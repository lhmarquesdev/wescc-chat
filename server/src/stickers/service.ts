import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import {
  canCreateFromMessage,
  cleanEmojis,
  cleanKeywords,
  cleanStickerName,
  DEFAULT_STICKER_NAME,
  normalizeSearch,
  PHASH_RE,
  rolesBlockedFromSending,
  STICKER_LIMITS,
  stickerExt,
  type MessageSticker,
  type StickerCatalogMine,
  type StickerCatalogOrg,
  type StickerCatalogUnchanged,
  type StickerItem,
  type StickerPack,
  type StickerQuota,
  type StickerScope,
  type StickerUserItem,
} from '@shared/stickers';
import { many, one, pool, query, tx, type Queryable } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { filterBadWords, getMessageRow, withExtra } from '../services/messages';
import { getUserRoles, roleExists, rolesHavePermission } from '../services/permissions';
import { canAccessRoom, getRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { newStoredRel, storedPath, typeAllowed, withFsRetry, writeStored } from '../services/uploads';
import { actorOf, type Ctx } from '../services/users';
import {
  assertNotNearBlocked,
  assertNotNearRestricted,
  canViewStickerFile,
  clearStickerAccessCache,
  fileFacts,
  forgetDeniedUser,
  isRestricted,
  lockLiveFile,
  markOrgFilesDirty,
  readStickerParts,
  restoreMissingBytes,
  restrictedError,
  StickerRetry,
  storeStickerFile,
  toFileInfo,
  validatePoster,
  validateStickerBytes,
  visibleOrgSql,
  type FileFacts,
  type StickerFileRow,
  type ValidSticker,
} from './files';
import { drainStickerTrash, queuePendingWrite } from './trash';
import { zipStore } from './zip';

// Figurinhas: papéis, catálogos, pacotes, favoritas, recentes e o aviso coalescido de mudanças.

// ---------- Papéis ----------

export interface StickerRoleFlags {
  manager: boolean;
  moderator: boolean;
  moderationViewer: boolean;
  consoleViewer: boolean; // view-moderation-console
}

function flagsOf(roles: string[]): StickerRoleFlags {
  const moderator = rolesHavePermission(roles, 'manage-moderation-actions');
  const consoleViewer = rolesHavePermission(roles, 'view-moderation-console');
  return { manager: rolesHavePermission(roles, 'manage-sticker-packs'), moderator, consoleViewer, moderationViewer: moderator || consoleViewer };
}

// Papéis globais (sem sala): "Visível para" e o bloqueio de envio usam só estes.
export async function userGlobalRoles(userId: string): Promise<string[]> {
  return getUserRoles(userId);
}

// Uma leitura dos papéis para os papéis e as quatro permissões.
export async function stickerRoleInfo(userId: string): Promise<{ roles: string[]; flags: StickerRoleFlags }> {
  const roles = await userGlobalRoles(userId);
  return { roles, flags: flagsOf(roles) };
}

export async function stickerRoleFlags(userId: string): Promise<StickerRoleFlags> {
  return (await stickerRoleInfo(userId)).flags;
}

export async function isSendBlocked(userId: string): Promise<boolean> {
  return rolesBlockedFromSending(await userGlobalRoles(userId), String(getSetting('Stickers_Send_Blocked_Roles') ?? ''));
}

// Nome, palavras-chave, nome e descrição de pacote: limpeza de §2.3 e depois o filtro de palavrões (quando ligado).
export function cleanText(v: unknown, max: number): string {
  return filterBadWords(cleanStickerName(v, max));
}

export function cleanKeywordList(v: unknown): string[] {
  return [...new Set(cleanKeywords(v).map((k) => cleanText(k, STICKER_LIMITS.keywordMax)).filter(Boolean))];
}

// Gestores preparam pacotes com a função desligada; o resto das pessoas não.
export function assertStickersOn(flags?: StickerRoleFlags) {
  if (!getSetting('Stickers_Enabled') && !flags?.manager) throw badRequest('error-stickers-disabled', 'As figurinhas estão desativadas.');
}

// ---------- Erros ----------

export const packNotFound = () => notFound('error-sticker-pack-not-found', 'Pacote não encontrado.');
export const stickerNotFound = () => notFound('error-sticker-not-found', 'Figurinha não encontrada.');
export const removedError = () => new ApiError(410, 'error-sticker-removed', 'Esta figurinha foi removida.');
export const blockedError = () => new ApiError(403, 'error-sticker-blocked', 'Esta imagem foi removida pela moderação e não pode virar figurinha.');
const duplicateError = () => badRequest('error-sticker-duplicate', 'Esta figurinha já está neste pacote.');
const packNameError = () => badRequest('error-sticker-pack-name', 'Dê um nome ao pacote.');
const coverError = () => badRequest('error-invalid-params', 'A capa precisa ser uma figurinha deste pacote.');
const isUniqueViolation = (e: any) => e?.code === '23505';

// ---------- Versões e avisos ----------

export async function bumpVersion(key: string, db: Queryable = pool): Promise<void> {
  await query(
    `INSERT INTO sticker_versions (key, version) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET version = sticker_versions.version + 1`,
    [key],
    db,
  );
  // De novo depois do commit, em notifyStickers: aqui é só para esta instância não servir o cache velho.
  if (key === 'org') {
    markOrgFilesDirty();
    clearStickerAccessCache();
  } else if (key.startsWith('user:')) forgetDeniedUser(key.slice(5));
}

// Várias chaves numa transação: sempre na mesma ordem, para duas remoções nunca se travarem.
export async function bumpVersions(keys: Iterable<string>, db: Queryable = pool): Promise<void> {
  for (const k of [...new Set(keys)].sort()) await bumpVersion(k, db);
}

const versionKey = (pack: { scope: string; owner_id: string | null }) => (pack.scope === 'org' ? 'org' : `user:${pack.owner_id}`);

interface Pending {
  due: number;
  timer: NodeJS.Timeout;
  fire: () => void;
}
const pending = new Map<string, Pending>();

// Coalesce os avisos: uma alteração em lote não vira uma enxurrada de recargas em todos os navegadores.
export function notifyStickers(scope: 'org' | 'mine', userId?: string, opts: { batch?: boolean } = {}): void {
  if (scope === 'org') {
    markOrgFilesDirty();
    clearStickerAccessCache();
  } else if (userId) forgetDeniedUser(userId);
  if (scope === 'mine' && !userId) return;
  const key = scope === 'org' ? 'org' : `mine:${userId}`;
  const windowMs = opts.batch ? 30_000 : scope === 'org' ? 5_000 : 1_000;
  const due = Date.now() + windowMs;
  const cur = pending.get(key);
  if (cur && cur.due <= due) return;
  if (cur) clearTimeout(cur.timer);
  const fire = () => {
    pending.delete(key);
    try {
      bus.publish(scope === 'org' ? { all: true } : { user: userId! }, { type: 'stickers.changed', scope });
    } catch {
      // o próximo envio ou a próxima abertura do seletor revalida pela versão
    }
  };
  const timer = setTimeout(fire, windowMs);
  timer.unref?.();
  pending.set(key, { due, timer, fire });
}

// Publica agora (uma chave, `org` ou `mine:<id>`, ou todas).
export function flushStickerNotifications(key?: string): void {
  for (const [k, p] of [...pending]) {
    if (key && k !== key) continue;
    clearTimeout(p.timer);
    p.fire();
  }
}

// ---------- Formato das respostas ----------

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : '');

// Colunas de figurinha + arquivo, como os catálogos e as respostas usam.
const ITEM_JSON = `json_build_object(
  'id', s.id, 'name', s.name, 'emojis', s.emojis, 'keywords', s.keywords, 'sort', s.sort, 'created_at', s.created_at,
  'file_id', f.id, 'mime', f.mime, 'width', f.width, 'height', f.height, 'size', f.size, 'animated', f.animated,
  'frames', f.frames, 'duration_ms', f.duration_ms, 'poster_mime', f.poster_mime)`;

function toItem(packId: string, s: any): StickerItem {
  return {
    ...toFileInfo(s.file_id, s),
    _id: s.id,
    packId,
    name: s.name,
    emojis: s.emojis ?? [],
    keywords: s.keywords ?? [],
    sort: s.sort,
    createdAt: iso(s.created_at),
  };
}

async function stickerItem(stickerId: string, db: Queryable = pool): Promise<StickerItem> {
  const r = await one(`SELECT s.pack_id, ${ITEM_JSON} AS item FROM stickers s JOIN sticker_files f ON f.id = s.file_id WHERE s.id = $1`, [stickerId], db);
  if (!r) throw stickerNotFound();
  return toItem(r.pack_id, r.item);
}

function toPack(r: any): StickerPack {
  const stickers: StickerItem[] = (r.stickers ?? []).map((s: any) => toItem(r.id, s));
  const cover = stickers.find((s) => s._id === r.cover_sticker_id) ?? stickers[0];
  const pack: StickerPack = {
    _id: r.id,
    scope: r.scope,
    name: r.name,
    description: r.description ?? '',
    status: r.status,
    visibleRoles: r.visible_roles ?? [],
    sort: r.sort,
    count: stickers.length,
    stickers,
    updatedAt: r.updated_at,
  };
  if (cover) pack.coverUrl = cover.posterUrl ?? cover.url;
  return pack;
}

// Uma consulta: os pacotes e, em cada um, as figurinhas em ordem.
async function loadPacks(where: string, params: unknown[], db: Queryable = pool): Promise<StickerPack[]> {
  const rows = await many(
    `SELECT p.*, st.list AS stickers
     FROM sticker_packs p
     CROSS JOIN LATERAL (
       SELECT coalesce(json_agg(${ITEM_JSON} ORDER BY s.sort, s.created_at), '[]'::json) AS list
       FROM stickers s JOIN sticker_files f ON f.id = s.file_id AND f.blocked_at IS NULL
       WHERE s.pack_id = p.id
     ) st
     WHERE ${where}
     ORDER BY p.sort, p.created_at`,
    params,
    db,
  );
  return rows.map(toPack);
}

async function packById(packId: string, db: Queryable = pool): Promise<StickerPack> {
  const [pack] = await loadPacks('p.id = $1', [packId], db);
  if (!pack) throw packNotFound();
  return pack;
}

// ---------- Catálogos ----------

async function versionsOf(userId: string): Promise<{ org: number; mine: number }> {
  const r = await one(
    `SELECT coalesce((SELECT version FROM sticker_versions WHERE key = 'org'), 0) AS org,
            coalesce((SELECT version FROM sticker_versions WHERE key = $1), 0) AS mine`,
    [`user:${userId}`],
  );
  return { org: Number(r?.org ?? 0), mine: Number(r?.mine ?? 0) };
}

// O que muda o catálogo sem mudar a versão do banco: papéis, ser gestor, limites e o pedido de rascunhos.
function catalogHash(roles: string[], manager: boolean, drafts: boolean) {
  const data = JSON.stringify([[...roles].sort(), manager, getSetting('Stickers_Personal_Max_Packs'), getSetting('Stickers_Personal_Quota_MB'), drafts]);
  return createHash('sha1').update(data).digest('hex').slice(0, 8);
}

export async function orgCatalog(ctx: Ctx, opts: { includeDrafts?: boolean; version?: string } = {}): Promise<StickerCatalogOrg | StickerCatalogUnchanged> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  const drafts = !!opts.includeDrafts && flags.manager;
  const v = await versionsOf(ctx.userId);
  const version = `o${v.org}-${catalogHash(roles, flags.manager, drafts)}`;
  if (opts.version === version) return { scope: 'org', version, unchanged: true };
  const packs = drafts
    ? await loadPacks(`p.scope = 'org'`, [])
    : await loadPacks(visibleOrgSql('p', '$1::text[]', '$2::boolean'), [roles, flags.manager]);
  return { scope: 'org', version, userId: ctx.userId, packs };
}

async function usedBytes(userId: string, fileId: string | null, db: Queryable = pool): Promise<{ used: number; has: boolean }> {
  const r = await one(
    `SELECT coalesce(sum(f.size + coalesce(f.poster_size, 0)), 0)::bigint AS used, coalesce(bool_or(f.id = $2), false) AS has
     FROM sticker_files f
     WHERE f.id IN (SELECT s.file_id FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE p.owner_id = $1)`,
    [userId, fileId ?? ''],
    db,
  );
  return { used: Number(r?.used ?? 0), has: !!r?.has };
}

export async function myCatalog(ctx: Ctx, opts: { version?: string } = {}): Promise<StickerCatalogMine | StickerCatalogUnchanged> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  const v = await versionsOf(ctx.userId);
  const version = `u${v.mine}-o${v.org}-${catalogHash(roles, flags.manager, false)}`;
  if (opts.version === version) return { scope: 'mine', version, unchanged: true };
  const packs = await loadPacks('p.owner_id = $1', [ctx.userId]);
  // Itens de arquivo removido ou restrito para a pessoa ficam de fora; o escopo vem do primeiro pacote visível.
  const items = await many(
    `SELECT i.kind, i.name, i.emojis, i.used_at, f.id AS file_id, f.mime, f.width, f.height, f.size, f.animated, f.frames,
            f.duration_ms, f.poster_mime, vo.sticker_id AS vo_sticker_id, vo.pack_id AS vo_pack_id, vo.pack_name AS vo_pack_name
     FROM sticker_user_items i
     JOIN sticker_files f ON f.id = i.file_id AND f.blocked_at IS NULL
     LEFT JOIN LATERAL (
       SELECT s.id AS sticker_id, p.id AS pack_id, p.name AS pack_name
       FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
       WHERE s.file_id = f.id AND ${visibleOrgSql('p', '$2::text[]', '$3::boolean')}
       ORDER BY p.sort, p.created_at, s.sort, s.created_at LIMIT 1
     ) vo ON true
     WHERE i.user_id = $1
       AND (vo.sticker_id IS NOT NULL OR $3::boolean
            OR NOT EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
                           WHERE s.file_id = f.id AND p.scope = 'org' AND (p.status = 'draft' OR p.visible_roles <> '{}'))
            OR EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = f.id AND p.owner_id = $1))
     ORDER BY i.used_at DESC`,
    [ctx.userId, roles, flags.manager],
  );
  const toUserItem = (r: any): StickerUserItem => {
    const item: StickerUserItem = { ...toFileInfo(r.file_id, r), kind: r.kind, name: r.name, emojis: r.emojis ?? [], scope: r.vo_sticker_id ? 'org' : 'personal', usedAt: r.used_at };
    if (r.vo_sticker_id) Object.assign(item, { stickerId: r.vo_sticker_id, packId: r.vo_pack_id, packName: r.vo_pack_name });
    return item;
  };
  const favorites = items.filter((r) => r.kind === 'favorite').map(toUserItem);
  const recents = items.filter((r) => r.kind === 'recent').slice(0, STICKER_LIMITS.recents).map(toUserItem);
  const { used } = await usedBytes(ctx.userId, null);
  const quota: StickerQuota = {
    packs: packs.length,
    maxPacks: getSetting<number>('Stickers_Personal_Max_Packs'),
    bytes: used,
    quotaBytes: getSetting<number>('Stickers_Personal_Quota_MB') * 1024 * 1024,
  };
  return { scope: 'mine', version, userId: ctx.userId, packs, favorites, recents, quota };
}

// ---------- Regras de criação e capacidade ----------

// Criar ou salvar figurinha pessoal (§3.1). O tipo do arquivo, quando já é conhecido.
function assertPersonalCreate(roles: string[], mime?: string) {
  if (!rolesHavePermission(roles, 'create-personal-stickers')) throw forbidden();
  if (!getSetting('Stickers_Personal_Enabled')) throw new ApiError(403, 'error-sticker-personal-disabled', 'As figurinhas pessoais estão desativadas.');
  if (!getSetting('FileUpload_Enabled')) throw forbidden('Upload de arquivos desativado.');
  if (mime && !typeAllowed(mime)) throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');
}

// Serializa as contas de pacotes, cota e favoritas de uma pessoa (sem conflitar com as chaves estrangeiras).
const lockUser = (db: Queryable, userId: string) => query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId], db);

async function assertCapacity(db: Queryable, pack: any, file: { id: string | null; bytes: number }, opts: { skipQuota?: boolean } = {}) {
  const personal = pack.scope === 'personal';
  const max = getSetting<number>(personal ? 'Stickers_Personal_Max_Per_Pack' : 'Stickers_Org_Max_Per_Pack');
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM stickers WHERE pack_id = $1', [pack.id], db);
  if ((r?.n ?? 0) >= max) throw badRequest('error-sticker-pack-full', `Este pacote chegou ao limite de ${max} figurinhas.`);
  if (!personal || opts.skipQuota) return;
  const quotaMB = getSetting<number>('Stickers_Personal_Quota_MB');
  const { used, has } = await usedBytes(pack.owner_id, file.id, db);
  if (used + (has ? 0 : file.bytes) > quotaMB * 1024 * 1024) throw badRequest('error-sticker-quota', `Suas figurinhas passariam do limite de ${quotaMB} MB.`);
}

// O pacote de destino de uma criação ou de um "salvar".
async function resolveTargetPack(ctx: Ctx, roles: string[], flags: StickerRoleFlags, packId: string | undefined) {
  if (!packId) {
    assertPersonalCreate(roles);
    return ensureDefaultPack(ctx);
  }
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [packId]);
  if (pack?.scope === 'personal' && pack.owner_id === ctx.userId) assertPersonalCreate(roles);
  else if (pack?.scope === 'org') {
    if (!flags.manager) throw forbidden();
  } else throw packNotFound();
  return pack;
}

// Primeiro pacote próprio; sem nenhum, cria "Minhas figurinhas".
export async function ensureDefaultPack(ctx: Ctx): Promise<any> {
  const first = (db: Queryable) => one('SELECT * FROM sticker_packs WHERE owner_id = $1 ORDER BY sort, created_at LIMIT 1', [ctx.userId], db);
  const found = await first(pool);
  if (found) return found;
  const out = await tx(async (c) => {
    await lockUser(c, ctx.userId);
    const again = await first(c);
    if (again) return { pack: again, created: false };
    const pack = await one(
      `INSERT INTO sticker_packs (id, scope, owner_id, name, sort, created_by) VALUES ($1, 'personal', $2, 'Minhas figurinhas', 0, $2) RETURNING *`,
      [newId(), ctx.userId],
      c,
    );
    await bumpVersion(`user:${ctx.userId}`, c);
    return { pack, created: true };
  });
  if (out.created) notifyStickers('mine', ctx.userId);
  return out.pack;
}

function listField(v: string | undefined, commaList: boolean): unknown {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return commaList ? t : [t];
    }
  }
  return t;
}

// ---------- stickers.create ----------

interface CreateTarget {
  pack: any;
  personal: boolean;
  phash: string | null;
  source: { id: string; userId: string | null } | null;
  batch: boolean;
}

async function resolveCreateTarget(ctx: Ctx, roles: string[], flags: StickerRoleFlags, fields: Record<string, string>): Promise<CreateTarget> {
  let phash: string | null = null;
  if (fields.phash) {
    if (!PHASH_RE.test(fields.phash)) throw badRequest('error-invalid-params', 'Hash da imagem inválido.');
    phash = fields.phash;
  }
  const pack = await resolveTargetPack(ctx, roles, flags, fields.packId || undefined);
  let source: CreateTarget['source'] = null;
  if (fields.sourceMessageId) {
    const m = await getMessageRow(fields.sourceMessageId);
    const room = m ? await getRoom(m.room_id) : null;
    if (!m || !room || !(await canAccessRoom(ctx.userId, room))) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
    if (m.extra?.sticker) throw badRequest('error-sticker-source', 'Esta imagem já é uma figurinha. Use “Salvar nas minhas figurinhas”.');
    if (!canCreateFromMessage(withExtra(m))) throw badRequest('error-sticker-source', 'Esta mensagem não tem uma imagem que possa virar figurinha.');
    source = { id: m.id, userId: m.user_id ?? null };
  }
  return { pack, personal: pack.scope === 'personal', phash, source, batch: fields.batch === '1' };
}

export async function createSticker(ctx: Ctx, req: FastifyRequest): Promise<{ sticker: StickerItem }> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  const box: { target?: CreateTarget } = {};
  const parts = await readStickerParts(req, async (fields) => {
    box.target = await resolveCreateTarget(ctx, roles, flags, fields);
  });
  const t = box.target;
  if (!t || !parts.file) throw badRequest('error-invalid-params', 'Informe a figurinha.');
  const v = validateStickerBytes(parts.file, { personal: t.personal, phash: t.phash });
  let poster: { bytes: Uint8Array; mime: 'image/webp' | 'image/png' } | null = null;
  if (v.probe.animated) {
    if (!parts.poster) throw badRequest('error-sticker-poster-required', 'Falta a imagem parada da figurinha animada.');
    poster = validatePoster(parts.poster, v.probe.width, v.probe.height);
  }
  const fields = parts.fields;
  const name = cleanText(fields.name, STICKER_LIMITS.nameMax) || DEFAULT_STICKER_NAME;
  const emojis = cleanEmojis(listField(fields.emojis, false));
  const keywords = cleanKeywordList(listField(fields.keywords, true));

  // O bloqueio exato vem antes do "parecido": quem reenvia o mesmo arquivo recebe o motivo certo.
  const existing = await one('SELECT id, blocked_at, size, poster_size FROM sticker_files WHERE sha256 = $1', [v.sha256]);
  if (existing?.blocked_at) throw blockedError();
  await assertNotNearBlocked(flags, v);
  await assertNotNearRestricted(ctx.userId, flags, v);
  await assertCapacity(pool, t.pack, {
    id: existing?.id ?? null,
    bytes: existing ? existing.size + (existing.poster_size ?? 0) : v.bytes.length + (poster?.bytes.length ?? 0),
  });

  for (let attempt = 0; ; attempt++) {
    const row = attempt === 0 ? existing : await one('SELECT id, blocked_at FROM sticker_files WHERE sha256 = $1', [v.sha256]);
    if (row?.blocked_at) throw blockedError();
    // Gravar é lento: fica fora da transação, com a lixeira já avisada.
    const written = row ? null : await writeStickerBytes(v, poster);
    let sticker: StickerItem;
    try {
      sticker = await tx(async (c) => {
        const file = await storeStickerFile(c, ctx, v, written);
        if (!written) await restoreMissingBytes(c, ctx, file, v, poster, flags.manager);
        const pack = await one('SELECT * FROM sticker_packs WHERE id = $1 FOR UPDATE', [t.pack.id], c);
        if (!pack) throw packNotFound();
        if (pack.scope === 'personal') await lockUser(c, ctx.userId);
        await assertCapacity(c, pack, { id: file.id, bytes: file.size + (file.poster_size ?? 0) });
        const s = await one(
          `INSERT INTO stickers (id, pack_id, file_id, name, emojis, keywords, sort, created_by, source_message_id, source_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort), -1) + 1 FROM stickers WHERE pack_id = $2), $7, $8, $9) RETURNING id`,
          [newId(), pack.id, file.id, name, emojis, keywords, ctx.userId, t.source?.id ?? null, t.source?.userId ?? null],
          c,
        );
        await bumpVersion(versionKey(pack), c);
        return stickerItem(s!.id, c);
      });
    } catch (e) {
      // Sem commit, os bytes gravados agora não servem a ninguém. Com um commit cuja resposta se perdeu, a lixeira
      // vê a linha usando o caminho e não apaga; se ela própria falhar, a limpeza diária termina depois do prazo.
      if (written) await drainStickerTrash({ only: [written.path, written.posterPath] }).catch(() => {});
      if (e instanceof StickerRetry && attempt === 0) continue;
      if (isUniqueViolation(e)) throw duplicateError();
      throw e;
    }
    // Depois do commit tudo é de melhor esforço: a figurinha já existe e o que ficou na lixeira sai à noite.
    if (written) await drainStickerTrash({ only: [written.path, written.posterPath] }).catch(() => {});
    notifyStickers(t.personal ? 'mine' : 'org', ctx.userId, { batch: t.batch });
    if (!t.personal) {
      await audit(actorOf(ctx), 'sticker.created', { packId: t.pack.id, stickerId: sticker._id }, { name, fileId: sticker.fileId, sourceMessageId: t.source?.id ?? null });
    }
    return { sticker };
  }
}

interface Written {
  path: string;
  posterPath: string | null;
  posterMime: string | null;
  posterSize: number | null;
}

// A linha da lixeira entra antes dos bytes: um corte entre a gravação e o commit não deixa arquivo sem dono.
async function writeStickerBytes(v: ValidSticker, poster: { bytes: Uint8Array; mime: string } | null): Promise<Written> {
  const id = newId();
  const path = newStoredRel(id);
  const posterPath = poster ? newStoredRel(`${id}.poster`) : null;
  await queuePendingWrite([path, posterPath]);
  try {
    await writeStored(path, v.bytes);
    if (poster && posterPath) await writeStored(posterPath, poster.bytes);
  } catch (e) {
    await drainStickerTrash({ only: [path, posterPath] }).catch(() => {});
    throw e;
  }
  return { path, posterPath, posterMime: poster?.mime ?? null, posterSize: poster?.bytes.length ?? null };
}

// ---------- Alvo de favoritar e salvar ----------

export interface StickerTarget {
  messageId?: string;
  stickerId?: string;
  fileId?: string;
}

interface ResolvedTarget {
  fileId: string;
  snapshot: MessageSticker | null;
  orgStickerId: string | null;
}

async function resolveTarget(ctx: Ctx, roles: string[], flags: StickerRoleFlags, t: StickerTarget, opts: { removal?: boolean } = {}): Promise<ResolvedTarget> {
  const given = [t.messageId, t.stickerId, t.fileId].filter(Boolean).length;
  if (given !== 1) throw badRequest('error-invalid-params', 'Informe a figurinha.');
  if (t.messageId) {
    const m = await getMessageRow(t.messageId);
    const room = m ? await getRoom(m.room_id) : null;
    if (!m || !room || !(await canAccessRoom(ctx.userId, room))) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
    const s = m.extra?.sticker as MessageSticker | undefined;
    if (!s) throw stickerNotFound();
    if (s.removed || !m.sticker_file_id) {
      if (opts.removal && s.fileId) return { fileId: s.fileId, snapshot: null, orgStickerId: null };
      throw removedError();
    }
    return { fileId: m.sticker_file_id, snapshot: s, orgStickerId: s.scope === 'org' ? (s.stickerId ?? null) : null };
  }
  if (t.stickerId) {
    const r = await one(
      `SELECT s.id, s.file_id, p.scope FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
       WHERE s.id = $1 AND (p.owner_id = $2 OR ${visibleOrgSql('p', '$3::text[]', '$4::boolean')})`,
      [t.stickerId, ctx.userId, roles, flags.manager],
    );
    if (!r) throw stickerNotFound();
    return { fileId: r.file_id, snapshot: null, orgStickerId: r.scope === 'org' ? r.id : null };
  }
  const fileId = String(t.fileId);
  if (!/^[A-Za-z0-9]{10,24}$/.test(fileId)) throw stickerNotFound();
  if (!opts.removal && !(await canViewStickerFile(ctx.userId, fileId))) throw stickerNotFound();
  return { fileId, snapshot: null, orgStickerId: null };
}

// Nome e emojis padrão (§3.8). Nunca da figurinha pessoal de outra pessoa: o nome dela é privado.
async function defaultsFor(userId: string, fileId: string, target: ResolvedTarget, facts: FileFacts, db: Queryable): Promise<{ name: string; emojis: string[] }> {
  const own = await one(
    `SELECT s.name, s.emojis FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
     WHERE s.file_id = $1 AND p.owner_id = $2 ORDER BY p.sort, p.created_at, s.sort, s.created_at LIMIT 1`,
    [fileId, userId],
    db,
  );
  if (own) return { name: own.name, emojis: own.emojis ?? [] };
  if (facts.visibleOrg) return { name: facts.visibleOrg.name, emojis: facts.visibleOrg.emojis };
  let snap = target.snapshot;
  if (!snap) {
    const m = await one(
      `SELECT m.extra->'sticker' AS s FROM messages m
       JOIN subscriptions su ON su.room_id = m.room_id AND su.user_id = $2
       WHERE m.sticker_file_id = $1 AND m.extra->'sticker'->>'removed' IS DISTINCT FROM 'true'
       ORDER BY m.created_at DESC LIMIT 1`,
      [fileId, userId],
      db,
    );
    snap = m?.s ?? null;
  }
  if (snap && !snap.removed) return { name: snap.name || DEFAULT_STICKER_NAME, emojis: snap.emojis ?? [] };
  return { name: DEFAULT_STICKER_NAME, emojis: [] };
}

// sticker_id do item: a figurinha da organização de onde veio, se ainda existe com este arquivo.
async function orgStickerFor(target: ResolvedTarget, facts: FileFacts, db: Queryable): Promise<string | null> {
  if (target.orgStickerId && (await one('SELECT 1 FROM stickers WHERE id = $1 AND file_id = $2', [target.orgStickerId, target.fileId], db))) {
    return target.orgStickerId;
  }
  return facts.visibleOrg?.stickerId ?? null;
}

// ---------- Favoritas ----------

export async function setFavorite(ctx: Ctx, target: StickerTarget, favorite: boolean): Promise<{ favorite: boolean; fileId: string }> {
  if (!getSetting('Stickers_Enabled')) throw badRequest('error-stickers-disabled', 'As figurinhas estão desativadas.');
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  const tg = await resolveTarget(ctx, roles, flags, target, { removal: !favorite });
  if (!favorite) {
    await tx(async (c) => {
      await query(`DELETE FROM sticker_user_items WHERE user_id = $1 AND kind = 'favorite' AND file_id = $2`, [ctx.userId, tg.fileId], c);
      await bumpVersion(`user:${ctx.userId}`, c);
    });
    notifyStickers('mine', ctx.userId);
    return { favorite: false, fileId: tg.fileId };
  }
  await tx(async (c) => {
    const file = await lockLiveFile(c, tg.fileId);
    if (!file) throw removedError();
    const facts = await fileFacts(ctx.userId, file.id, c);
    if (isRestricted(facts)) throw restrictedError();
    await lockUser(c, ctx.userId);
    const max = getSetting<number>('Stickers_Max_Favorites');
    const r = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM sticker_user_items WHERE user_id = $1 AND kind = 'favorite' AND file_id <> $2`,
      [ctx.userId, file.id],
      c,
    );
    if ((r?.n ?? 0) >= max) throw badRequest('error-sticker-favorites-full', `Você já tem ${max} favoritas. Remova alguma para adicionar outra.`);
    const d = await defaultsFor(ctx.userId, file.id, tg, facts, c);
    await query(
      `INSERT INTO sticker_user_items (user_id, kind, file_id, sticker_id, name, emojis, used_at) VALUES ($1, 'favorite', $2, $3, $4, $5, now())
       ON CONFLICT (user_id, kind, file_id) DO UPDATE SET used_at = now()`,
      [ctx.userId, file.id, await orgStickerFor(tg, facts, c), d.name, d.emojis],
      c,
    );
    await bumpVersion(`user:${ctx.userId}`, c);
  });
  notifyStickers('mine', ctx.userId);
  return { favorite: true, fileId: tg.fileId };
}

// ---------- Recentes ----------

// Cada envio sobe a figurinha para o topo. Muda a versão, mas não avisa: uma rajada não faz todo aparelho recarregar.
export async function recordRecent(userId: string, file: { id: string }, snapshot: MessageSticker): Promise<void> {
  if (snapshot.removed) return;
  await tx(async (c) => {
    if (!(await lockLiveFile(c, file.id))) return;
    const stickerId = snapshot.scope === 'org' && snapshot.stickerId && (await one('SELECT 1 FROM stickers WHERE id = $1', [snapshot.stickerId], c)) ? snapshot.stickerId : null;
    await query(
      `INSERT INTO sticker_user_items (user_id, kind, file_id, sticker_id, name, emojis, used_at) VALUES ($1, 'recent', $2, $3, $4, $5, clock_timestamp())
       ON CONFLICT (user_id, kind, file_id) DO UPDATE SET used_at = clock_timestamp(), sticker_id = EXCLUDED.sticker_id, name = EXCLUDED.name, emojis = EXCLUDED.emojis`,
      [userId, file.id, stickerId, snapshot.name || DEFAULT_STICKER_NAME, snapshot.emojis ?? []],
      c,
    );
    await query(
      `DELETE FROM sticker_user_items WHERE user_id = $1 AND kind = 'recent' AND file_id NOT IN (
         SELECT file_id FROM sticker_user_items WHERE user_id = $1 AND kind = 'recent' ORDER BY used_at DESC LIMIT ${STICKER_LIMITS.recents})`,
      [userId],
      c,
    );
    await bumpVersion(`user:${userId}`, c);
  });
}

export async function removeRecent(ctx: Ctx, fileId: string): Promise<void> {
  assertStickersOn(await stickerRoleFlags(ctx.userId));
  await tx(async (c) => {
    await query(`DELETE FROM sticker_user_items WHERE user_id = $1 AND kind = 'recent' AND file_id = $2`, [ctx.userId, fileId], c);
    await bumpVersion(`user:${ctx.userId}`, c);
  });
  notifyStickers('mine', ctx.userId);
}

export async function clearRecents(ctx: Ctx): Promise<void> {
  assertStickersOn(await stickerRoleFlags(ctx.userId));
  await tx(async (c) => {
    await query(`DELETE FROM sticker_user_items WHERE user_id = $1 AND kind = 'recent'`, [ctx.userId], c);
    await bumpVersion(`user:${ctx.userId}`, c);
  });
  notifyStickers('mine', ctx.userId);
}

// ---------- Salvar ----------

export async function saveSticker(
  ctx: Ctx,
  target: StickerTarget,
  opts: { packId?: string; name?: unknown; emojis?: unknown; keywords?: unknown } = {},
): Promise<{ sticker: StickerItem }> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  const tg = await resolveTarget(ctx, roles, flags, target);
  const pack0 = await resolveTargetPack(ctx, roles, flags, opts.packId || undefined);
  const personal = pack0.scope === 'personal';
  const sticker = await (async () => {
    try {
      return await tx(async (c) => {
        const file = await lockLiveFile(c, tg.fileId);
        if (!file) throw removedError();
        if (personal) assertPersonalCreate(roles, file.mime);
        const facts = await fileFacts(ctx.userId, file.id, c);
        if (isRestricted(facts)) throw restrictedError();
        const pack = await one('SELECT * FROM sticker_packs WHERE id = $1 FOR UPDATE', [pack0.id], c);
        if (!pack) throw packNotFound();
        if (personal) await lockUser(c, ctx.userId);
        await assertCapacity(c, pack, { id: file.id, bytes: file.size + (file.poster_size ?? 0) });
        const d = await defaultsFor(ctx.userId, file.id, tg, facts, c);
        const name = (opts.name !== undefined && cleanText(opts.name, STICKER_LIMITS.nameMax)) || d.name;
        const emojis = opts.emojis !== undefined ? cleanEmojis(opts.emojis) : d.emojis;
        const keywords = opts.keywords !== undefined ? cleanKeywordList(opts.keywords) : [];
        const s = await one(
          `INSERT INTO stickers (id, pack_id, file_id, name, emojis, keywords, sort, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort), -1) + 1 FROM stickers WHERE pack_id = $2), $7) RETURNING id`,
          [newId(), pack.id, file.id, name, emojis, keywords, ctx.userId],
          c,
        );
        await bumpVersion(versionKey(pack), c);
        return stickerItem(s!.id, c);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateError();
      throw e;
    }
  })();
  notifyStickers(personal ? 'mine' : 'org', ctx.userId);
  if (!personal) await audit(actorOf(ctx), 'sticker.created', { packId: pack0.id, stickerId: sticker._id }, { name: sticker.name, fileId: sticker.fileId, sourceMessageId: null });
  return { sticker };
}

// ---------- Pacotes ----------

function cleanRoles(v: unknown): string[] {
  const list = [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))];
  if (list.length > STICKER_LIMITS.visibleRolesMax) throw badRequest('error-invalid-params', `Escolha no máximo ${STICKER_LIMITS.visibleRolesMax} papéis.`);
  for (const id of list) if (!roleExists(id, 'Users')) throw badRequest('error-invalid-role', `Papel inexistente: ${id}.`);
  return list;
}

function cleanStatus(v: unknown): 'draft' | 'published' {
  if (v === 'draft' || v === 'published') return v;
  throw badRequest('error-invalid-params', 'O parâmetro "status" deve ser "draft" ou "published".');
}

// Dono do pacote: a pessoa, no pessoal; um gestor, no da organização. Pacote pessoal de outra pessoa não existe.
function assertPackOwner(pack: any, ctx: Ctx, flags: StickerRoleFlags) {
  if (!pack) throw packNotFound();
  if (pack.scope === 'personal') {
    if (pack.owner_id !== ctx.userId) throw packNotFound();
  } else if (!flags.manager) throw forbidden();
}

async function afterChange(ctx: Ctx, pack: { scope: string }, action: string, target: Record<string, unknown>, data: Record<string, unknown>) {
  if (pack.scope === 'org') {
    notifyStickers('org');
    await audit(actorOf(ctx), action, target, data);
  } else notifyStickers('mine', ctx.userId);
}

export async function createPack(
  ctx: Ctx,
  input: { scope: unknown; name: unknown; description?: unknown; status?: unknown; visibleRoles?: unknown },
): Promise<{ pack: StickerPack }> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  if (input.scope !== 'org' && input.scope !== 'personal') throw badRequest('error-invalid-params', 'O parâmetro "scope" deve ser "org" ou "personal".');
  const scope: StickerScope = input.scope;
  const name = cleanText(input.name, STICKER_LIMITS.packNameMax);
  if (!name) throw packNameError();
  const description = cleanText(input.description ?? '', STICKER_LIMITS.packDescriptionMax);
  let status: 'draft' | 'published' = 'published';
  let visibleRoles: string[] = [];
  if (scope === 'org') {
    if (!flags.manager) throw forbidden();
    status = input.status === undefined || input.status === null || input.status === '' ? 'draft' : cleanStatus(input.status);
    visibleRoles = cleanRoles(input.visibleRoles);
  } else assertPersonalCreate(roles);
  const id = await tx(async (c) => {
    if (scope === 'personal') {
      await lockUser(c, ctx.userId);
      const max = getSetting<number>('Stickers_Personal_Max_Packs');
      const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM sticker_packs WHERE owner_id = $1', [ctx.userId], c);
      if ((r?.n ?? 0) >= max) throw badRequest('error-sticker-packs-full', `Você chegou ao limite de ${max} pacotes.`);
    } else {
      // A linha da versão 'org' serializa as criações: duas ao mesmo tempo não passam juntas do limite.
      await query(`INSERT INTO sticker_versions (key, version) VALUES ('org', 0) ON CONFLICT (key) DO UPDATE SET version = sticker_versions.version`, [], c);
      const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM sticker_packs WHERE scope = 'org'`, [], c);
      if ((r?.n ?? 0) >= STICKER_LIMITS.orgPacksMax) throw badRequest('error-sticker-packs-full', `A organização chegou ao limite de ${STICKER_LIMITS.orgPacksMax} pacotes.`);
    }
    const row = await one(
      `INSERT INTO sticker_packs (id, scope, owner_id, name, description, status, visible_roles, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               (SELECT coalesce(max(sort), -1) + 1 FROM sticker_packs WHERE ${scope === 'org' ? `scope = 'org'` : 'owner_id = $3'}), $8)
       RETURNING id`,
      [newId(), scope, scope === 'org' ? null : ctx.userId, name, description, status, visibleRoles, ctx.userId],
      c,
    );
    await bumpVersion(scope === 'org' ? 'org' : `user:${ctx.userId}`, c);
    return row!.id as string;
  });
  await afterChange(ctx, { scope }, 'sticker_pack.created', { packId: id }, { name, status, visibleRoles });
  return { pack: await packById(id) };
}

export async function updatePack(
  ctx: Ctx,
  input: { packId: string; name?: unknown; description?: unknown; status?: unknown; visibleRoles?: unknown; coverStickerId?: unknown },
): Promise<{ pack: StickerPack }> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [input.packId]);
  assertPackOwner(pack, ctx, flags);
  const changed: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, STICKER_LIMITS.packNameMax);
    if (!name) throw packNameError();
    if (name !== pack.name) changed.name = name;
  }
  if (input.description !== undefined) {
    const description = cleanText(input.description ?? '', STICKER_LIMITS.packDescriptionMax);
    if (description !== pack.description) changed.description = description;
  }
  if (pack.scope === 'org') {
    if (input.status !== undefined) {
      const status = cleanStatus(input.status);
      if (status !== pack.status) changed.status = status;
    }
    if (input.visibleRoles !== undefined) {
      const roles = cleanRoles(input.visibleRoles);
      if (JSON.stringify([...roles].sort()) !== JSON.stringify([...(pack.visible_roles ?? [])].sort())) changed.visible_roles = roles;
    }
  }
  if (input.coverStickerId !== undefined) {
    const cover = input.coverStickerId ? String(input.coverStickerId) : null;
    if (cover && !(await one('SELECT 1 FROM stickers WHERE id = $1 AND pack_id = $2', [cover, pack.id]))) throw coverError();
    if (cover !== pack.cover_sticker_id) changed.cover_sticker_id = cover;
  }
  const keys = Object.keys(changed);
  if (keys.length) {
    try {
      await tx(async (c) => {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        // A capa precisa continuar sendo deste pacote (uma remoção ou mudança no meio do caminho a teria tirado).
        const row = await one(`UPDATE sticker_packs SET ${sets}, updated_at = now() WHERE id = $1 RETURNING cover_sticker_id`, [pack.id, ...keys.map((k) => changed[k])], c);
        if (!row) throw packNotFound();
        if (row.cover_sticker_id && !(await one('SELECT 1 FROM stickers WHERE id = $1 AND pack_id = $2', [row.cover_sticker_id, pack.id], c))) throw coverError();
        await bumpVersion(versionKey(pack), c);
      });
    } catch (e: any) {
      // A figurinha escolhida foi apagada (remoção de todas as conversas) enquanto a chave estrangeira a esperava.
      if (e?.code === '23503' && e?.constraint === 'sticker_packs_cover_fk') throw coverError();
      throw e;
    }
    const data: Record<string, unknown> = {};
    for (const k of keys) data[k === 'visible_roles' ? 'visibleRoles' : k === 'cover_sticker_id' ? 'coverStickerId' : k] = changed[k];
    await afterChange(ctx, pack, 'sticker_pack.updated', { packId: pack.id }, data);
  }
  return { pack: await packById(pack.id) };
}

export async function deletePack(ctx: Ctx, packId: string): Promise<void> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [packId]);
  assertPackOwner(pack, ctx, flags);
  await tx(async (c) => {
    // As figurinhas saem em cascata; favoritas, recentes e mensagens ficam (a limpeza diária cuida dos arquivos).
    await query('DELETE FROM sticker_packs WHERE id = $1', [pack.id], c);
    await bumpVersion(versionKey(pack), c);
  });
  await afterChange(ctx, pack, 'sticker_pack.deleted', { packId: pack.id }, { name: pack.name });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

export async function reorderPacks(ctx: Ctx, scope: unknown, packIds: string[]): Promise<void> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  if (scope !== 'org' && scope !== 'personal') throw badRequest('error-invalid-params', 'O parâmetro "scope" deve ser "org" ou "personal".');
  if (scope === 'org' && !flags.manager) throw forbidden();
  await tx(async (c) => {
    const key = scope === 'org' ? 'org' : `user:${ctx.userId}`;
    const rows = await many(scope === 'org' ? `SELECT id FROM sticker_packs WHERE scope = 'org'` : 'SELECT id FROM sticker_packs WHERE owner_id = $1', scope === 'org' ? [] : [ctx.userId], c);
    if (!sameSet(packIds, rows.map((r) => r.id))) throw badRequest('error-invalid-params', 'A lista de pacotes não confere.');
    await query('UPDATE sticker_packs p SET sort = x.i - 1 FROM unnest($1::text[]) WITH ORDINALITY x(id, i) WHERE p.id = x.id', [packIds], c);
    await bumpVersion(key, c);
  });
  await afterChange(ctx, { scope }, 'sticker_pack.updated', { scope }, { order: packIds });
}

export async function packInfo(ctx: Ctx, packId: string): Promise<{ pack: StickerPack }> {
  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  assertStickersOn(flags);
  const [pack] = await loadPacks(`p.id = $1 AND (p.owner_id = $2 OR (p.scope = 'org' AND ($4::boolean OR ${visibleOrgSql('p', '$3::text[]', 'false')})))`, [
    packId,
    ctx.userId,
    roles,
    flags.manager,
  ]);
  if (!pack) throw packNotFound();
  return { pack };
}

// ---------- Figurinhas de um pacote ----------

async function ownedSticker(ctx: Ctx, flags: StickerRoleFlags, stickerId: string) {
  const s = await one('SELECT * FROM stickers WHERE id = $1', [stickerId]);
  if (!s) throw stickerNotFound();
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [s.pack_id]);
  try {
    assertPackOwner(pack, ctx, flags);
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 404) throw stickerNotFound();
    throw e;
  }
  return { s, pack };
}

export async function updateSticker(ctx: Ctx, input: { stickerId: string; name?: unknown; emojis?: unknown; keywords?: unknown }): Promise<{ sticker: StickerItem }> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const { s, pack } = await ownedSticker(ctx, flags, input.stickerId);
  const changed: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, STICKER_LIMITS.nameMax) || DEFAULT_STICKER_NAME;
    if (name !== s.name) changed.name = name;
  }
  if (input.emojis !== undefined) {
    const emojis = cleanEmojis(input.emojis);
    if (JSON.stringify(emojis) !== JSON.stringify(s.emojis)) changed.emojis = emojis;
  }
  if (input.keywords !== undefined) {
    const keywords = cleanKeywordList(input.keywords);
    if (JSON.stringify(keywords) !== JSON.stringify(s.keywords)) changed.keywords = keywords;
  }
  const keys = Object.keys(changed);
  if (keys.length) {
    await tx(async (c) => {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      if (!(await one(`UPDATE stickers SET ${sets}, updated_at = now() WHERE id = $1 RETURNING id`, [s.id, ...keys.map((k) => changed[k])], c))) throw stickerNotFound();
      await bumpVersion(versionKey(pack), c);
    });
    await afterChange(ctx, pack, 'sticker.updated', { packId: pack.id, stickerId: s.id }, changed);
  }
  return { sticker: await stickerItem(s.id) };
}

export async function deleteSticker(ctx: Ctx, stickerId: string): Promise<void> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const { s, pack } = await ownedSticker(ctx, flags, stickerId);
  await tx(async (c) => {
    // Pacote antes da figurinha, a ordem de remover de todas as conversas. A capa apagada vira NULL pela chave
    // estrangeira, que sem esta trava pegaria o pacote só depois da figurinha (deadlock com a remoção).
    await query('SELECT 1 FROM sticker_packs WHERE id = $1 FOR UPDATE', [s.pack_id], c);
    if (!(await one('DELETE FROM stickers WHERE id = $1 AND pack_id = $2 RETURNING id', [s.id, s.pack_id], c))) throw stickerNotFound();
    await bumpVersion(versionKey(pack), c);
  });
  await afterChange(ctx, pack, 'sticker.deleted', { packId: pack.id, stickerId: s.id }, { name: s.name, fileId: s.file_id });
}

export async function reorderStickers(ctx: Ctx, packId: string, stickerIds: string[]): Promise<void> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [packId]);
  assertPackOwner(pack, ctx, flags);
  await tx(async (c) => {
    await query('SELECT 1 FROM sticker_packs WHERE id = $1 FOR UPDATE', [pack.id], c);
    const rows = await many('SELECT id FROM stickers WHERE pack_id = $1', [pack.id], c);
    if (!sameSet(stickerIds, rows.map((r) => r.id))) throw badRequest('error-invalid-params', 'A lista de figurinhas não confere.');
    await query('UPDATE stickers s SET sort = x.i - 1 FROM unnest($1::text[]) WITH ORDINALITY x(id, i) WHERE s.id = x.id', [stickerIds], c);
    await bumpVersion(versionKey(pack), c);
  });
  await afterChange(ctx, pack, 'sticker_pack.updated', { packId: pack.id }, { order: stickerIds });
}

export async function moveSticker(ctx: Ctx, stickerId: string, packId: string): Promise<{ sticker: StickerItem }> {
  const flags = await stickerRoleFlags(ctx.userId);
  assertStickersOn(flags);
  const { s, pack: from } = await ownedSticker(ctx, flags, stickerId);
  const to = await one('SELECT * FROM sticker_packs WHERE id = $1', [packId]);
  assertPackOwner(to, ctx, flags);
  if (to.id === from.id) return { sticker: await stickerItem(s.id) };
  if (to.scope !== from.scope || to.owner_id !== from.owner_id) throw badRequest('error-invalid-params', 'A figurinha só pode ir para outro pacote do mesmo dono.');
  try {
    await tx(async (c) => {
      for (const id of [from.id, to.id].sort()) await query('SELECT 1 FROM sticker_packs WHERE id = $1 FOR UPDATE', [id], c);
      // Mesmo dono: a cota não muda, só a capacidade do pacote de destino.
      await assertCapacity(c, to, { id: s.file_id, bytes: 0 }, { skipQuota: true });
      const moved = await one(
        `UPDATE stickers SET pack_id = $2, sort = (SELECT coalesce(max(sort), -1) + 1 FROM stickers WHERE pack_id = $2), updated_at = now()
         WHERE id = $1 AND pack_id = $3 RETURNING id`,
        [s.id, to.id, from.id],
        c,
      );
      if (!moved) throw stickerNotFound();
      await query('UPDATE sticker_packs SET cover_sticker_id = NULL WHERE id = $1 AND cover_sticker_id = $2', [from.id, s.id], c);
      await bumpVersion(versionKey(to), c);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicateError();
    throw e;
  }
  await afterChange(ctx, to, 'sticker.moved', { stickerId: s.id }, { from: from.id, to: to.id });
  return { sticker: await stickerItem(s.id) };
}

// ---------- Exportação ----------

const slugOf = (s: string, fallback: string) =>
  normalizeSearch(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || fallback;

// Pacote em ZIP: pack.json primeiro, depois cada figurinha (e o pôster das animadas), lidas uma por vez.
export async function exportPack(ctx: Ctx, packId: string): Promise<{ fileName: string; packName: string; stream: Readable }> {
  const flags = await stickerRoleFlags(ctx.userId);
  const pack = await one('SELECT * FROM sticker_packs WHERE id = $1', [packId]);
  if (!pack || (pack.scope === 'personal' ? pack.owner_id !== ctx.userId : !flags.manager)) throw packNotFound();
  const all = await many<{ name: string; emojis: string[]; keywords: string[] } & StickerFileRow>(
    `SELECT s.name, s.emojis, s.keywords, f.mime, f.animated, f.path, f.poster_path, f.poster_mime
     FROM stickers s JOIN sticker_files f ON f.id = s.file_id AND f.blocked_at IS NULL
     WHERE s.pack_id = $1 ORDER BY s.sort, s.created_at`,
    [pack.id],
  );
  // Arquivo que sumiu do disco fica de fora antes das 200: um ZIP sem ele vale mais que um download cortado.
  const onDisk = (rel: string | null) => (rel ? fs.promises.access(storedPath(rel)).then(() => true, () => false) : Promise.resolve(false));
  const found = await Promise.all(all.map(async (r) => ({ r, file: await onDisk(r.path), poster: r.animated && (await onDisk(r.poster_path)) })));
  const entries = found
    .filter((x) => x.file)
    .map(({ r, poster: hasPoster }, i) => {
      const base = `${String(i + 1).padStart(3, '0')}-${slugOf(r.name, 'figurinha')}`;
      const poster = hasPoster && r.poster_mime ? `${base}.poster.${stickerExt(r.poster_mime)}` : null;
      return { row: r, file: `${base}.${stickerExt(r.mime)}`, poster };
    });
  const manifest = {
    format: 'wescc-stickers',
    version: 1,
    name: pack.name,
    description: pack.description ?? '',
    exportedAt: new Date().toISOString(),
    stickers: entries.map((e) => ({ file: e.file, poster: e.poster, name: e.row.name, emojis: e.row.emojis ?? [], keywords: e.row.keywords ?? [], animated: e.row.animated })),
  };
  // Depois das 200 não há como avisar: um arquivo que some no meio (uma remoção em paralelo) só fica de fora.
  const read = (rel: string) => withFsRetry(() => fs.promises.readFile(storedPath(rel))).catch(() => null);
  async function* files() {
    yield { name: 'pack.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') };
    for (const e of entries) {
      const data = await read(e.row.path!);
      if (!data) continue;
      yield { name: e.file, data };
      const poster = e.poster ? await read(e.row.poster_path!) : null;
      if (e.poster && poster) yield { name: e.poster, data: poster };
    }
  }
  return { fileName: `figurinhas-${slugOf(pack.name, 'pacote')}.zip`, packName: pack.name, stream: zipStore(files()) };
}
