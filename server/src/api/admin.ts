import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit, listAuditLog } from '../services/audit';
import { withExtra } from '../services/messages';
import { listPermissions, listRoles, mapRole, setPermissionRoles, hasPermission, loadPermissions, roleScope } from '../services/permissions';
import { isKnownSetting, isSecretSetting, listSettings, updateSettings } from '../services/settings';
import { engagementChannels, engagementMessages, engagementUsers, workspaceStatistics } from '../services/stats';
import { runRetention } from '../services/retention';
import { mapUser } from '../services/mappers';
import { actorOf, invalidateMandatory2faCache } from '../services/users';
import { bus } from '../realtime/bus';
import { b, paging, q, route, str, strArray } from './http';
import { resolveUserParam } from './users';

export function adminRoutes(app: FastifyInstance) {
  // ---------- Informações públicas ----------
  route(app, 'GET', 'info', { auth: false }, async () => ({ info: { version: '0.1.0', product: 'Wescc Chat' } }));
  route(app, 'GET', 'settings.public', { auth: false }, async () => {
    const settings = listSettings({ publicOnly: true }).map((s) => ({ _id: s._id, value: s.value }));
    return { settings, count: settings.length, offset: 0, total: settings.length };
  });

  // ---------- Configurações ----------
  route(app, 'GET', 'settings', { permissions: ['view-privileged-setting'] }, async (req) => {
    const group = q(req).group;
    const settings = listSettings().filter((s) => !group || s.group === group);
    return { settings, count: settings.length, offset: 0, total: settings.length };
  });
  route(app, 'POST', 'settings', { permissions: ['edit-privileged-setting'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const values: Record<string, unknown> = body.settings ?? (body._id ? { [body._id]: body.value } : {});
    for (const [k, v] of Object.entries(values)) {
      if (!isKnownSetting(k)) throw badRequest('error-invalid-setting', `Configuração desconhecida: ${k}`);
      if (v === '********') delete values[k];
    }
    const changed = await updateSettings(values).catch((e) => {
      throw badRequest('error-invalid-setting-value', String(e.message));
    });
    await audit(actorOf(ctx), 'settings.changed', {}, { settings: changed.map((c) => ({ _id: c._id, value: isSecretSetting(c._id) ? '***' : c.value })) });
    return { changed: changed.map((c) => c._id) };
  });

  // ---------- Permissões e papéis (papéis customizados liberados) ----------
  route(app, 'GET', 'permissions.listAll', {}, async () => ({ update: await listPermissions(), remove: [] }));
  route(app, 'POST', 'permissions.update', { permissions: ['access-permissions'] }, async (req, _rep, ctx) => {
    const perms = b(req).permissions;
    if (!Array.isArray(perms)) throw badRequest('error-invalid-params', 'permissions deve ser uma lista.');
    await setPermissionRoles(perms.map((p: any) => ({ _id: String(p._id), roles: strArray(p.roles) })));
    await audit(actorOf(ctx), 'permissions.changed', {}, { permissions: perms });
    return { permissions: await listPermissions() };
  });
  route(app, 'GET', 'roles.list', {}, async () => ({ roles: await listRoles() }));
  route(app, 'POST', 'roles.create', { permissions: ['access-permissions', 'manage-roles'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const name = str(body.name, 'name', { max: 60 });
    if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw badRequest('error-invalid-role-name', 'Nome de papel inválido.');
    if (await one('SELECT 1 FROM roles WHERE lower(id) = lower($1)', [name])) throw badRequest('error-duplicate-role-names-not-allowed', 'Já existe um papel com esse nome.');
    const scope = body.scope === 'Subscriptions' ? 'Subscriptions' : 'Users';
    const row = await one('INSERT INTO roles (id, description, scope, protected, mandatory_2fa) VALUES ($1,$2,$3,false,$4) RETURNING *', [
      name,
      String(body.description ?? ''),
      scope,
      !!body.mandatory2fa,
    ]);
    await loadPermissions();
    bus.permissionsChanged();
    await audit(actorOf(ctx), 'role.created', { role: name });
    return { role: mapRole(row) };
  });
  route(app, 'POST', 'roles.update', { permissions: ['access-permissions', 'manage-roles'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const id = str(body.roleId, 'roleId');
    const existing = await one('SELECT * FROM roles WHERE id = $1', [id]);
    if (!existing) throw notFound('error-invalid-roleId', 'Papel não encontrado.');
    const row = await one('UPDATE roles SET description = COALESCE($2, description), mandatory_2fa = COALESCE($3, mandatory_2fa), scope = CASE WHEN protected THEN scope ELSE COALESCE($4, scope) END WHERE id = $1 RETURNING *', [
      id,
      body.description ?? null,
      body.mandatory2fa ?? null,
      body.scope ?? null,
    ]);
    invalidateMandatory2faCache();
    await loadPermissions();
    bus.permissionsChanged();
    await audit(actorOf(ctx), 'role.updated', { role: id });
    return { role: mapRole(row) };
  });
  route(app, 'POST', 'roles.delete', { permissions: ['access-permissions', 'manage-roles'] }, async (req, _rep, ctx) => {
    const id = str(b(req).roleId, 'roleId');
    const role = await one('SELECT * FROM roles WHERE id = $1', [id]);
    if (!role) throw notFound('error-invalid-roleId', 'Papel não encontrado.');
    if (role.protected) throw badRequest('error-role-protected', 'Papéis do sistema não podem ser excluídos.');
    const inUse = await one(`SELECT (SELECT count(*) FROM users WHERE $1 = ANY(roles)) + (SELECT count(*) FROM subscriptions WHERE $1 = ANY(roles)) AS n`, [id]);
    if (Number(inUse.n) > 0) throw badRequest('error-role-in-use', 'O papel ainda está atribuído a usuários.');
    await query('DELETE FROM roles WHERE id = $1', [id]);
    await query('UPDATE permissions SET roles = array_remove(roles, $1)', [id]);
    await loadPermissions();
    bus.permissionsChanged();
    await audit(actorOf(ctx), 'role.deleted', { role: id });
    return {};
  });
  route(app, 'POST', 'roles.addUserToRole', { permissions: ['access-permissions', 'manage-roles'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const role = str(body.roleId ?? body.roleName, 'roleId');
    if (!(await one('SELECT 1 FROM roles WHERE id = $1', [role]))) throw notFound('error-invalid-roleId', 'Papel não encontrado.');
    if (role === 'admin' && !(await hasPermission(ctx.userId, 'assign-admin-role'))) throw forbidden();
    const user = await resolveUserParam(body);
    if (roleScope(role) === 'Subscriptions' && body.roomId) {
      await query('UPDATE subscriptions SET roles = array_append(array_remove(roles, $3), $3), updated_at = now() WHERE room_id = $1 AND user_id = $2', [body.roomId, user.id, role]);
    } else {
      await query('UPDATE users SET roles = array_append(array_remove(roles, $2), $2), updated_at = now() WHERE id = $1', [user.id, role]);
    }
    await audit(actorOf(ctx), 'role.user.added', { role, userId: user.id, roomId: body.roomId });
    return { role: { _id: role } };
  });
  route(app, 'POST', 'roles.removeUserFromRole', { permissions: ['access-permissions', 'manage-roles'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const role = str(body.roleId ?? body.roleName, 'roleId');
    const user = await resolveUserParam(body);
    if (role === 'admin') {
      const n = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active`);
      if (n.n <= 1 && user.roles.includes('admin')) throw badRequest('error-action-not-allowed', 'Não é possível remover o último administrador.');
    }
    if (body.roomId) await query('UPDATE subscriptions SET roles = array_remove(roles, $3), updated_at = now() WHERE room_id = $1 AND user_id = $2', [body.roomId, user.id, role]);
    else await query('UPDATE users SET roles = array_remove(roles, $2), updated_at = now() WHERE id = $1', [user.id, role]);
    await audit(actorOf(ctx), 'role.user.removed', { role, userId: user.id, roomId: body.roomId });
    return {};
  });
  route(app, 'GET', 'roles.getUsersInRole', { permissions: ['access-permissions', 'view-user-administration'] }, async (req) => {
    const role = str(q(req).role, 'role');
    const p = paging(q(req));
    const rid = q(req).roomId;
    const rows = rid
      ? await many(
          `SELECT u.*, count(*) OVER() AS total FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.room_id = $1 AND $2 = ANY(s.roles) ORDER BY u.username LIMIT ${p.count} OFFSET ${p.offset}`,
          [rid, role],
        )
      : await many(`SELECT *, count(*) OVER() AS total FROM users WHERE $1 = ANY(roles) ORDER BY username LIMIT ${p.count} OFFSET ${p.offset}`, [role]);
    return { users: rows.map((r) => mapUser(r, { full: true })), total: Number(rows[0]?.total ?? 0) };
  });

  // ---------- Estatísticas e dashboard de engajamento ----------
  route(app, 'GET', 'statistics', { permissions: ['view-statistics'] }, async () => workspaceStatistics());
  route(app, 'GET', 'engagement-dashboard/users', { permissions: ['view-engagement-dashboard'] }, async (req) => engagementUsers(q(req).start, q(req).end));
  route(app, 'GET', 'engagement-dashboard/messages', { permissions: ['view-engagement-dashboard'] }, async (req) => engagementMessages(q(req).start, q(req).end));
  route(app, 'GET', 'engagement-dashboard/channels', { permissions: ['view-engagement-dashboard'] }, async (req) => {
    const p = paging(q(req));
    return engagementChannels(q(req).start, q(req).end, p.offset, p.count);
  });

  // ---------- Auditoria ----------
  // Auditoria de mensagens: por sala, por usuários (DMs entre eles) ou por usuário.
  route(app, 'POST', 'audit.messages', { permissions: ['can-audit'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const type = String(body.type ?? 'room');
    const start = str(body.startDate, 'startDate');
    const end = str(body.endDate, 'endDate');
    const params: unknown[] = [start, end];
    const w = ['m.created_at BETWEEN $1 AND $2'];
    if (body.msg) w.push(`m.msg ILIKE $${params.push(`%${body.msg}%`)}`);
    if (type === 'room') {
      w.push(`m.room_id = $${params.push(str(body.rid, 'rid'))}`);
    } else if (type === 'u') {
      const users = strArray(body.users);
      if (users.length < 2) throw badRequest('error-invalid-params', 'Informe ao menos dois usuários.');
      const ids = (await many('SELECT id FROM users WHERE username = ANY($1)', [users])).map((r) => r.id);
      w.push(`m.room_id IN (SELECT id FROM rooms WHERE t = 'd' AND uids @> $${params.push(ids)})`);
    } else if (type === 'user') {
      const u = await resolveUserParam({ username: body.username, userId: body.userId });
      w.push(`m.user_id = $${params.push(u.id)}`);
    } else if (type === 'd') {
      const u = await resolveUserParam({ username: body.username, userId: body.userId });
      w.push(`m.room_id IN (SELECT id FROM rooms WHERE t = 'd' AND $${params.push(u.id)} = ANY(uids))`);
    } else {
      throw badRequest('error-invalid-params', 'type inválido.');
    }
    const rows = await many(
      `SELECT m.*, r.t AS room_t, coalesce(r.fname, r.name, array_to_string(r.usernames, ', ')) AS room_name FROM messages m JOIN rooms r ON r.id = m.room_id
       WHERE ${w.join(' AND ')} ORDER BY m.created_at DESC LIMIT 2000`,
      params,
    );
    await audit(actorOf(ctx), 'audit.messages.query', { type, rid: body.rid, users: body.users, username: body.username }, { startDate: start, endDate: end, msg: body.msg, results: rows.length });
    return { messages: rows.map((r) => ({ ...withExtra(r), roomName: r.room_name, roomType: r.room_t })) };
  });
  route(app, 'GET', 'audit.auditions', { permissions: ['can-audit-log'] }, async (req) => {
    const p = paging(q(req));
    return listAuditLog({ start: q(req).startDate, end: q(req).endDate, action: 'audit.%', ...p });
  });
  route(app, 'GET', 'audit.log', { permissions: ['can-audit-log'] }, async (req) => {
    const query2 = q(req);
    const p = paging(query2);
    return listAuditLog({ start: query2.start, end: query2.end, action: query2.action, actor: query2.actor, ...p });
  });
  route(app, 'GET', 'audit.settings', { permissions: ['can-audit-log'] }, async (req) => {
    const p = paging(q(req));
    return listAuditLog({ start: q(req).start, end: q(req).end, action: 'settings.%', ...p });
  });

  // ---------- Retenção ----------
  route(app, 'POST', 'retention.run', { permissions: ['manage-retention-policy'] }, async (_req, _rep, ctx) => {
    const r = await runRetention();
    await audit(actorOf(ctx), 'retention.run.manual', {}, r);
    return r;
  });

  // ---------- LDAP ----------
  route(app, 'POST', 'ldap.testConnection', { permissions: ['edit-privileged-setting'] }, async () => {
    const { ldapTestConnection } = await import('../ldap/ldap');
    try {
      const r = await ldapTestConnection();
      return { message: `Conexão bem-sucedida (${r.sample} entradas de exemplo).` };
    } catch (e: any) {
      throw badRequest('error-ldap-connection', `Falha na conexão: ${e.message}`);
    }
  });
  route(app, 'POST', 'ldap.syncNow', { permissions: ['edit-privileged-setting'] }, async (_req, _rep, ctx) => {
    const { ldapSync } = await import('../ldap/ldap');
    const r = await ldapSync();
    await audit(actorOf(ctx), 'ldap.sync.manual', {}, r);
    return { message: `Importados: ${r.imported}, atualizados: ${r.updated}, desativados: ${r.deactivated}`, ...r };
  });

  // ---------- Moderação ----------
  route(app, 'GET', 'moderation.reportsByUsers', { permissions: ['view-moderation-console'] }, async (req) => {
    const p = paging(q(req));
    const rows = await many(
      `SELECT r.reported_user_id, u.username, u.name, count(*)::int AS count, max(r.created_at) AS last, count(*) OVER() AS total
       FROM moderation_reports r LEFT JOIN users u ON u.id = r.reported_user_id
       WHERE NOT r.resolved GROUP BY r.reported_user_id, u.username, u.name ORDER BY last DESC LIMIT ${p.count} OFFSET ${p.offset}`,
    );
    return { reports: rows.map((r) => ({ userId: r.reported_user_id, username: r.username, name: r.name, count: r.count, ts: r.last })), total: Number(rows[0]?.total ?? 0) };
  });
  route(app, 'GET', 'moderation.userReports', { permissions: ['view-moderation-console'] }, async (req) => {
    const rows = await many(
      `SELECT r.*, m.msg, m.created_at AS msg_ts, rep.username AS reporter, ro.name AS room_name FROM moderation_reports r
       LEFT JOIN messages m ON m.id = r.message_id LEFT JOIN users rep ON rep.id = r.reporter_id LEFT JOIN rooms ro ON ro.id = r.room_id
       WHERE r.reported_user_id = $1 AND NOT r.resolved ORDER BY r.created_at DESC`,
      [str(q(req).userId, 'userId')],
    );
    return {
      reports: rows.map((r) => ({ _id: r.id, messageId: r.message_id, msg: r.msg, roomName: r.room_name, reporter: r.reporter, description: r.description, ts: r.created_at })),
    };
  });
  route(app, 'POST', 'moderation.dismissReports', { permissions: ['manage-moderation-actions'] }, async (req, _rep, ctx) => {
    const body = b(req);
    if (body.userId) await query('UPDATE moderation_reports SET resolved = true WHERE reported_user_id = $1', [body.userId]);
    if (body.msgId) await query('UPDATE moderation_reports SET resolved = true WHERE message_id = $1', [body.msgId]);
    await audit(actorOf(ctx), 'moderation.dismissed', { userId: body.userId, msgId: body.msgId });
    return {};
  });
  route(app, 'POST', 'moderation.user.deleteReportedMessages', { permissions: ['manage-moderation-actions'] }, async (req, _rep, ctx) => {
    const userId = str(b(req).userId, 'userId');
    const msgs = await many('SELECT m.* FROM messages m WHERE m.id IN (SELECT message_id FROM moderation_reports WHERE reported_user_id = $1 AND NOT resolved)', [userId]);
    const { removeMessageRow } = await import('../services/messages');
    for (const m of msgs) await removeMessageRow(m);
    await query('UPDATE moderation_reports SET resolved = true WHERE reported_user_id = $1', [userId]);
    await audit(actorOf(ctx), 'moderation.messages.deleted', { userId }, { count: msgs.length });
    return {};
  });

  // ---------- Instâncias ----------
  route(app, 'GET', 'instances.get', { permissions: ['view-statistics'] }, async () => {
    const rows = await many(`SELECT i.*, (SELECT count(*) FROM presence_connections p WHERE p.instance_id = i.id)::int AS conns FROM instances i WHERE last_seen > now() - interval '2 minutes'`);
    return { instances: rows.map((r) => ({ _id: r.id, startedAt: r.started_at, lastSeen: r.last_seen, connections: r.conns, ...r.info })) };
  });
}
