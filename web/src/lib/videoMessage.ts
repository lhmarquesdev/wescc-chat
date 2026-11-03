// Mensagem de vídeo: câmera (getUserMedia) e gravação (MediaRecorder), até 2 minutos.
import { VIDEO_MESSAGE_MAX_SECONDS } from '@shared/messages';

export { VIDEO_MESSAGE_MAX_SECONDS };

// O navegador só libera a câmera em HTTPS ou em localhost.
export function videoSupport(): 'ok' | 'insecure' | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'unsupported';
  return 'ok';
}

export function openCamera(facing: 'user' | 'environment') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

export async function cameraCount() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
  } catch {
    return 1;
  }
}

// O motivo da falha ao abrir a câmera, em português.
export function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Libere a câmera e o microfone para este site no navegador (ícone de cadeado na barra de endereço).';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Nenhuma câmera encontrada neste dispositivo.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'A câmera está em uso por outro programa.';
  return 'Não foi possível usar a câmera.';
}

// MP4 primeiro: toca no iPhone. Firefox grava WebM.
function pickMime() {
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

export interface VideoResult {
  file: File;
  duration: number;
  url: string; // para rever antes de enviar (revogar ao descartar)
}

export interface VideoRecording {
  elapsed(): number;
  stop(): Promise<VideoResult | null>;
  cancel(): void;
}

export function recordVideo(stream: MediaStream): VideoRecording {
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = performance.now();
  rec.start(1000);
  const elapsed = () => (performance.now() - started) / 1000;
  return {
    elapsed,
    cancel() {
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') rec.stop();
    },
    stop() {
      const duration = Math.min(elapsed(), VIDEO_MESSAGE_MAX_SECONDS);
      return new Promise<VideoResult | null>((resolve) => {
        rec.onstop = () => {
          const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
          const blob = new Blob(chunks, { type });
          if (!blob.size) return resolve(null);
          const ext = type.includes('mp4') ? 'mp4' : 'webm';
          const stamp = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '-').replace(/,?\s+/g, ' ');
          resolve({ file: new File([blob], `Mensagem de vídeo ${stamp}.${ext}`, { type }), duration, url: URL.createObjectURL(blob) });
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      });
    },
  };
}
