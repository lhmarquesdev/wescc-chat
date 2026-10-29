// Histórico de papéis e permissões (rbac_history): toda escrita de papel ou de papéis de uma pessoa grava aqui, na
// mesma transação, só os campos que mudaram. Exclusão grava o retrato completo para poder recriar.
import { many, one, type Queryable } from '../db/pool';

export type HistoryEntity = 'role' | 'user';
export type HistoryAction = 'create' | 'update' | 'delete' | 'bulk' | 'rollback';
export type HistorySource = 'manual' | 'system' | 'ldap' | 'oauth' | 'saml' | 'omnichannel' | 'migration';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface HistoryInput {
  entityType: HistoryEntity;
  entityId: string;
  entityLabel?: string;
  action: HistoryAction;
  source?: HistorySource;
  actor: { id: string; username: string } | null;
  changes: FieldChange[];
  batchId?: string | null;
  revertsId?: number | null;
}

const same = (a: unknown, b: unknown) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

// Só os campos que mudaram; um update sem mudança real não grava nada. Devolve o id da linha.
export async function recordHistory(db: Queryable, h: HistoryInput): Promise<number | null> {
  const changes = h.action === 'delete' || h.action === 'create' ? h.changes : h.changes.filter((c) => !same(c.before, c.after));
  if (!changes.length && h.action !== 'delete') return null;
  const norm = changes.map((c) => ({ field: c.field, before: sortIfArray(c.before), after: sortIfArray(c.after) }));
  const r = await one<{ id: number }>(
    `INSERT INTO rbac_history (batch_id, entity_type, entity_id, entity_label, action, source, actor_id, actor_username, changes, reverts_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [h.batchId ?? null, h.entityType, h.entityId, h.entityLabel ?? h.entityId, h.action, h.source ?? 'manual', h.actor?.id ?? null, h.actor?.username ?? null, JSON.stringify(norm), h.revertsId ?? null],
    db,
  );
  return r?.id ?? null;
}

const sortIfArray = (v: unknown) => (Array.isArray(v) ? [...v].sort() : (v ?? null));

export interface HistoryRow {
  _id: number;
  batchId: string | null;
  entityType: HistoryEntity;
  entityId: string;
  entityLabel: string;
  action: HistoryAction;
  source: HistorySource;
  actor: { _id: string | null; username: string | null } | null;
  changes: FieldChange[];
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  revertsId: number | null;
  createdAt: string;
}

export function mapHistory(r: any): HistoryRow {
  return {
    _id: Number(r.id),
    batchId: r.batch_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    action: r.action,
    source: r.source,
    actor: r.actor_username || r.actor_id ? { _id: r.actor_id, username: r.actor_username } : null,
    changes: r.changes ?? [],
    rolledBackAt: r.rolled_back_at,
    rolledBackBy: r.rolled_back_by_username ?? r.rolled_back_by,
    revertsId: r.reverts_id === null || r.reverts_id === undefined ? null : Number(r.reverts_id),
    createdAt: r.created_at,
  };
}

export async function listHistory(opts: { types: HistoryEntity[]; entityId?: string; actor?: string; start?: string; end?: string; offset?: number; count?: number }) {
  const where = ['h.entity_type = ANY($1)'];
  const params: unknown[] = [opts.types];
  if (opts.entityId) where.push(`h.entity_id = $${params.push(opts.entityId)}`);
  if (opts.actor === 'system') where.push('h.actor_id IS NULL');
  else if (opts.actor) where.push(`h.actor_id = $${params.push(opts.actor)}`);
  if (opts.start) where.push(`h.created_at >= $${params.push(opts.start)}`);
  if (opts.end) where.push(`h.created_at <= $${params.push(opts.end)}`);
  const count = Math.min(Math.max(Number(opts.count) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const rows = await many(
    `SELECT h.*, rb.username AS rolled_back_by_username, count(*) OVER() AS total
     FROM rbac_history h LEFT JOIN users rb ON rb.id = h.rolled_back_by
     WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC, h.id DESC LIMIT ${count} OFFSET ${offset}`,
    params,
  );
  return { items: rows.map(mapHistory), total: rows[0]?.total ?? 0, offset, count };
}

export async function historyActors(types: HistoryEntity[]) {
  const rows = await many(
    `SELECT DISTINCT h.actor_id, coalesce(u.username, h.actor_username) AS username
     FROM rbac_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.entity_type = ANY($1) AND h.actor_id IS NOT NULL ORDER BY 2`,
    [types],
  );
  return rows.map((r) => ({ _id: r.actor_id, username: r.username }));
}

export async function getHistory(id: number, db?: Queryable) {
  const r = await one('SELECT h.*, rb.username AS rolled_back_by_username FROM rbac_history h LEFT JOIN users rb ON rb.id = h.rolled_back_by WHERE h.id = $1', [id], db);
  return r ? mapHistory(r) : null;
}
