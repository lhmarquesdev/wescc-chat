// Mensagens de voz: gravação pelo microfone (MediaRecorder) e a onda que vai junto com o arquivo.

export const VOICE_BARS = 48; // barras da onda guardadas na mensagem
export const VOICE_MAX_SECONDS = 15 * 60; // passou disso, a gravação para e fica pronta para enviar

// O navegador só libera o microfone em HTTPS ou em localhost.
export function voiceSupport(): 'ok' | 'insecure' | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'unsupported';
  return 'ok';
}

// Opus em WebM (Chrome, Edge, Firefox) ou AAC em MP4 (Safari).
function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

export interface VoiceResult {
  file: File;
  duration: number;
  waveform: number[];
}

export interface VoiceRecorder {
  // Níveis já gravados (0 a 1, um a cada ~100 ms), para a onda ao vivo.
  levels: number[];
  elapsed(): number;
  pause(): void;
  resume(): void;
  paused(): boolean;
  stop(): Promise<VoiceResult | null>;
  cancel(): void;
}

const TICK_MS = 100;

// Reduz os níveis para n barras (pico de cada trecho), de 0 a 100, com a maior barra em 100.
export function downsample(levels: number[], n = VOICE_BARS): number[] {
  if (!levels.length) return Array(n).fill(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    let peak = 0;
    for (let j = a; j < b && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  const max = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / max) * 100));
}

export async function startVoiceRecording(onTick?: () => void, onLimit?: () => void): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const mime = pickMime();
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    rec = new MediaRecorder(stream);
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // Nível do microfone: RMS do sinal a cada 100 ms (só enquanto não está pausado).
  const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx: AudioContext = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const levels: number[] = [];
  let recorded = 0; // ms gravados antes da última retomada
  let since = performance.now();
  let isPaused = false;
  let done = false;
  const elapsed = () => (recorded + (isPaused ? 0 : performance.now() - since)) / 1000;
  const timer = window.setInterval(() => {
    if (isPaused) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    // Escala suave: a fala normal fica no meio da onda, o silêncio perto de zero.
    levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6));
    if (elapsed() >= VOICE_MAX_SECONDS) onLimit?.();
    onTick?.();
  }, TICK_MS);

  const release = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  rec.start(250);
  return {
    levels,
    elapsed,
    paused: () => isPaused,
    pause() {
      if (isPaused || rec.state !== 'recording') return;
      rec.pause();
      recorded += performance.now() - since;
      isPaused = true;
      onTick?.();
    },
    resume() {
      if (!isPaused || rec.state !== 'paused') return;
      rec.resume();
      since = performance.now();
      isPaused = false;
      onTick?.();
    },
    cancel() {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
    stop() {
      const duration = elapsed();
      return new Promise<VoiceResult | null>((resolve) => {
        rec.onstop = () => {
          release();
          const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
          const blob = new Blob(chunks, { type });
          if (!blob.size || duration < 0.5) return resolve(null);
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const stamp = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '-').replace(/,?\s+/g, ' ');
          resolve({ file: new File([blob], `Mensagem de voz ${stamp}.${ext}`, { type }), duration, waveform: downsample(levels) });
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      });
    },
  };
}

// Só uma mensagem de voz toca por vez: dar play numa pausa a anterior.
let playing: HTMLAudioElement | null = null;
export function claimPlayback(el: HTMLAudioElement) {
  if (playing && playing !== el) playing.pause();
  playing = el;
}
