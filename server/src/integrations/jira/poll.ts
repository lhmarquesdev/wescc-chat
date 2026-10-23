// Consulta periódica por JQL (modo sem webhook, §4.3): gera os mesmos eventos e chaves do webhook, então trocar de modo não duplica.
import { query } from '../../db/pool';
import { badRequest } from '../../lib/errors';
import { getSetting } from '../../services/settings';
import type { Lease } from '../runtime';
import { activity, getState, mergeState, seen } from '../state';
import { currentSite, integrationClient, JiraError, jiraOn, markConnection, type ConnectionState, type JiraClient } from './client';
import { eventsMode } from './config';
import { commentEvent, fromHistories, fromSearchIssue, ISSUE_FIELDS, projectKeyOf, type NormalizedJiraEvent } from './events';
import { notifyEvent } from './notify';
import { enabledRules } from './rules';
import { CONFIG_TEXT } from './texts';

export interface PollState {
  lastRunStart?: string;
  lastOkAt?: string | null;
  lastCount?: number;
  cursor?: string; // início da última consulta que deu certo (a próxima janela parte daqui)
  errSince?: string | null;
  lastError?: string | null;
  connBefore?: { tone: ConnectionState['tone']; text: string } | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_PAGES = 10;
const MAX_BYTES = 16 * 1024 * 1024;

export const pollIntervalMs = () => Math.min(15, Math.max(1, Number(getSetting('Jira_Poll_Minutes') ?? 2) || 2)) * MIN;
export const pollEnabled = () => jiraOn() && eventsMode() === 'polling';

class LeaseLost extends Error {}

export async function pollJira(lease: Lease): Promise<void> {
  const runStart = new Date();
  // Antes de ler o ponto de partida: uma troca de endereço (§4.2) feita aqui zera jira.poll.
  await currentSite();
  const prev = (await getState<PollState>('jira.poll')) ?? {};
  let count: number;
  try {
    count = await pollOnce(lease, runStart, prev);
  } catch (e) {
    if (e instanceof LeaseLost) return; // outra instância assumiu: ela continua a partir do mesmo ponto
    await pollError(e, runStart, prev);
    throw e; // a atividade de erro (uma por texto por hora) e o alerta jira.poll ficam com o runtime
  }
  await mergeState('jira.poll', { lastRunStart: runStart.toISOString(), lastOkAt: new Date().toISOString(), lastCount: count, cursor: runStart.toISOString(), errSince: null, lastError: null, connBefore: null });
  if (prev.errSince) {
    // A conexão voltou: devolve o estado que ela tinha antes da falha da consulta.
    const st = await getState<ConnectionState>('jira.status');
    if (st?.tone === 'err' && st.text === prev.lastError && prev.connBefore) await markConnection(prev.connBefore.tone, prev.connBefore.text);
  }
}

async function pollError(e: unknown, runStart: Date, prev: PollState) {
  const text = e instanceof Error ? e.message : String(e);
  const errSince = prev.errSince ?? runStart.toISOString();
  let connBefore = prev.connBefore ?? null;
  if (e instanceof JiraError) {
    const st = await getState<ConnectionState>('jira.status');
    if (!prev.errSince && st && st.tone !== 'err') connBefore = { tone: st.tone, text: st.text };
    if (st?.text !== text) await markConnection('err', text).catch(() => {});
  }
  await mergeState('jira.poll', { lastRunStart: runStart.toISOString(), errSince, lastError: text, connBefore });
}

// Uma consulta: janela, busca paginada, históricos longos e comentários; devolve quantas issues vieram.
async function pollOnce(lease: Lease, runStart: Date, prev: PollState): Promise<number> {
  const rules = await enabledRules();
  const projects = [...new Set(rules.flatMap((r) => r.config.projects))].sort();
  if (!projects.length) return 0;
  const site = await currentSite();
  if ('problem' in site) throw badRequest('error-jira-not-configured', site.problem);
  const client = await integrationClient({ job: true });

  // Sem ponto de partida (primeira vez ou troca de site): só o último intervalo, nada de recuperar o passado.
  const now = runStart.getTime();
  const cursor = prev.cursor ? Date.parse(prev.cursor) : NaN;
  const start = new Date(Number.isFinite(cursor) ? Math.max(cursor - 2 * MIN, now - HOUR) : now - pollIntervalMs());
  const minutes = Math.max(1, Math.ceil((now - start.getTime()) / MIN));
  const wantsComments = new Set(rules.filter((r) => r.config.events.includes('commented')).flatMap((r) => r.config.projects));

  const events: NormalizedJiraEvent[] = [];
  let issues = 0;
  let pages = 0;
  let truncated: string | null = null;
  for (let i = 0; i < projects.length; i += 50) {
    // Das mais novas para as mais antigas: passando de 500, ficam de fora as mais antigas da janela.
    const jql = `project in (${projects.slice(i, i + 50).join(', ')}) AND updated >= "-${minutes}m" ORDER BY updated DESC`;
    let token: string | undefined;
    do {
      if (pages >= MAX_PAGES) {
        truncated = jql;
        break;
      }
      if (pages > 0 && !(await lease.renew())) throw new LeaseLost('lease');
      const r = await client.get<any>('/rest/api/3/search/jql', { jql, fields: ISSUE_FIELDS, expand: 'changelog', maxResults: 50, nextPageToken: token }, { maxBytes: MAX_BYTES });
      pages++;
      for (const issue of Array.isArray(r?.issues) ? r.issues : []) {
        issues++;
        events.push(...(await issueEvents(client, issue, start, site.origin, wantsComments)));
      }
      token = typeof r?.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : undefined;
    } while (token);
    if (truncated) break;
  }
  if (truncated) {
    const n = await approximateCount(client, projects, minutes).catch(() => null);
    await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.tooMany(Math.max(n ?? 0, issues + 1)) });
  }

  // Em ordem de acontecimento; cada chave (n:, h:, c:) só uma vez, também entre consultas e com o webhook.
  const unique = new Map<string, NormalizedJiraEvent>();
  for (const ev of events) if (!unique.has(ev.key)) unique.set(ev.key, ev);
  for (const ev of [...unique.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    if (await seen('jira.event', ev.key)) continue;
    try {
      await notifyEvent(ev, site.origin);
    } catch (e) {
      await query(`DELETE FROM integration_seen WHERE scope = 'jira.event' AND key = $1`, [ev.key]).catch(() => {});
      throw e;
    }
  }
  return issues;
}

async function approximateCount(client: JiraClient, projects: string[], minutes: number): Promise<number | null> {
  const r = await client.post<any>('/rest/api/3/search/approximate-count', { jql: `project in (${projects.join(', ')}) AND updated >= "-${minutes}m"` });
  return typeof r?.count === 'number' ? r.count : null;
}

async function issueEvents(client: JiraClient, issue: any, start: Date, origin: string, wantsComments: Set<string>): Promise<NormalizedJiraEvent[]> {
  const out = fromSearchIssue(issue, start, origin);
  const cl = issue?.changelog;
  const total = Number(cl?.total ?? 0);
  const inline = Array.isArray(cl?.histories) ? cl.histories.length : 0;
  if (total > inline) out.push(...fromHistories(issue, await newestHistories(client, String(issue.id), total, start), start));
  if (wantsComments.has(projectKeyOf(issue, String(issue?.key ?? '')))) out.push(...(await newComments(client, issue, start, origin)));
  return out;
}

// Históricos longos: lê do fim mais novo e volta enquanto a página ainda tem mudanças da janela (até 5 páginas).
async function newestHistories(client: JiraClient, issueId: string, total: number, start: Date): Promise<any[]> {
  const out: any[] = [];
  let startAt = Math.max(0, total - 100);
  for (let page = 0; page < 5; page++) {
    const r = await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(issueId)}/changelog`, { startAt, maxResults: 100 });
    const values: any[] = Array.isArray(r?.values) ? r.values : [];
    out.push(...values);
    const times = values.map((h) => Date.parse(h?.created)).filter((t) => Number.isFinite(t));
    const oldest = times.length ? Math.min(...times) : -Infinity;
    if (startAt === 0 || oldest < start.getTime()) break;
    startAt = Math.max(0, startAt - 100);
  }
  return out;
}

// Comentários novos, do mais novo para o mais antigo, parando no primeiro de antes da janela.
async function newComments(client: JiraClient, issue: any, start: Date, origin: string): Promise<NormalizedJiraEvent[]> {
  const r = await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(String(issue.id))}/comment`, { orderBy: '-created', maxResults: 50, expand: 'properties' });
  const serviceDesk = issue?.fields?.project?.projectTypeKey === 'service_desk';
  const out: NormalizedJiraEvent[] = [];
  for (const c of Array.isArray(r?.comments) ? r.comments : []) {
    const at = Date.parse(c?.created);
    if (!Number.isFinite(at) || at < start.getTime()) break;
    out.push(commentEvent(issue, c, origin, serviceDesk));
  }
  return out;
}
