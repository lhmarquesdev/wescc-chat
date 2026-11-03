import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors';
import { contentDisposition } from '../services/exportRender';
import { createExportTicket, exportInfo, openExport, parseExportParams } from '../services/roomExport';
import { listDataDownloads, openDataDownload, requestDataDownload } from '../services/userData';
import { b, q, requireCtx, route, str } from './http';

// Exportar mensagens de uma sala e "Baixar meus dados" (LGPD).

// Rotas binárias ficam fora do route(): a trava de troca de senha ou 2FA pendente se repete aqui.
function binaryCtx(req: FastifyRequest) {
  const ctx = requireCtx(req);
  if (ctx.setup === 'password') throw new ApiError(403, 'error-password-change-required', 'Defina uma nova senha antes de continuar.');
  if (ctx.setup) throw new ApiError(403, 'error-2fa-setup-required', 'Configure a autenticação em dois fatores antes de continuar.');
  return ctx;
}

export function dataExportRoutes(app: FastifyInstance) {
  // ---------- Exportar mensagens ----------

  // Quantas mensagens e arquivos o período tem (a prévia do painel).
  route(app, 'GET', 'rooms.export.info', {}, async (req, _reply, ctx) => exportInfo(ctx, parseExportParams(q(req), { needFormat: false })));

  // Confere tudo e devolve o endereço de download, com um tíquete de uso único que vale por 2 minutos.
  route(app, 'POST', 'rooms.export', {}, async (req, _reply, ctx) => createExportTicket(ctx, parseExportParams(b(req), { needFormat: true })));

  app.get('/api/v1/rooms.export.download', async (req, reply) => {
    const ctx = binaryCtx(req);
    const out = await openExport(ctx, String(q(req).ticket ?? ''));
    out.stream.on('error', (e) => req.log.error({ err: e }, 'exportação de mensagens interrompida'));
    reply.header('Content-Type', out.contentType);
    reply.header('Content-Disposition', contentDisposition(out.fileName));
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    // O HTML exportado nunca roda nada nem carrega nada de fora, mesmo que um navegador o abra aqui em vez de baixar.
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return reply.send(out.stream);
  });

  // ---------- Meus dados (LGPD) ----------

  // POST: cria uma tarefa (o GET aceita o cookie de sessão, que vale para leituras).
  route(app, 'POST', 'users.requestDataDownload', {}, async (_req, _reply, ctx) => ({ request: await requestDataDownload(ctx) }));

  route(app, 'GET', 'users.dataDownloads.list', {}, async (_req, _reply, ctx) => listDataDownloads(ctx));

  app.get('/api/v1/users.dataDownloads.file', async (req, reply) => {
    const ctx = binaryCtx(req);
    const out = await openDataDownload(ctx, str(q(req).id, 'id', { max: 64 }));
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Length', String(out.size));
    reply.header('Content-Disposition', contentDisposition(out.fileName));
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(out.stream);
  });
}
