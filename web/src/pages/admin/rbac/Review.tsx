// "Revisar alterações": antes de gravar, o que muda no papel em linguagem de gestor, agrupado por área, com setas de
// amplia/reduz, avisos (perder o próprio acesso, brecha de papel restrito, permissão sensível) e quantas pessoas
// ativas são afetadas. Com permissão sensível entrando, salvar pede o "Entendi". A matriz usa o modo de vários papéis.
import { useState } from 'react';
import { DIRECT_LOOPHOLES } from '@shared/direct';
import { AREA_GROUP, diffPermissions, levelText, RBAC_AREAS, RBAC_GROUPS, RBAC_KEYS, rbacLabel, screenGapWarning, sensitiveAdded, type AreaChange } from '@shared/rbac';
import { nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { useIsPhone } from '../../../components/overlay';
import { Modal } from '../../../components/ui';
import { groupIcon } from './groupIcons';
import { people, type Grant, type RbacRole } from './data';

export interface Draft {
  name: string;
  description: string;
  purpose: string;
  scope: 'Users' | 'Subscriptions';
  mandatory2fa: boolean;
  restrictDirect: boolean;
  permissions: Set<string>;
  delegable: string[];
}

const active = (n: number) => `${people(n)} ${n === 1 ? 'ativa' : 'ativas'}`;

// Avisos de uma troca de permissões num papel: o que o próprio ator perde, brecha de papel restrito, gestão de papéis
// e, à parte, as sensíveis que entram (estas pedem o "Entendi").
export function permissionWarnings(role: RbacRole | undefined, before: Set<string>, after: Set<string>, restricted: boolean, grant: Grant) {
  const warnings: string[] = [];
  const lost = [...before].filter((k) => !after.has(k));
  if (role && grant.ownRoles.includes(role._id) && lost.length)
    warnings.push(`Você tem este papel: também perde ${nameList(lost.slice(0, 3).map(rbacLabel), 3)}${lost.length > 3 ? ' e outras' : ''} (a não ser que outro papel seu dê o mesmo).`);
  const holes = DIRECT_LOOPHOLES.filter((k) => after.has(k));
  if (restricted && holes.length) warnings.push(`O papel é restrito em conversas diretas, mas deixa ${nameList(holes.map((k) => rbacLabel(k).toLowerCase()), 3)}: isso abre conversas particulares.`);
  const diff = diffPermissions(before, after);
  if (diff.areas.some((a) => a.area === 'admin-permissions' && a.direction !== 'down')) warnings.push('Quem tem este papel passa a mexer em papéis e permissões (só no que ele mesmo tiver).');
  // Dar papéis sem ver a lista de usuários: a permissão vale, mas não há tela para usá-la (só quando a troca cria isso).
  const gap = screenGapWarning(after);
  if (gap && gap !== screenGapWarning(before)) warnings.push(gap);
  const n = role?.activeUsers ?? 0;
  const sensitive = sensitiveAdded(before, after).map((k) => `Sensível: ${rbacLabel(k)}. ${RBAC_KEYS[k].sensitive}${n ? ` ${active(n)} ${n === 1 ? 'passa' : 'passam'} a ter.` : ''}`);
  return { warnings, sensitive, diff };
}

function Callouts({ warnings, sensitive }: { warnings: string[]; sensitive: string[] }) {
  return (
    <>
      {warnings.map((w) => (
        <div key={w} className="callout warn">
          <Icon name="warning" />
          <span>{w}</span>
        </div>
      ))}
      {sensitive.map((w) => (
        <div key={w} className="callout warn rbac-review-sensitive">
          <Icon name="rbac-sensitive" />
          <span>{w}</span>
        </div>
      ))}
    </>
  );
}

function Understood({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="rbac-understood">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Entendi o que estas permissões liberam.
    </label>
  );
}

export function ReviewDialog({
  role,
  isNew,
  initial,
  draft,
  grant,
  saving,
  onClose,
  onConfirm,
}: {
  role?: RbacRole;
  isNew: boolean;
  initial: Draft;
  draft: Draft;
  grant: Grant;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const phone = useIsPhone();
  const [ok, setOk] = useState(false);
  const meta: { label: string; before: string; after: string }[] = [];
  const yesNo = (v: boolean) => (v ? 'Sim' : 'Não');
  if (!isNew && initial.description !== draft.description) meta.push({ label: 'Nome exibido', before: initial.description || '—', after: draft.description || '—' });
  if (!isNew && initial.purpose !== draft.purpose) meta.push({ label: 'Para que serve', before: initial.purpose || '—', after: draft.purpose || '—' });
  if (initial.scope !== draft.scope) meta.push({ label: 'Escopo', before: initial.scope === 'Users' ? 'Global' : 'De sala', after: draft.scope === 'Users' ? 'Global' : 'De sala' });
  if (initial.mandatory2fa !== draft.mandatory2fa) meta.push({ label: 'Exigir 2FA', before: yesNo(initial.mandatory2fa), after: yesNo(draft.mandatory2fa) });
  if (initial.restrictDirect !== draft.restrictDirect) meta.push({ label: 'Restrito em conversas diretas', before: yesNo(initial.restrictDirect), after: yesNo(draft.restrictDirect) });
  const delegAdded = draft.delegable.filter((x) => !initial.delegable.includes(x));
  const delegRemoved = initial.delegable.filter((x) => !draft.delegable.includes(x));

  const { warnings, sensitive, diff } = permissionWarnings(role, initial.permissions, draft.permissions, draft.scope === 'Users' && draft.restrictDirect, grant);
  const nothing = !diff.areas.length && !meta.length && !delegAdded.length && !delegRemoved.length && !diff.other.added.length && !diff.other.removed.length;
  const affected = role?.activeUsers ?? 0;

  return (
    <Modal
      wide
      variant={phone ? 'sheet' : undefined}
      title={isNew ? `Criar o papel ${draft.name.trim()}` : `Revisar alterações em ${roleLabel(role!._id)}`}
      description={isNew ? 'Confira o que o papel novo libera.' : affected ? `${active(affected)} ${affected === 1 ? 'tem' : 'têm'} este papel e ${affected === 1 ? 'sente' : 'sentem'} a mudança na hora.` : 'Ninguém ativo tem este papel agora.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            Voltar ao editor
          </button>
          <button className="btn primary" onClick={onConfirm} disabled={saving || nothing || (sensitive.length > 0 && !ok)} aria-busy={saving || undefined}>
            {isNew ? 'Criar papel' : 'Salvar alterações'}
          </button>
        </>
      }
    >
      <div className="rbac-review">
        <Callouts warnings={warnings} sensitive={sensitive} />
        {sensitive.length > 0 && <Understood checked={ok} onChange={setOk} />}
        {nothing && <p className="muted">Nenhuma alteração.</p>}
        {meta.length > 0 && (
          <section className="rbac-review-group">
            <h3>Identificação</h3>
            <ul>
              {meta.map((m) => (
                <li key={m.label} className="rbac-review-row">
                  <span className="rbac-review-area">{m.label}</span>
                  <span className="rbac-review-change">
                    <s>{m.before}</s>
                    <Icon name="next" size={14} />
                    <strong>{m.after}</strong>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <DiffGroups diff={diff} />
        {(delegAdded.length > 0 || delegRemoved.length > 0) && (
          <section className="rbac-review-group">
            <h3>
              <Icon name="rbac-delegation" size={14} />
              Delegação
            </h3>
            <ul>
              {delegAdded.length > 0 && (
                <li className="rbac-review-row up">
                  <Icon name="rbac-up" size={14} />
                  <span>Passa a dar e editar: {nameList(delegAdded.map(roleLabel), 4)}</span>
                </li>
              )}
              {delegRemoved.length > 0 && (
                <li className="rbac-review-row down">
                  <Icon name="rbac-down" size={14} />
                  <span>Deixa de dar e editar: {nameList(delegRemoved.map(roleLabel), 4)}</span>
                </li>
              )}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

// Matriz: vários papéis de uma vez, uma seção por papel com o que muda e os avisos dele.
export function MatrixReviewDialog({
  items,
  grant,
  saving,
  onClose,
  onConfirm,
}: {
  items: { role: RbacRole; before: Set<string>; after: Set<string> }[];
  grant: Grant;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const phone = useIsPhone();
  const [ok, setOk] = useState(false);
  const parts = items.map((i) => ({ ...i, ...permissionWarnings(i.role, i.before, i.after, i.role.scope === 'Users' && !!i.role.restrictDirect, grant) }));
  const needOk = parts.some((p) => p.sensitive.length);
  const n = items.reduce((s, i) => s + (i.role.activeUsers ?? 0), 0);
  return (
    <Modal
      wide
      variant={phone ? 'sheet' : undefined}
      title="Revisar alterações na matriz"
      description={`${items.length} ${items.length === 1 ? 'papel muda' : 'papéis mudam'}. ${n ? `${active(n)} ${n === 1 ? 'sente' : 'sentem'} a mudança na hora.` : 'Ninguém ativo tem esses papéis agora.'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            Voltar à matriz
          </button>
          <button className="btn primary" onClick={onConfirm} disabled={saving || !items.length || (needOk && !ok)} aria-busy={saving || undefined}>
            Salvar alterações
          </button>
        </>
      }
    >
      <div className="rbac-review">
        {parts.map((p) => (
          <section key={p.role._id} className="rbac-review-role">
            <h3 className="rbac-review-role-name">
              <Icon name={p.role.root ? 'rbac-root' : p.role.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} size={16} />
              {roleLabel(p.role._id)}
              <span className="muted small">{active(p.role.activeUsers ?? 0)}</span>
            </h3>
            <Callouts warnings={p.warnings} sensitive={p.sensitive} />
            <DiffGroups diff={p.diff} />
          </section>
        ))}
        {needOk && <Understood checked={ok} onChange={setOk} />}
      </div>
    </Modal>
  );
}

function DiffGroups({ diff }: { diff: ReturnType<typeof diffPermissions> }) {
  return (
    <>
      {RBAC_GROUPS.map((g) => {
        const list = diff.areas.filter((a) => a.group === g.id);
        if (!list.length) return null;
        return (
          <section key={g.id} className="rbac-review-group">
            <h3>
              <Icon name={groupIcon(g.id)} size={14} />
              {g.label}
            </h3>
            <ul>
              {list.map((a) => (
                <AreaDiff key={a.area} change={a} />
              ))}
            </ul>
          </section>
        );
      })}
      {(diff.other.added.length > 0 || diff.other.removed.length > 0) && (
        <section className="rbac-review-group">
          <h3>Outras permissões</h3>
          <p className="muted small">{[...diff.other.added.map((k) => `+ ${rbacLabel(k)}`), ...diff.other.removed.map((k) => `− ${rbacLabel(k)}`)].join(' · ')}</p>
        </section>
      )}
    </>
  );
}

export function AreaDiff({ change }: { change: AreaChange }) {
  const area = RBAC_AREAS.find((a) => a.id === change.area)!;
  const levelChanged = area.levels.length > 0 && JSON.stringify(change.before) !== JSON.stringify(change.after);
  return (
    <li className={`rbac-review-row ${change.direction}`} data-group={AREA_GROUP[change.area]}>
      <Icon name={change.direction === 'down' ? 'rbac-down' : change.direction === 'up' ? 'rbac-up' : 'sys-transfer'} size={14} />
      <span className="rbac-review-area">{area.label}</span>
      <span className="rbac-review-change">
        {levelChanged && (
          <span className="rbac-review-level">
            <s>{levelText(area, change.before)}</s>
            <Icon name="next" size={14} />
            <strong>{levelText(area, change.after)}</strong>
          </span>
        )}
        {change.added.length > 0 && <span className="rbac-review-keys add">+ {change.added.map(rbacLabel).join(', ')}</span>}
        {change.removed.length > 0 && <span className="rbac-review-keys del">− {change.removed.map(rbacLabel).join(', ')}</span>}
      </span>
    </li>
  );
}
