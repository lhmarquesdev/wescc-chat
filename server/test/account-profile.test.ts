import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, login, newUser, raw, sleep, startServer, stopServer, type Auth } from './helpers';

// Minha conta: perfil, senha, e-mail, foto e preferências. Os e-mails ficam numa caixa de saída em memória.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => (outbox.push(m), true),
  mailStatus: () => ({ configured: true, lastSuccessAt: null, lastFailure: null }),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());
beforeEach(() => {
  outbox.length = 0;
});

const PW = 'senha-forte-1';
const profile = (u: Auth, data: Record<string, unknown>) => api('POST', 'users.updateOwnBasicInfo', { data }, u);
const settings = (s: Record<string, unknown>) => api('POST', 'settings', { settings: s }, A);
const row = async (id: string) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const err = (r: any) => [r.status, r.error];

describe('perfil travado pela administração', () => {
  it('"Permitir alterar perfil" desligado não impede a troca de senha, nem a obrigatória', async () => {
    await settings({ Accounts_AllowUserProfileChange: false });
    try {
      const u = await newUser(A);
      expect(err(await profile(u, { bio: 'oi' }))).toEqual([403, 'Alteração de perfil desativada.']);
      // A tela manda os campos como estavam: sem mudança, nada é recusado.
      const me = await api('GET', 'me', undefined, u);
      expect((await profile(u, { name: me.name, username: me.username, email: me.email, bio: '', statusText: '' })).success).toBe(true);
      expect((await profile(u, { currentPassword: PW, newPassword: 'senha-nova-123' })).success).toBe(true);
      expect((await login(u.username, 'senha-nova-123')).userId).toBe(u.userId);

      const r = await api('POST', 'users.create', { username: 'troca.obrigatoria', name: 'Troca', email: 'troca@test.local', password: 'senha-provisoria-1', requirePasswordChange: true }, A);
      expect(r.success).toBe(true);
      const forced = await login('troca.obrigatoria', 'senha-provisoria-1');
      expect((await profile(forced, { newPassword: 'senha-definitiva-1' })).success).toBe(true);
      expect((await api('GET', 'me', undefined, await login('troca.obrigatoria', 'senha-definitiva-1'))).requirePasswordChange).toBe(false);
    } finally {
      await settings({ Accounts_AllowUserProfileChange: true });
    }
  });
});

describe('conta sem e-mail', () => {
  it('salva o resto do perfil com o campo de e-mail vazio', async () => {
    const r = await api('POST', 'users.create', { username: 'sem.email', name: 'Sem Email', password: PW }, A);
    expect(r.success).toBe(true);
    const u = await login('sem.email', PW);
    const ok = await profile(u, { name: 'Sem Email', username: 'sem.email', email: '', bio: 'Técnico de campo', statusText: '' });
    expect(ok.success).toBe(true);
    expect(await row(u.userId)).toMatchObject({ bio: 'Técnico de campo', email: null });
    // Com a troca de e-mail desligada também (o campo vazio não é uma troca).
    await settings({ Accounts_AllowEmailChange: false });
    try {
      expect((await profile(u, { email: '', bio: 'Supervisor' })).success).toBe(true);
    } finally {
      await settings({ Accounts_AllowEmailChange: true });
    }
    // Quem tem e-mail não fica sem ele pelo perfil.
    const v = await newUser(A);
    expect(err(await profile(v, { email: '  ', currentPassword: PW }))).toEqual([400, 'Informe o e-mail.']);
  });
});

describe('troca do próprio e-mail', () => {
  it('pede a senha atual, respeita os domínios permitidos e avisa o endereço antigo', async () => {
    const u = await newUser(A);
    const old = `${u.username}@test.local`;
    expect(err(await profile(u, { email: 'atacante@evil.example' }))).toEqual([400, 'Digite sua senha atual para trocar o e-mail.']);
    expect(err(await profile(u, { email: 'atacante@evil.example', currentPassword: 'errada-123' }))).toEqual([400, 'Senha atual incorreta.']);
    expect((await row(u.userId)).email).toBe(old);
    await settings({ Accounts_AllowedDomainsList: 'test.local, empresa.com.br' });
    try {
      expect(err(await profile(u, { email: 'fulano@gmail.com', currentPassword: PW }))).toEqual([400, 'Domínio de e-mail não permitido.']);
      const ok = await profile(u, { email: `novo.${u.username}@empresa.com.br`, currentPassword: PW });
      expect(ok.success).toBe(true);
    } finally {
      await settings({ Accounts_AllowedDomainsList: '' });
    }
    expect(await row(u.userId)).toMatchObject({ email: `novo.${u.username}@empresa.com.br`, email_verified: false });
    await sleep(50);
    const notice = outbox.find((m) => m.to === old);
    expect(notice?.subject).toContain('O e-mail da sua conta foi alterado');
    expect(notice?.text).toContain(`novo.${u.username}@empresa.com.br`);
    // A administração continua trocando sem a senha da pessoa (e sem aviso por aqui).
    outbox.length = 0;
    expect((await api('POST', 'users.update', { userId: u.userId, data: { email: `adm.${u.username}@test.local` } }, A)).success).toBe(true);
    await sleep(50);
    expect(outbox).toHaveLength(0);
  });
});

describe('contas LDAP e SSO', () => {
  it('conta só de OAuth não cria senha do chat nem troca o e-mail; a exclusão pede o nome de usuário', async () => {
    const u = await newUser(A);
    await pool.query(`UPDATE users SET auth_source = 'oauth', external_id = 'google:123', password_hash = NULL WHERE id = $1`, [u.userId]);
    expect(err(await profile(u, { newPassword: 'senha-local-123' }))).toEqual([403, 'Sua conta entra pelo provedor da empresa; a senha é trocada lá.']);
    expect((await row(u.userId)).password_hash).toBeNull();
    expect(err(await profile(u, { email: 'outro@test.local' }))).toEqual([403, 'Sua conta entra pelo provedor da empresa; o e-mail é atualizado por lá.']);
    expect((await profile(u, { name: 'Nome Novo' })).success).toBe(true);
    expect((await api('GET', 'me', undefined, u)).hasPassword).toBe(false);

    await settings({ Accounts_AllowDeleteOwnAccount: true });
    try {
      expect(err(await api('POST', 'users.deleteOwnAccount', { password: 'qualquer coisa' }, u))).toEqual([400, 'Digite seu nome de usuário para confirmar.']);
      expect((await api('POST', 'users.deleteOwnAccount', { username: `@${u.username.toUpperCase()}` }, u)).success).toBe(true);
      expect(await row(u.userId)).toBeUndefined();
    } finally {
      await settings({ Accounts_AllowDeleteOwnAccount: false });
    }
  });

  it('conta LDAP não muda nome, usuário, e-mail nem senha pelo perfil; o resto continua', async () => {
    const u = await newUser(A);
    await pool.query(`UPDATE users SET auth_source = 'ldap' WHERE id = $1`, [u.userId]);
    const locked = [403, 'Nome, nome de usuário e e-mail da sua conta vêm do diretório da empresa (LDAP) e são atualizados por lá.'];
    expect(err(await profile(u, { name: 'Outro Nome' }))).toEqual(locked);
    expect(err(await profile(u, { username: `${u.username}x` }))).toEqual(locked);
    expect(err(await profile(u, { email: 'outro@test.local', currentPassword: PW }))).toEqual(locked);
    expect(err(await profile(u, { currentPassword: PW, newPassword: 'senha-local-123' }))).toEqual([403, 'Sua conta entra pelo provedor da empresa; a senha é trocada lá.']);
    const me = await api('GET', 'me', undefined, u);
    expect((await profile(u, { name: me.name, username: me.username, email: me.email, bio: 'Plantão noturno' })).success).toBe(true);
    expect((await row(u.userId)).bio).toBe('Plantão noturno');
  });

  it('conta vinculada ao SAML que manteve a senha local troca a senha com a senha atual', async () => {
    const u = await newUser(A);
    await pool.query(`UPDATE users SET auth_source = 'saml', external_id = 'saml-1' WHERE id = $1`, [u.userId]);
    expect(err(await profile(u, { currentPassword: 'errada-123', newPassword: 'senha-nova-123' }))).toEqual([400, 'Senha atual incorreta.']);
    expect((await profile(u, { currentPassword: PW, newPassword: 'senha-nova-123' })).success).toBe(true);
  });
});

describe('nome de usuário reservado', () => {
  it('all e here não servem como nome de usuário em nenhum caminho', async () => {
    const u = await newUser(A);
    for (const name of ['here', 'ALL', 'Here']) expect(err(await profile(u, { username: name }))).toEqual([400, 'Esse nome de usuário é reservado.']);
    const created = await api('POST', 'users.create', { username: 'All', name: 'Todos', email: 'todos@test.local', password: PW }, A);
    expect(err(created)).toEqual([400, 'Esse nome de usuário é reservado.']);
    const reg = await api('POST', 'users.register', { username: 'here', name: 'Aqui', email: 'aqui@test.local', pass: 'Senha-forte-123' });
    expect(err(reg)).toEqual([400, 'Esse nome de usuário é reservado.']);
  });
});

describe('nome e Sobre', () => {
  it('nome obrigatório, com letras ou números, sem espaços sobrando e com limite; Sobre com limite; só texto', async () => {
    const u = await newUser(A);
    const noName = [400, 'Informe um nome com letras ou números.'];
    expect(err(await profile(u, { name: '' }))).toEqual(noName);
    expect(err(await profile(u, { name: '   ' }))).toEqual(noName);
    expect(err(await profile(u, { name: '\u200B\u200B\u202E' }))).toEqual(noName);
    expect(err(await profile(u, { name: '...' }))).toEqual(noName);
    expect(err(await profile(u, { name: 'N'.repeat(101) }))).toEqual([400, 'O nome pode ter no máximo 100 caracteres.']);
    expect(err(await profile(u, { name: 123 }))).toEqual([400, 'O campo Nome deve ser um texto.']);
    expect(err(await profile(u, { bio: { a: 1 } }))).toEqual([400, 'O campo Sobre deve ser um texto.']);
    expect(err(await profile(u, { statusText: 5 }))).toEqual([400, 'O campo Mensagem de status deve ser um texto.']);
    expect(err(await profile(u, { bio: 'x'.repeat(501) }))).toEqual([400, 'O campo Sobre pode ter no máximo 500 caracteres.']);
    const dm = await api('POST', 'im.create', { username: 'admin' }, u);
    await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi' } }, u);
    expect((await profile(u, { name: '  Ana \u200B  Souza\n', bio: '  Sobre mim  ' })).success).toBe(true);
    expect(await row(u.userId)).toMatchObject({ name: 'Ana Souza', bio: 'Sobre mim' });
    // As mensagens levam o nome já arrumado.
    const msgs = await pool.query('SELECT DISTINCT user_name FROM messages WHERE user_id = $1', [u.userId]);
    expect(msgs.rows).toEqual([{ user_name: 'Ana Souza' }]);
    // Um nome antigo fora das regras não impede salvar o resto (a tela manda o nome como estava).
    await pool.query(`UPDATE users SET name = $2 WHERE id = $1`, [u.userId, 'L'.repeat(300)]);
    expect((await profile(u, { name: 'L'.repeat(300), bio: 'ok' })).success).toBe(true);
    // A administração e o cadastro seguem as mesmas regras.
    expect(err(await api('POST', 'users.create', { username: 'nome.vazio', name: '  ', email: 'nv@test.local', password: PW }, A))).toEqual(noName);
    expect(err(await api('POST', 'users.update', { userId: u.userId, data: { name: '\u200B' } }, A))).toEqual(noName);
    expect(err(await api('POST', 'users.register', { username: 'sem.nome', name: ' ', email: 'sn@test.local', pass: 'Senha-forte-123' }))).toEqual(noName);
  });
});

describe('preferências', () => {
  it('só as chaves conhecidas, com valores válidos; null volta ao padrão', async () => {
    const u = await newUser(A);
    const set = (data: unknown) => api('POST', 'users.setPreferences', { data }, u);
    expect(err(await set({ desktopNotifications: 'sometimes' }))).toEqual([400, 'Valor inválido para a preferência desktopNotifications.']);
    expect(err(await set({ theme: 'purple' }))).toEqual([400, 'Valor inválido para a preferência theme.']);
    expect(err(await set({ sendOnEnter: 'false' }))).toEqual([400, 'Valor inválido para a preferência sendOnEnter.']);
    expect(err(await set({ lixo: 'x'.repeat(100_000) }))).toEqual([400, 'Preferência desconhecida: lixo.']);
    expect(err(await set({ constructor: 'x' }))).toEqual([400, 'Preferência desconhecida: constructor.']);
    const ok = await set({ theme: 'dark', desktopNotifications: 'nothing', notificationSound: false, stickerAnimation: 'hover', highlights: ['plantão'], language: 'en' });
    expect(ok.success).toBe(true);
    expect(ok.user.settings.preferences).toMatchObject({ theme: 'dark', desktopNotifications: 'nothing', notificationSound: false, stickerAnimation: 'hover', highlights: ['plantão'], language: 'en' });
    // Uma chave gravada antes da validação sai com null.
    await pool.query(`UPDATE users SET preferences = preferences || '{"lixo": "x"}'::jsonb WHERE id = $1`, [u.userId]);
    const cleaned = await set({ lixo: null, theme: null });
    expect(cleaned.success).toBe(true);
    expect(cleaned.user.settings.preferences).not.toHaveProperty('lixo');
    expect(cleaned.user.settings.preferences).not.toHaveProperty('theme');
  });
});

describe('foto do perfil e da sala', () => {
  // Começa com a assinatura do PNG: o servidor confere o conteúdo, não o tipo declarado.
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = (bytes: number) => new Blob([Buffer.concat([PNG_SIG, Buffer.alloc(Math.max(0, bytes - PNG_SIG.length))])], { type: 'image/png' });
  it('arquivo acima de 5 MB é recusado com a mensagem em português', async () => {
    const u = await newUser(A);
    const fd = new FormData();
    fd.append('image', png(6 * 1024 * 1024), 'grande.png');
    expect(err(await api('POST', 'users.setAvatar', fd, u))).toEqual([400, 'Imagem muito grande (máx. 5 MB).']);
    const small = new FormData();
    small.append('image', png(1000), 'foto.png');
    expect((await api('POST', 'users.setAvatar', small, u)).success).toBe(true);
  });

  it('arquivo que não é imagem é recusado, e o tipo gravado é o do conteúdo (com nosniff no /avatar)', async () => {
    const u = await newUser(A);
    const pdf = new FormData();
    pdf.append('image', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'image/png' }), 'foto.png');
    expect(err(await api('POST', 'users.setAvatar', pdf, u))).toEqual([400, 'O arquivo não é uma imagem PNG, JPEG, GIF ou WebP.']);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect(err(await api('POST', 'users.setAvatar', { avatarUrl: `data:image/png;base64,${svg}` }, u))).toEqual([400, 'O arquivo não é uma imagem PNG, JPEG, GIF ou WebP.']);
    expect((await row(u.userId)).avatar_etag).toBeNull();
    // Um PNG de verdade declarado como JPEG fica gravado como PNG.
    const real = new FormData();
    real.append('image', new Blob([await png(500).arrayBuffer()], { type: 'image/jpeg' }), 'foto.jpg');
    expect((await api('POST', 'users.setAvatar', real, u)).success).toBe(true);
    const res = await raw(`/avatar/${u.username}`, u);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await raw(`/avatar/uid/${u.userId}`, u)).headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('foto da sala: sem permissão é recusada antes de ler o arquivo; acima de 5 MB também', async () => {
    const owner = await newUser(A);
    const other = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `foto-${Date.now().toString(36)}`, members: [other.username] }, owner)).channel;
    const form = (bytes: number) => {
      const fd = new FormData();
      fd.append('roomId', ch._id);
      fd.append('image', png(bytes), 'sala.png');
      return fd;
    };
    expect((await api('POST', 'rooms.setAvatar', form(8 * 1024 * 1024), other)).status).toBe(403);
    expect(err(await api('POST', 'rooms.setAvatar', form(6 * 1024 * 1024), owner))).toEqual([400, 'Imagem muito grande (máx. 5 MB).']);
    expect((await api('POST', 'rooms.setAvatar', form(1000), owner)).success).toBe(true);
  });
});

describe('notificações e tempo real', () => {
  it('"Avisar sobre: Nada" também silencia as conversas diretas', async () => {
    const ana = await newUser(A);
    const carla = await newUser(A);
    const dm = await api('POST', 'im.create', { username: carla.username }, ana);
    const ws = connectWs(carla);
    await ws.ready;
    try {
      await api('POST', 'users.setPreferences', { data: { desktopNotifications: 'nothing' } }, carla);
      const quiet = await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi, Carla' } }, ana);
      await sleep(400);
      expect(ws.events.some((e) => e.type === 'notification' && e.messageId === quiet.message._id)).toBe(false);
      await api('POST', 'users.setPreferences', { data: { desktopNotifications: 'mentions' } }, carla);
      const loud = await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'e agora?' } }, ana);
      expect((await ws.waitFor((e) => e.type === 'notification' && e.messageId === loud.message._id)).title).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('mensagem de status do perfil chega aos outros pela presença; nome e usuário novos chegam às conversas diretas', async () => {
    const alice = await newUser(A);
    const bruno = await newUser(A);
    const dm = await api('POST', 'im.create', { username: alice.username }, bruno);
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      expect((await profile(alice, { statusText: 'Em reunião até 16h' })).success).toBe(true);
      const p = await ws.waitFor((e) => e.type === 'presence' && e.userId === alice.userId);
      expect(p.statusText).toBe('Em reunião até 16h');

      expect((await profile(alice, { name: 'Alice Nova' })).success).toBe(true);
      const sub = await ws.waitFor((e) => e.type === 'subscription' && e.subscription.rid === dm.room._id && e.subscription.fname === 'Alice Nova');
      expect(sub.subscription.name).toBe(alice.username);

      expect((await profile(alice, { username: `${alice.username}.nova` })).success).toBe(true);
      const renamed = await ws.waitFor((e) => e.type === 'subscription' && e.subscription.rid === dm.room._id && e.subscription.name === `${alice.username}.nova`);
      expect(renamed.subscription.fname).toBe('Alice Nova');
      expect((await ws.waitFor((e) => e.type === 'presence' && e.username === `${alice.username}.nova`)).userId).toBe(alice.userId);
    } finally {
      ws.close();
    }
  });
});
