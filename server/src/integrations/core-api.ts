import type { FastifyInstance } from 'fastify';
import type { ConnectorStatus, IntegrationActivity, IntegrationsMe, Provider } from '@shared/integrations';
import { b, bool, paging, q, route, str, strArray } from '../api/http';
import { many, one } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { integrationsPaused, keyInfo, keyMismatch, keyReady, reencryptAll } from '../lib/secrets';
import { audit } from '../services/audit';
import { getUserRoles, hasPermission } from '../services/permissions';
import { canAccessRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { actorOf, type Ctx } from '../services/users';
import { alertsFor } from './alerts';
import { botIds, checkTargets, registerBotDmReply, roomRef } from './bots';
import { sessionTag } from './ephemeral';
import { getJob, retryDead, retryJob } from './jobs';
import { getLinked, listLinked, mapLinked, removeLinked, setLinkedMeta } from './linked';
import { publishChanged } from './state';

// Integrações (Jira/Teams): rotas comuns (integrations.*): o que a pessoa pode usar, visão geral, alertas,
// atividade, novas tentativas, salas de destino, contas conectadas e a troca da chave de segredos.

const MANAGE: Record<Provider, string> = { jira: 'manage-jira', msteams: 'manage-msteams' };
const RULE_PROVIDER: Record<string, Provider> = { 'jira-events': 'jira', 'msteams-outgoing': 'msteams', 'msteams-incoming': 'msteams' };

// ---------- Estado do conector (cada módulo registra o seu) ----------

const statusFns = new Map<Provider, () => Promise<ConnectorStatus>>();

export function registerConnectorStatus(provider: Provider, fn: () => Promise<ConnectorStatus>): void {
  statusFns.set(provider, fn);
}

async function connectorStatus(provider: Provider): Promise<ConnectorStatus> {
  const fn = statusFns.get(provider);
  if (!fn) return { tone: 'off', text: 'Não configurado' };
  try {
    return await fn();
  } catch (e) {
    return { tone: 'err', text: (e as Error).message || 'Não foi possível ler o estado da conexão.' };
  }
}

// ---------- Ajudantes ----------

const asProvider = (v: unknown): Provider => {
  if (v === 'jira' || v === 'msteams') return v;
  throw badRequest('error-invalid-params', 'O parâmetro "provider" deve ser jira ou msteams.');
};

async function requireManage(ctx: Ctx, provider: Provider) {
  if (!(await hasPermission(ctx.userId, MANAGE[provider]))) throw forbidden();
}

const isAdmin = async (userId: string) => (await getUserRoles(userId)).includes('admin');

const originOf = (raw: unknown) => {
  try {
    return raw ? new URL(String(raw)).origin : '';
  } catch {
    return '';
  }
};

// Ligado e com o mínimo configurado (e a chave de segredos em ordem).
export function jiraReady(): boolean {
  return getSetting('Jira_Enabled') === true && !!originOf(getSetting('Jira_Site_Url')) && !integrationsPaused();
}

export function msteamsReady(): boolean {
  const filled = (k: string) => !!String(getSetting(k) ?? '').trim();
  return getSetting('MSTeams_Enabled') === true && filled('MSTeams_Tenant_Id') && filled('MSTeams_Client_Id') && !integrationsPaused();
}

export async function integrationsMe(ctx: Ctx): Promise<IntegrationsMe> {
  const [canUse, canCreate, canManageJira, canMeet, canManageTeams] = await Promise.all([
    hasPermission(ctx.userId, 'use-jira'),
    hasPermission(ctx.userId, 'create-jira-issue'),
    hasPermission(ctx.userId, 'manage-jira'),
    hasPermission(ctx.userId, 'start-msteams-meeting'),
    hasPermission(ctx.userId, 'manage-msteams'),
  ]);
  const [jiraAccount, msAccount, user] = await Promise.all([
    getLinked(ctx.userId, 'jira'),
    getLinked(ctx.userId, 'microsoft'),
    one('SELECT email_verified FROM users WHERE id = $1', [ctx.userId]),
  ]);
  const userAuth = String(getSetting('Jira_User_Auth') ?? 'token');
  const meetings = String(getSetting('MSTeams_Meetings_Mode') ?? 'links');
  return {
    sessionTag: sessionTag(ctx.sessionId ?? ''),
    bots: await botIds(),
    jira: {
      enabled: jiraReady(),
      canUse,
      canCreate,
      canManage: canManageJira,
      userAuth: userAuth === 'oauth' || userAuth === 'off' ? userAuth : 'token',
      createAsIntegration: getSetting('Jira_Create_As_Integration') === true,
      defaultProject: String(getSetting('Jira_Default_Project') ?? ''),
      site: originOf(getSetting('Jira_Site_Url')),
      account: jiraAccount ? mapLinked(jiraAccount) : null,
    },
    msteams: {
      enabled: msteamsReady(),
      meetings: meetings === 'off' || meetings === 'graph' ? meetings : 'links',
      canMeet,
      canManage: canManageTeams,
      defaultMinutes: Number(getSetting('MSTeams_Meeting_Minutes') ?? 30) || 30,
      presence: getSetting('MSTeams_Presence_Enabled') === true,
      emailTrusted: user?.email_verified === true,
      account: msAccount ? mapLinked(msAccount) : null,
    },
  };
}

function mapActivity(r: any): IntegrationActivity {
  return {
    _id: r.id,
    provider: r.provider,
    integrationId: r.integration_id ?? null,
    integrationName: r.integration_name ?? null,
    tone: r.tone,
    text: r.text,
    detail: r.detail ?? null,
    jobId: r.job_id ?? null,
    canRetry: r.job_status === 'dead',
    at: r.created_at,
  };
}

// ---------- Rotas ----------

export function integrationsCoreRoutes(app: FastifyInstance) {
  registerBotDmReply();
  // Na subida, antes de aceitar pedidos (as migrações já rodaram): a chave é a mesma das outras instâncias?
  app.addHook('onReady', async () => {
    await keyReady();
  });

  route(app, 'GET', 'integrations.me', {}, async (_req, _r, ctx) => integrationsMe(ctx));

  route(app, 'GET', 'integrations.overview', { permissions: ['manage-jira', 'manage-msteams', 'manage-integrations'] }, async (_req, _r, ctx) => {
    const counts = await many(`SELECT type, count(*)::int AS n FROM integrations GROUP BY type`);
    const n = (t: string) => Number(counts.find((c) => c.type === t)?.n ?? 0);
    const info = keyInfo();
    const admin = await isAdmin(ctx.userId);
    return {
      jira: { enabled: getSetting('Jira_Enabled') === true, status: await connectorStatus('jira'), rules: n('jira-events') },
      msteams: { enabled: getSetting('MSTeams_Enabled') === true, status: await connectorStatus('msteams'), outRules: n('msteams-outgoing'), inRules: n('msteams-incoming') },
      webhooks: { incoming: n('webhook-incoming'), outgoing: n('webhook-outgoing') },
      // O caminho do arquivo e o erro do sistema só para o papel admin.
      secretsKey: {
        source: info.source,
        ...(admin && info.file ? { file: info.file } : {}),
        created: info.created,
        ...(info.problem ? { problem: (admin && info.detail) || info.problem } : {}),
      },
      // Chave diferente da das outras instâncias (sem chave é source 'none' ou problem).
      paused: keyMismatch(),
    };
  });

  route(app, 'GET', 'integrations.alerts', {}, async (_req, _r, ctx) => {
    const [jira, msteams, admin] = await Promise.all([hasPermission(ctx.userId, 'manage-jira'), hasPermission(ctx.userId, 'manage-msteams'), isAdmin(ctx.userId)]);
    return { alerts: await alertsFor(ctx.userId, { jira, msteams, admin }) };
  });

  route(app, 'GET', 'integrations.activity', {}, async (req, _r, ctx) => {
    const query = q(req);
    const provider = asProvider(query.provider);
    await requireManage(ctx, provider);
    const { offset } = paging(query);
    const count = Math.max(1, Math.min(100, Number(query.count ?? 25) || 25));
    const params: unknown[] = [provider];
    let where = 'a.provider = $1';
    if (query.integrationId) where += ` AND a.integration_id = $${params.push(String(query.integrationId))}`;
    if (query.tone) {
      if (!['ok', 'warn', 'err', 'info'].includes(query.tone)) throw badRequest('error-invalid-params', 'O parâmetro "tone" é inválido.');
      where += ` AND a.tone = $${params.push(query.tone)}`;
    }
    const total = Number((await one(`SELECT count(*)::int AS n FROM integration_activity a WHERE ${where}`, params))?.n ?? 0);
    const rows = await many(
      `SELECT a.*, i.name AS integration_name, j.status AS job_status
       FROM integration_activity a
       LEFT JOIN integrations i ON i.id = a.integration_id
       LEFT JOIN integration_jobs j ON j.id = a.job_id
       WHERE ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${count} OFFSET ${offset}`,
      params,
    );
    return { activity: rows.map(mapActivity), total };
  });

  route(app, 'POST', 'integrations.jobs.retry', {}, async (req, _r, ctx) => {
    const jobId = str(b(req).jobId, 'jobId', { max: 64 });
    const job = await getJob(jobId);
    if (!job) throw notFound('error-not-found', 'Esta tarefa já foi reenviada ou não existe mais.');
    await requireManage(ctx, job.provider);
    await retryJob(jobId);
    await audit(actorOf(ctx), 'integration.job.retried', { jobId }, { kind: job.kind, integrationId: job.integrationId });
    return {};
  });

  route(app, 'POST', 'integrations.jobs.retryAll', {}, async (req, _r, ctx) => {
    const integrationId = str(b(req).integrationId, 'integrationId', { max: 64 });
    const rule = await one('SELECT type FROM integrations WHERE id = $1', [integrationId]);
    const provider = rule ? RULE_PROVIDER[rule.type] : null;
    if (!provider) throw notFound('error-not-found', 'Regra não encontrada.');
    await requireManage(ctx, provider);
    const count = await retryDead(integrationId);
    await audit(actorOf(ctx), 'integration.job.retried', { integrationId }, { integrationId, count });
    return { count };
  });

  route(app, 'POST', 'integrations.targets.check', {}, async (req, _r, ctx) => {
    const body = b(req);
    const provider = asProvider(body.provider);
    await requireManage(ctx, provider);
    const mode = body.mode === 'read' ? 'read' : 'post';
    const roomIds = strArray(body.roomIds).slice(0, 20);
    return { targets: await checkTargets(ctx, provider, roomIds, mode, bool(body.grantPublisher) === true) };
  });

  // Só salas que a pessoa pode acessar: nunca discussões, salas arquivadas ou canais de um time privado de fora.
  route(app, 'GET', 'integrations.rooms.search', { permissions: ['manage-jira', 'manage-msteams'] }, async (req, _r, ctx) => {
    const query = q(req);
    const text = String(query.text ?? '').trim().slice(0, 100);
    const count = Math.max(1, Math.min(20, Number(query.count ?? 10) || 10));
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const candidates = await many(
      `SELECT r.*, (s.id IS NOT NULL) AS member FROM rooms r
       LEFT JOIN subscriptions s ON s.room_id = r.id AND s.user_id = $1
       WHERE r.t IN ('c', 'p') AND r.prid IS NULL AND NOT r.archived
         AND (r.t = 'c' OR s.id IS NOT NULL)
         AND ($2 = '' OR r.name ILIKE $3 OR r.fname ILIKE $3)
       ORDER BY (s.id IS NOT NULL) DESC, lower(COALESCE(NULLIF(r.fname, ''), r.name))
       LIMIT 200`,
      [ctx.userId, text, like],
    );
    const rooms = [];
    for (const r of candidates) {
      if (rooms.length >= count) break;
      if (!r.member && !(await canAccessRoom(ctx.userId, r))) continue;
      rooms.push(roomRef(r));
    }
    return { rooms };
  });

  route(app, 'GET', 'integrations.linked.list', {}, async (_req, _r, ctx) => ({ accounts: (await listLinked(ctx.userId)).map(mapLinked) }));

  route(app, 'POST', 'integrations.linked.remove', {}, async (req, _r, ctx) => {
    const provider = b(req).provider;
    if (provider !== 'jira' && provider !== 'microsoft') throw badRequest('error-invalid-params', 'O parâmetro "provider" deve ser jira ou microsoft.');
    await removeLinked(ctx.userId, provider);
    return {};
  });

  route(app, 'POST', 'integrations.linked.update', {}, async (req, _r, ctx) => {
    const body = b(req);
    if (body.provider !== 'microsoft') throw badRequest('error-invalid-params', 'Só a conta Microsoft 365 tem opções.');
    const busySync = bool(body.busySync);
    if (busySync === undefined) throw badRequest('error-invalid-params', 'O parâmetro "busySync" é obrigatório.');
    const row = await setLinkedMeta(ctx.userId, 'microsoft', { busySync });
    if (!row) throw notFound('error-not-found', 'Nenhuma conta Microsoft 365 encontrada para você.');
    return { account: mapLinked(row) };
  });

  // discardUnreadable: a chave antiga se perdeu e o administrador confirmou que os segredos que não abrem serão
  // cadastrados de novo (sem isso, numa instância com a chave diferente da das outras, a resposta é 500).
  route(app, 'POST', 'integrations.secretsKey.reencrypt', {}, async (req, _r, ctx) => {
    if (!(await isAdmin(ctx.userId))) throw forbidden();
    const discardUnreadable = bool(b(req).discardUnreadable) === true;
    const { count, unreadable } = await reencryptAll({ discardUnreadable });
    await audit(actorOf(ctx), 'integration.secretsKey.reencrypted', {}, { count, unreadable, ...(discardUnreadable ? { discardUnreadable } : {}) });
    publishChanged('config');
    return { count, unreadable };
  });
}
