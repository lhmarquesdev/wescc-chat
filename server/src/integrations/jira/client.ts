// Cliente REST do Jira Cloud: identidade da integração ou da pessoa, origem conferida a cada uso (D25), limites e erros em pt-BR.
import { jiraSiteAllowed } from '@shared/integrations';
import { many, one, query, tx } from '../../db/pool';
import { ApiError, badRequest } from '../../lib/errors';
import { getSecret } from '../../lib/secrets';
import { integrationAllowedHosts, safeFetch, SafeFetchError, type SafeResponse } from '../../lib/safeFetch';
import { audit, type Actor } from '../../services/audit';
import { getSetting, updateSettings } from '../../services/settings';
import { endpoints } from '../endpoints';
import { PermanentError, RetryLater } from '../jobs';
import { expireAllLinked, getLinked, linkedSecrets, saveLinked, setLinkedStatus, touchLinked } from '../linked';
import { activity, getState, setState } from '../state';
import { safeExternalText } from '../text';
import { CONFIG_TEXT, cut, JIRA_ERROR_TEXT, LINK_TEXT } from './texts';

export type Identity = { kind: 'integration' } | { kind: 'user'; userId: string };

export interface JiraClient {
  identity: Identity;
  origin: string; // origem do Jira conferida nesta chamada
  get<T>(path: string, query?: Record<string, string | number | undefined>, o?: { maxBytes?: number }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
}

// Erro do Jira para a API do chat: status e código da tabela do §4.2. retryAfterMs vem do Retry-After.
export class JiraError extends ApiError {
  constructor(status: number, code: string, message: string, public retryAfterMs?: number, public jiraStatus?: number) {
    super(status, code, message);
  }
}

export const jiraOn = () => getSetting<boolean>('Jira_Enabled') === true;

// Origem do Jira configurada e liberada; o cloudId só vale quando foi lido desta mesma origem (teste de conexão).
// Quando o endereço mudou por fora do jira.config.save (POST settings genérico), a troca do §4.2 roda aqui, uma vez.
export async function currentSite(): Promise<{ origin: string; cloudId: string } | { problem: string }> {
  const raw = String(getSetting('Jira_Site_Url') ?? '').trim();
  if (!raw) return { problem: CONFIG_TEXT.notConfigured };
  const r = jiraSiteAllowed(raw, integrationAllowedHosts());
  if ('problem' in r) return r;
  const rows = await many(`SELECT id, data FROM integration_state WHERE id IN ('jira.site', 'jira.origin')`);
  const st = rows.find((x) => x.id === 'jira.site')?.data as { origin?: string; cloudId?: string } | undefined;
  const known = (rows.find((x) => x.id === 'jira.origin')?.data as { origin?: string } | undefined)?.origin;
  if (known !== r.origin && (await switchSite(r.origin, { username: 'system' }))) return { origin: r.origin, cloudId: '' };
  const cloudId = st?.origin === r.origin ? String(st.cloudId ?? '') : '';
  return { origin: r.origin, cloudId };
}

// ---------- Troca de endereço (D25, §4.2) ----------

// Origem a que pertencem o token da integração, o cloudId e as contas vinculadas. Gravada em jira.origin; antes da
// primeira gravação, vem de onde as credenciais dizem que são.
async function credentialOrigin(): Promise<string | null> {
  const r = await one(
    `SELECT COALESCE(
       (SELECT data->>'origin' FROM integration_state WHERE id = 'jira.origin'),
       (SELECT bound_to FROM integration_secrets WHERE id = 'jira.apiToken'),
       (SELECT data->>'origin' FROM integration_state WHERE id = 'jira.site'),
       (SELECT site FROM linked_accounts WHERE provider = 'jira' AND site IS NOT NULL ORDER BY updated_at DESC LIMIT 1)
     ) AS origin`,
  );
  return r?.origin ? String(r.origin) : null;
}

// Compara com a origem das credenciais, não com o valor anterior do campo: A → vazio → B também é uma troca.
// Roda uma vez por troca (a gravação condicional de jira.origin decide quem faz); true quando esta chamada trocou.
export async function switchSite(to: string, actor: Actor): Promise<boolean> {
  const from = await credentialOrigin();
  const claimed = await one(
    `INSERT INTO integration_state (id, data, updated_at) VALUES ('jira.origin', $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       WHERE integration_state.data->>'origin' IS DISTINCT FROM EXCLUDED.data->>'origin'
     RETURNING 1 AS ok`,
    [JSON.stringify({ origin: to })],
  );
  if (!claimed || !from || from === to) return false;
  // Só o token do endereço antigo: um token novo, gravado para este endereço na mesma hora, fica.
  const gone = await query(`DELETE FROM integration_secrets WHERE id = 'jira.apiToken' AND bound_to IS DISTINCT FROM $1`, [to]);
  if (gone.rowCount) await audit(actor, 'integration.secret.cleared', { id: 'jira.apiToken' });
  await updateSettings({ Jira_Cloud_Id: '' });
  await setState('jira.site', {});
  const dropped = await forgetOldSite();
  await expireAllLinked('jira', CONFIG_TEXT.linkedSiteChanged);
  await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.siteChanged(from, to) });
  if (dropped) await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.oldJobsDropped(dropped) });
  await audit(actor, 'integration.jira.site.changed', {}, { from, to });
  await setState('jira.poll', {});
  await setState('jira.webhook.shownJql', {});
  await setState('jira.status', null);
  clearJiraCaches();
  return true;
}

// Tarefas que releem ou publicam pelo id ou pela chave da issue: no site novo, o mesmo id é outra issue.
const SITE_JOBS = ['jira.webhook', 'jira.post', 'jira.unfurl', 'jira.remotelink'];

// Os ids do Jira (issue, histórico, comentário) são de cada site e se repetem entre sites. Nada guardado com eles vale
// no site novo: os tópicos por issue, as chaves vistas e as tarefas do site antigo na fila ou com falha saem; as que
// já terminaram só soltam a chave de dedupe. Devolve quantas tarefas foram descartadas.
async function forgetOldSite(): Promise<number> {
  return tx(async (c) => {
    await c.query('DELETE FROM jira_threads');
    await c.query(
      `DELETE FROM integration_seen
        WHERE scope IN ('jira.event', 'jira.created-from-chat')
           OR (scope = 'post' AND key LIKE 'jira:%')
           OR (scope = 'once' AND (key LIKE 'activity:jira:jira.restricted:%' OR key LIKE 'activity:jira:jira.notvisible:%'))`,
    );
    const gone = await c.query(`DELETE FROM integration_jobs WHERE kind = ANY($1::text[]) AND status IN ('queued', 'dead')`, [SITE_JOBS]);
    await c.query(`UPDATE integration_jobs SET dedupe_key = NULL WHERE kind = 'jira.post' AND dedupe_key IS NOT NULL`);
    return gone.rowCount ?? 0;
  });
}

// Ligado e com endereço válido (o resto das rotas responde error-jira-disabled sem isso).
export async function jiraEnabled(): Promise<boolean> {
  return jiraOn() && 'origin' in (await currentSite());
}

export async function assertJiraEnabled() {
  if (!(await jiraEnabled())) throw badRequest('error-jira-disabled', CONFIG_TEXT.disabled);
}

// ---------- Limites: balde por identidade e no máximo 4 chamadas ao mesmo tempo por instância ----------

const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(id: string, rate: number, burst: number): number {
  const now = Date.now();
  const b = buckets.get(id) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  buckets.set(id, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.ceil(((1 - b.tokens) / rate) * 1000);
}

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(identity: Identity) {
  const id = identity.kind === 'integration' ? 'integration' : `user:${identity.userId}`;
  const [rate, burst] = identity.kind === 'integration' ? [10, 20] : [5, 10];
  for (let i = 0; i < 50; i++) {
    const wait = takeToken(id, rate, burst);
    if (!wait) return;
    await sleep(wait);
  }
}

// ---------- Erros ----------

function jiraMessages(res: SafeResponse): string {
  try {
    const j = res.json();
    const parts = [...(Array.isArray(j?.errorMessages) ? j.errorMessages : []), ...Object.values(j?.errors ?? {})].map((x) => String(x)).filter(Boolean);
    if (parts.length) return cut(safeExternalText(parts.join(' ')), 300);
  } catch {
    // corpo que não é JSON
  }
  return `HTTP ${res.status}`;
}

function retryAfter(res: SafeResponse): number | undefined {
  const v = res.headers['retry-after'];
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

async function failure(res: SafeResponse, identity: Identity): Promise<JiraError> {
  const s = res.status;
  if (s === 401) {
    if (identity.kind === 'user') {
      await setLinkedStatus(identity.userId, 'jira', 'expired', JIRA_ERROR_TEXT.authUser).catch(() => {});
      return new JiraError(400, 'error-jira-auth', JIRA_ERROR_TEXT.authUser, undefined, s);
    }
    await markConnection('err', JIRA_ERROR_TEXT.authIntegration).catch(() => {});
    return new JiraError(400, 'error-jira-auth', JIRA_ERROR_TEXT.authIntegration, undefined, s);
  }
  if (s === 403) return new JiraError(403, 'error-jira-forbidden', identity.kind === 'user' ? JIRA_ERROR_TEXT.forbiddenUser : JIRA_ERROR_TEXT.forbiddenIntegration, undefined, s);
  if (s === 404) return new JiraError(404, 'error-jira-not-found', JIRA_ERROR_TEXT.notFound, undefined, s);
  if (s === 429) {
    const ms = retryAfter(res) ?? 30_000;
    return new JiraError(429, 'error-jira-busy', JIRA_ERROR_TEXT.busy(Math.max(1, Math.ceil(ms / 1000))), ms, s);
  }
  if (s >= 300 && s < 400) return new JiraError(400, 'error-jira-invalid', JIRA_ERROR_TEXT.redirect, undefined, s);
  if (s >= 400 && s < 500) return new JiraError(400, 'error-jira-invalid', JIRA_ERROR_TEXT.invalid(jiraMessages(res)), undefined, s);
  return new JiraError(502, 'error-jira-unavailable', JIRA_ERROR_TEXT.unavailable, retryAfter(res), s);
}

function networkError(e: SafeFetchError): JiraError {
  if (e.code === 'error-network' || e.code === 'error-timeout') return new JiraError(502, 'error-jira-unavailable', JIRA_ERROR_TEXT.unavailable);
  if (e.code === 'error-tls' || e.code === 'error-proxy' || e.code === 'error-proxy-auth') return new JiraError(502, 'error-jira-unavailable', e.message);
  return new JiraError(400, e.code, e.message);
}

// Estado da conexão (mostrado na tela e usado pelo alerta jira.connection).
export interface ConnectionState {
  tone: 'ok' | 'warn' | 'err' | 'off';
  text: string;
  checkedAt: string | null;
  details?: string[];
  errSince?: string | null;
  account?: { accountId: string; displayName: string; email?: string | null; locale?: string | null } | null;
  serviceDeskProjects?: string[];
}

export async function markConnection(tone: ConnectionState['tone'], text: string, extra: Partial<ConnectionState> = {}) {
  const prev = (await getState<ConnectionState>('jira.status')) ?? null;
  const errSince = tone === 'err' ? (prev?.tone === 'err' && prev.errSince ? prev.errSince : new Date().toISOString()) : null;
  const next: ConnectionState = { ...(prev ?? { details: [] }), ...extra, tone, text, checkedAt: new Date().toISOString(), errSince } as ConnectionState;
  if (!extra.details && tone === 'err' && prev?.tone !== 'err') next.details = [text];
  await setState('jira.status', next);
  return next;
}

// ---------- Cliente ----------

interface Base {
  url: string;
  auth: () => Promise<string>;
}

function makeClient(identity: Identity, origin: string, base: Base, o: { job?: boolean } = {}): JiraClient {
  const timeoutMs = o.job ? 20_000 : 10_000;
  const call = async <T>(method: 'GET' | 'POST' | 'PUT', path: string, query?: Record<string, string | number | undefined>, body?: unknown, maxBytes = 5 * 1024 * 1024): Promise<T> => {
    const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== '') : [];
    const url = `${base.url}${path}${qs.length ? `?${new URLSearchParams(qs.map(([k, v]) => [k, String(v)])).toString()}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      await throttle(identity);
      const headers: Record<string, string> = { Authorization: await base.auth(), Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: SafeResponse;
      try {
        res = await slot(() => safeFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs, maxBytes }));
      } catch (e) {
        if (e instanceof SafeFetchError) throw networkError(e);
        throw e;
      }
      if (res.status >= 200 && res.status < 300) {
        if (identity.kind === 'user') void touchLinked(identity.userId, 'jira').catch(() => {});
        if (res.status === 204 || !res.body.length) return undefined as T;
        try {
          return res.json<T>();
        } catch {
          throw new JiraError(502, 'error-jira-unavailable', JIRA_ERROR_TEXT.unavailable, undefined, res.status);
        }
      }
      const err = await failure(res, identity);
      // Interativo: espera uma vez quando o Jira pede no máximo 2 s.
      if (!o.job && err.errorType === 'error-jira-busy' && attempt === 0 && (err.retryAfterMs ?? 99_999) <= 2000) {
        await sleep(err.retryAfterMs ?? 0);
        continue;
      }
      throw err;
    }
  };
  return {
    identity,
    origin,
    get: (path, query, opt) => call('GET', path, query, undefined, opt?.maxBytes),
    post: (path, body) => call('POST', path, undefined, body),
    put: (path, body) => call('PUT', path, undefined, body),
  };
}

const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

// Conta da integração. Sem endereço, token ou cloudId (conta de serviço) → error-jira-not-configured.
export async function integrationClient(o: { job?: boolean } = {}): Promise<JiraClient> {
  const site = await currentSite();
  if ('problem' in site) throw badRequest('error-jira-not-configured', site.problem);
  const token = await getSecret('jira.apiToken', site.origin).catch(() => null);
  const email = String(getSetting('Jira_Account_Email') ?? '').trim();
  if (!token || !email) throw badRequest('error-jira-not-configured', CONFIG_TEXT.notConfigured);
  const scoped = getSetting('Jira_Auth_Type') !== 'basic';
  if (scoped && !site.cloudId) throw badRequest('error-jira-not-configured', CONFIG_TEXT.notConfigured);
  const url = scoped ? `${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(site.cloudId)}` : site.origin;
  return makeClient({ kind: 'integration' }, site.origin, { url, auth: async () => basic(email, token) }, o);
}

// Cliente da integração para um endereço que ainda não foi gravado (teste de conexão antes de salvar).
export function rawClient(identity: Identity, origin: string, url: string, authHeader: string, o: { job?: boolean } = {}): JiraClient {
  return makeClient(identity, origin, { url, auth: async () => authHeader }, o);
}

// Uma renovação por pessoa por vez; o refresh token novo é gravado na hora (a Atlassian gira os tokens).
const refreshing = new Map<string, Promise<string | null>>();

async function refreshOAuth(userId: string, origin: string): Promise<string | null> {
  const linked = await getLinked(userId, 'jira');
  if (!linked) return null;
  const { refresh } = await linkedSecrets(userId, 'jira', origin);
  const clientId = String(getSetting('Jira_OAuth_Client_Id') ?? '');
  const secret = await getSecret('jira.oauthClientSecret').catch(() => null);
  if (!refresh || !clientId || !secret) return null;
  let res: SafeResponse;
  try {
    res = await safeFetch(`${endpoints.atlassianAuth()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, client_secret: secret, refresh_token: refresh }),
      timeoutMs: 10_000,
    });
  } catch (e) {
    if (e instanceof SafeFetchError) throw networkError(e);
    throw e;
  }
  const j: any = (() => {
    try {
      return res.json();
    } catch {
      return {};
    }
  })();
  if (res.status !== 200 || !j.access_token) {
    if (res.status === 400 || res.status === 401 || res.status === 403 || j.error === 'invalid_grant') {
      await setLinkedStatus(userId, 'jira', 'expired', LINK_TEXT.expired);
      return null;
    }
    throw new JiraError(502, 'error-jira-unavailable', JIRA_ERROR_TEXT.unavailable);
  }
  await saveLinked({
    userId,
    provider: 'jira',
    method: 'oauth',
    externalId: linked.externalId,
    displayName: linked.displayName,
    email: linked.email,
    site: origin,
    tokenExpiresAt: new Date(Date.now() + Number(j.expires_in ?? 3600) * 1000),
    secretExpiresAt: null,
    scopes: typeof j.scope === 'string' ? j.scope.split(' ') : linked.scopes,
    meta: linked.meta,
    access: j.access_token,
    refresh: j.refresh_token ?? refresh,
  });
  return j.access_token as string;
}

// Conta vinculada da pessoa, válida para a origem atual. null: sem conta (ou expirada, ou de outro endereço).
export async function userClient(userId: string, o: { job?: boolean } = {}): Promise<JiraClient | null> {
  const site = await currentSite();
  if ('problem' in site) return null;
  const linked = await getLinked(userId, 'jira');
  if (!linked || linked.status !== 'ok') return null;
  if (linked.site !== site.origin) {
    await setLinkedStatus(userId, 'jira', 'expired', CONFIG_TEXT.linkedSiteChanged);
    return null;
  }
  const identity: Identity = { kind: 'user', userId };
  if (linked.method === 'oauth') {
    const cloudId = String(linked.meta?.cloudId ?? site.cloudId ?? '');
    if (!cloudId) return null;
    const url = `${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(cloudId)}`;
    const auth = async () => {
      const exp = linked.tokenExpiresAt ? new Date(linked.tokenExpiresAt).getTime() : 0;
      let access = exp - Date.now() > 60_000 ? (await linkedSecrets(userId, 'jira', site.origin)).access : null;
      if (!access) {
        let p = refreshing.get(userId);
        if (!p) {
          p = refreshOAuth(userId, site.origin).finally(() => refreshing.delete(userId));
          refreshing.set(userId, p);
        }
        access = await p;
        if (access) linked.tokenExpiresAt = new Date(Date.now() + 50 * 60_000);
      }
      if (!access) throw new JiraError(403, 'error-jira-link-required', LINK_TEXT.expired);
      return `Bearer ${access}`;
    };
    return makeClient(identity, site.origin, { url, auth }, o);
  }
  const { access } = await linkedSecrets(userId, 'jira', site.origin);
  if (!access || !linked.email) return null;
  const url = linked.meta?.base === 'gateway' && site.cloudId ? `${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(site.cloudId)}` : site.origin;
  return makeClient(identity, site.origin, { url, auth: async () => basic(linked.email!, access) }, o);
}

// Erro do cliente dentro de uma tarefa da fila: 429, 5xx e rede tentam de novo; o resto é definitivo.
export function toJobError(e: unknown): Error {
  if (e instanceof JiraError) {
    if (e.errorType === 'error-jira-busy') return new RetryLater(e.message, e.retryAfterMs);
    if (e.errorType === 'error-jira-unavailable') return new RetryLater(e.message, e.retryAfterMs);
    return new PermanentError(e.message);
  }
  if (e instanceof ApiError) return e.statusCode >= 500 ? new RetryLater(e.message) : new PermanentError(e.message);
  return e instanceof Error ? e : new Error(String(e));
}

// Cache simples com validade e tamanho máximo (issues relidas, prévias, createmeta). Troca de site limpa todos.
const allCaches: TtlCache<unknown>[] = [];
export const clearJiraCaches = () => allCaches.forEach((c) => c.clear());

export class TtlCache<V> {
  private map = new Map<string, { v: V; until: number }>();
  constructor(
    private ttlMs: number,
    private max = 500,
  ) {
    allCaches.push(this as TtlCache<unknown>);
  }
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.until < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { v, until: Date.now() + this.ttlMs });
  }
  clear() {
    this.map.clear();
  }
}
