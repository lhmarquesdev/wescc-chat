// Conta de serviço do Teams (§5.2): entrada com código + PKCE, renovação do token (refresh token rotativo) e
// invalid_grant (senha trocada, conta bloqueada, Acesso Condicional): tudo que depende dela para com o mesmo texto.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { many, query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { getSecret, setSecret } from '../../lib/secrets';
import { SafeFetchError } from '../../lib/safeFetch';
import { audit } from '../../services/audit';
import { actorOf, type Ctx } from '../../services/users';
import { alertText, clearAlert, raiseAlert } from '../alerts';
import { endpoints } from '../endpoints';
import { finishOAuth, OAuthStateError, oauthRedirectTarget, pkcePair, safeReturnTo, startOAuth, stateErrorTarget } from '../oauthState';
import { activity, getState, markRule, mergeState, publishChanged, setState } from '../state';
import { safeExternalText } from '../text';
import { safeName } from './html';
import { presenceOn, serviceRedirectUri, type ServiceState } from './config';
import { appCredentials, graph, MsError, setServiceTokenProvider, tokenRequest } from './graph';

export const SERVICE_TEXT = {
  alert: (detail: string) => alertText('A conta de serviço do Teams parou de funcionar', detail),
  unlinked: 'A conta de serviço do Teams foi desconectada.',
};

const BASE_SCOPES = ['offline_access', 'User.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'];
export const serviceScopes = () => [...BASE_SCOPES, ...(presenceOn() ? ['Presence.Read.All'] : [])];

// ---------- Entrada (código + PKCE) ----------

export async function startServiceSignIn(ctx: Ctx, reply: FastifyReply, returnToRaw: unknown): Promise<{ url: string }> {
  const { tenant, client } = await appCredentials();
  const returnTo = safeReturnTo(returnToRaw, 'msteams-service');
  const { uri } = serviceRedirectUri();
  const { verifier, challenge } = pkcePair();
  const { state } = await startOAuth(reply, { purpose: 'msteams-service', userId: ctx.userId, redirectUri: uri, returnTo, codeVerifier: verifier });
  const params = new URLSearchParams({
    client_id: client,
    response_type: 'code',
    redirect_uri: uri,
    response_mode: 'query',
    scope: serviceScopes().join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${endpoints.msLogin()}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}` };
}

// GET /integrations/msteams/callback: sem sessão; quem iniciou vem do state, o navegador do cookie (§3.8).
export async function serviceCallback(req: FastifyRequest, reply: FastifyReply) {
  let st: { userId: string; redirectUri: string; returnTo: string; codeVerifier?: string };
  try {
    st = await finishOAuth(req, 'msteams-service', reply);
  } catch (e) {
    return reply.redirect(stateErrorTarget(e instanceof OAuthStateError ? e.returnTo : '/admin/integrations/teams/conexao'));
  }
  const back = st.returnTo;
  const fail = (motivo: string) => reply.redirect(oauthRedirectTarget(back, { integracao: 'erro', motivo }));
  const qs = (req.query ?? {}) as Record<string, string>;
  if (qs.error || !qs.code || !st.codeVerifier) return fail('negado');
  try {
    const { tenant, client, secret } = await appCredentials();
    const scopes = serviceScopes();
    const tok = await tokenRequest(tenant, {
      client_id: client,
      client_secret: secret,
      grant_type: 'authorization_code',
      code: String(qs.code),
      redirect_uri: st.redirectUri,
      code_verifier: st.codeVerifier,
      scope: scopes.join(' '),
    });
    if (!tok.refresh_token) return fail('token');
    // Identidade pelo id (oid) do /me, nunca pelo sub (que muda por aplicativo).
    const me = await graph<any>('service', 'GET', '/me?$select=id,displayName,userPrincipalName,mail', undefined, { token: tok.access_token, permission: 'User.Read' });
    if (!me?.id) return fail('conta');
    await setSecret('msteams.serviceRefreshToken', tok.refresh_token, st.userId);
    remember(tok.access_token, tok.expires_in);
    const state: ServiceState = {
      id: String(me.id),
      upn: String(me.userPrincipalName ?? me.mail ?? ''),
      displayName: safeName(me.displayName, safeExternalText, 256),
      scopes,
      linkedAt: new Date().toISOString(),
      error: null,
      errorSince: null,
    };
    await setState('msteams.service', state);
    await clearAlert('msteams.service');
    await audit({ id: st.userId, username: null }, 'integration.msteams.service.linked', {}, { upn: state.upn });
    publishChanged('config');
    onLinked?.().catch(() => {});
  } catch (e) {
    if (e instanceof SafeFetchError) return fail('rede');
    if (e instanceof MsError) return fail(e.errorType === 'error-msteams-unavailable' ? 'rede' : 'token');
    if (e instanceof ApiError && e.errorType === 'error-msteams-not-configured') return fail('config');
    return fail('erro');
  }
  return reply.redirect(oauthRedirectTarget(back, { integracao: 'teams-ok' }));
}

// Assinaturas e leituras voltam quando a conta entra de novo (notifications.ts registra).
let onLinked: (() => Promise<void>) | null = null;
export function setServiceLinkedHandler(fn: () => Promise<void>) {
  onLinked = fn;
}

// "Desconectar a conta de serviço": apaga o refresh token, o estado e as assinaturas (§5.4).
export async function unlinkService(ctx: Ctx): Promise<void> {
  const subs = await many(`SELECT id FROM msteams_subscriptions`);
  for (const s of subs) await graph('service', 'DELETE', `/subscriptions/${encodeURIComponent(s.id)}`).catch(() => {});
  await query(`DELETE FROM msteams_subscriptions`);
  const prev = await getState<ServiceState>('msteams.service');
  await setSecret('msteams.serviceRefreshToken', null, ctx.userId);
  await setState('msteams.service', null);
  forget();
  await clearAlert('msteams.service');
  await audit(actorOf(ctx), 'integration.msteams.service.unlinked', {}, { upn: prev?.upn ?? null });
  await activity({ provider: 'msteams', tone: 'info', text: SERVICE_TEXT.unlinked });
  publishChanged('config');
}

// ---------- Token de acesso (memória) e renovação ----------

let cached: { token: string; exp: number } | null = null;
let inflight: Promise<string> | null = null;

function remember(token: string, expiresIn?: number) {
  cached = { token, exp: Date.now() + Math.max(60, Number(expiresIn ?? 3600)) * 1000 };
}
function forget() {
  cached = null;
}

// Conta parada: estado com o texto, regras de recebimento com o erro, alerta msteams.service (uma vez por dia).
export async function markServiceBroken(text: string) {
  const st = await getState<ServiceState>('msteams.service');
  if (st?.error !== text) await mergeState('msteams.service', { error: text, errorSince: st?.errorSince ?? new Date().toISOString() });
  forget();
  const rules = await many(`SELECT id FROM integrations WHERE type = 'msteams-incoming' AND enabled`);
  for (const r of rules) await markRule(r.id, false, text);
  await raiseAlert({ key: 'msteams.service', provider: 'msteams', tone: 'err', text: SERVICE_TEXT.alert(text), href: '/admin/integrations/teams/conexao', to: 'managers' }).catch(() => {});
  publishChanged('config');
}

export async function serviceBroken(): Promise<string | null> {
  return (await getState<ServiceState>('msteams.service'))?.error ?? null;
}

async function refresh(): Promise<string> {
  const st = await getState<ServiceState>('msteams.service');
  if (st?.error) throw new MsError(400, 'error-msteams-service', st.error);
  const rt = await getSecret('msteams.serviceRefreshToken').catch(() => null);
  if (!rt) throw new MsError(400, 'error-msteams-service', 'Conecte a conta de serviço.');
  const { tenant, client, secret } = await appCredentials();
  let tok;
  try {
    tok = await tokenRequest(tenant, {
      client_id: client,
      client_secret: secret,
      grant_type: 'refresh_token',
      refresh_token: rt,
      scope: (st?.scopes?.length ? st.scopes : BASE_SCOPES).join(' '),
    });
  } catch (e) {
    if (e instanceof MsError && e.graphCode === 'invalid_grant') await markServiceBroken(e.message);
    throw e;
  }
  // O refresh token novo vale no lugar do antigo: gravado na hora.
  if (tok.refresh_token && tok.refresh_token !== rt) await setSecret('msteams.serviceRefreshToken', tok.refresh_token, null);
  remember(tok.access_token, tok.expires_in);
  return tok.access_token;
}

setServiceTokenProvider({
  async get() {
    if (cached && cached.exp - 5 * 60_000 > Date.now()) return cached.token;
    if (!inflight) inflight = refresh().finally(() => (inflight = null));
    return inflight;
  },
  forget,
});

