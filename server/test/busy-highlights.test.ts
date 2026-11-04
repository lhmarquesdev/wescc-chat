import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// "Ocupado" silencia as notificações de mensagem (desktop, som, push e e-mail), chamadas continuam tocando; palavras
// destacadas contam e avisam como uma menção.

// Os e-mails ficam numa caixa de saída em memória em vez de irem para um servidor SMTP.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => (outbox.push(m), true),
}));

// Serviço de push falso: guarda cada envio.
const pushed: { url: string }[] = [];
let pushOrigin = '';
const pushServer = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    pushed.push({ url: req.url! });
    res.writeHead(201).end();
  });
});

let A: Auth;
beforeAll(async () => {
  await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', () => r()));
  pushOrigin = `http://127.0.0.1:${(pushServer.address() as any).port}`;
  process.env.PUSH_EXTRA_ORIGINS = pushOrigin;
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Calls_Group_Enabled: false } }, A);
});
afterAll(async () => {
  await stopServer();
  pushServer.close();
});
beforeEach(() => {
  outbox.length = 0;
  pushed.length = 0;
});

type Ws = ReturnType<typeof connectWs>;
async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  const connectionId = ws.events.find((e) => e.type === 'connected').connectionId as string;
  return Object.assign(ws, { connectionId });
}
// Espera um evento que chegue depois deste ponto (os anteriores não contam).
function next(ws: Ws, pred: (e: any) => boolean, ms = 5000) {
  const since = ws.events.length;
  return () => ws.waitFor((e) => ws.events.indexOf(e) >= since && pred(e), ms);
}
const send = async (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => {
  const r = await api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.message;
};
const dmOf = async (from: Auth, to: Auth) => (await api('POST', 'im.create', { username: to.username }, from)).room._id as string;
const channelWith = async (owner: Auth, members: Auth[], name = `hl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`) =>
  (await api('POST', 'channels.create', { name, members: members.map((m) => m.username) }, owner)).channel as { _id: string; name: string };
const setStatus = (auth: Auth, body: Record<string, unknown>) => api('POST', 'users.setStatus', body, auth);
const subOf = async (auth: Auth, rid: string) => (await api('GET', 'subscriptions.getOne', { roomId: rid }, auth)).subscription;
const highlights = (auth: Auth, words: unknown) => api('POST', 'users.setPreferences', { data: { highlights: words } }, auth);
// Nenhuma notificação desta mensagem chega em ms milissegundos.
async function noNotification(ws: Ws, messageId: string, ms = 400) {
  await sleep(ms);
  return !ws.events.some((e) => e.type === 'notification' && e.messageId === messageId);
}
async function subscribePush(auth: Auth) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = { endpoint: `${pushOrigin}/push/${auth.username}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const r = await api('POST', 'push.webSubscribe', { subscription }, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
}
const pushesTo = (auth: Auth) => pushed.filter((p) => p.url === `/push/${auth.username}`);
async function settle(ms = 300) {
  await sleep(ms);
}

describe('"Ocupado" silencia as notificações de mensagem', () => {
  it('DM para quem está ocupado: sem notificação, mas os contadores sobem', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    const wb = await online(bruno);
    try {
      await setStatus(bruno, { status: 'busy' });
      const dm = await dmOf(ana, bruno);
      const counted = next(wb, (e) => e.type === 'subscription' && e.subscription.rid === dm && e.subscription.unread === 1);
      const m = await send(ana, dm, 'oi, está aí?');
      await counted();
      expect(await noNotification(wb, m._id)).toBe(true);
      // Menção num canal: userMentions sobe, sem notificação.
      const ch = await channelWith(ana, [bruno]);
      const mentioned = next(wb, (e) => e.type === 'subscription' && e.subscription.rid === ch._id && e.subscription.userMentions === 1);
      const m2 = await send(ana, ch._id, `@${bruno.username} olha isso`);
      expect((await mentioned()).subscription).toMatchObject({ alert: true, unread: 1 });
      expect(await noNotification(wb, m2._id)).toBe(true);
      // De volta a Disponível, a notificação volta.
      await setStatus(bruno, { status: 'online' });
      const n = next(wb, (e) => e.type === 'notification' && e.rid === dm);
      await send(ana, dm, 'e agora?');
      expect((await n()).text).toBe('e agora?');
    } finally {
      wb.close();
    }
  });

  it('"Em reunião" (tipo ocupado) também silencia', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    const wb = await online(bruno);
    try {
      await setStatus(bruno, { statusId: 'status-em-reuniao' });
      const dm = await dmOf(ana, bruno);
      const m = await send(ana, dm, 'reunião boa?');
      expect(await noNotification(wb, m._id)).toBe(true);
    } finally {
      wb.close();
    }
  });

  it('ocupado com o chat fechado: nem push nem e-mail (o de controle, disponível, recebe os dois)', async () => {
    await api('POST', 'settings', { settings: { Email_Notifications_Enabled: true } }, A);
    try {
      const ana = await newUser(A);
      const busy = await newUser(A);
      const free = await newUser(A);
      await subscribePush(busy);
      await subscribePush(free);
      await setStatus(busy, { status: 'busy' });
      await send(ana, await dmOf(ana, busy), 'para quem está ocupado');
      await send(ana, await dmOf(ana, free), 'para quem está disponível');
      await settle(500);
      expect(pushesTo(busy)).toHaveLength(0);
      expect(outbox.filter((m) => m.to === `${busy.username}@test.local`)).toHaveLength(0);
      expect(pushesTo(free)).toHaveLength(1);
      expect(outbox.filter((m) => m.to === `${free.username}@test.local`)).toHaveLength(1);
    } finally {
      await api('POST', 'settings', { settings: { Email_Notifications_Enabled: false } }, A);
    }
  });

  it('e-mail só para quem não tem o chat aberto (invisível conectado não recebe)', async () => {
    await api('POST', 'settings', { settings: { Email_Notifications_Enabled: true } }, A);
    try {
      const ana = await newUser(A);
      const bruno = await newUser(A);
      const dm = await dmOf(ana, bruno);
      const wb = await online(bruno);
      await setStatus(bruno, { status: 'offline' });
      await send(ana, dm, 'você está aí, invisível?');
      await settle();
      expect(outbox.filter((m) => m.to === `${bruno.username}@test.local`)).toHaveLength(0);
      wb.close();
      await settle(300);
      await send(ana, dm, 'agora saiu');
      await settle();
      const mails = outbox.filter((m) => m.to === `${bruno.username}@test.local`);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toMatch(/^\[Wescc Chat\] Mensagem direta de /);
    } finally {
      await api('POST', 'settings', { settings: { Email_Notifications_Enabled: false } }, A);
    }
  });

  it('chamadas continuam tocando para quem está ocupado (com o chat aberto e por push)', async () => {
    const caller = await newUser(A);
    const callee = await newUser(A);
    const rid = await dmOf(caller, callee);
    const [wc, wd] = await Promise.all([online(caller), online(callee)]);
    try {
      await setStatus(callee, { status: 'busy' });
      const ring = next(wd, (e) => e.type === 'call' && e.call.status === 'ringing');
      const started = await api('POST', 'calls.start', { roomId: rid, kind: 'audio', connectionId: wc.connectionId }, caller);
      expect(started.call).toMatchObject({ status: 'ringing' });
      expect((await ring()).call._id).toBe(started.call._id);
      await api('POST', 'calls.end', { callId: started.call._id }, caller);
    } finally {
      wd.close();
    }
    // Com o chat fechado, o toque chega por push mesmo ocupado.
    await subscribePush(callee);
    await settle(200);
    pushed.length = 0;
    const again = await api('POST', 'calls.start', { roomId: rid, kind: 'video', connectionId: wc.connectionId }, caller);
    expect(again.call).toMatchObject({ status: 'ringing' });
    await settle(400);
    expect(pushesTo(callee)).toHaveLength(1);
    wc.close();
  });
});

describe('palavras destacadas', () => {
  it('setPreferences valida e normaliza; os outros não veem a lista', async () => {
    const u = await newUser(A);
    const r = await highlights(u, ['  Plantão  ', 'plantao', 'servidor    fora', '', 'C++']);
    expect(r.success).toBe(true);
    expect(r.user.settings.preferences.highlights).toEqual(['Plantão', 'servidor fora', 'C++']);
    const err = async (words: unknown) => {
      const x = await highlights(u, words);
      return [x.status, x.errorType, x.error];
    };
    expect(await err(Array.from({ length: 21 }, (_, i) => `palavra${i}`))).toEqual([400, 'error-invalid-highlights', 'Use no máximo 20 palavras destacadas.']);
    expect(await err(['ok', 'a'])).toEqual([400, 'error-invalid-highlights', '“a”: cada palavra destacada precisa ter de 2 a 40 caracteres.']);
    expect(await err(['x'.repeat(41)])).toEqual([400, 'error-invalid-highlights', `“${'x'.repeat(41)}”: cada palavra destacada precisa ter de 2 a 40 caracteres.`]);
    expect(await err(['!!'])).toEqual([400, 'error-invalid-highlights', '“!!”: use letras ou números.']);
    expect(await err('plantão')).toEqual([400, 'error-invalid-highlights', 'Palavras destacadas: envie uma lista de textos.']);
    expect(await err([1, 2])).toEqual([400, 'error-invalid-highlights', 'Palavras destacadas: envie uma lista de textos.']);
    const bad = await api('POST', 'users.setPreferences', { data: ['x'] }, u);
    expect([bad.status, bad.errorType, bad.error]).toEqual([400, 'error-invalid-params', 'Preferências inválidas.']);
    // A lista recusada não muda o que estava salvo.
    expect((await api('GET', 'me', undefined, u)).preferences.highlights).toEqual(['Plantão', 'servidor fora', 'C++']);
    const other = await newUser(A);
    expect((await api('GET', 'users.info', { userId: u.userId }, other)).user.preferences).toBeUndefined();
  });

  it('outra aba fica sabendo (evento "user" só para a pessoa)', async () => {
    const u = await newUser(A);
    const other = await newUser(A);
    const [wu, wo] = await Promise.all([online(u), online(other)]);
    try {
      const ev = next(wu, (e) => e.type === 'user' && e.user._id === u.userId && e.user.preferences);
      await highlights(u, ['plantão']);
      expect((await ev()).user.preferences.highlights).toEqual(['plantão']);
      // Qualquer preferência, não só as palavras.
      const theme = next(wu, (e) => e.type === 'user' && e.user.preferences?.theme === 'dark');
      await api('POST', 'users.setPreferences', { data: { theme: 'dark' } }, u);
      expect((await theme()).user.preferences.highlights).toEqual(['plantão']);
      await sleep(200);
      expect(wo.events.some((e) => e.type === 'user' && e.user._id === u.userId)).toBe(false);
    } finally {
      wu.close();
      wo.close();
    }
  });

  it('palavra destacada conta como menção e avisa com "Só menções"', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(ana, [bruno]);
    const wb = await online(bruno);
    try {
      const n = next(wb, (e) => e.type === 'notification' && e.rid === ch._id);
      const sub = next(wb, (e) => e.type === 'subscription' && e.subscription.rid === ch._id && e.subscription.userMentions === 1);
      await send(ana, ch._id, 'Quem pega o PLANTAO?');
      expect((await sub()).subscription).toMatchObject({ alert: true, userMentions: 1 });
      expect((await n()).text).toContain('Quem pega o PLANTAO?');
      // Sem a palavra, "Só menções" não avisa.
      const m = await send(ana, ch._id, 'bom dia a todos');
      expect(await noNotification(wb, m._id)).toBe(true);
      expect((await subOf(bruno, ch._id)).userMentions).toBe(1);
    } finally {
      wb.close();
    }
  });

  it('limites da palavra, expressões e caracteres especiais', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão', 'servidor fora', 'c++']);
    const ch = await channelWith(ana, [bruno]);
    const mentions = async () => (await subOf(bruno, ch._id)).userMentions as number;
    for (const msg of ['o replantão foi ontem', 'plantãozinho rápido', 'plantaoX', 'servidorfora', 'cc++']) await send(ana, ch._id, msg);
    await settle(100);
    expect(await mentions()).toBe(0);
    await send(ana, ch._id, 'quem pega o #plantão, hein?');
    expect(await mentions()).toBe(1);
    await send(ana, ch._id, 'o SERVIDOR   fora de novo');
    expect(await mentions()).toBe(2);
    await send(ana, ch._id, 'c++ quebrou o build');
    expect(await mentions()).toBe(3);
  });

  it('em tópico: a resposta com a palavra põe o tópico em não lidas e avisa, mesmo sem seguir', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    const carla = await newUser(A);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(ana, [bruno, carla]);
    const root = await send(ana, ch._id, 'escala da semana');
    const wb = await online(bruno);
    try {
      const n = next(wb, (e) => e.type === 'notification' && e.rid === ch._id && e.tmid === root._id);
      const sub = next(wb, (e) => e.type === 'subscription' && e.subscription.rid === ch._id && e.subscription.tunread.includes(root._id));
      await send(carla, ch._id, 'fico com o plantão de sábado', { tmid: root._id });
      expect((await sub()).subscription.userMentions).toBe(1);
      await n();
    } finally {
      wb.close();
    }
  });

  it('quem escreveu não é destacado pelas próprias palavras', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(ana, ['plantão']);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(ana, [bruno]);
    await send(bruno, ch._id, 'eu pego o plantão');
    await settle(100);
    expect((await subOf(ana, ch._id)).userMentions).toBe(1);
    expect((await subOf(bruno, ch._id)).userMentions).toBe(0);
  });

  it('sala silenciada: conta, mas não avisa', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(ana, [bruno]);
    expect((await api('POST', 'rooms.saveNotification', { roomId: ch._id, notifications: { disableNotifications: true } }, bruno)).success).toBe(true);
    const wb = await online(bruno);
    try {
      const m = await send(ana, ch._id, 'plantão hoje?');
      expect(await noNotification(wb, m._id)).toBe(true);
      expect((await subOf(bruno, ch._id)).userMentions).toBe(1);
    } finally {
      wb.close();
    }
  });

  it('ocupado + palavra destacada: conta, mas não avisa', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    await setStatus(bruno, { status: 'busy' });
    const ch = await channelWith(ana, [bruno]);
    const wb = await online(bruno);
    try {
      const m = await send(ana, ch._id, 'plantão hoje?');
      expect(await noNotification(wb, m._id)).toBe(true);
      expect((await subOf(bruno, ch._id)).userMentions).toBe(1);
    } finally {
      wb.close();
    }
  });

  it('e-mail de palavra destacada: o assunto diz a palavra', async () => {
    await api('POST', 'settings', { settings: { Email_Notifications_Enabled: true } }, A);
    try {
      const ana = await newUser(A);
      const bruno = await newUser(A);
      await highlights(bruno, ['plantão']);
      const ch = await channelWith(ana, [bruno], `canal-${Date.now().toString(36)}`);
      await send(ana, ch._id, 'quem fica de PLANTAO?');
      await settle();
      const mail = outbox.find((m) => m.to === `${bruno.username}@test.local`);
      expect(mail?.subject).toBe(`[Wescc Chat] “plantão” em #${ch.name}`);
      // Menção direta continua com o assunto de menção.
      outbox.length = 0;
      await send(ana, ch._id, `@${bruno.username} e o plantão?`);
      await settle();
      expect(outbox.find((m) => m.to === `${bruno.username}@test.local`)?.subject).toBe(`[Wescc Chat] Você foi mencionado em #${ch.name}`);
    } finally {
      await api('POST', 'settings', { settings: { Email_Notifications_Enabled: false } }, A);
    }
  });

  it('mensagem de integração não destaca', async () => {
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(A, [bruno]);
    const { sendMessage } = await import('../src/services/messages');
    await sendMessage({ userId: A.userId, username: A.username, sessionId: 'teste' }, { rid: ch._id, msg: 'Issue PLAN-1: plantão do fim de semana' }, { integration: true });
    await settle(100);
    expect((await subOf(bruno, ch._id)).userMentions).toBe(0);
  });

  it('encaminhada: o texto levado não destaca de novo; só o comentário de quem encaminhou', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    const src = await channelWith(ana, []);
    const dest = await channelWith(ana, [bruno]);
    const orig = await send(ana, src._id, 'Quem pega o plantão hoje?');
    const wb = await online(bruno);
    try {
      const r1 = await api('POST', 'chat.forwardMessage', { messageId: orig._id, targets: [{ rid: dest._id }] }, ana);
      expect(r1.results?.[0]?.ok, JSON.stringify(r1)).toBe(true);
      expect(await noNotification(wb, r1.results[0].message._id)).toBe(true);
      expect((await subOf(bruno, dest._id)).userMentions).toBe(0);
      // A palavra no comentário avisa como uma menção.
      const n = next(wb, (e) => e.type === 'notification' && e.rid === dest._id);
      const r2 = await api('POST', 'chat.forwardMessage', { messageId: orig._id, targets: [{ rid: dest._id }], comment: 'o plantão é seu' }, ana);
      expect(r2.results?.[0]?.ok, JSON.stringify(r2)).toBe(true);
      expect((await n()).messageId).toBe(r2.results[0].message._id);
      expect((await subOf(bruno, dest._id)).userMentions).toBe(1);
    } finally {
      wb.close();
    }
  });

  it('editar e pôr a palavra não avisa de novo', async () => {
    const ana = await newUser(A);
    const bruno = await newUser(A);
    await highlights(bruno, ['plantão']);
    const ch = await channelWith(ana, [bruno]);
    const wb = await online(bruno);
    try {
      const m = await send(ana, ch._id, 'quem pega hoje?');
      expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'quem pega o plantão hoje?' }, ana)).success).toBe(true);
      expect(await noNotification(wb, m._id)).toBe(true);
      expect((await subOf(bruno, ch._id)).userMentions).toBe(0);
    } finally {
      wb.close();
    }
  });
});
