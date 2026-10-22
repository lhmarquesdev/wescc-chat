import type { Call, CallKind, CallSignal, CallStatus } from '@shared/index';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { assertCanCall, callPolicies } from './direct';
import { sendSystemMessage } from './messages';
import { getRoom, getSubscriptionRow } from './rooms';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Chamadas de voz e vídeo em DMs de duas pessoas: o servidor guarda o estado e o histórico e repassa a
// sinalização WebRTC (SDP e ICE) entre as duas conexões; o áudio e o vídeo vão direto entre os navegadores
// (ou por um servidor TURN, se configurado).

const ACTIVE = ['ringing', 'ongoing'];
const FINAL_MESSAGE: Partial<Record<CallStatus, string>> = { missed: 'call_missed', declined: 'call_missed', canceled: 'call_missed', busy: 'call_missed', ended: 'call_ended' };

const SELECT = `SELECT c.*, a.username AS caller_username, a.name AS caller_name, b.username AS callee_username, b.name AS callee_name
  FROM calls c JOIN users a ON a.id = c.caller_id JOIN users b ON b.id = c.callee_id`;

function mapCall(r: any): Call {
  const answered = r.answered_at ? new Date(r.answered_at).getTime() : null;
  const ended = r.ended_at ? new Date(r.ended_at).getTime() : null;
  return {
    _id: r.id,
    rid: r.room_id,
    kind: r.kind,
    status: r.status,
    caller: { _id: r.caller_id, username: r.caller_username, name: r.caller_name },
    callee: { _id: r.callee_id, username: r.callee_username, name: r.callee_name },
    callerConnectionId: r.caller_conn,
    calleeConnectionId: r.callee_conn,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    duration: answered && ended ? Math.max(0, Math.round((ended - answered) / 1000)) : null,
  };
}

async function loadCall(id: string) {
  const r = await one(`${SELECT} WHERE c.id = $1`, [id]);
  if (!r) throw notFound('error-call-not-found', 'Chamada não encontrada.');
  return r;
}

function publish(r: any) {
  const call = mapCall(r);
  bus.publish({ users: [r.caller_id, r.callee_id] }, { type: 'call', call });
  return call;
}

// A conexão informada precisa ser um WebSocket aberto desta mesma sessão (é por ela que a sinalização passa).
async function assertOwnConnection(ctx: Ctx, connectionId: unknown) {
  const id = typeof connectionId === 'string' ? connectionId : '';
  if (!id || !(await one('SELECT 1 FROM presence_connections WHERE id = $1 AND user_id = $2 AND session_id = $3', [id, ctx.userId, ctx.sessionId]))) {
    throw badRequest('error-call-connection', 'Conexão em tempo real não encontrada. Recarregue a página e tente de novo.');
  }
  return id;
}

export function callConfig() {
  const iceServers: { urls: string[]; username?: string; credential?: string }[] = [];
  const stun = String(getSetting('Calls_STUN_Servers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length) iceServers.push({ urls: stun });
  const turn = String(getSetting('Calls_TURN_Server') ?? '').trim();
  if (turn) iceServers.push({ urls: turn.split(',').map((s) => s.trim()), username: getSetting<string>('Calls_TURN_Username') || undefined, credential: getSetting<string>('Calls_TURN_Password') || undefined });
  return { enabled: !!getSetting('Calls_Enabled'), ringTimeout: getSetting<number>('Calls_Ring_Timeout') || 40, iceServers };
}

export async function startCall(ctx: Ctx, input: { roomId: string; kind: CallKind; connectionId: unknown }) {
  if (!getSetting('Calls_Enabled')) throw forbidden('As chamadas estão desativadas.');
  if (input.kind !== 'audio' && input.kind !== 'video') throw badRequest('error-invalid-params', 'Tipo de chamada inválido.');
  const room = await getRoom(input.roomId);
  if (!room || room.t !== 'd' || room.uids.length !== 2 || !(await getSubscriptionRow(room.id, ctx.userId))) {
    throw badRequest('error-call-room', 'Chamadas só em mensagens diretas entre duas pessoas.');
  }
  const calleeId = room.uids.find((u: string) => u !== ctx.userId);
  const callee = calleeId ? await one('SELECT id, active, type FROM users WHERE id = $1', [calleeId]) : null;
  if (!callee?.active || callee.type === 'bot') throw badRequest('error-call-user', 'Este usuário não pode receber chamadas.');
  await assertCanCall(ctx, room);
  const conn = await assertOwnConnection(ctx, input.connectionId);
  if (await one(`SELECT 1 FROM calls WHERE status = ANY($2) AND (caller_id = $1 OR callee_id = $1)`, [ctx.userId, ACTIVE])) {
    throw new ApiError(409, 'error-call-in-progress', 'Você já está em uma chamada.');
  }
  const busy = !!(await one(`SELECT 1 FROM calls WHERE status = ANY($2) AND (caller_id = $1 OR callee_id = $1)`, [callee.id, ACTIVE]));
  const id = newId();
  await query(
    `INSERT INTO calls (id, room_id, caller_id, callee_id, kind, status, caller_conn, ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'busy' THEN now() END)`,
    [id, room.id, ctx.userId, callee.id, input.kind, busy ? 'busy' : 'ringing', conn],
  );
  const r = await loadCall(id);
  const call = publish(r);
  if (busy) {
    await finalMessage(r);
    return call;
  }
  // Quem está com o chat fechado recebe o toque como notificação push.
  const online = await one('SELECT 1 FROM presence_connections WHERE user_id = $1 LIMIT 1', [callee.id]);
  if (!online) {
    const { sendPush } = await import('./push');
    void sendPush([callee.id], { title: ctx.username, body: input.kind === 'video' ? '🎥 Chamada de vídeo' : '📞 Chamada de voz', url: `/direct/${room.id}`, tag: `call-${id}` }).catch(() => {});
  }
  const timeout = (getSetting<number>('Calls_Ring_Timeout') || 40) * 1000;
  setTimeout(() => void finishIfStatus(id, ['ringing'], 'missed', null).catch(() => {}), timeout).unref();
  return call;
}

// Muda o estado só se a chamada ainda estiver em um dos estados esperados (evita corrida entre atender e desligar).
async function finishIfStatus(id: string, from: string[], to: CallStatus, by: string | null) {
  const updated = await one(`UPDATE calls SET status = $3, ended_at = now(), ended_by = $4 WHERE id = $1 AND status = ANY($2) RETURNING id`, [id, from, to, by]);
  if (!updated) return null;
  const r = await loadCall(id);
  const call = publish(r);
  await finalMessage(r);
  return call;
}

// Registro da chamada na própria DM (aparece no histórico da conversa).
async function finalMessage(r: any) {
  const t = FINAL_MESSAGE[r.status as CallStatus];
  if (!t) return;
  const call = mapCall(r);
  await sendSystemMessage(r.room_id, t, { id: r.caller_id, username: r.caller_username }, '', { call: { _id: call._id, kind: call.kind, status: call.status, duration: call.duration } }).catch(() => {});
}

export async function acceptCall(ctx: Ctx, callId: string, connectionId: unknown) {
  const conn = await assertOwnConnection(ctx, connectionId);
  const r = await loadCall(callId);
  if (r.callee_id !== ctx.userId) throw forbidden();
  const updated = await one(`UPDATE calls SET status = 'ongoing', callee_conn = $2, answered_at = now() WHERE id = $1 AND status = 'ringing' RETURNING id`, [callId, conn]);
  if (!updated) throw badRequest('error-call-not-ringing', 'Esta chamada já terminou.');
  return publish(await loadCall(callId));
}

export async function declineCall(ctx: Ctx, callId: string) {
  const r = await loadCall(callId);
  if (r.callee_id !== ctx.userId) throw forbidden();
  return (await finishIfStatus(callId, ['ringing'], 'declined', ctx.userId)) ?? mapCall(r);
}

// Desligar: cancela se ainda está tocando (quem ligou), recusa (quem recebe) ou encerra a chamada em andamento.
export async function endCall(ctx: Ctx, callId: string) {
  const r = await loadCall(callId);
  if (r.caller_id !== ctx.userId && r.callee_id !== ctx.userId) throw forbidden();
  if (r.status === 'ringing') return (await finishIfStatus(callId, ['ringing'], r.caller_id === ctx.userId ? 'canceled' : 'declined', ctx.userId)) ?? mapCall(await loadCall(callId));
  if (r.status === 'ongoing') return (await finishIfStatus(callId, ['ongoing'], 'ended', ctx.userId)) ?? mapCall(await loadCall(callId));
  return mapCall(r);
}

export async function getCall(ctx: Ctx, callId: string) {
  const r = await loadCall(callId);
  if (r.caller_id !== ctx.userId && r.callee_id !== ctx.userId) throw forbidden();
  return mapCall(r);
}

export async function listCalls(ctx: Ctx, opts: { offset: number; count: number }) {
  const rows = await many(
    `${SELECT}, (SELECT count(*) FROM calls x WHERE x.caller_id = $1 OR x.callee_id = $1) AS total
     WHERE c.caller_id = $1 OR c.callee_id = $1 ORDER BY c.created_at DESC LIMIT ${Math.min(opts.count, 100)} OFFSET ${opts.offset}`,
    [ctx.userId],
  );
  const calls = rows.map(mapCall);
  // Para os botões de ligar de novo: a política de conversas diretas vale também para o histórico.
  const policies = await callPolicies(ctx, calls.map((c) => c.rid));
  for (const c of calls) {
    const p = policies.get(c.rid);
    c.canCall = p?.canCall ?? true;
    if (p?.reason) c.callBlockedReason = p.reason;
  }
  return { calls, total: Number(rows[0]?.total ?? 0) };
}

// Sinalização: só entre as duas conexões da chamada em andamento, nunca para outra.
export async function relaySignal(fromConn: string, userId: string, callId: unknown, data: CallSignal) {
  if (typeof callId !== 'string' || !data || typeof data !== 'object') return;
  if (JSON.stringify(data).length > 64 * 1024) return;
  const r = await one(`SELECT caller_id, callee_id, caller_conn, callee_conn FROM calls WHERE id = $1 AND status = 'ongoing'`, [callId]);
  if (!r) return;
  let to: string | null = null;
  if (fromConn === r.caller_conn && userId === r.caller_id) to = r.callee_conn;
  else if (fromConn === r.callee_conn && userId === r.callee_id) to = r.caller_conn;
  if (to) bus.publish({ conn: to }, { type: 'call.signal', callId, data });
}

// A conexão de um dos lados fechou (aba fechada, recarregada, sem rede): a chamada termina.
export async function connectionClosed(connId: string) {
  const rows = await many(`SELECT id, status, caller_conn, caller_id, callee_id FROM calls WHERE status = ANY($2) AND (caller_conn = $1 OR callee_conn = $1)`, [connId, ACTIVE]);
  for (const r of rows) {
    if (r.status === 'ongoing') await finishIfStatus(r.id, ['ongoing'], 'ended', r.caller_conn === connId ? r.caller_id : r.callee_id);
    else if (r.caller_conn === connId) await finishIfStatus(r.id, ['ringing'], 'canceled', r.caller_id);
  }
}

// Varredura periódica (scheduler): toque esgotado e chamadas cujas conexões sumiram (instância que caiu).
export async function sweepCalls() {
  const timeout = getSetting<number>('Calls_Ring_Timeout') || 40;
  const expired = await many(`SELECT id FROM calls WHERE status = 'ringing' AND created_at < now() - make_interval(secs => $1)`, [timeout]);
  for (const r of expired) await finishIfStatus(r.id, ['ringing'], 'missed', null);
  const orphans = await many(
    `SELECT id, status FROM calls c WHERE status = ANY($1) AND created_at < now() - interval '15 seconds'
       AND (NOT EXISTS (SELECT 1 FROM presence_connections p WHERE p.id = c.caller_conn)
            OR (c.callee_conn IS NOT NULL AND NOT EXISTS (SELECT 1 FROM presence_connections p WHERE p.id = c.callee_conn)))`,
    [ACTIVE],
  );
  for (const r of orphans) await finishIfStatus(r.id, [r.status], r.status === 'ongoing' ? 'ended' : 'canceled', null);
}
