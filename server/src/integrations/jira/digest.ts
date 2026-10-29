// Muitas mudanças de uma regra e sala no mesmo minuto (edição em massa no Jira) viram um resumo (D9).
import type { JiraIssueSnapshot } from '@shared/integrations';
import { sendMessage } from '../../services/messages';
import { getRoom } from '../../services/rooms';
import { getSetting } from '../../services/settings';
import { botCtx, ensureBotUser } from '../bots';
import { PermanentError } from '../jobs';
import { activity, claimPost, markRule, releasePost } from '../state';
import { currentSite } from './client';
import { toSnapshot } from './cards';
import { projectKeyOf } from './events';
import { createdFromChat, failure, matchesRuleJql, postKey, storedSnapshot, type PostPayload } from './notify';
import type { RuleRow } from './rules';
import { digestActivity, digestGenericText, digestLine, digestMore, digestStatusText, postFailed, shortEventText } from './texts';

const MAX_LINES = 50;

export async function postDigest(rule: RuleRow, roomId: string, items: PostPayload[]): Promise<void> {
  const site = await currentSite();
  if ('problem' in site) throw new PermanentError(site.problem);
  const room = await getRoom(roomId);
  if (!room) return;
  items = items.filter((p) => !p.origin || p.origin === site.origin); // lidos no site antigo, antes da troca de endereço

  // O mesmo filtro dos avisos um a um: JQL da regra, issues criadas pelo próprio chat e, na exclusão, o cartão
  // que a sala já viu (o JQL não vale para issue excluída, que o Jira não acha mais).
  const withIssue = items.filter((p) => p.kind !== 'deleted' && p.ev.issue);
  const allowed = await matchesRuleJql(rule, [...new Set(withIssue.map((p) => p.ev.issueKey))]);
  const keep: { p: PostPayload; snap: JiraIssueSnapshot }[] = [];
  for (const p of items) {
    if (p.kind === 'deleted') {
      const stored = await storedSnapshot(rule.id, roomId, p.ev.issueId, site.origin);
      if (stored) keep.push({ p, snap: stored.snap });
      continue;
    }
    if (!p.ev.issue || !allowed.has(p.ev.issueKey)) continue;
    if (p.kind === 'created' && (await createdFromChat(rule.id, roomId, p.ev.issueId))) continue;
    keep.push({ p, snap: toSnapshot(p.ev.issue, site.origin) });
  }
  const claimed: { p: PostPayload; snap: JiraIssueSnapshot; key: string }[] = [];
  for (const k of keep) {
    const key = postKey(rule.id, roomId, k.p.ev.key);
    if (await claimPost(key)) claimed.push({ ...k, key });
  }
  if (!claimed.length) return;

  const n = claimed.length;
  const projects = [...new Set(claimed.map(({ p, snap }) => snap.project.key || projectKeyOf(p.ev.issue, p.ev.issueKey)))].sort();
  // "Mudaram de status para X": a mudança para um status de conclusão chega como "resolvida" (status + resolução).
  const statusTo = (p: PostPayload) => (p.kind === 'status' || p.kind === 'resolved' ? (p.ev.changes.find((c) => c.field === 'status')?.to ?? '') : '');
  const targets = new Set(claimed.map(({ p }) => statusTo(p)));
  const only = [...targets][0];
  const rootText = targets.size === 1 && only ? digestStatusText(n, projects, only) : digestGenericText(n, projects);

  // A lista cabe numa mensagem: até 50 linhas e o tamanho máximo do chat.
  const max = Number(getSetting('Message_MaxAllowedSize') ?? 5000);
  const lines: string[] = [];
  let size = 0;
  for (const { p, snap } of claimed) {
    if (lines.length >= MAX_LINES) break;
    const line = digestLine(snap, shortEventText(p.kind, p.ev, snap), p.kind === 'deleted');
    if (size + line.length + 40 > max) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length < n) lines.push(digestMore(n - lines.length));

  const opts = { skipCommands: true, trusted: true, internalAttachments: true, integration: true };
  let root: any;
  try {
    const bot = await ensureBotUser('jira');
    root = await sendMessage(botCtx(bot), { rid: roomId, msg: rootText, mentionsAllowed: [] }, opts);
  } catch (e) {
    for (const c of claimed) await releasePost(c.key);
    throw failure(e, room);
  }
  try {
    const bot = await ensureBotUser('jira');
    await sendMessage(botCtx(bot), { rid: roomId, msg: lines.join('\n'), tmid: root._id, mentionsAllowed: [] }, opts);
  } catch (e) {
    // A raiz já foi publicada: tentar de novo publicaria outro resumo. Os avisos ficam marcados e o erro aparece na regra.
    const text = postFailed(String(room.name ?? ''), e instanceof Error ? e.message : String(e));
    await markRule(rule.id, false, text);
    await activity({ provider: 'jira', integrationId: rule.id, tone: 'err', text });
    return;
  }
  await markRule(rule.id, true);
  await activity({ provider: 'jira', integrationId: rule.id, tone: 'info', text: digestActivity(n, String(room.name ?? '')) });
}
