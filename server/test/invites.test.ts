import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

let seq = 0;
const group = async (owner: Auth, members: Auth[] = []) => {
  const r = await api('POST', 'groups.create', { name: `convite-${Date.now()}-${++seq}`, members: members.map((m) => m.username) }, owner);
  expect(r.success).toBe(true);
  return r.group._id as string;
};
const link = (auth: Auth, rid: string, days: unknown = 1, maxUses: unknown = 0) => api('POST', 'findOrCreateInvite', { rid, days, maxUses }, auth);
const use = (auth: Auth, token: string) => api('POST', 'useInviteToken', { token }, auth);
const validate = (token: string, auth?: Auth) => api('POST', 'validateInviteToken', { token }, auth);
const membersOf = async (rid: string) => (await pool.query('SELECT user_id FROM subscriptions WHERE room_id = $1', [rid])).rows.map((r) => r.user_id);
const usesOf = async (token: string) => (await pool.query('SELECT uses FROM invites WHERE id = $1', [token])).rows[0]?.uses;
async function grant(permission: string, role: string) {
  const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
  const roles = perms.find((p) => p._id === permission)!.roles;
  expect((await api('POST', 'permissions.update', { permissions: [{ _id: permission, roles: [...new Set([...roles, role])] }] }, A)).success).toBe(true);
}

describe('links de convite', () => {
  it('prazo e limite de usos inválidos dão 400 em português; sala inexistente dá 404', async () => {
    const owner = await newUser(A);
    const rid = await group(owner);
    for (const days of ['abc', 1.5, -5, -1, 1e9, 366, '', true, {}]) {
      const r = await link(owner, rid, days);
      expect(r.status, `days=${JSON.stringify(days)}`).toBe(400);
      expect(r.errorType).toBe('error-invalid-params');
      expect(r.error).toMatch(/^Prazo do convite inválido/);
    }
    for (const maxUses of ['x', -1, -5, 2.5, 1001]) {
      const r = await link(owner, rid, 1, maxUses);
      expect(r.status, `maxUses=${JSON.stringify(maxUses)}`).toBe(400);
      expect(r.error).toMatch(/^Limite de usos inválido/);
    }
    const bogus = await link(A, 'nao-existe');
    expect(bogus.status).toBe(404);
    expect(bogus.error).toBe('Sala não encontrada.');
    // Valores da tela e números vindos como texto continuam valendo.
    const ok = await link(owner, rid, '7', '5');
    expect(ok).toMatchObject({ status: 200, days: 7, maxUses: 5 });
    expect(new Date(ok.expires).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86400000);
    expect(await link(owner, rid, 0, 0)).toMatchObject({ status: 200, expires: null });
    expect(await link(owner, rid, 365, 1000)).toMatchObject({ status: 200 });
    expect((await api('POST', 'findOrCreateInvite', { rid }, owner)).days).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM invites WHERE room_id = $1 AND (days < 0 OR max_uses < 0)', [rid])).rows[0].n).toBe(0);
  });

  it('quem não participa da sala não cria link para ela, nem com a permissão global', async () => {
    const owner = await newUser(A);
    const rid = await group(owner);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'Pauta confidencial' } }, owner);
    expect((await api('POST', 'roles.create', { name: 'convidador', scope: 'Users' }, A)).success).toBe(true);
    await grant('create-invite-links', 'convidador');
    const carla = await newUser(A, { roles: ['user', 'convidador'] });
    for (const who of [carla, A]) {
      const r = await link(who, rid);
      expect(r.status).toBe(403);
      expect(r.error).toBe('Só quem participa da sala pode criar um link de convite para ela.');
    }
    expect((await api('GET', 'listInvites', { rid }, carla)).status).toBe(403);
    expect((await api('GET', 'groups.history', { roomId: rid }, carla)).status).toBe(403);
    expect(await membersOf(rid)).toEqual([owner.userId]);
    // Um link antigo, criado por quem não participa (antes desta regra), também não vale.
    await pool.query(`INSERT INTO invites (id, room_id, user_id, days, max_uses) VALUES ('conviteforadasala', $1, $2, 0, 0)`, [rid, carla.userId]);
    expect(await validate('conviteforadasala')).toMatchObject({ valid: false, reason: 'invalid' });
    expect((await use(carla, 'conviteforadasala')).errorType).toBe('invalid-invite-token');
    expect(await membersOf(rid)).toEqual([owner.userId]);
  });

  it('o link para de valer quando quem criou sai da sala, perde o papel, é desativado ou excluído', async () => {
    const [owner, bruno, dora, eva] = await Promise.all([newUser(A), newUser(A), newUser(A), newUser(A)]);
    const rid = await group(owner, [bruno]);
    expect((await api('POST', 'groups.addModerator', { roomId: rid, userId: bruno.userId }, owner)).success).toBe(true);
    const inv = await link(bruno, rid, 0, 0);
    expect(inv.status).toBe(200);
    expect(await validate(inv._id)).toMatchObject({ valid: true });

    // Removido: nem ele volta pelo próprio link, nem traz outra pessoa.
    expect((await api('POST', 'groups.kick', { roomId: rid, userId: bruno.userId }, owner)).success).toBe(true);
    expect(await validate(inv._id)).toMatchObject({ valid: false, reason: 'invalid' });
    expect(await use(bruno, inv._id)).toMatchObject({ status: 400, errorType: 'invalid-invite-token', error: 'Convite inválido ou expirado.' });
    expect((await api('GET', 'groups.history', { roomId: rid }, bruno)).status).toBe(403);
    expect((await use(dora, inv._id)).status).toBe(400);
    // De volta como membro comum (sem create-invite-links na sala), o link antigo continua sem valer.
    expect((await api('POST', 'groups.invite', { roomId: rid, userId: bruno.userId }, owner)).success).toBe(true);
    expect((await use(dora, inv._id)).status).toBe(400);
    // Moderador de novo: vale.
    expect((await api('POST', 'groups.addModerator', { roomId: rid, userId: bruno.userId }, owner)).success).toBe(true);
    expect((await use(dora, inv._id)).status).toBe(200);

    // Desativado: não vale; reativado: vale de novo.
    expect((await api('POST', 'users.setActiveStatus', { userId: bruno.userId, activeStatus: false }, A)).success).toBe(true);
    expect(await validate(inv._id)).toMatchObject({ valid: false, reason: 'invalid' });
    expect((await use(eva, inv._id)).status).toBe(400);
    expect((await api('POST', 'users.setActiveStatus', { userId: bruno.userId, activeStatus: true }, A)).success).toBe(true);
    expect(await validate(inv._id)).toMatchObject({ valid: true });

    // Excluído (o convite fica sem dono): não vale.
    expect((await api('POST', 'users.delete', { userId: bruno.userId, confirmRelinquish: true }, A)).success).toBe(true);
    expect((await pool.query('SELECT user_id FROM invites WHERE id = $1', [inv._id])).rows[0].user_id).toBeNull();
    expect(await validate(inv._id)).toMatchObject({ valid: false, reason: 'invalid' });
    expect((await use(eva, inv._id)).status).toBe(400);
    expect(await membersOf(rid)).not.toContain(eva.userId);
  });

  it('quem já participa não gasta uso; o limite vale com pedidos ao mesmo tempo', async () => {
    const owner = await newUser(A);
    const rid = await group(owner);
    const inv = await link(owner, rid, 7, 1);
    // O dono confere o próprio link: vai para a sala, e o uso não é gasto.
    expect(await validate(inv._id, owner)).toMatchObject({ valid: true, alreadyMember: true, room: { _id: rid } });
    for (let i = 0; i < 3; i++) expect(await use(owner, inv._id)).toMatchObject({ status: 200, room: { rid } });
    expect(await usesOf(inv._id)).toBe(0);
    expect(await validate(inv._id)).toMatchObject({ valid: true });
    expect((await validate(inv._id)).alreadyMember).toBeUndefined();

    // Seis pessoas ao mesmo tempo num link de uso único: só uma entra.
    const people = await Promise.all(Array.from({ length: 6 }, () => newUser(A)));
    const results = await Promise.all(people.map((p) => use(p, inv._id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const refused = results.filter((r) => r.status !== 200);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.error).toBe('Este convite já foi usado o número máximo de vezes. Peça um novo a quem convidou você.');
    expect(await usesOf(inv._id)).toBe(1);
    expect((await membersOf(rid)).length).toBe(2);
    expect(await validate(inv._id)).toMatchObject({ valid: false, reason: 'used-up' });
    // Quem entrou continua sendo levado para a sala pelo link esgotado.
    const joined = people[results.findIndex((r) => r.status === 200)];
    expect(await validate(inv._id, joined)).toMatchObject({ valid: false, alreadyMember: true, room: { _id: rid } });
    expect((await use(joined, inv._id)).status).toBe(200);

    // Limite maior que 1 com corrida: nunca passa do limite.
    const inv3 = await link(owner, rid, 7, 3);
    const more = await Promise.all(Array.from({ length: 8 }, () => newUser(A)));
    const r3 = await Promise.all(more.map((p) => use(p, inv3._id)));
    expect(r3.filter((r) => r.status === 200)).toHaveLength(3);
    expect(await usesOf(inv3._id)).toBe(3);
  });

  it('entrada recusada (Operação) não gasta uso', async () => {
    const sup = await newUser(A);
    const op1 = await newUser(A, { roles: ['operacao'] });
    const op2 = await newUser(A, { roles: ['operacao'] });
    const rid = await group(sup, [op1]);
    expect((await api('POST', 'groups.addOwner', { roomId: rid, userId: op1.userId }, sup)).success).toBe(true);
    const inv = await link(op1, rid, 1, 1);
    expect(inv.status).toBe(200);
    expect((await use(op2, inv._id)).errorType).toBe('error-direct-restricted');
    expect(await usesOf(inv._id)).toBe(0);
  });

  it('sala arquivada e convite vencido: o motivo aparece antes de clicar', async () => {
    const owner = await newUser(A);
    const guest = await newUser(A);
    const rid = await group(owner);
    const inv = await link(owner, rid, 7, 0);
    const old = await link(owner, rid, 1, 0);
    await pool.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old._id]);
    expect(await validate(old._id)).toMatchObject({ valid: false, reason: 'expired' });
    expect((await validate(old._id)).room).toBeUndefined();
    expect((await use(guest, old._id)).error).toBe('Este convite expirou. Peça um novo a quem convidou você.');
    expect(await validate('nao-existe')).toMatchObject({ valid: false, reason: 'invalid' });
    expect(await validate({} as any)).toMatchObject({ valid: false, reason: 'invalid' });

    expect((await api('POST', 'groups.archive', { roomId: rid }, owner)).success).toBe(true);
    expect(await validate(inv._id)).toMatchObject({ valid: false, reason: 'archived' });
    expect(await use(guest, inv._id)).toMatchObject({ status: 400, errorType: 'error-room-archived' });
    expect(await usesOf(inv._id)).toBe(0);
    expect(await link(owner, rid)).toMatchObject({ status: 400, errorType: 'error-room-archived' });
  });

  it('o painel da sala lista os links de todos e diz quem pode revogar', async () => {
    const [owner, mod, plain] = await Promise.all([newUser(A), newUser(A), newUser(A)]);
    const rid = await group(owner, [mod, plain]);
    expect((await api('POST', 'groups.addModerator', { roomId: rid, userId: mod.userId }, owner)).success).toBe(true);
    const modLink = await link(mod, rid, 0, 0);
    const ownLink = await link(owner, rid, 7, 5);
    const list = await api('GET', 'listInvites', { rid }, owner);
    expect(list.status).toBe(200);
    expect(list.invites.map((i: any) => i._id).sort()).toEqual([modLink._id, ownLink._id].sort());
    const m = list.invites.find((i: any) => i._id === modLink._id);
    expect(m).toMatchObject({ status: 'active', canRevoke: true, createdBy: { _id: mod.userId, username: mod.username }, room: { _id: rid, t: 'p' } });
    // Membro comum não tem create-invite-links na sala: não lista.
    expect((await api('GET', 'listInvites', { rid }, plain)).status).toBe(403);
    expect((await api('GET', 'listInvites', { rid: 'nao-existe' }, owner)).status).toBe(404);
    // Sem rid: os próprios links.
    expect((await api('GET', 'listInvites', {}, mod)).invites.map((i: any) => i._id)).toEqual([modLink._id]);
    // Quem foi removido aparece como inválido para o dono, que revoga.
    expect((await api('POST', 'groups.kick', { roomId: rid, userId: mod.userId }, owner)).success).toBe(true);
    expect((await api('GET', 'listInvites', { rid }, owner)).invites.find((i: any) => i._id === modLink._id).status).toBe('invalid');
    expect((await api('DELETE', `removeInvite/${modLink._id}`, undefined, owner)).success).toBe(true);
    expect((await api('GET', 'listInvites', { rid }, owner)).invites.map((i: any) => i._id)).toEqual([ownLink._id]);
  });

  it('a Administração mostra a situação e só oferece Revogar a quem pode', async () => {
    const owner = await newUser(A);
    const rid = await group(owner);
    const inv = await link(owner, rid, 7, 2);
    expect((await api('POST', 'roles.create', { name: 'auditor-salas', scope: 'Users' }, A)).success).toBe(true);
    await grant('view-room-administration', 'auditor-salas');
    const auditor = await newUser(A, { roles: ['user', 'auditor-salas'] });
    const seen = (await api('GET', 'listInvites', {}, auditor)).invites.find((i: any) => i._id === inv._id);
    expect(seen).toMatchObject({ status: 'active', canRevoke: false, roomName: expect.any(String), room: { t: 'p' }, createdBy: { username: owner.username } });
    expect((await api('DELETE', `removeInvite/${inv._id}`, undefined, auditor)).status).toBe(403);
    expect((await api('GET', 'listInvites', {}, A)).invites.find((i: any) => i._id === inv._id).canRevoke).toBe(true);
  });
});
