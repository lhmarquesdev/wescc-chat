import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { probeImage, sniffMime } from '@shared/imageProbe';
import { audit } from '../services/audit';
import { listCommands, runSlashCommand } from '../services/commands';
import {
  deleteMessage,
  followThread,
  getMessage,
  getMessageRow,
  history,
  listByFlag,
  messageHistory,
  messagesAround,
  react,
  searchMessages,
  sendMessage,
  setPinned,
  setStarred,
  syncMessages,
  threadMessages,
  threadsList,
  STANDARD_EMOJI,
  updateMessage,
} from '../services/messages';
import { ackMessage, assertCanSeeReceipts, listAcks, myAcks } from '../services/notices';
import { getReadReceipts } from '../services/reads';
import { getRoomByName, loadRoomForUser, resolveRoom } from '../services/rooms';
import { assertCanUpload, getFileForUser, inlineMimeType, listRoomFiles, readUpload, safeMimeType, saveUpload } from '../services/uploads';
import { actorOf } from '../services/users';
import { b, bool, paging, q, route, str } from './http';

// Emojis personalizados: o nome segue a regra do :código: das mensagens; o arquivo fica no banco e todo mundo o baixa.
const EMOJI_NAME = /^[a-z0-9_+-]{1,40}$/;
const EMOJI_MAX_KB = 256;
const EMOJI_MAX_ALIASES = 10;

// O motivo da denúncia é obrigatório (a moderação precisa saber o que houve).
function reportReason(v: unknown) {
  const text = String(v ?? '').trim();
  if (text.length < 3) throw badRequest('error-report-reason', 'Informe o motivo da denúncia.');
  return text.slice(0, 1000);
}

export function chatRoutes(app: FastifyInstance) {
  route(app, 'POST', 'chat.sendMessage', {}, async (req, _rep, ctx) => {
    const m = b(req).message ?? {};
    const out = await sendMessage(ctx, {
      _id: m._id,
      rid: str(m.rid, 'message.rid'),
      msg: m.msg,
      tmid: m.tmid,
      tshow: !!m.tshow,
      attachments: m.attachments,
      alias: m.alias,
      emoji: m.emoji,
      avatar: m.avatar,
      customFields: m.customFields,
      ackRequired: !!bool(m.ackRequired),
      // Conversa criptografada: o texto vai cifrado e as menções vêm da web.
      e2e: m.e2e,
      e2eMentions: Array.isArray(m.e2eMentions) ? m.e2eMentions.map(String) : undefined,
    });
    return { message: out };
  });
  // Compatível com chat.postMessage do Rocket.Chat (integrações e bots).
  route(app, 'POST', 'chat.postMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    let rid = body.roomId;
    if (!rid && body.channel) {
      const ch = String(body.channel);
      if (ch.startsWith('@')) {
        const { createDirect } = await import('../services/rooms');
        rid = (await createDirect(ctx, [ch.slice(1)])).id;
      } else {
        const r = await getRoomByName(ch.replace(/^#/, ''));
        if (!r) throw badRequest('error-room-not-found', 'Canal não encontrado.');
        rid = r.id;
      }
    }
    const out = await sendMessage(ctx, { rid: str(rid, 'roomId'), msg: body.text, attachments: body.attachments, alias: body.alias, emoji: body.emoji, avatar: body.avatar, tmid: body.tmid });
    return { ts: Date.now(), channel: body.channel, message: out };
  });
  route(app, 'POST', 'chat.update', {}, async (req, _rep, ctx) => {
    const body = b(req);
    if (body.e2e) {
      const mentions = Array.isArray(body.e2eMentions) ? body.e2eMentions.map(String) : undefined;
      return { message: await updateMessage(ctx, str(body.msgId, 'msgId'), '', body.roomId, { envelope: body.e2e, mentions }) };
    }
    return { message: await updateMessage(ctx, str(body.msgId, 'msgId'), str(body.text, 'text'), body.roomId) };
  });
  route(app, 'POST', 'chat.delete', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await deleteMessage(ctx, str(body.msgId, 'msgId'), {});
    return { _id: body.msgId, ts: Date.now() };
  });
  route(app, 'POST', 'chat.react', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await react(ctx, str(body.messageId, 'messageId'), str(body.emoji ?? body.reaction, 'emoji'), bool(body.shouldReact));
    return {};
  });
  route(app, 'POST', 'chat.pinMessage', {}, async (req, _rep, ctx) => ({ message: await setPinned(ctx, str(b(req).messageId, 'messageId'), true) }));
  route(app, 'POST', 'chat.unPinMessage', {}, async (req, _rep, ctx) => {
    await setPinned(ctx, str(b(req).messageId, 'messageId'), false);
    return {};
  });
  route(app, 'POST', 'chat.starMessage', {}, async (req, _rep, ctx) => {
    await setStarred(ctx, str(b(req).messageId, 'messageId'), true);
    return {};
  });
  route(app, 'POST', 'chat.unStarMessage', {}, async (req, _rep, ctx) => {
    await setStarred(ctx, str(b(req).messageId, 'messageId'), false);
    return {};
  });
  route(app, 'POST', 'chat.followMessage', {}, async (req, _rep, ctx) => {
    await followThread(ctx, str(b(req).mid, 'mid'), true);
    return {};
  });
  route(app, 'POST', 'chat.unfollowMessage', {}, async (req, _rep, ctx) => {
    await followThread(ctx, str(b(req).mid, 'mid'), false);
    return {};
  });
  route(app, 'GET', 'chat.getMessage', {}, async (req, _rep, ctx) => ({ message: await getMessage(ctx, str(q(req).msgId, 'msgId')) }));
  route(app, 'GET', 'chat.getMessageHistory', {}, async (req, _rep, ctx) => ({ history: await messageHistory(ctx, str(q(req).msgId, 'msgId')) }));
  route(app, 'GET', 'chat.getMessagesAround', {}, async (req, _rep, ctx) => ({ messages: await messagesAround(ctx, str(q(req).msgId, 'msgId'), Number(q(req).count ?? 30)) }));

  for (const prefix of ['channels', 'groups', 'im', 'rooms'] as const) {
    route(app, 'GET', `${prefix}.history`, {}, async (req, _rep, ctx) => {
      const query = q(req);
      const room = await resolveRoom(query);
      const messages = await history(ctx, room.id, {
        latest: query.latest,
        oldest: query.oldest,
        count: Number(query.count ?? 50),
        inclusive: query.inclusive === 'true',
        showThreadMessages: query.showThreadMessages === 'true',
      });
      return { messages };
    });
    route(app, 'GET', `${prefix}.files`, {}, async (req, _rep, ctx) => {
      const query = q(req);
      const room = await resolveRoom(query);
      const p = paging(query);
      const r = await listRoomFiles(ctx, room.id, { ...p, type: query.typeGroup, name: query.name });
      return { ...r, count: r.files.length, offset: p.offset };
    });
  }
  route(app, 'GET', 'chat.syncMessages', {}, async (req, _rep, ctx) => ({ result: await syncMessages(ctx, str(q(req).roomId, 'roomId'), str(q(req).lastUpdate, 'lastUpdate')) }));
  route(app, 'GET', 'chat.getThreadMessages', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await threadMessages(ctx, str(q(req).tmid, 'tmid'), { offset: p.offset, count: Number(q(req).count ?? 200) });
    return { ...r, count: r.messages.length, offset: p.offset };
  });
  route(app, 'GET', 'chat.getThreadsList', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await threadsList(ctx, str(q(req).rid, 'rid'), { ...p, type: q(req).type as any, text: q(req).text });
    return { ...r, count: r.threads.length, offset: p.offset };
  });
  for (const [path, flag] of [
    ['chat.getPinnedMessages', 'pinned'],
    ['chat.getStarredMessages', 'starred'],
    ['chat.getMentionedMessages', 'mentions'],
  ] as const) {
    route(app, 'GET', path, {}, async (req, _rep, ctx) => {
      const p = paging(q(req));
      const r = await listByFlag(ctx, str(q(req).roomId, 'roomId'), flag, p);
      return { ...r, count: r.messages.length, offset: p.offset };
    });
  }
  route(app, 'GET', 'chat.search', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await searchMessages(ctx, { rid: q(req).roomId || undefined, searchText: str(q(req).searchText, 'searchText'), ...p });
    return { ...r, count: r.messages.length, offset: p.offset };
  });
  route(app, 'GET', 'chat.getMessageReadReceipts', {}, async (req, _rep, ctx) => {
    const messageId = str(q(req).messageId, 'messageId');
    const receipts = await getReadReceipts(ctx, messageId);
    await assertCanSeeReceipts(ctx, messageId);
    return { receipts };
  });

  // ---------- "Ciente" nos canais de avisos ----------
  route(app, 'POST', 'chat.ack', {}, async (req, _rep, ctx) => ackMessage(ctx, str(b(req).messageId, 'messageId')));
  route(app, 'GET', 'chat.getAcks', {}, async (req, _rep, ctx) => {
    const query = q(req);
    const status = query.status ?? 'acked';
    if (status !== 'acked' && status !== 'pending') throw badRequest('error-invalid-params', 'status deve ser "acked" ou "pending".');
    const p = paging(query);
    return listAcks(ctx, str(query.messageId, 'messageId'), { status, offset: p.offset, count: p.count });
  });
  route(app, 'GET', 'chat.myAcks', {}, async (req, _rep, ctx) => myAcks(ctx, str(q(req).roomId, 'roomId')));
  route(app, 'POST', 'chat.reportMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const m = await getMessageRow(str(body.messageId, 'messageId'));
    if (!m) throw badRequest('error-message-not-found', 'Mensagem não encontrada.');
    await loadRoomForUser(ctx, m.room_id);
    const description = reportReason(body.description);
    if (m.user_id === ctx.userId) throw badRequest('error-report-own', 'Você não pode denunciar a sua própria mensagem.');
    // Uma denúncia aberta por pessoa e mensagem (índice único da migração 042): repetir não infla a contagem.
    const row = await one(
      `INSERT INTO moderation_reports (id, message_id, room_id, reported_user_id, reporter_id, description) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (message_id, reporter_id) WHERE NOT resolved AND message_id IS NOT NULL DO NOTHING RETURNING id`,
      [newId(), m.id, m.room_id, m.user_id, ctx.userId, description],
    );
    if (!row) throw badRequest('error-report-exists', 'Você já denunciou esta mensagem. A moderação vai analisar.');
    return {};
  });
  route(app, 'POST', 'moderation.reportUser', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const user = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [str(body.userId, 'userId')]);
    if (!user) throw notFound('error-user-not-found', 'Usuário não encontrado.');
    if (user.id === ctx.userId) throw badRequest('error-report-own', 'Você não pode denunciar a si mesmo.');
    const description = reportReason(body.description);
    const row = await one(
      `INSERT INTO moderation_reports (id, reported_user_id, reporter_id, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (reported_user_id, reporter_id) WHERE NOT resolved AND message_id IS NULL DO NOTHING RETURNING id`,
      [newId(), user.id, ctx.userId, description],
    );
    if (!row) throw badRequest('error-report-exists', 'Você já denunciou esta pessoa. A moderação vai analisar.');
    return {};
  });

  // ---------- Comandos ----------
  route(app, 'GET', 'commands.list', {}, async (_req, _rep, ctx) => {
    const commands = await listCommands(ctx);
    return { commands, count: commands.length, offset: 0, total: commands.length };
  });
  route(app, 'POST', 'commands.run', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const room = await loadRoomForUser(ctx, str(body.roomId, 'roomId'));
    const r = await runSlashCommand(ctx, room, `/${str(body.command, 'command')} ${body.params ?? ''}`.trim(), body.tmid ?? null);
    if (r === false) throw badRequest('error-command-not-found', 'Comando não encontrado.');
    return { result: r };
  });

  // ---------- Upload ----------
  const uploadHandler = async (req: any, _rep: any, ctx: any) => {
    const rid = req.params.rid;
    const room = await assertCanUpload(ctx, rid);
    const { file, fields } = await readUpload(req, { opaque: !!room.encrypted });
    if (!file) throw badRequest('error-invalid-params', 'Nenhum arquivo enviado.');
    return { message: await saveUpload(ctx, rid, file, fields) };
  };
  route(app, 'POST', 'rooms.upload/:rid', {}, uploadHandler);
  route(app, 'POST', 'rooms.media/:rid', {}, uploadHandler);

  const fileForRequest = (req: any) => getFileForUser(req.ctx, req.params.id);
  app.get('/file-upload/:id/*', async (req: any, reply) => {
    const f = await fileForRequest(req);
    // Tipo revalidado também aqui (arquivos antigos podem ter um tipo como "image/png,text/html").
    const type = safeMimeType(f.type);
    const inline = inlineMimeType(type);
    const download = q(req).download !== undefined;
    reply.header('Content-Type', type);
    reply.header('Content-Length', f.size);
    reply.header('Cache-Control', 'private, max-age=31536000');
    reply.header('X-Content-Type-Options', 'nosniff');
    // sandbox impede formulários, scripts e navegação; o visualizador de PDF do navegador não funciona com ele.
    const csp = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
    reply.header('Content-Security-Policy', type === 'application/pdf' ? csp : `${csp}; sandbox`);
    reply.header('Content-Disposition', `${inline && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(fs.createReadStream(f.absPath));
  });

  // ---------- Emojis personalizados ----------
  route(app, 'GET', 'emoji-custom.list', {}, async () => {
    const rows = await many('SELECT id, name, aliases, content_type, created_at FROM custom_emoji ORDER BY name');
    return { emojis: { update: rows.map((r) => ({ _id: r.id, name: r.name, aliases: r.aliases, extension: r.content_type.split('/')[1], _updatedAt: r.created_at })), remove: [] } };
  });
  route(app, 'POST', 'emoji-custom.create', { permissions: ['manage-emoji'] }, async (req, _rep, ctx) => {
    if (!(req as any).isMultipart?.()) throw badRequest('error-invalid-params', 'Envie o emoji como multipart/form-data.');
    let name = '';
    let aliasText = '';
    let data: Buffer | null = null;
    try {
      // Limites desta rota no lugar dos globais (1 GB): o emoji vai para o banco e é baixado inteiro por todo mundo.
      for await (const part of req.parts({ limits: { files: 1, fields: 4, parts: 5, fieldSize: 8 * 1024, fileSize: EMOJI_MAX_KB * 1024 } })) {
        if (part.type === 'file') data = await part.toBuffer();
        else if (part.fieldname === 'name') name = String(part.value ?? '');
        else if (part.fieldname === 'aliases') aliasText = String(part.value ?? '');
      }
    } catch (e) {
      const code = (e as any)?.code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new ApiError(413, 'error-emoji-too-large', `A imagem passa de ${EMOJI_MAX_KB} KB.`);
      if (e instanceof ApiError) throw e;
      throw badRequest('error-invalid-params', 'Não foi possível ler o envio do emoji. Tente de novo.');
    }
    // Nomes e apelidos em minúsculas e sem os dois-pontos: ":Logo:" e "logo" são o mesmo emoji.
    const norm = (v: string) => v.trim().replace(/^:+|:+$/g, '').toLowerCase();
    name = norm(name);
    if (!EMOJI_NAME.test(name)) throw badRequest('error-invalid-emoji-name', 'Nome de emoji inválido. Use letras minúsculas, números, _ + e -, até 40 caracteres.');
    const aliases = [...new Set(aliasText.split(',').map(norm).filter((a) => a && a !== name))];
    const badAlias = aliases.find((a) => !EMOJI_NAME.test(a));
    if (badAlias !== undefined) throw badRequest('error-invalid-emoji-alias', `Apelido inválido: "${badAlias.slice(0, 40)}". Use letras minúsculas, números, _ + e -, até 40 caracteres.`);
    if (aliases.length > EMOJI_MAX_ALIASES) throw badRequest('error-invalid-emoji-alias', `Use no máximo ${EMOJI_MAX_ALIASES} apelidos.`);
    // O arquivo tem de ser mesmo uma imagem (o tipo vem dos bytes, não do que o navegador disse).
    const type = data ? sniffMime(data) : null;
    if (!data || !type) throw badRequest('error-invalid-image', 'Imagem inválida. Use PNG, GIF, JPEG ou WebP.');
    try {
      probeImage(data, { maxFrames: 1000 });
    } catch {
      throw badRequest('error-invalid-image', 'Não foi possível ler esta imagem. O arquivo pode estar corrompido.');
    }
    // Um código vale um emoji só: nem outro nome ou apelido (sem diferença de maiúsculas) nem um emoji padrão.
    const codes = [name, ...aliases];
    const standard = codes.find((c) => STANDARD_EMOJI.has(c));
    if (standard) throw badRequest('error-emoji-exists', `:${standard}: já é um emoji padrão. Escolha outro nome ou apelido.`);
    const taken = await one<{ code: string }>(
      `SELECT c AS code FROM custom_emoji e, unnest(array_prepend(e.name, e.aliases)) c WHERE lower(c) = ANY($1) LIMIT 1`,
      [codes],
    );
    if (taken) throw badRequest('error-emoji-exists', `Já existe um emoji com o nome ou apelido :${taken.code.toLowerCase()}:.`);
    try {
      await query('INSERT INTO custom_emoji (id, name, aliases, content_type, data) VALUES ($1,$2,$3,$4,$5)', [newId(), name, aliases, type, data]);
    } catch (e: any) {
      if (e?.code === '23505') throw badRequest('error-emoji-exists', `Já existe um emoji com o nome ou apelido :${name}:.`);
      throw e;
    }
    await audit(actorOf(ctx), 'emoji.created', { name }, { aliases, size: data.length, type });
    const { bus } = await import('../realtime/bus');
    bus.publish({ all: true }, { type: 'settings.changed', settings: [{ _id: '__emoji', value: Date.now() }] });
    return {};
  });
  route(app, 'POST', 'emoji-custom.delete', { permissions: ['manage-emoji'] }, async (req, _rep, ctx) => {
    const e = await one<{ name: string }>('DELETE FROM custom_emoji WHERE id = $1 RETURNING name', [str(b(req).emojiId, 'emojiId')]);
    if (!e) throw notFound('error-emoji-not-found', 'Emoji não encontrado.');
    await audit(actorOf(ctx), 'emoji.removed', { name: e.name });
    // Quem está com o chat aberto recarrega a lista (o emoji some do seletor sem recarregar a página).
    const { bus } = await import('../realtime/bus');
    bus.publish({ all: true }, { type: 'settings.changed', settings: [{ _id: '__emoji', value: Date.now() }] });
    return {};
  });
  app.get('/emoji-custom/:name', async (req: any, reply) => {
    const name = String(req.params.name).replace(/\.[a-z]+$/, '');
    // O nome vence o apelido (instalações antigas podem ter um apelido igual ao nome de outro emoji).
    const e = await one('SELECT content_type, data, created_at FROM custom_emoji WHERE name = $1 OR $1 = ANY(aliases) ORDER BY (name = $1) DESC LIMIT 1', [name]);
    if (!e) return reply.status(404).send();
    // A web pede /emoji-custom/nome?v=<criação>: trocar a imagem (apagar e criar de novo) muda o endereço. Sem a versão
    // certa, o navegador confere de novo a cada uso, para não mostrar a imagem antiga por uma hora.
    const version = String(new Date(e.created_at).getTime());
    reply.header('Cache-Control', q(req).v === version ? 'public, max-age=31536000, immutable' : 'no-cache');
    reply.header('ETag', `"${version}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === `"${version}"`) return reply.status(304).send();
    return reply.type(e.content_type).send(e.data);
  });
  void forbidden;
}
