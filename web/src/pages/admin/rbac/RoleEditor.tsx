// Editor de papel: cabeçalho fixo (voltar, nome editável, alterações pendentes, Reverter, Salvar) e abas no rodapé:
// Identificação, um grupo de permissões por aba (Conversas, Salas, Administração, Atendimento), Mapa de poder, Pessoas
// e Histórico. Salvar abre o "Revisar alterações"; nada é gravado antes de confirmar.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { areaLevel, KEY_AREA, levelText, RBAC_GROUPS, RBAC_KEYS, rbacLabel, VISIBLE_KEYS, withAreaLevel, type RbacArea, type RbacGroup } from '@shared/rbac';
import { api } from '../../../lib/api';
import { plural, roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Menu, SkeletonTable, Toggle, Tooltip, confirmDialog, useAsync } from '../../../components/ui';
import { UserCell } from '../parts';
import { RbacHistory } from './History';
import { GROUP_ICON, ReachBar, groupReach } from './reach';
import { ReviewDialog, type Draft } from './Review';
import { Chips, EditorShell, Notice, Section, type EditorTab } from './shell';
import { lockText, people, rbacFail, rbacOk, type Grant, type RbacRole } from './data';

// O papel Administrador nunca perde a gestão de papéis (o servidor recusa).
const ROOT_KEEP = ['view-permissions', 'access-permissions', 'manage-roles'];
const KNOWN = Object.keys(RBAC_KEYS);

type Tab = 'identity' | 'chat' | 'room' | 'admin' | 'power' | 'people' | 'history';

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function draftOf(role: RbacRole): Draft {
  return {
    name: role._id,
    description: role.description ?? '',
    scope: role.scope,
    mandatory2fa: role.mandatory2fa,
    restrictDirect: role.restrictDirect,
    permissions: new Set(role.permissions),
    delegable: [...(role.delegable ?? [])].sort(),
  };
}

export function RoleEditor({ roleId, roles, grant, onSaved, onDeleted }: { roleId: string; roles: RbacRole[] | null; grant: Grant | null; onSaved: () => void; onDeleted: () => void }) {
  const navigate = useNavigate();
  const role = roles?.find((r) => r._id === roleId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>('identity');
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    if (draft || !role) return;
    const d = draftOf(role);
    setDraft(d);
    setInitial(d);
  }, [role, draft]);

  const lock = role && grant ? grant.roleLocks[role._id] : null;
  const canEditPerms = !!grant?.canEditPermissions && !lock;
  const canEditRole = !!grant?.canEditRoles && !lock;
  const canWrite = canEditPerms || canEditRole;
  const held = useMemo(() => new Set(grant?.held ?? []), [grant]);
  const dirty = useMemo(() => {
    if (!draft || !initial) return false;
    return (
      draft.description !== initial.description ||
      draft.scope !== initial.scope ||
      draft.mandatory2fa !== initial.mandatory2fa ||
      draft.restrictDirect !== initial.restrictDirect ||
      !sameSet(draft.permissions, initial.permissions) ||
      draft.delegable.join() !== initial.delegable.join()
    );
  }, [draft, initial]);

  // Sair da página com alterações: o navegador pergunta.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (!roles || !grant) return <SkeletonTable rows={10} cols={2} />;
  if (!role)
    return (
      <Empty icon="search" title="Papel não encontrado">
        <button className="btn" onClick={() => navigate('/admin/permissions')}>
          Voltar aos papéis
        </button>
      </Empty>
    );
  if (!draft || !initial) return <SkeletonTable rows={10} cols={2} />;

  // Trava de uma chave: o ator não tem (só dá e tira o que tem) ou é a gestão de papéis do Administrador.
  const keyLock = (k: string): string | null => {
    if (!canEditPerms) return lock ? lockText(lock) : 'Você pode ver, mas não alterar permissões.';
    if (role.root && ROOT_KEEP.includes(k)) return 'O Administrador sempre gerencia papéis.';
    if (!grant.root && !held.has(k)) return 'Você não tem esta permissão, então não pode dá-la nem tirá-la.';
    return null;
  };
  const setPerms = (next: Set<string>) => setDraft({ ...draft, permissions: next });
  const toggleKey = (k: string, on: boolean) => {
    const next = new Set(draft.permissions);
    if (on) next.add(k);
    else next.delete(k);
    setPerms(next);
  };
  const levelBlocked = (area: RbacArea, index: number) => {
    const next = withAreaLevel(area, draft.permissions, index);
    const locked = area.levels.flatMap((l) => l.keys).filter((k) => next.has(k) !== draft.permissions.has(k) && keyLock(k));
    return locked.length ? keyLock(locked[0]) : null;
  };
  const setGroup = (g: RbacGroup, mode: 'none' | 'view' | 'max') => {
    let next = new Set(draft.permissions);
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
    setPerms(next);
  };

  const askLeave = async () => !dirty || confirmDialog({ title: 'Descartar as alterações?', body: 'O que você mudou neste papel ainda não foi salvo.', confirmLabel: 'Descartar', danger: true });

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { roleId: role._id, description: draft.description, mandatory2fa: draft.mandatory2fa, restrictDirect: draft.scope === 'Users' && draft.restrictDirect };
      if (!role.protected) body.scope = draft.scope;
      if (grant.canEditPermissions) Object.assign(body, { permissions: [...draft.permissions], knownPermissions: KNOWN });
      if (grant.root && draft.scope === 'Users' && !role.root) body.delegable = draft.delegable;
      await api.post('rbac.roles.update', body);
      rbacOk(`Papel ${roleLabel(role._id)} salvo.`);
      setReview(false);
      setInitial(draft);
      onSaved();
    } catch (e) {
      rbacFail(e);
    } finally {
      setSaving(false);
    }
  };

  const delLock = grant.deleteLocks[role._id];
  const remove = async () => {
    if (role.users > 0) {
      await confirmDialog({ title: `${roleLabel(role._id)} ainda está com ${people(role.users)}`, body: 'Tire o papel dessas pessoas antes de excluí-lo (aba Pessoas).', confirmLabel: 'Entendi', cancelLabel: 'Fechar' });
      return;
    }
    const yes = await confirmDialog({ title: `Excluir o papel ${roleLabel(role._id)}?`, body: 'Ninguém tem este papel. A exclusão fica no histórico e pode ser desfeita de lá.', confirmLabel: 'Excluir', danger: true });
    if (yes)
      api
        .post('rbac.roles.delete', { roleId: role._id })
        .then(() => (rbacOk(`Papel ${roleLabel(role._id)} excluído.`), onDeleted()))
        .catch(rbacFail);
  };

  const groupOf = (id: string) => RBAC_GROUPS.find((g) => g.id === id)!;
  const reachText = (id: string) => {
    const r = groupReach(groupOf(id), [...draft.permissions]);
    return `${r.any}/${r.total}`;
  };
  const tabs: EditorTab<Tab>[] = [
    { id: 'identity', label: 'Identificação', icon: 'rbac-id' },
    { id: 'chat', label: 'Conversas', icon: 'rbac-chat' },
    { id: 'room', label: 'Salas', icon: 'rbac-room' },
    { id: 'admin', label: 'Administração', icon: 'rbac-admin' },
    { id: 'power', label: 'Mapa de poder', icon: 'rbac-power' },
    { id: 'people', label: 'Pessoas', icon: 'admin-users' },
    { id: 'history', label: 'Histórico', icon: 'rbac-history' },
  ];
  // Papel de sala: a aba de salas vem logo depois da identificação.
  if (draft.scope === 'Subscriptions') tabs.splice(1, 2, tabs[2], tabs[1]);

  const status = role.root ? (
    <span className="rbac-status root">
      <Icon name="rbac-root" size={12} />
      Administrador
    </span>
  ) : role.protected ? (
    <span className="rbac-status">Sistema</span>
  ) : (
    <span className="rbac-status custom">Personalizado</span>
  );

  const notices = (
    <>
      {role.root && <Notice>O Administrador passa por todas as travas de concessão: dá e tira qualquer permissão, edita qualquer papel e define delegações. A gestão de papéis fica sempre ligada nele.</Notice>}
      {lock && <Notice kind="lock">Somente leitura. {lockText(lock)}</Notice>}
      {!lock && canEditPerms && !grant.root && <Notice>Você só dá ou tira permissões que você mesmo tem. As outras aparecem com cadeado.</Notice>}
      {!grant.canEditRoles && !grant.canEditPermissions && <Notice kind="lock">Você pode ver os papéis, mas não alterá-los.</Notice>}
    </>
  );

  const groupProps: GroupProps = { draft, initial, keyLock, levelBlocked, onLevel: (a, i) => setPerms(withAreaLevel(a, draft.permissions, i)), onKey: toggleKey, editable: canEditPerms };

  return (
    <>
      <EditorShell<Tab>
        backTo="/admin/permissions"
        onBack={askLeave}
        icon={<Icon name={role.root ? 'rbac-root' : draft.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} size={18} />}
        iconClass={role.root ? 'root' : undefined}
        eyebrow="Editor de papel"
        title={
          canEditRole && !role.root ? (
            <input
              className="rbac-title-input"
              aria-label="Nome exibido do papel"
              value={draft.description}
              placeholder={roleLabel(role._id)}
              maxLength={500}
              size={Math.max(8, Math.min(32, (draft.description || roleLabel(role._id)).length + 1))}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          ) : (
            <h1>{roleLabel(role._id)}</h1>
          )
        }
        status={status}
        dirty={dirty}
        canWrite={canWrite}
        saving={saving}
        onRevert={() => setDraft(initial)}
        onSave={() => setReview(true)}
        notices={notices}
        tabs={tabs}
        active={tab}
        onTab={setTab}
        label="Seções do papel"
      >
        {tab === 'identity' && (
          <div className="rbac-stack">
            <div className="rbac-grid-75">
              <Section icon="rbac-id" title="Identificação" hint="Nome, escopo e regras de segurança.">
                <div className="form">
                  <div className="two-col">
                    <Field label="Nome técnico" hint="Não muda depois de criado.">
                      <input value={role._id} disabled />
                    </Field>
                    <Field label="Nome exibido e descrição" hint="Até 32 caracteres viram o nome do papel nas telas.">
                      <input value={draft.description} disabled={!canEditRole} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Escopo">
                    <select value={draft.scope} disabled={role.protected || !canEditRole} onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}>
                      <option value="Users">Global: vale em todo o chat</option>
                      <option value="Subscriptions">De sala: vale só nas salas onde a pessoa tem o papel</option>
                    </select>
                  </Field>
                  <div className="toggle-list">
                    <Toggle
                      checked={draft.mandatory2fa}
                      disabled={!canEditRole}
                      onChange={(v) => setDraft({ ...draft, mandatory2fa: v })}
                      label="Exigir 2FA"
                      description="Quem tem o papel configura a autenticação em dois fatores antes de usar o chat."
                    />
                    {draft.scope === 'Users' && (
                      <Toggle
                        checked={draft.restrictDirect}
                        disabled={!canEditRole}
                        onChange={(v) => setDraft({ ...draft, restrictDirect: v })}
                        label="Restrito em conversas diretas"
                        description="Não abre conversas diretas nem chamadas com outras pessoas restritas (como a Operação)."
                      />
                    )}
                  </div>
                </div>
              </Section>
              <Section icon="info" title="Sobre este papel">
                <dl className="rbac-facts">
                  <dt>Tipo</dt>
                  <dd>{role.root ? 'Administrador (raiz)' : role.protected ? 'Do sistema' : 'Personalizado'}</dd>
                  <dt>Escopo</dt>
                  <dd>{role.scope === 'Users' ? 'Global' : 'De sala'}</dd>
                  <dt>Pessoas</dt>
                  <dd>
                    {role.users}
                    {role.scope === 'Users' && role.users !== role.activeUsers ? ` (${role.activeUsers} ativas)` : ''}
                  </dd>
                  <dt>Permissões</dt>
                  <dd>{draft.permissions.size}</dd>
                </dl>
                <div className="rbac-about-actions">
                  {grant.canEditRoles && (
                    <button className="btn small" onClick={() => navigate(`/admin/permissions?copy=${encodeURIComponent(role._id)}`)}>
                      <Icon name="rbac-duplicate" />
                      Duplicar
                    </button>
                  )}
                  {grant.canEditRoles && !role.protected && (
                    <Tooltip label={delLock ? lockText(delLock) : 'Excluir o papel'}>
                      <button className="btn small ghost danger" aria-disabled={!!delLock} onClick={() => !delLock && void remove()}>
                        <Icon name="delete" />
                        Excluir
                      </button>
                    </Tooltip>
                  )}
                </div>
              </Section>
            </div>
            <Section icon="rbac-areas" title="Resumo de acesso" hint="Quantas áreas de cada grupo este papel libera. Toque num grupo para abrir a aba dele.">
              <div className="rbac-summary-groups">
                {RBAC_GROUPS.filter((g) => g.id !== 'technical').map((g) => {
                  const r = groupReach(g, [...draft.permissions]);
                  return (
                    <button key={g.id} type="button" className="rbac-summary-card" onClick={() => setTab(g.id as Tab)}>
                      <span className="rbac-summary-head">
                        <Icon name={GROUP_ICON[g.id]} size={16} />
                        {g.label}
                      </span>
                      <strong>
                        {r.any}
                        <span>/{r.total}</span>
                      </strong>
                      <span className="muted small">{r.any ? `${r.full} ${r.full === 1 ? 'completa' : 'completas'}` : 'sem acesso'}</span>
                    </button>
                  );
                })}
              </div>
            </Section>
            {draft.scope === 'Users' && !role.root && (
              <Section
                icon="rbac-delegation"
                title="Delegação"
                hint={`Papéis que quem tem ${roleLabel(role._id)} pode dar, tirar e editar mesmo sem ter tudo o que eles dão. Excluir continua exigindo ter tudo. Só um administrador altera.`}
              >
                <div className="rbac-delegation">
                  {roles
                    .filter((r) => r.scope === 'Users' && !r.root && r._id !== role._id)
                    .map((r) => {
                      const on = draft.delegable.includes(r._id);
                      return (
                        <label key={r._id} className={`chip selectable ${on ? 'on' : ''} ${!grant.root ? 'disabled' : ''}`}>
                          <input
                            type="checkbox"
                            hidden
                            checked={on}
                            disabled={!grant.root}
                            onChange={() => setDraft({ ...draft, delegable: (on ? draft.delegable.filter((x) => x !== r._id) : [...draft.delegable, r._id]).sort() })}
                          />
                          {roleLabel(r._id)}
                        </label>
                      );
                    })}
                </div>
              </Section>
            )}
          </div>
        )}
        {(tab === 'chat' || tab === 'room' || tab === 'admin') && (
          <div className="rbac-stack">
            <GroupPanel group={groupOf(tab)} count={reachText(tab)} onGroup={(m) => setGroup(groupOf(tab), m)} {...groupProps} />
            {tab === 'chat' && (showTechnical || [...draft.permissions].some((k) => KEY_AREA[k] === 'bots')) && (
              <GroupPanel group={groupOf('technical')} count={reachText('technical')} onGroup={(m) => setGroup(groupOf('technical'), m)} {...groupProps} />
            )}
            {tab === 'chat' && (
              <label className="rbac-tech-toggle">
                <input type="checkbox" checked={showTechnical} onChange={(e) => setShowTechnical(e.target.checked)} />
                Mostrar as permissões técnicas (bots e integrações)
              </label>
            )}
          </div>
        )}
        {tab === 'power' && <PowerMap perms={draft.permissions} />}
        {tab === 'people' && <RolePeople role={role} />}
        {tab === 'history' && <RbacHistory entity={role._id} embedded onChanged={onSaved} />}
      </EditorShell>
      {review && <ReviewDialog role={role} isNew={false} initial={initial} draft={draft} grant={grant} saving={saving} onClose={() => setReview(false)} onConfirm={() => void save()} />}
    </>
  );
}

// ---------- Aba de um grupo ----------

type AreaFilter = 'all' | 'on' | 'off';

interface GroupProps {
  draft: Draft;
  initial: Draft;
  keyLock: (k: string) => string | null;
  levelBlocked: (a: RbacArea, i: number) => string | null;
  onLevel: (a: RbacArea, i: number) => void;
  onKey: (k: string, on: boolean) => void;
  editable: boolean;
}

const areaKeys = (a: RbacArea) => [...a.levels.flatMap((l) => l.keys), ...a.extras];

function GroupPanel({ group, count, onGroup, ...p }: GroupProps & { group: RbacGroup; count: string; onGroup: (m: 'none' | 'view' | 'max') => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<AreaFilter>('all');
  const term = q.trim().toLowerCase();
  const list = group.areas.filter((a) => {
    const on = areaKeys(a).some((k) => p.draft.permissions.has(k));
    if (filter === 'on' && !on) return false;
    if (filter === 'off' && on) return false;
    if (!term) return true;
    return [a.label, a.description, ...areaKeys(a).map(rbacLabel)].some((t) => t.toLowerCase().includes(term));
  });
  const hasView = group.areas.some((a) => a.levels.length);
  return (
    <Section
      icon={GROUP_ICON[group.id]}
      title={group.label}
      hint={group.description}
      count={count}
      flush
      action={
        p.editable && (
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
      <div className="rbac-area-tools">
        <label className="rbac-search small">
          <Icon name="search" />
          <input type="search" value={q} placeholder="Buscar nesta aba" aria-label="Buscar nesta aba" onChange={(e) => setQ(e.target.value)} />
        </label>
        <Chips<AreaFilter>
          label="Mostrar"
          value={filter}
          onChange={setFilter}
          items={[
            { id: 'all', label: 'Todas' },
            { id: 'on', label: 'Com acesso' },
            { id: 'off', label: 'Sem acesso' },
          ]}
        />
      </div>
      <div className="rbac-areas">
        {list.map((a) => (
          <AreaRow key={a.id} area={a} {...p} />
        ))}
        {!list.length && <p className="muted small rbac-empty-areas">Nenhuma área com esse filtro.</p>}
      </div>
    </Section>
  );
}

function AreaRow({ area, draft, initial, keyLock, levelBlocked, onLevel, onKey, editable }: GroupProps & { area: RbacArea }) {
  const level = areaLevel(area, draft.permissions);
  const [open, setOpen] = useState(level.kind === 'custom');
  useEffect(() => {
    if (level.kind === 'custom') setOpen(true);
  }, [level.kind]);
  const changed = areaKeys(area).some((k) => draft.permissions.has(k) !== initial.permissions.has(k));
  const n = area.levels.flatMap((l) => l.keys).length;
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
          <LevelPicker
            area={area}
            current={level.kind === 'none' ? -1 : level.kind === 'level' ? level.index : null}
            readOnly={!editable}
            blocked={(i) => levelBlocked(area, i)}
            onPick={(i) => onLevel(area, i)}
          />
        )}
      </div>
      {area.extras.length > 0 && (
        <div className="rbac-keys">
          {area.extras.map((k) => (
            <KeyCheck key={k} k={k} draft={draft} initial={initial} keyLock={keyLock} onKey={onKey} />
          ))}
        </div>
      )}
      {n > 0 && (
        <div className="rbac-detail">
          <button type="button" className="rbac-detail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevron-down" size={14} />
            {n === 1 ? `${open ? 'Esconder' : 'Ver'} a permissão do nível` : `${open ? 'Esconder' : 'Ver'} as ${n} permissões dos níveis`}
          </button>
          {open && (
            <div className="rbac-keys levels">
              {area.levels.map((l) => (
                <div key={l.label} className="rbac-level-keys">
                  <span className="rbac-level-name">{l.label}</span>
                  {l.keys.map((k) => (
                    <KeyCheck key={k} k={k} draft={draft} initial={initial} keyLock={keyLock} onKey={onKey} />
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

function KeyCheck({ k, draft, initial, keyLock, onKey }: { k: string; draft: Draft; initial: Draft; keyLock: (k: string) => string | null; onKey: (k: string, on: boolean) => void }) {
  const on = draft.permissions.has(k);
  const lock = keyLock(k);
  const changed = on !== initial.permissions.has(k);
  const def = RBAC_KEYS[k];
  return (
    <label className={`rbac-key${lock ? ' locked' : ''}${changed ? ' changed' : ''}`} title={lock ?? undefined}>
      <input type="checkbox" checked={on} disabled={!!lock} onChange={(e) => onKey(k, e.target.checked)} />
      <span className="rbac-key-text">
        <span className="rbac-key-label">
          {def?.label ?? k}
          {lock && <Icon name="rbac-lock" size={12} />}
        </span>
        {def?.description && <span className="rbac-key-desc">{def.description}</span>}
      </span>
    </label>
  );
}

// ---------- Mapa de poder ----------

function PowerMap({ perms }: { perms: Set<string> }) {
  const legacy = [...perms].filter((k) => !VISIBLE_KEYS.includes(k));
  const technical = RBAC_GROUPS.find((g) => g.id === 'technical')!.areas.flatMap((a) => a.extras).filter((k) => perms.has(k));
  return (
    <div className="rbac-stack">
      <Section icon="rbac-power" title="O que este papel libera" hint="Área por área, o nível e as capacidades ligadas. Áreas sem acesso ficam de fora.">
        <ReachBar perms={[...perms]} />
        <div className="rbac-power">
          {RBAC_GROUPS.filter((g) => g.id !== 'technical').map((g) => {
            const list = g.areas.filter((a) => areaKeys(a).some((k) => perms.has(k)));
            return (
              <div key={g.id} className="rbac-power-group">
                <span className="rbac-group-label">
                  <Icon name={GROUP_ICON[g.id]} size={14} />
                  {g.label}
                </span>
                {list.length ? (
                  <ul>
                    {list.map((a) => {
                      const lv = areaLevel(a, perms);
                      const extras = a.extras.filter((k) => perms.has(k));
                      return (
                        <li key={a.id}>
                          <span className="rbac-power-area">{a.label}</span>
                          {a.levels.length > 0 && (
                            <span className={`pill tag${lv.kind === 'custom' ? ' warn' : lv.kind === 'level' && lv.index === a.levels.length - 1 ? ' accent' : ''}`}>{levelText(a, lv)}</span>
                          )}
                          {extras.length > 0 && <span className="muted small">{extras.map(rbacLabel).join(' · ')}</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted small">Sem acesso.</p>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      <Section icon="rbac-technical" title="Capacidades avançadas" hint="Permissões de bots e integrações, e as antigas sem efeito que ficam guardadas.">
        <p className="small">{technical.length ? technical.map(rbacLabel).join(' · ') : 'Nenhuma capacidade técnica.'}</p>
        {legacy.length > 0 && (
          <p className="muted small">
            Também guarda {plural(legacy.length, 'permissão antiga', 'permissões antigas')} sem efeito no chat (herança do Rocket.Chat). Elas não aparecem nas abas e continuam como estão ao salvar.
          </p>
        )}
      </Section>
    </div>
  );
}

// ---------- Pessoas com o papel ----------

function RolePeople({ role }: { role: RbacRole }) {
  const can = usePermission(['view-user-administration']);
  const navigate = useNavigate();
  const { data, loading, error } = useAsync(() => (can ? api.get('roles.getUsersInRole', { role: role._id, count: 200 }) : Promise.resolve(null)), [role._id, can]);
  if (!can)
    return (
      <Section icon="admin-users" title="Pessoas">
        <p className="muted small">Ver quem tem o papel pede acesso à lista de usuários.</p>
      </Section>
    );
  return (
    <Section
      icon="admin-users"
      title="Pessoas com este papel"
      count={data?.total ?? role.users}
      hint={role.scope === 'Users' ? 'Para dar ou tirar o papel, abra a pessoa.' : 'Papel de sala: a lista mostra quem tem o papel em alguma sala.'}
      flush
    >
      {loading && !data ? (
        <SkeletonTable rows={4} cols={2} />
      ) : error ? (
        <p className="muted small rbac-empty-areas">{error}</p>
      ) : !data?.users.length ? (
        <Empty icon="admin-users" title="Ninguém tem este papel" />
      ) : (
        <ul className="rbac-people">
          {data.users.map((u: any) => (
            <li key={u._id}>
              <button type="button" className="rbac-people-row" onClick={() => navigate(`/admin/users/edit/${u._id}`)}>
                <UserCell username={u.username} name={u.name} sub={u.active ? undefined : 'Desativado'} />
                <Icon name="next" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
