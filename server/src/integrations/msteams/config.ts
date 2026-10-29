// Configuração do Teams: settings + segredos → TeamsConfig; salvar; aceite da leitura periódica; teste de conexão (§5.2).
import { INTEGRATION_CALLBACK, type ConnectorStatus, type TeamsConfig, type TeamsConfigInput } from '@shared/integrations';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config as serverConfig } from '../../config';
import { one } from '../../db/pool';
import { ApiError, badRequest } from '../../lib/errors';
import { randomToken } from '../../lib/ids';
import { getSecret, secretState, setSecret } from '../../lib/secrets';
import { internalAddress } from '../../oauth/login';
import { audit } from '../../services/audit';
import { getSetting, updateSettings } from '../../services/settings';
import { siteUrl } from '../../services/sso';
import { actorOf, type Ctx } from '../../services/users';
import { getState, mergeState, publishChanged, setState } from '../state';
import { safeExternalText } from '../text';
import { appToken, clearTokenCache, clientSecret, GRAPH_TEXT, graph, serviceToken, tokenClaims } from './graph';
import { safeName } from './html';

export const CONFIG_TEXT = {
  disabled: 'A integração com o Microsoft Teams está desligada.',
  notConfigured: 'Configure e teste a conexão com o Microsoft Teams antes de ativar.',
  emailChange: 'Pessoas podem trocar o próprio e-mail no chat. Desligue Permitir alterar e-mail antes de usar Criar agora e a presença.',
  redirectNote: (port: number) =>
    `O Microsoft Entra só aceita endereços https ou http://localhost. Faça este passo no próprio servidor: abra http://localhost:${port}/admin/integrations/teams/conexao nele.`,
  notificationsProblem: (site: string) => `As notificações do Microsoft 365 só chegam a endereços https públicos, com certificado de uma autoridade pública. Este chat está em ${site}.`,
  pollingAccept: 'Para usar a leitura periódica, confirme que leu o aviso sobre a recomendação da Microsoft.',
  pollingUnavailable: 'A leitura periódica não está disponível neste locatário do Microsoft 365.',
  presenceDelivery: 'A presença precisa das notificações do Microsoft 365 (endereço https público) ou da leitura periódica aceita na aba Conexão.',
  outReady: 'Pronto: cada regra usa o endereço de um fluxo do Workflows.',
  missing: (list: string[]) => `Falta: ${list.join(', ')}.`,
  ready: 'Pronto.',
  off: 'Não configurado',
  ok: 'Conectado ao Microsoft 365.',
  warn: 'Conectado ao Microsoft 365, com avisos.',
  unreadable: 'Não foi possível ler o segredo do aplicativo (a chave de segredos mudou). Cadastre o segredo de novo.',
  serviceLinked: (name: string, upn: string) => (upn ? `Conta de serviço: ${name || upn} (${upn})` : `Conta de serviço: ${name}`),
  appRoles: (list: string[]) => `Permissões do aplicativo: ${list.length ? list.join(', ') : 'nenhuma'}.`,
  serviceScopes: (list: string[]) => `Permissões da conta de serviço: ${list.length ? list.join(', ') : 'nenhuma'}.`,
  feature: (name: string, line: string) => `${name} · ${line}`,
};

export const FEATURES = { out: 'Avisos para o Teams', in: 'Mensagens do Teams', meetings: 'Criar reunião na hora', presence: 'Presença' };

export const teamsOn = () => getSetting<boolean>('MSTeams_Enabled') === true;
export const inboundMode = () => {
  const v = String(getSetting('MSTeams_Inbound_Mode') ?? 'off');
  return (v === 'notifications' || v === 'polling' ? v : 'off') as TeamsConfig['inboundMode'];
};
export const meetingsMode = () => {
  const v = String(getSetting('MSTeams_Meetings_Mode') ?? 'links');
  return (v === 'off' || v === 'graph' ? v : 'links') as TeamsConfig['meetingsMode'];
};
export const presenceOn = () => getSetting<boolean>('MSTeams_Presence_Enabled') === true;
export const emailChangeAllowed = () => getSetting('Accounts_AllowEmailChange') !== false;

export function assertTeamsEnabled() {
  if (!teamsOn()) throw badRequest('error-msteams-disabled', CONFIG_TEXT.disabled);
}

// ---------- Endereços ----------

export function serviceRedirectUri(): { uri: string; note: string | null } {
  const site = siteUrl();
  if (/^https:\/\//i.test(site)) return { uri: `${site}${INTEGRATION_CALLBACK.msteams}`, note: null };
  return { uri: `http://localhost:${serverConfig.port}${INTEGRATION_CALLBACK.msteams}`, note: CONFIG_TEXT.redirectNote(serverConfig.port) };
}

const dnsCache = new Map<string, { internal: boolean; at: number }>();

// null quando a Microsoft consegue chamar este endereço: https e um host que não é da rede interna.
export async function notificationsProblem(): Promise<string | null> {
  const site = siteUrl();
  const problem = CONFIG_TEXT.notificationsProblem(site);
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return problem;
  }
  if (u.protocol !== 'https:') return problem;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return internalAddress(host) ? problem : null;
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|corp|home\.arpa)$/.test(host)) return problem;
  const hit = dnsCache.get(host);
  let internal = hit && Date.now() - hit.at < 60_000 ? hit.internal : undefined;
  if (internal === undefined) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      internal = addrs.some((a) => internalAddress(a.address));
    } catch {
      internal = false; // sem resolução aqui não dá para afirmar que é interno
    }
    if (dnsCache.size > 50) dnsCache.clear();
    dnsCache.set(host, { internal, at: Date.now() });
  }
  return internal ? problem : null;
}

// {Site_Url}/hooks/msteams/{token}: o token (32 bytes) nasce no primeiro uso.
export async function notificationsTarget(create = true): Promise<{ url: string | null; problem: string | null }> {
  const problem = await notificationsProblem();
  if (problem) return { url: null, problem };
  let token = await getSecret('msteams.notifyToken').catch(() => null);
  if (!token && create) {
    try {
      token = randomToken(32).replace(/[^A-Za-z0-9]/g, '').slice(0, 43);
      await setSecret('msteams.notifyToken', token, null);
    } catch {
      token = null;
    }
  }
  return { url: token ? `${siteUrl()}/hooks/msteams/${token}` : null, problem: null };
}

// ---------- Estado guardado ----------

export interface ConnState {
  tone: ConnectorStatus['tone'];
  text: string;
  checkedAt: string;
  details: string[];
  granted: { application: string[]; delegated: string[] };
}

export interface ServiceState {
  id?: string;
  upn?: string;
  displayName?: string;
  scopes?: string[];
  linkedAt?: string;
  error?: string | null;
  errorSince?: string | null;
}

export interface PollingState {
  acceptedAt?: string | null;
  acceptedBy?: string | null;
  unavailable?: string | null;
}

export const getServiceState = () => getState<ServiceState>('msteams.service');
export const getPolling = async () => (await getState<PollingState>('msteams.polling')) ?? {};
export const pollingAccepted = async () => !!(await getPolling()).acceptedAt;

export async function serviceLinked(): Promise<boolean> {
  return (await secretState('msteams.serviceRefreshToken')).set;
}

function serviceStatus(linked: boolean, st: ServiceState | null): ConnectorStatus {
  if (st?.error) return { tone: 'err', text: st.error, checkedAt: st.errorSince ?? null };
  if (!linked) return { tone: 'off', text: GRAPH_TEXT.noService };
  return { tone: 'ok', text: CONFIG_TEXT.serviceLinked(st?.displayName ?? '', st?.upn ?? ''), checkedAt: st?.linkedAt ?? null };
}

export async function getTeamsConfig(): Promise<TeamsConfig> {
  const secret = await secretState('msteams.clientSecret');
  const conn = await getState<ConnState>('msteams.status');
  const svc = await getServiceState();
  const linked = await serviceLinked();
  const redirect = serviceRedirectUri();
  const target = await notificationsTarget(inboundMode() === 'notifications' || teamsOn());
  const polling = await getPolling();
  const app = await getState<{ oid?: string }>('msteams.app');
  const configured = !!String(getSetting('MSTeams_Tenant_Id') ?? '').trim() && !!String(getSetting('MSTeams_Client_Id') ?? '').trim() && secret.set;
  let status: ConnectorStatus = configured && conn ? { tone: conn.tone, text: conn.text, checkedAt: conn.checkedAt, details: conn.details ?? [] } : { tone: 'off', text: CONFIG_TEXT.off, checkedAt: null, details: [] };
  if (secret.unreadable) status = { tone: 'err', text: CONFIG_TEXT.unreadable, checkedAt: conn?.checkedAt ?? null, details: [CONFIG_TEXT.unreadable] };
  const acceptedBy = polling.acceptedBy ? await one('SELECT username FROM users WHERE id = $1', [polling.acceptedBy]) : null;
  return {
    enabled: teamsOn(),
    tenantId: String(getSetting('MSTeams_Tenant_Id') ?? ''),
    clientId: String(getSetting('MSTeams_Client_Id') ?? ''),
    clientSecret: secret,
    status,
    granted: conn?.granted ?? { application: [], delegated: [] },
    serviceAccount: { linked, upn: svc?.upn ?? null, displayName: svc?.displayName ?? null, status: serviceStatus(linked, svc) },
    serviceRedirectUri: redirect.uri,
    serviceRedirectNote: redirect.note,
    inboundMode: inboundMode(),
    notificationsUrl: target.url,
    notificationsProblem: target.problem,
    pollMinutes: Number(getSetting('MSTeams_Poll_Minutes') ?? 2),
    pollingAcceptedAt: polling.acceptedAt ?? null,
    pollingAcceptedBy: acceptedBy?.username ?? (polling.acceptedBy ? polling.acceptedBy : null),
    pollingUnavailable: polling.unavailable ?? null,
    appObjectId: app?.oid ?? null,
    emailChangeAllowed: emailChangeAllowed(),
    meetingsMode: meetingsMode(),
    meetingLobby: (String(getSetting('MSTeams_Meeting_Lobby') ?? 'organization') as TeamsConfig['meetingLobby']),
    meetingMinutes: Number(getSetting('MSTeams_Meeting_Minutes') ?? 30),
    presenceEnabled: presenceOn(),
    presenceMinutes: Number(getSetting('MSTeams_Presence_Minutes') ?? 5),
  };
}

// Estado mostrado na visão geral das integrações.
export async function connectorStatus(): Promise<ConnectorStatus> {
  if (!teamsOn()) return { tone: 'off', text: 'Desligado' };
  const c = await getTeamsConfig();
  if (c.inboundMode !== 'off' && c.serviceAccount.status.tone === 'err') return c.serviceAccount.status;
  return c.status;
}

// ---------- Salvar ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function settingError(e: unknown): never {
  if (e instanceof ApiError) throw e;
  throw badRequest('error-invalid-setting', String((e as Error)?.message ?? e));
}

// Quem reage à troca do modo de recebimento (assinaturas e leitura): notifications.ts registra.
let onInboundChange: ((from: string, to: string) => Promise<void>) | null = null;
export function setInboundChangeHandler(fn: (from: string, to: string) => Promise<void>) {
  onInboundChange = fn;
}

export async function saveTeamsConfig(ctx: Ctx, input: TeamsConfigInput): Promise<{ config: TeamsConfig }> {
  const values: Record<string, unknown> = {};
  let connectionChanged = false;
  const fromMode = inboundMode();

  if (input.tenantId !== undefined) {
    values.MSTeams_Tenant_Id = String(input.tenantId ?? '').trim();
    if (values.MSTeams_Tenant_Id !== getSetting('MSTeams_Tenant_Id')) connectionChanged = true;
  }
  if (input.clientId !== undefined) {
    values.MSTeams_Client_Id = String(input.clientId ?? '').trim();
    if (values.MSTeams_Client_Id !== getSetting('MSTeams_Client_Id')) connectionChanged = true;
  }
  if (input.pollMinutes !== undefined) values.MSTeams_Poll_Minutes = input.pollMinutes;
  if (input.meetingsMode !== undefined) values.MSTeams_Meetings_Mode = input.meetingsMode;
  if (input.meetingLobby !== undefined) values.MSTeams_Meeting_Lobby = input.meetingLobby;
  if (input.meetingMinutes !== undefined) values.MSTeams_Meeting_Minutes = input.meetingMinutes;
  if (input.presenceMinutes !== undefined) values.MSTeams_Presence_Minutes = input.presenceMinutes;
  if (input.clientSecretExpiresAt && !DATE.test(input.clientSecretExpiresAt)) throw badRequest('error-invalid-setting', 'Informe a validade do segredo no formato AAAA-MM-DD.');
  if (typeof input.clientSecret === 'string' && (input.clientSecret.trim().length < 8 || input.clientSecret.length > 8192)) {
    throw badRequest('error-invalid-setting', 'Cole o valor do segredo do aplicativo inteiro.');
  }

  // Modo de recebimento: leitura periódica só com o aceite por escrito (D13); notificações só com endereço público.
  const polling = await getPolling();
  let toMode = fromMode;
  if (input.inboundMode !== undefined) {
    if (!['off', 'notifications', 'polling'].includes(input.inboundMode)) throw badRequest('error-invalid-setting', 'Modo de recebimento inválido.');
    toMode = input.inboundMode;
    if (toMode === 'polling' && fromMode !== 'polling' && input.acceptPolling !== true) throw badRequest('error-msteams-polling-accept', CONFIG_TEXT.pollingAccept);
    if (toMode === 'notifications' && fromMode !== 'notifications') {
      const target = await notificationsTarget();
      if (!target.url) throw badRequest('error-msteams-not-configured', target.problem ?? CONFIG_TEXT.notConfigured);
    }
    values.MSTeams_Inbound_Mode = toMode;
  }

  if (input.presenceEnabled !== undefined) {
    if (input.presenceEnabled === true && !presenceOn()) {
      const accepted = !!polling.acceptedAt || (toMode === 'polling' && input.acceptPolling === true);
      const canNotify = toMode === 'notifications' || !(await notificationsProblem());
      if (!accepted && !canNotify) throw badRequest('error-invalid-setting', CONFIG_TEXT.presenceDelivery);
    }
    values.MSTeams_Presence_Enabled = !!input.presenceEnabled;
  }

  if (input.enabled === true) {
    const tenant = String(values.MSTeams_Tenant_Id ?? getSetting('MSTeams_Tenant_Id') ?? '').trim();
    const client = String(values.MSTeams_Client_Id ?? getSetting('MSTeams_Client_Id') ?? '').trim();
    const secret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : input.clientSecret === null ? null : await clientSecret();
    if (!tenant || !client || !secret) throw badRequest('error-msteams-not-configured', CONFIG_TEXT.notConfigured);
  }

  try {
    if (Object.keys(values).length) await updateSettings(values);
  } catch (e) {
    settingError(e);
  }
  if (typeof input.clientSecret === 'string') {
    await setSecret('msteams.clientSecret', input.clientSecret.trim(), ctx.userId, { expiresAt: input.clientSecretExpiresAt ?? null });
    connectionChanged = true;
  } else if (input.clientSecret === null) {
    await setSecret('msteams.clientSecret', null, ctx.userId);
    connectionChanged = true;
  } else if (input.clientSecretExpiresAt !== undefined) {
    const cur = await clientSecret();
    if (cur) await setSecret('msteams.clientSecret', cur, ctx.userId, { expiresAt: input.clientSecretExpiresAt });
  }
  if (connectionChanged) {
    clearTokenCache();
    await setState('msteams.status', null);
    await setState('msteams.app', null);
  }

  if (toMode !== fromMode) {
    if (toMode === 'polling') await setState('msteams.polling', { acceptedAt: new Date().toISOString(), acceptedBy: ctx.userId, unavailable: null });
    await audit(actorOf(ctx), 'integration.msteams.inbound.mode', {}, { from: fromMode, to: toMode, accepted: toMode === 'polling' });
  }
  if (input.enabled !== undefined) {
    try {
      await updateSettings({ MSTeams_Enabled: !!input.enabled });
    } catch (e) {
      settingError(e);
    }
  }

  await audit(actorOf(ctx), 'integration.msteams.config.saved', {}, { fields: Object.keys(input).filter((k) => !/secret/i.test(k)) });
  if (toMode !== fromMode && onInboundChange) await onInboundChange(fromMode, toMode).catch(() => {});
  if (connectionChanged && (await clientSecret()) && String(getSetting('MSTeams_Tenant_Id') ?? '').trim() && String(getSetting('MSTeams_Client_Id') ?? '').trim()) {
    await testConnection().catch(() => {});
  }
  publishChanged('config');
  return { config: await getTeamsConfig() };
}

// ---------- Teste de conexão (§5.2) ----------

const IN_SCOPES = ['ChannelMessage.Read.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All'];
const MEETING_ROLES = ['OnlineMeetings.ReadWrite.All', 'User.Read.All'];
const PRESENCE_ROLES = ['Presence.Read.All', 'User.Read.All'];

const missingOf = (need: string[], have: string[]) => need.filter((p) => !have.some((h) => h.toLowerCase() === p.toLowerCase()));

export async function testConnection(): Promise<{ config: TeamsConfig }> {
  const details: { tone: 'ok' | 'warn' | 'err'; line: string }[] = [];
  const granted = { application: [] as string[], delegated: [] as string[] };
  let fatal: string | null = null;

  // 1. Token do aplicativo para o Graph.
  try {
    const token = await appToken('graph');
    granted.application = tokenClaims(token).roles ?? [];
    details.push({ tone: 'ok', line: CONFIG_TEXT.appRoles(granted.application) });
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
  }

  // 2. Conta de serviço.
  const linked = await serviceLinked();
  if (!fatal && linked) {
    try {
      const token = await serviceToken();
      granted.delegated = (tokenClaims(token).scp ?? '').split(' ').filter(Boolean);
      const me = await graph<any>('service', 'GET', '/me?$select=id,displayName,userPrincipalName,mail', undefined, { permission: 'User.Read' });
      if (me?.id) await mergeState('msteams.service', { id: String(me.id), upn: String(me.userPrincipalName ?? me.mail ?? ''), displayName: safeName(me.displayName, safeExternalText, 256) });
      const svc = await getServiceState();
      details.push({ tone: 'ok', line: CONFIG_TEXT.serviceLinked(svc?.displayName ?? '', svc?.upn ?? '') });
      details.push({ tone: 'ok', line: CONFIG_TEXT.serviceScopes(granted.delegated) });
    } catch (e) {
      details.push({ tone: 'err', line: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3. E-mail que a própria pessoa troca (D30).
  const emailWarn = emailChangeAllowed();
  if (emailWarn) details.push({ tone: 'warn', line: CONFIG_TEXT.emailChange });

  // 4. Uma linha por recurso.
  if (!fatal) {
    details.push({ tone: 'ok', line: CONFIG_TEXT.feature(FEATURES.out, CONFIG_TEXT.outReady) });
    const target = await notificationsTarget(false);
    const delivery = inboundMode() === 'polling' ? await pollingAccepted() : !(await notificationsProblem());
    const inMissing = missingOf(IN_SCOPES, granted.delegated);
    const inLine = !linked
      ? GRAPH_TEXT.noService
      : inMissing.length
        ? CONFIG_TEXT.missing(inMissing)
        : !delivery
          ? (target.problem ?? CONFIG_TEXT.notificationsProblem(String(getSetting('Site_Url') ?? '')))
          : CONFIG_TEXT.ready;
    details.push({ tone: inLine === CONFIG_TEXT.ready || inboundMode() === 'off' ? 'ok' : 'warn', line: CONFIG_TEXT.feature(FEATURES.in, inLine) });
    const mtMissing = missingOf(MEETING_ROLES, granted.application);
    const mtLine = mtMissing.length ? CONFIG_TEXT.missing(mtMissing) : emailWarn ? CONFIG_TEXT.emailChange : CONFIG_TEXT.ready;
    details.push({ tone: mtLine === CONFIG_TEXT.ready || meetingsMode() !== 'graph' ? 'ok' : 'warn', line: CONFIG_TEXT.feature(FEATURES.meetings, mtLine) });
    const prMissing = missingOf(PRESENCE_ROLES, granted.application);
    // Com notificações, a presença chega por assinatura da conta de serviço (permissão delegada).
    if (!(await notificationsProblem())) prMissing.push(...missingOf(['Presence.Read.All'], granted.delegated).map((p) => `${p} (conta de serviço)`));
    const prLine = prMissing.length ? CONFIG_TEXT.missing(prMissing) : emailWarn ? CONFIG_TEXT.emailChange : CONFIG_TEXT.ready;
    details.push({ tone: prLine === CONFIG_TEXT.ready || !presenceOn() ? 'ok' : 'warn', line: CONFIG_TEXT.feature(FEATURES.presence, prLine) });
  }

  const tone: ConnectorStatus['tone'] = fatal ? 'err' : details.some((d) => d.tone !== 'ok') ? 'warn' : 'ok';
  const st: ConnState = {
    tone,
    text: fatal ?? (tone === 'warn' ? CONFIG_TEXT.warn : CONFIG_TEXT.ok),
    checkedAt: new Date().toISOString(),
    details: fatal ? [fatal, ...details.map((d) => d.line)] : details.map((d) => d.line),
    granted,
  };
  await setState('msteams.status', st);
  publishChanged('config');
  return { config: await getTeamsConfig() };
}

