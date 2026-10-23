import { many, one } from '../db/pool';
import { badRequest } from '../lib/errors';
import type { Ctx } from '../services/users';
import { hit } from './limits';
import { loadCallRow, loadRoomInfo, presentSql, withCallLock, type Db, type Effects } from './model';
import { ERR } from './policy';
import { seesListeners } from './views';

// Mãos levantadas (§5.13): só o servidor muda hand_at; os atributos do LiveKit nunca são usados.

// Para quem vai o call.hand: os presentes; a mão de um ouvinte oculto numa sala com a lista oculta só vai para ele e
// para quem pode ver os ouvintes.
async function handTargetsTx(c: Db, call: any, room: any, userId: string, hidden: boolean): Promise<string[]> {
  const rows = await many(
    `SELECT p.user_id, p.host, u.roles AS g, s.roles AS s FROM call_participants p JOIN users u ON u.id = p.user_id
       LEFT JOIN subscriptions s ON s.room_id = $2 AND s.user_id = p.user_id
      WHERE p.call_id = $1 AND ${presentSql()}`,
    [call.id, call.room_id],
    c,
  );
  const limited = hidden && call.listen_only && room?.broadcast;
  const ids = rows.filter((r) => !limited || r.user_id === userId || seesListeners([...r.g, ...(r.s ?? [])], r.host)).map((r) => r.user_id as string);
  return ids.includes(userId) ? ids : [...ids, userId];
}

export async function publishHandTx(c: Db, fx: Effects, call: any, room: any, row: { user_id: string; granted_hidden?: boolean }, at: string | null) {
  const to = await handTargetsTx(c, call, room, row.user_id, !!row.granted_hidden);
  fx.publish({ users: to }, { type: 'call.hand', callId: call.id, userId: row.user_id, at });
}

export async function setHand(ctx: Ctx, callId: string, raised: boolean): Promise<{ handAt: string | null }> {
  hit(ctx.userId, 'hand', 10, 60_000);
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call) throw ERR.notFound();
    if (call.scope !== 'group') throw badRequest('error-invalid-params', 'Levantar a mão só existe em chamadas em grupo.');
    if (call.status !== 'ongoing') throw ERR.ended();
    const row = await one(`SELECT user_id, state, hand_at, granted_hidden FROM call_participants WHERE call_id = $1 AND user_id = $2 FOR UPDATE`, [callId, ctx.userId], c);
    if (row?.state !== 'joined') throw ERR.notInCall();
    const r = await one(
      `UPDATE call_participants SET hand_at = CASE WHEN $3 THEN coalesce(hand_at, now()) ELSE NULL END WHERE call_id = $1 AND user_id = $2 RETURNING hand_at`,
      [callId, ctx.userId, raised],
      c,
    );
    const at = (r?.hand_at ?? null) as string | null;
    if (at !== row.hand_at) await publishHandTx(c, fx, call, await loadRoomInfo(call.room_id, c), row, at);
    return { handAt: at };
  });
}

// Baixa a mão de alguém (moderação). Devolve false quando não havia mão levantada.
export async function clearHandTx(c: Db, fx: Effects, call: any, room: any, userId: string): Promise<boolean> {
  const r = await one(
    `UPDATE call_participants SET hand_at = NULL WHERE call_id = $1 AND user_id = $2 AND hand_at IS NOT NULL RETURNING user_id, granted_hidden`,
    [call.id, userId],
    c,
  );
  if (!r) return false;
  await publishHandTx(c, fx, call, room, r, null);
  return true;
}

export async function clearHand(callId: string, userId: string): Promise<boolean> {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call) return false;
    return clearHandTx(c, fx, call, await loadRoomInfo(call.room_id, c), userId);
  });
}
