import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { audit } from './audit';
import { mapRoom, mapTeam } from './mappers';
import { hasPermission } from './permissions';
import { addUserToRoom, createRoom, deleteRoom, getRoom, getRoomByName, notifyRoomUpdated, removeUserFromRoom } from './rooms';
import { sendSystemMessage } from './messages';
import { actorOf, type Ctx } from './users';

export async function getTeam(idOrName: { teamId?: string; teamName?: string; roomId?: string }) {
  if (idOrName.teamId) return one('SELECT * FROM teams WHERE id = $1', [idOrName.teamId]);
  if (idOrName.teamName) return one('SELECT * FROM teams WHERE lower(name) = lower($1)', [idOrName.teamName]);
  if (idOrName.roomId) return one('SELECT * FROM teams WHERE room_id = $1', [idOrName.roomId]);
  return null;
}

export async function requireTeam(p: { teamId?: string; teamName?: string; roomId?: string }) {
  const t = await getTeam(p);
  if (!t) throw notFound('team-does-not-exist', 'Time não encontrado.');
  return t;
}

async function isTeamMember(teamId: string, userId: string) {
  return !!(await one('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]));
}

export async function createTeam(ctx: Ctx, input: { name: string; type: 0 | 1; members?: string[]; readOnly?: boolean; topic?: string; description?: string }) {
  if (!(await hasPermission(ctx.userId, 'create-team'))) throw forbidden();
  if (await one('SELECT 1 FROM teams WHERE lower(name) = lower($1)', [input.name])) throw badRequest('team-name-already-exists', 'Já existe um time com esse nome.');
  if (await getRoomByName(input.name)) throw badRequest('error-duplicate-channel-name', 'Já existe uma sala com esse nome.');
  const id = newId();
  // A sala principal é criada antes para termos o room_id.
  const room = await createRoom(ctx, {
    type: input.type === 1 ? 'p' : 'c',
    name: input.name,
    readOnly: input.readOnly,
    topic: input.topic,
    description: input.description,
    skipPermission: true,
  });
  await query('INSERT INTO teams (id, name, type, room_id, created_by) VALUES ($1,$2,$3,$4,$5)', [id, input.name, input.type, room.id, ctx.userId]);
  await query('UPDATE rooms SET team_id = $2, team_main = true WHERE id = $1', [room.id, id]);
  // Membros já adicionados à sala viram membros do time.
  await query(
    `INSERT INTO team_members (team_id, user_id, roles)
     SELECT $1, user_id, CASE WHEN 'owner' = ANY(roles) THEN ARRAY['owner','member'] ELSE ARRAY['member'] END FROM subscriptions WHERE room_id = $2
     ON CONFLICT DO NOTHING`,
    [id, room.id],
  );
  if (input.members?.length) {
    const users = await many('SELECT id FROM users WHERE lower(username) = ANY($1) AND active', [input.members.map((m) => m.toLowerCase())]);
    for (const u of users) await addUserToRoom(room.id, u.id, { inviter: { id: ctx.userId, username: ctx.username }, silent: true });
  }
  await audit(actorOf(ctx), 'team.created', { teamId: id, name: input.name });
  await notifyRoomUpdated(room.id);
  return one('SELECT * FROM teams WHERE id = $1', [id]);
}

export async function teamInfo(ctx: Ctx, team: any) {
  const room = await getRoom(team.room_id);
  if (team.type === 1 && !(await isTeamMember(team.id, ctx.userId)) && !(await hasPermission(ctx.userId, 'view-all-teams'))) throw forbidden();
  const counts = await one(
    `SELECT (SELECT count(*) FROM rooms WHERE team_id = $1 AND NOT team_main)::int AS rooms_count, (SELECT count(*) FROM team_members WHERE team_id = $1)::int AS members_count`,
    [team.id],
  );
  return { ...mapTeam({ ...team, ...counts }), room: mapRoom(room) };
}

export async function listMyTeams(ctx: Ctx) {
  const rows = await many(
    `SELECT t.*, (SELECT count(*) FROM rooms WHERE team_id = t.id AND NOT team_main)::int AS rooms_count,
        (SELECT count(*) FROM team_members WHERE team_id = t.id)::int AS members_count
     FROM teams t JOIN team_members m ON m.team_id = t.id AND m.user_id = $1 ORDER BY t.name`,
    [ctx.userId],
  );
  return rows.map(mapTeam);
}

export async function listAllTeams(ctx: Ctx, opts: { offset?: number; count?: number; text?: string }) {
  if (!(await hasPermission(ctx.userId, 'view-all-teams'))) throw forbidden();
  const rows = await many(
    `SELECT t.*, u.username AS created_by_username,
        (SELECT count(*) FROM rooms WHERE team_id = t.id AND NOT team_main)::int AS rooms_count,
        (SELECT count(*) FROM team_members WHERE team_id = t.id)::int AS members_count, count(*) OVER() AS total
     FROM teams t LEFT JOIN users u ON u.id = t.created_by WHERE t.name ILIKE $1 ORDER BY t.name
     LIMIT ${Math.min(opts.count ?? 25, 100)} OFFSET ${Number(opts.offset ?? 0)}`,
    [`%${opts.text ?? ''}%`],
  );
  return { total: Number(rows[0]?.total ?? 0), teams: rows.map(mapTeam) };
}

export async function teamRooms(ctx: Ctx, team: any, opts: { filter?: string; offset?: number; count?: number }) {
  const member = await isTeamMember(team.id, ctx.userId);
  if (team.type === 1 && !member && !(await hasPermission(ctx.userId, 'view-all-teams'))) throw forbidden();
  const seeAll = await hasPermission(ctx.userId, 'view-all-team-channels', team.room_id);
  const rows = await many(
    `SELECT r.*, (s.id IS NOT NULL) AS is_member, count(*) OVER() AS total FROM rooms r
     LEFT JOIN subscriptions s ON s.room_id = r.id AND s.user_id = $2
     WHERE r.team_id = $1 AND NOT r.team_main AND coalesce(r.fname, r.name, '') ILIKE $3 AND (r.t = 'c' OR s.id IS NOT NULL OR $4)
     ORDER BY r.name LIMIT ${Math.min(opts.count ?? 50, 200)} OFFSET ${Number(opts.offset ?? 0)}`,
    [team.id, ctx.userId, `%${opts.filter ?? ''}%`, seeAll],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    rooms: rows.map((r) => ({ ...mapRoom(r), isMember: r.is_member, teamDefault: !!r.custom_fields?.teamDefault })),
  };
}

export async function addRoomsToTeam(ctx: Ctx, team: any, rids: string[]) {
  if (!(await hasPermission(ctx.userId, 'add-team-channel', team.room_id))) throw forbidden();
  for (const rid of rids) {
    const room = await getRoom(rid);
    if (!room || room.t === 'd') throw badRequest('error-invalid-room', 'Sala inválida.');
    if (room.team_id) throw badRequest('error-room-already-on-team', `A sala ${room.name} já pertence a um time.`);
    if (!(await hasPermission(ctx.userId, 'move-room-to-team', rid)) && !(await hasPermission(ctx.userId, 'add-team-channel', team.room_id))) throw forbidden();
    await query('UPDATE rooms SET team_id = $2, updated_at = now() WHERE id = $1', [rid, team.id]);
    await sendSystemMessage(team.room_id, 'user-added-room-to-team', { id: ctx.userId, username: ctx.username }, room.fname ?? room.name);
    await notifyRoomUpdated(rid);
  }
}

export async function createTeamRoom(ctx: Ctx, team: any, input: { name: string; type: 'c' | 'p'; members?: string[]; readOnly?: boolean }) {
  if (!(await hasPermission(ctx.userId, input.type === 'c' ? 'create-team-channel' : 'create-team-group', team.room_id))) throw forbidden();
  const room = await createRoom(ctx, { ...input, teamId: team.id, skipPermission: true });
  await sendSystemMessage(team.room_id, 'user-added-room-to-team', { id: ctx.userId, username: ctx.username }, room.name);
  return room;
}

export async function removeRoomFromTeam(ctx: Ctx, team: any, rid: string) {
  if (!(await hasPermission(ctx.userId, 'remove-team-channel', team.room_id))) throw forbidden();
  const room = await getRoom(rid);
  if (!room || room.team_id !== team.id || room.team_main) throw badRequest('error-invalid-room', 'Sala inválida.');
  await query(`UPDATE rooms SET team_id = NULL, custom_fields = custom_fields - 'teamDefault', updated_at = now() WHERE id = $1`, [rid]);
  await sendSystemMessage(team.room_id, 'user-removed-room-from-team', { id: ctx.userId, username: ctx.username }, room.fname ?? room.name);
  await notifyRoomUpdated(rid);
}

export async function updateTeamRoom(ctx: Ctx, rid: string, isDefault: boolean) {
  const room = await getRoom(rid);
  if (!room?.team_id) throw badRequest('error-invalid-room', 'Sala inválida.');
  const team = await requireTeam({ teamId: room.team_id });
  if (!(await hasPermission(ctx.userId, 'edit-team-channel', team.room_id))) throw forbidden();
  await query(`UPDATE rooms SET custom_fields = jsonb_set(custom_fields, '{teamDefault}', to_jsonb($2::boolean)), updated_at = now() WHERE id = $1`, [rid, isDefault]);
  if (isDefault) {
    const members = await many('SELECT user_id FROM team_members WHERE team_id = $1', [team.id]);
    for (const m of members) await addUserToRoom(rid, m.user_id, { silent: true }).catch(() => {});
  }
}

export async function teamMembers(ctx: Ctx, team: any, opts: { offset?: number; count?: number; text?: string }) {
  if (team.type === 1 && !(await isTeamMember(team.id, ctx.userId)) && !(await hasPermission(ctx.userId, 'view-all-teams'))) throw forbidden();
  const rows = await many(
    `SELECT m.roles, m.created_at, u.id, u.username, u.name, u.status, count(*) OVER() AS total FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND (u.username ILIKE $2 OR u.name ILIKE $2) ORDER BY u.username
     LIMIT ${Math.min(opts.count ?? 50, 200)} OFFSET ${Number(opts.offset ?? 0)}`,
    [team.id, `%${opts.text ?? ''}%`],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    members: rows.map((r) => ({ user: { _id: r.id, username: r.username, name: r.name, status: r.status }, roles: r.roles, createdAt: r.created_at })),
  };
}

export async function addTeamMembers(ctx: Ctx, team: any, members: { userId: string; roles?: string[] }[]) {
  if (!(await hasPermission(ctx.userId, 'add-team-member', team.room_id))) throw forbidden();
  for (const m of members) {
    await addUserToRoom(team.room_id, m.userId, { inviter: { id: ctx.userId, username: ctx.username } });
    if (m.roles?.length) await query('UPDATE team_members SET roles = $3 WHERE team_id = $1 AND user_id = $2', [team.id, m.userId, m.roles]);
    // Entra automaticamente nas salas padrão do time.
    const defaults = await many(`SELECT id FROM rooms WHERE team_id = $1 AND NOT team_main AND (custom_fields->>'teamDefault')::boolean`, [team.id]);
    for (const r of defaults) await addUserToRoom(r.id, m.userId, { silent: true }).catch(() => {});
  }
}

export async function removeTeamMember(ctx: Ctx, team: any, userId: string, rooms: string[] = []) {
  if (ctx.userId !== userId && !(await hasPermission(ctx.userId, 'edit-team-member', team.room_id))) throw forbidden();
  const owners = await one(`SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND 'owner' = ANY(roles) AND user_id <> $2`, [team.id, userId]);
  const target = await one('SELECT roles FROM team_members WHERE team_id = $1 AND user_id = $2', [team.id, userId]);
  if (!target) throw badRequest('error-user-not-in-team', 'Usuário não está no time.');
  if (target.roles.includes('owner') && owners.n === 0) throw badRequest('error-you-are-last-owner', 'Não é possível remover o último dono do time.');
  await removeUserFromRoom(team.room_id, userId, { by: { id: ctx.userId, username: ctx.username } });
  for (const rid of rooms) {
    const r = await getRoom(rid);
    if (r?.team_id === team.id) await removeUserFromRoom(rid, userId, { silent: true });
  }
}

export async function deleteTeam(ctx: Ctx, team: any, roomsToRemove: string[] = []) {
  if (!(await hasPermission(ctx.userId, 'delete-team', team.room_id))) throw forbidden();
  for (const rid of roomsToRemove) {
    const r = await getRoom(rid);
    if (r?.team_id === team.id && !r.team_main) await deleteRoom(ctx, rid).catch(() => {});
  }
  await query(`UPDATE rooms SET team_id = NULL WHERE team_id = $1 AND NOT team_main`, [team.id]);
  await query('UPDATE rooms SET team_main = false WHERE id = $1', [team.room_id]);
  await query('DELETE FROM teams WHERE id = $1', [team.id]);
  await deleteRoom(ctx, team.room_id);
  await audit(actorOf(ctx), 'team.deleted', { teamId: team.id, name: team.name });
}

export async function convertRoomToTeam(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room || room.t === 'd' || room.prid) throw badRequest('error-invalid-room', 'Sala inválida.');
  if (room.team_id) throw badRequest('error-room-already-on-team', 'A sala já pertence a um time.');
  if (!(await hasPermission(ctx.userId, 'create-team')) || !(await hasPermission(ctx.userId, 'edit-room', rid))) throw forbidden();
  const id = newId();
  await query('INSERT INTO teams (id, name, type, room_id, created_by) VALUES ($1,$2,$3,$4,$5)', [id, room.name, room.t === 'p' ? 1 : 0, rid, ctx.userId]);
  await query('UPDATE rooms SET team_id = $2, team_main = true, updated_at = now() WHERE id = $1', [rid, id]);
  await query(
    `INSERT INTO team_members (team_id, user_id, roles)
     SELECT $1, user_id, CASE WHEN 'owner' = ANY(roles) THEN ARRAY['owner','member'] ELSE ARRAY['member'] END FROM subscriptions WHERE room_id = $2
     ON CONFLICT DO NOTHING`,
    [id, rid],
  );
  await sendSystemMessage(rid, 'user-converted-to-team', { id: ctx.userId, username: ctx.username }, room.name);
  await notifyRoomUpdated(rid);
  return one('SELECT * FROM teams WHERE id = $1', [id]);
}

export async function convertTeamToRoom(ctx: Ctx, team: any) {
  if (!(await hasPermission(ctx.userId, 'edit-team', team.room_id))) throw forbidden();
  await query(`UPDATE rooms SET team_id = NULL WHERE team_id = $1 AND NOT team_main`, [team.id]);
  await query('UPDATE rooms SET team_id = NULL, team_main = false, updated_at = now() WHERE id = $1', [team.room_id]);
  await query('DELETE FROM teams WHERE id = $1', [team.id]);
  await sendSystemMessage(team.room_id, 'user-converted-to-channel', { id: ctx.userId, username: ctx.username }, team.name);
  await notifyRoomUpdated(team.room_id);
}
