import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_SFU_NOT_CONFIGURED, roomCallNeedsPoll } from '@shared/call-view';
import { sfuConfig } from '../src/calls/livekit';
import { pool } from '../src/db/pool';
import { newId } from '../src/lib/ids';
import { sweepCalls } from '../src/services/calls';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  // Chamadas em grupo desligadas: estes testes exercitam só as chamadas a dois (P2P), como antes.
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Calls_Group_Enabled: false } }, A);
});
afterAll(() => stopServer());

// Usuário com o chat aberto: WebSocket conectado e o id da conexão (usado pela sinalização).
async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  const connectionId = ws.events.find((e) => e.type === 'connected').connectionId as string;
  return { ...ws, connectionId };
}

async function dmWith(a: Auth, b: Auth) {
  return (await api('POST', 'im.create', { username: b.username }, a)).room._id as string;
}

// O canal padrão (#geral): sala de grupo, recusada enquanto as chamadas em grupo estão desligadas.
const generalId = async () => (await pool.query(`SELECT id FROM rooms WHERE is_default AND t = 'c' LIMIT 1`)).rows[0].id as string;

const callEvent = (ws: Awaited<ReturnType<typeof online>>, id: string, status: string) => ws.waitFor((e) => e.type === 'call' && e.call._id === id && e.call.status === status);

async function until(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condição não aconteceu a tempo');
    await sleep(50);
  }
}

describe('chamadas em mensagens diretas', () => {
  it('toca, é atendida, repassa a sinalização só entre as duas conexões e registra a duração', async () => {
    const u = await newUser(A);
    const intruder = await newUser(A);
    const [wa, wu, wi] = await Promise.all([online(A), online(u), online(intruder)]);
    const rid = await dmWith(A, u);

    expect((await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: 'qualquer' }, A)).errorType).toBe('error-call-connection');
    expect((await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: wu.connectionId }, A)).errorType).toBe('error-call-connection');
    expect((await api('POST', 'calls.start', { roomId: 'GENERAL', kind: 'video', connectionId: wa.connectionId }, A)).errorType).toBe('error-room-not-found');
    expect((await api('POST', 'calls.start', { roomId: await generalId(), kind: 'video', connectionId: wa.connectionId }, A)).errorType).toBe('error-call-group-disabled');

    const started = await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: wa.connectionId }, A);
    expect(started.call).toMatchObject({ status: 'ringing', kind: 'video', caller: { username: 'admin' }, callee: { username: u.username } });
    const id = started.call._id;
    await callEvent(wu, id, 'ringing');
    expect(wi.events.some((e) => e.type === 'call')).toBe(false);
    // Só quem recebe atende.
    expect((await api('POST', 'calls.accept', { callId: id, connectionId: wa.connectionId }, A)).success).toBe(false);
    const accepted = await api('POST', 'calls.accept', { callId: id, connectionId: wu.connectionId }, u);
    expect(accepted.call).toMatchObject({ status: 'ongoing', calleeConnectionId: wu.connectionId });
    await callEvent(wa, id, 'ongoing');

    wa.send({ type: 'call.signal', callId: id, data: { sdp: { type: 'offer', sdp: 'v=0 oferta' } } });
    const got = await wu.waitFor((e) => e.type === 'call.signal');
    expect(got).toEqual({ type: 'call.signal', callId: id, data: { sdp: { type: 'offer', sdp: 'v=0 oferta' } } });
    wu.send({ type: 'call.signal', callId: id, data: { candidate: { candidate: 'c1' } } });
    await wa.waitFor((e) => e.type === 'call.signal' && e.data.candidate?.candidate === 'c1');
    // Terceiro não injeta sinalização.
    wi.send({ type: 'call.signal', callId: id, data: { sdp: { type: 'answer', sdp: 'falsa' } } });
    await sleep(300);
    expect(wa.events.some((e) => e.type === 'call.signal' && e.data.sdp?.sdp === 'falsa')).toBe(false);
    expect((await api('POST', 'calls.end', { callId: id }, intruder)).success).toBe(false);

    await sleep(1100);
    const ended = await api('POST', 'calls.end', { callId: id }, A);
    expect(ended.call.status).toBe('ended');
    expect(ended.call.duration).toBeGreaterThanOrEqual(1);
    await callEvent(wu, id, 'ended');
    const hist = await api('GET', 'im.history', { roomId: rid }, u);
    expect(hist.messages[0]).toMatchObject({ t: 'call_ended', call: { kind: 'video', status: 'ended' } });
    for (const w of [wa, wu, wi]) w.close();
  });

  it('chamada não atendida vira perdida; quem já está em chamada recebe como ocupado', async () => {
    const u = await newUser(A);
    const other = await newUser(A);
    const [wa, wu, wo] = await Promise.all([online(A), online(u), online(other)]);
    const rid = await dmWith(A, u);
    const first = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).call;
    // Enquanto toca para u, outra pessoa liga para u: ocupado.
    const rid2 = await dmWith(other, u);
    const busy = (await api('POST', 'calls.start', { roomId: rid2, kind: 'audio', connectionId: wo.connectionId }, other)).call;
    expect(busy.status).toBe('busy');
    // Quem já está em chamada não começa outra.
    expect((await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).errorType).toBe('error-call-in-progress');
    // O toque mínimo agora é 10 s: o teste adianta o relógio em vez de esperar.
    await pool.query(`UPDATE calls SET created_at = now() - interval '41 seconds' WHERE id = $1`, [first._id]);
    await sweepCalls();
    await callEvent(wu, first._id, 'missed');
    const list = await api('GET', 'calls.list', {}, u);
    expect(list.calls.map((c: any) => c.status).slice(0, 2).sort()).toEqual(['busy', 'missed']);
    for (const w of [wa, wu, wo]) w.close();
  });

  it('recusar e cancelar; a chamada termina se uma das conexões cai e não volta a tempo', async () => {
    const u = await newUser(A);
    const [wa, wu] = await Promise.all([online(A), online(u)]);
    const rid = await dmWith(A, u);
    const c1 = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).call;
    expect((await api('POST', 'calls.decline', { callId: c1._id }, u)).call.status).toBe('declined');
    const c2 = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).call;
    expect((await api('POST', 'calls.end', { callId: c2._id }, A)).call.status).toBe('canceled');

    const c3 = (await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: wa.connectionId }, A)).call;
    await api('POST', 'calls.accept', { callId: c3._id, connectionId: wu.connectionId }, u);
    wu.close();
    // A chamada não cai junto com a conexão: anota a queda e espera a pessoa voltar.
    await until(async () => !!(await pool.query('SELECT callee_lost_at FROM calls WHERE id = $1', [c3._id])).rows[0].callee_lost_at);
    await sweepCalls();
    expect((await api('GET', 'calls.info', { callId: c3._id }, A)).call.status).toBe('ongoing');
    // Sem volta a tempo: a varredura encerra como queda de quem caiu, com a duração até a queda (não até a varredura).
    await pool.query(`UPDATE calls SET answered_at = now() - interval '90 seconds', callee_lost_at = now() - interval '40 seconds' WHERE id = $1`, [c3._id]);
    await sweepCalls();
    await callEvent(wa, c3._id, 'ended');
    const info = await api('GET', 'calls.info', { callId: c3._id }, A);
    expect(info.call).toMatchObject({ endedBy: u.userId, endedReason: 'dropped', duration: 50 });
    const hist = await api('GET', 'im.history', { roomId: rid }, A);
    expect(hist.messages[0]).toMatchObject({ t: 'call_ended', call: { _id: c3._id, duration: 50 } });
    expect((await api('GET', 'calls.list', {}, u)).calls[0]).toMatchObject({ _id: c3._id, mine: { leftReason: 'disconnected', seconds: 50 } });
    expect((await api('GET', 'calls.list', {}, A)).calls[0]).toMatchObject({ _id: c3._id, mine: { leftReason: 'ended', seconds: 50 } });
    wa.close();
  });

  it('a conexão em tempo real cai e volta: a chamada a dois segue, com a sinalização pela conexão nova', async () => {
    const u = await newUser(A);
    const intruder = await newUser(A);
    const [wa, wu] = await Promise.all([online(A), online(u)]);
    const rid = await dmWith(A, u);
    const c = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).call;
    await api('POST', 'calls.accept', { callId: c._id, connectionId: wu.connectionId }, u);
    await callEvent(wa, c._id, 'ongoing');
    wu.close();
    await until(async () => !!(await pool.query('SELECT callee_lost_at FROM calls WHERE id = $1', [c._id])).rows[0].callee_lost_at);
    const wu2 = await online(u);
    // Só quem está na chamada, com uma conexão da própria sessão.
    expect((await api('POST', 'calls.reattach', { callId: c._id, connectionId: wu2.connectionId }, intruder)).status).toBe(403);
    expect((await api('POST', 'calls.reattach', { callId: c._id, connectionId: wa.connectionId }, u)).errorType).toBe('error-call-connection');
    const back = await api('POST', 'calls.reattach', { callId: c._id, connectionId: wu2.connectionId }, u);
    expect(back.call).toMatchObject({ status: 'ongoing', calleeConnectionId: wu2.connectionId, callerConnectionId: wa.connectionId });
    await wa.waitFor((e) => e.type === 'call' && e.call._id === c._id && e.call.calleeConnectionId === wu2.connectionId);
    expect((await pool.query('SELECT callee_lost_at FROM calls WHERE id = $1', [c._id])).rows[0].callee_lost_at).toBeNull();
    // A sinalização (renegociação, compartilhar tela) passa pela conexão nova.
    wa.send({ type: 'call.signal', callId: c._id, data: { sdp: { type: 'offer', sdp: 'v=0 de novo' } } });
    await wu2.waitFor((e) => e.type === 'call.signal' && e.data.sdp?.sdp === 'v=0 de novo');
    wu2.send({ type: 'call.signal', callId: c._id, data: { candidate: { candidate: 'c2' } } });
    await wa.waitFor((e) => e.type === 'call.signal' && e.data.candidate?.candidate === 'c2');
    // A varredura não encerra quem voltou.
    await pool.query(`UPDATE calls SET created_at = now() - interval '5 minutes' WHERE id = $1`, [c._id]);
    await sweepCalls();
    expect((await api('GET', 'calls.info', { callId: c._id }, A)).call.status).toBe('ongoing');

    // Servidor reiniciado: a conexão some sem o aviso de fechamento; a varredura anota a queda e espera a volta.
    await pool.query('DELETE FROM presence_connections WHERE id = $1', [wa.connectionId]);
    await sweepCalls();
    expect((await pool.query('SELECT caller_lost_at FROM calls WHERE id = $1', [c._id])).rows[0].caller_lost_at).not.toBeNull();
    expect((await api('GET', 'calls.info', { callId: c._id }, A)).call.status).toBe('ongoing');
    const wa2 = await online(A);
    expect((await api('POST', 'calls.reattach', { callId: c._id, connectionId: wa2.connectionId }, A)).call).toMatchObject({ status: 'ongoing', callerConnectionId: wa2.connectionId });

    // Desligou enquanto a outra pessoa estava sem conexão: ao voltar, ela recebe a chamada encerrada, com o motivo.
    wu2.close();
    await until(async () => !!(await pool.query('SELECT callee_lost_at FROM calls WHERE id = $1', [c._id])).rows[0].callee_lost_at);
    expect((await api('POST', 'calls.end', { callId: c._id }, A)).call.status).toBe('ended');
    const wu3 = await online(u);
    expect((await api('POST', 'calls.reattach', { callId: c._id, connectionId: wu3.connectionId }, u)).call).toMatchObject({ status: 'ended', endedReason: 'hangup', endedBy: A.userId });
    for (const w of [wa, wu, wa2, wu3]) w.close();
  });

  it('administrador encerra a chamada a dois: o evento já traz quem encerrou, para o aviso nos dois lados', async () => {
    const u = await newUser(A);
    const v = await newUser(A);
    const [wu, wv] = await Promise.all([online(u), online(v)]);
    const rid = await dmWith(u, v);
    for (const answer of [true, false]) {
      const c = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wu.connectionId }, u)).call;
      if (answer) await api('POST', 'calls.accept', { callId: c._id, connectionId: wv.connectionId }, v);
      const status = answer ? 'ended' : 'canceled';
      const evs = [callEvent(wu, c._id, status), callEvent(wv, c._id, status)];
      expect((await api('POST', 'calls.admin.end', { callId: c._id }, A)).call.status).toBe(status);
      for (const e of await Promise.all(evs)) expect(e.call).toMatchObject({ endedReason: 'moderator', endedBy: A.userId, endedByUser: { _id: A.userId, username: 'admin' } });
    }
    for (const w of [wu, wv]) w.close();
  });

  it('a conexão direta entre os navegadores caiu: calls.end com dropped encerra como queda, sem culpar ninguém', async () => {
    const u = await newUser(A);
    const [wa, wu] = await Promise.all([online(A), online(u)]);
    const rid = await dmWith(A, u);
    const c = (await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wa.connectionId }, A)).call;
    await api('POST', 'calls.accept', { callId: c._id, connectionId: wu.connectionId }, u);
    const ended = (await api('POST', 'calls.end', { callId: c._id, dropped: true }, u)).call;
    expect(ended).toMatchObject({ status: 'ended', endedReason: 'dropped', endedBy: null });
    await callEvent(wa, c._id, 'ended');
    for (const w of [wa, wu]) w.close();
  });

  it('configuração entrega os servidores ICE (TURN com credenciais só para quem está logado)', async () => {
    await api('POST', 'settings', { settings: { Calls_TURN_Server: 'turn:turn.empresa.com.br:3478', Calls_TURN_Username: 'chat', Calls_TURN_Password: 'segredo-turn' } }, A);
    const u = await newUser(A);
    const cfg = await api('GET', 'calls.config', undefined, u);
    // Sem STUN por padrão: na rede interna não há a quem perguntar.
    expect(cfg.iceServers).toEqual([{ urls: ['turn:turn.empresa.com.br:3478'], username: 'chat', credential: 'segredo-turn' }]);
    expect(cfg).toMatchObject({ enabled: true, groupEnabled: false, directViaSfu: false, sfu: false, ringTimeout: 40, limits: { participants: 30, listeners: 300, videoPublishers: 16, maxHours: 12, ringPerAction: 10 } });
    expect(Math.abs(Date.parse(cfg.serverTime) - Date.now())).toBeLessThan(5000);
    expect((await api('GET', 'calls.config')).status).toBe(401);
  });

  it('credenciais TURN temporárias com Calls_TURN_Secret: usuário com validade e HMAC-SHA1 conferem', async () => {
    const secret = crypto.randomBytes(24).toString('base64url');
    await api('POST', 'settings', { settings: { Calls_TURN_Server: 'turn:turn.empresa.com.br:3478', Calls_TURN_Secret: secret } }, A);
    try {
      const u = await newUser(A);
      const cfg = await api('GET', 'calls.config', undefined, u);
      expect(cfg.iceServers).toHaveLength(1);
      const t = cfg.iceServers[0];
      expect(t.urls).toEqual(['turn:turn.empresa.com.br:3478']);
      const [expiry, id] = t.username.split(':');
      expect(id).toBe(u.userId);
      // Validade de 24 h a partir de agora.
      expect(Math.abs(Number(expiry) - (Math.floor(Date.now() / 1000) + 86400))).toBeLessThan(60);
      expect(t.credential).toBe(crypto.createHmac('sha1', secret).update(t.username).digest('base64'));
      // O usuário e a senha fixos não vão junto quando há segredo.
      expect(JSON.stringify(cfg)).not.toContain('segredo-turn');
    } finally {
      await api('POST', 'settings', { settings: { Calls_TURN_Secret: '', Calls_TURN_Server: '' } }, A);
    }
  });

  it('histórico migrado: chamadas antigas aparecem em calls.list com direção, duração e perdidas; perdidas antigas não contam no selo', async () => {
    const u = await newUser(A);
    const v = await newUser(A);
    const rid = await dmWith(u, v);
    // Linhas como a versão anterior gravava: só calls, sem participantes, e a coluna calls_seen_at ainda vazia.
    const old = [
      { id: newId(), status: 'ended', ago: 50, answered: 48, ended: 46, caller: u.userId, callee: v.userId },
      { id: newId(), status: 'missed', ago: 40, answered: null, ended: 39, caller: u.userId, callee: v.userId },
      { id: newId(), status: 'canceled', ago: 30, answered: null, ended: 29, caller: v.userId, callee: u.userId },
      { id: newId(), status: 'busy', ago: 20, answered: null, ended: 20, caller: u.userId, callee: v.userId },
    ];
    for (const c of old) {
      await pool.query(
        `INSERT INTO calls (id, room_id, caller_id, callee_id, kind, status, caller_conn, created_at, answered_at, ended_at)
         VALUES ($1, $2, $3, $4, 'audio', $5, 'conexao-antiga', now() - make_interval(mins => $6), now() - make_interval(mins => $7::int), now() - make_interval(mins => $8))`,
        [c.id, rid, c.caller, c.callee, c.status, c.ago, c.answered, c.ended],
      );
    }
    await pool.query('UPDATE users SET calls_seen_at = NULL WHERE id = ANY($1)', [[u.userId, v.userId]]);
    // A migração 014 é idempotente: aplicada de novo, preenche o histórico por pessoa dessas chamadas.
    await pool.query(fs.readFileSync(path.resolve(import.meta.dirname, '../src/db/migrations/014_group_calls.sql'), 'utf8'));

    const lv = await api('GET', 'calls.list', {}, v);
    expect(lv.total).toBe(4);
    const byId = new Map(lv.calls.map((c: any) => [c._id, c]));
    expect(byId.get(old[0].id)).toMatchObject({ status: 'ended', duration: 120, mine: { direction: 'incoming', missed: false, seconds: 120 } });
    expect(byId.get(old[1].id)).toMatchObject({ status: 'missed', mine: { direction: 'incoming', missed: true } });
    expect(byId.get(old[2].id)).toMatchObject({ status: 'canceled', mine: { direction: 'outgoing', missed: false } });
    // Ocupado conta como perdida para quem recebeu.
    expect(byId.get(old[3].id)).toMatchObject({ status: 'busy', mine: { direction: 'incoming', missed: true, leftReason: 'busy' } });
    expect((await api('GET', 'calls.list', { filter: 'missed' }, v)).calls.map((c: any) => c._id).sort()).toEqual([old[1].id, old[3].id].sort());
    expect((await api('GET', 'calls.list', { filter: 'outgoing' }, v)).calls.map((c: any) => c._id)).toEqual([old[2].id]);
    expect((await api('GET', 'calls.list', { filter: 'incoming', roomId: rid }, v)).total).toBe(3);
    // Para quem ligou e o outro cancelou: perdida (u recebeu a chamada cancelada).
    expect((await api('GET', 'calls.list', { filter: 'missed' }, u)).calls.map((c: any) => c._id)).toEqual([old[2].id]);
    // As perdidas antigas já contam como vistas.
    expect((await api('GET', 'calls.missedCount', {}, v)).count).toBe(0);
    expect((await api('GET', 'calls.missedCount', {}, u)).count).toBe(0);
  });

  it('limite de chamadas diretas: 10 por minuto, contadas só depois da validação', async () => {
    const u = await newUser(A);
    const v = await newUser(A);
    const wu = await online(u);
    const rid = await dmWith(u, v);
    await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: true } }, A);
    try {
      // Entrada inválida e recusa de política não contam.
      for (let i = 0; i < 12; i++) expect((await api('POST', 'calls.start', { roomId: rid, kind: 'tela', connectionId: wu.connectionId }, u)).errorType).toBe('error-invalid-params');
      const general = await generalId();
      for (let i = 0; i < 12; i++) expect((await api('POST', 'calls.start', { roomId: general, kind: 'audio', connectionId: wu.connectionId }, u)).errorType).toBe('error-call-group-disabled');
      for (let i = 0; i < 10; i++) {
        const r = await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wu.connectionId }, u);
        expect(r.call?.status).toBe('ringing');
        expect((await api('POST', 'calls.end', { callId: r.call._id }, u)).call.status).toBe('canceled');
      }
      const over = await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wu.connectionId }, u);
      expect(over).toMatchObject({ status: 429, errorType: 'error-call-rate-limit', error: 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.' });
    } finally {
      await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
      wu.close();
    }
  });
});

// O PC da Wescc roda sem LiveKit por enquanto: as chamadas em grupo ligadas, mas sem servidor de chamadas configurado,
// explicam isso (não "não está respondendo"), e as chamadas a dois seguem por P2P.
describe('sem servidor de chamadas configurado', () => {
  it('chamadas em grupo dão o motivo de não configurado em roomCall, calls.start, /call e no autoteste; a dois seguem por P2P', async () => {
    expect(sfuConfig().configured).toBe(false);
    const u = await newUser(A);
    const v = await newUser(A);
    const [wa, wu, wv] = await Promise.all([online(A), online(u), online(v)]);
    const general = await generalId();
    await api('POST', 'settings', { settings: { Calls_Group_Enabled: true } }, A);
    try {
      const notConfigured = { status: 503, errorType: 'error-call-sfu-not-configured', error: CALL_SFU_NOT_CONFIGURED };
      // Os botões da sala ficam, com o motivo, e a sala não fica conferindo de novo (não passa sozinho).
      const state = await api('GET', 'calls.roomCall', { roomId: general }, A);
      expect(state).toMatchObject({ call: null, canStart: false, hideStart: false, startBlockedReason: CALL_SFU_NOT_CONFIGURED });
      expect(roomCallNeedsPoll(state)).toBe(false);
      expect(await api('POST', 'calls.start', { roomId: general, kind: 'video', connectionId: wa.connectionId }, A)).toMatchObject(notConfigured);
      expect((await pool.query(`SELECT count(*)::int AS n FROM calls WHERE room_id = $1`, [general])).rows[0].n).toBe(0);
      expect(await api('POST', 'chat.sendMessage', { message: { rid: general, msg: '/call' } }, A)).toMatchObject(notConfigured);
      // Numa sala que não aceita chamadas (avisos, somente leitura) ou para quem não pode iniciar, o /call dá o motivo da
      // sala, como os botões (calls.roomCall), e não manda pedir ao administrador.
      const op = await newUser(A, { roles: ['operacao'] });
      const sends = async (extra: Record<string, unknown>, who: Auth) => {
        const r = await api('POST', 'channels.create', { name: `sem-lk-${newId().slice(0, 8).toLowerCase()}`, members: [u.username, op.username], ...extra }, A);
        expect(r.success).toBe(true);
        const rid = r.channel._id as string;
        const room = await api('GET', 'calls.roomCall', { roomId: rid }, who);
        return { room, call: await api('POST', 'chat.sendMessage', { message: { rid, msg: '/call' } }, who) };
      };
      for (const extra of [{ extraData: { broadcast: true } }, { readOnly: true }]) {
        const { room, call } = await sends(extra, A);
        expect(room).toMatchObject({ canStart: false, hideStart: true, startBlockedReason: 'Esta sala não aceita chamadas.' });
        expect(call).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Esta sala não aceita chamadas.' });
      }
      const noPerm = await sends({}, op);
      expect(noPerm.room).toMatchObject({ canStart: false, hideStart: true, startBlockedReason: 'Você não tem permissão para iniciar chamadas nesta sala.' });
      expect(noPerm.call).toMatchObject({ status: 403, errorType: 'error-call-not-allowed', error: 'Você não tem permissão para iniciar chamadas nesta sala.' });
      // Numa sala comum, quem pode iniciar recebe o motivo de não configurado.
      expect((await sends({}, u)).call).toMatchObject(notConfigured);
      expect(await api('POST', 'calls.selfTest', {}, A)).toMatchObject(notConfigured);
      expect(await api('GET', 'calls.config', {}, A)).toMatchObject({ enabled: true, groupEnabled: false, sfu: false });
      expect(await api('GET', 'calls.sfu.status', undefined, A)).toMatchObject({ configured: false, reachable: false, groupEnabled: true });

      // Mensagem direta a dois: P2P, sem LiveKit.
      const rid = await dmWith(u, v);
      expect(await api('GET', 'calls.roomCall', { roomId: rid }, u)).toMatchObject({ canStart: true });
      const prompt = wu.waitFor((e) => e.type === 'call.prompt');
      expect((await api('POST', 'chat.sendMessage', { message: { rid, msg: '/call voz' } }, u)).success).toBe(true);
      expect(await prompt).toEqual({ type: 'call.prompt', rid, kind: 'audio' });
      const started = await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wu.connectionId }, u);
      expect(started.call).toMatchObject({ status: 'ringing', scope: 'direct', media: 'p2p' });
      await callEvent(wv, started.call._id, 'ringing');
      const accepted = await api('POST', 'calls.accept', { callId: started.call._id, connectionId: wv.connectionId }, v);
      expect(accepted.call).toMatchObject({ status: 'ongoing', media: 'p2p' });
      expect((await api('POST', 'calls.end', { callId: started.call._id }, u)).call.status).toBe('ended');
    } finally {
      await api('POST', 'settings', { settings: { Calls_Group_Enabled: false } }, A);
      for (const w of [wa, wu, wv]) w.close();
    }
  });
});
