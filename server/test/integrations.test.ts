import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

let A: Auth;
let hook: http.Server;
let hookUrl = '';
const received: any[] = [];

beforeAll(async () => {
  await startServer();
  A = await admin();
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      received.push(data);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data.text?.includes('eco') ? { text: `Recebi: ${data.text}` } : {}));
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/in`;
});
afterAll(async () => {
  hook.close();
  await stopServer();
});

describe('integrações', () => {
  it('webhook de entrada publica no canal com apelido e anexos', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'CI', username: 'admin', channel: '#geral', alias: 'Robô CI', emoji: ':robot:' }, A);
    expect(r.success).toBe(true);
    const { _id, token } = r.integration;
    const res = await fetch(urlOf(`/hooks/${_id}/${token}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Build *verde*', attachments: [{ title: 'Pipeline', text: 'ok', color: '#0f0' }] }),
    });
    expect(res.status).toBe(200);
    const bad = await fetch(urlOf(`/hooks/${_id}/errado`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
    expect(bad.status).toBe(404);
    const geral = await api('GET', 'channels.info', { roomName: 'geral' }, A);
    const hist = await api('GET', 'channels.history', { roomId: geral.channel._id }, A);
    const m = hist.messages.find((x: any) => x.msg === 'Build *verde*');
    expect(m.alias).toBe('Robô CI');
    expect(m.attachments[0].title).toBe('Pipeline');
  });

  it('formato do Slack (payload em form-urlencoded) também funciona', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Slack', username: 'admin', channel: '#geral' }, A);
    const res = await fetch(urlOf(`/hooks/${r.integration._id}/${r.integration.token}`), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `payload=${encodeURIComponent(JSON.stringify({ text: 'via slack' }))}`,
    });
    expect(res.status).toBe(200);
  });

  it('webhook de saída dispara com palavra-gatilho e responde na sala', async () => {
    const u = await newUser(A);
    const r = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'Eco', username: 'admin', event: 'sendMessage', channel: 'all_public_channels', urls: [hookUrl], triggerWords: ['!eco'] }, A);
    expect(r.success).toBe(true);
    const geral = await api('GET', 'channels.info', { roomName: 'geral' }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: geral.channel._id, msg: 'sem gatilho' } }, u);
    await api('POST', 'chat.sendMessage', { message: { rid: geral.channel._id, msg: '!eco olá' } }, u);
    for (let i = 0; i < 40 && !received.some((x) => x.text === '!eco olá'); i++) await sleep(50);
    const call = received.find((x) => x.text === '!eco olá');
    expect(call.trigger_word).toBe('!eco');
    expect(call.user_name).toBe(u.username);
    expect(call.token).toBe(r.integration.token);
    expect(received.some((x) => x.text === 'sem gatilho')).toBe(false);
    let reply;
    for (let i = 0; i < 40 && !reply; i++) {
      await sleep(50);
      const hist = await api('GET', 'channels.history', { roomId: geral.channel._id }, A);
      reply = hist.messages.find((x: any) => x.msg === 'Recebi: !eco olá');
    }
    expect(reply.u.username).toBe('admin');
    const h = await api('GET', 'integrations.history', { id: r.integration._id }, A);
    expect(h.history[0].step).toBe('sent');
    expect(h.history[0].httpStatus).toBe(200);
  });

  it('scripts só rodam com a configuração ligada', async () => {
    const script = `class Script { process_incoming_request({ request }) { return { content: { text: 'Alerta: ' + request.content.alert } }; } }`;
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Script', username: 'admin', channel: '#geral', scriptEnabled: true, script }, A);
    const send = () => fetch(urlOf(`/hooks/${r.integration._id}/${r.integration.token}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alert: 'disco cheio', text: 'cru' }) });
    expect((await send()).status).toBe(200);
    await api('POST', 'settings', { settings: { Integrations_Scripts_Enabled: true } }, A);
    expect((await send()).status).toBe(200);
    const geral = await api('GET', 'channels.info', { roomName: 'geral' }, A);
    const hist = await api('GET', 'channels.history', { roomId: geral.channel._id }, A);
    expect(hist.messages.some((x: any) => x.msg === 'cru')).toBe(true);
    expect(hist.messages.some((x: any) => x.msg === 'Alerta: disco cheio')).toBe(true);
    const bad = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Quebrado', username: 'admin', channel: '#geral', scriptEnabled: true, script: 'class {' }, A);
    expect(bad.errorType).toBe('error-invalid-script');
  });

  it('usuário comum não gerencia integrações', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'integrations.list', undefined, u)).status).toBe(403);
    const list = await api('GET', 'integrations.list', undefined, A);
    expect(list.total).toBeGreaterThanOrEqual(4);
  });
});
