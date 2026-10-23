import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetSfuState, sfuHealth } from '../src/calls/livekit';
import { touchCall } from '../src/calls/card';
import { lockViolations } from '../src/calls/model';
import { entryGate } from '../src/calls/queue';
import { resetRetentionGate } from '../src/calls/sweep';
import { pool } from '../src/db/pool';
import { bus } from '../src/realtime/bus';
import { loadPermissions } from '../src/services/permissions';
import { admin, api, newUser, sleep, startServer, stopServer, type Auth } from './helpers';
import {
  callRow,
  channel,
  connect,
  dm,
  enter,
  eventsSince,
  hook,
  join,
  next,
  online,
  part,
  settle,
  setSettings,
  setupSfu,
  sfuRoom,
  start,
  startIn,
  sweep,
  twirpSince,
} from './call-kit';
import type { FakeSfu } from './sfu-fake';

// O serviço de push de verdade precisa de um navegador inscrito; aqui basta saber para quem e o quê.
const push = vi.hoisted(() => ({ sent: [] as { userIds: string[]; payload: any }[] }));
vi.mock('../src/services/push', async (orig) => ({
  ...(await orig<typeof import('../src/services/push')>()),
  sendPush: async (userIds: string[], payload: any) => {
    push.sent.push({ userIds, payload });
  },
}));

// Atraso injetado na leitura das tarefas agrupadas (call.room e cartão), para o fim chegar no meio delas.
const slow = vi.hoisted(() => ({ room: false, card: false, hit: false, ms: 500 }));
vi.mock('../src/calls/views', async (orig) => {
  const m = await orig<typeof import('../src/calls/views')>();
  return {
    ...m,
    callView: async (...a: Parameters<typeof m.callView>) => {
      const [row, viewerId, o] = a;
      if (slow.room && viewerId === null && o?.guard && !o.room && row?.status === 'ongoing') {
        slow.hit = true;
        await new Promise((r) => setTimeout(r, slow.ms));
      }
      return m.callView(...a);
    },
  };
});
vi.mock('../src/calls/model', async (orig) => {
  const m = await orig<typeof import('../src/calls/model')>();
  return {
    ...m,
    // Só o cartão lê sem passar a conexão.
    loadStats: async (...a: Parameters<typeof m.loadStats>) => {
      const out = await m.loadStats(...a);
      if (slow.card && !a[1]) {
        slow.card = false;
        slow.hit = true;
        await new Promise((r) => setTimeout(r, slow.ms));
      }
      return out;
    },
  };
});

let A: Auth;
let fake: FakeSfu;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await setSettings(A, { API_Enable_Rate_Limiter: false });
  fake = await setupSfu(A);
});
afterAll(async () => {
  await stopServer();
  await fake?.stop();
});

const ALL_SOURCES = ['camera', 'microphone', 'screen_share', 'screen_share_audio'];
const history = async (auth: Auth, rid: string, prefix = 'channels') => (await api('GET', `${prefix}.history`, { roomId: rid, count: 50 }, auth)).messages as any[];
const user = () => newUser(A);

describe('chamadas em grupo', () => {
  it('canal: membro com call-management inicia; a sala do LiveKit é criada depois do commit; o cartão call_group aparece e a sala recebe call.room', async () => {
    const [owner, m, w] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, w]);
    const ww = await online(w);
    const from = fake.calls.length;
    const r = await start(m, rid);
    expect(r.success).toBe(true);
    expect(r.call).toMatchObject({ scope: 'group', media: 'sfu', status: 'ongoing', rid, callee: null, caller: { username: m.username }, participantsCount: 1, mine: { host: true, state: 'joining', canEnd: true } });
    expect(r.call.participants.map((p: any) => p.user.username)).toEqual([m.username]);
    expect(r.join).toMatchObject({ identity: m.userId, canPublish: true, hidden: false, maxVideoPublishers: 16 });
    expect([...r.join.sources].sort()).toEqual(ALL_SOURCES);
    const id = r.call._id;
    expect(twirpSince(fake, from, 'CreateRoom')[0].body).toMatchObject({ name: sfuRoom(id), emptyTimeout: 120, departureTimeout: 40, maxParticipants: 305 });
    const ev = await ww.waitFor((e) => e.type === 'call.room' && e.rid === rid && e.call?._id === id);
    expect(ev.call).toMatchObject({ participantsCount: 1, guardUntil: null, guard: { mode: 'pairs', chaperone: false, restrictedSpeakers: 0 } });
    expect(ev.call.participants).toBeUndefined();
    expect(ev.call.mine).toBeUndefined();
    const card = (await history(w, rid)).find((x) => x.t === 'call_group');
    expect(card.call).toMatchObject({ _id: id, scope: 'group', kind: 'video', status: 'ongoing', endedAt: null });
    expect(card.u.username).toBe(m.username);
    expect((await callRow(id)).message_id).toBe(card._id);
    expect(lockViolations()).toEqual([]);
    ww.close();
  });

  it('falha no CreateRoom apaga a chamada e responde 503; nada fica na sala', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    // A saúde guardada diz que está tudo bem; o CreateRoom é que falha.
    expect((await sfuHealth(true)).ok).toBe(true);
    fake.down();
    try {
      const r = await start(m, rid);
      expect(r).toMatchObject({ status: 503, errorType: 'error-call-sfu-unavailable', error: 'O servidor de chamadas não está respondendo. Tente de novo em instantes ou avise o administrador.' });
      expect((await pool.query('SELECT count(*)::int AS n FROM calls WHERE room_id = $1', [rid])).rows[0].n).toBe(0);
      expect((await history(m, rid)).some((x) => x.t === 'call_group')).toBe(false);
    } finally {
      fake.up();
      resetSfuState();
    }
    // Com o servidor de volta, inicia normalmente.
    expect((await start(m, rid)).success).toBe(true);
  });

  it('operacao entra mas não inicia nem chama; quem não é membro não entra', async () => {
    const [owner, m, out] = [await user(), await user(), await user()];
    const op = await newUser(A, { roles: ['operacao'] });
    const rid = await channel(owner, [m, op]);
    const r2 = await channel(owner, [op]);
    expect(await start(op, r2)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Você não tem permissão para iniciar chamadas nesta sala.' });
    const { id } = await startIn(fake, m, rid);
    const j = await join(op, id);
    expect(j.success).toBe(true);
    expect(j.call.mine).toMatchObject({ host: false, canRing: false, canModerate: false, canEnd: false });
    expect(await api('POST', 'calls.ring', { callId: id, userIds: [owner.userId] }, op)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Você não pode chamar pessoas para esta chamada.' });
    expect(await join(out, id)).toMatchObject({ status: 403, errorType: 'error-call-not-member', error: 'Entre na sala para participar da chamada.' });
  });

  it('segunda tentativa de iniciar devolve error-call-exists com o id da chamada', async () => {
    const [owner, m1, m2, m3] = [await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [m1, m2, m3]);
    const { id } = await startIn(fake, m1, rid);
    expect(await start(m2, rid)).toMatchObject({ status: 409, errorType: 'error-call-exists', error: 'Já existe uma chamada em andamento nesta sala.', details: { callId: id } });
    // Duas ao mesmo tempo numa sala sem chamada: uma inicia, a outra recebe o id dela.
    const rid2 = await channel(owner, [m2, m3]);
    const [a, b] = await Promise.all([start(m2, rid2), start(m3, rid2)]);
    const won = [a, b].find((x) => x.success)!;
    const lost = [a, b].find((x) => !x.success)!;
    expect(won).toBeTruthy();
    expect(lost).toMatchObject({ status: 409, errorType: 'error-call-exists', details: { callId: won.call._id } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = $1`, [rid2])).rows[0].n).toBe(1);
  });

  it('sala arquivada, silenciado, atendimento e sala somente leitura (v1a) recusam com os textos certos', async () => {
    const [owner, m] = [await user(), await user()];
    const archived = await channel(owner, [m]);
    await api('POST', 'channels.archive', { roomId: archived }, owner);
    expect(await start(m, archived)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Esta sala está arquivada.' });
    const muted = await channel(owner, [m]);
    expect((await api('POST', 'rooms.muteUser', { roomId: muted, userId: m.userId }, owner)).success).toBe(true);
    expect(await start(m, muted)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Você está silenciado nesta sala.' });
    const ro = await channel(owner, [m]);
    expect((await api('POST', 'channels.setReadOnly', { roomId: ro, readOnly: true }, owner)).success).toBe(true);
    expect(await start(owner, ro)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Esta sala não aceita chamadas.' });
    for (const flag of ['notice', 'broadcast']) {
      const rid = await channel(owner, [m]);
      await pool.query(`UPDATE rooms SET ${flag} = true WHERE id = $1`, [rid]);
      expect(await start(owner, rid)).toMatchObject({ status: 403, error: 'Esta sala não aceita chamadas.' });
    }
    const live = await channel(owner, [m]);
    await pool.query(`UPDATE rooms SET t = 'l' WHERE id = $1`, [live]);
    expect(await start(owner, live)).toMatchObject({ status: 400, errorType: 'error-call-room', error: 'Chamadas não estão disponíveis em conversas de atendimento.' });
    expect(await start(owner, live, 'tela' as any)).toMatchObject({ status: 400, errorType: 'error-invalid-params', error: 'Tipo de chamada inválido.' });
  });

  it('DM com três pessoas toca para todos; recusa e tempo esgotado ficam por pessoa; push para quem está offline', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const [wb, wb2, wc] = [await online(b), await online(b), await online(c)];
    const rid = await dm(a, [b, c, d]);
    push.sent.length = 0;
    const r = await start(a, rid, 'audio');
    expect(r.success).toBe(true);
    const id = r.call._id;
    const ring = await wb.waitFor((e) => e.type === 'call.ring' && e.action === 'ring' && e.call._id === id);
    expect(ring.by.username).toBe(a.username);
    expect(ring.call.room).toMatchObject({ _id: rid, t: 'd' });
    await wb2.waitFor((e) => e.type === 'call.ring' && e.action === 'ring' && e.call._id === id);
    await wc.waitFor((e) => e.type === 'call.ring' && e.action === 'ring' && e.call._id === id);
    for (const u of [b, c, d]) expect((await part(id, u.userId)).state).toBe('ringing');
    // Só d está com o chat fechado.
    const sent = push.sent.filter((p) => p.payload.tag === `call-${id}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].userIds).toEqual([d.userId]);
    expect(sent[0].payload).toMatchObject({ body: `@${a.username} está chamando você · Chamada de voz em grupo`, url: `/direct/${rid}#call`, tag: `call-${id}` });
    expect(sent[0].payload.title).toBeTruthy();
    // b recusa: para de tocar no outro aparelho de b; a chamada continua.
    const stop = next(wb2, (e) => e.type === 'call.ring' && e.action === 'stop' && e.call._id === id);
    expect((await api('POST', 'calls.decline', { callId: id }, b)).call.mine.state).toBe('declined');
    await stop;
    // O toque de c vence.
    await pool.query(`UPDATE call_participants SET rung_at = now() - interval '41 seconds' WHERE call_id = $1 AND user_id = $2`, [id, c.userId]);
    const stopC = next(wc, (e) => e.type === 'call.ring' && e.action === 'stop' && e.call._id === id);
    await sweep();
    await stopC;
    expect((await part(id, c.userId)).state).toBe('missed');
    expect((await part(id, d.userId)).state).toBe('ringing');
    expect((await callRow(id)).status).toBe('ongoing');
    // Quem foi chamado entra pelo calls.accept (vira um join).
    const acc = await api('POST', 'calls.accept', { callId: id, engines: ['sfu'] }, d);
    expect(acc.join.identity).toBe(d.userId);
    expect((await part(id, d.userId)).state).toBe('joining');
    for (const w of [wb, wb2, wc]) w.close();
  });

  it('Chamar: até 10 pessoas, 5 vezes por minuto; pula quem não é membro, já está, está ocupado, seria barrado ou foi removido', async () => {
    const [owner, m1, here, busy, outsider] = [await user(), await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [m1, here, busy]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, here, id);
    const other = await channel(busy, []);
    await startIn(fake, busy, other);
    expect(await api('POST', 'calls.ring', { callId: id, userIds: Array.from({ length: 11 }, (_, i) => `u${i}`) }, owner)).toMatchObject({
      status: 400,
      errorType: 'error-call-ring-limit',
      error: 'Chame até 10 pessoas por vez.',
    });
    expect((await api('POST', 'calls.ring', { callId: id, userIds: [] }, owner)).errorType).toBe('error-call-ring-limit');
    const wm = await online(m1);
    const r = await api('POST', 'calls.ring', { callId: id, userIds: [m1.userId, here.userId, busy.userId, outsider.userId] }, owner);
    expect(r.rung.map((u: any) => u.username)).toEqual([m1.username]);
    expect(r.skipped.map((s: any) => [s.user.username, s.reason])).toEqual([
      [here.username, 'present'],
      [busy.username, 'busy'],
      [outsider.username, 'not-member'],
    ]);
    await wm.waitFor((e) => e.type === 'call.ring' && e.action === 'ring' && e.call._id === id && e.by.username === owner.username);
    expect(await part(id, m1.userId)).toMatchObject({ state: 'ringing', rung_by: owner.userId });

    // Barrado pela trava: só um operador dentro, chamando outro operador num grupo privado.
    const [op1, op2] = [await newUser(A, { roles: ['user', 'operacao'] }), await newUser(A, { roles: ['operacao'] })];
    const g = await channel(A, [op1, op2], { private: true });
    const gc = await startIn(fake, op1, g);
    const rr = await api('POST', 'calls.ring', { callId: gc.id, userIds: [op2.userId] }, op1);
    expect(rr.skipped).toEqual([{ user: { _id: op2.userId, username: op2.username, name: expect.any(String) }, reason: 'restricted' }]);

    // Removido: um membro comum da DM não chama de volta; quem removeu (moderate-call) chama.
    const [u1, u2] = [await user(), await user()];
    const drid = await dm(A, [u1, u2]);
    const dc = await startIn(fake, A, drid);
    await enter(fake, u1, dc.id);
    await enter(fake, u2, dc.id);
    expect((await api('POST', 'calls.moderate', { callId: dc.id, userId: u2.userId, action: 'remove' }, A)).participant.leftReason).toBe('removed');
    expect((await api('POST', 'calls.ring', { callId: dc.id, userIds: [u2.userId] }, u1)).skipped[0].reason).toBe('removed');
    expect((await api('POST', 'calls.ring', { callId: dc.id, userIds: [u2.userId] }, A)).rung[0]._id).toBe(u2.userId);
    await api('POST', 'calls.end', { callId: dc.id }, A);

    // 5 ações por minuto com o limite ligado.
    await setSettings(A, { API_Enable_Rate_Limiter: true });
    try {
      for (let i = 0; i < 5; i++) expect((await api('POST', 'calls.ring', { callId: id, userIds: [outsider.userId] }, owner)).success).toBe(true);
      expect(await api('POST', 'calls.ring', { callId: id, userIds: [outsider.userId] }, owner)).toMatchObject({ status: 429, errorType: 'error-call-rate-limit' });
    } finally {
      await setSettings(A, { API_Enable_Rate_Limiter: false });
    }
    wm.close();
  });

  it('Chamar todos e Avisar a sala: aviso sem toque só para quem está online e não silenciou a sala; uma vez a cada 10 min', async () => {
    const [owner, m1, m2, m3, m4, m5] = [await user(), await user(), await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [m1, m2, m3, m4, m5]);
    const [w1, w2, w4, w5] = [await online(m1), await online(m2), await online(m4), await online(m5)];
    await api('POST', 'rooms.saveNotification', { roomId: rid, notifications: { disableNotifications: true } }, m2);
    await api('POST', 'rooms.saveNotification', { roomId: rid, notifications: { desktop: 'nothing' } }, m4);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m5, id);
    // "Chamar todos" é o calls.ring com todos os outros membros.
    const all = await api('POST', 'calls.ring', { callId: id, userIds: [m1, m2, m3, m4, m5].map((u) => u.userId) }, owner);
    expect(all.rung.map((u: any) => u._id).sort()).toEqual([m1, m2, m3, m4].map((u) => u.userId).sort());
    expect(all.skipped).toEqual([{ user: expect.objectContaining({ _id: m5.userId }), reason: 'present' }]);

    const since2 = w2.events.length;
    const inv = await api('POST', 'calls.invite', { callId: id }, owner);
    expect(inv).toMatchObject({ success: true, notified: 1 });
    const got = await w1.waitFor((e) => e.type === 'call.invite' && e.call._id === id);
    expect(got.by.username).toBe(owner.username);
    expect(got.call.room._id).toBe(rid);
    await settle();
    expect(eventsSince(w2, since2, (e) => e.type === 'call.invite')).toEqual([]);
    expect(w4.events.some((e) => e.type === 'call.invite')).toBe(false);
    expect(w5.events.some((e) => e.type === 'call.invite')).toBe(false);
    expect((await api('GET', 'calls.info', { callId: id }, owner)).call.mine.canInvite).toBe(false);
    expect(await api('POST', 'calls.invite', { callId: id }, owner)).toMatchObject({ status: 429, errorType: 'error-call-invite-wait', error: 'Aguarde 10 min para avisar a sala de novo.' });
    await pool.query(`UPDATE calls SET invited_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
    expect((await api('GET', 'calls.info', { callId: id }, owner)).call.mine.canInvite).toBe(true);
    expect((await api('POST', 'calls.invite', { callId: id }, owner)).notified).toBe(1);
    // Em DM, só Chamar.
    const drid = await dm(m1, [m2, m3]);
    const dc = await startIn(fake, m1, drid);
    expect(await api('POST', 'calls.invite', { callId: dc.id }, m1)).toMatchObject({ status: 400, errorType: 'error-invalid-params', error: 'Nas conversas diretas, use Chamar.' });
    for (const w of [w1, w2, w4, w5]) w.close();
  });

  it('mão levantada pelo servidor: call.hand para os presentes; moderador baixa; sair limpa', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const [wo, wm] = [await online(owner), await online(m)];
    const { id } = await startIn(fake, owner, rid);
    expect(await api('POST', 'calls.hand', { callId: id, raised: true }, m)).toMatchObject({ status: 400, error: 'Você não está nesta chamada.' });
    await enter(fake, m, id);
    expect(await api('POST', 'calls.hand', { callId: id }, m)).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
    const up = await api('POST', 'calls.hand', { callId: id, raised: true }, m);
    expect(up.handAt).toBeTruthy();
    const ev = await wo.waitFor((e) => e.type === 'call.hand' && e.callId === id && e.userId === m.userId && e.at);
    expect(ev.at).toBe(up.handAt);
    // Levantar de novo mantém a hora da primeira vez.
    expect((await api('POST', 'calls.hand', { callId: id, raised: true }, m)).handAt).toBe(up.handAt);
    const notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'moderated');
    expect((await api('POST', 'calls.moderate', { callId: id, userId: m.userId, action: 'lowerHand' }, owner)).participant.handAt).toBeNull();
    expect((await notice).notice).toMatchObject({ action: 'lowerHand', text: `@${owner.username} baixou sua mão.`, by: { username: owner.username } });
    await wo.waitFor((e) => e.type === 'call.hand' && e.userId === m.userId && e.at === null);
    await api('POST', 'calls.hand', { callId: id, raised: true }, m);
    const cleared = next(wo, (e) => e.type === 'call.hand' && e.userId === m.userId && e.at === null);
    await api('POST', 'calls.leave', { callId: id }, m);
    await cleared;
    expect((await part(id, m.userId)).hand_at).toBeNull();
    wo.close();
    wm.close();
  });

  it('presença: webhooks de entrada e saída; a reconciliação corrige webhook perdido; token vencido deixa de contar', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const { id } = await startIn(fake, owner, rid);
    expect((await part(id, owner.userId)).state).toBe('joined');
    await enter(fake, m, id);
    expect(await part(id, m.userId)).toMatchObject({ state: 'joined', left_reason: null });
    expect((await callRow(id)).peak).toBe(2);
    // Saída com webhook.
    await fake.leave(sfuRoom(id), m.userId);
    await settle();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    // Entrada sem webhook: a reconciliação vê no LiveKit e marca joined.
    await join(m, id);
    await fake.join(sfuRoom(id), m.userId, { webhook: false });
    await sweep();
    expect((await part(id, m.userId)).state).toBe('joined');
    // Saída sem webhook: a reconciliação marca a queda.
    await fake.leave(sfuRoom(id), m.userId, { webhook: false });
    await sweep();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    // Token de entrada vencido: deixa de contar como presente e vira "failed".
    expect((await join(n, id)).call.participantsCount).toBe(2);
    await pool.query(`UPDATE call_participants SET token_at = now() - interval '61 seconds' WHERE call_id = $1 AND user_id = $2`, [id, n.userId]);
    expect((await api('GET', 'calls.info', { callId: id }, owner)).call.participantsCount).toBe(1);
    await sweep();
    expect(await part(id, n.userId)).toMatchObject({ state: 'left', left_reason: 'failed' });
    expect((await part(id, m.userId)).seconds).toBeGreaterThanOrEqual(0);
  });

  it('webhook repetido ou atrasado não muda nada (id e createdAt)', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    const { sid } = await enter(fake, m, id);
    const now = Math.floor(Date.now() / 1000);
    // Saída mais velha que a última entrada aplicada: descartada.
    expect(await hook(fake, { event: 'participant_left', room: sfuRoom(id), identity: m.userId, sid, createdAt: now - 30 })).toBe(200);
    expect((await part(id, m.userId)).state).toBe('joined');
    // Saída nova: aplicada.
    const leftId = 'EV_saida_repetida';
    await hook(fake, { event: 'participant_left', room: sfuRoom(id), identity: m.userId, sid, createdAt: now, id: leftId });
    expect((await part(id, m.userId)).state).toBe('left');
    // Volta (sessão nova); o mesmo webhook de saída chega de novo e é ignorado pelo id.
    await enter(fake, m, id);
    expect((await part(id, m.userId)).state).toBe('joined');
    await hook(fake, { event: 'participant_left', room: sfuRoom(id), identity: m.userId, sid, createdAt: now, id: leftId });
    expect((await part(id, m.userId)).state).toBe('joined');
    // Fora de ordem e repetidos de verdade (o falso segura e solta ao contrário, duas vezes): termina consistente.
    fake.hold();
    await fake.leave(sfuRoom(id), owner.userId);
    await fake.release({ order: 'reverse', twice: true });
    await settle();
    expect(await part(id, owner.userId)).toMatchObject({ state: 'left', left_reason: 'disconnected' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1`, [id])).rows[0].n).toBe(2);
  });

  it('segundo dispositivo assume o lugar sem duplicar a pessoa; saída da sessão antiga é ignorada', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    const first = await enter(fake, m, id);
    const firstJoined = (await part(id, m.userId)).last_joined_at;
    // O segundo aparelho pede outro token: a linha continua joined.
    const again = await join(m, id);
    expect(again.success).toBe(true);
    expect((await part(id, m.userId)).state).toBe('joined');
    // O LiveKit derruba a sessão antiga (DUPLICATE_IDENTITY) e fica com a nova.
    const sid2 = await connect(fake, id, m, again.join);
    expect(sid2).not.toBe(first.sid);
    expect(await part(id, m.userId)).toMatchObject({ state: 'joined', session_id: sid2, last_joined_at: firstJoined });
    // Um webhook atrasado da sessão antiga não tira a pessoa.
    await hook(fake, { event: 'participant_left', room: sfuRoom(id), identity: m.userId, sid: first.sid, createdAt: Math.floor(Date.now() / 1000) + 5, reason: 'CLIENT_INITIATED' });
    expect((await part(id, m.userId)).state).toBe('joined');
    expect((await api('GET', 'calls.info', { callId: id }, m)).call.participantsCount).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1 AND user_id = $2`, [id, m.userId])).rows[0].n).toBe(1);
  });

  it('uma chamada por pessoa: entrar em outra exige leaveCurrent e sai da primeira', async () => {
    const [o1, o2, m] = [await user(), await user(), await user()];
    const r1 = await channel(o1, [m]);
    const r2 = await channel(o2, [m]);
    const c1 = await startIn(fake, o1, r1);
    const c2 = await startIn(fake, o2, r2);
    await enter(fake, m, c1.id);
    expect(await join(m, c2.id)).toMatchObject({ status: 409, errorType: 'error-call-in-progress', error: 'Você já está em uma chamada.' });
    expect(await start(m, await channel(m, []))).toMatchObject({ status: 409, errorType: 'error-call-in-progress' });
    const from = fake.calls.length;
    const ok = await join(m, c2.id, { leaveCurrent: true });
    expect(ok.success).toBe(true);
    expect(await part(c1.id, m.userId)).toMatchObject({ state: 'left', left_reason: 'hangup' });
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => [c.body.room, c.body.identity])).toContainEqual([sfuRoom(c1.id), m.userId]);
    expect((await callRow(c1.id)).status).toBe('ongoing');
  });

  it('moderação: silenciar, desligar vídeo, parar a tela por 60 s, baixar mão e remover, com auditoria e aviso ao alvo', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const wm = await online(m);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    const room = sfuRoom(id);
    const mic = await fake.publish(room, m.userId, { source: 'microphone', name: 'microphone', type: 'audio' });
    const cam = await fake.publish(room, m.userId, { source: 'camera', name: 'camera', type: 'video' });
    await fake.publish(room, m.userId, { source: 'screen_share', name: 'screen_share', type: 'video' });
    await settle();
    expect((await part(id, m.userId)).state).toBe('joined');
    const by = `@${owner.username}`;
    const moderate = (action: string) => api('POST', 'calls.moderate', { callId: id, userId: m.userId, action }, owner);

    let from = fake.calls.length;
    let notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'moderated');
    expect((await moderate('mute')).participant.user._id).toBe(m.userId);
    expect((await notice).notice).toMatchObject({ action: 'mute', text: `${by} silenciou seu microfone.` });
    await settle();
    expect(twirpSince(fake, from, 'MutePublishedTrack').map((c) => c.body)).toEqual([expect.objectContaining({ room, identity: m.userId, trackSid: mic, muted: true })]);

    from = fake.calls.length;
    notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'moderated');
    await moderate('stopVideo');
    expect((await notice).notice.text).toBe(`${by} desligou sua câmera e parou seu compartilhamento de tela.`);
    await settle();
    expect(twirpSince(fake, from, 'MutePublishedTrack').map((c) => c.body.trackSid)).toEqual([cam]);
    const upd = twirpSince(fake, from, 'UpdateParticipant');
    expect(upd).toHaveLength(1);
    expect([...upd[0].body.permission.canPublishSources].sort()).toEqual(['CAMERA', 'MICROPHONE']);
    const row = await part(id, m.userId);
    expect(new Date(row.screen_block_until).getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(row.granted_sources.sort()).toEqual(['camera', 'microphone']);
    // Sem faixa para parar: nada a fazer, sem erro.
    expect((await moderate('mute')).success).toBe(true);

    await api('POST', 'calls.hand', { callId: id, raised: true }, m);
    notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'moderated');
    await moderate('lowerHand');
    expect((await notice).notice.text).toBe(`${by} baixou sua mão.`);

    expect(await moderate('allowSpeak')).toMatchObject({ status: 400, error: 'A fala só é controlada em transmissões.' });
    expect(await moderate('unmute')).toMatchObject({ status: 400, errorType: 'error-invalid-params' });

    from = fake.calls.length;
    notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'moderated');
    expect((await moderate('remove')).participant).toMatchObject({ state: 'left', leftReason: 'removed' });
    expect((await notice).notice.text).toBe(`${by} removeu você da chamada.`);
    await settle();
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => c.body.identity)).toEqual([m.userId]);
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'removed', removed_by: owner.userId });
    expect(await join(m, id)).toMatchObject({ status: 403, errorType: 'error-call-removed', error: `Você foi removido desta chamada por @${owner.username}.` });

    const audits = (await pool.query(`SELECT target, data, actor_id FROM audit_log WHERE action = 'call.moderate' AND target->>'callId' = $1 ORDER BY created_at`, [id])).rows;
    expect(audits.map((a) => a.data.action)).toEqual(['mute', 'stopVideo', 'lowerHand', 'remove']);
    expect(audits[0]).toMatchObject({ actor_id: owner.userId, target: { callId: id, rid, userId: m.userId } });
    wm.close();
  });

  it('anfitrião sem moderate-call não age sobre moderador da sala; ninguém modera a si mesmo; operador anfitrião de DM não modera', async () => {
    const [owner, host, p] = [await user(), await user(), await user()];
    const rid = await channel(owner, [host, p]);
    const { id } = await startIn(fake, host, rid);
    await enter(fake, owner, id);
    await enter(fake, p, id);
    const mod = (who: Auth, target: Auth, action = 'mute') => api('POST', 'calls.moderate', { callId: id, userId: target.userId, action }, who);
    expect(await mod(host, owner)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator', error: 'Você não pode fazer isso com um moderador da sala.' });
    expect(await mod(host, host)).toMatchObject({ status: 400, error: 'Use os botões da chamada para você mesmo.' });
    expect((await mod(host, p)).success).toBe(true);
    expect(await mod(p, host)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator', error: 'Só quem iniciou a chamada e os moderadores da sala podem fazer isso.' });
    // O dono da sala (moderate-call) age sobre o anfitrião.
    expect((await mod(owner, host)).success).toBe(true);
    // Operador que iniciou uma DM em grupo é anfitrião, mas não tem call-management: não modera.
    const op = await newUser(A, { roles: ['operacao'] });
    const [x, y] = [await user(), await user()];
    const drid = await dm(op, [x, y]);
    const dc = await startIn(fake, op, drid);
    await enter(fake, x, dc.id);
    expect((await api('GET', 'calls.info', { callId: dc.id }, op)).call.mine).toMatchObject({ host: true, canModerate: false, canEnd: true });
    expect(await api('POST', 'calls.moderate', { callId: dc.id, userId: x.userId, action: 'mute' }, op)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator' });
  });

  it('encerrar para todos: anfitrião ou moderate-call; cartão final com duração e pessoas', async () => {
    const [owner, host, p] = [await user(), await user(), await user()];
    const rid = await channel(owner, [host, p]);
    const [wp, wo] = [await online(p), await online(owner)];
    const { id } = await startIn(fake, host, rid);
    await enter(fake, p, id);
    expect(await api('POST', 'calls.end', { callId: id }, p)).toMatchObject({ status: 403, errorType: 'error-call-not-moderator' });
    await pool.query(`UPDATE calls SET created_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    const from = fake.calls.length;
    const notice = next(wp, (e) => e.type === 'call.notice' && e.notice.kind === 'ended');
    const roomEnd = next(wo, (e) => e.type === 'call.room' && e.rid === rid && e.call === null);
    const ended = await api('POST', 'calls.end', { callId: id }, host);
    expect(ended.call).toMatchObject({ status: 'ended', endedReason: 'moderator', endedBy: host.userId });
    expect(ended.call.duration).toBeGreaterThanOrEqual(299);
    expect((await notice).notice).toMatchObject({ reason: 'moderator', text: expect.stringContaining('Encerrada por') });
    await roomEnd;
    await settle();
    expect(twirpSince(fake, from, 'DeleteRoom').map((c) => c.body.room)).toEqual([sfuRoom(id)]);
    const card = (await history(owner, rid)).find((x) => x.t === 'call_group');
    expect(card.call).toMatchObject({ status: 'ended', endedReason: 'moderator', endedBy: { _id: host.userId, username: host.username }, totalJoined: 2, peak: 2 });
    expect(card.call.duration).toBeGreaterThanOrEqual(299);
    expect(card.editedAt ?? card.editedBy ?? null).toBeNull();
    for (const u of [host, p]) expect(await part(id, u.userId)).toMatchObject({ state: 'left', left_reason: 'ended' });
    const audit = (await pool.query(`SELECT * FROM audit_log WHERE action = 'call.end' AND target->>'callId' = $1`, [id])).rows;
    expect(audit).toHaveLength(1);
    // Moderador da sala também encerra.
    const c2 = await startIn(fake, host, rid);
    expect((await api('POST', 'calls.end', { callId: c2.id }, owner)).call.status).toBe('ended');
    wp.close();
    wo.close();
  });

  it('anfitrião sai: o papel passa para quem está há mais tempo e tem call-management', async () => {
    const [owner, host, a, b] = [await user(), await user(), await user(), await user()];
    const op = await newUser(A, { roles: ['operacao'] });
    const rid = await channel(owner, [host, a, b, op]);
    const wa = await online(a);
    const { id } = await startIn(fake, host, rid);
    await enter(fake, op, id);
    await enter(fake, a, id);
    await enter(fake, b, id);
    // O operador entrou primeiro, mas não tem call-management.
    await pool.query(`UPDATE call_participants SET last_joined_at = now() - interval '3 minutes' WHERE call_id = $1 AND user_id = $2`, [id, op.userId]);
    await pool.query(`UPDATE call_participants SET last_joined_at = now() - interval '2 minutes' WHERE call_id = $1 AND user_id = $2`, [id, a.userId]);
    const notice = next(wa, (e) => e.type === 'call.notice' && e.notice.kind === 'host');
    await api('POST', 'calls.leave', { callId: id }, host);
    expect((await notice).notice.text).toBe('Agora você é o anfitrião da chamada.');
    await wa.waitFor((e) => e.type === 'call' && e.call._id === id && e.call.mine?.host === true);
    expect((await part(id, a.userId)).host).toBe(true);
    expect((await part(id, host.userId)).host).toBe(false);
    // Quem era anfitrião volta e não retoma o papel.
    await enter(fake, host, id);
    expect((await part(id, host.userId)).host).toBe(false);
    // Sem ninguém com call-management, a chamada fica sem anfitrião até alguém assim entrar.
    for (const u of [a, b, host]) await api('POST', 'calls.leave', { callId: id }, u);
    expect((await pool.query(`SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1 AND host`, [id])).rows[0].n).toBe(0);
    expect((await callRow(id)).status).toBe('ongoing');
    await enter(fake, b, id);
    expect((await part(id, b.userId)).host).toBe(true);
    wa.close();
  });

  it('sair da sala tira da chamada; arquivar encerra; usuário desativado sai na reconciliação', async () => {
    const [owner, m, n, d] = [await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [m, n, d]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await enter(fake, d, id);
    const from = fake.calls.length;
    expect((await api('POST', 'channels.leave', { roomId: rid }, m)).success).toBe(true);
    await settle();
    expect(await part(id, m.userId)).toMatchObject({ state: 'left', left_reason: 'room' });
    expect(twirpSince(fake, from, 'RemoveParticipant').map((c) => c.body.identity)).toContain(m.userId);
    // Chamado e saiu da sala: o toque vira perdido.
    await api('POST', 'calls.ring', { callId: id, userIds: [n.userId] }, owner);
    await api('POST', 'channels.leave', { roomId: rid }, n);
    await settle();
    expect((await part(id, n.userId)).state).toBe('missed');
    // Desativado: sai na próxima reconciliação.
    expect((await api('POST', 'users.setActiveStatus', { userId: d.userId, activeStatus: false }, A)).success).toBe(true);
    await sweep();
    expect(await part(id, d.userId)).toMatchObject({ state: 'left', left_reason: 'deactivated' });
    expect(fake.rooms.get(sfuRoom(id))!.participants.has(d.userId)).toBe(false);
    // Arquivar encerra.
    await api('POST', 'channels.archive', { roomId: rid }, owner);
    await settle();
    expect(await callRow(id)).toMatchObject({ status: 'ended', ended_reason: 'room' });
  });

  it('o último a sair encerra na hora; queda de todos espera 30 s; sozinho 30 min encerra; limite de horas encerra', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    let c = await startIn(fake, owner, rid);
    await enter(fake, m, c.id);
    await api('POST', 'calls.leave', { callId: c.id }, m);
    expect((await callRow(c.id)).status).toBe('ongoing');
    await api('POST', 'calls.leave', { callId: c.id }, owner);
    expect(await callRow(c.id)).toMatchObject({ status: 'ended', ended_reason: 'empty' });

    // Todos caem: espera 30 s antes de encerrar.
    c = await startIn(fake, owner, rid);
    await enter(fake, m, c.id);
    await fake.leave(sfuRoom(c.id), owner.userId, { reason: 'UNKNOWN' });
    await fake.leave(sfuRoom(c.id), m.userId, { reason: 'UNKNOWN' });
    await settle();
    expect((await callRow(c.id)).empty_since).toBeTruthy();
    await sweep();
    expect((await callRow(c.id)).status).toBe('ongoing');
    await pool.query(`UPDATE calls SET empty_since = now() - interval '31 seconds' WHERE id = $1`, [c.id]);
    await sweep();
    expect(await callRow(c.id)).toMatchObject({ status: 'ended', ended_reason: 'empty' });

    // Sozinho por 30 min.
    c = await startIn(fake, owner, rid);
    expect((await callRow(c.id)).alone_since).toBeTruthy();
    await pool.query(`UPDATE calls SET alone_since = now() - interval '31 minutes' WHERE id = $1`, [c.id]);
    await sweep();
    expect(await callRow(c.id)).toMatchObject({ status: 'ended', ended_reason: 'alone' });

    // Limite de horas.
    c = await startIn(fake, owner, rid);
    await enter(fake, m, c.id);
    await pool.query(`UPDATE calls SET created_at = now() - interval '13 hours' WHERE id = $1`, [c.id]);
    await sweep();
    expect(await callRow(c.id)).toMatchObject({ status: 'ended', ended_reason: 'max-duration' });
  });

  it('sala vira somente leitura no meio da chamada: encerra com readonly', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const wm = await online(m);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    await api('POST', 'channels.setReadOnly', { roomId: rid, readOnly: true }, owner);
    const notice = next(wm, (e) => e.type === 'call.notice' && e.notice.kind === 'ended');
    await sweep();
    expect(await callRow(id)).toMatchObject({ status: 'ended', ended_reason: 'readonly' });
    expect((await notice).notice.text).toBe('Encerrada: a sala passou a aceitar só quem publica');
    wm.close();
  });

  it('LiveKit reiniciou: room_finished não encerra; calls.join recria a sala; sem ninguém em 90 s a chamada acaba com sfu', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const { id } = await startIn(fake, owner, rid);
    await fake.finish(sfuRoom(id));
    await settle();
    expect(await callRow(id)).toMatchObject({ status: 'ongoing' });
    expect((await callRow(id)).sfu_missing_since).toBeTruthy();
    // Quem entra agora recria a sala antes de receber o token.
    const from = fake.calls.length;
    const r = await join(m, id);
    expect(r.success).toBe(true);
    expect(twirpSince(fake, from, 'CreateRoom').map((c) => c.body.name)).toEqual([sfuRoom(id)]);
    expect(fake.rooms.has(sfuRoom(id))).toBe(true);
    await connect(fake, id, m, r.join);
    await sweep();
    expect((await callRow(id)).sfu_missing_since).toBeNull();

    // Reinício sem ninguém voltando: a reconciliação recria a sala e, passados 90 s, encerra com sfu.
    fake.restart();
    await sweep();
    const row = await callRow(id);
    expect(row.status).toBe('ongoing');
    expect(row.sfu_missing_since).toBeTruthy();
    fake.restart();
    await pool.query(`UPDATE calls SET sfu_missing_since = now() - interval '91 seconds' WHERE id = $1`, [id]);
    await pool.query(`UPDATE call_participants SET last_joined_at = now() - interval '2 minutes' WHERE call_id = $1`, [id]);
    await sweep();
    expect(await callRow(id)).toMatchObject({ status: 'ended', ended_reason: 'sfu' });
  });

  it('limite por chamada e limite do servidor (error-call-capacity)', async () => {
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    await setSettings(A, { Calls_Max_Participants: 2 });
    try {
      const { id } = await startIn(fake, owner, rid);
      await enter(fake, m, id);
      expect(await join(n, id)).toMatchObject({ status: 409, errorType: 'error-call-full', error: 'A chamada está cheia (2 pessoas).' });
      // Quem já está dentro pode pegar outro token.
      expect((await join(m, id)).success).toBe(true);
    } finally {
      await setSettings(A, { Calls_Max_Participants: 30 });
    }
    // Limite do servidor: 10 pessoas em chamadas ao mesmo tempo.
    const crowd = await Promise.all(Array.from({ length: 8 }, () => user()));
    const big = await channel(owner, [...crowd, n]);
    await setSettings(A, { Calls_Max_Total_Participants: 10 });
    try {
      // Fecha as chamadas vivas dos outros testes para a conta ficar exata.
      await pool.query(`UPDATE calls SET status = 'ended', ended_at = now() WHERE status IN ('ringing', 'ongoing')`);
      const c = await startIn(fake, owner, big);
      for (const u of crowd) await enter(fake, u, c.id);
      await enter(fake, m, (await startIn(fake, m, rid)).id).catch(() => {});
      expect((await pool.query(`SELECT count(*)::int AS n FROM call_participants p JOIN calls k ON k.id = p.call_id WHERE k.status = 'ongoing' AND p.state = 'joined'`)).rows[0].n).toBe(10);
      expect(await join(n, c.id)).toMatchObject({ status: 503, errorType: 'error-call-capacity', error: 'O servidor de chamadas está no limite agora. Tente em alguns minutos.' });
      const solo = await channel(n, []);
      expect(await start(n, solo)).toMatchObject({ status: 503, errorType: 'error-call-capacity' });
    } finally {
      await setSettings(A, { Calls_Max_Total_Participants: 150 });
    }
  });

  it('Calls_Group_Enabled desligado recusa fora de DM a dois; /call manda call.prompt; /jitsi só com VideoConf_Enabled', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const wo = await online(owner);
    const send = (msg: string, room = rid) => api('POST', 'chat.sendMessage', { message: { rid: room, msg } }, owner);
    await setSettings(A, { Calls_Group_Enabled: false });
    try {
      expect(await start(owner, rid)).toMatchObject({ status: 400, errorType: 'error-call-group-disabled', error: 'Chamadas em grupo estão desativadas. Só é possível ligar em mensagens diretas entre duas pessoas.' });
      const drid3 = await dm(owner, [m, await user()]);
      expect((await start(owner, drid3)).errorType).toBe('error-call-group-disabled');
      expect((await send('/call')).errorType).toBe('error-call-group-disabled');
      expect((await api('GET', 'calls.config', {}, owner)).groupEnabled).toBe(false);
      // A dois continua (P2P).
      const drid = await dm(owner, [m]);
      const prompt = next(wo, (e) => e.type === 'call.prompt');
      expect((await send('/call voz', drid)).success).toBe(true);
      expect(await prompt).toEqual({ type: 'call.prompt', rid: drid, kind: 'audio' });
    } finally {
      await setSettings(A, { Calls_Group_Enabled: true });
    }
    const before = (await history(owner, rid)).length;
    let prompt = next(wo, (e) => e.type === 'call.prompt');
    expect((await send('/call')).success).toBe(true);
    expect(await prompt).toEqual({ type: 'call.prompt', rid, kind: 'video' });
    prompt = next(wo, (e) => e.type === 'call.prompt');
    await send('/call vídeo');
    expect((await prompt).kind).toBe('video');
    expect((await history(owner, rid)).length).toBe(before);
    expect(await send('/jitsi')).toMatchObject({ success: false, error: 'O Jitsi está desativado. Use /call para uma chamada interna.' });
    await setSettings(A, { VideoConf_Enabled: true });
    try {
      expect((await send('/jitsi')).success).toBe(true);
      expect((await history(owner, rid))[0].msg).toContain('meet.jit.si');
    } finally {
      await setSettings(A, { VideoConf_Enabled: false });
    }
    const ro = await channel(owner, [m]);
    await api('POST', 'channels.setReadOnly', { roomId: ro, readOnly: true }, owner);
    expect(await send('/call', ro)).toMatchObject({ success: false, errorType: 'error-call-not-allowed', error: 'Esta sala não aceita chamadas.' });
    // Calls_Enabled desligado e sem Jitsi.
    await setSettings(A, { Calls_Enabled: false });
    try {
      expect(await send('/call')).toMatchObject({ success: false, error: 'As chamadas estão desativadas.' });
      expect(await start(owner, rid)).toMatchObject({ status: 403, error: 'As chamadas estão desativadas.' });
    } finally {
      await setSettings(A, { Calls_Enabled: true });
    }
    wo.close();
  });

  it('calls.list com filtros, calls.missedCount e calls.seen; chamada em grupo aparece para quem entrou ou foi chamado', async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    const drid = await dm(a, [b, c]);
    const { id } = await startIn(fake, a, drid);
    await enter(fake, c, id);
    await pool.query(`UPDATE call_participants SET rung_at = now() - interval '41 seconds' WHERE call_id = $1 AND user_id = $2`, [id, b.userId]);
    await sweep();
    expect((await part(id, b.userId)).state).toBe('missed');
    expect((await api('GET', 'calls.list', {}, a)).calls.map((x: any) => x._id)).not.toContain(id); // viva não aparece
    await api('POST', 'calls.end', { callId: id }, a);
    // Canal em que d é membro mas nunca entrou.
    const rid = await channel(a, [d]);
    const cc = await startIn(fake, a, rid);
    await api('POST', 'calls.end', { callId: cc.id }, a);
    const la = await api('GET', 'calls.list', { filter: 'outgoing' }, a);
    expect(la.calls.map((x: any) => x._id).sort()).toEqual([id, cc.id].sort());
    expect(la.total).toBe(2);
    expect(la.calls.find((x: any) => x._id === id)).toMatchObject({ scope: 'group', callee: null, room: { _id: drid, t: 'd' }, mine: { direction: 'outgoing', host: true } });
    const lb = await api('GET', 'calls.list', { filter: 'missed' }, b);
    expect(lb.calls.map((x: any) => x._id)).toEqual([id]);
    expect(lb.calls[0].mine).toMatchObject({ missed: true, direction: 'incoming', state: 'missed' });
    expect((await api('GET', 'calls.list', { filter: 'incoming' }, c)).calls.map((x: any) => x._id)).toEqual([id]);
    expect((await api('GET', 'calls.list', {}, d)).total).toBe(0);
    expect((await api('GET', 'calls.list', { roomId: drid }, a)).calls.map((x: any) => x._id)).toEqual([id]);
    expect(await api('GET', 'calls.list', { filter: 'qualquer' }, a)).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
    expect((await api('GET', 'calls.missedCount', {}, b)).count).toBe(1);
    expect((await api('POST', 'calls.seen', {}, b)).success).toBe(true);
    expect((await api('GET', 'calls.missedCount', {}, b)).count).toBe(0);
  });

  it('calls.roomCall prevê iniciar e entrar com os mesmos textos da recusa; call.room traz guard e contagem', async () => {
    const [owner, m, muted, outsider] = [await user(), await user(), await user(), await user()];
    const op = await newUser(A, { roles: ['operacao'] });
    const rid = await channel(owner, [m, muted, op]);
    await api('POST', 'rooms.muteUser', { roomId: rid, userId: muted.userId }, owner);
    const state = (auth: Auth, room = rid) => api('GET', 'calls.roomCall', { roomId: room }, auth);
    expect(await state(m)).toMatchObject({ call: null, canStart: true, hideStart: false, canJoin: false, transmission: false });
    expect(await state(op)).toMatchObject({ canStart: false, hideStart: true, startBlockedReason: 'Você não tem permissão para iniciar chamadas nesta sala.', viewerGuard: { restricted: true, exempt: false, speaks: true } });
    expect(await state(muted)).toMatchObject({ canStart: false, hideStart: false, startBlockedReason: 'Você está silenciado nesta sala.' });
    expect(await state(outsider)).toMatchObject({ canStart: false, hideStart: false, startBlockedReason: 'Entre na sala para iniciar uma chamada.' });
    const ro = await channel(owner, [m]);
    await api('POST', 'channels.setReadOnly', { roomId: ro, readOnly: true }, owner);
    expect(await state(m, ro)).toMatchObject({ canStart: false, hideStart: true, transmission: true, startBlockedReason: 'Esta sala não aceita chamadas.' });
    // Com a chamada viva.
    const wm = await online(m);
    const { id } = await startIn(fake, owner, rid);
    // Quem iniciou só conta como acompanhante depois de conectar (o call.room seguinte, agrupado, já traz isso).
    const ev = await wm.waitFor((e) => e.type === 'call.room' && e.call?._id === id && e.call.participantsCount === 1 && e.call.sample.length === 1 && e.call.guard?.chaperone);
    expect(ev.call.guard).toEqual({ mode: 'pairs', chaperone: true, restrictedSpeakers: 0, connectedSpeakers: 0 });
    const s = await state(m);
    expect(s).toMatchObject({ canStart: false, startBlockedReason: 'Já existe uma chamada em andamento nesta sala.', canJoin: true, listenOnly: false, call: { _id: id, participantsCount: 1 } });
    expect(Math.abs(Date.parse(s.serverTime) - Date.now())).toBeLessThan(5000);
    expect(await state(outsider)).toMatchObject({ canJoin: false, joinBlockedReason: 'Entre na sala para participar da chamada.' });
    // A recusa prevista é a mesma que o calls.join dá.
    expect((await join(outsider, id)).error).toBe('Entre na sala para participar da chamada.');
    const second = next(wm, (e) => e.type === 'call.room' && e.call?._id === id && e.call.participantsCount === 2);
    await enter(fake, m, id);
    const ev2 = await second;
    expect(ev2.call.sample.map((u: any) => u.username).sort()).toEqual([owner.username, m.username].sort());
    wm.close();
  });

  it('calls.inCall e call.presence: em chamada enquanto presente, nunca muda o status', async () => {
    const [owner, m, watcher] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m]);
    const ww = await online(watcher);
    const wm = await online(m);
    expect((await api('GET', 'calls.inCall', { userIds: [m.userId, owner.userId].join(',') }, watcher)).userIds).toEqual([]);
    const { id } = await startIn(fake, owner, rid);
    const on = next(ww, (e) => e.type === 'call.presence' && e.userId === m.userId && e.inCall === true);
    await enter(fake, m, id);
    await on;
    expect((await api('GET', 'calls.inCall', { userIds: [m.userId, owner.userId, watcher.userId].join(',') }, watcher)).userIds.sort()).toEqual([m.userId, owner.userId].sort());
    expect((await api('GET', 'users.getStatus', { userId: m.userId }, watcher)).status).toBe('online');
    const off = next(ww, (e) => e.type === 'call.presence' && e.userId === m.userId && e.inCall === false);
    await api('POST', 'calls.leave', { callId: id }, m);
    await settle();
    await off;
    expect((await api('GET', 'calls.inCall', { userIds: m.userId }, watcher)).userIds).toEqual([]);
    expect(await api('GET', 'calls.inCall', { userIds: Array.from({ length: 201 }, (_, i) => `x${i}`).join(',') }, watcher)).toMatchObject({ status: 400 });
    ww.close();
    wm.close();
  });

  it('retenção: com Calls_History_Retention_Days, chamadas antigas e seus participantes somem', async () => {
    const [owner, m] = [await user(), await user()];
    const rid = await channel(owner, [m]);
    const old = await startIn(fake, owner, rid);
    await enter(fake, m, old.id);
    await api('POST', 'calls.end', { callId: old.id }, owner);
    const recent = await startIn(fake, owner, rid);
    await api('POST', 'calls.end', { callId: recent.id }, owner);
    await pool.query(`UPDATE calls SET ended_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
    await setSettings(A, { Calls_History_Retention_Days: 30 });
    try {
      resetRetentionGate();
      await sweep();
    } finally {
      await setSettings(A, { Calls_History_Retention_Days: 0 });
    }
    expect(await callRow(old.id)).toBeUndefined();
    expect((await pool.query('SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1', [old.id])).rows[0].n).toBe(0);
    expect(await callRow(recent.id)).toBeTruthy();
    // A mensagem do cartão segue a retenção de mensagens, não a das chamadas.
    expect((await history(owner, rid)).filter((x) => x.t === 'call_group')).toHaveLength(2);
  });

  it('v1a: DM em grupo somente leitura não inicia; sala que virou somente leitura recusa entrar antes da reconciliação', async () => {
    const [u1, u2] = [await user(), await user()];
    const drid = await dm(A, [u1, u2]);
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: drid, readOnly: true }, A)).success).toBe(true);
    expect(await start(u1, drid)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Esta sala não aceita chamadas.' });
    expect(await api('GET', 'calls.roomCall', { roomId: drid }, u2)).toMatchObject({ canStart: false, hideStart: true, transmission: true, startBlockedReason: 'Esta sala não aceita chamadas.' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = $1`, [drid])).rows[0].n).toBe(0);
    // Chamada viva numa sala que acabou de virar somente leitura: ninguém mais entra, e a prévia diz o mesmo.
    const [owner, m, n] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, n]);
    const { id } = await startIn(fake, owner, rid);
    await enter(fake, m, id);
    expect((await api('POST', 'channels.setReadOnly', { roomId: rid, readOnly: true }, owner)).success).toBe(true);
    expect(await api('GET', 'calls.roomCall', { roomId: rid }, n)).toMatchObject({ transmission: true, canJoin: false, joinBlockedReason: 'Esta sala não aceita chamadas.' });
    expect(await join(n, id)).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Esta sala não aceita chamadas.' });
    expect(await part(id, n.userId)).toBeUndefined();
    await sweep();
    expect(await callRow(id)).toMatchObject({ status: 'ended', ended_reason: 'readonly' });
  });

  it('ligação a dois (P2P) não espera na fila de entradas do servidor de chamadas; em grupo, espera', async () => {
    const [a, b, owner, m] = [await user(), await user(), await user(), await user()];
    const rd = await dm(a, [b]);
    const rid = await channel(owner, [m]);
    const [wa, wb] = [await online(a), await online(b)];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // As 8 vagas ocupadas, como no meio de uma enxurrada de entradas em grupo.
    const busy = Array.from({ length: 8 }, () => entryGate(() => held));
    const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'esperando' as const)]);
    try {
      const s: any = await within(api('POST', 'calls.start', { roomId: rd, kind: 'audio', connectionId: wa.connectionId }, a), 3000);
      expect(s).toMatchObject({ success: true, call: { status: 'ringing' } });
      const acc = await within(api('POST', 'calls.accept', { callId: s.call._id, connectionId: wb.connectionId }, b), 3000);
      expect(acc).toMatchObject({ success: true, call: { status: 'ongoing' } });
      expect((await api('POST', 'calls.end', { callId: s.call._id }, a)).success).toBe(true);
      const g = start(owner, rid);
      expect(await within(g, 500)).toBe('esperando');
      release();
      expect((await g).success).toBe(true);
    } finally {
      release();
      await Promise.all(busy);
      wa.close();
      wb.close();
    }
  });

  it('sair, ser removido ou sair da sala manda o "call" só para quem saiu; os outros ficam com o call.room agrupado', async () => {
    const [owner, a, b, c, d] = [await user(), await user(), await user(), await user(), await user()];
    const rid = await channel(owner, [a, b, c, d]);
    const { id } = await startIn(fake, owner, rid);
    for (const u of [a, b, c, d]) await enter(fake, u, id);
    await settle();
    const spy = vi.spyOn(bus, 'publish');
    const callTargets = () => spy.mock.calls.filter(([, e]: any[]) => e.type === 'call' && e.call?._id === id).map(([t]) => t);
    try {
      expect((await api('POST', 'calls.leave', { callId: id }, a)).success).toBe(true);
      await settle();
      expect(callTargets()).toEqual([{ user: a.userId }]);
      spy.mockClear();
      expect((await api('POST', 'calls.moderate', { callId: id, userId: b.userId, action: 'remove' }, owner)).success).toBe(true);
      await settle();
      expect(callTargets()).toEqual([{ user: b.userId }]);
      spy.mockClear();
      expect((await api('POST', 'channels.leave', { roomId: rid }, c)).success).toBe(true);
      await settle();
      expect(callTargets()).toEqual([{ user: c.userId }]);
      // A contagem nova chega para a sala pelo call.room.
      const room = spy.mock.calls.filter(([, e]: any[]) => e.type === 'call.room' && e.call?._id === id).map(([, e]: any[]) => e.call.participantsCount);
      expect(room.at(-1)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('tarefa agrupada que já tinha lido a chamada viva não sai depois do fim (call.room null e cartão final ficam)', async () => {
    const [owner, m, w] = [await user(), await user(), await user()];
    const rid = await channel(owner, [m, w]);
    const ow = await online(owner);
    const r1 = await startIn(fake, m, rid);
    await enter(fake, w, r1.id);
    await settle();
    // call.room: a tarefa agrupada está montando o resumo quando o anfitrião encerra.
    slow.hit = false;
    slow.room = true;
    try {
      touchCall(r1.id);
      while (!slow.hit) await sleep(5);
      const since = ow.events.length;
      expect((await api('POST', 'calls.end', { callId: r1.id }, m)).success).toBe(true);
      await sleep(slow.ms + 300);
      await settle();
      const rooms = eventsSince(ow, since, (e) => e.type === 'call.room' && e.rid === rid).map((e) => e.call?.status ?? null);
      expect(rooms.at(-1)).toBeNull();
    } finally {
      slow.room = false;
    }
    // Cartão: a atualização agrupada está lendo as contagens quando a chamada acaba.
    const r2 = await startIn(fake, m, rid);
    await enter(fake, w, r2.id);
    await settle();
    slow.hit = false;
    slow.card = true;
    touchCall(r2.id);
    const flushing = settle();
    while (!slow.hit) await sleep(5);
    expect((await api('POST', 'calls.end', { callId: r2.id }, m)).success).toBe(true);
    await flushing;
    await sleep(slow.ms + 300);
    await settle();
    const card = (await pool.query(`SELECT m.extra->'call' AS card FROM calls c JOIN messages m ON m.id = c.message_id WHERE c.id = $1`, [r2.id])).rows[0].card;
    expect(card).toMatchObject({ status: 'ended' });
    expect(card.endedAt).toBeTruthy();
    ow.close();
  });

  it('a migração 014 dá call-management ao user só onde estava no padrão antigo e marca perdidas antigas como vistas', async () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../src/db/migrations/014_group_calls.sql'), 'utf8');
    const roles = async () => (await pool.query(`SELECT roles FROM permissions WHERE id = 'call-management'`)).rows[0].roles.sort();
    const original = await roles();
    try {
      await pool.query(`UPDATE permissions SET roles = ARRAY['admin', 'owner', 'moderator'] WHERE id = 'call-management'`);
      await pool.query(sql);
      expect(await roles()).toEqual(['admin', 'moderator', 'owner', 'user']);
      // Instalação que mudou o padrão: não é tocada.
      await pool.query(`UPDATE permissions SET roles = ARRAY['admin', 'moderator'] WHERE id = 'call-management'`);
      await pool.query(sql);
      expect(await roles()).toEqual(['admin', 'moderator']);
      const u = await user();
      await pool.query('UPDATE users SET calls_seen_at = NULL WHERE id = $1', [u.userId]);
      await pool.query(sql);
      expect((await pool.query('SELECT calls_seen_at FROM users WHERE id = $1', [u.userId])).rows[0].calls_seen_at).toBeTruthy();
    } finally {
      await pool.query(`UPDATE permissions SET roles = $1 WHERE id = 'call-management'`, [original]);
      await loadPermissions();
    }
    expect(lockViolations()).toEqual([]);
  });
});
