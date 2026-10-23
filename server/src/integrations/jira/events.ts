// Webhook e consulta periódica → NormalizedJiraEvent; comentário restrito (puro).
import type { JiraChange, JiraEventKind, JiraPerson } from '@shared/integrations';
import { excerpt, safeExternalText } from '../text';
import { adfToText, wikiToText } from './adf';

export interface NormalizedJiraEvent {
  key: string; // n:, h:, c:, d:
  kinds: JiraEventKind[]; // um histórico pode trazer status + resolução
  issueId: string;
  issueKey: string;
  issue: any | null; // só os campos do cartão; null até ser relida (webhook) e em "deleted"
  actor: JiraPerson | null;
  changes: JiraChange[];
  comment?: { id: string; text: string; url: string; restricted: boolean };
  restricted: boolean; // nível de segurança
  at: string; // hora do evento no Jira
  assignee?: { accountId: string | null; displayName: string | null }; // novo responsável (kind assigned)
}

export const KIND_ORDER: JiraEventKind[] = ['deleted', 'created', 'resolved', 'status', 'assigned', 'priority', 'commented', 'updated'];

export function primaryKind(e: NormalizedJiraEvent, wanted: JiraEventKind[]): JiraEventKind | null {
  return KIND_ORDER.find((k) => e.kinds.includes(k) && wanted.includes(k)) ?? null;
}

// Campos que o cartão usa; o resto da issue não entra na fila nem no banco.
export const ISSUE_FIELDS = 'summary,status,issuetype,priority,assignee,reporter,project,resolution,security,created,updated';

const person = (p: any): any => (p && typeof p === 'object' ? { accountId: p.accountId, displayName: p.displayName ?? '' } : null);

export function pickIssue(issue: any): any {
  const f = issue?.fields ?? {};
  return {
    id: String(issue?.id ?? ''),
    key: String(issue?.key ?? ''),
    fields: {
      summary: String(f.summary ?? ''),
      status: f.status ? { name: f.status.name ?? '', statusCategory: { key: f.status.statusCategory?.key ?? 'new' } } : null,
      issuetype: f.issuetype ? { name: f.issuetype.name ?? '', subtask: !!f.issuetype.subtask, hierarchyLevel: f.issuetype.hierarchyLevel } : null,
      priority: f.priority ? { name: f.priority.name ?? '' } : null,
      assignee: person(f.assignee),
      reporter: person(f.reporter),
      project: f.project ? { key: f.project.key ?? '', name: f.project.name ?? '', projectTypeKey: f.project.projectTypeKey } : null,
      resolution: f.resolution ? { name: f.resolution.name ?? '' } : null,
      security: f.security ? { id: String(f.security.id ?? '1') } : null,
      created: f.created ?? null,
      updated: f.updated ?? null,
    },
  };
}

export const projectKeyOf = (issue: any, fallbackKey: string) => String(issue?.fields?.project?.key ?? fallbackKey.slice(0, fallbackKey.lastIndexOf('-')));

const safePerson = (p: any): JiraPerson | null =>
  p && typeof p === 'object' && (p.displayName || p.accountId) ? { accountId: p.accountId ? String(p.accountId) : undefined, displayName: safeExternalText(String(p.displayName ?? '')) } : null;
const safe = (v: unknown) => (v === null || v === undefined || v === '' ? null : safeExternalText(String(v)));
// De/para de um histórico: uma Descrição pode ter dezenas de KB e o aviso só mostra um trecho.
const CHANGE_MAX = 300;
const safeValue = (v: unknown) => {
  const s = safe(v);
  return s === null ? null : excerpt(s, CHANGE_MAX);
};

// Campos que não viram aviso (ruído do Jira).
const IGNORED_FIELDS = new Set(['Rank', 'timeestimate', 'timeoriginalestimate', 'timespent', 'WorklogId', 'RemoteIssueLink', 'Workflow']);

export const JIRA_FIELD_LABEL: Record<string, string> = {
  summary: 'Resumo',
  description: 'Descrição',
  labels: 'Rótulos',
  duedate: 'Data de entrega',
  Sprint: 'Sprint',
  'Fix Version': 'Versão de correção',
  Component: 'Componentes',
  issuetype: 'Tipo',
  parent: 'Item pai',
  Attachment: 'Anexos',
  // além da lista do desenho: campos que os históricos do Jira também trazem
  status: 'Status',
  resolution: 'Resolução',
  assignee: 'Responsável',
  priority: 'Prioridade',
  reporter: 'Relator',
  environment: 'Ambiente',
};

// Itens de um histórico → tipos de aviso e mudanças legíveis.
export function classifyItems(items: any[]): { kinds: JiraEventKind[]; changes: JiraChange[]; assignee?: NormalizedJiraEvent['assignee'] } {
  const kinds = new Set<JiraEventKind>();
  const changes: JiraChange[] = [];
  let assignee: NormalizedJiraEvent['assignee'];
  for (const it of Array.isArray(items) ? items : []) {
    const field = String(it?.field ?? it?.fieldId ?? '');
    if (!field || IGNORED_FIELDS.has(field)) continue;
    const id = String(it?.fieldId ?? field);
    const from = safeValue(it?.fromString ?? null);
    const to = safeValue(it?.toString ?? null);
    if (field === 'status') kinds.add('status');
    else if (field === 'resolution' && !it?.from && !it?.fromString && (it?.to || it?.toString)) kinds.add('resolved');
    else if (field === 'assignee') {
      kinds.add('assigned');
      assignee = { accountId: it?.to ? String(it.to) : null, displayName: to };
    } else if (field === 'priority') kinds.add('priority');
    else kinds.add('updated');
    changes.push({ field: id, label: JIRA_FIELD_LABEL[field] ?? safeExternalText(field), from, to });
  }
  return { kinds: [...kinds], changes, assignee };
}

// Comentário que não pode sair do Jira: restrito a grupo ou papel, interno do Service Management,
// ou (fail closed) comentário de Service Management sem nenhuma das duas marcas.
export function commentRestricted(c: any, serviceDesk: boolean): boolean {
  if (!c || typeof c !== 'object') return true;
  if (c.visibility) return true;
  if (c.jsdPublic === false) return true;
  const props: any[] = Array.isArray(c.properties) ? c.properties : [];
  const prop = props.find((p) => p?.key === 'sd.public.comment');
  if (prop?.value?.internal === true) return true;
  if (serviceDesk && c.jsdPublic === undefined && !prop) return true;
  return false;
}

export const commentUrl = (origin: string, key: string, commentId: string) => `${origin}/browse/${key}?focusedCommentId=${encodeURIComponent(commentId)}`;

// Texto de um comentário: ADF (API v3) ou wiki (webhooks antigos) → texto seguro, até 300 caracteres.
export function commentText(body: unknown): string {
  const plain = typeof body === 'string' ? wikiToText(body) : adfToText(body);
  return excerpt(safeExternalText(plain), 300);
}

const iso = (v: unknown, fallback?: string): string => {
  const d = v === undefined || v === null || v === '' ? null : new Date(typeof v === 'number' ? v : String(v));
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : (fallback ?? new Date().toISOString());
};

export function commentEvent(issue: any, c: any, origin: string, serviceDesk: boolean): NormalizedJiraEvent {
  const key = String(issue?.key ?? '');
  return {
    key: `c:${c.id}`,
    kinds: ['commented'],
    issueId: String(issue?.id ?? ''),
    issueKey: key,
    issue: issue?.fields ? pickIssue(issue) : null,
    actor: safePerson(c.author ?? c.updateAuthor),
    changes: [],
    comment: { id: String(c.id), text: commentText(c.body), url: commentUrl(origin, key, String(c.id)), restricted: commentRestricted(c, serviceDesk) },
    restricted: !!issue?.fields?.security,
    at: iso(c.created),
  };
}

// Entrega de outro Jira Cloud (o webhook do site antigo, esquecido depois de uma troca de endereço): os ids de lá são
// outras issues aqui. Devolve a origem de `self` quando ela e a configurada são do Jira Cloud e diferem; sem `self`, ou
// com um endereço liberado no ambiente, não dá para afirmar nada e vale.
const CLOUD_HOST = /^[a-z0-9-]+\.(atlassian\.net|jira\.com)$/i;
export function otherJiraSite(self: unknown, origin: string | null): string | null {
  if (typeof self !== 'string' || !origin) return null;
  let from: URL;
  let site: URL;
  try {
    from = new URL(self);
    site = new URL(origin);
  } catch {
    return null;
  }
  if (from.protocol !== 'https:' || !CLOUD_HOST.test(from.hostname) || !CLOUD_HOST.test(site.hostname)) return null;
  return from.origin === site.origin ? null : from.origin;
}

// Corpo de um webhook do Jira → eventos. A issue do corpo nunca vira cartão: a tarefa relê tudo com a conta da integração.
export function fromWebhook(body: any, origin: string): NormalizedJiraEvent[] {
  const kind = String(body?.webhookEvent ?? '');
  const issue = body?.issue;
  const issueId = String(issue?.id ?? '');
  const issueKey = String(issue?.key ?? '');
  if (!issueId || !issueKey) return [];
  const at = iso(body?.timestamp);
  const restricted = !!issue?.fields?.security;
  const actor = safePerson(body?.user);
  const base = { issueId, issueKey, issue: null, restricted };
  if (kind === 'jira:issue_created') return [{ ...base, key: `n:${issueId}`, kinds: ['created'], actor, changes: [], at }];
  if (kind === 'jira:issue_deleted') return [{ ...base, key: `d:${issueId}`, kinds: ['deleted'], actor, changes: [], at }];
  if (kind === 'jira:issue_updated') {
    const cl = body?.changelog;
    if (!cl?.id) return [];
    const { kinds, changes, assignee } = classifyItems(cl.items);
    if (!kinds.length) return [];
    return [{ ...base, key: `h:${cl.id}`, kinds, actor, changes, at, ...(assignee ? { assignee } : {}) }];
  }
  if (kind === 'comment_created' && body?.comment?.id) {
    const c = body.comment;
    return [
      {
        ...base,
        key: `c:${c.id}`,
        kinds: ['commented'],
        actor: safePerson(c.author) ?? actor,
        changes: [],
        comment: { id: String(c.id), text: commentText(c.body), url: commentUrl(origin, issueKey, String(c.id)), restricted: commentRestricted(c, false) },
        at: iso(c.created, at),
      },
    ];
  }
  return [];
}

// Issue de uma busca (expand=changelog) → criação e mudanças desde `since`. Comentários vêm à parte (poll.ts).
export function fromSearchIssue(issue: any, since: Date, origin: string): NormalizedJiraEvent[] {
  void origin;
  const issueId = String(issue?.id ?? '');
  const issueKey = String(issue?.key ?? '');
  if (!issueId || !issueKey) return [];
  const picked = pickIssue(issue);
  const restricted = !!issue?.fields?.security;
  const out: NormalizedJiraEvent[] = [];
  const created = issue?.fields?.created ? new Date(issue.fields.created) : null;
  if (created && created >= since) {
    out.push({ key: `n:${issueId}`, kinds: ['created'], issueId, issueKey, issue: picked, actor: safePerson(issue.fields.reporter), changes: [], restricted, at: created.toISOString() });
  }
  out.push(...fromHistories(issue, issue?.changelog?.histories ?? [], since));
  return out;
}

// Históricos (da busca ou de /changelog) → mudanças desde `since`, da mais antiga para a mais nova.
export function fromHistories(issue: any, histories: any[], since: Date): NormalizedJiraEvent[] {
  const issueId = String(issue?.id ?? '');
  const issueKey = String(issue?.key ?? '');
  const picked = issue?.fields ? pickIssue(issue) : null;
  const restricted = !!issue?.fields?.security;
  const out: NormalizedJiraEvent[] = [];
  for (const h of Array.isArray(histories) ? histories : []) {
    const at = h?.created ? new Date(h.created) : null;
    if (!h?.id || !at || Number.isNaN(at.getTime()) || at < since) continue;
    const actor = safePerson(h.author);
    const { kinds, changes, assignee } = classifyItems(h.items);
    if (!kinds.length) continue;
    out.push({ key: `h:${h.id}`, kinds, issueId, issueKey, issue: picked, actor, changes, restricted, at: at.toISOString(), ...(assignee ? { assignee } : {}) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
