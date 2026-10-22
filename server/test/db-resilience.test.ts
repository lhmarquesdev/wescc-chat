import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { admin, api, connectWs, sleep, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
let killer: pg.Client;

beforeAll(async () => {
  await startServer();
  A = await admin();
  killer = new pg.Client({ connectionString: config.databaseUrl });
  await killer.connect();
});

afterAll(async () => {
  await killer.end().catch(() => {});
  await stopServer();
});

// Simula o reinício do PostgreSQL: o banco encerra todas as conexões do servidor de uma vez.
async function dropAllConnections() {
  const r = await killer.query(
    'SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) t',
  );
  return r.rows[0].n as number;
}

async function listening() {
  const r = await killer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN wescc_rt'");
  return r.rows[0].n as number;
}

describe('banco reiniciado', () => {
  it('o servidor continua de pé, volta a consultar e refaz o LISTEN', async () => {
    const ws = connectWs(A);
    await ws.ready;
    expect(await api('GET', 'me', undefined, A)).toMatchObject({ _id: A.userId });
    expect(await listening()).toBe(1);

    expect(await dropAllConnections()).toBeGreaterThan(0);
    await sleep(100);

    // O pool abre conexões novas sozinho.
    expect(await api('GET', 'me', undefined, A)).toMatchObject({ _id: A.userId });

    // O barramento volta a escutar (primeira tentativa em 1 s).
    let n = 0;
    for (let i = 0; i < 40 && n === 0; i++) {
      await sleep(100);
      n = await listening();
    }
    expect(n).toBe(1);

    // E entrega de novo o que outra instância publica.
    const payload = JSON.stringify({ o: 'outra-instancia', t: { user: A.userId }, e: { type: 'teste-reconexao' } });
    await killer.query('SELECT pg_notify($1, $2)', ['wescc_rt', payload]);
    await expect(ws.waitFor((e) => e.type === 'teste-reconexao', 3000)).resolves.toMatchObject({ type: 'teste-reconexao' });
    ws.close();
  });

  it('cai duas vezes seguidas e se recupera de novo', async () => {
    await dropAllConnections();
    await sleep(50);
    await dropAllConnections();
    expect(await api('GET', 'me', undefined, A)).toMatchObject({ _id: A.userId });
    let n = 0;
    for (let i = 0; i < 60 && n === 0; i++) {
      await sleep(100);
      n = await listening();
    }
    expect(n).toBe(1);
  });
});
