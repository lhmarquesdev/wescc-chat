import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
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

const callEvent = (ws: Awaited<ReturnType<typeof online>>, id: string, status: string) => ws.waitFor((e) => e.type === 'call' && e.call._id === id && e.call.status === status);

describe('chamadas em mensagens diretas', () => {
  it('toca, é atendida, repassa a sinalização só entre as duas conexões e registra a duração', async () => {
    const u = await newUser(A);
    const intruder = await newUser(A);
    const [wa, wu, wi] = await Promise.all([online(A), online(u), online(intruder)]);
    const rid = await dmWith(A, u);

    expect((await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: 'qualquer' }, A)).errorType).toBe('error-call-connection');
    expect((await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: wu.connectionId }, A)).errorType).toBe('error-call-connection');
    expect((await api('POST', 'calls.start', { roomId: 'GENERAL', kind: 'video', connectionId: wa.connectionId }, A)).errorType).toBe('error-call-room');

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
    await api('POST', 'settings', { settings: { Calls_Ring_Timeout: 1 } }, A);
    try {
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
      await callEvent(wu, first._id, 'missed');
      const list = await api('GET', 'calls.list', {}, u);
      expect(list.calls.map((c: any) => c.status).slice(0, 2).sort()).toEqual(['busy', 'missed']);
      for (const w of [wa, wu, wo]) w.close();
    } finally {
      await api('POST', 'settings', { settings: { Calls_Ring_Timeout: 40 } }, A);
    }
  });

  it('recusar e cancelar; a chamada termina se uma das conexões cai', async () => {
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
    await callEvent(wa, c3._id, 'ended');
    const info = await api('GET', 'calls.info', { callId: c3._id }, A);
    expect(info.call.endedBy).toBe(u.userId);
    wa.close();
  });

  it('configuração entrega os servidores ICE (TURN com credenciais só para quem está logado)', async () => {
    await api('POST', 'settings', { settings: { Calls_TURN_Server: 'turn:turn.empresa.com.br:3478', Calls_TURN_Username: 'chat', Calls_TURN_Password: 'segredo-turn' } }, A);
    const u = await newUser(A);
    const cfg = await api('GET', 'calls.config', undefined, u);
    expect(cfg.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turn:turn.empresa.com.br:3478'], username: 'chat', credential: 'segredo-turn' }]);
    expect((await api('GET', 'calls.config')).status).toBe(401);
  });
});
