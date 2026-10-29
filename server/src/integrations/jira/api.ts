// Rotas REST do Jira (§4.11), o retorno do OAuth e o webhook. Registra tarefas, ganchos e /jira uma vez.
import { INTEGRATION_CALLBACK, JIRA_DEFAULT_EVENTS, JIRA_EVENT_KINDS, type JiraConfigInput, type JiraCreateInput, type JiraEventKind, type MessageJira } from '@shared/integrations';
import type { FastifyInstance } from 'fastify';
import { b, bool, q, route, str, strArray } from '../../api/http';
import { badRequest } from '../../lib/errors';
import { canPostInRoom } from '../../services/messages';
import { loadRoomForUser } from '../../services/rooms';
import { assertJiraEnabled, currentSite, integrationClient } from './client';
import { sendSearchPage } from './command';
import { ackWebhook, getJiraConfig, rotateWebhook, saveJiraConfig, testConnection } from './config';
import { fromSearchIssue, ISSUE_FIELDS, primaryKind, type NormalizedJiraEvent } from './events';
import { assignableUsers, assignIssue, commentIssue, createIssue, createMeta, listProjects, searchIssues, shareIssue, snapshots, viewIssue } from './issues';
import { linkToken, oauthCallback, startLink } from './link';
import { eventInfo } from './notify';
import { registerJira } from './register';
import { listRules, removeRule, saveRule } from './rules';
import { eventText, RULE_TEXT } from './texts';
import { removePreview } from './unfurl';
import { registerJiraWebhook } from './webhook';

const MANAGE = { permissions: ['manage-jira'] };
const USE = { permissions: ['use-jira'] };
const CREATE = { permissions: ['create-jira-issue'] };
const KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;

// Exemplo de aviso para a tela da regra: a issue mais nova sem nível de segurança do primeiro projeto. Nada é publicado.
async function rulePreview(projectsRaw: unknown, eventsRaw: unknown): Promise<{ msg: string; jira: MessageJira }> {
  const projects = strArray(projectsRaw).map((p) => p.trim().toUpperCase()).filter((p) => KEY_RE.test(p));
  if (!projects.length) throw badRequest('error-jira-rule', RULE_TEXT.projects);
  const asked = strArray(eventsRaw).filter((e): e is JiraEventKind => (JIRA_EVENT_KINDS as readonly string[]).includes(e));
  const events = asked.length ? asked : JIRA_DEFAULT_EVENTS;
  const site = await currentSite();
  if ('problem' in site) throw badRequest('error-jira-not-configured', site.problem);
  const client = await integrationClient();
  const r = await client.get<any>('/rest/api/3/search/jql', { jql: `project = ${projects[0]} AND level IS EMPTY ORDER BY created DESC`, fields: ISSUE_FIELDS, expand: 'changelog', maxResults: 1 });
  const issue = Array.isArray(r?.issues) ? r.issues.find((i: any) => !i?.fields?.security) : null;
  if (!issue) throw badRequest('error-jira-rule', RULE_TEXT.previewEmpty(projects[0]));
  // O evento mais recente que a regra avisaria; sem nenhum, a criação da issue.
  const evs = fromSearchIssue(issue, new Date(0), site.origin);
  let chosen: { ev: NormalizedJiraEvent; kind: JiraEventKind } | null = null;
  for (const ev of [...evs].reverse()) {
    const kind = primaryKind(ev, events);
    if (kind && kind !== 'deleted') {
      chosen = { ev, kind };
      break;
    }
  }
  if (!chosen) {
    const created = evs.find((e) => e.kinds.includes('created'));
    const base: NormalizedJiraEvent = created ?? { key: `n:${issue.id}`, kinds: ['created'], issueId: String(issue.id), issueKey: String(issue.key), issue, actor: null, changes: [], restricted: false, at: new Date().toISOString() };
    chosen = { ev: base, kind: 'created' };
  }
  const [snap] = await snapshots([issue], site.origin);
  return { msg: eventText(chosen.kind, chosen.ev, snap), jira: { kind: 'event', site: site.origin, issues: [snap], event: eventInfo(chosen.kind, chosen.ev) } };
}

export function jiraRoutes(app: FastifyInstance) {
  registerJira();

  // ---------- Configuração e regras (manage-jira; funcionam com o Jira desligado) ----------
  route(app, 'GET', 'jira.config', MANAGE, async () => ({ config: await getJiraConfig() }));
  route(app, 'POST', 'jira.config.save', MANAGE, async (req, _r, ctx) => saveJiraConfig(ctx, b(req) as JiraConfigInput));
  route(app, 'POST', 'jira.config.test', MANAGE, async () => testConnection());
  route(app, 'POST', 'jira.webhook.rotate', MANAGE, async (req, _r, ctx) => {
    const what = b(req).what === 'secret' ? 'secret' : b(req).what === 'url' ? 'url' : null;
    if (!what) throw badRequest('error-invalid-params', 'Escolha o que gerar de novo: url ou secret.');
    return rotateWebhook(ctx, what);
  });
  route(app, 'POST', 'jira.webhook.ack', MANAGE, async (req) => {
    await ackWebhook(String(b(req).jql ?? ''));
    return {};
  });
  route(app, 'GET', 'jira.rules', MANAGE, async () => ({ rules: await listRules() }));
  route(app, 'POST', 'jira.rules.save', MANAGE, async (req, _r, ctx) => ({ rule: await saveRule(ctx, b(req) as any) }));
  route(app, 'POST', 'jira.rules.remove', MANAGE, async (req, _r, ctx) => {
    await removeRule(ctx, str(b(req)._id, '_id'));
    return {};
  });
  route(app, 'POST', 'jira.rules.preview', MANAGE, async (req) => rulePreview(b(req).projects, b(req).events));

  // ---------- Uso no chat (error-jira-disabled com o Jira desligado ou sem endereço) ----------
  route(app, 'GET', 'jira.projects', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    return listProjects(ctx, { query: q(req).query, forCreate: bool(q(req).forCreate) === true });
  });
  route(app, 'GET', 'jira.search', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const p = q(req);
    // q vazio chega ao searchIssues, que responde "Digite o que procurar." (§11).
    return searchIssues(ctx, { q: str(p.q, 'q', { optional: true, max: 1000 }) ?? '', mode: p.mode === 'jql' ? 'jql' : 'text', nextPageToken: p.nextPageToken || null, max: 20 });
  });
  route(app, 'POST', 'jira.search.more', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const body = b(req);
    // Mesmas regras do comando: "Ver mais" só funciona onde a pessoa pode escrever.
    const room = await loadRoomForUser(ctx, str(body.rid, 'rid'));
    await canPostInRoom(ctx, room);
    const text = str(body.q, 'q', { optional: true, max: 1000 }) ?? '';
    const r = await searchIssues(ctx, { q: text, mode: body.mode === 'jql' ? 'jql' : 'text', nextPageToken: str(body.nextPageToken, 'nextPageToken', { max: 4000 }), max: 10 });
    sendSearchPage(ctx, room, typeof body.tmid === 'string' ? body.tmid : null, r, text);
    return { ok: true };
  });
  route(app, 'GET', 'jira.issue', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const v = await viewIssue(ctx, str(q(req).key, 'key'));
    return { issue: v.issue, canComment: v.canComment, canAssign: v.canAssign };
  });
  route(app, 'GET', 'jira.createMeta', CREATE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    return createMeta(ctx, str(q(req).projectKey, 'projectKey'), str(q(req).roomId, 'roomId'));
  });
  route(app, 'POST', 'jira.issue.create', CREATE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    return createIssue(ctx, b(req) as JiraCreateInput);
  });
  route(app, 'POST', 'jira.issue.comment', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const body = b(req);
    await commentIssue(ctx, { key: str(body.key, 'key'), text: str(body.text, 'text'), public: body.public === true });
    return {};
  });
  route(app, 'POST', 'jira.issue.assign', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const body = b(req);
    const accountId = body.accountId === null || body.accountId === undefined || body.accountId === '' ? null : String(body.accountId);
    return { issue: await assignIssue(ctx, str(body.key, 'key'), accountId) };
  });
  route(app, 'POST', 'jira.issue.share', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const body = b(req);
    return shareIssue(ctx, { key: str(body.key, 'key'), roomId: str(body.roomId, 'roomId'), tmid: typeof body.tmid === 'string' ? body.tmid : null, confirmed: body.confirmed === true });
  });
  route(app, 'GET', 'jira.users.assignable', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    const p = q(req);
    return { users: await assignableUsers(ctx, { key: p.key, projectKey: p.projectKey, query: p.query }) };
  });
  route(app, 'POST', 'jira.preview.remove', {}, async (req, _r, ctx) => {
    await assertJiraEnabled();
    await removePreview(ctx, str(b(req).messageId, 'messageId'));
    return {};
  });
  route(app, 'POST', 'jira.link.token', USE, async (req, _r, ctx) => {
    await assertJiraEnabled();
    return linkToken(ctx, b(req));
  });
  route(app, 'POST', 'jira.link.start', USE, async (req, reply, ctx) => {
    await assertJiraEnabled();
    return startLink(ctx, reply, b(req).returnTo);
  });

  // Retorno do OAuth (sem sessão: a pessoa vem do state e o navegador do cookie) e o webhook do Jira.
  app.get(INTEGRATION_CALLBACK.jira, async (req, reply) => oauthCallback(req, reply));
  registerJiraWebhook(app);
}
