import crypto from 'node:crypto';
import os from 'node:os';
import type { Provider } from '@shared/integrations';
import { many, one, query } from '../db/pool';
import { checkSharedKey, integrationsPaused, KEY_MISMATCH, keyInfo, keyMismatch, keyReady } from '../lib/secrets';
import { getSetting } from '../services/settings';
import { alertText, clearAlert, raiseAlert } from './alerts';
import { startJobWorker, sweepJobs } from './jobs';
import { activity, getState, mergeState } from './state';

// Tarefas periódicas das integrações: leases no banco (uma instância por vez, sem segurar conexão durante HTTP),
// consultas periódicas ao Jira e ao Teams, a fila de tarefas, a limpeza e as conferências diárias.

const INSTANCE = `${os.hostname()}:${process.pid}`;
const runId = () => `${INSTANCE}:${crypto.randomBytes(6).toString('hex')}`;
const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const LABEL: Record<Provider, string> = { jira: 'Jira', msteams: 'Teams' };

// ---------- Leases ----------

export interface Lease {
  renew(): Promise<boolean>;
}

async function takeLease(id: string, ttlMs: number, owner: string): Promise<boolean> {
  const r = await one(
    `INSERT INTO integration_state (id, data, updated_at)
     VALUES ($1, jsonb_build_object('until', now() + $2 * interval '1 millisecond', 'owner', $3::text), now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       WHERE (integration_state.data->>'until')::timestamptz < now() OR integration_state.data->>'owner' = $3
     RETURNING id`,
    [`lease:${id}`, ttlMs, owner],
  );
  return !!r;
}

// Lease em integration_state 'lease:<id>': uma instância por vez. false: outra instância está com ele.
export async function withLease(id: string, ttlMs: number, fn: (lease: Lease) => Promise<void>, owner = runId()): Promise<boolean> {
  const ttl = Math.max(60_000, Math.round(ttlMs));
  if (!(await takeLease(id, ttl, owner))) return false;
  try {
    await fn({ renew: () => takeLease(id, ttl, owner) });
  } finally {
    await query(
      `UPDATE integration_state SET data = jsonb_set(data, '{until}', to_jsonb(now())), updated_at = now() WHERE id = $1 AND data->>'owner' = $2`,
      [`lease:${id}`, owner],
    ).catch(() => {});
  }
  return true;
}

// ---------- Consultas periódicas ----------

export interface Poller {
  id: string;
  provider: Provider;
  intervalMs: () => number;
  enabled: () => boolean;
  gapWarnMs?: number;
  run: (lease: Lease) => Promise<void>;
  // Alerta quando falha por mais de 1 hora (padrão do Jira: jira.poll). false: nenhum.
  alert?: { key: string; text: (error: string) => string; href: string } | false;
}

interface PollerState {
  lastStart?: string;
  failingSince?: string | null;
  lastError?: string | null;
}

const pollers = new Map<string, Poller>();

export function registerPoller(p: Poller): void {
  pollers.set(p.id, p);
}

function pollerAlert(p: Poller) {
  if (p.alert === false) return null;
  if (p.alert) return p.alert;
  if (p.provider === 'jira') {
    return { key: 'jira.poll', text: (e: string) => alertText('A consulta ao Jira falha há mais de 1 hora', e), href: '/admin/integrations/jira/avisos' };
  }
  return null;
}

async function lastStartOf(id: string): Promise<number | null> {
  const [own, mine] = await Promise.all([getState<{ lastRunStart?: string }>(id), getState<PollerState>(`poller:${id}`)]);
  const times = [own?.lastRunStart, mine?.lastStart].map((t) => (t ? new Date(t).getTime() : NaN)).filter((n) => Number.isFinite(n));
  return times.length ? Math.max(...times) : null;
}

const due = (last: number | null, intervalMs: number) => last === null || Date.now() - last >= Math.max(1000, intervalMs) - 250;

async function runPoller(p: Poller, owner: string, force: boolean): Promise<boolean> {
  const interval = p.intervalMs();
  const ttl = Math.max(60_000, interval * 2);
  let ran = false;
  await withLease(
    `poller:${p.id}`,
    ttl,
    async (lease) => {
      // Lido dentro do lease: várias instâncias rodam uma vez por intervalo, não uma vez cada.
      const last = await lastStartOf(p.id);
      if (!force && !due(last, interval)) return;
      const now = new Date();
      await mergeState(`poller:${p.id}`, { lastStart: now.toISOString() });
      ran = true;
      if (last !== null && p.gapWarnMs && now.getTime() - last > p.gapWarnMs) {
        const minutes = Math.round((now.getTime() - last) / 60_000);
        await activity({
          provider: p.provider,
          tone: 'warn',
          text: `O chat ficou ${minutes} minutos sem consultar o ${LABEL[p.provider]}. Avisos desse período não foram publicados.`,
        });
      }
      const alert = pollerAlert(p);
      try {
        await p.run(lease);
        const st = await getState<PollerState>(`poller:${p.id}`);
        if (st?.failingSince) await mergeState(`poller:${p.id}`, { failingSince: null, lastError: null });
        if (alert) await clearAlert(alert.key);
      } catch (e) {
        const text = (e instanceof Error ? e.message : String(e)) || 'Erro desconhecido.';
        const st = await getState<PollerState>(`poller:${p.id}`);
        const since = st?.failingSince ?? now.toISOString();
        await mergeState(`poller:${p.id}`, { failingSince: since, lastError: text });
        await activity({ provider: p.provider, tone: 'err', text, detail: p.id, onceKey: `poll:${p.id}:${shortHash(text)}`, oncePerMs: 3600_000 });
        if (alert && Date.now() - new Date(since).getTime() > 3600_000) {
          await raiseAlert({ key: alert.key, provider: p.provider, tone: 'err', text: alert.text(text), href: alert.href, to: 'managers' });
        }
      }
    },
    owner,
  );
  return ran;
}

// Testes: roda a consulta agora (sob o lease, ignorando o intervalo).
export async function runPollerOnce(id: string): Promise<void> {
  const p = pollers.get(id);
  if (!p) throw new Error(`Consulta periódica desconhecida: ${id}`);
  await runPoller(p, runId(), true);
}

// ---------- Ganchos ----------

// hooks.emit engole erros: o erro de um ouvinte vira atividade (no máximo uma linha por texto por hora).
export function wrapHook<T>(provider: Provider, name: string, fn: (data: T) => Promise<void>): (data: T) => Promise<void> {
  return async (data: T) => {
    await keyReady();
    if (integrationsPaused()) return;
    try {
      await fn(data);
    } catch (e) {
      const text = (e instanceof Error ? e.message : String(e)) || 'Erro desconhecido.';
      await activity({ provider, tone: 'err', text: `Falha ao processar ${name}: ${text}`, onceKey: `hook:${name}:${shortHash(text)}`, oncePerMs: 3600_000 }).catch(() => {});
    }
  };
}

// ---------- Conferências diárias (07:00, hora do servidor) ----------

const dailyChecks: (() => Promise<void>)[] = [];

export function registerDailyCheck(fn: () => Promise<void>): void {
  dailyChecks.push(fn);
}

const DAY = 24 * 3600_000;
const daysLeft = (d: Date) => Math.ceil((d.getTime() - Date.now()) / DAY);
const dias = (n: number) => `${n} ${n === 1 ? 'dia' : 'dias'}`;

// Segredos com validade informada e tokens pessoais do Jira que vencem em até 14 dias. Já vencido, o alerta continua
// (com "expirou"): é quando ele mais importa.
async function expiryCheck() {
  const secrets = await many(`SELECT id, expires_at FROM integration_secrets WHERE id IN ('jira.apiToken', 'msteams.clientSecret')`);
  const expiring = new Map(secrets.filter((s) => s.expires_at).map((s) => [s.id as string, new Date(s.expires_at)]));
  const expiryAlert = async (o: { id: string; key: string; provider: Provider; soon: (d: string) => string; expired: string; href: string }) => {
    const at = expiring.get(o.id);
    const left = at ? daysLeft(at) : null;
    if (left === null || left > 14) return clearAlert(o.key);
    const expired = left <= 0;
    await raiseAlert({ key: o.key, provider: o.provider, tone: expired ? 'err' : 'warn', text: expired ? o.expired : o.soon(dias(left)), href: o.href, to: 'managers' });
  };
  await expiryAlert({
    id: 'jira.apiToken',
    key: 'jira.token',
    provider: 'jira',
    soon: (d) => `O token da conta da integração do Jira expira em ${d}.`,
    expired: 'O token da conta da integração do Jira expirou. Gere um novo e cadastre na conexão do Jira.',
    href: '/admin/integrations/jira/conexao',
  });
  await expiryAlert({
    id: 'msteams.clientSecret',
    key: 'msteams.secret',
    provider: 'msteams',
    soon: (d) => `O segredo do aplicativo do Microsoft Entra expira em ${d}.`,
    expired: 'O segredo do aplicativo do Microsoft Entra expirou. Crie um novo e cadastre na conexão do Teams.',
    href: '/admin/integrations/teams/conexao',
  });
  const people = await many(
    `SELECT user_id, secret_expires_at FROM linked_accounts
     WHERE provider = 'jira' AND status = 'ok' AND secret_expires_at IS NOT NULL AND secret_expires_at <= now() + interval '14 days'`,
  );
  for (const p of people) {
    const left = daysLeft(new Date(p.secret_expires_at));
    await raiseAlert({
      key: `jira.linked:${p.user_id}`,
      provider: 'jira',
      tone: left <= 0 ? 'err' : 'warn',
      text:
        left <= 0
          ? 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.'
          : `Seu token do Jira expira em ${dias(left)}. Gere um novo e atualize em Minha conta → Contas conectadas.`,
      href: '/account/connected',
      to: { userId: p.user_id },
    });
  }
}
registerDailyCheck(expiryCheck);

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function runDailyChecks(log: (m: string) => void = () => {}): Promise<void> {
  for (const fn of dailyChecks) {
    try {
      await fn();
    } catch (e) {
      log(`[integrações] conferência diária: ${(e as Error).message}`);
    }
  }
}

// ---------- Chave de segredos ----------

let mismatchLogged = false;

// Confere a chave com a das outras instâncias; parado e em uso: alerta secrets.key para os administradores.
export async function checkSecretsKey(log: (m: string) => void = () => {}): Promise<void> {
  await checkSharedKey();
  if (keyMismatch() !== mismatchLogged) {
    mismatchLogged = keyMismatch();
    if (mismatchLogged) log(`[integrações] ${KEY_MISMATCH}`);
  }
  if (!integrationsPaused()) {
    await clearAlert('secrets.key');
    return;
  }
  // Sem chave e sem nada configurado, as integrações só não estão em uso: não é motivo para alerta.
  const used =
    keyMismatch() ||
    getSetting('Jira_Enabled') === true ||
    getSetting('MSTeams_Enabled') === true ||
    !!(await one(`SELECT 1 FROM integration_secrets LIMIT 1`)) ||
    !!(await one(`SELECT 1 FROM integrations WHERE type IN ('jira-events', 'msteams-outgoing', 'msteams-incoming') LIMIT 1`));
  if (!used) return;
  const info = keyInfo();
  // O alerta vai só para o papel admin: pode levar o caminho do arquivo e o erro do sistema.
  const problem = keyMismatch()
    ? KEY_MISMATCH
    : (info.detail ?? info.problem ?? 'O servidor não tem a chave de segredos das integrações. Defina SECRETS_KEY_FILE com o caminho completo de um arquivo de chave e reinicie o serviço.');
  await raiseAlert({ key: 'secrets.key', provider: 'jira', tone: 'err', text: alertText('As integrações estão paradas', problem), href: '/admin/integrations', to: 'admins' });
}

// ---------- Laço ----------

export function startIntegrationsRuntime(log: (m: string) => void, o: { tickMs?: number; worker?: boolean } = {}): { stop(): void } {
  const owner = runId();
  const tickMs = o.tickMs ?? 5000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const busy = new Set<string>();
  let lastKeyCheck = 0;
  let lastSweep = 0;
  const logged = new Map<string, string>();
  const report = (what: string, e: unknown) => {
    const m = (e as Error)?.message ?? String(e);
    if (logged.get(what) === m) return;
    logged.set(what, m);
    log(`[integrações] ${what}: ${m}`);
  };

  // Cada tarefa roda no máximo uma vez ao mesmo tempo nesta instância.
  const once = (key: string, fn: () => Promise<void>) => {
    if (busy.has(key)) return;
    busy.add(key);
    void fn()
      .then(() => logged.delete(key))
      .catch((e) => report(key, e))
      .finally(() => busy.delete(key));
  };

  const tick = async () => {
    if (stopped) return;
    if (Date.now() - lastKeyCheck >= 60_000) {
      lastKeyCheck = Date.now();
      once('chave', () => checkSecretsKey(log));
    }
    if (!integrationsPaused()) {
      for (const p of pollers.values()) {
        let on = false;
        try {
          on = p.enabled();
        } catch {
          on = false;
        }
        if (!on) continue;
        once(`poller:${p.id}`, async () => {
          if (!due(await lastStartOf(p.id), p.intervalMs())) return;
          await runPoller(p, owner, false);
        });
      }
      if (Date.now() - lastSweep >= 60_000) {
        lastSweep = Date.now();
        once('limpeza', async () => {
          const st = await getState<{ lastRun?: string }>('sweep');
          if (st?.lastRun && Date.now() - new Date(st.lastRun).getTime() < 10 * 60_000) return;
          await withLease('sweep', 120_000, async () => {
            const again = await getState<{ lastRun?: string }>('sweep');
            if (again?.lastRun && Date.now() - new Date(again.lastRun).getTime() < 10 * 60_000) return;
            await mergeState('sweep', { lastRun: new Date().toISOString() });
            await sweepJobs();
          });
        });
      }
      const now = new Date();
      if (now.getHours() >= 7) {
        once('diária', async () => {
          const today = localDay(now);
          if ((await getState<{ lastDay?: string }>('daily'))?.lastDay === today) return;
          await withLease('daily', 10 * 60_000, async () => {
            if ((await getState<{ lastDay?: string }>('daily'))?.lastDay === today) return;
            await mergeState('daily', { lastDay: today });
            await runDailyChecks(log);
          });
        });
      }
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), tickMs);
      timer.unref?.();
    }
  };

  // Na subida: chave criada agora (guardar uma cópia) ou com problema (as integrações ficam paradas).
  const info = keyInfo();
  if (info.created && info.file) {
    log(`[integrações] Chave de segredos das integrações criada em ${info.file}. Guarde uma cópia em lugar seguro, separada do backup do banco: sem ela, os tokens das integrações precisam ser cadastrados de novo.`);
  }
  if (info.problem) log(`[integrações] ${info.detail ?? info.problem}`);

  const worker = o.worker === false ? null : startJobWorker(log);
  timer = setTimeout(() => void tick(), Math.min(1000, tickMs));
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      worker?.stop();
    },
  };
}
