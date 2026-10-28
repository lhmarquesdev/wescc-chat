// Estado da chamada (a dois e em grupo) e as ações que a interface chama. Ouve os eventos call, call.ring,
// call.notice, call.prompt, call.hand e call.room; o motor de mídia (P2P ou SFU) entra só quando a chamada começa.
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ReactNode } from 'react';
import type { Call, CallJoin, CallKind, CallModerationAction, CallNotice, CallParticipant, CallRoomRef, CallsConfig, CallSource, Room, ServerEvent, UserRef } from '@shared/index';
import { CALL_LIMITS, callEndedReasonText, callNamesLabel, callPeopleLabel, callUserLabel, formatCallDuration } from '@shared/calls';
import { cameraLimitReached } from '@shared/call-layout';
import { api, ApiError, errorMessage } from '../api';
import { nameOf } from '../names';
import { realtime } from '../realtime';
import { useStore } from '../store';
import { loadChoice, lowResFor, openMedia, PROBLEM_TEXT, problemOf, UNPLUGGED, watchDevices, watchMutedSpeech } from './devices';
import { createEngine, EngineError, type CallEngine, type EngineEvent } from './engine';
import { installShortcuts } from './shortcuts';
import { chime, startRing, stopRing } from './sounds';
import { announceCall, watchTabs, type TabCall } from './tabs';
import { keepAwake } from './wake';

export type CallPhase = 'idle' | 'preflight' | 'connecting' | 'ringing-out' | 'in-call' | 'reconnecting' | 'ended';
export type PeerQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export interface LivePeer {
  id: string; // = _id do usuário
  user: UserRef | null; // null até carregar
  isMe: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
  lastSpokeAt: number | null;
  handAt: number | null; // do servidor (call.hand), nunca do LiveKit
  quality: PeerQuality;
  canPublish: boolean;
  joinedAt: number;
}
export type CallWindowMode = 'docked' | 'pill' | 'big';
export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
export interface CallStoreState {
  phase: CallPhase;
  call: Call | null;
  room: CallRoomRef | null;
  preflight: { mode: 'start' | 'join' | 'listen'; rid: string; kind: CallKind; callId?: string } | null;
  incoming: Call[]; // fila de toques; mostra o primeiro
  peers: Record<string, LivePeer>;
  me: { mic: boolean; camera: boolean; screen: boolean; tabAudio: boolean; handAt: number | null; canPublish: boolean; sources: CallSource[]; hidden: boolean };
  view: { window: CallWindowMode; fullscreen: boolean; layout: 'grid' | 'spotlight'; pinned: string | null; panel: 'people' | null; receiveVideo: boolean };
  notice: CallNotice | null;
  elsewhere: 'device' | 'tab' | null;
  rejoin: Call | null; // saiu por queda ou recarga: oferece voltar
  ended: { title: string; text: string; seconds: number } | null;
  layer: HTMLElement | null; // raiz .call-layer (menus, diálogos e avisos da chamada)
  clockOffset: number; // relógio do servidor - relógio local, em ms
  // Adições da callweb (aditivas ao contrato da fase 0w):
  ringBy: Record<string, UserRef>; // quem chamou, por chamada (toque em grupo)
  roster: CallParticipant[]; // de calls.info: anfitrião, quem está sendo chamado
  audioBlocked: boolean; // o navegador bloqueou o som
  failed: boolean; // as novas tentativas de conexão acabaram
  tabCall: TabCall | null; // chamada aberta em outra aba deste navegador
  ptt: boolean; // segurando Espaço para falar
  maxVideo: number; // câmeras ligadas ao mesmo tempo
  screenBlockedUntil: number | null; // um moderador parou minha tela
  live: { text: string; n: number }; // região viva (leitores de tela)
  confirm: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  config: CallsConfig | null;
  engineId: number; // muda a cada motor novo: os vídeos se ligam de novo
  otherDevice: Call | null; // estou nesta chamada em outro aparelho (ou navegador): oferece trazer para cá
}

export const initialMe: CallStoreState['me'] = { mic: false, camera: false, screen: false, tabAudio: false, handAt: null, canPublish: false, sources: [], hidden: false };
export const initialView: CallStoreState['view'] = { window: 'docked', fullscreen: false, layout: 'grid', pinned: null, panel: null, receiveVideo: true };

const callIdle = {
  phase: 'idle' as CallPhase,
  call: null,
  room: null,
  preflight: null,
  peers: {},
  me: initialMe,
  view: initialView,
  notice: null,
  elsewhere: null,
  ended: null,
  roster: [],
  audioBlocked: false,
  failed: false,
  ptt: false,
  maxVideo: 16,
  screenBlockedUntil: null,
};

export const useCallStore: UseBoundStore<StoreApi<CallStoreState>> = create<CallStoreState>(() => ({
  ...callIdle,
  incoming: [],
  rejoin: null,
  layer: null,
  clockOffset: 0,
  ringBy: {},
  tabCall: null,
  live: { text: '', n: 0 },
  confirm: null,
  config: null,
  engineId: 0,
  otherDevice: null,
}));

const get = () => useCallStore.getState();
const set = (p: Partial<CallStoreState> | ((s: CallStoreState) => Partial<CallStoreState>)) => useCallStore.setState(p);
const toast = (text: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info', opts?: { action?: { label: string; onClick: () => void }; icon?: string }) =>
  useStore.getState().toast(text, kind, opts);
const meRef = (): UserRef | null => {
  const me = useStore.getState().me;
  return me ? { _id: me._id, username: me.username, name: me.name } : null;
};

// O servidor aceita os dois motores; a escolha dele chega em call.media.
const ENGINES = ['p2p', 'sfu'];

const ENDED_TEXT: Record<string, string> = {
  declined: 'Chamada recusada.',
  missed: 'Sem resposta.',
  busy: 'A pessoa está em outra chamada.',
  canceled: 'Chamada cancelada.',
  ended: 'Chamada encerrada.',
};
const NO_MIC = 'Não foi possível usar o microfone. Confira a permissão do navegador.';
const NO_LINK = 'Sem conexão com o servidor. Tente de novo em instantes.';
const JOIN_FAILED = 'Não foi possível entrar na chamada.';
const TOO_MANY = 'Há conexões demais abertas para esta chamada. Feche outras abas do chat e tente de novo.';
const GUARD_PAUSED = 'Microfones e câmeras pausados até um supervisor entrar.';
const SCREEN_BLOCKED = 'Um moderador parou seu compartilhamento. Tente de novo em instantes.';

// ---------- Estado de módulo (fora do zustand: objetos vivos) ----------

let engine: CallEngine | null = null;
let engineOff: (() => void) | null = null;
let gen = 0; // sessão atual: respostas de uma sessão antiga são ignoradas
let joinedAtLocal = 0;
let leaveNext = false; // a próxima entrada sai da chamada atual (confirmado na pergunta)
let refusedOnce = false;
let retryTimer = 0;
let retryStep = 0;
let endTimer = 0;
let removalTimer = 0;
let settled = false; // o primeiro lote de pessoas já chegou (as entradas seguintes viram aviso)
let speechOff: (() => void) | null = null;
let stableTimer = 0;
let lastInfo = 0;
let infoTimer = 0;
const users = new Map<string, UserRef>();
const hands = new Map<string, number>();
const since = new Map<string, number>(); // falando desde
const pendingJoin = new Map<string, number>(); // entrou antes de o nome chegar: o aviso espera calls.info
let preWindow: CallWindowMode = 'docked';
let awayAt = 0; // quando a chamada foi para outro aparelho ou aba (esse tempo não conta no "Você ficou")
let awayTimer = 0;

// Esta aba está (ou estava, antes de recarregar) nesta chamada. O sessionStorage é por aba e sobrevive à recarga:
// é o que separa "voltei depois de recarregar" (Voltar) de "estou nela em outro aparelho" (Trazer para cá).
const LIVE_KEY = 'wescc.call.live';
function markLive(callId: string | null) {
  try {
    if (callId) sessionStorage.setItem(LIVE_KEY, callId);
    else sessionStorage.removeItem(LIVE_KEY);
  } catch {
    // sem armazenamento da sessão
  }
}
function liveHere(): string | null {
  try {
    return sessionStorage.getItem(LIVE_KEY);
  } catch {
    return null;
  }
}

export function speakingSince(id: string): number | null {
  return since.get(id) ?? null;
}

export function userOf(id: string): UserRef | null {
  return users.get(id) ?? null;
}

function remember(list: (UserRef | null | undefined)[]) {
  for (const u of list) if (u?._id) users.set(u._id, u);
}

export function currentEngine(): CallEngine | null {
  return engine;
}

// ---------- Utilidades ----------

export function isInCall(callId?: string): boolean {
  const { call, phase } = useCallStore.getState();
  if (!call || phase === 'idle' || phase === 'preflight' || phase === 'ended') return false;
  return callId ? call._id === callId : true;
}

export function serverNow(): number {
  return Date.now() + useCallStore.getState().clockOffset;
}

// Hora do servidor vinda de calls.config ou de RoomCallState.serverTime: os cronômetros usam serverNow().
export function noteServerTime(iso: string | null | undefined) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(t)) set({ clockOffset: t - Date.now() });
}

export function announce(text: string) {
  set((s) => ({ live: { text, n: s.live.n + 1 } }));
}

const quiet = () => (get().call?.participantsCount ?? 0) > CALL_LIMITS.quietAbove;
const label = (u: UserRef | null | undefined) => (u ? callUserLabel(u) : 'Alguém');

function roomRefFromStore(rid: string): CallRoomRef | null {
  const r: Room | undefined = useStore.getState().rooms[rid];
  const sub = useStore.getState().subscriptions[rid];
  if (!r && !sub) return null;
  return {
    _id: rid,
    t: (r?.t ?? sub?.t) as CallRoomRef['t'],
    name: r?.name ?? sub?.name ?? null,
    fname: r?.fname ?? sub?.fname ?? null,
    prid: r?.prid ?? null,
    teamMain: r?.teamMain,
    notice: r?.notice,
    broadcast: r?.broadcast,
    usernames: r?.usernames,
  };
}

// Nome da sala da chamada: o da sala; numa conversa com várias pessoas, os nomes delas.
export function callRoomName(room: CallRoomRef | null | undefined): string {
  if (!room) return '';
  if (room.t === 'd') {
    const me = useStore.getState().me?.username;
    const others = (room.usernames ?? []).filter((u) => u !== me);
    if (others.length) return callNamesLabel(others.map((u) => ({ _id: u, username: u, name: nameOf(u) })), others.length);
  }
  const sub = useStore.getState().subscriptions[room._id];
  return room.fname || sub?.fname || room.name || sub?.name || '';
}

function isDirectRoom(rid: string, room?: Room | null) {
  const r = room ?? useStore.getState().rooms[rid];
  return r?.t === 'd' && (r.uids?.length ?? r.usernames?.length ?? 0) === 2;
}

// ---------- Pergunta dentro da chamada (camada da chamada, acima da janela) ----------

export function confirmInCall(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = get().confirm;
    prev?.resolve(false);
    set({ confirm: { ...o, resolve } });
  });
}

export function answerConfirm(ok: boolean) {
  const c = get().confirm;
  set({ confirm: null });
  c?.resolve(ok);
}

// Já em outra chamada: pergunta antes, e a próxima entrada leva leaveCurrent.
async function leaveFirst(): Promise<boolean> {
  leaveNext = false;
  if (!isInCall()) return true;
  const name = callRoomName(get().room) || 'outra sala';
  const ok = await confirmInCall({ title: 'Sair da chamada atual?', body: `Você está em uma chamada em ${name}. Para entrar nesta, você sai da outra.`, confirmLabel: 'Sair e entrar' });
  if (!ok) return false;
  leaveNext = true;
  return true;
}

// Ao sair da chamada atual pelo servidor, o motor daqui fecha sem aviso nem tela de fim.
async function dropLocal() {
  if (!isInCall()) return;
  teardown();
  set({ ...callIdle });
}

// ---------- Janela ----------

const VIEW_KEY = (k: CallKind) => `wescc.call.view.${k}`;

function openingMode(call: Call): CallWindowMode {
  if (call.scope === 'direct') return 'docked';
  try {
    const v = localStorage.getItem(VIEW_KEY(call.kind));
    if (v === 'docked' || v === 'big') return v;
  } catch {
    // sem armazenamento local
  }
  return call.kind === 'video' ? 'big' : 'docked';
}

export function setWindow(mode: CallWindowMode) {
  const { view, call } = get();
  if (mode === view.window) return;
  if (mode === 'pill') preWindow = view.window;
  if (mode !== 'big' && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  set({ view: { ...view, window: mode, fullscreen: mode === 'big' ? view.fullscreen : false } });
  // A escolha entre encaixada e ampliada vale para as próximas chamadas em grupo do mesmo tipo.
  if (call?.scope === 'group' && mode !== 'pill') {
    try {
      localStorage.setItem(VIEW_KEY(call.kind), mode);
    } catch {
      // sem armazenamento local
    }
  }
}

export function expandCall(): void {
  const { view, phase } = get();
  if (phase === 'idle') return;
  if (view.window === 'pill') setWindow(preWindow === 'pill' ? 'docked' : preWindow);
  else if (view.window === 'docked') setWindow('big');
}

export function minimizeCall(): void {
  if (get().phase !== 'idle') setWindow('pill');
}

export function setView(p: Partial<CallStoreState['view']>) {
  set((s) => ({ view: { ...s.view, ...p } }));
  if (p.receiveVideo !== undefined) engine?.setReceiveVideo(p.receiveVideo);
}

// ---------- Motor ----------

function engineCtx() {
  const me = meRef()!;
  remember([me]);
  return { me, userOf: (id: string) => users.get(id) ?? null, lookup };
}

// Identidade que ainda não conhecemos: calls.info, no máximo uma vez a cada 2 s.
function lookup() {
  if (infoTimer) return;
  const wait = Math.max(0, 2000 - (Date.now() - lastInfo));
  infoTimer = window.setTimeout(() => {
    infoTimer = 0;
    lastInfo = Date.now();
    void refreshRoster();
  }, wait);
}

export async function refreshRoster() {
  const call = get().call;
  if (!call || call.scope !== 'group') return;
  const g = gen;
  try {
    const r = (await api.get('calls.info', { callId: call._id })) as { call: Call };
    if (g !== gen) return;
    applyRoster(r.call);
  } catch {
    // tenta de novo no próximo pedido
  }
}

function applyRoster(c: Call) {
  const parts = c.participants ?? [];
  remember([c.caller, ...c.sample, ...parts.map((p) => p.user)]);
  for (const id of [...pendingJoin.keys()]) if (users.has(id)) flushJoin(id);
  for (const p of parts) {
    if (p.handAt && (p.state === 'joined' || p.state === 'joining')) hands.set(p.user._id, Date.parse(p.handAt));
    else hands.delete(p.user._id);
  }
  set((s) => ({
    roster: parts,
    call: s.call && s.call._id === c._id ? { ...s.call, ...c, participants: undefined } : s.call,
    peers: mergeHands(s.peers),
  }));
}

function mergeHands(peers: Record<string, LivePeer>) {
  const out: Record<string, LivePeer> = {};
  for (const [id, p] of Object.entries(peers)) out[id] = { ...p, user: p.user ?? users.get(id) ?? null, handAt: hands.get(id) ?? null };
  return out;
}

function onEngine(e: EngineEvent) {
  const s = get();
  switch (e.type) {
    case 'peers': {
      const next: Record<string, LivePeer> = {};
      const now = Date.now();
      for (const p of e.peers) {
        next[p.id] = { ...p, user: p.user ?? users.get(p.id) ?? null, handAt: hands.get(p.id) ?? null };
        if (p.speaking) since.set(p.id, since.get(p.id) ?? now);
        else since.delete(p.id);
      }
      const group = s.call?.scope === 'group';
      if (group && settled && !quiet()) {
        for (const p of e.peers) if (!p.isMe && !s.peers[p.id]) arrived(next[p.id], true);
        for (const p of Object.values(s.peers)) if (!p.isMe && !next[p.id]) arrived(p, false);
      }
      settled = true;
      const mine = e.peers.find((p) => p.isMe);
      const me = mine ? { ...s.me, mic: mine.mic, camera: mine.camera, screen: mine.screen } : s.me;
      if (mine && s.me.mic !== mine.mic && !s.ptt) announce(mine.mic ? 'Microfone ligado' : 'Microfone desligado');
      if (mine && s.me.camera !== mine.camera) announce(mine.camera ? 'Câmera ligada' : 'Câmera desligada');
      // Fixado que saiu da chamada: volta para a grade.
      const view = s.view.pinned && !next[s.view.pinned] ? { ...s.view, pinned: null } : s.view;
      set({ peers: next, me, view });
      return;
    }
    case 'speaking': {
      const now = Date.now();
      const ids = new Set(e.ids);
      const peers: Record<string, LivePeer> = {};
      for (const [id, p] of Object.entries(s.peers)) {
        const on = ids.has(id);
        if (on) since.set(id, since.get(id) ?? now);
        else since.delete(id);
        peers[id] = on === p.speaking ? p : { ...p, speaking: on, lastSpokeAt: on ? now : p.lastSpokeAt };
      }
      set({ peers });
      return;
    }
    case 'state':
      return onEngineState(e.state, e.reason);
    case 'permissions': {
      set({ me: { ...s.me, canPublish: e.canPublish, sources: e.sources } });
      return;
    }
    case 'audio-blocked':
      set({ audioBlocked: e.blocked });
      return;
    case 'refused':
      void onRefused(e.status);
      return;
    case 'device-error': {
      if (e.error.startsWith('Limite de')) toast(e.error, 'warning');
      else if (e.kind === 'screen') toast('Não foi possível compartilhar a tela.', 'error');
      else toast(PROBLEM_TEXT[problemOf({ name: e.error })] ?? NO_MIC, 'error');
      return;
    }
  }
}

function arrived(p: LivePeer, joined: boolean) {
  const u = p.user ?? users.get(p.id);
  // Nome ainda desconhecido: espera o calls.info (no máximo 3 s) em vez de avisar "Alguém entrou".
  if (!u && joined) {
    if (!pendingJoin.has(p.id)) pendingJoin.set(p.id, window.setTimeout(() => flushJoin(p.id), 3000));
    lookup();
    return;
  }
  if (!joined && pendingJoin.has(p.id)) {
    clearTimeout(pendingJoin.get(p.id));
    pendingJoin.delete(p.id);
    return;
  }
  notifyArrival(label(u), joined);
}

function flushJoin(id: string) {
  const t = pendingJoin.get(id);
  if (t === undefined) return;
  clearTimeout(t);
  pendingJoin.delete(id);
  const p = get().peers[id];
  if (p && !quiet()) notifyArrival(label(p.user ?? users.get(id)), true);
}

function notifyArrival(name: string, joined: boolean) {
  const text = `${name} ${joined ? 'entrou' : 'saiu'}`;
  toast(text, 'info', { icon: joined ? 'call-incoming' : 'call-outgoing' });
  announce(text);
  chime(joined ? 'join' : 'leave');
}

function clearPendingJoins() {
  for (const t of pendingJoin.values()) clearTimeout(t);
  pendingJoin.clear();
}

function onEngineState(state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected', reason?: string) {
  const s = get();
  if (state === 'connecting') return;
  if (state === 'connected') {
    if (s.phase === 'ringing-out') return;
    if (s.phase === 'reconnecting') toast('Conexão restabelecida.', 'success');
    set({ phase: 'in-call', failed: false });
    stopRing();
    armSpeechHint();
    clearTimeout(stableTimer);
    // Conectado por 10 s: uma próxima recusa volta a ganhar uma nova tentativa automática.
    stableTimer = window.setTimeout(() => (refusedOnce = false), 10_000);
    return;
  }
  if (state === 'reconnecting') {
    if (s.phase === 'in-call') set({ phase: 'reconnecting' });
    return;
  }
  // Desconectado.
  if (s.call?.scope === 'direct') {
    if (reason === 'failed') {
      toast('A conexão da chamada caiu.', 'error');
      void leaveCall();
    }
    return;
  }
  void onSfuDisconnected(reason ?? 'UNKNOWN_REASON');
}

async function onSfuDisconnected(reason: string) {
  const s = get();
  if (!s.call) return;
  if (reason === 'CLIENT_INITIATED') return;
  if (reason === 'DUPLICATE_IDENTITY') {
    await closeEngine();
    clearTimeout(retryTimer);
    markLive(null);
    awayAt = Date.now();
    set({ elsewhere: s.tabCall?.callId === s.call._id ? 'tab' : 'device', phase: 'in-call', failed: false });
    watchAway();
    return;
  }
  if (reason === 'PARTICIPANT_REMOVED' || reason === 'ROOM_DELETED') {
    // O motivo (remoção, recusa, fim) chega pelo call.notice ou pelo evento call: espera um pouco por ele.
    await closeEngine();
    awaitReason(reason === 'ROOM_DELETED' ? 'A chamada terminou.' : 'Você saiu da chamada.');
    return;
  }
  await closeEngine();
  scheduleRetry();
}

function awaitReason(fallback: string) {
  if (removalTimer) return;
  const g = gen;
  removalTimer = window.setTimeout(() => {
    removalTimer = 0;
    if (g === gen && get().call) endScreen(fallback);
  }, 1500);
}

function clearRemoval() {
  clearTimeout(removalTimer);
  removalTimer = 0;
}

// Novas tentativas em 1, 3, 6, 10 e 15 s; depois, a faixa "Não foi possível reconectar à chamada."
const RETRY_AT = [1000, 3000, 6000, 10000, 15000];

function scheduleRetry() {
  clearTimeout(retryTimer);
  const s = get();
  if (!s.call) return;
  if (retryStep >= RETRY_AT.length) {
    set({ failed: true, phase: 'reconnecting' });
    return;
  }
  set({ phase: 'reconnecting', failed: false });
  const wait = RETRY_AT[retryStep] - (retryStep ? RETRY_AT[retryStep - 1] : 0);
  retryStep++;
  const g = gen;
  retryTimer = window.setTimeout(() => {
    if (g === gen) void rejoin({ retrying: true });
  }, wait);
}

export function retryNow() {
  retryStep = 0;
  set({ failed: false });
  void rejoin({ retrying: true });
}

// Entra de novo na mesma chamada (queda, token recusado, outro aparelho): novo token e nova conexão.
async function rejoin(o: { retrying?: boolean; fromAway?: boolean } = {}) {
  const s = get();
  const call = s.call;
  if (!call) return;
  const g = gen;
  clearRemoval();
  let r: { call: Call; join: CallJoin };
  try {
    r = await api.post('calls.join', { callId: call._id, engines: ENGINES });
  } catch (e) {
    if (g !== gen) return;
    // "Trazer para cá" numa chamada que acabou (ou de onde saí): só o aviso; aqui eu não estava na chamada.
    if (o.fromAway) {
      toast(errorMessage(e), 'info', { icon: 'call-hangup' });
      teardown();
      set({ ...callIdle });
      return;
    }
    const status = e instanceof ApiError ? e.status : 0;
    // Chamada encerrada, removido ou sem acesso: não adianta tentar de novo.
    if (status >= 400 && status < 500 && status !== 429 && status !== 409) return endScreen(errorMessage(e));
    if (o.retrying) return scheduleRetry();
    toast(errorMessage(e), 'error');
    return;
  }
  if (g !== gen) return;
  clearRemoval();
  await closeEngine();
  stopAway();
  if (awayAt) {
    joinedAtLocal += Date.now() - awayAt;
    awayAt = 0;
  }
  markLive(call._id);
  set({ elsewhere: null, call: { ...r.call, participants: undefined }, me: { ...get().me, canPublish: r.join.canPublish, sources: r.join.sources, hidden: r.join.hidden }, maxVideo: r.join.maxVideoPublishers });
  if (r.call.participants) applyRoster(r.call);
  const { me } = get();
  // Volta como estava: a conexão anterior parou as faixas, então microfone e câmera ligados abrem de novo.
  const m = r.join.canPublish && (me.mic || me.camera) ? await openMedia({ audio: me.mic, video: me.camera, lowRes: lowResFor(r.call.participantsCount) }) : null;
  if (g !== gen) return void [m?.audio, m?.video].forEach((t) => t?.stop());
  const tracks = [m?.audio, m?.video].filter((t): t is MediaStreamTrack => !!t);
  try {
    await connectEngine(r.call, r.join, { mic: !!m?.audio, camera: !!m?.video, tracks }, g);
    retryStep = 0;
  } catch (e) {
    if (g !== gen) return;
    if (e instanceof EngineError && e.kind === 'refused') return;
    if (o.retrying) return scheduleRetry();
    toast(e instanceof EngineError && e.message ? e.message : JOIN_FAILED, 'error');
  }
}

export async function bringHere() {
  set({ elsewhere: null });
  await rejoin({ fromAway: true });
}

// Na tela "outro dispositivo": fecha aqui sem tirar o outro aparelho da chamada.
export function dismissElsewhere() {
  teardown();
  set({ ...callIdle });
}

export function dismissOtherDevice() {
  set({ otherDevice: null });
  stopAway();
}

// Enquanto a chamada está em outro aparelho (tela "outro dispositivo" ou a pílula "Trazer para cá"): os eventos do
// servidor fecham a tela quando a chamada acaba ou saio de lá; a cada 20 s confere de novo, caso um evento se perca.
function watchAway() {
  if (awayTimer) return;
  awayTimer = window.setInterval(() => {
    const s = get();
    if (!s.elsewhere && !s.otherDevice) return stopAway();
    void loadActive();
  }, 20_000);
}

function stopAway() {
  clearInterval(awayTimer);
  awayTimer = 0;
}

// A chamada de onde estou ausente acabou ou eu saí dela no outro aparelho.
function awayGone(callId: string) {
  const s = get();
  if (s.elsewhere && s.call?._id === callId) dismissElsewhere();
  if (s.otherDevice?._id === callId) dismissOtherDevice();
}

async function onRefused(status: 401 | 403 | 429) {
  if (status === 429) return endScreen(TOO_MANY);
  if (refusedOnce) return endScreen('Você precisa entrar na chamada de novo.');
  refusedOnce = true;
  await rejoin();
}

async function connectEngine(call: Call, join: CallJoin | undefined, o: { mic: boolean; camera: boolean; tracks: MediaStreamTrack[] }, g: number) {
  const eng = await createEngine(call.media, engineCtx());
  if (g !== gen) {
    for (const t of o.tracks) t.stop();
    return;
  }
  engine = eng;
  settled = call.scope === 'direct';
  engineOff = eng.on(onEngine);
  set((s) => ({ engineId: s.engineId + 1 }));
  eng.setReceiveVideo(get().view.receiveVideo);
  await eng.connect({ call, join, mic: o.mic, camera: o.camera, tracks: o.tracks });
  // Saída de áudio escolhida antes (tela de entrada ou chamada anterior).
  const out = loadChoice('out');
  if (out && g === gen) void eng.switchDevice('audiooutput', out).catch(() => {});
}

async function closeEngine() {
  const eng = engine;
  engine = null;
  engineOff?.();
  engineOff = null;
  speechOff?.();
  speechOff = null;
  since.clear();
  await eng?.disconnect().catch(() => {});
}

// Falando com o microfone desligado: um aviso com o atalho para ligar.
function armSpeechHint() {
  speechOff?.();
  speechOff = null;
  const t = engine?.micTrack();
  if (!t || get().me.hidden) return;
  speechOff = watchMutedSpeech(
    t,
    () => !get().me.mic && get().phase === 'in-call' && get().me.canPublish,
    () => toast('Você está com o microfone desligado.', 'info', { icon: 'mic-off', action: { label: 'Ligar microfone', onClick: () => void toggleMic() } }),
  );
}

// Começa a sessão: estado, motor e mídia. As faixas já abertas (tela de entrada) vão direto para o motor.
async function begin(call: Call, join: CallJoin | undefined, o: { mic: boolean; camera: boolean; tracks: MediaStreamTrack[] }) {
  clearTimeout(endTimer);
  const g = ++gen;
  joinedAtLocal = Date.now();
  awayAt = 0;
  stopAway();
  if (call.scope === 'group') markLive(call._id);
  refusedOnce = false;
  retryStep = 0;
  settled = false;
  hands.clear();
  clearPendingJoins();
  remember([call.caller, call.callee, ...call.sample]);
  const room = call.room ?? roomRefFromStore(call.rid);
  set({
    ...callIdle,
    call: { ...call, participants: undefined },
    room,
    phase: call.scope === 'direct' && call.status === 'ringing' && call.caller._id === meRef()?._id ? 'ringing-out' : 'connecting',
    me: { ...initialMe, mic: o.mic, camera: o.camera, canPublish: join?.canPublish ?? true, sources: join?.sources ?? ['microphone', 'camera', 'screen_share'], hidden: join?.hidden ?? false },
    view: { ...initialView, window: openingMode(call) },
    notice: call.guardUntil ? { kind: 'guard', until: call.guardUntil, text: '' } : null,
    maxVideo: join?.maxVideoPublishers ?? 16,
    rejoin: null,
    otherDevice: null,
    incoming: get().incoming.filter((c) => c._id !== call._id),
  });
  preWindow = openingMode(call);
  if (call.participants) applyRoster(call);
  announceCall({ callId: call._id, rid: call.rid });
  if (call.scope === 'group' && !join) {
    for (const t of o.tracks) t.stop();
    toast(JOIN_FAILED, 'error');
    void api.post('calls.leave', { callId: call._id }).catch(() => {});
    teardown();
    set({ ...callIdle });
    return;
  }
  try {
    await connectEngine(call, join, o, g);
  } catch (e) {
    if (g !== gen) return;
    if (e instanceof EngineError && e.kind === 'refused') return; // onRefused cuida
    toast(e instanceof EngineError && e.message ? e.message : JOIN_FAILED, 'error');
    if (call.scope === 'group') void api.post('calls.leave', { callId: call._id }).catch(() => {});
    else void api.post('calls.end', { callId: call._id }).catch(() => {});
    teardown();
    set({ ...callIdle });
  }
}

// Fecha tudo desta sessão (motor, toques, timers, aviso às outras abas). Não mexe na fila de toques.
function teardown() {
  gen++;
  markLive(null);
  awayAt = 0;
  void closeEngine();
  stopRing();
  clearTimeout(retryTimer);
  clearRemoval();
  clearTimeout(stableTimer);
  clearTimeout(endTimer);
  hands.clear();
  since.clear();
  clearPendingJoins();
  announceCall(null);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  if (get().incoming.length) startRing('incoming');
}

// Tela de fim (U10): 4 s na janela, depois some.
function endScreen(text: string, title = 'Chamada encerrada') {
  const s = get();
  if (!s.call) return;
  // A chamada estava em outro aparelho: a tela de fim aparece lá; aqui só fecha.
  if (s.elsewhere) return dismissElsewhere();
  const seconds = Math.round((Date.now() - joinedAtLocal) / 1000);
  teardown();
  set({ ...callIdle, phase: 'ended', view: s.view, room: s.room, ended: { title, text, seconds } });
  endTimer = window.setTimeout(() => {
    if (get().phase === 'ended') set({ ...callIdle });
  }, 4000);
}

export function dismissEnded() {
  if (get().phase === 'ended') {
    clearTimeout(endTimer);
    set({ ...callIdle });
  }
}

// ---------- Ações ----------

async function getRoom(rid: string): Promise<Room | null> {
  const r = useStore.getState().rooms[rid];
  if (r) return r;
  try {
    return ((await api.get('rooms.info', { roomId: rid })) as { room: Room }).room;
  } catch {
    return null;
  }
}

export async function openCall(rid: string, kind: CallKind): Promise<void> {
  if (get().preflight) return;
  const room = await getRoom(rid);
  if (!(await leaveFirst())) return;
  // Conversa a dois: toca na hora, como sempre (sem tela de entrada).
  if (isDirectRoom(rid, room)) return startDirect(rid, kind);
  set({ phase: isInCall() ? get().phase : 'preflight', preflight: { mode: 'start', rid, kind } });
}

export async function openJoin(callId: string, rid: string): Promise<void> {
  if (isInCall(callId)) return expandCall();
  if (get().preflight) return;
  if (!(await leaveFirst())) return;
  const known = [get().rejoin, get().otherDevice].find((c) => c?._id === callId);
  const kind = known?.kind ?? 'audio';
  set((s) => ({ phase: isInCall() ? s.phase : 'preflight', preflight: { mode: 'join', rid, kind, callId }, rejoin: s.rejoin?._id === callId ? null : s.rejoin }));
}

export function cancelPreflight() {
  set((s) => ({ preflight: null, phase: s.phase === 'preflight' ? 'idle' : s.phase }));
  leaveNext = false;
}

// Confirmou a tela de entrada: inicia ou entra, com as faixas que ela abriu.
export async function confirmPreflight(o: { mic: boolean; camera: boolean; tracks: MediaStreamTrack[] }): Promise<boolean> {
  const p = get().preflight;
  if (!p) return false;
  const leaveCurrent = leaveNext;
  let r: { call: Call; join?: CallJoin };
  try {
    if (p.mode === 'start') {
      try {
        r = await api.post('calls.start', { roomId: p.rid, kind: o.camera ? 'video' : 'audio', connectionId: realtime.connectionId, engines: ENGINES, leaveCurrent });
      } catch (e) {
        // Outra pessoa iniciou antes: entra na que já existe.
        if (!(e instanceof ApiError && e.errorType === 'error-call-exists' && e.details?.callId)) throw e;
        r = await api.post('calls.join', { callId: e.details.callId, engines: ENGINES, leaveCurrent });
        toast('Já havia uma chamada nesta sala. Você entrou nela.', 'info', { icon: 'call-live' });
      }
    } else r = await api.post('calls.join', { callId: p.callId, engines: ENGINES, leaveCurrent });
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
  leaveNext = false;
  if (leaveCurrent) await dropLocal();
  set({ preflight: null });
  await begin(r.call, r.join, o);
  return true;
}

async function startDirect(rid: string, kind: CallKind) {
  if (!realtime.connectionId) return void toast(NO_LINK, 'error');
  const m = await openMedia({ audio: true, video: kind === 'video' });
  if (!m.audio) {
    m.video?.stop();
    return void toast(m.problem === 'insecure' || m.problem === 'unsupported' ? PROBLEM_TEXT[m.problem] : NO_MIC, 'error');
  }
  const tracks = [m.audio, m.video].filter((t): t is MediaStreamTrack => !!t);
  const stop = () => tracks.forEach((t) => t.stop());
  const leaveCurrent = leaveNext;
  leaveNext = false;
  try {
    const r = (await api.post('calls.start', { roomId: rid, kind, connectionId: realtime.connectionId, engines: ENGINES, leaveCurrent })) as { call: Call; join?: CallJoin };
    if (r.call.status === 'busy') {
      stop();
      return void toast(ENDED_TEXT.busy, 'info', { icon: 'call-missed' });
    }
    if (leaveCurrent) await dropLocal();
    await begin(r.call, r.join, { mic: true, camera: !!m.video, tracks });
    if (get().phase === 'ringing-out') startRing('outgoing');
  } catch (e) {
    stop();
    toast(errorMessage(e), 'error');
  }
}

export async function acceptIncoming(callId: string, audioOnly = false): Promise<void> {
  const call = get().incoming.find((c) => c._id === callId);
  if (!call) return;
  if (!(await leaveFirst())) return;
  const leaveCurrent = leaveNext;
  leaveNext = false;
  set((s) => ({ incoming: s.incoming.filter((c) => c._id !== callId) }));
  if (!get().incoming.length) stopRing();
  const video = call.kind === 'video' && !audioOnly;
  const m = await openMedia({ audio: true, video, lowRes: call.scope === 'group' && lowResFor(call.participantsCount + 1) });
  const tracks = [m.audio, m.video].filter((t): t is MediaStreamTrack => !!t);
  if (call.scope === 'direct') {
    if (!m.audio) {
      m.video?.stop();
      toast(NO_MIC, 'error');
      return void api.post('calls.decline', { callId }).catch(() => {});
    }
    if (leaveCurrent) await dropLocal();
    // A conexão é criada antes de avisar o servidor: a oferta de quem ligou pode chegar antes da resposta.
    await begin(call, undefined, { mic: true, camera: !!m.video, tracks });
    const g = gen;
    try {
      const r = (await api.post('calls.accept', { callId, connectionId: realtime.connectionId, engines: ENGINES, leaveCurrent })) as { call: Call };
      if (g === gen && get().call?._id === r.call._id) set({ call: { ...get().call!, ...r.call } });
    } catch (e) {
      if (g !== gen) return;
      toast(errorMessage(e), 'error');
      teardown();
      set({ ...callIdle });
    }
    return;
  }
  if (m.problem && m.problem !== 'no-camera') toast(PROBLEM_TEXT[m.problem], 'warning');
  try {
    const r = (await api.post('calls.accept', { callId, engines: ENGINES, leaveCurrent })) as { call: Call; join?: CallJoin };
    if (leaveCurrent) await dropLocal();
    await begin({ ...r.call, room: r.call.room ?? call.room }, r.join, { mic: !!m.audio, camera: !!m.video, tracks });
  } catch (e) {
    for (const t of tracks) t.stop();
    toast(errorMessage(e), 'error');
  }
}

export async function declineIncoming(callId: string): Promise<void> {
  set((s) => ({ incoming: s.incoming.filter((c) => c._id !== callId) }));
  if (!get().incoming.length) stopRing();
  await api.post('calls.decline', { callId }).catch(() => {});
}

export async function leaveCall(): Promise<void> {
  const s = get();
  const call = s.call;
  if (!call) return;
  if (s.phase === 'ended') return dismissEnded();
  const seconds = Math.round((Date.now() - joinedAtLocal) / 1000);
  teardown();
  set({ ...callIdle });
  if (call.scope === 'direct') {
    await api.post('calls.end', { callId: call._id }).catch(() => {});
    return;
  }
  toast(`Você saiu da chamada · ${formatCallDuration(seconds)}`, 'info', { icon: 'call-hangup' });
  await api.post('calls.leave', { callId: call._id }).catch(() => {});
}

export async function endForAll(): Promise<void> {
  const call = get().call;
  if (!call) return;
  const ok = await confirmInCall({ title: 'Encerrar a chamada para todos?', body: 'Todos saem da chamada agora.', confirmLabel: 'Encerrar para todos', danger: true });
  if (!ok || get().call?._id !== call._id) return;
  try {
    const r = (await api.post('calls.end', { callId: call._id })) as { call: Call };
    if (get().call?._id === call._id) endScreen(callEndedReasonText(r.call.endedReason, meRef()) || 'A chamada terminou.');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function blockedText(source: CallSource): string | null {
  const s = get();
  if (s.me.canPublish && s.me.sources.includes(source)) return null;
  if (s.call?.guardUntil) return GUARD_PAUSED;
  if (source === 'screen_share' && s.screenBlockedUntil && s.screenBlockedUntil > Date.now()) return SCREEN_BLOCKED;
  return s.call?.scope === 'group' ? 'Você não pode fazer isso nesta chamada agora.' : null;
}

export function micBlocked(): string | null {
  return get().call?.scope === 'group' ? blockedText('microphone') : null;
}

export function cameraBlocked(): string | null {
  const s = get();
  if (s.call?.scope !== 'group') return null;
  const b = blockedText('camera');
  if (b) return b;
  const others = Object.values(s.peers).filter((p) => !p.isMe);
  if (!s.me.camera && cameraLimitReached(others, s.maxVideo)) return `Limite de ${s.maxVideo} câmeras ligadas nesta chamada.`;
  return null;
}

export function screenBlocked(): string | null {
  const s = get();
  if (s.screenBlockedUntil && s.screenBlockedUntil > Date.now()) return SCREEN_BLOCKED;
  if (s.call?.scope !== 'group') return null;
  const b = blockedText('screen_share');
  if (b) return b;
  const sharer = Object.values(s.peers).find((p) => !p.isMe && p.screen);
  if (sharer && !s.me.screen) return `@${sharer.user?.username ?? 'alguém'} está compartilhando a tela.`;
  return null;
}

export async function toggleMic(): Promise<void> {
  const s = get();
  if (!engine || !s.call) return;
  const on = !s.me.mic;
  const blocked = on ? micBlocked() : null;
  if (blocked) return void toast(blocked, 'warning');
  set({ me: { ...s.me, mic: on }, ptt: false });
  announce(on ? 'Microfone ligado' : 'Microfone desligado');
  try {
    await engine.setMic(on);
  } catch (e) {
    set({ me: { ...get().me, mic: !on } });
    toast(PROBLEM_TEXT[problemOf(e)] ?? NO_MIC, 'error');
  }
  armSpeechHint();
}

export async function toggleCamera(): Promise<void> {
  const s = get();
  if (!engine || !s.call) return;
  const on = !s.me.camera;
  const blocked = on ? cameraBlocked() : null;
  if (blocked) return void toast(blocked, 'warning');
  set({ me: { ...s.me, camera: on } });
  announce(on ? 'Câmera ligada' : 'Câmera desligada');
  try {
    await engine.setCamera(on);
  } catch (e) {
    set({ me: { ...get().me, camera: !on } });
    const p = problemOf(e);
    toast(p === 'no-mic' ? PROBLEM_TEXT['no-camera'] : PROBLEM_TEXT[p], 'error');
  }
}

export async function toggleScreen(o?: { tabAudio?: boolean }): Promise<void> {
  const s = get();
  if (!engine || !s.call) return;
  const on = !s.me.screen;
  const blocked = on ? screenBlocked() : null;
  if (blocked) return void toast(blocked, 'warning');
  try {
    await engine.setScreen(on, { tabAudio: !!o?.tabAudio });
    if (on) set({ me: { ...get().me, tabAudio: !!o?.tabAudio } });
  } catch {
    toast('Não foi possível compartilhar a tela.', 'error');
  }
}

export async function toggleHand(): Promise<void> {
  const s = get();
  if (!s.call || s.call.scope !== 'group') return;
  const raised = !s.me.handAt;
  try {
    const r = (await api.post('calls.hand', { callId: s.call._id, raised })) as { handAt: string | null };
    applyHand(meRef()!._id, r.handAt);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function applyHand(userId: string, at: string | null) {
  const t = at ? Date.parse(at) : null;
  if (t) hands.set(userId, t);
  else hands.delete(userId);
  set((s) => {
    const p = s.peers[userId];
    const isMe = userId === meRef()?._id;
    return {
      peers: p ? { ...s.peers, [userId]: { ...p, handAt: t } } : s.peers,
      me: isMe ? { ...s.me, handAt: t } : s.me,
      roster: s.roster.map((r) => (r.user._id === userId ? { ...r, handAt: at } : r)),
    };
  });
}

const SKIP_TEXT: Record<string, (u: string) => string> = {
  'not-member': (u) => `@${u} não é membro desta sala.`,
  inactive: (u) => `@${u} não pode receber chamadas.`,
  present: (u) => `@${u} já está na chamada.`,
  busy: (u) => `@${u} está em outra chamada.`,
  restricted: (u) => `@${u} não pode entrar agora pela política da empresa.`,
  removed: (u) => `@${u} foi removido desta chamada por um moderador.`,
};

export async function ringPeople(userIds: string[]): Promise<void> {
  const call = get().call;
  if (!call || !userIds.length) return;
  try {
    const r = (await api.post('calls.ring', { callId: call._id, userIds })) as { rung: UserRef[]; skipped: { user: UserRef; reason: string }[] };
    remember([...r.rung, ...r.skipped.map((x) => x.user)]);
    if (r.rung.length) toast(`Chamando ${callPeopleLabel(r.rung.length)}.`, 'info', { icon: 'call-ring' });
    for (const x of r.skipped.slice(0, 3)) toast((SKIP_TEXT[x.reason] ?? SKIP_TEXT.inactive)(x.user.username), 'warning');
    void refreshRoster();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function inviteRoom(): Promise<void> {
  const call = get().call;
  if (!call) return;
  try {
    const r = (await api.post('calls.invite', { callId: call._id })) as { notified: number };
    toast(r.notified ? `Avisamos ${callPeopleLabel(r.notified)} na sala.` : 'Ninguém mais da sala está online agora.', 'info', { icon: 'announcement' });
    // O próximo aviso só daqui a 10 min: o servidor recalcula canInvite.
    set((s) => (s.call?.mine ? { call: { ...s.call, mine: { ...s.call.mine, canInvite: false } } } : {}));
    invitedAt = Date.now();
  } catch (e) {
    toast(errorMessage(e), e instanceof ApiError && e.status === 429 ? 'warning' : 'error');
  }
}

let invitedAt = 0;
export function inviteWaitMinutes(): number {
  if (!invitedAt) return 0;
  return Math.max(0, Math.ceil((invitedAt + CALL_LIMITS.inviteEveryMinutes * 60_000 - Date.now()) / 60_000));
}

export async function moderate(userId: string, action: CallModerationAction): Promise<void> {
  const call = get().call;
  if (!call) return;
  if (action === 'remove') {
    const nome = label(users.get(userId) ?? get().peers[userId]?.user);
    const ok = await confirmInCall({ title: `Remover ${nome} da chamada?`, body: 'A pessoa só volta se um moderador chamar de novo.', confirmLabel: 'Remover', danger: true });
    if (!ok) return;
  }
  try {
    await api.post('calls.moderate', { callId: call._id, userId, action });
    if (action === 'lowerHand') applyHand(userId, null);
    void refreshRoster();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function switchDevice(kind: MediaDeviceKind, deviceId: string) {
  try {
    await engine?.switchDevice(kind, deviceId);
    if (kind === 'audioinput') armSpeechHint();
  } catch (e) {
    toast(PROBLEM_TEXT[problemOf(e)], 'error');
  }
}

export async function unblockAudio() {
  await engine?.startAudio();
}

export function togglePin(id: string) {
  const v = get().view;
  set({ view: { ...v, pinned: v.pinned === id ? null : id } });
}

export function dismissRejoin() {
  set({ rejoin: null });
}

// ---------- Eventos do servidor ----------

function notifyHidden(title: string, body: string, tag: string) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png', tag });
    n.onclick = () => (window.focus(), n.close());
  } catch {
    // notificações indisponíveis
  }
}

function pushIncoming(call: Call) {
  if (get().incoming.some((c) => c._id === call._id) || get().call?._id === call._id) return;
  set((s) => ({ incoming: [...s.incoming, call] }));
  startRing('incoming');
}

function dropIncoming(callId: string) {
  if (!get().incoming.some((c) => c._id === callId)) return;
  set((s) => ({ incoming: s.incoming.filter((c) => c._id !== callId) }));
  if (!get().incoming.length && get().phase !== 'ringing-out') stopRing();
}

function onDirectCall(call: Call) {
  const me = meRef()?._id;
  if (!me || (call.caller._id !== me && call.callee?._id !== me)) return;
  const s = get();
  // Tocando para mim (em todos os meus aparelhos, enquanto ninguém atende).
  if (call.callee?._id === me && call.status === 'ringing') {
    if (s.call && s.call._id !== call._id && s.call.scope === 'direct') return; // já estou em outra chamada a dois aqui
    if (!s.incoming.some((c) => c._id === call._id)) {
      pushIncoming(call);
      notifyHidden(call.caller.name || call.caller.username, call.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz', `call-${call._id}`);
    }
    return;
  }
  dropIncoming(call._id);
  if (s.call?._id !== call._id) return;
  if (call.status === 'ongoing') {
    set({ call: { ...s.call, ...call } });
    if (s.phase === 'ringing-out') {
      stopRing();
      set({ phase: 'connecting' });
    }
    return;
  }
  if (call.status !== 'ringing') {
    teardown();
    set({ ...callIdle });
    // Fim de chamada não é um aviso genérico: o ícone é o do telefone.
    toast(ENDED_TEXT[call.status] ?? 'Chamada encerrada.', 'info', { icon: call.status === 'missed' || call.status === 'busy' ? 'call-missed' : 'call-hangup' });
  }
}

function onGroupCall(call: Call) {
  const s = get();
  const mine = call.mine;
  // Fora daqui: a chamada acabou ou saí dela no outro aparelho.
  if (call.status !== 'ongoing' || mine?.state === 'left') awayGone(call._id);
  if (s.call?._id !== call._id) {
    if (call.status !== 'ongoing') dropIncoming(call._id);
    return;
  }
  if (s.elsewhere) return;
  if (call.status === 'ended') return endScreen(callEndedReasonText(call.endedReason) || 'A chamada terminou.');
  if (mine?.state === 'left' && s.phase !== 'ended') {
    // O texto de quem removeu chega pelo call.notice: espera um pouco por ele.
    if (mine.leftReason === 'removed') {
      void closeEngine();
      awaitReason('Você foi removido da chamada.');
      return;
    }
    if (mine.leftReason === 'ended' || mine.leftReason === 'room' || mine.leftReason === 'deactivated') return endScreen(callEndedReasonText(call.endedReason) || 'A chamada terminou.');
  }
  set({ call: { ...s.call, ...call, participants: undefined } });
  if (mine?.handAt !== undefined) applyHand(meRef()!._id, mine.handAt);
}

function onNotice(callId: string, n: CallNotice) {
  const s = get();
  if (s.call?._id !== callId) return;
  // Na tela "outro dispositivo" os avisos são do outro aparelho; só o fim da chamada (ou a remoção) fecha a tela aqui.
  if (s.elsewhere) {
    if (n.kind === 'ended' || (n.kind === 'moderated' && n.action === 'remove')) dismissElsewhere();
    return;
  }
  announce(n.text);
  switch (n.kind) {
    case 'guard':
      set({ notice: n, call: { ...s.call, guardUntil: n.until } });
      return;
    case 'guard-cleared':
      set({ notice: null, call: { ...s.call, guardUntil: null } });
      toast(n.text, 'success');
      return;
    case 'host':
      toast(n.text, 'info');
      void refreshRoster();
      return;
    case 'moderated':
      if (n.action === 'remove') {
        clearRemoval();
        return endScreen(n.text);
      }
      if (n.action === 'stopVideo' && /compartilhamento/.test(n.text)) set({ screenBlockedUntil: Date.now() + CALL_LIMITS.screenBlockSeconds * 1000 });
      toast(n.text, 'warning');
      set({ notice: n });
      return;
    case 'refused':
      clearRemoval();
      if (!refusedOnce) {
        refusedOnce = true;
        void rejoin();
      } else endScreen(n.text);
      return;
    case 'ended':
      clearRemoval();
      endScreen(n.text || 'A chamada terminou.');
      return;
  }
}

function onHand(callId: string, userId: string, at: string | null) {
  const s = get();
  if (s.call?._id !== callId) return;
  const before = s.peers[userId]?.handAt ?? hands.get(userId) ?? null;
  applyHand(userId, at);
  if (!at || before || userId === meRef()?._id) return;
  // Acima de 8 pessoas, só o anfitrião e os moderadores veem cada mão.
  if (quiet() && !(s.call.mine?.host || s.call.mine?.canModerate)) return;
  const text = `${label(users.get(userId) ?? s.peers[userId]?.user)} levantou a mão`;
  toast(text, 'info', { icon: 'call-hand' });
  announce(text);
  chime('hand');
}

function currentRoomId(): string | null {
  const m = location.pathname.match(/^\/(?:direct|group|channel)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

let started = false;
let configTimer = 0;

async function loadConfig() {
  try {
    const c = (await api.get('calls.config')) as CallsConfig;
    set({ config: c });
    noteServerTime(c.serverTime);
  } catch {
    // tenta de novo na próxima reconexão
  }
}

// Ao abrir (ou reconectar): toques pendentes e chamadas de onde caí ou que ficaram abertas numa recarga.
async function loadActive() {
  try {
    const r = (await api.get('calls.active')) as { calls: Call[] };
    const me = meRef()?._id;
    const s = get();
    const here = liveHere();
    let rejoin: Call | null = null;
    let other: Call | null = null;
    let awayLive = false;
    for (const c of r.calls) {
      const mine = c.mine;
      if (c.status !== 'ongoing' && c.status !== 'ringing') continue;
      if (c.scope === 'group' && mine?.state === 'ringing' && !s.incoming.some((x) => x._id === c._id) && !isInCall(c._id)) pushIncoming(c);
      if (c.scope === 'direct' && c.status === 'ringing' && c.callee?._id === me) onDirectCall(c);
      const present = (mine?.state === 'joined' || mine?.state === 'joining') && c.scope === 'group';
      if (present && s.elsewhere && s.call?._id === c._id) awayLive = true;
      if (isInCall(c._id) || s.tabCall?.callId === c._id || c.scope !== 'group') continue;
      const dropped = mine?.leftReason === 'disconnected' && mine.state === 'left';
      // Presente sem estar aqui: depois de recarregar esta aba, é o "Voltar"; senão estou nela em outro aparelho.
      if (dropped || (present && here === c._id)) rejoin = c;
      else if (present) other = c;
    }
    if (s.elsewhere && !awayLive) dismissElsewhere();
    if (!isInCall()) set({ rejoin, otherDevice: other });
    if (other) watchAway();
  } catch {
    // sem chamadas por agora
  }
}

function onEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'connected':
      if (!started) return;
      void loadActive();
      clearTimeout(configTimer);
      configTimer = window.setTimeout(() => void loadConfig(), 500);
      return;
    case 'call':
      if (ev.call.scope === 'group') onGroupCall(ev.call);
      else onDirectCall(ev.call);
      return;
    case 'call.ring': {
      const c = ev.call;
      if (ev.action === 'ring') {
        if (isInCall(c._id)) return;
        if (ev.by) {
          remember([ev.by]);
          set((s) => ({ ringBy: { ...s.ringBy, [c._id]: ev.by! } }));
        }
        pushIncoming(c);
        notifyHidden(`Chamada em ${callRoomName(c.room ?? roomRefFromStore(c.rid))}`, `@${ev.by?.username ?? c.caller.username} está chamando você`, `call-${c._id}`);
      } else dropIncoming(c._id);
      return;
    }
    case 'call.notice':
      return onNotice(ev.callId, ev.notice);
    case 'call.hand':
      return onHand(ev.callId, ev.userId, ev.at);
    case 'call.prompt':
      if (document.hasFocus() && currentRoomId() === ev.rid) void openCall(ev.rid, ev.kind);
      return;
    case 'call.room': {
      const s = get();
      if (ev.call && s.call?._id === ev.call._id) {
        remember(ev.call.sample);
        set({ call: { ...s.call, participantsCount: ev.call.participantsCount, sample: ev.call.sample, guardUntil: ev.call.guardUntil, guard: ev.call.guard, peak: ev.call.peak } });
      }
      // A chamada de onde caí acabou: some o "Voltar" (e a tela ou a pílula do outro aparelho).
      if (!ev.call && s.rejoin?.rid === ev.rid) set({ rejoin: null });
      if (!ev.call && s.otherDevice?.rid === ev.rid) awayGone(s.otherDevice._id);
      if (!ev.call && s.elsewhere && s.call?.rid === ev.rid) dismissElsewhere();
      return;
    }
  }
}

// Instala os ouvintes uma vez (ao carregar o módulo, com a sessão já aberta ou não).
export function startCallStore() {
  if (started) return;
  started = true;
  realtime.on(onEvent);
  watchTabs((c) => set((s) => ({ tabCall: c, rejoin: c && s.rejoin?._id === c.callId ? null : s.rejoin })));
  watchDevices(
    () => {},
    (kind) => {
      if (!isInCall() || kind === 'out') return;
      toast(UNPLUGGED[kind], 'warning');
      void switchDevice(kind === 'mic' ? 'audioinput' : 'videoinput', '');
    },
  );
  installShortcuts({
    active: () => isInCall() && !get().elsewhere && get().phase !== 'ringing-out',
    pttAllowed: () => get().view.window === 'big',
    mic: () => void toggleMic(),
    camera: () => {
      const s = get();
      // Na chamada a dois de voz não há câmera para ligar.
      if (s.call?.scope === 'direct' && !s.me.camera && s.call.kind === 'audio') return;
      void toggleCamera();
    },
    hand: () => void toggleHand(),
    pttDown: () => {
      const s = get();
      if (s.me.mic || !engine || micBlocked()) return;
      set({ ptt: true, me: { ...s.me, mic: true } });
      void engine.setMic(true);
    },
    pttUp: () => {
      const s = get();
      if (!s.ptt || !engine) return;
      set({ ptt: false, me: { ...s.me, mic: false } });
      void engine.setMic(false);
    },
  });
  useCallStore.subscribe((s, prev) => {
    const video = s.me.camera || s.me.screen || Object.values(s.peers).some((p) => p.camera || p.screen);
    if (s.phase !== prev.phase || s.peers !== prev.peers || s.me !== prev.me) keepAwake((s.phase === 'in-call' || s.phase === 'reconnecting') && video);
  });
  if (useStore.getState().me) {
    // As outras abas respondem ao "quem está em chamada?" antes de oferecer o "Voltar".
    window.setTimeout(() => void loadActive(), 400);
    void loadConfig();
  }
}
