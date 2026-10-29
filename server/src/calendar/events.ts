// Agenda: eventos do chat (criar, editar, cancelar, responder) e reuniões com sala própria e link /meet/<código>.
// Quem vê um evento: o dono e os convidados. Eventos trazidos do Google/Outlook são só do dono e só leitura aqui.
import crypto from 'node:crypto';
import type { AttendeeResponse, CalendarEvent, CalendarEventInput, MeetingAccess, MeetingInfo } from '@shared/calendar';
import type { MessageMeeting } from '@shared/integrations';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { assertCanBringIn } from '../services/direct';
import { sendMessage } from '../services/messages';
import { hasPermission } from '../services/permissions';
import { sendPush } from '../services/push';
import { addUserToRoom, createRoom, getRoom, notifyRoomUpdated, removeUserFromRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { siteUrl } from '../services/sso';
import { actorOf, type Ctx } from '../services/users';
import { markDirty } from './dirty';

export const CAL_TEXT = {
  off: 'A Agenda está desativada neste chat.',
  notFound: 'Evento não encontrado.',
  meetingNotFound: 'Reunião não encontrada. Confira o link.',
  readOnly: 'Este evento veio da sua conta externa. Edite-o no Google Agenda ou no Outlook.',
  onlyOwner: 'Só quem criou o evento pode alterá-lo.',
  canceled: 'Este evento foi cancelado.',
  title: 'Dê um título ao evento.',
  titleLong: 'O título pode ter até 200 caracteres.',
  descriptionLong: 'A descrição pode ter até 5.000 caracteres.',
  locationLong: 'O local pode ter até 300 caracteres.',
  start: 'Informe a data e a hora de início.',
  end: 'O fim precisa ser depois do início.',
  tooLong: 'Um evento pode durar até 31 dias.',
  attendees: 'Convide até 200 pessoas por evento.',
  badAttendee: 'Uma das pessoas convidadas não existe ou está desativada.',
  reminder: 'Escolha um lembrete entre 0 minutos e 7 dias antes.',
  response: 'Resposta inválida.',
  notInvited: 'Você não está entre os convidados deste evento.',
  meetingPermission: 'Você não tem permissão para criar reuniões.',
  meetingOff: 'Não é possível desfazer a reunião de um evento. Cancele o evento se ela não vai mais acontecer.',
  invitedOnly: 'Só os convidados entram nesta reunião. Peça a quem organizou para convidar você.',
  range: 'Escolha um período de até 400 dias.',
  card: (title: string, url: string) => `Reunião: [${title}](${url})`,
  cardText: 'Reunião do chat',
  canceledMsg: (title: string) => `A reunião **${title}** foi cancelada.`,
  movedMsg: (title: string, when: string) => `A reunião **${title}** mudou de horário: ${when}.`,
  invitePush: (by: string) => `${by} convidou você`,
};

const MAX_ATTENDEES = 200;
const DAY = 86_400_000;
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';

export const calendarOn = () => getSetting<boolean>('Calendar_Enabled') !== false;
export function assertCalendar() {
  if (!calendarOn()) throw forbidden(CAL_TEXT.off);
}

// abc-defg-hij: fácil de ditar e de digitar, 33^10 combinações.
function meetingCode(): string {
  const bytes = crypto.randomBytes(10);
  const s = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}

export const meetingUrl = (code: string) => `${siteUrl()}/meet/${code}`;

// ---------- Leitura ----------

interface Viewer {
  userId: string;
}

async function hydrate(rows: any[], viewer: Viewer): Promise<CalendarEvent[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const owners = [...new Set(rows.map((r) => r.owner_id))];
  const [att, users] = await Promise.all([
    many(
      `SELECT a.event_id, a.response, u.id, u.username, u.name FROM calendar_attendees a JOIN users u ON u.id = a.user_id
        WHERE a.event_id = ANY($1) ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.username))`,
      [ids],
    ),
    many(`SELECT id, username, name FROM users WHERE id = ANY($1)`, [owners]),
  ]);
  const byEvent = new Map<string, any[]>();
  for (const a of att) {
    const list = byEvent.get(a.event_id) ?? [];
    list.push(a);
    byEvent.set(a.event_id, list);
  }
  const userMap = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const list = byEvent.get(r.id) ?? [];
    const mine = list.find((a) => a.id === viewer.userId);
    const owner = userMap.get(r.owner_id);
    return {
      _id: r.id,
      title: r.title,
      description: r.description,
      location: r.location,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      allDay: r.all_day,
      source: r.source,
      status: r.status,
      owner: { _id: r.owner_id, username: owner?.username ?? '', name: owner?.name ?? '' },
      attendees: list.map((a) => ({ _id: a.id, username: a.username, name: a.name ?? '', response: a.response })),
      myResponse: r.owner_id === viewer.userId ? 'organizer' : (mine?.response ?? 'pending'),
      reminderMinutes: r.reminder_minutes ?? null,
      meeting: r.is_meeting ? { code: r.meeting_code, url: meetingUrl(r.meeting_code), rid: r.room_id ?? null, access: r.meeting_access } : null,
      externalUrl: r.external_url ?? null,
      externalJoinUrl: r.external_join_url ?? null,
      canEdit: r.source === 'chat' && r.owner_id === viewer.userId && r.status === 'confirmed',
      updatedAt: new Date(r.updated_at).toISOString(),
    } satisfies CalendarEvent;
  });
}

export async function eventFor(id: string, viewerId: string): Promise<CalendarEvent | null> {
  const r = await one('SELECT * FROM calendar_events WHERE id = $1', [id]);
  return r ? (await hydrate([r], { userId: viewerId }))[0] : null;
}

async function canSee(userId: string, row: any): Promise<boolean> {
  if (row.owner_id === userId) return true;
  if (row.source !== 'chat') return false;
  return !!(await one('SELECT 1 FROM calendar_attendees WHERE event_id = $1 AND user_id = $2', [row.id, userId]));
}

export async function getEvent(ctx: Ctx, id: string): Promise<CalendarEvent> {
  assertCalendar();
  const row = await one('SELECT * FROM calendar_events WHERE id = $1', [id]);
  if (!row || !(await canSee(ctx.userId, row))) throw notFound('error-event-not-found', CAL_TEXT.notFound);
  return (await hydrate([row], ctx))[0];
}

function rangeOf(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const from = new Date(String(fromRaw ?? ''));
  const to = new Date(String(toRaw ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 400 * DAY) {
    throw badRequest('error-invalid-params', CAL_TEXT.range);
  }
  return { from, to };
}

// Eventos da pessoa que tocam o período [from, to): os dela (do chat e trazidos) e os que a convidaram, sem os que recusou
// quando pedir (hideDeclined). Cancelados não aparecem.
export async function listEvents(ctx: Ctx, input: { from?: unknown; to?: unknown; hideDeclined?: boolean }): Promise<CalendarEvent[]> {
  assertCalendar();
  const { from, to } = rangeOf(input.from, input.to);
  const rows = await many(
    `SELECT e.* FROM calendar_events e
      WHERE e.status = 'confirmed' AND e.starts_at < $3 AND e.ends_at > $2
        AND (e.owner_id = $1 OR EXISTS (
          SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $1 AND ($4::boolean IS NOT TRUE OR a.response <> 'declined')))
      ORDER BY e.starts_at, e.id LIMIT 2000`,
    [ctx.userId, from, to, input.hideDeclined === true],
  );
  return hydrate(rows, ctx);
}

// Horários ocupados de outras pessoas (só início e fim, sem título), para escolher um horário livre ao convidar.
export async function busyTimes(ctx: Ctx, input: { userIds: string[]; from?: unknown; to?: unknown }): Promise<Record<string, { startsAt: string; endsAt: string }[]>> {
  assertCalendar();
  const { from, to } = rangeOf(input.from, input.to);
  if (to.getTime() - from.getTime() > 31 * DAY) throw badRequest('error-invalid-params', CAL_TEXT.range);
  const ids = [...new Set(input.userIds)].slice(0, 50);
  const out: Record<string, { startsAt: string; endsAt: string }[]> = Object.fromEntries(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = await many(
    `SELECT DISTINCT p.uid, e.starts_at, e.ends_at FROM calendar_events e
       JOIN LATERAL (
         SELECT e.owner_id AS uid
         UNION SELECT a.user_id FROM calendar_attendees a WHERE a.event_id = e.id AND a.response IN ('accepted', 'tentative')
       ) p ON p.uid = ANY($1)
      WHERE e.status = 'confirmed' AND NOT e.all_day AND e.starts_at < $3 AND e.ends_at > $2
      ORDER BY e.starts_at LIMIT 2000`,
    [ids, from, to],
  );
  for (const r of rows) out[r.uid]?.push({ startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString() });
  return out;
}

// ---------- Validação ----------

interface Clean {
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  attendeeIds: string[] | undefined;
  isMeeting: boolean;
  meetingAccess: MeetingAccess;
  reminderMinutes: number | null;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Dia inteiro: datas AAAA-MM-DD com o último dia incluído; grava 00:00 UTC do primeiro dia até 00:00 UTC do dia seguinte.
function utcDay(v: string): Date {
  const d = new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
  if (!DATE_ONLY.test(v.slice(0, 10)) || Number.isNaN(d.getTime())) throw badRequest('error-invalid-params', CAL_TEXT.start);
  return d;
}

async function clean(ctx: Ctx, input: Partial<CalendarEventInput>, prev?: any): Promise<Clean> {
  const title = [...text(input.title ?? prev?.title)].join('');
  if (!title) throw badRequest('error-invalid-params', CAL_TEXT.title);
  if ([...title].length > 200) throw badRequest('error-invalid-params', CAL_TEXT.titleLong);
  const description = typeof input.description === 'string' ? input.description.trim() : (prev?.description ?? '');
  if (description.length > 5000) throw badRequest('error-invalid-params', CAL_TEXT.descriptionLong);
  const location = typeof input.location === 'string' ? input.location.trim() : (prev?.location ?? '');
  if (location.length > 300) throw badRequest('error-invalid-params', CAL_TEXT.locationLong);
  const allDay = input.allDay === undefined ? !!prev?.all_day : input.allDay === true;
  let startsAt: Date;
  let endsAt: Date;
  const rawStart = input.startsAt ?? (prev ? new Date(prev.starts_at).toISOString() : '');
  const rawEnd = input.endsAt ?? (prev ? new Date(prev.ends_at).toISOString() : '');
  if (typeof rawStart !== 'string' || !rawStart) throw badRequest('error-invalid-params', CAL_TEXT.start);
  if (typeof rawEnd !== 'string' || !rawEnd) throw badRequest('error-invalid-params', CAL_TEXT.end);
  if (allDay) {
    startsAt = utcDay(rawStart);
    // Vindo do próprio evento (prev), o fim já está gravado sem o último dia incluído.
    const sameEnd = prev && input.endsAt === undefined && prev.all_day;
    endsAt = sameEnd ? new Date(prev.ends_at) : new Date(utcDay(rawEnd).getTime() + DAY);
  } else {
    startsAt = new Date(rawStart);
    endsAt = new Date(rawEnd);
    if (Number.isNaN(startsAt.getTime())) throw badRequest('error-invalid-params', CAL_TEXT.start);
    if (Number.isNaN(endsAt.getTime())) throw badRequest('error-invalid-params', CAL_TEXT.end);
  }
  if (endsAt.getTime() <= startsAt.getTime()) throw badRequest('error-invalid-params', CAL_TEXT.end);
  if (endsAt.getTime() - startsAt.getTime() > 31 * DAY) throw badRequest('error-invalid-params', CAL_TEXT.tooLong);

  let attendeeIds: string[] | undefined;
  if (input.attendeeIds !== undefined) {
    if (!Array.isArray(input.attendeeIds)) throw badRequest('error-invalid-params', CAL_TEXT.badAttendee);
    const ids = [...new Set(input.attendeeIds.filter((x): x is string => typeof x === 'string' && !!x))].filter((id) => id !== (prev?.owner_id ?? ctx.userId));
    if (ids.length > MAX_ATTENDEES) throw badRequest('error-invalid-params', CAL_TEXT.attendees);
    const found = ids.length ? await many(`SELECT id FROM users WHERE id = ANY($1) AND active AND type = 'user'`, [ids]) : [];
    if (found.length !== ids.length) throw badRequest('error-invalid-params', CAL_TEXT.badAttendee);
    attendeeIds = ids;
  }
  let reminderMinutes: number | null = prev ? (prev.reminder_minutes ?? null) : 10;
  if (input.reminderMinutes !== undefined) {
    if (input.reminderMinutes === null) reminderMinutes = null;
    else {
      const n = Number(input.reminderMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 10080) throw badRequest('error-invalid-params', CAL_TEXT.reminder);
      reminderMinutes = n;
    }
  }
  const meetingAccess: MeetingAccess = input.meetingAccess === 'org' || input.meetingAccess === 'invited' ? input.meetingAccess : (prev?.meeting_access ?? 'invited');
  const isMeeting = input.isMeeting === undefined ? !!prev?.is_meeting : input.isMeeting === true;
  if (prev?.is_meeting && !isMeeting) throw badRequest('error-invalid-params', CAL_TEXT.meetingOff);
  return { title, description, location, startsAt, endsAt, allDay, attendeeIds, isMeeting, meetingAccess, reminderMinutes };
}

// ---------- Avisos ----------

async function involved(eventId: string, ownerId: string): Promise<string[]> {
  const rows = await many(`SELECT user_id FROM calendar_attendees WHERE event_id = $1`, [eventId]);
  return [ownerId, ...rows.map((r) => r.user_id)];
}

export async function changed(userIds: string[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  bus.publish({ users: ids }, { type: 'calendar.changed' });
  await markDirty(ids);
}

const whenFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'America/Sao_Paulo' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' });
export function whenText(e: { allDay: boolean; startsAt: string | Date }) {
  const d = new Date(e.startsAt);
  return e.allDay ? `${dayFmt.format(d)} (dia inteiro)` : whenFmt.format(d);
}

async function announceInvites(ctx: Ctx, eventId: string, userIds: string[]) {
  if (!userIds.length) return;
  const by = await one('SELECT id, username, name FROM users WHERE id = $1', [ctx.userId]);
  const byRef = { _id: ctx.userId, username: String(by?.username ?? ctx.username), name: String(by?.name ?? '') };
  for (const uid of userIds) {
    const ev = await eventFor(eventId, uid);
    if (ev) bus.publish({ user: uid }, { type: 'calendar.invite', event: ev, by: byRef });
  }
  const ev = await eventFor(eventId, ctx.userId);
  if (!ev) return;
  void sendPush(userIds, {
    title: ev.title,
    body: `${CAL_TEXT.invitePush(byRef.name || byRef.username)} · ${whenText(ev)}`,
    url: `/calendar?evento=${encodeURIComponent(eventId)}`,
    tag: `calendar-${eventId}`,
  }).catch(() => {});
}

// ---------- Reunião: sala e cartão ----------

const linkLabel = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')');

async function meetingRoomFor(ctx: Ctx, eventId: string, code: string, c: Clean): Promise<string> {
  const users = c.attendeeIds?.length ? await many(`SELECT username FROM users WHERE id = ANY($1)`, [c.attendeeIds]) : [];
  const room = await createRoom(ctx, {
    type: 'p',
    name: `reuniao-${code}`,
    fname: c.title,
    topic: CAL_TEXT.cardText,
    members: users.map((u) => u.username),
    skipPermission: true,
  });
  await query(`UPDATE calendar_events SET room_id = $2 WHERE id = $1`, [eventId, room.id]);
  await postMeetingCard(ctx, room.id, eventId, code, c);
  return room.id;
}

async function postMeetingCard(ctx: Ctx, rid: string, eventId: string, code: string, c: { title: string; startsAt: Date; endsAt: Date }) {
  const u = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  const url = meetingUrl(code);
  const meeting: MessageMeeting = {
    provider: 'wescc',
    kind: 'created',
    meetingId: eventId,
    joinUrl: url,
    subject: c.title,
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    by: { _id: ctx.userId, username: String(u?.username ?? ctx.username), name: String(u?.name ?? '') },
  };
  await sendMessage(
    ctx,
    { rid, msg: CAL_TEXT.card(linkLabel(c.title), url), meeting, attachments: [{ type: 'meeting', title: c.title, title_link: url, text: CAL_TEXT.cardText }] },
    { internalAttachments: true, integration: true, skipCommands: true, ignoreReadOnly: true },
  ).catch(() => {});
}

async function roomNote(ctx: Ctx, rid: string | null, msg: string) {
  if (!rid) return;
  await sendMessage(ctx, { rid, msg }, { skipCommands: true, integration: true, ignoreReadOnly: true }).catch(() => {});
}

// ---------- Escrita ----------

export async function createEvent(ctx: Ctx, input: Partial<CalendarEventInput>): Promise<CalendarEvent> {
  assertCalendar();
  const c = await clean(ctx, input);
  if (c.isMeeting && !(await hasPermission(ctx.userId, 'create-calendar-meeting'))) throw forbidden(CAL_TEXT.meetingPermission);
  // Restrição de conversas (papel Operação): convidar é levar a pessoa para uma conversa privada, como numa sala.
  if (c.attendeeIds?.length) await assertCanBringIn(ctx.userId, { t: 'p' }, c.attendeeIds);
  const id = newId();
  const code = c.isMeeting ? meetingCode() : null;
  await query(
    `INSERT INTO calendar_events (id, owner_id, title, description, location, starts_at, ends_at, all_day, is_meeting, meeting_code, meeting_access, reminder_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, ctx.userId, c.title, c.description, c.location, c.startsAt, c.endsAt, c.allDay, c.isMeeting, code, c.meetingAccess, c.reminderMinutes],
  );
  for (const uid of c.attendeeIds ?? []) await query(`INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, uid]);
  if (code) {
    try {
      await meetingRoomFor(ctx, id, code, c);
    } catch (e) {
      await query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
      throw e;
    }
  }
  await audit(actorOf(ctx), 'calendar.event.created', { eventId: id }, { meeting: c.isMeeting, attendees: c.attendeeIds?.length ?? 0 });
  await changed([ctx.userId, ...(c.attendeeIds ?? [])]);
  await announceInvites(ctx, id, c.attendeeIds ?? []);
  return (await eventFor(id, ctx.userId))!;
}

async function ownRow(ctx: Ctx, id: string) {
  const row = await one('SELECT * FROM calendar_events WHERE id = $1', [id]);
  if (!row || !(await canSee(ctx.userId, row))) throw notFound('error-event-not-found', CAL_TEXT.notFound);
  if (row.source !== 'chat') throw badRequest('error-event-read-only', CAL_TEXT.readOnly);
  if (row.owner_id !== ctx.userId) throw forbidden(CAL_TEXT.onlyOwner);
  if (row.status !== 'confirmed') throw badRequest('error-event-canceled', CAL_TEXT.canceled);
  return row;
}

export async function updateEvent(ctx: Ctx, id: string, input: Partial<CalendarEventInput>): Promise<CalendarEvent> {
  assertCalendar();
  const prev = await ownRow(ctx, id);
  const c = await clean(ctx, input, prev);
  const before = (await many(`SELECT user_id FROM calendar_attendees WHERE event_id = $1`, [id])).map((r) => r.user_id as string);
  const next = c.attendeeIds ?? before;
  const added = next.filter((u) => !before.includes(u));
  const removed = before.filter((u) => !next.includes(u));
  if (c.isMeeting && !prev.is_meeting && !(await hasPermission(ctx.userId, 'create-calendar-meeting'))) throw forbidden(CAL_TEXT.meetingPermission);
  if (added.length) await assertCanBringIn(ctx.userId, prev.room_id ? { id: prev.room_id, t: 'p' } : { t: 'p' }, added);
  const moved = c.startsAt.getTime() !== new Date(prev.starts_at).getTime() || c.endsAt.getTime() !== new Date(prev.ends_at).getTime() || c.allDay !== prev.all_day;
  const code = c.isMeeting ? (prev.meeting_code ?? meetingCode()) : null;
  await query(
    `UPDATE calendar_events SET title = $2, description = $3, location = $4, starts_at = $5, ends_at = $6, all_day = $7, is_meeting = $8,
       meeting_code = $9, meeting_access = $10, reminder_minutes = $11, reminded_at = CASE WHEN $12 OR reminder_minutes IS DISTINCT FROM $11 THEN NULL ELSE reminded_at END,
       updated_at = now()
     WHERE id = $1`,
    [id, c.title, c.description, c.location, c.startsAt, c.endsAt, c.allDay, c.isMeeting, code, c.meetingAccess, c.reminderMinutes, moved],
  );
  if (removed.length) await query(`DELETE FROM calendar_attendees WHERE event_id = $1 AND user_id = ANY($2)`, [id, removed]);
  for (const uid of added) await query(`INSERT INTO calendar_attendees (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, uid]);
  // Mudou o horário: quem já tinha respondido responde de novo.
  if (moved) await query(`UPDATE calendar_attendees SET response = 'pending', responded_at = NULL WHERE event_id = $1 AND response <> 'declined'`, [id]);

  let rid: string | null = prev.room_id ?? null;
  if (code && !prev.is_meeting) rid = await meetingRoomFor(ctx, id, code, { ...c, attendeeIds: next });
  else if (rid && (await getRoom(rid))) {
    if (c.title !== prev.title) {
      await query(`UPDATE rooms SET fname = $2, updated_at = now() WHERE id = $1`, [rid, c.title]);
      await notifyRoomUpdated(rid);
    }
    const me = { id: ctx.userId, username: ctx.username };
    for (const uid of added) await addUserToRoom(rid, uid, { inviter: me }).catch(() => {});
    for (const uid of removed) await removeUserFromRoom(rid, uid, { by: me }).catch(() => {});
    if (moved) await roomNote(ctx, rid, CAL_TEXT.movedMsg(c.title, whenText({ allDay: c.allDay, startsAt: c.startsAt })));
  }
  await audit(actorOf(ctx), 'calendar.event.updated', { eventId: id }, { added: added.length, removed: removed.length, moved });
  await changed([ctx.userId, ...before, ...added]);
  await announceInvites(ctx, id, added);
  return (await eventFor(id, ctx.userId))!;
}

export async function cancelEvent(ctx: Ctx, id: string): Promise<void> {
  assertCalendar();
  const row = await ownRow(ctx, id);
  const people = await involved(id, row.owner_id);
  await query(`UPDATE calendar_events SET status = 'canceled', canceled_at = now(), updated_at = now() WHERE id = $1`, [id]);
  if (row.is_meeting) await roomNote(ctx, row.room_id, CAL_TEXT.canceledMsg(row.title));
  const others = people.filter((u) => u !== ctx.userId);
  if (others.length) {
    void sendPush(others, { title: row.title, body: CAL_TEXT.canceled, url: '/calendar', tag: `calendar-${id}` }).catch(() => {});
  }
  await audit(actorOf(ctx), 'calendar.event.canceled', { eventId: id }, {});
  await changed(people);
}

export async function respond(ctx: Ctx, id: string, response: unknown): Promise<CalendarEvent> {
  assertCalendar();
  if (response !== 'accepted' && response !== 'declined' && response !== 'tentative') throw badRequest('error-invalid-params', CAL_TEXT.response);
  const row = await one('SELECT * FROM calendar_events WHERE id = $1', [id]);
  if (!row || !(await canSee(ctx.userId, row))) throw notFound('error-event-not-found', CAL_TEXT.notFound);
  if (row.status !== 'confirmed') throw badRequest('error-event-canceled', CAL_TEXT.canceled);
  const r = await query(`UPDATE calendar_attendees SET response = $3, responded_at = now() WHERE event_id = $1 AND user_id = $2`, [id, ctx.userId, response as AttendeeResponse]);
  if (!r.rowCount) throw badRequest('error-not-invited', CAL_TEXT.notInvited);
  await changed(await involved(id, row.owner_id));
  return (await eventFor(id, ctx.userId))!;
}

// ---------- Link da reunião ----------

async function meetingRow(code: unknown) {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (!/^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/.test(c)) throw notFound('error-meeting-not-found', CAL_TEXT.meetingNotFound);
  const row = await one(`SELECT * FROM calendar_events WHERE meeting_code = $1 AND is_meeting`, [c]);
  if (!row) throw notFound('error-meeting-not-found', CAL_TEXT.meetingNotFound);
  return row;
}

export async function meetingInfo(ctx: Ctx, code: unknown): Promise<MeetingInfo> {
  assertCalendar();
  const row = await meetingRow(code);
  const invited = await canSee(ctx.userId, row);
  // Quem não foi convidado só vê a reunião aberta para a organização.
  if (!invited && row.meeting_access !== 'org') throw forbidden(CAL_TEXT.invitedOnly);
  const joined = !!(row.room_id && (await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [row.room_id, ctx.userId])));
  const [event] = await hydrate([row], ctx);
  // Fora da lista de convidados, a lista de quem vai não aparece.
  if (!invited) event.attendees = [];
  return { event, canJoin: row.status === 'confirmed' && (invited || row.meeting_access === 'org'), joined };
}

// Entrar pelo link: convidado que saiu da sala volta; com o link aberto para a organização, a pessoa vira convidada.
export async function joinMeeting(ctx: Ctx, code: unknown): Promise<{ rid: string; event: CalendarEvent }> {
  assertCalendar();
  const row = await meetingRow(code);
  if (row.status !== 'confirmed') throw badRequest('error-event-canceled', CAL_TEXT.canceled);
  const invited = await canSee(ctx.userId, row);
  if (!invited && row.meeting_access !== 'org') throw forbidden(CAL_TEXT.invitedOnly);
  if (!row.room_id || !(await getRoom(row.room_id))) throw notFound('error-meeting-not-found', CAL_TEXT.meetingNotFound);
  if (row.owner_id !== ctx.userId) {
    await assertCanBringIn(row.owner_id, { id: row.room_id, t: 'p' }, [ctx.userId], { joinerId: ctx.userId });
    if (!invited) {
      await query(`INSERT INTO calendar_attendees (event_id, user_id, response, responded_at) VALUES ($1, $2, 'accepted', now()) ON CONFLICT DO NOTHING`, [row.id, ctx.userId]);
      await changed(await involved(row.id, row.owner_id));
    }
  }
  await addUserToRoom(row.room_id, ctx.userId);
  return { rid: row.room_id, event: (await eventFor(row.id, ctx.userId))! };
}

// Reunião ligada a uma sala (cabeçalho da sala da reunião).
export async function meetingForRoom(ctx: Ctx, rid: string): Promise<CalendarEvent | null> {
  if (!calendarOn()) return null;
  const row = await one(`SELECT * FROM calendar_events WHERE room_id = $1 AND is_meeting ORDER BY created_at DESC LIMIT 1`, [rid]);
  if (!row || !(await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, ctx.userId]))) return null;
  return (await hydrate([row], ctx))[0];
}
