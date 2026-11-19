import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/api/http';
import { initialsSvg } from '../src/api/users';
import { cleanInput, hasVisibleText } from '../src/lib/sanitize';
import { admin, api, newUser, startServer, stopServer, urlOf, type Auth } from './helpers';

// Entradas estranhas na API (texto colado de logs, webhooks, integrações e scripts): nada de "Erro interno do
// servidor" nem de mensagem em inglês; nomes e tópicos sem controles de direção; mensagem invisível é vazia.

let A: Auth;
let user: Auth;
let geral: string;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  user = await newUser(A);
  geral = (await api('GET', 'channels.info', { roomName: 'geral' }, A)).channel._id;
});
afterAll(() => stopServer());

const post = (path: string, body: string, auth: Auth, contentType = 'application/json') =>
  fetch(urlOf(`/api/v1/${path}`), { method: 'POST', headers: { 'content-type': contentType, 'x-user-id': auth.userId, 'x-auth-token': auth.authToken }, body }).then(async (r) => ({
    status: r.status,
    ...((await r.json()) as any),
  }));

describe('caractere nulo (U+0000)', () => {
  it('sai da mensagem, do login, da busca e do webhook de entrada, sem erro interno', async () => {
    const m = await api('POST', 'chat.sendMessage', { message: { rid: geral, msg: 'linha copiada de um log:\u0000fim' } }, user);
    expect(m.status).toBe(200);
    expect(m.message.msg).toBe('linha copiada de um log:fim');

    const login = await api('POST', 'login', { user: `${user.username}\u0000`, password: 'errada' });
    expect(login.status).toBe(401);

    for (const [path, query] of [
      ['spotlight', { query: 'a\u0000b' }],
      ['chat.search', { roomId: geral, searchText: 'a\u0000b' }],
      ['users.autocomplete', { term: 'a\u0000b' }],
    ] as const) {
      const r = await api('GET', path, query, user);
      expect(r.status, path).toBe(200);
    }

    const hook = (await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Monitor', username: 'admin', channel: '#geral' }, A)).integration;
    const res = await fetch(urlOf(`/hooks/${hook._id}/${hook.token}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'alerta: disco cheio\u0000 em srv01' }) });
    expect(res.status).toBe(200);
    const hist = await api('GET', 'channels.history', { roomId: geral }, A);
    expect(hist.messages.some((x: any) => x.msg === 'alerta: disco cheio em srv01')).toBe(true);
  });

  it('cleanInput limpa objetos e listas aninhados, no lugar', () => {
    const body = { a: 'x\u0000y', list: ['\u0000', { deep: 'k\u0000' }], n: 1, ok: true, nada: null };
    expect(cleanInput(body)).toBe(body);
    expect(body).toEqual({ a: 'xy', list: ['', { deep: 'k' }], n: 1, ok: true, nada: null });
  });
});

describe('formato da requisição (erros do Fastify) em português', () => {
  it('JSON quebrado, vazio, grande demais, sem multipart, tipo não aceito e corpo que não é objeto', async () => {
    const bad = await post('chat.sendMessage', '{"message":', user);
    expect(bad).toMatchObject({ status: 400, errorType: 'FST_ERR_CTP_INVALID_JSON_BODY', error: 'O corpo da requisição não é um JSON válido.' });
    const empty = await post('chat.sendMessage', '', user);
    expect(empty).toMatchObject({ status: 400, errorType: 'FST_ERR_CTP_EMPTY_JSON_BODY', error: 'O corpo da requisição está vazio.' });
    const big = await post('users.updateOwnBasicInfo', JSON.stringify({ data: { bio: 'x'.repeat(2.2 * 1024 * 1024) } }), user);
    expect(big).toMatchObject({ status: 413, errorType: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'O conteúdo enviado é grande demais (máx. 2 MB).' });
    const notMultipart = await post('emoji-custom.create', '{}', A);
    expect(notMultipart).toMatchObject({ status: 406, errorType: 'FST_INVALID_MULTIPART_CONTENT_TYPE', error: 'Envie o arquivo como formulário (multipart/form-data).' });
    const xml = await post('chat.sendMessage', '<a/>', user, 'application/xml');
    expect(xml).toMatchObject({ status: 415, error: 'Formato da requisição não aceito.' });
    for (const raw of ['42', '"texto"', '[1,2]']) {
      const r = await post('rooms.saveRoomSettings', raw, A);
      expect(r, raw).toMatchObject({ status: 400, errorType: 'error-invalid-params', error: 'O corpo da requisição deve ser um objeto JSON.' });
    }
    const text = await post('chat.sendMessage', 'oi', user, 'text/plain');
    expect(text).toMatchObject({ status: 400, error: 'O corpo da requisição deve ser um objeto JSON.' });
  });
});

describe('parâmetros inválidos', () => {
  it('offset enorme e datas inválidas não dão erro interno', async () => {
    for (const path of ['channels.list', 'users.list', 'directory', 'audit.log']) {
      const r = await api('GET', path, { offset: '100000000000000000000', count: '1e308' }, A);
      expect(r.status, path).toBe(200);
    }
    for (const [path, query] of [
      ['channels.history', { roomId: geral, latest: 'ontem' }],
      ['channels.history', { roomId: geral, count: 'abc' }],
      ['chat.syncMessages', { roomId: geral, lastUpdate: 'abc' }],
      ['engagement-dashboard/users', { start: 'abc' }],
      ['audit.log', { start: 'ontem' }],
    ] as const) {
      const r = await api('GET', path, query, A);
      expect(r.status, `${path} ${JSON.stringify(query)}`).toBeGreaterThanOrEqual(200);
      expect(r.status, `${path} ${JSON.stringify(query)}`).toBeLessThan(500);
    }
  });

  it('audit.log com action repetida e rooms.cleanHistory com data inválida dizem qual parâmetro', async () => {
    const res = await fetch(urlOf('/api/v1/audit.log?action=a&action=b'), { headers: { 'x-user-id': A.userId, 'x-auth-token': A.authToken } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('O parâmetro "action" deve ser texto.');
    const r = await api('POST', 'rooms.cleanHistory', { roomId: geral, latest: 'abc', oldest: '2020-01-01' }, A);
    expect(r).toMatchObject({ status: 400, error: 'O parâmetro "latest" deve ser uma data.' });
  });

  it('a rede do errorHandler: valor recusado pelo PostgreSQL ou data inválida viram 400 em português', () => {
    const run = (err: any, input: { query?: object; body?: object } = {}) => {
      const out: any = {};
      const reply: any = { status: (c: number) => ((out.status = c), reply), send: (b: any) => ((out.body = b), reply) };
      const req: any = { log: { warn() {}, error() {} }, routeOptions: {}, ...input };
      errorHandler(err, req, reply);
      return out;
    };
    const db = (code: string, message = 'x') => Object.assign(new Error(message), { code });
    expect(run(db('22021'))).toEqual({ status: 400, body: { success: false, error: 'O texto contém um caractere inválido.', errorType: 'error-invalid-params' } });
    expect(run(db('22007')).body.error).toBe('Data inválida.');
    expect(run(db('22003')).status).toBe(400);
    expect(run(db('2201X')).status).toBe(400);
    expect(run(db('42703', 'column "nan" does not exist')).status).toBe(400);
    expect(run(new RangeError('Invalid time value')).body.error).toBe('Data inválida.');
    expect(run(new TypeError('Cannot convert object to primitive value')).status).toBe(400);
    // Quando só um parâmetro pode ter trazido o valor, a mensagem diz qual.
    const ts = (v: string) => db('22007', `invalid input syntax for type timestamp with time zone: "${v}"`);
    expect(run(ts('ontem'), { query: { roomId: 'x', latest: 'ontem' } }).body.error).toBe('O parâmetro "latest" deve ser uma data.');
    expect(run(db('22P02', 'invalid input syntax for type integer: "abc"'), { body: { count: 'abc', roomId: 'x' } }).body.error).toBe('O parâmetro "count" tem um valor inválido.');
    expect(run(new RangeError('Invalid time value'), { query: { start: 'abc', end: '2024-01-01', userId: 'x' } }).body.error).toBe('O parâmetro "start" deve ser uma data.');
    expect(run(ts('x'), { query: { latest: 'x', oldest: 'x' } }).body.error).toBe('Data inválida.'); // os dois têm o valor
    // Coluna errada de verdade (erro do código) e falhas comuns continuam erro interno.
    expect(run(db('42703', 'column "nmae" does not exist')).status).toBe(500);
    expect(run(new TypeError('x is not a function')).status).toBe(500);
    // Erro desconhecido do Fastify: texto em português, errorType original.
    expect(run(Object.assign(new Error('the request is weird'), { statusCode: 400, code: 'FST_SOMETHING' })).body).toMatchObject({ error: 'Requisição inválida.', errorType: 'FST_SOMETHING' });
  });
});

describe('caracteres invisíveis e de direção', () => {
  it('mensagem só com espaços de largura zero é vazia (enviar e agendar)', async () => {
    for (const msg of ['\u200b\u200b\u200b', '\u2060\ufeff', ' \u200d ', '\u2800']) {
      const r = await api('POST', 'chat.sendMessage', { message: { rid: geral, msg } }, user);
      expect(r, JSON.stringify(msg)).toMatchObject({ status: 400, errorType: 'error-invalid-message', error: 'Mensagem vazia.' });
    }
    const s = await api('POST', 'chat.scheduleMessage', { message: { rid: geral, msg: '\u200b\u200b' }, sendAt: new Date(Date.now() + 600_000).toISOString() }, user);
    expect(s).toMatchObject({ status: 400, error: 'Mensagem vazia.' });
    expect(hasVisibleText('a\u200b')).toBe(true);
    expect(hasVisibleText('🎉')).toBe(true);
  });

  it('nome, tópico, descrição e anúncio perdem RLO e afins; o texto da mensagem fica como veio', async () => {
    const me = await api('POST', 'users.updateOwnBasicInfo', { data: { name: 'a\u202eRLO-invertido' } }, user);
    expect(me.status).toBe(200);
    expect((await api('GET', 'me', undefined, user)).name).toBe('aRLO-invertido');
    // A mensagem de status do menu do usuário (users.setStatus) também.
    await api('POST', 'users.setStatus', { message: 'em reunião ‮até 15h' }, user);
    expect((await api('GET', 'users.getStatus', undefined, user)).message).toBe('em reunião até 15h');

    const room = (await api('POST', 'channels.create', { name: `bidi-${Date.now().toString(36)}` }, A)).channel._id;
    await api('POST', 'channels.setTopic', { roomId: room, topic: '\u202e tópico invertido' }, A);
    await api('POST', 'rooms.saveRoomSettings', { rid: room, roomDescription: 'des\u2066cri\u2069ção', roomAnnouncement: '\u202daviso' }, A);
    const info = (await api('GET', 'rooms.info', { roomId: room }, A)).room;
    expect(info.topic).toBe(' tópico invertido');
    expect(info.description).toBe('descrição');
    expect(info.announcement).toBe('aviso');

    const m = await api('POST', 'chat.sendMessage', { message: { rid: room, msg: 'exemplo: \u202efdp.exe' } }, A);
    expect(m.message.msg).toBe('exemplo: \u202efdp.exe');
  });
});

describe('iniciais do avatar', () => {
  const text = (name: string) => initialsSvg(name).match(/<text[^>]*>([^<]*)<\/text>/)![1];
  it('emoji no começo do nome não vira meio caractere', () => {
    expect(text('🦊 Raposa Feliz 🎉')).toBe('RF');
    expect(text('Ana Souza')).toBe('AS');
    expect(text('qa.visual')).toBe('QV');
    expect(text('admin')).toBe('AD');
    expect(text('🦊')).toBe('🦊');
    expect(text('')).toBe('?');
  });
});
