import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { b, paging, q, route, str, strArray } from '../api/http';
import { inlineMimeType, safeMimeType } from '../services/uploads';
import {
  activity,
  createFolder,
  driveHome,
  fileForDownload,
  folderView,
  listTrash,
  moveItems,
  purgeItems,
  recent,
  renameFile,
  restoreItems,
  search,
  searchSubjects,
  setAcl,
  storage,
  trashItems,
  updateFolder,
  uploadFile,
} from './drive';

// Arquivos: a aba de pastas compartilhadas. Toda rota pede view-files (ou manage-all-files); cada pasta confere o resto.
const P = { permissions: ['view-files', 'manage-all-files'] };
const id = (v: unknown, name: string) => str(v, name, { max: 64 });
const items = (body: Record<string, any>) => ({ fileIds: strArray(body.fileIds), folderIds: strArray(body.folderIds) });

export function driveRoutes(app: FastifyInstance) {
  route(app, 'GET', 'files.home', P, async (_req, _r, ctx) => driveHome(ctx));
  route(app, 'GET', 'files.folder', P, async (req, _r, ctx) => folderView(ctx, id(q(req).folderId, 'folderId')));
  route(app, 'GET', 'files.search', P, async (req, _r, ctx) => search(ctx, q(req).text));
  route(app, 'GET', 'files.recent', P, async (_req, _r, ctx) => recent(ctx));
  route(app, 'GET', 'files.storage', P, async () => ({ storage: await storage() }));
  route(app, 'GET', 'files.activity', P, async (req, _r, ctx) => activity(ctx, id(q(req).folderId, 'folderId'), paging(q(req))));
  route(app, 'GET', 'files.subjects', P, async (req, _r, ctx) => ({ subjects: await searchSubjects(ctx, q(req).text) }));

  route(app, 'POST', 'files.folder.create', P, async (req, _r, ctx) => ({ folder: await createFolder(ctx, b(req)) }));
  route(app, 'POST', 'files.folder.update', P, async (req, _r, ctx) => updateFolder(ctx, id(b(req).folderId, 'folderId'), b(req)));
  route(app, 'POST', 'files.folder.share', P, async (req, _r, ctx) => setAcl(ctx, id(b(req).folderId, 'folderId'), b(req)));
  route(app, 'POST', 'files.upload/:folderId', P, async (req: any, _r, ctx) => ({ file: await uploadFile(ctx, req.params.folderId, req) }));
  route(app, 'POST', 'files.rename', P, async (req, _r, ctx) => renameFile(ctx, id(b(req).fileId, 'fileId'), b(req).name));
  route(app, 'POST', 'files.move', P, async (req, _r, ctx) => moveItems(ctx, { ...items(b(req)), targetId: b(req).targetId }));
  route(app, 'POST', 'files.trash', P, async (req, _r, ctx) => trashItems(ctx, items(b(req))));
  route(app, 'GET', 'files.trash.list', P, async (_req, _r, ctx) => listTrash(ctx));
  route(app, 'POST', 'files.restore', P, async (req, _r, ctx) => restoreItems(ctx, items(b(req))));
  route(app, 'POST', 'files.purge', P, async (req, _r, ctx) => purgeItems(ctx, { ...items(b(req)), all: b(req).all === true }));

  // Download e pré-visualização (o cookie de sessão vale para GET). Mesmas proteções dos anexos do chat.
  app.get('/file-upload/drive/:id/*', async (req: any, reply) => {
    const download = q(req).download !== undefined;
    const f = await fileForDownload(req.ctx, String(req.params.id), download);
    const type = safeMimeType(f.type);
    const inline = inlineMimeType(type);
    reply.header('Content-Type', type);
    reply.header('Content-Length', f.size);
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    const csp = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
    reply.header('Content-Security-Policy', type === 'application/pdf' ? csp : `${csp}; sandbox`);
    reply.header('Content-Disposition', `${inline && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(fs.createReadStream(f.absPath));
  });
}
