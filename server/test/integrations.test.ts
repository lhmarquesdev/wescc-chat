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

  it('webhook de entrada mantém pretext, autor, miniatura e rodapé dos anexos e não monta citação', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'GitHub', username: 'admin', channel: '#geral' }, A);
    const geral = await api('GET', 'channels.info', { roomName: 'geral' }, A);
    const secreta = await api('POST', 'chat.postMessage', { channel: '#geral', text: 'texto que não deve ser citado' }, A);
    const rich = {
      pretext: 'Novo PR',
      author_name: 'octo',
      author_link: 'https://github.com/octo',
      author_icon: 'https://github.com/octo.png',
      thumb_url: 'https://github.com/thumb.png',
      footer: 'GitHub',
      title: 'PR #1',
      title_link: 'https://github.com/x/y/pull/1',
      text: 'corpo',
      color: 'good',
      fields: [{ title: 'Revisor', value: '@bia', short: true }],
    };
    const res = await fetch(urlOf(`/hooks/${r.integration._id}/${r.integration.token}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hook com anexos ricos',
        attachments: [
          rich,
          { message_link: `?msg=${secreta.message._id}`, text: 'só texto' },
          { title: 'links ruins', author_link: 'javascript:alert(1)', thumb_url: 'data:image/png;base64,AAAA', footer: 7 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const hist = await api('GET', 'channels.history', { roomId: geral.channel._id }, A);
    const m = hist.messages.find((x: any) => x.msg === 'hook com anexos ricos');
    expect(m.attachments).toHaveLength(3);
    expect(m.attachments[0]).toMatchObject(rich);
    // A citação é montada pelo servidor a partir da mensagem; vinda de um webhook, o link é ignorado.
    expect(m.attachments[1].message_link).toBeUndefined();
    expect(m.attachments[1].text).toBe('só texto');
    expect(m.attachments[1].author_name).toBeUndefined();
    // As mesmas regras do chat.postMessage: só URLs http(s) ou do servidor, e texto curto.
    expect(m.attachments[2]).toEqual({ title: 'links ruins', footer: '7' });
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

  it('destino inexistente e tentativas fora da faixa são recusados ao salvar', async () => {
    const base = { type: 'webhook-incoming', name: 'Destino', username: 'admin' };
    expect(await api('POST', 'integrations.create', { ...base, channel: '#naoexiste' }, A)).toMatchObject({ status: 400, errorType: 'error-invalid-channel', error: 'Canal não encontrado: #naoexiste' });
    expect(await api('POST', 'integrations.create', { ...base, channel: '@ninguem.aqui' }, A)).toMatchObject({ status: 400, error: 'Usuário não encontrado: @ninguem.aqui' });
    expect((await api('POST', 'integrations.create', { ...base, channel: 'all_public_channels' }, A)).errorType).toBe('error-invalid-channel');
    // Grupo privado de que o usuário da integração não participa: toda chamada falharia depois.
    const u = await newUser(A);
    const grupo = await api('POST', 'groups.create', { name: `grupo-${Date.now()}` }, A);
    expect(await api('POST', 'integrations.create', { ...base, username: u.username, channel: `#${grupo.group.name}` }, A)).toMatchObject({ status: 400, errorType: 'error-not-member' });
    const out = { type: 'webhook-outgoing', name: 'Saída', username: 'admin', event: 'sendMessage', urls: [hookUrl] };
    expect((await api('POST', 'integrations.create', { ...out, channel: '#naoexiste' }, A)).error).toBe('Canal não encontrado: #naoexiste');
    expect((await api('POST', 'integrations.create', { ...out, targetRoom: '#naoexiste' }, A)).error).toBe('Canal não encontrado: #naoexiste');
    expect(await api('POST', 'integrations.create', { ...out, retryCount: 99 }, A)).toMatchObject({ status: 400, errorType: 'error-invalid-retry-count', error: 'Tentativas: use um número inteiro de 0 a 10.' });
    expect((await api('POST', 'integrations.create', { ...out, retryCount: -1 }, A)).status).toBe(400);
    // Sem tentar de novo, o número não importa.
    expect((await api('POST', 'integrations.create', { ...out, retryFailedCalls: false, retryCount: 99 }, A)).success).toBe(true);
    const ok = await api('POST', 'integrations.create', { ...out, channel: ['#geral', 'all_private_groups'], targetRoom: '#geral', retryCount: 10 }, A);
    expect(ok.integration.retryCount).toBe(10);
  });

  it('webhook de entrada guarda cada chamada no histórico e explica JSON inválido em português', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Monitor', username: 'admin', channel: '#geral' }, A);
    const url = urlOf(`/hooks/${r.integration._id}/${r.integration.token}`);
    const post = (body: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post('{"text":"tudo certo"}')).status).toBe(200);
    const bad = await post('{ruim');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ success: false, error: 'O corpo da requisição não é um JSON válido.' });
    expect((await post('{}')).status).toBe(400);
    const h = await api('GET', 'integrations.history', { id: r.integration._id }, A);
    // O JSON inválido não chega à integração (o Fastify recusa antes); a mensagem vazia e a que deu certo, sim.
    expect(h.history.map((x: any) => [x.event, x.step, x.httpStatus])).toEqual([
      ['incoming', 'failed', 400],
      ['incoming', 'received', 200],
    ]);
    expect(h.history[0].error).toBe('Mensagem vazia.');
    expect(h.history[1].data).toEqual({ text: 'tudo certo' });
    // Corpo grande fica cortado no histórico.
    await post(JSON.stringify({ text: 'a'.repeat(6000) }));
    const big = await api('GET', 'integrations.history', { id: r.integration._id, count: 1 }, A);
    expect(typeof big.history[0].data).toBe('string');
    expect(big.history[0].data.length).toBeLessThanOrEqual(4001);
  });

  it('usuário comum não gerencia integrações', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'integrations.list', undefined, u)).status).toBe(403);
    const list = await api('GET', 'integrations.list', undefined, A);
    expect(list.total).toBeGreaterThanOrEqual(4);
  });
});
