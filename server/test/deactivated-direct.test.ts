import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Conta desativada: não se começa conversa direta com ela; a que já existe abre só para ler (sem escrever nem ligar).
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

const send = (auth: Auth, rid: string, msg: string) => api('POST', 'chat.sendMessage', { message: { rid, msg } }, auth);
const policy = async (auth: Auth, rid: string) => (await api('GET', 'rooms.info', { roomId: rid }, auth)).room.direct;
const dms = async () => Number((await pool.query(`SELECT count(*) FROM rooms WHERE t = 'd'`)).rows[0].count);

describe('conversa direta com conta desativada', () => {
  it('nova é recusada; a antiga reabre só para ler; a discussão dela segue aberta', async () => {
    const [alice, bruno, daniel] = [await newUser(A), await newUser(A), await newUser(A)];
    const old = await api('POST', 'im.create', { username: daniel.username }, alice);
    expect(old.status).toBe(200);
    const rid = old.room._id;
    expect((await send(daniel, rid, 'Oi Alice')).status).toBe(200);
    const disc = await api('POST', 'rooms.createDiscussion', { prid: rid, t_name: 'Passagem de turno' }, alice);
    expect(disc.status).toBe(200);
    expect(await policy(alice, rid)).toMatchObject({ canSend: true, canCall: true });

    expect((await api('POST', 'users.setActiveStatus', { userId: daniel.userId, activeStatus: false }, A)).success).toBe(true);
    try {
      // Nova, a dois ou em grupo: recusada antes de criar a sala.
      const before = await dms();
      const r = await api('POST', 'im.create', { username: daniel.username }, bruno);
      expect([r.status, r.errorType, r.error]).toEqual([400, 'error-user-deactivated', `A conta de @${daniel.username} está desativada.`]);
      const g = await api('POST', 'im.create', { usernames: `${daniel.username},${alice.username}` }, bruno);
      expect([g.status, g.errorType]).toEqual([400, 'error-user-deactivated']);
      expect(await dms()).toBe(before);

      // A que já existe reabre (histórico), mas rooms.info já diz que não dá para escrever nem ligar.
      const again = await api('POST', 'im.create', { username: daniel.username }, alice);
      expect(again.status).toBe(200);
      expect(again.room._id).toBe(rid);
      expect(await policy(alice, rid)).toEqual({
        canSend: false,
        canCall: false,
        sendBlockedReason: 'Este usuário está desativado.',
        callBlockedReason: 'Este usuário está desativado.',
      });
      expect((await send(alice, rid, 'Oi?')).error).toBe('Este usuário está desativado.');

      // A discussão criada na DM continua aceitando mensagens (o envio não a barra).
      expect(await policy(alice, disc.discussion._id)).toMatchObject({ canSend: true });
      expect((await send(alice, disc.discussion._id, 'anotação')).status).toBe(200);
    } finally {
      await api('POST', 'users.setActiveStatus', { userId: daniel.userId, activeStatus: true }, A);
    }
    // Reativada, tudo volta.
    expect(await policy(alice, rid)).toMatchObject({ canSend: true, canCall: true });
    expect((await send(alice, rid, 'Bem-vindo de volta')).status).toBe(200);
    expect((await api('POST', 'im.create', { username: daniel.username }, bruno)).status).toBe(200);
  });
});
