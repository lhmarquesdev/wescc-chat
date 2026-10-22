import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config';
import { many, one, query, tx, type Queryable } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { newId } from '../lib/ids';
import { trimEndChars, truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { audit, type Actor } from '../services/audit';
import { rolesHavePermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import { safeMimeType } from '../services/uploads';
import { openForImporter } from './archive';
import { runConversion, sanitizeRoomName } from './converter';
import { downloadToFile } from './download';
import { countPendingAvatars, countPendingFiles, runPendingAvatars, runPendingFiles } from './pending';
import { getImporter, importerName, importers } from './registry';
import { clearStaging, countStaged, deleteSuccessful, iterateStaged, scrubSecrets, stageRecords, StagingWriter } from './staging';
import {
  BUSY_STATES,
  DIRECT_MESSAGES_ID,
  FINAL_STATES,
  IMPORTING_STATES,
  ImportError,
  MENTION_CLOSE,
  MENTION_OPEN,
  PREPARING_STATES,
  ST,
  WAITING_STATES,
  type ArchiveSource,
  type ImportChannel,
  type ImportContact,
  type ImportCounts,
  type Importer,
  type ImporterKey,
  type ImportMessage,
  type ImportOperation,
  type ImportOptions,
  type ImportProgressPayload,
  type ImportSelection,
  type ImportStatus,
  type ImportUser,
  type PrepareContext,
  type ProgressSink,
  type SelectionChannel,
  type ShortSelection,
} from './types';

const LOCK_KEY = 727105;
const MAX_WARNINGS = 200;
const ACTIVE: ImportStatus[] = Object.values(ST).filter((s) => !FINAL_STATES.includes(s));
const INTERRUPTED =
  'A importação foi interrompida porque o servidor reiniciou. Os dados já importados foram mantidos; você pode importar o mesmo arquivo de novo (o que já foi importado é atualizado, não duplicado).';

export const operationDir = (opId: string) => path.join(config.uploadDir, 'imports', opId);

function logError(what: string, e: unknown) {
  if (config.logLevel !== 'silent') console.error(`importação: ${what}`, e);
}

// ---------- Formato da API ----------

function countsOf(r: any): ImportCounts {
  return {
    users: r.count_users,
    channels: r.count_channels,
    messages: r.count_messages,
    contacts: r.count_contacts,
    total: r.count_total,
    completed: r.count_completed,
    error: r.count_error,
    skipped: r.count_skipped,
  };
}

export function mapOperation(r: any, name: string): ImportOperation {
  return {
    _id: r.id,
    type: name,
    importerKey: r.importer_key,
    status: r.status,
    valid: r.valid,
    user: r.user_id,
    source: r.source,
    file: r.file_name,
    contentType: r.content_type,
    fileSize: r.file_size,
    count: countsOf(r),
    messagesstatus: r.messages_status,
    error: r.error,
    warnings: r.warnings ?? [],
    options: r.options ?? {},
    ts: r.created_at,
    _updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function presentOperation(r: any): ImportOperation {
  return mapOperation(r, importerName(r.importer_key));
}

export async function currentOperation() {
  return one('SELECT * FROM import_operations ORDER BY created_at DESC LIMIT 1');
}

export async function validOperation() {
  return one('SELECT * FROM import_operations WHERE valid');
}

export const operationNotFound = () => badRequest('error-operation-not-found', 'Nenhuma importação em andamento.');
const busyError = () => new ApiError(409, 'error-import-running', 'Já existe uma importação em andamento. Espere terminar ou cancele.');
const cancelledError = () => badRequest('error-import-cancelled', 'A importação foi cancelada.');

// ---------- Progresso em tempo real ----------

let watchers: { ids: string[]; at: number } | null = null;

// Só quem pode ver as importações recebe o progresso.
async function importWatchers(): Promise<string[]> {
  if (watchers && Date.now() - watchers.at < 30_000) return watchers.ids;
  const roles = (await many<{ id: string }>('SELECT id FROM roles'))
    .map((r) => r.id)
    .filter((r) => rolesHavePermission([r], 'run-import') || rolesHavePermission([r], 'view-import-operations'));
  const ids = roles.length ? (await many<{ id: string }>('SELECT id FROM users WHERE active AND roles && $1', [roles])).map((r) => r.id) : [];
  watchers = { ids, at: Date.now() };
  return ids;
}

function progressOf(r: any, extra: Partial<ImportProgressPayload> = {}): ImportProgressPayload {
  return { _id: r.id, importerKey: r.importer_key, status: r.status, valid: r.valid, count: countsOf(r), messagesstatus: r.messages_status, error: r.error, ...extra };
}

async function emit(p: ImportProgressPayload) {
  const users = await importWatchers().catch(() => [] as string[]);
  if (users.length) bus.publish({ users }, { type: 'import.progress', operation: p });
}

export async function publishProgress(opId: string, extra?: Partial<ImportProgressPayload>) {
  const r = await one('SELECT * FROM import_operations WHERE id = $1', [opId]);
  if (r) await emit(progressOf(r, extra));
}

// Atualiza a operação (e avisa a tela) só se a situação ainda for uma das esperadas; devolve null se não for.
async function update(opId: string, set: Record<string, unknown>, from: readonly ImportStatus[] = ACTIVE, db?: Queryable) {
  const params: unknown[] = [opId];
  const assigns = Object.entries(set).map(([col, v]) => `${col} = $${params.push(v)}`);
  const r = await one(
    `UPDATE import_operations SET ${[...assigns, 'updated_at = now()'].join(', ')} WHERE id = $1 AND status = ANY($${params.push(from)}::text[]) RETURNING *`,
    params,
    db,
  );
  if (r && !db) await emit(progressOf(r));
  return r;
}

// Texto de fora (nome de arquivo, mensagem de erro, aviso) para o banco: o PostgreSQL recusa U+0000 em text e jsonb, e
// o jsonb recusa metade de um par UTF-16. Uma gravação recusada deixaria a operação presa na situação anterior.
const dbText = (s: unknown, max: number) => truncate(String(s ?? '').replace(/\u0000/g, ''), max);

const fail = (opId: string, message: string) => update(opId, { status: ST.failed, error: dbText(message, 4000), finished_at: new Date() });
const markCancelled = (opId: string) => update(opId, { status: ST.cancelled, finished_at: new Date() });

// ---------- Trabalhos em segundo plano nesta instância ----------

interface Job {
  cancel: boolean;
  abort?: () => void;
}

const jobs = new Map<string, Job>();
let beatTimer: NodeJS.Timeout | null = null;

// Marca esta instância como viva (last_seen = agora) e recria a linha se a limpeza diária do agendador a apagou.
// Sem o agendador (DISABLE_CRON) só isto atualiza last_seen, e outra instância marcaria a importação daqui como
// interrompida. Roda antes de a operação ficar ocupada em nome desta instância e a cada 20 s enquanto houver trabalho.
export async function heartbeat(db?: Queryable) {
  await query(
    `INSERT INTO instances (id, info) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET last_seen = now()`,
    [bus.origin, JSON.stringify({ pid: process.pid, host: os.hostname(), port: config.port })],
    db,
  );
}

function startJob(opId: string): Job {
  const job: Job = { cancel: false };
  jobs.set(opId, job);
  if (!beatTimer) {
    void heartbeat().catch(() => {});
    beatTimer = setInterval(() => void heartbeat().catch(() => {}), 20_000);
    beatTimer.unref();
  }
  return job;
}

function endJob(opId: string) {
  jobs.delete(opId);
  if (!jobs.size && beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

// ---------- Criação ----------

// FOR UPDATE: um startImport que está mudando a operação ao mesmo tempo termina antes, e a situação lida aqui já é a
// nova (importando, portanto ocupada). Sem a trava, a nova operação invalidaria a importação que acabou de começar.
async function assertNotBusy(db?: Queryable) {
  const cur = await one('SELECT status FROM import_operations WHERE valid FOR UPDATE', [], db);
  if (cur && BUSY_STATES.includes(cur.status)) throw busyError();
}

async function removeOperationFiles(rows: { id: string; source: string }[]) {
  for (const r of rows) {
    if (r.source === 'path') continue;
    await fs.promises.rm(operationDir(r.id), { recursive: true, force: true }).catch(() => {});
  }
}

// Invalida as anteriores (e os dados lidos delas) e cria a nova operação, que passa a ser a única válida.
// Já nasce na situação inicial pedida, para que ninguém crie outra no meio do caminho.
export async function newOperation(
  actor: Actor,
  importerKey: ImporterKey,
  opts: { id?: string; source?: ImportOperation['source']; status?: ImportStatus; fields?: Record<string, unknown> } = {},
) {
  const { row, old } = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await assertNotBusy(c);
    const old = await many('UPDATE import_operations SET valid = false, updated_at = now() WHERE valid RETURNING id, source', [], c);
    await c.query('DELETE FROM import_records');
    // Na mesma transação: a operação nunca aparece em nome desta instância com last_seen velho.
    await heartbeat(c);
    const cols: Record<string, unknown> = {
      id: opts.id ?? newId(),
      importer_key: importerKey,
      status: opts.status ?? ST.new,
      user_id: actor.id ?? null,
      source: opts.source ?? 'none',
      instance_id: bus.origin,
      ...opts.fields,
    };
    const names = Object.keys(cols);
    const row = await one(
      `INSERT INTO import_operations (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(cols),
      c,
    );
    return { row, old };
  });
  await removeOperationFiles(old);
  await emit(progressOf(row));
  return row;
}

export async function clearOperations(actor: Actor) {
  const old = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await assertNotBusy(c);
    const old = await many('UPDATE import_operations SET valid = false, updated_at = now() WHERE valid RETURNING *', [], c);
    await c.query('DELETE FROM import_records');
    return old;
  });
  await removeOperationFiles(old);
  for (const r of old) await emit(progressOf(r));
  await audit(actor, 'import.cleared', {}, { operations: old.map((r) => r.id) });
}

// ---------- Arquivo de origem ----------

export function maxImportSize() {
  const v = Number(getSetting('Import_MaxFileSize'));
  return v > 0 ? v : Number.MAX_SAFE_INTEGER;
}

function formatSize(n: number) {
  for (const [unit, v] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]] as const) {
    if (n >= v) return `${String(Math.round((n / v) * 10) / 10).replace('.', ',')} ${unit}`;
  }
  return `${n} bytes`;
}

const tooLarge = (max: number) => new ApiError(413, 'error-file-too-large', `O arquivo passa do tamanho máximo para importação (${formatSize(max)}).`);

// Nome guardado no disco: só [A-Za-z0-9._-], sem caminho e sem ponto no começo.
export function safeFileName(name: string) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const rawExt = path.extname(base);
  const ext = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt.toLowerCase() : '';
  const stem = trimEndChars(
    base
      .slice(0, base.length - rawExt.length)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+/, ''),
    '._-',
  ).slice(0, 100);
  return `${/[A-Za-z0-9]/.test(stem) ? stem : 'source'}${ext}`;
}

// Nome para mostrar e guardar em file_name. Vem do navegador, do endereço ou do Content-Disposition (um %00 vira U+0000):
// sem caminho e sem caracteres de controle.
function displayName(name: string | undefined) {
  const n = dbText(
    path
      .basename(String(name ?? '').replace(/\\/g, '/'))
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim(),
    255,
  );
  return n && n !== '.' && n !== '..' ? n : 'arquivo';
}

function acceptList(importer: Importer) {
  return importer.accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Sem extensão no nome, quem decide é a leitura do arquivo (o .zip é conferido pelos primeiros bytes).
export function acceptsFile(importer: Importer, filename: string, mimetype?: string) {
  const list = acceptList(importer);
  const ext = path.extname(filename).toLowerCase();
  if (!list.length || !ext) return true;
  const type = (mimetype ?? '').toLowerCase();
  return list.some((a) => (a.startsWith('.') ? ext === a : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));
}

// Num endereço, só uma extensão que algum importador aceita diz o tipo do arquivo: download.php, .aspx, um nome com
// versão ("backup-v1.2") ou o nome do servidor não dizem nada, e quem decide é a leitura do arquivo baixado.
function wrongKnownType(importer: Importer, filename: string) {
  const ext = path.extname(filename).toLowerCase();
  if (!ext || ![importer, ...importers].some((i) => acceptList(i).includes(ext))) return false;
  return !acceptsFile(importer, filename);
}

function wrongTypeMessage(importer: Importer, filename: string, all: Importer[]) {
  const exts = acceptList(importer).filter((a) => a.startsWith('.'));
  const ext = path.extname(filename).toLowerCase();
  let msg = `O importador "${importer.label}" espera um arquivo ${exts.join(' ou ')}, mas foi enviado um arquivo ${ext}.`;
  if (exts.includes('.zip') && ext === '.csv') msg += ' Compacte os arquivos .csv em um único .zip (veja o formato na ajuda).';
  const others = all.filter((i) => i.visible && i.key !== importer.key && acceptList(i).includes(ext)).map((i) => `"${i.label}"`);
  if (others.length) msg += ` Para um arquivo ${ext}, escolha ${others.join(' ou ')}.`;
  return msg;
}

function importerFor(key: string) {
  const importer = getImporter(key);
  if (!importer) throw badRequest('error-importer-not-defined', `Tipo de importação desconhecido: ${key || '(vazio)'}.`);
  return { importer, all: importers };
}

const LIMIT_ERRORS: Record<string, string> = {
  FST_FIELDS_LIMIT: 'Campos demais no envio.',
  FST_PARTS_LIMIT: 'Partes demais no envio.',
  FST_FILES_LIMIT: 'Envie um arquivo por vez.',
};

function uploadError(e: any, max: number) {
  if (e instanceof ApiError) return e;
  const code = e?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge(max);
  if (LIMIT_ERRORS[code]) return new ApiError(413, 'error-too-many-parts', LIMIT_ERRORS[code]);
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return badRequest('error-invalid-params', 'Envie o arquivo como multipart/form-data.');
  return badRequest('error-upload-failed', `O envio do arquivo foi interrompido${e?.message ? `: ${e.message}` : '.'}`);
}

// O Fastify não tem tempo limite por requisição: um envio que para de chegar (notebook fechado, conexão meio aberta)
// deixaria a operação "enviando" para sempre e bloquearia as outras importações. Mudável nos testes.
export const uploadLimits = { idleMs: 120_000 };
const stalledError = () => new ApiError(408, 'error-upload-stalled', 'O envio do arquivo parou de chegar e foi interrompido. Envie de novo.');

// Envio pelo navegador (multipart com "importerKey" e "file", em qualquer ordem). O arquivo vai direto para o disco.
export async function uploadOperation(req: any, actor: Actor) {
  const max = maxImportSize();
  // Antes de receber um arquivo grande que seria recusado.
  await assertNotBusy();
  const id = newId();
  const dir = operationDir(id);
  const s: { key: string; row: any; job: Job | null; file: { name: string; path: string; size: number; type: string } | null; stalled: boolean } = {
    key: '',
    row: null,
    job: null,
    file: null,
    stalled: false,
  };
  // Cada pedaço que chega do cliente renova o prazo; sem nada por idleMs, a conexão é derrubada.
  let idle: NodeJS.Timeout | null = null;
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      s.stalled = true;
      req.raw.destroy();
    }, uploadLimits.idleMs);
    idle.unref();
  };

  // Cria a operação assim que se sabe o importador (antes do arquivo, se o campo vier primeiro).
  const begin = async (name: string, type: string) => {
    const { importer, all } = importerFor(s.key);
    s.row = await newOperation(actor, importer.key, { id, source: 'upload', status: ST.uploading, fields: { file_name: name, content_type: type } });
    s.job = startJob(id);
    if (!acceptsFile(importer, name, type)) throw badRequest('error-invalid-file-type', wrongTypeMessage(importer, name, all));
  };

  try {
    const parts = req.parts({ limits: { fileSize: max, files: 1, fields: 10, parts: 11, fieldSize: 4096 } });
    // Depois de req.parts(), que já ligou o corpo ao leitor do multipart: este ouvinte só observa os bytes.
    req.raw.on('data', arm);
    arm();
    for await (const part of parts) {
      if (part.type !== 'file') {
        if (part.fieldname === 'importerKey') s.key = String(part.value ?? '').trim();
        continue;
      }
      const name = displayName(part.filename);
      const type = safeMimeType(part.mimetype);
      try {
        if (s.file) throw new ApiError(413, 'error-too-many-parts', LIMIT_ERRORS.FST_FILES_LIMIT);
        if (s.key && !s.row) await begin(name, type);
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (e) {
        part.file.resume();
        throw e;
      }
      const dest = path.join(dir, safeFileName(name));
      if (s.job) s.job.abort = () => part.file.destroy(new Error('cancelada'));
      await pipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) throw tooLarge(max);
      s.file = { name, path: dest, size: (await fs.promises.stat(dest)).size, type };
    }
    // O corpo inteiro chegou: o prazo de espera não vale mais.
    if (idle) clearTimeout(idle);
    if (s.stalled) throw stalledError();
    if (!s.file) throw badRequest('error-invalid-params', 'Envie o arquivo no campo "file".');
    if (!s.row) await begin(s.file.name, s.file.type);
    if (s.job?.cancel) throw cancelledError();
    s.row = await update(id, { status: ST.fileLoaded, file_name: s.file.name, file_path: s.file.path, file_size: s.file.size, content_type: s.file.type }, [ST.uploading]);
    if (!s.row) throw cancelledError();
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    const cancelled = !!s.job?.cancel;
    const err = cancelled ? cancelledError() : s.stalled ? stalledError() : uploadError(e, max);
    if (s.row) await (cancelled ? markCancelled(id) : fail(id, err.message));
    throw err;
  } finally {
    if (idle) clearTimeout(idle);
    req.raw.off('data', arm);
    if (s.job) endJob(id);
  }
  await audit(actor, 'import.uploaded', { operationId: id }, { importer: s.row.importer_key, source: 'upload', file: s.file.name, size: s.file.size });
  prepareInBackground(id);
  return s.row;
}

// Endereço público: a operação volta na hora e o download segue em segundo plano.
export async function urlOperation(actor: Actor, key: string, fileUrl: string) {
  const { importer, all } = importerFor(key);
  let u: URL;
  try {
    u = new URL(fileUrl);
  } catch {
    throw badRequest('error-invalid-url', 'Endereço inválido.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('error-invalid-url', 'O endereço precisa começar com http:// ou https://.');
  let fromPath = path.posix.basename(u.pathname);
  try {
    fromPath = decodeURIComponent(fromPath);
  } catch {
    // nome com % inválido: fica como veio
  }
  // O nome do servidor só serve para mostrar: o ".com" de "intranet.example.com" não é tipo de arquivo.
  const name = displayName(fromPath || u.hostname);
  if (fromPath && wrongKnownType(importer, name)) throw badRequest('error-invalid-file-type', wrongTypeMessage(importer, name, all));

  const id = newId();
  const dest = path.join(operationDir(id), safeFileName(name));
  // O endereço completo não é guardado: pode levar um token na query.
  const row = await newOperation(actor, importer.key, { id, source: 'url', status: ST.downloadingFile, fields: { file_name: name, file_path: dest } });
  const job = startJob(id);
  const abort = new AbortController();
  job.abort = () => abort.abort();
  await audit(actor, 'import.uploaded', { operationId: id }, { importer: importer.key, source: 'url', host: u.host, file: name });
  void (async () => {
    let loaded = null;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const r = await downloadToFile(u.href, dest, { maxBytes: maxImportSize(), signal: abort.signal });
      if (job.cancel) throw cancelledError();
      // Nome que o servidor deu ao arquivo (download.php?id=42 → "exportacao.zip"), conferido como o do endereço.
      const served = r.fileName ? displayName(r.fileName) : '';
      if (served && wrongKnownType(importer, served)) throw badRequest('error-invalid-file-type', wrongTypeMessage(importer, served, all));
      const fields = { status: ST.fileLoaded, file_size: r.size, content_type: safeMimeType(r.contentType), ...(served ? { file_name: served } : {}) };
      loaded = await update(id, fields, [ST.downloadingFile]);
    } catch (e: any) {
      await fs.promises.rm(operationDir(id), { recursive: true, force: true }).catch(() => {});
      if (job.cancel) await markCancelled(id);
      else await fail(id, e instanceof ApiError ? e.message : `Não foi possível baixar o arquivo: ${e?.message ?? e}`);
    } finally {
      endJob(id);
    }
    if (loaded) await startPreparation(id);
  })().catch((e) => logError(`download da operação ${id}`, e));
  return row;
}

const outside = (base: string, p: string) => {
  const rel = path.relative(base, p);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

// Arquivo ou pasta já no servidor, usado no lugar (sem cópia). Só dentro de IMPORT_SERVER_DIR.
export async function pathOperation(actor: Actor, key: string, input: string) {
  const { importer, all } = importerFor(key);
  const baseDir = process.env.IMPORT_SERVER_DIR;
  if (!baseDir) throw badRequest('error-import-path-disabled', 'A importação por caminho no servidor está desativada. Defina IMPORT_SERVER_DIR no servidor para liberar.');
  const base = await fs.promises.realpath(baseDir).catch(() => null);
  if (!base) throw badRequest('error-import-path-disabled', `A pasta de importação do servidor (IMPORT_SERVER_DIR) não existe: ${baseDir}`);
  // Mesma resposta para "não existe" e "fica fora da pasta", e o que fica fora pelo texto do caminho é recusado antes
  // de olhar o disco: a mensagem não pode servir para descobrir se um arquivo existe em outro lugar do servidor.
  const missing = () => badRequest('error-import-file-missing', `Arquivo não encontrado na pasta de importação do servidor: ${input}`);
  const wanted = path.resolve(base, input);
  if (outside(base, wanted) && outside(path.resolve(baseDir), path.resolve(baseDir, input))) throw missing();
  const real = await fs.promises.realpath(wanted).catch(() => null);
  if (!real || outside(base, real)) throw missing();
  const st = await fs.promises.stat(real).catch(() => null);
  if (!st) throw missing();
  if (st.isDirectory()) {
    if (importer.sourceKind !== 'zip-or-dir') throw badRequest('error-invalid-file-type', `O importador "${importer.label}" precisa de um arquivo ${importer.accept}, não de uma pasta.`);
  } else if (!st.isFile()) {
    throw missing();
  } else if (!acceptsFile(importer, real)) {
    throw badRequest('error-invalid-file-type', wrongTypeMessage(importer, real, all));
  }
  const row = await newOperation(actor, importer.key, { source: 'path', status: ST.fileLoaded, fields: { file_name: real, file_path: real, file_size: st.isFile() ? st.size : null } });
  await audit(actor, 'import.uploaded', { operationId: row.id }, { importer: importer.key, source: 'path', file: real });
  prepareInBackground(row.id);
  return row;
}

// ---------- Leitura do arquivo (prévia) ----------

class Warnings {
  private items: string[] = [];
  private extra = 0;
  add(m: string) {
    if (this.items.length < MAX_WARNINGS) this.items.push(dbText(m, 1000));
    else this.extra++;
  }
  list() {
    return this.extra ? [...this.items, `e mais ${this.extra} avisos`] : this.items;
  }
  first(n: number) {
    return this.items.slice(0, n);
  }
}

// Manda no máximo um evento a cada `ms`, sempre incluindo o último valor.
function throttled(ms: number, fn: (v: number) => void) {
  let last = 0;
  let pending: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    timer = null;
    if (pending === null) return;
    last = Date.now();
    const v = pending;
    pending = null;
    fn(v);
  };
  return {
    call(v: number) {
      pending = v;
      if (timer) return;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
  };
}

const prepareInBackground = (opId: string) => void startPreparation(opId).catch((e) => logError(`leitura da operação ${opId}`, e));

// Lê o arquivo e grava os dados em import_records. Roda em segundo plano, nunca dentro de uma requisição.
export async function startPreparation(opId: string): Promise<void> {
  const row = await update(opId, { status: ST.preparingStarted, instance_id: bus.origin, error: null }, [ST.fileLoaded]);
  if (!row) return;
  const job = startJob(opId);
  const writer = new StagingWriter(opId);
  const warnings = new Warnings();
  const live = { status: row.status as ImportStatus, messagesStatus: null as string | null };
  const liveCounts = (): ImportCounts => {
    const c = writer.counts();
    return { users: c.user, channels: c.channel, messages: c.message, contacts: c.contact, total: c.user + c.channel + c.message + c.contact, completed: 0, error: 0, skipped: 0 };
  };

  // Contadores crescendo na tela; também é aqui que um cancelamento feito em outra instância é percebido.
  let ticking: Promise<void> | null = null;
  const tick = async () => {
    const c = liveCounts();
    const r = await one(
      `UPDATE import_operations SET count_users = $2, count_channels = $3, count_messages = $4, count_contacts = $5, count_total = $6,
         messages_status = $7, warnings = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [opId, c.users, c.channels, c.messages, c.contacts, c.total, live.messagesStatus, JSON.stringify(warnings.list())],
    );
    // Cancelada, invalidada ou dada como falha por outra instância: para de ler.
    if (!r || !r.valid || !PREPARING_STATES.includes(r.status)) job.cancel = true;
    else await emit(progressOf(r));
  };
  const timer = setInterval(() => {
    if (!ticking) ticking = tick().catch((e) => logError('contadores da leitura', e)).finally(() => (ticking = null));
  }, 2000);
  timer.unref();
  const rate = throttled(300, (v) => void emit(progressOf(row, { status: live.status, count: liveCounts(), messagesstatus: live.messagesStatus, rate: v })));

  let source: ArchiveSource | null = null;
  let error: unknown = null;
  try {
    const importer = getImporter(row.importer_key);
    if (!importer) throw new ImportError('Tipo de importação desconhecido.');
    source = await openForImporter(row.file_path, importer, { warn: (m) => warnings.add(m) });
    const ctx: PrepareContext = {
      operationId: opId,
      source,
      user: (rec: ImportUser) => writer.add('user', rec.importIds?.[0] ?? null, rec),
      channel: (rec: ImportChannel) => writer.add('channel', rec.importIds?.[0] ?? null, rec),
      message: (rec: ImportMessage) => writer.add('message', rec.importId ?? null, rec),
      contact: (rec: ImportContact) => writer.add('contact', rec.importIds?.[0] ?? null, rec),
      setStep: async (step) => {
        if (!PREPARING_STATES.includes(step) || step === live.status) return;
        live.status = step;
        if (!(await update(opId, { status: step }, PREPARING_STATES))) job.cancel = true;
      },
      setMessagesStatus: async (s) => {
        live.messagesStatus = s;
      },
      progress: (v) => rate.call(Math.max(0, Math.min(100, Math.round(Number(v) * 10) / 10 || 0))),
      warn: (m) => warnings.add(m),
      cancelled: () => job.cancel,
      findImported: async (kind, importId) => (await one('SELECT target_id FROM import_map WHERE kind = $1 AND import_id = $2', [kind, importId]))?.target_id ?? null,
    };
    await importer.prepare(ctx);
    await writer.flush();
  } catch (e) {
    error = e;
  } finally {
    clearInterval(timer);
    await ticking;
    rate.flush();
    await source?.close().catch(() => {});
  }

  try {
    const done = { warnings: JSON.stringify(warnings.list()), messages_status: null, finished_at: new Date() };
    if (job.cancel) {
      await clearStaging(opId);
      await update(opId, { ...done, status: ST.cancelled }, PREPARING_STATES);
    } else if (error) {
      if (!(error instanceof ImportError)) logError(`leitura da operação ${opId}`, error);
      await clearStaging(opId);
      const msg = error instanceof ImportError ? error.message : `Não foi possível ler o arquivo: ${(error as any)?.message ?? error}`;
      await update(opId, { ...done, status: ST.failed, error: dbText(msg, 4000) }, PREPARING_STATES);
    } else {
      const c = await countStaged(opId);
      const total = c.user + c.channel + c.message + c.contact;
      const counts = { count_users: c.user, count_channels: c.channel, count_messages: c.message, count_contacts: c.contact, count_total: total };
      if (!total) {
        const first = warnings.first(5);
        const msg = `Nenhum dado válido foi encontrado no arquivo.${first.length ? ` Avisos: ${first.join(' | ')}` : ''}`;
        await update(opId, { ...done, ...counts, status: ST.failed, error: msg }, PREPARING_STATES);
      } else {
        await update(opId, { ...done, ...counts, finished_at: null, status: ST.userSelection }, PREPARING_STATES);
      }
    }
  } catch (e) {
    logError(`fim da leitura da operação ${opId}`, e);
    await fail(opId, `Não foi possível ler o arquivo: ${(e as any)?.message ?? e}`).catch(() => {});
  } finally {
    endJob(opId);
  }
}

// ---------- Prévia e seleção ----------

export async function buildSelection(opId: string): Promise<ImportSelection> {
  const op = await one('SELECT importer_key FROM import_operations WHERE id = $1', [opId]);
  const out: ImportSelection = { name: importerName(op?.importer_key ?? ''), users: [], channels: [], contacts: [], message_count: 0 };

  const users: ImportUser[] = [];
  for await (const batch of iterateStaged<ImportUser>(opId, 'user', 2000)) for (const r of batch) users.push(r.data);
  // Mesmas regras que a conversão usa para achar a conta existente (e juntar os dados a ela): importação anterior do
  // mesmo id, qualquer um dos e-mails, ou o nome de usuário quando a conta é do mesmo tipo (bot ou não) e os e-mails
  // não se contradizem. Fora isso, mesmo nome é outra pessoa, que ganha uma conta nova com outro nome.
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? truncate(v.trim(), max) : '');
  const emailsOf = (u: ImportUser) => (Array.isArray(u.emails) ? u.emails : []).map((e) => clean(e, 254).toLowerCase()).filter(Boolean);
  const usernameOf = (u: ImportUser) => clean(u.username, 200).replace(/^@+/, '').toLowerCase();
  const idsOf = (v: { importIds?: unknown }) => (Array.isArray(v.importIds) ? v.importIds : []).filter((i) => i !== null && i !== undefined && i !== '').map(String);
  const emails = [...new Set(users.flatMap(emailsOf))];
  const usernames = [...new Set(users.map(usernameOf).filter(Boolean))];
  const takenEmails = new Set((await many('SELECT lower(email) AS v FROM users WHERE lower(email) = ANY($1::text[])', [emails])).map((r) => r.v));
  const byName = new Map(
    (await many('SELECT lower(username) AS v, type, email FROM users WHERE lower(username) = ANY($1::text[])', [usernames])).map((r) => [r.v, r]),
  );
  const mappedUsers = new Set(
    (
      await many(`SELECT m.import_id FROM import_map m JOIN users u ON u.id = m.target_id WHERE m.kind = 'user' AND m.import_id = ANY($1::text[])`, [
        [...new Set(users.flatMap(idsOf))],
      ])
    ).map((r) => r.import_id),
  );
  const existing = (u: ImportUser) => {
    const mine = emailsOf(u);
    if (idsOf(u).some((i) => mappedUsers.has(i)) || mine.some((e) => takenEmails.has(e))) return true;
    const other = byName.get(usernameOf(u));
    return !!other && (other.type === 'bot') === (u.type === 'bot') && !(other.email && mine.length);
  };
  out.users = users.map((u) => ({
    user_id: u.importIds?.[0] ?? '',
    username: u.username ?? '',
    name: u.name ?? '',
    email: u.emails?.[0] ?? '',
    is_deleted: !!u.deleted,
    is_bot: u.type === 'bot',
    is_email_taken: existing(u),
    // Só vale para contas criadas agora e quando quem importa pode dar o papel; a tela avisa antes.
    is_admin: Array.isArray(u.roles) && u.roles.includes('admin'),
    do_import: true,
  }));

  const channels: ImportChannel[] = [];
  let directs = 0;
  for await (const batch of iterateStaged<ImportChannel>(opId, 'channel', 2000)) {
    for (const r of batch) {
      if (r.data.t === 'd') directs++;
      else channels.push(r.data);
    }
  }
  // Mesmas regras que a conversão usa para achar a sala existente, na ordem do arquivo: o canal padrão; a sala ligada a
  // este mesmo id por uma importação anterior (import_map), salvo quando a ligação veio só do nome e a sala é de outro
  // canal deste arquivo; e, só para canal público, um canal público com o mesmo nome que nenhum outro canal deste
  // arquivo usa. Grupo privado nunca é achado pelo nome, e o segundo canal do arquivo com o mesmo nome vira outra sala.
  const slugOf = (c: ImportChannel) => sanitizeRoomName(clean(c.name, 500)).toLowerCase();
  const roomIdsOf = (c: ImportChannel) => [...new Set(idsOf(c))];
  const names = [...new Set(channels.map(slugOf).filter(Boolean))];
  const byRoomName = new Map(
    (await many(`SELECT id, t, lower(name) AS n FROM rooms WHERE t IN ('c','p') AND prid IS NULL AND lower(name) = ANY($1::text[])`, [names])).map((r) => [r.n, r]),
  );
  const mapped = await many(
    `SELECT m.import_id, r.id, r.t, r.prid, rc.import_id IS NOT NULL AS created
       FROM import_map m JOIN rooms r ON r.id = m.target_id
       LEFT JOIN import_map rc ON rc.kind = 'room-created' AND rc.import_id = m.import_id AND rc.target_id = m.target_id
      WHERE m.kind = 'room' AND m.import_id = ANY($1::text[])`,
    [[...new Set(channels.flatMap(roomIdsOf))]],
  );
  const mappedById = new Map(mapped.map((r) => [r.import_id, r]));
  // Salas ligadas a algum canal deste arquivo, e as que uma importação criou para um deles.
  const fileRooms = new Set(mapped.map((r) => r.id));
  const fileCreated = new Set(mapped.filter((r) => r.created).map((r) => r.id));
  const defaultRoom = channels.some((c) => c.isDefault) ? await one(`SELECT id FROM rooms WHERE is_default AND t = 'c' ORDER BY created_at LIMIT 1`) : null;
  // Sala existente → ids dos canais deste arquivo que já ficaram com ela.
  const used = new Map<string, Set<string>>();
  const existingRoom = (c: ImportChannel): string | null => {
    const ids = roomIdsOf(c);
    if (!ids.length || !clean(c.name, 500)) return null;
    if (c.isDefault && defaultRoom) return defaultRoom.id;
    const prev = ids.map((i) => mappedById.get(i)).find(Boolean);
    if (prev && (prev.t === 'c' || prev.t === 'p') && !prev.prid) {
      // Ligada antes só pelo nome: fica com o canal deste arquivo que a criou ou que já a usou acima.
      const created = ids.some((i) => mappedById.get(i)?.id === prev.id && mappedById.get(i)?.created);
      const holders = used.get(prev.id);
      return created || !(fileCreated.has(prev.id) || (holders && !ids.some((i) => holders.has(i)))) ? prev.id : null;
    }
    if (c.t === 'p') return null;
    const same = byRoomName.get(slugOf(c));
    return same?.t === 'c' && !used.has(same.id) && !fileRooms.has(same.id) ? same.id : null;
  };
  out.channels = channels.map((c): SelectionChannel => {
    const rid = existingRoom(c);
    if (rid) used.set(rid, new Set([...(used.get(rid) ?? []), ...roomIdsOf(c)]));
    return {
      channel_id: c.importIds?.[0] ?? '',
      name: c.name ?? '',
      is_archived: !!c.archived,
      is_private: c.t === 'p',
      is_direct: false,
      members: c.users?.length ?? 0,
      exists: !!rid,
      do_import: true,
    };
  });
  if (directs) {
    out.channels.push({ channel_id: DIRECT_MESSAGES_ID, name: 'Mensagens diretas', is_archived: false, is_private: true, is_direct: true, members: directs, exists: false, do_import: true });
  }

  for await (const batch of iterateStaged<ImportContact>(opId, 'contact', 2000)) {
    for (const r of batch) out.contacts.push({ id: r.data.importIds?.[0] ?? '', name: r.data.name ?? '', emails: r.data.emails ?? [], phones: r.data.phones ?? [], do_import: true });
  }
  out.message_count = (await countStaged(opId)).message;
  return out;
}

export async function importFileData() {
  const row = await validOperation();
  if (!row) throw operationNotFound();
  const operation = presentOperation(row);
  if (WAITING_STATES.includes(row.status) || PREPARING_STATES.includes(row.status)) return { waiting: true, operation };
  if (row.status === ST.userSelection) return { ...(await buildSelection(row.id)), operation };
  return { operation };
}

// ---------- Importação ----------

// Agrupa os contadores e grava a cada 500 ms (ou 200 registros); cada gravação também relê se a operação foi cancelada.
export function createProgressSink(opId: string): ProgressSink & { close(): Promise<void> } {
  const acc = { completed: 0, error: 0, skipped: 0 };
  let n = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  const write = async () => {
    const d = { ...acc };
    acc.completed = acc.error = acc.skipped = 0;
    n = 0;
    const changed = d.completed || d.error || d.skipped;
    const r = changed
      ? await one(
          `UPDATE import_operations SET count_completed = count_completed + $2, count_error = count_error + $3, count_skipped = count_skipped + $4, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [opId, d.completed, d.error, d.skipped],
        )
      : await one('SELECT * FROM import_operations WHERE id = $1', [opId]);
    // Fora das situações de importação (cancelada, ou dada como falha por outra instância): para.
    if (!r || !r.valid || !IMPORTING_STATES.includes(r.status)) stopped = true;
    if (r && changed) await emit(progressOf(r));
  };
  const flush = () => (chain = chain.then(write).catch((e) => logError('contadores', e)));
  const timer = setInterval(() => void flush(), 500);
  timer.unref();
  return {
    async step(step) {
      await flush();
      if (!(await update(opId, { status: step }, IMPORTING_STATES))) stopped = true;
    },
    inc(d) {
      const k = (d.completed ?? 0) + (d.error ?? 0) + (d.skipped ?? 0);
      if (!k) return;
      acc.completed += d.completed ?? 0;
      acc.error += d.error ?? 0;
      acc.skipped += d.skipped ?? 0;
      n += k;
      if (n >= 200) void flush();
    },
    flush: () => flush(),
    cancelled: () => stopped || jobs.get(opId)?.cancel === true,
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}

const summarizeSelection = (s: ShortSelection) =>
  Object.fromEntries((['users', 'channels', 'contacts'] as const).map((k) => [k, s[k]?.all ? 'all' : (s[k]?.list?.length ?? 0)]));

// Começa a importação da operação válida que está esperando a seleção.
export async function startImport(actor: Actor, input: ShortSelection, options: ImportOptions = {}, onlyKey?: ImporterKey) {
  await heartbeat();
  const params: unknown[] = [ST.importingStarted, JSON.stringify(options), bus.origin, ST.userSelection];
  const onlyWhere = onlyKey ? ` AND importer_key = $${params.push(onlyKey)}` : '';
  const row = await one(
    `UPDATE import_operations SET status = $1, options = $2, instance_id = $3, started_at = now(), finished_at = NULL, error = NULL,
       count_completed = 0, count_error = 0, count_skipped = 0, updated_at = now()
     WHERE valid AND status = $4${onlyWhere} RETURNING *`,
    params,
  );
  if (!row) throw badRequest('error-invalid-operation-status', 'A importação não está pronta: espere a leitura do arquivo terminar e escolha o que importar.');
  await emit(progressOf(row));
  await audit(actor, 'import.started', { operationId: row.id }, { importer: row.importer_key, selection: summarizeSelection(input), options });
  void runImport(row.id, actor, input, options);
  return row;
}

async function runImport(opId: string, actor: Actor, selection: ShortSelection, options: ImportOptions) {
  startJob(opId);
  const sink = createProgressSink(opId);
  try {
    const result = await runConversion({ operationId: opId, actor: { userId: actor.id ?? '', username: actor.username ?? '' }, selection, options, sink });
    await sink.close();
    await deleteSuccessful(opId);
    const status = sink.cancelled() ? ST.cancelled : ST.done;
    await update(opId, { status, finished_at: new Date() }, IMPORTING_STATES);
    await audit(actor, 'import.finished', { operationId: opId }, {
      status,
      users: result.users,
      channels: result.channels,
      messages: result.messages,
      contacts: result.contacts,
      rooms: result.roomIds.length,
      newUsers: result.newUserIds.length,
    });
  } catch (e: any) {
    await sink.close().catch(() => {});
    if (!(e instanceof ImportError)) logError(`importação ${opId}`, e);
    const msg = dbText(e?.message ?? e, 4000);
    // Uma operação que falhou não roda de novo: as senhas que ficaram nos dados lidos não servem mais. A situação
    // final vem por último, porque é ela que diz à tela (e a quem consulta a API) que tudo terminou.
    await scrubSecrets(opId).catch((err) => logError(`limpeza das senhas da operação ${opId}`, err));
    await audit(actor, 'import.failed', { operationId: opId }, { error: msg }).catch((err) => logError(`auditoria da operação ${opId}`, err));
    await fail(opId, msg).catch(() => {});
  } finally {
    endJob(opId);
  }
}

// Downloads posteriores de arquivos e fotos que ficaram na origem.
export async function startPending(actor: Actor, kind: 'files' | 'avatars') {
  const count = kind === 'files' ? await countPendingFiles() : await countPendingAvatars();
  // Sem nada para baixar, a operação já nasce concluída.
  const row = await newOperation(actor, kind === 'files' ? 'pending-files' : 'pending-avatars', {
    status: count ? ST.importingFiles : ST.done,
    fields: { count_total: count, started_at: new Date(), finished_at: count ? null : new Date() },
  });
  await audit(actor, kind === 'files' ? 'import.pendingFiles' : 'import.pendingAvatars', { operationId: row.id }, { count });
  if (count) void runPending(row.id, actor, kind);
  return { count, operation: row };
}

async function runPending(opId: string, actor: Actor, kind: 'files' | 'avatars') {
  startJob(opId);
  const sink = createProgressSink(opId);
  try {
    const r = kind === 'files' ? await runPendingFiles(opId, sink) : await runPendingAvatars(opId, sink);
    await sink.close();
    const status = sink.cancelled() ? ST.cancelled : ST.done;
    await update(opId, { status, finished_at: new Date() }, IMPORTING_STATES);
    await audit(actor, 'import.finished', { operationId: opId }, { status, importer: `pending-${kind}`, ...r });
  } catch (e: any) {
    await sink.close().catch(() => {});
    logError(`downloads pendentes ${opId}`, e);
    const msg = dbText(e?.message ?? e, 4000);
    await fail(opId, msg).catch(() => {});
    await audit(actor, 'import.failed', { operationId: opId }, { error: msg }).catch((err) => logError(`auditoria da operação ${opId}`, err));
  } finally {
    endJob(opId);
    await fs.promises.rm(operationDir(opId), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Cancelamento e recuperação ----------

export async function cancelOperation(actor: Actor) {
  const row = await validOperation();
  if (!row) throw operationNotFound();
  if (FINAL_STATES.includes(row.status)) throw badRequest('error-invalid-operation-status', 'Esta importação já terminou.');
  const job = jobs.get(row.id);
  let out = row;
  if (job) {
    // O trabalho para no próximo registro e grava a situação "cancelada" ao sair.
    job.cancel = true;
    job.abort?.();
  } else {
    out = (await markCancelled(row.id)) ?? row;
    if (row.status === ST.new || row.status === ST.userSelection) await clearStaging(row.id);
    else await scrubSecrets(row.id);
  }
  await audit(actor, 'import.cancelled', { operationId: row.id }, { status: row.status });
  return out;
}

// Operações presas em uma instância que parou (queda ou reinício) viram falha. `self` é a instância que confere
// (os testes simulam outra).
export async function recoverInterrupted(self: string = bus.origin): Promise<number> {
  const rows = await many(
    `UPDATE import_operations o SET status = $1, error = $2, finished_at = now(), updated_at = now()
      WHERE status = ANY($3::text[]) AND instance_id IS DISTINCT FROM $4
        AND NOT EXISTS (SELECT 1 FROM instances i WHERE i.id = o.instance_id AND i.last_seen > now() - interval '90 seconds')
      RETURNING *`,
    [ST.failed, INTERRUPTED, BUSY_STATES, self],
  );
  for (const r of rows) {
    await scrubSecrets(r.id).catch((e) => logError(`limpeza das senhas da operação ${r.id}`, e));
    await emit(progressOf(r));
  }
  return rows.length;
}

// ---------- Importação pela API ----------

function assertApiOperation(op: any) {
  if (!op || op.importer_key !== 'api') throw badRequest('error-operation-not-found', 'A importação pela API não foi iniciada. Chame import.new antes.');
  if (FINAL_STATES.includes(op.status)) throw badRequest('error-invalid-operation-status', 'A importação atual já terminou. Chame import.new para começar outra.');
  if (op.status !== ST.new && op.status !== ST.userSelection) throw badRequest('error-invalid-operation-status', 'A importação atual não pode receber novos dados.');
}

// Conferência antecipada (antes de gerar o hash das senhas); addApiUsers confere de novo dentro da transação.
export async function checkApiOperation() {
  assertApiOperation(await validOperation());
}

export async function addApiUsers(users: ImportUser[]) {
  const row = await tx(async (c) => {
    const op = await one('SELECT * FROM import_operations WHERE valid FOR UPDATE', [], c);
    assertApiOperation(op);
    if (!users.length) return op;
    await stageRecords(op.id, users.map((u) => ({ type: 'user' as const, importId: u.importIds[0], data: u })), c);
    const n = await countStaged(op.id, c);
    return update(op.id, { status: ST.userSelection, count_users: n.user, count_total: n.user + n.channel + n.message + n.contact }, [ST.new, ST.userSelection], c);
  });
  await emit(progressOf(row));
  return row;
}

export function coarseState(r: any): 'new' | 'loading' | 'ready' | 'importing' | 'done' | 'error' | 'canceled' {
  if (!r.valid && r.status !== ST.done) return 'error';
  if (r.status === ST.new) return 'new';
  if (WAITING_STATES.includes(r.status) || PREPARING_STATES.includes(r.status)) return 'loading';
  if (r.status === ST.userSelection) return 'ready';
  if (IMPORTING_STATES.includes(r.status)) return 'importing';
  if (r.status === ST.done) return 'done';
  if (r.status === ST.cancelled) return 'canceled';
  return 'error';
}

// ---------- Histórico e erros ----------

export async function latestOperations(offset: number, count: number) {
  const rows = await many(`SELECT *, count(*) OVER() AS total FROM import_operations ORDER BY created_at DESC LIMIT ${count} OFFSET ${offset}`);
  const total = rows.length ? Number(rows[0].total) : Number((await one('SELECT count(*)::int AS n FROM import_operations'))?.n ?? 0);
  return { operations: rows.map((r) => mapOperation(r, importerName(r.importer_key))), total };
}

// Troca os marcadores de menção (MENTION_OPEN [@#] id |rótulo MENTION_CLOSE) pelo rótulo, ou pelo id sem rótulo.
// Varredura linear: a regex equivalente volta atrás e fica quadrática num texto com muitas aberturas sem fechamento.
export function plainMentions(s: string): string {
  const parts: string[] = [];
  let from = 0;
  let close = -1;
  for (let open = s.indexOf(MENTION_OPEN); open >= 0; open = s.indexOf(MENTION_OPEN, open + 1)) {
    if (close < open) close = s.indexOf(MENTION_CLOSE, open + 1);
    if (close < 0) break;
    const sigil = s[open + 1];
    if (open + 1 >= close || (sigil !== '@' && sigil !== '#')) continue;
    const body = s.slice(open + 2, close);
    const bar = body.indexOf('|');
    const id = bar < 0 ? body : body.slice(0, bar);
    const label = bar < 0 ? '' : body.slice(bar + 1);
    parts.push(s.slice(from, open), sigil, label || id);
    from = close + 1;
    open = close;
  }
  parts.push(s.slice(from));
  return parts.join('');
}

function recordLabel(type: string, importId: string | null, d: any): string {
  if (type === 'user') return d.username || d.name || d.emails?.[0] || importId || '';
  if (type === 'channel') return d.t === 'd' ? 'Mensagem direta' : d.name || importId || '';
  if (type === 'contact') return d.name || d.emails?.[0] || d.phones?.[0] || importId || '';
  const text = plainMentions(String(d.msg ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return d.files?.[0]?.name ? `📎 ${d.files[0].name}` : importId || '';
  // Corte por caractere (um emoji não fica pela metade).
  const cut = truncate(text, 80);
  return cut.length < text.length ? `${cut}…` : cut;
}

export async function listErrors(opts: { operationId?: string; type?: string; offset: number; count: number }) {
  const opId = opts.operationId || (await currentOperation())?.id;
  if (!opId) return { errors: [], total: 0 };
  const params: unknown[] = [opId];
  const typeWhere = opts.type ? ` AND data_type = $${params.push(opts.type)}` : '';
  const where = `operation_id = $1 AND errors <> '[]'::jsonb${typeWhere}`;
  const rows = await many(`SELECT id, data_type, import_id, data, errors FROM import_records WHERE ${where} ORDER BY id LIMIT ${opts.count} OFFSET ${opts.offset}`, params);
  const total = (await one(`SELECT count(*)::int AS n FROM import_records WHERE ${where}`, params))?.n ?? 0;
  return {
    errors: rows.map((r) => ({ id: Number(r.id), type: r.data_type, importId: r.import_id, label: recordLabel(r.data_type, r.import_id, r.data), messages: r.errors })),
    total,
  };
}
