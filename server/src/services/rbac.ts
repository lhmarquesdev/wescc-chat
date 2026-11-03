// Papéis e permissões no modelo RBAC: hierarquia de concessão, gravação de papéis e dos papéis de cada pessoa, sempre
// com o histórico na mesma transação. As regras puras ficam em shared/rbac.ts (a tela usa as mesmas).
import type pg from 'pg';
import {
  applyDelta,
  grantContextFor,
  keysNotHeld,
  LOCK_TEXT,
  RBAC_KEYS,
  roleDeleteLock,
  roleLock,
  ROOT_KEEP,
  userLock,
  type GrantContext,
  type LockReason,
  type RoleInfo,
} from '@shared/rbac';
import { many, one, tx } from '../db/pool';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { getUserRoles, loadPermissions, mapRole, roleInfos, rolesIncludeRoot } from './permissions';
import { recordHistory, type HistorySource } from './rbacHistory';
import type { Ctx } from './users';

export const rbacError = (status: number, code: string, msg: string, details?: Record<string, unknown>) => new ApiError(status, code, msg, details);

// Permissões que o papel raiz nunca perde (do catálogo): sem elas ninguém mais administraria nem daria papéis.
export { ROOT_KEEP };

// Tem o papel raiz (pela flag is_root, não pelo id 'admin').
export async function isRootUser(userId: string): Promise<boolean> {
  return rolesIncludeRoot(await getUserRoles(userId));
}

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
  // Papel de sala (Dono, Moderador…) não vira papel global: ele valeria em todas as salas.
  const roomScoped = after.filter((r) => !before.includes(r) && infos.find((x) => x.id === r)?.scope === 'Subscriptions');
  if (roomScoped.length) throw badRequest('error-invalid-role', `Papel de sala não vale como papel global: ${roomScoped.join(', ')}`);
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

export type BulkBlockReason = Exclude<LockReason, null | 'own-role' | 'protected'> | 'self' | 'not-assignable' | 'last-admin';
interface BulkPerson {
  _id: string;
  username: string;
}

// Ação em massa: dá e tira papéis de várias pessoas, com um batch_id no histórico. A prévia (dryRun) diz quem muda,
// quem já está assim e quem fica de fora e por quê. Sem skipBlocked é tudo ou nada (o erro de hoje); com skipBlocked
// grava só quem pode e conta quem ficou de fora.
export async function bulkUserRoles(ctx: Ctx, userIds: string[], add: string[], remove: string[], opts: { dryRun?: boolean; skipBlocked?: boolean } = {}) {
  const g = await grantContext(ctx.userId);
  const infos = roleInfos();
  const known = new Set(infos.map((r) => r.id));
  const badRoles = [...add, ...remove].filter((r) => !known.has(r));
  if (badRoles.length) throw badRequest('error-invalid-role', `Papel inexistente: ${badRoles.join(', ')}`);
  const roomScoped = add.filter((r) => infos.find((x) => x.id === r)?.scope === 'Subscriptions');
  if (roomScoped.length) throw badRequest('error-invalid-role', `Papel de sala não vale como papel global: ${roomScoped.join(', ')}`);
  const users = await many<{ id: string; username: string; roles: string[]; active: boolean }>('SELECT id, username, roles, active FROM users WHERE id = ANY($1) ORDER BY username', [userIds]);
  if (users.length !== new Set(userIds).size) throw badRequest('error-invalid-user', 'Usuário não encontrado.');
  const root = infos.find((r) => r.root)?.id;
  const ok: (BulkPerson & { next: string[]; roles: string[] })[] = [];
  const unchanged: BulkPerson[] = [];
  const blocked: (BulkPerson & { reason: BulkBlockReason; roles?: string[]; idle?: boolean })[] = [];
  // Quantos administradores ativos sobram se tirar o papel raiz de todos os escolhidos.
  let activeRoots = root ? Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE $1 = ANY(roles) AND active`, [root]))?.n ?? 0) : 0;
  for (const u of users) {
    const next = [...new Set([...u.roles.filter((r) => !remove.includes(r)), ...add])];
    const person = { _id: u.id, username: u.username };
    const changed = [...next.filter((r) => !u.roles.includes(r)), ...u.roles.filter((r) => !next.includes(r))];
    // Pessoa com cadeado fica de fora mesmo quando nada mudaria nela (a prévia mostra o motivo); só a que mudaria
    // trava o "tudo ou nada".
    const lock = userLock(g, u.id, u.roles, infos);
    if (lock) {
      blocked.push({ ...person, reason: lock === 'own-role' || lock === 'protected' ? 'superior' : lock, ...(changed.length ? {} : { idle: true }) });
      continue;
    }
    if (!changed.length) {
      unchanged.push(person);
      continue;
    }
    const locked = changed.filter((id) => {
      const r = infos.find((x) => x.id === id);
      return r && roleLock(g, r);
    });
    if (locked.length) {
      blocked.push({ ...person, reason: 'not-assignable', roles: locked });
      continue;
    }
    if (root && u.active && u.roles.includes(root) && !next.includes(root)) {
      if (activeRoots <= 1) {
        blocked.push({ ...person, reason: 'last-admin' });
        continue;
      }
      activeRoots--;
    }
    ok.push({ ...person, next, roles: u.roles });
  }
  if (opts.dryRun) return { ok: ok.map(({ _id, username }) => ({ _id, username })), blocked: blocked.map(({ idle: _, ...b }) => b), unchanged };
  const stuck = blocked.filter((b) => !b.idle);
  if (stuck.length && !opts.skipBlocked) {
    // O mesmo erro de antes (tudo ou nada), na ordem: pessoa travada, papel travado, último administrador.
    const first = stuck[0];
    const u = users.find((x) => x.id === first._id)!;
    const next = [...new Set([...u.roles.filter((r) => !remove.includes(r)), ...add])];
    if (first.reason === 'last-admin') throw badRequest('error-action-not-allowed', 'Não é possível remover o último administrador.');
    await assertRoleChange(ctx, u.id, u.roles, next, g);
    throw lockError('superior', 'RBAC_TARGET_SUPERIOR', { userId: u.id });
  }
  if (!ok.length) return { batchId: null, users: 0, skipped: blocked.length };
  const batchId = newId();
  const rows = await tx(async (c) => {
    const out = [];
    for (const p of ok) out.push((await writeUserRoles(c, p._id, p.next, { actor: ctx, action: 'bulk', batchId })).row);
    return out;
  });
  rows.forEach(publishUserRoles);
  return { batchId, users: rows.length, skipped: blocked.length };
}

// ---------- Papéis ----------

export interface RoleInput {
  description?: string;
  // "Para que serve": uma frase simples que a tela mostra embaixo do nome.
  purpose?: string;
  scope?: 'Users' | 'Subscriptions';
  mandatory2fa?: boolean;
  restrictDirect?: boolean;
  permissions?: string[];
  // O catálogo que a tela tinha ao abrir: chaves atuais fora dele são mantidas (uma aba antiga não apaga chave nova).
  knownPermissions?: string[];
  // As permissões que a tela tinha ao abrir o papel: grava só a diferença (base → permissions) sobre o estado atual, e
  // o que outra pessoa salvou nesse meio-tempo em outras chaves fica. Substitui knownPermissions.
  basePermissions?: string[];
  delegable?: string[];
}

const RESTRICT_GLOBAL_ONLY = 'Só papéis globais podem ser restritos em conversas diretas.';

function roleFields(r: any, permissions: string[]) {
  return {
    description: r.description,
    purpose: r.purpose ?? '',
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
      await c.query('INSERT INTO roles (id, description, purpose, scope, protected, mandatory_2fa, restrict_direct, delegable_roles) VALUES ($1,$2,$3,$4,false,$5,$6,$7) RETURNING *', [
        name,
        String(input.description ?? ''),
        String(input.purpose ?? '').slice(0, 200),
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
  await afterRoleChange({ roles: [name], by: ctx.userId });
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
      if (input.basePermissions) after = applyDelta(before, input.basePermissions, input.permissions);
      else {
        const requested = new Set(input.permissions);
        const known = new Set(input.knownPermissions ?? [...Object.keys(RBAC_KEYS), ...before]);
        after = [...new Set([...requested, ...before.filter((k) => !known.has(k))])].sort();
      }
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

    const purpose = input.purpose === undefined ? undefined : String(input.purpose).slice(0, 200);
    const meta = { description: input.description, purpose, mandatory2fa: input.mandatory2fa, scope: existing.protected ? undefined : input.scope, restrictDirect: input.restrictDirect };
    const metaChanged =
      (meta.description !== undefined && meta.description !== existing.description) ||
      (meta.purpose !== undefined && meta.purpose !== (existing.purpose ?? '')) ||
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
           restrict_direct = COALESCE($5, restrict_direct), delegable_roles = $6, purpose = COALESCE($7, purpose)
         WHERE id = $1 RETURNING *`,
        [id, meta.description ?? null, meta.mandatory2fa ?? null, meta.scope ?? null, meta.restrictDirect ?? null, delegable, meta.purpose ?? null],
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
    return { row, historyId, permissions: after };
  });
  await afterRoleChange({ roles: [id], by: ctx.userId });
  return { role: mapRole(out.row), permissions: out.permissions, historyId: out.historyId };
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
  await afterRoleChange({ roles: [id], by: ctx.userId });
}

// ---------- Várias permissões em vários papéis (matriz) ----------

export interface PermissionDelta {
  roleId: string;
  add: string[];
  remove: string[];
}

// O único caminho para mexer em permissões de vários papéis de uma vez (matriz e permissions.update do Rocket.Chat):
// lê cada papel do banco travado (FOR UPDATE, em ordem de id para duas matrizes não se travarem), aplica só o que
// entra e sai, confere a hierarquia de concessão de cada papel e grava tudo ou nada, com um lote no histórico.
export async function applyPermissionDeltas(ctx: Ctx, changes: PermissionDelta[]): Promise<{ roles: { _id: string; permissions: string[] }[]; batchId: string | null }> {
  if (!changes.length) throw badRequest('error-invalid-params', 'Nenhuma alteração.');
  const merged = new Map<string, { add: Set<string>; remove: Set<string> }>();
  for (const ch of changes) {
    const m = merged.get(ch.roleId) ?? { add: new Set(), remove: new Set() };
    ch.add.forEach((k) => m.add.add(k));
    ch.remove.forEach((k) => m.remove.add(k));
    merged.set(ch.roleId, m);
  }
  if (merged.size > 50) throw badRequest('error-invalid-params', 'Até 50 papéis por vez.');
  for (const m of merged.values()) if ([...m.add].some((k) => m.remove.has(k))) throw badRequest('error-invalid-params', 'A mesma permissão não pode entrar e sair do mesmo papel.');
  const known = new Set((await many<{ id: string }>('SELECT id FROM roles')).map((r) => r.id));
  for (const id of merged.keys()) if (!known.has(id)) throw notFound('error-invalid-roleId', `Papel não encontrado: ${id}.`);
  await assertKnownKeys([...new Set([...merged.values()].flatMap((m) => [...m.add]))]);
  const g = await grantContext(ctx.userId);
  const ids = [...merged.keys()].sort();
  const plan: { id: string; before: string[]; after: string[] }[] = [];
  const batchId = await tx(async (c) => {
    for (const id of ids) {
      const row = (await c.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const before = await rolePermissions(c, id);
      const m = merged.get(id)!;
      const after = [...new Set([...before.filter((k) => !m.remove.has(k)), ...m.add])].sort();
      if (after.length === before.length && after.every((k, i) => k === before[i])) continue;
      const info: RoleInfo = { id, scope: row.scope, protected: row.protected, root: row.is_root, permissions: before, delegable: row.delegable_roles ?? [] };
      const lock = roleLock(g, info);
      if (lock) throw lockError(lock, 'RBAC_ROLE_SUPERIOR', { roleId: id });
      const notHeld = keysNotHeld(g, before, after);
      if (notHeld.length) throw rbacError(403, 'RBAC_PERMISSION_NOT_HELD', 'Você só dá ou tira permissões que você tem.', { keys: notHeld, roleId: id });
      const lost = row.is_root ? ROOT_KEEP.filter((k) => before.includes(k) && !after.includes(k)) : [];
      if (lost.length) throw rbacError(400, 'RBAC_ROOT_LOCKOUT', 'O papel Administrador não pode perder a gestão de papéis.', { keys: lost, roleId: id });
      plan.push({ id, before, after });
    }
    const batch = plan.length > 1 ? newId() : null;
    for (const p of plan) {
      await setRolePermissions(c, p.id, p.before, p.after);
      await recordHistory(c, { entityType: 'role', entityId: p.id, action: 'update', actor: actorOfCtx(ctx), batchId: batch, changes: [{ field: 'permissions', before: p.before, after: p.after }] });
    }
    return batch;
  });
  if (plan.length) await afterRoleChange({ roles: plan.map((p) => p.id), by: ctx.userId });
  return { roles: plan.map((p) => ({ _id: p.id, permissions: p.after })), batchId };
}

// Compatibilidade com a API do Rocket.Chat (permissions.update): cada permissão com a lista de papéis. Vira, por papel,
// o que entra e sai contra o estado atual, e segue o mesmo caminho da matriz (mesmas regras, mesmo histórico).
export async function updatePermissionMatrix(ctx: Ctx, updates: { _id: string; roles: string[] }[]) {
  await assertKnownKeys(updates.map((u) => u._id));
  const known = new Set(roleInfos().map((r) => r.id));
  const current = new Map((await many<{ id: string; roles: string[] }>('SELECT id, roles FROM permissions')).map((r) => [r.id, r.roles]));
  const perRole = new Map<string, PermissionDelta>();
  const delta = (id: string) => perRole.get(id) ?? (perRole.set(id, { roleId: id, add: [], remove: [] }), perRole.get(id)!);
  for (const u of updates) {
    const next = new Set(u.roles.filter((r) => known.has(r)));
    const prev = new Set(current.get(u._id) ?? []);
    for (const r of next) if (!prev.has(r)) delta(r).add.push(u._id);
    for (const r of prev) if (!next.has(r) && known.has(r)) delta(r).remove.push(u._id);
  }
  if (!perRole.size) return { roles: [], batchId: null };
  return applyPermissionDeltas(ctx, [...perRole.values()]);
}

async function afterRoleChange(meta: { roles?: string[]; by?: string } = {}) {
  const { invalidateMandatory2faCache } = await import('./users');
  invalidateMandatory2faCache();
  await loadPermissions();
  bus.permissionsChanged(meta);
}

export { roleInfo };
