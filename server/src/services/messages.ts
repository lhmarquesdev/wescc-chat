import type { Attachment, MessageFile, UserRef } from '@shared/index';
import type { MessageBridge, MessageJira, MessageMeeting } from '@shared/integrations';
import { messagePreviewText, stickerPreviewText, type MessageSticker } from '@shared/stickers';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { trimEndChars, truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { assertCanSendDirect, partyOf } from './direct';
import { mapMessage } from './mappers';
import { dispatchNotifications } from './notifications';
import { getUserRoles, hasPermission, restrictedRoleIds, rolesHavePermission } from './permissions';
import { canAccessRoom, getRoom, getSubscriptionRow, loadRoomForUser, notifyRoomUpdated } from './rooms';
import { getSetting } from './settings';
import { recordActivity } from './stats';
import { actorOf, type Ctx } from './users';
import { emit } from './hooks';

export const MENTION_RE = /(?:^|[\s(>"'])@([0-9a-zA-Z._-]+)/g;
export const CHANNEL_RE = /(?:^|[\s(])#([0-9a-zA-ZÀ-ſ._-]+)/g;

export async function getMessageRow(id: string) {
  return one('SELECT * FROM messages WHERE id = $1', [id]);
}

async function parseMentions(msg: string, room: any) {
  const names = new Set<string>();
  for (const m of msg.matchAll(MENTION_RE)) names.add(trimEndChars(m[1], '.'));
  const mentions: UserRef[] = [];
  const special: string[] = [];
  const lookup: string[] = [];
  for (const n of names) {
    if (n === 'all' || n === 'here') special.push(n);
    else lookup.push(n.toLowerCase());
  }
  for (const s of special) mentions.push({ _id: s, username: s });
  if (lookup.length) {
    const users = await many('SELECT id, username, name FROM users WHERE lower(username) = ANY($1)', [lookup]);
    for (const u of users) mentions.push({ _id: u.id, username: u.username, name: u.name });
    // Menção a time: @nome-do-time notifica todos os membros.
    const found = new Set(users.map((u) => u.username.toLowerCase()));
    const rest = lookup.filter((l) => !found.has(l));
    if (rest.length) {
      const teams = await many('SELECT id, name FROM teams WHERE lower(name) = ANY($1)', [rest]);
      for (const t of teams) mentions.push({ _id: t.id, username: t.name, name: t.name, type: 'team' } as UserRef);
    }
  }
  const chNames = new Set<string>();
  for (const m of msg.matchAll(CHANNEL_RE)) chNames.add(m[1].toLowerCase());
  const channels = chNames.size
    ? (await many(`SELECT id, name FROM rooms WHERE lower(name) = ANY($1) AND t IN ('c','p')`, [[...chNames]])).map((r) => ({ _id: r.id, name: r.name }))
    : [];
  void room;
  return { mentions, channels };
}

export function filterBadWords(msg: string) {
  if (!getSetting('Message_AllowBadWordsFilter')) return msg;
  const words = String(getSetting('Message_BadWordsFilterList') ?? '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  let out = msg;
  for (const w of words) out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), (m) => '*'.repeat(m.length));
  return out;
}

export async function sendSystemMessage(rid: string, t: string, user: { id: string; username: string }, msg: string, extra: Record<string, unknown> = {}) {
  const u = await one('SELECT name FROM users WHERE id = $1', [user.id]);
  const row = await one(
    `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, t, extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [newId(), rid, user.id, user.username, u?.name ?? '', msg, t, JSON.stringify(extra)],
  );
  await query('UPDATE rooms SET updated_at = now() WHERE id = $1', [rid]);
  bus.publish({ room: rid }, { type: 'message', action: 'inserted', message: withExtra(row) });
  return row;
}

export function withExtra(row: any) {
  const m = mapMessage(row) as any;
  if (row.extra && Object.keys(row.extra).length) Object.assign(m, row.extra);
  return m;
}

export interface SendInput {
  _id?: string;
  rid: string;
  msg?: string;
  tmid?: string | null;
  tshow?: boolean;
  attachments?: Attachment[];
  files?: MessageFile[];
  alias?: string;
  emoji?: string;
  avatar?: string;
  customFields?: Record<string, unknown>;
  ackRequired?: boolean; // aviso que pede "Ciente"
  // Integrações (Jira/Teams): só valem com opts.integration (código do servidor); chat.sendMessage nunca os repassa.
  jira?: MessageJira;
  meeting?: MessageMeeting;
  bridge?: MessageBridge;
  mentionsAllowed?: string[]; // usernames que podem virar menção numa mensagem de integração (só o responsável da issue)
  sticker?: MessageSticker; // figurinha (só chat.sendSticker preenche, com opts.sticker)
}

export async function canPostInRoom(ctx: Ctx, room: any) {
  const sub = await getSubscriptionRow(room.id, ctx.userId);
  if (!sub) {
    if (room.t === 'l' && (await hasPermission(ctx.userId, 'view-livechat-rooms'))) return;
    throw forbidden('Você precisa entrar na sala para enviar mensagens.');
  }
  return assertCanWrite(ctx, room);
}

// Regras de escrita, sem exigir inscrição: valem para enviar, editar e criar discussão. Editar ou abrir uma
// discussão numa sala em que a pessoa não pode enviar seria outro jeito de publicar texto ali.
async function assertCanWrite(ctx: Ctx, room: any, roles?: string[]) {
  if (room.archived) throw badRequest('error-room-archived', 'Esta sala está arquivada.');
  roles ??= await getUserRoles(ctx.userId, room.id);
  if (room.ro && !rolesHavePermission(roles, 'post-readonly')) {
    throw forbidden(room.notice ? 'Este é um canal de avisos: só os publicadores enviam mensagens.' : 'Esta sala é somente leitura.');
  }
  if (room.muted?.includes(ctx.username)) throw forbidden('Você está silenciado nesta sala.');
  if (room.t === 'd') await assertDirectOpen(ctx, room);
  else await assertCanSendDirect(ctx, room);
  return roles;
}

// DM: participante desativado (conversa a dois) e política de conversas diretas, com uma só consulta.
async function assertDirectOpen(ctx: Ctx, room: any) {
  const restricted = restrictedRoleIds().length > 0;
  if (room.uids.length !== 2 && !restricted) return;
  const users = await many('SELECT id, username, roles, active FROM users WHERE id = ANY($1)', [[...new Set([ctx.userId, ...room.uids])]]);
  if (room.uids.length === 2) {
    const other = users.find((u) => u.id !== ctx.userId && room.uids.includes(u.id));
    if (other && !other.active) throw badRequest('error-user-deactivated', 'Este usuário está desativado.');
  }
  if (restricted) await assertCanSendDirect(ctx, room, users.map(partyOf));
}

// ---------- Anexos enviados pelo cliente ----------

export const safeUrl = (v: unknown) => (typeof v === 'string' && v.length <= 2048 && (/^https?:\/\//i.test(v) || /^\/(?!\/)/.test(v)) ? v : undefined);
const text = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? truncate(String(v), max) : undefined);

function quotedMessageId(link: string) {
  return /[?&]msg=([A-Za-z0-9]{10,24})/.exec(link)?.[1] ?? /\/msg\/([A-Za-z0-9]{10,24})/.exec(link)?.[1] ?? null;
}

// A citação é montada no servidor a partir da mensagem original (o cliente só indica qual é),
// e só se quem cita tem acesso à sala dela: assim não dá para inventar o que outra pessoa disse.
async function quoteAttachment(ctx: Ctx, link: string): Promise<Attachment | null> {
  const id = quotedMessageId(link);
  const m = id ? await getMessageRow(id) : null;
  if (!m || m.t === 'rm') return null;
  if (!(await canAccessRoom(ctx.userId, await getRoom(m.room_id)))) return null;
  const files = (m.files ?? []) as MessageFile[];
  return { text: messagePreviewText({ msg: m.msg, sticker: m.extra?.sticker, files }, { withName: false }), author_name: m.username, ts: m.created_at, message_link: `?msg=${m.id}` };
}

export async function sanitizeAttachments(ctx: Ctx, list: unknown): Promise<Attachment[]> {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const a of list.slice(0, 20) as any[]) {
    if (!a || typeof a !== 'object') continue;
    if (a.message_link) {
      const q = await quoteAttachment(ctx, String(a.message_link));
      if (q) out.push(q);
      continue;
    }
    const clean: Record<string, unknown> = {
      title: text(a.title, 500),
      title_link: safeUrl(a.title_link),
      type: a.type === 'file' ? 'file' : undefined,
      image_url: safeUrl(a.image_url),
      audio_url: safeUrl(a.audio_url),
      video_url: safeUrl(a.video_url),
      description: text(a.description, 5000),
      text: text(a.text, 5000),
      pretext: text(a.pretext, 5000),
      author_name: text(a.author_name, 200),
      author_link: safeUrl(a.author_link),
      author_icon: safeUrl(a.author_icon),
      thumb_url: safeUrl(a.thumb_url),
      footer: text(a.footer, 5000),
      color: text(a.color, 30),
      size: typeof a.size === 'number' ? a.size : undefined,
      format: text(a.format, 20),
      fields: Array.isArray(a.fields) ? a.fields.slice(0, 20).map((f: any) => ({ title: truncate(String(f?.title ?? ''), 200), value: truncate(String(f?.value ?? ''), 2000), short: !!f?.short })) : undefined,
    };
    for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    if (Object.keys(clean).length) out.push(clean as Attachment);
  }
  return out;
}

// trusted: mensagens de integrações, que podem definir apelido e avatar próprios.
// internalAttachments: anexos montados pelo próprio servidor (upload de arquivo).
export async function sendMessage(ctx: Ctx, input: SendInput, opts: { skipCommands?: boolean; trusted?: boolean; internalAttachments?: boolean; sticker?: boolean; integration?: boolean } = {}) {
  const sticker = opts.sticker ? input.sticker : undefined; // só o servidor monta figurinhas
  const room = await getRoom(input.rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  const roles = (await canPostInRoom(ctx, room)) ?? (await getUserRoles(ctx.userId, room.id));
  let msg = (input.msg ?? '').trim();
  const max = getSetting<number>('Message_MaxAllowedSize');
  if (msg.length > max) throw badRequest('error-message-size-exceeded', `A mensagem excede ${max} caracteres.`);
  const attachments = opts.internalAttachments ? (input.attachments ?? []) : await sanitizeAttachments(ctx, input.attachments);
  const rich = opts.integration && (input.jira || input.meeting);
  if (!msg && !attachments.length && !input.files?.length && !sticker && !rich) throw badRequest('error-invalid-message', 'Mensagem vazia.');
  if (sticker && (msg || input.ackRequired)) throw badRequest('error-invalid-message', 'Figurinha não leva texto nem pede “Ciente”.');
  if (input.ackRequired && (!room.notice || !room.notice_ack || input.tmid)) {
    throw badRequest('error-ack-not-allowed', 'Só avisos de um canal de avisos com “Ciente” ativado podem pedir confirmação.');
  }

  if (!opts.skipCommands && msg.startsWith('/') && !input.files?.length) {
    const { runSlashCommand } = await import('./commands');
    const handled = await runSlashCommand(ctx, room, msg, input.tmid ?? null);
    if (handled !== false) return handled;
  }

  if ((input.alias || input.avatar) && !opts.trusted && !rolesHavePermission(roles, 'message-impersonate')) throw forbidden('Sem permissão para personificar.');

  let tmid: string | null = input.tmid ?? null;
  let parent: any = null;
  if (tmid) {
    if (!getSetting('Threads_enabled')) throw badRequest('error-threads-disabled', 'Threads estão desativadas.');
    parent = await getMessageRow(tmid);
    if (!parent || parent.room_id !== room.id) throw badRequest('error-invalid-thread', 'Thread inválida.');
    // Resposta a uma resposta vira resposta da raiz.
    if (parent.tmid) {
      tmid = parent.tmid;
      parent = await getMessageRow(parent.tmid);
    }
  }

  msg = filterBadWords(msg);
  let { mentions, channels } = await parseMentions(msg, room);
  // Integrações (Jira/Teams): texto de fora não menciona ninguém; só o responsável escolhido pelo servidor. Nunca @all, @here, times ou #sala.
  if (opts.integration) {
    const allowed = new Set((input.mentionsAllowed ?? []).map((u) => u.toLowerCase()));
    mentions = mentions.filter((m: any) => m._id !== 'all' && m._id !== 'here' && m.type !== 'team' && allowed.has(String(m.username).toLowerCase()));
    channels = [];
  }
  const mentionAll = mentions.some((m) => m._id === 'all');
  const mentionHere = mentions.some((m) => m._id === 'here');
  if (mentionAll && !rolesHavePermission(roles, 'mention-all')) throw forbidden('Sem permissão para mencionar @all.');
  if (mentionHere && !rolesHavePermission(roles, 'mention-here')) throw forbidden('Sem permissão para mencionar @here.');
  const maxAll = getSetting<number>('Message_MaxAll');
  if (mentionAll && maxAll > 0 && room.users_count > maxAll) throw forbidden(`@all não é permitido em salas com mais de ${maxAll} membros.`);

  const me = await one('SELECT name FROM users WHERE id = $1', [ctx.userId]);
  // Figurinha: sendSticker já conferiu o _id; um conflito volta como erro de chave para o envio idempotente, nunca como cópia.
  const id = input._id && /^[A-Za-z0-9]{10,24}$/.test(input._id) && (sticker || !(await getMessageRow(input._id))) ? input._id : newId();
  const receipts = getSetting<boolean>('Message_Read_Receipt_Enabled');
  const extra: Record<string, unknown> = {};
  if (input.tshow && tmid) extra.tshow = true;
  if (input.customFields) extra.customFields = input.customFields;
  // Integrações (Jira/Teams)
  if (opts.integration) {
    if (input.jira) extra.jira = input.jira;
    if (input.meeting) extra.meeting = input.meeting;
    if (input.bridge) extra.bridge = input.bridge;
  }
  if (sticker) extra.sticker = sticker;
  const row = await one(
    `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, tmid, mentions, channels, attachments, files, alias, emoji, avatar, extra, unread, ack_required, sticker_file_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      id,
      room.id,
      ctx.userId,
      ctx.username,
      me?.name ?? '',
      msg,
      tmid,
      JSON.stringify(mentions),
      JSON.stringify(channels),
      JSON.stringify(attachments),
      JSON.stringify(input.files ?? []),
      input.alias ?? null,
      input.emoji ?? null,
      input.avatar ?? null,
      JSON.stringify(extra),
      receipts && room.users_count > 1,
      !!input.ackRequired,
      sticker?.fileId ?? null,
    ],
  );
  if (input.files?.length) {
    await query('UPDATE files SET message_id = $1 WHERE id = ANY($2)', [id, input.files.map((f) => f._id)]);
  }

  // Atualiza a sala
  const preview = messagePreviewText({ msg, sticker, files: input.files });
  const lastMessage = { _id: id, msg: truncate(preview, 200), u: { _id: ctx.userId, username: ctx.username, name: me?.name }, ts: row.created_at };
  if (!tmid || input.tshow) {
    await query(`UPDATE rooms SET msgs = msgs + 1, last_message = $2, lm = $3, updated_at = now() WHERE id = $1`, [room.id, JSON.stringify(lastMessage), row.created_at]);
  } else {
    await query(`UPDATE rooms SET msgs = msgs + 1, lm = $2, updated_at = now() WHERE id = $1`, [room.id, row.created_at]);
  }

  // Atualiza a raiz da thread
  if (tmid && parent) {
    const updatedParent = await one(
      `UPDATE messages SET tcount = tcount + 1, tlm = $2,
         replies = (SELECT array_agg(DISTINCT x) FROM unnest(replies || ARRAY[$3::text, $4::text]) x),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [tmid, row.created_at, ctx.userId, parent.user_id ?? ctx.userId],
    );
    bus.publish({ room: room.id }, { type: 'message', action: 'updated', message: withExtra(updatedParent) });
    parent = updatedParent;
  }

  const message = withExtra(row);
  bus.publish({ room: room.id }, { type: 'message', action: 'inserted', message });

  await updateSubscriptionsOnMessage(ctx, room, row, mentions, parent);
  if (room.prid) await bumpDiscussionCounter(room);
  void recordActivity(ctx.userId, 'message');
  void dispatchNotifications(ctx, room, row, mentions, parent).catch(() => {});
  // A própria leitura do remetente
  const { markReadInternal } = await import('./reads');
  await markReadInternal(ctx.userId, room.id);
  if (room.t === 'c' || room.t === 'p') await notifyRoomUpdated(room.id);
  else bus.publish({ room: room.id }, { type: 'room', action: 'updated', room: (await import('./mappers')).mapRoom(await getRoom(room.id)) });
  emit('message.sent', { room, message, user: { _id: ctx.userId, username: ctx.username, name: me?.name } });
  if (input.files?.length) emit('file.uploaded', { room, message, file: input.files[0], user: { _id: ctx.userId, username: ctx.username } });
  return message;
}

async function updateSubscriptionsOnMessage(ctx: Ctx, room: any, row: any, mentions: UserRef[], parent: any) {
  const userMentionIds = mentions.filter((m) => m._id !== 'all' && m._id !== 'here' && (m as any).type !== 'team').map((m) => m._id);
  const teamIds = mentions.filter((m) => (m as any).type === 'team').map((m) => m._id);
  if (teamIds.length) {
    const tm = await many('SELECT DISTINCT user_id FROM team_members WHERE team_id = ANY($1)', [teamIds]);
    userMentionIds.push(...tm.map((t) => t.user_id));
  }
  const group = mentions.some((m) => m._id === 'all' || m._id === 'here');
  const isThreadReply = !!row.tmid && !row.extra?.tshow;
  let changed;
  if (isThreadReply) {
    // Seguidores da thread e mencionados recebem a thread em "não lidas".
    const followers: string[] = parent?.replies ?? [];
    const targets = [...new Set([...followers, ...userMentionIds])].filter((u) => u !== ctx.userId);
    if (!targets.length) return;
    changed = await many(
      `UPDATE subscriptions SET tunread = (SELECT array_agg(DISTINCT x) FROM unnest(tunread || ARRAY[$3::text]) x),
         user_mentions = user_mentions + CASE WHEN user_id = ANY($4) THEN 1 ELSE 0 END,
         alert = true, open = true, updated_at = now()
       WHERE room_id = $1 AND user_id = ANY($2) RETURNING *`,
      [room.id, targets, row.tmid, userMentionIds],
    );
  } else {
    changed = await many(
      `UPDATE subscriptions SET
         unread = unread + 1,
         alert = true,
         open = true,
         user_mentions = user_mentions + CASE WHEN user_id = ANY($3) THEN 1 ELSE 0 END,
         group_mentions = group_mentions + CASE WHEN $4 THEN 1 ELSE 0 END,
         updated_at = now()
       WHERE room_id = $1 AND user_id <> $2 RETURNING *`,
      [room.id, ctx.userId, userMentionIds, group],
    );
  }
  const { buildSubscription } = await import('./rooms');
  const fresh = await getRoom(room.id);
  for (const s of changed) {
    bus.publish({ user: s.user_id }, { type: 'subscription', action: 'updated', subscription: await buildSubscription(s, fresh) });
  }
}

// ---------- Edição / exclusão ----------

function minutesSince(ts: string) {
  return (Date.now() - new Date(ts).getTime()) / 60000;
}

export async function updateMessage(ctx: Ctx, msgId: string, text: string, rid?: string) {
  const m = await getMessageRow(msgId);
  if (!m || (rid && m.room_id !== rid)) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  if (m.t) throw badRequest('error-action-not-allowed', 'Mensagens de sistema não podem ser editadas.');
  if (m.extra?.sticker) throw badRequest('error-sticker-not-editable', 'Figurinhas não podem ser editadas.');
  const roles = await getUserRoles(ctx.userId, m.room_id);
  const canEditAny = rolesHavePermission(roles, 'edit-message');
  const own = m.user_id === ctx.userId;
  if (!canEditAny) {
    if (!getSetting('Message_AllowEditing') || !own) throw forbidden('Você não pode editar esta mensagem.');
    const block = getSetting<number>('Message_AllowEditing_BlockEditInMinutes');
    if (block > 0 && minutesSince(m.created_at) > block && !rolesHavePermission(roles, 'bypass-time-limit-edit-and-delete'))
      throw forbidden('O tempo para editar esta mensagem expirou.');
  }
  const max = getSetting<number>('Message_MaxAllowedSize');
  const msg = filterBadWords(text.trim());
  if (msg.length > max) throw badRequest('error-message-size-exceeded', `A mensagem excede ${max} caracteres.`);
  const room = await getRoom(m.room_id);
  await assertCanWrite(ctx, room, roles);
  if (getSetting('Message_KeepHistory')) {
    await query('INSERT INTO message_history (message_id, room_id, msg, edited_by) VALUES ($1,$2,$3,$4)', [m.id, m.room_id, m.msg, ctx.userId]);
  }
  const { mentions, channels } = await parseMentions(msg, room);
  const row = await one(
    `UPDATE messages SET msg = $2, mentions = $3, channels = $4, edited_at = now(), edited_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [m.id, msg, JSON.stringify(mentions), JSON.stringify(channels), JSON.stringify({ _id: ctx.userId, username: ctx.username })],
  );
  if (room.last_message?._id === m.id) {
    await query(`UPDATE rooms SET last_message = jsonb_set(last_message, '{msg}', to_jsonb($2::text)) WHERE id = $1`, [room.id, truncate(msg, 200)]);
  }
  if (!own) await audit(actorOf(ctx), 'message.edited', { rid: m.room_id, msgId: m.id, author: m.username });
  const message = withExtra(row);
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message });
  emit('message.updated', { room, message });
  return message;
}

export async function deleteMessage(ctx: Ctx, msgId: string, opts: { asAdmin?: boolean } = {}) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  const roles = await getUserRoles(ctx.userId, m.room_id);
  const own = m.user_id === ctx.userId;
  const canAny = rolesHavePermission(roles, 'delete-message') || rolesHavePermission(roles, 'force-delete-message');
  if (!canAny && !opts.asAdmin) {
    if (!own || !getSetting('Message_AllowDeleting') || !rolesHavePermission(roles, 'delete-own-message')) throw forbidden('Você não pode apagar esta mensagem.');
    const block = getSetting<number>('Message_AllowDeleting_BlockDeleteInMinutes');
    if (block > 0 && minutesSince(m.created_at) > block && !rolesHavePermission(roles, 'bypass-time-limit-edit-and-delete'))
      throw forbidden('O tempo para apagar esta mensagem expirou.');
  }
  await removeMessageRow(m);
  if (!own) await audit(actorOf(ctx), 'message.deleted', { rid: m.room_id, msgId: m.id, author: m.username }, { msg: truncate(m.msg, 500) });
}

export async function removeMessageRow(m: any) {
  const { deleteFilesOfMessage } = await import('./uploads');
  await deleteFilesOfMessage(m.id);
  if (m.tcount > 0) {
    // Raiz de thread com respostas: mantém o lugar como "mensagem removida", sem o pedido de "Ciente" nem as confirmações.
    const row = await one(
      `UPDATE messages SET msg = '', t = 'rm', attachments = '[]', files = '[]', reactions = '{}', ack_required = false, ack_count = 0,
         -- Integrações (Jira/Teams): mensagem removida não guarda cartão
         extra = extra - 'sticker' - 'jira' - 'meeting' - 'bridge', sticker_file_id = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [m.id],
    );
    if (m.ack_required) await query('UPDATE message_reads SET ack_at = NULL WHERE message_id = $1 AND ack_at IS NOT NULL', [m.id]);
    bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
  } else {
    await query('DELETE FROM messages WHERE id = $1', [m.id]);
    bus.publish({ room: m.room_id }, { type: 'message.deleted', rid: m.room_id, _id: m.id, tmid: m.tmid });
  }
  if (m.tmid) {
    const parent = await one(
      `UPDATE messages SET tcount = GREATEST(tcount - 1, 0),
         tlm = (SELECT max(created_at) FROM messages WHERE tmid = $1), updated_at = now() WHERE id = $1 RETURNING *`,
      [m.tmid],
    );
    if (parent) bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(parent) });
  }
  // Recalcula a última mensagem da sala, se necessário.
  const room = await getRoom(m.room_id);
  if (room?.last_message?._id === m.id) {
    const last = await one(`SELECT * FROM messages WHERE room_id = $1 AND t IS NULL AND (tmid IS NULL OR extra->>'tshow' = 'true') ORDER BY created_at DESC LIMIT 1`, [m.room_id]);
    const lm = last ? { _id: last.id, msg: truncate(last.msg || (last.extra?.sticker ? stickerPreviewText(last.extra.sticker) : ''), 200), u: { _id: last.user_id, username: last.username, name: last.user_name }, ts: last.created_at } : null;
    await query('UPDATE rooms SET last_message = $2, updated_at = now() WHERE id = $1', [m.room_id, lm ? JSON.stringify(lm) : null]);
    await notifyRoomUpdated(m.room_id);
  }
}

// Integrações (Jira/Teams): grava ou remove uma chave de extra sem marcar a mensagem como editada (prévias, cartões).
export async function setMessageExtra(msgId: string, key: 'jira' | 'meeting' | 'bridge' | 'jiraNoPreview', value: unknown) {
  const row =
    value === null || value === undefined
      ? await one(`UPDATE messages SET extra = extra - $2, updated_at = now() WHERE id = $1 RETURNING *`, [msgId, key])
      : await one(`UPDATE messages SET extra = jsonb_set(extra, ARRAY[$2::text], $3::jsonb), updated_at = now() WHERE id = $1 RETURNING *`, [msgId, key, JSON.stringify(value)]);
  if (row) bus.publish({ room: row.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
  return row;
}

// Integrações (Jira/Teams): edição espelhada de outro sistema (Teams). Sem as regras de tempo de edição, sem menções.
export async function replaceMessageText(msgId: string, text: string, editor: { id: string; username: string }, extra: Record<string, unknown> = {}) {
  const m = await getMessageRow(msgId);
  if (!m || m.t) return null;
  const msg = filterBadWords(text.trim()).slice(0, getSetting<number>('Message_MaxAllowedSize'));
  if (getSetting('Message_KeepHistory')) {
    await query('INSERT INTO message_history (message_id, room_id, msg, edited_by) VALUES ($1,$2,$3,$4)', [m.id, m.room_id, m.msg, editor.id]);
  }
  const row = await one(
    `UPDATE messages SET msg = $2, mentions = '[]', channels = '[]', extra = extra || $4::jsonb, edited_at = now(), edited_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [m.id, msg, JSON.stringify({ _id: editor.id, username: editor.username }), JSON.stringify(extra)],
  );
  const room = await getRoom(m.room_id);
  if (room?.last_message?._id === m.id) {
    await query(`UPDATE rooms SET last_message = jsonb_set(last_message, '{msg}', to_jsonb($2::text)) WHERE id = $1`, [room.id, truncate(msg, 200)]);
  }
  const message = withExtra(row);
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message });
  emit('message.updated', { room, message });
  return message;
}

// ---------- Reações, fixar, favoritar ----------

// Os shortcodes que a web desenha como emoji (as chaves de EMOJI em web/src/lib/emoji.ts; um teste confere que são as mesmas).
export const STANDARD_EMOJI = new Set(
  (
    '100 smile smiley grinning blush wink heart_eyes kissing_heart relaxed joy rofl sweat_smile laughing innocent slight_smile upside_down yum ' +
    'stuck_out_tongue stuck_out_tongue_winking_eye sunglasses nerd thinking neutral_face expressionless no_mouth smirk unamused rolling_eyes ' +
    'grimacing relieved pensive sleepy sleeping mask nauseated_face sneezing_face hot_face cold_face dizzy_face exploding_head cowboy ' +
    'partying_face confused worried slight_frown open_mouth astonished flushed pleading_face cry sob scream confounded persevere disappointed ' +
    'sweat weary tired_face yawning_face triumph rage angry skull poop clown ghost alien robot smiley_cat see_no_evil hear_no_evil speak_no_evil ' +
    'hugging shushing_face zipper_mouth money_mouth star_struck face_with_monocle saluting_face melting_face wave raised_hand ok_hand v ' +
    'crossed_fingers metal call_me point_left point_right point_up point_down thumbsup +1 thumbsdown -1 fist punch clap raised_hands open_hands ' +
    'handshake pray muscle writing_hand eyes brain heart orange_heart yellow_heart green_heart blue_heart purple_heart black_heart broken_heart ' +
    'two_hearts sparkling_heart heartbeat fire sparkles star star2 zap boom tada confetti_ball balloon gift trophy medal first_place rocket ' +
    'airplane car coffee beer beers wine_glass pizza hamburger cake birthday apple banana popcorn sun sunny cloud umbrella snowflake rainbow ' +
    'earth_americas moon dog cat unicorn bug bee tree seedling rose sunflower check white_check_mark heavy_check_mark x warning no_entry question ' +
    'exclamation bulb memo pencil book books calendar date clock hourglass alarm_clock bell mega loudspeaker email envelope inbox_tray ' +
    'outbox_tray package paperclip pushpin round_pushpin link lock unlock key hammer wrench gear computer keyboard iphone telephone phone ' +
    'video_camera camera tv chart_with_upwards_trend chart_with_downwards_trend bar_chart clipboard file_folder mag money_with_wings moneybag ' +
    'dollar credit_card briefcase house office hospital school checkered_flag triangular_flag_on_post flag_br soccer basketball video_game ' +
    'musical_note headphones art red_circle green_circle yellow_circle blue_circle white_circle black_circle arrow_right arrow_left arrow_up ' +
    'arrow_down repeat recycle infinity hourglass_flowing_sand stopwatch zzz speech_balloon thought_balloon dash sweat_drops droplet ok new free ' +
    'sos cool top soon'
  ).split(' '),
);

async function isKnownEmoji(key: string) {
  const name = key.slice(1, -1);
  return STANDARD_EMOJI.has(name) || !!(await one('SELECT 1 FROM custom_emoji WHERE name = $1 OR $1 = ANY(aliases)', [name]));
}

export async function react(ctx: Ctx, msgId: string, emoji: string, shouldReact?: boolean) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  const room = await loadRoomForUser(ctx, m.room_id);
  if (room.archived) throw badRequest('error-room-archived', 'Sala arquivada.');
  const reader = !!room.ro && !(await hasPermission(ctx.userId, 'post-readonly', room.id));
  if (reader && !room.react_when_ro) {
    throw forbidden(room.notice ? 'Este canal de avisos não aceita reações.' : 'Sala somente leitura.');
  }
  if (room.muted?.includes(ctx.username)) throw forbidden('Você está silenciado nesta sala.');
  await assertCanSendDirect(ctx, room);
  const key = emoji.startsWith(':') ? emoji : `:${emoji}:`;
  if (!/^:[a-z0-9_+\-]{1,64}:$/i.test(key)) throw badRequest('error-invalid-emoji', 'Emoji inválido.');
  const reactions = m.reactions ?? {};
  const users: string[] = reactions[key]?.usernames ?? [];
  const has = users.includes(ctx.username);
  const add = shouldReact ?? !has;
  if (add === has) return withExtra(m);
  // Em sala somente leitura a reação é a única voz de quem lê: reação nova só com emoji de verdade, nunca texto livre.
  if (add && reader && !users.length && !(await isKnownEmoji(key))) throw badRequest('error-invalid-emoji', 'Escolha um emoji da lista para reagir.');
  if (add) reactions[key] = { usernames: [...users, ctx.username] };
  else {
    const rest = users.filter((u) => u !== ctx.username);
    if (rest.length) reactions[key] = { usernames: rest };
    else delete reactions[key];
  }
  const row = await one('UPDATE messages SET reactions = $2, updated_at = now() WHERE id = $1 RETURNING *', [m.id, JSON.stringify(reactions)]);
  const message = withExtra(row);
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message });
  return message;
}

export async function setPinned(ctx: Ctx, msgId: string, pinned: boolean) {
  if (!getSetting('Message_AllowPinning')) throw forbidden('Fixar mensagens está desativado.');
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  const room = await loadRoomForUser(ctx, m.room_id);
  // Em DMs, qualquer participante pode fixar.
  if (room.t !== 'd' && !(await hasPermission(ctx.userId, 'pin-message', m.room_id))) throw forbidden();
  if (m.pinned === pinned) return withExtra(m);
  const row = await one(
    `UPDATE messages SET pinned = $2, pinned_at = CASE WHEN $2 THEN now() ELSE NULL END, pinned_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [m.id, pinned, pinned ? JSON.stringify({ _id: ctx.userId, username: ctx.username }) : null],
  );
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
  if (pinned) {
    await sendSystemMessage(m.room_id, 'message_pinned', { id: ctx.userId, username: ctx.username }, '', {
      attachments: [{ text: m.msg || (m.extra?.sticker ? stickerPreviewText(m.extra.sticker, { withName: false }) : ''), author_name: m.username, ts: m.created_at, message_link: `/msg/${m.id}` }],
      pinnedMessageId: m.id,
    });
  }
  return withExtra(row);
}

export async function setStarred(ctx: Ctx, msgId: string, starred: boolean) {
  if (!getSetting('Message_AllowStarring')) throw forbidden('Favoritar mensagens está desativado.');
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  await loadRoomForUser(ctx, m.room_id);
  const row = await one(
    starred
      ? 'UPDATE messages SET starred = array_append(array_remove(starred, $2), $2), updated_at = now() WHERE id = $1 RETURNING *'
      : 'UPDATE messages SET starred = array_remove(starred, $2), updated_at = now() WHERE id = $1 RETURNING *',
    [m.id, ctx.userId],
  );
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
  return withExtra(row);
}

export async function followThread(ctx: Ctx, msgId: string, follow: boolean) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  await loadRoomForUser(ctx, m.room_id);
  const row = await one(
    follow
      ? 'UPDATE messages SET replies = array_append(array_remove(replies, $2), $2), updated_at = now() WHERE id = $1 RETURNING *'
      : 'UPDATE messages SET replies = array_remove(replies, $2), updated_at = now() WHERE id = $1 RETURNING *',
    [m.id, ctx.userId],
  );
  if (!follow) {
    const sub = await one(`UPDATE subscriptions SET tunread = array_remove(tunread, $3), updated_at = now() WHERE room_id = $1 AND user_id = $2 RETURNING *`, [
      m.room_id,
      ctx.userId,
      m.id,
    ]);
    if (sub) {
      const { notifySubscription } = await import('./rooms');
      await notifySubscription(ctx.userId, m.room_id, 'updated', sub);
    }
  }
  bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
}

// ---------- Leitura ----------

export async function getMessage(ctx: Ctx, msgId: string) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  await loadRoomForUser(ctx, m.room_id);
  return withExtra(m);
}

export async function history(ctx: Ctx, rid: string, opts: { latest?: string; oldest?: string; count?: number; inclusive?: boolean; showThreadMessages?: boolean }) {
  await loadRoomForUser(ctx, rid);
  const params: unknown[] = [rid];
  const w: string[] = ['room_id = $1'];
  if (!opts.showThreadMessages) w.push(`(tmid IS NULL OR extra->>'tshow' = 'true')`);
  const op = opts.inclusive ? '=' : '';
  if (opts.latest) w.push(`created_at <${op} $${params.push(opts.latest)}`);
  if (opts.oldest) w.push(`created_at >${op} $${params.push(opts.oldest)}`);
  const count = Math.min(opts.count ?? 50, 200);
  const order = opts.oldest && !opts.latest ? 'ASC' : 'DESC';
  const rows = await many(`SELECT * FROM messages WHERE ${w.join(' AND ')} ORDER BY created_at ${order} LIMIT ${count}`, params);
  if (order === 'ASC') rows.reverse();
  return rows.map(withExtra);
}

export async function messagesAround(ctx: Ctx, msgId: string, count = 30) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  await loadRoomForUser(ctx, m.room_id);
  const before = await many(
    `SELECT * FROM messages WHERE room_id = $1 AND (tmid IS NULL OR extra->>'tshow' = 'true') AND created_at <= $2 ORDER BY created_at DESC LIMIT $3`,
    [m.room_id, m.created_at, count],
  );
  const after = await many(
    `SELECT * FROM messages WHERE room_id = $1 AND (tmid IS NULL OR extra->>'tshow' = 'true') AND created_at > $2 ORDER BY created_at ASC LIMIT $3`,
    [m.room_id, m.created_at, count],
  );
  return [...after.reverse(), ...before].map(withExtra);
}

export async function syncMessages(ctx: Ctx, rid: string, since: string) {
  await loadRoomForUser(ctx, rid);
  const rows = await many('SELECT * FROM messages WHERE room_id = $1 AND updated_at > $2 ORDER BY created_at DESC LIMIT 500', [rid, since]);
  return { updated: rows.map(withExtra), deleted: [] as { _id: string }[] };
}

export async function threadMessages(ctx: Ctx, tmid: string, opts: { offset?: number; count?: number } = {}) {
  const root = await getMessageRow(tmid);
  if (!root) throw notFound('error-message-not-found', 'Thread não encontrada.');
  await loadRoomForUser(ctx, root.room_id);
  const rows = await many(
    `SELECT *, count(*) OVER() AS total FROM messages WHERE tmid = $1 ORDER BY created_at ASC LIMIT ${Math.min(opts.count ?? 100, 500)} OFFSET ${Number(opts.offset ?? 0)}`,
    [tmid],
  );
  // Ler a thread a remove das não lidas.
  const sub = await one(`UPDATE subscriptions SET tunread = array_remove(tunread, $3), updated_at = now() WHERE room_id = $1 AND user_id = $2 AND $3 = ANY(tunread) RETURNING *`, [
    root.room_id,
    ctx.userId,
    tmid,
  ]);
  if (sub) {
    const { notifySubscription } = await import('./rooms');
    await notifySubscription(ctx.userId, root.room_id, 'updated', sub);
  }
  return { total: Number(rows[0]?.total ?? 0), messages: rows.map(withExtra) };
}

export async function threadsList(ctx: Ctx, rid: string, opts: { type?: 'all' | 'following' | 'unread'; text?: string; offset?: number; count?: number }) {
  await loadRoomForUser(ctx, rid);
  const params: unknown[] = [rid];
  const w = ['room_id = $1', 'tcount > 0'];
  if (opts.type === 'following') w.push(`$${params.push(ctx.userId)} = ANY(replies)`);
  if (opts.type === 'unread') {
    const sub = await getSubscriptionRow(rid, ctx.userId);
    w.push(`id = ANY($${params.push(sub?.tunread ?? [])})`);
  }
  if (opts.text) w.push(`msg ILIKE $${params.push(`%${opts.text}%`)}`);
  const rows = await many(
    `SELECT *, count(*) OVER() AS total FROM messages WHERE ${w.join(' AND ')} ORDER BY tlm DESC LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return { total: Number(rows[0]?.total ?? 0), threads: rows.map(withExtra) };
}

export async function listByFlag(ctx: Ctx, rid: string, flag: 'pinned' | 'starred' | 'mentions', opts: { offset?: number; count?: number }) {
  await loadRoomForUser(ctx, rid);
  const params: unknown[] = [rid];
  const w = ['room_id = $1', 't IS NULL'];
  if (flag === 'pinned') w.push('pinned');
  if (flag === 'starred') w.push(`$${params.push(ctx.userId)} = ANY(starred)`);
  if (flag === 'mentions') w.push(`mentions @> $${params.push(JSON.stringify([{ _id: ctx.userId }]))}::jsonb`);
  const rows = await many(
    `SELECT *, count(*) OVER() AS total FROM messages WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return { total: Number(rows[0]?.total ?? 0), messages: rows.map(withExtra) };
}

// Busca com operadores: from:@user, has:file|link|star|pin, is:pinned|starred|thread, before:AAAA-MM-DD, after:AAAA-MM-DD, in:#canal
export async function searchMessages(ctx: Ctx, opts: { rid?: string; searchText: string; offset?: number; count?: number }) {
  let text = opts.searchText.trim();
  const params: unknown[] = [];
  const w: string[] = ['m.t IS NULL'];
  const take = (re: RegExp, fn: (v: string) => void) => {
    text = text.replace(re, (_all, v) => {
      fn(v);
      return ' ';
    });
  };
  take(/\bfrom:@?([0-9a-zA-Z._-]+)/gi, (v) => w.push(`lower(m.username) = lower($${params.push(v)})`));
  take(/\bin:#?([0-9a-zA-ZÀ-ſ._-]+)/gi, (v) => w.push(`m.room_id IN (SELECT id FROM rooms WHERE lower(name) = lower($${params.push(v)}))`));
  take(/\bbefore:(\d{4}-\d{2}-\d{2})/gi, (v) => w.push(`m.created_at < $${params.push(v)}::date`));
  take(/\bafter:(\d{4}-\d{2}-\d{2})/gi, (v) => w.push(`m.created_at >= ($${params.push(v)}::date + 1)`));
  take(/\bon:(\d{4}-\d{2}-\d{2})/gi, (v) => w.push(`m.created_at::date = $${params.push(v)}::date`));
  take(/\b(?:has|is):(file|link|star|starred|pin|pinned|thread|mention)\b/gi, (v) => {
    const k = v.toLowerCase();
    if (k === 'file') w.push(`jsonb_array_length(m.files) > 0`);
    if (k === 'link') w.push(`m.msg ~* 'https?://'`);
    if (k === 'star' || k === 'starred') w.push(`$${params.push(ctx.userId)} = ANY(m.starred)`);
    if (k === 'pin' || k === 'pinned') w.push('m.pinned');
    if (k === 'thread') w.push('m.tcount > 0');
    if (k === 'mention') w.push(`m.mentions @> $${params.push(JSON.stringify([{ _id: ctx.userId }]))}::jsonb`);
  });
  text = text.replace(/\s+/g, ' ').trim();
  if (opts.rid) {
    await loadRoomForUser(ctx, opts.rid);
    w.push(`m.room_id = $${params.push(opts.rid)}`);
  } else {
    w.push(`m.room_id IN (SELECT room_id FROM subscriptions WHERE user_id = $${params.push(ctx.userId)})`);
  }
  let rank = 'm.created_at';
  if (text) {
    const isRegex = /^\/.+\/$/.test(text);
    if (isRegex) {
      w.push(`m.msg ~* $${params.push(text.slice(1, -1))}`);
    } else {
      // Busca textual com prefixo em cada termo + fallback por substring.
      const terms = text
        .split(' ')
        .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
        .filter(Boolean);
      if (terms.length) {
        const tsq = terms.map((t) => `${t}:*`).join(' & ');
        w.push(`(m.search @@ to_tsquery('simple', $${params.push(tsq)}) OR m.msg ILIKE $${params.push(`%${text}%`)})`);
      }
    }
  }
  const count = Math.min(opts.count ?? 25, 100);
  const rows = await many(
    `SELECT m.*, count(*) OVER() AS total FROM messages m WHERE ${w.join(' AND ')} ORDER BY ${rank} DESC LIMIT ${count} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  ).catch((e) => {
    if (String(e.message).includes('regular expression')) throw badRequest('error-invalid-regex', 'Expressão regular inválida.');
    throw e;
  });
  return { total: Number(rows[0]?.total ?? 0), messages: rows.map(withExtra) };
}

export async function messageHistory(ctx: Ctx, msgId: string) {
  const m = await getMessageRow(msgId);
  if (!m) throw notFound('error-message-not-found', 'Mensagem não encontrada.');
  await loadRoomForUser(ctx, m.room_id);
  return many('SELECT msg, edited_by, created_at FROM message_history WHERE message_id = $1 ORDER BY id', [msgId]);
}

// ---------- Discussões ----------

export async function createDiscussion(ctx: Ctx, input: { prid: string; pmid?: string; t_name: string; users?: string[]; reply?: string; encrypted?: boolean; topic?: string }) {
  if (!getSetting('Discussion_enabled')) throw badRequest('error-discussions-disabled', 'Discussões estão desativadas.');
  const parent = await loadRoomForUser(ctx, input.prid);
  if (!(await hasPermission(ctx.userId, 'start-discussion', parent.id)) && !(await hasPermission(ctx.userId, 'start-discussion-other-user', parent.id)))
    throw forbidden();
  if (parent.prid) throw badRequest('error-nested-discussion', 'Não é possível criar uma discussão dentro de outra.');
  // A discussão publica o nome na sala de origem (e numa DM junta os mesmos participantes): valem as regras de envio dela.
  await assertCanWrite(ctx, parent);
  let pm: any = null;
  if (input.pmid) {
    pm = await getMessageRow(input.pmid);
    if (!pm || pm.room_id !== parent.id) throw badRequest('error-invalid-message', 'Mensagem de origem inválida.');
    if (pm.drid) throw badRequest('error-discussion-exists', 'Esta mensagem já tem uma discussão.');
  }
  const name = input.t_name.trim();
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome da discussão.');
  const { createRoom, addUserToRoom } = await import('./rooms');
  const type = parent.t === 'c' ? 'c' : 'p';
  const room = await createRoom(ctx, {
    type,
    name: newId(),
    fname: name,
    prid: parent.id,
    pmid: input.pmid ?? null,
    members: input.users,
    encrypted: input.encrypted,
    topic: input.topic ?? parent.fname ?? parent.name ?? '',
    skipPermission: true,
  });
  // Em DMs, todos os participantes entram na discussão.
  if (parent.t === 'd') for (const uid of parent.uids) await addUserToRoom(room.id, uid, { silent: true });
  const sys = await sendSystemMessage(parent.id, 'discussion-created', { id: ctx.userId, username: ctx.username }, name, { drid: room.id });
  if (pm) {
    const row = await one('UPDATE messages SET drid = $2, dcount = 0, dlm = now(), updated_at = now() WHERE id = $1 RETURNING *', [pm.id, room.id]);
    bus.publish({ room: parent.id }, { type: 'message', action: 'updated', message: withExtra(row) });
  } else {
    await query('UPDATE messages SET drid = $2 WHERE id = $1', [sys.id, room.id]);
  }
  if (input.reply) await sendMessage(ctx, { rid: room.id, msg: input.reply }, { skipCommands: true });
  return room;
}

export async function listDiscussions(ctx: Ctx, rid: string, opts: { text?: string; offset?: number; count?: number }) {
  await loadRoomForUser(ctx, rid);
  const rows = await many(
    `SELECT r.*, count(*) OVER() AS total FROM rooms r WHERE r.prid = $1 AND coalesce(r.fname, '') ILIKE $2 ORDER BY r.lm DESC NULLS LAST, r.created_at DESC
     LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    [rid, `%${opts.text ?? ''}%`],
  );
  const { mapRoom } = await import('./mappers');
  return { total: Number(rows[0]?.total ?? 0), discussions: rows.map(mapRoom) };
}

// Ao enviar numa discussão, atualiza o contador na mensagem de origem.
export async function bumpDiscussionCounter(room: any) {
  if (!room.prid || !room.pmid) return;
  const row = await one('UPDATE messages SET dcount = dcount + 1, dlm = now(), updated_at = now() WHERE id = $1 RETURNING *', [room.pmid]);
  if (row) bus.publish({ room: row.room_id }, { type: 'message', action: 'updated', message: withExtra(row) });
}

export async function cleanHistory(
  ctx: Ctx,
  rid: string,
  opts: { latest: string; oldest: string; inclusive?: boolean; excludePinned?: boolean; filesOnly?: boolean; users?: string[]; limit?: number },
) {
  if (!(await hasPermission(ctx.userId, 'clean-channel-history', rid))) throw forbidden();
  const { pruneMessages } = await import('./retention');
  const n = await pruneMessages(rid, opts);
  await audit(actorOf(ctx), 'room.history.cleaned', { rid }, { ...opts, count: n });
  return n;
}

export { canAccessRoom, ApiError };
