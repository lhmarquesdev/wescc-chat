import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { truncate } from '../lib/text';
import { internalAddress, publicLookup } from '../oauth/login';
import { sizeLabel } from './archive';

// Download http(s) do arquivo da importação, dos arquivos pendentes e das fotos. Endereços internos são recusados
// (no nome, no endereço resolvido usado na conexão e em cada redirecionamento), salvo os liberados em IMPORT_ALLOWED_HOSTS.

const MAX_REDIRECTS = 5;
const UA = 'Wescc-Chat-Importer';

export class DownloadError extends Error {
  constructor(
    message: string,
    public code = 'error-download-failed',
  ) {
    super(message);
  }
}

const internalError = () =>
  new DownloadError('Endereço da rede interna não permitido. Para liberar um servidor interno, inclua "host:porta" em IMPORT_ALLOWED_HOSTS no servidor.', 'error-download-internal');
const tooLarge = (max: number) => new DownloadError(`O arquivo passa do tamanho máximo (${sizeLabel(max)}).`, 'error-file-too-large');

const hostKey = (host: string) => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return net.isIPv6(h) ? `[${h}]` : h;
};

// "host:porta" (ou "[::1]:porta") liberados mesmo sendo endereços internos; lido a cada chamada.
export function allowedInternalHosts(): string[] {
  return String(process.env.IMPORT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s);
      if (!m) return hostKey(s);
      return m[2] ? `${hostKey(m[1])}:${Number(m[2])}` : hostKey(m[1]);
    });
}

// Sem porta na lista vale só a porta padrão do protocolo.
function internalAllowed(u: URL) {
  const host = hostKey(u.hostname);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const defaultPort = !u.port;
  return allowedInternalHosts().some((e) => e === `${host}:${port}` || (defaultPort && e === host));
}

function parseUrl(s: string) {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new DownloadError('Endereço inválido.', 'error-invalid-url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DownloadError('Só são aceitos endereços http:// e https://.', 'error-invalid-url');
  return u;
}

function toDownloadError(e: any): DownloadError {
  if (e instanceof DownloadError) return e;
  const code = String(e?.code ?? '');
  if (code === 'EINTERNAL') return internalError();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return new DownloadError('Servidor não encontrado.');
  if (code === 'ECONNREFUSED') return new DownloadError('O servidor recusou a conexão.');
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.message === 'aborted') return new DownloadError('A conexão caiu durante o download.');
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return new DownloadError('Não foi possível conectar ao servidor.');
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/.test(code)) return new DownloadError('O certificado https do servidor não é válido.');
  return new DownloadError(`Falha no download (${truncate(String(e?.message ?? e), 200)}).`);
}

// Credenciais não seguem para outro servidor num redirecionamento.
function withoutCredentials(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
}

interface FetchOpts {
  maxBytes: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function getOnce(u: URL, headers: Record<string, string>, signal: AbortSignal, idleMs: number, abort: (e: Error) => void) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const internalOk = internalAllowed(u);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!internalOk && net.isIP(host) && internalAddress(host)) return reject(internalError());
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers, signal, agent: false, lookup: internalOk ? undefined : publicLookup }, resolve);
    req.setTimeout(idleMs, () => abort(new DownloadError('O servidor parou de responder.', 'error-download-timeout')));
    // Confere também o endereço em que a conexão foi feita de fato.
    if (!internalOk) {
      req.on('socket', (s) =>
        s.once('connect', () => {
          if (!s.remoteAddress || internalAddress(s.remoteAddress)) req.destroy(internalError());
        }),
      );
    }
    req.on('error', reject);
  });
}

async function fetchFollowing<T>(url: string, o: FetchOpts, consume: (res: http.IncomingMessage, u: URL, signal: AbortSignal) => Promise<T>): Promise<T> {
  let u = parseUrl(url);
  const ctl = new AbortController();
  let reason: Error | null = null;
  const abort = (e: Error) => {
    if (reason) return;
    reason = e;
    ctl.abort(e);
  };
  const timer = setTimeout(() => abort(new DownloadError('O download demorou demais e foi interrompido.', 'error-download-timeout')), o.timeoutMs ?? 10 * 60_000);
  const onCancel = () => abort(new DownloadError('Download cancelado.', 'error-download-cancelled'));
  if (o.signal?.aborted) onCancel();
  else o.signal?.addEventListener('abort', onCancel, { once: true });
  let headers: Record<string, string> = { 'user-agent': UA, accept: '*/*', ...o.headers };
  try {
    for (let hop = 0; ; hop++) {
      if (reason) throw reason;
      const res = await getOnce(u, headers, ctl.signal, o.idleTimeoutMs ?? 60_000, abort);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Corpo do redirecionamento não interessa: fecha a conexão já.
        res.destroy();
        if (hop >= MAX_REDIRECTS) throw new DownloadError('O endereço redireciona vezes demais.', 'error-download-redirects');
        const next = parseUrl(new URL(res.headers.location, u).toString());
        if (u.protocol === 'https:' && next.protocol === 'http:') throw new DownloadError('Redirecionamento de https para http recusado.', 'error-download-redirects');
        if (next.origin !== u.origin) headers = withoutCredentials(headers);
        u = next;
        continue;
      }
      if (status < 200 || status > 299) {
        res.destroy();
        throw new DownloadError(`O servidor respondeu ${status}.`, 'error-download-status');
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        throw tooLarge(o.maxBytes);
      }
      return await consume(res, u, ctl.signal);
    }
  } catch (e) {
    throw reason ?? toDownloadError(e);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onCancel);
  }
}

const contentTypeOf = (res: http.IncomingMessage) => String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

function sizeGuard(max: number, counter: { size: number }) {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      counter.size += chunk.length;
      if (counter.size > max) cb(tooLarge(max));
      else cb(null, chunk);
    },
  });
}

const incomplete = () => new DownloadError('O download veio incompleto.');

// Nome do arquivo que o servidor sugere em Content-Disposition (filename* do RFC 6266 tem preferência), ou ''.
// Lido sem regex: o cabeçalho vem de um servidor de fora.
export function dispositionFileName(header: string | string[] | undefined): string {
  const h = String((Array.isArray(header) ? header[0] : header) ?? '');
  const params = new Map<string, string>();
  let i = h.indexOf(';');
  while (i >= 0) {
    const eq = h.indexOf('=', i + 1);
    const semi = h.indexOf(';', i + 1);
    if (eq < 0) break;
    if (semi >= 0 && semi < eq) {
      i = semi;
      continue;
    }
    const key = h.slice(i + 1, eq).trim().toLowerCase();
    let j = eq + 1;
    while (h[j] === ' ' || h[j] === '\t') j++;
    let value = '';
    if (h[j] === '"') {
      const chars: string[] = [];
      for (j++; j < h.length && h[j] !== '"'; j++) {
        if (h[j] === '\\' && j + 1 < h.length) j++;
        chars.push(h[j]);
      }
      value = chars.join('');
      i = h.indexOf(';', j);
    } else {
      i = semi;
      value = (semi < 0 ? h.slice(j) : h.slice(j, semi)).trim();
    }
    if (key && !params.has(key)) params.set(key, value);
  }
  const ext = params.get('filename*');
  if (ext) {
    // charset'idioma'valor-com-%
    const second = ext.indexOf("'", ext.indexOf("'") + 1);
    if (second > 0) {
      try {
        const v = decodeURIComponent(ext.slice(second + 1));
        if (v) return v;
      } catch {
        // codificação inválida: fica o filename simples
      }
    }
  }
  return params.get('filename') ?? '';
}

// Grava em dest + '.part' e só renomeia no fim: nunca fica um arquivo pela metade com o nome final.
export async function downloadToFile(
  url: string,
  dest: string,
  opts: { maxBytes: number; timeoutMs?: number; idleTimeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ size: number; contentType: string; finalUrl: string; fileName: string }> {
  const part = `${dest}.part`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    return await fetchFollowing(url, opts, async (res, u, signal) => {
      const counter = { size: 0 };
      await pipeline(res, sizeGuard(opts.maxBytes, counter), fs.createWriteStream(part), { signal });
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && counter.size !== declared) throw incomplete();
      await fs.promises.rename(part, dest);
      return { size: counter.size, contentType: contentTypeOf(res), finalUrl: u.toString(), fileName: dispositionFileName(res.headers['content-disposition']) };
    });
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

export async function downloadToBuffer(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; idleTimeoutMs?: number; accept?: string; signal?: AbortSignal },
): Promise<{ data: Buffer; contentType: string }> {
  const headers = opts.accept ? { accept: opts.accept } : undefined;
  return fetchFollowing(url, { ...opts, headers }, async (res, _u, signal) => {
    const counter = { size: 0 };
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await pipeline(res, sizeGuard(opts.maxBytes, counter), sink, { signal });
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && counter.size !== declared) throw incomplete();
    return { data: Buffer.concat(chunks), contentType: contentTypeOf(res) };
  });
}
