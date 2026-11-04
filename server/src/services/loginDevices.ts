// E-mail de login em dispositivo novo (Device_Management_Enable_Login_Emails).
//
// Cada navegador recebe um cookie HttpOnly (wescc_device, só no caminho do login, 400 dias) com um id aleatório; a conta
// guarda o hash dele em user_devices. Programas que não são navegador (scripts, curl) quase nunca guardam cookie: valem
// o programa e a rede (o hash do User-Agent com o prefixo do IP), para um script que entra toda hora não mandar um
// e-mail a cada vez; o que guarda cookie passa a valer pelo cookie sem contar como novo. As sessões não servem para
// isso: somem no logout e ao vencer.
//
// Nunca no primeiro dispositivo da conta: se ela não tinha nenhum, o dispositivo é anotado e nada sai. Isso também vale
// para quem já usava o chat antes desta versão (nenhuma conta recebe uma leva de e-mails). Os dispositivos são anotados
// sempre, mesmo com o aviso desligado: ligar depois não dispara e-mails para todo mundo.
import net from 'node:net';
import { deviceLabel } from '@shared/devices';
import { one, query } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';
import { audit } from './audit';
import { formatLong } from './exportRender';
import { getSetting } from './settings';
import { cookieAttrs, siteUrl } from './sso';

export const DEVICE_COOKIE = 'wescc_device';
const DEVICE_RE = /^[A-Za-z0-9_-]{20,64}$/;
const COOKIE_DAYS = 400;
const KEEP_PER_USER = 100;

export interface ParsedDevice {
  browser: string;
  os: string;
  name: string;
}

// O id do cookie, se veio e tem o formato certo (qualquer outra coisa conta como dispositivo novo).
export function readDeviceId(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== DEVICE_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    return DEVICE_RE.test(v) ? v : undefined;
  }
  return undefined;
}

export const deviceCookieHeader = (id: string) => `${DEVICE_COOKIE}=${id}; ${cookieAttrs(COOKIE_DAYS * 86400)}`;

// A rede de onde veio o login: IPv4 /24 (também ::ffff:a.b.c.d), IPv6 /48; vazio sem IP.
export function ipPrefix(ip?: string): string {
  if (!ip) return '';
  const v4 = ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(ip)) {
    // Expande o "::" para pegar os três primeiros grupos.
    const [head, tail = ''] = ip.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return `${groups.slice(0, 3).map((g) => g || '0').join(':')}::/48`;
  }
  return '';
}

const SCRIPT_BROWSERS = new Set(['API', 'Outro']);

export async function rememberLoginDevice(userId: string, info: { deviceId?: string; userAgent?: string; ip?: string }, parsed: ParsedDevice): Promise<{ deviceId: string; isNew: boolean }> {
  const known = info.deviceId && DEVICE_RE.test(info.deviceId) ? info.deviceId : undefined;
  const deviceId = known ?? randomToken(24);
  const script = SCRIPT_BROWSERS.has(parsed.browser);
  const programHash = sha256(`u:${info.userAgent ?? ''}|${ipPrefix(info.ip)}`);
  const hash = known || !script ? sha256(`d:${deviceId}`) : programHash;
  // Programa que guarda cookie (requests.Session, app nativo): o primeiro login veio sem cookie e ficou anotado pelo
  // programa e pela rede; o segundo traz o cookie e vale como conhecido se qualquer um dos dois já estava anotado. Daí
  // em diante o cookie basta, mesmo se a rede mudar.
  const alias = known && script ? programHash : null;
  const r = await one<{ inserted: boolean; n: number; alias: boolean }>(
    `WITH prior AS (SELECT count(*)::int AS n, COALESCE(bool_or(device_hash = $5::text), false) AS alias FROM user_devices WHERE user_id = $1),
     up AS (
       INSERT INTO user_devices (user_id, device_hash, device, last_ip) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = now(), last_ip = EXCLUDED.last_ip, device = EXCLUDED.device
       RETURNING (xmax = 0) AS inserted)
     SELECT up.inserted, prior.n, prior.alias FROM up, prior`,
    [userId, hash, JSON.stringify({ browser: parsed.browser, os: parsed.os, name: parsed.name }), info.ip ?? null, alias],
  );
  const inserted = !!r?.inserted;
  if (inserted) {
    // Os 100 mais recentes de cada conta (cookies apagados toda hora não enchem a tabela).
    await query(
      `DELETE FROM user_devices WHERE user_id = $1 AND device_hash NOT IN
         (SELECT device_hash FROM user_devices WHERE user_id = $1 ORDER BY last_seen DESC LIMIT $2)`,
      [userId, KEEP_PER_USER],
    );
  }
  return { deviceId, isNew: inserted && (r?.n ?? 0) > 0 && !r?.alias };
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// false sem enviar: aviso desligado, conta sem e-mail, robô ou sem SMTP configurado.
export async function sendNewDeviceEmail(user: { email?: string | null; type?: string; name?: string; username: string }, parsed: ParsedDevice, ip: string | undefined, at: Date): Promise<boolean> {
  if (!getSetting<boolean>('Device_Management_Enable_Login_Emails') || !user.email || user.type === 'bot') return false;
  const { sendMail } = await import('./mailer');
  const site = getSetting<string>('Site_Name');
  const name = user.name || user.username;
  const when = formatLong(at);
  const device = deviceLabel(parsed);
  const where = ip || 'desconhecido';
  const link = `${siteUrl()}/account/devices`;
  const text =
    `Olá, ${name}.\n\nSua conta no ${site} acabou de ser acessada por um dispositivo que ainda não tínhamos visto:\n\n` +
    `Quando: ${when}\nDispositivo: ${device}\nEndereço IP: ${where}\n\n` +
    `Se foi você, não precisa fazer nada.\n` +
    `Se não foi você, encerre essa sessão agora em Minha conta › Dispositivos e troque a sua senha em Minha conta › Segurança:\n${link}`;
  const html =
    `<p>Olá, ${escapeHtml(name)}.</p><p>Sua conta no ${escapeHtml(site)} acabou de ser acessada por um dispositivo que ainda não tínhamos visto:</p>` +
    `<p><b>Quando:</b> ${escapeHtml(when)}<br><b>Dispositivo:</b> ${escapeHtml(device)}<br><b>Endereço IP:</b> ${escapeHtml(where)}</p>` +
    `<p>Se foi você, não precisa fazer nada.</p><p>Se não foi você, encerre essa sessão agora em Minha conta › Dispositivos e troque a sua senha em Minha conta › Segurança.</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d74f5;color:#fff;border-radius:6px;text-decoration:none">Ver meus dispositivos</a></p>`;
  return sendMail({ to: user.email, subject: `[${site}] Novo acesso à sua conta`, text, html }).catch(() => false);
}

// Depois do login (em segundo plano: o tempo de resposta do login não revela nada): e-mail e auditoria.
export async function announceNewDevice(userId: string, parsed: ParsedDevice, ip: string | undefined, sessionId: string) {
  const user = await one('SELECT id, username, name, email, type FROM users WHERE id = $1', [userId]);
  if (!user) return;
  const emailed = await sendNewDeviceEmail(user, parsed, ip, new Date());
  await audit({ id: user.id, username: user.username, ip }, 'auth.login.newDevice', { sessionId, userId }, { browser: parsed.browser, os: parsed.os, emailed });
}

// Limpeza (a cada minuto, trava 727101): dispositivos sem login há mais tempo que o cookie dura.
export async function cleanupUserDevices() {
  await query(`DELETE FROM user_devices WHERE last_seen < now() - make_interval(days => $1)`, [COOKIE_DAYS]);
}
