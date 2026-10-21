import { newId } from '../lib/ids';
import { many, query } from '../db/pool';

export interface Actor {
  id?: string | null;
  username?: string | null;
  ip?: string | null;
}

// Registra ações administrativas e de segurança.
export async function audit(actor: Actor, action: string, target: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  await query(
    'INSERT INTO audit_log (id, actor_id, actor_username, action, target, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [newId(), actor.id ?? null, actor.username ?? null, action, JSON.stringify(target), JSON.stringify(data), actor.ip ?? null],
  ).catch(() => {});
}

export async function listAuditLog(opts: { start?: string; end?: string; action?: string; actor?: string; offset?: number; count?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.start) where.push(`created_at >= $${params.push(opts.start)}`);
  if (opts.end) where.push(`created_at <= $${params.push(opts.end)}`);
  if (opts.action) where.push(`action LIKE $${params.push(opts.action.replace(/\*/g, '%'))}`);
  if (opts.actor) where.push(`actor_username = $${params.push(opts.actor)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = Math.min(opts.count ?? 50, 500);
  const rows = await many(
    `SELECT *, count(*) OVER() AS total FROM audit_log ${w} ORDER BY created_at DESC LIMIT ${count} OFFSET ${Number(opts.offset ?? 0)}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    events: rows.map((r) => ({
      _id: r.id,
      actor: { _id: r.actor_id, username: r.actor_username, ip: r.ip },
      action: r.action,
      target: r.target,
      data: r.data,
      ts: r.created_at,
    })),
  };
}
