import type { IntegrationRoomRef, Provider, TargetCheck } from '@shared/integrations';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { on } from '../services/hooks';
import { sendMessage } from '../services/messages';
import { getUserRoles, hasPermission, rolesHavePermission } from '../services/permissions';
import { addUserToRoom, canAccessRoom, getRoom, getSubscriptionRow, removeUserFromRoom, setRoomRole } from '../services/rooms';
import { createUser, getUserByUsername, setAvatar, type Ctx } from '../services/users';
import { BOT_AVATAR } from './assets';
import { sendEphemeral } from './ephemeral';
import { activity, getState, once } from './state';

// Usuários robôs das integrações: quem publica os avisos do Jira e as mensagens do Teams nas salas. São visíveis
// como pessoas (entram na sala com a mensagem de sistema de sempre) e seguem todas as regras da sala.

export type BotKind = 'jira' | 'msteams';
export const BOTS: Record<BotKind, { username: string; name: string }> = {
  jira: { username: 'jira.bot', name: 'Jira' },
  msteams: { username: 'msteams.bot', name: 'Microsoft Teams' },
};

const MANAGED_TYPES = ['jira-events', 'msteams-outgoing', 'msteams-incoming'];
const DM_TEXT: Record<BotKind, string> = {
  jira: 'Eu só publico avisos do Jira nas salas. Use /jira ajuda para ver o que dá para fazer.',
  msteams: 'Eu só levo mensagens entre o chat e o Microsoft Teams. Use /teams ajuda para marcar reuniões.',
};

const inactiveText = (username: string) => `O usuário ${username} foi desativado. Reative-o em Administração → Usuários para as regras voltarem a publicar.`;

// ---------- Usuário do robô ----------

const inflight = new Map<BotKind, Promise<{ id: string; username: string }>>();

async function storedBot(kind: BotKind): Promise<any | null> {
  const s = await getState<{ id: string }>(`bot.${kind}`);
  if (!s?.id) return null;
  return one(`SELECT id, username, active, type FROM users WHERE id = $1`, [s.id]);
}

async function createBot(kind: BotKind, replaceId: string | null): Promise<{ id: string; username: string }> {
  const base = BOTS[kind].username;
  let username = base;
  for (let n = 2; (await getUserByUsername(username)) && n < 50; n++) username = `${base}${n}`;
  const row = await createUser({ username, name: BOTS[kind].name, type: 'bot', roles: ['bot'], password: null, verified: true, joinDefaultChannels: false });
  // Outra instância pode ter criado ao mesmo tempo: vale o primeiro gravado, o outro é apagado.
  const data = JSON.stringify({ id: row.id });
  const saved = replaceId
    ? await one(`UPDATE integration_state SET data = $2, updated_at = now() WHERE id = $1 AND data->>'id' = $3 RETURNING id`, [`bot.${kind}`, data, replaceId])
    : await one(`INSERT INTO integration_state (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING RETURNING id`, [`bot.${kind}`, data]);
  if (!saved) {
    await query(`DELETE FROM users WHERE id = $1`, [row.id]).catch(() => {});
    const other = await storedBot(kind);
    if (!other) throw new ApiError(500, 'error-integration-bot', 'Não foi possível criar o usuário do robô da integração.');
    return { id: other.id, username: other.username };
  }
  await setAvatar(row.id, 'image/png', Buffer.from(BOT_AVATAR[kind], 'base64')).catch(() => {});
  botCache = null;
  return { id: row.id, username: row.username };
}

// Cria na primeira vez; confere a cada chamada se ainda existe e está ativo (desativado: erro, nunca reativamos).
export async function ensureBotUser(kind: BotKind): Promise<{ id: string; username: string }> {
  const pending = inflight.get(kind);
  if (pending) return pending;
  const p = (async () => {
    const stored = await getState<{ id: string }>(`bot.${kind}`);
    const row = stored?.id ? await one(`SELECT id, username, active, type FROM users WHERE id = $1`, [stored.id]) : null;
    if (row && row.type === 'bot') {
      if (!row.active) throw badRequest('error-integration-bot-inactive', inactiveText(row.username));
      return { id: row.id as string, username: row.username as string };
    }
    return createBot(kind, stored?.id ?? null);
  })();
  inflight.set(kind, p);
  try {
    return await p;
  } finally {
    inflight.delete(kind);
  }
}

let botCache: { at: number; ids: string[]; byId: Map<string, BotKind> } | null = null;

async function loadBots() {
  if (botCache && Date.now() - botCache.at < 60_000) return botCache;
  const rows = await many(`SELECT id, data FROM integration_state WHERE id IN ('bot.jira', 'bot.msteams')`);
  const byId = new Map<string, BotKind>();
  for (const r of rows) if (r.data?.id) byId.set(String(r.data.id), r.id === 'bot.jira' ? 'jira' : 'msteams');
  botCache = { at: Date.now(), ids: [...byId.keys()], byId };
  return botCache;
}

// Ids dos robôs (cache de 60 s).
export async function botIds(): Promise<string[]> {
  return (await loadBots()).ids;
}

export function botCtx(bot: { id: string; username: string }): Ctx {
  return { userId: bot.id, username: bot.username, sessionId: '' };
}

// ---------- Salas de destino ----------

export function roomRef(room: any, rid?: string): IntegrationRoomRef {
  if (!room) return { _id: rid ?? '', name: '', t: 'c', notice: false, archived: false, ro: false };
  return {
    _id: room.id,
    name: room.name ?? '',
    ...(room.fname && room.fname !== room.name ? { fname: room.fname } : {}),
    t: room.t === 'p' ? 'p' : 'c',
    notice: !!room.notice,
    archived: !!room.archived,
    ro: !!room.ro,
  };
}

const roomLabel = (room: any) => String(room?.fname || room?.name || '');

export async function checkTargets(ctx: Ctx, kind: BotKind, roomIds: string[], mode: 'post' | 'read', grantPublisher: boolean): Promise<TargetCheck[]> {
  const botName = BOTS[kind].name;
  const stored = await storedBot(kind);
  const botUsername: string = stored?.username ?? BOTS[kind].username;
  const callerGlobal = await getUserRoles(ctx.userId);
  const out: TargetCheck[] = [];
  for (const rid of [...new Set(roomIds.map(String))]) {
    const room = await getRoom(rid).catch(() => null);
    // Sala que a pessoa não pode ver volta só com o id: nem nome nem marcas vazam pela recusa.
    const visible = room ? await canAccessRoom(ctx.userId, room).catch(() => false) : false;
    const ref = roomRef(visible ? room : null, rid);
    const fail = (problem: string, extra: Partial<TargetCheck> = {}): TargetCheck => ({ room: ref, ok: false, botMember: false, needsPublisher: false, problem, ...extra });
    if (!room || (room.t !== 'c' && room.t !== 'p')) {
      out.push(fail('Só canais e grupos privados podem ser usados.'));
      continue;
    }
    if (room.prid) {
      out.push(fail('Discussões não podem ser usadas em integrações.'));
      continue;
    }
    const callerSub = await getSubscriptionRow(room.id, ctx.userId);
    if (room.t === 'p' && !callerSub) {
      out.push(fail('Você precisa participar do grupo privado para usá-lo numa integração.'));
      continue;
    }
    if (room.t === 'c' && !visible) {
      out.push(fail('Este canal é de um time privado do qual você não participa.'));
      continue;
    }
    const botSub = stored ? await getSubscriptionRow(room.id, stored.id) : null;
    const botMember = !!botSub;
    if (room.archived) {
      out.push(fail('A sala está arquivada.', { botMember }));
      continue;
    }
    if (mode === 'read') {
      const roomRoles: string[] = callerSub?.roles ?? [];
      if (!roomRoles.includes('owner') && !roomRoles.includes('moderator') && !callerGlobal.includes('admin')) {
        out.push(fail('Só donos e moderadores da sala podem enviar as mensagens dela para o Teams.', { botMember }));
        continue;
      }
    }
    let needsPublisher = false;
    if (mode === 'post' && room.ro) {
      const botRoles = stored ? await getUserRoles(stored.id, room.id) : ['bot'];
      const canPost = rolesHavePermission(botRoles, 'post-readonly') || ['publisher', 'owner', 'moderator'].some((r) => (botSub?.roles ?? []).includes(r));
      if (!canPost) {
        needsPublisher = true;
        if (!grantPublisher) {
          out.push(
            fail(
              room.notice
                ? `Este é um canal de avisos. Marque “Permitir que o ${botName} publique neste canal de avisos”.`
                : `Esta sala é somente leitura. Marque “Permitir que o ${botName} publique nesta sala”.`,
              { botMember, needsPublisher },
            ),
          );
          continue;
        }
        if (!(await hasPermission(ctx.userId, 'set-publisher', room.id))) {
          out.push(fail(`Você não pode tornar o ${botName} publicador em #${roomLabel(room)}.`, { botMember, needsPublisher }));
          continue;
        }
      }
    }
    if ((room.muted ?? []).includes(botUsername)) {
      out.push(fail(`O ${botName} está silenciado nesta sala.`, { botMember, needsPublisher }));
      continue;
    }
    out.push({ room: ref, ok: true, botMember, needsPublisher });
  }
  return out;
}

// Confere e prepara: o robô entra (com a mensagem "adicionou" de sempre) e, se preciso, vira publicador.
export async function prepareTargets(ctx: Ctx, kind: BotKind, roomIds: string[], grantPublisher: boolean, mode: 'post' | 'read' = 'post'): Promise<void> {
  const checks = await checkTargets(ctx, kind, roomIds, mode, grantPublisher);
  const bad = checks.find((c) => !c.ok);
  if (bad) throw badRequest('error-integration-room', bad.problem);
  const bot = await ensureBotUser(kind);
  for (const c of checks) {
    if (!(await getSubscriptionRow(c.room._id, bot.id))) {
      await addUserToRoom(c.room._id, bot.id, { inviter: { id: ctx.userId, username: ctx.username } });
    }
    if (c.needsPublisher && grantPublisher) {
      const sub = await getSubscriptionRow(c.room._id, bot.id);
      if (!(sub?.roles ?? []).includes('publisher')) await setRoomRole(ctx, c.room._id, bot.id, 'publisher', true);
    }
  }
}

// Uma mensagem do robô na sala, sem menção a ninguém. Uma falha (sala arquivada, robô silenciado) vira atividade.
// Só textos fixos do servidor (regra criada ou removida): o aviso sai também num canal de avisos ou numa sala somente
// leitura em que o robô só lê (Sala → Teams), sem torná-lo publicador; os membros precisam saber para onde vão as mensagens.
export async function announce(kind: BotKind, roomId: string, text: string): Promise<void> {
  const bot = await ensureBotUser(kind);
  try {
    await sendMessage(botCtx(bot), { rid: roomId, msg: text }, { skipCommands: true, trusted: true, integration: true, ignoreReadOnly: true });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const room = await getRoom(roomId).catch(() => null);
    await activity({ provider: kind as Provider, tone: 'warn', text: `Não foi possível avisar em #${roomLabel(room) || roomId}: ${e.message}` });
  }
}

// O robô sai das salas que nenhuma regra dele usa mais (chame depois de gravar ou apagar a regra). Com text, ele
// avisa antes de sair, só nas salas que deixa.
export async function releaseTargets(ctx: Ctx, kind: BotKind, roomIds: string[], text?: string): Promise<void> {
  const stored = await storedBot(kind);
  if (!stored) return;
  for (const rid of [...new Set(roomIds.map(String))]) {
    if (!(await getSubscriptionRow(rid, stored.id))) continue;
    const used = await one(
      `SELECT 1 FROM integrations WHERE user_id = $1 AND type = ANY($3::text[]) AND ($2 = ANY(channels) OR config->>'roomId' = $2) LIMIT 1`,
      [stored.id, rid, MANAGED_TYPES],
    );
    if (used) continue;
    if (text) await announce(kind, rid, text).catch(() => {});
    await removeUserFromRoom(rid, stored.id, { by: { id: ctx.userId, username: ctx.username } });
  }
}

// ---------- DMs para o robô ----------

let dmHookRegistered = false;

// Gancho message.sent: quem escreve numa DM com um robô recebe uma resposta efêmera (no máximo uma a cada
// 10 minutos por sala). O robô nunca escreve na DM.
export function registerBotDmReply(): void {
  if (dmHookRegistered) return;
  dmHookRegistered = true;
  on('message.sent', async ({ room, message, user }) => {
    if (room?.t !== 'd' || !user || message?.t) return;
    const bots = await loadBots();
    if (!bots.ids.length || bots.byId.has(user._id)) return;
    const botId = (room.uids ?? []).find((id: string) => bots.byId.has(id));
    if (!botId) return;
    const kind = bots.byId.get(botId)!;
    if (!(await once(`botdm:${room.id}`, 10 * 60_000))) return;
    sendEphemeral(user._id, { rid: room.id, tmid: message.tmid ?? null, source: kind, tone: 'info', text: DM_TEXT[kind] });
  });
}

export function botKindOf(userId: string): BotKind | null {
  return botCache?.byId.get(userId) ?? null;
}
