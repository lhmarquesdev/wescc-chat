// Administração de pessoas: cadastro sem e-mail, excluir sem levar as conversas dos outros, o último administrador
// ativo, as restrições de segurança de papéis com gente acima de quem edita, o que o editor de usuário mostra e a
// ordem da lista.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Os e-mails ficam numa caixa de saída em memória; "SMTP configurado" é ligado e desligado pelo teste.
const mail = vi.hoisted(() => ({ configured: true, outbox: [] as { to: string; subject: string; text: string; html?: string }[] }));
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => (mail.outbox.push(m), true),
  mailStatus: () => ({ configured: mail.configured, lastSuccessAt: null, lastFailure: null }),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Site_Url: 'https://chat.empresa.com.br' } }, A);
});
afterAll(() => stopServer());
beforeEach(() => {
  mail.outbox.length = 0;
  mail.configured = true;
});

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

describe('papéis: travas de segurança com pessoas acima de quem edita', () => {
  it('gestor não liga 2FA obrigatório nem Restrito num papel que administradores também têm', async () => {
    const keys = ['view-user-administration', 'edit-other-user-info', 'assign-roles', 'view-permissions', 'manage-roles'];
    expect((await api('POST', 'rbac.roles.create', { name: 'gestor-pessoas', description: 'Gestor de pessoas', scope: 'Users', permissions: keys }, A)).success).toBe(true);
    const gestor = await newUser(A, { roles: ['user', 'gestor-pessoas'] });
    expect((await api('POST', 'rbac.roles.create', { name: 'equipe-noite', description: 'Equipe da noite', scope: 'Users' }, A)).success).toBe(true);
    await newUser(A, { roles: ['user', 'equipe-noite'] });

    const g = await api('GET', 'rbac.grantContext', undefined, gestor);
    expect(g.holderLocks.user).toBe('root-only');
    expect(g.holderLocks['equipe-noite']).toBeUndefined();

    for (const body of [{ roleId: 'user', mandatory2fa: true }, { roleId: 'user', restrictDirect: true }]) {
      const r = await api('POST', 'rbac.roles.update', body, gestor);
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('RBAC_HOLDER_SUPERIOR');
      expect(r.error).toMatch(/só um administrador muda o 2FA obrigatório/);
    }
    expect((await api('POST', 'roles.update', { roleId: 'user', mandatory2fa: true }, gestor)).errorType).toBe('RBAC_HOLDER_SUPERIOR');
    const row = (await pool.query(`SELECT mandatory_2fa, restrict_direct FROM roles WHERE id = 'user'`)).rows[0];
    expect(row).toEqual({ mandatory_2fa: false, restrict_direct: false });
    // O resto do papel continua editável, e num papel só de quem o gestor gerencia as travas também.
    expect((await api('POST', 'rbac.roles.update', { roleId: 'user', purpose: 'Todos da empresa' }, gestor)).success).toBe(true);
    expect((await api('POST', 'rbac.roles.update', { roleId: 'equipe-noite', mandatory2fa: true }, gestor)).success).toBe(true);
    // O administrador continua mudando.
    expect((await api('POST', 'rbac.roles.update', { roleId: 'user', restrictDirect: false, mandatory2fa: false }, A)).success).toBe(true);
    expect((await api('GET', 'rbac.grantContext', undefined, A)).holderLocks).toEqual({});
  });
});

describe('senha: criar com troca obrigatória ou com link, e o editor mostra o que vale', () => {
  it('"Exigir troca de senha" aparece no users.info e grava junto com uma senha nova', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.requirePasswordChange).toBe(false);
    expect((await api('POST', 'users.update', { userId: u.userId, data: { requirePasswordChange: true } }, A)).success).toBe(true);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.requirePasswordChange).toBe(true);
    expect((await api('POST', 'users.update', { userId: u.userId, data: { requirePasswordChange: false } }, A)).success).toBe(true);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.requirePasswordChange).toBe(false);
    // Senha provisória e troca obrigatória na mesma gravação (antes: erro de SQL).
    const r = await api('POST', 'users.update', { userId: u.userId, data: { password: 'provisoria-123', requirePasswordChange: true } }, A);
    expect(r.success).toBe(true);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.requirePasswordChange).toBe(true);
    // A pessoa fica sabendo por e-mail que a senha foi trocada por um administrador.
    await sleep(50);
    expect(mail.outbox.find((m) => m.to === `${u.username}@test.local`)?.text).toMatch(/Um administrador trocou a senha/);
  });

  it('criar com "Enviar link": sem senha, o e-mail leva o link; sem e-mail ou sem SMTP a conta não é criada', async () => {
    const noEmail = await api('POST', 'users.create', { username: 'link.sem', name: 'Sem', email: '', sendPasswordEmail: true }, A);
    expect(noEmail.status).toBe(400);
    expect(noEmail.error).toMatch(/Informe o e-mail/);
    mail.configured = false;
    const noSmtp = await api('POST', 'users.create', { username: 'link.smtp', name: 'Smtp', email: 'link.smtp@test.local', sendPasswordEmail: true }, A);
    expect(noSmtp.status).toBe(400);
    expect(noSmtp.errorType).toBe('error-smtp-not-configured');
    expect((await pool.query(`SELECT 1 FROM users WHERE username IN ('link.sem', 'link.smtp')`)).rowCount).toBe(0);
    mail.configured = true;
    const r = await api('POST', 'users.create', { username: 'link.ok', name: 'Lia Link', email: 'lia@test.local', sendPasswordEmail: true }, A);
    expect(r.success).toBe(true);
    expect(r.passwordEmailSent).toBe(true);
    const sent = mail.outbox.find((m) => m.to === 'lia@test.local')!;
    expect(sent.text).toMatch(/foi criada com o nome de usuário "link.ok"/);
    const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(sent.text)![1];
    expect((await api('POST', 'users.resetPassword', { token, password: 'senha-da-lia-1' })).success).toBe(true);
    expect((await login('link.ok', 'senha-da-lia-1')).username).toBe('link.ok');
    // Sem a opção, a senha continua obrigatória.
    expect((await api('POST', 'users.create', { username: 'sem.senha', name: 'S', email: 's@test.local' }, A)).status).toBe(400);
  });

  it('o editor manda o link de definir a senha por e-mail (com a permissão e a hierarquia)', async () => {
    const u = await newUser(A);
    const r = await api('POST', 'users.sendPasswordLink', { userId: u.userId }, A);
    expect(r.success).toBe(true);
    expect(mail.outbox[0].text).toMatch(/Um administrador do .* pediu que você defina uma senha nova/);
    const plain = await newUser(A);
    expect((await api('POST', 'users.sendPasswordLink', { userId: u.userId }, plain)).status).toBe(403);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [u.userId]);
    expect((await api('POST', 'users.sendPasswordLink', { userId: u.userId }, A)).error).toMatch(/não tem e-mail/);
  });
});

describe('cadastros aguardando aprovação', () => {
  it('aparecem com filtro e contagem próprios, e Ativar aprova (com aviso por e-mail)', async () => {
    await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Public', Accounts_ManuallyApproveNewUsers: true } }, A);
    const reg = await api('POST', 'users.register', { username: 'novato', name: 'Novato', email: 'novato@test.local', pass: 'senha-forte-1' });
    expect(reg.success).toBe(true);
    const off = await newUser(A);
    await api('POST', 'users.setActiveStatus', { userId: off.userId, activeStatus: false }, A);

    const pending = await api('GET', 'users.list', { status: 'pending', counts: 'true' }, A);
    expect(pending.users.map((u: any) => u.username)).toEqual(['novato']);
    expect(pending.users[0].pendingApproval).toBe(true);
    expect(pending.counts.pending).toBe(1);
    const deact = await api('GET', 'users.list', { status: 'deactivated' }, A);
    expect(deact.users.map((u: any) => u.username)).toContain(off.username);
    expect(deact.users.map((u: any) => u.username)).not.toContain('novato');
    expect((await api('GET', 'users.listPendingApproval', undefined, A)).users.map((u: any) => u.username)).toEqual(['novato']);
    // Sem counts=true a lista não calcula as contagens.
    expect(pending.counts && (await api('GET', 'users.list', { status: 'pending' }, A)).counts).toBeUndefined();

    expect((await api('POST', 'users.setActiveStatus', { userId: reg.user._id, activeStatus: true }, A)).success).toBe(true);
    await sleep(50);
    expect(mail.outbox.find((m) => m.to === 'novato@test.local')?.subject).toMatch(/Cadastro aprovado/);
    const after = await api('GET', 'users.list', { status: 'pending', counts: 'true' }, A);
    expect(after.users).toHaveLength(0);
    expect(after.counts.pending).toBe(0);
    expect((await login('novato', 'senha-forte-1')).username).toBe('novato');
    await api('POST', 'settings', { settings: { Accounts_ManuallyApproveNewUsers: false } }, A);
  });
});

describe('cadastro aguardando aprovação avisa quem aprova', () => {
  it('quem pode ativar contas recebe o aviso no chat e por e-mail, com o link do filtro', async () => {
    const keys = ['view-user-administration', 'edit-other-user-active-status'];
    expect((await api('POST', 'rbac.roles.create', { name: 'aprovador', description: 'Aprovador', scope: 'Users', permissions: keys }, A)).success).toBe(true);
    const aprovador = await newUser(A, { roles: ['user', 'aprovador'] });
    const comum = await newUser(A);
    const wsA = connectWs(aprovador);
    const wsC = connectWs(comum);
    await Promise.all([wsA.ready, wsC.ready]);
    await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Public', Accounts_ManuallyApproveNewUsers: true } }, A);
    const reg = await api('POST', 'users.register', { username: 'espera.aprov', name: 'Edu Espera', email: 'edu@test.local', pass: 'senha-forte-1' });
    expect(reg.success).toBe(true);
    const ev = await wsA.waitFor((e) => e.type === 'notification' && e.title === 'Cadastro aguardando aprovação');
    expect(ev.text).toMatch(/Edu Espera \(@espera\.aprov, edu@test\.local\) se cadastrou/);
    await sleep(100);
    expect(wsC.events.some((e) => e.type === 'notification' && e.title === 'Cadastro aguardando aprovação')).toBe(false);
    const adminEmail = (await pool.query(`SELECT email FROM users WHERE username = 'admin'`)).rows[0].email;
    const to = mail.outbox.filter((m) => m.subject.includes('Cadastro aguardando aprovação')).map((m) => m.to);
    expect(to).toEqual(expect.arrayContaining([adminEmail, `${aprovador.username}@test.local`]));
    expect(to).not.toContain(`${comum.username}@test.local`);
    expect(mail.outbox.find((m) => m.to === adminEmail && m.subject.includes('aguardando'))!.text).toMatch(/https:\/\/chat\.empresa\.com\.br\/admin\/users\?status=pending/);
    // Sem aprovação manual, ninguém é avisado.
    mail.outbox.length = 0;
    await api('POST', 'settings', { settings: { Accounts_ManuallyApproveNewUsers: false } }, A);
    expect((await api('POST', 'users.register', { username: 'livre.entra', name: 'Livre', email: 'livre@test.local', pass: 'senha-forte-1' })).success).toBe(true);
    await sleep(100);
    expect(mail.outbox.filter((m) => m.subject.includes('aguardando'))).toHaveLength(0);
    wsA.close();
    wsC.close();
  });
});

describe('dados da pessoa: nome, bio, nomes reservados e nome exibido do papel', () => {
  it('nome obrigatório (sem só espaços), até 100 caracteres e sem espaços nas pontas; bio até 500', async () => {
    const u = await newUser(A);
    for (const name of ['   ', '', 'x'.repeat(101)]) {
      const r = await api('POST', 'users.update', { userId: u.userId, data: { name } }, A);
      expect(r.status).toBe(400);
      expect(r.error).toBe('Informe um nome (até 100 caracteres).');
    }
    expect((await api('POST', 'users.update', { userId: u.userId, data: { name: '  Bia Nova  ' } }, A)).user.name).toBe('Bia Nova');
    const bio = await api('POST', 'users.update', { userId: u.userId, data: { bio: 'b'.repeat(501) } }, A);
    expect(bio.status).toBe(400);
    expect(bio.error).toBe('A bio pode ter até 500 caracteres.');
    expect((await api('POST', 'users.update', { userId: u.userId, data: { bio: 'b'.repeat(500) } }, A)).success).toBe(true);
    // Cadastro pela administração e pela tela de entrar.
    const c = await api('POST', 'users.create', { username: 'nome.vazio', name: '   ', email: '', password: 'senha-forte-1' }, A);
    expect(c.error).toBe('Informe um nome (até 100 caracteres).');
    await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Public' } }, A);
    expect((await api('POST', 'users.register', { username: 'reg.vazio', name: '  ', email: 'rv@test.local', pass: 'senha-forte-1' })).error).toBe('Informe um nome (até 100 caracteres).');
    // Minha conta: o próprio nome também, e um nome antigo fora da regra não trava o resto do formulário.
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { name: '   ' } }, u)).error).toBe('Informe um nome (até 100 caracteres).');
    await pool.query('UPDATE users SET name = $2 WHERE id = $1', [u.userId, 'n'.repeat(150)]);
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { name: 'n'.repeat(150), statusText: 'De férias' } }, u)).success).toBe(true);
  });

  it('all, here e system são nomes de usuário reservados', async () => {
    for (const username of ['all', 'HERE', 'system']) {
      const r = await api('POST', 'users.create', { username, name: 'Reservado', email: '', password: 'senha-forte-1' }, A);
      expect(r.status).toBe(400);
      expect(r.error).toBe('Este nome de usuário é reservado. Escolha outro.');
    }
    const u = await newUser(A);
    expect((await api('POST', 'users.update', { userId: u.userId, data: { username: 'here' } }, A)).error).toBe('Este nome de usuário é reservado. Escolha outro.');
    await api('POST', 'settings', { settings: { Accounts_RegistrationForm: 'Public' } }, A);
    expect((await api('POST', 'users.register', { username: 'all', name: 'Todos', email: 'todos@test.local', pass: 'senha-forte-1' })).error).toBe('Este nome de usuário é reservado. Escolha outro.');
    // "allan" e "here.now" continuam livres.
    expect((await api('POST', 'users.create', { username: 'allan', name: 'Allan', email: '', password: 'senha-forte-1' }, A)).success).toBe(true);
  });

  it('nome exibido do papel: sem espaços nas pontas e até 32 caracteres (vazio mostra o identificador)', async () => {
    const blank = await api('POST', 'rbac.roles.create', { name: 'equipe-branca', description: '   ', scope: 'Users' }, A);
    expect(blank.success).toBe(true);
    expect((await pool.query(`SELECT description FROM roles WHERE id = 'equipe-branca'`)).rows[0].description).toBe('');
    const long = await api('POST', 'rbac.roles.create', { name: 'equipe-longa', description: 'x'.repeat(33), scope: 'Users' }, A);
    expect(long.status).toBe(400);
    expect(long.error).toBe('O nome exibido pode ter até 32 caracteres.');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'equipe-branca', description: 'y'.repeat(40) }, A)).errorType).toBe('RBAC_INVALID_ROLE_LABEL');
    expect((await api('POST', 'rbac.roles.update', { roleId: 'equipe-branca', description: '  Equipe Branca  ' }, A)).success).toBe(true);
    expect((await pool.query(`SELECT description FROM roles WHERE id = 'equipe-branca'`)).rows[0].description).toBe('Equipe Branca');
  });
});

describe('editor de usuário: própria senha, e-mail verificado e dispositivos', () => {
  it('a própria senha não muda pelo editor da administração (só em Minha conta, com a senha atual)', async () => {
    const r = await api('POST', 'users.update', { userId: A.userId, data: { password: 'outra-senha-123' } }, A);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/Minha conta › Segurança/);
    expect((await login('admin', 'admin-pass-123')).username).toBe('admin');
    // A de outra pessoa continua mudando, e os outros dados da própria conta também.
    const u = await newUser(A);
    expect((await api('POST', 'users.update', { userId: u.userId, data: { password: 'nova-senha-123' } }, A)).success).toBe(true);
    expect((await api('POST', 'users.update', { userId: A.userId, data: { bio: 'Administra o chat' } }, A)).success).toBe(true);
  });

  it('trocar o e-mail desmarca "verificado", a não ser que a administração mantenha marcado na mesma gravação', async () => {
    const u = await newUser(A, { verified: true });
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.emailVerified).toBe(true);
    await api('POST', 'users.update', { userId: u.userId, data: { email: 'trocado1@test.local' } }, A);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.emailVerified).toBe(false);
    await api('POST', 'users.update', { userId: u.userId, data: { verified: true } }, A);
    await api('POST', 'users.update', { userId: u.userId, data: { email: 'trocado2@test.local', verified: true } }, A);
    expect((await api('GET', 'users.info', { userId: u.userId }, A)).user.emailVerified).toBe(true);
  });

  it('Dispositivos marca a sessão de quem vê e manda os papéis do dono (para o cadeado)', async () => {
    const u = await newUser(A);
    const r = await api('GET', 'sessions.list.all', { count: 200 }, A);
    const mine = r.sessions.filter((s: any) => s.current);
    expect(mine).toHaveLength(1);
    expect(mine[0].userId).toBe(A.userId);
    expect(mine[0].roles).toContain('admin');
    expect(r.sessions.find((s: any) => s.userId === u.userId)).toMatchObject({ current: false, roles: ['user'] });
  });
});

describe('lista de usuários: ordenar por coluna', () => {
  it('ordena por nome (sem acento), e-mail e último acesso, com as pessoas antes dos bots; campo inválido é recusado', async () => {
    const mk = async (username: string, name: string, email: string | null, type = 'user') => {
      const r = await api('POST', 'users.create', { username, name, email: email ?? '', password: 'senha-forte-1', type }, A);
      expect(r.success).toBe(true);
      return r.user._id as string;
    };
    const ids = {
      ordem1: await mk('ordem1', 'Bruno', 'z@ordem.local'),
      ordem2: await mk('ordem2', 'álvaro', 'b@ordem.local'),
      ordem3: await mk('ordem3', 'Carla', 'A@ordem.local'),
      ordem4: await mk('ordem4', 'Ana', null),
      ordem5: await mk('ordem5', 'Aaa Bot', null, 'bot'),
    };
    // ordem2 nunca entrou; o bot também não.
    const seen: Record<string, string | null> = { ordem1: '1 day', ordem2: null, ordem3: '5 days', ordem4: '0 days', ordem5: null };
    for (const [u, ago] of Object.entries(seen)) await pool.query(`UPDATE users SET last_login = CASE WHEN $2::interval IS NULL THEN NULL ELSE now() - $2::interval END WHERE id = $1`, [ids[u as keyof typeof ids], ago]);

    const list = async (sort?: unknown, auth: Auth = A, extra: Record<string, string> = {}) => {
      const r = await api('GET', 'users.list', { filter: 'ordem', ...(sort ? { sort: typeof sort === 'string' ? sort : JSON.stringify(sort) } : {}), ...extra }, auth);
      return r.users ? r.users.map((u: any) => u.username).join(' ') : r;
    };
    expect(await list()).toBe('ordem1 ordem2 ordem3 ordem4 ordem5');
    expect(await list({ name: 1 })).toBe('ordem2 ordem4 ordem1 ordem3 ordem5');
    expect(await list({ name: -1 })).toBe('ordem3 ordem1 ordem4 ordem2 ordem5');
    // Quem nunca entrou conta como o acesso mais antigo.
    expect(await list({ lastLogin: 1 })).toBe('ordem2 ordem3 ordem1 ordem4 ordem5');
    expect(await list({ lastLogin: -1 })).toBe('ordem4 ordem1 ordem3 ordem2 ordem5');
    // Sem e-mail fica no fim, nas duas direções; maiúsculas não contam.
    expect(await list({ email: 1 })).toBe('ordem3 ordem2 ordem1 ordem4 ordem5');
    expect(await list({ email: -1 })).toBe('ordem1 ordem2 ordem3 ordem4 ordem5');
    expect(await list({ createdAt: -1 })).toBe('ordem4 ordem3 ordem2 ordem1 ordem5');
    // A ordem vale entre as páginas.
    expect(await list({ name: 1 }, A, { offset: '1', count: '2' })).toBe('ordem4 ordem1');

    for (const bad of [{ roles: 1 }, { name: 2 }, { name: 1, email: 1 }, '["name"]', 'name', '{"__proto__":1}', '{"constructor":1}']) {
      const r = await list(bad);
      expect(r.status).toBe(400);
      expect(r.error).toBe('Não dá para ordenar a lista de usuários por esse campo.');
    }
    // Quem não administra não vê e-mail nem último acesso: também não ordena por eles.
    const plain = await newUser(A);
    expect((await list({ lastLogin: 1 }, plain)).status).toBe(400);
    expect((await list({ email: 1 }, plain)).status).toBe(400);
    expect(await list({ name: -1 }, plain)).toBe('ordem3 ordem1 ordem4 ordem2 ordem5');
  });
});
