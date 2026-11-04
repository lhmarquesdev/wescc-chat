import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, login, newUser, startServer, stopServer, type Auth } from './helpers';

// Busca da barra lateral (GET spotlight): pessoas para conversar e canais em que a pessoa ainda não está.
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

const rand = () => Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'q');
// Pessoa com usuário e nome escolhidos (newUser sorteia o usuário).
async function person(username: string, name: string, extra: Record<string, unknown> = {}): Promise<Auth> {
  const r = await api('POST', 'users.create', { username, name, email: `${username}@test.local`, password: 'senha-forte-1', ...extra }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
  return login(username, 'senha-forte-1');
}
const search = (auth: Auth, query: string) => api('GET', 'spotlight', { query }, auth);
const names = (r: any) => (r.users ?? []).map((u: any) => u.username);
const roomNames = (r: any) => (r.rooms ?? []).map((x: any) => x.name);
const channel = async (name: string, by: Auth = A, extra: Record<string, unknown> = {}) => (await api('POST', 'channels.create', { name, ...extra }, by)).channel._id as string;

async function withPermission(id: string, roles: (cur: string[]) => string[], fn: () => Promise<void>) {
  const cur = ((await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[]).find((p) => p._id === id)!.roles;
  await api('POST', 'permissions.update', { permissions: [{ _id: id, roles: roles(cur) }] }, A);
  try {
    await fn();
  } finally {
    await api('POST', 'permissions.update', { permissions: [{ _id: id, roles: cur }] }, A);
  }
}

describe('spotlight: pessoas', () => {
  it('sem login → 401', async () => {
    expect((await api('GET', 'spotlight', { query: 'ana' })).status).toBe(401);
  });

  it('acha pelo sobrenome e sem acento, com os papéis e sem o e-mail', async () => {
    const t = rand();
    const ana = await person(`ana.${t}`, `Ana Conceição ${t}`);
    const u = await newUser(A);
    for (const q of ['conceicao', 'CONCEI', `concei ${t}`.slice(0, 6)]) {
      const r = await search(u, q);
      expect(r.success).toBe(true);
      expect(names(r)).toContain(ana.username);
    }
    const hit = (await search(u, 'conceição')).users.find((x: any) => x.username === ana.username);
    expect(hit).toMatchObject({ _id: ana.userId, name: `Ana Conceição ${t}`, roles: ['user'] });
    expect(hit).not.toHaveProperty('email');
  });

  it('não lista a própria pessoa, bots nem contas desativadas', async () => {
    const t = rand();
    const me = await person(`eu.${t}`, `Fulano ${t}`);
    const off = await person(`off.${t}`, `Desligado ${t}`);
    const bot = await api('POST', 'users.create', { username: `bot.${t}`, name: `Robô ${t}`, email: `bot.${t}@test.local`, password: 'senha-forte-1', roles: ['bot'] }, A);
    await pool.query(`UPDATE users SET type = 'bot' WHERE id = $1`, [bot.user._id]);
    expect((await api('POST', 'users.setActiveStatus', { userId: off.userId, activeStatus: false }, A)).success).toBe(true);
    const other = await person(`outro.${t}`, `Outro ${t}`);
    const r = await search(me, t);
    expect(names(r)).toEqual([other.username]);
  });

  it('ordem: usuário exato, começo do nome, começo de palavra, qualquer parte', async () => {
    const t = `kx${rand()}`;
    const contains = await person(`c.${rand()}`, `Maria Ab${t}`);
    const word = await person(`w.${rand()}`, `Maria ${t}son`);
    const prefix = await person(`p.${rand()}`, `${t}inho Silva`);
    const exact = await person(t, 'Zé Exato');
    const u = await newUser(A);
    expect(names(await search(u, t.toUpperCase()))).toEqual([exact.username, prefix.username, word.username, contains.username]);
  });

  it('"@" busca só pessoas, "#" só salas; menos de 2 letras vem vazio; % e _ valem como letras', async () => {
    const t = rand();
    const p = await person(`zz${t}`, `Pessoa ${t}`);
    await channel(`zz${t}-sala`);
    const u = await newUser(A);
    const both = await search(u, `zz${t}`);
    expect(names(both)).toEqual([p.username]);
    expect(roomNames(both)).toEqual([`zz${t}-sala`]);
    const people = await search(u, `@ zz${t}`);
    expect(names(people)).toEqual([p.username]);
    expect(people.rooms).toEqual([]);
    const rooms = await search(u, `#zz${t}`);
    expect(rooms.users).toEqual([]);
    expect(roomNames(rooms)).toEqual([`zz${t}-sala`]);
    for (const q of ['', 'z', '@z', '#z', '  ']) expect(await search(u, q)).toMatchObject({ users: [], rooms: [] });
    expect(await search(u, '%%')).toMatchObject({ users: [], rooms: [] });
    const under = await person(`xa_b${t}`, `Sublinhado ${t}`);
    await person(`h${t}`, `Haxbr ${t}`);
    expect(names(await search(u, `a_b${t}`))).toEqual([under.username]);
    expect(names(await search(u, 'a_b')).every((n: string) => n.includes('a_b'))).toBe(true);
  });

  it('sem create-d não lista pessoas (as DMs que existem continuam na busca local)', async () => {
    const t = rand();
    await person(`sem.${t}`, `Sem Conversa ${t}`);
    const u = await newUser(A);
    await withPermission('create-d', (cur) => cur.filter((r) => r !== 'user'), async () => {
      const r = await search(u, `sem.${t}`);
      expect(r.users).toEqual([]);
    });
    expect(names(await search(u, `sem.${t}`))).toHaveLength(1);
  });

  it('operação: aparece com os papéis, e im.create continua recusando', async () => {
    const t = rand();
    const op1 = await person(`op1.${t}`, `Operador Um ${t}`, { roles: ['user', 'operacao'] });
    const op2 = await person(`op2.${t}`, `Operador Dois ${t}`, { roles: ['user', 'operacao'] });
    const r = await search(op1, `op2.${t}`);
    expect(r.users).toHaveLength(1);
    expect(r.users[0].roles).toContain('operacao');
    const dm = await api('POST', 'im.create', { username: op2.username }, op1);
    expect(dm.status).toBe(403);
    expect(dm.errorType).toBe('error-direct-restricted');
  });

  it('status personalizado de quem está offline não vaza', async () => {
    const t = rand();
    const b = await person(`reuniao.${t}`, `Bruno Reunião ${t}`);
    expect((await api('POST', 'users.setStatus', { statusId: 'status-em-reuniao' }, b)).success).toBe(true);
    const u = await newUser(A);
    const r = await search(u, `reuniao.${t}`);
    expect(r.users[0]).toMatchObject({ status: 'offline', statusCustom: null });
  });
});

describe('spotlight: canais', () => {
  it('lista o canal público em que a pessoa não está, e nada que ela não pode abrir', async () => {
    const t = rand();
    const u = await newUser(A);
    const mate = await newUser(A);
    const pub = await channel(`${t}-publico`);
    await channel(`${t}-membro`, A, { members: [u.username] });
    await api('POST', 'groups.create', { name: `${t}-privado`, members: [mate.username] }, A);
    expect((await api('POST', 'rooms.createDiscussion', { prid: pub, t_name: `${t}-discussao` }, A)).success).toBe(true);
    const arch = await channel(`${t}-arquivado`);
    expect((await api('POST', 'channels.archive', { roomId: arch }, A)).success).toBe(true);
    const ban = await channel(`${t}-banido`);
    await pool.query(`UPDATE rooms SET custom_fields = jsonb_build_object('banned', jsonb_build_array($2::text)) WHERE id = $1`, [ban, u.userId]);
    const team = (await api('POST', 'teams.create', { name: `${t}-time-fechado`, type: 1, members: [mate.username] }, A)).team;
    expect((await api('POST', 'teams.createRoom', { teamId: team._id, name: `${t}-canal-do-time`, type: 'c' }, A)).success).toBe(true);

    const r = await search(u, t);
    expect(roomNames(r)).toEqual([`${t}-publico`]);
    expect(r.rooms[0]).toMatchObject({ _id: pub, t: 'c', fname: `${t}-publico`, teamMain: false, notice: false, joinCodeRequired: false, usersCount: 1 });
    // Quem é do time privado vê o canal do time.
    expect(roomNames(await search(mate, t))).toEqual(expect.arrayContaining([`${t}-canal-do-time`, `${t}-publico`]));
  });

  it('time público aparece pela sala principal, e entrar nela põe a pessoa no time', async () => {
    const t = rand();
    const team = (await api('POST', 'teams.create', { name: `${t}-time-aberto`, type: 0 }, A)).team;
    const u = await newUser(A);
    const r = await search(u, `${t}-time`);
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]).toMatchObject({ _id: team.roomId, teamMain: true });
    expect(r.rooms[0].teamName).toBeUndefined();
    expect((await api('POST', 'channels.join', { roomId: team.roomId }, u)).success).toBe(true);
    const members = await api('GET', 'teams.members', { teamId: team._id }, A);
    expect(members.members.map((m: any) => m.user?._id ?? m.user?.id ?? m._id)).toContain(u.userId);
    expect((await search(u, `${t}-time`)).rooms).toEqual([]);
  });

  it('canal de time público traz o nome do time', async () => {
    const t = rand();
    const team = (await api('POST', 'teams.create', { name: `${t}-suporte`, type: 0 }, A)).team;
    await api('POST', 'teams.createRoom', { teamId: team._id, name: `${t}-fila`, type: 'c' }, A);
    const u = await newUser(A);
    const r = await search(u, `${t}-fila`);
    expect(r.rooms[0]).toMatchObject({ name: `${t}-fila`, teamMain: false, teamName: `${t}-suporte` });
  });

  it('sem view-c-room não lista salas', async () => {
    const t = rand();
    await channel(`${t}-visivel`);
    const u = await newUser(A);
    await withPermission('view-c-room', (cur) => cur.filter((r) => r !== 'user'), async () => {
      expect((await search(u, t)).rooms).toEqual([]);
    });
    expect(roomNames(await search(u, t))).toEqual([`${t}-visivel`]);
  });

  it('joinCodeRequired: pede o código a quem não tem join-without-join-code', async () => {
    const t = rand();
    const rid = await channel(`${t}-codigo`);
    expect((await api('POST', 'rooms.saveRoomSettings', { rid, joinCode: '1234' }, A)).success).toBe(true);
    const u = await newUser(A);
    expect((await search(u, t)).rooms[0]).toMatchObject({ _id: rid, joinCodeRequired: true });
    // O administrador entra sem código: para ele o canal não pede (sem a inscrição, para a sala aparecer na busca).
    await pool.query('DELETE FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, A.userId]);
    expect((await search(A, t)).rooms[0]).toMatchObject({ _id: rid, joinCodeRequired: false });
  });
});
