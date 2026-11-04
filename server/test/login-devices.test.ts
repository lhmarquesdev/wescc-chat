import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { totpCode } from '../src/lib/totp';
import { cleanupUserDevices, ipPrefix, readDeviceId } from '../src/services/loginDevices';
import { createSession } from '../src/services/users';
import { admin, api, enable2fa, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// E-mail de login em dispositivo novo: o primeiro dispositivo da conta nunca avisa; navegador novo avisa; programas
// sem navegador valem pelo programa e pela rede.

const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string; html?: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => (outbox.push(m), true),
}));

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0';
const PASS = 'senha-forte-1';

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

let seq = 0;
// Conta criada sem login: o primeiro login do teste é mesmo o primeiro.
async function account(extra: Record<string, unknown> = {}) {
  const username = `disp${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const r = await api('POST', 'users.create', { username, name: `Pessoa ${seq}`, email: `${username}@test.local`, password: PASS, ...extra }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
  return { id: r.user._id as string, username, email: `${username}@test.local` };
}

async function browserLogin(user: string, opts: { cookie?: string; ua?: string; code?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': opts.ua ?? CHROME };
  if (opts.cookie !== undefined) headers.cookie = `wescc_device=${opts.cookie}`;
  const res = await fetch(urlOf('/api/v1/login'), { method: 'POST', headers, body: JSON.stringify({ user, password: PASS, ...(opts.code ? { code: opts.code } : {}) }) });
  const json: any = await res.json();
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('wescc_device=')) ?? '';
  const device = /^wescc_device=([^;]*)/.exec(setCookie)?.[1];
  const auth: Auth | undefined = json.data ? { userId: json.data.userId, authToken: json.data.authToken, username: json.data.me.username } : undefined;
  return { json, auth, device, setCookie };
}

const devices = async (userId: string) => (await pool.query('SELECT * FROM user_devices WHERE user_id = $1 ORDER BY first_seen', [userId])).rows;
const auditsOf = async (userId: string) => (await pool.query(`SELECT * FROM audit_log WHERE action = 'auth.login.newDevice' AND target->>'userId' = $1 ORDER BY created_at`, [userId])).rows;
// O aviso sai em segundo plano depois do login: espera a auditoria dele (ou um instante, quando não deve haver aviso).
const announced = (userId: string, n: number) => vi.waitFor(async () => expect(await auditsOf(userId)).toHaveLength(n), { timeout: 3000, interval: 25 });
const settle = () => sleep(150);

describe('login em dispositivo novo', () => {
  it('primeiro login não avisa; o mesmo navegador também não', async () => {
    const u = await account();
    const first = await browserLogin(u.username);
    expect(first.auth).toBeTruthy();
    expect(first.device).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    await settle();
    expect(outbox).toHaveLength(0);
    expect(await devices(u.id)).toHaveLength(1);
    expect(await auditsOf(u.id)).toHaveLength(0);
    const again = await browserLogin(u.username, { cookie: first.device });
    expect(again.device).toBe(first.device);
    await settle();
    expect(outbox).toHaveLength(0);
    expect(await devices(u.id)).toHaveLength(1);
  });

  it('navegador novo avisa com data, IP, navegador e sistema', async () => {
    const u = await account({ name: 'Rita <b>Reis</b>' });
    await browserLogin(u.username);
    const other = await browserLogin(u.username);
    expect(other.auth).toBeTruthy();
    await announced(u.id, 1);
    expect(outbox).toHaveLength(1);
    const mail = outbox[0];
    expect(mail.to).toBe(u.email);
    expect(mail.subject).toMatch(/^\[.+\] Novo acesso à sua conta$/);
    expect(mail.text).toContain('Olá, Rita <b>Reis</b>.');
    expect(mail.text).toContain('Dispositivo: Chrome em Windows');
    expect(mail.text).toContain('Endereço IP: 127.0.0.1');
    expect(mail.text).toMatch(/Quando: \d{1,2} de [a-zç]+ de \d{4}/);
    expect(mail.text).toContain('https://chat.empresa.com.br/account/devices');
    expect(mail.html).toContain('Rita &#60;b&#62;Reis&#60;/b&#62;');
    expect(mail.html).not.toContain('Rita <b>');
    expect(mail.html).toContain('Ver meus dispositivos');
    expect(await devices(u.id)).toHaveLength(2);
    // Outro navegador no mesmo computador também é novo.
    await browserLogin(u.username, { ua: FIREFOX_MAC });
    await announced(u.id, 2);
    expect(outbox[1].text).toContain('Dispositivo: Firefox em macOS');
  });

  it('configuração desligada: sem e-mail, mas o dispositivo fica conhecido', async () => {
    const u = await account();
    await browserLogin(u.username);
    await api('POST', 'settings', { settings: { Device_Management_Enable_Login_Emails: false } }, A);
    let quiet: string | undefined;
    try {
      quiet = (await browserLogin(u.username)).device;
      await announced(u.id, 1);
      expect(outbox).toHaveLength(0);
      expect((await auditsOf(u.id))[0].data).toMatchObject({ emailed: false });
      expect(await devices(u.id)).toHaveLength(2);
    } finally {
      await api('POST', 'settings', { settings: { Device_Management_Enable_Login_Emails: true } }, A);
    }
    // Ligado de novo: o dispositivo anotado com o aviso desligado já é conhecido.
    await browserLogin(u.username, { cookie: quiet });
    await settle();
    expect(outbox).toHaveLength(0);
    await browserLogin(u.username);
    await announced(u.id, 2);
    expect(outbox).toHaveLength(1);
  });

  it('cookie seguro', async () => {
    const u = await account();
    const r = await browserLogin(u.username);
    const attrs = r.setCookie.split(';').map((s) => s.trim());
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api/v1/login', 'Max-Age=34560000', 'Secure']));
    // Valor inválido no cookie: dispositivo novo, e um id novo no lugar.
    const bad = await browserLogin(u.username, { cookie: '<script>' });
    expect(bad.device).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    await announced(u.id, 1);
    expect(outbox).toHaveLength(1);
    // Sem https no Site_Url, o cookie vai sem Secure (desenvolvimento).
    await api('POST', 'settings', { settings: { Site_Url: 'http://localhost:3000' } }, A);
    try {
      const plain = await browserLogin(u.username, { cookie: r.device });
      expect(plain.setCookie).not.toContain('Secure');
    } finally {
      await api('POST', 'settings', { settings: { Site_Url: 'https://chat.empresa.com.br' } }, A);
    }
  });

  it('programas sem navegador: mesmo programa e rede não repetem', async () => {
    const u = await account();
    await browserLogin(u.username);
    await browserLogin(u.username, { ua: 'curl/8.5.0' });
    await announced(u.id, 1);
    await browserLogin(u.username, { ua: 'curl/8.5.0' });
    await settle();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toContain('Dispositivo: Navegador ou aplicativo desconhecido\n');
    expect(outbox[0].text).not.toContain('Outro em Desconhecido');
    await browserLogin(u.username, { ua: 'python-requests/2.32' });
    await announced(u.id, 2);
    expect(outbox).toHaveLength(2);
    expect(await devices(u.id)).toHaveLength(3);
  });

  it('programa que guarda cookie: o segundo login, já com o cookie, não é dispositivo novo', async () => {
    const u = await account();
    const UA = 'python-requests/2.32.3';
    // Primeiro dispositivo da conta: anotado pelo programa e pela rede, sem e-mail.
    const first = await browserLogin(u.username, { ua: UA });
    expect(first.device).toBeTruthy();
    // requests.Session, cookie jar do Java/Node, app nativo: devolvem o cookie que o servidor mandou.
    const second = await browserLogin(u.username, { ua: UA, cookie: first.device });
    expect(second.auth).toBeTruthy();
    const third = await browserLogin(u.username, { ua: UA, cookie: second.device });
    expect(third.auth).toBeTruthy();
    await settle();
    expect(outbox).toHaveLength(0);
    expect(await auditsOf(u.id)).toHaveLength(0);
    // Outro programa com um cookie que a conta nunca viu continua sendo novo.
    await browserLogin(u.username, { ua: 'Java/17.0.2', cookie: 'c'.repeat(32) });
    await announced(u.id, 1);
    expect(outbox).toHaveLength(1);
  });

  it('a sessão nova fica marcada', async () => {
    const u = await account();
    const a = await browserLogin(u.username);
    const b = await browserLogin(u.username, { ua: FIREFOX_MAC });
    const a2 = await browserLogin(u.username, { cookie: a.device });
    const list = await api('GET', 'sessions.list', {}, b.auth);
    const flagged = list.sessions.filter((s: any) => s.device?.newDevice === true);
    expect(list.sessions).toHaveLength(3);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].device).toMatchObject({ browser: 'Firefox', os: 'macOS' });
    expect(flagged[0].current).toBe(true);
    expect(a2.auth).toBeTruthy();
    // Também na lista do administrador (Administração › Dispositivos).
    const all = await api('GET', 'sessions.list.all', { count: '200' }, A);
    expect(all.sessions.filter((s: any) => s.userId === u.id && s.device?.newDevice)).toHaveLength(1);
  });

  it('2FA: só depois do código', async () => {
    const u = await account();
    const first = await browserLogin(u.username);
    const secret = await enable2fa(first.auth!);
    const noCode = await browserLogin(u.username);
    expect(noCode.json.error).toBe('totp-required');
    expect(noCode.setCookie).toBe('');
    await settle();
    expect(await devices(u.id)).toHaveLength(1);
    expect(outbox).toHaveLength(0);
    const ok = await browserLogin(u.username, { code: totpCode(secret) });
    expect(ok.auth).toBeTruthy();
    await announced(u.id, 1);
    expect(outbox).toHaveLength(1);
    expect(await devices(u.id)).toHaveLength(2);
  });

  it('SSO usa a mesma regra', async () => {
    const u = await account();
    await browserLogin(u.username);
    const s1 = await createSession(u.id, { userAgent: CHROME, ip: '10.0.0.12', deviceId: undefined });
    await announced(u.id, 1);
    const s2 = await createSession(u.id, { userAgent: CHROME, ip: '10.0.0.12', deviceId: undefined });
    await announced(u.id, 2);
    expect(outbox).toHaveLength(2);
    expect(outbox[0].text).toContain('Endereço IP: 10.0.0.12');
    expect(s1.deviceCookie).not.toBe(s2.deviceCookie);
    const id = readDeviceId(s1.deviceCookie.split(';')[0]);
    expect(id).toBeTruthy();
    await createSession(u.id, { userAgent: CHROME, ip: '10.0.0.99', deviceId: id });
    await settle();
    expect(outbox).toHaveLength(2);
    // Sem IP conhecido: "desconhecido".
    await createSession(u.id, { userAgent: FIREFOX_MAC });
    await announced(u.id, 3);
    expect(outbox[2].text).toContain('Endereço IP: desconhecido');
  });

  it('sem e-mail ou robô: nada sai', async () => {
    const semEmail = await account();
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [semEmail.id]);
    const bot = await account();
    await pool.query(`UPDATE users SET type = 'bot' WHERE id = $1`, [bot.id]);
    for (const u of [semEmail, bot]) {
      await browserLogin(u.username);
      await browserLogin(u.username);
      await announced(u.id, 1);
      expect((await auditsOf(u.id))[0].data).toMatchObject({ emailed: false });
      expect(await devices(u.id)).toHaveLength(2);
    }
    expect(outbox).toHaveLength(0);
  });

  it('auditoria', async () => {
    const u = await account();
    await browserLogin(u.username);
    const b = await browserLogin(u.username, { ua: FIREFOX_MAC });
    await announced(u.id, 1);
    const [row] = await auditsOf(u.id);
    expect(row).toMatchObject({ actor_id: u.id, actor_username: u.username, ip: '127.0.0.1' });
    expect(row.data).toEqual({ browser: 'Firefox', os: 'macOS', emailed: true });
    const sessions = await api('GET', 'sessions.list', {}, b.auth);
    expect(row.target).toEqual({ sessionId: sessions.sessions.find((s: any) => s.current)._id, userId: u.id });
  });

  it('limpeza: dispositivos com mais de 400 dias saem', async () => {
    const u = await account();
    await browserLogin(u.username);
    await browserLogin(u.username, { ua: FIREFOX_MAC });
    const [old, recent] = await devices(u.id);
    await pool.query(`UPDATE user_devices SET last_seen = now() - interval '401 days' WHERE user_id = $1 AND device_hash = $2`, [u.id, old.device_hash]);
    await pool.query(`UPDATE user_devices SET last_seen = now() - interval '399 days' WHERE user_id = $1 AND device_hash = $2`, [u.id, recent.device_hash]);
    await cleanupUserDevices();
    expect((await devices(u.id)).map((d) => d.device_hash)).toEqual([recent.device_hash]);
  });

  it('cada conta guarda até 100 dispositivos', async () => {
    const u = await account();
    await pool.query(
      `INSERT INTO user_devices (user_id, device_hash, device, last_seen)
       SELECT $1, 'velho' || g, '{}'::jsonb, now() - make_interval(days => g) FROM generate_series(1, 100) g`,
      [u.id],
    );
    await browserLogin(u.username);
    const rows = await devices(u.id);
    expect(rows).toHaveLength(100);
    expect(rows.some((d) => d.device_hash === 'velho100')).toBe(false);
    expect(rows.some((d) => d.device_hash === 'velho1')).toBe(true);
    // Já havia dispositivos: o login avisa.
    await announced(u.id, 1);
  });
});

describe('regras do dispositivo', () => {
  it('prefixo da rede', () => {
    expect(ipPrefix('10.0.0.12')).toBe('10.0.0.0/24');
    expect(ipPrefix('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
    expect(ipPrefix('')).toBe('');
    expect(ipPrefix(undefined)).toBe('');
    expect(ipPrefix('não é ip')).toBe('');
  });

  it('id do cookie', () => {
    const id = 'a'.repeat(32);
    expect(readDeviceId(`rc_uid=x; wescc_device=${id}; outro=1`)).toBe(id);
    expect(readDeviceId(`wescc_device=${id}`)).toBe(id);
    expect(readDeviceId('wescc_device=<script>')).toBeUndefined();
    expect(readDeviceId('wescc_device=curto')).toBeUndefined();
    expect(readDeviceId(`xwescc_device=${id}`)).toBeUndefined();
    expect(readDeviceId(undefined)).toBeUndefined();
  });
});
