import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { normalizeHighlights } from '@shared/highlights';
import { foldText } from '@shared/search';
import { formatDateTime } from '../lib/format';
import { disablePushHere, enablePushHere, pushEnabledHere, pushSupported, syncPushSubscription } from '../lib/push';
import { endSession, startSession } from '../lib/session';
import { useSetting, useStore, type Me } from '../lib/store';
import { useLanguages, useTranslateAllowed } from '../lib/translate';
import { capitalize, languageLabel, languageOptions } from '../lib/translateRules';
import { normalizeLang } from '@shared/translate';
import { Avatar, Empty, Field, Modal, Segmented, SkeletonList, SkeletonTable, Toggle, confirmDialog, useAsync, ThLabel } from '../components/ui';
import { useMedia } from '../components/overlay';
import { Icon } from '../components/Icon';
import { SideBrand, TakeoverBack, TakeoverHead } from '../components/Sidebar';
import { QrCode } from '../components/QrCode';
import { DeviceCell, NewDevicePill, PageHead, TableWrap, lastSeen, useActiveNavInView } from './admin/parts';
import { useLeaveGuard } from './admin/rbac/leaveGuard';
// Figurinhas: o item some com a função desligada.
import { useStickerCaps } from '../lib/stickers';

// Figurinhas: a seção /account/stickers carrega sob demanda, como o editor (§8: o pacote principal fica menor).
const StickersSection = lazy(() => import('./account/StickersSection'));
// Integrações (Jira): Contas conectadas (Jira e Microsoft 365)
import { useIntegrationsMe } from '../lib/integrations';
import { ConnectedAccounts } from './account/ConnectedAccounts';
// Meus dados (LGPD): cópia dos próprios dados num .zip.
import { MyDataSection } from './account/MyDataSection';
// Criptografia de ponta a ponta
import { E2eCard } from '../components/e2e/E2eCard';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const ACCOUNT_SECTIONS = ['profile', 'preferences', 'stickers', 'security', 'devices', 'data', 'tokens', 'connected'];

export function AccountPage() {
  const { section = 'profile' } = useParams();
  const navRef = useActiveNavInView(section);
  const canTokens = useStore((s) => s.me?.permissions.includes('create-personal-access-tokens'));
  // Figurinhas: com a função desligada a seção some (quem cuida dos pacotes continua vendo).
  const stickerCaps = useStickerCaps();
  // Integração com o Jira: o item só aparece quando há uma conta para conectar.
  const integrations = useIntegrationsMe();
  const canConnected = !!integrations && integrations.jira.enabled && integrations.jira.userAuth !== 'off';
  // Meus dados: configuração pública, então o item some na hora quando o administrador desliga.
  const userDataOn = useSetting<boolean>('UserData_EnableDownload');
  // Endereço velho ou digitado errado, ou seção que a pessoa não tem: vai para o Perfil em vez de uma área vazia
  // (Contas conectadas espera a consulta das integrações antes de decidir).
  const hidden =
    (section === 'stickers' && !stickerCaps.on && !stickerCaps.canManage) || (section === 'tokens' && !canTokens) || (section === 'connected' && !!integrations && !canConnected);
  if (!ACCOUNT_SECTIONS.includes(section) || hidden) return <Navigate to="/account/profile" replace />;
  return (
    <div className="page with-nav takeover account-page">
      <TakeoverHead title="Minha conta" />
      <nav className="page-nav" aria-label="Minha conta" ref={navRef}>
        <div className="side-head">
          <SideBrand />
        </div>
        <h2>Minha conta</h2>
        <NavLink to="/account/profile">
          <Icon name="account" />
          Perfil
        </NavLink>
        <NavLink to="/account/preferences">
          <Icon name="preferences" />
          Preferências
        </NavLink>
        {/* Figurinhas: preferências, pacotes, favoritas e recentes. */}
        {(stickerCaps.on || stickerCaps.canManage) && (
          <NavLink to="/account/stickers">
            <Icon name="sticker" />
            Figurinhas
          </NavLink>
        )}
        <NavLink to="/account/security">
          <Icon name="security" />
          Segurança
        </NavLink>
        <NavLink to="/account/devices">
          <Icon name="devices" />
          Dispositivos
        </NavLink>
        {userDataOn && (
          <NavLink to="/account/data">
            <Icon name="my-data" />
            Meus dados
          </NavLink>
        )}
        {canTokens && (
          <NavLink to="/account/tokens">
            <Icon name="tokens" />
            Tokens de acesso
          </NavLink>
        )}
        {/* Integrações (Jira) */}
        {canConnected && (
          <NavLink to="/account/connected">
            <Icon name="int-linked" />
            Contas conectadas
          </NavLink>
        )}
        <TakeoverBack />
      </nav>
      <div className="page-body">
        {section === 'profile' && <Profile />}
        {section === 'preferences' && <Preferences />}
        {/* Figurinhas */}
        {section === 'stickers' && (
          <Suspense fallback={<SkeletonList n={4} />}>
            <StickersSection />
          </Suspense>
        )}
        {section === 'security' && <Security />}
        {section === 'devices' && <Devices />}
        {section === 'data' && (userDataOn ? <MyDataSection /> : <Empty icon="my-data" title="Meus dados está desativado">O administrador desligou o download dos dados.</Empty>)}
        {section === 'tokens' && <Tokens />}
        {/* Integrações (Jira) */}
        {section === 'connected' && <ConnectedAccounts />}
      </div>
    </div>
  );
}

// Limites do servidor (services/users.ts).
const NAME_MAX = 100;
const BIO_MAX = 500;
const AVATAR_MAX = 5 * 1024 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const profileForm = (me: Me) => ({ name: me.name, username: me.username, email: me.email ?? '', bio: me.bio ?? '', statusText: me.statusText ?? '' });
type ProfileForm = ReturnType<typeof profileForm>;

function Profile() {
  const me = useStore((s) => s.me)!;
  // Com "Permitir alterar perfil" desligado o formulário fica travado (o servidor recusaria ao salvar).
  const allowProfile = useSetting<boolean>('Accounts_AllowUserProfileChange') !== false;
  const allowUsername = useSetting<boolean>('Accounts_AllowUsernameChange');
  const allowEmail = useSetting<boolean>('Accounts_AllowEmailChange');
  const allowAvatar = useSetting<boolean>('Accounts_AllowUserAvatarChange');
  const allowDelete = useSetting<boolean>('Accounts_AllowDeleteOwnAccount');
  // base: o que o formulário mostrou ao abrir (ou depois de salvar). Só vai para o servidor o que a pessoa mudou: um
  // campo vazio ou travado que ela nem tocou (o e-mail de quem não tem e-mail, por exemplo) não impede salvar o resto.
  const [base, setBase] = useState(() => profileForm(me));
  const [f, setF] = useState(base);
  const [currentPassword, setCurrentPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  // O que mudou por fora com a tela aberta (a mensagem de status pelo menu da foto, outro aparelho) entra nos campos
  // que a pessoa não mexeu; o que ela está editando fica como está.
  const fresh = JSON.stringify(profileForm(me));
  useEffect(() => {
    if (fresh === JSON.stringify(base)) return;
    const next: ProfileForm = JSON.parse(fresh);
    setF((cur) => Object.fromEntries((Object.keys(cur) as (keyof ProfileForm)[]).map((k) => [k, cur[k] === base[k] ? next[k] : cur[k]])) as ProfileForm);
    setBase(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);
  const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== base[k]);
  const dirty = changed.length > 0;
  // O e-mail recebe o link de "Esqueci minha senha": trocá-lo pede a senha atual.
  const emailChanged = f.email.trim() !== base.email.trim();
  const nameMissing = changed.includes('name') && !/[\p{L}\p{N}]/u.test(f.name);
  const canSave = allowProfile && dirty && !nameMissing && !(emailChanged && !currentPassword) && !saving;
  // Trocar de seção, "Voltar às conversas" ou fechar a aba com alterações não salvas pergunta antes.
  useLeaveGuard(dirty, () => confirmDialog({ title: 'Descartar as alterações?', body: 'O que você mudou no perfil ainda não foi salvo.', confirmLabel: 'Descartar', danger: true }));
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const data: Record<string, string> = Object.fromEntries(changed.map((k) => [k, f[k]]));
      if (emailChanged) data.currentPassword = currentPassword;
      const r = await api.post('users.updateOwnBasicInfo', { data });
      // Campo esvaziado (Sobre, mensagem de status) não vem na resposta: fica vazio, não com o valor antigo.
      const cur = useStore.getState().me ?? me;
      const next: Me = { ...cur, ...r.user, bio: r.user.bio, statusText: r.user.statusText };
      useStore.getState().setMe(next);
      setBase(profileForm(next));
      setF(profileForm(next));
      setCurrentPassword('');
      ok('Perfil atualizado.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };
  // Tipo e tamanho conferidos antes de enviar (o servidor confere de novo, pelo conteúdo do arquivo).
  const upload = async (picked: File) => {
    if (!AVATAR_TYPES.includes(picked.type)) return fail(new Error('Escolha uma imagem PNG, JPEG, GIF ou WebP.'));
    if (picked.size > AVATAR_MAX) return fail(new Error('A foto pode ter até 5 MB (PNG, JPEG, GIF ou WebP).'));
    const fd = new FormData();
    fd.append('image', picked);
    setUploading(true);
    try {
      await api.post('users.setAvatar', fd);
      ok('Foto atualizada.');
    } catch (e) {
      fail(e);
    } finally {
      setUploading(false);
    }
  };
  const removeAvatar = async () => {
    const yes = await confirmDialog({ title: 'Remover a foto?', body: 'No lugar dela aparecem as suas iniciais.', confirmLabel: 'Remover', danger: true });
    if (!yes) return;
    try {
      await api.post('users.resetAvatar');
      ok('Foto removida.');
    } catch (e) {
      fail(e);
    }
  };
  const ldap = me.authSource === 'ldap';
  // Conta sem senha do chat (só SAML/OAuth): o e-mail vem do provedor.
  const sso = !ldap && me.hasPassword === false;
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
                  <button type="button" className="btn small" disabled={uploading} aria-busy={uploading || undefined} onClick={() => file.current?.click()}>
                    {uploading ? <span className="spinner" aria-hidden="true" /> : <Icon name="image-change" />}
                    {uploading ? 'Enviando…' : 'Trocar foto'}
                  </button>
                  {/* Só há o que remover quando a pessoa enviou uma foto (as iniciais são o padrão). */}
                  {me.avatarETag && !uploading && (
                    <button type="button" className="btn small ghost" onClick={() => void removeAvatar()}>
                      <Icon name="image-remove" />
                      Remover
                    </button>
                  )}
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
        {sso && (
          <div className="callout info">
            <Icon name="security" />
            <span>Você entra pelo login da empresa; o e-mail e a senha são mantidos por lá.</span>
          </div>
        )}
        {!allowProfile && (
          <div className="callout info">
            <Icon name="rbac-lock" />
            <span>O administrador não permite alterar o perfil. Para mudar seus dados, fale com ele.</span>
          </div>
        )}
        <div className="card">
          {/* Formulário de verdade: o Enter num campo salva. */}
          <form className="form" onSubmit={(e) => (e.preventDefault(), void save())}>
            <div className="two-col">
              <Field label="Nome" required error={nameMissing ? 'Informe seu nome.' : undefined}>
                <input value={f.name} maxLength={NAME_MAX} required onChange={(e) => setF({ ...f, name: e.target.value })} disabled={ldap || !allowProfile} />
              </Field>
              <Field label="Nome de usuário" hint={allowProfile && !ldap && !allowUsername ? 'O administrador não permite trocar o nome de usuário.' : undefined}>
                <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} disabled={!allowProfile || !allowUsername || ldap} />
              </Field>
            </div>
            <Field label="E-mail" hint={allowProfile && !ldap && !sso && !allowEmail ? 'O administrador não permite trocar o e-mail.' : undefined}>
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!allowProfile || !allowEmail || ldap || sso} />
            </Field>
            {emailChanged && (
              <Field label="Senha atual" hint="Para trocar o e-mail, confirme com a sua senha. O endereço antigo recebe um aviso.">
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            )}
            <Field label="Mensagem de status" hint="Aparece ao lado do seu nome, até 120 caracteres.">
              <input value={f.statusText} maxLength={120} onChange={(e) => setF({ ...f, statusText: e.target.value })} disabled={!allowProfile} />
            </Field>
            <Field label="Sobre" hint={`${f.bio.length}/${BIO_MAX}`}>
              <textarea rows={3} value={f.bio} maxLength={BIO_MAX} onChange={(e) => setF({ ...f, bio: e.target.value })} disabled={!allowProfile} />
            </Field>
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={!canSave}>
                Salvar
              </button>
            </div>
          </form>
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

// No lugar do prompt(): a senha confirma a exclusão. Conta sem senha do chat (só SAML/OAuth): o nome de usuário.
function DeleteAccount({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const byUsername = me.hasPassword === false;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post('users.deleteOwnAccount', byUsername ? { username: password } : { password });
      await endSession();
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
      description={byUsername ? `Não dá para desfazer. Digite seu nome de usuário (${me.username}) para confirmar.` : 'Não dá para desfazer. Digite sua senha para confirmar.'}
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
      <Field label={byUsername ? 'Nome de usuário' : 'Senha'}>
        <input
          type={byUsername ? 'text' : 'password'}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={byUsername ? 'off' : 'current-password'}
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={(e) => e.key === 'Enter' && password && go()}
        />
      </Field>
    </Modal>
  );
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Preferences() {
  // Lidas da store, não copiadas: o botão de tema do topo e as mudanças feitas em outro aparelho (evento "user")
  // aparecem aqui na hora.
  const prefs = useStore((s) => s.me?.preferences);
  const coarse = useMedia('(pointer: coarse)');
  const p: Record<string, any> = {
    theme: 'auto',
    desktopNotifications: 'mentions',
    emailNotificationMode: 'mentions',
    notificationSound: true,
    sendOnEnter: true,
    ...prefs,
  };
  // Otimista: a store muda na hora; se o servidor recusar, só as chaves deste pedido voltam ao que eram.
  const save = async (patch: Record<string, unknown>) => {
    const st = useStore.getState();
    if (!st.me) return;
    const before: Record<string, unknown> = { ...st.me.preferences };
    st.setMe({ ...st.me, preferences: { ...st.me.preferences, ...patch } });
    if (patch.theme) applyTheme(String(patch.theme));
    try {
      await api.post('users.setPreferences', { data: patch });
    } catch (e) {
      const now = useStore.getState().me;
      if (now) {
        const back: Record<string, unknown> = { ...now.preferences };
        for (const k of Object.keys(patch)) {
          if (k in before) back[k] = before[k];
          else delete back[k];
        }
        useStore.getState().setMe({ ...now, preferences: back as Me['preferences'] });
      }
      if (patch.theme) applyTheme(String(before.theme ?? 'auto'));
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
                  { id: 'light', label: 'Claro', icon: 'theme-light' },
                  { id: 'dark', label: 'Escuro', icon: 'theme-dark' },
                  { id: 'auto', label: 'Automático', icon: 'theme-auto' },
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
            {/* Vale para o computador, o celular e o app instalado: o rótulo não fala em "área de trabalho". */}
            <Field label="Avisar sobre">
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
            <BrowserNotificationsCallout />
          </div>
        </div>
        {/* Também no celular: fora do bloco do teclado físico. */}
        <HighlightsCard />
        {/* No teclado de toque não há Shift: lá o Enter sempre quebra a linha e o botão envia. */}
        {!coarse && (
          <div className="card">
            <div className="card-head">
              <h2>Mensagens</h2>
            </div>
            <div className="toggle-list">
              <Toggle
                checked={p.sendOnEnter !== false}
                onChange={(v) => save({ sendOnEnter: v })}
                label="Enter envia"
                description={p.sendOnEnter !== false ? 'Shift+Enter quebra a linha.' : `Enter quebra a linha; ${MAC ? '⌘+Enter' : 'Ctrl+Enter'} envia.`}
              />
            </div>
          </div>
        )}
        {/* Também no celular (o destino das traduções não depende do teclado). */}
        <TranslationCard value={p.language} onSave={(v) => save({ language: v || null })} />
      </div>
    </>
  );
}

// Tradução de mensagens: o idioma de destino (preferences.language). Vazio = o padrão da empresa.
function TranslationCard({ value, onSave }: { value: unknown; onSave: (v: string) => void }) {
  const allowed = useTranslateAllowed();
  const { list, unavailable } = useLanguages();
  const site = useSetting<string>('Language') || 'pt-BR';
  if (!allowed) return null;
  const current = typeof value === 'string' && value ? normalizeLang(value) : '';
  const options = languageOptions(list ?? []);
  if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: capitalize(languageLabel(current)) });
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Tradução</h2>
          <p className="card-desc">Mensagens em outros idiomas podem ser traduzidas pelo servidor de tradução da empresa.</p>
        </div>
      </div>
      <div className="form">
        <Field
          label="Traduzir mensagens para"
          hint={
            unavailable
              ? 'O servidor de tradução não respondeu. A lista de idiomas volta sozinha quando ele responder.'
              : 'Para traduzir uma sala inteira, abra Tradução automática no menu da sala.'
          }
        >
          <select value={current} disabled={unavailable || !list} onChange={(e) => onSave(e.target.value)}>
            <option value="">{`Padrão da empresa: ${capitalize(languageLabel(site))}`}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

// Palavras destacadas: as mensagens com elas ficam marcadas e avisam como uma menção. Cada mudança é salva na hora;
// se o servidor recusar, a lista volta ao que era.
// (Não usa <Field>: ele é um <label> e o clique no rótulo apertaria o X do primeiro chip.)
function HighlightsCard() {
  const words = useStore((s) => {
    const w = s.me?.preferences?.highlights;
    return Array.isArray(w) ? (w as string[]) : EMPTY_WORDS;
  });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const id = 'account-highlights';
  const save = async (next: string[]) => {
    const r = normalizeHighlights(next);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setError('');
    const st = useStore.getState();
    const me = st.me!;
    const before = me.preferences ?? {};
    st.setMe({ ...me, preferences: { ...before, highlights: r.words } });
    try {
      await api.post('users.setPreferences', { data: { highlights: r.words } });
      return true;
    } catch (e) {
      // Volta só as palavras: outra preferência pode ter mudado nesse meio tempo.
      const now = useStore.getState().me;
      if (now) useStore.getState().setMe({ ...now, preferences: { ...now.preferences, highlights: before.highlights ?? [] } });
      fail(e);
      return false;
    }
  };
  // Palavra que já está na lista (sem acento e sem maiúsculas, como o servidor compara): avisa em vez de sumir calada.
  const repeated = (parts: string[]) => {
    const have = new Map(words.map((w) => [foldText(w.replace(/\s+/g, ' ').trim()), w]));
    for (const p of parts) {
      const old = have.get(foldText(p.replace(/\s+/g, ' ').trim()));
      if (old) return old === p ? `“${p}” já está na lista.` : `“${p}” já está na lista (como “${old}”).`;
    }
    return '';
  };
  const add = async () => {
    const parts = draft
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const dup = repeated(parts);
    if (dup) return setError(dup);
    if (await save([...words, ...parts])) setDraft('');
  };
  const remove = (w: string) => {
    void save(words.filter((x) => x !== w));
    inputRef.current?.focus();
  };
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Palavras destacadas</h2>
          <p className="card-desc">Mensagens com estas palavras ficam marcadas e avisam você como uma menção. Maiúsculas e acentos não importam.</p>
        </div>
      </div>
      <div className="form">
        <div className="field">
          <label className="field-label" htmlFor={id}>
            Palavra ou expressão
          </label>
          <div className="hl-add">
            <div className="picker">
              {/* Clicar no vão da caixa leva ao campo, como num campo comum. */}
              <div className="chips" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), inputRef.current?.focus())}>
                {words.map((w) => (
                  <span key={w} className="chip">
                    {w}
                    <button type="button" aria-label={`Remover “${w}”`} onClick={() => remove(w)}>
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
                <input
                  id={id}
                  ref={inputRef}
                  value={draft}
                  maxLength={400}
                  autoComplete="off"
                  enterKeyHint="done"
                  placeholder="Ex.: plantão, servidor fora"
                  aria-describedby={error ? `${id}-hint ${id}-err` : `${id}-hint`}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    setError('');
                    // A vírgula fecha a palavra (também quando ela chega colada no meio do texto).
                    if (v.includes(',')) {
                      const parts = v.split(',');
                      const rest = parts.pop() ?? '';
                      const done = parts.map((w) => w.trim()).filter(Boolean);
                      const dup = repeated(done);
                      if (dup) {
                        setError(dup);
                        setDraft(v.replace(/,\s*$/, ''));
                        return;
                      }
                      setDraft(rest);
                      if (done.length) void save([...words, ...done]).then((ok2) => !ok2 && setDraft(v.replace(/,\s*$/, '')));
                      return;
                    }
                    setDraft(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void add();
                    } else if (e.key === 'Backspace' && !draft && words.length) {
                      e.preventDefault();
                      void save(words.slice(0, -1));
                    }
                  }}
                />
              </div>
            </div>
            <button type="button" className="btn small" disabled={!draft.trim()} onClick={() => void add()}>
              Adicionar
            </button>
          </div>
          <span className="field-hint" id={`${id}-hint`}>
            Até 20, de 2 a 40 caracteres cada. Enter ou vírgula também adiciona.
          </span>
          {error && (
            <span className="field-error" id={`${id}-err`} role="alert">
              <Icon name="error" size={14} />
              {error}
            </span>
          )}
        </div>
        {words.length === 0 && <p className="muted hl-empty">Nenhuma palavra ainda.</p>}
      </div>
    </div>
  );
}
const EMPTY_WORDS: string[] = [];

// Permissão de notificações do navegador, lida de novo quando muda (cadeado da barra de endereço, outra aba) e depois do
// pedido. Bloqueada, o botão não adiantaria (o navegador não pergunta de novo): a tela explica como liberar.
function BrowserNotificationsCallout() {
  const [perm, setPerm] = useState<NotificationPermission>(() => ('Notification' in window ? Notification.permission : 'granted'));
  useEffect(() => {
    if (!('Notification' in window)) return;
    const sync = () => setPerm(Notification.permission);
    let status: PermissionStatus | undefined;
    let gone = false;
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        if (gone) return;
        status = s;
        s.addEventListener('change', sync);
      })
      .catch(() => {});
    window.addEventListener('focus', sync);
    return () => {
      gone = true;
      status?.removeEventListener('change', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);
  // Liberada agora (pelo botão ou pelo cadeado): a inscrição de push deste aparelho é feita na hora.
  const was = useRef(perm);
  useEffect(() => {
    if (perm === 'granted' && was.current !== 'granted') void syncPushSubscription();
    was.current = perm;
  }, [perm]);
  if (perm === 'granted') return null;
  if (perm === 'denied')
    return (
      <div className="callout warn">
        <Icon name="notify-silenced" />
        <span>O navegador bloqueou as notificações deste site. Para liberar, clique no ícone ao lado do endereço (cadeado ou ajustes), abra Notificações e escolha Permitir.</span>
      </div>
    );
  return (
    <div className="callout info">
      <Icon name="notify-prompt" />
      <span>O navegador ainda não deixou este site mostrar notificações.</span>
      <button type="button" className="btn small callout-action" onClick={() => void Notification.requestPermission().then(setPerm)}>
        Permitir notificações do navegador
      </button>
    </div>
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

// Tema no padrão AtendeTI: a classe `dark` no <html> liga os tokens escuros. data-theme guarda a escolha
// (light, dark ou ausente = Automático, que segue o sistema operacional).
const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
function paintTheme() {
  const root = document.documentElement;
  const choice = root.dataset.theme;
  const dark = choice === 'dark' || (choice !== 'light' && !!systemDark?.matches);
  if (root.classList.contains('dark') === dark) return;
  // Trocar de tema não anima a tela inteira.
  root.classList.add('eloom-theme-switching');
  root.classList.toggle('dark', dark);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('eloom-theme-switching')));
}
systemDark?.addEventListener('change', paintTheme);
export function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  paintTheme();
}

// As regras da senha (configurações públicas), para a pessoa ver antes de errar.
function usePasswordRules() {
  const min = Number(useSetting<number>('Accounts_Password_Policy_MinLength')) || 0;
  const upper = useSetting<boolean>('Accounts_Password_Policy_AtLeastOneUppercase');
  const digit = useSetting<boolean>('Accounts_Password_Policy_AtLeastOneNumber');
  const special = useSetting<boolean>('Accounts_Password_Policy_AtLeastOneSpecialCharacter');
  const parts = [upper && 'uma letra maiúscula', digit && 'um número', special && 'um caractere especial'].filter(Boolean) as string[];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
  const size = min > 1 ? `Pelo menos ${min} caracteres` : min === 1 ? 'Pelo menos 1 caractere' : '';
  if (!size) return list ? `Com ${list}.` : undefined;
  return `${size}${list ? `, com ${list}` : ''}.`;
}

function Security() {
  const me = useStore((s) => s.me)!;
  const twoFA = useSetting<boolean>('Accounts_TwoFactorAuthentication_Enabled');
  const allowPassword = useSetting<boolean>('Accounts_AllowPasswordChange');
  const allowLogoutAll = useSetting<boolean>('Device_Management_Allow_Logout_All') !== false;
  const rules = usePasswordRules();
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  // Marcado: quem troca a senha porque ela vazou tira os outros aparelhos da conta junto.
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const mismatch = !!p2 && p1 !== p2;
  const blank = !!p1 && !p1.trim();
  // LDAP e contas só de SAML/OAuth entram pelo provedor: a senha não é do chat.
  const external = me.authSource === 'ldap' || (me.authSource !== 'local' && me.hasPassword === false);
  useLeaveGuard(!!(p1 || p2), () => confirmDialog({ title: 'Descartar a senha nova?', body: 'A senha ainda não foi trocada.', confirmLabel: 'Descartar', danger: true }));
  const changePw = async () => {
    if (!p1 || blank || busy) return;
    if (p1 !== p2) return fail(new Error('As senhas não conferem.'));
    setBusy(true);
    try {
      const r = await api.post('users.updateOwnBasicInfo', { data: { currentPassword: cur, newPassword: p1, ...(allowLogoutAll && logoutOthers ? { logoutOthers: true } : {}) } });
      setCur('');
      setP1('');
      setP2('');
      const n = Number(r.sessionsEnded ?? 0);
      ok(n ? `Senha alterada. ${n === 1 ? '1 outra sessão foi encerrada' : `${n} outras sessões foram encerradas`}.` : 'Senha alterada.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead title="Segurança" />
      <div className="account-col">
        {allowPassword && external && (
          <div className="callout info">
            <Icon name="security" />
            <span>Você entra pelo login da empresa ({me.authSource === 'ldap' ? 'Active Directory' : 'SSO'}); a senha é trocada por lá.</span>
          </div>
        )}
        {allowPassword && !external && (
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Senha</h2>
                <p className="card-desc">
                  {allowLogoutAll ? 'Troque a senha sempre que achar que outra pessoa pode saber dela.' : 'Depois de trocar, as outras sessões continuam abertas; encerre-as em Dispositivos se precisar.'}
                </p>
              </div>
            </div>
            {/* Formulário de verdade: o Enter num campo troca a senha. */}
            <form className="form" onSubmit={(e) => (e.preventDefault(), void changePw())}>
              {/* Para o gerenciador de senhas saber de qual conta é a senha nova. */}
              <input type="text" name="username" autoComplete="username" value={me.username} readOnly hidden />
              <Field label="Senha atual">
                <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
              </Field>
              <div className="two-col">
                <Field label="Nova senha" hint={rules} error={blank ? 'A senha não pode ser só espaços.' : undefined}>
                  <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Confirmar nova senha" error={mismatch ? 'As senhas não conferem.' : undefined}>
                  <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
                </Field>
              </div>
              {allowLogoutAll && (
                <Toggle checked={logoutOthers} onChange={setLogoutOthers} label="Encerrar as outras sessões" description="Os outros aparelhos saem da conta e entram de novo com a senha nova." />
              )}
              <div className="form-actions">
                <button type="submit" className="btn primary" disabled={!p1 || mismatch || blank || busy}>
                  Alterar senha
                </button>
              </div>
            </form>
          </div>
        )}
        {twoFA && <TwoFactorCard />}
        <E2eCard />
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
      <PageHead title="Dispositivos" />
      <p className="page-lead">
        Cada login cria uma sessão. Encerre as que você não reconhece. “Dispositivo novo” marca o primeiro acesso da conta por um navegador ou programa.
      </p>
      {/* Abaixo do texto, não no cabeçalho: a barra de 56px fica igual à das outras páginas da conta. */}
      {allowAll && others > 0 && (
        <div className="row-actions page-lead-actions">
          <button className="btn" onClick={logoutOthers}>
            <Icon name="logout" />
            Encerrar todas as outras sessões
          </button>
        </div>
      )}
      {loading && !data ? (
        <SkeletonTable rows={4} cols={4} />
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>
                  <ThLabel>Dispositivo</ThLabel>
                </th>
                <th>
                  <ThLabel>Último uso</ThLabel>
                </th>
                <th className="col-lg">
                  <ThLabel>Login</ThLabel>
                </th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.sessions.map((s: any) => (
                <tr key={s._id}>
                  <td>
                    <DeviceCell
                      device={s.device}
                      tag={
                        <>
                          {s.current && <span className="pill accent tag">Esta sessão</span>}
                          {s.device?.newDevice && <NewDevicePill current={s.current} />}
                        </>
                      }
                    />
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
      <p className="page-lead">Use em integrações: envie estes dois cabeçalhos em cada requisição.</p>
      {/* Bloco de código com cópia: no celular o texto mono quebrava no meio ("X-User-" e "Id:"). */}
      <div className="token-headers">
        <pre>
          <code>{`X-User-Id: ${me._id}\nX-Auth-Token: <token>`}</code>
        </pre>
        <button
          type="button"
          className="btn small"
          onClick={() =>
            navigator.clipboard
              .writeText(`X-User-Id: ${me._id}\nX-Auth-Token: ${token || '<token>'}`)
              .then(() => ok('Cabeçalhos copiados.'))
              .catch(fail)
          }
        >
          <Icon name="copy" />
          Copiar
        </button>
      </div>
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
              <input ref={input} placeholder="Nome do token" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && generate()} />
            </Field>
            <Toggle checked={bypass} onChange={setBypass} label="Ignorar 2FA" description="O token funciona sem pedir o código do autenticador." />
            <div className="form-actions">
              <button className="btn" onClick={() => (setCreating(false), setName(''))}>
                Cancelar
              </button>
              <button className="btn primary" disabled={!name.trim()} onClick={generate}>
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
                <th>
                  <ThLabel>Nome</ThLabel>
                </th>
                <th>
                  <ThLabel>Criado</ThLabel>
                </th>
                <th>
                  <ThLabel>Último uso</ThLabel>
                </th>
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
