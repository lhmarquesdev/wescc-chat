import { useRef, useState } from 'react';
import { formatVoiceDuration } from '@shared/stickers';
import { claimPlayback } from '../lib/voice';
import { Icon } from './Icon';

// Mensagem de vídeo gravada no chat: retângulo arredondado, toque para tocar com som, um tocando por vez.
export function VideoMessage({ src, duration }: { src: string; duration?: number }) {
  const el = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ratio, setRatio] = useState<string>('3 / 4');
  const [failed, setFailed] = useState(false);
  const total = duration ?? 0;
  const toggle = () => {
    const v = el.current;
    if (!v) return;
    if (v.paused) {
      claimPlayback(v);
      v.muted = false;
      v.play().catch(() => setFailed(true));
    } else v.pause();
  };
  const fullscreen = () => {
    const v = el.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!v) return;
    if (v.requestFullscreen) void v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  };
  const label = playing ? 'Pausar mensagem de vídeo' : `Reproduzir mensagem de vídeo (${formatVoiceDuration(total)})`;
  return (
    <div className={`video-msg ${playing ? 'playing' : ''}`} style={{ aspectRatio: ratio }}>
      <video
        ref={el}
        src={`${src}#t=0.1`}
        playsInline
        preload="metadata"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setProgress(0))}
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setRatio(`${v.videoWidth} / ${v.videoHeight}`);
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : total;
          setProgress(d > 0 ? Math.min(1, v.currentTime / d) : 0);
        }}
      />
      <button type="button" className="video-msg-play" aria-label={label} title={failed ? 'Não foi possível tocar' : label} onClick={toggle}>
        <Icon name={playing ? 'voice-pause' : 'voice-play'} size={24} fill />
      </button>
      <span className="video-msg-time">{formatVoiceDuration(total)}</span>
      <button type="button" className="video-msg-full icon-btn" aria-label="Tela cheia" title="Tela cheia" onClick={fullscreen}>
        <Icon name="enlarge" size={16} />
      </button>
      <span className="video-msg-bar" aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </span>
    </div>
  );
}
