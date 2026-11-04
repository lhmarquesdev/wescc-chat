import dns from 'node:dns';
import net from 'node:net';
import { parseAllowedHosts } from '@shared/integrations';
import { translateExternalText, translateUrlCheck } from '@shared/translate';
import { config } from '../config';
import { externalIp, internalAddress } from '../lib/internalAddress';
import { safeFetch, SafeFetchError, SAFE_FETCH_TEXT, type SafeResponse } from '../lib/safeFetch';
import { getSetting } from '../services/settings';

// Cliente do LibreTranslate instalado pela empresa. Saída HTTP só pelo safeFetch (host liberado em
// INTEGRATIONS_ALLOWED_HOSTS) e, além disso, só para um endereço da rede da empresa: o texto das mensagens não sai
// (conferido no endereço da própria conexão: safeFetch internalOnly).
// A chave da API vai no corpo JSON (o LibreTranslate lê json.api_key), nunca na URL nem no log. Nenhum texto de
// mensagem vai para o log.

export type LibreCode = 'not-configured' | 'external' | 'auth' | 'busy' | 'timeout' | 'unavailable' | 'invalid' | 'too-long' | 'unsupported';

export class LibreError extends Error {
  constructor(
    public code: LibreCode,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface LibreLanguage {
  code: string;
  name: string;
  targets: string[];
}

export interface LibreConn {
  base: string;
  host: string; // sem colchetes no IPv6
  apiKey: string | null;
  timeoutMs: number;
}

const NOT_CONFIGURED = 'Informe o endereço do LibreTranslate em Configurações › Tradução automática.';
const NO_URL_TO_TEST = 'Preencha o endereço do LibreTranslate para testar.';
const MASK = '********';

const allowed = () => parseAllowedHosts(process.env.INTEGRATIONS_ALLOWED_HOSTS);

// url e apiKey: valores do rascunho da tela (teste de conexão). Sem eles, os gravados.
export function libreConfig(o: { url?: string; apiKey?: string | null } = {}): LibreConn {
  const url = String(o.url ?? getSetting<string>('AutoTranslate_LibreTranslate_Url') ?? '').trim();
  if (!url) throw new LibreError('not-configured', NOT_CONFIGURED);
  const r = translateUrlCheck(url, allowed(), externalIp);
  if ('problem' in r) throw new LibreError(r.external ? 'external' : 'not-configured', r.problem);
  const draft = o.apiKey !== undefined && o.apiKey !== null && o.apiKey !== MASK ? String(o.apiKey) : null;
  const apiKey = config.translate.apiKey || (draft ?? String(getSetting<string>('AutoTranslate_LibreTranslate_ApiKey') ?? '')) || null;
  const seconds = Number(getSetting<number>('AutoTranslate_Timeout_Seconds')) || 15;
  return { base: r.base, host: new URL(r.base).hostname.replace(/^\[|\]$/g, '').toLowerCase(), apiKey, timeoutMs: seconds * 1000 };
}

// ---------- Só a rede da empresa ----------

const NET_TTL = 60_000;
const netCache = new Map<string, { ok: boolean; at: number }>();

const externalError = (host: string) => new LibreError('external', translateExternalText(host));

// IP literal: precisa ser interno. Nome: todos os endereços resolvidos precisam ser internos (guardado 60 s por host).
// É o aviso claro antes de conectar e a única conferência pelo proxy (INTEGRATIONS_PROXY_FOR_ALLOWED=1); na conexão
// direta, o safeFetch confere de novo o endereço em que conectou (internalOnly), então um DNS que muda depois daqui
// não leva o texto para fora.
export async function assertCompanyNetwork(host: string): Promise<void> {
  if (net.isIP(host)) {
    if (!internalAddress(host)) throw externalError(host);
    return;
  }
  const hit = netCache.get(host);
  if (hit && Date.now() - hit.at < NET_TTL) {
    if (!hit.ok) throw externalError(host);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new LibreError('unavailable', 'Servidor não encontrado.');
  }
  const ok = addrs.length > 0 && addrs.every((a) => internalAddress(a.address));
  if (netCache.size > 100) netCache.clear();
  netCache.set(host, { ok, at: Date.now() });
  if (!ok) throw externalError(host);
}

// Teste de conexão (Administração): endereço vazio e endereço da internet têm o aviso deles antes do de
// INTEGRATIONS_ALLOWED_HOSTS (liberar um endereço da internet não adiantaria). Um nome que não resolve segue para o
// aviso da lista, se for o caso.
export async function libreConfigForTest(o: { url?: string; apiKey?: string | null }): Promise<LibreConn> {
  const url = String(o.url ?? getSetting<string>('AutoTranslate_LibreTranslate_Url') ?? '').trim();
  if (!url) throw new LibreError('not-configured', NO_URL_TO_TEST);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    // inválido: o libreConfig diz o que corrigir
  }
  if (host && !net.isIP(host)) {
    try {
      await assertCompanyNetwork(host);
    } catch (e) {
      if (e instanceof LibreError && e.code === 'external') throw e;
    }
  }
  return libreConfig({ url, apiKey: o.apiKey });
}

export function __resetLibreForTests() {
  netCache.clear();
  languagesCache.clear();
}

// ---------- Respostas e erros ----------

const cut = (s: string, n: number) => {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
};

function serverError(res: SafeResponse): string {
  try {
    const j = res.json();
    if (typeof j?.error === 'string' && j.error.trim()) return cut(j.error, 200);
  } catch {
    // corpo que não é JSON
  }
  return `HTTP ${res.status}`;
}

// Mesma leitura do Jira: segundos ou data; sem cabeçalho, quem chama usa 30 s.
function retryAfter(res: SafeResponse): number | undefined {
  const v = res.headers['retry-after'];
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

function failure(res: SafeResponse): LibreError {
  const s = res.status;
  const err = serverError(res);
  if (s === 400) {
    if (/API key/i.test(err)) return new LibreError('auth', 'O LibreTranslate pediu uma chave de API. Informe a chave em Configurações › Tradução automática.');
    if (/exceeds text limit/i.test(err)) return new LibreError('too-long', 'O texto passa do limite do LibreTranslate.');
    if (/not supported|not available/i.test(err)) return new LibreError('unsupported', err);
    return new LibreError('invalid', `O LibreTranslate recusou o pedido: ${err}`);
  }
  if (s === 403) {
    if (/limits violations/i.test(err)) return new LibreError('busy', 'O LibreTranslate pediu para esperar (limite de requisições).', 30_000);
    return new LibreError('auth', 'O LibreTranslate recusou a chave da API. Confira a chave em Configurações › Tradução automática.');
  }
  if (s === 429) return new LibreError('busy', 'O LibreTranslate pediu para esperar (limite de requisições).', retryAfter(res) ?? 30_000);
  if (s >= 300 && s < 400) return new LibreError('not-configured', SAFE_FETCH_TEXT['error-redirect']);
  if (s === 404) return new LibreError('not-configured', 'O endereço não parece ser de um LibreTranslate (HTTP 404). Confira o endereço.');
  return new LibreError('unavailable', `O servidor de tradução não respondeu (HTTP ${s}).`);
}

function networkError(e: unknown, c: LibreConn): LibreError {
  if (e instanceof LibreError) return e;
  if (e instanceof SafeFetchError) {
    if (e.code === 'error-timeout') return new LibreError('timeout', 'O servidor de tradução demorou demais para responder.');
    if (e.code === 'error-url-external') return externalError(c.host);
    if (e.code === 'error-url-not-allowed' || e.code === 'error-url-internal') {
      // O texto do safeFetch fala do Jira: o da tradução diz o que liberar.
      const r = translateUrlCheck(c.base, allowed());
      return new LibreError('not-configured', 'problem' in r ? r.problem : NOT_CONFIGURED);
    }
    return new LibreError('unavailable', e.message);
  }
  return new LibreError('unavailable', 'Não foi possível conectar ao servidor de tradução.');
}

async function call(c: LibreConn, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<any> {
  await assertCompanyNetwork(c.host);
  let res: SafeResponse;
  try {
    res = await safeFetch(`${c.base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: c.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      internalOnly: true,
    });
  } catch (e) {
    throw networkError(e, c);
  }
  if (res.status < 200 || res.status >= 300) throw failure(res);
  try {
    return res.json();
  } catch {
    throw new LibreError('unavailable', 'O servidor de tradução respondeu algo que não é JSON. Confira o endereço.');
  }
}

const withKey = (c: LibreConn, body: Record<string, unknown>) => (c.apiKey ? { ...body, api_key: c.apiKey } : body);

// ---------- Chamadas ----------

const LANG_TTL = 10 * 60_000;
const languagesCache = new Map<string, { list: LibreLanguage[]; at: number }>();

// A lista guardada deste endereço (menos de 10 minutos), sem chamar o servidor.
export function cachedLanguages(c: LibreConn): LibreLanguage[] | null {
  const hit = languagesCache.get(c.base);
  return hit && Date.now() - hit.at < LANG_TTL ? hit.list : null;
}

// GET /languages (sem chave: o LibreTranslate não pede). Guardado 10 minutos por endereço; fresh pula o guardado.
export async function libreLanguages(c: LibreConn = libreConfig(), o: { fresh?: boolean } = {}): Promise<LibreLanguage[]> {
  const hit = o.fresh ? null : cachedLanguages(c);
  if (hit) return hit;
  const j = await call(c, 'GET', '/languages');
  if (!Array.isArray(j)) throw new LibreError('unavailable', 'O servidor de tradução respondeu algo que não é a lista de idiomas. Confira o endereço.');
  const code = (x: unknown) => typeof x === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(x);
  const list: LibreLanguage[] = j
    .filter((l: any) => l && code(l.code))
    .map((l: any) => ({ code: l.code, name: typeof l.name === 'string' ? cut(l.name, 60) : l.code, targets: Array.isArray(l.targets) ? l.targets.filter(code) : [] }));
  if (languagesCache.size > 10) languagesCache.clear();
  languagesCache.set(c.base, { list, at: Date.now() });
  return list;
}

export async function libreDetect(text: string, c: LibreConn = libreConfig()): Promise<{ language: string; confidence: number }> {
  const j = await call(c, 'POST', '/detect', withKey(c, { q: text }));
  const first = Array.isArray(j) ? j[0] : null;
  if (!first || typeof first.language !== 'string') throw new LibreError('unavailable', 'O servidor de tradução não identificou o idioma (resposta inesperada).');
  const confidence = Number(first.confidence);
  return { language: first.language, confidence: Number.isFinite(confidence) ? confidence : 0 };
}

// Sempre com a origem explícita e format 'text' (no html, blocos longos voltam sem tradução).
export async function libreTranslate(q: string[], source: string, target: string, c: LibreConn = libreConfig()): Promise<string[]> {
  const j = await call(c, 'POST', '/translate', withKey(c, { q, source, target, format: 'text' }));
  const out = j?.translatedText;
  if (!Array.isArray(out) || out.length !== q.length || out.some((x: unknown) => typeof x !== 'string')) {
    throw new LibreError('unavailable', 'O servidor de tradução respondeu algo inesperado.');
  }
  return out;
}

// GET /frontend/settings: o limite de caracteres, para o aviso do teste de conexão. Erro → null.
export async function libreFrontendSettings(c: LibreConn = libreConfig()): Promise<{ charLimit?: number } | null> {
  try {
    const j = await call(c, 'GET', '/frontend/settings');
    const n = Number(j?.charLimit);
    return Number.isFinite(n) ? { charLimit: n } : {};
  } catch {
    return null;
  }
}
