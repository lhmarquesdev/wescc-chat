// Administração de pessoas: cadastro sem e-mail, excluir sem levar as conversas dos outros, o último administrador
// ativo, as restrições de segurança de papéis com gente acima de quem edita e o que o editor de usuário mostra.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, login, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

const send = (auth: Auth, rid: string, msg: string) => api('POST', 'chat.sendMessage', { message: { rid, msg } }, auth);

describe('cadastro sem e-mail', () => {
  it('vários usuários sem e-mail (vazio ou só espaços) ficam com e-mail NULL', async () => {
    const a = await api('POST', 'users.create', { username: 'sem.email1', name: 'Sem 1', email: '', password: 'senha-forte-1' }, A);
    const b = await api('POST', 'users.create', { username: 'sem.email2', name: 'Sem 2', email: '   ', password: 'senha-forte-1' }, A);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const rows = (await pool.query(`SELECT email FROM users WHERE username IN ('sem.email1', 'sem.email2')`)).rows;
    expect(rows.map((r) => r.email)).toEqual([null, null]);
  });

  it('e-mail repetido é recusado com mensagem, inclusive com espaços e outra caixa', async () => {
    await api('POST', 'users.create', { username: 'com.email1', name: 'C1', email: 'dup@test.local', password: 'senha-forte-1' }, A);
    const r = await api('POST', 'users.create', { username: 'com.email2', name: 'C2', email: '  DUP@test.local ', password: 'senha-forte-1' }, A);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Este e-mail já está em uso.');
  });

  it('a administração apaga o e-mail de alguém (fica NULL); a própria pessoa não', async () => {
    const u = await newUser(A);
    const r = await api('POST', 'users.update', { userId: u.userId, data: { email: '' } }, A);
    expect(r.success).toBe(true);
    expect((await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [u.userId])).rows[0]).toEqual({ email: null, email_verified: false });
    const v = await newUser(A);
    const own = await api('POST', 'users.updateOwnBasicInfo', { data: { email: '' } }, v);
    expect(own.success).toBe(false);
    expect(own.error).toBe('E-mail inválido.');
  });
});

describe('excluir usuário', () => {
  it('conversa em grupo continua para os outros; a dois fica arquivada; reunião passa para um convidado', async () => {
    const alice = await newUser(A);
    const bruno = await newUser(A);
    const temp = await newUser(A);
    const group = await api('POST', 'im.create', { usernames: [alice.username, bruno.username].join(',') }, temp);
    expect(group.success).toBe(true);
    const gid = group.room._id;
    await send(alice, gid, 'oi do grupo (alice)');
    await send(bruno, gid, 'oi do grupo (bruno)');
    await send(temp, gid, 'oi do grupo (temp)');
    const pair = await api('POST', 'im.create', { username: temp.username }, alice);
    const pid = pair.room._id;
    await send(alice, pid, 'conversa a dois');
    const ev = await api(
      'POST',
      'calendar.create',
      { title: 'Reunião de planejamento', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), attendeeIds: [alice.userId, bruno.userId] },
      temp,
    );
    expect(ev.success).toBe(true);
    await api('POST', 'calendar.respond', { eventId: ev.event._id, response: 'accepted' }, bruno);
    const solo = await api('POST', 'calendar.create', { title: 'Só meu', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() }, temp);

    const del = await api('POST', 'users.delete', { userId: temp.userId }, A);
    expect(del.success).toBe(true);

    // O grupo continua com as três mensagens, agora só entre alice e bruno.
    const h = await api('GET', 'im.history', { roomId: gid }, alice);
    expect(h.success).toBe(true);
    expect(h.messages.filter((m: any) => m.msg.startsWith('oi do grupo'))).toHaveLength(3);
    const room = (await pool.query('SELECT uids, usernames, archived FROM rooms WHERE id = $1', [gid])).rows[0];
    expect([...room.uids].sort()).toEqual([alice.userId, bruno.userId].sort());
    expect(room.usernames).not.toContain(temp.username);
    expect(room.archived).toBe(false);
    expect((await send(bruno, gid, 'seguimos')).success).toBe(true);

    // A conversa a dois fica para alice ler, arquivada e com o nome de quem saiu.
    const ph = await api('GET', 'im.history', { roomId: pid }, alice);
    expect(ph.messages.map((m: any) => m.msg)).toContain('conversa a dois');
    const subs = await api('GET', 'subscriptions.get', undefined, alice);
    const sub = subs.update.find((s: any) => s.rid === pid);
    expect(sub.archived).toBe(true);
    expect(sub.fname).toMatch(/\(conta excluída\)$/);
    expect((await send(alice, pid, 'alguém aí?')).success).toBe(false);

    // A reunião continua: bruno (que aceitou) organiza; alice segue convidada. O evento só dela some.
    const ae = await api('GET', 'calendar.event', { eventId: ev.event._id }, alice);
    expect(ae.success).toBe(true);
    expect(ae.event.owner._id).toBe(bruno.userId);
    expect(ae.event.attendees.map((x: any) => x._id)).toEqual([alice.userId]);
    expect((await api('GET', 'calendar.event', { eventId: ev.event._id }, bruno)).event.canEdit).toBe(true);
    expect((await pool.query('SELECT 1 FROM calendar_events WHERE id = $1', [solo.event._id])).rowCount).toBe(0);

    // Quando a outra pessoa também sai, a conversa a dois some (não sobra ninguém para ler); o grupo que ficou só com
    // bruno vira uma conversa arquivada para ele.
    expect((await api('POST', 'users.delete', { userId: alice.userId }, A)).success).toBe(true);
    expect((await pool.query('SELECT 1 FROM rooms WHERE id = $1', [pid])).rowCount).toBe(0);
    expect((await pool.query('SELECT archived FROM rooms WHERE id = $1', [gid])).rows[0].archived).toBe(true);
    expect((await api('GET', 'im.history', { roomId: gid }, bruno)).messages.filter((m: any) => m.msg.startsWith('oi do grupo'))).toHaveLength(3);
  });
});

describe('desativar', () => {
  it('ninguém desativa a própria conta, nem pela lista nem pelo editor', async () => {
    for (const [path, body] of [
      ['users.setActiveStatus', { userId: A.userId, activeStatus: false }],
      ['users.update', { userId: A.userId, data: { active: false } }],
    ] as const) {
      const r = await api('POST', path, body, A);
      expect(r.status).toBe(400);
      expect(r.error).toBe('Você não pode desativar a própria conta.');
    }
    expect((await pool.query('SELECT active FROM users WHERE id = $1', [A.userId])).rows[0].active).toBe(true);
    expect((await api('GET', 'me', undefined, A)).username).toBe('admin');
  });

  it('o último administrador ativo não é desativado; com outro ativo, pode', async () => {
    const other = await newUser(A, { roles: ['admin', 'user'] });
    // Pela API o último administrador ativo é sempre quem age (e a própria conta já é recusada): a regra é conferida
    // no serviço, com o admin principal desativado por um instante.
    const { updateUser } = await import('../src/services/users');
    const actor = { userId: 'sistema', username: 'sistema', sessionId: 'teste' };
    await pool.query('UPDATE users SET active = false WHERE id = $1', [A.userId]);
    try {
      await expect(updateUser(actor, other.userId, { active: false }, { asAdmin: true })).rejects.toThrow('Não é possível desativar o último administrador ativo.');
    } finally {
      await pool.query('UPDATE users SET active = true WHERE id = $1', [A.userId]);
    }
    expect((await api('POST', 'users.setActiveStatus', { userId: other.userId, activeStatus: false }, A)).success).toBe(true);
    expect((await api('POST', 'users.setActiveStatus', { userId: other.userId, activeStatus: true }, A)).success).toBe(true);
  });
});
