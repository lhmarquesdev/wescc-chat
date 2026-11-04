import { createHash } from 'node:crypto';
import {
  canonicalPublicKey,
  E2E_BATCH,
  E2E_KEY_ID,
  E2E_MESSAGE_ID,
  E2E_TEXT,
  E2E_WRAPPED,
  e2eMaxCiphertext,
  e2eToggleVerdict,
  isEnvelope,
  isPrivateKeyBlob,
  type E2EEnvelope,
} from '@shared/e2e';
import { many, one, query, tx, type Queryable } from '../db/pool';
import { ApiError, notFound } from '../lib/errors';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { assertCanSendDirect } from './direct';
import { rolesHavePermission } from './permissions';
import { getRoom, notifyRoomUpdated } from './rooms';
import { getSetting } from './settings';
import { actorOf, type Ctx } from './users';

// Criptografia de ponta a ponta: o servidor guarda e entrega só material cifrado. Ele confere quem participa da conversa
// e o formato das chaves; cifrar e decifrar acontece no navegador. As regras de sala (inscrição, arquivada, somente
// leitura, silêncio e a regra das conversas diretas da Operação) correm antes de qualquer conferência daqui.

export const e2eOn = () => !!getSetting<boolean>('E2E_Enable');

const err = (status: number, code: string, text: string) => new ApiError(status, code, text);
export const E2E_ERR = {
  disabled: (status = 403) => err(status, 'error-e2e-disabled', E2E_TEXT.disabled),
  roomType: () => err(400, 'error-e2e-room-type', E2E_TEXT.roomType),
  public: () => err(400, 'error-e2e-public', E2E_TEXT.public),
  noKeys: () => err(400, 'error-e2e-no-keys', E2E_TEXT.noKeys),
  userNoKeys: () => err(400, 'error-e2e-user-no-keys', E2E_TEXT.userNoKeys),
  invalidKey: () => err(400, 'error-e2e-invalid-key', E2E_TEXT.invalidKey),
  keysExist: () => err(409, 'error-e2e-keys-exist', E2E_TEXT.keysExist),
  notEncrypted: () => err(400, 'error-e2e-not-encrypted', E2E_TEXT.notEncrypted),
  notMember: () => err(403, 'error-e2e-not-member', E2E_TEXT.notMember),
  noKey: () => err(403, 'error-e2e-no-key', E2E_TEXT.noKey),
  keyExists: () => err(409, 'error-e2e-key-exists', E2E_TEXT.keyExists),
  keyOutdated: () => err(409, 'error-e2e-key-outdated', E2E_TEXT.keyOutdated),
  required: () => err(400, 'error-e2e-required', E2E_TEXT.required),
  sticker: () => err(400, 'error-e2e-sticker', E2E_TEXT.sticker),
  invalid: () => err(400, 'error-e2e-invalid', E2E_TEXT.invalid),
  plainField: () => err(400, 'error-e2e-plain-field', E2E_TEXT.plainField),
  id: () => err(409, 'error-e2e-id', E2E_TEXT.id),
  reply: () => err(400, 'error-e2e-reply', E2E_TEXT.reply),
  batch: () => err(400, 'error-e2e-batch', E2E_TEXT.batch),
  archived: () => err(400, 'error-room-archived', E2E_TEXT.archived),
  rotateForbidden: () => err(403, 'error-not-allowed', E2E_TEXT.rotateForbidden),
};

// ---------- Chaves da pessoa ----------

export const fingerprintText = (publicKey: string) => createHash('sha256').update(publicKey).digest('base64url').slice(0, 16);

export async function hasUserKeys(userId: string) {
  return !!(await one('SELECT 1 FROM e2e_user_keys WHERE user_id = $1', [userId]));
}

export async function myKeys(userId: string): Promise<{ publicKey: string | null; privateKey: string | null }> {
  const r = await one('SELECT public_key, private_key FROM e2e_user_keys WHERE user_id = $1', [userId]);
  return { publicKey: r?.public_key ?? null, privateKey: r?.private_key ?? null };
}

// A impressão da chave pública vai no /me: a web confere se a chave guardada neste navegador ainda é a da conta.
export async function fingerprintOf(userId: string): Promise<string | null> {
  const r = await one('SELECT public_key FROM e2e_user_keys WHERE user_id = $1', [userId]);
  return r ? fingerprintText(r.public_key) : null;
}

const inEncryptedRoom = async (userId: string) =>
  !!(await one('SELECT 1 FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 AND r.encrypted LIMIT 1', [userId]));

// Cria as chaves (primeira vez) ou troca só a chave privada cifrada (troca da senha da criptografia: a mesma chave
// pública). Criar pede E2E_Enable ou já estar numa conversa criptografada (alguém ligou antes de a opção ser desligada).
export async function setMyKeys(ctx: Ctx, pub: string, priv: string): Promise<void> {
  const canonical = typeof pub === 'string' ? canonicalPublicKey(pub) : null;
  if (!canonical || typeof priv !== 'string' || !isPrivateKeyBlob(priv)) throw E2E_ERR.invalidKey();
  const update = async () => {
    const existing = await one('SELECT public_key FROM e2e_user_keys WHERE user_id = $1', [ctx.userId]);
    if (!existing) return false;
    if (existing.public_key !== canonical) throw E2E_ERR.keysExist();
    await query('UPDATE e2e_user_keys SET private_key = $2, updated_at = now() WHERE user_id = $1', [ctx.userId, priv]);
    await audit(actorOf(ctx), 'user.e2e.password.changed', { userId: ctx.userId });
    bus.publish({ user: ctx.userId }, { type: 'e2e.keys', action: 'updated' });
    return true;
  };
  if (await update()) return;
  if (!e2eOn() && !(await inEncryptedRoom(ctx.userId))) throw E2E_ERR.disabled();
  const row = await one('INSERT INTO e2e_user_keys (user_id, public_key, private_key) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING RETURNING user_id', [
    ctx.userId,
    canonical,
    priv,
  ]);
  // Outro aparelho criou ao mesmo tempo: vale a regra de troca (a mesma chave pública ou 409).
  if (!row) {
    await update();
    return;
  }
  await query('UPDATE users SET e2e_reset_at = NULL WHERE id = $1 AND e2e_reset_at IS NOT NULL', [ctx.userId]);
  await audit(actorOf(ctx), 'user.e2e.keys.created', { userId: ctx.userId });
  bus.publish({ user: ctx.userId }, { type: 'e2e.keys', action: 'created' });
  // Quem está nas conversas criptografadas e já tem a chave entrega para a pessoa.
  const rooms = await many(
    `SELECT r.id, r.e2e_key_id FROM subscriptions s JOIN rooms r ON r.id = s.room_id
     WHERE s.user_id = $1 AND r.encrypted AND r.e2e_key_id IS NOT NULL LIMIT 200`,
    [ctx.userId],
  );
  for (const r of rooms) keyRequest(r.id, r.e2e_key_id);
}

// ---------- Pedidos de chave ----------

// No máximo um pedido por sala a cada 10 s (por instância). Um pedido dentro da janela não se perde: sai um só no fim
// dela, com a geração atual da sala. Quem entrega busca todos que ainda não têm a chave, então um pedido cobre vários.
const ROOM_WINDOW_MS = 10_000;
const USER_WINDOW_MS = 30_000;
const lastRoomRequest = new Map<string, number>();
const trailing = new Map<string, NodeJS.Timeout>();
const lastUserRequest = new Map<string, number>();

function keyRequest(rid: string, keyID: string | null) {
  if (!keyID) return false;
  const now = Date.now();
  const last = lastRoomRequest.get(rid) ?? 0;
  if (now - last >= ROOM_WINDOW_MS) {
    lastRoomRequest.set(rid, now);
    bus.publish({ room: rid }, { type: 'e2e.keyRequest', rid, keyID });
    return true;
  }
  if (!trailing.has(rid)) {
    const t = setTimeout(
      () => {
        trailing.delete(rid);
        void getRoom(rid)
          .then((room) => {
            if (!room?.encrypted || !room.e2e_key_id) return;
            lastRoomRequest.set(rid, Date.now());
            bus.publish({ room: rid }, { type: 'e2e.keyRequest', rid, keyID: room.e2e_key_id });
          })
          .catch(() => {});
      },
      last + ROOM_WINDOW_MS - now,
    );
    t.unref?.();
    trailing.set(rid, t);
  }
  return true;
}

// Testes: zera as janelas de pedido.
export function resetKeyRequestWindows() {
  lastRoomRequest.clear();
  lastUserRequest.clear();
  for (const t of trailing.values()) clearTimeout(t);
  trailing.clear();
}

// Pessoa nova na sala (com chaves): pede a chave para quem já tem.
export async function requestKeyForNewMember(room: any, userId: string) {
  if (!room?.encrypted || !room.e2e_key_id) return;
  if (await hasUserKeys(userId)) keyRequest(room.id, room.e2e_key_id);
}

// Com rid: a sala (a pessoa ainda sem a chave atual). Sem: até 50 conversas criptografadas em que falta a chave.
export async function requestKeys(ctx: Ctx, rid?: string): Promise<{ requested: number }> {
  if (!(await hasUserKeys(ctx.userId))) throw E2E_ERR.noKeys();
  const rooms = rid
    ? [await memberRoom(ctx, rid)].filter((r) => r.encrypted && r.e2e_key_id)
    : await many(`SELECT r.* FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 AND r.encrypted AND r.e2e_key_id IS NOT NULL LIMIT 200`, [
        ctx.userId,
      ]);
  let requested = 0;
  for (const r of rooms) {
    if (requested >= 50) break;
    if (await one('SELECT 1 FROM e2e_room_keys WHERE room_id = $1 AND user_id = $2 AND key_id = $3', [r.id, ctx.userId, r.e2e_key_id])) continue;
    const k = `${ctx.userId}:${r.id}`;
    const now = Date.now();
    if (now - (lastUserRequest.get(k) ?? 0) < USER_WINDOW_MS) continue;
    lastUserRequest.set(k, now);
    if (keyRequest(r.id, r.e2e_key_id)) requested++;
  }
  return { requested };
}

// ---------- Chaves das salas ----------

// Sala em que a pessoa participa: em DM e grupo privado "acesso" é ter a inscrição, então quem administra e não está
// na conversa não recebe nada.
async function memberRoom(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room) throw notFound('error-room-not-found', 'Sala não encontrada.');
  if (!(await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, ctx.userId]))) throw E2E_ERR.notMember();
  return room;
}

const holds = async (rid: string, userId: string, keyID: string | null) =>
  !!keyID && !!(await one('SELECT 1 FROM e2e_room_keys WHERE room_id = $1 AND user_id = $2 AND key_id = $3', [rid, userId, keyID]));

// DM bloqueada pela regra das conversas diretas (ou discussão de uma DM assim): nenhuma chave passa.
async function directOpen(ctx: Ctx, room: any) {
  try {
    await assertCanSendDirect(ctx, room);
    return true;
  } catch {
    return false;
  }
}

export async function roomKeys(ctx: Ctx, rid: string) {
  const room = await memberRoom(ctx, rid);
  const rows = await many(
    'SELECT key_id, wrapped_key, provided_by, created_at FROM e2e_room_keys WHERE room_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100',
    [rid, ctx.userId],
  );
  return {
    keyID: (room.e2e_key_id as string | null) ?? null,
    rotate: !!room.e2e_rotate,
    keys: rows.map((r) => ({ keyID: r.key_id as string, key: r.wrapped_key as string, providedBy: (r.provided_by as string | null) ?? null, ts: r.created_at as string })),
  };
}

// Quem pode receber a chave: inscrito na sala, conta ativa e com chaves da criptografia.
const RECIPIENTS = `SELECT u.id, u.username, k.public_key FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN e2e_user_keys k ON k.user_id = u.id
  WHERE s.room_id = $1 AND u.active`;

export async function usersWithoutKey(ctx: Ctx, rid: string, keyID?: string) {
  const room = await memberRoom(ctx, rid);
  if (!room.encrypted && !room.e2e_key_id) throw E2E_ERR.notEncrypted();
  if (!(await holds(rid, ctx.userId, room.e2e_key_id))) throw E2E_ERR.noKey();
  const k = keyID ?? room.e2e_key_id;
  if (!E2E_KEY_ID.test(String(k))) throw E2E_ERR.invalidKey();
  if (!(await directOpen(ctx, room))) return { users: [] };
  const rows = await many(
    `${RECIPIENTS} AND u.id <> $2 AND NOT EXISTS (SELECT 1 FROM e2e_room_keys x WHERE x.room_id = $1 AND x.user_id = u.id AND x.key_id = $3)
     ORDER BY u.username LIMIT 500`,
    [rid, ctx.userId, k],
  );
  return { users: rows.map((r) => ({ _id: r.id as string, username: r.username as string, e2e: { public_key: r.public_key as string } })) };
}

function checkBatch(keys: unknown, opts: { min?: number } = {}): { uid: string; key: string }[] {
  if (!Array.isArray(keys) || keys.length < (opts.min ?? 1) || keys.length > E2E_BATCH) throw E2E_ERR.batch();
  const out: { uid: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const x of keys) {
    const uid = x?.uid;
    const key = x?.key;
    if (typeof uid !== 'string' || !uid || uid.length > 40 || typeof key !== 'string' || !E2E_WRAPPED.test(key)) throw E2E_ERR.invalidKey();
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({ uid, key });
  }
  return out;
}

// Grava as chaves de quem pode receber (as outras voltam em skipped) e avisa quem recebeu.
async function insertKeys(c: Queryable | null, rid: string, keyID: string, by: string, keys: { uid: string; key: string }[]) {
  const db = c ?? undefined;
  const eligible = new Set(
    (await many(`${RECIPIENTS} AND u.id = ANY($2)`, [rid, keys.map((k) => k.uid)], db)).map((r) => r.id as string),
  );
  const list = keys.filter((k) => eligible.has(k.uid));
  const inserted = list.length
    ? (
        await many(
          `INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by)
           SELECT $1, x.uid, $2, x.key, $3 FROM jsonb_to_recordset($4::jsonb) AS x(uid text, key text)
           ON CONFLICT DO NOTHING RETURNING user_id`,
          [rid, keyID, by, JSON.stringify(list)],
          db,
        )
      ).map((r) => r.user_id as string)
    : [];
  const done = new Set(inserted);
  return { inserted, skipped: keys.map((k) => k.uid).filter((u) => !done.has(u)) };
}

function announceKeys(rid: string, keyID: string, uids: string[], except?: string) {
  const users = uids.filter((u) => u !== except);
  if (users.length) bus.publish({ users }, { type: 'e2e.keyAvailable', rid, keyID });
}

export const publishRoom = (rid: string) => notifyRoomUpdated(rid);

// A primeira chave da sala (ninguém criou ainda): a sala passa a ter a geração keyID, e quem criou fica com a sua.
export async function setRoomKeyId(ctx: Ctx, rid: string, keyID: string, key: string): Promise<void> {
  const room = await memberRoom(ctx, rid);
  if (!room.encrypted) throw E2E_ERR.notEncrypted();
  if (room.archived) throw E2E_ERR.archived();
  if (!(await hasUserKeys(ctx.userId))) throw E2E_ERR.noKeys();
  if (typeof keyID !== 'string' || !E2E_KEY_ID.test(keyID) || typeof key !== 'string' || !E2E_WRAPPED.test(key)) throw E2E_ERR.invalidKey();
  await assertCanSendDirect(ctx, room);
  await tx(async (c) => {
    const r = await c.query('UPDATE rooms SET e2e_key_id = $2, e2e_rotate = false, updated_at = now() WHERE id = $1 AND encrypted AND e2e_key_id IS NULL RETURNING id', [rid, keyID]);
    if (!r.rowCount) throw E2E_ERR.keyExists();
    await c.query('INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by) VALUES ($1,$2,$3,$4,$2) ON CONFLICT DO NOTHING', [rid, ctx.userId, keyID, key]);
  });
  await audit(actorOf(ctx), 'room.e2e.key.created', { rid }, { keyID });
  await publishRoom(rid);
}

// Entrega a chave atual a quem ainda não tem. Sala arquivada também (para ler o histórico).
export async function updateGroupKey(ctx: Ctx, rid: string, keyID: string, keys: unknown) {
  const room = await memberRoom(ctx, rid);
  const list = checkBatch(keys);
  if (typeof keyID !== 'string' || !E2E_KEY_ID.test(keyID)) throw E2E_ERR.invalidKey();
  if (!(await holds(rid, ctx.userId, keyID))) throw E2E_ERR.noKey();
  if (keyID !== room.e2e_key_id) throw E2E_ERR.keyOutdated();
  await assertCanSendDirect(ctx, room);
  const r = await insertKeys(null, rid, keyID, ctx.userId, list.filter((k) => k.uid !== ctx.userId));
  announceKeys(rid, keyID, r.inserted);
  return { inserted: r.inserted.length, skipped: [...r.skipped, ...list.filter((k) => k.uid === ctx.userId).map((k) => k.uid)] };
}

// Chave nova (alguém saiu, redefiniu ou "Gerar chave nova"): troca a geração com compare-and-swap e grava as chaves.
export async function resetRoomKey(ctx: Ctx, rid: string, prevKeyID: string, keyID: string, keys: unknown) {
  const room = await memberRoom(ctx, rid);
  if (!room.encrypted) throw E2E_ERR.notEncrypted();
  if (room.archived) throw E2E_ERR.archived();
  const list = checkBatch(keys);
  if (typeof prevKeyID !== 'string' || !E2E_KEY_ID.test(prevKeyID) || typeof keyID !== 'string' || !E2E_KEY_ID.test(keyID) || keyID === prevKeyID) throw E2E_ERR.invalidKey();
  if (!list.some((k) => k.uid === ctx.userId)) throw E2E_ERR.invalidKey();
  if (!(await holds(rid, ctx.userId, prevKeyID))) throw E2E_ERR.noKey();
  const reason = room.e2e_rotate ? 'pedido' : 'manual';
  if (!room.e2e_rotate) {
    try {
      await assertCanToggleE2e(ctx, room, true);
    } catch {
      throw E2E_ERR.rotateForbidden();
    }
  }
  await assertCanSendDirect(ctx, room);
  const r = await tx(async (c) => {
    const u = await c.query('UPDATE rooms SET e2e_key_id = $3, e2e_rotate = false, updated_at = now() WHERE id = $1 AND e2e_key_id = $2 RETURNING id', [rid, prevKeyID, keyID]);
    if (!u.rowCount) throw E2E_ERR.keyOutdated();
    return insertKeys(c, rid, keyID, ctx.userId, list);
  });
  await audit(actorOf(ctx), 'room.e2e.key.rotated', { rid }, { prev: prevKeyID, keyID, reason });
  await publishRoom(rid);
  announceKeys(rid, keyID, r.inserted, ctx.userId);
  return { inserted: r.inserted.length, skipped: r.skipped };
}

// A chave recebida não confere (o código não é o da chave): apaga a linha e pede de novo.
export async function rejectSuggestedKey(ctx: Ctx, rid: string, keyID: string): Promise<void> {
  const room = await memberRoom(ctx, rid);
  if (typeof keyID !== 'string' || !E2E_KEY_ID.test(keyID)) throw E2E_ERR.invalidKey();
  const row = await one(
    'DELETE FROM e2e_room_keys WHERE room_id = $1 AND user_id = $2 AND key_id = $3 AND provided_by IS DISTINCT FROM $2 RETURNING provided_by',
    [rid, ctx.userId, keyID],
  );
  if (!row) return;
  await audit(actorOf(ctx), 'room.e2e.key.rejected', { rid }, { keyID, providedBy: row.provided_by });
  if (room.encrypted && room.e2e_key_id === keyID) keyRequest(rid, keyID);
}

// Pede chave nova nas salas (só nas que já têm uma geração) e avisa quem participa.
export async function markRotate(rids: string[]): Promise<void> {
  const ids = [...new Set(rids)].filter(Boolean);
  if (!ids.length) return;
  const rows = await many('UPDATE rooms SET e2e_rotate = true, updated_at = now() WHERE id = ANY($1) AND e2e_key_id IS NOT NULL RETURNING id, e2e_key_id', [ids]);
  for (const r of rows) {
    bus.publish({ room: r.id }, { type: 'e2e.rotate', rid: r.id, keyID: r.e2e_key_id });
    await publishRoom(r.id);
  }
}

// Saiu, foi removido ou excluído da sala: as chaves dela saem, e quem fica gera uma chave nova.
export async function forgetRoomKeys(rid: string, userId: string) {
  const gone = await many('DELETE FROM e2e_room_keys WHERE room_id = $1 AND user_id = $2 RETURNING key_id', [rid, userId]);
  if (gone.length) await markRotate([rid]);
}

// Esqueceu a senha (self) ou o administrador redefiniu: as chaves somem e as salas em que a pessoa tinha chave trocam.
export async function resetUserKeys(actor: Ctx, userId: string, opts: { self: boolean }): Promise<void> {
  const rooms = await tx(async (c) => {
    const rs = (await c.query('SELECT DISTINCT room_id FROM e2e_room_keys WHERE user_id = $1', [userId])).rows.map((r: any) => r.room_id as string);
    await c.query('DELETE FROM e2e_room_keys WHERE user_id = $1', [userId]);
    const k = await c.query('DELETE FROM e2e_user_keys WHERE user_id = $1 RETURNING user_id', [userId]);
    if (!k.rowCount && !opts.self) throw E2E_ERR.userNoKeys();
    // Pelo administrador: a pessoa fica sabendo o motivo ao entrar de novo (me.e2eResetByAdmin).
    await c.query('UPDATE users SET e2e_reset_at = $2 WHERE id = $1', [userId, opts.self ? null : new Date()]);
    return rs;
  });
  await markRotate(rooms);
  bus.publish({ user: userId }, { type: 'e2e.keys', action: 'reset' });
  await audit(actorOf(actor), 'user.e2e.reset', { userId }, { self: opts.self });
}

// Salas em que a pessoa tem chave (antes de a conta sair; as linhas vão em cascata).
export async function roomsWithKeysOf(userId: string, db?: Queryable): Promise<string[]> {
  return (await many('SELECT DISTINCT room_id FROM e2e_room_keys WHERE user_id = $1', [userId], db)).map((r) => r.room_id as string);
}

// ---------- Ligar e desligar ----------

// DM: quem participa (e pode mandar mensagem nela, pela regra da Operação). Grupo: toggle-room-e2e-encryption.
export async function assertCanToggleE2e(ctx: Ctx, room: any, on: boolean, roles?: string[]): Promise<void> {
  const { getUserRoles } = await import('./permissions');
  roles ??= await getUserRoles(ctx.userId, room.id);
  const isDm = room.t === 'd';
  const v = e2eToggleVerdict({
    t: room.t,
    archived: !!room.archived,
    on,
    settingOn: e2eOn(),
    isDm,
    isParticipant: isDm && (room.uids ?? []).includes(ctx.userId),
    canToggle: rolesHavePermission(roles, 'toggle-room-e2e-encryption'),
    hasKeys: on ? await hasUserKeys(ctx.userId) : true,
  });
  if (!v.ok) throw err(v.status, v.code, v.text);
  if (isDm) await assertCanSendDirect(ctx, room);
}

// ---------- Mensagens ----------

// Usada por sendMessage, updateMessage e pelos uploads. null: sala sem criptografia e sem e2e. Em sala criptografada
// toda mensagem que não é de sistema vem cifrada, de qualquer caminho (webhooks, bots, comandos, agendadas…).
export async function checkE2eInput(
  ctx: Ctx,
  room: any,
  input: { _id?: string; e2e?: unknown; msg?: string; attachments?: unknown[]; alias?: string; emoji?: string; avatar?: string; sticker?: unknown; jira?: unknown; meeting?: unknown },
): Promise<E2EEnvelope | null> {
  const has = input.e2e !== undefined && input.e2e !== null;
  if (!room.encrypted) {
    if (has) throw E2E_ERR.notEncrypted();
    return null;
  }
  if (!has) throw input.sticker ? E2E_ERR.sticker() : E2E_ERR.required();
  if ((input.msg ?? '').trim() || input.attachments?.length || input.alias || input.emoji || input.avatar || input.jira || input.meeting || input.sticker) {
    throw E2E_ERR.plainField();
  }
  const max = e2eMaxCiphertext(getSetting<number>('Message_MaxAllowedSize'));
  if (!isEnvelope(input.e2e, max) || input.e2e.by !== ctx.userId || !E2E_MESSAGE_ID.test(input._id ?? '')) throw E2E_ERR.invalid();
  if (input.e2e.kid !== room.e2e_key_id) throw E2E_ERR.keyOutdated();
  const { v, kid, iv, ct, by } = input.e2e;
  return { v, kid, iv, ct, by };
}

// @usuário que a web leu no texto: só nomes válidos, sem repetir, no máximo 50.
export function cleanMentionNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const x of list) if (typeof x === 'string' && /^[0-9a-zA-Z._-]{1,64}$/.test(x)) out.add(x);
  return [...out].slice(0, 50);
}

