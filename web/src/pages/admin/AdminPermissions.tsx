import { Fragment, useMemo, useState } from 'react';
import type { DirectRestrictionReport } from '@shared/direct';
import { api, errorMessage } from '../../lib/api';
import { useStore } from '../../lib/store';
import { nameList, roleLabel, setRoleDescriptions } from '../../lib/format';
import { UserPicker, type PickedUser } from '../../components/Pickers';
import { Icon } from '../../components/Icon';
import { Empty, Field, Modal, SearchInput, SkeletonTable, Tabs, Toggle, confirmDialog, useAsync } from '../../components/ui';
import { PageHead, RowMenu, TableWrap, UserCell } from './parts';
import { permissionLabel } from './permissionLabels';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

const GROUP_LABEL: Record<string, string> = {
  admin: 'Administração',
  users: 'Usuários',
  roles: 'Papéis',
  rooms: 'Salas',
  messages: 'Mensagens',
  teams: 'Times',
  audit: 'Auditoria',
  retention: 'Retenção',
  omnichannel: 'Atendimento',
  general: 'Geral',
  // Integrações (Jira/Teams)
  integrations: 'Integrações',
};

export function AdminPermissions() {
  const [tab, setTab] = useState<'permissions' | 'roles'>('permissions');
  const perms = useAsync(() => api.get('permissions.listAll'), []);
  // Recarregar a lista também atualiza os nomes dos papéis criados aqui (roleLabel).
  const roles = useAsync(() => api.get('roles.list').then((r) => (setRoleDescriptions(r.roles), r)), []);
  const report = useAsync(() => api.get('directRestriction.report').then((r) => r.report as DirectRestrictionReport), []);
  const [filter, setFilter] = useState('');
  const [editRole, setEditRole] = useState<any>(null);
  const [usersOf, setUsersOf] = useState<string | null>(null);
  const [scope, setScope] = useState<'Users' | 'Subscriptions' | 'all'>('all');

  const grouped = useMemo(() => {
    const out: Record<string, any[]> = {};
    for (const p of perms.data?.update ?? []) {
      const q = filter.trim().toLowerCase();
      if (q && !p._id.includes(q) && !permissionLabel(p._id).toLowerCase().includes(q)) continue;
      (out[p.group] ??= []).push(p);
    }
    return out;
  }, [perms.data, filter]);

  if ((perms.loading && !perms.data) || (roles.loading && !roles.data))
    return (
      <>
        <PageHead title="Papéis e permissões" />
        <SkeletonTable rows={10} cols={6} />
      </>
    );
  const roleList = (roles.data?.roles ?? []).filter((r: any) => scope === 'all' || r.scope === scope);

  const toggle = async (perm: any, role: string) => {
    const next = perm.roles.includes(role) ? perm.roles.filter((r: string) => r !== role) : [...perm.roles, role];
    try {
      await api.post('permissions.update', { permissions: [{ _id: perm._id, roles: next }] });
      perm.roles = next;
      perms.reload();
      report.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <PageHead title="Papéis e permissões">
        <button className="btn primary" onClick={() => setEditRole({ name: '', description: '', scope: 'Users', mandatory2fa: false, isNew: true })}>
          <Icon name="add" />
          Novo papel
        </button>
      </PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'permissions', label: 'Permissões' },
          { id: 'roles', label: 'Papéis' },
        ]}
      />
      {tab === 'permissions' ? (
        <>
          <div className="filters admin-filters">
            <SearchInput value={filter} onChange={setFilter} placeholder="Filtrar permissões" />
            <select aria-label="Papéis mostrados" value={scope} onChange={(e) => setScope(e.target.value as any)}>
              <option value="all">Todos os papéis</option>
              <option value="Users">Papéis globais</option>
              <option value="Subscriptions">Papéis de sala</option>
            </select>
          </div>
          <div className="matrix-wrap">
            <table className="table matrix">
              <thead>
                <tr>
                  <th>Permissão</th>
                  {roleList.map((r: any) => (
                    <th key={r._id} title={r.description || undefined}>
                      <span className="role-head">{roleLabel(r._id)}</span>
                      <span className="role-head-id">{r._id}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(grouped).map(([g, list]) => (
                  <Fragment key={g}>
                    <tr className="group-row">
                      <td colSpan={roleList.length + 1}>
                        <span>{GROUP_LABEL[g] ?? g}</span>
                      </td>
                    </tr>
                    {list.map((p) => (
                      <tr key={p._id}>
                        <td>
                          <span className="perm-label">{permissionLabel(p._id)}</span>
                          {permissionLabel(p._id) !== p._id && <span className="perm-id">{p._id}</span>}
                        </td>
                        {roleList.map((r: any) => (
                          <td key={r._id} className="center">
                            <label className="check-cell" title={`${permissionLabel(p._id)} · ${roleLabel(r._id)}`}>
                              <input type="checkbox" aria-label={`${permissionLabel(p._id)} para ${roleLabel(r._id)}`} checked={p.roles.includes(r._id)} onChange={() => toggle(p, r._id)} />
                            </label>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!Object.keys(grouped).length && (
              <Empty icon="search" title={`Nada encontrado para “${filter}”`}>
                Busque pelo nome em português ou pelo id da permissão.
              </Empty>
            )}
          </div>
        </>
      ) : (
        <>
          <DirectReportCard state={report} onFix={() => (setScope('Users'), setTab('permissions'))} />
          <TableWrap>
            <table className="table stack kv">
              <thead>
                <tr>
                  <th>Papel</th>
                  <th>Descrição</th>
                  <th>Escopo</th>
                  <th>2FA</th>
                  <th className="actions-col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.data?.roles.map((r: any) => (
                  <tr key={r._id}>
                    <td>
                      <div className="cell-entity">
                        <span className="cell-icon">
                          <Icon name="admin-permissions" />
                        </span>
                        <div>
                          <span className="cell-name">
                            {roleLabel(r._id)}
                            {r.protected && <span className="pill tag">Sistema</span>}
                            {r.restrictDirect && (
                              <span className="pill warn tag blocked" title="Restrito em conversas diretas">
                                <Icon name="direct-blocked" size={12} />
                                Restrito
                              </span>
                            )}
                          </span>
                          <span className="cell-sub mono">{r._id}</span>
                        </div>
                      </div>
                    </td>
                    <td className={roleDescription(r) ? 'role-desc' : 'role-desc empty'}>{roleDescription(r) || <span className="muted">—</span>}</td>
                    <td data-label="Escopo">{r.scope === 'Users' ? 'Global' : 'Por sala'}</td>
                    <td data-label="2FA">{r.mandatory2fa ? <span className="pill ok dot">Exigido</span> : <span className="muted">—</span>}</td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button className="btn small ghost" onClick={() => setUsersOf(r._id)}>
                          <Icon name="admin-users" />
                          Usuários
                        </button>
                        <button className="btn small ghost" onClick={() => setEditRole(r)}>
                          <Icon name="edit" />
                          Editar
                        </button>
                        {!r.protected && (
                          <RowMenu>
                            {(close) => (
                              <button
                                className="danger"
                                onClick={async () => {
                                  close();
                                  const yes = await confirmDialog({
                                    title: `Excluir o papel ${roleLabel(r._id)}?`,
                                    body: 'Quem tem este papel perde as permissões que vinham dele.',
                                    confirmLabel: 'Excluir',
                                    danger: true,
                                  });
                                  if (yes) api.post('roles.delete', { roleId: r._id }).then(roles.reload).catch(fail);
                                }}
                              >
                                <Icon name="delete" />
                                Excluir
                              </button>
                            )}
                          </RowMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
      {editRole && (
        <RoleForm
          role={editRole}
          onClose={() => setEditRole(null)}
          onSaved={() => {
            roles.reload();
            perms.reload();
            report.reload();
          }}
        />
      )}
      {usersOf && <RoleUsers role={usersOf} onClose={() => (setUsersOf(null), report.reload())} />}
    </>
  );
}

function RoleForm({ role, onClose, onSaved }: { role: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: role._id ?? role.name, description: role.description, scope: role.scope, mandatory2fa: role.mandatory2fa, restrictDirect: !!role.restrictDirect });
  const save = async () => {
    try {
      // Só papéis globais podem ser restritos (o servidor recusa o resto).
      const restrictDirect = f.scope === 'Users' && f.restrictDirect;
      if (role.isNew) await api.post('roles.create', { ...f, restrictDirect });
      else await api.post('roles.update', { roleId: role._id, description: f.description, mandatory2fa: f.mandatory2fa, scope: f.scope, restrictDirect });
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={role.isNew ? 'Novo papel' : `Papel ${roleLabel(role._id)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Nome" hint={role.isNew ? 'O id do papel, sem espaços (ex.: supervisor).' : undefined}>
          <input value={f.name} disabled={!role.isNew} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Descrição">
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Escopo">
          <select value={f.scope} disabled={role.protected} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            <option value="Users">Global</option>
            <option value="Subscriptions">Por sala</option>
          </select>
        </Field>
        <div className="toggle-list">
          <Toggle checked={f.mandatory2fa} onChange={(v) => setF({ ...f, mandatory2fa: v })} label="Exigir 2FA de quem tem este papel" />
          {f.scope === 'Users' && (
            <Toggle
              checked={f.restrictDirect}
              onChange={(v) => setF({ ...f, restrictDirect: v })}
              label="Restrito em conversas diretas"
              description={
                <>
                  Quem tem este papel não pode iniciar conversas diretas nem chamadas com outras pessoas restritas. A exceção é quem tem a permissão {permissionLabel(EXEMPT_PERMISSION)} (
                  <code className="mono">{EXEMPT_PERMISSION}</code>).
                </>
              }
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function RoleUsers({ role, onClose }: { role: string; onClose: () => void }) {
  const { data, loading, reload } = useAsync(() => api.get('roles.getUsersInRole', { role, count: 200 }), [role]);
  const [add, setAdd] = useState<PickedUser[]>([]);
  return (
    <Modal title={`Usuários com o papel ${roleLabel(role)}`} onClose={onClose}>
      <div className="form role-users-add">
        <UserPicker value={add} onChange={setAdd} />
        {add.length > 0 && (
          <button
            className="btn primary"
            onClick={async () => {
              for (const u of add) await api.post('roles.addUserToRole', { roleId: role, userId: u._id }).catch(fail);
              setAdd([]);
              reload();
            }}
          >
            Adicionar
          </button>
        )}
      </div>
      {loading && !data ? (
        <SkeletonTable rows={4} cols={2} />
      ) : !data?.users.length ? (
        <Empty>Ninguém tem este papel ainda.</Empty>
      ) : (
        <ul className="session-list">
          {data.users.map((u: any) => (
            <li key={u._id}>
              <UserCell username={u.username} name={u.name} />
              <button className="btn small ghost danger" onClick={() => api.post('roles.removeUserFromRole', { roleId: role, userId: u._id }).then(reload).catch(fail)}>
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

const EXEMPT_PERMISSION = 'start-dm-between-restricted';

// Descrição que só repete o nome (ex.: "admin" / "Admin") não diz nada: a célula fica com o traço.
function roleDescription(r: { _id: string; description?: string }) {
  const d = (r.description ?? '').trim();
  return [r._id, roleLabel(r._id)].some((x) => x.toLowerCase() === d.toLowerCase()) ? '' : d;
}

// O que cada brecha deixa criar ("criar grupos privados, times e discussões").
const LOOPHOLE_WHAT: Record<string, string> = {
  'create-p': 'grupos privados',
  'create-team': 'times',
  'start-discussion': 'discussões',
  'start-discussion-other-user': 'discussões',
};

const people = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

// Resumo da política de conversas diretas e das brechas (papéis que deixam pessoas restritas abrir salas privadas).
function DirectReportCard({ state, onFix }: { state: { data: DirectRestrictionReport | null; loading: boolean; error: string | null }; onFix: () => void }) {
  const { data: r, loading, error } = state;
  if (loading && !r)
    return (
      <div className="card direct-report">
        <SkeletonTable rows={3} cols={3} />
      </div>
    );
  if (error || !r) return <div className="card direct-report muted small">Não foi possível carregar o resumo das conversas diretas restritas{error ? `: ${error}` : '.'}</div>;
  if (!r.restrictedRoles.length)
    return (
      <div className="card direct-report">
        <h3>Conversas diretas restritas</h3>
        <p className="muted">Nenhum papel está restrito em conversas diretas.</p>
      </div>
    );
  // As brechas viram um aviso só (criar grupos privados, times e discussões costumam vir do mesmo papel e das mesmas
  // pessoas). start-discussion e start-discussion-other-user contam como uma ação.
  const what = new Set<string>();
  const other = new Set<string>();
  const viaRoles = new Set<string>();
  const sample = new Map<string, string>();
  const counts = new Set<number>();
  for (const l of r.loopholes) {
    if (LOOPHOLE_WHAT[l.permission]) what.add(LOOPHOLE_WHAT[l.permission]);
    else other.add(permissionLabel(l.permission).toLowerCase());
    l.viaRoles.forEach((x) => viaRoles.add(x));
    l.sample.forEach((u) => sample.size < 10 && sample.set(u._id, u.username));
    counts.add(l.users);
  }
  // Contagens diferentes por ação: o número de uma não vale para as outras.
  const one = counts.size === 1 ? [...counts][0] : 0;
  const who = one ? `${people(one)} com papel restrito ainda ${one === 1 ? 'pode' : 'podem'}` : 'Pessoas com papel restrito ainda podem';
  const via = [...viaRoles].map(roleLabel);
  const actions = [...(what.size ? [`criar ${nameList([...what], 3)}`] : []), ...other];
  return (
    <div className="card direct-report">
      <h3>Conversas diretas restritas</h3>
      <p>Papéis restritos: {r.restrictedRoles.map((x) => `${roleLabel(x._id)} (${people(x.users)})`).join(', ')}.</p>
      <p>{r.scope === 'same_role' ? 'Regra: pessoas com o mesmo papel restrito não conversam em particular.' : 'Regra: duas pessoas com papel restrito não conversam em particular.'}</p>
      <p>
        Exceção (permissão {permissionLabel(EXEMPT_PERMISSION)}, <code className="mono">{EXEMPT_PERMISSION}</code>): {r.exemptRoles.length ? r.exemptRoles.map(roleLabel).join(', ') : 'ninguém'}.
      </p>
      {actions.length > 0 && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>
            {who} {nameList(actions, 3)} pelo {via.length === 1 ? 'papel' : 'papéis'} {nameList(via, 3)}, o que abre conversas particulares fora das mensagens diretas. Tire o
            papel dessas pessoas ou as permissões do papel.
            <span className="callout-sample">{[...sample.values()].map((u) => `@${u}`).join(', ')}</span>
          </span>
          <button className="btn small" onClick={onFix}>
            Ver permissões
          </button>
        </div>
      )}
      {r.blockedDirects > 0 && (
        <p className="muted small">
          {r.blockedDirects === 1
            ? '1 conversa direta antiga está bloqueada (o histórico continua disponível).'
            : `${r.blockedDirects} conversas diretas antigas estão bloqueadas (o histórico continua disponível).`}
        </p>
      )}
    </div>
  );
}
