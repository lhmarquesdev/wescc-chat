import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_GUARD_CLEARED, CALL_GUARD_ENDED, CALL_GUARD_JOIN, callGuardText, callStartBlockMessage } from '@shared/calls';
import { lockViolations, runGuardNow } from '../src/calls/model';
import { pool } from '../src/db/pool';
import { currentDirectRules } from '../src/services/direct';
import { restrictedRoleIds } from '../src/services/permissions';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';
import { callRow, channel, connect, dm, enter, join, next, online, part, settle, setSettings, setupSfu, sfuRoom, start, startIn, sweep, twirpSince } from './call-kit';
import type { FakeSfu } from './sfu-fake';

// Trava de pessoas restritas (§5.10) com o papel operacao restrito, como na operação da Explorer.

let A: Auth;
let fake: FakeSfu;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await setSettings(A, { API_Enable_Rate_Limiter: false, Calls_Restricted_Public: 'pairs', Calls_Restricted_Grace: 30 });
  fake = await setupSfu(A);
  expect(restrictedRoleIds()).toEqual(['operacao']);
});
afterAll(async () => {
  expect(lockViolations()).toEqual([]);
  await stopServer();
  await fake?.stop();
});

const ALL = ['CAMERA', 'MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'];
const user = () => newUser(A);
const op = () => newUser(A, { roles: ['operacao'] });
// Operador que também tem o papel user (call-management global): inicia chamadas em salas.
const opUser = () => newUser(A, { roles: ['user', 'operacao'] });
const leave = async (auth: Auth, callId: string) => {
  const r = await api('POST', 'calls.leave', { callId }, auth);
  await settle();
  return r;
};
const permissionOf = (callId: string, auth: Auth) => fake.rooms.get(sfuRoom(callId))?.participants.get(auth.userId)?.permission;
const guardUntil = async (callId: string) => (await callRow(callId)).guard_until as Date | null;
// Uma sala privada só com operadores: o supervisor cria, passa a posse ao primeiro e sai (a brecha do grupo privado).
async function opsOnlyGroup(ops: Auth[]) {
  const sup = await user();
  const rid = await channel(sup, ops, { private: true });
  expect((await api('POST', 'groups.addOwner', { roomId: rid, userId: ops[0].userId }, sup)).success).toBe(true);
  expect((await api('POST', 'groups.leave', { roomId: rid }, sup)).success).toBe(true);
  await settle();
  return rid;
}

describe('trava de pessoas restritas nas chamadas', () => {
  it('dois operadores não ficam a sós numa chamada de grupo privado: o segundo é recusado com o texto da política', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await leave(sup, id);
    // Uma pessoa sozinha nunca é bloqueada.
    expect(await callRow(id)).toMatchObject({ status: 'ongoing', guard_until: null });
    // A web prevê a recusa sem saber os papéis de ninguém.
    const s = await api('GET', 'calls.roomCall', { roomId: rid }, o2);
    expect(s).toMatchObject({ canJoin: false, joinBlockedReason: CALL_GUARD_JOIN, viewerGuard: { restricted: true, exempt: false, speaks: true } });
    expect(s.call.guard).toEqual({ mode: 'strict', chaperone: false, restrictedSpeakers: 1, connectedSpeakers: 1 });
    expect(await join(o2, id)).toMatchObject({ status: 403, errorType: 'error-call-restricted', error: CALL_GUARD_JOIN });
    expect(await part(id, o2.userId)).toBeUndefined();
    // Com o supervisor de volta, o segundo entra.
    await enter(fake, sup, id);
    await enter(fake, o2, id);
    expect((await part(id, o2.userId)).state).toBe('joined');
    expect(await guardUntil(id)).toBeNull();
  });

  it('canal público no modo pairs: dois operadores sozinhos pausam; três seguem; no modo strict, três também pausam', async () => {
    const [sup, o1, o2, o3] = [await user(), await op(), await op(), await op()];
    const rid = await channel(sup, [o1, o2, o3]);
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'pairs', chaperone: true, restrictedSpeakers: 2, connectedSpeakers: 2 });
    await leave(sup, id);
    expect(await guardUntil(id)).not.toBeNull();
    // Um terceiro operador desfaz o par, mas só quando conecta: com o token na mão (e renovado antes de vencer) ele
    // ainda não está lá, e a dupla continua pausada.
    const j3 = await join(o3, id);
    expect(j3.success).toBe(true);
    await sweep();
    await pool.query(`UPDATE call_participants SET token_at = now() - interval '55 seconds' WHERE call_id = $1 AND user_id = $2`, [id, o3.userId]);
    expect((await join(o3, id)).success).toBe(true);
    await sweep();
    expect(await guardUntil(id)).not.toBeNull();
    expect(permissionOf(id, o1)).toMatchObject({ canPublish: false });
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'pairs', chaperone: false, restrictedSpeakers: 3, connectedSpeakers: 2 });
    await connect(fake, id, o3, j3.join);
    expect(await guardUntil(id)).toBeNull();
    expect(permissionOf(id, o1)).toMatchObject({ canPublish: true });
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'pairs', chaperone: false, restrictedSpeakers: 3, connectedSpeakers: 3 });
    try {
      await setSettings(A, { Calls_Restricted_Public: 'strict' });
      await runGuardNow(id);
      expect(await guardUntil(id)).not.toBeNull();
      expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard.mode).toBe('strict');
    } finally {
      await setSettings(A, { Calls_Restricted_Public: 'pairs' });
    }
    await runGuardNow(id);
    expect(await guardUntil(id)).toBeNull();
  });

  it('o supervisor sai: publicação suspensa para todos com fontes vazias, aviso com prazo, chamada encerrada como restricted', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    const w1 = await online(o1);
    const w2 = await online(o2);
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    expect([...permissionOf(id, o1).canPublishSources].sort()).toEqual(ALL);
    const from = fake.calls.length;
    const notice = next(w1, (e) => e.type === 'call.notice' && e.callId === id && e.notice.kind === 'guard');
    const notice2 = next(w2, (e) => e.type === 'call.notice' && e.callId === id && e.notice.kind === 'guard');
    await leave(sup, id);
    const until = await guardUntil(id);
    expect(until).not.toBeNull();
    expect(new Date(until!).getTime() - Date.now()).toBeGreaterThan(25_000);
    // Pausa para todos: canPublish false e nenhuma fonte.
    const upd = twirpSince(fake, from, 'UpdateParticipant').filter((c) => c.body.room === sfuRoom(id));
    for (const o of [o1, o2]) {
      const last = upd.filter((c) => c.body.identity === o.userId).at(-1);
      expect(last?.body.permission).toMatchObject({ canPublish: false, canPublishSources: [], canPublishData: false, canUpdateMetadata: false });
      expect(permissionOf(id, o)).toMatchObject({ canPublish: false, canPublishSources: [] });
    }
    expect((await notice).notice).toEqual({ kind: 'guard', until: new Date(until!).toISOString(), text: callGuardText(30) });
    await notice2;
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guardUntil).toBe(new Date(until!).toISOString());
    // Antes do prazo: nada muda.
    await runGuardNow(id);
    expect((await callRow(id)).status).toBe('ongoing');
    // O prazo acaba sem supervisor: encerrada como restricted.
    const ended = next(w1, (e) => e.type === 'call.notice' && e.callId === id && e.notice.kind === 'ended');
    await pool.query(`UPDATE calls SET guard_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await runGuardNow(id);
    expect(await callRow(id)).toMatchObject({ status: 'ended', ended_reason: 'restricted' });
    expect((await ended).notice).toEqual({ kind: 'ended', reason: 'restricted', text: CALL_GUARD_ENDED });
    expect(fake.rooms.has(sfuRoom(id))).toBe(false);
    w1.close();
    w2.close();
  });

  it('o supervisor volta a tempo: permissões restauradas e aviso de liberação', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    const w1 = await online(o1);
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    await leave(sup, id);
    expect(await guardUntil(id)).not.toBeNull();
    const from = fake.calls.length;
    const cleared = next(w1, (e) => e.type === 'call.notice' && e.callId === id && e.notice.kind === 'guard-cleared');
    const back = await enter(fake, sup, id);
    // Durante a pausa o token novo também não publica; a liberação vem logo depois da conexão.
    expect(back.join.canPublish).toBe(false);
    expect(await guardUntil(id)).toBeNull();
    expect((await cleared).notice).toEqual({ kind: 'guard-cleared', text: CALL_GUARD_CLEARED });
    for (const o of [o1, o2, sup]) {
      expect(permissionOf(id, o).canPublish).toBe(true);
      expect([...permissionOf(id, o).canPublishSources].sort()).toEqual(ALL);
    }
    expect(twirpSince(fake, from, 'UpdateParticipant').some((c) => c.body.identity === o1.userId && c.body.permission.canPublish)).toBe(true);
    expect(await part(id, o1.userId)).toMatchObject({ granted_publish: true });
    expect((await callRow(id)).status).toBe('ongoing');
    w1.close();
  });

  it('queda do supervisor por menos de 8 s não pausa; troca de dispositivo do supervisor não pausa', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    // Queda (não desligou): ainda conta por 8 s.
    await fake.leave(sfuRoom(id), sup.userId);
    await settle();
    expect(await part(id, sup.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    await runGuardNow(id);
    expect(await guardUntil(id)).toBeNull();
    // Volta antes dos 8 s.
    await enter(fake, sup, id);
    expect((await part(id, sup.userId)).state).toBe('joined');
    // Segundo aparelho: o LiveKit derruba a sessão antiga com DUPLICATE_IDENTITY e a nova assume.
    const old = (await part(id, sup.userId)).session_id;
    const r = await join(sup, id);
    const sid = await connect(fake, id, sup, r.join);
    expect(await part(id, sup.userId)).toMatchObject({ state: 'joined', session_id: sid });
    expect(sid).not.toBe(old);
    await runGuardNow(id);
    expect(await guardUntil(id)).toBeNull();
    // Passados os 8 s sem voltar, a trava liga.
    await fake.leave(sfuRoom(id), sup.userId);
    await settle();
    await pool.query(`UPDATE call_participants SET left_at = now() - interval '9 seconds' WHERE call_id = $1 AND user_id = $2`, [id, sup.userId]);
    await runGuardNow(id);
    expect(await guardUntil(id)).not.toBeNull();
  });

  it('supervisor ainda entrando (joining) não conta como acompanhante; bot nunca conta', async () => {
    const [sup, sup2, o1, o2, bot] = [await user(), await user(), await op(), await op(), await user()];
    const rid = await channel(sup, [sup2, o1, o2, bot], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    await enter(fake, bot, id);
    await pool.query(`UPDATE users SET type = 'bot' WHERE id = $1`, [bot.userId]);
    expect((await join(sup2, id)).success).toBe(true);
    expect((await part(id, sup2.userId)).state).toBe('joining');
    await leave(sup, id);
    expect(await guardUntil(id)).not.toBeNull();
    const info = (await api('GET', 'calls.info', { callId: id }, o1)).call;
    expect(info.guard).toEqual({ mode: 'strict', chaperone: false, restrictedSpeakers: 2, connectedSpeakers: 2 });
    // O token de entrada que publicaria foi anulado: o supervisor pede outro e, conectado, libera.
    expect((await part(id, sup2.userId)).token_at).toBeNull();
    await enter(fake, sup2, id);
    expect(await guardUntil(id)).toBeNull();
  });

  it('brecha do grupo privado (supervisor criou, passou a posse e saiu): bloqueado também', async () => {
    const [o1, o2, o3] = [await opUser(), await op(), await op()];
    const rid = await opsOnlyGroup([o1, o2, o3]);
    // Com call-management global (o papel de dono da sala não conta para operador), ele inicia (três pessoas na sala).
    const { id } = await startIn(fake, o1, rid);
    expect(await join(o2, id)).toMatchObject({ status: 403, errorType: 'error-call-restricted', error: CALL_GUARD_JOIN });
    expect(await join(o3, id)).toMatchObject({ status: 403, error: CALL_GUARD_JOIN });
    expect((await api('GET', 'calls.roomCall', { roomId: rid }, o2)).joinBlockedReason).toBe(CALL_GUARD_JOIN);
    // "Chamar" também pula quem seria barrado.
    const ring = await api('POST', 'calls.ring', { callId: id, userIds: [o2.userId] }, o1);
    expect(ring).toMatchObject({ rung: [], skipped: [{ user: { _id: o2.userId, username: o2.username }, reason: 'restricted' }] });
  });

  it('sala com só dois operadores: iniciar é recusado como ligação direta', async () => {
    const [o1, o2] = [await opUser(), await op()];
    const rid = await opsOnlyGroup([o1, o2]);
    const text = `Você não pode ligar para @${o2.username}: chamadas entre vocês estão bloqueadas pela política da empresa.`;
    const r = await start(o1, rid);
    expect(r).toMatchObject({ status: 403, errorType: 'error-direct-restricted', error: text });
    expect(r.details).toEqual({ action: 'call', usernames: [o1.username, o2.username] });
    expect(await api('GET', 'calls.roomCall', { roomId: rid }, o1)).toMatchObject({ canStart: false, startBlockedReason: text });
    expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = $1`, [rid])).rows[0].n).toBe(0);
  });

  it('operador moderador ou dono da sala não inicia no canal, não chama, não modera e não vira anfitrião (G10, O1)', async () => {
    const [sup, o1, u1, u2] = [await user(), await op(), await user(), await user()];
    const rid = await channel(sup, [o1, u1, u2]);
    expect((await api('POST', 'channels.addModerator', { roomId: rid, userId: o1.userId }, sup)).success).toBe(true);
    const denied = 'Você não tem permissão para iniciar chamadas nesta sala.';
    expect(await start(o1, rid)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: denied });
    expect(await api('GET', 'calls.roomCall', { roomId: rid }, o1)).toMatchObject({ canStart: false, startBlockedReason: denied });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, u1, id);
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.mine).toMatchObject({ host: false, canModerate: false, canRing: false });
    expect(await api('POST', 'calls.ring', { callId: id, userIds: [u2.userId] }, o1)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed' });
    expect(await api('POST', 'calls.moderate', { callId: id, userId: sup.userId, action: 'remove' }, o1)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator' });
    expect((await part(id, sup.userId)).state).toBe('joined');
    // O supervisor sai: o anfitrião passa para u1, nunca para o operador que entrou antes dele.
    await leave(sup, id);
    expect((await part(id, u1.userId)).host).toBe(true);
    expect((await part(id, o1.userId)).host).toBe(false);
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.mine).toMatchObject({ host: false, canModerate: false });
    // Dono do grupo privado: também não modera o supervisor.
    const [sup2, o2] = [await user(), await op()];
    const g = await channel(sup2, [o2, u2], { private: true });
    expect((await api('POST', 'groups.addOwner', { roomId: g, userId: o2.userId }, sup2)).success).toBe(true);
    const gc = await startIn(fake, sup2, g);
    await enter(fake, o2, gc.id);
    for (const action of ['mute', 'remove']) {
      expect(await api('POST', 'calls.moderate', { callId: gc.id, userId: sup2.userId, action }, o2)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator' });
    }
    expect((await part(gc.id, sup2.userId)).state).toBe('joined');
  });

  it('a reconciliação pausa antes de liberar: operador que deixa de estar silenciado nunca publica a sós', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    expect((await api('POST', 'rooms.muteUser', { roomId: rid, userId: o2.userId }, sup)).success).toBe(true);
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await leave(sup, id);
    // Silenciado na sala, o2 não fala: entra como ouvinte mesmo sem acompanhante.
    await enter(fake, o2, id);
    expect(await guardUntil(id)).toBeNull();
    expect(permissionOf(id, o2).canPublish).toBe(false);
    expect((await api('POST', 'rooms.unmuteUser', { roomId: rid, userId: o2.userId }, sup)).success).toBe(true);
    const from = fake.calls.length;
    await sweep();
    expect(await guardUntil(id)).not.toBeNull();
    const upd = twirpSince(fake, from, 'UpdateParticipant').filter((c) => c.body.identity === o2.userId);
    expect(upd.map((c) => c.body.permission.canPublish)).not.toContain(true);
    expect(permissionOf(id, o2).canPublish).toBe(false);
  });

  it('DM em grupo com dois operadores: só quem tem a isenção inicia; isento presente libera a chamada', async () => {
    const isento = await newUser(A, { roles: ['user', 'admin'] });
    const [u, o1, o2] = [await user(), await op(), await op()];
    const drid = await dm(isento, [o1, o2, u]);
    const r1 = await start(o1, drid);
    expect(r1).toMatchObject({ status: 403, errorType: 'error-direct-restricted', error: `Você não pode ligar para @${o2.username}: chamadas entre vocês estão bloqueadas pela política da empresa.` });
    const r2 = await start(u, drid);
    expect(r2).toMatchObject({ status: 403, errorType: 'error-direct-restricted' });
    expect(r2.error).toBe(callStartBlockMessage({ allowed: false, action: 'call', pair: r2.details.usernames }, { _id: u.userId, username: u.username, roles: ['user'] }, currentDirectRules()));
    expect(r2.error).toContain('Só quem tem a permissão de conversa entre pessoas restritas inicia chamadas aqui.');
    expect([...r2.details.usernames].sort()).toEqual([o1.username, o2.username].sort());
    // Quem tem a isenção inicia; os operadores entram e falam com ele presente.
    const { id } = await startIn(fake, isento, drid);
    expect((await part(id, o1.userId)).state).toBe('ringing');
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    expect(await guardUntil(id)).toBeNull();
    expect(permissionOf(id, o2).canPublish).toBe(true);
    // Sem o isento (u só foi chamado), a trava liga: DM em grupo é sempre strict.
    await leave(isento, id);
    expect(await guardUntil(id)).not.toBeNull();
  });

  it('troca de papel no meio da chamada vale na reconciliação', async () => {
    const [sup, o1, u] = [await user(), await op(), await user()];
    const rid = await channel(sup, [o1, u], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, u, id);
    await leave(sup, id);
    expect(await guardUntil(id)).toBeNull();
    // u vira operador: na próxima varredura a dupla fica sem acompanhante.
    expect((await api('POST', 'users.update', { userId: u.userId, data: { roles: ['operacao'] } }, A)).success).toBe(true);
    await sweep();
    expect(await guardUntil(id)).not.toBeNull();
    expect(permissionOf(id, u).canPublish).toBe(false);
    // E de volta.
    expect((await api('POST', 'users.update', { userId: u.userId, data: { roles: ['user'] } }, A)).success).toBe(true);
    await sweep();
    expect(await guardUntil(id)).toBeNull();
    expect(permissionOf(id, o1).canPublish).toBe(true);
  });

  it('sem papéis restritos nada muda', async () => {
    const [sup, o1, o2, o3] = [await user(), await op(), await op(), await op()];
    const rid = await channel(sup, [o1, o2, o3], { private: true });
    const [p1, p2] = [await op(), await op()];
    const pair = await opsOnlyGroup([p1, p2]);
    expect((await api('POST', 'roles.update', { roleId: 'operacao', restrictDirect: false }, A)).success).toBe(true);
    try {
      expect(restrictedRoleIds()).toEqual([]);
      const { id } = await startIn(fake, sup, rid);
      await enter(fake, o1, id);
      await enter(fake, o2, id);
      await leave(sup, id);
      await enter(fake, o3, id);
      await sweep();
      expect(await callRow(id)).toMatchObject({ status: 'ongoing', guard_until: null });
      const info = (await api('GET', 'calls.info', { callId: id }, o1)).call;
      expect(info.guard).toBeUndefined();
      const s = await api('GET', 'calls.roomCall', { roomId: rid }, o1);
      expect(s.viewerGuard).toBeUndefined();
      expect(s.call.guard).toBeUndefined();
      for (const o of [o1, o2, o3]) expect(permissionOf(id, o).canPublish).toBe(true);
      // A sala só com dois operadores também deixa iniciar, e o outro entra.
      const c2 = await startIn(fake, p1, pair);
      await enter(fake, p2, c2.id);
      expect((await part(c2.id, p2.userId)).state).toBe('joined');
      await api('POST', 'calls.end', { callId: c2.id }, p1);
    } finally {
      expect((await api('POST', 'roles.update', { roleId: 'operacao', restrictDirect: true }, A)).success).toBe(true);
    }
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });
});
