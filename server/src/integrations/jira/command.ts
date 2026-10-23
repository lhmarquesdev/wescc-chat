// /jira (§4.9): toda resposta é efêmera (só quem digitou vê). canPostInRoom vem antes de tudo, porque commands.run não confere.
import type { EphemeralAction, EphemeralMessage, JiraSearchResult } from '@shared/integrations';
import { one } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { canPostInRoom } from '../../services/messages';
import { hasPermission } from '../../services/permissions';
import type { Ctx } from '../../services/users';
import { sendEphemeral, sessionTag } from '../ephemeral';
import { getLinked, removeLinked } from '../linked';
import { jiraEnabled } from './client';
import { userAuthMode } from './config';
import { assignIssue, commentIssue, limited, searchIssues, shareIssue, viewIssue } from './issues';
import { isIssueKey } from './keys';
import { COMMAND_TEXT as T } from './texts';

type Reply = Omit<EphemeralMessage, '_id' | 'ts' | 'rid' | 'tmid' | 'source'>;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Primeira palavra sem acento e em minúsculas → subcomando (aceita os nomes em inglês).
const ALIASES: Record<string, string> = {
  ajuda: 'help',
  help: 'help',
  ver: 'view',
  view: 'view',
  buscar: 'search',
  busca: 'search',
  procurar: 'search',
  search: 'search',
  jql: 'jql',
  criar: 'create',
  create: 'create',
  nova: 'create',
  atribuir: 'assign',
  assign: 'assign',
  comentar: 'comment',
  comment: 'comment',
  compartilhar: 'share',
  share: 'share',
  conectar: 'connect',
  connect: 'connect',
  desconectar: 'disconnect',
  disconnect: 'disconnect',
};

const openAction = (url: string): EphemeralAction => ({ kind: 'url', label: T.actOpen, url });
const linkAction: EphemeralAction = { kind: 'modal', label: T.actConnect, modal: 'jira-link', primary: true };

export async function jiraCommand(ctx: Ctx, room: any, args: string, tmid: string | null) {
  const reply = (r: Reply) => sendEphemeral(ctx.userId, { rid: room.id, tmid: tmid ?? null, source: 'jira', ...r });
  try {
    const answer = await runJira(ctx, room, String(args ?? '').trim(), tmid);
    if (answer) reply(answer);
  } catch (e) {
    reply(errorReply(e));
  }
  return { ok: true, command: 'jira' };
}

function errorReply(e: unknown): Reply {
  if (e instanceof ApiError) {
    const r: Reply = { tone: 'err', text: e.message };
    if (e.errorType === 'error-jira-link-required') r.actions = [linkAction];
    return r;
  }
  return { tone: 'err', text: 'Não foi possível concluir o comando. Tente de novo.' };
}

async function runJira(ctx: Ctx, room: any, args: string, tmid: string | null): Promise<Reply | null> {
  if (!(await jiraEnabled())) return { tone: 'info', text: T.disabled };
  if (!(await hasPermission(ctx.userId, 'use-jira'))) return { tone: 'err', text: T.noPermission };
  // Sala em que a pessoa não pode escrever (DM restrita, canal de avisos, arquivada, silenciada): nada acontece.
  try {
    await canPostInRoom(ctx, room);
  } catch (e) {
    if (e instanceof ApiError) return { tone: 'err', text: e.message };
    throw e;
  }
  if (limited(`command:${ctx.userId}`, 30, 60_000)) return { tone: 'warn', text: T.tooMany };

  const [first = '', ...restWords] = args.split(/\s+/).filter(Boolean);
  const rest = args.slice(args.indexOf(first) + first.length).trim();
  if (!first) return { tone: 'info', text: T.help };
  if (isIssueKey(first.toUpperCase()) && !restWords.length) return view(ctx, first);
  const sub = ALIASES[fold(first)];
  switch (sub) {
    case 'help':
      return { tone: 'info', text: T.help };
    case 'view':
      return rest ? view(ctx, rest.split(/\s+/)[0]) : { tone: 'info', text: T.usageView };
    case 'search':
      if (!rest) return { tone: 'info', text: T.usageSearch };
      return searchReply(room, tmid, await searchIssues(ctx, { q: rest, mode: 'text', max: 10 }), rest);
    case 'jql':
      if (!rest) return { tone: 'info', text: T.usageJql };
      return searchReply(room, tmid, await searchIssues(ctx, { q: rest, mode: 'jql', max: 10 }), rest);
    case 'create':
      return create(ctx, room, tmid, rest);
    case 'assign':
      return assign(ctx, rest);
    case 'comment':
      return comment(ctx, rest);
    case 'share':
      return share(ctx, room, tmid, rest);
    case 'connect':
      if (userAuthMode() === 'off') return { tone: 'info', text: T.connectOff };
      return { tone: 'info', text: T.connect, actions: [linkAction] };
    case 'disconnect':
      return disconnect(ctx);
    default:
      return { tone: 'info', text: T.unknown };
  }
}

async function view(ctx: Ctx, key: string): Promise<Reply> {
  const v = await viewIssue(ctx, key);
  return { tone: 'info', text: '', issues: [v.issue], issueActions: true, actions: [openAction(v.issue.url)] };
}

// Resultado de busca como efêmera; "Ver mais" chama jira.search.more, que manda outra efêmera.
export function searchReply(room: any, tmid: string | null, r: JiraSearchResult, q: string): Reply {
  if (!r.issues.length) return { tone: 'info', text: r.mode === 'jql' ? T.jqlNoResults : T.noResults(q) };
  const out: Reply = { tone: 'info', text: r.mode === 'jql' ? T.jqlResults(r.issues.length) : T.results(r.issues.length, q), issues: r.issues, issueActions: true };
  if (r.nextPageToken) {
    out.actions = [{ kind: 'api', label: T.actMore, endpoint: 'jira.search.more', body: { q, mode: r.mode, nextPageToken: r.nextPageToken, rid: room.id, ...(tmid ? { tmid } : {}) } }];
  }
  return out;
}

// jira.search.more: a próxima página vai como uma nova resposta efêmera.
export function sendSearchPage(ctx: Ctx, room: any, tmid: string | null, r: JiraSearchResult, q: string) {
  const reply = searchReply(room, tmid, r, q);
  return sendEphemeral(ctx.userId, { rid: room.id, tmid: tmid ?? null, source: 'jira', ...reply, ...(r.issues.length ? { text: T.moreResults(r.issues.length) } : {}) });
}

async function create(ctx: Ctx, room: any, tmid: string | null, summary: string): Promise<Reply> {
  if (!(await hasPermission(ctx.userId, 'create-jira-issue'))) return { tone: 'err', text: T.noCreatePermission };
  const params: Record<string, string> = { summary: summary.slice(0, 255), roomId: room.id };
  if (tmid) params.tmid = tmid;
  return {
    tone: 'info',
    text: T.opening,
    actions: [{ kind: 'modal', label: T.actCreate, modal: 'jira-create', params, autoOpen: true, primary: true }],
    autoOpenFor: sessionTag(ctx.sessionId),
  };
}

const ME = new Set(['eu', 'mim', 'me']);
const NOBODY = new Set(['ninguem', 'nenhum', 'none', 'nobody']);

async function assign(ctx: Ctx, rest: string): Promise<Reply> {
  const [rawKey = '', target = ''] = rest.split(/\s+/);
  const key = rawKey.toUpperCase();
  if (!isIssueKey(key) || !target) return { tone: 'info', text: T.usageAssign };
  const pick: EphemeralAction = { kind: 'modal', label: T.actAssign, modal: 'jira-assign', params: { key } };
  const t = fold(target);
  if (ME.has(t)) {
    const snap = await assignIssue(ctx, key, 'me');
    return { tone: 'ok', text: T.assignedMe(snap.key) };
  }
  if (NOBODY.has(t)) {
    const snap = await assignIssue(ctx, key, null);
    return { tone: 'ok', text: T.unassigned(snap.key) };
  }
  const username = target.replace(/^@/, '');
  const u = await one('SELECT id, username, name FROM users WHERE lower(username) = lower($1) AND active', [username]);
  if (!u) return { tone: 'warn', text: T.assigneeUnknown(username), actions: [pick] };
  const name = String(u.name || u.username);
  const linked = await getLinked(u.id, 'jira');
  if (!linked || linked.status !== 'ok' || !linked.externalId) return { tone: 'warn', text: T.assigneeNotLinked(name), actions: [pick] };
  const snap = await assignIssue(ctx, key, linked.externalId);
  return { tone: 'ok', text: T.assignedTo(snap.key, name) };
}

async function comment(ctx: Ctx, rest: string): Promise<Reply> {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  if (!m || !isIssueKey(m[1].toUpperCase())) return { tone: 'info', text: T.usageComment };
  // Pelo comando, sempre interno em projetos do Service Management (D26).
  const r = await commentIssue(ctx, { key: m[1], text: m[2] });
  return { tone: 'ok', text: r.internal ? T.commentedInternal(r.key) : T.commented(r.key), actions: [openAction(r.url)] };
}

async function share(ctx: Ctx, room: any, tmid: string | null, rest: string): Promise<Reply | null> {
  const key = rest.split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!isIssueKey(key)) return { tone: 'info', text: T.usageShare };
  try {
    await shareIssue(ctx, { key, roomId: room.id, tmid });
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.errorType === 'error-jira-share-confirm') {
      return {
        tone: 'warn',
        text: e.message,
        actions: [{ kind: 'api', label: T.actShareAnyway, endpoint: 'jira.issue.share', body: { key, roomId: room.id, ...(tmid ? { tmid } : {}), confirmed: true }, primary: true }],
      };
    }
    throw e;
  }
}

async function disconnect(ctx: Ctx): Promise<Reply> {
  const linked = await getLinked(ctx.userId, 'jira');
  if (!linked) return { tone: 'info', text: T.notConnected };
  await removeLinked(ctx.userId, 'jira');
  return { tone: 'ok', text: linked.method === 'oauth' ? T.disconnectedOauth : T.disconnectedToken };
}

