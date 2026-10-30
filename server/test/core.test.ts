import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, connectWs, login, newUser, raw, sleep, startServer, stopServer, type Auth } from './helpers';
import { totpCode } from '../src/lib/totp';

let A: Auth;

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(stopServer);

describe('autenticação', () => {
  it('faz login, retorna me e permissões', async () => {
    const me = await api('GET', 'me', undefined, A);
    expect(me.success).toBe(true);
    expect(me.username).toBe('admin');
    expect(me.permissions).toContain('view-administration');
  });

  it('rejeita senha errada e token inválido', async () => {
    expect((await api('POST', 'login', { user: 'admin', password: 'x' })).status).toBe(401);
    expect((await api('GET', 'me', undefined, { ...A, authToken: 'nope' })).status).toBe(401);
  });

  it('cadastro público respeita política de senha', async () => {
    const weak = await api('POST', 'users.register', { username: 'fulano', name: 'Fulano', email: 'f@x.com', pass: '123' });
    expect(weak.errorType).toBe('error-password-policy-not-met');
    const ok = await api('POST', 'users.register', { username: 'fulano', name: 'Fulano', email: 'f@x.com', pass: 'senha-forte-1' });
    expect(ok.success).toBe(true);
    const u = await login('fulano', 'senha-forte-1');
    // Entra no canal padrão automaticamente
    const subs = await api('GET', 'subscriptions.get', undefined, u);
    expect(subs.update.map((s: any) => s.name)).toContain('geral');
  });

  it('2FA TOTP exige código no login', async () => {
    const u = await newUser(A);
    const en = await api('POST', 'users.2fa.enableTotp', {}, u);
    expect(en.secret).toBeTruthy();
    const ver = await api('POST', 'users.2fa.verifyTotp', { code: totpCode(en.secret) }, u);
    expect(ver.codes).toHaveLength(12);
    const r1 = await api('POST', 'login', { user: u.username, password: 'senha-forte-1' });
    expect(r1.errorType).toBe('totp-required');
    const r2 = await api('POST', 'login', { user: u.username, password: 'senha-forte-1', code: totpCode(en.secret) });
    expect(r2.data.authToken).toBeTruthy();
    // código de backup funciona uma única vez
    const r3 = await api('POST', 'login', { user: u.username, password: 'senha-forte-1', code: ver.codes[0] });
    expect(r3.data.authToken).toBeTruthy();
    const r4 = await api('POST', 'login', { user: u.username, password: 'senha-forte-1', code: ver.codes[0] });
    expect(r4.status).toBe(401);
  });

  it('gestão de dispositivos: lista e encerra sessões', async () => {
    const u = await newUser(A);
    const second = await login(u.username, 'senha-forte-1');
    const list = await api('GET', 'sessions.list', undefined, u);
    expect(list.sessions.length).toBe(2);
    const other = list.sessions.find((s: any) => !s.current);
    await api('POST', 'sessions.logout.me', { sessionId: other._id }, u);
    expect((await api('GET', 'me', undefined, second)).status).toBe(401);
    expect((await api('GET', 'me', undefined, u)).success).toBe(true);
    const all = await api('GET', 'sessions.list.all', undefined, A);
    expect(all.total).toBeGreaterThan(1);
  });
});

describe('salas e mensagens', () => {
  it('cria canal, envia, edita, reage, fixa e apaga mensagens', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'projeto-x', members: [u.username] }, A);
    expect(ch.channel.name).toBe('projeto-x');
    const rid = ch.channel._id;
    const sent = await api('POST', 'chat.sendMessage', { message: { rid, msg: `Olá @${u.username} veja #projeto-x` } }, A);
    expect(sent.message.mentions[0].username).toBe(u.username);
    expect(sent.message.channels[0].name).toBe('projeto-x');
    const subs = await api('GET', 'subscriptions.get', undefined, u);
    const sub = subs.update.find((s: any) => s.rid === rid);
    expect(sub.unread).toBe(1);
    expect(sub.userMentions).toBe(1);

    const upd = await api('POST', 'chat.update', { roomId: rid, msgId: sent.message._id, text: 'editada' }, A);
    expect(upd.message.msg).toBe('editada');
    expect(upd.message.editedBy.username).toBe('admin');

    await api('POST', 'chat.react', { messageId: sent.message._id, emoji: 'thumbsup' }, u);
    const got = await api('GET', 'chat.getMessage', { msgId: sent.message._id }, A);
    expect(got.message.reactions[':thumbsup:'].usernames).toEqual([u.username]);

    // Usuário comum não pode editar mensagem de outro
    expect((await api('POST', 'chat.update', { roomId: rid, msgId: sent.message._id, text: 'hack' }, u)).status).toBe(403);

    await api('POST', 'chat.pinMessage', { messageId: sent.message._id }, A);
    const pinned = await api('GET', 'chat.getPinnedMessages', { roomId: rid }, u);
    expect(pinned.messages).toHaveLength(1);

    await api('POST', 'subscriptions.read', { rid }, u);
    const subs2 = await api('GET', 'subscriptions.get', undefined, u);
    expect(subs2.update.find((s: any) => s.rid === rid).unread).toBe(0);

    await api('POST', 'chat.delete', { msgId: sent.message._id }, A);
    expect((await api('GET', 'chat.getMessage', { msgId: sent.message._id }, A)).status).toBe(404);
  });

  it('grupo privado não é visível para quem não é membro', async () => {
    const u = await newUser(A);
    const g = await api('POST', 'groups.create', { name: 'secreto' }, A);
    expect((await api('GET', 'rooms.info', { roomId: g.group._id }, u)).status).toBe(403);
    expect((await api('GET', 'channels.history', { roomId: g.group._id }, u)).status).toBe(403);
    await api('POST', 'groups.invite', { roomId: g.group._id, userId: u.userId }, A);
    expect((await api('GET', 'rooms.info', { roomId: g.group._id }, u)).success).toBe(true);
  });

  it('DMs, threads e discussões', async () => {
    const u = await newUser(A);
    const dm = await api('POST', 'im.create', { username: u.username }, A);
    const rid = dm.room._id;
    const again = await api('POST', 'im.create', { username: 'admin' }, u);
    expect(again.room._id).toBe(rid);
    const root = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'raiz' } }, A);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'resposta', tmid: root.message._id } }, u);
    const th = await api('GET', 'chat.getThreadMessages', { tmid: root.message._id }, A);
    expect(th.messages.map((m: any) => m.msg)).toEqual(['resposta']);
    const r = await api('GET', 'chat.getMessage', { msgId: root.message._id }, A);
    expect(r.message.tcount).toBe(1);
    const subs = await api('GET', 'subscriptions.get', undefined, u);
    expect(subs.update.find((s: any) => s.rid === rid).name).toBe('admin');

    const ch = await api('POST', 'channels.create', { name: 'com-discussao', members: [u.username] }, A);
    const d = await api('POST', 'rooms.createDiscussion', { prid: ch.channel._id, t_name: 'Planejamento', users: [u.username], reply: 'vamos lá' }, A);
    expect(d.discussion.prid).toBe(ch.channel._id);
    const list = await api('GET', 'rooms.getDiscussions', { roomId: ch.channel._id }, A);
    expect(list.discussions[0].fname).toBe('Planejamento');
  });

  it('busca com operadores', async () => {
    const ch = await api('POST', 'channels.create', { name: 'busca' }, A);
    const rid = ch.channel._id;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'relatório financeiro trimestral' } }, A);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'almoço amanhã?' } }, A);
    const r = await api('GET', 'chat.search', { roomId: rid, searchText: 'financ' }, A);
    expect(r.messages.map((m: any) => m.msg)).toEqual(['relatório financeiro trimestral']);
    const r2 = await api('GET', 'chat.search', { searchText: 'from:@admin almoço' }, A);
    expect(r2.messages.length).toBe(1);
  });

  it('comandos de barra', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'cmds' }, A);
    const rid = ch.channel._id;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: `/invite @${u.username}` } }, A);
    const members = await api('GET', 'channels.members', { roomId: rid }, A);
    expect(members.members.map((m: any) => m.username)).toContain(u.username);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: '/topic Novo tópico' } }, A);
    expect((await api('GET', 'rooms.info', { roomId: rid }, A)).room.topic).toBe('Novo tópico');
    const s = await api('POST', 'chat.sendMessage', { message: { rid, msg: '/shrug' } }, A);
    expect(s.message.msg).toContain('ツ');
  });

  it('confirmação de leitura', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'leitura', members: [u.username] }, A);
    const rid = ch.channel._id;
    const m = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'leia isto' } }, A);
    expect(m.message.unread).toBe(true);
    await api('POST', 'subscriptions.read', { rid }, u);
    const got = await api('GET', 'chat.getMessage', { msgId: m.message._id }, A);
    expect(got.message.unread).toBeFalsy();
    const rec = await api('GET', 'chat.getMessageReadReceipts', { messageId: m.message._id }, A);
    expect(rec.receipts.map((r: any) => r.user.username)).toEqual([u.username]);
  });

  it('upload e download de arquivo com controle de acesso', async () => {
    const u = await newUser(A);
    const g = await api('POST', 'groups.create', { name: 'arquivos' }, A);
    const fd = new FormData();
    fd.append('msg', 'segue o arquivo');
    fd.append('file', new Blob(['conteúdo de teste'], { type: 'text/plain' }), 'nota.txt');
    const up = await api('POST', `rooms.upload/${g.group._id}`, fd, A);
    expect(up.message.files[0].name).toBe('nota.txt');
    const url = up.message.attachments[0].title_link;
    const ok = await raw(url, A);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('conteúdo de teste');
    expect((await raw(url, u)).status).toBe(403);
    const files = await api('GET', 'groups.files', { roomId: g.group._id }, A);
    expect(files.files).toHaveLength(1);
  });

  it('envia mensagem de voz com duração e onda', async () => {
    const g = await api('POST', 'groups.create', { name: 'voz' }, A);
    const fd = new FormData();
    fd.append('voice', '1');
    fd.append('duration', '12.34');
    fd.append('waveform', '0,20,55,100,40');
    fd.append('file', new Blob(['opus'], { type: 'audio/webm;codecs=opus' }), 'Mensagem de voz.webm');
    const up = await api('POST', `rooms.upload/${g.group._id}`, fd, A);
    const att = up.message.attachments[0];
    expect(att.audio_url).toBeTruthy();
    expect(att).toMatchObject({ voice: true, audio_duration: 12.3, audio_waveform: [0, 20, 55, 100, 40] });
    expect(up.message.files[0]).toMatchObject({ voice: true, duration: 12.3, type: 'audio/webm' });
    // Onda inválida é descartada; arquivo que não é áudio não vira mensagem de voz.
    const bad = new FormData();
    bad.append('voice', '1');
    bad.append('waveform', '1,999');
    bad.append('file', new Blob(['opus'], { type: 'audio/ogg' }), 'a.ogg');
    const up2 = await api('POST', `rooms.upload/${g.group._id}`, bad, A);
    expect(up2.message.attachments[0].voice).toBe(true);
    expect(up2.message.attachments[0].audio_waveform).toBeUndefined();
    const txt = new FormData();
    txt.append('voice', '1');
    txt.append('file', new Blob(['x'], { type: 'text/plain' }), 'n.txt');
    const up3 = await api('POST', `rooms.upload/${g.group._id}`, txt, A);
    expect(up3.message.attachments[0].voice).toBeUndefined();
  });
});

describe('tempo real', () => {
  it('entrega mensagens, digitação e presença por WebSocket', async () => {
    const u = await newUser(A);
    const ch = await api('POST', 'channels.create', { name: 'ao-vivo', members: [u.username] }, A);
    const rid = ch.channel._id;
    const ws = connectWs(u);
    await ws.ready;
    const wsA = connectWs(A);
    await wsA.ready;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'em tempo real' } }, A);
    const ev = await ws.waitFor((e) => e.type === 'message' && e.message.msg === 'em tempo real');
    expect(ev.message.rid).toBe(rid);
    await ws.waitFor((e) => e.type === 'subscription' && e.subscription.rid === rid && e.subscription.unread === 1);
    wsA.send({ type: 'typing', rid, typing: true });
    await ws.waitFor((e) => e.type === 'typing' && e.username === 'admin');
    const me = await api('GET', 'users.info', { userId: u.userId }, A);
    expect(me.user.status).toBe('online');
    ws.close();
    await sleep(300);
    const after = await api('GET', 'users.info', { userId: u.userId }, A);
    expect(after.user.status).toBe('offline');
    wsA.close();
  });

  it('logout remoto derruba o WebSocket', async () => {
    const u = await newUser(A);
    const ws = connectWs(u);
    await ws.ready;
    await api('POST', 'users.logout', { userId: u.userId }, A);
    await ws.waitFor((e) => e.type === 'force_logout');
  });
});

describe('administração', () => {
  it('papéis customizados e permissões', async () => {
    const u = await newUser(A);
    const r = await api('POST', 'roles.create', { name: 'rh', description: 'Recursos humanos' }, A);
    expect(r.role._id).toBe('rh');
    await api('POST', 'permissions.update', { permissions: [{ _id: 'view-user-administration', roles: ['admin', 'rh'] }] }, A);
    expect((await api('GET', 'users.list', undefined, u)).users[0].email).toBeUndefined();
    await api('POST', 'roles.addUserToRole', { roleId: 'rh', username: u.username }, A);
    const me = await api('GET', 'me', undefined, u);
    expect(me.permissions).toContain('view-user-administration');
    expect((await api('GET', 'users.list', undefined, u)).users.length).toBeGreaterThan(0);
  });

  it('configurações, estatísticas, engajamento e auditoria', async () => {
    const s = await api('POST', 'settings', { settings: { Site_Name: 'Minha Empresa' } }, A);
    expect(s.changed).toEqual(['Site_Name']);
    const pub = await api('GET', 'settings.public');
    expect(pub.settings.find((x: any) => x._id === 'Site_Name').value).toBe('Minha Empresa');
    expect(pub.settings.find((x: any) => x._id === 'SMTP_Password')).toBeUndefined();
    const stats = await api('GET', 'statistics', undefined, A);
    expect(stats.users.total).toBeGreaterThan(1);
    const eng = await api('GET', 'engagement-dashboard/messages', undefined, A);
    expect(eng.total).toBeGreaterThan(0);
    const users = await api('GET', 'engagement-dashboard/users', undefined, A);
    expect(users.daily.length).toBe(30);
    const ch = await api('GET', 'directory', { type: 'channels', text: 'busca' }, A);
    const audit = await api('POST', 'audit.messages', { type: 'room', rid: ch.result[0]._id, startDate: '2000-01-01', endDate: '2999-01-01' }, A);
    expect(audit.messages.length).toBeGreaterThan(0);
    const log = await api('GET', 'audit.auditions', undefined, A);
    expect(log.events[0].action).toBe('audit.messages.query');
    const allLog = await api('GET', 'audit.log', { action: 'settings.*' }, A);
    expect(allLog.events.length).toBeGreaterThan(0);
  });

  it('política de retenção apaga mensagens antigas', async () => {
    const ch = await api('POST', 'channels.create', { name: 'retencao' }, A);
    const rid = ch.channel._id;
    const m = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'antiga' } }, A);
    const { pool } = await import('../src/db/pool');
    await pool.query(`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = $1`, [m.message._id]);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'nova' } }, A);
    await api('POST', 'settings', { settings: { RetentionPolicy_Enabled: true, RetentionPolicy_AppliesToChannels: true, RetentionPolicy_TTL_Channels: 30 } }, A);
    const r = await api('POST', 'retention.run', {}, A);
    expect(r.removed).toBeGreaterThan(0);
    const h = await api('GET', 'channels.history', { roomId: rid }, A);
    expect(h.messages.map((x: any) => x.msg)).toEqual(['nova']);
    await api('POST', 'settings', { settings: { RetentionPolicy_Enabled: false } }, A);
  });

  it('times: cria, adiciona sala e membros', async () => {
    const u = await newUser(A);
    const t = await api('POST', 'teams.create', { name: 'engenharia', type: 0 }, A);
    expect(t.team.name).toBe('engenharia');
    const room = await api('POST', 'teams.createRoom', { teamId: t.team._id, name: 'eng-backend', type: 'c' }, A);
    expect(room.room.teamId).toBe(t.team._id);
    await api('POST', 'teams.addMembers', { teamId: t.team._id, members: [{ userId: u.userId }] }, A);
    const members = await api('GET', 'teams.members', { teamId: t.team._id }, A);
    expect(members.members.map((m: any) => m.user.username)).toContain(u.username);
    const rooms = await api('GET', 'teams.listRooms', { teamId: t.team._id }, u);
    expect(rooms.rooms.map((r: any) => r.name)).toEqual(['eng-backend']);
    const mine = await api('GET', 'teams.list', undefined, u);
    expect(mine.teams[0].name).toBe('engenharia');
  });
});
