// Motor da chamada em grupo pelo servidor de chamadas (LiveKit, atrás do próprio chat em /sfu). É o único arquivo
// que importa livekit-client: o build o põe num pedaço próprio, carregado só quando uma chamada em grupo começa.
// Nomes, metadados e atributos do LiveKit nunca são lidos: quem é quem vem do chat.
import {
  ConnectionCheck,
  ConnectionError,
  ConnectionErrorReason,
  DisconnectReason,
  isBrowserSupported,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type CheckInfo,
  type LocalTrack,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
} from 'livekit-client';
import type { CallSource } from '@shared/index';
import { AUDIO_CONSTRAINTS, fitCamera, loadChoice, lowResFor, openTrack } from './devices';
import { realtime } from '../realtime';
import { emitter, EngineError, peerBatcher, type CallEngine, type EngineContext } from './engine';
import type { LivePeer, PeerQuality } from './store';

export function sfuUrl() {
  const u = new URL('/sfu', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export const browserSupported = () => isBrowserSupported();

const NAME: Record<CallSource, string> = { microphone: 'microphone', camera: 'camera', screen_share: 'screen_share', screen_share_audio: 'screen_share_audio' };
// TrackSource do protocolo (permissões): 1 câmera, 2 microfone, 3 tela, 4 áudio da tela.
const PROTO_SOURCE: Record<number, CallSource> = { 1: 'camera', 2: 'microphone', 3: 'screen_share', 4: 'screen_share_audio' };
const ALL_SOURCES: CallSource[] = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];

const FULL_TEXT = 'A chamada está cheia no servidor de chamadas. Tente de novo em alguns minutos.';
const NETWORK_TEXT = 'Não foi possível conectar ao servidor de chamadas. Confira a rede e tente de novo.';
// O mesmo diagnóstico do teste de conexão (§6.13) para "a mídia não passa".
const MEDIA_TEXT = 'A mídia não passa. Peça à TI para liberar UDP 7882 a 7885 e TCP 7881 até o servidor do chat, no firewall e na VPN. Se o Chrome é gerenciado, confira a política WebRtcIPHandling.';

function statusOf(e: ConnectionError): number | undefined {
  const ctx = e.context as { status?: number } | undefined;
  return typeof e.status === 'number' ? e.status : typeof ctx?.status === 'number' ? ctx.status : undefined;
}

// O navegador não mostra o status de um upgrade recusado, e o livekit-client só traz o do validate em 401, 403 e
// 404. A ponte faz no validate a mesma admissão do upgrade, então perguntamos nós: 0 quando nem o validate responde.
async function validateStatus(token: string): Promise<number> {
  const u = new URL(sfuUrl().replace(/^ws/, 'http'));
  // O validate da v1 exige o join_request do próprio cliente; o da v0 confere só o token (e passa pela mesma admissão).
  u.pathname = `${u.pathname.replace(/\/$/, '')}/rtc/validate`;
  u.searchParams.set('access_token', token);
  try {
    return (await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(8000) })).status;
  } catch {
    return 0;
  }
}

// Falha ao conectar, já com o texto da pessoa.
// - Com o sinal já conectado (signalUp), o que falhou foi o PeerConnection: a mídia não passa (firewall, VPN, política
//   do Chrome). O validate aceitaria o token, então ele não diz nada aqui.
// - Recusa da ponte (401, 403, 429) vira 'refused'.
// - Sala cheia só com o sinal dela: o upgrade do WebSocket recusado (o LiveKit responde 500 "connection closed by
//   media") enquanto o validate aceita o token e o chat está conectado (o WebSocket passa pela rede).
async function connectFailure(e: unknown, token: string, signalUp: boolean): Promise<EngineError> {
  if (!(e instanceof ConnectionError)) return new EngineError(NETWORK_TEXT, 'network');
  if (e.reason === ConnectionErrorReason.Cancelled || e.reason === ConnectionErrorReason.LeaveRequest) return new EngineError('', 'other');
  let status = statusOf(e);
  if (e.reason === ConnectionErrorReason.InternalError && /closed by media/i.test(e.message)) return new EngineError(FULL_TEXT, 'full', status);
  if (signalUp) return /could not establish (pc|publisher|subscriber)/i.test(e.message) ? new EngineError(MEDIA_TEXT, 'media') : new EngineError(NETWORK_TEXT, 'network', status);
  const upgradeRefused = e.reason === ConnectionErrorReason.WebSocket;
  if (status === undefined && (upgradeRefused || e.reason === ConnectionErrorReason.InternalError)) status = await validateStatus(token);
  if (status === 401 || status === 403 || status === 429) return new EngineError('', 'refused', status);
  if (upgradeRefused && status !== undefined && status >= 200 && status < 300 && realtime.connectionId) return new EngineError(FULL_TEXT, 'full', status);
  return new EngineError(NETWORK_TEXT, 'network', status);
}

export function createSfuEngine(ctx: EngineContext): CallEngine {
  const ev = emitter();
  let room: Room | null = null;
  let receiveVideo = true;
  let pendingMic: MediaStreamTrack | null = null; // capturado, ainda não publicado (entrou com o microfone desligado)
  let closing = false;
  // Durante o connect, a queda é a própria falha da conexão: quem decide (recusa, sala cheia, rede) é o catch do connect.
  let connecting = false;
  let lowRes = false;
  const firstSeen = new Map<string, number>();
  const views = new Map<HTMLMediaElement, { peer: string; source: 'camera' | 'screen'; track: Track | null }>();
  const sink = document.createElement('div');
  sink.className = 'call-hidden';
  sink.setAttribute('aria-hidden', 'true');
  const audios = new Map<string, HTMLMediaElement>();

  const participants = (): Participant[] => (room ? [room.localParticipant, ...room.remoteParticipants.values()] : []);
  const byId = (id: string) => participants().find((p) => p.identity === id) ?? null;

  const peers = (): LivePeer[] =>
    participants().map((p) => {
      const isMe = p === room?.localParticipant;
      const user = isMe ? ctx.me : ctx.userOf(p.identity);
      if (!user) ctx.lookup(p.identity);
      if (!firstSeen.has(p.identity)) firstSeen.set(p.identity, p.joinedAt?.getTime() ?? Date.now());
      return {
        id: p.identity,
        user,
        isMe,
        mic: p.isMicrophoneEnabled,
        camera: p.isCameraEnabled,
        screen: p.isScreenShareEnabled,
        speaking: p.isSpeaking,
        lastSpokeAt: p.lastSpokeAt?.getTime() ?? null,
        handAt: null,
        quality: (p.connectionQuality as string as PeerQuality) ?? 'unknown',
        canPublish: p.permissions?.canPublish ?? true,
        joinedAt: firstSeen.get(p.identity)!,
      };
    });
  const batch = peerBatcher(peers, ev.emit);

  // Vídeo de cada quadro: liga a faixa certa ao elemento sempre que ela chega, sai ou troca.
  function bind(el: HTMLMediaElement, v: { peer: string; source: 'camera' | 'screen'; track: Track | null }) {
    const p = byId(v.peer);
    const pub = p?.getTrackPublication(v.source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera);
    const track = pub && !pub.isMuted ? (pub.track ?? null) : null;
    if (track === v.track) return;
    v.track?.detach(el);
    v.track = track;
    if (track) track.attach(el);
    else el.srcObject = null;
  }
  const rebind = () => {
    for (const [el, v] of views) bind(el, v);
    batch.schedule();
  };

  function onSubscribed(track: RemoteTrack) {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.className = 'call-hidden';
      sink.appendChild(el);
      audios.set(track.sid ?? String(audios.size), el);
    }
    rebind();
  }
  function onUnsubscribed(track: RemoteTrack) {
    if (track.kind === Track.Kind.Audio) {
      for (const el of track.detach()) el.remove();
      if (track.sid) audios.delete(track.sid);
    }
    rebind();
  }

  function permissions() {
    const perm = room?.localParticipant.permissions;
    if (!perm) return;
    const list = (perm.canPublishSources ?? []).map((s) => PROTO_SOURCE[s as unknown as number]).filter(Boolean);
    ev.emit({ type: 'permissions', canPublish: perm.canPublish, sources: perm.canPublish ? (list.length ? list : ALL_SOURCES) : [] });
  }

  function remoteCameras() {
    return room ? [...room.remoteParticipants.values()].filter((p) => p.isCameraEnabled).length : 0;
  }

  async function publish(track: MediaStreamTrack, source: CallSource) {
    if (!room) return;
    const src = source === 'microphone' ? Track.Source.Microphone : source === 'camera' ? Track.Source.Camera : source === 'screen_share' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio;
    await room.localParticipant.publishTrack(track, { name: NAME[source], source: src });
  }

  function wire(r: Room) {
    r.on(RoomEvent.ParticipantConnected, rebind)
      .on(RoomEvent.ParticipantDisconnected, rebind)
      .on(RoomEvent.TrackSubscribed, onSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
      .on(RoomEvent.TrackMuted, rebind)
      .on(RoomEvent.TrackUnmuted, rebind)
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => {
        if (!receiveVideo && pub.source === Track.Source.Camera) pub.setSubscribed(false);
        rebind();
      })
      .on(RoomEvent.TrackUnpublished, rebind)
      .on(RoomEvent.LocalTrackPublished, rebind)
      .on(RoomEvent.LocalTrackUnpublished, rebind)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        ev.emit({ type: 'speaking', ids: speakers.map((p) => p.identity) });
        batch.schedule();
      })
      .on(RoomEvent.ConnectionQualityChanged, () => batch.schedule())
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p === r.localParticipant) permissions();
        batch.schedule();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => ev.emit({ type: 'audio-blocked', blocked: !r.canPlaybackAudio }))
      .on(RoomEvent.MediaDevicesError, (e: Error, kind?: MediaDeviceKind) => ev.emit({ type: 'device-error', kind: kind === 'videoinput' ? 'camera' : 'mic', error: e.name || e.message }))
      .on(RoomEvent.Reconnecting, () => ev.emit({ type: 'state', state: 'reconnecting' }))
      .on(RoomEvent.SignalReconnecting, () => ev.emit({ type: 'state', state: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        ev.emit({ type: 'state', state: 'connected' });
        rebind();
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (room !== r || connecting) return;
        room = null;
        rebind();
        if (!closing) ev.emit({ type: 'state', state: 'disconnected', reason: reason !== undefined ? DisconnectReason[reason] : 'UNKNOWN_REASON' });
      });
  }

  const engine: CallEngine = {
    media: 'sfu',
    async connect(o) {
      if (!o.join) throw new EngineError('Não foi possível entrar na chamada.', 'other');
      closing = false;
      lowRes = lowResFor(o.call.participantsCount);
      const preset = lowRes ? VideoPresets.h360 : VideoPresets.h720;
      const r = new Room({
        adaptiveStream: { pixelDensity: lowRes ? 1 : 'screen', pauseVideoInBackground: true },
        dynacast: true,
        disconnectOnPageLeave: true,
        stopLocalTrackOnUnpublish: true,
        videoCaptureDefaults: { resolution: preset.resolution },
        audioCaptureDefaults: { ...AUDIO_CONSTRAINTS },
        publishDefaults: {
          simulcast: true,
          videoCodec: 'vp8',
          videoEncoding: preset.encoding,
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
          screenShareSimulcastLayers: [ScreenSharePresets.h360fps3, ScreenSharePresets.h720fps5],
          dtx: true,
          red: true,
        },
      });
      room = r;
      wire(r);
      document.body.appendChild(sink);
      ev.emit({ type: 'state', state: 'connecting' });
      connecting = true;
      let signalUp = false;
      r.once(RoomEvent.SignalConnected, () => (signalUp = true));
      try {
        // Sem servidores ICE: o LiveKit mandaria o STUN público do Google (G22).
        await r.connect(sfuUrl(), o.join.token, { rtcConfig: { iceServers: [] } });
      } catch (e) {
        room = null;
        for (const t of o.tracks ?? []) t.stop();
        const err = await connectFailure(e, o.join.token, signalUp);
        connecting = false;
        if (err.kind === 'refused' && !closing) ev.emit({ type: 'refused', status: err.status as 401 | 403 | 429 });
        throw err;
      }
      connecting = false;
      permissions();
      const canPublish = o.join.canPublish && o.join.sources.length > 0;
      for (const t of o.tracks ?? []) {
        if (!canPublish) {
          t.stop();
          continue;
        }
        try {
          if (t.kind === 'audio') {
            if (o.mic) await publish(t, 'microphone');
            else pendingMic = t;
          } else if (o.camera && remoteCameras() < o.join.maxVideoPublishers) {
            await fitCamera(t, lowRes);
            await publish(t, 'camera');
          }
          else {
            if (o.camera) ev.emit({ type: 'device-error', kind: 'camera', error: `Limite de ${o.join.maxVideoPublishers} câmeras ligadas nesta chamada.` });
            t.stop();
          }
        } catch (e) {
          t.stop();
          ev.emit({ type: 'device-error', kind: t.kind === 'audio' ? 'mic' : 'camera', error: (e as Error)?.name || 'publish' });
        }
      }
      if (!r.canPlaybackAudio) ev.emit({ type: 'audio-blocked', blocked: true });
      ev.emit({ type: 'state', state: 'connected' });
      rebind();
    },
    async disconnect() {
      closing = true;
      batch.cancel();
      pendingMic?.stop();
      pendingMic = null;
      const r = room;
      room = null;
      for (const [el, v] of views) {
        v.track?.detach(el);
        v.track = null;
      }
      await r?.disconnect(true).catch(() => {});
      for (const el of audios.values()) el.remove();
      audios.clear();
      sink.remove();
    },
    async setMic(on) {
      const lp = room?.localParticipant;
      if (!lp) return;
      const pub = lp.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) {
        if (on) await pub.unmute();
        else await pub.mute();
      } else if (on) {
        if (pendingMic && pendingMic.readyState === 'live') {
          const t = pendingMic;
          pendingMic = null;
          await publish(t, 'microphone');
        } else {
          const id = loadChoice('mic');
          await lp.setMicrophoneEnabled(true, { ...AUDIO_CONSTRAINTS, deviceId: id || undefined }, { name: NAME.microphone });
        }
      }
      batch.schedule();
    },
    async setCamera(on) {
      const lp = room?.localParticipant;
      if (!lp) return;
      const pub = lp.getTrackPublication(Track.Source.Camera);
      if (!on) {
        // Câmera da tela de entrada (fornecida por nós): despublica e solta o aparelho (a luz apaga).
        if (pub?.track?.isUserProvided) await lp.unpublishTrack(pub.track as LocalTrack, true);
        else await lp.setCameraEnabled(false);
      } else {
        const id = loadChoice('cam');
        await lp.setCameraEnabled(true, { deviceId: id || undefined }, { name: NAME.camera });
      }
      rebind();
    },
    async setScreen(on, o) {
      const lp = room?.localParticipant;
      if (!lp) return;
      if (!on) {
        for (const s of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
          const pub = lp.getTrackPublication(s);
          if (pub?.track) await lp.unpublishTrack(pub.track as LocalTrack, true);
        }
        rebind();
        return;
      }
      const tabAudio = !!o?.tabAudio;
      let tracks: LocalTrack[];
      try {
        tracks = await lp.createScreenTracks({
          audio: tabAudio,
          video: tabAudio ? { displaySurface: 'browser' } : true,
          contentHint: 'detail',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: 'exclude',
        });
      } catch (e) {
        // Cancelar a escolha da tela não é erro.
        const name = (e as Error)?.name;
        if (name !== 'NotAllowedError' && name !== 'AbortError') ev.emit({ type: 'device-error', kind: 'screen', error: name || 'screen' });
        return;
      }
      for (const t of tracks) {
        const video = t.kind === Track.Kind.Video;
        await lp.publishTrack(t, { name: video ? NAME.screen_share : NAME.screen_share_audio, source: video ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio });
      }
      rebind();
    },
    setReceiveVideo(on) {
      receiveVideo = on;
      for (const p of room?.remoteParticipants.values() ?? []) {
        const pub = p.getTrackPublication(Track.Source.Camera);
        pub?.setSubscribed(on);
      }
    },
    async switchDevice(kind, deviceId) {
      const r = room;
      if (!r) return;
      if (kind === 'audiooutput') {
        await r.switchActiveDevice(kind, deviceId || 'default').catch(() => {});
        return;
      }
      const isMic = kind === 'audioinput';
      if (isMic && pendingMic) {
        pendingMic.stop();
        pendingMic = await openTrack('mic', deviceId);
        return;
      }
      const pub: TrackPublication | undefined = r.localParticipant.getTrackPublication(isMic ? Track.Source.Microphone : Track.Source.Camera);
      const track = pub?.track as LocalTrack | undefined;
      if (!track) return;
      // Troca a faixa na mesma publicação: vale também para a faixa que veio da tela de entrada. A faixa antiga é
      // nossa (userProvidedTrack), então o LiveKit não a para: sem isso a luz da câmera continuava acesa.
      const old = track.mediaStreamTrack;
      const next = await openTrack(isMic ? 'mic' : 'cam', deviceId, { lowRes });
      await track.replaceTrack(next, { userProvidedTrack: true });
      if (old !== next) old.stop();
      rebind();
    },
    attach(peerId, source, el) {
      if (source === 'audio') return () => {};
      const v = { peer: peerId, source, track: null as Track | null };
      views.set(el, v);
      bind(el, v);
      return () => {
        v.track?.detach(el);
        views.delete(el);
      };
    },
    async startAudio() {
      await room?.startAudio().catch(() => {});
      if (room) ev.emit({ type: 'audio-blocked', blocked: !room.canPlaybackAudio });
    },
    on: ev.on,
    micTrack() {
      const t = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      return t?.mediaStreamTrack ?? pendingMic;
    },
  };
  return engine;
}

// ---------- Teste de conexão ----------

export type SelfTestStatus = 'idle' | 'running' | 'skipped' | 'success' | 'failed';
export interface SelfTestStep {
  status: SelfTestStatus;
  protocol?: 'udp' | 'tcp';
}

const STATUS: SelfTestStatus[] = ['idle', 'running', 'skipped', 'success', 'failed'];

// Servidor de chamadas, conexão de mídia, caminho (UDP ou TCP), envio de áudio e de vídeo, nesta ordem.
export async function runSelfTest(token: string, onUpdate: (steps: SelfTestStep[]) => void): Promise<SelfTestStep[]> {
  const cc = new ConnectionCheck(sfuUrl(), token, { connectOptions: { rtcConfig: { iceServers: [] } } });
  const steps: SelfTestStep[] = Array.from({ length: 5 }, () => ({ status: 'idle' }));
  const map = (i: CheckInfo): SelfTestStep => ({ status: STATUS[i.status] ?? 'idle', protocol: i.data?.protocol === 'tcp' ? 'tcp' : i.data?.protocol === 'udp' ? 'udp' : undefined });
  const run = async (n: number, f: () => Promise<CheckInfo>) => {
    steps[n] = { status: 'running' };
    onUpdate([...steps]);
    try {
      steps[n] = map(await f());
    } catch {
      steps[n] = { status: 'failed' };
    }
    onUpdate([...steps]);
    return steps[n].status === 'success';
  };
  const skipFrom = (n: number) => {
    for (let k = n; k < steps.length; k++) steps[k] = { status: 'skipped' };
    onUpdate([...steps]);
  };
  if (!(await run(0, () => cc.checkWebsocket()))) return skipFrom(1), steps;
  if (!(await run(1, () => cc.checkWebRTC()))) return skipFrom(2), steps;
  await run(2, () => cc.checkConnectionProtocol());
  await run(3, () => cc.checkPublishAudio());
  await run(4, () => cc.checkPublishVideo());
  return steps;
}
