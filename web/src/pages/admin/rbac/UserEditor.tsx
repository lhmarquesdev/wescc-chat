// Editor de usuário (guia de layout): cabeçalho fixo com a pessoa, alterações pendentes, Reverter e Salvar; abas no
// rodapé: Identidade, Acesso & Papéis (papéis com cadeado, o acesso efetivo com a simulação e os papéis de sala),
// Segurança e Histórico. Cada campo abre só com a permissão dele, e Salvar manda só o que mudou.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../../lib/api';
import { formatDateTime, roleLabel } from '../../../lib/format';
import { usePermission, useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Avatar, Empty, Field, Modal, SkeletonTable, Toggle, Tooltip, confirmDialog, useAsync } from '../../../components/ui';
import { DeviceCell, lastSeen } from '../parts';
import { EffectiveAccess } from './Effective';
import { RbacHistory } from './History';
import { EditorShell, Notice, Section, type EditorTab } from './shell';
import { lockText, loadGrant, rbacFail, rbacOk } from './data';

type Tab = 'identity' | 'access' | 'security' | 'history';

interface Form {
  name: string;
  username: string;
  email: string;
  bio: string;
  password: string;
  roles: string[];
  active: boolean;
  verified: boolean;
  requirePasswordChange: boolean;
}

const FIELD: Record<string, string> = {
  name: 'Nome',
  username: 'Nome de usuário',
  email: 'E-mail',
  bio: 'Bio',
  password: 'Senha',
  active: 'Ativo',
  verified: 'E-mail verificado',
  requirePasswordChange: 'Exigir troca de senha',
};

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const sorted = (a: string[]) => [...a].sort().join();

export function UserEditor({ id, onSaved }: { id: string; onSaved?: () => void }) {
  const me = useStore((s) => s.me)!;
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('identity');
  const [user, setUser] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const [f, setF] = useState<Form | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const roles = useAsync(() => api.get('roles.list').then((r) => (r.roles as any[]).filter((x) => x.scope === 'Users')), []);
  const grant = useAsync(loadGrant, []);
  const perms = {
    info: usePermission('edit-other-user-info'),
    assign: usePermission('assign-roles'),
    password: usePermission('edit-other-user-password'),
    active: usePermission('edit-other-user-active-status'),
    totp: usePermission('edit-other-user-totp'),
    avatar: usePermission('edit-other-user-avatar'),
    sessions: usePermission('view-device-management'),
    logout: usePermission('logout-other-user'),
    remove: usePermission('delete-user'),
  };

  useEffect(() => {
    api
      .get('users.info', { userId: id })
      .then((r) => {
        const u = r.user;
        const form: Form = { name: u.name ?? '', username: u.username, email: u.email ?? '', bio: u.bio ?? '', password: '', roles: u.roles ?? [], active: u.active, verified: !!u.emailVerified, requirePasswordChange: false };
        setUser(u);
        setF(form);
        setInitial(form);
      })
      .catch(() => setMissing(true));
  }, [id, version]);

  const changed = useMemo(() => {
    if (!f || !initial) return [] as string[];
    return (Object.keys(FIELD) as (keyof Form)[]).filter((k) => f[k] !== initial[k]).concat(sorted(f.roles) !== sorted(initial.roles) ? ['roles'] : []);
  }, [f, initial]);
  const dirty = changed.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (missing)
    return (
      <Empty icon="search" title="Usuário não encontrado">
        <button className="btn" onClick={() => navigate('/admin/users')}>
          Voltar aos usuários
        </button>
      </Empty>
    );
  if (!f || !initial || !user || !grant.data || !roles.data) return <SkeletonTable rows={8} cols={2} />;

  const g = grant.data;
  const self = id === me._id;
  const can = perms;
  // Ninguém mexe nos próprios papéis (só o administrador); pessoa com papel acima de quem edita fica só para leitura.
  const selfLocked = self && !g.root;
  const targetLock = !g.root ? initial.roles.map((r) => g.roleLocks[r]).find(Boolean) ?? null : null;
  const readOnly = !!targetLock;
  const set = (patch: Partial<Form>) => setF({ ...f, ...patch });
  const toggleRole = (r: string) => set({ roles: f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r] });
  const restrictedWithUser = f.roles.includes('user') && roles.data.some((r) => r.restrictDirect && f.roles.includes(r._id));
  const askLeave = async () => !dirty || confirmDialog({ title: 'Descartar as alterações?', body: `O que você mudou em @${initial.username} ainda não foi salvo.`, confirmLabel: 'Descartar', danger: true });

  const save = async () => {
    setSaving(true);
    try {
      // Só o que mudou: quem só dá papéis salva sem esbarrar nos dados, e vice-versa.
      const data: Record<string, unknown> = {};
      for (const k of changed) if (k !== 'roles' && k !== 'password' && k !== 'active') data[k] = f[k as keyof Form];
      if (changed.includes('roles')) data.roles = f.roles;
      if (f.password) data.password = f.password;
      // Ativar e desativar têm chave própria: sem a de dados, vai por users.setActiveStatus.
      const activeChanged = changed.includes('active');
      if (activeChanged && can.info) data.active = f.active;
      if (Object.keys(data).length) await api.post('users.update', { userId: id, data });
      if (activeChanged && !can.info) await api.post('users.setActiveStatus', { userId: id, activeStatus: f.active });
      rbacOk(`@${f.username} salvo.`);
      const next = { ...f, password: '' };
      setF(next);
      setInitial(next);
      setReview(false);
      setVersion((v) => v + 1);
      onSaved?.();
    } catch (e) {
      rbacFail(e);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    const yes = await confirmDialog({ title: `Excluir @${initial.username}?`, body: 'A conta é apagada. As mensagens dela permanecem nas conversas.', confirmLabel: 'Excluir', danger: true });
    if (!yes) return;
    api
      .post('users.delete', { userId: id })
      .then(() => (rbacOk(`@${initial.username} excluído.`), onSaved?.(), navigate('/admin/users')))
      .catch(rbacFail);
  };

  const isAdmin = initial.roles.includes('admin');
  const dataEditable = !readOnly && can.info;
  const status = (
    <>
      {isAdmin && (
        <span className="rbac-status root">
          <Icon name="rbac-root" size={12} />
          Administrador
        </span>
      )}
      <span className={`rbac-status${initial.active ? ' ok' : ' off'}`}>{initial.active ? 'Ativo' : 'Desativado'}</span>
    </>
  );
  const tabs: EditorTab<Tab>[] = [
    { id: 'identity', label: 'Identidade', icon: 'rbac-id' },
    { id: 'access', label: 'Acesso & Papéis', icon: 'admin-permissions' },
    { id: 'security', label: 'Segurança', icon: 'security' },
    { id: 'history', label: 'Histórico', icon: 'rbac-history' },
  ];
  const origin = user.authSource && user.authSource !== 'local' ? (user.authSource === 'oauth' ? `OAuth${user.authProvider ? ` · ${user.authProvider}` : ''}` : user.authSource.toUpperCase()) : 'Local';

  return (
    <>
      <EditorShell<Tab>
        backTo="/admin/users"
        onBack={askLeave}
        icon={<Avatar username={initial.username} size={36} etag={user.avatarETag} />}
        iconClass="avatar-slot"
        eyebrow="Editor de usuário"
        title={<h1>{initial.name || `@${initial.username}`}</h1>}
        status={status}
        dirty={dirty}
        canWrite={!readOnly}
        saving={saving}
        onRevert={() => setF(initial)}
        onSave={() => setReview(true)}
        notices={readOnly && <Notice kind="lock">Somente leitura. {lockText(targetLock!)} Você pode ver, mas não alterar esta pessoa.</Notice>}
        tabs={tabs}
        active={tab}
        onTab={setTab}
        label="Seções do usuário"
      >
        {tab === 'identity' && (
          <div className="rbac-grid-75">
            <Section icon="rbac-id" title="Identidade" hint="Como a pessoa aparece no chat.">
              <div className="form">
                <div className="two-col">
                  <Field label="Nome">
                    <input value={f.name} disabled={!dataEditable} onChange={(e) => set({ name: e.target.value })} />
                  </Field>
                  <Field label="Nome de usuário">
                    <input value={f.username} disabled={!dataEditable} onChange={(e) => set({ username: e.target.value })} />
                  </Field>
                </div>
                <Field label="E-mail">
                  <input type="email" value={f.email} disabled={!dataEditable} onChange={(e) => set({ email: e.target.value })} />
                </Field>
                <Field label="Bio">
                  <textarea rows={3} value={f.bio} disabled={!dataEditable} maxLength={500} onChange={(e) => set({ bio: e.target.value })} />
                </Field>
                {!readOnly && !can.info && <p className="field-hint">Editar os dados de outras pessoas pede a permissão Editar dados de outras pessoas.</p>}
              </div>
            </Section>
            <Section icon="info" title="Sobre a conta">
              <dl className="rbac-facts">
                <dt>Tipo</dt>
                <dd>{user.type === 'bot' ? 'Bot' : 'Pessoa'}</dd>
                <dt>Origem</dt>
                <dd>{origin}</dd>
                <dt>Criada em</dt>
                <dd>{user.createdAt ? formatDateTime(user.createdAt) : '—'}</dd>
                <dt>Último acesso</dt>
                <dd>{user.lastLogin ? lastSeen(user.lastLogin) : '—'}</dd>
              </dl>
              {!self && !readOnly && can.remove && (
                <div className="rbac-about-actions">
                  <button className="btn small ghost danger" onClick={() => void remove()}>
                    <Icon name="delete" />
                    Excluir conta
                  </button>
                </div>
              )}
            </Section>
          </div>
        )}
        {tab === 'access' && (
          <div className="rbac-stack">
            <Section icon="admin-permissions" title="Papéis" count={f.roles.length} hint="Os papéis globais somam permissões. Papéis com cadeado você não pode dar nem tirar.">
              {selfLocked && <Notice kind="lock">{lockText('self')}</Notice>}
              <div className="rbac-role-chips">
                {roles.data.map((r) => {
                  const lock = g.roleLocks[r._id];
                  const disabled = selfLocked || readOnly || !!lock || !can.assign;
                  const on = f.roles.includes(r._id);
                  const was = initial.roles.includes(r._id);
                  const tip = selfLocked ? lockText('self') : lock ? lockText(lock) : !can.assign ? 'Dar e tirar papéis pede a permissão Dar e tirar papéis de pessoas.' : r.restrictDirect ? 'Restrito em conversas diretas' : null;
                  const chip = (
                    <label className={`chip selectable ${on ? 'on' : ''} ${disabled ? 'disabled' : ''} ${on !== was ? 'changed' : ''}`}>
                      <input type="checkbox" hidden checked={on} disabled={disabled} onChange={() => toggleRole(r._id)} />
                      {lock && !selfLocked && <Icon name="rbac-lock" size={12} />}
                      {roleLabel(r._id)}
                      {r.restrictDirect && <span className="chip-note">Restrito</span>}
                    </label>
                  );
                  return tip ? (
                    <Tooltip key={r._id} label={tip}>
                      {chip}
                    </Tooltip>
                  ) : (
                    <span key={r._id}>{chip}</span>
                  );
                })}
              </div>
              {restrictedWithUser && (
                <Notice kind="warn">O papel Usuário permite criar grupos privados, times e discussões. Pessoas com papel restrito em conversas diretas normalmente não devem tê-lo.</Notice>
              )}
              {roles.data.some((r) => r.restrictDirect) && <p className="field-hint">Restrito: quem tem o papel não abre conversas diretas nem chamadas com outras pessoas restritas.</p>}
            </Section>
            <EffectiveAccess key={version} userId={id} draftRoles={changed.includes('roles') ? f.roles : undefined} />
          </div>
        )}
        {tab === 'security' && <Security id={id} user={user} f={f} set={set} readOnly={readOnly} self={self} can={can} />}
        {tab === 'history' && <RbacHistory entity={id} embedded onChanged={() => setVersion((v) => v + 1)} />}
      </EditorShell>
      {review && <UserReview initial={initial} f={f} changed={changed} saving={saving} onClose={() => setReview(false)} onConfirm={() => void save()} />}
    </>
  );
}

function Security({ id, user, f, set, readOnly, self, can }: { id: string; user: any; f: Form; set: (p: Partial<Form>) => void; readOnly: boolean; self: boolean; can: Record<string, boolean> }) {
  // Sem permissão de ver dispositivos, nem chama a API.
  const sessions = useAsync(() => (can.sessions ? api.get('sessions.list.all', { userId: id, count: 50 }).then((r) => r.sessions as any[]) : Promise.resolve([] as any[])), [id, can.sessions]);
  const [twoFactor, setTwoFactor] = useState(!!user.twoFactorEnabled);
  const [avatar, setAvatar] = useState(!!user.avatarETag);
  const list = sessions.data ?? [];
  const logout = async () => {
    const yes = await confirmDialog({ title: `Encerrar as sessões de @${user.username}?`, body: 'A pessoa sai da conta em todos os dispositivos e precisa entrar de novo.', confirmLabel: 'Encerrar sessões', danger: true });
    if (yes)
      api
        .post('users.logout', { userId: id })
        .then((r) => (rbacOk(r.message), sessions.reload()))
        .catch(fail);
  };
  return (
    <div className="rbac-stack">
      <div className="rbac-grid-75">
        <Section icon="security" title="Acesso à conta" hint="Entrar no chat, senha e verificação.">
          <div className="form">
            <Field label="Nova senha" hint={can.password && can.info ? 'Deixe vazio para manter a atual.' : 'Trocar a senha pede a permissão Trocar a senha de outras pessoas.'}>
              <input type="password" value={f.password} disabled={readOnly || !can.password || !can.info} autoComplete="new-password" onChange={(e) => set({ password: e.target.value })} />
            </Field>
            <div className="toggle-list">
              <Toggle
                checked={f.active}
                disabled={readOnly || self || !can.active}
                onChange={(v) => set({ active: v })}
                label="Ativo"
                description={self ? 'Você não pode desativar a própria conta.' : f.active ? 'A pessoa consegue entrar no chat.' : 'Desligado, a pessoa não consegue entrar.'}
              />
              <Toggle checked={f.verified} disabled={readOnly || !can.info} onChange={(v) => set({ verified: v })} label="E-mail verificado" />
              <Toggle checked={f.requirePasswordChange} disabled={readOnly || !can.info} onChange={(v) => set({ requirePasswordChange: v })} label="Exigir troca de senha no próximo login" />
            </div>
          </div>
        </Section>
        <Section icon="rbac-technical" title="Ações imediatas" hint="Valem na hora, sem Salvar.">
          <div className="rbac-quick">
            <button className="btn small" disabled={readOnly || !twoFactor || !can.totp} title={can.totp ? undefined : 'Pede a permissão Redefinir o 2FA de outras pessoas.'} onClick={() => api.post('users.resetTOTP', { userId: id }).then(() => (rbacOk('2FA redefinido.'), setTwoFactor(false))).catch(fail)}>
              <Icon name="security" />
              {twoFactor ? 'Redefinir 2FA' : '2FA não configurado'}
            </button>
            <button className="btn small" disabled={readOnly || !avatar || !can.avatar} title={can.avatar ? undefined : 'Pede a permissão Trocar a foto de outras pessoas.'} onClick={() => api.post('users.resetAvatar', { userId: id }).then(() => (rbacOk('Avatar removido.'), setAvatar(false))).catch(fail)}>
              <Icon name="image-remove" />
              Remover avatar
            </button>
          </div>
        </Section>
      </div>
      <Section
        icon="devices"
        title="Sessões ativas"
        count={can.sessions ? list.length : undefined}
        flush
        action={
          list.length > 0 &&
          !self &&
          !readOnly &&
          can.logout && (
            <button className="btn small ghost danger" onClick={() => void logout()}>
              <Icon name="logout" />
              Encerrar todas
            </button>
          )
        }
      >
        {!can.sessions ? (
          <p className="muted small rbac-empty-areas">Ver as sessões pede a permissão Ver os dispositivos e as sessões.</p>
        ) : sessions.loading && !sessions.data ? (
          <SkeletonTable rows={3} cols={2} />
        ) : list.length ? (
          <ul className="rbac-people">
            {list.map((s) => (
              <li key={s._id} className="rbac-session">
                <DeviceCell device={s.device} />
                <span className="muted small nowrap">último uso {lastSeen(s.lastActiveAt).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small rbac-empty-areas">Nenhuma sessão ativa.</p>
        )}
      </Section>
    </div>
  );
}

function UserReview({ initial, f, changed, saving, onClose, onConfirm }: { initial: Form; f: Form; changed: string[]; saving: boolean; onClose: () => void; onConfirm: () => void }) {
  const added = f.roles.filter((r) => !initial.roles.includes(r));
  const removed = initial.roles.filter((r) => !f.roles.includes(r));
  const show = (k: string, v: unknown) => (typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : v === '' ? '—' : String(v));
  return (
    <Modal
      title={`Revisar alterações em @${initial.username}`}
      description={changed.includes('roles') ? 'A mudança de papéis vale na hora para a pessoa e fica no histórico.' : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Voltar ao editor
          </button>
          <button className="btn primary" disabled={saving} aria-busy={saving || undefined} onClick={onConfirm}>
            Salvar alterações
          </button>
        </>
      }
    >
      <ul className="rbac-hist-changes rbac-user-review">
        {changed.includes('roles') && (
          <li className={added.length && removed.length ? 'mixed' : added.length ? 'up' : 'down'}>
            <Icon name={added.length && removed.length ? 'sys-transfer' : added.length ? 'rbac-up' : 'rbac-down'} size={12} />
            <strong>Papéis</strong>
            {added.length > 0 && <span className="rbac-review-keys add">+ {added.map(roleLabel).join(', ')}</span>}
            {removed.length > 0 && <span className="rbac-review-keys del">− {removed.map(roleLabel).join(', ')}</span>}
          </li>
        )}
        {changed
          .filter((k) => k !== 'roles')
          .map((k) => (
            <li key={k}>
              <strong>{FIELD[k]}</strong>
              {k === 'password' ? (
                <span>nova senha definida</span>
              ) : (
                <span>
                  <s className="muted">{show(k, initial[k as keyof Form])}</s> → {show(k, f[k as keyof Form])}
                </span>
              )}
            </li>
          ))}
      </ul>
    </Modal>
  );
}
