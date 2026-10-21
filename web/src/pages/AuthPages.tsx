import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { OAuthProviderPublic } from '@shared/index';
import { api, ApiError, errorMessage, getCredentials } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { login, loginWithOAuth, loginWithSaml } from '../lib/session';
import { useSetting } from '../lib/store';
import { confirmAction, Field } from '../components/ui';

function AuthShell({ children }: { children: React.ReactNode }) {
  const site = useSetting<string>('Site_Name');
  const terms = useSetting<string>('Layout_Login_Terms');
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/favicon.svg" width={48} height={48} alt="" />
          <h1>{site}</h1>
        </div>
        {children}
        {terms && <div className="auth-terms">{renderMarkdown(terms)}</div>}
      </div>
    </div>
  );
}

const safeNext = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') && !/[\\\x00-\x1f]/.test(v) ? v : '/home');

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const registration = useSetting<string>('Accounts_RegistrationForm');
  const saml = useSetting<boolean>('SAML_Enable');
  const samlLabel = useSetting<string>('SAML_Button_Label');
  const ldap = useSetting<boolean>('LDAP_Enable');
  const [providers, setProviders] = useState<OAuthProviderPublic[]>([]);
  const next = safeNext(params.get('next'));

  useEffect(() => {
    void api
      .get('oauth-providers.public')
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, []);

  // Retorno do SSO (SAML ou OAuth): credencial de uso único na URL, trocada por uma sessão.
  useEffect(() => {
    const saml = params.get('saml');
    const oauth = params.get('oauth');
    if (!saml && !oauth) return;
    // Já há uma sessão neste navegador: só troca de conta se a pessoa confirmar.
    if (getCredentials() && !confirmAction('Você já está conectado neste navegador. Entrar com a conta do login que acabou de fazer?')) {
      navigate(next, { replace: true });
      return;
    }
    setBusy(true);
    (saml ? loginWithSaml(saml) : loginWithOAuth(oauth!))
      .then(() => navigate(next, { replace: true }))
      .catch((err) => (setError(errorMessage(err)), setBusy(false), navigate('/login', { replace: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(user, password, needCode ? code : undefined);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.errorType === 'totp-required') setNeedCode(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="form">
        {!needCode ? (
          <>
            <Field label={ldap ? 'Usuário de rede ou e-mail' : 'Usuário ou e-mail'}>
              <input autoFocus autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field label="Senha">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field label="Código de verificação" hint="Digite o código de 6 dígitos do seu aplicativo autenticador ou um código de backup.">
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn primary block" disabled={busy || !user || !password}>
          {needCode ? 'Verificar' : 'Entrar'}
        </button>
        {!needCode && (saml || providers.length > 0) && (
          <>
            <div className="auth-sep">
              <span>ou</span>
            </div>
            {saml && (
              <a className="btn block sso-btn" href={`/saml/login?redirect=${encodeURIComponent(next)}`}>
                🔐 {samlLabel}
              </a>
            )}
            {providers.map((p) => (
              <a
                key={p._id}
                className="btn block sso-btn"
                style={{ background: p.buttonColor, color: p.buttonTextColor }}
                href={`/oauth/${encodeURIComponent(p._id)}/login?redirect=${encodeURIComponent(next)}`}
              >
                {p.label || 'Entrar'}
              </a>
            ))}
          </>
        )}
        {registration === 'Public' && (
          <div className="auth-alt">
            Não tem conta? <Link to="/register">Cadastre-se</Link>
          </div>
        )}
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { secret } = useParams();
  const [f, setF] = useState({ name: '', username: '', email: '', pass: '', confirm: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const minLen = useSetting<number>('Accounts_Password_Policy_MinLength');
  const registration = useSetting<string>('Accounts_RegistrationForm');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (f.pass !== f.confirm) return setError('As senhas não conferem.');
    try {
      await api.post('users.register', { name: f.name, username: f.username, email: f.email, pass: f.pass, secretURL: secret });
      try {
        await login(f.username, f.pass);
        navigate('/home');
      } catch {
        setDone(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (registration === 'Disabled') return <AuthShell><p>O cadastro está desativado. Peça um convite ao administrador.</p><Link to="/login">Voltar</Link></AuthShell>;
  if (done)
    return (
      <AuthShell>
        <p>Cadastro recebido. Sua conta precisa ser aprovada por um administrador.</p>
        <Link to="/login">Voltar ao login</Link>
      </AuthShell>
    );
  return (
    <AuthShell>
      <form onSubmit={submit} className="form">
        <Field label="Nome">
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Nome de usuário">
          <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.replace(/\s/g, '.') })} />
        </Field>
        <Field label="E-mail">
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Senha" hint={`Mínimo de ${minLen} caracteres.`}>
          <input type="password" autoComplete="new-password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} />
        </Field>
        <Field label="Confirmar senha">
          <input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary block">Criar conta</button>
        <div className="auth-alt">
          Já tem conta? <Link to="/login">Entrar</Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function InvitePage({ loggedIn }: { loggedIn: boolean }) {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api.post('validateInviteToken', { token }).then(setInfo).catch((e) => setError(errorMessage(e)));
  }, [token]);
  const accept = async () => {
    try {
      const r = await api.post('useInviteToken', { token });
      navigate(r.room.t === 'p' ? `/group/${r.room.rid}` : `/channel/${r.room.rid}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <AuthShell>
      {error && <div className="form-error">{error}</div>}
      {info && !info.valid && <p>Este convite é inválido ou expirou.</p>}
      {info?.valid && (
        <div className="form">
          <p>
            Você foi convidado para <strong>{info.room.fname || info.room.name}</strong>.
          </p>
          {loggedIn ? (
            <button className="btn primary block" onClick={accept}>
              Entrar na sala
            </button>
          ) : (
            <Link className="btn primary block" to={`/login?next=/invite/${token}`}>
              Entrar para aceitar
            </Link>
          )}
        </div>
      )}
    </AuthShell>
  );
}

export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (p1 !== p2) return setError('As senhas não conferem.');
    try {
      await api.post('users.updateOwnBasicInfo', { data: { newPassword: p1, currentPassword: '' } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <AuthShell>
      <form className="form" onSubmit={submit}>
        <p>O administrador pediu que você defina uma nova senha.</p>
        <Field label="Nova senha">
          <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} />
        </Field>
        <Field label="Confirmar">
          <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary block">Salvar</button>
      </form>
    </AuthShell>
  );
}
