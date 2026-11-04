import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { loadPermissions, seedPermissions } from '../src/services/permissions';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

// Papéis e permissões v2. Primeiro os dois buracos fechados: dar papel de sala por roles.addUserToRole (quem tinha
// manage-roles virava Dono de qualquer sala) e pôr gente em qualquer sala pelo Admin › Salas só com "Visualizar".
let A: Auth;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const grants = async (role: string) => (await pool.query('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [role])).rows.map((r) => r.id);
const subRoles = async (rid: string, uid: string) => (await pool.query('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, uid])).rows[0]?.roles as string[] | undefined;
const isMember = async (rid: string, uid: string) => (await pool.query('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, uid])).rowCount === 1;
const systemCount = async (rid: string, t: string) => Number((await pool.query('SELECT count(*) AS n FROM messages WHERE room_id = $1 AND t = $2', [rid, t])).rows[0].n);
const lastHistory = async (entityId: string) => (await pool.query('SELECT * FROM rbac_history WHERE entity_id = $1 ORDER BY id DESC LIMIT 1', [entityId])).rows[0];
const rolesOf = async (userId: string) => (await pool.query('SELECT roles FROM users WHERE id = $1', [userId])).rows[0].roles as string[];
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

describe('assign-roles: dar e tirar papéis de pessoas', () => {
  it('nasce numa instalação existente com quem já dava papéis (e com histórico do sistema)', async () => {
    await pool.query(`INSERT INTO roles (id, description, scope) VALUES ('gestor-v2', 'Gestor', 'Users')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'gestor-v2') WHERE id = 'edit-other-user-info'`);
    const holdersBefore = (await pool.query(`SELECT roles FROM permissions WHERE id = 'assign-roles'`)).rows[0].roles as string[];
    await pool.query(`DELETE FROM permissions WHERE id = 'assign-roles'`);
    try {
      await seedPermissions();
      expect(await grants('gestor-v2')).toEqual(['assign-roles', 'edit-other-user-info']);
      expect(await grants('user')).not.toContain('assign-roles');
      expect(await grants('admin')).toContain('assign-roles');
      const h = await lastHistory('gestor-v2');
      expect(h).toMatchObject({ entity_type: 'role', source: 'system', actor_id: null });
      expect(h.changes[0]).toMatchObject({ field: 'permissions', before: ['edit-other-user-info'], after: ['assign-roles', 'edit-other-user-info'] });
    } finally {
      await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'gestor-v2')`);
      await pool.query(`DELETE FROM roles WHERE id = 'gestor-v2'`);
      await pool.query(`UPDATE permissions SET roles = $1 WHERE id = 'assign-roles'`, [holdersBefore]);
      await loadPermissions();
    }
  });

  it('users.update separa dados de papéis', async () => {
    await roleWith('leitor-u', ['view-c-room']);
    await roleWith('rh-v2', ['view-user-administration', 'assign-roles']);
    await roleWith('dados-v2', ['view-user-administration', 'edit-other-user-info']);
    // A delegação deixa os dois agirem sobre quem tem o papel Usuário.
    for (const r of ['rh-v2', 'dados-v2']) expect((await api('POST', 'rbac.roles.update', { roleId: r, delegable: ['user', 'leitor-u'] }, A)).success).toBe(true);
    const rh = await newUser(A, { roles: ['rh-v2'] });
    const dados = await newUser(A, { roles: ['dados-v2'] });
    const alvo = await newUser(A, { roles: ['user'] });
    expect((await api('POST', 'users.update', { userId: alvo.userId, data: { roles: ['user', 'leitor-u'] } }, rh)).status).toBe(200);
    expect(await rolesOf(alvo.userId)).toEqual(['user', 'leitor-u']);
    const rhName = await api('POST', 'users.update', { userId: alvo.userId, data: { name: 'Outro nome' } }, rh);
    expect(rhName).toMatchObject({ status: 403, error: 'Sem permissão para editar os dados de outras pessoas.' });
    expect((await api('POST', 'users.update', { userId: alvo.userId, data: { name: 'Nome novo' } }, dados)).status).toBe(200);
    const dadosRoles = await api('POST', 'users.update', { userId: alvo.userId, data: { roles: ['user'] } }, dados);
    expect(dadosRoles).toMatchObject({ status: 403, error: 'Sem permissão para dar ou tirar papéis.' });
    expect((await api('POST', 'rbac.users.setRoles', { userId: alvo.userId, roles: ['user'] }, dados)).status).toBe(403);
    // Ativar e desativar pedem a chave própria, também por users.update (o mesmo valor passa).
    expect((await api('POST', 'users.update', { userId: alvo.userId, data: { active: false } }, dados)).status).toBe(403);
    expect((await api('POST', 'users.update', { userId: alvo.userId, data: { active: true, name: 'Nome novo' } }, dados)).status).toBe(200);
    expect(await rolesOf(alvo.userId)).toEqual(['user', 'leitor-u']);
  });

  it('papel de sala não vira papel global', async () => {
    const u = await newUser(A);
    const r = await api('POST', 'rbac.users.setRoles', { userId: u.userId, roles: ['user', 'moderator'] }, A);
    expect(r).toMatchObject({ status: 400, errorType: 'error-invalid-role' });
    expect((await api('POST', 'rbac.users.bulkRoles', { userIds: [u.userId], add: ['owner'] }, A)).status).toBe(400);
  });
});

describe('roles.addUserToRole com sala passa pelas regras de papel de sala', () => {
  let ana: Auth;
  let bia: Auth;
  beforeAll(async () => {
    // Gerencia papéis, mas não tem Definir donos (set-owner) em sala nenhuma.
    await roleWith('papeis', ['view-permissions', 'manage-roles', 'access-permissions', 'assign-roles']);
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

describe('roles.getUsersInRole de papel de sala', () => {
  it('sem roomId, devolve quem tem o papel em alguma sala', async () => {
    await api('POST', 'channels.create', { name: uniq('dono-alguma') }, A);
    const r = await api('GET', 'roles.getUsersInRole', { role: 'owner' }, A);
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.users.map((u: any) => u._id)).toContain(A.userId);
  });
});

describe('matriz, deltas, Quem pode…?, papéis em salas, simulação e lote', () => {
  let sup: Auth;
  let plain: Auth;
  let viewer: Auth;
  let auditor: Auth;
  beforeAll(async () => {
    await roleWith('sup-v2', ['view-user-administration', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status', 'view-permissions', 'access-permissions', 'manage-roles', 'assign-roles']);
    await roleWith('leitor-v2', ['view-c-room']);
    await roleWith('ver-papeis', ['view-permissions']);
    sup = await newUser(A, { roles: ['user', 'sup-v2'] });
    plain = await newUser(A, { roles: ['user'] });
    viewer = await newUser(A, { roles: ['user', 'ver-papeis'] });
    auditor = await newUser(A, { roles: ['user', 'auditor'] });
  });

  it('rbac.matrix.update: dois papéis num lote só, com auditoria', async () => {
    const r = await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-c'] }, { roleId: 'ver-papeis', add: ['mention-here'] }] }, A);
    expect(r.status).toBe(200);
    expect(r.batchId).toBeTruthy();
    expect(r.roles).toEqual([
      { _id: 'leitor-v2', permissions: ['create-c', 'view-c-room'] },
      { _id: 'ver-papeis', permissions: ['mention-here', 'view-permissions'] },
    ]);
    const rows = (await pool.query('SELECT entity_id FROM rbac_history WHERE batch_id = $1 ORDER BY entity_id', [r.batchId])).rows;
    expect(rows.map((x) => x.entity_id)).toEqual(['leitor-v2', 'ver-papeis']);
    const log = (await pool.query(`SELECT * FROM audit_log WHERE action = 'permissions.changed' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(log.data.changes).toHaveLength(2);
    await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', remove: ['create-c'] }, { roleId: 'ver-papeis', remove: ['mention-here'] }] }, A);
  });

  it('rbac.matrix.update: mesmas travas, e nada grava quando um papel falha', async () => {
    const notHeld = await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['manage-calls'] }] }, sup);
    expect(notHeld).toMatchObject({ status: 403, errorType: 'RBAC_PERMISSION_NOT_HELD', details: { keys: ['manage-calls'], roleId: 'leitor-v2' } });
    expect((await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'admin', remove: ['assign-roles'] }] }, A)).errorType).toBe('RBAC_ROOT_LOCKOUT');
    expect((await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'nao-existe', add: ['create-c'] }] }, A)).status).toBe(404);
    expect((await api('POST', 'rbac.matrix.update', { changes: [] }, A))).toMatchObject({ status: 400, error: 'Nenhuma alteração.' });
    expect((await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-c'], remove: ['create-c'] }] }, A)).status).toBe(400);
    // Tudo ou nada: o primeiro papel seria válido, o segundo não.
    const mixed = await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-c'] }, { roleId: 'ver-papeis', add: ['manage-calls'] }] }, sup);
    expect(mixed.status).toBe(403);
    expect(await grants('leitor-v2')).toEqual(['view-c-room']);
    // Sem access-permissions, nem chega.
    expect((await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-c'] }] }, viewer)).status).toBe(403);
  });

  it('salvar papel aplica a diferença: o que outra pessoa salvou nesse meio-tempo fica', async () => {
    const base = await grants('leitor-v2');
    // B salva pela matriz enquanto A está com o papel aberto.
    expect((await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-p'] }] }, A)).status).toBe(200);
    const r = await api('POST', 'rbac.roles.update', { roleId: 'leitor-v2', permissions: [...base, 'create-c'], basePermissions: base }, A);
    expect(r.status).toBe(200);
    expect(r.role.permissions).toEqual(['create-c', 'create-p', 'view-c-room']);
    expect(await grants('leitor-v2')).toEqual(['create-c', 'create-p', 'view-c-room']);
    // Sem basePermissions, o comportamento antigo (a lista que veio vale).
    expect((await api('POST', 'rbac.roles.update', { roleId: 'leitor-v2', permissions: ['view-c-room'] }, A)).status).toBe(200);
    expect(await grants('leitor-v2')).toEqual(['view-c-room']);
  });

  it('permissions.update (Rocket.Chat) segue o mesmo caminho: lote quando muda dois papéis', async () => {
    const roles = (await pool.query(`SELECT roles FROM permissions WHERE id = 'pin-message'`)).rows[0].roles as string[];
    const r = await api('POST', 'permissions.update', { permissions: [{ _id: 'pin-message', roles: [...roles, 'leitor-v2', 'ver-papeis'] }] }, A);
    expect(r.status).toBe(200);
    const h = await lastHistory('leitor-v2');
    expect(h.batch_id).toBeTruthy();
    expect((await lastHistory('ver-papeis')).batch_id).toBe(h.batch_id);
    expect((await api('POST', 'permissions.update', { permissions: [{ _id: 'pin-message', roles }] }, A)).status).toBe(200);
    expect(await grants('leitor-v2')).toEqual(['view-c-room']);
  });

  it('o evento permissions.changed diz quais papéis mudaram e quem mudou', async () => {
    const ws = connectWs(A);
    await ws.ready;
    try {
      await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', add: ['create-c'] }] }, A);
      const ev = await ws.waitFor((e) => e.type === 'permissions.changed' && e.roles?.includes('leitor-v2'));
      expect(ev).toMatchObject({ type: 'permissions.changed', roles: ['leitor-v2'], by: A.userId });
    } finally {
      ws.close();
      await api('POST', 'rbac.matrix.update', { changes: [{ roleId: 'leitor-v2', remove: ['create-c'] }] }, A);
    }
  });

  it('Quem pode…?: papéis globais, de sala, sem efeito e pessoas com o porquê', async () => {
    const audit = await api('GET', 'rbac.whoCan', { permission: 'can-audit' }, A);
    expect(audit).toMatchObject({ permission: 'can-audit', legacy: false, checkedIn: 'global' });
    expect(audit.roles.map((r: any) => r._id)).toEqual(expect.arrayContaining(['admin', 'auditor']));
    expect(audit.roles.find((r: any) => r._id === 'admin').root).toBe(true);
    const person = audit.people.items.find((p: any) => p._id === auditor.userId);
    expect(person).toMatchObject({ via: ['auditor'], active: true, restricted: false });

    await api('POST', 'channels.create', { name: uniq('quem-pode') }, A);
    const del = await api('GET', 'rbac.whoCan', { permission: 'delete-message' }, A);
    expect(del.checkedIn).toBe('room');
    expect(del.roomRoles.find((r: any) => r._id === 'owner').assignments).toBeGreaterThanOrEqual(1);
    // Papel de sala com uma chave que não é checada nas salas: aparece como sem efeito.
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'owner') WHERE id = 'can-audit'`);
    await loadPermissions();
    try {
      expect((await api('GET', 'rbac.whoCan', { permission: 'can-audit' }, A)).inert).toEqual(['owner']);
    } finally {
      await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'owner') WHERE id = 'can-audit'`);
      await loadPermissions();
    }

    // Sem ver usuários: só os papéis.
    const v = await api('GET', 'rbac.whoCan', { permission: 'can-audit' }, viewer);
    expect(v.status).toBe(200);
    expect(v.people).toBeNull();
    expect((await api('GET', 'rbac.whoCan', { permission: 'can-audit' }, plain)).status).toBe(403);

    // Desativada só com includeInactive; filtro por nome.
    await api('POST', 'users.setActiveStatus', { userId: auditor.userId, activeStatus: false }, A);
    try {
      expect((await api('GET', 'rbac.whoCan', { permission: 'can-audit' }, A)).people.items.map((p: any) => p._id)).not.toContain(auditor.userId);
      const all = await api('GET', 'rbac.whoCan', { permission: 'can-audit', includeInactive: 'true', q: auditor.username }, A);
      expect(all.people.items).toEqual([expect.objectContaining({ _id: auditor.userId, active: false })]);
      expect(all.people.total).toBe(1);
    } finally {
      await api('POST', 'users.setActiveStatus', { userId: auditor.userId, activeStatus: true }, A);
    }
    expect((await api('GET', 'rbac.whoCan', { permission: 'nao-existe' }, A))).toMatchObject({ status: 400, errorType: 'error-invalid-permission' });
    expect((await api('GET', 'rbac.whoCan', { permission: 'view-p-room' }, A)).legacy).toBe(true);
  });

  it('Quem pode…? marca quem é restrito (Operação)', async () => {
    const op = await newUser(A, { roles: ['operacao'] });
    const r = await api('GET', 'rbac.whoCan', { permission: 'create-d', q: op.username }, A);
    expect(r.people.items).toEqual([expect.objectContaining({ _id: op.userId, via: ['operacao'], restricted: true })]);
  });

  it('papéis em salas: por papel, com grupo privado oculto para quem não participa; DMs nunca', async () => {
    const ch = (await api('POST', 'channels.create', { name: uniq('canal-dono') }, A)).channel;
    const grp = (await api('POST', 'groups.create', { name: uniq('grupo-oculto') }, A)).group;
    await api('POST', 'im.create', { username: plain.username }, A);
    const all = await api('GET', 'rbac.roomRoles', { role: 'owner', count: 100 }, A);
    expect(all.items.find((i: any) => i.room._id === ch._id)).toMatchObject({ room: { name: ch.name, t: 'c' }, user: { _id: A.userId }, roles: ['owner'] });
    expect(all.items.find((i: any) => i.room._id === grp._id)?.room.name).toBe(grp.name);
    expect(all.items.every((i: any) => i.room.t !== 'd')).toBe(true);
    const v = await api('GET', 'rbac.roomRoles', { role: 'owner', userId: A.userId, count: 100 }, viewer);
    expect(v.status).toBe(200);
    expect(v.items.some((i: any) => i.room.hidden && i.room.t === 'p')).toBe(true);
    expect(v.items.some((i: any) => i.room._id === grp._id)).toBe(false);
    expect(v.items.some((i: any) => i.room._id === ch._id)).toBe(true);
    expect((await api('GET', 'rbac.roomRoles', {}, A))).toMatchObject({ status: 400, error: 'Escolha um papel, uma pessoa ou uma sala.' });
  });

  it('acesso efetivo: simula antes de salvar e mostra as restrições', async () => {
    const r = await api('GET', 'rbac.users.effective', { userId: plain.userId, roles: 'user,auditor' }, A);
    expect(r.simulated.roles).toEqual(['user', 'auditor']);
    expect(r.simulated.diff.areas).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'admin-audit', direction: 'up' })]));
    expect(r.restrictions).toEqual({ restrictDirect: [], mandatory2fa: [] });
    expect((await api('GET', 'rbac.users.effective', { userId: plain.userId, roles: 'user,nao-existe' }, A))).toMatchObject({ status: 400, errorType: 'error-invalid-role' });
    const op = await newUser(A, { roles: ['operacao'] });
    expect((await api('GET', 'rbac.users.effective', { userId: op.userId }, A)).restrictions.restrictDirect).toEqual(['operacao']);
  });

  it('papéis em lote com prévia: quem recebe, quem fica de fora e por quê', async () => {
    const ids = [plain.userId, A.userId, sup.userId];
    const preview = await api('POST', 'rbac.users.bulkRoles', { userIds: ids, add: ['leitor-v2'], dryRun: true }, sup);
    expect(preview.ok).toEqual([{ _id: plain.userId, username: plain.username }]);
    expect(preview.blocked).toEqual(
      expect.arrayContaining([
        { _id: A.userId, username: 'admin', reason: 'root-only' },
        { _id: sup.userId, username: sup.username, reason: 'self' },
      ]),
    );
    expect(preview.unchanged).toEqual([]);
    expect(await rolesOf(plain.userId)).toEqual(['user']);
    const all = await api('POST', 'rbac.users.bulkRoles', { userIds: ids, add: ['leitor-v2'] }, sup);
    expect(all.status).toBe(403);
    expect(await rolesOf(plain.userId)).toEqual(['user']);
    const skip = await api('POST', 'rbac.users.bulkRoles', { userIds: ids, add: ['leitor-v2'], skipBlocked: true }, sup);
    expect(skip).toMatchObject({ status: 200, users: 1, skipped: 2 });
    expect(await rolesOf(plain.userId)).toEqual(['user', 'leitor-v2']);
    const rows = (await pool.query('SELECT action, entity_id FROM rbac_history WHERE batch_id = $1', [skip.batchId])).rows;
    expect(rows).toEqual([{ action: 'bulk', entity_id: plain.userId }]);
    // Quem já tem fica em "já têm"; papel que não pode dar vem com o nome.
    const again = await api('POST', 'rbac.users.bulkRoles', { userIds: [plain.userId], add: ['leitor-v2'], dryRun: true }, sup);
    expect(again.unchanged).toEqual([{ _id: plain.userId, username: plain.username }]);
    const notAssignable = await api('POST', 'rbac.users.bulkRoles', { userIds: [plain.userId], add: ['bot'], dryRun: true }, sup);
    expect(notAssignable.blocked).toEqual([{ _id: plain.userId, username: plain.username, reason: 'not-assignable', roles: ['bot'] }]);
    // Quem tem cadeado fica de fora mesmo sem ter o papel; no "tudo ou nada" ele não trava, porque nada mudaria nele.
    const removeIdle = await api('POST', 'rbac.users.bulkRoles', { userIds: [plain.userId, A.userId], remove: ['leitor-v2'], dryRun: true }, sup);
    expect(removeIdle.ok).toEqual([{ _id: plain.userId, username: plain.username }]);
    expect(removeIdle.blocked).toEqual([{ _id: A.userId, username: 'admin', reason: 'root-only' }]);
    const strict = await api('POST', 'rbac.users.bulkRoles', { userIds: [plain.userId, A.userId], remove: ['leitor-v2'] }, sup);
    expect(strict).toMatchObject({ status: 200, users: 1, skipped: 1 });
    expect(await rolesOf(plain.userId)).toEqual(['user']);
  });

  it('o último administrador ativo não sai pelo lote', async () => {
    const r = await api('POST', 'rbac.users.bulkRoles', { userIds: [A.userId], remove: ['admin'], dryRun: true }, A);
    expect(r.blocked).toEqual([{ _id: A.userId, username: 'admin', reason: 'last-admin' }]);
    expect((await api('POST', 'rbac.users.bulkRoles', { userIds: [A.userId], remove: ['admin'] }, A)).status).toBe(400);
  });

  it('"Para que serve": cria, atualiza, histórico, reversão e limite de 200 caracteres', async () => {
    const c = await api('POST', 'rbac.roles.create', { name: 'proposito', description: 'Propósito', purpose: 'Cuida do turno da noite.' }, A);
    expect(c.role.purpose).toBe('Cuida do turno da noite.');
    const u = await api('POST', 'rbac.roles.update', { roleId: 'proposito', purpose: 'Cuida dos turnos da noite e do fim de semana.' }, A);
    expect(u.role.purpose).toBe('Cuida dos turnos da noite e do fim de semana.');
    const h = await lastHistory('proposito');
    expect(h.changes).toEqual([expect.objectContaining({ field: 'purpose', before: 'Cuida do turno da noite.', after: 'Cuida dos turnos da noite e do fim de semana.' })].concat(h.changes.filter((x: any) => x.field !== 'purpose')));
    expect((await api('POST', 'rbac.history.rollback', { id: h.id }, A)).success).toBe(true);
    expect((await pool.query(`SELECT purpose FROM roles WHERE id = 'proposito'`)).rows[0].purpose).toBe('Cuida do turno da noite.');
    await api('POST', 'rbac.roles.update', { roleId: 'proposito', purpose: 'x'.repeat(260) }, A);
    expect((await pool.query(`SELECT purpose FROM roles WHERE id = 'proposito'`)).rows[0].purpose).toHaveLength(200);
    const list = await api('GET', 'rbac.roles', {}, A);
    expect(list.roles.find((r: any) => r._id === 'operacao').purpose).toBe('Turno de operação: lê canais e conversa em particular só com quem não é restrito.');
  });

  it('o papel raiz pela flag nas integrações', async () => {
    expect((await api('POST', 'integrations.secretsKey.reencrypt', {}, sup)).status).toBe(403);
    expect((await api('POST', 'integrations.secretsKey.reencrypt', {}, A)).status).not.toBe(403);
  });
});

describe('migração 033: para que serve', () => {
  it('descrição longa ou com pontuação vira o para que serve; a curta continua só nome', async () => {
    const long = 'Equipe que atende os chamados do turno noturno';
    await pool.query(`INSERT INTO roles (id, description, scope) VALUES ('mig-longo', $1, 'Users'), ('mig-curto', 'Curto', 'Users'), ('mig-ponto', 'Faz isso.', 'Users')`, [long]);
    try {
      await pool.query(fs.readFileSync(path.resolve(import.meta.dirname, '../src/db/migrations/033_rbac_v2.sql'), 'utf8'));
      const rows = Object.fromEntries((await pool.query(`SELECT id, purpose FROM roles WHERE id LIKE 'mig-%'`)).rows.map((r) => [r.id, r.purpose]));
      expect(rows).toEqual({ 'mig-longo': long, 'mig-curto': '', 'mig-ponto': 'Faz isso.' });
      expect((await pool.query(`SELECT purpose FROM roles WHERE id = 'admin'`)).rows[0].purpose).toBe('');
    } finally {
      await pool.query(`DELETE FROM roles WHERE id LIKE 'mig-%'`);
      await loadPermissions();
    }
  });
});

// Achados da revisão: o Usuário que entra quando a lista fica vazia passa pela hierarquia como qualquer papel, e
// users.update só grava papéis pelo caminho com as travas (nunca direto na linha).
describe('supervisor que só dá Operação', () => {
  let sup: Auth;
  let contas: Auth;
  beforeAll(async () => {
    await roleWith('sup-op-v2', ['view-user-administration', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status', 'logout-other-user', 'assign-roles']);
    expect((await api('POST', 'rbac.roles.update', { roleId: 'sup-op-v2', delegable: ['operacao'] }, A)).success).toBe(true);
    sup = await newUser(A, { roles: ['sup-op-v2'] });
    await roleWith('contas-v2', ['view-user-administration', 'edit-other-user-active-status', 'logout-other-user']);
    contas = await newUser(A, { roles: ['user', 'contas-v2'] });
  });

  it('não transforma ninguém em Usuário tirando o último papel', async () => {
    const g = await api('GET', 'rbac.grantContext', {}, sup);
    expect(g.roleLocks).toMatchObject({ operacao: null, user: 'superior' });
    const op = await newUser(A, { roles: ['operacao'] });
    const histBefore = Number((await pool.query('SELECT count(*) AS n FROM rbac_history WHERE entity_id = $1', [op.userId])).rows[0].n);

    const preview = await api('POST', 'rbac.users.bulkRoles', { userIds: [op.userId], remove: ['operacao'], dryRun: true }, sup);
    expect(preview.ok).toEqual([]);
    expect(preview.blocked).toEqual([{ _id: op.userId, username: op.username, reason: 'not-assignable', roles: ['user'] }]);
    expect(await api('POST', 'rbac.users.bulkRoles', { userIds: [op.userId], remove: ['operacao'], skipBlocked: true }, sup)).toMatchObject({ status: 200, users: 0, skipped: 1 });
    expect((await api('POST', 'rbac.users.bulkRoles', { userIds: [op.userId], remove: ['operacao'] }, sup)).errorType).toBe('RBAC_ROLE_NOT_ASSIGNABLE');
    expect((await api('POST', 'roles.removeUserFromRole', { roleId: 'operacao', userId: op.userId }, sup)).errorType).toBe('RBAC_ROLE_NOT_ASSIGNABLE');
    expect((await api('POST', 'rbac.users.setRoles', { userId: op.userId, roles: [] }, sup)).errorType).toBe('RBAC_ROLE_NOT_ASSIGNABLE');
    expect((await api('POST', 'users.update', { userId: op.userId, data: { roles: [] } }, sup)).errorType).toBe('RBAC_ROLE_NOT_ASSIGNABLE');
    expect(await rolesOf(op.userId)).toEqual(['operacao']);
    expect((await api('POST', 'groups.create', { name: uniq('grupo-op') }, op)).status).toBe(403);
    expect(Number((await pool.query('SELECT count(*) AS n FROM rbac_history WHERE entity_id = $1', [op.userId])).rows[0].n)).toBe(histBefore);

    // Dar e tirar Operação continua: o papel delegado entra e sai de quem tem outro papel que ele gerencia.
    const op2 = await newUser(A, { roles: ['operacao'] });
    expect((await api('POST', 'rbac.users.setRoles', { userId: op2.userId, roles: ['operacao'] }, sup)).status).toBe(200);

    // Criar conta sem papel é dar Usuário: recusado para quem não o dá; com Operação, passa.
    const semPapel = await api('POST', 'users.create', { username: uniq('sem-papel'), name: 'Sem papel', password: 'senha-forte-1' }, sup);
    expect(semPapel).toMatchObject({ status: 403, errorType: 'RBAC_ROLE_NOT_ASSIGNABLE' });
    const comOp = await api('POST', 'users.create', { username: uniq('com-op'), name: 'Com Operação', password: 'senha-forte-1', roles: ['operacao'] }, sup);
    expect(comOp.status).toBe(200);
    expect(comOp.user.roles).toEqual(['operacao']);
  });

  it('o administrador tira o último papel: a prévia avisa que a pessoa fica com Usuário', async () => {
    const op = await newUser(A, { roles: ['operacao'] });
    const preview = await api('POST', 'rbac.users.bulkRoles', { userIds: [op.userId], remove: ['operacao'], dryRun: true }, A);
    expect(preview.ok).toEqual([{ _id: op.userId, username: op.username, fallbackUser: true }]);
    expect(await api('POST', 'rbac.users.bulkRoles', { userIds: [op.userId], remove: ['operacao'] }, A)).toMatchObject({ status: 200, users: 1 });
    expect(await rolesOf(op.userId)).toEqual(['user']);
    // Quem já tinha Usuário não "cai" nele: sem aviso.
    const both = await newUser(A, { roles: ['user', 'operacao'] });
    expect((await api('POST', 'rbac.users.bulkRoles', { userIds: [both.userId], remove: ['operacao'], dryRun: true }, A)).ok).toEqual([{ _id: both.userId, username: both.username }]);
  });

  it('users.update recusa roles que não são lista (vazio, false, null, 0) sem gravar nada', async () => {
    const op = await newUser(A, { roles: ['operacao'] });
    const hist = async (id: string) => Number((await pool.query('SELECT count(*) AS n FROM rbac_history WHERE entity_id = $1', [id])).rows[0].n);
    const before = await hist(op.userId);
    for (const roles of ['', false, null, 0, {}, [1]]) {
      const r = await api('POST', 'users.update', { userId: op.userId, data: { roles } }, sup);
      expect(r, JSON.stringify(roles)).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
    }
    expect(await rolesOf(op.userId)).toEqual(['operacao']);
    expect(await hist(op.userId)).toBe(before);
    // Os próprios papéis e o último administrador continuam travados por esse caminho.
    expect((await api('POST', 'users.update', { userId: sup.userId, data: { roles: '' } }, sup)).status).toBe(400);
    expect(await rolesOf(sup.userId)).toEqual(['sup-op-v2']);
    expect((await api('POST', 'users.update', { userId: sup.userId, data: { roles: ['operacao'] } }, sup)).errorType).toBe('RBAC_SELF_ESCALATION');
    expect((await api('POST', 'users.update', { userId: A.userId, data: { roles: '' } }, A)).status).toBe(400);
    expect(await rolesOf(A.userId)).toContain('admin');
    // Lista válida (também como texto com vírgula) grava pelo caminho com histórico e evento.
    const ws = connectWs(A);
    await ws.ready;
    try {
      const evt = ws.waitFor((e: any) => e.type === 'user' && e.user?._id === op.userId && e.user.roles?.includes('admin'));
      const ok = await api('POST', 'users.update', { userId: op.userId, data: { roles: 'operacao,admin' } }, A);
      expect(ok.status).toBe(200);
      expect(await rolesOf(op.userId)).toEqual(['operacao', 'admin']);
      expect(await hist(op.userId)).toBe(before + 1);
      await evt;
    } finally {
      ws.close();
    }
    expect((await api('POST', 'rbac.users.setRoles', { userId: op.userId, roles: ['operacao'] }, A)).status).toBe(200);
  });

  it('ativar, desativar e encerrar sessões em lote numa chamada só, sem a própria conta e sem cadeado', async () => {
    const ops = [await newUser(A, { roles: ['operacao'] }), await newUser(A, { roles: ['operacao'] })];
    const plainUser = await newUser(A, { roles: ['user'] });
    const ids = [...ops.map((o) => o.userId), plainUser.userId, A.userId, sup.userId];
    const off = await api('POST', 'users.bulkSetActiveStatus', { userIds: ids, activeStatus: false }, sup);
    expect(off).toMatchObject({ status: 200, users: 2, skipped: { self: 1, locked: 2, unchanged: 0 } });
    for (const o of ops) expect((await pool.query('SELECT active FROM users WHERE id = $1', [o.userId])).rows[0].active).toBe(false);
    expect((await pool.query('SELECT active FROM users WHERE id = $1', [plainUser.userId])).rows[0].active).toBe(true);
    // Desativar encerra as sessões, como no individual.
    expect((await api('GET', 'me', undefined, ops[0])).status).toBe(401);
    expect(await api('POST', 'users.bulkSetActiveStatus', { userIds: ops.map((o) => o.userId), activeStatus: false }, sup)).toMatchObject({ users: 0, skipped: { unchanged: 2 } });
    expect(await api('POST', 'users.bulkSetActiveStatus', { userIds: ops.map((o) => o.userId), activeStatus: true }, sup)).toMatchObject({ users: 2 });

    const a = await newUser(A, { roles: ['user'] });
    const out = await api('POST', 'users.bulkLogout', { userIds: [a.userId, contas.userId, A.userId] }, contas);
    expect(out).toMatchObject({ status: 200, users: 1, skipped: { self: 1, locked: 1 } });
    expect(out.sessions).toBeGreaterThanOrEqual(1);
    expect((await api('GET', 'me', undefined, a)).status).toBe(401);
    expect((await api('GET', 'me', undefined, contas))._id).toBe(contas.userId);

    expect((await api('POST', 'users.bulkLogout', { userIds: [a.userId] }, plainUser)).status).toBe(403);
    expect((await api('POST', 'users.bulkSetActiveStatus', { userIds: [], activeStatus: false }, sup)).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => `x${i}`);
    expect(await api('POST', 'users.bulkSetActiveStatus', { userIds: many, activeStatus: false }, sup)).toMatchObject({ status: 400, error: 'Até 500 pessoas por vez.' });
    expect((await api('POST', 'users.bulkLogout', { userIds: ['nao-existe'] }, contas)).status).toBe(404);
  });

  it('Quem pode…? conta pessoas distintas nos papéis de sala; users.info mostra o e-mail a quem vê a lista', async () => {
    const dona = await newUser(A, { roles: ['user'] });
    for (let i = 0; i < 3; i++) expect((await api('POST', 'channels.create', { name: uniq('dona-tres') }, dona)).status).toBe(200);
    const r = await api('GET', 'rbac.whoCan', { permission: 'delete-message' }, A);
    const owner = r.roomRoles.find((x: any) => x._id === 'owner');
    const db = (await pool.query(`SELECT count(DISTINCT user_id)::int AS users, count(*)::int AS assignments, count(DISTINCT room_id)::int AS rooms FROM subscriptions WHERE 'owner' = ANY(roles)`)).rows[0];
    expect(owner).toEqual({ _id: 'owner', ...db });
    expect(owner.users).toBeLessThan(owner.assignments);

    const info = await api('GET', 'users.info', { userId: dona.userId }, contas);
    expect(info.user).toMatchObject({ email: expect.stringContaining('@test.local'), emailVerified: expect.any(Boolean) });
    const plainUser = await newUser(A, { roles: ['user'] });
    expect((await api('GET', 'users.info', { userId: dona.userId }, plainUser)).user.email).toBeUndefined();
  });
});

describe('nome de papel: nenhum papel criado se passa por outro', () => {
  it('recusa "admin " e "admin.", o nome de exibição de um papel padrão e o de outro papel; editar a descrição também', async () => {
    const mano = await newUser(A);
    await roleWith(uniq('so-papeis'), ['manage-roles']);
    const roleId = (await pool.query(`SELECT id FROM roles WHERE id LIKE 'so-papeis-%' ORDER BY id DESC LIMIT 1`)).rows[0].id;
    expect((await api('POST', 'roles.addUserToRole', { roleName: roleId, userId: mano.userId }, A)).success).toBe(true);
    for (const name of ['admin ', 'admin.', 'Admin', ' admin', 'ad-min', '.oculto']) {
      const r = await api('POST', 'rbac.roles.create', { name, description: 'Papel' }, mano);
      expect(r.success, name).toBe(false);
      expect(['RBAC_RESERVED_ROLE_NAME', 'error-invalid-role-name']).toContain(r.errorType);
    }
    // Nome de exibição de papel padrão (sem maiúsculas e acentos) ou de outro papel.
    for (const description of ['Administrador', 'administrador', 'ADMIN', 'Usuário', 'usuario', 'Auditor', 'Dono']) {
      const r = await api('POST', 'rbac.roles.create', { name: uniq('falso'), description }, mano);
      expect(r.errorType, description).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    }
    const turno = uniq('turno');
    expect((await api('POST', 'rbac.roles.create', { name: turno, description: 'Chefe de turno' }, mano)).success).toBe(true);
    expect((await api('POST', 'rbac.roles.create', { name: uniq('turno2'), description: 'chefe de TURNO' }, mano)).errorType).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    // Um identificador que dobra no de outro papel.
    expect((await api('POST', 'rbac.roles.create', { name: `${turno.toUpperCase()}`, description: 'Outro' }, mano)).errorType).toBe('error-duplicate-role-names-not-allowed');
    // Editar a descrição para a de um papel padrão também é recusado; a mesma descrição de antes passa.
    expect((await api('POST', 'rbac.roles.update', { roleId: turno, description: 'Administrador' }, mano)).errorType).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect((await api('POST', 'rbac.roles.update', { roleId: turno, description: 'Chefe de turno', purpose: 'Turno da noite' }, mano)).success).toBe(true);
    const list = (await api('GET', 'roles.list', undefined, mano)).roles as { _id: string; description: string }[];
    expect(list.filter((r) => r.description === 'Administrador').map((r) => r._id)).toEqual(['admin']);
  });

  // Sobras da validação final: o "Administrador" com letras de outro alfabeto, de largura total ou com invisíveis
  // passava, e o "Dono da sala" (a descrição do papel padrão) também. Nas rotas novas e nas antigas, ao criar e ao
  // renomear.
  it('letras parecidas, largura total, invisíveis e controles de direção não passam em rbac.* nem em roles.*', async () => {
    const mano = await newUser(A);
    const papel = uniq('so-papeis-2');
    await roleWith(papel, ['manage-roles']);
    expect((await api('POST', 'roles.addUserToRole', { roleName: papel, userId: mano.userId }, A)).success).toBe(true);
    const lookAlikes = [
      '\u0410dmin', // A cirílico
      '\u0410dministrador',
      'Administr\u0430dor', // a cirílico no meio
      'Administrad\u03bfr', // ο grego
      '\uff21\uff44\uff4d\uff49\uff4e', // Ａｄｍｉｎ
      'Ad\u200bmin', // largura zero
      '\u200fAdministrador\u200e', // marcas de direção
      'Dono da sala',
      'D\u043eno da s\u0430la',
      'Moderador da sala',
      // Revisão final: traço no lugar do i, lisu, copta, cherokee minúsculo e mistura de alfabetos.
      'Adm|n',
      '\ua4ee\ua4d3\ua4df\ua4f2\ua4e0', // ꓮꓓꓟꓲꓠ
      '\u2c80dmin', // Ⲁdmin
      'Administrad\u2c9fr', // ⲟ copta
      '\uab7admin', // ꭺdmin
      'Chefe d\u0435 turno', // е cirílico, sem imitar ninguém: mistura alfabetos
    ];
    const turno = uniq('turno-b');
    expect((await api('POST', 'rbac.roles.create', { name: turno, description: 'Chefe de turno B' }, mano)).success).toBe(true);
    for (const description of lookAlikes) {
      const novo = await api('POST', 'rbac.roles.create', { name: uniq('falso'), description }, mano);
      expect(novo.status, description).toBe(400);
      expect(['RBAC_DUPLICATE_ROLE_LABEL', 'RBAC_INVALID_ROLE_LABEL'], description).toContain(novo.errorType);
      expect((await api('POST', 'roles.create', { name: uniq('falso'), description }, mano)).errorType, description).toBe(novo.errorType);
      expect((await api('POST', 'rbac.roles.update', { roleId: turno, description }, mano)).errorType, description).toBe(novo.errorType);
      expect((await api('POST', 'roles.update', { roleId: turno, description }, mano)).errorType, description).toBe(novo.errorType);
    }
    // RLO: "\u202EnimdA" aparece "Admin"; recusado de vez, com o motivo em português.
    const rlo = await api('POST', 'rbac.roles.create', { name: uniq('falso'), description: '\u202enimdA' }, mano);
    expect(rlo).toMatchObject({ status: 400, errorType: 'RBAC_INVALID_ROLE_LABEL', error: expect.stringContaining('caracteres invisíveis') });
    // O identificador também (o nome exibido vazio vira o identificador).
    for (const name of ['Adm1n', 'administrator', 'Administradora']) {
      expect((await api('POST', 'rbac.roles.create', { name, description: 'Turno' }, mano)).errorType, name).toBe('RBAC_RESERVED_ROLE_NAME');
      expect((await api('POST', 'roles.create', { name, description: 'Turno' }, mano)).errorType, name).toBe('RBAC_RESERVED_ROLE_NAME');
    }
    // Nada disso ficou gravado; o nome que só acrescenta palavras passa.
    const list = (await api('GET', 'roles.list', undefined, mano)).roles as { _id: string; description: string }[];
    expect(list.find((r) => r._id === turno)?.description).toBe('Chefe de turno B');
    expect(list.filter((r) => /^falso-/.test(r._id))).toEqual([]);
    expect((await api('POST', 'rbac.roles.create', { name: uniq('adm-noc'), description: 'Administrador do NOC' }, mano)).success).toBe(true);
    expect((await api('POST', 'roles.update', { roleId: turno, description: 'Moderador de turno' }, mano)).success).toBe(true);
  });
});

describe('users.setStatus de outra pessoa', () => {
  it('passa pela hierarquia (o supervisor não mexe no status do Administrador), fica na auditoria e erra em português', async () => {
    const sup = await newUser(A);
    const role = uniq('sup-status');
    await roleWith(role, ['edit-other-user-info']);
    expect((await api('POST', 'roles.addUserToRole', { roleName: role, userId: sup.userId }, A)).success).toBe(true);
    const plain = await newUser(A);
    const before = (await pool.query('SELECT status_text FROM users WHERE id = $1', [A.userId])).rows[0].status_text;
    const r = await api('POST', 'users.setStatus', { userId: A.userId, status: 'offline', message: 'De férias — fale com a Ana' }, sup);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('RBAC_ADMIN_ONLY');
    expect((await pool.query('SELECT status_text FROM users WHERE id = $1', [A.userId])).rows[0].status_text).toBe(before);
    // Quem ele gerencia: muda, e a auditoria guarda antes e depois.
    expect((await api('POST', 'users.setStatus', { userId: plain.userId, status: 'away', message: 'Em treinamento' }, sup)).success).toBe(true);
    const row = (await pool.query(`SELECT * FROM audit_log WHERE action = 'user.status.changedByAdmin' AND target->>'userId' = $1 ORDER BY created_at DESC LIMIT 1`, [plain.userId])).rows[0];
    expect(row?.actor_id).toBe(sup.userId);
    expect(row.data).toMatchObject({ before: { message: '' }, after: { status: 'away', message: 'Em treinamento' } });
    // Sem a permissão: a recusa em português; pessoa que não existe: 404.
    const r2 = await api('POST', 'users.setStatus', { userId: plain.userId, status: 'busy' }, await newUser(A));
    expect(r2.status).toBe(403);
    expect(r2.error).toBe('Você não tem permissão para mudar o status de outra pessoa.');
    expect((await api('POST', 'users.setStatus', { userId: 'nao-existe', status: 'busy' }, sup)).status).toBe(404);
    // O próprio status continua livre.
    expect((await api('POST', 'users.setStatus', { status: 'busy', message: 'Reunião' }, sup)).success).toBe(true);
  });

  it('as recusas padrão saem em português', async () => {
    const u = await newUser(A);
    const r = await api('GET', 'audit.log', undefined, u);
    expect(r.status).toBe(403);
    expect(r.error).toBe('Você não tem permissão para fazer isso.');
    const anon = await api('GET', 'me');
    expect(anon.status).toBe(401);
    expect(anon.error).toBe('Entre de novo para continuar.');
  });
});
