import type { FastifyInstance } from 'fastify';
import { acceptCall, callConfig, declineCall, endCall, getCall, listCalls, startCall } from '../services/calls';
import { b, paging, q, route, str } from './http';

// Chamadas de voz e vídeo em mensagens diretas (estado e histórico; a mídia vai por WebRTC).
export function callsRoutes(app: FastifyInstance) {
  route(app, 'GET', 'calls.config', {}, async () => callConfig());
  route(app, 'POST', 'calls.start', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return { call: await startCall(ctx, { roomId: str(body.roomId, 'roomId'), kind: body.kind === 'video' ? 'video' : body.kind === 'audio' ? 'audio' : body.kind, connectionId: body.connectionId }) };
  });
  route(app, 'POST', 'calls.accept', {}, async (req, _rep, ctx) => ({ call: await acceptCall(ctx, str(b(req).callId, 'callId'), b(req).connectionId) }));
  route(app, 'POST', 'calls.decline', {}, async (req, _rep, ctx) => ({ call: await declineCall(ctx, str(b(req).callId, 'callId')) }));
  route(app, 'POST', 'calls.end', {}, async (req, _rep, ctx) => ({ call: await endCall(ctx, str(b(req).callId, 'callId')) }));
  route(app, 'GET', 'calls.info', {}, async (req, _rep, ctx) => ({ call: await getCall(ctx, str(q(req).callId, 'callId')) }));
  route(app, 'GET', 'calls.list', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await listCalls(ctx, p);
    return { ...r, count: r.calls.length, offset: p.offset };
  });
}
