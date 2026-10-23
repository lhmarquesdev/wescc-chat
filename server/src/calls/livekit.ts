import crypto from 'node:crypto';
import { CALL_LIMITS } from '@shared/calls';
import type { CallSource } from '@shared/index';
import { config } from '../config';
import { getSetting } from '../services/settings';

// Servidor de chamadas (LiveKit): tokens de entrada, a API Twirp e os webhooks assinados. Código nosso, sem o SDK:
// HS256 com node:crypto e a API com fetch.

export interface SfuConfig { url: string; apiKey: string; apiSecret: string; configured: boolean }

// config.livekit.* (Fase H) têm precedência sobre Calls_SFU_*
export function sfuConfig(): SfuConfig {
  const url = (config.livekit.url ?? String(getSetting('Calls_SFU_Url') ?? '')).trim().replace(/\/+$/, '');
  const apiKey = (config.livekit.apiKey ?? String(getSetting('Calls_SFU_Api_Key') ?? '')).trim();
  const apiSecret = config.livekit.apiSecret ?? String(getSetting('Calls_SFU_Api_Secret') ?? '');
  return { url, apiKey, apiSecret, configured: !!(url && apiKey && apiSecret) };
}

// ---------- JWT (HS256) ----------

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const hmac = (data: string, secret: string) => crypto.createHmac('sha256', secret).update(data).digest();
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(hmac(`${head}.${body}`, secret))}`;
}

function decodePart(s: string): any {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Só HS256, assinatura conferida em tempo constante, exp obrigatório; nbf aceita a folga (o relógio de quem assinou).
export function verifyJwt(token: string, secret: string, opts: { issuer?: string; leewaySeconds?: number } = {}): Record<string, any> | null {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [head, body, sig] = parts;
  const header = decodePart(head);
  if (!header || header.alg !== 'HS256') return null;
  const expected = hmac(`${head}.${body}`, secret);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  const claims = decodePart(body);
  if (!claims) return null;
  const now = nowSeconds();
  const leeway = opts.leewaySeconds ?? 10;
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + leeway)) return null;
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) return null;
  return claims;
}

// ---------- Tokens de entrada ----------

export interface JoinGrant { room: string; identity: string; canPublish: boolean; sources: CallSource[] | null; hidden: boolean; ttlSeconds?: number }

// Sem nome, metadados ou atributos, e sem direito de mudá-los nem de mandar dados: seriam um canal escondido.
export function joinToken(g: JoinGrant): { token: string; expiresAt: string } {
  const c = sfuConfig();
  if (!c.configured) throw new SfuError('not_configured', 'Servidor de chamadas não configurado.');
  const now = nowSeconds();
  const exp = now + (g.ttlSeconds ?? CALL_LIMITS.tokenSeconds);
  const video: Record<string, unknown> = {
    roomJoin: true,
    room: g.room,
    canSubscribe: true,
    canPublish: g.canPublish,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: g.hidden,
  };
  // sources null: sem lista (só o autoteste, que publica uma faixa sem fonte)
  if (g.sources !== null) video.canPublishSources = [...g.sources];
  const token = signJwt({ iss: c.apiKey, sub: g.identity, nbf: now - 5, exp, video }, c.apiSecret);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

// Lê as permissões de um token de entrada (o nosso ou um renovado pelo LiveKit) para a ponte, como o LiveKit as lê:
// canPublish ausente vale true; sources null (lista ausente ou vazia) libera todas as fontes.
export interface JoinClaims { identity: string; room: string; hidden: boolean; nbf: number; exp: number; canPublish: boolean; sources: string[] | null; forbidden: string | null }

const CALL_ROOM = /^wc_[A-Za-z0-9]+$/;
const TEST_ROOM = /^wc_test_[A-Za-z0-9]+$/;
const FORBIDDEN_GRANTS = ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin', 'recorder', 'agent', 'canUpdateOwnMetadata'];

export function parseJoinClaims(claims: Record<string, any>): JoinClaims {
  const v = claims?.video && typeof claims.video === 'object' ? claims.video : {};
  const identity = typeof claims?.sub === 'string' ? claims.sub : '';
  const room = typeof v.room === 'string' ? v.room : '';
  const canPublish = v.canPublish !== false;
  const sources = Array.isArray(v.canPublishSources) && v.canPublishSources.length ? v.canPublishSources.map(String) : null;
  // Sem canPublishData, o LiveKit segue o canPublish.
  const canPublishData = typeof v.canPublishData === 'boolean' ? v.canPublishData : canPublish;
  let forbidden: string | null = null;
  if (v.roomJoin !== true) forbidden = 'roomJoin';
  else if (!CALL_ROOM.test(room) && !TEST_ROOM.test(room)) forbidden = 'room';
  else if (!identity) forbidden = 'sub';
  else forbidden = FORBIDDEN_GRANTS.find((k) => v[k] === true) ?? (canPublishData ? 'canPublishData' : null);
  return { identity, room, hidden: v.hidden === true, nbf: Number(claims?.nbf ?? 0), exp: Number(claims?.exp ?? 0), canPublish, sources, forbidden };
}

export class SfuError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); }
}

// ---------- Formatos normalizados ----------

export interface SfuTrack { sid: string; source: CallSource | 'unknown'; type: 'audio' | 'video' | 'data'; name: string; muted: boolean }
export interface SfuParticipant {
  sid: string;
  identity: string;
  state: string;
  joinedAt: number; // segundos
  tracks: SfuTrack[];
  permission: { canPublish: boolean; canPublishSources: CallSource[]; canPublishData: boolean; canUpdateMetadata: boolean; hidden: boolean };
}
export interface SfuRoom { name: string; numParticipants: number; creationTime: number } // segundos

// protojson: int64 em texto, campos no valor padrão omitidos, enums pelo nome. Lê também o nome do proto
// (snake_case), que é o que alguns servidores Twirp devolvem.
function field(o: any, camel: string): any {
  if (!o || typeof o !== 'object') return undefined;
  if (o[camel] !== undefined) return o[camel];
  return o[camel.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)];
}
const num = (x: unknown) => Number(x ?? 0) || 0;
const text = (x: unknown) => (x == null ? '' : String(x));
const flag = (x: unknown) => (x ?? false) === true;
const list = (x: unknown): any[] => (Array.isArray(x) ? x : []);

const SOURCE_NAMES: Record<string, CallSource> = { MICROPHONE: 'microphone', CAMERA: 'camera', SCREEN_SHARE: 'screen_share', SCREEN_SHARE_AUDIO: 'screen_share_audio' };
const SOURCE_NUMBERS: Record<number, CallSource> = { 1: 'camera', 2: 'microphone', 3: 'screen_share', 4: 'screen_share_audio' };
const SOURCE_ENUM: Record<CallSource, string> = { microphone: 'MICROPHONE', camera: 'CAMERA', screen_share: 'SCREEN_SHARE', screen_share_audio: 'SCREEN_SHARE_AUDIO' };

function sourceOf(x: unknown): CallSource | 'unknown' {
  if (typeof x === 'number') return SOURCE_NUMBERS[x] ?? 'unknown';
  return SOURCE_NAMES[text(x).toUpperCase()] ?? 'unknown';
}

// AUDIO é o valor padrão do enum: vem omitido.
function trackTypeOf(x: unknown): 'audio' | 'video' | 'data' {
  if (x === 1 || x === 'VIDEO') return 'video';
  if (x === 2 || x === 'DATA') return 'data';
  return 'audio';
}

const PARTICIPANT_STATES = ['JOINING', 'JOINED', 'ACTIVE', 'DISCONNECTED'];
const DISCONNECT_REASONS = [
  'UNKNOWN_REASON', 'CLIENT_INITIATED', 'DUPLICATE_IDENTITY', 'SERVER_SHUTDOWN', 'PARTICIPANT_REMOVED', 'ROOM_DELETED',
  'STATE_MISMATCH', 'JOIN_FAILURE', 'MIGRATION', 'SIGNAL_CLOSE', 'ROOM_CLOSED', 'USER_UNAVAILABLE', 'USER_REJECTED',
  'SIP_TRUNK_FAILURE', 'CONNECTION_TIMEOUT', 'MEDIA_FAILURE',
];

function enumName(x: unknown, names: string[]): string {
  if (typeof x === 'number') return names[x] ?? String(x);
  return x == null || x === '' ? names[0] : String(x);
}

function normTrack(t: any): SfuTrack {
  return { sid: text(field(t, 'sid')), source: sourceOf(field(t, 'source')), type: trackTypeOf(field(t, 'type')), name: text(field(t, 'name')), muted: flag(field(t, 'muted')) };
}

function normParticipant(p: any): SfuParticipant {
  const perm = field(p, 'permission') ?? {};
  return {
    sid: text(field(p, 'sid')),
    identity: text(field(p, 'identity')),
    state: enumName(field(p, 'state'), PARTICIPANT_STATES),
    joinedAt: num(field(p, 'joinedAt')),
    tracks: list(field(p, 'tracks')).map(normTrack),
    permission: {
      canPublish: flag(field(perm, 'canPublish')),
      canPublishSources: list(field(perm, 'canPublishSources')).map(sourceOf).filter((s): s is CallSource => s !== 'unknown'),
      canPublishData: flag(field(perm, 'canPublishData')),
      canUpdateMetadata: flag(field(perm, 'canUpdateMetadata')),
      hidden: flag(field(perm, 'hidden')),
    },
  };
}

function normRoom(r: any): SfuRoom {
  return { name: text(field(r, 'name')), numParticipants: num(field(r, 'numParticipants')), creationTime: num(field(r, 'creationTime')) };
}

// ---------- Twirp ----------

type Grant = Record<string, unknown>;

async function twirp(method: string, body: Record<string, unknown>, grant: Grant, timeoutMs = 5000): Promise<any> {
  const c = sfuConfig();
  if (!c.configured) throw new SfuError('not_configured', 'Servidor de chamadas não configurado.');
  const now = nowSeconds();
  const token = signJwt({ iss: c.apiKey, nbf: now, exp: now + 60, video: grant }, c.apiSecret);
  let res: Response;
  try {
    res = await fetch(`${c.url}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Rede ou tempo esgotado: para quem chama, as duas são "sem resposta".
    throw new SfuError('unreachable', `Sem resposta de ${c.url}.`);
  }
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    throw new SfuError('unreachable', `Sem resposta de ${c.url}.`);
  }
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) throw new SfuError(typeof data?.code === 'string' ? data.code : `http_${res.status}`, typeof data?.msg === 'string' ? data.msg : res.statusText, res.status);
  return data ?? {};
}

const admin = (room: string): Grant => ({ roomAdmin: true, room });
const isNotFound = (e: unknown) => e instanceof SfuError && (e.code === 'not_found' || e.status === 404);

// O servidor Twirp do LiveKit descarta campos que não conhece (o 1.13 aceita e ignora revokeTokenTs). Um servidor que
// recusasse o corpo responderia malformed, com um texto fixo que não cita o campo: aí tenta uma vez sem ele e, se
// passar, guarda isso para o processo.
let revokeUnsupported = false;
const malformed = (e: unknown) => e instanceof SfuError && e.code === 'malformed';

export const sfu = {
  // já existe: não é erro
  async createRoom(name: string, o: { emptyTimeout: number; departureTimeout: number; maxParticipants: number }): Promise<void> {
    try {
      await twirp('CreateRoom', { name, emptyTimeout: o.emptyTimeout, departureTimeout: o.departureTimeout, maxParticipants: o.maxParticipants }, { roomCreate: true });
    } catch (e) {
      if (!(e instanceof SfuError && e.code === 'already_exists')) throw e;
    }
  },
  // sala inexistente não é erro
  async deleteRoom(name: string): Promise<void> {
    try {
      await twirp('DeleteRoom', { room: name }, { roomCreate: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  },
  async listRooms(names?: string[], o: { timeoutMs?: number } = {}): Promise<SfuRoom[]> {
    const data = await twirp('ListRooms', { names: names ?? [] }, { roomList: true }, o.timeoutMs);
    return list(field(data, 'rooms')).map(normRoom);
  },
  // sala inexistente: SfuError('not_found'). O LiveKit 1.13 responde lista vazia para sala que não existe, então
  // uma lista vazia é conferida no ListRooms (é o que mostra que o LiveKit reiniciou).
  async listParticipants(room: string, o: { timeoutMs?: number } = {}): Promise<SfuParticipant[]> {
    let data: any;
    try {
      data = await twirp('ListParticipants', { room }, admin(room), o.timeoutMs);
    } catch (e) {
      if (isNotFound(e)) throw new SfuError('not_found', (e as SfuError).message, 404);
      throw e;
    }
    const people = list(field(data, 'participants')).map(normParticipant);
    if (!people.length && !(await sfu.listRooms([room], o)).some((r) => r.name === room)) {
      throw new SfuError('not_found', 'requested room does not exist', 404);
    }
    return people;
  },
  // ausente não é erro; pede que os tokens já emitidos deixem de valer (o 1.13 ignora: quem barra a volta é a ponte)
  async removeParticipant(room: string, identity: string): Promise<void> {
    const send = (revoke: boolean) =>
      twirp('RemoveParticipant', revoke ? { room, identity, revokeTokenTs: String(nowSeconds()) } : { room, identity }, admin(room));
    try {
      await send(!revokeUnsupported);
    } catch (e) {
      if (isNotFound(e)) return;
      if (revokeUnsupported || !malformed(e)) throw e;
      try {
        await send(false);
      } catch (e2) {
        if (!isNotFound(e2)) throw e2;
      }
      revokeUnsupported = true;
    }
  },
  // A permissão é trocada inteira: fontes valem mais que canPublish, então uma pausa nunca leva lista.
  async updatePermission(room: string, identity: string, p: { canPublish: boolean; sources: CallSource[]; hidden: boolean }): Promise<void> {
    if (p.canPublish && !p.sources.length) throw new Error('fontes vazias');
    const permission = {
      canSubscribe: true,
      canPublish: p.canPublish,
      canPublishData: false,
      canUpdateMetadata: false,
      hidden: p.hidden,
      canPublishSources: p.canPublish ? p.sources.map((s) => SOURCE_ENUM[s]) : [],
    };
    await twirp('UpdateParticipant', { room, identity, permission }, admin(room));
  },
  // Não existe o contrário: ninguém liga o microfone de outra pessoa.
  async muteTrack(room: string, identity: string, trackSid: string): Promise<void> {
    await twirp('MutePublishedTrack', { room, identity, trackSid, muted: true }, admin(room));
  },
};

// ---------- Saúde ----------

type Health = { ok: boolean; latencyMs: number | null; rooms?: number; participants?: number; error?: string };
let healthCache: { key: string; at: number; value: Health } | null = null;
let healthInFlight: { key: string; promise: Promise<Health> } | null = null;
const HEALTH_TTL = 15_000;

function healthError(e: unknown, url: string): string {
  if (e instanceof SfuError) {
    if (e.code === 'not_configured') return 'Servidor de chamadas não configurado.';
    if (e.code === 'unreachable') return `Sem resposta de ${url}.`;
    if (e.status === 401 || e.code === 'unauthenticated') return 'A chave ou o segredo da API do LiveKit não conferem.';
    return `O servidor de chamadas respondeu com erro (${e.code}).`;
  }
  return `O servidor de chamadas respondeu com erro (${(e as Error)?.message ?? e}).`;
}

export async function sfuHealth(force = false): Promise<Health> {
  const c = sfuConfig();
  if (!c.configured) return { ok: false, latencyMs: null, error: 'Servidor de chamadas não configurado.' };
  // A chave do cache muda quando o endereço, a chave ou o segredo mudam.
  const key = crypto.createHash('sha256').update(`${c.url}\n${c.apiKey}\n${c.apiSecret}`).digest('base64');
  if (!force && healthCache && healthCache.key === key && Date.now() - healthCache.at < HEALTH_TTL) return healthCache.value;
  if (healthInFlight && healthInFlight.key === key) return healthInFlight.promise;
  const promise = (async (): Promise<Health> => {
    const started = Date.now();
    let value: Health;
    try {
      const rooms = await sfu.listRooms([], { timeoutMs: 3000 });
      value = { ok: true, latencyMs: Date.now() - started, rooms: rooms.length, participants: rooms.reduce((n, r) => n + r.numParticipants, 0) };
    } catch (e) {
      value = { ok: false, latencyMs: null, error: healthError(e, c.url) };
    }
    healthCache = { key, at: Date.now(), value };
    return value;
  })();
  healthInFlight = { key, promise };
  try {
    return await promise;
  } finally {
    if (healthInFlight?.promise === promise) healthInFlight = null;
  }
}

// Testes: esquece o cache da saúde e o que se soube do revokeTokenTs.
export function resetSfuState() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetSfuState só existe nos testes');
  healthCache = null;
  healthInFlight = null;
  revokeUnsupported = false;
}

// ---------- Webhooks ----------

export interface SfuWebhookEvent {
  event: string;
  id: string | null;
  createdAt: number; // segundos
  room: { sid: string; name: string } | null;
  participant: { sid: string; identity: string; disconnectReason: string | null } | null;
  track: { sid: string; name: string; source: CallSource | 'unknown' } | null;
}

// Aceita "Bearer <jwt>" ou o JWT puro; o sha256 do token tem de ser o do corpo cru.
export function verifyWebhook(rawBody: string, authorization: string | undefined): SfuWebhookEvent | null {
  const c = sfuConfig();
  if (!c.configured || typeof authorization !== 'string' || typeof rawBody !== 'string') return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const claims = verifyJwt(token, c.apiSecret, { issuer: c.apiKey });
  if (!claims || typeof claims.sha256 !== 'string') return null;
  const expected = Buffer.from(crypto.createHash('sha256').update(rawBody, 'utf8').digest('base64'));
  const got = Buffer.from(claims.sha256);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let b: any;
  try {
    b = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object') return null;
  const room = field(b, 'room');
  const p = field(b, 'participant');
  const t = field(b, 'track');
  const reason = p ? enumName(field(p, 'disconnectReason'), DISCONNECT_REASONS) : null;
  return {
    event: text(field(b, 'event')),
    id: field(b, 'id') ? text(field(b, 'id')) : null,
    createdAt: num(field(b, 'createdAt')),
    room: room ? { sid: text(field(room, 'sid')), name: text(field(room, 'name')) } : null,
    participant: p ? { sid: text(field(p, 'sid')), identity: text(field(p, 'identity')), disconnectReason: reason && reason !== 'UNKNOWN_REASON' ? reason : null } : null,
    track: t ? { sid: text(field(t, 'sid')), name: text(field(t, 'name')), source: sourceOf(field(t, 'source')) } : null,
  };
}
