import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { endSession } from '../lib/session';
import { useSetting, useStore } from '../lib/store';
import { Avatar, Field, Spinner, Toggle, useAsync } from '../components/ui';
import { QrCode } from '../components/QrCode';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export function AccountPage() {
  const { section = 'profile' } = useParams();
  const canTokens = useStore((s) => s.me?.permissions.includes('create-personal-access-tokens'));
  return (
    <div className="page with-nav">
      <nav className="page-nav">
        <h2>Minha conta</h2>
        <NavLink to="/account/profile">👤 Perfil</NavLink>
        <NavLink to="/account/preferences">🎛 Preferências</NavLink>
        <NavLink to="/account/security">🔐 Segurança</NavLink>
        <NavLink to="/account/devices">💻 Dispositivos</NavLink>
        {canTokens && <NavLink to="/account/tokens">🔑 Tokens de acesso</NavLink>}
      </nav>
      <div className="page-body">
        {section === 'profile' && <Profile />}
        {section === 'preferences' && <Preferences />}
        {section === 'security' && <Security />}
        {section === 'devices' && <Devices />}
        {section === 'tokens' && <Tokens />}
      </div>
    </div>
  );
}

function Profile() {
  const me = useStore((s) => s.me)!;
  const allowUsername = useSetting<boolean>('Accounts_AllowUsernameChange');
  const allowEmail = useSetting<boolean>('Accounts_AllowEmailChange');
  const allowAvatar = useSetting<boolean>('Accounts_AllowUserAvatarChange');
  const allowDelete = useSetting<boolean>('Accounts_AllowDeleteOwnAccount');
  const [f, setF] = useState({ name: me.name, username: me.username, email: me.email ?? '', bio: me.bio ?? '', statusText: me.statusText ?? '' });
  const save = async () => {
    try {
      const r = await api.post('users.updateOwnBasicInfo', { data: f });
      useStore.getState().setMe({ ...me, ...r.user });
      ok('Perfil atualizado.');
    } catch (e) {
      fail(e);
    }
  };
  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('image', file);
    await api.post('users.setAvatar', fd).then(() => ok('Foto atualizada.')).catch(fail);
  };
  const ldap = me.authSource === 'ldap';
  return (
    <div className="card form narrow">
      <h2>Perfil</h2>
      <div className="avatar-edit">
        <Avatar username={me.username} size={96} etag={me.avatarETag} />
        {allowAvatar && (
          <div>
            <label className="btn">
              Trocar foto
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
            <button className="btn" onClick={() => api.post('users.resetAvatar').catch(fail)}>
              Remover
            </button>
          </div>
        )}
      </div>
      {ldap && <div className="muted small">Sua conta é sincronizada com o diretório da empresa (LDAP); alguns campos são mantidos por lá.</div>}
      <Field label="Nome">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={ldap} />
      </Field>
      <Field label="Nome de usuário">
        <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} disabled={!allowUsername || ldap} />
      </Field>
      <Field label="E-mail">
        <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!allowEmail || ldap} />
      </Field>
      <Field label="Mensagem de status">
        <input value={f.statusText} maxLength={120} onChange={(e) => setF({ ...f, statusText: e.target.value })} />
      </Field>
      <Field label="Bio">
        <textarea rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
      </Field>
      <button className="btn primary" onClick={save}>
        Salvar
      </button>
      {allowDelete && (
        <div className="danger-zone">
          <h3>Excluir conta</h3>
          <button
            className="btn danger"
            onClick={async () => {
              const password = prompt('Digite sua senha para confirmar a exclusão da conta:');
              if (!password) return;
              try {
                await api.post('users.deleteOwnAccount', { password });
                endSession();
                location.href = '/login';
              } catch (e) {
                fail(e);
              }
            }}
          >
            Excluir minha conta
          </button>
        </div>
      )}
    </div>
  );
}

function Preferences() {
  const me = useStore((s) => s.me)!;
  const [p, setP] = useState<Record<string, any>>({
    theme: 'auto',
    desktopNotifications: 'mentions',
    emailNotificationMode: 'mentions',
    notificationSound: true,
    sendOnEnter: true,
    ...me.preferences,
  });
  const save = async (patch: Record<string, unknown>) => {
    const next = { ...p, ...patch };
    setP(next);
    try {
      await api.post('users.setPreferences', { data: patch });
      useStore.getState().setMe({ ...me, preferences: next });
      if (patch.theme) applyTheme(String(patch.theme));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="card form narrow">
      <h2>Preferências</h2>
      <Field label="Tema">
        <select value={p.theme} onChange={(e) => save({ theme: e.target.value })}>
          <option value="auto">Automático (sistema)</option>
          <option value="light">Claro</option>
          <option value="dark">Escuro</option>
        </select>
      </Field>
      <Field label="Notificações na área de trabalho (padrão)">
        <select value={p.desktopNotifications} onChange={(e) => save({ desktopNotifications: e.target.value })}>
          <option value="all">Todas as mensagens</option>
          <option value="mentions">Só menções e DMs</option>
          <option value="nothing">Nada</option>
        </select>
      </Field>
      <Field label="E-mail quando offline">
        <select value={p.emailNotificationMode} onChange={(e) => save({ emailNotificationMode: e.target.value })}>
          <option value="mentions">Menções e DMs</option>
          <option value="nothing">Nunca</option>
        </select>
      </Field>
      <Toggle checked={p.notificationSound !== false} onChange={(v) => save({ notificationSound: v })} label="Som de notificação" />
      <Toggle checked={p.sendOnEnter !== false} onChange={(v) => save({ sendOnEnter: v })} label="Enter envia (Shift+Enter quebra linha)" />
      {'Notification' in window && Notification.permission !== 'granted' && (
        <button className="btn" onClick={() => Notification.requestPermission()}>
          Permitir notificações do navegador
        </button>
      )}
    </div>
  );
}

export function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

function Security() {
  const me = useStore((s) => s.me)!;
  const twoFA = useSetting<boolean>('Accounts_TwoFactorAuthentication_Enabled');
  const allowPassword = useSetting<boolean>('Accounts_AllowPasswordChange');
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const changePw = async () => {
    if (p1 !== p2) return fail(new Error('As senhas não conferem.'));
    try {
      await api.post('users.updateOwnBasicInfo', { data: { currentPassword: cur, newPassword: p1 } });
      setCur('');
      setP1('');
      setP2('');
      ok('Senha alterada.');
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      {allowPassword && me.authSource !== 'ldap' && (
        <div className="card form narrow">
          <h2>Senha</h2>
          <Field label="Senha atual">
            <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="Nova senha">
            <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirmar nova senha">
            <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
          </Field>
          <button className="btn primary" onClick={changePw} disabled={!p1}>
            Alterar senha
          </button>
        </div>
      )}
      {twoFA && (
        <div className="card form narrow">
          <h2>Autenticação em dois fatores</h2>
          {codes ? (
            <>
              <p>2FA ativado. Guarde estes códigos de backup em local seguro; cada um funciona uma vez:</p>
              <pre className="codes">{codes.join('\n')}</pre>
              <button className="btn" onClick={() => setCodes(null)}>
                Pronto
              </button>
            </>
          ) : me.twoFactorEnabled ? (
            <>
              <p>✅ Ativado com aplicativo autenticador.</p>
              <Field label="Código atual para desativar">
                <input value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <button
                className="btn danger"
                onClick={() =>
                  api
                    .post('users.2fa.disableTotp', { code })
                    .then(() => (useStore.getState().setMe({ ...me, twoFactorEnabled: false }), setCode(''), ok('2FA desativado.')))
                    .catch(fail)
                }
              >
                Desativar 2FA
              </button>
            </>
          ) : setup ? (
            <>
              <p>Escaneie o QR code no seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…):</p>
              <QrCode text={setup.url} size={200} />
              <p className="muted small">
                Ou digite a chave manualmente: <code>{setup.secret}</code>
              </p>
              <Field label="Código gerado pelo aplicativo">
                <input autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <button
                className="btn primary"
                onClick={() =>
                  api
                    .post('users.2fa.verifyTotp', { code })
                    .then((r) => (setCodes(r.codes), setSetup(null), setCode(''), useStore.getState().setMe({ ...me, twoFactorEnabled: true })))
                    .catch(fail)
                }
              >
                Verificar e ativar
              </button>
            </>
          ) : (
            <>
              <p>Proteja sua conta exigindo um código do celular no login.</p>
              <button className="btn primary" onClick={() => api.post('users.2fa.enableTotp').then(setSetup).catch(fail)}>
                Ativar 2FA
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function Devices() {
  const { data, loading, reload } = useAsync(() => api.get('sessions.list', { count: 100 }), []);
  const allowAll = useSetting<boolean>('Device_Management_Allow_Logout_All');
  return (
    <div className="card">
      <h2>Dispositivos conectados</h2>
      <p className="muted">Cada login cria uma sessão. Encerre as que você não reconhece.</p>
      {allowAll && (
        <button className="btn" onClick={() => api.post('sessions.logout.others').then((r) => (ok(`${r.removed} sessões encerradas.`), reload())).catch(fail)}>
          Encerrar todas as outras sessões
        </button>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Dispositivo</th>
              <th>IP</th>
              <th>Último uso</th>
              <th>Login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.sessions.map((s: any) => (
              <tr key={s._id}>
                <td>
                  {s.device.os === 'Android' || s.device.os === 'iOS' ? '📱' : '💻'} {s.device.name}
                  {s.current && <span className="pill accent">esta sessão</span>}
                </td>
                <td className="muted">{s.device.ip}</td>
                <td>{formatDateTime(s.lastActiveAt)}</td>
                <td className="muted">{formatDateTime(s.createdAt)}</td>
                <td>
                  {!s.current && (
                    <button className="btn small danger" onClick={() => api.post('sessions.logout.me', { sessionId: s._id }).then(reload).catch(fail)}>
                      Encerrar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Tokens() {
  const { data, loading, reload } = useAsync(() => api.get('users.getPersonalAccessTokens'), []);
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState('');
  const [bypass, setBypass] = useState(false);
  const [token, setToken] = useState('');
  return (
    <div className="card form">
      <h2>Tokens de acesso pessoal</h2>
      <p className="muted">
        Use em integrações com os cabeçalhos <code>X-User-Id: {me._id}</code> e <code>X-Auth-Token: &lt;token&gt;</code>.
      </p>
      <div className="row-actions">
        <input placeholder="Nome do token" value={name} onChange={(e) => setName(e.target.value)} />
        <Toggle checked={bypass} onChange={setBypass} label="Ignorar 2FA" />
        <button className="btn primary" disabled={!name} onClick={() => api.post('users.generatePersonalAccessToken', { tokenName: name, bypassTwoFactor: bypass }).then((r) => (setToken(r.token), setName(''), reload())).catch(fail)}>
          Gerar
        </button>
      </div>
      {token && (
        <div className="copy-box">
          <span>Copie agora, ele não será mostrado de novo:</span>
          <input readOnly value={token} onFocus={(e) => e.target.select()} />
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Criado</th>
              <th>Último uso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.tokens.map((t: any) => (
              <tr key={t._id}>
                <td>{t.name}</td>
                <td>{formatDateTime(t.createdAt)}</td>
                <td>{formatDateTime(t.lastUsedAt)}</td>
                <td>
                  <button className="btn small danger" onClick={() => api.post('users.removePersonalAccessToken', { tokenName: t.name }).then(reload).catch(fail)}>
                    Revogar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
