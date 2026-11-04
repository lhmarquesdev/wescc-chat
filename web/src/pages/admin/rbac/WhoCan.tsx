// Quem pode…? Da ação para os papéis e as pessoas: busca uma permissão pelo que ela faz, mostra os papéis globais que
// a dão, os papéis de sala em que ela vale (e os em que não tem efeito) e as pessoas, com o porquê (via qual papel).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AREA_GROUP, KEY_AREA, keyMatches, RBAC_AREAS, RBAC_GROUPS, RBAC_KEYS, rbacLabel, ROLE_PURPOSE, VISIBLE_KEYS } from '@shared/rbac';
import { api } from '../../../lib/api';
import { nameList, plural, roleLabel } from '../../../lib/format';
import { realtime } from '../../../lib/realtime';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Pager, SkeletonTable, Toggle, useAsync } from '../../../components/ui';
import { UserCell } from '../parts';
import { matrixQuery } from './matrix';
import { SensitiveTag } from './SensitiveTag';
import { ListStrip, RbacViews, Section } from './shell';
import { people, rbacOk, type Grant, type RbacRole } from './data';

// Atalhos para as perguntas mais comuns.
const SHORTCUTS: { key: string; label: string }[] = [
  { key: 'assign-roles', label: 'Quem dá papéis a outras pessoas?' },
  { key: 'can-audit', label: 'Quem lê mensagens de qualquer conversa?' },
  { key: 'start-dm-between-restricted', label: 'Quem conversa em particular com outras pessoas restritas?' },
  { key: 'create-p', label: 'Quem cria grupos privados?' },
  { key: 'delete-message', label: 'Quem apaga mensagens de outras pessoas?' },
  { key: 'edit-other-user-active-status', label: 'Quem desativa contas?' },
  { key: 'post-readonly', label: 'Quem escreve em canais de avisos?' },
  { key: 'edit-privileged-setting', label: 'Quem muda as configurações do chat?' },
];

const DIRECT_KEYS = ['create-d', 'view-d-room', 'start-dm-between-restricted'];
const CALL_KEYS = ['call-management', 'videoconf-ring-users'];

interface WhoCan {
  permission: string;
  legacy: boolean;
  checkedIn: 'room' | 'global';
  roles: { _id: string; users: number; activeUsers: number; root: boolean }[];
  // users: pessoas distintas; assignments: atribuições (a mesma pessoa Dona em três salas conta três).
  roomRoles: { _id: string; users: number; assignments: number; rooms: number }[];
  inert: string[];
  people: null | {
    items: { _id: string; username: string; name: string; active: boolean; type: string; via: string[]; restricted: boolean }[];
    total: number;
    offset: number;
    count: number;
  };
}

const areaOf = (k: string) => RBAC_AREAS.find((a) => a.id === KEY_AREA[k]);
const groupOf = (k: string) => RBAC_GROUPS.find((g) => g.id === AREA_GROUP[KEY_AREA[k]]);

export function WhoCanPage({ roles, grant }: { roles: RbacRole[] | null; grant: Grant | null }) {
  const [params, setParams] = useSearchParams();
  const key = params.get('key') ?? '';
  const pick = (k: string) => setParams(k ? { key: k } : {});
  return (
    <div className="rbac-shell list">
      <ListStrip eyebrow="Papéis e permissões" title="Quem pode…?" views={<RbacViews value="who" />}>
        <KeySearch onPick={pick} />
      </ListStrip>
      <div className="rbac-list-body">
        {!key ? (
          <div className="rbac-who-start">
            <p className="muted">Escolha uma ação para ver quais papéis e pessoas podem fazê-la, e por quê.</p>
            <div className="rbac-who-shortcuts">
              {SHORTCUTS.map((s) => (
                <button key={s.key} type="button" className="chip selectable" onClick={() => pick(s.key)}>
                  <Icon name="rbac-who" size={14} />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <WhoCanResult key={key} permission={key} roles={roles} grant={grant} />
        )}
      </div>
    </div>
  );
}

// Busca com sugestões agrupadas por grupo (rótulo, área e o que a permissão faz, numa linha).
function KeySearch({ onPick }: { onPick: (k: string) => void }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => (term.trim() ? VISIBLE_KEYS.filter((k) => keyMatches(k, term)).slice(0, 40) : []), [term]);
  useEffect(() => setActive(0), [term]);
  const choose = (k: string) => {
    onPick(k);
    setTerm('');
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (items.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      // Primeiro Esc fecha a lista e guarda o texto; o segundo limpa (o campo de busca limparia de cara).
      e.preventDefault();
      if (shown || empty) setOpen(false);
      else setTerm('');
    }
  };
  useEffect(() => {
    (listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const shown = open && items.length > 0;
  const empty = open && !!term.trim() && !items.length;
  return (
    <div className="rbac-who-search">
      <label className="rbac-search">
        <Icon name="search" />
        <input
          type="search"
          role="combobox"
          aria-expanded={shown || empty}
          aria-controls="rbac-who-options"
          aria-activedescendant={shown && active >= 0 ? `rbac-who-opt-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Busque uma ação"
          placeholder="Busque uma ação, ex.: apagar mensagens"
          value={term}
          onChange={(e) => (setTerm(e.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
        />
        {term && (
          <button type="button" aria-label="Limpar busca" onClick={() => setTerm('')}>
            <Icon name="close" size={14} />
          </button>
        )}
      </label>
      {empty && (
        <div className="rbac-who-options rbac-who-empty" id="rbac-who-options" role="status">
          Nenhuma permissão para “{term.trim()}”.
        </div>
      )}
      {shown && (
        <div className="rbac-who-options" id="rbac-who-options" role="listbox" aria-label="Permissões" ref={listRef}>
          {RBAC_GROUPS.map((g) => {
            const list = items.filter((k) => AREA_GROUP[KEY_AREA[k]] === g.id);
            if (!list.length) return null;
            return (
              <div key={g.id} role="group" aria-label={g.label}>
                <span className="rbac-who-options-group">{g.label}</span>
                {list.map((k) => {
                  const i = items.indexOf(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      id={`rbac-who-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? 'active' : undefined}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(k)}
                    >
                      <span className="rbac-who-option-label">
                        {rbacLabel(k)}
                        <span className="muted small"> · {areaOf(k)?.label}</span>
                      </span>
                      <span className="rbac-who-option-desc muted small">{RBAC_KEYS[k]?.description}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WhoCanResult({ permission, roles, grant }: { permission: string; roles: RbacRole[] | null; grant: Grant | null }) {
  const navigate = useNavigate();
  const canSeeUsers = usePermission(['view-user-administration']);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [inactive, setInactive] = useState(false);
  const [bots, setBots] = useState(false);
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(q.trim()), setOffset(0)), 250);
    return () => clearTimeout(t);
  }, [q]);
  const res = useAsync(
    () =>
      api.get('rbac.whoCan', {
        permission,
        q: debounced || undefined,
        includeInactive: inactive ? 'true' : undefined,
        includeBots: bots ? 'true' : undefined,
        offset,
        count,
      }) as Promise<WhoCan>,
    [permission, debounced, inactive, bots, offset, count],
  );
  const { reload } = res;
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'permissions.changed' || (ev.type === 'user' && ev.user.roles)) reload();
    });
    return () => void off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const def = RBAC_KEYS[permission];
  const data = res.data;
  if (res.error && !data)
    return (
      <Empty icon="error" title="Não foi possível consultar">
        {res.error}
      </Empty>
    );
  if (!data) return <SkeletonTable rows={6} cols={2} />;
  const area = areaOf(permission);
  const group = groupOf(permission);
  const purposeOf = (id: string) => {
    const r = roles?.find((x) => x._id === id);
    return r?.purpose || ROLE_PURPOSE[id] || '';
  };
  const holders = [...data.roles.map((r) => r._id), ...data.roomRoles.map((r) => r._id)];
  // Mesmo critério da lista de papéis: quem não edita (ou tem o papel acima do que dá) só vê.
  const canEdit = (id: string) => !!grant && (grant.canEditRoles || grant.canEditPermissions) && !grant.roleLocks[id];
  const matrixUrl = `/admin/permissions/matrix${matrixQuery({ roles: holders.slice(0, 12), group: 'all', q: permission, diff: false, sens: false })}`;
  const copy = () => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => rbacOk('Link copiado.'),
      () => rbacOk(window.location.href),
    );
  };
  const notes: string[] = [];
  if (DIRECT_KEYS.includes(permission))
    notes.push('Pessoas restritas em conversas diretas (Operação) só conversam com quem não é restrito, a não ser que alguém da conversa tenha Conversar em particular entre pessoas restritas.');
  if (CALL_KEYS.includes(permission)) notes.push('Para pessoas restritas, os papéis de sala não contam nas chamadas.');
  if (data.legacy) notes.push('Nenhuma parte do chat checa esta permissão.');

  return (
    <div className="rbac-who">
      <div className="rbac-who-main">
        <section className="rbac-who-card">
          <span className="rbac-eyebrow">
            {group?.label ?? 'Outras'} › {area?.label ?? 'Fora das áreas'}
          </span>
          <h2>
            {def?.label ?? permission}
            <SensitiveTag k={permission} />
          </h2>
          {def?.description && <p>{def.description}</p>}
          <div className="rbac-who-card-foot">
            <span className="pill tag">{data.checkedIn === 'room' ? 'Vale também nas salas' : 'Vale em todo o chat'}</span>
            <code className="mono small muted">{permission}</code>
            <span className="rbac-who-card-actions">
              <button type="button" className="btn small" onClick={() => navigate(matrixUrl)}>
                <Icon name="rbac-matrix" size={14} />
                Ver na matriz
              </button>
              <button type="button" className="btn small ghost" onClick={copy}>
                <Icon name="copy-link" size={14} />
                Copiar link
              </button>
            </span>
          </div>
        </section>
        {notes.map((n) => (
          <div key={n} className="callout info">
            <Icon name="info" />
            <span>{n}</span>
          </div>
        ))}
        <Section icon="admin-permissions" title="Papéis que dão esta permissão" count={data.roles.length} flush>
          {!data.roles.length ? (
            <p className="muted small rbac-empty-areas">Nenhum papel global dá esta permissão.</p>
          ) : (
            <ul className="rbac-who-roles">
              {data.roles.map((r) => (
                <li key={r._id}>
                  <span className={`cell-icon rbac-role-icon${r.root ? ' root' : ''}`}>
                    <Icon name={r.root ? 'rbac-root' : 'admin-permissions'} />
                  </span>
                  <span className="rbac-who-role-text">
                    <strong>{roleLabel(r._id)}</strong>
                    {purposeOf(r._id) && <span className="muted small">{purposeOf(r._id)}</span>}
                  </span>
                  {canSeeUsers ? (
                    <button type="button" className="link-btn small" onClick={() => navigate(`/admin/users?role=${encodeURIComponent(r._id)}`)}>
                      {people(r.users)}
                    </button>
                  ) : (
                    <span className="small muted">{people(r.users)}</span>
                  )}
                  <button type="button" className="btn small ghost" onClick={() => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}?tab=perms`)}>
                    {canEdit(r._id) ? 'Editar papel' : 'Ver papel'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {data.checkedIn === 'room' && (
          <Section icon="rbac-room" title="Papéis de sala" count={data.roomRoles.length} hint="Valem só nas salas onde a pessoa tem o papel." flush>
            {!data.roomRoles.length ? (
              <p className="muted small rbac-empty-areas">Nenhum papel de sala dá esta permissão.</p>
            ) : (
              <ul className="rbac-who-roles">
                {data.roomRoles.map((r) => (
                  <li key={r._id}>
                    <span className="cell-icon rbac-role-icon room">
                      <Icon name="rbac-room" />
                    </span>
                    <span className="rbac-who-role-text">
                      <strong>{roleLabel(r._id)}</strong>
                      <span className="muted small">
                        {plural(r.users, 'pessoa', 'pessoas')} em {plural(r.rooms, 'sala', 'salas')}
                      </span>
                    </span>
                    <button type="button" className="btn small ghost" onClick={() => navigate(`/admin/permissions/role/${encodeURIComponent(r._id)}?tab=people`)}>
                      Ver salas
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
        {data.inert.length > 0 && (
          <p className="muted small rbac-who-inert">Também marcada em {nameList(data.inert.map(roleLabel), 4)}, mas sem efeito: a permissão não é checada nas salas.</p>
        )}
      </div>
      <Section icon="admin-users" title="Pessoas" count={data.people?.total} flush>
        {!data.people ? (
          <p className="muted small rbac-empty-areas">Ver as pessoas pede a permissão Ver a lista de usuários.</p>
        ) : (
          <>
            <div className="rbac-area-tools">
              <label className="rbac-search small">
                <Icon name="search" />
                <input type="search" value={q} placeholder="Filtrar pessoas" aria-label="Filtrar pessoas" onChange={(e) => setQ(e.target.value)} />
              </label>
              <Toggle checked={inactive} onChange={(v) => (setInactive(v), setOffset(0))} label="Incluir desativadas" />
              <Toggle checked={bots} onChange={(v) => (setBots(v), setOffset(0))} label="Incluir bots" />
            </div>
            {!data.people.items.length ? (
              <p className="muted small rbac-empty-areas">{data.roles.length ? 'Ninguém com esses filtros.' : 'Ninguém tem esta permissão por um papel global.'}</p>
            ) : (
              <ul className="rbac-people">
                {data.people.items.map((u) => (
                  <li key={u._id}>
                    <button type="button" className="rbac-people-row" onClick={() => navigate(`/admin/users/edit/${u._id}`)}>
                      <UserCell
                        username={u.username}
                        name={u.name}
                        sub={`via ${nameList(u.via.map(roleLabel), 3)}`}
                        tag={
                          <>
                            {!u.active && <span className="pill tag">Desativada</span>}
                            {u.restricted && <span className="pill warn tag">Restrita</span>}
                            {u.type === 'bot' && <span className="pill tag">Bot</span>}
                          </>
                        }
                      />
                      <Icon name="next" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="rbac-who-pager">
              <Pager offset={offset} count={count} total={data.people.total} onChange={setOffset} onCountChange={(c) => (setCount(c), setOffset(0))} />
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
