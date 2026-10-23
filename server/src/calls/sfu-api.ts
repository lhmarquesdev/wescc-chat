import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CALL_LIMITS } from '@shared/calls';
import { route } from '../api/http';
import { config } from '../config';
import { ApiError, forbidden } from '../lib/errors';
import { newId } from '../lib/ids';
import { getSetting } from '../services/settings';
import { tlsStatus } from '../tls';
import { hit } from './limits';
import { joinToken, sfu, sfuConfig, sfuHealth, verifyWebhook } from './livekit';
import { currentCallOf, totalPresent } from './model';
import { handleSfuEvent } from './presence';
import { bridgeStats, closeBridges, sfuAdmission } from './sfu-bridge';

// Rotas HTTP do servidor de chamadas: o que o livekit-client pede por HTTP no /sfu, os webhooks do LiveKit, o estado
// para o Admin › Chamadas e o autoteste de conexão.

// Só a raiz (o HEAD que o cliente manda) e o validate; o resto do LiveKit não aparece no /sfu.
const PASSTHROUGH = /^\/sfu(?:\/rtc(?:\/v1)?\/validate)?\/?$/;
const UNAVAILABLE = 'Servidor de chamadas indisponível.';
const SFU_DOWN = 'O servidor de chamadas não está respondendo. Tente de novo em instantes ou avise o administrador.';

function text(reply: FastifyReply, status: number, body: string) {
  return reply.code(status).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(body);
}

async function passthrough(req: FastifyRequest, reply: FastifyReply) {
  const url = req.raw.url ?? req.url;
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q);
  if (!PASSTHROUGH.test(path)) return text(reply, 404, 'Não encontrado.');
  const c = sfuConfig();
  if (!c.configured) return text(reply, 502, UNAVAILABLE);
  if (path.includes('/validate')) {
    // A mesma resposta que a ponte daria: é por aqui que o livekit-client descobre por que o WebSocket foi recusado.
    const a = await sfuAdmission(new URLSearchParams(query.slice(1)).get('access_token'), req.ip);
    if (!a.ok) return text(reply, a.status, a.status === 503 ? UNAVAILABLE : 'acesso recusado');
  }
  const upstreamPath = path.replace(/^\/sfu/, '').replace(/(.)\/$/, '$1') || '/';
  const headers: Record<string, string> = {};
  if (req.headers.accept) headers.accept = String(req.headers.accept);
  if (req.headers['user-agent']) headers['user-agent'] = String(req.headers['user-agent']);
  let res: Response;
  let body: Buffer;
  try {
    res = await fetch(c.url + upstreamPath + query, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    body = Buffer.from(await res.arrayBuffer());
  } catch {
    return text(reply, 502, UNAVAILABLE);
  }
  // Só o status, o tipo e o corpo: nada de cookies nem cabeçalhos do LiveKit.
  reply.code(res.status).header('cache-control', 'no-store');
  const type = res.headers.get('content-type');
  if (type) reply.type(type);
  return reply.send(body);
}

export function sfuRoutes(app: FastifyInstance): void {
  app.route({ method: 'GET', url: '/sfu', logLevel: 'warn', handler: passthrough });
  app.route({ method: 'GET', url: '/sfu/*', logLevel: 'warn', handler: passthrough });
  app.addHook('preClose', (done) => {
    closeBridges();
    done();
  });

  // Webhooks do LiveKit: o corpo cru é o que a assinatura cobre.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
  app.post('/sfu-webhook', { logLevel: 'warn' }, async (req, reply) => {
    const ev = typeof req.body === 'string' ? verifyWebhook(req.body, req.headers.authorization) : null;
    if (!ev) return reply.code(401).send({ success: false });
    // Responde na hora (o LiveKit não espera o processamento); erros ficam no log, nunca voltam para ele.
    reply.send({ success: true });
    setImmediate(() => {
      Promise.resolve()
        .then(() => handleSfuEvent(ev))
        .catch((e) => req.log.error({ err: e, event: ev.event, room: ev.room?.name }, 'Falha ao tratar um webhook do servidor de chamadas.'));
    });
    return reply;
  });

  route(app, 'GET', 'calls.sfu.status', { permissions: ['manage-calls'] }, async (req) => {
    const c = sfuConfig();
    const h = await sfuHealth();
    return {
      configured: c.configured,
      reachable: h.ok,
      latencyMs: h.latencyMs,
      rooms: h.rooms ?? null,
      participants: h.participants ?? null,
      ...(h.error ? { error: h.error } : {}),
      url: c.url,
      urlFromEnv: !!config.livekit.url,
      groupEnabled: !!getSetting('Calls_Group_Enabled'),
      directViaSfu: !!getSetting('Calls_Direct_Via_SFU'),
      tls: tlsStatus(),
      secure: req.protocol === 'https',
      bridges: bridgeStats(),
      present: await totalPresent(),
      maxPresent: Number(getSetting('Calls_Max_Total_Participants')),
    };
  });

  // Autoteste: sala temporária wc_test_ e um token sem lista de fontes (o ConnectionCheck publica uma faixa sem
  // fonte e abre uma sala nova por etapa com o mesmo token). A varredura apaga essas salas depois de 10 min.
  route(app, 'POST', 'calls.selfTest', {}, async (_req, _rep, ctx) => {
    if (!getSetting('Calls_Enabled')) throw forbidden('As chamadas estão desativadas.');
    if (!sfuConfig().configured) throw new ApiError(503, 'error-call-sfu-unavailable', SFU_DOWN);
    if (await currentCallOf(ctx.userId)) throw new ApiError(409, 'error-call-in-progress', 'Saia da chamada para testar a conexão.');
    hit(ctx.userId, 'selftest', 3, 60_000);
    const room = `wc_test_${newId()}`;
    try {
      await sfu.createRoom(room, { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 3 });
    } catch {
      throw new ApiError(503, 'error-call-sfu-unavailable', SFU_DOWN);
    }
    return joinToken({ room, identity: ctx.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: CALL_LIMITS.selfTestTokenSeconds });
  });
}
