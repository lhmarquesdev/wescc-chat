import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { many, one, query } from '../db/pool';
import { ApiError } from '../lib/errors';
import { newId, randomToken, sha256 } from '../lib/ids';
import { audit } from '../services/audit';
import { getSetting } from '../services/settings';
import { callbackUrl, effectiveEndpoints, effectiveFieldMap, effectiveScope, microsoftMultiTenant } from './providers';

// Fluxo authorization code + PKCE (S256): /oauth/:id/login guarda state e verificador no Postgres e
// redireciona ao provedor; /oauth/:id/callback valida o state (uso único, mesmo navegador), troca o
// código pelo token, lê a identidade e cria ou atualiza o usuário local.

const STATE_TTL_MIN = 10;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE = 1024 * 1024;
const MAX_AVATAR = 5 * 1024 * 1024;
const UA = 'Wescc-Chat-OAuth';
export const BROWSER_COOKIE = 'wescc_oauth';

const fail = (status: number, type: string, msg: string) => new ApiError(status, type, msg);
// Texto vindo do provedor, reduzido antes de aparecer em mensagens.
const short = (v: unknown) => String(v ?? '').replace(/[^\w .:-]/g, '').slice(0, 120);

export async function startLogin(p: any, redirect: string, browserNonce: string) {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  await query('DELETE FROM oauth_states WHERE expires_at < now()');
  await query(
    `INSERT INTO oauth_states (state_hash, provider_id, browser_hash, code_verifier, redirect, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))`,
    [sha256(state), p.id, sha256(browserNonce), verifier, redirect, STATE_TTL_MIN],
  );
  const url = new URL(effectiveEndpoints(p).authorizeUrl);
  const scope = effectiveScope(p);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.client_id);
  url.searchParams.set('redirect_uri', callbackUrl(p.id));
  if (scope) url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export const stateTtlSeconds = STATE_TTL_MIN * 60;

// O state é apagado ao ser lido: vale uma vez, só para o provedor e o navegador que o criaram.
export async function consumeState(providerId: string, state: string, browserNonce: string | undefined) {
  const r = await one('DELETE FROM oauth_states WHERE state_hash = $1 RETURNING *', [sha256(state)]);
  if (!r || r.provider_id !== providerId || new Date(r.expires_at).getTime() < Date.now()) {
    throw fail(400, 'error-oauth-state', 'O pedido de login expirou ou já foi usado. Tente entrar novamente.');
  }
  if (!browserNonce || sha256(browserNonce) !== r.browser_hash) {
    throw fail(400, 'error-oauth-browser', 'O login foi iniciado em outro navegador ou os cookies estão bloqueados. Tente entrar novamente.');
  }
  return r as { code_verifier: string; redirect: string };
}

// ---------- HTTP com o provedor ----------

async function readBody(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// JSON ou application/x-www-form-urlencoded (o GitHub responde assim sem Accept).
function parseResponse(text: string, contentType: string): any {
  const t = text.trim();
  if (!t) return {};
  if (/json/i.test(contentType) || t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (/x-www-form-urlencoded|text\/plain/i.test(contentType) || /^[\w.-]+=/.test(t)) return Object.fromEntries(new URLSearchParams(t));
  return null;
}

async function call(url: string, init: RequestInit, what: string) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e: any) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw fail(502, 'error-oauth-provider', timeout ? `O provedor demorou demais para responder (${what}).` : `Não foi possível falar com o provedor (${what}).`);
  }
  const body = await readBody(res, MAX_RESPONSE).catch(() => null);
  if (!body) throw fail(502, 'error-oauth-provider', `Resposta inválida do provedor (${what}).`);
  return { status: res.status, data: parseResponse(body.toString('utf8'), res.headers.get('content-type') ?? '') };
}

async function exchangeCode(p: any, code: string, verifier: string) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(p.id), client_id: p.client_id, code_verifier: verifier });
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA };
  if (p.token_auth === 'basic') {
    // RFC 6749 2.3.1: id e segredo codificados como formulário antes do Base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.authorization = `Basic ${Buffer.from(`${enc(p.client_id)}:${enc(p.client_secret)}`).toString('base64')}`;
  } else if (p.client_secret) {
    body.set('client_secret', p.client_secret);
  }
  const r = await call(effectiveEndpoints(p).tokenUrl, { method: 'POST', headers, body }, 'token');
  if (r.data?.error) throw fail(401, 'error-oauth-token', `O provedor recusou o código de autorização (${short(r.data.error)}).`);
  if (r.status >= 400 || !r.data?.access_token) throw fail(502, 'error-oauth-token', 'O provedor não devolveu um token de acesso.');
  return { accessToken: String(r.data.access_token), idToken: typeof r.data.id_token === 'string' ? r.data.id_token : undefined };
}

async function getJson(p: any, url: string, accessToken: string, what: string) {
  const u = new URL(url);
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': UA };
  if (p.token_sent_via === 'query') u.searchParams.set(p.access_token_param || 'access_token', accessToken);
  else headers.authorization = `Bearer ${accessToken}`;
  const r = await call(u.toString(), { headers }, what);
  if (r.status >= 400 || r.data === null) throw fail(502, 'error-oauth-identity', `O provedor não devolveu os dados do usuário (${what}, HTTP ${r.status}).`);
  return r.data;
}

// Claims do id_token. Ele chega direto do endpoint de token por TLS, então a assinatura pode ser
// dispensada (OpenID Connect Core 3.1.3.7); ainda assim conferimos audiência e validade.
function idTokenClaims(p: any, idToken?: string): Record<string, any> {
  if (!idToken) return {};
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
  if (!claims || typeof claims !== 'object') return {};
  if (claims.aud !== undefined && ![claims.aud].flat().includes(p.client_id)) throw fail(401, 'error-oauth-identity', 'O id_token não foi emitido para este cliente.');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() - 5 * 60_000) throw fail(401, 'error-oauth-identity', 'O id_token expirou.');
  return claims;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Microsoft: o id_token precisa dizer de qual diretório veio (tid/iss) e, com um diretório fixo por ID, ser dele.
function checkMicrosoftTenant(p: any, claims: Record<string, any>) {
  if (p.type !== 'microsoft') return;
  const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
  if (!GUID_RE.test(tid)) throw fail(401, 'error-oauth-identity', 'A Microsoft não informou o diretório (tid) no id_token. Confira se o escopo inclui "openid".');
  const iss = typeof claims.iss === 'string' ? claims.iss.toLowerCase() : '';
  if (iss && iss !== `https://login.microsoftonline.com/${tid}/v2.0` && iss !== `https://sts.windows.net/${tid}/`) throw fail(401, 'error-oauth-identity', 'O emissor do id_token não confere com o diretório.');
  const tenant = String(p.tenant ?? '').trim().toLowerCase();
  if (GUID_RE.test(tenant) && tid !== tenant) throw fail(403, 'error-oauth-tenant', 'Esta conta Microsoft pertence a outro diretório.');
}

export function getPath(obj: any, path: string): any {
  if (!path) return undefined;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const scalar = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? String(v).trim() : '') || undefined;
const isTrue = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Lista de valores de um claim: array, ou texto separado por vírgulas.
export function claimList(obj: any, path: string): string[] {
  const v = getPath(obj, path);
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
  return [...new Set(items.map((x) => (x && typeof x === 'object' ? scalar((x as any).name ?? (x as any).id) : scalar(x))).filter((x): x is string => !!x))];
}

export interface OAuthIdentity {
  id: string;
  username?: string;
  email?: string;
  // Verificado pelo provedor: permite vincular a uma conta existente.
  emailVerified: boolean;
  // Pode ser gravado na conta e conferido com os domínios permitidos (verificado, ou gerenciado por um diretório fixo).
  emailTrusted: boolean;
  name?: string;
  avatar?: string;
  raw: Record<string, any>;
}

export async function fetchIdentity(p: any, tokens: { accessToken: string; idToken?: string }): Promise<OAuthIdentity> {
  const ep = effectiveEndpoints(p);
  const claims = idTokenClaims(p, tokens.idToken);
  checkMicrosoftTenant(p, claims);
  let info: any = {};
  if (ep.identityUrl) {
    info = await getJson(p, ep.identityUrl, tokens.accessToken, 'identidade');
    if (p.identity_path) info = getPath(info, p.identity_path);
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw fail(502, 'error-oauth-identity', 'A resposta de identidade do provedor não tem o formato esperado.');
  } else if (!tokens.idToken) {
    throw fail(502, 'error-oauth-identity', 'O provedor não devolveu id_token e não há URL de identidade configurada.');
  }
  if (claims.sub !== undefined && info.sub !== undefined && String(claims.sub) !== String(info.sub)) {
    throw fail(401, 'error-oauth-identity', 'A identidade devolvida pelo provedor não confere com o id_token.');
  }
  const raw = { ...claims, ...info };
  const fm = effectiveFieldMap(p);
  const id = scalar(getPath(raw, fm.id));
  if (!id) throw fail(502, 'error-oauth-identity', `O provedor não informou o identificador do usuário (campo "${fm.id}").`);
  let email = scalar(getPath(raw, fm.email))?.toLowerCase();
  if (email && !EMAIL_RE.test(email)) email = undefined;
  let emailVerified = !!email && !!fm.emailVerified && isTrue(getPath(raw, fm.emailVerified));

  // GitHub: o e-mail confiável é o principal verificado de /user/emails.
  if (p.type === 'github' && ep.emailsUrl) {
    const list = await getJson(p, ep.emailsUrl, tokens.accessToken, 'e-mails').catch(() => []);
    const emails = (Array.isArray(list) ? list : []).filter((e: any) => e && typeof e.email === 'string');
    const primary = emails.find((e: any) => e.primary && e.verified === true);
    if (primary) {
      email = String(primary.email).toLowerCase();
      emailVerified = true;
    } else {
      emailVerified = !!email && emails.some((e: any) => e.verified === true && String(e.email).toLowerCase() === email);
    }
  }
  // Microsoft com diretório fixo: o e-mail vem do próprio diretório da empresa (só os administradores dele o alteram).
  const emailTrusted = !!email && (emailVerified || (p.type === 'microsoft' && !microsoftMultiTenant(p)));
  return {
    id,
    username: scalar(getPath(raw, fm.username)),
    email,
    emailVerified,
    emailTrusted,
    name: scalar(getPath(raw, fm.name)),
    avatar: scalar(getPath(raw, fm.avatar)),
    raw,
  };
}

// ---------- Usuário local ----------

async function usernameTaken(username: string) {
  return !!(await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]));
}

// Nome de usuário livre a partir da identidade; nunca reaproveita uma conta existente.
async function uniqueUsername(p: any, ident: OAuthIdentity) {
  let s = ident.username || ident.email || ident.name || '';
  if (s.includes('@')) s = s.split('@')[0];
  s = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 36);
  if (s.length < 2) s = `${p.id}-${ident.id}`.replace(/[^0-9a-zA-Z._-]+/g, '-').slice(0, 36);
  if (!(await usernameTaken(s))) return s;
  for (let n = 2; n < 50; n++) {
    const c = `${s}-${n}`;
    if (!(await usernameTaken(c))) return c;
  }
  return `${s.slice(0, 30)}-${newId(6).toLowerCase()}`;
}

function allowedDomain(email: string | undefined, verified: boolean) {
  const domains = String(getSetting('Accounts_AllowedDomainsList') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!domains.length) return true;
  return !!email && verified && domains.includes(email.split('@')[1]);
}

export async function upsertOAuthUser(p: any, ident: OAuthIdentity) {
  const { createUser, revokeAllSessions } = await import('../services/users');
  const externalId = `${p.id}:${ident.id}`;
  // O vínculo fica só em oauth_identities (apagado quando o provedor muda de servidor).
  let user = await one('SELECT u.* FROM oauth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = $1 AND i.subject = $2', [p.id, ident.id]);
  let linked = false;
  let created = false;

  if (!user && ident.email) {
    const byEmail = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [ident.email]);
    if (byEmail) {
      // Só vincula quando o provedor e a conta existente confirmaram o e-mail (evita contas "pré-sequestradas").
      if (!p.merge_users) throw fail(409, 'error-oauth-email-in-use', 'Já existe uma conta com este e-mail. Peça ao administrador para ativar a vinculação de contas neste provedor.');
      if (!ident.emailVerified) throw fail(409, 'error-oauth-email-not-verified', 'O provedor não confirmou este e-mail, então ele não pode ser vinculado à conta existente.');
      if (byEmail.type !== 'user') throw fail(409, 'error-oauth-email-in-use', 'O e-mail pertence a uma conta de bot ou aplicativo.');
      if (!byEmail.email_verified) {
        throw fail(409, 'error-oauth-email-not-verified', 'A conta existente com este e-mail não tem o e-mail confirmado, então não pode ser vinculada. Peça ao administrador para confirmar o e-mail da conta.');
      }
      user = byEmail;
      linked = true;
    }
  }

  // E-mail não confirmado pelo provedor (nem gerenciado por um diretório fixo) nunca é gravado na conta.
  const email = ident.emailTrusted ? ident.email : undefined;
  if (!user) {
    if (p.block_new_users) throw fail(403, 'error-oauth-no-user', 'Usuário não cadastrado. Fale com o administrador.');
    if (!allowedDomain(email, !!email)) throw fail(403, 'error-invalid-domain', 'Seu e-mail não pertence a um domínio permitido ou não foi confirmado pelo provedor.');
    const username = await uniqueUsername(p, ident);
    user = await createUser({
      username,
      name: ident.name || username,
      email: email ?? null,
      verified: !!email && ident.emailVerified,
      authSource: 'oauth',
      externalId,
      active: !getSetting('Accounts_ManuallyApproveNewUsers'),
      skipPasswordPolicy: true,
    });
    created = true;
  } else {
    // A conta vinculada mantém a origem (local, LDAP, SAML) e a senha; o vínculo fica em oauth_identities.
    const emailFree = email && !(await one('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, user.id]));
    user = await one(
      `UPDATE users SET name = COALESCE($2, name),
         email = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE email END,
         email_verified = CASE WHEN $3::text IS NULL THEN email_verified WHEN lower(email) = lower($3) THEN email_verified OR $4 ELSE $4 END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [user.id, ident.name || null, emailFree ? email : null, ident.emailVerified],
    );
  }

  const identity = await one(
    `INSERT INTO oauth_identities (provider_id, subject, user_id) VALUES ($1,$2,$3)
     ON CONFLICT (provider_id, subject) DO UPDATE SET user_id = EXCLUDED.user_id, last_login = now() RETURNING synced_roles`,
    [p.id, ident.id, user.id],
  );
  if (linked) {
    // Sessões abertas antes do vínculo saem; a nova sessão é criada depois.
    const revoked = await revokeAllSessions(user.id);
    await audit({ id: user.id, username: user.username }, 'auth.oauth.linked', { userId: user.id, provider: p.id }, { externalId, sessionsRevoked: revoked });
  }
  return { user, created, linked, syncedRoles: (identity?.synced_roles ?? []) as string[] };
}

// ---------- Papéis e canais (sincronizados a cada login) ----------

// Claims de papéis e grupos só valem com um diretório Microsoft fixo (em "common" qualquer diretório os define).
const tenantScopedClaimsOk = (p: any) => p.type !== 'microsoft' || !microsoftMultiTenant(p);

export async function syncRoles(p: any, user: any, ident: OAuthIdentity, previous: string[]) {
  if (!p.sync_roles || !p.roles_claim || !tenantScopedClaimsOk(p)) return user;
  const mapping = (p.role_mapping ?? {}) as Record<string, string | string[]>;
  // Só papéis do mapa explícito: os valores do claim podem ser criados pelo próprio usuário (ex.: grupos do GitLab).
  if (!Object.keys(mapping).length) return user;
  const values = claimList(ident.raw, p.roles_claim);
  const wanted = values.flatMap((v) => (Object.hasOwn(mapping, v) ? [mapping[v]].flat() : []));
  const existing = await many(`SELECT id FROM roles WHERE scope = 'Users' AND id = ANY($1)`, [wanted]);
  const granted = existing.map((r) => r.id as string).sort();

  let next: string[];
  if (p.merge_roles) {
    // Mantém os papéis não gerenciados pelo provedor (atribuídos à mão, por exemplo).
    const managed = new Set([...Object.values(mapping).flat(), ...previous]);
    next = [...user.roles.filter((r: string) => !managed.has(r)), ...granted];
  } else {
    next = [...granted];
  }
  next = [...new Set([...next, 'user'])];
  if (user.roles.includes('admin') && !next.includes('admin')) {
    const n = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active AND id <> $1`, [user.id]);
    if (!n.n) next.push('admin'); // nunca remove o último administrador
  }
  await query('UPDATE oauth_identities SET synced_roles = $3 WHERE provider_id = $1 AND subject = $2', [p.id, ident.id, granted]);
  const same = next.length === user.roles.length && next.every((r) => user.roles.includes(r));
  if (same) return user;
  const row = await one('UPDATE users SET roles = $2, updated_at = now() WHERE id = $1 RETURNING *', [user.id, next]);
  await audit({ id: user.id, username: user.username }, 'auth.oauth.roles', { userId: user.id, provider: p.id }, { before: user.roles, after: next });
  return row;
}

export async function mapChannels(p: any, user: any, ident: OAuthIdentity) {
  if (!p.map_channels || !tenantScopedClaimsOk(p)) return;
  const claim = p.groups_claim || p.roles_claim;
  if (!claim) return;
  const mapping = (p.channel_mapping ?? {}) as Record<string, string | string[]>;
  const names = new Set(claimList(ident.raw, claim).flatMap((g) => (Object.hasOwn(mapping, g) ? [mapping[g]].flat() : [])));
  if (!names.size) return;
  const { addUserToRoom, createRoom, getRoomByName } = await import('../services/rooms');
  for (const name of names) {
    try {
      let room = await getRoomByName(name);
      if (!room) room = await createRoom(null, { type: 'p', name, skipPermission: true });
      await addUserToRoom(room.id, user.id, { silent: true });
    } catch {
      // nome inválido ou sala arquivada: ignora este canal
    }
  }
}

// ---------- Foto do perfil ----------

const INTERNAL = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  INTERNAL.addSubnet(a, n, 'ipv4');
}
for (const [a, n] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) INTERNAL.addSubnet(a, n, 'ipv6');

// Loopback, redes privadas, link-local, multicast... (IPv4 mapeado em IPv6 também conta).
export function internalAddress(ip: string) {
  const family = net.isIP(ip);
  return !family || INTERNAL.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// Resolve o nome e recusa endereços internos no momento da conexão (vale também contra DNS rebinding).
const publicLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, options, (err, address: any, family?: number) => {
    if (err) return cb(err, address, family);
    const list: { address: string }[] = Array.isArray(address) ? address : [{ address }];
    if (!list.length || list.some((a) => internalAddress(a.address))) return cb(Object.assign(new Error('endereço interno'), { code: 'EINTERNAL' }), address, family);
    cb(null, address, family);
  });
};

function getOnce(u: URL, headers: Record<string, string>, internalOk: boolean, signal: AbortSignal) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!internalOk && net.isIP(host) && internalAddress(host)) return reject(new Error('endereço interno'));
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers, signal, lookup: internalOk ? undefined : publicLookup }, resolve);
    req.on('error', reject);
  });
}

async function readStream(res: http.IncomingMessage, max: number) {
  if (Number(res.headers['content-length'] ?? 0) > max) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) {
      res.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Só na criação ou no primeiro vínculo, e só se o usuário ainda não tiver foto. Cada redirecionamento é conferido:
// fora do próprio servidor do provedor, só https e só endereços públicos.
export async function importAvatar(p: any, user: any, ident: OAuthIdentity, accessToken: string) {
  if (!ident.avatar || user.avatar_etag) return;
  let u: URL;
  try {
    u = new URL(ident.avatar);
  } catch {
    return;
  }
  const ep = effectiveEndpoints(p);
  const origins = [ep.identityUrl, ep.tokenUrl, ep.authorizeUrl].filter(Boolean).map((x) => new URL(x).origin);
  const identityOrigin = ep.identityUrl ? new URL(ep.identityUrl).origin : '';
  const signal = AbortSignal.timeout(5_000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const own = origins.includes(u.origin);
      if (u.protocol !== 'https:' && !(own && u.protocol === 'http:')) return;
      const headers: Record<string, string> = { accept: 'image/*', 'user-agent': UA };
      // O token só vai para o host da identidade (ex.: Microsoft Graph).
      if (u.origin === identityOrigin) headers.authorization = `Bearer ${accessToken}`;
      const res = await getOnce(u, headers, own, signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        u = new URL(res.headers.location, u);
        continue;
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (status < 200 || status > 299 || !/^image\/(png|jpeg|gif|webp)$/.test(type)) {
        res.resume();
        return;
      }
      const data = await readStream(res, MAX_AVATAR);
      if (!data?.length) return;
      const { setAvatar } = await import('../services/users');
      await setAvatar(user.id, type, data);
      return;
    }
  } catch {
    // sem foto
  }
}

// Código → token → identidade → usuário (com papéis, canais e foto).
export async function completeLogin(p: any, code: string, verifier: string) {
  const tokens = await exchangeCode(p, code, verifier);
  const ident = await fetchIdentity(p, tokens);
  const r = await upsertOAuthUser(p, ident);
  let user = r.user;
  if (!user.active) throw fail(403, 'error-user-inactive', 'Usuário desativado ou aguardando aprovação de um administrador.');
  user = await syncRoles(p, user, ident, r.syncedRoles);
  await mapChannels(p, user, ident);
  if (r.created || r.linked) await importAvatar(p, user, ident, tokens.accessToken);
  return { user, externalId: `${p.id}:${ident.id}`, created: r.created };
}
