import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, login, newUser, startServer, stopServer, type Auth } from './helpers';

// Diretório (GET directory): busca sem acento, % e _ como letras, canais só com view-c-room, código de acesso e
// canais arquivados marcados. users.autocomplete também ignora acentos.
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

const rand = () => Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'q');
async function person(username: string, name: string): Promise<Auth> {
  const r = await api('POST', 'users.create', { username, name, email: `${username}@test.local`, password: 'senha-forte-1' }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
  return login(username, 'senha-forte-1');
}
const dir = (auth: Auth, type: string, text: string) => api('GET', 'directory', { type, text }, auth);
const names = (r: any) => (r.result ?? []).map((x: any) => x.username ?? x.name);
const channel = async (name: string, extra: Record<string, unknown> = {}) => (await api('POST', 'channels.create', { name, ...extra }, A)).channel._id as string;

async function withPermission(id: string, roles: (cur: string[]) => string[], fn: () => Promise<void>) {
  const cur = ((await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[]).find((p) => p._id === id)!.roles;
  await api('POST', 'permissions.update', { permissions: [{ _id: id, roles: roles(cur) }] }, A);
  try {
    await fn();
  } finally {
    await api('POST', 'permissions.update', { permissions: [{ _id: id, roles: cur }] }, A);
  }
}

describe('diretório: acentos e curingas', () => {
  it('acha pessoas, canais e times sem acento', async () => {
    const t = rand();
    const joao = await person(`joao.${t}`, `João Conceição ${t}`);
    const u = await newUser(A);
    for (const q of [`Joao Conceicao ${t}`, `JOÃO CONCEIÇÃO ${t}`, `conceicao ${t}`]) expect(names(await dir(u, 'users', q)), q).toEqual([joao.username]);
    await channel(`reuniao-${t}`, { extraData: { topic: `Reunião diária ${t}` } });
    expect(names(await dir(u, 'channels', `Reunião diária ${t}`))).toEqual([`reuniao-${t}`]);
    expect(names(await dir(u, 'channels', `reuniao diaria ${t}`))).toEqual([`reuniao-${t}`]);
    await api('POST', 'teams.create', { name: `atencao-${t}`, type: 0 }, A);
    expect(names(await dir(u, 'teams', `atenção-${t}`))).toEqual([`atencao-${t}`]);
  });

  it('% e _ valem como letras, não como curinga', async () => {
    const t = rand();
    await channel(`vendas_${t}`);
    await channel(`vendasx${t}`);
    const u = await newUser(A);
    expect(names(await dir(u, 'channels', `vendas_${t}`))).toEqual([`vendas_${t}`]);
    expect((await dir(u, 'channels', '%')).total).toBe(0);
    expect((await dir(u, 'users', '%')).total).toBe(0);
  });

  it('users.autocomplete: começo do nome sem acento', async () => {
    const t = rand();
    const ana = await person(`aa${t}`, `Ána Ávila ${t}`);
    const u = await newUser(A);
    const items = (await api('GET', 'users.autocomplete', { term: 'Ana Avila' }, u)).items.map((i: any) => i.username);
    expect(items).toContain(ana.username);
    expect((await api('GET', 'users.autocomplete', { term: '%' }, u)).items).toEqual([]);
  });
});

describe('diretório: permissão e entrada', () => {
  it('sem view-c-room não lista canais nem times públicos (só os em que a pessoa está)', async () => {
    const t = rand();
    const pub = await channel(`${t}-publico`);
    const mine = await channel(`${t}-meu`);
    await api('POST', 'teams.create', { name: `${t}-time`, type: 0 }, A);
    const u = await newUser(A);
    await api('POST', 'channels.invite', { roomId: mine, userId: u.userId }, A);
    await withPermission('view-c-room', (cur) => cur.filter((r) => r !== 'user'), async () => {
      expect(names(await dir(u, 'channels', t))).toEqual([`${t}-meu`]);
      expect(names(await dir(u, 'teams', t))).toEqual([]);
      expect((await api('GET', 'channels.list', { filter: t }, u)).channels.map((c: any) => c.name)).toEqual([`${t}-meu`]);
    });
    // A sala principal do time público também é um canal.
    expect(names(await dir(u, 'channels', t)).sort()).toEqual([`${t}-meu`, `${t}-publico`, `${t}-time`]);
    expect(names(await dir(u, 'teams', t))).toEqual([`${t}-time`]);
    expect(pub).toBeTruthy();
  });

  it('canal com código vem com joinCodeRequired (não para quem entra sem código) e o arquivado com archived', async () => {
    const t = rand();
    const coded = await channel(`${t}-codigo`);
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: coded, joinCode: 'abc123' }, A)).success).toBe(true);
    const arch = await channel(`${t}-arquivado`);
    expect((await api('POST', 'channels.archive', { roomId: arch }, A)).success).toBe(true);
    const u = await newUser(A);
    const rows = (await dir(u, 'channels', t)).result;
    expect(rows.find((r: any) => r._id === coded)).toMatchObject({ joinCodeRequired: true, archived: false });
    expect(rows.find((r: any) => r._id === arch)).toMatchObject({ joinCodeRequired: false, archived: true });
    expect((await api('GET', 'rooms.info', { roomId: coded }, u)).room.joinCodeRequired).toBe(true);
    // O administrador (join-without-join-code) entra sem código.
    expect((await dir(A, 'channels', t)).result.find((r: any) => r._id === coded).joinCodeRequired).toBe(false);
    expect((await api('GET', 'rooms.info', { roomId: coded }, A)).room.joinCodeRequired).toBe(false);
    // Entrar sem código continua recusado; com o código, entra.
    expect((await api('POST', 'channels.join', { roomId: coded }, u)).errorType).toBe('error-code-invalid');
    expect((await api('POST', 'channels.join', { roomId: coded, joinCode: 'abc123' }, u)).success).toBe(true);
  });
});
