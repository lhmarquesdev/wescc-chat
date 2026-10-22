import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { many, one, query } from '../db/pool';
import { badRequest } from '../lib/errors';
import { getSetting, setSettingCache } from './settings';

// Web Push (RFC 8030) com VAPID (RFC 8292) e conteúdo cifrado em aes128gcm (RFC 8291), só com node:crypto.
// O navegador entrega a inscrição (endpoint + chaves); o servidor cifra a notificação e a envia ao serviço de push
// do navegador (Google, Mozilla, Apple, Microsoft), que a entrega ao dispositivo mesmo com o chat fechado.

const b64u = (buf: Buffer) => buf.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

// Só serviços de push conhecidos: o endpoint vem do navegador e não pode virar uma requisição para a rede interna.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: string) {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  // Origens extras só por variável de ambiente (testes ou serviço de push próprio).
  const extra = (process.env.PUSH_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(u.origin)) return true;
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// ---------- Chaves VAPID (geradas no primeiro uso e guardadas nas configurações) ----------

export async function ensureVapidKeys() {
  if (getSetting('Push_VAPID_Public_Key') && getSetting('Push_VAPID_Private_Key')) return;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  // As duas chaves num só comando: se outra instância gerou ao mesmo tempo, fica o par dela.
  await query(
    `INSERT INTO settings (id, value, updated_at) VALUES ('Push_VAPID_Public_Key', $1, now()), ('Push_VAPID_Private_Key', $2, now()) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(b64u(ecdh.getPublicKey())), JSON.stringify(b64u(ecdh.getPrivateKey()))],
  );
  for (const r of await many(`SELECT id, value FROM settings WHERE id IN ('Push_VAPID_Public_Key', 'Push_VAPID_Private_Key')`)) setSettingCache(r.id, r.value);
}

function vapidPrivateKey(publicKey: Buffer, privateKey: Buffer) {
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)), d: b64u(privateKey) },
    format: 'jwk',
  });
}

export function vapidAuthorization(endpoint: string, now = Date.now()) {
  const pub = fromB64u(getSetting<string>('Push_VAPID_Public_Key'));
  const priv = fromB64u(getSetting<string>('Push_VAPID_Private_Key'));
  const from = String(getSetting('From_Email') || 'chat@localhost');
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: `mailto:${from}` })));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidPrivateKey(pub, priv), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${b64u(pub)}`;
}

// ---------- Cifragem aes128gcm (RFC 8291) ----------

export function encryptPayload(payload: Buffer, p256dh: string, auth: string, salt = crypto.randomBytes(16)) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw badRequest('error-invalid-push-subscription', 'Inscrição de push inválida.');
  // Par de chaves efêmero, um por mensagem.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // Um único registro: conteúdo + delimitador 0x02 (último registro).
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---------- Inscrições ----------

const MAX_PER_USER = 10;

export async function saveSubscription(userId: string, sessionId: string, sub: any, userAgent?: string) {
  if (!getSetting('Push_enable')) throw badRequest('error-push-disabled', 'Notificações push desativadas.');
  if (sessionId.startsWith('pat:')) throw badRequest('error-push-session', 'Inscrição de push precisa de uma sessão de login.');
  const endpoint = String(sub?.endpoint ?? '');
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint)) throw badRequest('error-invalid-push-subscription', 'Serviço de push não reconhecido.');
  if (fromB64u(p256dh).length !== 65 || fromB64u(auth).length !== 16) throw badRequest('error-invalid-push-subscription', 'Inscrição de push inválida.');
  // O mesmo navegador trocando de conta leva a inscrição junto.
  await query(
    `INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, created_at = now()`,
    [endpoint, userId, sessionId, p256dh, auth, String(userAgent ?? '').slice(0, 300)],
  );
  await query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${MAX_PER_USER})`,
    [userId],
  );
}

export async function removeSubscription(userId: string, endpoint: string) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

// ---------- Envio ----------

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

function post(endpoint: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(endpoint);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { ...headers, 'content-length': String(body.length) }, timeout: 10_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function sendPushToSubscription(sub: { endpoint: string; p256dh: string; auth: string }, msg: PushMessage) {
  if (!isAllowedPushEndpoint(sub.endpoint)) return 410;
  const body = encryptPayload(Buffer.from(JSON.stringify(msg)), sub.p256dh, sub.auth);
  return post(
    sub.endpoint,
    {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: String(24 * 3600),
      urgency: 'high',
      ...(msg.tag ? { topic: crypto.createHash('sha256').update(msg.tag).digest('base64url').slice(0, 32) } : {}),
      authorization: vapidAuthorization(sub.endpoint),
    },
    body,
  );
}

// Envia para todos os dispositivos inscritos dos usuários; inscrições que o serviço diz não existirem mais são apagadas.
export async function sendPush(userIds: string[], msg: PushMessage) {
  if (!userIds.length || !getSetting('Push_enable') || !getSetting('Push_VAPID_Private_Key')) return;
  const subs = await many('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)', [userIds]);
  await Promise.all(
    subs.map(async (s) => {
      try {
        const status = await sendPushToSubscription(s, msg);
        if (status === 404 || status === 410) await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
        else if (status >= 200 && status < 300) await query('UPDATE push_subscriptions SET last_used_at = now() WHERE endpoint = $1', [s.endpoint]);
      } catch {
        // serviço de push fora do ar: tenta de novo na próxima mensagem
      }
    }),
  );
}

export async function pushInfo(userId: string) {
  const r = await one('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId]);
  return { enabled: !!getSetting('Push_enable'), publicKey: getSetting<string>('Push_VAPID_Public_Key') || null, devices: r.n };
}
