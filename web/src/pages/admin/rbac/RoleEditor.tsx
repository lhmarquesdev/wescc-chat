// Editor de papel: cabeçalho fixo (voltar, nome editável, Comparar com…, alterações pendentes, Reverter, Salvar) e
// quatro abas no rodapé: Resumo (identificação, o que o papel libera, delegação), Permissões, Pessoas e Histórico.
// Salvar abre o "Revisar alterações" e grava só o que esta tela mudou (deltas): o que outra pessoa salvou no meio-tempo
// em outras permissões continua.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { areaLevel, isSensitive, KEY_AREA, levelText, RBAC_GROUPS, rbacLabel, ROLE_PURPOSE, VISIBLE_KEYS } from '@shared/rbac';
import { api } from '../../../lib/api';
import { plural, ROLE_LABEL, roleLabel } from '../../../lib/format';
import { realtime } from '../../../lib/realtime';
import { usePermission, useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { UserPicker, type PickedUser } from '../../../components/Pickers';
import { Empty, Field, Menu, Modal, SkeletonTable, Toggle, Tooltip, confirmDialog, useAsync } from '../../../components/ui';
import { useIsPhone } from '../../../components/overlay';
import { UserCell } from '../parts';
import { BulkRolesDialog } from './BulkRoles';
import { RbacHistory } from './History';
import { groupIcon } from './groupIcons';
import { matrixQuery } from './matrix';
import { areaKeys, PermissionsTab } from './Permissions';
import { ReachBar } from './reach';
import { ReviewDialog, type Draft } from './Review';
import { RoomRoles } from './RoomRoles';
import { SensitiveTag } from './SensitiveTag';
import { EditorShell, LockHint, Notice, Section, type EditorTab } from './shell';
import { lockText, people, rbacFail, rbacOk, userLockOf, type Grant, type RbacRole } from './data';

type Tab = 'summary' | 'perms' | 'people' | 'history';
const TABS: Tab[] = ['summary', 'perms', 'people', 'history'];
const NAME_MAX = 32;
const PURPOSE_MAX = 200;

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function draftOf(role: RbacRole): Draft {
  return {
    name: role._id,
    description: role.description ?? '',
    purpose: role.purpose ?? '',
    scope: role.scope,
    mandatory2fa: role.mandatory2fa,
    restrictDirect: role.restrictDirect,
    permissions: new Set(role.permissions),
    delegable: [...(role.delegable ?? [])].sort(),
  };
}

const differs = (a: Draft, b: Draft) =>
  a.description !== b.description ||
  a.purpose !== b.purpose ||
  a.scope !== b.scope ||
  a.mandatory2fa !== b.mandatory2fa ||
  a.restrictDirect !== b.restrictDirect ||
  !sameSet(a.permissions, b.permissions) ||
  a.delegable.join() !== b.delegable.join();

export const compareUrl = (a: string, b: string) => `/admin/permissions/matrix${matrixQuery({ roles: [a, b], group: 'all', q: '', diff: true, sens: false })}`;

export function RoleEditor({ roleId, roles, grant, onSaved, onDeleted }: { roleId: string; roles: RbacRole[] | null; grant: Grant | null; onSaved: () => void; onDeleted: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const meId = useStore((s) => s.me?._id);
  const role = roles?.find((r) => r._id === roleId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [group, setGroup] = useState('all');
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  // Outra pessoa salvou este papel enquanto ele estava com alterações aqui ('' = não deu para saber quem).
  const [changedBy, setChangedBy] = useState<string | null>(null);
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'summary';
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'summary') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );

  const dirty = useMemo(() => !!draft && !!initial && differs(draft, initial), [draft, initial]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // A lista recarrega a cada permissions.changed (index.tsx). Sem alterações aqui, o editor acompanha em silêncio.
  useEffect(() => {
    if (!role || (draft && dirtyRef.current)) return;
    const d = draftOf(role);
    setDraft(d);
    setInitial(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Com alterações: avisa quem salvou, e ao salvar só as mudanças desta tela entram.
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type !== 'permissions.changed' || !ev.roles?.includes(roleId) || ev.by === meId || !dirtyRef.current) return;
      if (!ev.by) return setChangedBy('');
      api
        .get('users.info', { userId: ev.by })
        .then((r) => setChangedBy(`@${r.user.username}`))
        .catch(() => setChangedBy(''));
    });
    return () => void off();
  }, [roleId, meId]);

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

  const lock = grant.roleLocks[role._id];
  const canEditPerms = grant.canEditPermissions && !lock;
  const canEditRole = grant.canEditRoles && !lock;
  const canWrite = canEditPerms || canEditRole;

  const askLeave = async () => !dirty || confirmDialog({ title: 'Descartar as alterações?', body: 'O que você mudou neste papel ainda não foi salvo.', confirmLabel: 'Descartar', danger: true });
  const compare = async (other: string) => {
    if (await askLeave()) navigate(compareUrl(role._id, other));
  };
  const revert = () => {
    const d = draftOf(role);
    setDraft(d);
    setInitial(d);
    setChangedBy(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { roleId: role._id, description: draft.description, purpose: draft.purpose, mandatory2fa: draft.mandatory2fa, restrictDirect: draft.scope === 'Users' && draft.restrictDirect };
      if (!role.protected) body.scope = draft.scope;
      if (grant.canEditPermissions) Object.assign(body, { permissions: [...draft.permissions], basePermissions: [...initial.permissions] });
      if (grant.root && draft.scope === 'Users' && !role.root) body.delegable = draft.delegable;
      const r = await api.post('rbac.roles.update', body);
      rbacOk(`Papel ${roleLabel(role._id)} salvo.`);
      // O que ficou no servidor (pode ter mudanças de outra pessoa) vira a base.
      const next = draftOf({ ...role, ...r.role });
      setReview(false);
      setInitial(next);
      setDraft(next);
      setChangedBy(null);
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

  const tabs: EditorTab<Tab>[] = [
    { id: 'summary', label: 'Resumo', icon: 'rbac-id' },
    { id: 'perms', label: 'Permissões', icon: 'rbac-areas' },
    { id: 'people', label: 'Pessoas', icon: 'admin-users' },
    { id: 'history', label: 'Histórico', icon: 'rbac-history' },
  ];

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
      {changedBy !== null && dirty && (
        <Notice kind="warn">{changedBy ? `${changedBy} alterou este papel agora.` : 'Outra pessoa alterou este papel agora.'} Ao salvar, só as suas mudanças são aplicadas.</Notice>
      )}
      {tab === 'summary' && role.root && (
        <Notice>O Administrador passa por todas as travas de concessão: dá e tira qualquer permissão, edita qualquer papel e define delegações. A gestão de papéis fica sempre ligada nele.</Notice>
      )}
      {tab !== 'perms' && lock && <Notice kind="lock">Somente leitura. {lockText(lock)}</Notice>}
      {tab !== 'perms' && !lock && !grant.canEditRoles && !grant.canEditPermissions && <Notice kind="lock">Você pode ver os papéis, mas não alterá-los.</Notice>}
    </>
  );

  const others = [...roles].filter((r) => r._id !== role._id).sort((a, b) => Number(b.scope === 'Users') - Number(a.scope === 'Users') || roleLabel(a._id).localeCompare(roleLabel(b._id), 'pt-BR'));
  const compareMenu = (small?: boolean) => (
    <Menu
      label="Comparar com…"
      sheetTitle="Comparar com…"
      trigger={
        <button type="button" className={`btn small${small ? '' : ' rbac-compare-btn'}`}>
          <Icon name="rbac-compare" size={14} />
          <span>Comparar com…</span>
        </button>
      }
    >
      {(close) => (
        <div className="rbac-menu-scroll">
          {others.map((r) => (
            <button key={r._id} onClick={() => (close(), void compare(r._id))}>
              <Icon name={r.root ? 'rbac-root' : r.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} />
              {roleLabel(r._id)}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );

  const nameEditable = canEditRole && !role.root && !ROLE_LABEL[role._id];

  return (
    <>
      <EditorShell<Tab>
        backTo="/admin/permissions"
        onBack={askLeave}
        icon={<Icon name={role.root ? 'rbac-root' : draft.scope === 'Subscriptions' ? 'rbac-room' : 'admin-permissions'} size={18} />}
        iconClass={role.root ? 'root' : undefined}
        eyebrow="Editor de papel"
        title={
          nameEditable ? (
            <input
              className="rbac-title-input"
              aria-label="Nome exibido do papel"
              value={draft.description}
              placeholder={roleLabel(role._id)}
              maxLength={NAME_MAX}
              size={Math.max(8, Math.min(NAME_MAX, (draft.description || roleLabel(role._id)).length + 1))}
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
        onRevert={revert}
        onSave={() => setReview(true)}
        extraActions={compareMenu()}
        notices={notices}
        tabs={tabs}
        active={tab}
        onTab={setTab}
        label="Seções do papel"
      >
        {tab === 'summary' && (
          <div className="rbac-stack">
            <div className="rbac-grid-75">
              <Section icon="rbac-id" title="Identificação" hint="Nome, para que serve, escopo e regras de segurança.">
                <div className="form">
                  <div className="two-col">
                    <Field label="Identificador" hint="Não muda depois de criado.">
                      <input value={role._id} disabled />
                    </Field>
                    <Field label="Nome exibido" hint={nameEditable ? `Até ${NAME_MAX} caracteres. ${draft.description.length}/${NAME_MAX}` : 'Nome do sistema.'}>
                      <input value={nameEditable ? draft.description : roleLabel(role._id)} disabled={!nameEditable} maxLength={NAME_MAX} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Para que serve" hint={`Uma frase simples. Aparece embaixo do nome. ${draft.purpose.length}/${PURPOSE_MAX}`}>
                    <textarea
                      rows={2}
                      value={draft.purpose}
                      placeholder={ROLE_PURPOSE[role._id] ?? 'Ex.: Cuida da equipe do turno da noite.'}
                      disabled={!canEditRole}
                      maxLength={PURPOSE_MAX}
                      onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                    />
                  </Field>
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
                  {compareMenu(true)}
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
            <PowerMap perms={draft.permissions} onGroup={(g) => (setGroup(g), setTab('perms'))} />
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
        {tab === 'perms' && (
          <PermissionsTab
            role={role}
            draft={draft}
            initial={initial}
            grant={grant}
            editable={canEditPerms}
            lockNotice={lock ? `Somente leitura. ${lockText(lock)}` : 'Você vê as permissões, mas não as altera: falta Alterar as permissões dos papéis.'}
            group={group}
            onGroup={setGroup}
            onChange={(next) => setDraft({ ...draft, permissions: next })}
          />
        )}
        {tab === 'people' && (role.scope === 'Users' ? <RolePeople role={role} grant={grant} onChanged={onSaved} /> : <RoomRolePeople role={role} />)}
        {tab === 'history' && <RbacHistory entity={role._id} embedded onChanged={onSaved} />}
      </EditorShell>
      {review && <ReviewDialog role={role} isNew={false} initial={initial} draft={draft} grant={grant} saving={saving} onClose={() => setReview(false)} onConfirm={() => void save()} />}
    </>
  );
}

// ---------- O que este papel libera ----------

function PowerMap({ perms, onGroup }: { perms: Set<string>; onGroup: (g: string) => void }) {
  const legacy = [...perms].filter((k) => !VISIBLE_KEYS.includes(k));
  const technical = [...perms].filter((k) => KEY_AREA[k] === 'bots');
  const sensitive = [...perms].filter(isSensitive);
  return (
    <Section icon="rbac-power" title="O que este papel libera" hint="Área por área, o nível e as capacidades ligadas. Toque num grupo para abrir as permissões dele.">
      <ReachBar perms={[...perms]} />
      <div className="rbac-power">
        {RBAC_GROUPS.filter((g) => g.id !== 'technical').map((g) => {
          const list = g.areas.filter((a) => areaKeys(a).some((k) => perms.has(k)));
          return (
            <div key={g.id} className="rbac-power-group">
              <button type="button" className="rbac-group-label link-btn" onClick={() => onGroup(g.id)}>
                <Icon name={groupIcon(g.id)} size={14} />
                {g.label}
                <Icon name="next" size={12} />
              </button>
              {list.length ? (
                <ul>
                  {list.map((a) => {
                    const lv = areaLevel(a, perms);
                    const extras = a.extras.filter((k) => perms.has(k) && !isSensitive(k));
                    const sens = areaKeys(a).filter((k) => perms.has(k) && isSensitive(k));
                    return (
                      <li key={a.id}>
                        <span className="rbac-power-area">{a.label}</span>
                        {a.levels.length > 0 && (
                          <span className={`pill tag${lv.kind === 'custom' ? ' warn' : lv.kind === 'level' && lv.index === a.levels.length - 1 ? ' accent' : ''}`}>{levelText(a, lv)}</span>
                        )}
                        {extras.length > 0 && <span className="muted small">{extras.map(rbacLabel).join(' · ')}</span>}
                        {sens.map((k) => (
                          <SensitiveTag key={k} k={k} label />
                        ))}
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
      {sensitive.length > 0 && (
        <p className="rbac-power-sensitive">
          <Icon name="rbac-sensitive" size={14} />
          {plural(sensitive.length, 'permissão sensível', 'permissões sensíveis')}
        </p>
      )}
      {technical.length > 0 && <p className="muted small">Técnicas: {technical.map(rbacLabel).join(' · ')}</p>}
      {legacy.length > 0 && (
        <p className="muted small">
          Também guarda {plural(legacy.length, 'permissão antiga', 'permissões antigas')} sem efeito no chat (herança do Rocket.Chat). Elas não aparecem nas abas e continuam como estão ao salvar.
        </p>
      )}
    </Section>
  );
}

// ---------- Pessoas com o papel ----------

function RolePeople({ role, grant, onChanged }: { role: RbacRole; grant: Grant; onChanged: () => void }) {
  const can = usePermission(['view-user-administration']);
  const meId = useStore((s) => s.me?._id) ?? '';
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(() => (can ? api.get('roles.getUsersInRole', { role: role._id, count: 200 }) : Promise.resolve(null)), [role._id, can]);
  const [picking, setPicking] = useState(false);
  const [bulk, setBulk] = useState<{ mode: 'add' | 'remove'; userIds: string[] } | null>(null);
  const canAssign = grant.canAssignRoles && !grant.roleLocks[role._id];
  const done = () => (setBulk(null), reload(), onChanged());
  if (!can)
    return (
      <Section icon="admin-users" title="Pessoas">
        <p className="muted small">Ver quem tem o papel pede acesso à lista de usuários.</p>
      </Section>
    );
  return (
    <>
      <Section
        icon="admin-users"
        title="Pessoas com este papel"
        count={data?.total ?? role.users}
        hint={canAssign ? 'Dê o papel a mais pessoas ou tire de quem não precisa: antes de aplicar você vê quem muda.' : 'Para dar ou tirar o papel, peça a quem tem a permissão Dar e tirar papéis de pessoas.'}
        action={
          canAssign && (
            <button type="button" className="btn small primary" onClick={() => setPicking(true)}>
              <Icon name="add" />
              Dar este papel a…
            </button>
          )
        }
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
            {data.users.map((u: any) => {
              const userLock = userLockOf(grant, meId, u);
              return (
                <li key={u._id} className="rbac-people-item">
                  <button type="button" className="rbac-people-row" onClick={() => navigate(`/admin/users/edit/${u._id}`)}>
                    <UserCell username={u.username} name={u.name} sub={u.active ? undefined : 'Desativado'} />
                    <Icon name="next" />
                  </button>
                  {canAssign &&
                    (userLock ? (
                      <LockHint text={lockText(userLock)} />
                    ) : (
                      <button type="button" className="btn small ghost" onClick={() => setBulk({ mode: 'remove', userIds: [u._id] })}>
                        Tirar
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {picking && <GiveRole role={role} grant={grant} onClose={() => setPicking(false)} onPicked={(ids) => (setPicking(false), setBulk({ mode: 'add', userIds: ids }))} />}
      {bulk && <BulkRolesDialog role={role._id} mode={bulk.mode} userIds={bulk.userIds} onClose={() => setBulk(null)} onDone={done} />}
    </>
  );
}

// Escolher a quem dar o papel; pessoas travadas aparecem desativadas com o motivo.
function GiveRole({ role, grant, onClose, onPicked }: { role: RbacRole; grant: Grant; onClose: () => void; onPicked: (ids: string[]) => void }) {
  const phone = useIsPhone();
  const meId = useStore((s) => s.me?._id) ?? '';
  const [picked, setPicked] = useState<PickedUser[]>([]);
  return (
    <Modal
      size="sm"
      variant={phone ? 'sheet' : undefined}
      title={`Dar o papel ${roleLabel(role._id)} a…`}
      description="Escolha as pessoas. Antes de aplicar, você vê quem recebe e quem fica de fora."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!picked.length} onClick={() => onPicked(picked.map((u) => u._id))}>
            Revisar
          </button>
        </>
      }
    >
      <UserPicker
        value={picked}
        onChange={setPicked}
        placeholder="Buscar pessoas"
        itemDisabled={(u) => {
          if (u.roles?.includes(role._id)) return 'Já tem este papel.';
          const l = userLockOf(grant, meId, { _id: u._id, roles: u.roles });
          return l ? lockText(l) : undefined;
        }}
      />
    </Modal>
  );
}

function RoomRolePeople({ role }: { role: RbacRole }) {
  const can = usePermission(['view-user-administration', 'view-permissions', 'access-permissions', 'manage-roles']);
  return (
    <Section icon="rbac-room" title="Pessoas com este papel" count={role.users} hint="Papel de sala: vale só nas salas listadas. Para dar ou tirar, use o menu de membros da sala." flush>
      {can ? <RoomRoles role={role._id} /> : <p className="muted small rbac-empty-areas">Ver quem tem o papel pede acesso à lista de usuários.</p>}
    </Section>
  );
}
