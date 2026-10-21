import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool';

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir() {
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

export async function migrate(log: (m: string) => void = console.log) {
  const client = await pool.connect();
  try {
    // Trava para que várias instâncias não migrem ao mesmo tempo.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migração aplicada: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

// Só como script (tsx src/db/migrate.ts); no bundle do esbuild import.meta.url é o dist/index.js.
if (process.argv[1] && path.basename(process.argv[1]).startsWith('migrate.') && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
