import { buildApp } from './app';
import { boot } from './boot';
import { config } from './config';
import { pool } from './db/pool';
import { bus } from './realtime/bus';
import { startScheduler } from './scheduler';

async function main() {
  const app = await buildApp();
  const log = (m: string) => app.log.info(m);
  await boot(log);
  const stop = config.disableCron ? () => {} : startScheduler(log);
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    stop();
    await app.close();
    await pool.query('DELETE FROM presence_connections WHERE instance_id = $1', [bus.origin]).catch(() => {});
    await pool.query('DELETE FROM instances WHERE id = $1', [bus.origin]).catch(() => {});
    await bus.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Uma promessa rejeitada sem tratamento (por exemplo, uma tarefa em segundo plano com o banco fora do ar)
// é registrada em vez de derrubar o servidor inteiro.
process.on('unhandledRejection', (e) => {
  console.error('[processo] promessa rejeitada sem tratamento:', e);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
