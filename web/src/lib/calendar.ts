// Agenda no navegador: datas (semana começando na segunda, no fuso da pessoa), chamadas à API e a lista de eventos de
// um período, que se atualiza sozinha quando a agenda muda no servidor.
import { useEffect, useState } from 'react';
import type { CalendarEvent, CalendarEventInput, CalendarProviderInfo, MeetingInfo, SyncDirection } from '@shared/calendar';
import { api } from './api';
import { realtime } from './realtime';

export const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

// Segunda-feira da semana de d.
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// 6 semanas a partir da segunda antes do dia 1: a grade do mês sempre tem a mesma altura.
export function monthGrid(month: Date): Date[] {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

// Dia inteiro vem em UTC (00:00 do primeiro dia até 00:00 do dia seguinte ao último): vira datas locais.
export function eventDays(e: Pick<CalendarEvent, 'allDay' | 'startsAt' | 'endsAt'>): { start: Date; end: Date } {
  if (!e.allDay) return { start: new Date(e.startsAt), end: new Date(e.endsAt) };
  const s = new Date(e.startsAt);
  const en = new Date(e.endsAt);
  return { start: new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()), end: new Date(en.getUTCFullYear(), en.getUTCMonth(), en.getUTCDate()) };
}

// O evento aparece no dia d (local)?
export function onDay(e: CalendarEvent, d: Date): boolean {
  const { start, end } = eventDays(e);
  const day0 = startOfDay(d);
  const day1 = addDays(day0, 1);
  return start < day1 && (end > day0 || (end.getTime() === start.getTime() && sameDay(start, d)));
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function fromInputs(date: string, time: string): Date {
  const [y, m, dd] = date.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  return new Date(y, (m || 1) - 1, dd || 1, h || 0, mi || 0);
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
export const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
export const weekdayShort = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });

export const fmtTime = (d: Date | string) => timeFmt.format(new Date(d));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtDay = (d: Date) => cap(dayFmt.format(d));

// "Hoje, 14:00–15:00", "Amanhã, dia inteiro", "Qui., 30 de out., 09:00–10:30".
export function whenLabel(e: Pick<CalendarEvent, 'allDay' | 'startsAt' | 'endsAt'>): string {
  const { start, end } = eventDays(e);
  const today = startOfDay(new Date());
  const dayName = (d: Date) => (sameDay(d, today) ? 'Hoje' : sameDay(d, addDays(today, 1)) ? 'Amanhã' : sameDay(d, addDays(today, -1)) ? 'Ontem' : cap(shortDayFmt.format(d)));
  if (e.allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last) || last < start ? `${dayName(start)}, dia inteiro` : `${dayName(start)} a ${dayName(last)}, dia inteiro`;
  }
  if (sameDay(start, end) || (end.getTime() - start.getTime() < DAY_MS && end.getHours() === 0 && end.getMinutes() === 0))
    return `${dayName(start)}, ${fmtTime(start)}–${fmtTime(end)}`;
  return `${dayName(start)}, ${fmtTime(start)} – ${dayName(end)}, ${fmtTime(end)}`;
}

export function reminderLabel(m: number | null): string {
  if (m === null) return 'Sem lembrete';
  if (m === 0) return 'Na hora';
  if (m < 60) return `${m} minutos antes`;
  if (m === 60) return '1 hora antes';
  if (m % 1440 === 0) return m === 1440 ? '1 dia antes' : `${m / 1440} dias antes`;
  return `${Math.round(m / 60)} horas antes`;
}

// ---------- API ----------

export const calendarApi = {
  list: (from: Date, to: Date) => api.get<{ events: CalendarEvent[] }>('calendar.events', { from: from.toISOString(), to: to.toISOString() }).then((r) => r.events),
  get: (eventId: string) => api.get<{ event: CalendarEvent }>('calendar.event', { eventId }).then((r) => r.event),
  create: (input: CalendarEventInput) => api.post<{ event: CalendarEvent }>('calendar.create', input as any).then((r) => r.event),
  update: (eventId: string, input: Partial<CalendarEventInput>) => api.post<{ event: CalendarEvent }>('calendar.update', { eventId, ...input }).then((r) => r.event),
  cancel: (eventId: string) => api.post('calendar.cancel', { eventId }),
  respond: (eventId: string, response: 'accepted' | 'declined' | 'tentative') => api.post<{ event: CalendarEvent }>('calendar.respond', { eventId, response }).then((r) => r.event),
  busy: (userIds: string[], from: Date, to: Date) =>
    api.get<{ busy: Record<string, { startsAt: string; endsAt: string }[]> }>('calendar.busy', { userIds, from: from.toISOString(), to: to.toISOString() }).then((r) => r.busy),
  meeting: (code: string) => api.get<MeetingInfo>('calendar.meeting', { code }),
  join: (code: string) => api.post<{ rid: string; event: CalendarEvent }>('calendar.meeting.join', { code }),
  byRoom: (roomId: string) => api.get<{ event: CalendarEvent | null }>('calendar.meeting.byRoom', { roomId }).then((r) => r.event),
  accounts: () => api.get<{ providers: CalendarProviderInfo[] }>('calendar.accounts').then((r) => r.providers),
  connect: (provider: string, direction: SyncDirection) =>
    api.post<{ url: string }>('calendar.accounts.connect', { provider, direction, returnTo: `${location.pathname}${location.search}` }),
  direction: (provider: string, direction: SyncDirection) => api.post('calendar.accounts.direction', { provider, direction }),
  disconnect: (provider: string) => api.post('calendar.accounts.disconnect', { provider }),
  syncNow: (provider: string) => api.post<{ result: { error?: string }; providers: CalendarProviderInfo[] }>('calendar.accounts.sync', { provider }),
};

// Eventos de [from, to). Volta a buscar quando a agenda muda (evento, convite, resposta, sincronização), com 300 ms de
// folga para juntar vários avisos seguidos. A lista anterior fica na tela enquanto a nova chega.
export function useCalendarEvents(from: Date, to: Date) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${from.getTime()}-${to.getTime()}`;
  useEffect(() => {
    let alive = true;
    calendarApi
      .list(from, to)
      .then((list) => alive && (setEvents(list), setError(null)))
      .catch((e) => alive && setError(e?.message ?? 'Não foi possível carregar a agenda.'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  useEffect(() => {
    let t = 0;
    const off = realtime.on((ev) => {
      if (ev.type === 'calendar.changed' || ev.type === 'calendar.invite') {
        clearTimeout(t);
        t = window.setTimeout(() => setTick((n) => n + 1), 300);
      }
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, []);
  return { events, error, reload: () => setTick((n) => n + 1) };
}

// Disposição dos eventos com horário de um dia em colunas (os que se sobrepõem ficam lado a lado).
export interface Placed {
  e: CalendarEvent;
  top: number; // minutos desde 00:00
  height: number; // minutos
  col: number;
  cols: number;
}

export function layoutDay(events: CalendarEvent[], day: Date): Placed[] {
  const d0 = startOfDay(day).getTime();
  const d1 = addDays(startOfDay(day), 1).getTime();
  const items = events
    .filter((e) => !e.allDay)
    .map((e) => {
      const s = Math.max(new Date(e.startsAt).getTime(), d0);
      const en = Math.min(new Date(e.endsAt).getTime(), d1);
      return { e, s, en: Math.max(en, s + 15 * 60_000) };
    })
    .filter((x) => x.s < d1 && x.en > d0)
    .sort((a, b) => a.s - b.s || b.en - a.en);
  const out: Placed[] = [];
  let group: { item: (typeof items)[number]; col: number }[] = [];
  let groupEnd = 0;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) out.push({ e: g.item.e, top: (g.item.s - d0) / 60_000, height: (g.item.en - g.item.s) / 60_000, col: g.col, cols });
    group = [];
  };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    const used = new Set(group.filter((g) => g.item.en > it.s).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ item: it, col });
    groupEnd = Math.max(groupEnd, it.en);
  }
  if (group.length) flush();
  return out;
}
