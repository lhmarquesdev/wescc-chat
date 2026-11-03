import type { Message } from '@shared/index';
import { ENCRYPTED_PLACEHOLDER } from '@shared/dataExport';
import { aheadError, encryptedContent, messageLink, REMINDERS_MAX, type MessageReminder } from '@shared/messages';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { getMessageRow, rowPreview, withExtra } from './messages';
import { canAccessRoom, getRoom } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

// "Lembrar-me": um lembrete por pessoa e mensagem. Só a própria pessoa vê os seus (nem administradores veem os de
// outra pessoa). Avisado, fica na página "Lembretes" até a pessoa concluir ou adiar.

export const REMINDER_HIDDEN_TEXT = 'Você pediu para ser lembrado de uma mensagem.';

function mapReminder(row: any, room: any, message: Message | null): MessageReminder {
  const r: MessageReminder = {
    _id: row.id,
    messageId: row.message_id,
    rid: row.room_id,
    t: room?.t ?? 'c',
    remindAt: row.remind_at,
    firedAt: row.fired_at ?? null,
    message,
  };
  if (room && room.t !== 'd') r.roomName = room.fname || room.name;
  return r;
}

const publish = (userId: string, action: 'upserted' | 'fired' | 'removed', reminder: MessageReminder) =>
  bus.publish({ user: userId }, { type: 'message.reminder', action, reminder });

// ---------- Marcar e adiar ----------

// O mesmo serve para criar, trocar o horário e adiar um que já avisou (fired_at volta a NULL).
export async function setReminder(ctx: Ctx, messageId: string, remindAt: unknown): Promise<MessageReminder> {
  const m = await getMessageRow(messageId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  if (m.t) throw badRequest('error-reminder-not-allowed', 'Não dá para pôr lembrete nesta mensagem.');
  const room = await getRoom(m.room_id);
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta mensagem.');
  const err = aheadError(remindAt, new Date());
  if (err) throw badRequest('error-invalid-date', err);
  const others = (await one('SELECT count(*)::int AS n FROM message_reminders WHERE user_id = $1 AND message_id <> $2', [ctx.userId, m.id]))!.n;
  if (others >= REMINDERS_MAX) throw badRequest('error-too-many-reminders', `Você já tem ${REMINDERS_MAX} lembretes. Conclua alguns antes de criar outro.`);
  const row = await one(
    `INSERT INTO message_reminders (id, user_id, message_id, room_id, remind_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, message_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, fired_at = NULL, updated_at = now()
     RETURNING *`,
    [newId(), ctx.userId, m.id, m.room_id, new Date(String(remindAt)).toISOString()],
  );
  const reminder = mapReminder(row, room, withExtra(m));
  publish(ctx.userId, 'upserted', reminder); // outras abas e o celular
  return reminder;
}

// ---------- Listar ----------

// Avisados primeiro (o mais recente no topo), depois os próximos. A mensagem só vai enquanto a pessoa acessa a sala.
export async function listReminders(ctx: Ctx): Promise<{ reminders: MessageReminder[]; fired: number }> {
  const rows = await many(
    `SELECT * FROM message_reminders WHERE user_id = $1
     ORDER BY (fired_at IS NULL), fired_at DESC, remind_at, id`,
    [ctx.userId],
  );
  if (!rows.length) return { reminders: [], fired: 0 };
  const roomIds = [...new Set(rows.map((r) => r.room_id as string))];
  const rooms = new Map((await many('SELECT * FROM rooms WHERE id = ANY($1)', [roomIds])).map((r) => [r.id as string, r]));
  const allowed = new Set<string>();
  for (const rid of roomIds) if (await canAccessRoom(ctx.userId, rooms.get(rid))) allowed.add(rid);
  const msgs = new Map(
    (await many('SELECT * FROM messages WHERE id = ANY($1)', [rows.filter((r) => allowed.has(r.room_id)).map((r) => r.message_id)])).map((m) => [m.id as string, m]),
  );
  const reminders = rows.map((r) => {
    const m = msgs.get(r.message_id);
    return mapReminder(r, rooms.get(r.room_id), m && m.t !== 'rm' ? withExtra(m) : null);
  });
  return { reminders, fired: rows.filter((r) => r.fired_at).length };
}

// ---------- Concluir ----------

export async function deleteReminder(ctx: Ctx, id: string): Promise<void> {
  const row = await one('DELETE FROM message_reminders WHERE id = $1 AND user_id = $2 RETURNING *', [id, ctx.userId]);
  if (!row) throw notFound('error-reminder-not-found', 'Lembrete não encontrado.');
  publish(ctx.userId, 'removed', mapReminder(row, await getRoom(row.room_id), null));
}

// Mensagem apagada (ou que a retenção tirou): os lembretes saem e cada dono fica sabendo.
export async function removeRemindersOfMessage(messageId: string | string[]): Promise<void> {
  const ids = Array.isArray(messageId) ? messageId : [messageId];
  if (!ids.length) return;
  const rows = await many('DELETE FROM message_reminders WHERE message_id = ANY($1) RETURNING *', [ids]);
  if (!rows.length) return;
  const rooms = new Map((await many('SELECT * FROM rooms WHERE id = ANY($1)', [[...new Set(rows.map((r) => r.room_id))]])).map((r) => [r.id as string, r]));
  for (const r of rows) publish(r.user_id, 'removed', mapReminder(r, rooms.get(r.room_id), null));
}

// ---------- Avisar (agendador) ----------

// O texto do push: nunca o conteúdo quando o servidor esconde o conteúdo dos avisos ou a mensagem é criptografada.
export function reminderPushBody(m: any, room: any): string {
  if (getSetting<boolean>('Push_Privacy_Hide_Content')) return REMINDER_HIDDEN_TEXT;
  const author = m.alias ? String(m.alias) : (m.user_name || '').trim() || m.username;
  const preview = encryptedContent(room, m) ? ENCRYPTED_PLACEHOLDER : rowPreview(m);
  return truncate(`${author}: ${preview}`, 140);
}

// Sem prazo de atraso: um lembrete vencido com o servidor parado ainda avisa quando ele volta.
export async function fireDueReminders(): Promise<number> {
  const rows = await many(
    `UPDATE message_reminders SET fired_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM message_reminders WHERE fired_at IS NULL AND remind_at <= now()
                   ORDER BY remind_at LIMIT 200 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  if (!rows.length) return 0;
  const users = new Map((await many('SELECT id, active FROM users WHERE id = ANY($1)', [[...new Set(rows.map((r) => r.user_id))]])).map((u) => [u.id as string, u]));
  const rooms = new Map((await many('SELECT * FROM rooms WHERE id = ANY($1)', [[...new Set(rows.map((r) => r.room_id))]])).map((r) => [r.id as string, r]));
  const pushes: { userId: string; title: string; body: string; url: string; tag: string }[] = [];
  for (const r of rows) {
    if (!users.get(r.user_id)?.active) continue; // conta desativada: fica avisado, sem evento nem push
    const room = rooms.get(r.room_id);
    const m = await getMessageRow(r.message_id);
    if (!room || !m || m.t === 'rm' || !(await canAccessRoom(r.user_id, room))) {
      // Perdeu o acesso (ou a mensagem sumiu): o lembrete sai sem levar nada da mensagem.
      await query('DELETE FROM message_reminders WHERE id = $1', [r.id]);
      publish(r.user_id, 'removed', mapReminder(r, room, null));
      continue;
    }
    publish(r.user_id, 'fired', mapReminder(r, room, withExtra(m)));
    pushes.push({ userId: r.user_id, title: 'Lembrete', body: reminderPushBody(m, room), url: messageLink({ rid: room.id, t: room.t, mid: m.id, tmid: m.tmid }), tag: `reminder-${r.id}` });
  }
  // Push só para quem não está com o chat aberto em nenhum lugar (quem está recebe pelo WebSocket).
  if (pushes.length && getSetting('Push_enable')) {
    const online = new Set((await many('SELECT DISTINCT user_id FROM presence_connections WHERE user_id = ANY($1)', [pushes.map((p) => p.userId)])).map((r) => r.user_id));
    const push = await import('./push');
    for (const p of pushes) {
      if (online.has(p.userId)) continue;
      void push.sendPush([p.userId], { title: p.title, body: p.body, url: p.url, tag: p.tag }).catch(() => {});
    }
  }
  return rows.length;
}
