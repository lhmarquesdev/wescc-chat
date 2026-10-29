import crypto from 'node:crypto';
import os from 'node:os';
import type { Provider } from '@shared/integrations';
import { many, one, query, tx } from '../db/pool';
import { ApiError, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { integrationsPaused, keyReady } from '../lib/secrets';
import { SafeFetchError } from '../lib/safeFetch';
import { truncate } from '../lib/text';
import { getSetting } from '../services/settings';
import { alertText, raiseAlert } from './alerts';
import { activity, markRule } from './state';

// Fila persistente das integrações: chamadas externas e publicações com novas tentativas, em ordem dentro de cada
// grupo (regra e sala), compartilhada por todas as instâncias pelo banco.

export class RetryLater extends Error {
  constructor(
    message: string,
    public afterMs?: number,
    public countAttempt = true,
  ) {
    super(message);
  }
}
export class PermanentError extends Error {}

// Erros de sendMessage e afins: ApiError 400/403/404 → PermanentError; o resto (banco, pool, rede) → RetryLater.
export function classifyError(e: unknown, text: string): PermanentError | RetryLater {
  if (e instanceof PermanentError || e instanceof RetryLater) return e;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const full = !msg || text.includes(msg) ? text : `${text}: ${msg}`;
  if (e instanceof ApiError && [400, 403, 404].includes(e.statusCode)) return new PermanentError(full);
  if (e instanceof SafeFetchError && (e.code === 'error-url-not-allowed' || e.code === 'error-url-internal')) return new PermanentError(full);
  return new RetryLater(full);
}

export interface JobRow {
  id: string;
  kind: string;
  integrationId: string | null;
  groupKey: string | null;
  payload: any;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
}
export type JobHandler = (job: JobRow) => Promise<void>;

interface Registered {
  handler: JobHandler;
  provider: Provider;
  concurrency: number;
  describe?: (job: JobRow) => string;
}

const handlers = new Map<string, Registered>();
const DEFAULT_CONCURRENCY: Record<string, number> = { 'jira.post': 4, 'msteams.post': 4 };
const MAX_QUEUED = 20_000;
const MAX_DELAY = 6 * 3600_000;
const STALE_OFF_MS = 6 * 3600_000;
const STALE_KINDS = ['jira.post', 'msteams.post', 'msteams.digest'];
const STALE_TEXT = 'A integração ficou desligada por mais de 6 horas; este aviso antigo foi descartado.';
const STUCK_TEXT = 'A tarefa travou ou derrubou o servidor nas últimas tentativas.';
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

export function registerJobHandler(kind: string, handler: JobHandler, opts: { provider: Provider; concurrency?: number; describe?: (job: JobRow) => string }): void {
  handlers.set(kind, { handler, provider: opts.provider, concurrency: Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY[kind] ?? 2), describe: opts.describe });
}

const providerOf = (kind: string): Provider => handlers.get(kind)?.provider ?? (kind.startsWith('msteams') ? 'msteams' : 'jira');

const mapJob = (r: any): JobRow => ({
  id: r.id,
  kind: r.kind,
  integrationId: r.integration_id ?? null,
  groupKey: r.group_key ?? null,
  payload: r.payload ?? {},
  attempts: Number(r.attempts ?? 0),
  maxAttempts: Number(r.max_attempts ?? 6),
  createdAt: r.created_at,
});

// ---------- Entrada na fila ----------

const queuedCount = new Map<string, { n: number; at: number }>();

async function queueFull(kind: string): Promise<boolean> {
  const c = queuedCount.get(kind);
  if (c && Date.now() - c.at < 5000) return c.n >= MAX_QUEUED;
  const r = await one(`SELECT count(*)::int AS n FROM (SELECT 1 FROM integration_jobs WHERE kind = $1 AND status = 'queued' LIMIT $2) s`, [kind, MAX_QUEUED + 1]);
  const n = Number(r?.n ?? 0);
  queuedCount.set(kind, { n, at: Date.now() });
  return n >= MAX_QUEUED;
}

// null: a dedupe_key já existe (ou a fila daquele tipo está cheia, o que vira uma linha de atividade).
export async function enqueue(
  kind: string,
  payload: object,
  opts: { integrationId?: string | null; groupKey?: string | null; dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  if (await queueFull(kind)) {
    await activity({ provider: providerOf(kind), tone: 'err', text: `Fila de tarefas cheia (${kind}).`, onceKey: `queue-full:${kind}`, oncePerMs: 3600_000 });
    return null;
  }
  const r = await one(
    `INSERT INTO integration_jobs (id, kind, integration_id, group_key, payload, dedupe_key, max_attempts, run_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), clock_timestamp())
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [newId(), kind, opts.integrationId ?? null, opts.groupKey ?? null, JSON.stringify(payload ?? {}), opts.dedupeKey ?? null, opts.maxAttempts ?? 6, opts.runAt ?? null],
  );
  if (!r) return null;
  const c = queuedCount.get(kind);
  if (c) c.n++;
  return r.id;
}

// ---------- Resumo de rajadas ----------

const mergedSelf = new Set<string>();

// Marca como 'merged' as tarefas `kind` na fila do grupo (mais a atual, includeJobId, que fica 'merged' quando o handler
// termina) e as devolve em ordem, para virarem um resumo; null se forem menos que minCount. withinMs: só as criadas
// até withinMs depois da mais antiga. Numa nova tentativa da atual, as que ela já juntou voltam na lista.
export async function collapseQueued(groupKey: string, kind: string, o: { includeJobId?: string; minCount: number; withinMs?: number; max?: number }): Promise<JobRow[] | null> {
  const owner = o.includeJobId ? `merged:${o.includeJobId}` : `merged:${newId()}`;
  const max = Math.max(1, o.max ?? 200);
  const rows = await tx(async (c) => {
    const found = (
      await c.query(
        `SELECT * FROM integration_jobs
         WHERE group_key = $1 AND kind = $2
           AND (status = 'queued' OR (status = 'merged' AND locked_by = $3) OR id = $4)
         ORDER BY created_at, id
         LIMIT $5
         FOR UPDATE`,
        [groupKey, kind, owner, o.includeJobId ?? null, max],
      )
    ).rows;
    if (!found.length) return null;
    const first = new Date(found[0].created_at).getTime();
    const within = o.withinMs === undefined ? found : found.filter((r) => new Date(r.created_at).getTime() - first <= o.withinMs!);
    if (within.length < o.minCount) return null;
    const ids = within.filter((r) => r.id !== o.includeJobId && r.status === 'queued').map((r) => r.id);
    if (ids.length) {
      await c.query(`UPDATE integration_jobs SET status = 'merged', locked_by = $2, finished_at = now() WHERE id = ANY($1::text[])`, [ids, owner]);
    }
    return within;
  });
  if (!rows) return null;
  if (o.includeJobId) mergedSelf.add(o.includeJobId);
  return rows.map(mapJob);
}

// ---------- Reserva e execução ----------

// Fornecedor ligado e chave de segredos em ordem: só então as tarefas dele são reservadas.
const lastEnabled = new Map<Provider, boolean>();

function providerOn(p: Provider): boolean {
  if (integrationsPaused()) return false;
  return getSetting(p === 'jira' ? 'Jira_Enabled' : 'MSTeams_Enabled') === true;
}

// Ao religar (e na subida), avisos guardados há mais de 6 horas não são mais publicados.
async function noteProviderState(p: Provider): Promise<boolean> {
  const on = providerOn(p);
  const before = lastEnabled.get(p);
  lastEnabled.set(p, on);
  if (on && before !== true) await discardStale(p);
  return on;
}

async function discardStale(p: Provider) {
  const kinds = STALE_KINDS.filter((k) => providerOf(k) === p);
  const rows = await many(
    `UPDATE integration_jobs SET status = 'dead', finished_at = now(), last_error = $3
     WHERE status = 'queued' AND kind = ANY($1::text[]) AND created_at < now() - $2 * interval '1 millisecond'
     RETURNING integration_id`,
    [kinds, STALE_OFF_MS, STALE_TEXT],
  );
  const perRule = new Map<string | null, number>();
  for (const r of rows) perRule.set(r.integration_id ?? null, (perRule.get(r.integration_id ?? null) ?? 0) + 1);
  for (const [integrationId, n] of perRule) {
    const text = n === 1 ? STALE_TEXT : `A integração ficou desligada por mais de 6 horas; ${n} avisos antigos foram descartados.`;
    await activity({ provider: p, integrationId, tone: 'warn', text });
  }
}

const running = new Map<string, number>();

async function claim(kind: string, limit: number): Promise<JobRow[]> {
  if (limit <= 0) return [];
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727125)');
    const r = await c.query(
      `UPDATE integration_jobs j SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
       WHERE j.id IN (
         SELECT c.id FROM integration_jobs c
         WHERE c.status = 'queued' AND c.run_at <= now() AND c.kind = ANY($2)
           AND (c.group_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM integration_jobs o
             WHERE o.group_key = c.group_key AND o.id <> c.id
               AND (o.status = 'running' OR (o.status = 'queued' AND (o.created_at, o.id) < (c.created_at, c.id)))))
         ORDER BY c.created_at
         LIMIT $3)
       RETURNING *`,
      [WORKER_ID, [kind], limit],
    );
    return r.rows.map(mapJob);
  });
}

function delayFor(job: JobRow, e: RetryLater | null): number {
  if (e?.afterMs !== undefined && e.afterMs !== null && Number.isFinite(e.afterMs)) return Math.min(MAX_DELAY, Math.max(0, e.afterMs));
  const base = Math.min(MAX_DELAY, 30_000 * 4 ** Math.max(0, job.attempts - 1));
  return base * (0.7 + Math.random() * 0.6);
}

// Só a execução que reservou a tarefa grava o resultado: um handler que travou e terminou depois que a limpeza
// devolveu (ou matou) a tarefa não apaga o que veio depois.
const MINE = `id = $1 AND status = 'running' AND attempts = $2`;

async function runJob(job: JobRow): Promise<void> {
  const reg = handlers.get(job.kind);
  running.set(job.kind, (running.get(job.kind) ?? 0) + 1);
  try {
    if (!reg) {
      // Sem handler nesta instância: volta para a fila sem gastar a tentativa.
      await query(`UPDATE integration_jobs SET status = 'queued', attempts = GREATEST(0, attempts - 1), locked_by = NULL, locked_at = NULL WHERE ${MINE}`, [job.id, job.attempts]);
      return;
    }
    try {
      await reg.handler(job);
      const status = mergedSelf.has(job.id) ? 'merged' : 'done';
      await query(`UPDATE integration_jobs SET status = $3, finished_at = now(), last_error = NULL WHERE ${MINE}`, [job.id, job.attempts, status]);
    } catch (e) {
      await failJob(job, reg, e);
    }
  } finally {
    mergedSelf.delete(job.id);
    running.set(job.kind, Math.max(0, (running.get(job.kind) ?? 1) - 1));
  }
}

async function failJob(job: JobRow, reg: Registered, e: unknown) {
  const err = classifyError(e, e instanceof Error && e.message ? e.message : 'Falha inesperada.');
  const text = truncate(err.message || 'Erro desconhecido.', 500);
  if (err instanceof RetryLater && !err.countAttempt) {
    await query(
      `UPDATE integration_jobs SET status = 'queued', attempts = GREATEST(0, attempts - 1), run_at = now() + $3 * interval '1 millisecond',
         locked_by = NULL, locked_at = NULL, last_error = $4 WHERE ${MINE}`,
      [job.id, job.attempts, Math.round(delayFor(job, err)), text],
    );
    return;
  }
  if (err instanceof RetryLater && job.attempts < job.maxAttempts) {
    await query(
      `UPDATE integration_jobs SET status = 'queued', run_at = now() + $3 * interval '1 millisecond', locked_by = NULL, locked_at = NULL, last_error = $4 WHERE ${MINE}`,
      [job.id, job.attempts, Math.round(delayFor(job, err)), text],
    );
    return;
  }
  const r = await query(`UPDATE integration_jobs SET status = 'dead', finished_at = now(), last_error = $3 WHERE ${MINE}`, [job.id, job.attempts, text]);
  if (r.rowCount) await onDead(job, reg.provider, reg.describe, text);
}

async function onDead(job: JobRow, provider: Provider, describe: ((job: JobRow) => string) | undefined, text: string) {
  let label: string;
  try {
    label = describe ? describe(job) : `Tarefa ${job.kind}`;
  } catch {
    label = `Tarefa ${job.kind}`;
  }
  await activity({
    provider,
    integrationId: job.integrationId,
    tone: 'err',
    text: `${label}: ${text}`,
    detail: `${job.kind} · tentativa ${job.attempts} de ${job.maxAttempts}`,
    jobId: job.id,
  }).catch(() => {});
  if (!job.integrationId) return;
  await markRule(job.integrationId, false, text).catch(() => {});
  const rule = await one(`SELECT name, config FROM integrations WHERE id = $1`, [job.integrationId]).catch(() => null);
  if (!rule) return;
  const name = String(rule.name ?? '');
  if (provider === 'jira') {
    await raiseAlert({ key: `jira.rule:${job.integrationId}`, provider, tone: 'err', text: alertText(`A regra “${name}” do Jira não conseguiu publicar`, text), href: '/admin/integrations/jira/avisos', to: 'managers' }).catch(() => {});
  } else if (job.kind === 'msteams.post' || job.kind === 'msteams.digest') {
    await raiseAlert({ key: `msteams.out:${job.integrationId}`, provider, tone: 'err', text: alertText(`O envio “${name}” para o Teams falhou`, text), href: '/admin/integrations/teams/envio', to: 'managers' }).catch(() => {});
  } else if (job.groupKey?.startsWith('msteams.in:')) {
    const team = rule.config?.team?.name ?? rule.config?.teamName ?? name;
    const channel = rule.config?.channel?.name ?? rule.config?.channelName ?? '';
    const where = channel ? `${team} › ${channel}` : team;
    await raiseAlert({ key: `msteams.in:${job.integrationId}`, provider, tone: 'err', text: alertText(`As mensagens do canal ${where} não estão chegando ao chat`, text), href: '/admin/integrations/teams/recebimento', to: 'managers' }).catch(() => {});
  }
}

// Uma rodada: para cada tipo com handler e fornecedor ligado, reserva até as vagas livres e devolve as tarefas.
async function claimRound(onlyKinds?: string[]): Promise<JobRow[]> {
  const kinds = [...handlers.keys()].filter((k) => !onlyKinds || onlyKinds.includes(k));
  if (!kinds.length) return [];
  await keyReady();
  const on = new Map<Provider, boolean>();
  for (const p of new Set(kinds.map(providerOf))) on.set(p, await noteProviderState(p));
  const active = kinds.filter((k) => on.get(providerOf(k)));
  if (!active.length) return [];
  const due = (await many(`SELECT DISTINCT kind FROM integration_jobs WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1::text[])`, [active])).map((r) => r.kind as string);
  const out: JobRow[] = [];
  for (const kind of due) {
    const free = (handlers.get(kind)?.concurrency ?? 2) - (running.get(kind) ?? 0);
    out.push(...(await claim(kind, free)));
  }
  return out;
}

export function startJobWorker(log: (m: string) => void): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastError = '';
  const tick = async () => {
    if (stopped) return;
    let found = false;
    try {
      const jobs = await claimRound();
      found = jobs.length > 0;
      for (const j of jobs) void runJob(j).catch((e) => log(`[integrações] tarefa ${j.kind} ${j.id}: ${(e as Error).message}`));
      lastError = '';
    } catch (e) {
      const m = (e as Error).message;
      if (m !== lastError) log(`[integrações] fila de tarefas: ${m}`);
      lastError = m;
    }
    if (!stopped) {
      timer = setTimeout(tick, found ? 1000 : 5000);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, 1000);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// Testes: roda até não haver tarefa vencida (ou até maxMs). Devolve quantas rodaram.
export async function drainJobs(opts: { kinds?: string[]; maxMs?: number } = {}): Promise<number> {
  const until = Date.now() + (opts.maxMs ?? 30_000);
  let n = 0;
  while (Date.now() < until) {
    const jobs = await claimRound(opts.kinds);
    if (!jobs.length) {
      // Pode haver tarefas do mesmo grupo esperando as que ainda rodam em outro lugar deste processo.
      const busy = [...running.values()].some((v) => v > 0);
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    await Promise.all(jobs.map((j) => runJob(j)));
    n += jobs.length;
  }
  return n;
}

// ---------- Ações do administrador ----------

export async function retryJob(jobId: string): Promise<void> {
  const r = await query(
    `UPDATE integration_jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL, locked_by = NULL, locked_at = NULL
     WHERE id = $1 AND status = 'dead'`,
    [jobId],
  );
  if (!r.rowCount) throw notFound('error-not-found', 'Esta tarefa já foi reenviada ou não existe mais.');
}

export async function retryDead(integrationId: string): Promise<number> {
  const r = await query(
    `UPDATE integration_jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL, finished_at = NULL, locked_by = NULL, locked_at = NULL
     WHERE integration_id = $1 AND status = 'dead'`,
    [integrationId],
  );
  return r.rowCount ?? 0;
}

// ---------- Limpeza (a cada 10 min, sob lease) ----------

export async function sweepJobs(): Promise<void> {
  // Presa em running (o worker caiu ou o handler parou): volta para a fila; se já gastou as tentativas, morre, para
  // uma tarefa que derruba o servidor não ser reservada para sempre nem segurar o grupo dela.
  const stuck = await many(
    `UPDATE integration_jobs SET status = 'dead', finished_at = now(), last_error = $1, locked_by = NULL, locked_at = NULL
     WHERE status = 'running' AND locked_at < now() - interval '5 minutes' AND attempts >= max_attempts
     RETURNING *`,
    [STUCK_TEXT],
  );
  for (const r of stuck) {
    const job = mapJob(r);
    await onDead(job, providerOf(job.kind), handlers.get(job.kind)?.describe, STUCK_TEXT);
  }
  await query(`UPDATE integration_jobs SET status = 'queued', locked_by = NULL, locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`);
  await query(`DELETE FROM integration_jobs WHERE status IN ('done', 'merged') AND COALESCE(finished_at, created_at) < now() - interval '1 day'`);
  await query(`DELETE FROM integration_jobs WHERE status = 'dead' AND COALESCE(finished_at, created_at) < now() - interval '14 days'`);
  await query(`DELETE FROM integration_seen WHERE created_at < now() - interval '7 days'`);
  await query(`DELETE FROM integration_oauth_states WHERE expires_at < now()`);
  await query(`DELETE FROM integration_activity WHERE created_at < now() - interval '30 days'`);
  await query(
    `DELETE FROM integration_activity a USING (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY provider ORDER BY created_at DESC, id DESC) AS n FROM integration_activity) r WHERE r.n > 2000
     ) old WHERE a.id = old.id`,
  );
}

// Para a API e os testes.
export async function getJob(jobId: string): Promise<(JobRow & { status: string; lastError: string | null; runAt: string; provider: Provider }) | null> {
  const r = await one('SELECT * FROM integration_jobs WHERE id = $1', [jobId]);
  if (!r) return null;
  return { ...mapJob(r), status: r.status, lastError: r.last_error ?? null, runAt: r.run_at, provider: providerOf(r.kind) };
}

export const jobProvider = providerOf;
