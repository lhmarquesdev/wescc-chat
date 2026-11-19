import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, login, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// "Gerenciar as próprias integrações" (manage-own-integrations, sem manage-integrations): o webhook publica só como a
// própria pessoa e se liga só a salas que ela já lê. Antes, um webhook próprio recebia as DMs e os grupos privados de
// todo mundo e publicava como o administrador (admsys-1, admsys-3).
let A: Auth;
let bruno: Auth;
let alice: Auth;
let carla: Auth;
let hook: http.Server;
let hookUrl = '';
const received: any[] = [];
let grupoId = '';
let dmId = '';
let geralId = '';

const hookPost = (i: any, body: unknown) =>
  fetch(urlOf(`/hooks/${i._id}/${i.token}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lastMsg = async (rid: string) => (await pool.query('SELECT msg, user_id FROM messages WHERE room_id = $1 AND t IS NULL ORDER BY created_at DESC LIMIT 1', [rid])).rows[0];

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  const role = await api('POST', 'rbac.roles.create', { name: 'integrador', description: 'Só as próprias integrações', scope: 'Users', permissions: ['manage-own-integrations'] }, A);
  if (!role.success) throw new Error(JSON.stringify(role));
  const b = await newUser(A);
  const set = await api('POST', 'rbac.users.setRoles', { userId: b.userId, roles: ['user', role.role._id ?? 'integrador'] }, A);
  if (!set.success) throw new Error(JSON.stringify(set));
  bruno = await login(b.username, 'senha-forte-1');
  alice = await newUser(A);
  carla = await newUser(A);
  const g = await api('POST', 'groups.create', { name: 'segredos', members: [alice.username] }, A);
  grupoId = g.group._id;
  const dm = await api('POST', 'im.create', { username: 'admin' }, alice);
  dmId = dm.room._id ?? dm.room.rid;
  geralId = (await api('GET', 'channels.info', { roomName: 'geral' }, A)).channel._id;
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, ...JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}`;
});
afterAll(async () => {
  hook.close();
  await stopServer();
});

describe('integrações próprias (manage-own-integrations)', () => {
  it('recusa publicar como outra pessoa, salas que a pessoa não lê, resposta como o autor e scripts', async () => {
    const base = { type: 'webhook-outgoing', name: 'espiao', username: bruno.username, event: 'sendMessage', urls: [`${hookUrl}/x`] };
    const asAdmin = await api('POST', 'integrations.create', { ...base, username: 'admin' }, bruno);
    expect(asAdmin.status).toBe(400);
    expect(asAdmin.error).toContain(`@${bruno.username}`);
    for (const channel of ['all_direct_messages', 'all_private_groups', '#segredos', grupoId, dmId]) {
      const r = await api('POST', 'integrations.create', { ...base, channel }, bruno);
      expect(r.status, channel).toBe(400);
      expect(r.errorType, channel).toBe('error-invalid-channel');
    }
    expect((await api('POST', 'integrations.create', { ...base, channel: '#geral', targetRoom: '#segredos' }, bruno)).errorType).toBe('error-invalid-channel');
    expect((await api('POST', 'integrations.create', { ...base, channel: '#geral', impersonateUser: true }, bruno)).status).toBe(400);
    expect((await api('POST', 'integrations.create', { ...base, channel: '#geral', scriptEnabled: true, script: 'class Script {}' }, bruno)).status).toBe(400);
    const incoming = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'x', username: 'admin', channel: '#geral' }, bruno);
    expect(incoming.status).toBe(400);
    // Sem nome de usuário, publica como a própria pessoa; #geral e as próprias DMs valem.
    const ok = await api('POST', 'integrations.create', { ...base, username: '', channel: ['#geral', 'all_public_channels', `@${alice.username}`] }, bruno);
    expect(ok.success).toBe(true);
    expect(ok.integration.username).toBe(bruno.username);
    await api('POST', 'integrations.remove', { type: 'webhook-outgoing', integrationId: ok.integration._id }, bruno);
  });

  it('webhook de saída só recebe o que quem o criou pode ler, mesmo de uma integração antiga', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'tudo que leio', username: bruno.username, event: 'sendMessage', urls: [`${hookUrl}/own`] }, bruno);
    expect(r.success).toBe(true);
    // Integração antiga, gravada antes da regra: todas as DMs e grupos privados.
    const legacy = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'antiga', username: bruno.username, event: 'sendMessage', channel: '#geral', urls: [`${hookUrl}/legacy`] }, bruno);
    await pool.query(`UPDATE integrations SET channels = '{all_direct_messages,all_private_groups,all_public_channels}' WHERE id = $1`, [legacy.integration._id]);
    await api('POST', 'chat.sendMessage', { message: { rid: dmId, msg: 'SEGREDO-DM' } }, alice);
    await api('POST', 'chat.sendMessage', { message: { rid: grupoId, msg: 'SEGREDO-GRUPO' } }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: geralId, msg: 'aviso no geral' } }, alice);
    for (let i = 0; i < 60 && received.filter((x) => x.text === 'aviso no geral').length < 2; i++) await sleep(50);
    await sleep(200);
    expect(received.filter((x) => x.text === 'aviso no geral').map((x) => x.url).sort()).toEqual(['/legacy', '/own']);
    expect(received.some((x) => String(x.text).startsWith('SEGREDO'))).toBe(false);
    // O administrador continua podendo observar todas as DMs.
    const all = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'auditoria', username: 'admin', event: 'sendMessage', channel: 'all_direct_messages', urls: [`${hookUrl}/admin`] }, A);
    expect(all.success).toBe(true);
    await api('POST', 'chat.sendMessage', { message: { rid: dmId, msg: 'dm para o admin' } }, alice);
    for (let i = 0; i < 60 && !received.some((x) => x.text === 'dm para o admin'); i++) await sleep(50);
    expect(received.filter((x) => x.text === 'dm para o admin').map((x) => x.url)).toEqual(['/admin']);
    for (const id of [r.integration._id, legacy.integration._id, all.integration._id]) await api('POST', 'integrations.remove', { type: 'webhook-outgoing', integrationId: id }, A);
    // "Usuário criado": sem o e-mail para quem não vê os dados completos das pessoas.
    const created = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'novatos', username: bruno.username, event: 'userCreated', urls: [`${hookUrl}/novos`] }, bruno);
    expect(created.success).toBe(true);
    const novo = await newUser(A);
    for (let i = 0; i < 60 && !received.some((x) => x.url === '/novos'); i++) await sleep(50);
    const got = received.find((x) => x.url === '/novos');
    expect(got.user_name).toBe(novo.username);
    expect(got.email).toBeUndefined();
  });

  it('webhook de entrada publica só como quem o criou e só nos canais configurados', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'meu', username: bruno.username, channel: '#geral' }, bruno);
    expect(r.success).toBe(true);
    expect((await hookPost(r.integration, { text: 'do meu sistema' })).status).toBe(200);
    expect(await lastMsg(geralId)).toMatchObject({ msg: 'do meu sistema', user_id: bruno.userId });
    expect((await hookPost(r.integration, { text: 'no geral de novo', channel: '#geral' })).status).toBe(200);
    for (const over of [{ channel: '#segredos' }, { roomId: dmId }, { roomId: grupoId }, { channel: `@${carla.username}` }]) {
      const res = await hookPost(r.integration, { text: 'fora', ...over });
      expect(res.status, JSON.stringify(over)).toBe(403);
    }
    expect((await pool.query(`SELECT 1 FROM messages WHERE msg = 'fora'`)).rowCount).toBe(0);
    // Integração antiga que publicava como o administrador: bloqueada até alguém revisar.
    await pool.query(`UPDATE integrations SET user_id = $2, username = 'admin' WHERE id = $1`, [r.integration._id, A.userId]);
    expect((await hookPost(r.integration, { text: 'como admin' })).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM messages WHERE msg = 'como admin'`)).rowCount).toBe(0);
    await api('POST', 'integrations.remove', { type: 'webhook-incoming', integrationId: r.integration._id }, A);
  });

  it('o administrador continua publicando como outro usuário e mudando o canal pelo payload', async () => {
    const r = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'admin hook', username: 'admin', channel: '#geral' }, A);
    expect(r.success).toBe(true);
    expect((await hookPost(r.integration, { text: 'no grupo pelo payload', channel: '#segredos' })).status).toBe(200);
    expect(await lastMsg(grupoId)).toMatchObject({ msg: 'no grupo pelo payload', user_id: A.userId });
  });
});
