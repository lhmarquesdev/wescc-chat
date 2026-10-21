import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
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
import { getSetting } from './services/settings';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(rateLimit, {
    global: true,
    max: () => (getSetting('API_Enable_Rate_Limiter') ? getSetting<number>('API_Enable_Rate_Limiter_Limit_Calls_Default') : 1_000_000),
    timeWindow: 60_000,
    keyGenerator: (req) => (req.headers['x-user-id'] as string) || req.ip,
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, success: false, error: `Limite de requisições excedido. Tente novamente em ${Math.ceil(ctx.ttl / 1000)}s.`, errorType: 'error-too-many-requests' }),
  });

  app.decorateRequest('ctx', null);
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/file-upload/')) await authenticate(req);
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

  app.get('/health', async () => ({ ok: true }));

  // Cliente web (build do Vite), com fallback para o index.html (SPA).
  const webDist = config.webDist ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
    const indexHtml = fs.readFileSync(path.join(webDist, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        const file = path.join(webDist, decodeURIComponent(req.url.split('?')[0]));
        if (file.startsWith(webDist) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(path.relative(webDist, file));
        return reply.type('text/html').send(indexHtml);
      }
      return reply.status(404).send({ success: false, error: 'Não encontrado.', errorType: 'error-not-found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ success: false, error: 'Não encontrado.', errorType: 'error-not-found' }));
  }
  return app;
}
