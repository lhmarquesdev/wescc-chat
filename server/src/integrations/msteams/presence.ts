// Presença do Teams no chat (fase 3, §5.6, D15): por assinatura quando há endereço público, por consulta só com o
// aceite por escrito. A sincronização "ocupado" é opcional por pessoa e nunca vai do chat para o Teams.
import { TEAMS_BUSY_ACTIVITIES, teamsPresenceLabel, type ExternalPresence } from '@shared/integrations';
import { many, one, query } from '../../db/pool';
import { bus } from '../../realtime/bus';
import { getSetting } from '../../services/settings';
import { setStatusTransient } from '../../services/users';
import { enqueue, type JobRow } from '../jobs';
import type { Lease } from '../runtime';
import { notificationsTarget, pollingAccepted, presenceOn, teamsOn } from './config';
import { graph, odataQuote, toJobError } from './graph';
import { createSubscription, deleteSubscription, setPresenceMissedHandler, type SubRow } from './notifications';
import { lookupQuiet } from './people';

export const PRESENCE_TEXT = {
  busy: 'Em reunião no Teams',
};

const IDS_PER_CALL = 650;
const NEW_LOOKUPS = 50;
const HIT_MS = 7 * 86_400_000;
const MISS_MS = 86_400_000;

export const presenceMinutes = () => Math.min(30, Math.max(5, Math.round(Number(getSetting('MSTeams_Presence_Minutes') ?? 5)) || 5));
export const presenceIntervalMs = () => presenceMinutes() * 60_000;
export const presenceEnabled = () => teamsOn() && presenceOn();

// applied: o que o chat aplicou (para restaurar) ou 'manual' quando a pessoa mudou o status no meio da reunião.
interface Applied {
  status: 'busy' | 'manual';
  previousDefault?: string;
  previousText?: string;
}

const chunk = <T>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Pessoas com a conta Microsoft 365 encontrada pelo e-mail confirmado (que ainda é o e-mail do chat).
async function people(): Promise<{ userId: string; oid: string }[]> {
  const rows = await many(
    `SELECT l.user_id, l.external_id FROM linked_accounts l JOIN users u ON u.id = l.user_id
     WHERE l.provider = 'microsoft' AND l.method = 'directory' AND u.active AND u.type = 'user' AND u.email_verified
       AND u.email IS NOT NULL AND lower(u.email) = lower(l.email)`,
  );
  return rows.map((r) => ({ userId: r.user_id, oid: r.external_id }));
}

// Até 50 buscas novas por rodada (quem ainda não tem conta encontrada, cujo e-mail mudou ou cuja busca venceu).
async function lookupNewPeople(): Promise<void> {
  const rows = await many(
    `SELECT u.id FROM users u
     LEFT JOIN linked_accounts l ON l.user_id = u.id AND l.provider = 'microsoft'
     LEFT JOIN integration_state m ON m.id = 'msteams.people.miss:' || u.id
     WHERE u.active AND u.type = 'user' AND u.email_verified AND u.email IS NOT NULL
       AND (l.user_id IS NULL OR (l.method = 'directory' AND (lower(l.email) IS DISTINCT FROM lower(u.email)
            OR COALESCE((l.meta->>'lookedUpAt')::timestamptz, 'epoch') < now() - $1 * interval '1 millisecond')))
       AND (m.id IS NULL OR m.data->>'email' IS DISTINCT FROM lower(u.email) OR (m.data->>'at')::timestamptz < now() - $2 * interval '1 millisecond')
     ORDER BY u.created_at
     LIMIT ${NEW_LOOKUPS}`,
    [HIT_MS, MISS_MS],
  );
  for (const r of rows) await lookupQuiet(r.id, { interactive: false });
}

// ---------- Aplicar uma presença ----------

export function toPresence(row: { availability: string; activity: string; updated_at: string | Date }): ExternalPresence {
  return {
    provider: 'msteams',
    availability: row.availability,
    activity: row.activity,
    label: teamsPresenceLabel(row.availability, row.activity),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function saveApplied(userId: string, applied: Applied | null) {
  await query(`UPDATE external_presence SET applied = $2 WHERE user_id = $1`, [userId, applied ? JSON.stringify(applied) : null]);
}

// Sincronização opcional: ocupado no Teams → "Em reunião no Teams" (sem tocar no status padrão da pessoa). Uma troca
// manual no meio da reunião vence: o chat não reaplica até a reunião acabar.
async function syncBusy(user: any, busy: boolean, applied: Applied | null) {
  const want = user.busy_sync === true && busy;
  if (want) {
    if (!applied) {
      if (user.status_default !== 'online' || user.status !== 'online') return;
      await saveApplied(user.id, { status: 'busy', previousDefault: 'online', previousText: String(user.status_text ?? '') });
      await setStatusTransient(user.id, 'busy', PRESENCE_TEXT.busy);
      return;
    }
    if (applied.status === 'busy' && (user.status_text !== PRESENCE_TEXT.busy || user.status_default !== applied.previousDefault)) {
      await saveApplied(user.id, { status: 'manual' });
    }
    return;
  }
  if (!applied) return;
  if (applied.status === 'busy' && user.status_text === PRESENCE_TEXT.busy && user.status_default === applied.previousDefault) {
    // Volta o texto anterior; o status só volta se ainda estiver "ocupado" (ausente por inatividade fica como está).
    await setStatusTransient(user.id, user.status === 'busy' ? (applied.previousDefault as any) : undefined, applied.previousText ?? '');
  }
  await saveApplied(user.id, null);
}

export async function applyPresence(p: { id?: unknown; availability?: unknown; activity?: unknown }): Promise<void> {
  const oid = typeof p?.id === 'string' ? p.id : '';
  if (!oid) return;
  const user = await one(
    `SELECT u.id, u.status, u.status_default, u.status_text, (l.meta->>'busySync') = 'true' AS busy_sync
     FROM linked_accounts l JOIN users u ON u.id = l.user_id
     WHERE l.provider = 'microsoft' AND l.method = 'directory' AND l.external_id = $1 AND u.active AND u.email_verified AND lower(u.email) = lower(l.email)`,
    [oid],
  );
  if (!user) return;
  const availability = String(p.availability ?? 'PresenceUnknown').slice(0, 40) || 'PresenceUnknown';
  const activity = String(p.activity ?? availability).slice(0, 40) || availability;
  const prev = await one(`SELECT availability, activity, applied FROM external_presence WHERE user_id = $1`, [user.id]);
  const row = await one(
    `INSERT INTO external_presence (user_id, provider, availability, activity, updated_at) VALUES ($1, 'msteams', $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET availability = EXCLUDED.availability, activity = EXCLUDED.activity, updated_at = now()
     RETURNING availability, activity, updated_at`,
    [user.id, availability, activity],
  );
  if (!prev || prev.availability !== availability || prev.activity !== activity) {
    bus.publish({ all: true }, { type: 'presence.external', userId: user.id, presence: toPresence(row) });
  }
  await syncBusy(user, TEAMS_BUSY_ACTIVITIES.includes(activity), (prev?.applied as Applied | null) ?? null);
}

// POST /communications/getPresencesByUserId (token do aplicativo), até 650 ids por chamada.
export async function fetchPresences(oids: string[], o: { interactive?: boolean } = {}): Promise<void> {
  for (const ids of chunk([...new Set(oids)], IDS_PER_CALL)) {
    const r = await graph<any>('app', 'POST', '/communications/getPresencesByUserId', { ids }, { interactive: o.interactive ?? false, permission: 'Presence.Read.All' });
    for (const p of Array.isArray(r?.value) ? r.value : []) await applyPresence(p);
  }
}

// ---------- Assinaturas ----------

export const presenceResource = (ids: string[]) => `/communications/presences?$filter=id in (${ids.map(odataQuote).join(',')})`;

export function idsOfResource(resource: string): string[] {
  return [...String(resource).matchAll(/'((?:[^']|'')+)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

// Assinaturas cobrem todas as pessoas: quem entrou ganha uma assinatura nova; as antigas saem depois (sem buraco).
async function syncSubscriptions(oids: string[]): Promise<void> {
  const subs = (await many(`SELECT * FROM msteams_subscriptions WHERE purpose = 'presence'`)) as SubRow[];
  const live = subs.filter((s) => new Date(s.expires_at).getTime() > Date.now() + 60_000);
  const covered = new Set(live.flatMap((s) => idsOfResource(s.resource)));
  const missing = oids.filter((id) => !covered.has(id));
  for (const s of subs) if (!live.includes(s)) await deleteSubscription(s.id);
  if (!missing.length) return;
  for (const ids of chunk(oids, IDS_PER_CALL)) await createSubscription('presence', presenceResource(ids), null);
  for (const s of live) await deleteSubscription(s.id);
  // A assinatura só avisa mudanças: a presença atual de quem entrou é lida uma vez.
  await fetchPresences(missing);
}

// ---------- Rodada periódica ----------

export async function presenceRun(lease: Lease): Promise<void> {
  if (!presenceEnabled()) return;
  const target = await notificationsTarget();
  const mode = target.url ? 'subscriptions' : (await pollingAccepted()) ? 'polling' : null;
  if (!mode) return;
  let lookupError: unknown = null;
  try {
    await lookupNewPeople();
  } catch (e) {
    lookupError = e;
  }
  await lease.renew();
  const oids = (await people()).map((p) => p.oid);
  if (mode === 'subscriptions') {
    if (oids.length) await syncSubscriptions(oids);
  } else {
    for (const s of await many(`SELECT id FROM msteams_subscriptions WHERE purpose = 'presence'`)) await deleteSubscription(s.id);
    await fetchPresences(oids);
  }
  if (lookupError) throw lookupError;
}

// msteams.presence: uma notificação (ids citados) ou a recuperação depois de notificações perdidas (todas).
export async function presenceJob(job: JobRow): Promise<void> {
  if (!presenceEnabled()) return;
  const all = job.payload?.all === true;
  const known = new Set((await people()).map((p) => p.oid));
  const ids = all ? [...known] : (Array.isArray(job.payload?.ids) ? job.payload.ids : []).filter((id: unknown): id is string => typeof id === 'string' && known.has(id));
  if (!ids.length) return;
  try {
    await fetchPresences(ids);
  } catch (e) {
    throw toJobError(e);
  }
}

// GET msteams.presence: até 100 pessoas, para quem está logado.
export async function presenceFor(userIds: string[]): Promise<Record<string, ExternalPresence>> {
  const out: Record<string, ExternalPresence> = {};
  if (!presenceEnabled() || !userIds.length) return out;
  const rows = await many(`SELECT user_id, availability, activity, updated_at FROM external_presence WHERE user_id = ANY($1)`, [userIds.slice(0, 100)]);
  for (const r of rows) out[r.user_id] = toPresence(r);
  return out;
}

setPresenceMissedHandler(async () => {
  await enqueue('msteams.presence', { all: true }, { groupKey: 'msteams.presence' });
});
