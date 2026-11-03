import { useEffect, useRef, useState } from 'react';
import { formatVoiceDuration } from '@shared/stickers';
import { cameraCount, cameraError, openCamera, recordVideo, VIDEO_MESSAGE_MAX_SECONDS, videoSupport, type VideoRecording, type VideoResult } from '../lib/videoMessage';
import { useSetting, useStore } from '../lib/store';
import { Icon } from './Icon';
import { Modal } from './ui';

// Mensagem de vídeo: prévia ao vivo, gravar até 2 minutos, rever e enviar. Fechar descarta sem perguntar.

type Phase = 'opening' | 'ready' | 'recording' | 'review';

// Antes de abrir: os motivos que já dá para saber (HTTP, navegador sem suporte). null = pode abrir.
export function videoBlockedReason(): string | null {
  const s = videoSupport();
  if (s === 'insecure') return 'Gravar vídeo só funciona com o chat aberto em HTTPS (ou em localhost).';
  if (s === 'unsupported') return 'Este navegador não grava vídeo.';
  return null;
}

export function VideoRecorder({ onClose, onSend, onActivity }: { onClose: () => void; onSend: (r: VideoResult) => void; onActivity: (on: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('opening');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [cameras, setCameras] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<VideoResult | null>(null);
  const [muted, setMuted] = useState(true);
  const live = useRef<HTMLVideoElement>(null);
  const review = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<VideoRecording | null>(null);
  const maxBytes = useSetting<number>('FileUpload_MaxFileSize') || 0;
  const toast = (t: string) => useStore.getState().toast(t, 'error');

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  // Abre (ou troca) a câmera.
  useEffect(() => {
    let alive = true;
    setPhase((p) => (p === 'review' ? p : 'opening'));
    openCamera(facing)
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        release();
        stream.current = s;
        if (live.current) live.current.srcObject = s;
        setCameras(await cameraCount());
        setPhase((p) => (p === 'review' ? p : 'ready'));
      })
      .catch((e) => {
        if (!alive) return;
        toast(cameraError(e));
        onClose();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing]);

  // Ao fechar: câmera desligada, gravação descartada, "gravando vídeo" desligado.
  useEffect(
    () => () => {
      rec.current?.cancel();
      release();
      onActivity(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    onActivity(false);
    const out = await r.stop();
    release();
    if (!out || out.duration < 1) {
      if (out) URL.revokeObjectURL(out.url);
      toast('Vídeo curto demais.');
      reopen();
      return;
    }
    if (maxBytes > 0 && out.file.size > maxBytes) {
      URL.revokeObjectURL(out.url);
      toast(`O vídeo passou do tamanho permitido (${Math.round(maxBytes / 1048576)} MB). Grave um vídeo mais curto.`);
      onClose();
      return;
    }
    setResult(out);
    setPhase('review');
  };

  // Gravando: relógio, "gravando vídeo" a cada 3 s e parada automática em 2:00.
  useEffect(() => {
    if (phase !== 'recording') return;
    onActivity(true);
    const tick = window.setInterval(() => {
      const t = rec.current?.elapsed() ?? 0;
      setElapsed(t);
      if (t >= VIDEO_MESSAGE_MAX_SECONDS) void stop();
    }, 250);
    const activity = window.setInterval(() => onActivity(true), 3000);
    // Aba escondida no meio da gravação: para e vai para "rever".
    const hide = () => document.visibilityState === 'hidden' && void stop();
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearInterval(tick);
      clearInterval(activity);
      document.removeEventListener('visibilitychange', hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = () => {
    if (!stream.current) return;
    try {
      rec.current = recordVideo(stream.current);
      setElapsed(0);
      setPhase('recording');
    } catch {
      toast('Este navegador não grava vídeo.');
    }
  };
  const redo = () => {
    setResult(null);
    setMuted(true);
    reopen();
  };
  // A câmera desligou ao parar: abre de novo para gravar outra vez.
  function reopen() {
    setPhase('opening');
    openCamera(facing)
      .then((s) => {
        stream.current = s;
        if (live.current) live.current.srcObject = s;
        setPhase('ready');
      })
      .catch((e) => (toast(cameraError(e)), onClose()));
  }
  const send = () => {
    if (!result) return;
    onSend(result);
    onClose();
  };

  const footer =
    phase === 'review' ? (
      <>
        <button type="button" className="btn" onClick={redo}>
          Regravar
        </button>
        <button type="button" className="btn primary" onClick={send}>
          Enviar
        </button>
      </>
    ) : undefined;

  return (
    <Modal title="Mensagem de vídeo" onClose={onClose} variant="fullscreen" className="video-recorder" footer={footer}>
      <div className="vr-stage">
        {phase !== 'review' && <video ref={live} className={`vr-live ${facing === 'user' ? 'mirror' : ''}`} autoPlay muted playsInline />}
        {phase === 'review' && result && (
          <>
            <video ref={review} className="vr-review" src={result.url} autoPlay loop muted={muted} playsInline />
            <button type="button" className="vr-sound icon-btn" aria-label={muted ? 'Ligar o som' : 'Desligar o som'} title={muted ? 'Ligar o som' : 'Desligar o som'} onClick={() => setMuted(!muted)}>
              <Icon name={muted ? 'call-speaker-off' : 'call-speaker'} size={18} />
            </button>
          </>
        )}
        {phase === 'opening' && <div className="vr-note">Abrindo a câmera…</div>}
        {phase === 'recording' && (
          <div className="vr-clock" role="timer">
            <span className="vr-dot" aria-hidden="true" />
            {formatVoiceDuration(elapsed)} / {formatVoiceDuration(VIDEO_MESSAGE_MAX_SECONDS)}
          </div>
        )}
      </div>
      {(phase === 'ready' || phase === 'recording') && (
        <div className="vr-controls">
          {phase === 'ready' && <span className="muted small vr-hint">Até 2 minutos.</span>}
          {phase === 'ready' && cameras > 1 && (
            <button type="button" className="icon-btn vr-flip" aria-label="Virar câmera" title="Virar câmera" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>
              <Icon name="call-switch-camera" size={20} />
            </button>
          )}
          {phase === 'ready' ? (
            <button type="button" className="vr-rec" onClick={start} aria-label="Gravar">
              <Icon name="record-start" size={20} fill />
              <span>Gravar</span>
            </button>
          ) : (
            <button type="button" className="vr-rec stop" onClick={() => void stop()} aria-label="Parar">
              <Icon name="record-stop" size={18} fill />
              <span>Parar</span>
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
