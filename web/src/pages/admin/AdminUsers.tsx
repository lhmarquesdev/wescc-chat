import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, plural, roleLabel, setRoleDescriptions } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, Menu, Modal, Pager, SkeletonTable, Toggle, Tooltip, confirmDialog, useAsync } from '../../components/ui';
import { ActivePill, RolePills, RowMenu, UserCell, lastSeen } from './parts';
import type { LockReason } from '@shared/rbac';
import { loadGrant, lockText, rbacFail } from './rbac/data';
import { Chips, ListStrip } from './rbac/shell';
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
// editor; a seleção abre a barra flutuante das ações em lote.
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
  const [exporting, setExporting] = useState(false);
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

  useEffect(() => setSelected(new Set()), [filter, status, role, offset, count]);

  const users: any[] = data?.users ?? [];
  const allOnPage = users.length > 0 && users.every((u) => selected.has(u._id));
  const someOnPage = users.some((u) => selected.has(u._id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allOnPage ? new Set() : new Set(users.map((u) => u._id)));
  const resetFilters = () => (setFilter(''), setStatus(''), setRole(''), setOffset(0));

  // Ações em lote: uma chamada por pessoa, e um aviso só no fim. Desativar e encerrar sessões nunca valem para
  // quem está usando a tela (a seleção de todos inclui a própria linha): seria trancar ou deslogar a si mesmo.
  const selectedUsers = users.filter((u) => selected.has(u._id));
  const others = selectedUsers.filter((u) => u._id !== me._id);
  const selfSelected = others.length < selectedUsers.length;
  const bulk = async (what: string, fn: (u: any) => Promise<unknown>, skipSelf = false) => {
    const targets = skipSelf ? others : selectedUsers;
    let done = 0;
    for (const u of targets) {
      try {
        await fn(u);
        done++;
      } catch (e) {
        fail(e);
      }
    }
    if (done) ok(`${what}: ${plural(done, 'pessoa', 'pessoas')}${skipSelf && selfSelected ? ' (você não foi incluído)' : ''}.`);
    else if (skipSelf && selfSelected) ok('Nada a fazer: você não pode aplicar isso à sua própria conta.');
    setSelected(new Set());
    reload();
  };
  const selfNote = selfSelected ? ' Sua própria conta fica de fora.' : '';
  // Papéis em lote: uma chamada só, tudo ou nada, e um lote no histórico de Papéis e permissões.
  const bulkRoles = async (roleId: string, mode: 'add' | 'remove') => {
    const targets = grant.data?.root ? selectedUsers : others;
    if (!targets.length) return ok('Nada a fazer: você não pode mudar os próprios papéis.');
    try {
      await api.post('rbac.users.bulkRoles', { userIds: targets.map((u) => u._id), [mode]: [roleId] });
      ok(`Papel ${roleLabel(roleId)} ${mode === 'add' ? 'adicionado a' : 'removido de'} ${plural(targets.length, 'pessoa', 'pessoas')}${targets.length < selectedUsers.length ? ' (você não foi incluído)' : ''}.`);
      setSelected(new Set());
      reload();
    } catch (e) {
      rbacFail(e);
    }
  };
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
    await bulk(active ? 'Ativadas' : 'Desativadas', (u) => api.post('users.setActiveStatus', { userId: u._id, activeStatus: active }), !active);
  };
  const logoutSelected = async () => {
    const yes = await confirmDialog({
      title: `Encerrar as sessões de ${plural(others.length, 'pessoa', 'pessoas')}?`,
      body: `Elas saem da conta em todos os dispositivos e precisam entrar de novo.${selfNote}`,
      confirmLabel: 'Encerrar sessões',
      danger: true,
    });
    if (yes) await bulk('Sessões encerradas', (u) => api.post('users.logout', { userId: u._id }), true);
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
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add-people" />
          Novo usuário
        </button>
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
                return (
                  <tr key={u._id} className={selected.has(u._id) ? 'clickable selected' : 'clickable'} onClick={() => open(u)}>
                    <td className="sel-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Selecionar @${u.username}`} checked={selected.has(u._id)} onChange={() => toggle(u._id)} />
                    </td>
                    <td>
                      <UserCell username={u.username} name={u.name} status={u.status} tag={tag && <span className="pill tag">{tag}</span>} sub={from || undefined} />
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
                                <Icon name="edit" />
                                Editar
                              </button>
                              <button disabled={u._id === me._id} title={u._id === me._id ? 'Você não pode desativar a própria conta.' : undefined} onClick={() => (close(), void setOneActive(u))}>
                                <Icon name={u.active ? 'disabled-user' : 'success'} />
                                {u.active ? 'Desativar' : 'Ativar'}
                              </button>
                              <button
                                disabled={u._id === me._id}
                                title={u._id === me._id ? 'Para sair dos seus dispositivos, use Minha conta › Dispositivos.' : undefined}
                                onClick={() => (close(), void logoutOne(u))}
                              >
                                <Icon name="logout" />
                                Encerrar sessões
                              </button>
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
            {(close) => globalRoles.map((r) => <BulkRoleItem key={r._id} role={r} lock={grant.data?.roleLocks[r._id]} onPick={() => (close(), void bulkRoles(r._id, 'add'))} />)}
          </Menu>
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
            {(close) => globalRoles.map((r) => <BulkRoleItem key={r._id} role={r} lock={grant.data?.roleLocks[r._id]} onPick={() => (close(), void bulkRoles(r._id, 'remove'))} />)}
          </Menu>
          <button type="button" className="btn small ghost" onClick={setActive(true)}>
            <Icon name="success" />
            <span>Ativar</span>
          </button>
          <button type="button" className="btn small ghost" disabled={!others.length} onClick={() => void logoutSelected()}>
            <Icon name="logout" />
            <span>Encerrar sessões</span>
          </button>
          <button type="button" className="btn small ghost danger" disabled={!others.length} onClick={setActive(false)}>
            <Icon name="disabled-user" />
            <span>Desativar ({others.length})</span>
          </button>
          <button type="button" className="btn small ghost" aria-label="Limpar seleção" onClick={() => setSelected(new Set())}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {creating && <CreateUser roles={globalRoles} onClose={() => setCreating(false)} onCreated={(id) => (reload(), navigate(`/admin/users/edit/${encodeURIComponent(id)}`))} />}
    </div>
  );
}

function BulkRoleItem({ role, lock, onPick }: { role: any; lock?: LockReason; onPick: () => void }) {
  return (
    <button disabled={!!lock} title={lock ? lockText(lock) : undefined} onClick={onPick}>
      {lock && <Icon name="rbac-lock" size={12} />}
      {roleLabel(role._id)}
    </button>
  );
}

// Criação por modal curto (guia de layout): o básico para a conta existir; papéis, segurança e o resto ficam no editor,
// que abre logo em seguida.
function CreateUser({ roles, onClose, onCreated }: { roles: any[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', username: '', email: '', password: '', type: 'user', joinDefaultChannels: true, verified: true });
  const [busy, setBusy] = useState(false);
  const hasUser = roles.some((r) => r._id === 'user');
  const valid = f.name.trim() && f.username.trim() && f.password;
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('users.create', { ...f, roles: hasUser ? ['user'] : [], requirePasswordChange: false, active: true });
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
      description="Começa com o papel Usuário. Papéis, segurança e o resto você ajusta no editor, que abre em seguida."
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
