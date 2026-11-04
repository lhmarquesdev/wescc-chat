import type { FastifyInstance } from 'fastify';
import { b, route, str } from '../api/http';
import { one } from '../db/pool';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { withExtra } from '../services/messages';
import { hasPermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import { targetFor } from '@shared/translate';
import { LibreError } from './libre';
import { assertCanTranslate, saveRoomTranslate, supportedLanguages, testConnection, translateMessages } from './service';

// Rotas autoTranslate.* (nomes e formato do Rocket.Chat). Todas pedem login; a permissão auto-translate é conferida
// dentro, com o texto em português. Nenhuma grava auditoria por tradução (seria uma linha por mensagem lida).
export function translateRoutes(app: FastifyInstance) {
  // targetLanguage é aceito e ignorado: os nomes vêm do servidor e a web os mostra em português.
  route(app, 'GET', 'autoTranslate.getSupportedLanguages', {}, async (_req, _rep, ctx) => {
    await assertCanTranslate(ctx);
    const user = await one('SELECT preferences FROM users WHERE id = $1', [ctx.userId]);
    const r = await supportedLanguages();
    return { ...r, defaultLanguage: targetFor({ prefs: user?.preferences, siteLanguage: getSetting<string>('Language') }) };
  });

  route(app, 'POST', 'autoTranslate.saveSettings', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await saveRoomTranslate(ctx, str(body.roomId, 'roomId', { max: 64 }), body.field, body.value, body.defaultLanguage);
    return {};
  });

  route(app, 'POST', 'autoTranslate.translateMessages', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return translateMessages(ctx, str(body.roomId, 'roomId', { max: 64 }), body.messageIds, body.targetLanguage);
  });

  // Uma mensagem, no formato do Rocket.Chat: message.translations[idioma] = texto (vazio quando não traduziu).
  route(app, 'POST', 'autoTranslate.translateMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const id = str(body.messageId, 'messageId', { max: 64 });
    const row = await one('SELECT * FROM messages WHERE id = $1', [id]);
    if (!row) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
    const r = await translateMessages(ctx, row.room_id, [id], body.targetLanguage);
    const t = r.translations[0];
    const translations: Record<string, string> = t?.status === 'translated' && t.text ? { [r.language]: t.text } : {};
    return { message: { ...withExtra(row), translations }, ...(r.notice ? { notice: r.notice } : {}) };
  });

  // Testa o rascunho da tela, sem precisar salvar (apiKey '********' ou ausente = a gravada).
  route(app, 'POST', 'autoTranslate.testConnection', {}, async (req, _rep, ctx) => {
    if (!(await hasPermission(ctx.userId, 'edit-privileged-setting'))) throw new ApiError(403, 'error-not-allowed', 'Você não tem permissão para alterar as configurações.');
    const body = b(req);
    const url = typeof body.url === 'string' ? body.url : undefined;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    try {
      return await testConnection({ url, apiKey });
    } catch (e) {
      if (e instanceof LibreError) throw badRequest('error-translate-connection', `Falha na conexão: ${e.message}`);
      throw e;
    }
  });
}
