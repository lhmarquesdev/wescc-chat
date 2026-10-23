// Reuniões do Teams (§5.5): criar na hora (Graph), anunciar um link colado e montar o link de "Agendar no Teams".
// Ordem fixa das conferências: acesso à sala → restrição de chamadas (assertCanMeet) → escrever na sala → ação.
import { localIso, normalizeTeamsMeetingUrl, teamsScheduleLink, type MessageMeeting } from '@shared/integrations';
import { many, one, query } from '../../db/pool';
import { ApiError, badRequest } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { audit } from '../../services/audit';
import { assertCanCall, directParentFor } from '../../services/direct';
import { canPostInRoom, sendMessage } from '../../services/messages';
import { restrictedRoleIds } from '../../services/permissions';
import { loadRoomForUser } from '../../services/rooms';
import { getSetting } from '../../services/settings';
import { actorOf, type Ctx } from '../../services/users';
import { botIds } from '../bots';
import { meetingsMode } from './config';
import { GRAPH_TEXT, graph, MsError } from './graph';
import { lookup, lookupQuiet } from './people';

export const MEETING_TEXT = {
  off: 'As reuniões do Microsoft Teams estão desligadas.',
  graphOff: 'Criar reunião na hora não está ligado neste chat. Use Agendar no Teams ou Colar link.',
  policy:
    'O Microsoft 365 ainda não permite que o chat crie reuniões em seu nome. O administrador do Teams precisa liberar o aplicativo para você (política de acesso de aplicativo; leva até 30 minutos). Enquanto isso, use Agendar no Teams ou Colar link.',
  link: 'Cole um link de reunião do Teams (https://teams.microsoft.com/l/meetup-join/… ou https://teams.microsoft.com/meet/…).',
  room: 'Reuniões do Teams só podem ser anunciadas em canais, grupos privados e conversas diretas.',
  start: 'Informe a data e a hora de início.',
  minutes: 'Escolha uma duração entre 5 e 480 minutos.',
  card: (subject: string, url: string) => `Reunião do Teams: [${subject}](${url})`,
  cardText: 'Reunião do Microsoft Teams',
  inRoom: (room: string) => `Reunião em #${room}`,
  withPerson: (name: string) => `Reunião com ${name}`,
  content: (site: string, room: string) => `Marcada pelo ${site} em #${room}`,
  contentDirect: (site: string, name: string) => `Marcada pelo ${site} na conversa com ${name}`,
  testSubject: (site: string) => `Teste de reunião do ${site}`,
  testOk: 'Reunião de teste criada e apagada: o Microsoft 365 permite que o chat crie reuniões em seu nome.',
};

const MAX_ATTENDEE_ROOM = 20;
const g = encodeURIComponent;
const siteName = () => String(getSetting('Site_Name') || 'Wescc Chat');

export interface MeetingResult {
  meeting: MessageMeeting;
  messageId: string;
}

function assertMeetings(graphOnly = false) {
  const mode = meetingsMode();
  if (mode === 'off') throw badRequest('error-msteams-disabled', MEETING_TEXT.off);
  if (graphOnly && mode !== 'graph') throw badRequest('error-msteams-disabled', MEETING_TEXT.graphOff);
}

// Reunião é chamada (D20), e a restrição de chamadas não vale só na DM: a discussão criada numa DM segue a regra da DM
// (como as mensagens, assertCanSendDirect), e uma sala com só mais uma pessoa é, na prática, uma ligação direta
// (a mesma regra de startCheck em calls/policy.ts). Sem isso, um grupo privado a dois ou a discussão da DM marcavam
// a reunião que a DM recusa.
export async function assertCanMeet(ctx: Ctx, room: any): Promise<void> {
  if (room?.t === 'd') return assertCanCall(ctx, room);
  if (!restrictedRoleIds().length) return;
  const parent = await directParentFor(ctx, room);
  if (parent) await assertCanCall(ctx, parent);
  const others = await many(
    `SELECT u.id FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.room_id = $1 AND u.active AND u.type = 'user' AND u.id <> $2 LIMIT 2`,
    [room.id, ctx.userId],
  );
  if (others.length === 1) await assertCanCall(ctx, { t: 'd', uids: [ctx.userId, others[0].id] });
}

// As três ações de sala passam por aqui antes de qualquer chamada ao Microsoft 365 (§6).
export async function meetingRoom(ctx: Ctx, roomId: unknown, posts: boolean): Promise<any> {
  if (typeof roomId !== 'string' || !roomId) throw badRequest('error-invalid-params', 'O parâmetro "roomId" é obrigatório.');
  const room = await loadRoomForUser(ctx, roomId);
  if (!['c', 'p', 'd'].includes(room.t)) throw badRequest('error-invalid-room', MEETING_TEXT.room);
  await assertCanMeet(ctx, room);
  if (posts) await canPostInRoom(ctx, room);
  return room;
}

const roomName = (room: any) => String(room?.fname || room?.name || '');

async function otherName(ctx: Ctx, room: any): Promise<string> {
  const other = (room.uids ?? []).find((u: string) => u !== ctx.userId) ?? ctx.userId;
  const u = await one('SELECT name, username FROM users WHERE id = $1', [other]);
  return String(u?.name || u?.username || '');
}

async function subjectFor(ctx: Ctx, room: any, raw: unknown): Promise<string> {
  const typed = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const s = typed || (room.t === 'd' ? MEETING_TEXT.withPerson(await otherName(ctx, room)) : MEETING_TEXT.inRoom(roomName(room)));
  return [...s].slice(0, 200).join('');
}

// Início, fim e o deslocamento do navegador (minutos), validados.
function timesOf(input: { startsAt?: unknown; minutes?: unknown; tzOffset?: unknown }) {
  const tzRaw = Number(input.tzOffset);
  const tz = Number.isInteger(tzRaw) && Math.abs(tzRaw) <= 14 * 60 ? tzRaw : -new Date().getTimezoneOffset();
  let start = new Date();
  if (input.startsAt !== undefined && input.startsAt !== null && input.startsAt !== '') {
    const t = Date.parse(String(input.startsAt));
    if (!Number.isFinite(t)) throw badRequest('error-invalid-params', MEETING_TEXT.start);
    start = new Date(t);
  }
  const minutes = input.minutes === undefined || input.minutes === null || input.minutes === '' ? Number(getSetting('MSTeams_Meeting_Minutes') ?? 30) || 30 : Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw badRequest('error-invalid-params', MEETING_TEXT.minutes);
  return { start, end: new Date(start.getTime() + minutes * 60_000), tz };
}

// 403 por falta da política de acesso de aplicativo → o texto do §5.5; outro 403 → a permissão que falta.
export function meetingError(e: unknown): unknown {
  if (e instanceof MsError && e.msStatus === 403) {
    const detail = `${e.graphCode ?? ''} ${e.graphMessage ?? ''}`;
    if (/access\s*polic/i.test(detail)) return new ApiError(403, 'error-msteams-policy', MEETING_TEXT.policy);
    return new MsError(403, 'error-msteams-forbidden', GRAPH_TEXT.forbidden('OnlineMeetings.ReadWrite.All'), 403, undefined, e.graphCode, e.graphMessage);
  }
  return e;
}

// Rótulo e endereço seguros dentro de [rótulo](endereço).
const linkLabel = (s: string) => s.replace(/\[/g, '(').replace(/\]/g, ')');
const linkHref = (u: string) => u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');

// Grava a reunião e publica o cartão como a própria pessoa (mensagem normal: valem as regras da sala).
async function postCard(
  ctx: Ctx,
  room: any,
  m: { kind: MessageMeeting['kind']; externalId: string | null; joinUrl: string; subject: string; startsAt: string | null; endsAt: string | null; tmid?: string | null },
): Promise<MeetingResult> {
  const id = newId();
  await query(
    `INSERT INTO meetings (id, room_id, provider, kind, external_id, join_url, subject, starts_at, ends_at, created_by) VALUES ($1, $2, 'msteams', $3, $4, $5, $6, $7, $8, $9)`,
    [id, room.id, m.kind, m.externalId, m.joinUrl, m.subject, m.startsAt, m.endsAt, ctx.userId],
  );
  const u = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  const meeting: MessageMeeting = {
    provider: 'msteams',
    kind: m.kind,
    meetingId: id,
    joinUrl: m.joinUrl,
    subject: m.subject,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    by: { _id: ctx.userId, username: String(u?.username ?? ctx.username), name: String(u?.name ?? '') },
  };
  let msg: any;
  try {
    msg = await sendMessage(
      ctx,
      {
        rid: room.id,
        msg: MEETING_TEXT.card(linkLabel(m.subject), linkHref(m.joinUrl)),
        tmid: m.tmid ?? null,
        meeting,
        attachments: [{ type: 'meeting', title: m.subject, title_link: m.joinUrl, text: MEETING_TEXT.cardText }],
      },
      { internalAttachments: true, integration: true, skipCommands: true },
    );
  } catch (e) {
    await query(`DELETE FROM meetings WHERE id = $1`, [id]).catch(() => {});
    throw e;
  }
  const messageId = String(msg?._id ?? '');
  await query(`UPDATE meetings SET message_id = $2 WHERE id = $1`, [id, messageId || null]);
  await audit(actorOf(ctx), 'integration.msteams.meeting.created', { rid: room.id, meetingId: id }, { rid: room.id, kind: m.kind });
  return { meeting, messageId };
}

// ---------- Ações ----------

export async function createMeeting(ctx: Ctx, input: { roomId?: unknown; subject?: unknown; startsAt?: unknown; minutes?: unknown; tzOffset?: unknown; tmid?: string | null }): Promise<MeetingResult> {
  assertMeetings(true);
  const room = await meetingRoom(ctx, input.roomId, true);
  const { start, end, tz } = timesOf(input);
  const subject = await subjectFor(ctx, room, input.subject);
  // E-mail confirmado antes de qualquer chamada (D30).
  const organizer = await lookup(ctx.userId);
  let r: any;
  try {
    r = await graph<any>(
      'app',
      'POST',
      `/users/${g(organizer.id)}/onlineMeetings`,
      {
        subject,
        startDateTime: localIso(start, tz),
        endDateTime: localIso(end, tz),
        lobbyBypassSettings: { scope: String(getSetting('MSTeams_Meeting_Lobby') ?? 'organization'), isDialInBypassEnabled: false },
      },
      { permission: 'OnlineMeetings.ReadWrite.All' },
    );
  } catch (e) {
    throw meetingError(e);
  }
  const joinUrl = normalizeTeamsMeetingUrl(String(r?.joinWebUrl ?? r?.joinUrl ?? ''));
  if (!r?.id || !joinUrl) throw new MsError(502, 'error-msteams-unavailable', GRAPH_TEXT.unavailable);
  return postCard(ctx, room, { kind: 'created', externalId: String(r.id), joinUrl, subject, startsAt: start.toISOString(), endsAt: end.toISOString(), tmid: input.tmid });
}

export async function linkMeeting(ctx: Ctx, input: { roomId?: unknown; url?: unknown; subject?: unknown; tmid?: string | null }): Promise<MeetingResult> {
  assertMeetings();
  const room = await meetingRoom(ctx, input.roomId, true);
  const joinUrl = normalizeTeamsMeetingUrl(typeof input.url === 'string' ? input.url.trim() : '');
  if (!joinUrl) throw badRequest('error-msteams-link', MEETING_TEXT.link);
  const subject = await subjectFor(ctx, room, input.subject);
  return postCard(ctx, room, { kind: 'linked', externalId: null, joinUrl, subject, startsAt: null, endsAt: null, tmid: input.tmid });
}

// Convidados só em DM ou grupo privado de até 20 pessoas, por UPN encontrado pelo e-mail confirmado. Nada é publicado.
export async function scheduleLink(
  ctx: Ctx,
  input: { roomId?: unknown; subject?: unknown; startsAt?: unknown; minutes?: unknown; tzOffset?: unknown; includeMembers?: unknown },
): Promise<{ url: string; skipped: string[] }> {
  assertMeetings();
  const room = await meetingRoom(ctx, input.roomId, false);
  const { start, end, tz } = timesOf(input);
  const subject = await subjectFor(ctx, room, input.subject);
  const content = room.t === 'd' ? MEETING_TEXT.contentDirect(siteName(), await otherName(ctx, room)) : MEETING_TEXT.content(siteName(), roomName(room));
  const attendees: string[] = [];
  const skipped: string[] = [];
  const small = room.t === 'd' || (room.t === 'p' && !room.prid && Number((await one(`SELECT count(*)::int AS n FROM subscriptions WHERE room_id = $1`, [room.id]))?.n ?? 0) <= MAX_ATTENDEE_ROOM);
  if (input.includeMembers === true && meetingsMode() === 'graph' && small) {
    const bots = new Set(await botIds());
    const ids = room.t === 'd' ? (room.uids ?? []) : (await many(`SELECT user_id FROM subscriptions WHERE room_id = $1`, [room.id])).map((s) => s.user_id);
    const members = await many(
      `SELECT id, name, username, email_verified FROM users WHERE id = ANY($1) AND id <> $2 AND active AND type = 'user'
       ORDER BY lower(COALESCE(NULLIF(name, ''), username))`,
      [ids, ctx.userId],
    );
    for (const m of members) {
      if (bots.has(m.id)) continue;
      const name = String(m.name || m.username);
      const person = m.email_verified === true ? await lookupQuiet(m.id) : null;
      if (person?.upn) attendees.push(person.upn);
      else skipped.push(name);
    }
  }
  return { url: teamsScheduleLink({ subject, start, end, offsetMinutes: tz, content, attendeesUpn: attendees }), skipped };
}

// "Testar criação": reunião de 15 minutos de quem testa, apagada em seguida.
export async function testMeeting(ctx: Ctx, tzOffset?: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    assertMeetings(true);
    const { start, end, tz } = timesOf({ minutes: 15, tzOffset });
    const organizer = await lookup(ctx.userId);
    let r: any;
    try {
      r = await graph<any>(
        'app',
        'POST',
        `/users/${g(organizer.id)}/onlineMeetings`,
        { subject: MEETING_TEXT.testSubject(siteName()), startDateTime: localIso(start, tz), endDateTime: localIso(end, tz) },
        { permission: 'OnlineMeetings.ReadWrite.All' },
      );
    } catch (e) {
      throw meetingError(e);
    }
    if (r?.id) await graph('app', 'DELETE', `/users/${g(organizer.id)}/onlineMeetings/${g(String(r.id))}`, undefined, { permission: 'OnlineMeetings.ReadWrite.All' }).catch(() => {});
    return { ok: true, text: MEETING_TEXT.testOk };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, text: e.message };
    throw e;
  }
}
