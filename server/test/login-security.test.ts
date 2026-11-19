import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { sha256 } from '../src/lib/ids';
import { totpCode } from '../src/lib/totp';
import { getSetting, loadSettings } from '../src/services/settings';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Os e-mails ficam numa caixa de saída em memória em vez de irem para um servidor SMTP.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => (outbox.push(m), true),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, SMTP_Host: 'smtp.empresa.test' } }, A);
});
afterAll(() => stopServer());

const PW = 'senha-forte-1';
const genToken = (u: Auth, name: string, extra: Record<string, unknown> = {}) => api('POST', 'users.generatePersonalAccessToken', { tokenName: name, ...extra }, u);
const patAuth = (u: Auth, token: string): Auth => ({ userId: u.userId, authToken: token, username: u.username });
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

describe('tokens de acesso pessoal', () => {
  it('criar pede a senha atual e, com 2FA, o código', async () => {
    const u = await newUser(A);
    expect(await genToken(u, 'sem-senha')).toMatchObject({ status: 400, errorType: 'error-invalid-password', error: 'Senha atual incorreta.' });
    expect(await genToken(u, 'errada', { password: 'outra-senha' })).toMatchObject({ status: 400, errorType: 'error-invalid-password' });
    const ok = await genToken(u, 'certa', { password: PW });
    expect(ok.token).toBeTruthy();
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, ok.token))).status).toBe(200);

    const en = await api('POST', 'users.2fa.enableTotp', {}, u);
    await api('POST', 'users.2fa.verifyTotp', { code: totpCode(en.secret) }, u);
    expect(await genToken(u, 'sem-codigo', { password: PW })).toMatchObject({ status: 400, errorType: 'invalid-totp' });
    expect((await genToken(u, 'com-codigo', { password: PW, code: totpCode(en.secret, Date.now() + 30_000) })).token).toBeTruthy();
  });

  it('redefinir a senha pelo e-mail revoga os tokens', async () => {
    const u = await newUser(A);
    const token = (await genToken(u, 'script', { password: PW })).token;
    outbox.length = 0;
    await api('POST', 'users.forgotPassword', { email: `${u.username}@test.local` });
    await sleep(50);
    const link = /reset-password#token=([A-Za-z0-9_-]+)/.exec(outbox[0].text)![1];
    expect((await api('POST', 'users.resetPassword', { token: link, password: 'senha-redefinida-1' })).success).toBe(true);
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, token))).status).toBe(401);
    expect((await pool.query('SELECT 1 FROM personal_access_tokens WHERE user_id = $1', [u.userId])).rowCount).toBe(0);
    const ev = (await pool.query(`SELECT data FROM audit_log WHERE action = 'user.password.reset' AND target->>'userId' = $1`, [u.userId])).rows[0];
    expect(ev.data).toEqual({ tokensRevoked: 1 });
    await sleep(50);
    expect(outbox.find((m) => m.subject.includes('Sua senha foi alterada'))?.text).toContain('os tokens de acesso foram revogados');
  });

  it('encerrar sessões e trocar a senha pelo administrador revogam os tokens; a troca da própria senha não', async () => {
    const u = await newUser(A);
    const t1 = (await genToken(u, 'a', { password: PW })).token;
    const out = await api('POST', 'users.logout', { userId: u.userId }, A);
    expect(out.message).toBe('Sessões encerradas: 1. Tokens de acesso revogados: 1');
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, t1))).status).toBe(401);

    const s2 = await login(u.username, PW);
    const t2 = (await genToken(s2, 'b', { password: PW })).token;
    expect((await api('POST', 'users.update', { userId: u.userId, data: { password: 'trocada-pelo-admin-1' } }, A)).success).toBe(true);
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, t2))).status).toBe(401);

    const s3 = await login(u.username, 'trocada-pelo-admin-1');
    const t3 = (await genToken(s3, 'c', { password: 'trocada-pelo-admin-1' })).token;
    const bulk = await api('POST', 'users.bulkLogout', { userIds: [u.userId] }, A);
    expect(bulk).toMatchObject({ users: 1, sessions: 1, tokens: 1 });
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, t3))).status).toBe(401);

    const s4 = await login(u.username, 'trocada-pelo-admin-1');
    const t4 = (await genToken(s4, 'd', { password: 'trocada-pelo-admin-1' })).token;
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { currentPassword: 'trocada-pelo-admin-1', newPassword: 'trocada-por-mim-1' } }, s4)).success).toBe(true);
    expect((await api('GET', 'subscriptions.get', undefined, patAuth(u, t4))).status).toBe(200);
  });

  it('desativar a conta fecha o socket aberto com o token; revogar um token fecha o dele', async () => {
    const u = await newUser(A);
    const ws = connectWs(patAuth(u, (await genToken(u, 'ws', { password: PW })).token));
    await ws.ready;
    const closed = new Promise<number>((r) => ws.ws.on('close', (code) => r(code)));
    expect((await api('POST', 'users.setActiveStatus', { userId: u.userId, activeStatus: false }, A)).success).toBe(true);
    expect(await closed).toBe(4003);
    await api('POST', 'users.setActiveStatus', { userId: u.userId, activeStatus: true }, A);

    const s = await login(u.username, PW);
    const ws2 = connectWs(patAuth(u, (await genToken(s, 'ws2', { password: PW })).token));
    await ws2.ready;
    const closed2 = new Promise<number>((r) => ws2.ws.on('close', (code) => r(code)));
    await api('POST', 'users.removePersonalAccessToken', { tokenName: 'ws2' }, s);
    expect(await closed2).toBe(4003);
  });
});

describe('login', () => {
  it('espaço antes ou depois do usuário é ignorado', async () => {
    const u = await newUser(A);
    expect((await api('POST', 'login', { user: `  ${u.username} `, password: PW })).data?.userId).toBe(u.userId);
    expect((await api('POST', 'login', { user: ` ${u.username}@test.local\t`, password: PW })).data?.userId).toBe(u.userId);
  });

  it('conta inexistente leva o mesmo tempo que senha errada (o tempo não revela quem tem cadastro)', async () => {
    const u = await newUser(A);
    await login(u.username, PW); // aquece o hash de mentira
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now();
      expect((await api('POST', 'login', { user: u.username, password: `errada-${i}` })).status).toBe(401);
      known.push(performance.now() - t);
      t = performance.now();
      expect((await api('POST', 'login', { user: `ninguem-${i}-${Date.now()}`, password: `errada-${i}` })).status).toBe(401);
      unknown.push(performance.now() - t);
    }
    await pool.query('DELETE FROM login_attempts');
    // Antes: ~3 ms contra ~35 ms (10x). Agora as duas calculam o scrypt.
    expect(median(unknown)).toBeGreaterThan(median(known) / 3);
  });
});

describe('bloqueio por tentativas falhas', () => {
  // Login como o navegador faz: IP (X-Forwarded-For do proxy local) e o cookie wescc_device, quando já tem.
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const attempt = async (user: string, password: string, ip: string, cookie?: string) => {
    const r = await fetch(urlOf('/api/v1/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ user, password }),
    });
    const j = await r.json();
    return { status: r.status, error: j.error as string | undefined, cookie: /wescc_device=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0] };
  };

  it('quem erra a senha de outra pessoa não a tira do chat: o navegador em que ela já entrou continua entrando', async () => {
    await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 3 } }, A);
    try {
      const u = await newUser(A);
      const own = (await attempt(u.username, PW, '10.7.0.1')).cookie!;
      expect(own).toBeTruthy();
      // Tentativas espalhadas por várias máquinas bloqueiam a conta para aparelhos em que ela nunca entrou.
      for (let i = 0; i < 3; i++) expect((await attempt(u.username, 'errada', `10.66.0.${i + 1}`)).status).toBe(401);
      const stranger = await attempt(u.username, PW, '10.66.0.9');
      expect([stranger.status, stranger.error]).toEqual([429, 'Muitas tentativas falhas nesta conta. Entre por um computador ou celular em que você já entrou antes, ou tente novamente em alguns minutos.']);
      expect((await attempt(`${u.username}@test.local`, PW, '10.7.0.2')).status).toBe(429);
      // O navegador da pessoa entra (de qualquer rede, inclusive a mesma do atacante), pelo usuário ou pelo e-mail.
      expect((await attempt(u.username, PW, '10.7.0.1', own)).status).toBe(200);
      expect((await attempt(`${u.username}@test.local`, PW, '10.66.0.1', own)).status).toBe(200);
      // Entrar por ele não desfaz o bloqueio da conta para os outros aparelhos.
      expect((await attempt(u.username, PW, '10.66.0.9')).status).toBe(429);
      // O cookie de uma conta não vale para outra.
      const other = await newUser(A);
      for (let i = 0; i < 3; i++) await attempt(other.username, 'errada', `10.66.1.${i + 1}`);
      expect((await attempt(other.username, PW, '10.7.0.1', own)).status).toBe(429);

      // O aparelho conhecido também tem limite, só dele: errar 3 vezes nele bloqueia só ele.
      await pool.query('DELETE FROM login_attempts');
      for (let i = 0; i < 3; i++) expect((await attempt(u.username, 'errada', '10.7.0.1', own)).status).toBe(401);
      const self = await attempt(u.username, PW, '10.7.0.1', own);
      expect([self.status, self.error]).toEqual([429, 'Muitas tentativas falhas. Tente novamente em alguns minutos.']);
      expect((await attempt(u.username, PW, '10.7.0.5')).status).toBe(200);
    } finally {
      await pool.query('DELETE FROM login_attempts');
      await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 10 } }, A);
    }
  });
});

describe('2FA', () => {
  it('o mesmo código do aplicativo não vale duas vezes, nem o da ativação; dois pedidos juntos: só um entra', async () => {
    const u = await newUser(A);
    const en = await api('POST', 'users.2fa.enableTotp', {}, u);
    const activation = totpCode(en.secret);
    expect((await api('POST', 'users.2fa.verifyTotp', { code: activation }, u)).codes).toHaveLength(12);
    const reuse = await api('POST', 'login', { user: u.username, password: PW, code: activation });
    expect([reuse.status, reuse.error]).toEqual([401, 'Código de verificação inválido ou já usado.']);

    const next = totpCode(en.secret, Date.now() + 30_000);
    const [a, b] = await Promise.all([api('POST', 'login', { user: u.username, password: PW, code: next }), api('POST', 'login', { user: u.username, password: PW, code: next })]);
    expect([!!a.data?.authToken, !!b.data?.authToken].sort()).toEqual([false, true]);
    expect((await api('POST', 'login', { user: u.username, password: PW, code: next })).status).toBe(401);
    await pool.query('DELETE FROM login_attempts');
  });

  it('códigos de backup: sem letras que se confundem, sem diferença de maiúsculas, espaço ou hífen; os antigos continuam valendo', async () => {
    const u = await newUser(A);
    const en = await api('POST', 'users.2fa.enableTotp', {}, u);
    const codes: string[] = (await api('POST', 'users.2fa.verifyTotp', { code: totpCode(en.secret) }, u)).codes;
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    const typed = ` ${codes[0].slice(0, 5).toLowerCase()} ${codes[0].slice(6)} `;
    expect((await api('POST', 'login', { user: u.username, password: PW, code: typed })).data?.userId).toBe(u.userId);
    expect((await api('POST', 'login', { user: u.username, password: PW, code: codes[0] })).status).toBe(401); // uso único
    expect((await api('POST', 'login', { user: u.username, password: PW, code: codes[1].replace('-', '') })).data?.userId).toBe(u.userId);

    // Código gerado antes da mudança (base64url, com maiúsculas e minúsculas): vale como foi mostrado.
    await pool.query('UPDATE users SET backup_codes = array_append(backup_codes, $2) WHERE id = $1', [u.userId, sha256('aB-c_9xY')]);
    expect((await api('POST', 'login', { user: u.username, password: PW, code: 'aB-c_9xY' })).data?.userId).toBe(u.userId);
    await pool.query('DELETE FROM login_attempts');
  });

  it('desativar o 2FA pede a senha e bloqueia depois de várias tentativas erradas', async () => {
    await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 3 } }, A);
    try {
      const u = await newUser(A);
      const en = await api('POST', 'users.2fa.enableTotp', {}, u);
      await api('POST', 'users.2fa.verifyTotp', { code: totpCode(en.secret) }, u);
      const off = (body: Record<string, unknown>) => api('POST', 'users.2fa.disableTotp', body, u);
      const next = totpCode(en.secret, Date.now() + 30_000);
      expect(await off({ code: next })).toMatchObject({ status: 400, errorType: 'error-invalid-password', error: 'Senha atual incorreta.' });
      expect(await off({ code: '000000', password: PW })).toMatchObject({ status: 400, errorType: 'invalid-totp' });
      expect(await off({ code: '000001', password: PW })).toMatchObject({ status: 400, errorType: 'invalid-totp' });
      // A terceira falha (senha ou código) bloqueia por alguns minutos, mesmo com a senha e o código certos.
      expect(await off({ code: next, password: PW })).toMatchObject({ status: 429, errorType: 'error-login-blocked', error: 'Muitas tentativas erradas. Tente novamente em alguns minutos.' });
      expect((await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [u.userId])).rows[0].totp_enabled).toBe(true);
      await pool.query(`DELETE FROM login_attempts WHERE key = $1`, [`2fa-disable:${u.userId}`]);
      expect((await off({ code: next, password: PW })).success).toBe(true);
      expect((await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [u.userId])).rows[0].totp_enabled).toBe(false);
    } finally {
      await pool.query('DELETE FROM login_attempts');
      await api('POST', 'settings', { settings: { Accounts_Block_Failed_Login_Attempts: 10 } }, A);
    }
  });
});

describe('troca de senha', () => {
  it('a senha nova precisa ser diferente da atual (troca obrigatória e Minha conta); o administrador define qualquer uma', async () => {
    const r = await api('POST', 'users.create', { username: `prov${Date.now()}`, name: 'Prov', email: `prov${Date.now()}@test.local`, password: 'Provisoria123', requirePasswordChange: true }, A);
    const forced = await login(r.user.username, 'Provisoria123');
    // Salvar com o campo vazio não é mais um 200 que não muda nada.
    const empty = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: '', currentPassword: '' } }, forced);
    expect([empty.status, empty.error]).toEqual([400, 'Digite a nova senha.']);
    const spaces = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: '          ', currentPassword: '' } }, forced);
    expect([spaces.status, spaces.error]).toEqual([400, 'A senha não pode ter só espaços.']);
    const same = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: 'Provisoria123', currentPassword: '' } }, forced);
    expect([same.status, same.errorType, same.error]).toEqual([400, 'error-password-same', 'A senha nova precisa ser diferente da atual.']);
    expect((await api('GET', 'me', undefined, forced)).requirePasswordChange).toBe(true);
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: 'Definitiva123', currentPassword: '' } }, forced)).success).toBe(true);

    const u = await newUser(A);
    const mine = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: PW, currentPassword: PW } }, u);
    expect(mine.errorType).toBe('error-password-same');
    expect((await api('POST', 'users.update', { userId: u.userId, data: { password: PW } }, A)).success).toBe(true);
  });
});

describe('esqueci minha senha sem e-mail configurado', () => {
  it('a tela de login sabe que não há envio, e o pedido diz o motivo em vez de prometer um e-mail', async () => {
    const pub = async () => (await api('GET', 'settings.public')).settings.find((s: any) => s._id === 'Accounts_PasswordReset_Available')?.value;
    expect(await pub()).toBe(true);
    await api('POST', 'settings', { settings: { SMTP_Host: '' } }, A);
    try {
      expect(await pub()).toBe(false);
      const u = await newUser(A);
      const r = await api('POST', 'users.forgotPassword', { email: `${u.username}@test.local` });
      expect([r.status, r.errorType, r.error]).toEqual([503, 'error-email-not-configured', 'O envio de e-mails não está configurado neste chat. Peça ao administrador para redefinir a sua senha.']);
      expect((await api('POST', 'users.forgotPassword', { email: 'ninguem@test.local' })).status).toBe(503);
    } finally {
      await api('POST', 'settings', { settings: { SMTP_Host: 'smtp.empresa.test' } }, A);
    }
    await api('POST', 'settings', { settings: { Accounts_PasswordReset: false } }, A);
    expect(await pub()).toBe(false);
    await api('POST', 'settings', { settings: { Accounts_PasswordReset: true } }, A);
  });
});

describe('cadastro', () => {
  it('instalação nova: cadastro desativado; quem já usava o chat com o padrão antigo continua com o cadastro público', async () => {
    const s = (await api('GET', 'settings', { group: 'Accounts' }, A)).settings.find((x: any) => x._id === 'Accounts_RegistrationForm');
    expect(s.value).toBe('Disabled');
    const r = await api('POST', 'users.register', { username: 'estranho', name: 'Estranho', email: 'estranho@gmail.com', pass: 'qualquer-123' });
    expect([r.status, r.error]).toEqual([403, 'O cadastro está desativado.']);

    // Instalação que já existia (com contas) e nunca mexeu na opção: a migração grava o valor de antes.
    await pool.query(`DELETE FROM settings WHERE id = 'Accounts_RegistrationForm'`);
    await pool.query(`DELETE FROM schema_migrations WHERE name = '046_login_seguro.sql'`);
    await migrate(() => {});
    await loadSettings();
    try {
      expect(getSetting('Accounts_RegistrationForm')).toBe('Public');
      // Quem já tinha escolhido outro valor fica com ele.
      await pool.query(`UPDATE settings SET value = '"Secret"' WHERE id = 'Accounts_RegistrationForm'`);
      await pool.query(`DELETE FROM schema_migrations WHERE name = '046_login_seguro.sql'`);
      await migrate(() => {});
      await loadSettings();
      expect(getSetting('Accounts_RegistrationForm')).toBe('Secret');
    } finally {
      await pool.query(`DELETE FROM settings WHERE id = 'Accounts_RegistrationForm'`);
      await loadSettings();
    }
    expect(getSetting('Accounts_RegistrationForm')).toBe('Disabled');
  });
  it('campos com mensagem para quem preenche; nome obrigatório e com limite; senha só de espaços recusada', async () => {
    await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Public' } }, A);
    try {
      const reg = (body: Record<string, unknown>) => api('POST', 'users.register', { name: 'Fulano', username: `cad${Date.now()}`, email: `cad${Date.now()}@test.local`, pass: 'senha-forte-1', ...body });
      expect((await reg({ username: '' })).error).toBe('Informe o nome de usuário.');
      expect((await reg({ name: '   ' })).error).toBe('Informe o nome.');
      expect((await reg({ name: undefined })).error).toBe('Informe o nome.');
      expect((await reg({ name: 'N'.repeat(81) })).error).toBe('O nome pode ter até 80 caracteres.');
      expect((await reg({ email: ' ' })).error).toBe('Informe o e-mail.');
      expect((await reg({ pass: '' })).error).toBe('Informe a senha.');
      expect((await reg({ pass: '          ' })).error).toBe('A senha não pode ter só espaços.');
      // Espaços nas pontas do nome saem.
      const ok = await reg({ name: '  Fulana de Tal  ' });
      expect(ok.user.name).toBe('Fulana de Tal');
      // Com o cadastro fechado a resposta continua sendo essa, mesmo com campos vazios.
      await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Disabled' } }, A);
      expect((await reg({ name: '' })).error).toBe('O cadastro está desativado.');

      // O administrador também não cria conta sem nome ou com nome enorme.
      const create = (name: unknown) => api('POST', 'users.create', { username: `adm${Date.now()}`, name, email: `adm${Date.now()}@test.local`, password: 'senha-forte-1' }, A);
      expect((await create('  ')).error).toBe('Informe o nome.');
      expect((await create('N'.repeat(500))).error).toBe('O nome pode ter até 80 caracteres.');
      expect((await create(' Beltrano ')).user.name).toBe('Beltrano');
    } finally {
      await pool.query(`DELETE FROM settings WHERE id = 'Accounts_RegistrationForm'`);
      await loadSettings();
    }
  });
});

describe('saída forçada com motivo', () => {
  // O motivo que chega ao navegador com o force_logout (a tela de entrar explica a saída).
  const reasonOf = async (s: Auth, action: () => Promise<unknown>) => {
    const ws = connectWs(s);
    await ws.ready;
    await action();
    const ev = await ws.waitFor((e) => e.type === 'force_logout');
    ws.close();
    return ev.reason;
  };

  it('desativar, encerrar sessões, trocar a senha e encerrar em outro dispositivo dizem o motivo', async () => {
    let u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'users.setActiveStatus', { userId: u.userId, activeStatus: false }, A))).toBe('deactivated');
    u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'users.bulkSetActiveStatus', { userIds: [u.userId], activeStatus: false }, A))).toBe('deactivated');
    u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'users.logout', { userId: u.userId }, A))).toBe('admin-logout');
    u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'users.bulkLogout', { userIds: [u.userId] }, A))).toBe('admin-logout');
    u = await newUser(A);
    const sid = (await api('GET', 'sessions.list', undefined, u)).sessions.find((s: any) => s.current)._id;
    expect(await reasonOf(u, () => api('POST', 'sessions.logout', { sessionId: sid }, A))).toBe('admin-logout');
    u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'users.update', { userId: u.userId, data: { password: 'trocada-pelo-admin-1' } }, A))).toBe('password-changed');

    u = await newUser(A);
    outbox.length = 0;
    await api('POST', 'users.forgotPassword', { email: `${u.username}@test.local` });
    await sleep(50);
    const link = /reset-password#token=([A-Za-z0-9_-]+)/.exec(outbox[0].text)![1];
    expect(await reasonOf(u, () => api('POST', 'users.resetPassword', { token: link, password: 'senha-redefinida-1' }))).toBe('password-changed');

    u = await newUser(A);
    const other = await login(u.username, PW);
    expect(await reasonOf(u, () => api('POST', 'sessions.logout.others', {}, other))).toBe('session-revoked');
    u = await newUser(A);
    const other2 = await login(u.username, PW);
    const first = (await api('GET', 'sessions.list', undefined, other2)).sessions.find((s: any) => !s.current)._id;
    expect(await reasonOf(u, () => api('POST', 'sessions.logout.me', { sessionId: first }, other2))).toBe('session-revoked');
    // O Sair (a própria sessão) não tem motivo: as outras abas do navegador só voltam para a tela de entrar.
    u = await newUser(A);
    expect(await reasonOf(u, () => api('POST', 'logout', {}, u))).toBeUndefined();
  });
});
