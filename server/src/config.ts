import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const env = process.env;

// Erro de configuração lido ao carregar este arquivo: o index.ts mostra só a mensagem, sem o rastro de pilha.
function configError(message: string) {
  const e = new Error(message);
  e.name = 'ConfigError';
  return e;
}

function readFailure(e: unknown) {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'o arquivo não existe';
  if (code === 'EACCES' || code === 'EPERM') return 'sem permissão de leitura: confira as permissões do arquivo e da pasta';
  if (code === 'EISDIR') return 'o caminho é uma pasta, não um arquivo';
  return code ?? String((e as Error)?.message ?? e);
}

// Conteúdo de um arquivo de segredo, sem o espaço do fim. Arquivos salvos no Windows podem vir com BOM
// (UTF-8 do Bloco de Notas antigo, UTF-16 do "Out-File" do PowerShell 5.1).
export function readSecretFile(file: string): string {
  const buf = fs.readFileSync(file);
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else text = buf.toString('utf8');
  return text.trimEnd();
}

// Segredo vindo de arquivo (NOME_FILE, recomendado no serviço do Windows) ou da variável (NOME, desenvolvimento).
export function readSecret(name: string, e: NodeJS.ProcessEnv = env): string | null {
  const file = e[`${name}_FILE`];
  if (file) {
    try {
      return readSecretFile(file);
    } catch (err) {
      throw configError(`Não foi possível ler ${name}_FILE: ${file} (${readFailure(err)})`);
    }
  }
  return e[name] ?? null;
}

// Nomes que o Fastify (proxy-addr) aceita além de endereços e faixas.
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

// Máscara por extenso (10.0.0.0/255.0.0.0): só os bits da rede ligados, sem buracos, e pelo menos um.
function maskOk(mask: string) {
  const m = mask.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
  const host = 2 ** 32 - 1 - m;
  return m > 0 && (host & (host + 1)) === 0;
}

// O mesmo que o proxy-addr do Fastify aceita: um erro aqui sai em português, e não em inglês ao montar o app.
function proxyEntryOk(s: string) {
  if (PROXY_NAMES.has(s)) return true;
  const [addr, bits, extra] = s.split('/');
  const v = net.isIP(addr);
  if (!v || extra !== undefined) return false;
  if (bits === undefined) return true;
  if (v === 4 && net.isIPv4(bits)) return maskOk(bits);
  return /^\d{1,3}$/.test(bits) && Number(bits) >= 1 && Number(bits) <= (v === 4 ? 32 : 128);
}

// TRUST_PROXY: true, false, ou endereços/faixas separados por vírgula. Sem a variável: false com HTTPS próprio, true sem ele.
export function parseTrustProxy(v: string | undefined, nativeTls: boolean): boolean | string[] {
  const s = (v ?? '').trim();
  if (!s) return !nativeTls;
  const low = s.toLowerCase();
  if (low === 'true' || low === '1') return true;
  if (low === 'false' || low === '0') return false;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = list.find((x) => !proxyEntryOk(x));
  if (bad !== undefined || !list.length) {
    throw configError(`TRUST_PROXY inválido: "${bad ?? s}". Use true, false ou os endereços e faixas dos proxies separados por vírgula (por exemplo 127.0.0.1,10.0.0.0/8).`);
  }
  return list;
}

// Porta de uma variável. Vazia vale o padrão (e não 0, que seria uma porta qualquer).
function portVar(name: string, def: number): number {
  const v = (env[name] ?? '').trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw configError(`${name} inválido: "${v}". Use um número de porta de 1 a 65535.`);
  return n;
}

export const config = {
  port: portVar('PORT', 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: readSecret('DATABASE_URL') ?? 'postgres://chat:chat@127.0.0.1:5432/chat',
  uploadDir: path.resolve(env.UPLOAD_DIR ?? './uploads'),
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : null,
  siteUrl: env.SITE_URL ?? 'http://localhost:3000',
  sessionDays: Number(env.SESSION_DAYS ?? 90),
  // Usuário administrador criado na primeira execução, se não houver nenhum.
  adminUsername: env.ADMIN_USERNAME ?? 'admin',
  adminPassword: env.ADMIN_PASSWORD ?? null,
  adminEmail: env.ADMIN_EMAIL ?? 'admin@localhost',
  logLevel: env.LOG_LEVEL ?? 'info',
  disableCron: env.DISABLE_CRON === '1',
  // HTTPS próprio (sem proxy reverso): PFX exportado do AD CS ou PEM.
  tls: {
    pfxFile: env.TLS_PFX_FILE || null,
    pfxPassphrase: readSecret('TLS_PFX_PASSPHRASE'),
    // Relido na troca do certificado sem reiniciar: o PFX novo pode vir com outra senha.
    pfxPassphraseFile: env.TLS_PFX_PASSPHRASE_FILE || null,
    certFile: env.TLS_CERT_FILE || null,
    keyFile: env.TLS_KEY_FILE || null,
    caFile: env.TLS_CA_FILE || null,
  },
  httpRedirectPorts: (env.HTTP_REDIRECT_PORT ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
  internalPort: portVar('INTERNAL_PORT', 3080), // só 127.0.0.1, só com HTTPS próprio: webhooks do LiveKit
  trustProxy: parseTrustProxy(env.TRUST_PROXY, !!(env.TLS_PFX_FILE || env.TLS_CERT_FILE)),
  livekit: {
    url: env.LIVEKIT_URL || null,
    apiKey: env.LIVEKIT_API_KEY || null,
    apiSecret: readSecret('LIVEKIT_API_SECRET') || null,
  },
};
