import http from 'node:http';
import type net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { CallSource } from '@shared/index';
import { joinToken, signJwt } from '../src/calls/livekit';
import { bridgeStats, clientIp, sfuAdmission, useBridgeLogger } from '../src/calls/sfu-bridge';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { newId } from '../src/lib/ids';
import { safeReq, startInternalListener } from '../src/tls';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';
import { startFakeSfu, type FakeSfu } from './sfu-fake';

// A ponte do /sfu e as rotas HTTP do servidor de chamadas, com um LiveKit de mentira (HTTP e WebSocket) na frente
// do falso. Até o callsrv chegar, bridgeAdmission e handleSfuEvent são substituídos; com REAL_ADMISSION=1 valem os
// de verdade, e as vagas são linhas reais no banco nos dois modos.
const stub = vi.hoisted(() => ({
  allowed: new Set<string>(),
  admissions: [] as { identity: string; sfuRoom: string; hidden: boolean }[],
  events: [] as any[],
  slow: false,
  fail: false,
}));
vi.mock('../src/calls/model', async (importOriginal) => {
  const real: any = await importOriginal();
  if (process.env.REAL_ADMISSION) return real;
  return {
    ...real,
    bridgeAdmission: async (o: { identity: string; sfuRoom: string; hidden: boolean }) => {
      stub.admissions.push(o);
      return stub.allowed.has(`${o.identity}|${o.sfuRoom}|${o.hidden}`) ? { ok: true } : { ok: false, status: 403 };
    },
  };
});
vi.mock('../src/calls/presence', async (importOriginal) => {
  if (process.env.REAL_ADMISSION) return importOriginal();
  return {
    handleSfuEvent: async (ev: any) => {
      stub.events.push(ev);
      if (stub.slow) await sleep(3000);
      if (stub.fail) throw new Error('falha de propósito');
    },
  };
});
const REAL = !!process.env.REAL_ADMISSION;

// ---------- LiveKit de mentira: WebSocket e HTTP do /rtc; o Twirp vai para o falso ----------

interface Upstream {
  url: string;
  upgrades: { url: string; headers: http.IncomingHttpHeaders }[];
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[];
  sockets: WebSocket[];
  received: Map<WebSocket, { data: Buffer; isBinary: boolean }[]>;
  closes: Map<WebSocket, { code: number; reason: string }>;
  next(): Promise<WebSocket>;
  close(): Promise<void>;
}

async function startUpstream(fake: FakeSfu): Promise<Upstream> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });
  const waiters: ((w: WebSocket) => void)[] = [];
  const held: net.Socket[] = [];
  const up: Upstream = {
    url: '',
    upgrades: [],
    requests: [],
    sockets: [],
    received: new Map(),
    closes: new Map(),
    next: () => new Promise((r) => waiters.push(r)),
    close: async () => {
      for (const s of held) s.destroy();
      for (const w of up.sockets) w.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = http.createServer((req, res) => {
    up.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const path = (req.url ?? '').split('?')[0];
    if (path.startsWith('/twirp/')) {
      // O Twirp vai para o LiveKit falso, com o token como veio.
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', async () => {
        const r = await fetch(fake.url + req.url, { method: 'POST', headers: { 'content-type': String(req.headers['content-type']), authorization: String(req.headers.authorization) }, body: Buffer.concat(chunks) });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      return;
    }
    if (path === '/' || path === '/rtc/v1/validate' || path === '/rtc/validate') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'set-cookie': 'lk=segredo; Path=/', 'x-livekit': '1' });
      return res.end(path === '/' ? 'OK' : 'success');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 page not found');
  });
  server.on('upgrade', (req, socket, head) => {
    up.upgrades.push({ url: req.url ?? '', headers: req.headers });
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const mode = q.get('stub');
    if (mode === 'refuse404') return socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 29\r\n\r\nrequested room does not exist');
    if (mode === 'slow') return void held.push(socket as net.Socket);
    wss.handleUpgrade(req, socket, head, (w) => {
      up.sockets.push(w);
      up.received.set(w, []);
      w.on('message', (data, isBinary) => up.received.get(w)!.push({ data: Buffer.from(data as Buffer), isBinary }));
      w.on('close', (code, reason) => up.closes.set(w, { code, reason: reason.toString() }));
      w.on('error', () => {});
      waiters.shift()?.(w);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  up.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return up;
}

// ---------- Cliente ----------

type Opened = { ws: WebSocket; status: 101 };
type Refused = { status: number; body: string };
const wsUrl = (path: string) => urlOf(path).replace(/^http/, 'ws');

function open(path: string, o: { headers?: Record<string, string>; maxPayload?: number } = {}): Promise<Opened | Refused> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path), { headers: o.headers, maxPayload: o.maxPayload ?? 64 << 20 });
    ws.on('open', () => resolve({ ws, status: 101 }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on('error', (e) => reject(e));
  });
}
async function opened(path: string, o?: Parameters<typeof open>[1]) {
  const r = await open(path, o);
  if (r.status !== 101) throw new Error(`esperava 101, veio ${r.status} ${(r as Refused).body}`);
  return (r as Opened).ws;
}
const closed = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
const nextMessage = (ws: WebSocket) => new Promise<{ data: Buffer; isBinary: boolean }>((r) => ws.once('message', (data, isBinary) => r({ data: Buffer.from(data as Buffer), isBinary })));

let A: Auth;
let app: FastifyInstance;
let fake: FakeSfu;
let up: Upstream;

async function settings(values: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings: values }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
}

// Uma vaga na chamada: canal com a pessoa, chamada em grupo viva pelo SFU e a linha dela.
let seq = 0;
async function seat(u: Auth, o: { hidden?: boolean; state?: 'joined' | 'joining' | 'left' } = {}) {
  seq++;
  const rid = (await api('POST', 'channels.create', { name: `sfu-${seq}-${Math.random().toString(36).slice(2, 7)}` }, u)).channel._id as string;
  const callId = newId();
  const sfuRoom = `wc_${callId}`;
  const state = o.state ?? 'joined';
  await pool.query(`INSERT INTO calls (id, room_id, caller_id, kind, status, scope, media, sfu_room) VALUES ($1, $2, $3, 'video', 'ongoing', 'group', 'sfu', $4)`, [callId, rid, u.userId, sfuRoom]);
  // A linha concede o mesmo que o token de token(): microfone para quem fala, nada para quem só ouve.
  await pool.query(
    `INSERT INTO call_participants (call_id, user_id, host, state, created_at, token_at, granted_publish, granted_sources, granted_hidden, left_reason)
     VALUES ($1, $2, true, $3, now(), now(), $4, $5, $6, $7)`,
    [callId, u.userId, state, !o.hidden, o.hidden ? [] : ['microphone'], !!o.hidden, state === 'left' ? 'hangup' : null],
  );
  if (state !== 'left') stub.allowed.add(`${u.userId}|${sfuRoom}|${!!o.hidden}`);
  const token = (hidden = !!o.hidden) => joinToken({ room: sfuRoom, identity: u.userId, canPublish: !hidden, sources: hidden ? [] : ['microphone'], hidden }).token;
  return { rid, callId, sfuRoom, token };
}

const rtc = (token: string, extra = '') => `/sfu/rtc/v1?access_token=${encodeURIComponent(token)}${extra}`;

beforeAll(async () => {
  app = await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  fake = await startFakeSfu({ webhookUrl: urlOf('/sfu-webhook') });
  up = await startUpstream(fake);
  await settings({ Calls_SFU_Url: up.url, Calls_SFU_Api_Key: fake.key, Calls_SFU_Api_Secret: fake.secret });
});
afterAll(async () => {
  await up?.close();
  await fake?.stop();
  await stopServer();
});

describe('ponte do /sfu', () => {
  it('ponte recusa sem token, token inválido, grant proibido e linha recusada antes de abrir o upstream (401, 403)', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const before = up.upgrades.length;
    const now = Math.floor(Date.now() / 1000);
    const claims = (video: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ iss: fake.key, sub: u.userId, nbf: now - 5, exp: now + 60, video: { roomJoin: true, room: s.sfuRoom, canPublish: true, canSubscribe: true, ...video }, ...extra });

    expect(await open('/sfu/rtc/v1')).toMatchObject({ status: 401, body: 'acesso recusado' });
    expect(await open('/sfu/rtc/v1?access_token=')).toMatchObject({ status: 401 });
    expect(await open(rtc('lixo'))).toMatchObject({ status: 401 });
    expect(await open(rtc(signJwt(claims({}), 'outro-segredo')))).toMatchObject({ status: 401 });
    expect(await open(rtc(signJwt(claims({}, { iss: 'APIoutra' }), fake.secret)))).toMatchObject({ status: 401 });
    expect(await open(rtc(signJwt(claims({}, { exp: now - 1 }), fake.secret)))).toMatchObject({ status: 401 });
    for (const g of ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'canPublishData', 'canUpdateOwnMetadata', 'agent', 'recorder']) {
      expect(await open(rtc(signJwt(claims({ [g]: true }), fake.secret)))).toMatchObject({ status: 403, body: 'acesso recusado' });
    }
    expect(await open(rtc(signJwt(claims({ room: 'loadtest1' }), fake.secret)))).toMatchObject({ status: 403 });
    // Linha recusada: hidden diferente do concedido, outra pessoa com o token de outra sala, quem já saiu.
    expect(await open(rtc(s.token(true)))).toMatchObject({ status: 403 });
    const other = await newUser(A);
    expect(await open(rtc(joinToken({ room: s.sfuRoom, identity: other.userId, canPublish: true, sources: ['microphone'], hidden: false }).token))).toMatchObject({ status: 403 });
    const gone = await seat(other, { state: 'left' });
    expect(await open(rtc(gone.token()))).toMatchObject({ status: 403 });
    if (!REAL) expect(stub.admissions).toContainEqual({ identity: other.userId, sfuRoom: gone.sfuRoom, hidden: false });
    // Nada disso chegou ao LiveKit.
    expect(up.upgrades.length).toBe(before);
    expect(bridgeStats().refusedLastMinute).toBeGreaterThanOrEqual(15);

    // Autoteste: pessoa ativa e token curto bastam (o nosso, de 5 min, ou o de 10 min que o LiveKit renova e a
    // retomada usa); token mais longo ou pessoa desativada, não.
    const testRoom = `wc_test_${newId()}`;
    const ok = await opened(rtc(joinToken({ room: testRoom, identity: u.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: 300 }).token));
    ok.close();
    const renewed = await opened(rtc(signJwt({ iss: fake.key, sub: u.userId, nbf: now, exp: now + 600, video: { roomJoin: true, room: testRoom, canPublish: true, canPublishData: false } }, fake.secret)));
    renewed.close();
    expect(await open(rtc(joinToken({ room: testRoom, identity: u.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: 3600 }).token))).toMatchObject({ status: 403 });
    expect(await open(rtc(signJwt({ iss: fake.key, sub: u.userId, exp: now + 600, video: { roomJoin: true, room: testRoom, canPublish: true, canPublishData: false } }, fake.secret)))).toMatchObject({ status: 403 }); // sem nbf
    await pool.query('UPDATE users SET active = false WHERE id = $1', [other.userId]);
    expect(await open(rtc(joinToken({ room: testRoom, identity: other.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: 300 }).token))).toMatchObject({ status: 403 });

    // A vaga certa passa e chega ao LiveKit.
    const pending = up.next();
    const ws = await opened(rtc(s.token()));
    await pending;
    expect(up.upgrades.length).toBe(before + 3);
    ws.close();

    // Linha recusada também quando o token publica mais do que a linha concede agora: um token de antes da pausa da
    // trava ou do bloqueio da tela (o primeiro, ou um renovado pelo LiveKit antes da mudança) não reabre a publicação.
    const p = await newUser(A);
    const ps = await seat(p);
    const grant = (canPublish: boolean, sources: CallSource[] | null) => joinToken({ room: ps.sfuRoom, identity: p.userId, canPublish, sources, hidden: false }).token;
    const at = up.upgrades.length;
    expect(await open(rtc(grant(true, ['microphone', 'camera'])))).toMatchObject({ status: 403, body: 'acesso recusado' });
    expect(await open(rtc(grant(true, null)))).toMatchObject({ status: 403 }); // sem lista: todas as fontes
    // canPublish ausente: o LiveKit entende que publica.
    expect(await open(rtc(signJwt({ iss: fake.key, sub: p.userId, nbf: now - 5, exp: now + 60, video: { roomJoin: true, room: ps.sfuRoom, canPublishData: false, canPublishSources: ['camera'] } }, fake.secret)))).toMatchObject({ status: 403 });
    await pool.query(`UPDATE call_participants SET granted_publish = false, granted_sources = '{}' WHERE call_id = $1 AND user_id = $2`, [ps.callId, p.userId]);
    expect(await open(rtc(grant(true, ['microphone'])))).toMatchObject({ status: 403 });
    expect((await fetch(urlOf(`/sfu/rtc/v1/validate?access_token=${grant(true, ['microphone'])}`))).status).toBe(403);
    expect(up.upgrades.length).toBe(at);
    // Sem publicar (o token que o LiveKit manda depois da pausa) entra; e, com a linha de volta, menos fontes também.
    const quiet = await opened(rtc(grant(false, [])));
    quiet.close();
    await pool.query(`UPDATE call_participants SET granted_publish = true, granted_sources = '{microphone,camera,screen_share}' WHERE call_id = $1 AND user_id = $2`, [ps.callId, p.userId]);
    const fewer = await opened(rtc(grant(true, ['camera', 'microphone'])));
    fewer.close();
    expect(await open(rtc(grant(true, ['microphone', 'screen_share_audio'])))).toMatchObject({ status: 403 });
    expect(up.upgrades.length).toBe(at + 2);
  });

  it('mais de 4 pontes por pessoa ou 50 por IP dá 429; o IP do X-Forwarded-For só vale com proxy confiável', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const mine: WebSocket[] = [];
    for (let i = 0; i < 4; i++) mine.push(await opened(rtc(s.token())));
    expect(await open(rtc(s.token()))).toMatchObject({ status: 429, body: 'acesso recusado' });
    mine.pop()!.close();
    // A vaga volta quando os dois lados fecham.
    await vi.waitFor(async () => {
      const r = await open(rtc(s.token()));
      if (r.status === 101) mine.push((r as Opened).ws);
      expect(r.status).toBe(101);
    }, { timeout: 3000, interval: 100 });
    for (const w of mine) w.close();

    // 50 por IP: com TRUST_PROXY padrão (sem HTTPS próprio, true) o X-Forwarded-For conta.
    const people = await Promise.all(Array.from({ length: 13 }, () => newUser(A)));
    const seats = await Promise.all(people.map((p) => seat(p)));
    // Pessoa sem nenhuma ponte, para o limite por pessoa não se misturar com o por IP.
    const free = await seat(await newUser(A));
    const fromIp = (ip: string) => ({ headers: { 'x-forwarded-for': `${ip}, 127.0.0.1` } });
    const all: WebSocket[] = [];
    for (let i = 0; i < 50; i++) all.push(await opened(rtc(seats[i % 13].token()), fromIp('10.9.9.9')));
    expect(await open(rtc(seats[12].token()), fromIp('10.9.9.9'))).toMatchObject({ status: 429 });
    const other = await opened(rtc(seats[12].token()), fromIp('10.9.9.8'));
    other.close();
    await closed(other);
    const saved = config.trustProxy;
    try {
      // Sem proxy confiável, o cabeçalho não vale: quem conta é o socket (127.0.0.1), que ainda tem vaga.
      config.trustProxy = false;
      expect(clientIp('127.0.0.1', '10.9.9.9')).toBe('127.0.0.1');
      const viaSocket = await opened(rtc(free.token()), fromIp('10.9.9.9'));
      viaSocket.close();
      await closed(viaSocket);
      config.trustProxy = ['10.0.0.0/8'];
      expect(clientIp('::ffff:127.0.0.1', '10.9.9.9')).toBe('127.0.0.1');
      config.trustProxy = ['loopback'];
      expect(clientIp('::ffff:127.0.0.1', '10.9.9.9')).toBe('10.9.9.9');
      expect(await open(rtc(free.token()), fromIp('10.9.9.9'))).toMatchObject({ status: 429 });
      // Da direita para a esquerda, até o primeiro endereço que não é proxy confiável (como o req.ip do Fastify).
      config.trustProxy = ['127.0.0.1', '10.0.0.0/255.0.0.0'];
      expect(clientIp('127.0.0.1', '203.0.113.7, 10.1.1.1')).toBe('203.0.113.7');
      expect(clientIp('127.0.0.1', '1.1.1.1, 203.0.113.7, 10.1.1.1')).toBe('203.0.113.7');
      expect(clientIp('192.168.0.9', '203.0.113.7')).toBe('192.168.0.9');
      config.trustProxy = true;
      expect(clientIp('192.168.0.9', '203.0.113.7, 10.1.1.1')).toBe('203.0.113.7');
      expect(clientIp('192.168.0.9', 'lixo')).toBe('192.168.0.9');
    } finally {
      config.trustProxy = saved;
    }
    for (const w of all) w.close();
    await vi.waitFor(() => expect(bridgeStats().open).toBe(0), { timeout: 5000 });
  });

  it('caminhos fora da lista, como /sfu/twirp/livekit.RoomService/ListRooms, dão 404', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const before = { upgrades: up.upgrades.length, twirp: up.requests.filter((r) => r.url.startsWith('/twirp/')).length };
    for (const p of ['/sfu/twirp/livekit.RoomService/ListRooms', '/sfu', '/sfu/', '/sfu/rtc/v2', '/sfu/rtc/v1/validate', '/sfu/rtc/v1/x', '/sfu/%2e%2e/twirp/livekit.RoomService/ListRooms', '/sfu/rtc/../twirp']) {
      expect(await open(`${p}?access_token=${s.token()}`), p).toMatchObject({ status: 404 });
    }
    for (const p of ['/sfu/twirp/livekit.RoomService/ListRooms', '/sfu/rtc/v1', '/sfu/rtc', '/sfu/metrics', '/sfu/rtc/v1/validate/x']) {
      const r = await fetch(urlOf(p));
      expect(r.status, p).toBe(404);
    }
    const post = await fetch(urlOf('/sfu/twirp/livekit.RoomService/ListRooms'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(404);
    expect(up.upgrades.length).toBe(before.upgrades);
    expect(up.requests.filter((r) => r.url.startsWith('/twirp/')).length).toBe(before.twirp);
    // O /websocket do chat continua no @fastify/websocket.
    const chat = connectWs(A);
    await chat.ready;
    chat.close();
  });

  it('WebSocket pela ponte: binário e texto nos dois sentidos, consulta de 12 KB repassada, códigos de fechamento propagados nos dois lados (1000, 1011, 1013, 4000+)', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const joinRequest = Buffer.alloc(9000, 7).toString('base64url'); // 12 KB, como a oferta SDP compactada
    const query = `access_token=${s.token()}&join_request=${joinRequest}&auto_subscribe=1&sdk=js&version=2.22.3&protocol=16`;
    expect(query.length).toBeGreaterThan(12_000);
    const pending = up.next();
    const ws = await opened(`/sfu/rtc/v1?${query}`, { headers: { cookie: 'rc_token=segredo-do-chat', authorization: 'Bearer segredo-do-chat', 'x-auth-token': 'segredo-do-chat', 'user-agent': 'NavegadorDeTeste/1.0' } });
    const lk = await pending;
    const seen = up.upgrades[up.upgrades.length - 1];
    expect(seen.url).toBe(`/rtc/v1?${query}`);
    expect(seen.headers['user-agent']).toBe('NavegadorDeTeste/1.0');
    for (const h of ['cookie', 'authorization', 'x-auth-token', 'x-forwarded-for', 'origin']) expect(seen.headers).not.toHaveProperty(h);

    ws.send('olá, LiveKit');
    ws.send(Buffer.from([1, 2, 3, 250]));
    await vi.waitFor(() => expect(up.received.get(lk)!.length).toBe(2));
    expect(up.received.get(lk)).toEqual([
      { data: Buffer.from('olá, LiveKit'), isBinary: false },
      { data: Buffer.from([1, 2, 3, 250]), isBinary: true },
    ]);
    let m = nextMessage(ws);
    lk.send('do LiveKit');
    expect(await m).toEqual({ data: Buffer.from('do LiveKit'), isBinary: false });
    m = nextMessage(ws);
    lk.send(Buffer.from([9, 8, 7]));
    expect(await m).toEqual({ data: Buffer.from([9, 8, 7]), isBinary: true });

    // Fechamento pelo cliente chega ao LiveKit com o mesmo código e motivo.
    const c1 = closed(lk);
    ws.close(4001, 'motivo do cliente');
    expect(await c1).toEqual({ code: 4001, reason: 'motivo do cliente' });
    await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));

    // Fechamento pelo LiveKit chega ao cliente: 1000, 1011, 1013 e 4000+ como vieram; queda sem código vira 1011.
    for (const code of [1000, 1011, 1013, 4404]) {
      const p = up.next();
      const w = await opened(rtc(s.token()));
      const l = await p;
      const c = closed(w);
      l.close(code, `código ${code}`);
      expect(await c).toEqual({ code, reason: `código ${code}` });
    }
    const p2 = up.next();
    const w2 = await opened(rtc(s.token()));
    const l2 = await p2;
    const c2 = closed(w2);
    l2.terminate();
    expect((await c2).code).toBe(1011);
    // E o LiveKit vê 1011 quando o cliente cai sem fechar.
    const p3 = up.next();
    const w3 = await opened(rtc(s.token()));
    const l3 = await p3;
    const c3 = closed(l3);
    w3.terminate();
    expect((await c3).code).toBe(1011);
  });

  it('quadro de 300 KB passa no /sfu; no /websocket do chat acima de 64 KB fecha com 1009', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const pending = up.next();
    const ws = await opened(rtc(s.token()));
    const lk = await pending;
    const big = Buffer.alloc(300 * 1024, 5);
    ws.send(big);
    await vi.waitFor(() => expect(up.received.get(lk)!.length).toBe(1));
    expect(up.received.get(lk)![0].data.equals(big)).toBe(true);
    const m = nextMessage(ws);
    lk.send(big);
    expect((await m).data.length).toBe(big.length);
    // Acima de 1 MiB do navegador: 1009 para o cliente e o fechamento chega ao LiveKit.
    const c = closed(ws);
    const cl = closed(lk);
    ws.send(Buffer.alloc((1 << 20) + 1));
    expect((await c).code).toBe(1009);
    expect((await cl).code).toBe(1009);

    const chat = connectWs(A);
    await chat.ready;
    const cc = closed(chat.ws);
    chat.ws.send(Buffer.alloc(100 * 1024, 65));
    expect((await cc).code).toBe(1009);
  });

  it('upstream lento demais ou com buffer acima de 8 MiB fecha os dois lados', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    // O LiveKit não responde ao upgrade: 502 depois de 10 s, e a vaga volta.
    const t0 = Date.now();
    expect(await open(rtc(s.token(), '&stub=slow'))).toMatchObject({ status: 502, body: 'Servidor de chamadas indisponível.' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_500);
    await vi.waitFor(() => expect(bridgeStats().open).toBe(0));

    // O LiveKit para de ler: o buffer da ponte passa de 8 MiB e os dois lados fecham com 1013.
    const pending = up.next();
    const ws = await opened(rtc(s.token()));
    const lk = await pending;
    (lk as any)._socket.pause();
    const c = closed(ws);
    const cl = closed(lk);
    const chunk = Buffer.alloc(1_000_000, 1);
    for (let i = 0; i < 60 && ws.readyState === WebSocket.OPEN; i++) {
      ws.send(chunk);
      await sleep(5);
    }
    expect((await c).code).toBe(1013);
    (lk as any)._socket.resume();
    await cl;
    await vi.waitFor(() => expect(bridgeStats().open).toBe(0), { timeout: 5000 });
  }, 40_000);

  it('recusa do upstream (sala inexistente) chega ao cliente com o mesmo status', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    expect(await open(rtc(s.token(), '&stub=refuse404'))).toEqual({ status: 404, body: 'requested room does not exist' });
    await vi.waitFor(() => expect(bridgeStats().open).toBe(0));
    // LiveKit fora do ar: 502.
    await settings({ Calls_SFU_Url: 'http://127.0.0.1:9' });
    try {
      expect(await open(rtc(s.token()))).toMatchObject({ status: 502, body: 'Servidor de chamadas indisponível.' });
    } finally {
      await settings({ Calls_SFU_Url: up.url });
    }
  });
});

describe('rotas HTTP do servidor de chamadas', () => {
  it('proxy HTTP: /sfu e /sfu/rtc/v1/validate repassam status e corpo, sem cookies e sem set-cookie; validate aplica a mesma admissão', async () => {
    const u = await newUser(A);
    const s = await seat(u);
    const secretHeaders = { cookie: 'rc_uid=x; rc_token=segredo-do-chat', authorization: 'Bearer segredo-do-chat', 'x-auth-token': 'segredo-do-chat', 'x-user-id': u.userId, accept: 'text/plain', 'user-agent': 'NavegadorDeTeste/1.0' };
    for (const p of ['/sfu', '/sfu/']) {
      const r = await fetch(urlOf(p), { headers: secretHeaders });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('OK');
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(r.headers.get('x-livekit')).toBeNull();
      expect(r.headers.get('content-type')).toContain('text/plain');
    }
    const head = await fetch(urlOf('/sfu'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    for (const p of ['/sfu/rtc/v1/validate', '/sfu/rtc/validate']) {
      const n = up.requests.length;
      const r = await fetch(urlOf(`${p}?access_token=${s.token()}&join_request=abc`), { headers: secretHeaders });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('success');
      expect(r.headers.get('set-cookie')).toBeNull();
      const seen = up.requests[n];
      expect(seen.url).toBe(`${p.replace('/sfu', '')}?access_token=${s.token().length ? seen.url.split('access_token=')[1].split('&')[0] : ''}&join_request=abc`);
      expect(seen.headers['user-agent']).toBe('NavegadorDeTeste/1.0');
      expect(seen.headers.accept).toBe('text/plain');
      for (const h of ['cookie', 'authorization', 'x-auth-token', 'x-user-id']) expect(seen.headers).not.toHaveProperty(h);
    }
    // A mesma admissão da ponte, sem chegar ao LiveKit.
    const n = up.requests.length;
    expect((await fetch(urlOf('/sfu/rtc/v1/validate'))).status).toBe(401);
    const bad = await fetch(urlOf('/sfu/rtc/v1/validate?access_token=lixo'));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toBe('acesso recusado');
    const now = Math.floor(Date.now() / 1000);
    const admin = signJwt({ iss: fake.key, sub: u.userId, nbf: now, exp: now + 60, video: { roomJoin: true, room: s.sfuRoom, roomAdmin: true } }, fake.secret);
    expect((await fetch(urlOf(`/sfu/rtc/validate?access_token=${admin}`))).status).toBe(403);
    expect((await fetch(urlOf(`/sfu/rtc/v1/validate?access_token=${s.token(true)}`))).status).toBe(403);
    expect(up.requests.length).toBe(n);
    const four: WebSocket[] = [];
    for (let i = 0; i < 4; i++) four.push(await opened(rtc(s.token())));
    expect((await fetch(urlOf(`/sfu/rtc/v1/validate?access_token=${s.token()}`))).status).toBe(429);
    for (const w of four) w.close();
    await vi.waitFor(() => expect(bridgeStats().open).toBe(0));
    // LiveKit fora do ar.
    await settings({ Calls_SFU_Url: 'http://127.0.0.1:9' });
    try {
      const down = await fetch(urlOf('/sfu'));
      expect(down.status).toBe(502);
      expect(await down.text()).toBe('Servidor de chamadas indisponível.');
    } finally {
      await settings({ Calls_SFU_Url: up.url });
    }
  });

  it('webhook: assinatura válida responde 200 na hora e chega ao handleSfuEvent; inválida dá 401', async () => {
    stub.events.length = 0;
    // O LiveKit falso cria a sala e manda room_started assinado para o chat.
    const res = await fetch(`${up.url}/twirp/livekit.RoomService/CreateRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signJwt({ iss: fake.key, nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, video: { roomCreate: true } }, fake.secret)}` },
      body: JSON.stringify({ name: 'wc_webhook1', emptyTimeout: 60 }),
    });
    expect(res.status).toBe(200);
    if (!REAL) {
      await vi.waitFor(() => expect(stub.events.map((e) => e.event)).toContain('room_started'));
      expect(stub.events.find((e) => e.event === 'room_started')).toMatchObject({ room: { name: 'wc_webhook1' }, id: expect.stringMatching(/^EV_/) });
    }

    const body = JSON.stringify({ event: 'participant_joined', room: { sid: 'RM_a', name: 'wc_webhook1' }, participant: { sid: 'PA_a', identity: 'u1' }, id: `EV_${newId()}`, createdAt: String(Math.floor(Date.now() / 1000)) });
    const { createHash } = await import('node:crypto');
    const sig = (b: string, secret = fake.secret) => signJwt({ iss: fake.key, nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, sha256: createHash('sha256').update(b).digest('base64') }, secret);
    const post = (b: string, auth: string | null, type = 'application/webhook+json', url = urlOf('/sfu-webhook')) =>
      fetch(url, { method: 'POST', headers: { 'content-type': type, ...(auth ? { authorization: auth } : {}) }, body: b });

    // Responde antes do processamento, mesmo quando ele demora ou falha.
    stub.slow = true;
    const t0 = Date.now();
    const okRes = await post(body, sig(body));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ success: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    stub.slow = false;
    if (!REAL) await vi.waitFor(() => expect(stub.events.some((e) => e.event === 'participant_joined' && e.participant.identity === 'u1')).toBe(true));
    stub.fail = true;
    expect((await post(body, sig(body))).status).toBe(200);
    stub.fail = false;

    for (const [b, auth, type] of [
      [body, null, undefined],
      [body, 'Bearer lixo', undefined],
      [body + ' ', sig(body), undefined],
      [body, sig(body, 'outro-segredo'), undefined],
      [body, sig(body), 'application/json'],
    ] as [string, string | null, string | undefined][]) {
      const r = await post(b, auth, type);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ success: false });
    }
    const huge = JSON.stringify({ event: 'x', pad: 'a'.repeat(70 * 1024) });
    expect((await post(huge, sig(huge))).status).toBe(413);

    // Com HTTPS próprio o LiveKit posta no ouvinte interno (127.0.0.1), que repassa para a mesma rota.
    const internal = startInternalListener(app, 0, () => {});
    await new Promise((r) => internal.once('listening', r));
    const iurl = `http://127.0.0.1:${(internal.address() as net.AddressInfo).port}/sfu-webhook`;
    try {
      const r = await post(body, sig(body), undefined, iurl);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ success: true });
      expect((await post(body, 'Bearer lixo', undefined, iurl)).status).toBe(401);
      expect((await fetch(iurl.replace('/sfu-webhook', '/api/v1/info'))).status).toBe(404);
    } finally {
      await new Promise<void>((r) => internal.close(() => r()));
    }
    await fetch(`${up.url}/twirp/livekit.RoomService/DeleteRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signJwt({ iss: fake.key, exp: Math.floor(Date.now() / 1000) + 60, video: { roomCreate: true } }, fake.secret)}` },
      body: JSON.stringify({ room: 'wc_webhook1' }),
    });
  });

  it('calls.sfu.status só com manage-calls e nunca traz o segredo; calls.selfTest cria sala wc_test_ e devolve token sem fontes', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'calls.sfu.status', undefined, u)).status).toBe(403);
    const st = await api('GET', 'calls.sfu.status', undefined, A);
    expect(st).toMatchObject({
      success: true,
      configured: true,
      reachable: true,
      latencyMs: expect.any(Number),
      url: up.url,
      urlFromEnv: false,
      groupEnabled: expect.any(Boolean),
      directViaSfu: false,
      tls: { enabled: false },
      secure: false,
      bridges: { open: expect.any(Number), refusedLastMinute: expect.any(Number) },
      present: expect.any(Number),
      maxPresent: 150,
    });
    const text = JSON.stringify(st);
    expect(text).not.toContain(fake.secret);
    expect(text).not.toContain(fake.key);

    const r = await api('POST', 'calls.selfTest', {}, u);
    expect(r.success).toBe(true);
    const claims = JSON.parse(Buffer.from(r.token.split('.')[1], 'base64url').toString());
    expect(claims.sub).toBe(u.userId);
    expect(claims.video.room).toMatch(/^wc_test_[A-Za-z0-9]+$/);
    expect(claims.video).not.toHaveProperty('canPublishSources');
    expect(claims.video).toMatchObject({ roomJoin: true, canPublish: true, canPublishData: false, canUpdateOwnMetadata: false, hidden: false });
    expect(claims.exp - claims.nbf).toBe(305);
    expect(new Date(r.expiresAt).getTime()).toBe(claims.exp * 1000);
    expect(fake.rooms.get(claims.video.room)?.options).toEqual({ emptyTimeout: 60, departureTimeout: 10, maxParticipants: 3 });
    // O token abre a ponte e o validate (sem linha de participante).
    const ws = await opened(rtc(r.token));
    ws.close();
    expect((await fetch(urlOf(`/sfu/rtc/v1/validate?access_token=${r.token}`))).status).toBe(200);

    // Em chamada: 409 com o texto do autoteste.
    const busy = await newUser(A);
    await seat(busy);
    expect(await api('POST', 'calls.selfTest', {}, busy)).toMatchObject({ status: 409, errorType: 'error-call-in-progress', error: 'Saia da chamada para testar a conexão.' });
    // Limite de 3 por minuto, com o limitador ligado.
    const rl = await newUser(A);
    await settings({ API_Enable_Rate_Limiter: true });
    try {
      for (let i = 0; i < 3; i++) expect((await api('POST', 'calls.selfTest', {}, rl)).success).toBe(true);
      expect(await api('POST', 'calls.selfTest', {}, rl)).toMatchObject({ status: 429, errorType: 'error-call-rate-limit' });
    } finally {
      await settings({ API_Enable_Rate_Limiter: false });
    }
    // Chamadas desligadas e servidor de chamadas não configurado.
    await settings({ Calls_Enabled: false });
    try {
      expect(await api('POST', 'calls.selfTest', {}, u)).toMatchObject({ status: 403, error: 'As chamadas estão desativadas.' });
    } finally {
      await settings({ Calls_Enabled: true });
    }
    await settings({ Calls_SFU_Api_Secret: '' });
    try {
      expect(await api('POST', 'calls.selfTest', {}, u)).toMatchObject({ status: 503, errorType: 'error-call-sfu-not-configured' });
      expect(await api('GET', 'calls.sfu.status', undefined, A)).toMatchObject({ configured: false, reachable: false, error: 'Servidor de chamadas não configurado.' });
    } finally {
      await settings({ Calls_SFU_Api_Secret: fake.secret });
    }
    expect((await api('POST', 'calls.selfTest', {}, undefined)).status).toBe(401);
  });

  it('o log da ponte e das rotas /sfu não contém access_token nem join_request', async () => {
    const lines: unknown[] = [];
    const capture = (level: string) => (o: object, m: string) => lines.push({ level, o, m });
    useBridgeLogger({ info: capture('info'), debug: capture('debug'), warn: capture('warn') });
    try {
      const u = await newUser(A);
      const s = await seat(u);
      const token = s.token();
      const join = `segredo-da-oferta-${newId()}`;
      expect(await open(rtc(token, `&join_request=${join}&stub=refuse404`))).toMatchObject({ status: 404 });
      expect(await open(rtc(s.token(true), `&join_request=${join}`))).toMatchObject({ status: 403 });
      const ws = await opened(rtc(token, `&join_request=${join}`));
      const c = closed(ws);
      ws.close(4000);
      await c;
      await vi.waitFor(() => expect(lines.some((l: any) => l.level === 'debug')).toBe(true));
      await fetch(urlOf(`/sfu/rtc/v1/validate?access_token=lixo&join_request=${join}`));
      const text = JSON.stringify(lines);
      expect(text).not.toContain(token);
      expect(text).not.toContain(join);
      expect(text).not.toContain('access_token');
      expect(text).not.toContain('join_request');
      expect(lines).toContainEqual({ level: 'info', o: { identity: u.userId, room: s.sfuRoom, ip: '127.0.0.1', status: 403 }, m: expect.any(String) });
      expect(lines).toContainEqual({ level: 'debug', o: { identity: u.userId, room: s.sfuRoom, durationMs: expect.any(Number), code: 4000 }, m: expect.any(String) });
      // O log das requisições do Fastify passa pelo safeReq; as rotas /sfu nem registram as requisições comuns (nível warn).
      const logged = safeReq({ method: 'GET', url: `/sfu/rtc/v1/validate?access_token=${token}&join_request=${join}`, hostname: 'chat', ip: '10.0.0.1', socket: { remotePort: 1 } } as any);
      expect(JSON.stringify(logged)).not.toContain(token);
      expect(JSON.stringify(logged)).not.toContain(join);
      const routes = app.printRoutes({ commonPrefix: false, includeHooks: false });
      expect(routes).toContain('/sfu');
    } finally {
      useBridgeLogger(app.log);
    }
  });
});

describe('recusas em massa', () => {
  it('recusas em massa custam o mesmo com a janela de 60 s cheia, o log não registra cada uma e a contagem esquece depois de 60 s', async () => {
    const lines: { level: string; o: any; m: string }[] = [];
    const capture = (level: string) => (o: object, m: string) => lines.push({ level, o, m });
    useBridgeLogger({ info: capture('info'), debug: capture('debug'), warn: capture('warn') });
    // Token lixo, antes de qualquer consulta: é o caminho de quem inunda sem conta.
    const batch = async (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await sfuAdmission('lixo', '203.0.113.9');
      return performance.now() - t0;
    };
    // Um segundo só para a enxurrada, longe das recusas dos outros testes.
    const at = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const first = await batch(2000);
      await batch(40_000);
      const last = await batch(2000);
      expect(bridgeStats().refusedLastMinute).toBe(44_000);
      // Custo fixo por recusa: o último lote, com 42 mil na janela, custa o mesmo que o primeiro (folga para a máquina).
      expect(last).toBeLessThan(first * 5 + 50);
      // 20 linhas no segundo e um aviso quando o resto deixa de ser registrado uma a uma.
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(20);
      expect(lines[0]).toEqual({ level: 'info', o: { identity: null, room: null, ip: '203.0.113.9', status: 401 }, m: expect.any(String) });
      expect(lines.filter((l) => l.level === 'warn')).toEqual([{ level: 'warn', o: { ip: '203.0.113.9', status: 401 }, m: expect.any(String) }]);
      expect(JSON.stringify(lines)).not.toContain('lixo');
      // Um minuto depois nada disso conta mais.
      clock.mockReturnValue(at + 61_000);
      expect(bridgeStats().refusedLastMinute).toBe(0);
      await sfuAdmission(null, '203.0.113.9');
      expect(bridgeStats().refusedLastMinute).toBe(1);
    } finally {
      clock.mockRestore();
      useBridgeLogger(app.log);
    }
  }, 120_000);
});
