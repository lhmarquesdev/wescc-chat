// Administração › Papéis e permissões: lista em faixa única (busca, contador, Todos/Sistema/Personalizados, Novo
// papel) com a tabela de papéis; o editor (RoleEditor) com abas no rodapé; o histórico com reversão e o resumo das
// conversas diretas restritas, cada um na sua página.
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { DirectRestrictionReport } from '@shared/direct';
import { RBAC_KEYS, VISIBLE_KEYS } from '@shared/rbac';
import { api } from '../../../lib/api';
import { plural, roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Modal, SkeletonTable, Tooltip, confirmDialog, useAsync } from '../../../components/ui';
import { RowMenu } from '../parts';
import { DirectReportCard } from './DirectReport';
import { RbacHistory } from './History';
import { RoleEditor } from './RoleEditor';
import { ReachBar } from './reach';
import { Chips, ListStrip, LockHint } from './shell';
import { lockText, loadGrant, loadRoles, people, rbacFail, rbacOk, type Grant, type RbacRole } from './data';

type Kind = 'all' | 'system' | 'custom';

export function AdminPermissions() {
  const { view, param } = useParams();
  const navigate = useNavigate();
  const roles = useAsync(loadRoles, []);
  const grant = useAsync(loadGrant, []);
  const reload = () => (roles.reload(), grant.reload());

  if (view === 'role' && param)
    return <RoleEditor key={param} roleId={param} roles={roles.data} grant={grant.data} onSaved={reload} onDeleted={() => (reload(), navigate('/admin/permissions'))} />;
  if (view === 'history')
    return (
      <div className="rbac-shell list">
        <ListStrip eyebrow="Papéis e permissões" title="Histórico de alterações">
          <button className="btn ghost" onClick={() => navigate('/admin/permissions')}>
            <Icon name="back" />
            Papéis
          </button>
        </ListStrip>
        <div className="rbac-list-body">
          <RbacHistory onChanged={reload} />
        </div>
      </div>
    );
  if (view === 'direct') return <DirectPage />;
  return <RoleList roles={roles.data} grant={grant.data} loading={roles.loading || grant.loading} error={roles.error} onChanged={reload} />;
}

function DirectPage() {
  const navigate = useNavigate();
  const report = useAsync(() => api.get('directRestriction.report').then((r) => r.report as DirectRestrictionReport), []);
  return (
    <div className="rbac-shell list">
      <ListStrip eyebrow="Papéis e permissões" title="Conversas restritas">
        <button className="btn ghost" onClick={() => navigate('/admin/permissions')}>
          <Icon name="back" />
          Papéis
        </button>
      </ListStrip>
      <div className="rbac-list-body">
        <DirectReportCard state={report} onFix={(role) => navigate(`/admin/permissions/role/${encodeURIComponent(role)}`)} />
      </div>
    </div>
  );
}

function RoleList({ roles, grant, loading, error, onChanged }: { roles: RbacRole[] | null; grant: Grant | null; loading: boolean; error: string | null; onChanged: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canSeeUsers = usePermission(['view-user-administration']);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const copyFrom = params.get('copy');

  const all = useMemo(() => [...(roles ?? [])].sort((a, b) => Number(!!b.root) - Number(!!a.root) || roleLabel(a._id).localeCompare(roleLabel(b._id), 'pt-BR')), [roles]);
  const term = q.trim().toLowerCase();
  const list = all.filter((r) => {
    if (kind === 'system' && !r.protected) return false;
    if (kind === 'custom' && r.protected) return false;
    return !term || [r._id, roleLabel(r._id), r.description ?? ''].some((t) => t.toLowerCase().includes(term));
  });
  const canWrite = !!grant?.canEditRoles;
  const deletable = (r: RbacRole) => canWrite && !grant?.deleteLocks[r._id];
  const open = (r: RbacRole) => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}`);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectable = list.filter(deletable);
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r._id));

  const removeMany = async (ids: string[]) => {
    const targets = all.filter((r) => ids.includes(r._id));
    const inUse = targets.filter((r) => r.users > 0);
    if (inUse.length) {
      await confirmDialog({
        title: inUse.length === 1 ? `${roleLabel(inUse[0]._id)} ainda está com ${people(inUse[0].users)}` : `${inUse.length} papéis ainda têm pessoas`,
        body: `Tire o papel dessas pessoas antes de excluir (${inUse.map((r) => `${roleLabel(r._id)}: ${people(r.users)}`).join('; ')}).`,
        confirmLabel: 'Entendi',
        cancelLabel: 'Fechar',
      });
      return;
    }
    const yes = await confirmDialog({
      title: targets.length === 1 ? `Excluir o papel ${roleLabel(targets[0]._id)}?` : `Excluir ${targets.length} papéis?`,
      body: 'Ninguém perde acesso: nenhuma pessoa tem esses papéis. A exclusão fica no histórico e pode ser desfeita de lá.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    let done = 0;
    for (const r of targets) {
      try {
        await api.post('rbac.roles.delete', { roleId: r._id });
        done++;
      } catch (e) {
        rbacFail(e);
      }
    }
    if (done) rbacOk(`${plural(done, 'papel excluído', 'papéis excluídos')}.`);
    setSelected(new Set());
    onChanged();
  };

  const counts = { all: all.length, system: all.filter((r) => r.protected).length, custom: all.filter((r) => !r.protected).length };
  return (
    <div className="rbac-shell list">
      <ListStrip eyebrow="Papéis e permissões" title="Papéis" search={q} onSearch={setQ} placeholder="Buscar papéis..." count={list.length}>
        <Chips<Kind>
          label="Tipo"
          value={kind}
          onChange={setKind}
          items={[
            { id: 'all', label: 'Todos', count: counts.all },
            { id: 'system', label: 'Sistema', count: counts.system },
            { id: 'custom', label: 'Personalizados', count: counts.custom },
          ]}
        />
        <Tooltip label="Histórico de alterações">
          <button className="icon-btn" aria-label="Histórico de alterações" onClick={() => navigate('/admin/permissions/history')}>
            <Icon name="rbac-history" />
          </button>
        </Tooltip>
        <Tooltip label="Conversas restritas">
          <button className="icon-btn" aria-label="Conversas restritas" onClick={() => navigate('/admin/permissions/direct')}>
            <Icon name="direct-blocked" />
          </button>
        </Tooltip>
        {canWrite && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="add" />
            Novo papel
          </button>
        )}
      </ListStrip>
      <div className="rbac-list-body flush">
        {loading && !roles ? (
          <SkeletonTable rows={6} cols={5} />
        ) : error && !roles ? (
          <Empty icon="error" title="Não foi possível carregar os papéis">
            {error}
          </Empty>
        ) : !list.length ? (
          <Empty icon="admin-permissions" title={term ? `Nenhum papel para “${q}”` : 'Nenhum papel cadastrado'} />
        ) : (
          <table className="table stack rbac-roles">
            <thead>
              <tr>
                {canWrite && (
                  <th className="check-col">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os papéis que você pode excluir"
                      checked={allOn}
                      disabled={!selectable.length}
                      onChange={() => setSelected(allOn ? new Set() : new Set(selectable.map((r) => r._id)))}
                    />
                  </th>
                )}
                <th>
                  <span className="th-icon">
                    <Icon name="admin-permissions" size={14} />
                    Papel
                  </span>
                </th>
                <th>
                  <span className="th-icon">
                    <Icon name="rbac-id" size={14} />
                    Identificador
                  </span>
                </th>
                <th>
                  <span className="th-icon">
                    <Icon name="rbac-areas" size={14} />
                    Acesso
                  </span>
                </th>
                <th className="num">
                  <span className="th-icon">
                    <Icon name="admin-users" size={14} />
                    Pessoas
                  </span>
                </th>
                <th>Tipo</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const lock = grant?.roleLocks[r._id];
                const delLock = grant?.deleteLocks[r._id];
                return (
                  <tr key={r._id} className={`rbac-role-row${selected.has(r._id) ? ' selected' : ''}`} onClick={() => open(r)}>
                    {canWrite && (
                      <td className="check-col" onClick={(e) => e.stopPropagation()}>
                        {deletable(r) ? (
                          <input type="checkbox" aria-label={`Selecionar ${roleLabel(r._id)}`} checked={selected.has(r._id)} onChange={() => toggle(r._id)} />
                        ) : (
                          <LockHint text={lockText(delLock) || 'Não pode ser excluído.'} />
                        )}
                      </td>
                    )}
                    <td>
                      <div className="cell-entity">
                        <span className={`cell-icon rbac-role-icon${r.root ? ' root' : r.scope === 'Subscriptions' ? ' room' : ''}`}>
                          <Icon name={r.root ? 'rbac-root' : r.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} />
                        </span>
                        <div>
                          <span className="cell-name">
                            <button type="button" className="link-btn" onClick={(e) => (e.stopPropagation(), open(r))}>
                              {roleLabel(r._id)}
                            </button>
                            {r.restrictDirect && (
                              <span className="pill warn tag" title="Restrito em conversas diretas">
                                <Icon name="direct-blocked" size={12} />
                                Restrito
                              </span>
                            )}
                            {lock && <LockHint text={lockText(lock)} />}
                          </span>
                          <span className="cell-sub">{r.scope === 'Users' ? 'Global' : 'De sala'}</span>
                        </div>
                      </div>
                    </td>
                    <td data-label="Identificador">
                      <code className="mono small rbac-id">{r._id}</code>
                    </td>
                    <td data-label="Acesso">{r.root ? <span className="rbac-total">Acesso total à gestão</span> : <ReachBar perms={r.permissions} compact />}</td>
                    <td className="num" data-label="Pessoas">
                      {r.users ? (
                        canSeeUsers && r.scope === 'Users' ? (
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
                    <td data-label="Tipo">
                      <span className={`rbac-type${r.root ? ' root' : r.protected ? '' : ' custom'}`}>{r.root ? 'Administrador' : r.protected ? 'Sistema' : 'Personalizado'}</span>
                    </td>
                    <td className="actions-col" onClick={(e) => e.stopPropagation()}>
                      <RowMenu>
                        {(close) => (
                          <>
                            <button onClick={() => (close(), open(r))}>
                              <Icon name={lock || !canWrite ? 'show' : 'edit'} />
                              {lock || !canWrite ? 'Ver' : 'Editar'}
                            </button>
                            {canWrite && (
                              <button onClick={() => (close(), setParams({ copy: r._id }))}>
                                <Icon name="rbac-duplicate" />
                                Duplicar
                              </button>
                            )}
                            {canWrite && (
                              <button className="danger" disabled={!!delLock} title={delLock ? lockText(delLock) : undefined} onClick={() => (close(), void removeMany([r._id]))}>
                                <Icon name="delete" />
                                Excluir
                              </button>
                            )}
                          </>
                        )}
                      </RowMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {selected.size > 0 && (
        <div className="rbac-bulk" role="toolbar" aria-label="Ações em lote">
          <span className="rbac-bulk-count">
            <Icon name="check" />
            {plural(selected.size, 'selecionado', 'selecionados')}
          </span>
          <button type="button" className="btn small ghost danger" onClick={() => void removeMany([...selected])}>
            <Icon name="delete" />
            Excluir ({selected.size})
          </button>
          <button type="button" className="btn small ghost" aria-label="Limpar seleção" onClick={() => setSelected(new Set())}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {(creating || copyFrom) && grant && (
        <CreateRole
          source={copyFrom ? all.find((r) => r._id === copyFrom) : undefined}
          grant={grant}
          onClose={() => {
            setCreating(false);
            if (copyFrom) setParams({});
          }}
          onCreated={(id) => {
            onChanged();
            navigate(`/admin/permissions/role/${encodeURIComponent(id)}`);
          }}
        />
      )}
    </div>
  );
}

// Criação por modal curto: identificador, nome e escopo. Duplicar leva as permissões da origem (quem não é
// administrador só leva as que tem). O resto se completa no editor.
function CreateRole({ source, grant, onClose, onCreated }: { source?: RbacRole; grant: Grant; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState(source ? `${source._id}-copia` : '');
  const [label, setLabel] = useState(source ? `Cópia de ${roleLabel(source._id)}` : '');
  const [scope, setScope] = useState<'Users' | 'Subscriptions'>(source?.scope ?? 'Users');
  const [busy, setBusy] = useState(false);
  const held = new Set(grant.held);
  const perms = (source?.permissions ?? []).filter((k) => grant.root || held.has(k));
  const stripped = (source?.permissions ?? []).filter((k) => !perms.includes(k) && VISIBLE_KEYS.includes(k));
  const valid = /^[a-zA-Z0-9 _.-]+$/.test(name.trim());
  const create = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), description: label.trim(), scope };
      if (source) Object.assign(body, { permissions: grant.canEditPermissions ? perms : [], mandatory2fa: source.mandatory2fa, restrictDirect: scope === 'Users' && source.restrictDirect });
      await api.post('rbac.roles.create', body);
      rbacOk(`Papel ${label.trim() || name.trim()} criado.`);
      onCreated(name.trim());
    } catch (e) {
      rbacFail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title={source ? `Duplicar ${roleLabel(source._id)}` : 'Novo papel'}
      description="Depois de criar, você escolhe as permissões no editor."
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
        <Field label="Identificador" hint="Sem acentos, ex.: supervisor. Não muda depois.">
          <input value={name} autoFocus maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Nome exibido">
          <input value={label} maxLength={60} placeholder="Supervisor de operação" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Escopo">
          <select value={scope} onChange={(e) => setScope(e.target.value as 'Users' | 'Subscriptions')}>
            <option value="Users">Global: vale em todo o chat</option>
            <option value="Subscriptions">De sala: vale só nas salas onde a pessoa tem o papel</option>
          </select>
        </Field>
        {source && (
          <p className="field-hint">
            Leva {plural(perms.length, 'permissão', 'permissões')} de {roleLabel(source._id)}
            {stripped.length > 0
              ? `; ${plural(stripped.length, 'fica', 'ficam')} de fora porque você não ${stripped.length === 1 ? 'a' : 'as'} tem: ${stripped
                  .slice(0, 3)
                  .map((k) => RBAC_KEYS[k]?.label ?? k)
                  .join(', ')}${stripped.length > 3 ? '...' : ''}`
              : ''}
            .
          </p>
        )}
      </div>
    </Modal>
  );
}
