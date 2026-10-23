import { many } from '../db/pool';
import { on } from '../services/hooks';
import { endGroupCall, endGroupCallTx } from './group';
import { lk, loadCallRow, loadRoomInfo, presentIds, publishCallTo, withCallLock } from './model';
import { afterLeaveTx, leaveRowsTx } from './presence';
import { enqueue } from './queue';

// Mudanças de fora (§5.17): quem sai da sala sai da chamada; sala arquivada encerra a chamada.

async function liveCallsOf(rid: string): Promise<string[]> {
  return (await many(`SELECT id FROM calls WHERE room_id = $1 AND scope = 'group' AND status = 'ongoing'`, [rid])).map((r) => r.id as string);
}

export async function leaveRoomCalls(rid: string, userId: string) {
  for (const callId of await liveCallsOf(rid)) {
    await withCallLock(callId, async (c, fx) => {
      const call = await loadCallRow(callId, c);
      if (!call || call.status !== 'ongoing') return;
      await c.query(`UPDATE call_participants SET state = 'missed', left_at = now() WHERE call_id = $1 AND user_id = $2 AND state = 'ringing'`, [callId, userId]);
      const left = await leaveRowsTx(c, callId, [userId], 'room');
      if (!left.length) return;
      const sfuRoom = call.sfu_room;
      fx.sfu(() => lk.removeParticipant(sfuRoom, userId));
      fx.after(() => publishCallTo(callId, [userId]));
      if (!(await presentIds(callId, c)).length) await endGroupCallTx(c, fx, call, 'empty', null);
      else await afterLeaveTx(c, fx, call, await loadRoomInfo(call.room_id, c), left);
    });
  }
}

// Fila por sala: a ordem das mudanças da mesma sala é mantida, e a tarefa já conta como pendente desde o evento.
on('room.left', ({ room, user }) => {
  void enqueue(`room:${room.id}`, () => leaveRoomCalls(room.id, user._id)).catch((e) => console.error(`[chamadas] saída da sala ${room.id} falhou: ${e?.message ?? e}`));
});

on('room.archived', ({ room }) => {
  void enqueue(`room:${room.id}`, async () => {
    for (const id of await liveCallsOf(room.id)) await endGroupCall(id, 'room');
  }).catch((e) => console.error(`[chamadas] arquivar a sala ${room.id} falhou: ${e?.message ?? e}`));
});
