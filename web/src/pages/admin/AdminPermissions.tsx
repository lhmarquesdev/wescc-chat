import { Fragment, useMemo, useState } from 'react';
import type { DirectRestrictionReport } from '@shared/direct';
import { api, errorMessage } from '../../lib/api';
import { useStore } from '../../lib/store';
import { UserPicker, type PickedUser } from '../../components/Pickers';
import { Field, Modal, Spinner, Tabs, Toggle, useAsync } from '../../components/ui';

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
  omnichannel: 'Omnichannel',
  general: 'Geral',
};

export function AdminPermissions() {
  const [tab, setTab] = useState<'permissions' | 'roles'>('permissions');
  const perms = useAsync(() => api.get('permissions.listAll'), []);
  const roles = useAsync(() => api.get('roles.list'), []);
  const report = useAsync(() => api.get('directRestriction.report').then((r) => r.report as DirectRestrictionReport), []);
  const [filter, setFilter] = useState('');
  const [editRole, setEditRole] = useState<any>(null);
  const [usersOf, setUsersOf] = useState<string | null>(null);
  const [scope, setScope] = useState<'Users' | 'Subscriptions' | 'all'>('all');

  const grouped = useMemo(() => {
    const out: Record<string, any[]> = {};
    for (const p of perms.data?.update ?? []) {
      if (filter && !p._id.includes(filter.toLowerCase())) continue;
      (out[p.group] ??= []).push(p);
    }
    return out;
  }, [perms.data, filter]);

  if (perms.loading || roles.loading) return <Spinner />;
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
      <div className="page-title-row">
        <h1>Papéis e permissões</h1>
        <button className="btn primary" onClick={() => setEditRole({ name: '', description: '', scope: 'Users', mandatory2fa: false, isNew: true })}>
          ＋ Novo papel
        </button>
      </div>
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
          <div className="filters">
            <input placeholder="Filtrar permissões" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select value={scope} onChange={(e) => setScope(e.target.value as any)}>
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
                    <th key={r._id} title={r.description}>
                      {r._id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(grouped).map(([g, list]) => (
                  <Fragment key={g}>
                    <tr className="group-row">
                      <td colSpan={roleList.length + 1}>{GROUP_LABEL[g] ?? g}</td>
                    </tr>
                    {list.map((p) => (
                      <tr key={p._id}>
                        <td className="mono">{p._id}</td>
                        {roleList.map((r: any) => (
                          <td key={r._id} className="center">
                            <input type="checkbox" checked={p.roles.includes(r._id)} onChange={() => toggle(p, r._id)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <DirectReportCard state={report} />
          <table className="table">
            <thead>
              <tr>
                <th>Papel</th>
                <th>Descrição</th>
                <th>Escopo</th>
                <th>2FA obrigatório</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.data?.roles.map((r: any) => (
                <tr key={r._id}>
                  <td>
                    <strong>{r._id}</strong> {r.protected && <span className="pill">sistema</span>}{' '}
                    {r.restrictDirect && (
                      <span className="pill blocked" title="Restrito em conversas diretas">
                        restrito
                      </span>
                    )}
                  </td>
                  <td>{r.description}</td>
                  <td>{r.scope === 'Users' ? 'Global' : 'Por sala'}</td>
                  <td>{r.mandatory2fa ? 'Sim' : 'Não'}</td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => setUsersOf(r._id)}>
                      Usuários
                    </button>
                    <button className="btn small" onClick={() => setEditRole(r)}>
                      Editar
                    </button>
                    {!r.protected && (
                      <button className="btn small danger" onClick={() => confirm(`Excluir o papel ${r._id}?`) && api.post('roles.delete', { roleId: r._id }).then(roles.reload).catch(fail)}>
                        Excluir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
      title={role.isNew ? 'Novo papel' : `Papel ${role._id}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Salvar
        </button>
      }
    >
      <div className="form">
        <Field label="Nome">
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
        <Toggle checked={f.mandatory2fa} onChange={(v) => setF({ ...f, mandatory2fa: v })} label="Exigir 2FA de quem tem este papel" />
        {f.scope === 'Users' && (
          <>
            <Toggle checked={f.restrictDirect} onChange={(v) => setF({ ...f, restrictDirect: v })} label="Restrito em conversas diretas" />
            <span className="field-hint opt-hint">
              Quem tem este papel não pode iniciar conversas diretas nem chamadas com outras pessoas restritas. A exceção é quem tem a permissão start-dm-between-restricted.
            </span>
          </>
        )}
      </div>
    </Modal>
  );
}

function RoleUsers({ role, onClose }: { role: string; onClose: () => void }) {
  const { data, loading, reload } = useAsync(() => api.get('roles.getUsersInRole', { role, count: 200 }), [role]);
  const [add, setAdd] = useState<PickedUser[]>([]);
  return (
    <Modal title={`Usuários com o papel ${role}`} onClose={onClose}>
      <div className="form">
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
      {loading ? (
        <Spinner />
      ) : (
        <ul className="plain-list">
          {data?.users.map((u: any) => (
            <li key={u._id}>
              @{u.username} — {u.name}
              <button className="btn small" onClick={() => api.post('roles.removeUserFromRole', { roleId: role, userId: u._id }).then(reload).catch(fail)}>
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

const LOOPHOLE_ACTION: Record<string, string> = {
  'create-p': 'criar grupos privados',
  'create-team': 'criar times',
  'start-discussion': 'criar discussões',
  'start-discussion-other-user': 'criar discussões',
};

const people = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;

// Resumo da política de conversas diretas e das brechas (papéis que deixam pessoas restritas abrir salas privadas).
function DirectReportCard({ state }: { state: { data: DirectRestrictionReport | null; loading: boolean; error: string | null } }) {
  const { data: r, loading, error } = state;
  if (loading && !r)
    return (
      <div className="card direct-report">
        <Spinner />
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
  // start-discussion e start-discussion-other-user dizem a mesma coisa: um aviso só.
  const warnings = new Map<string, { users: number; viaRoles: Set<string>; sample: Map<string, string> }>();
  for (const l of r.loopholes) {
    const action = LOOPHOLE_ACTION[l.permission] ?? l.permission;
    const w = warnings.get(action) ?? { users: 0, viaRoles: new Set<string>(), sample: new Map<string, string>() };
    w.users = Math.max(w.users, l.users);
    l.viaRoles.forEach((x) => w.viaRoles.add(x));
    l.sample.forEach((u) => w.sample.size < 10 && w.sample.set(u._id, u.username));
    warnings.set(action, w);
  }
  return (
    <div className="card direct-report">
      <h3>Conversas diretas restritas</h3>
      <p>Papéis restritos: {r.restrictedRoles.map((x) => `${x._id} (${people(x.users)})`).join(', ')}.</p>
      <p>{r.scope === 'same_role' ? 'Regra: pessoas com o mesmo papel restrito não conversam em particular.' : 'Regra: duas pessoas com papel restrito não conversam em particular.'}</p>
      <p>Exceção (permissão start-dm-between-restricted): {r.exemptRoles.length ? r.exemptRoles.join(', ') : 'ninguém'}.</p>
      {[...warnings].map(([action, w]) => (
        <p key={action} className="warn-note">
          ⚠ {people(w.users)} com papel restrito também {w.users === 1 ? 'pode' : 'podem'} {action} pelo papel {[...w.viaRoles].join(', ')}. Isso permite conversas particulares fora das mensagens diretas. Tire esse papel dessas pessoas ou essa permissão do papel.
          <span className="sample">{[...w.sample.values()].map((u) => `@${u}`).join(', ')}</span>
        </p>
      ))}
      {r.blockedDirects > 0 && (
        <p className="muted small">
          {r.blockedDirects === 1 ? '1 conversa direta antiga está bloqueada (o histórico continua disponível).' : `${r.blockedDirects} conversas diretas antigas estão bloqueadas (o histórico continua disponível).`}
        </p>
      )}
    </div>
  );
}
