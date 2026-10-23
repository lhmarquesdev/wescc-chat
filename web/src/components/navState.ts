// Dados da navegação (barra lateral, abas do celular e Início): chamadas perdidas ainda não vistas,
// o total de menções e a faixa "Para você".
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Call, Message, Subscription } from '@shared/index';
import { api } from '../lib/api';
import { formatTime, roomPath } from '../lib/format';
import { realtime } from '../lib/realtime';
import { useSetting, useStore } from '../lib/store';

// ---------- Chamadas perdidas ----------

const SEEN_KEY = 'wescc.calls.seen';
const listeners = new Set<() => void>();
let missed: Call[] = [];
let seen = readSeen();
let loadedFor = '';
let version = 0;
let offRealtime: (() => void) | null = null;

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function emit() {
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// Abrir a página de chamadas zera o contador (o "visto" fica só neste navegador).
export function markCallsSeen() {
  seen = new Date().toISOString();
  try {
    localStorage.setItem(SEEN_KEY, seen);
  } catch {
    // sem armazenamento: o contador só zera nesta sessão
  }
  emit();
}

function ensureMissed(meId: string) {
  if (loadedFor === meId) return;
  loadedFor = meId;
  missed = [];
  api
    .get('calls.list', { offset: 0, count: 30 })
    .then((r: { calls: Call[] }) => {
      missed = r.calls.filter((c) => c.status === 'missed' && c.callee._id === meId);
      emit();
    })
    .catch(() => {});
  offRealtime?.();
  offRealtime = realtime.on((ev) => {
    if (ev.type !== 'call' || ev.call.callee._id !== meId) return;
    const rest = missed.filter((c) => c._id !== ev.call._id);
    missed = ev.call.status === 'missed' ? [ev.call, ...rest] : rest;
    emit();
  });
}

export function useMissedCalls() {
  const meId = useStore((s) => s.me?._id ?? '');
  const enabled = useSetting<boolean>('Calls_Enabled');
  useEffect(() => {
    if (enabled && meId) ensureMissed(meId);
  }, [enabled, meId]);
  const v = useSyncExternalStore(subscribe, () => version);
  return useMemo(() => {
    const recent = enabled ? missed.filter((c) => !seen || c.createdAt > seen) : [];
    return { count: recent.length, recent };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, v]);
}

// ---------- Menções ----------

// O selo vermelho: DMs e salas que mencionam você, pela contagem de não lidas (o mesmo da barra lateral).
export const isMentionBadge = (s: Subscription) => s.userMentions > 0 || s.t === 'd';

export function useMentionTotal() {
  return useStore((st) => Object.values(st.subscriptions).reduce((n, s) => n + (isMentionBadge(s) ? s.unread : 0), 0));
}

// ---------- Para você ----------

export interface ForYouItem {
  key: string;
  kind: 'mention' | 'missed';
  title: string;
  sub: string;
  ts: string;
  to: string;
  username?: string;
}

const byUpdated = (a: Subscription, b: Subscription) => (b._updatedAt ?? '').localeCompare(a._updatedAt ?? '');

const dm = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const dmy = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
// Só a hora para hoje, "ontem, 18:35" para ontem e a data para antes: uma menção antiga não parece de hoje.
function when(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ontem, ${formatTime(iso)}`;
  return (d.getFullYear() === now.getFullYear() ? dm : dmy).format(d);
}
// "#" só para canal público (não para grupo privado nem discussão), como no cabeçalho da sala.
const roomLabel = (s: Subscription) => `${s.t === 'c' && !s.prid ? '#' : ''}${s.fname || s.name}`;

// Menções recentes (salas, não DMs) e chamadas perdidas, as mais novas primeiro.
export function useForYou(max = 3): ForYouItem[] {
  const subs = useStore((s) => s.subscriptions);
  const rooms = useMemo(
    () =>
      Object.values(subs)
        .filter((s) => s.userMentions > 0 && s.t !== 'd')
        .sort(byUpdated)
        .slice(0, max),
    [subs, max],
  );
  const key = rooms.map((s) => `${s.rid}:${s.userMentions}`).join(',');
  const [last, setLast] = useState<Record<string, Message | null>>({});
  useEffect(() => {
    let alive = true;
    for (const s of rooms) {
      api
        .get('chat.getMentionedMessages', { roomId: s.rid, count: 1 })
        .then((r: { messages: Message[] }) => alive && setLast((x) => ({ ...x, [s.rid]: r.messages[0] ?? null })))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const { recent } = useMissedCalls();
  return useMemo(() => {
    const mentions: ForYouItem[] = rooms.map((s) => {
      const m = last[s.rid];
      const who = m ? m.u.name || m.u.username : '';
      return {
        key: `m-${s.rid}`,
        kind: 'mention',
        // A ação na primeira linha (o cartão estreito cortava o verbo de "Fulano mencionou você"); quem, onde e
        // quando na segunda.
        title: s.userMentions > 1 ? `${s.userMentions} menções a você` : who ? 'Mencionou você' : 'Menção a você',
        sub: [who, roomLabel(s), m ? when(m.ts) : ''].filter(Boolean).join(' · '),
        ts: m?.ts ?? s._updatedAt ?? '',
        to: m ? `${roomPath(s)}?msg=${m._id}` : roomPath(s),
      };
    });
    const calls: ForYouItem[] = recent.map((c) => ({
      key: `c-${c._id}`,
      kind: 'missed',
      title: c.kind === 'video' ? 'Chamada de vídeo perdida' : 'Chamada perdida',
      sub: `${c.caller.name || c.caller.username} · ${when(c.createdAt)}`,
      ts: c.createdAt,
      to: roomPath({ _id: c.rid, t: 'd' }),
      username: c.caller.username,
    }));
    return [...mentions, ...calls].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, max);
  }, [rooms, last, recent, max]);
}
