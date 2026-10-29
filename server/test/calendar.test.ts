import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool';
import { ACCOUNT_TEXT } from '../src/calendar/accounts';
import { CAL_TEXT } from '../src/calendar/events';
import { sendDueReminders } from '../src/calendar/reminders';
import { setSyncKicker } from '../src/calendar/dirty';
import { kickAccount, syncAccount } from '../src/calendar/sync';
import { reloadSecretsKey, setSecret } from '../src/lib/secrets';
import { startFakeCalendars, type FakeCalendars } from './fake-calendars';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Agenda: eventos, convites e respostas, reuniões com sala e link, lembretes e a sincronização com o Google Agenda e o
// Outlook nos três sentidos, contra os fornecedores falsos (fake-calendars.ts). Nada sai para a internet.

process.env.SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const SITE = 'https://chat.explorer.example';
const H = 3_600_000;
const DAY = 24 * H;
let F: FakeCalendars;
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
  F = await startFakeCalendars();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = F.host;
  process.env.GOOGLE_AUTH_URL = F.url;
  process.env.GOOGLE_TOKEN_URL = F.url;
  process.env.GOOGLE_API_URL = F.url;
  process.env.MS_LOGIN_URL = F.url;
  process.env.MS_GRAPH_URL = F.url;
  reloadSecretsKey();
  await startServer();
  A = await admin();
  await setSettings({ API_Enable_Rate_Limiter: false, Site_Url: SITE });
  ana = await newUser(A, { name: 'Ana Souza' });
  bruno = await newUser(A, { name: 'Bruno Lima' });
  carla = await newUser(A, { name: 'Carla Dias' });
});

afterAll(async () => {
  await stopServer();
  await F.close();
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

// Conecta pelo fluxo completo: calendar.accounts.connect → fornecedor (falso) → /integrations/calendar/:p/callback.
async function connect(auth: Auth, provider: 'google' | 'microsoft', direction: 'import' | 'export' | 'both') {
  const res = await fetch(urlOf('/api/v1/calendar.accounts.connect'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': auth.userId, 'x-auth-token': auth.authToken },
    body: JSON.stringify({ provider, direction, returnTo: '/calendar' }),
  });
  const j: any = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j));
  const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0];
  const u = new URL(j.url);
  const code = F.authorize(provider, u.searchParams.get('code_challenge')!);
  const cb = await fetch(urlOf(`/integrations/calendar/${provider}/callback?state=${encodeURIComponent(u.searchParams.get('state')!)}&code=${code}`), {
    headers: { cookie },
    redirect: 'manual',
  });
  return { authorizeUrl: u, location: cb.headers.get('location') ?? '' };
}

async function accountId(auth: Auth, provider: string) {
  return (await one(`SELECT id FROM calendar_accounts WHERE user_id = $1 AND provider = $2`, [auth.userId, provider])).id as string;
}

describe('sincronização', () => {
  let dani: Auth;
  beforeAll(async () => {
    // As rodadas aqui são chamadas pelo teste; a rodada automática logo depois de uma mudança tem teste próprio no fim.
    setSyncKicker(null);
    dani = await newUser(A, { name: 'Dani Alves' });
    await setSettings({ MSTeams_Tenant_Id: '11111111-2222-3333-4444-555555555555', MSTeams_Client_Id: '66666666-7777-8888-9999-000000000000' });
    await setSecret('msteams.clientSecret', 'segredo-teste-ms', A.userId);
  });

  it('sem configuração do administrador a conexão não abre', async () => {
    const p = await api('GET', 'calendar.accounts', {}, dani);
    expect(p.providers.map((x: any) => [x.provider, x.available, x.account])).toEqual([
      ['google', false, null],
      ['microsoft', false, null],
    ]);
    expect((await api('POST', 'calendar.accounts.connect', { provider: 'google' }, dani)).error).toBe(ACCOUNT_TEXT.googleOff);
    expect((await api('POST', 'calendar.admin.save', { googleEnabled: true }, A)).error).toBe(ACCOUNT_TEXT.clientId);
    expect((await api('GET', 'calendar.admin.config', {}, dani)).status).toBe(403);
  });

  it('administração liga o Google e o Outlook', async () => {
    const r = await api('POST', 'calendar.admin.save', { googleEnabled: true, googleClientId: 'cliente-teste.apps.googleusercontent.com', googleClientSecret: 'segredo-google', microsoftEnabled: true }, A);
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.config.google).toMatchObject({ enabled: true, secretSet: true, redirectUri: `${SITE}/integrations/calendar/google/callback` });
    expect(r.config.microsoft).toMatchObject({ enabled: true, secretSet: true, redirectUri: `${SITE}/integrations/calendar/microsoft/callback` });
    expect(JSON.stringify(r)).not.toContain('segredo-google');
  });

  it('Google nos dois sentidos: traz, leva e não duplica', async () => {
    F.google.events.push({ id: 'gext1', title: 'Dentista', description: '', location: 'Centro', start: at(2 * DAY), end: at(2 * DAY + H), allDay: false });
    F.google.events.push({ id: 'gext2', title: 'Viagem', description: '', location: '', start: new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10), end: new Date(Date.now() + 8 * DAY).toISOString().slice(0, 10), allDay: true });
    const mine = await api('POST', 'calendar.create', { title: 'Reunião com cliente', startsAt: at(3 * DAY), endsAt: at(3 * DAY + H), isMeeting: true, description: 'Pauta' }, dani);

    const { authorizeUrl, location } = await connect(dani, 'google', 'both');
    expect(authorizeUrl.searchParams.get('scope')).toContain('calendar.events');
    expect(authorizeUrl.searchParams.get('access_type')).toBe('offline');
    expect(location).toBe('/calendar?integracao=agenda-ok&agenda=google');
    const id = await accountId(dani, 'google');
    const r = await syncAccount(id);
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(2);
    expect(r.pushed).toBeGreaterThanOrEqual(1);

    const list = (await api('GET', 'calendar.events', range, dani)).events;
    const dent = list.find((e: any) => e.title === 'Dentista');
    expect(dent).toMatchObject({ source: 'google', canEdit: false, location: 'Centro' });
    expect(list.find((e: any) => e.title === 'Viagem').allDay).toBe(true);
    expect((await api('POST', 'calendar.update', { eventId: dent._id, title: 'X' }, dani)).error).toBe(CAL_TEXT.readOnly);
    // A cópia lá leva o link da reunião e a marca do chat.
    const copy = F.google.events.find((e) => e.wesccEventId === mine.event._id)!;
    expect(copy.title).toBe('Reunião com cliente');
    expect(copy.description).toContain(mine.event.meeting.url);
    expect(copy.location).toBe(mine.event.meeting.url);

    // Outra rodada: nada volta como evento trazido, nada é gravado de novo.
    const r2 = await syncAccount(id);
    expect([r2.imported, r2.removed, r2.pushed, r2.deleted]).toEqual([0, 0, 0, 0]);
    expect((await api('GET', 'calendar.events', range, dani)).events.filter((e: any) => e.title === 'Reunião com cliente')).toHaveLength(1);

    // Mudou lá, apagou lá, mudou aqui, cancelou aqui.
    F.google.events.find((e) => e.id === 'gext1')!.title = 'Dentista (remarcado)';
    F.google.events.splice(F.google.events.findIndex((e) => e.id === 'gext2'), 1);
    await api('POST', 'calendar.update', { eventId: mine.event._id, title: 'Reunião com o cliente' }, dani);
    const r3 = await syncAccount(id);
    expect([r3.imported, r3.removed, r3.pushed]).toEqual([1, 1, 1]);
    expect(F.google.events.find((e) => e.wesccEventId === mine.event._id)!.title).toBe('Reunião com o cliente');
    await api('POST', 'calendar.cancel', { eventId: mine.event._id }, dani);
    const r4 = await syncAccount(id);
    expect(r4.deleted).toBe(1);
    expect(F.google.events.some((e) => e.wesccEventId === mine.event._id)).toBe(false);
  });

  it('convite aceito vai para a agenda do convidado; recusar tira de lá', async () => {
    const id = await accountId(dani, 'google');
    const c = await api('POST', 'calendar.create', { title: 'Alinhamento', startsAt: at(4 * DAY), endsAt: at(4 * DAY + H), attendeeIds: [dani.userId] }, ana);
    await syncAccount(id);
    expect(F.google.events.some((e) => e.wesccEventId === c.event._id)).toBe(true);
    await api('POST', 'calendar.respond', { eventId: c.event._id, response: 'declined' }, dani);
    await syncAccount(id);
    expect(F.google.events.some((e) => e.wesccEventId === c.event._id)).toBe(false);
  });

  it('só trazer: o chat não grava nada lá; só levar: os trazidos saem do chat', async () => {
    const id = await accountId(dani, 'google');
    expect((await api('POST', 'calendar.accounts.direction', { provider: 'google', direction: 'import' }, dani)).account.direction).toBe('import');
    const before = F.google.events.length;
    await api('POST', 'calendar.create', { title: 'Só no chat', startsAt: at(DAY), endsAt: at(DAY + H) }, dani);
    await syncAccount(id);
    expect(F.google.events.length).toBe(before);
    expect((await api('POST', 'calendar.accounts.direction', { provider: 'google', direction: 'export' }, dani)).success).toBe(true);
    expect((await api('GET', 'calendar.events', range, dani)).events.some((e: any) => e.source === 'google')).toBe(false);
    const r = await syncAccount(id);
    expect(r.imported).toBe(0);
    expect(F.google.events.some((e) => e.title === 'Só no chat')).toBe(true);
    expect((await api('POST', 'calendar.accounts.direction', { provider: 'google', direction: 'lado' }, dani)).error).toBe(ACCOUNT_TEXT.direction);
  });

  it('token vencido é renovado; renovação recusada marca a conta para conectar de novo', async () => {
    const id = await accountId(dani, 'google');
    await query(`UPDATE calendar_accounts SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const old = F.google.access;
    expect((await syncAccount(id)).error).toBeUndefined();
    expect(F.google.access).not.toBe(old);
    F.google.refreshDenied = true;
    await query(`UPDATE calendar_accounts SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    const r = await syncAccount(id);
    expect(r.error).toBe(ACCOUNT_TEXT.expired);
    const p = await api('GET', 'calendar.accounts', {}, dani);
    expect(p.providers.find((x: any) => x.provider === 'google').account).toMatchObject({ status: 'expired', statusText: ACCOUNT_TEXT.expired });
    F.google.refreshDenied = false;
    // Conectar de novo volta ao normal, sem duplicar a conta.
    await connect(dani, 'google', 'both');
    expect((await many(`SELECT id, status FROM calendar_accounts WHERE user_id = $1 AND provider = 'google'`, [dani.userId])).map((x) => x.status)).toEqual(['ok']);
  });

  it('Outlook: traz e leva pelo Microsoft Graph', async () => {
    F.microsoft.events.push({ id: 'AAMkext1', title: 'Treinamento', description: 'Sala B', location: 'Auditório', start: at(2 * DAY), end: at(2 * DAY + 2 * H), allDay: false });
    const { authorizeUrl } = await connect(dani, 'microsoft', 'both');
    expect(authorizeUrl.pathname).toBe('/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize');
    expect(authorizeUrl.searchParams.get('scope')).toContain('Calendars.ReadWrite');
    const id = await accountId(dani, 'microsoft');
    const r = await syncAccount(id);
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(1);
    const t = (await api('GET', 'calendar.events', range, dani)).events.find((e: any) => e.title === 'Treinamento');
    expect(t).toMatchObject({ source: 'microsoft', location: 'Auditório', startsAt: at(2 * DAY), endsAt: at(2 * DAY + 2 * H) });
    expect(F.microsoft.events.some((e) => e.title === 'Só no chat')).toBe(true);
    const r2 = await syncAccount(id);
    expect([r2.imported, r2.pushed]).toEqual([0, 0]);
    expect((await api('GET', 'calendar.events', range, dani)).events.filter((e: any) => e.title === 'Só no chat')).toHaveLength(1);
  });

  it('desconectar apaga lá as cópias futuras e a conta', async () => {
    const copies = () => F.microsoft.events.filter((e) => e.title === 'Só no chat').length;
    expect(copies()).toBe(1);
    expect((await api('POST', 'calendar.accounts.disconnect', { provider: 'microsoft' }, dani)).success).toBe(true);
    expect(copies()).toBe(0);
    expect(await one(`SELECT 1 FROM calendar_accounts WHERE user_id = $1 AND provider = 'microsoft'`, [dani.userId])).toBeNull();
    expect((await api('GET', 'calendar.events', range, dani)).events.some((e: any) => e.source === 'microsoft')).toBe(false);
  });

  it('uma mudança no chat chega lá sem esperar a rodada periódica', async () => {
    setSyncKicker((ids) => ids.forEach(kickAccount));
    try {
      const c = await api('POST', 'calendar.create', { title: 'Na hora', startsAt: at(DAY), endsAt: at(DAY + H) }, dani);
      for (let i = 0; i < 50 && !F.google.events.some((e) => e.wesccEventId === c.event._id); i++) await sleep(100);
      expect(F.google.events.some((e) => e.wesccEventId === c.event._id)).toBe(true);
    } finally {
      setSyncKicker(null);
    }
  });

  it('o retorno do OAuth recusa state de outro navegador', async () => {
    const res = await fetch(urlOf('/api/v1/calendar.accounts.connect'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': dani.userId, 'x-auth-token': dani.authToken },
      body: JSON.stringify({ provider: 'google' }),
    });
    const j: any = await res.json();
    const state = new URL(j.url).searchParams.get('state')!;
    const cb = await fetch(urlOf(`/integrations/calendar/google/callback?state=${encodeURIComponent(state)}&code=x`), { redirect: 'manual' });
    expect(cb.headers.get('location')).toContain('integracao=erro');
  });
});
