import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Ausência automática com mais de uma conexão (abas, aplicativo, celular): Ausente só quando todas estão paradas.
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

const status = async (id: string) => (await pool.query('SELECT status FROM users WHERE id = $1', [id])).rows[0].status as string;
async function until(id: string, want: string) {
  for (let i = 0; i < 50; i++) {
    if ((await status(id)) === want) return want;
    await sleep(40);
  }
  return status(id);
}
async function tab(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  return ws;
}

describe('ausência automática', () => {
  it('uma aba parada não deixa Ausente quem usa outra; todas paradas, sim', async () => {
    const u = await newUser(A);
    const a = await tab(u);
    const b = await tab(u);
    expect(await until(u.userId, 'online')).toBe('online');
    b.send({ type: 'idle', idle: true });
    await sleep(300);
    expect(await status(u.userId)).toBe('online');
    a.send({ type: 'idle', idle: true });
    expect(await until(u.userId, 'away')).toBe('away');
    // Mexeu numa delas: Disponível de novo.
    a.send({ type: 'idle', idle: false });
    expect(await until(u.userId, 'online')).toBe('online');
    // A ativa fecha e sobra só a parada: Ausente.
    a.close();
    expect(await until(u.userId, 'away')).toBe('away');
    // Uma aba nova (ativa) chega dizendo que não está parada: Disponível.
    const c = await tab(u);
    c.send({ type: 'idle', idle: false });
    expect(await until(u.userId, 'online')).toBe('online');
    b.close();
    c.close();
    expect(await until(u.userId, 'offline')).toBe('offline');
  });

  it('a aba que reconecta parada não volta a pessoa para Disponível', async () => {
    const u = await newUser(A);
    const a = await tab(u);
    a.send({ type: 'idle', idle: true });
    expect(await until(u.userId, 'away')).toBe('away');
    const b = await tab(u);
    b.send({ type: 'idle', idle: true });
    a.close();
    await sleep(300);
    expect(await status(u.userId)).toBe('away');
    b.close();
  });

  it('não mexe em quem escolheu Ocupado', async () => {
    const u = await newUser(A);
    const a = await tab(u);
    expect((await api('POST', 'users.setStatus', { status: 'busy' }, u)).success).toBe(true);
    a.send({ type: 'idle', idle: true });
    await sleep(300);
    expect(await status(u.userId)).toBe('busy');
    a.send({ type: 'idle', idle: false });
    await sleep(300);
    expect(await status(u.userId)).toBe('busy');
    a.close();
  });
});
