import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import {
  certificateSummary, checkCertificate, loadTls, needsAttention, portConflict, startHttpRedirect, startInternalListener, tlsStatus, watchTls,
} from '../src/tls';
import { runServer } from './run-server';

// Certificados descartáveis, feitos pelo openssl numa pasta temporária.
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
if (!hasOpenssl) console.warn('openssl não encontrado: teste de HTTPS ignorado');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-tls-'));
const f = (name: string) => path.join(dir, name);
const HOST = 'chat.exemplo.test';
let hasLegacy = false;

function openssl(...args: string[]) {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')}: ${r.stderr}`);
}

function selfSigned(name: string, cn: string, days: number, san = `DNS:${cn},DNS:${HOST},IP:127.0.0.1`) {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', String(days),
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`);
}

// Com o início escolhido: o "openssl req -x509" do OpenSSL 3.0 não aceita -not_before, o "openssl ca" aceita.
function dated(name: string, cn: string, from: Date, days: number) {
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  if (!fs.existsSync(f('ca'))) {
    fs.mkdirSync(f('ca'));
    fs.writeFileSync(f('ca/index.txt'), '');
    fs.writeFileSync(f('ca/ca.cnf'), ['[ca]', 'default_ca = d', '[d]', 'database = ca/index.txt', 'new_certs_dir = ca', 'rand_serial = yes',
      'default_md = sha256', 'policy = p', 'copy_extensions = copy', 'unique_subject = no', '[p]', 'commonName = supplied', ''].join('\n'));
  }
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${cn},DNS:${HOST},IP:127.0.0.1`);
  openssl('ca', '-config', 'ca/ca.cnf', '-selfsign', '-keyfile', `${name}.key`, '-in', `${name}.csr`, '-startdate', stamp(from),
    '-enddate', stamp(new Date(from.getTime() + days * 86_400_000)), '-batch', '-notext', '-out', `${name}.crt`);
}

if (hasOpenssl) {
  selfSigned('a', HOST, 400);
  // A renovação que só começa a valer daqui a 30 dias.
  dated('futuro', HOST, new Date(Date.now() + 30 * 86_400_000), 400);
  selfSigned('b', 'chat-novo.exemplo.test', 45);
  selfSigned('outro', 'outro.exemplo.test', 400, 'DNS:outro.exemplo.test');
  // Só com o CN, sem SAN: o Chrome e o Edge recusam.
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'cn.key', '-out', 'cn.crt', '-days', '400', '-subj', `/CN=${HOST}`);
  // Venceu ontem (-days -1).
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'velho.key', '-out', 'velho.csr', '-subj', `/CN=${HOST}`);
  fs.writeFileSync(f('velho.ext'), `subjectAltName=DNS:${HOST}\n`);
  openssl('x509', '-req', '-in', 'velho.csr', '-signkey', 'velho.key', '-days', '-1', '-extfile', 'velho.ext', '-out', 'velho.crt');
  // Cadeia fora de ordem: outro certificado antes do certificado do chat.
  fs.writeFileSync(f('invertida.crt'), Buffer.concat([fs.readFileSync(f('b.crt')), fs.readFileSync(f('a.crt'))]));
  openssl('genrsa', '-out', 'outra.key', '2048');
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ec.key');
  openssl('pkcs12', '-export', '-inkey', 'a.key', '-in', 'a.crt', '-out', 'a.pfx', '-passout', 'pass:senha-do-pfx',
    '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'SHA256');
  openssl('pkcs12', '-export', '-inkey', 'b.key', '-in', 'b.crt', '-out', 'b.pfx', '-passout', 'pass:outra-senha',
    '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'SHA256');
  // Chave com senha: como sai do "openssl pkcs12 -nocerts" sem -nodes, e no formato PEM antigo.
  openssl('pkcs12', '-in', 'a.pfx', '-nocerts', '-passin', 'pass:senha-do-pfx', '-passout', 'pass:outra', '-out', 'a-senha.key');
  openssl('rsa', '-in', 'a.key', '-aes256', '-traditional', '-passout', 'pass:outra', '-out', 'a-senha-antiga.key');
  try {
    openssl('pkcs12', '-export', '-legacy', '-inkey', 'a.key', '-in', 'a.crt', '-out', 'antigo.pfx', '-passout', 'pass:senha-do-pfx');
    hasLegacy = true;
  } catch {
    console.warn('openssl sem -legacy: teste de PFX antigo ignorado');
  }
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type TlsConfig = typeof config.tls;
const none: TlsConfig = { pfxFile: null, pfxPassphrase: null, pfxPassphraseFile: null, certFile: null, keyFile: null, caFile: null };
const pem = (name = 'a'): TlsConfig => ({ ...none, certFile: f(`${name}.crt`), keyFile: f(`${name}.key`) });
const pfx = (file = 'a.pfx', pass = 'senha-do-pfx'): TlsConfig => ({ ...none, pfxFile: f(file), pfxPassphrase: pass });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

// GET sem reaproveitar conexões; em HTTPS, confia só no certificado a.crt.
function request(url: string, o: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Res> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const extra = u.protocol === 'https:' ? { ca: fs.readFileSync(f('a.crt')), servername: HOST } : {};
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: o.method ?? 'GET', headers: o.headers, agent: false, ...extra }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

// O certificado que o servidor apresenta agora.
function presented(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: HOST, rejectUnauthorized: false }, () => {
      const subject = s.getPeerX509Certificate()?.subject ?? '';
      s.destroy();
      resolve(subject);
    });
    s.on('error', reject);
  });
}

function listening(s: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    if (s.listening) return resolve((s.address() as AddressInfo).port);
    s.once('listening', () => resolve((s.address() as AddressInfo).port));
    s.once('error', reject);
  });
}

const close = (s: http.Server) => new Promise<void>((resolve) => s.close(() => resolve()));

async function until(cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function withSiteUrl<T>(url: string, fn: () => Promise<T>) {
  const old = config.siteUrl;
  config.siteUrl = url;
  try {
    return await fn();
  } finally {
    config.siteUrl = old;
  }
}

describe.skipIf(!hasOpenssl)('HTTPS próprio, redirecionamento e ouvinte interno', () => {
  it('loadTls aceita PEM e PFX; arquivo faltando dá erro claro', () => {
    expect(tlsStatus()).toEqual({ enabled: false });
    expect(loadTls(none)).toBeNull();

    const p = loadTls(pem())!;
    expect(p.maxHeaderSize).toBe(64 * 1024);
    expect(String(p.cert)).toContain('BEGIN CERTIFICATE');
    expect(p.ca).toBeUndefined();
    expect(loadTls({ ...pem(), caFile: f('a.crt') })!.ca).toBeDefined();

    const x = loadTls(pfx())!;
    expect(x.maxHeaderSize).toBe(64 * 1024);
    expect(x.pfx).toBeDefined();
    expect(x.passphrase).toBe('senha-do-pfx');
    // PFX tem precedência sobre PEM.
    const both = loadTls({ ...pem(), ...pfx() })!;
    expect(both.pfx).toBeDefined();
    expect(both.cert).toBeUndefined();

    expect(() => loadTls({ ...pem(), certFile: f('nao-existe.crt') })).toThrow(`Certificado HTTPS não encontrado: ${f('nao-existe.crt')}`);
    expect(() => loadTls({ ...pem(), caFile: f('nao-existe-ca.crt') })).toThrow(`Certificado HTTPS não encontrado: ${f('nao-existe-ca.crt')}`);
    expect(() => loadTls(pfx('nao-existe.pfx'))).toThrow(`Certificado HTTPS não encontrado: ${f('nao-existe.pfx')}`);
    expect(() => loadTls({ ...none, certFile: f('a.crt') })).toThrow('Defina TLS_CERT_FILE e TLS_KEY_FILE juntos (ou use TLS_PFX_FILE).');
    // Chave de outro certificado, do mesmo tipo (RSA) e de outro tipo (EC).
    expect(() => loadTls({ ...pem(), keyFile: f('outra.key') })).toThrow('O certificado e a chave não combinam.');
    expect(() => loadTls({ ...pem(), keyFile: f('ec.key') })).toThrow('O certificado e a chave não combinam.');
    fs.writeFileSync(f('lixo.crt'), '-----BEGIN CERTIFICATE-----\nisto não é um certificado\n-----END CERTIFICATE-----\n');
    expect(() => loadTls({ ...pem(), certFile: f('lixo.crt') })).toThrow(/^Não foi possível usar o certificado HTTPS: /);

    // Erros comuns ao montar o PEM à mão, cada um com o motivo de verdade.
    expect(() => loadTls({ ...pem(), certFile: f('invertida.crt') })).toThrow(
      'O certificado do chat precisa ser o primeiro do arquivo TLS_CERT_FILE (depois vêm as intermediárias).',
    );
    for (const k of ['a-senha.key', 'a-senha-antiga.key']) {
      expect(() => loadTls({ ...pem(), keyFile: f(k) })).toThrow(
        'A chave em TLS_KEY_FILE tem senha. Exporte a chave sem senha (openssl pkcs12 ... -nodes) ou use o PFX (TLS_PFX_FILE).',
      );
    }
    expect(() => loadTls({ ...pem(), certFile: f('a.key'), keyFile: f('a.crt') })).toThrow(
      `TLS_CERT_FILE não é um certificado em PEM (${f('a.key')}): falta a linha "-----BEGIN CERTIFICATE-----". Se o arquivo é um PFX, use TLS_PFX_FILE.`,
    );
    expect(() => loadTls({ ...pem(), certFile: f('a.pfx') })).toThrow(`TLS_CERT_FILE não é um certificado em PEM (${f('a.pfx')})`);
    expect(() => loadTls({ ...pem(), keyFile: f('a.crt') })).toThrow(
      `TLS_KEY_FILE não é uma chave em PEM (${f('a.crt')}): falta a linha "-----BEGIN PRIVATE KEY-----".`,
    );
    expect(() => loadTls({ ...pem(), caFile: f('a.key') })).toThrow(`TLS_CA_FILE não é um certificado em PEM (${f('a.key')})`);
    expect(() => loadTls({ ...none, pfxFile: f('a.crt'), pfxPassphrase: 'x' })).toThrow(
      `TLS_PFX_FILE é um arquivo PEM (${f('a.crt')}), não um PFX. Use TLS_CERT_FILE e TLS_KEY_FILE para certificado e chave em PEM.`,
    );
  });

  it.skipIf(!hasLegacy)('PFX com criptografia antiga pede para exportar com AES256-SHA256', () => {
    expect(() => loadTls(pfx('antigo.pfx'))).toThrow(
      'O PFX usa uma criptografia antiga que o Node 22 não lê. Exporte de novo com AES256-SHA256 ou use TLS_CERT_FILE e TLS_KEY_FILE.',
    );
  });

  it('senha errada do PFX dá erro claro', () => {
    expect(() => loadTls(pfx('a.pfx', 'senha-errada'))).toThrow('A senha do PFX não confere (TLS_PFX_PASSPHRASE_FILE).');
    expect(() => loadTls({ ...pfx(), pfxPassphrase: null })).toThrow('A senha do PFX não confere (TLS_PFX_PASSPHRASE_FILE).');
  });

  it('servidor HTTPS responde e o redirecionamento manda para o host do SITE_URL com o mesmo caminho, nas duas portas', async () => {
    const app = await buildApp({ logger: false, https: loadTls(pfx()) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const redirects: http.Server[] = [];
    try {
      const health = await request(`https://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ ok: true });
      // Sem TLS na porta do HTTPS não há resposta em texto puro.
      await expect(request(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

      await withSiteUrl(`https://${HOST}`, async () => {
        redirects.push(startHttpRedirect(0, () => {}), startHttpRedirect(0, () => {}));
        for (const s of redirects) {
          const p = await listening(s);
          // O Host da requisição não muda o destino (sem redirecionamento aberto).
          const r = await request(`http://127.0.0.1:${p}/channel/geral?msg=abc&x=1`, { headers: { host: 'outro-site.example' } });
          expect(r.status).toBe(308);
          expect(r.headers.location).toBe(`https://${HOST}/channel/geral?msg=abc&x=1`);
          const post = await request(`http://127.0.0.1:${p}/api/v1/login`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
          expect(post.status).toBe(308);
          expect(post.headers.location).toBe(`https://${HOST}/api/v1/login`);
        }
      });
      // Porta no SITE_URL vai junto.
      await withSiteUrl(`https://${HOST}:8443/`, async () => {
        const s = startHttpRedirect(0, () => {});
        redirects.push(s);
        const r = await request(`http://127.0.0.1:${await listening(s)}/`);
        expect(r.headers.location).toBe(`https://${HOST}:8443/`);
      });
    } finally {
      await Promise.all(redirects.map(close));
      await app.close();
    }
  });

  it('ouvinte interno só aceita POST /sfu-webhook em 127.0.0.1', async () => {
    // Um app mínimo no lugar do chat: devolve o que chegou pela injeção.
    const app = Fastify();
    app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    app.post('/sfu-webhook', async (req) => ({ headers: req.headers, body: req.body }));
    await app.ready();
    const logs: string[] = [];
    const s = startInternalListener(app as unknown as FastifyInstance, 0, (m) => logs.push(m));
    try {
      const port = await listening(s);
      expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
      expect(logs.join('\n')).toContain(`http://127.0.0.1:${port}/sfu-webhook`);
      const url = `http://127.0.0.1:${port}`;

      expect((await request(`${url}/sfu-webhook`)).status).toBe(404);
      expect((await request(`${url}/api/v1/me`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await request(`${url}/sfu-webhook/x`, { method: 'POST', body: '{}' })).status).toBe(404);

      const body = JSON.stringify({ event: 'room_started', id: 'EV_1', createdAt: '1700000000' });
      const ok = await request(`${url}/sfu-webhook`, {
        method: 'POST',
        body,
        headers: { authorization: 'Bearer abc.def.ghi', 'content-type': 'application/webhook+json', cookie: 'rc_token=x', 'x-user-id': 'u1' },
      });
      expect(ok.status).toBe(200);
      const echo = JSON.parse(ok.body);
      expect(echo.body).toBe(body);
      expect(echo.headers.authorization).toBe('Bearer abc.def.ghi');
      expect(echo.headers['content-type']).toBe('application/webhook+json');
      // Só a assinatura e o tipo passam: nada de cookies ou cabeçalhos de autenticação do chat.
      expect(echo.headers.cookie).toBeUndefined();
      expect(echo.headers['x-user-id']).toBeUndefined();

      const big = await request(`${url}/sfu-webhook`, { method: 'POST', body: Buffer.alloc(64 * 1024 + 1, 'a'), headers: { 'content-type': 'application/webhook+json' } });
      expect(big.status).toBe(413);

      // De outro endereço deste computador a porta não responde.
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (lan) await expect(request(`http://${lan.address}:${port}/sfu-webhook`, { method: 'POST', body: '{}' })).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await close(s);
      await app.close();
    }
  });

  it('troca do certificado é aplicada sem reiniciar', async () => {
    const live = { ...none, certFile: f('vivo.crt'), keyFile: f('vivo.key') };
    fs.copyFileSync(f('a.crt'), live.certFile);
    fs.copyFileSync(f('a.key'), live.keyFile);
    const logs: string[] = [];
    const warns: string[] = [];
    const server = https.createServer(loadTls(live)!, (_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    const port = await listening(server);
    const swap = async (name: string) => {
      fs.copyFileSync(f(`${name}.key`), live.keyFile);
      fs.copyFileSync(f(`${name}.crt`), live.certFile);
    };
    const rejected = (reason: string) => until(() => warns.some((m) => m === `O certificado HTTPS novo não foi aplicado; o anterior continua valendo. ${reason}`));
    const stop = watchTls(server, (m) => logs.push(m), live, { intervalMs: 100, warn: (m) => warns.push(m) });
    try {
      await withSiteUrl(`https://${HOST}`, async () => {
        expect(await presented(port)).toBe(`CN=${HOST}`);
        await swap('b');
        expect(await until(async () => (await presented(port)) === 'CN=chat-novo.exemplo.test')).toBe(true);
        expect(logs).toContain('Certificado HTTPS recarregado.');
        // Faltam menos de 45 dias: o resumo depois da troca é só informativo; abaixo de 30 vira aviso.
        expect(await until(() => logs.some((m) => m.startsWith('HTTPS ativo: CN=chat-novo.exemplo.test')))).toBe(true);
        expect(warns).toEqual([]);

        // Arquivo novo com defeito: o certificado anterior continua valendo, com aviso.
        fs.writeFileSync(live.certFile, 'quebrado');
        expect(await until(() => warns.some((m) => m.startsWith('O certificado HTTPS novo não foi aplicado; o anterior continua valendo.')))).toBe(true);
        expect(await presented(port)).toBe('CN=chat-novo.exemplo.test');

        // Certificado vencido (o do ano passado copiado por engano) não substitui o que está valendo.
        await swap('velho');
        const expiredOn = new Date(new X509Certificate(fs.readFileSync(f('velho.crt'))).validTo).toLocaleDateString('pt-BR');
        expect(await rejected(`O certificado HTTPS venceu em ${expiredOn}.`)).toBe(true);
        expect(await presented(port)).toBe('CN=chat-novo.exemplo.test');

        // Nem o de outro servidor, nem um só com o CN.
        await swap('outro');
        expect(await rejected(`O certificado HTTPS não vale para ${HOST} (o endereço do SITE_URL). Peça à TI um certificado com esse nome.`)).toBe(true);
        expect(await presented(port)).toBe('CN=chat-novo.exemplo.test');
        await swap('cn');
        expect(await until(() => warns.some((m) => m.includes(`não traz o nome ${HOST} no SAN`)))).toBe(true);
        expect(await presented(port)).toBe('CN=chat-novo.exemplo.test');
        expect(logs.filter((m) => m === 'Certificado HTTPS recarregado.')).toHaveLength(1);
      });
    } finally {
      stop();
      await close(server);
    }

    // Se o certificado atual também não vale para o SITE_URL, o novo não piora nada e é aplicado (com aviso).
    const server1 = https.createServer(loadTls(pem('outro'))!, (_req, res) => res.end('ok'));
    server1.listen(0, '127.0.0.1');
    const port1 = await listening(server1);
    const live1 = { ...none, certFile: f('vivo1.crt'), keyFile: f('vivo1.key') };
    fs.copyFileSync(f('outro.crt'), live1.certFile);
    fs.copyFileSync(f('outro.key'), live1.keyFile);
    const warns1: string[] = [];
    await withSiteUrl('https://chat.outro-dominio.test', async () => {
      const stop1 = watchTls(server1, () => {}, live1, { intervalMs: 100, warn: (m) => warns1.push(m) });
      try {
        fs.copyFileSync(f('a.key'), live1.keyFile);
        fs.copyFileSync(f('a.crt'), live1.certFile);
        expect(await until(async () => (await presented(port1)) === `CN=${HOST}`)).toBe(true);
        expect(await until(() => warns1.some((m) => m.startsWith('O certificado HTTPS não vale para chat.outro-dominio.test')))).toBe(true);
      } finally {
        stop1();
        await close(server1);
      }
    });

    // PFX renovado com outra senha: o arquivo da senha é relido.
    const livePfx = { ...none, pfxFile: f('vivo.pfx'), pfxPassphraseFile: f('vivo-senha.txt'), pfxPassphrase: 'senha-do-pfx' };
    fs.copyFileSync(f('a.pfx'), livePfx.pfxFile);
    fs.writeFileSync(livePfx.pfxPassphraseFile, 'senha-do-pfx\r\n');
    const server2 = https.createServer(loadTls(livePfx)!, (_req, res) => res.end('ok'));
    server2.listen(0, '127.0.0.1');
    const port2 = await listening(server2);
    const stop2 = watchTls(server2, () => {}, livePfx, { intervalMs: 100 });
    try {
      expect(await presented(port2)).toBe(`CN=${HOST}`);
      fs.copyFileSync(f('b.pfx'), livePfx.pfxFile);
      fs.writeFileSync(livePfx.pfxPassphraseFile, 'outra-senha\n');
      expect(await until(async () => (await presented(port2)) === 'CN=chat-novo.exemplo.test')).toBe(true);
    } finally {
      stop2();
      await close(server2);
    }
  });

  it('checkCertificate informa validade e dias restantes', async () => {
    const server = https.createServer(loadTls(pem())!, (_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    const port = await listening(server);
    const short = https.createServer(loadTls(pem('b'))!, (_req, res) => res.end('ok'));
    short.listen(0, '127.0.0.1');
    const shortPort = await listening(short);
    try {
      await withSiteUrl(`https://${HOST}`, async () => {
        const s = await checkCertificate(port);
        expect(s).toMatchObject({ enabled: true, subject: `CN=${HOST}` });
        expect(s.error).toBeUndefined();
        expect(s.daysLeft).toBeGreaterThanOrEqual(398);
        expect(s.daysLeft).toBeLessThanOrEqual(400);
        expect(new Date(s.validTo!).getTime()).toBeGreaterThan(Date.now() + 398 * 86_400_000);
        expect(tlsStatus()).toEqual(s);
        expect(certificateSummary(s)).toMatch(/^HTTPS ativo: CN=chat\.exemplo\.test, válido até \d{2}\/\d{2}\/\d{4} \(\d+ dias\)\.$/);

        // Menos de 30 dias: aviso para pedir outro.
        const b = await checkCertificate(shortPort);
        expect(b.daysLeft).toBeLessThan(45);
        expect(b.error).toBeUndefined();
        expect(certificateSummary({ ...b, daysLeft: 12 })).toMatch(/^O certificado HTTPS vence em 12 dias \(\d{2}\/\d{2}\/\d{4}\)\. Peça um novo à TI/);
      });
      // Só com o CN, sem SAN: o nome confere, mas o Chrome e o Edge recusam.
      const cnOnly = https.createServer(loadTls(pem('cn'))!, (_req, res) => res.end('ok'));
      cnOnly.listen(0, '127.0.0.1');
      try {
        const cnPort = await listening(cnOnly);
        await withSiteUrl(`https://${HOST}`, async () => {
          const s = await checkCertificate(cnPort);
          expect(s.subject).toBe(`CN=${HOST}`);
          expect(s.error).toBe(
            `O certificado HTTPS não traz o nome ${HOST} no SAN (nome alternativo do assunto), e o Chrome e o Edge recusam certificados só com o CN. Peça à TI um certificado com o nome DNS no SAN.`,
          );
        });
      } finally {
        await close(cnOnly);
      }
      // Certificado que não vale para o endereço do SITE_URL.
      await withSiteUrl('https://chat.outro-dominio.test', async () => {
        const s = await checkCertificate(port);
        expect(s.error).toBe('O certificado HTTPS não vale para chat.outro-dominio.test (o endereço do SITE_URL). Peça à TI um certificado com esse nome.');
        expect(s.daysLeft).toBeGreaterThan(300);
      });
      // Ninguém escutando.
      const down = await checkCertificate(1);
      expect(down.enabled).toBe(true);
      expect(down.error).toMatch(/^Não foi possível conferir o certificado HTTPS: /);
    } finally {
      await close(server);
      await close(short);
    }
  });

  it('certificado que ainda não começou a valer: aviso ao conferir, recusa no --check-tls e na troca, e entra sozinho na hora', async () => {
    const from = (name: string) => new Date(new X509Certificate(fs.readFileSync(f(`${name}.crt`))).validFrom);
    const when = (d: Date) => `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    const notYet = (name: string) =>
      `O certificado HTTPS só vale a partir de ${when(from(name))}, e até lá os navegadores recusam. Confira com a TI a data do certificado e o relógio deste computador.`;
    const site = `https://${HOST}`;

    // Ao subir e na conferência diária: aviso, com a data de início.
    const server = https.createServer(loadTls(pem('futuro'))!, (_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    try {
      const port = await listening(server);
      await withSiteUrl(site, async () => {
        const s = await checkCertificate(port);
        expect(s).toMatchObject({ enabled: true, subject: `CN=${HOST}`, validFrom: from('futuro').toISOString(), error: notYet('futuro') });
        expect(s.daysLeft).toBeGreaterThan(400);
        expect(needsAttention(s)).toBe(true);
        expect(certificateSummary(s)).toBe(notYet('futuro'));
      });
    } finally {
      await close(server);
    }

    // O instalador do Windows confere com --check-tls antes de copiar o certificado.
    const r = await runServer({ TLS_CERT_FILE: f('futuro.crt'), TLS_KEY_FILE: f('futuro.key'), SITE_URL: site }, ['--check-tls']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout.trim()).error).toBe(notYet('futuro'));

    // Na troca sem reiniciar, o atual continua valendo; o novo entra sozinho quando começa a valer.
    const live = { ...none, certFile: f('vivo2.crt'), keyFile: f('vivo2.key') };
    fs.copyFileSync(f('a.crt'), live.certFile);
    fs.copyFileSync(f('a.key'), live.keyFile);
    const logs: string[] = [];
    const warns: string[] = [];
    const current = https.createServer(loadTls(live)!, (_req, res) => res.end('ok'));
    current.listen(0, '127.0.0.1');
    const port = await listening(current);
    const swap = (name: string) => {
      fs.copyFileSync(f(`${name}.key`), live.keyFile);
      fs.copyFileSync(f(`${name}.crt`), live.certFile);
    };
    const refused = (name: string) =>
      `O certificado HTTPS novo não foi aplicado; o anterior continua valendo. ${notYet(name)} O chat passa a usá-lo sozinho nessa hora, sem reiniciar.`;
    const stop = watchTls(current, (m) => logs.push(m), live, { intervalMs: 100, warn: (m) => warns.push(m) });
    try {
      await withSiteUrl(site, async () => {
        swap('futuro');
        expect(await until(() => warns.includes(refused('futuro')))).toBe(true);
        expect(await presented(port)).toBe(`CN=${HOST}`);

        // Começa a valer em 5 s (o relógio de quem emitiu um pouco adiantado): recusado agora, aplicado depois sem
        // outra troca de arquivo.
        dated('logo', 'chat-logo.exemplo.test', new Date(Date.now() + 5000), 400);
        swap('logo');
        expect(await until(() => warns.includes(refused('logo')))).toBe(true);
        expect(await presented(port)).toBe(`CN=${HOST}`);
        expect(logs).not.toContain('Certificado HTTPS recarregado.');
        expect(await until(async () => (await presented(port)) === 'CN=chat-logo.exemplo.test', 15_000)).toBe(true);
        expect(logs).toContain('Certificado HTTPS recarregado.');
        expect(await until(() => logs.some((m) => m.startsWith('HTTPS ativo: CN=chat-logo.exemplo.test')))).toBe(true);
      });
    } finally {
      stop();
      await close(current);
    }
  });

  it('consulta de 40 KB na URL passa nos dois modos (maxHeaderSize)', async () => {
    const q = `/health?join_request=${'A'.repeat(40 * 1024)}`;
    // Sem o ajuste, o Node recusa (431): o teste mede de fato o limite.
    const plain = http.createServer((_req, res) => res.end('ok'));
    plain.listen(0, '127.0.0.1');
    try {
      expect((await request(`http://127.0.0.1:${await listening(plain)}${q}`)).status).toBe(431);
    } finally {
      await close(plain);
    }

    for (const opts of [{}, { https: loadTls(pem()) }]) {
      const app = await buildApp({ logger: false, ...opts });
      await app.listen({ port: 0, host: '127.0.0.1' });
      try {
        const port = (app.server.address() as AddressInfo).port;
        const r = await request(`${opts.https ? 'https' : 'http'}://127.0.0.1:${port}${q}`);
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body)).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    }
  });

  it('porta dos webhooks igual à do chat ou à de um redirecionamento é recusada ao subir, antes do banco', async () => {
    expect(portConflict({ port: 443, internalPort: 3080, httpRedirectPorts: [80, 3000] }, true)).toBeNull();
    expect(portConflict({ port: 3080, internalPort: 3080, httpRedirectPorts: [] }, false)).toBeNull();
    expect(portConflict({ port: 3080, internalPort: 3080, httpRedirectPorts: [] }, true)).toBe(
      'A porta 3080 é a dos webhooks do servidor de chamadas (INTERNAL_PORT, só em 127.0.0.1) e não pode ser também a do chat (PORT). Escolha outra em PORT ou em INTERNAL_PORT.',
    );
    expect(portConflict({ port: 443, internalPort: 3080, httpRedirectPorts: [80, 3080] }, true)).toBe(
      'A porta 3080 é a dos webhooks do servidor de chamadas (INTERNAL_PORT, só em 127.0.0.1) e não pode ser também de redirecionamento (HTTP_REDIRECT_PORT). Escolha outra em HTTP_REDIRECT_PORT ou em INTERNAL_PORT.',
    );
    expect(portConflict({ port: 3000, internalPort: 3080, httpRedirectPorts: [80, 3000] }, false)).toBe(
      'A porta 3000 está em PORT e em HTTP_REDIRECT_PORT: o redirecionamento precisa de outra porta.',
    );

    // O processo de verdade sai com a mensagem, sem tocar no banco (o endereço abaixo não existe).
    const r = await runServer({
      PORT: '3599', INTERNAL_PORT: '3599', TLS_CERT_FILE: f('a.crt'), TLS_KEY_FILE: f('a.key'), SITE_URL: `https://${HOST}:3599`,
      DATABASE_URL: 'postgres://ninguem:x@127.0.0.1:1/nada',
    });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(
      'A porta 3599 é a dos webhooks do servidor de chamadas (INTERNAL_PORT, só em 127.0.0.1) e não pode ser também a do chat (PORT). Escolha outra em PORT ou em INTERNAL_PORT.',
    );
  });
});

// Sem Windows aqui: confere no texto do instalador o que protege o serviço. O comportamento foi conferido com o
// PowerShell 7 e um icacls simulado; estas conferências pegam a volta dos problemas do review.
describe('instalador do serviço do Windows', () => {
  const ps1 = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/windows/install-chat-service.ps1'), 'utf8');
  const at = (s: string) => {
    const i = ps1.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it('tranca a pasta do serviço, a do chat e a dos arquivos enviados antes de copiar o WinSW e gravar o XML', () => {
    const lock = at('Protect-Folder $d.Path $d.What -Mine:$d.Mine -NoLinks:$d.NoLinks -Again:$d.Again -Skip $skip');
    for (const d of ['$InstallDir', '$AppDir', '$UploadDir']) expect(at(`[pscustomobject]@{ Path = ${d}; `)).toBeLessThan(lock);
    expect(lock).toBeLessThan(at('Copy-Item -LiteralPath $winswSource -Destination $ServiceExe'));
    expect(lock).toBeLessThan(at('[IO.File]::WriteAllText($ServiceXml'));
    // No C:\ os Usuários autenticados herdam Modificar: a pasta perde a herança e fica só com SYSTEM e Administradores.
    const fn = ps1.slice(at('function Protect-Folder('), at('function Protect-Root('));
    expect(fn).toContain("@($Path, '/setowner', '*S-1-5-32-544', '/Q')");
    expect(fn).toContain("@($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q')");
    expect(fn).toContain("@($inside, '/reset', '/T', '/C', '/L', '/Q')");
    // C:\Wescc só com os Administradores criando ou renomeando pastas; pastas fora dele precisam de pais protegidos.
    expect(ps1).toMatch(/Invoke-Step "Deixar \$WesccRoot com os Administradores como donos[^\n]*\{ Protect-Root \$WesccRoot \}/);
    for (const d of ['InstallDir', 'AppDir', 'UploadDir', 'SecretsDir']) expect(ps1).toContain(`Assert-SafeLocation $${d} `);
    expect(ps1).toContain('if (Test-InUserProfile $AppDir) {\n  Fail "O chat está numa pasta de usuário');
  });

  it('o que já existia na pasta do serviço ou na dos segredos: link, junção ou item de outra conta param a instalação, antes e depois de trancar', () => {
    const own = ps1.slice(at('function Assert-OwnFolder('), at('function Protect-Folder('));
    // Percorre sem seguir links: cada item é conferido antes de entrar nele.
    expect(own).not.toContain('-Recurse');
    expect(own).toContain('@(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop)');
    expect(own).toContain('if (([int]$item.Attributes -band 0x400) -ne 0) {\n      Fail "Há um atalho (link ou junção) para outro lugar em $full');
    // Donos aceitos: SYSTEM, Administradores, TrustedInstaller, quem roda o instalador e o próprio serviço (logs).
    expect(own).toContain('$owners = $TrustedSids + @($CurrentSid, $ServiceSid)');
    expect(own).toContain('if ($owners -notcontains $owner) {');
    expect(ps1).toContain('$CurrentSid = $identity.User.Value');
    // Antes de qualquer mudança (passo 1); a dos logs também não pode ser um link.
    const early = at("if (-not (Test-Locked $InstallDir)) { Assert-OwnFolder $InstallDir 'pasta do serviço' -Mine -Skip $AppDir }");
    expect(ps1).toContain("if (Test-Locked $SecretsDir) { Assert-OwnFolder $SecretsDir 'pasta dos segredos' } else { Assert-OwnFolder $SecretsDir 'pasta dos segredos' -Mine }");
    expect(ps1).toContain("if ($uploadsFresh) { Assert-OwnFolder $UploadDir 'pasta dos arquivos enviados' }");
    expect(ps1).toContain("Assert-SafeLocation $LogDir 'A pasta dos logs' $LockedDirs");
    expect(at('# ---------- 1. Ambiente ----------')).toBeLessThan(early);
    expect(early).toBeLessThan(at("Section 'Portas'"));
    // De novo ao trancar: antes do dono novo, e com o topo já trancado, antes de passar a posse do que está dentro.
    const fn = ps1.slice(at('function Protect-Folder('), at('function Protect-Root('));
    const pre = fn.indexOf('if ($Mine) { Assert-OwnFolder $Path $What -Mine -Skip $Skip }');
    const top = fn.indexOf("Remove-OtherAccess $Path $TrustedSids");
    const post = fn.indexOf('if ($Mine -or $NoLinks) { Assert-OwnFolder $Path $What -Mine:$Mine -Skip $Skip }');
    const inside = fn.indexOf("@($inside, '/setowner'");
    expect(pre).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(fn.indexOf("@($Path, '/setowner'"));
    expect(top).toBeLessThan(post);
    expect(post).toBeLessThan(inside);
    expect(ps1).toContain("Protect-Folder $SecretsDir 'pasta dos segredos' -Mine");
    expect(ps1).toContain("[pscustomobject]@{ Path = $InstallDir; What = 'pasta do serviço'; Mine = $true; NoLinks = $true; Again = $false }");
    expect(ps1).toContain("[pscustomobject]@{ Path = $UploadDir; What = 'pasta dos arquivos enviados'; Mine = $false; NoLinks = $true; Again = $false }");
  });

  it('segredos, WinSW e XML vão para arquivos novos: quem guardou o arquivo antigo (aberto ou com outro nome) não vê o conteúdo novo', () => {
    for (const name of ['Write-SecretFile', 'Copy-SecretFile']) {
      const fn = ps1.slice(at(`function ${name}(`));
      const body = fn.slice(0, fn.indexOf('\n}\n'));
      const write = body.search(/\[IO\.File\]::WriteAllText\(\$new|Copy-Item -LiteralPath \$Source -Destination \$new/);
      expect(write, name).toBeGreaterThan(-1);
      expect(write).toBeLessThan(body.indexOf('Remove-OldFile $Path'));
      expect(body.indexOf('Remove-OldFile $Path')).toBeLessThan(body.indexOf('[IO.File]::Move($new, $Path)'));
    }
    expect(ps1).toContain('function Remove-OldFile([string]$Path) {\n  if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }\n}');
    expect(ps1).toContain('Copy-SecretFile $pfxSource $PfxTarget');
    expect(ps1).toContain('Copy-SecretFile $certSource $CertTarget');
    expect(ps1).toContain('Copy-SecretFile $keySource $KeyTarget');
    expect(ps1).not.toMatch(/Copy-Item -LiteralPath \$(pfx|cert|key)Source/);
    expect(ps1).toContain('Remove-OldFile $ServiceExe; Copy-Item -LiteralPath $winswSource -Destination $ServiceExe');
    expect(ps1).toContain('Remove-OldFile $ServiceXml; [IO.File]::WriteAllText($ServiceXml');
  });

  it('com -Offline, o WinSW é copiado para a pasta temporária e conferido lá; a cópia instalada é conferida de novo', () => {
    const pick = ps1.slice(at('  if ($Offline) {\n    $offlineFile = Join-Path $Offline $winswFile'), at('Ok "WinSW $winswTag conferido (SHA-256)."'));
    const copy = pick.indexOf('Copy-Item -LiteralPath $offlineFile -Destination $winswSource');
    expect(copy).toBeGreaterThan(-1);
    expect(pick.indexOf('$winswSource = Join-Path $env:TEMP "wescc-$winswFile"')).toBeLessThan(copy);
    // O hash é tirado da cópia na pasta do administrador, depois da cópia.
    expect(copy).toBeLessThan(pick.indexOf('if ((Get-Sha256 $winswSource) -ne $winswHash)'));
    const install = ps1.slice(at('Remove-OldFile $ServiceExe; Copy-Item -LiteralPath $winswSource -Destination $ServiceExe'));
    expect(install.slice(0, install.indexOf('Gravar $ServiceXml'))).toContain('if ((Get-Sha256 $ServiceExe) -ne $winswHash) {\n      Remove-OldFile $ServiceExe');
  });

  it('a cada vez confere o que o serviço roda na pasta do chat e refaz as permissões dela inteira quando algo chegou com outras', () => {
    const items = ps1.slice(at('function Get-AppItems('), at('function Assert-SafeLocation('));
    expect(items).toContain("@('', 'server', 'server\\dist', 'web', 'web\\dist', 'shared', 'node_modules', 'server\\node_modules')");
    expect(items).toContain("$c.Name.StartsWith('@')");
    const check = ps1.slice(at('$appRelock = $false'), at("if (-not $appRelock) { Ok 'Pastas do serviço conferidas"));
    expect(check).toContain('if ($appWasLocked) {');
    expect(check).toContain('foreach ($item in (Get-AppItems $AppDir)) {');
    expect(check).toContain('Get-UnsafeAccess $item.FullName $WriteRights');
    expect(check).toContain('$appRelock = $true');
    expect(check).toContain('Warn (');
    // O passo 5 percorre a pasta inteira de novo (-Again) em vez de conferir só o topo.
    expect(ps1).toContain("[pscustomobject]@{ Path = $AppDir; What = 'pasta do chat'; Mine = $false; NoLinks = $false; Again = $appRelock }");
    expect(ps1).toContain('if (-not $Again -and (Test-Locked $Path)) { return }');
    expect(at('$appRelock = $false')).toBeLessThan(at('[pscustomobject]@{ Path = $AppDir;'));
    expect(ps1).toContain("Depois de atualizar, rode este script com -Reconfigure");
  });

  it('com HTTPS, a porta do chat não pode ser a dos webhooks', () => {
    expect(ps1).toContain('if ($https -and $Port -eq $InternalPort) { Fail ');
  });

  it('-Uninstall remove o serviço, as regras do firewall, as reservas de porta anotadas e o acesso aos segredos', () => {
    const block = ps1.slice(at('if ($Uninstall) {'), at('# ---------- 1. Ambiente ----------'));
    expect(block).toContain("Invoke-Native $ServiceExe @('uninstall')");
    expect(block).toContain("Invoke-Native 'sc.exe' @('delete', $ServiceName)");
    expect(block).toContain('$rules | Remove-NetFirewallRule');
    expect(block).toContain("$reserved = @(Split-List $S['ReservedPorts']");
    expect(block).toContain("@('int', 'ipv4', 'delete', 'excludedportrange', 'protocol=tcp', \"startport=$p\"");
    expect(block).toContain("@($SecretsDir, '/remove', \"*$ServiceSid\"");
    expect(block).toMatch(/\n  exit 0\n\}\n*$/);
    // A instalação anota as portas que reservou, para a remoção desfazer só essas.
    expect(ps1).toContain('$script:reservedNow += $p');
    expect(ps1).toContain('ReservedPorts = @($allReserved)');
  });
});
