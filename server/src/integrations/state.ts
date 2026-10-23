import type { Provider } from '@shared/integrations';
import { one, query } from '../db/pool';
import { newId } from '../lib/ids';
import { truncate } from '../lib/text';
import { bus } from '../realtime/bus';

// Estado pequeno das integrações (integration_state), linhas de atividade e chaves já vistas.

export async function getState<T>(id: string): Promise<T | null> {
  const r = await one('SELECT data FROM integration_state WHERE id = $1', [id]);
  return (r?.data as T) ?? null;
}

export async function setState(id: string, data: unknown): Promise<void> {
  if (data === null || data === undefined) {
    await query('DELETE FROM integration_state WHERE id = $1', [id]);
    return;
  }
  await query(
    `INSERT INTO integration_state (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, JSON.stringify(data)],
  );
}

// Junta campos ao estado que já existe (sem apagar os outros).
export async function mergeState(id: string, patch: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO integration_state (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = integration_state.data || EXCLUDED.data, updated_at = now()`,
    [id, JSON.stringify(patch)],
  );
}

// Uma vez por período por chave, também entre instâncias: true quando é a vez de fazer.
export async function once(key: string, periodMs: number): Promise<boolean> {
  const r = await one(
    `INSERT INTO integration_seen (scope, key) VALUES ('once', $1)
     ON CONFLICT (scope, key) DO UPDATE SET created_at = now()
       WHERE integration_seen.created_at < now() - $2 * interval '1 millisecond'
     RETURNING 1 AS ok`,
    [truncate(key, 400), Math.max(0, Math.round(periodMs))],
  );
  return !!r;
}

export async function activity(p: {
  provider: Provider;
  integrationId?: string | null;
  tone: 'ok' | 'warn' | 'err' | 'info';
  text: string;
  detail?: string | null;
  jobId?: string | null;
  onceKey?: string;
  oncePerMs?: number;
}): Promise<void> {
  if (p.onceKey && !(await once(`activity:${p.provider}:${p.onceKey}`, p.oncePerMs ?? 3600_000))) return;
  await query(
    `INSERT INTO integration_activity (id, provider, integration_id, tone, text, detail, job_id)
     VALUES ($1, $2, (SELECT id FROM integrations WHERE id = $3), $4, $5, $6, $7)`,
    [newId(), p.provider, p.integrationId ?? null, p.tone, truncate(p.text, 1000), p.detail ? truncate(p.detail, 300) : null, p.jobId ?? null],
  );
}

// ok: a regra funcionou agora (o erro anterior sai); senão grava o erro e quando.
export async function markRule(ruleId: string, ok: boolean, error?: string | null): Promise<void> {
  if (ok) await query('UPDATE integrations SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1', [ruleId]);
  else await query('UPDATE integrations SET last_error = $2, last_error_at = now() WHERE id = $1', [ruleId, truncate(error ?? 'Erro desconhecido.', 500)]);
}

// true se a chave já existia (e grava quando não).
export async function seen(scope: string, key: string): Promise<boolean> {
  const r = await one(`INSERT INTO integration_seen (scope, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1 AS ok`, [scope, key]);
  return !r;
}

// Publicação no chat no máximo uma vez: sem linha nova, já foi publicada.
export async function claimPost(key: string): Promise<boolean> {
  const r = await one(`INSERT INTO integration_seen (scope, key) VALUES ('post', $1) ON CONFLICT DO NOTHING RETURNING 1 AS ok`, [key]);
  return !!r;
}

export async function releasePost(key: string): Promise<void> {
  await query(`DELETE FROM integration_seen WHERE scope = 'post' AND key = $1`, [key]);
}

// Clientes abertos recarregam integrations.me (config) ou a conta da pessoa (account).
export function publishChanged(scope: 'config' | 'account', userId?: string) {
  bus.publish(scope === 'account' && userId ? { user: userId } : { all: true }, { type: 'integrations.changed', scope });
}
