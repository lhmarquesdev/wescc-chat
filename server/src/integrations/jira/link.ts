// Vincular a conta do Jira da pessoa (§4.10): Entrar com a Atlassian (OAuth 2.0 3LO) ou token pessoal.
import type { LinkedAccount } from '@shared/integrations';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, badRequest } from '../../lib/errors';
import { getSecret } from '../../lib/secrets';
import { safeFetch, SafeFetchError } from '../../lib/safeFetch';
import { getSetting } from '../../services/settings';
import type { Ctx } from '../../services/users';
import { endpoints } from '../endpoints';
import { getLinked, mapLinked, saveLinked } from '../linked';
import { finishOAuth, OAuthStateError, oauthRedirectTarget, safeReturnTo, startOAuth, stateErrorTarget } from '../oauthState';
import { safeExternalText } from '../text';
import { currentSite } from './client';
import { oauthProblem, oauthRedirectUri, userAuthMode } from './config';
import { personLimit } from './issues';
import { LINK_TEXT } from './texts';

const SCOPES = 'read:jira-work write:jira-work read:jira-user read:me offline_access';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Chamada sem efeitos colaterais (o cliente normal marcaria a conta como expirada num 401).
async function probe(url: string, init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<{ status: number; json: any }> {
  const res = await safeFetch(url, { method: init.method ?? 'GET', headers: { Accept: 'application/json', ...init.headers }, body: init.body, timeoutMs: 10_000 });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function requireSite() {
  const site = await currentSite();
  if ('problem' in site) throw badRequest('error-jira-not-configured', site.problem);
  return site;
}

// ---------- OAuth 2.0 (3LO) ----------

export async function startLink(ctx: Ctx, reply: FastifyReply, returnToRaw: unknown): Promise<{ url: string }> {
  if (userAuthMode() !== 'oauth') throw badRequest('error-jira-not-configured', LINK_TEXT.oauthOff);
  const problem = oauthProblem();
  if (problem) throw badRequest('error-jira-not-configured', problem);
  // Só caminhos do próprio chat (Minha conta ou a administração das integrações); outro vira /account/connected.
  const returnTo = safeReturnTo(returnToRaw, 'jira-user');
  const clientId = String(getSetting('Jira_OAuth_Client_Id') ?? '').trim();
  const secret = await getSecret('jira.oauthClientSecret').catch(() => null);
  if (!clientId || !secret) throw badRequest('error-jira-not-configured', LINK_TEXT.oauthOff);
  await requireSite();
  const redirectUri = oauthRedirectUri();
  const { state } = await startOAuth(reply, { purpose: 'jira-user', userId: ctx.userId, redirectUri, returnTo });
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return { url: `${endpoints.atlassianAuth()}/authorize?${params.toString()}` };
}

// GET /integrations/jira/callback: sem sessão; a pessoa vem só do state, o navegador só do cookie (§3.8).
export async function oauthCallback(req: FastifyRequest, reply: FastifyReply) {
  let st: { userId: string; redirectUri: string; returnTo: string };
  try {
    st = await finishOAuth(req, 'jira-user', reply);
  } catch (e) {
    // State desconhecido, vencido, de outro navegador ou já usado: nenhum código é trocado.
    return reply.redirect(stateErrorTarget(e instanceof OAuthStateError ? e.returnTo : '/account/connected'));
  }
  const back = st.returnTo;
  const fail = (motivo: string) => reply.redirect(oauthRedirectTarget(back, { integracao: 'erro', motivo }));
  const qs = (req.query ?? {}) as Record<string, string>;
  if (qs.error || !qs.code) return fail('negado');
  try {
    const site = await currentSite();
    if ('problem' in site) return fail('config');
    const clientId = String(getSetting('Jira_OAuth_Client_Id') ?? '').trim();
    const secret = await getSecret('jira.oauthClientSecret');
    if (!clientId || !secret) return fail('config');

    const tok = await probe(`${endpoints.atlassianAuth()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code: String(qs.code), redirect_uri: st.redirectUri }),
    });
    if (tok.status !== 200 || !tok.json?.access_token) return fail('token');
    const access = String(tok.json.access_token);
    const bearer = { Authorization: `Bearer ${access}` };

    const res = await probe(`${endpoints.atlassianApi()}/oauth/token/accessible-resources`, { headers: bearer });
    const sameOrigin = (u: unknown) => {
      try {
        return new URL(String(u)).origin === site.origin;
      } catch {
        return false;
      }
    };
    const resource = (Array.isArray(res.json) ? res.json : []).find((r: any) => r?.id && sameOrigin(r.url));
    if (!resource) return fail('site');

    const me = await probe(`${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(String(resource.id))}/rest/api/3/myself`, { headers: bearer });
    if (me.status !== 200 || !me.json?.accountId) return fail('conta');

    await saveLinked({
      userId: st.userId,
      provider: 'jira',
      method: 'oauth',
      externalId: String(me.json.accountId),
      displayName: safeExternalText(String(me.json.displayName ?? '')),
      email: me.json.emailAddress ? String(me.json.emailAddress) : null,
      site: site.origin,
      tokenExpiresAt: new Date(Date.now() + Number(tok.json.expires_in ?? 3600) * 1000),
      secretExpiresAt: null,
      scopes: typeof tok.json.scope === 'string' ? tok.json.scope.split(' ').filter(Boolean) : SCOPES.split(' '),
      meta: { cloudId: String(resource.id) },
      access,
      refresh: tok.json.refresh_token ? String(tok.json.refresh_token) : null,
    });
  } catch (e) {
    if (e instanceof ApiError && e.errorType === 'error-linked-elsewhere') return fail('conflito');
    if (e instanceof SafeFetchError) return fail('rede');
    return fail('erro');
  }
  return reply.redirect(oauthRedirectTarget(back, { integracao: 'jira-ok' }));
}

// ---------- Token pessoal ----------

export async function linkToken(ctx: Ctx, p: { email?: unknown; token?: unknown; expiresAt?: unknown }): Promise<{ account: LinkedAccount }> {
  if (userAuthMode() !== 'token') throw badRequest('error-jira-not-configured', LINK_TEXT.tokenOff);
  const email = String(p.email ?? '').trim();
  if (!EMAIL.test(email) || email.length > 254) throw badRequest('error-invalid-params', LINK_TEXT.email);
  const token = String(p.token ?? '').trim();
  if (token.length < 20 || token.length > 500 || /\s/.test(token)) throw badRequest('error-invalid-params', LINK_TEXT.token);
  let expires: Date | null = null;
  if (p.expiresAt !== undefined && p.expiresAt !== null && p.expiresAt !== '') {
    const s = String(p.expiresAt);
    expires = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59`) : null;
    if (!expires || Number.isNaN(expires.getTime())) throw badRequest('error-invalid-params', LINK_TEXT.expiresAt);
  }
  personLimit(ctx.userId, 'link');
  const site = await requireSite();
  const auth = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };

  let me = await probe(`${site.origin}/rest/api/3/myself`, { headers: auth });
  let gateway = false;
  // Token com escopos só funciona pelo gateway da Atlassian.
  if (me.status === 401 && site.cloudId) {
    const g = await probe(`${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/myself`, { headers: auth });
    if (g.status === 200) {
      me = g;
      gateway = true;
    }
  }
  if (me.status !== 200 || !me.json?.accountId) throw badRequest('error-jira-auth', LINK_TEXT.tokenFailed(email));

  await saveLinked({
    userId: ctx.userId,
    provider: 'jira',
    method: 'token',
    externalId: String(me.json.accountId),
    displayName: safeExternalText(String(me.json.displayName ?? '')),
    email,
    site: site.origin,
    tokenExpiresAt: null,
    secretExpiresAt: expires,
    scopes: [],
    meta: gateway ? { base: 'gateway' } : {},
    access: token,
    refresh: null,
  });
  const row = await getLinked(ctx.userId, 'jira');
  return { account: mapLinked(row!) };
}
