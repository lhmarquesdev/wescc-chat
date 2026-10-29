import vm from 'node:vm';
import { stickerPreviewText } from '@shared/stickers';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId, randomToken } from '../lib/ids';
import { audit } from '../services/audit';
import { on } from '../services/hooks';
import { sendMessage } from '../services/messages';
import { hasPermission } from '../services/permissions';
import { addUserToRoom, createDirect, getRoom, getRoomByName, getSubscriptionRow } from '../services/rooms';
import { getSetting } from '../services/settings';
import { actorOf, type Ctx } from '../services/users';

// Webhooks de entrada (/hooks/:id/:token) e de saída (eventos do chat → URLs externas),
// no formato das integrações do Rocket.Chat, incluindo scripts opcionais.

export const OUTGOING_EVENTS = ['sendMessage', 'fileUploaded', 'roomArchived', 'roomCreated', 'roomJoined', 'roomLeft', 'userCreated'] as const;
export type OutgoingEvent = (typeof OUTGOING_EVENTS)[number];

// Integrações (Jira/Teams): estes tipos têm telas e serviços próprios; a API genérica não mexe neles.
export const MANAGED_TYPES = ['jira-events', 'msteams-outgoing', 'msteams-incoming'];
function refuseManaged(row: any) {
  if (row && MANAGED_TYPES.includes(row.type)) {
    const where = row.type === 'jira-events' ? 'Jira' : 'Microsoft Teams';
    throw badRequest('error-integration-managed', `Esta integração é configurada em Administração → Integrações → ${where}.`);
  }
}

export function mapIntegration(r: any) {
  const base = {
    _id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.enabled,
    username: r.username,
    userId: r.user_id,
    channel: r.channels,
    alias: r.alias ?? undefined,
    avatar: r.avatar ?? undefined,
    emoji: r.emoji ?? undefined,
    scriptEnabled: r.script_enabled,
    script: r.script,
    token: r.token,
    _createdBy: r.created_by,
    _createdAt: r.created_at,
    _updatedAt: r.updated_at,
  };
  if (r.type === 'webhook-incoming') return base;
  return {
    ...base,
    event: r.event,
    urls: r.urls,
    triggerWords: r.trigger_words,
    triggerWordAnywhere: r.trigger_word_anywhere,
    impersonateUser: r.impersonate_user,
    runOnEdits: r.run_on_edits,
    retryFailedCalls: r.retry_failed_calls,
    retryCount: r.retry_count,
    retryDelay: r.retry_delay,
    targetRoom: r.target_room ?? undefined,
  };
}

async function canManage(ctx: Ctx, row?: any) {
  if (await hasPermission(ctx.userId, 'manage-integrations')) return true;
  if (await hasPermission(ctx.userId, 'manage-own-integrations')) return !row || row.created_by === ctx.userId;
  return false;
}

function normalizeChannels(v: unknown): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  return list.map((c) => String(c).trim()).filter(Boolean);
}

export interface IntegrationInput {
  type: 'webhook-incoming' | 'webhook-outgoing';
  name: string;
  enabled?: boolean;
  username: string;
  channel?: string | string[];
  event?: string;
  urls?: string[];
  triggerWords?: string[];
  triggerWordAnywhere?: boolean;
  alias?: string;
  avatar?: string;
  emoji?: string;
  impersonateUser?: boolean;
  runOnEdits?: boolean;
  retryFailedCalls?: boolean;
  retryCount?: number;
  retryDelay?: string;
  targetRoom?: string;
  scriptEnabled?: boolean;
  script?: string;
}

async function validate(input: IntegrationInput) {
  if (!['webhook-incoming', 'webhook-outgoing'].includes(input.type)) throw badRequest('error-invalid-type', 'Tipo de integração inválido.');
  if (!input.name?.trim()) throw badRequest('error-invalid-name', 'Informe um nome.');
  const user = await one('SELECT id, username FROM users WHERE lower(username) = lower($1) AND active', [String(input.username ?? '').replace(/^@/, '')]);
  if (!user) throw badRequest('error-invalid-user', 'Usuário para publicar não encontrado.');
  // Integrações (Jira/Teams): ninguém publica como o robô oficial do Jira ou do Teams por um webhook genérico.
  if (await one(`SELECT 1 FROM integration_state WHERE id IN ('bot.jira', 'bot.msteams') AND data->>'id' = $1`, [user.id])) {
    throw badRequest('error-invalid-user', 'O robô do Jira ou do Teams não pode publicar por um webhook.');
  }
  const channels = normalizeChannels(input.channel);
  if (input.type === 'webhook-incoming' && !channels.length) throw badRequest('error-invalid-channel', 'Informe o canal de destino (#canal ou @usuário).');
  if (input.type === 'webhook-outgoing') {
    if (!OUTGOING_EVENTS.includes(input.event as OutgoingEvent)) throw badRequest('error-invalid-event', 'Evento inválido.');
    const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) throw badRequest('error-invalid-urls', 'Informe ao menos uma URL.');
    for (const u of urls) {
      try {
        const p = new URL(u);
        if (!['http:', 'https:'].includes(p.protocol)) throw new Error();
      } catch {
        throw badRequest('error-invalid-urls', `URL inválida: ${u}`);
      }
    }
  }
  if (input.script) compileScript(input.script); // erros de sintaxe voltam ao administrador
  return { user, channels };
}

export async function createIntegration(ctx: Ctx, input: IntegrationInput) {
  if (!(await canManage(ctx))) throw forbidden();
  const { user, channels } = await validate(input);
  const row = await one(
    `INSERT INTO integrations (id, type, name, enabled, token, user_id, username, channels, event, trigger_words, trigger_word_anywhere, urls,
       alias, avatar, emoji, impersonate_user, run_on_edits, retry_failed_calls, retry_count, retry_delay, target_room, script_enabled, script, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [
      newId(),
      input.type,
      input.name.trim(),
      input.enabled ?? true,
      randomToken(24).replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
      user.id,
      user.username,
      channels,
      input.type === 'webhook-outgoing' ? input.event : null,
      (input.triggerWords ?? []).map((w) => w.trim()).filter(Boolean),
      input.triggerWordAnywhere ?? false,
      (input.urls ?? []).map((u) => u.trim()).filter(Boolean),
      input.alias || null,
      input.avatar || null,
      input.emoji || null,
      input.impersonateUser ?? false,
      input.runOnEdits ?? false,
      input.retryFailedCalls ?? true,
      Math.min(10, Math.max(0, input.retryCount ?? 5)),
      input.retryDelay ?? 'powers-of-ten',
      input.targetRoom || null,
      input.scriptEnabled ?? false,
      input.script ?? '',
      ctx.userId,
    ],
  );
  await audit(actorOf(ctx), 'integration.created', { integrationId: row.id, name: row.name, type: row.type });
  return mapIntegration(row);
}

export async function updateIntegration(ctx: Ctx, id: string, input: IntegrationInput) {
  const cur = await one('SELECT * FROM integrations WHERE id = $1', [id]);
  if (!cur) throw notFound('error-invalid-integration', 'Integração não encontrada.');
  refuseManaged(cur);
  if (!(await canManage(ctx, cur))) throw forbidden();
  const { user, channels } = await validate({ ...input, type: cur.type });
  const row = await one(
    `UPDATE integrations SET name=$2, enabled=$3, user_id=$4, username=$5, channels=$6, event=$7, trigger_words=$8, trigger_word_anywhere=$9, urls=$10,
       alias=$11, avatar=$12, emoji=$13, impersonate_user=$14, run_on_edits=$15, retry_failed_calls=$16, retry_count=$17, retry_delay=$18, target_room=$19,
       script_enabled=$20, script=$21, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      id,
      input.name.trim(),
      input.enabled ?? cur.enabled,
      user.id,
      user.username,
      channels,
      cur.type === 'webhook-outgoing' ? input.event : null,
      (input.triggerWords ?? []).map((w) => w.trim()).filter(Boolean),
      input.triggerWordAnywhere ?? false,
      (input.urls ?? []).map((u) => u.trim()).filter(Boolean),
      input.alias || null,
      input.avatar || null,
      input.emoji || null,
      input.impersonateUser ?? false,
      input.runOnEdits ?? false,
      input.retryFailedCalls ?? true,
      Math.min(10, Math.max(0, input.retryCount ?? 5)),
      input.retryDelay ?? 'powers-of-ten',
      input.targetRoom || null,
      input.scriptEnabled ?? false,
      input.script ?? '',
    ],
  );
  await audit(actorOf(ctx), 'integration.updated', { integrationId: id, name: row.name });
  return mapIntegration(row);
}

export async function removeIntegration(ctx: Ctx, id: string) {
  const cur = await one('SELECT * FROM integrations WHERE id = $1', [id]);
  if (!cur) throw notFound('error-invalid-integration', 'Integração não encontrada.');
  refuseManaged(cur);
  if (!(await canManage(ctx, cur))) throw forbidden();
  await query('DELETE FROM integrations WHERE id = $1', [id]);
  await audit(actorOf(ctx), 'integration.removed', { integrationId: id, name: cur.name });
}

export async function listIntegrations(ctx: Ctx, opts: { type?: string; name?: string; offset: number; count: number }) {
  const all = await hasPermission(ctx.userId, 'manage-integrations');
  if (!all && !(await hasPermission(ctx.userId, 'manage-own-integrations'))) throw forbidden();
  const where: string[] = [];
  const params: unknown[] = [];
  if (!all) where.push(`created_by = $${params.push(ctx.userId)}`);
  // Integrações (Jira/Teams): os tipos próprios não passam por aqui; sem tipo, só os webhooks genéricos.
  refuseManaged({ type: opts.type });
  if (opts.type) where.push(`type = $${params.push(opts.type)}`);
  else where.push(`type IN ('webhook-incoming', 'webhook-outgoing')`);
  if (opts.name) where.push(`name ILIKE $${params.push(`%${opts.name}%`)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await many(`SELECT * FROM integrations ${w} ORDER BY created_at DESC OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`, params);
  const total = await one(`SELECT count(*)::int AS n FROM integrations ${w}`, params.slice(0, params.length - 2));
  return { integrations: rows.map(mapIntegration), offset: opts.offset, count: rows.length, total: total.n };
}

export async function getIntegration(ctx: Ctx, id: string) {
  const row = await one('SELECT * FROM integrations WHERE id = $1', [id]);
  if (!row) throw notFound('error-invalid-integration', 'Integração não encontrada.');
  refuseManaged(row);
  if (!(await canManage(ctx, row))) throw forbidden();
  return mapIntegration(row);
}

export async function integrationHistory(ctx: Ctx, id: string, offset: number, count: number) {
  await getIntegration(ctx, id);
  const rows = await many('SELECT * FROM integration_history WHERE integration_id = $1 ORDER BY created_at DESC OFFSET $2 LIMIT $3', [id, offset, count]);
  const total = await one('SELECT count(*)::int AS n FROM integration_history WHERE integration_id = $1', [id]);
  return {
    history: rows.map((h) => ({
      _id: h.id,
      event: h.event,
      step: h.step,
      url: h.url,
      data: h.data,
      httpStatus: h.http_status,
      response: h.response,
      error: h.error,
      finished: h.finished,
      _createdAt: h.created_at,
    })),
    offset,
    count: rows.length,
    total: total.n,
  };
}

export async function clearHistory(ctx: Ctx, id: string) {
  await getIntegration(ctx, id);
  await query('DELETE FROM integration_history WHERE integration_id = $1', [id]);
}

async function history(integrationId: string, event: string, step: string, extra: { url?: string; data?: unknown; status?: number; response?: string; error?: string; finished?: boolean }) {
  await query(
    `INSERT INTO integration_history (id, integration_id, event, step, url, data, http_status, response, error, finished) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId(), integrationId, event, step, extra.url ?? null, extra.data === undefined ? null : JSON.stringify(extra.data), extra.status ?? null, extra.response?.slice(0, 4000) ?? null, extra.error?.slice(0, 2000) ?? null, extra.finished ?? false],
  );
  // Mantém só as 200 entradas mais recentes por integração.
  await query(
    `DELETE FROM integration_history WHERE integration_id = $1 AND id NOT IN (SELECT id FROM integration_history WHERE integration_id = $1 ORDER BY created_at DESC LIMIT 200)`,
    [integrationId],
  );
}

// ---------- Scripts ----------
// Os scripts são escritos por administradores (como no Rocket.Chat) e rodam em um contexto
// separado, sem require/process, com tempo limite. Ficam desativados por padrão.

function compileScript(code: string) {
  try {
    return new vm.Script(`${code}\n;typeof Script === 'function' ? new Script() : null`, { filename: 'integration.js' });
  } catch (e: any) {
    throw badRequest('error-invalid-script', `Erro no script: ${e.message}`);
  }
}

function runScript(row: any, method: string, arg: unknown): { ok: boolean; result?: any; error?: string; logs: string[] } {
  const logs: string[] = [];
  if (!row.script_enabled || !row.script || !getSetting<boolean>('Integrations_Scripts_Enabled')) return { ok: true, result: undefined, logs };
  const log = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const sandbox = vm.createContext(
    { console: { log, info: log, warn: log, error: log }, JSON, Math, Date, encodeURIComponent, decodeURIComponent, __arg: JSON.parse(JSON.stringify(arg ?? null)) },
    { codeGeneration: { strings: false, wasm: false } },
  );
  try {
    const instance = compileScript(row.script).runInContext(sandbox, { timeout: 2000 });
    if (!instance || typeof instance[method] !== 'function') return { ok: true, result: undefined, logs };
    sandbox.__instance = instance;
    const result = vm.runInContext(`JSON.stringify(__instance.${method}(__arg) ?? null)`, sandbox, { timeout: 2000 });
    return { ok: true, result: JSON.parse(result), logs };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), logs };
  }
}

// ---------- Publicação ----------

async function resolveTarget(integrationUser: { id: string; username: string }, channel: string) {
  const c = channel.trim();
  if (c.startsWith('@')) {
    const dm: any = await createDirect({ userId: integrationUser.id, username: integrationUser.username, sessionId: '' }, [c.slice(1)]);
    return getRoom(dm.id ?? dm._id ?? dm.rid);
  }
  const name = c.replace(/^#/, '');
  const room = (await getRoom(name)) ?? (await getRoomByName(name));
  if (!room) throw badRequest('error-invalid-channel', `Canal não encontrado: ${c}`);
  if (!(await getSubscriptionRow(room.id, integrationUser.id))) {
    if (room.t !== 'c') throw badRequest('error-not-member', `O usuário da integração não participa de ${c}.`);
    await addUserToRoom(room.id, integrationUser.id, { silent: true });
  }
  return room;
}

interface PostContent {
  text?: string;
  msg?: string;
  channel?: string | string[];
  roomId?: string;
  alias?: string;
  emoji?: string;
  icon_emoji?: string;
  avatar?: string;
  icon_url?: string;
  attachments?: any[];
  tmid?: string;
}

async function postAs(row: any, content: PostContent, defaultChannels: string[], userOverride?: { id: string; username: string }) {
  const user = userOverride ?? (await one('SELECT id, username FROM users WHERE id = $1 AND active', [row.user_id]));
  if (!user) throw badRequest('error-invalid-user', 'Usuário da integração inválido ou desativado.');
  const targets = content.roomId ? [content.roomId] : content.channel ? normalizeChannels(content.channel) : defaultChannels;
  const ctx: Ctx = { userId: user.id, username: user.username, sessionId: '' };
  // Campos, URLs e tamanhos dos anexos ficam com sanitizeAttachments (em sendMessage), como no chat.postMessage: uma
  // lista própria aqui perdia pretext, author_link, author_icon, thumb_url e footer. Só a citação (message_link) sai:
  // quem chama o webhook não é o usuário da integração e não deve copiar mensagens das salas que ele lê.
  const attachments = Array.isArray(content.attachments)
    ? content.attachments
        .slice(0, 20)
        .filter((a) => a && typeof a === 'object' && !Array.isArray(a))
        .map((a) => ({ ...a, message_link: undefined }))
    : undefined;
  const text = String(content.text ?? content.msg ?? '');
  const out = [];
  for (const target of targets) {
    const room = target === content.roomId ? await getRoom(target) : await resolveTarget(user, target);
    if (!room) continue;
    // A integração pode definir apelido/ícone sem a permissão de personificação do usuário.
    out.push(
      await sendMessage(ctx, {
        rid: room.id,
        msg: text,
        tmid: content.tmid,
        attachments,
        alias: content.alias ?? row.alias ?? undefined,
        emoji: content.emoji ?? content.icon_emoji ?? row.emoji ?? undefined,
        avatar: content.avatar ?? content.icon_url ?? row.avatar ?? undefined,
      }, { skipCommands: true, trusted: true }),
    );
  }
  return out;
}

// ---------- Entrada ----------

export async function handleIncoming(id: string, token: string, req: { body: unknown; headers: Record<string, unknown>; url: string; query: Record<string, string> }) {
  if (!getSetting<boolean>('Integrations_Enabled')) throw forbidden('Integrações desativadas.');
  const row = await one(`SELECT * FROM integrations WHERE id = $1 AND type = 'webhook-incoming'`, [id]);
  if (!row || row.token !== token) throw notFound('error-invalid-integration', 'Integração não encontrada.');
  if (!row.enabled) throw badRequest('error-integration-disabled', 'Integração desativada.');
  let body: any = req.body ?? {};
  // Formato do Slack: payload=<json> em form-urlencoded.
  if (typeof body === 'object' && typeof body.payload === 'string') {
    try {
      body = JSON.parse(body.payload);
    } catch {
      throw badRequest('error-invalid-payload', 'payload inválido.');
    }
  }
  let content: PostContent = typeof body === 'object' ? body : { text: String(body) };
  if (row.script_enabled) {
    const r = runScript(row, 'process_incoming_request', { request: { url: { href: req.url, query: req.query }, headers: req.headers, content: body, content_raw: JSON.stringify(body) } });
    if (!r.ok) {
      await history(row.id, 'incoming', 'script-error', { data: body, error: r.error });
      throw badRequest('error-running-script', 'Erro ao executar o script da integração.');
    }
    if (r.result?.error) throw badRequest('error-script', String(r.result.error.message ?? 'Rejeitado pelo script.'));
    if (r.result === null) return { success: true };
    if (r.result?.content) content = r.result.content;
  }
  if (!content.text && !content.msg && !content.attachments?.length) throw badRequest('error-invalid-message', 'Mensagem vazia.');
  const messages = await postAs(row, content, row.channels);
  return { success: true, messages: messages.length };
}

// ---------- Saída ----------

function delayFor(kind: string, attempt: number) {
  if (kind === 'powers-of-two') return 2 ** attempt * 1000;
  if (kind === 'increments-of-two') return (attempt + 1) * 2000;
  return 10 ** Math.min(attempt, 4) * 100; // powers-of-ten: 100ms, 1s, 10s, 100s...
}

function matchesChannel(row: any, room: any, username?: string) {
  const ch: string[] = row.channels;
  if (!ch.length) return true;
  for (const c of ch) {
    if (c === 'all_public_channels' && room.t === 'c') return true;
    if (c === 'all_private_groups' && room.t === 'p') return true;
    if (c === 'all_direct_messages' && room.t === 'd') return true;
    if (c.startsWith('#') && (room.name ?? '').toLowerCase() === c.slice(1).toLowerCase()) return true;
    if (c.startsWith('@') && room.t === 'd' && (room.usernames ?? []).some((u: string) => u.toLowerCase() === c.slice(1).toLowerCase() && u !== username)) return true;
    if (c === room.id) return true;
  }
  return false;
}

function triggerWordFor(row: any, text: string) {
  const words: string[] = row.trigger_words;
  if (!words.length) return { ok: true, word: undefined as string | undefined };
  for (const w of words) {
    if (row.trigger_word_anywhere ? text.includes(w) : text.startsWith(w)) return { ok: true, word: w };
  }
  return { ok: false, word: undefined };
}

async function callOutgoing(row: any, event: OutgoingEvent, data: Record<string, unknown>, room: any | null, url: string, attempt = 0): Promise<void> {
  let request: any = { url, method: 'POST', headers: { 'content-type': 'application/json' }, data };
  if (row.script_enabled) {
    const r = runScript(row, 'prepare_outgoing_request', { request });
    if (!r.ok) return history(row.id, event, 'script-error', { url, data, error: r.error, finished: true });
    if (r.result === null) return history(row.id, event, 'skipped-by-script', { url, data, finished: true });
    if (r.result?.message && room) {
      await postAs(row, { ...r.result.message, roomId: room.id }, []).catch(() => {});
      return history(row.id, event, 'replied-by-script', { url, data, finished: true });
    }
    if (r.result) request = { ...request, ...r.result };
  }
  let status = 0;
  let responseText = '';
  try {
    const timeout = getSetting<number>('Integrations_Outgoing_Timeout') * 1000;
    const res = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: request.headers,
      body: request.method === 'GET' ? undefined : JSON.stringify(request.data),
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    status = res.status;
    responseText = (await res.text()).slice(0, 64 * 1024);
    if (status >= 500 || status === 429) throw new Error(`HTTP ${status}`);
  } catch (e: any) {
    const willRetry = row.retry_failed_calls && attempt < row.retry_count;
    await history(row.id, event, willRetry ? 'retrying' : 'failed', { url, data: request.data, status: status || undefined, response: responseText, error: String(e?.message ?? e), finished: !willRetry });
    if (willRetry) setTimeout(() => void callOutgoing(row, event, data, room, url, attempt + 1).catch(() => {}), delayFor(row.retry_delay, attempt));
    return;
  }
  await history(row.id, event, 'sent', { url, data: request.data, status, response: responseText, finished: true });
  // Resposta com { text } vira mensagem na sala de origem (ou na sala alvo).
  let reply: any = null;
  try {
    reply = responseText ? JSON.parse(responseText) : null;
  } catch {
    reply = null;
  }
  if (row.script_enabled) {
    const r = runScript(row, 'process_outgoing_response', { request, response: { status_code: status, content: reply, content_raw: responseText } });
    if (r.ok && r.result !== undefined) reply = r.result?.content ?? r.result;
  }
  if (reply && typeof reply === 'object' && (reply.text || reply.attachments?.length)) {
    if (!row.target_room && !room) return;
    const impersonated = row.impersonate_user && data.user_id ? await one('SELECT id, username FROM users WHERE id = $1', [data.user_id]) : null;
    const content = row.target_room ? { ...reply, roomId: undefined, channel: undefined } : { ...reply, roomId: room.id };
    await postAs(row, content, row.target_room ? [row.target_room] : [], impersonated ?? undefined).catch(() => {});
  }
}

async function fireOutgoing(event: OutgoingEvent, room: any | null, data: Record<string, unknown>, opts: { text?: string; username?: string; userId?: string } = {}) {
  if (!getSetting<boolean>('Integrations_Enabled')) return;
  const rows = await many(`SELECT * FROM integrations WHERE type = 'webhook-outgoing' AND enabled AND event = $1`, [event]);
  for (const row of rows) {
    // Ignora mensagens da própria integração para evitar laços.
    if (opts.userId && opts.userId === row.user_id) continue;
    if (room && !matchesChannel(row, room, opts.username)) continue;
    let triggerWord: string | undefined;
    if (event === 'sendMessage') {
      const t = triggerWordFor(row, opts.text ?? '');
      if (!t.ok) continue;
      triggerWord = t.word;
    }
    const payload = { token: row.token, bot: false, trigger_word: triggerWord, siteUrl: getSetting('Site_Url'), ...data };
    for (const url of row.urls) void callOutgoing(row, event, payload, room, url).catch(() => {});
  }
}

// Integrações (Jira/Teams): figurinha chega aos webhooks como o texto da prévia ("😂 Figurinha “Rindo”"), nunca vazia.
const outgoingText = (message: any): string => message.msg || (message.sticker ? stickerPreviewText(message.sticker) : '');

let registered = false;
export function registerIntegrationHooks() {
  if (registered) return;
  registered = true;
  on('message.sent', ({ room, message, user }) => {
    if (message.t) return;
    const text = outgoingText(message);
    return fireOutgoing(
      'sendMessage',
      room,
      {
        channel_id: room.id,
        channel_name: room.name,
        message_id: message._id,
        timestamp: message.ts,
        user_id: user?._id,
        user_name: user?.username,
        text,
        tmid: message.tmid ?? undefined,
      },
      { text, username: user?.username, userId: user?._id },
    );
  });
  on('message.updated', async ({ room, message }) => {
    if (message.t) return;
    const rows = await one(`SELECT 1 FROM integrations WHERE type='webhook-outgoing' AND enabled AND event='sendMessage' AND run_on_edits LIMIT 1`);
    if (!rows) return;
    const editRows = await many(`SELECT * FROM integrations WHERE type='webhook-outgoing' AND enabled AND event='sendMessage' AND run_on_edits`);
    for (const row of editRows) {
      if (message.u?._id === row.user_id || !matchesChannel(row, room, message.u?.username)) continue;
      const t = triggerWordFor(row, message.msg ?? '');
      if (!t.ok) continue;
      const payload = {
        token: row.token,
        bot: false,
        trigger_word: t.word,
        siteUrl: getSetting('Site_Url'),
        channel_id: room.id,
        channel_name: room.name,
        message_id: message._id,
        timestamp: message.ts,
        user_id: message.u?._id,
        user_name: message.u?.username,
        text: message.msg,
        isEdited: true,
      };
      for (const url of row.urls) void callOutgoing(row, 'sendMessage', payload, room, url).catch(() => {});
    }
  });
  on('file.uploaded', ({ room, message, file, user }) =>
    fireOutgoing('fileUploaded', room, { channel_id: room.id, channel_name: room.name, message_id: message._id, user_id: user._id, user_name: user.username, text: message.msg, file: { _id: file._id, name: file.name, type: file.type, size: file.size, url: file.url } }, { userId: user._id }),
  );
  on('room.created', ({ room, owner }) => (room.t === 'd' ? undefined : fireOutgoing('roomCreated', room, { channel_id: room.id, channel_name: room.name, owner: owner ?? undefined })));
  on('room.archived', ({ room, by }) => fireOutgoing('roomArchived', room, { channel_id: room.id, channel_name: room.name, user_id: by?._id, user_name: by?.username }));
  on('room.joined', ({ room, user }) => (room.t === 'd' ? undefined : fireOutgoing('roomJoined', room, { channel_id: room.id, channel_name: room.name, user_id: user._id, user_name: user.username }, { userId: user._id })));
  on('room.left', ({ room, user }) => (room.t === 'd' ? undefined : fireOutgoing('roomLeft', room, { channel_id: room.id, channel_name: room.name, user_id: user._id, user_name: user.username }, { userId: user._id })));
  on('user.created', ({ user }) => fireOutgoing('userCreated', null, { user_id: user._id, user_name: user.username, name: user.name, email: user.email ?? undefined }));
}

