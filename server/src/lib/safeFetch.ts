import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { parseAllowedHosts } from '@shared/integrations';
import { config, readSecret } from '../config';
import { isVendorHost } from '../integrations/endpoints';
import { internalAddress, publicLookup } from '../oauth/login';

// HTTP de saída das integrações: só os hosts dos fornecedores (endpoints.ts) e os liberados no ambiente do servidor
// (INTEGRATIONS_ALLOWED_HOSTS). Endereços internos recusados na conexão, proxy corporativo, limites de tamanho e tempo.

export type SafeFetchCode =
  | 'error-url-not-allowed'
  | 'error-url-internal'
  | 'error-network'
  | 'error-timeout'
  | 'error-too-large'
  | 'error-tls'
  | 'error-redirect'
  | 'error-proxy'
  | 'error-proxy-auth';

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public code: SafeFetchCode,
  ) {
    super(message);
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number; // padrão 15000
  maxBytes?: number; // padrão 2 MB
  redirects?: number; // padrão 0: APIs não seguem redirecionamento
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  url: string;
  body: Buffer;
  text(): string;
  json<T = any>(): T;
}

const UA = 'Wescc-Chat-Integrations';

export const SAFE_FETCH_TEXT: Record<SafeFetchCode, string> = {
  'error-url-not-allowed': 'Este endereço não é permitido. O chat só fala com o Jira Cloud, o Microsoft 365 e o Power Automate, ou com servidores liberados em INTEGRATIONS_ALLOWED_HOSTS.',
  'error-url-internal': 'Endereço da rede interna não permitido. Para liberar um servidor interno, inclua "host:porta" em INTEGRATIONS_ALLOWED_HOSTS.',
  'error-network': 'Não foi possível conectar ao servidor.',
  'error-timeout': 'O servidor demorou demais para responder.',
  'error-too-large': 'A resposta passou do tamanho máximo.',
  'error-tls': 'O certificado foi recusado. Se a empresa inspeciona o tráfego https, ligue NODE_USE_SYSTEM_CA=1 no serviço do chat ou informe o certificado raiz em NODE_EXTRA_CA_CERTS.',
  'error-redirect': 'O servidor respondeu com um redirecionamento. Confira o endereço.',
  'error-proxy': 'O proxy recusou a conexão.',
  'error-proxy-auth': 'O proxy pediu autenticação. Informe usuário e senha em INTEGRATIONS_PROXY ou use um proxy auxiliar (px, cntlm) para a autenticação do Windows.',
};
const fail = (code: SafeFetchCode, message = SAFE_FETCH_TEXT[code]) => new SafeFetchError(message, code);

export function integrationAllowedHosts(): string[] {
  return parseAllowedHosts(process.env.INTEGRATIONS_ALLOWED_HOSTS);
}

const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

// Entrada "host" vale só para https na 443 (regra 2: http ou outra porta só com "host:porta"); "host:porta", só
// naquela porta.
function allowlisted(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return integrationAllowedHosts().some((e) => e === `${host}:${port}` || (!u.port && u.protocol === 'https:' && e === host));
}

export function checkOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw fail('error-url-not-allowed', 'Endereço inválido.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('error-url-not-allowed');
  if (u.username || u.password) throw fail('error-url-not-allowed');
  if (allowlisted(u)) return u;
  const host = bareHost(u);
  if ((net.isIP(host) && internalAddress(host)) || host === 'localhost' || host.endsWith('.localhost')) throw fail('error-url-internal');
  if (!isVendorHost(host) || u.protocol !== 'https:' || (u.port && u.port !== '443')) throw fail('error-url-not-allowed');
  return u;
}

// ---------- Proxy ----------

interface ProxyInfo {
  host: string;
  port: number;
  auth: string | null; // "Basic ..."
  label: string; // http://proxy:porta, sem usuário e senha
}

// Em teste nunca vale o proxy do ambiente (HTTPS_PROXY): só um INTEGRATIONS_PROXY que o próprio teste definiu.
const testMode = () => process.env.NODE_ENV === 'test';

const PROXY_FILE_FAILED = 'Não foi possível ler o arquivo do proxy das integrações (INTEGRATIONS_PROXY_FILE). Confira o caminho e se o serviço pode ler o arquivo.';
let proxyFileLogged = '';

function proxyInfo(): ProxyInfo | null {
  let raw: string | null;
  try {
    raw = readSecret('INTEGRATIONS_PROXY');
  } catch (e) {
    // O texto chega a quem gerencia o Jira ou o Teams (teste da conexão, alertas): o caminho e o erro do sistema
    // vão só para o log do servidor, uma vez por problema.
    const detail = (e as Error).message;
    if (detail !== proxyFileLogged) {
      proxyFileLogged = detail;
      if (config.logLevel !== 'silent') console.error(`[integrações] ${detail}`);
    }
    throw fail('error-proxy', PROXY_FILE_FAILED);
  }
  if (!raw && !testMode()) raw = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw fail('error-proxy', 'O endereço do proxy (INTEGRATIONS_PROXY ou HTTPS_PROXY) é inválido. Use http://proxy:porta.');
  }
  if (u.protocol !== 'http:') throw fail('error-proxy', 'O proxy precisa ser informado como http://proxy:porta.');
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || 80),
    auth: user || pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : null,
    label: `http://${u.host}`,
  };
}

// Túnel CONNECT pelo nome do host: o DNS da empresa pode não resolver nomes da internet, e a lista de hosts é fixa.
class TunnelAgent extends https.Agent {
  constructor(private proxy: ProxyInfo) {
    super({ keepAlive: false });
  }

  // Assíncrono: devolve undefined e entrega o socket TLS pelo callback, quando o proxy aceita o CONNECT.
  createConnection(options: any, cb?: (err: Error | null, stream: any) => void): any {
    const target = `${options.host}:${options.port}`;
    const headers: Record<string, string> = { host: target };
    if (this.proxy.auth) headers['proxy-authorization'] = this.proxy.auth;
    const req = http.request({ host: this.proxy.host, port: this.proxy.port, method: 'CONNECT', path: target, headers, agent: false });
    let done = false;
    const finish = (e: Error | null, s?: net.Socket) => {
      if (done) return;
      done = true;
      cb?.(e, s);
    };
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const host = String(options.host);
        finish(
          res.statusCode === 407
            ? fail('error-proxy-auth')
            : fail('error-proxy', `O proxy recusou a conexão com ${host} (HTTP ${res.statusCode}). Peça para liberar ${host} no proxy.`),
        );
        return;
      }
      finish(null, tls.connect({ socket, servername: options.servername || options.host, ALPNProtocols: ['http/1.1'] }));
    });
    req.once('error', (e: NodeJS.ErrnoException) => finish(fail('error-proxy', `Não foi possível falar com o proxy ${this.proxy.label} (${e.code ?? e.message}).`)));
    req.setTimeout(15_000, () => req.destroy(Object.assign(new Error('tempo esgotado'), { code: 'ETIMEDOUT' })));
    req.end();
    return undefined;
  }
}

// Agentes próprios: o proxy do ambiente do Node (NODE_USE_ENV_PROXY) não embrulha de novo estas chamadas.
// Em teste, um fornecedor de verdade nunca é alcançado: o nome resolvido para um endereço público é recusado.
const vendorLookup: net.LookupFunction = (hostname, options, cb) =>
  publicLookup(hostname, options, (err, address, family) => {
    if (!err && testMode()) return cb(Object.assign(new Error('fornecedor real em teste'), { code: 'ETESTVENDOR' }), address, family);
    cb(err, address, family);
  });
const vendorAgent = new https.Agent({ keepAlive: false, lookup: vendorLookup } as https.AgentOptions);
const allowedHttps = new https.Agent({ keepAlive: false });
const allowedHttp = new http.Agent({ keepAlive: false });
const tunnels = new Map<string, TunnelAgent>();

function tunnelFor(p: ProxyInfo) {
  const key = `${p.host}:${p.port}:${p.auth ?? ''}`;
  let a = tunnels.get(key);
  if (!a) {
    if (tunnels.size > 4) tunnels.clear();
    a = new TunnelAgent(p);
    tunnels.set(key, a);
  }
  return a;
}

// ---------- Pedido ----------

function networkError(e: any): SafeFetchError {
  if (e instanceof SafeFetchError) return e;
  const code = String(e?.code ?? '');
  if (code === 'EINTERNAL') return fail('error-url-internal');
  if (code === 'ETESTVENDOR') return fail('error-network', 'Em teste, o chat não chama o Jira nem a Microsoft de verdade: aponte as URLs base para um servidor falso.');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return fail('error-network', 'Servidor não encontrado.');
  if (code === 'ECONNREFUSED') return fail('error-network', 'O servidor recusou a conexão.');
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS/.test(code)) return fail('error-tls');
  return fail('error-network');
}

interface Raw {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function requestOnce(u: URL, o: { method: string; headers: Record<string, string>; body?: string | Buffer; maxBytes: number; signal: AbortSignal }): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    const vendor = !allowlisted(u);
    let proxy: ProxyInfo | null = null;
    try {
      proxy = vendor || process.env.INTEGRATIONS_PROXY_FOR_ALLOWED === '1' ? proxyInfo() : null;
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === 'https:';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const headers: Record<string, string> = { ...o.headers, host: u.host };
    let opts: https.RequestOptions;
    if (proxy && !isHttps) {
      // http (só host liberado, com INTEGRATIONS_PROXY_FOR_ALLOWED=1): a URL inteira vai para o proxy.
      if (proxy.auth) headers['proxy-authorization'] = proxy.auth;
      opts = { hostname: proxy.host, port: proxy.port, path: u.toString(), agent: allowedHttp };
    } else {
      const agent = proxy ? tunnelFor(proxy) : vendor ? vendorAgent : isHttps ? allowedHttps : allowedHttp;
      opts = { hostname: host, port: u.port || (isHttps ? 443 : 80), path: `${u.pathname}${u.search}`, agent, ...(isHttps ? { servername: net.isIP(host) ? undefined : host } : {}) };
    }
    const lib = isHttps ? https : http;
    const req = lib.request({ ...opts, method: o.method, headers, signal: o.signal }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        return reject(fail('error-too-large'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          res.destroy();
          reject(fail('error-too-large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => reject(networkError(e)));
    });
    // Conexão direta a um fornecedor: confere também o endereço em que a conexão foi feita de fato.
    if (vendor && !proxy) {
      req.on('socket', (s) =>
        s.once('connect', () => {
          if (!s.remoteAddress || internalAddress(s.remoteAddress)) req.destroy(Object.assign(new Error('endereço interno'), { code: 'EINTERNAL' }));
        }),
      );
    }
    req.on('error', (e) => reject(networkError(e)));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  let u = checkOutboundUrl(url);
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  let method: string = opts.method ?? 'GET';
  let body = opts.body;
  let headers: Record<string, string> = { 'user-agent': UA, accept: 'application/json' };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  if (body !== undefined && !headers['content-length']) headers['content-length'] = String(Buffer.byteLength(body));
  try {
    for (let hop = 0; ; hop++) {
      let r: Raw;
      try {
        r = await requestOnce(u, { method, headers, body, maxBytes, signal: ctl.signal });
      } catch (e) {
        if (ctl.signal.aborted) throw fail('error-timeout');
        throw e;
      }
      const location = r.headers.location;
      if (REDIRECT.has(r.status) && location && (opts.redirects ?? 0) > 0) {
        if (hop >= (opts.redirects ?? 0)) throw fail('error-redirect');
        let next: URL;
        try {
          next = checkOutboundUrl(new URL(location, u).toString());
        } catch (e) {
          throw e instanceof SafeFetchError ? e : fail('error-redirect');
        }
        if (u.protocol === 'https:' && next.protocol === 'http:') throw fail('error-redirect');
        // Credenciais não seguem para outro servidor.
        if (next.host !== u.host) {
          const { authorization: _a, cookie: _c, ...rest } = headers;
          headers = rest;
        }
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          const { 'content-length': _l, 'content-type': _t, ...rest } = headers;
          headers = rest;
        }
        u = next;
        continue;
      }
      const finalUrl = u.toString();
      return {
        status: r.status,
        headers: r.headers,
        url: finalUrl,
        body: r.body,
        text: () => r.body.toString('utf8'),
        json: <T = any>() => JSON.parse(r.body.toString('utf8') || 'null') as T,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Endereço para mostrar em atividades e erros: só o host (o caminho de um webhook é um segredo).
export function displayUrl(raw: string): string {
  try {
    return `${new URL(raw).protocol}//${new URL(raw).host}/…`;
  } catch {
    return '…';
  }
}
