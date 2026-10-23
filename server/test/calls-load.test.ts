import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockViolations } from '../src/calls/model';
import { pool } from '../src/db/pool';
import { createSession, createUser } from '../src/services/users';
import { admin, api, startServer, stopServer, type Auth } from './helpers';
import { channel, join, settle, setSettings, setupSfu, sfuRoom, startIn } from './call-kit';
import type { FakeSfu } from './sfu-fake';

// Carga (§13.2): seis chamadas de 50 pessoas entrando ao mesmo tempo, com o LiveKit falso demorando 20 ms em cada
// resposta, enquanto alguém usa o chat.

let A: Auth;
let fake: FakeSfu;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await setSettings(A, { API_Enable_Rate_Limiter: false, Calls_Max_Participants: 50, Calls_Max_Total_Participants: 400 });
  fake = await setupSfu(A);
});
afterAll(async () => {
  await stopServer();
  await fake?.stop();
});

// Sem senha (o scrypt de 300 contas tomaria o teste todo): a sessão sai direto do serviço.
let seq = 0;
async function quickUser(): Promise<Auth> {
  const username = `carga${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const u = await createUser({ username, name: `Carga ${seq}`, joinDefaultChannels: false });
  const s = await createSession(u.id, { userAgent: 'teste' });
  return { userId: u.id, authToken: s.authToken, username };
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

describe('carga das chamadas em grupo', () => {
  it('300 entradas e 300 webhooks ao mesmo tempo (6 chamadas de 50) não travam o chat: GET me com p95 abaixo de 300 ms', { timeout: 180_000 }, async () => {
    const people: Auth[] = [];
    for (let i = 0; i < 300; i++) people.push(await quickUser());
    const watcher = await quickUser();
    const groups = Array.from({ length: 6 }, (_, g) => people.slice(g * 50, g * 50 + 50));
    const rooms: string[] = [];
    for (const g of groups) rooms.push(await channel(g[0], g.slice(1)));
    fake.delay(20);
    // Quem inicia entra primeiro (a chamada precisa existir); as outras 294 entradas e os 300 webhooks vêm juntos.
    const calls = await Promise.all(groups.map((g, i) => startIn(fake, g[0], rooms[i])));

    let maxWaiting = 0;
    const sampler = setInterval(() => {
      maxWaiting = Math.max(maxWaiting, pool.waitingCount);
    }, 1);
    const latencies: number[] = [];
    let storming = true;
    const chat = (async () => {
      while (storming) {
        const t = performance.now();
        const r = await api('GET', 'me', undefined, watcher);
        latencies.push(performance.now() - t);
        expect(r.success).toBe(true);
        await new Promise((res) => setTimeout(res, 10));
      }
    })();
    const errors: unknown[] = [];
    const t0 = performance.now();
    await Promise.all(
      groups.flatMap((g, i) =>
        g.slice(1).map(async (m) => {
          const r = await join(m, calls[i].id);
          if (!r.success) return void errors.push(r);
          await fake.join(sfuRoom(calls[i].id), m.userId, { permission: { canPublish: r.join.canPublish, canPublishSources: r.join.sources } });
        }),
      ),
    );
    await settle();
    const storm = performance.now() - t0;
    storming = false;
    await chat;
    clearInterval(sampler);
    fake.delay(0);

    console.log(`[carga] ${storm.toFixed(0)} ms; GET me: ${latencies.length} pedidos, p95 ${p95(latencies).toFixed(1)} ms, máximo ${Math.max(...latencies).toFixed(1)} ms; pool.waitingCount máximo ${maxWaiting}`);
    expect(errors).toEqual([]);
    const states = (await pool.query(`SELECT call_id, state, count(*)::int AS n FROM call_participants WHERE call_id = ANY($1) GROUP BY 1, 2`, [calls.map((c) => c.id)])).rows;
    expect(states).toHaveLength(6);
    for (const s of states) expect(s).toMatchObject({ state: 'joined', n: 50 });
    for (const c of calls) expect(fake.rooms.get(sfuRoom(c.id))!.participants.size).toBe(50);
    expect(latencies.length).toBeGreaterThan(5);
    expect(p95(latencies)).toBeLessThan(300);
    expect(maxWaiting).toBeLessThanOrEqual(10);
    expect(lockViolations()).toEqual([]);
  });
});
