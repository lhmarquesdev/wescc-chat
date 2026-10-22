import type { FastifyInstance } from 'fastify';
import { b, bool, paging, q, requireCtx, route, str, strArray } from '../api/http';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { stickerFilesRoutes } from './files';
import { listBlocked, removeEverywhere, stickerUsage, unblockFile } from './moderation';
import { sendSticker } from './send';
import {
  clearRecents,
  createPack,
  createSticker,
  deletePack,
  deleteSticker,
  exportPack,
  flushStickerNotifications,
  moveSticker,
  myCatalog,
  orgCatalog,
  packInfo,
  removeRecent,
  reorderPacks,
  reorderStickers,
  saveSticker,
  setFavorite,
  stickerRoleFlags,
  updatePack,
  updateSticker,
} from './service';

// Rotas REST das figurinhas (§3.13) e as dos bytes.

// RFC 8187: encodeURIComponent deixa ' ( ) * ! passarem, e um apóstrofo a mais faz o Chrome ignorar o filename*.
const extValue = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const opt = (v: unknown, name: string) => str(v, name, { optional: true, max: 64 }) || undefined;

// Um dos três alvos: arquivo, figurinha ou mensagem.
const targetOf = (body: Record<string, any>) => ({
  fileId: opt(body.fileId, 'fileId'),
  stickerId: opt(body.stickerId, 'stickerId'),
  messageId: opt(body.messageId, 'messageId'),
});

export function stickersRoutes(app: FastifyInstance) {
  stickerFilesRoutes(app);

  route(app, 'GET', 'stickers.list', {}, async (req, _reply, ctx) => {
    const query = q(req);
    const version = query.version ? String(query.version).slice(0, 100) : undefined;
    if (query.scope === 'org') return orgCatalog(ctx, { includeDrafts: bool(query.includeDrafts) === true, version });
    if (query.scope === 'mine') return myCatalog(ctx, { version });
    throw badRequest('error-invalid-params', 'O parâmetro "scope" deve ser "org" ou "mine".');
  });

  route(app, 'POST', 'chat.sendSticker', {}, async (req, _reply, ctx) => {
    const body = b(req);
    const message = await sendSticker(ctx, {
      roomId: str(body.roomId, 'roomId', { max: 64 }),
      stickerId: opt(body.stickerId, 'stickerId'),
      fileId: opt(body.fileId, 'fileId'),
      tmid: opt(body.tmid, 'tmid') ?? null,
      tshow: bool(body.tshow),
      quoteMessageId: opt(body.quoteMessageId, 'quoteMessageId'),
      _id: opt(body._id, '_id'),
    });
    return { message };
  });

  route(app, 'POST', 'stickers.favorite', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return setFavorite(ctx, targetOf(body), bool(body.favorite) ?? true);
  });

  route(app, 'POST', 'stickers.recents.remove', {}, async (req, _reply, ctx) => {
    await removeRecent(ctx, str(b(req).fileId, 'fileId', { max: 64 }));
    return {};
  });

  route(app, 'POST', 'stickers.recents.clear', {}, async (_req, _reply, ctx) => {
    await clearRecents(ctx);
    return {};
  });

  route(app, 'POST', 'stickers.save', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return saveSticker(ctx, targetOf(body), { packId: opt(body.packId, 'packId'), name: body.name, emojis: body.emojis, keywords: body.keywords });
  });

  // Multipart, campos antes dos arquivos.
  route(app, 'POST', 'stickers.create', {}, async (req, _reply, ctx) => {
    if (!(req as any).isMultipart?.()) throw badRequest('error-invalid-params', 'Envie a figurinha como multipart/form-data.');
    return createSticker(ctx, req);
  });

  route(app, 'POST', 'stickers.import.done', {}, async (req, _reply, ctx) => {
    const scope = b(req).scope;
    if (scope === 'org') {
      if (!(await stickerRoleFlags(ctx.userId)).manager) throw forbidden();
      flushStickerNotifications('org');
    } else if (scope === 'mine') flushStickerNotifications(`mine:${ctx.userId}`);
    else throw badRequest('error-invalid-params', 'O parâmetro "scope" deve ser "org" ou "mine".');
    return {};
  });

  route(app, 'POST', 'stickers.update', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return updateSticker(ctx, { stickerId: str(body.stickerId, 'stickerId', { max: 64 }), name: body.name, emojis: body.emojis, keywords: body.keywords });
  });

  route(app, 'POST', 'stickers.delete', {}, async (req, _reply, ctx) => {
    await deleteSticker(ctx, str(b(req).stickerId, 'stickerId', { max: 64 }));
    return {};
  });

  route(app, 'POST', 'stickers.reorder', {}, async (req, _reply, ctx) => {
    const body = b(req);
    await reorderStickers(ctx, str(body.packId, 'packId', { max: 64 }), strArray(body.stickerIds));
    return {};
  });

  route(app, 'POST', 'stickers.move', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return moveSticker(ctx, str(body.stickerId, 'stickerId', { max: 64 }), str(body.packId, 'packId', { max: 64 }));
  });

  route(app, 'POST', 'stickers.packs.create', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return createPack(ctx, {
      scope: body.scope,
      name: body.name,
      description: body.description,
      status: body.status,
      visibleRoles: body.visibleRoles === undefined ? undefined : strArray(body.visibleRoles),
    });
  });

  route(app, 'POST', 'stickers.packs.update', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return updatePack(ctx, {
      packId: str(body.packId, 'packId', { max: 64 }),
      name: body.name,
      description: body.description,
      status: body.status,
      visibleRoles: body.visibleRoles === undefined ? undefined : strArray(body.visibleRoles),
      coverStickerId: body.coverStickerId,
    });
  });

  route(app, 'POST', 'stickers.packs.delete', {}, async (req, _reply, ctx) => {
    await deletePack(ctx, str(b(req).packId, 'packId', { max: 64 }));
    return {};
  });

  route(app, 'POST', 'stickers.packs.reorder', {}, async (req, _reply, ctx) => {
    const body = b(req);
    await reorderPacks(ctx, body.scope, strArray(body.packIds));
    return {};
  });

  route(app, 'GET', 'stickers.packs.info', {}, async (req, _reply, ctx) => packInfo(ctx, str(q(req).packId, 'packId', { max: 64 })));

  // Binário: fora do route(), então a trava de pendência de senha ou 2FA se repete aqui.
  app.get('/api/v1/stickers.packs.export', async (req, reply) => {
    const ctx = requireCtx(req);
    if (ctx.setup === 'password') throw new ApiError(403, 'error-password-change-required', 'Defina uma nova senha antes de continuar.');
    if (ctx.setup) throw new ApiError(403, 'error-2fa-setup-required', 'Configure a autenticação em dois fatores antes de continuar.');
    const out = await exportPack(ctx, str(q(req).packId, 'packId', { max: 64 }));
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${out.fileName}"; filename*=UTF-8''${extValue(`figurinhas-${out.packName}.zip`)}`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(out.stream);
  });

  route(app, 'POST', 'stickers.removeEverywhere', {}, async (req, _reply, ctx) => {
    const body = b(req);
    return removeEverywhere(ctx, { fileId: opt(body.fileId, 'fileId'), messageId: opt(body.messageId, 'messageId'), reason: typeof body.reason === 'string' ? body.reason : undefined });
  });

  route(app, 'GET', 'stickers.blocked.list', {}, async (req, _reply, ctx) => {
    const query = q(req);
    return listBlocked(ctx, { text: query.text, ...paging(query) });
  });

  route(app, 'POST', 'stickers.blocked.unblock', {}, async (req, _reply, ctx) => {
    await unblockFile(ctx, str(b(req).fileId, 'fileId', { max: 64 }));
    return {};
  });

  route(app, 'GET', 'stickers.usage', {}, async (req, _reply, ctx) => {
    const query = q(req);
    return { usage: await stickerUsage(ctx, { fileId: opt(query.fileId, 'fileId'), messageId: opt(query.messageId, 'messageId') }) };
  });
}
