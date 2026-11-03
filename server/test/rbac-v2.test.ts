import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { loadPermissions } from '../src/services/permissions';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Papéis e permissões v2. Primeiro os dois buracos fechados: dar papel de sala por roles.addUserToRole (quem tinha
// manage-roles virava Dono de qualquer sala) e pôr gente em qualquer sala pelo Admin › Salas só com "Visualizar".
let A: Auth;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const grants = async (role: string) => (await pool.query('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [role])).rows.map((r) => r.id);
const subRoles = async (rid: string, uid: string) => (await pool.query('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, uid])).rows[0]?.roles as string[] | undefined;
const isMember = async (rid: string, uid: string) => (await pool.query('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, uid])).rowCount === 1;
const systemCount = async (rid: string, t: string) => Number((await pool.query('SELECT count(*) AS n FROM messages WHERE room_id = $1 AND t = $2', [rid, t])).rows[0].n);
const geralId = async () => (await pool.query(`SELECT id FROM rooms WHERE name = 'geral'`)).rows[0].id as string;

async function roleWith(name: string, permissions: string[], scope: 'Users' | 'Subscriptions' = 'Users') {
  const r = await api('POST', 'rbac.roles.create', { name, description: name, scope, permissions }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

describe('roles.addUserToRole com sala passa pelas regras de papel de sala', () => {
  let ana: Auth;
  let bia: Auth;
  beforeAll(async () => {
    // Gerencia papéis, mas não tem Definir donos (set-owner) em sala nenhuma.
    await roleWith('papeis', ['view-permissions', 'manage-roles', 'access-permissions']);
    ana = await newUser(A, { roles: ['user', 'papeis'] });
    bia = await newUser(A, { roles: ['user'] });
  });

  it('quem só gerencia papéis não vira Dona do #geral sozinha', async () => {
    const geral = await geralId();
    expect(await isMember(geral, ana.userId)).toBe(true);
    const r = await api('POST', 'roles.addUserToRole', { roleId: 'owner', userId: ana.userId, roomId: geral }, ana);
    expect(r.status).toBe(403);
    expect(await subRoles(geral, ana.userId)).not.toContain('owner');
    // Nem dá Dono a outra pessoa, nem tira.
    expect((await api('POST', 'roles.addUserToRole', { roleId: 'owner', userId: bia.userId, roomId: geral }, ana)).status).toBe(403);
    expect(await subRoles(geral, bia.userId)).not.toContain('owner');
  });

  it('o administrador dá Dono: mensagem de sistema; repetir não muda nada; a última dona não sai', async () => {
    const ch = (await api('POST', 'channels.create', { name: uniq('sala-papel'), members: [bia.username] }, A)).channel;
    const before = await systemCount(ch._id, 'subscription-role-added');
    const r = await api('POST', 'roles.addUserToRole', { roleId: 'owner', userId: bia.userId, roomId: ch._id }, A);
    expect(r.status).toBe(200);
    expect(await subRoles(ch._id, bia.userId)).toContain('owner');
    expect(await systemCount(ch._id, 'subscription-role-added')).toBe(before + 1);
    expect((await api('POST', 'roles.addUserToRole', { roleId: 'owner', userId: bia.userId, roomId: ch._id }, A)).status).toBe(200);
    expect(await systemCount(ch._id, 'subscription-role-added')).toBe(before + 1);
    // Tira o admin (sobra a bia) e depois tenta tirar a última dona.
    expect((await api('POST', 'roles.removeUserFromRole', { roleId: 'owner', userId: A.userId, roomId: ch._id }, A)).status).toBe(200);
    const last = await api('POST', 'roles.removeUserFromRole', { roleId: 'owner', userId: bia.userId, roomId: ch._id }, A);
    expect(last).toMatchObject({ status: 400, errorType: 'error-remove-last-owner' });
    expect(await subRoles(ch._id, bia.userId)).toContain('owner');
    // Tirar de quem não tem: nada muda, sem erro.
    expect((await api('POST', 'roles.removeUserFromRole', { roleId: 'moderator', userId: bia.userId, roomId: ch._id }, A)).status).toBe(200);
  });

  it('papel de sala criado aqui que dá mais do que o ator tem: recusado mesmo para a dona da sala', async () => {
    await roleWith('faxina-sala', ['clean-channel-history', 'pin-message'], 'Subscriptions');
    const ch = (await api('POST', 'channels.create', { name: uniq('sala-da-ana'), members: [bia.username] }, ana)).channel;
    expect(await subRoles(ch._id, ana.userId)).toContain('owner');
    const r = await api('POST', 'roles.addUserToRole', { roleId: 'faxina-sala', userId: bia.userId, roomId: ch._id }, ana);
    expect(r).toMatchObject({ status: 403, errorType: 'RBAC_ROLE_SUPERIOR' });
    expect(await subRoles(ch._id, bia.userId)).toEqual([]);
  });

  it('DM não tem papel de sala; papel de sala sem sala é recusado', async () => {
    const dm = (await api('POST', 'im.create', { username: bia.username }, A)).room._id;
    const r = await api('POST', 'roles.addUserToRole', { roleId: 'publisher', userId: bia.userId, roomId: dm }, A);
    expect(r).toMatchObject({ status: 400, errorType: 'error-not-allowed', error: 'Mensagens diretas não têm papéis de sala.' });
    const none = await api('POST', 'roles.addUserToRole', { roleId: 'owner', userId: bia.userId }, A);
    expect(none).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
    expect((await pool.query('SELECT roles FROM users WHERE id = $1', [bia.userId])).rows[0].roles).not.toContain('owner');
  });
});

describe('Admin › Salas › adicionar pessoa', () => {
  let vera: Auth;
  let grupo: string;
  let canal: string;
  beforeAll(async () => {
    await roleWith('salas-ver', ['view-room-administration']);
    vera = await newUser(A, { roles: ['user', 'salas-ver'] });
    grupo = (await api('POST', 'groups.create', { name: uniq('secreto-diretoria') }, A)).group._id;
    canal = (await api('POST', 'channels.create', { name: uniq('canal-geral') }, A)).channel._id;
  });

  it('só "Visualizar" salas não põe ninguém num grupo privado nem num canal', async () => {
    const g = await api('POST', 'rooms.adminRooms.addUser', { roomId: grupo, userId: vera.userId }, vera);
    expect(g).toMatchObject({ status: 403, errorType: 'error-not-allowed', error: 'Sem permissão para adicionar pessoas a esta sala.' });
    expect(await isMember(grupo, vera.userId)).toBe(false);
    expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: canal, userId: vera.userId }, vera)).status).toBe(403);
    expect(await isMember(canal, vera.userId)).toBe(false);
  });

  it('com add-user-to-any-p-room: entra no grupo, mas não no canal; DM nunca', async () => {
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'salas-ver') WHERE id = 'add-user-to-any-p-room'`);
    await loadPermissions();
    try {
      expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: grupo, userId: vera.userId }, vera)).status).toBe(200);
      expect(await isMember(grupo, vera.userId)).toBe(true);
      expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: canal, userId: vera.userId }, vera)).status).toBe(403);
      const dm = (await api('POST', 'im.create', { username: vera.username }, A)).room._id;
      expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: dm, userId: vera.userId }, A)).status).toBe(400);
    } finally {
      await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'salas-ver') WHERE id = 'add-user-to-any-p-room'`);
      await loadPermissions();
    }
  });

  it('o Administrador continua adicionando em grupos privados (padrão novo do catálogo)', async () => {
    expect(await grants('admin')).toContain('add-user-to-any-p-room');
    const u = await newUser(A);
    expect((await api('POST', 'rooms.adminRooms.addUser', { roomId: grupo, userId: u.userId }, A)).status).toBe(200);
  });
});

describe('migração 033', () => {
  const sql = () => fs.readFileSync(path.resolve(import.meta.dirname, '../src/db/migrations/033_rbac_v2.sql'), 'utf8');

  it('quem via Admin › Salas ganha as duas chaves de adicionar, com histórico; rodar de novo não grava nada', async () => {
    await pool.query(`INSERT INTO roles (id, description, scope) VALUES ('salas-mig', 'Salas', 'Users'), ('sala-mig', 'De sala', 'Subscriptions')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'salas-mig') WHERE id IN ('view-room-administration', 'create-c')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'sala-mig') WHERE id = 'view-room-administration'`);
    try {
      await pool.query(sql());
      expect(await grants('salas-mig')).toEqual(['add-user-to-any-c-room', 'add-user-to-any-p-room', 'create-c', 'view-room-administration']);
      // Num papel de sala view-room-administration não vale: ele não ganha nada.
      expect(await grants('sala-mig')).toEqual(['view-room-administration']);
      const h = (await pool.query(`SELECT * FROM rbac_history WHERE entity_id = 'salas-mig' ORDER BY id`)).rows;
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ entity_type: 'role', action: 'update', source: 'migration', actor_id: null });
      expect(h[0].changes).toEqual([
        { field: 'permissions', before: ['create-c', 'view-room-administration'], after: ['add-user-to-any-c-room', 'add-user-to-any-p-room', 'create-c', 'view-room-administration'] },
      ]);
      await pool.query(sql());
      expect((await pool.query(`SELECT count(*)::int AS n FROM rbac_history WHERE entity_id IN ('salas-mig', 'sala-mig')`)).rows[0].n).toBe(1);
    } finally {
      await pool.query(`UPDATE permissions SET roles = array_remove(array_remove(roles, 'salas-mig'), 'sala-mig')`);
      await pool.query(`DELETE FROM roles WHERE id IN ('salas-mig', 'sala-mig')`);
      await loadPermissions();
    }
  });
});
