// Status personalizados (Administração › Status do usuário), com os nomes do Rocket.Chat (custom-user-status.*).
// O tipo decide o comportamento: quem escolhe um do tipo ocupado fica com status_default = 'busy' e é silenciado.
import type { UserStatus } from '@shared/index';
import { isStatusType, MAX_CUSTOM_STATUSES, normalizeStatusName, sortStatuses, type CustomUserStatus } from '@shared/status';
import { many, one, tx } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { presenceEvent } from './mappers';
import { actorOf, type Ctx } from './users';

const mapStatus = (r: any, withCount = false): CustomUserStatus => ({
  _id: r.id,
  name: r.name,
  statusType: r.status_type,
  ...(withCount ? { usersCount: Number(r.users_count ?? 0) } : {}),
});

export async function getCustomStatus(id: string) {
  return id ? one('SELECT * FROM custom_user_statuses WHERE id = $1', [id]) : null;
}

export async function listCustomStatuses(opts: { withCounts?: boolean } = {}): Promise<CustomUserStatus[]> {
  const rows = await many(
    `SELECT c.*, ${opts.withCounts ? '(SELECT count(*) FROM users u WHERE u.status_custom = c.id)::int' : '0'} AS users_count FROM custom_user_statuses c`,
  );
  return sortStatuses(rows.map((r) => mapStatus(r, opts.withCounts)));
}

// A lista nova para todas as abas abertas (sem usersCount: só quem gerencia vê, e pede pela lista).
async function broadcastStatuses() {
  bus.publish({ all: true }, { type: 'userStatus.changed', statuses: await listCustomStatuses() });
}

// Quem estava com o status muda junto: presença para todos e a escolha só para a própria pessoa.
function publishHolders(rows: any[]) {
  for (const r of rows) {
    bus.publish({ all: true }, presenceEvent(r));
    bus.publish({ user: r.id }, { type: 'user', action: 'updated', user: { _id: r.id, statusDefault: r.status_default, statusCustom: r.status_custom } });
  }
}

function validate(input: { name?: unknown; statusType?: unknown }) {
  const n = normalizeStatusName(input.name);
  if (!n.ok) throw badRequest(n.code, n.error);
  if (!isStatusType(input.statusType)) throw badRequest('error-invalid-status-type', 'Tipo de status inválido.');
  return { name: n.name, statusType: input.statusType as UserStatus };
}

const nameTaken = () => badRequest('error-status-name-exists', 'Já existe um status com esse nome.');

async function assertNameFree(name: string, exceptId?: string) {
  const other = await one('SELECT id FROM custom_user_statuses WHERE wescc_fold(btrim(name)) = wescc_fold(btrim($1)) AND id <> $2', [name, exceptId ?? '']);
  if (other) throw nameTaken();
}

// O índice único é a última barreira (dois administradores ao mesmo tempo): vira o mesmo erro amigável.
function mapUnique(e: any): never {
  if (e?.code === '23505' && String(e.constraint ?? '').includes('custom_user_statuses_name_uq')) throw nameTaken();
  throw e;
}

export async function createCustomStatus(ctx: Ctx, input: { name?: unknown; statusType?: unknown }) {
  const v = validate(input);
  const n = await one('SELECT count(*)::int AS n FROM custom_user_statuses');
  if (n.n >= MAX_CUSTOM_STATUSES) throw badRequest('error-too-many-statuses', `Limite de ${MAX_CUSTOM_STATUSES} status personalizados.`);
  await assertNameFree(v.name);
  const id = newId();
  const row = await one(
    'INSERT INTO custom_user_statuses (id, name, status_type, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
    [id, v.name, v.statusType, ctx.userId],
  ).catch(mapUnique);
  await audit(actorOf(ctx), 'user-status.created', { id, name: v.name }, { statusType: v.statusType });
  await broadcastStatuses();
  return mapStatus(row);
}

export async function updateCustomStatus(ctx: Ctx, id: string, input: { name?: unknown; statusType?: unknown }) {
  const v = validate(input);
  const cur = await getCustomStatus(id);
  if (!cur) throw notFound('error-status-not-found', 'Status não encontrado.');
  await assertNameFree(v.name, id);
  const typeChanged = cur.status_type !== v.statusType;
  const { row, holders } = await tx(async (db) => {
    const row = await one('UPDATE custom_user_statuses SET name = $2, status_type = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, v.name, v.statusType], db).catch(mapUnique);
    // Tipo novo: quem está com o status passa a ter o tipo novo (offline continua offline).
    const holders = typeChanged
      ? await many(
          `UPDATE users SET status_default = $2,
             status = CASE WHEN EXISTS (SELECT 1 FROM presence_connections p WHERE p.user_id = users.id) THEN $2 ELSE 'offline' END
           WHERE status_custom = $1
           RETURNING id, username, status, status_text, status_default, status_custom`,
          [id, v.statusType],
          db,
        )
      : [];
    return { row, holders };
  });
  publishHolders(holders);
  await audit(
    actorOf(ctx),
    'user-status.updated',
    { id, name: v.name },
    { before: { name: cur.name, statusType: cur.status_type }, after: { name: v.name, statusType: v.statusType }, users: holders.length },
  );
  await broadcastStatuses();
  return mapStatus(row);
}

export async function deleteCustomStatus(ctx: Ctx, id: string) {
  const cur = await getCustomStatus(id);
  if (!cur) throw notFound('error-status-not-found', 'Status não encontrado.');
  // Quem estava com ele fica no tipo base (status_default não muda).
  const holders = await tx(async (db) => {
    const rows = await many(
      'UPDATE users SET status_custom = NULL WHERE status_custom = $1 RETURNING id, username, status, status_text, status_default, status_custom',
      [id],
      db,
    );
    await many('DELETE FROM custom_user_statuses WHERE id = $1', [id], db);
    return rows;
  });
  publishHolders(holders);
  await audit(actorOf(ctx), 'user-status.deleted', { id, name: cur.name }, { statusType: cur.status_type, users: holders.length });
  await broadcastStatuses();
}

