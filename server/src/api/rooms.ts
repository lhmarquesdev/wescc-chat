import { roomAccess, setMemberRoomRoles, setPosters } from '../services/roomAccess';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { audit } from '../services/audit';
import { assertCanBringIn, directParentFor, directPolicyFor } from '../services/direct';
import { mapRoom, mapTeam } from '../services/mappers';
import { cleanHistory, createDiscussion, listDiscussions } from '../services/messages';
import { hasPermission } from '../services/permissions';
import { getInvite, INVITE_MAX_DAYS, INVITE_MAX_USES, inviteNumber, inviteStatus, listInvites, oneJoinAtATime, type InviteStatus } from '../services/invites';
import {
  addUserToRoom,
  adminListRooms,
  canAccessRoom,
  createDirect,
  createRoom,
  deleteRoom,
  directory,
  getRoom,
  inviteToRoom,
  joinRoom,
  kickFromRoom,
  leaveRoom,
  listMembers,
  listRoomRoles,
  listSubscriptions,
  listUserRooms,
  loadRoomForUser,
  markRead,
  markUnread,
  notifyRoomUpdated,
  resolveRoom,
  saveRoomSettings,
  setArchived,
  setMuted,
  setRoomRole,
  updateSubscriptionFlags,
  buildSubscription,
  getSubscriptionRow,
} from '../services/rooms';
import {
  addRoomsToTeam,
  addTeamMembers,
  convertRoomToTeam,
  convertTeamToRoom,
  createTeam,
  createTeamRoom,
  deleteTeam,
  listAllTeams,
  listMyTeams,
  removeRoomFromTeam,
  removeTeamMember,
  requireTeam,
  teamInfo,
  teamMembers,
  teamRooms,
  updateTeamRoom,
} from '../services/teams';
import { spotlight } from '../services/spotlight';
import { actorOf } from '../services/users';
import { b, bool, paging, q, route, str, strArray } from './http';
import { resolveUserParam } from './users';

const PREFIX_TYPE: Record<string, 'c' | 'p'> = { channels: 'c', groups: 'p' };

export function roomsRoutes(app: FastifyInstance) {
  // ---------- Assinaturas e salas do usuário ----------
  route(app, 'GET', 'subscriptions.get', {}, async (req, _rep, ctx) => {
    const subs = await listSubscriptions(ctx.userId, q(req).updatedSince);
    return { update: subs, remove: [] };
  });
  route(app, 'GET', 'subscriptions.getOne', {}, async (req, _rep, ctx) => {
    const sub = await getSubscriptionRow(str(q(req).roomId, 'roomId'), ctx.userId);
    return { subscription: sub ? await buildSubscription(sub) : null };
  });
  route(app, 'POST', 'subscriptions.read', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await markRead(ctx, str(body.rid ?? body.roomId, 'rid'), { readThreads: !!bool(body.readThreads) });
    return {};
  });
  route(app, 'POST', 'subscriptions.unread', {}, async (req, _rep, ctx) => {
    const body = b(req);
    if (body.firstUnreadMessage?._id) {
      const m = await one('SELECT room_id FROM messages WHERE id = $1', [body.firstUnreadMessage._id]);
      if (!m) throw notFound('error-message-not-found');
      await markUnread(ctx, m.room_id, body.firstUnreadMessage._id);
    } else {
      await markUnread(ctx, str(body.roomId, 'roomId'));
    }
    return {};
  });
  route(app, 'GET', 'rooms.get', {}, async (_req, _rep, ctx) => ({ update: await listUserRooms(ctx.userId), remove: [] }));
  route(app, 'POST', 'rooms.favorite', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await updateSubscriptionFlags(ctx, str(body.roomId, 'roomId'), { favorite: !!bool(body.favorite) });
    return {};
  });
  route(app, 'POST', 'rooms.hide', {}, async (req, _rep, ctx) => {
    await updateSubscriptionFlags(ctx, str(b(req).roomId, 'roomId'), { open: false });
    return {};
  });
  route(app, 'POST', 'rooms.open', {}, async (req, _rep, ctx) => {
    await updateSubscriptionFlags(ctx, str(b(req).roomId, 'roomId'), { open: true });
    return {};
  });
  route(app, 'POST', 'rooms.saveNotification', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await updateSubscriptionFlags(ctx, str(body.roomId, 'roomId'), { notifications: body.notifications ?? {} });
    return {};
  });
  route(app, 'GET', 'rooms.info', {}, async (req, _rep, ctx) => {
    const room = await resolveRoom(q(req));
    if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta sala.');
    const out: any = mapRoom(room);
    out.muted = room.muted;
    if (room.team_id) {
      const t = await one('SELECT * FROM teams WHERE id = $1', [room.team_id]);
      if (t) out.team = mapTeam(t);
    }
    if (room.prid) {
      const p = await getRoom(room.prid);
      if (p) out.parent = { _id: p.id, t: p.t, name: p.name, fname: p.fname };
    }
    out.joinCodeRequired = !!room.join_code;
    // Calculado para quem pergunta: a web desativa o compositor e as chamadas antes do clique.
    // A discussão criada numa DM segue a política da DM para quem participa dela.
    const direct = room.t === 'd' ? room : await directParentFor(ctx, room);
    if (direct) out.direct = await directPolicyFor(ctx, direct);
    return { room: out };
  });
  route(app, 'GET', 'rooms.membersOrderedByRole', {}, async (req, _rep, ctx) => {
    const room = await loadRoomForUser(ctx, str(q(req).roomId, 'roomId'));
    if (room.broadcast && !(await hasPermission(ctx.userId, 'view-broadcast-member-list', room.id))) throw forbidden();
    return listMembers(room.id, { ...paging(q(req)), filter: q(req).filter, orderByRole: true });
  });
  route(app, 'POST', 'rooms.saveRoomSettings', {}, async (req, _rep, ctx) => {
    const body = b(req);
    // Booleanos normalizados só quando enviados: a auditoria registra os campos que vieram.
    const settings: Record<string, any> = { ...body };
    for (const k of ['readOnly', 'reactWhenReadOnly', 'notice', 'noticeAck', 'broadcast', 'encrypted']) if (k in body) settings[k] = bool(body[k]);
    const room = await saveRoomSettings(ctx, str(body.rid, 'rid'), settings);
    return { rid: room.id, room: mapRoom(room) };
  });
  route(app, 'POST', 'rooms.delete', {}, async (req, _rep, ctx) => {
    await deleteRoom(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });
  route(app, 'POST', 'rooms.leave', {}, async (req, _rep, ctx) => {
    await leaveRoom(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });
  route(app, 'POST', 'rooms.cleanHistory', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const count = await cleanHistory(ctx, str(body.roomId, 'roomId'), {
      latest: str(body.latest, 'latest'),
      oldest: str(body.oldest, 'oldest'),
      inclusive: !!bool(body.inclusive),
      excludePinned: !!bool(body.excludePinned),
      filesOnly: !!bool(body.filesOnly),
      users: strArray(body.users),
      limit: Number(body.limit ?? 0),
    });
    return { count };
  });
  // Permissões do canal: quem pode enviar e o que cada pessoa pode fazer nele (painel Permissões da sala).
  route(app, 'GET', 'rooms.access', {}, async (req, _rep, ctx) => roomAccess(ctx, str(q(req).roomId, 'roomId'), q(req).filter ?? ''));
  route(app, 'POST', 'rooms.access.setRoles', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const roles = await setMemberRoomRoles(ctx, str(body.roomId, 'roomId'), str(body.userId, 'userId'), strArray(body.roles));
    return { roles };
  });
  route(app, 'POST', 'rooms.access.setPosters', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return { changed: await setPosters(ctx, str(body.roomId, 'roomId'), strArray(body.add), strArray(body.remove)) };
  });
  route(app, 'POST', 'rooms.muteUser', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const u = await resolveUserParam(body);
    await setMuted(ctx, str(body.roomId, 'roomId'), u.id, true);
    return {};
  });
  route(app, 'POST', 'rooms.unmuteUser', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const u = await resolveUserParam(body);
    await setMuted(ctx, str(body.roomId, 'roomId'), u.id, false);
    return {};
  });
  route(app, 'POST', 'rooms.setAvatar', {}, async (req, _rep, ctx) => {
    let rid = '';
    let data: Buffer | null = null;
    let type = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        data = await part.toBuffer();
        type = part.mimetype;
      } else if (part.fieldname === 'roomId') rid = String(part.value);
    }
    if (!rid || !data) throw badRequest('error-invalid-params', 'roomId e imagem são obrigatórios.');
    if (!(await hasPermission(ctx.userId, 'edit-room-avatar', rid))) throw forbidden();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw badRequest('error-invalid-image', 'Formato não suportado.');
    await query(
      `INSERT INTO room_avatars (room_id, content_type, data) VALUES ($1,$2,$3) ON CONFLICT (room_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
      [rid, type, data],
    );
    await query('UPDATE rooms SET avatar_etag = $2, updated_at = now() WHERE id = $1', [rid, newId(8)]);
    await notifyRoomUpdated(rid);
    return {};
  });

  // ---------- channels.* e groups.* ----------
  for (const prefix of ['channels', 'groups'] as const) {
    const t = PREFIX_TYPE[prefix];
    route(app, 'POST', `${prefix}.create`, {}, async (req, _rep, ctx) => {
      const body = b(req);
      const extra = body.extraData ?? {};
      const room = await createRoom(ctx, {
        type: t,
        name: str(body.name, 'name'),
        members: strArray(body.members),
        readOnly: !!bool(body.readOnly),
        topic: extra.topic,
        description: extra.description,
        broadcast: !!bool(extra.broadcast),
        notice: !!bool(extra.notice),
        noticeAck: !!bool(extra.noticeAck),
        reactWhenReadOnly: !!bool(extra.reactWhenReadOnly),
        encrypted: !!bool(extra.encrypted),
        teamId: extra.teamId,
      });
      return { [prefix === 'channels' ? 'channel' : 'group']: mapRoom(room) };
    });
    route(app, 'GET', `${prefix}.info`, {}, async (req, _rep, ctx) => {
      const room = await resolveRoom(q(req));
      if (!(await canAccessRoom(ctx.userId, room))) throw forbidden();
      return { [prefix === 'channels' ? 'channel' : 'group']: mapRoom(room) };
    });
    route(app, 'GET', `${prefix}.members`, {}, async (req, _rep, ctx) => {
      const room = await resolveRoom(q(req));
      if (!(await canAccessRoom(ctx.userId, room))) throw forbidden();
      if (room.broadcast && !(await hasPermission(ctx.userId, 'view-broadcast-member-list', room.id))) throw forbidden();
      const p = paging(q(req));
      const r = await listMembers(room.id, { ...p, filter: q(req).filter, status: strArray(q(req).status) });
      return { ...r, count: r.members.length, offset: p.offset };
    });
    route(app, 'GET', `${prefix}.roles`, {}, async (req, _rep, ctx) => {
      const room = await resolveRoom(q(req));
      if (!(await canAccessRoom(ctx.userId, room))) throw forbidden();
      return { roles: await listRoomRoles(room.id) };
    });
    route(app, 'POST', `${prefix}.invite`, {}, async (req, _rep, ctx) => {
      const body = b(req);
      const room = await resolveRoom(body);
      const ids = body.userIds ? strArray(body.userIds) : [(await resolveUserParam(body)).id];
      await inviteToRoom(ctx, room.id, ids);
      return { [prefix === 'channels' ? 'channel' : 'group']: mapRoom(await getRoom(room.id)) };
    });
    route(app, 'POST', `${prefix}.kick`, {}, async (req, _rep, ctx) => {
      const body = b(req);
      const room = await resolveRoom(body);
      await kickFromRoom(ctx, room.id, (await resolveUserParam(body)).id);
      return {};
    });
    route(app, 'POST', `${prefix}.leave`, {}, async (req, _rep, ctx) => {
      await leaveRoom(ctx, (await resolveRoom(b(req))).id);
      return {};
    });
    route(app, 'POST', `${prefix}.archive`, {}, async (req, _rep, ctx) => {
      await setArchived(ctx, (await resolveRoom(b(req))).id, true);
      return {};
    });
    route(app, 'POST', `${prefix}.unarchive`, {}, async (req, _rep, ctx) => {
      await setArchived(ctx, (await resolveRoom(b(req))).id, false);
      return {};
    });
    route(app, 'POST', `${prefix}.delete`, {}, async (req, _rep, ctx) => {
      await deleteRoom(ctx, (await resolveRoom(b(req))).id);
      return {};
    });
    for (const [action, role] of [
      ['Owner', 'owner'],
      ['Moderator', 'moderator'],
      ['Leader', 'leader'],
      ['Publisher', 'publisher'],
    ] as const) {
      route(app, 'POST', `${prefix}.add${action}`, {}, async (req, _rep, ctx) => {
        const body = b(req);
        await setRoomRole(ctx, (await resolveRoom(body)).id, (await resolveUserParam(body)).id, role, true);
        return {};
      });
      route(app, 'POST', `${prefix}.remove${action}`, {}, async (req, _rep, ctx) => {
        const body = b(req);
        await setRoomRole(ctx, (await resolveRoom(body)).id, (await resolveUserParam(body)).id, role, false);
        return {};
      });
    }
    for (const [suffix, field] of [
      ['setTopic', 'roomTopic'],
      ['setDescription', 'roomDescription'],
      ['setAnnouncement', 'roomAnnouncement'],
      ['rename', 'roomName'],
    ] as const) {
      route(app, 'POST', `${prefix}.${suffix}`, {}, async (req, _rep, ctx) => {
        const body = b(req);
        const value = body.topic ?? body.description ?? body.announcement ?? body.name ?? '';
        const room = await saveRoomSettings(ctx, (await resolveRoom(body)).id, { [field]: value });
        return { [prefix === 'channels' ? 'channel' : 'group']: mapRoom(room) };
      });
    }
    route(app, 'POST', `${prefix}.setReadOnly`, {}, async (req, _rep, ctx) => {
      const body = b(req);
      await saveRoomSettings(ctx, (await resolveRoom(body)).id, { readOnly: !!bool(body.readOnly) });
      return {};
    });
    route(app, 'POST', `${prefix}.setType`, {}, async (req, _rep, ctx) => {
      const body = b(req);
      await saveRoomSettings(ctx, (await resolveRoom(body)).id, { roomType: body.type === 'p' ? 'p' : 'c' });
      return {};
    });
  }
  route(app, 'POST', 'channels.join', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const room = await resolveRoom(body);
    await joinRoom(ctx, room.id, body.joinCode);
    return { channel: mapRoom(await getRoom(room.id)) };
  });
  route(app, 'GET', 'channels.list', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await directory(ctx, { type: 'channels', text: q(req).filter ?? q(req).text, ...p });
    return { channels: r.result, total: r.total, count: r.result.length, offset: p.offset };
  });
  route(app, 'GET', 'channels.list.joined', {}, async (_req, _rep, ctx) => ({ channels: (await listUserRooms(ctx.userId)).filter((r) => r.t === 'c') }));
  route(app, 'GET', 'groups.list', {}, async (_req, _rep, ctx) => ({ groups: (await listUserRooms(ctx.userId)).filter((r) => r.t === 'p') }));

  // ---------- Mensagens diretas ----------
  route(app, 'POST', 'im.create', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const names = body.usernames ? strArray(body.usernames) : [str(body.username, 'username')];
    const room = await createDirect(ctx, names);
    return { room: { ...mapRoom(room), rid: room.id } };
  });
  route(app, 'GET', 'im.list', {}, async (_req, _rep, ctx) => ({ ims: (await listUserRooms(ctx.userId)).filter((r) => r.t === 'd') }));
  route(app, 'GET', 'im.members', {}, async (req, _rep, ctx) => {
    const room = await loadRoomForUser(ctx, str(q(req).roomId, 'roomId'));
    return listMembers(room.id, paging(q(req)));
  });
  route(app, 'POST', 'im.close', {}, async (req, _rep, ctx) => {
    await updateSubscriptionFlags(ctx, str(b(req).roomId, 'roomId'), { open: false });
    return {};
  });
  route(app, 'POST', 'im.delete', {}, async (req, _rep, ctx) => {
    await deleteRoom(ctx, str(b(req).roomId, 'roomId'));
    return {};
  });

  // ---------- Discussões ----------
  route(app, 'POST', 'rooms.createDiscussion', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const room = await createDiscussion(ctx, {
      prid: str(body.prid, 'prid'),
      pmid: body.pmid,
      t_name: str(body.t_name, 't_name', { max: 200 }),
      users: strArray(body.users),
      reply: body.reply,
      encrypted: !!bool(body.encrypted),
      topic: body.topic,
    });
    return { discussion: { ...mapRoom(room), rid: room.id } };
  });
  route(app, 'GET', 'rooms.getDiscussions', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await listDiscussions(ctx, str(q(req).roomId, 'roomId'), { ...p, text: q(req).text });
    return { ...r, count: r.discussions.length, offset: p.offset };
  });

  // ---------- Diretório ----------
  route(app, 'GET', 'directory', {}, async (req, _rep, ctx) => {
    const query = q(req);
    const p = paging(query);
    const type = (query.type as 'channels' | 'users' | 'teams') ?? 'channels';
    if (!['channels', 'users', 'teams'].includes(type)) throw badRequest('error-invalid-params', 'type inválido.');
    const r = await directory(ctx, { type, text: query.text, ...p });
    return { ...r, count: r.result.length, offset: p.offset };
  });
  route(app, 'GET', 'rooms.autocomplete.channelAndPrivate', {}, async (req, _rep, ctx) => {
    const term = String(q(req).term ?? '');
    const rows = await many(
      `SELECT r.* FROM rooms r WHERE r.t IN ('c','p') AND r.prid IS NULL AND r.name ILIKE $1
         AND (r.t = 'c' OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.room_id = r.id AND s.user_id = $2))
       ORDER BY r.name LIMIT 15`,
      [`${term}%`, ctx.userId],
    );
    return { items: rows.map(mapRoom) };
  });
  // Busca da barra lateral (Ctrl+K): pessoas e canais públicos que ainda não estão na lista de quem pergunta.
  route(app, 'GET', 'spotlight', {}, async (req, _rep, ctx) => spotlight(ctx, str(q(req).query, 'query', { optional: true, max: 200 }) ?? ''));

  // ---------- Admin de salas ----------
  route(app, 'GET', 'rooms.adminRooms', { permissions: ['view-room-administration'] }, async (req) => {
    const query = q(req);
    const p = paging(query);
    const r = await adminListRooms({ filter: query.filter, types: strArray(query.types) as any, ...p });
    return { ...r, count: r.rooms.length, offset: p.offset };
  });
  route(app, 'GET', 'rooms.adminRooms.getRoom', { permissions: ['view-room-administration'] }, async (req) => {
    const room = await getRoom(str(q(req).rid, 'rid'));
    if (!room) throw notFound('error-room-not-found');
    return mapRoom(room);
  });
  // Ver a administração de salas não basta para pôr gente nelas: canal pede add-user-to-any-c-room e grupo privado
  // add-user-to-any-p-room, como no resto do chat. A regra da Operação vale dentro de addUserToRoom (assertCanBringIn).
  route(app, 'POST', 'rooms.adminRooms.addUser', { permissions: ['view-room-administration'] }, async (req, _rep, ctx) => {
    const body = b(req);
    const room = await getRoom(str(body.roomId, 'roomId'));
    if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
    if (room.t === 'd') throw badRequest('error-not-allowed', 'Não é possível adicionar pessoas a uma DM existente.');
    if (!(await hasPermission(ctx.userId, room.t === 'p' ? 'add-user-to-any-p-room' : 'add-user-to-any-c-room'))) throw forbidden('Sem permissão para adicionar pessoas a esta sala.');
    await addUserToRoom(room.id, (await resolveUserParam(body)).id, { inviter: { id: ctx.userId, username: ctx.username } });
    await audit(actorOf(ctx), 'admin.room.user.added', { rid: body.roomId, userId: body.userId });
    return {};
  });

  // ---------- Times ----------
  route(app, 'POST', 'teams.create', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const members = strArray(body.members);
    // A sala principal nasce antes dos membros: a regra de quem traz restritos é conferida antes de criar.
    if (members.length && Number(body.type) === 1 && (await hasPermission(ctx.userId, 'create-team'))) {
      const ids = (await many('SELECT id FROM users WHERE lower(username) = ANY($1) AND active', [members.map((m) => m.replace(/^@/, '').toLowerCase())])).map((u) => u.id);
      await assertCanBringIn(ctx.userId, { t: 'p' }, ids);
    }
    const team = await createTeam(ctx, {
      name: str(body.name, 'name'),
      type: Number(body.type) === 1 ? 1 : 0,
      members,
      readOnly: !!bool(body.room?.readOnly),
      topic: body.room?.extraData?.topic,
      description: body.room?.extraData?.description,
    });
    return { team: mapTeam(team) };
  });
  route(app, 'GET', 'teams.list', {}, async (_req, _rep, ctx) => {
    const teams = await listMyTeams(ctx);
    return { teams, total: teams.length, count: teams.length, offset: 0 };
  });
  route(app, 'GET', 'teams.listAll', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await listAllTeams(ctx, { ...p, text: q(req).text });
    return { ...r, count: r.teams.length, offset: p.offset };
  });
  route(app, 'GET', 'teams.info', {}, async (req, _rep, ctx) => ({ teamInfo: await teamInfo(ctx, await requireTeam(q(req))) }));
  route(app, 'GET', 'teams.listRooms', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const r = await teamRooms(ctx, await requireTeam(q(req)), { ...p, filter: q(req).filter });
    return { ...r, count: r.rooms.length, offset: p.offset };
  });
  route(app, 'GET', 'teams.members', {}, async (req, _rep, ctx) => {
    const p = paging(q(req));
    const team = await requireTeam(q(req));
    // "Ocultar a lista de membros" na sala principal vale também para a lista do time.
    if ((await getRoom(team.room_id))?.broadcast && !(await hasPermission(ctx.userId, 'view-broadcast-member-list', team.room_id))) throw forbidden();
    const r = await teamMembers(ctx, team, { ...p, text: q(req).username ?? q(req).name });
    return { ...r, count: r.members.length, offset: p.offset };
  });
  route(app, 'POST', 'teams.addMembers', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const team = await requireTeam(body);
    const members = (body.members ?? []).map((m: any) => ({ userId: m.userId, roles: m.roles }));
    // Quem entra no time entra também nas salas padrão dele: confere todas antes de adicionar alguém.
    if (members.length && (await hasPermission(ctx.userId, 'add-team-member', team.room_id))) {
      const ids = members.map((m: { userId: string }) => String(m.userId));
      const rooms = await many(`SELECT * FROM rooms WHERE id = $1 OR (team_id = $2 AND NOT team_main AND (custom_fields->>'teamDefault')::boolean)`, [team.room_id, team.id]);
      for (const r of rooms) await assertCanBringIn(ctx.userId, r, ids);
    }
    await addTeamMembers(ctx, team, members);
    return {};
  });
  route(app, 'POST', 'teams.removeMember', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await removeTeamMember(ctx, await requireTeam(body), str(body.userId, 'userId'), strArray(body.rooms));
    return {};
  });
  route(app, 'POST', 'teams.leave', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await removeTeamMember(ctx, await requireTeam(body), ctx.userId, strArray(body.rooms));
    return {};
  });
  route(app, 'POST', 'teams.addRooms', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await addRoomsToTeam(ctx, await requireTeam(body), strArray(body.rooms));
    return {};
  });
  route(app, 'POST', 'teams.createRoom', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const room = await createTeamRoom(ctx, await requireTeam(body), {
      name: str(body.name, 'name'),
      type: body.type === 'p' ? 'p' : 'c',
      members: strArray(body.members),
      readOnly: !!bool(body.readOnly),
    });
    return { room: mapRoom(room) };
  });
  route(app, 'POST', 'teams.removeRoom', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await removeRoomFromTeam(ctx, await requireTeam(body), str(body.roomId, 'roomId'));
    return {};
  });
  route(app, 'POST', 'teams.updateRoom', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const rid = str(body.roomId, 'roomId');
    const isDefault = !!bool(body.isDefault);
    // Sala padrão recebe todos os membros do time de uma vez, trazidos por quem marcou.
    const room = isDefault ? await getRoom(rid) : null;
    const team = room?.team_id ? await requireTeam({ teamId: room.team_id }) : null;
    if (room && team && (await hasPermission(ctx.userId, 'edit-team-channel', team.room_id))) {
      const ids = (await many('SELECT user_id FROM team_members WHERE team_id = $1', [team.id])).map((m) => m.user_id);
      await assertCanBringIn(ctx.userId, room, ids);
    }
    await updateTeamRoom(ctx, rid, isDefault);
    return {};
  });
  route(app, 'POST', 'teams.delete', {}, async (req, _rep, ctx) => {
    const body = b(req);
    await deleteTeam(ctx, await requireTeam(body), strArray(body.roomsToRemove));
    return {};
  });
  route(app, 'POST', 'teams.convertToChannel', {}, async (req, _rep, ctx) => {
    await convertTeamToRoom(ctx, await requireTeam(b(req)));
    return {};
  });
  route(app, 'POST', 'rooms.convertToTeam', {}, async (req, _rep, ctx) => {
    const team = await convertRoomToTeam(ctx, str(b(req).roomId, 'roomId'));
    return { team: mapTeam(team) };
  });

  // ---------- Convites ----------
  route(app, 'POST', 'findOrCreateInvite', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const rid = str(body.rid, 'rid');
    const room = await getRoom(rid);
    if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
    if (!(await hasPermission(ctx.userId, 'create-invite-links', rid))) throw forbidden();
    if (room.t === 'd') throw badRequest('error-not-allowed', 'Não é possível adicionar pessoas a uma DM existente.');
    // Como no Rocket.Chat, só quem participa da sala cria link para ela (e o link vale enquanto a pessoa estiver nela).
    if (!(await getSubscriptionRow(rid, ctx.userId))) throw forbidden('Só quem participa da sala pode criar um link de convite para ela.');
    if (room.archived) throw badRequest('error-room-archived', 'A sala está arquivada.');
    const days = inviteNumber(body.days, 1, INVITE_MAX_DAYS);
    if (days === null) throw badRequest('error-invalid-params', `Prazo do convite inválido: use um número inteiro de dias, de 0 (nunca expira) a ${INVITE_MAX_DAYS}.`);
    const maxUses = inviteNumber(body.maxUses, 0, INVITE_MAX_USES);
    if (maxUses === null) throw badRequest('error-invalid-params', `Limite de usos inválido: use um número inteiro, de 0 (ilimitado) a ${INVITE_MAX_USES}.`);
    let inv = await one(
      `SELECT * FROM invites WHERE room_id = $1 AND user_id = $2 AND days = $3 AND max_uses = $4 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses = 0 OR uses < max_uses)`,
      [rid, ctx.userId, days, maxUses],
    );
    if (!inv) {
      inv = await one(
        `INSERT INTO invites (id, room_id, user_id, days, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $4 > 0 THEN now() + ($4 || ' days')::interval END) RETURNING *`,
        [newId(), rid, ctx.userId, days, maxUses],
      );
    }
    return { _id: inv.id, rid, days, maxUses, uses: inv.uses, expires: inv.expires_at, url: `/invite/${inv.id}` };
  });
  route(app, 'GET', 'listInvites', {}, async (req, _rep, ctx) => {
    const rid = str(q(req).rid, 'rid', { optional: true });
    if (rid) {
      // Painel da sala: todos os links dela (de qualquer pessoa), para quem participa e pode criar links ali.
      if (!(await getRoom(rid))) throw notFound('error-room-not-found', 'Sala não encontrada.');
      if (!(await getSubscriptionRow(rid, ctx.userId)) || !(await hasPermission(ctx.userId, 'create-invite-links', rid))) throw forbidden();
      return { invites: await listInvites(ctx.userId, { rid }) };
    }
    return { invites: await listInvites(ctx.userId, { all: await hasPermission(ctx.userId, 'view-room-administration') }) };
  });
  route(app, 'DELETE', 'removeInvite/:id', {}, async (req: any, _rep, ctx) => {
    const inv = await one('SELECT * FROM invites WHERE id = $1', [req.params.id]);
    if (!inv) throw notFound('invalid-invitation-id');
    if (inv.user_id !== ctx.userId && !(await hasPermission(ctx.userId, 'create-invite-links', inv.room_id))) throw forbidden();
    await query('DELETE FROM invites WHERE id = $1', [inv.id]);
    return {};
  });
  // Sem login responde só se vale (e por que não: expired, used-up, archived ou invalid). Com login, quem já participa da
  // sala recebe alreadyMember para a tela levar direto para ela.
  route(app, 'POST', 'validateInviteToken', { auth: false }, async (req) => {
    const token = b(req).token;
    const inv = typeof token === 'string' && token ? await getInvite(token) : null;
    if (!inv) return { valid: false, reason: 'invalid' };
    const status = inviteStatus(inv);
    const room = { _id: inv.room_id, name: inv.name, fname: inv.fname, t: inv.t };
    if (req.ctx && inv.t !== 'd' && (await getSubscriptionRow(inv.room_id, req.ctx.userId))) return { valid: status === 'active', alreadyMember: true, room };
    if (status !== 'active') return { valid: false, reason: status };
    return { valid: true, room };
  });
  route(app, 'POST', 'useInviteToken', {}, async (req, _rep, ctx) => {
    const token = str(b(req).token, 'token');
    // Clique duplo ou pedidos repetidos da mesma pessoa com o mesmo link: um de cada vez, e o seguinte já a encontra na
    // sala (não gasta outro uso).
    return oneJoinAtATime(`${token}:${ctx.userId}`, async () => {
      const inv = await getInvite(token);
      if (!inv) throw inviteRefused('invalid');
      if (inv.t === 'd') throw badRequest('error-not-allowed', 'Não é possível adicionar pessoas a uma DM existente.');
      const out = { room: { rid: inv.room_id, name: inv.name, fname: inv.fname, t: inv.t } };
      // Quem já participa só é levado para a sala, sem gastar um uso (o link de uso único segue valendo para o convidado).
      const sub = await getSubscriptionRow(inv.room_id, ctx.userId);
      if (sub) {
        if (!sub.open) await updateSubscriptionFlags(ctx, inv.room_id, { open: true });
        return out;
      }
      const status = inviteStatus(inv);
      if (status !== 'active') throw inviteRefused(status);
      // Quem traz a pessoa é quem criou o link.
      await assertCanBringIn(inv.user_id, await getRoom(inv.room_id), [ctx.userId], { joinerId: ctx.userId });
      // O uso é reservado antes da entrada, com o limite e o prazo conferidos no próprio UPDATE: pedidos ao mesmo tempo
      // não passam do limite. Se a entrada falha, o uso volta.
      const used = await one(
        `UPDATE invites SET uses = uses + 1 WHERE id = $1 AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now()) RETURNING id`,
        [inv.id],
      );
      if (!used) {
        // Dois cliques: o primeiro pedido já gastou o último uso e pôs a pessoa na sala.
        if (await getSubscriptionRow(inv.room_id, ctx.userId)) return out;
        const now = await getInvite(inv.id);
        throw inviteRefused(now ? inviteStatus(now) : 'invalid');
      }
      try {
        await addUserToRoom(inv.room_id, ctx.userId);
      } catch (e) {
        await query('UPDATE invites SET uses = GREATEST(uses - 1, 0) WHERE id = $1', [inv.id]);
        throw e;
      }
      return out;
    });
  });
}

// Por que o link não serve, em português (a tela de convite mostra o mesmo motivo antes do clique).
function inviteRefused(status: InviteStatus) {
  if (status === 'archived') return badRequest('error-room-archived', 'A sala está arquivada.');
  if (status === 'expired') return badRequest('invalid-invite-token', 'Este convite expirou. Peça um novo a quem convidou você.');
  if (status === 'used-up') return badRequest('invalid-invite-token', 'Este convite já foi usado o número máximo de vezes. Peça um novo a quem convidou você.');
  return badRequest('invalid-invite-token', 'Convite inválido ou expirado.');
}
