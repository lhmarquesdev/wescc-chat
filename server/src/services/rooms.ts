import type { RoomRetention, RoomType, Subscription, SubscriptionNotifyPrefs } from '@shared/index';
import { many, one, query, type Queryable } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { LOCK_TEXT } from '@shared/rbac';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { assertCanBringIn, assertCanStartDirect } from './direct';
import { mapRoom, mapSubscription } from './mappers';
import { sendSystemMessage } from './messages';
import { hasPermission, rolesHavePermission, getUserRoles, roleInfos } from './permissions';
import { getSetting } from './settings';
import { actorOf, getUserById, type Ctx } from './users';
import { emit } from './hooks';

const ROOM_NAME_RE = /^[0-9a-zA-ZÀ-ſ._-]{1,64}$/;

export function validateRoomName(name: string) {
  if (!ROOM_NAME_RE.test(name)) throw badRequest('error-invalid-room-name', `"${name}" não é um nome de sala válido (use letras, números, ponto, hífen e sublinhado).`);
}

export async function getRoom(rid: string, db?: Queryable) {
  return one('SELECT r.*, u.username AS owner_username FROM rooms r LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = $1', [rid], db);
}

export async function getRoomByName(name: string) {
  return one(
    `SELECT r.*, u.username AS owner_username FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
     WHERE lower(r.name) = lower($1) AND r.t IN ('c','p') ORDER BY r.prid NULLS FIRST LIMIT 1`,
    [name],
  );
}

export async function getSubscriptionRow(rid: string, userId: string) {
  return one('SELECT * FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, userId]);
}

// Regras de acesso de leitura a uma sala.
export async function canAccessRoom(userId: string, room: any): Promise<boolean> {
  if (!room) return false;
  const sub = await getSubscriptionRow(room.id, userId);
  if (sub) return true;
  if (room.t === 'c') {
    // Canal de um time privado só é visível para membros do time.
    if (room.team_id && !room.team_main) {
      const team = await one('SELECT type FROM teams WHERE id = $1', [room.team_id]);
      if (team?.type === 1 && !(await one('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [room.team_id, userId]))) return false;
    }
    return hasPermission(userId, 'view-c-room');
  }
  return false;
}

export async function loadRoomForUser(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta sala.');
  return room;
}

export async function resolveRoom(params: { roomId?: string; rid?: string; roomName?: string }) {
  const rid = params.roomId ?? params.rid;
  const room = rid ? await getRoom(rid) : params.roomName ? await getRoomByName(params.roomName.replace(/^#/, '')) : null;
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  return room;
}

// ---------- Assinaturas ----------

async function dmNameFor(room: any, userId: string) {
  if (room.t !== 'd') return undefined;
  const others = room.uids.filter((u: string) => u !== userId);
  const ids = others.length ? others : [userId];
  const users = await many('SELECT id, username, name FROM users WHERE id = ANY($1)', [ids]);
  users.sort((a, b) => a.username.localeCompare(b.username));
  return { name: users.map((u) => u.username).join(', '), fname: users.map((u) => u.name || u.username).join(', ') };
}

export async function buildSubscription(subRow: any, room?: any): Promise<Subscription> {
  room ??= await getRoom(subRow.room_id);
  const user = await one('SELECT id, username FROM users WHERE id = $1', [subRow.user_id]);
  return mapSubscription(subRow, room, user, await dmNameFor(room, subRow.user_id));
}

export async function notifySubscription(userId: string, rid: string, action: 'inserted' | 'updated' | 'removed', subRow?: any) {
  const row = subRow ?? (await getSubscriptionRow(rid, userId));
  if (!row) return;
  const room = await getRoom(rid);
  if (!room) return;
  bus.publish({ user: userId }, { type: 'subscription', action, subscription: await buildSubscription(row, room) });
}

export async function notifyRoomUpdated(rid: string) {
  const room = await getRoom(rid);
  if (!room) return;
  bus.publish({ room: rid }, { type: 'room', action: 'updated', room: mapRoom(room) });
  if (room.t === 'c') bus.publish({ all: true }, { type: 'room', action: 'updated', room: mapRoom(room) });
}

export async function listSubscriptions(userId: string, updatedSince?: string) {
  const params: unknown[] = [userId];
  let w = '';
  if (updatedSince) w = `AND s.updated_at > $${params.push(updatedSince)}`;
  const rows = await many(
    `SELECT s.*, row_to_json(r.*) AS room FROM subscriptions s JOIN rooms r ON r.id = s.room_id
     WHERE s.user_id = $1 ${w} ORDER BY s.created_at`,
    params,
  );
  const user = await one('SELECT id, username FROM users WHERE id = $1', [userId]);
  // Nomes de DM em lote.
  const dmUids = new Set<string>();
  for (const r of rows) if (r.room.t === 'd') for (const u of r.room.uids) dmUids.add(u);
  const dmUsers = new Map((await many('SELECT id, username, name FROM users WHERE id = ANY($1)', [[...dmUids]])).map((u) => [u.id, u]));
  return rows.map((r) => {
    const room = fixJsonRoom(r.room);
    let dm;
    if (room.t === 'd') {
      const others = room.uids.filter((u: string) => u !== userId);
      const us = (others.length ? others : [userId]).map((id: string) => dmUsers.get(id)).filter(Boolean);
      us.sort((a: any, b: any) => a.username.localeCompare(b.username));
      dm = { name: us.map((u: any) => u.username).join(', '), fname: us.map((u: any) => u.name || u.username).join(', ') };
    }
    return mapSubscription(r, room, user, dm);
  });
}

// row_to_json devolve timestamps sem o parser do pg; normalizamos para ISO.
export function fixJsonRoom(r: any) {
  for (const k of ['created_at', 'updated_at', 'lm']) if (r[k]) r[k] = new Date(r[k]).toISOString();
  return r;
}

export async function listUserRooms(userId: string) {
  const rows = await many(
    `SELECT r.*, u.username AS owner_username FROM rooms r JOIN subscriptions s ON s.room_id = r.id AND s.user_id = $1
     LEFT JOIN users u ON u.id = r.owner_id ORDER BY r.lm DESC NULLS LAST`,
    [userId],
  );
  return rows.map(mapRoom);
}

export async function userRoomIds(userId: string): Promise<string[]> {
  return (await many('SELECT room_id FROM subscriptions WHERE user_id = $1', [userId])).map((r) => r.room_id);
}

// ---------- Membros ----------

export async function addUserToRoom(
  rid: string,
  userId: string,
  opts: { inviter?: { id: string; username: string }; silent?: boolean; roles?: string[]; db?: Queryable } = {},
) {
  const room = await getRoom(rid, opts.db);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.archived) throw badRequest('error-room-archived', 'A sala está arquivada.');
  // Os participantes de uma DM são os do uids (é sobre eles que valem as regras de conversa direta).
  if (room.t === 'd' && !room.uids.includes(userId)) throw badRequest('error-not-allowed', 'Não é possível adicionar pessoas a uma DM existente.');
  const existing = await one('SELECT * FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, userId], opts.db);
  if (existing) {
    if (!existing.open) await query('UPDATE subscriptions SET open = true, updated_at = now() WHERE id = $1', [existing.id], opts.db);
    return existing;
  }
  const user = await one('SELECT id, username, name FROM users WHERE id = $1', [userId], opts.db);
  if (!user) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  if (opts.inviter && opts.inviter.id !== userId) await assertCanBringIn(opts.inviter.id, room, [userId]);
  const sub = await one(
    `INSERT INTO subscriptions (id, room_id, user_id, roles, ls) VALUES ($1,$2,$3,$4, now()) ON CONFLICT (room_id, user_id) DO NOTHING RETURNING *`,
    [newId(), rid, userId, opts.roles ?? []],
    opts.db,
  );
  if (!sub) return getSubscriptionRow(rid, userId);
  await query('UPDATE rooms SET users_count = users_count + 1, updated_at = now() WHERE id = $1', [rid], opts.db);
  if (room.team_main && room.team_id) {
    await query(`INSERT INTO team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [room.team_id, userId], opts.db);
  }
  bus.joinRoom(userId, rid);
  const after = async () => {
    await notifySubscription(userId, rid, 'inserted', sub);
    if (!opts.silent && room.t !== 'd') {
      if (opts.inviter && opts.inviter.id !== userId) {
        await sendSystemMessage(rid, 'au', opts.inviter, user.username);
      } else {
        await sendSystemMessage(rid, 'uj', { id: user.id, username: user.username }, user.username);
      }
    }
  };
  if (opts.db) setImmediate(() => void after().catch(() => {}));
  else await after();
  emit('room.joined', { room, user: { _id: user.id, username: user.username } });
  return sub;
}

export async function removeUserFromRoom(rid: string, userId: string, opts: { by?: { id: string; username: string }; silent?: boolean } = {}) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  const user = await one('SELECT id, username FROM users WHERE id = $1', [userId]);
  const sub = await one('DELETE FROM subscriptions WHERE room_id = $1 AND user_id = $2 RETURNING *', [rid, userId]);
  if (!sub) return;
  await query('UPDATE rooms SET users_count = GREATEST(users_count - 1, 0), updated_at = now() WHERE id = $1', [rid]);
  if (room.team_main && room.team_id) {
    await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [room.team_id, userId]);
  }
  bus.leaveRoom(userId, rid);
  bus.publish({ user: userId }, { type: 'subscription', action: 'removed', subscription: await buildSubscription(sub, room) });
  if (!opts.silent && user) {
    if (opts.by && opts.by.id !== userId) await sendSystemMessage(rid, 'ru', opts.by, user.username);
    else await sendSystemMessage(rid, 'ul', { id: user.id, username: user.username }, user.username);
  }
  if (user) emit('room.left', { room, user: { _id: user.id, username: user.username } });
}

export async function joinDefaultChannels(userId: string) {
  const rooms = await many(`SELECT id FROM rooms WHERE is_default AND t IN ('c','p') AND NOT archived`);
  for (const r of rooms) await addUserToRoom(r.id, userId, { silent: false }).catch(() => {});
}

export async function listMembers(rid: string, opts: { offset?: number; count?: number; filter?: string; status?: string[]; orderByRole?: boolean } = {}) {
  const params: unknown[] = [rid];
  let w = '';
  if (opts.filter) w += ` AND (u.username ILIKE $${params.push(`%${opts.filter}%`)} OR u.name ILIKE $${params.length})`;
  if (opts.status?.length) w += ` AND u.status = ANY($${params.push(opts.status)})`;
  const rows = await many(
    `SELECT u.id, u.username, u.name, u.status, u.status_text, u.avatar_etag, s.roles AS room_roles, count(*) OVER() AS total
     FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.room_id = $1 ${w}
     ORDER BY ${opts.orderByRole ? `CASE WHEN 'owner' = ANY(s.roles) THEN 0 WHEN 'moderator' = ANY(s.roles) THEN 1 WHEN 'leader' = ANY(s.roles) THEN 2 WHEN 'publisher' = ANY(s.roles) THEN 3 ELSE 4 END,` : ''}
       (u.status <> 'offline') DESC, u.username LIMIT ${Math.min(opts.count ?? 50, 500)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    members: rows.map((r) => ({
      _id: r.id,
      username: r.username,
      name: r.name,
      status: r.status,
      statusText: r.status_text,
      avatarETag: r.avatar_etag,
      roles: r.room_roles,
    })),
  };
}

// ---------- Criação ----------

export interface CreateRoomInput {
  type: 'c' | 'p';
  name: string;
  members?: string[]; // usernames
  readOnly?: boolean;
  topic?: string;
  description?: string;
  teamId?: string | null;
  teamMain?: boolean;
  isDefault?: boolean;
  broadcast?: boolean;
  notice?: boolean; // canal de avisos (sempre somente leitura)
  noticeAck?: boolean;
  reactWhenReadOnly?: boolean;
  encrypted?: boolean;
  prid?: string | null;
  pmid?: string | null;
  fname?: string;
  skipPermission?: boolean;
}

export async function createRoom(ctx: Ctx | null, input: CreateRoomInput) {
  const owner = ctx ? await getUserById(ctx.userId) : null;
  if (ctx && !input.skipPermission) {
    const perm = input.type === 'c' ? 'create-c' : 'create-p';
    if (!(await hasPermission(ctx.userId, perm))) throw forbidden();
  }
  if (!input.prid) {
    validateRoomName(input.name);
    if (await getRoomByName(input.name)) throw badRequest('error-duplicate-channel-name', `Já existe uma sala chamada ${input.name}.`);
  }
  const usernames = [...new Set((input.members ?? []).map((m) => m.replace(/^@/, '')))].filter((u) => u !== owner?.username);
  const users = usernames.length ? await many('SELECT id, username FROM users WHERE lower(username) = ANY($1) AND active', [usernames.map((u) => u.toLowerCase())]) : [];
  // Antes de criar: uma recusa no meio deixaria a sala pela metade.
  if (owner && users.length) await assertCanBringIn(owner.id, { t: input.type, team_id: input.teamId, team_main: input.teamMain }, users.map((u) => u.id));
  const id = newId();
  const ro = input.readOnly || input.broadcast || input.notice || false;
  await query(
    `INSERT INTO rooms (id, t, name, fname, topic, description, owner_id, ro, broadcast, encrypted, team_id, team_main, is_default, prid, pmid, notice, notice_ack, react_when_ro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id,
      input.type,
      input.name,
      input.fname ?? input.name,
      input.topic ?? '',
      input.description ?? '',
      owner?.id ?? null,
      ro,
      input.broadcast ?? false,
      input.encrypted ?? false,
      input.teamId ?? null,
      input.teamMain ?? false,
      input.isDefault ?? false,
      input.prid ?? null,
      input.pmid ?? null,
      input.notice ?? false,
      input.noticeAck ?? false,
      input.reactWhenReadOnly ?? false,
    ],
  );
  if (owner) await addUserToRoom(id, owner.id, { roles: ['owner'], silent: true });
  for (const u of users) await addUserToRoom(id, u.id, { inviter: owner ?? undefined, silent: true });
  if (ctx) await audit(actorOf(ctx), 'room.created', { rid: id, name: input.name, t: input.type });
  const room = await getRoom(id);
  if (room.t === 'c') bus.publish({ all: true }, { type: 'room', action: 'inserted', room: mapRoom(room) });
  emit('room.created', { room, owner: owner ? { _id: owner.id, username: owner.username } : null });
  return room;
}

export async function createDirect(ctx: Ctx, usernames: string[]) {
  if (!(await hasPermission(ctx.userId, 'create-d'))) throw forbidden();
  const names = [...new Set(usernames.map((u) => u.replace(/^@/, '').toLowerCase()))].filter((u) => u !== ctx.username.toLowerCase());
  const others = names.length ? await many('SELECT id, username FROM users WHERE lower(username) = ANY($1)', [names]) : [];
  if (others.length !== names.length) throw badRequest('error-invalid-user', 'Usuário não encontrado.');
  if (others.length > 8) throw badRequest('error-too-many-users', 'Máximo de 9 participantes em mensagem direta.');
  const all = [{ id: ctx.userId, username: ctx.username }, ...others];
  const uids = all.map((u) => u.id).sort();
  const existing = await one(`SELECT * FROM rooms WHERE t = 'd' AND dm_key = $1`, [uids.join(',')]);
  if (existing) {
    // Reabre para quem estava com a conversa oculta.
    const sub = await getSubscriptionRow(existing.id, ctx.userId);
    if (sub && !sub.open) {
      const s2 = await one('UPDATE subscriptions SET open = true, updated_at = now() WHERE id = $1 RETURNING *', [sub.id]);
      await notifySubscription(ctx.userId, existing.id, 'updated', s2);
    } else if (!sub) {
      await addUserToRoom(existing.id, ctx.userId, { silent: true });
    }
    return existing;
  }
  // Só uma conversa nova passa pela política; reabrir uma antiga mostra o histórico e o compositor explica o bloqueio.
  await assertCanStartDirect(ctx, others.map((u) => u.id));
  const id = newId();
  const inserted = await one(
    `INSERT INTO rooms (id, t, uids, usernames, owner_id, users_count, dm_key) VALUES ($1,'d',$2,$3,$4,0,$5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [id, uids, all.map((u) => u.username).sort(), ctx.userId, uids.join(',')],
  );
  // Corrida com outra criação simultânea da mesma DM: devolve a existente.
  if (!inserted) return one(`SELECT * FROM rooms WHERE t = 'd' AND dm_key = $1`, [uids.join(',')]);
  for (const u of all) await addUserToRoom(id, u.id, { silent: true });
  return getRoom(id);
}

// ---------- Entrar / sair ----------

export async function joinRoom(ctx: Ctx, rid: string, joinCode?: string) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t !== 'c') throw forbidden('Só é possível entrar sozinho em canais públicos.');
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden();
  if (room.join_code && room.join_code !== joinCode && !(await hasPermission(ctx.userId, 'join-without-join-code')))
    throw badRequest('error-code-invalid', 'Código de acesso inválido.');
  const banned = await one(`SELECT 1 FROM rooms WHERE id = $1 AND custom_fields->'banned' ? $2`, [rid, ctx.userId]);
  if (banned) throw forbidden('Você foi banido desta sala.');
  return addUserToRoom(rid, ctx.userId);
}

export async function leaveRoom(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd') throw badRequest('error-not-allowed', 'Não é possível sair de uma mensagem direta; oculte a conversa.');
  const sub = await getSubscriptionRow(rid, ctx.userId);
  if (!sub) throw badRequest('error-user-not-in-room', 'Você não está nesta sala.');
  if (sub.roles.includes('owner')) {
    const otherOwners = await one(`SELECT count(*)::int AS n FROM subscriptions WHERE room_id = $1 AND user_id <> $2 AND 'owner' = ANY(roles)`, [rid, ctx.userId]);
    if (otherOwners.n === 0 && room.users_count > 1) throw badRequest('error-you-are-last-owner', 'Você é o último dono. Defina outro dono antes de sair.');
  }
  await removeUserFromRoom(rid, ctx.userId);
}

export async function inviteToRoom(ctx: Ctx, rid: string, userIds: string[]) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd') throw badRequest('error-not-allowed', 'Não é possível adicionar pessoas a uma DM existente.');
  const isMember = !!(await getSubscriptionRow(rid, ctx.userId));
  const roles = await getUserRoles(ctx.userId, rid);
  const allowed =
    (isMember && rolesHavePermission(roles, 'add-user-to-joined-room')) ||
    (room.t === 'c' && rolesHavePermission(roles, 'add-user-to-any-c-room')) ||
    (room.t === 'p' && rolesHavePermission(roles, 'add-user-to-any-p-room'));
  if (!allowed) throw forbidden();
  await assertCanBringIn(ctx.userId, room, userIds);
  for (const uid of userIds) await addUserToRoom(rid, uid, { inviter: { id: ctx.userId, username: ctx.username } });
}

export async function kickFromRoom(ctx: Ctx, rid: string, userId: string) {
  if (!(await hasPermission(ctx.userId, 'remove-user', rid))) throw forbidden();
  const target = await getSubscriptionRow(rid, userId);
  if (!target) throw badRequest('error-user-not-in-room', 'Usuário não está na sala.');
  if (target.roles.includes('owner')) {
    const n = await one(`SELECT count(*)::int AS n FROM subscriptions WHERE room_id = $1 AND 'owner' = ANY(roles)`, [rid]);
    if (n.n <= 1) throw badRequest('error-you-are-last-owner', 'Não é possível remover o último dono.');
  }
  await removeUserFromRoom(rid, userId, { by: { id: ctx.userId, username: ctx.username } });
  await audit(actorOf(ctx), 'room.user.removed', { rid, userId });
}

// ---------- Configurações da sala ----------

export interface RoomSettings {
  roomName?: string;
  roomTopic?: string;
  roomDescription?: string;
  roomAnnouncement?: string;
  roomType?: 'c' | 'p';
  readOnly?: boolean;
  reactWhenReadOnly?: boolean;
  notice?: boolean;
  noticeAck?: boolean;
  broadcast?: boolean; // "Ocultar a lista de membros"
  default?: boolean;
  featured?: boolean;
  encrypted?: boolean;
  joinCode?: string;
  retention?: Partial<RoomRetention>;
}

export async function saveRoomSettings(ctx: Ctx, rid: string, s: RoomSettings) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  const roles = await getUserRoles(ctx.userId, rid);
  const can = (p: string) => rolesHavePermission(roles, p);
  if (!can('edit-room')) throw forbidden();
  const sets: string[] = [];
  const params: unknown[] = [rid];
  const sys: [string, string][] = [];
  const me = { id: ctx.userId, username: ctx.username };

  if (s.roomName !== undefined && s.roomName !== room.name && room.t !== 'd') {
    if (!room.prid) {
      validateRoomName(s.roomName);
      const other = await getRoomByName(s.roomName);
      if (other && other.id !== rid) throw badRequest('error-duplicate-channel-name', 'Já existe uma sala com esse nome.');
    }
    sets.push(`name = $${params.push(s.roomName)}`, `fname = $${params.length}`);
    sys.push(['r', s.roomName]);
    if (room.team_main && room.team_id) await query('UPDATE teams SET name = $2 WHERE id = $1', [room.team_id, s.roomName]);
  }
  if (s.roomTopic !== undefined && s.roomTopic !== room.topic) {
    sets.push(`topic = $${params.push(s.roomTopic)}`);
    sys.push(['room_changed_topic', s.roomTopic]);
  }
  if (s.roomDescription !== undefined && s.roomDescription !== room.description) {
    sets.push(`description = $${params.push(s.roomDescription)}`);
    sys.push(['room_changed_description', s.roomDescription]);
  }
  if (s.roomAnnouncement !== undefined && s.roomAnnouncement !== room.announcement) {
    sets.push(`announcement = $${params.push(s.roomAnnouncement)}`);
    sys.push(['room_changed_announcement', s.roomAnnouncement]);
  }
  if (s.roomType !== undefined && s.roomType !== room.t && room.t !== 'd') {
    if (!can(s.roomType === 'c' ? 'create-c' : 'create-p')) throw forbidden();
    if (s.roomType === 'p') {
      const ids = (await many('SELECT user_id FROM subscriptions WHERE room_id = $1', [rid])).map((r) => r.user_id);
      await assertCanBringIn(ctx.userId, { t: 'p', team_id: room.team_id, team_main: room.team_main }, ids, { privatize: true });
    }
    sets.push(`t = $${params.push(s.roomType)}`);
    sys.push(['room_changed_privacy', s.roomType === 'c' ? 'public' : 'private']);
    if (room.team_main && room.team_id) await query('UPDATE teams SET type = $2 WHERE id = $1', [room.team_id, s.roomType === 'c' ? 0 : 1]);
  }
  const noticeChanged = s.notice !== undefined && s.notice !== !!room.notice;
  const notice = noticeChanged ? !!s.notice : !!room.notice;
  if (noticeChanged) {
    if (room.t !== 'c' && room.t !== 'p') throw badRequest('error-not-allowed', 'Só canais e grupos podem ser canais de avisos.');
    if (!can('set-readonly')) throw forbidden();
  }
  if (s.readOnly === false && notice) {
    throw badRequest('error-notice-readonly', 'Um canal de avisos é sempre somente leitura. Desative “Canal de avisos” para liberar a escrita.');
  }
  if (noticeChanged) {
    // A mensagem de sistema do aviso já diz tudo: sem "somente leitura" junto.
    sets.push(`notice = $${params.push(notice)}`, `ro = $${params.push(notice || s.readOnly === true)}`);
    sys.push([notice ? 'room-set-notice' : 'room-removed-notice', '']);
  } else if (s.readOnly !== undefined && s.readOnly !== room.ro) {
    if (!can('set-readonly')) throw forbidden();
    sets.push(`ro = $${params.push(s.readOnly)}`);
    sys.push([s.readOnly ? 'room-set-read-only' : 'room-removed-read-only', '']);
  }
  if (s.noticeAck !== undefined && s.noticeAck !== !!room.notice_ack) {
    if (!can('set-readonly')) throw forbidden();
    sets.push(`notice_ack = $${params.push(s.noticeAck)}`);
  }
  if (s.broadcast !== undefined && s.broadcast !== !!room.broadcast) {
    if (!can('set-readonly')) throw forbidden();
    sets.push(`broadcast = $${params.push(s.broadcast)}`);
  }
  // Só quando muda: o painel da sala reenvia o valor atual, e o moderador não tem essa permissão.
  if (s.reactWhenReadOnly !== undefined && s.reactWhenReadOnly !== !!room.react_when_ro) {
    if (!can('set-react-when-readonly')) throw forbidden();
    sets.push(`react_when_ro = $${params.push(s.reactWhenReadOnly)}`);
  }
  if (s.default !== undefined || s.featured !== undefined) {
    if (!(await hasPermission(ctx.userId, 'view-room-administration'))) throw forbidden();
    if (s.default !== undefined) sets.push(`is_default = $${params.push(s.default)}`);
    if (s.featured !== undefined) sets.push(`featured = $${params.push(s.featured)}`);
  }
  if (s.encrypted !== undefined && s.encrypted !== room.encrypted) {
    if (!can('toggle-room-e2e-encryption') && !can('edit-room')) throw forbidden();
    sets.push(`encrypted = $${params.push(s.encrypted)}`);
    sys.push([s.encrypted ? 'room_e2e_enabled' : 'room_e2e_disabled', '']);
  }
  if (s.joinCode !== undefined) sets.push(`join_code = $${params.push(s.joinCode || null)}`);
  if (s.retention !== undefined) {
    if (!can('edit-room-retention-policy')) throw forbidden();
    const r: RoomRetention = {
      enabled: !!s.retention.enabled,
      overrideGlobal: !!s.retention.overrideGlobal,
      maxAgeDays: Math.max(1, Number(s.retention.maxAgeDays ?? 30)),
      filesOnly: !!s.retention.filesOnly,
      excludePinned: s.retention.excludePinned ?? true,
    };
    sets.push(`retention = $${params.push(JSON.stringify(r))}`);
  }
  if (!sets.length) return room;
  sets.push('updated_at = now()');
  await query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = $1`, params);
  for (const [t, msg] of sys) await sendSystemMessage(rid, t, me, msg);
  await audit(actorOf(ctx), 'room.settings.changed', { rid, name: room.name }, { fields: Object.keys(s) });
  await notifyRoomUpdated(rid);
  // Nome, tipo e canal de avisos mudam a exibição das assinaturas.
  if (s.roomName !== undefined || s.roomType !== undefined || noticeChanged) {
    const subs = await many('SELECT * FROM subscriptions WHERE room_id = $1', [rid]);
    const updated = await getRoom(rid);
    for (const sub of subs) {
      bus.publish({ user: sub.user_id }, { type: 'subscription', action: 'updated', subscription: await buildSubscription(sub, updated) });
    }
  }
  return getRoom(rid);
}

export async function setArchived(ctx: Ctx, rid: string, archived: boolean) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd') throw badRequest('error-not-allowed', 'DMs não podem ser arquivadas.');
  if (!(await hasPermission(ctx.userId, archived ? 'archive-room' : 'unarchive-room', rid))) throw forbidden();
  await query('UPDATE rooms SET archived = $2, updated_at = now() WHERE id = $1', [rid, archived]);
  await sendSystemMessage(rid, archived ? 'room-archived' : 'room-unarchived', { id: ctx.userId, username: ctx.username }, '');
  await audit(actorOf(ctx), archived ? 'room.archived' : 'room.unarchived', { rid, name: room.name });
  await notifyRoomUpdated(rid);
  if (archived) emit('room.archived', { room, by: { _id: ctx.userId, username: ctx.username } });
}

export async function deleteRoom(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  const perm = room.t === 'c' ? 'delete-c' : room.t === 'p' ? 'delete-p' : 'delete-d';
  if (!(await hasPermission(ctx.userId, perm, rid))) throw forbidden();
  if (room.team_main) throw badRequest('error-not-allowed', 'Exclua o time em vez da sala principal.');
  const subs = await many('SELECT * FROM subscriptions WHERE room_id = $1', [rid]);
  const { deleteRoomFiles } = await import('./uploads');
  await deleteRoomFiles(rid);
  // Discussões filhas são removidas em cascata.
  await query('DELETE FROM rooms WHERE id = $1', [rid]);
  if (room.prid && room.pmid) {
    await query('UPDATE messages SET dcount = GREATEST(dcount - 1, 0), drid = NULL WHERE id = $1', [room.pmid]);
  }
  for (const s of subs) {
    bus.leaveRoom(s.user_id, rid);
    bus.publish({ user: s.user_id }, { type: 'subscription', action: 'removed', subscription: await buildSubscription(s, room) });
  }
  bus.publish({ all: true }, { type: 'room', action: 'removed', room: mapRoom(room) });
  await audit(actorOf(ctx), 'room.deleted', { rid, name: room.name, t: room.t });
}

// ---------- Papéis na sala ----------

const ROLE_PERMS: Record<string, string> = { owner: 'set-owner', moderator: 'set-moderator', leader: 'set-leader', publisher: 'set-publisher' };
const ROLE_MSG: Record<string, string> = { owner: 'owner', moderator: 'moderator', leader: 'leader', publisher: 'publisher' };

// Papel de sala que não é um dos quatro do sistema: um papel com escopo "De sala" criado em Papéis e permissões. Dar ou
// tirar pede Definir moderadores na sala e a mesma trava de concessão dos papéis globais: o papel precisa caber no que
// o ator tem nesta sala (papéis globais mais os da sala), salvo administrador ou delegação.
export function roomRoleLock(actorRoles: string[], role: string): string | null {
  const infos = roleInfos();
  const info = infos.find((r) => r.id === role);
  if (!info || info.scope !== 'Subscriptions') return 'invalid';
  if (ROLE_PERMS[role]) return null;
  const byId = new Map(infos.map((r) => [r.id, r]));
  const mine = actorRoles.map((r) => byId.get(r)).filter((r): r is NonNullable<typeof r> => !!r);
  if (mine.some((r) => r.root)) return null;
  const held = new Set(mine.flatMap((r) => r.permissions));
  if (info.permissions.every((k) => held.has(k))) return null;
  if (mine.some((r) => r.delegable.includes(role))) return null;
  return 'superior';
}

export async function setRoomRole(ctx: Ctx, rid: string, userId: string, role: string, add: boolean) {
  const builtin = ROLE_PERMS[role];
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd') throw badRequest('error-not-allowed', 'Mensagens diretas não têm papéis de sala.');
  const actorRoles = await getUserRoles(ctx.userId, rid);
  const lock = roomRoleLock(actorRoles, role);
  if (lock === 'invalid') throw badRequest('error-invalid-role', 'Papel inválido.');
  if (!rolesHavePermission(actorRoles, builtin ?? 'set-moderator')) throw forbidden();
  if (lock) throw new ApiError(403, 'RBAC_ROLE_SUPERIOR', LOCK_TEXT.superior);
  const sub = await getSubscriptionRow(rid, userId);
  if (!sub) throw badRequest('error-user-not-in-room', 'Usuário não está na sala.');
  if (add && sub.roles.includes(role)) throw badRequest('error-user-already-has-role', 'O usuário já tem esse papel.');
  if (!add && !sub.roles.includes(role)) throw badRequest('error-user-not-has-role', 'O usuário não tem esse papel.');
  if (!add && role === 'owner') {
    const n = await one(`SELECT count(*)::int AS n FROM subscriptions WHERE room_id = $1 AND 'owner' = ANY(roles)`, [rid]);
    if (n.n <= 1) throw badRequest('error-remove-last-owner', 'Não é possível remover o último dono.');
  }
  const roles = add ? [...sub.roles, role] : sub.roles.filter((r: string) => r !== role);
  const row = await one('UPDATE subscriptions SET roles = $2, updated_at = now() WHERE id = $1 RETURNING *', [sub.id, roles]);
  const target = await one('SELECT username FROM users WHERE id = $1', [userId]);
  await sendSystemMessage(rid, add ? 'subscription-role-added' : 'subscription-role-removed', { id: ctx.userId, username: ctx.username }, target.username, {
    role: ROLE_MSG[role] ?? role,
  });
  await notifySubscription(userId, rid, 'updated', row);
  if (room.team_main && room.team_id) {
    await query(`UPDATE team_members SET roles = $3 WHERE team_id = $1 AND user_id = $2`, [room.team_id, userId, roles.length ? roles : ['member']]);
  }
  await audit(actorOf(ctx), add ? 'room.role.added' : 'room.role.removed', { rid, userId, role });
}

export async function listRoomRoles(rid: string) {
  const rows = await many(
    `SELECT s.roles, u.id, u.username, u.name FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.room_id = $1 AND cardinality(s.roles) > 0`,
    [rid],
  );
  return rows.map((r) => ({ rid, u: { _id: r.id, username: r.username, name: r.name }, roles: r.roles }));
}

export async function setMuted(ctx: Ctx, rid: string, userId: string, mute: boolean) {
  if (!(await hasPermission(ctx.userId, 'mute-user', rid))) throw forbidden();
  const target = await one('SELECT username FROM users WHERE id = $1', [userId]);
  if (!target) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  await query(
    mute
      ? 'UPDATE rooms SET muted = array_append(array_remove(muted, $2), $2), updated_at = now() WHERE id = $1'
      : 'UPDATE rooms SET muted = array_remove(muted, $2), updated_at = now() WHERE id = $1',
    [rid, target.username],
  );
  await sendSystemMessage(rid, mute ? 'user-muted' : 'user-unmuted', { id: ctx.userId, username: ctx.username }, target.username);
  await notifyRoomUpdated(rid);
}

// ---------- Ações do usuário sobre a assinatura ----------

export async function markRead(ctx: Ctx, rid: string, opts: { readThreads?: boolean } = {}) {
  const sub = await getSubscriptionRow(rid, ctx.userId);
  if (!sub) return;
  const prevLs = sub.ls;
  const row = await one(
    `UPDATE subscriptions SET unread = 0, alert = false, user_mentions = 0, group_mentions = 0, ls = now(), updated_at = now()
       ${opts.readThreads ? ", tunread = '{}'" : ''}
     WHERE id = $1 RETURNING *`,
    [sub.id],
  );
  await notifySubscription(ctx.userId, rid, 'updated', row);
  const { recordReads } = await import('./reads');
  await recordReads(ctx.userId, rid, prevLs);
}

export async function markUnread(ctx: Ctx, rid: string, fromMessageId?: string) {
  const sub = await getSubscriptionRow(rid, ctx.userId);
  if (!sub) return;
  let ls: string | null = null;
  let unread = 1;
  if (fromMessageId) {
    const m = await one('SELECT created_at FROM messages WHERE id = $1 AND room_id = $2', [fromMessageId, rid]);
    if (m) {
      ls = new Date(new Date(m.created_at).getTime() - 1).toISOString();
      const c = await one('SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND created_at > $2 AND tmid IS NULL AND t IS NULL', [rid, ls]);
      unread = Math.max(1, c.n);
    }
  }
  const row = await one(
    `UPDATE subscriptions SET alert = true, unread = $2, ls = COALESCE($3, ls), updated_at = now() WHERE id = $1 RETURNING *`,
    [sub.id, unread, ls],
  );
  await notifySubscription(ctx.userId, rid, 'updated', row);
}

export async function updateSubscriptionFlags(ctx: Ctx, rid: string, data: { favorite?: boolean; open?: boolean; notifications?: SubscriptionNotifyPrefs }) {
  const sub = await getSubscriptionRow(rid, ctx.userId);
  if (!sub) throw badRequest('error-user-not-in-room', 'Você não está nesta sala.');
  const sets: string[] = [];
  const params: unknown[] = [sub.id];
  if (data.favorite !== undefined) sets.push(`favorite = $${params.push(data.favorite)}`);
  if (data.open !== undefined) sets.push(`open = $${params.push(data.open)}`);
  if (data.notifications) sets.push(`notifications = notifications || $${params.push(JSON.stringify(data.notifications))}::jsonb`);
  if (!sets.length) return sub;
  const row = await one(`UPDATE subscriptions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  await notifySubscription(ctx.userId, rid, 'updated', row);
  return row;
}

// ---------- Diretório ----------

export async function directory(ctx: Ctx, opts: { type: 'channels' | 'users' | 'teams'; text?: string; offset?: number; count?: number; sort?: string }) {
  const count = Math.min(opts.count ?? 25, 100);
  const offset = Number(opts.offset ?? 0);
  const text = `%${opts.text ?? ''}%`;
  if (opts.type === 'users') {
    const rows = await many(
      `SELECT id, username, name, status, status_text, avatar_etag, bio, roles, created_at, count(*) OVER() AS total FROM users
       WHERE active AND type = 'user' AND (username ILIKE $1 OR name ILIKE $1)
       ORDER BY username LIMIT ${count} OFFSET ${offset}`,
      [text],
    );
    return {
      total: Number(rows[0]?.total ?? 0),
      result: rows.map((r) => ({
        _id: r.id,
        username: r.username,
        name: r.name,
        status: r.status,
        statusText: r.status_text,
        avatarETag: r.avatar_etag,
        roles: r.roles,
        createdAt: r.created_at,
      })),
    };
  }
  if (opts.type === 'teams') {
    const rows = await many(
      `SELECT t.*, r.description, r.topic, r.users_count, (SELECT count(*) FROM rooms x WHERE x.team_id = t.id AND NOT x.team_main)::int AS rooms_count,
         count(*) OVER() AS total
       FROM teams t JOIN rooms r ON r.id = t.room_id
       WHERE t.name ILIKE $1 AND (t.type = 0 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2))
       ORDER BY t.name LIMIT ${count} OFFSET ${offset}`,
      [text, ctx.userId],
    );
    return {
      total: Number(rows[0]?.total ?? 0),
      result: rows.map((r) => ({ _id: r.id, name: r.name, type: r.type, roomId: r.room_id, description: r.description, topic: r.topic, usersCount: r.users_count, roomsCount: r.rooms_count, ts: r.created_at })),
    };
  }
  const rows = await many(
    `SELECT r.*, u.username AS owner_username, t.name AS team_name, count(*) OVER() AS total FROM rooms r
     LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN teams t ON t.id = r.team_id
     WHERE r.t = 'c' AND r.prid IS NULL AND (r.name ILIKE $1 OR r.fname ILIKE $1 OR r.topic ILIKE $1)
       AND (r.team_id IS NULL OR t.type = 0 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = r.team_id AND m.user_id = $2))
     ORDER BY r.featured DESC, r.users_count DESC, r.name LIMIT ${count} OFFSET ${offset}`,
    [text, ctx.userId],
  );
  return { total: Number(rows[0]?.total ?? 0), result: rows.map((r) => ({ ...mapRoom(r), teamName: r.team_name })) };
}

export async function adminListRooms(opts: { filter?: string; types?: RoomType[]; offset?: number; count?: number }) {
  const params: unknown[] = [`%${opts.filter ?? ''}%`];
  let w = '(r.name ILIKE $1 OR r.fname ILIKE $1 OR array_to_string(r.usernames, \',\') ILIKE $1)';
  if (opts.types?.length) w += ` AND r.t = ANY($${params.push(opts.types)})`;
  // Pela última atividade (mensagem, ou a criação se não há mensagens): as salas em uso vêm primeiro.
  const rows = await many(
    `SELECT r.*, u.username AS owner_username, count(*) OVER() AS total FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
     WHERE ${w} ORDER BY COALESCE(r.lm, r.created_at) DESC, r.created_at DESC LIMIT ${Math.min(opts.count ?? 25, 200)} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return { total: Number(rows[0]?.total ?? 0), rooms: rows.map(mapRoom) };
}

export async function ensureDefaultChannel() {
  const any = await one(`SELECT 1 FROM rooms WHERE is_default LIMIT 1`);
  if (any) return;
  const names = String(getSetting('Default_Channels') || 'geral')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    if (await getRoomByName(name)) continue;
    await createRoom(null, { type: 'c', name, isDefault: true, skipPermission: true });
  }
}
