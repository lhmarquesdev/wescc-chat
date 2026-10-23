import crypto from 'node:crypto';
import type { CallJoin } from '@shared/index';
import { resetSfuState } from '../src/calls/livekit';
import { flushCallTimers } from '../src/calls/model';
import { sweepCalls } from '../src/calls/sweep';
import { pool } from '../src/db/pool';
import { api, connectWs, urlOf, type Auth } from './helpers';
import { startFakeSfu, useFakeSfu, type FakeSfu } from './sfu-fake';

// Peças comuns dos testes de chamadas em grupo (LiveKit falso, salas, entrar e conectar, webhooks feitos à mão).

export async function setupSfu(A: Auth): Promise<FakeSfu> {
  const fake = await startFakeSfu({ webhookUrl: urlOf('/sfu-webhook') });
  await useFakeSfu(A, fake);
  resetSfuState();
  return fake;
}

// Espera os webhooks, as filas por chamada e os agrupamentos (call.room, cartão, presença, trava) terminarem.
export const settle = () => flushCallTimers();

export async function sweep() {
  await settle();
  await sweepCalls();
  await settle();
}

// Usuário com o chat aberto: WebSocket conectado e o id da conexão.
export async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  const connectionId = ws.events.find((e) => e.type === 'connected').connectionId as string;
  return { ...ws, connectionId };
}
export type Online = Awaited<ReturnType<typeof online>>;

// Um evento que chegue depois deste ponto (os anteriores não contam).
export function next(ws: Online, pred: (e: any) => boolean, ms = 5000) {
  const since = ws.events.length;
  return ws.waitFor((e) => ws.events.indexOf(e) >= since && pred(e), ms);
}
export const eventsSince = (ws: Online, since: number, pred: (e: any) => boolean) => ws.events.slice(since).filter(pred);

let seq = 0;
export async function channel(owner: Auth, members: Auth[], o: { private?: boolean } = {}): Promise<string> {
  const r = await api('POST', o.private ? 'groups.create' : 'channels.create', { name: `chamada-${Date.now().toString(36)}-${++seq}`, members: members.map((m) => m.username) }, owner);
  if (!r.success) throw new Error(`sala: ${JSON.stringify(r)}`);
  return (r.channel ?? r.group)._id as string;
}

export async function dm(a: Auth, others: Auth[]): Promise<string> {
  const r = await api('POST', 'im.create', others.length === 1 ? { username: others[0].username } : { usernames: others.map((u) => u.username).join(',') }, a);
  if (!r.success) throw new Error(`dm: ${JSON.stringify(r)}`);
  return r.room._id as string;
}

export const sfuRoom = (callId: string) => `wc_${callId}`;
export const start = (auth: Auth, rid: string, kind: 'audio' | 'video' = 'video', extra: Record<string, unknown> = {}) =>
  api('POST', 'calls.start', { roomId: rid, kind, engines: ['sfu', 'p2p'], ...extra }, auth);
export const join = (auth: Auth, callId: string, extra: Record<string, unknown> = {}) => api('POST', 'calls.join', { callId, engines: ['sfu', 'p2p'], ...extra }, auth);

// O navegador conecta no LiveKit com o token recebido (o falso manda o participant_joined).
export async function connect(fake: FakeSfu, callId: string, auth: Auth, j?: CallJoin, o: { sid?: string; webhook?: boolean } = {}) {
  const permission = j ? { canPublish: j.canPublish, canPublishSources: j.sources, hidden: j.hidden } : undefined;
  const sid = await fake.join(sfuRoom(callId), auth.userId, { permission, hidden: j?.hidden, ...o });
  await settle();
  return sid;
}

// Inicia e conecta (quem iniciou fica "joined").
export async function startIn(fake: FakeSfu, auth: Auth, rid: string, kind: 'audio' | 'video' = 'video') {
  const r = await start(auth, rid, kind);
  if (!r.success) throw new Error(`start: ${JSON.stringify(r)}`);
  const sid = await connect(fake, r.call._id, auth, r.join);
  return { id: r.call._id as string, call: r.call, join: r.join as CallJoin, sid };
}

// Entra e conecta.
export async function enter(fake: FakeSfu, auth: Auth, callId: string, extra: Record<string, unknown> = {}) {
  const r = await join(auth, callId, extra);
  if (!r.success) throw new Error(`join: ${JSON.stringify(r)}`);
  const sid = await connect(fake, callId, auth, r.join);
  return { ...r, sid };
}

export async function part(callId: string, userId: string) {
  return (await pool.query('SELECT * FROM call_participants WHERE call_id = $1 AND user_id = $2', [callId, userId])).rows[0];
}
export async function callRow(callId: string) {
  return (await pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
}

export const setSettings = async (A: Auth, settings: Record<string, unknown>) => {
  const r = await api('POST', 'settings', { settings }, A);
  if (!r.success) throw new Error(`settings: ${JSON.stringify(r)}`);
};

// Webhook assinado como o LiveKit assina (para mandar eventos fora de ordem, atrasados ou repetidos).
export async function hook(
  fake: FakeSfu,
  ev: { event: string; room: string; identity?: string; sid?: string; createdAt?: number; id?: string; reason?: string; track?: { sid: string; name: string; source: string } },
) {
  const body = JSON.stringify({
    event: ev.event,
    id: ev.id ?? `EV_${crypto.randomBytes(8).toString('hex')}`,
    createdAt: String(ev.createdAt ?? Math.floor(Date.now() / 1000)),
    room: { sid: 'RM_x', name: ev.room },
    ...(ev.identity ? { participant: { sid: ev.sid ?? 'PA_x', identity: ev.identity, ...(ev.reason ? { disconnectReason: ev.reason } : {}) } } : {}),
    ...(ev.track ? { track: { sid: ev.track.sid, name: ev.track.name, source: ev.track.source.toUpperCase() } } : {}),
  });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({ iss: fake.key, nbf: now, exp: now + 300, sha256: crypto.createHash('sha256').update(body).digest('base64') });
  const sig = crypto.createHmac('sha256', fake.secret).update(`${head}.${claims}`).digest('base64url');
  const res = await fetch(urlOf('/sfu-webhook'), { method: 'POST', headers: { 'content-type': 'application/webhook+json', authorization: `${head}.${claims}.${sig}` }, body });
  await settle();
  return res.status;
}

// Chamadas Twirp recebidas pelo LiveKit falso a partir de um ponto.
export const twirpSince = (fake: FakeSfu, from: number, method?: string) => fake.calls.slice(from).filter((c) => !method || c.method === method);
