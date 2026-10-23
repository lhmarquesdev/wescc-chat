import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { joinToken, parseJoinClaims, sfu, signJwt, verifyJwt } from '../src/calls/livekit';
import { pool } from '../src/db/pool';
import { newId } from '../src/lib/ids';
import { admin, api, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';
import { startFakeSfu, type FakeSfu } from './sfu-fake';

// O LiveKit de verdade (a versão fixada em PINS.md), com a configuração renderizada como na instalação, portas livres
// e chave e segredo aleatórios. Os participantes reais vêm do lk; os de sinalização crua falam o protobuf do /rtc.
// bridgeAdmission e handleSfuEvent seguem o sfu-proxy: substituídos, ou os de verdade com REAL_ADMISSION=1.
const LIVEKIT_BIN = process.env.LIVEKIT_BIN;
const LK_BIN = process.env.LK_BIN;
const REAL = !!process.env.REAL_ADMISSION;
const SKIP_LIVEKIT = 'LIVEKIT_BIN não definido: teste com LiveKit real ignorado';
const SKIP_LK = 'LK_BIN não definido: testes com participante real ignorados';

const stub = vi.hoisted(() => ({
  allowed: new Set<string>(),
  events: [] as any[],
}));
vi.mock('../src/calls/model', async (importOriginal) => {
  const real: any = await importOriginal();
  if (process.env.REAL_ADMISSION) return real;
  return {
    ...real,
    bridgeAdmission: async (o: { identity: string; sfuRoom: string; hidden: boolean }) =>
      stub.allowed.has(`${o.identity}|${o.sfuRoom}|${o.hidden}`) ? { ok: true } : { ok: false, status: 403 },
  };
});
// Os eventos ficam registrados nos dois modos; com REAL_ADMISSION seguem para o código do callsrv.
vi.mock('../src/calls/presence', async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    handleSfuEvent: async (ev: any) => {
      stub.events.push(ev);
      if (process.env.REAL_ADMISSION) await real.handleSfuEvent(ev);
    },
  };
});

// ---------- protobuf mínimo da sinalização (SignalRequest / SignalResponse) ----------

const varint = (n: number | bigint) => {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const field = (no: number, wire: 0 | 2, payload: Buffer) => Buffer.concat([varint((no << 3) | wire), wire === 2 ? Buffer.concat([varint(payload.length), payload]) : payload]);
const text = (no: number, s: string) => field(no, 2, Buffer.from(s));
const message = (no: number, ...parts: Buffer[]) => field(no, 2, Buffer.concat(parts));
type Field = { no: number; v?: bigint; b?: Buffer };
function decode(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const rv = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      s += 7n;
      if (!(b & 0x80)) return r;
    }
  };
  while (i < buf.length) {
    const tag = Number(rv());
    const no = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ no, v: rv() });
    else if (wire === 2) {
      const n = Number(rv());
      out.push({ no, b: buf.subarray(i, i + n) });
      i += n;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return out;
}
const sub = (f: Field[], no: number) => f.find((x) => x.no === no);
const str = (f: Field[], no: number) => sub(f, no)?.b?.toString() ?? '';
const num = (f: Field[], no: number) => Number(sub(f, no)?.v ?? 0);

// SignalRequest: update_metadata = 15 { metadata 1, name 2, attributes 3 (mapa), request_id 4 }; leave = 8 { reason 2 }.
const updateMetadata = (requestId: number) =>
  message(15, text(1, 'metadados livres'), text(2, 'Nome trocado'), message(3, text(1, 'canal'), text(2, 'escondido')), field(4, 0, varint(requestId)));
const leaveRequest = (reason: number) => message(8, field(2, 0, varint(reason)));
// SignalResponse: join 1, leave 8, refresh_token 16, request_response 22. DisconnectReason: 1 CLIENT_INITIATED,
// 2 DUPLICATE_IDENTITY, 4 PARTICIPANT_REMOVED. RequestResponse.reason 2 = NOT_ALLOWED.
const SIG = { join: 1, leave: 8, refreshToken: 16, requestResponse: 22 };
// /rtc/v1: o livekit-client manda o JoinRequest no join_request (WrappedJoinRequest { compression 1, join_request 2 },
// em base64 com + e / trocados). JoinRequest: client_info 1 { sdk 1 (JS = 1), version 2, protocol 3, client_protocol 12 },
// connection_settings 2 { auto_subscribe 1 }, metadata 3, participant_attributes 4 (mapa).
function joinRequest(o: { metadata?: string; attributes?: Record<string, string>; gzip?: boolean } = {}) {
  const parts = [message(1, field(1, 0, varint(1)), text(2, '2.22.3'), field(3, 0, varint(16)), field(12, 0, varint(1))), message(2, field(1, 0, varint(1)))];
  if (o.metadata !== undefined) parts.push(text(3, o.metadata));
  for (const [k, v] of Object.entries(o.attributes ?? {})) parts.push(message(4, text(1, k), text(2, v)));
  const raw = Buffer.concat(parts);
  const wrapped = Buffer.concat([field(1, 0, varint(o.gzip ? 1 : 0)), field(2, 2, o.gzip ? zlib.gzipSync(raw) : raw)]);
  return encodeURIComponent(wrapped.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
}

interface Signal {
  ws: WebSocket;
  frames: Field[][];
  closed: Promise<{ code: number }>;
  next(no: number, timeoutMs?: number): Promise<Buffer>; // o conteúdo do primeiro campo com esse número
  send(b: Buffer): void;
  close(): void;
}
type Refused = { refused: number; body: string };

// Uma conexão de sinalização como a do livekit-client, sem WebRTC: basta para entrar, receber e mandar pedidos.
function signal(url: string): Promise<Signal | Refused> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 8 << 20 });
    const frames: Field[][] = [];
    const waiters: { no: number; resolve: (b: Buffer) => void }[] = [];
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(field(14, 0, varint(Date.now()))), 4000);
    const closed = new Promise<{ code: number }>((r) => ws.once('close', (code) => r({ code })));
    void closed.then(() => clearInterval(ping));
    ws.on('message', (d: Buffer) => {
      const f = decode(Buffer.from(d));
      frames.push(f);
      for (const w of [...waiters]) {
        const hit = sub(f, w.no);
        if (hit) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(hit.b ?? Buffer.alloc(0));
        }
      }
    });
    ws.on('unexpected-response', (_q, res) => {
      clearInterval(ping);
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ refused: res.statusCode ?? 0, body }));
    });
    ws.on('error', (e) => {
      clearInterval(ping);
      reject(e);
    });
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        closed,
        next(no, timeoutMs = 10_000) {
          for (const f of frames) {
            const hit = sub(f, no);
            if (hit) return Promise.resolve(hit.b ?? Buffer.alloc(0));
          }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`sem a mensagem ${no} da sinalização`)), timeoutMs);
            waiters.push({ no, resolve: (b) => (clearTimeout(t), res(b)) });
          });
        },
        send: (b) => ws.send(b),
        close: () => ws.close(),
      }),
    );
  });
}
async function joined(url: string): Promise<Signal> {
  const s = await signal(url);
  if ('refused' in s) throw new Error(`conexão recusada: ${s.refused} ${s.body}`);
  await s.next(SIG.join);
  return s;
}
// O n-ésimo campo `no` recebido (0 é o primeiro), esperando até chegar.
async function nth(s: Signal, no: number, n: number, timeoutMs = 10_000): Promise<Buffer> {
  const t0 = Date.now();
  for (;;) {
    const hits = s.frames.map((f) => sub(f, no)).filter((x) => x);
    if (hits.length > n) return hits[n]!.b ?? Buffer.alloc(0);
    if (Date.now() - t0 > timeoutMs) throw new Error(`sem a mensagem ${no} número ${n} da sinalização`);
    await sleep(20);
  }
}
const QUERY = 'protocol=15&auto_subscribe=1&sdk=js&version=2.15.0';
const viaBridge = (token: string) => `${urlOf('/sfu/rtc').replace(/^http/, 'ws')}?access_token=${encodeURIComponent(token)}&${QUERY}`;
// Como o livekit-client de agora conecta: /rtc/v1 com o join_request.
const viaBridgeV1 = (token: string, join = joinRequest({ gzip: true })) => `${urlOf('/sfu/rtc/v1').replace(/^http/, 'ws')}?access_token=${encodeURIComponent(token)}&join_request=${join}`;

// ---------- LiveKit, lk e portas ----------

let TMP = '';
const children = new Set<ChildProcess>();
let livekit: ChildProcess | null = null;
let livekitLog = '';
let yamlPath = '';
let yamlText = '';
let lkPort = 0;
let lkUrl = '';
const key = `API${crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, 'x')}`;
const secret = crypto.randomBytes(32).toString('base64url');
// Se algo der errado no meio, nada fica rodando: só os processos que este arquivo iniciou.
process.once('exit', () => {
  for (const c of children) c.kill('SIGKILL');
});

async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
async function udpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => resolve(false));
    s.bind(port, () => s.close(() => resolve(true)));
  });
}
// Quatro portas UDP seguidas, como o 7882-7885 da instalação.
async function freeUdpRange(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const base = 20_000 + crypto.randomInt(0, 40_000);
    let ok = true;
    for (let p = base; p < base + 4 && ok; p++) ok = await udpFree(p);
    if (ok) return base;
  }
  throw new Error('nenhuma faixa UDP livre');
}

function nodeAddress(): { ip: string; cidr: string; loopback: boolean } {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return { ip: a.address, cidr: `${a.address}/32`, loopback: false };
  }
  return { ip: '127.0.0.1', cidr: '127.0.0.0/8', loopback: true };
}

// O mesmo modelo do §8.3; usado só enquanto scripts/livekit/render-config.mjs (do callops) não existe.
function fallbackConfig(o: { nodeIp: string; lanCidr: string; webhookUrl: string; cores: number; maxMbps: number }) {
  return [
    '# Gerado por scripts/livekit/render-config.mjs. Não edite à mão: rode o instalador de novo.',
    'port: 7880',
    'bind_addresses:',
    '  - "127.0.0.1"',
    'rtc:',
    '  tcp_port: 7881',
    '  udp_port: "7882-7885"',
    '  use_external_ip: false',
    `  node_ip: "${o.nodeIp}"`,
    '  ips:',
    '    includes:',
    `      - "${o.lanCidr}"`,
    '  enable_loopback_candidate: false',
    '  allow_tcp_fallback: true',
    'keys:',
    `  "${key}": "${secret}"`,
    'room:',
    '  auto_create: false',
    '  empty_timeout: 120',
    '  departure_timeout: 40',
    '  enable_remote_unmute: false',
    'webhook:',
    `  api_key: "${key}"`,
    '  urls:',
    `    - "${o.webhookUrl}"`,
    'turn:',
    '  enabled: false',
    'limit:',
    `  num_tracks: ${Math.min(400 * o.cores, 8000)}`,
    `  bytes_per_sec: ${o.maxMbps * 125_000}`,
    'logging:',
    '  level: info',
    '',
  ].join('\n');
}

async function renderConfig(webhookUrl: string): Promise<{ text: string; via: 'render-config.mjs' | 'modelo do teste' }> {
  const addr = nodeAddress();
  const script = path.resolve(__dirname, '../../scripts/livekit/render-config.mjs');
  let text: string;
  let via: 'render-config.mjs' | 'modelo do teste';
  if (fs.existsSync(script)) {
    const secretFile = path.join(TMP, 'segredo');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    const out = path.join(TMP, 'renderizado.yaml');
    const args = [script, '--node-ip', addr.ip, '--lan-cidr', addr.cidr, '--api-key', key, '--secret-file', secretFile, '--webhook-url', webhookUrl, '--cores', '1', '--max-mbps', '100', '--out', out];
    const code = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr!.on('data', (d) => (err += d));
      p.on('exit', (c) => {
        if (c) console.error(err);
        resolve(c ?? 1);
      });
    });
    if (code !== 0) throw new Error(`render-config.mjs saiu com ${code}`);
    text = fs.readFileSync(out, 'utf8');
    via = 'render-config.mjs';
  } else {
    text = fallbackConfig({ nodeIp: addr.ip, lanCidr: addr.cidr, webhookUrl, cores: 1, maxMbps: 100 });
    via = 'modelo do teste';
  }
  // Só as portas mudam (portas livres nesta máquina); sem endereço de rede, o candidato de loopback é o único caminho.
  lkPort = await freeTcpPort();
  const tcp = await freeTcpPort();
  const udp = await freeUdpRange();
  const swaps: [RegExp, string][] = [
    [/^port: 7880$/m, `port: ${lkPort}`],
    [/^(\s+)tcp_port: 7881$/m, `$1tcp_port: ${tcp}`],
    [/^(\s+)udp_port: "7882-7885"$/m, `$1udp_port: "${udp}-${udp + 3}"`],
  ];
  if (addr.loopback) swaps.push([/^(\s+)enable_loopback_candidate: false$/m, '$1enable_loopback_candidate: true']);
  for (const [re, to] of swaps) {
    if (!re.test(text)) throw new Error(`a configuração renderizada não tem ${re}`);
    text = text.replace(re, to);
  }
  return { text, via };
}

async function startLivekit() {
  const p = spawn(LIVEKIT_BIN!, ['--config', yamlPath], { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p);
  livekit = p;
  const keep = (d: Buffer) => {
    livekitLog = (livekitLog + d.toString()).slice(-20_000);
  };
  p.stdout!.on('data', keep);
  p.stderr!.on('data', keep);
  p.once('exit', () => children.delete(p));
  for (let i = 0; i < 100; i++) {
    if (p.exitCode !== null) break;
    try {
      const r = await fetch(`${lkUrl}/`);
      if (r.ok) return;
    } catch {
      // ainda subindo
    }
    await sleep(100);
  }
  throw new Error(`o LiveKit não subiu:\n${livekitLog.slice(-3000)}`);
}
async function stopLivekit(sig: NodeJS.Signals) {
  const p = livekit;
  if (!p || p.exitCode !== null) return;
  const gone = new Promise((r) => p.once('exit', r));
  p.kill(sig);
  await gone;
}

// Participante real: o lk entra direto no LiveKit com um token feito por ele mesmo.
function lkJoin(room: string, identity: string, extra: string[] = []) {
  const p = spawn(LK_BIN!, ['room', 'join', '--identity', identity, ...extra, room], {
    cwd: TMP,
    env: { ...process.env, LIVEKIT_URL: lkUrl, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(p);
  let log = '';
  p.stdout!.on('data', (d) => (log = (log + d).slice(-5000)));
  p.stderr!.on('data', (d) => (log = (log + d).slice(-5000)));
  p.once('exit', () => children.delete(p));
  return {
    proc: p,
    log: () => log,
    stop: async (sig: NodeJS.Signals = 'SIGINT') => {
      if (p.exitCode !== null) return;
      const gone = new Promise((r) => p.once('exit', r));
      p.kill(sig);
      await Promise.race([gone, sleep(5000)]);
      if (p.exitCode === null) p.kill('SIGKILL');
    },
  };
}

// ---------- Chat ----------

let A: Auth;
let fake: FakeSfu;

async function settings(values: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings: values }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
}
const useReal = () => settings({ Calls_SFU_Url: lkUrl, Calls_SFU_Api_Key: key, Calls_SFU_Api_Secret: secret });
async function onFake<T>(fn: () => Promise<T>): Promise<T> {
  await settings({ Calls_SFU_Url: fake.url, Calls_SFU_Api_Key: fake.key, Calls_SFU_Api_Secret: fake.secret });
  try {
    return await fn();
  } finally {
    await useReal();
  }
}

// Chamada em grupo viva pelo SFU, com uma linha por pessoa (todas no canal).
let seq = 0;
async function liveCall(people: { u: Auth; hidden?: boolean }[]) {
  seq++;
  const [owner, ...rest] = people;
  const rid = (await api('POST', 'channels.create', { name: `ao-vivo-${seq}-${Math.random().toString(36).slice(2, 7)}`, members: rest.map((p) => p.u.username) }, owner.u)).channel._id as string;
  const callId = newId();
  const sfuRoom = `wc_${callId}`;
  await pool.query(`INSERT INTO calls (id, room_id, caller_id, kind, status, scope, media, sfu_room) VALUES ($1, $2, $3, 'video', 'ongoing', 'group', 'sfu', $4)`, [callId, rid, owner.u.userId, sfuRoom]);
  for (const [i, p] of people.entries()) {
    // A linha concede o mesmo que token(): microfone e câmera para quem fala, nada para quem só ouve.
    await pool.query(
      `INSERT INTO call_participants (call_id, user_id, host, state, created_at, token_at, granted_publish, granted_sources, granted_hidden)
       VALUES ($1, $2, $3, 'joined', now(), now(), $4, $5, $6)`,
      [callId, p.u.userId, i === 0, !p.hidden, p.hidden ? [] : ['microphone', 'camera'], !!p.hidden],
    );
    stub.allowed.add(`${p.u.userId}|${sfuRoom}|${!!p.hidden}`);
  }
  const token = (u: Auth, hidden = false) => joinToken({ room: sfuRoom, identity: u.userId, canPublish: !hidden, sources: hidden ? [] : ['microphone', 'camera'], hidden }).token;
  return { rid, callId, sfuRoom, token };
}
const ROOM = { emptyTimeout: 30, departureTimeout: 5, maxParticipants: 10 };

async function waitEvent(pred: (e: any) => boolean, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const e = stub.events.find(pred);
    if (e) return e;
    if (Date.now() - t0 > timeoutMs) throw new Error('webhook não chegou');
    await sleep(50);
  }
}
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`tempo esgotado: ${what}`);
    await sleep(100);
  }
}
const participant = (room: string, identity: string) => async () => (await sfu.listParticipants(room)).find((p) => p.identity === identity);

// Twirp cru, para comparar os formatos do LiveKit e do falso campo a campo.
async function twirp(base: string, k: string, s: string, method: string, body: unknown, video: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const r = await fetch(`${base}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signJwt({ iss: k, nbf: now, exp: now + 60, video }, s)}` },
    body: JSON.stringify(body),
  });
  expect(r.status, method).toBe(200);
  return r.json() as Promise<any>;
}
const shape = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v]));
const keys = (o: Record<string, unknown>) => Object.keys(o).sort();

if (!LIVEKIT_BIN) {
  describe('LiveKit real', () => {
    it.skip(SKIP_LIVEKIT, () => {});
  });
} else {
  describe('LiveKit real', () => {
    const lkIt = LK_BIN ? it : it.skip;
    let presence: typeof import('../src/calls/presence');

    beforeAll(async () => {
      TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sfu-live-'));
      await startServer();
      A = await admin();
      await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
      presence = await vi.importActual<typeof import('../src/calls/presence')>('../src/calls/presence');
      const rendered = await renderConfig(urlOf('/sfu-webhook'));
      yamlText = rendered.text;
      yamlPath = path.join(TMP, 'livekit.yaml');
      fs.writeFileSync(yamlPath, yamlText, { mode: 0o600 });
      lkUrl = `http://127.0.0.1:${lkPort}`;
      console.info(`LiveKit em ${lkUrl}, configuração pelo ${rendered.via}`);
      await startLivekit();
      // O falso só serve para comparar formatos; os webhooks dele não vão para o chat.
      fake = await startFakeSfu({ webhookUrl: 'http://127.0.0.1:9/sfu-webhook' });
      await useReal();
    }, 60_000);
    afterAll(async () => {
      for (const c of [...children]) c.kill('SIGKILL');
      await fake?.stop();
      await stopServer();
      if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
    });

    if (!LK_BIN) it.skip(SKIP_LK, () => {});

    it('o LiveKit renderizado escuta a API só em 127.0.0.1', async () => {
      expect(yamlText).toMatch(/^bind_addresses:\n\s+- "127\.0\.0\.1"$/m);
      const r = await fetch(`${lkUrl}/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('OK');
      // Pelos outros endereços da máquina, a porta da API nem aceita conexão.
      const others = Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => !a.internal).map((a) => a.address));
      for (const host of others) {
        const reached = await new Promise<boolean>((resolve) => {
          const s = net.connect({ host, port: lkPort, timeout: 1500 });
          s.once('connect', () => (s.destroy(), resolve(true)));
          s.once('error', () => resolve(false));
          s.once('timeout', () => (s.destroy(), resolve(false)));
        });
        expect(reached, host).toBe(false);
      }
    });

    it('CreateRoom gera room_started assinado que o chat aceita; formatos das respostas iguais aos do falso', async () => {
      const room = `wc_${newId()}`;
      await sfu.createRoom(room, ROOM);
      // A rota só chama o handleSfuEvent depois de conferir a assinatura e o sha256 do corpo.
      const ev = await waitEvent((e) => e.event === 'room_started' && e.room?.name === room);
      expect(ev.id).toMatch(/^EV_/);
      expect(ev.createdAt).toBeGreaterThan(0);
      expect(ev.room).toMatchObject({ name: room });
      // Criar de novo não falha (o LiveKit devolve a mesma sala).
      await sfu.createRoom(room, ROOM);

      // Formatos crus: tudo o que o falso manda o LiveKit também manda, com o mesmo tipo.
      const realRoom = await twirp(lkUrl, key, secret, 'CreateRoom', { name: room, ...ROOM }, { roomCreate: true });
      const fakeRoom = await twirp(fake.url, fake.key, fake.secret, 'CreateRoom', { name: room, ...ROOM }, { roomCreate: true });
      expect(keys(realRoom)).toEqual(expect.arrayContaining(keys(fakeRoom)));
      const realShape = shape(realRoom);
      for (const [k, t] of Object.entries(shape(fakeRoom))) expect(realShape[k], k).toBe(t);
      const realList = await twirp(lkUrl, key, secret, 'ListParticipants', { room }, { roomAdmin: true, room });
      const fakeList = await twirp(fake.url, fake.key, fake.secret, 'ListParticipants', { room }, { roomAdmin: true, room });
      expect(realList).toEqual(fakeList);

      // Normalizados: o mesmo objeto dos dois lados.
      const [real] = await sfu.listRooms([room]);
      const [fromFake] = await onFake(() => sfu.listRooms([room]));
      expect(shape(real as any)).toEqual(shape(fromFake as any));
      expect(real).toMatchObject({ name: room, numParticipants: 0 });
      await sfu.deleteRoom(room);
    });

    it('validate pela ponte aceita token bom e recusa token ruim; WebSocket pela ponte recebe a primeira resposta do LiveKit', async () => {
      const u = await newUser(A);
      const c = await liveCall([{ u }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const good = c.token(u);
      const ok = await fetch(urlOf(`/sfu/rtc/validate?access_token=${encodeURIComponent(good)}&${QUERY}`));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('set-cookie')).toBeNull();
      const bad = signJwt({ iss: key, sub: u.userId, nbf: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 60, video: { roomJoin: true, room: c.sfuRoom } }, 'segredo-errado');
      const no = await fetch(urlOf(`/sfu/rtc/validate?access_token=${bad}&${QUERY}`));
      expect(no.status).toBe(401);
      expect(await no.text()).toBe('acesso recusado');

      // A primeira mensagem do LiveKit é o JoinResponse, com a sala e a pessoa do token.
      const s = await joined(viaBridge(good));
      const join = decode(await s.next(SIG.join));
      expect(str(decode(sub(join, 1)!.b!), 2)).toBe(c.sfuRoom);
      expect(str(decode(sub(join, 2)!.b!), 2)).toBe(u.userId);
      s.close();
      await s.closed;
      await sfu.deleteRoom(c.sfuRoom);
    });

    it('DeleteRoom gera room_finished; room_finished sem DeleteRoom não encerra a chamada', async () => {
      const room = `wc_${newId()}`;
      await sfu.createRoom(room, ROOM);
      await sfu.deleteRoom(room);
      await waitEvent((e) => e.event === 'room_finished' && e.room?.name === room);

      // Sala vazia que o LiveKit fecha sozinho (é o que se vê depois de um reinício): a chamada continua viva.
      const u = await newUser(A);
      const c = await liveCall([{ u }]);
      await sfu.createRoom(c.sfuRoom, { emptyTimeout: 1, departureTimeout: 1, maxParticipants: 10 });
      const ev = await waitEvent((e) => e.event === 'room_finished' && e.room?.name === c.sfuRoom, 20_000);
      if (!REAL) await presence.handleSfuEvent(ev);
      await vi.waitFor(async () => {
        const row = (await pool.query('SELECT status, sfu_missing_since FROM calls WHERE id = $1', [c.callId])).rows[0];
        expect(row.status).toBe('ongoing');
        expect(row.sfu_missing_since).not.toBeNull();
      });
    });

    it('participante não consegue alterar os próprios atributos nem o nome', async () => {
      // Controle: com canUpdateOwnMetadata o mesmo pedido muda nome, metadados e atributos (o protobuf está certo).
      const free = `wc_${newId()}`;
      await sfu.createRoom(free, ROOM);
      const now = Math.floor(Date.now() / 1000);
      const control = await joined(`${lkUrl.replace(/^http/, 'ws')}/rtc?access_token=${signJwt({ iss: key, sub: 'controle', nbf: now - 5, exp: now + 60, video: { roomJoin: true, room: free, canSubscribe: true, canUpdateOwnMetadata: true } }, secret)}&${QUERY}`);
      control.send(updateMetadata(1));
      const changed = await waitFor(async () => (await twirp(lkUrl, key, secret, 'ListParticipants', { room: free }, { roomAdmin: true, room: free })).participants.find((p: any) => p.name === 'Nome trocado'), 5000, 'o controle trocar o nome');
      expect(changed).toMatchObject({ identity: 'controle', metadata: 'metadados livres', attributes: { canal: 'escondido' } });
      control.close();

      // Pela ponte, com o token do chat: o LiveKit recusa e nada muda. Uma pessoa por conexão: com REAL_ADMISSION, quem
      // fecha a sinalização sai da chamada e teria de passar pelo calls.join de novo.
      const [u, x, y, z] = [await newUser(A), await newUser(A), await newUser(A), await newUser(A)];
      const c = await liveCall([{ u }, { u: x }, { u: y }, { u: z }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const s = await joined(viaBridge(c.token(u)));
      s.send(updateMetadata(2));
      const resp = decode(await s.next(SIG.requestResponse));
      expect(num(resp, 1)).toBe(2);
      expect(num(resp, 2)).toBe(2); // NOT_ALLOWED
      await sleep(500);
      const people = async (room: string) => (await twirp(lkUrl, key, secret, 'ListParticipants', { room }, { roomAdmin: true, room })).participants as any[];
      const raw = (await people(c.sfuRoom)).find((p: any) => p.identity === u.userId);
      expect(raw).toMatchObject({ name: '', metadata: '', attributes: {} });
      s.close();
      await s.closed;

      // /rtc/v1, como o navegador conecta, com metadados e atributos no join_request. Controle direto no LiveKit com
      // canUpdateOwnMetadata: o LiveKit aplica na entrada (a codificação está certa).
      const covert = { metadata: 'metadados no join', attributes: { canal: 'escondido' } };
      const lkV1 = `${lkUrl.replace(/^http/, 'ws')}/rtc/v1?access_token=${signJwt({ iss: key, sub: 'controle-v1', nbf: now - 5, exp: now + 60, video: { roomJoin: true, room: free, canSubscribe: true, canUpdateOwnMetadata: true } }, secret)}`;
      const control1 = await joined(`${lkV1}&join_request=${joinRequest({ ...covert, gzip: true })}`);
      const applied = await waitFor(async () => (await people(free)).find((p: any) => p.identity === 'controle-v1' && p.metadata), 5000, 'o controle entrar com metadados');
      expect(applied).toMatchObject(covert);
      control1.close();
      // Pela ponte, com o token do chat (canUpdateOwnMetadata false), comprimido ou não, só metadados ou só atributos:
      // o LiveKit fixado recusa a entrada. Se uma versão nova deixar entrar, nada disso pode chegar aos outros.
      const outcomes: string[] = [];
      for (const o of [{ ...covert, gzip: true }, { metadata: covert.metadata }, { attributes: covert.attributes }, { attributes: { canal: '' }, gzip: true }]) {
        const attempt = await signal(viaBridgeV1(c.token(x), joinRequest(o)));
        if ('refused' in attempt) {
          expect(attempt.refused).toBeGreaterThanOrEqual(400);
          outcomes.push(`recusado (${attempt.refused} ${attempt.body})`);
          continue;
        }
        await attempt.next(SIG.join);
        await sleep(300);
        outcomes.push('aceito');
        expect((await people(c.sfuRoom)).find((p: any) => p.identity === x.userId)).toMatchObject({ metadata: '', attributes: {} });
        attempt.close();
        await attempt.closed;
      }
      console.info(`join_request com metadados ou atributos no LiveKit fixado: ${outcomes.join('; ')}`);
      for (const p of await people(c.sfuRoom)) expect(p, p.identity).toMatchObject({ name: '', metadata: '', attributes: {} });
      // O mesmo pedido sem metadados (o que o livekit-client manda) entra pela ponte, sem nada.
      const v1 = await joined(viaBridgeV1(c.token(y)));
      const join = decode(await v1.next(SIG.join));
      expect(str(decode(sub(join, 2)!.b!), 2)).toBe(y.userId);
      expect((await people(c.sfuRoom)).find((p: any) => p.identity === y.userId)).toMatchObject({ metadata: '', attributes: {} });
      v1.close();
      await v1.closed;
      // E no /rtc antigo, nome, metadados e atributos na consulta não valem nada.
      const v0 = await joined(`${viaBridge(c.token(z))}&name=Nome&metadata=${encodeURIComponent(covert.metadata)}&attributes=${encodeURIComponent(JSON.stringify(covert.attributes))}`);
      await sleep(300);
      expect((await people(c.sfuRoom)).find((p: any) => p.identity === z.userId)).toMatchObject({ name: '', metadata: '', attributes: {} });
      v0.close();
      await v0.closed;
      await sfu.deleteRoom(free);
      await sfu.deleteRoom(c.sfuRoom);
    });

    it('token renovado pelo LiveKit traz sala e hidden que parseJoinClaims lê', async () => {
      const [u, w] = [await newUser(A), await newUser(A)];
      const c = await liveCall([{ u, hidden: true }, { u: w }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const first = await joined(viaBridge(c.token(u, true)));
      // O LiveKit manda um token renovado logo depois de entrar (e a cada mudança de permissão).
      const refreshed = (await first.next(SIG.refreshToken)).toString();
      const claims = verifyJwt(refreshed, secret, { issuer: key });
      expect(claims).not.toBeNull();
      expect(parseJoinClaims(claims!)).toMatchObject({ identity: u.userId, room: c.sfuRoom, hidden: true, forbidden: null });
      // A retomada do livekit-client usa esse token: a ponte aceita e o LiveKit troca a sessão.
      const again = await joined(viaBridge(refreshed));
      const leave = decode(await first.next(SIG.leave));
      expect(num(leave, 2)).toBe(2); // DUPLICATE_IDENTITY
      again.close();
      await again.closed;

      // Pausa (a trava, ou a tela bloqueada) depois do token: um token renovado antes dela não reabre a publicação
      // pela ponte; o que o LiveKit manda depois da pausa entra, sem publicar.
      const talk = await joined(viaBridge(c.token(w)));
      const claimsOf = (t: string) => parseJoinClaims(verifyJwt(t, secret, { issuer: key })!);
      const refreshes = () => talk.frames.flatMap((f) => sub(f, SIG.refreshToken)?.b?.toString() ?? []);
      const before = (await nth(talk, SIG.refreshToken, 0)).toString();
      expect(claimsOf(before)).toMatchObject({ identity: w.userId, canPublish: true, sources: ['microphone', 'camera'], forbidden: null });
      const seen = refreshes().length;
      await pool.query(`UPDATE call_participants SET granted_publish = false, granted_sources = '{}' WHERE call_id = $1 AND user_id = $2`, [c.callId, w.userId]);
      await sfu.updatePermission(c.sfuRoom, w.userId, { canPublish: false, sources: [], hidden: false });
      const after = await waitFor(async () => refreshes().slice(seen).find((t) => !claimsOf(t).canPublish), 5000, 'o token renovado depois da pausa');
      expect(claimsOf(after)).toMatchObject({ identity: w.userId, room: c.sfuRoom, canPublish: false, forbidden: null });
      expect(await signal(viaBridge(before))).toMatchObject({ refused: 403, body: 'acesso recusado' });
      const resumed = await joined(viaBridge(after));
      expect(num(decode(await talk.next(SIG.leave)), 2)).toBe(2); // DUPLICATE_IDENTITY
      expect((await participant(c.sfuRoom, w.userId)())?.permission).toMatchObject({ canPublish: false, canPublishSources: [] });
      resumed.close();
      await resumed.closed;
      await sfu.deleteRoom(c.sfuRoom);
    });

    it('autoteste: a retomada com o token que o LiveKit renovou passa pela ponte; token mais longo, não', async () => {
      const u = await newUser(A);
      const room = `wc_test_${newId()}`;
      await sfu.createRoom(room, { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 3 });
      const first = await joined(viaBridge(joinToken({ room, identity: u.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: 300 }).token));
      const refreshed = (await first.next(SIG.refreshToken)).toString();
      expect(parseJoinClaims(verifyJwt(refreshed, secret, { issuer: key })!)).toMatchObject({ identity: u.userId, room, forbidden: null });
      // O "Resuming connection" do ConnectionCheck fecha o WebSocket e volta com esse token, que vale 10 min.
      const again = await joined(viaBridge(refreshed));
      expect(num(decode(await first.next(SIG.leave)), 2)).toBe(2); // DUPLICATE_IDENTITY
      again.close();
      await again.closed;
      const long = joinToken({ room, identity: u.userId, canPublish: true, sources: null, hidden: false, ttlSeconds: 3600 }).token;
      expect(await signal(viaBridge(long))).toMatchObject({ refused: 403, body: 'acesso recusado' });
      await sfu.deleteRoom(room);
    });

    lkIt('permissão revogada tira a faixa publicada em até 2 s', async () => {
      const room = `wc_${newId()}`;
      await sfu.createRoom(room, ROOM);
      const pub = lkJoin(room, 'publica', ['--publish-demo']);
      try {
        const p = await waitFor(async () => {
          const x = await participant(room, 'publica')();
          return x?.tracks.length ? x : null;
        }, 20_000, `o lk publicar\n${pub.log()}`);
        expect(p.tracks[0]).toMatchObject({ type: 'video', source: 'camera' });
        // Formato da faixa igual ao do falso.
        const fromFake = await onFake(async () => {
          await sfu.createRoom(room, ROOM);
          await fake.join(room, 'publica');
          await fake.publish(room, 'publica', { source: 'camera', name: 'camera', type: 'video' });
          return (await sfu.listParticipants(room))[0];
        });
        expect(shape(p.tracks[0] as any)).toEqual(shape(fromFake.tracks[0] as any));
        const rawReal = (await twirp(lkUrl, key, secret, 'ListParticipants', { room }, { roomAdmin: true, room })).participants[0].tracks[0];
        const rawFake = (await twirp(fake.url, fake.key, fake.secret, 'ListParticipants', { room }, { roomAdmin: true, room })).participants[0].tracks[0];
        expect(keys(rawReal)).toEqual(expect.arrayContaining(keys(rawFake)));

        const t0 = Date.now();
        await sfu.updatePermission(room, 'publica', { canPublish: false, sources: [], hidden: false });
        await waitFor(async () => (await participant(room, 'publica')())?.tracks.length === 0, 2000, 'a faixa sair');
        expect(Date.now() - t0).toBeLessThanOrEqual(2000);
        await waitEvent((e) => e.event === 'track_unpublished' && e.room?.name === room && e.participant?.identity === 'publica', 2000);
      } finally {
        await pub.stop('SIGKILL');
        await sfu.deleteRoom(room);
      }
    }, 60_000);

    it('ListParticipants lista participantes ocultos', async () => {
      const [u, v] = [await newUser(A), await newUser(A)];
      const c = await liveCall([{ u }, { u: v, hidden: true }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const seen = await joined(viaBridge(c.token(u)));
      const hidden = await joined(viaBridge(c.token(v, true)));
      const list = await sfu.listParticipants(c.sfuRoom);
      expect(list.find((p) => p.identity === u.userId)?.permission).toMatchObject({ hidden: false, canPublish: true, canPublishSources: ['microphone', 'camera'], canPublishData: false, canUpdateMetadata: false });
      expect(list.find((p) => p.identity === v.userId)?.permission).toMatchObject({ hidden: true, canPublish: false, canPublishData: false, canUpdateMetadata: false });
      // O mesmo formato normalizado do falso.
      const fromFake = await onFake(async () => {
        await sfu.createRoom(c.sfuRoom, ROOM);
        await fake.join(c.sfuRoom, v.userId, { hidden: true });
        return (await sfu.listParticipants(c.sfuRoom))[0];
      });
      const real = list.find((p) => p.identity === v.userId)!;
      expect(shape(real as any)).toEqual(shape(fromFake as any));
      expect(shape(real.permission as any)).toEqual(shape(fromFake.permission as any));
      const rawReal = (await twirp(lkUrl, key, secret, 'ListParticipants', { room: c.sfuRoom }, { roomAdmin: true, room: c.sfuRoom })).participants[0];
      const rawFake = (await twirp(fake.url, fake.key, fake.secret, 'ListParticipants', { room: c.sfuRoom }, { roomAdmin: true, room: c.sfuRoom })).participants[0];
      expect(keys(rawReal)).toEqual(expect.arrayContaining(keys(rawFake)));
      expect(keys(rawReal.permission)).toEqual(expect.arrayContaining(keys(rawFake.permission)));
      seen.close();
      hidden.close();
      await Promise.all([seen.closed, hidden.closed]);
      await sfu.deleteRoom(c.sfuRoom);
    });

    it('RemoveParticipant com revokeTokenTs: registra se a versão fixada aceita o campo', async () => {
      const u = await newUser(A);
      const c = await liveCall([{ u }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const token = c.token(u);
      const s = await joined(viaBridge(token));
      const spy = vi.spyOn(globalThis, 'fetch');
      try {
        await sfu.removeParticipant(c.sfuRoom, u.userId);
        const removes = spy.mock.calls.filter(([url]) => String(url).endsWith('/RemoveParticipant'));
        // O LiveKit aceita o pedido com o campo (não há segunda tentativa sem ele).
        expect(removes.length).toBe(1);
        expect(JSON.parse(String(removes[0][1]!.body))).toMatchObject({ room: c.sfuRoom, identity: u.userId, revokeTokenTs: expect.stringMatching(/^\d+$/) });
      } finally {
        spy.mockRestore();
      }
      const leave = decode(await s.next(SIG.leave));
      expect(num(leave, 2)).toBe(4); // PARTICIPANT_REMOVED
      await s.closed;

      // Se o LiveKit respeita o campo, o mesmo token (emitido antes da remoção) não entra mais, nem direto.
      await sleep(1100);
      const direct = await signal(`${lkUrl.replace(/^http/, 'ws')}/rtc?access_token=${token}&${QUERY}`);
      const honoured = 'refused' in direct;
      console.info(`revokeTokenTs no LiveKit fixado: ${honoured ? 'respeitado (o token antigo foi recusado)' : 'aceito e ignorado (o token antigo ainda entra direto no LiveKit)'}`);
      if (!honoured) {
        (direct as Signal).close();
        await (direct as Signal).closed;
      }
      // De qualquer forma, pela ponte quem saiu não volta: a admissão olha a linha, não o LiveKit.
      await pool.query(`UPDATE call_participants SET state = 'left', left_reason = 'removed' WHERE call_id = $1 AND user_id = $2`, [c.callId, u.userId]);
      stub.allowed.delete(`${u.userId}|${c.sfuRoom}|false`);
      expect(await signal(viaBridge(token))).toMatchObject({ refused: 403, body: 'acesso recusado' });
      await sfu.deleteRoom(c.sfuRoom);
    });

    lkIt('LiveKit reinicia com chamada viva: a sala volta e as pessoas reconectam', async () => {
      const u = await newUser(A);
      const c = await liveCall([{ u }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const person = lkJoin(c.sfuRoom, u.userId, ['--publish-demo']);
      try {
        await waitFor(participant(c.sfuRoom, u.userId), 20_000, `o lk entrar\n${person.log()}`);
        // Queda sem aviso: o LiveKit volta vazio, sem a sala.
        await stopLivekit('SIGKILL');
        await startLivekit();
        await expect(sfu.listParticipants(c.sfuRoom)).rejects.toMatchObject({ code: 'not_found' });
        // A reconciliação (a cada 10 s no agendador) marca a falta e recria a sala; a chamada continua.
        await presence.reconcileCall(c.callId);
        let row = (await pool.query('SELECT status, sfu_missing_since FROM calls WHERE id = $1', [c.callId])).rows[0];
        expect(row.status).toBe('ongoing');
        expect(row.sfu_missing_since).not.toBeNull();
        expect((await sfu.listRooms([c.sfuRoom])).map((r) => r.name)).toEqual([c.sfuRoom]);
        // O lk reconecta sozinho na sala recriada.
        await waitFor(participant(c.sfuRoom, u.userId), 30_000, `o lk reconectar\n${person.log()}`);
        await presence.reconcileCall(c.callId);
        row = (await pool.query('SELECT status, sfu_missing_since FROM calls WHERE id = $1', [c.callId])).rows[0];
        expect(row.status).toBe('ongoing');
        expect(row.sfu_missing_since).toBeNull();
      } finally {
        await person.stop('SIGKILL');
        await sfu.deleteRoom(c.sfuRoom);
      }
    }, 90_000);

    it('troca de dispositivo numa chamada a dois cheia', async () => {
      const [u, v] = [await newUser(A), await newUser(A)];
      const c = await liveCall([{ u }, { u: v }]);
      await sfu.createRoom(c.sfuRoom, { emptyTimeout: 30, departureTimeout: 5, maxParticipants: 2 });
      const phone = await joined(viaBridge(c.token(u)));
      const other = await joined(viaBridge(c.token(v)));
      const before = await participant(c.sfuRoom, u.userId)();
      // Sala cheia: uma terceira pessoa não entra.
      const now = Math.floor(Date.now() / 1000);
      const third = await signal(`${lkUrl.replace(/^http/, 'ws')}/rtc?access_token=${signJwt({ iss: key, sub: 'terceira', nbf: now - 5, exp: now + 60, video: { roomJoin: true, room: c.sfuRoom, canSubscribe: true } }, secret)}&${QUERY}`);
      expect(third).toMatchObject({ refused: expect.any(Number) });
      expect((third as Refused).refused).toBeGreaterThanOrEqual(400);
      // O segundo aparelho da mesma pessoa entra e o primeiro sai com DUPLICATE_IDENTITY.
      const laptop = await joined(viaBridge(c.token(u)));
      const leave = decode(await phone.next(SIG.leave));
      expect(num(leave, 2)).toBe(2);
      await phone.closed;
      const ev = await waitEvent((e) => /^participant_(left|connection_aborted)$/.test(e.event) && e.room?.name === c.sfuRoom && e.participant?.identity === u.userId);
      expect(ev.participant.disconnectReason).toBe('DUPLICATE_IDENTITY');
      const list = await sfu.listParticipants(c.sfuRoom);
      expect(list.map((p) => p.identity).sort()).toEqual([u.userId, v.userId].sort());
      expect(list.find((p) => p.identity === u.userId)!.sid).not.toBe(before!.sid);
      laptop.close();
      other.close();
      await Promise.all([laptop.closed, other.closed]);
      await sfu.deleteRoom(c.sfuRoom);
    });

    lkIt('saída pelo cliente chega com CLIENT_INITIATED', async () => {
      const room = `wc_${newId()}`;
      await sfu.createRoom(room, ROOM);
      const person = lkJoin(room, 'sai');
      try {
        await waitFor(participant(room, 'sai'), 20_000, `o lk entrar\n${person.log()}`);
        await person.stop('SIGINT');
        const ev = await waitEvent((e) => e.event === 'participant_left' && e.room?.name === room && e.participant?.identity === 'sai');
        expect(ev.participant.disconnectReason).toBe('CLIENT_INITIATED');
      } finally {
        await person.stop('SIGKILL');
      }
      // O mesmo pela ponte: o livekit-client manda LeaveRequest com CLIENT_INITIATED.
      const u = await newUser(A);
      const c = await liveCall([{ u }]);
      await sfu.createRoom(c.sfuRoom, ROOM);
      const s = await joined(viaBridge(c.token(u)));
      s.send(leaveRequest(1));
      const ev = await waitEvent((e) => /^participant_(left|connection_aborted)$/.test(e.event) && e.room?.name === c.sfuRoom && e.participant?.identity === u.userId);
      expect(ev.participant.disconnectReason).toBe('CLIENT_INITIATED');
      s.close();
      await s.closed;
      await sfu.deleteRoom(room);
      await sfu.deleteRoom(c.sfuRoom);
    }, 60_000);
  });
}
