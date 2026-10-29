// Editor de um papel: identificação, um cartão por grupo (Conversas, Moderação de salas, Administração, Atendimento)
// com o nível de cada área e as capacidades avulsas, e a delegação. Nada é gravado até "Revisar e salvar": a revisão
// mostra o que amplia e o que reduz, área por área, e quantas pessoas são afetadas.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  areaLevel,
  KEY_AREA,
  RBAC_GROUPS,
  RBAC_KEYS,
  rbacLabel,
  VISIBLE_KEYS,
  withAreaLevel,
  type RbacArea,
  type RbacGroup,
} from '@shared/rbac';
import { api } from '../../../lib/api';
import { plural, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Menu, SkeletonTable, Toggle, Tooltip, confirmDialog } from '../../../components/ui';
import { GROUP_ICON, ReachBar } from './reach';
import { ReviewDialog, type Draft } from './Review';
import { lockText, people, rbacFail, rbacOk, type Grant, type RbacRole } from './data';

// O papel Administrador nunca perde a gestão de papéis (o servidor recusa).
const ROOT_KEEP = ['view-permissions', 'access-permissions', 'manage-roles'];
const KNOWN = Object.keys(RBAC_KEYS);

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function RoleEditor({
  roleId,
  copyFrom,
  roles,
  grant,
  onSaved,
  onDeleted,
}: {
  roleId?: string;
  copyFrom?: string;
  roles: RbacRole[] | null;
  grant: Grant | null;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const role = roleId ? roles?.find((r) => r._id === roleId) : undefined;
  const source = copyFrom ? roles?.find((r) => r._id === copyFrom) : undefined;
  const isNew = !roleId;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [stripped, setStripped] = useState<string[]>([]);
  const [showTechnical, setShowTechnical] = useState(false);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);

  // O rascunho nasce uma vez, quando os papéis e o contexto chegam.
  useEffect(() => {
    if (draft || !roles || !grant) return;
    if (roleId && !role) return;
    let base: Draft;
    if (role) {
      base = {
        name: role._id,
        description: role.description ?? '',
        scope: role.scope,
        mandatory2fa: role.mandatory2fa,
        restrictDirect: role.restrictDirect,
        permissions: new Set(role.permissions),
        delegable: [...(role.delegable ?? [])].sort(),
      };
      setInitial(base);
    } else {
      // Duplicar leva as permissões da origem; quem não é administrador só leva as que tem.
      const held = new Set(grant.held);
      const perms = (source?.permissions ?? []).filter((k) => grant.root || held.has(k));
      setStripped((source?.permissions ?? []).filter((k) => !perms.includes(k) && VISIBLE_KEYS.includes(k)));
      base = {
        name: source ? `${source._id}-copia` : '',
        description: source ? `Cópia de ${roleLabel(source._id)}` : '',
        scope: source?.scope ?? 'Users',
        mandatory2fa: source?.mandatory2fa ?? false,
        restrictDirect: source?.restrictDirect ?? false,
        permissions: new Set(perms),
        delegable: [],
      };
      setInitial({ ...base, permissions: new Set(), name: '', description: '' });
    }
    setDraft(base);
  }, [roles, grant, role, source, roleId, draft]);

  const lock = role && grant ? grant.roleLocks[role._id] : null;
  const canEditPerms = !!grant?.canEditPermissions && !lock;
  const canEditRole = !!grant?.canEditRoles && !lock;
  const readOnly = !canEditPerms && !canEditRole;
  const held = useMemo(() => new Set(grant?.held ?? []), [grant]);

  const dirty = useMemo(() => {
    if (!draft || !initial) return false;
    if (isNew) return true;
    return (
      draft.description !== initial.description ||
      draft.scope !== initial.scope ||
      draft.mandatory2fa !== initial.mandatory2fa ||
      draft.restrictDirect !== initial.restrictDirect ||
      !sameSet(draft.permissions, initial.permissions) ||
      draft.delegable.join() !== initial.delegable.join()
    );
  }, [draft, initial, isNew]);

  // Sair da página com alterações: o navegador pergunta.
  useEffect(() => {
    if (!dirty || isNew) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, isNew]);

  if (!roles || !grant) return <SkeletonTable rows={10} cols={2} />;
  if (roleId && !role)
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
    if (role?.root && ROOT_KEEP.includes(k)) return 'O Administrador sempre gerencia papéis.';
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
  // Um nível só pode ser escolhido se todas as chaves que ele muda estão liberadas para o ator.
  const levelBlocked = (area: RbacArea, index: number) => {
    const next = withAreaLevel(area, draft.permissions, index);
    const changed = area.levels.flatMap((l) => l.keys).filter((k) => next.has(k) !== draft.permissions.has(k));
    const locked = changed.filter((k) => keyLock(k));
    return locked.length ? keyLock(locked[0]) : null;
  };
  const setLevel = (area: RbacArea, index: number) => setPerms(withAreaLevel(area, draft.permissions, index));
  const setGroup = (g: RbacGroup, mode: 'none' | 'max') => {
    let next = new Set(draft.permissions);
    for (const a of g.areas) {
      const keys = [...a.levels.flatMap((l) => l.keys), ...a.extras].filter((k) => !keyLock(k));
      for (const k of keys) {
        if (mode === 'max') next.add(k);
        else next.delete(k);
      }
      next = new Set(next);
    }
    setPerms(next);
  };

  const groups = RBAC_GROUPS.filter((g) => g.id !== 'technical' || showTechnical || [...draft.permissions].some((k) => KEY_AREA[k] === 'bots'));
  const ordered = draft.scope === 'Subscriptions' ? [...groups].sort((a, b) => Number(b.id === 'room') - Number(a.id === 'room')) : groups;
  const legacyHeld = [...draft.permissions].filter((k) => !VISIBLE_KEYS.includes(k));
  const title = isNew ? (source ? `Duplicar ${roleLabel(source._id)}` : 'Novo papel') : roleLabel(role!._id);

  const back = async () => {
    if (dirty && !isNew) {
      const yes = await confirmDialog({ title: 'Descartar as alterações?', body: 'O que você mudou neste papel ainda não foi salvo.', confirmLabel: 'Descartar', danger: true });
      if (!yes) return;
    }
    navigate('/admin/permissions');
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        description: draft.description,
        mandatory2fa: draft.mandatory2fa,
        restrictDirect: draft.scope === 'Users' && draft.restrictDirect,
      };
      if (isNew || !role?.protected) body.scope = draft.scope;
      if (grant.canEditPermissions) Object.assign(body, { permissions: [...draft.permissions], knownPermissions: KNOWN });
      if (grant.root && draft.scope === 'Users' && !role?.root) body.delegable = draft.delegable;
      if (isNew) await api.post('rbac.roles.create', { name: draft.name.trim(), ...body });
      else await api.post('rbac.roles.update', { roleId: role!._id, ...body });
      rbacOk(isNew ? `Papel ${draft.name.trim()} criado.` : `Papel ${roleLabel(role!._id)} salvo.`);
      setReview(false);
      setInitial(draft);
      onSaved(isNew ? draft.name.trim() : role!._id);
    } catch (e) {
      rbacFail(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!role) return;
    if (role.users > 0) {
      await confirmDialog({ title: `${roleLabel(role._id)} ainda está com ${people(role.users)}`, body: 'Tire o papel dessas pessoas antes de excluí-lo.', confirmLabel: 'Entendi', cancelLabel: 'Fechar' });
      return;
    }
    const yes = await confirmDialog({ title: `Excluir o papel ${roleLabel(role._id)}?`, body: 'A exclusão fica no histórico e pode ser desfeita de lá.', confirmLabel: 'Excluir', danger: true });
    if (!yes) return;
    api
      .post('rbac.roles.delete', { roleId: role._id })
      .then(() => (rbacOk(`Papel ${roleLabel(role._id)} excluído.`), onDeleted()))
      .catch(rbacFail);
  };

  const delLock = role ? grant.deleteLocks[role._id] : null;
  const delegationTargets = roles.filter((r) => r.scope === 'Users' && !r.root && r._id !== role?._id);
  const changes = countChanges(initial, draft);

  return (
    <>
      <div className="rbac-editor">
        <div className="rbac-editor-head">
          <button className="btn ghost small rbac-back" onClick={() => void back()}>
            <Icon name="back" />
            Papéis
          </button>
          <div className="rbac-editor-title">
            <span className={role?.root ? 'rbac-title-icon root' : 'rbac-title-icon'}>
              <Icon name={role?.root ? 'rbac-root' : draft.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} size={20} />
            </span>
            <div>
              <h1>{title}</h1>
              <span className="muted small">
                {isNew ? 'O nome técnico não muda depois de criado.' : `${role!._id} · ${role!.scope === 'Users' ? 'papel global' : 'papel de sala'} · ${people(role!.users)}`}
              </span>
            </div>
          </div>
          {role && (
            <div className="page-actions">
              {grant.canEditRoles && (
                <button className="btn" onClick={() => navigate(`/admin/permissions/new/${encodeURIComponent(role._id)}`)}>
                  <Icon name="rbac-duplicate" />
                  Duplicar
                </button>
              )}
              <button className="btn" onClick={() => navigate(`/admin/permissions/history?entity=${encodeURIComponent(role._id)}`)}>
                <Icon name="rbac-history" />
                Histórico
              </button>
              {grant.canEditRoles && (
                <Tooltip label={delLock ? lockText(delLock) : 'Excluir o papel'}>
                  <button className="btn ghost danger" disabled={!!delLock} onClick={() => void remove()} aria-label="Excluir o papel">
                    <Icon name="delete" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {role?.root && (
          <div className="callout info">
            <Icon name="rbac-root" />
            <span>
              O Administrador passa por todas as travas de concessão: dá e tira qualquer permissão, edita qualquer papel e define delegações. A gestão de papéis fica sempre ligada
              nele, para ninguém perder o acesso a esta tela.
            </span>
          </div>
        )}
        {lock && (
          <div className="callout warn">
            <Icon name="rbac-lock" />
            <span>Somente leitura. {lockText(lock)}</span>
          </div>
        )}
        {!lock && !readOnly && !grant.root && (
          <div className="callout">
            <Icon name="info" />
            <span>Você só dá ou tira permissões que você mesmo tem. As outras aparecem com cadeado.</span>
          </div>
        )}
        {stripped.length > 0 && (
          <div className="callout warn">
            <Icon name="warning" />
            <span>
              {plural(stripped.length, 'permissão ficou', 'permissões ficaram')} de fora da cópia porque você não {stripped.length === 1 ? 'a' : 'as'} tem: {stripped.slice(0, 4).map(rbacLabel).join(', ')}
              {stripped.length > 4 ? '...' : '.'}
            </span>
          </div>
        )}

        <div className="rbac-editor-layout">
          <nav className="rbac-editor-nav" aria-label="Seções do papel">
            <a href="#rbac-identity">
              <Icon name="admin-permissions" size={14} />
              Identificação
            </a>
            {ordered.map((g) => {
              const n = g.areas.filter((a) => [...a.levels.flatMap((l) => l.keys), ...a.extras].some((k) => draft.permissions.has(k))).length;
              return (
                <a key={g.id} href={`#rbac-${g.id}`}>
                  <Icon name={GROUP_ICON[g.id]} size={14} />
                  {g.label}
                  <span className="rbac-nav-count">
                    {n}/{g.areas.length}
                  </span>
                </a>
              );
            })}
            {draft.scope === 'Users' && !role?.root && (
              <a href="#rbac-delegation">
                <Icon name="rbac-delegation" size={14} />
                Delegação
              </a>
            )}
            <label className="rbac-nav-toggle">
              <input type="checkbox" checked={showTechnical} onChange={(e) => setShowTechnical(e.target.checked)} />
              Mostrar permissões técnicas
            </label>
          </nav>

          <div className="rbac-editor-main">
            <section id="rbac-identity" className="card rbac-card">
              <header className="rbac-card-head">
                <div>
                  <h2>Identificação</h2>
                  <p className="muted small">Nome, escopo e regras de segurança do papel.</p>
                </div>
              </header>
              <div className="rbac-identity">
                <div className="two-col">
                  <Field label="Nome técnico" hint={isNew ? 'Sem espaços, ex.: supervisor. Não muda depois.' : undefined}>
                    <input value={draft.name} disabled={!isNew} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  <Field label="Nome exibido e descrição" hint="Até 32 caracteres viram o nome do papel nas telas.">
                    <input value={draft.description} disabled={!canEditRole && !isNew} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </Field>
                  <Field label="Escopo">
                    <select value={draft.scope} disabled={(!isNew && role?.protected) || (!canEditRole && !isNew)} onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}>
                      <option value="Users">Global: vale em todo o chat</option>
                      <option value="Subscriptions">De sala: vale só nas salas onde a pessoa tem o papel</option>
                    </select>
                  </Field>
                </div>
                <div className="toggle-list">
                  <Toggle
                    checked={draft.mandatory2fa}
                    disabled={!canEditRole && !isNew}
                    onChange={(v) => setDraft({ ...draft, mandatory2fa: v })}
                    label="Exigir 2FA"
                    description="Quem tem o papel configura a autenticação em dois fatores antes de usar o chat."
                  />
                  {draft.scope === 'Users' && (
                    <Toggle
                      checked={draft.restrictDirect}
                      disabled={!canEditRole && !isNew}
                      onChange={(v) => setDraft({ ...draft, restrictDirect: v })}
                      label="Restrito em conversas diretas"
                      description="Quem tem o papel não abre conversas diretas nem chamadas com outras pessoas restritas (como a Operação)."
                    />
                  )}
                </div>
                <div className="rbac-summary">
                  <span className="rbac-summary-label">Alcance</span>
                  <ReachBar perms={[...draft.permissions]} />
                </div>
              </div>
            </section>

            {ordered.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                draft={draft}
                initial={initial}
                keyLock={keyLock}
                levelBlocked={levelBlocked}
                onLevel={setLevel}
                onKey={toggleKey}
                onGroup={(mode) => setGroup(g, mode)}
                editable={canEditPerms}
              />
            ))}

            {legacyHeld.length > 0 && (
              <p className="muted small rbac-legacy-note">
                <Icon name="info" size={12} /> Este papel também tem {plural(legacyHeld.length, 'permissão antiga', 'permissões antigas')} sem efeito no chat (herança do Rocket.Chat). Elas não aparecem
                aqui e continuam como estão ao salvar.
              </p>
            )}

            {draft.scope === 'Users' && !role?.root && (
              <section id="rbac-delegation" className="card rbac-card">
                <header className="rbac-card-head">
                  <span className="rbac-group-icon">
                    <Icon name="rbac-delegation" />
                  </span>
                  <div>
                    <h2>Delegação</h2>
                    <p className="muted small">
                      Papéis que quem tem {draft.name ? roleLabel(draft.name) || draft.name : 'este papel'} pode dar, tirar e editar mesmo sem ter tudo o que eles dão. Excluir continua exigindo
                      ter tudo. Só um administrador altera.
                    </p>
                  </div>
                </header>
                {delegationTargets.length ? (
                  <div className="rbac-delegation">
                    {delegationTargets.map((r) => {
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
                ) : (
                  <p className="muted small">Não há outros papéis globais.</p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>

      {(dirty || isNew) && !readOnly && (
        <div className="save-bar" role="region" aria-label="Alterações não salvas">
          <span className="save-bar-text">
            <span className="save-bar-dot" aria-hidden="true" />
            {isNew ? 'Papel novo, ainda não criado' : plural(changes, 'alteração não salva', 'alterações não salvas')}
          </span>
          {!isNew && (
            <button className="btn ghost" onClick={() => setDraft(initial)} disabled={saving}>
              Descartar
            </button>
          )}
          <button className="btn primary" disabled={saving || (isNew && !draft.name.trim())} onClick={() => setReview(true)}>
            {isNew ? 'Revisar e criar' : 'Revisar e salvar'}
          </button>
        </div>
      )}
      {review && <ReviewDialog role={role} isNew={isNew} initial={initial} draft={draft} grant={grant} saving={saving} onClose={() => setReview(false)} onConfirm={() => void save()} />}
    </>
  );
}

const levelKeysText = (open: boolean, n: number) => (n === 1 ? `${open ? 'Esconder' : 'Ver'} a permissão do nível` : `${open ? 'Esconder' : 'Ver'} as ${n} permissões dos níveis`);

function countChanges(a: Draft, b: Draft) {
  let n = 0;
  for (const k of ['description', 'scope', 'mandatory2fa', 'restrictDirect'] as const) if (a[k] !== b[k]) n++;
  for (const k of new Set([...a.permissions, ...b.permissions])) if (a.permissions.has(k) !== b.permissions.has(k)) n++;
  if (a.delegable.join() !== b.delegable.join()) n++;
  return n;
}

function GroupCard({
  group,
  draft,
  initial,
  keyLock,
  levelBlocked,
  onLevel,
  onKey,
  onGroup,
  editable,
}: {
  group: RbacGroup;
  draft: Draft;
  initial: Draft;
  keyLock: (k: string) => string | null;
  levelBlocked: (a: RbacArea, i: number) => string | null;
  onLevel: (a: RbacArea, i: number) => void;
  onKey: (k: string, on: boolean) => void;
  onGroup: (mode: 'none' | 'max') => void;
  editable: boolean;
}) {
  const n = group.areas.filter((a) => [...a.levels.flatMap((l) => l.keys), ...a.extras].some((k) => draft.permissions.has(k))).length;
  return (
    <section id={`rbac-${group.id}`} className="card rbac-card">
      <header className="rbac-card-head">
        <span className="rbac-group-icon">
          <Icon name={GROUP_ICON[group.id]} />
        </span>
        <div>
          <h2>
            {group.label}
            <span className="pill head-count">
              {n}/{group.areas.length}
            </span>
          </h2>
          <p className="muted small">{group.description}</p>
        </div>
        {editable && (
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
        )}
      </header>
      <div className="rbac-areas">
        {group.areas.map((a) => (
          <AreaRow key={a.id} area={a} draft={draft} initial={initial} keyLock={keyLock} levelBlocked={levelBlocked} onLevel={onLevel} onKey={onKey} editable={editable} />
        ))}
      </div>
    </section>
  );
}

function AreaRow({
  area,
  draft,
  initial,
  keyLock,
  levelBlocked,
  onLevel,
  onKey,
  editable,
}: {
  area: RbacArea;
  draft: Draft;
  initial: Draft;
  keyLock: (k: string) => string | null;
  levelBlocked: (a: RbacArea, i: number) => string | null;
  onLevel: (a: RbacArea, i: number) => void;
  onKey: (k: string, on: boolean) => void;
  editable: boolean;
}) {
  const level = areaLevel(area, draft.permissions);
  const [open, setOpen] = useState(level.kind === 'custom');
  useEffect(() => {
    if (level.kind === 'custom') setOpen(true);
  }, [level.kind]);
  const current = level.kind === 'none' ? -1 : level.kind === 'level' ? level.index : null;
  const changed = [...area.levels.flatMap((l) => l.keys), ...area.extras].some((k) => draft.permissions.has(k) !== initial.permissions.has(k));
  const options = [{ label: 'Sem acesso', index: -1 }, ...area.levels.map((l, i) => ({ label: l.label, index: i }))];
  return (
    <div className={`rbac-area${changed ? ' changed' : ''}`}>
      <div className="rbac-area-main">
        <div className="rbac-area-text">
          <span className="rbac-area-name">
            {area.label}
            {changed && <span className="rbac-changed-dot" title="Alterado" />}
          </span>
          <span className="rbac-area-desc">{area.description}</span>
        </div>
        {area.levels.length > 0 && (
          <div className="rbac-level" role="radiogroup" aria-label={`Nível em ${area.label}`}>
            {options.map((o) => {
              const blocked = editable ? levelBlocked(area, o.index) : 'Somente leitura';
              const on = current === o.index;
              const btn = (
                <button
                  key={o.index}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  data-level={o.index < 0 ? 'none' : o.index === area.levels.length - 1 ? 'top' : 'mid'}
                  disabled={!!blocked && !on}
                  onClick={() => !on && onLevel(area, o.index)}
                >
                  {blocked && !on && editable && <Icon name="rbac-lock" size={12} />}
                  {o.label}
                </button>
              );
              return blocked && !on && editable ? (
                <Tooltip key={o.index} label={blocked}>
                  <span>{btn}</span>
                </Tooltip>
              ) : (
                btn
              );
            })}
            {level.kind === 'custom' && <span className="pill warn rbac-custom">Personalizado</span>}
          </div>
        )}
      </div>
      {area.extras.length > 0 && (
        <div className="rbac-keys">
          {area.extras.map((k) => (
            <KeyCheck key={k} k={k} draft={draft} initial={initial} keyLock={keyLock} onKey={onKey} />
          ))}
        </div>
      )}
      {area.levels.length > 0 && (
        <div className="rbac-detail">
          <button type="button" className="rbac-detail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevron-down" size={14} />
            {levelKeysText(open, area.levels.flatMap((l) => l.keys).length)}
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
