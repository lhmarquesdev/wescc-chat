// Minha conta › Segurança: a senha da criptografia de ponta a ponta neste navegador.
import { E2E_UI, useE2e } from '../../lib/e2e/client';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { openE2eDialog } from './E2eDialogs';
import './e2e.css';

export function E2eCard() {
  const on = useSetting<boolean>('E2E_Enable');
  const hasKeys = useStore((s) => !!s.me?.e2eKeys);
  const status = useE2e((s) => s.status);
  const resetByAdmin = useStore((s) => !!s.me?.e2eResetByAdmin);
  if (!on && !hasKeys) return null;
  return (
    <div className="card form e2e-card">
      <div className="card-head">
        <div>
          <h2>Criptografia de ponta a ponta</h2>
          <p className="card-desc">A senha que abre as conversas criptografadas.</p>
        </div>
      </div>
      {status === 'unsupported' ? (
        <div className="callout warn">
          <Icon name="e2e-warning" />
          <span>A criptografia só funciona com o chat aberto em https.</span>
        </div>
      ) : status === 'ready' ? (
        <>
          <div className="callout ok">
            <Icon name="success" />
            <span>Configurada e desbloqueada neste navegador.</span>
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => void openE2eDialog('password')}>
              <Icon name="e2e-key" size={16} />
              Trocar a senha da criptografia
            </button>
            <button type="button" className="btn danger" onClick={() => void openE2eDialog('reset')}>
              Redefinir
            </button>
          </div>
        </>
      ) : status === 'locked' || (status === 'loading' && hasKeys) ? (
        <>
          <p className="muted">Configurada. Neste navegador, falta digitar a senha da criptografia.</p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={() => void openE2eDialog('unlock')}>
              Desbloquear
            </button>
            <button type="button" className="btn ghost" onClick={() => void openE2eDialog('reset')}>
              Esqueci a senha
            </button>
          </div>
        </>
      ) : (
        <>
          {resetByAdmin ? (
            <div className="callout warn">
              <Icon name="e2e-warning" />
              <span>{E2E_UI.resetByAdmin}</span>
            </div>
          ) : (
            <p className="muted">Você ainda não configurou. A senha é pedida na primeira conversa criptografada.</p>
          )}
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={() => void openE2eDialog('setup')}>
              Configurar agora
            </button>
          </div>
        </>
      )}
    </div>
  );
}
