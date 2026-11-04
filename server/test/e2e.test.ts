// Criptografia de ponta a ponta (spec E §9.2): chaves das pessoas e das salas, ligar e desligar, mensagens e arquivos
// cifrados, troca de chave, redefinição e o que deixa de funcionar numa conversa criptografada. Chaves de verdade,
// geradas com o mesmo código do navegador (web/src/lib/e2e/crypto.ts).
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { totpCode } from '../src/lib/totp';
import { resetKeyRequestWindows } from '../src/services/e2e';
import { on } from '../src/services/hooks';
import { reminderPushBody } from '../src/services/reminders';
import { pruneMessages } from '../src/services/retention';
import { runDataExportJobs } from '../src/services/userData';
import { E2E_PREVIEW, type E2EEnvelope } from '@shared/e2e';
import { stickersAllowedIn } from '@shared/stickers';
import {
  encryptContent,
  encryptFile,
  encryptPrivateKey,
  fingerprint,
  generateRoomKey,
  generateUserKeys,
  importPublicKey,
  newMessageId,
  wrapRoomKey,
} from '../../web/src/lib/e2e/crypto';
import { admin, api, connectWs, enable2fa, login, newUser, raw, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';
import { unzip } from './zip-read';

// Os e-mails ficam numa caixa de saída em memória.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => (outbox.push(m), true),
}));

// Webhook de saída falso: guarda o que chega.
const received: any[] = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push(JSON.parse(body || '{}'));
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});
let hookUrl = '';

// Ganchos internos (webhooks de saída, robôs, Jira): nenhum recebe mensagem cifrada.
const hooked: { event: string; id: string }[] = [];

let A: Auth;
beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/out`;
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  on('message.sent', ({ message }) => void hooked.push({ event: 'message.sent', id: message._id }));
  on('message.updated', ({ message }) => void hooked.push({ event: 'message.updated', id: message._id }));
  on('file.uploaded', ({ message }) => void hooked.push({ event: 'file.uploaded', id: message._id }));
});
afterAll(async () => {
  hook.close();
  await stopServer();
});

// ---------- Ajudantes ----------

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const setSettings = (settings: Record<string, unknown>) => api('POST', 'settings', { settings }, A);
const info = async (auth: Auth, rid: string) => (await api('GET', 'rooms.info', { roomId: rid }, auth)).room;
const send = (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const save = (auth: Auth, rid: string, s: Record<string, unknown>) => api('POST', 'rooms.saveRoomSettings', { rid, ...s }, auth);
const audits = async (action: string) => (await pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY created_at', [action])).rows;
const keyRows = async (rid: string) => (await pool.query('SELECT * FROM e2e_room_keys WHERE room_id = $1 ORDER BY created_at', [rid])).rows;
const roomRow = async (rid: string) => (await pool.query('SELECT * FROM rooms WHERE id = $1', [rid])).rows[0];
const msgRow = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
async function permissionRoles(id: string): Promise<string[]> {
  const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
  return perms.find((p) => p._id === id)!.roles;
}
const setPermission = (id: string, roles: string[]) => api('POST', 'permissions.update', { permissions: [{ _id: id, roles }] }, A);

// Espera um evento que chegue depois deste ponto (os anteriores não contam).
type Ws = ReturnType<typeof connectWs>;
async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  return ws;
}
function next(ws: Ws, pred: (e: any) => boolean, ms = 5000) {
  const since = ws.events.length;
  return () => ws.waitFor((e) => ws.events.indexOf(e) >= since && pred(e), ms);
}
const countSince = (ws: Ws, since: number, pred: (e: any) => boolean) => ws.events.slice(since).filter(pred).length;

// Chaves de cada pessoa (geradas no "navegador").
interface UserKeys {
  publicKey: string;
  blob: string;
  pub: CryptoKey;
}
const userKeys = new Map<string, UserKeys>();
const PASS = 'senha da criptografia comprida';
async function makeKeys(): Promise<UserKeys> {
  const { publicKey, pkcs8 } = await generateUserKeys();
  return { publicKey, blob: await encryptPrivateKey(pkcs8, PASS, 100_000), pub: await importPublicKey(publicKey) };
}
async function withKeys(auth: Auth): Promise<UserKeys> {
  const k = await makeKeys();
  const r = await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: k.publicKey, private_key: k.blob }, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  userKeys.set(auth.userId, k);
  return k;
}
const person = async (extra: Record<string, unknown> = {}) => {
  const u = await newUser(A, extra);
  await withKeys(u);
  return u;
};

// Sala criptografada com a chave de quem criou.
interface ERoom {
  rid: string;
  key: CryptoKey;
  keyID: string;
}
const wrapFor = (key: CryptoKey, auth: Auth) => wrapRoomKey(key, userKeys.get(auth.userId)!.pub);
async function group(owner: Auth, members: Auth[] = [], extraData: Record<string, unknown> = {}) {
  const r = await api('POST', 'groups.create', { name: name('grupo'), members: members.map((m) => m.username), extraData }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.group._id as string;
}
async function createKey(owner: Auth, rid: string): Promise<ERoom> {
  const { key, keyID } = await generateRoomKey();
  const r = await api('POST', 'e2e.setRoomKeyID', { rid, keyID, key: await wrapFor(key, owner) }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return { rid, key, keyID };
}
async function giveKey(room: ERoom, from: Auth, to: Auth[]) {
  const keys = await Promise.all(to.map(async (u) => ({ uid: u.userId, key: await wrapFor(room.key, u) })));
  const r = await api('POST', 'e2e.updateGroupKey', { rid: room.rid, keyID: room.keyID, keys }, from);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r;
}
// Grupo privado criptografado, com a chave entregue a todos.
async function encryptedGroup(owner: Auth, members: Auth[] = [], extraData: Record<string, unknown> = {}) {
  const rid = await group(owner, members, extraData);
  const t = await save(owner, rid, { encrypted: true });
  if (!t.success) throw new Error(JSON.stringify(t));
  const room = await createKey(owner, rid);
  if (members.length) await giveKey(room, owner, members);
  return room;
}
const envelope = (auth: Auth, room: ERoom, mid: string, msg: string, extra: Record<string, unknown> = {}) =>
  encryptContent(room.key, room.keyID, room.rid, mid, auth.userId, { msg, ...extra });
async function sendE2e(auth: Auth, room: ERoom, msg: string, opts: { mid?: string; mentions?: string[]; extra?: Record<string, unknown>; e2e?: unknown } = {}) {
  const mid = opts.mid ?? newMessageId();
  const e2e = opts.e2e ?? (await envelope(auth, room, mid, msg));
  return api('POST', 'chat.sendMessage', { message: { _id: mid, rid: room.rid, e2e, e2eMentions: opts.mentions, ...opts.extra } }, auth);
}
function e2eForm(fields: Record<string, string>, bytes: BlobPart = 'cifrado', type = 'application/octet-stream', fileName = 'arquivo-criptografado') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([bytes], { type }), fileName);
  return fd;
}

// ---------- Chaves ----------

describe('criptografia: chaves das pessoas', () => {
  it('1. desligada nas configurações: nada de chaves nem de ligar', async () => {
    const u = await newUser(A);
    const k = await makeKeys();
    const r = await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: k.publicKey, private_key: k.blob }, u);
    expect([r.status, r.errorType]).toEqual([403, 'error-e2e-disabled']);
    expect(r.error).toBe('A criptografia de ponta a ponta está desligada nas configurações do chat.');
    const rid = await group(u);
    const t = await save(u, rid, { encrypted: true });
    expect([t.status, t.errorType]).toEqual([400, 'error-e2e-disabled']);
    // Ligar a configuração (o resto dos testes usa a criptografia ligada).
    expect((await setSettings({ E2E_Enable: true })).success).toBe(true);
  });

  it('2. grava e lê as próprias chaves; outra pessoa não vê; me.e2eKeys é a impressão digital', async () => {
    const u = await newUser(A);
    const other = await newUser(A);
    expect((await api('GET', 'me', {}, u)).e2eKeys).toBeNull();
    const k = await withKeys(u);
    const mine = await api('GET', 'e2e.fetchMyKeys', {}, u);
    expect(mine).toMatchObject({ publicKey: k.publicKey, privateKey: k.blob });
    expect(await api('GET', 'e2e.fetchMyKeys', {}, other)).toMatchObject({ publicKey: null, privateKey: null });
    expect((await api('GET', 'me', {}, u)).e2eKeys).toBe(await fingerprint(k.publicKey));
    expect(await audits('user.e2e.keys.created')).toEqual(expect.arrayContaining([expect.objectContaining({ actor_id: u.userId })]));
  });

  it('3. formato: chave pública curta ou chave privada sem salt são recusadas', async () => {
    const u = await newUser(A);
    const k = await makeKeys();
    const j = JSON.parse(k.publicKey);
    const short = await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: JSON.stringify({ ...j, n: j.n.slice(1) }), private_key: k.blob }, u);
    expect([short.status, short.errorType]).toEqual([400, 'error-e2e-invalid-key']);
    const { salt: _s, ...noSalt } = JSON.parse(k.blob);
    const bad = await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: k.publicKey, private_key: JSON.stringify(noSalt) }, u);
    expect([bad.status, bad.errorType]).toEqual([400, 'error-e2e-invalid-key']);
  });

  it('4. mesma chave pública com outra senha troca a senha; outra chave pública é recusada', async () => {
    const u = await newUser(A);
    const k = await withKeys(u);
    const ws = await online(u);
    try {
      const updated = next(ws, (e) => e.type === 'e2e.keys' && e.action === 'updated');
      const { pkcs8 } = await generateUserKeys(); // o conteúdo não importa ao servidor: só o formato
      const blob2 = await encryptPrivateKey(pkcs8, 'outra senha comprida', 100_000);
      expect((await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: k.publicKey, private_key: blob2 }, u)).success).toBe(true);
      await updated();
      expect((await api('GET', 'e2e.fetchMyKeys', {}, u)).privateKey).toBe(blob2);
      expect((await audits('user.e2e.password.changed')).some((r) => r.actor_id === u.userId)).toBe(true);
      const other = await makeKeys();
      const r = await api('POST', 'e2e.setUserPublicAndPrivateKeys', { public_key: other.publicKey, private_key: other.blob }, u);
      expect([r.status, r.errorType]).toEqual([409, 'error-e2e-keys-exist']);
    } finally {
      ws.close();
    }
  });
});

// ---------- Ligar e desligar ----------

describe('criptografia: ligar e desligar', () => {
  it('5. canal público não pode ser criptografado', async () => {
    const u = await person();
    const c = await api('POST', 'channels.create', { name: name('canal') }, u);
    const t = await save(u, c.channel._id, { encrypted: true });
    expect([t.status, t.errorType]).toEqual([400, 'error-e2e-room-type']);
    const created = await api('POST', 'channels.create', { name: name('canal'), extraData: { encrypted: true } }, u);
    expect([created.status, created.errorType]).toEqual([400, 'error-e2e-room-type']);
  });

  it('6. grupo: sem permissão não liga; dono sem chaves não liga; dono com chaves liga', async () => {
    const owner = await newUser(A);
    const member = await person();
    const rid = await group(owner, [member]);
    const denied = await save(member, rid, { encrypted: true });
    expect([denied.status, denied.errorType]).toEqual([403, 'error-not-allowed']);
    expect(denied.error).toBe('Sem permissão para ligar ou desligar a criptografia desta conversa.');
    const noKeys = await save(owner, rid, { encrypted: true });
    expect([noKeys.status, noKeys.errorType]).toEqual([400, 'error-e2e-no-keys']);
    await withKeys(owner);
    expect((await save(owner, rid, { encrypted: true })).success).toBe(true);
    const room = await info(owner, rid);
    expect(room).toMatchObject({ encrypted: true, e2eKeyId: null });
    const sys = (await api('GET', 'groups.history', { roomId: rid }, owner)).messages.find((m: any) => m.t === 'room_e2e_enabled');
    expect(sys).toBeTruthy();
    const a = (await audits('room.settings.changed')).filter((r) => r.target.rid === rid);
    expect(a.at(-1).data.fields).toContain('encrypted');
    // Grupo criado já criptografado.
    const g2 = await api('POST', 'groups.create', { name: name('grupo'), extraData: { encrypted: true } }, owner);
    expect(g2.group.encrypted).toBe(true);
    const g3 = await api('POST', 'groups.create', { name: name('grupo'), extraData: { encrypted: true } }, await newUser(A));
    expect([g3.status, g3.errorType]).toEqual([400, 'error-e2e-no-keys']);
  });

  it('7. DM: participante liga só com {encrypted}; DM entre dois da Operação é recusada pela regra das conversas diretas', async () => {
    const ana = await person();
    const bruno = await person();
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
    expect((await save(ana, dm, { encrypted: true })).success).toBe(true);
    expect((await info(bruno, dm)).encrypted).toBe(true);
    // Outra coisa junto pede edit-room, que quem participa da DM não tem.
    expect((await save(bruno, dm, { encrypted: false, roomTopic: 'x' })).status).toBe(403);
    expect((await save(bruno, dm, { encrypted: false })).success).toBe(true);

    // DM que ficou bloqueada (os dois passaram a ser da Operação): nem ligar, nem chave.
    const op1 = await person({ roles: ['operacao'] });
    const sup = await person();
    const old = (await api('POST', 'im.create', { username: op1.username }, sup)).room._id;
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: sup.username }, A);
    await api('POST', 'roles.removeUserFromRole', { roleId: 'user', username: sup.username }, A);
    const r = await save(op1, old, { encrypted: true });
    expect([r.status, r.errorType]).toEqual([403, 'error-direct-restricted']);
    expect((await info(op1, old)).encrypted).toBe(false);
    // Mesmo com a sala marcada no banco, nenhuma chave passa por ela.
    await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [old]);
    const { key, keyID } = await generateRoomKey();
    const k = await api('POST', 'e2e.setRoomKeyID', { rid: old, keyID, key: await wrapFor(key, op1) }, op1);
    expect([k.status, k.errorType]).toEqual([403, 'error-direct-restricted']);
    expect(await keyRows(old)).toHaveLength(0);
    await pool.query('UPDATE rooms SET encrypted = false WHERE id = $1', [old]);
  });

  it('7b. sem edit-room, quem não participa não lê a sala pela resposta (nem sem mudar nada)', async () => {
    const ana = await person();
    const bruno = await person();
    const fora = await person();
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
    await send(ana, dm, 'segredo da DM 4321');
    const gid = await group(ana, [bruno]);
    await api('POST', 'groups.setTopic', { roomId: gid, topic: 'tópico secreto' }, ana);
    await send(ana, gid, 'segredo do grupo 9876');
    for (const rid of [dm, gid]) {
      for (const body of [{}, { encrypted: false }, { encrypted: true }]) {
        const r = await save(fora, rid, body);
        expect(r.status).toBe(403);
        expect(r.room).toBeUndefined();
        expect(JSON.stringify(r)).not.toContain('segredo');
        expect(JSON.stringify(r)).not.toContain(ana.username);
      }
    }
    // Só {rid}, mesmo para quem participa da DM: não é pedido de ligar nem de desligar.
    expect((await save(bruno, dm, {})).status).toBe(403);
    // Quem participa da DM, sem mudar nada: passa pela regra de ligar e recebe a sala.
    const same = await save(bruno, dm, { encrypted: false });
    expect(same.success).toBe(true);
    expect(same.room.encrypted).toBe(false);
    expect(await info(ana, dm)).toMatchObject({ encrypted: false });
    expect((await info(ana, gid)).encrypted).toBe(false);
  });

  it('8. grupo criptografado não vira público', async () => {
    const owner = await person();
    const room = await encryptedGroup(owner);
    const r = await save(owner, room.rid, { roomType: 'c' });
    expect([r.status, r.errorType]).toEqual([400, 'error-e2e-public']);
    expect(r.error).toBe('Desligue a criptografia antes de tornar o grupo público.');
    // Desligando junto, pode.
    expect((await save(owner, room.rid, { roomType: 'c', encrypted: false })).success).toBe(true);
    expect(await info(owner, room.rid)).toMatchObject({ t: 'c', encrypted: false });
  });
});

// ---------- Chave da sala ----------

describe('criptografia: chave da sala', () => {
  it('9. primeira chave: uma vez só, e só para quem participa', async () => {
    const owner = await person();
    const outsider = await person();
    const rid = await group(owner);
    await save(owner, rid, { encrypted: true });
    const { key, keyID } = await generateRoomKey();
    const notMember = await api('POST', 'e2e.setRoomKeyID', { rid, keyID, key: await wrapFor(key, outsider) }, outsider);
    expect([notMember.status, notMember.errorType]).toEqual([403, 'error-e2e-not-member']);
    expect((await api('POST', 'e2e.setRoomKeyID', { rid, keyID, key: await wrapFor(key, owner) }, owner)).success).toBe(true);
    expect((await info(owner, rid)).e2eKeyId).toBe(keyID);
    const again = await generateRoomKey();
    const r = await api('POST', 'e2e.setRoomKeyID', { rid, keyID: again.keyID, key: await wrapFor(again.key, owner) }, owner);
    expect([r.status, r.errorType]).toEqual([409, 'error-e2e-key-exists']);
    const mine = await api('GET', 'e2e.fetchRoomKeys', { rid }, owner);
    expect(mine).toMatchObject({ keyID, rotate: false, keys: [{ keyID, providedBy: owner.userId }] });
    expect((await audits('room.e2e.key.created')).some((a) => a.target.rid === rid)).toBe(true);
  });

  it('10. quem está sem a chave: só membros com chaves, sem a própria pessoa', async () => {
    const owner = await person();
    const withK = await person();
    const noK = await newUser(A);
    const outsider = await person();
    const rid = await group(owner, [withK, noK]);
    await save(owner, rid, { encrypted: true });
    const room = await createKey(owner, rid);
    const r = await api('GET', 'e2e.getUsersOfRoomWithoutKey', { rid }, withK);
    expect([r.status, r.errorType]).toEqual([403, 'error-e2e-no-key']);
    const list = await api('GET', 'e2e.getUsersOfRoomWithoutKey', { rid }, owner);
    expect(list.users).toEqual([{ _id: withK.userId, username: withK.username, e2e: { public_key: userKeys.get(withK.userId)!.publicKey } }]);
    await giveKey(room, owner, [withK]);
    expect((await api('GET', 'e2e.getUsersOfRoomWithoutKey', { rid }, owner)).users).toEqual([]);
    expect((await api('GET', 'e2e.getUsersOfRoomWithoutKey', { rid }, outsider)).errorType).toBe('error-e2e-not-member');
  });

  it('11. entregar a chave: quem recebe é avisado; de fora fica em skipped; chave velha e lote grande são recusados', async () => {
    const owner = await person();
    const member = await person();
    const outsider = await person();
    const rid = await group(owner, [member]);
    await save(owner, rid, { encrypted: true });
    const room = await createKey(owner, rid);
    const ws = await online(member);
    try {
      const avail = next(ws, (e) => e.type === 'e2e.keyAvailable' && e.rid === rid);
      const r = await api(
        'POST',
        'e2e.updateGroupKey',
        { rid, keyID: room.keyID, keys: [{ uid: member.userId, key: await wrapFor(room.key, member) }, { uid: outsider.userId, key: await wrapFor(room.key, outsider) }] },
        owner,
      );
      expect(r).toMatchObject({ inserted: 1, skipped: [outsider.userId] });
      expect((await avail()).keyID).toBe(room.keyID);
      const got = await api('GET', 'e2e.fetchRoomKeys', { rid }, member);
      expect(got.keys).toEqual([expect.objectContaining({ keyID: room.keyID, providedBy: owner.userId })]);
      const stale = await api('POST', 'e2e.updateGroupKey', { rid, keyID: 'AAAAAAAAAAAAAAAA', keys: [{ uid: member.userId, key: await wrapFor(room.key, member) }] }, owner);
      expect([stale.status, stale.errorType]).toEqual([403, 'error-e2e-no-key']);
      // Quem tem uma geração antiga não entrega mais por ela.
      await pool.query(`INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by) VALUES ($1,$2,'BBBBBBBBBBBBBBBB',$3,$2)`, [rid, owner.userId, 'x'.repeat(342)]);
      const old = await api('POST', 'e2e.updateGroupKey', { rid, keyID: 'BBBBBBBBBBBBBBBB', keys: [{ uid: member.userId, key: 'x'.repeat(342) }] }, owner);
      expect([old.status, old.errorType]).toEqual([409, 'error-e2e-key-outdated']);
      const many = Array.from({ length: 201 }, () => ({ uid: member.userId, key: 'x'.repeat(342) }));
      const big = await api('POST', 'e2e.updateGroupKey', { rid, keyID: room.keyID, keys: many }, owner);
      expect([big.status, big.errorType]).toEqual([400, 'error-e2e-batch']);
      const bad = await api('POST', 'e2e.updateGroupKey', { rid, keyID: room.keyID, keys: [{ uid: member.userId, key: 'curta' }] }, owner);
      expect([bad.status, bad.errorType]).toEqual([400, 'error-e2e-invalid-key']);
    } finally {
      ws.close();
    }
  });

  it('12. pessoa nova com chaves: pedido de chave para a sala, no máximo um a cada 10 s', async () => {
    resetKeyRequestWindows();
    const owner = await person();
    const room = await encryptedGroup(owner);
    const ws = await online(owner);
    try {
      const n1 = await person();
      const n2 = await person();
      const req = next(ws, (e) => e.type === 'e2e.keyRequest' && e.rid === room.rid);
      expect((await api('POST', 'groups.invite', { roomId: room.rid, userId: n1.userId }, owner)).success).toBe(true);
      expect(await req()).toMatchObject({ rid: room.rid, keyID: room.keyID });
      const since = ws.events.length;
      expect((await api('POST', 'groups.invite', { roomId: room.rid, userId: n2.userId }, owner)).success).toBe(true);
      await sleep(400);
      expect(countSince(ws, since, (e) => e.type === 'e2e.keyRequest' && e.rid === room.rid)).toBe(0);
      // Sem chaves ainda: nenhum pedido.
      resetKeyRequestWindows();
      const n3 = await newUser(A);
      const since3 = ws.events.length;
      await api('POST', 'groups.invite', { roomId: room.rid, userId: n3.userId }, owner);
      await sleep(300);
      expect(countSince(ws, since3, (e) => e.type === 'e2e.keyRequest')).toBe(0);
    } finally {
      ws.close();
      resetKeyRequestWindows();
    }
  });

  it('12b. quem tem a chave e acabou de desbloquear vê onde entregar ou trocar', async () => {
    const ana = await person();
    const bruno = await person();
    const room = await encryptedGroup(ana, [bruno]);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, ana)).rooms).toEqual([]);
    // Carla chega com chaves enquanto ninguém com a chave está com o chat aberto.
    const carla = await person();
    await api('POST', 'groups.invite', { roomId: room.rid, userId: carla.userId }, ana);
    const pending = { rid: room.rid, keyID: room.keyID, rotate: false };
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, ana)).rooms).toEqual([pending]);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, bruno)).rooms).toEqual([pending]);
    // Quem não tem a chave (Carla) e quem não participa não veem nada.
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, carla)).rooms).toEqual([]);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, await person())).rooms).toEqual([]);
    // Sem chaves da criptografia (ainda não configurou) também não conta.
    const semChaves = await newUser(A);
    await api('POST', 'groups.invite', { roomId: room.rid, userId: semChaves.userId }, ana);
    await giveKey(room, ana, [carla]);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, ana)).rooms).toEqual([]);
    // Bruno sai: a sala pede chave nova, e quem ficou com a chave vê a troca.
    await api('POST', 'rooms.leave', { roomId: room.rid }, bruno);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, ana)).rooms).toEqual([{ ...pending, rotate: true }]);
    expect((await api('GET', 'e2e.fetchRoomsToProvide', {}, bruno)).rooms).toEqual([]);
  });

  it('13. recusar uma chave que não confere: apaga, registra e pede de novo', async () => {
    resetKeyRequestWindows();
    const owner = await person();
    const member = await person();
    const room = await encryptedGroup(owner, [member]);
    const ws = await online(owner);
    try {
      const req = next(ws, (e) => e.type === 'e2e.keyRequest' && e.rid === room.rid);
      expect((await api('POST', 'e2e.rejectSuggestedGroupKey', { rid: room.rid, keyID: room.keyID }, member)).success).toBe(true);
      expect((await keyRows(room.rid)).map((r) => r.user_id)).toEqual([owner.userId]);
      const a = (await audits('room.e2e.key.rejected')).find((x) => x.target.rid === room.rid);
      expect(a.data).toEqual({ keyID: room.keyID, providedBy: owner.userId });
      await req();
      // A própria chave (criada por ela) não é apagada assim.
      await api('POST', 'e2e.rejectSuggestedGroupKey', { rid: room.rid, keyID: room.keyID }, owner);
      expect((await keyRows(room.rid)).map((r) => r.user_id)).toEqual([owner.userId]);
    } finally {
      ws.close();
      resetKeyRequestWindows();
    }
  });
});

// ---------- Mensagens ----------

describe('criptografia: mensagens', () => {
  it('14. sala criptografada não recebe texto aberto (chat, postMessage, webhook de entrada)', async () => {
    await withKeys(A).catch(() => {}); // o admin pode já ter chaves de outro teste
    const room = await encryptedGroup(A);
    const plain = await send(A, room.rid, 'oi');
    expect([plain.status, plain.errorType]).toEqual([400, 'error-e2e-required']);
    expect(plain.error).toBe('Esta conversa é criptografada: o servidor não pode publicar texto aqui.');
    const post = await api('POST', 'chat.postMessage', { roomId: room.rid, text: 'oi' }, A);
    expect([post.status, post.errorType]).toEqual([400, 'error-e2e-required']);
    const groupName = (await info(A, room.rid)).name;
    const integ = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'CI', username: 'admin', channel: `#${groupName}` }, A);
    expect(integ.success).toBe(true);
    const res = await fetch(urlOf(`/hooks/${integ.integration._id}/${integ.integration.token}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'alerta' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorType).toBe('error-e2e-required');
    const msgs = (await api('GET', 'groups.history', { roomId: room.rid }, A)).messages.filter((m: any) => !m.t);
    expect(msgs).toHaveLength(0);
  });

  it('15. mensagem cifrada: msg vazio, envelope guardado, busca não acha, prévia "Mensagem criptografada"', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const mid = newMessageId();
    const e2e = await envelope(ana, room, mid, 'reunião secreta às 15h');
    const r = await sendE2e(ana, room, '', { mid, e2e });
    expect(r.success).toBe(true);
    expect(r.message).toMatchObject({ _id: mid, msg: '', e2e });
    const row = await msgRow(mid);
    expect(row.msg).toBe('');
    expect(row.e2e).toEqual(e2e);
    expect(row.t).toBeNull();
    expect((await api('GET', 'chat.search', { roomId: room.rid, searchText: 'reunião' }, ana)).messages).toHaveLength(0);
    expect((await api('GET', 'chat.search', { roomId: room.rid, searchText: e2e.ct.slice(0, 8) }, ana)).messages).toHaveLength(0);
    expect((await info(ana, room.rid)).lastMessage.msg).toBe(E2E_PREVIEW);
    // Spotlight só procura pessoas e canais públicos: nada da conversa aparece.
    expect((await api('GET', 'spotlight', { query: 'reunião' }, ana)).rooms).toEqual([]);
  });

  it('16. envelope conferido: chave velha, autor trocado, sala sem criptografia, campos abertos junto', async () => {
    const ana = await person();
    const bruno = await person();
    const room = await encryptedGroup(ana, [bruno]);
    const mid = newMessageId();
    const stale = await sendE2e(ana, room, 'x', { mid, e2e: { ...(await envelope(ana, room, mid, 'x')), kid: 'CCCCCCCCCCCCCCCC' } });
    expect([stale.status, stale.errorType]).toEqual([409, 'error-e2e-key-outdated']);
    const other = await sendE2e(bruno, room, 'x', { e2e: await envelope(ana, room, newMessageId(), 'x') });
    expect([other.status, other.errorType]).toEqual([400, 'error-e2e-invalid']);
    const badId = await api('POST', 'chat.sendMessage', { message: { _id: 'x', rid: room.rid, e2e: await envelope(ana, room, 'x', 'x') } }, ana);
    expect(badId.errorType).toBe('error-e2e-invalid');
    const extraKey = await sendE2e(ana, room, 'x', { e2e: { ...(await envelope(ana, room, mid, 'x')), extra: 1 } });
    expect(extraKey.errorType).toBe('error-e2e-invalid');
    const withMsg = await sendE2e(ana, room, 'x', { extra: { msg: 'aberto' } });
    expect([withMsg.status, withMsg.errorType]).toEqual([400, 'error-e2e-plain-field']);
    const withAtt = await sendE2e(ana, room, 'x', { extra: { attachments: [{ text: 'aberto' }] } });
    expect(withAtt.errorType).toBe('error-e2e-plain-field');
    const plainRoom = await group(ana);
    const mid2 = newMessageId();
    const r = await api('POST', 'chat.sendMessage', { message: { _id: mid2, rid: plainRoom, e2e: await envelope(ana, { ...room, rid: plainRoom }, mid2, 'x') } }, ana);
    expect([r.status, r.errorType]).toEqual([400, 'error-e2e-not-encrypted']);
  });

  it('17. reenvio com o mesmo _id: a mesma mensagem; outro conteúdo com o mesmo _id é recusado', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const mid = newMessageId();
    const e2e = await envelope(ana, room, mid, 'uma vez');
    const [a, b] = await Promise.all([sendE2e(ana, room, '', { mid, e2e }), sendE2e(ana, room, '', { mid, e2e })]);
    expect(a.message._id).toBe(mid);
    expect(b.message._id).toBe(mid);
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE id = $1', [mid])).rows[0].n).toBe(1);
    const again = await sendE2e(ana, room, '', { mid, e2e });
    expect(again.message._id).toBe(mid);
    const other = await sendE2e(ana, room, 'outra', { mid });
    expect([other.status, other.errorType]).toEqual([409, 'error-e2e-id']);
    expect((await info(ana, room.rid)).msgs).toBe(1);
  });

  it('18. menções vêm da web: contam e avisam com "Mensagem criptografada"; @all segue a permissão', async () => {
    const ana = await person({ name: 'Ana Souza' });
    const bruno = await person();
    const room = await encryptedGroup(ana, [bruno]);
    const ws = await online(bruno);
    try {
      const notif = next(ws, (e) => e.type === 'notification' && e.rid === room.rid);
      expect((await sendE2e(ana, room, `oi @${bruno.username}`, { mentions: [bruno.username, 'nao-existe', '<script>'] })).success).toBe(true);
      const ev = await notif();
      expect(ev.text).toBe(`Ana Souza: ${E2E_PREVIEW}`);
      expect(ev.e2e).toMatchObject({ prefix: 'Ana Souza: ', envelope: { kid: room.keyID, by: ana.userId } });
      const sub = (await api('GET', 'subscriptions.getOne', { roomId: room.rid }, bruno)).subscription;
      expect(sub.userMentions).toBe(1);
      // Conteúdo escondido nas notificações: o envelope não vai junto.
      await setSettings({ Push_Privacy_Hide_Content: true });
      try {
        const hidden = next(ws, (e) => e.type === 'notification' && e.rid === room.rid);
        await sendE2e(ana, room, 'x', { mentions: [bruno.username] });
        const h = await hidden();
        expect(h.e2e).toBeUndefined();
      } finally {
        await setSettings({ Push_Privacy_Hide_Content: false });
      }
    } finally {
      ws.close();
    }
    const before = await permissionRoles('mention-all');
    await setPermission(
      'mention-all',
      before.filter((r) => r !== 'user' && r !== 'owner'),
    );
    try {
      const r = await sendE2e(ana, room, '@all oi', { mentions: ['all'] });
      expect(r.status).toBe(403);
      expect(r.error).toBe('Sem permissão para mencionar @all.');
    } finally {
      await setPermission('mention-all', before);
    }
  });

  it('19. editar: novo envelope, histórico guarda o anterior; texto aberto é recusado', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const mid = newMessageId();
    const first = await envelope(ana, room, mid, 'antes');
    await sendE2e(ana, room, '', { mid, e2e: first });
    const second = await envelope(ana, room, mid, 'depois');
    const u = await api('POST', 'chat.update', { roomId: room.rid, msgId: mid, e2e: second, e2eMentions: [] }, ana);
    expect(u.success).toBe(true);
    expect(u.message).toMatchObject({ msg: '', e2e: second });
    expect(u.message.editedBy).toMatchObject({ _id: ana.userId });
    const hist = await api('GET', 'chat.getMessageHistory', { msgId: mid }, ana);
    expect(hist.history).toEqual([expect.objectContaining({ msg: '', e2e: first })]);
    const plain = await api('POST', 'chat.update', { roomId: room.rid, msgId: mid, text: 'aberto' }, ana);
    expect([plain.status, plain.errorType]).toEqual([400, 'error-e2e-required']);
    expect((await info(ana, room.rid)).lastMessage.msg).toBe(E2E_PREVIEW);

    // Mensagem aberta de antes de ligar a criptografia, editada depois: a prévia deixa de mostrar o texto antigo.
    const rid = await group(ana);
    const old = (await send(ana, rid, 'texto antigo aberto')).message;
    expect((await save(ana, rid, { encrypted: true })).success).toBe(true);
    const later = await createKey(ana, rid);
    expect((await info(ana, rid)).lastMessage.msg).toBe('texto antigo aberto');
    const ws = await online(ana);
    try {
      const changed = next(ws, (e) => e.type === 'room' && e.room?._id === rid && e.room?.lastMessage?.msg === E2E_PREVIEW);
      const e = await api('POST', 'chat.update', { roomId: rid, msgId: old._id, e2e: await envelope(ana, later, old._id, 'texto novo'), e2eMentions: [] }, ana);
      expect(e.message).toMatchObject({ msg: '', e2e: { kid: later.keyID } });
      await changed();
    } finally {
      ws.close();
    }
    expect((await info(ana, rid)).lastMessage.msg).toBe(E2E_PREVIEW);
    expect(JSON.stringify(await roomRow(rid))).not.toContain('texto antigo aberto');
  });

  it('20. thread: resposta cifrada conta na raiz; filtro por texto não acha', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const root = (await sendE2e(ana, room, 'raiz')).message;
    expect((await sendE2e(ana, room, 'resposta', { extra: { tmid: root._id } })).success).toBe(true);
    expect((await api('GET', 'chat.getMessage', { msgId: root._id }, ana)).message.tcount).toBe(1);
    expect((await api('GET', 'chat.getThreadsList', { rid: room.rid, text: 'raiz' }, ana)).threads).toEqual([]);
    expect((await api('GET', 'chat.getThreadsList', { rid: room.rid }, ana)).threads).toHaveLength(1);
  });

  it('21. fixar: o anexo do sistema vai sem texto; citar o link em canal aberto mostra "Mensagem criptografada"', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const m = (await sendE2e(ana, room, 'fixada')).message;
    expect((await api('POST', 'chat.pinMessage', { messageId: m._id }, ana)).success).toBe(true);
    const sys = (await api('GET', 'groups.history', { roomId: room.rid }, ana)).messages.find((x: any) => x.t === 'message_pinned');
    expect(sys.attachments[0]).toMatchObject({ text: '', author_name: ana.username });
    expect(sys.pinnedMessageId).toBe(m._id);
    const c = (await api('POST', 'channels.create', { name: name('canal') }, ana)).channel._id;
    const q = await send(ana, c, 'olha isso', { attachments: [{ message_link: `?msg=${m._id}` }] });
    expect(q.message.attachments[0].text).toBe(E2E_PREVIEW);
  });

  it('22. figurinha é recusada', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const r = await api('POST', 'chat.sendSticker', { roomId: room.rid, stickerId: 'qualquer' }, ana);
    expect([r.status, r.errorType]).toEqual([400, 'error-e2e-sticker']);
    expect(stickersAllowedIn({ t: 'p', encrypted: true }, { noticeRooms: true })).toBe(false);
  });

  it('23. comandos que publicam texto pelo servidor são recusados; os outros funcionam', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const shrug = await api('POST', 'commands.run', { roomId: room.rid, command: 'shrug', params: 'oi' }, ana);
    expect([shrug.status, shrug.errorType]).toEqual([400, 'error-e2e-required']);
    const topic = await api('POST', 'commands.run', { roomId: room.rid, command: 'topic', params: 'novo assunto' }, ana);
    expect(topic.success).toBe(true);
    expect((await info(ana, room.rid)).topic).toBe('novo assunto');
  });

  it('24. grupo de avisos criptografado: leitor recebe o mesmo erro do texto aberto; publicador envia; "Ciente" funciona', async () => {
    const owner = await person();
    const reader = await person();
    const room = await encryptedGroup(owner, [reader], { notice: true, noticeAck: true });
    const plain = await send(reader, room.rid, 'oi');
    const e2e = await sendE2e(reader, room, 'oi');
    expect([e2e.status, e2e.error]).toEqual([plain.status, plain.error]);
    expect(e2e.status).toBe(403);
    const sent = await sendE2e(owner, room, 'aviso', { extra: { ackRequired: true } });
    expect(sent.success).toBe(true);
    expect(sent.message.ackRequired).toBe(true);
    expect((await api('POST', 'chat.ack', { messageId: sent.message._id }, reader)).success).toBe(true);
  });

  it('25. silenciado: o mesmo erro do texto aberto', async () => {
    const owner = await person();
    const member = await person();
    const room = await encryptedGroup(owner, [member]);
    expect((await api('POST', 'rooms.muteUser', { roomId: room.rid, username: member.username }, owner)).success).toBe(true);
    const plain = await send(member, room.rid, 'oi');
    const e2e = await sendE2e(member, room, 'oi');
    expect([e2e.status, e2e.error]).toEqual([plain.status, plain.error]);
    expect(e2e.error).toBe('Você está silenciado nesta sala.');
  });
});

// ---------- Arquivos ----------

describe('criptografia: arquivos', () => {
  it('26. arquivo cifrado: nome e tipo genéricos, sem anexo aberto, baixa os mesmos bytes; lista de tipos não vale', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const noE2e = await api('POST', `rooms.upload/${room.rid}`, e2eForm({}), ana);
    expect([noE2e.status, noE2e.errorType]).toEqual([400, 'error-e2e-required']);
    const mid = newMessageId();
    const plainBytes = new TextEncoder().encode('conteúdo do relatório');
    const { data, ref } = await encryptFile(plainBytes, room.rid, mid);
    const e2e = await envelope(ana, room, mid, 'legenda', { file: { name: 'relatório.pdf', type: 'application/pdf', size: plainBytes.length, ...ref } });
    await setSettings({ FileUpload_MediaTypeWhiteList: 'image/*' });
    try {
      const up = await api('POST', `rooms.upload/${room.rid}`, e2eForm({ _id: mid, e2e: JSON.stringify(e2e), e2eMentions: '' }, new Uint8Array(data), 'application/pdf', 'relatório.pdf'), ana);
      expect(up.success).toBe(true);
      expect(up.message).toMatchObject({ _id: mid, msg: '', e2e, attachments: [] });
      const f = up.message.files[0];
      expect(f).toMatchObject({ name: 'arquivo-criptografado', type: 'application/octet-stream', size: data.byteLength, e2e: true });
      const row = (await pool.query('SELECT * FROM files WHERE id = $1', [f._id])).rows[0];
      expect(row).toMatchObject({ e2e: true, name: 'arquivo-criptografado', type: 'application/octet-stream', message_id: mid });
      const res = await raw(`/file-upload/${f._id}/arquivo-criptografado`, ana);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
      const list = await api('GET', 'groups.files', { roomId: room.rid }, ana);
      // O painel Arquivos decifra o nome e o tipo pela mensagem (o mesmo conteúdo cifrado do histórico).
      expect(list.files[0]).toMatchObject({ _id: f._id, e2e: true, messageId: mid, e2eMessage: { e2e, u: { _id: ana.userId } } });
      expect(hooked.some((h) => h.id === mid)).toBe(false);
      // Reenvio do mesmo arquivo (a rede caiu depois de gravar): a mesma mensagem, e a cópia nova não fica solta.
      const again = await api('POST', `rooms.upload/${room.rid}`, e2eForm({ _id: mid, e2e: JSON.stringify(e2e), e2eMentions: '' }, new Uint8Array(data), 'application/pdf', 'relatório.pdf'), ana);
      expect(again.success).toBe(true);
      expect(again.message.files[0]._id).toBe(f._id);
      expect((await pool.query('SELECT id, message_id FROM files WHERE room_id = $1', [room.rid])).rows).toEqual([{ id: f._id, message_id: mid }]);
      expect((await api('GET', 'groups.files', { roomId: room.rid }, ana)).total).toBe(1);
    } finally {
      await setSettings({ FileUpload_MediaTypeWhiteList: '' });
    }
  });

  it('27. voz e legenda abertas são recusadas', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const mid = newMessageId();
    const e2e = JSON.stringify(await envelope(ana, room, mid, ''));
    const voice = await api('POST', `rooms.upload/${room.rid}`, e2eForm({ _id: mid, e2e, voice: '1', duration: '3' }), ana);
    expect([voice.status, voice.errorType]).toEqual([400, 'error-e2e-plain-field']);
    const caption = await api('POST', `rooms.upload/${room.rid}`, e2eForm({ _id: mid, e2e, description: 'aberta' }), ana);
    expect(caption.errorType).toBe('error-e2e-plain-field');
    expect((await pool.query('SELECT count(*)::int AS n FROM files WHERE room_id = $1', [room.rid])).rows[0].n).toBe(0);
  });
});

// ---------- Troca de chave ----------

describe('criptografia: troca de chave', () => {
  it('28. quem tinha a chave sai: pedido de troca; a troca vale uma vez', async () => {
    const owner = await person();
    const bruno = await person();
    const carla = await person();
    const room = await encryptedGroup(owner, [bruno, carla]);
    const ws = await online(bruno);
    const carlaWs = await online(carla);
    try {
      const rotate = next(ws, (e) => e.type === 'e2e.rotate' && e.rid === room.rid);
      const since = carlaWs.events.length;
      const removed = next(carlaWs, (e) => e.type === 'subscription' && e.action === 'removed');
      expect((await api('POST', 'groups.leave', { roomId: room.rid }, carla)).success).toBe(true);
      expect(await rotate()).toMatchObject({ keyID: room.keyID });
      // Quem saiu não ouve mais a sala: o pedido de troca e a sala atualizada não chegam para ela.
      await removed();
      expect(countSince(carlaWs, since, (e) => e.type === 'e2e.rotate' || (e.type === 'room' && (e.room?._id ?? e.rid) === room.rid))).toBe(0);
      expect((await info(owner, room.rid)).e2eRotate).toBe(true);
      expect((await keyRows(room.rid)).map((r) => r.user_id).sort()).toEqual([owner.userId, bruno.userId].sort());
      const fresh = await generateRoomKey();
      const avail = next(ws, (e) => e.type === 'e2e.keyAvailable' && e.rid === room.rid && e.keyID === fresh.keyID);
      const keys = [
        { uid: owner.userId, key: await wrapFor(fresh.key, owner) },
        { uid: bruno.userId, key: await wrapFor(fresh.key, bruno) },
        { uid: carla.userId, key: await wrapFor(fresh.key, carla) },
      ];
      const r = await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: fresh.keyID, keys }, owner);
      expect(r).toMatchObject({ inserted: 2, skipped: [carla.userId] });
      await avail();
      expect(await info(owner, room.rid)).toMatchObject({ e2eKeyId: fresh.keyID });
      expect((await info(owner, room.rid)).e2eRotate).toBeUndefined();
      expect((await audits('room.e2e.key.rotated')).find((a) => a.target.rid === room.rid).data).toEqual({ prev: room.keyID, keyID: fresh.keyID, reason: 'pedido' });
      const again = await generateRoomKey();
      const second = await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: again.keyID, keys: [{ uid: owner.userId, key: await wrapFor(again.key, owner) }] }, owner);
      expect([second.status, second.errorType]).toEqual([409, 'error-e2e-key-outdated']);
      // A mensagem com a chave antiga não entra mais.
      const old = await sendE2e(bruno, room, 'chave antiga');
      expect(old.errorType).toBe('error-e2e-key-outdated');
      expect((await sendE2e(bruno, { ...room, keyID: fresh.keyID, key: fresh.key }, 'chave nova')).success).toBe(true);
    } finally {
      ws.close();
      carlaWs.close();
    }
  });

  it('29. troca sem pedido: só quem pode ligar a criptografia', async () => {
    const owner = await person();
    const member = await person();
    const room = await encryptedGroup(owner, [member]);
    const fresh = await generateRoomKey();
    const keys = [
      { uid: member.userId, key: await wrapFor(fresh.key, member) },
      { uid: owner.userId, key: await wrapFor(fresh.key, owner) },
    ];
    const denied = await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: fresh.keyID, keys }, member);
    expect([denied.status, denied.errorType, denied.error]).toEqual([403, 'error-not-allowed', 'Só quem pode ligar a criptografia gera uma chave nova.']);
    const noSelf = await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: fresh.keyID, keys: [keys[0]] }, owner);
    expect(noSelf.status).toBe(400);
    expect((await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: fresh.keyID, keys }, owner)).success).toBe(true);
    expect((await audits('room.e2e.key.rotated')).find((a) => a.target.rid === room.rid).data.reason).toBe('manual');
    // Quem perde a corrida (a chave já trocou) recebe 409 de chave desatualizada, não a recusa de permissão.
    const late = await generateRoomKey();
    const lost = await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: late.keyID, keys: [{ uid: member.userId, key: await wrapFor(late.key, member) }] }, member);
    expect([lost.status, lost.errorType]).toEqual([409, 'error-e2e-key-outdated']);
  });

  it('30. quem chega depois da troca só recebe a chave atual', async () => {
    const owner = await person();
    const room = await encryptedGroup(owner);
    const fresh = await generateRoomKey();
    await api('POST', 'e2e.resetRoomKey', { rid: room.rid, prevKeyID: room.keyID, keyID: fresh.keyID, keys: [{ uid: owner.userId, key: await wrapFor(fresh.key, owner) }] }, owner);
    const newcomer = await person();
    await api('POST', 'groups.invite', { roomId: room.rid, userId: newcomer.userId }, owner);
    await giveKey({ rid: room.rid, key: fresh.key, keyID: fresh.keyID }, owner, [newcomer]);
    const got = await api('GET', 'e2e.fetchRoomKeys', { rid: room.rid }, newcomer);
    expect(got.keyID).toBe(fresh.keyID);
    expect(got.keys.map((k: any) => k.keyID)).toEqual([fresh.keyID]);
    // O dono ainda tem as duas gerações (lê o histórico antigo), a mais nova primeiro.
    expect((await api('GET', 'e2e.fetchRoomKeys', { rid: room.rid }, owner)).keys.map((k: any) => k.keyID)).toEqual([fresh.keyID, room.keyID]);
  });
});

// ---------- Redefinir e excluir ----------

describe('criptografia: redefinir e excluir', () => {
  it('31. esqueci a senha: confere a senha de entrar e o 2FA; as chaves somem e as salas trocam', async () => {
    const ana = await person();
    const bruno = await person();
    const room = await encryptedGroup(ana, [bruno]);
    const wrong = await api('POST', 'e2e.resetOwnE2EKey', { password: 'errada' }, bruno);
    expect([wrong.status, wrong.errorType, wrong.error]).toEqual([400, 'error-invalid-password', 'Senha incorreta.']);
    const secret = await enable2fa(bruno);
    const noCode = await api('POST', 'e2e.resetOwnE2EKey', { password: 'senha-forte-1' }, bruno);
    expect([noCode.status, noCode.errorType]).toEqual([400, 'invalid-totp']);
    const ws = await online(bruno);
    const wsAna = await online(ana);
    try {
      const reset = next(ws, (e) => e.type === 'e2e.keys' && e.action === 'reset');
      const rotate = next(wsAna, (e) => e.type === 'e2e.rotate' && e.rid === room.rid);
      expect((await api('POST', 'e2e.resetOwnE2EKey', { password: 'senha-forte-1', code: totpCode(secret) }, bruno)).success).toBe(true);
      await reset();
      await rotate();
      expect(await api('GET', 'e2e.fetchMyKeys', {}, bruno)).toMatchObject({ publicKey: null, privateKey: null });
      expect((await keyRows(room.rid)).map((r) => r.user_id)).toEqual([ana.userId]);
      expect((await roomRow(room.rid)).e2e_rotate).toBe(true);
      expect((await audits('user.e2e.reset')).find((a) => a.target.userId === bruno.userId).data).toEqual({ self: true });
    } finally {
      ws.close();
      wsAna.close();
    }
  });

  it('32. administrador redefine: exige a permissão, encerra as sessões; sem chaves é recusado', async () => {
    const ana = await person();
    const nobody = await newUser(A);
    const r = await api('POST', 'users.resetE2EKey', { userId: ana.userId }, nobody);
    expect(r.status).toBe(403);
    // O editor do administrador sabe quem configurou (o botão fica travado sem chaves, como o do 2FA).
    expect((await api('GET', 'users.info', { userId: ana.userId }, A)).user.e2eConfigured).toBe(true);
    expect((await api('GET', 'users.info', { userId: nobody.userId }, A)).user.e2eConfigured).toBe(false);
    expect((await api('GET', 'users.info', { userId: ana.userId }, nobody)).user.e2eConfigured).toBeUndefined();
    expect((await api('GET', 'me', {}, ana)).e2eResetByAdmin).toBeUndefined();
    const ws = await online(ana);
    try {
      const out = next(ws, (e) => e.type === 'force_logout');
      expect((await api('POST', 'users.resetE2EKey', { userId: ana.userId }, A)).success).toBe(true);
      // A saída forçada leva o motivo: a tela de entrar explica o que aconteceu.
      expect(await out()).toEqual({ type: 'force_logout', reason: 'e2e-reset' });
    } finally {
      ws.close();
    }
    expect((await api('GET', 'me', {}, ana)).status).toBe(401);
    expect((await api('GET', 'users.info', { userId: ana.userId }, A)).user.e2eConfigured).toBe(false);
    expect((await pool.query('SELECT 1 FROM e2e_user_keys WHERE user_id = $1', [ana.userId])).rowCount).toBe(0);
    expect((await audits('user.e2e.reset')).find((a) => a.target.userId === ana.userId)).toMatchObject({ actor_id: A.userId, data: { self: false } });
    const again = await api('POST', 'users.resetE2EKey', { userId: ana.userId }, A);
    expect([again.status, again.errorType]).toEqual([400, 'error-e2e-user-no-keys']);
    // Entrando de novo, o aviso continua até a pessoa criar as chaves novas.
    const back = await login(ana.username, 'senha-forte-1');
    expect((await api('GET', 'me', {}, back)).e2eResetByAdmin).toBe(true);
    await withKeys(back);
    expect((await api('GET', 'me', {}, back)).e2eResetByAdmin).toBeUndefined();
  });

  it('33. conta excluída: as chaves vão junto e as salas trocam', async () => {
    const ana = await person();
    const bruno = await person();
    const room = await encryptedGroup(ana, [bruno]);
    expect((await api('POST', 'users.delete', { userId: bruno.userId, confirmRelinquish: true }, A)).success).toBe(true);
    expect((await keyRows(room.rid)).map((r) => r.user_id)).toEqual([ana.userId]);
    expect((await roomRow(room.rid)).e2e_rotate).toBe(true);
  });
});

// ---------- Discussões, administração, retenção, integrações ----------

describe('criptografia: discussões, administração, retenção e integrações', () => {
  it('34. discussão de grupo criptografado nasce criptografada; sem primeira mensagem aberta; canal não', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const d = await api('POST', 'rooms.createDiscussion', { prid: room.rid, t_name: 'Particular' }, ana);
    expect(d.success).toBe(true);
    expect(d.discussion.encrypted).toBe(true);
    const reply = await api('POST', 'rooms.createDiscussion', { prid: room.rid, t_name: 'Com texto', reply: 'oi' }, ana);
    expect([reply.status, reply.errorType]).toEqual([400, 'error-e2e-reply']);
    const c = (await api('POST', 'channels.create', { name: name('canal') }, ana)).channel._id;
    const onC = await api('POST', 'rooms.createDiscussion', { prid: c, t_name: 'Cifrada', encrypted: true }, ana);
    expect([onC.status, onC.errorType]).toEqual([400, 'error-e2e-room-type']);
    const plain = await group(ana);
    const asked = await api('POST', 'rooms.createDiscussion', { prid: plain, t_name: 'Pedida', encrypted: true }, ana);
    expect(asked.discussion.encrypted).toBe(true);
  });

  it('35. administrador fora do grupo não recebe chave; a auditoria mostra só o envelope', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const m = (await sendE2e(ana, room, 'segredo da auditoria')).message;
    const r = await api('GET', 'e2e.fetchRoomKeys', { rid: room.rid }, A);
    expect([r.status, r.errorType]).toEqual([403, 'error-e2e-not-member']);
    const day = 86400_000;
    const a = await api('POST', 'audit.messages', { type: 'room', rid: room.rid, startDate: new Date(Date.now() - day).toISOString(), endDate: new Date(Date.now() + day).toISOString() }, A);
    const row = a.messages.find((x: any) => x._id === m._id);
    expect(row).toMatchObject({ msg: '', e2e: m.e2e });
    expect(JSON.stringify(a)).not.toContain('segredo');
    // Denúncia de mensagem cifrada: a moderação vê só que é cifrada.
    await api('POST', 'chat.reportMessage', { messageId: m._id, description: 'ofensiva' }, ana);
    const rep = await api('GET', 'moderation.userReports', { userId: ana.userId }, A);
    expect(rep.reports[0]).toMatchObject({ messageId: m._id, msg: '', e2e: true });
  });

  it('36. retenção: só arquivos mantém o envelope; apagar recalcula a prévia como "Mensagem criptografada"', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const first = (await sendE2e(ana, room, 'primeira')).message;
    const mid = newMessageId();
    const { data, ref } = await encryptFile(new TextEncoder().encode('arquivo'), room.rid, mid);
    const e2e = await envelope(ana, room, mid, '', { file: { name: 'a.txt', type: 'text/plain', size: 7, ...ref } });
    const up = await api('POST', `rooms.upload/${room.rid}`, e2eForm({ _id: mid, e2e: JSON.stringify(e2e) }, new Uint8Array(data)), ana);
    expect(up.success).toBe(true);
    const far = new Date(Date.now() + 60_000).toISOString();
    await pruneMessages(room.rid, { latest: far, oldest: new Date(0).toISOString(), filesOnly: true });
    const kept = await msgRow(mid);
    expect(kept.e2e).toEqual(e2e);
    expect(kept.files).toEqual([]);
    const last = await sendE2e(ana, room, 'última');
    await pruneMessages(room.rid, { latest: far, oldest: last.message.ts, inclusive: true });
    expect(await msgRow(last.message._id)).toBeUndefined();
    expect(await msgRow(first._id)).toBeTruthy();
    expect((await roomRow(room.rid)).last_message.msg).toBe(E2E_PREVIEW);
  });

  it('37. integrações não recebem mensagem cifrada (webhook de saída, ganchos)', async () => {
    const ana = await person();
    const integ = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'Saída', username: 'admin', event: 'sendMessage', channel: 'all_private_groups', urls: [hookUrl] }, A);
    expect(integ.success).toBe(true);
    const room = await encryptedGroup(ana, [await person()]);
    await api('POST', 'groups.invite', { roomId: room.rid, userId: A.userId }, ana);
    const m = (await sendE2e(ana, room, 'não vá para fora')).message;
    await api('POST', 'chat.update', { roomId: room.rid, msgId: m._id, e2e: await envelope(ana, room, m._id, 'editada'), e2eMentions: [] }, ana);
    // Controle: um grupo aberto dispara o webhook.
    const plain = await group(ana);
    await send(ana, plain, 'grupo aberto');
    for (let i = 0; i < 40 && !received.some((x) => x.text === 'grupo aberto'); i++) await sleep(50);
    expect(received.some((x) => x.text === 'grupo aberto')).toBe(true);
    expect(received.some((x) => x.message_id === m._id || x.channel_id === room.rid)).toBe(false);
    expect(hooked.filter((h) => h.id === m._id)).toEqual([]);
  });

  it('38. configuração desligada depois: a conversa continua; ligar outra não', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    await setSettings({ E2E_Enable: false });
    try {
      expect((await sendE2e(ana, room, 'continua')).success).toBe(true);
      const other = await group(ana);
      const r = await save(ana, other, { encrypted: true });
      expect([r.status, r.errorType]).toEqual([400, 'error-e2e-disabled']);
      // Desligar não depende da configuração.
      expect((await save(ana, room.rid, { encrypted: false })).success).toBe(true);
    } finally {
      await setSettings({ E2E_Enable: true });
    }
  });
});

// ---------- O que deixa de funcionar (spec E §7) ----------

describe('criptografia: outras funções numa conversa criptografada', () => {
  it('encaminhar: nem de uma mensagem cifrada (mesmo com a criptografia desligada depois) nem para sala criptografada', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const m = (await sendE2e(ana, room, 'não encaminhe')).message;
    const plain = await group(ana);
    const r = await api('POST', 'chat.forwardMessage', { messageId: m._id, targets: [{ rid: plain }] }, ana);
    expect(r.errorType).toBe('error-forward-encrypted');
    await save(ana, room.rid, { encrypted: false });
    const still = await api('POST', 'chat.forwardMessage', { messageId: m._id, targets: [{ rid: plain }] }, ana);
    expect(still.errorType).toBe('error-forward-encrypted');
    await save(ana, room.rid, { encrypted: true });
    const src = (await send(ana, plain, 'aberta')).message;
    const into = await api('POST', 'chat.forwardMessage', { messageId: src._id, targets: [{ rid: room.rid }] }, ana);
    expect(into.results[0]).toMatchObject({ ok: false, errorType: 'error-forward-encrypted-target' });
  });

  it('enquete, envio agendado e editar mensagem cifrada numa sala que deixou de ser criptografada', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const poll = await api('POST', 'polls.create', { rid: room.rid, question: 'Sim?', options: ['Sim', 'Não'] }, ana);
    expect(poll.errorType).toBe('error-poll-encrypted');
    const sched = await api('POST', 'chat.scheduleMessage', { message: { rid: room.rid, msg: 'depois' }, sendAt: new Date(Date.now() + 3600_000).toISOString() }, ana);
    expect(sched.errorType).toBe('error-schedule-encrypted');
    const m = (await sendE2e(ana, room, 'cifrada')).message;
    await save(ana, room.rid, { encrypted: false });
    const edit = await api('POST', 'chat.update', { roomId: room.rid, msgId: m._id, text: 'aberta' }, ana);
    expect([edit.status, edit.errorType]).toEqual([400, 'error-e2e-not-encrypted']);
    expect((await send(ana, room.rid, 'agora aberta')).success).toBe(true);
  });

  it('lembrete: o aviso nunca leva o conteúdo', async () => {
    const ana = await person({ name: 'Ana Souza' });
    const room = await encryptedGroup(ana);
    const m = (await sendE2e(ana, room, 'lembrar disto')).message;
    const r = await api('POST', 'reminders.set', { messageId: m._id, remindAt: new Date(Date.now() + 3600_000).toISOString() }, ana);
    expect(r.success).toBe(true);
    const row = await msgRow(m._id);
    expect(reminderPushBody(row, { encrypted: false })).toBe(`Ana Souza: ${E2E_PREVIEW}`);
    expect(reminderPushBody(row, await roomRow(room.rid))).toBe(`Ana Souza: ${E2E_PREVIEW}`);
  });

  it('exportar a sala e "Meus dados": "Mensagem criptografada", nunca o envelope', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const m = (await sendE2e(ana, room, 'exportar')).message;
    const day = 86400_000;
    const t = await api('POST', 'rooms.export', { rid: room.rid, format: 'json', dateFrom: new Date(Date.now() - day).toISOString(), dateTo: new Date(Date.now() + 60_000).toISOString() }, ana);
    expect(t.success).toBe(true);
    const json = await (await raw(t.url, ana)).text();
    expect(json).not.toContain(m.e2e.ct);
    expect(JSON.parse(json).messages.find((x: any) => x.id === m._id)).toMatchObject({ encrypted: true, msg: null, text: E2E_PREVIEW });

    const req = await api('POST', 'users.requestDataDownload', {}, ana);
    expect(req.success).toBe(true);
    await runDataExportJobs();
    const res = await raw(`/api/v1/users.dataDownloads.file?id=${encodeURIComponent(req.request._id)}`, ana);
    expect(res.status).toBe(200);
    const entries = await unzip(Buffer.from(await res.arrayBuffer()));
    const all = entries.map((e) => e.data.toString('utf8')).join('\n');
    expect(all).not.toContain(m.e2e.ct);
    const msgs = JSON.parse(entries.find((e) => e.name === 'mensagens.json')!.data.toString('utf8'));
    expect(JSON.stringify(msgs)).toContain('"criptografada":true');
  });

  it('palavras destacadas e e-mail: o servidor não lê o texto', async () => {
    const ana = await person({ name: 'Ana Souza' });
    const bruno = await person();
    await api('POST', 'users.setPreferences', { data: { highlights: ['plantão'] } }, bruno);
    const room = await encryptedGroup(ana, [bruno]);
    await sendE2e(ana, room, 'plantão hoje');
    expect((await api('GET', 'subscriptions.getOne', { roomId: room.rid }, bruno)).subscription.userMentions ?? 0).toBe(0);
    // E-mail de DM para quem está sem o chat aberto: só "Mensagem criptografada".
    await setSettings({ Email_Notifications_Enabled: true });
    try {
      const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
      await save(ana, dm, { encrypted: true });
      const dmRoom = await createKey(ana, dm);
      outbox.length = 0;
      await sendE2e(ana, dmRoom, 'segredo por e-mail');
      for (let i = 0; i < 40 && !outbox.length; i++) await sleep(50);
      const mail = outbox.find((x) => x.to === `${bruno.username}@test.local`);
      expect(mail?.text).toContain(`Ana Souza: ${E2E_PREVIEW}`);
      expect(JSON.stringify(outbox)).not.toContain('segredo');
    } finally {
      await setSettings({ Email_Notifications_Enabled: false });
    }
  });

  it('o tipo do envelope é exatamente o da web', async () => {
    const ana = await person();
    const room = await encryptedGroup(ana);
    const mid = newMessageId();
    const e: E2EEnvelope = await envelope(ana, room, mid, 'x');
    expect(Object.keys(e).sort()).toEqual(['by', 'ct', 'iv', 'kid', 'v']);
  });
});
