import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CALL_GUARD_JOIN } from '@shared/calls';
import { joinCall } from '../src/calls/group';
import { parseJoinClaims } from '../src/calls/livekit';
import { bridgeAdmission, lk, lockViolations, presentSql, runGuardNow, totalPresent, withCallLock } from '../src/calls/model';
import { reconcileCall } from '../src/calls/presence';
import { pool } from '../src/db/pool';
import { admin, api, newUser, sleep, startServer, stopServer, type Auth } from './helpers';
import { callRow, channel, connect, dm, enter, hook, join, next, online, part, settle, setSettings, setupSfu, sfuRoom, start, startIn, sweep, twirpSince } from './call-kit';
import type { FakeSfu } from './sfu-fake';

// Segurança das chamadas em grupo (§9): o servidor do chat é a única autoridade, e o LiveKit só faz o que ele concede.

// "Já está em outra chamada?" de calls.start e calls.accept, conferido fora da trava (no pool, não na conexão da
// transação), espera aqui uma vez depois de responder: o outro pedido, como numa outra instância (sem a fila por
// pessoa), grava no meio.
const held = vi.hoisted(() => ({ userId: '', wait: null as Promise<void> | null, reached: null as (() => void) | null }));
vi.mock('../src/calls/model', async (orig) => {
  const m = await orig<typeof import('../src/calls/model')>();
  const hold = async <T>(userId: string, db: unknown, out: T) => {
    const inTx = typeof (db as { release?: unknown } | undefined)?.release === 'function';
    if (!inTx && held.wait && held.userId === userId) {
      const w = held.wait;
      held.wait = null;
      held.reached?.();
      await w;
    }
    return out;
  };
  return {
    ...m,
    activeCallOf: async (...a: Parameters<typeof m.activeCallOf>) => hold(a[0], a[2], await m.activeCallOf(...a)),
  };
});
function holdNextCheck(userId: string) {
  let release!: () => void;
  const reached = new Promise<void>((r) => (held.reached = r));
  held.wait = new Promise<void>((r) => (release = r));
  held.userId = userId;
  return { reached, release };
}

let A: Auth;
let fake: FakeSfu;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await setSettings(A, { API_Enable_Rate_Limiter: false, Calls_Restricted_Public: 'pairs' });
  fake = await setupSfu(A);
});
afterAll(async () => {
  await stopServer();
  await fake?.stop();
});

const user = () => newUser(A);
const op = () => newUser(A, { roles: ['operacao'] });
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const admit = (callId: string, auth: Auth, hidden = false) => bridgeAdmission({ identity: auth.userId, sfuRoom: sfuRoom(callId), hidden });
const permissionOf = (callId: string, auth: Auth) => fake.rooms.get(sfuRoom(callId))?.participants.get(auth.userId)?.permission;
const leave = async (auth: Auth, callId: string) => {
  const r = await api('POST', 'calls.leave', { callId }, auth);
  await settle();
  return r;
};
const DENIED = { ok: false, status: 403 };

describe('segurança das chamadas em grupo', () => {
  it('S1: tokens e permissões nunca deixam mudar nome, metadados ou atributos, nem mandar dados', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const from = fake.calls.length;
    const s = await startIn(fake, owner, rid);
    const r = await join(m, s.id);
    for (const token of [s.join.token, r.join.token]) {
      const c = claimsOf(token);
      expect(c.name).toBeUndefined();
      expect(c.metadata).toBeUndefined();
      expect(c.attributes).toBeUndefined();
      expect(c.video).toMatchObject({ roomJoin: true, room: sfuRoom(s.id), canPublishData: false, canUpdateOwnMetadata: false });
      expect(c.video.roomAdmin).toBeUndefined();
      expect(parseJoinClaims(c).forbidden).toBeNull();
    }
    await connect(fake, s.id, m, r.join);
    // Alguém (um cliente adulterado, um LiveKit reiniciado) ficou com canPublishData: a reconciliação corrige.
    permissionOf(s.id, m).canPublishData = true;
    permissionOf(s.id, m).canUpdateMetadata = true;
    await sweep();
    expect(permissionOf(s.id, m)).toMatchObject({ canPublishData: false, canUpdateMetadata: false });
    const upd = twirpSince(fake, from, 'UpdateParticipant');
    expect(upd.some((c) => c.body.identity === m.userId)).toBe(true);
    for (const c of upd) {
      expect(c.body.permission).toMatchObject({ canPublishData: false, canUpdateMetadata: false });
      expect(Object.keys(c.body).sort()).toEqual(['identity', 'permission', 'room']);
    }
  });

  it('S2: bridgeAdmission recusa quem desligou, foi removido, saiu da sala, foi desativado ou tem token de entrada vencido', async () => {
    const [owner, hung, removed, gone, off, late] = [await user(), await user(), await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [hung, removed, gone, off, late]);
    const { id } = await startIn(fake, owner, rid);
    for (const u of [hung, removed, gone, off]) {
      await enter(fake, u, id);
      expect(await admit(id, u)).toEqual({ ok: true });
    }
    await leave(hung, id);
    expect(await admit(id, hung)).toEqual(DENIED);
    await api('POST', 'calls.moderate', { callId: id, userId: removed.userId, action: 'remove' }, owner);
    await settle();
    expect(await admit(id, removed)).toEqual(DENIED);
    await api('POST', 'channels.leave', { roomId: rid }, gone);
    await settle();
    expect(await admit(id, gone)).toEqual(DENIED);
    // Desativado: recusado já na ponte, antes mesmo da reconciliação.
    await api('POST', 'users.setActiveStatus', { userId: off.userId, activeStatus: false }, A);
    expect(await admit(id, off)).toEqual(DENIED);
    // Entrando: vale enquanto o token tem menos de 60 s.
    await join(late, id);
    expect(await admit(id, late)).toEqual({ ok: true });
    await pool.query(`UPDATE call_participants SET token_at = now() - interval '61 seconds' WHERE call_id = $1 AND user_id = $2`, [id, late.userId]);
    expect(await admit(id, late)).toEqual(DENIED);
    // Sala que não é de chamada, sala de outra chamada e chamada encerrada.
    expect(await bridgeAdmission({ identity: owner.userId, sfuRoom: 'outra-sala', hidden: false })).toEqual(DENIED);
    expect(await bridgeAdmission({ identity: owner.userId, sfuRoom: `wc_${id}x`, hidden: false })).toEqual(DENIED);
    expect(await admit(id, owner)).toEqual({ ok: true });
    await api('POST', 'calls.end', { callId: id }, owner);
    await settle();
    expect(await admit(id, owner)).toEqual(DENIED);
  });

  it('S2: hidden diferente do concedido é recusado; joined é aceito (retomada e troca de dispositivo)', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    expect(await admit(id, m)).toEqual({ ok: true });
    expect(await admit(id, m, true)).toEqual(DENIED);
    // Retomada do LiveKit muito depois do token de entrada: joined continua aceito.
    await pool.query(`UPDATE call_participants SET token_at = now() - interval '10 minutes' WHERE call_id = $1 AND user_id = $2`, [id, m.userId]);
    expect(await admit(id, m)).toEqual({ ok: true });
    // Troca de aparelho: token novo, sessão nova, a pessoa continua joined e aceita.
    const r = await join(m, id);
    expect(await admit(id, m)).toEqual({ ok: true });
    await connect(fake, id, m, r.join);
    expect((await part(id, m.userId)).state).toBe('joined');
    expect(await admit(id, m)).toEqual({ ok: true });
    // Quem só ouve (hidden concedido) entra com hidden; sem hidden, não.
    await pool.query(`UPDATE call_participants SET granted_hidden = true WHERE call_id = $1 AND user_id = $2`, [id, m.userId]);
    expect(await admit(id, m, true)).toEqual({ ok: true });
    expect(await admit(id, m, false)).toEqual(DENIED);
  });

  it('S3: token emitido antes da saída do supervisor não publica depois que a trava liga (token anulado e permissão reaplicada)', async () => {
    const [sup, o1, o2] = [await user(), await op(), await op()];
    const rid = await channel(sup, [o1, o2], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    // o2 recebe o token com o supervisor presente: pode publicar.
    const r = await join(o2, id);
    expect(r.join).toMatchObject({ canPublish: true });
    expect(await admit(id, o2)).toEqual({ ok: true });
    // O supervisor sai antes de o2 conectar.
    await leave(sup, id);
    expect((await callRow(id)).guard_until).not.toBeNull();
    expect((await part(id, o2.userId)).token_at).toBeNull();
    expect(await admit(id, o2)).toEqual(DENIED);
    expect(permissionOf(id, o1)).toMatchObject({ canPublish: false, canPublishSources: [] });
    // Mesmo que a conexão passe (o token ainda é válido para o LiveKit), a permissão é reaplicada na entrada.
    const from = fake.calls.length;
    await connect(fake, id, o2, r.join);
    expect(twirpSince(fake, from, 'UpdateParticipant').filter((c) => c.body.identity === o2.userId).at(-1)?.body.permission).toMatchObject({ canPublish: false, canPublishSources: [] });
    expect(permissionOf(id, o2)).toMatchObject({ canPublish: false, canPublishSources: [] });
    await expect(fake.publish(sfuRoom(id), o2.userId, { source: 'microphone', name: 'microphone', type: 'audio' })).rejects.toThrow();
    // Na pausa, novas avaliações reaplicam a quem ainda publica.
    permissionOf(id, o1).canPublish = true;
    await runGuardNow(id);
    await sweep();
    expect(permissionOf(id, o1).canPublish).toBe(false);
  });

  it('S9: membro comum não chama de volta quem o moderador removeu; o moderador chama e a remoção acaba', async () => {
    const [host, m, x] = [await user(), await user(), await user()];
    const drid = await dm(host, [m, x]);
    const { id } = await startIn(fake, host, drid);
    await enter(fake, m, id);
    await enter(fake, x, id);
    expect((await api('POST', 'calls.moderate', { callId: id, userId: x.userId, action: 'remove' }, host)).success).toBe(true);
    await settle();
    expect(await join(x, id)).toMatchObject({ status: 403, errorType: 'error-call-removed', error: `Você foi removido desta chamada por @${host.username}.` });
    // m está presente e pode chamar numa DM, mas não desfaz a remoção.
    const r1 = await api('POST', 'calls.ring', { callId: id, userIds: [x.userId] }, m);
    expect(r1).toMatchObject({ rung: [], skipped: [{ user: { _id: x.userId }, reason: 'removed' }] });
    expect(await part(id, x.userId)).toMatchObject({ state: 'left', left_reason: 'removed', removed_by: host.userId });
    const wx = await online(x);
    const ring = next(wx, (e) => e.type === 'call.ring' && e.action === 'ring' && e.call._id === id);
    const r2 = await api('POST', 'calls.ring', { callId: id, userIds: [x.userId] }, host);
    expect(r2).toMatchObject({ rung: [{ _id: x.userId }], skipped: [] });
    await ring;
    expect(await part(id, x.userId)).toMatchObject({ state: 'ringing', left_reason: null, removed_by: null });
    await enter(fake, x, id);
    expect((await part(id, x.userId)).state).toBe('joined');
    wx.close();
  });

  it('S11: calls.admin.active, calls.admin.end e calls.sfu.status só com manage-calls', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    // Nem o dono da sala (moderate-call) vê a visão de administração.
    for (const who of [owner, m]) {
      expect(await api('GET', 'calls.admin.active', {}, who)).toMatchObject({ status: 403, success: false });
      expect(await api('POST', 'calls.admin.end', { callId: id }, who)).toMatchObject({ status: 403, success: false });
      expect(await api('GET', 'calls.sfu.status', {}, who)).toMatchObject({ status: 403, success: false });
    }
    expect((await callRow(id)).status).toBe('ongoing');
    const active = await api('GET', 'calls.admin.active', {}, A);
    expect(active.success).toBe(true);
    expect(JSON.stringify(active)).toContain(id);
    const status = await api('GET', 'calls.sfu.status', {}, A);
    expect(status.success).toBe(true);
    expect(JSON.stringify(status)).not.toContain(fake.secret);
    const ended = await api('POST', 'calls.admin.end', { callId: id }, A);
    expect(ended.call).toMatchObject({ _id: id, status: 'ended', endedReason: 'moderator' });
    const audit = (await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'call.admin.end' AND target->>'callId' = $1`, [id])).rows;
    expect(audit).toEqual([{ actor_id: A.userId }]);
  });

  it('S13: entrada atrasada depois da saída não cria acompanhante fantasma', async () => {
    const [sup, sup2, o1, o2] = [await user(), await user(), await op(), await op()];
    const rid = await channel(sup, [sup2, o1, o2], { private: true });
    const { id } = await startIn(fake, sup, rid);
    await enter(fake, o1, id);
    await enter(fake, o2, id);
    // sup2 pede para entrar e conecta, mas o participant_joined fica preso; enquanto isso ele desliga.
    const r = await join(sup2, id);
    fake.hold();
    await fake.join(sfuRoom(id), sup2.userId, { permission: { canPublish: r.join.canPublish, canPublishSources: r.join.sources } });
    await leave(sup2, id);
    await leave(sup, id);
    expect((await callRow(id)).guard_until).not.toBeNull();
    const from = fake.calls.length;
    await fake.release();
    await settle();
    // O joined atrasado não ressuscita quem desligou: a trava continua e o LiveKit tira a sessão.
    expect(await part(id, sup2.userId)).toMatchObject({ state: 'left', left_reason: 'hangup' });
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => c.body.identity)).toContain(sup2.userId);
    await runGuardNow(id);
    expect((await callRow(id)).guard_until).not.toBeNull();
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard.chaperone).toBe(false);
    // Um participant_joined repetido ou velho também não muda nada.
    await hook(fake, { event: 'participant_joined', room: sfuRoom(id), identity: sup2.userId, sid: 'PA_velho', createdAt: Math.floor(Date.now() / 1000) - 60 });
    expect(await part(id, sup2.userId)).toMatchObject({ state: 'left', left_reason: 'hangup' });
    expect((await callRow(id)).guard_until).not.toBeNull();
  });

  it('S14: acompanhante só conta conectado e humano', async () => {
    const [sup, o1, o2, bot] = [await user(), await op(), await op(), await user()];
    const rid = await channel(sup, [o1, o2, bot], { private: true });
    const s = await start(sup, rid);
    const id = s.call._id as string;
    // O supervisor só pediu o token (joining): ainda não acompanha ninguém.
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'strict', chaperone: false, restrictedSpeakers: 0, connectedSpeakers: 0 });
    await enter(fake, o1, id);
    expect(await join(o2, id)).toMatchObject({ status: 403, error: CALL_GUARD_JOIN });
    expect((await api('GET', 'calls.roomCall', { roomId: rid }, o2)).joinBlockedReason).toBe(CALL_GUARD_JOIN);
    // Conectado, conta.
    await connect(fake, id, sup, s.join);
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'strict', chaperone: true, restrictedSpeakers: 1, connectedSpeakers: 1 });
    await enter(fake, o2, id);
    // Um bot conectado nunca conta.
    await enter(fake, bot, id);
    await pool.query(`UPDATE users SET type = 'bot' WHERE id = $1`, [bot.userId]);
    await leave(sup, id);
    expect((await callRow(id)).guard_until).not.toBeNull();
    expect((await api('GET', 'calls.info', { callId: id }, o1)).call.guard).toEqual({ mode: 'strict', chaperone: false, restrictedSpeakers: 2, connectedSpeakers: 2 });
  });

  it('S15: parar o vídeo tira as fontes de tela por 60 s', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    const room = sfuRoom(id);
    await fake.publish(room, m.userId, { source: 'screen_share', name: 'screen_share', type: 'video' });
    await settle();
    await api('POST', 'calls.moderate', { callId: id, userId: m.userId, action: 'stopVideo' }, owner);
    await settle();
    expect([...permissionOf(id, m).canPublishSources].sort()).toEqual(['CAMERA', 'MICROPHONE']);
    expect(fake.rooms.get(room)!.participants.get(m.userId)!.tracks.some((t: any) => t.source === 'screen_share')).toBe(false);
    await expect(fake.publish(room, m.userId, { source: 'screen_share', name: 'screen_share', type: 'video' })).rejects.toThrow();
    // Um token novo durante o bloqueio também não traz a tela, e a reconciliação mantém o bloqueio.
    const r = await join(m, id);
    expect([...r.join.sources].sort()).toEqual(['camera', 'microphone']);
    await sweep();
    expect([...permissionOf(id, m).canPublishSources].sort()).toEqual(['CAMERA', 'MICROPHONE']);
    expect((await part(id, m.userId)).state).toBe('joined');
    // Passados os 60 s, a reconciliação devolve as fontes de tela.
    await pool.query(`UPDATE call_participants SET screen_block_until = now() - interval '1 second' WHERE call_id = $1 AND user_id = $2`, [id, m.userId]);
    await sweep();
    expect([...permissionOf(id, m).canPublishSources].sort()).toEqual(['CAMERA', 'MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);
    expect((await part(id, m.userId)).granted_sources.sort()).toEqual(['camera', 'microphone', 'screen_share', 'screen_share_audio']);
  });

  it('faixa com nome fora do padrão remove a pessoa e audita call.tamper', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const wm = await online(m);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await enter(fake, n, id);
    const room = sfuRoom(id);
    // Nomes fixos passam.
    await fake.publish(room, n.userId, { source: 'microphone', name: 'microphone', type: 'audio' });
    await fake.publish(room, n.userId, { source: 'camera', name: '', type: 'video' });
    await settle();
    expect((await part(id, n.userId)).state).toBe('joined');
    const refused = next(wm, (e) => e.type === 'call.notice' && e.callId === id && e.notice.kind === 'refused');
    const from = fake.calls.length;
    await fake.publish(room, m.userId, { source: 'microphone', name: 'me liga 9999-0000', type: 'audio' });
    await settle();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'failed' });
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => c.body.identity)).toEqual([m.userId]);
    await refused;
    const audit = (await pool.query(`SELECT actor_id, target, data FROM audit_log WHERE action = 'call.tamper' AND target->>'callId' = $1`, [id])).rows;
    expect(audit).toEqual([{ actor_id: m.userId, target: { callId: id, userId: m.userId }, data: { source: 'microphone', name: 'me liga 9999-0000' } }]);
    // A reconciliação pega a faixa que o webhook não trouxe.
    const t = fake.rooms.get(room)!.participants.get(n.userId)!;
    t.tracks.push({ sid: 'TR_semwebhook', source: 'camera', type: 'video', name: 'camera-2', muted: false } as any);
    await sweep();
    expect(await part(id, n.userId)).toMatchObject({ state: 'left', left_reason: 'failed' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'call.tamper' AND target->>'callId' = $1`, [id])).rows[0].n).toBe(2);
    wm.close();
  });

  it('S9b: "Chamar" conferido antes de uma remoção não desfaz a remoção (confere de novo dentro da trava)', async () => {
    const [host, u1, x] = [await user(), await user(), await user()];
    const drid = await dm(host, [u1, x]);
    const { id } = await startIn(fake, host, drid);
    await enter(fake, u1, id);
    await enter(fake, x, id);
    await leave(x, id);
    // Segura a fila da chamada para ordenar: x volta, o anfitrião remove x e só então grava o "Chamar" de u1, que
    // conferiu enquanto x ainda tinha só desligado.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const blocker = withCallLock(id, () => held);
    await sleep(50);
    const pJoin = join(x, id);
    await sleep(300);
    const pRemove = api('POST', 'calls.moderate', { callId: id, userId: x.userId, action: 'remove' }, host);
    await sleep(300);
    const pRing = api('POST', 'calls.ring', { callId: id, userIds: [x.userId] }, u1);
    await sleep(300);
    release();
    await blocker;
    const [rj, rm, rr] = await Promise.all([pJoin, pRemove, pRing]);
    await settle();
    expect(rj.success).toBe(true);
    expect(rm.participant.leftReason).toBe('removed');
    expect(rr).toMatchObject({ rung: [], skipped: [{ user: { _id: x.userId }, reason: 'removed' }] });
    expect(await part(id, x.userId)).toMatchObject({ state: 'left', left_reason: 'removed', removed_by: host.userId });
    expect(await api('POST', 'calls.accept', { callId: id }, x)).toMatchObject({ status: 403, errorType: 'error-call-removed' });
  });

  it('quem foi expulso do grupo privado não vê mais quem está na chamada (calls.info)', async () => {
    const [owner, m, later] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, later], { private: true });
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    expect((await api('POST', 'groups.kick', { roomId: rid, userId: m.userId }, owner)).success).toBe(true);
    await settle();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'room' });
    await enter(fake, later, id);
    expect(await api('GET', 'calls.info', { callId: id }, m)).toMatchObject({ status: 403 });
    expect(await api('GET', 'calls.roomCall', { roomId: rid }, m)).toMatchObject({ status: 403 });
    // Quem continua na sala vê normalmente.
    expect((await api('GET', 'calls.info', { callId: id }, later)).call.participants.map((p: any) => p.user.username)).toContain(later.username);
  });

  it('limite do servidor com entradas e inícios simultâneos em chamadas diferentes (G18)', async () => {
    // Fecha as chamadas vivas dos outros testes para a conta ficar exata.
    await pool.query(`UPDATE calls SET status = 'ended', ended_at = now() WHERE status IN ('ringing', 'ongoing')`);
    const starters = await Promise.all(Array.from({ length: 9 }, () => user()));
    const joiners = await Promise.all(Array.from({ length: 8 }, () => user()));
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await startIn(fake, starters[i], await channel(starters[i], i < 8 ? [joiners[i]] : []))).id);
    const more = await Promise.all(Array.from({ length: 6 }, () => user()));
    const rooms: string[] = [];
    for (const m of more) rooms.push(await channel(m, []));
    await setSettings(A, { Calls_Max_Total_Participants: 10 });
    try {
      expect(await totalPresent()).toBe(9);
      // Oito entradas ao mesmo tempo, cada uma numa chamada: só uma cabe.
      const rs = await Promise.all(joiners.map((j, i) => join(j, ids[i])));
      expect(rs.filter((r) => r.success)).toHaveLength(1);
      expect(rs.filter((r) => !r.success).map((r) => r.errorType)).toEqual(Array(7).fill('error-call-capacity'));
      expect(await totalPresent()).toBe(10);
      // Mais uma vaga e seis inícios ao mesmo tempo em salas diferentes: só um.
      await setSettings(A, { Calls_Max_Total_Participants: 11 });
      const ss = await Promise.all(more.map((m, i) => start(m, rooms[i])));
      expect(ss.filter((r) => r.success)).toHaveLength(1);
      expect(ss.filter((r) => !r.success).map((r) => r.errorType)).toEqual(Array(5).fill('error-call-capacity'));
      expect(await totalPresent()).toBe(11);
      expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = ANY($1)`, [rooms])).rows[0].n).toBe(1);
    } finally {
      await setSettings(A, { Calls_Max_Total_Participants: 150 });
    }
  });

  it('uma chamada por pessoa com pedidos simultâneos: duas entradas ou dois inícios deixam uma presença só (G27)', async () => {
    const [o1, o2, u, v] = [await user(), await user(), await user(), await user()];
    const c1 = await startIn(fake, o1, await channel(o1, [u]));
    const c2 = await startIn(fake, o2, await channel(o2, [u]));
    const presentIn = async (userId: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM call_participants p JOIN calls c ON c.id = p.call_id WHERE p.user_id = $1 AND c.status = 'ongoing' AND ${presentSql()}`, [userId])).rows[0].n;
    const both = await Promise.all([join(u, c1.id), join(u, c2.id)]);
    expect(both.filter((r) => r.success)).toHaveLength(1);
    expect(both.find((r) => !r.success)).toMatchObject({ status: 409, errorType: 'error-call-in-progress', error: 'Você já está em uma chamada.' });
    expect(await presentIn(u.userId)).toBe(1);
    // Duas abas iniciando em salas diferentes.
    const [s1, s2] = [await channel(o1, [v]), await channel(o2, [v])];
    const starts = await Promise.all([start(v, s1), start(v, s2)]);
    expect(starts.filter((r) => r.success)).toHaveLength(1);
    expect(starts.find((r) => !r.success)).toMatchObject({ status: 409, errorType: 'error-call-in-progress' });
    expect(await presentIn(v.userId)).toBe(1);
  });

  it('uma chamada por pessoa entre instâncias: ligação a dois e entrada em grupo ao mesmo tempo deixam uma presença só (G27)', async () => {
    const presence = async (userId: string) =>
      (
        await pool.query(
          `SELECT c.scope FROM call_participants p JOIN calls c ON c.id = p.call_id WHERE p.user_id = $1 AND c.status IN ('ringing', 'ongoing') AND ${presentSql()}`,
          [userId],
        )
      ).rows.map((r) => r.scope);
    const other = (a: Auth) => ({ userId: a.userId, username: a.username, sessionId: 'outra-instancia' });
    const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.errorType ?? String(e));

    // calls.start a dois conferiu "livre"; a entrada em grupo (outra instância) grava antes de a ligação gravar.
    const [u, v, o] = [await user(), await user(), await user()];
    const d = await dm(u, [v]);
    const g = await startIn(fake, o, await channel(o, [u]));
    const [wu, wv] = [await online(u), await online(v)];
    let h = holdNextCheck(u.userId);
    const pStart = api('POST', 'calls.start', { roomId: d, kind: 'audio', connectionId: wu.connectionId, engines: ['p2p'] }, u);
    await h.reached;
    expect(await outcome(joinCall(other(u), g.id))).toBe('ok');
    h.release();
    expect(await pStart).toMatchObject({ status: 409, errorType: 'error-call-in-progress', error: 'Você já está em uma chamada.' });
    await settle();
    expect(await presence(u.userId)).toEqual(['group']);
    expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = $1`, [d])).rows[0].n).toBe(0);
    await leave(u, g.id);

    // calls.accept conferiu "livre"; a entrada em grupo grava no meio. O atendimento é desfeito e a chamada segue tocando.
    const ring = await api('POST', 'calls.start', { roomId: d, kind: 'audio', connectionId: wv.connectionId, engines: ['p2p'] }, v);
    expect(ring.call.status).toBe('ringing');
    h = holdNextCheck(u.userId);
    const pAccept = api('POST', 'calls.accept', { callId: ring.call._id, connectionId: wu.connectionId }, u);
    await h.reached;
    expect(await outcome(joinCall(other(u), g.id))).toBe('ok');
    h.release();
    expect(await pAccept).toMatchObject({ status: 409, errorType: 'error-call-in-progress' });
    await settle();
    expect(await presence(u.userId)).toEqual(['group']);
    expect(await callRow(ring.call._id)).toMatchObject({ status: 'ringing', answered_at: null, callee_conn: null });
    expect((await part(ring.call._id, u.userId)).state).toBe('ringing');
    await leave(u, g.id);

    // O contrário: a entrada em grupo conferiu "livre" e espera a fila da chamada; o atendimento grava antes, e a entrada
    // é recusada.
    let release!: () => void;
    const blocker = withCallLock(g.id, () => new Promise<void>((r) => (release = r)));
    await sleep(50);
    const pJoin = outcome(joinCall(other(u), g.id));
    await sleep(300);
    expect((await api('POST', 'calls.accept', { callId: ring.call._id, connectionId: wu.connectionId }, u)).call.status).toBe('ongoing');
    release();
    await blocker;
    expect(await pJoin).toBe('error-call-in-progress');
    await settle();
    expect(await presence(u.userId)).toEqual(['direct']);
    await api('POST', 'calls.end', { callId: ring.call._id }, u);
    wu.close();
    wv.close();
  });

  it('quem caiu da chamada e depois foi expulso do grupo privado não a vê mais em calls.active', async () => {
    const [owner, m, later] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, later], { private: true });
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await enter(fake, later, id);
    await fake.leave(sfuRoom(id), m.userId, { reason: 'UNKNOWN' });
    await settle();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    // Ainda membro: a chamada aparece para voltar, com mine.leftReason.
    const before = (await api('GET', 'calls.active', {}, m)).calls.find((c: any) => c._id === id);
    expect(before?.mine).toMatchObject({ leftReason: 'disconnected' });
    expect((await api('POST', 'groups.kick', { roomId: rid, userId: m.userId }, owner)).success).toBe(true);
    await settle();
    expect(await api('GET', 'calls.info', { callId: id }, m)).toMatchObject({ status: 403 });
    expect((await api('GET', 'calls.active', {}, m)).calls.map((c: any) => c._id)).not.toContain(id);
    // Quem continua na sala vê normalmente.
    expect((await api('GET', 'calls.active', {}, later)).calls.find((c: any) => c._id === id)?.participantsCount).toBe(2);
  });

  it('silenciar na sala quem está com o microfone aberto só tira a permissão: nem a reconciliação nem um webhook atrasado contam como adulteração', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await enter(fake, n, id);
    const room = sfuRoom(id);
    await fake.publish(room, m.userId, { source: 'microphone', name: 'microphone', type: 'audio' });
    await settle();
    const tampers = async () => (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'call.tamper' AND target->>'callId' = $1`, [id])).rows[0].n;
    expect((await api('POST', 'rooms.muteUser', { roomId: rid, userId: m.userId }, owner)).success).toBe(true);
    const from = fake.calls.length;
    // A lista da reconciliação ainda traz o microfone: é de antes da permissão nova.
    await sweep();
    expect(await part(id, m.userId)).toMatchObject({ state: 'joined', granted_publish: false, granted_sources: [] });
    expect(await tampers()).toBe(0);
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => c.body.identity)).not.toContain(m.userId);
    expect(permissionOf(id, m)).toMatchObject({ canPublish: false });
    expect(fake.rooms.get(room)!.participants.get(m.userId)!.tracks).toEqual([]);
    // O track_published de uma faixa publicada antes de o LiveKit receber a permissão nova chega depois dela.
    const track = { sid: 'TR_antes', name: 'microphone', source: 'microphone' };
    await hook(fake, { event: 'track_published', room, identity: m.userId, sid: 'PA_x', track });
    expect((await part(id, m.userId)).state).toBe('joined');
    expect(await tampers()).toBe(0);
    // Passados os 30 s, uma fonte que não foi concedida volta a ser adulteração.
    await pool.query(`UPDATE call_participants SET revoked_at = now() - interval '31 seconds' WHERE call_id = $1 AND user_id = $2`, [id, m.userId]);
    await hook(fake, { event: 'track_published', room, identity: m.userId, sid: 'PA_x', track: { ...track, sid: 'TR_depois' } });
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'failed' });
    expect(await tampers()).toBe(1);
  });

  it('faixa que o LiveKit ainda deixava publicar (a permissão nova não chegou) não é adulteração; a reconciliação reaplica', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await enter(fake, n, id);
    const room = sfuRoom(id);
    await fake.publish(room, m.userId, { source: 'microphone', name: 'microphone', type: 'audio' });
    await settle();
    // O silêncio na sala foi gravado há tempo, mas a permissão nova nunca chegou ao LiveKit (que caiu no meio).
    await pool.query(`UPDATE rooms SET muted = array_append(coalesce(muted, '{}'), $2) WHERE id = $1`, [rid, m.username]);
    await pool.query(`UPDATE call_participants SET granted_publish = false, granted_sources = '{}', revoked_sources = '{}', revoked_at = NULL WHERE call_id = $1 AND user_id = $2`, [id, m.userId]);
    const from = fake.calls.length;
    await sweep();
    expect((await part(id, m.userId)).state).toBe('joined');
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'call.tamper' AND target->>'callId' = $1`, [id])).rows[0].n).toBe(0);
    expect(twirpSince(fake, from, 'UpdateParticipant').filter((c) => c.body.identity === m.userId).map((c) => c.body.permission.canPublish)).toEqual([false]);
    expect(fake.rooms.get(room)!.participants.get(m.userId)!.tracks).toEqual([]);
  });

  it('reconciliação com a lista do LiveKit tirada antes da conexão não marca saída nem expulsa quem acabou de entrar (G15)', async () => {
    const [owner, m, w] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, w]);
    const c = await startIn(fake, m, rid);
    const j = await join(w, c.id);
    expect((await part(c.id, w.userId)).state).toBe('joining');
    // A lista sai agora (sem w) e chega 400 ms depois; nesse meio tempo w conecta e o webhook chega.
    fake.delay(400);
    const rec = reconcileCall(c.id);
    await sleep(60);
    fake.delay(0);
    await fake.join(sfuRoom(c.id), w.userId, { permission: { canPublish: j.join.canPublish, canPublishSources: j.join.sources } });
    for (let t = 0; t < 300 && (await part(c.id, w.userId)).state !== 'joined'; t++) await sleep(10);
    expect((await part(c.id, w.userId)).state).toBe('joined');
    await rec;
    await settle();
    expect(await part(c.id, w.userId)).toMatchObject({ state: 'joined', left_reason: null });
    const from = fake.calls.length;
    await reconcileCall(c.id);
    await settle();
    expect(twirpSince(fake, from, 'RemoveParticipant').map((x) => x.body.identity)).not.toContain(w.userId);
    expect(fake.rooms.get(sfuRoom(c.id))?.participants.has(w.userId)).toBe(true);
    expect((await part(c.id, w.userId)).state).toBe('joined');
  });

  it('saída de uma sessão nova que chega antes da entrada (fora de ordem) deixa a pessoa fora da chamada', async () => {
    const [owner, m, w] = [await user(), await user(), await user()];
    const c = await startIn(fake, m, await channel(owner, [m, w]));
    const j1 = await join(w, c.id);
    await connect(fake, c.id, w, j1.join);
    await fake.leave(sfuRoom(c.id), w.userId, { reason: 'UNKNOWN' });
    await settle();
    expect(await part(c.id, w.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    // Volta pela web (joining, ainda com o session_id da sessão 1); a sessão 2 conecta e cai, e os webhooks chegam invertidos.
    expect((await join(w, c.id)).success).toBe(true);
    const t = Math.floor(Date.now() / 1000) + 2;
    await hook(fake, { event: 'participant_left', room: sfuRoom(c.id), identity: w.userId, sid: 'PA_sessao2', createdAt: t + 1, reason: 'CONNECTION_TIMEOUT' });
    await hook(fake, { event: 'participant_joined', room: sfuRoom(c.id), identity: w.userId, sid: 'PA_sessao2', createdAt: t });
    await settle();
    expect(await part(c.id, w.userId)).toMatchObject({ state: 'left', session_id: 'PA_sessao2' });
    // Uma entrada repetida da sessão 2, mesmo mais nova, não traz de volta.
    await hook(fake, { event: 'participant_joined', room: sfuRoom(c.id), identity: w.userId, sid: 'PA_sessao2', createdAt: t + 2 });
    await settle();
    expect((await part(c.id, w.userId)).state).toBe('left');
  });

  it('nenhuma chamada ao LiveKit acontece dentro da trava da chamada', async () => {
    // O detector funciona: uma chamada de propósito dentro da trava falha e fica anotada.
    const before = lockViolations().length;
    await expect(withCallLock('detector', async () => lk.listRooms())).rejects.toThrow('LiveKit chamado dentro da trava');
    expect(lockViolations().slice(before)).toEqual(['listRooms (detector)']);
    // E nada mais: todos os fluxos acima (e os de efeitos e agrupamentos que eles dispararam) chamaram o LiveKit fora dela.
    await settle();
    expect(lockViolations().filter((v) => !v.endsWith('(detector)'))).toEqual([]);
  });
});
