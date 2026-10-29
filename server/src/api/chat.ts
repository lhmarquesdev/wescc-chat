import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden } from '../lib/errors';
import { newId } from '../lib/ids';
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
  updateMessage,
} from '../services/messages';
import { ackMessage, assertCanSeeReceipts, listAcks, myAcks } from '../services/notices';
import { getReadReceipts } from '../services/reads';
import { getRoomByName, loadRoomForUser, resolveRoom } from '../services/rooms';
import { assertCanUpload, getFileForUser, getFileForVisitor, inlineMimeType, listRoomFiles, readUpload, safeMimeType, saveUpload } from '../services/uploads';
import { b, bool, paging, q, route, str } from './http';

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
    await query('INSERT INTO moderation_reports (id, message_id, room_id, reported_user_id, reporter_id, description) VALUES ($1,$2,$3,$4,$5,$6)', [
      newId(),
      m.id,
      m.room_id,
      m.user_id,
      ctx.userId,
      String(body.description ?? '').slice(0, 1000),
    ]);
    return {};
  });
  route(app, 'POST', 'moderation.reportUser', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await query('INSERT INTO moderation_reports (id, reported_user_id, reporter_id, description) VALUES ($1,$2,$3,$4)', [
      newId(),
      str(body.userId, 'userId'),
      ctx.userId,
      String(body.description ?? '').slice(0, 1000),
    ]);
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
    await assertCanUpload(ctx, rid);
    const { file, fields } = await readUpload(req);
    if (!file) throw badRequest('error-invalid-params', 'Nenhum arquivo enviado.');
    return { message: await saveUpload(ctx, rid, file, fields) };
  };
  route(app, 'POST', 'rooms.upload/:rid', {}, uploadHandler);
  route(app, 'POST', 'rooms.media/:rid', {}, uploadHandler);

  // O widget do livechat baixa com o cabeçalho x-visitor-token (nunca na URL).
  const fileForRequest = async (req: any) => {
    const visitorToken = String(req.headers['x-visitor-token'] ?? '');
    if (!visitorToken) return getFileForUser(req.ctx, req.params.id);
    try {
      return await getFileForVisitor(visitorToken, req.params.id);
    } catch (e) {
      if (!req.ctx) throw e;
      return getFileForUser(req.ctx, req.params.id);
    }
  };
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
  route(app, 'POST', 'emoji-custom.create', { permissions: ['manage-emoji'] }, async (req) => {
    let name = '';
    let aliases: string[] = [];
    let data: Buffer | null = null;
    let type = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        data = await part.toBuffer();
        type = part.mimetype;
      } else if (part.fieldname === 'name') name = String(part.value);
      else if (part.fieldname === 'aliases') aliases = String(part.value).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (!/^[a-z0-9_+-]{1,40}$/i.test(name)) throw badRequest('error-invalid-emoji-name', 'Nome de emoji inválido.');
    if (!data || !/^image\/(png|gif|jpeg|webp)$/.test(type)) throw badRequest('error-invalid-image', 'Imagem inválida.');
    if (await one('SELECT 1 FROM custom_emoji WHERE name = $1', [name])) throw badRequest('error-emoji-exists', 'Já existe um emoji com esse nome.');
    await query('INSERT INTO custom_emoji (id, name, aliases, content_type, data) VALUES ($1,$2,$3,$4,$5)', [newId(), name, aliases, type, data]);
    const { bus } = await import('../realtime/bus');
    bus.publish({ all: true }, { type: 'settings.changed', settings: [{ _id: '__emoji', value: Date.now() }] });
    return {};
  });
  route(app, 'POST', 'emoji-custom.delete', { permissions: ['manage-emoji'] }, async (req) => {
    await query('DELETE FROM custom_emoji WHERE id = $1', [str(b(req).emojiId, 'emojiId')]);
    return {};
  });
  app.get('/emoji-custom/:name', async (req: any, reply) => {
    const name = String(req.params.name).replace(/\.[a-z]+$/, '');
    const e = await one('SELECT content_type, data FROM custom_emoji WHERE name = $1 OR $1 = ANY(aliases)', [name]);
    if (!e) return reply.status(404).send();
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.type(e.content_type).send(e.data);
  });
  void forbidden;
}
