// Acesso efetivo de uma pessoa (no editor de usuário): o que ela pode em cada área, somando os papéis globais, e de
// qual papel vem cada acesso; as restrições que os papéis trazem; os papéis de sala. Com papéis mudados e não salvos,
// "Depois de salvar" simula no servidor (as mesmas regras das checagens) e mostra o que muda.
import { useState } from 'react';
import { isSensitive, keyMatches, levelText, RBAC_AREAS, RBAC_GROUPS, RBAC_KEYS, rbacLabel, sensitiveAdded, type AreaChange, type EffectiveArea } from '@shared/rbac';
import { api } from '../../../lib/api';
import { nameList, roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Segmented, SkeletonTable, useAsync } from '../../../components/ui';
import { groupIcon } from './groupIcons';
import { AreaDiff } from './Review';
import { RoomRoles } from './RoomRoles';
import { SensitiveTag } from './SensitiveTag';
import { Chips, Section } from './shell';

type Mode = 'now' | 'after';
type Filter = 'all' | 'sensitive';

interface Restrictions {
  restrictDirect: string[];
  mandatory2fa: string[];
}
interface Effective {
  roles: string[];
  areas: EffectiveArea[];
  restrictions: Restrictions;
  simulated?: { roles: string[]; areas: EffectiveArea[]; restrictions: Restrictions; diff: { areas: AreaChange[] } };
}

const keysOf = (areas: EffectiveArea[]) => areas.flatMap((a) => a.keys.map((k) => k.key));

// Restrições que entram ou saem ao salvar (Restrita em conversas diretas, 2FA obrigatório), com o papel que as traz.
function restrictionChanges(now: Restrictions, after: Restrictions) {
  const out: { key: string; icon: 'direct-blocked' | 'security'; text: string }[] = [];
  const via = (ids: string[]) => ` (via ${nameList(ids.map(roleLabel), 2)})`;
  if (!now.restrictDirect.length && after.restrictDirect.length)
    out.push({ key: 'rd', icon: 'direct-blocked', text: `Passa a ser restrita em conversas diretas${via(after.restrictDirect)}: só conversa e liga para quem não é restrito.` });
  if (now.restrictDirect.length && !after.restrictDirect.length) out.push({ key: 'rd', icon: 'direct-blocked', text: 'Deixa de ser restrita em conversas diretas.' });
  if (!now.mandatory2fa.length && after.mandatory2fa.length)
    out.push({ key: '2fa', icon: 'security', text: `Passa a exigir 2FA${via(after.mandatory2fa)}: configura antes de voltar a usar o chat.` });
  if (now.mandatory2fa.length && !after.mandatory2fa.length) out.push({ key: '2fa', icon: 'security', text: 'Deixa de exigir 2FA.' });
  return out;
}

export function EffectiveAccess({ userId, draftRoles }: { userId: string; draftRoles?: string[] }) {
  const can = usePermission(['view-user-administration', 'view-permissions', 'access-permissions', 'manage-roles']);
  const [mode, setMode] = useState<Mode>('after');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const simulate = !!draftRoles && mode === 'after';
  const rolesParam = draftRoles?.join(',') ?? '';
  const { data, loading, error } = useAsync(
    () => (can ? (api.get('rbac.users.effective', simulate ? { userId, roles: rolesParam } : { userId }) as Promise<Effective>) : Promise.resolve(null)),
    [userId, can, simulate, rolesParam],
  );
  if (!can) return null;
  const sim = simulate ? data?.simulated : undefined;
  const areas: EffectiveArea[] = (sim ?? data)?.areas ?? [];
  const restrictions = (sim ?? data)?.restrictions;
  const term = q.trim();
  const keyShown = (k: string) => keyMatches(k, term) && (filter === 'all' || isSensitive(k));
  const sensitiveNew = sim && data ? sensitiveAdded(keysOf(data.areas), keysOf(sim.areas)) : [];
  const restrictionDiff = sim && data ? restrictionChanges(data.restrictions, sim.restrictions) : [];

  return (
    <>
      <Section
        icon="rbac-effective"
        title="Acesso efetivo"
        hint="O que a pessoa pode, somando os papéis globais. Os papéis de sala (Dono, Moderador) valem só nas salas deles. Toque numa área para ver de qual papel vem."
        action={
          draftRoles && (
            <Segmented<Mode>
              label="Acesso"
              value={mode}
              onChange={setMode}
              items={[
                { id: 'now', label: 'Agora' },
                { id: 'after', label: 'Depois de salvar' },
              ]}
            />
          )
        }
      >
        <div className="rbac-effective">
          {loading && !data ? (
            <SkeletonTable rows={4} cols={2} />
          ) : error ? (
            <p className="muted small">Não foi possível carregar: {error}</p>
          ) : (
            <>
              {sim && (
                <div className="rbac-eff-change">
                  <h3>
                    <Icon name="sys-transfer" size={14} />
                    Muda ao salvar
                  </h3>
                  {sensitiveNew.map((k) => (
                    <div key={k} className="callout warn rbac-review-sensitive">
                      <Icon name="rbac-sensitive" />
                      <span>
                        Sensível: {rbacLabel(k)}. {RBAC_KEYS[k].sensitive}
                      </span>
                    </div>
                  ))}
                  {sim.diff.areas.length || restrictionDiff.length ? (
                    <ul className="rbac-eff-diff">
                      {restrictionDiff.map((r) => (
                        <li key={r.key} className="rbac-review-row rbac-eff-restriction mixed">
                          <Icon name={r.icon} size={14} />
                          <span className="rbac-review-change">
                            <span>{r.text}</span>
                          </span>
                        </li>
                      ))}
                      {sim.diff.areas.map((a) => (
                        <AreaDiff key={a.area} change={a} />
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">Nada muda no acesso.</p>
                  )}
                </div>
              )}
              {restrictions && (restrictions.restrictDirect.length > 0 || restrictions.mandatory2fa.length > 0) && (
                <div className="rbac-eff-restrictions">
                  {restrictions.restrictDirect.length > 0 && (
                    <span className="pill warn tag">
                      <Icon name="direct-blocked" size={12} />
                      Restrita em conversas diretas (via {nameList(restrictions.restrictDirect.map(roleLabel), 2)})
                    </span>
                  )}
                  {restrictions.mandatory2fa.length > 0 && (
                    <span className="pill tag">
                      <Icon name="security" size={12} />
                      2FA obrigatório (via {nameList(restrictions.mandatory2fa.map(roleLabel), 2)})
                    </span>
                  )}
                </div>
              )}
              <div className="rbac-area-tools rbac-eff-tools">
                <label className="rbac-search small">
                  <Icon name="search" />
                  <input type="search" value={q} placeholder="Buscar uma permissão" aria-label="Buscar uma permissão" onChange={(e) => setQ(e.target.value)} />
                </label>
                <Chips<Filter>
                  label="Mostrar"
                  value={filter}
                  onChange={setFilter}
                  items={[
                    { id: 'all', label: 'Todas' },
                    { id: 'sensitive', label: 'Sensíveis' },
                  ]}
                />
              </div>
              {RBAC_GROUPS.map((g) => {
                const list = areas.filter((a) => g.areas.some((x) => x.id === a.area) && a.keys.some((k) => keyShown(k.key)));
                if (!list.length) return null;
                return (
                  <div key={g.id} className="rbac-eff-group">
                    <span className="rbac-eff-group-name">
                      <Icon name={groupIcon(g.id)} size={14} />
                      {g.label}
                    </span>
                    <ul>
                      {list.map((e) => {
                        const area = RBAC_AREAS.find((a) => a.id === e.area)!;
                        const via = [...new Set(e.keys.flatMap((k) => k.via))];
                        const expanded = open === e.area || !!term || filter === 'sensitive';
                        const sens = e.keys.filter((k) => isSensitive(k.key)).length;
                        return (
                          <li key={e.area}>
                            <button type="button" className="rbac-eff-row" aria-expanded={expanded} onClick={() => setOpen(open === e.area ? null : e.area)}>
                              <span className="rbac-eff-area">{area.label}</span>
                              <span className={`pill tag${e.level.kind === 'custom' ? ' warn' : ''}`}>{area.levels.length ? levelText(area, e.level) : `${e.keys.length} de ${area.extras.length}`}</span>
                              {sens > 0 && (
                                <span className="rbac-tag-sensitive compact" aria-label={`${sens} sensíveis`}>
                                  <Icon name="rbac-sensitive" size={12} />
                                  {sens}
                                </span>
                              )}
                              <span className="rbac-eff-via muted small">via {nameList(via.map(roleLabel), 2)}</span>
                              <Icon name="chevron-down" size={14} />
                            </button>
                            {expanded && (
                              <ul className="rbac-eff-keys">
                                {e.keys
                                  .filter((k) => keyShown(k.key))
                                  .map((k) => (
                                    <li key={k.key}>
                                      <Icon name="check" size={12} />
                                      {rbacLabel(k.key)}
                                      <SensitiveTag k={k.key} />
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
              })}
              {!areas.length && <p className="muted small">Nenhum acesso.</p>}
            </>
          )}
        </div>
      </Section>
      <Section icon="rbac-room" title="Papéis em salas" hint="Valem só na sala. Para mudar, use o menu de membros da sala.">
        <RoomRoles userId={userId} />
      </Section>
    </>
  );
}
