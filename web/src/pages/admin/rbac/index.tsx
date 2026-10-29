// Administração › Papéis e permissões: a lista de papéis com o alcance de cada um, o editor por área (RoleEditor),
// o histórico com reversão (RbacHistory) e o resumo das conversas diretas restritas.
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DirectRestrictionReport } from '@shared/direct';
import { api } from '../../../lib/api';
import { roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { ReachBar, ReachLegend } from './reach';
import { Empty, SkeletonTable, Tabs, Tooltip, confirmDialog, useAsync } from '../../../components/ui';
import { PageHead, RowMenu, TableWrap } from '../parts';
import { DirectReportCard } from './DirectReport';
import { RbacHistory } from './History';
import { RoleEditor } from './RoleEditor';
import { lockText, loadGrant, loadRoles, people, rbacFail, rbacOk, type Grant, type RbacRole } from './data';

type Tab = 'roles' | 'history' | 'direct';

export function AdminPermissions() {
  const { view, param } = useParams();
  const navigate = useNavigate();
  const roles = useAsync(loadRoles, []);
  const grant = useAsync(loadGrant, []);
  const reload = () => (roles.reload(), grant.reload());

  if (view === 'role' || view === 'new')
    return (
      <RoleEditor
        key={`${view}:${param ?? ''}`}
        roleId={view === 'role' ? param : undefined}
        copyFrom={view === 'new' ? param : undefined}
        roles={roles.data}
        grant={grant.data}
        onSaved={(id) => (reload(), navigate(`/admin/permissions/role/${encodeURIComponent(id)}`, { replace: true }))}
        onDeleted={() => (reload(), navigate('/admin/permissions'))}
      />
    );

  const tab: Tab = view === 'history' ? 'history' : view === 'direct' ? 'direct' : 'roles';
  return (
    <>
      <PageHead title="Papéis e permissões">
        {grant.data?.canEditRoles && (
          <button className="btn primary" onClick={() => navigate('/admin/permissions/new')}>
            <Icon name="add" />
            Novo papel
          </button>
        )}
      </PageHead>
      <p className="page-lead">
        Cada pessoa recebe papéis; cada papel libera áreas do chat em níveis (Sem acesso, Visualizar, Gerenciar). Quem gerencia papéis só dá ou tira o que ele mesmo tem.
      </p>
      <Tabs
        value={tab}
        onChange={(t) => navigate(t === 'roles' ? '/admin/permissions' : `/admin/permissions/${t}`)}
        items={[
          { id: 'roles', label: 'Papéis', count: roles.data?.length },
          { id: 'history', label: 'Histórico' },
          { id: 'direct', label: 'Conversas restritas' },
        ]}
      />
      {tab === 'roles' && <RoleList roles={roles.data} grant={grant.data} loading={roles.loading || grant.loading} error={roles.error} onChanged={reload} />}
      {tab === 'history' && <RbacHistory onChanged={reload} />}
      {tab === 'direct' && <DirectTab />}
    </>
  );
}

function DirectTab() {
  const report = useAsync(() => api.get('directRestriction.report').then((r) => r.report as DirectRestrictionReport), []);
  const navigate = useNavigate();
  return <DirectReportCard state={report} onFix={(role) => navigate(`/admin/permissions/role/${encodeURIComponent(role)}`)} />;
}

function RoleList({ roles, grant, loading, error, onChanged }: { roles: RbacRole[] | null; grant: Grant | null; loading: boolean; error: string | null; onChanged: () => void }) {
  const navigate = useNavigate();
  const canAssign = usePermission(['view-user-administration']);
  const groups = useMemo(() => {
    const list = [...(roles ?? [])].sort((a, b) => Number(!!b.root) - Number(!!a.root) || b.users - a.users || roleLabel(a._id).localeCompare(roleLabel(b._id)));
    return [
      { id: 'Users', title: 'Papéis globais', hint: 'Valem em todo o chat.', list: list.filter((r) => r.scope === 'Users') },
      { id: 'Subscriptions', title: 'Papéis de sala', hint: 'Valem só nas salas onde a pessoa tem o papel (Dono, Moderador...).', list: list.filter((r) => r.scope === 'Subscriptions') },
    ];
  }, [roles]);
  if (loading && !roles) return <SkeletonTable rows={8} cols={4} />;
  if (error && !roles) return <Empty icon="error" title="Não foi possível carregar os papéis">{error}</Empty>;

  const remove = async (r: RbacRole) => {
    if (r.users > 0) {
      await confirmDialog({
        title: `${roleLabel(r._id)} ainda está com ${people(r.users)}`,
        body: 'Tire o papel dessas pessoas antes de excluí-lo (em Usuários, filtre pelo papel e use Remover papel em lote).',
        confirmLabel: 'Entendi',
        cancelLabel: 'Fechar',
      });
      return;
    }
    const yes = await confirmDialog({ title: `Excluir o papel ${roleLabel(r._id)}?`, body: 'Ninguém tem este papel. A exclusão fica no histórico e pode ser desfeita de lá.', confirmLabel: 'Excluir', danger: true });
    if (yes)
      api
        .post('rbac.roles.delete', { roleId: r._id })
        .then(() => (rbacOk(`Papel ${roleLabel(r._id)} excluído.`), onChanged()))
        .catch(rbacFail);
  };

  return (
    <div className="rbac-role-groups">
      {groups.map((g) => (
        <section key={g.id} className="rbac-role-group">
          <div className="rbac-section-head">
            <h2>{g.title}</h2>
            <span className="muted small">{g.hint}</span>
            {g.id === 'Users' && <ReachLegend />}
          </div>
          <TableWrap>
            <table className="table stack rbac-roles">
              <thead>
                <tr>
                  <th>Papel</th>
                  <th>Alcance</th>
                  <th className="num">Pessoas</th>
                  <th className="actions-col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.list.map((r) => {
                  const lock = grant?.roleLocks[r._id];
                  const delLock = grant?.deleteLocks[r._id];
                  return (
                    <tr key={r._id} className="rbac-role-row" onClick={() => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}`)}>
                      <td>
                        <div className="cell-entity">
                          <span className={r.root ? 'cell-icon rbac-root-icon' : 'cell-icon'}>
                            <Icon name={r.root ? 'rbac-root' : r.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} />
                          </span>
                          <div>
                            <span className="cell-name">
                              <button type="button" className="link-btn" onClick={(e) => (e.stopPropagation(), navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}`))}>
                                {roleLabel(r._id)}
                              </button>
                              {r.protected && !r.root && <span className="pill tag">Sistema</span>}
                              {r.restrictDirect && (
                                <span className="pill warn tag" title="Restrito em conversas diretas">
                                  <Icon name="direct-blocked" size={12} />
                                  Restrito
                                </span>
                              )}
                              {lock && (
                                <Tooltip label={lockText(lock)}>
                                  <span className="rbac-lock-tag" aria-label={lockText(lock)}>
                                    <Icon name="rbac-lock" size={12} />
                                  </span>
                                </Tooltip>
                              )}
                            </span>
                            <span className="cell-sub">{r.root ? 'Pode tudo na gestão de papéis' : (r.description && r.description !== roleLabel(r._id) ? r.description : r._id)}</span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Alcance">
                        <ReachBar perms={r.permissions} />
                      </td>
                      <td className="num" data-label="Pessoas">
                        {r.users ? (
                          canAssign && r.scope === 'Users' ? (
                            <button type="button" className="link-btn" onClick={(e) => (e.stopPropagation(), navigate(`/admin/users?role=${encodeURIComponent(r._id)}`))}>
                              {r.users}
                            </button>
                          ) : (
                            r.users
                          )
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="actions-col" onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn small ghost" onClick={() => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}`)}>
                            <Icon name={lock || !grant?.canEditRoles ? 'show' : 'edit'} />
                            {lock || !grant?.canEditRoles ? 'Ver' : 'Editar'}
                          </button>
                          {grant?.canEditRoles && (
                            <RowMenu>
                              {(close) => (
                                <>
                                  <button onClick={() => (close(), navigate(`/admin/permissions/new/${encodeURIComponent(r._id)}`))}>
                                    <Icon name="rbac-duplicate" />
                                    Duplicar
                                  </button>
                                  <button
                                    className="danger"
                                    disabled={!!delLock}
                                    title={delLock ? lockText(delLock) : undefined}
                                    onClick={() => {
                                      close();
                                      void remove(r);
                                    }}
                                  >
                                    <Icon name="delete" />
                                    Excluir
                                  </button>
                                </>
                              )}
                            </RowMenu>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </section>
      ))}
    </div>
  );
}
