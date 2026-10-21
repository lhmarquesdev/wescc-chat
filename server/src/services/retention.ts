import { many, query } from '../db/pool';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { getSetting } from './settings';
import { deleteFilesWhere } from './uploads';
import { withExtra } from './messages';

export interface PruneOptions {
  latest: string;
  oldest: string;
  inclusive?: boolean;
  excludePinned?: boolean;
  filesOnly?: boolean;
  ignoreDiscussion?: boolean;
  ignoreThreads?: boolean;
  users?: string[];
  limit?: number;
}

// Apaga mensagens (ou só arquivos) de uma sala num intervalo de tempo.
export async function pruneMessages(rid: string, o: PruneOptions): Promise<number> {
  const lt = o.inclusive ? '<=' : '<';
  const gt = o.inclusive ? '>=' : '>';
  if (o.filesOnly) {
    const rows = await deleteFilesWhere(rid, o.latest, o.oldest);
    const ids = [...new Set(rows.map((r) => r.message_id).filter(Boolean))];
    if (ids.length) {
      const updated = await many(
        `UPDATE messages SET files = '[]', attachments = '[{"text":"Arquivo removido pela política de retenção"}]', updated_at = now() WHERE id = ANY($1) RETURNING *`,
        [ids],
      );
      for (const m of updated) bus.publish({ room: rid }, { type: 'message', action: 'updated', message: withExtra(m) });
    }
    return rows.length;
  }
  const params: unknown[] = [rid, o.latest, o.oldest];
  const w = [`room_id = $1`, `created_at ${lt} $2`, `created_at ${gt} $3`];
  if (o.excludePinned) w.push('NOT pinned');
  if (o.ignoreDiscussion) w.push('drid IS NULL');
  if (o.ignoreThreads) w.push('tcount = 0 AND tmid IS NULL');
  if (o.users?.length) w.push(`username = ANY($${params.push(o.users)})`);
  const limit = o.limit && o.limit > 0 ? `LIMIT ${Number(o.limit)}` : '';
  const target = await many(`SELECT id FROM messages WHERE ${w.join(' AND ')} ORDER BY created_at ${limit}`, params);
  if (!target.length) return 0;
  const ids = target.map((t) => t.id);
  const fileRows = await many('DELETE FROM files WHERE message_id = ANY($1) RETURNING storage_path', [ids]);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { config } = await import('../config');
  for (const f of fileRows) await fs.promises.rm(path.join(config.uploadDir, f.storage_path), { force: true }).catch(() => {});
  await query('DELETE FROM messages WHERE id = ANY($1)', [ids]);
  // Recalcula contadores de threads afetadas e a última mensagem.
  await query(
    `UPDATE messages p SET tcount = (SELECT count(*) FROM messages c WHERE c.tmid = p.id) WHERE p.room_id = $1 AND p.tcount > 0`,
    [rid],
  );
  await query(
    `UPDATE rooms SET last_message = (
       SELECT jsonb_build_object('_id', id, 'msg', left(msg, 200), 'u', jsonb_build_object('_id', user_id, 'username', username, 'name', user_name), 'ts', created_at)
       FROM messages WHERE room_id = $1 AND t IS NULL AND tmid IS NULL ORDER BY created_at DESC LIMIT 1), updated_at = now()
     WHERE id = $1`,
    [rid],
  );
  bus.publish({ room: rid }, { type: 'messages.bulkDeleted', rid, ids: ids.length <= 500 ? ids : undefined, before: o.latest });
  return ids.length;
}

const TYPE_KEYS: Record<string, [string, string]> = {
  c: ['RetentionPolicy_AppliesToChannels', 'RetentionPolicy_TTL_Channels'],
  p: ['RetentionPolicy_AppliesToGroups', 'RetentionPolicy_TTL_Groups'],
  d: ['RetentionPolicy_AppliesToDMs', 'RetentionPolicy_TTL_DMs'],
};

// Executada periodicamente pelo agendador.
export async function runRetention(now = new Date()) {
  if (!getSetting('RetentionPolicy_Enabled')) return { rooms: 0, removed: 0 };
  let removed = 0;
  let roomsTouched = 0;
  const rooms = await many(`SELECT id, t, retention FROM rooms WHERE t IN ('c','p','d')`);
  for (const r of rooms) {
    const keys = TYPE_KEYS[r.t];
    const own = r.retention;
    let days: number | null = null;
    let filesOnly = getSetting<boolean>('RetentionPolicy_FilesOnly');
    let excludePinned = getSetting<boolean>('RetentionPolicy_DoNotPrunePinned');
    if (own?.enabled && own.overrideGlobal) {
      days = own.maxAgeDays;
      filesOnly = own.filesOnly;
      excludePinned = own.excludePinned;
    } else if (own && own.enabled === false && own.overrideGlobal) {
      continue;
    } else if (getSetting(keys[0])) {
      days = getSetting<number>(keys[1]);
    }
    if (!days || days <= 0) continue;
    const latest = new Date(now.getTime() - days * 86400_000).toISOString();
    const n = await pruneMessages(r.id, {
      latest,
      oldest: '1970-01-01T00:00:00Z',
      filesOnly,
      excludePinned,
      ignoreDiscussion: getSetting<boolean>('RetentionPolicy_DoNotPruneDiscussion'),
      ignoreThreads: getSetting<boolean>('RetentionPolicy_DoNotPruneThreads'),
    });
    if (n) {
      removed += n;
      roomsTouched++;
    }
  }
  if (removed) await audit({ username: 'system' }, 'retention.pruned', {}, { rooms: roomsTouched, removed });
  return { rooms: roomsTouched, removed };
}
