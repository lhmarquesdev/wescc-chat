import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool';
import { CAL_TEXT } from '../src/calendar/events';
import { sendDueReminders } from '../src/calendar/reminders';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Agenda: eventos, convites e respostas, reuniões com sala e link e lembretes. Tudo fica no chat (sem agendas externas).

const SITE = 'https://chat.explorer.example';
const H = 3_600_000;
const DAY = 24 * H;
let A: Auth;
let ana: Auth;
let bruno: Auth;
let carla: Auth;

const at = (msFromNow: number) => new Date(Math.round((Date.now() + msFromNow) / 60_000) * 60_000).toISOString();
const range = { from: new Date(Date.now() - 2 * DAY).toISOString(), to: new Date(Date.now() + 40 * DAY).toISOString() };

async function setSettings(settings: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await setSettings({ API_Enable_Rate_Limiter: false, Site_Url: SITE });
  ana = await newUser(A, { name: 'Ana Souza' });
  bruno = await newUser(A, { name: 'Bruno Lima' });
  carla = await newUser(A, { name: 'Carla Dias' });
});

afterAll(async () => {
  await stopServer();
});

describe('eventos', () => {
  it('cria, lista para dono e convidado e esconde de quem não foi convidado', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Planejamento', startsAt: at(DAY), endsAt: at(DAY + H), attendeeIds: [bruno.userId], location: 'Sala 3' }, ana);
    expect(c.success, JSON.stringify(c)).toBe(true);
    expect(c.event.myResponse).toBe('organizer');
    expect(c.event.attendees.map((a: any) => [a._id, a.response])).toEqual([[bruno.userId, 'pending']]);
    expect(c.event.meeting).toBeNull();
    expect(c.event.reminderMinutes).toBe(10);

    const mine = await api('GET', 'calendar.events', range, ana);
    expect(mine.events.map((e: any) => e._id)).toContain(c.event._id);
    const his = await api('GET', 'calendar.events', range, bruno);
    const seen = his.events.find((e: any) => e._id === c.event._id);
    expect(seen.myResponse).toBe('pending');
    expect(seen.canEdit).toBe(false);
    expect((await api('GET', 'calendar.events', range, carla)).events.find((e: any) => e._id === c.event._id)).toBeUndefined();
    expect((await api('GET', 'calendar.event', { eventId: c.event._id }, carla)).status).toBe(404);
    // Convidado não edita.
    expect((await api('POST', 'calendar.update', { eventId: c.event._id, title: 'X' }, bruno)).error).toBe(CAL_TEXT.onlyOwner);
  });

  it('valida título, horário, duração e convidados', async () => {
    const base = { title: 'A', startsAt: at(DAY), endsAt: at(DAY + H) };
    expect((await api('POST', 'calendar.create', { ...base, title: '  ' }, ana)).error).toBe(CAL_TEXT.title);
    expect((await api('POST', 'calendar.create', { ...base, endsAt: at(DAY - H) }, ana)).error).toBe(CAL_TEXT.end);
    expect((await api('POST', 'calendar.create', { ...base, endsAt: at(40 * DAY) }, ana)).error).toBe(CAL_TEXT.tooLong);
    expect((await api('POST', 'calendar.create', { ...base, attendeeIds: ['nao-existe'] }, ana)).error).toBe(CAL_TEXT.badAttendee);
    expect((await api('POST', 'calendar.create', { ...base, reminderMinutes: -1 }, ana)).error).toBe(CAL_TEXT.reminder);
    expect((await api('GET', 'calendar.events', { from: range.to, to: range.from }, ana)).error).toBe(CAL_TEXT.range);
  });

  it('dia inteiro guarda do primeiro dia até o dia seguinte ao último', async () => {
    const day = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const c = await api('POST', 'calendar.create', { title: 'Feriado', allDay: true, startsAt: day, endsAt: next }, ana);
    expect(c.event.allDay).toBe(true);
    expect(c.event.startsAt).toBe(`${day}T00:00:00.000Z`);
    expect(c.event.endsAt).toBe(new Date(Date.parse(`${next}T00:00:00Z`) + DAY).toISOString());
    // Editar só o título mantém as datas.
    const u = await api('POST', 'calendar.update', { eventId: c.event._id, title: 'Feriado municipal' }, ana);
    expect([u.event.startsAt, u.event.endsAt]).toEqual([c.event.startsAt, c.event.endsAt]);
  });

  it('resposta do convidado, e mudar o horário pede resposta de novo', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Revisão', startsAt: at(2 * DAY), endsAt: at(2 * DAY + H), attendeeIds: [bruno.userId, carla.userId] }, ana);
    expect((await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'accepted' }, bruno)).event.myResponse).toBe('accepted');
    expect((await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'declined' }, carla)).event.myResponse).toBe('declined');
    expect((await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'talvez' }, carla)).error).toBe(CAL_TEXT.response);
    expect((await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'accepted' }, ana)).error).toBe(CAL_TEXT.notInvited);
    // Quem recusou some da lista com hideDeclined.
    expect((await api('GET', 'calendar.events', { ...range, hideDeclined: 'true' }, carla)).events.some((e: any) => e._id === c.event._id)).toBe(false);
    const u = await api('POST', 'calendar.update', { eventId: c.event._id, startsAt: at(3 * DAY), endsAt: at(3 * DAY + H) }, ana);
    const resp = Object.fromEntries(u.event.attendees.map((a: any) => [a._id, a.response]));
    expect(resp).toEqual({ [bruno.userId]: 'pending', [carla.userId]: 'declined' });
  });

  it('cancelar tira o evento da agenda de todos', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Cancelável', startsAt: at(DAY), endsAt: at(DAY + H), attendeeIds: [bruno.userId] }, ana);
    expect((await api('POST', 'calendar.cancel', { eventId: c.event._id }, bruno)).error).toBe(CAL_TEXT.onlyOwner);
    expect((await api('POST', 'calendar.cancel', { eventId: c.event._id }, ana)).success).toBe(true);
    expect((await api('GET', 'calendar.events', range, bruno)).events.some((e: any) => e._id === c.event._id)).toBe(false);
    expect((await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'accepted' }, bruno)).error).toBe(CAL_TEXT.canceled);
  });

  it('horários ocupados mostram só início e fim de quem aceitou', async () => {
    const start = at(5 * DAY);
    const c = await api('POST', 'calendar.create', { title: 'Particular', startsAt: start, endsAt: at(5 * DAY + H), attendeeIds: [carla.userId] }, bruno);
    let busy = await api('GET', 'calendar.busy', { userIds: `${bruno.userId},${carla.userId}`, from: at(4 * DAY), to: at(6 * DAY) }, ana);
    expect(busy.busy[bruno.userId]).toEqual([{ startsAt: start, endsAt: at(5 * DAY + H) }]);
    expect(busy.busy[carla.userId]).toEqual([]);
    await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'accepted' }, carla);
    busy = await api('GET', 'calendar.busy', { userIds: carla.userId, from: at(4 * DAY), to: at(6 * DAY) }, ana);
    expect(busy.busy[carla.userId]).toHaveLength(1);
    expect(JSON.stringify(busy)).not.toContain('Particular');
  });

  it('convite avisa o convidado na hora', async () => {
    const ws = connectWs(bruno);
    await ws.ready;
    const c = await api('POST', 'calendar.create', { title: 'Café', startsAt: at(DAY), endsAt: at(DAY + H), attendeeIds: [bruno.userId] }, ana);
    const ev = await ws.waitFor((e) => e.type === 'calendar.invite' && e.event._id === c.event._id);
    expect(ev.by._id).toBe(ana.userId);
    expect(ev.event.myResponse).toBe('pending');
    ws.close();
  });
});

describe('reuniões', () => {
  it('cria a sala com os convidados, o cartão com o link e o link só para convidados', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Reunião de turno', startsAt: at(H), endsAt: at(2 * H), attendeeIds: [bruno.userId], isMeeting: true }, ana);
    expect(c.success, JSON.stringify(c)).toBe(true);
    const m = c.event.meeting;
    expect(m.code).toMatch(/^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/);
    expect(m.url).toBe(`${SITE}/meet/${m.code}`);
    expect(m.access).toBe('invited');
    const room = await one('SELECT * FROM rooms WHERE id = $1', [m.rid]);
    expect([room.t, room.fname]).toEqual(['p', 'Reunião de turno']);
    const members = (await many('SELECT user_id FROM subscriptions WHERE room_id = $1', [m.rid])).map((r) => r.user_id).sort();
    expect(members).toEqual([ana.userId, bruno.userId].sort());
    const card = await one(`SELECT * FROM messages WHERE room_id = $1 AND extra ? 'meeting'`, [m.rid]);
    expect(card.extra.meeting).toMatchObject({ provider: 'wescc', meetingId: c.event._id, joinUrl: m.url, subject: 'Reunião de turno' });

    const info = await api('GET', 'calendar.meeting', { code: m.code }, bruno);
    expect([info.canJoin, info.joined]).toEqual([true, true]);
    expect((await api('GET', 'calendar.meeting', { code: m.code }, carla)).error).toBe(CAL_TEXT.invitedOnly);
    expect((await api('POST', 'calendar.meeting.join', { code: m.code }, carla)).error).toBe(CAL_TEXT.invitedOnly);
    expect((await api('GET', 'calendar.meeting', { code: 'xxx-yyyy-zzz' }, bruno)).error).toBe(CAL_TEXT.meetingNotFound);
    expect((await api('GET', 'calendar.meeting.byRoom', { roomId: m.rid }, bruno)).event._id).toBe(c.event._id);
    expect((await api('GET', 'calendar.meeting.byRoom', { roomId: m.rid }, carla)).event).toBeNull();
  });

  it('link aberto para a organização: quem entra vira convidado e membro da sala', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Aberta', startsAt: at(H), endsAt: at(2 * H), isMeeting: true, meetingAccess: 'org' }, ana);
    const code = c.event.meeting.code;
    const info = await api('GET', 'calendar.meeting', { code }, carla);
    expect([info.canJoin, info.joined]).toEqual([true, false]);
    const j = await api('POST', 'calendar.meeting.join', { code }, carla);
    expect(j.rid).toBe(c.event.meeting.rid);
    expect(j.event.myResponse).toBe('accepted');
    expect(await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [j.rid, carla.userId])).toBeTruthy();
  });

  it('mudar convidados acompanha a sala; o título renomeia a sala; cancelar avisa na sala', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Sync', startsAt: at(DAY), endsAt: at(DAY + H), attendeeIds: [bruno.userId], isMeeting: true }, ana);
    const rid = c.event.meeting.rid;
    const u = await api('POST', 'calendar.update', { eventId: c.event._id, attendeeIds: [carla.userId], title: 'Sync semanal' }, ana);
    expect(u.success, JSON.stringify(u)).toBe(true);
    const members = (await many('SELECT user_id FROM subscriptions WHERE room_id = $1', [rid])).map((r) => r.user_id).sort();
    expect(members).toEqual([ana.userId, carla.userId].sort());
    expect((await one('SELECT fname FROM rooms WHERE id = $1', [rid])).fname).toBe('Sync semanal');
    expect((await api('POST', 'calendar.update', { eventId: c.event._id, isMeeting: false }, ana)).error).toBe(CAL_TEXT.meetingOff);
    await api('POST', 'calendar.cancel', { eventId: c.event._id }, ana);
    const last = await one(`SELECT msg FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`, [rid]);
    expect(last.msg).toBe(CAL_TEXT.canceledMsg('Sync semanal'));
    expect((await api('GET', 'calendar.meeting', { code: c.event.meeting.code }, carla)).canJoin).toBe(false);
  });

  it('sem a permissão create-calendar-meeting não cria reunião, mas cria evento', async () => {
    const { loadPermissions } = await import('../src/services/permissions');
    await query(`UPDATE permissions SET roles = array_remove(roles, 'user') WHERE id = 'create-calendar-meeting'`);
    await loadPermissions();
    try {
      const r = await api('POST', 'calendar.create', { title: 'R', startsAt: at(DAY), endsAt: at(DAY + H), isMeeting: true }, bruno);
      expect(r.error).toBe(CAL_TEXT.meetingPermission);
      expect((await api('POST', 'calendar.create', { title: 'R', startsAt: at(DAY), endsAt: at(DAY + H) }, bruno)).success).toBe(true);
    } finally {
      await query(`UPDATE permissions SET roles = array_append(roles, 'user') WHERE id = 'create-calendar-meeting'`);
      await loadPermissions();
    }
  });
});

describe('lembretes', () => {
  it('avisa uma vez, antes do início, quem não recusou', async () => {
    const c = await api('POST', 'calendar.create', { title: 'Daqui a pouco', startsAt: at(5 * 60_000), endsAt: at(H), attendeeIds: [bruno.userId, carla.userId], reminderMinutes: 10 }, ana);
    await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'declined' }, carla);
    const later = await api('POST', 'calendar.create', { title: 'Amanhã', startsAt: at(DAY), endsAt: at(DAY + H), reminderMinutes: 10 }, ana);
    const wsB = connectWs(bruno);
    const wsC = connectWs(carla);
    await Promise.all([wsB.ready, wsC.ready]);
    expect(await sendDueReminders()).toBeGreaterThanOrEqual(1);
    const ev = await wsB.waitFor((e) => e.type === 'calendar.reminder' && e.event._id === c.event._id);
    expect(ev.event.title).toBe('Daqui a pouco');
    await sleep(200);
    expect(wsC.events.some((e) => e.type === 'calendar.reminder' && e.event._id === c.event._id)).toBe(false);
    expect(wsB.events.some((e) => e.type === 'calendar.reminder' && e.event._id === later.event._id)).toBe(false);
    const n = wsB.events.length;
    await sendDueReminders();
    await sleep(200);
    expect(wsB.events.slice(n).some((e) => e.type === 'calendar.reminder' && e.event._id === c.event._id)).toBe(false);
    wsB.close();
    wsC.close();
  });
});

describe('sem agendas externas', () => {
  it('não há mais conexão com o Google Agenda nem com o Outlook', async () => {
    const r = await api('GET', 'calendar.accounts', undefined, ana);
    expect(r.success).not.toBe(true);
    const cb = await fetch(urlOf('/integrations/calendar/google/callback?state=x&code=x'), { redirect: 'manual' });
    expect(cb.status).toBe(404);
    expect(await one(`SELECT to_regclass('calendar_accounts') AS t`)).toEqual({ t: null });
    const cols = (await many(`SELECT column_name FROM information_schema.columns WHERE table_name = 'calendar_events'`)).map((c) => c.column_name);
    expect(cols).not.toContain('source');
    expect(cols).not.toContain('account_id');
  });
});
