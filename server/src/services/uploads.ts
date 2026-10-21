import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Attachment } from '@shared/index';
import { config } from '../config';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { canPostInRoom, sendMessage } from './messages';
import { canAccessRoom, getRoom, loadRoomForUser } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

function typeAllowed(type: string) {
  const list = (key: string) =>
    String(getSetting(key) ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const match = (pattern: string) => (pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern);
  if (list('FileUpload_MediaTypeBlackList').some(match)) return false;
  const white = list('FileUpload_MediaTypeWhiteList');
  return !white.length || white.some(match);
}

export function fileUrl(id: string, name: string) {
  return `/file-upload/${id}/${encodeURIComponent(name)}`;
}

export async function saveUpload(
  ctx: Ctx,
  rid: string,
  file: { stream: Readable; filename: string; mimetype: string },
  fields: { msg?: string; description?: string; tmid?: string },
) {
  if (!getSetting('FileUpload_Enabled')) throw forbidden('Upload de arquivos desativado.');
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd' && !getSetting('FileUpload_Enabled_Direct')) throw forbidden('Upload em mensagens diretas desativado.');
  await canPostInRoom(ctx, room);
  const type = (file.mimetype || 'application/octet-stream').toLowerCase();
  if (!typeAllowed(type)) throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');

  const id = newId();
  const now = new Date();
  const rel = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), id);
  const abs = path.join(config.uploadDir, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const max = getSetting<number>('FileUpload_MaxFileSize');
  let size = 0;
  let tooBig = false;
  file.stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (max > 0 && size > max && !tooBig) {
      tooBig = true;
      file.stream.destroy(new Error('too-big'));
    }
  });
  try {
    await pipeline(file.stream, fs.createWriteStream(abs));
  } catch (e) {
    await fs.promises.rm(abs, { force: true });
    if (tooBig) throw badRequest('error-file-too-large', `Arquivo maior que o permitido (${Math.round(max / 1048576)} MB).`);
    throw e;
  }
  if ((file.stream as any).truncated) {
    await fs.promises.rm(abs, { force: true });
    throw badRequest('error-file-too-large', 'Arquivo maior que o permitido.');
  }
  const name = path.basename(file.filename || 'arquivo').slice(0, 200);
  await query('INSERT INTO files (id, room_id, user_id, name, type, size, storage_path) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, rid, ctx.userId, name, type, size, rel]);
  const url = fileUrl(id, name);
  const att: Attachment = { title: name, title_link: url, type: 'file', description: fields.description, size, format: path.extname(name).slice(1).toUpperCase() };
  if (type.startsWith('image/')) att.image_url = url;
  else if (type.startsWith('audio/')) att.audio_url = url;
  else if (type.startsWith('video/')) att.video_url = url;
  return sendMessage(
    ctx,
    { rid, msg: fields.msg ?? '', tmid: fields.tmid || null, files: [{ _id: id, name, type, size }], attachments: [att] },
    { skipCommands: true },
  );
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
    `SELECT f.*, u.username, count(*) OVER() AS total FROM files f LEFT JOIN users u ON u.id = f.user_id
     WHERE ${w} ORDER BY f.created_at DESC LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    files: rows.map((r) => ({ _id: r.id, name: r.name, type: r.type, size: r.size, rid: r.room_id, messageId: r.message_id, user: { _id: r.user_id, username: r.username }, uploadedAt: r.created_at, url: fileUrl(r.id, r.name) })),
  };
}

async function removeFiles(rows: { storage_path: string }[]) {
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
