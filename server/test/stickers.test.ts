import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalize, crc32 } from '@shared/imageProbe';
import { mediaTypeAllowed, STICKER_LIMITS, stickerPreviewText, type MessageSticker } from '@shared/stickers';
import { inflateRawStream, readStickerPack, readZip } from '@shared/zipRead';
import { pool } from '../src/db/pool';
import { newId } from '../src/lib/ids';
import { OPERACAO_PERMISSIONS } from '../src/services/permissions';
import { pruneMessages } from '../src/services/retention';
import { getSetting, listSettings, setSettingCache } from '../src/services/settings';
import { storeBuffer, storedPath, typeAllowed } from '../src/services/uploads';
import type { Ctx } from '../src/services/users';
import { __setStickerByteLimitForTests, clearStickerAccessCache, lockLiveFile, storeStickerFile, validateStickerBytes } from '../src/stickers/files';
import { gcStickerFiles, removeEverywhere, rewriteRemovedStickerMessages } from '../src/stickers/moderation';
import { __setStickerSendBurstForTests } from '../src/stickers/send';
import { flushStickerNotifications } from '../src/stickers/service';
import { drainStickerTrash, queueTrash } from '../src/stickers/trash';
import { admin, api, connectWs, newUser, raw, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';
import { gif, jpeg, png, webp } from './sticker-bytes';

// Figurinhas no servidor: regras, arquivos, moderação e limpeza (design §11.1).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  // O limitador de rajada fica folgado; os casos 29 e 30 o ajustam e devolvem.
  __setStickerSendBurstForTests(1000, 10_000);
});
afterAll(async () => {
  __setStickerSendBurstForTests(STICKER_LIMITS.sendBurst, STICKER_LIMITS.sendWindowMs);
  await stopServer();
});

// ---------- Ajudantes ----------

let seed = 5000;
const nextSeed = () => ++seed;
const still = (w = 512, h = 512) => webp({ kind: 'vp8l', w, h, seed: nextSeed() });
const anim = () => webp({ kind: 'vp8x', w: 256, h: 256, frames: 3, durationsMs: [200, 200, 200], seed: nextSeed() });
const posterFor = (w = 256, h = 256) => png({ w, h, seed: nextSeed() });
const blob = (b: Uint8Array) => new Blob([new Uint8Array(b)], { type: 'application/octet-stream' });

function form(fields: Record<string, string>, file?: Uint8Array, poster?: Uint8Array) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', blob(file), 'figurinha.bin');
  if (poster) fd.append('poster', blob(poster), 'parada.bin');
  return fd;
}
const create = (auth: Auth, file: Uint8Array, fields: Record<string, string> = {}, poster?: Uint8Array) =>
  api('POST', 'stickers.create', form(fields, file, poster), auth);
const sendSt = (auth: Auth, roomId: string, body: Record<string, unknown>) => api('POST', 'chat.sendSticker', { roomId, ...body }, auth);
const sendText = (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) =>
  api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const mine = (auth: Auth) => api('GET', 'stickers.list', { scope: 'mine' }, auth);
const orgList = (auth: Auth) => api('GET', 'stickers.list', { scope: 'org' }, auth);

async function orgPack(name: string, extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'stickers.packs.create', { scope: 'org', name, status: 'published', ...extra }, A);
  if (!r.pack) throw new Error(JSON.stringify(r));
  return r.pack;
}
async function orgSticker(packId: string, fields: Record<string, string> = {}, file: Uint8Array = still(), poster?: Uint8Array) {
  const r = await create(A, file, { packId, ...fields }, poster);
  if (!r.sticker) throw new Error(JSON.stringify(r));
  return r.sticker;
}
async function personalPack(auth: Auth, name: string) {
  const r = await api('POST', 'stickers.packs.create', { scope: 'personal', name }, auth);
  if (!r.pack) throw new Error(JSON.stringify(r));
  return r.pack._id as string;
}

async function withSettings(values: Record<string, unknown>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, getSetting(k)]));
  const r = await api('POST', 'settings', { settings: values }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
  try {
    await fn();
  } finally {
    await api('POST', 'settings', { settings: before }, A);
  }
}

const fileRow = async (fileId: string) => (await pool.query('SELECT *, phash::text AS phash FROM sticker_files WHERE id = $1', [fileId])).rows[0];
const lastMessage = async (rid: string) => (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [rid])).rows[0].last_message;
const messageRow = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);

// Inverte n bits espalhados: distância de Hamming exata.
function flip(hex: string, n: number) {
  let v = BigInt(`0x${hex}`);
  for (let i = 0; i < n; i++) v ^= 1n << BigInt(i * 7);
  return v.toString(16).padStart(16, '0');
}
const H_BOM_DIA = '0123456789abcdef';
const H_RESTRITA = '3c3c3c3c5a5a5a5a';
const H_REMOVIVEL = 'f0e1d2c3b4a59687';

// Espera até alguma sessão estar parada numa trava, com a consulta indicada.
async function waitForLock(pattern: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${pattern}%`],
    );
    if (r.rowCount) return;
    await sleep(25);
  }
  throw new Error(`ninguém esperando trava em: ${pattern}`);
}

function unzip(buf: Buffer): Promise<{ name: string; data: Buffer; crc: number }[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: { name: string; data: Buffer; crc: number }[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks), crc: entry.crc32 });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const ctxOf = (a: Auth): Ctx => ({ userId: a.userId, username: a.username, sessionId: 'teste' });

// ---------- 1 e 2: antes de qualquer papel ou permissão criados pelo teste ----------

describe('figurinhas: permissões, configurações e agendador', () => {
  it('semeia as permissões novas sem mexer no papel operacao', async () => {
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    expect(perms.find((p) => p._id === 'manage-sticker-packs')!.roles).toEqual(['admin']);
    expect([...perms.find((p) => p._id === 'create-personal-stickers')!.roles].sort()).toEqual(['admin', 'user']);
    expect(perms.filter((p) => p.roles.includes('operacao')).map((p) => p._id).sort()).toEqual([...OPERACAO_PERMISSIONS].sort());

    const stickerSettings = listSettings().filter((s) => s._id.startsWith('Stickers_'));
    expect(stickerSettings.length).toBe(15);
    for (const s of stickerSettings) expect(!!(s as any).public).toBe(s._id !== 'Stickers_Removed_Keep_Days');
    const pub = (await api('GET', 'settings.public')).settings.map((s: any) => s._id);
    expect(pub).toContain('Stickers_Enabled');
    expect(pub).not.toContain('Stickers_Removed_Keep_Days');

    for (const v of [0, 5000]) {
      const r = await api('POST', 'settings', { settings: { Stickers_Max_Static_KB: v } }, A);
      expect(r.status).toBe(400);
    }
    expect(getSetting('Stickers_Max_Static_KB')).toBe(256);
    const bad = await api('POST', 'settings', { settings: { Stickers_Send_Blocked_Roles: 'operaçao' } }, A);
    expect(bad.status).toBe(400);
    expect(bad.error).toContain('Papel inexistente: operaçao.');
    expect(getSetting('Stickers_Send_Blocked_Roles')).toBe('');
  });

  it('chave de lock única no agendador', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/scheduler.ts'), 'utf8');
    const keys = [...src.matchAll(/withLock\((\d+)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(3);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === '727111')).toHaveLength(1);
  });
});

// ---------- O resto ----------

describe('figurinhas', () => {
  let sup: Auth;
  let sup2: Auth;
  let op1: Auth;
  let op2: Auth;
  let pub: Auth;
  let com: Auth;
  let mod: Auth;
  let geral: string;
  let diretoria: string;
  let avisos: string;
  let dmSupOp1: string;
  let dmOps: string;
  let livechat: string;
  let org1: string;
  let bomDia: any;

  beforeAll(async () => {
    for (const name of ['supervisao', 'comunicacao', 'moderacao']) {
      const r = await api('POST', 'roles.create', { name, scope: 'Users' }, A);
      if (!r.success) throw new Error(JSON.stringify(r));
    }
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    const plus = (id: string, role: string) => ({ _id: id, roles: [...perms.find((p) => p._id === id)!.roles, role] });
    await api(
      'POST',
      'permissions.update',
      { permissions: [plus('manage-sticker-packs', 'comunicacao'), plus('view-moderation-console', 'moderacao'), plus('manage-moderation-actions', 'moderacao')] },
      A,
    );
    sup = await newUser(A);
    sup2 = await newUser(A, { roles: ['user', 'supervisao'] });
    op1 = await newUser(A, { roles: ['operacao'] });
    op2 = await newUser(A);
    pub = await newUser(A);
    com = await newUser(A, { roles: ['comunicacao'] });
    mod = await newUser(A, { roles: ['user', 'moderacao'] });
    geral = (await api('GET', 'rooms.info', { roomName: 'geral' }, A)).room._id;
    diretoria = (await api('POST', 'groups.create', { name: `diretoria-${Date.now()}`, members: [sup.username] }, A)).group._id;
    const av = await api('POST', 'channels.create', { name: `avisos-${Date.now()}`, members: [op1.username, pub.username, sup.username], extraData: { notice: true, noticeAck: true } }, A);
    avisos = av.channel._id;
    expect((await api('POST', 'channels.addPublisher', { roomId: avisos, userId: pub.userId }, A)).status).toBe(200);
    dmSupOp1 = (await api('POST', 'im.create', { username: op1.username }, sup)).room._id;
    // DM antiga entre dois operadores: aberta antes de op2 virar operador (como no teste das regras de operação).
    dmOps = (await api('POST', 'im.create', { username: op2.username }, op1)).room._id;
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: op2.username }, A);
    await api('POST', 'roles.removeUserFromRole', { roleId: 'user', username: op2.username }, A);
    livechat = newId();
    await pool.query(`INSERT INTO rooms (id, t, name, fname) VALUES ($1, 'l', $2, 'Atendimento')`, [livechat, `atendimento-${livechat}`]);
  });

  it('admin cria pacote da organização em rascunho, adiciona figurinha e publica', async () => {
    const draft = await api('POST', 'stickers.packs.create', { scope: 'org', name: 'Atendimento' }, A);
    expect(draft.pack).toMatchObject({ scope: 'org', status: 'draft', name: 'Atendimento', count: 0, visibleRoles: [] });
    org1 = draft.pack._id;
    const s = await create(A, still(), { packId: org1, name: 'Bom dia', emojis: '["☀️"]', keywords: 'manhã, Saudação', phash: H_BOM_DIA });
    expect(s.status).toBe(200);
    expect(s.sticker).toMatchObject({ packId: org1, name: 'Bom dia', emojis: ['☀️'], keywords: ['manhã', 'saudação'], mime: 'image/webp', width: 512, height: 512, animated: false });
    expect(s.sticker.url).toBe(`/sticker/${s.sticker.fileId}.webp`);
    bomDia = s.sticker;
    expect((await fileRow(bomDia.fileId)).phash).not.toBeNull();

    const sees = async (who: Auth) => (await orgList(who)).packs.some((p: any) => p._id === org1);
    expect(await sees(op1)).toBe(false);
    expect((await api('GET', 'stickers.list', { scope: 'org', includeDrafts: 'true' }, A)).packs.some((p: any) => p._id === org1)).toBe(true);
    expect((await api('POST', 'stickers.packs.update', { packId: org1, status: 'published' }, A)).pack.status).toBe('published');
    expect(await sees(op1)).toBe(true);

    flushStickerNotifications();
    const ws = connectWs(op1);
    await ws.ready;
    try {
      await api('POST', 'stickers.packs.update', { packId: org1, description: 'Saudações' }, A);
      await api('POST', 'stickers.update', { stickerId: bomDia._id, keywords: ['manhã', 'saudação', 'oi'] }, A);
      await api('POST', 'stickers.packs.update', { packId: org1, description: 'Saudações do dia' }, A);
      await sleep(200);
      expect(ws.events.filter((e) => e.type === 'stickers.changed')).toHaveLength(0);
      flushStickerNotifications();
      await ws.waitFor((e) => e.type === 'stickers.changed');
      await sleep(300);
      const got = ws.events.filter((e) => e.type === 'stickers.changed');
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ type: 'stickers.changed', scope: 'org' });
    } finally {
      ws.close();
    }
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE action LIKE 'sticker%'`)).rows.map((r) => r.action);
    expect(actions).toContain('sticker_pack.created');
    expect(actions).toContain('sticker.created');
    expect(actions).toContain('sticker_pack.updated');
    expect(actions).toContain('sticker.updated');
  });

  it('multipart: dois arquivos passam e campo depois de arquivo é recusado', async () => {
    const r = await create(A, anim(), { packId: org1, name: 'Aceno' }, posterFor());
    expect(r.status).toBe(200);
    expect(r.sticker).toMatchObject({ animated: true, frames: 3, durationMs: 600, width: 256, height: 256 });
    expect(r.sticker.posterUrl).toBe(`/sticker/${r.sticker.fileId}/poster.png`);
    const fd = new FormData();
    fd.append('packId', org1);
    fd.append('file', blob(still()), 'f.webp');
    fd.append('name', 'Tarde');
    const late = await api('POST', 'stickers.create', fd, A);
    expect(late.status).toBe(400);
    expect(late.errorType).toBe('error-invalid-params');
    expect(late.error).toBe('Envie os campos antes dos arquivos.');
    const other = new FormData();
    other.append('packId', org1);
    other.append('foto', blob(still()), 'f.webp');
    expect((await api('POST', 'stickers.create', other, A)).status).toBe(400);
  });

  it('versão do catálogo devolve unchanged e muda quando o pacote muda', async () => {
    const first = await orgList(op1);
    expect(first.version).toMatch(/^o\d+-[0-9a-f]{8}$/);
    expect(first.userId).toBe(op1.userId);
    const same = await api('GET', 'stickers.list', { scope: 'org', version: first.version }, op1);
    expect(same).toMatchObject({ status: 200, scope: 'org', version: first.version, unchanged: true });
    expect(same.packs).toBeUndefined();
    // Rascunhos pedidos por um gestor têm outra versão: o cache de um não serve ao outro.
    const drafts = await api('GET', 'stickers.list', { scope: 'org', includeDrafts: 'true' }, A);
    const plain = await orgList(A);
    expect(drafts.version).not.toBe(plain.version);
    await api('POST', 'stickers.packs.update', { packId: org1, description: 'Saudações e despedidas' }, A);
    const after = await api('GET', 'stickers.list', { scope: 'org', version: first.version }, op1);
    expect(after.unchanged).toBeUndefined();
    expect(after.version).not.toBe(first.version);
    const m1 = await mine(op1);
    expect(m1.version).toMatch(/^u\d+-o\d+-[0-9a-f]{8}$/);
    expect((await api('GET', 'stickers.list', { scope: 'mine', version: m1.version }, op1)).unchanged).toBe(true);
    expect((await api('GET', 'stickers.list', { scope: 'tudo' }, op1)).status).toBe(400);
  });

  it('operador envia figurinha da organização, favorita e não cria', async () => {
    const r = await sendSt(op1, geral, { stickerId: bomDia._id });
    expect(r.status).toBe(200);
    expect(r.message.msg).toBe('');
    expect(r.message.sticker).toEqual({
      fileId: bomDia.fileId,
      name: 'Bom dia',
      emojis: ['☀️'],
      width: 512,
      height: 512,
      animated: false,
      url: bomDia.url,
      scope: 'org',
      stickerId: bomDia._id,
      packId: org1,
      packName: 'Atendimento',
    });
    const fallback = r.message.attachments.filter((a: any) => a.type === 'sticker');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ title: 'Bom dia', image_url: bomDia.url, image_dimensions: { width: 512, height: 512 }, image_type: 'image/webp' });
    expect((await messageRow(r.message._id)).sticker_file_id).toBe(bomDia.fileId);
    expect((await lastMessage(geral)).msg).toBe('☀️ Figurinha “Bom dia”');

    const fav = await api('POST', 'stickers.favorite', { messageId: r.message._id, favorite: true }, op1);
    expect(fav).toMatchObject({ status: 200, favorite: true, fileId: bomDia.fileId });
    expect((await create(op1, still())).status).toBe(403);
    expect((await api('POST', 'stickers.save', { stickerId: bomDia._id }, op1)).status).toBe(403);
    expect((await api('POST', 'stickers.packs.create', { scope: 'personal', name: 'Meu' }, op1)).status).toBe(403);
    const m = await mine(op1);
    expect(m.packs).toEqual([]);
    expect(m.favorites).toHaveLength(1);
    expect(m.favorites[0]).toMatchObject({ kind: 'favorite', fileId: bomDia.fileId, scope: 'org', stickerId: bomDia._id, packId: org1, packName: 'Atendimento', name: 'Bom dia', emojis: ['☀️'] });
    expect(m.recents[0]).toMatchObject({ kind: 'recent', fileId: bomDia.fileId, scope: 'org' });
    expect(m.quota).toMatchObject({ packs: 0, maxPacks: 5, bytes: 0, quotaBytes: 20 * 1024 * 1024 });
  });

  it('reenvio com o mesmo _id devolve a mesma mensagem', async () => {
    const id = `fig${Date.now().toString(36)}abc`;
    const a = await sendSt(op1, geral, { stickerId: bomDia._id, _id: id });
    const b = await sendSt(op1, geral, { stickerId: bomDia._id, _id: id });
    expect(a.message._id).toBe(id);
    expect(b.message._id).toBe(id);
    expect(await count('SELECT count(*) AS n FROM messages WHERE id = $1', [id])).toBe(1);
    const other = await sendSt(sup, dmSupOp1, { stickerId: bomDia._id, _id: id });
    expect(other.status).toBe(200);
    expect(other.message._id).not.toBe(id);
    expect(other.message.rid).toBe(dmSupOp1);
  });

  it('chat.sendMessage não forja figurinha', async () => {
    const fake = { fileId: bomDia.fileId, name: 'Falsa', emojis: [], width: 512, height: 512, animated: false, url: bomDia.url, scope: 'org' };
    const a = await sendText(sup, geral, '', { attachments: [{ type: 'sticker', image_url: bomDia.url, title: 'Falsa' }] });
    const b = await sendText(sup, geral, 'oi', { customFields: { sticker: fake }, sticker: fake });
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.message.sticker).toBeUndefined();
      expect(r.message.attachments.some((x: any) => x.type === 'sticker')).toBe(false);
      const row = await messageRow(r.message._id);
      expect(row.sticker_file_id).toBeNull();
      expect(row.extra.sticker).toBeUndefined();
    }
    const empty = await sendText(sup, geral, '', { sticker: fake });
    expect(empty.status).toBe(400);
  });

  it('figurinha segue as regras da sala', async () => {
    const reader = await sendSt(op1, avisos, { stickerId: bomDia._id });
    expect(reader.status).toBe(403);
    expect(reader.error).toBe('Este é um canal de avisos: só os publicadores enviam mensagens.');
    expect(await sendSt(pub, avisos, { stickerId: bomDia._id })).toMatchObject({
      status: 403,
      errorType: 'error-sticker-not-allowed-here',
      error: 'Figurinhas não são permitidas em canais de avisos.',
    });
    await withSettings({ Stickers_In_Notice_Rooms: true }, async () => {
      const ok = await sendSt(pub, avisos, { stickerId: bomDia._id });
      expect(ok.status).toBe(200);
      expect(ok.message.ackRequired).toBeFalsy();
      expect((await messageRow(ok.message._id)).ack_required).toBe(false);
    });

    const arch = (await api('POST', 'channels.create', { name: `arquivada-${Date.now()}`, members: [sup.username] }, A)).channel._id;
    await api('POST', 'channels.archive', { roomId: arch }, A);
    expect(await sendSt(sup, arch, { stickerId: bomDia._id })).toMatchObject({ status: 400, errorType: 'error-room-archived' });

    const muted = (await api('POST', 'channels.create', { name: `silencio-${Date.now()}`, members: [sup.username] }, A)).channel._id;
    await api('POST', 'rooms.muteUser', { roomId: muted, username: sup.username }, A);
    const m = await sendSt(sup, muted, { stickerId: bomDia._id });
    expect(m.status).toBe(403);
    expect(m.error).toBe((await sendText(sup, muted, 'oi')).error);

    expect(await sendSt(sup, livechat, { stickerId: bomDia._id })).toMatchObject({
      status: 403,
      errorType: 'error-sticker-not-allowed-here',
      error: 'Figurinhas não estão disponíveis em atendimentos.',
    });
    expect((await sendSt(op1, diretoria, { stickerId: bomDia._id })).status).toBe(403);
    expect((await sendSt(op1, 'naoexiste1234567', { stickerId: bomDia._id })).status).toBe(404);
    expect((await sendSt(op1, geral, {})).errorType).toBe('error-invalid-params');
    expect((await sendSt(op1, geral, { stickerId: bomDia._id, fileId: bomDia.fileId })).error).toBe('Informe a figurinha.');

    const root = await sendText(sup, geral, 'pergunta da thread');
    const reply = await sendSt(op1, geral, { stickerId: bomDia._id, tmid: root.message._id, tshow: true });
    expect(reply.status).toBe(200);
    expect(reply.message.tmid).toBe(root.message._id);
    expect((await messageRow(root.message._id)).tcount).toBe(1);
    expect((await lastMessage(geral))._id).toBe(reply.message._id);
  });

  it('restrição de conversa direta vale para figurinhas', async () => {
    const text = await sendText(op1, dmOps, 'oi');
    expect(text.errorType).toBe('error-direct-restricted');
    const st = await sendSt(op1, dmOps, { stickerId: bomDia._id });
    expect(st.status).toBe(403);
    expect(st.errorType).toBe('error-direct-restricted');
    expect(st.error).toBe(text.error);
    expect((await sendSt(op1, `@${op2.username}`, { stickerId: bomDia._id })).status).toBe(404);
    expect((await sendSt(sup, dmSupOp1, { stickerId: bomDia._id })).status).toBe(200);
  });

  it('papel bloqueado não envia', async () => {
    await withSettings({ Stickers_Send_Blocked_Roles: ' operacao, ' }, async () => {
      expect(await sendSt(op1, geral, { stickerId: bomDia._id })).toMatchObject({
        status: 403,
        errorType: 'error-sticker-send-blocked',
        error: 'Seu perfil não pode enviar figurinhas.',
      });
      expect((await sendSt(sup, geral, { stickerId: bomDia._id })).status).toBe(200);
    });
    expect((await sendSt(op1, geral, { stickerId: bomDia._id })).status).toBe(200);
  });

  let supPersonal: any;
  let supPack: string;

  it('figurinha pessoal segue a política de upload', async () => {
    const created = await create(sup, still(), { name: 'Minha' });
    expect(created.status).toBe(200);
    supPersonal = created.sticker;
    const packs = (await mine(sup)).packs;
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ name: 'Minhas figurinhas', scope: 'personal', status: 'published', count: 1 });
    supPack = packs[0]._id;
    const s = await sendSt(sup, geral, { stickerId: supPersonal._id });
    expect(s.status).toBe(200);
    expect(s.message.sticker).toMatchObject({ scope: 'personal', name: 'Minha', fileId: supPersonal.fileId });
    expect(s.message.sticker.packId).toBeUndefined();
    expect(s.message.sticker.stickerId).toBeUndefined();

    await withSettings({ FileUpload_Enabled_Direct: false }, async () => {
      expect(await sendSt(sup, dmSupOp1, { stickerId: supPersonal._id })).toMatchObject({
        status: 403,
        errorType: 'error-sticker-personal-not-allowed',
        error: 'Nesta conversa só dá para enviar figurinhas da organização.',
      });
      expect((await sendSt(sup, dmSupOp1, { stickerId: bomDia._id })).status).toBe(200);
    });
    await withSettings({ FileUpload_Enabled: false }, async () => {
      expect((await sendSt(sup, geral, { fileId: supPersonal.fileId })).errorType).toBe('error-sticker-personal-not-allowed');
      expect((await sendSt(sup, geral, { stickerId: bomDia._id })).status).toBe(200);
    });
    await withSettings({ Stickers_Personal_Enabled: false }, async () => {
      expect(await sendSt(sup, geral, { stickerId: supPersonal._id })).toMatchObject({ status: 403, errorType: 'error-sticker-personal-disabled' });
      expect((await sendSt(sup, geral, { stickerId: bomDia._id })).status).toBe(200);
    });

    const g = await create(sup, gif({ w: 128, h: 128, frames: 1, seed: nextSeed() }), { name: 'Gif parado' });
    expect(g.status).toBe(200);
    expect(g.sticker.mime).toBe('image/gif');
    await withSettings({ FileUpload_MediaTypeBlackList: 'image/gif' }, async () => {
      expect(await sendSt(sup, geral, { stickerId: g.sticker._id })).toMatchObject({ status: 403, errorType: 'error-sticker-personal-not-allowed' });
      expect(await create(sup, gif({ w: 128, h: 128, frames: 1, seed: nextSeed() }))).toMatchObject({ status: 400, errorType: 'error-invalid-file-type' });
    });
  });

  it('mesma regra de tipo no cliente e no servidor', () => {
    const before = [getSetting('FileUpload_MediaTypeWhiteList'), getSetting('FileUpload_MediaTypeBlackList')];
    try {
      const table: [string, string][] = [
        ['', ''],
        ['image/*', ''],
        ['image/png', ''],
        ['', 'image/gif'],
        ['image/*', 'image/webp'],
        [' IMAGE/PNG , image/gif ', ''],
        ['application/pdf', ''],
        ['', 'image/*'],
      ];
      for (const [white, black] of table) {
        setSettingCache('FileUpload_MediaTypeWhiteList', white);
        setSettingCache('FileUpload_MediaTypeBlackList', black);
        for (const t of ['image/png', 'image/webp', 'image/gif']) expect(mediaTypeAllowed(t, white, black)).toBe(typeAllowed(t));
      }
    } finally {
      setSettingCache('FileUpload_MediaTypeWhiteList', before[0]);
      setSettingCache('FileUpload_MediaTypeBlackList', before[1]);
    }
  });

  it('validação do arquivo', async () => {
    expect(await create(sup, webp({ kind: 'vp8l', w: 513, h: 100, seed: nextSeed() }))).toMatchObject({
      status: 400,
      errorType: 'error-sticker-dimensions',
      error: 'A figurinha precisa ter no máximo 512 × 512 px (esta tem 513 × 100).',
    });
    expect(await create(sup, still(80, 80))).toMatchObject({ status: 400, errorType: 'error-sticker-too-small', error: 'A figurinha precisa ter pelo menos 96 px no lado maior.' });
    expect(await create(sup, png({ w: 512, h: 512, noise: true, seed: nextSeed() }))).toMatchObject({
      status: 413,
      errorType: 'error-sticker-too-large',
      error: 'A figurinha passa do limite de 256 KB.',
    });
    expect(await create(sup, jpeg({ w: 200, h: 200 }))).toMatchObject({ status: 400, errorType: 'error-sticker-format', error: 'Formato não suportado. Use PNG, WebP ou GIF.' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script></svg>');
    expect((await create(sup, svg)).errorType).toBe('error-sticker-format');
    expect((await create(sup, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(10)]))).status).toBe(400);
    expect(await create(sup, anim())).toMatchObject({ status: 400, errorType: 'error-sticker-poster-required', error: 'Falta a imagem parada da figurinha animada.' });
    expect(await create(sup, anim(), {}, posterFor(128, 128))).toMatchObject({
      status: 400,
      errorType: 'error-sticker-poster-invalid',
      error: 'A imagem parada da figurinha animada é inválida.',
    });
    expect((await create(sup, anim(), {}, anim())).errorType).toBe('error-sticker-poster-invalid');
    expect(await create(sup, gif({ w: 128, h: 128, frames: 2, delaysCs: [550, 550], seed: nextSeed() }))).toMatchObject({
      status: 400,
      errorType: 'error-sticker-too-long',
      error: 'A animação passa do limite de 10 segundos.',
    });
    expect((await create(sup, still(), { phash: 'XYZ' })).error).toBe('Hash da imagem inválido.');
    await withSettings({ Stickers_Animated_Enabled: false }, async () => {
      expect(await create(sup, anim(), {}, posterFor())).toMatchObject({ status: 403, errorType: 'error-sticker-animated-disabled' });
      expect((await create(sup, still())).status).toBe(200);
    });

    // EXIF, XMP e bytes depois do fim não chegam ao disco; o hash é o do arquivo limpo.
    const s = nextSeed();
    const clean = webp({ kind: 'vp8x', w: 300, h: 300, seed: s });
    const dirty = webp({ kind: 'vp8x', w: 300, h: 300, seed: s, exif: true, xmp: true, trailing: 'sobras no fim' });
    const up = await create(sup, dirty, { name: 'Limpa' });
    expect(up.status).toBe(200);
    const row = await fileRow(up.sticker.fileId);
    const stored = fs.readFileSync(storedPath(row.path));
    const canonical = Buffer.from(canonicalize(clean, 'webp'));
    expect(stored.equals(canonical)).toBe(true);
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);
    expect(stored.includes(Buffer.from('sobras'))).toBe(false);
    expect(row.sha256).toBe(createHash('sha256').update(canonical).digest('hex'));
    const served = await raw(up.sticker.url, sup);
    expect(Buffer.from(await served.arrayBuffer()).equals(canonical)).toBe(true);
    const again = await create(sup, clean, { packId: await personalPack(sup, 'Segundo') });
    expect(again.sticker.fileId).toBe(up.sticker.fileId);
  });

  it('conteúdo repetido reaproveita o arquivo', async () => {
    const bytes = still();
    const second = (await mine(sup)).packs.find((p: any) => p.name === 'Segundo')._id;
    const a = await create(sup, bytes, { packId: supPack });
    const b = await create(sup, bytes, { packId: second });
    expect(a.status).toBe(200);
    expect(b.sticker.fileId).toBe(a.sticker.fileId);
    expect(await count('SELECT count(*) AS n FROM sticker_files WHERE sha256 = (SELECT sha256 FROM sticker_files WHERE id = $1)', [a.sticker.fileId])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM stickers WHERE file_id = $1', [a.sticker.fileId])).toBe(2);
    expect(await create(sup, bytes, { packId: second })).toMatchObject({ status: 400, errorType: 'error-sticker-duplicate', error: 'Esta figurinha já está neste pacote.' });
    expect((await api('POST', 'stickers.save', { stickerId: a.sticker._id, packId: second }, sup)).errorType).toBe('error-sticker-duplicate');
    expect((await api('POST', 'stickers.move', { stickerId: a.sticker._id, packId: second }, sup)).errorType).toBe('error-sticker-duplicate');
  });

  it('nomes passam pelo filtro de palavrões', async () => {
    const early = await create(sup, still(), { name: 'Bobo' });
    expect(early.sticker.name).toBe('Bobo');
    await withSettings({ Message_AllowBadWordsFilter: true, Message_BadWordsFilterList: 'bobo' }, async () => {
      const s = await create(sup, still(), { name: 'Bobo alegre', keywords: 'bobo,feliz' });
      expect(s.sticker.name).toBe('**** alegre');
      expect(s.sticker.keywords).toEqual(['****', 'feliz']);
      const p = await api('POST', 'stickers.packs.create', { scope: 'personal', name: 'Pacote bobo', description: 'só coisa boba e bobo' }, sup);
      expect(p.pack.name).toBe('Pacote ****');
      expect(p.pack.description).toBe('só coisa boba e ****');
      const m = await sendSt(sup, geral, { stickerId: early.sticker._id });
      expect(m.message.sticker.name).toBe('****');
      expect((await messageRow(m.message._id)).extra.sticker.name).toBe('****');
      await api('POST', 'stickers.packs.delete', { packId: p.pack._id }, sup);
    });
  });

  it('limites pessoais', async () => {
    const u = await newUser(A);
    const packs: string[] = [];
    for (let i = 1; i <= 5; i++) packs.push(await personalPack(u, `Pacote ${i}`));
    expect(await api('POST', 'stickers.packs.create', { scope: 'personal', name: 'Sexto' }, u)).toMatchObject({
      status: 400,
      errorType: 'error-sticker-packs-full',
      error: 'Você chegou ao limite de 5 pacotes.',
    });
    expect((await api('POST', 'stickers.packs.create', { scope: 'personal', name: '  ' }, sup)).errorType).toBe('error-sticker-pack-name');
    await withSettings({ Stickers_Personal_Max_Per_Pack: 2 }, async () => {
      expect((await create(u, still(), { packId: packs[0] })).status).toBe(200);
      expect((await create(u, still(), { packId: packs[0] })).status).toBe(200);
      expect(await create(u, still(), { packId: packs[0] })).toMatchObject({ status: 400, errorType: 'error-sticker-pack-full', error: 'Este pacote chegou ao limite de 2 figurinhas.' });
    });
    await withSettings({ Stickers_Personal_Quota_MB: 1 }, async () => {
      const big = () => png({ w: 290, h: 290, noise: true, seed: nextSeed() });
      for (let i = 0; i < 4; i++) {
        const r = await create(u, big(), { packId: packs[1] });
        expect(r.status).toBe(200);
        expect(r.sticker.size).toBeGreaterThan(240 * 1024);
      }
      expect(await create(u, big(), { packId: packs[1] })).toMatchObject({ status: 400, errorType: 'error-sticker-quota', error: 'Suas figurinhas passariam do limite de 1 MB.' });
      const q = (await mine(u)).quota;
      expect(q.quotaBytes).toBe(1024 * 1024);
      expect(q.bytes).toBeGreaterThan(4 * 240 * 1024);
    });
    // 50 favoritas prontas no banco; a 51ª é recusada.
    const fake: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = newId();
      fake.push(id);
      await pool.query(`INSERT INTO sticker_files (id, sha256, mime, width, height, size, path) VALUES ($1, $2, 'image/webp', 100, 100, 10, $3)`, [
        id,
        createHash('sha256').update(id).digest('hex'),
        `2026/01/${id}`,
      ]);
      await pool.query(`INSERT INTO sticker_user_items (user_id, kind, file_id, name) VALUES ($1, 'favorite', $2, 'F')`, [u.userId, id]);
    }
    try {
      expect(await api('POST', 'stickers.favorite', { stickerId: bomDia._id, favorite: true }, u)).toMatchObject({
        status: 400,
        errorType: 'error-sticker-favorites-full',
        error: 'Você já tem 50 favoritas. Remova alguma para adicionar outra.',
      });
      // Favoritar de novo uma que já está lá não conta como nova.
      expect((await api('POST', 'stickers.favorite', { fileId: fake[0], favorite: true }, u)).status).not.toBe(400);
    } finally {
      await pool.query('DELETE FROM sticker_files WHERE id = ANY($1)', [fake]);
    }
  });

  it('acesso aos bytes', async () => {
    const p = (await create(sup, still(), { name: 'Privada' })).sticker;
    expect((await sendSt(sup, diretoria, { stickerId: p._id })).status).toBe(200);
    const outsider = await newUser(A);
    expect((await raw(p.url, outsider)).status).toBe(404);
    expect((await raw(p.url, sup)).status).toBe(200);
    expect((await raw(`/sticker/${p.fileId}.png`, sup)).status).toBe(404);
    expect((await raw('/sticker/curto.webp', sup)).status).toBe(404);
    // A recusa fica guardada por 30 s: uma mensagem gravada por fora não muda a resposta.
    const sneaky = newId();
    await pool.query(`INSERT INTO messages (id, room_id, user_id, username, msg, sticker_file_id) VALUES ($1, $2, $3, $4, '', $5)`, [sneaky, geral, sup.userId, sup.username, p.fileId]);
    try {
      expect((await raw(p.url, outsider)).status).toBe(404);
      // Um envio de verdade numa sala da pessoa limpa a recusa na hora.
      expect((await sendSt(sup, geral, { stickerId: p._id })).status).toBe(200);
      const ok = await raw(p.url, outsider);
      expect(ok.status).toBe(200);
      const row = await fileRow(p.fileId);
      expect(ok.headers.get('content-type')).toBe('image/webp');
      expect(ok.headers.get('content-length')).toBe(String(row.size));
      expect(ok.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(ok.headers.get('content-disposition')).toBe('inline; filename="figurinha.webp"');
      const etag = ok.headers.get('etag')!;
      expect(etag).toBe(`"${row.sha256.slice(0, 32)}"`);
      const cookie = `rc_uid=${outsider.userId}; rc_token=${outsider.authToken}`;
      expect((await fetch(urlOf(p.url), { headers: { cookie, 'if-none-match': etag } })).status).toBe(304);
      expect((await fetch(urlOf(p.url))).status).toBe(401);
    } finally {
      await pool.query('DELETE FROM messages WHERE id = $1', [sneaky]);
    }

    const animated = (await create(sup, anim(), {}, posterFor())).sticker;
    const poster = await raw(animated.posterUrl, sup);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('image/png');
    expect(poster.headers.get('etag')).toMatch(/^"[0-9a-f]{32}-p"$/);
    expect((await raw(`/sticker/${animated.fileId}/poster.webp`, sup)).status).toBe(404);

    __setStickerByteLimitForTests(3);
    try {
      const statuses: number[] = [];
      let last: Response | null = null;
      for (let i = 0; i < 4; i++) {
        clearStickerAccessCache();
        last = await raw(p.url, outsider);
        statuses.push(last.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(last!.headers.get('retry-after')).toBe('60');
      expect((await last!.json()).errorType).toBe('error-too-many-requests');
      // Arquivo público da organização não passa pelo limite.
      expect((await raw(bomDia.url, outsider)).status).toBe(200);
    } finally {
      __setStickerByteLimitForTests(1200);
    }
  });

  let restricted: any;
  let restrictedMsg: any;

  it('pacote restrito por papel', async () => {
    const rp = await orgPack('Supervisão', { visibleRoles: ['supervisao'] });
    expect(rp.visibleRoles).toEqual(['supervisao']);
    expect((await api('POST', 'stickers.packs.create', { scope: 'org', name: 'Errado', visibleRoles: ['naoexiste'] }, A)).error).toBe('Papel inexistente: naoexiste.');
    const bytes = still();
    restricted = await orgSticker(rp._id, { name: 'Só supervisão', phash: H_RESTRITA }, bytes);
    expect((await orgList(sup2)).packs.some((p: any) => p._id === rp._id)).toBe(true);
    expect((await orgList(op1)).packs.some((p: any) => p._id === rp._id)).toBe(false);
    expect((await orgList(sup)).packs.some((p: any) => p._id === rp._id)).toBe(false);
    restrictedMsg = (await sendSt(sup2, geral, { stickerId: restricted._id })).message;
    expect(restrictedMsg.sticker.scope).toBe('org');

    expect((await raw(restricted.url, op1)).status).toBe(200);
    for (const target of [{ fileId: restricted.fileId }, { messageId: restrictedMsg._id }]) {
      expect(await api('POST', 'stickers.favorite', { ...target, favorite: true }, op1)).toMatchObject({
        status: 403,
        errorType: 'error-sticker-restricted',
        error: 'Esta figurinha é de um pacote restrito e não pode ser salva.',
      });
    }
    // op1 nem cria nem salva (falta create-personal-stickers); as recusas por restrição se veem com sup.
    expect((await api('POST', 'stickers.save', { messageId: restrictedMsg._id }, op1)).status).toBe(403);
    expect(await api('POST', 'stickers.save', { messageId: restrictedMsg._id }, sup)).toMatchObject({ status: 403, errorType: 'error-sticker-restricted' });
    expect(await create(sup, bytes)).toMatchObject({ status: 403, errorType: 'error-sticker-restricted' });
    expect(await create(sup, still(), { phash: flip(H_RESTRITA, 3) })).toMatchObject({ status: 403, errorType: 'error-sticker-restricted' });
    expect(await sendSt(op1, geral, { fileId: restricted.fileId })).toMatchObject({ status: 404, errorType: 'error-sticker-not-found' });
    expect(await create(sup, still(), { sourceMessageId: restrictedMsg._id })).toMatchObject({
      status: 400,
      errorType: 'error-sticker-source',
      error: 'Esta imagem já é uma figurinha. Use “Salvar nas minhas figurinhas”.',
    });
    const text = await sendText(sup, geral, 'sem imagem');
    expect((await create(sup, still(), { sourceMessageId: text.message._id })).error).toBe('Esta mensagem não tem uma imagem que possa virar figurinha.');
    expect((await create(sup, still(), { sourceMessageId: 'naoexiste12345' })).errorType).toBe('error-message-not-found');
    // Quem vê o pacote favorita normalmente; gestores também.
    expect((await api('POST', 'stickers.favorite', { fileId: restricted.fileId, favorite: true }, sup2)).status).toBe(200);
  });

  it('nome da favorita nunca vem do pacote pessoal de outra pessoa', async () => {
    const s = (await create(sup2, still(), { name: 'Sorriso', emojis: '😀' })).sticker;
    expect((await sendSt(sup2, geral, { stickerId: s._id })).status).toBe(200);
    const saved = await api('POST', 'stickers.save', { fileId: s.fileId, name: 'Chefe chato' }, sup);
    expect(saved.sticker).toMatchObject({ name: 'Chefe chato', fileId: s.fileId, packId: supPack });
    expect((await api('POST', 'stickers.favorite', { fileId: s.fileId, favorite: true }, op1)).status).toBe(200);
    const item = (await mine(op1)).favorites.find((f: any) => f.fileId === s.fileId);
    expect(item).toMatchObject({ name: 'Sorriso', emojis: ['😀'], scope: 'personal' });
    const row = (await pool.query(`SELECT name FROM sticker_user_items WHERE user_id = $1 AND file_id = $2`, [op1.userId, s.fileId])).rows[0];
    expect(row.name).toBe('Sorriso');
    // Desfavoritar uma que não existe é 200.
    expect((await api('POST', 'stickers.favorite', { fileId: s.fileId, favorite: false }, op1)).favorite).toBe(false);
    expect((await api('POST', 'stickers.favorite', { fileId: s.fileId, favorite: false }, op1)).status).toBe(200);
  });

  it('editar, apagar, citar e fixar', async () => {
    const room = (await api('POST', 'channels.create', { name: `editar-${Date.now()}`, members: [sup.username] }, A)).channel._id;
    const prev = await sendText(sup, room, 'anterior');
    const st = await sendSt(sup, room, { stickerId: bomDia._id });
    expect(await api('POST', 'chat.update', { roomId: room, msgId: st.message._id, text: 'texto' }, sup)).toMatchObject({
      status: 400,
      errorType: 'error-sticker-not-editable',
      error: 'Figurinhas não podem ser editadas.',
    });
    expect((await lastMessage(room)).msg).toBe('☀️ Figurinha “Bom dia”');
    expect((await api('POST', 'chat.delete', { roomId: room, msgId: st.message._id }, sup)).status).toBe(200);
    expect(await lastMessage(room)).toMatchObject({ _id: prev.message._id, msg: 'anterior' });

    const root = await sendSt(sup, room, { stickerId: bomDia._id });
    await sendText(A, room, 'resposta', { tmid: root.message._id });
    await api('POST', 'chat.delete', { roomId: room, msgId: root.message._id }, sup);
    const rm = await messageRow(root.message._id);
    expect(rm.t).toBe('rm');
    expect(rm.extra.sticker).toBeUndefined();
    expect(rm.sticker_file_id).toBeNull();

    const q1 = await sendSt(sup, room, { stickerId: bomDia._id });
    const q2 = await sendSt(A, room, { stickerId: bomDia._id, quoteMessageId: q1.message._id });
    const quote = q2.message.attachments.find((a: any) => a.message_link);
    expect(quote).toMatchObject({ text: '☀️ Figurinha', author_name: sup.username, message_link: `?msg=${q1.message._id}` });
    expect(q2.message.attachments.filter((a: any) => a.type === 'sticker')).toHaveLength(1);
    const q3 = await sendText(A, room, 'citando', { attachments: [{ message_link: `?msg=${q1.message._id}` }] });
    expect(q3.message.attachments[0].text).toBe('☀️ Figurinha');

    expect((await api('POST', 'chat.pinMessage', { messageId: q1.message._id }, A)).status).toBe(200);
    const sys = (await pool.query(`SELECT extra FROM messages WHERE room_id = $1 AND t = 'message_pinned'`, [room])).rows[0];
    expect(sys.extra.attachments[0].text).toBe('☀️ Figurinha');
  });

  it('notificação de figurinha', async () => {
    const ws = connectWs(op1);
    await ws.ready;
    try {
      const st = await sendSt(sup, dmSupOp1, { stickerId: bomDia._id });
      const n = await ws.waitFor((e) => e.type === 'notification' && e.messageId === st.message._id);
      expect(n.text).toContain('☀️ Figurinha “Bom dia”');
    } finally {
      ws.close();
    }
  });

  let removed: any;
  let removedBytes: Buffer;
  let removedMsgs: string[] = [];

  it('remover de todas as conversas', async () => {
    const pk = await orgPack('Removíveis');
    removedBytes = still();
    removed = await orgSticker(pk._id, { name: 'Removível', emojis: '😈', phash: H_REMOVIVEL }, removedBytes);
    expect((await api('POST', 'stickers.save', { stickerId: removed._id }, sup)).status).toBe(200);
    expect((await api('POST', 'stickers.favorite', { stickerId: removed._id, favorite: true }, op1)).status).toBe(200);
    expect((await api('POST', 'stickers.favorite', { stickerId: removed._id, favorite: true }, sup2)).status).toBe(200);
    const m1 = await sendSt(op1, geral, { stickerId: removed._id });
    const m2 = await sendSt(sup, geral, { stickerId: removed._id });
    const m3 = await sendSt(sup, diretoria, { stickerId: removed._id });
    removedMsgs = [m1, m2, m3].map((m) => m.message._id);
    await api('POST', 'chat.reportMessage', { messageId: m1.message._id, description: 'ofensiva' }, sup2);
    const before = await fileRow(removed.fileId);

    const ws = connectWs(op1);
    await ws.ready;
    try {
      const r = await api('POST', 'stickers.removeEverywhere', { fileId: removed.fileId, reason: '  teste 50%_ok  ' }, mod);
      expect(r).toMatchObject({ status: 200, fileId: removed.fileId, messages: 3, packs: 2 });
      expect(r.users).toBeGreaterThanOrEqual(2);
      await ws.waitFor((e) => e.type === 'sticker.removed' && e.fileId === removed.fileId);
      await sleep(300);
      expect(ws.events.filter((e) => e.type === 'sticker.removed' && e.fileId === removed.fileId)).toHaveLength(1);
    } finally {
      ws.close();
    }
    expect(fs.existsSync(storedPath(before.path))).toBe(false);
    expect(fs.readFileSync(storedPath(`quarantine/${removed.fileId}`)).equals(Buffer.from(canonicalize(removedBytes, 'webp')))).toBe(true);
    const after = await fileRow(removed.fileId);
    expect(after).toMatchObject({ path: null, blocked_reason: 'teste 50%_ok', blocked_name: 'Removível', quarantine_path: `quarantine/${removed.fileId}` });
    expect(after.blocked_by).toEqual({ _id: mod.userId, username: mod.username });
    const days = (new Date(after.quarantine_until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    for (const id of removedMsgs) {
      const row = await messageRow(id);
      expect(row.extra.sticker).toEqual({ fileId: removed.fileId, removed: true, width: 512, height: 512 });
      expect(row.attachments).toEqual([{ type: 'sticker', text: 'Figurinha removida' }]);
    }
    expect((await lastMessage(diretoria)).msg).toBe('Figurinha removida');
    expect((await pool.query('SELECT resolved FROM moderation_reports WHERE message_id = $1', [m1.message._id])).rows[0].resolved).toBe(true);
    expect(await count('SELECT count(*) AS n FROM stickers WHERE file_id = $1', [removed.fileId])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM sticker_user_items WHERE file_id = $1', [removed.fileId])).toBe(0);

    const gone = await raw(removed.url, op1);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ success: false, errorType: 'error-sticker-removed' });
    // O mesmo que `curl -I --cookie …` da definição de pronto.
    const head = await fetch(urlOf(removed.url), { method: 'HEAD', headers: { cookie: `rc_uid=${op1.userId}; rc_token=${op1.authToken}` } });
    expect(head.status).toBe(410);
    const q = await raw(`${removed.url}?q=1`, mod);
    expect(q.status).toBe(200);
    expect(q.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await q.arrayBuffer()).equals(Buffer.from(canonicalize(removedBytes, 'webp')))).toBe(true);
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'sticker.quarantine_viewed' AND target->>'fileId' = $1`, [removed.fileId])).toBe(1);
    expect((await raw(`${removed.url}?q=1`, sup)).status).toBe(410);

    expect(await create(sup, removedBytes)).toMatchObject({
      status: 403,
      errorType: 'error-sticker-blocked',
      error: 'Esta imagem foi removida pela moderação e não pode virar figurinha.',
    });
    const near = still();
    expect(await create(sup, near, { phash: flip(H_REMOVIVEL, 4) })).toMatchObject({
      status: 403,
      errorType: 'error-sticker-blocked-similar',
      error: 'Esta imagem é parecida demais com uma figurinha removida pela moderação. Se for um engano, fale com a moderação.',
    });
    expect((await create(mod, near, { phash: flip(H_REMOVIVEL, 4) })).status).toBe(200);
    expect(await sendSt(sup, geral, { fileId: removed.fileId })).toMatchObject({ status: 410, errorType: 'error-sticker-removed' });
    expect((await api('POST', 'stickers.favorite', { messageId: m2.message._id, favorite: true }, sup)).status).toBe(410);

    const audit = (await pool.query(`SELECT data FROM audit_log WHERE action = 'sticker.removed_everywhere' AND target->>'fileId' = $1`, [removed.fileId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ name: 'Removível', reason: 'teste 50%_ok', messages: 3, packs: 2, keepDays: 30, sha256: before.sha256 });
    expect(await api('POST', 'stickers.removeEverywhere', { messageId: m1.message._id }, mod)).toMatchObject({ status: 200, alreadyRemoved: true, messages: 0 });
    expect((await api('POST', 'stickers.removeEverywhere', { fileId: removed.fileId }, sup)).status).toBe(403);
  });

  it('gestor de pacotes não é moderador', async () => {
    const pk = await orgPack('Gestão');
    const y = await orgSticker(pk._id);
    expect(await api('POST', 'stickers.removeEverywhere', { fileId: y.fileId }, com)).toMatchObject({ status: 200, fileId: y.fileId });

    const p = (await create(sup, still(), { name: 'Só minha' })).sticker;
    expect(await api('POST', 'stickers.removeEverywhere', { fileId: p.fileId }, com)).toMatchObject({
      status: 403,
      errorType: 'error-sticker-remove-not-allowed',
      error: 'Só a moderação pode remover de todas as conversas uma figurinha que não está nos pacotes da organização.',
    });
    expect((await sendSt(sup, dmSupOp1, { stickerId: p._id })).status).toBe(200);
    expect((await raw(p.url, com)).status).toBe(404);
    expect((await raw(p.url, op1)).status).toBe(200);

    const z = await orgSticker(pk._id, { name: 'Usada' });
    expect((await api('POST', 'stickers.save', { stickerId: z._id }, sup)).status).toBe(200);
    expect((await sendSt(op1, geral, { stickerId: z._id })).status).toBe(200);
    const u1 = (await api('GET', 'stickers.usage', { fileId: z.fileId }, com)).usage;
    expect(u1).toMatchObject({ fileId: z.fileId, messages: 1, rooms: 1, packCount: 2, favorites: 0, blocked: false, keepDays: 30 });
    expect(u1.packs).toEqual([{ _id: pk._id, name: 'Gestão', scope: 'org' }]);
    expect(u1.provenance).toBeUndefined();
    expect((await api('GET', 'stickers.usage', { fileId: p.fileId }, com)).status).toBe(404);
    const u2 = (await api('GET', 'stickers.usage', { fileId: z.fileId }, mod)).usage;
    expect(u2.packs).toHaveLength(2);
    expect(u2.packs.find((x: any) => x.scope === 'personal').owner).toBe(sup.username);
    expect(u2.provenance.createdBy).toBe('admin');
    expect(u2.provenance.sources).toHaveLength(2);

    expect((await api('GET', 'stickers.blocked.list', {}, com)).status).toBe(403);
    expect((await api('POST', 'stickers.blocked.unblock', { fileId: y.fileId }, com)).status).toBe(403);
    const d = await sendSt(sup, diretoria, { stickerId: z._id });
    expect((await api('GET', 'stickers.usage', { messageId: d.message._id }, com)).status).toBe(404);
    expect((await api('GET', 'stickers.usage', { messageId: d.message._id }, mod)).status).toBe(200);
    expect((await api('GET', 'stickers.usage', { fileId: z.fileId }, sup)).status).toBe(403);
  });

  it('remover em paralelo com salvar não deixa figurinha viva', async () => {
    const pk = await orgPack('Corrida');
    const modCtx = ctxOf(mod);
    const race = async (fileId: string, write: (c: any) => Promise<unknown>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        expect(await lockLiveFile(client, fileId)).not.toBeNull();
        await write(client);
        const removal = removeEverywhere(modCtx, { fileId });
        await waitForLock('FOR UPDATE');
        await client.query('COMMIT');
        expect((await removal).messages).toBe(0);
      } finally {
        client.release();
      }
    };
    const s1 = await orgSticker(pk._id);
    await race(s1.fileId, (c) =>
      c.query(`INSERT INTO stickers (id, pack_id, file_id, name, sort, created_by) VALUES ($1, $2, $3, 'Corrida', 99, $4)`, [newId(), supPack, s1.fileId, sup.userId]),
    );
    expect(await count('SELECT count(*) AS n FROM stickers WHERE file_id = $1', [s1.fileId])).toBe(0);
    const s2 = await orgSticker(pk._id);
    await race(s2.fileId, (c) => c.query(`INSERT INTO sticker_user_items (user_id, kind, file_id, name) VALUES ($1, 'favorite', $2, 'Corrida')`, [op1.userId, s2.fileId]));
    expect(await count('SELECT count(*) AS n FROM sticker_user_items WHERE file_id = $1', [s2.fileId])).toBe(0);

    // Envio real chegando durante uma remoção: a checagem depois do envio reescreve a mensagem.
    const s3 = await orgSticker(pk._id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM sticker_files WHERE id = $1 FOR UPDATE', [s3.fileId]);
      await client.query(`UPDATE sticker_files SET blocked_at = now(), blocked_name = 'Corrida' WHERE id = $1`, [s3.fileId]);
      await rewriteRemovedStickerMessages(client, s3.fileId);
      const sending = sendSt(op1, geral, { stickerId: s3._id });
      await waitForLock('INSERT INTO messages');
      await client.query('COMMIT');
      const r = await sending;
      expect(r.status).toBe(200);
      expect(r.message.sticker).toEqual({ fileId: s3.fileId, removed: true, width: 512, height: 512 });
      expect((await messageRow(r.message._id)).extra.sticker.removed).toBe(true);
      expect((await lastMessage(geral)).msg).toBe('Figurinha removida');
    } finally {
      client.release();
    }
  });

  it('permitir de novo, também depois de uma corrida', async () => {
    const list = await api('GET', 'stickers.blocked.list', { text: '50%_' }, mod);
    const entry = list.files.find((f: any) => f.fileId === removed.fileId);
    expect(entry).toMatchObject({ name: 'Removível', reason: 'teste 50%_ok', messages: 3, quarantined: true, mime: 'image/webp' });
    expect(entry.blockedBy).toEqual({ _id: mod.userId, username: mod.username });
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect((await api('GET', 'stickers.blocked.list', { text: '5%k' }, mod)).files.some((f: any) => f.fileId === removed.fileId)).toBe(false);
    expect((await api('GET', 'stickers.blocked.list', { text: '0_' }, mod)).files.some((f: any) => f.fileId === removed.fileId)).toBe(false);
    expect((await api('GET', 'stickers.blocked.list', {}, mod)).files.length).toBeGreaterThanOrEqual(3);

    await pool.query(`INSERT INTO stickers (id, pack_id, file_id, name) VALUES ($1, $2, $3, 'Velha')`, [newId(), supPack, removed.fileId]);
    const quarantine = storedPath(`quarantine/${removed.fileId}`);
    expect(fs.existsSync(quarantine)).toBe(true);
    expect((await api('POST', 'stickers.blocked.unblock', { fileId: removed.fileId }, sup)).status).toBe(403);
    expect((await api('POST', 'stickers.blocked.unblock', { fileId: removed.fileId }, mod)).status).toBe(200);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(await fileRow(removed.fileId)).toBeUndefined();
    expect(await count('SELECT count(*) AS n FROM stickers WHERE file_id = $1', [removed.fileId])).toBe(0);
    for (const id of removedMsgs) {
      const row = await messageRow(id);
      expect(row.sticker_file_id).toBeNull();
      expect(row.extra.sticker.removed).toBe(true);
    }
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'sticker.unblocked' AND target->>'fileId' = $1`, [removed.fileId])).toBe(1);
    expect((await api('POST', 'stickers.blocked.unblock', { fileId: removed.fileId }, mod)).status).toBe(404);
    const again = await create(sup, removedBytes);
    expect(again.status).toBe(200);
    expect(again.sticker.fileId).not.toBe(removed.fileId);
  });

  it('quarentena vence e é apagada', async () => {
    const pk = await orgPack('Quarentena');
    const q = await orgSticker(pk._id, { name: 'Animada' }, anim(), posterFor());
    expect((await api('POST', 'stickers.removeEverywhere', { fileId: q.fileId }, mod)).status).toBe(200);
    const copy = storedPath(`quarantine/${q.fileId}`);
    const copyPoster = storedPath(`quarantine/${q.fileId}.poster`);
    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.existsSync(copyPoster)).toBe(true);
    await pool.query(`UPDATE sticker_files SET quarantine_until = now() - interval '1 day' WHERE id = $1`, [q.fileId]);
    expect((await gcStickerFiles()).purged).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(copyPoster)).toBe(false);
    expect(await fileRow(q.fileId)).toMatchObject({ quarantine_path: null, quarantine_poster_path: null, quarantine_until: null });
    expect((await fileRow(q.fileId)).blocked_at).not.toBeNull();
    expect((await raw(`${q.url}?q=1`, mod)).status).toBe(410);

    await withSettings({ Stickers_Removed_Keep_Days: 0 }, async () => {
      const q2 = await orgSticker(pk._id);
      const p = (await fileRow(q2.fileId)).path;
      expect((await api('POST', 'stickers.removeEverywhere', { fileId: q2.fileId }, mod)).status).toBe(200);
      expect(fs.existsSync(storedPath(p))).toBe(false);
      expect(fs.existsSync(storedPath(`quarantine/${q2.fileId}`))).toBe(false);
      expect(await fileRow(q2.fileId)).toMatchObject({ quarantine_path: null, quarantine_until: null });
    });
  });

  it('limpeza diária', async () => {
    const u = await newUser(A);
    const p1 = await personalPack(u, 'Temporário');
    const g = (await create(u, still(), { packId: p1 })).sticker;
    const gPath = (await fileRow(g.fileId)).path;
    await api('POST', 'stickers.packs.delete', { packId: p1 }, u);
    await gcStickerFiles();
    expect((await fileRow(g.fileId)).orphan_since).not.toBeNull();
    expect(fs.existsSync(storedPath(gPath))).toBe(true);
    await pool.query(`UPDATE sticker_files SET orphan_since = now() - interval '8 days' WHERE id = $1`, [g.fileId]);
    expect((await gcStickerFiles()).deleted).toBeGreaterThanOrEqual(1);
    expect(await fileRow(g.fileId)).toBeUndefined();
    expect(fs.existsSync(storedPath(gPath))).toBe(false);

    // Arquivo que só uma mensagem usa nunca é marcado.
    const p2 = await personalPack(u, 'Enviada');
    const h = (await create(u, still(), { packId: p2 })).sticker;
    expect((await sendSt(u, geral, { stickerId: h._id })).status).toBe(200);
    await api('POST', 'stickers.packs.delete', { packId: p2 }, u);
    await pool.query('DELETE FROM sticker_user_items WHERE file_id = $1', [h.fileId]);
    await gcStickerFiles();
    await gcStickerFiles();
    expect((await fileRow(h.fileId)).orphan_since).toBeNull();

    // Corrida: storeStickerFile trava a linha; a limpeza espera, relê e não apaga.
    const p3 = await personalPack(u, 'Corrida');
    const bytes = still();
    const r = (await create(u, bytes, { packId: p3 })).sticker;
    const rPath = (await fileRow(r.fileId)).path;
    await api('POST', 'stickers.packs.delete', { packId: p3 }, u);
    await pool.query(`UPDATE sticker_files SET orphan_since = now() - interval '8 days' WHERE id = $1`, [r.fileId]);
    const v = validateStickerBytes(bytes, { personal: false, phash: null });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect((await storeStickerFile(client, ctxOf(u), v, null)).id).toBe(r.fileId);
      const gc = gcStickerFiles();
      await waitForLock('DELETE FROM sticker_files');
      await client.query('COMMIT');
      await gc;
    } finally {
      client.release();
    }
    expect(await fileRow(r.fileId)).toBeDefined();
    expect(fs.existsSync(storedPath(rPath))).toBe(true);
  });

  it('lixeira tenta de novo quando o Windows segura o arquivo', async () => {
    const rel = await storeBuffer(still());
    await queueTrash(pool, rel);
    const realRm = fs.promises.rm.bind(fs.promises);
    let calls = 0;
    const busy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('arquivo em uso'), { code: 'EBUSY' });
      return realRm(...args);
    });
    try {
      expect(await drainStickerTrash({ only: [rel] })).toMatchObject({ done: 1, failed: 0 });
    } finally {
      busy.mockRestore();
    }
    expect(calls).toBe(3);
    expect(fs.existsSync(storedPath(rel))).toBe(false);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1', [rel])).toBe(0);

    const rel2 = await storeBuffer(still());
    await queueTrash(pool, rel2);
    const denied = vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('sem permissão'), { code: 'EPERM' }));
    try {
      expect(await drainStickerTrash({ only: [rel2] })).toMatchObject({ done: 0, failed: 1 });
      const row = (await pool.query('SELECT attempts, last_error FROM sticker_trash WHERE path = $1', [rel2])).rows[0];
      expect(row.attempts).toBe(1);
      expect(row.last_error).toMatch(/^EPERM: /);
      await pool.query(`UPDATE sticker_trash SET since = now() - interval '4 days' WHERE path = $1`, [rel2]);
      expect((await gcStickerFiles()).stuck).toBe(1);
    } finally {
      denied.mockRestore();
    }
    expect((await drainStickerTrash({ only: [rel2] })).done).toBe(1);
    expect(fs.existsSync(storedPath(rel2))).toBe(false);
  });

  it('recentes', async () => {
    __setStickerSendBurstForTests(100, 10_000);
    try {
      const pk = await orgPack('Recentes');
      const list: any[] = [];
      for (let i = 0; i < 31; i++) list.push(await orgSticker(pk._id, { name: `R${i}` }, still(96, 96)));
      const u = await newUser(A);
      flushStickerNotifications();
      const ws = connectWs(u);
      await ws.ready;
      try {
        for (const s of list) expect((await sendSt(u, geral, { stickerId: s._id })).status).toBe(200);
        let m = await mine(u);
        expect(m.recents).toHaveLength(30);
        expect(m.recents[0].fileId).toBe(list[30].fileId);
        expect(m.recents.map((r: any) => r.fileId)).not.toContain(list[0].fileId);
        expect(await count(`SELECT count(*) AS n FROM sticker_user_items WHERE user_id = $1 AND kind = 'recent'`, [u.userId])).toBe(30);
        expect((await sendSt(u, geral, { stickerId: list[5]._id })).status).toBe(200);
        m = await mine(u);
        expect(m.recents[0]).toMatchObject({ fileId: list[5].fileId, name: 'R5', scope: 'org' });
        await sleep(1300);
        expect(ws.events.filter((e) => e.type === 'stickers.changed' && e.scope === 'mine')).toHaveLength(0);
      } finally {
        ws.close();
      }
      expect((await api('POST', 'stickers.recents.remove', { fileId: list[5].fileId }, u)).status).toBe(200);
      const after = await mine(u);
      expect(after.recents).toHaveLength(29);
      expect(after.recents.map((r: any) => r.fileId)).not.toContain(list[5].fileId);
      expect((await api('POST', 'stickers.recents.clear', {}, u)).status).toBe(200);
      expect((await mine(u)).recents).toEqual([]);
    } finally {
      __setStickerSendBurstForTests(1000, 10_000);
    }
  });

  it('envio rápido demais', async () => {
    __setStickerSendBurstForTests(STICKER_LIMITS.sendBurst, STICKER_LIMITS.sendWindowMs);
    try {
      const u = await newUser(A);
      for (let i = 0; i < 8; i++) expect((await sendSt(u, geral, { stickerId: bomDia._id })).status).toBe(200);
      expect(await sendSt(u, geral, { stickerId: bomDia._id })).toMatchObject({
        status: 429,
        errorType: 'error-sticker-too-fast',
        error: 'Muitas figurinhas seguidas. Espere alguns segundos.',
      });
    } finally {
      __setStickerSendBurstForTests(1000, 10_000);
    }
  });

  it('importação adia o aviso para todos', async () => {
    const pk = await orgPack('Importação');
    flushStickerNotifications();
    const ws = connectWs(op1);
    await ws.ready;
    try {
      for (let i = 0; i < 5; i++) expect((await create(A, still(), { packId: pk._id, batch: '1', name: `Lote ${i}` })).status).toBe(200);
      // Passa da janela normal da organização (5 s): só o lote (30 s) explica o silêncio.
      await sleep(5500);
      expect(ws.events.filter((e) => e.type === 'stickers.changed')).toHaveLength(0);
      expect((await api('POST', 'stickers.import.done', { scope: 'org' }, op1)).status).toBe(403);
      expect((await api('POST', 'stickers.import.done', { scope: 'org' }, A)).status).toBe(200);
      await ws.waitFor((e) => e.type === 'stickers.changed');
      await sleep(300);
      const got = ws.events.filter((e) => e.type === 'stickers.changed');
      expect(got).toHaveLength(1);
      expect(got[0].scope).toBe('org');
    } finally {
      ws.close();
    }
  });

  it('exportar pacote', async () => {
    const pk = await personalPack(sup, 'Exportação Ação');
    const st1 = (await create(sup, still(), { packId: pk, name: 'Bom dia!', emojis: '☀️', keywords: 'manhã' })).sticker;
    const st2 = (await create(sup, anim(), { packId: pk, name: 'Aceno' }, posterFor())).sticker;
    const url = `/api/v1/stickers.packs.export?packId=${pk}`;
    const res = await raw(url, sup);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="figurinhas-exportacao-acao.zip"; filename*=UTF-8''${encodeURIComponent('figurinhas-Exportação Ação.zip')}`,
    );
    const zipBytes = await res.arrayBuffer();
    const entries = await unzip(Buffer.from(zipBytes));
    expect(entries.map((e) => e.name)).toEqual(['pack.json', '001-bom-dia.webp', '002-aceno.webp', '002-aceno.poster.png']);
    for (const e of entries) expect(crc32(e.data) >>> 0).toBe(e.crc >>> 0);
    const manifest = JSON.parse(entries[0].data.toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'wescc-stickers',
      version: 1,
      name: 'Exportação Ação',
      description: '',
      stickers: [
        { file: '001-bom-dia.webp', poster: null, name: 'Bom dia!', emojis: ['☀️'], keywords: ['manhã'], animated: false },
        { file: '002-aceno.webp', poster: '002-aceno.poster.png', name: 'Aceno', emojis: [], keywords: [], animated: true },
      ],
    });
    expect(Number.isNaN(Date.parse(manifest.exportedAt))).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(sup.userId);
    const r1 = await fileRow(st1.fileId);
    const r2 = await fileRow(st2.fileId);
    expect(entries[1].data.equals(fs.readFileSync(storedPath(r1.path)))).toBe(true);
    expect(entries[2].data.equals(fs.readFileSync(storedPath(r2.path)))).toBe(true);
    expect(entries[3].data.equals(fs.readFileSync(storedPath(r2.poster_path)))).toBe(true);

    // O leitor que a web usa na importação entende o que o servidor exporta (D15).
    const pack = await readStickerPack(readZip(new Uint8Array(zipBytes), inflateRawStream), { fileName: 'figurinhas.zip' });
    expect(pack).toMatchObject({ kind: 'wescc', name: 'Exportação Ação', description: '', ignored: [] });
    expect(pack.items.map((i) => [i.entry.name, i.name, i.emojis, i.keywords, i.poster?.name ?? null])).toEqual([
      ['001-bom-dia.webp', 'Bom dia!', ['☀️'], ['manhã'], null],
      ['002-aceno.webp', 'Aceno', [], [], '002-aceno.poster.png'],
    ]);
    expect(Buffer.from(await pack.items[1].entry.read()).equals(entries[2].data)).toBe(true);

    const filesBefore = await count('SELECT count(*) AS n FROM sticker_files');
    const pk2 = await personalPack(sup, 'Reimportação');
    expect((await create(sup, entries[1].data, { packId: pk2 })).sticker.fileId).toBe(st1.fileId);
    expect((await create(sup, entries[2].data, { packId: pk2 }, entries[3].data)).sticker.fileId).toBe(st2.fileId);
    expect(await count('SELECT count(*) AS n FROM sticker_files')).toBe(filesBefore);

    expect((await raw(url, op1)).status).toBe(404);
    expect((await raw(`/api/v1/stickers.packs.export?packId=${org1}`, sup)).status).toBe(404);
    expect((await raw(`/api/v1/stickers.packs.export?packId=${org1}`, A)).status).toBe(200);
    const pending = await newUser(A, { requirePasswordChange: true });
    const blocked = await raw(url, pending);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).errorType).toBe('error-password-change-required');
  });

  it('retenção recalcula a última mensagem com a mesma prévia', async () => {
    const room = (await api('POST', 'channels.create', { name: `retencao-${Date.now()}` }, A)).channel._id;
    const live = (name: string, emojis: string[]): MessageSticker => ({
      fileId: 'semarquivo1234',
      name,
      emojis,
      width: 512,
      height: 512,
      animated: false,
      url: '/sticker/semarquivo1234.webp',
      scope: 'org',
    });
    const stickers: MessageSticker[] = [
      live('Bom dia', ['☀️']),
      live('Sem emoji', []),
      live('', ['😂']),
      live('Figurinha', ['😂']),
      { fileId: 'semarquivo1234', removed: true, width: 512, height: 512 },
    ];
    const insert = (msg: string, extra: unknown, at: Date, files: unknown[] = []) =>
      pool.query(`INSERT INTO messages (id, room_id, user_id, username, msg, extra, files, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        newId(),
        room,
        A.userId,
        A.username,
        msg,
        JSON.stringify(extra),
        JSON.stringify(files),
        at,
      ]);
    const prune = async (kept: Date) => {
      await insert('apagar', {}, new Date());
      await pruneMessages(room, { latest: new Date(Date.now() + 60_000).toISOString(), oldest: new Date(kept.getTime() + 1000).toISOString() });
    };
    for (const s of stickers) {
      await pool.query('DELETE FROM messages WHERE room_id = $1', [room]);
      const kept = new Date(Date.now() - 60_000);
      await insert('', { sticker: s }, kept);
      await prune(kept);
      expect((await lastMessage(room)).msg).toBe(stickerPreviewText(s));
    }
    await pool.query('DELETE FROM messages WHERE room_id = $1', [room]);
    const kept = new Date(Date.now() - 60_000);
    await insert('', {}, kept, [{ _id: 'arquivo123456', name: 'relatorio.pdf', type: 'application/pdf' }]);
    await prune(kept);
    expect((await lastMessage(room)).msg).toBe('');
  });

  it('console de moderação mostra a figurinha', async () => {
    const st = await sendSt(op1, geral, { stickerId: bomDia._id });
    const text = await sendText(op1, geral, 'texto denunciado');
    await api('POST', 'chat.reportMessage', { messageId: st.message._id, description: 'teste' }, sup);
    await api('POST', 'chat.reportMessage', { messageId: text.message._id, description: 'teste' }, sup);
    const r = await api('GET', 'moderation.userReports', { userId: op1.userId }, A);
    const row = r.reports.find((x: any) => x.messageId === st.message._id);
    expect(row.sticker).toMatchObject({ fileId: bomDia.fileId, name: 'Bom dia', scope: 'org' });
    expect(r.reports.find((x: any) => x.messageId === text.message._id).sticker).toBeNull();
  });

  it('capa apagada não quebra o pacote', async () => {
    const pk = await orgPack('Capa');
    const c1 = await orgSticker(pk._id, { name: 'Primeira' });
    const c2 = await orgSticker(pk._id, { name: 'Capa' });
    const up = await api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: c2._id }, A);
    expect(up.pack.coverUrl).toBe(c2.url);
    expect((await api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: bomDia._id }, A)).status).toBe(400);
    expect((await api('POST', 'stickers.delete', { stickerId: c2._id }, A)).status).toBe(200);
    expect((await pool.query('SELECT cover_sticker_id FROM sticker_packs WHERE id = $1', [pk._id])).rows[0].cover_sticker_id).toBeNull();
    const info = await api('GET', 'stickers.packs.info', { packId: pk._id }, op1);
    expect(info.status).toBe(200);
    expect(info.pack).toMatchObject({ count: 1, coverUrl: c1.url });
    expect((await api('POST', 'stickers.delete', { stickerId: c1._id }, sup)).status).toBe(403);
  });

  it('figurinhas desativadas', async () => {
    await withSettings({ Stickers_Enabled: false }, async () => {
      expect(await sendSt(op1, geral, { stickerId: bomDia._id })).toMatchObject({ status: 400, errorType: 'error-stickers-disabled', error: 'As figurinhas estão desativadas.' });
      expect((await api('POST', 'stickers.favorite', { stickerId: bomDia._id, favorite: true }, sup)).status).toBe(400);
      expect((await orgList(op1)).status).toBe(400);
      expect((await mine(sup)).status).toBe(400);
      const adm = await api('GET', 'stickers.list', { scope: 'org', includeDrafts: 'true' }, A);
      expect(adm.status).toBe(200);
      expect(adm.packs.length).toBeGreaterThan(0);
      expect((await raw(bomDia.url, op1)).status).toBe(200);
    });
    expect((await orgList(op1)).status).toBe(200);
  });

  // ---------- Correções da revisão ----------

  const monthDir = () => {
    const now = new Date();
    return path.dirname(storedPath(`${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/aaaaaaaaaa`));
  };
  const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const stickerMsgsOf = (userId: string, rid: string) =>
    count(`SELECT count(*) AS n FROM messages WHERE user_id = $1 AND room_id = $2 AND extra ? 'sticker'`, [userId, rid]);
  // Falha só a primeira consulta que casar com `match`, como uma queda de conexão naquele instante.
  const failOnce = (match: (sql: string) => boolean) => {
    const real = pool.query.bind(pool) as (...a: any[]) => any;
    let armed = true;
    return vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
      if (armed && typeof args[0] === 'string' && match(args[0])) {
        armed = false;
        return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
      }
      return real(...args);
    }) as any);
  };
  // Segura a transação logo depois da primeira consulta que casar com `match`, até release().
  const pauseAfter = (match: (sql: string) => boolean) => {
    const realConnect = pool.connect.bind(pool) as (...a: any[]) => any;
    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const spy = vi.spyOn(pool, 'connect').mockImplementation(((...args: any[]) => {
      if (args.length) return realConnect(...args);
      return realConnect().then((c: any) => {
        const q = c.query;
        c.query = async (...qa: any[]) => {
          const out = await q.apply(c, qa);
          if (armed && typeof qa[0] === 'string' && match(qa[0])) {
            armed = false;
            reached();
            await gate;
          }
          return out;
        };
        const rel = c.release;
        c.release = (...ra: any[]) => {
          c.query = q;
          c.release = rel;
          return rel.apply(c, ra);
        };
        return c;
      });
    }) as any);
    return { at, release: () => release(), restore: () => spy.mockRestore() };
  };

  it('envios simultâneos com o mesmo _id viram uma mensagem só', async () => {
    const u = await newUser(A);
    for (let round = 0; round < 5; round++) {
      const id = `par${round}${Date.now().toString(36)}xyz`;
      const before = await stickerMsgsOf(u.userId, geral);
      const res = await Promise.all([0, 1, 2].map(() => sendSt(u, geral, { stickerId: bomDia._id, _id: id })));
      expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(res.map((r) => r.message._id)).toEqual([id, id, id]);
      expect(await stickerMsgsOf(u.userId, geral)).toBe(before + 1);
    }

    // Outra instância grava o mesmo _id entre a checagem e o INSERT: a chave primária recusa e a resposta é a mensagem dela.
    const real = pool.query.bind(pool) as (...a: any[]) => any;
    const dupId = `dup${Date.now().toString(36)}xyz`;
    const pk = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO messages') && args[1]?.[0] === dupId) {
        await real(...args);
        throw Object.assign(new Error('duplicate key value violates unique constraint "messages_pkey"'), { code: '23505' });
      }
      return real(...args);
    }) as any);
    let before = await stickerMsgsOf(u.userId, geral);
    try {
      const r = await sendSt(u, geral, { stickerId: bomDia._id, _id: dupId });
      expect(r.status).toBe(200);
      expect(r.message._id).toBe(dupId);
    } finally {
      pk.mockRestore();
    }
    expect(await stickerMsgsOf(u.userId, geral)).toBe(before + 1);

    // Outra instância grava o mesmo _id logo antes de sendMessage conferir o id: a cópia com id novo sai.
    const lateId = `late${Date.now().toString(36)}xyz`;
    let reads = 0;
    const late = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      if (args[0] === 'SELECT * FROM messages WHERE id = $1' && args[1]?.[0] === lateId && ++reads === 2) {
        const extra = { sticker: { fileId: bomDia.fileId, name: 'Bom dia', emojis: ['☀️'], width: 512, height: 512, animated: false, url: bomDia.url, scope: 'org' } };
        await real(`INSERT INTO messages (id, room_id, user_id, username, msg, extra, sticker_file_id) VALUES ($1, $2, $3, $4, '', $5, $6)`, [
          lateId,
          geral,
          u.userId,
          u.username,
          JSON.stringify(extra),
          bomDia.fileId,
        ]);
      }
      return real(...args);
    }) as any);
    before = await stickerMsgsOf(u.userId, geral);
    try {
      const r = await sendSt(u, geral, { stickerId: bomDia._id, _id: lateId });
      expect(r.status).toBe(200);
      expect(r.message._id).toBe(lateId);
    } finally {
      late.mockRestore();
    }
    expect(await stickerMsgsOf(u.userId, geral)).toBe(before + 1);

    // O _id é de uma mensagem de outra pessoa gravada logo antes do INSERT: o envio sai com um id novo, sem erro.
    const otherId = `alheia${Date.now().toString(36)}xyz`;
    let fired = false;
    const other = vi.spyOn(pool, 'query').mockImplementation((async (...args: any[]) => {
      if (!fired && typeof args[0] === 'string' && args[0].startsWith('INSERT INTO messages') && args[1]?.[0] === otherId) {
        fired = true;
        await real(`INSERT INTO messages (id, room_id, user_id, username, msg) VALUES ($1, $2, $3, $4, 'texto')`, [otherId, geral, sup.userId, sup.username]);
      }
      return real(...args);
    }) as any);
    before = await stickerMsgsOf(u.userId, geral);
    try {
      const r = await sendSt(u, geral, { stickerId: bomDia._id, _id: otherId });
      expect(r.status).toBe(200);
      expect(r.message._id).not.toBe(otherId);
      expect(r.message.sticker.fileId).toBe(bomDia.fileId);
    } finally {
      other.mockRestore();
    }
    expect(fired).toBe(true);
    expect(await stickerMsgsOf(u.userId, geral)).toBe(before + 1);
    expect((await messageRow(otherId)).user_id).toBe(sup.userId);
  });

  it('nome com apóstrofo e parênteses chega inteiro no filename* da exportação', async () => {
    const name = "Pão d'água (top)*!";
    const pk = await personalPack(sup, name);
    expect((await create(sup, still(), { packId: pk })).status).toBe(200);
    const res = await raw(`/api/v1/stickers.packs.export?packId=${pk}`, sup);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    const ext = /filename\*=UTF-8''(.+)$/.exec(cd)![1];
    // attr-char da RFC 8187: sem ' ( ) * e sem !.
    expect(ext).toMatch(/^[A-Za-z0-9%#$&+\-.^_`|~]+$/);
    expect(ext).toBe('figurinhas-P%C3%A3o%20d%27%C3%A1gua%20%28top%29%2A%21.zip');
    expect(decodeURIComponent(ext)).toBe(`figurinhas-${name}.zip`);
    await res.arrayBuffer();
    await api('POST', 'stickers.packs.delete', { packId: pk }, sup);
  });

  it('gestor não remove figurinha pessoal salvando-a num rascunho da organização', async () => {
    const p = (await create(sup, still(), { name: 'Pessoal da sup' })).sticker;
    const inGeral = await sendSt(sup, geral, { stickerId: p._id });
    expect((await sendSt(sup, dmSupOp1, { stickerId: p._id })).status).toBe(200);
    const notAllowed = { status: 403, errorType: 'error-sticker-remove-not-allowed' };
    expect(await api('POST', 'stickers.removeEverywhere', { fileId: p.fileId }, com)).toMatchObject(notAllowed);
    expect((await api('GET', 'stickers.usage', { fileId: p.fileId }, com)).status).toBe(404);

    const draft = (await api('POST', 'stickers.packs.create', { scope: 'org', name: 'Rascunho do gestor' }, com)).pack;
    expect(draft.status).toBe('draft');
    expect((await api('POST', 'stickers.save', { messageId: inGeral.message._id, packId: draft._id }, com)).status).toBe(200);
    expect(await api('POST', 'stickers.removeEverywhere', { fileId: p.fileId }, com)).toMatchObject(notAllowed);
    expect(await api('POST', 'stickers.removeEverywhere', { messageId: inGeral.message._id }, com)).toMatchObject(notAllowed);
    expect((await api('GET', 'stickers.usage', { fileId: p.fileId }, com)).status).toBe(404);
    expect((await fileRow(p.fileId)).blocked_at).toBeNull();
    expect((await messageRow(inGeral.message._id)).extra.sticker.removed).toBeUndefined();
    expect((await api('GET', 'stickers.usage', { fileId: p.fileId }, mod)).usage.rooms).toBe(2);

    // Conteúdo que nasceu na organização continua removível pelo gestor, mesmo salvo depois por alguém.
    const o = await orgSticker(draft._id, { name: 'Oficial' });
    // O gestor vê o rascunho e salva por fileId (por stickerId, só pacotes publicados).
    expect((await api('POST', 'stickers.save', { fileId: o.fileId }, A)).status).toBe(200);
    await pool.query(`UPDATE stickers SET pack_id = $1 WHERE file_id = $2 AND pack_id <> $3`, [supPack, o.fileId, draft._id]);
    expect(await api('POST', 'stickers.removeEverywhere', { fileId: o.fileId }, com)).toMatchObject({ status: 200, packs: 2 });
    await api('POST', 'stickers.packs.delete', { packId: draft._id }, com);
  });

  it('cópia vencida da quarentena não é mais servida', async () => {
    const pk = await orgPack('Quarentena vencida');
    const s = await orgSticker(pk._id);
    expect((await api('POST', 'stickers.removeEverywhere', { fileId: s.fileId }, mod)).status).toBe(200);
    expect((await raw(`${s.url}?q=1`, mod)).status).toBe(200);
    await pool.query(`UPDATE sticker_files SET quarantine_until = now() - interval '1 day' WHERE id = $1`, [s.fileId]);
    const entry = (await api('GET', 'stickers.blocked.list', {}, mod)).files.find((f: any) => f.fileId === s.fileId);
    expect(entry.quarantined).toBe(false);
    const late = await raw(`${s.url}?q=1`, mod);
    expect(late.status).toBe(410);
    expect(late.headers.get('cache-control')).toBe('no-store');
  });

  it('falha depois do commit não apaga a figurinha criada', async () => {
    const pk = await orgPack('Depois do commit');
    // A consulta da lixeira depois do commit cai.
    const spy = failOnce((sql) => /^SELECT .* FROM sticker_trash/s.test(sql));
    let r: any;
    try {
      r = await create(A, still(), { packId: pk._id });
    } finally {
      spy.mockRestore();
    }
    expect(r.status).toBe(200);
    const row = await fileRow(r.sticker.fileId);
    expect(fs.existsSync(storedPath(row.path))).toBe(true);
    expect((await raw(r.sticker.url, op1)).status).toBe(200);

    // O COMMIT passa no banco, mas a resposta dele se perde: o arquivo que a linha aponta fica no disco.
    const realConnect = pool.connect.bind(pool) as (...a: any[]) => any;
    const conn = vi.spyOn(pool, 'connect').mockImplementation(((...args: any[]) => {
      if (args.length) return realConnect(...args);
      return realConnect().then((c: any) => {
        const q = c.query;
        let sawInsert = false;
        c.query = async (...qa: any[]) => {
          if (typeof qa[0] === 'string' && qa[0].includes('INSERT INTO stickers (')) sawInsert = true;
          const out = await q.apply(c, qa);
          if (qa[0] === 'COMMIT' && sawInsert) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
          return out;
        };
        const release = c.release;
        c.release = (...ra: any[]) => {
          c.query = q;
          c.release = release;
          return release.apply(c, ra);
        };
        return c;
      });
    }) as any);
    let lost: any;
    try {
      lost = await create(A, still(), { packId: pk._id, name: 'Perdida' });
    } finally {
      conn.mockRestore();
    }
    expect(lost.status).toBe(500);
    const saved = (await pool.query(`SELECT f.* FROM stickers s JOIN sticker_files f ON f.id = s.file_id WHERE s.pack_id = $1 AND s.name = 'Perdida'`, [pk._id])).rows[0];
    expect(saved).toBeDefined();
    expect(fs.existsSync(storedPath(saved.path))).toBe(true);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1', [saved.path])).toBe(0);
  });

  it('lixeira nunca apaga um caminho que uma linha ainda usa', async () => {
    const pk = await orgPack('Caminho em uso');
    const s = await orgSticker(pk._id);
    const row = await fileRow(s.fileId);
    await queueTrash(pool, row.path);
    expect(await drainStickerTrash({ only: [row.path] })).toMatchObject({ failed: 0 });
    expect(fs.existsSync(storedPath(row.path))).toBe(true);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1', [row.path])).toBe(0);
  });

  it('chaves estrangeiras das figurinhas têm índice', async () => {
    const r = await pool.query(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]) AS indexed
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid::regclass::text IN ('messages', 'stickers', 'sticker_files', 'sticker_packs')
        AND (c.conrelid::regclass::text LIKE 'sticker%' OR (c.conrelid::regclass::text = 'messages' AND a.attname = 'sticker_file_id'))`);
    const missing = r.rows.filter((x) => !x.indexed).map((x) => `${x.tbl}.${x.col}`);
    expect(missing).toEqual([]);
    expect(r.rows.map((x) => `${x.tbl}.${x.col}`)).toEqual(expect.arrayContaining(['stickers.source_message_id', 'sticker_user_items.sticker_id', 'sticker_packs.cover_sticker_id']));
  });

  it('falha depois do commit da remoção não perde a auditoria nem o aviso', async () => {
    const pk = await orgPack('Remoção com queda');
    const s = await orgSticker(pk._id);
    const ws = connectWs(op1);
    await ws.ready;
    const spy = failOnce((sql) => /^SELECT .* FROM sticker_trash/s.test(sql));
    let r: any;
    try {
      r = await api('POST', 'stickers.removeEverywhere', { fileId: s.fileId }, mod);
      expect(r.status).toBe(200);
      await ws.waitFor((e) => e.type === 'sticker.removed' && e.fileId === s.fileId);
    } finally {
      spy.mockRestore();
      ws.close();
    }
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'sticker.removed_everywhere' AND target->>'fileId' = $1`, [s.fileId])).toBe(1);
    // A lixeira ficou para depois e termina na próxima drenagem.
    await drainStickerTrash();
    expect(fs.existsSync(storedPath(`quarantine/${s.fileId}`))).toBe(true);
  });

  it('arquivo sumido do disco responde 404 sem cache e volta com um novo envio', async () => {
    const pk = await orgPack('Sumida');
    const bytes = still();
    const s = await orgSticker(pk._id, {}, bytes);
    const row = await fileRow(s.fileId);
    fs.rmSync(storedPath(row.path));
    const res = await raw(s.url, op1);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('etag')).toBeNull();
    const etag = `"${row.sha256.slice(0, 32)}"`;
    const cond = await fetch(urlOf(s.url), { headers: { cookie: `rc_uid=${op1.userId}; rc_token=${op1.authToken}`, 'if-none-match': etag } });
    expect(cond.status).toBe(404);
    // Reenviar o mesmo conteúdo devolve o arquivo ao disco.
    const pk2 = await orgPack('Sumida 2');
    const again = await orgSticker(pk2._id, {}, bytes);
    expect(again.fileId).toBe(s.fileId);
    expect(fs.existsSync(storedPath(row.path))).toBe(true);
    const ok = await raw(s.url, op1);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(canonicalize(bytes, 'webp')))).toBe(true);
  });

  it('remover um arquivo que já sumiu do disco não promete cópia na quarentena', async () => {
    const pk = await orgPack('Sumiu antes');
    const s = await orgSticker(pk._id);
    fs.rmSync(storedPath((await fileRow(s.fileId)).path));
    expect((await api('POST', 'stickers.removeEverywhere', { fileId: s.fileId }, mod)).status).toBe(200);
    const entry = (await api('GET', 'stickers.blocked.list', {}, mod)).files.find((f: any) => f.fileId === s.fileId);
    expect(entry.quarantined).toBe(false);
    expect((await raw(`${s.url}?q=1`, mod)).status).toBe(410);
    expect((await fileRow(s.fileId)).quarantine_path).toBeNull();
  });

  it('gravação cortada no meio não deixa o .tmp para trás', async () => {
    const rel = await storeBuffer(still());
    const tmp = `${storedPath(rel)}.tmp`;
    fs.renameSync(storedPath(rel), tmp);
    await pool.query(`INSERT INTO sticker_trash (path, since) VALUES ($1, now() - interval '2 hours')`, [rel]);
    await gcStickerFiles();
    expect(fs.existsSync(tmp)).toBe(false);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1', [rel])).toBe(0);
  });

  it('exportação pula o arquivo que falta em vez de cortar o ZIP', async () => {
    const dono = await newUser(A);
    const pk = await personalPack(dono, 'Exportação falha');
    const a = (await create(dono, still(), { packId: pk, name: 'Some' })).sticker;
    const b = (await create(dono, still(), { packId: pk, name: 'Fica' })).sticker;
    const c = (await create(dono, still(), { packId: pk, name: 'Some no meio' })).sticker;
    fs.rmSync(storedPath((await fileRow(a.fileId)).path));
    const cPath = storedPath((await fileRow(c.fileId)).path);
    // A terceira some no meio da transmissão (uma remoção em paralelo, por exemplo).
    const realRead = fs.promises.readFile.bind(fs.promises) as (...a: any[]) => any;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((...args: any[]) => {
      if (args[0] === cPath) return Promise.reject(Object.assign(new Error('não existe'), { code: 'ENOENT' }));
      return realRead(...args);
    }) as any);
    let entries: { name: string; data: Buffer }[];
    try {
      const res = await raw(`/api/v1/stickers.packs.export?packId=${pk}`, dono);
      expect(res.status).toBe(200);
      entries = await unzip(Buffer.from(await res.arrayBuffer()));
    } finally {
      spy.mockRestore();
    }
    expect(entries.map((e) => e.name)).toEqual(['pack.json', '001-fica.webp']);
    const manifest = JSON.parse(entries[0].data.toString('utf8'));
    expect(manifest.stickers.map((s: any) => s.name)).toEqual(['Fica', 'Some no meio']);
    expect(entries[1].data.equals(fs.readFileSync(storedPath((await fileRow(b.fileId)).path)))).toBe(true);
  });

  it('permitir de novo só mexe nos arquivos daquela figurinha', async () => {
    const pk = await orgPack('Permitir rápido');
    const s = await orgSticker(pk._id);
    expect((await api('POST', 'stickers.removeEverywhere', { fileId: s.fileId }, mod)).status).toBe(200);
    // Sobra de uma remoção interrompida: o original ainda no disco, a caminho da quarentena.
    const leftover = await storeBuffer(still(), s.fileId);
    await queueTrash(pool, leftover, `quarantine/${s.fileId}`);
    const others = [await storeBuffer(still()), await storeBuffer(still())];
    for (const o of others) await queueTrash(pool, o);
    expect((await api('POST', 'stickers.blocked.unblock', { fileId: s.fileId }, mod)).status).toBe(200);
    expect(fs.existsSync(storedPath(`quarantine/${s.fileId}`))).toBe(false);
    expect(fs.existsSync(storedPath(leftover))).toBe(false);
    for (const o of others) expect(fs.existsSync(storedPath(o))).toBe(true);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = ANY($1) AND attempts = 0', [others])).toBe(2);
    expect((await drainStickerTrash({ only: others })).done).toBe(2);
  });

  it('limpeza diária esvazia a lixeira inteira e só conta como presa o que falhou', async () => {
    await drainStickerTrash();
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE since <= now()')).toBe(0);
    await pool.query(
      `INSERT INTO sticker_trash (path, since) SELECT '2020/01/lixo' || lpad(i::text, 6, '0'), now() - interval '4 days' - i * interval '1 second' FROM generate_series(1, 650) i`,
    );
    const failing = await storeBuffer(still());
    await pool.query(`INSERT INTO sticker_trash (path, since) VALUES ($1, now() - interval '5 days')`, [failing]);
    const realRm = fs.promises.rm.bind(fs.promises) as (...a: any[]) => any;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(((...args: any[]) => {
      if (args[0] === storedPath(failing)) return Promise.reject(Object.assign(new Error('arquivo em uso'), { code: 'ENOTEMPTY' }));
      return realRm(...args);
    }) as any);
    let gc: any;
    try {
      gc = await gcStickerFiles();
    } finally {
      spy.mockRestore();
    }
    expect(await count(`SELECT count(*) AS n FROM sticker_trash WHERE path LIKE '2020/01/lixo%'`)).toBe(0);
    expect(gc.stuck).toBe(1);
    expect((await drainStickerTrash({ only: [failing] })).done).toBe(1);
  });

  it('envio multipart malformado vira erro em português', async () => {
    const send = (body: string | Buffer, type: string) =>
      fetch(urlOf('/api/v1/stickers.create'), {
        method: 'POST',
        headers: { 'content-type': type, 'x-user-id': A.userId, 'x-auth-token': A.authToken },
        body: typeof body === 'string' ? body : new Uint8Array(body),
      });
    const expectPt = async (res: Response) => {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ errorType: 'error-invalid-params', error: 'Não foi possível ler o envio da figurinha. Tente de novo.' });
    };
    const B = 'limiteXYZ';
    const head = `--${B}\r\nContent-Disposition: form-data; name="name"\r\n\r\nCortada\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="f.webp"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    await expectPt(await send(Buffer.concat([Buffer.from(head), Buffer.from(still()).subarray(0, 50)]), `multipart/form-data; boundary=${B}`));
    const proto = `--${B}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nx\r\n--${B}--\r\n`;
    await expectPt(await send(proto, `multipart/form-data; boundary=${B}`));
    await expectPt(await send(proto, 'multipart/form-data'));
  });

  it('gravação que falha não deixa .tmp nem arquivo fora do alcance da limpeza', async () => {
    const pk = await orgPack('Gravação');
    const dir = monthDir();
    let before = listDir(dir);
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('arquivo em uso'), { code: 'EPERM' }));
    try {
      expect((await create(A, still(), { packId: pk._id })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(listDir(dir).filter((f) => !before.includes(f))).toEqual([]);

    // O processo "cai" entre gravar e o commit: a transação falha e a lixeira daquele momento também.
    before = listDir(dir);
    const realConnect = pool.connect.bind(pool) as (...a: any[]) => any;
    const conn = vi.spyOn(pool, 'connect').mockImplementation(((...args: any[]) => {
      if (args.length) return realConnect(...args);
      return realConnect().then((c: any) => {
        const q = c.query;
        c.query = (...qa: any[]) =>
          typeof qa[0] === 'string' && qa[0].includes('INSERT INTO stickers (') ? Promise.reject(new Error('queda no meio da transação')) : q.apply(c, qa);
        const release = c.release;
        c.release = (...ra: any[]) => {
          c.query = q;
          c.release = release;
          return release.apply(c, ra);
        };
        return c;
      });
    }) as any);
    const trash = failOnce((sql) => /^SELECT .* FROM sticker_trash/s.test(sql));
    try {
      expect((await create(A, still(), { packId: pk._id })).status).toBe(500);
    } finally {
      conn.mockRestore();
      trash.mockRestore();
    }
    const left = listDir(dir).filter((f) => !before.includes(f));
    expect(left).toHaveLength(1);
    const rel = path.relative(path.resolve(dir, '../..'), path.join(dir, left[0])).split(path.sep).join('/');
    // Ninguém mais lembra do arquivo, só a lixeira: com o prazo vencido, a limpeza diária o apaga.
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1 AND since > now()', [rel])).toBe(1);
    await gcStickerFiles();
    expect(fs.existsSync(path.join(dir, left[0]))).toBe(true);
    await pool.query(`UPDATE sticker_trash SET since = now() - interval '2 hours' WHERE path = $1`, [rel]);
    await gcStickerFiles();
    expect(fs.existsSync(path.join(dir, left[0]))).toBe(false);
  });

  it('remover a capa de um pacote em paralelo com reordenar não trava', async () => {
    const pk = await orgPack('Capa em corrida');
    const c1 = await orgSticker(pk._id, { name: 'Capa' });
    const c2 = await orgSticker(pk._id, { name: 'Outra' });
    await api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: c1._id }, A);
    const client = await pool.connect();
    try {
      // Os passos de reorderStickers, com a transação aberta no meio.
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM sticker_packs WHERE id = $1 FOR UPDATE', [pk._id]);
      const removal = removeEverywhere(ctxOf(mod), { fileId: c1.fileId });
      await waitForLock('');
      await client.query('UPDATE stickers s SET sort = x.i - 1 FROM unnest($1::text[]) WITH ORDINALITY x(id, i) WHERE s.id = x.id', [[c2._id, c1._id]]);
      await client.query('COMMIT');
      expect((await removal).packs).toBe(1);
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT cover_sticker_id FROM sticker_packs WHERE id = $1', [pk._id])).rows[0].cover_sticker_id).toBeNull();
  });

  it('limite de pacotes da organização vale com criações simultâneas', async () => {
    const created: string[] = [];
    try {
      const n = await count(`SELECT count(*) AS n FROM sticker_packs WHERE scope = 'org'`);
      for (let i = n; i < STICKER_LIMITS.orgPacksMax - 2; i++) created.push((await orgPack(`Enche ${i}`))._id);
      const res = await Promise.all([0, 1, 2, 3, 4].map((i) => api('POST', 'stickers.packs.create', { scope: 'org', name: `Paralelo ${i}` }, A)));
      for (const r of res) if (r.pack) created.push(r.pack._id);
      expect(res.map((r) => r.status).sort()).toEqual([200, 200, 400, 400, 400]);
      expect(res.filter((r) => r.status === 400).every((r) => r.errorType === 'error-sticker-packs-full')).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM sticker_packs WHERE scope = 'org'`)).toBe(STICKER_LIMITS.orgPacksMax);
    } finally {
      for (const id of created) await api('POST', 'stickers.packs.delete', { packId: id }, A);
    }
  });

  // ---------- Correções da verificação ----------

  it('.tmp preso pelo antivírus continua na lixeira até sair do disco', async () => {
    const pk = await orgPack('Tmp preso');
    const dir = monthDir();
    const before = listDir(dir);
    const eperm = () => Promise.reject(Object.assign(new Error('arquivo em uso'), { code: 'EPERM' }));
    const isTmp = (p: unknown) => String(p).endsWith('.tmp');
    const real = { rename: fs.promises.rename, rm: fs.promises.rm, unlink: fs.promises.unlink };
    // O antivírus segura só o .tmp recém-gravado: nem renomear nem apagar passam enquanto durar a trava.
    const spies = [
      vi.spyOn(fs.promises, 'rename').mockImplementation(((a: any, b: any) => (isTmp(a) ? eperm() : real.rename(a, b))) as any),
      vi.spyOn(fs.promises, 'rm').mockImplementation(((p: any, o: any) => (isTmp(p) ? eperm() : real.rm(p, o))) as any),
      vi.spyOn(fs.promises, 'unlink').mockImplementation(((p: any) => (isTmp(p) ? eperm() : real.unlink(p))) as any),
    ];
    try {
      expect((await create(A, still(), { packId: pk._id })).status).toBe(500);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const left = listDir(dir).filter((f) => !before.includes(f));
    expect(left).toHaveLength(1);
    expect(left[0].endsWith('.tmp')).toBe(true);
    const rel = `${path.basename(path.dirname(dir))}/${path.basename(dir)}/${left[0].slice(0, -4)}`;
    const row = (await pool.query('SELECT attempts, last_error, since > now() AS pending FROM sticker_trash WHERE path = $1', [rel])).rows[0];
    expect(row).toMatchObject({ attempts: 1, pending: true });
    expect(row.last_error).toMatch(/^EPERM/);
    // A trava saiu; vencido o prazo da gravação pendente, a limpeza diária apaga o .tmp e só então solta a linha.
    await pool.query(`UPDATE sticker_trash SET since = now() - interval '2 hours' WHERE path = $1`, [rel]);
    await gcStickerFiles();
    expect(fs.existsSync(path.join(dir, left[0]))).toBe(false);
    expect(await count('SELECT count(*) AS n FROM sticker_trash WHERE path = $1', [rel])).toBe(0);
  });

  it('apagar a capa enquanto a remoção de todas as conversas corre não trava', async () => {
    const pk = await orgPack('Capa apagada em corrida');
    const c1 = await orgSticker(pk._id, { name: 'Capa' });
    const c2 = await orgSticker(pk._id, { name: 'Fica' });
    await api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: c1._id }, A);
    // A remoção para logo depois de tirar a capa, com o pacote travado, e o apagar chega nesse instante.
    const p = pauseAfter((sql) => sql.startsWith('UPDATE sticker_packs SET cover_sticker_id = NULL WHERE cover_sticker_id IN'));
    let removal: Promise<any> = Promise.resolve();
    let del: Promise<any> = Promise.resolve();
    try {
      removal = api('POST', 'stickers.removeEverywhere', { fileId: c1.fileId }, mod);
      await p.at;
      del = api('POST', 'stickers.delete', { stickerId: c1._id }, A);
      await waitForLock('');
    } finally {
      p.release();
      p.restore();
    }
    const [r, d] = await Promise.all([removal, del]);
    expect(r.status).toBe(200);
    expect(r.packs).toBe(1);
    expect([d.status, d.errorType]).toEqual([404, 'error-sticker-not-found']);
    expect((await fileRow(c1.fileId)).blocked_at).not.toBeNull();
    const info = await api('GET', 'stickers.packs.info', { packId: pk._id }, A);
    expect(info.pack).toMatchObject({ count: 1, coverUrl: c2.url });

    // Sem pausa: apagar e remover juntos, a capa e outra figurinha do mesmo arquivo, nunca dão erro interno.
    for (let round = 0; round < 8; round++) {
      const a = await orgPack(`Corrida ${round}`);
      const b = await orgPack(`Corrida ${round} b`);
      const bytes = still();
      const sa = await orgSticker(a._id, {}, bytes);
      const sb = await orgSticker(b._id, {}, bytes);
      await api('POST', 'stickers.packs.update', { packId: a._id, coverStickerId: sa._id }, A);
      const res = await Promise.all([
        api('POST', 'stickers.removeEverywhere', { fileId: sa.fileId }, mod),
        sleep(round % 4).then(() => api('POST', 'stickers.delete', { stickerId: round % 2 ? sa._id : sb._id }, A)),
      ]);
      expect(res[0].status).toBe(200);
      expect([200, 404]).toContain(res[1].status);
      for (const id of [a._id, b._id]) await api('POST', 'stickers.packs.delete', { packId: id }, A);
    }
  });

  it('trocar a capa enquanto a remoção apaga aquela figurinha dá o erro da capa, não erro interno', async () => {
    const pk = await orgPack('Capa nova em corrida');
    const c1 = await orgSticker(pk._id, { name: 'Antiga' });
    const c2 = await orgSticker(pk._id, { name: 'Nova' });
    await api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: c1._id }, A);
    // A remoção de c2 para com a figurinha já apagada (e travada); a troca de capa passou pela conferência antes.
    const p = pauseAfter((sql) => sql.startsWith('WITH gone AS (DELETE FROM stickers'));
    let removal: Promise<any> = Promise.resolve();
    let upd: Promise<any> = Promise.resolve();
    try {
      removal = api('POST', 'stickers.removeEverywhere', { fileId: c2.fileId }, mod);
      await p.at;
      upd = api('POST', 'stickers.packs.update', { packId: pk._id, coverStickerId: c2._id }, A);
      await waitForLock('');
    } finally {
      p.release();
      p.restore();
    }
    const [r, u] = await Promise.all([removal, upd]);
    expect(r.status).toBe(200);
    expect([u.status, u.errorType]).toEqual([400, 'error-invalid-params']);
    expect(u.error).toBe('A capa precisa ser uma figurinha deste pacote.');
    expect((await pool.query('SELECT cover_sticker_id FROM sticker_packs WHERE id = $1', [pk._id])).rows[0].cover_sticker_id).toBe(c1._id);
  });

  it('pôster sumido só volta pelas mãos de quem enviou primeiro ou de um gestor', async () => {
    const creator = await newUser(A);
    const stranger = await newUser(A);
    const bytes = anim();
    const mine0 = posterFor();
    const s = (await create(creator, bytes, { name: 'Dança' }, mine0)).sticker;
    const row = await fileRow(s.fileId);
    const posterOnDisk = () => storedPath(row.poster_path);
    const restored = () => count(`SELECT count(*) AS n FROM audit_log WHERE action = 'sticker.poster_restored' AND target->>'fileId' = $1`, [s.fileId]);
    const served = async (auth: Auth) => {
      const res = await raw(s.posterUrl, auth);
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    };
    fs.rmSync(posterOnDisk());

    // Outra pessoa envia a mesma animação com outro pôster: a figurinha dela vale, mas o pôster de todos não muda.
    const other = await create(stranger, bytes, {}, posterFor());
    expect(other.status).toBe(200);
    expect(other.sticker.fileId).toBe(s.fileId);
    expect(fs.existsSync(posterOnDisk())).toBe(false);
    expect((await served(creator)).status).toBe(404);
    expect(await restored()).toBe(0);

    // Quem enviou primeiro devolve o pôster dele.
    const mine1 = posterFor();
    expect((await create(creator, bytes, { packId: await personalPack(creator, 'Outro') }, mine1)).status).toBe(200);
    let got = await served(creator);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(Buffer.from(canonicalize(mine1, 'png')))).toBe(true);
    expect(await restored()).toBe(1);

    // Um gestor também (é quem cuida dos pacotes da organização), e o registro diz quem foi.
    fs.rmSync(posterOnDisk());
    const pk = await api('POST', 'stickers.packs.create', { scope: 'org', name: 'Pôster do gestor', status: 'published' }, com);
    const curated = posterFor();
    expect((await create(com, bytes, { packId: pk.pack._id }, curated)).status).toBe(200);
    got = await served(op1);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(Buffer.from(canonicalize(curated, 'png')))).toBe(true);
    const log = (await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'sticker.poster_restored' AND target->>'fileId' = $1 ORDER BY created_at`, [s.fileId])).rows;
    expect(log.map((l) => l.actor_id)).toEqual([creator.userId, com.userId]);
  });
});
