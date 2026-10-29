// Wescc → Teams (§5.3): regras msteams-outgoing, gancho message.sent e envio pelo Workflows (Power Automate).
import type { IntegrationRoomRef, MessageJira, TeamsOutFilter, TeamsOutRule, TeamsOutRuleInput } from '@shared/integrations';
import { stickerPreviewText } from '@shared/stickers';
import { many, one, query } from '../../db/pool';
import { ApiError, badRequest, notFound } from '../../lib/errors';
import { newId, randomToken } from '../../lib/ids';
import { aadFor, decryptSecret, encryptSecret, noteKeyUse, secretHint } from '../../lib/secrets';
import { displayUrl, integrationAllowedHosts, safeFetch, SafeFetchError, type SafeResponse } from '../../lib/safeFetch';
import { audit } from '../../services/audit';
import { getMessageRow } from '../../services/messages';
import { getRoom } from '../../services/rooms';
import { getSetting } from '../../services/settings';
import { actorOf, type Ctx } from '../../services/users';
import { clearAlert, raiseAlert } from '../alerts';
import { announce, checkTargets, ensureBotUser, prepareTargets, releaseTargets, roomRef } from '../bots';
import { collapseQueued, enqueue, PermanentError, RetryLater, type JobRow } from '../jobs';
import { activity, claimPost, getState, markRule, publishChanged, releasePost } from '../state';
import { excerpt, messagePermalink, plainFromMarkdown } from '../text';
import { takePost } from './budget';
import { buildCard, buildDigestCard, type CardRoom } from './cards';
import { teamsOn } from './config';
import { appObjectId, appToken } from './graph';

export const OUT_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  logicAzure: 'Este endereço de fluxo é antigo e a Microsoft o desativou. Abra o fluxo no Power Automate e copie o endereço novo.',
  connector: 'Este é um endereço de conector do Office 365, que a Microsoft desativou. Crie um fluxo no Workflows e use o endereço dele.',
  workflowsUrl: 'Use o endereço do fluxo do Workflows (Power Automate). Ele termina em .environment.api.powerplatform.com.',
  rooms: 'Escolha de 1 a 10 salas.',
  keywords: 'Informe de 1 a 20 palavras-chave.',
  destination: 'Diga para onde vão as mensagens, por exemplo Operação › Avisos.',
  flowOwner: 'Informe o e-mail da conta dona do fluxo no Power Automate.',
  budget: 'Escolha 5, 10 ou 20 mensagens a cada 5 minutos.',
  limit: 'Limite de 50 regras de envio para o Teams atingido.',
  announce: (dest: string, by: string) => `As mensagens desta sala agora também vão para o Microsoft Teams (${dest}). Configurado por ${by}.`,
  onlyRoot: ' Só as mensagens principais, sem as respostas em tópicos.',
  onlyAck: ' Só os avisos com “Ciente”.',
  onlyKeywords: (words: string[]) => ` Só as mensagens com: ${words.join(', ')}.`,
  removed: 'As mensagens desta sala deixaram de ir para o Microsoft Teams.',
  grouped: (n: number) => `Muitas mensagens para o Teams: ${n} foram agrupadas num resumo.`,
  delivered: (dest: string) => `Entregue ao fluxo do Workflows (${dest}).`,
  rejected: (snippet: string) => `O Teams recusou o cartão: ${snippet}`,
  authNone: (oid: string) =>
    `O fluxo exige autenticação. Na regra, escolha Autenticar com o aplicativo do Entra; no gatilho do fluxo, escolha Usuários específicos no meu locatário com o ID de objeto ${oid}. (Opção antiga, menos segura: Qualquer pessoa.)`,
  authEntra: (oid: string) => `O fluxo recusou o token do aplicativo. No gatilho do fluxo, escolha Usuários específicos no meu locatário e informe o ID de objeto ${oid}.`,
  noOid: '(configure o aplicativo do Entra na aba Conexão)',
  gone: 'O fluxo não existe mais ou foi desligado. Crie de novo e atualize o endereço na regra.',
  throttled: 'O Power Automate pediu para esperar. Se isso se repetir, diminua o limite da regra.',
  waiting: 'Aguardando o limite do Power Automate.',
  other: (status: number) => `O fluxo respondeu HTTP ${status}.`,
  testText: (room: string) => `Teste: as mensagens de #${room} vão aparecer aqui.`,
  testOk: 'O fluxo aceitou o teste. Se o cartão não aparecer no canal em 1 minuto, abra o histórico de execuções do fluxo no Power Automate.',
  testBudget: 'O limite de posts deste dono do fluxo foi atingido agora. Tente o teste de novo em alguns minutos.',
  notFound: 'Regra não encontrada.',
};

// ---------- Endereço do fluxo ----------

// null quando serve: https em *.environment.api.powerplatform.com (ou host liberado no ambiente do servidor).
export function workflowsUrlProblem(raw: string, allowed: string[] = integrationAllowedHosts()): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return OUT_TEXT.workflowsUrl;
  }
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.logic.azure.com') || host === 'logic.azure.com') return OUT_TEXT.logicAzure;
  if (host === 'webhook.office.com' || host.endsWith('.webhook.office.com') || host === 'outlook.office.com' || host === 'outlook.office365.com') return OUT_TEXT.connector;
  if (u.username || u.password) return OUT_TEXT.workflowsUrl;
  const hostPort = `${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  if (allowed.includes(hostPort) || (!u.port && allowed.includes(host))) return u.protocol === 'https:' || u.protocol === 'http:' ? null : OUT_TEXT.workflowsUrl;
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return OUT_TEXT.workflowsUrl;
  const suffix = '.environment.api.powerplatform.com';
  if (!host.endsWith(suffix) || host.length === suffix.length) return OUT_TEXT.workflowsUrl;
  return null;
}

// ---------- Regras ----------

export interface OutConfig {
  filter: TeamsOutFilter;
  keywords: string[];
  includeBots: boolean;
  includeFiles: boolean;
  includeLink: boolean;
  destinationLabel: string;
  destinationPrivate: boolean;
  flowOwner: string;
  budget: 5 | 10 | 20;
  auth: 'none' | 'entra';
}

export interface OutRow {
  id: string;
  name: string;
  enabled: boolean;
  channels: string[];
  user_id: string;
  secret: string | null;
  config: OutConfig;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

const FILTERS: TeamsOutFilter[] = ['all', 'root', 'ack', 'keywords'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RULES = 50;

function normConfig(c: any): OutConfig {
  const budget = Number(c?.budget);
  return {
    filter: FILTERS.includes(c?.filter) ? c.filter : 'root',
    keywords: Array.isArray(c?.keywords) ? c.keywords.map(String) : [],
    includeBots: c?.includeBots === true,
    includeFiles: c?.includeFiles !== false,
    includeLink: c?.includeLink !== false,
    destinationLabel: String(c?.destinationLabel ?? ''),
    destinationPrivate: c?.destinationPrivate === true,
    flowOwner: String(c?.flowOwner ?? ''),
    budget: (budget === 5 || budget === 20 ? budget : 10) as OutConfig['budget'],
    auth: c?.auth === 'entra' ? 'entra' : 'none',
  };
}

const rowOf = (r: any): OutRow => ({ ...r, channels: r.channels ?? [], config: normConfig(r.config) });

export async function listOutRows(): Promise<OutRow[]> {
  return (await many(`SELECT * FROM integrations WHERE type = 'msteams-outgoing' ORDER BY created_at`)).map(rowOf);
}

export async function getOutRow(id: string): Promise<OutRow | null> {
  const r = await one(`SELECT * FROM integrations WHERE id = $1 AND type = 'msteams-outgoing'`, [id]);
  return r ? rowOf(r) : null;
}

// Regras ligadas por sala, em memória por até 60 s: sem regra para a sala, o gancho volta antes de qualquer consulta.
let snapshot: { byRoom: Map<string, OutRow[]>; owners: Set<string>; at: number } | null = null;
export async function refreshOutSnapshot() {
  const byRoom = new Map<string, OutRow[]>();
  const owners = new Set<string>();
  for (const r of (await listOutRows()).filter((x) => x.enabled)) {
    owners.add(r.config.flowOwner.toLowerCase());
    for (const rid of r.channels) byRoom.set(rid, [...(byRoom.get(rid) ?? []), r]);
  }
  snapshot = { byRoom, owners, at: Date.now() };
  return snapshot;
}
async function current() {
  if (!snapshot || Date.now() - snapshot.at > 60_000) return refreshOutSnapshot();
  return snapshot;
}
export async function flowOwners(): Promise<Set<string>> {
  return (await current()).owners;
}

function decryptUrl(r: OutRow): string | null {
  if (!r.secret) return null;
  return decryptSecret(r.secret, aadFor.rule(r.id));
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

async function roomRefs(ids: string[]): Promise<IntegrationRoomRef[]> {
  if (!ids.length) return [];
  const rows = await many(`SELECT id, name, fname, t, notice, archived, ro FROM rooms WHERE id = ANY($1)`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((r) => roomRef(r));
}

export async function mapOutRule(r: OutRow): Promise<TeamsOutRule> {
  const by = r.created_by ? await one('SELECT id, username FROM users WHERE id = $1', [r.created_by]) : null;
  let url: TeamsOutRule['url'] = { set: false };
  let urlHost: string | null = null;
  if (r.secret) {
    try {
      const plain = decryptUrl(r)!;
      url = { set: true, hint: secretHint(plain), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null };
      urlHost = hostOf(plain);
    } catch {
      url = { set: true, hint: '••••', unreadable: true };
    }
  }
  return {
    _id: r.id,
    name: r.name,
    enabled: r.enabled,
    roomIds: r.channels,
    rooms: await roomRefs(r.channels),
    filter: r.config.filter,
    keywords: r.config.keywords,
    includeBots: r.config.includeBots,
    includeFiles: r.config.includeFiles,
    includeLink: r.config.includeLink,
    destinationLabel: r.config.destinationLabel,
    destinationPrivate: r.config.destinationPrivate,
    flowOwner: r.config.flowOwner,
    budget: r.config.budget,
    auth: r.config.auth,
    url,
    urlHost,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdBy: by ? { _id: by.id, username: by.username } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listOutRules(): Promise<TeamsOutRule[]> {
  return Promise.all((await listOutRows()).map(mapOutRule));
}

const ruleError = (text: string) => badRequest('error-msteams-rule', text);

async function validate(ctx: Ctx, input: any, prev: OutRow | null) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 80) throw ruleError(OUT_TEXT.name);
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!prev && !url) throw ruleError(OUT_TEXT.workflowsUrl);
  if (url) {
    const problem = workflowsUrlProblem(url);
    if (problem) throw ruleError(problem);
  }
  const roomIds = [...new Set((Array.isArray(input.roomIds) ? input.roomIds : []).map(String).filter(Boolean))] as string[];
  if (!roomIds.length || roomIds.length > 10) throw ruleError(OUT_TEXT.rooms);
  const filter: TeamsOutFilter = FILTERS.includes(input.filter) ? input.filter : 'root';
  let keywords: string[] = [];
  if (filter === 'keywords') {
    keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : []).map((k: unknown) => String(k).trim()).filter(Boolean))] as string[];
    if (!keywords.length || keywords.length > 20 || keywords.some((k) => [...k].length > 40)) throw ruleError(OUT_TEXT.keywords);
  }
  const destinationLabel = typeof input.destinationLabel === 'string' ? input.destinationLabel.trim() : '';
  if (!destinationLabel || [...destinationLabel].length > 80) throw ruleError(OUT_TEXT.destination);
  const flowOwner = typeof input.flowOwner === 'string' ? input.flowOwner.trim().toLowerCase() : '';
  if (!EMAIL.test(flowOwner) || flowOwner.length > 254) throw ruleError(OUT_TEXT.flowOwner);
  const budget = Number(input.budget);
  if (![5, 10, 20].includes(budget)) throw ruleError(OUT_TEXT.budget);
  if (!prev && Number((await one(`SELECT count(*)::int AS n FROM integrations WHERE type = 'msteams-outgoing'`))?.n ?? 0) >= MAX_RULES) {
    throw badRequest('error-integration-limit', OUT_TEXT.limit);
  }
  for (const t of await checkTargets(ctx, 'msteams', roomIds, 'read', false)) {
    if (!t.ok) throw badRequest('error-integration-room', t.problem ?? OUT_TEXT.rooms);
  }
  const cfg: OutConfig = {
    filter,
    keywords,
    includeBots: input.includeBots === true,
    includeFiles: input.includeFiles !== false,
    includeLink: input.includeLink !== false,
    destinationLabel,
    destinationPrivate: input.destinationPrivate === true,
    flowOwner,
    budget: budget as OutConfig['budget'],
    auth: input.auth === 'entra' ? 'entra' : 'none',
  };
  return { name, enabled: input.enabled !== false, roomIds, url, cfg };
}

async function saverName(ctx: Ctx) {
  const u = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  return String(u?.name || u?.username || ctx.username);
}

export function announceText(cfg: OutConfig, by: string): string {
  const suffix = cfg.filter === 'root' ? OUT_TEXT.onlyRoot : cfg.filter === 'ack' ? OUT_TEXT.onlyAck : cfg.filter === 'keywords' ? OUT_TEXT.onlyKeywords(cfg.keywords) : '';
  return `${OUT_TEXT.announce(cfg.destinationLabel, by)}${suffix}`;
}

// Outra regra ligada ainda manda esta sala para o Teams?
async function coveredElsewhere(roomId: string, exceptId: string) {
  return !!(await one(`SELECT 1 FROM integrations WHERE type = 'msteams-outgoing' AND enabled AND id <> $1 AND $2 = ANY(channels) LIMIT 1`, [exceptId, roomId]));
}

// A regra deixou de enviar estas salas: aviso na sala (se nenhuma outra regra envia) e o robô sai das que ninguém usa.
async function dropRooms(ctx: Ctx, ruleId: string, roomIds: string[]) {
  for (const rid of roomIds) {
    if (!(await coveredElsewhere(rid, ruleId))) await announce('msteams', rid, OUT_TEXT.removed).catch(() => {});
  }
  await releaseTargets(ctx, 'msteams', roomIds).catch((e) => {
    if (!(e instanceof ApiError)) throw e;
  });
}

export async function saveOutRule(ctx: Ctx, input: Partial<TeamsOutRuleInput> & { _id?: string }): Promise<TeamsOutRule> {
  const prev = input._id ? await getOutRow(String(input._id)) : null;
  if (input._id && !prev) throw notFound('error-not-found', OUT_TEXT.notFound);
  const v = await validate(ctx, input, prev);
  const bot = await ensureBotUser('msteams');
  await prepareTargets(ctx, 'msteams', v.roomIds, false, 'read');

  const id = prev?.id ?? newId();
  let blob: string | null = null;
  if (v.url) {
    blob = encryptSecret(v.url, aadFor.rule(id));
    await noteKeyUse(blob);
  }
  let row: OutRow;
  if (prev) {
    row = rowOf(
      await one(
        `UPDATE integrations SET name = $2, enabled = $3, channels = $4, user_id = $5, username = $6, config = $7, secret = COALESCE($8, secret), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, v.name, v.enabled, v.roomIds, bot.id, bot.username, JSON.stringify(v.cfg), blob],
      ),
    );
  } else {
    row = rowOf(
      await one(
        `INSERT INTO integrations (id, type, name, enabled, token, user_id, username, channels, config, secret, created_by)
         VALUES ($1, 'msteams-outgoing', $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [id, v.name, v.enabled, randomToken(24).replace(/[^A-Za-z0-9]/g, '').slice(0, 32), bot.id, bot.username, v.roomIds, JSON.stringify(v.cfg), blob, ctx.userId],
      ),
    );
  }
  await audit(actorOf(ctx), prev ? 'integration.msteams.rule.updated' : 'integration.msteams.rule.created', { integrationId: row.id }, {
    name: row.name,
    kind: 'outgoing',
    rooms: row.channels,
    destination: v.cfg.destinationLabel,
    urlHost: hostOf(v.url || null) ?? undefined,
  });

  const before = new Set(prev?.channels ?? []);
  const by = await saverName(ctx);
  for (const rid of v.roomIds.filter((r) => !before.has(r))) await announce('msteams', rid, announceText(v.cfg, by)).catch(() => {});
  const dropped = (prev?.channels ?? []).filter((r) => !v.roomIds.includes(r));
  if (dropped.length) await dropRooms(ctx, row.id, dropped);

  await refreshOutSnapshot();
  publishChanged('config');
  return mapOutRule(row);
}

export async function removeOutRule(ctx: Ctx, id: string) {
  const prev = await getOutRow(id);
  if (!prev) throw notFound('error-not-found', OUT_TEXT.notFound);
  await query(`DELETE FROM integrations WHERE id = $1`, [id]);
  await audit(actorOf(ctx), 'integration.msteams.rule.removed', { integrationId: id }, { name: prev.name, kind: 'outgoing' });
  await dropRooms(ctx, id, prev.channels);
  await clearAlert(`msteams.out:${id}`).catch(() => {});
  await refreshOutSnapshot();
  publishChanged('config');
}

// ---------- Fluxo sem uso (conferência diária, §3.14) ----------

export const SILENT_DAYS = 75;
export const silentText = (name: string) =>
  `O fluxo da regra “${name}” não é usado há ${SILENT_DAYS} dias. A Microsoft pode desligar fluxos sem uso por 90 dias.`;

// A Microsoft desliga fluxos sem execução por 90 dias; avisa aos 75. A chave é a mesma do envio que falhou: um
// alerta de erro ativo não é trocado por este aviso, e o aviso some quando a regra volta a enviar ou é desligada.
export async function silentFlowCheck(): Promise<void> {
  const rows = await many(
    `SELECT id, name, enabled, COALESCE(last_ok_at, created_at) < now() - make_interval(days => $1) AS silent
     FROM integrations WHERE type = 'msteams-outgoing'`,
    [SILENT_DAYS],
  );
  for (const r of rows) {
    const key = `msteams.out:${r.id}`;
    const cur = await getState<{ tone?: string }>(`alert:${key}`);
    if (teamsOn() && r.enabled && r.silent) {
      if (cur?.tone !== 'err') await raiseAlert({ key, provider: 'msteams', tone: 'warn', text: silentText(r.name), href: '/admin/integrations/teams/envio', to: 'managers' });
    } else if (cur?.tone === 'warn') await clearAlert(key);
  }
}

// ---------- Gancho message.sent ----------

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterAccepts(cfg: OutConfig, m: { msg?: string; tmid?: string | null; tshow?: boolean; ackRequired?: boolean; sticker?: unknown }): boolean {
  const reply = !!m.tmid && !m.tshow;
  if (cfg.filter === 'root') return !reply;
  if (cfg.filter === 'ack') return !!m.ackRequired;
  if (cfg.filter === 'keywords') {
    const text = fold(String(m.msg ?? ''));
    return cfg.keywords.some((k) => text.includes(fold(k)));
  }
  return true;
}

const userTypes = new Map<string, { type: string; at: number }>();
async function userType(userId: string): Promise<string> {
  const hit = userTypes.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.type;
  const r = await one('SELECT type FROM users WHERE id = $1', [userId]);
  const type = String(r?.type ?? 'user');
  if (userTypes.size > 2000) userTypes.clear();
  userTypes.set(userId, { type, at: Date.now() });
  return type;
}

export interface PostPayload {
  ruleId: string;
  messageId: string;
}

export async function onMessageSent(d: { room: any; message: any; user: { _id: string } | null }) {
  if (!teamsOn()) return;
  const { room, message, user } = d;
  if (!room || (room.t !== 'c' && room.t !== 'p') || room.prid || !message || message.t || message.bridge || !user) return;
  const rules = (await current()).byRoom.get(room.id);
  if (!rules?.length) return;
  const bot = (await ensureBotUser('msteams').catch(() => null))?.id;
  if (bot && user._id === bot) return;
  let botLike: boolean | null = null;
  for (const rule of rules) {
    if (!rule.config.includeBots) {
      if (message.alias) continue;
      if (botLike === null) botLike = ['bot', 'app'].includes(await userType(user._id));
      if (botLike) continue;
    }
    if (!filterAccepts(rule.config, message)) continue;
    await enqueue('msteams.post', { ruleId: rule.id, messageId: message._id } satisfies PostPayload, {
      integrationId: rule.id,
      groupKey: `msteams:${rule.id}`,
      dedupeKey: `msteams.post:${rule.id}:${message._id}`,
    });
  }
}

// ---------- Envio ----------

const siteName = () => String(getSetting('Site_Name') || 'Wescc Chat');
const cardRoom = (room: any): CardRoom => ({ name: String(room?.fname || room?.name || ''), t: room?.t === 'p' ? 'p' : 'c' });

// Menor budget entre as regras ligadas do mesmo dono (todas dividem a conexão dele).
export async function ownerCapacity(owner: string): Promise<number> {
  const r = await one(
    `SELECT min((config->>'budget')::int) AS cap FROM integrations
     WHERE type = 'msteams-outgoing' AND enabled AND lower(config->>'flowOwner') = lower($1) AND (config->>'budget') ~ '^[0-9]+$'`,
    [owner],
  );
  return Number(r?.cap) || 10;
}

const msgText = (m: any) => String(m?.msg || (m?.extra?.sticker ? stickerPreviewText(m.extra.sticker) : ''));

async function cardFor(rule: OutRow, m: any, room: any): Promise<object> {
  let rootExcerpt: string | null = null;
  if (m.tmid) {
    const root = await getMessageRow(m.tmid);
    rootExcerpt = root ? excerpt(plainFromMarkdown(msgText(root)).replace(/\s*\n\s*/g, ' '), 80) || null : null;
  }
  return buildCard({
    ruleId: rule.id,
    messageId: m.id,
    siteName: siteName(),
    room: cardRoom(room),
    author: { name: String(m.user_name || m.username || ''), username: String(m.username ?? '') },
    text: msgText(m),
    at: new Date(m.created_at).toISOString(),
    rootExcerpt,
    files: rule.config.includeFiles ? ((m.files ?? []) as { name?: string }[]).map((f) => ({ name: String(f?.name ?? 'arquivo') })) : [],
    ack: !!m.ack_required,
    link: rule.config.includeLink ? messagePermalink(room, m.id) : null,
    jira: (m.extra?.jira as MessageJira | undefined) ?? null,
  });
}

async function oidText() {
  return (await appObjectId()) || OUT_TEXT.noOid;
}

// POST no fluxo. Erros definitivos (PermanentError) e temporários (RetryLater) com os textos do §5.3; o endereço só
// aparece como https://{host}/… (o caminho leva a assinatura).
export async function postToFlow(rule: OutRow, card: object): Promise<void> {
  let url: string | null;
  try {
    url = decryptUrl(rule);
  } catch (e) {
    throw new PermanentError((e as Error).message);
  }
  if (!url) throw new PermanentError(OUT_TEXT.workflowsUrl);
  const problem = workflowsUrlProblem(url);
  if (problem) throw new PermanentError(problem);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (rule.config.auth === 'entra') {
    try {
      headers.authorization = `Bearer ${await appToken('flow')}`;
    } catch (e) {
      const m = (e as Error).message;
      throw e instanceof ApiError && e.statusCode === 502 ? new RetryLater(m) : new PermanentError(m);
    }
  }
  let res: SafeResponse;
  try {
    res = await safeFetch(url, { method: 'POST', headers, body: JSON.stringify(card), timeoutMs: 20_000, maxBytes: 256 * 1024 });
  } catch (e) {
    if (e instanceof SafeFetchError && (e.code === 'error-url-not-allowed' || e.code === 'error-url-internal' || e.code === 'error-tls' || e.code === 'error-proxy-auth')) {
      throw new PermanentError(`${e.message} (${displayUrl(url)})`);
    }
    throw new RetryLater(`${e instanceof Error ? e.message : String(e)} (${displayUrl(url)})`);
  }
  if (res.status >= 200 && res.status < 300) return;
  const after = (() => {
    const h = res.headers['retry-after'];
    if (!h) return undefined;
    const s = Number(h);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const d = Date.parse(h);
    return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
  })();
  if (res.status === 400) {
    let snippet = '';
    try {
      const j = res.json<any>();
      snippet = String(j?.error?.message ?? j?.message ?? '') || res.text();
    } catch {
      snippet = res.text();
    }
    throw new PermanentError(OUT_TEXT.rejected(excerpt(snippet.replace(/\s+/g, ' ').trim() || 'HTTP 400', 200)));
  }
  if (res.status === 401 || res.status === 403) throw new PermanentError(rule.config.auth === 'entra' ? OUT_TEXT.authEntra(await oidText()) : OUT_TEXT.authNone(await oidText()));
  if (res.status === 404) throw new PermanentError(OUT_TEXT.gone);
  if (res.status === 429) {
    await activity({ provider: 'msteams', integrationId: rule.id, tone: 'warn', text: OUT_TEXT.throttled, detail: 'HTTP 429', onceKey: `flow-429:${rule.id}`, oncePerMs: 3600_000 });
    throw new RetryLater(`${OUT_TEXT.throttled} (HTTP 429)`, after);
  }
  if (res.status >= 500) throw new RetryLater(`O fluxo respondeu HTTP ${res.status} (${displayUrl(url)}).`, after);
  throw new PermanentError(OUT_TEXT.other(res.status));
}

async function delivered(rule: OutRow, jobId: string | null) {
  await markRule(rule.id, true);
  await clearAlert(`msteams.out:${rule.id}`).catch(() => {});
  await activity({ provider: 'msteams', integrationId: rule.id, tone: 'ok', text: OUT_TEXT.delivered(rule.config.destinationLabel), jobId });
}

export async function postJob(job: JobRow): Promise<void> {
  const p = job.payload as PostPayload;
  const rule = await getOutRow(p.ruleId);
  if (!rule || !rule.enabled) return;
  const m = await getMessageRow(p.messageId);
  if (!m || m.t || m.extra?.bridge || !rule.channels.includes(m.room_id)) return;
  const room = await getRoom(m.room_id);
  if (!room) return;

  const budget = await takePost(rule.config.flowOwner, await ownerCapacity(rule.config.flowOwner));
  if (!budget.ok) {
    // Sem vaga no limite do dono: esta e as que esperam viram um resumo daqui a 5 minutos. Nada se perde.
    const group = job.groupKey ?? `msteams:${rule.id}`;
    const merged = (await collapseQueued(group, 'msteams.post', { includeJobId: job.id, minCount: 1, max: 500 })) ?? [job];
    const messageIds = [...new Set(merged.map((j) => String((j.payload as PostPayload)?.messageId ?? '')).filter(Boolean))];
    await enqueue('msteams.digest', { ruleId: rule.id, messageIds }, {
      integrationId: rule.id,
      groupKey: group,
      dedupeKey: `msteams.digest:${rule.id}:${job.id}`,
      runAt: new Date(Date.now() + 5 * 60_000),
    });
    await activity({ provider: 'msteams', integrationId: rule.id, tone: 'warn', text: OUT_TEXT.grouped(messageIds.length), onceKey: `grouped:${rule.id}`, oncePerMs: 3600_000 });
    return;
  }
  // No máximo um cartão por mensagem e regra, mesmo que a tarefa rode de novo depois de entregar.
  const key = `msteams.out:${rule.id}:${m.id}`;
  if (!(await claimPost(key))) return;
  try {
    await postToFlow(rule, await cardFor(rule, m, room));
  } catch (e) {
    await releasePost(key);
    throw e;
  }
  await delivered(rule, job.id);
}

export interface DigestPayload {
  ruleId: string;
  messageIds: string[];
}

const MAX_DIGEST = 500;

export async function digestJob(job: JobRow): Promise<void> {
  const p = job.payload as DigestPayload;
  const rule = await getOutRow(p.ruleId);
  if (!rule || !rule.enabled) return;
  const group = job.groupKey ?? `msteams:${rule.id}`;
  // Junta as mensagens que chegaram enquanto o resumo esperava. Sem includeJobId: o resumo não é uma das tarefas
  // juntadas e termina 'done' (com includeJobId terminava 'merged'). As juntadas aqui ficam marcadas 'merged' com outro
  // dono, então a lista vai para o payload do próprio resumo: uma nova tentativa (sem vaga no limite) volta com elas.
  const known = [...new Set((p.messageIds ?? []).map(String).filter(Boolean))];
  const seen = new Set(known);
  const space = MAX_DIGEST - known.length;
  const more = space > 0 ? ((await collapseQueued(group, 'msteams.post', { minCount: 0, max: space })) ?? []) : [];
  const added = [...new Set(more.map((j) => String((j.payload as PostPayload)?.messageId ?? '')).filter((id) => id && !seen.has(id)))];
  const ids = [...known, ...added];
  if (added.length) await query(`UPDATE integration_jobs SET payload = jsonb_set(payload, '{messageIds}', $2::jsonb) WHERE id = $1`, [job.id, JSON.stringify(ids)]);
  if (!ids.length) return;
  const rows = await many(`SELECT * FROM messages WHERE id = ANY($1) AND t IS NULL ORDER BY created_at, id`, [ids]);
  const msgs = rows.filter((m) => rule.channels.includes(m.room_id));
  if (!msgs.length) return;
  const budget = await takePost(rule.config.flowOwner, await ownerCapacity(rule.config.flowOwner));
  if (!budget.ok) throw new RetryLater(OUT_TEXT.waiting, budget.waitMs, false);
  // Salas na ordem em que aparecem: o cartão diz de qual sala veio cada linha quando há mais de uma.
  const rooms = new Map<string, any>();
  for (const m of msgs) if (!rooms.has(m.room_id)) rooms.set(m.room_id, await getRoom(m.room_id));
  const first = rooms.get(msgs[0].room_id);
  const card = buildDigestCard({
    ruleId: rule.id,
    siteName: siteName(),
    room: cardRoom(first),
    rooms: [...rooms.values()].map(cardRoom),
    items: msgs.slice(0, 5).map((m) => ({ author: String(m.user_name || m.username || ''), text: msgText(m), room: cardRoom(rooms.get(m.room_id)) })),
    total: msgs.length,
    link: rule.config.includeLink && first ? messagePermalink(first, msgs[0].id) : null,
  });
  const key = `msteams.out:${rule.id}:resumo:${job.id}`;
  if (!(await claimPost(key))) return;
  try {
    await postToFlow(rule, card);
  } catch (e) {
    await releasePost(key);
    throw e;
  }
  await delivered(rule, job.id);
}

// "Enviar teste" (manage-msteams): fora da fila, mas gasta um token do limite do dono.
export async function testOutRule(id: string): Promise<{ ok: boolean; text: string }> {
  const rule = await getOutRow(id);
  if (!rule) throw notFound('error-not-found', OUT_TEXT.notFound);
  const room = rule.channels.length ? await getRoom(rule.channels[0]) : null;
  const budget = await takePost(rule.config.flowOwner, await ownerCapacity(rule.config.flowOwner));
  if (!budget.ok) return { ok: false, text: OUT_TEXT.testBudget };
  const site = siteName();
  const card = buildCard({
    ruleId: rule.id,
    messageId: 'teste',
    siteName: site,
    room: cardRoom(room),
    author: { name: site, username: site },
    text: OUT_TEXT.testText(cardRoom(room).name),
    at: new Date().toISOString(),
    files: [],
    ack: false,
    link: null,
  });
  try {
    await postToFlow(rule, card);
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
  await markRule(rule.id, true);
  await clearAlert(`msteams.out:${rule.id}`).catch(() => {});
  return { ok: true, text: OUT_TEXT.testOk };
}

