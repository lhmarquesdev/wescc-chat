import type { Attachment, Message } from '@shared/index';
import { DEFAULT_STICKER_NAME, STICKER_LIMITS, stickerPosterUrl, stickerUrl, type MessageStickerLive, type StickerScope } from '@shared/stickers';
import { one, pool } from '../db/pool';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { bus } from '../realtime/bus';
import { canPostInRoom, filterBadWords, getMessageRow, sanitizeAttachments, sendMessage, withExtra } from '../services/messages';
import { getRoom, notifyRoomUpdated } from '../services/rooms';
import { getSetting } from '../services/settings';
import { typeAllowed } from '../services/uploads';
import type { Ctx } from '../services/users';
import { fileFacts, forgetDenied, isUsable, visibleOrgSql, type StickerFileRow } from './files';
import { rewriteRemovedStickerMessages } from './moderation';
import { isSendBlocked, recordRecent, removedError, stickerNotFound, stickerRoleInfo } from './service';

// Envio de figurinhas: as regras da sala primeiro (iguais às do texto), depois as da figurinha.

const ID_RE = /^[A-Za-z0-9]{10,24}$/;

let sendBurst: number = STICKER_LIMITS.sendBurst;
let sendWindowMs: number = STICKER_LIMITS.sendWindowMs;
const sends = new Map<string, number[]>(); // userId -> horários dos envios recentes

// Também zera os contadores.
export function __setStickerSendBurstForTests(burst: number, windowMs: number) {
  sendBurst = burst;
  sendWindowMs = windowMs;
  sends.clear();
}

function countSend(userId: string) {
  const now = Date.now();
  const list = (sends.get(userId) ?? []).filter((t) => now - t < sendWindowMs);
  if (list.length >= sendBurst) {
    sends.set(userId, list);
    throw new ApiError(429, 'error-sticker-too-fast', 'Muitas figurinhas seguidas. Espere alguns segundos.');
  }
  list.push(now);
  sends.set(userId, list);
  if (sends.size > 20_000) for (const [k, v] of sends) if (!v.some((t) => now - t < sendWindowMs)) sends.delete(k);
}

// Um reenvio (clique duplo, rede lenta, socket que caiu) que chega com o primeiro ainda em andamento espera por ele,
// e então a checagem de _id acha a mensagem pronta (D19). Fila por pessoa e _id, nesta instância.
const inFlight = new Map<string, Promise<unknown>>();

async function onePerId<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prev = inFlight.get(key);
  const run = prev ? prev.then(() => fn()) : fn();
  const tail = run.catch(() => {});
  inFlight.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}

interface Resolved {
  file: StickerFileRow;
  scope: StickerScope;
  name: string;
  emojis: string[];
  org: { stickerId: string; packId: string; packName: string } | null;
}

async function resolveSticker(ctx: Ctx, roles: string[], manager: boolean, input: { stickerId?: string; fileId?: string }): Promise<Resolved> {
  let fileId: string;
  let chosen: { id: string; name: string; emojis: string[]; scope: string; pack_id: string; pack_name: string } | null = null;
  if (input.stickerId) {
    // A figurinha precisa estar num pacote da organização visível ou num pacote próprio.
    chosen = await one(
      `SELECT s.id, s.name, s.emojis, s.file_id, p.scope, p.id AS pack_id, p.name AS pack_name
       FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
       WHERE s.id = $1 AND (p.owner_id = $2 OR ${visibleOrgSql('p', '$3::text[]', '$4::boolean')})`,
      [input.stickerId, ctx.userId, roles, manager],
    );
    if (!chosen) throw stickerNotFound();
    fileId = (chosen as any).file_id;
  } else {
    fileId = String(input.fileId);
    if (!ID_RE.test(fileId)) throw stickerNotFound();
  }
  const facts = await fileFacts(ctx.userId, fileId);
  if (facts.file?.blocked_at) throw removedError();
  if (!facts.file || (!chosen && !isUsable(facts))) throw stickerNotFound();
  // Escopo 'org' quando o arquivo está num pacote da organização visível, venha de onde vier.
  if (chosen?.scope === 'org') {
    return { file: facts.file, scope: 'org', name: chosen.name, emojis: chosen.emojis ?? [], org: { stickerId: chosen.id, packId: chosen.pack_id, packName: chosen.pack_name } };
  }
  if (facts.visibleOrg) {
    const v = facts.visibleOrg;
    return { file: facts.file, scope: 'org', name: v.name, emojis: v.emojis, org: { stickerId: v.stickerId, packId: v.packId, packName: v.packName } };
  }
  if (chosen) return { file: facts.file, scope: 'personal', name: chosen.name, emojis: chosen.emojis ?? [], org: null };
  // Pessoal por arquivo: a linha própria, ou então a favorita ou recente.
  const own = await one(
    `SELECT s.name, s.emojis FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
     WHERE s.file_id = $1 AND p.owner_id = $2 ORDER BY p.sort, p.created_at, s.sort, s.created_at LIMIT 1`,
    [fileId, ctx.userId],
  );
  const item =
    own ??
    (await one(
      `SELECT name, emojis FROM sticker_user_items WHERE user_id = $1 AND file_id = $2 ORDER BY kind = 'favorite' DESC, used_at DESC LIMIT 1`,
      [ctx.userId, fileId],
    ));
  return { file: facts.file, scope: 'personal', name: item?.name ?? DEFAULT_STICKER_NAME, emojis: item?.emojis ?? [], org: null };
}

export async function sendSticker(
  ctx: Ctx,
  input: { roomId: string; stickerId?: string; fileId?: string; tmid?: string | null; tshow?: boolean; quoteMessageId?: string; _id?: string },
): Promise<Message> {
  if (!getSetting('Stickers_Enabled')) throw badRequest('error-stickers-disabled', 'As figurinhas estão desativadas.');
  if (!!input.stickerId === !!input.fileId) throw badRequest('error-invalid-params', 'Informe a figurinha.');
  const room = input.roomId ? await getRoom(String(input.roomId)) : null;
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'l') throw new ApiError(403, 'error-sticker-not-allowed-here', 'Figurinhas não estão disponíveis em atendimentos.');
  // Antes de qualquer regra de figurinha: os erros de sala ficam idênticos aos do texto.
  await canPostInRoom(ctx, room);
  if (room.notice && !getSetting('Stickers_In_Notice_Rooms')) {
    throw new ApiError(403, 'error-sticker-not-allowed-here', 'Figurinhas não são permitidas em canais de avisos.');
  }
  const clientId = input._id && ID_RE.test(input._id) ? input._id : null;
  return onePerId(clientId && `${ctx.userId}:${clientId}`, () => sendOnce(ctx, room, input, clientId));
}

async function sendOnce(ctx: Ctx, room: any, input: Parameters<typeof sendSticker>[1], clientId: string | null): Promise<Message> {
  // A mesma pessoa, na mesma sala, com uma figurinha: é o mesmo envio.
  const sameSend = (row: any) => row.user_id === ctx.userId && row.room_id === room.id && !!row.extra?.sticker;
  let id: string | undefined;
  if (clientId) {
    const prev = await getMessageRow(clientId);
    if (prev && sameSend(prev)) return withExtra(prev);
    id = prev ? undefined : clientId; // id de outra mensagem: sendMessage escolhe outro, como hoje
  }
  if (await isSendBlocked(ctx.userId)) throw new ApiError(403, 'error-sticker-send-blocked', 'Seu perfil não pode enviar figurinhas.');
  countSend(ctx.userId);

  const { roles, flags } = await stickerRoleInfo(ctx.userId);
  const r = await resolveSticker(ctx, roles, flags.manager, input);
  const f = r.file;
  if (r.scope === 'personal') {
    if (!getSetting('Stickers_Personal_Enabled')) throw new ApiError(403, 'error-sticker-personal-disabled', 'As figurinhas pessoais estão desativadas.');
    if (!getSetting('FileUpload_Enabled') || !typeAllowed(f.mime) || (room.t === 'd' && !getSetting('FileUpload_Enabled_Direct'))) {
      throw new ApiError(403, 'error-sticker-personal-not-allowed', 'Nesta conversa só dá para enviar figurinhas da organização.');
    }
  }
  if (f.animated && !getSetting('Stickers_Animated_Enabled')) throw new ApiError(403, 'error-sticker-animated-disabled', 'Figurinhas animadas estão desativadas.');

  // Só do banco: o cliente nunca descreve a figurinha. O filtro roda de novo porque a lista pode ter mudado.
  const snapshot: MessageStickerLive = {
    fileId: f.id,
    name: filterBadWords(r.name || DEFAULT_STICKER_NAME),
    emojis: r.emojis,
    width: f.width,
    height: f.height,
    animated: f.animated,
    url: stickerUrl(f.id, f.mime),
    scope: r.scope,
  };
  if (f.animated) {
    if (f.duration_ms != null) snapshot.durationMs = f.duration_ms;
    if (f.poster_mime) snapshot.posterUrl = stickerPosterUrl(f.id, f.poster_mime);
  }
  if (r.org) Object.assign(snapshot, r.org);

  const quote = input.quoteMessageId ? await sanitizeAttachments(ctx, [{ message_link: `?msg=${input.quoteMessageId}` }]) : [];
  const fallback: Attachment = {
    type: 'sticker',
    title: snapshot.name,
    image_url: snapshot.url,
    image_dimensions: { width: f.width, height: f.height },
    image_type: f.mime,
    image_size: f.size,
  };
  let message: Message;
  for (;;) {
    try {
      message = await sendMessage(
        ctx,
        { _id: id, rid: room.id, msg: '', tmid: input.tmid ?? null, tshow: input.tshow, attachments: [...quote, fallback], sticker: snapshot },
        { skipCommands: true, internalAttachments: true, sticker: true },
      );
      break;
    } catch (e: any) {
      // O arquivo saiu do banco entre a busca e a gravação (permitido de novo e apagado).
      if (e?.code === '23503') throw removedError();
      // O _id foi gravado por outro lado entre a checagem e o INSERT (outra instância): a resposta é aquela mensagem.
      const taken = e?.code === '23505' && id ? await getMessageRow(id) : null;
      if (!taken) throw e;
      if (sameSend(taken)) return withExtra(taken);
      id = undefined;
    }
  }

  // Fecha a corrida com uma remoção em andamento: o FOR SHARE espera por ela.
  const after = await one('SELECT blocked_at FROM sticker_files WHERE id = $1 FOR SHARE', [f.id], pool);
  if (!after || after.blocked_at) {
    const rewritten = await rewriteRemovedStickerMessages(pool, f.id, message._id);
    const row = await getMessageRow(message._id);
    if (row) message = withExtra(row);
    const lm = await one(
      `UPDATE rooms SET last_message = jsonb_set(last_message, '{msg}', '"Figurinha removida"') WHERE id = $1 AND last_message->>'_id' = $2 RETURNING id`,
      [room.id, message._id],
    );
    if (rewritten.length) bus.publish({ room: room.id }, { type: 'message', action: 'updated', message });
    if (lm) await notifyRoomUpdated(room.id);
    return message;
  }

  forgetDenied(f.id);
  try {
    await recordRecent(ctx.userId, f, snapshot);
  } catch {
    // a recente é conveniência: o envio já aconteceu
  }
  return message;
}
