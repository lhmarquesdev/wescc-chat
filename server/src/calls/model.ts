import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import type { Call, CallGuardState, CallParticipant, CallRoomRef, ServerEvent, UserRef } from '@shared/index';
import { CALL_LIMITS } from '@shared/calls';
import { many, one, pool, tx, type Queryable } from '../db/pool';
import { ApiError } from '../lib/errors';
import { bus, type Target } from '../realtime/bus';
import { sfu, sfuHealth } from './livekit';
import { drainCoalesced, enqueue } from './queue';
import { callViewsFor } from './views';

// Modelo das chamadas: a trava por chamada, os efeitos depois do commit e as leituras que todos usam.

export const LIVE = `('ringing', 'ongoing')`;
// "Presente": entrou, ou está entrando com um token de menos de 60 s.
export const presentSql = (p = 'p') =>
  `(${p}.state = 'joined' OR (${p}.state = 'joining' AND ${p}.token_at > now() - make_interval(secs => ${CALL_LIMITS.tokenSeconds})))`;

// ---------- Trava, efeitos e o LiveKit fora dela ----------

const lockScope = new AsyncLocalStorage<string>();
const violations: string[] = [];

// Todo acesso do servidor ao LiveKit passa por aqui. Nos testes, uma chamada dentro da trava falha (e fica anotada).
function outsideLock<A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return (...a: A) => {
    const inside = lockScope.getStore();
    if (inside && process.env.NODE_ENV === 'test') {
      violations.push(`${name} (${inside})`);
      return Promise.reject(new Error('LiveKit chamado dentro da trava'));
    }
    return f(...a);
  };
}

export const lk = {
  createRoom: outsideLock('createRoom', (name: string, o: { emptyTimeout: number; departureTimeout: number; maxParticipants: number }) => sfu.createRoom(name, o)),
  deleteRoom: outsideLock('deleteRoom', (name: string) => sfu.deleteRoom(name)),
  listRooms: outsideLock('listRooms', (names?: string[], o?: { timeoutMs?: number }) => sfu.listRooms(names, o)),
  listParticipants: outsideLock('listParticipants', (room: string, o?: { timeoutMs?: number }) => sfu.listParticipants(room, o)),
  removeParticipant: outsideLock('removeParticipant', (room: string, identity: string) => sfu.removeParticipant(room, identity)),
  updatePermission: outsideLock('updatePermission', (room: string, identity: string, p: Parameters<typeof sfu.updatePermission>[2]) => sfu.updatePermission(room, identity, p)),
  muteTrack: outsideLock('muteTrack', (room: string, identity: string, trackSid: string) => sfu.muteTrack(room, identity, trackSid)),
  health: outsideLock('sfuHealth', (force?: boolean) => sfuHealth(force)),
};

type Effect = { k: 'sfu'; fn: () => Promise<unknown> } | { k: 'pub'; t: Target; e: ServerEvent } | { k: 'after'; fn: () => unknown };

// Efeitos de uma operação: rodam em ordem depois do COMMIT, fora da transação. Falha de efeito não desfaz nada.
export class Effects {
  private list: Effect[] = [];
  readonly pushed = new Set<string>(); // quem já recebeu permissão nova nesta transação (applyGrantsTx)
  sfu(fn: () => Promise<unknown>) {
    this.list.push({ k: 'sfu', fn });
  }
  publish(t: Target, e: ServerEvent) {
    this.list.push({ k: 'pub', t, e });
  }
  after(fn: () => unknown) {
    this.list.push({ k: 'after', fn });
  }
  async run(callId: string) {
    const items = this.list;
    this.list = [];
    if (!items.length) return;
    // LiveKit e eventos em ordem por chamada (uma pausa nunca chega depois da liberação que veio depois dela).
    await enqueue(`fx:${callId}`, async () => {
      for (const it of items) {
        if (it.k === 'pub') bus.publish(it.t, it.e);
        else if (it.k === 'sfu') await it.fn().catch((e) => logFx(callId, e));
      }
    });
    for (const it of items) if (it.k === 'after') await Promise.resolve().then(it.fn).catch((e) => logFx(callId, e));
  }
}

function logFx(callId: string, e: unknown) {
  console.error(`[chamadas] efeito da chamada ${callId} falhou: ${(e as Error)?.message ?? e}`);
}

export type Db = pg.PoolClient;

const busyError = () => new ApiError(503, 'error-call-busy', 'A chamada está ocupada com muitas entradas ao mesmo tempo. Tente de novo.');

async function advisoryLock(c: Db, sql: string, params: unknown[]) {
  try {
    await c.query(sql, params);
  } catch (e) {
    if ((e as any)?.code === '55P03') throw busyError();
    throw e;
  }
}

// Fila da instância, depois a trava do banco (727110, hashtext(callId)) com lock_timeout; os efeitos vêm depois do commit.
export async function withCallLock<T>(callId: string, fn: (c: Db, fx: Effects) => Promise<T>): Promise<T> {
  const fx = new Effects();
  const out = await enqueue(callId, () =>
    lockScope.run(callId, () =>
      tx(async (c) => {
        await c.query(`SET LOCAL lock_timeout = '3s'`);
        await advisoryLock(c, 'SELECT pg_advisory_xact_lock(727110, hashtext($1))', [callId]);
        return fn(c, fx);
      }),
    ),
  );
  await fx.run(callId);
  return out;
}

// Trava curta do servidor inteiro (727110, 0), sempre depois da trava da chamada, na transação de quem entra, inicia
// ou atende (em grupo ou a dois): a contagem de presentes e a gravação da entrada não se cruzam entre chamadas
// diferentes (limite do servidor e uma chamada por pessoa, também entre instâncias).
export async function lockEntries(c: Db) {
  await advisoryLock(c, 'SELECT pg_advisory_xact_lock(727110, 0)', []);
}

// Salas do LiveKit vistas por esta instância (webhook ou reconciliação) nos últimos segundos.
const seen = new Map<string, number>();
export function markRoomSeen(callId: string) {
  seen.set(callId, Date.now());
  if (seen.size > 5000) for (const [k, t] of seen) if (t < Date.now() - 60_000) seen.delete(k);
}
export function roomSeenRecently(callId: string, ms = 30_000) {
  return (seen.get(callId) ?? 0) > Date.now() - ms;
}

// ---------- Leituras ----------

export const CALL_SELECT = `SELECT c.*, a.username AS caller_username, a.name AS caller_name, b.username AS callee_username, b.name AS callee_name,
    e.username AS ended_by_username, e.name AS ended_by_name
  FROM calls c JOIN users a ON a.id = c.caller_id LEFT JOIN users b ON b.id = c.callee_id LEFT JOIN users e ON e.id = c.ended_by`;

export async function loadCallRow(id: string, db: Queryable = pool) {
  const r = await one(`${CALL_SELECT} WHERE c.id = $1`, [id], db);
  if (r) rememberScope(r.id, r.scope);
  return r;
}

// O escopo de uma chamada nunca muda. Guardado aqui, sair e atender escolhem o caminho (a dois ou em grupo) sem ir ao
// banco: numa saída em massa, 300 pedidos ao mesmo tempo não disputam o pool antes da fila de saídas.
const scopes = new Map<string, 'direct' | 'group'>();
function rememberScope(id: string, scope: 'direct' | 'group') {
  if (scopes.has(id)) return;
  scopes.set(id, scope);
  if (scopes.size > 5000) scopes.delete(scopes.keys().next().value!);
}

export async function callScope(id: string): Promise<'direct' | 'group' | null> {
  const known = scopes.get(id);
  if (known) return known;
  const r = await one(`SELECT id, scope FROM calls WHERE id = $1`, [id]);
  if (r) rememberScope(r.id, r.scope);
  return r?.scope ?? null;
}

export async function loadCall(id: string, db: Queryable = pool) {
  const r = await loadCallRow(id, db);
  if (!r) throw new ApiError(404, 'error-call-not-found', 'Chamada não encontrada.');
  return r;
}

export const isLive = (r: any) => r.status === 'ringing' || r.status === 'ongoing';

const ms = (v: string | null) => (v ? new Date(v).getTime() : null);

export interface CallStats {
  present: number;
  totalJoined: number;
  sample: UserRef[];
}

export function mapCall(r: any, x: Partial<CallStats> & { guard?: CallGuardState; room?: CallRoomRef; participants?: CallParticipant[] } = {}): Call {
  const created = ms(r.created_at)!;
  const answered = ms(r.answered_at);
  const ended = ms(r.ended_at);
  const group = r.scope === 'group';
  const start = group ? created : answered;
  const call: Call = {
    _id: r.id,
    rid: r.room_id,
    kind: r.kind,
    status: r.status,
    scope: r.scope,
    media: r.media,
    caller: { _id: r.caller_id, username: r.caller_username, name: r.caller_name },
    callee: r.callee_id ? { _id: r.callee_id, username: r.callee_username, name: r.callee_name } : null,
    callerConnectionId: r.caller_conn ?? null,
    calleeConnectionId: r.callee_conn ?? null,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    endedReason: r.ended_reason ?? null,
    duration: start && ended ? Math.max(0, Math.round((ended - start) / 1000)) : null,
    listenOnly: !!r.listen_only,
    participantsCount: x.present ?? 0,
    sample: x.sample ?? [],
    peak: group ? r.peak : r.answered_at ? 2 : 1,
    totalJoined: x.totalJoined ?? 0,
    guardUntil: r.guard_until ?? null,
    messageId: r.message_id ?? null,
  };
  if (x.guard) call.guard = x.guard;
  if (x.room) call.room = x.room;
  if (x.participants) call.participants = x.participants;
  return call;
}

// Presentes, quem já entrou e a amostra (até 5): presentes por ordem de chegada; encerrada, os primeiros que entraram.
// Em transmissões, só quem fala aparece na amostra.
export async function loadStats(ids: string[], db: Queryable = pool): Promise<Map<string, CallStats>> {
  const out = new Map<string, CallStats>(ids.map((id) => [id, { present: 0, totalJoined: 0, sample: [] }]));
  if (!ids.length) return out;
  const counts = await many(
    `SELECT p.call_id, count(*) FILTER (WHERE ${presentSql()} AND c.status IN ${LIVE})::int AS present,
            count(*) FILTER (WHERE p.joined_at IS NOT NULL)::int AS total
       FROM call_participants p JOIN calls c ON c.id = p.call_id WHERE p.call_id = ANY($1) GROUP BY p.call_id`,
    [ids],
    db,
  );
  for (const r of counts) Object.assign(out.get(r.call_id)!, { present: r.present, totalJoined: r.total });
  const sample = await many(
    `SELECT call_id, id, username, name FROM (
       SELECT p.call_id, u.id, u.username, u.name,
              row_number() OVER (PARTITION BY p.call_id ORDER BY CASE WHEN c.status IN ${LIVE} THEN p.last_joined_at ELSE p.joined_at END, u.username) AS n
         FROM call_participants p JOIN calls c ON c.id = p.call_id JOIN users u ON u.id = p.user_id
        WHERE p.call_id = ANY($1)
          AND CASE WHEN c.status IN ${LIVE} THEN ${presentSql()} ELSE p.joined_at IS NOT NULL END
          AND (NOT c.listen_only OR NOT p.granted_hidden)
     ) x WHERE n <= ${CALL_LIMITS.sampleSize} ORDER BY call_id, n`,
    [ids],
    db,
  );
  for (const s of sample) out.get(s.call_id)!.sample.push({ _id: s.id, username: s.username, name: s.name });
  return out;
}

// Linhas de participantes com o usuário e os papéis na sala, numa consulta.
export async function loadParticipants(callId: string, db: Queryable = pool) {
  return many(
    `SELECT p.*, u.username, u.name, u.roles AS global_roles, u.active, u.type, s.roles AS room_roles, (s.id IS NOT NULL) AS member
       FROM call_participants p JOIN calls c ON c.id = p.call_id JOIN users u ON u.id = p.user_id
       LEFT JOIN subscriptions s ON s.room_id = c.room_id AND s.user_id = p.user_id
      WHERE p.call_id = $1
      ORDER BY (p.state IN ('joined', 'joining')) DESC, p.last_joined_at NULLS LAST, p.rung_at NULLS LAST, u.username`,
    [callId],
    db,
  );
}

export async function presentIds(callId: string, db: Queryable = pool): Promise<string[]> {
  return (await many(`SELECT user_id FROM call_participants p WHERE call_id = $1 AND ${presentSql()}`, [callId], db)).map((r) => r.user_id);
}

// Pessoas presentes em chamadas vivas pelo servidor de chamadas (limite do servidor).
export async function totalPresent(db: Queryable = pool): Promise<number> {
  const r = await one(
    `SELECT count(*)::int AS n FROM call_participants p JOIN calls c ON c.id = p.call_id
      WHERE c.status IN ${LIVE} AND c.media = 'sfu' AND ${presentSql()}`,
    [],
    db,
  );
  return r?.n ?? 0;
}

export async function liveCallOfRoom(rid: string, db: Queryable = pool) {
  return one(`${CALL_SELECT} WHERE c.room_id = $1 AND c.scope = 'group' AND c.status = 'ongoing'`, [rid], db);
}

// A chamada em que a pessoa está: a dois, quem liga ou recebe (mesmo tocando, como sempre); em grupo, quem está
// presente. hiddenToo false: ouvinte oculto de transmissão não conta (pode receber uma ligação).
export async function activeCallOf(userId: string, o: { except?: string; hiddenToo?: boolean } = {}, db: Queryable = pool) {
  const direct = await one(
    `SELECT id, scope FROM calls WHERE scope = 'direct' AND status IN ${LIVE} AND (caller_id = $1 OR callee_id = $1) AND ($2::text IS NULL OR id <> $2)
      ORDER BY created_at DESC LIMIT 1`,
    [userId, o.except ?? null],
    db,
  );
  return direct ?? currentCallOf(userId, { except: o.except, hiddenToo: o.hiddenToo }, db);
}

// A chamada viva em que a pessoa está presente (uma por vez). hiddenToo: conta também quem só ouve.
export async function currentCallOf(userId: string, o: { except?: string; hiddenToo?: boolean } = {}, db: Queryable = pool) {
  return one(
    `SELECT c.id, c.scope, c.media, c.status FROM call_participants p JOIN calls c ON c.id = p.call_id
      WHERE p.user_id = $1 AND p.state IN ('joining', 'joined') AND ${presentSql()} AND c.status IN ${LIVE}
        AND ($2::text IS NULL OR c.id <> $2) AND ($3 OR NOT p.granted_hidden)
      ORDER BY c.created_at DESC LIMIT 1`,
    [userId, o.except ?? null, o.hiddenToo !== false],
    db,
  );
}

// A ponte do /sfu: só quem tem linha viva (entrando com token novo, ou já dentro), ainda é membro e está ativo, com o
// mesmo hidden que o servidor concedeu. Uma consulta pela chave primária.
export async function bridgeAdmission(o: { identity: string; sfuRoom: string; hidden: boolean }): Promise<{ ok: true } | { ok: false; status: 403 }> {
  const m = /^wc_([A-Za-z0-9]+)$/.exec(o.sfuRoom ?? '');
  if (!m || typeof o.identity !== 'string' || !o.identity) return { ok: false, status: 403 };
  const r = await one(
    `SELECT 1 FROM calls c
       JOIN call_participants p ON p.call_id = c.id AND p.user_id = $2
       JOIN users u ON u.id = p.user_id AND u.active
       JOIN subscriptions s ON s.room_id = c.room_id AND s.user_id = p.user_id
      WHERE c.id = $1 AND c.sfu_room = $3 AND c.media = 'sfu' AND c.status IN ${LIVE}
        AND ${presentSql()} AND p.granted_hidden = $4`,
    [m[1], o.identity, o.sfuRoom, !!o.hidden],
  );
  return r ? { ok: true } : { ok: false, status: 403 };
}

// ---------- Salas ----------

export async function loadRoomInfo(rid: string, db: Queryable = pool) {
  const r = await one(
    `SELECT r.*, (SELECT m.t FROM teams tm JOIN rooms m ON m.id = tm.room_id WHERE tm.id = r.team_id) AS team_main_t
       FROM rooms r WHERE r.id = $1`,
    [rid],
    db,
  );
  if (r) r.private_team = r.team_main_t === 'p';
  return r;
}

export function roomRef(r: any): CallRoomRef {
  const ref: CallRoomRef = { _id: r.id, t: r.t, name: r.name ?? null, fname: r.fname ?? null };
  if (r.prid) ref.prid = r.prid;
  if (r.team_main) ref.teamMain = true;
  if (r.notice) ref.notice = true;
  if (r.broadcast) ref.broadcast = true;
  if (r.t === 'd') ref.usernames = r.usernames ?? [];
  return ref;
}

// Caminho da sala na web (para push e para o "#call").
export function roomPath(r: any) {
  const base = r.t === 'd' ? 'direct' : r.t === 'p' ? 'group' : r.t === 'l' ? 'live' : 'channel';
  return `/${base}/${r.id}`;
}

// ---------- Publicação ----------

// Cada evento do bus também vira um pg_notify no pool (para as outras instâncias). Os eventos de uma pessoa por vez
// (dezenas de uma vez, de várias chamadas) passam por uma fila única da instância, em lotes de 8: um lote só sai quando o
// pool tem conexões livres para ele e ainda sobram 4 (espera no máximo 250 ms), para o chat nunca esperar atrás das
// chamadas. A ordem dos eventos é mantida.
const FANOUT_SLICE = 8;
const roomForSlice = () => pool.waitingCount === 0 && (pool.options.max ?? 10) - pool.totalCount + pool.idleCount >= FANOUT_SLICE + 4;
const fanout: { t: Target; e: ServerEvent; done?: () => void }[] = [];
let pumping = false;

async function pumpFanout() {
  if (pumping) return;
  pumping = true;
  try {
    while (fanout.length) {
      for (let waited = 0; !roomForSlice() && waited < 250; waited += 2) await new Promise((r) => setTimeout(r, 2));
      for (const it of fanout.splice(0, FANOUT_SLICE)) {
        bus.publish(it.t, it.e);
        it.done?.();
      }
      if (fanout.length) await new Promise((r) => setImmediate(r));
    }
  } finally {
    pumping = false;
  }
}

export function publishEach(list: [Target, ServerEvent][]): Promise<void> {
  if (!list.length) return Promise.resolve();
  return new Promise<void>((resolve) => {
    list.forEach(([t, e], i) => fanout.push({ t, e, done: i === list.length - 1 ? resolve : undefined }));
    void pumpFanout();
  });
}

// Evento "call": a dois, para os dois lados (todos os aparelhos), como sempre; em grupo, para cada presente com o seu
// "mine" (início, trava, anfitrião, fim; §5.20). extra: quem acabou de sair também recebe.
export async function publishCall(callId: string, extra: string[] = []) {
  const row = await loadCallRow(callId);
  if (!row) return;
  if (row.scope === 'direct') {
    const stats = (await loadStats([row.id])).get(row.id)!;
    bus.publish({ users: [row.caller_id, row.callee_id].filter(Boolean) }, { type: 'call', call: mapCall(row, stats) });
    return;
  }
  await publishViews(row, [...new Set([...(await presentIds(callId)), ...extra])]);
}

// Só para estas pessoas (todos os aparelhos de cada uma): quem saiu, foi removido ou teve a fala mudada. Os outros
// presentes não precisam de um "call" novo por isso: a contagem chega no call.room e as pessoas, pelo LiveKit.
export async function publishCallTo(callId: string, userIds: string[]) {
  const row = await loadCallRow(callId);
  if (!row || row.scope !== 'group') return;
  await publishViews(row, [...new Set(userIds)]);
}

async function publishViews(row: any, ids: string[]) {
  if (!ids.length) return;
  const views = await callViewsFor(row, ids);
  await publishEach([...views].map(([userId, call]): [Target, ServerEvent] => [{ user: userId }, { type: 'call', call }]));
}

// ---------- Ganchos de teste ----------

function testOnly(name: string) {
  if (process.env.NODE_ENV !== 'test') throw new Error(`${name} só existe nos testes`);
}

// Roda já os agrupamentos pendentes (call.room, cartão, presença, trava, permissões) e espera as filas esvaziarem.
export async function flushCallTimers() {
  testOnly('flushCallTimers');
  await drainCoalesced();
}

export async function runGuardNow(callId: string) {
  testOnly('runGuardNow');
  const { evaluateGuardNow } = await import('./guard');
  await evaluateGuardNow(callId);
  await drainCoalesced();
}

// Chamadas ao LiveKit que aconteceram dentro da trava (deve ficar vazio).
export function lockViolations() {
  testOnly('lockViolations');
  return [...violations];
}
