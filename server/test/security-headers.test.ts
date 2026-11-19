import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { admin, api, startServer, stopServer, urlOf, type Auth } from './helpers';

// Cabeçalhos de segurança: a página do chat com CSP (só os scripts do build e o do tema, pelo hash) e sem abrir dentro
// de outro site; nosniff e Referrer-Policy em todas as respostas; os arquivos enviados mantêm a política própria.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-csp-'));
const dist = path.join(tmp, 'dist');
const THEME = "document.documentElement.dataset.theme = 'dark';";
const INDEX = `<!doctype html><title>Teste</title><script>${THEME}</script><script type="module" crossorigin src="/assets/app-1.js"></script>`;
const RETRY = "setTimeout(() => location.reload(), 5000);";
const OFFLINE = `<!doctype html><title>Sem conexão</title><script>${THEME}</script><button>Tentar agora</button><script>${RETRY}</script>`;
const before = config.webDist;
let A: Auth;

beforeAll(async () => {
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
  fs.writeFileSync(path.join(dist, 'offline.html'), OFFLINE);
  fs.writeFileSync(path.join(dist, 'assets', 'app-1.js'), 'console.log(1)');
  config.webDist = dist;
  await startServer();
  A = await admin();
});

afterAll(async () => {
  await stopServer();
  config.webDist = before;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(p: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(urlOf(p));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const common = (res: Response, p: string) => {
  expect(res.headers.get('x-content-type-options'), p).toBe('nosniff');
  expect(res.headers.get('referrer-policy'), p).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('x-frame-options'), p).toBe('SAMEORIGIN');
};

describe('cabeçalhos de segurança', () => {
  it('a página do chat sai com CSP que libera só o script do tema embutido', async () => {
    const hash = `'sha256-${createHash('sha256').update(THEME).digest('base64')}'`;
    for (const p of ['/', '/home', '/channel/geral', '/index.html']) {
      const res = await fetch(urlOf(p));
      expect(res.status, p).toBe(200);
      expect(await res.text(), p).toBe(INDEX);
      common(res, p);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, p).toContain(`script-src 'self' ${hash}`);
      for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "default-src 'self'"]) expect(csp, p).toContain(d);
      expect(csp, p).not.toContain('unsafe-eval');
      expect(csp.split(';').find((x) => x.trim().startsWith('script-src')), p).not.toContain('unsafe-inline');
    }
  });

  it('a página sem conexão leva os hashes dos próprios scripts, não os do index.html', async () => {
    const h = (src: string) => `'sha256-${createHash('sha256').update(src).digest('base64')}'`;
    const res = await fetch(urlOf('/offline.html'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(OFFLINE);
    common(res, '/offline.html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`script-src 'self' ${h(THEME)} ${h(RETRY)}`);
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('API, arquivos do build e avatares levam nosniff, sem a CSP da página', async () => {
    for (const p of ['/api/info', '/api/v1/nao-existe', '/assets/app-1.js', '/avatar/admin', '/health']) {
      const res = await fetch(urlOf(p), { headers: { 'x-user-id': A.userId, 'x-auth-token': A.authToken } });
      await res.arrayBuffer();
      common(res, p);
      expect(res.headers.get('content-security-policy'), p).toBeNull();
    }
  });

  it('arquivo enviado mantém a própria CSP (sandbox)', async () => {
    const g = await api('POST', 'groups.create', { name: 'arquivos-csp' }, A);
    const fd = new FormData();
    fd.append('file', new Blob(['oi'], { type: 'text/plain' }), 'oi.txt');
    const up = await api('POST', `rooms.upload/${g.group._id}`, fd, A);
    expect(up.success).toBe(true);
    // Conexão própria, fechada no fim (um download pela conexão reaproveitada do fetch às vezes segura o fechamento do
    // servidor de teste).
    const res = await get(up.message.attachments[0].title_link, { cookie: `rc_uid=${A.userId}; rc_token=${A.authToken}` });
    expect(res.status).toBe(200);
    expect(res.body).toBe('oi');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });
});
