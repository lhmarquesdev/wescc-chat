import type { FastifyInstance } from 'fastify';
import { many, one } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { mapUser } from '../services/mappers';
import { getUserRoles, hasPermission, permissionsForRoles } from '../services/permissions';
import { getSetting } from '../services/settings';
import {
  actorOf,
  createPersonalToken,
  createUser,
  deleteUser,
  disableTotp,
  enableTotp,
  getUserById,
  getUserByUsername,
  listPersonalTokens,
  listSessions,
  login,
  logout,
  needs2faSetup,
  registerUser,
  removePersonalToken,
  requestPasswordReset,
  resetPasswordWithToken,
  resetAvatar,
  revokeAllSessions,
  revokeSession,
  setAvatar,
  setPreferences,
  setStatus,
  TwoFactorRequired,
  updateUser,
  verifyAndEnableTotp,
} from '../services/users';
import { b, bool, paging, parseCookies, q, route, str, strArray } from './http';

async function meResponse(userId: string) {
  const u = await getUserById(userId);
  const roles = await getUserRoles(userId);
  // O servidor também bloqueia o resto da API enquanto a troca de senha ou o 2FA estiverem pendentes (api/http.ts).
  return { ...mapUser(u, { full: true }), permissions: permissionsForRoles(roles), requirePasswordChange: u.require_password_change, require2faSetup: await needs2faSetup(u) };
}

export async function resolveUserParam(params: Record<string, any>) {
  const u = params.userId ? await getUserById(params.userId) : params.username ? await getUserByUsername(params.username) : null;
  if (!u) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  return u;
}

export function usersRoutes(app: FastifyInstance) {
  // ---------- Autenticação ----------
  route(app, 'POST', 'login', { auth: false }, async (req, reply) => {
    const body = b(req);
    if (body.resume) {
      // Login com token existente (reconexão).
      const { resolveToken } = await import('../services/users');
      const r = await resolveToken(undefined, body.resume);
      if (!r) throw new (await import('../lib/errors')).ApiError(401, 'error-unauthorized', 'Sessão expirada.');
      return { status: 'success', data: { userId: r.user.id, authToken: body.resume, me: await meResponse(r.user.id) } };
    }
    if (body.saml || body.oauth) {
      // Troca a credencial de uso único do /saml/acs ou do /oauth/:id/callback por uma sessão.
      const method = body.saml ? 'saml' : 'oauth';
      const { clearSsoBrowserCookie, consumeSsoCredential, SSO_BROWSER_COOKIE } = await import('../services/sso');
      const { createSession } = await import('../services/users');
      const enabled = method === 'oauth' || getSetting('SAML_Enable');
      // Sem o cookie entregue no fim do fluxo, a credencial não vale (outro navegador).
      const nonce = parseCookies(req.headers.cookie)[SSO_BROWSER_COOKIE];
      reply.header('set-cookie', clearSsoBrowserCookie());
      const u = enabled ? await consumeSsoCredential(str(body.credentialToken, 'credentialToken'), method, nonce) : null;
      if (!u || !u.active) throw new (await import('../lib/errors')).ApiError(401, 'error-unauthorized', 'Login SSO expirado. Tente novamente.');
      const s = await createSession(u.id, { userAgent: req.headers['user-agent'], ip: req.ip });
      await audit({ id: u.id, username: u.username, ip: req.ip }, 'auth.login', { sessionId: s.sessionId, method });
      return { status: 'success', data: { userId: u.id, authToken: s.authToken, me: await meResponse(u.id) } };
    }
    const user = str(body.user ?? body.username ?? body.email, 'user');
    const password = str(body.password, 'password');
    try {
      const r = await login({ user, password, code: body.code, device: { userAgent: req.headers['user-agent'], ip: req.ip } });
      return { status: 'success', data: { userId: r.user.id, authToken: r.authToken, me: await meResponse(r.user.id) } };
    } catch (e) {
      if (e instanceof TwoFactorRequired) {
        return { success: false, status: 'error', error: 'totp-required', errorType: 'totp-required', details: { method: 'totp' } };
      }
      throw e;
    }
  });

  route(app, 'POST', 'logout', {}, async (_req, _rep, ctx) => {
    await logout(ctx.sessionId);
    return { status: 'success', data: { message: 'Você saiu.' } };
  });

  route(app, 'GET', 'me', {}, async (_req, _rep, ctx) => meResponse(ctx.userId));

  route(app, 'POST', 'users.register', { auth: false }, async (req) => {
    const body = b(req);
    const row = await registerUser(
      { username: str(body.username, 'username'), name: str(body.name, 'name'), email: str(body.email, 'email'), pass: str(body.pass, 'pass'), secretURL: body.secretURL },
      req.ip,
    );
    return { user: mapUser(row) };
  });

  // ---------- Esqueci minha senha ----------
  route(app, 'POST', 'users.forgotPassword', { auth: false }, async (req) => {
    await requestPasswordReset(str(b(req).email, 'email', { max: 320 }), req.ip);
    return {};
  });
  route(app, 'POST', 'users.resetPassword', { auth: false }, async (req) => {
    const body = b(req);
    await resetPasswordWithToken(str(body.token, 'token', { max: 200 }), str(body.password, 'password', { max: 1000 }), req.ip);
    return {};
  });

  // ---------- 2FA ----------
  route(app, 'POST', 'users.2fa.enableTotp', {}, async (_req, _rep, ctx) => {
    if (!getSetting('Accounts_TwoFactorAuthentication_Enabled')) throw forbidden('2FA desativado no servidor.');
    return enableTotp(ctx);
  });
  route(app, 'POST', 'users.2fa.verifyTotp', {}, async (req, _rep, ctx) => verifyAndEnableTotp(ctx, str(b(req).code, 'code')));
  route(app, 'POST', 'users.2fa.disableTotp', {}, async (req, _rep, ctx) => {
    await disableTotp(ctx, str(b(req).code, 'code'));
    return {};
  });

  // ---------- Notificações push (Web Push) ----------
  route(app, 'GET', 'push.info', {}, async (_req, _rep, ctx) => {
    const { pushInfo } = await import('../services/push');
    return pushInfo(ctx.userId);
  });
  route(app, 'POST', 'push.webSubscribe', {}, async (req, _rep, ctx) => {
    const { saveSubscription } = await import('../services/push');
    await saveSubscription(ctx.userId, ctx.sessionId, b(req).subscription, req.headers['user-agent']);
    return {};
  });
  route(app, 'POST', 'push.webUnsubscribe', {}, async (req, _rep, ctx) => {
    const { removeSubscription } = await import('../services/push');
    await removeSubscription(ctx.userId, str(b(req).endpoint, 'endpoint', { max: 2048 }));
    return {};
  });

  // ---------- Sessões / dispositivos ----------
  route(app, 'GET', 'sessions.list', {}, async (req, _rep, ctx) => {
    const r = await listSessions({ userId: ctx.userId, ...paging(q(req)) });
    return { ...r, sessions: r.sessions.map((s) => ({ ...s, current: s._id === ctx.sessionId })), count: r.sessions.length, offset: paging(q(req)).offset };
  });
  route(app, 'POST', 'sessions.logout.me', {}, async (req, _rep, ctx) => {
    await revokeSession(ctx, str(b(req).sessionId, 'sessionId'), false);
    return {};
  });
  route(app, 'POST', 'sessions.logout.others', {}, async (_req, _rep, ctx) => {
    if (!getSetting('Device_Management_Allow_Logout_All')) throw forbidden();
    return { removed: await revokeAllSessions(ctx.userId, ctx.sessionId) };
  });
  route(app, 'GET', 'sessions.list.all', { permissions: ['view-device-management'] }, async (req) => {
    const query = q(req);
    const r = await listSessions({ ...paging(query), search: query.filter, userId: query.userId });
    return { ...r, count: r.sessions.length, offset: paging(query).offset };
  });
  route(app, 'POST', 'sessions.logout', { permissions: ['view-device-management', 'logout-other-user'] }, async (req, _rep, ctx) => {
    await revokeSession(ctx, str(b(req).sessionId, 'sessionId'), true);
    return {};
  });

  // ---------- Tokens pessoais ----------
  route(app, 'GET', 'users.getPersonalAccessTokens', { permissions: ['create-personal-access-tokens'] }, async (_req, _rep, ctx) => ({
    tokens: await listPersonalTokens(ctx.userId),
  }));
  route(app, 'POST', 'users.generatePersonalAccessToken', { permissions: ['create-personal-access-tokens'] }, async (req, _rep, ctx) => ({
    token: await createPersonalToken(ctx, str(b(req).tokenName, 'tokenName', { max: 100 }), !!bool(b(req).bypassTwoFactor)),
  }));
  route(app, 'POST', 'users.removePersonalAccessToken', {}, async (req, _rep, ctx) => {
    await removePersonalToken(ctx.userId, str(b(req).tokenName, 'tokenName'));
    return {};
  });

  // ---------- Perfil próprio ----------
  route(app, 'POST', 'users.updateOwnBasicInfo', {}, async (req, _rep, ctx) => {
    const d = b(req).data ?? {};
    // Na troca de senha obrigatória só a senha pode ser alterada.
    const fields = ctx.setup === 'password' ? { password: d.newPassword } : { username: d.username, name: d.name, email: d.email, password: d.newPassword, bio: d.bio, statusText: d.statusText };
    const row = await updateUser(
      ctx,
      ctx.userId,
      fields,
      { asAdmin: false, currentPassword: d.currentPassword },
    );
    return { user: mapUser(row, { full: true }) };
  });
  route(app, 'POST', 'users.setPreferences', {}, async (req, _rep, ctx) => {
    const row = await setPreferences(ctx, b(req).data ?? {});
    return { user: { _id: row.id, settings: { preferences: row.preferences } } };
  });
  route(app, 'POST', 'users.setStatus', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const target = body.userId && body.userId !== ctx.userId ? body.userId : ctx.userId;
    if (target !== ctx.userId && !(await hasPermission(ctx.userId, 'edit-other-user-info'))) throw forbidden();
    if (body.status && !['online', 'away', 'busy', 'offline'].includes(body.status)) throw badRequest('error-invalid-status', 'Status inválido.');
    await setStatus(target, body.status, body.message);
    return {};
  });
  route(app, 'GET', 'users.getStatus', {}, async (req, _rep, ctx) => {
    const u = q(req).userId ? await getUserById(q(req).userId) : await getUserById(ctx.userId);
    if (!u) throw notFound('error-invalid-user');
    return { _id: u.id, status: u.status, message: u.status_text, connectionStatus: u.status === 'offline' ? 'offline' : 'online' };
  });
  route(app, 'POST', 'users.deleteOwnAccount', {}, async (req, _rep, ctx) => {
    if (!getSetting('Accounts_AllowDeleteOwnAccount')) throw forbidden('Excluir a própria conta está desativado.');
    const u = await getUserById(ctx.userId);
    const { verifyPassword } = await import('../lib/password');
    if (u.password_hash && !(await verifyPassword(str(b(req).password, 'password'), u.password_hash))) throw badRequest('error-invalid-password', 'Senha incorreta.');
    await deleteUser(ctx, ctx.userId);
    return {};
  });
  route(app, 'POST', 'users.resetAvatar', {}, async (req, _rep, ctx) => {
    const body = b(req);
    let target = ctx.userId;
    if (body.userId || body.username) {
      const u = await resolveUserParam(body);
      if (u.id !== ctx.userId && !(await hasPermission(ctx.userId, 'edit-other-user-avatar'))) throw forbidden();
      target = u.id;
    }
    await resetAvatar(target);
    return {};
  });
  route(app, 'POST', 'users.setAvatar', {}, async (req, _rep, ctx) => {
    let target = ctx.userId;
    let data: Buffer | null = null;
    let type = '';
    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          data = await part.toBuffer();
          type = part.mimetype;
        } else if (part.fieldname === 'userId' && part.value) {
          target = String(part.value);
        }
      }
    } else {
      const body = b(req);
      if (body.userId) target = body.userId;
      const m = String(body.avatarUrl ?? '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (!m) throw badRequest('error-invalid-image', 'Envie a imagem como arquivo ou data URL.');
      type = m[1];
      data = Buffer.from(m[2], 'base64');
    }
    if (target !== ctx.userId && !(await hasPermission(ctx.userId, 'edit-other-user-avatar'))) throw forbidden();
    if (target === ctx.userId && !getSetting('Accounts_AllowUserAvatarChange')) throw forbidden('Alteração de avatar desativada.');
    if (!data) throw badRequest('error-invalid-image', 'Imagem ausente.');
    await setAvatar(target, type, data);
    return {};
  });

  // ---------- Consulta ----------
  route(app, 'GET', 'users.info', {}, async (req, _rep, ctx) => {
    const u = await resolveUserParam(q(req));
    const full = u.id === ctx.userId || (await hasPermission(ctx.userId, 'view-full-other-user-info'));
    const user: any = mapUser(u, { full });
    if (q(req).includeUserRooms === 'true' && u.id === ctx.userId) {
      user.rooms = await many('SELECT room_id AS rid, roles FROM subscriptions WHERE user_id = $1', [u.id]);
    }
    return { user };
  });
  route(app, 'GET', 'users.list', { permissions: ['view-user-administration', 'view-d-room'] }, async (req, _rep, ctx) => {
    const query = q(req);
    const { offset, count } = paging(query);
    const admin = await hasPermission(ctx.userId, 'view-user-administration');
    const params: unknown[] = [`%${query.filter ?? query.text ?? ''}%`];
    let w = '(username ILIKE $1 OR name ILIKE $1' + (admin ? ' OR email ILIKE $1)' : ')');
    if (!admin) w += ' AND active';
    if (query.status === 'active') w += ' AND active';
    if (query.status === 'deactivated') w += ' AND NOT active';
    if (query.role) w += ` AND $${params.push(query.role)} = ANY(roles)`;
    if (query.type) w += ` AND type = $${params.push(query.type)}`;
    const rows = await many(`SELECT *, count(*) OVER() AS total FROM users WHERE ${w} ORDER BY username LIMIT ${count} OFFSET ${offset}`, params);
    return { users: rows.map((r) => mapUser(r, { full: admin })), count: rows.length, offset, total: Number(rows[0]?.total ?? 0) };
  });
  route(app, 'GET', 'users.autocomplete', {}, async (req, _rep, ctx) => {
    const term = String(q(req).selector ? JSON.parse(q(req).selector).term ?? '' : q(req).term ?? '');
    const exclude = strArray(q(req).exclude);
    // inRoom só para quem pode ver os membros da sala; sem acesso, ou com a lista de membros oculta, o rid é ignorado.
    let rid: string | undefined;
    if (q(req).rid) {
      const { canAccessRoom, getRoom } = await import('../services/rooms');
      const room = await getRoom(String(q(req).rid));
      const visible = room && (await canAccessRoom(ctx.userId, room)) && (!room.broadcast || (await hasPermission(ctx.userId, 'view-broadcast-member-list', room.id)));
      if (visible) rid = room.id;
    }
    const rows = await many(
      `SELECT id, username, name, status, avatar_etag, roles ${rid ? ', EXISTS (SELECT 1 FROM subscriptions s WHERE s.room_id = $4 AND s.user_id = users.id) AS in_room' : ''}
       FROM users WHERE active AND (username ILIKE $1 OR name ILIKE $1) AND NOT (username = ANY($2))
       ORDER BY ${rid ? 'in_room DESC, ' : ''}(lower(username) = lower($3)) DESC, username LIMIT 15`,
      rid ? [`${term}%`, exclude, term, rid] : [`${term}%`, exclude, term],
    );
    // roles (globais): a web decide antes do clique se dá para abrir uma conversa direta.
    return { items: rows.map((r) => ({ _id: r.id, username: r.username, name: r.name, status: r.status, avatarETag: r.avatar_etag, roles: r.roles, inRoom: r.in_room })) };
  });
  route(app, 'GET', 'users.presence', {}, async (req) => {
    const ids = strArray(q(req).ids);
    const rows = ids.length
      ? await many('SELECT id, username, name, status, status_text FROM users WHERE id = ANY($1)', [ids])
      : await many(`SELECT id, username, name, status, status_text FROM users WHERE status <> 'offline'`);
    return { users: rows.map((r) => ({ _id: r.id, username: r.username, name: r.name, status: r.status, statusText: r.status_text })), full: !ids.length };
  });

  // ---------- Administração de usuários ----------
  route(app, 'POST', 'users.create', { permissions: ['create-user'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const roles = strArray(body.roles);
    if (roles.includes('admin') && !(await hasPermission(ctx.userId, 'assign-admin-role'))) throw forbidden();
    const row = await createUser(
      {
        username: str(body.username, 'username'),
        name: str(body.name, 'name'),
        email: body.email,
        password: str(body.password, 'password'),
        roles: roles.length ? roles : ['user'],
        active: bool(body.active) ?? true,
        verified: bool(body.verified) ?? false,
        requirePasswordChange: bool(body.requirePasswordChange) ?? false,
        joinDefaultChannels: bool(body.joinDefaultChannels) ?? true,
        type: body.type === 'bot' ? 'bot' : 'user',
      },
      actorOf(ctx),
    );
    return { user: mapUser(row, { full: true }) };
  });
  route(app, 'POST', 'users.update', { permissions: ['edit-other-user-info'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const d = body.data ?? {};
    const userId = str(body.userId, 'userId');
    if (d.roles) {
      const roles = strArray(d.roles);
      if (roles.includes('admin') && !(await hasPermission(ctx.userId, 'assign-admin-role'))) throw forbidden();
      const known = new Set((await many('SELECT id FROM roles')).map((r) => r.id));
      const bad = roles.filter((r) => !known.has(r));
      if (bad.length) throw badRequest('error-invalid-role', `Papel inexistente: ${bad.join(', ')}`);
      d.roles = roles;
    }
    if (d.password && !(await hasPermission(ctx.userId, 'edit-other-user-password'))) throw forbidden();
    const row = await updateUser(ctx, userId, d, { asAdmin: true });
    return { user: mapUser(row, { full: true }) };
  });
  route(app, 'POST', 'users.setActiveStatus', { permissions: ['edit-other-user-active-status'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const row = await updateUser(ctx, str(body.userId, 'userId'), { active: !!bool(body.activeStatus) }, { asAdmin: true });
    return { user: { _id: row.id, active: row.active } };
  });
  route(app, 'POST', 'users.delete', { permissions: ['delete-user'] }, async (req, _rep, ctx) => {
    const u = await resolveUserParam(b(req));
    await deleteUser(ctx, u.id, { confirmRelinquish: !!bool(b(req).confirmRelinquish) });
    return {};
  });
  route(app, 'POST', 'users.logout', {}, async (req, _rep, ctx) => {
    const userId = b(req).userId ?? ctx.userId;
    if (userId !== ctx.userId && !(await hasPermission(ctx.userId, 'logout-other-user'))) throw forbidden();
    const n = await revokeAllSessions(userId);
    await audit(actorOf(ctx), 'user.logout.all', { userId }, { sessions: n });
    return { message: `Sessões encerradas: ${n}` };
  });
  route(app, 'POST', 'users.resetTOTP', { permissions: ['edit-other-user-totp'] }, async (req, _rep, ctx) => {
    const userId = str(b(req).userId, 'userId');
    const { query } = await import('../db/pool');
    await query("UPDATE users SET totp_enabled = false, totp_secret = NULL, backup_codes = '{}' WHERE id = $1", [userId]);
    await audit(actorOf(ctx), 'user.2fa.reset', { userId });
    return {};
  });
  route(app, 'GET', 'users.listPendingApproval', { permissions: ['view-user-administration'] }, async () => {
    const rows = await many(`SELECT * FROM users WHERE NOT active AND last_login IS NULL ORDER BY created_at DESC LIMIT 200`);
    return { users: rows.map((r) => mapUser(r, { full: true })) };
  });

  // Avatares. Sem login (com Accounts_AvatarBlockUnauthenticatedAccess) só as iniciais do que foi pedido, sem revelar nada.
  const avatarsPublic = () => !getSetting('Accounts_AvatarBlockUnauthenticatedAccess');
  app.get('/avatar/:username', async (req: any, reply) => {
    const name = String(req.params.username).replace(/^@/, '');
    if (name.startsWith('room/')) return reply.callNotFound();
    const visible = !!req.ctx || avatarsPublic();
    reply.header('Cache-Control', visible && !req.ctx ? 'public, max-age=300' : 'private, max-age=300');
    if (!visible) return reply.type('image/svg+xml').send(initialsSvg(name));
    const u = await one('SELECT u.id, u.username, u.name, a.content_type, a.data, a.updated_at FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE lower(u.username) = lower($1)', [name]);
    if (u?.data) return reply.type(u.content_type).send(u.data);
    return reply.type('image/svg+xml').send(initialsSvg(u?.name || u?.username || name));
  });
  app.get('/avatar/room/:rid', async (req: any, reply) => {
    const r = await one('SELECT r.*, a.content_type, a.data FROM rooms r LEFT JOIN room_avatars a ON a.room_id = r.id WHERE r.id = $1', [req.params.rid]);
    reply.header('Cache-Control', 'private, max-age=300');
    // Sala privada, DM ou atendimento: só para quem tem acesso. Canal público: segue a configuração de avatares.
    const { canAccessRoom } = await import('../services/rooms');
    const visible = !!r && (r.t === 'c' && avatarsPublic() ? true : !!req.ctx && (await canAccessRoom(req.ctx.userId, r)));
    if (!visible) return reply.type('image/svg+xml').send(initialsSvg('#'));
    if (r.data) return reply.type(r.content_type).send(r.data);
    return reply.type('image/svg+xml').send(initialsSvg(r.fname || r.name || '#'));
  });
}

const COLORS = ['#1d74f5', '#2de0a5', '#f5455c', '#ffd21f', '#9f22c7', '#f38c39', '#10529e', '#158d65', '#cd1f35', '#5c1a7c'];

export function initialsSvg(name: string) {
  const clean = name.trim() || '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = COLORS[h % COLORS.length];
  const esc = initials.replace(/[<>&"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="${color}"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="600" fill="#fff">${esc}</text></svg>`;
}
