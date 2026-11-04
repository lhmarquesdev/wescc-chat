import type { Message, UserRef } from '@shared/index';
import { cleanPollOptions, encryptedContent, pollInputError, type MessagePoll } from '@shared/messages';
import { many, one, query, tx, type Queryable } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { assertCanSendDirect } from './direct';
import { filterBadWords, sendMessage, withExtra } from './messages';
import { getUserRoles, hasPermission, rolesHavePermission } from './permissions';
import { canAccessRoom, getRoom, getSubscriptionRow } from './rooms';
import { actorOf, type Ctx } from './users';

// Enquetes. Pergunta, opções e o resultado que a sala vê ficam em messages.extra.poll (montado só pelo servidor); as
// regras e os votos ficam em polls e poll_votes. Numa enquete anônima ninguém recebe quem votou, nem quem criou.

const pollNotFound = () => notFound('error-poll-not-found', 'Enquete não encontrada.');
const closedError = () => badRequest('error-poll-closed', 'Esta enquete já foi encerrada.');

// Muitos votos logo depois da enquete sair: no máximo um "message updated" por enquete a cada segundo.
const scheduled = new Map<string, NodeJS.Timeout>();
function publishPollLater(messageId: string) {
  if (scheduled.has(messageId)) return;
  const timer = setTimeout(() => {
    scheduled.delete(messageId);
    void one('SELECT * FROM messages WHERE id = $1', [messageId])
      .then((row) => {
        if (row) bus.publish({ room: row.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
      })
      .catch(() => {});
  }, 1000);
  timer.unref();
  scheduled.set(messageId, timer);
}

function publishNow(row: any) {
  const t = scheduled.get(row.id);
  if (t) {
    clearTimeout(t);
    scheduled.delete(row.id);
  }
  bus.publish({ room: row.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
}

const isClosed = (p: { closed_at: string | null; closes_at: string | null }) => !!p.closed_at || (!!p.closes_at && new Date(p.closes_at).getTime() <= Date.now());

// Recalcula a contagem e grava o resultado na mensagem (dentro da transação que mudou os votos ou o prazo).
async function writeResult(db: Queryable, messageId: string, closedAt?: string | null): Promise<any> {
  const counts = new Map((await many('SELECT option_id, count(*)::int AS n FROM poll_votes WHERE message_id = $1 GROUP BY option_id', [messageId], db)).map((r) => [r.option_id, r.n]));
  const voters = (await one('SELECT count(DISTINCT user_id)::int AS n FROM poll_votes WHERE message_id = $1', [messageId], db))!.n;
  const m = await one('SELECT extra FROM messages WHERE id = $1', [messageId], db);
  const poll = m?.extra?.poll as MessagePoll | undefined;
  if (!poll) return null;
  const next: MessagePoll = {
    ...poll,
    options: poll.options.map((o) => ({ ...o, votes: counts.get(o.id) ?? 0 })),
    voters,
    ...(closedAt !== undefined ? { closedAt } : {}),
  };
  return one(`UPDATE messages SET extra = jsonb_set(extra, '{poll}', $2::jsonb), updated_at = now() WHERE id = $1 RETURNING *`, [messageId, JSON.stringify(next)], db);
}

// ---------- Criar ----------

export interface CreatePollInput {
  rid: string;
  tmid?: string | null;
  question: unknown;
  options: unknown;
  multiple?: boolean;
  anonymous?: boolean;
  closesAt?: string | null;
}

export async function createPoll(ctx: Ctx, input: CreatePollInput): Promise<Message> {
  const room = await getRoom(input.rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  // Inscrição antes de tudo: quem não é da sala não descobre nada dela (criptografia, avisos) pelas respostas.
  if (!(await getSubscriptionRow(room.id, ctx.userId))) throw forbidden('Você precisa entrar na sala para enviar mensagens.');
  if (encryptedContent(room)) throw badRequest('error-poll-encrypted', 'Enquetes não estão disponíveis em salas criptografadas.');
  if (!(await hasPermission(ctx.userId, 'create-poll', room.id))) throw forbidden('Você não tem permissão para criar enquetes nesta sala.');
  const question = filterBadWords(typeof input.question === 'string' ? input.question.trim() : '');
  const options = cleanPollOptions(input.options).map(filterBadWords);
  const closesAt = input.closesAt || null;
  const error = pollInputError({ question, options, closesAt }, new Date());
  if (error) throw badRequest('error-invalid-poll', error);
  const poll: MessagePoll = {
    question,
    options: options.map((text, i) => ({ id: `o${i + 1}`, text, votes: 0 })),
    voters: 0,
    multiple: !!input.multiple,
    anonymous: !!input.anonymous,
    closesAt: closesAt ? new Date(closesAt).toISOString() : null,
    closedAt: null,
  };
  // msg = pergunta: busca, auditoria, prévia e menções (com as permissões de @all/@here) funcionam sem código novo.
  return sendMessage(
    ctx,
    { rid: room.id, tmid: input.tmid || null, msg: question, poll },
    {
      skipCommands: true,
      poll: true,
      onInserted: (row) =>
        query('INSERT INTO polls (message_id, room_id, created_by, multiple, anonymous, option_ids, closes_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
          row.id,
          room.id,
          ctx.userId,
          poll.multiple,
          poll.anonymous,
          poll.options.map((o) => o.id),
          poll.closesAt,
        ]),
    },
  );
}

// ---------- Votar ----------

async function loadPoll(messageId: string) {
  const p = messageId ? await one('SELECT p.*, m.t FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = $1', [messageId]) : null;
  if (!p || p.t === 'rm') throw pollNotFound();
  return p;
}

// Somente leitura e canal de avisos não impedem votar (é a voz de quem lê, como a reação).
async function assertCanVote(ctx: Ctx, room: any) {
  if (!(await getSubscriptionRow(room.id, ctx.userId))) throw forbidden('Entre na sala para votar.');
  if (room.archived) throw badRequest('error-room-archived', 'Esta sala está arquivada.');
  if (room.muted?.includes(ctx.username)) throw forbidden('Você está silenciado nesta sala.');
  await assertCanSendDirect(ctx, room);
}

export async function vote(ctx: Ctx, messageId: string, optionIds: unknown): Promise<{ message: Message; optionIds: string[] }> {
  if (!Array.isArray(optionIds) || optionIds.some((x) => typeof x !== 'string')) throw badRequest('error-invalid-params', 'Parâmetros inválidos.');
  const ids = [...new Set(optionIds as string[])];
  const p = await loadPoll(messageId);
  const room = await getRoom(p.room_id);
  if (!room) throw pollNotFound();
  await assertCanVote(ctx, room);
  const row = await tx(async (c) => {
    // A linha da enquete em fila: dois votos ao mesmo tempo nunca gravam uma contagem velha.
    const locked = await one('SELECT * FROM polls WHERE message_id = $1 FOR UPDATE', [messageId], c);
    if (!locked) throw pollNotFound();
    if (isClosed(locked)) throw closedError();
    if (ids.some((id) => !locked.option_ids.includes(id))) throw badRequest('error-invalid-params', 'Opção inválida.');
    if (!locked.multiple && ids.length > 1) throw badRequest('error-invalid-params', 'Esta enquete aceita uma resposta só.');
    await query('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2', [messageId, ctx.userId], c);
    if (ids.length) await query('INSERT INTO poll_votes (message_id, user_id, option_id) SELECT $1, $2, unnest($3::text[])', [messageId, ctx.userId, ids], c);
    return writeResult(c, messageId);
  });
  if (!row) throw pollNotFound();
  publishPollLater(messageId);
  const sorted = [...ids].sort();
  bus.publish({ user: ctx.userId }, { type: 'poll.myVotes', rid: p.room_id, messageId, optionIds: sorted });
  return { message: withExtra(row), optionIds: sorted };
}

// ---------- Encerrar ----------

export async function closePoll(ctx: Ctx, messageId: string): Promise<Message> {
  const p = await loadPoll(messageId);
  const room = await getRoom(p.room_id);
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta sala.');
  const own = p.created_by === ctx.userId;
  if (!own && !rolesHavePermission(await getUserRoles(ctx.userId, p.room_id), 'delete-message')) {
    throw forbidden('Só quem criou a enquete ou um moderador da sala pode encerrá-la.');
  }
  const row = await tx(async (c) => {
    const done = await one(`UPDATE polls SET closed_at = now(), closed_by = $2 WHERE message_id = $1 AND closed_at IS NULL RETURNING closed_at`, [messageId, ctx.userId], c);
    if (!done) return null;
    return writeResult(c, messageId, new Date(done.closed_at).toISOString());
  });
  if (!row) return withExtra(await one('SELECT * FROM messages WHERE id = $1', [messageId])); // já estava encerrada
  publishNow(row);
  if (!own) {
    const author = await one('SELECT username FROM users WHERE id = $1', [p.created_by]);
    await audit(actorOf(ctx), 'poll.closed', { rid: p.room_id, msgId: messageId }, { author: author?.username ?? null });
  }
  return withExtra(row);
}

// Agendador: enquetes que passaram do prazo. Um voto depois do prazo já é recusado antes deste ciclo (isClosed).
export async function closeDuePolls(): Promise<number> {
  const due = await tx(async (c) => {
    const ids = await many(
      `UPDATE polls SET closed_at = closes_at
        WHERE message_id IN (SELECT message_id FROM polls WHERE closed_at IS NULL AND closes_at <= now() ORDER BY closes_at LIMIT 200 FOR UPDATE SKIP LOCKED)
        RETURNING message_id, closed_at`,
      [],
      c,
    );
    const rows: any[] = [];
    for (const r of ids) {
      const row = await writeResult(c, r.message_id, new Date(r.closed_at).toISOString());
      if (row) rows.push(row);
    }
    return rows;
  });
  for (const row of due) publishNow(row);
  return due.length;
}

// ---------- Leitura ----------

// Só os votos de quem pergunta: não precisa de checagem de sala.
export async function myVotes(ctx: Ctx, messageIds: string[]): Promise<Record<string, string[]>> {
  const ids = [...new Set(messageIds)].slice(0, 100);
  const out: Record<string, string[]> = {};
  if (!ids.length) return out;
  const rows = await many(
    'SELECT message_id, array_agg(option_id ORDER BY option_id) AS ids FROM poll_votes WHERE user_id = $1 AND message_id = ANY($2) GROUP BY message_id',
    [ctx.userId, ids],
  );
  for (const r of rows) out[r.message_id] = r.ids;
  return out;
}

export async function pollVoters(ctx: Ctx, messageId: string): Promise<{ options: { id: string; total: number; users: UserRef[] }[] }> {
  const p = await loadPoll(messageId);
  const room = await getRoom(p.room_id);
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta sala.');
  if (p.anonymous) throw badRequest('error-poll-anonymous', 'Esta enquete é anônima: ninguém vê quem votou.');
  // Canal de avisos ou lista de membros oculta: a mesma regra dos recibos de leitura.
  if (room.notice || room.broadcast) {
    const roles = await getUserRoles(ctx.userId, room.id);
    if (!rolesHavePermission(roles, 'post-readonly') && !(room.broadcast && rolesHavePermission(roles, 'view-broadcast-member-list'))) {
      throw new ApiError(403, 'error-not-allowed', 'Só quem publica neste canal vê quem votou.');
    }
  }
  const totals = new Map((await many('SELECT option_id, count(*)::int AS n FROM poll_votes WHERE message_id = $1 GROUP BY option_id', [messageId])).map((r) => [r.option_id, r.n]));
  // Conta excluída: fora da lista, dentro do total.
  const rows = await many(
    `SELECT option_id, id, username, name FROM (
       SELECT v.option_id, u.id, u.username, u.name, row_number() OVER (PARTITION BY v.option_id ORDER BY v.voted_at, u.username) AS n
         FROM poll_votes v JOIN users u ON u.id = v.user_id WHERE v.message_id = $1
     ) x WHERE n <= 200 ORDER BY option_id, n`,
    [messageId],
  );
  return {
    options: (p.option_ids as string[]).map((id) => ({
      id,
      total: totals.get(id) ?? 0,
      users: rows.filter((r) => r.option_id === id).map((r) => ({ _id: r.id, username: r.username, name: r.name || undefined })),
    })),
  };
}
