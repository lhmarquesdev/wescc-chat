import pg from 'pg';
import { config } from '../config';

// Datas sempre como string ISO para o JSON das respostas.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(20, (v) => Number(v)); // bigint
pg.types.setTypeParser(1082, (v) => v); // date: mantém AAAA-MM-DD, sem fuso

// Quando o PostgreSQL reinicia (atualização do Docker, por exemplo), as conexões ociosas são encerradas e o
// pool emite 'error'. Sem este ouvinte o processo inteiro cairia; o pool abre conexões novas na próxima consulta.
function watch(p: pg.Pool) {
  p.on('error', (e) => console.error(`[db] conexão ociosa encerrada pelo banco: ${e.message}`));
  return p;
}

export let pool = watch(new pg.Pool({ connectionString: config.databaseUrl, max: 20 }));

export function setPool(p: pg.Pool) {
  pool = watch(p);
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool) {
  return db.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const r = await db.query<T>(text, params as any[]);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const r = await db.query<T>(text, params as any[]);
  return r.rows;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // Se nem o ROLLBACK passa, a conexão morreu: ela é descartada em vez de voltar ao pool.
    await client.query('ROLLBACK').catch((err) => (broken = err));
    throw e;
  } finally {
    client.release(broken);
  }
}
