import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { sha256 } from '../src/lib/ids';
import { totpCode } from '../src/lib/totp';
import { getSetting, loadSettings } from '../src/services/settings';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

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
});

describe('troca de senha', () => {
  it('a senha nova precisa ser diferente da atual (troca obrigatória e Minha conta); o administrador define qualquer uma', async () => {
    const r = await api('POST', 'users.create', { username: `prov${Date.now()}`, name: 'Prov', email: `prov${Date.now()}@test.local`, password: 'Provisoria123', requirePasswordChange: true }, A);
    const forced = await login(r.user.username, 'Provisoria123');
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
