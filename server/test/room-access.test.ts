import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Permissões de um canal: "só quem eu escolher" fala (sala somente leitura + Publicador), silenciar, papéis de sala do
// sistema e papéis de sala próprios criados em Papéis e permissões, com a trava de concessão.
let A: Auth;
let owner: Auth;
let ana: Auth;
let bia: Auth;
let rid: string;

const send = (who: Auth, msg: string) => api('POST', 'chat.sendMessage', { message: { rid, msg } }, who);
const access = async (who: Auth = owner) => api('GET', 'rooms.access', { roomId: rid }, who);
const member = (r: any, who: Auth) => r.members.find((m: any) => m._id === who.userId);

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  owner = await newUser(A, { roles: ['user'] });
  ana = await newUser(A, { roles: ['user'] });
  bia = await newUser(A, { roles: ['user'] });
  const r = await api('POST', 'channels.create', { name: `perm-${Date.now().toString(36)}`, members: [ana.username, bia.username] }, owner);
  expect(r.success).toBe(true);
  rid = r.channel._id;
  // Papéis de sala próprios: um que o dono pode dar (fixar) e um que dá mais do que o dono tem (limpar o histórico).
  expect((await api('POST', 'rbac.roles.create', { name: 'fixador', description: 'Fixador', scope: 'Subscriptions', permissions: ['pin-message'] }, A)).success).toBe(true);
  expect((await api('POST', 'rbac.roles.create', { name: 'faxineiro', description: 'Faxineiro', scope: 'Subscriptions', permissions: ['clean-channel-history'] }, A)).success).toBe(true);
});
afterAll(() => stopServer());

describe('quem pode enviar', () => {
  it('membro comum não vê nem mexe nas permissões do canal', async () => {
    expect((await access(ana)).status).toBe(403);
    expect((await api('POST', 'rooms.access.setPosters', { roomId: rid, add: [ana.userId] }, ana)).status).toBe(403);
  });

  it('com todos falando, todo membro pode enviar', async () => {
    const r = await access();
    expect(r.room.readOnly).toBe(false);
    expect(r.can).toMatchObject({ mode: true, mute: true, posters: true });
    expect(member(r, ana).canPost).toBe(true);
    expect(member(r, owner).roomRoles).toContain('owner');
    expect(member(r, owner).roomPermissions).toContain('post-readonly');
    expect((await send(bia, 'oi')).success).toBe(true);
  });

  it('"só quem eu escolher": só o dono e quem foi escolhido enviam', async () => {
    expect((await api('POST', 'rooms.saveRoomSettings', { rid, readOnly: true }, owner)).success).toBe(true);
    expect((await api('POST', 'rooms.access.setPosters', { roomId: rid, add: [ana.userId] }, owner)).changed).toBe(1);
    const r = await access();
    expect(member(r, ana)).toMatchObject({ canPost: true, roomRoles: ['publisher'] });
    expect(member(r, bia).canPost).toBe(false);
    expect((await send(ana, 'posso')).success).toBe(true);
    expect((await send(bia, 'não posso')).status).toBe(403);
    expect((await send(owner, 'dono fala')).success).toBe(true);
    // Repetir não duplica; tirar devolve ao silêncio.
    expect((await api('POST', 'rooms.access.setPosters', { roomId: rid, add: [ana.userId] }, owner)).changed).toBe(0);
    expect((await api('POST', 'rooms.access.setPosters', { roomId: rid, remove: [ana.userId] }, owner)).changed).toBe(1);
    expect((await send(ana, 'agora não')).status).toBe(403);
  });

  it('silenciar tira a fala mesmo de quem foi escolhido', async () => {
    await api('POST', 'rooms.access.setPosters', { roomId: rid, add: [bia.userId] }, owner);
    expect((await api('POST', 'rooms.muteUser', { roomId: rid, userId: bia.userId }, owner)).success).toBe(true);
    expect(member(await access(), bia)).toMatchObject({ muted: true, canPost: false });
    expect((await send(bia, 'calada')).status).toBe(403);
    await api('POST', 'rooms.unmuteUser', { roomId: rid, userId: bia.userId }, owner);
    expect((await send(bia, 'voltei')).success).toBe(true);
    await api('POST', 'rooms.saveRoomSettings', { rid, readOnly: false }, owner);
  });
});

describe('papéis de cada pessoa no canal', () => {
  it('troca os papéis de sala de uma vez e lista os papéis de sala próprios', async () => {
    const r = await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: ana.userId, roles: ['moderator', 'fixador'] }, owner);
    expect(r.roles.sort()).toEqual(['fixador', 'moderator']);
    const a = await access();
    expect(member(a, ana).roomRoles.sort()).toEqual(['fixador', 'moderator']);
    expect(member(a, ana).roomPermissions).toContain('pin-message');
    expect(a.roles.find((x: any) => x._id === 'fixador')).toMatchObject({ builtin: false, lock: null });
    expect(a.roles.find((x: any) => x._id === 'faxineiro')).toMatchObject({ lock: 'superior' });
    expect((await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: ana.userId, roles: [] }, owner)).roles).toEqual([]);
  });

  it('papel de sala que dá mais do que o dono tem fica travado; o administrador consegue', async () => {
    const r = await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: bia.userId, roles: ['faxineiro'] }, owner);
    expect(r).toMatchObject({ status: 403, errorType: 'RBAC_ROLE_SUPERIOR' });
    await api('POST', 'channels.invite', { roomId: rid, userId: A.userId }, owner);
    expect((await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: bia.userId, roles: ['faxineiro'] }, A)).success).toBe(true);
  });

  it('papel global não vira papel de sala, e moderador não dá dono', async () => {
    expect((await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: bia.userId, roles: ['admin'] }, A)).status).toBe(400);
    await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: ana.userId, roles: ['moderator'] }, owner);
    expect((await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: bia.userId, roles: ['faxineiro', 'owner'] }, ana)).status).toBe(403);
  });

  it('não deixa o canal sem dono', async () => {
    expect((await api('POST', 'rooms.access.setRoles', { roomId: rid, userId: owner.userId, roles: [] }, owner)).status).toBe(400);
  });
});
