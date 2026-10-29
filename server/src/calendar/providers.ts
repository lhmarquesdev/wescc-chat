// Google Agenda e Outlook (Microsoft Graph): a mesma interface para ler a janela de eventos e gravar as cópias do chat.
import { endpoints } from '../integrations/endpoints';
import { calFetch, CalHttpError } from './http';

export interface ExternalEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  url: string | null;
  joinUrl: string | null;
  ours: boolean; // cópia gravada pelo chat (não volta como evento trazido)
}

export interface OutgoingEvent {
  eventId: string;
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
}

export interface CalendarApi {
  label: string;
  list(token: string, from: Date, to: Date): Promise<ExternalEvent[]>;
  create(token: string, ev: OutgoingEvent): Promise<string>;
  update(token: string, externalId: string, ev: OutgoingEvent): Promise<void>;
  remove(token: string, externalId: string): Promise<void>;
}

const MAX_PAGES = 20;
const day = (d: Date) => d.toISOString().slice(0, 10);
const cut = (s: unknown, n: number) => [...String(s ?? '')].slice(0, n).join('').trim();
const httpsOnly = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) && u.length <= 2000 ? u : null);

// ---------- Google ----------

const gBase = () => `${endpoints.googleApi()}/calendar/v3/calendars/primary/events`;
const gId = (id: string) => encodeURIComponent(id);

function fromGoogle(e: any): ExternalEvent | null {
  if (!e?.id || e.status === 'cancelled') return null;
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const startsAt = new Date(allDay ? `${e.start.date}T00:00:00.000Z` : e.start?.dateTime);
  const endsAt = new Date(allDay ? `${e.end?.date ?? e.start.date}T00:00:00.000Z` : (e.end?.dateTime ?? e.start?.dateTime));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  const video = Array.isArray(e.conferenceData?.entryPoints) ? e.conferenceData.entryPoints.find((p: any) => p?.entryPointType === 'video')?.uri : null;
  return {
    id: String(e.id),
    title: cut(e.summary, 200) || '(sem título)',
    description: cut(e.description, 5000),
    location: cut(e.location, 300),
    startsAt,
    endsAt: endsAt < startsAt ? startsAt : endsAt,
    allDay,
    url: httpsOnly(e.htmlLink),
    joinUrl: httpsOnly(e.hangoutLink) ?? httpsOnly(video),
    ours: !!e.extendedProperties?.private?.wesccEventId,
  };
}

function toGoogle(ev: OutgoingEvent) {
  const when = ev.allDay
    ? { start: { date: day(ev.startsAt) }, end: { date: day(ev.endsAt) } }
    : { start: { dateTime: ev.startsAt.toISOString() }, end: { dateTime: ev.endsAt.toISOString() } };
  return { summary: ev.title, description: ev.description, location: ev.location, ...when, extendedProperties: { private: { wesccEventId: ev.eventId } } };
}

export const google: CalendarApi = {
  label: 'Google Agenda',
  async list(token, from, to) {
    const out: ExternalEvent[] = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const p = new URLSearchParams({ singleEvents: 'true', timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: '250', orderBy: 'startTime' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await calFetch<any>('Google Agenda', `${gBase()}?${p}`, { token });
      for (const e of r?.items ?? []) {
        const x = fromGoogle(e);
        if (x) out.push(x);
      }
      pageToken = typeof r?.nextPageToken === 'string' ? r.nextPageToken : '';
      if (!pageToken) return out;
    }
    throw new CalHttpError('retry', 'Eventos demais na janela do Google Agenda.');
  },
  async create(token, ev) {
    const r = await calFetch<any>('Google Agenda', gBase(), { token, method: 'POST', body: toGoogle(ev) });
    if (!r?.id) throw new CalHttpError('fail', 'O Google Agenda não devolveu o evento criado.');
    return String(r.id);
  },
  async update(token, externalId, ev) {
    await calFetch('Google Agenda', `${gBase()}/${gId(externalId)}`, { token, method: 'PUT', body: toGoogle(ev) });
  },
  async remove(token, externalId) {
    try {
      await calFetch('Google Agenda', `${gBase()}/${gId(externalId)}`, { token, method: 'DELETE' });
    } catch (e) {
      // Já apagado lá (404 ou 410): nada a fazer.
      if (e instanceof CalHttpError && (e.kind === 'notFound' || e.kind === 'gone')) return;
      throw e;
    }
  },
};

// ---------- Microsoft (Outlook / Teams) ----------

const msBase = () => `${endpoints.msGraph().replace(/\/+$/, '')}/v1.0/me`;
const UTC_PREFER = { prefer: 'outlook.timezone="UTC"' };

function msDate(v: unknown): Date {
  const s = String(v ?? '');
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
}

function fromMicrosoft(e: any): ExternalEvent | null {
  if (!e?.id || e.isCancelled || e['@removed']) return null;
  const allDay = !!e.isAllDay;
  let startsAt = msDate(e.start?.dateTime);
  let endsAt = msDate(e.end?.dateTime);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return null;
  if (allDay) {
    startsAt = new Date(`${String(e.start?.dateTime).slice(0, 10)}T00:00:00.000Z`);
    endsAt = new Date(`${String(e.end?.dateTime).slice(0, 10)}T00:00:00.000Z`);
  }
  return {
    id: String(e.id),
    title: cut(e.subject, 200) || '(sem título)',
    description: cut(e.bodyPreview, 5000),
    location: cut(e.location?.displayName, 300),
    startsAt,
    endsAt: endsAt < startsAt ? startsAt : endsAt,
    allDay,
    url: httpsOnly(e.webLink),
    joinUrl: httpsOnly(e.onlineMeeting?.joinUrl),
    ours: false, // a cópia do chat é reconhecida pela tabela calendar_exports
  };
}

function toMicrosoft(ev: OutgoingEvent) {
  const at = (d: Date) => ({ dateTime: ev.allDay ? `${day(d)}T00:00:00` : d.toISOString().replace(/Z$/, ''), timeZone: 'UTC' });
  return {
    subject: ev.title,
    body: { contentType: 'text', content: ev.description },
    location: { displayName: ev.location },
    start: at(ev.startsAt),
    end: at(ev.endsAt),
    isAllDay: ev.allDay,
    isReminderOn: false, // o lembrete é do chat; o Outlook não avisa de novo
  };
}

export const microsoft: CalendarApi = {
  label: 'Outlook',
  async list(token, from, to) {
    const out: ExternalEvent[] = [];
    const p = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $top: '200',
      $select: 'id,subject,bodyPreview,start,end,isAllDay,isCancelled,location,webLink,onlineMeeting',
    });
    let url = `${msBase()}/calendarView?${p}`;
    const origin = new URL(endpoints.msGraph()).origin;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await calFetch<any>('Outlook', url, { token, headers: { prefer: 'outlook.timezone="UTC", odata.maxpagesize=200' } });
      for (const e of r?.value ?? []) {
        const x = fromMicrosoft(e);
        if (x) out.push(x);
      }
      const next = typeof r?.['@odata.nextLink'] === 'string' ? r['@odata.nextLink'] : '';
      if (!next) return out;
      // O próximo link só vale na mesma origem do Graph.
      if (new URL(next).origin !== origin) throw new CalHttpError('fail', 'O Microsoft Graph devolveu um link de outro endereço.');
      url = next;
    }
    throw new CalHttpError('retry', 'Eventos demais na janela do Outlook.');
  },
  async create(token, ev) {
    const r = await calFetch<any>('Outlook', `${msBase()}/events`, { token, method: 'POST', body: toMicrosoft(ev), headers: UTC_PREFER });
    if (!r?.id) throw new CalHttpError('fail', 'O Outlook não devolveu o evento criado.');
    return String(r.id);
  },
  async update(token, externalId, ev) {
    await calFetch('Outlook', `${msBase()}/events/${encodeURIComponent(externalId)}`, { token, method: 'PATCH', body: toMicrosoft(ev), headers: UTC_PREFER });
  },
  async remove(token, externalId) {
    try {
      await calFetch('Outlook', `${msBase()}/events/${encodeURIComponent(externalId)}`, { token, method: 'DELETE' });
    } catch (e) {
      if (e instanceof CalHttpError && (e.kind === 'notFound' || e.kind === 'gone')) return;
      throw e;
    }
  },
};

export const apis = { google, microsoft } as const;
