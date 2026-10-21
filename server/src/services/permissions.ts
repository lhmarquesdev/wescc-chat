import type { Permission, Role } from '@shared/index';
import { many, one, query } from '../db/pool';
import { bus } from '../realtime/bus';

// Papéis padrão. Papéis com escopo "Subscriptions" valem por sala (owner, moderator, leader).
export const DEFAULT_ROLES: Omit<Role, 'name'>[] = [
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
];

const A = 'admin';
const O = 'owner';
const M = 'moderator';
const U = 'user';
const B = 'bot';
const G = 'guest';

// [id, grupo, papéis padrão]
export const DEFAULT_PERMISSIONS: [string, string, string[]][] = [
  // Administração
  ['view-administration', 'admin', [A]],
  ['view-statistics', 'admin', [A]],
  ['view-engagement-dashboard', 'admin', [A]],
  ['view-privileged-setting', 'admin', [A]],
  ['edit-privileged-setting', 'admin', [A]],
  ['manage-selected-settings', 'admin', [A]],
  ['view-logs', 'admin', [A]],
  ['run-import', 'admin', [A]],
  ['manage-emoji', 'admin', [A]],
  ['manage-integrations', 'admin', [A]],
  ['manage-own-integrations', 'admin', [A]],
  ['manage-oauth-apps', 'admin', [A]],
  ['manage-apps', 'admin', [A]],
  ['manage-sounds', 'admin', [A]],
  ['manage-email-inbox', 'admin', [A]],
  ['view-moderation-console', 'admin', [A]],
  ['manage-moderation-actions', 'admin', [A]],
  // Usuários
  ['view-user-administration', 'users', [A]],
  ['view-full-other-user-info', 'users', [A]],
  ['create-user', 'users', [A]],
  ['edit-other-user-info', 'users', [A]],
  ['edit-other-user-password', 'users', [A]],
  ['edit-other-user-avatar', 'users', [A]],
  ['edit-other-user-active-status', 'users', [A]],
  ['edit-other-user-totp', 'users', [A]],
  ['edit-other-user-e2ee', 'users', [A]],
  ['delete-user', 'users', [A]],
  ['assign-admin-role', 'users', [A]],
  ['create-personal-access-tokens', 'users', [A, U]],
  ['logout-other-user', 'users', [A]],
  ['view-device-management', 'users', [A]],
  ['view-outside-room', 'users', [A, U, B]],
  ['view-d-room', 'users', [A, U, B]],
  ['bulk-register-user', 'users', [A]],
  // Papéis e permissões
  ['access-permissions', 'roles', [A]],
  ['access-setting-permissions', 'roles', [A]],
  ['manage-roles', 'roles', [A]],
  // Salas
  ['view-room-administration', 'rooms', [A]],
  ['create-c', 'rooms', [A, U, B]],
  ['create-p', 'rooms', [A, U, B]],
  ['create-d', 'rooms', [A, U, B]],
  ['start-discussion', 'rooms', [A, U, G, B]],
  ['start-discussion-other-user', 'rooms', [A, U, G, B, O]],
  ['view-c-room', 'rooms', [A, U, B, G]],
  ['view-p-room', 'rooms', [A, U, B, G]],
  ['view-joined-room', 'rooms', [G, B, U, A]],
  ['preview-c-room', 'rooms', [A, U]],
  ['join-without-join-code', 'rooms', [A, B]],
  ['add-user-to-joined-room', 'rooms', [A, O, M]],
  ['add-user-to-any-c-room', 'rooms', [A]],
  ['add-user-to-any-p-room', 'rooms', []],
  ['remove-user', 'rooms', [A, O, M]],
  ['edit-room', 'rooms', [A, O, M]],
  ['edit-room-retention-policy', 'rooms', [A]],
  ['edit-room-avatar', 'rooms', [A, O, M]],
  ['delete-c', 'rooms', [A, O]],
  ['delete-p', 'rooms', [A, O]],
  ['delete-d', 'rooms', [A]],
  ['archive-room', 'rooms', [A, O]],
  ['unarchive-room', 'rooms', [A]],
  ['set-owner', 'rooms', [A, O]],
  ['set-moderator', 'rooms', [A, O]],
  ['set-leader', 'rooms', [A, O]],
  ['set-readonly', 'rooms', [A, O]],
  ['set-react-when-readonly', 'rooms', [A, O]],
  ['ban-user', 'rooms', [A, O, M]],
  ['mute-user', 'rooms', [A, O, M]],
  ['clean-channel-history', 'rooms', [A]],
  ['create-invite-links', 'rooms', [A, O, M]],
  ['view-broadcast-member-list', 'rooms', [A, O, M]],
  ['toggle-room-e2e-encryption', 'rooms', [O]],
  ['mention-all', 'rooms', [A, O, M, U]],
  ['mention-here', 'rooms', [A, O, M, U]],
  ['view-other-user-channels', 'rooms', [A]],
  ['view-room-members', 'rooms', [A, U, B]],
  ['call-management', 'rooms', [A, O, M]],
  // Mensagens
  ['post-readonly', 'messages', [A, O, M]],
  ['edit-message', 'messages', [A, O, M]],
  ['delete-message', 'messages', [A, O, M]],
  ['delete-own-message', 'messages', [A, U, B]],
  ['force-delete-message', 'messages', [A, O]],
  ['bypass-time-limit-edit-and-delete', 'messages', [B, 'app']],
  ['pin-message', 'messages', [O, M, A]],
  ['snippet-message', 'messages', [O, M]],
  ['message-impersonate', 'messages', [B, 'app']],
  ['send-many-messages', 'messages', [A, B, 'app']],
  ['view-message-read-receipts', 'messages', [A, O, M, U]],
  // Teams
  ['create-team', 'teams', [A, U]],
  ['delete-team', 'teams', [A, O]],
  ['edit-team', 'teams', [A, O]],
  ['add-team-member', 'teams', [A, O, M]],
  ['edit-team-member', 'teams', [A, O, M]],
  ['add-team-channel', 'teams', [A, O, M]],
  ['edit-team-channel', 'teams', [A, O, M]],
  ['remove-team-channel', 'teams', [A, O, M]],
  ['view-all-teams', 'teams', [A]],
  ['view-all-team-channels', 'teams', [A, O]],
  ['move-room-to-team', 'teams', [A, O, M]],
  ['create-team-channel', 'teams', [A, O]],
  ['create-team-group', 'teams', [A, O]],
  ['mention-team', 'teams', [A, U]],
  // Auditoria
  ['can-audit', 'audit', [A, 'auditor']],
  ['can-audit-log', 'audit', [A, 'auditor-log']],
  // Retenção
  ['manage-retention-policy', 'retention', [A]],
  // Omnichannel
  ['view-livechat-manager', 'omnichannel', [A, 'livechat-manager']],
  ['view-livechat-rooms', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor']],
  ['view-l-room', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor', 'livechat-agent']],
  ['close-livechat-room', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['transfer-livechat-guest', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['manage-livechat-departments', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-agents', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-managers', 'omnichannel', [A]],
  ['manage-livechat-canned-responses', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor']],
  ['view-canned-responses', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor', 'livechat-agent']],
  ['view-livechat-analytics', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor']],
  ['manage-livechat-sla', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-priorities', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-business-hours', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-tags', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-units', 'omnichannel', [A, 'livechat-manager']],
  ['view-livechat-queue', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['take-livechat-room', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['on-hold-livechat-room', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['manage-livechat-monitors', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-custom-fields', 'omnichannel', [A, 'livechat-manager']],
  ['manage-livechat-triggers', 'omnichannel', [A, 'livechat-manager']],
  ['view-livechat-contacts', 'omnichannel', [A, 'livechat-manager', 'livechat-monitor', 'livechat-agent']],
  ['edit-livechat-contact', 'omnichannel', [A, 'livechat-manager', 'livechat-agent']],
  ['remove-livechat-contact', 'omnichannel', [A, 'livechat-manager']],
  ['view-livechat-offline-messages', 'omnichannel', [A, 'livechat-manager']],
];

let permCache = new Map<string, Set<string>>();
let roleScopes = new Map<string, Role['scope']>();

export async function loadPermissions() {
  const rows = await many<{ id: string; roles: string[] }>('SELECT id, roles FROM permissions');
  permCache = new Map(rows.map((r) => [r.id, new Set(r.roles)]));
  const roles = await many<{ id: string; scope: Role['scope'] }>('SELECT id, scope FROM roles');
  roleScopes = new Map(roles.map((r) => [r.id, r.scope]));
}

bus.onPermissions(() => void loadPermissions());

export async function seedPermissions() {
  for (const r of DEFAULT_ROLES) {
    await query(
      `INSERT INTO roles (id, description, scope, protected, mandatory_2fa) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [r._id, r.description, r.scope, r.protected, r.mandatory2fa],
    );
  }
  for (const [id, grp, roles] of DEFAULT_PERMISSIONS) {
    await query(`INSERT INTO permissions (id, grp, roles) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, grp, roles]);
  }
  await loadPermissions();
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
  return { _id: r.id, name: r.id, description: r.description, scope: r.scope, protected: r.protected, mandatory2fa: r.mandatory_2fa };
}

export function roleScope(role: string) {
  return roleScopes.get(role);
}
