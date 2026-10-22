import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMOJI } from '../../web/src/lib/emoji';
import { pool } from '../src/db/pool';
import { STANDARD_EMOJI } from '../src/services/messages';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

const READER_TEXT = 'Este é um canal de avisos: só os publicadores enviam mensagens.';
let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const send = (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const save = (auth: Auth, rid: string, s: Record<string, unknown>) => api('POST', 'rooms.saveRoomSettings', { rid, ...s }, auth);
const info = async (rid: string) => (await api('GET', 'rooms.info', { roomId: rid }, A)).room;
const systemTypes = async (rid: string) => (await api('GET', 'channels.history', { roomId: rid, count: 100 }, A)).messages.filter((m: any) => m.t).map((m: any) => m.t);

async function noticeChannel(owner: Auth, members: Auth[], extra: Record<string, unknown> = {}, prefix: 'channels' | 'groups' = 'channels') {
  const r = await api('POST', `${prefix}.create`, { name: name('avisos'), members: members.map((m) => m.username), extraData: { notice: true, ...extra } }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return (prefix === 'channels' ? r.channel : r.group) as any;
}

describe('canais de avisos', () => {
  let owner: Auth;
  let mod: Auth;
  let member: Auth;
  let pub: Auth;
  beforeAll(async () => {
    [owner, mod, member, pub] = await Promise.all([newUser(A), newUser(A), newUser(A), newUser(A)]);
  });

  it('canal de avisos: somente leitura; escrevem dono, moderador, publicador e admin', async () => {
    const ch = await noticeChannel(owner, [mod, member, pub]);
    expect(ch).toMatchObject({ notice: true, ro: true, noticeAck: false, reactWhenReadOnly: false });
    await api('POST', 'channels.addModerator', { roomId: ch._id, userId: mod.userId }, owner);
    const r = await send(member, ch._id, 'posso falar?');
    expect(r.status).toBe(403);
    expect(r.error).toBe(READER_TEXT);
    expect((await send(owner, ch._id, 'aviso do dono')).status).toBe(200);
    expect((await send(mod, ch._id, 'aviso do moderador')).status).toBe(200);
    await api('POST', 'channels.join', { roomId: ch._id }, A);
    expect((await send(A, ch._id, 'aviso do admin')).status).toBe(200);
    const sub = (await api('GET', 'subscriptions.get', undefined, member)).update.find((s: any) => s.rid === ch._id);
    expect(sub.notice).toBe(true);
    const normal = (await api('GET', 'subscriptions.get', undefined, member)).update.find((s: any) => s.name === 'geral');
    expect(normal.notice).toBeUndefined();
    expect((await info(ch._id)).notice).toBe(true);
  });

  it('publicador', async () => {
    const ch = await noticeChannel(owner, [member, pub]);
    const add = await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, owner);
    expect(add.status).toBe(200);
    const sys = (await api('GET', 'channels.history', { roomId: ch._id }, owner)).messages.find((m: any) => m.t === 'subscription-role-added');
    expect(sys).toMatchObject({ msg: pub.username, role: 'publisher' });
    expect((await api('GET', 'channels.roles', { roomId: ch._id }, member)).roles.find((r: any) => r.u._id === pub.userId).roles).toEqual(['publisher']);
    expect((await send(pub, ch._id, 'aviso do publicador')).status).toBe(200);
    expect((await send(pub, ch._id, '@all atenção: reunião às 15h')).status).toBe(200);
    const ordered = await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, owner);
    expect(ordered.members.map((m: any) => m.username).slice(0, 2)).toEqual([owner.username, pub.username]);
    expect((await api('POST', 'channels.removePublisher', { roomId: ch._id, userId: pub.userId }, owner)).status).toBe(200);
    const removed = (await api('GET', 'channels.history', { roomId: ch._id }, owner)).messages.find((m: any) => m.t === 'subscription-role-removed');
    expect(removed).toMatchObject({ msg: pub.username, role: 'publisher' });
    expect((await send(pub, ch._id, 'de novo')).status).toBe(403);
    expect((await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: member.userId }, member)).status).toBe(403);

    const g = await noticeChannel(owner, [member, pub], {}, 'groups');
    expect(g).toMatchObject({ t: 'p', notice: true, ro: true });
    expect((await send(pub, g._id, 'antes')).status).toBe(403);
    expect((await api('POST', 'groups.addPublisher', { roomId: g._id, userId: pub.userId }, owner)).status).toBe(200);
    expect((await send(pub, g._id, 'aviso no grupo')).status).toBe(200);
    expect((await api('POST', 'groups.addPublisher', { roomId: g._id, userId: member.userId }, member)).status).toBe(403);
    expect((await api('POST', 'groups.removePublisher', { roomId: g._id, userId: pub.userId }, owner)).status).toBe(200);
    expect((await send(pub, g._id, 'depois')).status).toBe(403);

    // Mensagem direta não tem papel de sala.
    const dm = (await api('POST', 'im.create', { username: member.username }, A)).room._id;
    const viaRoute = await api('POST', 'channels.addPublisher', { roomId: dm, userId: member.userId }, A);
    expect(viaRoute.status).toBe(400);
    expect(viaRoute.errorType).toBe('error-not-allowed');
    // Nem pela tela de papéis (roles.addUserToRole com roomId).
    const viaRoles = await api('POST', 'roles.addUserToRole', { roleId: 'publisher', username: member.username, roomId: dm }, A);
    expect(viaRoles).toMatchObject({ status: 400, errorType: 'error-not-allowed', error: 'Mensagens diretas não têm papéis de sala.' });
    expect((await pool.query('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [dm, member.userId])).rows[0].roles).not.toContain('publisher');
  });

  it('papel global com post-readonly publica em todos os canais de avisos', async () => {
    await api('POST', 'roles.create', { name: 'avisos-publicador', scope: 'Users' }, A);
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update;
    const before = perms.find((p: any) => p._id === 'post-readonly').roles;
    await api('POST', 'permissions.update', { permissions: [{ _id: 'post-readonly', roles: [...before, 'avisos-publicador'] }] }, A);
    try {
      const gp = await newUser(A, { roles: ['user', 'avisos-publicador'] });
      const c1 = await noticeChannel(owner, [gp, member]);
      const c2 = await noticeChannel(mod, [gp, member], {}, 'groups');
      expect((await send(gp, c1._id, 'aviso geral 1')).status).toBe(200);
      expect((await send(gp, c2._id, 'aviso geral 2')).status).toBe(200);
      expect((await send(member, c1._id, 'eu também')).status).toBe(403);
    } finally {
      await api('POST', 'permissions.update', { permissions: [{ _id: 'post-readonly', roles: before }] }, A);
    }
  });

  it('reações, threads e uploads de leitores', async () => {
    const ch = await noticeChannel(owner, [member]);
    const m = await send(owner, ch._id, 'aviso importante');
    const r = await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':thumbsup:' }, member);
    expect(r.status).toBe(403);
    expect(r.error).toBe('Este canal de avisos não aceita reações.');
    expect((await save(owner, ch._id, { reactWhenReadOnly: true })).status).toBe(200);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':thumbsup:' }, member)).status).toBe(200);
    // Reação é emoji, não um recado em texto embaixo do aviso.
    const text = await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':treinamento_foi_cancelado_avisem_todos:' }, member);
    expect(text.status).toBe(400);
    expect(text.errorType).toBe('error-invalid-emoji');
    expect(text.error).toBe('Escolha um emoji da lista para reagir.');
    const custom = name('logo').replace(/-/g, '_');
    await pool.query(`INSERT INTO custom_emoji (id, name, aliases, content_type, data) VALUES ($1, $2, $3, 'image/png', $4)`, [name('emoji'), custom, [`${custom}_alt`], Buffer.from('png')]);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: `:${custom}:` }, member)).status).toBe(200);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: `:${custom}_alt:` }, member)).status).toBe(200);
    // Quem publica escreve o que quiser; o leitor pode se juntar a uma reação que já existe e tirar a sua.
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':confirmado_pela_gerencia:' }, owner)).status).toBe(200);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':confirmado_pela_gerencia:' }, member)).status).toBe(200);
    expect((await api('POST', 'chat.react', { messageId: m.message._id, emoji: ':confirmado_pela_gerencia:' }, member)).status).toBe(200);
    const reactions = (await api('GET', 'chat.getMessage', { msgId: m.message._id }, owner)).message.reactions;
    expect(Object.keys(reactions).sort()).toEqual([':confirmado_pela_gerencia:', `:${custom}:`, `:${custom}_alt:`, ':thumbsup:'].sort());
    expect(reactions[':confirmado_pela_gerencia:'].usernames).toEqual([owner.username]);
    // Em sala comum quem lê também escreve: a reação segue livre como antes.
    const plainRoom = (await api('POST', 'channels.create', { name: name('livre'), members: [member.username] }, owner)).channel._id;
    const pm = await send(owner, plainRoom, 'oi');
    expect((await api('POST', 'chat.react', { messageId: pm.message._id, emoji: ':qualquer_coisa:' }, member)).status).toBe(200);
    const reply = await send(member, ch._id, 'dúvida', { tmid: m.message._id });
    expect(reply.status).toBe(403);
    expect(reply.error).toBe(READER_TEXT);
    const fd = new FormData();
    fd.append('file', new Blob(['arquivo'], { type: 'text/plain' }), 'leitor.txt');
    const up = await api('POST', `rooms.upload/${ch._id}`, fd, member);
    expect(up.status).toBe(403);
    expect(up.error).toBe(READER_TEXT);
    // Em sala somente leitura comum o texto continua o antigo.
    const ro = await api('POST', 'channels.create', { name: name('ro'), readOnly: true, members: [member.username] }, owner);
    expect((await send(member, ro.channel._id, 'oi')).error).toBe('Esta sala é somente leitura.');
    const rm = await send(owner, ro.channel._id, 'leitura');
    expect((await api('POST', 'chat.react', { messageId: rm.message._id, emoji: ':thumbsup:' }, member)).error).toBe('Sala somente leitura.');
  });

  it('leitores não publicam criando discussão nem editando mensagens', async () => {
    const outsider = await newUser(A);
    const ch = await noticeChannel(owner, [member, pub], { noticeAck: true });
    await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, owner);
    const aviso = (await send(pub, ch._id, 'Escala de sábado: equipe A', { ackRequired: true })).message;
    expect((await api('POST', 'chat.ack', { messageId: aviso._id }, member)).message.ackCount).toBe(1);

    // Discussão: o nome dela vira mensagem na sala de origem, então vale a regra de quem envia.
    for (const who of [member, outsider]) {
      const d = await api('POST', 'rooms.createDiscussion', { prid: ch._id, pmid: aviso._id, t_name: 'ATENÇÃO TODOS: reunião cancelada', reply: 'oi' }, who);
      expect(d.status).toBe(403);
      expect(d.error).toBe(READER_TEXT);
    }
    let history = (await api('GET', 'channels.history', { roomId: ch._id, count: 100 }, owner)).messages;
    expect(history.filter((m: any) => m.t === 'discussion-created')).toHaveLength(0);
    expect(history.find((m: any) => m._id === aviso._id).drid).toBeFalsy();
    const ok = await api('POST', 'rooms.createDiscussion', { prid: ch._id, t_name: 'Dúvidas sobre a escala' }, pub);
    expect(ok.status).toBe(200);

    // Edição: quem deixou de publicar não reescreve o aviso que os outros já confirmaram.
    expect((await api('POST', 'channels.removePublisher', { roomId: ch._id, userId: pub.userId }, owner)).status).toBe(200);
    const exPub = await api('POST', 'chat.update', { roomId: ch._id, msgId: aviso._id, text: 'Escala de sábado: equipe B' }, pub);
    expect(exPub.status).toBe(403);
    expect(exPub.error).toBe(READER_TEXT);
    await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, owner);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: aviso._id, text: 'Escala de sábado: equipe A (8h)' }, pub)).status).toBe(200);

    // Mensagens antigas de leitores, de quando a sala ainda era comum.
    const plain = (await api('POST', 'channels.create', { name: name('comum'), members: [member.username] }, owner)).channel;
    const old = (await send(member, plain._id, 'mensagem antiga do leitor')).message;
    await save(owner, plain._id, { notice: true });
    const edit = await api('POST', 'chat.update', { roomId: plain._id, msgId: old._id, text: 'TEXTO NOVO DO LEITOR @all' }, member);
    expect(edit.status).toBe(403);
    expect(edit.error).toBe(READER_TEXT);
    history = (await api('GET', 'channels.history', { roomId: plain._id, count: 100 }, owner)).messages;
    expect(history.find((m: any) => m._id === old._id).msg).toBe('mensagem antiga do leitor');
    await save(owner, plain._id, { notice: false, readOnly: true });
    expect((await api('POST', 'chat.update', { roomId: plain._id, msgId: old._id, text: 'outra' }, member)).error).toBe('Esta sala é somente leitura.');
    await save(owner, plain._id, { readOnly: false });
    expect((await api('POST', 'chat.update', { roomId: plain._id, msgId: old._id, text: 'agora pode' }, member)).status).toBe(200);
  });

  it('editar', async () => {
    const ch = (await api('POST', 'channels.create', { name: name('comum'), members: [mod.username, member.username] }, owner)).channel;
    await api('POST', 'channels.addModerator', { roomId: ch._id, userId: mod.userId }, owner);
    const on = await save(owner, ch._id, { notice: true });
    expect(on.status).toBe(200);
    expect(on.room).toMatchObject({ notice: true, ro: true });
    let types = await systemTypes(ch._id);
    expect(types).toContain('room-set-notice');
    expect(types).not.toContain('room-set-read-only');
    expect((await api('GET', 'subscriptions.getOne', { roomId: ch._id }, member)).subscription.notice).toBe(true);

    const bad = await save(owner, ch._id, { readOnly: false });
    expect(bad.status).toBe(400);
    expect(bad.errorType).toBe('error-notice-readonly');
    expect(bad.error).toBe('Um canal de avisos é sempre somente leitura. Desative “Canal de avisos” para liberar a escrita.');
    expect((await api('POST', 'channels.setReadOnly', { roomId: ch._id, readOnly: false }, owner)).errorType).toBe('error-notice-readonly');
    expect((await save(owner, ch._id, { notice: true, readOnly: false })).errorType).toBe('error-notice-readonly');

    const off = await save(owner, ch._id, { notice: false });
    expect(off.room).toMatchObject({ notice: false, ro: false });
    types = await systemTypes(ch._id);
    expect(types).toContain('room-removed-notice');
    expect(types).not.toContain('room-removed-read-only');
    expect((await api('GET', 'subscriptions.getOne', { roomId: ch._id }, member)).subscription.notice).toBeUndefined();
    // Desligar o aviso mantendo a sala somente leitura.
    await save(owner, ch._id, { notice: true });
    expect((await save(owner, ch._id, { notice: false, readOnly: true })).room).toMatchObject({ notice: false, ro: true });
    await save(owner, ch._id, { readOnly: false });

    // O painel da sala reenvia o valor atual: o moderador salva sem 403.
    const current = (await info(ch._id)).reactWhenReadOnly;
    const modSave = await save(mod, ch._id, { roomTopic: 'x', reactWhenReadOnly: current, readOnly: false, notice: false });
    expect(modSave.status).toBe(200);
    expect(modSave.room.topic).toBe('x');
    expect((await save(mod, ch._id, { reactWhenReadOnly: !current })).status).toBe(403);
    expect((await save(mod, ch._id, { notice: true })).status).toBe(403);
    expect((await save(mod, ch._id, { noticeAck: true })).status).toBe(403);
    expect((await save(owner, ch._id, { noticeAck: true })).room.noticeAck).toBe(true);

    const dm = (await api('POST', 'im.create', { username: member.username }, A)).room._id;
    const inDm = await save(A, dm, { notice: true });
    expect(inDm.status).toBe(400);
    expect(inDm.errorType).toBe('error-not-allowed');
    expect(inDm.error).toBe('Só canais e grupos podem ser canais de avisos.');
  });

  it('ocultar lista de membros editável', async () => {
    const ch = await noticeChannel(owner, [mod, member]);
    await api('POST', 'channels.addModerator', { roomId: ch._id, userId: mod.userId }, owner);
    expect((await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, member)).status).toBe(200);
    expect((await save(mod, ch._id, { broadcast: true })).status).toBe(403);
    const r = await save(owner, ch._id, { broadcast: true });
    expect(r.room.broadcast).toBe(true);
    expect((await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, member)).status).toBe(403);
    expect((await api('GET', 'channels.members', { roomId: ch._id }, member)).status).toBe(403);
    expect((await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, owner)).status).toBe(200);
    expect((await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, mod)).status).toBe(200);
    // O autocomplete com rid também não diz quem está na sala.
    const inRoom = async (who: Auth, rid: string) =>
      (await api('GET', 'users.autocomplete', { term: mod.username, rid }, who)).items.find((i: any) => i.username === mod.username).inRoom;
    expect(await inRoom(member, ch._id)).toBeUndefined();
    expect(await inRoom(owner, ch._id)).toBe(true);
    expect((await save(owner, ch._id, { broadcast: false })).room.broadcast).toBe(false);
    expect((await api('GET', 'rooms.membersOrderedByRole', { roomId: ch._id }, member)).status).toBe(200);
    expect(await inRoom(member, ch._id)).toBe(true);
    // Nem de um grupo privado em que quem pergunta não está.
    const secret = (await api('POST', 'groups.create', { name: name('secreto'), members: [mod.username] }, owner)).group;
    const outsider = await newUser(A);
    expect(await inRoom(outsider, secret._id)).toBeUndefined();
    expect(await inRoom(owner, secret._id)).toBe(true);

    // A lista do time segue a da sala principal.
    const team = (await api('POST', 'teams.create', { name: name('time'), type: 0, members: [member.username, mod.username] }, owner)).team;
    const teamMembers = (who: Auth) => api('GET', 'teams.members', { teamId: team._id }, who);
    expect((await teamMembers(member)).status).toBe(200);
    expect((await save(owner, team.roomId, { notice: true, broadcast: true })).room.broadcast).toBe(true);
    expect((await teamMembers(member)).status).toBe(403);
    expect((await teamMembers(outsider)).status).toBe(403);
    expect((await teamMembers(owner)).members.map((m: any) => m.user.username).sort()).toEqual([owner.username, member.username, mod.username].sort());
    await save(owner, team.roomId, { broadcast: false });
    expect((await teamMembers(member)).total).toBe(3);
    expect((await teamMembers(outsider)).status).toBe(200);
  });

  it('recibos de leitura não mostram a quem lê o canal de avisos quem está nele nem quem confirmou', async () => {
    const [reader, hidden] = await Promise.all([newUser(A, { roles: ['operacao'] }), newUser(A)]);
    const ch = await noticeChannel(owner, [reader, hidden, pub], { noticeAck: true, broadcast: true });
    await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, owner);
    const aviso = (await send(owner, ch._id, 'Escala da semana', { ackRequired: true })).message;
    await api('POST', 'subscriptions.read', { rid: ch._id }, hidden);
    const receipts = (who: Auth, id = aviso._id) => api('GET', 'chat.getMessageReadReceipts', { messageId: id }, who);
    expect((await api('GET', 'channels.members', { roomId: ch._id }, reader)).status).toBe(403);
    const refused = await receipts(reader);
    expect(refused.status).toBe(403);
    expect(refused.error).toBe('Só quem publica neste canal vê quem leu os avisos.');
    expect((await receipts(owner)).receipts.map((r: any) => r.user.username)).toContain(hidden.username);
    expect((await receipts(pub)).status).toBe(200);
    // Sem a lista oculta vale o mesmo: as linhas do "Ciente" são as de chat.getAcks.
    await save(owner, ch._id, { broadcast: false });
    expect((await receipts(reader)).status).toBe(403);
    // Lista oculta numa sala comum: cada um vê os recibos das próprias mensagens.
    const plain = (await api('POST', 'channels.create', { name: name('comum'), members: [reader.username, hidden.username] }, owner)).channel._id;
    await save(owner, plain, { broadcast: true });
    const mine = (await send(hidden, plain, 'minha')).message;
    const theirs = (await send(owner, plain, 'do dono')).message;
    await api('POST', 'subscriptions.read', { rid: plain }, reader);
    expect((await receipts(hidden, mine._id)).receipts.map((r: any) => r.user.username)).toContain(reader.username);
    const hiddenList = await receipts(hidden, theirs._id);
    expect(hiddenList.status).toBe(403);
    expect(hiddenList.error).toBe('Neste canal a lista de membros está oculta: só donos e moderadores veem quem leu as mensagens.');
    await save(owner, plain, { broadcast: false });
    expect((await receipts(hidden, theirs._id)).status).toBe(200);

    // Recibos desligados: as únicas linhas seriam as do "Ciente".
    await api('POST', 'settings', { settings: { Message_Read_Receipt_Enabled: false } }, A);
    try {
      const av2 = (await send(owner, ch._id, 'Aviso 2', { ackRequired: true })).message;
      expect((await api('POST', 'chat.ack', { messageId: av2._id }, hidden)).status).toBe(200);
      expect((await api('GET', 'chat.getAcks', { messageId: av2._id }, reader)).status).toBe(403);
      for (const who of [reader, owner]) {
        const off = await receipts(who, av2._id);
        expect(off.status).toBe(400);
        expect(off.errorType).toBe('error-read-receipts-disabled');
        expect(off.error).toBe('A confirmação de leitura está desativada.');
      }
      expect((await api('GET', 'chat.getAcks', { messageId: av2._id }, owner)).acked.map((a: any) => a.user.username)).toEqual([hidden.username]);
    } finally {
      await api('POST', 'settings', { settings: { Message_Read_Receipt_Enabled: true } }, A);
    }
  });

  it('os emojis aceitos dos leitores são os que a web mostra', () => {
    expect([...STANDARD_EMOJI].sort()).toEqual(Object.keys(EMOJI).sort());
  });

  it('criar com reações e "Ciente"', async () => {
    const ch = await noticeChannel(owner, [member], { noticeAck: true, reactWhenReadOnly: true, broadcast: true });
    expect(ch).toMatchObject({ notice: true, ro: true, noticeAck: true, reactWhenReadOnly: true, broadcast: true });
    const plain = await api('POST', 'channels.create', { name: name('simples') }, owner);
    expect(plain.channel).toMatchObject({ notice: false, ro: false, noticeAck: false });
  });
});

describe('"Ciente" nos avisos', () => {
  let owner: Auth;
  let pub: Auth;
  let m1: Auth;
  let m2: Auth;
  let m3: Auth;
  let gone: Auth;
  let outsider: Auth;
  let rid: string;
  let notice: any; // aviso que pede "Ciente"
  let bot: string;
  beforeAll(async () => {
    [owner, pub, m1, m2, m3, gone, outsider] = await Promise.all([newUser(A), newUser(A), newUser(A), newUser(A), newUser(A), newUser(A), newUser(A)]);
    const b = await api('POST', 'users.create', { username: name('robo'), name: 'Robô', email: `${name('robo')}@test.local`, password: 'senha-forte-1', type: 'bot', roles: ['bot'] }, A);
    bot = b.user.username;
    rid = (await noticeChannel(owner, [pub, m1, m2, m3, gone, { username: bot } as Auth], { noticeAck: true }))._id;
    await api('POST', 'channels.addPublisher', { roomId: rid, userId: pub.userId }, owner);
    await api('POST', 'users.setActiveStatus', { userId: gone.userId, activeStatus: false }, A);
  });

  it('Ciente: conta uma vez; autor não confirma; quem não é membro não confirma', async () => {
    const sent = await send(pub, rid, 'Reunião geral amanhã às 10h.', { ackRequired: true });
    expect(sent.status).toBe(200);
    notice = sent.message;
    expect(notice).toMatchObject({ ackRequired: true, ackCount: 0 });
    const first = await api('POST', 'chat.ack', { messageId: notice._id }, m1);
    expect(first.status).toBe(200);
    expect(first.message.ackCount).toBe(1);
    expect(typeof first.ackAt).toBe('string');
    const again = await api('POST', 'chat.ack', { messageId: notice._id }, m1);
    expect(again.ackAt).toBe(first.ackAt);
    expect(again.message.ackCount).toBe(1);
    expect((await api('GET', 'chat.getMessage', { msgId: notice._id }, m2)).message.ackCount).toBe(1);

    const own = await api('POST', 'chat.ack', { messageId: notice._id }, pub);
    expect(own.status).toBe(400);
    expect(own.errorType).toBe('error-ack-own');
    expect(own.error).toBe('Você é o autor deste aviso.');
    const out = await api('POST', 'chat.ack', { messageId: notice._id }, outsider);
    expect(out.status).toBe(403);
    expect(out.error).toBe('Você precisa participar do canal para confirmar.');
    const plain = await send(pub, rid, 'Sem confirmação.');
    expect(plain.message.ackRequired).toBeUndefined();
    expect(plain.message.ackCount).toBeUndefined();
    const notRequired = await api('POST', 'chat.ack', { messageId: plain.message._id }, m1);
    expect(notRequired.status).toBe(400);
    expect(notRequired.errorType).toBe('error-ack-not-required');
    expect((await api('POST', 'chat.ack', { messageId: 'naoexiste123' }, m1)).status).toBe(404);
  });

  it('quem publica vê confirmados e pendentes; leitor não', async () => {
    const acked = await api('GET', 'chat.getAcks', { messageId: notice._id, status: 'acked' }, pub);
    expect(acked.status).toBe(200);
    expect(acked.acked.map((a: any) => a.user.username)).toEqual([m1.username]);
    expect(typeof acked.acked[0].ackAt).toBe('string');
    expect(acked).toMatchObject({ messageId: notice._id, ackCount: 1, total: 1, pending: [] });
    const pending = await api('GET', 'chat.getAcks', { messageId: notice._id, status: 'pending' }, pub);
    const expected = [owner, m2, m3].map((u) => u.username).sort();
    expect(pending.pending.map((u: any) => u.username)).toEqual(expected);
    expect(pending).toMatchObject({ pendingCount: 3, total: 3, acked: [] });
    expect(acked.pendingCount).toBe(3);
    const page = await api('GET', 'chat.getAcks', { messageId: notice._id, status: 'pending', count: 2, offset: 2 }, pub);
    expect(page.pending.map((u: any) => u.username)).toEqual(expected.slice(2));
    // O dono da sala também publica ali.
    expect((await api('GET', 'chat.getAcks', { messageId: notice._id, status: 'pending' }, owner)).status).toBe(200);
    const reader = await api('GET', 'chat.getAcks', { messageId: notice._id }, m2);
    expect(reader.status).toBe(403);
    expect(reader.error).toBe('Só quem publica neste canal vê as confirmações.');
    expect((await api('GET', 'chat.getAcks', { messageId: notice._id, status: 'todos' }, pub)).status).toBe(400);
  });

  it('chat.myAcks', async () => {
    const second = (await send(pub, rid, 'Novo horário do almoço.', { ackRequired: true })).message;
    const old = (await send(pub, rid, 'Aviso antigo.', { ackRequired: true })).message;
    await pool.query(`UPDATE messages SET created_at = now() - interval '31 days' WHERE id = $1`, [old._id]);
    const mine = await api('GET', 'chat.myAcks', { roomId: rid }, m1);
    expect(mine.acked).toEqual([notice._id]);
    expect(mine.pending).toEqual([second._id]);
    const other = await api('GET', 'chat.myAcks', { roomId: rid }, m2);
    expect(other.pending).toEqual([notice._id, second._id]);
    expect(other.acked).toEqual([]);
    expect((await api('GET', 'chat.myAcks', { roomId: rid }, pub)).pending).toEqual([]);
    expect((await api('GET', 'chat.myAcks', { roomId: rid }, outsider)).status).toBe(403);
  });

  it('ackRequired fora do lugar é recusado', async () => {
    const text = 'Só avisos de um canal de avisos com “Ciente” ativado podem pedir confirmação.';
    const normal = (await api('POST', 'channels.create', { name: name('normal') }, owner)).channel._id;
    const r1 = await send(owner, normal, 'oi', { ackRequired: true });
    expect(r1.status).toBe(400);
    expect(r1.errorType).toBe('error-ack-not-allowed');
    expect(r1.error).toBe(text);
    const noAck = (await noticeChannel(owner, [m1]))._id;
    expect((await send(owner, noAck, 'aviso', { ackRequired: true })).errorType).toBe('error-ack-not-allowed');
    expect((await send(pub, rid, 'na thread', { ackRequired: true, tmid: notice._id })).errorType).toBe('error-ack-not-allowed');
    // Desligar o "Ciente" na sala vale para os próximos avisos.
    await save(owner, rid, { noticeAck: false });
    expect((await send(pub, rid, 'agora não', { ackRequired: true })).errorType).toBe('error-ack-not-allowed');
    await save(owner, rid, { noticeAck: true });
  });

  it('apagar o aviso apaga as confirmações; recibos de leitura seguem', async () => {
    const x = (await send(pub, rid, 'Será apagado.', { ackRequired: true })).message;
    const y = (await send(pub, rid, 'Fica.', { ackRequired: true })).message;
    await api('POST', 'chat.ack', { messageId: x._id }, m1);
    await api('POST', 'chat.ack', { messageId: y._id }, m1);
    expect((await pool.query('SELECT 1 FROM message_reads WHERE message_id = $1', [x._id])).rowCount).toBeGreaterThan(0);
    expect((await api('POST', 'chat.delete', { msgId: x._id }, pub)).status).toBe(200);
    expect((await pool.query('SELECT 1 FROM message_reads WHERE message_id = $1', [x._id])).rowCount).toBe(0);
    const receipts = await api('GET', 'chat.getMessageReadReceipts', { messageId: y._id }, pub);
    expect(receipts.status).toBe(200);
    expect(receipts.receipts.map((r: any) => r.user.username)).toContain(m1.username);

    // Aviso com respostas na thread: fica no lugar como "mensagem removida", sem pedido nem confirmações.
    const z = (await send(pub, rid, 'Também será apagado.', { ackRequired: true })).message;
    await send(pub, rid, 'detalhe na thread', { tmid: z._id });
    await api('POST', 'chat.ack', { messageId: z._id }, m1);
    expect((await api('POST', 'chat.delete', { msgId: z._id }, pub)).status).toBe(200);
    const row = (await pool.query('SELECT t, ack_required, ack_count FROM messages WHERE id = $1', [z._id])).rows[0];
    expect(row).toEqual({ t: 'rm', ack_required: false, ack_count: 0 });
    expect((await pool.query('SELECT 1 FROM message_reads WHERE message_id = $1 AND ack_at IS NOT NULL', [z._id])).rowCount).toBe(0);
    const late = await api('POST', 'chat.ack', { messageId: z._id }, m2);
    expect(late.status).toBe(400);
    expect(late.errorType).toBe('error-ack-not-required');
    expect((await api('GET', 'chat.getAcks', { messageId: z._id }, pub)).errorType).toBe('error-ack-not-required');
    expect((await api('GET', 'chat.myAcks', { roomId: rid }, m1)).acked).not.toContain(z._id);
    expect((await api('GET', 'chat.myAcks', { roomId: rid }, m2)).pending).not.toContain(z._id);
  });

  it('eventos de contagem são agrupados', async () => {
    const z = (await send(pub, rid, 'Novo procedimento de atendimento.', { ackRequired: true })).message;
    const ws = connectWs(owner);
    await ws.ready;
    try {
      const since = ws.events.length;
      const started = Date.now();
      await Promise.all([m1, m2, m3].map((u) => api('POST', 'chat.ack', { messageId: z._id }, u)));
      expect(Date.now() - started).toBeLessThan(300);
      const updated = await ws.waitFor((e) => ws.events.indexOf(e) >= since && e.type === 'message' && e.action === 'updated' && e.message._id === z._id, 3000);
      expect(updated.message.ackCount).toBe(3);
      await sleep(2500);
      expect(ws.events.slice(since).filter((e) => e.type === 'message' && e.action === 'updated' && e.message._id === z._id)).toHaveLength(1);
    } finally {
      ws.close();
    }
  });
});
