import type { Call, CallMine, CallParticipant } from '@shared/index';
import { many, pool, type Queryable } from '../db/pool';
import { rolesHavePermission } from '../services/permissions';
import { guardState } from './guard';
import { loadParticipants, loadStats, mapCall, presentSql, roomRef } from './model';
import { grantsFor, managementRoles, rightsFor, type Viewer } from './policy';

// Monta o Call das respostas e dos eventos: contagem, amostra, sala, trava, participantes e o "mine" de quem pergunta.

export interface ViewOpts {
  participants?: boolean;
  mine?: boolean;
  room?: boolean;
  guard?: boolean;
}

const rolesOf = (r: any): string[] => [...(r.global_roles ?? []), ...(r.room_roles ?? [])];

// Lista de ouvintes de uma transmissão em sala com a lista oculta: só anfitrião, moderadores e quem tem a permissão.
export function seesListeners(roles: string[], host: boolean) {
  return host || rolesHavePermission(roles, 'moderate-call') || rolesHavePermission(roles, 'view-broadcast-member-list');
}

export function participantOf(r: any, call: any, room: any): CallParticipant {
  const g = grantsFor({ username: r.username }, call, room, rolesOf(r), r);
  return {
    user: { _id: r.user_id, username: r.username, name: r.name },
    state: r.state,
    host: !!r.host,
    speaker: g.canPublish,
    speakGranted: !!r.speak_granted,
    handAt: r.hand_at ?? null,
    joinedAt: r.joined_at ?? null,
    leftAt: r.left_at ?? null,
    leftReason: r.left_reason ?? null,
    seconds: r.seconds ?? 0,
  };
}

export function mineOf(v: Viewer, call: any, room: any): CallMine {
  const row = v.row;
  const rights = rightsFor(v, call, room);
  return {
    state: row?.state ?? null,
    host: !!row?.host,
    seconds: row?.seconds ?? 0,
    direction: call.caller_id === v.id ? 'outgoing' : 'incoming',
    missed: row?.state === 'missed',
    leftReason: row?.left_reason ?? null,
    leftAt: row?.left_at ?? null,
    listenOnly: row?.present ? !!row.granted_hidden : grantsFor(v, call, room, v.roles, row).hidden,
    handAt: row?.hand_at ?? null,
    ...rights,
  };
}

async function loadViewers(userIds: string[], calls: any[], db: Queryable): Promise<Map<string, Viewer>> {
  const out = new Map<string, Viewer>();
  if (!userIds.length || !calls.length) return out;
  const rows = await many(
    `SELECT c.id AS call_id, u.id, u.username, u.roles AS g, u.active, u.type, s.roles AS s, (s.id IS NOT NULL) AS member,
            p.call_id AS p_call, p.state, p.host, p.seconds, p.left_reason, p.left_at, p.hand_at, p.granted_hidden,
            p.speak_granted, p.screen_block_until, p.removed_by, ${presentSql()} AS present
       FROM unnest($1::text[]) AS x(uid) JOIN users u ON u.id = x.uid
       CROSS JOIN unnest($2::text[]) AS y(cid) JOIN calls c ON c.id = y.cid
       LEFT JOIN subscriptions s ON s.room_id = c.room_id AND s.user_id = u.id
       LEFT JOIN call_participants p ON p.call_id = c.id AND p.user_id = u.id`,
    [userIds, calls.map((c) => c.id)],
    db,
  );
  for (const r of rows) {
    const row = r.p_call
      ? { state: r.state, host: r.host, seconds: r.seconds, left_reason: r.left_reason, left_at: r.left_at, hand_at: r.hand_at, granted_hidden: r.granted_hidden,
          speak_granted: r.speak_granted, screen_block_until: r.screen_block_until, removed_by: r.removed_by, present: !!r.present }
      : null;
    const viewer = { id: r.id, username: r.username, roles: [...r.g, ...(r.s ?? [])], globalRoles: r.g, mgmtRoles: managementRoles(r.g, r.s), member: r.member, active: r.active, type: r.type, row };
    out.set(`${r.call_id}:${r.id}`, viewer);
  }
  return out;
}

export async function callViews(rows: any[], viewerId: string | null, o: ViewOpts = {}, db: Queryable = pool): Promise<Call[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const stats = await loadStats(ids, db);
  const needRooms = o.room || o.mine || o.participants || o.guard;
  const rooms = needRooms ? new Map((await many(`SELECT * FROM rooms WHERE id = ANY($1)`, [[...new Set(rows.map((r) => r.room_id))]], db)).map((r) => [r.id, r])) : new Map();
  const viewers = o.mine && viewerId ? await loadViewers([viewerId], rows, db) : new Map<string, Viewer>();
  const out: Call[] = [];
  for (const r of rows) {
    const room = rooms.get(r.room_id);
    const live = r.status === 'ringing' || r.status === 'ongoing';
    const guard = o.guard && live && r.scope === 'group' ? await guardState(r.id, db, r) : undefined;
    const call = mapCall(r, { ...stats.get(r.id)!, guard, room: o.room && room ? roomRef(room) : undefined });
    const v = viewerId ? viewers.get(`${r.id}:${viewerId}`) : undefined;
    if (o.participants && room) {
      let parts = await loadParticipants(r.id, db);
      if (r.listen_only && room.broadcast && !(v && seesListeners(v.roles, !!v.row?.host))) parts = parts.filter((p) => !p.granted_hidden);
      call.participants = parts.map((p) => participantOf(p, r, room));
    }
    if (v && room) call.mine = mineOf(v, r, room);
    out.push(call);
  }
  return out;
}

export async function callView(row: any, viewerId: string | null, o: ViewOpts = {}, db: Queryable = pool): Promise<Call> {
  return (await callViews([row], viewerId, o, db))[0];
}

// O mesmo Call para várias pessoas, cada uma com o seu "mine" (evento "call" das chamadas em grupo).
export async function callViewsFor(row: any, userIds: string[], db: Queryable = pool): Promise<Map<string, Call>> {
  const [base] = await callViews([row], null, { guard: true }, db);
  const room = (await many(`SELECT * FROM rooms WHERE id = $1`, [row.room_id], db))[0];
  const viewers = await loadViewers(userIds, [row], db);
  const out = new Map<string, Call>();
  for (const id of userIds) {
    const v = viewers.get(`${row.id}:${id}`);
    out.set(id, v && room ? { ...base, mine: mineOf(v, row, room) } : base);
  }
  return out;
}
