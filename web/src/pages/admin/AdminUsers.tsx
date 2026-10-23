import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, plural, roleLabel } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, Menu, Modal, Pager, SearchInput, Segmented, SkeletonTable, Toggle, confirmDialog, useAsync } from '../../components/ui';
import { ActivePill, DeviceCell, PageHead, RolePills, RowMenu, TableWrap, UserCell, lastSeen } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const AUTH_LABEL: Record<string, string> = { local: 'Local', ldap: 'LDAP', saml: 'SAML' };
const nf = new Intl.NumberFormat('pt-BR');

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
  const me = useStore((s) => s.me)!;
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const editId = params.get('edit');
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
  const roles = useAsync(() => api.get('roles.list'), []);
  const globalRoles: any[] = (roles.data?.roles ?? []).filter((r: any) => r.scope === 'Users');

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
    <>
      <PageHead title="Usuários" count={c?.all}>
        <button className="btn" onClick={exportCsv} disabled={exporting} aria-busy={exporting || undefined}>
          <Icon name={exporting ? 'loading' : 'download'} className={exporting ? 'spin' : undefined} />
          Exportar CSV
        </button>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add-people" />
          Novo usuário
        </button>
      </PageHead>
      <div className="filters admin-filters">
        <SearchInput value={filter} onChange={(v) => (setFilter(v), setOffset(0))} placeholder="Buscar por nome, usuário ou e-mail" />
        <select aria-label="Papel" value={role} onChange={(e) => (setRole(e.target.value), setOffset(0))}>
          <option value="">Qualquer papel</option>
          {globalRoles.map((r: any) => (
            <option key={r._id} value={r._id}>
              {roleLabel(r._id)}
            </option>
          ))}
        </select>
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={(v) => (setStatus(v), setOffset(0))}
          items={[
            { id: '', label: <>Todos{c && <span className="seg-count">{nf.format(c.all)}</span>}</> },
            { id: 'active', label: <>Ativos{c && <span className="seg-count">{nf.format(c.active)}</span>}</> },
            { id: 'deactivated', label: <>Desativados{c && <span className="seg-count">{nf.format(c.off)}</span>}</> },
          ]}
        />
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Ações em lote">
          <span className="bulk-count">
            <Icon name="check" />
            {plural(selected.size, 'selecionado', 'selecionados')}
          </span>
          <span className="bulk-sep" aria-hidden="true" />
          <Menu
            align="left"
            label="Adicionar papel"
            trigger={
              <button type="button" className="btn small ghost">
                <Icon name="admin-permissions" />
                Adicionar papel
              </button>
            }
          >
            {(close) =>
              globalRoles.map((r) => (
                <button
                  key={r._id}
                  onClick={() => {
                    close();
                    void bulk(`Papel ${roleLabel(r._id)} adicionado`, (u) => api.post('users.update', { userId: u._id, data: { roles: [...new Set([...u.roles, r._id])] } }));
                  }}
                >
                  {roleLabel(r._id)}
                </button>
              ))
            }
          </Menu>
          <button type="button" className="btn small ghost" onClick={setActive(true)}>
            <Icon name="success" />
            Ativar
          </button>
          <button type="button" className="btn small ghost" disabled={!others.length} onClick={() => void logoutSelected()}>
            <Icon name="logout" />
            Encerrar sessões
          </button>
          <button type="button" className="btn small ghost danger" disabled={!others.length} onClick={setActive(false)}>
            <Icon name="disabled-user" />
            Desativar
          </button>
          <button type="button" className="btn small ghost bulk-clear" onClick={() => setSelected(new Set())}>
            <Icon name="close" />
            Limpar seleção
          </button>
        </div>
      )}
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
        <TableWrap>
          <table className="table stack kv users-table">
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
                  <tr key={u._id} className={selected.has(u._id) ? 'clickable selected' : 'clickable'} onClick={() => setParams({ edit: u._id })}>
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
                    <td className="actions-col">
                      <div className="row-actions">
                        <button type="button" className="btn small ghost" onClick={(e) => (e.stopPropagation(), setParams({ edit: u._id }))}>
                          <Icon name="edit" />
                          Editar
                        </button>
                        <RowMenu>
                          {(close) => (
                            <>
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
        </TableWrap>
      )}
      {data && data.total > 0 && <Pager offset={offset} count={count} total={data.total} onChange={setOffset} sizes={[10, 25, 50, 100]} onCountChange={(n) => (setCount(n), setOffset(0))} />}
      {creating && <UserForm roles={globalRoles} onClose={() => setCreating(false)} onSaved={reload} />}
      {editId && <UserForm id={editId} roles={globalRoles} onClose={() => setParams({})} onSaved={reload} />}
    </>
  );
}

function UserForm({ id, roles, onClose, onSaved }: { id?: string; roles: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    name: '',
    username: '',
    email: '',
    password: '',
    roles: ['user'],
    active: true,
    verified: true,
    requirePasswordChange: false,
    joinDefaultChannels: true,
    type: 'user',
  });
  const [loaded, setLoaded] = useState(!id);
  const [sessions, setSessions] = useState<any[]>([]);
  useEffect(() => {
    if (!id) return;
    void api.get('users.info', { userId: id }).then((r) => {
      setF({ ...r.user, email: r.user.email ?? '', password: '', verified: r.user.emailVerified });
      setLoaded(true);
    });
    void api
      .get('sessions.list.all', { userId: id, count: 50 })
      .then((r) => setSessions(r.sessions))
      .catch(() => {});
  }, [id]);

  const save = async () => {
    try {
      if (id) {
        const data: any = { name: f.name, username: f.username, email: f.email, roles: f.roles, active: f.active, verified: f.verified, requirePasswordChange: f.requirePasswordChange, bio: f.bio };
        if (f.password) data.password = f.password;
        await api.post('users.update', { userId: id, data });
      } else {
        await api.post('users.create', f);
      }
      ok('Usuário salvo.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async () => {
    const yes = await confirmDialog({ title: `Excluir @${f.username}?`, body: 'A conta é apagada. As mensagens dela permanecem nas conversas.', confirmLabel: 'Excluir', danger: true });
    if (!yes) return;
    api
      .post('users.delete', { userId: id })
      .then(() => (onSaved(), onClose()))
      .catch(fail);
  };
  const toggleRole = (r: string) => setF({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] });
  // O papel user dá create-p, create-team e start-discussion: com ele, pessoas restritas abrem salas privadas entre si.
  const restrictedWithUser = f.roles.includes('user') && roles.some((r) => r.restrictDirect && f.roles.includes(r._id));

  return (
    <Modal
      wide
      title={id ? `Editar @${f.username}` : 'Novo usuário'}
      onClose={onClose}
      footer={
        <>
          {id && (
            <button className="btn danger left" onClick={remove}>
              <Icon name="delete" />
              Excluir
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      {!loaded ? (
        <SkeletonTable rows={6} cols={1} />
      ) : (
        <div className="form user-form">
          <section className="form-section">
            <h3 className="form-section-title">Conta</h3>
            <div className="two-col">
              <Field label="Nome">
                <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field label="Nome de usuário">
                <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
              </Field>
              <Field label="E-mail">
                <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </Field>
              <Field label={id ? 'Nova senha' : 'Senha'} hint={id ? 'Deixe vazio para manter a atual.' : undefined}>
                <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
              </Field>
              {!id && (
                <Field label="Tipo">
                  <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                    <option value="user">Pessoa</option>
                    <option value="bot">Bot</option>
                  </select>
                </Field>
              )}
            </div>
          </section>
          <section className="form-section">
            <h3 className="form-section-title">Papéis</h3>
            <div className="chips">
              {roles.map((r) => (
                <label key={r._id} className={`chip selectable ${f.roles.includes(r._id) ? 'on' : ''}`} title={r.restrictDirect ? 'Restrito em conversas diretas' : undefined}>
                  <input type="checkbox" hidden checked={f.roles.includes(r._id)} onChange={() => toggleRole(r._id)} />
                  {r.restrictDirect && <Icon name="direct-blocked" size={14} label="Restrito em conversas diretas" />}
                  {roleLabel(r._id)}
                </label>
              ))}
            </div>
            {restrictedWithUser && (
              <div className="callout warn">
                <Icon name="warning" />
                <span>O papel Usuário permite criar grupos privados, times e discussões. Pessoas com papel restrito em conversas diretas normalmente não devem tê-lo.</span>
              </div>
            )}
          </section>
          <section className="form-section">
            <h3 className="form-section-title">Acesso</h3>
            <div className="toggle-list">
              <Toggle
                checked={f.active}
                onChange={(v) => setF({ ...f, active: v })}
                label="Ativo"
                description={f.active ? 'A pessoa consegue entrar no chat.' : 'Desligado, a pessoa não consegue entrar.'}
              />
              <Toggle checked={f.verified} onChange={(v) => setF({ ...f, verified: v })} label="E-mail verificado" />
              <Toggle checked={f.requirePasswordChange} onChange={(v) => setF({ ...f, requirePasswordChange: v })} label="Exigir troca de senha no próximo login" />
              {!id && <Toggle checked={f.joinDefaultChannels} onChange={(v) => setF({ ...f, joinDefaultChannels: v })} label="Entrar nos canais padrão" />}
            </div>
          </section>
          {id && (
            <section className="form-section">
              <h3 className="form-section-title">Ações</h3>
              <div className="row-actions wrap">
                {f.twoFactorEnabled && (
                  <button
                    className="btn small"
                    onClick={() =>
                      api
                        .post('users.resetTOTP', { userId: id })
                        .then(() => ok('2FA redefinido.'))
                        .catch(fail)
                    }
                  >
                    <Icon name="security" />
                    Redefinir 2FA
                  </button>
                )}
                <button
                  className="btn small"
                  onClick={() =>
                    api
                      .post('users.logout', { userId: id })
                      .then((r) => (ok(r.message), setSessions([])))
                      .catch(fail)
                  }
                >
                  <Icon name="logout" />
                  Encerrar todas as sessões
                </button>
                <button
                  className="btn small"
                  onClick={() =>
                    api
                      .post('users.resetAvatar', { userId: id })
                      .then(() => ok('Avatar removido.'))
                      .catch(fail)
                  }
                >
                  <Icon name="image-remove" />
                  Remover avatar
                </button>
              </div>
              <h4 className="sub-title">
                Sessões ativas <span className="pill head-count">{sessions.length}</span>
              </h4>
              {sessions.length ? (
                <ul className="session-list">
                  {sessions.map((s) => (
                    <li key={s._id}>
                      <DeviceCell device={s.device} />
                      <span className="muted small nowrap">último uso {lastSeen(s.lastActiveAt).toLowerCase()}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nenhuma sessão ativa.</Empty>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
