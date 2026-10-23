// Teams → Wescc (§5.4): regras msteams-incoming e o processamento de uma mensagem do Teams (comum aos dois modos).
import type { MessageBridge, TeamsChannelRef, TeamsInRule, TeamsInRuleInput } from '@shared/integrations';
import { many, one, query } from '../../db/pool';
import { ApiError, badRequest, notFound } from '../../lib/errors';
import { newId, randomToken } from '../../lib/ids';
import { audit } from '../../services/audit';
import { getMessageRow, removeMessageRow, replaceMessageText, sendMessage } from '../../services/messages';
import { getRoom } from '../../services/rooms';
import { getSetting } from '../../services/settings';
import { actorOf, type Ctx } from '../../services/users';
import { clearAlert } from '../alerts';
import { announce, botCtx, checkTargets, ensureBotUser, prepareTargets, releaseTargets, roomRef } from '../bots';
import { classifyError, PermanentError, RetryLater } from '../jobs';
import { activity, claimPost, getState, markRule, mergeState, publishChanged, releasePost, setState } from '../state';
import { safeExternalText, trustedLinkHost } from '../text';
import { WESCC_MARKER } from './cards';
import { inboundMode } from './config';
import { graph, MsError, odataQuote } from './graph';
import { HTML_TEXT, htmlIsBlank, safeName, teamsMessageText } from './html';
import { flowOwners } from './outgoing';

export const IN_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  modeOff: 'Escolha antes como as mensagens do Teams chegam (aba Conexão).',
  channel: 'Escolha a equipe e o canal do Teams.',
  room: 'Escolha a sala do chat que recebe as mensagens.',
  privateAck: (room: string) => `Este canal do Teams é privado. Confirme que as mensagens dele ficarão visíveis para todos os membros de #${room}.`,
  duplicate: 'Já existe uma regra deste canal do Teams para esta sala.',
  limit: 'Limite de 20 regras de mensagens do Teams atingido.',
  announce: (team: string, channel: string, by: string) => `As mensagens do canal ${team} › ${channel} do Microsoft Teams agora aparecem aqui. Configurado por ${by}.`,
  chatOnly: ' Respostas escritas aqui ficam só no chat.',
  bothWays: ' As mensagens escritas aqui também vão para o Teams.',
  removed: (team: string, channel: string) => `As mensagens do canal ${team} › ${channel} do Microsoft Teams deixaram de aparecer aqui.`,
  forbidden: (account: string) => `A conta de serviço não vê este canal. Inclua ${account} na equipe (e no canal, se for privado).`,
  channelGone: 'O canal do Teams não existe mais.',
  notFound: 'Regra não encontrada.',
  alias: (name: string) => `${name} (Teams)`,
  ownerLookup: (email: string) => `Não foi possível conferir no Microsoft 365 o dono do fluxo ${email}.`,
  unsaved: (reason: string) => `A mensagem do Teams não pôde ser gravada: ${reason}`,
};

export interface InConfig {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  membership: TeamsChannelRef['membership'];
  replies: boolean;
  edits: boolean;
  deletes: boolean;
  grantPublisher: boolean;
  startedAt: string;
}

export interface InRow {
  id: string;
  name: string;
  enabled: boolean;
  channels: string[];
  user_id: string;
  config: InConfig;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}
export type TeamsInRow = InRow;

export interface InState {
  lastEventAt?: string | null;
  deltaLink?: string | null;
  lastReadAt?: string | null;
  subFailingSince?: string | null;
  catchupAt?: string | null;
}

const MAX_RULES = 20;
const MEMBERSHIP = ['standard', 'private', 'shared'] as const;

function normConfig(c: any): InConfig {
  return {
    teamId: String(c?.teamId ?? ''),
    teamName: String(c?.teamName ?? ''),
    channelId: String(c?.channelId ?? ''),
    channelName: String(c?.channelName ?? ''),
    membership: (MEMBERSHIP as readonly string[]).includes(c?.membership) ? c.membership : 'standard',
    replies: c?.replies !== false,
    edits: c?.edits !== false,
    deletes: c?.deletes !== false,
    grantPublisher: c?.grantPublisher === true,
    startedAt: String(c?.startedAt ?? new Date(0).toISOString()),
  };
}

const rowOf = (r: any): InRow => ({ ...r, channels: r.channels ?? [], config: normConfig(r.config) });
export const roomOf = (r: InRow) => r.channels[0] ?? '';
export const stateKey = (ruleId: string) => `msteams.in:${ruleId}`;
export const getInState = async (ruleId: string) => (await getState<InState>(stateKey(ruleId))) ?? {};

export async function listInRows(): Promise<InRow[]> {
  return (await many(`SELECT * FROM integrations WHERE type = 'msteams-incoming' ORDER BY created_at`)).map(rowOf);
}
export async function enabledInRows(): Promise<InRow[]> {
  return (await listInRows()).filter((r) => r.enabled);
}
export async function getInRow(id: string): Promise<InRow | null> {
  const r = await one(`SELECT * FROM integrations WHERE id = $1 AND type = 'msteams-incoming'`, [id]);
  return r ? rowOf(r) : null;
}

export async function mapInRule(r: InRow): Promise<TeamsInRule> {
  const by = r.created_by ? await one('SELECT id, username FROM users WHERE id = $1', [r.created_by]) : null;
  const room = roomOf(r) ? await getRoom(roomOf(r)).catch(() => null) : null;
  const st = await getInState(r.id);
  const sub = await one(`SELECT expires_at FROM msteams_subscriptions WHERE integration_id = $1 AND purpose = 'messages' ORDER BY expires_at DESC LIMIT 1`, [r.id]);
  return {
    _id: r.id,
    name: r.name,
    enabled: r.enabled,
    team: { id: r.config.teamId, name: r.config.teamName },
    channel: { id: r.config.channelId, name: r.config.channelName, membership: r.config.membership },
    roomId: roomOf(r),
    room: room ? roomRef(room) : null,
    replies: r.config.replies,
    edits: r.config.edits,
    deletes: r.config.deletes,
    grantPublisher: r.config.grantPublisher,
    lastEventAt: st.lastEventAt ?? null,
    subscriptionExpiresAt: sub?.expires_at ? new Date(sub.expires_at).toISOString() : null,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdBy: by ? { _id: by.id, username: by.username } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listInRules(): Promise<TeamsInRule[]> {
  return Promise.all((await listInRows()).map(mapInRule));
}

// ---------- Equipes e canais (conta de serviço) ----------

const g = encodeURIComponent;

export async function listTeams(): Promise<{ id: string; name: string }[]> {
  const r = await graph<any>('service', 'GET', '/me/joinedTeams?$select=id,displayName', undefined, { permission: 'Team.ReadBasic.All' });
  return (Array.isArray(r?.value) ? r.value : []).map((t: any) => ({ id: String(t.id), name: safeName(t.displayName, safeExternalText, 256) }));
}

const membershipOf = (v: unknown): TeamsChannelRef['membership'] => (v === 'private' || v === 'shared' ? v : 'standard');

export async function listChannels(teamId: string): Promise<TeamsChannelRef[]> {
  const r = await graph<any>('service', 'GET', `/teams/${g(teamId)}/channels?$select=id,displayName,membershipType`, undefined, { permission: 'Channel.ReadBasic.All' });
  return (Array.isArray(r?.value) ? r.value : []).map((c: any) => ({ id: String(c.id), name: safeName(c.displayName, safeExternalText, 256), membership: membershipOf(c.membershipType) }));
}

export async function serviceUpn(): Promise<string> {
  const st = await getState<{ upn?: string; displayName?: string }>('msteams.service');
  return st?.upn || st?.displayName || 'a conta de serviço';
}

// 403/404 do Graph no canal → os textos do §5.4.
export async function channelError(e: unknown): Promise<Error> {
  if (e instanceof MsError && e.msStatus === 403) return new PermanentError(IN_TEXT.forbidden(await serviceUpn()));
  if (e instanceof MsError && e.msStatus === 404) return new PermanentError(IN_TEXT.channelGone);
  return e instanceof Error ? e : new Error(String(e));
}

// ---------- Salvar ----------

const ruleError = (text: string) => badRequest('error-msteams-rule', text);

async function saverName(ctx: Ctx) {
  const u = await one('SELECT name, username FROM users WHERE id = $1', [ctx.userId]);
  return String(u?.name || u?.username || ctx.username);
}

async function outgoingCovers(roomId: string) {
  return !!(await one(`SELECT 1 FROM integrations WHERE type = 'msteams-outgoing' AND enabled AND $1 = ANY(channels) LIMIT 1`, [roomId]));
}

// Assinaturas (modo notificações): notifications.ts registra quem cria e apaga.
interface SubHooks {
  created(rule: InRow): Promise<void>;
  removed(ruleId: string): Promise<void>;
}
let subHooks: SubHooks | null = null;
export function setSubscriptionHooks(h: SubHooks) {
  subHooks = h;
}

export async function saveInRule(ctx: Ctx, input: Partial<TeamsInRuleInput> & { _id?: string }): Promise<TeamsInRule> {
  const prev = input._id ? await getInRow(String(input._id)) : null;
  if (input._id && !prev) throw notFound('error-not-found', IN_TEXT.notFound);
  if (inboundMode() === 'off') throw ruleError(IN_TEXT.modeOff);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 80) throw ruleError(IN_TEXT.name);
  const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
  const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
  if (!teamId || !channelId || teamId.length > 200 || channelId.length > 200) throw ruleError(IN_TEXT.channel);
  const roomId = typeof input.roomId === 'string' ? input.roomId.trim() : '';
  if (!roomId) throw ruleError(IN_TEXT.room);
  const grantPublisher = input.grantPublisher === true;
  if (!prev && Number((await one(`SELECT count(*)::int AS n FROM integrations WHERE type = 'msteams-incoming'`))?.n ?? 0) >= MAX_RULES) {
    throw badRequest('error-integration-limit', IN_TEXT.limit);
  }

  // O canal precisa ser legível pela conta de serviço.
  let channel: any;
  try {
    channel = await graph<any>('service', 'GET', `/teams/${g(teamId)}/channels/${g(channelId)}?$select=id,displayName,membershipType`, undefined, { permission: 'Channel.ReadBasic.All' });
  } catch (e) {
    if (e instanceof MsError && e.msStatus === 403) throw ruleError(IN_TEXT.forbidden(await serviceUpn()));
    if (e instanceof MsError && e.msStatus === 404) throw ruleError(IN_TEXT.channelGone);
    throw e;
  }
  const teams = await listTeams().catch(() => [] as { id: string; name: string }[]);
  const teamName = teams.find((t) => t.id === teamId)?.name ?? prev?.config.teamName ?? '';
  const membership = membershipOf(channel?.membershipType);

  for (const t of await checkTargets(ctx, 'msteams', [roomId], 'post', grantPublisher)) {
    if (!t.ok) throw badRequest('error-integration-room', t.problem ?? IN_TEXT.room);
  }
  const room = await getRoom(roomId);
  if (membership !== 'standard' && input.acknowledgePrivate !== true) throw ruleError(IN_TEXT.privateAck(String(room?.fname || room?.name || '')));
  const dup = await one(
    `SELECT 1 FROM integrations WHERE type = 'msteams-incoming' AND config->>'channelId' = $1 AND $2 = ANY(channels) AND id <> $3 LIMIT 1`,
    [channelId, roomId, prev?.id ?? ''],
  );
  if (dup) throw ruleError(IN_TEXT.duplicate);

  const bot = await ensureBotUser('msteams');
  await prepareTargets(ctx, 'msteams', [roomId], grantPublisher, 'post');

  const sameChannel = !!prev && prev.config.channelId === channelId && prev.config.teamId === teamId;
  const cfg: InConfig = {
    teamId,
    teamName,
    channelId,
    channelName: safeName(channel?.displayName, safeExternalText, 256),
    membership,
    replies: input.replies !== false,
    edits: input.edits !== false,
    deletes: input.deletes !== false,
    grantPublisher,
    // Sem cópia do passado: só o que chegar depois de a regra existir (ou de trocar de canal).
    startedAt: sameChannel ? prev!.config.startedAt : new Date().toISOString(),
  };
  const enabled = input.enabled !== false;
  let row: InRow;
  if (prev) {
    row = rowOf(
      await one(`UPDATE integrations SET name = $2, enabled = $3, channels = $4, user_id = $5, username = $6, config = $7, updated_at = now() WHERE id = $1 RETURNING *`, [
        prev.id,
        name,
        enabled,
        [roomId],
        bot.id,
        bot.username,
        JSON.stringify(cfg),
      ]),
    );
  } else {
    row = rowOf(
      await one(
        `INSERT INTO integrations (id, type, name, enabled, token, user_id, username, channels, config, created_by)
         VALUES ($1, 'msteams-incoming', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [newId(), name, enabled, randomToken(24).replace(/[^A-Za-z0-9]/g, '').slice(0, 32), bot.id, bot.username, [roomId], JSON.stringify(cfg), ctx.userId],
      ),
    );
  }
  await audit(actorOf(ctx), prev ? 'integration.msteams.rule.updated' : 'integration.msteams.rule.created', { integrationId: row.id }, {
    name: row.name,
    kind: 'incoming',
    room: roomId,
    team: cfg.teamName,
    channel: cfg.channelName,
    membership,
  });

  if (!sameChannel && prev) {
    await setState(stateKey(row.id), null);
    await subHooks?.removed(row.id).catch(() => {});
  }
  const prevRoom = prev ? roomOf(prev) : null;
  if (prevRoom !== roomId) {
    const by = await saverName(ctx);
    const suffix = (await outgoingCovers(roomId)) ? IN_TEXT.bothWays : IN_TEXT.chatOnly;
    await announce('msteams', roomId, `${IN_TEXT.announce(cfg.teamName, cfg.channelName, by)}${suffix}`).catch(() => {});
    if (prevRoom) await leaveRoom(ctx, prev!, prevRoom);
  }
  if (!enabled) await subHooks?.removed(row.id).catch(() => {});
  else if (inboundMode() === 'notifications') {
    try {
      await subHooks?.created(row);
    } catch (e) {
      await markRule(row.id, false, e instanceof Error ? e.message : String(e));
      row = (await getInRow(row.id)) ?? row;
    }
  }
  publishChanged('config');
  return mapInRule(row);
}

async function leaveRoom(ctx: Ctx, rule: InRow, roomId: string) {
  await announce('msteams', roomId, IN_TEXT.removed(rule.config.teamName, rule.config.channelName)).catch(() => {});
  await releaseTargets(ctx, 'msteams', [roomId]).catch((e) => {
    if (!(e instanceof ApiError)) throw e;
  });
}

export async function removeInRule(ctx: Ctx, id: string) {
  const prev = await getInRow(id);
  if (!prev) throw notFound('error-not-found', IN_TEXT.notFound);
  await subHooks?.removed(id).catch(() => {});
  await query(`DELETE FROM integrations WHERE id = $1`, [id]);
  await setState(stateKey(id), null);
  await audit(actorOf(ctx), 'integration.msteams.rule.removed', { integrationId: id }, { name: prev.name, kind: 'incoming' });
  if (roomOf(prev)) await leaveRoom(ctx, prev, roomOf(prev));
  await clearAlert(`msteams.in:${id}`).catch(() => {});
  publishChanged('config');
}

// ---------- Uma mensagem do Teams ----------

const time = (v: unknown) => {
  const t = v ? new Date(String(v)).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

// Donos de fluxo resolvidos para o id no Entra: um cartão publicado "como usuário" pelo dono não volta (H5).
// Achado: guardado 1 dia. Não achado de vez (nenhuma ou várias contas, falta User.Read.All, aplicativo recusado):
// guardado 1 hora, e um cartão sozinho não é espelhado nesse tempo. Falha passageira (rede, 429, 5xx): nada é guardado
// e o erro sobe, para a mensagem ser lida de novo depois; antes ela virava "sem dono" por 1 dia e o cartão sumia.
const OWNER_HIT_MS = 86_400_000;
const OWNER_MISS_MS = 3_600_000;
const ownerIds = new Map<string, { id: string | null; at: number }>();

const passing = (e: unknown) =>
  e instanceof RetryLater || (e instanceof MsError && (e.statusCode === 429 || e.statusCode >= 500)) || !(e instanceof ApiError || e instanceof PermanentError);

async function flowOwnerIds(): Promise<{ ids: Set<string>; unresolved: boolean }> {
  const ids = new Set<string>();
  let unresolved = false;
  for (const email of await flowOwners()) {
    const hit = ownerIds.get(email);
    if (hit && Date.now() - hit.at < (hit.id ? OWNER_HIT_MS : OWNER_MISS_MS)) {
      if (hit.id) ids.add(hit.id);
      else unresolved = true;
      continue;
    }
    let id: string | null = null;
    try {
      const r = await graph<any>('app', 'GET', `/users?$filter=${g(`mail eq ${odataQuote(email)} or userPrincipalName eq ${odataQuote(email)}`)}&$select=id`, undefined, {
        permission: 'User.Read.All',
        interactive: false,
      });
      const list = Array.isArray(r?.value) ? r.value : [];
      id = list.length === 1 ? String(list[0].id) : null;
    } catch (e) {
      if (passing(e)) throw new RetryLater(`${IN_TEXT.ownerLookup(email)} ${e instanceof Error ? e.message : String(e)}`.trim(), e instanceof RetryLater ? e.afterMs : undefined);
      id = null;
    }
    ownerIds.set(email, { id, at: Date.now() });
    if (id) ids.add(id);
    else unresolved = true;
  }
  return { ids, unresolved };
}

const isCard = (a: any) => typeof a?.contentType === 'string' && a.contentType.startsWith('application/vnd.microsoft.card.');

function cardOnly(m: any): boolean {
  const atts: any[] = Array.isArray(m?.attachments) ? m.attachments : [];
  if (!atts.length || !atts.every(isCard)) return false;
  return htmlIsBlank(String(m?.body?.content ?? ''));
}

// Nossos próprios cartões (marcador wescc:) e cartões publicados pelo dono de um fluxo de envio nunca voltam ao chat (H5).
async function ownEcho(m: any): Promise<boolean> {
  const atts: any[] = Array.isArray(m?.attachments) ? m.attachments : [];
  if (atts.some((a) => String(a?.content ?? '').includes(`"${WESCC_MARKER}`))) return true;
  if (!cardOnly(m)) return false;
  const { ids, unresolved } = await flowOwnerIds();
  const author = String(m?.from?.user?.id ?? '');
  // Sem como conferir o dono (falta User.Read.All), um cartão sozinho não é espelhado: melhor faltar que fazer eco.
  return ids.has(author) || unresolved;
}

async function bridgeRow(ruleId: string, teamsId: string) {
  return one(`SELECT * FROM msteams_bridge_messages WHERE integration_id = $1 AND teams_id = $2`, [ruleId, teamsId]);
}

// Exclusão no Teams (deletedDateTime, changeType deleted ou 404 na releitura).
export async function mirrorDelete(rule: InRow, teamsId: string): Promise<boolean> {
  if (!rule.config.deletes) return false;
  const row = await bridgeRow(rule.id, teamsId);
  if (!row) return false;
  const msg = await getMessageRow(row.message_id);
  if (msg && !msg.t) await removeMessageRow(msg);
  await query(`DELETE FROM msteams_bridge_messages WHERE integration_id = $1 AND teams_id = $2`, [rule.id, teamsId]);
  return true;
}

// Uma conversão que falhe (HTML que nada aqui previu) não trava a regra: a mensagem entra como conteúdo escondido.
function messageText(m: any, max: number) {
  try {
    return teamsMessageText(m, { trustedHost: trustedLinkHost, safeText: safeExternalText, max });
  } catch {
    return HTML_TEXT.hidden;
  }
}

function webUrlOf(m: any): string | null {
  try {
    const u = new URL(String(m?.webUrl ?? ''));
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

async function noteEvent(rule: InRow, at: number | null) {
  if (at === null) return;
  const st = await getInState(rule.id);
  const prev = time(st.lastEventAt);
  if (prev === null || at > prev) await mergeState(stateKey(rule.id), { lastEventAt: new Date(at).toISOString() });
}

async function ruleOk(rule: InRow) {
  await markRule(rule.id, true);
  await clearAlert(`msteams.in:${rule.id}`).catch(() => {});
}

// Erro de dado do Postgres (classe 22: byte inválido, U+0000, valor fora do tipo) se repete igual a cada tentativa:
// a mensagem é recusada de vez, para não segurar a fila da regra por horas nem parar a leitura periódica.
const dataError = (e: unknown) => /^22[0-9A-Z]{3}$/.test(String((e as any)?.code ?? ''));

export async function processTeamsMessage(rule: TeamsInRow, m: any, rootId: string | null): Promise<void> {
  try {
    await processMessage(rule, m, rootId);
  } catch (e) {
    if (dataError(e)) throw new PermanentError(IN_TEXT.unsaved((e as Error).message));
    throw e;
  }
}

async function processMessage(rule: TeamsInRow, m: any, rootId: string | null): Promise<void> {
  if (!m || typeof m !== 'object' || !m.id) return;
  const teamsId = String(m.id);
  const created = time(m.createdDateTime);
  const edited = time(m.lastEditedDateTime);
  const known = await bridgeRow(rule.id, teamsId);

  if (known) {
    if (m.deletedDateTime) {
      if (await mirrorDelete(rule, teamsId)) await noteEvent(rule, time(m.deletedDateTime) ?? Date.now());
      await ruleOk(rule);
      return;
    }
    // Só lastEditedDateTime é edição: lastModifiedDateTime muda também com reações (M8).
    const before = time(known.edited_at);
    if (rule.config.edits && edited !== null && (before === null || edited > before)) {
      const msg = await getMessageRow(known.message_id);
      if (msg && !msg.t) {
        const bot = await ensureBotUser('msteams');
        const max = Number(getSetting('Message_MaxAllowedSize') ?? 5000);
        const prefix = msg.msg?.startsWith(HTML_TEXT.olderThread) ? `${HTML_TEXT.olderThread}\n` : '';
        const text = `${prefix}${messageText(m, Math.max(100, max - prefix.length)) || HTML_TEXT.hidden}`;
        const bridge: MessageBridge = { ...(msg.extra?.bridge ?? {}), editedAt: new Date(edited).toISOString() };
        await replaceMessageText(msg.id, text, bot, { bridge });
      }
      await query(`UPDATE msteams_bridge_messages SET edited_at = $3 WHERE integration_id = $1 AND teams_id = $2`, [rule.id, teamsId, new Date(edited).toISOString()]);
      await noteEvent(rule, edited);
    }
    await ruleOk(rule);
    return;
  }

  // ---------- Mensagem nova ----------
  if (m.deletedDateTime) return;
  if (m.messageType !== 'message') return;
  if (m.from?.application || !m.from?.user) return;
  if (created === null || created < (time(rule.config.startedAt) ?? 0)) return;
  if (await ownEcho(m)) return;
  if (rootId && !rule.config.replies) return;

  const roomId = roomOf(rule);
  let tmid: string | null = null;
  let prefix = '';
  if (rootId) {
    const root = await bridgeRow(rule.id, rootId);
    const rootMsg = root ? await getMessageRow(root.message_id) : null;
    if (rootMsg && rootMsg.room_id === roomId) tmid = rootMsg.id;
    else prefix = `${HTML_TEXT.olderThread}\n`;
  }

  const key = `msteams:${rule.id}:${teamsId}`;
  if (!(await claimPost(key))) return;
  try {
    const bot = await ensureBotUser('msteams');
    const max = Number(getSetting('Message_MaxAllowedSize') ?? 5000);
    const body = messageText(m, Math.max(100, max - prefix.length)) || HTML_TEXT.hidden;
    const author = safeName(m.from.user.displayName, safeExternalText) || 'Teams';
    const bridge: MessageBridge = { provider: 'msteams', externalId: teamsId, author, webUrl: webUrlOf(m), editedAt: null };
    const msg = await sendMessage(
      botCtx(bot),
      { rid: roomId, msg: `${prefix}${body}`, tmid, alias: IN_TEXT.alias(author), bridge },
      { skipCommands: true, trusted: true, integration: true },
    );
    await query(
      `INSERT INTO msteams_bridge_messages (integration_id, teams_id, teams_root_id, message_id, edited_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (integration_id, teams_id) DO NOTHING`,
      [rule.id, teamsId, rootId, (msg as any)._id, edited !== null ? new Date(edited).toISOString() : null],
    );
  } catch (e) {
    await releasePost(key);
    const room = await getRoom(roomId).catch(() => null);
    const reason = e instanceof Error ? e.message : String(e);
    const text = `Não foi possível publicar em #${room?.fname || room?.name || roomId}: ${reason}`;
    throw dataError(e) ? new PermanentError(text) : classifyError(e, text);
  }
  await noteEvent(rule, Math.max(created, edited ?? 0));
  await ruleOk(rule);
}

// Leitura em lote (leitura periódica e recuperação): uma mensagem que o chat recusa de vez (tópicos desligados, sala
// arquivada…) fica anotada na atividade da regra e a leitura segue. Antes o erro parava a rodada inteira: o deltaLink
// nunca avançava e a mesma mensagem travava a regra a cada leitura. Erro do Microsoft 365 ou passageiro continua parando.
export async function processOrSkip(rule: TeamsInRow, m: any, rootId: string | null): Promise<void> {
  try {
    await processTeamsMessage(rule, m, rootId);
  } catch (e) {
    const refused = !(e instanceof MsError) && (e instanceof PermanentError || (e instanceof ApiError && [400, 403, 404].includes(e.statusCode)));
    if (!refused) throw e;
    await activity({ provider: 'msteams', integrationId: rule.id, tone: 'err', text: (e as Error).message || 'Mensagem do Teams recusada pelo chat.' });
  }
}

export async function noteInboundActivity(rule: InRow, text: string, tone: 'ok' | 'warn' | 'err' | 'info' = 'warn') {
  await activity({ provider: 'msteams', integrationId: rule.id, tone, text });
}
