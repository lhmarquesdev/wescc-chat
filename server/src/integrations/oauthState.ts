import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool';
import { parseCookies } from '../api/http';
import { aadFor, decryptSecret, derivedKey, encryptSecret, noteKeyUse } from '../lib/secrets';
import { siteUrl } from '../services/sso';

// OAuth das integrações (conta pessoal do Jira, conta de serviço do Teams): state de uso único, preso à pessoa e a um
// cookie HttpOnly deste navegador. Os retornos (/integrations/*/callback) não têm sessão: a pessoa vem só do state.

export type OAuthPurpose = 'jira-user' | 'msteams-service';

export const OAUTH_COOKIE = 'wescc_int_oauth';
const TTL_SECONDS = 600;
const RETURN_PREFIXES = ['/account/', '/admin/integrations/'];
const DEFAULT_RETURN: Record<OAuthPurpose, string> = { 'jira-user': '/account/connected', 'msteams-service': '/admin/integrations/teams/conexao' };

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Falha no retorno: quem chamou redireciona para returnTo com ?integracao=erro&motivo=estado e não troca o código.
export class OAuthStateError extends Error {
  constructor(public returnTo: string) {
    super('Estado de OAuth inválido.');
  }
}

// Caminho do mesmo site, começando por /account/ ou /admin/integrations/.
export function safeReturnTo(raw: unknown, purpose: OAuthPurpose): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\r\n\t]/.test(s)) return DEFAULT_RETURN[purpose];
  try {
    const u = new URL(s, 'http://x');
    if (u.host !== 'x' || !RETURN_PREFIXES.some((p) => u.pathname.startsWith(p))) return DEFAULT_RETURN[purpose];
    return `${u.pathname}${u.search}`;
  } catch {
    return DEFAULT_RETURN[purpose];
  }
}

export function oauthRedirectTarget(returnTo: string, params: Record<string, string>): string {
  const u = new URL(returnTo, 'http://x');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return `${u.pathname}${u.search}`;
}

export const stateErrorTarget = (returnTo: string) => oauthRedirectTarget(returnTo, { integracao: 'erro', motivo: 'estado' });

function cookie(value: string, maxAge: number) {
  const secure = siteUrl().startsWith('https:') ? '; Secure' : '';
  return `${OAUTH_COOKIE}=${value}; Path=/integrations/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function appendCookie(reply: FastifyReply, value: string) {
  const prev = reply.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev.map(String) : prev ? [String(prev)] : [];
  reply.header('set-cookie', [...list.filter((c) => !c.startsWith(`${OAUTH_COOKIE}=`)), value]);
}

// O nonce sai da sessão: duas abas da mesma sessão têm o mesmo e as duas continuam válidas, sem ler o cookie, que
// o navegador só manda para /integrations/. Sem sessão ou sem chave, um nonce novo a cada início.
function browserNonce(sessionId: string | undefined): string {
  const key = sessionId ? derivedKey('oauth-browser') : null;
  if (!key || !sessionId) return crypto.randomBytes(32).toString('base64url');
  return crypto.createHmac('sha256', key).update(sessionId).digest('base64url');
}

// Grava o state e põe o cookie na resposta da chamada da API que inicia o OAuth (mesma origem).
export async function startOAuth(
  reply: FastifyReply,
  p: { purpose: OAuthPurpose; userId: string; redirectUri: string; returnTo: string; codeVerifier?: string },
): Promise<{ state: string }> {
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = browserNonce(reply.request?.ctx?.sessionId || undefined);
  const stateHash = sha(state);
  let verifier: string | null = null;
  if (p.codeVerifier) {
    verifier = encryptSecret(p.codeVerifier, aadFor.oauth(stateHash));
    await noteKeyUse(verifier);
  }
  await query(
    `INSERT INTO integration_oauth_states (state_hash, purpose, user_id, browser_hash, code_verifier, redirect_uri, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 second')`,
    [stateHash, p.purpose, p.userId, sha(nonce), verifier, p.redirectUri, safeReturnTo(p.returnTo, p.purpose), TTL_SECONDS],
  );
  appendCookie(reply, cookie(nonce, TTL_SECONDS));
  reply.header('cache-control', 'no-store');
  return { state };
}

// Confere o state (existe, não venceu, mesmo propósito, cookie deste navegador) e o apaga (uso único). Com reply, o
// cookie é apagado também. Qualquer diferença: OAuthStateError com o returnTo para o redirecionamento de erro.
export async function finishOAuth(
  req: FastifyRequest,
  purpose: OAuthPurpose,
  reply?: FastifyReply,
): Promise<{ userId: string; redirectUri: string; returnTo: string; codeVerifier?: string }> {
  const query_ = (req.query ?? {}) as Record<string, unknown>;
  const state = typeof query_.state === 'string' ? query_.state : '';
  const nonce = parseCookies(req.headers.cookie)[OAUTH_COOKIE] ?? '';
  if (reply) appendCookie(reply, cookie('', 0));
  if (!state || state.length > 200) throw new OAuthStateError(DEFAULT_RETURN[purpose]);
  const stateHash = sha(state);
  // Apaga primeiro: um state só serve uma vez, mesmo que a conferência falhe.
  const row = await one(`DELETE FROM integration_oauth_states WHERE state_hash = $1 RETURNING *`, [stateHash]);
  if (!row) throw new OAuthStateError(DEFAULT_RETURN[purpose]);
  const returnTo = safeReturnTo(row.return_to, purpose);
  const expired = new Date(row.expires_at).getTime() < Date.now();
  const want = Buffer.from(String(row.browser_hash ?? ''));
  const got = Buffer.from(nonce ? sha(nonce) : '');
  const sameBrowser = got.length === want.length && want.length > 0 && crypto.timingSafeEqual(got, want);
  if (row.purpose !== purpose || expired || !sameBrowser) throw new OAuthStateError(row.purpose === purpose ? returnTo : DEFAULT_RETURN[purpose]);
  let codeVerifier: string | undefined;
  if (row.code_verifier) {
    try {
      codeVerifier = decryptSecret(row.code_verifier, aadFor.oauth(stateHash));
    } catch {
      throw new OAuthStateError(returnTo);
    }
  }
  return { userId: row.user_id, redirectUri: row.redirect_uri, returnTo, ...(codeVerifier ? { codeVerifier } : {}) };
}

// PKCE (Microsoft): verifier e challenge S256.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
