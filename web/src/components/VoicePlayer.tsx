// Player das mensagens de voz (e dos arquivos de áudio): play/pausa, onda com o progresso, arrastar para
// avançar, tempo e velocidade 1×/1,5×/2×.
import { useEffect, useRef, useState } from 'react';
import { formatVoiceDuration } from '@shared/stickers';
import { claimPlayback, VOICE_BARS } from '../lib/voice';
import { Icon } from './Icon';

const SPEEDS = [1, 1.5, 2];
const SPEED_KEY = 'wescc.voice.speed';

// Arquivo de áudio comum não traz onda: uma forma fixa, derivada do endereço, para não parecer uma linha reta.
function pseudoWave(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: VOICE_BARS }, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return 25 + ((h >>> 0) % 60);
  });
}

function savedSpeed() {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function VoicePlayer({ src, duration, waveform, title, voice }: { src: string; duration?: number; waveform?: number[]; title?: string; voice?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(duration ?? 0);
  const [speed, setSpeed] = useState(savedSpeed);
  const [failed, setFailed] = useState(false);
  const bars = waveform?.length ? waveform : pseudoWave(src);
  const progress = total > 0 ? Math.min(1, time / total) : 0;

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  // WebM gravado pelo navegador não traz a duração no cabeçalho (vem Infinity): vale a da mensagem.
  const onMeta = () => {
    const d = audio.current?.duration;
    if (d && Number.isFinite(d) && !duration) setTotal(d);
  };

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      claimPlayback(el);
      el.playbackRate = speed;
      el.play().catch(() => setFailed(true));
    } else el.pause();
  };

  const seekTo = (clientX: number) => {
    const el = audio.current;
    const box = wave.current?.getBoundingClientRect();
    if (!el || !box || !total) return;
    const t = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total;
    el.currentTime = t;
    setTime(t);
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    try {
      localStorage.setItem(SPEED_KEY, String(next));
    } catch {
      // ignora
    }
  };

  const label = voice ? 'Mensagem de voz' : title || 'Áudio';
  return (
    <div className={['voice-player', playing && 'playing', voice && 'is-voice'].filter(Boolean).join(' ')}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={onMeta}
        onDurationChange={onMeta}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setTime(0))}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onError={() => setFailed(true)}
      />
      <button type="button" className="voice-play" onClick={toggle} aria-label={playing ? `Pausar ${label}` : `Ouvir ${label}`} title={playing ? 'Pausar' : 'Ouvir'} disabled={failed}>
        <Icon name={playing ? 'voice-pause' : 'voice-play'} size={18} />
      </button>
      <div className="voice-body">
        {!voice && title && <span className="voice-title">{title}</span>}
        <div
          ref={wave}
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label={`Posição em ${label}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatVoiceDuration(time)} de ${formatVoiceDuration(total)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e.clientX);
          }}
          onPointerMove={(e) => e.buttons && e.currentTarget.hasPointerCapture(e.pointerId) && seekTo(e.clientX)}
          onKeyDown={(e) => {
            const el = audio.current;
            if (!el || !total) return;
            const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
            if (!step) return;
            e.preventDefault();
            el.currentTime = Math.max(0, Math.min(total, el.currentTime + step));
          }}
        >
          {bars.map((v, i) => (
            <i key={i} className={(i + 0.5) / bars.length <= progress ? 'on' : undefined} style={{ height: `${Math.max(12, v)}%` }} />
          ))}
          <span className="voice-knob" style={{ left: `${progress * 100}%` }} aria-hidden="true" />
        </div>
        <span className="voice-meta">
          <span className="voice-clock">{failed ? 'Não foi possível tocar' : formatVoiceDuration(playing || time > 0 ? time : total)}</span>
          {voice && (
            <span className="voice-mic" aria-hidden="true">
              <Icon name="mic" size={12} />
            </span>
          )}
        </span>
      </div>
      <button type="button" className="voice-speed" onClick={cycleSpeed} title="Velocidade" aria-label={`Velocidade ${String(speed).replace('.', ',')} vezes`}>
        {String(speed).replace('.', ',')}×
      </button>
    </div>
  );
}
