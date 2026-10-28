// Faixas no alto do palco: a trava de pessoas restritas (aguardando um supervisor, com contagem), a reconexão,
// a falha depois das novas tentativas e o som bloqueado pelo navegador.
import { useEffect, useState } from 'react';
import { CALL_GUARD_TITLE, callGuardText } from '@shared/calls';
import { retryNow, serverNow, unblockAudio, useCallStore } from '../../lib/call/store';
import { Icon } from '../Icon';

function useSecondsLeft(until: string | null | undefined) {
  const at = until ? Date.parse(until) : NaN;
  const left = () => (Number.isFinite(at) ? Math.max(0, Math.ceil((at - serverNow()) / 1000)) : 0);
  const [s, setS] = useState(left);
  useEffect(() => {
    if (!Number.isFinite(at)) return;
    setS(left());
    const t = window.setInterval(() => setS(left()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  return s;
}

export function GuardBanner() {
  const until = useCallStore((s) => s.call?.guardUntil);
  const seconds = useSecondsLeft(until);
  if (!until) return null;
  return (
    <div className="call-banner call-guard warn" role="status">
      <Icon name="call-guard" size={18} />
      <div className="call-banner-text">
        <strong>{CALL_GUARD_TITLE}</strong>
        <span>{callGuardText(seconds)}</span>
      </div>
    </div>
  );
}

export function CallBanners() {
  const phase = useCallStore((s) => s.phase);
  const failed = useCallStore((s) => s.failed);
  const audioBlocked = useCallStore((s) => s.audioBlocked);
  return (
    <div className="call-banners">
      <GuardBanner />
      {phase === 'reconnecting' &&
        (failed ? (
          <div className="call-banner err" role="alert">
            <Icon name="call-server-down" size={18} />
            <span className="call-banner-text">Não foi possível reconectar à chamada.</span>
            <button type="button" className="btn small" onClick={retryNow}>
              <Icon name="call-retry" />
              Tentar de novo
            </button>
          </div>
        ) : (
          <div className="call-banner" role="status">
            <Icon name="call-retry" size={18} />
            <span className="call-banner-text">Reconectando…</span>
          </div>
        ))}
      {audioBlocked && phase !== 'reconnecting' && (
        <div className="call-banner warn" role="alert">
          <Icon name="call-speaker-off" size={18} />
          <span className="call-banner-text">O navegador bloqueou o som da chamada.</span>
          <button type="button" className="btn small" onClick={() => void unblockAudio()}>
            Ativar som
          </button>
        </div>
      )}
    </div>
  );
}
