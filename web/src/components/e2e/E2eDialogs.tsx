// Diálogos da criptografia de ponta a ponta: configurar, desbloquear, redefinir, trocar a senha e "Saiba mais".
// Abrem de qualquer lugar (banner, compositor, Minha conta, criar grupo) por openE2eDialog, numa raiz própria como o
// confirmDialog.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { E2E_MIN_OWN_PASSWORD } from '@shared/e2e';
import { ApiError, errorMessage } from '../../lib/api';
import { changePassword, E2E_UI, generatePassphrase, resetOwnKeys, setupKeys, tooManyIn, unlock, useE2e } from '../../lib/e2e/client';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Field, Modal } from '../ui';
import './e2e.css';

export type E2eDialogKind = 'setup' | 'unlock' | 'reset' | 'info' | 'password';

type Request = { kind: E2eDialogKind; resolve: (ok: boolean) => void };
let current: Request | null = null;
let listener: (() => void) | null = null;
let hostReady = false;

function E2eHost() {
  const [, render] = useState(0);
  useEffect(() => {
    listener = () => render((n) => n + 1);
    return () => {
      listener = null;
    };
  }, []);
  const req = current;
  if (!req) return null;
  const done = (ok: boolean) => {
    if (current !== req) return;
    current = null;
    req.resolve(ok);
    render((n) => n + 1);
  };
  // Um diálogo leva a outro (Esqueci a senha → redefinir → configurar): a mesma promessa segue até o fim.
  const go = (kind: E2eDialogKind) => {
    current = { kind, resolve: req.resolve };
    render((n) => n + 1);
  };
  const props = { onDone: done, go };
  switch (req.kind) {
    case 'setup':
      return <SetupModal key="setup" {...props} />;
    case 'unlock':
      return <UnlockModal key="unlock" {...props} />;
    case 'reset':
      return <ResetModal key="reset" {...props} />;
    case 'password':
      return <PasswordModal key="password" {...props} />;
    default:
      return <InfoModal key="info" onDone={done} />;
  }
}

// Resolve true quando a criptografia termina pronta neste navegador (ou o "Saiba mais" fecha).
export function openE2eDialog(kind: E2eDialogKind): Promise<boolean> {
  return new Promise((resolve) => {
    current?.resolve(false);
    current = { kind, resolve };
    if (!hostReady) {
      hostReady = true;
      const host = document.createElement('div');
      host.id = 'e2e-root';
      document.body.appendChild(host);
      createRoot(host).render(<E2eHost />);
    } else listener?.();
  });
}

// Antes de ligar, criar um grupo criptografado ou escrever: configura ou desbloqueia, se precisar.
export async function requireE2eReady(): Promise<boolean> {
  let st = useE2e.getState().status;
  for (let i = 0; st === 'loading' && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = useE2e.getState().status;
  }
  if (st === 'ready') return true;
  if (st === 'unsupported') {
    useStore.getState().toast(E2E_UI.unsupported, 'error');
    return false;
  }
  return (await openE2eDialog(st === 'none' ? 'setup' : 'unlock')) && useE2e.getState().status === 'ready';
}

interface DialogProps {
  onDone: (ok: boolean) => void;
  go: (kind: E2eDialogKind) => void;
}

const fieldProps = { autoComplete: 'off', spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } as const;

// Senha escolhida pela pessoa: os erros aparecem ao sair do campo (ou ao tentar concluir), não a cada tecla; depois
// disso acompanham o que ela digita.
function useOwnPassword(p1: string, p2: string) {
  const [left1, setLeft1] = useState(false);
  const [left2, setLeft2] = useState(false);
  const [tried, setTried] = useState(false);
  const short = p1.length < E2E_MIN_OWN_PASSWORD;
  return {
    valid: !short && p1 === p2,
    shortErr: (left1 || tried) && short ? 'A senha precisa ter pelo menos 12 caracteres.' : undefined,
    matchErr: (left2 || tried) && !short && p1 !== p2 ? 'As senhas não conferem.' : undefined,
    blur1: () => p1 && setLeft1(true),
    blur2: () => p2 && setLeft2(true),
    tried: () => setTried(true),
  };
}

// O que não se recupera: a mesma frase na senha gerada e na escolhida.
const NO_RECOVERY = 'O chat não mostra de novo nem recupera esta senha. Guarde em lugar seguro: sem ela, as mensagens criptografadas antigas ficam ilegíveis.';

// ---------- Configurar ----------

function SetupModal({ onDone, go }: DialogProps) {
  const phone = useIsPhone();
  const pass = useMemo(() => generatePassphrase(), []);
  const [own, setOwn] = useState(false);
  const [saved, setSaved] = useState(false);
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useOwnPassword(p1, p2);
  const valid = own ? check.valid : saved;
  // Um administrador redefiniu: o motivo, antes de pedir a senha nova.
  const resetByAdmin = useStore((s) => !!s.me?.e2eResetByAdmin);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pass);
      useStore.getState().toast('Senha copiada.', 'success');
    } catch {
      useStore.getState().toast('Não foi possível copiar. Selecione a senha e copie.', 'error');
    }
  };
  const finish = async () => {
    if (own) check.tried();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await setupKeys(own ? p1 : pass);
      useStore.getState().toast('Criptografia configurada.', 'success');
      onDone(true);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      // Outro aparelho configurou antes: a senha que vale é a de lá.
      if (e instanceof ApiError && e.status === 409) go('unlock');
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Configurar a criptografia"
      variant={phone ? 'fullscreen' : undefined}
      onClose={() => onDone(false)}
      className="e2e-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!valid || busy} onClick={finish}>
            {busy ? 'Configurando…' : 'Concluir'}
          </button>
        </>
      }
    >
      {resetByAdmin && (
        <div className="callout warn e2e-reset-note">
          <Icon name="e2e-warning" />
          <span>{E2E_UI.resetByAdmin}</span>
        </div>
      )}
      {!own ? (
        <div className="e2e-setup">
          <p className="e2e-lead">
            Esta é a sua senha da criptografia. Ela abre as conversas criptografadas em qualquer navegador. Guarde em lugar seguro: o chat não mostra de novo nem
            recupera.
          </p>
          <div className="e2e-pass" aria-label={`Senha da criptografia: ${pass}`}>
            {pass.split('-').map((g, i) => (
              <span key={i} className="e2e-pass-group">
                {g}
              </span>
            ))}
          </div>
          <button type="button" className={`btn${phone ? ' block' : ''}`} onClick={copy}>
            <Icon name="copy" size={16} />
            Copiar
          </button>
          <label className="check e2e-saved">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            Guardei a senha em lugar seguro
          </label>
          <button type="button" className="link e2e-switch" onClick={() => setOwn(true)}>
            Prefiro escolher a minha senha
          </button>
        </div>
      ) : (
        <form
          className="form e2e-setup"
          onSubmit={(e) => {
            e.preventDefault();
            void finish();
          }}
        >
          <div className="callout warn">
            <Icon name="e2e-key" />
            <span>{NO_RECOVERY}</span>
          </div>
          <Field label="Sua senha" hint="Pelo menos 12 caracteres. Não use a senha de entrar no chat." error={check.shortErr}>
            <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} onBlur={check.blur1} {...fieldProps} autoFocus />
          </Field>
          <Field label="Repita a senha" error={check.matchErr}>
            <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} onBlur={check.blur2} {...fieldProps} />
          </Field>
          <button type="button" className="link e2e-switch" onClick={() => setOwn(false)}>
            Usar a senha gerada
          </button>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

// ---------- Desbloquear ----------

function UnlockModal({ onDone, go }: DialogProps) {
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const waitUntil = useE2e((s) => s.waitUntil);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  // Muitas senhas erradas: contagem regressiva no lugar do erro; ao acabar, o erro some e o botão volta.
  const left = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const waiting = left > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [waiting]);
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (wasWaiting.current && !waiting) {
      setErr('');
      input.current?.focus();
    }
    wasWaiting.current = waiting;
  }, [waiting]);
  useEffect(() => input.current?.focus(), []);
  const submit = async () => {
    if (!pass || busy || waiting) return;
    setBusy(true);
    setErr('');
    try {
      await unlock(pass);
      onDone(true);
    } catch (e) {
      setErr(errorMessage(e));
      setNow(Date.now());
      setBusy(false);
      input.current?.select();
    }
  };
  return (
    <Modal
      title="Desbloquear a criptografia"
      variant="sheet"
      onClose={() => onDone(false)}
      className="e2e-modal"
      footer={
        <>
          <button type="button" className="link e2e-forgot" onClick={() => go('reset')}>
            Esqueci a senha
          </button>
          <button type="button" className="btn primary" disabled={!pass || busy || waiting} onClick={submit}>
            {busy ? 'Desbloqueando…' : 'Desbloquear'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="e2e-lead">Digite a senha da criptografia para ler e escrever nas conversas criptografadas neste navegador.</p>
        <Field label="Senha da criptografia" error={waiting ? tooManyIn(left) : err || undefined}>
          <input
            ref={input}
            type="password"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
              if (err) setErr('');
            }}
            {...fieldProps}
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------- Redefinir ----------

function ResetModal({ onDone, go }: DialogProps) {
  const me = useStore((s) => s.me)!;
  const twoFAOn = useSetting<boolean>('Accounts_TwoFactorAuthentication_Enabled') !== false;
  const needsPassword = !me.authSource || me.authSource === 'local';
  const needsCode = !!me.twoFactorEnabled && twoFAOn;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ password?: string; code?: string; other?: string }>({});
  const ready = (!needsPassword || !!password) && (!needsCode || !!code);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr({});
    try {
      await resetOwnKeys({ password, code });
      useStore.getState().toast('Criptografia redefinida. Crie a senha nova.', 'success');
      go('setup');
    } catch (e) {
      const t = e instanceof ApiError ? e.errorType : '';
      setErr(t === 'error-invalid-password' ? { password: errorMessage(e) } : t === 'invalid-totp' ? { code: errorMessage(e) } : { other: errorMessage(e) });
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Redefinir a criptografia?"
      variant="sheet"
      onClose={() => onDone(false)}
      className="e2e-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancelar
          </button>
          <button type="button" className="btn danger solid" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Redefinindo…' : 'Redefinir'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="e2e-lead">
          Você cria uma senha nova e deixa de ler as mensagens criptografadas antigas, em todas as conversas. As outras pessoas continuam lendo normalmente.
        </p>
        {needsPassword && (
          <Field label="Senha de entrar no chat" error={err.password}>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
        )}
        {needsCode && (
          <Field label="Código do 2FA" error={err.code}>
            <input
              className="otp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
              autoFocus={!needsPassword}
            />
          </Field>
        )}
        {err.other && (
          <div className="callout err">
            <Icon name="error" />
            <span>{err.other}</span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------- Trocar a senha ----------

function PasswordModal({ onDone }: DialogProps) {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = useOwnPassword(p1, p2);
  const ready = !!cur && check.valid;
  const submit = async () => {
    check.tried();
    if (!ready || busy) return;
    setBusy(true);
    setErr('');
    try {
      await changePassword(cur, p1);
      useStore.getState().toast('Senha da criptografia trocada.', 'success');
      onDone(true);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Trocar a senha da criptografia"
      onClose={() => onDone(false)}
      className="e2e-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(false)}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Trocando…' : 'Trocar senha'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Senha atual da criptografia" error={err}>
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} {...fieldProps} autoFocus />
        </Field>
        <Field label="Nova senha" hint="Pelo menos 12 caracteres. Não use a senha de entrar no chat." error={check.shortErr}>
          <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} onBlur={check.blur1} {...fieldProps} />
        </Field>
        <Field label="Confirmar nova senha" error={check.matchErr}>
          <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} onBlur={check.blur2} {...fieldProps} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------- Saiba mais ----------

const INFO = [
  'As mensagens e os arquivos desta conversa são cifrados no seu navegador. O servidor guarda só o conteúdo cifrado.',
  'Nem os administradores leem. Eles veem só que a conversa é criptografada, quem participa e quando houve mensagens.',
  'Cada navegador pede a sua senha da criptografia uma vez. Ao sair da conta, o navegador esquece.',
  'Não funcionam aqui: busca no servidor, prévias do Jira, figurinhas, bots e integrações. Push e e-mail dizem só “Mensagem criptografada”.',
  'Chamadas de voz e vídeo não são cifradas de ponta a ponta.',
  'Esqueceu a senha? Dá para redefinir, mas as mensagens antigas ficam ilegíveis para você.',
  'Quem sai da conversa e volta só lê o que vier depois da volta. Quem é novo na conversa lê o histórico.',
  'A proteção vale contra quem lê o banco de dados ou os backups. Ela depende de o servidor do chat ser o original.',
];

function InfoModal({ onDone }: { onDone: (ok: boolean) => void }) {
  return (
    <Modal
      title="Criptografia de ponta a ponta"
      variant="sheet"
      onClose={() => onDone(true)}
      className="e2e-modal"
      footer={
        <button type="button" className="btn primary" onClick={() => onDone(true)}>
          Entendi
        </button>
      }
    >
      <ul className="e2e-info">
        {INFO.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Modal>
  );
}
