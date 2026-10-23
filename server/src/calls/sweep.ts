import { many, query } from '../db/pool';
import { getSetting } from '../services/settings';
import { expireRings } from './group';
import { sfuConfig } from './livekit';
import { lk } from './model';
import { reconcileCall } from './presence';

// Varredura das chamadas (a cada 10 s sob a trava 727110; os testes chamam direto).

const CALL_ROOM = /^wc_([A-Za-z0-9]+)$/;
const TEST_ROOM = /^wc_test_/;
let retentionAt = 0;

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await Promise.allSettled(items.slice(i, i + size).map(fn));
}

export async function sweepCalls() {
  const ringTimeout = Number(getSetting('Calls_Ring_Timeout')) || 40;
  const sfu = sfuConfig().configured;
  // 1 e 2. A dois (P2P): toque esgotado e conexões que sumiram, como sempre.
  const { sweepDirectCalls } = await import('../services/calls');
  await sweepDirectCalls();
  // 3. Reconciliação de cada chamada viva pelo servidor de chamadas, 4 por vez.
  if (sfu) {
    const live = await many(`SELECT id FROM calls WHERE status IN ('ringing', 'ongoing') AND media = 'sfu' ORDER BY created_at`);
    await inBatches(live, 4, (r) => reconcileCall(r.id));
  }
  // 4. Toques de chamadas em grupo vencidos.
  const rung = await many(
    `SELECT DISTINCT p.call_id FROM call_participants p JOIN calls c ON c.id = p.call_id
      WHERE c.scope = 'group' AND p.state = 'ringing' AND p.rung_at < now() - make_interval(secs => $1)`,
    [ringTimeout],
  );
  await inBatches(rung, 4, (r) => expireRings(r.call_id));
  // 5. Salas do LiveKit sem chamada viva (sala apagada, instância que caiu) e salas de autoteste antigas.
  if (sfu) {
    const rooms = await lk.listRooms(undefined, { timeoutMs: 5000 }).catch(() => null);
    if (rooms?.length) {
      const now = Date.now() / 1000;
      const ids = rooms.map((r) => CALL_ROOM.exec(r.name)?.[1]).filter((x): x is string => !!x);
      const alive = new Set(
        ids.length ? (await many(`SELECT id FROM calls WHERE id = ANY($1) AND status IN ('ringing', 'ongoing')`, [ids])).map((r) => r.id as string) : [],
      );
      for (const r of rooms) {
        const age = now - (r.creationTime || now);
        const id = CALL_ROOM.exec(r.name)?.[1];
        const orphan = TEST_ROOM.test(r.name) ? age > 600 : !!id && !alive.has(id) && age > 60;
        if (orphan) await lk.deleteRoom(r.name).catch(() => {});
      }
    }
  }
  // 6. Retenção do histórico, no máximo uma vez por hora.
  const days = Number(getSetting('Calls_History_Retention_Days')) || 0;
  if (days > 0 && Date.now() - retentionAt >= 3_600_000) {
    retentionAt = Date.now();
    for (;;) {
      const r = await query(
        `DELETE FROM calls WHERE id IN (SELECT id FROM calls WHERE ended_at < now() - make_interval(days => $1) LIMIT 1000)`,
        [days],
      );
      if (!r.rowCount) break;
    }
  }
}

// Testes: deixa a retenção rodar de novo na próxima varredura.
export function resetRetentionGate() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetRetentionGate só existe nos testes');
  retentionAt = 0;
}
