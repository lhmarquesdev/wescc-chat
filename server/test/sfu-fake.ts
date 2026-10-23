import crypto from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import type { CallSource } from '@shared/index';
import type { SfuTrack } from '../src/calls/livekit';
import { api, type Auth } from './helpers';

// LiveKit falso para os testes: a API Twirp e os webhooks assinados, com os formatos que o LiveKit 1.13.9 usa de
// verdade (conferidos no sfu-live). A API responde com os nomes do proto (snake_case) e todos os campos, int64 em
// texto e enums pelo nome; os webhooks vêm em camelCase, sem os campos no valor padrão.

export interface FakeParticipant { sid: string; identity: string; hidden: boolean; joinedAt: number; tracks: SfuTrack[]; permission: any }
export interface FakeSfu {
  url: string;
  key: string;
  secret: string;
  calls: { method: string; body: any; grant: any }[]; // cada chamada Twirp recebida
  rooms: Map<string, { options: any; creationTime: number; participants: Map<string, FakeParticipant> }>;
  join(room: string, identity: string, o?: { sid?: string; hidden?: boolean; webhook?: boolean; permission?: any }): Promise<string>; // devolve o sid
  leave(room: string, identity: string, o?: { webhook?: boolean; reason?: 'CLIENT_INITIATED' | 'DUPLICATE_IDENTITY' | 'UNKNOWN' }): Promise<void>; // webhook false = webhook perdido
  abort(room: string, identity: string): Promise<void>;
  publish(room: string, identity: string, t: { source: CallSource | 'unknown'; name: string; type: 'audio' | 'video' }): Promise<string>; // track_published
  finish(room: string): Promise<void>; // room_finished sem DeleteRoom (reinício do LiveKit)
  hold(): void; // segura os webhooks
  release(o?: { order?: 'fifo' | 'reverse'; twice?: boolean }): Promise<void>; // solta fora de ordem e repetidos
  delay(ms: number): void; // atraso em cada resposta Twirp
  restart(): void; // esquece todas as salas, como um LiveKit reiniciado
  down(): void; // passa a recusar conexões
  up(): void;
  stop(): Promise<void>;
}

type Room = { sid: string; options: any; creationTime: number; creationTimeMs: number; participants: Map<string, FakeParticipant> };

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const rid = (prefix: string, n = 12) => prefix + Array.from(crypto.randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('');
const now = () => Math.floor(Date.now() / 1000);

const SOURCE_ENUM: Record<string, string> = { microphone: 'MICROPHONE', camera: 'CAMERA', screen_share: 'SCREEN_SHARE', screen_share_audio: 'SCREEN_SHARE_AUDIO', unknown: 'UNKNOWN' };
// Valores padrão dos enums, que o protojson omite nos webhooks.
const ENUM_DEFAULTS = new Set(['AUDIO', 'UNKNOWN', 'JOINING', 'UNKNOWN_REASON', 'STANDARD']);

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function toTwirp(v: any): any {
  if (Array.isArray(v)) return v.map(toTwirp);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), toTwirp(x)]));
  return v;
}
function omitDefaults(v: any): any {
  if (Array.isArray(v)) return v.map(omitDefaults);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === false || x === 0 || x === '' || x === null || x === undefined || x === '0' || ENUM_DEFAULTS.has(x as string)) continue;
    if (Array.isArray(x) && !x.length) continue;
    if (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length) continue;
    out[k] = omitDefaults(x);
  }
  return out;
}

function b64urlJson(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function sign(claims: Record<string, unknown>, secret: string) {
  const h = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const p = b64urlJson(claims);
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
// Verificação própria (não usa o código testado): assinatura, alg, validade e iss.
function verify(token: string, key: string, secret: string): any | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (head.alg !== 'HS256') return null;
    const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], 'base64url');
    if (got.length !== sig.length || !crypto.timingSafeEqual(got, sig)) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (c.iss !== key || typeof c.exp !== 'number' || c.exp < now() || (typeof c.nbf === 'number' && c.nbf > now() + 60)) return null;
    return c;
  } catch {
    return null;
  }
}

function permissionOf(p: any) {
  return {
    canSubscribe: p?.canSubscribe ?? true,
    canPublish: p?.canPublish ?? true,
    canPublishData: p?.canPublishData ?? false,
    canPublishSources: Array.isArray(p?.canPublishSources) ? p.canPublishSources.map((s: string) => String(s).toUpperCase()) : [],
    hidden: p?.hidden ?? false,
    recorder: false,
    canUpdateMetadata: p?.canUpdateMetadata ?? false,
    agent: false,
    canSubscribeMetrics: false,
    canManageAgentSession: false,
  };
}

function trackInfo(t: SfuTrack) {
  return { sid: t.sid, type: t.type.toUpperCase(), name: t.name, muted: t.muted, width: 0, height: 0, simulcast: false, disableDtx: false, source: SOURCE_ENUM[t.source] };
}

export async function startFakeSfu(o: { webhookUrl: string }): Promise<FakeSfu> {
  const key = rid('API', 12);
  const secret = crypto.randomBytes(32).toString('base64url');
  const rooms = new Map<string, Room>();
  const calls: FakeSfu['calls'] = [];
  const held: string[] = [];
  let holding = false;
  let delayMs = 0;
  let isDown = false;
  const sockets = new Set<net.Socket>();

  const roomInfo = (name: string, r: Room) => ({
    sid: r.sid,
    name,
    emptyTimeout: Number(r.options.emptyTimeout ?? 0),
    departureTimeout: Number(r.options.departureTimeout ?? 0),
    maxParticipants: Number(r.options.maxParticipants ?? 0),
    creationTime: String(r.creationTime),
    creationTimeMs: String(r.creationTimeMs),
    turnPassword: '',
    enabledCodecs: [],
    metadata: '',
    numParticipants: r.participants.size,
    numPublishers: [...r.participants.values()].filter((p) => p.tracks.length).length,
    activeRecording: false,
    version: null,
  });
  const participantInfo = (p: FakeParticipant, state = 'ACTIVE', disconnectReason = 'UNKNOWN_REASON') => ({
    sid: p.sid,
    identity: p.identity,
    state,
    tracks: p.tracks.map(trackInfo),
    metadata: '',
    joinedAt: String(p.joinedAt),
    joinedAtMs: String(p.joinedAt * 1000),
    name: '',
    version: 1,
    permission: p.permission,
    region: '',
    isPublisher: p.tracks.length > 0,
    kind: 'STANDARD',
    attributes: {},
    disconnectReason,
  });

  // Um webhook por vez, na ordem dos eventos, como o LiveKit.
  let chain: Promise<void> = Promise.resolve();
  function deliver(body: string) {
    chain = chain.then(async () => {
      const auth = sign({ iss: key, nbf: now(), exp: now() + 300, sha256: crypto.createHash('sha256').update(body).digest('base64') }, secret);
      try {
        await fetch(o.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/webhook+json', authorization: auth }, body });
      } catch {
        // O LiveKit também desiste depois de algumas tentativas.
      }
    });
    return chain;
  }
  async function webhook(event: string, data: Record<string, unknown>, send = true) {
    if (!send) return;
    const body = JSON.stringify(omitDefaults({ event, ...data, id: rid('EV_'), createdAt: String(now()) }));
    if (holding) held.push(body);
    else await deliver(body);
  }

  const roomOf = (name: string) => {
    const r = rooms.get(name);
    if (!r) throw new Error(`sala ${name} não existe no LiveKit falso`);
    return r;
  };

  async function dropParticipant(name: string, r: Room, p: FakeParticipant, event: string, reason: string, send = true) {
    r.participants.delete(p.identity);
    await webhook(event, { room: roomInfo(name, r), participant: participantInfo(p, 'DISCONNECTED', reason) }, send);
  }

  const GRANTS: Record<string, (g: any, body: any) => boolean> = {
    CreateRoom: (g) => g?.roomCreate === true,
    DeleteRoom: (g) => g?.roomCreate === true,
    ListRooms: (g) => g?.roomList === true,
    ListParticipants: (g, b) => g?.roomAdmin === true && g.room === b.room,
    RemoveParticipant: (g, b) => g?.roomAdmin === true && g.room === b.room,
    UpdateParticipant: (g, b) => g?.roomAdmin === true && g.room === b.room,
    MutePublishedTrack: (g, b) => g?.roomAdmin === true && g.room === b.room,
  };

  type Reply = [number, unknown];
  const notFound = (msg: string): Reply => [404, { code: 'not_found', msg }];

  async function handle(method: string, body: any): Promise<Reply> {
    switch (method) {
      case 'CreateRoom': {
        const name = String(body.name ?? '');
        let r = rooms.get(name);
        if (!r) {
          r = { sid: rid('RM_'), options: { emptyTimeout: body.emptyTimeout, departureTimeout: body.departureTimeout, maxParticipants: body.maxParticipants }, creationTime: now(), creationTimeMs: Date.now(), participants: new Map() };
          rooms.set(name, r);
          void webhook('room_started', { room: roomInfo(name, r) });
        }
        return [200, roomInfo(name, r)];
      }
      case 'DeleteRoom': {
        const name = String(body.room ?? '');
        const r = rooms.get(name);
        if (!r) return notFound('requested room does not exist');
        for (const p of [...r.participants.values()]) await dropParticipant(name, r, p, 'participant_left', 'ROOM_DELETED');
        rooms.delete(name);
        void webhook('room_finished', { room: roomInfo(name, r), roomEndReason: 'ROOM_END_API_DELETE' });
        return [200, {}];
      }
      case 'ListRooms': {
        const names: string[] = Array.isArray(body.names) ? body.names : [];
        const out = [...rooms.entries()].filter(([n]) => !names.length || names.includes(n)).map(([n, r]) => roomInfo(n, r));
        return [200, { rooms: out }];
      }
      case 'ListParticipants': {
        // Como o LiveKit 1.13: sala inexistente responde lista vazia.
        const r = rooms.get(String(body.room ?? ''));
        return [200, { participants: r ? [...r.participants.values()].map((p) => participantInfo(p)) : [] }];
      }
      case 'RemoveParticipant': {
        const name = String(body.room ?? '');
        const r = rooms.get(name);
        const p = r?.participants.get(String(body.identity ?? ''));
        if (!r || !p) return notFound('participant does not exist');
        await dropParticipant(name, r, p, 'participant_left', 'PARTICIPANT_REMOVED');
        return [200, {}];
      }
      case 'UpdateParticipant': {
        const name = String(body.room ?? '');
        const r = rooms.get(name);
        const p = r?.participants.get(String(body.identity ?? ''));
        if (!r || !p) return notFound('participant does not exist');
        if (body.permission) {
          // A permissão é trocada inteira; faixas de fontes que deixaram de valer saem, como no LiveKit.
          p.permission = permissionOf(body.permission);
          p.hidden = p.permission.hidden;
          const allowed = (t: SfuTrack) =>
            p.permission.canPublish && (!p.permission.canPublishSources.length || p.permission.canPublishSources.includes(SOURCE_ENUM[t.source]));
          for (const t of p.tracks.filter((x) => !allowed(x))) {
            p.tracks.splice(p.tracks.indexOf(t), 1);
            void webhook('track_unpublished', { room: { sid: r.sid, name }, participant: { sid: p.sid, identity: p.identity }, track: trackInfo(t) });
          }
        }
        return [200, participantInfo(p)];
      }
      case 'MutePublishedTrack': {
        const r = rooms.get(String(body.room ?? ''));
        const p = r?.participants.get(String(body.identity ?? ''));
        // O LiveKit 1.13 não acha o dono da faixa: 503 depois de esperar (aqui, sem esperar).
        if (!r || !p) return [503, { code: 'unavailable', msg: 'no response from servers' }];
        const t = p.tracks.find((x) => x.sid === body.trackSid);
        if (t) t.muted = body.muted === true;
        return [200, { track: t ? trackInfo(t) : null }];
      }
    }
    return [404, { code: 'bad_route', msg: `no handler for path "/twirp/livekit.RoomService/${method}"` }];
  }

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      const out = typeof body === 'string' ? body : JSON.stringify(type === 'application/json' ? toTwirp(body) : body);
      setTimeout(() => {
        res.writeHead(status, { 'content-type': type });
        res.end(out);
      }, delayMs);
    };
    const m = /^\/twirp\/livekit\.RoomService\/([A-Za-z]+)$/.exec((req.url ?? '').split('?')[0]);
    if (req.method === 'GET' && (req.url ?? '') === '/') return send(200, 'OK', 'text/plain');
    if (!m || req.method !== 'POST') return send(404, '404 page not found', 'text/plain');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      const claims = auth.startsWith('Bearer ') ? verify(auth.slice(7), key, secret) : null;
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { code: 'malformed', msg: 'the json request could not be decoded' });
      }
      const method = m[1];
      calls.push({ method, body, grant: claims?.video ?? null });
      if (!claims) return send(401, 'invalid authorization token', 'text/plain');
      if (GRANTS[method] && !GRANTS[method](claims.video, body)) return send(401, { code: 'unauthenticated', msg: 'permissions denied' });
      handle(method, body).then(([status, out]) => send(status, out), (e) => send(500, { code: 'internal', msg: String(e?.message ?? e) }));
    });
  });
  server.on('connection', (s) => {
    if (isDown) return s.destroy();
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const fake: FakeSfu = {
    url: `http://127.0.0.1:${port}`,
    key,
    secret,
    calls,
    rooms: rooms as unknown as FakeSfu['rooms'],
    async join(room, identity, opts = {}) {
      const r = roomOf(room);
      const old = r.participants.get(identity);
      // Mesma identidade de novo: o LiveKit derruba a sessão antiga (DUPLICATE_IDENTITY) e fica com a nova.
      if (old) await dropParticipant(room, r, old, 'participant_left', 'DUPLICATE_IDENTITY', opts.webhook !== false);
      const permission = permissionOf({ ...(opts.permission ?? {}), hidden: opts.hidden ?? opts.permission?.hidden ?? false });
      const p: FakeParticipant = { sid: opts.sid ?? rid('PA_'), identity, hidden: permission.hidden, joinedAt: now(), tracks: [], permission };
      r.participants.set(identity, p);
      await webhook('participant_joined', { room: roomInfo(room, r), participant: participantInfo(p) }, opts.webhook !== false);
      return p.sid;
    },
    async leave(room, identity, opts = {}) {
      const r = roomOf(room);
      const p = r.participants.get(identity);
      if (!p) return;
      const reason = opts.reason === 'UNKNOWN' ? 'UNKNOWN_REASON' : (opts.reason ?? 'CLIENT_INITIATED');
      await dropParticipant(room, r, p, 'participant_left', reason, opts.webhook !== false);
    },
    async abort(room, identity) {
      const r = roomOf(room);
      const p = r.participants.get(identity);
      if (!p) return;
      await dropParticipant(room, r, p, 'participant_connection_aborted', 'CONNECTION_TIMEOUT');
    },
    async publish(room, identity, t) {
      const r = roomOf(room);
      const p = r.participants.get(identity);
      if (!p) throw new Error(`${identity} não está na sala ${room} do LiveKit falso`);
      const allowedSources = p.permission.canPublishSources as string[];
      // O LiveKit recusa publicar fonte sem permissão; nem chega a haver track_published.
      if (!p.permission.canPublish || (allowedSources.length && !allowedSources.includes(SOURCE_ENUM[t.source]))) {
        throw new Error(`o LiveKit recusaria publicar ${t.source} para ${identity}`);
      }
      const track: SfuTrack = { sid: rid('TR_'), source: t.source, type: t.type, name: t.name, muted: false };
      p.tracks.push(track);
      await webhook('track_published', { room: { sid: r.sid, name: room }, participant: { sid: p.sid, identity }, track: trackInfo(track) });
      return track.sid;
    },
    async finish(room) {
      const r = roomOf(room);
      rooms.delete(room);
      await webhook('room_finished', { room: roomInfo(room, r) });
    },
    hold() {
      holding = true;
    },
    async release(opts = {}) {
      holding = false;
      const batch = held.splice(0, held.length);
      if (opts.order === 'reverse') batch.reverse();
      for (const body of batch) {
        await deliver(body);
        if (opts.twice) await deliver(body);
      }
    },
    delay(ms) {
      delayMs = ms;
    },
    restart() {
      rooms.clear();
    },
    down() {
      isDown = true;
      for (const s of sockets) s.destroy();
    },
    up() {
      isDown = false;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

// Grava o endereço, a chave e o segredo do LiveKit falso pelas configurações (como o admin faria).
export async function useFakeSfu(A: Auth, fake: FakeSfu): Promise<void> {
  const r = await api('POST', 'settings', { settings: { Calls_SFU_Url: fake.url, Calls_SFU_Api_Key: fake.key, Calls_SFU_Api_Secret: fake.secret } }, A);
  if (!r.success) throw new Error(`useFakeSfu: ${JSON.stringify(r)}`);
}
