import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { admin, startServer, stopServer, urlOf, type Auth } from './helpers';

// Primeiro acesso leve: o JS e o CSS do build saem das cópias .br/.gz gravadas pelo build (preCompressed), os arquivos
// de /assets (com hash no nome) ficam no cache sem revalidar, e o JSON grande da API sai comprimido.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-gz-'));
const dist = path.join(tmp, 'dist');
const before = config.webDist;
const JS = `console.log(${JSON.stringify('x'.repeat(4000))});`;

function get(p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(urlOf('/'));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const writeAsset = (name: string, body: string) => {
  const file = path.join(dist, 'assets', name);
  fs.writeFileSync(file, body);
  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(body));
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(body));
};

let A: Auth;
beforeAll(async () => {
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>teste</title>');
  fs.writeFileSync(path.join(dist, 'sw.js'), '// sw');
  writeAsset('index-abc.js', JS);
  config.webDist = dist;
  await startServer();
  A = await admin();
});

afterAll(async () => {
  await stopServer();
  config.webDist = before;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('compressão e cache', () => {
  it('assets saem da cópia comprimida que o navegador aceita, com cache imutável', async () => {
    const br = await get('/assets/index-abc.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toContain('javascript');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(String(br.headers.vary)).toMatch(/accept-encoding/i);
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(JS);

    const gz = await get('/assets/index-abc.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gz.body).toString()).toBe(JS);

    const plain = await get('/assets/index-abc.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(JS);
    expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // Fora de /assets (service worker, manifest, build.json): continua revalidando.
    const sw = await get('/sw.js', { 'accept-encoding': 'br' });
    expect(sw.status).toBe(200);
    expect(sw.headers['cache-control']).not.toContain('immutable');
  });

  it('arquivo de um build novo, sem reiniciar o servidor, também sai comprimido e imutável', async () => {
    writeAsset('novo-def.js', JS);
    const r = await get('/assets/novo-def.js', { 'accept-encoding': 'br' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('br');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(zlib.brotliDecompressSync(r.body).toString()).toBe(JS);
  });

  it('JSON grande da API sai comprimido (br ou gzip); pequeno ou sem Accept-Encoding, como está', async () => {
    const auth = { 'x-user-id': A.userId, 'x-auth-token': A.authToken };
    const plain = await get('/api/v1/settings', auth);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.length).toBeGreaterThan(1024);
    const total = JSON.parse(plain.body.toString()).total;

    const br = await get('/api/v1/settings', { ...auth, 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(String(br.headers.vary)).toMatch(/accept-encoding/i);
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(plain.body.length / 3);
    expect(JSON.parse(zlib.brotliDecompressSync(br.body).toString())).toMatchObject({ success: true, total });

    const gz = await get('/api/v1/settings', { ...auth, 'accept-encoding': 'br;q=0, gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(zlib.gunzipSync(gz.body).toString()).success).toBe(true);

    const small = await get('/api/v1/info', { 'accept-encoding': 'br' });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(small.body.toString()).success).toBe(true);
  });
});
