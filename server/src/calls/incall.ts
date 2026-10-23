import { many, pool, type Queryable } from '../db/pool';
import type { ServerEvent } from '@shared/index';
import type { Target } from '../realtime/bus';
import { LIVE, presentSql, publishEach } from './model';
import { coalesce } from './queue';

// "Em chamada" (§5.16): presente numa chamada que toca ou está em andamento, sem ser ouvinte oculto. Nunca muda
// users.status.

export async function inCallIds(userIds: string[], db: Queryable = pool): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await many(
    `SELECT DISTINCT p.user_id FROM call_participants p JOIN calls c ON c.id = p.call_id
      WHERE p.user_id = ANY($1) AND p.state IN ('joining', 'joined') AND c.status IN ${LIVE} AND ${presentSql()} AND NOT p.granted_hidden`,
    [userIds],
    db,
  );
  return rows.map((r) => r.user_id as string);
}

// Último valor publicado por esta instância, para mandar só mudanças.
const last = new Map<string, boolean>();
const waiting = new Set<string>();

// Cada pessoa sai no máximo uma vez por segundo, no fim da janela. Quem mudou na mesma janela vai junto, numa consulta
// só: 300 entradas ao mesmo tempo dão uma consulta, não 300 disputando o pool.
export function publishInCall(userId: string) {
  waiting.add(userId);
  coalesce('incall', 'presence', 1000, async () => {
    const ids = [...waiting];
    waiting.clear();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const now = new Set(await inCallIds(part));
      const changed: [Target, ServerEvent][] = [];
      for (const id of part) {
        const inCall = now.has(id);
        if (last.get(id) === inCall) continue;
        last.set(id, inCall);
        changed.push([{ all: true }, { type: 'call.presence', userId: id, inCall }]);
      }
      await publishEach(changed);
    }
    if (last.size > 20_000) for (const [id, v] of last) if (!v) last.delete(id);
  });
}
