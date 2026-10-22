import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import net from 'node:net';
import { internalAddress } from '../src/oauth/login';
import { safeRedirect } from '../src/services/sso';
import { admin, api, enable2fa, login as passwordLogin, newUser, startServer, stopServer, urlOf, type Auth } from './helpers';

// Servidor OAuth 2.0 / OIDC de mentira: /authorize emite o código, /token confere PKCE e cliente,
// /userinfo e /user devolvem o perfil, /user/emails imita o GitHub.
const CLIENT_ID = 'chat-client';
const SECRET = 'segredo-super-secreto-123';

const mock = {
  base: '',
  server: null as http.Server | null,
  nextUser: {} as Record<string, any>,
  emails: [] as any[],
  tokenFormat: 'json' as 'json' | 'form',
  idToken: false,
  idTokenAud: CLIENT_ID,
  wrap: '',
  codes: new Map<string, { challenge: string; method: string; redirectUri: string; user: any }>(),
  tokens: new Map<string, any>(),
  issued: [] as string[],
  last: { verifier: '', challenge: '', pkceOk: false, auth: '', tokenVia: '', scope: '', avatarAuth: false },
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function b64url(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function startMock() {
  mock.server = http.createServer((req, res) => {
    const u = new URL(req.url!, mock.base || 'http://127.0.0.1');
    const path = u.pathname;
    if (path.endsWith('/authorize')) {
      const q = u.searchParams;
      if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code') return send(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(12).toString('hex');
      mock.issued.push(code);
      mock.last.scope = q.get('scope') ?? '';
      mock.codes.set(code, { challenge: q.get('code_challenge') ?? '', method: q.get('code_challenge_method') ?? '', redirectUri: q.get('redirect_uri')!, user: mock.nextUser });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && (path.endsWith('/token') || path.endsWith('/access_token'))) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : null;
        mock.last.auth = basic ? 'basic' : 'post';
        const [cid, secret] = basic ?? [f.get('client_id'), f.get('client_secret')];
        if (cid !== CLIENT_ID || secret !== SECRET) return send(res, 401, { error: 'invalid_client' });
        const entry = mock.codes.get(f.get('code') ?? '');
        mock.codes.delete(f.get('code') ?? '');
        if (!entry || f.get('grant_type') !== 'authorization_code' || f.get('redirect_uri') !== entry.redirectUri) return send(res, 400, { error: 'invalid_grant' });
        const verifier = f.get('code_verifier') ?? '';
        mock.last.verifier = verifier;
        mock.last.challenge = entry.challenge;
        mock.last.pkceOk = entry.method === 'S256' && crypto.createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
        if (!mock.last.pkceOk) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        const token = crypto.randomBytes(16).toString('hex');
        mock.issued.push(token);
        mock.tokens.set(token, entry.user);
        const out: Record<string, string> = { access_token: token, token_type: 'bearer' };
        if (mock.idToken) out.id_token = `${b64url({ alg: 'none' })}.${b64url({ iss: mock.base, aud: mock.idTokenAud, exp: Math.floor(Date.now() / 1000) + 300, ...entry.user })}.`;
        if (mock.tokenFormat === 'form') return send(res, 200, new URLSearchParams(out).toString(), 'application/x-www-form-urlencoded');
        return send(res, 200, out);
      });
      return;
    }
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = bearer ?? u.searchParams.get('token') ?? u.searchParams.get('access_token');
    mock.last.tokenVia = bearer ? 'header' : token ? 'query' : '';
    const user = token ? mock.tokens.get(token) : null;
    if (path.endsWith('/redir')) {
      res.writeHead(302, { location: u.searchParams.get('to')! });
      return res.end();
    }
    if (path.endsWith('/avatar.png')) {
      mock.last.avatarAuth = !!user;
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (path.endsWith('/user/emails')) return user ? send(res, 200, mock.emails) : send(res, 401, { message: 'Bad credentials' });
    if (path.endsWith('/userinfo') || path.endsWith('/user')) {
      if (!user) return send(res, 401, { error: 'invalid_token' });
      return send(res, 200, mock.wrap ? { data: { [mock.wrap]: user } } : user);
    }
    send(res, 404, { error: 'not_found' });
  });
  return new Promise<void>((resolve) =>
    mock.server!.listen(0, '127.0.0.1', () => {
      mock.base = `http://127.0.0.1:${(mock.server!.address() as any).port}`;
      resolve();
    }),
  );
}

let A: Auth;
let site = '';

const provider = (extra: Record<string, unknown> = {}) => ({
  type: 'custom',
  enabled: true,
  label: 'Entrar com Mock',
  buttonColor: '#123456',
  buttonTextColor: '#ffffff',
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  authorizeUrl: `${mock.base}/authorize`,
  tokenUrl: `${mock.base}/token`,
  identityUrl: `${mock.base}/userinfo`,
  scope: 'openid profile email',
  ...extra,
});

const update = (id: string, body: Record<string, unknown>) => api('PUT', `oauth-providers/${id}`, body, A);

async function startFlow(pid: string, redirect = '/channel/geral') {
  const r = await fetch(urlOf(`/oauth/${pid}/login?redirect=${encodeURIComponent(redirect)}`), { redirect: 'manual' });
  expect(r.status).toBe(302);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const loc = new URL(r.headers.get('location')!);
  return { loc, cookie, state: loc.searchParams.get('state')! };
}

async function authorize(loc: URL) {
  const r = await fetch(loc, { redirect: 'manual' });
  expect(r.status).toBe(302);
  return r.headers.get('location')!;
}

const callback = (url: string, cookie?: string) => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function flow(pid: string, user: Record<string, any>, redirect = '/channel/geral') {
  mock.nextUser = user;
  const f = await startFlow(pid, redirect);
  const cb = await authorize(f.loc);
  const res = await callback(cb, f.cookie);
  return { ...f, cb, res };
}

// Troca a credencial em POST /login, com o cookie que o callback entregou ao navegador (ou outro, ou nenhum).
async function redeem(credentialToken: string, cookie?: string, method = 'oauth') {
  const r = await fetch(urlOf('/api/v1/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ [method]: true, credentialToken }),
  });
  return { status: r.status, setCookie: r.headers.get('set-cookie') ?? '', ...((await r.json()) as any) };
}

const ssoCookie = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith('wescc_sso=')) ?? '').split(';')[0];

async function exchange(res: Response) {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!, 'http://x');
  expect(loc.pathname).toBe('/login');
  const cookie = ssoCookie(res);
  const login = await redeem(loc.searchParams.get('oauth')!, cookie);
  return { login, next: loc.searchParams.get('next'), credential: loc.searchParams.get('oauth')!, cookie };
}

async function loginAs(pid: string, user: Record<string, any>, redirect?: string) {
  const { res } = await flow(pid, user, redirect);
  const { login, next } = await exchange(res);
  expect(login.status).toBe('success');
  return { me: login.data.me, userId: login.data.userId as string, next };
}

const dbUser = async (id: string) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  await startMock();
  await startServer();
  A = await admin();
  site = urlOf('').replace(/\/$/, '');
  const s = await api('POST', 'settings', { settings: { Site_Url: site, API_Enable_Rate_Limiter: false } }, A);
  expect(s.success).toBe(true);
  const r = await api('POST', 'oauth-providers', { _id: 'mock', ...provider() }, A);
  expect(r.success).toBe(true);
});
afterAll(async () => {
  await stopServer();
  mock.server?.close();
});
beforeEach(() => {
  mock.tokenFormat = 'json';
  mock.idToken = false;
  mock.idTokenAud = CLIENT_ID;
  mock.wrap = '';
  mock.emails = [];
});

describe('OAuth: administração', () => {
  it('cria, lista e atualiza sem nunca devolver o client secret', async () => {
    const created = await api('POST', 'oauth-providers', { _id: 'acme', ...provider({ enabled: false, label: 'ACME' }) }, A);
    expect(created.provider.clientSecretSet).toBe(true);
    expect(created.provider.callbackUrl).toBe(`${site}/oauth/acme/callback`);
    const responses = [
      created,
      await api('GET', 'oauth-providers', undefined, A),
      await api('GET', 'oauth-providers/acme', undefined, A),
      await update('acme', { label: 'ACME Corp' }),
      await api('GET', 'oauth-providers.public'),
      await api('GET', 'oauth-providers.presets', undefined, A),
    ];
    for (const r of responses) {
      expect(r.success).toBe(true);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    // Atualizar sem informar o segredo mantém o atual.
    expect((await pool.query(`SELECT client_secret FROM oauth_providers WHERE id = 'acme'`)).rows[0].client_secret).toBe(SECRET);
    const cleared = await update('acme', { clientSecret: null });
    expect(cleared.provider.clientSecretSet).toBe(false);
    // Texto e cores apagados voltam ao padrão do tipo (o botão nunca fica vazio).
    const blank = await update('acme', { label: '', buttonColor: '', buttonTextColor: '' });
    expect(blank.provider.label).toBe('Entrar com SSO');
    expect(blank.provider.buttonColor).toBe('#1d74f5');
    expect(blank.provider.buttonTextColor).toBe('#ffffff');

    const audit = await pool.query(`SELECT target::text || data::text AS t FROM audit_log WHERE action LIKE 'oauth.provider.%'`);
    expect(audit.rowCount).toBeGreaterThanOrEqual(3);
    for (const row of audit.rows) expect(row.t).not.toContain(SECRET);

    expect((await api('DELETE', 'oauth-providers/acme', undefined, A)).success).toBe(true);
    expect((await api('GET', 'oauth-providers/acme', undefined, A)).status).toBe(404);
  });

  it('lista pública só tem provedores ativos, com id, texto e cores', async () => {
    await api('POST', 'oauth-providers', { _id: 'desligado', ...provider({ enabled: false }) }, A);
    const r = await api('GET', 'oauth-providers.public');
    const ids = r.providers.map((p: any) => p._id);
    expect(ids).toContain('mock');
    expect(ids).not.toContain('desligado');
    for (const p of r.providers) expect(Object.keys(p).sort()).toEqual(['_id', 'buttonColor', 'buttonTextColor', 'label']);
  });

  it('exige manage-oauth-apps e valida os dados', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'oauth-providers', undefined, u)).status).toBe(403);
    expect((await api('POST', 'oauth-providers', { _id: 'x', ...provider() }, u)).status).toBe(403);
    expect((await api('GET', 'oauth-providers.presets', undefined, u)).status).toBe(403);
    const bad = [
      { _id: 'Inválido!', ...provider() },
      { _id: 'mock', ...provider() },
      { _id: 'sem-cliente', ...provider({ clientId: '' }) },
      { _id: 'sem-token', ...provider({ tokenUrl: '' }) },
      { _id: 'url-ruim', ...provider({ authorizeUrl: 'javascript:alert(1)' }) },
      { _id: 'cor-ruim', ...provider({ buttonColor: 'red;background:url(x)' }) },
      { _id: 'mapa-ruim', ...provider({ roleMapping: '{"a": 1}' }) },
    ];
    for (const body of bad) expect((await api('POST', 'oauth-providers', body, A)).status).toBe(400);
    const presets = await api('GET', 'oauth-providers.presets', undefined, A);
    expect(presets.presets.map((p: any) => p.type)).toEqual(['google', 'github', 'gitlab', 'microsoft', 'custom']);
  });
});

describe('OAuth: fluxo de login', () => {
  it('login completo com PKCE: cria o usuário e troca a credencial por uma sessão', async () => {
    const { loc, res } = await flow('mock', { sub: 'u-100', preferred_username: 'joana.silva', email: 'Joana@Empresa.com', email_verified: true, name: 'Joana Silva' });
    expect(loc.origin).toBe(mock.base);
    expect(loc.searchParams.get('redirect_uri')).toBe(`${site}/oauth/mock/callback`);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toBe('openid profile email');
    // O verificador que chegou ao endpoint de token corresponde ao desafio enviado na autorização.
    expect(mock.last.pkceOk).toBe(true);
    expect(crypto.createHash('sha256').update(mock.last.verifier).digest('base64url')).toBe(loc.searchParams.get('code_challenge'));
    expect(mock.last.verifier.length).toBeGreaterThanOrEqual(43);

    const sso = res.headers.getSetCookie().find((c) => c.startsWith('wescc_sso='))!;
    expect(sso).toContain('Path=/api/v1/login');
    expect(sso).toContain('HttpOnly');
    expect(sso).toContain('SameSite=Lax');
    const { login, next, credential, cookie } = await exchange(res);
    expect(login.setCookie).toContain('wescc_sso=;');
    expect(next).toBe('/channel/geral');
    expect(login.data.me.username).toBe('joana.silva');
    expect(login.data.me.name).toBe('Joana Silva');
    expect(login.data.me.email).toBe('joana@empresa.com');
    expect(login.data.me.roles).toEqual(['user']);
    expect(login.data.me.authSource).toBe('oauth');
    const row = await dbUser(login.data.userId);
    expect(row.auth_source).toBe('oauth');
    expect(row.external_id).toBe('mock:u-100');
    expect(row.email_verified).toBe(true);

    // Credencial de uso único.
    expect((await redeem(credential, cookie)).success).toBe(false);
    // Nem serve como credencial SAML.
    expect((await redeem(credential, cookie, 'saml')).success).toBe(false);

    // Segundo login cai na mesma conta.
    const again = await loginAs('mock', { sub: 'u-100', preferred_username: 'outro-nome', email: 'joana@empresa.com', email_verified: true, name: 'Joana S.' });
    expect(again.userId).toBe(login.data.userId);
    expect(again.me.username).toBe('joana.silva');
    expect(again.me.name).toBe('Joana S.');
  });

  it('state vale uma vez, só para o provedor e o navegador que o criaram', async () => {
    mock.nextUser = { sub: 'u-200', preferred_username: 'state.user' };
    const f = await startFlow('mock');
    const cb = await authorize(f.loc);
    expect((await callback(cb, f.cookie)).status).toBe(302);
    const reused = await callback(cb, f.cookie);
    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain('expirou ou já foi usado');

    expect((await callback(urlOf('/oauth/mock/callback?code=abc&state=nao-existe'), f.cookie)).status).toBe(400);
    expect((await callback(urlOf('/oauth/mock/callback?code=abc'), f.cookie)).status).toBe(400);

    const expired = await startFlow('mock');
    const cbExpired = await authorize(expired.loc);
    await pool.query(`UPDATE oauth_states SET expires_at = now() - interval '1 minute'`);
    expect((await callback(cbExpired, expired.cookie)).status).toBe(400);

    await api('POST', 'oauth-providers', { _id: 'mock2', ...provider() }, A);
    const other = await startFlow('mock');
    const cbOther = (await authorize(other.loc)).replace('/oauth/mock/', '/oauth/mock2/');
    expect((await callback(cbOther, other.cookie)).status).toBe(400);

    const noCookie = await startFlow('mock');
    const cbNoCookie = await authorize(noCookie.loc);
    expect((await callback(cbNoCookie)).status).toBe(400);
    const wrongCookie = await startFlow('mock');
    const cbWrong = await authorize(wrongCookie.loc);
    const r = await callback(cbWrong, 'wescc_oauth=' + 'x'.repeat(32));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('outro navegador');
  });

  it('a credencial da URL só vale no navegador que concluiu o login (contra CSRF de login)', async () => {
    // Quem roda o fluxo da própria conta e repassa /login?oauth=... não loga a vítima: falta o cookie.
    const attacker = await flow('mock', { sub: 'csrf-1', preferred_username: 'atacante' });
    const token = new URL(attacker.res.headers.get('location')!, 'http://x').searchParams.get('oauth')!;
    const victim = await redeem(token);
    expect(victim.status).toBe(401);
    expect(victim.success).toBe(false);
    // Uso único: depois da tentativa, nem o cookie certo vale.
    expect((await redeem(token, ssoCookie(attacker.res))).success).toBe(false);

    const other = await flow('mock', { sub: 'csrf-1' });
    const t2 = new URL(other.res.headers.get('location')!, 'http://x').searchParams.get('oauth')!;
    expect((await redeem(t2, 'wescc_sso=' + 'x'.repeat(32))).success).toBe(false);
    const ok = await flow('mock', { sub: 'csrf-1' });
    expect((await exchange(ok.res)).login.status).toBe('success');
  });

  it('erro do provedor aparece escapado e nada sensível vai para a auditoria', async () => {
    const f = await startFlow('mock');
    const r = await callback(urlOf(`/oauth/mock/callback?state=${f.state}&error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`), f.cookie);
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&#60;script&#62;');

    const rows = await pool.query(`SELECT action || target::text || data::text AS t FROM audit_log WHERE action LIKE 'auth.%'`);
    const all = rows.rows.map((x) => x.t).join('\n');
    expect(all).toContain('auth.oauth');
    for (const s of [...mock.issued, SECRET]) expect(all).not.toContain(s);
    const failed = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.oauth.failed'`);
    expect(failed.rows[0].n).toBeGreaterThan(0);
  });

  it('só redireciona para caminhos internos', async () => {
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', '']) {
      expect(safeRedirect(bad)).toBe('/home');
    }
    expect(safeRedirect('/group/time?x=1#m')).toBe('/group/time?x=1#m');
    const evil = await loginAs('mock', { sub: 'u-300', preferred_username: 'redir' }, 'https://evil.example/');
    expect(evil.next).toBe('/home');
    const evil2 = await loginAs('mock', { sub: 'u-300' }, '/\\evil.example');
    expect(evil2.next).toBe('/home');
    const good = await loginAs('mock', { sub: 'u-300' }, '/direct/abc?msg=1');
    expect(good.next).toBe('/direct/abc?msg=1');
  });

  it('provedor desativado ou inexistente responde 404', async () => {
    await update('mock2', { enabled: false });
    expect((await fetch(urlOf('/oauth/mock2/login'), { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(urlOf('/oauth/mock2/callback?code=a&state=b'), { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(urlOf('/oauth/nao-existe/login'), { redirect: 'manual' })).status).toBe(404);
    expect((await api('GET', 'oauth-providers.public')).providers.map((p: any) => p._id)).not.toContain('mock2');
  });

  it('token por query, identidade aninhada, Basic no token e resposta em formulário', async () => {
    await api(
      'POST',
      'oauth-providers',
      {
        _id: 'mockq',
        ...provider({
          tokenSentVia: 'query',
          accessTokenParam: 'token',
          tokenAuth: 'basic',
          identityPath: 'data.perfil',
          fieldMap: { id: 'uid', username: 'login', email: 'mail', name: 'display' },
        }),
      },
      A,
    );
    mock.wrap = 'perfil';
    mock.tokenFormat = 'form';
    const { me } = await loginAs('mockq', { uid: 9001, login: 'Zé Ninguém', mail: 'ze@exemplo.com', display: 'José' });
    expect(mock.last.auth).toBe('basic');
    expect(mock.last.tokenVia).toBe('query');
    expect(me.username).toBe('Ze.Ninguem');
    expect(me.name).toBe('José');
    expect(me.emailVerified).toBe(false);
    // E-mail que o provedor não confirmou não é gravado (não serve de alvo para vínculos futuros).
    expect((await pool.query(`SELECT email FROM users WHERE username = 'Ze.Ninguem'`)).rows[0].email).toBeNull();
  });

  it('usa os claims do id_token quando não há URL de identidade', async () => {
    await api('POST', 'oauth-providers', { _id: 'oidc', ...provider({ identityUrl: '' }) }, A);
    mock.idToken = true;
    const { me } = await loginAs('oidc', { sub: 'oidc-1', preferred_username: 'via.idtoken', email: 'idt@exemplo.com', email_verified: true });
    expect(me.username).toBe('via.idtoken');
    mock.idTokenAud = 'outro-cliente';
    const { res } = await flow('oidc', { sub: 'oidc-2', preferred_username: 'aud.errada' });
    expect(res.status).toBe(401);
  });
});

describe('OAuth: contas existentes', () => {
  it('vincula por e-mail só com a opção ligada e o e-mail confirmado no provedor e na conta', async () => {
    const c = await api('POST', 'users.create', { username: 'carla', name: 'Carla', email: 'carla@empresa.com', password: 'senha-forte-1' }, A);
    const carlaId = c.user._id;
    const ident = { sub: 'm-1', preferred_username: 'carla.oauth', email: 'carla@empresa.com', name: 'Carla' };

    const off = await flow('mock', { ...ident, email_verified: true });
    expect(off.res.status).toBe(409);
    await update('mock', { mergeUsers: true });
    const unverified = await flow('mock', { ...ident, email_verified: false });
    expect(unverified.res.status).toBe(409);
    expect(await unverified.res.text()).toContain('não confirmou');
    // Conta local com o e-mail não confirmado (ex.: alguém se cadastrou com o e-mail de outra pessoa): não vincula.
    const localUnverified = await flow('mock', { ...ident, email_verified: true });
    expect(localUnverified.res.status).toBe(409);
    expect(await localUnverified.res.text()).toContain('não tem o e-mail confirmado');
    expect((await dbUser(carlaId)).auth_source).toBe('local');
    expect((await pool.query(`SELECT 1 FROM oauth_identities WHERE subject = 'm-1'`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM users WHERE username = 'carla.oauth'`)).rowCount).toBe(0);

    // O administrador confirma o e-mail; as sessões abertas antes do vínculo são encerradas.
    expect((await api('POST', 'users.update', { userId: carlaId, data: { verified: true } }, A)).success).toBe(true);
    const before = await passwordLogin('carla', 'senha-forte-1');
    const linked = await loginAs('mock', { ...ident, email_verified: true });
    expect(linked.userId).toBe(carlaId);
    expect(linked.me.username).toBe('carla');
    expect((await api('GET', 'me', undefined, before)).status).toBe(401);
    // A conta continua local (com a senha); o vínculo fica em oauth_identities.
    const row = await dbUser(carlaId);
    expect(row.auth_source).toBe('local');
    expect(row.external_id).toBeNull();
    expect((await pool.query(`SELECT user_id FROM oauth_identities WHERE provider_id = 'mock' AND subject = 'm-1'`)).rows[0].user_id).toBe(carlaId);
    expect((await loginAs('mock', { ...ident, email_verified: true })).userId).toBe(carlaId);
    await update('mock', { mergeUsers: false });

    // 2FA obrigatório continua valendo para o login com senha da conta vinculada.
    await enable2fa(A); // senão o próprio admin fica bloqueado até configurar o 2FA
    await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: true } }, A);
    const pw = await api('POST', 'login', { user: 'carla', password: 'senha-forte-1' });
    expect(pw.data.me.require2faSetup).toBe(true);
    // Quem só entra pelo provedor (sem senha local) segue a política do provedor.
    const oauthOnly = await loginAs('mock', { sub: 'm-2fa', preferred_username: 'so.oauth' });
    expect(oauthOnly.me.require2faSetup).toBe(false);
    // Se essa conta definir uma senha, o 2FA passa a ser exigido.
    await pool.query(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE username = 'carla') WHERE id = $1`, [oauthOnly.userId]);
    expect((await api('POST', 'login', { user: 'so.oauth', password: 'senha-forte-1' })).data.me.require2faSetup).toBe(true);
    await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: false } }, A);
  });

  it('GitHub: só confia no e-mail principal verificado de /user/emails', async () => {
    const created = await api('POST', 'oauth-providers', { _id: 'gh', type: 'github', enabled: true, clientId: CLIENT_ID, clientSecret: SECRET, serverUrl: `${mock.base}/gh`, mergeUsers: true }, A);
    expect(created.provider.effective.authorizeUrl).toBe(`${mock.base}/gh/login/oauth/authorize`);
    expect(created.provider.effective.identityUrl).toBe(`${mock.base}/gh/api/v3/user`);
    expect(created.provider.label).toBe('Entrar com GitHub');
    const d = await api('POST', 'users.create', { username: 'dani', name: 'Dani', email: 'dani@empresa.com', password: 'senha-forte-1', verified: true }, A);
    const ghUser = { id: 4242, login: 'dani-gh', name: 'Dani GH', email: 'dani@empresa.com', avatar_url: `${mock.base}/gh/avatar.png` };
    mock.tokenFormat = 'form';

    mock.emails = [
      { email: 'dani@empresa.com', primary: true, verified: false },
      { email: 'dani@outro.com', primary: false, verified: true },
    ];
    const refused = await flow('gh', ghUser);
    expect(refused.res.status).toBe(409);
    expect(mock.last.scope).toBe('read:user user:email');

    mock.emails = [{ email: 'dani@empresa.com', primary: true, verified: true }];
    const ok = await loginAs('gh', ghUser);
    expect(ok.userId).toBe(d.user._id);
    const dani = await dbUser(d.user._id);
    expect(dani.auth_source).toBe('local');
    expect((await pool.query(`SELECT user_id FROM oauth_identities WHERE provider_id = 'gh' AND subject = '4242'`)).rows[0].user_id).toBe(d.user._id);
    // A foto vem do próprio servidor do provedor, com o token de acesso.
    expect(dani.avatar_etag).toBeTruthy();
    expect(mock.last.avatarAuth).toBe(true);

    // Sem e-mail verificado, um usuário novo é criado sem marcar o e-mail como verificado.
    mock.emails = [{ email: 'novo@gh.com', primary: true, verified: false }];
    const fresh = await loginAs('gh', { id: 5151, login: 'novo-gh', email: null });
    expect(fresh.me.username).toBe('novo-gh');
    expect(fresh.me.emailVerified).toBe(false);
    expect((await dbUser(fresh.userId)).email).toBeNull();
  });

  it('foto: redirecionamentos conferidos, sem http fora do provedor nem endereços internos', async () => {
    expect(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe'].every(internalAddress)).toBe(true);
    expect(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'].some(internalAddress)).toBe(false);

    // Servidor "interno" que não pode receber nada: conta conexões TCP e pedidos HTTP.
    let hits = 0;
    const inner = http.createServer((_req, res) => (hits++, res.writeHead(200, { 'content-type': 'image/png' }), res.end(PNG)));
    let conns = 0;
    inner.on('connection', () => conns++);
    await new Promise<void>((r) => inner.listen(0, '127.0.0.1', () => r()));
    const port = (inner.address() as any).port;
    const tcp = net.createServer((sock) => (conns++, sock.destroy()));
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const tcpPort = (tcp.address() as any).port;
    try {
      const avatarOf = async (sub: string, picture: string) => (await dbUser((await loginAs('mock', { sub, preferred_username: `foto-${sub}`, picture })).userId)).avatar_etag;
      // https → http interno por redirecionamento (o provedor aqui é o próprio mock; o destino é outro host:porta).
      expect(await avatarOf('av-1', `${mock.base}/redir?to=${encodeURIComponent(`http://127.0.0.1:${port}/latest/meta-data/`)}`)).toBeNull();
      // https direto para IP interno ou para um nome que resolve para loopback.
      expect(await avatarOf('av-2', `https://127.0.0.1:${tcpPort}/a.png`)).toBeNull();
      expect(await avatarOf('av-3', `https://localhost:${tcpPort}/a.png`)).toBeNull();
      expect(await avatarOf('av-4', `${mock.base}/redir?to=${encodeURIComponent(`https://localhost:${tcpPort}/a.png`)}`)).toBeNull();
      expect(hits).toBe(0);
      expect(conns).toBe(0);
      // Redirecionamento dentro do próprio servidor do provedor continua valendo.
      expect(await avatarOf('av-5', `${mock.base}/redir?to=${encodeURIComponent(`${mock.base}/avatar.png`)}`)).toBeTruthy();
    } finally {
      inner.close();
      tcp.close();
    }
  });

  it('nome de usuário em uso gera outro nome em vez de tomar a conta', async () => {
    const adminBefore = await dbUser(A.userId);
    const { userId, me } = await loginAs('mock', { sub: 'c-1', preferred_username: 'admin', email: 'outro-admin@externo.com', email_verified: true });
    expect(userId).not.toBe(A.userId);
    expect(me.username).toMatch(/^admin-\d+$/);
    expect(me.roles).toEqual(['user']);
    const adminAfter = await dbUser(A.userId);
    expect(adminAfter.auth_source).toBe('local');
    expect(adminAfter.roles).toEqual(adminBefore.roles);
    expect(adminAfter.email).toBe(adminBefore.email);
  });

  it('respeita o bloqueio de novos usuários e recusa usuários desativados', async () => {
    await update('mock', { blockNewUsers: true });
    const blocked = await flow('mock', { sub: 'b-1', preferred_username: 'bloqueado' });
    expect(blocked.res.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM users WHERE username = 'bloqueado'`)).rowCount).toBe(0);
    // Quem já existe continua entrando.
    const joana = await loginAs('mock', { sub: 'u-100', email: 'joana@empresa.com', email_verified: true });
    await update('mock', { blockNewUsers: false });

    expect((await api('POST', 'users.setActiveStatus', { userId: joana.userId, activeStatus: false }, A)).success).toBe(true);
    const inactive = await flow('mock', { sub: 'u-100', email: 'joana@empresa.com', email_verified: true });
    expect(inactive.res.status).toBe(403);
    expect(inactive.res.headers.get('location')).toBeNull();
    await api('POST', 'users.setActiveStatus', { userId: joana.userId, activeStatus: true }, A);
  });
});

describe('OAuth: papéis e canais', () => {
  const roles = async (groups: string[], sub = 'r-1') => (await loginAs('mock', { sub, preferred_username: `papel-${sub}`, realm: { roles: groups } })).me.roles.slice().sort();

  it('mapeia papéis, aplica só os existentes e só concede admin por mapeamento', async () => {
    await update('mock', {
      rolesClaim: 'realm.roles',
      syncRoles: true,
      mergeRoles: false,
      roleMapping: { 'chat-admins': 'admin', suporte: ['livechat-agent'], fantasma: 'papel-inexistente' },
    });
    expect(await roles(['suporte', 'fantasma'])).toEqual(['livechat-agent', 'user']);
    expect(await roles(['chat-admins'])).toEqual(['admin', 'user']);
    expect(await roles([])).toEqual(['user']);

    // Valores fora do mapa nunca viram papéis (ex.: um grupo "auditor" criado pelo próprio usuário no GitLab).
    expect(await roles(['auditor', 'livechat-manager', 'admin', 'constructor', 'toString'])).toEqual(['user']);
    // Sincronizar sem mapa é recusado.
    const empty = await update('mock', { roleMapping: {} });
    expect(empty.status).toBe(400);
    expect(empty.errorType).toBe('error-oauth-role-mapping');
    expect((await api('POST', 'oauth-providers', { _id: 'gl-sem-mapa', type: 'gitlab', clientId: CLIENT_ID, syncRoles: true }, A)).status).toBe(400);
    // Provedor salvo antes desta regra (sincronização ligada, mapa vazio): o login não mexe nos papéis.
    await pool.query(`UPDATE oauth_providers SET role_mapping = '{}' WHERE id = 'mock'`);
    const manual = await loginAs('mock', { sub: 'r-9', preferred_username: 'papel-manual' });
    expect((await api('POST', 'roles.addUserToRole', { roleId: 'livechat-agent', userId: manual.userId }, A)).success).toBe(true);
    expect((await loginAs('mock', { sub: 'r-9', realm: { roles: ['auditor', 'livechat-manager'] } })).me.roles.slice().sort()).toEqual(['livechat-agent', 'user']);
    // Texto separado por vírgula também vale.
    await update('mock', { roleMapping: { suporte: 'livechat-agent', gestao: 'livechat-manager' } });
    expect((await loginAs('mock', { sub: 'r-2', realm: { roles: 'gestao, suporte, auditor' } })).me.roles.slice().sort()).toEqual(['livechat-agent', 'livechat-manager', 'user']);
  });

  it('mesclar papéis mantém os atribuídos à mão; sem mesclar, o provedor manda', async () => {
    await update('mock', { roleMapping: { suporte: 'livechat-agent', gestao: 'livechat-manager' }, mergeRoles: true });
    const first = await loginAs('mock', { sub: 'r-3', preferred_username: 'mescla', realm: { roles: ['suporte'] } });
    expect((await api('POST', 'roles.addUserToRole', { roleId: 'auditor', userId: first.userId }, A)).success).toBe(true);
    expect(await roles(['suporte', 'gestao'], 'r-3')).toEqual(['auditor', 'livechat-agent', 'livechat-manager', 'user']);
    expect(await roles(['gestao'], 'r-3')).toEqual(['auditor', 'livechat-manager', 'user']);
    expect(await roles([], 'r-3')).toEqual(['auditor', 'user']);

    await update('mock', { mergeRoles: false });
    expect(await roles(['suporte'], 'r-3')).toEqual(['livechat-agent', 'user']);
    await update('mock', { syncRoles: false });
    // Com a sincronização desligada os papéis não mudam.
    expect(await roles(['gestao'], 'r-3')).toEqual(['livechat-agent', 'user']);
  });

  it('papéis e canais configurados já na criação do provedor', async () => {
    const r = await api(
      'POST',
      'oauth-providers',
      { _id: 'sync', ...provider({ rolesClaim: 'grupos', syncRoles: true, roleMapping: { suporte: 'livechat-agent' }, mapChannels: true, channelMapping: { suporte: 'canal-suporte' } }) },
      A,
    );
    expect(r.provider.rolesClaim).toBe('grupos');
    expect(r.provider.roleMapping).toEqual({ suporte: 'livechat-agent' });
    const gl = await api('POST', 'oauth-providers', { _id: 'gl', type: 'gitlab', clientId: CLIENT_ID, serverUrl: 'https://gitlab.empresa.com.br' }, A);
    expect(gl.provider.rolesClaim).toBe('groups');
    expect(gl.provider.effective.tokenUrl).toBe('https://gitlab.empresa.com.br/oauth/token');
    const { me, userId } = await loginAs('sync', { sub: 's-1', preferred_username: 'criado.sync', grupos: ['suporte'] });
    expect(me.roles.slice().sort()).toEqual(['livechat-agent', 'user']);
    const subs = await pool.query(`SELECT 1 FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 AND r.name = 'canal-suporte'`, [userId]);
    expect(subs.rowCount).toBe(1);
  });

  it('mapeia grupos para canais e cria grupo privado quando falta', async () => {
    await update('mock', { mapChannels: true, groupsClaim: 'grupos', channelMapping: { 'time-dev': ['dev-interno', 'geral'], outro: 'nome inválido!' } });
    const { userId } = await loginAs('mock', { sub: 'ch-1', preferred_username: 'canais', grupos: ['time-dev', 'outro', 'sem-mapa'] });
    const room = (await pool.query(`SELECT id, t FROM rooms WHERE name = 'dev-interno'`)).rows[0];
    expect(room.t).toBe('p');
    const subs = await pool.query(`SELECT r.name FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 ORDER BY r.name`, [userId]);
    expect(subs.rows.map((r) => r.name)).toEqual(['dev-interno', 'geral']);
    // Login seguinte não duplica nada.
    await loginAs('mock', { sub: 'ch-1', grupos: ['time-dev'] });
    expect((await pool.query(`SELECT count(*)::int AS n FROM rooms WHERE name = 'dev-interno'`)).rows[0].n).toBe(1);
    await update('mock', { mapChannels: false });
  });
});

describe('OAuth: provedor e diretório', () => {
  const TENANT = '11111111-2222-3333-4444-555555555555';
  const OTHER = '99999999-8888-7777-6666-555555555555';
  const msUser = (tid: string, extra: Record<string, unknown> = {}) => ({ tid, iss: `https://login.microsoftonline.com/${tid}/v2.0`, ...extra });
  const ms = (id: string, extra: Record<string, unknown> = {}) =>
    api('POST', 'oauth-providers', { _id: id, ...provider({ type: 'microsoft', label: '', scope: '', ...extra }) }, A);

  it('Microsoft: diretório fixo confere tid/iss e só ele sincroniza papéis', async () => {
    // Com "common" (ou vazio) qualquer diretório define papéis e grupos: sincronizar é recusado.
    for (const tenant of ['', 'common', 'organizations']) {
      const r = await ms(`ms-multi-${tenant || 'vazio'}`, { tenant, syncRoles: true, rolesClaim: 'roles', roleMapping: { 'Chat.Admin': 'admin' } });
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-oauth-tenant');
    }
    expect((await ms('ms-multi-canais', { tenant: 'common', mapChannels: true, channelMapping: { g: 'x' } })).status).toBe(400);

    const created = await ms('ms', { tenant: TENANT, syncRoles: true, roleMapping: { 'Chat.Admin': 'admin', Suporte: 'livechat-agent' } });
    expect(created.success).toBe(true);
    expect(created.provider.effective.fieldMap.emailVerified).toBe('xms_edov');
    mock.idToken = true;
    // Conta de outro diretório (ex.: diretório gratuito criado por alguém, com o papel Chat.Admin atribuído a si mesmo).
    const foreign = await flow('ms', msUser(OTHER, { sub: 'ms-x', preferred_username: 'intruso', roles: ['Chat.Admin'] }));
    expect(foreign.res.status).toBe(403);
    expect(await foreign.res.text()).toContain('outro diretório');
    // Emissor que não bate com o tid.
    expect((await flow('ms', { ...msUser(TENANT), iss: `https://login.microsoftonline.com/${OTHER}/v2.0`, sub: 'ms-y', roles: ['Chat.Admin'] })).res.status).toBe(401);
    expect((await pool.query(`SELECT 1 FROM users WHERE username = 'intruso'`)).rowCount).toBe(0);
    // Sem id_token não há como saber o diretório.
    mock.idToken = false;
    expect((await flow('ms', msUser(TENANT, { sub: 'ms-z' }))).res.status).toBe(401);
    mock.idToken = true;
    const ok = await loginAs('ms', msUser(TENANT, { sub: 'ms-1', preferred_username: 'ana.ms', roles: ['Suporte'] }));
    expect(ok.me.roles.slice().sort()).toEqual(['livechat-agent', 'user']);
  });

  it('Microsoft: e-mail do diretório vale para domínios permitidos; vínculo só com xms_edov', async () => {
    await api('POST', 'settings', { settings: { Accounts_AllowedDomainsList: 'empresa.com.br' } }, A);
    try {
      mock.idToken = true;
      // Diretório fixo: o Entra não manda email_verified, mas o e-mail é gerenciado pelo diretório da empresa.
      const first = await loginAs('ms', msUser(TENANT, { sub: 'ms-2', preferred_username: 'joao.ms', email: 'joao@empresa.com.br' }));
      const joao = await dbUser(first.userId);
      expect(joao.email).toBe('joao@empresa.com.br');
      expect(joao.email_verified).toBe(false);
      // Diretório "common": só com xms_edov (domínio verificado pelo diretório que emitiu o token).
      await ms('ms-common', { tenant: 'common' });
      expect((await flow('ms-common', msUser(OTHER, { sub: 'c-1', email: 'maria@empresa.com.br' }))).res.status).toBe(403);
      const maria = await loginAs('ms-common', msUser(OTHER, { sub: 'c-2', preferred_username: 'maria.ms', email: 'maria@empresa.com.br', xms_edov: true }));
      expect((await dbUser(maria.userId)).email_verified).toBe(true);
      // Vincular a uma conta existente exige xms_edov, mesmo no diretório fixo.
      await update('ms', { mergeUsers: true });
      const u = await api('POST', 'users.create', { username: 'rui', name: 'Rui', email: 'rui@empresa.com.br', password: 'senha-forte-1', verified: true }, A);
      expect((await flow('ms', msUser(TENANT, { sub: 'ms-3', email: 'rui@empresa.com.br' }))).res.status).toBe(409);
      expect((await loginAs('ms', msUser(TENANT, { sub: 'ms-3', email: 'rui@empresa.com.br', xms_edov: true }))).userId).toBe(u.user._id);
    } finally {
      await api('POST', 'settings', { settings: { Accounts_AllowedDomainsList: '' } }, A);
    }
  });

  it('trocar o servidor do provedor desfaz os vínculos (ids podem repetir entre servidores)', async () => {
    await api('POST', 'oauth-providers', { _id: 'troca', ...provider() }, A);
    const first = await loginAs('troca', { sub: '4242', preferred_username: 'pessoa.antiga', email: 'antiga@empresa.com', email_verified: true });
    // Mudar só o texto do botão mantém os vínculos.
    await update('troca', { label: 'Outro texto' });
    expect((await loginAs('troca', { sub: '4242' })).userId).toBe(first.userId);
    // Novo servidor: o mesmo id "4242" é outra pessoa.
    const moved = await update('troca', { authorizeUrl: `${mock.base}/novo/authorize`, tokenUrl: `${mock.base}/novo/token`, identityUrl: `${mock.base}/novo/userinfo` });
    expect(moved.success).toBe(true);
    expect((await pool.query(`SELECT 1 FROM oauth_identities WHERE provider_id = 'troca'`)).rowCount).toBe(0);
    const other = await loginAs('troca', { sub: '4242', preferred_username: 'pessoa.nova', email: 'nova@outra.com', email_verified: true });
    expect(other.userId).not.toBe(first.userId);
    expect(other.me.username).toBe('pessoa.nova');
    const audit = await pool.query(`SELECT data FROM audit_log WHERE action = 'oauth.provider.updated' AND target->>'providerId' = 'troca' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0].data.identitiesRemoved).toBe(1);
  });
});
