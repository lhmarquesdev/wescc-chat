import { useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { disablePushHere, enablePushHere, pushEnabledHere, pushSupported, syncPushSubscription } from '../lib/push';
import { endSession, startSession } from '../lib/session';
import { useSetting, useStore } from '../lib/store';
import { Avatar, Empty, Field, Modal, Segmented, SkeletonTable, Toggle, confirmDialog, useAsync } from '../components/ui';
import { Icon } from '../components/Icon';
import { SideFoot, TakeoverBack } from '../components/Sidebar';
import { QrCode } from '../components/QrCode';
import { DeviceCell, PageHead, TableWrap, lastSeen, useActiveNavInView } from './admin/parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export function AccountPage() {
  const { section = 'profile' } = useParams();
  const navRef = useActiveNavInView(section);
  const canTokens = useStore((s) => s.me?.permissions.includes('create-personal-access-tokens'));
  return (
    <div className="page with-nav takeover account-page">
      <nav className="page-nav" aria-label="Minha conta" ref={navRef}>
        <TakeoverBack />
        <h2>Minha conta</h2>
        <NavLink to="/account/profile">
          <Icon name="account" />
          Perfil
        </NavLink>
        <NavLink to="/account/preferences">
          <Icon name="preferences" />
          Preferências
        </NavLink>
        <NavLink to="/account/security">
          <Icon name="security" />
          Segurança
        </NavLink>
        <NavLink to="/account/devices">
          <Icon name="devices" />
          Dispositivos
        </NavLink>
        {canTokens && (
          <NavLink to="/account/tokens">
            <Icon name="tokens" />
            Tokens de acesso
          </NavLink>
        )}
        <SideFoot />
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
  const [deleting, setDeleting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dirty = f.name !== me.name || f.username !== me.username || f.email !== (me.email ?? '') || f.bio !== (me.bio ?? '') || f.statusText !== (me.statusText ?? '');
  const save = async () => {
    try {
      const r = await api.post('users.updateOwnBasicInfo', { data: f });
      useStore.getState().setMe({ ...me, ...r.user });
      ok('Perfil atualizado.');
    } catch (e) {
      fail(e);
    }
  };
  const upload = async (picked: File) => {
    const fd = new FormData();
    fd.append('image', picked);
    await api
      .post('users.setAvatar', fd)
      .then(() => ok('Foto atualizada.'))
      .catch(fail);
  };
  const ldap = me.authSource === 'ldap';
  return (
    <>
      <PageHead title="Perfil" />
      <div className="account-col">
        <div className="card profile-card">
          <div className="avatar-edit">
            <Avatar username={me.username} size={64} etag={me.avatarETag} />
            <div className="profile-who">
              <span className="profile-name">{me.name}</span>
              <span className="muted">@{me.username}</span>
              {allowAvatar && (
                <div className="row-actions">
                  <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (e.target.files?.[0] && upload(e.target.files[0]), (e.target.value = ''))} />
                  <button type="button" className="btn small" onClick={() => file.current?.click()}>
                    <Icon name="image-change" />
                    Trocar foto
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => api.post('users.resetAvatar').catch(fail)}>
                    <Icon name="image-remove" />
                    Remover
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {ldap && (
          <div className="callout info">
            <Icon name="admin-ldap" />
            <span>Sua conta é sincronizada com o diretório da empresa (LDAP); alguns campos são mantidos por lá.</span>
          </div>
        )}
        <div className="card">
          <div className="form">
            <div className="two-col">
              <Field label="Nome">
                <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={ldap} />
              </Field>
              <Field label="Nome de usuário">
                <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} disabled={!allowUsername || ldap} />
              </Field>
            </div>
            <Field label="E-mail">
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!allowEmail || ldap} />
            </Field>
            <Field label="Mensagem de status" hint="Aparece ao lado do seu nome, até 120 caracteres.">
              <input value={f.statusText} maxLength={120} onChange={(e) => setF({ ...f, statusText: e.target.value })} />
            </Field>
            <Field label="Sobre">
              <textarea rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
            </Field>
            <div className="form-actions">
              <button className="btn primary" onClick={save} disabled={!dirty}>
                Salvar
              </button>
            </div>
          </div>
        </div>
        {allowDelete && (
          <div className="danger-zone">
            <div>
              <h3>Excluir conta</h3>
              <p className="muted small">Apaga sua conta de vez. As mensagens que você mandou continuam nas conversas.</p>
            </div>
            <button className="btn danger" onClick={() => setDeleting(true)}>
              <Icon name="delete" />
              Excluir minha conta
            </button>
          </div>
        )}
      </div>
      {deleting && <DeleteAccount onClose={() => setDeleting(false)} />}
    </>
  );
}

// No lugar do prompt(): a senha confirma a exclusão.
function DeleteAccount({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post('users.deleteOwnAccount', { password });
      endSession();
      location.href = '/login';
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title="Excluir sua conta?"
      description="Não dá para desfazer. Digite sua senha para confirmar."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn danger solid" disabled={!password || busy} onClick={go}>
            Excluir minha conta
          </button>
        </>
      }
    >
      <Field label="Senha">
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={(e) => e.key === 'Enter' && password && go()} />
      </Field>
    </Modal>
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
    <>
      <PageHead title="Preferências" />
      <div className="account-col">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Aparência</h2>
              <p className="card-desc">Vale para este e para os outros dispositivos em que você entrar.</p>
            </div>
          </div>
          <div className="form">
            {/* Três opções curtas: controle segmentado, como no menu do usuário (o rótulo não é <label>: são botões). */}
            <div className="field">
              <span className="field-label" id="account-theme">
                Tema
              </span>
              <Segmented
                label="Tema"
                value={(['auto', 'light', 'dark'].includes(p.theme) ? p.theme : 'auto') as 'auto' | 'light' | 'dark'}
                onChange={(v) => save({ theme: v })}
                items={[
                  { id: 'auto', label: 'Automático', icon: 'theme-auto' },
                  { id: 'light', label: 'Claro', icon: 'theme-light' },
                  { id: 'dark', label: 'Escuro', icon: 'theme-dark' },
                ]}
              />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Notificações</h2>
              <p className="card-desc">O padrão de cada sala; dá para mudar sala a sala nas preferências de notificação dela.</p>
            </div>
          </div>
          <div className="form">
            <Field label="Notificações na área de trabalho">
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
            <div className="toggle-list">
              <Toggle checked={p.notificationSound !== false} onChange={(v) => save({ notificationSound: v })} label="Som de notificação" />
              <PushToggle />
            </div>
            {'Notification' in window && Notification.permission !== 'granted' && (
              <div className="callout info">
                <Icon name="notify-prompt" />
                <span>O navegador ainda não deixou este site mostrar notificações.</span>
                <button className="btn small callout-action" onClick={() => Notification.requestPermission().then((r) => r === 'granted' && syncPushSubscription())}>
                  Permitir notificações do navegador
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Mensagens</h2>
          </div>
          <div className="toggle-list">
            <Toggle checked={p.sendOnEnter !== false} onChange={(v) => save({ sendOnEnter: v })} label="Enter envia" description="Shift+Enter quebra a linha." />
          </div>
        </div>
      </div>
    </>
  );
}

// Push neste navegador: chega mesmo com o chat fechado (no celular, com o app instalado na tela inicial).
function PushToggle() {
  const enabled = useSetting<boolean>('Push_enable');
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void pushEnabledHere().then(setOn);
  }, []);
  if (!enabled || !pushSupported() || on === null) return null;
  const change = async (v: boolean) => {
    if (v) {
      const ok2 = await enablePushHere();
      setOn(ok2);
      if (!ok2) fail(new Error('Não foi possível ativar. Confira se as notificações deste site estão permitidas no navegador.'));
    } else {
      await disablePushHere();
      setOn(false);
    }
  };
  return <Toggle checked={on} onChange={(v) => void change(v)} label="Notificações push neste dispositivo" description="Chegam mesmo com o chat fechado." />;
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
  const mismatch = !!p2 && p1 !== p2;
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
      <PageHead title="Segurança" />
      <div className="account-col">
        {allowPassword && me.authSource !== 'ldap' && (
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Senha</h2>
                <p className="card-desc">Depois de trocar, as outras sessões continuam abertas; encerre-as em Dispositivos se precisar.</p>
              </div>
            </div>
            <div className="form">
              <Field label="Senha atual">
                <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
              </Field>
              <div className="two-col">
                <Field label="Nova senha">
                  <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Confirmar nova senha" error={mismatch ? 'As senhas não conferem.' : undefined}>
                  <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
                </Field>
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={changePw} disabled={!p1 || mismatch}>
                  Alterar senha
                </button>
              </div>
            </div>
          </div>
        )}
        {twoFA && <TwoFactorCard />}
      </div>
    </>
  );
}

// Cartão do 2FA, usado em Minha conta › Segurança e na tela de 2FA obrigatório (App.tsx).
export function TwoFactorCard() {
  const me = useStore((s) => s.me)!;
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  // Com o 2FA obrigatório pendente, o resto do chat só carrega depois que os códigos de backup forem vistos.
  const done = () => {
    setCodes(null);
    if (me.require2faSetup) void startSession();
  };
  return (
    <div className="card form two-factor">
      <div className="card-head">
        <div>
          <h2>Autenticação em dois fatores</h2>
          <p className="card-desc">Um código do celular, além da senha, para entrar.</p>
        </div>
        {me.twoFactorEnabled && !codes && <span className="pill ok dot">Ativado</span>}
      </div>
      {codes ? (
        <>
          <div className="callout ok">
            <Icon name="success" />
            <span>2FA ativado. Guarde estes códigos de backup em local seguro; cada um funciona uma vez:</span>
          </div>
          <pre className="codes">{codes.join('\n')}</pre>
          <div className="form-actions">
            <button className="btn primary" onClick={done}>
              Pronto
            </button>
          </div>
        </>
      ) : me.twoFactorEnabled ? (
        <>
          <div className="callout ok">
            <Icon name="success" />
            <span>Ativado com aplicativo autenticador.</span>
          </div>
          {/* Aceita também um código de backup (8 letras e números): sem o teclado só numérico. */}
          <Field label="Código atual para desativar" hint="O código do aplicativo ou um dos códigos de backup.">
            <input
              className="otp-input"
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={8}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
            />
          </Field>
          <div className="form-actions">
            <button
              className="btn danger"
              disabled={!code}
              onClick={() =>
                api
                  .post('users.2fa.disableTotp', { code })
                  .then(() => (useStore.getState().setMe({ ...me, twoFactorEnabled: false }), setCode(''), ok('2FA desativado.')))
                  .catch(fail)
              }
            >
              Desativar 2FA
            </button>
          </div>
        </>
      ) : setup ? (
        <>
          <ol className="steps">
            <li>Escaneie o QR code no seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
            <li>Digite o código de 6 dígitos que ele mostrar.</li>
          </ol>
          <div className="qr-box">
            <QrCode text={setup.url} size={200} />
            <p className="muted small">
              Ou digite a chave manualmente: <code>{setup.secret}</code>
            </p>
          </div>
          <Field label="Código gerado pelo aplicativo">
            <input
              autoFocus
              className="otp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <div className="form-actions">
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
          </div>
        </>
      ) : (
        <div className="form-actions">
          <button className="btn primary" onClick={() => api.post('users.2fa.enableTotp').then(setSetup).catch(fail)}>
            <Icon name="security" />
            Ativar 2FA
          </button>
        </div>
      )}
    </div>
  );
}

function Devices() {
  const { data, loading, reload } = useAsync(() => api.get('sessions.list', { count: 100 }), []);
  const allowAll = useSetting<boolean>('Device_Management_Allow_Logout_All');
  const others = (data?.sessions ?? []).filter((s: any) => !s.current).length;
  const logoutOthers = async () => {
    const yes = await confirmDialog({ title: 'Encerrar as outras sessões?', body: 'Os outros dispositivos saem da conta e precisam entrar de novo.', confirmLabel: 'Encerrar sessões', danger: true });
    if (!yes) return;
    api
      .post('sessions.logout.others')
      .then((r) => (ok(`${r.removed} sessões encerradas.`), reload()))
      .catch(fail);
  };
  return (
    <>
      <PageHead title="Dispositivos">
        {allowAll && others > 0 && (
          <button className="btn" onClick={logoutOthers}>
            <Icon name="logout" />
            Encerrar todas as outras sessões
          </button>
        )}
      </PageHead>
      <p className="page-lead">Cada login cria uma sessão. Encerre as que você não reconhece.</p>
      {loading && !data ? (
        <SkeletonTable rows={4} cols={4} />
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Dispositivo</th>
                <th>Último uso</th>
                <th className="col-lg">Login</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.sessions.map((s: any) => (
                <tr key={s._id}>
                  <td>
                    <DeviceCell device={s.device} tag={s.current && <span className="pill accent tag">Esta sessão</span>} />
                  </td>
                  <td className="nowrap" data-label="Último uso">
                    {s.current ? 'Agora' : lastSeen(s.lastActiveAt)}
                  </td>
                  <td className="muted nowrap col-lg" data-label="Login">
                    {formatDateTime(s.createdAt)}
                  </td>
                  <td className="actions-col">
                    {!s.current && (
                      <div className="row-actions">
                        <button className="btn small ghost danger" onClick={() => api.post('sessions.logout.me', { sessionId: s._id }).then(reload).catch(fail)}>
                          <Icon name="logout" />
                          Encerrar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}

function Tokens() {
  const { data, loading, reload } = useAsync(() => api.get('users.getPersonalAccessTokens'), []);
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState('');
  const [bypass, setBypass] = useState(false);
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tokens: any[] = data?.tokens ?? [];
  const generate = () =>
    api
      .post('users.generatePersonalAccessToken', { tokenName: name, bypassTwoFactor: bypass })
      .then((r) => (setToken(r.token), setName(''), setCreating(false), reload()))
      .catch(fail);
  const revoke = async (t: any) => {
    const yes = await confirmDialog({ title: `Revogar o token "${t.name}"?`, body: 'Scripts e integrações que usam este token param de funcionar.', confirmLabel: 'Revogar', danger: true });
    if (!yes) return;
    api.post('users.removePersonalAccessToken', { tokenName: t.name }).then(reload).catch(fail);
  };
  const open = () => (setCreating(true), setTimeout(() => input.current?.focus(), 0));
  return (
    <>
      <PageHead title="Tokens de acesso" count={tokens.length || undefined}>
        {tokens.length > 0 && !creating && (
          <button className="btn primary" onClick={open}>
            <Icon name="add" />
            Gerar token
          </button>
        )}
      </PageHead>
      <p className="page-lead">
        Use em integrações com os cabeçalhos <code>X-User-Id: {me._id}</code> e <code>X-Auth-Token: &lt;token&gt;</code>.
      </p>
      {token && (
        <div className="callout ok token-new">
          <Icon name="success" />
          <span>Token gerado. Copie agora: ele não será mostrado de novo.</span>
          <div className="copy-box">
            <input readOnly value={token} onFocus={(e) => e.target.select()} aria-label="Token gerado" />
            <button
              type="button"
              className="btn small"
              onClick={() =>
                navigator.clipboard
                  .writeText(token)
                  .then(() => ok('Token copiado.'))
                  .catch(fail)
              }
            >
              <Icon name="copy" />
              Copiar
            </button>
          </div>
        </div>
      )}
      {creating && (
        <div className="card token-form">
          <div className="form">
            <Field label="Nome do token" hint="Para reconhecer onde ele é usado, como “Relatório diário”.">
              <input ref={input} placeholder="Nome do token" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && generate()} />
            </Field>
            <Toggle checked={bypass} onChange={setBypass} label="Ignorar 2FA" description="O token funciona sem pedir o código do autenticador." />
            <div className="form-actions">
              <button className="btn" onClick={() => (setCreating(false), setName(''))}>
                Cancelar
              </button>
              <button className="btn primary" disabled={!name} onClick={generate}>
                Gerar
              </button>
            </div>
          </div>
        </div>
      )}
      {loading && !data ? (
        <SkeletonTable rows={3} cols={3} />
      ) : !tokens.length ? (
        !creating && (
          <Empty
            icon="tokens"
            title="Nenhum token de acesso"
            action={
              <button className="btn primary" onClick={open}>
                Gerar token
              </button>
            }
          >
            Tokens permitem usar a API em scripts e integrações.
          </Empty>
        )
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Criado</th>
                <th>Último uso</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t: any) => (
                <tr key={t._id}>
                  <td>
                    <div className="cell-entity">
                      <span className="cell-icon">
                        <Icon name="tokens" />
                      </span>
                      <div>
                        <span className="cell-name">{t.name}</span>
                        {t.bypassTwoFactor && <span className="cell-sub">Ignora 2FA</span>}
                      </div>
                    </div>
                  </td>
                  <td className="nowrap" data-label="Criado">
                    {formatDateTime(t.createdAt)}
                  </td>
                  <td data-label="Último uso">{t.lastUsedAt ? lastSeen(t.lastUsedAt) : <span className="muted">Nunca usado</span>}</td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <button className="btn small ghost danger" onClick={() => revoke(t)}>
                        Revogar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
