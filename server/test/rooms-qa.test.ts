import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

// Salas: correções da rodada de testes (times, hierarquia na sala, imagem da sala, leitura, membros, nomes).
let A: Auth;
let ana: Auth;
let bia: Auth;
let caio: Auth;

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  ana = await newUser(A, { roles: ['user'] });
  bia = await newUser(A, { roles: ['user'] });
  caio = await newUser(A, { roles: ['user'] });
});
afterAll(() => stopServer());

const uniq = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

describe('mover salas para um time', () => {
  it('quem não modera a sala não a leva para o próprio time nem lê um grupo privado', async () => {
    const g = await api('POST', 'groups.create', { name: uniq('secreto'), members: [bia.username] }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: g.group._id, msg: 'reunião confidencial' } }, A);
    const c = await api('POST', 'channels.create', { name: uniq('aberto') }, A);
    const t = await api('POST', 'teams.create', { name: uniq('time-ana'), type: 1 }, ana);
    expect(t.success).toBe(true);
    // Grupo privado de que ana não participa: nem aparece.
    const r1 = await api('POST', 'teams.addRooms', { teamId: t.team._id, rooms: [g.group._id] }, ana);
    expect(r1.status).toBe(400);
    // Canal público de que ana não é dona: proibido.
    const r2 = await api('POST', 'teams.addRooms', { teamId: t.team._id, rooms: [c.channel._id] }, ana);
    expect(r2.status).toBe(403);
    // Nada mudou, e ana segue sem ler o grupo.
    expect((await api('GET', 'rooms.info', { roomId: c.channel._id }, A)).room.teamId).toBeFalsy();
    expect((await api('GET', 'rooms.info', { roomId: g.group._id }, A)).room.teamId).toBeFalsy();
    expect((await api('GET', 'groups.history', { roomId: g.group._id }, ana)).status).toBe(403);
  });

  it('uma sala recusada no meio não deixa as anteriores no time', async () => {
    const mine = await api('POST', 'channels.create', { name: uniq('da-ana') }, ana);
    const other = await api('POST', 'channels.create', { name: uniq('do-admin') }, A);
    const t = await api('POST', 'teams.create', { name: uniq('time-ana2'), type: 0 }, ana);
    const r = await api('POST', 'teams.addRooms', { teamId: t.team._id, rooms: [mine.channel._id, other.channel._id] }, ana);
    expect(r.status).toBe(403);
    expect((await api('GET', 'rooms.info', { roomId: mine.channel._id }, ana)).room.teamId).toBeFalsy();
    // Só a própria sala: passa.
    expect((await api('POST', 'teams.addRooms', { teamId: t.team._id, rooms: [mine.channel._id] }, ana)).success).toBe(true);
    expect((await api('GET', 'rooms.info', { roomId: mine.channel._id }, ana)).room.teamId).toBe(t.team._id);
  });

  it('administrador move qualquer sala; grupo privado de que o dono do time não participa vem sem a última mensagem', async () => {
    const t = await api('POST', 'teams.create', { name: uniq('time-bia'), type: 0 }, bia);
    const g = await api('POST', 'groups.create', { name: uniq('so-admin') }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: g.group._id, msg: 'texto privado' } }, A);
    expect((await api('POST', 'teams.addMembers', { teamId: t.team._id, members: [{ userId: A.userId }] }, bia)).success).toBe(true);
    expect((await api('POST', 'teams.addRooms', { teamId: t.team._id, rooms: [g.group._id] }, A)).success).toBe(true);
    const list = await api('GET', 'teams.listRooms', { teamId: t.team._id }, bia);
    const row = list.rooms.find((r: any) => r._id === g.group._id);
    expect(row).toBeTruthy();
    expect(row.lastMessage).toBeUndefined();
    // Marcar como padrão traria todo o time (bia junto) para o grupo: bia não pode pôr pessoas nele.
    const d = await api('POST', 'teams.updateRoom', { roomId: g.group._id, isDefault: true }, bia);
    expect(d.status).toBe(403);
    expect((await api('GET', 'groups.history', { roomId: g.group._id }, bia)).status).toBe(403);
    // O administrador (membro do grupo) pode.
    expect((await api('POST', 'teams.updateRoom', { roomId: g.group._id, isDefault: true }, A)).success).toBe(true);
    expect((await api('GET', 'groups.history', { roomId: g.group._id }, bia)).success).toBe(true);
  });
});

describe('moderador e dono', () => {
  it('moderador não silencia nem remove um dono; dono e administrador podem', async () => {
    const c = await api('POST', 'channels.create', { name: uniq('hierarquia'), members: [bia.username, caio.username] }, ana);
    const rid = c.channel._id;
    expect((await api('POST', 'channels.addModerator', { roomId: rid, userId: bia.userId }, ana)).success).toBe(true);
    expect((await api('POST', 'channels.addOwner', { roomId: rid, userId: caio.userId }, ana)).success).toBe(true);
    const mute = await api('POST', 'rooms.muteUser', { roomId: rid, userId: ana.userId }, bia);
    expect(mute.status).toBe(403);
    expect(mute.error).toBe('Só donos podem silenciar ou remover outro dono.');
    expect((await api('POST', 'channels.kick', { roomId: rid, userId: caio.userId }, bia)).status).toBe(403);
    expect((await api('GET', 'rooms.info', { roomId: rid }, ana)).room.muted ?? []).not.toContain(ana.username);
    // Dono age sobre outro dono; o administrador também.
    expect((await api('POST', 'rooms.muteUser', { roomId: rid, userId: caio.userId }, ana)).success).toBe(true);
    expect((await api('POST', 'rooms.unmuteUser', { roomId: rid, userId: caio.userId }, A)).success).toBe(true);
    expect((await api('POST', 'channels.kick', { roomId: rid, userId: caio.userId }, ana)).success).toBe(true);
    // Moderador segue moderando membros comuns.
    const d = await newUser(A, { roles: ['user'] });
    await api('POST', 'channels.invite', { roomId: rid, userId: d.userId }, ana);
    expect((await api('POST', 'rooms.muteUser', { roomId: rid, userId: d.userId }, bia)).success).toBe(true);
    expect((await api('POST', 'channels.kick', { roomId: rid, userId: d.userId }, bia)).success).toBe(true);
  });
});

describe('imagem da sala', () => {
  const png = (size: number) => {
    const b = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    return b;
  };
  const send = (rid: string, data: Buffer, type = 'image/png') => {
    const fd = new FormData();
    fd.append('roomId', rid);
    fd.append('image', new Blob([new Uint8Array(data)], { type }), 'img.png');
    return api('POST', 'rooms.setAvatar', fd, ana);
  };
  it('recusa imagem acima de 5 MB e arquivo que não é imagem', async () => {
    const c = await api('POST', 'channels.create', { name: uniq('foto') }, ana);
    const big = await send(c.channel._id, png(6 * 1024 * 1024));
    expect(big.status).toBe(400);
    expect(big.error).toBe('Imagem muito grande (máx. 5 MB).');
    const fake = await send(c.channel._id, Buffer.from('<html>não é imagem</html>'));
    expect(fake.status).toBe(400);
    expect(fake.errorType).toBe('error-invalid-image');
    expect((await send(c.channel._id, png(2048))).success).toBe(true);
    expect((await api('GET', 'rooms.info', { roomId: c.channel._id }, ana)).room.avatarETag).toBeTruthy();
  });
});

describe('leitura de quem envia', () => {
  const sub = async (rid: string, who: Auth) => (await api('GET', 'subscriptions.getOne', { roomId: rid }, who)).subscription;
  it('responder na conversa zera o selo em todas as sessões da pessoa', async () => {
    const c = await api('POST', 'channels.create', { name: uniq('leitura'), members: [ana.username] }, bia);
    const rid = c.channel._id;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: `oi @${ana.username}` } }, bia);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'tudo bem?' } }, bia);
    expect((await sub(rid, ana)).unread).toBe(2);
    const ws = connectWs(ana);
    await ws.ready;
    // Outra sessão (o celular) responde: esta sessão recebe a inscrição lida.
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'tudo!' } }, ana);
    const ev = await ws.waitFor((e) => e.type === 'subscription' && e.subscription?.rid === rid && e.subscription.unread === 0);
    expect(ev.subscription.userMentions).toBe(0);
    ws.close();
  });

  it('responder só numa thread lê a thread, não a conversa principal', async () => {
    const c = await api('POST', 'channels.create', { name: uniq('thread'), members: [ana.username] }, bia);
    const rid = c.channel._id;
    const root = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'raiz' } }, bia);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'resposta', tmid: root.message._id } }, ana);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'nova na thread', tmid: root.message._id } }, bia);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: `@${ana.username} olha aqui` } }, bia);
    const before = await sub(rid, ana);
    expect(before.unread).toBeGreaterThanOrEqual(1);
    expect(before.userMentions).toBe(1);
    expect(before.tunread).toContain(root.message._id);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'respondi na thread', tmid: root.message._id } }, ana);
    const after = await sub(rid, ana);
    expect(after.unread).toBe(before.unread);
    expect(after.userMentions).toBe(1);
    expect(after.tunread ?? []).not.toContain(root.message._id);
    // "Também enviar na conversa" conta como resposta na conversa.
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'e aqui também', tmid: root.message._id, tshow: true } }, ana);
    expect((await sub(rid, ana)).unread).toBe(0);
  });
});

describe('membros ao vivo', () => {
  it('entrar e sair de uma sala avisa quem está nela (número de membros)', async () => {
    const g = await api('POST', 'groups.create', { name: uniq('ao-vivo'), members: [bia.username] }, ana);
    const rid = g.group._id;
    const ws = connectWs(ana);
    await ws.ready;
    await api('POST', 'groups.invite', { roomId: rid, userId: caio.userId }, ana);
    const up = await ws.waitFor((e) => e.type === 'room' && e.action === 'updated' && e.room._id === rid && e.room.usersCount === 3);
    expect(up.room.usersCount).toBe(3);
    await api('POST', 'groups.kick', { roomId: rid, userId: bia.userId }, ana);
    await ws.waitFor((e) => e.type === 'room' && e.action === 'updated' && e.room._id === rid && e.room.usersCount === 2);
    ws.close();
  });

  it('a lista de membros diz quantos estão online no total, e filtra por status', async () => {
    const c = await api('POST', 'channels.create', { name: uniq('lista'), members: [bia.username, caio.username] }, ana);
    const rid = c.channel._id;
    const all = await api('GET', 'rooms.membersOrderedByRole', { roomId: rid, count: 1 }, ana);
    expect(all.total).toBe(3);
    expect(all.members).toHaveLength(1);
    expect(typeof all.online).toBe('number');
    const on = await api('GET', 'rooms.membersOrderedByRole', { roomId: rid, status: 'online,away,busy' }, ana);
    expect(on.total).toBe(all.online);
    expect(on.members.every((m: any) => m.status !== 'offline')).toBe(true);
  });

  it('grupo privado excluído: só quem participava recebe o aviso', async () => {
    const g = await api('POST', 'groups.create', { name: uniq('apagar'), members: [bia.username] }, ana);
    const rid = g.group._id;
    const wsBia = connectWs(bia);
    const wsCaio = connectWs(caio);
    await Promise.all([wsBia.ready, wsCaio.ready]);
    expect((await api('POST', 'groups.delete', { roomId: rid }, ana)).success).toBe(true);
    await wsBia.waitFor((e) => e.type === 'room' && e.action === 'removed' && e.room._id === rid);
    await new Promise((r) => setTimeout(r, 300));
    expect(wsCaio.events.some((e) => e.type === 'room' && e.room?._id === rid)).toBe(false);
    wsBia.close();
    wsCaio.close();
  });
});

describe('nomes e limites ao criar', () => {
  const create = (name: string) => api('POST', 'channels.create', { name }, ana);
  it('nome precisa de letra ou número, sem × ÷, com mensagem para cada problema', async () => {
    for (const bad of ['.', '..', '-', '×÷', '_-_']) {
      const r = await create(bad);
      expect(r.status, bad).toBe(400);
      expect(r.error, bad).toMatch(/pelo menos uma letra ou número|não é permitido/);
    }
    expect((await create('a'.repeat(65))).error).toBe('O nome pode ter no máximo 64 caracteres.');
    expect((await create('nome/com/barra')).error).toBe('O caractere “/” não é permitido. Use letras, números, ponto, hífen ou sublinhado.');
    expect((await create('festa🎉')).error).toContain('“🎉”');
    expect((await create('a×b')).error).toContain('“×”');
    expect((await create(uniq('Operação'))).success).toBe(true);
    expect((await create(uniq('x').slice(0, 10) + 'a'.repeat(54))).success).toBe(true);
  });

  it('canal do time sem nome e discussão longa explicam em português', async () => {
    const t = await api('POST', 'teams.create', { name: uniq('time-nomes'), type: 0 }, ana);
    const r = await api('POST', 'teams.createRoom', { teamId: t.team._id, name: '', type: 'c' }, ana);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Informe o nome.');
    const c = await create(uniq('origem'));
    const d = await api('POST', 'rooms.createDiscussion', { prid: c.channel._id, t_name: 'x'.repeat(250) }, ana);
    expect(d.error).toBe('O nome da discussão pode ter no máximo 200 caracteres.');
    expect((await api('POST', 'rooms.createDiscussion', { prid: c.channel._id, t_name: '' }, ana)).error).toBe('Informe o nome da discussão.');
  });

  it('mensagem direta com mais de 8 pessoas além de você', async () => {
    const people = [];
    for (let i = 0; i < 9; i++) people.push((await newUser(A, { roles: ['user'] })).username);
    const r = await api('POST', 'im.create', { usernames: people.join(',') }, ana);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Uma mensagem direta junta no máximo 8 pessoas além de você.');
    expect((await api('POST', 'im.create', { usernames: people.slice(0, 8).join(',') }, ana)).success).toBe(true);
  });
});
