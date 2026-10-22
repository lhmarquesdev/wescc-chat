import os from 'node:os';
import type { LdapRunStatus, LdapSyncChange, LdapSyncChangeKind, LdapSyncCounts, LdapSyncIssue, LdapSyncRun } from '@shared/ldap';
import { config } from '../config';
import { many, one, pool, query } from '../db/pool';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';

// Execuções da sincronização: trava entre instâncias, linha de histórico e o que cada execução registrou.

const LDAP_LOCK = 727103; // a mesma chave que o agendador usava
const MAX_CHANGES = 500;
const MAX_ERRORS = 200;
const MAX_WARNINGS = 100;
const KEEP_RUNS = 100;
const INTERRUPTED = 'Interrompida (o servidor parou durante a sincronização).';

export type LdapTrigger = LdapSyncRun['trigger'];

export const emptyCounts = (): LdapSyncCounts => ({
  seen: 0,
  imported: 0,
  updated: 0,
  changed: 0,
  deactivated: 0,
  reactivated: 0,
  skipped: 0,
  errors: 0,
  avatars: 0,
  rolesChanged: 0,
  channelsAdded: 0,
  channelsRemoved: 0,
  teamsAdded: 0,
  teamsRemoved: 0,
});

// O advisory lock é da conexão: fica num cliente dedicado do pool durante toda a execução.
export async function tryLdapLock(): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LDAP_LOCK]);
    if (!r.rows[0].ok) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release(true);
    throw e;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LDAP_LOCK]);
      client.release();
    } catch {
      // Sem o unlock, descarta a conexão: o lock some com ela.
      client.release(true);
    }
  };
}

// O que uma execução (ou uma prévia) registra, com os limites de tamanho do histórico.
export class RunLog {
  counts = emptyCounts();
  changes: LdapSyncChange[] = [];
  changesTotal = 0;
  errors: LdapSyncIssue[] = [];
  warnings: string[] = [];
  private warned = new Set<string>();
  guardFired = false;

  change(username: string, kind: LdapSyncChangeKind, detail: string) {
    this.changesTotal++;
    if (this.changes.length < MAX_CHANGES) this.changes.push({ username, kind, detail });
  }

  issue(i: LdapSyncIssue) {
    this.counts.errors++;
    if (this.errors.length < MAX_ERRORS) this.errors.push(i);
  }

  warn(text: string) {
    if (this.warned.has(text)) return;
    this.warned.add(text);
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(text);
  }
}

// Execuções que estão de fato rodando nesta instância.
const activeRuns = new Set<string>();
let beatTimer: NodeJS.Timeout | null = null;

// Marca esta instância como viva (e recria a linha se a limpeza do agendador a apagou). Sem o agendador
// (DISABLE_CRON) só isto atualiza last_seen, e outra instância daria a execução daqui por interrompida
// (failDeadRuns). Roda antes de a execução aparecer e a cada 20 s enquanto houver uma rodando.
async function heartbeat() {
  await query(`INSERT INTO instances (id, info) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET last_seen = now()`, [
    bus.origin,
    JSON.stringify({ pid: process.pid, host: os.hostname(), port: config.port }),
  ]);
}

export async function insertRun(trigger: LdapTrigger, startedBy: string | null): Promise<string> {
  await heartbeat();
  // Quem chama tem o lock: nenhuma outra sincronização roda, então toda linha "running" é de uma instância que parou.
  await query(`UPDATE ldap_sync_runs SET status = 'failed', error = $1 WHERE status = 'running'`, [INTERRUPTED]);
  const id = newId();
  await query(`INSERT INTO ldap_sync_runs (id, trigger, status, started_by, instance_id) VALUES ($1, $2, 'running', $3, $4)`, [id, trigger, startedBy, bus.origin]);
  activeRuns.add(id);
  if (!beatTimer) {
    beatTimer = setInterval(() => void heartbeat().catch(() => {}), 20_000);
    beatTimer.unref();
  }
  return id;
}

function endRun(runId: string) {
  activeRuns.delete(runId);
  if (!activeRuns.size && beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

const countsJson = (log: RunLog) => JSON.stringify({ ...log.counts, changesTotal: log.changesTotal });

export async function saveProgress(runId: string, log: RunLog) {
  await query(`UPDATE ldap_sync_runs SET counts = $2 WHERE id = $1 AND status = 'running'`, [runId, countsJson(log)]);
}

export async function finishRun(runId: string, status: LdapRunStatus, log: RunLog, error: string | null = null) {
  try {
    await query(
      `UPDATE ldap_sync_runs SET status = $2, finished_at = now(), counts = $3, changes = $4, errors = $5, warnings = $6, error = $7 WHERE id = $1`,
      [runId, status, countsJson(log), JSON.stringify(log.changes), JSON.stringify(log.errors), JSON.stringify(log.warnings), error],
    );
  } finally {
    endRun(runId);
  }
  await query(`DELETE FROM ldap_sync_runs WHERE id IN (SELECT id FROM ldap_sync_runs ORDER BY started_at DESC, id DESC OFFSET ${KEEP_RUNS})`);
}

// Sem o lock (tela de status): só marca as execuções desta instância que não rodam mais e as de instâncias paradas.
export async function failDeadRuns() {
  await query(
    `UPDATE ldap_sync_runs r SET status = 'failed', error = $1
     WHERE status = 'running' AND (
       (instance_id = $2 AND NOT (id = ANY($3::text[])))
       OR (instance_id IS DISTINCT FROM $2 AND NOT EXISTS (SELECT 1 FROM instances i WHERE i.id = r.instance_id AND i.last_seen > now() - interval '90 seconds'))
     )`,
    [INTERRUPTED, bus.origin, [...activeRuns]],
  );
}

const RUN_SELECT = `SELECT r.id, r.trigger, r.status, r.started_by, r.started_at, r.finished_at, r.counts, r.error,
    jsonb_array_length(r.changes) AS changes_len, jsonb_array_length(r.errors) AS errors_len, jsonb_array_length(r.warnings) AS warnings_len,
    u.username AS started_by_username, u.name AS started_by_name`;

export function mapRun(r: any, withLists = false): LdapSyncRun {
  const base = emptyCounts();
  const raw = r.counts ?? {};
  const counts = Object.fromEntries(Object.keys(base).map((k) => [k, Number(raw[k] ?? 0)])) as unknown as LdapSyncCounts;
  const started = new Date(r.started_at);
  const finished = r.finished_at ? new Date(r.finished_at) : null;
  const run: LdapSyncRun = {
    _id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedBy: r.started_by ? { _id: r.started_by, username: r.started_by_username, name: r.started_by_name ?? undefined } : null,
    startedAt: started.toISOString(),
    finishedAt: finished ? finished.toISOString() : null,
    durationMs: finished ? finished.getTime() - started.getTime() : null,
    counts,
    error: r.error ?? null,
    changesCount: Math.max(Number(raw.changesTotal ?? 0), Number(r.changes_len ?? 0)),
    errorsCount: Math.max(counts.errors, Number(r.errors_len ?? 0)),
    warningsCount: Number(r.warnings_len ?? 0),
  };
  if (withLists) {
    run.changes = r.changes ?? [];
    run.errors = r.errors ?? [];
    run.warnings = r.warnings ?? [];
  }
  return run;
}

export async function getRun(runId: string): Promise<LdapSyncRun | null> {
  const r = await one(`${RUN_SELECT}, r.changes, r.errors, r.warnings FROM ldap_sync_runs r LEFT JOIN users u ON u.id = r.started_by WHERE r.id = $1`, [runId]);
  return r ? mapRun(r, true) : null;
}

export async function listRuns(offset: number, count: number): Promise<{ runs: LdapSyncRun[]; total: number }> {
  const rows = await many(
    `${RUN_SELECT}, count(*) OVER() AS total FROM ldap_sync_runs r LEFT JOIN users u ON u.id = r.started_by
     ORDER BY r.started_at DESC, r.id DESC LIMIT $1 OFFSET $2`,
    [count, offset],
  );
  const total = rows.length ? Number(rows[0].total) : Number((await one('SELECT count(*)::int AS n FROM ldap_sync_runs'))?.n ?? 0);
  return { runs: rows.map((r) => mapRun(r)), total };
}

export async function currentRuns(): Promise<{ running: LdapSyncRun | null; lastRun: LdapSyncRun | null }> {
  await failDeadRuns();
  const from = `FROM ldap_sync_runs r LEFT JOIN users u ON u.id = r.started_by`;
  const running = await one(`${RUN_SELECT} ${from} WHERE r.status = 'running' ORDER BY r.started_at DESC LIMIT 1`);
  const last = await one(`${RUN_SELECT} ${from} WHERE r.status <> 'running' ORDER BY r.started_at DESC, r.id DESC LIMIT 1`);
  return { running: running ? mapRun(running) : null, lastRun: last ? mapRun(last) : null };
}
