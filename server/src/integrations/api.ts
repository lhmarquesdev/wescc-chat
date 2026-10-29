import type { FastifyInstance } from 'fastify';
import { b, paging, q, route, str } from '../api/http';
import { badRequest } from '../lib/errors';
import { integrationsCoreRoutes } from './core-api';
import { jiraRoutes } from './jira/api';
import { msteamsRoutes } from './msteams/api';
import {
  clearHistory,
  createIntegration,
  getIntegration,
  handleIncoming,
  integrationHistory,
  listIntegrations,
  registerIntegrationHooks,
  removeIntegration,
  updateIntegration,
  OUTGOING_EVENTS,
} from './service';

export function integrationsRoutes(app: FastifyInstance) {
  registerIntegrationHooks();

  route(app, 'POST', 'integrations.create', {}, async (req, _r, ctx) => ({ integration: await createIntegration(ctx, b(req) as any) }));
  route(app, 'GET', 'integrations.list', {}, async (req, _r, ctx) => {
    const { offset, count } = paging(q(req));
    return listIntegrations(ctx, { type: q(req).type, name: q(req).name, offset, count });
  });
  route(app, 'GET', 'integrations.get', {}, async (req, _r, ctx) => ({ integration: await getIntegration(ctx, str(q(req).integrationId, 'integrationId')) }));
  route(app, 'PUT', 'integrations.update', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { integration: await updateIntegration(ctx, str(body.integrationId, 'integrationId'), body as any) };
  });
  route(app, 'POST', 'integrations.remove', {}, async (req, _r, ctx) => {
    const body = b(req);
    const id = str(body.integrationId, 'integrationId');
    const integration = await getIntegration(ctx, id);
    await removeIntegration(ctx, id);
    return { integration };
  });
  route(app, 'GET', 'integrations.history', {}, async (req, _r, ctx) => {
    const { offset, count } = paging(q(req));
    return integrationHistory(ctx, str(q(req).id, 'id'), offset, count);
  });
  route(app, 'POST', 'integrations.clearHistory', {}, async (req, _r, ctx) => {
    await clearHistory(ctx, str(b(req).integrationId, 'integrationId'));
    return {};
  });
  route(app, 'GET', 'integrations.events', {}, async () => ({ events: OUTGOING_EVENTS }));

  // Webhook de entrada: sem autenticação de usuário; o token da URL identifica a integração.
  const incoming = async (req: any) => {
    const { id, token } = req.params as { id: string; token: string };
    if (!id || !token) throw badRequest('error-invalid-integration', 'URL inválida.');
    return handleIncoming(id, token, { body: req.body, headers: req.headers, url: req.url, query: req.query ?? {} });
  };
  app.post('/hooks/:id/:token', incoming);
  app.get('/hooks/:id/:token', incoming);
  // Formulários (formato do Slack) chegam como application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Integrações (Jira/Teams)
  integrationsCoreRoutes(app);
  jiraRoutes(app);
  msteamsRoutes(app);
}
