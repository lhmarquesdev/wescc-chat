import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { OAuthProviderPublic, OAuthProviderType } from '@shared/index';
import { api, ApiError, errorMessage, getCredentials } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { clearLogoutReason, LOGOUT_REASON_ICON, LOGOUT_REASON_TEXT, peekLogoutReason } from '../lib/logoutReason';
import { login, loginWithOAuth, loginWithSaml, logout } from '../lib/session';
import { useSetting, useStore } from '../lib/store';
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
      {/* Padrão Atendeti: a arte da marca no lado claro e o formulário no painel azul. */}
      <aside className="auth-art">
        <BrandMark size={112} />
        <span className="auth-art-name">{site}</span>
        <p className="auth-art-line">Chat, chamadas e agenda da sua equipe em um só lugar.</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-logo">
            <BrandMark size={48} />
            <h1>{site}</h1>
          </div>
          {title && (
            <div className="auth-head">
              <span className="auth-eyebrow">Acesso restrito</span>
              <h2 className="auth-title">{title}</h2>
              {subtitle && <p className="auth-subtitle">{subtitle}</p>}
            </div>
          )}
          {children}
          {terms && <div className="auth-terms">{renderMarkdown(terms)}</div>}
          <div className="auth-foot">
            {site} © {new Date().getFullYear()} · Acesso restrito a usuários autorizados
            {version && ` · versão ${version}`}
          </div>
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
  // Código de backup tem letras: o campo troca o teclado numérico do celular pelo de texto.
  const [backupCode, setBackupCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const registration = useSetting<string>('Accounts_RegistrationForm');
  const saml = useSetting<boolean>('SAML_Enable');
  const samlLabel = useSetting<string>('SAML_Button_Label');
  const ldap = useSetting<boolean>('LDAP_Enable');
  const passwordReset = useSetting<boolean>('Accounts_PasswordReset');
  // Sem o envio de e-mails configurado o link nunca chegaria (valor calculado pelo servidor).
  const resetAvailable = useSetting<boolean>('Accounts_PasswordReset_Available') !== false;
  const [providers, setProviders] = useState<OAuthProviderPublic[]>([]);
  const next = safeNext(params.get('next'));
  // Saída forçada com motivo (conta desativada, sessão encerrada, criptografia redefinida): o aviso fica até a pessoa
  // entrar ou ir para outra tela. Apagar ao abrir perderia o aviso no recarregamento que vem logo depois da saída.
  const [reason] = useState(peekLogoutReason);
  useEffect(() => clearLogoutReason, []);

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
    const before = getCredentials();
    try {
      await login(user.trim(), password, needCode ? code : undefined);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.errorType === 'totp-required') setNeedCode(true);
      // O login passou (credencial nova) e só a abertura falhou sem recusar a sessão (limite de requisições, queda):
      // segue para o chat, que abre a sessão de novo sozinho (sem o "me" pela metade), em vez de pedir outro login.
      else if (getCredentials() && getCredentials() !== before && !(err instanceof ApiError && err.status === 401)) {
        useStore.getState().setMe(null);
        navigate(next, { replace: true });
      }
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={needCode ? 'Verificação em duas etapas' : 'Bem-vindo de volta'}
      subtitle={needCode ? (backupCode ? 'Digite um dos códigos de backup que você guardou.' : 'Digite o código do seu aplicativo autenticador.') : ldap ? 'Use seu usuário de rede ou e-mail corporativo.' : 'Use seu usuário ou e-mail corporativo.'}
    >
      <form onSubmit={submit} className="form auth-form">
        {reason && !error && (
          <div className="callout info" role="status">
            <Icon name={LOGOUT_REASON_ICON[reason]} />
            <span>{LOGOUT_REASON_TEXT[reason]}</span>
          </div>
        )}
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
              <div className="auth-row">{resetAvailable ? <Link to="/forgot-password">Esqueci minha senha</Link> : <span>Esqueceu a senha? Fale com o administrador.</span>}</div>
            )}
          </>
        ) : (
          <>
            <Field
              label={backupCode ? 'Código de backup' : 'Código de verificação'}
              hint={backupCode ? 'Cada código vale uma vez. Maiúsculas, espaços e hífen não importam.' : 'O código de 6 dígitos do aplicativo autenticador.'}
            >
              <input
                key={backupCode ? 'backup' : 'app'}
                autoFocus
                inputMode={backupCode ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <div className="auth-row">
              <button type="button" className="link" onClick={() => (setBackupCode(!backupCode), setCode(''))}>
                {backupCode ? 'Usar o código do aplicativo' : 'Usar um código de backup'}
              </button>
            </div>
          </>
        )}
        <button type="submit" className="btn primary lg full block" aria-busy={busy || undefined} disabled={busy || !user || !password}>
          {busy && <span className="spinner sm" aria-hidden="true" />}
          {needCode ? 'Verificar' : 'Entrar'}
        </button>
        {needCode && (
          <button type="button" className="btn ghost full" onClick={() => (setNeedCode(false), setCode(''), setBackupCode(false), setError(''))}>
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

// Com o AD ligado, o link vale só para contas com senha do chat (as de rede trocam a senha pelo procedimento da TI).
// Não diz se o e-mail digitado é de uma conta de rede.
function LdapResetNote() {
  return (
    <div className="callout info">
      <Icon name="info" />
      <span>Se você entra com o usuário de rede (AD), troque a senha pelo procedimento da TI: a redefinição por aqui vale só para contas do chat.</span>
    </div>
  );
}

export function ForgotPasswordPage() {
  const ldap = useSetting<boolean>('LDAP_Enable');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const available = useSetting<boolean>('Accounts_PasswordReset_Available') !== false;
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
        {ldap && <LdapResetNote />}
        <Link className="btn lg full" to="/login">
          <Icon name="back" />
          Voltar ao login
        </Link>
      </AuthShell>
    );
  if (!available)
    return (
      <AuthShell title="Esqueci minha senha" subtitle="Este chat não envia e-mails. Peça ao administrador para redefinir a sua senha.">
        {ldap && <LdapResetNote />}
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
        {ldap && <LdapResetNote />}
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
          <span>Por segurança, todas as sessões abertas foram encerradas e os tokens de acesso foram revogados.</span>
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

// Nome de usuário aceito pelo servidor (validateUsername).
const USERNAME_RE = /^[0-9a-zA-Z._-]{2,40}$/;
type RegisterForm = { name: string; username: string; email: string; pass: string; confirm: string };

// Conferência antes de enviar, campo a campo, com o texto que a pessoa entende (o servidor confere de novo).
function registerErrors(f: RegisterForm): Partial<Record<keyof RegisterForm, string>> {
  const e: Partial<Record<keyof RegisterForm, string>> = {};
  if (!f.name.trim()) e.name = 'Preencha o seu nome.';
  else if (f.name.trim().length > 80) e.name = 'O nome pode ter até 80 caracteres.';
  if (!f.username) e.username = 'Preencha o nome de usuário.';
  else if (!USERNAME_RE.test(f.username)) e.username = 'Use de 2 a 40 letras sem acento, números, ponto, hífen ou sublinhado.';
  if (!f.email.trim()) e.email = 'Preencha o e-mail.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Digite um e-mail válido, como nome@empresa.com.br.';
  if (!f.pass) e.pass = 'Crie uma senha.';
  else if (!f.pass.trim()) e.pass = 'A senha não pode ter só espaços.';
  if (f.pass && f.confirm !== f.pass) e.confirm = 'As senhas não conferem.';
  return e;
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { secret } = useParams();
  const [f, setF] = useState<RegisterForm>({ name: '', username: '', email: '', pass: '', confirm: '' });
  const [error, setError] = useState('');
  // Erros por campo: aparecem depois da primeira tentativa de enviar e somem conforme a pessoa corrige.
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const minLen = useSetting<number>('Accounts_Password_Policy_MinLength');
  const registration = useSetting<string>('Accounts_RegistrationForm');
  const errs = tried ? registerErrors(f) : {};

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setTried(true);
    const found = registerErrors(f);
    const first = (['name', 'username', 'email', 'pass', 'confirm'] as const).find((k) => found[k]);
    if (first) {
      document.querySelector<HTMLInputElement>(`.auth-form [name="${first}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.post('users.register', { name: f.name.trim(), username: f.username, email: f.email.trim(), pass: f.pass, secretURL: secret });
      try {
        await login(f.username, f.pass);
        navigate('/home');
      } catch {
        setDone(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
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
  // Só pelo link secreto e o endereço veio sem ele: avisa antes de a pessoa preencher tudo.
  if (registration === 'Secret' && !secret)
    return (
      <AuthShell title="Cadastro só pelo link" subtitle="O cadastro é feito só pelo link enviado pela empresa. Peça o link ao administrador.">
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
      <form onSubmit={submit} className="form auth-form" noValidate>
        {error && <FormError>{error}</FormError>}
        <Field label="Nome" error={errs.name}>
          <input autoFocus name="name" required autoComplete="name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Nome de usuário" hint={errs.username ? undefined : 'Letras sem acento, números, ponto, hífen e sublinhado (2 a 40).'} error={errs.username}>
          <input
            name="username"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={f.username}
            onChange={(e) => setF({ ...f, username: e.target.value.replace(/\s/g, '.') })}
          />
        </Field>
        <Field label="E-mail" error={errs.email}>
          <input name="email" type="email" required autoComplete="email" autoCapitalize="none" spellCheck={false} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Senha" hint={errs.pass ? undefined : `Mínimo de ${minLen} caracteres.`} error={errs.pass}>
          <PasswordInput name="pass" required autoComplete="new-password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} />
        </Field>
        <Field label="Confirmar senha" error={errs.confirm}>
          <PasswordInput name="confirm" required autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
        <button className="btn primary lg full block" aria-busy={busy || undefined} disabled={busy}>
          {busy && <span className="spinner sm" aria-hidden="true" />}
          Criar conta
        </button>
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
  const navigate = useNavigate();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!p1) return setError('Digite a nova senha.');
    if (p1 !== p2) return setError('As senhas não conferem.');
    setBusy(true);
    setError('');
    try {
      await api.post('users.updateOwnBasicInfo', { data: { newPassword: p1, currentPassword: '' } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Defina uma nova senha" subtitle="O administrador pediu que você troque a sua senha antes de continuar.">
      <form className="form auth-form" onSubmit={submit}>
        {error && <FormError>{error}</FormError>}
        <Field label="Nova senha">
          <PasswordInput autoFocus autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} />
        </Field>
        <Field label="Confirmar nova senha">
          <PasswordInput autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        <button className="btn primary lg full block" aria-busy={busy || undefined} disabled={busy || !p1}>
          {busy && <span className="spinner sm" aria-hidden="true" />}
          Salvar
        </button>
        {/* Conta errada ou computador compartilhado: sair sem trocar a senha, como na tela do 2FA obrigatório. */}
        <button type="button" className="btn ghost full" onClick={() => void logout().then(() => navigate('/login'))}>
          <Icon name="logout" />
          Sair
        </button>
      </form>
    </AuthShell>
  );
}
