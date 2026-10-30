// Mensagem de voz no compositor, como no WhatsApp: segurar o microfone grava e soltar envia; arrastar para a
// esquerda cancela e para cima trava a gravação (mãos livres). Um toque rápido (ou o teclado) já começa travado.
import { useEffect, useRef, useState } from 'react';
import { formatVoiceDuration } from '@shared/stickers';
import { useStore } from '../lib/store';
import { startVoiceRecording, voiceSupport, type VoiceRecorder, type VoiceResult } from '../lib/voice';
import { Icon } from './Icon';

type Phase = 'idle' | 'starting' | 'holding' | 'locked';

const CANCEL_DX = 110; // px para a esquerda
const LOCK_DY = 70; // px para cima
const TAP_MS = 350; // soltar antes disso é um toque: grava travado

const denied = (e: unknown) => {
  const name = (e as any)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Libere o microfone para este site no navegador (ícone de cadeado na barra de endereço).';
  if (name === 'NotFoundError') return 'Nenhum microfone encontrado neste computador.';
  if (name === 'NotReadableError') return 'O microfone está em uso por outro programa.';
  return 'Não foi possível usar o microfone.';
};

export function useVoiceRecorder(opts: { onSend: (r: VoiceResult) => void; onActivity: (recording: boolean) => void }) {
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [, tick] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const rec = useRef<VoiceRecorder | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const press = useRef({ x: 0, y: 0, at: 0, released: false, id: -1 });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const setPhase = (p: Phase) => ((phaseRef.current = p), setPhaseState(p));

  const reset = () => {
    rec.current = null;
    setDrag({ dx: 0, dy: 0 });
    setPhase('idle');
    optsRef.current.onActivity(false);
  };
  const cancel = () => {
    rec.current?.cancel();
    // Pediu para cancelar enquanto o microfone ainda abria: o start vê 'idle' e descarta.
    reset();
  };
  const send = async () => {
    const r = rec.current;
    if (!r) return cancel();
    rec.current = null;
    const result = await r.stop();
    reset();
    if (result) optsRef.current.onSend(result);
    else useStore.getState().toast('Áudio curto demais: segure o microfone enquanto fala.', 'info');
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const start = async (mode: 'hold' | 'locked') => {
    if (phaseRef.current !== 'idle') return;
    const support = voiceSupport();
    if (support !== 'ok') {
      useStore
        .getState()
        .toast(support === 'insecure' ? 'Gravar áudio só funciona com o chat aberto em HTTPS (ou em localhost).' : 'Este navegador não grava áudio.', 'error');
      return;
    }
    setPhase('starting');
    try {
      const r = await startVoiceRecording(
        () => tick((x) => x + 1),
        () => void sendRef.current(), // passou do limite: envia o que foi gravado
      );
      if ((phaseRef.current as Phase) !== 'starting') return r.cancel();
      rec.current = r;
      optsRef.current.onActivity(true);
      setPhase(mode === 'locked' || press.current.released ? 'locked' : 'holding');
    } catch (e) {
      setPhase('idle');
      useStore.getState().toast(denied(e), 'error');
    }
  };

  // Enquanto segura: o dedo é seguido pela janela (o botão pode sair de baixo do dedo).
  useEffect(() => {
    if (phase !== 'holding' && phase !== 'starting') return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== press.current.id || phaseRef.current !== 'holding') return;
      const dx = Math.min(0, e.clientX - press.current.x);
      const dy = Math.min(0, e.clientY - press.current.y);
      if (-dx > CANCEL_DX) return cancel();
      if (-dy > LOCK_DY) {
        setDrag({ dx: 0, dy: 0 });
        return setPhase('locked');
      }
      setDrag(Math.abs(dx) > Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy });
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== press.current.id) return;
      press.current.released = true;
      if (phaseRef.current !== 'holding') return;
      if (performance.now() - press.current.at < TAP_MS || e.type === 'pointercancel') {
        setDrag({ dx: 0, dy: 0 });
        setPhase('locked');
      } else void sendRef.current();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [phase]);

  // Quem está na sala vê "gravando áudio…" enquanto a gravação dura.
  useEffect(() => {
    if (phase !== 'holding' && phase !== 'locked') return;
    const t = setInterval(() => optsRef.current.onActivity(true), 3000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === 'idle') return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.preventDefault(), cancel());
      else if (e.key === 'Enter' && phaseRef.current === 'locked' && !(e.target instanceof HTMLTextAreaElement)) (e.preventDefault(), void sendRef.current());
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [phase]);

  // Saiu da sala no meio da gravação: descarta.
  useEffect(() => () => rec.current?.cancel(), []);

  const micProps = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || phaseRef.current !== 'idle') return;
      e.preventDefault();
      press.current = { x: e.clientX, y: e.clientY, at: performance.now(), released: false, id: e.pointerId };
      void start('hold');
    },
    // Teclado (Enter/Espaço): começa travado. O clique do mouse já foi tratado no pointerdown.
    onClick: (e: React.MouseEvent) => {
      if (phaseRef.current === 'locked') return void sendRef.current();
      if (e.detail === 0) void start('locked');
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  return {
    phase,
    active: phase !== 'idle',
    drag,
    recorder: rec.current,
    micProps,
    cancel,
    send: () => void send(),
    togglePause: () => {
      const r = rec.current;
      if (!r) return;
      if (r.paused()) r.resume();
      else r.pause();
    },
  };
}

export type VoiceControls = ReturnType<typeof useVoiceRecorder>;

// Faixa da gravação, por cima da caixa de texto (o botão do microfone/enviar continua no lugar dele).
export function VoiceBar({ voice }: { voice: VoiceControls }) {
  const r = voice.recorder;
  const paused = !!r?.paused();
  const levels = r?.levels.slice(-90) ?? [];
  const time = formatVoiceDuration(r?.elapsed() ?? 0);
  if (voice.phase === 'holding' || voice.phase === 'starting') {
    const fade = Math.max(0, 1 + voice.drag.dx / CANCEL_DX);
    return (
      <div className="voice-bar holding" role="status">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-time">{time}</span>
        <span className="voice-slide" style={{ transform: `translateX(${voice.drag.dx}px)`, opacity: fade }}>
          <Icon name="prev" size={16} />
          Deslize para cancelar
        </span>
        <span className="voice-lock" style={{ transform: `translateY(${voice.drag.dy}px)` }} aria-hidden="true">
          <Icon name="voice-lock" size={16} />
          <Icon name="voice-up" size={14} />
        </span>
      </div>
    );
  }
  return (
    <div className="voice-bar locked" role="group" aria-label="Gravando mensagem de voz">
      <button type="button" className="tool-btn voice-trash" title="Descartar áudio" aria-label="Descartar áudio" onClick={voice.cancel}>
        <Icon name="delete" size={18} />
      </button>
      <span className={paused ? 'voice-dot paused' : 'voice-dot'} aria-hidden="true" />
      <span className="voice-time" aria-live="off">
        {time}
      </span>
      <span className="voice-live" aria-hidden="true">
        {levels.map((v, i) => (
          <i key={i} style={{ height: `${Math.max(8, v * 100)}%` }} />
        ))}
      </span>
      <button type="button" className="tool-btn voice-pause" title={paused ? 'Continuar gravando' : 'Pausar'} aria-label={paused ? 'Continuar gravando' : 'Pausar'} onClick={voice.togglePause}>
        <Icon name={paused ? 'mic' : 'voice-pause'} size={18} />
      </button>
    </div>
  );
}
