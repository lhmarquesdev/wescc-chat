// Matriz de permissões: uma coluna por papel, uma linha por permissão (agrupadas por área). Marca e desmarca várias
// de uma vez e grava só o que entrou e saiu de cada papel (rbac.matrix.update). Comparar é a matriz com dois papéis e
// "Só diferenças"; no celular ela vira Comparar com dois seletores e cartões. Estado na URL (?roles=&group=&q=&diff=&sens=).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { areaLevel, isSensitive, keyMatches, levelText, RBAC_GROUPS, RBAC_KEYS, rbacLabel, type RbacArea } from '@shared/rbac';
import { api } from '../../../lib/api';
import { plural, roleLabel } from '../../../lib/format';
import { realtime } from '../../../lib/realtime';
import { Icon, type IconName } from '../../../components/Icon';
import { useIsPhone } from '../../../components/overlay';
import { Empty, Menu, SkeletonTable, Toggle, Tooltip, confirmDialog, useEdgeFade } from '../../../components/ui';
import { areaKeys } from './Permissions';
import { cellLock, cellState, defaultColumns, differs, MATRIX_MAX, matrixChanges, matrixQuery, parseMatrixQuery, type CellState, type MatrixQuery } from './matrix';
import { MatrixReviewDialog } from './Review';
import { Chips, ListStrip, Notice, RbacViews } from './shell';
import { people, rbacFail, rbacOk, type Grant, type RbacRole } from './data';

const INERT = 'Papel de sala: esta permissão não é checada nas salas, então não tem efeito.';

const roleIcon = (r: RbacRole): IconName => (r.root ? 'rbac-root' : r.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions');

const sortRoles = (roles: RbacRole[]) =>
  [...roles].sort((a, b) => Number(!!b.root) - Number(!!a.root) || Number(b.scope === 'Users') - Number(a.scope === 'Users') || roleLabel(a._id).localeCompare(roleLabel(b._id), 'pt-BR'));

// Nível do papel na área (linha da área): o nome do nível, ou "n de m" nas áreas só de capacidades avulsas.
const areaSummary = (a: RbacArea, perms: Set<string>) => (a.levels.length ? levelText(a, areaLevel(a, perms)) : `${a.extras.filter((k) => perms.has(k)).length} de ${a.extras.length}`);

const snapshot = (roles: RbacRole[]) => ({
  base: Object.fromEntries(roles.map((r) => [r._id, [...r.permissions]])) as Record<string, string[]>,
  draft: Object.fromEntries(roles.map((r) => [r._id, new Set(r.permissions)])) as Record<string, Set<string>>,
});

export function MatrixPage({ roles, grant, error, onSaved }: { roles: RbacRole[] | null; grant: Grant | null; error: string | null; onSaved: () => void }) {
  const phone = useIsPhone();
  const location = useLocation();
  const navigate = useNavigate();
  const query = parseMatrixQuery(location.search);
  const setQuery = (patch: Partial<MatrixQuery>) => navigate({ search: matrixQuery({ ...query, ...patch }) }, { replace: true });

  const [state, setState] = useState<ReturnType<typeof snapshot> | null>(null);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [otherChanged, setOtherChanged] = useState(false);
  const changes = useMemo(() => (state ? matrixChanges(state.base, state.draft) : []), [state]);
  const dirty = changes.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Sem alterações, acompanha o servidor; com alterações, só acrescenta papéis novos (as deltas cuidam do resto).
  useEffect(() => {
    if (!roles) return;
    setState((s) => {
      if (!s || !dirtyRef.current) return snapshot(roles);
      const fresh = snapshot(roles.filter((r) => !(r._id in s.base)));
      return { base: { ...s.base, ...fresh.base }, draft: { ...s.draft, ...fresh.draft } };
    });
  }, [roles]);

  // Outra pessoa (ou a mesma em outra aba) salvou papéis enquanto esta matriz tem alterações.
  const savingRef = useRef(false);
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'permissions.changed' && !savingRef.current && dirtyRef.current) setOtherChanged(true);
    });
    return () => void off();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const sorted = useMemo(() => sortRoles(roles ?? []), [roles]);
  const byId = useMemo(() => new Map(sorted.map((r) => [r._id, r])), [sorted]);
  const asked = query.roles.filter((id) => byId.has(id));
  const columns = (asked.length ? asked : defaultColumns(sorted)).slice(0, MATRIX_MAX);
  const cols = (phone ? columns.slice(0, 2) : columns).map((id) => byId.get(id)!).filter(Boolean);
  const colIds = cols.map((r) => r._id);

  const guard = async () => !dirtyRef.current || (await confirmDialog({ title: 'Descartar as alterações?', body: 'O que você mudou na matriz ainda não foi salvo.', confirmLabel: 'Descartar', danger: true }));

  if (!roles || !grant || !state)
    return (
      <div className="rbac-shell list">
        <ListStrip eyebrow="Papéis e permissões" title="Matriz de permissões" views={<RbacViews value="matrix" />} />
        <div className="rbac-list-body">{error ? <Empty icon="error" title="Não foi possível carregar os papéis">{error}</Empty> : <SkeletonTable rows={8} cols={5} />}</div>
      </div>
    );

  const canEdit = grant.canEditPermissions;
  const base = state.base;
  const draft = state.draft;
  const lockOf = (k: string, r: RbacRole) => cellLock(k, r, grant, canEdit);
  const toggle = (k: string, r: RbacRole) => {
    if (cellState(k, r, draft[r._id], lockOf(k, r)) === 'inert' || lockOf(k, r)) return;
    setState((s) => {
      if (!s) return s;
      const next = new Set(s.draft[r._id]);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return { ...s, draft: { ...s.draft, [r._id]: next } };
    });
  };
  const discard = () => (setState(snapshot(roles)), setOtherChanged(false));

  // Linhas: grupo → área → permissões que passam nos filtros.
  const baseSets = Object.fromEntries(colIds.map((id) => [id, new Set(base[id] ?? [])]));
  const rowChanged = (k: string) => colIds.some((id) => draft[id].has(k) !== baseSets[id].has(k));
  const groups = RBAC_GROUPS.filter((g) => query.group === 'all' || g.id === query.group)
    .map((g) => ({
      g,
      areas: g.areas
        .map((a) => ({
          a,
          keys: areaKeys(a).filter(
            (k) => keyMatches(k, query.q) && (!query.sens || isSensitive(k)) && (!query.diff || differs(k, colIds, baseSets) || differs(k, colIds, draft) || rowChanged(k)),
          ),
        }))
        .filter((x) => x.keys.length),
    }))
    .filter((x) => x.areas.length);
  const rows = groups.flatMap((x) => x.areas.flatMap((a) => a.keys));
  const nChanges = changes.reduce((s, c) => s + c.add.length + c.remove.length, 0);
  const clear = () => setQuery({ group: 'all', q: '', diff: false, sens: false });

  const save = async () => {
    setSaving(true);
    savingRef.current = true;
    try {
      await api.post('rbac.matrix.update', { changes });
      rbacOk(`Matriz salva: ${plural(changes.length, 'papel', 'papéis')}.`);
      setReview(false);
      setOtherChanged(false);
      // O que foi salvo vira a base; a recarga traz o resto do servidor.
      setState((s) => s && { base: Object.fromEntries(Object.entries(s.draft).map(([id, v]) => [id, [...v]])), draft: s.draft });
      dirtyRef.current = false;
      onSaved();
    } catch (e) {
      rbacFail(e);
    } finally {
      setSaving(false);
      setTimeout(() => (savingRef.current = false), 1500);
    }
  };

  const setColumns = (ids: string[]) => setQuery({ roles: ids });
  const tools = (
    <MatrixTools
      query={query}
      setQuery={setQuery}
      roles={sorted}
      columns={columns}
      onColumns={setColumns}
      phone={phone}
      diffDisabled={colIds.length < 2}
    />
  );

  return (
    <div className={`rbac-shell ${phone ? 'list rbac-compare' : 'matrix'}`}>
      <ListStrip
        eyebrow="Papéis e permissões"
        title={phone ? 'Comparar papéis' : 'Matriz de permissões'}
        views={<RbacViews value="matrix" guard={guard} />}
        search={query.q}
        onSearch={(v) => setQuery({ q: v })}
        placeholder="Buscar permissões..."
        count={rows.length}
        countUnit={['linha', 'linhas']}
      />
      {tools}
      {otherChanged && dirty && <Notice kind="warn">Outra pessoa alterou papéis agora. Ao salvar, só as suas mudanças são aplicadas.</Notice>}
      {!canEdit && <Notice kind="lock">Você pode ver, mas não alterar permissões.</Notice>}
      {phone ? (
        <CompareCards roles={sorted} cols={cols} columns={columns} onColumns={setColumns} groups={groups} draft={draft} baseSets={baseSets} lockOf={lockOf} toggle={toggle} onClear={clear} />
      ) : !rows.length ? (
        <div className="rbac-list-body">
          <Empty icon="search" title="Nenhuma permissão com esses filtros." action={<button className="btn" onClick={clear}>Limpar filtros</button>} />
        </div>
      ) : (
        <MatrixGrid cols={cols} groups={groups} draft={draft} baseSets={baseSets} lockOf={lockOf} toggle={toggle} onOpen={(r) => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}`)} />
      )}
      {dirty && (
        <div className="rbac-savebar" role="region" aria-label="Alterações na matriz">
          <span className="rbac-savebar-count">
            <i aria-hidden="true" />
            {plural(nChanges, 'alteração', 'alterações')} em {plural(changes.length, 'papel', 'papéis')}
          </span>
          <button type="button" className="btn" onClick={discard} disabled={saving}>
            Descartar
          </button>
          <button type="button" className="btn primary" onClick={() => setReview(true)} disabled={saving}>
            Revisar e salvar
          </button>
        </div>
      )}
      {review && (
        <MatrixReviewDialog
          items={changes.map((c) => ({ role: byId.get(c.roleId)!, before: new Set(base[c.roleId]), after: draft[c.roleId] }))}
          grant={grant}
          saving={saving}
          onClose={() => setReview(false)}
          onConfirm={() => void save()}
        />
      )}
    </div>
  );
}

// ---------- Barra de ferramentas ----------

function MatrixTools({
  query,
  setQuery,
  roles,
  columns,
  onColumns,
  phone,
  diffDisabled,
}: {
  query: MatrixQuery;
  setQuery: (p: Partial<MatrixQuery>) => void;
  roles: RbacRole[];
  columns: string[];
  onColumns: (ids: string[]) => void;
  phone: boolean;
  diffDisabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeFade(ref, query.group);
  const full = columns.length >= MATRIX_MAX;
  const toggleCol = (id: string) => onColumns(columns.includes(id) ? columns.filter((x) => x !== id) : [...columns, id]);
  const diff = <Toggle checked={query.diff && !diffDisabled} disabled={diffDisabled} onChange={(v) => setQuery({ diff: v })} label="Só diferenças" />;
  return (
    <div className="rbac-matrix-tools" ref={ref}>
      <Chips<string> label="Grupo" value={query.group} onChange={(g) => setQuery({ group: g })} items={[{ id: 'all', label: 'Todas' }, ...RBAC_GROUPS.map((g) => ({ id: g.id, label: g.label }))]} />
      <div className="rbac-matrix-toggles">
        {!phone && (
          <Menu
            label="Papéis na matriz"
            sheetTitle="Papéis na matriz"
            align="left"
            trigger={
              <button type="button" className="btn small">
                <Icon name="admin-permissions" size={14} />
                Papéis
                <span className="rbac-chip-count">{columns.length}</span>
                <Icon name="chevron-down" size={14} />
              </button>
            }
          >
            {() => (
              <div className="rbac-menu-scroll">
                {roles.map((r) => {
                  const on = columns.includes(r._id);
                  // Sem nenhum papel a matriz voltaria às colunas padrão; o último fica.
                  const last = on && columns.length === 1;
                  const blocked = (!on && full) || last;
                  return (
                    <button
                      key={r._id}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      aria-disabled={blocked || undefined}
                      title={last ? 'Deixe ao menos um papel.' : blocked ? 'Até 12 papéis por vez.' : undefined}
                      onClick={() => !blocked && toggleCol(r._id)}
                    >
                      <Icon name={on ? 'check' : roleIcon(r)} />
                      {roleLabel(r._id)}
                      {r.scope === 'Subscriptions' && <span className="pill tag">De sala</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </Menu>
        )}
        {diffDisabled ? <Tooltip label="Escolha ao menos dois papéis.">{<span>{diff}</span>}</Tooltip> : diff}
        <Toggle checked={query.sens} onChange={(v) => setQuery({ sens: v })} label="Só sensíveis" />
      </div>
    </div>
  );
}

// ---------- Grade (desktop) ----------

interface GridProps {
  cols: RbacRole[];
  groups: { g: (typeof RBAC_GROUPS)[number]; areas: { a: RbacArea; keys: string[] }[] }[];
  draft: Record<string, Set<string>>;
  baseSets: Record<string, Set<string>>;
  lockOf: (k: string, r: RbacRole) => string | null;
  toggle: (k: string, r: RbacRole) => void;
}

function MatrixGrid({ cols, groups, draft, baseSets, lockOf, toggle, onOpen }: GridProps & { onOpen: (r: RbacRole) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState({ r: 0, c: 0 });
  const rowCount = groups.reduce((s, g) => s + g.areas.reduce((t, a) => t + a.keys.length, 0), 0);
  const focusCell = (r: number, c: number) => {
    const rr = Math.max(0, Math.min(rowCount - 1, r));
    const cc = Math.max(0, Math.min(cols.length - 1, c));
    setCur({ r: rr, c: cc });
    (ref.current?.querySelector(`[data-r="${rr}"][data-c="${cc}"]`) as HTMLElement | null)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.dataset.r === undefined) return;
    const r = Number(t.dataset.r);
    const c = Number(t.dataset.c);
    const moves: Record<string, [number, number]> = { ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], Home: [r, 0], End: [r, cols.length - 1] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    focusCell(m[0], m[1]);
  };
  let rowIndex = 0;
  return (
    <div className="rbac-matrix-wrap" ref={ref} onKeyDown={onKey}>
      <table className="rbac-matrix" role="grid" aria-label="Matriz de permissões" aria-rowcount={rowCount} style={{ ['--cols' as string]: cols.length }}>
        <thead>
          <tr>
            <th className="rbac-matrix-key" scope="col">
              Permissão
            </th>
            {cols.map((r) => (
              <th key={r._id} scope="col" className="rbac-matrix-role">
                <button type="button" className="rbac-matrix-role-btn" onClick={() => onOpen(r)} title={`Abrir ${roleLabel(r._id)}`}>
                  <Icon name={roleIcon(r)} size={14} />
                  <span className="rbac-matrix-role-name">{roleLabel(r._id)}</span>
                </button>
                <span className="rbac-matrix-role-sub">
                  {r.scope === 'Subscriptions' && <span className="pill tag">De sala</span>}
                  {people(r.users)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map(({ g, areas }) => (
          <tbody key={g.id} className="rbac-matrix-group">
            <tr className="rbac-matrix-group-row">
              <th scope="rowgroup" colSpan={cols.length + 1}>
                {g.label}
              </th>
            </tr>
            {areas.map(({ a, keys }) => {
              const first = rowIndex;
              rowIndex += keys.length;
              return <AreaRows key={a.id} area={a} keys={keys} first={first} cols={cols} draft={draft} baseSets={baseSets} lockOf={lockOf} toggle={toggle} cur={cur} onFocus={(r, c) => setCur({ r, c })} />;
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function AreaRows({
  area,
  keys,
  first,
  cols,
  draft,
  baseSets,
  lockOf,
  toggle,
  cur,
  onFocus,
}: Omit<GridProps, 'groups'> & { area: RbacArea; keys: string[]; first: number; cur: { r: number; c: number }; onFocus: (r: number, c: number) => void }) {
  return (
    <>
      <tr className="rbac-matrix-area">
        <th scope="row">{area.label}</th>
        {cols.map((r) => (
          <td key={r._id} className="rbac-matrix-level">
            {areaSummary(area, draft[r._id])}
          </td>
        ))}
      </tr>
      {keys.map((k, i) => {
        const def = RBAC_KEYS[k];
        const r0 = first + i;
        return (
          <tr key={k} className="rbac-matrix-row">
            <th scope="row" className="rbac-matrix-key">
              <span className="rbac-matrix-key-label">
                {def?.label ?? k}
                {isSensitive(k) && (
                  <Tooltip label={`Sensível: ${def.sensitive}`}>
                    <span className="rbac-tag-sensitive compact" aria-label={`Sensível: ${def.sensitive}`}>
                      <Icon name="rbac-sensitive" size={12} />
                    </span>
                  </Tooltip>
                )}
                {def?.description && (
                  <Tooltip label={def.description}>
                    <span className="rbac-matrix-info" aria-label={def.description} tabIndex={-1}>
                      <Icon name="info" size={12} />
                    </span>
                  </Tooltip>
                )}
              </span>
            </th>
            {cols.map((r, c) => {
              const lock = lockOf(k, r);
              const st = cellState(k, r, draft[r._id], lock);
              return (
                <td key={r._id} className="rbac-matrix-cell">
                  <Cell
                    k={k}
                    role={r}
                    state={st}
                    on={draft[r._id].has(k)}
                    changed={draft[r._id].has(k) !== baseSets[r._id]?.has(k)}
                    lock={lock}
                    focus={cur.r === r0 && cur.c === c}
                    r={r0}
                    c={c}
                    onToggle={() => toggle(k, r)}
                    onFocus={() => onFocus(r0, c)}
                  />
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

function cellTitle(state: CellState, on: boolean, lock: string | null, role: string, key: string) {
  if (state === 'inert') return INERT;
  const base = `${roleLabel(role)} ${on ? 'tem' : 'não tem'}: ${rbacLabel(key)}`;
  return lock ? `${base}. ${lock}` : base;
}

function Cell({ k, role, state, on, changed, lock, focus, r, c, onToggle, onFocus }: { k: string; role: RbacRole; state: CellState; on: boolean; changed: boolean; lock: string | null; focus?: boolean; r?: number; c?: number; onToggle: () => void; onFocus?: () => void }) {
  const title = cellTitle(state, on, lock, role._id, k);
  const disabled = state === 'inert' || state === 'locked';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      aria-label={title}
      title={title}
      tabIndex={focus === undefined ? 0 : focus ? 0 : -1}
      className={`rbac-cell${changed ? ' changed' : ''}`}
      data-state={state}
      data-on={on || undefined}
      data-r={r}
      data-c={c}
      onFocus={onFocus}
      onClick={() => !disabled && onToggle()}
    >
      {state === 'inert' ? <span className="rbac-cell-dash" aria-hidden="true" /> : on ? <Icon name="check" size={16} /> : null}
      {state === 'locked' && <Icon name="rbac-lock" size={12} className="rbac-cell-lock" />}
    </button>
  );
}

// ---------- Comparar (celular) ----------

function CompareCards({
  roles,
  cols,
  columns,
  onColumns,
  groups,
  draft,
  baseSets,
  lockOf,
  toggle,
  onClear,
}: GridProps & { roles: RbacRole[]; columns: string[]; onColumns: (ids: string[]) => void; onClear: () => void }) {
  const a = cols[0]?._id ?? '';
  const b = cols[1]?._id ?? '';
  const pick = (which: 0 | 1, id: string) => {
    const next = [which === 0 ? id : a, which === 1 ? id : b].filter(Boolean);
    onColumns([...new Set(next)].concat(columns.filter((x) => !next.includes(x))).slice(0, MATRIX_MAX));
  };
  const select = (which: 0 | 1, label: string, value: string) => (
    <label className="field rbac-compare-pick">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => pick(which, e.target.value)}>
        {roles.map((r) => (
          <option key={r._id} value={r._id} disabled={r._id === (which === 0 ? b : a)}>
            {roleLabel(r._id)}
            {r.scope === 'Subscriptions' ? ' (de sala)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  const count = groups.reduce((s, g) => s + g.areas.reduce((t, x) => t + x.keys.length, 0), 0);
  return (
    <div className="rbac-list-body rbac-compare-body">
      <div className="rbac-compare-picks">
        {select(0, 'Papel A', a)}
        {select(1, 'Papel B', b)}
      </div>
      {!count ? (
        <Empty icon="search" title="Nenhuma permissão com esses filtros." action={<button className="btn" onClick={onClear}>Limpar filtros</button>} />
      ) : (
        groups.map(({ g, areas }) => (
          <section key={g.id} className="rbac-compare-group">
            <h2>{g.label}</h2>
            {areas.map(({ a: area, keys }) => (
              <div key={area.id} className="rbac-compare-area">
                <h3>{area.label}</h3>
                {keys.map((k) => (
                  <div key={k} className="rbac-compare-card">
                    <details>
                      <summary>
                        <span className="rbac-matrix-key-label">
                          {rbacLabel(k)}
                          {isSensitive(k) && <Icon name="rbac-sensitive" size={12} className="rbac-tag-sensitive" />}
                        </span>
                      </summary>
                      <p className="muted small">{RBAC_KEYS[k]?.description}</p>
                    </details>
                    <div className="rbac-compare-cells">
                      {cols.map((r) => {
                        const lock = lockOf(k, r);
                        const st = cellState(k, r, draft[r._id], lock);
                        return (
                          <span key={r._id} className="rbac-compare-cell">
                            <span className="rbac-compare-role">{roleLabel(r._id)}</span>
                            <Cell k={k} role={r} state={st} on={draft[r._id].has(k)} changed={draft[r._id].has(k) !== baseSets[r._id]?.has(k)} lock={lock} onToggle={() => toggle(k, r)} />
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
