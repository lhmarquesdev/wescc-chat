// Buscar, ver, criar, comentar, atribuir e compartilhar issues (§4.8). Tudo que vem pela conta da integração passa por visibleFilter.
import type { JiraAssignable, JiraCreateInput, JiraCreateMeta, JiraFieldMeta, JiraIssueSnapshot, JiraIssueTypeMeta, JiraProjectRef, JiraSearchResult, MessageJira } from '@shared/integrations';
import { one, query } from '../../db/pool';
import { ApiError, badRequest, forbidden } from '../../lib/errors';
import { audit } from '../../services/audit';
import { canPostInRoom, getMessage, sendMessage } from '../../services/messages';
import { hasPermission } from '../../services/permissions';
import { loadRoomForUser } from '../../services/rooms';
import { getSetting } from '../../services/settings';
import { actorOf, type Ctx } from '../../services/users';
import { enqueue, PermanentError, type JobRow } from '../jobs';
import { getLinked, userForExternal } from '../linked';
import { seen } from '../state';
import { messagePermalink, plainFromMarkdown, safeExternalText } from '../text';
import { adfDoc, adfParagraphs, adfQuote, adfRule, textToAdf, type AdfNode } from './adf';
import { fallbackAttachment, toSnapshot } from './cards';
import { integrationClient, JiraError, TtlCache, toJobError, userClient, type JiraClient } from './client';
import { createProjects, userAuthMode, visibleProjects } from './config';
import { ISSUE_FIELDS } from './events';
import { mapFields, mapIssueTypes, toJiraFieldValue } from './fields';
import { isIssueKey, projectOfKey } from './keys';
import { enabledRules } from './rules';
import { ISSUE_TEXT } from './texts';

type IdentityName = 'user' | 'integration';

// ---------- Limites por pessoa (na memória desta instância) ----------

const hits = new Map<string, number[]>();
export function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  if (hits.size > 10_000) hits.clear();
  hits.set(key, list);
  return false;
}

const LIMITS = { search: [30, 60_000], create: [10, 60_000], comment: [20, 60_000], assign: [20, 60_000], link: [5, 600_000] } as const;
export function personLimit(userId: string, action: keyof typeof LIMITS) {
  const [max, ms] = LIMITS[action];
  if (limited(`${action}:${userId}`, max, ms)) throw new ApiError(429, 'error-integration-busy', ISSUE_TEXT.busy);
}

// ---------- Identidade ----------

const linkRequired = (text: string) => new ApiError(403, 'error-jira-link-required', text);

// Conta vinculada da pessoa (válida para o site atual), ou null.
export async function linkedClient(userId: string, o: { job?: boolean } = {}): Promise<JiraClient | null> {
  if (userAuthMode() === 'off') return null;
  return userClient(userId, o);
}

async function readClient(ctx: Ctx): Promise<{ client: JiraClient; identity: IdentityName }> {
  const u = await linkedClient(ctx.userId);
  if (u) return { client: u, identity: 'user' };
  return { client: await integrationClient(), identity: 'integration' };
}

// Só projetos visíveis para a empresa e sem nível de segurança: o que a conta da integração pode mostrar a qualquer um.
export function visibleFilter<T extends { fields?: any; key?: string }>(issues: T[]): T[] {
  const visible = new Set(visibleProjects());
  return issues.filter((i) => {
    const project = String(i?.fields?.project?.key ?? '');
    return !!project && visible.has(project) && !i?.fields?.security;
  });
}

// accountId → @usuário de quem vinculou a conta, para o cartão.
async function peopleMap(issues: any[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const i of issues) for (const p of [i?.fields?.assignee, i?.fields?.reporter]) if (p?.accountId) ids.add(String(p.accountId));
  const m = new Map<string, string>();
  for (const id of ids) {
    const u = await userForExternal('jira', id).catch(() => null);
    if (u) m.set(id, u.username);
  }
  return m;
}

export async function snapshots(issues: any[], origin: string): Promise<JiraIssueSnapshot[]> {
  const people = await peopleMap(issues);
  return issues.map((i) => toSnapshot(i, origin, people));
}

// ---------- Busca ----------

// Texto digitado só entra entre aspas, sem aspas, barras e operadores da busca de texto (D24).
export function cleanText(q: string): string {
  return q
    .replace(/[\u0000-\u001f\u007f"\\+\-&|!(){}[\]^~*?:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchIssues(ctx: Ctx, p: { q: string; mode?: 'text' | 'jql'; nextPageToken?: string | null; max: number }): Promise<JiraSearchResult> {
  const q = String(p.q ?? '').trim();
  if ([...q].length > 200) throw badRequest('error-invalid-params', 'A busca pode ter até 200 caracteres.');
  const mode = p.mode === 'jql' ? 'jql' : 'text';
  if (mode === 'text' && isIssueKey(q.toUpperCase()) && !p.nextPageToken) {
    const v = await viewIssue(ctx, q.toUpperCase());
    return { mode, jql: `issuekey = ${v.issue.key}`, issues: [v.issue], nextPageToken: null, identity: v.identity };
  }
  personLimit(ctx.userId, 'search');
  const u = await linkedClient(ctx.userId);
  let jql: string;
  let client: JiraClient;
  if (mode === 'jql') {
    if (!u) throw linkRequired(ISSUE_TEXT.linkForJql);
    if (!q) throw badRequest('error-invalid-params', ISSUE_TEXT.emptyQuery);
    jql = q;
    client = u;
  } else {
    const clean = cleanText(q);
    if (!clean) throw badRequest('error-invalid-params', ISSUE_TEXT.emptyQuery);
    if (u) {
      jql = `text ~ "${clean}" ORDER BY updated DESC`;
      client = u;
    } else {
      const visible = visibleProjects();
      if (!visible.length) throw linkRequired(ISSUE_TEXT.linkToSearch);
      jql = `project in (${visible.join(', ')}) AND text ~ "${clean}" ORDER BY updated DESC`;
      client = await integrationClient();
    }
  }
  const r = await client.get<any>('/rest/api/3/search/jql', { jql, fields: ISSUE_FIELDS, maxResults: p.max, nextPageToken: p.nextPageToken ?? undefined });
  const raw: any[] = Array.isArray(r?.issues) ? r.issues : [];
  const list = u ? raw : visibleFilter(raw);
  return {
    mode,
    jql,
    issues: await snapshots(list, client.origin),
    nextPageToken: typeof r?.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : null,
    identity: u ? 'user' : 'integration',
  };
}

// ---------- Ver ----------

export async function fetchIssue(client: JiraClient, key: string): Promise<any> {
  return client.get<any>(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: ISSUE_FIELDS });
}

const notFoundJira = () => new JiraError(404, 'error-jira-not-found', 'Issue não encontrada, ou sem permissão para vê-la.', undefined, 404);

export interface IssueView {
  issue: JiraIssueSnapshot;
  raw: any;
  origin: string;
  identity: IdentityName;
  canComment: boolean;
  canAssign: boolean;
}

export async function viewIssue(ctx: Ctx, rawKey: string): Promise<IssueView> {
  const key = String(rawKey ?? '').trim().toUpperCase();
  if (!isIssueKey(key)) throw badRequest('error-invalid-params', 'Informe a chave da issue, por exemplo OPS-123.');
  const u = await linkedClient(ctx.userId);
  if (u) {
    const raw = await fetchIssue(u, key);
    return { issue: (await snapshots([raw], u.origin))[0], raw, origin: u.origin, identity: 'user', canComment: true, canAssign: true };
  }
  const visible = visibleProjects();
  if (!visible.length) throw linkRequired(ISSUE_TEXT.linkToSearch);
  if (!visible.includes(projectOfKey(key))) throw linkRequired(ISSUE_TEXT.linkToViewOther);
  const client = await integrationClient();
  const raw = await fetchIssue(client, key);
  // A issue pode ter mudado de projeto (o Jira redireciona a chave antiga): vale o projeto de agora.
  if (!visibleFilter([raw]).length) throw notFoundJira();
  return { issue: (await snapshots([raw], client.origin))[0], raw, origin: client.origin, identity: 'integration', canComment: false, canAssign: false };
}

// ---------- Projetos ----------

const projectCache = new TtlCache<JiraProjectRef[]>(10 * 60_000, 200);

const toProjectRef = (p: any): JiraProjectRef => ({
  id: String(p.id ?? ''),
  key: String(p.key ?? ''),
  name: safeExternalText(String(p.name ?? p.key ?? '')),
  ...(p.projectTypeKey === 'service_desk' ? { serviceDesk: true } : {}),
});

async function searchProjects(client: JiraClient, o: { query?: string; forCreate: boolean }): Promise<JiraProjectRef[]> {
  const ck = `${client.identity.kind === 'user' ? client.identity.userId : 'integration'}:${o.forCreate ? 'create' : 'browse'}:${o.query ?? ''}`;
  const hit = projectCache.get(ck);
  if (hit) return hit;
  const r = await client.get<any>('/rest/api/3/project/search', { maxResults: 50, query: o.query || undefined, action: o.forCreate ? 'create' : undefined });
  const list = (Array.isArray(r?.values) ? r.values : []).filter((p: any) => p?.key).map(toProjectRef);
  projectCache.set(ck, list);
  return list;
}

export async function createIdentity(ctx: Ctx): Promise<{ client: JiraClient | null; identity: IdentityName | 'none' }> {
  const u = await linkedClient(ctx.userId);
  if (u) return { client: u, identity: 'user' };
  if (getSetting('Jira_Create_As_Integration') === true) return { client: await integrationClient(), identity: 'integration' };
  return { client: null, identity: 'none' };
}

export async function listProjects(ctx: Ctx, o: { query?: string; forCreate?: boolean }): Promise<{ projects: JiraProjectRef[]; identity: IdentityName | 'none' }> {
  const query = String(o.query ?? '').trim().slice(0, 100);
  if (o.forCreate) {
    const { client, identity } = await createIdentity(ctx);
    if (!client) return { projects: [], identity };
    return { projects: await creatableProjects(client, query), identity };
  }
  const { client, identity } = await readClient(ctx);
  let list = await searchProjects(client, { query, forCreate: false });
  if (identity === 'integration') {
    const visible = new Set(visibleProjects());
    list = list.filter((p) => visible.has(p.key));
  }
  return { projects: list, identity };
}

async function creatableProjects(client: JiraClient, query = ''): Promise<JiraProjectRef[]> {
  const allowed = createProjects();
  const list = await searchProjects(client, { query, forCreate: true });
  return allowed.length ? list.filter((p) => allowed.includes(p.key)) : list;
}

// ---------- Metadados de criação ----------

const metaCache = new TtlCache<{ project: JiraProjectRef; issueTypes: JiraIssueTypeMeta[]; fields: Record<string, JiraFieldMeta[]>; blockers: Record<string, string[]> }>(10 * 60_000, 200);

async function loadCreateMeta(client: JiraClient, projectKey: string) {
  const ck = `${client.identity.kind === 'user' ? client.identity.userId : 'integration'}:${projectKey}`;
  const hit = metaCache.get(ck);
  if (hit) return hit;
  const project = (await creatableProjects(client)).find((p) => p.key === projectKey);
  if (!project) throw badRequest('error-jira-invalid', ISSUE_TEXT.projectNotAllowed);
  const types = mapIssueTypes(await client.get<any>(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`, { maxResults: 50 }));
  const fields: Record<string, JiraFieldMeta[]> = {};
  const blockers: Record<string, string[]> = {};
  for (const t of types) {
    const m = mapFields(await client.get<any>(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(t.id)}`, { maxResults: 200 }));
    fields[t.id] = m.fields;
    blockers[t.id] = m.blockers;
  }
  const out = { project, issueTypes: types, fields, blockers };
  metaCache.set(ck, out);
  return out;
}

async function postCheck(ctx: Ctx, room: any): Promise<{ canPost: boolean; canPostReason: string | null }> {
  try {
    await canPostInRoom(ctx, room);
    return { canPost: true, canPostReason: null };
  } catch (e) {
    if (e instanceof ApiError) return { canPost: false, canPostReason: e.message };
    throw e;
  }
}

export async function createMeta(ctx: Ctx, projectKeyRaw: string, roomId: string): Promise<JiraCreateMeta> {
  const projectKey = String(projectKeyRaw ?? '').trim().toUpperCase();
  const room = await loadRoomForUser(ctx, roomId);
  const post = await postCheck(ctx, room);
  const { client, identity } = await createIdentity(ctx);
  if (!client) return { project: { id: '', key: projectKey, name: projectKey }, issueTypes: [], fields: {}, blockers: {}, identity: 'none', ...post };
  const m = await loadCreateMeta(client, projectKey);
  return { ...m, identity, ...post };
}

// ---------- Criar ----------

const pad = (n: number) => String(n).padStart(2, '0');
const brDate = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const roomName = (room: any) => String(room?.fname || room?.name || '');

export async function createIssue(ctx: Ctx, input: JiraCreateInput): Promise<{ issue: JiraIssueSnapshot; messageId?: string }> {
  if (!(await hasPermission(ctx.userId, 'use-jira')) || !(await hasPermission(ctx.userId, 'create-jira-issue'))) throw forbidden();
  const roomId = String(input?.roomId ?? '');
  const room = await loadRoomForUser(ctx, roomId);
  let source: any = null;
  if (input.messageId) {
    source = await getMessage(ctx, String(input.messageId));
    if (source.rid !== room.id) throw badRequest('error-invalid-params', ISSUE_TEXT.messageNotFound);
  }
  // Antes de qualquer chamada ao Jira: a resposta na sala segue as regras de envio (DM restrita, canal de avisos…).
  if (input.replyInThread) await canPostInRoom(ctx, room);

  const summary = String(input.summary ?? '').trim();
  if (!summary || [...summary].length > 255) throw badRequest('error-jira-field', ISSUE_TEXT.summary);
  const description = String(input.description ?? '');
  if (description.length > 32000) throw badRequest('error-jira-field', ISSUE_TEXT.description);
  personLimit(ctx.userId, 'create');

  const { client, identity } = await createIdentity(ctx);
  if (!client || identity === 'none') throw linkRequired(ISSUE_TEXT.linkToCreate);
  const projectKey = String(input.projectKey ?? '').trim().toUpperCase();
  const meta = await loadCreateMeta(client, projectKey);
  const type = meta.issueTypes.find((t) => t.id === String(input.issueTypeId ?? ''));
  if (!type) throw badRequest('error-jira-field', ISSUE_TEXT.typeNotFound);
  if (meta.blockers[type.id]?.length) throw badRequest('error-jira-field', ISSUE_TEXT.blockers(meta.blockers[type.id]));

  const siteName = String(getSetting('Site_Name') || 'Chat');
  const me = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  const myName = String(me?.name || me?.username || ctx.username);

  // Descrição: atribuição (conta da integração), o texto da pessoa e a mensagem de origem com o link de volta.
  const blocks: AdfNode[] = [];
  if (identity === 'integration') blocks.push(...adfParagraphs(ISSUE_TEXT.createdBy(myName, ctx.username, siteName)));
  blocks.push(...adfParagraphs(description));
  const permalink = source ? messagePermalink(room, source._id) : null;
  if (source) {
    blocks.push(adfRule());
    blocks.push(...adfParagraphs(ISSUE_TEXT.original(String(source.u?.name || source.u?.username || ''), roomName(room), brDate(new Date(source.ts)))));
    blocks.push(adfQuote(plainFromMarkdown(String(source.msg ?? ''))));
    if (permalink) blocks.push(...adfParagraphs(ISSUE_TEXT.openIn(siteName, permalink)));
  }

  const fields: Record<string, unknown> = { project: { key: projectKey }, issuetype: { id: type.id }, summary, description: adfDoc(blocks) };
  for (const f of meta.fields[type.id] ?? []) {
    let value: unknown;
    if (f.key === 'priority') value = input.priorityId ?? input.fields?.priority;
    else if (f.key === 'assignee') {
      // null = "Sem responsável", escolhido no formulário: vai explícito, senão o Jira põe o responsável padrão do projeto.
      if (input.assigneeAccountId === null && !f.required) {
        fields.assignee = null;
        continue;
      }
      value = input.assigneeAccountId ?? input.fields?.assignee;
    } else value = input.fields?.[f.key];
    const v = toJiraFieldValue(f, value);
    if (v !== undefined) fields[f.key] = v;
  }

  const created = await client.post<any>('/rest/api/3/issue', { fields });
  const key = String(created?.key ?? '');
  const issueId = String(created?.id ?? '');
  if (!key || !issueId) throw new JiraError(502, 'error-jira-unavailable', 'O Jira não respondeu. Tente de novo em alguns minutos.');

  // As regras desta sala não anunciam a criação de novo (UX 5.6).
  const rules = (await enabledRules()).filter((r) => r.config.projects.includes(projectKey) && r.channels.includes(room.id));
  for (const r of rules) await seen('jira.created-from-chat', `${r.id}:${room.id}:${issueId}`);

  let raw: any;
  try {
    raw = await fetchIssue(client, key);
  } catch {
    raw = { id: issueId, key, fields: { summary, issuetype: { name: type.name }, project: { key: projectKey, name: meta.project.name, projectTypeKey: meta.project.serviceDesk ? 'service_desk' : undefined }, status: { name: '' } } };
  }
  const snap = (await snapshots([raw], client.origin))[0];

  if (source && permalink) {
    await enqueue('jira.remotelink', { key, userId: ctx.userId, identity, url: permalink, title: ISSUE_TEXT.remoteTitle(siteName), messageId: source._id }, { maxAttempts: 3 }).catch(() => null);
  }

  let messageId: string | undefined;
  let root: string | null = source ? String(source.tmid || source._id) : null;
  if (input.replyInThread) {
    const jira: MessageJira = { kind: 'created', site: client.origin, issues: [snap], by: { _id: ctx.userId, username: ctx.username, name: myName }, ...(identity === 'integration' ? { viaIntegration: true } : {}) };
    const msg: any = await sendMessage(ctx, { rid: room.id, tmid: root ?? undefined, msg: ISSUE_TEXT.created(snap), jira, attachments: [fallbackAttachment(snap)] }, { internalAttachments: true, integration: true });
    messageId = String(msg._id);
    root ??= messageId;
  }
  if (root) {
    for (const r of rules.filter((x) => x.config.threads)) {
      await query(
        `INSERT INTO jira_threads (integration_id, room_id, issue_id, issue_key, message_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (integration_id, room_id, issue_id) DO NOTHING`,
        [r.id, room.id, issueId, key, root],
      );
    }
  }
  await audit(actorOf(ctx), 'integration.jira.issue.created', { key }, { roomId: room.id, identity, projectKey, ...(source ? { messageId: source._id } : {}) });
  return { issue: snap, ...(messageId ? { messageId } : {}) };
}

// Tarefa jira.remotelink: o link "Mensagem no chat" na issue (3 tentativas).
export async function remoteLinkJob(job: JobRow): Promise<void> {
  const p = job.payload as { key: string; userId: string; identity: IdentityName; url: string; title: string; messageId: string };
  let client: JiraClient | null;
  try {
    client = p.identity === 'user' ? await linkedClient(p.userId, { job: true }) : await integrationClient({ job: true });
  } catch (e) {
    throw toJobError(e);
  }
  if (!client) throw new PermanentError('A conta do Jira da pessoa não está mais conectada.');
  try {
    await client.post(`/rest/api/3/issue/${encodeURIComponent(p.key)}/remotelink`, { globalId: `wescc:${p.messageId}`, object: { url: p.url, title: p.title } });
  } catch (e) {
    throw toJobError(e);
  }
}

// ---------- Comentar e atribuir (sempre com a conta da pessoa) ----------

async function personClient(ctx: Ctx): Promise<JiraClient> {
  const u = await linkedClient(ctx.userId);
  if (!u) throw linkRequired(ISSUE_TEXT.linkToAct);
  return u;
}

export async function commentIssue(ctx: Ctx, p: { key: string; text: string; public?: boolean }): Promise<{ key: string; internal: boolean; url: string }> {
  const key = String(p.key ?? '').trim().toUpperCase();
  if (!isIssueKey(key)) throw badRequest('error-invalid-params', 'Informe a chave da issue, por exemplo OPS-123.');
  const text = String(p.text ?? '');
  if (!text.trim()) throw badRequest('error-invalid-params', ISSUE_TEXT.commentEmpty);
  if (text.length > 10000) throw badRequest('error-invalid-params', ISSUE_TEXT.commentLong);
  const client = await personClient(ctx);
  personLimit(ctx.userId, 'comment');
  const issue = await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: 'project' });
  // Service Management: comentário do chat é interno, a não ser que a pessoa marque como público (D26).
  const internal = issue?.fields?.project?.projectTypeKey === 'service_desk' && p.public !== true;
  const body: Record<string, unknown> = { body: textToAdf(text) };
  if (internal) body.properties = [{ key: 'sd.public.comment', value: { internal: true } }];
  const c = await client.post<any>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, body);
  const realKey = String(issue?.key ?? key);
  return { key: realKey, internal, url: `${client.origin}/browse/${encodeURIComponent(realKey)}${c?.id ? `?focusedCommentId=${encodeURIComponent(String(c.id))}` : ''}` };
}

export async function assignIssue(ctx: Ctx, rawKey: string, accountId: string | null): Promise<JiraIssueSnapshot> {
  const key = String(rawKey ?? '').trim().toUpperCase();
  if (!isIssueKey(key)) throw badRequest('error-invalid-params', 'Informe a chave da issue, por exemplo OPS-123.');
  const client = await personClient(ctx);
  personLimit(ctx.userId, 'assign');
  let target: string | null = accountId;
  if (target === 'me') target = (await getLinked(ctx.userId, 'jira'))?.externalId ?? null;
  if (target !== null && !/^[A-Za-z0-9:_-]{1,128}$/.test(target)) throw badRequest('error-invalid-params', 'Pessoa inválida.');
  await client.put(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId: target });
  const raw = await fetchIssue(client, key);
  return (await snapshots([raw], client.origin))[0];
}

export async function assignableUsers(ctx: Ctx, p: { key?: string; projectKey?: string; query?: string }): Promise<JiraAssignable[]> {
  const client = await personClient(ctx);
  const key = p.key ? String(p.key).trim().toUpperCase() : '';
  const project = p.projectKey ? String(p.projectKey).trim().toUpperCase() : '';
  if (!key && !project) throw badRequest('error-invalid-params', 'Informe a issue ou o projeto.');
  const r = await client.get<any[]>('/rest/api/3/user/assignable/search', {
    ...(key ? { issueKey: key } : { project }),
    query: String(p.query ?? '').slice(0, 100) || undefined,
    maxResults: 20,
  });
  const out: JiraAssignable[] = [];
  for (const u of Array.isArray(r) ? r : []) {
    if (!u?.accountId) continue;
    const linked = await userForExternal('jira', String(u.accountId)).catch(() => null);
    out.push({ accountId: String(u.accountId), displayName: safeExternalText(String(u.displayName ?? '')), ...(linked ? { username: linked.username } : {}) });
  }
  return out;
}

// ---------- Compartilhar na sala (como mensagem normal da pessoa) ----------

export async function shareIssue(ctx: Ctx, p: { key: string; roomId: string; tmid?: string | null; confirmed?: boolean }): Promise<{ messageId: string }> {
  const room = await loadRoomForUser(ctx, String(p.roomId ?? ''));
  await canPostInRoom(ctx, room);
  const v = await viewIssue(ctx, p.key);
  const visible = visibleProjects();
  const restricted = v.identity === 'user' && (!visible.includes(v.issue.project.key) || !!v.raw?.fields?.security);
  if (restricted && p.confirmed !== true) {
    throw new ApiError(409, 'error-jira-share-confirm', ISSUE_TEXT.shareConfirm(roomName(room), v.issue.key));
  }
  const me = await one('SELECT name FROM users WHERE id = $1', [ctx.userId]);
  const jira: MessageJira = { kind: 'share', site: v.origin, issues: [v.issue], by: { _id: ctx.userId, username: ctx.username, ...(me?.name ? { name: me.name } : {}) } };
  const msg: any = await sendMessage(ctx, { rid: room.id, tmid: p.tmid || undefined, msg: ISSUE_TEXT.share(v.issue), jira, attachments: [fallbackAttachment(v.issue)] }, { internalAttachments: true, integration: true });
  if (restricted) await audit(actorOf(ctx), 'integration.jira.issue.shared', { key: v.issue.key }, { roomId: room.id, messageId: msg._id });
  return { messageId: String(msg._id) };
}
