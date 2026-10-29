import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Attachment } from '@shared/index';
import { config } from '../config';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { canPostInRoom, sendMessage } from './messages';
import { canAccessRoom, getRoom, loadRoomForUser } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

export function mediaTypeList(key: string) {
  return String(getSetting(key) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

// Um único tipo/subtipo, sem parâmetros; qualquer outra coisa (ex.: "image/png,text/html") vira octet-stream.
export function safeMimeType(v: unknown) {
  const t = String(v ?? '').split(';')[0].trim().toLowerCase();
  return MIME_RE.test(t) ? t : 'application/octet-stream';
}

// Tipos que o navegador pode abrir na própria aba; o resto é sempre baixado.
export function inlineMimeType(type: string) {
  return /^(image\/(png|jpeg|gif|webp|bmp|avif)|(audio|video)\/[a-z0-9.+-]+|application\/pdf)$/.test(type);
}

// Regras de tipo dos arquivos enviados.
export function typeAllowed(type: string) {
  const match = (pattern: string) => (pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern);
  if (mediaTypeList('FileUpload_MediaTypeBlackList').some(match)) return false;
  const white = mediaTypeList('FileUpload_MediaTypeWhiteList');
  return !white.length || white.some(match);
}

export function fileUrl(id: string, name: string) {
  return `/file-upload/${id}/${encodeURIComponent(name)}`;
}

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  rel: string;
}

function tooLarge(max: number) {
  const limit = max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${Math.max(1, Math.round(max / 1024))} KB`;
  return badRequest('error-file-too-large', `Arquivo maior que o permitido (${limit}).`);
}

// Confere o tipo e grava no armazenamento; o tamanho é limitado pelo parser do multipart.
async function writeFile(file: { file: Readable & { truncated?: boolean }; filename: string; mimetype: string }, max: number): Promise<StoredFile> {
  const type = safeMimeType(file.mimetype);
  if (!typeAllowed(type)) {
    file.file.resume();
    throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');
  }
  const id = newId();
  const now = new Date();
  const rel = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), id);
  const abs = path.join(config.uploadDir, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  try {
    await pipeline(file.file, fs.createWriteStream(abs));
  } catch (e) {
    await fs.promises.rm(abs, { force: true });
    if ((e as any)?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(max);
    throw e;
  }
  if (file.file.truncated) {
    await fs.promises.rm(abs, { force: true });
    throw tooLarge(max);
  }
  const { size } = await fs.promises.stat(abs);
  const name = path.basename(file.filename || 'arquivo').slice(0, 200);
  return { id, name: name && name !== '.' && name !== '..' ? name : 'arquivo', type, size, rel };
}

const UPLOAD_FIELDS = ['msg', 'description', 'tmid'];
// Limites do multipart além do arquivo: sem eles cada campo de texto (até 1 MB, sem limite de quantidade) fica na memória.
const FIELD_LIMITS = { files: 1, fields: 10, parts: 11, fieldSize: 64 * 1024 };

const LIMIT_ERRORS: Record<string, string> = {
  FST_FIELDS_LIMIT: 'Campos demais no envio.',
  FST_PARTS_LIMIT: 'Partes demais no envio.',
  FST_FILES_LIMIT: 'Envie um arquivo por vez.',
};

// Lê um multipart/form-data com um campo "file" e campos de texto (msg, description, tmid), em qualquer ordem.
export async function readUpload(req: any): Promise<{ file: StoredFile | null; fields: Record<string, string> }> {
  const max = getSetting<number>('FileUpload_MaxFileSize');
  const fields: Record<string, string> = {};
  let file: StoredFile | null = null;
  try {
    for await (const part of req.parts({ limits: max > 0 ? { ...FIELD_LIMITS, fileSize: max } : FIELD_LIMITS })) {
      if (part.type !== 'file') {
        if (part.valueTruncated) throw new ApiError(413, 'error-field-too-large', 'Texto grande demais no envio.');
        if (UPLOAD_FIELDS.includes(part.fieldname)) fields[part.fieldname] = String(part.value ?? '');
      } else if (file) part.file.resume();
      else file = await writeFile(part, max);
    }
  } catch (e) {
    if (file) await discardFile(file);
    const code = (e as any)?.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(max);
    if (LIMIT_ERRORS[code]) throw new ApiError(413, 'error-too-many-parts', LIMIT_ERRORS[code]);
    throw e;
  }
  return { file, fields };
}

export async function discardFile(f: StoredFile) {
  await query('DELETE FROM files WHERE id = $1', [f.id]).catch(() => {});
  await fs.promises.rm(path.join(config.uploadDir, f.rel), { force: true }).catch(() => {});
}

export async function registerFile(f: StoredFile, rid: string, owner: { userId?: string | null }) {
  await query('INSERT INTO files (id, room_id, user_id, name, type, size, storage_path) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    f.id,
    rid,
    owner.userId ?? null,
    f.name,
    f.type,
    f.size,
    f.rel,
  ]);
  return { _id: f.id, name: f.name, type: f.type, size: f.size };
}

// Formato do anexo que o cliente web exibe.
export function fileAttachment(f: StoredFile, description?: string): Attachment {
  const url = fileUrl(f.id, f.name);
  const att: Attachment = { title: f.name, title_link: url, type: 'file', description: description || undefined, size: f.size, format: path.extname(f.name).slice(1).toUpperCase() };
  if (f.type.startsWith('image/')) att.image_url = url;
  else if (f.type.startsWith('audio/')) att.audio_url = url;
  else if (f.type.startsWith('video/')) att.video_url = url;
  return att;
}

// Checagens feitas antes de ler o corpo da requisição.
export async function assertCanUpload(ctx: Ctx, rid: string) {
  if (!getSetting('FileUpload_Enabled')) throw forbidden('Upload de arquivos desativado.');
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd' && !getSetting('FileUpload_Enabled_Direct')) throw forbidden('Upload em mensagens diretas desativado.');
  await canPostInRoom(ctx, room);
  return room;
}

export async function saveUpload(ctx: Ctx, rid: string, file: StoredFile, fields: { msg?: string; description?: string; tmid?: string }) {
  try {
    const f = await registerFile(file, rid, { userId: ctx.userId });
    return await sendMessage(ctx, { rid, msg: fields.msg ?? '', tmid: fields.tmid || null, files: [f], attachments: [fileAttachment(file, fields.description)] }, { skipCommands: true, internalAttachments: true });
  } catch (e) {
    await discardFile(file);
    throw e;
  }
}

export async function getFileForUser(ctx: Ctx | null, id: string) {
  const f = await one('SELECT * FROM files WHERE id = $1', [id]);
  if (!f) throw notFound('error-file-not-found', 'Arquivo não encontrado.');
  if (!ctx) throw forbidden();
  const room = await getRoom(f.room_id);
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden();
  return { ...f, absPath: path.join(config.uploadDir, f.storage_path) };
}

export async function listRoomFiles(ctx: Ctx, rid: string, opts: { offset?: number; count?: number; type?: string; name?: string }) {
  await loadRoomForUser(ctx, rid);
  const params: unknown[] = [rid];
  let w = 'f.room_id = $1';
  if (opts.type) w += ` AND f.type LIKE $${params.push(opts.type.replace('*', '%'))}`;
  if (opts.name) w += ` AND f.name ILIKE $${params.push(`%${opts.name}%`)}`;
  const rows = await many(
    `SELECT f.*, u.username, count(*) OVER() AS total FROM files f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE ${w} ORDER BY f.created_at DESC LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    files: rows.map((r) => ({ _id: r.id, name: r.name, type: r.type, size: r.size, rid: r.room_id, messageId: r.message_id, user: { _id: r.user_id, username: r.username }, uploadedAt: r.created_at, url: fileUrl(r.id, r.name) })),
  };
}

export async function removeFiles(rows: { storage_path: string }[]) {
  for (const r of rows) await fs.promises.rm(path.join(config.uploadDir, r.storage_path), { force: true }).catch(() => {});
}

export async function deleteFilesOfMessage(messageId: string) {
  await removeFiles(await many('DELETE FROM files WHERE message_id = $1 RETURNING storage_path', [messageId]));
}

export async function deleteRoomFiles(rid: string) {
  await removeFiles(await many('DELETE FROM files WHERE room_id = $1 RETURNING storage_path', [rid]));
}

export async function deleteFilesWhere(rid: string, before: string, after: string) {
  return many('DELETE FROM files WHERE room_id = $1 AND created_at < $2 AND created_at > $3 RETURNING id, storage_path, message_id', [rid, before, after]).then(async (rows) => {
    await removeFiles(rows);
    return rows;
  });
}

// Figurinhas: arquivos que não pertencem a uma sala. Mesmo diretório; o caminho relativo usa sempre "/",
// para o banco servir em Windows e Linux.
const STORED_REL_RE = /^(?:\d{4}\/\d{2}|quarantine)\/[A-Za-z0-9]{10,24}(?:\.poster)?$/;
const FS_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);
const FS_RETRY_DELAYS = [100, 250, 500, 1000, 1500]; // cerca de 3,4 s no total

// Antivírus e indexador do Windows seguram arquivos recém-gravados: tenta de novo antes de desistir.
export async function withFsRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e: any) {
      if (i >= FS_RETRY_DELAYS.length || !FS_RETRY_CODES.has(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, FS_RETRY_DELAYS[i]));
    }
  }
}

export function storedPath(rel: string): string {
  if (!STORED_REL_RE.test(rel)) throw new Error(`caminho de arquivo inválido: ${rel}`);
  return path.resolve(config.uploadDir, ...rel.split('/'));
}

// Caminho de um arquivo novo (AAAA/MM/<id>): quem precisa anotar o caminho antes de gravar usa este e writeStored.
export function newStoredRel(id: string = newId(), now = new Date()): string {
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
}

// Grava em .tmp e renomeia. Se o rename não passar, tenta tirar o .tmp; o das figurinhas fica também na lixeira.
export async function writeStored(rel: string, buf: Uint8Array): Promise<void> {
  const abs = storedPath(rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.promises.writeFile(tmp, buf, { flag: 'wx' });
  try {
    await withFsRetry(() => fs.promises.rename(tmp, abs));
  } catch (e) {
    await withFsRetry(() => fs.promises.rm(tmp, { force: true })).catch(() => {});
    throw e;
  }
}

export async function storeBuffer(buf: Uint8Array, id: string = newId()): Promise<string> {
  const rel = newStoredRel(id);
  await writeStored(rel, buf);
  return rel;
}

// Apagar: "não existe" conta como feito.
export async function deleteStored(rel: string): Promise<void> {
  await withFsRetry(() => fs.promises.rm(storedPath(rel), { force: true }));
}

// Mover (quarentena). Em outro volume, ou se o rename não passar, copia e apaga.
export async function moveStored(rel: string, toRel: string): Promise<void> {
  const from = storedPath(rel);
  const to = storedPath(toRel);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await withFsRetry(() => fs.promises.rename(from, to));
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw e;
    await withFsRetry(() => fs.promises.copyFile(from, to));
    await withFsRetry(() => fs.promises.rm(from, { force: true }));
  }
}
