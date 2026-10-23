import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { config } from './config';
import { adminRoutes } from './api/admin';
import { chatRoutes } from './api/chat';
import { authenticate, errorHandler } from './api/http';
import { roomsRoutes } from './api/rooms';
import { usersRoutes } from './api/users';
import { registerWebsocket } from './realtime/ws';
import { isCorsOriginAllowed } from './services/origins';
import { getSetting } from './services/settings';
import { MAX_HEADER_SIZE, safeReq } from './tls';

export async function buildApp(opts: { logger?: boolean; https?: https.ServerOptions | null } = {}) {
  const base = {
    logger: opts.logger === false ? false : { level: config.logLevel, serializers: { req: safeReq } },
    // Com HTTPS próprio não há proxy na frente: X-Forwarded-For só vale de quem TRUST_PROXY indicar.
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  };
  // maxHeaderSize: o livekit-client põe a oferta SDP compactada na consulta do /sfu, e o Node conta a linha da
  // requisição nos 16 KiB padrão.
  const app = (opts.https
    ? Fastify({ ...base, https: { maxHeaderSize: MAX_HEADER_SIZE, ...opts.https } })
    : Fastify({ ...base, http: { maxHeaderSize: MAX_HEADER_SIZE } })) as unknown as FastifyInstance;

  // Sem cookies entre sites (o cookie de sessão só vale para leituras na mesma origem); outros sites só com CORS ligado.
  await app.register(cors, { origin: (origin, cb) => cb(null, isCorsOriginAllowed(origin)), credentials: false });
  // Campos de texto limitados em todas as rotas multipart (o padrão do busboy é 1 MB por campo, sem limite de quantidade).
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 20, parts: 21, fieldSize: 64 * 1024 } });
  // Upgrades do /sfu vão para a ponte do servidor de chamadas (servidor ws próprio, 1 MiB por quadro); os demais
  // seguem para o @fastify/websocket com 64 KiB, como antes.
  const chatUpgrades = new EventEmitter();
  await app.register(websocket, { options: { maxPayload: 64 * 1024, server: chatUpgrades as unknown as http.Server } });
  const { isSfuUpgrade, sfuUpgrade, useBridgeLogger } = await import('./calls/sfu-bridge');
  useBridgeLogger(app.log);
  app.server.on('upgrade', (req, socket, head) => {
    if (isSfuUpgrade(req.url)) sfuUpgrade(req, socket, head);
    else chatUpgrades.emit('upgrade', req, socket, head);
  });
  await app.register(rateLimit, {
    global: true,
    max: () => (getSetting('API_Enable_Rate_Limiter') ? getSetting<number>('API_Enable_Rate_Limiter_Limit_Calls_Default') : 1_000_000),
    timeWindow: 60_000,
    // Usuário autenticado (o hook de autenticação roda antes) ou IP; nunca o cabeçalho x-user-id sem token.
    keyGenerator: (req) => req.ctx?.userId || req.ip,
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, success: false, error: `Limite de requisições excedido. Tente novamente em ${Math.ceil(ctx.ttl / 1000)}s.`, errorType: 'error-too-many-requests' }),
  });

  app.decorateRequest('ctx', null);
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/file-upload/') || req.url.startsWith('/avatar/') || req.url.startsWith('/sticker/')) await authenticate(req);
  });
  app.setErrorHandler(errorHandler);

  usersRoutes(app);
  roomsRoutes(app);
  chatRoutes(app);
  adminRoutes(app);
  registerWebsocket(app);
  const { omnichannelRoutes } = await import('./omnichannel/api');
  omnichannelRoutes(app);
  const { integrationsRoutes } = await import('./integrations/api');
  integrationsRoutes(app);
  const { samlRoutes } = await import('./saml/saml');
  samlRoutes(app);
  const { oauthRoutes } = await import('./oauth/api');
  oauthRoutes(app);
  const { callsRoutes } = await import('./api/calls');
  callsRoutes(app);
  const { sfuRoutes } = await import('./calls/sfu-api');
  sfuRoutes(app);
  const { ldapRoutes } = await import('./ldap/api');
  ldapRoutes(app);
  const { importRoutes } = await import('./importer/api');
  importRoutes(app);
  const { stickersRoutes } = await import('./stickers/api');
  stickersRoutes(app);

  app.get('/health', async () => ({ ok: true }));

  // Cliente web (build do Vite), com fallback para o index.html (SPA).
  const webDist = config.webDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
    // Relê o index.html quando o build muda (o nome dos assets muda a cada build).
    const indexPath = path.join(webDist, 'index.html');
    let cached = { mtime: 0, html: Buffer.alloc(0) };
    const indexHtml = () => {
      const mtime = fs.statSync(indexPath).mtimeMs;
      if (mtime !== cached.mtime) cached = { mtime, html: fs.readFileSync(indexPath) };
      return cached.html;
    };
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        const file = path.join(webDist, decodeURIComponent(req.url.split('?')[0]));
        if (file.startsWith(webDist) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(path.relative(webDist, file));
        return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml());
      }
      return reply.status(404).send({ success: false, error: 'Não encontrado.', errorType: 'error-not-found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ success: false, error: 'Não encontrado.', errorType: 'error-not-found' }));
  }
  return app;
}
