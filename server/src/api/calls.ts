import type { FastifyInstance } from 'fastify';
import type { CallKind, CallModerationAction } from '@shared/index';
import '../calls/hooks';
import { inviteRoom, joinCall, ringPeople } from '../calls/group';
import { setHand } from '../calls/hands';
import { CALL_MODERATION_ACTIONS, moderate } from '../calls/moderation';
import { callsEnabled } from '../calls/policy';
import { entryGate, userLane } from '../calls/queue';
import { badRequest, forbidden } from '../lib/errors';
import {
  acceptCall,
  activeCalls,
  adminActiveCalls,
  adminEndCall,
  callConfig,
  declineCall,
  endCall,
  getCall,
  inCall,
  leave,
  listCalls,
  markSeen,
  missedCount,
  roomCallState,
  startCall,
  type CallListFilter,
} from '../services/calls';
import { b, bool, paging, q, route, str, strArray } from './http';

// Chamadas de voz e vídeo: a dois (P2P, como sempre) e em grupo (pelo servidor de chamadas). A entrada é validada
// aqui, antes de qualquer contagem de limite. Iniciar, entrar e atender da mesma pessoa rodam um de cada vez (G27).

const FILTERS: CallListFilter[] = ['all', 'missed', 'incoming', 'outgoing'];
const engines = (v: unknown) => strArray(v).slice(0, 4);
const callIdOf = (body: Record<string, any>) => str(body.callId, 'callId', { max: 64 });

function assertEnabled() {
  if (!callsEnabled()) throw forbidden('As chamadas estão desativadas.');
}

export function callsRoutes(app: FastifyInstance) {
  route(app, 'GET', 'calls.config', {}, async (_req, _rep, ctx) => callConfig(ctx.userId));

  route(app, 'POST', 'calls.start', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const input = {
      roomId: str(body.roomId, 'roomId', { max: 64 }),
      kind: body.kind as CallKind,
      connectionId: body.connectionId,
      leaveCurrent: !!bool(body.leaveCurrent),
      engines: engines(body.engines),
    };
    return userLane(ctx.userId, () => startCall(ctx, input));
  });
  route(app, 'POST', 'calls.join', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const callId = callIdOf(body);
    assertEnabled();
    const leaveCurrent = !!bool(body.leaveCurrent);
    return userLane(ctx.userId, () => entryGate(() => joinCall(ctx, callId, { leaveCurrent })));
  });
  route(app, 'POST', 'calls.accept', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const callId = callIdOf(body);
    const o = { connectionId: body.connectionId, leaveCurrent: !!bool(body.leaveCurrent), engines: engines(body.engines) };
    return userLane(ctx.userId, () => acceptCall(ctx, callId, o));
  });
  route(app, 'POST', 'calls.decline', {}, async (req, _rep, ctx) => ({ call: await declineCall(ctx, callIdOf(b(req))) }));
  route(app, 'POST', 'calls.leave', {}, async (req, _rep, ctx) => ({ call: await leave(ctx, callIdOf(b(req))) }));
  route(app, 'POST', 'calls.end', {}, async (req, _rep, ctx) => ({ call: await endCall(ctx, callIdOf(b(req))) }));

  route(app, 'POST', 'calls.ring', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const callId = callIdOf(body);
    if (!Array.isArray(body.userIds)) throw badRequest('error-invalid-params', 'O parâmetro "userIds" deve ser uma lista.');
    const userIds = strArray(body.userIds);
    assertEnabled();
    return ringPeople(ctx, callId, userIds);
  });
  route(app, 'POST', 'calls.invite', {}, async (req, _rep, ctx) => {
    const callId = callIdOf(b(req));
    assertEnabled();
    return inviteRoom(ctx, callId);
  });
  route(app, 'POST', 'calls.hand', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const callId = callIdOf(body);
    const raised = bool(body.raised);
    if (raised === undefined) throw badRequest('error-invalid-params', 'O parâmetro "raised" é obrigatório.');
    return setHand(ctx, callId, raised);
  });
  route(app, 'POST', 'calls.moderate', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const callId = callIdOf(body);
    const userId = str(body.userId, 'userId', { max: 64 });
    const action = body.action as CallModerationAction;
    if (!CALL_MODERATION_ACTIONS.includes(action)) throw badRequest('error-invalid-params', 'Ação de moderação inválida.');
    return moderate(ctx, { callId, userId, action });
  });

  route(app, 'GET', 'calls.info', {}, async (req, _rep, ctx) => ({ call: await getCall(ctx, str(q(req).callId, 'callId', { max: 64 })) }));
  route(app, 'GET', 'calls.active', {}, async (_req, _rep, ctx) => activeCalls(ctx));
  route(app, 'GET', 'calls.roomCall', {}, async (req, _rep, ctx) => roomCallState(ctx, str(q(req).roomId, 'roomId', { max: 64 })));
  route(app, 'GET', 'calls.inCall', {}, async (req) => {
    const ids = [...new Set(strArray(q(req).userIds))];
    if (ids.length > 200) throw badRequest('error-invalid-params', 'Informe até 200 usuários.');
    return inCall(ids);
  });
  route(app, 'GET', 'calls.list', {}, async (req, _rep, ctx) => {
    const query = q(req);
    const p = paging(query);
    const filter = (query.filter || 'all') as CallListFilter;
    if (!FILTERS.includes(filter)) throw badRequest('error-invalid-params', 'Filtro inválido.');
    const roomId = str(query.roomId, 'roomId', { optional: true, max: 64 });
    const r = await listCalls(ctx, { ...p, filter, roomId });
    return { ...r, count: r.calls.length, offset: p.offset };
  });
  route(app, 'GET', 'calls.missedCount', {}, async (_req, _rep, ctx) => ({ count: await missedCount(ctx) }));
  route(app, 'POST', 'calls.seen', {}, async (_req, _rep, ctx) => {
    await markSeen(ctx);
    return {};
  });

  route(app, 'GET', 'calls.admin.active', { permissions: ['manage-calls'] }, async () => adminActiveCalls());
  route(app, 'POST', 'calls.admin.end', { permissions: ['manage-calls'] }, async (req, _rep, ctx) => ({ call: await adminEndCall(ctx, callIdOf(b(req))) }));
}
