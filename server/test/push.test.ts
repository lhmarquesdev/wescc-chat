import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Serviço de push falso: guarda cada envio e responde com o código configurado.
const received: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
let replyStatus = 201;
let pushOrigin = '';
const pushServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(replyStatus).end();
  });
});

let A: Auth;
beforeAll(async () => {
  await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', () => r()));
  pushOrigin = `http://127.0.0.1:${(pushServer.address() as any).port}`;
  process.env.PUSH_EXTRA_ORIGINS = pushOrigin;
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(async () => {
  await stopServer();
  pushServer.close();
});
beforeEach(() => {
  received.length = 0;
  replyStatus = 201;
});

// Navegador falso: par de chaves e segredo de autenticação, como o PushManager gera.
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: crypto.randomBytes(16) };
}

const subscription = (endpoint: string, k: ReturnType<typeof browserKeys>) => ({ endpoint, keys: { p256dh: ecdhPublic(k), auth: k.auth.toString('base64url') } });
const ecdhPublic = (k: ReturnType<typeof browserKeys>) => k.ecdh.getPublicKey().toString('base64url');

// Decifra como o navegador (RFC 8291).
function decrypt(body: Buffer, k: ReturnType<typeof browserKeys>) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const secret = k.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, k.auth, Buffer.concat([Buffer.from('WebPush: info\0'), k.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

function verifyVapid(header: string, endpoint: string, publicKey: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  expect(m[2]).toBe(publicKey);
  const [h, c, s] = m[1].split('.');
  const pub = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  expect(claims.aud).toBe(new URL(endpoint).origin);
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
}

async function waitPush(n = 1) {
  for (let i = 0; i < 40 && received.length < n; i++) await sleep(50);
}

describe('Web Push', () => {
  it('recusa inscrições para endereços que não são serviços de push', async () => {
    const u = await newUser(A);
    const k = browserKeys();
    for (const endpoint of ['http://127.0.0.1:5432/x', 'https://evil.example/push', 'https://fcm.googleapis.com.evil.example/x', 'https://user@fcm.googleapis.com/x']) {
      const r = await api('POST', 'push.webSubscribe', { subscription: subscription(endpoint, k) }, u);
      expect(r.errorType).toBe('error-invalid-push-subscription');
    }
    expect((await api('POST', 'push.webSubscribe', { subscription: subscription('https://fcm.googleapis.com/fcm/send/abc', k) }, u)).success).toBe(true);
    expect((await api('POST', 'push.webSubscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'x', auth: 'y' } } }, u)).success).toBe(false);
  });

  it('envia a DM cifrada e assinada para quem está com o chat fechado', async () => {
    const u = await newUser(A);
    const k = browserKeys();
    const endpoint = `${pushOrigin}/push/${u.username}`;
    expect((await api('POST', 'push.webSubscribe', { subscription: subscription(endpoint, k) }, u)).success).toBe(true);
    const info = await api('GET', 'push.info', undefined, u);
    expect(info).toMatchObject({ enabled: true, devices: 1 });
    expect(Buffer.from(info.publicKey, 'base64url')).toHaveLength(65);

    const dm = await api('POST', 'im.create', { username: u.username }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'Reunião às 15h' } }, A);
    await waitPush();
    expect(received).toHaveLength(1);
    const p = received[0];
    expect(p.url).toBe(`/push/${u.username}`);
    expect(p.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(p.headers.ttl)).toBeGreaterThan(0);
    verifyVapid(String(p.headers.authorization), endpoint, info.publicKey);
    expect(decrypt(p.body, k)).toEqual({ title: 'admin', body: 'Reunião às 15h', url: `/direct/${dm.room._id}`, tag: dm.room._id });

    // Com conteúdo oculto, só o aviso genérico.
    await api('POST', 'settings', { settings: { Push_Privacy_Hide_Content: true } }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'segredo' } }, A);
    await waitPush(2);
    expect(decrypt(received[1].body, k).body).toBe('Você tem uma nova mensagem');
    await api('POST', 'settings', { settings: { Push_Privacy_Hide_Content: false } }, A);
  });

  it('não envia push para quem está com o chat aberto', async () => {
    const u = await newUser(A);
    await api('POST', 'push.webSubscribe', { subscription: subscription(`${pushOrigin}/push/aberto`, browserKeys()) }, u);
    const ws = connectWs(u);
    await ws.ready;
    const dm = await api('POST', 'im.create', { username: u.username }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi' } }, A);
    await ws.waitFor((e) => e.type === 'notification');
    await sleep(300);
    expect(received).toHaveLength(0);
    ws.close();
  });

  it('apaga a inscrição que o serviço diz não existir mais e a que pertence a uma sessão encerrada', async () => {
    const u = await newUser(A);
    const endpoint = `${pushOrigin}/push/expirada`;
    await api('POST', 'push.webSubscribe', { subscription: subscription(endpoint, browserKeys()) }, u);
    replyStatus = 410;
    const dm = await api('POST', 'im.create', { username: u.username }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi' } }, A);
    await waitPush();
    await sleep(100);
    expect((await pool.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [endpoint])).rowCount).toBe(0);

    await api('POST', 'push.webSubscribe', { subscription: subscription(`${pushOrigin}/push/logout`, browserKeys()) }, u);
    await api('POST', 'logout', {}, u);
    expect((await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [u.userId])).rowCount).toBe(0);
  });
});
