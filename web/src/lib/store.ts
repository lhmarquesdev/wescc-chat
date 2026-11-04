import { create } from 'zustand';
import type { CustomUserStatus, Message, MessageReminder, Room, ScheduledMessage, ServerEvent, Subscription, User, UserStatus } from '@shared/index';
import { selfUserPatch } from '@shared/status';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
  duration: number;
  icon?: string; // nome de ícone no lugar do ícone do tipo (ex.: fim de chamada)
  key?: string; // um aviso por chave: o novo troca o anterior, e dismissToastKey tira (ex.: a falha de uma agendada)
}

export type Me = User & { permissions: string[]; requirePasswordChange?: boolean; require2faSetup?: boolean };

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
  presence: Record<string, Presence>;
  userStatuses: CustomUserStatus[]; // status personalizados (Administração › Status do usuário)
  typing: Record<string, Record<string, number>>;
  recording: Record<string, Record<string, 'recording' | 'video'>>; // quem do typing está gravando áudio ou vídeo
  connected: boolean;
  emojiVersion: number;
  toasts: ToastItem[];
  permMap: Record<string, string[]>;
  restrictedRoles: string[]; // papéis globais com "Restrito em conversas diretas"
  userRoles: Record<string, string[]>; // papéis globais anunciados por eventos "user" desde a conexão (id -> papéis)
  // Mensagens: os lembretes e as agendadas da pessoa (só ela vê) e os próprios votos em enquetes (id da mensagem -> opções)
  reminders: MessageReminder[];
  scheduled: ScheduledMessage[];
  pollVotes: Record<string, string[]>;

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
  setPresence(username: string, status: UserStatus, statusText?: string, statusCustom?: string | null): void;
  setTyping(rid: string, username: string, typing: boolean, recording?: 'recording' | 'video'): void;
  setConnected(c: boolean): void;
  setReminders(list: MessageReminder[]): void;
  upsertReminder(r: MessageReminder): void;
  removeReminder(id: string): void;
  setScheduled(list: ScheduledMessage[]): void;
  upsertScheduled(s: ScheduledMessage): void;
  removeScheduled(id: string): void;
  setPollVotes(votes: Record<string, string[]>): void;
  toast(text: string, kind?: ToastKind, opts?: { action?: ToastItem['action']; duration?: number; icon?: string; key?: string }): void;
  dismissToast(id: number): void;
  dismissToastKey(key: string): void;
  reset(): void;
}

export interface Presence {
  status: UserStatus;
  statusText?: string;
  statusCustom?: string | null; // id do status personalizado (null quando a pessoa aparece offline)
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
  userStatuses: [],
  typing: {},
  recording: {},
  connected: false,
  emojiVersion: 0,
  toasts: [],
  permMap: {},
  restrictedRoles: [],
  userRoles: {},
  reminders: [],
  scheduled: [],
  pollVotes: {},
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
  setPresence: (username, status, statusText, statusCustom = null) => set({ presence: { ...get().presence, [username]: { status, statusText, statusCustom } } }),
  setTyping: (rid, username, typing, recording) => {
    const room = { ...(get().typing[rid] ?? {}) };
    const rec = { ...(get().recording[rid] ?? {}) };
    if (typing) room[username] = Date.now();
    else delete room[username];
    if (typing && recording) rec[username] = recording;
    else delete rec[username];
    set({ typing: { ...get().typing, [rid]: room }, recording: { ...get().recording, [rid]: rec } });
  },
  // Sem conexão os eventos de "parou de digitar" não chegam: a faixa de digitação sairia presa.
  setConnected: (connected) => set(connected ? { connected } : { connected, typing: {}, recording: {} }),
  setReminders: (reminders) => set({ reminders }),
  upsertReminder: (r) => set({ reminders: [...get().reminders.filter((x) => x._id !== r._id && x.messageId !== r.messageId), r] }),
  removeReminder: (id) => set({ reminders: get().reminders.filter((x) => x._id !== id) }),
  setScheduled: (scheduled) => set({ scheduled }),
  // Enviada, cancelada ou de volta a pendente (editada): o aviso de falha dela não vale mais.
  upsertScheduled: (s) => {
    set({ scheduled: [...get().scheduled.filter((x) => x._id !== s._id), s].sort((a, b) => a.sendAt.localeCompare(b.sendAt)) });
    if (s.status !== 'failed') get().dismissToastKey(scheduledFailKey(s._id));
  },
  removeScheduled: (id) => {
    set({ scheduled: get().scheduled.filter((x) => x._id !== id) });
    get().dismissToastKey(scheduledFailKey(id));
  },
  setPollVotes: (votes) => set({ pollVotes: { ...get().pollVotes, ...votes } }),
  // O tempo corre no componente (pausa com o mouse em cima): erro 8 s, os outros 4 s.
  toast: (text, kind = 'info', opts) => {
    const id = ++toastSeq;
    const duration = opts?.duration ?? (kind === 'error' ? 8000 : 4000);
    // No máximo 3: um aviso antigo não reaparece depois que os novos saem.
    const rest = opts?.key ? get().toasts.filter((t) => t.key !== opts.key) : get().toasts;
    set({ toasts: [...rest, { id, text, kind, action: opts?.action, duration, icon: opts?.icon, key: opts?.key }].slice(-3) });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  dismissToastKey: (key) => {
    if (get().toasts.some((t) => t.key === key)) set({ toasts: get().toasts.filter((t) => t.key !== key) });
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
    case 'message': {
      st.upsertMessage(ev.message);
      if (ev.action !== 'inserted') break;
      st.setTyping(ev.message.rid, ev.message.u.username, false);
      // A sala sobe em "Recentes" já com a mensagem, sem esperar o evento da inscrição.
      const sub = st.subscriptions[ev.message.rid];
      if (sub && (sub.lm ?? '') < ev.message.ts) st.upsertSubscription({ ...sub, lm: ev.message.ts });
      break;
    }
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
      if (ev.action === 'removed') {
        st.removeSubscription(ev.subscription.rid);
        // Saiu da sala: as agendadas dela já saíram no servidor.
        if (st.scheduled.some((x) => x.rid === ev.subscription.rid)) st.setScheduled(st.scheduled.filter((x) => x.rid !== ev.subscription.rid));
      } else st.upsertSubscription(ev.subscription);
      break;
    case 'room':
      if (ev.action !== 'removed') st.upsertRoom(ev.room);
      break;
    case 'presence':
      st.setPresence(ev.username, ev.status, ev.statusText, ev.statusCustom ?? null);
      // O próprio status personalizado chega pelo evento "user" (aqui vem null quando a pessoa está invisível).
      if (st.me && ev.userId === st.me._id) st.setMe({ ...st.me, status: ev.status, statusText: ev.statusText, ...(ev.statusCustom ? { statusCustom: ev.statusCustom } : {}) });
      break;
    case 'userStatus.changed':
      useStore.setState({ userStatuses: ev.statuses });
      break;
    case 'typing':
      if (ev.username !== st.me?.username) st.setTyping(ev.tmid ? `${ev.rid}:${ev.tmid}` : ev.rid, ev.username, ev.typing, ev.activity);
      break;
    case 'reads':
      st.markReads(ev.rid, ev.messageIds);
      break;
    case 'user':
      // Só o evento da própria escolha muda o status personalizado (o do perfil chega como os outros o veem).
      if (st.me && ev.user._id === st.me._id) st.setMe({ ...st.me, ...selfUserPatch(ev.user) } as Me);
      if (ev.user.roles) useStore.setState({ userRoles: { ...st.userRoles, [ev.user._id]: ev.user.roles } });
      if (ev.user.avatarETag !== undefined && ev.user.username) avatarBust[ev.user.username] = String(ev.user.avatarETag ?? Date.now());
      break;
    case 'poll.myVotes':
      st.setPollVotes({ [ev.messageId]: ev.optionIds });
      break;
    case 'message.reminder':
      if (ev.action === 'removed') st.removeReminder(ev.reminder._id);
      else st.upsertReminder(ev.reminder);
      break;
    case 'message.scheduled':
      if (ev.action === 'removed') st.removeScheduled(ev.scheduled._id);
      else st.upsertScheduled(ev.scheduled);
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

// Chave do aviso "Sua mensagem agendada … não foi enviada" (um por agendada).
export const scheduledFailKey = (id: string) => `scheduled-failed-${id}`;
