// Microfone, câmera e saída de áudio: listas, escolhas lembradas, aparelho desconectado, textos de erro, o medidor
// de nível e o aviso de "falando com o microfone desligado".
import { CALL_LIMITS } from '@shared/calls';

export type DeviceKind = 'mic' | 'cam' | 'out';

const KEYS: Record<DeviceKind, string> = { mic: 'wescc.call.mic', cam: 'wescc.call.cam', out: 'wescc.call.out' };
const MEDIA_KIND: Record<DeviceKind, MediaDeviceKind> = { mic: 'audioinput', cam: 'videoinput', out: 'audiooutput' };

export function loadChoice(kind: DeviceKind): string {
  try {
    return localStorage.getItem(KEYS[kind]) ?? '';
  } catch {
    return '';
  }
}

export function saveChoice(kind: DeviceKind, id: string) {
  try {
    if (id) localStorage.setItem(KEYS[kind], id);
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    // sem armazenamento local: vale só nesta chamada
  }
}

export const mediaKindOf = (k: DeviceKind) => MEDIA_KIND[k];

// Compartilhar a tela: só com getDisplayMedia e fora de telas de toque (navegadores de celular não compartilham).
export function canShareScreen() {
  return typeof navigator !== 'undefined' && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && !matchMedia('(pointer: coarse)').matches;
}

export const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export interface DeviceLists {
  mic: MediaDeviceInfo[];
  cam: MediaDeviceInfo[];
  out: MediaDeviceInfo[];
}

// "default" e "communications" são apelidos do Chrome para o padrão: já entram como "Padrão do sistema".
export async function listDevices(): Promise<DeviceLists> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
  const pick = (k: MediaDeviceKind) => all.filter((d) => d.kind === k && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return { mic: pick('audioinput'), cam: pick('videoinput'), out: pick('audiooutput') };
}

export function deviceLabel(d: MediaDeviceInfo, i: number, kind: DeviceKind) {
  if (d.label) return d.label;
  return kind === 'mic' ? `Microfone ${i + 1}` : kind === 'cam' ? `Câmera ${i + 1}` : `Saída ${i + 1}`;
}

// ---------- Abrir a mídia ----------

export const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export type MediaProblem = 'denied' | 'no-mic' | 'no-camera' | 'busy' | 'insecure' | 'unsupported' | 'other';

export const PROBLEM_TEXT: Record<MediaProblem, string> = {
  denied: 'O navegador bloqueou o microfone e a câmera. Clique no cadeado da barra de endereço, permita o acesso e tente de novo.',
  'no-mic': 'Nenhum microfone encontrado. Conecte um fone com microfone ou entre sem microfone.',
  'no-camera': 'Nenhuma câmera encontrada. Você entra só com áudio.',
  busy: 'O microfone ou a câmera está em uso por outro programa. Feche o outro programa e tente de novo.',
  insecure: 'Chamadas exigem HTTPS. Peça ao administrador para ativar o HTTPS do chat.',
  unsupported: 'Este navegador não faz chamadas. Use Chrome, Edge, Firefox ou Safari atualizados.',
  other: 'Não foi possível usar o microfone. Confira a permissão do navegador.',
};

export function problemOf(e: unknown): MediaProblem {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-mic';
  return 'other';
}

// Câmera em 720p; em 360p acima de 8 pessoas ou num PC com 4 núcleos ou menos (G18). O motor de grupo confere de
// novo antes de publicar, porque a contagem pode ter mudado desde a tela de entrada.
export const CAM_SIZE = { full: { width: 1280, height: 720 }, low: { width: 640, height: 360, frameRate: 20 } };

export function lowResFor(participants: number): boolean {
  return participants > CALL_LIMITS.lowResAbove || (navigator.hardwareConcurrency || 8) <= 4;
}

export interface OpenOptions {
  lowRes?: boolean;
}

function camConstraint(lowRes = false): MediaTrackConstraints {
  const s = lowRes ? CAM_SIZE.low : CAM_SIZE.full;
  return { width: { ideal: s.width }, height: { ideal: s.height }, ...(lowRes ? { frameRate: { ideal: CAM_SIZE.low.frameRate } } : {}) };
}

function constraint(kind: DeviceKind, id: string, o: OpenOptions = {}): MediaTrackConstraints | boolean {
  const base: MediaTrackConstraints = kind === 'mic' ? { ...AUDIO_CONSTRAINTS } : camConstraint(o.lowRes);
  return id ? { ...base, deviceId: { exact: id } } : base;
}

async function gum(kind: DeviceKind, id: string, o: OpenOptions = {}) {
  try {
    return await navigator.mediaDevices.getUserMedia(kind === 'mic' ? { audio: constraint('mic', id) } : { video: constraint('cam', id, o) });
  } catch (e) {
    // O aparelho lembrado sumiu: tenta o padrão do sistema.
    if (id && (e as { name?: string })?.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia(kind === 'mic' ? { audio: constraint('mic', '') } : { video: constraint('cam', '', o) });
    throw e;
  }
}

// Faixa de câmera aberta maior do que a chamada pede (360p): reduz na própria faixa, sem pedir o aparelho de novo.
export async function fitCamera(t: MediaStreamTrack, lowRes: boolean) {
  if (!lowRes || t.kind !== 'video') return;
  const { width = 0, height = 0 } = t.getSettings();
  if (Math.max(width, height) <= CAM_SIZE.low.width) return;
  await t.applyConstraints({ ...t.getConstraints(), ...camConstraint(true) }).catch(() => {});
}

export interface OpenedMedia {
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  problem: MediaProblem | null; // o que impediu o microfone (ou a câmera, quando ela foi pedida e faltou)
}

// Pede microfone e câmera separados: sem câmera, a chamada segue só com áudio; sem microfone, só com vídeo.
export async function openMedia(o: { audio: boolean; video: boolean; lowRes?: boolean }): Promise<OpenedMedia> {
  const r: OpenedMedia = { audio: null, video: null, problem: null };
  if (!window.isSecureContext) return { ...r, problem: 'insecure' };
  if (!navigator.mediaDevices?.getUserMedia) return { ...r, problem: 'unsupported' };
  if (o.audio) {
    try {
      r.audio = (await gum('mic', loadChoice('mic'))).getAudioTracks()[0] ?? null;
    } catch (e) {
      r.problem = problemOf(e);
    }
  }
  if (o.video && r.problem !== 'denied') {
    try {
      r.video = (await gum('cam', loadChoice('cam'), o)).getVideoTracks()[0] ?? null;
    } catch (e) {
      const p = problemOf(e);
      if (!r.problem) r.problem = p === 'no-mic' ? 'no-camera' : p;
    }
  }
  return r;
}

export async function openTrack(kind: 'mic' | 'cam', id = loadChoice(kind), o: OpenOptions = {}): Promise<MediaStreamTrack> {
  const s = await gum(kind, id, o);
  return (kind === 'mic' ? s.getAudioTracks() : s.getVideoTracks())[0];
}

// ---------- Aparelho desconectado ----------

export const UNPLUGGED: Record<'mic' | 'cam', string> = {
  mic: 'O microfone foi desconectado. Usando o padrão do sistema.',
  cam: 'A câmera foi desconectada. Usando a padrão do sistema.',
};

// Chama onGone quando o aparelho escolhido some da lista (a escolha volta para o padrão).
export function watchDevices(onChange: (lists: DeviceLists) => void, onGone: (kind: DeviceKind) => void) {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  const h = async () => {
    const lists = await listDevices();
    for (const k of ['mic', 'cam', 'out'] as const) {
      const id = loadChoice(k);
      if (id && lists[k].length && !lists[k].some((d) => d.deviceId === id)) {
        saveChoice(k, '');
        onGone(k);
      }
    }
    onChange(lists);
  };
  md.addEventListener('devicechange', h);
  return () => md.removeEventListener('devicechange', h);
}

// ---------- Nível do microfone ----------

export const SPEECH_LEVEL = 0.06;

let meterCtx: AudioContext | null = null;

export interface Meter {
  level(): number; // 0 a 1
  stop(): void;
}

// Lê uma cópia da faixa, nunca publicada: desligar o microfone na chamada não cala o medidor.
export function createMeter(track: MediaStreamTrack): Meter | null {
  try {
    meterCtx ??= new AudioContext();
    const clone = track.clone();
    clone.enabled = true;
    const src = meterCtx.createMediaStreamSource(new MediaStream([clone]));
    const an = meterCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    if (meterCtx.state === 'suspended') void meterCtx.resume().catch(() => {});
    return {
      level() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        return Math.min(1, Math.sqrt(sum / buf.length) * 3);
      },
      stop() {
        src.disconnect();
        clone.stop();
      },
    };
  } catch {
    return null;
  }
}

// Falando com o microfone desligado (U2): nível acima do limiar por 2 s seguidos, no máximo um aviso a cada 2 min.
export function watchMutedSpeech(track: MediaStreamTrack, muted: () => boolean, onSpeech: () => void) {
  const m = createMeter(track);
  if (!m) return () => {};
  let since = 0;
  let last = 0;
  const t = window.setInterval(() => {
    if (!muted()) return void (since = 0);
    const loud = m.level() > SPEECH_LEVEL * 2;
    const now = Date.now();
    if (!loud) return void (since = 0);
    since ||= now;
    if (now - since >= 2000 && now - last >= 120_000) {
      last = now;
      since = 0;
      onSpeech();
    }
  }, 200);
  return () => {
    clearInterval(t);
    m.stop();
  };
}
