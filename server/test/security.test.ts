import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { totpCode } from '../src/lib/totp';
import { admin, api, enable2fa, login, newUser, raw, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  // Admin com 2FA próprio, para poder ligar o 2FA obrigatório sem se bloquear.
  await enable2fa(A);
  const s = await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  expect(s.success).toBe(true);
});
afterAll(() => stopServer());

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Abre o WebSocket e diz se a sessão foi aceita ("connected") ou com que código a conexão fechou.
function wsOutcome(opts: { token?: string; cookie?: string; origin?: string }, ms = 1500) {
  return new Promise<{ connected?: boolean; closeCode?: number }>((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    const ws = new WebSocket(urlOf('/websocket').replace('http', 'ws'), { headers });
    const t = setTimeout(() => (ws.close(), resolve({ connected: false })), ms);
    ws.on('open', () => opts.token && ws.send(JSON.stringify({ type: 'auth', token: opts.token })));
    ws.on('message', (d) => {
      if (JSON.parse(String(d)).type !== 'connected') return;
      clearTimeout(t);
      ws.close();
      resolve({ connected: true });
    });
    ws.on('close', (code) => (clearTimeout(t), resolve({ closeCode: code })));
  });
}

describe('2FA e troca de senha cobrados no servidor', () => {
  it('gerar uma chave nova não desliga o 2FA ativo sem código', async () => {
    const u = await newUser(A);
    const secret = await enable2fa(u);
    const r = await api('POST', 'users.2fa.enableTotp', {}, u);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('totp-already-enabled');
    const row = (await pool.query('SELECT totp_enabled, totp_secret FROM users WHERE id = $1', [u.userId])).rows[0];
    expect(row.totp_enabled).toBe(true);
    expect(row.totp_secret).toBe(secret);
  });

  it('com 2FA obrigatório a API e o WebSocket só liberam a configuração do 2FA', async () => {
    const u = await newUser(A);
    await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: true } }, A);
    try {
      const blocked = await api('GET', 'subscriptions.get', undefined, u);
      expect(blocked.status).toBe(403);
      expect(blocked.errorType).toBe('error-2fa-setup-required');
      expect((await api('POST', 'chat.sendMessage', { message: { rid: 'GENERAL', msg: 'oi' } }, u)).errorType).toBe('error-2fa-setup-required');
      expect((await api('GET', 'me', undefined, u)).require2faSetup).toBe(true);
      expect((await wsOutcome({ token: u.authToken })).closeCode).toBe(4005);
      // Arquivos e avatares também não reconhecem a sessão.
      expect((await raw('/file-upload/qualquer/x.png', u)).status).not.toBe(200);

      await enable2fa(u);
      expect((await api('GET', 'subscriptions.get', undefined, u)).success).toBe(true);
      expect((await wsOutcome({ token: u.authToken })).connected).toBe(true);
    } finally {
      await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: false } }, A);
    }
  });

  it('com troca de senha obrigatória só a senha pode mudar', async () => {
    const created = await api('POST', 'users.create', { username: 'trocar.senha', name: 'Trocar', email: 'trocar@test.local', password: 'senha-provisoria-1', requirePasswordChange: true }, A);
    expect(created.success).toBe(true);
    const u = await login('trocar.senha', 'senha-provisoria-1');
    expect((await api('GET', 'subscriptions.get', undefined, u)).errorType).toBe('error-password-change-required');
    const ch = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: 'senha-nova-123', username: 'outro.nome', name: 'Outro' } }, u);
    expect(ch.success).toBe(true);
    const row = (await pool.query('SELECT username, name, require_password_change FROM users WHERE id = $1', [u.userId])).rows[0];
    expect(row).toMatchObject({ username: 'trocar.senha', name: 'Trocar', require_password_change: false });
    expect((await api('GET', 'subscriptions.get', undefined, u)).success).toBe(true);
  });
});

describe('bloqueio de tentativas de login', () => {
  it('bloqueia a conta mesmo trocando de IP, e código 2FA errado conta como falha', async () => {
    await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 3 } }, A);
    try {
      const u = await newUser(A);
      const attempt = (password: string, ip: string, extra: Record<string, unknown> = {}) =>
        fetch(urlOf('/api/v1/login'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ user: u.username, password, ...extra }) });
      for (let i = 0; i < 3; i++) expect((await attempt('errada', `10.0.0.${i + 1}`)).status).toBe(401);
      expect((await attempt('senha-forte-1', '10.0.0.9')).status).toBe(429);
      // O e-mail é a mesma conta.
      const byEmail = await fetch(urlOf('/api/v1/login'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.10' }, body: JSON.stringify({ user: `${u.username}@test.local`, password: 'senha-forte-1' }) });
      expect(byEmail.status).toBe(429);

      await pool.query('DELETE FROM login_attempts');
      const secret = await enable2fa(await login(u.username, 'senha-forte-1'));
      for (let i = 0; i < 3; i++) expect((await attempt('senha-forte-1', '10.0.1.1', { code: '000000' })).status).toBe(401);
      expect((await attempt('senha-forte-1', '10.0.1.1', { code: totpCode(secret) })).status).toBe(429);
    } finally {
      await pool.query('DELETE FROM login_attempts');
      await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 10 } }, A);
    }
  });
});

describe('origens e cookies', () => {
  it('CORS só responde para a URL do site ou origens liberadas', async () => {
    const evil = await fetch(urlOf('/api/v1/info'), { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const site = urlOf('').replace(/\/$/, '');
    await api('POST', 'settings', { settings: { Site_Url: site } }, A);
    const own = await fetch(urlOf('/api/v1/info'), { headers: { origin: site } });
    expect(own.headers.get('access-control-allow-origin')).toBe(site);
    expect(own.headers.get('access-control-allow-credentials')).toBeNull();
    await api('POST', 'settings', { settings: { API_Enable_CORS: true, API_CORS_Origin: 'https://intranet.example' } }, A);
    const listed = await fetch(urlOf('/api/v1/info'), { headers: { origin: 'https://intranet.example' } });
    expect(listed.headers.get('access-control-allow-origin')).toBe('https://intranet.example');
    await api('POST', 'settings', { settings: { API_Enable_CORS: false } }, A);
  });

  it('o cookie de sessão não autentica ações (POST) nem WebSocket de outro site', async () => {
    const u = await newUser(A);
    const cookie = `rc_uid=${u.userId}; rc_token=${u.authToken}`;
    const post = await fetch(urlOf('/api/v1/users.setStatus'), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'busy' }) });
    expect(post.status).toBe(401);
    // Leitura com cookie continua valendo (imagens e downloads).
    expect((await raw('/api/v1/me', u)).status).toBe(200);
    expect((await wsOutcome({ cookie, origin: 'https://evil.example' })).connected).toBe(false);
    expect((await wsOutcome({ cookie, origin: urlOf('').replace(/\/$/, '') })).connected).toBe(true);
  });

  it('avatares e avatares de salas privadas não aparecem para quem não pode ver', async () => {
    const u = await newUser(A);
    expect((await api('POST', 'users.setAvatar', { avatarUrl: PNG }, u)).success).toBe(true);
    const anon = await fetch(urlOf(`/avatar/${u.username}`));
    expect(anon.headers.get('content-type')).toContain('image/svg+xml');
    expect((await raw(`/avatar/${u.username}`, A)).headers.get('content-type')).toContain('image/png');

    const g = await api('POST', 'groups.create', { name: 'diretoria-secreta' }, A);
    const outsider = await newUser(A);
    const svg = await (await raw(`/avatar/room/${g.group._id}`, outsider)).text();
    expect(svg).not.toContain('DS');
    expect(await (await raw(`/avatar/room/${g.group._id}`, A)).text()).toContain('DS');
  });
});

describe('mensagens e salas', () => {
  it('citação é montada no servidor e não pode ser inventada', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'citacoes', members: [u.username] }, A);
    const rid = ch.channel._id;
    const original = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'texto verdadeiro' } }, A);
    const forged = await api(
      'POST',
      'chat.sendMessage',
      { message: { rid, msg: 'veja', attachments: [{ text: 'texto inventado', author_name: 'admin', message_link: `?msg=${original.message._id}` }] } },
      u,
    );
    expect(forged.message.attachments).toEqual([expect.objectContaining({ text: 'texto verdadeiro', author_name: 'admin', message_link: `?msg=${original.message._id}` })]);

    // Mensagem de sala sem acesso: a citação é descartada.
    const g = await api('POST', 'groups.create', { name: 'sem-acesso' }, A);
    const hidden = await api('POST', 'chat.sendMessage', { message: { rid: g.group._id, msg: 'segredo' } }, A);
    const leak = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'tentativa', attachments: [{ message_link: `/msg/${hidden.message._id}` }] } }, u);
    expect(leak.message.attachments).toEqual([]);
    const fake = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'link', attachments: [{ title: 'x', title_link: 'javascript:alert(1)', image_url: '//evil.example/a.png' }] } }, u);
    expect(fake.message.attachments).toEqual([{ title: 'x' }]);
  });

  it('lista de membros de sala de transmissão exige permissão', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'avisos-gerais', members: [u.username], extraData: { broadcast: true } }, A);
    const r = await api('GET', 'rooms.membersOrderedByRole', { roomId: ch.channel._id }, u);
    expect(r.status).toBe(403);
    const own = await api('GET', 'rooms.membersOrderedByRole', { roomId: ch.channel._id }, A);
    expect(own.members[0].username).toBe('admin'); // dono primeiro
  });

  it('convidado não abre canal público em que não foi adicionado', async () => {
    const ch = await api('POST', 'channels.create', { name: 'aberto-a-todos' }, A);
    const guest = await newUser(A, { roles: ['guest'] });
    expect((await api('GET', 'channels.info', { roomId: ch.channel._id }, guest)).status).toBe(403);
    const user = await newUser(A);
    expect((await api('GET', 'channels.info', { roomId: ch.channel._id }, user)).success).toBe(true);
  });
});

describe('LDAP', () => {
  it('não assume conta local com o mesmo nome sem a opção de vínculo, nem conta de outra pessoa do LDAP', async () => {
    const { upsertFromEntry } = await import('../src/ldap/ldap');
    const entry = (user: string, guid: string) => ({ dn: `cn=${user},dc=empresa`, sAMAccountName: user, cn: user, objectGUID: guid }) as any;
    await expect(upsertFromEntry(entry('admin', 'g-admin'), [])).rejects.toMatchObject({ errorType: 'error-ldap-username-taken' });
    expect((await pool.query(`SELECT auth_source FROM users WHERE username = 'admin'`)).rows[0].auth_source).toBe('local');

    const local = await newUser(A);
    await api('POST', 'settings', { settings: { LDAP_Merge_Existing_Users: true } }, A);
    try {
      const merged = await upsertFromEntry(entry(local.username, 'g-1'), []);
      expect(merged).toMatchObject({ id: local.userId, auth_source: 'ldap', external_id: 'g-1' });
      // Outra pessoa do diretório com o mesmo nome (outro identificador) não herda a conta.
      await expect(upsertFromEntry(entry(local.username, 'g-2'), [])).rejects.toMatchObject({ errorType: 'error-ldap-username-taken' });
    } finally {
      await api('POST', 'settings', { settings: { LDAP_Merge_Existing_Users: false } }, A);
    }
  });
});

describe('auditoria', () => {
  it('não grava segredos de configurações', async () => {
    await api('POST', 'settings', { settings: { Livechat_External_Queue_Token: 'token-super-secreto' } }, A);
    await sleep(50);
    const log = await api('GET', 'audit.settings', {}, A);
    expect(JSON.stringify(log)).not.toContain('token-super-secreto');
    expect(JSON.stringify(log)).toContain('Livechat_External_Queue_Token');
  });
});
