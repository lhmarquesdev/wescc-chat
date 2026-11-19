import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(stopServer);

const send = async (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const membersOf = async (rid: string) => (await api('GET', 'channels.members', { roomId: rid }, A)).members.map((m: any) => m.username).sort();

describe('comandos que apontam para outra sala', () => {
  it('/invite-all-from de um grupo privado de que a pessoa não participa responde como sala que não existe', async () => {
    const [alice, bruno, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const secret = (await api('POST', 'groups.create', { name: `sigilo-${uniq()}`, members: [bruno.username, carla.username] }, A)).group;
    const mine = (await api('POST', 'channels.create', { name: `da-alice-${uniq()}` }, alice)).channel;
    const r = await send(alice, mine._id, `/invite-all-from #${secret.name}`);
    expect(r.status).toBe(400);
    expect(r.error).toBe(`Sala #${secret.name} não encontrada.`);
    expect(await membersOf(mine._id)).toEqual([alice.username]);
    // O mesmo texto de uma sala que não existe, também nos outros comandos com #sala.
    for (const cmd of [`/archive #${secret.name}`, `/invite-all-to #${secret.name}`, `/join #${secret.name}`]) {
      const x = await send(alice, mine._id, cmd);
      expect([cmd, x.status, x.error]).toEqual([cmd, 400, `Sala #${secret.name} não encontrada.`]);
    }
    // Quem participa do grupo copia os membros; a administração de salas também.
    await api('POST', 'groups.invite', { roomId: secret._id, userId: alice.userId }, A);
    expect((await send(alice, mine._id, `/invite-all-from #${secret.name}`)).status).toBe(200);
    expect(await membersOf(mine._id)).toEqual([A.username, alice.username, bruno.username, carla.username].sort());
  });

  it('não copia os membros de uma sala com a lista de membros oculta', async () => {
    const [alice, bruno] = [await newUser(A), await newUser(A)];
    const hidden = (await api('POST', 'channels.create', { name: `oculta-${uniq()}`, members: [alice.username, bruno.username], extraData: { broadcast: true } }, A)).channel;
    const mine = (await api('POST', 'channels.create', { name: `copia-${uniq()}` }, alice)).channel;
    const r = await send(alice, mine._id, `/invite-all-from #${hidden.name}`);
    expect(r.status).toBe(403);
    expect(await membersOf(mine._id)).toEqual([alice.username]);
  });
});

describe('quem saiu da sala', () => {
  it('removido de um grupo privado não edita nem apaga as próprias mensagens nele', async () => {
    const [alice, bruno] = [await newUser(A), await newUser(A)];
    const g = (await api('POST', 'groups.create', { name: `grupo-${uniq()}`, members: [alice.username, bruno.username] }, A)).group;
    const m = (await send(alice, g._id, 'texto original')).message;
    await api('POST', 'groups.kick', { roomId: g._id, userId: alice.userId }, A);
    const upd = await api('POST', 'chat.update', { roomId: g._id, msgId: m._id, text: 'trocado depois de sair' }, alice);
    expect([upd.status, upd.error]).toEqual([403, 'Você não tem acesso a esta sala.']);
    const del = await api('POST', 'chat.delete', { roomId: g._id, msgId: m._id }, alice);
    expect([del.status, del.error]).toEqual([403, 'Você não tem acesso a esta sala.']);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, bruno)).message.msg).toBe('texto original');
    // O administrador continua podendo editar e apagar.
    expect((await api('POST', 'chat.update', { roomId: g._id, msgId: m._id, text: 'corrigido pela administração' }, A)).status).toBe(200);
    expect((await api('POST', 'chat.delete', { roomId: g._id, msgId: m._id }, A)).status).toBe(200);
  });

  it('quem saiu de um canal público entra de novo para editar (editar é publicar)', async () => {
    const alice = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `publico-${uniq()}`, members: [alice.username] }, A)).channel;
    const m = (await send(alice, ch._id, 'mensagem do canal')).message;
    await api('POST', 'channels.leave', { roomId: ch._id }, alice);
    const upd = await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'outra coisa' }, alice);
    expect([upd.status, upd.error]).toEqual([403, 'Você precisa entrar na sala para editar mensagens.']);
    await api('POST', 'channels.join', { roomId: ch._id }, alice);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'outra coisa' }, alice)).message.msg).toBe('outra coisa');
  });
});

describe('versões anteriores de uma mensagem editada', () => {
  it('só quem escreveu e quem modera a sala veem; apagar a mensagem leva as versões', async () => {
    const [bruno, carla, owner, outsider] = [await newUser(A), await newUser(A), await newUser(A), await newUser(A)];
    const ch = (await api('POST', 'channels.create', { name: `versoes-${uniq()}`, members: [bruno.username, carla.username, owner.username] }, A)).channel;
    await api('POST', 'channels.addOwner', { roomId: ch._id, userId: owner.userId }, A);
    const m = (await send(bruno, ch._id, 'acesso VPN: senha Bru#2026')).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'acesso VPN: peça a senha ao suporte' }, bruno);
    for (const who of [carla, outsider]) {
      const r = await api('GET', 'chat.getMessageHistory', { msgId: m._id }, who);
      expect([r.status, r.history]).toEqual([403, undefined]);
    }
    for (const who of [bruno, owner, A]) {
      const r = await api('GET', 'chat.getMessageHistory', { msgId: m._id }, who);
      expect(r.history.map((h: any) => h.msg)).toEqual(['acesso VPN: senha Bru#2026']);
    }
    await api('POST', 'chat.delete', { roomId: ch._id, msgId: m._id }, bruno);
    expect((await pool.query('SELECT count(*)::int AS n FROM message_history WHERE message_id = $1', [m._id])).rows[0].n).toBe(0);
  });

  it('raiz de tópico apagada (o lugar fica como "mensagem removida") também perde as versões', async () => {
    const ch = (await api('POST', 'channels.create', { name: `raiz-${uniq()}` }, A)).channel;
    const root = (await send(A, ch._id, 'raiz com segredo')).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: root._id, text: 'raiz sem segredo' }, A);
    await send(A, ch._id, 'resposta', { tmid: root._id });
    await api('POST', 'chat.delete', { roomId: ch._id, msgId: root._id }, A);
    expect((await api('GET', 'chat.getMessage', { msgId: root._id }, A)).message.t).toBe('rm');
    expect((await pool.query('SELECT count(*)::int AS n FROM message_history WHERE message_id = $1', [root._id])).rows[0].n).toBe(0);
  });
});

describe('cópias do texto (fixação e citações)', () => {
  const pinNoteOf = async (rid: string, mid: string) => (await api('GET', 'channels.history', { roomId: rid, count: 50 }, A)).messages.find((x: any) => x.t === 'message_pinned' && x.pinnedMessageId === mid);

  it('apagar a original tira o texto da nota de fixação e das citações, em qualquer sala', async () => {
    const ch = (await api('POST', 'channels.create', { name: `copias-${uniq()}` }, A)).channel;
    const other = (await api('POST', 'channels.create', { name: `outra-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'A senha do wifi é Segredo#2026')).message;
    await api('POST', 'chat.pinMessage', { messageId: m._id }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0].text).toBe('A senha do wifi é Segredo#2026');
    const q1 = (await send(A, ch._id, 'citando aqui', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    const q2 = (await send(A, other._id, 'citando em outra sala', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    expect(q2.attachments[0].text).toBe('A senha do wifi é Segredo#2026');

    await api('POST', 'chat.delete', { roomId: ch._id, msgId: m._id }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0]).toMatchObject({ text: 'Mensagem removida', removed: true });
    for (const q of [q1, q2]) {
      const got = (await api('GET', 'chat.getMessage', { msgId: q._id }, A)).message;
      expect(got.attachments[0]).toMatchObject({ text: 'Mensagem removida', removed: true, message_link: `?msg=${m._id}` });
      expect(got.msg).toBe(q.msg);
    }
  });

  it('editar a original atualiza a nota de fixação e as citações', async () => {
    const ch = (await api('POST', 'channels.create', { name: `edita-copia-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'meu CPF é 123.456.789-00')).message;
    await api('POST', 'chat.pinMessage', { messageId: m._id }, A);
    const q = (await send(A, ch._id, 'citação', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'meu CPF está no cadastro' }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0].text).toBe('meu CPF está no cadastro');
    expect((await api('GET', 'chat.getMessage', { msgId: q._id }, A)).message.attachments[0].text).toBe('meu CPF está no cadastro');
  });
});

describe('envio repetido', () => {
  it('o mesmo _id da mesma pessoa volta a mensagem que já existe, sem cópia', async () => {
    const ch = (await api('POST', 'channels.create', { name: `duplo-${uniq()}` }, A)).channel;
    const _id = `cli${uniq()}`.replace(/[^A-Za-z0-9]/g, '').padEnd(17, 'x').slice(0, 17);
    const [a, b] = await Promise.all([send(A, ch._id, 'Confirmo a reunião de amanhã', { _id }), send(A, ch._id, 'Confirmo a reunião de amanhã', { _id })]);
    const c = await send(A, ch._id, 'Confirmo a reunião de amanhã', { _id });
    expect([a.message._id, b.message._id, c.message._id]).toEqual([_id, _id, _id]);
    const hist = (await api('GET', 'channels.history', { roomId: ch._id, count: 50 }, A)).messages.filter((x: any) => !x.t);
    expect(hist.map((x: any) => x.msg)).toEqual(['Confirmo a reunião de amanhã']);
    expect((await api('GET', 'rooms.info', { roomId: ch._id }, A)).room.msgs).toBe(1);
    // O _id de outra pessoa não devolve a mensagem dela: a nova sai com outro _id.
    const u = await newUser(A);
    await api('POST', 'channels.invite', { roomId: ch._id, userId: u.userId }, A);
    const other = await send(u, ch._id, 'minha', { _id });
    expect(other.message._id).not.toBe(_id);
    expect(other.message.msg).toBe('minha');
  });
});

describe('menção a quem não está na sala', () => {
  it('a resposta do envio diz quem foi mencionado sem estar na sala', async () => {
    const [alice, bruno, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const g = (await api('POST', 'groups.create', { name: `mencao-${uniq()}`, members: [alice.username, bruno.username] }, alice)).group;
    const r = await send(alice, g._id, `@${carla.username} e @${bruno.username}, podem ver isso?`);
    expect(r.mentionsNotInRoom).toEqual([{ _id: carla.userId, username: carla.username, name: expect.any(String) }]);
    expect((await api('GET', 'subscriptions.getOne', { roomId: g._id }, carla)).subscription).toBeNull();
    const ok = await send(alice, g._id, `@${bruno.username} só você`);
    expect(ok.mentionsNotInRoom).toBeUndefined();
    const all = await send(alice, g._id, '@all reunião');
    expect(all.mentionsNotInRoom).toBeUndefined();
  });

  it('num canal de avisos, só quem vê a lista de membros fica sabendo', async () => {
    const [dono, pub, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const ch = (await api('POST', 'channels.create', { name: `avisos-${uniq()}`, members: [pub.username], extraData: { broadcast: true } }, dono)).channel;
    await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, dono);
    expect((await send(dono, ch._id, `@${carla.username} veja`)).mentionsNotInRoom).toHaveLength(1);
    const r = await send(pub, ch._id, `@${carla.username} veja`);
    expect(r.message.msg).toBe(`@${carla.username} veja`);
    expect(r.mentionsNotInRoom).toBeUndefined();
  });
});
