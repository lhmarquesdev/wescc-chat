// Configuração do Jira: settings + segredos → JiraConfig; salvar; troca de site (D25); teste de conexão (§4.2).
import { INTEGRATION_CALLBACK, jiraSiteAllowed, type ConnectorStatus, type JiraConfig, type JiraConfigInput } from '@shared/integrations';
import crypto from 'node:crypto';
import { ApiError, badRequest } from '../../lib/errors';
import { randomToken } from '../../lib/ids';
import { getSecret, secretState, setSecret } from '../../lib/secrets';
import { integrationAllowedHosts, safeFetch, SafeFetchError } from '../../lib/safeFetch';
import { bus } from '../../realtime/bus';
import { audit } from '../../services/audit';
import { getSetting, updateSettings } from '../../services/settings';
import { siteUrl } from '../../services/sso';
import { actorOf, type Ctx } from '../../services/users';
import { clearAlert, raiseAlert } from '../alerts';
import { endpoints } from '../endpoints';
import { getState, setState } from '../state';
import { currentSite, JiraError, markConnection, rawClient, switchSite, type ConnectionState } from './client';
import { listRuleRows, refreshRulesSnapshot, webhookJqlFor } from './rules';
import { ALERT_TEXT, CONFIG_TEXT, LINK_TEXT, localeName } from './texts';
import { webhookProblem } from './webhook';

// "OPS, sup ;X" → ['OPS', 'SUP', 'X'] (maiúsculas, sem repetir).
export function projectKeys(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,;]+/);
  return [...new Set(list.map((k) => k.trim().toUpperCase()).filter(Boolean))];
}
export const visibleProjects = () => projectKeys(getSetting('Jira_Projects_Visible'));
export const createProjects = () => projectKeys(getSetting('Jira_Projects_Create'));
export const userAuthMode = () => (getSetting<string>('Jira_User_Auth') ?? 'token') as JiraConfig['userAuth'];
export const eventsMode = () => (getSetting<string>('Jira_Events_Mode') === 'webhook' ? 'webhook' : 'polling') as JiraConfig['eventsMode'];

export const oauthRedirectUri = () => `${siteUrl()}${INTEGRATION_CALLBACK.jira}`;
export function oauthProblem(): string | null {
  const u = oauthRedirectUri();
  return /^https:\/\//i.test(u) || /^http:\/\/localhost(:\d+)?\//i.test(u) ? null : CONFIG_TEXT.oauthProblem;
}

export async function webhookUrl(): Promise<{ url: string | null; problem: string | null }> {
  const problem = await webhookProblem(siteUrl());
  if (problem) return { url: null, problem };
  const token = await getSecret('jira.webhookToken').catch(() => null);
  return { url: token ? `${siteUrl()}/hooks/jira/${token}` : null, problem: null };
}

const expiresInDays = (iso: string | null | undefined) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);

function toStatus(st: ConnectionState | null): ConnectorStatus {
  if (!st) return { tone: 'off', text: CONFIG_TEXT.off, checkedAt: null, details: [] };
  return { tone: st.tone, text: st.text, checkedAt: st.checkedAt, details: st.details ?? [] };
}

async function statusFor(origin: string | null): Promise<ConnectorStatus> {
  const apiToken = await secretState('jira.apiToken', origin);
  const st = await getState<ConnectionState>('jira.status');
  if (apiToken.unreadable) return { tone: 'err', text: CONFIG_TEXT.unreadable, checkedAt: st?.checkedAt ?? null, details: [CONFIG_TEXT.unreadable] };
  return toStatus(origin && apiToken.set ? st : null);
}

// Estado mostrado na visão geral (integrations.overview).
export async function jiraConnectorStatus(): Promise<ConnectorStatus> {
  const site = await currentSite();
  return statusFor('origin' in site ? site.origin : null);
}

export async function getJiraConfig(): Promise<JiraConfig> {
  const site = await currentSite();
  const rawSite = String(getSetting('Jira_Site_Url') ?? '');
  const origin = 'origin' in site ? site.origin : null;
  const apiToken = await secretState('jira.apiToken', origin);
  const st = await getState<ConnectionState>('jira.status');
  const status = await statusFor(origin);
  const wh = await webhookUrl();
  const rules = await listRuleRows();
  const jql = webhookJqlFor(rules);
  const shown = await getState<{ jql: string }>('jira.webhook.shownJql');
  const poll = await getState<{ lastOkAt?: string }>('jira.poll');
  const lastWebhook = await getState<{ at?: string }>('jira.webhook.lastAt');
  return {
    enabled: getSetting('Jira_Enabled') === true,
    siteUrl: rawSite,
    authType: getSetting('Jira_Auth_Type') === 'basic' ? 'basic' : 'scoped',
    accountEmail: String(getSetting('Jira_Account_Email') ?? ''),
    cloudId: 'origin' in site ? site.cloudId : '',
    apiToken,
    account: st?.account ?? null,
    siteProblem: rawSite.trim() && 'problem' in site ? site.problem : null,
    status,
    userAuth: userAuthMode(),
    oauthClientId: String(getSetting('Jira_OAuth_Client_Id') ?? ''),
    oauthClientSecret: await secretState('jira.oauthClientSecret'),
    oauthRedirectUri: oauthRedirectUri(),
    oauthProblem: oauthProblem(),
    eventsMode: eventsMode(),
    pollMinutes: Number(getSetting('Jira_Poll_Minutes') ?? 2),
    lastPollAt: poll?.lastOkAt ?? null,
    webhookUrl: wh.url,
    webhookProblem: wh.problem,
    webhookSecret: await secretState('jira.webhookSecret'),
    webhookJql: jql,
    webhookJqlChanged: !!jql && (shown?.jql ?? '') !== jql,
    lastWebhookAt: lastWebhook?.at ?? null,
    unfurlEnabled: getSetting('Jira_Unfurl_Enabled') !== false,
    unfurlMax: Number(getSetting('Jira_Unfurl_Max') ?? 3),
    projectsVisible: visibleProjects(),
    projectsCreate: createProjects(),
    defaultProject: String(getSetting('Jira_Default_Project') ?? ''),
    createAsIntegration: getSetting('Jira_Create_As_Integration') === true,
    serviceDeskProjects: st?.serviceDeskProjects ?? [],
  };
}

const changedConfig = () => bus.publish({ all: true }, { type: 'integrations.changed', scope: 'config' });

function settingError(e: unknown): never {
  if (e instanceof ApiError) throw e;
  throw badRequest('error-invalid-setting', String((e as Error)?.message ?? e));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Segredo HMAC do webhook: 32 bytes aleatórios em hexadecimal (o Jira aceita qualquer texto).
const newHmacSecret = () => crypto.randomBytes(32).toString('hex');

export async function saveJiraConfig(ctx: Ctx, input: JiraConfigInput): Promise<{ config: JiraConfig; webhookSecret?: string }> {
  const prev = await currentSite();
  const values: Record<string, unknown> = {};
  let origin = 'origin' in prev ? prev.origin : null;
  let connectionChanged = false;

  if (input.siteUrl !== undefined) {
    const raw = String(input.siteUrl ?? '').trim();
    if (raw) {
      const r = jiraSiteAllowed(raw, integrationAllowedHosts());
      if ('problem' in r) throw badRequest('error-jira-not-configured', r.problem);
      origin = r.origin;
      values.Jira_Site_Url = r.origin;
    } else {
      origin = null;
      values.Jira_Site_Url = '';
    }
    if (values.Jira_Site_Url !== getSetting('Jira_Site_Url')) connectionChanged = true;
  }
  if (input.authType !== undefined) {
    if (input.authType !== 'scoped' && input.authType !== 'basic') throw badRequest('error-invalid-setting', 'Tipo de conta inválido.');
    if (input.authType !== getSetting('Jira_Auth_Type')) connectionChanged = true;
    values.Jira_Auth_Type = input.authType;
  }
  if (input.accountEmail !== undefined) {
    const email = String(input.accountEmail ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('error-invalid-setting', 'Informe um e-mail válido para a conta da integração.');
    if (email !== getSetting('Jira_Account_Email')) connectionChanged = true;
    values.Jira_Account_Email = email;
  }
  if (input.userAuth !== undefined) values.Jira_User_Auth = input.userAuth;
  if (input.oauthClientId !== undefined) values.Jira_OAuth_Client_Id = String(input.oauthClientId ?? '').trim();
  if (input.eventsMode !== undefined) values.Jira_Events_Mode = input.eventsMode;
  if (input.pollMinutes !== undefined) values.Jira_Poll_Minutes = input.pollMinutes;
  if (input.unfurlEnabled !== undefined) values.Jira_Unfurl_Enabled = !!input.unfurlEnabled;
  if (input.unfurlMax !== undefined) values.Jira_Unfurl_Max = input.unfurlMax;
  if (input.projectsVisible !== undefined) values.Jira_Projects_Visible = projectKeys(input.projectsVisible).join(', ');
  if (input.projectsCreate !== undefined) values.Jira_Projects_Create = projectKeys(input.projectsCreate).join(', ');
  if (input.defaultProject !== undefined) values.Jira_Default_Project = projectKeys(input.defaultProject)[0] ?? '';
  if (input.createAsIntegration !== undefined) values.Jira_Create_As_Integration = !!input.createAsIntegration;
  if (input.apiTokenExpiresAt && !DATE.test(input.apiTokenExpiresAt)) throw badRequest('error-invalid-setting', LINK_TEXT.expiresAt);
  if (typeof input.apiToken === 'string' && (input.apiToken.trim().length < 8 || input.apiToken.length > 8192)) throw badRequest('error-invalid-setting', 'Cole o token de API inteiro.');
  if (typeof input.oauthClientSecret === 'string' && (!input.oauthClientSecret.trim() || input.oauthClientSecret.length > 8192)) throw badRequest('error-invalid-setting', 'Cole o segredo do aplicativo inteiro.');

  const nextMode = (values.Jira_Events_Mode ?? eventsMode()) as string;
  if (nextMode === 'webhook' && (input.eventsMode === 'webhook' || input.enabled)) {
    const problem = await webhookProblem(siteUrl());
    if (problem) throw badRequest('error-jira-webhook', problem);
  }
  if (input.enabled === true) {
    // O token gravado só vale para o endereço a que pertence (bound_to): depois de uma troca, é preciso um novo.
    const token = typeof input.apiToken === 'string' ? input.apiToken : input.apiToken === null || !origin ? null : await getSecret('jira.apiToken', origin).catch(() => null);
    const email = (values.Jira_Account_Email ?? getSetting('Jira_Account_Email')) as string;
    if (!origin || !token || !email) throw badRequest('error-jira-not-configured', CONFIG_TEXT.notConfigured);
  }

  // Configurações primeiro (validadas juntas); depois a troca de site e os segredos ligados à origem nova.
  try {
    if (Object.keys(values).length) await updateSettings(values);
  } catch (e) {
    settingError(e);
  }
  // Troca de endereço (D25): compara com a origem das credenciais, também quando o campo estava vazio (A → vazio → B).
  // Descarta o token, o cloudId e as contas vinculadas do endereço antigo; nada é reenviado ao endereço novo.
  if (origin) await switchSite(origin, actorOf(ctx));
  if (typeof input.apiToken === 'string') {
    if (!origin) throw badRequest('error-jira-not-configured', CONFIG_TEXT.notConfigured);
    await setSecret('jira.apiToken', input.apiToken.trim(), ctx.userId, { boundTo: origin, expiresAt: input.apiTokenExpiresAt ?? null });
    connectionChanged = true;
  } else if (input.apiToken === null) {
    await setSecret('jira.apiToken', null, ctx.userId);
    await setState('jira.status', null);
  } else if (input.apiTokenExpiresAt !== undefined && origin) {
    const cur = await getSecret('jira.apiToken', origin).catch(() => null);
    if (cur) await setSecret('jira.apiToken', cur, ctx.userId, { boundTo: origin, expiresAt: input.apiTokenExpiresAt });
  }
  if (typeof input.oauthClientSecret === 'string') await setSecret('jira.oauthClientSecret', input.oauthClientSecret.trim(), ctx.userId);
  else if (input.oauthClientSecret === null) await setSecret('jira.oauthClientSecret', null, ctx.userId);

  // Primeira vez em modo webhook: cria o endereço e o segredo (mostrado só nesta resposta).
  let webhookSecret: string | undefined;
  if (eventsMode() === 'webhook' && !(await getSecret('jira.webhookToken').catch(() => null))) {
    await setSecret('jira.webhookToken', randomToken(32), ctx.userId);
    webhookSecret = newHmacSecret();
    await setSecret('jira.webhookSecret', webhookSecret, ctx.userId);
  }
  if (input.enabled !== undefined) {
    try {
      await updateSettings({ Jira_Enabled: !!input.enabled });
    } catch (e) {
      settingError(e);
    }
  }

  await audit(actorOf(ctx), 'integration.jira.config.saved', {}, { fields: Object.keys(input).filter((k) => !/token|secret/i.test(k)) });
  if (connectionChanged && origin && (await getSecret('jira.apiToken', origin).catch(() => null))) await testConnection().catch(() => {});
  changedConfig();
  await refreshRulesSnapshot();
  return { config: await getJiraConfig(), ...(webhookSecret ? { webhookSecret } : {}) };
}

// ---------- Teste de conexão (§4.2) ----------

interface Step {
  tone: 'ok' | 'warn' | 'err';
  line: string;
}

export async function testConnection(): Promise<{ status: ConnectorStatus; account: JiraConfig['account'] }> {
  const details: Step[] = [];
  const fail = async (text: string, extra: string[] = []) => {
    const lines = [...details.map((d) => d.line), text, ...extra];
    const st = await markConnection('err', text, { details: lines });
    await connectionAlert(st);
    return { status: toStatus(st), account: st.account ?? null };
  };
  const site = await currentSite();
  if ('problem' in site) return fail(site.problem);
  const { origin } = site;
  const token = await getSecret('jira.apiToken', origin).catch(() => null);
  const email = String(getSetting('Jira_Account_Email') ?? '').trim();
  if (!token || !email) return fail(CONFIG_TEXT.noToken);

  // 2. cloudId do site
  let cloudId = '';
  try {
    const res = await safeFetch(`${origin}/_edge/tenant_info`, { timeoutMs: 10_000 });
    cloudId = res.status === 200 ? String(res.json()?.cloudId ?? '') : '';
  } catch (e) {
    if (e instanceof SafeFetchError && e.code !== 'error-network' && e.code !== 'error-timeout') return fail(e.message);
  }
  if (!cloudId) return fail(CONFIG_TEXT.noCloud);
  await setState('jira.site', { origin, cloudId });
  if (getSetting('Jira_Cloud_Id') !== cloudId) await updateSettings({ Jira_Cloud_Id: cloudId });

  const scoped = getSetting('Jira_Auth_Type') !== 'basic';
  const base = scoped ? `${endpoints.atlassianApi()}/ex/jira/${encodeURIComponent(cloudId)}` : origin;
  const client = rawClient({ kind: 'integration' }, origin, base, `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`);

  // 3. tipo de instalação
  try {
    const info = await client.get<any>('/rest/api/3/serverInfo');
    if (info?.deploymentType && info.deploymentType !== 'Cloud') details.push({ tone: 'warn', line: CONFIG_TEXT.dataCenter });
  } catch (e) {
    if (e instanceof JiraError && (e.jiraStatus === 401 || e.jiraStatus === 403)) return fail(e.message, [CONFIG_TEXT.ipAllowlist]);
    return fail(e instanceof Error ? e.message : String(e));
  }

  // 4. conta da integração
  let account: NonNullable<JiraConfig['account']>;
  try {
    const me = await client.get<any>('/rest/api/3/myself');
    account = { accountId: String(me.accountId ?? ''), displayName: String(me.displayName ?? ''), email: me.emailAddress ?? null, locale: me.locale ?? null };
    details.push({ tone: 'ok', line: CONFIG_TEXT.account(account.displayName) });
    if (account.locale && !/^pt/i.test(account.locale)) details.push({ tone: 'warn', line: CONFIG_TEXT.language(localeName(account.locale)) });
  } catch (e) {
    if (e instanceof JiraError && (e.jiraStatus === 401 || e.jiraStatus === 403)) return fail(e.message, [CONFIG_TEXT.ipAllowlist]);
    return fail(e instanceof Error ? e.message : String(e));
  }

  // 5. projetos que a conta vê (e quais são do Service Management)
  const serviceDesk: string[] = [];
  try {
    const page = await client.get<any>('/rest/api/3/project/search', { maxResults: 50 });
    const values: any[] = Array.isArray(page?.values) ? page.values : [];
    for (const p of values) if (p?.projectTypeKey === 'service_desk' && p.key) serviceDesk.push(String(p.key));
    details.push({ tone: 'ok', line: CONFIG_TEXT.projects(Number(page?.total ?? values.length)) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // 6. projetos usados nas prévias e nas regras
  const rules = await listRuleRows();
  const wanted = [...new Set([...projectKeys(getSetting('Jira_Projects_Visible')), ...rules.flatMap((r) => projectKeys(r.config?.projects))])];
  for (const key of wanted) {
    try {
      const p = await client.get<any>(`/rest/api/3/project/${encodeURIComponent(key)}`);
      if (p?.projectTypeKey === 'service_desk' && !serviceDesk.includes(key)) serviceDesk.push(key);
    } catch (e) {
      if (e instanceof JiraError && (e.jiraStatus === 404 || e.jiraStatus === 403)) details.push({ tone: 'warn', line: CONFIG_TEXT.projectMissing(key) });
      else return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // 7. validade do token
  const tokenState = await secretState('jira.apiToken', origin);
  const days = expiresInDays(tokenState.expiresAt);
  if (days !== null && days <= 14) {
    details.push({ tone: 'warn', line: CONFIG_TEXT.tokenExpires(Math.max(0, days)) });
    await raiseAlert({ key: 'jira.token', provider: 'jira', tone: 'warn', text: ALERT_TEXT.token(Math.max(0, days)), href: '/admin/integrations/jira/conexao', to: 'managers' }).catch(() => {});
  } else await clearAlert('jira.token').catch(() => {});

  const warn = details.some((d) => d.tone === 'warn');
  const st = await markConnection(warn ? 'warn' : 'ok', warn ? CONFIG_TEXT.warn(account.displayName) : CONFIG_TEXT.ok(account.displayName), {
    details: details.map((d) => d.line),
    account,
    serviceDeskProjects: serviceDesk,
  });
  await connectionAlert(st);
  return { status: toStatus(st), account };
}

// Erro por mais de 1 hora → alerta jira.connection; voltou → limpa.
export async function connectionAlert(st: ConnectionState | null) {
  if (!st) return;
  if (st.tone !== 'err') return clearAlert('jira.connection').catch(() => {});
  if (st.errSince && Date.now() - new Date(st.errSince).getTime() > 3_600_000) {
    await raiseAlert({ key: 'jira.connection', provider: 'jira', tone: 'err', text: ALERT_TEXT.connection(st.text), href: '/admin/integrations/jira/conexao', to: 'managers' }).catch(() => {});
  }
}

// "Gerar novo endereço" / "Gerar novo segredo". O segredo só aparece nesta resposta.
export async function rotateWebhook(ctx: Ctx, what: 'url' | 'secret'): Promise<{ webhookUrl: string | null; secret?: string }> {
  const problem = await webhookProblem(siteUrl());
  if (problem) throw badRequest('error-jira-webhook', problem);
  let secret: string | undefined;
  if (what === 'url' || !(await getSecret('jira.webhookToken').catch(() => null))) await setSecret('jira.webhookToken', randomToken(32), ctx.userId);
  if (what === 'secret' || !(await getSecret('jira.webhookSecret').catch(() => null))) {
    secret = newHmacSecret();
    await setSecret('jira.webhookSecret', secret, ctx.userId);
  }
  await audit(actorOf(ctx), 'integration.jira.webhook.rotated', {}, { what });
  changedConfig();
  return { webhookUrl: (await webhookUrl()).url, ...(secret ? { secret } : {}) };
}

export async function ackWebhook(jql: string) {
  await setState('jira.webhook.shownJql', { jql: String(jql ?? '').slice(0, 5000) });
  changedConfig();
}
