import type { Attachment, Message, MessageFile } from '@shared/index';
import { encryptedContent, FORWARD_MAX_TARGETS, type MessageForward } from '@shared/messages';
import type { MessageSticker } from '@shared/stickers';
import { many } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { isPrivateRoom } from './direct';
import { filterBadWords, getMessageRow, sanitizeAttachments, sendMessage } from './messages';
import { hasPermission } from './permissions';
import { canAccessRoom, createDirect, getRoom } from './rooms';
import { getSetting } from './settings';
import { typeAllowed } from './uploads';
import type { Ctx } from './users';

// Encaminhar: a mesma mensagem (texto, arquivos, figurinha, anexos de integração) publicada em outras conversas por quem
// a lê, com a origem guardada em messages.extra.forward. Cada destino passa pelo sendMessage, com todas as regras de
// envio dele (inscrição, somente leitura, canal de avisos, silêncio, arquivada, DM restrita, tamanho, @all).

export interface ForwardTarget {
  rid?: string;
  username?: string;
}

export type ForwardResult =
  | { target: ForwardTarget; ok: true; rid: string; message: Message }
  | { target: ForwardTarget; ok: false; error: string; errorType: string };

const FILE_LINK_RE = /^\/file-upload\/([A-Za-z0-9]{10,24})\//;
const URL_KEYS = ['title_link', 'image_url', 'audio_url', 'video_url'] as const;

const notForwardable = (text = 'Este tipo de mensagem não pode ser encaminhado.') => badRequest('error-forward-not-allowed', text);

// Destinos sem repetição: o mesmo rid, ou o mesmo @usuário sem diferenciar maiúsculas.
function uniqueTargets(list: unknown): ForwardTarget[] {
  if (!Array.isArray(list)) throw badRequest('error-invalid-params', 'Parâmetros inválidos.');
  const out: ForwardTarget[] = [];
  const seen = new Set<string>();
  for (const t of list as any[]) {
    const rid = typeof t?.rid === 'string' && t.rid ? t.rid : undefined;
    const username = !rid && typeof t?.username === 'string' && t.username.trim() ? t.username.trim().replace(/^@/, '') : undefined;
    if (!rid && !username) throw badRequest('error-invalid-params', `Escolha de 1 a ${FORWARD_MAX_TARGETS} destinos.`);
    const key = rid ? `r:${rid}` : `u:${username!.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rid ? { rid } : { username });
  }
  if (!out.length || out.length > FORWARD_MAX_TARGETS) throw badRequest('error-invalid-params', `Escolha de 1 a ${FORWARD_MAX_TARGETS} destinos.`);
  return out;
}

const fileIdOf = (a: Attachment) => (a.title_link ? FILE_LINK_RE.exec(a.title_link)?.[1] ?? null : null);
const isFileAttachment = (a: Attachment) => a.type === 'file' || !!a.title_link?.startsWith('/file-upload/');

export async function forwardMessage(ctx: Ctx, input: { messageId: string; targets: unknown; comment?: unknown }): Promise<{ results: ForwardResult[] }> {
  if (!(await hasPermission(ctx.userId, 'forward-message'))) throw forbidden('Você não tem permissão para encaminhar mensagens.');
  const targets = uniqueTargets(input.targets);
  const m = await getMessageRow(input.messageId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  const src = await getRoom(m.room_id);
  // Canal público vale sem entrar, como na citação.
  if (!(await canAccessRoom(ctx.userId, src))) throw forbidden('Você não tem acesso a esta mensagem.');
  if (encryptedContent(src, m)) throw badRequest('error-forward-encrypted', 'Mensagens de salas criptografadas não podem ser encaminhadas.');
  if (m.t || m.extra?.poll) throw notForwardable();
  const srcSticker: MessageSticker | undefined = m.extra?.sticker;
  if (srcSticker?.removed) throw notForwardable('Esta figurinha foi removida.');
  const max = getSetting<number>('Message_MaxAllowedSize');
  const comment = filterBadWords(typeof input.comment === 'string' ? input.comment.trim() : '');
  if (comment.length > max) throw badRequest('error-message-size-exceeded', `A mensagem excede ${max} caracteres.`);

  // ---------- Conteúdo, montado uma vez ----------
  // Arquivos: só os que ainda existem (a retenção pode ter tirado). A cópia é outra linha de files, com outro id.
  const fileRows = await many('SELECT id, name, type, size FROM files WHERE message_id = $1', [m.id]);
  const rowById = new Map(fileRows.map((f) => [f.id as string, f]));
  const fileAtts: Attachment[] = [];
  const stickerAtts: Attachment[] = [];
  const otherAtts: Attachment[] = [];
  for (const a of (m.attachments ?? []) as Attachment[]) {
    if (!a || typeof a !== 'object' || a.message_link || a.pendingFileId) continue; // citações e arquivos pendentes da importação não vão
    if (a.type === 'sticker') {
      if (srcSticker) stickerAtts.push(a);
      continue;
    }
    if (isFileAttachment(a)) {
      const id = fileIdOf(a);
      if (id && rowById.has(id)) fileAtts.push(a);
      continue;
    }
    otherAtts.push(a);
  }
  const integration = otherAtts.length ? await sanitizeAttachments(ctx, otherAtts) : [];
  const usedIds = [...new Set(fileAtts.map(fileIdOf).filter((x): x is string => !!x))];
  const msgFiles = ((m.files ?? []) as MessageFile[]).filter((f) => usedIds.includes(f._id));
  const types = usedIds.map((id) => String(rowById.get(id)!.type));
  if (!m.msg && !usedIds.length && !srcSticker && !integration.length) throw notForwardable('Esta mensagem não tem mais conteúdo para encaminhar.');

  // Origem: encaminhar de novo mantém a primeira e soma um salto (o comentário anterior não vai).
  let origin: MessageForward;
  if (m.extra?.forward) {
    origin = { ...(m.extra.forward as MessageForward) };
    delete origin.comment;
    origin.hops = (origin.hops ?? 1) + 1;
  } else {
    origin = {
      mid: m.id,
      rid: src.id,
      t: src.t,
      tmid: m.tmid ?? null,
      u: { _id: m.user_id, username: m.username, name: m.user_name || undefined },
      ts: m.created_at,
      hops: 1,
    };
    if (m.alias) origin.alias = m.alias;
    // Só o nome de um canal público: grupo privado, canal de time privado e DM a web resolve pela inscrição de quem vê.
    if (src.t === 'c' && !(await isPrivateRoom(src))) origin.roomName = src.fname || src.name;
  }
  if (comment) origin.comment = comment;

  // ---------- Cada destino, em sequência ----------
  const results: ForwardResult[] = [];
  const sent = new Map<string, Message>();
  for (const target of targets) {
    try {
      let room: any;
      if (target.rid) {
        room = await getRoom(target.rid);
        if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
      } else {
        // createDirect recusa sem create-d com o texto padrão (em inglês): o motivo vai em português para a tela.
        if (!(await hasPermission(ctx.userId, 'create-d'))) throw forbidden('Você não pode iniciar conversas diretas.');
        room = await createDirect(ctx, [target.username!]);
      }
      const done = sent.get(room.id);
      if (done) {
        results.push({ target, ok: true, rid: room.id, message: done });
        continue;
      }
      if (encryptedContent(room)) throw badRequest('error-forward-encrypted-target', 'Não dá para encaminhar para uma sala criptografada.');
      if (usedIds.length) {
        if (!getSetting('FileUpload_Enabled')) throw new ApiError(403, 'error-forward-files-disabled', 'O envio de arquivos está desativado.');
        if (room.t === 'd' && !getSetting('FileUpload_Enabled_Direct')) throw new ApiError(403, 'error-forward-files-direct', 'Arquivos não podem ser enviados em mensagens diretas.');
        if (types.some((t) => !typeAllowed(t))) throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');
      }
      if (srcSticker) {
        // Os erros de sala vêm antes dos de figurinha, como no envio pelo seletor.
        const { canPostInRoom } = await import('./messages');
        await canPostInRoom(ctx, room);
        const { assertStickerAllowedIn } = await import('../stickers/send');
        await assertStickerAllowedIn(ctx, room, srcSticker.fileId, srcSticker.scope);
      }
      const idMap = new Map(usedIds.map((id) => [id, newId()]));
      const swap = (url?: string) => {
        if (!url) return url;
        const id = FILE_LINK_RE.exec(url)?.[1];
        const to = id && idMap.get(id);
        return to ? url.replace(`/file-upload/${id}/`, `/file-upload/${to}/`) : url;
      };
      const attachments: Attachment[] = [
        ...fileAtts.map((a) => {
          const copy: Attachment = { ...a };
          for (const k of URL_KEYS) if (copy[k]) copy[k] = swap(copy[k]);
          return copy;
        }),
        ...stickerAtts,
        ...integration,
      ];
      const files: MessageFile[] = msgFiles.map((f) => ({ ...f, _id: idMap.get(f._id)! }));
      const oldIds = [...idMap.keys()];
      const newIds = oldIds.map((id) => idMap.get(id)!);
      const message = await sendMessage(
        ctx,
        { rid: room.id, msg: m.msg, attachments, files, sticker: srcSticker, forward: origin },
        {
          skipCommands: true,
          internalAttachments: true,
          sticker: !!srcSticker,
          forward: true,
          onInserted: async (row) => {
            if (oldIds.length) {
              // FOR SHARE: uma exclusão simultânea da original espera a cópia existir; depois dela, removeFiles vê a
              // cópia e mantém o arquivo no disco.
              const r = await many(
                `INSERT INTO files (id, room_id, user_id, message_id, name, type, size, storage_path)
                 SELECT x.new_id, $2, $3, $4, f.name, f.type, f.size, f.storage_path
                   FROM (SELECT * FROM files WHERE id = ANY($1::text[]) FOR SHARE) f
                   JOIN unnest($1::text[], $5::text[]) AS x(old_id, new_id) ON x.old_id = f.id
                 RETURNING id`,
                [oldIds, room.id, ctx.userId, row.id, newIds],
              );
              if (r.length < oldIds.length) throw badRequest('error-forward-gone', 'A mensagem original foi apagada.');
            }
            if (srcSticker) {
              const { stickerStillUsable } = await import('../stickers/send');
              if (!(await stickerStillUsable(srcSticker.fileId))) {
                const { removedError } = await import('../stickers/service');
                throw removedError();
              }
            }
          },
        },
      );
      sent.set(room.id, message);
      results.push({ target, ok: true, rid: room.id, message });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      results.push({ target, ok: false, error: e.message, errorType: e.errorType });
    }
  }
  return { results };
}
