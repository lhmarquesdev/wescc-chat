// Papéis e permissões no modelo RBAC: hierarquia de concessão, gravação de papéis e dos papéis de cada pessoa, sempre
// com o histórico na mesma transação. As regras puras ficam em shared/rbac.ts (a tela usa as mesmas).
import type pg from 'pg';
import {
  grantContextFor,
  keysNotHeld,
  LOCK_TEXT,
  RBAC_KEYS,
  roleDeleteLock,
  roleLock,
  userLock,
  type GrantContext,
  type RoleInfo,
} from '@shared/rbac';
import { many, one, tx } from '../db/pool';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { getUserRoles, loadPermissions, mapRole, roleInfos } from './permissions';
import { recordHistory, type HistorySource } from './rbacHistory';
import type { Ctx } from './users';

export const rbacError = (status: number, code: string, msg: string, details?: Record<string, unknown>) => new ApiError(status, code, msg, details);

// Permissões que o papel raiz nunca perde: sem elas ninguém mais administraria os papéis.
export const ROOT_KEEP = ['view-permissions', 'access-permissions', 'manage-roles'];

export async function grantContext(userId: string): Promise<GrantContext> {
  return grantContextFor(userId, await getUserRoles(userId), roleInfos());
}

const actorOfCtx = (ctx: Ctx | null) => (ctx ? { id: ctx.userId, username: ctx.username } : null);

function roleInfo(id: string): RoleInfo | undefined {
  return roleInfos().find((r) => r.id === id);
}

function lockError(lock: string, fallbackCode: string, details?: Record<string, unknown>) {
  const code = lock === 'root-only' ? 'RBAC_ADMIN_ONLY' : lock === 'self' ? 'RBAC_SELF_ESCALATION' : lock === 'own-role' ? 'RBAC_SELF_ESCALATION' : fallbackCode;
  return rbacError(403, code, LOCK_TEXT[lock as keyof typeof LOCK_TEXT] ?? 'Sem permissão para esta ação.', details);
}

// ---------- Pessoas ----------

// Alterar, excluir ou agir sobre outra pessoa exige que todos os papéis dela sejam gerenciáveis pelo ator.
export async function assertCanManageUser(ctx: Ctx, targetId: string, opts: { allowSelf?: boolean } = {}) {
  if (opts.allowSelf !== false && targetId === ctx.userId) return;
  const g = await grantContext(ctx.userId);
  const target = await one<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1', [targetId]);
  if (!target) return;
  const lock = userLock(g, targetId, target.roles, roleInfos());
  if (lock) throw lockError(lock, 'RBAC_TARGET_SUPERIOR', { userId: targetId });
}

// Confere a troca de papéis globais de uma pessoa: ninguém mexe nos próprios papéis, a pessoa precisa ser
// gerenciável e cada papel que entra ou sai também.
export async function assertRoleChange(ctx: Ctx, targetId: string, before: string[], after: string[], g?: GrantContext) {
  g ??= await grantContext(ctx.userId);
  const infos = roleInfos();
  const known = new Set(infos.map((r) => r.id));
  const bad = after.filter((r) => !known.has(r));
  if (bad.length) throw badRequest('error-invalid-role', `Papel inexistente: ${bad.join(', ')}`);
  const changed = [...after.filter((r) => !before.includes(r)), ...before.filter((r) => !after.includes(r))];
  if (!changed.length) return;
  const lock = userLock(g, targetId, before, infos);
  if (lock) throw lockError(lock, 'RBAC_TARGET_SUPERIOR', { userId: targetId });
  const locked = changed.filter((id) => {
    const r = infos.find((x) => x.id === id);
    return r && roleLock(g!, r);
  });
  if (locked.length) throw rbacError(403, 'RBAC_ROLE_NOT_ASSIGNABLE', `Você não pode dar nem tirar: ${locked.join(', ')}.`, { roles: locked });
}

// Grava os papéis globais de uma pessoa (com o histórico). Quem chama já conferiu a hierarquia quando é uma pessoa
// agindo (assertRoleChange); sincronizações (LDAP, OAuth, SAML) passam source e actor null.
export async function writeUserRoles(
  db: pg.PoolClient | null,
  userId: string,
  next: string[],
  opts: { actor: Ctx | null; source?: HistorySource; batchId?: string | null; action?: 'update' | 'bulk' | 'rollback'; revertsId?: number | null },
) {
  const run = async (c: pg.PoolClient) => {
    const u = (await c.query('SELECT id, username, roles FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
    const roles = [...new Set(next)];
    const final = roles.length ? roles : ['user'];
    const root = roleInfos().find((r) => r.root)?.id;
    if (root && u.roles.includes(root) && !final.includes(root)) {
      const n = (await c.query(`SELECT count(*)::int AS n FROM users WHERE $1 = ANY(roles) AND active AND id <> $2`, [root, userId])).rows[0].n;
      if (n < 1) throw badRequest('error-action-not-allowed', 'Não é possível remover o último administrador.');
    }
    const row = (await c.query('UPDATE users SET roles = $2, updated_at = now() WHERE id = $1 RETURNING id, username, roles', [userId, final])).rows[0];
    const historyId = await recordHistory(c, {
      entityType: 'user',
      entityId: userId,
      entityLabel: u.username,
      action: opts.action ?? 'update',
      source: opts.source ?? 'manual',
      actor: actorOfCtx(opts.actor),
      batchId: opts.batchId,
      revertsId: opts.revertsId,
      changes: [{ field: 'roles', before: u.roles, after: final }],
    });
    return { row, historyId, before: u.roles as string[] };
  };
  const out = db ? await run(db) : await tx(run);
  return out;
}

export function publishUserRoles(user: { id: string; username: string; roles: string[] }) {
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: { _id: user.id, username: user.username, roles: user.roles } });
}

// Ação em massa: dá e tira papéis de várias pessoas, tudo ou nada, com um batch_id no histórico.
export async function bulkUserRoles(ctx: Ctx, userIds: string[], add: string[], remove: string[]) {
  const g = await grantContext(ctx.userId);
  const users = await many<{ id: string; username: string; roles: string[] }>('SELECT id, username, roles FROM users WHERE id = ANY($1)', [userIds]);
  if (users.length !== new Set(userIds).size) throw badRequest('error-invalid-user', 'Usuário não encontrado.');
  const plan = users.map((u) => ({ u, next: [...new Set([...u.roles.filter((r) => !remove.includes(r)), ...add])] }));
  for (const p of plan) await assertRoleChange(ctx, p.u.id, p.u.roles, p.next, g);
  const batchId = newId();
  const rows = await tx(async (c) => {
    const out = [];
    for (const p of plan) out.push((await writeUserRoles(c, p.u.id, p.next, { actor: ctx, action: 'bulk', batchId })).row);
    return out;
  });
  rows.forEach(publishUserRoles);
  return { batchId, users: rows.length };
}

// ---------- Papéis ----------

export interface RoleInput {
  description?: string;
  scope?: 'Users' | 'Subscriptions';
  mandatory2fa?: boolean;
  restrictDirect?: boolean;
  permissions?: string[];
  // O catálogo que a tela tinha ao abrir: chaves atuais fora dele são mantidas (uma aba antiga não apaga chave nova).
  knownPermissions?: string[];
  delegable?: string[];
}

const RESTRICT_GLOBAL_ONLY = 'Só papéis globais podem ser restritos em conversas diretas.';

function roleFields(r: any, permissions: string[]) {
  return {
    description: r.description,
    scope: r.scope,
    mandatory2fa: r.mandatory_2fa,
    restrictDirect: !!r.restrict_direct,
    permissions: [...permissions].sort(),
    delegable: [...(r.delegable_roles ?? [])].sort(),
  };
}

async function rolePermissions(c: pg.PoolClient, id: string) {
  return (await c.query<{ id: string }>('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [id])).rows.map((r) => r.id);
}

async function setRolePermissions(c: pg.PoolClient, id: string, before: string[], after: string[]) {
  const add = after.filter((k) => !before.includes(k));
  const del = before.filter((k) => !after.includes(k));
  if (add.length) await c.query('UPDATE permissions SET roles = array_append(roles, $1) WHERE id = ANY($2) AND NOT ($1 = ANY(roles))', [id, add]);
  if (del.length) await c.query('UPDATE permissions SET roles = array_remove(roles, $1) WHERE id = ANY($2)', [id, del]);
}

async function validateDelegable(list: string[], self: string) {
  const infos = roleInfos();
  for (const id of list) {
    const r = infos.find((x) => x.id === id);
    if (!r) throw badRequest('error-invalid-role', `Papel inexistente: ${id}`);
    if (r.root || r.scope !== 'Users' || id === self) throw badRequest('RBAC_DELEGATION_INVALID', 'A delegação só aceita outros papéis globais (nunca o Administrador).');
  }
}

async function assertKnownKeys(keys: string[]) {
  const all = new Set((await many<{ id: string }>('SELECT id FROM permissions')).map((r) => r.id));
  const bad = keys.filter((k) => !all.has(k));
  if (bad.length) throw badRequest('error-invalid-permission', `Permissão inexistente: ${bad.join(', ')}`);
}

export async function createRole(ctx: Ctx, name: string, input: RoleInput, opts: { canEditPermissions: boolean; batchId?: string; revertsId?: number | null; action?: 'create' | 'rollback' }) {
  if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw badRequest('error-invalid-role-name', 'Nome de papel inválido.');
  if (name.toLowerCase() === 'admin') throw rbacError(400, 'RBAC_RESERVED_ROLE_NAME', 'O nome admin é reservado.');
  if (await one('SELECT 1 FROM roles WHERE lower(id) = lower($1)', [name])) throw badRequest('error-duplicate-role-names-not-allowed', 'Já existe um papel com esse nome.');
  const scope = input.scope === 'Subscriptions' ? 'Subscriptions' : 'Users';
  const restrictDirect = !!input.restrictDirect;
  if (restrictDirect && scope !== 'Users') throw badRequest('error-invalid-params', RESTRICT_GLOBAL_ONLY);
  const g = await grantContext(ctx.userId);
  const permissions = [...new Set(input.permissions ?? [])];
  if (permissions.length) {
    if (!opts.canEditPermissions) throw rbacError(403, 'error-not-allowed', 'Sem permissão para alterar permissões.');
    await assertKnownKeys(permissions);
    const notHeld = keysNotHeld(g, [], permissions);
    if (notHeld.length) throw rbacError(403, 'RBAC_PERMISSION_NOT_HELD', 'Você só dá permissões que você tem.', { keys: notHeld });
  }
  const delegable = [...new Set(input.delegable ?? [])];
  if (delegable.length) {
    if (!g.root) throw rbacError(403, 'RBAC_DELEGATION_ADMIN_ONLY', 'Só um administrador define delegações.');
    await validateDelegable(delegable, name);
  }
  const row = await tx(async (c) => {
    const row = (
      await c.query('INSERT INTO roles (id, description, scope, protected, mandatory_2fa, restrict_direct, delegable_roles) VALUES ($1,$2,$3,false,$4,$5,$6) RETURNING *', [
        name,
        String(input.description ?? ''),
        scope,
        !!input.mandatory2fa,
        restrictDirect,
        delegable,
      ])
    ).rows[0];
    await setRolePermissions(c, name, [], permissions);
    const f = roleFields(row, permissions);
    await recordHistory(c, {
      entityType: 'role',
      entityId: name,
      action: opts.action ?? 'create',
      actor: actorOfCtx(ctx),
      batchId: opts.batchId,
      revertsId: opts.revertsId,
      changes: Object.entries(f).map(([field, after]) => ({ field, before: null, after })),
    });
    return row;
  });
  await afterRoleChange();
  return mapRole(row);
}

export async function updateRole(ctx: Ctx, id: string, input: RoleInput, opts: { canEditPermissions: boolean; canEditRole: boolean; action?: 'update' | 'rollback'; revertsId?: number | null; batchId?: string }) {
  const g = await grantContext(ctx.userId);
  const out = await tx(async (c) => {
    const existing = (await c.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!existing) throw notFound('error-invalid-roleId', 'Papel não encontrado.');
    const before = await rolePermissions(c, id);
    const info: RoleInfo = { id, scope: existing.scope, protected: existing.protected, root: existing.is_root, permissions: before, delegable: existing.delegable_roles ?? [] };
    const lock = roleLock(g, info);
    if (lock) throw lockError(lock, 'RBAC_ROLE_SUPERIOR', { roleId: id });

    let after = before;
    if (input.permissions) {
      const requested = new Set(input.permissions);
      const known = new Set(input.knownPermissions ?? [...Object.keys(RBAC_KEYS), ...before]);
      after = [...new Set([...requested, ...before.filter((k) => !known.has(k))])].sort();
      const changed = after.length !== before.length || after.some((k) => !before.includes(k));
      if (changed) {
        if (!opts.canEditPermissions) throw rbacError(403, 'error-not-allowed', 'Sem permissão para alterar permissões.');
        await assertKnownKeys(after.filter((k) => !before.includes(k)));
        const notHeld = keysNotHeld(g, before, after);
        if (notHeld.length) throw rbacError(403, 'RBAC_PERMISSION_NOT_HELD', 'Você só dá ou tira permissões que você tem.', { keys: notHeld });
        const lost = existing.is_root ? ROOT_KEEP.filter((k) => before.includes(k) && !after.includes(k)) : [];
        if (lost.length) throw rbacError(400, 'RBAC_ROOT_LOCKOUT', 'O papel Administrador não pode perder a gestão de papéis.', { keys: lost });
      } else after = before;
    }

    const meta = { description: input.description, mandatory2fa: input.mandatory2fa, scope: existing.protected ? undefined : input.scope, restrictDirect: input.restrictDirect };
    const metaChanged =
      (meta.description !== undefined && meta.description !== existing.description) ||
      (meta.mandatory2fa !== undefined && meta.mandatory2fa !== existing.mandatory_2fa) ||
      (meta.scope !== undefined && meta.scope !== existing.scope) ||
      (meta.restrictDirect !== undefined && meta.restrictDirect !== existing.restrict_direct);
    if (metaChanged && !opts.canEditRole) throw rbacError(403, 'error-not-allowed', 'Sem permissão para editar papéis.');
    const scope = meta.scope ?? existing.scope;
    if ((meta.restrictDirect ?? existing.restrict_direct) && scope !== 'Users') throw badRequest('error-invalid-params', RESTRICT_GLOBAL_ONLY);

    let delegable: string[] = existing.delegable_roles ?? [];
    if (input.delegable) {
      const next = [...new Set(input.delegable)].sort();
      const same = next.length === delegable.length && next.every((x, i) => x === [...delegable].sort()[i]);
      if (!same) {
        if (!g.root) throw rbacError(403, 'RBAC_DELEGATION_ADMIN_ONLY', 'Só um administrador define delegações.');
        if (existing.is_root) throw badRequest('RBAC_DELEGATION_INVALID', 'O Administrador já pode tudo; não precisa de delegação.');
        await validateDelegable(next, id);
        delegable = next;
      }
    }

    const row = (
      await c.query(
        `UPDATE roles SET description = COALESCE($2, description), mandatory_2fa = COALESCE($3, mandatory_2fa), scope = COALESCE($4, scope),
           restrict_direct = COALESCE($5, restrict_direct), delegable_roles = $6
         WHERE id = $1 RETURNING *`,
        [id, meta.description ?? null, meta.mandatory2fa ?? null, meta.scope ?? null, meta.restrictDirect ?? null, delegable],
      )
    ).rows[0];
    await setRolePermissions(c, id, before, after);
    const fb = roleFields(existing, before);
    const fa = roleFields(row, after);
    const historyId = await recordHistory(c, {
      entityType: 'role',
      entityId: id,
      action: opts.action ?? 'update',
      actor: actorOfCtx(ctx),
      batchId: opts.batchId,
      revertsId: opts.revertsId,
      changes: (Object.keys(fa) as (keyof typeof fa)[]).map((field) => ({ field, before: fb[field], after: fa[field] })),
    });
    return { row, historyId };
  });
  await afterRoleChange();
  return { role: mapRole(out.row), historyId: out.historyId };
}

export async function deleteRole(ctx: Ctx, id: string, opts: { action?: 'delete' | 'rollback'; revertsId?: number | null; batchId?: string } = {}) {
  const g = await grantContext(ctx.userId);
  await tx(async (c) => {
    const role = (await c.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!role) throw notFound('error-invalid-roleId', 'Papel não encontrado.');
    const permissions = await rolePermissions(c, id);
    const info: RoleInfo = { id, scope: role.scope, protected: role.protected, root: role.is_root, permissions, delegable: role.delegable_roles ?? [] };
    const lock = roleDeleteLock(g, info);
    if (lock === 'protected') throw badRequest('error-role-protected', 'Papéis do sistema não podem ser excluídos.');
    if (lock) throw lockError(lock, 'RBAC_ROLE_SUPERIOR', { roleId: id });
    const inUse = (await c.query(`SELECT (SELECT count(*) FROM users WHERE $1 = ANY(roles)) + (SELECT count(*) FROM subscriptions WHERE $1 = ANY(roles)) AS n`, [id])).rows[0];
    if (Number(inUse.n) > 0) throw badRequest('error-role-in-use', 'O papel ainda está atribuído a usuários.', { users: Number(inUse.n) });
    const batchId = opts.batchId ?? newId();
    // Outros papéis que delegavam este deixam de delegar (fica no histórico deles também).
    const delegators = (await c.query('SELECT id, delegable_roles FROM roles WHERE $1 = ANY(delegable_roles)', [id])).rows;
    for (const d of delegators) {
      const next = (d.delegable_roles as string[]).filter((x) => x !== id);
      await c.query('UPDATE roles SET delegable_roles = $2 WHERE id = $1', [d.id, next]);
      await recordHistory(c, { entityType: 'role', entityId: d.id, action: 'update', actor: actorOfCtx(ctx), batchId, changes: [{ field: 'delegable', before: d.delegable_roles, after: next }] });
    }
    await c.query('DELETE FROM roles WHERE id = $1', [id]);
    await c.query('UPDATE permissions SET roles = array_remove(roles, $1) WHERE $1 = ANY(roles)', [id]);
    const f = roleFields(role, permissions);
    await recordHistory(c, {
      entityType: 'role',
      entityId: id,
      action: opts.action ?? 'delete',
      actor: actorOfCtx(ctx),
      batchId,
      revertsId: opts.revertsId,
      changes: Object.entries(f).map(([field, before]) => ({ field, before, after: null })),
    });
  });
  await afterRoleChange();
}

// Compatibilidade com a API do Rocket.Chat (permissions.update): cada permissão com a lista de papéis. Vira, por papel,
// a mesma checagem e o mesmo histórico do editor.
export async function updatePermissionMatrix(ctx: Ctx, updates: { _id: string; roles: string[] }[]) {
  const g = await grantContext(ctx.userId);
  const infos = roleInfos();
  const known = new Set(infos.map((r) => r.id));
  await assertKnownKeys(updates.map((u) => u._id));
  const current = new Map((await many<{ id: string; roles: string[] }>('SELECT id, roles FROM permissions')).map((r) => [r.id, r.roles]));
  const perRole = new Map<string, { before: Set<string>; after: Set<string> }>();
  const roleSets = (id: string) => {
    if (!perRole.has(id)) {
      const p = infos.find((r) => r.id === id)!.permissions;
      perRole.set(id, { before: new Set(p), after: new Set(p) });
    }
    return perRole.get(id)!;
  };
  for (const u of updates) {
    const next = new Set(u.roles.filter((r) => known.has(r)));
    const prev = new Set(current.get(u._id) ?? []);
    for (const r of new Set([...next, ...prev])) {
      if (next.has(r) === prev.has(r)) continue;
      const s = roleSets(r);
      if (next.has(r)) s.after.add(u._id);
      else s.after.delete(u._id);
    }
  }
  for (const [id, s] of perRole) {
    const lock = roleLock(g, infos.find((r) => r.id === id)!);
    if (lock) throw lockError(lock, 'RBAC_ROLE_SUPERIOR', { roleId: id });
    const notHeld = keysNotHeld(g, s.before, s.after);
    if (notHeld.length) throw rbacError(403, 'RBAC_PERMISSION_NOT_HELD', 'Você só dá ou tira permissões que você tem.', { keys: notHeld, roleId: id });
    if (infos.find((r) => r.id === id)!.root) {
      const lost = ROOT_KEEP.filter((k) => s.before.has(k) && !s.after.has(k));
      if (lost.length) throw rbacError(400, 'RBAC_ROOT_LOCKOUT', 'O papel Administrador não pode perder a gestão de papéis.', { keys: lost });
    }
  }
  const batchId = perRole.size > 1 ? newId() : null;
  await tx(async (c) => {
    for (const [id, s] of perRole) {
      await setRolePermissions(c, id, [...s.before], [...s.after]);
      await recordHistory(c, { entityType: 'role', entityId: id, action: 'update', actor: actorOfCtx(ctx), batchId, changes: [{ field: 'permissions', before: [...s.before], after: [...s.after] }] });
    }
  });
  await afterRoleChange();
}

async function afterRoleChange() {
  const { invalidateMandatory2faCache } = await import('./users');
  invalidateMandatory2faCache();
  await loadPermissions();
  bus.permissionsChanged();
}

export { roleInfo };
