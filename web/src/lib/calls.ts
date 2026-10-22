// Chamadas de voz e vídeo em DMs: estado da chamada, mídia local/remota e WebRTC (sinalização pelo WebSocket).
import { create } from 'zustand';
import type { Call, CallKind, CallSignal, ServerEvent } from '@shared/index';
import { api, errorMessage } from './api';
import { realtime } from './realtime';
import { useStore } from './store';

interface CallState {
  call: Call | null; // chamada deste dispositivo (tocando para o outro lado ou em andamento)
  incoming: Call | null; // tocando para mim
  local: MediaStream | null;
  remote: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  connected: boolean;
}

const initial: CallState = { call: null, incoming: null, local: null, remote: null, muted: false, cameraOff: false, sharing: false, connected: false };
export const useCalls = create<CallState>(() => initial);

let pc: RTCPeerConnection | null = null;
let pending: RTCIceCandidateInit[] = [];
let cameraTrack: MediaStreamTrack | null = null;
let iceServers: RTCIceServer[] | null = null;

const toast = (t: string, kind?: 'error') => useStore.getState().toast(t, kind);
const myId = () => useStore.getState().me?._id;

// ---------- Toque (WebAudio, sem arquivo de som) ----------

let ringTimer: number | null = null;
let audioCtx: AudioContext | null = null;
function tone(freqs: number[], ms: number, gain = 0.06) {
  try {
    audioCtx ??= new AudioContext();
    const g = audioCtx.createGain();
    g.gain.value = gain;
    g.connect(audioCtx.destination);
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start();
      o.stop(audioCtx.currentTime + ms / 1000);
    }
  } catch {
    // sem áudio disponível
  }
}
function startRing(kind: 'incoming' | 'outgoing') {
  stopRing();
  const play = () => (kind === 'incoming' ? tone([440, 480], 1200, 0.08) : tone([425], 900, 0.03));
  play();
  ringTimer = window.setInterval(play, kind === 'incoming' ? 3000 : 4000);
}
function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

// ---------- Mídia e conexão ----------

async function getIceServers() {
  if (!iceServers) iceServers = ((await api.get('calls.config')) as { iceServers: RTCIceServer[] }).iceServers;
  return iceServers;
}

async function openMedia(kind: CallKind) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
  } catch (e) {
    // Sem câmera (ou câmera negada): segue só com o microfone.
    if (kind === 'video') return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    throw e;
  }
}

function signal(callId: string, data: CallSignal) {
  realtime.send({ type: 'call.signal', callId, data });
}

async function createPeer(call: Call, local: MediaStream, isCaller: boolean) {
  const servers = await getIceServers();
  const conn = new RTCPeerConnection({ iceServers: servers });
  pc = conn;
  pending = [];
  for (const t of local.getTracks()) conn.addTrack(t, local);
  // Chamada de voz: a oferta já inclui vídeo, para o compartilhamento de tela de qualquer lado.
  if (isCaller && !local.getVideoTracks().length) conn.addTransceiver('video', { direction: 'recvonly' });
  conn.ontrack = (e) => useCalls.setState({ remote: e.streams[0] ?? new MediaStream([e.track]) });
  conn.onicecandidate = (e) => signal(call._id, { candidate: e.candidate ? (e.candidate.toJSON() as Record<string, unknown>) : null });
  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    if (conn.connectionState === 'connected') useCalls.setState({ connected: true });
    if (conn.connectionState === 'failed') {
      toast('A conexão da chamada caiu.', 'error');
      void hangup();
    }
  };
  return conn;
}

async function flushCandidates() {
  if (!pc?.remoteDescription) return;
  for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
}

async function onSignal(callId: string, data: CallSignal) {
  const st = useCalls.getState();
  if (!pc || st.call?._id !== callId) return;
  if ('sdp' in data) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal(callId, { sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
    }
    await flushCandidates();
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate as RTCIceCandidateInit).catch(() => {});
    else pending.push(data.candidate as RTCIceCandidateInit);
  }
}

function cleanup() {
  stopRing();
  const st = useCalls.getState();
  for (const t of st.local?.getTracks() ?? []) t.stop();
  cameraTrack?.stop();
  cameraTrack = null;
  pc?.close();
  pc = null;
  pending = [];
  useCalls.setState({ ...initial, incoming: st.incoming && st.incoming._id !== st.call?._id ? st.incoming : null });
}

const ENDED_TEXT: Record<string, string> = {
  declined: 'Chamada recusada.',
  missed: 'Sem resposta.',
  busy: 'A pessoa está em outra chamada.',
  canceled: 'Chamada cancelada.',
  ended: 'Chamada encerrada.',
};

// ---------- Ações ----------

export async function startCall(rid: string, kind: CallKind) {
  if (useCalls.getState().call) return toast('Você já está em uma chamada.', 'error');
  if (!realtime.connectionId) return toast('Sem conexão com o servidor. Tente de novo em instantes.', 'error');
  let local: MediaStream;
  try {
    local = await openMedia(kind);
  } catch {
    return toast('Não foi possível usar o microfone. Confira a permissão do navegador.', 'error');
  }
  try {
    const { call } = (await api.post('calls.start', { roomId: rid, kind, connectionId: realtime.connectionId })) as { call: Call };
    if (call.status === 'busy') {
      for (const t of local.getTracks()) t.stop();
      return toast(ENDED_TEXT.busy);
    }
    useCalls.setState({ call, local, cameraOff: !local.getVideoTracks().length });
    startRing('outgoing');
  } catch (e) {
    for (const t of local.getTracks()) t.stop();
    toast(errorMessage(e), 'error');
  }
}

export async function acceptCall(audioOnly = false) {
  const incoming = useCalls.getState().incoming;
  if (!incoming) return;
  stopRing();
  let local: MediaStream;
  try {
    local = await openMedia(audioOnly ? 'audio' : incoming.kind);
  } catch {
    toast('Não foi possível usar o microfone. Confira a permissão do navegador.', 'error');
    return declineCall();
  }
  // A conexão é criada antes de avisar o servidor: a oferta de quem ligou pode chegar antes da resposta.
  useCalls.setState({ call: incoming, incoming: null, local, cameraOff: !local.getVideoTracks().length });
  await createPeer(incoming, local, false);
  try {
    const { call } = (await api.post('calls.accept', { callId: incoming._id, connectionId: realtime.connectionId })) as { call: Call };
    if (useCalls.getState().call?._id === call._id) useCalls.setState({ call });
  } catch (e) {
    toast(errorMessage(e), 'error');
    cleanup();
  }
}

export async function declineCall() {
  const incoming = useCalls.getState().incoming;
  if (!incoming) return;
  stopRing();
  useCalls.setState({ incoming: null });
  await api.post('calls.decline', { callId: incoming._id }).catch(() => {});
}

export async function hangup() {
  const call = useCalls.getState().call;
  cleanup();
  if (call) await api.post('calls.end', { callId: call._id }).catch(() => {});
}

export function toggleMute() {
  const { local, muted } = useCalls.getState();
  for (const t of local?.getAudioTracks() ?? []) t.enabled = muted;
  useCalls.setState({ muted: !muted });
}

export function toggleCamera() {
  const { local, cameraOff, sharing } = useCalls.getState();
  if (sharing) return;
  for (const t of local?.getVideoTracks() ?? []) t.enabled = cameraOff;
  useCalls.setState({ cameraOff: !cameraOff });
}

// Compartilha a tela no lugar da câmera (ou acrescenta vídeo numa chamada de voz).
export async function toggleScreenShare() {
  const st = useCalls.getState();
  if (!pc || !st.local) return;
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video') ?? pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
  if (st.sharing) {
    const screen = st.local.getVideoTracks()[0];
    await sender?.replaceTrack(cameraTrack);
    screen?.stop();
    if (screen) st.local.removeTrack(screen);
    if (cameraTrack) st.local.addTrack(cameraTrack);
    cameraTrack = null;
    useCalls.setState({ sharing: false, local: new MediaStream(st.local.getTracks()) });
    return;
  }
  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }
  const screen = display.getVideoTracks()[0];
  cameraTrack = st.local.getVideoTracks()[0] ?? null;
  if (cameraTrack) st.local.removeTrack(cameraTrack);
  st.local.addTrack(screen);
  if (sender) {
    // Transceptor só de recebimento (chamada de voz) passa a enviar.
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    if (tr && tr.direction === 'recvonly') {
      tr.direction = 'sendrecv';
      await sender.replaceTrack(screen);
      await renegotiate();
    } else await sender.replaceTrack(screen);
  }
  screen.onended = () => void (useCalls.getState().sharing && toggleScreenShare());
  useCalls.setState({ sharing: true, local: new MediaStream(st.local.getTracks()) });
}

async function renegotiate() {
  const call = useCalls.getState().call;
  if (!pc || !call) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal(call._id, { sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
}

// ---------- Eventos do servidor ----------

async function onCall(call: Call) {
  const me = myId();
  if (!me || (call.caller._id !== me && call.callee._id !== me)) return;
  const st = useCalls.getState();
  // Tocando para mim (em todos os meus dispositivos, enquanto ninguém atende).
  if (call.callee._id === me && call.status === 'ringing') {
    if (st.call) return; // já estou em outra chamada neste dispositivo
    if (st.incoming?._id !== call._id) {
      useCalls.setState({ incoming: call });
      startRing('incoming');
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(call.caller.name || call.caller.username, { body: call.kind === 'video' ? '🎥 Chamada de vídeo' : '📞 Chamada de voz', tag: `call-${call._id}` });
        n.onclick = () => (window.focus(), n.close());
      }
    }
    return;
  }
  if (st.incoming?._id === call._id) {
    stopRing();
    useCalls.setState({ incoming: null });
  }
  if (st.call?._id !== call._id) return;
  if (call.status === 'ongoing') {
    useCalls.setState({ call });
    // Quem ligou cria a oferta quando o outro lado atende (neste dispositivo).
    if (call.caller._id === me && call.callerConnectionId === realtime.connectionId && !pc && st.local) {
      stopRing();
      const conn = await createPeer(call, st.local, true);
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      signal(call._id, { sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
    }
    return;
  }
  if (call.status !== 'ringing') {
    cleanup();
    toast(ENDED_TEXT[call.status] ?? 'Chamada encerrada.');
  }
}

realtime.on((ev: ServerEvent) => {
  if (ev.type === 'call') void onCall(ev.call);
  if (ev.type === 'call.signal') void onSignal(ev.callId, ev.data).catch(() => {});
});
