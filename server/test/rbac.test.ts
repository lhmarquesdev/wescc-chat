import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RBAC_KEYS } from '@shared/rbac';
import { pool } from '../src/db/pool';
import { loadPermissions, seedPermissions } from '../src/services/permissions';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Papéis e permissões no modelo RBAC: "ninguém ganha, ninguém perde", hierarquia de concessão, delegação, histórico e
// reversão. Os papéis do teste: supervisor (administra usuários e papéis, sem auditoria) e auditor (auditoria).
let A: Auth;
let sup: Auth;
let plain: Auth;

const grants = async (role: string) => (await pool.query('SELECT id FROM permissions WHERE $1 = ANY(roles) ORDER BY id', [role])).rows.map((r) => r.id);
const rolesOf = async (userId: string) => (await pool.query('SELECT roles FROM users WHERE id = $1', [userId])).rows[0].roles as string[];
const lastHistory = async (entityId: string) => (await pool.query('SELECT * FROM rbac_history WHERE entity_id = $1 ORDER BY id DESC LIMIT 1', [entityId])).rows[0];

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  const sv = await api('POST', 'rbac.roles.create', {
    name: 'supervisor',
    description: 'Supervisor',
    permissions: ['view-user-administration', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status', 'view-permissions', 'access-permissions', 'manage-roles'],
  }, A);
  expect(sv.success).toBe(true);
  sup = await newUser(A, { roles: ['user', 'supervisor'] });
  plain = await newUser(A, { roles: ['user'] });
});
afterAll(() => stopServer());

describe('ninguém ganha, ninguém perde', () => {
  it('os papéis padrão continuam com exatamente as permissões padrão; a chave nova só vai para quem já geria papéis', async () => {
    for (const role of ['user', 'operacao', 'owner', 'publisher', 'bot', 'guest']) {
      const expected = Object.entries(RBAC_KEYS).filter(([, k]) => k.defaults.includes(role)).map(([id]) => id).sort();
      expect(await grants(role), role).toEqual(expected);
    }
    expect(await grants('admin')).toContain('view-permissions');
  });

  it('chave nova numa instalação existente nasce com quem tinha a mãe e fica no histórico (autor: sistema)', async () => {
    await pool.query(`INSERT INTO roles (id, description, scope) VALUES ('gestor', 'Gestor', 'Users')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'gestor') WHERE id = 'manage-roles'`);
    await pool.query(`DELETE FROM permissions WHERE id = 'view-permissions'`);
    await seedPermissions();
    expect((await grants('gestor')).sort()).toEqual(['manage-roles', 'view-permissions']);
    expect((await grants('user'))).not.toContain('view-permissions');
    const h = await lastHistory('gestor');
    expect(h).toMatchObject({ entity_type: 'role', source: 'system', actor_id: null });
    expect(h.changes[0]).toMatchObject({ field: 'permissions', before: ['manage-roles'], after: ['manage-roles', 'view-permissions'] });
    // Retirar é definitivo: o próximo boot não devolve.
    await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'gestor') WHERE id = 'view-permissions'`);
    await seedPermissions();
    expect(await grants('gestor')).toEqual(['manage-roles']);
    await pool.query(`UPDATE permissions SET roles = array_remove(roles, 'gestor')`);
    await pool.query(`DELETE FROM roles WHERE id = 'gestor'`);
    await loadPermissions();
  });

  it('a migração 018 dá a quem administrava usuários a delegação dos papéis que ele já dava', async () => {
    await pool.query(`INSERT INTO roles (id, description, scope) VALUES ('rh', 'RH', 'Users'), ('cofre', 'Cofre', 'Users')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'rh') WHERE id IN ('edit-other-user-info', 'create-c')`);
    await pool.query(`UPDATE permissions SET roles = array_append(roles, 'cofre') WHERE id IN ('can-audit')`);
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../src/db/migrations/018_rbac.sql'), 'utf8');
    await pool.query(`UPDATE roles SET delegable_roles = '{}'`);
    await pool.query(sql);
    const rh = (await pool.query(`SELECT delegable_roles FROM roles WHERE id = 'rh'`)).rows[0].delegable_roles;
    // O que não cabe nas permissões do RH (cofre, supervisor, auditor...), nunca o admin nem o próprio RH.
    expect(rh).toContain('cofre');
    expect(rh).toContain('supervisor');
    expect(rh).not.toContain('admin');
    expect(rh).not.toContain('rh');
    expect((await lastHistory('rh')).source).toBe('migration');
    await pool.query(`UPDATE permissions SET roles = array_remove(array_remove(roles, 'rh'), 'cofre')`);
    await pool.query(`DELETE FROM roles WHERE id IN ('rh', 'cofre')`);
    await pool.query(`UPDATE roles SET delegable_roles = '{}'`);
    await loadPermissions();
  });
});

describe('hierarquia de concessão', () => {
  it('ninguém mexe nos próprios papéis (só o administrador)', async () => {
    const r = await api('POST', 'rbac.users.setRoles', { userId: sup.userId, roles: ['user', 'supervisor', 'auditor'] }, sup);
    expect(r).toMatchObject({ status: 403, errorType: 'RBAC_SELF_ESCALATION' });
    const viaOld = await api('POST', 'users.update', { userId: sup.userId, data: { roles: ['user'] } }, sup);
    expect(viaOld.errorType).toBe('RBAC_SELF_ESCALATION');
  });

  it('só dá papel que cabe no que tem; com delegação do administrador, dá', async () => {
    const r = await api('POST', 'rbac.users.setRoles', { userId: plain.userId, roles: ['user', 'auditor'] }, sup);
    expect(r).toMatchObject({ status: 403, errorType: 'RBAC_ROLE_NOT_ASSIGNABLE', details: { roles: ['auditor'] } });
    const old = await api('POST', 'roles.addUserToRole', { roleId: 'auditor', userId: plain.userId }, sup);
    expect(old.errorType).toBe('RBAC_ROLE_NOT_ASSIGNABLE');
    // Só o administrador define delegação.
    expect((await api('POST', 'rbac.roles.update', { roleId: 'supervisor', delegable: ['auditor'] }, sup)).errorType).toBe('RBAC_DELEGATION_ADMIN_ONLY');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'supervisor', delegable: ['admin'] }, A)).errorType).toBe('RBAC_DELEGATION_INVALID');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'supervisor', delegable: ['auditor'] }, A)).success).toBe(true);
    expect((await api('POST', 'rbac.users.setRoles', { userId: plain.userId, roles: ['user', 'auditor'] }, sup)).success).toBe(true);
    expect(await rolesOf(plain.userId)).toEqual(['user', 'auditor']);
  });

  it('nunca dá o Administrador sem assign-admin-role, nem age sobre um administrador', async () => {
    expect((await api('POST', 'rbac.users.setRoles', { userId: plain.userId, roles: ['user', 'admin'] }, sup)).status).toBe(403);
    const adminId = A.userId;
    expect((await api('POST', 'users.update', { userId: adminId, data: { password: 'outra-senha-forte-9' } }, sup)).errorType).toBe('RBAC_ADMIN_ONLY');
    expect((await api('POST', 'users.setActiveStatus', { userId: adminId, activeStatus: false }, sup)).errorType).toBe('RBAC_ADMIN_ONLY');
    // Uma pessoa comum, sim.
    expect((await api('POST', 'users.update', { userId: plain.userId, data: { name: 'Pessoa Comum' } }, sup)).success).toBe(true);
  });

  it('no papel, só dá ou tira a permissão que tem; o papel do Administrador só o administrador edita', async () => {
    const give = await api('POST', 'rbac.roles.update', { roleId: 'operacao', permissions: [...(await grants('operacao')), 'manage-calls'] }, sup);
    expect(give).toMatchObject({ status: 403, errorType: 'RBAC_PERMISSION_NOT_HELD', details: { keys: ['manage-calls'] } });
    expect((await api('POST', 'rbac.roles.update', { roleId: 'operacao', permissions: [...(await grants('operacao')), 'create-c'] }, sup)).success).toBe(true);
    expect(await grants('operacao')).toContain('create-c');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'admin', description: 'x' }, sup)).errorType).toBe('RBAC_ADMIN_ONLY');
    // A matriz antiga (permissions.update) passa pelas mesmas regras.
    expect((await api('POST', 'permissions.update', { permissions: [{ _id: 'manage-calls', roles: ['admin', 'operacao'] }] }, sup)).errorType).toBe('RBAC_PERMISSION_NOT_HELD');
    expect((await api('POST', 'permissions.update', { permissions: [{ _id: 'create-c', roles: (await pool.query(`SELECT roles FROM permissions WHERE id='create-c'`)).rows[0].roles.filter((r: string) => r !== 'operacao') }] }, sup)).success).toBe(true);
  });

  it('o Administrador não perde a gestão de papéis', async () => {
    const perms = (await grants('admin')).filter((k) => k !== 'access-permissions');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'admin', permissions: perms }, A)).errorType).toBe('RBAC_ROOT_LOCKOUT');
  });

  it('permissões fora do catálogo que a tela tinha são preservadas ao salvar', async () => {
    await pool.query(`INSERT INTO permissions (id, grp, roles) VALUES ('chave-futura', 'general', '{operacao}')`);
    await loadPermissions();
    const known = Object.keys(RBAC_KEYS);
    const r = await api('POST', 'rbac.roles.update', { roleId: 'operacao', permissions: (await grants('operacao')).filter((k) => k !== 'chave-futura'), knownPermissions: known }, A);
    expect(r.success).toBe(true);
    expect(await grants('operacao')).toContain('chave-futura');
    await pool.query(`DELETE FROM permissions WHERE id = 'chave-futura'`);
    await loadPermissions();
  });

  it('o contexto de concessão diz à tela o que fica travado e por quê', async () => {
    const g = await api('GET', 'rbac.grantContext', {}, sup);
    expect(g.root).toBe(false);
    expect(g.roleLocks).toMatchObject({ admin: 'root-only', auditor: null, user: null, bot: 'superior' });
    expect(g.deleteLocks.supervisor).toBe('own-role');
  });
});

describe('acesso efetivo', () => {
  it('mostra cada área com a origem ("via")', async () => {
    const r = await api('GET', 'rbac.users.effective', { userId: plain.userId }, A);
    const audit = r.areas.find((a: any) => a.area === 'admin-audit');
    expect(audit.keys).toEqual([{ key: 'can-audit', via: ['auditor'] }]);
    expect(r.lock).toBeNull();
    expect((await api('GET', 'rbac.users.effective', { userId: A.userId }, sup)).lock).toBe('root-only');
  });
});

describe('histórico e reversão', () => {
  it('editar um papel grava só o que mudou; reverter volta e marca a versão', async () => {
    await api('POST', 'rbac.roles.create', { name: 'leitor', description: 'Leitor', permissions: ['view-c-room'] }, A);
    await api('POST', 'rbac.roles.update', { roleId: 'leitor', description: 'Leitor de canais', permissions: ['view-c-room', 'create-c'] }, A);
    const h = await lastHistory('leitor');
    expect(h.action).toBe('update');
    expect(h.changes.map((c: any) => c.field).sort()).toEqual(['description', 'permissions']);
    // Mudança posterior em outra chave não é desfeita pela reversão (só o delta daquela versão).
    await api('POST', 'rbac.roles.update', { roleId: 'leitor', permissions: ['view-c-room', 'create-c', 'create-p'] }, A);
    const preview = await api('GET', 'rbac.history.preview', { id: h.id }, A);
    expect(preview.next).toEqual({ description: 'Leitor', permissions: ['create-p', 'view-c-room'] });
    expect((await api('POST', 'rbac.history.rollback', { id: h.id }, A)).success).toBe(true);
    expect(await grants('leitor')).toEqual(['create-p', 'view-c-room']);
    expect((await pool.query(`SELECT description FROM roles WHERE id='leitor'`)).rows[0].description).toBe('Leitor');
    const rb = await lastHistory('leitor');
    expect(rb).toMatchObject({ action: 'rollback', reverts_id: h.id });
    expect((await api('POST', 'rbac.history.rollback', { id: h.id }, A)).errorType).toBe('RBAC_ROLLBACK_BLOCKED');
  });

  it('a reversão passa pela mesma hierarquia', async () => {
    await api('POST', 'rbac.roles.update', { roleId: 'leitor', permissions: ['view-c-room', 'create-p', 'manage-calls'] }, A);
    const h = await lastHistory('leitor');
    const r = await api('POST', 'rbac.history.rollback', { id: h.id }, sup);
    expect(r.errorType).toBe('RBAC_ROLLBACK_FORBIDDEN');
  });

  it('desfazer a exclusão recria o papel; referência que sumiu pede substituto', async () => {
    await api('POST', 'rbac.roles.create', { name: 'temporario', description: 'Temp' }, A);
    await api('POST', 'rbac.roles.update', { roleId: 'leitor', delegable: ['temporario'] }, A);
    await api('POST', 'rbac.roles.update', { roleId: 'leitor', delegable: [] }, A);
    const removedDelegation = await lastHistory('leitor');
    expect((await api('POST', 'rbac.roles.delete', { roleId: 'temporario' }, A)).success).toBe(true);
    const preview = await api('GET', 'rbac.history.preview', { id: removedDelegation.id }, A);
    expect(preview.missing).toEqual(['temporario']);
    // Só substitui o que a prévia apontou.
    expect((await api('POST', 'rbac.history.rollback', { id: removedDelegation.id, replace: { auditor: 'user' } }, A)).errorType).toBe('RBAC_ROLLBACK_INVALID');
    expect((await api('POST', 'rbac.history.rollback', { id: removedDelegation.id, replace: { temporario: 'auditor' } }, A)).success).toBe(true);
    expect((await pool.query(`SELECT delegable_roles FROM roles WHERE id='leitor'`)).rows[0].delegable_roles).toEqual(['auditor']);

    const del = (await pool.query(`SELECT id FROM rbac_history WHERE entity_id = 'temporario' AND action = 'delete'`)).rows[0];
    expect((await api('POST', 'rbac.history.rollback', { id: del.id }, A)).success).toBe(true);
    expect((await pool.query(`SELECT description FROM roles WHERE id='temporario'`)).rows[0].description).toBe('Temp');
  });

  it('papéis de uma pessoa: troca, ação em massa num lote só, e reversão', async () => {
    const p2 = await newUser(A, { roles: ['user'] });
    const bulk = await api('POST', 'rbac.users.bulkRoles', { userIds: [plain.userId, p2.userId], add: ['leitor'] }, A);
    expect(bulk.success).toBe(true);
    const rows = (await pool.query(`SELECT * FROM rbac_history WHERE batch_id = $1`, [bulk.batchId])).rows;
    expect(rows.map((r) => r.action)).toEqual(['bulk', 'bulk']);
    const one = rows.find((r) => r.entity_id === p2.userId);
    expect((await api('POST', 'rbac.history.rollback', { id: one.id }, A)).success).toBe(true);
    expect(await rolesOf(p2.userId)).toEqual(['user']);
    // A lista mostra o tipo "user" a quem administra usuários.
    const list = await api('GET', 'rbac.history', { type: 'user', entityId: p2.userId }, A);
    expect(list.items.map((i: any) => i.action)).toEqual(['rollback', 'bulk', 'create']);
    expect(list.items[1].rolledBackAt).toBeTruthy();
  });

  it('quem não gerencia papéis não vê o histórico', async () => {
    expect((await api('GET', 'rbac.history', {}, plain)).status).toBe(403);
  });
});
