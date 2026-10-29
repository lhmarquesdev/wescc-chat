import type { Call, CallEndReason, CallJoin, CallKind, UserRef } from '@shared/index';
import { CALL_GUARD_ENDED, CALL_LIMITS, callEndedReasonText } from '@shared/calls';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { rolesHavePermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import type { Ctx } from '../services/users';
import { finalCard, postCard, touchCall } from './card';
import { assertJoinSafe } from './guard';
import { publishInCall } from './incall';
import { hit } from './limits';
import { joinToken, SfuError } from './livekit';
import {
  activeCallOf,
  currentCallOf,
  lk,
  loadCall,
  loadCallRow,
  loadParticipants,
  loadRoomInfo,
  lockEntries,
  markRoomSeen,
  presentIds,
  presentSql,
  publishCall,
  publishCallTo,
  roomPath,
  roomSeenRecently,
  withCallLock,
  type Db,
  type Effects,
} from './model';
import { ERR, grantsFor, joinCheck, loadViewer, managementRoles, maxListeners, rightsFor, serverFull } from './policy';
import { afterLeaveTx, leaveRowsTx, revokedSql, updateClocksTx } from './presence';
import { callView } from './views';

// Chamadas em grupo (§5.6–§5.8, §5.12): iniciar, entrar, sair, encerrar, chamar pessoas e avisar a sala.

export const roomOptions = (_call?: any) => ({ emptyTimeout: 120, departureTimeout: 40, maxParticipants: maxListeners() + 5 });
const ringTimeout = () => Number(getSetting('Calls_Ring_Timeout')) || 40;
const userRef = (r: any): UserRef => ({ _id: r.id ?? r.user_id, username: r.username, name: r.name });

// ---------- Token ----------

async function joinFor(call: any, userId: string): Promise<CallJoin> {
  const row = await one(`SELECT granted_publish, granted_sources, granted_hidden FROM call_participants WHERE call_id = $1 AND user_id = $2`, [call.id, userId]);
  const sources = row.granted_publish ? row.granted_sources : [];
  const t = joinToken({ room: call.sfu_room, identity: userId, canPublish: row.granted_publish, sources, hidden: row.granted_hidden });
  return {
    token: t.token,
    expiresAt: t.expiresAt,
    identity: userId,
    canPublish: row.granted_publish,
    sources,
    hidden: row.granted_hidden,
    maxVideoPublishers: Number(getSetting('Calls_Max_Video_Publishers')) || 16,
  };
}

// ---------- Encerrar ----------

export async function endGroupCallTx(c: Db, fx: Effects, call: any, reason: CallEndReason, by: UserRef | null) {
  const ended = await one(
    `UPDATE calls SET status = 'ended', ended_at = now(), ended_by = $3, ended_reason = $2, guard_until = NULL
      WHERE id = $1 AND status = 'ongoing' RETURNING id`,
    [call.id, reason, by?._id ?? null],
    c,
  );
  if (!ended) return false;
  const present = await presentIds(call.id, c);
  const ringing = (await many(`SELECT user_id FROM call_participants WHERE call_id = $1 AND state = 'ringing'`, [call.id], c)).map((r) => r.user_id);
  await leaveRowsTx(c, call.id, (await many(`SELECT user_id FROM call_participants WHERE call_id = $1 AND state IN ('joining', 'joined')`, [call.id], c)).map((r) => r.user_id), 'ended');
  await c.query(`UPDATE call_participants SET state = 'missed', left_at = now() WHERE call_id = $1 AND state = 'ringing'`, [call.id]);
  await c.query(`UPDATE call_participants SET hand_at = NULL WHERE call_id = $1 AND hand_at IS NOT NULL`, [call.id]);
  const sfuRoom = call.sfu_room;
  if (sfuRoom) fx.sfu(() => lk.deleteRoom(sfuRoom));
  const callId = call.id;
  const rid = call.room_id;
  fx.after(() => finalCard(callId));
  fx.after(() => publishCall(callId, present));
  fx.publish({ room: rid }, { type: 'call.room', rid, call: null });
  const text = reason === 'restricted' ? CALL_GUARD_ENDED : callEndedReasonText(reason, by);
  if (text) fx.publish({ users: present }, { type: 'call.notice', callId, notice: { kind: 'ended', reason, text } });
  fx.after(async () => {
    const row = await loadCallRow(callId);
    if (!row || !ringing.length) return;
    const view = await callView(row, null, { room: true });
    bus.publish({ users: ringing }, { type: 'call.ring', action: 'stop', call: view });
  });
  for (const u of present) fx.after(() => publishInCall(u));
  return true;
}

export async function endGroupCall(callId: string, reason: CallEndReason, by: UserRef | null = null) {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || call.status !== 'ongoing' || call.scope !== 'group') return false;
    return endGroupCallTx(c, fx, call, reason, by);
  });
}

// ---------- Anfitrião ----------

// O papel passa para quem está dentro há mais tempo e tem call-management na sala (operadores nunca). Sem ninguém assim,
// a chamada fica sem anfitrião até alguém com call-management entrar. candidate: só essa pessoa pode assumir.
export async function handOverTx(c: Db, fx: Effects, call: any, _room: any, o: { candidate?: string } = {}) {
  const rows = await loadParticipants(call.id, c);
  if (rows.some((r) => r.host && r.state === 'joined')) return null;
  const next = rows
    .filter((r) => r.state === 'joined' && r.type === 'user' && r.active && r.member && (!o.candidate || r.user_id === o.candidate))
    .filter((r) => rolesHavePermission(managementRoles(r.global_roles, r.room_roles), 'call-management'))
    .sort((a, b) => new Date(a.last_joined_at).getTime() - new Date(b.last_joined_at).getTime())[0];
  await c.query(`UPDATE call_participants SET host = false WHERE call_id = $1 AND host AND state <> 'joined'`, [call.id]);
  if (!next) return null;
  await c.query(`UPDATE call_participants SET host = (user_id = $2) WHERE call_id = $1`, [call.id, next.user_id]);
  const callId = call.id;
  fx.publish({ user: next.user_id }, { type: 'call.notice', callId, notice: { kind: 'host', text: 'Agora você é o anfitrião da chamada.' } });
  fx.after(() => publishCall(callId));
  return next.user_id as string;
}

export async function handOver(callId: string) {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || call.status !== 'ongoing') return null;
    return handOverTx(c, fx, call, null);
  });
}

// ---------- Iniciar ----------

// Depois das verificações de calls.start (services/calls.ts). A sala do LiveKit só é criada depois do commit; se falhar,
// a chamada some (nada aconteceu ainda para ninguém).
export async function startGroupCall(ctx: Ctx, room: any, kind: CallKind): Promise<{ call: Call; join: CallJoin }> {
  const id = newId();
  const ring = room.t === 'd';
  const viewer = (await loadViewer(ctx.userId, null, room.id))!;
  try {
    await withCallLock(id, async (c) => {
      // De novo sob a trava de entradas: outro início ou outra entrada (em qualquer chamada, em qualquer instância) pode
      // ter ocupado a última vaga do servidor, ou posto esta pessoa em outra chamada, depois das verificações de calls.start.
      await lockEntries(c);
      if (await serverFull(false, c)) throw ERR.capacity();
      if (await activeCallOf(ctx.userId, { except: id }, c)) throw ERR.inProgress();
      await c.query(
        `INSERT INTO calls (id, room_id, caller_id, callee_id, kind, status, caller_conn, scope, media, sfu_room, listen_only, ring)
         VALUES ($1, $2, $3, NULL, $4, 'ongoing', NULL, 'group', 'sfu', $5, false, $6)`,
        [id, room.id, ctx.userId, kind, `wc_${id}`, ring],
      );
      const call = await loadCallRow(id, c);
      const g = grantsFor(viewer, call, room, viewer.roles, null);
      await c.query(
        `INSERT INTO call_participants (call_id, user_id, host, state, created_at, token_at, granted_publish, granted_sources, granted_hidden)
         VALUES ($1, $2, true, 'joining', $3, now(), $4, $5, $6)`,
        [id, ctx.userId, call.created_at, g.canPublish, g.sources, g.hidden],
      );
      if (ring) await insertDmRingsTx(c, call, room, ctx.userId);
      await updateClocksTx(c, id);
    });
  } catch (e) {
    if ((e as any)?.code === '23505') {
      const live = await one(`SELECT id FROM calls WHERE room_id = $1 AND scope = 'group' AND status = 'ongoing'`, [room.id]);
      throw ERR.exists(live?.id ?? '');
    }
    throw e;
  }
  const row = await loadCallRow(id);
  try {
    await lk.createRoom(row.sfu_room, roomOptions(row));
  } catch (e) {
    await query('DELETE FROM calls WHERE id = $1', [id]);
    // Configuração apagada entre a conferência e o CreateRoom: o motivo é o de não configurado, não o de queda.
    throw e instanceof SfuError && e.code === 'not_configured' ? ERR.sfuNotConfigured() : ERR.sfu();
  }
  markRoomSeen(id);
  await postCard(id);
  bus.publish({ room: room.id }, { type: 'call.room', rid: room.id, call: await callView((await loadCallRow(id))!, null, { guard: true }) });
  if (ring) await sendRings(id, ctx, (await many(`SELECT user_id FROM call_participants WHERE call_id = $1 AND state = 'ringing'`, [id])).map((r) => r.user_id));
  void publishInCall(ctx.userId);
  const join = await joinFor(row, ctx.userId);
  const call = await callView((await loadCallRow(id))!, ctx.userId, { participants: true, mine: true, room: true, guard: true });
  return { call, join };
}

// DM com várias pessoas: toca para cada outro membro ativo e humano que não está em outra chamada (senão, perdida por ocupado).
async function insertDmRingsTx(c: Db, call: any, room: any, starterId: string) {
  const others = await many(
    `SELECT u.id, u.active, u.type,
            EXISTS (SELECT 1 FROM call_participants q JOIN calls k ON k.id = q.call_id
                     WHERE q.user_id = u.id AND k.status IN ('ringing', 'ongoing') AND k.id <> $3 AND ${presentSql('q')} AND NOT q.granted_hidden) AS busy
       FROM users u WHERE u.id = ANY($1) AND u.id <> $2`,
    [room.uids, starterId, call.id],
    c,
  );
  for (const u of others) {
    if (!u.active || u.type !== 'user') continue;
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, host, state, created_at, rung_at, rung_by, left_at, left_reason)
       VALUES ($1, $2, false, $3, $4, now(), $5, CASE WHEN $3 = 'missed' THEN now() END, CASE WHEN $3 = 'missed' THEN 'busy' END)`,
      [call.id, u.id, u.busy ? 'missed' : 'ringing', call.created_at, starterId],
    );
  }
}

// Toque em todos os aparelhos, push para quem está com o chat fechado e o tempo de toque.
async function sendRings(callId: string, by: { userId: string; username: string }, userIds: string[]) {
  if (!userIds.length) return;
  const row = await loadCallRow(callId);
  if (!row) return;
  const room = await loadRoomInfo(row.room_id);
  const view = await callView(row, null, { room: true });
  const me = await one('SELECT id, username, name FROM users WHERE id = $1', [by.userId]);
  const byRef = userRef(me ?? { id: by.userId, username: by.username });
  for (const u of userIds) bus.publish({ user: u }, { type: 'call.ring', action: 'ring', call: view, by: byRef });
  if (getSetting('Push_enable')) {
    const online = new Set((await many('SELECT DISTINCT user_id FROM presence_connections WHERE user_id = ANY($1)', [userIds])).map((r) => r.user_id));
    const offline = userIds.filter((u) => !online.has(u));
    if (offline.length) {
      const { sendPush } = await import('../services/push');
      const body = `@${by.username} está chamando você · Chamada ${row.kind === 'video' ? 'de vídeo' : 'de voz'} em grupo`;
      let title = room.fname || room.name || '';
      if (room.t === 'd' && !title) title = (room.usernames ?? []).join(', ');
      void sendPush(offline, { title, body, url: `${roomPath(room)}#call`, tag: `call-${callId}` }).catch(() => {});
    }
  }
  setTimeout(() => void expireRings(callId).catch(() => {}), ringTimeout() * 1000 + 200).unref();
}

// Toques vencidos viram perdidos (pelo temporizador e pela varredura).
export async function expireRings(callId: string) {
  const gone = await withCallLock(callId, async (c) => {
    const rows = await many(
      `UPDATE call_participants SET state = 'missed', left_at = now()
        WHERE call_id = $1 AND state = 'ringing' AND rung_at < now() - make_interval(secs => $2) RETURNING user_id`,
      [callId, ringTimeout()],
      c,
    );
    return rows.map((r) => r.user_id as string);
  });
  if (!gone.length) return;
  const row = await loadCallRow(callId);
  if (!row) return;
  const view = await callView(row, null, { room: true });
  bus.publish({ users: gone }, { type: 'call.ring', action: 'stop', call: view });
}

// ---------- Entrar ----------

export async function joinCall(ctx: Ctx, callId: string, o: { leaveCurrent?: boolean } = {}): Promise<{ call: Call; join: CallJoin }> {
  const pre = await loadCallRow(callId);
  if (!pre) throw ERR.notFound();
  const room = await loadRoomInfo(pre.room_id);
  const v = await joinCheck(ctx, pre, room, { leaveCurrent: o.leaveCurrent });
  if (!v.allowed) throw v.error!;
  hit(ctx.userId, 'join', 20, 60_000);
  if (o.leaveCurrent) {
    const { leaveCurrentCall } = await import('../services/calls');
    await leaveCurrentCall(ctx, callId);
  }
  await withCallLock(callId, async (c, fx) => {
    // De novo dentro da trava: duas entradas ao mesmo tempo não passam juntas pela trava de restritos nem pelo limite.
    const call = await loadCallRow(callId, c);
    const again = await joinCheck(ctx, call, room, { leaveCurrent: true, db: c, server: false });
    if (!again.allowed) throw again.error!;
    const viewer = again.viewer!;
    // Limite do servidor e uma chamada por pessoa valem entre chamadas diferentes: só sob a trava de entradas, que
    // fica até o commit desta gravação.
    await lockEntries(c);
    if (call.media === 'sfu' && (await serverFull(!!viewer.row?.present, c))) throw ERR.capacity();
    if (await currentCallOf(ctx.userId, { except: callId }, c)) throw ERR.inProgress();
    const g = grantsFor(viewer, call, room, viewer.roles, viewer.row);
    if (viewer.row?.state === 'joined') {
      // A sessão conectada segue com a permissão de antes até a próxima conexão ou a reconciliação: o que saiu fica
      // guardado (faixas).
      await c.query(
        `UPDATE call_participants SET token_at = now(), granted_publish = $3, granted_sources = $4, granted_hidden = $5, ${revokedSql(4)}
          WHERE call_id = $1 AND user_id = $2`,
        [callId, ctx.userId, g.canPublish, g.sources, g.hidden],
      );
    } else {
      await c.query(
        `INSERT INTO call_participants (call_id, user_id, host, state, created_at, token_at, granted_publish, granted_sources, granted_hidden)
         VALUES ($1, $2, false, 'joining', $3, now(), $4, $5, $6)
         ON CONFLICT (call_id, user_id) DO UPDATE SET state = 'joining', token_at = now(), granted_publish = $4, granted_sources = $5,
           granted_hidden = $6, left_reason = NULL, removed_by = NULL, left_at = NULL, hand_at = NULL`,
        [callId, ctx.userId, call.created_at, g.canPublish, g.sources, g.hidden],
      );
    }
    await updateClocksTx(c, callId);
    const wasRinging = viewer.row?.state === 'ringing';
    if (wasRinging) fx.publish({ user: ctx.userId }, { type: 'call.ring', action: 'stop', call: (await callView(call, null, { room: true }, c)) });
    fx.after(() => touchCall(callId));
    fx.after(() => publishInCall(ctx.userId));
  });
  const row = await loadCallRow(callId);
  // Depois de um reinício do LiveKit a sala pode não existir: recria antes do token (já existir não é erro).
  if (row.sfu_missing_since || !roomSeenRecently(callId)) {
    await lk.createRoom(row.sfu_room, roomOptions(row)).then(() => markRoomSeen(callId), () => {});
  }
  const join = await joinFor(row, ctx.userId);
  return { call: await callView(row, ctx.userId, { participants: true, mine: true, room: true, guard: true }), join };
}

// ---------- Sair e recusar ----------

export async function leaveCall(ctx: Ctx, callId: string): Promise<Call> {
  await withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || call.status !== 'ongoing') return;
    const room = await loadRoomInfo(call.room_id, c);
    const row = await one(`SELECT state FROM call_participants WHERE call_id = $1 AND user_id = $2`, [callId, ctx.userId], c);
    if (row?.state === 'ringing') return void (await declineRingTx(c, fx, call, ctx.userId));
    const left = await leaveRowsTx(c, callId, [ctx.userId], 'hangup');
    if (!left.length) return;
    const sfuRoom = call.sfu_room;
    fx.sfu(() => lk.removeParticipant(sfuRoom, ctx.userId));
    fx.after(() => publishCallTo(callId, [ctx.userId]));
    // O último a sair encerra na hora (um adeus explícito); com gente dentro, a chamada segue.
    if (!(await presentIds(callId, c)).length) {
      await endGroupCallTx(c, fx, call, 'empty', null);
      fx.after(() => publishInCall(ctx.userId));
      return;
    }
    await afterLeaveTx(c, fx, call, room, left);
  });
  return callView((await loadCall(callId))!, ctx.userId, { mine: true, room: true });
}

async function declineRingTx(c: Db, fx: Effects, call: any, userId: string) {
  const r = await one(`UPDATE call_participants SET state = 'declined', left_at = now() WHERE call_id = $1 AND user_id = $2 AND state = 'ringing' RETURNING user_id`, [call.id, userId], c);
  if (!r) return false;
  // Para de tocar nos outros aparelhos da pessoa.
  fx.publish({ user: userId }, { type: 'call.ring', action: 'stop', call: await callView(call, null, { room: true }, c) });
  return true;
}

export async function declineRing(ctx: Ctx, callId: string): Promise<Call> {
  await withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || call.scope !== 'group') return;
    await declineRingTx(c, fx, call, ctx.userId);
  });
  return callView((await loadCall(callId))!, ctx.userId, { mine: true, room: true });
}

// ---------- Chamar e avisar ----------

type SkipReason = 'not-member' | 'inactive' | 'present' | 'busy' | 'restricted' | 'removed';

export async function ringPeople(ctx: Ctx, callId: string, userIds: string[]) {
  const call = await loadCall(callId);
  if (call.scope !== 'group' || call.status !== 'ongoing') throw ERR.ended();
  const room = await loadRoomInfo(call.room_id);
  const viewer = await loadViewer(ctx.userId, callId, call.room_id);
  if (!viewer || !rightsFor(viewer, call, room).canRing) throw ERR.cannotRing();
  const ids = [...new Set(userIds)].filter((id) => id !== ctx.userId);
  if (!ids.length || ids.length > CALL_LIMITS.ringPerAction) throw badRequest('error-call-ring-limit', 'Chame até 10 pessoas por vez.');
  hit(ctx.userId, 'ring', CALL_LIMITS.ringActionsPerMinute, 60_000);
  const canClear = !!viewer.row?.host || rolesHavePermission(viewer.mgmtRoles, 'moderate-call');
  const users = await many(
    `SELECT u.id, u.username, u.name, u.active, u.type, (s.id IS NOT NULL) AS member, p.state, p.left_reason,
            ${presentSql()} AS present,
            EXISTS (SELECT 1 FROM call_participants q JOIN calls k ON k.id = q.call_id
                     WHERE q.user_id = u.id AND k.status IN ('ringing', 'ongoing') AND k.id <> $2 AND ${presentSql('q')} AND NOT q.granted_hidden) AS busy
       FROM users u
       LEFT JOIN subscriptions s ON s.room_id = $3 AND s.user_id = u.id
       LEFT JOIN call_participants p ON p.call_id = $2 AND p.user_id = u.id
      WHERE u.id = ANY($1)`,
    [ids, callId, call.room_id],
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  const rung: UserRef[] = [];
  const skipped: { user: UserRef; reason: SkipReason }[] = [];
  const toRing: string[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    if (!u) continue;
    const ref = userRef(u);
    let reason: SkipReason | null = null;
    if (!u.member) reason = 'not-member';
    else if (!u.active || u.type !== 'user') reason = 'inactive';
    else if (u.present) reason = 'present';
    else if (u.busy) reason = 'busy';
    else {
      try {
        await assertJoinSafe(call, room, id);
      } catch {
        reason = 'restricted';
      }
      if (!reason && u.state === 'left' && u.left_reason === 'removed' && !canClear) reason = 'removed';
    }
    if (reason) skipped.push({ user: ref, reason });
    else {
      rung.push(ref);
      toRing.push(id);
    }
  }
  if (toRing.length) {
    const late = await withCallLock(callId, async (c) => {
      // De novo sob a trava: a pessoa pode ter sido removida (ou ter entrado) depois da verificação acima, e só o
      // anfitrião ou quem tem moderate-call desfaz uma remoção (S9).
      const me = await loadViewer(ctx.userId, callId, call.room_id, c);
      const clear = !!me?.row?.host || rolesHavePermission(me?.mgmtRoles ?? [], 'moderate-call');
      const out: { id: string; reason: SkipReason }[] = [];
      for (const id of toRing) {
        const r = await one(
          `INSERT INTO call_participants (call_id, user_id, host, state, created_at, rung_at, rung_by)
           VALUES ($1, $2, false, 'ringing', $3, now(), $4)
           ON CONFLICT (call_id, user_id) DO UPDATE SET state = 'ringing', rung_at = now(), rung_by = $4, left_at = NULL,
             left_reason = CASE WHEN call_participants.left_reason = 'removed' THEN NULL ELSE call_participants.left_reason END,
             removed_by = NULL
           WHERE call_participants.state NOT IN ('joined', 'joining')
             AND ($5 OR NOT (call_participants.state = 'left' AND call_participants.left_reason = 'removed'))
           RETURNING user_id`,
          [callId, id, call.created_at, ctx.userId, clear],
          c,
        );
        if (r) continue;
        const now = await one(`SELECT state, left_reason FROM call_participants WHERE call_id = $1 AND user_id = $2`, [callId, id], c);
        out.push({ id, reason: now?.state === 'left' && now.left_reason === 'removed' ? 'removed' : 'present' });
      }
      return out;
    });
    for (const { id, reason } of late) {
      const i = rung.findIndex((u) => u._id === id);
      skipped.push({ user: rung[i], reason });
      rung.splice(i, 1);
      toRing.splice(toRing.indexOf(id), 1);
    }
    await sendRings(callId, ctx, toRing);
  }
  return { rung, skipped };
}

// "Avisar a sala": um aviso sem toque, como o @here, para quem está online e não silenciou a sala. Uma vez a cada 10 min.
export async function inviteRoom(ctx: Ctx, callId: string) {
  const call = await loadCall(callId);
  if (call.scope !== 'group' || call.status !== 'ongoing') throw ERR.ended();
  const room = await loadRoomInfo(call.room_id);
  if (room.t === 'd') throw badRequest('error-invalid-params', 'Nas conversas diretas, use Chamar.');
  const viewer = await loadViewer(ctx.userId, callId, call.room_id);
  if (!viewer || !rightsFor(viewer, call, room).canRing) throw ERR.cannotRing();
  const ok = await one(
    `UPDATE calls SET invited_at = now() WHERE id = $1 AND (invited_at IS NULL OR invited_at <= now() - make_interval(mins => ${CALL_LIMITS.inviteEveryMinutes})) RETURNING id`,
    [callId],
  );
  if (!ok) {
    const r = await one(`SELECT CEIL(EXTRACT(EPOCH FROM invited_at + make_interval(mins => ${CALL_LIMITS.inviteEveryMinutes}) - now()) / 60)::int AS n FROM calls WHERE id = $1`, [callId]);
    throw new ApiError(429, 'error-call-invite-wait', `Aguarde ${Math.max(1, r?.n ?? 1)} min para avisar a sala de novo.`);
  }
  const rows = await many(
    `SELECT u.id FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.room_id = $1 AND u.id <> $2 AND u.active AND u.type = 'user' AND u.status <> 'offline'
        AND coalesce((s.notifications->>'disableNotifications')::boolean, false) = false
        AND coalesce((s.notifications->>'muteGroupMentions')::boolean, false) = false
        AND coalesce(nullif(s.notifications->>'desktop', 'default'), u.preferences->>'desktopNotifications', 'mentions') <> 'nothing'
        AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = $3 AND p.user_id = u.id AND ${presentSql()})`,
    [call.room_id, ctx.userId, callId],
  );
  const ids = rows.map((r) => r.id as string);
  if (ids.length) {
    const me = await one('SELECT id, username, name FROM users WHERE id = $1', [ctx.userId]);
    bus.publish({ users: ids }, { type: 'call.invite', call: await callView((await loadCallRow(callId))!, null, { room: true }), by: userRef(me) });
  }
  return { notified: ids.length };
}
