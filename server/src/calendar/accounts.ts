// Contas de agenda de cada pessoa: conectar (OAuth com PKCE), guardar os tokens cifrados, renovar, escolher o sentido
// da sincronização e desconectar. Google: cliente OAuth próprio da Agenda. Microsoft: o aplicativo do Teams (mesmo
// locatário, ID e segredo), com permissões delegadas da própria pessoa.
import type { CalendarAccount, CalendarAdminConfig, CalendarProvider, CalendarProviderInfo, SyncDirection } from '@shared/calendar';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { many, one, query } from '../db/pool';
import { endpoints } from '../integrations/endpoints';
import { clientId as msClientId, clientSecret as msClientSecret, tenantId as msTenantId } from '../integrations/msteams/graph';
import { finishOAuth, OAuthStateError, oauthRedirectTarget, pkcePair, safeReturnTo, startOAuth, stateErrorTarget, type OAuthPurpose } from '../integrations/oauthState';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { aadFor, decryptSecret, encryptSecret, getSecret, noteKeyUse, secretState, setSecret } from '../lib/secrets';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { getSetting, updateSettings } from '../services/settings';
import { siteUrl } from '../services/sso';
import { actorOf, type Ctx } from '../services/users';
import { kick } from './dirty';
import { calFetch, CalHttpError, idTokenClaims } from './http';

export const ACCOUNT_TEXT = {
  googleOff: 'O administrador ainda não ligou a conexão com o Google Agenda.',
  microsoftOff: 'O administrador ainda não ligou a conexão com o Outlook / Teams.',
  provider: 'Escolha Google ou Microsoft.',
  direction: 'Escolha em que sentido a agenda sincroniza.',
  notConnected: 'Esta conta não está conectada.',
  expired: 'A conexão venceu. Conecte a conta de novo.',
  unreadable: 'Não foi possível ler o token guardado (a chave de segredos mudou). Conecte a conta de novo.',
  clientId: 'Informe o ID do cliente OAuth do Google.',
  msNeedsTeams: 'Preencha antes o locatário, o ID e o segredo do aplicativo em Integrações › Microsoft Teams.',
};

const GOOGLE_SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.events';
const MS_SCOPES = 'offline_access openid profile email User.Read Calendars.ReadWrite';
const PURPOSE: Record<CalendarProvider, OAuthPurpose> = { google: 'calendar-google', microsoft: 'calendar-microsoft' };

export const redirectUri = (p: CalendarProvider) => `${siteUrl()}/integrations/calendar/${p}/callback`;

const googleClientId = () => String(getSetting('Calendar_Google_Client_Id') ?? '').trim();
const googleSecret = () => getSecret('calendar.googleClientSecret').catch(() => null);

async function providerReady(p: CalendarProvider): Promise<boolean> {
  if (p === 'google') return getSetting<boolean>('Calendar_Google_Enabled') === true && !!googleClientId() && !!(await googleSecret());
  return getSetting<boolean>('Calendar_Microsoft_Enabled') === true && !!msTenantId() && !!msClientId() && !!(await msClientSecret());
}

function providerOf(v: unknown): CalendarProvider {
  if (v !== 'google' && v !== 'microsoft') throw badRequest('error-invalid-params', ACCOUNT_TEXT.provider);
  return v;
}

function directionOf(v: unknown): SyncDirection {
  if (v !== 'import' && v !== 'export' && v !== 'both') throw badRequest('error-invalid-params', ACCOUNT_TEXT.direction);
  return v;
}

function mapAccount(r: any): CalendarAccount {
  return {
    provider: r.provider,
    email: r.email,
    displayName: r.display_name,
    direction: r.direction,
    status: r.status,
    statusText: r.status_text ?? null,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    connectedAt: new Date(r.created_at).toISOString(),
  };
}

export async function listProviders(ctx: Ctx): Promise<CalendarProviderInfo[]> {
  const rows = await many(`SELECT * FROM calendar_accounts WHERE user_id = $1`, [ctx.userId]);
  const out: CalendarProviderInfo[] = [];
  for (const provider of ['google', 'microsoft'] as const) {
    const row = rows.find((r) => r.provider === provider);
    out.push({ provider, available: await providerReady(provider), account: row ? mapAccount(row) : null });
  }
  return out;
}

const accountChanged = (userId: string) => bus.publish({ user: userId }, { type: 'calendar.changed' });

// ---------- Conectar ----------

export async function startConnect(ctx: Ctx, reply: FastifyReply, input: { provider?: unknown; direction?: unknown; returnTo?: unknown }): Promise<{ url: string }> {
  const provider = providerOf(input.provider);
  if (!(await providerReady(provider))) throw badRequest('error-calendar-not-configured', provider === 'google' ? ACCOUNT_TEXT.googleOff : ACCOUNT_TEXT.microsoftOff);
  const direction = input.direction === undefined ? 'both' : directionOf(input.direction);
  const purpose = PURPOSE[provider];
  const back = new URL(safeReturnTo(input.returnTo, purpose), 'http://x');
  back.searchParams.set('sentido', direction); // volta no retorno: o sentido escolhido antes de sair para o fornecedor
  const pkce = pkcePair();
  const uri = redirectUri(provider);
  const { state } = await startOAuth(reply, { purpose, userId: ctx.userId, redirectUri: uri, returnTo: `${back.pathname}${back.search}`, codeVerifier: pkce.verifier });
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: googleClientId(),
      redirect_uri: uri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${endpoints.googleAuth()}/o/oauth2/v2/auth?${p}` };
  }
  const p = new URLSearchParams({
    client_id: msClientId(),
    redirect_uri: uri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${endpoints.msLogin()}/${encodeURIComponent(msTenantId())}/oauth2/v2.0/authorize?${p}` };
}

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: Date;
}

async function tokenCall(provider: CalendarProvider, form: Record<string, string>): Promise<{ tokens: Tokens; idToken?: string }> {
  const url = provider === 'google' ? `${endpoints.googleToken()}/token` : `${endpoints.msLogin()}/${encodeURIComponent(msTenantId())}/oauth2/v2.0/token`;
  const secret = provider === 'google' ? await googleSecret() : await msClientSecret();
  const client = provider === 'google' ? googleClientId() : msClientId();
  if (!secret || !client) throw new CalHttpError('fail', provider === 'google' ? ACCOUNT_TEXT.googleOff : ACCOUNT_TEXT.microsoftOff);
  const r = await calFetch<any>(provider === 'google' ? 'Google' : 'Microsoft 365', url, { method: 'POST', form: { client_id: client, client_secret: secret, ...form } });
  if (!r?.access_token) throw new CalHttpError('fail', 'O fornecedor não devolveu o token.');
  return {
    tokens: {
      access: String(r.access_token),
      refresh: r.refresh_token ? String(r.refresh_token) : null,
      expiresAt: new Date(Date.now() + Math.max(60, Number(r.expires_in ?? 3600)) * 1000),
    },
    idToken: typeof r.id_token === 'string' ? r.id_token : undefined,
  };
}

async function profileOf(provider: CalendarProvider, access: string, idToken?: string): Promise<{ email: string; name: string }> {
  if (provider === 'google') {
    const c = idTokenClaims(idToken);
    return { email: c.email ?? '', name: c.name ?? '' };
  }
  const me = await calFetch<any>('Microsoft 365', `${endpoints.msGraph().replace(/\/+$/, '')}/v1.0/me?$select=displayName,mail,userPrincipalName`, { token: access });
  return { email: String(me?.mail || me?.userPrincipalName || ''), name: String(me?.displayName ?? '') };
}

async function saveTokens(accountId: string, t: Tokens, db = query) {
  const access = encryptSecret(t.access, aadFor.calendar(accountId, 'access'));
  await noteKeyUse(access);
  const refresh = t.refresh ? encryptSecret(t.refresh, aadFor.calendar(accountId, 'refresh')) : null;
  await db(
    `UPDATE calendar_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token), token_expires_at = $4, updated_at = now() WHERE id = $1`,
    [accountId, access, refresh, t.expiresAt],
  );
}

// GET /integrations/calendar/:provider/callback: sem sessão; a pessoa vem só do state, o navegador só do cookie.
export async function connectCallback(req: FastifyRequest, reply: FastifyReply, providerRaw: string) {
  const provider = providerRaw === 'google' || providerRaw === 'microsoft' ? providerRaw : null;
  if (!provider) return reply.redirect('/calendar');
  let st: { userId: string; redirectUri: string; returnTo: string; codeVerifier?: string };
  try {
    st = await finishOAuth(req, PURPOSE[provider], reply);
  } catch (e) {
    return reply.redirect(stateErrorTarget(e instanceof OAuthStateError ? e.returnTo : '/calendar'));
  }
  const back = new URL(st.returnTo, 'http://x');
  const direction = (['import', 'export', 'both'] as const).find((d) => d === back.searchParams.get('sentido')) ?? 'both';
  back.searchParams.delete('sentido');
  const backPath = `${back.pathname}${back.search}`;
  const fail = (motivo: string) => reply.redirect(oauthRedirectTarget(backPath, { integracao: 'erro', motivo, agenda: provider }));
  const qs = (req.query ?? {}) as Record<string, string>;
  if (qs.error || !qs.code) return fail('negado');
  try {
    const { tokens, idToken } = await tokenCall(provider, {
      grant_type: 'authorization_code',
      code: String(qs.code),
      redirect_uri: st.redirectUri,
      ...(st.codeVerifier ? { code_verifier: st.codeVerifier } : {}),
    });
    if (!tokens.refresh) return fail('token');
    const profile = await profileOf(provider, tokens.access, idToken);
    const prev = await one(`SELECT id FROM calendar_accounts WHERE user_id = $1 AND provider = $2`, [st.userId, provider]);
    const id = prev?.id ?? newId();
    await query(
      `INSERT INTO calendar_accounts (id, user_id, provider, email, display_name, direction, status, dirty)
       VALUES ($1, $2, $3, $4, $5, $6, 'ok', true)
       ON CONFLICT (user_id, provider) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
         direction = EXCLUDED.direction, status = 'ok', status_text = NULL, dirty = true, updated_at = now()`,
      [id, st.userId, provider, profile.email.slice(0, 320), profile.name.slice(0, 200), direction],
    );
    await saveTokens(id, tokens);
    const u = await one('SELECT id, username FROM users WHERE id = $1', [st.userId]);
    await audit({ id: st.userId, username: u?.username ?? null }, 'calendar.account.connected', { provider }, { direction });
    accountChanged(st.userId);
    kick([id]);
  } catch (e) {
    if (e instanceof CalHttpError) return fail(e.kind === 'retry' ? 'rede' : 'token');
    if (e instanceof ApiError) return fail('config');
    return fail('erro');
  }
  return reply.redirect(oauthRedirectTarget(backPath, { integracao: 'agenda-ok', agenda: provider }));
}

// ---------- Token para a sincronização ----------

async function setStatus(accountId: string, status: 'ok' | 'expired' | 'error', text: string | null) {
  const r = await one(
    `UPDATE calendar_accounts SET status = $2, status_text = $3, updated_at = now() WHERE id = $1 AND (status, COALESCE(status_text, '')) IS DISTINCT FROM ($2, COALESCE($3, '')) RETURNING user_id`,
    [accountId, status, text],
  );
  if (r) accountChanged(r.user_id);
}
export const markAccount = setStatus;

// Token válido da conta (renova quando falta menos de 2 minutos). Conta vencida: CalHttpError auth.
export async function accessToken(accountId: string): Promise<string> {
  const r = await one(`SELECT * FROM calendar_accounts WHERE id = $1`, [accountId]);
  if (!r) throw new CalHttpError('fail', ACCOUNT_TEXT.notConnected);
  let access: string | null = null;
  let refresh: string | null = null;
  try {
    access = r.access_token ? decryptSecret(r.access_token, aadFor.calendar(r.id, 'access')) : null;
    refresh = r.refresh_token ? decryptSecret(r.refresh_token, aadFor.calendar(r.id, 'refresh')) : null;
  } catch {
    await setStatus(r.id, 'expired', ACCOUNT_TEXT.unreadable);
    throw new CalHttpError('auth', ACCOUNT_TEXT.unreadable);
  }
  const fresh = r.token_expires_at && new Date(r.token_expires_at).getTime() - Date.now() > 120_000;
  if (access && fresh) return access;
  if (!refresh) {
    await setStatus(r.id, 'expired', ACCOUNT_TEXT.expired);
    throw new CalHttpError('auth', ACCOUNT_TEXT.expired);
  }
  try {
    const { tokens } = await tokenCall(r.provider, { grant_type: 'refresh_token', refresh_token: refresh, ...(r.provider === 'microsoft' ? { scope: MS_SCOPES } : {}) });
    await saveTokens(r.id, tokens);
    return tokens.access;
  } catch (e) {
    if (e instanceof CalHttpError && (e.kind === 'auth' || e.kind === 'fail')) {
      await setStatus(r.id, 'expired', ACCOUNT_TEXT.expired);
      throw new CalHttpError('auth', ACCOUNT_TEXT.expired);
    }
    throw e;
  }
}

// ---------- Opções e desconexão ----------

export async function setDirection(ctx: Ctx, input: { provider?: unknown; direction?: unknown }): Promise<CalendarAccount> {
  const provider = providerOf(input.provider);
  const direction = directionOf(input.direction);
  const r = await one(
    `UPDATE calendar_accounts SET direction = $3, dirty = true, updated_at = now() WHERE user_id = $1 AND provider = $2 RETURNING *`,
    [ctx.userId, provider, direction],
  );
  if (!r) throw notFound('error-calendar-not-connected', ACCOUNT_TEXT.notConnected);
  // Deixou de trazer: os eventos trazidos desta conta saem da agenda do chat.
  if (direction === 'export') await query(`DELETE FROM calendar_events WHERE account_id = $1`, [r.id]);
  await audit(actorOf(ctx), 'calendar.account.direction', { provider }, { direction });
  accountChanged(ctx.userId);
  kick([r.id]);
  return mapAccount(r);
}

export async function disconnect(ctx: Ctx, providerRaw: unknown): Promise<void> {
  const provider = providerOf(providerRaw);
  const r = await one(`SELECT * FROM calendar_accounts WHERE user_id = $1 AND provider = $2`, [ctx.userId, provider]);
  if (!r) return;
  // Tira do Google/Outlook as cópias de eventos do chat que ainda vão acontecer (melhor esforço: sem rede, ficam lá).
  try {
    const { removeExports } = await import('./sync');
    await removeExports(r.id, { futureOnly: true, maxMs: 15_000 });
  } catch {
    // segue para desconectar
  }
  const token = await accessTokenQuiet(r.id);
  if (token && provider === 'google') {
    await calFetch('Google', `${endpoints.googleToken()}/revoke`, { method: 'POST', form: { token } }).catch(() => {});
  }
  await query(`DELETE FROM calendar_accounts WHERE id = $1`, [r.id]);
  await audit(actorOf(ctx), 'calendar.account.disconnected', { provider }, {});
  accountChanged(ctx.userId);
}

async function accessTokenQuiet(accountId: string): Promise<string | null> {
  try {
    return await accessToken(accountId);
  } catch {
    return null;
  }
}

// ---------- Administração ----------

export async function adminConfig(): Promise<CalendarAdminConfig> {
  const g = await secretState('calendar.googleClientSecret');
  const msSecret = !!(await msClientSecret());
  return {
    google: { enabled: getSetting<boolean>('Calendar_Google_Enabled') === true, clientId: googleClientId(), secretSet: g.set, redirectUri: redirectUri('google') },
    microsoft: {
      enabled: getSetting<boolean>('Calendar_Microsoft_Enabled') === true,
      usesTeamsApp: true,
      tenantId: msTenantId(),
      clientId: msClientId(),
      secretSet: msSecret,
      redirectUri: redirectUri('microsoft'),
    },
    syncMinutes: Number(getSetting('Calendar_Sync_Minutes') ?? 5),
  };
}

export async function saveAdminConfig(
  ctx: Ctx,
  input: { googleEnabled?: unknown; googleClientId?: unknown; googleClientSecret?: unknown; microsoftEnabled?: unknown; syncMinutes?: unknown },
): Promise<CalendarAdminConfig> {
  const values: Record<string, unknown> = {};
  if (typeof input.googleClientId === 'string') values.Calendar_Google_Client_Id = input.googleClientId.trim().slice(0, 300);
  if (typeof input.googleClientSecret === 'string' && input.googleClientSecret.trim()) await setSecret('calendar.googleClientSecret', input.googleClientSecret.trim(), ctx.userId);
  if (input.googleEnabled !== undefined) {
    const on = input.googleEnabled === true;
    const id = (values.Calendar_Google_Client_Id as string | undefined) ?? googleClientId();
    if (on && !id) throw badRequest('error-invalid-params', ACCOUNT_TEXT.clientId);
    values.Calendar_Google_Enabled = on;
  }
  if (input.microsoftEnabled !== undefined) {
    const on = input.microsoftEnabled === true;
    if (on && (!msTenantId() || !msClientId() || !(await msClientSecret()))) throw badRequest('error-invalid-params', ACCOUNT_TEXT.msNeedsTeams);
    values.Calendar_Microsoft_Enabled = on;
  }
  if (input.syncMinutes !== undefined) values.Calendar_Sync_Minutes = input.syncMinutes;
  if (Object.keys(values).length) await updateSettings(values);
  await audit(actorOf(ctx), 'calendar.config.saved', {}, { keys: Object.keys(values) });
  return adminConfig();
}

export async function adminAccountsSummary(): Promise<{ provider: CalendarProvider; total: number; problems: number }[]> {
  const rows = await many(
    `SELECT provider, count(*)::int AS total, count(*) FILTER (WHERE status <> 'ok')::int AS problems FROM calendar_accounts GROUP BY provider`,
  );
  return (['google', 'microsoft'] as const).map((p) => {
    const r = rows.find((x) => x.provider === p);
    return { provider: p, total: r?.total ?? 0, problems: r?.problems ?? 0 };
  });
}
