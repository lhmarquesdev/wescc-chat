// Motor P2P da chamada a dois: a mesma conexão de sempre (sinalização pelo WebSocket, candidatos guardados até a
// descrição remota, tela no lugar da câmera com replaceTrack e renegociação), agora atrás do contrato CallEngine.
import type { Call, CallsConfig, CallSignal, ServerEvent, UserRef } from '@shared/index';
import { api } from '../api';
import { realtime } from '../realtime';
import { createMeter, openTrack, SPEECH_LEVEL, type Meter } from './devices';
import { emitter, peerBatcher, type CallEngine, type EngineContext } from './engine';
import type { LivePeer } from './store';

let iceServers: RTCIceServer[] | null = null;

async function getIceServers() {
  if (!iceServers) iceServers = ((await api.get('calls.config')) as CallsConfig).iceServers as RTCIceServer[];
  return iceServers;
}

export function createP2pEngine(ctx: EngineContext): CallEngine {
  const ev = emitter();
  let call: Call | null = null;
  let pc: RTCPeerConnection | null = null;
  let pending: RTCIceCandidateInit[] = [];
  let mic: MediaStreamTrack | null = null;
  let camera: MediaStreamTrack | null = null; // câmera (guardada enquanto a tela está no lugar dela)
  let screen: MediaStreamTrack | null = null;
  let micOn = false;
  let cameraOn = false;
  let remote: MediaStream | null = null;
  let connected = false;
  let closed = false;
  let joinedAt = Date.now();
  let speaking: string[] = [];
  let meter: Meter | null = null;
  let poll = 0;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.className = 'call-hidden';
  audio.setAttribute('aria-hidden', 'true');
  const views = new Map<HTMLMediaElement, { peer: string; source: 'camera' | 'screen' | 'audio' }>();

  const other = (): UserRef | null => (call ? (call.caller._id === ctx.me._id ? call.callee : call.caller) : null);
  const remoteVideo = () => remote?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;

  const peers = (): LivePeer[] => {
    const o = other();
    const list: LivePeer[] = [
      {
        id: ctx.me._id,
        user: ctx.me,
        isMe: true,
        mic: micOn && !!mic,
        camera: cameraOn && !!camera && !screen,
        screen: !!screen,
        speaking: speaking.includes(ctx.me._id),
        lastSpokeAt: null,
        handAt: null,
        quality: 'unknown',
        canPublish: true,
        joinedAt,
      },
    ];
    if (o)
      list.push({
        id: o._id,
        user: o,
        isMe: false,
        mic: true,
        camera: !!remoteVideo(),
        screen: false,
        speaking: speaking.includes(o._id),
        lastSpokeAt: null,
        handAt: null,
        quality: connected ? 'good' : 'unknown',
        canPublish: true,
        joinedAt: joinedAt + 1,
      });
    return list;
  };
  const batch = peerBatcher(peers, ev.emit);

  // Elementos de vídeo ligados a uma pessoa: trocam de faixa quando a câmera, a tela ou o outro lado mudam.
  function refresh() {
    for (const [el, v] of views) {
      const track = v.peer === ctx.me._id ? (screen ?? (cameraOn ? camera : null)) : remoteVideo();
      const cur = (el.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null;
      if (cur !== track) el.srcObject = track ? new MediaStream([track]) : null;
    }
    batch.schedule();
  }

  function signal(data: CallSignal) {
    if (call) realtime.send({ type: 'call.signal', callId: call._id, data });
  }

  function localTracks() {
    return [mic, screen ?? camera].filter((t): t is MediaStreamTrack => !!t);
  }

  async function createPeer(isCaller: boolean) {
    const servers = await getIceServers();
    if (closed) return null;
    const conn = new RTCPeerConnection({ iceServers: servers });
    pc = conn;
    pending = [];
    const stream = new MediaStream(localTracks());
    for (const t of stream.getTracks()) conn.addTrack(t, stream);
    // Chamada de voz: a oferta já inclui vídeo, para o compartilhamento de tela de qualquer lado.
    if (isCaller && !stream.getVideoTracks().length) conn.addTransceiver('video', { direction: 'recvonly' });
    conn.ontrack = (e) => {
      remote = e.streams[0] ?? new MediaStream([e.track]);
      if (audio.srcObject !== remote) audio.srcObject = remote;
      void audio.play().then(
        () => ev.emit({ type: 'audio-blocked', blocked: false }),
        () => ev.emit({ type: 'audio-blocked', blocked: true }),
      );
      e.track.onunmute = refresh;
      e.track.onmute = refresh;
      e.track.onended = refresh;
      refresh();
    };
    conn.onicecandidate = (e) => signal({ candidate: e.candidate ? (e.candidate.toJSON() as Record<string, unknown>) : null });
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      if (conn.connectionState === 'connected' && !connected) {
        connected = true;
        ev.emit({ type: 'state', state: 'connected' });
        batch.schedule();
      }
      if (conn.connectionState === 'failed') ev.emit({ type: 'state', state: 'disconnected', reason: 'failed' });
    };
    startSpeaking();
    return conn;
  }

  // Quem fala: nível do áudio recebido (getSynchronizationSources) e o do meu microfone, a cada 250 ms.
  function startSpeaking() {
    if (poll) return;
    poll = window.setInterval(() => {
      const ids: string[] = [];
      const o = other();
      const r = pc?.getReceivers().find((x) => x.track.kind === 'audio');
      const lvl = r?.getSynchronizationSources?.()[0]?.audioLevel ?? 0;
      if (o && lvl > 0.05) ids.push(o._id);
      if (micOn && meter && meter.level() > SPEECH_LEVEL) ids.push(ctx.me._id);
      if (ids.join() !== speaking.join()) {
        speaking = ids;
        ev.emit({ type: 'speaking', ids });
        batch.schedule();
      }
    }, 250);
  }

  async function flushCandidates() {
    if (!pc?.remoteDescription) return;
    for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  }

  async function onSignal(data: CallSignal) {
    if (!pc) return;
    if ('sdp' in data) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal({ sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
      }
      await flushCandidates();
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate as RTCIceCandidateInit).catch(() => {});
      else pending.push(data.candidate as RTCIceCandidateInit);
    }
  }

  async function offer() {
    if (!pc || !call) return;
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    signal({ sdp: { type: 'offer', sdp: o.sdp ?? '' } });
  }

  // Quem ligou cria a oferta quando o outro lado atende (neste aparelho).
  async function maybeOffer(c: Call) {
    if (pc || closed || c.status !== 'ongoing' || c.caller._id !== ctx.me._id || c.callerConnectionId !== realtime.connectionId) return;
    const conn = await createPeer(true);
    if (conn) await offer();
  }

  const off = realtime.on((e: ServerEvent) => {
    if (!call) return;
    if (e.type === 'call.signal' && e.callId === call._id) void onSignal(e.data).catch(() => {});
    if (e.type === 'call' && e.call._id === call._id) {
      call = e.call;
      void maybeOffer(e.call);
    }
  });

  function stopAll() {
    for (const t of [mic, camera, screen]) t?.stop();
    mic = camera = screen = null;
  }

  const engine: CallEngine = {
    media: 'p2p',
    async connect(o) {
      call = o.call;
      joinedAt = Date.now();
      for (const t of o.tracks ?? []) {
        if (t.kind === 'audio') mic = t;
        else camera = t;
      }
      micOn = o.mic && !!mic;
      cameraOn = o.camera && !!camera;
      if (mic) {
        mic.enabled = micOn;
        meter = createMeter(mic);
      }
      if (camera) camera.enabled = cameraOn;
      document.body.appendChild(audio);
      ev.emit({ type: 'state', state: 'connecting' });
      refresh();
      // A conexão de quem atende é criada antes de avisar o servidor: a oferta pode chegar antes da resposta.
      if (call.caller._id !== ctx.me._id) await createPeer(false);
      else await maybeOffer(call);
    },
    async disconnect() {
      closed = true;
      off();
      batch.cancel();
      clearInterval(poll);
      meter?.stop();
      stopAll();
      pc?.close();
      pc = null;
      audio.srcObject = null;
      audio.remove();
      for (const el of views.keys()) el.srcObject = null;
      views.clear();
    },
    async setMic(on) {
      if (!mic && on) {
        mic = await openTrack('mic');
        pc?.getSenders().find((s) => s.track?.kind === 'audio' || (!s.track && s.dtmf))?.replaceTrack(mic).catch(() => {});
        meter = createMeter(mic);
      }
      micOn = on && !!mic;
      if (mic) mic.enabled = micOn;
      batch.schedule();
    },
    async setCamera(on) {
      if (screen) return;
      if (on && !camera) {
        // Atendeu só com áudio: a câmera entra no transceptor de vídeo (sem ele, a chamada segue sem vídeo).
        camera = await openTrack('cam');
        const tr = pc?.getTransceivers().find((t) => t.receiver.track.kind === 'video');
        if (tr) {
          if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
            tr.direction = 'sendrecv';
            await tr.sender.replaceTrack(camera);
            await offer();
          } else await tr.sender.replaceTrack(camera);
        }
      }
      cameraOn = on && !!camera;
      if (camera) camera.enabled = cameraOn;
      refresh();
    },
    // Compartilha a tela no lugar da câmera (ou acrescenta vídeo numa chamada de voz).
    async setScreen(on) {
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video') ?? pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
      if (!on) {
        if (!screen) return;
        const s = screen;
        screen = null;
        await sender?.replaceTrack(camera).catch(() => {});
        s.stop();
        refresh();
        return;
      }
      if (screen) return;
      let display: MediaStream;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch {
        return;
      }
      const s = display.getVideoTracks()[0];
      screen = s;
      if (sender) {
        // Transceptor só de recebimento (chamada de voz) passa a enviar.
        const tr = pc.getTransceivers().find((t) => t.sender === sender);
        if (tr && (tr.direction === 'recvonly' || tr.direction === 'inactive')) {
          tr.direction = 'sendrecv';
          await sender.replaceTrack(s);
          await offer();
        } else await sender.replaceTrack(s);
      }
      s.onended = () => void (screen === s && engine.setScreen(false));
      refresh();
    },
    setReceiveVideo() {
      // Na chamada a dois o vídeo é sempre recebido.
    },
    async switchDevice(kind, deviceId) {
      if (kind === 'audiooutput') {
        await (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId).catch(() => {});
        return;
      }
      const isMic = kind === 'audioinput';
      if (isMic ? !mic : !camera) return;
      const next = await openTrack(isMic ? 'mic' : 'cam', deviceId);
      const old = isMic ? mic : camera;
      next.enabled = isMic ? micOn : cameraOn;
      const sender = pc?.getSenders().find((s) => s.track === old);
      if (sender && (isMic || !screen)) await sender.replaceTrack(next).catch(() => {});
      old?.stop();
      if (isMic) {
        mic = next;
        meter?.stop();
        meter = createMeter(next);
      } else camera = next;
      refresh();
    },
    attach(peerId, source, el) {
      if (source === 'audio') return () => {};
      views.set(el, { peer: peerId, source });
      el.muted = true;
      refresh();
      return () => {
        views.delete(el);
        el.srcObject = null;
      };
    },
    async startAudio() {
      await audio.play().then(
        () => ev.emit({ type: 'audio-blocked', blocked: false }),
        () => {},
      );
    },
    on: ev.on,
    micTrack: () => mic,
  };
  return engine;
}
