// Tokens (aplicativo, conta de serviço, Power Automate), chamadas ao Microsoft Graph e erros em pt-BR (§5.2).
import crypto from 'node:crypto';
import { ApiError, badRequest } from '../../lib/errors';
import { getSecret } from '../../lib/secrets';
import { safeFetch, SafeFetchError, type SafeResponse } from '../../lib/safeFetch';
import { getSetting } from '../../services/settings';
import { endpoints, FLOW_AUDIENCE } from '../endpoints';
import { PermanentError, RetryLater } from '../jobs';
import { mergeState } from '../state';

export const GRAPH_TEXT = {
  secret: 'O Microsoft Entra recusou o segredo do aplicativo. Confira se copiou o **valor** do segredo (não o ID) e se ele não expirou.',
  app: 'Aplicativo ou locatário não encontrado. Confira o ID do aplicativo e o ID do locatário.',
  consent: 'Falta o consentimento do administrador para as permissões do aplicativo.',
  conditional: 'O Acesso Condicional do Microsoft 365 bloqueou a conta de serviço a partir do servidor do chat. Peça ao administrador para liberar.',
  reauth: 'A conta de serviço do Teams precisa entrar de novo (senha trocada, expirada ou bloqueada pela política de acesso).',
  forbidden: (permission: string) => `O Microsoft 365 negou o acesso: falta a permissão ${permission} ou ela não foi consentida.`,
  notFound: 'Não encontrado no Microsoft 365.',
  unavailable: 'O Microsoft 365 não respondeu. Tente de novo em alguns minutos.',
  busy: 'O Microsoft 365 pediu para esperar. Tente de novo em alguns minutos.',
  invalid: (status: number, code?: string) => `O Microsoft 365 recusou o pedido (HTTP ${status}${code ? `, ${code}` : ''}).`,
  refused: (code: string) => `O Microsoft Entra recusou o pedido de token (${code}).`,
  notConfigured: 'Configure e teste a conexão com o Microsoft Teams antes de ativar.',
  noService: 'Conecte a conta de serviço.',
};

// Erro do Microsoft 365 para a API do chat (código e status da tabela do §11). msStatus: o status HTTP da Microsoft.
export class MsError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    public msStatus?: number,
    public retryAfterMs?: number,
    public graphCode?: string,
    public graphMessage?: string,
  ) {
    super(status, code, message);
  }
}

// ---------- Configuração mínima ----------

export const tenantId = () => String(getSetting('MSTeams_Tenant_Id') ?? '').trim();
export const clientId = () => String(getSetting('MSTeams_Client_Id') ?? '').trim();
export const clientSecret = () => getSecret('msteams.clientSecret').catch(() => null);

export async function appCredentials(): Promise<{ tenant: string; client: string; secret: string }> {
  const tenant = tenantId();
  const client = clientId();
  const secret = await clientSecret();
  if (!tenant || !client || !secret) throw badRequest('error-msteams-not-configured', GRAPH_TEXT.notConfigured);
  return { tenant, client, secret };
}

// ---------- Claims (só para mostrar: a assinatura não é conferida) ----------

export function tokenClaims(jwt: string): { roles?: string[]; scp?: string; oid?: string; upn?: string; aud?: string; exp?: number } {
  try {
    const part = String(jwt ?? '').split('.')[1];
    if (!part) return {};
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return {
      ...(Array.isArray(c?.roles) ? { roles: c.roles.map(String) } : {}),
      ...(typeof c?.scp === 'string' ? { scp: c.scp } : {}),
      ...(typeof c?.oid === 'string' ? { oid: c.oid } : {}),
      ...(typeof c?.upn === 'string' ? { upn: c.upn } : typeof c?.preferred_username === 'string' ? { upn: c.preferred_username } : {}),
      ...(typeof c?.aud === 'string' ? { aud: c.aud } : {}),
      ...(typeof c?.exp === 'number' ? { exp: c.exp } : {}),
    };
  } catch {
    return {};
  }
}

// ---------- Endpoint de token ----------

export interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

// AADSTS → código e texto do §5.2. invalid_grant numa renovação vira error-msteams-service (entrar de novo).
export function tokenError(status: number, json: any): MsError {
  const codes: number[] = Array.isArray(json?.error_codes) ? json.error_codes.map(Number) : [];
  const desc = String(json?.error_description ?? '');
  const has = (n: number) => codes.includes(n) || desc.includes(`AADSTS${n}`);
  const err = String(json?.error ?? '');
  if (has(7000215) || has(7000222)) return new MsError(400, 'error-msteams-secret', GRAPH_TEXT.secret, status);
  if (has(700016) || has(90002) || has(900023)) return new MsError(400, 'error-msteams-app', GRAPH_TEXT.app, status);
  if (has(65001)) return new MsError(400, 'error-msteams-consent', GRAPH_TEXT.consent, status);
  if (has(53003)) return new MsError(400, 'error-msteams-service', GRAPH_TEXT.conditional, status, undefined, 'invalid_grant');
  if (err === 'invalid_grant') return new MsError(400, 'error-msteams-service', GRAPH_TEXT.reauth, status, undefined, 'invalid_grant');
  if (status >= 500 || status === 0) return new MsError(502, 'error-msteams-unavailable', GRAPH_TEXT.unavailable, status);
  const first = codes[0] ? `AADSTS${codes[0]}` : err || `HTTP ${status}`;
  return new MsError(400, 'error-msteams-app', GRAPH_TEXT.refused(first), status);
}

export async function tokenRequest(tenant: string, form: Record<string, string>): Promise<TokenAnswer> {
  let res: SafeResponse;
  try {
    res = await safeFetch(`${endpoints.msLogin()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      timeoutMs: 15_000,
    });
  } catch (e) {
    throw fetchError(e);
  }
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  if (res.status !== 200 || !json?.access_token) throw tokenError(res.status, json);
  return json as TokenAnswer;
}

function fetchError(e: unknown): Error {
  if (e instanceof SafeFetchError) {
    if (e.code === 'error-url-not-allowed' || e.code === 'error-url-internal' || e.code === 'error-proxy-auth' || e.code === 'error-tls') return new ApiError(400, e.code, e.message);
    return new MsError(502, 'error-msteams-unavailable', GRAPH_TEXT.unavailable, 0);
  }
  return e instanceof Error ? e : new Error(String(e));
}

// ---------- Token do aplicativo (client_credentials), em memória até exp − 5 min ----------

const appCache = new Map<string, { token: string; exp: number }>();
const fingerprint = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function clearTokenCache() {
  appCache.clear();
}

// O recurso do Power Automate termina em barra; o escopo leva outra barra antes de .default para o token sair com o
// público exato https://service.flow.microsoft.com/ (M15).
export const FLOW_SCOPE = `${FLOW_AUDIENCE}/.default`;
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export async function appToken(audience: 'graph' | 'flow'): Promise<string> {
  const { tenant, client, secret } = await appCredentials();
  const key = `${audience}:${tenant}:${client}:${fingerprint(secret)}`;
  const hit = appCache.get(key);
  if (hit && hit.exp - 5 * 60_000 > Date.now()) return hit.token;
  const scope = audience === 'graph' ? GRAPH_SCOPE : FLOW_SCOPE;
  const t = await tokenRequest(tenant, { client_id: client, client_secret: secret, scope, grant_type: 'client_credentials' });
  const exp = Date.now() + Math.max(60, Number(t.expires_in ?? 3600)) * 1000;
  appCache.set(key, { token: t.access_token, exp });
  if (audience === 'graph') {
    const oid = tokenClaims(t.access_token).oid;
    if (oid) await mergeState('msteams.app', { oid }).catch(() => {});
  }
  return t.access_token;
}

// oid do token do aplicativo = ID de objeto da entidade de serviço (o gatilho do fluxo libera este ID).
export async function appObjectId(): Promise<string> {
  try {
    return tokenClaims(await appToken('graph')).oid ?? '';
  } catch {
    return '';
  }
}

// ---------- Token da conta de serviço (serviceAccount.ts registra quem renova) ----------

interface ServiceTokens {
  get(): Promise<string>;
  forget(): void;
}
let service: ServiceTokens | null = null;

export function setServiceTokenProvider(p: ServiceTokens) {
  service = p;
}

export async function serviceToken(): Promise<string> {
  if (!service) throw new MsError(400, 'error-msteams-service', GRAPH_TEXT.noService);
  return service.get();
}

// ---------- Chamadas ao Graph ----------

export interface GraphOptions {
  interactive?: boolean; // padrão true. false (tarefas da fila): 429/503/504 viram RetryLater
  headers?: Record<string, string>;
  permission?: string; // a permissão citada num 403
  maxBytes?: number;
  token?: string; // token já em mãos (a entrada da conta de serviço confere o /me antes de gravar)
}

const WAIT_MAX_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function retryAfterMs(h: string | undefined): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

// Endereço completo: um caminho do Graph, ou um @odata.nextLink/deltaLink da mesma origem do Graph (nunca outro host).
export function graphUrl(path: string): string {
  const base = endpoints.msGraph().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(path)) {
    let u: URL;
    try {
      u = new URL(path);
    } catch {
      throw new PermanentError('Link do Microsoft Graph inválido.');
    }
    if (u.origin !== new URL(base).origin) throw new PermanentError('O Microsoft Graph devolveu um link de outro endereço.');
    return u.toString();
  }
  return `${base}/v1.0${path.startsWith('/') ? path : `/${path}`}`;
}

export async function graph<T = any>(
  who: 'app' | 'service',
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  o: GraphOptions = {},
): Promise<T> {
  const interactive = o.interactive !== false;
  const url = graphUrl(path);
  let waited = false;
  for (let attempt = 0; ; attempt++) {
    const token = o.token ?? (who === 'app' ? await appToken('graph') : await serviceToken());
    let res: SafeResponse;
    try {
      res = await safeFetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs: 20_000,
        maxBytes: o.maxBytes ?? 16 * 1024 * 1024,
      });
    } catch (e) {
      const err = fetchError(e);
      if (!interactive) throw err instanceof MsError ? new RetryLater(err.message) : new PermanentError(err.message);
      throw err;
    }
    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204 || !res.body.length) return null as T;
      try {
        return res.json<T>();
      } catch {
        return null as T;
      }
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    const code = String(json?.error?.code ?? '');
    const message = String(json?.error?.message ?? '');
    // Token recusado (girado, revogado): pede outro uma vez.
    if (res.status === 401 && attempt === 0 && !o.token) {
      if (who === 'app') clearTokenCache();
      else service?.forget();
      continue;
    }
    // Só 429, ou 503/504 com Retry-After, é "pediu para esperar"; 503/504 sem ele é o serviço fora do ar.
    const after = retryAfterMs(res.headers['retry-after']);
    if (res.status === 429 || ((res.status === 503 || res.status === 504) && after !== undefined)) {
      if (!interactive) throw new RetryLater(GRAPH_TEXT.busy, after);
      if (!waited && after !== undefined && after <= WAIT_MAX_MS) {
        waited = true;
        await sleep(after);
        continue;
      }
      throw new MsError(429, 'error-msteams-busy', GRAPH_TEXT.busy, res.status, after, code, message);
    }
    if (res.status === 403) throw new MsError(403, 'error-msteams-forbidden', GRAPH_TEXT.forbidden(o.permission ?? 'necessária'), 403, undefined, code, message);
    if (res.status === 404) throw new MsError(404, 'error-msteams-not-found', GRAPH_TEXT.notFound, 404, undefined, code, message);
    // 401 mesmo com um token novo: a conta de serviço precisa entrar de novo; com o token do aplicativo, o problema é
    // o aplicativo ou o locatário (a conta de serviço não tem nada a ver).
    if (res.status === 401) {
      if (who === 'service') throw new MsError(400, 'error-msteams-service', GRAPH_TEXT.reauth, 401, undefined, code, message);
      throw new MsError(400, 'error-msteams-app', GRAPH_TEXT.app, 401, undefined, code, message);
    }
    if (res.status >= 500 || res.status === 408) {
      if (!interactive) throw new RetryLater(`${GRAPH_TEXT.unavailable} (HTTP ${res.status})`, after);
      throw new MsError(502, 'error-msteams-unavailable', GRAPH_TEXT.unavailable, res.status, after, code, message);
    }
    // 400 e os outros 4xx: o pedido foi recusado (não é falta de resposta). Numa tarefa vira erro definitivo (toJobError).
    throw new MsError(400, 'error-msteams-invalid', GRAPH_TEXT.invalid(res.status, code), res.status, undefined, code, message);
  }
}

// Erro de uma chamada dentro de uma tarefa: falta de permissão, não encontrado e configuração → definitivo; o resto tenta de novo.
export function toJobError(e: unknown): Error {
  if (e instanceof RetryLater || e instanceof PermanentError) return e;
  if (e instanceof MsError) return e.statusCode === 429 || e.statusCode === 502 ? new RetryLater(e.message, e.retryAfterMs) : new PermanentError(e.message);
  if (e instanceof ApiError) return new PermanentError(e.message);
  return e instanceof Error ? e : new Error(String(e));
}

// '…' do $filter do Graph: aspas simples dobradas.
export const odataQuote = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
