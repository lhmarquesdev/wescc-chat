// "Revisar alterações": antes de gravar, o que muda no papel em linguagem de gestor, agrupado por área, com setas de
// amplia/reduz, avisos (perder o próprio acesso, brecha de papel restrito) e quantas pessoas ativas são afetadas.
import { AREA_GROUP, diffPermissions, levelText, RBAC_AREAS, RBAC_GROUPS, rbacLabel, type AreaChange } from '@shared/rbac';
import { nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/ui';
import { GROUP_ICON } from './reach';
import { people, type Grant, type RbacRole } from './data';

export interface Draft {
  name: string;
  description: string;
  scope: 'Users' | 'Subscriptions';
  mandatory2fa: boolean;
  restrictDirect: boolean;
  permissions: Set<string>;
  delegable: string[];
}

// Com estas, uma pessoa restrita abre conversas particulares fora das mensagens diretas.
const LOOPHOLES = ['create-p', 'create-team', 'start-discussion', 'start-discussion-other-user'];

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
  const diff = diffPermissions(initial.permissions, draft.permissions);
  const meta: { label: string; before: string; after: string }[] = [];
  const yesNo = (v: boolean) => (v ? 'Sim' : 'Não');
  if (!isNew && initial.description !== draft.description) meta.push({ label: 'Descrição', before: initial.description || '—', after: draft.description || '—' });
  if (initial.scope !== draft.scope) meta.push({ label: 'Escopo', before: initial.scope === 'Users' ? 'Global' : 'De sala', after: draft.scope === 'Users' ? 'Global' : 'De sala' });
  if (initial.mandatory2fa !== draft.mandatory2fa) meta.push({ label: 'Exigir 2FA', before: yesNo(initial.mandatory2fa), after: yesNo(draft.mandatory2fa) });
  if (initial.restrictDirect !== draft.restrictDirect) meta.push({ label: 'Restrito em conversas diretas', before: yesNo(initial.restrictDirect), after: yesNo(draft.restrictDirect) });
  const delegAdded = draft.delegable.filter((x) => !initial.delegable.includes(x));
  const delegRemoved = initial.delegable.filter((x) => !draft.delegable.includes(x));

  const warnings: string[] = [];
  const lost = [...initial.permissions].filter((k) => !draft.permissions.has(k));
  if (role && grant.ownRoles.includes(role._id) && lost.length)
    warnings.push(`Você tem este papel: também perde ${nameList(lost.slice(0, 3).map(rbacLabel), 3)}${lost.length > 3 ? ' e outras' : ''} (a não ser que outro papel seu dê o mesmo).`);
  const restricted = draft.scope === 'Users' && draft.restrictDirect;
  const holes = LOOPHOLES.filter((k) => draft.permissions.has(k));
  if (restricted && holes.length) warnings.push(`O papel é restrito em conversas diretas, mas deixa ${nameList(holes.map((k) => rbacLabel(k).toLowerCase()), 3)}: isso abre conversas particulares.`);
  const roleAdminGained = diff.areas.find((a) => a.area === 'admin-permissions' && a.direction !== 'down');
  if (roleAdminGained) warnings.push('Quem tem este papel passa a mexer em papéis e permissões (só no que ele mesmo tiver).');

  const nothing = !diff.areas.length && !meta.length && !delegAdded.length && !delegRemoved.length && !diff.other.added.length && !diff.other.removed.length;
  const affected = role?.activeUsers ?? 0;

  return (
    <Modal
      wide
      title={isNew ? `Criar o papel ${draft.name.trim()}` : `Revisar alterações em ${roleLabel(role!._id)}`}
      description={isNew ? 'Confira o que o papel novo libera.' : affected ? `${people(affected)} ${affected === 1 ? 'ativa tem' : 'ativas têm'} este papel e ${affected === 1 ? 'sente' : 'sentem'} a mudança na hora.` : 'Ninguém ativo tem este papel agora.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            Voltar ao editor
          </button>
          <button className="btn primary" onClick={onConfirm} disabled={saving || nothing} aria-busy={saving || undefined}>
            {isNew ? 'Criar papel' : 'Salvar alterações'}
          </button>
        </>
      }
    >
      <div className="rbac-review">
        {warnings.map((w) => (
          <div key={w} className="callout warn">
            <Icon name="warning" />
            <span>{w}</span>
          </div>
        ))}
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
        {RBAC_GROUPS.map((g) => {
          const list = diff.areas.filter((a) => a.group === g.id);
          if (!list.length) return null;
          return (
            <section key={g.id} className="rbac-review-group">
              <h3>
                <Icon name={GROUP_ICON[g.id]} size={14} />
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
            <p className="muted small">
              {[...diff.other.added.map((k) => `+ ${rbacLabel(k)}`), ...diff.other.removed.map((k) => `− ${rbacLabel(k)}`)].join(' · ')}
            </p>
          </section>
        )}
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

function AreaDiff({ change }: { change: AreaChange }) {
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
