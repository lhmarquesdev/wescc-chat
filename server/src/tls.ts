import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { config, readSecretFile } from './config';

// HTTPS próprio do chat (sem proxy reverso), o redirecionamento das portas HTTP antigas e o ouvinte interno
// dos webhooks do LiveKit.

export interface TlsStatus { enabled: boolean; subject?: string; validFrom?: string; validTo?: string; daysLeft?: number; error?: string }

type TlsConfig = typeof config.tls;

// O livekit-client manda a oferta SDP compactada na consulta do /sfu (vários KB); o padrão do Node é 16 KiB.
export const MAX_HEADER_SIZE = 64 * 1024;
const WEBHOOK_MAX = 64 * 1024;
const DAY = 86_400_000;

function readCertFile(file: string) {
  try {
    return fs.readFileSync(file);
  } catch {
    throw new Error(`Certificado HTTPS não encontrado: ${file}`);
  }
}

const MISMATCH = 'O certificado e a chave não combinam.';

function explain(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  if (/unsupported pkcs12 pfx data/i.test(m)) {
    return 'O PFX usa uma criptografia antiga que o Node 22 não lê. Exporte de novo com AES256-SHA256 ou use TLS_CERT_FILE e TLS_KEY_FILE.';
  }
  if (/mac verify failure/i.test(m)) return 'A senha do PFX não confere (TLS_PFX_PASSPHRASE_FILE).';
  if (/key values mismatch/i.test(m)) return MISMATCH;
  return `Não foi possível usar o certificado HTTPS: ${m}`;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

// Erros comuns ao montar os arquivos PEM à mão, que o OpenSSL só descreve com um código.
function checkPemFiles(cert: Buffer, key: Buffer, ca: Buffer | undefined, c: TlsConfig) {
  const notCert = (name: string, file: string | null) => `${name} não é um certificado em PEM (${file}): falta a linha "-----BEGIN CERTIFICATE-----".`;
  if (!cert.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`${notCert('TLS_CERT_FILE', c.certFile)} Se o arquivo é um PFX, use TLS_PFX_FILE.`);
  if (ca && !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error(notCert('TLS_CA_FILE', c.caFile));
  const k = key.toString('latin1');
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,\s*ENCRYPTED/.test(k)) {
    throw new Error('A chave em TLS_KEY_FILE tem senha. Exporte a chave sem senha (openssl pkcs12 ... -nodes) ou use o PFX (TLS_PFX_FILE).');
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(k)) {
    throw new Error(`TLS_KEY_FILE não é uma chave em PEM (${c.keyFile}): falta a linha "-----BEGIN PRIVATE KEY-----".`);
  }
}

// O certificado do chat tem de vir antes das intermediárias: o OpenSSL usa o primeiro do arquivo.
function keyFitsLaterCert(cert: Buffer, key: Buffer) {
  try {
    const k = createPrivateKey(key);
    return (cert.toString('latin1').match(PEM_CERT) ?? []).slice(1).some((b) => new X509Certificate(b).checkPrivateKey(k));
  } catch {
    return false;
  }
}

export function loadTls(c: TlsConfig = config.tls): https.ServerOptions | null {
  let opts: https.ServerOptions;
  if (c.pfxFile) {
    const pfx = readCertFile(c.pfxFile);
    // Um PFX (DER) começa com 0x30; texto com "-----BEGIN" é PEM.
    if (pfx[0] !== 0x30 && pfx.includes('-----BEGIN')) {
      throw new Error(`TLS_PFX_FILE é um arquivo PEM (${c.pfxFile}), não um PFX. Use TLS_CERT_FILE e TLS_KEY_FILE para certificado e chave em PEM.`);
    }
    opts = { pfx, passphrase: c.pfxPassphrase ?? undefined };
  } else if (c.certFile || c.keyFile) {
    if (!c.certFile || !c.keyFile) throw new Error('Defina TLS_CERT_FILE e TLS_KEY_FILE juntos (ou use TLS_PFX_FILE).');
    const cert = readCertFile(c.certFile);
    const key = readCertFile(c.keyFile);
    const ca = c.caFile ? readCertFile(c.caFile) : undefined;
    checkPemFiles(cert, key, ca, c);
    opts = { cert, key };
    if (ca) opts.ca = ca;
  } else {
    return null;
  }
  // Valida agora: com um arquivo ruim o servidor nem sobe, com a mensagem certa.
  try {
    tls.createSecureContext(opts);
    // O OpenSSL só compara chave e certificado do mesmo tipo (RSA com RSA); uma chave EC com certificado RSA passaria.
    if (opts.cert && !new X509Certificate(opts.cert as Buffer).checkPrivateKey(createPrivateKey(opts.key as Buffer))) {
      throw new Error('key values mismatch');
    }
  } catch (e) {
    const m = explain(e);
    if (m === MISMATCH && opts.cert && keyFitsLaterCert(opts.cert as Buffer, opts.key as Buffer)) {
      throw new Error('O certificado do chat precisa ser o primeiro do arquivo TLS_CERT_FILE (depois vêm as intermediárias).');
    }
    throw new Error(m);
  }
  return { ...opts, maxHeaderSize: MAX_HEADER_SIZE };
}

const expired = (s: TlsStatus) => !!s.validTo && Date.parse(s.validTo) <= Date.now();
const notYetValid = (s: TlsStatus) => !!s.validFrom && Date.parse(s.validFrom) > Date.now();

// Abaixo de 30 dias, vencido ou com o nome errado o resumo vai como aviso.
export const needsAttention = (s: TlsStatus) => !!s.error || (s.daysLeft ?? 0) < 30;

// Troca do certificado sem reiniciar: confere os arquivos a cada minuto e aplica o novo. Se o novo estiver ruim
// (arquivo com defeito, vencido, ainda sem valer, ou sem valer para o SITE_URL enquanto o atual vale), o anterior
// continua valendo. Um que só começa a valer mais tarde é aplicado nessa hora, sem esperar outra troca de arquivo.
export function watchTls(
  server: tls.Server,
  log: (m: string) => void,
  c: TlsConfig = config.tls,
  o: { intervalMs?: number; warn?: (m: string) => void } = {},
): () => void {
  const intervalMs = o.intervalMs ?? 60_000;
  const warn = o.warn ?? log;
  const files = (c.pfxFile ? [c.pfxFile, c.pfxPassphraseFile] : [c.certFile, c.keyFile, c.caFile]).filter((f): f is string => !!f);
  let timer: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;
  let queue = Promise.resolve();
  const port = () => {
    const a = server.address();
    return a && typeof a === 'object' ? a.port : null;
  };
  // O setTimeout não passa de 24,8 dias: espera em etapas de um dia até a hora.
  const retryAt = (at: number) => {
    if (stopped) return;
    retry = setTimeout(() => {
      retry = null;
      if (Date.now() < at) retryAt(at);
      else queue = queue.then(reload);
    }, Math.min(Math.max(at - Date.now(), 0) + 1000, DAY));
    retry.unref();
  };
  const reload = async () => {
    if (retry) clearTimeout(retry);
    retry = null;
    try {
      let cur = c;
      if (c.pfxFile && c.pfxPassphraseFile) {
        try {
          cur = { ...c, pfxPassphrase: readSecretFile(c.pfxPassphraseFile) };
        } catch {
          throw new Error(`Não foi possível ler TLS_PFX_PASSPHRASE_FILE: ${c.pfxPassphraseFile}`);
        }
      }
      const opts = loadTls(cur);
      if (!opts) return;
      const next = await probeCertificate(opts);
      if (!next.validTo || expired(next)) throw new Error(next.error);
      if (notYetValid(next)) {
        retryAt(Date.parse(next.validFrom!));
        throw new Error(`${next.error} O chat passa a usá-lo sozinho nessa hora, sem reiniciar.`);
      }
      if (next.error) {
        // Nome errado só fica de fora quando o certificado atual vale para o SITE_URL: trocar não pode piorar.
        const p = port();
        const now = p ? await inspectCertificate(p) : { enabled: true };
        if (!now.error) throw new Error(next.error);
      }
      if (stopped) return;
      server.setSecureContext(opts);
      log('Certificado HTTPS recarregado.');
      const p = port();
      if (p) {
        const s = await checkCertificate(p);
        (needsAttention(s) ? warn : log)(certificateSummary(s));
      }
    } catch (e) {
      warn(`O certificado HTTPS novo não foi aplicado; o anterior continua valendo. ${(e as Error).message}`);
    }
  };
  const onChange = (cur: fs.Stats, prev: fs.Stats) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size && cur.ino === prev.ino) return;
    // Certificado e chave costumam ser trocados juntos: espera o segundo arquivo antes de recarregar.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      queue = queue.then(reload);
    }, Math.min(1000, intervalMs));
    timer.unref();
  };
  for (const f of files) fs.watchFile(f, { interval: intervalMs, persistent: false }, onChange);
  return () => {
    stopped = true;
    for (const f of files) fs.unwatchFile(f, onChange);
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
  };
}

const boundPort = (s: net.Server) => (s.address() as net.AddressInfo).port;

function siteHost() {
  try {
    return new URL(config.siteUrl);
  } catch {
    throw new Error(`SITE_URL inválido: ${config.siteUrl}`);
  }
}

// Endereços antigos (http://pc:3000, http://pc) continuam funcionando. O destino vem do SITE_URL, nunca do
// cabeçalho Host da requisição, para não virar um redirecionamento aberto.
export function startHttpRedirect(port: number, log: (m: string) => void): http.Server {
  const target = `https://${siteHost().host}`;
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
    const p = req.url?.startsWith('/') ? req.url : '/';
    res.writeHead(308, { location: target + p, 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
  });
  server.listen(port, config.host, () => log(`Redirecionando HTTP na porta ${boundPort(server)} para ${target}.`));
  return server;
}

// O LiveKit não confere o certificado HTTPS em 127.0.0.1: os webhooks dele chegam por aqui, em HTTP, só deste
// computador e só neste caminho.
export function startInternalListener(app: FastifyInstance, port: number, log: (m: string) => void): http.Server {
  const server = http.createServer((req, res) => {
    const reply = (status: number, body = '', headers: http.OutgoingHttpHeaders = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(body);
    };
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/sfu-webhook') {
      req.resume();
      return reply(404, 'Não encontrado.');
    }
    if (Number(req.headers['content-length'] ?? 0) > WEBHOOK_MAX) {
      req.resume();
      return reply(413, 'Corpo grande demais.', { connection: 'close' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (d: Buffer) => {
      if (tooBig) return;
      size += d.length;
      if (size > WEBHOOK_MAX) {
        tooBig = true;
        chunks.length = 0;
        reply(413, 'Corpo grande demais.', { connection: 'close' });
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (tooBig) return;
      const headers: Record<string, string> = {};
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      app
        .inject({ method: 'POST', url: '/sfu-webhook', headers, payload: Buffer.concat(chunks) })
        .then((r) => {
          const ct = r.headers['content-type'];
          reply(r.statusCode, r.body, ct ? { 'content-type': String(ct) } : {});
        })
        .catch(() => reply(500, 'Erro interno.'));
    });
    req.on('error', () => res.destroy());
  });
  server.listen(port, '127.0.0.1', () => log(`Webhooks do servidor de chamadas em http://127.0.0.1:${boundPort(server)}/sfu-webhook.`));
  return server;
}

let status: TlsStatus = { enabled: false };

// 22/11/2026 às 14:05, na hora deste computador.
const dateTime = (d: Date) => `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

// Abre uma conexão TLS com o servidor da porta e lê o certificado que ele apresenta de fato.
function inspectCertificate(port: number): Promise<TlsStatus> {
  const site = siteHost();
  const host = site.hostname.replace(/^\[|\]$/g, '');
  return new Promise<TlsStatus>((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const done = (s: TlsStatus) => {
      sock.destroy();
      resolve(s);
    };
    sock.setTimeout(5000, () => done({ enabled: true, error: 'O servidor HTTPS não respondeu em 5 s.' }));
    sock.once('error', (e) => done({ enabled: true, error: `Não foi possível conferir o certificado HTTPS: ${e.message}` }));
    sock.once('secureConnect', () => {
      const cert = sock.getPeerX509Certificate();
      if (!cert) return done({ enabled: true, error: 'O servidor HTTPS não apresentou um certificado.' });
      const validFrom = new Date(cert.validFrom);
      const validTo = new Date(cert.validTo);
      const s: TlsStatus = {
        enabled: true,
        subject: cert.subject.split('\n').join(', '),
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / DAY),
      };
      // Só o SAN: o Chrome e o Edge ignoram o CN desde 2017 (NET::ERR_CERT_COMMON_NAME_INVALID).
      const covers = net.isIP(host) ? cert.checkIP(host) : cert.checkHost(host, { subject: 'never' });
      const hasSan = /\b(DNS|IP Address):/.test(cert.subjectAltName ?? '');
      if (validTo.getTime() <= Date.now()) s.error = `O certificado HTTPS venceu em ${validTo.toLocaleDateString('pt-BR')}.`;
      // Sem tolerância: o navegador também não tem (NET::ERR_CERT_DATE_INVALID). O AD CS já recua o início em 10 min.
      else if (validFrom.getTime() > Date.now()) {
        s.error = `O certificado HTTPS só vale a partir de ${dateTime(validFrom)}, e até lá os navegadores recusam. Confira com a TI a data do certificado e o relógio deste computador.`;
      } else if (!covers && !hasSan) {
        s.error = `O certificado HTTPS não traz o nome ${host} no SAN (nome alternativo do assunto), e o Chrome e o Edge recusam certificados só com o CN. Peça à TI um certificado com o nome DNS no SAN.`;
      } else if (!covers) s.error = `O certificado HTTPS não vale para ${host} (o endereço do SITE_URL). Peça à TI um certificado com esse nome.`;
      done(s);
    });
  });
}

// O certificado que o próprio servidor apresenta agora (o arquivo pode ter sido trocado depois do início).
export async function checkCertificate(port: number): Promise<TlsStatus> {
  const result = await inspectCertificate(port);
  status = result;
  return result;
}

// Confere um certificado antes de usá-lo: sobe um servidor HTTPS descartável em 127.0.0.1 com ele.
export async function probeCertificate(opts: https.ServerOptions): Promise<TlsStatus> {
  const server = https.createServer(opts);
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await inspectCertificate(boundPort(server));
  } finally {
    server.close();
  }
}

// PORT, INTERNAL_PORT e HTTP_REDIRECT_PORT repetidos: a segunda porta daria "já está em uso", culpando outro programa.
export function portConflict(c: { port: number; internalPort: number; httpRedirectPorts: number[] }, nativeTls: boolean): string | null {
  if (c.httpRedirectPorts.includes(c.port)) return `A porta ${c.port} está em PORT e em HTTP_REDIRECT_PORT: o redirecionamento precisa de outra porta.`;
  if (!nativeTls) return null;
  const hooks = `A porta ${c.internalPort} é a dos webhooks do servidor de chamadas (INTERNAL_PORT, só em 127.0.0.1)`;
  if (c.internalPort === c.port) return `${hooks} e não pode ser também a do chat (PORT). Escolha outra em PORT ou em INTERNAL_PORT.`;
  if (c.httpRedirectPorts.includes(c.internalPort)) {
    return `${hooks} e não pode ser também de redirecionamento (HTTP_REDIRECT_PORT). Escolha outra em HTTP_REDIRECT_PORT ou em INTERNAL_PORT.`;
  }
  return null;
}

// Último resultado de checkCertificate.
export function tlsStatus(): TlsStatus {
  return status;
}

// Uma linha para o log a partir do resultado de checkCertificate.
export function certificateSummary(s: TlsStatus): string {
  if (s.error) return s.error;
  const date = s.validTo ? new Date(s.validTo).toLocaleDateString('pt-BR') : '?';
  if ((s.daysLeft ?? 0) < 30) {
    return `O certificado HTTPS vence em ${s.daysLeft} dias (${date}). Peça um novo à TI e troque o arquivo: o chat aplica sem reiniciar.`;
  }
  return `HTTPS ativo: ${s.subject}, válido até ${date} (${s.daysLeft} dias).`;
}

// Mensagens para erros ao abrir uma porta.
export function listenErrorMessage(e: NodeJS.ErrnoException, p: number): string {
  if (e.code === 'EADDRINUSE') {
    return `A porta ${p} já está em uso por outro programa. No Windows, veja "netsh http show servicestate" e "Get-NetTCPConnection -LocalPort ${p}" (IIS, WinRM, SSTP e o Gateway de Área de Trabalho Remota costumam usar 443 e 80).`;
  }
  if (e.code === 'EACCES') {
    return `Sem permissão para usar a porta ${p}. No Windows, veja "netsh int ipv4 show excludedportrange protocol=tcp" (o Hyper-V e o WSL reservam faixas); no Linux, dê CAP_NET_BIND_SERVICE ao serviço.`;
  }
  return `Não foi possível abrir a porta ${p}: ${e.message}`;
}

// Log das requisições sem os tokens que o livekit-client põe na URL do /sfu.
const REDACTED = new Set(['access_token', 'join_request']);

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const parts = url.slice(q + 1).split('&').map((part) => {
    const eq = part.indexOf('=');
    const raw = eq < 0 ? part : part.slice(0, eq);
    let name = raw;
    try {
      name = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      // nome malformado: compara como veio
    }
    return REDACTED.has(name) ? `${raw}=***` : part;
  });
  return `${url.slice(0, q + 1)}${parts.join('&')}`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

export function safeReq(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url ?? ''),
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
