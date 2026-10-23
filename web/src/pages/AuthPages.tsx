import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { OAuthProviderPublic, OAuthProviderType } from '@shared/index';
import { api, ApiError, errorMessage, getCredentials } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { login, loginWithOAuth, loginWithSaml } from '../lib/session';
import { useSetting } from '../lib/store';
import { BrandMark, ProviderIcon } from '../components/BrandIcons';
import { Icon } from '../components/Icon';
import { confirmAction, Field } from '../components/ui';

// Versão do servidor para o rodapé da marca (uma busca por carregamento da página).
let versionLoad: Promise<string> | null = null;
function useVersion() {
  const [v, setV] = useState('');
  useEffect(() => {
    versionLoad ??= api
      .get('info')
      .then((r: { info?: { version?: string } }) => r.info?.version ?? '')
      .catch(() => '');
    let alive = true;
    void versionLoad.then((x) => alive && setV(x));
    return () => {
      alive = false;
    };
  }, []);
  return v;
}

// Tela de entrada: painel da marca à esquerda (telas largas) e o formulário alinhado no alto, à direita.
function AuthShell({ children, title, subtitle }: { children: ReactNode; title?: string; subtitle?: ReactNode }) {
  const site = useSetting<string>('Site_Name') || 'Wescc Chat';
  const terms = useSetting<string>('Layout_Login_Terms');
  const version = useVersion();
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-brand-top">
          <BrandMark size={40} />
          <span className="auth-brand-name">{site}</span>
        </div>
        <div className="auth-brand-copy">
          <p className="auth-headline">Toda a operação em uma só conversa.</p>
          <p className="auth-subline">Chat, chamadas e atendimento da sua equipe em um só lugar.</p>
        </div>
        <div className="auth-brand-foot">
          {site}
          {version && ` · versão ${version}`}
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-logo">
            <BrandMark size={48} />
            <h1>{site}</h1>
          </div>
          {title && (
            <div className="auth-head">
              <h2 className="auth-title">{title}</h2>
              {subtitle && <p className="auth-subtitle">{subtitle}</p>}
            </div>
          )}
          {children}
          {terms && <div className="auth-terms">{renderMarkdown(terms)}</div>}
        </div>
      </main>
    </div>
  );
}

// Erro do formulário, acima dos campos para o cartão não pular (a classe .form-error é a dos testes).
function FormError({ children }: { children: ReactNode }) {
  return (
    <div className="form-error" role="alert">
      <Icon name="error" size={16} />
      <span>{children}</span>
    </div>
  );
}

// Senha com o botão de mostrar/ocultar dentro do campo.
function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  const label = show ? 'Ocultar senha' : 'Mostrar senha';
  return (
    <span className="password-field">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="icon-btn" title={label} aria-label={label} aria-pressed={show} onClick={() => setShow(!show)}>
        <Icon name={show ? 'hide' : 'show'} />
      </button>
    </span>
  );
}

// O endpoint público não diz o tipo do provedor: o ícone sai do nome do botão.
function providerType(label: string): OAuthProviderType {
  if (/google/i.test(label)) return 'google';
  if (/github/i.test(label)) return 'github';
  if (/gitlab/i.test(label)) return 'gitlab';
  if (/microsoft|azure|entra|office/i.test(label)) return 'microsoft';
  return 'custom';
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
  const passwordReset = useSetting<boolean>('Accounts_PasswordReset');
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
    <AuthShell
      title={needCode ? 'Verificação em duas etapas' : 'Entrar'}
      subtitle={needCode ? 'Digite o código do seu aplicativo autenticador.' : ldap ? 'Use seu usuário de rede ou e-mail corporativo.' : 'Use seu usuário ou e-mail corporativo.'}
    >
      <form onSubmit={submit} className="form auth-form">
        {error && <FormError>{error}</FormError>}
        {!needCode ? (
          <>
            <Field label={ldap ? 'Usuário de rede ou e-mail' : 'Usuário ou e-mail'}>
              <input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field label="Senha">
              <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {passwordReset && (
              <div className="auth-row">
                <Link to="/forgot-password">Esqueci minha senha</Link>
              </div>
            )}
          </>
        ) : (
          <Field label="Código de verificação" hint="O código de 6 dígitos do aplicativo autenticador ou um código de backup.">
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <button type="submit" className="btn primary lg full block" aria-busy={busy || undefined} disabled={busy || !user || !password}>
          {busy && <span className="spinner sm" aria-hidden="true" />}
          {needCode ? 'Verificar' : 'Entrar'}
        </button>
        {needCode && (
          <button type="button" className="btn ghost full" onClick={() => (setNeedCode(false), setCode(''), setError(''))}>
            <Icon name="back" />
            Voltar
          </button>
        )}
        {!needCode && (saml || providers.length > 0) && (
          <>
            <div className="auth-sep">
              <span>ou</span>
            </div>
            {saml && (
              <a className="btn lg block sso-btn" href={`/saml/login?redirect=${encodeURIComponent(next)}`}>
                <Icon name="sso" size={18} />
                {samlLabel}
              </a>
            )}
            {providers.map((p) => (
              <a
                key={p._id}
                className="btn lg block sso-btn"
                style={{ background: p.buttonColor, color: p.buttonTextColor }}
                href={`/oauth/${encodeURIComponent(p._id)}/login?redirect=${encodeURIComponent(next)}`}
              >
                <ProviderIcon type={providerType(p.label)} size={18} />
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

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('users.forgotPassword', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <AuthShell title="Confira seu e-mail">
        <div className="callout ok">
          <Icon name="success" />
          <span>Se houver uma conta com o e-mail {email.trim()}, você vai receber em instantes um link para criar uma senha nova. O link vale por 1 hora.</span>
        </div>
        <Link className="btn lg full" to="/login">
          <Icon name="back" />
          Voltar ao login
        </Link>
      </AuthShell>
    );
  return (
    <AuthShell title="Esqueci minha senha" subtitle="Digite o e-mail da sua conta para receber um link de redefinição de senha.">
      <form onSubmit={submit} className="form auth-form">
        {error && <FormError>{error}</FormError>}
        <Field label="E-mail">
          <input autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <button className="btn primary lg full block" aria-busy={busy || undefined} disabled={busy || !email.trim()}>
          Enviar link
        </button>
        <div className="auth-alt">
          <Link to="/login">Voltar ao login</Link>
        </div>
      </form>
    </AuthShell>
  );
}

// Aberta pelo link do e-mail: /reset-password#token=...
export function ResetPasswordPage() {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const minLen = useSetting<number>('Accounts_Password_Policy_MinLength');
  // Tira o token da barra de endereço (histórico e capturas de tela).
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname);
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (p1 !== p2) return setError('As senhas não conferem.');
    try {
      await api.post('users.resetPassword', { token, password: p1 });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (!token)
    return (
      <AuthShell title="Link inválido" subtitle="Peça um novo link em “Esqueci minha senha”.">
        <Link className="btn primary lg full" to="/forgot-password">
          Esqueci minha senha
        </Link>
      </AuthShell>
    );
  if (done)
    return (
      <AuthShell title="Senha redefinida">
        <div className="callout ok">
          <Icon name="success" />
          <span>Por segurança, todas as sessões abertas foram encerradas.</span>
        </div>
        <Link className="btn primary lg full block" to="/login">
          Entrar
        </Link>
      </AuthShell>
    );
  return (
    <AuthShell title="Nova senha" subtitle="Crie uma senha nova para a sua conta.">
      <form onSubmit={submit} className="form auth-form">
        {error && <FormError>{error}</FormError>}
        <Field label="Nova senha" hint={`Mínimo de ${minLen} caracteres.`}>
          <PasswordInput autoFocus autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
        </Field>
        <Field label="Confirmar nova senha">
          <PasswordInput autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        <button className="btn primary lg full block" disabled={!p1}>
          Salvar senha
        </button>
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

  if (registration === 'Disabled')
    return (
      <AuthShell title="Cadastro desativado" subtitle="Peça um convite ao administrador.">
        <Link className="btn lg full" to="/login">
          <Icon name="back" />
          Voltar ao login
        </Link>
      </AuthShell>
    );
  if (done)
    return (
      <AuthShell title="Cadastro recebido">
        <div className="callout info">
          <Icon name="info" />
          <span>Sua conta precisa ser aprovada por um administrador.</span>
        </div>
        <Link className="btn lg full" to="/login">
          <Icon name="back" />
          Voltar ao login
        </Link>
      </AuthShell>
    );
  return (
    <AuthShell title="Criar conta" subtitle="Preencha seus dados para entrar no chat da sua equipe.">
      <form onSubmit={submit} className="form auth-form">
        {error && <FormError>{error}</FormError>}
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
          <PasswordInput autoComplete="new-password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} />
        </Field>
        <Field label="Confirmar senha">
          <PasswordInput autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
        <button className="btn primary lg full block">Criar conta</button>
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
    <AuthShell title={info && !info.valid ? 'Convite inválido' : 'Convite'}>
      {error && <FormError>{error}</FormError>}
      {!info && !error && <div className="spinner" role="status" aria-label="Carregando" />}
      {info && !info.valid && <p className="muted">Este convite é inválido ou expirou. Peça um novo a quem convidou você.</p>}
      {info?.valid && (
        <div className="form auth-form">
          <div className="auth-invite">
            <span className="auth-invite-icon">
              <Icon name={info.room.t === 'p' ? 'room-private' : 'room-channel'} size={20} />
            </span>
            <span>
              Você foi convidado para <strong>{info.room.fname || info.room.name}</strong>.
            </span>
          </div>
          {loggedIn ? (
            <button type="button" className="btn primary lg full block" onClick={accept}>
              Entrar na sala
            </button>
          ) : (
            <Link className="btn primary lg full block" to={`/login?next=/invite/${token}`}>
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
    <AuthShell title="Defina uma nova senha" subtitle="O administrador pediu que você troque a sua senha antes de continuar.">
      <form className="form auth-form" onSubmit={submit}>
        {error && <FormError>{error}</FormError>}
        <Field label="Nova senha">
          <PasswordInput autoFocus autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
        </Field>
        <Field label="Confirmar">
          <PasswordInput autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        <button className="btn primary lg full block">Salvar</button>
      </form>
    </AuthShell>
  );
}
