import type { Permission, Role } from '@shared/index';
import { AREA_GROUP, KEY_AREA, RBAC_KEYS, planNewKeys, type RoleInfo } from '@shared/rbac';
import { many, one, query, tx } from '../db/pool';
import { bus } from '../realtime/bus';

// Papéis padrão. Papéis com escopo "Subscriptions" valem por sala (owner, moderator, leader, publisher).
export const DEFAULT_ROLES: Omit<Role, 'name' | 'restrictDirect'>[] = [
  { _id: 'admin', description: 'Administrador', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'user', description: 'Usuário', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'bot', description: 'Bot', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'app', description: 'App', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'guest', description: 'Convidado', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'anonymous', description: 'Anônimo', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'auditor', description: 'Auditor', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'auditor-log', description: 'Auditor de logs', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'livechat-agent', description: 'Agente de atendimento', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'livechat-manager', description: 'Gerente de atendimento', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'livechat-monitor', description: 'Monitor de atendimento', scope: 'Users', protected: true, mandatory2fa: false },
  { _id: 'owner', description: 'Dono da sala', scope: 'Subscriptions', protected: true, mandatory2fa: false },
  { _id: 'moderator', description: 'Moderador da sala', scope: 'Subscriptions', protected: true, mandatory2fa: false },
  { _id: 'leader', description: 'Líder da sala', scope: 'Subscriptions', protected: true, mandatory2fa: false },
  { _id: 'publisher', description: 'Publicador da sala', scope: 'Subscriptions', protected: true, mandatory2fa: false },
];

// Permissões padrão: saem do catálogo único (shared/rbac.ts). [id, grupo, papéis numa instalação nova]
export const DEFAULT_PERMISSIONS: [string, string, string[]][] = Object.entries(RBAC_KEYS).map(([id, k]) => [id, AREA_GROUP[KEY_AREA[id]] ?? 'legacy', [...k.defaults]]);

// Papel "Operação" (criado pela migração 013): lê canais, participa e fala em DM com quem não é restrito.
// Sem create-c/create-p/create-team/start-discussion: senão daria para abrir salas privadas entre operadores.
export const OPERACAO_PERMISSIONS = DEFAULT_PERMISSIONS.filter((p) => p[2].includes('operacao')).map((p) => p[0]);
export const PUBLISHER_PERMISSIONS = DEFAULT_PERMISSIONS.filter((p) => p[2].includes('publisher')).map((p) => p[0]);

let permCache = new Map<string, Set<string>>();
let roleScopes = new Map<string, Role['scope']>();
let restrictedRoles = new Set<string>();
let roleRows: { id: string; scope: Role['scope']; protected: boolean; is_root: boolean; delegable_roles: string[] }[] = [];

export async function loadPermissions() {
  const rows = await many<{ id: string; roles: string[] }>('SELECT id, roles FROM permissions');
  permCache = new Map(rows.map((r) => [r.id, new Set(r.roles)]));
  const roles = await many<{ id: string; scope: Role['scope']; restrict_direct: boolean; protected: boolean; is_root: boolean; delegable_roles: string[] }>(
    'SELECT id, scope, restrict_direct, protected, is_root, delegable_roles FROM roles',
  );
  roleRows = roles;
  roleScopes = new Map(roles.map((r) => [r.id, r.scope]));
  restrictedRoles = new Set(roles.filter((r) => r.restrict_direct && r.scope === 'Users').map((r) => r.id));
}

bus.onPermissions(() => void loadPermissions());

export async function seedPermissions() {
  const fresh = !(await one('SELECT 1 FROM permissions LIMIT 1'));
  for (const r of DEFAULT_ROLES) {
    await query(
      `INSERT INTO roles (id, description, scope, protected, mandatory_2fa) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [r._id, r.description, r.scope, r.protected, r.mandatory2fa],
    );
  }
  // O administrador é o papel raiz (a migração 018 marca instalações antigas; aqui, a instalação nova).
  await query(`UPDATE roles SET is_root = true WHERE id = 'admin' AND NOT is_root AND NOT EXISTS (SELECT 1 FROM roles WHERE is_root)`);
  await seedNewKeys(fresh);
  await loadPermissions();
}

// Chaves do catálogo que ainda não existem no banco nascem com os papéis do plano (planNewKeys): numa instalação que
// já existe, com quem tinha a permissão-mãe; senão com os padrões. Chave existente nunca é tocada (retirar uma chave de
// um papel é definitivo). Cada papel que ganhou chave fica no histórico, com o sistema como autor.
async function seedNewKeys(fresh: boolean) {
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727018)');
    const rows = (await c.query<{ id: string; roles: string[] }>('SELECT id, roles FROM permissions')).rows;
    const existing = new Map(rows.map((r) => [r.id, r.roles]));
    const roleIds = (await c.query<{ id: string }>('SELECT id FROM roles')).rows.map((r) => r.id);
    const plan = planNewKeys(existing, roleIds, fresh);
    if (!plan.size) return;
    const gained = new Map<string, string[]>();
    for (const [id, roles] of plan) {
      const grp = DEFAULT_PERMISSIONS.find((p) => p[0] === id)?.[1] ?? 'general';
      await c.query('INSERT INTO permissions (id, grp, roles) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, grp, roles]);
      for (const r of roles) gained.set(r, [...(gained.get(r) ?? []), id]);
    }
    if (fresh) return;
    const { recordHistory } = await import('./rbacHistory');
    for (const [role, keys] of gained) {
      const after = (await c.query<{ id: string }>('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [role])).rows.map((r) => r.id);
      const before = after.filter((k) => !keys.includes(k));
      await recordHistory(c, { entityType: 'role', entityId: role, entityLabel: role, action: 'update', source: 'system', actor: null, changes: [{ field: 'permissions', before, after }] });
    }
  });
  const missing = Object.keys(RBAC_KEYS).filter((k) => !permCache.has(k));
  await loadPermissions();
  const still = missing.filter((k) => !permCache.has(k));
  // Sem a chave, a checagem nova negaria a todos: melhor parar o boot.
  if (still.length) throw new Error(`Permissões do catálogo ausentes no banco: ${still.join(', ')}`);
}

export function rolesHavePermission(roles: Iterable<string>, permission: string): boolean {
  const allowed = permCache.get(permission);
  if (!allowed) return false;
  for (const r of roles) if (allowed.has(r)) return true;
  return false;
}

export async function getUserRoles(userId: string, rid?: string | null): Promise<string[]> {
  if (rid) {
    const r = await one<{ g: string[]; s: string[] | null }>(
      `SELECT u.roles AS g, s.roles AS s FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id AND s.room_id = $2
       WHERE u.id = $1`,
      [userId, rid],
    );
    if (!r) return [];
    return [...r.g, ...(r.s ?? [])];
  }
  const r = await one<{ roles: string[] }>('SELECT roles FROM users WHERE id = $1', [userId]);
  return r?.roles ?? [];
}

export async function hasPermission(userId: string, permission: string, rid?: string | null) {
  return rolesHavePermission(await getUserRoles(userId, rid), permission);
}

export async function hasAnyPermission(userId: string, permissions: string[], rid?: string | null) {
  const roles = await getUserRoles(userId, rid);
  return permissions.some((p) => rolesHavePermission(roles, p));
}

export async function hasRole(userId: string, role: string, rid?: string | null) {
  return (await getUserRoles(userId, rid)).includes(role);
}

// Papéis globais marcados como "Restrito em conversas diretas".
export function restrictedRoleIds(): string[] {
  return [...restrictedRoles];
}

export function rolesWithPermission(permission: string): string[] {
  return [...(permCache.get(permission) ?? [])];
}

export function permissionsForRoles(roles: string[]): string[] {
  const out: string[] = [];
  for (const [id, set] of permCache) if (roles.some((r) => set.has(r))) out.push(id);
  return out;
}

export async function listPermissions(): Promise<Permission[]> {
  const rows = await many('SELECT id, grp, roles FROM permissions ORDER BY grp, id');
  return rows.map((r) => ({ _id: r.id, group: r.grp, roles: r.roles }));
}

export async function setPermissionRoles(updates: { _id: string; roles: string[] }[]) {
  const known = new Set((await many('SELECT id FROM roles')).map((r) => r.id));
  for (const u of updates) {
    const roles = [...new Set(u.roles.filter((r) => known.has(r)))];
    await query('UPDATE permissions SET roles = $2 WHERE id = $1', [u._id, roles]);
  }
  await loadPermissions();
  bus.permissionsChanged();
}

export async function listRoles(): Promise<Role[]> {
  const rows = await many('SELECT * FROM roles ORDER BY protected DESC, id');
  return rows.map(mapRole);
}

export function mapRole(r: any): Role {
  return {
    _id: r.id,
    name: r.id,
    description: r.description,
    scope: r.scope,
    protected: r.protected,
    mandatory2fa: r.mandatory_2fa,
    restrictDirect: !!r.restrict_direct,
    root: !!r.is_root,
    delegable: r.delegable_roles ?? [],
  };
}

export function roleScope(role: string) {
  return roleScopes.get(role);
}

// Figurinhas: "Visível para" de um pacote só aceita papéis que existem (globais, por padrão).
export function roleExists(role: string, scope: Role['scope'] = 'Users'): boolean {
  return roleScopes.get(role) === scope;
}

// Papéis com as permissões de cada um, para a hierarquia de concessão e o acesso efetivo (shared/rbac.ts).
export function roleInfos(): RoleInfo[] {
  const perms = new Map<string, string[]>();
  for (const [id, set] of permCache) for (const r of set) perms.set(r, [...(perms.get(r) ?? []), id]);
  return roleRows.map((r) => ({ id: r.id, scope: r.scope, protected: r.protected, root: r.is_root, permissions: (perms.get(r.id) ?? []).sort(), delegable: r.delegable_roles ?? [] }));
}
