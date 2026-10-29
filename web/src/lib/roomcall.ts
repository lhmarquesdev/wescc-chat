// Chamadas vistas de fora da janela da chamada: o estado de cada sala aberta (cabeçalho, faixa e cartão), as chamadas
// vivas (pontos da barra lateral e página Chamadas), as perdidas (selo) e quem está em chamada. Cada parte busca uma
// vez pelo REST e depois se atualiza pelos eventos; numa reconexão, busca de novo.
import { useEffect, useMemo, useReducer } from 'react';
import { create } from 'zustand';
import type { Call, Room, RoomCallState, ServerEvent, Subscription } from '@shared/index';
import { CALL_GUARD_JOIN, predictJoinBlocked } from '@shared/calls';
import { crossesCallLimit, guessStart, isMuteNoticeFor, missedMayChange, roomCallNeedsPoll, type CallViewEnv, type HeaderGuess, type StartGuessRoom } from '@shared/call-view';
import { api } from './api';
import { namesIn } from './names';
import { callRoomName, isInCall, noteServerTime, openJoin, serverNow, useCallStore } from './call/store';
import { realtime } from './realtime';
import { useSetting, useStore } from './store';

const live = (c: Call | null | undefined) => !!c && (c.status === 'ongoing' || c.status === 'ringing');
const meId = () => useStore.getState().me?._id ?? null;

// ---------- Estado da chamada de cada sala aberta ----------

// stale: estado guardado de quando a sala ficou sem ninguém olhando (os sinais que pedem nova busca não chegaram a ela).
const useRoomCalls = create<{ byRoom: Record<string, RoomCallState | null>; stale: Record<string, true> }>(() => ({ byRoom: {}, stale: {} }));
const roomWatchers = new Map<string, number>();
const roomGen = new Map<string, number>();
const roomTimers = new Map<string, number>();
const pollTimers = new Map<string, number>();
const pollWhenVisible = new Set<string>();
const rechecks = new Map<string, Promise<RoomCallState | null>>();

// Servidor de chamadas fora do ar ou no limite não manda evento quando passa: a sala aberta pergunta de novo a cada
// 15 a 20 s (o servidor guarda a saúde do LiveKit por 15 s), e só com a aba à vista.
function schedulePoll(rid: string, s: RoomCallState | null) {
  clearTimeout(pollTimers.get(rid));
  pollTimers.delete(rid);
  if (!roomCallNeedsPoll(s)) return;
  pollTimers.set(
    rid,
    window.setTimeout(() => {
      pollTimers.delete(rid);
      if (document.hidden) pollWhenVisible.add(rid);
      else refetchRoom(rid, 0);
    }, 15_000 + Math.random() * 5_000),
  );
}

async function loadRoom(rid: string): Promise<RoomCallState | null> {
  const g = (roomGen.get(rid) ?? 0) + 1;
  roomGen.set(rid, g);
  let s: RoomCallState | null = null;
  try {
    s = await api.get<RoomCallState>('calls.roomCall', { roomId: rid });
    noteServerTime(s.serverTime);
  } catch {
    // Sem acesso à sala ou sem conexão: sem chamada para mostrar até a próxima busca.
  }
  if (roomGen.get(rid) !== g || !roomWatchers.has(rid)) return s;
  // Ponto de partida para comparar as próximas mudanças da assinatura e da sala.
  const { subscriptions, rooms } = useStore.getState();
  if (subscriptions[rid]) roomKeys.set(`sub:${rid}`, subKey(subscriptions[rid]));
  if (rooms[rid]) roomKeys.set(`room:${rid}`, roomKey(rooms[rid]));
  useRoomCalls.setState((st) => {
    const { [rid]: _was, ...stale } = st.stale;
    return { byRoom: { ...st.byRoom, [rid]: s }, stale };
  });
  schedulePoll(rid, s);
  return s;
}

// Clique num botão barrado (ou ainda sem resposta): pergunta ao servidor agora, porque o motivo pode já ter passado
// (servidor de volta, alguém saiu da chamada cheia). Cliques seguidos esperam a mesma pergunta.
export function recheckRoomCall(rid: string): Promise<RoomCallState | null> {
  const going = rechecks.get(rid);
  if (going) return going;
  clearTimeout(roomTimers.get(rid));
  roomTimers.delete(rid);
  const p = loadRoom(rid).finally(() => rechecks.delete(rid));
  rechecks.set(rid, p);
  return p;
}

// Várias mudanças seguidas (entrar: tela de entrada, conectando, na chamada) viram uma busca só.
function refetchRoom(rid: string, ms = 300) {
  if (!roomWatchers.has(rid)) return;
  clearTimeout(roomTimers.get(rid));
  roomTimers.set(
    rid,
    window.setTimeout(() => {
      roomTimers.delete(rid);
      void loadRoom(rid);
    }, ms),
  );
}

function refetchRooms() {
  for (const rid of roomWatchers.keys()) refetchRoom(rid);
}

function watchRoom(rid: string) {
  const n = roomWatchers.get(rid) ?? 0;
  roomWatchers.set(rid, n + 1);
  // Pela mesma pergunta dos cliques: um clique antes da resposta espera esta busca, sem outra.
  if (n === 0) void recheckRoomCall(rid);
  return () => {
    const left = (roomWatchers.get(rid) ?? 1) - 1;
    if (left > 0) return void roomWatchers.set(rid, left);
    roomWatchers.delete(rid);
    roomKeys.delete(`sub:${rid}`);
    roomKeys.delete(`room:${rid}`);
    clearTimeout(roomTimers.get(rid));
    roomTimers.delete(rid);
    clearTimeout(pollTimers.get(rid));
    pollTimers.delete(rid);
    pollWhenVisible.delete(rid);
    // O último estado fica (call.room ainda ajusta o resumo da chamada), marcado como provisório: ao voltar, o
    // cabeçalho aparece com ele na hora, sem os botões sumirem e voltarem, e o clique confere antes de agir.
    if (useRoomCalls.getState().byRoom[rid] !== undefined) useRoomCalls.setState((st) => ({ stale: { ...st.stale, [rid]: true } }));
  };
}

// Limite de pessoas da chamada para quem pergunta (o mesmo de calls.join): ouvintes de uma transmissão têm o seu.
function joinLimit(s: RoomCallState): number {
  const st = useStore.getState().settings;
  if (s.call?.listenOnly && s.listenOnly) return Number(st.Calls_Max_Listeners) || 300;
  return Number(st.Calls_Max_Participants) || 30;
}

// call.room (a cada 2 s no máximo): só o resumo muda aqui; outra chamada ou outro estado pedem a visão do servidor.
function patchRoom(rid: string, call: Call | null) {
  const s = useRoomCalls.getState().byRoom[rid];
  if (!s) return;
  const cur = s.call;
  const put = (next: RoomCallState) => useRoomCalls.setState((st) => ({ byRoom: { ...st.byRoom, [rid]: next } }));
  if (!call) {
    if (cur?.scope === 'group') {
      put({ ...s, call: null, canJoin: false, joinBlockedReason: undefined });
      refetchRoom(rid);
    }
    return;
  }
  if (!cur || cur._id !== call._id || cur.status !== call.status) {
    put({ ...s, call: { ...call, mine: cur?._id === call._id ? cur.mine : undefined } });
    refetchRoom(rid);
    return;
  }
  const next: RoomCallState = {
    ...s,
    call: { ...cur, participantsCount: call.participantsCount, sample: call.sample, guardUntil: call.guardUntil, guard: call.guard, peak: call.peak },
  };
  // Chamada que encheu ou abriu lugar: só o servidor sabe (o limite também vale para o servidor inteiro). Quem olha a
  // sala espera um pouco ao acaso, para não perguntarem todos juntos.
  if (crossesCallLimit(cur.participantsCount, call.participantsCount, joinLimit(s))) refetchRoom(rid, 300 + Math.random() * 1200);
  // A trava muda a cada entrada e saída: a previsão segue o resumo sem nova busca.
  if (predictJoinBlocked(call.guard, s.viewerGuard)) {
    next.canJoin = false;
    next.joinBlockedReason = CALL_GUARD_JOIN;
  } else if (s.joinBlockedReason === CALL_GUARD_JOIN) {
    next.canJoin = true;
    next.joinBlockedReason = undefined;
  }
  put(next);
}

// Uma chamada a dois não manda call.room: o evento call da própria chamada avisa a conversa.
function callChanged(call: Call) {
  const s = useRoomCalls.getState().byRoom[call.rid];
  if (s === undefined) return;
  const cur = s?.call ?? null;
  if (cur && cur._id === call._id) {
    if (cur.status !== call.status) refetchRoom(call.rid);
    return;
  }
  if (live(call) || cur) refetchRoom(call.rid);
}

// A assinatura e a sala mudam a cada mensagem (não lidas, última mensagem): só papéis, entrada, saída e o tipo da sala
// mudam o que a sala oferece.
const roomKeys = new Map<string, string>();
function changedFor(rid: string, kind: 'sub' | 'room', key: string) {
  if (!roomWatchers.has(rid)) return;
  const k = `${kind}:${rid}`;
  const before = roomKeys.get(k);
  roomKeys.set(k, key);
  if (before !== undefined && before !== key) refetchRoom(rid);
}
const subKey = (x: Subscription) => `${[...(x.roles ?? [])].sort().join(',')}|${!!x.notice}`;
const roomKey = (r: Room) => [r.ro, r.archived, r.broadcast, r.notice, r.t, r.uids?.length, r.direct?.canCall, r.direct?.callBlockedReason].map(String).join('|');

// Antes da primeira resposta, uma chamada em grupo viva que a lista de chamadas vivas já conhece faz as vezes do estado
// (pílula, faixa e cartão aparecem na hora); entrar fica para o clique conferir.
function fromLive(call: Call): RoomCallState {
  return { call, canStart: false, hideStart: false, canJoin: true, listenOnly: !!call.listenOnly, transmission: false, serverTime: '' };
}

export function useRoomCall(rid: string | null): RoomCallState | null {
  const s = useRoomCalls((st) => (rid ? st.byRoom[rid] : undefined));
  const known = useLive((st) => (rid && s === undefined ? st.calls[rid] : undefined));
  useEffect(() => {
    if (!rid) return;
    // A lista de chamadas vivas também serve a quem chega direto numa sala (celular, sem a barra lateral montada).
    ensureLive();
    return watchRoom(rid);
  }, [rid]);
  return useMemo(() => (s !== undefined ? s : known?.scope === 'group' && live(known) ? fromLive(known) : null), [s, known]);
}

// O estado da sala veio do servidor com a sala aberta. Sem isso (ainda sem resposta, só a lista de chamadas vivas ou
// guardado de quando estava fechada), o que a sala mostra é provisório e o clique pergunta ao servidor antes de agir.
export function useRoomCallSettled(rid: string | null): boolean {
  return useRoomCalls((st) => !!rid && st.byRoom[rid] !== undefined && !st.stale[rid]);
}

// O que o cliente já sabe para iniciar na sala (guessStart), com os papéis que o servidor conta: quem tem papel restrito
// em conversas diretas só vale pelos papéis globais (managementRoles).
export function useHeaderGuess(rid: string | null, room: (StartGuessRoom & { _id: string }) | null | undefined): HeaderGuess {
  const settled = useRoomCallSettled(rid);
  const groupEnabled = !!useSetting<boolean>('Calls_Group_Enabled');
  const me = useStore((st) => st.me);
  const sub = useStore((st) => (rid ? st.subscriptions[rid] : undefined));
  const allowed = useStore((st) => st.permMap['call-management']);
  const restricted = useStore((st) => st.restrictedRoles);
  const r = room && room._id === rid ? room : null;
  return useMemo(() => {
    if (!r || !me) return { start: { show: false }, settled };
    const restrictedMe = me.roles.some((x) => restricted.includes(x));
    const roles = restrictedMe ? me.roles : [...me.roles, ...(sub?.roles ?? [])];
    const canManage = !!allowed && roles.some((x) => allowed.includes(x));
    return { start: guessStart(r, { groupEnabled, canManage, member: !!sub, username: me.username }), settled };
  }, [r, me, sub, allowed, restricted, groupEnabled, settled]);
}

// ---------- Chamadas vivas (por sala) ----------

const useLive = create<{ calls: Record<string, Call> }>(() => ({ calls: {} }));
let liveLoaded = false;
let liveAsked = false;
let liveGen = 0;
let liveTimer = 0;

// Uma busca só, pedida por quem montar primeiro (barra lateral, página Chamadas ou a sala).
function ensureLive() {
  if (liveLoaded || liveAsked || !meId()) return;
  liveAsked = true;
  void loadLive();
}

async function loadLive() {
  const g = ++liveGen;
  try {
    const r = await api.get<{ calls: Call[] }>('calls.active');
    if (g !== liveGen) return;
    const calls: Record<string, Call> = {};
    // A mais nova primeiro (o servidor ordena): uma sala com duas chamadas vivas mostra a mais nova.
    for (const c of r.calls) if (live(c) && !calls[c.rid]) calls[c.rid] = c;
    useLive.setState({ calls });
    liveLoaded = true;
  } catch {
    // tenta de novo na próxima reconexão
  }
}

function refetchLive(ms = 500) {
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => void loadLive(), ms);
}

function liveFromRoom(rid: string, call: Call | null) {
  const cur = useLive.getState().calls[rid];
  if (!call) {
    if (!cur || cur.scope !== 'group') return;
    const { [rid]: _gone, ...rest } = useLive.getState().calls;
    useLive.setState({ calls: rest });
    return;
  }
  // Chamada nova: entra já (o ponto aparece na hora) e a lista completa traz a sala e o "mine".
  if (!cur || cur._id !== call._id) {
    useLive.setState((st) => ({ calls: { ...st.calls, [rid]: call } }));
    refetchLive();
    return;
  }
  useLive.setState((st) => ({ calls: { ...st.calls, [rid]: { ...cur, participantsCount: call.participantsCount, sample: call.sample, guardUntil: call.guardUntil, peak: call.peak } } }));
}

function liveFromCall(call: Call) {
  const cur = useLive.getState().calls[call.rid];
  if (live(call)) {
    useLive.setState((st) => ({ calls: { ...st.calls, [call.rid]: { ...cur, ...call, room: call.room ?? (cur?._id === call._id ? cur.room : undefined), participants: undefined } } }));
    return;
  }
  if (cur?._id !== call._id) return;
  const { [call.rid]: _gone, ...rest } = useLive.getState().calls;
  useLive.setState({ calls: rest });
}

export function useLiveCalls(): Record<string, Call> {
  const calls = useLive((s) => s.calls);
  useEffect(() => ensureLive(), []);
  return calls;
}

// ---------- Chamadas perdidas (selo de Chamadas) ----------

const useMissed = create<{ count: number }>(() => ({ count: 0 }));
let missedLoaded = false;
let missedGen = 0;
let missedTimer = 0;

async function loadMissed() {
  const g = ++missedGen;
  try {
    const r = await api.get<{ count: number }>('calls.missedCount');
    if (g !== missedGen) return;
    useMissed.setState({ count: r.count });
    missedLoaded = true;
  } catch {
    // tenta de novo na próxima reconexão
  }
}

function refetchMissed(ms = 800) {
  clearTimeout(missedTimer);
  missedTimer = window.setTimeout(() => void loadMissed(), ms);
}

// Chamada em grupo nova numa DM de várias pessoas: quem já está em outra chamada (aqui, em outra aba ou em outro
// aparelho) não recebe o toque e o servidor já grava a chamada como perdida. Só o call.room da sala avisa.
const dmGroupCalls = new Set<string>();
function noteDmGroupCall(rid: string, call: Call) {
  if (call.scope !== 'group' || !live(call) || dmGroupCalls.has(call._id)) return;
  if (useStore.getState().subscriptions[rid]?.t !== 'd') return;
  if (dmGroupCalls.size > 200) dmGroupCalls.clear();
  dmGroupCalls.add(call._id);
  refetchMissed();
}

export function useMissedCalls(): number {
  const n = useMissed((s) => s.count);
  useEffect(() => {
    if (!missedLoaded && meId()) void loadMissed();
  }, []);
  return n;
}

export async function markCallsSeen(): Promise<void> {
  missedGen++;
  useMissed.setState({ count: 0 });
  try {
    await api.post('calls.seen');
  } catch {
    // o selo volta a contar na próxima busca
  }
}

// ---------- "Em chamada" ----------

const useInCallStore = create<{ ids: Record<string, boolean> }>(() => ({ ids: {} }));
const inCallWatchers = new Map<string, number>();
const inCallAsked = new Set<string>();
const inCallQueue = new Set<string>();
let inCallTimer = 0;
let inCallGen = 0;

// Os pedidos de vários componentes que montam juntos (lista de membros) viram um só, com até 200 pessoas.
function askInCall(id: string) {
  if (inCallAsked.has(id)) return;
  inCallAsked.add(id);
  inCallQueue.add(id);
  if (inCallTimer) return;
  inCallTimer = window.setTimeout(() => {
    inCallTimer = 0;
    const all = [...inCallQueue];
    inCallQueue.clear();
    const g = inCallGen;
    for (let i = 0; i < all.length; i += 200) {
      const ids = all.slice(i, i + 200);
      api
        .get<{ userIds: string[] }>('calls.inCall', { userIds: ids.join(',') })
        .then((r) => {
          if (g !== inCallGen) return;
          const on = new Set(r.userIds);
          useInCallStore.setState((st) => {
            const next = { ...st.ids };
            // Um call.presence que chegou durante a busca vale mais que a resposta.
            for (const u of ids) if (!(u in st.ids)) next[u] = on.has(u);
            return { ids: next };
          });
        })
        .catch(() => {
          if (g === inCallGen) for (const u of ids) inCallAsked.delete(u);
        });
    }
  }, 50);
}

function watchInCall(id: string) {
  inCallWatchers.set(id, (inCallWatchers.get(id) ?? 0) + 1);
  askInCall(id);
  return () => {
    const left = (inCallWatchers.get(id) ?? 1) - 1;
    if (left > 0) inCallWatchers.set(id, left);
    else inCallWatchers.delete(id);
  };
}

export function useInCall(userId: string | null): boolean {
  const on = useInCallStore((s) => (userId ? s.ids[userId] === true : false));
  useEffect(() => (userId ? watchInCall(userId) : undefined), [userId]);
  return on;
}

// A outra pessoa de cada conversa a dois da barra lateral. A assinatura só traz o nome de usuário e a sala só entra
// no store quando é aberta: as que faltam vêm de um im.list só, refeito quando aparece uma conversa nova.
const usePeers = create<{ byRid: Record<string, string> }>(() => ({ byRid: {} }));
const peersAsked = new Set<string>();
let peersTimer = 0;
let peersGen = 0;

function askPeers(rid: string) {
  if (peersAsked.has(rid)) return;
  peersAsked.add(rid);
  if (peersTimer) return;
  peersTimer = window.setTimeout(() => {
    peersTimer = 0;
    const g = peersGen;
    api
      .get<{ ims: Room[] }>('im.list')
      .then((r) => {
        if (g !== peersGen) return;
        const me = meId();
        const byRid: Record<string, string> = {};
        for (const room of r.ims) {
          const other = room.uids?.length === 2 ? room.uids.find((id) => id !== me) : undefined;
          if (other) byRid[room._id] = other;
        }
        usePeers.setState((st) => ({ byRid: { ...st.byRid, ...byRid } }));
      })
      .catch(() => {
        if (g === peersGen) peersAsked.clear();
      });
  }, 50);
}

export function useDirectPeer(rid: string, enabled: boolean): string | null {
  const on = enabled && !!useSetting<boolean>('Calls_Enabled');
  const fromRoom = useStore((st) => (on ? (st.rooms[rid]?.uids?.find((id) => id !== st.me?._id) ?? null) : null));
  const fromList = usePeers((s) => (on ? (s.byRid[rid] ?? null) : null));
  useEffect(() => {
    if (on && !fromRoom && !fromList) askPeers(rid);
  }, [on, rid, fromRoom, fromList]);
  return fromRoom ?? fromList;
}

// ---------- Relógio e ambiente das visões (call-view.ts) ----------

const tickers = new Set<() => void>();
let tickTimer = 0;

function onTick(cb: () => void) {
  tickers.add(cb);
  if (!tickTimer) tickTimer = window.setInterval(() => tickers.forEach((f) => f()), 1000);
  return () => {
    tickers.delete(cb);
    if (!tickers.size) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  };
}

// Hora do servidor, de segundo em segundo enquanto `active` (um único intervalo para todos os cronômetros).
export function useNow(active = true): number {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => (active ? onTick(bump) : undefined), [active]);
  return serverNow();
}

// O que call-view.ts precisa saber de fora do servidor: chamadas ligadas, HTTPS, e se esta chamada é a minha.
export function useCallEnv(callId: string | null | undefined, tick = false): CallViewEnv {
  const enabled = !!useSetting<boolean>('Calls_Enabled');
  const inThisCall = useCallStore((s) => !!callId && s.call?._id === callId && s.phase !== 'idle' && s.phase !== 'preflight' && s.phase !== 'ended');
  const inOtherCall = useCallStore((s) => !!s.call && s.call._id !== callId && s.phase !== 'idle' && s.phase !== 'preflight' && s.phase !== 'ended');
  const otherTab = useCallStore((s) => !!callId && s.tabCall?.callId === callId);
  const now = useNow(tick);
  return { enabled, secure: window.isSecureContext, inThisCall, inOtherCall, otherTab, now };
}

// O motivo de um botão barrado (ou "em outra aba"), num aviso; cliques repetidos não empilham o mesmo texto.
export function explainCall(text: string) {
  const st = useStore.getState();
  const msg = namesIn(text);
  if (!st.toasts.some((t) => t.text === msg)) st.toast(msg, 'info');
}

// ---------- "Avisar a sala" ----------

// Nome da sala para um texto: "#geral" nos canais, como na barra lateral.
export function callRoomLabel(room: Call['room'] | null | undefined, fallback = 'uma sala'): string {
  const name = callRoomName(room ?? null);
  if (!name) return fallback;
  return room?.t === 'c' && !room.prid ? `#${name}` : name;
}

function roomLabel(call: Call) {
  return callRoomLabel(call.room);
}

function onInvite(call: Call, by: { username: string }) {
  if (isInCall(call._id)) return;
  const text = `@${by.username} chamou a sala para a chamada em ${roomLabel(call)}.`;
  useStore.getState().toast(text, 'info', { icon: 'call-live', duration: 10_000, action: { label: 'Entrar', onClick: () => void openJoin(call._id, call.rid) } });
  // Sem som: só a notificação do sistema quando a aba está escondida.
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`Chamada em ${roomLabel(call)}`, { body: text, icon: '/icons/icon-192.png', tag: `call-invite-${call._id}` });
    n.onclick = () => {
      window.focus();
      n.close();
      void openJoin(call._id, call.rid);
    };
  } catch {
    // notificações indisponíveis
  }
}

// ---------- Eventos ----------

function onEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'connected':
      // Primeira conexão ou reconexão: o que mudou enquanto estava fora volta pelo REST. O estado guardado das salas
      // fechadas perdeu eventos: sai, e a próxima abertura busca do zero.
      useRoomCalls.setState((st) => ({ byRoom: Object.fromEntries(Object.entries(st.byRoom).filter(([rid]) => roomWatchers.has(rid))), stale: {} }));
      refetchRooms();
      refetchLive(0);
      refetchMissed(0);
      inCallGen++;
      inCallAsked.clear();
      useInCallStore.setState({ ids: {} });
      for (const id of inCallWatchers.keys()) askInCall(id);
      return;
    case 'call.room':
      if (ev.call) noteDmGroupCall(ev.rid, ev.call);
      patchRoom(ev.rid, ev.call);
      liveFromRoom(ev.rid, ev.call);
      return;
    case 'call': {
      callChanged(ev.call);
      liveFromCall(ev.call);
      // Perdida no servidor também quando quem ligou cancelou ou deu ocupado: qualquer fim sem eu atender.
      if (missedMayChange(ev.call, meId())) refetchMissed();
      return;
    }
    case 'message':
      // Silenciado ou liberado nesta sala: iniciar muda (a sala não traz a lista de silenciados).
      if (ev.action === 'inserted' && isMuteNoticeFor(ev.message, useStore.getState().me?.username)) refetchRoom(ev.message.rid);
      return;
    case 'call.ring':
      if (ev.action === 'stop') refetchMissed();
      return;
    case 'call.presence':
      useInCallStore.setState((st) => (st.ids[ev.userId] === ev.inCall ? st : { ids: { ...st.ids, [ev.userId]: ev.inCall } }));
      return;
    case 'call.invite':
      onInvite(ev.call, ev.by);
      return;
    case 'permissions.changed':
      refetchRooms();
      return;
    case 'subscription':
      if (ev.action === 'updated') changedFor(ev.subscription.rid, 'sub', subKey(ev.subscription));
      else refetchRoom(ev.subscription.rid);
      return;
    case 'room':
      if (ev.action === 'updated') changedFor(ev.room._id, 'room', roomKey(ev.room));
      else refetchRoom(ev.room._id);
      return;
    case 'settings.changed':
      if (ev.settings.some((x) => /^(Calls_|VideoConf|Direct_)/.test(x._id))) refetchRooms();
      return;
    case 'user':
      if (ev.user._id === meId()) refetchRooms();
      // Papéis da outra pessoa de uma conversa a dois mudam quem pode ligar para quem.
      else if (ev.user.roles) for (const rid of roomWatchers.keys()) if (useStore.getState().rooms[rid]?.uids?.includes(ev.user._id)) refetchRoom(rid);
      return;
  }
}

realtime.on(onEvent);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const rid of pollWhenVisible) refetchRoom(rid, 0);
  pollWhenVisible.clear();
});

// Entrar, sair e fechar a tela de entrada mudam o que a sala oferece (Entrar, Na chamada, Iniciar). Ao sair, o selo
// confere de novo: toques que chegaram enquanto eu estava ocupado já são perdidos no servidor.
useCallStore.subscribe((s, prev) => {
  if (s.phase !== prev.phase || s.call?._id !== prev.call?._id || s.tabCall?.callId !== prev.tabCall?.callId) refetchRooms();
  if (s.phase === 'idle' && prev.phase !== 'idle') refetchMissed();
});

// Saiu da conta: nada do usuário anterior fica para o próximo.
useStore.subscribe((s, prev) => {
  if (prev.me && !s.me) {
    liveLoaded = false;
    liveAsked = false;
    missedLoaded = false;
    liveGen++;
    missedGen++;
    inCallGen++;
    inCallAsked.clear();
    peersGen++;
    peersAsked.clear();
    usePeers.setState({ byRid: {} });
    useLive.setState({ calls: {} });
    useMissed.setState({ count: 0 });
    useInCallStore.setState({ ids: {} });
    useRoomCalls.setState({ byRoom: {}, stale: {} });
    dmGroupCalls.clear();
  }
});
