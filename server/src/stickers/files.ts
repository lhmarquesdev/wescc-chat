import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalize, probeImage, ProbeError, sniffMime, type ImageProbe, type ProbeFormat } from '@shared/imageProbe';
import {
  phashFromDb,
  phashToDb,
  similarSticker,
  STICKER_LIMITS,
  STICKER_PATH_RE,
  stickerExt,
  stickerPosterUrl,
  stickerUrl,
  type StickerFileInfo,
  type StickerMime,
} from '@shared/stickers';
import { config } from '../config';
import { many, one, pool, query, type Queryable } from '../db/pool';
import { ApiError, badRequest, notFound, unauthorized } from '../lib/errors';
import { audit } from '../services/audit';
import { rolesWithPermission } from '../services/permissions';
import { canAccessRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { storedPath, typeAllowed, writeStored } from '../services/uploads';
import { actorOf, type Ctx } from '../services/users';
import { stickerRoleFlags, type StickerRoleFlags } from './service';
import { claimWritten, queueTrash } from './trash';

// Figurinhas: validação dos arquivos, gravação endereçada pelo conteúdo, regras de acesso e as rotas dos bytes.

export interface StickerFileRow {
  id: string;
  sha256: string;
  phash: string | null; // texto do bigint com sinal (phashFromDb converte para hex)
  mime: StickerMime;
  width: number;
  height: number;
  size: number;
  animated: boolean;
  frames: number;
  duration_ms: number | null;
  alpha: boolean;
  path: string | null;
  poster_path: string | null;
  poster_mime: string | null;
  poster_size: number | null;
  created_by: string | null;
  created_at: string;
  orphan_since: string | null;
  blocked_at: string | null;
  blocked_by: { _id: string; username: string } | null;
  blocked_reason: string | null;
  blocked_name: string | null;
  quarantine_path: string | null;
  quarantine_poster_path: string | null;
  quarantine_until: string | null;
}

// O parser de bigint do pool vira Number e perderia bits do hash: o hash sempre sai como texto.
export const FILE_COLUMNS = '*, phash::text AS phash';

// Pacote da organização visível para quem tem os papéis `roles` (e para gestores, todos os publicados).
export const visibleOrgSql = (p: string, roles: string, manager: string) =>
  `(${p}.scope = 'org' AND ${p}.status = 'published' AND (${manager} OR ${p}.visible_roles = '{}' OR ${p}.visible_roles && ${roles}))`;
// Pacote da organização que limita quem vê: rascunho ou "Visível para" preenchido.
export const restrictedOrgSql = (p: string) => `(${p}.scope = 'org' AND (${p}.status = 'draft' OR ${p}.visible_roles <> '{}'))`;

const ID_RE = /^[A-Za-z0-9]{10,24}$/;
const fileIdOfPath = (rel: string) => (rel.split('/').pop() ?? '').replace(/\.poster$/, '');

// ---------- Leitura do multipart ----------

export interface StickerParts {
  file?: Buffer;
  poster?: Buffer;
  fields: Record<string, string>;
}

const STICKER_FIELDS = new Set(['packId', 'name', 'emojis', 'keywords', 'phash', 'sourceMessageId', 'batch']);
const LIMIT_ERRORS: Record<string, string> = {
  FST_FIELDS_LIMIT: 'Campos demais no envio.',
  FST_PARTS_LIMIT: 'Partes demais no envio.',
  FST_FILES_LIMIT: 'Envie só a figurinha e, se for animada, a imagem parada.',
};

const tooLarge = (kb: number) => new ApiError(413, 'error-sticker-too-large', `A figurinha passa do limite de ${kb} KB.`);
const unreadable = () => badRequest('error-invalid-params', 'Não foi possível ler o envio da figurinha. Tente de novo.');

// onFirstFile roda antes de o primeiro arquivo ser lido: resolve o pacote e recusa cedo, sem guardar 1 MB à toa.
export async function readStickerParts(req: FastifyRequest, onFirstFile: (fields: Record<string, string>) => Promise<void>): Promise<StickerParts> {
  const maxKB = Math.max(getSetting<number>('Stickers_Max_Static_KB'), getSetting<number>('Stickers_Max_Animated_KB'));
  const out: StickerParts = { fields: {} };
  let started = false;
  let fromTarget: unknown = null; // erro de onFirstFile (banco, permissão): passa como veio
  try {
    // Limites desta rota (dois arquivos) no lugar dos globais do app.ts (um arquivo).
    const parts = (req as any).parts({ limits: { files: 2, fields: 10, parts: 12, fieldSize: 8 * 1024, fileSize: maxKB * 1024 + 1 } });
    for await (const part of parts) {
      if (part.type !== 'file') {
        if (started) throw badRequest('error-invalid-params', 'Envie os campos antes dos arquivos.');
        if (part.valueTruncated) throw new ApiError(413, 'error-field-too-large', 'Texto grande demais no envio.');
        if (STICKER_FIELDS.has(part.fieldname)) out.fields[part.fieldname] = String(part.value ?? '');
        continue;
      }
      const kind = part.fieldname as 'file' | 'poster';
      if ((kind !== 'file' && kind !== 'poster') || out[kind]) {
        part.file.resume();
        throw badRequest('error-invalid-params', 'Envie a figurinha no campo "file" e a imagem parada no campo "poster".');
      }
      if (!started) {
        started = true;
        try {
          await onFirstFile(out.fields);
        } catch (e) {
          part.file.resume();
          fromTarget = e;
          throw e;
        }
      }
      out[kind] = await part.toBuffer();
    }
  } catch (e) {
    const code = (e as any)?.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(maxKB);
    if (LIMIT_ERRORS[code]) throw new ApiError(413, 'error-too-many-parts', LIMIT_ERRORS[code]);
    if (e === fromTarget || e instanceof ApiError) throw e;
    // Corpo cortado, sem boundary, campo proibido: o leitor do multipart fala inglês e viraria erro interno.
    throw unreadable();
  }
  return out;
}

// ---------- Validação ----------

export interface ValidSticker {
  bytes: Uint8Array;
  probe: ImageProbe;
  mime: StickerMime;
  sha256: string;
  phash: string | null;
}

function probeFailure(e: unknown): Error {
  if (!(e instanceof ProbeError)) return e as Error;
  if (e.reason === 'format') return badRequest('error-sticker-format', 'Formato não suportado. Use PNG, WebP ou GIF.');
  if (e.reason === 'too-many-frames') return badRequest('error-sticker-too-many-frames', `A animação tem quadros demais (máximo de ${STICKER_LIMITS.maxFrames}).`);
  return badRequest('error-sticker-corrupt', 'Não foi possível ler esta imagem. O arquivo pode estar corrompido.');
}

export function validateStickerBytes(buf: Uint8Array, opts: { personal: boolean; phash: string | null }): ValidSticker {
  const sniffed = sniffMime(buf);
  // JPEG nunca vira figurinha direto: o editor sempre o recodifica.
  if (!sniffed || sniffed === 'image/jpeg') throw badRequest('error-sticker-format', 'Formato não suportado. Use PNG, WebP ou GIF.');
  if (opts.personal && !typeAllowed(sniffed)) throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');
  let probe: ImageProbe;
  try {
    probe = probeImage(buf, { maxFrames: STICKER_LIMITS.maxFrames });
  } catch (e) {
    throw probeFailure(e);
  }
  if (probe.width > STICKER_LIMITS.maxSide || probe.height > STICKER_LIMITS.maxSide) {
    throw badRequest('error-sticker-dimensions', `A figurinha precisa ter no máximo 512 × 512 px (esta tem ${probe.width} × ${probe.height}).`);
  }
  if (Math.max(probe.width, probe.height) < STICKER_LIMITS.minLongSide) {
    throw badRequest('error-sticker-too-small', `A figurinha precisa ter pelo menos ${STICKER_LIMITS.minLongSide} px no lado maior.`);
  }
  let limitKB = getSetting<number>('Stickers_Max_Static_KB');
  if (probe.animated) {
    if (!getSetting('Stickers_Animated_Enabled')) throw new ApiError(403, 'error-sticker-animated-disabled', 'Figurinhas animadas estão desativadas.');
    const maxSeconds = getSetting<number>('Stickers_Max_Animated_Seconds');
    if (probe.durationMs > maxSeconds * 1000) throw badRequest('error-sticker-too-long', `A animação passa do limite de ${maxSeconds} segundos.`);
    limitKB = getSetting<number>('Stickers_Max_Animated_KB');
  }
  if (buf.length > limitKB * 1024) throw tooLarge(limitKB);
  let bytes: Uint8Array;
  try {
    bytes = canonicalize(buf, probe.format as Exclude<ProbeFormat, 'jpeg'>);
  } catch (e) {
    throw probeFailure(e);
  }
  if (bytes.length > limitKB * 1024) throw tooLarge(limitKB);
  // Hex do sha256 dos bytes canônicos (o sha256 de lib/ids.ts é de texto e em base64).
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, probe, mime: probe.mime as StickerMime, sha256, phash: opts.phash };
}

export function validatePoster(buf: Uint8Array, width: number, height: number): { bytes: Uint8Array; mime: 'image/webp' | 'image/png' } {
  const invalid = () => badRequest('error-sticker-poster-invalid', 'A imagem parada da figurinha animada é inválida.');
  const mime = sniffMime(buf);
  if ((mime !== 'image/png' && mime !== 'image/webp') || buf.length > STICKER_LIMITS.posterMaxKB * 1024) throw invalid();
  try {
    const probe = probeImage(buf, { maxFrames: 1 });
    if (probe.animated || probe.width !== width || probe.height !== height) throw invalid();
    return { bytes: canonicalize(buf, probe.format as Exclude<ProbeFormat, 'jpeg'>), mime };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw invalid();
  }
}

// ---------- Gravação ----------

// Sinal interno: a linha sumiu (a limpeza apagou) entre a busca e a transação; a rota refaz a gravação uma vez.
export class StickerRetry extends Error {
  constructor() {
    super('figurinha: refazer a gravação');
  }
}

const blockedError = () => new ApiError(403, 'error-sticker-blocked', 'Esta imagem foi removida pela moderação e não pode virar figurinha.');
export const restrictedError = () => new ApiError(403, 'error-sticker-restricted', 'Esta figurinha é de um pacote restrito e não pode ser salva.');

// Trava (ou cria) a linha do arquivo dentro da transação de quem vai usá-lo: a remoção e a limpeza esperam por ela.
export async function storeStickerFile(
  db: Queryable,
  ctx: Ctx,
  v: ValidSticker,
  written: { path: string; posterPath: string | null; posterMime?: string | null; posterSize?: number | null } | null,
): Promise<StickerFileRow> {
  const lock = () => one<StickerFileRow>(`UPDATE sticker_files SET orphan_since = NULL WHERE sha256 = $1 RETURNING ${FILE_COLUMNS}`, [v.sha256], db);
  let row = await lock();
  if (!row) {
    if (!written) throw new StickerRetry();
    const p = v.probe;
    row = await one<StickerFileRow>(
      `INSERT INTO sticker_files (id, sha256, phash, mime, width, height, size, animated, frames, duration_ms, alpha, path, poster_path, poster_mime, poster_size, created_by)
       VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (sha256) DO NOTHING RETURNING ${FILE_COLUMNS}`,
      [
        fileIdOfPath(written.path),
        v.sha256,
        v.phash ? phashToDb(v.phash) : null,
        v.mime,
        p.width,
        p.height,
        v.bytes.length,
        p.animated,
        p.frames,
        p.animated ? p.durationMs : null,
        p.alpha ?? true,
        written.path,
        written.posterPath,
        written.posterPath ? (written.posterMime ?? null) : null,
        written.posterPath ? (written.posterSize ?? null) : null,
        ctx.userId,
      ],
      db,
    );
    if (row) {
      await claimWritten(db, [written.path, written.posterPath]);
      return row;
    }
    // Outro envio do mesmo conteúdo ganhou a corrida: vale a linha dele e os bytes gravados agora sobram.
    await queueTrash(db, written.path);
    await queueTrash(db, written.posterPath);
    row = await lock();
    if (!row) throw new StickerRetry();
  } else if (written) {
    await queueTrash(db, written.path);
    await queueTrash(db, written.posterPath);
  }
  if (row.blocked_at) throw blockedError();
  if (isRestricted(await fileFacts(ctx.userId, row.id, db))) throw restrictedError();
  // A primeira cópia mantém o pôster; um hash que faltava passa a valer.
  if (!row.phash && v.phash) {
    await query('UPDATE sticker_files SET phash = $2::bigint WHERE id = $1', [row.id, phashToDb(v.phash)], db);
    row.phash = phashToDb(v.phash);
  }
  return row;
}

// Arquivo vivo que sumiu do disco (antivírus, backup sem a pasta de uploads): quem envia o mesmo conteúdo o devolve.
// O pôster não é endereçado pelo conteúdo e aparece para todos: só quem enviou primeiro ou um gestor o devolve.
// Roda com a linha travada por storeStickerFile, então nem a remoção nem a limpeza mexem nele ao mesmo tempo.
export async function restoreMissingBytes(
  db: Queryable,
  ctx: Ctx,
  row: StickerFileRow,
  v: ValidSticker,
  poster: { bytes: Uint8Array; mime: string } | null,
  manager: boolean,
): Promise<void> {
  if (row.blocked_at || row.sha256 !== v.sha256) return;
  const missing = async (rel: string | null): Promise<boolean> => !!rel && !(await fs.promises.access(storedPath(rel)).then(() => true, () => false));
  // Erro de disco não derruba a criação: a figurinha nova vale do mesmo jeito e o próximo envio tenta de novo.
  const write = (rel: string, bytes: Uint8Array) => writeStored(rel, bytes).then(() => true, () => false);
  if (await missing(row.path)) await write(row.path!, v.bytes);
  if (!poster || !row.poster_path || row.poster_mime !== poster.mime || !(await missing(row.poster_path))) return;
  if (row.created_by !== ctx.userId && !manager) {
    if (config.logLevel !== 'silent') console.error(`Figurinhas: o pôster de ${row.id} sumiu do disco; só quem a enviou primeiro ou um gestor pode devolvê-lo.`);
    return;
  }
  if (!(await write(row.poster_path, poster.bytes))) return;
  if (row.poster_size !== poster.bytes.length) {
    await query('UPDATE sticker_files SET poster_size = $2 WHERE id = $1', [row.id, poster.bytes.length], db);
    row.poster_size = poster.bytes.length;
  }
  // Fora da transação: o disco já mudou, mesmo que a criação falhe depois.
  await audit(actorOf(ctx), 'sticker.poster_restored', { fileId: row.id }, { size: poster.bytes.length, createdBy: row.created_by });
}

// FOR SHARE, só se não bloqueado: serializa com o FOR UPDATE da remoção.
export async function lockLiveFile(db: Queryable, fileId: string): Promise<StickerFileRow | null> {
  return one<StickerFileRow>(`SELECT ${FILE_COLUMNS} FROM sticker_files WHERE id = $1 AND blocked_at IS NULL FOR SHARE`, [fileId], db);
}

// ---------- Fatos sobre um arquivo para uma pessoa ----------

export interface FileFacts {
  file: StickerFileRow | null;
  visibleOrg: { stickerId: string; packId: string; packName: string; name: string; emojis: string[] } | null; // primeiro por sort
  inOwn: boolean;
  inRestrictedOrg: boolean;
  inAnyOrg: boolean;
  inItems: boolean;
  manager: boolean;
}

export async function fileFacts(userId: string, fileId: string, db: Queryable = pool): Promise<FileFacts> {
  const r = await one(
    `SELECT f.*, f.phash::text AS phash, u.manager,
       vo.sticker_id AS vo_sticker_id, vo.pack_id AS vo_pack_id, vo.pack_name AS vo_pack_name, vo.name AS vo_name, vo.emojis AS vo_emojis,
       EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = f.id AND p.owner_id = $2) AS in_own,
       EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = f.id AND ${restrictedOrgSql('p')}) AS in_restricted_org,
       EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = f.id AND p.scope = 'org') AS in_any_org,
       EXISTS (SELECT 1 FROM sticker_user_items i WHERE i.user_id = $2 AND i.file_id = f.id) AS in_items
     FROM (SELECT coalesce(us.roles, '{}') AS roles, coalesce(us.roles && $3::text[], false) AS manager
           FROM (SELECT 1) one LEFT JOIN users us ON us.id = $2) u
     LEFT JOIN sticker_files f ON f.id = $1
     LEFT JOIN LATERAL (
       SELECT s.id AS sticker_id, p.id AS pack_id, p.name AS pack_name, s.name, s.emojis
       FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
       WHERE s.file_id = f.id AND ${visibleOrgSql('p', 'u.roles', 'u.manager')}
       ORDER BY p.sort, p.created_at, s.sort, s.created_at LIMIT 1
     ) vo ON true`,
    [fileId, userId, rolesWithPermission('manage-sticker-packs')],
    db,
  );
  return {
    file: r?.id ? (r as StickerFileRow) : null,
    visibleOrg: r?.vo_sticker_id ? { stickerId: r.vo_sticker_id, packId: r.vo_pack_id, packName: r.vo_pack_name, name: r.vo_name, emojis: r.vo_emojis ?? [] } : null,
    inOwn: !!r?.in_own,
    inRestrictedOrg: !!r?.in_restricted_org,
    inAnyOrg: !!r?.in_any_org,
    inItems: !!r?.in_items,
    manager: !!r?.manager,
  };
}

export const isRestricted = (f: FileFacts) => f.inRestrictedOrg && !f.visibleOrg && !f.inOwn && !f.manager;
export const isUsable = (f: FileFacts) => !!f.file && !f.file.blocked_at && (!!f.visibleOrg || f.inOwn || (f.inItems && !isRestricted(f)));

// ---------- Quase iguais (hash perceptual vindo do navegador) ----------

const near = (rows: { phash: string | null; width: number; height: number }[], v: ValidSticker) =>
  rows.some((r) => similarSticker({ phash: phashFromDb(r.phash), width: r.width, height: r.height }, { phash: v.phash, width: v.probe.width, height: v.probe.height }));

// Moderadores ficam de fora: um falso positivo precisa de uma saída.
export async function assertNotNearBlocked(flags: StickerRoleFlags, v: ValidSticker): Promise<void> {
  if (!v.phash || flags.moderator) return;
  const rows = await many('SELECT phash::text AS phash, width, height FROM sticker_files WHERE blocked_at IS NOT NULL AND phash IS NOT NULL');
  if (near(rows, v)) {
    throw new ApiError(403, 'error-sticker-blocked-similar', 'Esta imagem é parecida demais com uma figurinha removida pela moderação. Se for um engano, fale com a moderação.');
  }
}

export async function assertNotNearRestricted(userId: string, flags: StickerRoleFlags, v: ValidSticker): Promise<void> {
  if (!v.phash || flags.manager) return;
  const rows = await many(
    `WITH u AS (SELECT coalesce((SELECT roles FROM users WHERE id = $1), '{}') AS roles)
     SELECT f.phash::text AS phash, f.width, f.height FROM sticker_files f, u
     WHERE f.phash IS NOT NULL AND f.blocked_at IS NULL
       AND EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = f.id AND ${restrictedOrgSql('p')})
       AND NOT EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
                       WHERE s.file_id = f.id AND (p.owner_id = $1 OR ${visibleOrgSql('p', 'u.roles', 'false')}))`,
    [userId],
  );
  if (near(rows, v)) throw restrictedError();
}

// ---------- Acesso aos bytes ----------

let byteLimit: number = STICKER_LIMITS.byteChecksPerMinute;
const byteChecks = new Map<string, { start: number; n: number }>();
const allowed = new Map<string, number>(); // `${userId}:${fileId}` -> expira em
const denied = new Map<string, Map<string, number>>(); // fileId -> userId -> expira em

// Arquivos de pacotes publicados sem "Visível para": qualquer pessoa logada vê, sem consulta por pessoa.
let publicFiles = new Set<string>();
let publicAt = 0;
let publicDirty = true;
let publicLoading: Promise<Set<string>> | null = null;

export function markOrgFilesDirty() {
  publicDirty = true;
}

async function publicOrgFiles(): Promise<Set<string>> {
  if (!publicDirty && Date.now() - publicAt < 60_000) return publicFiles;
  if (publicLoading) return publicLoading;
  publicDirty = false;
  publicLoading = (async () => {
    try {
      const rows = await many(
        `SELECT DISTINCT s.file_id FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
         WHERE p.scope = 'org' AND p.status = 'published' AND p.visible_roles = '{}'`,
      );
      publicFiles = new Set(rows.map((r) => r.file_id));
      publicAt = Date.now();
      return publicFiles;
    } catch (e) {
      publicDirty = true;
      throw e;
    } finally {
      publicLoading = null;
    }
  })();
  return publicLoading;
}

export function clearStickerAccessCache() {
  allowed.clear();
  denied.clear();
}

// Quem acabou de ser recusado passa a ver assim que a figurinha é enviada numa sala dele.
export function forgetDenied(fileId: string) {
  denied.delete(fileId);
}

export function forgetDeniedUser(userId: string) {
  for (const m of denied.values()) m.delete(userId);
}

// Também zera os contadores.
export function __setStickerByteLimitForTests(perMinute: number) {
  byteLimit = perMinute;
  byteChecks.clear();
}

function countByteCheck(userId: string, now: number) {
  const c = byteChecks.get(userId);
  if (!c || now - c.start >= 60_000) {
    if (byteChecks.size > 20_000) for (const [k, v] of byteChecks) if (now - v.start >= 60_000) byteChecks.delete(k);
    byteChecks.set(userId, { start: now, n: 1 });
    return;
  }
  if (++c.n > byteLimit) throw new ApiError(429, 'error-too-many-requests', 'Limite de requisições excedido. Tente novamente em 60s.');
}

async function checkAccess(userId: string, fileId: string): Promise<boolean> {
  if ((await stickerRoleFlags(userId)).moderationViewer) return true;
  const f = await fileFacts(userId, fileId);
  if (!f.file) return false;
  if (f.manager && f.inAnyOrg) return true;
  if (f.visibleOrg || f.inOwn || f.inItems) return true;
  const member = await one(
    'SELECT 1 FROM messages m JOIN subscriptions s ON s.room_id = m.room_id AND s.user_id = $1 WHERE m.sticker_file_id = $2 LIMIT 1',
    [userId, fileId],
  );
  if (member) return true;
  // Canais públicos que a pessoa pode ver sem entrar.
  const rooms = await many(
    `SELECT r.* FROM (SELECT DISTINCT room_id FROM messages WHERE sticker_file_id = $1) x JOIN rooms r ON r.id = x.room_id AND r.t = 'c' LIMIT 20`,
    [fileId],
  );
  for (const room of rooms) if (await canAccessRoom(userId, room)) return true;
  return false;
}

export async function canViewStickerFile(userId: string, fileId: string): Promise<boolean> {
  const key = `${userId}:${fileId}`;
  const now = Date.now();
  const ok = allowed.get(key);
  if (ok !== undefined) {
    if (ok > now) return true;
    allowed.delete(key);
  }
  if ((await publicOrgFiles()).has(fileId)) return true;
  const no = denied.get(fileId)?.get(userId);
  if (no !== undefined) {
    if (no > now) return false;
    denied.get(fileId)?.delete(userId);
  }
  countByteCheck(userId, now);
  const yes = await checkAccess(userId, fileId);
  if (yes) {
    allowed.set(key, now + STICKER_LIMITS.accessCacheMs);
    while (allowed.size > STICKER_LIMITS.accessCacheMax) allowed.delete(allowed.keys().next().value as string);
  } else {
    let m = denied.get(fileId);
    if (!m) denied.set(fileId, (m = new Map()));
    m.set(userId, now + STICKER_LIMITS.deniedCacheMs);
    while (denied.size > STICKER_LIMITS.accessCacheMax) denied.delete(denied.keys().next().value as string);
  }
  return yes;
}

// ---------- Leituras abertas (a remoção corta) ----------

const streams = new Map<string, Set<Readable>>();

function trackStream(fileId: string, s: Readable) {
  let set = streams.get(fileId);
  if (!set) streams.set(fileId, (set = new Set()));
  set.add(s);
  s.once('close', () => {
    set.delete(s);
    if (!set.size && streams.get(fileId) === set) streams.delete(fileId);
  });
}

// No Windows um arquivo aberto não pode ser apagado nem movido: corta as leituras antes da lixeira.
export function destroyStickerStreams(fileId: string) {
  const set = streams.get(fileId);
  if (!set) return;
  streams.delete(fileId);
  for (const s of set) s.destroy();
}

// ---------- Formato das respostas ----------

export function toFileInfo(
  fileId: string,
  f: { mime: string; width: number; height: number; size: number; animated: boolean; frames: number; duration_ms: number | null; poster_mime: string | null },
): StickerFileInfo {
  const info: StickerFileInfo = {
    fileId,
    mime: f.mime as StickerMime,
    width: f.width,
    height: f.height,
    size: f.size,
    animated: f.animated,
    frames: f.frames,
    url: stickerUrl(fileId, f.mime),
  };
  if (f.animated) {
    if (f.duration_ms != null) info.durationMs = f.duration_ms;
    if (f.poster_mime) info.posterUrl = stickerPosterUrl(fileId, f.poster_mime);
  }
  return info;
}

// ---------- Rotas dos bytes ----------

function stickerHeaders(reply: FastifyReply, mime: string, size: number, cache: string) {
  reply.header('Content-Type', mime);
  reply.header('Content-Length', size);
  reply.header('Cache-Control', cache);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Content-Disposition', `inline; filename="figurinha.${stickerExt(mime)}"`);
}

async function openStored(rel: string | null): Promise<Readable | null> {
  if (!rel) return null;
  try {
    const handle = await fs.promises.open(storedPath(rel), 'r');
    return handle.createReadStream();
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

const etagMatches = (header: string | string[] | undefined, etag: string) =>
  String(header ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .includes(etag);

async function serveSticker(req: FastifyRequest, reply: FastifyReply, fileId: string, ext: string, poster: boolean) {
  const ctx = req.ctx;
  if (!ctx) throw unauthorized();
  const missing = () => notFound('error-sticker-not-found', 'Figurinha não encontrada.');
  const f = await one(
    `SELECT id, sha256, mime, size, path, poster_path, poster_mime, poster_size, blocked_at, quarantine_path, quarantine_poster_path,
            coalesce(quarantine_until > now(), false) AS quarantine_live
     FROM sticker_files WHERE id = $1`,
    [fileId],
  );
  const mime: string | null = poster ? f?.poster_mime : f?.mime;
  if (!f || !mime || stickerExt(mime) !== ext) throw missing();
  const size: number = poster ? f.poster_size : f.size;
  if (f.blocked_at) {
    // A cópia vencida não é servida nem antes da limpeza diária: vale o mesmo "quarentena" da lista de removidas.
    const copy = f.quarantine_live ? (poster ? f.quarantine_poster_path : f.quarantine_path) : null;
    if ((req.query as any)?.q === '1' && copy && (await stickerRoleFlags(ctx.userId)).moderationViewer) {
      const stream = await openStored(copy);
      if (stream) {
        trackStream(fileId, stream);
        await audit(actorOf(ctx), 'sticker.quarantine_viewed', { fileId });
        stickerHeaders(reply, mime, size, 'no-store');
        return reply.send(stream);
      }
    }
    reply.header('Cache-Control', 'no-store');
    return reply.status(410).send({ success: false, error: 'Esta figurinha foi removida.', errorType: 'error-sticker-removed' });
  }
  try {
    if (!(await canViewStickerFile(ctx.userId, fileId))) throw missing();
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 429) reply.header('Retry-After', '60');
    throw e;
  }
  // O disco antes do cache: um 404 com "immutable" (ou um 304) prenderia o navegador no erro mesmo depois de o arquivo voltar.
  const stream = await openStored(poster ? f.poster_path : f.path);
  if (!stream) {
    reply.header('Cache-Control', 'no-store');
    throw missing();
  }
  const etag = `"${String(f.sha256).slice(0, 32)}${poster ? '-p' : ''}"`;
  stickerHeaders(reply, mime, size, 'private, max-age=31536000, immutable');
  reply.header('ETag', etag);
  if (etagMatches(req.headers['if-none-match'], etag)) {
    stream.destroy();
    return reply.status(304).send();
  }
  trackStream(fileId, stream);
  return reply.send(stream);
}

export function stickerFilesRoutes(app: FastifyInstance) {
  app.get('/sticker/:name', async (req, reply) => {
    const m = STICKER_PATH_RE.exec(String((req.params as any).name ?? ''));
    if (!req.ctx) throw unauthorized();
    if (!m) throw notFound('error-sticker-not-found', 'Figurinha não encontrada.');
    return serveSticker(req, reply, m[1], m[2], false);
  });
  app.get('/sticker/:fileId/:poster', async (req, reply) => {
    const { fileId, poster } = req.params as any;
    const m = /^poster\.(webp|png|gif)$/.exec(String(poster ?? ''));
    if (!req.ctx) throw unauthorized();
    if (!ID_RE.test(String(fileId ?? '')) || !m) throw notFound('error-sticker-not-found', 'Figurinha não encontrada.');
    return serveSticker(req, reply, fileId, m[1], true);
  });
}
