import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, plural, roleLabel, setRoleDescriptions } from '../../lib/format';
import { usePermission, useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, Menu, Modal, Pager, SkeletonTable, Toggle, Tooltip, confirmDialog, useAsync } from '../../components/ui';
import { ActivePill, RolePills, RowMenu, UserCell, lastSeen } from './parts';
import type { LockReason } from '@shared/rbac';
import { BulkRolesDialog } from './rbac/BulkRoles';
import { loadGrant, lockText, rbacFail, userLockOf } from './rbac/data';
import { Chips, ListStrip, LockHint } from './rbac/shell';
import { UserEditor } from './rbac/UserEditor';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const AUTH_LABEL: Record<string, string> = { local: 'Local', ldap: 'LDAP', saml: 'SAML' };

function origin(u: any) {
  if (u.authSource === 'oauth') return u.authProvider ? `OAuth · ${u.authProvider}` : 'OAuth';
  if (!u.authSource || u.authSource === 'local') return '';
  return AUTH_LABEL[u.authSource] ?? u.authSource;
}

type Status = '' | 'active' | 'deactivated';

// CSV com ponto e vírgula (abre direto no Excel em português) e aspas quando preciso.
function toCsv(users: any[]) {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Nome', 'Usuário', 'E-mail', 'Papéis', 'Status', 'Origem', 'Último acesso'];
  const rows = users.map((u) => [u.name, u.username, u.email, u.roles.map(roleLabel).join(', '), u.active ? 'Ativo' : 'Desativado', origin(u) || 'Local', formatDateTime(u.lastLogin)]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\n');
}

export function AdminUsers() {
  const { view, param } = useParams();
  const [params] = useSearchParams();
  // Links antigos (?edit=id) abrem o editor em página.
  const legacy = params.get('edit');
  if (legacy) return <Navigate to={`/admin/users/edit/${encodeURIComponent(legacy)}`} replace />;
  if (view === 'edit' && param) return <UserEditor key={param} id={param} />;
  return <UserList />;
}

// Lista (guia de layout): faixa única com busca, contador, status, papel, exportar e Novo usuário; a linha abre o
// editor; a seleção abre a barra flutuante das ações em lote. Cada ação aparece só para quem tem a permissão dela, e
// pessoas com cadeado (papéis acima do que você dá) ficam de fora das ações de conta.
const SELECT_MAX = 500;

function UserList() {
  const me = useStore((s) => s.me)!;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [role, setRole] = useState(params.get('role') ?? '');
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Pessoas já vistas (em qualquer página ou no "Selecionar todos"): a seleção vale entre páginas.
  const [known, setKnown] = useState<Map<string, any>>(new Map());
  const [selectingAll, setSelectingAll] = useState(false);
  const [bulkRole, setBulkRole] = useState<{ role: string; mode: 'add' | 'remove' } | null>(null);
  const [exporting, setExporting] = useState(false);
  const canCreate = usePermission('create-user');
  const canAssign = usePermission('assign-roles');
  const canActive = usePermission('edit-other-user-active-status');
  const canLogout = usePermission('logout-other-user');
  const { data, loading, reload } = useAsync(() => api.get('users.list', { filter, status, role, offset, count }), [filter, status, role, offset, count]);
  // Contagens do controle segmentado (com a busca e o papel aplicados).
  const counts = useAsync(
    () =>
      Promise.all(['', 'active', 'deactivated'].map((s) => api.get('users.list', { filter, role, status: s, count: 1 }).then((r) => r.total as number))).then(([all, active, off]) => ({
        all,
        active,
        off,
      })),
    [filter, role, data],
  );
  const roles = useAsync(() => api.get('roles.list').then((r) => (setRoleDescriptions(r.roles), r)), []);
  // Hierarquia de concessão: papéis que quem está usando a tela pode dar ou tirar (os outros aparecem com cadeado).
  const grant = useAsync(loadGrant, []);
  const globalRoles: any[] = (roles.data?.roles ?? []).filter((r: any) => r.scope === 'Users');
  const open = (u: any) => navigate(`/admin/users/edit/${encodeURIComponent(u._id)}`);
  const lockOf = (u: any) => (grant.data ? userLockOf(grant.data, me._id, u) : null);

  // Trocar filtro limpa a seleção; trocar de página não.
  useEffect(() => setSelected(new Set()), [filter, status, role]);
  useEffect(() => {
    if (!data?.users?.length) return;
    setKnown((m) => {
      const n = new Map(m);
      for (const u of data.users) n.set(u._id, u);
      return n;
    });
  }, [data]);

  const users: any[] = data?.users ?? [];
  const total: number = data?.total ?? 0;
  const allOnPage = users.length > 0 && users.every((u) => selected.has(u._id));
  const someOnPage = users.some((u) => selected.has(u._id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      for (const u of users) allOnPage ? n.delete(u._id) : n.add(u._id);
      return n;
    });
  const resetFilters = () => (setFilter(''), setStatus(''), setRole(''), setOffset(0));
  // Todas as páginas do filtro (até 500), em páginas de 500 como a exportação.
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const all: any[] = [];
      for (let o = 0; o < SELECT_MAX; o += 500) {
        const r = await api.get('users.list', { filter, status, role, offset: o, count: 500 });
        all.push(...r.users);
        if (all.length >= r.total || !r.users.length) break;
      }
      setKnown((m) => {
        const n = new Map(m);
        for (const u of all) n.set(u._id, u);
        return n;
      });
      setSelected(new Set(all.slice(0, SELECT_MAX).map((u) => u._id)));
    } catch (e) {
      fail(e);
    } finally {
      setSelectingAll(false);
    }
  };

  // Ações de conta em lote: uma chamada só para todas (até 500, sem esbarrar no limite de chamadas por minuto) e um
  // aviso no fim. O servidor deixa de fora a própria conta e quem tem cadeado; a tela só antecipa as contagens.
  const selectedUsers = [...selected].map((id) => known.get(id)).filter(Boolean) as any[];
  const unlocked = selectedUsers.filter((u) => {
    const l = lockOf(u);
    return !l || l === 'self';
  });
  const lockedOut = selectedUsers.length - unlocked.length;
  const others = unlocked.filter((u) => u._id !== me._id);
  const selfSelected = selectedUsers.some((u) => u._id === me._id);
  const bulk = async (what: string, path: 'users.bulkSetActiveStatus' | 'users.bulkLogout', extra: Record<string, unknown> = {}, mentionSelf = true) => {
    try {
      const r = await api.post(path, { userIds: [...selected], ...extra });
      const sk = r.skipped ?? {};
      const notes = [
        mentionSelf && sk.self ? 'você não foi incluído' : '',
        sk.locked ? `${sk.locked} com cadeado ${sk.locked === 1 ? 'ficou' : 'ficaram'} de fora` : '',
        sk.unchanged ? `${sk.unchanged} já ${sk.unchanged === 1 ? 'estava' : 'estavam'} assim` : '',
      ].filter(Boolean);
      const tail = notes.length ? ` (${notes.join('; ')})` : '';
      if (r.users) ok(`${what}: ${plural(r.users, 'pessoa', 'pessoas')}${tail}.`);
      else ok(`Nada a fazer${tail || ': você não pode aplicar isso à sua própria conta'}.`);
      setSelected(new Set());
    } catch (e) {
      fail(e);
    }
    reload();
  };
  const selfNote = `${selfSelected ? ' Sua própria conta fica de fora.' : ''}${lockedOut ? ` ${plural(lockedOut, 'pessoa com cadeado fica', 'pessoas com cadeado ficam')} de fora.` : ''}`;
  const setActive = (active: boolean) => async () => {
    if (!active) {
      const yes = await confirmDialog({
        title: `Desativar ${plural(others.length, 'pessoa', 'pessoas')}?`,
        body: `Elas não conseguem entrar até serem reativadas. As mensagens permanecem.${selfNote}`,
        confirmLabel: 'Desativar',
        danger: true,
      });
      if (!yes) return;
    }
    await bulk(active ? 'Ativadas' : 'Desativadas', 'users.bulkSetActiveStatus', { activeStatus: active }, !active);
  };
  const logoutSelected = async () => {
    const yes = await confirmDialog({
      title: `Encerrar as sessões de ${plural(others.length, 'pessoa', 'pessoas')}?`,
      body: `Elas saem da conta em todos os dispositivos e precisam entrar de novo.${selfNote}`,
      confirmLabel: 'Encerrar sessões',
      danger: true,
    });
    if (yes) await bulk('Sessões encerradas', 'users.bulkLogout');
  };

  // Ações de uma linha (menu "Mais ações"): desativar e deslogar pedem confirmação, como em lote.
  const setOneActive = async (u: any) => {
    if (u.active) {
      const yes = await confirmDialog({
        title: `Desativar @${u.username}?`,
        body: 'A pessoa não consegue entrar até ser reativada. As mensagens permanecem.',
        confirmLabel: 'Desativar',
        danger: true,
      });
      if (!yes) return;
    }
    api
      .post('users.setActiveStatus', { userId: u._id, activeStatus: !u.active })
      .then(() => (ok(u.active ? 'Usuário desativado.' : 'Usuário ativado.'), reload()))
      .catch(fail);
  };
  const logoutOne = async (u: any) => {
    const yes = await confirmDialog({
      title: `Encerrar as sessões de @${u.username}?`,
      body: 'A pessoa sai da conta em todos os dispositivos e precisa entrar de novo.',
      confirmLabel: 'Encerrar sessões',
      danger: true,
    });
    if (yes)
      api
        .post('users.logout', { userId: u._id })
        .then((r) => ok(r.message))
        .catch(fail);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: any[] = [];
      for (let o = 0; ; o += 500) {
        const r = await api.get('users.list', { filter, status, role, offset: o, count: 500 });
        all.push(...r.users);
        if (all.length >= r.total || !r.users.length) break;
      }
      const url = URL.createObjectURL(new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'usuarios.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  const c = counts.data;
  return (
    <div className="rbac-shell list">
      <ListStrip eyebrow="Usuários e papéis" title="Usuários" search={filter} onSearch={(v) => (setFilter(v), setOffset(0))} placeholder="Buscar por nome, usuário ou e-mail" count={data?.total}>
        <Chips<Status>
          label="Status"
          value={status}
          onChange={(v) => (setStatus(v), setOffset(0))}
          items={[
            { id: '', label: 'Todos', count: c?.all },
            { id: 'active', label: 'Ativos', count: c?.active },
            { id: 'deactivated', label: 'Desativados', count: c?.off },
          ]}
        />
        <select className="rbac-strip-select" aria-label="Papel" value={role} onChange={(e) => (setRole(e.target.value), setOffset(0))}>
          <option value="">Qualquer papel</option>
          {globalRoles.map((r: any) => (
            <option key={r._id} value={r._id}>
              {roleLabel(r._id)}
            </option>
          ))}
        </select>
        <Tooltip label="Exportar CSV">
          <button className="icon-btn" aria-label="Exportar CSV" onClick={exportCsv} disabled={exporting} aria-busy={exporting || undefined}>
            <Icon name={exporting ? 'loading' : 'download'} className={exporting ? 'spin' : undefined} />
          </button>
        </Tooltip>
        {canCreate && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="add-people" />
            Novo usuário
          </button>
        )}
      </ListStrip>
      <div className="rbac-list-body flush">
        {loading && !data ? (
          <SkeletonTable rows={8} cols={6} />
        ) : !users.length ? (
          <Empty
            icon="search"
            title="Nenhum usuário encontrado"
            action={
              (filter || status || role) && (
                <button className="btn" onClick={resetFilters}>
                  Limpar filtros
                </button>
              )
            }
          >
            Confira a grafia ou mude os filtros.
          </Empty>
        ) : (
          <table className="table stack kv users-table rbac-users">
            <thead>
              <tr>
                <th className="sel-col">
                  <input
                    type="checkbox"
                    aria-label="Selecionar todos desta página"
                    checked={allOnPage}
                    ref={(el) => {
                      if (el) el.indeterminate = someOnPage && !allOnPage;
                    }}
                    onChange={toggleAll}
                  />
                </th>
                <th>Nome</th>
                <th className="col-xl">E-mail</th>
                <th className="col-roles col-md">Papéis</th>
                <th className="col-status">Status</th>
                <th className="col-seen col-lg">Último acesso</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u: any) => {
                const from = origin(u);
                const tag = u._id === me._id ? 'Você' : u.type === 'bot' ? 'Bot' : null;
                const lock = lockOf(u);
                const locked = !!lock && lock !== 'self';
                const self = u._id === me._id;
                return (
                  <tr key={u._id} className={selected.has(u._id) ? 'clickable selected' : 'clickable'} onClick={() => open(u)}>
                    <td className="sel-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Selecionar @${u.username}`} checked={selected.has(u._id)} onChange={() => toggle(u._id)} />
                    </td>
                    <td>
                      <UserCell
                        username={u.username}
                        name={u.name}
                        status={u.status}
                        tag={
                          (tag || locked) && (
                            <>
                              {tag && <span className="pill tag">{tag}</span>}
                              {locked && <LockHint text={lockText(lock)} />}
                            </>
                          )
                        }
                        sub={from || undefined}
                      />
                    </td>
                    <td className="ellipsis-cell col-xl" data-label="E-mail" title={u.email || undefined}>
                      {u.email || <span className="muted">—</span>}
                    </td>
                    <td className="col-md" data-label="Papéis">
                      <RolePills roles={u.roles} />
                    </td>
                    <td data-label="Status">
                      <ActivePill active={u.active} />
                    </td>
                    <td className="nowrap col-lg" data-label="Último acesso">
                      {u.lastLogin ? lastSeen(u.lastLogin) : <span className="muted">—</span>}
                    </td>
                    <td className="actions-col" onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        <RowMenu>
                          {(close) => (
                            <>
                              <button onClick={() => (close(), open(u))}>
                                <Icon name={locked ? 'show' : 'edit'} />
                                {locked ? 'Ver' : 'Editar'}
                              </button>
                              {canActive && !locked && (
                                <button disabled={self} title={self ? 'Você não pode desativar a própria conta.' : undefined} onClick={() => (close(), void setOneActive(u))}>
                                  <Icon name={u.active ? 'disabled-user' : 'success'} />
                                  {u.active ? 'Desativar' : 'Ativar'}
                                </button>
                              )}
                              {canLogout && !locked && (
                                <button
                                  disabled={self}
                                  title={self ? 'Para sair dos seus dispositivos, use Minha conta › Dispositivos.' : undefined}
                                  onClick={() => (close(), void logoutOne(u))}
                                >
                                  <Icon name="logout" />
                                  Encerrar sessões
                                </button>
                              )}
                            </>
                          )}
                        </RowMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="rbac-pager">
            <Pager offset={offset} count={count} total={data.total} onChange={setOffset} sizes={[10, 25, 50, 100]} onCountChange={(n) => (setCount(n), setOffset(0))} />
          </div>
        )}
      </div>
      {selected.size > 0 && (
        <div className="rbac-bulk" role="toolbar" aria-label="Ações em lote">
          <span className="rbac-bulk-count">
            <Icon name="check" />
            {plural(selected.size, 'selecionado', 'selecionados')}
          </span>
          {allOnPage && total > selected.size && (
            total <= SELECT_MAX ? (
              <button type="button" className="link-btn rbac-bulk-all" disabled={selectingAll} aria-busy={selectingAll || undefined} onClick={() => void selectAll()}>
                Selecionar os {total} resultados
              </button>
            ) : (
              <span className="muted small rbac-bulk-all">Selecione até 500 pessoas por vez.</span>
            )
          )}
          {canAssign && (
            <Menu
              align="left"
              placement="top"
              label="Adicionar papel"
              trigger={
                <button type="button" className="btn small ghost">
                  <Icon name="admin-permissions" />
                  <span>Adicionar papel</span>
                </button>
              }
            >
              {(close) => globalRoles.map((r) => <BulkRoleItem key={r._id} role={r} lock={grant.data?.roleLocks[r._id]} onPick={() => (close(), setBulkRole({ role: r._id, mode: 'add' }))} />)}
            </Menu>
          )}
          {canAssign && (
            <Menu
              align="left"
              placement="top"
              label="Remover papel"
              trigger={
                <button type="button" className="btn small ghost">
                  <Icon name="remove-user" />
                  <span>Remover papel</span>
                </button>
              }
            >
              {(close) => globalRoles.map((r) => <BulkRoleItem key={r._id} role={r} lock={grant.data?.roleLocks[r._id]} onPick={() => (close(), setBulkRole({ role: r._id, mode: 'remove' }))} />)}
            </Menu>
          )}
          {canActive && (
            <button type="button" className="btn small ghost" disabled={!unlocked.length} onClick={setActive(true)}>
              <Icon name="success" />
              <span>Ativar</span>
            </button>
          )}
          {canLogout && (
            <button type="button" className="btn small ghost" disabled={!others.length} onClick={() => void logoutSelected()}>
              <Icon name="logout" />
              <span>Encerrar sessões</span>
            </button>
          )}
          {canActive && (
            <button type="button" className="btn small ghost danger" disabled={!others.length} onClick={setActive(false)}>
              <Icon name="disabled-user" />
              <span>Desativar ({others.length})</span>
            </button>
          )}
          <button type="button" className="btn small ghost" aria-label="Limpar seleção" onClick={() => setSelected(new Set())}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {bulkRole && (
        <BulkRolesDialog
          role={bulkRole.role}
          info={globalRoles.find((r) => r._id === bulkRole.role)}
          mode={bulkRole.mode}
          userIds={[...selected]}
          onClose={() => setBulkRole(null)}
          onDone={() => (setBulkRole(null), setSelected(new Set()), reload())}
        />
      )}
      {creating && (
        <CreateUser
          roles={globalRoles.filter((r) => grant.data && !grant.data.roleLocks[r._id])}
          onClose={() => setCreating(false)}
          onCreated={(id) => (reload(), navigate(`/admin/users/edit/${encodeURIComponent(id)}`))}
        />
      )}
    </div>
  );
}

function BulkRoleItem({ role, lock, onPick }: { role: any; lock?: LockReason; onPick: () => void }) {
  return (
    <button role="menuitem" disabled={!!lock} aria-disabled={lock ? true : undefined} title={lock ? lockText(lock) : undefined} onClick={onPick}>
      {lock && <Icon name="rbac-lock" size={12} />}
      {roleLabel(role._id)}
    </button>
  );
}

// Criação por modal curto (guia de layout): o básico para a conta existir e o papel inicial (só os que você dá);
// segurança e o resto ficam no editor, que abre logo em seguida.
function CreateUser({ roles, onClose, onCreated }: { roles: any[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', username: '', email: '', password: '', type: 'user', joinDefaultChannels: true, verified: true });
  const [initialRole, setInitialRole] = useState(roles.some((r) => r._id === 'user') ? 'user' : (roles[0]?._id ?? ''));
  const [busy, setBusy] = useState(false);
  const valid = f.name.trim() && f.username.trim() && f.password;
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('users.create', { ...f, roles: initialRole ? [initialRole] : [], requirePasswordChange: false, active: true });
      ok(`@${r.user.username} criado.`);
      onCreated(r.user._id);
    } catch (e) {
      rbacFail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title="Novo usuário"
      description="Começa com o papel escolhido. Segurança e o resto você ajusta no editor, que abre em seguida."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !valid} aria-busy={busy || undefined} onClick={() => void create()}>
            Criar e abrir
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Nome">
          <input value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Nome de usuário">
          <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        </Field>
        <Field label="E-mail">
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Senha">
          <input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Papel inicial" hint="Os outros papéis você ajusta no editor.">
          <select value={initialRole} onChange={(e) => setInitialRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r._id} value={r._id}>
                {roleLabel(r._id)}
                {r.restrictDirect ? ' (restrito)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo">
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="user">Pessoa</option>
            <option value="bot">Bot</option>
          </select>
        </Field>
        <Toggle checked={f.joinDefaultChannels} onChange={(v) => setF({ ...f, joinDefaultChannels: v })} label="Entrar nos canais padrão" />
      </div>
    </Modal>
  );
}
