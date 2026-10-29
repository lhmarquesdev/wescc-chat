import crypto from 'node:crypto';
import type { FakeRequest, FakeServer } from './fake-http';
import { startFake } from './fake-http';

// Google Agenda e Outlook falsos para os testes da Agenda: o endpoint de token de cada um (código + PKCE e renovação),
// a lista de eventos da janela e a criação, alteração e exclusão. Um servidor só faz os dois papéis: os testes põem
// fake.host em INTEGRATIONS_ALLOWED_HOSTS e GOOGLE_*_URL / MS_*_URL em fake.url. Tokens e ids são falsos.

export interface FakeCalEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  start: string; // ISO, ou AAAA-MM-DD no dia inteiro
  end: string;
  allDay: boolean;
  status?: 'cancelled';
  wesccEventId?: string; // Google: extendedProperties.private
}

export interface FakeCalAccount {
  email: string;
  name: string;
  events: FakeCalEvent[];
  access: string;
  refresh: string;
  expiresIn: number;
  refreshDenied?: boolean;
}

export interface FakeCalendars {
  server: FakeServer;
  url: string;
  host: string;
  google: FakeCalAccount;
  microsoft: FakeCalAccount;
  codes: Map<string, { provider: 'google' | 'microsoft'; challenge: string }>;
  authorize(provider: 'google' | 'microsoft', challenge: string): string; // devolve um código válido
  close(): Promise<void>;
}

const tok = (p: string) => `tok-teste-${p}-${crypto.randomBytes(6).toString('hex')}`;
const b64url = (s: string) => Buffer.from(s).toString('base64url');

function account(email: string, name: string): FakeCalAccount {
  return { email, name, events: [], access: '', refresh: tok('refresh'), expiresIn: 3600 };
}

export async function startFakeCalendars(): Promise<FakeCalendars> {
  const server = await startFake();
  const codes = new Map<string, { provider: 'google' | 'microsoft'; challenge: string }>();
  const g = account('ana.google@explorer-teste.com.br', 'Ana no Google');
  const m = account('ana.outlook@explorer-teste.com.br', 'Ana no Outlook');
  const accounts = { google: g, microsoft: m };

  const bearer = (req: FakeRequest, a: FakeCalAccount) => req.headers.authorization === `Bearer ${a.access}` && !!a.access;

  const token = (provider: 'google' | 'microsoft') => (req: FakeRequest) => {
    const f = Object.fromEntries(new URLSearchParams(req.body));
    const a = accounts[provider];
    if (f.grant_type === 'authorization_code') {
      const c = codes.get(f.code);
      codes.delete(f.code);
      const challenge = crypto.createHash('sha256').update(String(f.code_verifier ?? '')).digest('base64url');
      if (!c || c.provider !== provider || c.challenge !== challenge) return { status: 400, body: { error: 'invalid_grant' } };
    } else if (f.grant_type === 'refresh_token') {
      if (a.refreshDenied || f.refresh_token !== a.refresh) return { status: 400, body: { error: 'invalid_grant' } };
    } else return { status: 400, body: { error: 'unsupported_grant_type' } };
    a.access = tok('access');
    const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: a.email, name: a.name, sub: '123' }))}.`;
    return { body: { access_token: a.access, refresh_token: a.refresh, expires_in: a.expiresIn, ...(provider === 'google' ? { id_token: idToken } : {}) } };
  };

  const inWindow = (e: FakeCalEvent, from: string, to: string) => {
    const s = e.allDay ? `${e.start}T00:00:00Z` : e.start;
    const en = e.allDay ? `${e.end}T00:00:00Z` : e.end;
    return new Date(s) < new Date(to) && new Date(en) > new Date(from);
  };

  // ---- Google ----
  server.on('POST', '/token', token('google'));
  server.on('POST', '/revoke', () => ({ body: {} }));
  server.on('GET', '/calendar/v3/calendars/primary/events', (req) => {
    if (!bearer(req, g)) return { status: 401, body: { error: { code: 401 } } };
    const items = g.events
      .filter((e) => e.status !== 'cancelled' && inWindow(e, req.query.timeMin, req.query.timeMax))
      .map((e) => ({
        id: e.id,
        summary: e.title,
        description: e.description,
        location: e.location,
        htmlLink: `https://calendar.google.com/event?eid=${e.id}`,
        start: e.allDay ? { date: e.start } : { dateTime: e.start },
        end: e.allDay ? { date: e.end } : { dateTime: e.end },
        ...(e.wesccEventId ? { extendedProperties: { private: { wesccEventId: e.wesccEventId } } } : {}),
      }));
    return { body: { items } };
  });
  const fromGoogleBody = (id: string, j: any): FakeCalEvent => ({
    id,
    title: j.summary,
    description: j.description ?? '',
    location: j.location ?? '',
    allDay: !!j.start?.date,
    start: j.start?.date ?? j.start?.dateTime,
    end: j.end?.date ?? j.end?.dateTime,
    wesccEventId: j.extendedProperties?.private?.wesccEventId,
  });
  server.on('POST', '/calendar/v3/calendars/primary/events', (req) => {
    if (!bearer(req, g)) return { status: 401, body: {} };
    const ev = fromGoogleBody(`g${crypto.randomBytes(5).toString('hex')}`, req.json);
    g.events.push(ev);
    return { body: { id: ev.id } };
  });
  server.on('*', /^\/calendar\/v3\/calendars\/primary\/events\/[^/]+$/, (req) => {
    if (!bearer(req, g)) return { status: 401, body: {} };
    const id = decodeURIComponent(req.path.split('/').pop()!);
    const i = g.events.findIndex((e) => e.id === id);
    if (i < 0) return { status: 404, body: { error: { code: 404 } } };
    if (req.method === 'DELETE') {
      g.events.splice(i, 1);
      return { status: 204, body: '' };
    }
    g.events[i] = fromGoogleBody(id, req.json);
    return { body: { id } };
  });

  // ---- Microsoft ----
  server.on('POST', /^\/[^/]+\/oauth2\/v2\.0\/token$/, token('microsoft'));
  server.on('GET', '/v1.0/me', (req) => (bearer(req, m) ? { body: { displayName: m.name, mail: m.email, userPrincipalName: m.email } } : { status: 401, body: {} }));
  server.on('GET', '/v1.0/me/calendarView', (req) => {
    if (!bearer(req, m)) return { status: 401, body: {} };
    const value = m.events
      .filter((e) => inWindow(e, req.query.startDateTime, req.query.endDateTime))
      .map((e) => ({
        id: e.id,
        subject: e.title,
        bodyPreview: e.description,
        isAllDay: e.allDay,
        isCancelled: e.status === 'cancelled',
        location: { displayName: e.location },
        webLink: `https://outlook.office365.com/owa/?itemid=${e.id}`,
        start: { dateTime: e.allDay ? `${e.start}T00:00:00.0000000` : e.start.replace(/Z$/, '0000'), timeZone: 'UTC' },
        end: { dateTime: e.allDay ? `${e.end}T00:00:00.0000000` : e.end.replace(/Z$/, '0000'), timeZone: 'UTC' },
      }));
    return { body: { value } };
  });
  const fromMsBody = (id: string, j: any): FakeCalEvent => ({
    id,
    title: j.subject,
    description: j.body?.content ?? '',
    location: j.location?.displayName ?? '',
    allDay: !!j.isAllDay,
    start: j.isAllDay ? String(j.start.dateTime).slice(0, 10) : `${j.start.dateTime}Z`,
    end: j.isAllDay ? String(j.end.dateTime).slice(0, 10) : `${j.end.dateTime}Z`,
  });
  server.on('POST', '/v1.0/me/events', (req) => {
    if (!bearer(req, m)) return { status: 401, body: {} };
    const ev = fromMsBody(`AAMk${crypto.randomBytes(5).toString('hex')}`, req.json);
    m.events.push(ev);
    return { status: 201, body: { id: ev.id } };
  });
  server.on('*', /^\/v1\.0\/me\/events\/[^/]+$/, (req) => {
    if (!bearer(req, m)) return { status: 401, body: {} };
    const id = decodeURIComponent(req.path.split('/').pop()!);
    const i = m.events.findIndex((e) => e.id === id);
    if (i < 0) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };
    if (req.method === 'DELETE') {
      m.events.splice(i, 1);
      return { status: 204, body: '' };
    }
    m.events[i] = { ...m.events[i], ...fromMsBody(id, req.json) };
    return { body: { id } };
  });

  return {
    server,
    url: server.url,
    host: server.host,
    google: g,
    microsoft: m,
    codes,
    authorize(provider, challenge) {
      const code = `cod-${crypto.randomBytes(6).toString('hex')}`;
      codes.set(code, { provider, challenge });
      return code;
    },
    close: () => server.close(),
  };
}
