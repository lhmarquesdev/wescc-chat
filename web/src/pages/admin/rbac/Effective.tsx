// Acesso efetivo de uma pessoa (no editor de usuário): o que ela pode em cada área, somando os papéis globais, e de
// qual papel vem cada acesso. Calculado no servidor com as mesmas regras das checagens.
import { useState } from 'react';
import { levelText, RBAC_AREAS, RBAC_GROUPS, rbacLabel, type EffectiveArea } from '@shared/rbac';
import { api } from '../../../lib/api';
import { nameList, roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { SkeletonTable, useAsync } from '../../../components/ui';
import { GROUP_ICON } from './reach';

export function EffectiveAccess({ userId }: { userId: string }) {
  const can = usePermission(['view-user-administration', 'view-permissions', 'access-permissions', 'manage-roles']);
  const { data, loading, error } = useAsync(() => (can ? api.get('rbac.users.effective', { userId }) : Promise.resolve(null)), [userId, can]);
  const [open, setOpen] = useState<string | null>(null);
  if (!can) return null;
  const areas: EffectiveArea[] = data?.areas ?? [];
  return (
    <section className="form-section rbac-effective">
      <h3 className="form-section-title">
        <Icon name="rbac-effective" size={16} />
        Acesso efetivo
      </h3>
      <p className="field-hint">O que a pessoa pode hoje, somando os papéis globais salvos. Os papéis de sala (Dono, Moderador) valem só nas salas deles.</p>
      {loading && !data ? (
        <SkeletonTable rows={4} cols={2} />
      ) : error ? (
        <p className="muted small">Não foi possível carregar: {error}</p>
      ) : (
        RBAC_GROUPS.map((g) => {
          const list = areas.filter((a) => g.areas.some((x) => x.id === a.area));
          if (!list.length) return null;
          return (
            <div key={g.id} className="rbac-eff-group">
              <span className="rbac-eff-group-name">
                <Icon name={GROUP_ICON[g.id]} size={14} />
                {g.label}
              </span>
              <ul>
                {list.map((e) => {
                  const area = RBAC_AREAS.find((a) => a.id === e.area)!;
                  const via = [...new Set(e.keys.flatMap((k) => k.via))];
                  const expanded = open === e.area;
                  return (
                    <li key={e.area}>
                      <button type="button" className="rbac-eff-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : e.area)}>
                        <span className="rbac-eff-area">{area.label}</span>
                        <span className={`pill tag${e.level.kind === 'custom' ? ' warn' : ''}`}>{area.levels.length ? levelText(area, e.level) : `${e.keys.length} de ${area.extras.length}`}</span>
                        <span className="rbac-eff-via muted small">via {nameList(via.map(roleLabel), 2)}</span>
                        <Icon name="chevron-down" size={14} />
                      </button>
                      {expanded && (
                        <ul className="rbac-eff-keys">
                          {e.keys.map((k) => (
                            <li key={k.key}>
                              <Icon name="check" size={12} />
                              {rbacLabel(k.key)}
                              <span className="muted small">via {nameList(k.via.map(roleLabel), 3)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
