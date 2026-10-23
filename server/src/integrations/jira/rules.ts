// Regras jira-events (linhas de integrations), validação ao salvar e filtro JQL do webhook.
import { JIRA_DEFAULT_EVENTS, JIRA_EVENT_KINDS, type IntegrationRoomRef, type JiraEventKind, type JiraRule, type JiraRuleInput } from '@shared/integrations';
import { many, one, query } from '../../db/pool';
import { ApiError, badRequest, notFound } from '../../lib/errors';
import { newId, randomToken } from '../../lib/ids';
import { bus } from '../../realtime/bus';
import { audit } from '../../services/audit';
import { actorOf, type Ctx } from '../../services/users';
import { clearAlert } from '../alerts';
import { announce, checkTargets, ensureBotUser, prepareTargets, releaseTargets } from '../bots';
import { integrationClient, JiraError } from './client';
import { RULE_TEXT, ruleAnnounce, ruleRelease } from './texts';

export interface RuleConfig {
  projects: string[];
  issueTypes: string[];
  events: JiraEventKind[];
  jql: string;
  threads: boolean;
  mentionAssignee: boolean;
  grantPublisher: boolean;
}

export interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  channels: string[];
  user_id: string;
  username: string;
  config: RuleConfig;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

const MAX_RULES = 50;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;

function normConfig(c: any): RuleConfig {
  return {
    projects: Array.isArray(c?.projects) ? c.projects.map(String) : [],
    issueTypes: Array.isArray(c?.issueTypes) ? c.issueTypes.map(String) : [],
    events: Array.isArray(c?.events) ? c.events.filter((e: any) => (JIRA_EVENT_KINDS as readonly string[]).includes(e)) : [...JIRA_DEFAULT_EVENTS],
    jql: typeof c?.jql === 'string' ? c.jql : '',
    threads: c?.threads !== false,
    mentionAssignee: c?.mentionAssignee === true,
    grantPublisher: c?.grantPublisher === true,
  };
}

const rowOf = (r: any): RuleRow => ({ ...r, channels: r.channels ?? [], config: normConfig(r.config) });

export async function listRuleRows(): Promise<RuleRow[]> {
  return (await many(`SELECT * FROM integrations WHERE type = 'jira-events' ORDER BY created_at`)).map(rowOf);
}

export async function getRuleRow(id: string): Promise<RuleRow | null> {
  const r = await one(`SELECT * FROM integrations WHERE id = $1 AND type = 'jira-events'`, [id]);
  return r ? rowOf(r) : null;
}

// Regras ligadas, em memória por até 60 s (salvar nesta instância renova na hora).
let snapshot: { rules: RuleRow[]; at: number } | null = null;
export async function refreshRulesSnapshot() {
  snapshot = { rules: (await listRuleRows()).filter((r) => r.enabled), at: Date.now() };
  return snapshot.rules;
}
export async function enabledRules(): Promise<RuleRow[]> {
  if (!snapshot || Date.now() - snapshot.at > 60_000) return refreshRulesSnapshot();
  return snapshot.rules;
}

// Filtro do webhook no Jira: os projetos das regras ligadas.
export function webhookJqlFor(rows: RuleRow[]): string {
  const keys = [...new Set(rows.filter((r) => r.enabled).flatMap((r) => r.config.projects))].sort();
  return keys.length ? `project in (${keys.join(', ')})` : '';
}

async function roomRefs(ids: string[]): Promise<IntegrationRoomRef[]> {
  if (!ids.length) return [];
  const rows = await many(`SELECT id, name, fname, t, notice, archived, ro FROM rooms WHERE id = ANY($1)`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r: any) => ({ _id: r.id, name: r.name ?? '', ...(r.fname ? { fname: r.fname } : {}), t: r.t === 'p' ? 'p' : 'c', notice: !!r.notice, archived: !!r.archived, ro: !!r.ro }));
}

export async function mapRule(r: RuleRow): Promise<JiraRule> {
  const by = r.created_by ? await one('SELECT id, username FROM users WHERE id = $1', [r.created_by]) : null;
  return {
    _id: r.id,
    name: r.name,
    enabled: r.enabled,
    projects: r.config.projects,
    issueTypes: r.config.issueTypes,
    events: r.config.events,
    jql: r.config.jql,
    roomIds: r.channels,
    rooms: await roomRefs(r.channels),
    threads: r.config.threads,
    mentionAssignee: r.config.mentionAssignee,
    grantPublisher: r.config.grantPublisher,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdBy: by ? { _id: by.id, username: by.username } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listRules(): Promise<JiraRule[]> {
  return Promise.all((await listRuleRows()).map(mapRule));
}

const ruleError = (text: string) => badRequest('error-jira-rule', text);

// Confere tudo antes de gravar: nada fica pela metade (o robô só entra nas salas depois disso).
async function validate(ctx: Ctx, input: any, isNew: boolean): Promise<{ cfg: RuleConfig; name: string; enabled: boolean; roomIds: string[] }> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 80) throw ruleError(RULE_TEXT.name);
  const projects = [...new Set((Array.isArray(input.projects) ? input.projects : []).map((p: unknown) => String(p).trim().toUpperCase()).filter(Boolean))] as string[];
  if (!projects.length || projects.length > 20 || projects.some((p) => !KEY_RE.test(p))) throw ruleError(RULE_TEXT.projects);
  const events = [...new Set((Array.isArray(input.events) ? input.events : []).filter((e: unknown) => (JIRA_EVENT_KINDS as readonly unknown[]).includes(e)))] as JiraEventKind[];
  if (!events.length) throw ruleError(RULE_TEXT.events);
  const issueTypes = [...new Set((Array.isArray(input.issueTypes) ? input.issueTypes : []).map((t: unknown) => String(t).trim()).filter(Boolean))].slice(0, 50) as string[];
  if (issueTypes.some((t) => t.length > 100)) throw ruleError(RULE_TEXT.events);
  const jql = typeof input.jql === 'string' ? input.jql.trim() : '';
  if (jql.length > 1000) throw ruleError(RULE_TEXT.jqlLong);
  const roomIds = [...new Set((Array.isArray(input.roomIds) ? input.roomIds : []).map(String).filter(Boolean))] as string[];
  if (!roomIds.length || roomIds.length > 5) throw ruleError(RULE_TEXT.rooms);
  const grantPublisher = input.grantPublisher === true;
  if (isNew && Number((await one(`SELECT count(*)::int AS n FROM integrations WHERE type = 'jira-events'`))?.n ?? 0) >= MAX_RULES) {
    throw badRequest('error-integration-limit', RULE_TEXT.limit);
  }

  for (const t of await checkTargets(ctx, 'jira', roomIds, 'post', grantPublisher)) {
    if (!t.ok) throw badRequest('error-integration-room', t.problem ?? RULE_TEXT.rooms);
  }

  // Projetos e JQL conferidos com a conta da integração.
  const client = await integrationClient();
  for (const key of projects) {
    try {
      await client.get(`/rest/api/3/project/${encodeURIComponent(key)}`);
    } catch (e) {
      if (e instanceof JiraError && (e.jiraStatus === 404 || e.jiraStatus === 403)) throw ruleError(RULE_TEXT.projectMissing(key));
      throw e;
    }
  }
  if (jql) {
    let parsed: any;
    try {
      parsed = await client.post<any>('/rest/api/3/jql/parse?validation=strict', { queries: [jql] });
    } catch (e) {
      if (e instanceof JiraError && e.jiraStatus === 400) throw ruleError(RULE_TEXT.jql(e.message.replace(/^O Jira recusou: /, '')));
      throw e;
    }
    const errors: string[] = parsed?.queries?.[0]?.errors ?? [];
    if (errors.length) throw ruleError(RULE_TEXT.jql(errors.join(' ')));
  }

  return {
    name,
    enabled: input.enabled !== false,
    roomIds,
    cfg: { projects, issueTypes, events, jql, threads: input.threads !== false, mentionAssignee: input.mentionAssignee === true, grantPublisher },
  };
}

async function saverName(ctx: Ctx) {
  const u = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  return String(u?.name || u?.username || ctx.username);
}

const changed = () => bus.publish({ all: true }, { type: 'integrations.changed', scope: 'config' });

export async function saveRule(ctx: Ctx, input: Partial<JiraRuleInput> & { _id?: string }): Promise<JiraRule> {
  const prev = input._id ? await getRuleRow(String(input._id)) : null;
  if (input._id && !prev) throw notFound('error-not-found', 'Regra não encontrada.');
  const v = await validate(ctx, input, !prev);
  const bot = await ensureBotUser('jira');
  await prepareTargets(ctx, 'jira', v.roomIds, v.cfg.grantPublisher);

  let row: RuleRow;
  if (prev) {
    row = rowOf(
      await one(`UPDATE integrations SET name = $2, enabled = $3, channels = $4, user_id = $5, username = $6, config = $7, updated_at = now() WHERE id = $1 RETURNING *`, [
        prev.id,
        v.name,
        v.enabled,
        v.roomIds,
        bot.id,
        bot.username,
        JSON.stringify(v.cfg),
      ]),
    );
  } else {
    row = rowOf(
      await one(
        `INSERT INTO integrations (id, type, name, enabled, token, user_id, username, channels, config, created_by)
         VALUES ($1, 'jira-events', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [newId(), v.name, v.enabled, randomToken(24).replace(/[^A-Za-z0-9]/g, '').slice(0, 32), bot.id, bot.username, v.roomIds, JSON.stringify(v.cfg), ctx.userId],
      ),
    );
  }
  await audit(actorOf(ctx), prev ? 'integration.jira.rule.updated' : 'integration.jira.rule.created', { integrationId: row.id }, { name: row.name, rooms: row.channels, projects: v.cfg.projects });

  const before = new Set(prev?.channels ?? []);
  const by = await saverName(ctx);
  for (const rid of v.roomIds.filter((r) => !before.has(r))) {
    await announce('jira', rid, ruleAnnounce(v.cfg.projects, v.cfg.events, v.name, by)).catch(() => {});
  }
  const dropped = (prev?.channels ?? []).filter((r) => !v.roomIds.includes(r));
  if (dropped.length) await release(ctx, dropped, prev!.config.projects);

  await refreshRulesSnapshot();
  changed();
  return mapRule(row);
}

// A regra deixou de avisar nestas salas: o robô avisa e sai das que nenhuma outra regra usa.
async function release(ctx: Ctx, roomIds: string[], projects: string[]) {
  await releaseTargets(ctx, 'jira', roomIds, ruleRelease(projects));
}

export async function removeRule(ctx: Ctx, id: string) {
  const prev = await getRuleRow(id);
  if (!prev) throw notFound('error-not-found', 'Regra não encontrada.');
  await query(`DELETE FROM integrations WHERE id = $1`, [id]);
  await audit(actorOf(ctx), 'integration.jira.rule.removed', { integrationId: id }, { name: prev.name });
  await clearAlert(`jira.rule:${id}`).catch(() => {});
  await release(ctx, prev.channels, prev.config.projects).catch((e) => {
    if (!(e instanceof ApiError)) throw e;
  });
  await refreshRulesSnapshot();
  changed();
}
