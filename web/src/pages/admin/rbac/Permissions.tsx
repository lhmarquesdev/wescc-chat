// Aba Permissões do editor de papel: chips dos grupos com quantas áreas têm acesso, uma busca em todas as permissões,
// filtros (com acesso, sem acesso, alteradas, sensíveis) e, por grupo, as áreas com o nível e as capacidades avulsas.
// Cada permissão mostra o que libera; a trava por chave fica só para "você não tem" e para a gestão do Administrador.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { areaLevel, isRoomChecked, isSensitive, KEY_AREA, keyMatches, RBAC_GROUPS, RBAC_KEYS, rbacLabel, ROOT_KEEP, withAreaLevel, type RbacArea, type RbacGroup } from '@shared/rbac';
import { foldMatches } from '@shared/search';
import { Icon } from '../../../components/Icon';
import { Menu, Tooltip } from '../../../components/ui';
import { groupIcon } from './groupIcons';
import { groupReach } from './reach';
import type { Draft } from './Review';
import { SensitiveTag } from './SensitiveTag';
import { Chips, Notice, Section } from './shell';
import type { Grant, RbacRole } from './data';

type Filter = 'all' | 'on' | 'off' | 'changed' | 'sensitive';

export const areaKeys = (a: RbacArea) => [...a.levels.flatMap((l) => l.keys), ...a.extras];

const ROOM_NOTE = 'Esta permissão é checada fora das salas: num papel de sala ela não muda nada.';

interface Ctx {
  draft: Draft;
  initial: Draft;
  roomRole: boolean;
  readOnly: boolean;
  keyLock: (k: string) => string | null;
  levelBlocked: (a: RbacArea, i: number) => string | null;
  onLevel: (a: RbacArea, i: number) => void;
  onKey: (k: string, on: boolean) => void;
}

export function PermissionsTab({
  role,
  draft,
  initial,
  grant,
  editable,
  lockNotice,
  group,
  onGroup,
  onChange,
}: {
  role: RbacRole;
  draft: Draft;
  initial: Draft;
  grant: Grant;
  // Pode alterar as permissões deste papel (tem a permissão e o papel não está travado).
  editable: boolean;
  // Por que não pode (quando não pode).
  lockNotice: string;
  group: string;
  onGroup: (g: string) => void;
  onChange: (next: Set<string>) => void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showTechnical, setShowTechnical] = useState(false);
  const held = new Set(grant.held);
  const perms = draft.permissions;
  const roomRole = draft.scope === 'Subscriptions';
  const term = q.trim();

  const keyLock = (k: string): string | null => {
    if (!editable) return null;
    if (role.root && ROOT_KEEP.includes(k)) return 'O Administrador sempre gerencia papéis.';
    if (!grant.root && !held.has(k)) return 'Você não tem esta permissão, então não pode dá-la nem tirá-la.';
    return null;
  };
  const levelBlocked = (area: RbacArea, index: number) => {
    const next = withAreaLevel(area, perms, index);
    const locked = area.levels.flatMap((l) => l.keys).filter((k) => next.has(k) !== perms.has(k) && keyLock(k));
    return locked.length ? keyLock(locked[0]) : null;
  };
  const toggleKey = (k: string, on: boolean) => {
    const next = new Set(perms);
    if (on) next.add(k);
    else next.delete(k);
    onChange(next);
  };
  const setGroup = (g: RbacGroup, mode: 'none' | 'view' | 'max') => {
    let next = new Set(perms);
    for (const a of g.areas) {
      if (mode === 'view') {
        if (a.levels.length && !levelBlocked(a, 0)) next = withAreaLevel(a, next, 0);
        continue;
      }
      for (const k of areaKeys(a).filter((k) => !keyLock(k))) {
        if (mode === 'max') next.add(k);
        else next.delete(k);
      }
    }
    onChange(next);
  };

  const techVisible = showTechnical || [...perms].some((k) => KEY_AREA[k] === 'bots');
  let groups = RBAC_GROUPS.filter((g) => g.id !== 'technical' || techVisible);
  // Papel de sala: a moderação de salas vem primeiro.
  if (roomRole) groups = [...groups.filter((g) => g.id === 'room'), ...groups.filter((g) => g.id !== 'room')];
  const chosen = group !== 'all' && groups.some((g) => g.id === group) ? group : 'all';

  // Quais chaves de cada área passam pela busca e pelo filtro (null = a área some).
  const visibleKeys = (a: RbacArea): string[] | null => {
    let keys = areaKeys(a);
    if (term && !foldMatches(`${a.label} ${a.description}`, term)) keys = keys.filter((k) => keyMatches(k, term));
    if (filter === 'sensitive') keys = keys.filter(isSensitive);
    if (!keys.length) return null;
    const all = areaKeys(a);
    if (filter === 'on' && !all.some((k) => perms.has(k))) return null;
    if (filter === 'off' && all.some((k) => perms.has(k))) return null;
    if (filter === 'changed' && !all.some((k) => perms.has(k) !== initial.permissions.has(k))) return null;
    return keys;
  };
  const panels = groups
    .filter((g) => chosen === 'all' || g.id === chosen)
    .map((g) => ({ g, areas: g.areas.map((a) => ({ a, keys: visibleKeys(a) })).filter((x): x is { a: RbacArea; keys: string[] } => !!x.keys) }))
    .filter((p) => p.areas.length);

  const ctx: Ctx = {
    draft,
    initial,
    roomRole,
    readOnly: !editable,
    keyLock,
    levelBlocked,
    onLevel: (a, i) => onChange(withAreaLevel(a, perms, i)),
    onKey: toggleKey,
  };
  const reach = (g: RbacGroup) => {
    const r = groupReach(g, [...perms]);
    return `${r.any}/${r.total}`;
  };
  const filtered = !!term || filter !== 'all';

  return (
    <div className="rbac-stack">
      {!editable && <Notice kind="lock">{lockNotice}</Notice>}
      {editable && !grant.root && <Notice>Você só dá ou tira permissões que você mesmo tem. As outras aparecem com cadeado.</Notice>}
      <div className="rbac-perm-tools">
        <Chips<string>
          label="Grupo"
          value={chosen}
          onChange={onGroup}
          items={[{ id: 'all', label: 'Todas' }, ...groups.map((g) => ({ id: g.id, label: g.label, count: reach(g) }))]}
        />
        <div className="rbac-perm-filters">
          <label className="rbac-search small">
            <Icon name="search" />
            <input
              type="search"
              value={q}
              placeholder="Buscar permissões"
              aria-label="Buscar permissões"
              onChange={(e) => {
                setQ(e.target.value);
                if (e.target.value.trim()) onGroup('all');
              }}
            />
            {q && (
              <button type="button" aria-label="Limpar busca" onClick={() => setQ('')}>
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
          <Chips<Filter>
            label="Mostrar"
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'all', label: 'Todas' },
              { id: 'on', label: 'Com acesso' },
              { id: 'off', label: 'Sem acesso' },
              { id: 'changed', label: 'Alteradas' },
              { id: 'sensitive', label: 'Sensíveis' },
            ]}
          />
        </div>
      </div>
      {panels.map(({ g, areas }) => (
        <GroupPanel key={g.id} group={g} count={reach(g)} areas={areas} filtered={filtered} onGroup={(m) => setGroup(g, m)} ctx={ctx} />
      ))}
      {!panels.length && (
        <div className="rbac-section rbac-perm-empty">
          <p className="muted">Nenhuma permissão com esses filtros.</p>
          <button type="button" className="btn small" onClick={() => (setQ(''), setFilter('all'), onGroup('all'))}>
            Limpar filtros
          </button>
        </div>
      )}
      <label className="rbac-tech-toggle">
        <input type="checkbox" checked={showTechnical} onChange={(e) => setShowTechnical(e.target.checked)} />
        Mostrar as permissões técnicas (bots e integrações)
      </label>
    </div>
  );
}

function GroupPanel({ group, count, areas, filtered, onGroup, ctx }: { group: RbacGroup; count: string; areas: { a: RbacArea; keys: string[] }[]; filtered: boolean; onGroup: (m: 'none' | 'view' | 'max') => void; ctx: Ctx }) {
  const hasView = group.areas.some((a) => a.levels.length);
  return (
    <Section
      icon={groupIcon(group.id)}
      title={group.label}
      hint={group.description}
      count={count}
      id={`rbac-group-${group.id}`}
      flush
      action={
        !ctx.readOnly && (
          <Menu
            label={`Todas as áreas de ${group.label}`}
            trigger={
              <button type="button" className="btn small ghost">
                Todas as áreas
                <Icon name="chevron-down" />
              </button>
            }
          >
            {(close) => (
              <>
                {hasView && (
                  <button onClick={() => (close(), onGroup('view'))}>
                    <Icon name="show" />
                    Primeiro nível em todas
                  </button>
                )}
                <button onClick={() => (close(), onGroup('max'))}>
                  <Icon name="rbac-up" />
                  Liberar tudo o que posso
                </button>
                <button onClick={() => (close(), onGroup('none'))}>
                  <Icon name="rbac-down" />
                  Sem acesso em todas
                </button>
              </>
            )}
          </Menu>
        )
      }
    >
      <div className="rbac-areas">
        {areas.map(({ a, keys }) => (
          <AreaRow key={a.id} area={a} only={filtered && keys.length < areaKeys(a).length ? new Set(keys) : null} ctx={ctx} />
        ))}
      </div>
    </Section>
  );
}

function AreaRow({ area, only, ctx }: { area: RbacArea; only: Set<string> | null; ctx: Ctx }) {
  const { draft, initial } = ctx;
  const level = areaLevel(area, draft.permissions);
  const levelKeys = area.levels.flatMap((l) => l.keys);
  const forced = !!only && levelKeys.some((k) => only.has(k));
  const [open, setOpen] = useState(level.kind === 'custom');
  useEffect(() => {
    if (level.kind === 'custom' || forced) setOpen(true);
  }, [level.kind, forced]);
  const changed = areaKeys(area).some((k) => draft.permissions.has(k) !== initial.permissions.has(k));
  const extras = only ? area.extras.filter((k) => only.has(k)) : area.extras;
  const includes = level.kind === 'level' ? area.levels[level.index].keys.map(rbacLabel) : [];
  return (
    <div className={`rbac-area${changed ? ' changed' : ''}`}>
      <div className="rbac-area-main">
        <div className="rbac-area-text">
          <span className="rbac-area-name">
            {area.label}
            {changed && <span className="rbac-changed-dot" title="Alterado" />}
            {level.kind === 'custom' && <span className="pill warn tag">Personalizado</span>}
          </span>
          <span className="rbac-area-desc">{area.description}</span>
        </div>
        {area.levels.length > 0 && (
          <div className="rbac-level-wrap">
            <LevelPicker
              area={area}
              current={level.kind === 'none' ? -1 : level.kind === 'level' ? level.index : null}
              readOnly={ctx.readOnly}
              blocked={(i) => ctx.levelBlocked(area, i)}
              onPick={(i) => ctx.onLevel(area, i)}
            />
            {includes.length > 0 && <p className="muted small rbac-level-includes">Inclui: {includes.join(', ')}</p>}
          </div>
        )}
      </div>
      {extras.length > 0 && (
        <div className="rbac-keys">
          {extras.map((k) => (
            <KeyCheck key={k} k={k} ctx={ctx} />
          ))}
        </div>
      )}
      {levelKeys.length > 0 && (!only || forced) && (
        <div className="rbac-detail">
          <button type="button" className="rbac-detail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevron-down" size={14} />
            {levelKeys.length === 1 ? `${open ? 'Esconder' : 'Ver'} a permissão do nível` : `${open ? 'Esconder' : 'Ver'} as ${levelKeys.length} permissões dos níveis`}
          </button>
          {open && (
            <div className="rbac-keys levels">
              {area.levels.map((l) => (
                <div key={l.label} className="rbac-level-keys">
                  <span className="rbac-level-name">{l.label}</span>
                  {l.keys.map((k) => (
                    <KeyCheck key={k} k={k} ctx={ctx} match={!!only?.has(k)} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Seletor de nível: um radiogroup com uma parada de Tab; setas, Home e End mudam o nível pulando os travados. O travado
// continua focável (aria-disabled), com cadeado e o motivo na dica. Sempre três colunas para as linhas alinharem.
function LevelPicker({ area, current, readOnly, blocked, onPick }: { area: RbacArea; current: number | null; readOnly: boolean; blocked: (i: number) => string | null; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const options = [{ label: 'Sem acesso', index: -1 }, ...area.levels.map((l, i) => ({ label: l.label, index: i }))];
  const focusIndex = current ?? -1;
  const lockOf = (i: number) => (readOnly ? null : blocked(i));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const pos = options.findIndex((o) => o.index === focusIndex);
    const order =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? options.slice(pos + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? options.slice(0, Math.max(pos, 0)).reverse()
          : e.key === 'Home'
            ? options
            : e.key === 'End'
              ? [...options].reverse()
              : null;
    if (!order) return;
    e.preventDefault();
    const next = order.find((o) => !lockOf(o.index));
    if (!next) return;
    onPick(next.index);
    requestAnimationFrame(() => (ref.current?.querySelector(`[data-index="${next.index}"]`) as HTMLElement | null)?.focus());
  };
  return (
    <div ref={ref} className={`rbac-level${readOnly ? ' readonly' : ''}`} role="radiogroup" aria-label={`Nível em ${area.label}`} aria-readonly={readOnly || undefined} onKeyDown={onKey}>
      {options.map((o) => {
        const lock = lockOf(o.index);
        const on = current === o.index;
        const btn = (
          <button
            type="button"
            role="radio"
            data-index={o.index}
            aria-checked={on}
            aria-disabled={readOnly || (!!lock && !on)}
            tabIndex={o.index === focusIndex ? 0 : -1}
            className={on ? 'on' : ''}
            data-level={o.index < 0 ? 'none' : o.index === area.levels.length - 1 ? 'top' : 'mid'}
            onClick={() => !on && !lock && !readOnly && onPick(o.index)}
          >
            {lock && !on && <Icon name="rbac-lock" size={12} />}
            {o.label}
          </button>
        );
        return lock && !on ? (
          <Tooltip key={o.index} label={lock}>
            {btn}
          </Tooltip>
        ) : (
          <span key={o.index} className="rbac-level-slot">
            {btn}
          </span>
        );
      })}
      {options.length < 3 && <span className="rbac-level-slot rbac-level-gap" aria-hidden="true" />}
    </div>
  );
}

function KeyCheck({ k, ctx, match }: { k: string; ctx: Ctx; match?: boolean }) {
  const on = ctx.draft.permissions.has(k);
  const lock = ctx.keyLock(k);
  const changed = on !== ctx.initial.permissions.has(k);
  const def = RBAC_KEYS[k];
  const inert = ctx.roomRole && !isRoomChecked(k);
  return (
    <label className={`rbac-key${lock ? ' locked' : ''}${ctx.readOnly ? ' readonly' : ''}${changed ? ' changed' : ''}${match ? ' match' : ''}`} title={lock ?? undefined} data-key={k}>
      <input type="checkbox" checked={on} disabled={ctx.readOnly || !!lock} onChange={(e) => ctx.onKey(k, e.target.checked)} />
      <span className="rbac-key-text">
        <span className="rbac-key-label">
          {def?.label ?? k}
          {lock && <Icon name="rbac-lock" size={12} />}
          <SensitiveTag k={k} />
          {inert && (
            <Tooltip label={ROOM_NOTE}>
              <span className="pill tag rbac-tag-inert" aria-label={ROOM_NOTE}>
                Sem efeito em papel de sala
              </span>
            </Tooltip>
          )}
        </span>
        {def?.description && <span className="rbac-key-desc">{def.description}</span>}
      </span>
    </label>
  );
}
