import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, login, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Os e-mails ficam numa caixa de saída em memória em vez de irem para um servidor SMTP.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string; html?: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => (outbox.push(m), true),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Site_Url: 'https://chat.empresa.com.br' } }, A);
});
afterAll(() => stopServer());
beforeEach(() => {
  outbox.length = 0;
});

const tokenOf = (text: string) => /reset-password#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
const forgot = (email: string) => api('POST', 'users.forgotPassword', { email });
const reset = (token: string, password: string) => api('POST', 'users.resetPassword', { token, password });

describe('esqueci minha senha', () => {
  it('envia o link, troca a senha uma única vez e encerra as sessões', async () => {
    const u = await newUser(A);
    const email = `${u.username}@test.local`;
    expect((await forgot(email.toUpperCase())).success).toBe(true);
    await sleep(50);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(email);
    expect(outbox[0].text).toContain('https://chat.empresa.com.br/reset-password#token=');
    const token = tokenOf(outbox[0].text);

    // Senha fraca não gasta o link.
    expect((await reset(token, '123')).success).toBe(false);
    expect((await reset(token, 'senha-redefinida-1')).success).toBe(true);
    expect((await api('GET', 'me', undefined, u)).status).toBe(401);
    expect((await login(u.username, 'senha-redefinida-1')).userId).toBe(u.userId);
    // Link de uso único.
    expect((await reset(token, 'outra-senha-123')).errorType).toBe('error-invalid-token');
    await sleep(50);
    expect(outbox.some((m) => m.subject.includes('Sua senha foi alterada'))).toBe(true);
  });

  it('não revela se o e-mail existe e não serve para contas LDAP ou desativadas', async () => {
    expect((await forgot('ninguem@test.local')).success).toBe(true);
    const ldap = await newUser(A);
    await pool.query(`UPDATE users SET auth_source = 'ldap' WHERE id = $1`, [ldap.userId]);
    expect((await forgot(`${ldap.username}@test.local`)).success).toBe(true);
    const off = await newUser(A);
    await api('POST', 'users.update', { userId: off.userId, data: { active: false } }, A);
    expect((await forgot(`${off.username}@test.local`)).success).toBe(true);
    await sleep(50);
    expect(outbox).toHaveLength(0);
  });

  it('só o link mais recente vale, expira e respeita a configuração', async () => {
    const u = await newUser(A);
    const email = `${u.username}@test.local`;
    await forgot(email);
    // Novo pedido logo em seguida é ignorado (um a cada 2 minutos).
    await forgot(email);
    await sleep(50);
    expect(outbox).toHaveLength(1);
    const first = tokenOf(outbox[0].text);
    await pool.query(`UPDATE password_resets SET created_at = now() - interval '3 minutes' WHERE user_id = $1`, [u.userId]);
    await forgot(email);
    await sleep(50);
    const second = tokenOf(outbox[1].text);
    expect((await reset(first, 'senha-redefinida-2')).errorType).toBe('error-invalid-token');
    await pool.query(`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.userId]);
    expect((await reset(second, 'senha-redefinida-2')).errorType).toBe('error-invalid-token');

    await api('POST', 'settings', { settings: { Accounts_PasswordReset: false } }, A);
    expect((await forgot(email)).status).toBe(403);
    await api('POST', 'settings', { settings: { Accounts_PasswordReset: true } }, A);
  });

  it('o 2FA continua sendo pedido depois de redefinir a senha', async () => {
    const { enable2fa } = await import('./helpers');
    const u = await newUser(A);
    await enable2fa(u);
    await forgot(`${u.username}@test.local`);
    await sleep(50);
    expect((await reset(tokenOf(outbox[0].text), 'senha-redefinida-3')).success).toBe(true);
    const r = await api('POST', 'login', { user: u.username, password: 'senha-redefinida-3' });
    expect(r.errorType).toBe('totp-required');
  });
});
