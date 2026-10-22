import { useEffect, useRef, useState } from 'react';
import { acceptCall, declineCall, hangup, toggleCamera, toggleMute, toggleScreenShare, useCalls } from '../lib/calls';
import { useStore } from '../lib/store';
import { Avatar } from './ui';

function Video({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Toque de chamada recebida e janela da chamada em andamento (fica por cima de qualquer tela).
export function CallOverlay() {
  const { call, incoming, local, remote, muted, cameraOff, sharing, connected } = useCalls();
  const me = useStore((s) => s.me);
  const [big, setBig] = useState(false);
  const elapsed = useElapsed(connected ? call?.answeredAt : null);

  if (incoming && !call) {
    const who = incoming.caller;
    return (
      <div className="call-incoming" role="alertdialog" aria-label="Chamada recebida">
        <Avatar username={who.username} size={56} />
        <div className="call-who">
          <strong>{who.name || who.username}</strong>
          <span className="muted">{incoming.kind === 'video' ? '🎥 Chamada de vídeo' : '📞 Chamada de voz'}</span>
        </div>
        <div className="call-buttons">
          <button className="call-btn accept" title="Atender" onClick={() => void acceptCall()}>
            {incoming.kind === 'video' ? '🎥' : '📞'}
          </button>
          {incoming.kind === 'video' && (
            <button className="call-btn" title="Atender só com áudio" onClick={() => void acceptCall(true)}>
              🎤
            </button>
          )}
          <button className="call-btn hang" title="Recusar" onClick={() => void declineCall()}>
            ✕
          </button>
        </div>
      </div>
    );
  }
  if (!call || !me) return null;

  const other = call.caller._id === me._id ? call.callee : call.caller;
  const hasRemoteVideo = !!remote?.getVideoTracks().some((t) => t.readyState === 'live');
  const hasLocalVideo = !!local?.getVideoTracks().length && !cameraOff;
  const status = call.status === 'ringing' ? 'Chamando…' : !connected ? 'Conectando…' : elapsed;
  return (
    <div className={`call-window ${big ? 'big' : ''}`} role="dialog" aria-label={`Chamada com ${other.name || other.username}`}>
      <div className="call-stage">
        {hasRemoteVideo ? (
          <Video stream={remote} className="call-remote" />
        ) : (
          <div className="call-placeholder">
            <Avatar username={other.username} size={big ? 120 : 72} />
            {/* Áudio do outro lado quando não há vídeo. */}
            <Video stream={remote} className="call-hidden" />
          </div>
        )}
        {hasLocalVideo && <Video stream={local} muted className={`call-local ${sharing ? 'screen' : ''}`} />}
      </div>
      <div className="call-bar">
        <div className="call-who">
          <strong>{other.name || other.username}</strong>
          <span className="muted">{status}</span>
        </div>
        <div className="call-buttons">
          <button className={`call-btn ${muted ? 'off' : ''}`} title={muted ? 'Ligar microfone' : 'Desligar microfone'} onClick={toggleMute}>
            {muted ? '🔇' : '🎤'}
          </button>
          {!!local?.getVideoTracks().length && !sharing && (
            <button className={`call-btn ${cameraOff ? 'off' : ''}`} title={cameraOff ? 'Ligar câmera' : 'Desligar câmera'} onClick={toggleCamera}>
              {cameraOff ? '🚫' : '📷'}
            </button>
          )}
          {connected && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
            <button className={`call-btn ${sharing ? 'on' : ''}`} title={sharing ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={() => void toggleScreenShare()}>
              🖥
            </button>
          )}
          <button className="call-btn" title={big ? 'Diminuir' : 'Ampliar'} onClick={() => setBig(!big)}>
            {big ? '↙' : '⤢'}
          </button>
          <button className="call-btn hang" title="Desligar" onClick={() => void hangup()}>
            📞
          </button>
        </div>
      </div>
    </div>
  );
}
