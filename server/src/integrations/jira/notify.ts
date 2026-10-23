// Evento × regras → tarefas jira.post; publicação no chat pelo robô e tópico por issue (§4.5).
import type { JiraEventInfo, JiraIssueSnapshot, MessageJira } from '@shared/integrations';
import { one, query } from '../../db/pool';
import { getRoom, getSubscriptionRow } from '../../services/rooms';
import { sendMessage } from '../../services/messages';
import { clearAlert } from '../alerts';
import { botCtx, ensureBotUser } from '../bots';
import { classifyError, collapseQueued, enqueue, PermanentError, type JobRow } from '../jobs';
import { userForExternal } from '../linked';
import { activity, claimPost, markRule, releasePost } from '../state';
import { currentSite, integrationClient, TtlCache, toJobError } from './client';
import { eventsMode } from './config';
import { fallbackAttachment, toSnapshot } from './cards';
import { postDigest } from './digest';
import { primaryKind, projectKeyOf, type NormalizedJiraEvent } from './events';
import { enabledRules, getRuleRow, type RuleRow } from './rules';
import { DELETED_STATUS, eventText, postedActivity, postFailed, restrictedSkipped } from './texts';
import type { JiraEventKind } from '@shared/integrations';

export interface PostPayload {
  ruleId: string;
  roomId: string;
  kind: JiraEventKind;
  ev: NormalizedJiraEvent;
  origin: string; // site de onde o evento veio: depois de uma troca de endereço, o aviso não é publicado
}

const DAY = 86_400_000;

// Raiz do tópico da issue nesta regra e sala, se ainda existe e não foi removida. Uma raiz com cartão de outro site
// não serve: o mesmo id é outra issue lá (a troca de endereço limpa os tópicos; isto cobre o que for gravado depois).
export async function threadRoot(ruleId: string, roomId: string, issueId: string, origin: string) {
  return one(
    `SELECT t.message_id FROM jira_threads t JOIN messages m ON m.id = t.message_id
     WHERE t.integration_id = $1 AND t.room_id = $2 AND t.issue_id = $3 AND m.t IS NULL
       AND COALESCE(m.extra->'jira'->>'site', $4) = $4`,
    [ruleId, roomId, issueId, origin],
  );
}

// Exclusão (§4.3): o cartão vem do último aviso desta issue já publicado no tópico, na raiz ou numa resposta.
// A raiz pode ser a mensagem de quem criou a issue pelo chat (UX 5.6), com a prévia de outra issue: por isso a busca
// é pelo id, e só cartões deste site (os ids se repetem entre sites). Sem cartão desta issue no tópico, a sala nunca
// a viu e nada é publicado.
export async function storedSnapshot(ruleId: string, roomId: string, issueId: string, origin: string): Promise<{ root: string; snap: JiraIssueSnapshot } | null> {
  const r = await one(
    `SELECT t.message_id, s.issues FROM jira_threads t
       JOIN messages m ON m.id = t.message_id AND m.t IS NULL
       JOIN LATERAL (
         SELECT x.extra->'jira'->'issues' AS issues FROM messages x
          WHERE x.room_id = t.room_id AND x.t IS NULL AND (x.id = t.message_id OR x.tmid = t.message_id)
            AND x.extra->'jira'->'issues' @> $4::jsonb AND x.extra->'jira'->>'site' = $5
          ORDER BY x.created_at DESC, x.id DESC LIMIT 1
       ) s ON true
      WHERE t.integration_id = $1 AND t.room_id = $2 AND t.issue_id = $3`,
    [ruleId, roomId, issueId, JSON.stringify([{ id: issueId }]), origin],
  );
  const snap = (Array.isArray(r?.issues) ? r.issues : []).find((i: any) => String(i?.id ?? '') === issueId) as JiraIssueSnapshot | undefined;
  return r && snap ? { root: String(r.message_id), snap: { ...snap, status: { ...snap.status, name: DELETED_STATUS } } } : null;
}

// origin: o site de onde o evento foi lido (vai junto na tarefa).
export async function notifyEvent(ev: NormalizedJiraEvent, origin: string): Promise<number> {
  if (ev.restricted || ev.comment?.restricted) {
    await activity({ provider: 'jira', tone: 'info', text: restrictedSkipped(ev.issueKey), onceKey: `jira.restricted:${ev.issueId}`, oncePerMs: DAY });
    return 0;
  }
  const project = projectKeyOf(ev.issue, ev.issueKey);
  const typeName = ev.issue?.fields?.issuetype?.name ?? null;
  const delay = eventsMode() === 'webhook' ? new Date(Date.now() + 5000) : undefined; // junta rajadas (edição em massa) para o resumo
  let queued = 0;
  for (const rule of await enabledRules()) {
    const cfg = rule.config;
    if (!cfg.projects.includes(project)) continue;
    if (ev.kinds[0] !== 'deleted' && cfg.issueTypes.length && !(typeName && cfg.issueTypes.includes(typeName))) continue;
    const kind = primaryKind(ev, cfg.events);
    if (!kind) continue;
    for (const roomId of rule.channels) {
      // Exclusão: só onde a issue já foi avisada (o cartão dela no tópico prova que ela era visível).
      if (kind === 'deleted' && !(await storedSnapshot(rule.id, roomId, ev.issueId, origin))) continue;
      const id = await enqueue('jira.post', { ruleId: rule.id, roomId, kind, ev, origin } satisfies PostPayload, {
        integrationId: rule.id,
        groupKey: `jira:${rule.id}:${roomId}`,
        dedupeKey: `jira.post:${rule.id}:${roomId}:${ev.key}`,
        runAt: delay,
      });
      if (id) queued++;
    }
  }
  return queued;
}

// Filtro JQL da regra: `issuekey = X AND (jql)` com a conta da integração (60 s por regra e issue).
const jqlCache = new TtlCache<boolean>(60_000, 2000);
export async function matchesRuleJql(rule: RuleRow, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!rule.config.jql) return new Set(keys);
  const missing = keys.filter((k) => {
    const v = jqlCache.get(`${rule.id}:${k}`);
    if (v) out.add(k);
    return v === undefined;
  });
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const client = await integrationClient({ job: true });
    let r: any;
    try {
      r = await client.get<any>('/rest/api/3/search/jql', { jql: `issuekey in (${chunk.join(', ')}) AND (${rule.config.jql})`, fields: 'key', maxResults: 100 });
    } catch (e) {
      throw toJobError(e);
    }
    const found = new Set<string>((r?.issues ?? []).map((x: any) => String(x.key)));
    for (const k of chunk) {
      jqlCache.set(`${rule.id}:${k}`, found.has(k));
      if (found.has(k)) out.add(k);
    }
  }
  return out;
}

export async function createdFromChat(ruleId: string, roomId: string, issueId: string) {
  return !!(await one(`SELECT 1 FROM integration_seen WHERE scope = 'jira.created-from-chat' AND key = $1`, [`${ruleId}:${roomId}:${issueId}`]));
}

export const postKey = (ruleId: string, roomId: string, evKey: string) => `jira:${ruleId}:${roomId}:${evKey}`;

// accountId → @usuário de quem vinculou a conta (para o cartão mostrar o @).
export async function peopleOf(issue: any): Promise<Map<string, string>> {
  const ids = [issue?.fields?.assignee?.accountId, issue?.fields?.reporter?.accountId].filter(Boolean) as string[];
  const m = new Map<string, string>();
  for (const id of new Set(ids)) {
    const u = await userForExternal('jira', id).catch(() => null);
    if (u) m.set(id, u.username);
  }
  return m;
}

export function eventInfo(kind: JiraEventKind, ev: NormalizedJiraEvent): JiraEventInfo {
  return {
    kind,
    actor: ev.actor,
    ...(ev.changes.length ? { changes: ev.changes } : {}),
    ...(ev.comment ? { comment: { id: ev.comment.id, excerpt: ev.comment.text, url: ev.comment.url } } : {}),
    at: ev.at,
  };
}

const roomLabel = (room: any) => String(room?.name ?? room?.fname ?? '');

export async function postJob(job: JobRow): Promise<void> {
  const p = job.payload as PostPayload;
  const rule = await getRuleRow(p.ruleId);
  if (!rule || !rule.enabled || !rule.channels.includes(p.roomId)) return;

  const burst = job.groupKey ? await collapseQueued(job.groupKey, 'jira.post', { includeJobId: job.id, minCount: 10, withinMs: 60_000, max: 200 }) : null;
  if (burst) return postDigest(rule, p.roomId, burst.map((j) => j.payload as PostPayload));

  const { ev, kind, roomId } = p;
  if (rule.config.jql && kind !== 'deleted' && !(await matchesRuleJql(rule, [ev.issueKey])).has(ev.issueKey)) return;
  if (kind === 'created' && (await createdFromChat(rule.id, roomId, ev.issueId))) return;

  const site = await currentSite();
  if ('problem' in site) throw new PermanentError(site.problem);
  if (p.origin && p.origin !== site.origin) return; // lido no site antigo, antes da troca de endereço
  const room = await getRoom(roomId);
  if (!room) return;

  let rootId: string | null;
  let snap: JiraIssueSnapshot;
  if (kind === 'deleted') {
    const stored = await storedSnapshot(rule.id, roomId, ev.issueId, site.origin);
    if (!stored) return;
    rootId = stored.root;
    snap = stored.snap;
  } else {
    if (!ev.issue) throw new PermanentError(`${ev.issueKey}: issue sem dados para o cartão.`);
    rootId = (await threadRoot(rule.id, roomId, ev.issueId, site.origin))?.message_id ?? null;
    snap = toSnapshot(ev.issue, site.origin, await peopleOf(ev.issue));
  }

  const key = postKey(rule.id, roomId, ev.key);
  if (!(await claimPost(key))) return;
  try {
    const bot = await ensureBotUser('jira');
    // Menção: só o responsável escolhido, membro da sala, com conta vinculada (D21).
    let mention: string | null = null;
    const assigneeId = ev.assignee?.accountId ?? snap.assignee?.accountId ?? null;
    const self = !!assigneeId && assigneeId === ev.actor?.accountId;
    if (rule.config.mentionAssignee && (kind === 'assigned' || kind === 'created') && assigneeId && !self) {
      const u = await userForExternal('jira', assigneeId);
      if (u && (await getSubscriptionRow(roomId, u.id))) mention = u.username;
    }
    const inThread = !!(rule.config.threads && rootId);
    const jira: MessageJira = { kind: 'event', site: site.origin, issues: [snap], event: eventInfo(kind, ev) };
    const msg = await sendMessage(
      botCtx(bot),
      {
        rid: roomId,
        msg: eventText(kind, ev, snap, { mention }),
        tmid: inThread ? rootId : null,
        tshow: inThread ? kind === 'resolved' || kind === 'deleted' : false,
        jira,
        attachments: [fallbackAttachment(snap)],
        mentionsAllowed: mention ? [mention] : [],
      },
      { skipCommands: true, trusted: true, internalAttachments: true, integration: true },
    );
    if (!inThread && kind !== 'deleted') {
      await query(
        `INSERT INTO jira_threads (integration_id, room_id, issue_id, issue_key, message_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (integration_id, room_id, issue_id) DO UPDATE SET message_id = EXCLUDED.message_id, issue_key = EXCLUDED.issue_key, updated_at = now()`,
        [rule.id, roomId, ev.issueId, snap.key, (msg as any)._id],
      );
    }
  } catch (e) {
    await releasePost(key);
    throw failure(e, room);
  }
  await markRule(rule.id, true);
  await activity({ provider: 'jira', integrationId: rule.id, tone: 'ok', text: postedActivity(snap.key, kind, roomLabel(room)), jobId: job.id });
  await clearAlert(`jira.rule:${rule.id}`).catch(() => {});
}

// Erro ao publicar: definitivo (sala arquivada, robô removido ou silenciado…) leva o nome da sala; a fila marca a
// regra com esse texto e levanta o alerta dela. O resto tenta de novo.
export function failure(e: unknown, room: any): Error {
  const reason = e instanceof Error ? e.message : String(e);
  const err = classifyError(e, reason);
  return err instanceof PermanentError ? new PermanentError(postFailed(roomLabel(room), reason)) : err;
}
