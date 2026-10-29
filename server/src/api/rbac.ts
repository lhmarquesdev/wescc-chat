// Rotas de Papéis e permissões (RBAC): papéis com as permissões, contexto de concessão para a tela travar antes da API
// recusar, acesso efetivo de uma pessoa, papéis em massa e o histórico com reversão.
import type { FastifyInstance } from 'fastify';
import { effectiveAccess, roleDeleteLock, roleLock, userLock } from '@shared/rbac';
import { many, one, tx } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { hasAnyPermission, hasPermission, roleInfos } from '../services/permissions';
import { getHistory, historyActors, listHistory, type HistoryEntity, type HistoryRow } from '../services/rbacHistory';
import {
  assertRoleChange,
  bulkUserRoles,
  createRole,
  deleteRole,
  grantContext,
  publishUserRoles,
  rbacError,
  updateRole,
  writeUserRoles,
  type RoleInput,
} from '../services/rbac';
import { listRoles } from '../services/permissions';
import type { Ctx } from '../services/users';
import { route, str } from './http';

const b = (req: any) => req.body ?? {};
const q = (req: any) => req.query ?? {};
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []);

export const RBAC_VIEW = ['view-permissions', 'access-permissions', 'manage-roles'];
export const RBAC_WRITE = ['access-permissions', 'manage-roles'];
export const USER_ROLE_WRITE = ['edit-other-user-info', 'access-permissions', 'manage-roles'];

function roleInput(body: any): RoleInput {
  return {
    description: body.description === undefined ? undefined : String(body.description).slice(0, 500),
    scope: body.scope === 'Subscriptions' ? 'Subscriptions' : body.scope === 'Users' ? 'Users' : undefined,
    mandatory2fa: body.mandatory2fa === undefined ? undefined : !!body.mandatory2fa,
    restrictDirect: body.restrictDirect === undefined ? undefined : !!body.restrictDirect,
    permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : undefined,
    knownPermissions: Array.isArray(body.knownPermissions) ? body.knownPermissions.map(String) : undefined,
    delegable: Array.isArray(body.delegable) ? body.delegable.map(String) : undefined,
  };
}

async function visibleHistoryTypes(userId: string): Promise<HistoryEntity[]> {
  const out: HistoryEntity[] = [];
  if (await hasAnyPermission(userId, RBAC_VIEW)) out.push('role');
  if (await hasAnyPermission(userId, [...USER_ROLE_WRITE, 'view-permissions'])) out.push('user');
  return out;
}

async function assertAdminRoleAllowed(ctx: Ctx, changed: string[]) {
  const root = roleInfos().find((r) => r.root)?.id;
  if (root && changed.includes(root) && !(await hasPermission(ctx.userId, 'assign-admin-role'))) throw forbidden();
}

export function registerRbac(app: FastifyInstance) {
  route(app, 'GET', 'rbac.roles', { permissions: RBAC_VIEW }, async () => {
    const roles = await listRoles();
    const infos = new Map(roleInfos().map((r) => [r.id, r]));
    const counts = new Map(
      (
        await many<{ role: string; n: number; active: number }>(
          `SELECT r AS role, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active FROM users, unnest(roles) r GROUP BY r`,
        )
      ).map((r) => [r.role, r]),
    );
    const subs = new Map((await many<{ role: string; n: number }>(`SELECT r AS role, count(DISTINCT user_id)::int AS n FROM subscriptions, unnest(roles) r GROUP BY r`)).map((r) => [r.role, r.n]));
    return {
      roles: roles.map((r) => ({
        ...r,
        permissions: infos.get(r._id)?.permissions ?? [],
        users: r.scope === 'Users' ? (counts.get(r._id)?.n ?? 0) : (subs.get(r._id) ?? 0),
        activeUsers: r.scope === 'Users' ? (counts.get(r._id)?.active ?? 0) : (subs.get(r._id) ?? 0),
      })),
    };
  });

  // O que o ator pode fazer, para a tela travar com o motivo antes de a API recusar.
  route(app, 'GET', 'rbac.grantContext', {}, async (_req, _rep, ctx) => {
    const g = await grantContext(ctx.userId);
    const infos = roleInfos();
    return {
      ...g,
      roleLocks: Object.fromEntries(infos.map((r) => [r.id, roleLock(g, r)])),
      deleteLocks: Object.fromEntries(infos.map((r) => [r.id, roleDeleteLock(g, r)])),
      canEditPermissions: await hasPermission(ctx.userId, 'access-permissions'),
      canEditRoles: await hasAnyPermission(ctx.userId, RBAC_WRITE),
      canAssignRoles: await hasAnyPermission(ctx.userId, USER_ROLE_WRITE),
      canAssignAdmin: await hasPermission(ctx.userId, 'assign-admin-role'),
    };
  });

  route(app, 'POST', 'rbac.roles.create', { permissions: RBAC_WRITE }, async (req, _rep, ctx) => {
    const body = b(req);
    const role = await createRole(ctx, str(body.name, 'name', { max: 60 }), roleInput(body), { canEditPermissions: await hasPermission(ctx.userId, 'access-permissions') });
    return { role };
  });

  route(app, 'POST', 'rbac.roles.update', { permissions: RBAC_WRITE }, async (req, _rep, ctx) => {
    const body = b(req);
    const out = await updateRole(ctx, str(body.roleId, 'roleId'), roleInput(body), { canEditPermissions: await hasPermission(ctx.userId, 'access-permissions'), canEditRole: true });
    return { role: out.role };
  });

  route(app, 'POST', 'rbac.roles.delete', { permissions: RBAC_WRITE }, async (req, _rep, ctx) => {
    await deleteRole(ctx, str(b(req).roleId, 'roleId'));
    return {};
  });

  // Acesso efetivo de uma pessoa: o que ela pode em cada área e de qual papel vem.
  route(app, 'GET', 'rbac.users.effective', { permissions: ['view-user-administration', ...RBAC_VIEW] }, async (req, _rep, ctx) => {
    const userId = str(q(req).userId, 'userId');
    const u = await one<{ id: string; roles: string[] }>('SELECT id, roles FROM users WHERE id = $1', [userId]);
    if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
    const infos = roleInfos();
    const g = await grantContext(ctx.userId);
    return { roles: u.roles, areas: effectiveAccess(u.roles, infos), lock: userLock(g, userId, u.roles, infos) };
  });

  route(app, 'POST', 'rbac.users.setRoles', { permissions: USER_ROLE_WRITE }, async (req, _rep, ctx) => {
    const body = b(req);
    const userId = str(body.userId, 'userId');
    const roles = strList(body.roles);
    const u = await one<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1', [userId]);
    if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
    await assertRoleChange(ctx, userId, u.roles, roles);
    await assertAdminRoleAllowed(ctx, [...roles.filter((r) => !u.roles.includes(r)), ...u.roles.filter((r) => !roles.includes(r))]);
    const { row } = await writeUserRoles(null, userId, roles, { actor: ctx });
    publishUserRoles(row);
    return { roles: row.roles };
  });

  route(app, 'POST', 'rbac.users.bulkRoles', { permissions: USER_ROLE_WRITE }, async (req, _rep, ctx) => {
    const body = b(req);
    const userIds = strList(body.userIds).slice(0, 500);
    const add = strList(body.add);
    const remove = strList(body.remove);
    if (!userIds.length || (!add.length && !remove.length)) throw badRequest('error-invalid-params', 'Escolha as pessoas e os papéis.');
    await assertAdminRoleAllowed(ctx, [...add, ...remove]);
    return await bulkUserRoles(ctx, userIds, add, remove);
  });

  route(app, 'GET', 'rbac.history', {}, async (req, _rep, ctx) => {
    const types = await visibleHistoryTypes(ctx.userId);
    const want = q(req).type;
    const allowed = want ? types.filter((t) => t === want) : types;
    if (!allowed.length) throw forbidden();
    return await listHistory({ types: allowed, entityId: q(req).entityId, actor: q(req).actor, start: q(req).start, end: q(req).end, offset: Number(q(req).offset) || 0, count: Number(q(req).count) || 50 });
  });

  route(app, 'GET', 'rbac.history.actors', {}, async (_req, _rep, ctx) => {
    const types = await visibleHistoryTypes(ctx.userId);
    if (!types.length) throw forbidden();
    return { actors: await historyActors(types) };
  });

  route(app, 'GET', 'rbac.history.preview', {}, async (req, _rep, ctx) => {
    const h = await loadVisible(ctx, Number(q(req).id));
    return await planRollback(h);
  });

  route(app, 'POST', 'rbac.history.rollback', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const h = await loadVisible(ctx, Number(body.id));
    const writeKeys = h.entityType === 'role' ? RBAC_WRITE : USER_ROLE_WRITE;
    if (!(await hasAnyPermission(ctx.userId, writeKeys))) throw forbidden();
    const plan = await planRollback(h);
    const replace: Record<string, string | null> = body.replace && typeof body.replace === 'object' ? body.replace : {};
    const missing = new Set(plan.missing);
    const extra = Object.keys(replace).filter((k) => !missing.has(k));
    if (extra.length) throw badRequest('RBAC_ROLLBACK_INVALID', 'Só dá para substituir o que a prévia apontou como inexistente.', { keys: extra });
    const swap = (list: string[]) => [...new Set(list.map((x) => (missing.has(x) ? (replace[x] ?? null) : x)).filter((x): x is string => !!x))];
    try {
      await applyRollback(ctx, h, plan, swap);
    } catch (e: any) {
      if (e?.statusCode === 403) throw rbacError(403, 'RBAC_ROLLBACK_FORBIDDEN', `Reversão recusada: ${e.message}`, e.details);
      throw e;
    }
    return { ok: true };
  });
}

async function loadVisible(ctx: Ctx, id: number) {
  if (!Number.isFinite(id)) throw badRequest('error-invalid-params', 'id inválido.');
  const h = await getHistory(id);
  if (!h) throw notFound('error-not-found', 'Registro não encontrado.');
  if (!(await visibleHistoryTypes(ctx.userId)).includes(h.entityType)) throw forbidden();
  return h;
}

interface RollbackPlan {
  kind: 'delete-role' | 'recreate-role' | 'restore-role' | 'restore-user';
  // Estado atual e o que fica depois de reverter (só os campos mexidos).
  current: Record<string, unknown> | null;
  next: Record<string, unknown>;
  // Referências (papéis) que não existem mais: a pessoa escolhe substituto ou nenhum.
  missing: string[];
  blocked?: string;
}

const field = (h: HistoryRow, f: string) => h.changes.find((c) => c.field === f);
const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

// Inverso do delta: volta o que aquela versão mudou sem desfazer mudanças posteriores em outras chaves.
const invert = (current: string[], before: unknown, after: unknown) => {
  const b = arr(before);
  const a = arr(after);
  const added = a.filter((x) => !b.includes(x));
  const removed = b.filter((x) => !a.includes(x));
  return [...new Set([...current.filter((x) => !added.includes(x)), ...removed])].sort();
};

async function planRollback(h: HistoryRow): Promise<RollbackPlan> {
  if (h.rolledBackAt) return { kind: 'restore-role', current: null, next: {}, missing: [], blocked: 'Esta versão já foi revertida.' };
  const roleIds = new Set((await many<{ id: string }>('SELECT id FROM roles')).map((r) => r.id));
  if (h.entityType === 'user') {
    if (h.action === 'create') return { kind: 'restore-user', current: null, next: {}, missing: [], blocked: 'Cadastro de pessoa: para mudar os papéis, edite a pessoa.' };
    const u = await one<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1', [h.entityId]);
    if (!u) return { kind: 'restore-user', current: null, next: {}, missing: [], blocked: 'A pessoa não existe mais.' };
    const c = field(h, 'roles');
    const roles = c ? invert(u.roles, c.before, c.after) : u.roles;
    return { kind: 'restore-user', current: { roles: u.roles }, next: { roles }, missing: roles.filter((r) => !roleIds.has(r)) };
  }
  const exists = roleIds.has(h.entityId);
  if (h.action === 'create' || (h.action === 'rollback' && h.changes.every((c) => c.before === null))) {
    if (!exists) return { kind: 'delete-role', current: null, next: {}, missing: [], blocked: 'O papel já não existe.' };
    return { kind: 'delete-role', current: { id: h.entityId }, next: {}, missing: [] };
  }
  if (h.action === 'delete' || h.changes.every((c) => c.after === null)) {
    if (exists) return { kind: 'recreate-role', current: null, next: {}, missing: [], blocked: 'Já existe um papel com esse nome.' };
    const next = Object.fromEntries(h.changes.map((c) => [c.field, c.before]));
    return { kind: 'recreate-role', current: null, next, missing: arr(next.delegable).filter((r) => !roleIds.has(r)) };
  }
  if (!exists) return { kind: 'restore-role', current: null, next: {}, missing: [], blocked: 'O papel foi excluído depois desta versão.' };
  const info = roleInfos().find((r) => r.id === h.entityId)!;
  const row = await one('SELECT * FROM roles WHERE id = $1', [h.entityId]);
  const current: Record<string, unknown> = {
    description: row.description,
    scope: row.scope,
    mandatory2fa: row.mandatory_2fa,
    restrictDirect: row.restrict_direct,
    permissions: info.permissions,
    delegable: row.delegable_roles ?? [],
  };
  const next: Record<string, unknown> = {};
  for (const c of h.changes) {
    if (c.field === 'permissions' || c.field === 'delegable') next[c.field] = invert(arr(current[c.field]), c.before, c.after);
    else next[c.field] = c.before;
  }
  return { kind: 'restore-role', current, next, missing: arr(next.delegable).filter((r) => !roleIds.has(r)) };
}

async function applyRollback(ctx: Ctx, h: HistoryRow, plan: RollbackPlan, swap: (l: string[]) => string[]) {
  if (plan.blocked) throw badRequest('RBAC_ROLLBACK_BLOCKED', plan.blocked);
  const opts = { action: 'rollback' as const, revertsId: h._id };
  const canPerms = await hasPermission(ctx.userId, 'access-permissions');
  if (plan.kind === 'restore-user') {
    const roles = swap(arr(plan.next.roles));
    const before = arr(plan.current?.roles);
    await assertRoleChange(ctx, h.entityId, before, roles);
    await assertAdminRoleAllowed(ctx, [...roles.filter((r) => !before.includes(r)), ...before.filter((r) => !roles.includes(r))]);
    const row = await tx(async (c) => {
      const out = await writeUserRoles(c, h.entityId, roles, { actor: ctx, ...opts });
      await markRolledBack(c, h._id, ctx.userId);
      return out.row;
    });
    publishUserRoles(row);
    return;
  }
  if (plan.kind === 'delete-role') await deleteRole(ctx, h.entityId, opts);
  else if (plan.kind === 'recreate-role') {
    const n = plan.next;
    await createRole(
      ctx,
      h.entityId,
      { description: String(n.description ?? ''), scope: n.scope as any, mandatory2fa: !!n.mandatory2fa, restrictDirect: !!n.restrictDirect, permissions: arr(n.permissions), delegable: swap(arr(n.delegable)) },
      { canEditPermissions: canPerms, ...opts, action: 'rollback' },
    );
  } else {
    const n = plan.next;
    const input: RoleInput = {};
    if ('description' in n) input.description = String(n.description ?? '');
    if ('scope' in n) input.scope = n.scope as any;
    if ('mandatory2fa' in n) input.mandatory2fa = !!n.mandatory2fa;
    if ('restrictDirect' in n) input.restrictDirect = !!n.restrictDirect;
    if ('permissions' in n) input.permissions = arr(n.permissions);
    if ('delegable' in n) input.delegable = swap(arr(n.delegable));
    await updateRole(ctx, h.entityId, input, { canEditPermissions: canPerms, canEditRole: true, ...opts });
  }
  await markRolledBack(null, h._id, ctx.userId);
}

async function markRolledBack(db: any, id: number, by: string) {
  const sql = 'UPDATE rbac_history SET rolled_back_at = now(), rolled_back_by = $2 WHERE id = $1 AND rolled_back_at IS NULL';
  if (db) await db.query(sql, [id, by]);
  else await one(sql, [id, by]);
}
