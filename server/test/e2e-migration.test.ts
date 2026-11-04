// Migração 034 num banco de antes dela: canais e grupos marcados "criptografados" no tempo do rótulo (nada era cifrado)
// não travam a migração, porque o UPDATE vem antes da restrição; nenhuma sala começa criptografada, e o valor antigo de
// E2E_Enable não vale.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { resetDb } from './helpers';

const dir = path.resolve(import.meta.dirname, '../src/db/migrations');

describe('migração 034 (criptografia)', () => {
  afterAll(async () => {
    await resetDb();
  });

  it('canal e grupo com o rótulo antigo: a migração passa, as salas ficam abertas e a restrição vale daí em diante', async () => {
    await resetDb();
    // O banco como estava antes da 034.
    await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const before = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && f < '034')
      .sort();
    for (const f of before) {
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    }
    await pool.query(`INSERT INTO rooms (id, t, name, encrypted) VALUES ('canal-rotulo', 'c', 'canal-rotulo', true), ('grupo-rotulo', 'p', 'grupo-rotulo', true)`);
    await pool.query(`INSERT INTO settings (id, value) VALUES ('E2E_Enable', 'true') ON CONFLICT (id) DO UPDATE SET value = 'true'`);

    await migrate(() => {});

    const rooms = (await pool.query(`SELECT id, encrypted, e2e_key_id, e2e_rotate FROM rooms WHERE id LIKE '%-rotulo' ORDER BY id`)).rows;
    expect(rooms).toEqual([
      { id: 'canal-rotulo', encrypted: false, e2e_key_id: null, e2e_rotate: false },
      { id: 'grupo-rotulo', encrypted: false, e2e_key_id: null, e2e_rotate: false },
    ]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM settings WHERE id = 'E2E_Enable'`)).rows[0].n).toBe(0);
    // Daí em diante: canal não pode ser criptografado; grupo pode.
    await expect(pool.query(`UPDATE rooms SET encrypted = true WHERE id = 'canal-rotulo'`)).rejects.toThrow(/rooms_e2e_type/);
    await pool.query(`UPDATE rooms SET encrypted = true WHERE id = 'grupo-rotulo'`);
    // Mensagem cifrada não pode ter texto aberto (NOT VALID só pula as linhas antigas).
    await expect(
      pool.query(`INSERT INTO messages (id, room_id, username, msg, e2e) VALUES ('m-cifrada', 'grupo-rotulo', 'alguem', 'texto aberto', '{"v":1}')`),
    ).rejects.toThrow(/messages_e2e_no_text/);
    await pool.query(`INSERT INTO messages (id, room_id, username, msg, e2e) VALUES ('m-cifrada', 'grupo-rotulo', 'alguem', '', '{"v":1}')`);
  });
});
