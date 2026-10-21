import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { VisitorClientEvent } from '@shared/index';
import { b, bool, paging, q, route, str, strArray } from '../api/http';
import { many, one } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus, type Conn } from '../realtime/bus';
import { hasPermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import { mediaTypeList, readUpload } from '../services/uploads';
import * as A from './admin';
import * as S from './service';
import { widgetHtml, widgetLoaderJs } from './widget';

const P = (req: any) => (req.params ?? {}) as Record<string, string>;
const visitorToken = (req: any) => String(req.headers['x-visitor-token'] ?? q(req).token ?? b(req).token ?? '');

async function requireVisitor(req: any) {
  const v = await S.getVisitorByToken(visitorToken(req));
  if (!v) throw notFound('error-invalid-token', 'Visitante não encontrado.');
  return v;
}

function ensureEnabled() {
  if (!getSetting<boolean>('Livechat_enabled')) throw badRequest('error-livechat-disabled', 'Atendimento desativado.');
}

export function omnichannelRoutes(app: FastifyInstance) {
  S.registerOmnichannelHooks();

  // ======================= Widget (visitante, sem login) =======================

  route(app, 'GET', 'livechat/config', { auth: false }, async (req) => {
    const enabled = getSetting<boolean>('Livechat_enabled');
    const token = visitorToken(req);
    const departmentId = q(req).department || undefined;
    const visitor = token ? await S.getVisitorByToken(token) : null;
    const open = visitor ? await S.openRoomOf(visitor.id) : null;
    const room = open ? await S.getLivechatRoomRow(open.room_id) : null;
    const departments = enabled ? (await A.listDepartments(null, { enabledOnly: true, offset: 0, count: 200 })).departments : [];
    return {
      config: {
        enabled,
        online: enabled ? await S.isOnline(departmentId ?? visitor?.department_id) : false,
        settings: {
          registrationForm: getSetting('Livechat_registration_form'),
          nameFieldRegistrationForm: getSetting('Livechat_name_field_registration_form'),
          emailFieldRegistrationForm: getSetting('Livechat_email_field_registration_form'),
          displayOfflineForm: getSetting('Livechat_display_offline_form'),
          showConnecting: false,
          transcript: getSetting('Livechat_enable_transcript'),
          survey: getSetting('Livechat_enable_satisfaction_survey'),
          limitTextLength: getSetting<number>('Livechat_enable_message_character_limit') || getSetting<number>('Message_MaxAllowedSize'),
          fileUpload: S.visitorUploadsEnabled(),
          fileUploadMaxSize: getSetting<number>('FileUpload_MaxFileSize'),
          fileUploadAcceptedTypes: mediaTypeList('FileUpload_MediaTypeWhiteList'),
          fileUploadBlockedTypes: mediaTypeList('FileUpload_MediaTypeBlackList'),
        },
        theme: { title: getSetting('Livechat_title'), color: getSetting('Livechat_title_color'), offlineTitle: getSetting('Livechat_offline_title') },
        messages: {
          offlineMessage: getSetting('Livechat_offline_message'),
          offlineSuccessMessage: getSetting('Livechat_offline_success_message'),
          registrationFormMessage: getSetting('Livechat_registration_form_message'),
          conversationFinishedMessage: getSetting('Livechat_conversation_finished_message'),
          transcriptMessage: getSetting('Livechat_transcript_message'),
        },
        departments: departments.filter((d) => d.showOnRegistration || d.showOnOfflineForm).map((d) => ({ _id: d._id, name: d.name, showOnRegistration: d.showOnRegistration, showOnOfflineForm: d.showOnOfflineForm })),
        customFields: await A.listCustomFields(true).then((l) => l.filter((f) => f.scope === 'visitor')),
        triggers: enabled ? await A.listTriggers(true) : [],
        guest: visitor ? { _id: visitor.id, token: visitor.token, name: visitor.name, email: visitor.email, username: visitor.username } : null,
        room: room ? S.mapRoomForVisitor(room) : null,
        agent: room?.agent_id && getSetting('Livechat_show_agent_info') ? { _id: room.agent_id, username: room.a_username, name: room.a_name } : null,
      },
    };
  });

  route(app, 'POST', 'livechat/visitor', { auth: false }, async (req) => {
    ensureEnabled();
    const v = b(req).visitor ?? {};
    const row = await S.registerVisitor(v, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    return { visitor: S.mapVisitorPublic(row) };
  });

  route(app, 'GET', 'livechat/visitor/:token', { auth: false }, async (req) => {
    const v = await S.getVisitorByToken(P(req).token);
    if (!v) throw notFound('error-invalid-token', 'Visitante não encontrado.');
    return { visitor: S.mapVisitorPublic(v) };
  });

  route(app, 'GET', 'livechat/room', { auth: false }, async (req) => {
    ensureEnabled();
    const v = await requireVisitor(req);
    const { rid, newRoom } = await S.getOrCreateVisitorRoom(v, { rid: q(req).rid, departmentId: q(req).department, source: { type: 'widget', url: q(req).url?.slice(0, 500) } });
    return { room: S.mapRoomForVisitor(await S.getLivechatRoomRow(rid)), newRoom };
  });

  route(app, 'POST', 'livechat/message', { auth: false }, async (req) => {
    ensureEnabled();
    const v = await requireVisitor(req);
    const body = b(req);
    let rid = body.rid as string | undefined;
    if (!rid) rid = (await S.getOrCreateVisitorRoom(v, { departmentId: body.department })).rid;
    const message = await S.sendVisitorMessage(v, rid!, String(body.msg ?? ''), body._id);
    return { message };
  });

  // Arquivo do visitante: multipart com "file" e, opcionalmente, "msg" e "description".
  route(app, 'POST', 'livechat/upload/:rid', { auth: false }, async (req) => {
    ensureEnabled();
    const v = await requireVisitor(req);
    const rid = P(req).rid;
    await S.assertVisitorCanUpload(v, rid, req.ip);
    const { file, fields } = await readUpload(req);
    if (!file) throw badRequest('error-invalid-params', 'Nenhum arquivo enviado.');
    return { message: await S.sendVisitorFile(v, rid, file, fields) };
  });

  route(app, 'GET', 'livechat/messages.history/:rid', { auth: false }, async (req) => {
    const v = await requireVisitor(req);
    const limit = Math.min(200, Math.max(1, Number(q(req).limit) || 50));
    return { messages: await S.visitorHistory(v, P(req).rid, { limit, before: q(req).ls || undefined }) };
  });

  route(app, 'POST', 'livechat/room.close', { auth: false }, async (req) => {
    const v = await requireVisitor(req);
    await S.closeRoom({ visitor: v }, str(b(req).rid, 'rid'));
    return { rid: b(req).rid, comment: getSetting('Livechat_conversation_finished_message') };
  });

  route(app, 'POST', 'livechat/transcript', { auth: false }, async (req) => {
    const v = await requireVisitor(req);
    await S.requestTranscript(v, str(b(req).rid, 'rid'), str(b(req).email, 'email'));
    return { message: 'Transcrição solicitada.' };
  });

  route(app, 'POST', 'livechat/room.survey', { auth: false }, async (req) => {
    const v = await requireVisitor(req);
    await S.saveSurvey(v, str(b(req).rid, 'rid'), b(req).data ?? []);
    return {};
  });

  route(app, 'POST', 'livechat/offline.message', { auth: false }, async (req) => {
    const body = b(req);
    await S.saveOfflineMessage({ name: body.name, email: body.email, message: body.message, department: body.department, host: String(req.headers.origin ?? req.headers.referer ?? '') });
    return { message: getSetting('Livechat_offline_success_message') };
  });

  route(app, 'GET', 'livechat/queue.position/:rid', { auth: false }, async (req) => {
    const v = await requireVisitor(req);
    const lr = await one('SELECT 1 FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [P(req).rid, v.id]);
    if (!lr) throw notFound('error-room-not-found', 'Conversa não encontrada.');
    return { position: await S.queuePosition(P(req).rid) };
  });

  // ======================= Agentes =======================

  route(app, 'GET', 'livechat/agent.status', {}, async (_req, _r, ctx) => ({ status: await S.getAgentStatus(ctx.userId) }));
  route(app, 'POST', 'livechat/agent.status', {}, async (req, _r, ctx) => {
    const me = await one(`SELECT 1 FROM users WHERE id = $1 AND 'livechat-agent' = ANY(roles)`, [ctx.userId]);
    const target = b(req).agentId && b(req).agentId !== ctx.userId ? b(req).agentId : ctx.userId;
    if (target !== ctx.userId && !(await hasPermission(ctx.userId, 'manage-livechat-agents'))) throw forbidden();
    if (target === ctx.userId && !me) throw badRequest('error-not-agent', 'Você não é agente de atendimento.');
    const status = b(req).status ?? ((await S.getAgentStatus(target)) === 'available' ? 'not-available' : 'available');
    if (!['available', 'not-available'].includes(status)) throw badRequest('error-invalid-status', 'Status inválido.');
    await S.setAgentStatus(target, status);
    return { status };
  });
  route(app, 'GET', 'livechat/agents/:id', {}, async (req, _r, ctx) => {
    if (P(req).id !== ctx.userId && !(await hasPermission(ctx.userId, 'manage-livechat-agents'))) throw forbidden();
    const info = await A.agentInfo(P(req).id);
    if (!info) throw notFound('error-invalid-agent', 'Agente não encontrado.');
    return { agent: info };
  });
  route(app, 'POST', 'livechat/agents/:id', {}, async (req, _r, ctx) => {
    await A.updateAgent(ctx, P(req).id, b(req));
    return { agent: await A.agentInfo(P(req).id) };
  });

  route(app, 'GET', 'livechat/inquiries.queuedForUser', {}, async (_req, _r, ctx) => ({ inquiries: await A.queueForUser(ctx) }));
  route(app, 'POST', 'livechat/inquiries.take', {}, async (req, _r, ctx) => ({ room: await S.takeInquiry(ctx, str(b(req).inquiryId, 'inquiryId'), b(req).userId) }));
  route(app, 'POST', 'livechat/inquiries.returnAsInquiry', {}, async (req, _r, ctx) => {
    await S.returnToQueue(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });

  route(app, 'GET', 'livechat/room.info', {}, async (req, _r, ctx) => {
    const rid = str(q(req).rid, 'rid');
    if (!(await S.canViewLivechatRoom(ctx.userId, rid))) throw forbidden();
    const room = await S.getLivechatRoom(rid);
    const visitor = await one('SELECT * FROM livechat_visitors WHERE id = $1', [room!.v._id]);
    const m: any = S.mapVisitor(visitor);
    delete m.token;
    const previous = await many(`SELECT room_id, status, created_at, closed_at FROM livechat_rooms WHERE visitor_id = $1 AND room_id <> $2 ORDER BY created_at DESC LIMIT 20`, [visitor.id, rid]);
    return { room, visitor: m, previousChats: previous.map((p) => ({ rid: p.room_id, status: p.status, ts: p.created_at, closedAt: p.closed_at })) };
  });
  route(app, 'POST', 'livechat/room.saveInfo', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { room: await S.saveRoomInfo(ctx, str(body.rid ?? body.roomData?._id, 'rid'), body) };
  });
  route(app, 'POST', 'livechat/room.closeByUser', {}, async (req, _r, ctx) => {
    const body = b(req);
    await S.closeRoom({ ctx }, str(body.rid, 'rid'), { comment: body.comment, tags: strArray(body.tags) });
    return {};
  });
  route(app, 'POST', 'livechat/room.forward', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { room: await S.forwardRoom(ctx, str(body.roomId, 'roomId'), { userId: body.userId, departmentId: body.departmentId, comment: body.comment }) };
  });
  route(app, 'POST', 'livechat/room.onHold', {}, async (req, _r, ctx) => {
    await S.placeOnHold(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });
  route(app, 'POST', 'livechat/room.resumeOnHold', {}, async (req, _r, ctx) => {
    await S.resumeOnHold(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });
  route(app, 'POST', 'livechat/room.transcript', {}, async (req, _r, ctx) => {
    const rid = str(b(req).rid, 'rid');
    if (!(await S.canViewLivechatRoom(ctx.userId, rid))) throw forbidden();
    const lr = await one('SELECT visitor_id FROM livechat_rooms WHERE room_id = $1', [rid]);
    const v = await one('SELECT * FROM livechat_visitors WHERE id = $1', [lr.visitor_id]);
    await S.requestTranscript(v, rid, str(b(req).email ?? v.email, 'email'));
    return {};
  });

  route(app, 'GET', 'livechat/rooms', {}, async (req, _r, ctx) => {
    const p = paging(q(req));
    const query = q(req);
    return A.listRooms(ctx, {
      agents: strArray(query.agents),
      departmentId: query.departmentId,
      status: query.status,
      tags: strArray(query.tags),
      text: query.text,
      from: query.from,
      to: query.to,
      visitorId: query.visitorId,
      ...p,
    });
  });

  // ======================= Gestão =======================

  for (const type of ['agent', 'manager', 'monitor'] as const) {
    route(app, 'GET', `livechat/users/${type}`, {}, async (req, _r, ctx) => A.listLivechatUsers(ctx, type, { text: q(req).text, ...paging(q(req)) }));
    route(app, 'POST', `livechat/users/${type}`, {}, async (req, _r, ctx) => ({ user: await A.addLivechatUser(ctx, type, str(b(req).username, 'username')) }));
    route(app, 'DELETE', `livechat/users/${type}/:id`, {}, async (req, _r, ctx) => {
      await A.removeLivechatUser(ctx, type, P(req).id);
      return {};
    });
  }

  route(app, 'GET', 'livechat/department', {}, async (req, _r, ctx) =>
    A.listDepartments(ctx, { text: q(req).text, enabledOnly: bool(q(req).enabled) ?? false, onlyMyDepartments: bool(q(req).onlyMyDepartments) ?? false, ...paging(q(req)) }),
  );
  route(app, 'GET', 'livechat/department/:id', {}, async (_req, _r, ctx) => {
    if (!(await hasPermission(ctx.userId, 'view-livechat-manager')) && !(await hasPermission(ctx.userId, 'transfer-livechat-guest'))) throw forbidden();
    return A.getDepartment(P(_req).id);
  });
  route(app, 'POST', 'livechat/department', {}, async (req, _r, ctx) => A.saveDepartment(ctx, null, b(req).department ?? {}, b(req).agents));
  route(app, 'PUT', 'livechat/department/:id', {}, async (req, _r, ctx) => A.saveDepartment(ctx, P(req).id, b(req).department ?? {}, b(req).agents));
  route(app, 'DELETE', 'livechat/department/:id', {}, async (req, _r, ctx) => {
    await A.removeDepartment(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/units', {}, async (_req, _r, ctx) => ({ units: await A.listUnits(ctx) }));
  route(app, 'POST', 'livechat/units', {}, async (req, _r, ctx) => ({ unit: await A.saveUnit(ctx, b(req)._id ?? null, b(req) as any) }));
  route(app, 'DELETE', 'livechat/units/:id', {}, async (req, _r, ctx) => {
    await A.removeUnit(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'canned-responses.get', {}, async (_req, _r, ctx) => ({ responses: await A.cannedForAgent(ctx) }));
  route(app, 'GET', 'canned-responses', {}, async (req, _r, ctx) => A.listCanned(ctx, { text: q(req).text, scope: q(req).scope, ...paging(q(req)) }));
  route(app, 'POST', 'canned-responses', {}, async (req, _r, ctx) => ({ cannedResponse: await A.saveCanned(ctx, b(req) as any) }));
  route(app, 'DELETE', 'canned-responses', {}, async (req, _r, ctx) => {
    await A.removeCanned(ctx, str(q(req)._id ?? b(req)._id, '_id'));
    return {};
  });

  route(app, 'GET', 'livechat/tags', {}, async (req) => ({ tags: await A.listTags(q(req).departmentId) }));
  route(app, 'POST', 'livechat/tags', {}, async (req, _r, ctx) => ({ tag: await A.saveTag(ctx, b(req)._id ?? null, b(req) as any) }));
  route(app, 'DELETE', 'livechat/tags/:id', {}, async (req, _r, ctx) => {
    await A.removeTag(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/priorities', {}, async () => ({ priorities: await A.listPriorities() }));
  route(app, 'PUT', 'livechat/priorities/:id', {}, async (req, _r, ctx) => {
    await A.updatePriority(ctx, P(req).id, b(req).reset ? null : b(req).name);
    return { priorities: await A.listPriorities() };
  });

  route(app, 'GET', 'livechat/sla', {}, async () => ({ sla: await A.listSla() }));
  route(app, 'POST', 'livechat/sla', {}, async (req, _r, ctx) => ({ sla: await A.saveSla(ctx, b(req)._id ?? null, b(req) as any) }));
  route(app, 'DELETE', 'livechat/sla/:id', {}, async (req, _r, ctx) => {
    await A.removeSla(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/business-hours', {}, async (_req, _r, ctx) => {
    if (!(await hasPermission(ctx.userId, 'view-livechat-manager'))) throw forbidden();
    return { businessHours: await A.listBusinessHours() };
  });
  route(app, 'POST', 'livechat/business-hours', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { businessHour: await A.saveBusinessHour(ctx, body._id ?? null, { ...body, timezone: body.timezone?.name ?? body.timezone } as any) };
  });
  route(app, 'DELETE', 'livechat/business-hours/:id', {}, async (req, _r, ctx) => {
    await A.removeBusinessHour(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/custom-fields', {}, async () => ({ customFields: await A.listCustomFields() }));
  route(app, 'POST', 'livechat/custom-fields', {}, async (req, _r, ctx) => ({ customField: await A.saveCustomField(ctx, b(req) as any) }));
  route(app, 'DELETE', 'livechat/custom-fields/:id', {}, async (req, _r, ctx) => {
    await A.removeCustomField(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/triggers', { permissions: ['manage-livechat-triggers'] }, async () => ({ triggers: await A.listTriggers() }));
  route(app, 'POST', 'livechat/triggers', {}, async (req, _r, ctx) => ({ trigger: await A.saveTrigger(ctx, b(req) as any) }));
  route(app, 'DELETE', 'livechat/triggers/:id', {}, async (req, _r, ctx) => {
    await A.removeTrigger(ctx, P(req).id);
    return {};
  });

  route(app, 'GET', 'livechat/visitors.search', {}, async (req, _r, ctx) => A.listContacts(ctx, { text: q(req).term ?? q(req).text, ...paging(q(req)) }));
  route(app, 'GET', 'livechat/visitors.info', {}, async (req, _r, ctx) => ({ visitor: await A.contactInfo(ctx, str(q(req).visitorId, 'visitorId')) }));
  route(app, 'PUT', 'livechat/visitors/:id', {}, async (req, _r, ctx) => ({ visitor: await A.updateContact(ctx, P(req).id, b(req)) }));
  route(app, 'DELETE', 'livechat/visitors/:id', {}, async (req, _r, ctx) => {
    await A.removeContact(ctx, P(req).id);
    return {};
  });
  route(app, 'GET', 'livechat/offline.messages', {}, async (req, _r, ctx) => {
    const p = paging(q(req));
    return A.listOfflineMessages(ctx, p.offset, p.count);
  });

  route(app, 'GET', 'livechat/analytics/overview', {}, async (req, _r, ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    return A.analyticsOverview(ctx, { start: q(req).start || today, end: q(req).end || today, departmentId: q(req).departmentId });
  });
  route(app, 'GET', 'livechat/analytics/realtime', {}, async (_req, _r, ctx) => A.realtimeMonitoring(ctx));

  // ======================= Widget (arquivos e tempo real) =======================

  app.get('/livechat', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    const allowed = String(getSetting('Livechat_allowed_domains') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    reply.header('content-security-policy', `frame-ancestors ${allowed.length ? `'self' ${allowed.map((d) => (d.includes('://') ? d : `https://${d} http://${d}`)).join(' ')}` : '*'}`);
    return widgetHtml();
  });
  app.get('/livechat/widget.js', async (_req, reply) => {
    reply.header('content-type', 'application/javascript; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return widgetLoaderJs();
  });

  app.get('/livechat/websocket', { websocket: true }, async (socket: WebSocket, req) => {
    const token = String((req.query as any)?.token ?? '');
    const visitor = await S.getVisitorByToken(token);
    if (!visitor) {
      socket.close(4001, 'invalid-token');
      return;
    }
    const rooms = await many(`SELECT room_id FROM livechat_rooms WHERE visitor_id = $1 ORDER BY created_at DESC LIMIT 5`, [visitor.id]);
    const conn: Conn = {
      id: newId(),
      kind: 'visitor',
      userId: S.visitorConnId(visitor.id),
      sessionId: '',
      rooms: new Set(rooms.map((r) => r.room_id)),
      watched: new Set(),
      send: (ev) => {
        if (socket.readyState !== socket.OPEN) return;
        // Visitante não recebe digitação de outros visitantes nem eventos internos de agentes.
        if (ev.type === 'subscription' || ev.type === 'presence' || ev.type === 'notification') return;
        if (ev.type === 'message') {
          const m: any = { ...ev.message };
          delete m.token;
          socket.send(JSON.stringify({ ...ev, message: m }));
          return;
        }
        socket.send(JSON.stringify(ev));
      },
      close: () => socket.close(),
    };
    bus.register(conn);
    socket.on('message', (data) => {
      let ev: VisitorClientEvent;
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ev.type === 'ping') conn.send({ type: 'pong' });
      else if (ev.type === 'typing' && conn.rooms.has(ev.rid)) {
        bus.publish({ room: ev.rid }, { type: 'typing', rid: ev.rid, username: visitor.name || visitor.username, typing: !!ev.typing });
      }
    });
    socket.on('close', () => bus.unregister(conn));
  });
}
