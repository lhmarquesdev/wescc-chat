import type { Message } from '@shared/index';
import { AHEAD_ERROR, aheadError, encryptedContent, SCHEDULE_LATE_MINUTES, SCHEDULED_MAX, type ScheduledMessage } from '@shared/messages';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { canPostInRoom, getMessageRow, MENTION_RE, sendMessage, withExtra } from './messages';
import { getUserRoles, hasPermission, rolesHavePermission } from './permissions';
import { getRoom } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Envio agendado: só texto (com tópico e "Ciente"). O id da linha vira o _id da mensagem enviada, então um envio
// interrompido no meio nunca sai duas vezes. Enviada, a linha sai; falhou, fica com o motivo até a pessoa editar,
// enviar agora ou cancelar. Só a própria pessoa vê as suas (nem administradores veem as de outra pessoa).

const GENERIC_FAIL = 'Não foi possível enviar. Tente de novo.';
const LATE_FAIL = 'O horário passou com o servidor fora do ar. Confira a mensagem e envie de novo.';
const ENCRYPTED_TEXT = 'Não dá para agendar mensagens em salas criptografadas.';
const MAX_ATTEMPTS = 3;

const notFoundError = () => notFound('error-scheduled-not-found', 'Mensagem agendada não encontrada.');
const sendingError = () => new ApiError(409, 'error-scheduled-sending', 'Esta mensagem já está sendo enviada.');

export function mapScheduled(row: any): ScheduledMessage {
  return {
    _id: row.id,
    rid: row.room_id,
    tmid: row.tmid ?? null,
    tshow: !!row.tshow,
    msg: row.msg,
    ackRequired: !!row.ack_required,
    sendAt: row.send_at,
    status: row.status,
    error: row.error ?? null,
    createdAt: row.created_at,
    _updatedAt: row.updated_at,
  };
}

// notify: a falha veio do agendador (a web avisa com um toast; numa ação da própria pessoa o erro já volta na resposta).
function publish(row: any, action: 'upserted' | 'removed', extra: { messageId?: string; notify?: boolean } = {}) {
  bus.publish({ user: row.user_id }, { type: 'message.scheduled', action, scheduled: mapScheduled(row), ...extra });
}

// ---------- Validações (as mesmas do envio, conferidas já ao agendar) ----------

function cleanText(msg: unknown): string {
  const text = typeof msg === 'string' ? msg.trim() : '';
  if (!text) throw badRequest('error-invalid-message', 'Mensagem vazia.');
  const max = getSetting<number>('Message_MaxAllowedSize');
  if (text.length > max) throw badRequest('error-message-size-exceeded', `A mensagem excede ${max} caracteres.`);
  if (text.startsWith('/')) throw badRequest('error-schedule-command', 'Comandos não podem ser agendados.');
  return text;
}

function checkSendAt(sendAt: unknown): string {
  const err = aheadError(sendAt, new Date());
  if (err) throw badRequest('error-invalid-date', err);
  return new Date(String(sendAt)).toISOString();
}

// @all e @here com as mesmas regras do envio (messages.ts).
function checkGroupMentions(msg: string, roles: string[], room: any) {
  const names = new Set([...msg.matchAll(MENTION_RE)].map((m) => m[1].replace(/\.+$/, '')));
  if (names.has('all') && !rolesHavePermission(roles, 'mention-all')) throw forbidden('Sem permissão para mencionar @all.');
  if (names.has('here') && !rolesHavePermission(roles, 'mention-here')) throw forbidden('Sem permissão para mencionar @here.');
  const maxAll = getSetting<number>('Message_MaxAll');
  if (names.has('all') && maxAll > 0 && room.users_count > maxAll) throw forbidden(`@all não é permitido em salas com mais de ${maxAll} membros.`);
}

// ---------- Agendar ----------

export interface ScheduleInput {
  rid: string;
  msg: unknown;
  tmid?: string | null;
  tshow?: boolean;
  ackRequired?: boolean;
}

export async function scheduleMessage(ctx: Ctx, input: ScheduleInput, sendAt: unknown): Promise<ScheduledMessage> {
  const room = await getRoom(input.rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (!(await hasPermission(ctx.userId, 'schedule-message', room.id))) throw forbidden('Você não tem permissão para agendar mensagens nesta sala.');
  if (encryptedContent(room)) throw badRequest('error-schedule-encrypted', ENCRYPTED_TEXT);
  const msg = cleanText(input.msg);
  const at = checkSendAt(sendAt);
  const roles = (await canPostInRoom(ctx, room)) ?? (await getUserRoles(ctx.userId, room.id));
  if (input.ackRequired && (!room.notice || !room.notice_ack || input.tmid)) {
    throw badRequest('error-ack-not-allowed', 'Só avisos de um canal de avisos com “Ciente” ativado podem pedir confirmação.');
  }
  let tmid: string | null = input.tmid || null;
  if (tmid) {
    if (!getSetting('Threads_enabled')) throw badRequest('error-threads-disabled', 'Threads estão desativadas.');
    let parent = await getMessageRow(tmid);
    if (!parent || parent.room_id !== room.id) throw badRequest('error-invalid-thread', 'Thread inválida.');
    if (parent.tmid) parent = await getMessageRow(parent.tmid); // resposta de resposta vira a raiz
    if (!parent) throw badRequest('error-invalid-thread', 'Thread inválida.');
    tmid = parent.id;
  }
  checkGroupMentions(msg, roles, room);
  const count = (await one('SELECT count(*)::int AS n FROM scheduled_messages WHERE user_id = $1', [ctx.userId]))!.n;
  if (count >= SCHEDULED_MAX) throw badRequest('error-too-many-scheduled', `Você já tem ${SCHEDULED_MAX} mensagens agendadas.`);
  const row = await one(
    `INSERT INTO scheduled_messages (id, room_id, user_id, tmid, tshow, msg, ack_required, send_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [newId(), room.id, ctx.userId, tmid, !!(tmid && input.tshow), msg, !!input.ackRequired, at],
  );
  publish(row, 'upserted');
  return mapScheduled(row);
}

// ---------- Listar, editar, cancelar ----------

export async function listScheduled(ctx: Ctx, rid?: string | null): Promise<ScheduledMessage[]> {
  const rows = rid
    ? await many('SELECT * FROM scheduled_messages WHERE user_id = $1 AND room_id = $2 ORDER BY send_at, id', [ctx.userId, rid])
    : await many('SELECT * FROM scheduled_messages WHERE user_id = $1 ORDER BY send_at, id', [ctx.userId]);
  return rows.map(mapScheduled);
}

async function ownRow(ctx: Ctx, id: string) {
  const row = await one('SELECT * FROM scheduled_messages WHERE id = $1 AND user_id = $2', [id, ctx.userId]);
  if (!row) throw notFoundError();
  return row;
}

export async function updateScheduled(ctx: Ctx, id: string, patch: { msg?: unknown; sendAt?: unknown }): Promise<ScheduledMessage> {
  const cur = await ownRow(ctx, id);
  if (cur.status === 'sending') throw sendingError();
  const msg = patch.msg !== undefined ? cleanText(patch.msg) : cur.msg;
  const at = patch.sendAt !== undefined ? checkSendAt(patch.sendAt) : cur.send_at;
  // Sem horário novo, o guardado precisa ainda estar à frente (uma que falhou por atraso volta com outro horário).
  if (patch.sendAt === undefined && new Date(cur.send_at).getTime() <= Date.now()) throw badRequest('error-invalid-date', AHEAD_ERROR);
  const room = await getRoom(cur.room_id);
  if (room) checkGroupMentions(msg, await getUserRoles(ctx.userId, room.id), room);
  const row = await one(
    `UPDATE scheduled_messages SET msg = $3, send_at = $4, status = 'pending', error = NULL, attempts = 0, claimed_at = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status <> 'sending' RETURNING *`,
    [id, ctx.userId, msg, at],
  );
  if (!row) throw (await one('SELECT 1 FROM scheduled_messages WHERE id = $1 AND user_id = $2', [id, ctx.userId])) ? sendingError() : notFoundError();
  publish(row, 'upserted');
  return mapScheduled(row);
}

export async function cancelScheduled(ctx: Ctx, id: string): Promise<void> {
  const row = await one(`DELETE FROM scheduled_messages WHERE id = $1 AND user_id = $2 AND status <> 'sending' RETURNING *`, [id, ctx.userId]);
  if (!row) {
    await ownRow(ctx, id); // 404 se não é da pessoa
    throw sendingError();
  }
  publish(row, 'removed');
}

// Saiu (ou foi tirada) da sala: as agendadas dela ali somem.
export async function removeScheduledOfUserInRoom(rid: string, userId: string): Promise<void> {
  const rows = await many(`DELETE FROM scheduled_messages WHERE room_id = $1 AND user_id = $2 AND status <> 'sending' RETURNING *`, [rid, userId]);
  for (const r of rows) publish(r, 'removed');
}

// ---------- Enviar ----------

async function markFailed(row: any, error: string, fromScheduler: boolean) {
  const r = await one(`UPDATE scheduled_messages SET status = 'failed', error = $2, claimed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, error]);
  if (!r) return;
  publish(r, 'upserted', fromScheduler ? { notify: true } : {});
  if (fromScheduler) await pushFailure(r, error).catch(() => {});
}

// Push para quem agendou, se não está com o chat aberto em nenhum lugar.
async function pushFailure(row: any, error: string) {
  if (!getSetting('Push_enable')) return;
  if (await one('SELECT 1 FROM presence_connections WHERE user_id = $1 LIMIT 1', [row.user_id])) return;
  const room = await getRoom(row.room_id);
  if (!room) return;
  let where = `#${room.fname || room.name}`;
  if (room.t === 'd') {
    const others = (room.uids as string[]).filter((u) => u !== row.user_id);
    const names = (await many(`SELECT coalesce(nullif(trim(name), ''), username) AS n FROM users WHERE id = ANY($1) ORDER BY 1`, [others.length ? others : room.uids])).map((r) => r.n as string);
    where = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names.join('');
  }
  const base = room.t === 'd' ? 'direct' : room.t === 'p' ? 'group' : 'channel';
  const { sendPush } = await import('./push');
  await sendPush([row.user_id], { title: 'Mensagem agendada não enviada', body: `${where}: ${error}`.slice(0, 300), url: `/${base}/${room.id}?tab=scheduled`, tag: `scheduled-${row.id}` });
}

async function sentAlready(row: any): Promise<Message | null> {
  const m = await getMessageRow(row.id);
  if (!m) return null;
  await query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  publish(row, 'removed', { messageId: m.id });
  return withExtra(m);
}

// reqCtx: "Enviar agora" da própria pessoa (sem o prazo de atraso; o erro volta na resposta e fica gravado).
async function deliver(row: any, reqCtx?: Ctx): Promise<Message> {
  const done = await sentAlready(row);
  if (done) return done;
  const fromScheduler = !reqCtx;
  let message: Message;
  try {
    if (fromScheduler && new Date(row.send_at).getTime() < Date.now() - SCHEDULE_LATE_MINUTES * 60_000) throw badRequest('error-scheduled-late', LATE_FAIL);
    const author = await one('SELECT id, username, active FROM users WHERE id = $1', [row.user_id]);
    if (!author?.active) throw badRequest('error-user-deactivated', 'A conta de quem agendou está desativada.');
    const room = await getRoom(row.room_id);
    if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
    if (encryptedContent(room)) throw badRequest('error-schedule-encrypted', ENCRYPTED_TEXT);
    if (!(await hasPermission(author.id, 'schedule-message', room.id))) throw forbidden('Você não tem mais permissão para agendar mensagens nesta sala.');
    // Nada no caminho de envio usa a sessão; um gancho futuro que use precisa saber do envio pelo agendador.
    const ctx: Ctx = reqCtx ?? { userId: author.id, username: author.username, sessionId: 'scheduler' };
    // Reconfere tudo na hora: inscrição, somente leitura e aviso, silêncio, arquivada, DM restrita, "Ciente", tópico, @all, tamanho.
    message = (await sendMessage(ctx, { _id: row.id, rid: room.id, msg: row.msg, tmid: row.tmid, tshow: row.tshow, ackRequired: row.ack_required }, { skipCommands: true })) as Message;
  } catch (e) {
    if (e instanceof ApiError) {
      await markFailed(row, e.message, fromScheduler);
      throw e;
    }
    // Erro do banco ou da rede: tenta de novo no próximo ciclo, até 3 vezes.
    if (row.attempts < MAX_ATTEMPTS) {
      const r = await one(`UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [row.id]).catch(() => null);
      if (r && reqCtx) publish(r, 'upserted');
    } else await markFailed(row, GENERIC_FAIL, fromScheduler).catch(() => {});
    throw e;
  }
  await query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  publish(row, 'removed', { messageId: message._id });
  return message;
}

export async function sendScheduledNow(ctx: Ctx, id: string): Promise<Message> {
  const row = await one(
    `UPDATE scheduled_messages SET status = 'sending', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'failed') RETURNING *`,
    [id, ctx.userId],
  );
  if (!row) {
    await ownRow(ctx, id);
    throw sendingError();
  }
  return deliver(row, ctx);
}

// Agendador (a cada 15 s): recupera envios interrompidos, reserva os vencidos e envia um por um.
export async function sendDueScheduled(): Promise<number> {
  // 1. Interrompidos há mais de 5 minutos (instância caiu no meio do envio).
  const stale = await many(`SELECT * FROM scheduled_messages WHERE status = 'sending' AND claimed_at < now() - interval '5 minutes' ORDER BY claimed_at LIMIT 50`);
  for (const row of stale) {
    if (await sentAlready(row)) continue;
    if (row.attempts < MAX_ATTEMPTS) {
      await query(`UPDATE scheduled_messages SET status = 'pending', claimed_at = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`, [row.id]);
    } else await markFailed(row, GENERIC_FAIL, true);
  }
  // 2. Reserva: UPDATE … RETURNING com SKIP LOCKED, então duas instâncias nunca pegam a mesma linha.
  const rows = await many(
    `UPDATE scheduled_messages SET status = 'sending', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= now()
                   ORDER BY send_at LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  let sent = 0;
  let firstError: unknown;
  for (const row of rows) {
    try {
      await deliver(row);
      sent++;
    } catch (e) {
      if (!(e instanceof ApiError)) firstError ??= e; // a falha de uma não impede as outras
    }
  }
  if (firstError) throw firstError;
  return sent;
}
