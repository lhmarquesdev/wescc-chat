import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import {
  myKeys,
  rejectSuggestedKey,
  requestKeys,
  resetRoomKey,
  resetUserKeys,
  roomKeys,
  roomsToProvide,
  setMyKeys,
  setRoomKeyId,
  updateGroupKey,
  usersWithoutKey,
} from '../services/e2e';
import { check2fa, getUserById } from '../services/users';
import { getSetting } from '../services/settings';
import { b, q, route, str } from './http';

// Criptografia de ponta a ponta: os nomes das rotas seguem as do Rocket.Chat (e2e.*). Todas pedem login; as regras de
// quem participa da conversa ficam em services/e2e.ts.
export function e2eRoutes(app: FastifyInstance) {
  route(app, 'GET', 'e2e.fetchMyKeys', {}, async (_req, _rep, ctx) => myKeys(ctx.userId));
  route(app, 'POST', 'e2e.setUserPublicAndPrivateKeys', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await setMyKeys(ctx, body.public_key, body.private_key);
    return {};
  });
  route(app, 'GET', 'e2e.fetchRoomKeys', {}, async (req, _rep, ctx) => roomKeys(ctx, str(q(req).rid, 'rid')));
  route(app, 'GET', 'e2e.getUsersOfRoomWithoutKey', {}, async (req, _rep, ctx) => usersWithoutKey(ctx, str(q(req).rid, 'rid'), q(req).keyID || undefined));
  route(app, 'POST', 'e2e.setRoomKeyID', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await setRoomKeyId(ctx, str(body.rid, 'rid'), body.keyID, body.key);
    return {};
  });
  route(app, 'POST', 'e2e.updateGroupKey', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return updateGroupKey(ctx, str(body.rid, 'rid'), body.keyID, body.keys);
  });
  route(app, 'POST', 'e2e.resetRoomKey', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return resetRoomKey(ctx, str(body.rid, 'rid'), body.prevKeyID, body.keyID, body.keys);
  });
  route(app, 'POST', 'e2e.rejectSuggestedGroupKey', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await rejectSuggestedKey(ctx, str(body.rid, 'rid'), body.keyID);
    return {};
  });
  route(app, 'POST', 'e2e.requestSubscriptionKeys', {}, async (req, _rep, ctx) => requestKeys(ctx, b(req).rid || undefined));
  // Próprio do Wescc: onde quem acabou de desbloquear tem chave para entregar (ou para trocar).
  route(app, 'GET', 'e2e.fetchRoomsToProvide', {}, async (_req, _rep, ctx) => roomsToProvide(ctx));
  // Esqueci a senha da criptografia: confirma a senha de entrar (contas com senha) e o 2FA (quando ligado).
  route(app, 'POST', 'e2e.resetOwnE2EKey', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const u = await getUserById(ctx.userId);
    if (u.password_hash) {
      const { verifyPassword } = await import('../lib/password');
      if (typeof body.password !== 'string' || !(await verifyPassword(body.password, u.password_hash))) throw badRequest('error-invalid-password', 'Senha incorreta.');
    }
    if (u.totp_enabled && getSetting('Accounts_TwoFactorAuthentication_Enabled')) {
      if (typeof body.code !== 'string' || !(await check2fa(u, body.code))) throw badRequest('invalid-totp', 'Código inválido.');
    }
    await resetUserKeys(ctx, ctx.userId, { self: true });
    return {};
  });
}
