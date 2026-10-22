import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { loadPermissions, OPERACAO_PERMISSIONS, PUBLISHER_PERMISSIONS, restrictedRoleIds } from '../src/services/permissions';
import { setSettingCache } from '../src/services/settings';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
let geral: string;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  geral = (await api('GET', 'rooms.info', { roomName: 'geral' }, A)).room._id;
});
afterAll(() => stopServer());

// Usuário com o chat aberto: WebSocket conectado e o id da conexão (usado pela sinalização).
async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  const connectionId = ws.events.find((e) => e.type === 'connected').connectionId as string;
  return { ...ws, connectionId };
}

type Ws = ReturnType<typeof connectWs>;
// Espera um evento que chegue depois deste ponto (os anteriores não contam).
function nextEvent(ws: Ws, pred: (e: any) => boolean, ms = 5000) {
  const since = ws.events.length;
  return () => ws.waitFor((e) => ws.events.indexOf(e) >= since && pred(e), ms);
}

const operador = () => newUser(A, { roles: ['operacao'] });
const send = (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const dmOf = (auth: Auth, usernames: string | string[]) =>
  api('POST', 'im.create', Array.isArray(usernames) ? { usernames: usernames.join(',') } : { username: usernames }, auth);

async function permissionRoles(id: string): Promise<string[]> {
  const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
  return perms.find((p) => p._id === id)!.roles;
}
async function grantsOf(role: string) {
  return (await pool.query('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [role])).rows.map((r) => r.id);
}
const setPermission = (id: string, roles: string[]) => api('POST', 'permissions.update', { permissions: [{ _id: id, roles }] }, A);

describe('papel operacao e migração 013', () => {
  it('o papel operacao vem semeado, restrito e só com as permissões dele', async () => {
    const roles = (await api('GET', 'roles.list', {}, A)).roles;
    expect(roles.find((r: any) => r._id === 'operacao')).toMatchObject({ scope: 'Users', protected: false, restrictDirect: true });
    expect(roles.find((r: any) => r._id === 'publisher')).toMatchObject({ scope: 'Subscriptions', restrictDirect: false });
    expect(roles.find((r: any) => r._id === 'user').restrictDirect).toBe(false);
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    expect(perms.filter((p) => p.roles.includes('operacao')).map((p) => p._id).sort()).toEqual([...OPERACAO_PERMISSIONS].sort());
    for (const id of ['post-readonly', 'mention-all', 'mention-here']) expect(perms.find((p) => p._id === id)!.roles).toContain('publisher');
    expect(perms.find((p) => p._id === 'start-dm-between-restricted')!.roles).toEqual(['admin']);
    expect(perms.find((p) => p._id === 'set-publisher')!.roles).toEqual(['admin', 'owner']);
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });

  it('a migração 013 recria o papel e as permissões num banco antigo', async () => {
    const forget013 = async () => {
      await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'operacao')`);
      await pool.query(`DELETE FROM roles WHERE id = 'operacao'`);
      await pool.query(`DELETE FROM schema_migrations WHERE name = '013_ops.sql'`);
    };
    try {
      await forget013();
      await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'publisher') WHERE id = ANY($1)`, [PUBLISHER_PERMISSIONS]);
      await migrate(() => {});
      await loadPermissions();
      expect(await grantsOf('operacao')).toEqual([...OPERACAO_PERMISSIONS].sort());
      expect(await grantsOf('publisher')).toEqual([...PUBLISHER_PERMISSIONS].sort());
      const role = (await pool.query(`SELECT * FROM roles WHERE id = 'operacao'`)).rows[0];
      expect(role).toMatchObject({ description: 'Operação', scope: 'Users', protected: false, restrict_direct: true });

      // Um papel "operacao" criado pelo administrador não é tocado: nem descrição, nem permissões.
      await forget013();
      await pool.query(`INSERT INTO roles (id, description, scope, protected, mandatory_2fa) VALUES ('operacao', 'manual', 'Users', false, false)`);
      await pool.query(`UPDATE permissions SET roles = array_append(roles, 'operacao') WHERE id = 'view-c-room'`);
      await migrate(() => {});
      expect((await pool.query(`SELECT description FROM roles WHERE id = 'operacao'`)).rows[0].description).toBe('manual');
      expect(await grantsOf('operacao')).toEqual(['view-c-room']);
    } finally {
      await forget013();
      await migrate(() => {});
      await loadPermissions();
    }
    expect(await grantsOf('operacao')).toEqual([...OPERACAO_PERMISSIONS].sort());
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });
});

describe('conversas diretas entre pessoas restritas', () => {
  let op1: Auth;
  let op2: Auth;
  let sup: Auth;
  let opx: Auth;
  let exemptDm: string;
  beforeAll(async () => {
    op1 = await operador();
    op2 = await operador();
    sup = await newUser(A);
  });

  it('operador sem o papel user não cria canal, grupo, time nem discussão; lê e entra em canal público', async () => {
    const pub = await api('POST', 'channels.create', { name: `publico-${Date.now()}` }, A);
    expect((await api('POST', 'channels.create', { name: `op-canal-${Date.now()}` }, op1)).status).toBe(403);
    expect((await api('POST', 'groups.create', { name: `op-grupo-${Date.now()}`, members: [op2.username] }, op1)).status).toBe(403);
    expect((await api('POST', 'teams.create', { name: `op-time-${Date.now()}`, type: 1, members: [op2.username] }, op1)).status).toBe(403);
    expect((await api('POST', 'rooms.createDiscussion', { prid: geral, t_name: 'Particular', users: [op2.username] }, op1)).status).toBe(403);
    const joined = await api('POST', 'channels.join', { roomId: pub.channel._id }, op1);
    expect(joined.status).toBe(200);
    await send(A, pub.channel._id, 'bom dia, equipe');
    const h = await api('GET', 'channels.history', { roomId: pub.channel._id }, op1);
    expect(h.messages.map((m: any) => m.msg)).toContain('bom dia, equipe');
    expect((await send(op1, pub.channel._id, 'bom dia')).status).toBe(200);
  });

  it('dois restritos não abrem DM; com supervisor, sim', async () => {
    const r = await dmOf(op1, op2.username);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('error-direct-restricted');
    expect(r.error).toContain(`@${op2.username}`);
    expect(r.error).toContain('Use um canal da equipe ou fale com um supervisor.');
    expect(r.details).toEqual({ action: 'start', usernames: [op1.username, op2.username] });

    const post = await api('POST', 'chat.postMessage', { channel: `@${op2.username}`, text: 'oi' }, op1);
    expect(post.status).toBe(403);
    expect(post.errorType).toBe('error-direct-restricted');
    const slash = await send(op1, geral, `/msg @${op2.username} oi`);
    expect(slash.status).toBe(403);
    expect(slash.errorType).toBe('error-direct-restricted');
    const cmd = await api('POST', 'commands.run', { roomId: geral, command: 'msg', params: `@${op2.username} oi` }, op1);
    expect(cmd.status).toBe(403);
    expect(cmd.errorType).toBe('error-direct-restricted');
    const key = [op1.userId, op2.userId].sort().join(',');
    expect((await pool.query(`SELECT 1 FROM rooms WHERE t = 'd' AND dm_key = $1`, [key])).rowCount).toBe(0);

    const withSup = await dmOf(op1, sup.username);
    expect(withSup.status).toBe(200);
    expect((await dmOf(sup, op1.username)).room._id).toBe(withSup.room._id);
    expect((await send(sup, withSup.room._id, 'pode falar')).status).toBe(200);
    expect((await send(op1, withSup.room._id, 'obrigado')).status).toBe(200);
  });

  it('DM em grupo com dois restritos é recusada mesmo aberta por supervisor', async () => {
    const other = await newUser(A);
    const r = await dmOf(sup, [op1.username, op2.username]);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('error-direct-restricted');
    expect(r.error).toBe(`Esta conversa juntaria @${op1.username} e @${op2.username}, que não podem conversar em particular. Use um grupo privado ou um canal.`);
    const ok = await dmOf(sup, [op1.username, other.username]);
    expect(ok.status).toBe(200);
    expect(ok.room.uids).toHaveLength(3);
  });

  it('quem tem a permissão abre a DM; os dois conversam; só ele liga', async () => {
    expect((await api('POST', 'roles.create', { name: 'livre', scope: 'Users' }, A)).success).toBe(true);
    await setPermission('start-dm-between-restricted', ['admin', 'livre']);
    opx = await newUser(A, { roles: ['operacao', 'livre'] });
    const dm = await dmOf(opx, op1.username);
    expect(dm.status).toBe(200);
    exemptDm = dm.room._id;
    const m = await send(op1, exemptDm, 'pode me ajudar?');
    expect(m.status).toBe(200);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':thumbsup:' }, op1)).status).toBe(200);
    expect((await dmOf(op1, opx.username)).room._id).toBe(exemptDm);
    const info = await api('GET', 'rooms.info', { roomId: exemptDm }, op1);
    expect(info.room.direct).toEqual({ canSend: true, canCall: false, callBlockedReason: `Só @${opx.username} pode iniciar chamadas com você.` });

    const [w1, wx] = await Promise.all([online(op1), online(opx)]);
    try {
      const refused = await api('POST', 'calls.start', { roomId: exemptDm, kind: 'audio', connectionId: w1.connectionId }, op1);
      expect(refused.status).toBe(403);
      expect(refused.errorType).toBe('error-direct-restricted');
      expect(refused.error).toBe(`Só @${opx.username} pode iniciar chamadas com você.`);
      const call = await api('POST', 'calls.start', { roomId: exemptDm, kind: 'audio', connectionId: wx.connectionId }, opx);
      expect(call.status).toBe(200);
      expect(call.call.status).toBe('ringing');
      expect((await api('POST', 'calls.end', { callId: call.call._id }, opx)).call.status).toBe('canceled');
    } finally {
      w1.close();
      wx.close();
    }

    const fresh = await dmOf(op2, opx.username);
    expect(fresh.status).toBe(403);
    expect(fresh.error).toBe(`Você não pode iniciar uma conversa direta com @${opx.username}. Peça para @${opx.username} iniciar a conversa.`);
  });

  it('DM antiga fica bloqueada e o histórico continua', async () => {
    const sup2 = await newUser(A);
    const dm = (await dmOf(sup2, op1.username)).room._id;
    const first = await send(sup2, dm, 'primeira');
    await send(op1, dm, 'segunda');
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: sup2.username }, A);
    await api('POST', 'roles.removeUserFromRole', { roleId: 'user', username: sup2.username }, A);
    const text = `Conversas diretas entre você e @${sup2.username} estão bloqueadas pela política da empresa. O histórico continua disponível, mas não é possível enviar mensagens.`;

    const blocked = await send(op1, dm, 'terceira');
    expect(blocked.status).toBe(403);
    expect(blocked.errorType).toBe('error-direct-restricted');
    expect(blocked.error).toBe(text);
    expect(blocked.details).toEqual({ action: 'send', usernames: [op1.username, sup2.username] });
    expect((await send(op1, dm, 'na thread', { tmid: first.message._id })).errorType).toBe('error-direct-restricted');
    expect((await send(sup2, dm, 'do outro lado')).errorType).toBe('error-direct-restricted');
    const fd = new FormData();
    fd.append('file', new Blob(['anexo'], { type: 'text/plain' }), 'anexo.txt');
    const up = await api('POST', `rooms.upload/${dm}`, fd, op1);
    expect(up.status).toBe(403);
    expect(up.errorType).toBe('error-direct-restricted');
    expect((await api('POST', 'chat.react', { messageId: first.message._id, emoji: ':thumbsup:' }, op1)).errorType).toBe('error-direct-restricted');
    const own = (await api('GET', 'im.history', { roomId: dm }, op1)).messages.find((m: any) => m.msg === 'segunda');
    expect((await api('POST', 'chat.update', { roomId: dm, msgId: own._id, text: 'editada' }, op1)).errorType).toBe('error-direct-restricted');
    // Discussão: mesmo com permissão para criar discussões, a DM bloqueada não vira sala nova.
    const before = await permissionRoles('start-discussion');
    await setPermission('start-discussion', [...before, 'operacao']);
    try {
      const d = await api('POST', 'rooms.createDiscussion', { prid: dm, t_name: 'Particular' }, op1);
      expect(d.status).toBe(403);
      expect(d.errorType).toBe('error-direct-restricted');
    } finally {
      await setPermission('start-discussion', before);
    }

    for (const path of ['im.history', 'rooms.history']) {
      const h = await api('GET', path, { roomId: dm }, op1);
      expect(h.status).toBe(200);
      expect(h.messages.map((m: any) => m.msg).sort()).toEqual(['primeira', 'segunda']);
    }
    expect((await api('POST', 'chat.starMessage', { messageId: first.message._id }, op1)).status).toBe(200);
    expect((await api('GET', 'chat.search', { roomId: dm, searchText: 'primeira' }, op1)).messages).toHaveLength(1);
    const info = await api('GET', 'rooms.info', { roomId: dm }, op1);
    expect(info.room.direct).toEqual({
      canSend: false,
      canCall: false,
      sendBlockedReason: text,
      callBlockedReason: `Você não pode ligar para @${sup2.username}: chamadas entre vocês estão bloqueadas pela política da empresa.`,
    });
    expect((await dmOf(op1, sup2.username)).room._id).toBe(dm);

    await api('POST', 'roles.addUserToRole', { roleId: 'user', username: sup2.username }, A);
    await api('POST', 'roles.removeUserFromRole', { roleId: 'operacao', username: sup2.username }, A);
    expect((await send(op1, dm, 'voltou')).status).toBe(200);
    expect((await api('GET', 'rooms.info', { roomId: dm }, op1)).room.direct).toEqual({ canSend: true, canCall: true });
  });

  it('discussão criada numa DM segue a DM depois do bloqueio', async () => {
    const [a, b] = await Promise.all([newUser(A), newUser(A)]);
    const dm = (await dmOf(a, b.username)).room._id;
    const disc = await api('POST', 'rooms.createDiscussion', { prid: dm, t_name: 'nosso papo', users: [sup.username] }, a);
    expect(disc.status).toBe(200);
    const rid = disc.discussion._id;
    const first = await send(b, rid, 'antes da regra');
    expect(first.status).toBe(200);
    expect((await api('GET', 'rooms.info', { roomId: rid }, a)).room.direct).toEqual({ canSend: true, canCall: true });
    // Implantação: os dois passam a ser só operação.
    for (const u of [a, b]) expect((await api('POST', 'users.update', { userId: u.userId, data: { roles: ['operacao'] } }, A)).status).toBe(200);
    try {
      for (const u of [a, b]) {
        const r = await send(u, rid, 'continuamos aqui em particular');
        expect(r.status).toBe(403);
        expect(r.errorType).toBe('error-direct-restricted');
      }
      const fd = new FormData();
      fd.append('file', new Blob(['anexo'], { type: 'text/plain' }), 'anexo.txt');
      expect((await api('POST', `rooms.upload/${rid}`, fd, a)).errorType).toBe('error-direct-restricted');
      expect((await api('POST', 'chat.react', { messageId: first.message._id, emoji: ':thumbsup:' }, a)).errorType).toBe('error-direct-restricted');
      expect((await api('POST', 'chat.update', { roomId: rid, msgId: first.message._id, text: 'editada' }, b)).errorType).toBe('error-direct-restricted');
      const info = (await api('GET', 'rooms.info', { roomId: rid }, a)).room;
      expect(info.direct.canSend).toBe(false);
      expect(info.direct.sendBlockedReason).toBe(
        `Conversas diretas entre você e @${b.username} estão bloqueadas pela política da empresa. O histórico continua disponível, mas não é possível enviar mensagens.`,
      );
      expect((await api('GET', 'groups.history', { roomId: rid }, a)).messages.map((m: any) => m.msg)).toContain('antes da regra');
      // Quem não participa da DM (o supervisor convidado) não é afetado.
      expect((await send(sup, rid, 'aviso do supervisor')).status).toBe(200);
      expect((await api('GET', 'rooms.info', { roomId: rid }, sup)).room.direct).toBeUndefined();
    } finally {
      for (const u of [a, b]) await api('POST', 'users.update', { userId: u.userId, data: { roles: ['user'] } }, A);
    }
    expect((await send(a, rid, 'voltou')).status).toBe(200);

    // Grupo de um supervisor com operadores, criado como discussão da DM dele: tem dono, como um grupo privado.
    const supDm = (await dmOf(sup, op1.username)).room._id;
    const supDisc = await api('POST', 'rooms.createDiscussion', { prid: supDm, t_name: 'escala', users: [op2.username] }, sup);
    expect(supDisc.status).toBe(200);
    expect((await send(op1, supDisc.discussion._id, 'ok')).status).toBe(200);
    expect((await send(op2, supDisc.discussion._id, 'ok')).status).toBe(200);
  });

  it('isento desativado não mantém aberta a DM em grupo dos outros', async () => {
    const holder = await newUser(A, { roles: ['operacao', 'livre'] });
    const [o1, o2] = await Promise.all([operador(), operador()]);
    const dm = await dmOf(holder, [o1.username, o2.username]);
    expect(dm.status).toBe(200);
    expect((await send(o1, dm.room._id, 'pode me ajudar?')).status).toBe(200);
    const blockedBefore = (await api('GET', 'directRestriction.report', {}, A)).report.blockedDirects;
    expect((await api('POST', 'users.setActiveStatus', { userId: holder.userId, activeStatus: false }, A)).status).toBe(200);
    try {
      const r = await send(o1, dm.room._id, 'seguimos só nós dois');
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('error-direct-restricted');
      expect((await send(o2, dm.room._id, 'ninguém mais lê')).errorType).toBe('error-direct-restricted');
      expect((await api('GET', 'rooms.info', { roomId: dm.room._id }, o1)).room.direct.canSend).toBe(false);
      expect((await api('GET', 'directRestriction.report', {}, A)).report.blockedDirects).toBe(blockedBefore + 1);
    } finally {
      await api('POST', 'users.setActiveStatus', { userId: holder.userId, activeStatus: true }, A);
    }
    expect((await send(o1, dm.room._id, 'voltou')).status).toBe(200);
  });

  it('ninguém entra numa DM que já existe', async () => {
    const dm = (await dmOf(sup, op1.username)).room._id;
    const add = await api('POST', 'rooms.adminRooms.addUser', { roomId: dm, userId: op2.userId }, A);
    expect(add.status).toBe(400);
    expect(add.errorType).toBe('error-not-allowed');
    expect((await api('GET', 'im.history', { roomId: dm }, op2)).status).toBe(403);
    expect((await api('POST', 'findOrCreateInvite', { rid: dm, days: 1, maxUses: 0 }, A)).errorType).toBe('error-not-allowed');
    // Convite antigo para a DM (criado antes desta regra) também não serve.
    await pool.query(`INSERT INTO invites (id, room_id, user_id, days, max_uses) VALUES ('convitedmantigo1', $1, $2, 0, 0)`, [dm, A.userId]);
    expect((await api('POST', 'useInviteToken', { token: 'convitedmantigo1' }, op2)).errorType).toBe('error-not-allowed');
    expect((await pool.query('SELECT uids FROM rooms WHERE id = $1', [dm])).rows[0].uids.sort()).toEqual([sup.userId, op1.userId].sort());
    const subOf = (uid: string) => pool.query('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [dm, uid]);
    expect((await subOf(op2.userId)).rowCount).toBe(0);
    // Um participante sem a inscrição (apagada) volta a entrar ao abrir a conversa.
    await pool.query('DELETE FROM subscriptions WHERE room_id = $1 AND user_id = $2', [dm, op1.userId]);
    await pool.query('UPDATE rooms SET users_count = users_count - 1 WHERE id = $1', [dm]);
    expect((await dmOf(op1, sup.username)).room._id).toBe(dm);
    expect((await subOf(op1.userId)).rowCount).toBe(1);
  });

  it('restrito não traz outro restrito para sala privada (convite, link, discussão, time)', async () => {
    const [op3, op4] = await Promise.all([operador(), operador()]);
    const membersOf = async (rid: string) => (await pool.query('SELECT user_id FROM subscriptions WHERE room_id = $1', [rid])).rows.map((r) => r.user_id);
    const addText = (u: Auth) =>
      `Você não pode adicionar @${u.username} a uma sala privada: conversas particulares entre vocês estão bloqueadas pela política da empresa. Peça a um supervisor para adicionar.`;

    // Discussão de uma DM: o criador é dono dela e, já como operador, tenta trazer outros dois operadores.
    const [a, b] = await Promise.all([newUser(A), newUser(A)]);
    const dm = (await dmOf(a, b.username)).room._id;
    const disc = (await api('POST', 'rooms.createDiscussion', { prid: dm, t_name: 'papo' }, a)).discussion._id;
    const g = (await api('POST', 'groups.create', { name: `grupo-antigo-${Date.now()}`, members: [b.username] }, a)).group._id;
    const pub = (await api('POST', 'channels.create', { name: `canal-antigo-${Date.now()}` }, a)).channel._id;
    const team = (await api('POST', 'teams.create', { name: `time-antigo-${Date.now()}`, type: 1 }, a)).team;
    for (const u of [a, b]) expect((await api('POST', 'users.update', { userId: u.userId, data: { roles: ['operacao'] } }, A)).status).toBe(200);
    try {
      const inv = await api('POST', 'groups.invite', { roomId: disc, userIds: [op3.userId, op4.userId] }, a);
      expect(inv.status).toBe(403);
      expect(inv.errorType).toBe('error-direct-restricted');
      expect(inv.error).toBe(addText(op3));
      expect(inv.details.usernames).toEqual([a.username, op3.username]);
      expect((await api('POST', 'chat.sendMessage', { message: { rid: g, msg: `/invite @${op3.username}` } }, a)).errorType).toBe('error-direct-restricted');
      const before = (await membersOf(disc)).sort();
      expect(before).toEqual([a.userId, b.userId].sort());
      expect((await membersOf(g)).sort()).toEqual([a.userId, b.userId].sort());

      // Link de convite: quem traz é quem criou o link; um supervisor entra por ele, um operador não.
      const link = await api('POST', 'findOrCreateInvite', { rid: disc, days: 1, maxUses: 0 }, a);
      expect(link.status).toBe(200);
      const use = await api('POST', 'useInviteToken', { token: link._id }, op3);
      expect(use.status).toBe(403);
      expect(use.errorType).toBe('error-direct-restricted');
      expect(use.error).toBe(
        `Este convite foi criado por @${a.username}, e conversas particulares entre vocês estão bloqueadas pela política da empresa. Peça um convite a um supervisor.`,
      );
      expect(await membersOf(disc)).not.toContain(op3.userId);
      expect((await api('POST', 'useInviteToken', { token: link._id }, sup)).status).toBe(200);

      // Dono de um grupo antigo: discussão com operadores (o dono tem start-discussion-other-user) não chega a nascer.
      const d2 = await api('POST', 'rooms.createDiscussion', { prid: g, t_name: 'só nós', users: [op3.username] }, a);
      expect(d2.status).toBe(403);
      expect(d2.error).toBe(addText(op3));
      expect((await pool.query('SELECT 1 FROM rooms WHERE prid = $1', [g])).rowCount).toBe(0);
      // Time privado antigo: nem membro novo, nem sala padrão que puxa os membros.
      const tm = await api('POST', 'teams.addMembers', { teamId: team._id, members: [{ userId: op3.userId }] }, a);
      expect(tm.status).toBe(403);
      expect(tm.error).toBe(addText(op3));
      expect(await membersOf(team.roomId)).toEqual([a.userId]);

      // Trazer quem não é restrito continua valendo, e canal público fica de fora (todos leem e entram sozinhos).
      expect((await api('POST', 'groups.invite', { roomId: g, userId: sup.userId }, a)).status).toBe(200);
      expect((await api('POST', 'channels.invite', { roomId: pub, userIds: [op3.userId, op4.userId] }, a)).status).toBe(200);
    } finally {
      for (const u of [a, b]) await api('POST', 'users.update', { userId: u.userId, data: { roles: ['user'] } }, A);
    }

    // Quem cria a sala já com os membros também passa pela regra, antes de a sala existir.
    const both = await newUser(A, { roles: ['operacao', 'user'] });
    const gname = `grupo-novo-${Date.now()}`;
    const created = await api('POST', 'groups.create', { name: gname, members: [op3.username] }, both);
    expect(created.status).toBe(403);
    expect(created.error).toBe(addText(op3));
    expect((await pool.query('SELECT 1 FROM rooms WHERE name = $1', [gname])).rowCount).toBe(0);
    const tname = `time-novo-${Date.now()}`;
    expect((await api('POST', 'teams.create', { name: tname, type: 1, members: [op3.username] }, both)).errorType).toBe('error-direct-restricted');
    expect((await pool.query('SELECT 1 FROM teams WHERE name = $1', [tname])).rowCount).toBe(0);
    // Nem tornar privado um canal público em que operadores entraram sozinhos.
    const open = (await api('POST', 'channels.create', { name: `aberto-${Date.now()}` }, both)).channel._id;
    expect((await api('POST', 'channels.join', { roomId: open }, op3)).status).toBe(200);
    const closed = await api('POST', 'channels.setType', { roomId: open, type: 'p' }, both);
    expect(closed.status).toBe(403);
    expect(closed.error).toBe(`Você não pode tornar esta sala privada: conversas particulares entre você e @${op3.username} estão bloqueadas pela política da empresa.`);
    expect((await pool.query('SELECT t FROM rooms WHERE id = $1', [open])).rows[0].t).toBe('c');
    expect((await api('POST', 'channels.setType', { roomId: open, type: 'p' }, A)).status).toBe(200);
    // Sala padrão do time: marcar puxa todos os membros do time para ela.
    const pubTeam = (await api('POST', 'teams.create', { name: `time-aberto-${Date.now()}`, type: 0 }, both)).team;
    expect((await api('POST', 'teams.addMembers', { teamId: pubTeam._id, members: [{ userId: op3.userId }] }, both)).status).toBe(200);
    const priv = (await api('POST', 'teams.createRoom', { teamId: pubTeam._id, name: `sala-fechada-${Date.now()}`, type: 'p' }, A)).room._id;
    const mark = await api('POST', 'teams.updateRoom', { roomId: priv, isDefault: true }, both);
    expect(mark.status).toBe(403);
    expect(mark.error).toBe(addText(op3));
    expect(await membersOf(priv)).not.toContain(op3.userId);
    expect((await api('POST', 'teams.updateRoom', { roomId: priv, isDefault: true }, A)).status).toBe(200);
    expect(await membersOf(priv)).toContain(op3.userId);
    const op5 = await operador();
    expect((await api('POST', 'teams.addMembers', { teamId: pubTeam._id, members: [{ userId: op5.userId }] }, both)).error).toBe(addText(op5));
    expect(await membersOf(pubTeam.roomId)).not.toContain(op5.userId);

    // Supervisor e quem tem a permissão de exceção trazem operadores normalmente.
    const supGroup = (await api('POST', 'groups.create', { name: `escala-${Date.now()}`, members: [op3.username, op4.username] }, sup)).group._id;
    expect((await membersOf(supGroup)).length).toBe(3);
    const lead = await newUser(A, { roles: ['operacao', 'livre', 'user'] });
    expect((await api('POST', 'groups.create', { name: `lider-${Date.now()}`, members: [op3.username, op4.username] }, lead)).status).toBe(200);
  });

  it('escopo same_role', async () => {
    for (const name of ['opA', 'opB']) expect((await api('POST', 'roles.create', { name, scope: 'Users', restrictDirect: true }, A)).role.restrictDirect).toBe(true);
    const a = await newUser(A, { roles: ['user', 'opA'] });
    const a2 = await newUser(A, { roles: ['user', 'opA'] });
    const b = await newUser(A, { roles: ['user', 'opB'] });
    setSettingCache('Direct_Restriction_Scope', 'same_role');
    try {
      expect((await dmOf(a, b.username)).status).toBe(200);
      const same = await dmOf(a, a2.username);
      expect(same.status).toBe(403);
      expect(same.details.usernames).toEqual([a.username, a2.username]);
      // Com escopo same_role, papéis restritos diferentes não formam par.
      expect((await dmOf(a, op1.username)).status).toBe(200);
      // Sala privada: a traz b (outro papel), mas não outro opB, que formaria par com b, que já está lá.
      const g = await api('POST', 'groups.create', { name: `same-role-${Date.now()}`, members: [b.username] }, a);
      expect(g.status).toBe(200);
      const b2 = await newUser(A, { roles: ['opB'] });
      const inv = await api('POST', 'groups.invite', { roomId: g.group._id, userId: b2.userId }, a);
      expect(inv.status).toBe(403);
      expect(inv.error).toBe(
        `Você não pode adicionar @${b2.username} a esta sala privada: @${b2.username} e @${b.username} não podem conversar em particular. Peça a um supervisor para adicionar.`,
      );
      expect((await api('POST', 'groups.invite', { roomId: g.group._id, userId: a2.userId }, a)).details.usernames).toEqual([a.username, a2.username]);
      expect((await api('POST', 'groups.invite', { roomId: g.group._id, userId: op1.userId }, a)).status).toBe(200);
    } finally {
      setSettingCache('Direct_Restriction_Scope', 'any');
    }
    expect((await dmOf(a2, b.username)).status).toBe(403);
    for (const name of ['opA', 'opB']) await api('POST', 'roles.update', { roleId: name, restrictDirect: false }, A);
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });

  it('roles.create/update aceitam restrictDirect; papel de sala não', async () => {
    const bad = await api('POST', 'roles.create', { name: 'sala-restrita', scope: 'Subscriptions', restrictDirect: true }, A);
    expect(bad.status).toBe(400);
    expect(bad.errorType).toBe('error-invalid-params');
    expect(bad.error).toBe('Só papéis globais podem ser restritos em conversas diretas.');
    expect((await api('POST', 'roles.update', { roleId: 'moderator', restrictDirect: true }, A)).status).toBe(400);

    const ws = connectWs(A);
    await ws.ready;
    try {
      await api('POST', 'roles.create', { name: 'temporario', scope: 'Users' }, A);
      const changed = nextEvent(ws, (e) => e.type === 'permissions.changed');
      const up = await api('POST', 'roles.update', { roleId: 'temporario', restrictDirect: true }, A);
      expect(up.role.restrictDirect).toBe(true);
      await changed();
      expect((await api('GET', 'roles.list', {}, A)).roles.find((r: any) => r._id === 'temporario').restrictDirect).toBe(true);
      expect(restrictedRoleIds().sort()).toEqual(['operacao', 'temporario']);
      // Papel protegido também pode ser marcado (e desmarcado).
      expect((await api('POST', 'roles.update', { roleId: 'guest', restrictDirect: true }, A)).role.restrictDirect).toBe(true);
      expect((await api('POST', 'roles.update', { roleId: 'guest', restrictDirect: false }, A)).role.restrictDirect).toBe(false);
      await api('POST', 'roles.update', { roleId: 'temporario', restrictDirect: false }, A);
      expect((await api('GET', 'roles.list', {}, A)).roles.find((r: any) => r._id === 'temporario').restrictDirect).toBe(false);
      const log = await pool.query(`SELECT target, data FROM audit_log WHERE action = 'role.updated' ORDER BY created_at DESC LIMIT 1`);
      expect(log.rows[0]).toEqual({ target: { role: 'temporario' }, data: { fields: ['roleId', 'restrictDirect'] } });
    } finally {
      ws.close();
    }
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });

  it('troca de papel avisa o usuário em tempo real', async () => {
    const u = await newUser(A);
    const ws = connectWs(u);
    await ws.ready;
    try {
      const added = nextEvent(ws, (e) => e.type === 'user' && e.user._id === u.userId && e.user.roles?.includes('auditor'));
      await api('POST', 'roles.addUserToRole', { roleId: 'auditor', username: u.username }, A);
      expect((await added()).user).toEqual({ _id: u.userId, username: u.username, roles: ['user', 'auditor'] });
      expect((await api('GET', 'me', undefined, u)).permissions).toContain('can-audit');
      const removed = nextEvent(ws, (e) => e.type === 'user' && e.user._id === u.userId && e.user.roles && !e.user.roles.includes('auditor'));
      await api('POST', 'roles.removeUserFromRole', { roleId: 'auditor', username: u.username }, A);
      expect((await removed()).user.roles).toEqual(['user']);
      expect((await api('GET', 'me', undefined, u)).permissions).not.toContain('can-audit');

      // Papel de sala: a assinatura é atualizada.
      const ch = await api('POST', 'channels.create', { name: `papel-sala-${Date.now()}`, members: [u.username] }, A);
      const sub = nextEvent(ws, (e) => e.type === 'subscription' && e.subscription.rid === ch.channel._id && e.subscription.roles.includes('publisher'));
      await api('POST', 'roles.addUserToRole', { roleId: 'publisher', username: u.username, roomId: ch.channel._id }, A);
      await sub();
      const subGone = nextEvent(ws, (e) => e.type === 'subscription' && e.subscription.rid === ch.channel._id && !e.subscription.roles.includes('publisher'));
      await api('POST', 'roles.removeUserFromRole', { roleId: 'publisher', username: u.username, roomId: ch.channel._id }, A);
      await subGone();
    } finally {
      ws.close();
    }
  });

  it('autocomplete, diretório e calls.list trazem o que a web precisa', async () => {
    const auto = await api('GET', 'users.autocomplete', { term: op1.username }, sup);
    expect(auto.items.find((i: any) => i.username === op1.username).roles).toEqual(['operacao']);
    const dir = await api('GET', 'directory', { type: 'users', text: op1.username }, sup);
    expect(dir.result.find((i: any) => i.username === op1.username).roles).toEqual(['operacao']);

    // op1 recebeu uma chamada de opx (que tem a permissão): opx liga de novo, op1 não.
    const mine = (await api('GET', 'calls.list', {}, op1)).calls.find((c: any) => c.rid === exemptDm);
    expect(mine).toMatchObject({ canCall: false, callBlockedReason: `Só @${opx.username} pode iniciar chamadas com você.` });
    const theirs = (await api('GET', 'calls.list', {}, opx)).calls.find((c: any) => c.rid === exemptDm);
    expect(theirs.canCall).toBe(true);
    expect(theirs.callBlockedReason).toBeUndefined();

    // Chamada com o supervisor: liberada para os dois lados.
    const dm = (await dmOf(sup, op1.username)).room._id;
    const [ws, w1] = await Promise.all([online(sup), online(op1)]);
    try {
      const call = await api('POST', 'calls.start', { roomId: dm, kind: 'video', connectionId: w1.connectionId }, op1);
      expect(call.call.status).toBe('ringing');
      await api('POST', 'calls.end', { callId: call.call._id }, op1);
    } finally {
      ws.close();
      w1.close();
    }
    expect((await api('GET', 'calls.list', {}, op1)).calls.find((c: any) => c.rid === dm)).toMatchObject({ canCall: true });
  });

  it('relatório aponta brechas e DMs bloqueadas', async () => {
    const mixed = await newUser(A);
    expect((await dmOf(mixed, op2.username)).status).toBe(200);
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: mixed.username }, A);
    const r = await api('GET', 'directRestriction.report', {}, A);
    expect(r.status).toBe(200);
    const report = r.report;
    expect(report.scope).toBe('any');
    expect(report.exemptRoles.sort()).toEqual(['admin', 'livre']);
    const op = report.restrictedRoles.find((x: any) => x._id === 'operacao');
    expect(op).toMatchObject({ description: 'Operação' });
    expect(op.users).toBeGreaterThanOrEqual(4);
    for (const permission of ['create-p', 'create-team', 'start-discussion']) {
      const l = report.loopholes.find((x: any) => x.permission === permission);
      expect(l, permission).toBeTruthy();
      expect(l.viaRoles).toContain('user');
      expect(l.users).toBeGreaterThanOrEqual(1);
      expect(l.sample.map((s: any) => s.username)).toContain(mixed.username);
    }
    expect(report.loopholes.every((l: any) => !l.sample.some((s: any) => s.username === op1.username))).toBe(true);
    expect(report.blockedDirects).toBeGreaterThanOrEqual(1);
    expect((await api('GET', 'directRestriction.report', {}, op1)).status).toBe(403);
    expect((await api('GET', 'directRestriction.report', {}, sup)).status).toBe(403);
  });

  it('sem papéis restritos nada muda', async () => {
    await api('POST', 'roles.update', { roleId: 'operacao', restrictDirect: false }, A);
    try {
      expect(restrictedRoleIds()).toEqual([]);
      const dm = await dmOf(op1, op2.username);
      expect(dm.status).toBe(200);
      expect((await api('GET', 'rooms.info', { roomId: dm.room._id }, op1)).room.direct).toEqual({ canSend: true, canCall: true });
      const [w1, w2] = await Promise.all([online(op1), online(op2)]);
      try {
        const call = await api('POST', 'calls.start', { roomId: dm.room._id, kind: 'audio', connectionId: w1.connectionId }, op1);
        expect(call.call.status).toBe('ringing');
        await api('POST', 'calls.end', { callId: call.call._id }, op1);
      } finally {
        w1.close();
        w2.close();
      }
      const report = (await api('GET', 'directRestriction.report', {}, A)).report;
      expect(report).toMatchObject({ restrictedRoles: [], loopholes: [], blockedDirects: 0 });
    } finally {
      await api('POST', 'roles.update', { roleId: 'operacao', restrictDirect: true }, A);
      await setPermission('start-dm-between-restricted', ['admin']);
    }
    expect(restrictedRoleIds()).toEqual(['operacao']);
  });
});
