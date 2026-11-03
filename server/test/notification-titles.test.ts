import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

// Título e texto da notificação (desktop, push e e-mail) mostram a pessoa pelo nome, como as telas do chat.
let A: Auth;
let ana: Auth;
let bruno: Auth;
let carla: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  ana = await newUser(A, { name: 'Ana Souza' });
  bruno = await newUser(A, { name: 'Bruno Lima' });
  carla = await newUser(A, { name: 'Carla Dias' });
});
afterAll(() => stopServer());

async function notificationFor(to: Auth, send: () => Promise<any>) {
  const ws = connectWs(to);
  await ws.ready;
  try {
    const r = await send();
    return await ws.waitFor((e) => e.type === 'notification' && e.messageId === r.message._id);
  } finally {
    ws.close();
  }
}

describe('títulos das notificações', () => {
  it('conversa direta: título é o nome de quem enviou', async () => {
    const dm = await api('POST', 'im.create', { username: bruno.username }, ana);
    const n = await notificationFor(bruno, () => api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi' } }, ana));
    expect(n.title).toBe('Ana Souza');
    expect(n.text).toBe('oi');
  });

  it('canal: #canal no título e o nome de quem enviou no texto', async () => {
    const ch = (await api('POST', 'channels.create', { name: `ops-${Date.now().toString(36)}`, members: [bruno.username] }, ana)).channel;
    const n = await notificationFor(bruno, () => api('POST', 'chat.sendMessage', { message: { rid: ch._id, msg: `@${bruno.username} olha isso` } }, ana));
    expect(n.title).toBe(`#${ch.name}`);
    expect(n.text).toBe(`Ana Souza: @${bruno.username} olha isso`);
  });

  it('conversa em grupo: título com quem enviou e os nomes das pessoas (não "ana em ana")', async () => {
    const dm = await api('POST', 'im.create', { usernames: [bruno.username, carla.username].join(',') }, ana);
    expect(dm.success).toBe(true);
    const n = await notificationFor(carla, () => api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'reunião às 15h' } }, ana));
    expect(n.title).toBe('Ana Souza em Ana Souza, Bruno Lima e Carla Dias');
  });
});
