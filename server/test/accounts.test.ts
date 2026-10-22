import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, enable2fa, login, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

describe('contas', () => {
  it('troca de senha obrigatória não pede a senha atual de novo', async () => {
    const r = await api('POST', 'users.create', { username: 'provisoria', name: 'P', email: 'p@test.local', password: 'senha-provisoria-1', requirePasswordChange: true }, A);
    expect(r.success).toBe(true);
    const u = await login('provisoria', 'senha-provisoria-1');
    expect((await api('GET', 'me', undefined, u)).requirePasswordChange).toBe(true);
    const ch = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: 'senha-nova-123' } }, u);
    expect(ch.success).toBe(true);
    const me = await api('GET', 'me', undefined, await login('provisoria', 'senha-nova-123'));
    expect(me.requirePasswordChange).toBe(false);
    // Fora da troca obrigatória a senha atual continua sendo exigida.
    const again = await api('POST', 'users.updateOwnBasicInfo', { data: { newPassword: 'outra-senha-123' } }, u);
    expect(again.success).toBe(false);
  });

  it('2FA obrigatório aparece no me (configuração geral ou papel)', async () => {
    // O admin também tem o papel "user": com 2FA próprio ele continua podendo mexer nas configurações.
    await enable2fa(A);
    const u = await newUser(A);
    expect((await api('GET', 'me', undefined, u)).require2faSetup).toBe(false);
    await api('POST', 'roles.update', { roleId: 'user', mandatory2fa: true }, A);
    expect((await api('GET', 'me', undefined, u)).require2faSetup).toBe(true);
    await api('POST', 'roles.update', { roleId: 'user', mandatory2fa: false }, A);
    await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: true } }, A);
    expect((await api('GET', 'me', undefined, u)).require2faSetup).toBe(true);
    await api('POST', 'settings', { settings: { Accounts_TwoFactorAuthentication_Enforce: false } }, A);
  });
});
