import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Administração › Salas: troca o dono de um grupo privado em que o administrador não está, e arquiva pela mesma tela
// (admsys-19).
let A: Auth;

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

describe('administração de salas', () => {
  it('lista os donos e troca o dono (quem não está na sala entra nela)', async () => {
    const dono = await newUser(A);
    const novo = await newUser(A);
    const g = await api('POST', 'groups.create', { name: 'equipe-saida' }, dono);
    const rid = g.group._id;
    let info = await api('GET', 'rooms.adminRooms.getRoom', { rid }, A);
    expect(info.owners.map((o: any) => o.username)).toEqual([dono.username]);

    // Como a tela faz: addOwner; fora da sala, entra e vira dono; depois sai o antigo.
    const first = await api('POST', 'groups.addOwner', { roomId: rid, userId: novo.userId }, A);
    expect(first.errorType).toBe('error-user-not-in-room');
    expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: rid, userId: novo.userId }, A)).status).toBe(200);
    expect((await api('POST', 'groups.addOwner', { roomId: rid, userId: novo.userId }, A)).status).toBe(200);
    expect((await api('POST', 'groups.removeOwner', { roomId: rid, userId: dono.userId }, A)).status).toBe(200);
    info = await api('GET', 'rooms.adminRooms.getRoom', { rid }, A);
    expect(info.owners.map((o: any) => o.username)).toEqual([novo.username]);
    const last = await api('POST', 'groups.removeOwner', { roomId: rid, userId: novo.userId }, A);
    expect(last.errorType).toBe('error-remove-last-owner');

    expect((await api('POST', 'groups.archive', { roomId: rid }, A)).status).toBe(200);
    expect((await api('GET', 'rooms.adminRooms.getRoom', { rid }, A)).archived).toBe(true);
    expect((await api('POST', 'groups.unarchive', { roomId: rid }, A)).status).toBe(200);
  });
});
