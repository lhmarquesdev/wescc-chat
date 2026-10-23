// Prévias de issues citadas nas mensagens (§4.7). Nunca atrasam o envio: o gancho só põe uma tarefa na fila.
import { jiraSiteAllowed } from '@shared/integrations';
import { forbidden } from '../../lib/errors';
import { integrationAllowedHosts } from '../../lib/safeFetch';
import { getMessage, getMessageRow, setMessageExtra } from '../../services/messages';
import { hasPermission } from '../../services/permissions';
import { getSetting } from '../../services/settings';
import type { Ctx } from '../../services/users';
import { botIds } from '../bots';
import { enqueue, RetryLater, type JobRow } from '../jobs';
import { currentSite, integrationClient, JiraError, jiraOn, TtlCache, toJobError, type JiraClient } from './client';
import { visibleProjects } from './config';
import { ISSUE_FIELDS, pickIssue } from './events';
import { snapshots, visibleFilter } from './issues';
import { extractIssueRefs } from './keys';
import { ISSUE_TEXT } from './texts';

const OWN_KINDS = new Set(['event', 'created', 'share']);

export const unfurlOn = () => jiraOn() && getSetting('Jira_Unfurl_Enabled') === true && visibleProjects().length > 0;
const unfurlMax = () => Math.min(5, Math.max(1, Number(getSetting('Jira_Unfurl_Max') ?? 3) || 3));

// Host do site configurado (só para reconhecer links /browse/ do próprio Jira), sem tocar no banco.
function siteHost(): string | null {
  const r = jiraSiteAllowed(String(getSetting('Jira_Site_Url') ?? ''), integrationAllowedHosts());
  return 'origin' in r ? new URL(r.origin).host : null;
}

export function previewKeys(msg: string): string[] {
  return extractIssueRefs(String(msg ?? ''), { siteHost: siteHost(), projects: visibleProjects(), max: unfurlMax() });
}

// Gancho de message.sent / message.updated: decide sem consultar o Jira.
export async function onMessageForPreview(data: { room: any; message: any }, edited: boolean): Promise<void> {
  if (!unfurlOn()) return;
  const { room, message: m } = data;
  if (!room || !m?._id || room.t === 'l' || m.t) return;
  if (m.jira && OWN_KINDS.has(m.jira.kind)) return;
  if (m.jiraNoPreview) return;
  if (m.u?._id && (await botIds()).includes(m.u._id)) return;
  const keys = previewKeys(m.msg);
  if (!keys.length) {
    if (edited && m.jira?.kind === 'preview') await setMessageExtra(m._id, 'jira', null);
    return;
  }
  // A mesma lista de chaves já mostrada: nada a refazer.
  if (edited && m.jira?.kind === 'preview' && sameKeys(m.jira.issues?.map((i: any) => i.key) ?? [], keys)) return;
  await enqueue('jira.unfurl', { messageId: m._id, keys }, { dedupeKey: `jira.unfurl:${m._id}:${keys.join(',')}`, maxAttempts: 3 });
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// Issues lidas pela conta da integração para prévias (60 s, 500 entradas).
const cache = new TtlCache<any | null>(60_000, 500);

async function issuesByKeys(client: JiraClient, keys: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const missing: string[] = [];
  for (const k of keys) {
    const v = cache.get(k);
    if (v === undefined) missing.push(k);
    else if (v) out.set(k, v);
  }
  if (!missing.length) return out;
  let found: any[];
  try {
    const r = await client.get<any>('/rest/api/3/search/jql', { jql: `issuekey in (${missing.join(', ')})`, fields: ISSUE_FIELDS, maxResults: missing.length });
    found = Array.isArray(r?.issues) ? r.issues : [];
  } catch (e) {
    // Uma chave que não existe faz o Jira recusar a consulta inteira: lê uma por uma.
    if (!(e instanceof JiraError) || e.jiraStatus !== 400) throw e;
    found = [];
    for (const k of missing) {
      try {
        found.push(await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(k)}`, { fields: ISSUE_FIELDS }));
      } catch (err) {
        if (!(err instanceof JiraError) || (err.jiraStatus !== 404 && err.jiraStatus !== 403)) throw err;
      }
    }
  }
  const byKey = new Map(found.map((i) => [String(i?.key ?? ''), pickIssue(i)]));
  for (const k of missing) {
    const v = byKey.get(k) ?? null;
    cache.set(k, v);
    if (v) out.set(k, v);
  }
  return out;
}

export async function unfurlJob(job: JobRow): Promise<void> {
  const p = job.payload as { messageId: string; keys: string[] };
  if (!unfurlOn()) return;
  const row = await getMessageRow(p.messageId);
  if (!row || row.t || row.extra?.jiraNoPreview) return;
  if (row.extra?.jira && OWN_KINDS.has(row.extra.jira.kind)) return;
  // A mensagem mudou depois que a tarefa entrou na fila: a tarefa da edição cuida dela.
  if (!sameKeys(previewKeys(row.msg), p.keys)) return;
  const site = await currentSite();
  if ('problem' in site) return;
  let found: Map<string, any>;
  try {
    found = await issuesByKeys(await integrationClient({ job: true }), p.keys);
  } catch (e) {
    const err = toJobError(e);
    // Uma prévia de minutos atrás já não ajuda: no máximo 3 tentativas (maxAttempts da fila).
    throw err instanceof RetryLater ? err : new RetryLater(err.message);
  }
  const issues = visibleFilter(p.keys.map((k) => found.get(k)).filter(Boolean));
  if (!issues.length) {
    if (row.extra?.jira?.kind === 'preview') await setMessageExtra(row.id, 'jira', null);
    return;
  }
  await setMessageExtra(row.id, 'jira', { kind: 'preview', site: site.origin, issues: await snapshots(issues, site.origin) });
}

// jira.preview.remove: o autor, ou quem pode editar mensagens na sala. Edições depois não recriam a prévia.
export async function removePreview(ctx: Ctx, messageId: string): Promise<void> {
  const m = await getMessage(ctx, messageId);
  if (m.u?._id !== ctx.userId && !(await hasPermission(ctx.userId, 'edit-message', m.rid))) throw forbidden(ISSUE_TEXT.previewForbidden);
  if (m.jira?.kind === 'preview') await setMessageExtra(m._id, 'jira', null);
  await setMessageExtra(m._id, 'jiraNoPreview', true);
}
