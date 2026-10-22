import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { many, one, query, tx } from '../db/pool';
import { newId } from '../lib/ids';
import { truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { withExtra } from '../services/messages';
import { notifyRoomUpdated } from '../services/rooms';
import { getSetting } from '../services/settings';
import { fileAttachment, safeMimeType, typeAllowed, type StoredFile } from '../services/uploads';
import { setAvatar } from '../services/users';
import { DownloadError, downloadToBuffer, downloadToFile } from './download';
import type { ProgressSink } from './types';

// "Baixar arquivos pendentes" e "Baixar fotos pendentes": downloads feitos depois da importação, a partir das URLs
// guardadas pelo conversor. Falhas ficam registradas na linha e podem ser tentadas de novo (até MAX_ATTEMPTS vezes).

const MAX_ATTEMPTS = 5;
const PAGE = 100;
const GiB = 1024 * 1024 * 1024;
const MAX_AVATAR = 5 * 1024 * 1024;
const OCTET = 'application/octet-stream';

const retryable = (a: string) => `(${a}.status = 'pending' OR (${a}.status = 'failed' AND ${a}.attempts < ${MAX_ATTEMPTS}))`;

export async function countPendingFiles(): Promise<number> {
  const r = await one(`SELECT count(*)::int AS n FROM import_pending_files p WHERE ${retryable('p')} AND p.url IS NOT NULL AND NOT p.external`);
  return r?.n ?? 0;
}

export async function countPendingAvatars(): Promise<number> {
  const r = await one(`SELECT count(*)::int AS n FROM import_pending_avatars a WHERE ${retryable('a')}`);
  return r?.n ?? 0;
}

// ---------- Execução ----------

const errorText = (e: unknown) => truncate(String((e as Error)?.message ?? e), 500);

function concurrency() {
  const n = Math.floor(Number(getSetting('Import_Pending_Files_Concurrency')) || 1);
  return Math.min(Math.max(n, 1), 10);
}

// O cancelamento também interrompe os downloads em andamento (que voltam a ficar pendentes).
function cancelWatcher(sink: ProgressSink) {
  const ctl = new AbortController();
  const check = () => {
    if (!ctl.signal.aborted && sink.cancelled()) ctl.abort();
  };
  const timer = setInterval(check, 500);
  return { signal: ctl.signal, cancelled: () => (check(), ctl.signal.aborted), stop: () => clearInterval(timer) };
}

// Linhas em ordem de chave, página por página, com até `limit` tarefas ao mesmo tempo. `work` nunca rejeita.
async function runPaged<R>(page: (after: string | null) => Promise<R[]>, keyOf: (r: R) => string, limit: number, cancelled: () => boolean, work: (r: R) => Promise<void>) {
  const running = new Set<Promise<void>>();
  let after: string | null = null;
  try {
    while (!cancelled()) {
      const rows = await page(after);
      if (!rows.length) break;
      for (const row of rows) {
        if (cancelled()) break;
        while (running.size >= limit) await Promise.race(running);
        const p: Promise<void> = work(row).finally(() => running.delete(p));
        running.add(p);
      }
      after = keyOf(rows[rows.length - 1]);
    }
  } finally {
    // Mesmo se a consulta falhar, espera os downloads em andamento antes de limpar a pasta temporária.
    await Promise.allSettled(running);
  }
}

const isCancel = (e: unknown, signal: AbortSignal) => signal.aborted && e instanceof DownloadError && e.code === 'error-download-cancelled';

function opDir(opId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(opId)) throw new Error('Id de operação inválido.');
  return path.join(config.uploadDir, 'imports', opId);
}

// ---------- Arquivos ----------

const EXT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

// Tipo informado na origem; senão o da resposta (se não for genérico); senão pela extensão.
export function pendingFileType(declared: string | null | undefined, served: string, name: string) {
  const d = safeMimeType(declared);
  if (d !== OCTET) return d;
  const s = safeMimeType(served);
  if (s !== OCTET) return s;
  return EXT_TYPES[path.extname(name).slice(1).toLowerCase()] ?? OCTET;
}

// Corte por caractere: com String.slice um emoji no limite ficava pela metade, o anexo (jsonb) era recusado e o
// download falhava em todas as tentativas.
function storedName(name: string) {
  const n = truncate(
    path
      .basename(String(name ?? '').replace(/\\/g, '/'))
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim(),
    200,
  );
  return n && n !== '.' && n !== '..' ? n : 'arquivo';
}

async function moveFile(from: string, to: string) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch (e) {
    if ((e as any)?.code !== 'EXDEV') throw e;
    await fs.promises.copyFile(from, to);
    await fs.promises.rm(from, { force: true });
  }
}

// Troca o anexo provisório (pendingFileId = id na origem) pelo anexo do arquivo; sem provisório, acrescenta no fim.
// Um único UPDATE: downloads simultâneos da mesma mensagem não se sobrescrevem.
const ATTACH_FILE_SQL = `
  UPDATE messages SET
    files = (CASE WHEN jsonb_typeof(files) = 'array' THEN files ELSE '[]'::jsonb END) || $2::jsonb,
    attachments = CASE
      WHEN jsonb_typeof(attachments) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'pendingFileId' = $3)
        THEN (SELECT jsonb_agg(CASE WHEN t.a->>'pendingFileId' = $3 THEN $4::jsonb ELSE t.a END ORDER BY t.i)
                FROM jsonb_array_elements(attachments) WITH ORDINALITY AS t(a, i))
      ELSE (CASE WHEN jsonb_typeof(attachments) = 'array' THEN attachments ELSE '[]'::jsonb END) || jsonb_build_array($4::jsonb)
    END,
    updated_at = now()
  WHERE id = $1 RETURNING *`;

async function markFileFailed(id: string, error: string, final = false) {
  // final: não adianta tentar de novo (tipo bloqueado), então já esgota as tentativas.
  await query(
    `UPDATE import_pending_files SET status = 'failed', attempts = ${final ? `GREATEST(attempts + 1, ${MAX_ATTEMPTS})` : 'attempts + 1'},
       error = $2, updated_at = now() WHERE id = $1`,
    [id, truncate(error, 500)],
  );
}

export async function runPendingFiles(opId: string, sink: ProgressSink): Promise<{ downloaded: number; failed: number }> {
  const dir = opDir(opId);
  const watch = cancelWatcher(sink);
  let downloaded = 0;
  let failed = 0;
  // Sem URL ou externos (Google Drive etc.) não têm como ser baixados.
  await query(
    `UPDATE import_pending_files SET status = 'unavailable', updated_at = now() WHERE status IN ('pending', 'failed') AND (external OR url IS NULL)`,
  );
  const configured = Number(getSetting('FileUpload_MaxFileSize'));
  const maxBytes = configured > 0 ? configured : GiB;

  // Baixa, confere o tipo, guarda e liga à mensagem. Devolve a mensagem atualizada, 'failed', ou null quando foi
  // cancelado (não conta).
  const store = async (row: any) => {
    const tmp = path.join(dir, `pending-${String(row.id).replace(/[^A-Za-z0-9_-]/g, '_')}`);
    let abs: string | null = null;
    try {
      const got = await downloadToFile(row.url, tmp, { maxBytes, signal: watch.signal });
      const type = pendingFileType(row.type, got.contentType, row.name);
      if (!typeAllowed(type)) {
        await fs.promises.rm(tmp, { force: true });
        await markFileFailed(row.id, `Tipo de arquivo não permitido (${type}).`, true);
        return 'failed' as const;
      }
      // Mesmo layout dos envios normais, mas com a data da mensagem (a retenção usa essa data).
      const when = new Date(row.message_ts);
      const date = Number.isNaN(when.getTime()) ? new Date() : when;
      const fileId = newId();
      const rel = path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), fileId);
      abs = path.join(config.uploadDir, rel);
      await moveFile(tmp, abs);
      const stored: StoredFile = { id: fileId, name: storedName(row.name), type, size: got.size, rel };
      const preview = truncate(`📎 ${stored.name}`, 200);
      return await tx(async (c) => {
        await c.query(
          'INSERT INTO files (id, room_id, user_id, message_id, name, type, size, storage_path, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [stored.id, row.room_id, row.user_id, row.message_id, stored.name, stored.type, stored.size, stored.rel, date.toISOString()],
        );
        const ref = JSON.stringify([{ _id: stored.id, name: stored.name, type: stored.type, size: stored.size }]);
        const message = await one(ATTACH_FILE_SQL, [row.message_id, ref, row.source_file_id, JSON.stringify(fileAttachment(stored))], c);
        if (!message) throw new Error('A mensagem não existe mais.');
        // A URL pode levar token de acesso (Slack): não fica guardada depois do download.
        await c.query(`UPDATE import_pending_files SET status = 'downloaded', file_id = $2, url = NULL, error = NULL, updated_at = now() WHERE id = $1`, [row.id, stored.id]);
        // Última mensagem da sala só com arquivo: passa a mostrar o nome dele, como num envio normal.
        const room = await one(
          `UPDATE rooms SET last_message = jsonb_set(last_message, '{msg}', to_jsonb($3::text))
            WHERE id = $1 AND last_message->>'_id' = $2 AND coalesce(last_message->>'msg', '') = '' RETURNING id`,
          [message.room_id, message.id, preview],
          c,
        );
        return { message, roomTouched: !!room };
      });
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (abs) await fs.promises.rm(abs, { force: true }).catch(() => {});
      if (isCancel(e, watch.signal)) return null;
      await markFileFailed(row.id, errorText(e)).catch(() => {});
      return 'failed' as const;
    }
  };

  const work = async (row: any) => {
    const r = await store(row);
    if (!r) return;
    if (r === 'failed') {
      failed++;
      sink.inc({ error: 1 });
      return;
    }
    downloaded++;
    sink.inc({ completed: 1 });
    try {
      bus.publish({ room: r.message.room_id }, { type: 'message', action: 'updated', message: withExtra(r.message) });
      if (r.roomTouched) await notifyRoomUpdated(r.message.room_id);
    } catch {
      // o arquivo já está guardado; quem estiver na sala vê ao recarregar
    }
  };

  try {
    await runPaged(
      (after) =>
        many(
          `SELECT p.*, m.created_at AS message_ts FROM import_pending_files p JOIN messages m ON m.id = p.message_id
            WHERE ${retryable('p')} AND p.url IS NOT NULL AND NOT p.external AND ($1::text IS NULL OR p.id > $1)
            ORDER BY p.id LIMIT ${PAGE}`,
          [after],
        ),
      (r) => r.id,
      concurrency(),
      watch.cancelled,
      work,
    );
  } finally {
    watch.stop();
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    await sink.flush();
  }
  return { downloaded, failed };
}

// ---------- Fotos de perfil ----------

// Pelo conteúdo, não pelo content-type da resposta (que pode mentir).
export function imageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function markAvatar(userId: string, status: 'downloaded' | 'failed' | 'skipped', error: string | null, final = false) {
  const attempts = status !== 'failed' ? 'attempts' : final ? `GREATEST(attempts + 1, ${MAX_ATTEMPTS})` : 'attempts + 1';
  await query(`UPDATE import_pending_avatars SET status = $2, error = $3, attempts = ${attempts}, updated_at = now() WHERE user_id = $1`, [userId, status, error]);
}

export async function runPendingAvatars(_opId: string, sink: ProgressSink): Promise<{ downloaded: number; failed: number }> {
  const watch = cancelWatcher(sink);
  let downloaded = 0;
  let failed = 0;

  const work = async (row: any) => {
    try {
      // Quem já pôs uma foto depois da importação fica com ela.
      if (row.avatar_etag) {
        await markAvatar(row.user_id, 'skipped', 'O usuário já tinha foto de perfil.');
        sink.inc({ skipped: 1 });
        return;
      }
      const { data } = await downloadToBuffer(row.url, { maxBytes: MAX_AVATAR, accept: 'image/*', timeoutMs: 60_000, idleTimeoutMs: 30_000, signal: watch.signal });
      const type = imageType(data);
      if (!type) {
        await markAvatar(row.user_id, 'failed', 'A imagem não está em PNG, JPEG, GIF ou WebP.', true);
        failed++;
        sink.inc({ error: 1 });
        return;
      }
      await setAvatar(row.user_id, type, data);
      await markAvatar(row.user_id, 'downloaded', null);
      downloaded++;
      sink.inc({ completed: 1 });
    } catch (e) {
      if (isCancel(e, watch.signal)) return;
      await markAvatar(row.user_id, 'failed', errorText(e)).catch(() => {});
      failed++;
      sink.inc({ error: 1 });
    }
  };

  try {
    await runPaged(
      (after) =>
        many(
          `SELECT a.user_id, a.url, u.avatar_etag FROM import_pending_avatars a JOIN users u ON u.id = a.user_id
            WHERE ${retryable('a')} AND ($1::text IS NULL OR a.user_id > $1) ORDER BY a.user_id LIMIT ${PAGE}`,
          [after],
        ),
      (r) => r.user_id,
      concurrency(),
      watch.cancelled,
      work,
    );
  } finally {
    watch.stop();
    await sink.flush();
  }
  return { downloaded, failed };
}
