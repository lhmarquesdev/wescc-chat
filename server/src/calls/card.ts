import type { CallCard } from '@shared/index';
import { one, query } from '../db/pool';
import { bus } from '../realtime/bus';
import { sendSystemMessage, withExtra } from '../services/messages';
import { isLive, loadCallRow, loadStats, mapCall } from './model';
import { cancelCoalesced, coalesce, enqueue } from './queue';
import { callView } from './views';

// Cartão da chamada em grupo na sala (§5.15) e o resumo call.room. Os dois são agrupados: a sala recebe no máximo um
// call.room a cada 2 s e uma atualização do cartão a cada 10 s, por maior que seja o vaivém de gente.

export async function cardOf(row: any): Promise<CallCard> {
  const stats = (await loadStats([row.id])).get(row.id)!;
  const c = mapCall(row, stats);
  return {
    _id: c._id,
    kind: c.kind,
    scope: 'group',
    status: c.status === 'ongoing' ? 'ongoing' : 'ended',
    listenOnly: c.listenOnly,
    startedAt: c.createdAt,
    endedAt: c.endedAt,
    duration: c.duration,
    participantsCount: c.participantsCount,
    sample: c.sample,
    peak: c.peak,
    totalJoined: c.totalJoined,
    endedReason: c.endedReason,
    endedBy: row.ended_by ? { _id: row.ended_by, username: row.ended_by_username, name: row.ended_by_name } : null,
  };
}

// Depois do CreateRoom (§5.6): a mensagem do cartão, em nome de quem iniciou.
export async function postCard(callId: string) {
  const row = await loadCallRow(callId);
  if (!row || row.scope !== 'group' || row.message_id) return;
  const card = await cardOf(row);
  const msg = await sendSystemMessage(row.room_id, 'call_group', { id: row.caller_id, username: row.caller_username }, '', { call: card });
  await query('UPDATE calls SET message_id = $2 WHERE id = $1', [callId, msg.id]);
}

// Cartão e call.room rodam na fila de efeitos da chamada (a mesma do call.room null e do cartão final do fim), lendo a
// chamada lá dentro: uma atualização agrupada que já tinha lido a chamada viva nunca sai depois do fim.

// Reescreve o cartão sem marcar a mensagem como editada. Só o final escreve sobre um cartão encerrado (outra instância
// pode ter encerrado a chamada enquanto esta montava o cartão).
function writeCard(callId: string, final = false) {
  return enqueue(`fx:${callId}`, async () => {
    const row = await loadCallRow(callId);
    if (!row?.message_id || (!final && !isLive(row))) return;
    const card = await cardOf(row);
    const m = await one(
      `UPDATE messages SET extra = jsonb_set(extra, '{call}', $2::jsonb), updated_at = now()
        WHERE id = $1 AND ($3 OR coalesce(extra->'call'->>'status', '') <> 'ended') RETURNING *`,
      [row.message_id, JSON.stringify(card), final],
    );
    if (m) bus.publish({ room: m.room_id }, { type: 'message', action: 'updated', message: withExtra(m) });
  });
}

// Resumo para a sala: sem participantes nem "mine". O fim manda call: null por conta própria (endGroupCall).
function publishRoom(callId: string) {
  return enqueue(`fx:${callId}`, async () => {
    const row = await loadCallRow(callId);
    if (!row || row.scope !== 'group' || !isLive(row)) return;
    const call = await callView(row, null, { guard: true });
    bus.publish({ room: row.room_id }, { type: 'call.room', rid: row.room_id, call });
  });
}

export function touchCall(callId: string) {
  coalesce(callId, 'room', 2000, () => publishRoom(callId));
  coalesce(callId, 'card', 10_000, () => writeCard(callId));
}

// O cartão final sai na hora; uma atualização agrupada que ainda esperava perde o sentido.
export async function finalCard(callId: string) {
  cancelCoalesced(callId, 'card');
  cancelCoalesced(callId, 'room');
  await writeCard(callId, true);
}
