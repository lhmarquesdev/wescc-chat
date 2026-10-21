import { create } from 'zustand';
import type { Message, Room, ServerEvent, Subscription, User, UserStatus } from '@shared/index';

export type Me = User & { permissions: string[]; requirePasswordChange?: boolean };

interface RoomMessages {
  list: Message[];
  hasMore: boolean;
  loaded: boolean;
}

interface State {
  me: Me | null;
  settings: Record<string, any>;
  subscriptions: Record<string, Subscription>;
  rooms: Record<string, Room>;
  messages: Record<string, RoomMessages>;
  threads: Record<string, Message[]>;
  presence: Record<string, { status: UserStatus; statusText?: string }>;
  typing: Record<string, Record<string, number>>;
  connected: boolean;
  emojiVersion: number;
  toasts: { id: number; text: string; kind: 'info' | 'error' }[];
  permMap: Record<string, string[]>;

  setMe(me: Me | null): void;
  setSettings(s: Record<string, any>): void;
  setSubscriptions(subs: Subscription[]): void;
  upsertSubscription(s: Subscription): void;
  removeSubscription(rid: string): void;
  upsertRoom(r: Room): void;
  setMessages(rid: string, list: Message[], hasMore: boolean): void;
  prependMessages(rid: string, list: Message[], hasMore: boolean): void;
  upsertMessage(m: Message): void;
  removeMessage(rid: string, id: string, tmid?: string | null): void;
  setThread(tmid: string, list: Message[]): void;
  markReads(rid: string, ids: string[]): void;
  setPresence(username: string, status: UserStatus, statusText?: string): void;
  setTyping(rid: string, username: string, typing: boolean): void;
  setConnected(c: boolean): void;
  toast(text: string, kind?: 'info' | 'error'): void;
  reset(): void;
}

let toastSeq = 0;

function insertSorted(list: Message[], m: Message) {
  const i = list.findIndex((x) => x._id === m._id);
  if (i >= 0) {
    const copy = list.slice();
    copy[i] = m;
    return copy;
  }
  const copy = list.slice();
  let pos = copy.length;
  while (pos > 0 && copy[pos - 1].ts > m.ts) pos--;
  copy.splice(pos, 0, m);
  return copy;
}

const initial = {
  me: null,
  subscriptions: {},
  rooms: {},
  messages: {},
  threads: {},
  presence: {},
  typing: {},
  connected: false,
  emojiVersion: 0,
  toasts: [],
  permMap: {},
};

export const useStore = create<State>((set, get) => ({
  ...initial,
  settings: {},

  setMe: (me) => set({ me }),
  setSettings: (s) => set({ settings: { ...get().settings, ...s } }),
  setSubscriptions: (subs) => set({ subscriptions: Object.fromEntries(subs.map((s) => [s.rid, s])) }),
  upsertSubscription: (s) => set({ subscriptions: { ...get().subscriptions, [s.rid]: s } }),
  removeSubscription: (rid) => {
    const subs = { ...get().subscriptions };
    delete subs[rid];
    set({ subscriptions: subs });
  },
  upsertRoom: (r) => set({ rooms: { ...get().rooms, [r._id]: r } }),
  setMessages: (rid, list, hasMore) => set({ messages: { ...get().messages, [rid]: { list, hasMore, loaded: true } } }),
  prependMessages: (rid, list, hasMore) => {
    const cur = get().messages[rid];
    const ids = new Set(cur?.list.map((m) => m._id));
    const merged = [...list.filter((m) => !ids.has(m._id)), ...(cur?.list ?? [])];
    set({ messages: { ...get().messages, [rid]: { list: merged, hasMore, loaded: true } } });
  },
  upsertMessage: (m) => {
    const st = get();
    const out: Partial<State> = {};
    const isReply = !!m.tmid && !(m as any).tshow;
    const cur = st.messages[m.rid];
    if (cur && (!isReply || cur.list.some((x) => x._id === m._id))) {
      out.messages = { ...st.messages, [m.rid]: { ...cur, list: insertSorted(cur.list, m) } };
    }
    if (m.tmid && st.threads[m.tmid]) {
      out.threads = { ...st.threads, [m.tmid]: insertSorted(st.threads[m.tmid], m) };
    }
    if (Object.keys(out).length) set(out);
  },
  removeMessage: (rid, id, tmid) => {
    const st = get();
    const cur = st.messages[rid];
    const out: Partial<State> = {};
    if (cur) out.messages = { ...st.messages, [rid]: { ...cur, list: cur.list.filter((m) => m._id !== id) } };
    if (tmid && st.threads[tmid]) out.threads = { ...st.threads, [tmid]: st.threads[tmid].filter((m) => m._id !== id) };
    set(out);
  },
  setThread: (tmid, list) => set({ threads: { ...get().threads, [tmid]: list } }),
  markReads: (rid, ids) => {
    const cur = get().messages[rid];
    if (!cur) return;
    const s = new Set(ids);
    set({ messages: { ...get().messages, [rid]: { ...cur, list: cur.list.map((m) => (s.has(m._id) ? { ...m, unread: false } : m)) } } });
  },
  setPresence: (username, status, statusText) => set({ presence: { ...get().presence, [username]: { status, statusText } } }),
  setTyping: (rid, username, typing) => {
    const room = { ...(get().typing[rid] ?? {}) };
    if (typing) room[username] = Date.now();
    else delete room[username];
    set({ typing: { ...get().typing, [rid]: room } });
  },
  setConnected: (connected) => set({ connected }),
  toast: (text, kind = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 5000);
  },
  reset: () => set({ ...initial }),
}));

export function hasPermission(perm: string | string[]) {
  const me = useStore.getState().me;
  if (!me) return false;
  const list = Array.isArray(perm) ? perm : [perm];
  return list.some((p) => me.permissions.includes(p));
}

export function usePermission(perm: string | string[]) {
  const me = useStore((s) => s.me);
  if (!me) return false;
  const list = Array.isArray(perm) ? perm : [perm];
  return list.some((p) => me.permissions.includes(p));
}

// Avalia uma permissão com os papéis globais + papéis da sala.
export function canWithRoles(perm: string, roles: string[]) {
  const allowed = useStore.getState().permMap[perm];
  if (!allowed) return false;
  return roles.some((r) => allowed.includes(r));
}

export function useSetting<T = any>(id: string): T {
  return useStore((s) => s.settings[id]) as T;
}

// Aplica um evento do servidor ao estado.
export function applyEvent(ev: ServerEvent) {
  const st = useStore.getState();
  switch (ev.type) {
    case 'message':
      st.upsertMessage(ev.message);
      if (ev.action === 'inserted') st.setTyping(ev.message.rid, ev.message.u.username, false);
      break;
    case 'message.deleted':
      st.removeMessage(ev.rid, ev._id, ev.tmid);
      break;
    case 'messages.bulkDeleted': {
      const cur = st.messages[ev.rid];
      if (!cur) break;
      const ids = ev.ids ? new Set(ev.ids) : null;
      const list = cur.list.filter((m) => (ids ? !ids.has(m._id) : !(ev.before && m.ts < ev.before)));
      useStore.setState({ messages: { ...st.messages, [ev.rid]: { ...cur, list } } });
      break;
    }
    case 'subscription':
      if (ev.action === 'removed') st.removeSubscription(ev.subscription.rid);
      else st.upsertSubscription(ev.subscription);
      break;
    case 'room':
      if (ev.action !== 'removed') st.upsertRoom(ev.room);
      break;
    case 'presence':
      st.setPresence(ev.username, ev.status, ev.statusText);
      if (st.me && ev.userId === st.me._id) st.setMe({ ...st.me, status: ev.status, statusText: ev.statusText });
      break;
    case 'typing':
      if (ev.username !== st.me?.username) st.setTyping(ev.tmid ? `${ev.rid}:${ev.tmid}` : ev.rid, ev.username, ev.typing);
      break;
    case 'reads':
      st.markReads(ev.rid, ev.messageIds);
      break;
    case 'user':
      if (st.me && ev.user._id === st.me._id) st.setMe({ ...st.me, ...ev.user } as Me);
      if (ev.user.avatarETag !== undefined && ev.user.username) avatarBust[ev.user.username] = String(ev.user.avatarETag ?? Date.now());
      break;
    case 'settings.changed': {
      const patch: Record<string, unknown> = {};
      for (const s of ev.settings) {
        if (s._id === '__emoji') useStore.setState({ emojiVersion: st.emojiVersion + 1 });
        else patch[s._id] = s.value;
      }
      st.setSettings(patch);
      break;
    }
  }
}

export const avatarBust: Record<string, string> = {};
