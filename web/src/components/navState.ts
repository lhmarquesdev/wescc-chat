// Dados da navegação (barra lateral, abas do celular e Início): chamadas perdidas ainda não vistas,
// o total de menções e a faixa "Para você".
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Call, Message, Subscription } from '@shared/index';
import { api } from '../lib/api';
import { formatTime, roomPath } from '../lib/format';
import { markCallsSeen as markSeenOnServer, useMissedCalls as useMissedCount } from '../lib/roomcall';
import { useSetting, useStore } from '../lib/store';

// ---------- Chamadas perdidas ----------

// Uma fonte só: o servidor conta as perdidas ainda não vistas (calls.missedCount, o selo de Chamadas) e guarda o
// "visto" (calls.seen), em todos os aparelhos. Aqui ficam só as mais novas, para os cartões de "Para você".
const listeners = new Set<() => void>();
let missed: Call[] = [];
let loadedKey = '';
let version = 0;

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

// Abrir a página de chamadas zera o contador (no servidor: vale para todos os aparelhos).
export function markCallsSeen() {
  void markSeenOnServer();
}

function loadMissed(key: string) {
  if (loadedKey === key) return;
  loadedKey = key;
  api
    .get('calls.list', { offset: 0, count: 30, filter: 'missed' })
    .then((r: { calls: Call[] }) => {
      if (loadedKey !== key) return;
      missed = r.calls;
      emit();
    })
    .catch(() => {
      if (loadedKey === key) loadedKey = '';
    });
}

export function useMissedCalls() {
  const meId = useStore((s) => s.me?._id ?? '');
  const enabled = useSetting<boolean>('Calls_Enabled');
  const count = useMissedCount();
  // A lista acompanha a contagem: uma perdida nova (a dois ou em grupo) muda o número e busca as mais novas.
  useEffect(() => {
    if (!count) loadedKey = '';
    else if (enabled && meId) loadMissed(`${meId}:${count}`);
  }, [enabled, meId, count]);
  const v = useSyncExternalStore(subscribe, () => version);
  return useMemo(() => {
    const n = enabled ? count : 0;
    return { count: n, recent: n ? missed.slice(0, n) : [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, count, v]);
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
    const calls: ForYouItem[] = recent.map((c) => {
      // Em grupo, a sala diz onde foi (uma DM com várias pessoas não tem nome: fica só quem chamou).
      const where = c.scope === 'group' && c.room && c.room.t !== 'd' ? `${c.room.t === 'c' && !c.room.prid ? '#' : ''}${c.room.fname || c.room.name || ''}` : '';
      return {
        key: `c-${c._id}`,
        kind: 'missed',
        title: c.kind === 'video' ? 'Chamada de vídeo perdida' : 'Chamada perdida',
        sub: [c.caller.name || c.caller.username, where, when(c.createdAt)].filter(Boolean).join(' · '),
        ts: c.createdAt,
        to: roomPath(c.room ?? { _id: c.rid, t: 'd' }),
        username: c.caller.username,
      };
    });
    return [...mentions, ...calls].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, max);
  }, [rooms, last, recent, max]);
}
