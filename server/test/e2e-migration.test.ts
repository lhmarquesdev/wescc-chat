// Migrações da criptografia num banco de antes delas. 034: canais e grupos marcados "criptografados" no tempo do rótulo
// (nada era cifrado) não travam a migração, porque o UPDATE vem antes da restrição; nenhuma sala começa criptografada, e
// o valor antigo de E2E_Enable não vale. 037: as saídas de antes da atualização vêm do histórico da sala.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { resetDb } from './helpers';

const dir = path.resolve(import.meta.dirname, '../src/db/migrations');

// Banco só com as migrações antes de `upto` (sem rodar a própria).
async function migrateUpTo(upto: string) {
  await resetDb();
  await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const before = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && f < upto)
    .sort();
  for (const f of before) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
}

describe('migração 034 (criptografia)', () => {
  afterAll(async () => {
    await resetDb();
  });

  it('canal e grupo com o rótulo antigo: a migração passa, as salas ficam abertas e a restrição vale daí em diante', async () => {
    // O banco como estava antes da 034.
    await migrateUpTo('034');
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

// Quando a 034 entrou (antes dela, "ligar a criptografia" era só um rótulo).
const applied034 = (ago: string) => pool.query(`UPDATE schema_migrations SET applied_at = now() - $1::interval WHERE name = '034_e2e.sql'`, [ago]);

// Migração 037 numa instalação com conversas criptografadas: quem saiu antes dela não tem registro de saída, e ele vem
// do que ficou na sala (mensagens de sistema desde que a criptografia foi ligada, mensagens cifradas, chaves entregues,
// leituras). Quem está na sala (nunca saiu ou já voltou) não ganha registro, e cada geração conhecida fica registrada.
describe('migração 037 (quem volta só lê dali para frente)', () => {
  afterAll(async () => {
    await resetDb();
  });

  it('saídas de antes da atualização vêm do histórico da sala; gerações vêm das chaves, das mensagens e da sala', async () => {
    await migrateUpTo('037');
    await applied034('8 days 12 hours');
    const users = ['ana', 'bruno', 'carla', 'davi', 'erika', 'fabio', 'gil', 'hugo'];
    for (const u of users) await pool.query('INSERT INTO users (id, username) VALUES ($1, $1)', [u]);
    const K1 = 'AAAAAAAAAAAAAAA1';
    const K2 = 'AAAAAAAAAAAAAAA2';
    const W = 'x'.repeat(342);
    await pool.query(`INSERT INTO rooms (id, t, name, encrypted, e2e_key_id, created_at) VALUES ('grupo', 'p', 'grupo', true, $1, now() - interval '10 days')`, [K2]);
    // Sala que nunca foi criptografada: ninguém conta.
    await pool.query(`INSERT INTO rooms (id, t, name, created_at) VALUES ('aberto', 'p', 'aberto', now() - interval '10 days')`);
    const msg = async (room: string, t: string | null, user: string, text: string, ago: string, e2e: unknown = null) =>
      (
        await pool.query(
          `INSERT INTO messages (id, room_id, user_id, username, msg, t, e2e, created_at) VALUES (md5(random()::text), $1, $2, $2, $3, $4, $5, now() - $6::interval) RETURNING id`,
          [room, user, text, t, e2e === null ? null : JSON.stringify(e2e), ago],
        )
      ).rows[0].id as string;
    // A criptografia foi ligada há 8 dias (a sala existe há 10; a 034 entrou há 8 dias e meio).
    await msg('grupo', 'uj', 'davi', 'davi', '9 days'); // entrou antes da criptografia
    await msg('grupo', 'ul', 'davi', 'davi', '9 days'); // e saiu antes também: volta como alguém novo
    await msg('grupo', 'room_e2e_enabled', 'ana', '', '8 days');
    await msg('grupo', 'ul', 'bruno', 'bruno', '5 days'); // saiu com a criptografia ligada
    await msg('grupo', 'ru', 'ana', 'carla', '4 days'); // foi removida
    await msg('grupo', 'au', 'ana', 'erika', '3 days'); // foi adicionada e não está mais (saiu sem mensagem)
    const cifrada = await msg('grupo', null, 'fabio', '', '2 days', { v: 1, kid: K1, iv: 'i'.repeat(16), ct: 'c'.repeat(40), by: 'fabio' }); // escreveu cifrado
    await pool.query(`INSERT INTO message_reads (message_id, user_id, room_id) VALUES ($1, 'gil', 'grupo')`, [cifrada]); // leu cifrado
    await msg('grupo', 'ul', 'hugo', 'hugo', '1 day'); // saiu e já voltou (está na sala): fica como está
    await msg('aberto', 'ul', 'bruno', 'bruno', '1 day');
    for (const u of ['ana', 'hugo']) await pool.query(`INSERT INTO subscriptions (id, room_id, user_id) VALUES (md5(random()::text), 'grupo', $1)`, [u]);
    await pool.query(`INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by, created_at) VALUES ('grupo', 'ana', $1, $2, 'ana', now() - interval '6 days')`, [K1, W]);
    await pool.query(`INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by) VALUES ('grupo', 'hugo', $1, $2, 'ana')`, [K2, W]);

    await migrate(() => {});

    const deps = (await pool.query(`SELECT room_id, user_id, left_key_id, returned_at FROM e2e_room_departures ORDER BY user_id`)).rows;
    expect(deps).toEqual(['bruno', 'carla', 'erika', 'fabio', 'gil'].map((u) => ({ room_id: 'grupo', user_id: u, left_key_id: null, returned_at: null })));
    const left = (await pool.query(`SELECT user_id, left_at FROM e2e_room_departures WHERE user_id IN ('bruno', 'fabio') ORDER BY user_id`)).rows;
    expect(Date.now() - new Date(left[0].left_at).getTime()).toBeGreaterThan(4 * 86400_000); // a hora do "saiu"
    expect(Date.now() - new Date(left[1].left_at).getTime()).toBeLessThan(60_000); // sem "saiu": a hora da atualização
    const gens = (await pool.query(`SELECT key_id, created_at FROM e2e_room_generations WHERE room_id = 'grupo' ORDER BY key_id`)).rows;
    expect(gens.map((g) => g.key_id)).toEqual([K1, K2]);
    // K1 vale desde a primeira chave entregue (antes da mensagem cifrada).
    expect(Date.now() - new Date(gens[0].created_at).getTime()).toBeGreaterThan(5 * 86400_000);
    // A conta ou a sala excluída leva o registro.
    await pool.query(`DELETE FROM users WHERE id = 'gil'`);
    await pool.query(`DELETE FROM rooms WHERE id = 'grupo'`);
    expect((await pool.query('SELECT count(*)::int AS n FROM e2e_room_departures')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM e2e_room_generations')).rows[0].n).toBe(0);
  });

  it('o começo da criptografia vem do que é de verdade: nascer criptografado e desligar e ligar não apaga quem saiu; o rótulo de antes da 034 não conta', async () => {
    await migrateUpTo('037');
    await applied034('10 days');
    for (const u of ['ana', 'carla', 'davi', 'erika', 'gil', 'hugo']) await pool.query('INSERT INTO users (id, username) VALUES ($1, $1)', [u]);
    const W = 'x'.repeat(342);
    const room = async (id: string, ago: string, key: string, keyAgo: string) => {
      await pool.query(`INSERT INTO rooms (id, t, name, encrypted, e2e_key_id, created_at) VALUES ($1, 'p', $1, true, $2, now() - $3::interval)`, [id, key, ago]);
      await pool.query(`INSERT INTO subscriptions (id, room_id, user_id) VALUES (md5(random()::text), $1, 'ana')`, [id]);
      await pool.query(`INSERT INTO e2e_room_keys (room_id, user_id, key_id, wrapped_key, provided_by, created_at) VALUES ($1, 'ana', $2, $3, 'ana', now() - $4::interval)`, [
        id,
        key,
        W,
        keyAgo,
      ]);
    };
    const msg = (rid: string, t: string, user: string, text: string, ago: string) =>
      pool.query(`INSERT INTO messages (id, room_id, user_id, username, msg, t, created_at) VALUES (md5(random()::text), $1, $2, $2, $3, $4, now() - $5::interval)`, [
        rid,
        user,
        text,
        t,
        ago,
      ]);
    // Grupo que nasceu criptografado (sem "ligou"): a Carla foi removida, e depois a criptografia foi desligada e ligada.
    await room('nasceu', '5 days', 'AAAAAAAAAAAAAAA1', '5 days');
    await msg('nasceu', 'ru', 'ana', 'carla', '4 days');
    await msg('nasceu', 'room_e2e_disabled', 'ana', '', '3 days');
    await msg('nasceu', 'room_e2e_enabled', 'ana', '', '2 days');
    // Grupo do tempo do rótulo: "ligou" e "desligou" antes da 034; o Davi foi removido com a sala aberta; a criptografia
    // de verdade foi ligada há 7 dias, e a Erika saiu depois.
    await room('rotulo', '20 days', 'AAAAAAAAAAAAAAA2', '7 days');
    await msg('rotulo', 'room_e2e_enabled', 'ana', '', '15 days');
    await msg('rotulo', 'room_e2e_disabled', 'ana', '', '12 days');
    await msg('rotulo', 'ru', 'ana', 'davi', '9 days');
    await msg('rotulo', 'room_e2e_enabled', 'ana', '', '7 days');
    await msg('rotulo', 'ul', 'erika', 'erika', '6 days');
    // Grupo criado aberto depois da 034 e criptografado depois: quem saiu antes de ligar não conta.
    await room('depois', '8 days', 'AAAAAAAAAAAAAAA3', '5 days');
    await msg('depois', 'ul', 'gil', 'gil', '6 days');
    await msg('depois', 'room_e2e_enabled', 'ana', '', '5 days');
    await msg('depois', 'ru', 'ana', 'hugo', '4 days');

    // Ivo redefiniu a criptografia ontem e está em dois grupos; só no "rotulo" a troca ainda está pendente.
    await pool.query(`INSERT INTO users (id, username) VALUES ('ivo', 'ivo')`);
    for (const r of ['rotulo', 'nasceu']) await pool.query(`INSERT INTO subscriptions (id, room_id, user_id) VALUES (md5(random()::text), $1, 'ivo')`, [r]);
    await pool.query(`UPDATE rooms SET e2e_rotate = true WHERE id = 'rotulo'`);
    await pool.query(`INSERT INTO audit_log (id, action, target, created_at) VALUES ('a1', 'user.e2e.reset', '{"userId":"ivo"}', now() - interval '1 day')`);

    await migrate(() => {});

    const deps = (await pool.query(`SELECT room_id, user_id FROM e2e_room_departures ORDER BY room_id, user_id`)).rows;
    expect(deps).toEqual([
      { room_id: 'depois', user_id: 'hugo' },
      { room_id: 'nasceu', user_id: 'carla' },
      { room_id: 'rotulo', user_id: 'erika' },
    ]);
    // A redefinição de antes da atualização vale onde a troca está pendente: a geração de antes não vai para ele.
    const resets = (await pool.query(`SELECT room_id, user_id, reset_at FROM e2e_room_resets`)).rows;
    expect(resets.map((r) => [r.room_id, r.user_id])).toEqual([['rotulo', 'ivo']]);
    expect(Date.now() - new Date(resets[0].reset_at).getTime()).toBeGreaterThan(20 * 3600_000);
  });
});
