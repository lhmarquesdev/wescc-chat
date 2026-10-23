import type { CallGuardState } from '@shared/index';
import {
  CALL_GUARD_CLEARED,
  CALL_GUARD_JOIN,
  CALL_LIMITS,
  callGuardText,
  callPresenceVerdict,
  guardModeFor,
  type GuardPerson,
} from '@shared/calls';
import { isExempt, isRestricted, type DirectRules } from '@shared/direct';
import { many, one, pool, type Queryable } from '../db/pool';
import { ApiError } from '../lib/errors';
import { currentDirectRules, partyOf } from '../services/direct';
import { restrictedRoleIds } from '../services/permissions';
import { getSetting } from '../services/settings';
import { endGroupCallTx } from './group';
import { loadCallRow, loadRoomInfo, presentIds, publishCall, withCallLock, type Db, type Effects } from './model';
import { grantsFor } from './policy';
import { touchCall } from './card';
import { applyGrantsTx } from './presence';
import { coalesce } from './queue';

// Trava de pessoas restritas (§5.10): olha quem está de fato na chamada, nunca quem criou a sala.

export interface GuardPeople {
  applies: boolean;
  mode: 'strict' | 'pairs';
  rules: DirectRules;
  people: (GuardPerson & { chaperone: boolean })[];
}

const graceSeconds = () => Number(getSetting('Calls_Restricted_Grace')) || 30;

// Uma consulta. Assimétrica de propósito: quem é restrito e está entrando já conta para formar par (arriving), mas
// não para a regra dos três do modo pairs; acompanhante só conta conectado (ou caído há menos de 8 s, sem ter
// desligado). Quem entra agora (joiner) conta como presente. Bots nunca contam.
export async function guardPeople(callId: string, joiner?: string, db: Queryable = pool, call?: any, room?: any): Promise<GuardPeople> {
  call ??= await loadCallRow(callId, db);
  room ??= call ? await loadRoomInfo(call.room_id, db) : null;
  const rules = currentDirectRules();
  const publicMode = getSetting('Calls_Restricted_Public') === 'strict' ? 'strict' : 'pairs';
  const mode = room ? guardModeFor({ t: room.t, prid: room.prid, privateTeam: !!room.private_team }, publicMode) : 'strict';
  const applies = !!call && call.scope === 'group' && restrictedRoleIds().length > 0;
  if (!applies) return { applies, mode, rules, people: [] };
  const rows = await many(
    `SELECT u.id, u.username, u.roles, u.active, s.roles AS room_roles, p.state, p.speak_granted, p.screen_block_until,
            (p.state = 'joining' AND p.token_at > now() - make_interval(secs => ${CALL_LIMITS.tokenSeconds})) AS fresh,
            (p.state = 'left' AND p.left_reason = 'disconnected' AND p.left_at > now() - make_interval(secs => ${CALL_LIMITS.chaperoneGraceSeconds})) AS grace,
            (u.id = $2) AS joiner
       FROM users u
       LEFT JOIN call_participants p ON p.call_id = $1 AND p.user_id = u.id
       LEFT JOIN subscriptions s ON s.room_id = $3 AND s.user_id = u.id
      WHERE u.type = 'user'
        AND (u.id = $2 OR u.id IN (SELECT user_id FROM call_participants WHERE call_id = $1 AND state IN ('joined', 'joining', 'left')))`,
    [callId, joiner ?? null, call.room_id],
    db,
  );
  const people: GuardPeople['people'] = [];
  for (const r of rows) {
    const party = partyOf({ id: r.id, username: r.username, roles: r.roles, active: r.active });
    const chaperone = !isRestricted(party, rules) || isExempt(party, rules);
    const counts = r.joiner || r.state === 'joined' || (r.fresh && !chaperone) || (r.grace && chaperone);
    if (!counts) continue;
    const speaks = grantsFor({ username: r.username }, call, room, [...r.roles, ...(r.room_roles ?? [])], r).speaker;
    people.push({ ...party, speaks, chaperone, arriving: !r.joiner && r.state === 'joining' });
  }
  return { applies, mode, rules, people };
}

export function guardStateOf(g: GuardPeople): CallGuardState | undefined {
  if (!g.applies) return undefined;
  return {
    mode: g.mode,
    chaperone: g.people.some((p) => p.chaperone),
    restrictedSpeakers: g.people.filter((p) => !p.chaperone && p.speaks).length,
    connectedSpeakers: g.people.filter((p) => !p.chaperone && p.speaks && !p.arriving).length,
  };
}

export async function guardState(callId: string, db: Queryable = pool, call?: any, room?: any): Promise<CallGuardState | undefined> {
  return guardStateOf(await guardPeople(callId, undefined, db, call, room));
}

// Recusa a entrada que deixaria a chamada insegura. Quem não é restrito (um supervisor) nunca é barrado aqui, nem
// quem só ouve: sem falar não forma par (a mesma regra de predictJoinBlocked, que a web usa para prever).
export async function assertJoinSafe(call: any, room: any, userId: string, db: Queryable = pool): Promise<void> {
  const g = await guardPeople(call.id, userId, db, call, room);
  if (!g.applies) return;
  if (g.people.find((p) => p._id === userId)?.speaks === false) return;
  if (!callPresenceVerdict(g.people, g.rules, g.mode).allowed) throw new ApiError(403, 'error-call-restricted', CALL_GUARD_JOIN);
}

// Agrupada (300 ms, roda já quando parada). O trabalho no banco fica na trava; o LiveKit, nos efeitos.
export function evaluateGuard(callId: string) {
  coalesce(callId, 'guard', 300, () => evaluateGuardNow(callId), { leading: true });
}

export async function evaluateGuardNow(callId: string) {
  const call = await one(`SELECT scope, status, guard_until FROM calls WHERE id = $1`, [callId]);
  if (!call || call.scope !== 'group' || call.status !== 'ongoing') return;
  // Sem papéis restritos e sem pausa não há o que conferir: poupa a trava nas chamadas comuns.
  if (!restrictedRoleIds().length && !call.guard_until) return;
  await withCallLock(callId, (c, fx) => evaluateGuardTx(c, fx, callId));
}

export type GuardOutcome = 'none' | 'paused' | 'still' | 'ended' | 'cleared';

export async function evaluateGuardTx(c: Db, fx: Effects, callId: string): Promise<GuardOutcome> {
  let call = await loadCallRow(callId, c);
  if (!call || call.scope !== 'group' || call.status !== 'ongoing') return 'none';
  const room = await loadRoomInfo(call.room_id, c);
  const g = await guardPeople(callId, undefined, c, call, room);
  const blocked = g.applies && !callPresenceVerdict(g.people, g.rules, g.mode).allowed;
  const present = await presentIds(callId, c);
  if (blocked && !call.guard_until) {
    const grace = graceSeconds();
    const r = await one(`UPDATE calls SET guard_until = now() + make_interval(secs => $2) WHERE id = $1 RETURNING guard_until`, [callId, grace], c);
    // Tokens ainda não usados de quem publicaria deixam de abrir a conexão.
    await c.query(`UPDATE call_participants SET token_at = NULL WHERE call_id = $1 AND state = 'joining' AND granted_publish`, [callId]);
    call = await loadCallRow(callId, c);
    await applyGrantsTx(c, fx, call, room);
    fx.publish({ users: present }, { type: 'call.notice', callId, notice: { kind: 'guard', until: r!.guard_until, text: callGuardText(grace) } });
    fx.after(() => publishCall(callId));
    fx.after(() => touchCall(callId));
    fx.after(() => {
      setTimeout(() => evaluateGuard(callId), grace * 1000 + 200).unref();
    });
    return 'paused';
  }
  if (blocked && new Date(call.guard_until).getTime() > Date.now()) {
    // Reaplica a pausa a quem ainda publica (S3) e anula tokens novos de quem publicaria.
    await c.query(`UPDATE call_participants SET token_at = NULL WHERE call_id = $1 AND state = 'joining' AND granted_publish`, [callId]);
    await applyGrantsTx(c, fx, call, room);
    return 'still';
  }
  if (blocked) {
    await endGroupCallTx(c, fx, call, 'restricted', null);
    return 'ended';
  }
  if (call.guard_until) {
    await c.query(`UPDATE calls SET guard_until = NULL WHERE id = $1`, [callId]);
    call = await loadCallRow(callId, c);
    await applyGrantsTx(c, fx, call, room);
    fx.publish({ users: present }, { type: 'call.notice', callId, notice: { kind: 'guard-cleared', text: CALL_GUARD_CLEARED } });
    fx.after(() => publishCall(callId));
    fx.after(() => touchCall(callId));
    return 'cleared';
  }
  return 'none';
}

// Um acompanhante caiu: a trava confere de novo quando a tolerância de 8 s acaba (a reconciliação também confere).
export function recheckAfterChaperoneGrace(callId: string) {
  setTimeout(() => evaluateGuard(callId), CALL_LIMITS.chaperoneGraceSeconds * 1000 + 200).unref();
}
