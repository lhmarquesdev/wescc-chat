import { one, query } from '../db/pool';
import { randomToken, sha256 } from '../lib/ids';
import { getSetting } from './settings';

// Base comum do login único (SAML e OAuth): ao fim do fluxo o navegador recebe uma credencial de
// uso único, trocada por uma sessão em POST /api/v1/login { saml|oauth: true, credentialToken }.

export type SsoMethod = 'saml' | 'oauth';

const CREDENTIAL_TTL_SEC = 60;
// Cookie que liga a credencial ao navegador que concluiu o login (contra CSRF de login).
export const SSO_BROWSER_COOKIE = 'wescc_sso';
const BROWSER_COOKIE_PATH = '/api/v1/login';

export function siteUrl() {
  return String(getSetting('Site_Url') || 'http://localhost:3000').replace(/\/+$/, '');
}

function cookieAttrs(maxAge: number) {
  const secure = siteUrl().startsWith('https:') ? '; Secure' : '';
  return `Path=${BROWSER_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearSsoBrowserCookie = () => `${SSO_BROWSER_COOKIE}=; ${cookieAttrs(0)}`;

// Devolve a credencial (vai na URL) e o cookie a enviar junto com o redirecionamento.
export async function issueSsoCredential(userId: string, method: SsoMethod) {
  const token = randomToken();
  const nonce = randomToken(24);
  await query('DELETE FROM sso_credentials WHERE expires_at < now()');
  await query(`INSERT INTO sso_credentials (token_hash, user_id, method, browser_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`, [
    sha256(token),
    userId,
    method,
    sha256(nonce),
    CREDENTIAL_TTL_SEC,
  ]);
  return { token, cookie: `${SSO_BROWSER_COOKIE}=${nonce}; ${cookieAttrs(CREDENTIAL_TTL_SEC)}` };
}

// Usa (e apaga) a credencial; só vale para o mesmo método e no navegador que a recebeu.
export async function consumeSsoCredential(token: string, method: SsoMethod, browserNonce: string | undefined) {
  const r = await one('DELETE FROM sso_credentials WHERE token_hash = $1 RETURNING user_id, method, browser_hash, expires_at', [sha256(String(token))]);
  if (!r || r.method !== method || new Date(r.expires_at).getTime() < Date.now()) return null;
  if (!browserNonce || !r.browser_hash || sha256(browserNonce) !== r.browser_hash) return null;
  return one('SELECT * FROM users WHERE id = $1', [r.user_id]);
}

// Só aceita voltar para caminhos internos (nada de //host, /\host, URLs absolutas ou caracteres de controle).
export function safeRedirect(v: unknown, fallback = '/home') {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.length > 2048 || /[\\\x00-\x1f\x7f]/.test(s)) return fallback;
  try {
    return new URL(s, 'http://local.invalid').origin === 'http://local.invalid' ? s : fallback;
  } catch {
    return fallback;
  }
}

export function ssoLoginUrl(method: SsoMethod, token: string, next: string) {
  return `/login?${method}=${encodeURIComponent(token)}&next=${encodeURIComponent(safeRedirect(next))}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function ssoErrorPage(message: string, title = 'Não foi possível entrar com SSO') {
  return (
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Falha no login</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;line-height:1.5"><h2>${esc(title)}</h2><p>${esc(message)}</p>` +
    `<p><a href="/login">Voltar ao login</a></p></body></html>`
  );
}
