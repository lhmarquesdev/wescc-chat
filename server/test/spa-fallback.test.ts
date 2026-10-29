import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { isSpaPath } from '../src/app';
import { config } from '../src/config';
import { startServer, stopServer, urlOf } from './helpers';

// Fallback da SPA com um build de mentira do web: as rotas do cliente recebem o index.html, os arquivos do build saem
// como estão e os caminhos do servidor (API, arquivos, /sfu, /twirp...) respondem 404 em JSON, nunca o index.html.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-spa-'));
const dist = path.join(tmp, 'dist');
const INDEX = '<!doctype html><title>SPA de teste</title>';
const before = config.webDist;

// Pedido com o caminho cru, sem a normalização do fetch (o /sfu/%2e%2e/... chega ao servidor como foi escrito).
function rawGet(p: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  const u = new URL(urlOf('/'));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsStatus(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(urlOf(p).replace(/^http/, 'ws'));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', reject);
  });
}

const expectNotFoundJson = (r: { status: number; type: string; body: string }, p: string) => {
  expect(r.status, p).toBe(404);
  expect(r.type, p).toContain('application/json');
  expect(JSON.parse(r.body), p).toMatchObject({ success: false, errorType: 'error-not-found' });
};

beforeAll(async () => {
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
  fs.writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log(1)');
  // Vizinho com o mesmo começo de nome: não pode sair pelo fallback.
  fs.mkdirSync(path.join(tmp, 'dist-velho'));
  fs.writeFileSync(path.join(tmp, 'dist-velho', 'segredo.txt'), 'segredo');
  config.webDist = dist;
  await startServer();
});

afterAll(async () => {
  await stopServer();
  config.webDist = before;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fallback da SPA', () => {
  it('rotas do cliente recebem o index.html (200); arquivos do build saem como estão', async () => {
    for (const p of ['/', '/home', '/channel/geral', '/direct/abc/thread/x', '/admin/integrations/teams/mensagens', '/admin/calls', '/account/connected', '/live/xyz', '/qualquer-coisa', '/apiario']) {
      const r = await rawGet(p);
      expect(r.status, p).toBe(200);
      expect(r.type, p).toContain('text/html');
      expect(r.body, p).toBe(INDEX);
    }
    const js = await rawGet('/assets/app-123.js');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.log(1)');
    // O widget do atendimento é do servidor, não da SPA.
    const widget = await rawGet('/livechat');
    expect(widget.status).toBe(200);
    expect(widget.body).not.toBe(INDEX);
  });

  it('/twirp, /sfu e os demais caminhos do servidor dão 404 em JSON, com e sem normalização', async () => {
    const paths = [
      '/twirp',
      '/twirp/',
      '/twirp/livekit.RoomService/ListRooms',
      '/sfu/%2e%2e/twirp/livekit.RoomService/ListRooms',
      '/x/%2e%2e/twirp/livekit.RoomService/ListRooms',
      '//twirp/livekit.RoomService/ListRooms',
      '/api',
      '/api/',
      '/api/v1/nao-existe',
      '/api/v1/%2e%2e/%2e%2e/twirp/x',
      '/sfu-webhook',
      '/websocket/x',
      '/file-upload/',
      '/avatar/a/b/c',
      '/sticker/a/b/c',
      '/emoji-custom/a/b',
      '/hooks/abc',
      '/livechat/nao-existe',
      '/saml/nao-existe',
      '/oauth/x',
      '/integrations/jira/x',
      '/health/x',
    ];
    for (const p of paths) {
      const r = await rawGet(p);
      if (p.startsWith('/sfu/')) {
        // Casou com a rota do /sfu, que recusa por conta própria (texto); o importante é não ser o index.html.
        expect(r.status, p).toBe(404);
        expect(r.body, p).not.toBe(INDEX);
        continue;
      }
      expectNotFoundJson(r, p);
    }
    // O fetch normaliza %2e%2e: /sfu/%2e%2e/twirp/... vira /twirp/... antes de sair.
    const f = await fetch(urlOf('/sfu/%2e%2e/twirp/livekit.RoomService/ListRooms'));
    expect(f.status).toBe(404);
    expect(await f.json()).toMatchObject({ errorType: 'error-not-found' });
  });

  it('WebSocket em caminho desconhecido, mesmo de rota da SPA, não recebe o index.html', async () => {
    for (const p of ['/twirp/livekit.RoomService/ListRooms', '/sfu/%2e%2e/twirp/livekit.RoomService/ListRooms', '/home', '/channel/geral']) {
      expect(await wsStatus(p), p).toBe(404);
    }
    expectNotFoundJson(await rawGet('/home', { connection: 'Upgrade', upgrade: 'h2c' }), 'upgrade h2c');
  });

  it('nada fora do build sai pelo fallback; %xx malformado não derruba', async () => {
    for (const p of ['/..%2fdist-velho%2fsegredo.txt', '/%2e%2e/dist-velho/segredo.txt', '/assets/..%2f..%2fdist-velho%2fsegredo.txt']) {
      const r = await rawGet(p);
      expect(r.body, p).not.toBe('segredo');
    }
    const bad = await rawGet('/channel/%E0%A4%A');
    expect(bad.status).toBeLessThan(500);
    expect(bad.body).not.toContain('segredo');
  });

  it('isSpaPath: prefixos do servidor fora, rotas do cliente dentro', () => {
    for (const p of ['/api/v1/me', '/API/v1/me', '/twirp/x', '/sfu', '/sfu/rtc', '/sfu/../twirp/x', '/a/../twirp/x', '/sticker/x', '/avatar/x', '/file-upload/x/y', '/hooks/a/b', '/livechat/x', '/emoji-custom/x', '/websocket', '/sfu-webhook', '/health', '/x/%2e%2e/api/v1/me']) {
      expect(isSpaPath(p), p).toBe(false);
    }
    for (const p of ['/', '/home', '/channel/x', '/group/x', '/direct/x', '/live/x', '/admin/stickers', '/admin/calls', '/account/stickers', '/omnichannel/queue', '/calls', '/login', '/invite/abc', '/apiario', '/livechatx', '/stickers']) {
      expect(isSpaPath(p), p).toBe(true);
    }
  });
});
