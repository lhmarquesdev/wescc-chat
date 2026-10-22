import { DEFAULT_STICKER_NAME, type BlockedStickerFile, type StickerMime, type StickerUsage } from '@shared/stickers';
import { many, one, query, tx, type Queryable } from '../db/pool';
import { newId } from '../lib/ids';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { bus } from '../realtime/bus';
import { getMessageRow } from '../services/messages';
import { canAccessRoom, getRoom, notifyRoomUpdated } from '../services/rooms';
import { getSetting } from '../services/settings';
import { actorOf, type Ctx } from '../services/users';
import { clearStickerAccessCache, destroyStickerStreams, FILE_COLUMNS, type StickerFileRow } from './files';
import { bumpVersions, notifyStickers, stickerNotFound, stickerRoleInfo, type StickerRoleFlags } from './service';
import { drainStickerTrash, queueTrash } from './trash';

// Moderação: remover de todas as conversas, permitir de novo, listar removidas, uso e a limpeza diária.

const ID_RE = /^[A-Za-z0-9]{10,24}$/;

// Por messageId: a sala precisa estar ao alcance de quem pergunta, salvo para quem tem o console de moderação.
async function fileIdFromInput(ctx: Ctx, flags: StickerRoleFlags, input: { fileId?: string; messageId?: string }): Promise<string> {
  if (input.messageId) {
    const m = await getMessageRow(String(input.messageId));
    if (!m) throw stickerNotFound();
    if (!flags.consoleViewer && !(await canAccessRoom(ctx.userId, await getRoom(m.room_id)))) throw stickerNotFound();
    if (!m.sticker_file_id) throw stickerNotFound();
    return m.sticker_file_id;
  }
  const fileId = String(input.fileId ?? '');
  if (!ID_RE.test(fileId)) throw badRequest('error-invalid-params', 'Informe a figurinha.');
  return fileId;
}

// Conteúdo da organização: está num pacote da organização e nasceu lá. Uma figurinha pessoal que um gestor salva num
// rascunho continua pessoal (uso pessoal antes da primeira linha da organização), senão bastaria salvar para remover
// das conversas e dos pacotes de todo mundo. Uma figurinha da organização que alguém salvou depois continua da organização.
async function orgContent(fileId: string, db?: Queryable): Promise<boolean> {
  const r = await one(
    `SELECT o.first IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
                        WHERE s.file_id = $1 AND p.scope = 'personal' AND s.created_at < o.first)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sticker_file_id = $1
                        AND m.extra->'sticker'->>'scope' = 'personal' AND m.created_at < o.first) AS ok
     FROM (SELECT min(s.created_at) AS first FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
           WHERE s.file_id = $1 AND p.scope = 'org') o`,
    [fileId],
    db,
  );
  return !!r?.ok;
}

// Na mesma transação da remoção: ela não acontece sem o registro, nem se a conexão cair logo depois do commit.
async function auditIn(db: Queryable, ctx: Ctx, action: string, target: Record<string, unknown>, data: Record<string, unknown>) {
  const a = actorOf(ctx);
  await query(
    'INSERT INTO audit_log (id, actor_id, actor_username, action, target, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [newId(), a.id ?? null, a.username ?? null, action, JSON.stringify(target), JSON.stringify(data), a.ip ?? null],
    db,
  );
}

// Depois do commit: avisos e disco. Um erro aqui não desfaz nada e não pode esconder os outros avisos.
async function quietly(fn: () => unknown) {
  try {
    await fn();
  } catch {
    // a lixeira e a próxima leitura terminam o serviço
  }
}

const removeNotAllowed = () =>
  new ApiError(403, 'error-sticker-remove-not-allowed', 'Só a moderação pode remover de todas as conversas uma figurinha que não está nos pacotes da organização.');

// Troca a figurinha das mensagens pelo estado "removida", mantendo o tamanho da caixa.
export async function rewriteRemovedStickerMessages(db: Queryable, fileId: string, onlyMessageId?: string): Promise<{ id: string; room_id: string }[]> {
  return many(
    `UPDATE messages SET
       extra = jsonb_set(extra, '{sticker}', jsonb_strip_nulls(jsonb_build_object(
         'fileId', $1::text, 'removed', true,
         'width', extra->'sticker'->'width', 'height', extra->'sticker'->'height'))),
       attachments = coalesce((SELECT jsonb_agg(a) FROM jsonb_array_elements(attachments) a WHERE a->>'type' IS DISTINCT FROM 'sticker'), '[]'::jsonb)
                     || '[{"type":"sticker","text":"Figurinha removida"}]'::jsonb,
       updated_at = now()
     WHERE sticker_file_id = $1 AND extra->'sticker'->>'removed' IS DISTINCT FROM 'true'
       AND ($2::text IS NULL OR id = $2)
     RETURNING id, room_id`,
    [fileId, onlyMessageId ?? null],
    db,
  );
}

export async function removeEverywhere(
  ctx: Ctx,
  input: { fileId?: string; messageId?: string; reason?: string },
): Promise<{ fileId: string; messages: number; packs: number; users: number; alreadyRemoved?: true }> {
  const { flags } = await stickerRoleInfo(ctx.userId);
  if (!flags.moderator && !flags.manager) throw forbidden();
  const fileId = await fileIdFromInput(ctx, flags, input);
  const exists = await one('SELECT blocked_at FROM sticker_files WHERE id = $1', [fileId]);
  if (!exists) throw stickerNotFound();
  const already = { fileId, messages: 0, packs: 0, users: 0, alreadyRemoved: true as const };
  if (exists.blocked_at) return already;
  if (!flags.moderator && !(await orgContent(fileId))) throw removeNotAllowed();
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  const keepDays = getSetting<number>('Stickers_Removed_Keep_Days');

  const out = await tx(async (c) => {
    const f = await one<StickerFileRow>(`SELECT ${FILE_COLUMNS} FROM sticker_files WHERE id = $1 FOR UPDATE`, [fileId], c);
    if (!f) throw stickerNotFound();
    if (f.blocked_at) return null;
    // Com a linha travada: o gestor só remove o que ainda está num pacote da organização e nasceu lá.
    if (!flags.moderator && !(await orgContent(fileId, c))) throw removeNotAllowed();
    const named = await one(
      `SELECT coalesce(
         (SELECT s.name FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = $1 AND p.scope = 'org'
          ORDER BY p.sort, p.created_at, s.sort, s.created_at LIMIT 1),
         (SELECT m.extra->'sticker'->>'name' FROM messages m WHERE m.sticker_file_id = $1 AND m.extra->'sticker'->>'name' IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1),
         (SELECT s.name FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = $1 AND p.scope = 'personal'
          ORDER BY s.created_at LIMIT 1)) AS name`,
      [fileId],
      c,
    );
    const name = named?.name || DEFAULT_STICKER_NAME;
    const q = keepDays > 0 ? `quarantine/${fileId}` : null;
    const qPoster = keepDays > 0 && f.poster_path ? `quarantine/${fileId}.poster` : null;
    await query(
      `UPDATE sticker_files SET blocked_at = now(), blocked_by = $2, blocked_reason = $3, blocked_name = $4,
         path = NULL, poster_path = NULL, orphan_since = NULL,
         quarantine_path = $5, quarantine_poster_path = $6,
         quarantine_until = CASE WHEN $5::text IS NULL THEN NULL ELSE now() + make_interval(days => $7) END
       WHERE id = $1`,
      [fileId, JSON.stringify({ _id: ctx.userId, username: ctx.username }), reason, name, q, qPoster, keepDays],
      c,
    );
    await queueTrash(c, f.path, q);
    await queueTrash(c, f.poster_path, qPoster);
    // Capas antes das figurinhas: a ordem fica arquivo, pacote, figurinha, a mesma de criar, reordenar e apagar. Pela chave
    // estrangeira, o pacote só travaria depois das figurinhas e um reordenar em paralelo daria deadlock.
    await query('UPDATE sticker_packs SET cover_sticker_id = NULL WHERE cover_sticker_id IN (SELECT id FROM stickers WHERE file_id = $1)', [fileId], c);
    const packs = await many(
      `WITH gone AS (DELETE FROM stickers WHERE file_id = $1 RETURNING pack_id)
       SELECT p.id, p.scope, p.owner_id FROM sticker_packs p WHERE p.id IN (SELECT pack_id FROM gone)`,
      [fileId],
      c,
    );
    const itemUsers = await many('DELETE FROM sticker_user_items WHERE file_id = $1 RETURNING user_id', [fileId], c);
    const msgs = await rewriteRemovedStickerMessages(c, fileId);
    const ids = msgs.map((m) => m.id);
    const rooms = ids.length
      ? await many(`UPDATE rooms SET last_message = jsonb_set(last_message, '{msg}', '"Figurinha removida"') WHERE last_message->>'_id' = ANY($1) RETURNING id`, [ids], c)
      : [];
    if (ids.length) await query('UPDATE moderation_reports SET resolved = true WHERE message_id = ANY($1) AND NOT resolved', [ids], c);
    const orgTouched = packs.some((p) => p.scope === 'org');
    const users = new Set<string>([...packs.filter((p) => p.owner_id).map((p) => p.owner_id as string), ...itemUsers.map((r) => r.user_id as string)]);
    await bumpVersions([...(orgTouched ? ['org'] : []), ...[...users].map((u) => `user:${u}`)], c);
    await auditIn(c, ctx, 'sticker.removed_everywhere', { fileId }, { name, reason, sha256: f.sha256, messages: msgs.length, packs: packs.length, users: users.size, keepDays });
    return { f, name, msgs, rooms: rooms.map((r) => r.id as string), packs: packs.length, orgTouched, users: [...users] };
  });
  if (!out) return already;

  destroyStickerStreams(fileId);
  // O que o disco não fizer agora fica na lixeira para a limpeza diária (D20).
  await quietly(() => drainStickerTrash({ only: [out.f.path, out.f.poster_path] }));
  clearStickerAccessCache();
  bus.publish({ all: true }, { type: 'sticker.removed', fileId });
  for (const rid of out.rooms) await quietly(() => notifyRoomUpdated(rid));
  if (out.orgTouched) notifyStickers('org');
  for (const u of out.users) notifyStickers('mine', u);
  return { fileId, messages: out.msgs.length, packs: out.packs, users: out.users.length };
}

// Permitir de novo: a linha de bloqueio sai, a cópia da quarentena também, e as mensagens continuam "removidas".
export async function unblockFile(ctx: Ctx, fileId: string): Promise<void> {
  const { flags } = await stickerRoleInfo(ctx.userId);
  if (!flags.moderator) throw forbidden();
  if (!ID_RE.test(fileId)) throw stickerNotFound();
  const out = await tx(async (c) => {
    // Linhas que uma corrida antiga deixou para trás saem em cascata; os donos recebem versão nova.
    const keys = await many(
      `SELECT CASE WHEN p.scope = 'org' THEN 'org' ELSE 'user:' || p.owner_id END AS key
       FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = $1
       UNION SELECT 'user:' || user_id FROM sticker_user_items WHERE file_id = $1`,
      [fileId],
      c,
    );
    const row = await one(
      'DELETE FROM sticker_files WHERE id = $1 AND blocked_at IS NOT NULL RETURNING quarantine_path, quarantine_poster_path, blocked_name',
      [fileId],
      c,
    );
    if (!row) throw stickerNotFound();
    await queueTrash(c, row.quarantine_path);
    await queueTrash(c, row.quarantine_poster_path);
    await bumpVersions(keys.map((k) => k.key as string), c);
    await auditIn(c, ctx, 'sticker.unblocked', { fileId }, { name: row.blocked_name });
    return { row, keys: keys.map((k) => k.key as string) };
  });
  // Só os arquivos desta figurinha (a quarentena e o que uma remoção interrompida deixou), não a lixeira inteira:
  // um arquivo preso pelo antivírus em outra figurinha não pode segurar este pedido.
  await quietly(async () => {
    const left = await many(`SELECT path FROM sticker_trash WHERE path LIKE '%/' || $1 OR path LIKE '%/' || $1 || '.poster'`, [fileId]);
    await drainStickerTrash({ only: [out.row.quarantine_path, out.row.quarantine_poster_path, ...left.map((r) => r.path as string)] });
  });
  clearStickerAccessCache();
  for (const k of out.keys) {
    if (k === 'org') notifyStickers('org');
    else notifyStickers('mine', k.slice(5));
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function listBlocked(
  ctx: Ctx,
  opts: { text?: string; offset?: number; count?: number },
): Promise<{ files: BlockedStickerFile[]; total: number; offset: number; count: number }> {
  const { flags } = await stickerRoleInfo(ctx.userId);
  if (!flags.moderationViewer) throw forbidden();
  const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
  const count = Math.max(1, Math.min(500, Number(opts.count ?? 25) || 25));
  const text = String(opts.text ?? '').trim();
  const params: unknown[] = [];
  let where = 'f.blocked_at IS NOT NULL';
  if (text) {
    params.push(`%${likeEscape(text)}%`);
    where += ` AND (f.blocked_name ILIKE $1 ESCAPE '\\' OR f.blocked_reason ILIKE $1 ESCAPE '\\')`;
  }
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM sticker_files f WHERE ${where}`, params);
  const rows = await many(
    `SELECT f.id, f.blocked_name, f.blocked_reason, f.blocked_at, f.blocked_by, f.mime, f.quarantine_until,
            (f.quarantine_path IS NOT NULL AND f.quarantine_until > now()) AS quarantined,
            (SELECT count(*)::int FROM messages m WHERE m.sticker_file_id = f.id) AS messages
     FROM sticker_files f WHERE ${where}
     ORDER BY f.blocked_at DESC LIMIT ${count} OFFSET ${offset}`,
    params,
  );
  const files: BlockedStickerFile[] = rows.map((r) => ({
    fileId: r.id,
    name: r.blocked_name || DEFAULT_STICKER_NAME,
    reason: r.blocked_reason ?? '',
    blockedAt: r.blocked_at,
    blockedBy: r.blocked_by ?? null,
    messages: r.messages,
    quarantined: !!r.quarantined,
    quarantineUntil: r.quarantine_until ?? null,
    mime: r.mime as StickerMime,
  }));
  return { files, total: total?.n ?? 0, offset, count: files.length };
}

// Moderação vê tudo; gestor, só arquivos de pacotes da organização e sem donos nem procedência.
export async function stickerUsage(ctx: Ctx, input: { fileId?: string; messageId?: string }): Promise<StickerUsage> {
  const { flags } = await stickerRoleInfo(ctx.userId);
  if (!flags.moderationViewer && !flags.manager) throw forbidden();
  const fileId = await fileIdFromInput(ctx, flags, input);
  const f = await one('SELECT id, blocked_at, created_by FROM sticker_files WHERE id = $1', [fileId]);
  if (!f) throw stickerNotFound();
  if (!flags.moderationViewer && !(await orgContent(fileId))) throw stickerNotFound();
  const counts = await one(
    `SELECT (SELECT count(*)::int FROM messages WHERE sticker_file_id = $1) AS messages,
            (SELECT count(DISTINCT room_id)::int FROM messages WHERE sticker_file_id = $1) AS rooms,
            (SELECT count(DISTINCT pack_id)::int FROM stickers WHERE file_id = $1) AS packs,
            (SELECT count(*)::int FROM sticker_user_items WHERE file_id = $1 AND kind = 'favorite') AS favorites`,
    [fileId],
  );
  const packs = await many(
    `SELECT DISTINCT ON (p.id) p.id, p.name, p.scope, u.username AS owner, p.sort, p.created_at
     FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id LEFT JOIN users u ON u.id = p.owner_id
     WHERE s.file_id = $1 ${flags.moderationViewer ? '' : `AND p.scope = 'org'`}
     ORDER BY p.id`,
    [fileId],
  );
  packs.sort((a, b) => (a.scope === b.scope ? a.sort - b.sort || String(a.created_at).localeCompare(String(b.created_at)) : a.scope === 'org' ? -1 : 1));
  const usage: StickerUsage = {
    fileId,
    messages: counts?.messages ?? 0,
    rooms: counts?.rooms ?? 0,
    packCount: counts?.packs ?? 0,
    packs: packs.map((p) => (flags.moderationViewer && p.owner ? { _id: p.id, name: p.name, scope: p.scope, owner: p.owner } : { _id: p.id, name: p.name, scope: p.scope })),
    favorites: counts?.favorites ?? 0,
    blocked: !!f.blocked_at,
    keepDays: getSetting<number>('Stickers_Removed_Keep_Days'),
  };
  if (flags.moderationViewer) {
    const creator = f.created_by ? await one('SELECT username FROM users WHERE id = $1', [f.created_by]) : null;
    const sources = await many(
      `SELECT s.id, p.name AS pack_name, o.username AS owner, s.source_message_id, su.username AS source_user
       FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
       LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN users su ON su.id = s.source_user_id
       WHERE s.file_id = $1 ORDER BY s.created_at`,
      [fileId],
    );
    usage.provenance = {
      createdBy: creator?.username ?? null,
      sources: sources.map((s) => {
        const src: NonNullable<StickerUsage['provenance']>['sources'][number] = {
          stickerId: s.id,
          packName: s.pack_name,
          sourceMessageId: s.source_message_id ?? null,
          sourceUser: s.source_user ?? null,
        };
        if (s.owner) src.owner = s.owner;
        return src;
      }),
    };
  }
  return usage;
}

// ---------- Limpeza diária ----------

const REF = (f: string) => `(EXISTS (SELECT 1 FROM stickers WHERE file_id = ${f}.id)
  OR EXISTS (SELECT 1 FROM sticker_user_items WHERE file_id = ${f}.id)
  OR EXISTS (SELECT 1 FROM messages WHERE sticker_file_id = ${f}.id))`;

export async function gcStickerFiles(): Promise<{ marked: number; deleted: number; purged: number; stuck: number }> {
  await query(`UPDATE sticker_files f SET orphan_since = NULL WHERE orphan_since IS NOT NULL AND ${REF('f')}`);
  const marked = (await query(`UPDATE sticker_files f SET orphan_since = now() WHERE orphan_since IS NULL AND blocked_at IS NULL AND NOT ${REF('f')}`)).rowCount ?? 0;
  // A trava que storeStickerFile pega faz este DELETE esperar e reler orphan_since (§3.11).
  const deleted = await tx(async (c) => {
    const rows = await many(
      `DELETE FROM sticker_files f WHERE orphan_since < now() - interval '7 days' AND blocked_at IS NULL AND NOT ${REF('f')} RETURNING path, poster_path`,
      [],
      c,
    );
    for (const r of rows) {
      await queueTrash(c, r.path);
      await queueTrash(c, r.poster_path);
    }
    return rows.length;
  });
  const purged = await tx(async (c) => {
    const rows = await many(
      `WITH old AS (
         SELECT id, quarantine_path, quarantine_poster_path FROM sticker_files
         WHERE quarantine_path IS NOT NULL AND quarantine_until < now() FOR UPDATE
       )
       UPDATE sticker_files f SET quarantine_path = NULL, quarantine_poster_path = NULL, quarantine_until = NULL
       FROM old WHERE f.id = old.id
       RETURNING old.quarantine_path, old.quarantine_poster_path`,
      [],
      c,
    );
    for (const r of rows) {
      await queueTrash(c, r.quarantine_path);
      await queueTrash(c, r.quarantine_poster_path);
    }
    return rows.length;
  });
  const { stuck } = await drainStickerTrash();
  return { marked, deleted, purged, stuck };
}
