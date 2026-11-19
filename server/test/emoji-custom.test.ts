import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, raw, startServer, stopServer, type Auth } from './helpers';
import { png } from './sticker-bytes';

// Emojis personalizados: nomes e apelidos únicos (sem diferença de maiúsculas, nem iguais a um emoji padrão), arquivo
// pequeno e que seja mesmo imagem, a troca da imagem aparece para todo mundo e criar/apagar entra na auditoria
// (admsys-16, admsys-17, admsys-20, admsys-21).
let A: Auth;

const create = (name: string, file: Buffer, aliases = '', type = 'image/png') => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('aliases', aliases);
  fd.append('emoji', new Blob([new Uint8Array(file)], { type }), `${name}.png`);
  return api('POST', 'emoji-custom.create', fd, A);
};
const list = async () => (await api('GET', 'emoji-custom.list', undefined, A)).emojis.update as any[];
const small = (seed = 1) => png({ w: 32, h: 32, seed });

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

describe('emojis personalizados', () => {
  it('nome e apelidos: minúsculas, formato do nome e um código para um emoji só', async () => {
    expect((await create('LogoQA', small(), ':Marca:, marca ,logo_qa')).status).toBe(200);
    const logo = (await list()).find((e) => e.name === 'logoqa');
    expect(logo.aliases).toEqual(['marca', 'logo_qa']);

    const dupName = await create('LOGOQA', small());
    expect([dupName.status, dupName.errorType]).toEqual([400, 'error-emoji-exists']);
    expect(dupName.error).toContain(':logoqa:');
    const aliasTakesName = await create('outro', small(), 'logoqa');
    expect([aliasTakesName.status, aliasTakesName.error]).toEqual([400, 'Já existe um emoji com o nome ou apelido :logoqa:.']);
    const nameTakesAlias = await create('marca', small());
    expect(nameTakesAlias.errorType).toBe('error-emoji-exists');
    const standard = await create('smile', small());
    expect([standard.status, standard.error]).toEqual([400, ':smile: já é um emoji padrão. Escolha outro nome ou apelido.']);
    const standardAlias = await create('sorriso', small(), 'thumbsup');
    expect(standardAlias.errorType).toBe('error-emoji-exists');

    for (const bad of ['com espaço', '<b>x</b>', 'a'.repeat(300)]) {
      const r = await create('terceiro', small(), bad);
      expect([r.status, r.errorType]).toEqual([400, 'error-invalid-emoji-alias']);
    }
    const many = await create('muitos', small(), Array.from({ length: 11 }, (_, i) => `apelido${i}`).join(','));
    expect(many.error).toBe('Use no máximo 10 apelidos.');
    expect((await create('nome inválido', small())).errorType).toBe('error-invalid-emoji-name');
    expect((await list()).map((e) => e.name)).toEqual(['logoqa']);
  });

  it('o apelido nunca troca a imagem de outro emoji (o nome vence)', async () => {
    // Instalações antigas aceitavam um apelido igual ao nome de outro emoji.
    await pool.query(`INSERT INTO custom_emoji (id, name, aliases, content_type, data) VALUES ('velho', 'antigo', '{logoqa}', 'image/png', $1)`, [small(9)]);
    const r = await raw('/emoji-custom/logoqa');
    const logo = (await pool.query(`SELECT data FROM custom_emoji WHERE name = 'logoqa'`)).rows[0].data as Buffer;
    expect(Buffer.from(await r.arrayBuffer()).equals(logo)).toBe(true);
    await pool.query(`DELETE FROM custom_emoji WHERE id = 'velho'`);
  });

  it('recusa arquivo grande e arquivo que não é imagem; o tipo vem dos bytes', async () => {
    const big = png({ w: 400, h: 400, noise: true });
    expect(big.length).toBeGreaterThan(256 * 1024);
    const tooBig = await create('grandao', big);
    expect([tooBig.status, tooBig.error]).toEqual([413, 'A imagem passa de 256 KB.']);
    const fake = await create('falso', Buffer.from('<html><script>alert(1)</script></html>'));
    expect([fake.status, fake.errorType]).toEqual([400, 'error-invalid-image']);
    const broken = await create('quebrado', Buffer.concat([small().subarray(0, 20)]));
    expect([broken.status, broken.errorType]).toEqual([400, 'error-invalid-image']);
    // PNG enviado dizendo ser GIF: fica guardado como PNG.
    expect((await create('tipo', small(), '', 'image/gif')).status).toBe(200);
    const row = (await pool.query(`SELECT content_type FROM custom_emoji WHERE name = 'tipo'`)).rows[0];
    expect(row.content_type).toBe('image/png');
    expect((await list()).map((e) => e.name)).not.toContain('grandao');
  });

  it('a imagem trocada aparece: endereço com versão, nosniff e aviso em tempo real ao apagar', async () => {
    expect((await create('troca', small(1))).status).toBe(200);
    const first = (await list()).find((e) => e.name === 'troca');
    const v1 = new Date(first._updatedAt).getTime();
    const versioned = await raw(`/emoji-custom/troca?v=${v1}`);
    expect(versioned.headers.get('cache-control')).toContain('immutable');
    expect(versioned.headers.get('x-content-type-options')).toBe('nosniff');
    const plain = await raw('/emoji-custom/troca');
    expect(plain.headers.get('cache-control')).toBe('no-cache');

    const ws = connectWs(A);
    await ws.ready;
    try {
      expect((await api('POST', 'emoji-custom.delete', { emojiId: first._id }, A)).status).toBe(200);
      await ws.waitFor((e) => e.type === 'settings.changed' && e.settings.some((s: any) => s._id === '__emoji'));
    } finally {
      ws.close();
    }
    expect((await raw('/emoji-custom/troca')).status).toBe(404);
    expect((await api('POST', 'emoji-custom.delete', { emojiId: first._id }, A)).status).toBe(404);

    await new Promise((r) => setTimeout(r, 5));
    expect((await create('troca', small(2))).status).toBe(200);
    const second = (await list()).find((e) => e.name === 'troca');
    expect(new Date(second._updatedAt).getTime()).not.toBe(v1);
    // A versão antiga não fica guardada para sempre no navegador.
    expect((await raw(`/emoji-custom/troca?v=${v1}`)).headers.get('cache-control')).toBe('no-cache');
  });

  it('criar e apagar entram na auditoria', async () => {
    const log = await api('GET', 'audit.log', { action: 'emoji.*' }, A);
    const actions = log.events.map((e: any) => `${e.action}:${e.target.name}`);
    expect(actions).toContain('emoji.created:logoqa');
    expect(actions).toContain('emoji.created:troca');
    expect(actions).toContain('emoji.removed:troca');
    expect(log.events.every((e: any) => e.actor.username === 'admin')).toBe(true);
  });
});
