import { many, one, query } from '../db/pool';
import { bus } from '../realtime/bus';
import { forbidden, notFound } from '../lib/errors';
import { hasPermission } from './permissions';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Confirmação de leitura (read receipts).
// Cada usuário que lê grava as leituras individuais; quando todos os membros
// já leram, a mensagem deixa de estar "não lida" e a sala recebe o evento "reads".

export async function markReadInternal(userId: string, rid: string) {
  await query('UPDATE subscriptions SET ls = now(), unread = 0, alert = false, user_mentions = 0, group_mentions = 0 WHERE room_id = $1 AND user_id = $2', [rid, userId]);
  await settleRoomReads(rid);
}

export async function recordReads(userId: string, rid: string, prevLs: string | null) {
  if (!getSetting('Message_Read_Receipt_Enabled')) return;
  if (getSetting('Message_Read_Receipt_Store_Users')) {
    await query(
      `INSERT INTO message_reads (message_id, user_id, room_id)
       SELECT id, $1, room_id FROM (
         SELECT id, room_id FROM messages
         WHERE room_id = $2 AND t IS NULL AND user_id IS DISTINCT FROM $1 AND ($3::timestamptz IS NULL OR created_at > $3)
         ORDER BY created_at DESC LIMIT 1000
       ) x
       ON CONFLICT DO NOTHING`,
      [userId, rid, prevLs],
    );
  }
  await settleRoomReads(rid);
}

export async function settleRoomReads(rid: string) {
  if (!getSetting('Message_Read_Receipt_Enabled')) return;
  const min = await one('SELECT min(ls) AS ls, count(*)::int AS n FROM subscriptions WHERE room_id = $1', [rid]);
  if (!min?.ls) return;
  const rows = await many(
    `UPDATE messages SET unread = false WHERE room_id = $1 AND unread AND created_at <= $2 RETURNING id`,
    [rid, min.ls],
  );
  if (rows.length) bus.publish({ room: rid }, { type: 'reads', rid, messageIds: rows.map((r) => r.id) });
}

export async function getReadReceipts(ctx: Ctx, messageId: string) {
  const m = await one('SELECT id, room_id FROM messages WHERE id = $1', [messageId]);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  const { loadRoomForUser } = await import('./rooms');
  await loadRoomForUser(ctx, m.room_id);
  if (!(await hasPermission(ctx.userId, 'view-message-read-receipts', m.room_id))) throw forbidden();
  const rows = await many(
    `SELECT r.read_at, u.id, u.username, u.name FROM message_reads r JOIN users u ON u.id = r.user_id
     WHERE r.message_id = $1 ORDER BY r.read_at`,
    [messageId],
  );
  return rows.map((r) => ({ _id: `${messageId}:${r.id}`, messageId, roomId: m.room_id, userId: r.id, ts: r.read_at, user: { _id: r.id, username: r.username, name: r.name } }));
}
