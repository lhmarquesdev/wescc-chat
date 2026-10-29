// Alcance de um papel: por grupo (Conversas, Moderação, Administração, Atendimento), quantas áreas têm algum acesso.
import { areaLevel, RBAC_GROUPS, type RbacGroup } from '@shared/rbac';
import { Icon, type IconName } from '../../../components/Icon';
import { Tooltip } from '../../../components/ui';

export const GROUP_ICON: Record<string, IconName> = { chat: 'rbac-chat', room: 'rbac-room', admin: 'rbac-admin', omnichannel: 'rbac-omni', technical: 'rbac-technical' };

// Alcance de um papel por grupo: quantas áreas têm algum acesso e quantas estão completas (último nível).
export function groupReach(g: RbacGroup, perms: string[]) {
  const held = new Set(perms);
  let any = 0;
  let full = 0;
  for (const a of g.areas) {
    const keys = [...a.levels.flatMap((l) => l.keys), ...a.extras];
    if (!keys.some((k) => held.has(k))) continue;
    any++;
    const lv = areaLevel(a, held);
    if ((lv.kind === 'level' && lv.index === a.levels.length - 1 && a.extras.every((k) => held.has(k))) || (!a.levels.length && a.extras.every((k) => held.has(k)))) full++;
  }
  return { any, full, total: g.areas.length };
}

export function ReachBar({ perms, compact }: { perms: string[]; compact?: boolean }) {
  return (
    <div className={compact ? 'rbac-reach compact' : 'rbac-reach'}>
      {RBAC_GROUPS.filter((g) => g.id !== 'technical').map((g) => {
        const r = groupReach(g, perms);
        return (
          <Tooltip key={g.id} label={`${g.label}: ${r.any} de ${r.total} áreas${r.full ? `, ${r.full} completas` : ''}`}>
            <span className="rbac-reach-group" data-empty={r.any === 0 || undefined} aria-label={`${g.label}: ${r.any} de ${r.total} áreas`}>
              <Icon name={GROUP_ICON[g.id]} size={14} />
              <span className="rbac-reach-cells" aria-hidden="true">
                {g.areas.map((a, i) => (
                  <i key={a.id} data-state={i < r.full ? 'full' : i < r.any ? 'some' : 'none'} />
                ))}
              </span>
              {!compact && (
                <span className="rbac-reach-num">
                  {r.any}/{r.total}
                </span>
              )}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}


// Legenda do alcance: um ícone por grupo, a mesma ordem das barras.
export function ReachLegend() {
  return (
    <span className="rbac-legend" aria-hidden="true">
      {RBAC_GROUPS.filter((g) => g.id !== 'technical').map((g) => (
        <span key={g.id}>
          <Icon name={GROUP_ICON[g.id]} size={12} />
          {g.label}
        </span>
      ))}
    </span>
  );
}
