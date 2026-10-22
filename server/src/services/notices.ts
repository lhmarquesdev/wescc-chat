import type { Message, NoticeAcks } from '@shared/index';
import { many, one, tx } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { bus } from '../realtime/bus';
import { withExtra } from './messages';
import { getUserRoles, rolesHavePermission } from './permissions';
import { canAccessRoom, getRoom, getSubscriptionRow } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

// "Ciente" nos canais de avisos. A confirmação usa a mesma linha de message_reads da confirmação de leitura;
// ack_at só é preenchido pelo clique.

const MEMBERS_ONLY = 'Você precisa participar do canal para confirmar.';
const NOT_REQUIRED = 'Esta mensagem não pede confirmação.';

// Logo depois de um aviso muitos confirmam juntos: no máximo um evento por mensagem a cada 2 s.
const scheduled = new Map<string, NodeJS.Timeout>();

function publishCountLater(messageId: string) {
  if (scheduled.has(messageId)) return;
  const timer = setTimeout(() => {
    scheduled.delete(messageId);
    void one('SELECT * FROM messages WHERE id = $1', [messageId])
      .then((row) => {
        if (row) bus.publish({ room: row.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
      })
      .catch(() => {});
  }, 2000);
  timer.unref();
  scheduled.set(messageId, timer);
}

export async function ackMessage(ctx: Ctx, messageId: string): Promise<{ message: Message; ackAt: string }> {
  const m = await one('SELECT * FROM messages WHERE id = $1', [messageId]);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  if (!(await getSubscriptionRow(m.room_id, ctx.userId))) throw forbidden(MEMBERS_ONLY);
  // Aviso removido (raiz de thread que ficou no lugar) não pede mais confirmação.
  if (!m.ack_required || m.t) throw badRequest('error-ack-not-required', NOT_REQUIRED);
  if (m.user_id === ctx.userId) throw badRequest('error-ack-own', 'Você é o autor deste aviso.');
  const r = await tx(async (c) => {
    // Só conta quando é esta chamada que preenche ack_at (o segundo clique, ou um clique simultâneo, não conta).
    const set = await one(
      `INSERT INTO message_reads (message_id, user_id, room_id, ack_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (message_id, user_id) DO UPDATE SET ack_at = EXCLUDED.ack_at WHERE message_reads.ack_at IS NULL
       RETURNING ack_at`,
      [m.id, ctx.userId, m.room_id],
      c,
    );
    if (!set) {
      const prev = await one('SELECT ack_at FROM message_reads WHERE message_id = $1 AND user_id = $2', [m.id, ctx.userId], c);
      return { row: m, ackAt: prev!.ack_at, counted: false };
    }
    const row = await one('UPDATE messages SET ack_count = ack_count + 1, updated_at = now() WHERE id = $1 RETURNING *', [m.id], c);
    return { row, ackAt: set.ack_at, counted: true };
  });
  if (r.counted) publishCountLater(m.id);
  return { message: withExtra(r.row), ackAt: new Date(r.ackAt).toISOString() };
}

export async function listAcks(ctx: Ctx, messageId: string, opts: { status: 'acked' | 'pending'; offset: number; count: number }): Promise<NoticeAcks> {
  const m = await one('SELECT id, room_id, user_id, t, ack_required, ack_count FROM messages WHERE id = $1', [messageId]);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  if (!(await canAccessRoom(ctx.userId, await getRoom(m.room_id)))) throw forbidden('Você não tem acesso a esta sala.');
  if (m.user_id !== ctx.userId && !rolesHavePermission(await getUserRoles(ctx.userId, m.room_id), 'post-readonly')) {
    throw forbidden('Só quem publica neste canal vê as confirmações.');
  }
  if (!m.ack_required || m.t) throw badRequest('error-ack-not-required', NOT_REQUIRED);
  const count = Math.min(Math.max(1, opts.count), 200);
  const offset = Math.max(0, opts.offset);
  // Pendentes: membros atuais, ativos, pessoas (não bots), menos o autor, sem "Ciente".
  const pendingFrom = `FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.room_id = $1 AND u.active AND u.type = 'user' AND u.id IS DISTINCT FROM $2
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = $3 AND r.user_id = u.id AND r.ack_at IS NOT NULL)`;
  const params = [m.room_id, m.user_id, m.id];
  const pendingCount = (await one(`SELECT count(*)::int AS n ${pendingFrom}`, params))!.n;
  const out: NoticeAcks = { messageId: m.id, ackCount: m.ack_count, pendingCount, acked: [], pending: [], total: 0 };
  if (opts.status === 'pending') {
    const rows = await many(`SELECT u.id, u.username, u.name ${pendingFrom} ORDER BY u.username LIMIT ${count} OFFSET ${offset}`, params);
    out.pending = rows.map((u) => ({ _id: u.id, username: u.username, name: u.name }));
    out.total = pendingCount;
  } else {
    const rows = await many(
      `SELECT r.ack_at, u.id, u.username, u.name FROM message_reads r JOIN users u ON u.id = r.user_id
       WHERE r.message_id = $1 AND r.ack_at IS NOT NULL ORDER BY r.ack_at, u.username LIMIT ${count} OFFSET ${offset}`,
      [m.id],
    );
    out.acked = rows.map((r) => ({ user: { _id: r.id, username: r.username, name: r.name }, ackAt: new Date(r.ack_at).toISOString() }));
    out.total = (await one('SELECT count(*)::int AS n FROM message_reads WHERE message_id = $1 AND ack_at IS NOT NULL', [m.id]))!.n;
  }
  return out;
}

// Recibos de leitura. Num canal de avisos (ou com a lista de membros oculta) eles mostram quem está no canal e,
// com as linhas do "Ciente", quem confirmou: valem as mesmas regras de chat.getAcks e da lista de membros.
// Desligados, não há o que mostrar (as linhas que sobram são só do "Ciente").
export async function assertCanSeeReceipts(ctx: Ctx, messageId: string): Promise<void> {
  if (!getSetting('Message_Read_Receipt_Enabled')) throw badRequest('error-read-receipts-disabled', 'A confirmação de leitura está desativada.');
  const m = await one('SELECT m.user_id, m.ack_required, r.id AS rid, r.notice, r.broadcast FROM messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = $1', [messageId]);
  if (!m || m.user_id === ctx.userId || !(m.notice || m.broadcast || m.ack_required)) return;
  const roles = await getUserRoles(ctx.userId, m.rid);
  if (rolesHavePermission(roles, 'post-readonly') || (m.broadcast && rolesHavePermission(roles, 'view-broadcast-member-list'))) return;
  throw forbidden(
    m.notice || m.ack_required ? 'Só quem publica neste canal vê quem leu os avisos.' : 'Neste canal a lista de membros está oculta: só donos e moderadores veem quem leu as mensagens.',
  );
}

export async function myAcks(ctx: Ctx, rid: string): Promise<{ acked: string[]; pending: string[] }> {
  if (!(await getSubscriptionRow(rid, ctx.userId))) throw forbidden(MEMBERS_ONLY);
  const acked = await many(
    `SELECT r.message_id FROM message_reads r JOIN messages m ON m.id = r.message_id
     WHERE r.room_id = $1 AND r.user_id = $2 AND r.ack_at IS NOT NULL AND m.ack_required AND m.t IS NULL
     ORDER BY m.created_at DESC LIMIT 500`,
    [rid, ctx.userId],
  );
  const pending = await many(
    `SELECT m.id FROM messages m
     WHERE m.room_id = $1 AND m.ack_required AND m.t IS NULL AND m.user_id IS DISTINCT FROM $2 AND m.created_at > now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $2 AND r.ack_at IS NOT NULL)
     ORDER BY m.created_at ASC LIMIT 100`,
    [rid, ctx.userId],
  );
  return { acked: acked.map((r) => r.message_id), pending: pending.map((r) => r.id) };
}
