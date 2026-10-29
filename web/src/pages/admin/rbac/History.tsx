// Histórico de papéis e permissões: quem mudou o quê (pessoa ou sincronização), o antes e o depois com nomes legíveis,
// ações em massa agrupadas e "Reverter" com prévia e substituição do que não existe mais.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { diffPermissions, levelText, RBAC_AREAS, rbacLabel } from '@shared/rbac';
import { api } from '../../../lib/api';
import { formatDateTime, nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Modal, Pager, Segmented, SkeletonTable, useAsync } from '../../../components/ui';
import { rbacFail, rbacOk } from './data';

interface Change {
  field: string;
  before: any;
  after: any;
}
interface Row {
  _id: number;
  batchId: string | null;
  entityType: 'role' | 'user';
  entityId: string;
  entityLabel: string;
  action: 'create' | 'update' | 'delete' | 'bulk' | 'rollback';
  source: string;
  actor: { _id: string | null; username: string | null } | null;
  changes: Change[];
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  revertsId: number | null;
  createdAt: string;
}

const SOURCE: Record<string, string> = { system: 'Automático', ldap: 'LDAP / AD', oauth: 'OAuth', saml: 'SAML', omnichannel: 'Atendimento', migration: 'Migração' };
const FIELD: Record<string, string> = { description: 'Descrição', scope: 'Escopo', mandatory2fa: 'Exigir 2FA', restrictDirect: 'Restrito em conversas diretas' };

const show = (field: string, v: any) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (field === 'scope') return v === 'Users' ? 'Global' : 'De sala';
  return String(v);
};

function headline(r: Row) {
  const who = r.actor?.username ? `@${r.actor.username}` : SOURCE[r.source] ? `${SOURCE[r.source]}` : 'Sistema';
  const target = r.entityType === 'role' ? `o papel ${roleLabel(r.entityId)}` : `os papéis de @${r.entityLabel}`;
  const verb = r.action === 'create' ? (r.entityType === 'role' ? 'criou' : 'cadastrou com papéis') : r.action === 'delete' ? 'excluiu' : r.action === 'rollback' ? 'reverteu' : r.action === 'bulk' ? 'alterou em lote' : 'alterou';
  const tgt = r.entityType === 'user' && r.action === 'create' ? `@${r.entityLabel}` : target;
  return { who, text: `${verb} ${tgt}` };
}

export function ChangeList({ changes }: { changes: Change[]; entityType?: 'role' | 'user' }) {
  return (
    <ul className="rbac-hist-changes">
      {changes.map((c) => {
        if (c.field === 'permissions') {
          const d = diffPermissions(c.before ?? [], c.after ?? []);
          return d.areas.map((a) => {
            const area = RBAC_AREAS.find((x) => x.id === a.area)!;
            return (
              <li key={`p-${a.area}`} className={a.direction}>
                <Icon name={a.direction === 'down' ? 'rbac-down' : a.direction === 'up' ? 'rbac-up' : 'sys-transfer'} size={12} />
                <strong>{area.label}</strong>
                {area.levels.length > 0 && JSON.stringify(a.before) !== JSON.stringify(a.after) && (
                  <span className="muted">
                    {levelText(area, a.before)} → {levelText(area, a.after)}
                  </span>
                )}
                {a.added.length > 0 && <span className="rbac-review-keys add">+ {a.added.map(rbacLabel).join(', ')}</span>}
                {a.removed.length > 0 && <span className="rbac-review-keys del">− {a.removed.map(rbacLabel).join(', ')}</span>}
              </li>
            );
          });
        }
        if (c.field === 'roles' || c.field === 'delegable') {
          const b: string[] = c.before ?? [];
          const a: string[] = c.after ?? [];
          const add = a.filter((x) => !b.includes(x));
          const del = b.filter((x) => !a.includes(x));
          const label = c.field === 'roles' ? 'Papéis' : 'Delegação';
          if (c.before === null || c.after === null) {
            const list = (c.after ?? c.before ?? []) as string[];
            return (
              <li key={c.field}>
                <strong>{label}</strong>
                <span>{list.length ? nameList(list.map(roleLabel), 6) : '—'}</span>
              </li>
            );
          }
          return (
            <li key={c.field} className={add.length && del.length ? 'mixed' : add.length ? 'up' : 'down'}>
              <strong>{label}</strong>
              {add.length > 0 && <span className="rbac-review-keys add">+ {add.map(roleLabel).join(', ')}</span>}
              {del.length > 0 && <span className="rbac-review-keys del">− {del.map(roleLabel).join(', ')}</span>}
            </li>
          );
        }
        return (
          <li key={c.field}>
            <strong>{FIELD[c.field] ?? c.field}</strong>
            <span>
              <s className="muted">{show(c.field, c.before)}</s> → {show(c.field, c.after)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// `entity` fixa o histórico de um papel ou de uma pessoa (aba Histórico dos editores); `embedded` deixa os filtros
// mais enxutos, sem o filtro por tipo nem o chip da entidade.
export function RbacHistory({ onChanged, entity: fixed, embedded }: { onChanged: () => void; entity?: string; embedded?: boolean }) {
  const [params, setParams] = useSearchParams();
  const entity = fixed ?? params.get('entity') ?? '';
  const [type, setType] = useState<'' | 'role' | 'user'>('');
  const [actor, setActor] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  const [revert, setRevert] = useState<Row | null>(null);
  useEffect(() => setOffset(0), [type, actor, start, end, entity]);
  const actors = useAsync(() => api.get('rbac.history.actors').then((r) => r.actors as { _id: string; username: string }[]), []);
  const list = useAsync(
    () =>
      api.get('rbac.history', {
        ...(type ? { type } : {}),
        ...(entity ? { entityId: entity } : {}),
        ...(actor ? { actor } : {}),
        ...(start ? { start: new Date(`${start}T00:00:00`).toISOString() } : {}),
        ...(end ? { end: new Date(`${end}T23:59:59`).toISOString() } : {}),
        offset,
        count,
      }),
    [type, actor, start, end, offset, count, entity],
  );
  const rows: Row[] = list.data?.items ?? [];
  // Ação em massa: as linhas do mesmo lote ficam juntas, com um cabeçalho só.
  const blocks = useMemo(() => {
    const out: { batch: string | null; rows: Row[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (r.batchId && last?.batch === r.batchId) last.rows.push(r);
      else out.push({ batch: r.batchId, rows: [r] });
    }
    return out;
  }, [rows]);

  return (
    <div className={embedded ? 'rbac-history embedded' : 'rbac-history'}>
      <div className="filters admin-filters">
        {!embedded && (
        <Segmented<'' | 'role' | 'user'>
          label="Tipo"
          value={type}
          onChange={setType}
          items={[
            { id: '', label: 'Tudo' },
            { id: 'role', label: 'Papéis' },
            { id: 'user', label: 'Pessoas' },
          ]}
        />
        )}
        <select aria-label="Autor" value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">Qualquer autor</option>
          <option value="system">Sistema e sincronizações</option>
          {(actors.data ?? []).map((a) => (
            <option key={a._id} value={a._id}>
              @{a.username}
            </option>
          ))}
        </select>
        <input type="date" aria-label="De" value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" aria-label="Até" value={end} onChange={(e) => setEnd(e.target.value)} />
        {entity && !fixed && (
          <button className="chip" onClick={() => setParams({})}>
            {roleLabel(entity) || entity}
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {list.loading && !list.data ? (
        <SkeletonTable rows={6} cols={2} />
      ) : list.error ? (
        <Empty icon="error" title="Não foi possível carregar o histórico">
          {list.error}
        </Empty>
      ) : !rows.length ? (
        <Empty icon="rbac-history" title="Nada no histórico com esses filtros">
          Toda alteração de papel, de permissão ou dos papéis de uma pessoa aparece aqui, com quem fez e quando.
        </Empty>
      ) : (
        <ol className="rbac-timeline">
          {blocks.map((b) =>
            b.batch && b.rows.length > 1 ? (
              <li key={b.batch} className="rbac-event batch">
                <div className="rbac-event-head">
                  <span className="rbac-event-icon">
                    <Icon name="admin-users" size={14} />
                  </span>
                  <span>
                    <strong>{headline(b.rows[0]).who}</strong> {b.rows[0].action === 'bulk' ? `alterou em lote os papéis de ${b.rows.length} pessoas` : `fez ${b.rows.length} alterações de uma vez`}
                  </span>
                  <time className="muted small">{formatDateTime(b.rows[0].createdAt)}</time>
                </div>
                <ul className="rbac-batch">
                  {b.rows.map((r) => (
                    <EventRow key={r._id} r={r} nested onRevert={() => setRevert(r)} />
                  ))}
                </ul>
              </li>
            ) : (
              <EventRow key={b.rows[0]._id} r={b.rows[0]} onRevert={() => setRevert(b.rows[0])} />
            ),
          )}
        </ol>
      )}
      {list.data && list.data.total > 0 && <Pager offset={offset} count={count} total={list.data.total} onChange={setOffset} sizes={[25, 50, 100]} onCountChange={(n) => (setCount(n), setOffset(0))} />}
      {revert && (
        <RevertDialog
          row={revert}
          onClose={() => setRevert(null)}
          onDone={() => {
            setRevert(null);
            list.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EventRow({ r, nested, onRevert }: { r: Row; nested?: boolean; onRevert: () => void }) {
  const h = headline(r);
  return (
    <li className={`rbac-event${nested ? ' nested' : ''}${r.rolledBackAt ? ' reverted' : ''}`}>
      <div className="rbac-event-head">
        {!nested && (
          <span className={`rbac-event-icon ${r.action}`}>
            <Icon name={r.action === 'rollback' ? 'rbac-revert' : r.entityType === 'role' ? 'admin-permissions' : 'admin-users'} size={14} />
          </span>
        )}
        <span>
          {nested ? (
            <strong>@{r.entityLabel}</strong>
          ) : (
            <>
              <strong>{h.who}</strong> {h.text}
            </>
          )}
          {r.actor?.username && SOURCE[r.source] && <span className="pill tag">{SOURCE[r.source]}</span>}
          {r.rolledBackAt && (
            <span className="pill tag" title={`Revertida em ${formatDateTime(r.rolledBackAt)}${r.rolledBackBy ? ` por @${r.rolledBackBy}` : ''}`}>
              Revertida
            </span>
          )}
        </span>
        {!nested && <time className="muted small">{formatDateTime(r.createdAt)}</time>}
        {!r.rolledBackAt && !(r.entityType === 'user' && r.action === 'create') && (
          <button className="btn small ghost rbac-revert" onClick={onRevert}>
            <Icon name="rbac-revert" />
            Reverter
          </button>
        )}
      </div>
      <ChangeList changes={r.changes} entityType={r.entityType} />
    </li>
  );
}

function RevertDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const preview = useAsync(() => api.get('rbac.history.preview', { id: row._id }), [row._id]);
  const roles = useAsync(() => api.get('roles.list').then((r) => r.roles as { _id: string; scope: string }[]), []);
  const [replace, setReplace] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const p = preview.data;
  const changes: Change[] = useMemo(() => {
    if (!p || p.blocked) return [];
    if (p.kind === 'delete-role') return [];
    return Object.keys(p.next).map((f) => ({ field: f, before: p.current ? p.current[f] : null, after: p.next[f] }));
  }, [p]);
  const go = async () => {
    setBusy(true);
    try {
      const rep = Object.fromEntries((p?.missing ?? []).map((m: string) => [m, replace[m] || null]));
      await api.post('rbac.history.rollback', { id: row._id, replace: rep });
      rbacOk('Alteração revertida.');
      onDone();
    } catch (e) {
      rbacFail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Reverter esta alteração?"
      description={`${headline(row).who} ${headline(row).text} em ${formatDateTime(row.createdAt)}.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !p || !!p.blocked} aria-busy={busy || undefined} onClick={() => void go()}>
            <Icon name="rbac-revert" />
            Reverter
          </button>
        </>
      }
    >
      {!p && !preview.error ? (
        <SkeletonTable rows={3} cols={1} />
      ) : preview.error ? (
        <div className="callout danger">
          <Icon name="error" />
          <span>{preview.error}</span>
        </div>
      ) : !p || p.blocked ? (
        <div className="callout warn">
          <Icon name="warning" />
          <span>{p?.blocked}</span>
        </div>
      ) : (
        <div className="rbac-revert-body">
          <p className="muted small">Volta só o que esta versão mudou. Mudanças feitas depois, em outras permissões, continuam como estão. A reversão também fica no histórico.</p>
          {p.kind === 'delete-role' ? (
            <div className="callout warn">
              <Icon name="delete" />
              <span>O papel {roleLabel(row.entityId)} será excluído (ele foi criado nesta versão).</span>
            </div>
          ) : (
            <ChangeList changes={changes} entityType={row.entityType} />
          )}
          {p.missing.length > 0 && (
            <div className="rbac-missing">
              <div className="callout warn">
                <Icon name="warning" />
                <span>Estes papéis não existem mais. Escolha um substituto ou deixe sem.</span>
              </div>
              {p.missing.map((m: string) => (
                <Field key={m} label={`No lugar de ${m}`}>
                  <select value={replace[m] ?? ''} onChange={(e) => setReplace({ ...replace, [m]: e.target.value })}>
                    <option value="">Nenhum</option>
                    {(roles.data ?? [])
                      .filter((r) => r.scope === 'Users' && r._id !== 'admin')
                      .map((r) => (
                        <option key={r._id} value={r._id}>
                          {roleLabel(r._id)}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
