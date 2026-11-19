import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { b, paging, q, route, str, strArray } from '../api/http';
import { ApiError } from '../lib/errors';
import { inlineMimeType, safeMimeType } from '../services/uploads';
import {
  activity,
  assertDriveOn,
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
// Com a aba desligada (Drive_Enabled), nada dela responde, nem os downloads.
const P = { permissions: ['view-files', 'manage-all-files'] };
type Handler = Parameters<typeof route>[4];
const on =
  (h: Handler): Handler =>
  async (req, reply, ctx) => {
    assertDriveOn();
    return h(req, reply, ctx);
  };
const id = (v: unknown, name: string) => str(v, name, { max: 64 });
const items = (body: Record<string, any>) => ({ fileIds: strArray(body.fileIds), folderIds: strArray(body.folderIds) });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// O link do arquivo aberto direto no navegador (aba nova, link colado no chat): sem acesso, uma página em português em
// vez do JSON de erro. As prévias da tela (imagem, vídeo, texto, PDF) e o Baixar continuam com o erro de sempre.
const opensAsPage = (req: any) => {
  const dest = req.headers['sec-fetch-dest'];
  return dest ? dest === 'document' : String(req.headers.accept ?? '').includes('text/html');
};

function fileErrorPage(e: ApiError, loggedIn: boolean) {
  const text = !loggedIn
    ? 'Este link é de um arquivo da aba Arquivos. Entre com a sua conta e abra o arquivo pela pasta dele.'
    : e.statusCode === 404
      ? 'O arquivo foi apagado, ou você não tem acesso à pasta dele. Peça a quem gerencia a pasta para compartilhá-la com você.'
      : e.message;
  const link = loggedIn ? '<a href="/files">Ir para Arquivos</a>' : '<a href="/login?next=%2Ffiles">Entrar</a>';
  return (
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Arquivo indisponível</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;line-height:1.5"><h2>${loggedIn ? 'Não deu para abrir este arquivo' : 'Entre para abrir este arquivo'}</h2>` +
    `<p>${esc(text)}</p><p>${link}</p></body></html>`
  );
}

export function driveRoutes(app: FastifyInstance) {
  route(app, 'GET', 'files.home', P, on(async (_req, _r, ctx) => driveHome(ctx)));
  route(app, 'GET', 'files.folder', P, on(async (req, _r, ctx) => folderView(ctx, id(q(req).folderId, 'folderId'))));
  route(app, 'GET', 'files.search', P, on(async (req, _r, ctx) => search(ctx, q(req).text)));
  route(app, 'GET', 'files.recent', P, on(async (_req, _r, ctx) => recent(ctx)));
  route(app, 'GET', 'files.storage', P, on(async () => ({ storage: await storage() })));
  route(app, 'GET', 'files.activity', P, on(async (req, _r, ctx) => activity(ctx, id(q(req).folderId, 'folderId'), paging(q(req)))));
  route(app, 'GET', 'files.subjects', P, on(async (req, _r, ctx) => ({ subjects: await searchSubjects(ctx, q(req).text) })));

  route(app, 'POST', 'files.folder.create', P, on(async (req, _r, ctx) => ({ folder: await createFolder(ctx, b(req)) })));
  route(app, 'POST', 'files.folder.update', P, on(async (req, _r, ctx) => updateFolder(ctx, id(b(req).folderId, 'folderId'), b(req))));
  route(app, 'POST', 'files.folder.share', P, on(async (req, _r, ctx) => setAcl(ctx, id(b(req).folderId, 'folderId'), b(req))));
  route(app, 'POST', 'files.upload/:folderId', P, on(async (req: any, _r, ctx) => ({ file: await uploadFile(ctx, req.params.folderId, req) })));
  route(app, 'POST', 'files.rename', P, on(async (req, _r, ctx) => renameFile(ctx, id(b(req).fileId, 'fileId'), b(req).name)));
  route(app, 'POST', 'files.move', P, on(async (req, _r, ctx) => moveItems(ctx, { ...items(b(req)), targetId: b(req).targetId })));
  route(app, 'POST', 'files.trash', P, on(async (req, _r, ctx) => trashItems(ctx, items(b(req)))));
  route(app, 'GET', 'files.trash.list', P, on(async (_req, _r, ctx) => listTrash(ctx)));
  route(app, 'POST', 'files.restore', P, on(async (req, _r, ctx) => restoreItems(ctx, items(b(req)))));
  route(app, 'POST', 'files.purge', P, on(async (req, _r, ctx) => purgeItems(ctx, { ...items(b(req)), all: b(req).all === true })));

  // Download e pré-visualização (o cookie de sessão vale para GET). Mesmas proteções dos anexos do chat.
  app.get('/file-upload/drive/:id/*', async (req: any, reply) => {
    const download = q(req).download !== undefined;
    let f: Awaited<ReturnType<typeof fileForDownload>>;
    try {
      f = await fileForDownload(req.ctx, String(req.params.id), { download, preview: q(req).preview !== undefined });
    } catch (e) {
      if (!(e instanceof ApiError) || !opensAsPage(req)) throw e;
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'");
      return reply.code(e.statusCode).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(fileErrorPage(e, !!req.ctx));
    }
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
