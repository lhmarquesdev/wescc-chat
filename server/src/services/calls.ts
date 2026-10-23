import crypto from 'node:crypto';
import type { Call, CallEndReason, CallJoin, CallKind, CallLeftReason, CallSignal, CallStatus, CallsConfig, RoomCallState, UserRef } from '@shared/index';
import { CALL_LIMITS, callEndedReasonText, callScopeOf, isTransmissionRoom } from '@shared/calls';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { declineRing, endGroupCall, joinCall, leaveCall, startGroupCall } from '../calls/group';
import { inCallIds, publishInCall } from '../calls/incall';
import { hit } from '../calls/limits';
import { sfuConfig } from '../calls/livekit';
import { CALL_SELECT, LIVE, activeCallOf, callScope, isLive, liveCallOfRoom, lk, loadCall, loadCallRow, loadRoomInfo, lockEntries, presentSql, publishCall, withCallLock } from '../calls/model';
import { ERR, callsEnabled, joinCheck, loadViewer, maxListeners, maxParticipants, resolveMedia, rightsFor, serverFull, startCheck, viewerGuardOf } from '../calls/policy';
import { entryGate, leaveGate } from '../calls/queue';
import { callView, callViews } from '../calls/views';
import { audit } from './audit';
import { callPolicies } from './direct';
import { sendSystemMessage } from './messages';
import { restrictedRoleIds } from './permissions';
import { canAccessRoom } from './rooms';
import { getSetting } from './settings';
import { actorOf, type Ctx } from './users';

export { sweepCalls } from '../calls/sweep';

// Entrada das chamadas. A dois (DM com duas pessoas) segue como sempre: o servidor guarda o estado e o histórico e
// repassa a sinalização WebRTC entre as duas conexões; o áudio e o vídeo vão direto entre os navegadores. Em grupo
// (canais, grupos, times, discussões e DMs com mais pessoas), a mídia passa pelo servidor de chamadas (calls/group.ts).

const ACTIVE = ['ringing', 'ongoing'];
const FINAL_MESSAGE: Partial<Record<CallStatus, string>> = { missed: 'call_missed', declined: 'call_missed', canceled: 'call_missed', busy: 'call_missed', ended: 'call_ended' };

const ringTimeout = () => Number(getSetting('Calls_Ring_Timeout')) || 40;

async function userRef(userId: string): Promise<UserRef> {
  const u = await one('SELECT id, username, name FROM users WHERE id = $1', [userId]);
  return { _id: userId, username: u?.username ?? '', name: u?.name };
}

// A conexão informada precisa ser um WebSocket aberto desta mesma sessão (é por ela que a sinalização passa).
async function assertOwnConnection(ctx: Ctx, connectionId: unknown) {
  const id = typeof connectionId === 'string' ? connectionId : '';
  if (!id || !(await one('SELECT 1 FROM presence_connections WHERE id = $1 AND user_id = $2 AND session_id = $3', [id, ctx.userId, ctx.sessionId]))) {
    throw badRequest('error-call-connection', 'Conexão em tempo real não encontrada. Recarregue a página e tente de novo.');
  }
  return id;
}

// ---------- Configuração ----------

// TURN REST (o coturn confere): usuário "<validade>:<id>" e senha base64(HMAC-SHA1(segredo, usuário)), por 24 h.
export function turnCredentials(secret: string, userId: string, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + 24 * 3600}:${userId}`;
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

export async function callConfig(userId?: string): Promise<CallsConfig> {
  const iceServers: CallsConfig['iceServers'] = [];
  const stun = String(getSetting('Calls_STUN_Servers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length) iceServers.push({ urls: stun });
  const turn = String(getSetting('Calls_TURN_Server') ?? '').trim();
  if (turn) {
    const urls = turn.split(',').map((s) => s.trim()).filter(Boolean);
    const secret = String(getSetting('Calls_TURN_Secret') ?? '');
    if (secret && userId) iceServers.push({ urls, ...turnCredentials(secret, userId) });
    else iceServers.push({ urls, username: getSetting<string>('Calls_TURN_Username') || undefined, credential: getSetting<string>('Calls_TURN_Password') || undefined });
  }
  const configured = sfuConfig().configured;
  const sfu = configured && (await lk.health()).ok;
  return {
    enabled: callsEnabled(),
    groupEnabled: !!getSetting('Calls_Group_Enabled') && configured,
    directViaSfu: !!getSetting('Calls_Direct_Via_SFU'),
    inNoticeRooms: !!getSetting('Calls_In_Notice_Rooms'),
    ringTimeout: ringTimeout(),
    sfu,
    iceServers,
    limits: {
      participants: maxParticipants(),
      listeners: maxListeners(),
      videoPublishers: Number(getSetting('Calls_Max_Video_Publishers')) || 16,
      maxHours: Number(getSetting('Calls_Max_Duration_Hours')) || 12,
      ringPerAction: CALL_LIMITS.ringPerAction,
    },
    serverTime: new Date().toISOString(),
  };
}

// ---------- Iniciar ----------

export interface StartInput {
  roomId: string;
  kind: CallKind;
  connectionId?: unknown;
  leaveCurrent?: boolean;
  engines?: string[];
}

// §5.6, nesta ordem. Só o início em grupo passa pela fila de entradas: a dois (P2P) nunca espera atrás de uma
// enxurrada de entradas em chamadas de grupo.
export async function startCall(ctx: Ctx, input: StartInput): Promise<{ call: Call; join?: CallJoin }> {
  if (!callsEnabled()) throw forbidden('As chamadas estão desativadas.');
  if (input.kind !== 'audio' && input.kind !== 'video') throw badRequest('error-invalid-params', 'Tipo de chamada inválido.');
  const room = await loadRoomInfo(input.roomId);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  return callScopeOf(room) === 'group' ? entryGate(() => startChecked(ctx, room, input)) : startChecked(ctx, room, input);
}

async function startChecked(ctx: Ctx, room: any, input: StartInput): Promise<{ call: Call; join?: CallJoin }> {
  const v = await startCheck(ctx, room);
  if (!v.allowed) throw v.error!;
  const scope = v.scope!;
  // Conta só agora, depois da política.
  if (scope === 'group') hit(ctx.userId, 'start-group', 3, 60_000);
  else hit(ctx.userId, 'start-direct', 10, 60_000);
  if (scope === 'group') {
    const live = await liveCallOfRoom(room.id);
    if (live) throw ERR.exists(live.id);
  }
  if (await activeCallOf(ctx.userId)) {
    if (!input.leaveCurrent) throw ERR.inProgress();
    await leaveCurrentCall(ctx);
  }
  if (scope === 'group' && (await serverFull(false))) throw ERR.capacity();
  const media = await resolveMedia(scope, { engines: input.engines, connectionId: typeof input.connectionId === 'string' ? input.connectionId : undefined });
  if (!media.allowed) throw media.error;
  if (scope === 'group') return startGroupCall(ctx, room, input.kind);
  return { call: await startDirect(ctx, room, input.kind, input.connectionId) };
}

async function startDirect(ctx: Ctx, room: any, kind: CallKind, connectionId: unknown): Promise<Call> {
  const conn = await assertOwnConnection(ctx, connectionId);
  const calleeId = room.uids.find((u: string) => u !== ctx.userId) as string;
  const id = newId();
  const busy = await withCallLock(id, async (c) => {
    // Sob a trava de entradas, como as entradas em grupo: uma entrada em outra chamada (em qualquer instância) que
    // gravou depois da conferência de calls.start aparece aqui (G27).
    await lockEntries(c);
    if (await activeCallOf(ctx.userId, {}, c)) throw ERR.inProgress();
    // Quem está em outra chamada (ou tocando) recebe como ocupado; ouvinte oculto de transmissão, não.
    const busy = !!(await activeCallOf(calleeId, { hiddenToo: false }, c));
    const r = await one(
      `INSERT INTO calls (id, room_id, caller_id, callee_id, kind, status, caller_conn, ended_at, scope, media)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'busy' THEN now() END, 'direct', 'p2p') RETURNING created_at`,
      [id, room.id, ctx.userId, calleeId, kind, busy ? 'busy' : 'ringing', conn],
      c,
    );
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, host, state, created_at, session_id, joined_at, last_joined_at, left_at, left_reason)
       VALUES ($1, $2, true, $3, $4, $5, now(), now(), CASE WHEN $3 = 'left' THEN now() END, CASE WHEN $3 = 'left' THEN 'ended' END)`,
      [id, ctx.userId, busy ? 'left' : 'joined', r!.created_at, conn],
    );
    await c.query(
      `INSERT INTO call_participants (call_id, user_id, host, state, created_at, rung_at, rung_by, left_at, left_reason)
       VALUES ($1, $2, false, $3, $4, now(), $5, CASE WHEN $3 = 'missed' THEN now() END, CASE WHEN $3 = 'missed' THEN 'busy' END)`,
      [id, calleeId, busy ? 'missed' : 'ringing', r!.created_at, ctx.userId],
    );
    return busy;
  });
  await publishCall(id);
  const row = await loadCallRow(id);
  if (busy) {
    await finalMessage(row);
  } else {
    // Quem está com o chat fechado recebe o toque como notificação push.
    const online = await one('SELECT 1 FROM presence_connections WHERE user_id = $1 LIMIT 1', [calleeId]);
    if (!online) {
      const { sendPush } = await import('./push');
      void sendPush([calleeId], { title: ctx.username, body: kind === 'video' ? '🎥 Chamada de vídeo' : '📞 Chamada de voz', url: `/direct/${room.id}`, tag: `call-${id}` }).catch(() => {});
    }
    setTimeout(() => void finishDirect(id, ['ringing'], 'missed', null, 'no-answer', () => 'ended').catch(() => {}), ringTimeout() * 1000).unref();
    publishInCall(ctx.userId);
  }
  return callView(row, ctx.userId, { participants: true, mine: true, room: true });
}

// Muda o estado só se a chamada ainda estiver em um dos estados esperados (evita corrida entre atender e desligar).
// leftOf: o motivo de saída de cada lado no histórico por pessoa.
async function finishDirect(id: string, from: CallStatus[], to: CallStatus, by: string | null, reason: CallEndReason | null, leftOf: (userId: string) => CallLeftReason) {
  const row = await withCallLock(id, async (c) => {
    const r = await one(
      `UPDATE calls SET status = $3, ended_at = now(), ended_by = $4, ended_reason = $5 WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [id, from, to, by, reason],
      c,
    );
    if (!r) return null;
    const seconds = r.answered_at ? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.answered_at)) / 1000)) : 0;
    for (const uid of [r.caller_id, r.callee_id].filter(Boolean)) {
      await c.query(
        `UPDATE call_participants SET
            state = CASE WHEN state = 'ringing' THEN $3 ELSE 'left' END,
            left_reason = CASE WHEN state = 'ringing' THEN NULL ELSE $4 END,
            seconds = CASE WHEN state = 'ringing' THEN 0 ELSE $5::int END,
            left_at = now(), hand_at = NULL
          WHERE call_id = $1 AND user_id = $2 AND state IN ('ringing', 'joining', 'joined')`,
        [id, uid, to === 'declined' ? 'declined' : 'missed', leftOf(uid), seconds],
      );
    }
    return r;
  });
  if (!row) return false;
  await publishCall(id);
  await finalMessage(await loadCallRow(id));
  publishInCall(row.caller_id);
  if (row.callee_id) publishInCall(row.callee_id);
  return true;
}

const hangupBy = (by: string) => (u: string): CallLeftReason => (u === by ? 'hangup' : 'ended');

// Registro da chamada na própria DM (aparece no histórico da conversa).
async function finalMessage(r: any) {
  const t = FINAL_MESSAGE[r?.status as CallStatus];
  if (!t) return;
  const answered = r.answered_at ? Date.parse(r.answered_at) : null;
  const ended = r.ended_at ? Date.parse(r.ended_at) : null;
  const duration = answered && ended ? Math.max(0, Math.round((ended - answered) / 1000)) : null;
  await sendSystemMessage(r.room_id, t, { id: r.caller_id, username: r.caller_username }, '', { call: { _id: r.id, kind: r.kind, status: r.status, duration } }).catch(() => {});
}

// ---------- Atender, recusar, sair, encerrar ----------

const view = async (callId: string, userId: string) => callView(await loadCall(callId), userId, { mine: true, room: true });

export async function acceptCall(ctx: Ctx, callId: string, o: { connectionId?: unknown; leaveCurrent?: boolean; engines?: string[] } = {}): Promise<{ call: Call; join?: CallJoin }> {
  if ((await callScope(callId)) === 'group') return entryGate(() => joinCall(ctx, callId, { leaveCurrent: o.leaveCurrent }));
  const r = await loadCall(callId);
  const conn = await assertOwnConnection(ctx, o.connectionId);
  if (r.callee_id !== ctx.userId) throw forbidden();
  if (await activeCallOf(ctx.userId, { except: callId })) {
    if (!o.leaveCurrent) throw ERR.inProgress();
    await leaveCurrentCall(ctx, callId);
  }
  const ok = await withCallLock(callId, async (c) => {
    // De novo sob a trava de entradas: uma entrada em grupo (em outra instância) pode ter gravado depois da conferência
    // acima. O erro desfaz o atendimento, e a chamada segue tocando.
    await lockEntries(c);
    const u = await one(`UPDATE calls SET status = 'ongoing', callee_conn = $2, answered_at = now() WHERE id = $1 AND status = 'ringing' RETURNING id`, [callId, conn], c);
    if (!u) return false;
    if (await activeCallOf(ctx.userId, { except: callId }, c)) throw ERR.inProgress();
    await c.query(
      `UPDATE call_participants SET state = 'joined', session_id = $3, joined_at = coalesce(joined_at, now()), last_joined_at = now(), left_at = NULL, left_reason = NULL
        WHERE call_id = $1 AND user_id = $2`,
      [callId, ctx.userId, conn],
    );
    return true;
  });
  if (!ok) throw badRequest('error-call-not-ringing', 'Esta chamada já terminou.');
  await publishCall(callId);
  publishInCall(ctx.userId);
  return { call: await callView(await loadCall(callId), ctx.userId, { participants: true, mine: true, room: true }) };
}

export async function declineCall(ctx: Ctx, callId: string): Promise<Call> {
  const r = await loadCall(callId);
  if (r.scope === 'group') return declineRing(ctx, callId);
  if (r.callee_id !== ctx.userId) throw forbidden();
  await finishDirect(callId, ['ringing'], 'declined', ctx.userId, null, hangupBy(ctx.userId));
  return view(callId, ctx.userId);
}

// Desligar a dois: cancela (quem ligou), recusa (quem recebe) ou encerra a chamada em andamento. Em grupo, encerrar
// para todos: anfitrião ou moderate-call na sala.
export async function endCall(ctx: Ctx, callId: string): Promise<Call> {
  const r = await loadCall(callId);
  if (r.scope === 'group') {
    if (r.status !== 'ongoing') return view(callId, ctx.userId);
    const room = await loadRoomInfo(r.room_id);
    const v = await loadViewer(ctx.userId, callId, r.room_id);
    if (!v || !rightsFor(v, r, room).canEnd) throw ERR.notModerator();
    if (await endGroupCall(callId, 'moderator', await userRef(ctx.userId))) await audit(actorOf(ctx), 'call.end', { callId, rid: r.room_id });
    return view(callId, ctx.userId);
  }
  if (r.caller_id !== ctx.userId && r.callee_id !== ctx.userId) throw forbidden();
  if (r.status === 'ringing') await finishDirect(callId, ['ringing'], r.caller_id === ctx.userId ? 'canceled' : 'declined', ctx.userId, null, hangupBy(ctx.userId));
  else if (r.status === 'ongoing') await finishDirect(callId, ['ongoing'], 'ended', ctx.userId, 'hangup', hangupBy(ctx.userId));
  return view(callId, ctx.userId);
}

// Sair: a dois é o mesmo que desligar; em grupo, a chamada segue com os outros.
export async function leave(ctx: Ctx, callId: string): Promise<Call> {
  const scope = await callScope(callId);
  if (!scope) throw ERR.notFound();
  if (scope === 'direct') return endCall(ctx, callId);
  return leaveGate(() => leaveCall(ctx, callId));
}

// leaveCurrent: sai da chamada em que a pessoa está antes de iniciar, entrar ou atender outra.
export async function leaveCurrentCall(ctx: Ctx, except?: string) {
  for (let i = 0; i < 3; i++) {
    const cur = await activeCallOf(ctx.userId, { except });
    if (!cur) return;
    await leave(ctx, cur.id);
  }
}

// ---------- Leituras ----------

export async function getCall(ctx: Ctx, callId: string): Promise<Call> {
  const r = await loadCall(callId);
  if (r.scope === 'direct') {
    if (r.caller_id !== ctx.userId && r.callee_id !== ctx.userId) throw forbidden();
  } else {
    // Membro da sala, ou quem está na chamada ou sendo chamado agora. Quem saiu da sala (ou foi expulso) não vê mais
    // quem está na chamada; o próprio histórico continua em calls.list.
    const allowed = await one(
      `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2)
          OR EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = $3 AND p.user_id = $2 AND (p.state = 'ringing' OR ${presentSql()}))`,
      [r.room_id, ctx.userId, callId],
    );
    if (!allowed) throw forbidden();
  }
  return callView(r, ctx.userId, { participants: true, mine: true, room: true, guard: true });
}

export type CallListFilter = 'all' | 'missed' | 'incoming' | 'outgoing';

// Histórico por pessoa (call_participants): as minhas chamadas encerradas, da mais nova para a mais antiga. Em grupo,
// só as que entrei, para as quais fui chamado ou que iniciei.
export async function listCalls(ctx: Ctx, opts: { offset: number; count: number; filter?: CallListFilter; roomId?: string }) {
  const where = [
    'p.user_id = $1',
    `c.status NOT IN ${LIVE}`,
    `(c.scope = 'direct' OR p.joined_at IS NOT NULL OR p.rung_at IS NOT NULL OR p.host OR c.caller_id = $1)`,
  ];
  const params: unknown[] = [ctx.userId];
  if (opts.filter === 'missed') where.push(`p.state = 'missed'`);
  else if (opts.filter === 'incoming') where.push('c.caller_id <> $1');
  else if (opts.filter === 'outgoing') where.push('c.caller_id = $1');
  if (opts.roomId) {
    params.push(opts.roomId);
    where.push(`c.room_id = $${params.length}`);
  }
  const cond = where.join(' AND ');
  const count = Math.min(opts.count, 100);
  const rows = await many(`${CALL_SELECT} JOIN call_participants p ON p.call_id = c.id WHERE ${cond} ORDER BY p.created_at DESC, c.id LIMIT ${count} OFFSET ${opts.offset}`, params);
  const total = await one(`SELECT count(*)::int AS n FROM call_participants p JOIN calls c ON c.id = p.call_id WHERE ${cond}`, params);
  const calls = await callViews(rows, ctx.userId, { mine: true, room: true });
  // Para os botões de ligar de novo: a política de conversas diretas vale também para o histórico.
  const direct = calls.filter((c) => c.scope === 'direct');
  const policies = await callPolicies(ctx, direct.map((c) => c.rid));
  for (const c of direct) {
    const p = policies.get(c.rid);
    c.canCall = p?.canCall ?? true;
    if (p?.reason) c.callBlockedReason = p.reason;
  }
  return { calls, total: total?.n ?? 0 };
}

// Chamadas vivas nas minhas salas, as minhas chamadas vivas e as que caí há menos de 2 min (para voltar). Em grupo, as
// mesmas regras de calls.info: membro da sala, ou tocando ou presente agora. Quem caiu e depois saiu da sala (ou foi
// expulso) não vê mais a chamada; voltar exige ser membro.
export async function activeCalls(ctx: Ctx): Promise<{ calls: Call[] }> {
  const rows = await many(
    `${CALL_SELECT}
      WHERE c.status IN ${LIVE}
        AND ((c.scope = 'group' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.room_id = c.room_id AND s.user_id = $1))
          OR EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $1
                      AND (p.state = 'ringing' OR ${presentSql()}
                           OR (c.scope = 'direct' AND p.state = 'left' AND p.left_reason = 'disconnected' AND p.left_at > now() - interval '2 minutes'))))
      ORDER BY c.created_at DESC LIMIT 200`,
    [ctx.userId],
  );
  return { calls: await callViews(rows, ctx.userId, { mine: true, room: true, guard: true }) };
}

// Prevê iniciar e entrar com o mesmo código de calls.start e calls.join; nunca lança erro de política.
export async function roomCallState(ctx: Ctx, rid: string): Promise<RoomCallState> {
  const room = await loadRoomInfo(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (!(await canAccessRoom(ctx.userId, room))) throw forbidden('Você não tem acesso a esta sala.');
  const transmission = isTransmissionRoom(room);
  const state: RoomCallState = { call: null, canStart: false, hideStart: true, canJoin: false, listenOnly: false, transmission, serverTime: new Date().toISOString() };
  if (!callsEnabled()) return { ...state, startBlockedReason: 'As chamadas estão desativadas.' };
  let row = await liveCallOfRoom(rid);
  if (!row && room.t === 'd') {
    row = await one(`${CALL_SELECT} WHERE c.room_id = $1 AND c.scope = 'direct' AND c.status IN ${LIVE} AND (c.caller_id = $2 OR c.callee_id = $2) ORDER BY c.created_at DESC LIMIT 1`, [rid, ctx.userId]);
  }
  if (row) state.call = await callView(row, ctx.userId, { mine: true, guard: true });
  const sv = await startCheck(ctx, room);
  state.canStart = sv.allowed;
  state.hideStart = !sv.allowed && !!sv.hide;
  if (sv.error) state.startBlockedReason = sv.error.message;
  if (state.canStart && row) {
    state.canStart = false;
    state.startBlockedReason = row.scope === 'group' ? ERR.exists(row.id).message : ERR.inProgress().message;
  }
  if (state.canStart && sv.scope === 'group') {
    const m = await resolveMedia('group', { recheck: false });
    if (!m.allowed) {
      state.canStart = false;
      state.startBlockedReason = m.error.message;
    } else if (await serverFull(false)) {
      state.canStart = false;
      state.startBlockedReason = ERR.capacity().message;
    }
  }
  if (row?.scope === 'group') {
    // "Você já está em uma chamada" não bloqueia aqui: a web oferece sair da outra (leaveCurrent).
    const jv = await joinCheck(ctx, row, room, { leaveCurrent: true });
    state.canJoin = jv.allowed;
    state.listenOnly = jv.listenOnly;
    if (jv.error) state.joinBlockedReason = jv.error.message;
  }
  if (restrictedRoleIds().length && callScopeOf(room) === 'group') {
    const v = await loadViewer(ctx.userId, row?.id ?? null, rid);
    if (v) state.viewerGuard = viewerGuardOf(v, row, room);
  }
  return state;
}

export async function inCall(userIds: string[]) {
  return { userIds: await inCallIds(userIds) };
}

// Selo do menu Chamadas: perdidas depois da última visita (sem visita registrada, todas).
export async function missedCount(ctx: Ctx): Promise<number> {
  const r = await one(
    `SELECT count(*)::int AS n FROM call_participants p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1 AND p.state = 'missed' AND (u.calls_seen_at IS NULL OR coalesce(p.left_at, p.created_at) > u.calls_seen_at)`,
    [ctx.userId],
  );
  return r?.n ?? 0;
}

export async function markSeen(ctx: Ctx) {
  await query('UPDATE users SET calls_seen_at = now() WHERE id = $1', [ctx.userId]);
}

// ---------- Administração ----------

export async function adminActiveCalls(): Promise<{ calls: Call[] }> {
  const rows = await many(`${CALL_SELECT} WHERE c.status IN ${LIVE} ORDER BY c.created_at DESC LIMIT 500`);
  return { calls: await callViews(rows, null, { room: true, guard: true }) };
}

// Qualquer chamada viva; a dois termina como um desligar, com "Encerrada por @admin" para os dois lados.
export async function adminEndCall(ctx: Ctx, callId: string): Promise<Call> {
  const r = await loadCall(callId);
  if (!isLive(r)) return view(callId, ctx.userId);
  const by = await userRef(ctx.userId);
  let ended = false;
  if (r.scope === 'group') ended = await endGroupCall(callId, 'moderator', by);
  else {
    ended =
      r.status === 'ringing'
        ? await finishDirect(callId, ['ringing'], 'canceled', ctx.userId, 'moderator', () => 'ended')
        : await finishDirect(callId, ['ongoing'], 'ended', ctx.userId, 'moderator', () => 'ended');
    if (ended) {
      bus.publish({ users: [r.caller_id, r.callee_id].filter(Boolean) }, { type: 'call.notice', callId, notice: { kind: 'ended', reason: 'moderator', text: callEndedReasonText('moderator', by) } });
    }
  }
  if (ended) await audit(actorOf(ctx), 'call.admin.end', { callId, rid: r.room_id });
  return view(callId, ctx.userId);
}

// ---------- Sinalização P2P ----------

// Sinalização: só entre as duas conexões da chamada em andamento, nunca para outra.
export async function relaySignal(fromConn: string, userId: string, callId: unknown, data: CallSignal) {
  if (typeof callId !== 'string' || !data || typeof data !== 'object') return;
  if (JSON.stringify(data).length > 64 * 1024) return;
  const r = await one(`SELECT caller_id, callee_id, caller_conn, callee_conn FROM calls WHERE id = $1 AND status = 'ongoing' AND media = 'p2p'`, [callId]);
  if (!r) return;
  let to: string | null = null;
  if (fromConn === r.caller_conn && userId === r.caller_id) to = r.callee_conn;
  else if (fromConn === r.callee_conn && userId === r.callee_id) to = r.caller_conn;
  if (to) bus.publish({ conn: to }, { type: 'call.signal', callId, data });
}

// A conexão de um dos lados fechou (aba fechada, recarregada, sem rede): a chamada a dois termina.
export async function connectionClosed(connId: string) {
  const rows = await many(
    `SELECT id, status, caller_conn, caller_id, callee_id FROM calls WHERE status = ANY($2) AND media = 'p2p' AND (caller_conn = $1 OR callee_conn = $1)`,
    [connId, ACTIVE],
  );
  for (const r of rows) {
    const by = r.caller_conn === connId ? r.caller_id : r.callee_id;
    const leftOf = (u: string): CallLeftReason => (u === by ? 'disconnected' : 'ended');
    if (r.status === 'ongoing') await finishDirect(r.id, ['ongoing'], 'ended', by, 'dropped', leftOf);
    else if (r.caller_conn === connId) await finishDirect(r.id, ['ringing'], 'canceled', r.caller_id, null, leftOf);
  }
}

// Passos 1 e 2 da varredura (calls/sweep.ts): toque esgotado e chamadas P2P cujas conexões sumiram (instância que caiu).
export async function sweepDirectCalls() {
  const expired = await many(`SELECT id FROM calls WHERE scope = 'direct' AND status = 'ringing' AND created_at < now() - make_interval(secs => $1)`, [ringTimeout()]);
  for (const r of expired) await finishDirect(r.id, ['ringing'], 'missed', null, 'no-answer', () => 'ended');
  const orphans = await many(
    `SELECT id, status FROM calls c WHERE scope = 'direct' AND media = 'p2p' AND status = ANY($1) AND created_at < now() - interval '15 seconds'
       AND (NOT EXISTS (SELECT 1 FROM presence_connections p WHERE p.id = c.caller_conn)
            OR (c.callee_conn IS NOT NULL AND NOT EXISTS (SELECT 1 FROM presence_connections p WHERE p.id = c.callee_conn)))`,
    [ACTIVE],
  );
  for (const r of orphans) {
    const ongoing = r.status === 'ongoing';
    await finishDirect(r.id, [r.status], ongoing ? 'ended' : 'canceled', null, ongoing ? 'dropped' : null, () => 'disconnected');
  }
}
