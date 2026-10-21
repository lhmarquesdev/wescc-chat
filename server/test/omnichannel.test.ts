import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

let A: Auth;
let ag1: Auth;
let ag2: Auth;
const sockets: { close(): void }[] = [];

async function settings(s: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings: s }, A);
  expect(r.success).toBe(true);
}

async function makeAgent() {
  const u = await newUser(A);
  expect((await api('POST', 'livechat/users/agent', { username: u.username }, A)).success).toBe(true);
  const ws = connectWs(u);
  await ws.ready;
  sockets.push(ws);
  expect((await api('POST', 'livechat/agent.status', { status: 'available' }, u)).status).toBe('available');
  return u;
}

let vseq = 0;
async function visitor(extra: Record<string, unknown> = {}) {
  const token = `visitor-token-${++vseq}-${Math.random().toString(36).slice(2)}`;
  const r = await api('POST', 'livechat/visitor', { visitor: { token, name: `Cliente ${vseq}`, email: `cliente${vseq}@ex.com`, ...extra } });
  expect(r.success).toBe(true);
  return { token, visitor: r.visitor };
}

async function startChat(token: string, msg = 'Olá, preciso de ajuda', department?: string) {
  const room = await api('GET', 'livechat/room', { token, ...(department ? { department } : {}) });
  expect(room.success).toBe(true);
  const m = await api('POST', 'livechat/message', { token, rid: room.room._id, msg });
  expect(m.success).toBe(true);
  return room.room._id as string;
}

async function waitRoom(rid: string, pred: (r: any) => boolean, auth = A) {
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', 'livechat/room.info', { rid }, auth);
    if (r.room && pred(r.room)) return r.room;
    await sleep(50);
  }
  throw new Error('estado da sala não chegou');
}

function visitorWs(token: string) {
  const ws = new WebSocket(urlOf(`/livechat/websocket?token=${token}`).replace('http', 'ws'));
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  sockets.push(ws);
  return { ws, events, open: new Promise((r) => ws.on('open', r)) };
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await settings({ Livechat_enabled: true, Livechat_Routing_Method: 'Load_Balancing' });
  ag1 = await makeAgent();
  ag2 = await makeAgent();
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await stopServer();
});

describe('omnichannel: widget e roteamento', () => {
  it('serve o widget e a configuração pública', async () => {
    const html = await fetch(urlOf('/livechat'));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('wescc.livechat.token');
    const js = await fetch(urlOf('/livechat/widget.js'));
    expect(await js.text()).toContain('WesccLivechat');
    const cfg = await api('GET', 'livechat/config');
    expect(cfg.config.enabled).toBe(true);
    expect(cfg.config.online).toBe(true);
  });

  it('visitante conversa com o agente nos dois sentidos, em tempo real', async () => {
    const { token } = await visitor();
    const vws = visitorWs(token);
    await vws.open;
    const rid = await startChat(token);
    const room = await waitRoom(rid, (r) => r.status === 'open');
    const agent = room.servedBy.username === ag1.username ? ag1 : ag2;
    const subs = await api('GET', 'subscriptions.get', undefined, agent);
    expect(subs.update.some((s: any) => s.rid === rid && s.t === 'l')).toBe(true);
    const sent = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'Oi! Como posso ajudar?' } }, agent);
    expect(sent.success).toBe(true);
    for (let i = 0; i < 40 && !vws.events.some((e) => e.type === 'message' && e.message.msg === 'Oi! Como posso ajudar?'); i++) await sleep(50);
    expect(vws.events.some((e) => e.type === 'message' && e.message.msg === 'Oi! Como posso ajudar?')).toBe(true);
    // Visitante não recebe eventos globais (presença dos usuários).
    expect(vws.events.some((e) => e.type === 'presence')).toBe(false);
    const hist = await api('GET', `livechat/messages.history/${rid}`, { token });
    expect(hist.messages.map((m: any) => m.msg)).toContain('Olá, preciso de ajuda');
    // Outro visitante não lê a conversa.
    const other = await visitor();
    expect((await api('GET', `livechat/messages.history/${rid}`, { token: other.token })).status).toBe(404);
    // Usuário comum não vê a sala.
    const u = await newUser(A);
    expect((await api('GET', 'livechat/room.info', { rid }, u)).status).toBe(403);
    expect((await api('GET', 'channels.history', { roomId: rid }, u)).success).not.toBe(true);
    await api('POST', 'livechat/room.closeByUser', { rid, comment: 'resolvido' }, agent);
  });

  it('balanceamento de carga divide entre agentes e respeita o limite de chats', async () => {
    await settings({ Livechat_maximum_chats_per_agent: 1 });
    const v1 = await visitor();
    const v2 = await visitor();
    const v3 = await visitor();
    const r1 = await startChat(v1.token);
    const r2 = await startChat(v2.token);
    const a = await waitRoom(r1, (r) => r.status === 'open');
    const b = await waitRoom(r2, (r) => r.status === 'open');
    expect(a.servedBy._id).not.toBe(b.servedBy._id);
    const r3 = await startChat(v3.token);
    await sleep(150);
    expect((await api('GET', 'livechat/room.info', { rid: r3 }, A)).room.status).toBe('queued');
    const q = await api('GET', 'livechat/inquiries.queuedForUser', undefined, ag1);
    expect(q.inquiries.map((i: any) => i.rid)).toContain(r3);
    // Ao encerrar um chat, a fila anda para o agente liberado.
    const freed = a.servedBy._id === ag1.userId ? ag1 : ag2;
    await api('POST', 'livechat/room.closeByUser', { rid: r1 }, freed);
    const served = await waitRoom(r3, (r) => r.status === 'open');
    expect(served.servedBy._id).toBe(freed.userId);
    await api('POST', 'livechat/room.closeByUser', { rid: r2 }, a.servedBy._id === ag1.userId ? ag2 : ag1);
    await api('POST', 'livechat/room.closeByUser', { rid: r3 }, freed);
    await settings({ Livechat_maximum_chats_per_agent: 0 });
  });

  it('fila manual: agente assume e ninguém mais pega a mesma conversa', async () => {
    await settings({ Livechat_Routing_Method: 'Manual_Selection' });
    const v = await visitor();
    const rid = await startChat(v.token);
    await sleep(100);
    expect((await api('GET', 'livechat/room.info', { rid }, A)).room.status).toBe('queued');
    const take = await api('POST', 'livechat/inquiries.take', { inquiryId: rid }, ag1);
    expect(take.room.servedBy.username).toBe(ag1.username);
    expect((await api('POST', 'livechat/inquiries.take', { inquiryId: rid }, ag2)).errorType).toBe('error-inquiry-taken');
    // Devolve para a fila e o outro agente assume.
    await api('POST', 'livechat/inquiries.returnAsInquiry', { roomId: rid }, ag1);
    expect((await api('POST', 'livechat/inquiries.take', { inquiryId: rid }, ag2)).success).toBe(true);
    await api('POST', 'livechat/room.closeByUser', { rid }, ag2);
    await settings({ Livechat_Routing_Method: 'Auto_Selection' });
  });

  it('transferência para agente e para departamento, espera e retomada', async () => {
    const dep = await api('POST', 'livechat/department', { department: { name: 'Financeiro', requestTagBeforeClosingChat: true }, agents: [{ agentId: ag2.userId }] }, A);
    expect(dep.success).toBe(true);
    const v = await visitor();
    const rid = await startChat(v.token);
    const room = await waitRoom(rid, (r) => r.status === 'open');
    const from = room.servedBy._id === ag1.userId ? ag1 : ag2;
    const to = from === ag1 ? ag2 : ag1;
    const fw = await api('POST', 'livechat/room.forward', { roomId: rid, userId: to.userId, comment: 'é com você' }, from);
    expect(fw.room.servedBy._id).toBe(to.userId);
    expect((await api('POST', 'chat.sendMessage', { message: { rid, msg: 'ainda aqui?' } }, from)).success).not.toBe(true);
    // Para departamento: só ag2 está no Financeiro (quem transfere não recebe de volta).
    if (to === ag2) await api('POST', 'livechat/room.forward', { roomId: rid, userId: ag1.userId }, ag2);
    await api('POST', 'livechat/room.forward', { roomId: rid, departmentId: dep.department._id }, ag1);
    const inDept = await waitRoom(rid, (r) => r.departmentId === dep.department._id && r.status === 'open');
    expect(inDept.servedBy._id).toBe(ag2.userId);
    // Espera: só quando o visitante não está aguardando resposta.
    expect((await api('POST', 'livechat/room.onHold', { roomId: rid }, ag2)).errorType).toBe('error-visitor-waiting');
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'Vou verificar e já volto.' } }, ag2);
    expect((await api('POST', 'livechat/room.onHold', { roomId: rid }, ag2)).success).toBe(true);
    await waitRoom(rid, (r) => r.status === 'onhold');
    await api('POST', 'livechat/message', { token: v.token, rid, msg: 'ok, aguardo' });
    await waitRoom(rid, (r) => r.status === 'open');
    // Departamento exige tag para encerrar.
    expect((await api('POST', 'livechat/room.closeByUser', { rid }, ag2)).errorType).toBe('error-tags-required');
    expect((await api('POST', 'livechat/room.closeByUser', { rid, tags: ['boleto'], comment: 'enviado 2ª via' }, ag2)).success).toBe(true);
    const closed = await waitRoom(rid, (r) => r.status === 'closed');
    expect(closed.tags).toContain('boleto');
    expect(closed.closer).toBe('user');
    // Pesquisa de satisfação depois de encerrar.
    expect((await api('POST', 'livechat/room.survey', { token: v.token, rid, data: [{ name: 'satisfaction', value: '5' }] })).success).toBe(true);
    // O agente que atendeu ainda vê o histórico da conversa encerrada.
    expect((await api('GET', 'livechat/room.info', { rid }, ag2)).room.survey.satisfaction).toBe('5');
  });

  it('prioridade e SLA ordenam a fila', async () => {
    await settings({ Livechat_Routing_Method: 'Manual_Selection' });
    const sla = await api('POST', 'livechat/sla', { name: 'Ouro', dueTimeInMinutes: 15 }, A);
    expect(sla.success).toBe(true);
    const v1 = await visitor();
    const v2 = await visitor();
    const r1 = await startChat(v1.token);
    const r2 = await startChat(v2.token);
    await api('POST', 'livechat/room.saveInfo', { rid: r2, roomData: { priorityId: 'highest', slaId: sla.sla._id } }, A);
    const q = await api('GET', 'livechat/inquiries.queuedForUser', undefined, ag1);
    const order = q.inquiries.map((i: any) => i.rid);
    expect(order.indexOf(r2)).toBeLessThan(order.indexOf(r1));
    const info = await api('GET', 'livechat/room.info', { rid: r2 }, A);
    expect(info.room.sla.name).toBe('Ouro');
    expect(info.room.priority._id).toBe('highest');
    for (const rid of [r1, r2]) await api('POST', 'livechat/room.closeByUser', { rid, comment: 'teste' }, A);
    await settings({ Livechat_Routing_Method: 'Auto_Selection' });
  });
});

describe('omnichannel: gestão', () => {
  it('respostas prontas por escopo', async () => {
    expect((await api('POST', 'canned-responses', { shortcut: 'ola', text: 'Olá {{contact.name}}!', scope: 'global' }, A)).success).toBe(true);
    expect((await api('POST', 'canned-responses', { shortcut: 'minha', text: 'Pessoal', scope: 'user' }, ag1)).success).toBe(true);
    expect((await api('POST', 'canned-responses', { shortcut: 'global2', text: 'x', scope: 'global' }, ag1)).status).toBe(403);
    const mine = await api('GET', 'canned-responses.get', undefined, ag1);
    expect(mine.responses.map((r: any) => r.shortcut).sort()).toEqual(['minha', 'ola']);
    const other = await api('GET', 'canned-responses.get', undefined, ag2);
    expect(other.responses.map((r: any) => r.shortcut)).toEqual(['ola']);
  });

  it('monitor só enxerga os departamentos das suas unidades', async () => {
    const mon = await newUser(A);
    await api('POST', 'livechat/users/monitor', { username: mon.username }, A);
    const depA = await api('POST', 'livechat/department', { department: { name: 'Suporte' }, agents: [{ agentId: ag1.userId }] }, A);
    const depB = await api('POST', 'livechat/department', { department: { name: 'Vendas' }, agents: [{ agentId: ag1.userId }] }, A);
    const unit = await api('POST', 'livechat/units', { name: 'Unidade Sul', departments: [depA.department._id], monitors: [mon.userId] }, A);
    expect(unit.success).toBe(true);
    const va = await visitor();
    const vb = await visitor();
    const ra = await startChat(va.token, 'suporte', depA.department._id);
    const rb = await startChat(vb.token, 'vendas', depB.department._id);
    const list = await api('GET', 'livechat/rooms', undefined, mon);
    const ids = list.rooms.map((r: any) => r._id);
    expect(ids).toContain(ra);
    expect(ids).not.toContain(rb);
    expect((await api('GET', 'livechat/room.info', { rid: rb }, mon)).status).toBe(403);
    for (const rid of [ra, rb]) await api('POST', 'livechat/room.closeByUser', { rid }, A);
  });

  it('horário de atendimento fecha o widget e guarda mensagem offline', async () => {
    await api('POST', 'livechat/business-hours', { _id: 'default', name: 'Padrão', workHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '08:00', close: '18:00', enabled: false })) }, A);
    await settings({ Livechat_enable_business_hours: true });
    expect((await api('GET', 'livechat/config')).config.online).toBe(false);
    const v = await visitor();
    expect((await api('GET', 'livechat/room', { token: v.token })).errorType).toBe('error-no-agents-online');
    expect((await api('POST', 'livechat/offline.message', { name: 'Ana', email: 'ana@ex.com', message: 'Me liguem amanhã' })).success).toBe(true);
    const off = await api('GET', 'livechat/offline.messages', undefined, A);
    expect(off.messages[0].message).toBe('Me liguem amanhã');
    await settings({ Livechat_enable_business_hours: false });
    expect((await api('GET', 'livechat/config')).config.online).toBe(true);
  });

  it('contatos, relatórios e monitoramento em tempo real', async () => {
    const contacts = await api('GET', 'livechat/visitors.search', { text: 'Cliente' }, ag1);
    expect(contacts.total).toBeGreaterThan(3);
    expect(contacts.visitors[0].token).toBeUndefined();
    const today = new Date().toISOString().slice(0, 10);
    const rep = await api('GET', 'livechat/analytics/overview', { start: today, end: today }, A);
    expect(rep.totals.conversations).toBeGreaterThan(3);
    expect(rep.totals.closed).toBeGreaterThan(0);
    expect(rep.byTag.some((t: any) => t.name === 'boleto')).toBe(true);
    expect(rep.totals.satisfaction).toBe(5);
    const rt = await api('GET', 'livechat/analytics/realtime', undefined, A);
    expect(rt.agents.available).toBe(2);
    expect((await api('GET', 'livechat/analytics/overview', undefined, ag1)).status).toBe(403);
  });
});
