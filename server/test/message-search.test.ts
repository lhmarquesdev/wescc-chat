import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { dayStartIn, parseSearchDay } from '../src/services/messages';
import { admin, api, startServer, stopServer, type Auth } from './helpers';

// Busca de mensagens da sala (chat.search): sem acento, nos arquivos, filtros de data válidos e no fuso de quem busca.
let A: Auth;
let rid: string;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  rid = (await api('POST', 'channels.create', { name: 'busca-msgs' }, A)).channel._id;
});
afterAll(() => stopServer());

const send = async (msg: string) => (await api('POST', 'chat.sendMessage', { message: { rid, msg } }, A)).message._id as string;
const search = (searchText: string, extra: Record<string, string> = {}) => api('GET', 'chat.search', { roomId: rid, searchText, ...extra }, A);
const ids = (r: any) => (r.messages ?? []).map((m: any) => m._id);

describe('chat.search: acentos', () => {
  it('acha "reunião" digitando "reuniao" e vice-versa, também por pedaço de palavra', async () => {
    const a = await send('A reunião de planejamento foi remarcada.');
    const b = await send("Copo d'água na mesa.");
    const c = await send('Plantao de sabado sem acento.');
    for (const q of ['reuniao', 'Reunião', 'REUNIAO planejamento', 'eunia']) expect(ids(await search(q)), q).toEqual([a]);
    for (const q of ['agua', 'água']) expect(ids(await search(q)), q).toEqual([b]);
    for (const q of ['plantão', 'sábado']) expect(ids(await search(q)), q).toEqual([c]);
  });
});

describe('chat.search: arquivos', () => {
  it('acha pelo nome do arquivo e pela legenda; nada de mensagem cifrada', async () => {
    const fd = new FormData();
    fd.append('description', 'Escala de novembro');
    fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'escala-plantao-novembro.pdf');
    const up = await api('POST', `rooms.upload/${rid}`, fd, A);
    expect(up.success).toBe(true);
    const id = up.message._id;
    for (const q of ['escala', 'novembro', 'plantao-novembro', 'Escala de novembro', 'plantão']) expect(ids(await search(q)), q).toContain(id);
    // O nome genérico de um arquivo cifrado não entra na busca.
    await pool.query(`UPDATE messages SET e2e = '{"ct":"x"}'::jsonb WHERE id = $1`, [id]);
    expect(ids(await search('escala'))).not.toContain(id);
    await pool.query(`UPDATE messages SET e2e = NULL WHERE id = $1`, [id]);
    expect(ids(await search('escala'))).toContain(id);
  });
});

describe('chat.search: datas', () => {
  it('data que não existe → 400 com o formato; DD/MM/AAAA vale como AAAA-MM-DD', async () => {
    for (const q of ['after:2026-02-30', 'before:2026-13-01', 'on:2026-11-31', 'on:31/04/2026', 'after:2026-1']) {
      const r = await search(q);
      expect(r.status, q).toBe(400);
      expect(r.errorType).toBe('error-invalid-date');
      expect(r.error).toBe(`Data inválida em ${q}. Use AAAA-MM-DD ou DD/MM/AAAA.`);
    }
    const id = await send('fechamento datas-br');
    await pool.query(`UPDATE messages SET created_at = '2026-03-10 12:00:00-03' WHERE id = $1`, [id]);
    for (const q of ['on:10/03/2026', 'on:2026-03-10', 'on:2026-3-10', 'after:09/03/2026', 'before:11/03/2026']) expect(ids(await search(`${q} datas-br`)), q).toEqual([id]);
    for (const q of ['on:11/03/2026', 'after:10/03/2026', 'before:10/03/2026']) expect(ids(await search(`${q} datas-br`)), q).toEqual([]);
  });

  it('o dia é o do fuso de quem busca: 23h30 de 18/11 em Brasília é 18/11, não 19/11', async () => {
    const id = await send('fechamento do caixa tz-teste');
    await pool.query(`UPDATE messages SET created_at = '2026-11-18 23:30:00-03' WHERE id = $1`, [id]);
    const tz = { tz: 'America/Sao_Paulo' };
    expect(ids(await search('on:2026-11-18 tz-teste', tz))).toEqual([id]);
    expect(ids(await search('on:2026-11-19 tz-teste', tz))).toEqual([]);
    expect(ids(await search('before:2026-11-19 tz-teste', tz))).toEqual([id]);
    expect(ids(await search('after:2026-11-18 tz-teste', tz))).toEqual([]);
    // Em UTC a mesma mensagem já é do dia 19.
    expect(ids(await search('on:2026-11-19 tz-teste', { tz: 'UTC' }))).toEqual([id]);
    // Fuso inválido: vale o do servidor (America/Sao_Paulo sem TZ).
    if (!process.env.TZ) expect(ids(await search('on:2026-11-18 tz-teste', { tz: 'Nada/Disso' }))).toEqual([id]);
  });

  it('dias válidos e começo do dia no fuso', () => {
    expect(parseSearchDay('2026-02-28')).toEqual([2026, 2, 28]);
    expect(parseSearchDay('29/02/2028')).toEqual([2028, 2, 29]);
    expect(parseSearchDay('29/02/2026')).toBeNull();
    expect(parseSearchDay('2026-00-10')).toBeNull();
    expect(parseSearchDay('ontem')).toBeNull();
    expect(dayStartIn('America/Sao_Paulo', 2026, 11, 18).toISOString()).toBe('2026-11-18T03:00:00.000Z');
    expect(dayStartIn('America/Sao_Paulo', 2026, 11, 31).toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(dayStartIn('UTC', 2026, 1, 1).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(dayStartIn('Asia/Tokyo', 2026, 1, 1).toISOString()).toBe('2025-12-31T15:00:00.000Z');
    // Horário de verão: em Nova York, 8/3/2026 começa ainda no horário padrão (-5), 9/3 já no de verão (-4).
    expect(dayStartIn('America/New_York', 2026, 3, 8).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(dayStartIn('America/New_York', 2026, 3, 9).toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('chat.search: páginas', () => {
  it('total conta todos os resultados e offset traz o resto', async () => {
    for (let i = 1; i <= 7; i++) await send(`lote-paginas ${i}`);
    const p1 = await search('lote-paginas', { count: '5' });
    expect(p1.total).toBe(7);
    expect(p1.messages).toHaveLength(5);
    const p2 = await search('lote-paginas', { count: '5', offset: '5' });
    expect(p2.total).toBe(7);
    expect(p2.messages).toHaveLength(2);
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(7);
  });
});

describe('chat.search: símbolos', () => {
  it('"%", "_", "C++" acham só o que tem o símbolo; % e _ não valem como curinga; aspas só agrupam', async () => {
    const room = (await api('POST', 'channels.create', { name: 'busca-simbolos' }, A)).channel._id;
    const say = async (msg: string) => (await api('POST', 'chat.sendMessage', { message: { rid: room, msg } }, A)).message._id as string;
    const pct = await say('Desconto de 50% liberado.');
    const und = await say('O arquivo config_final.txt está na pasta.');
    const cpp = await say('C++ e C# são linguagens diferentes (sim, sério).');
    const bang = await say('Cuidado com o degrau!');
    await say('Copa do mundo e calendário de cursos.');
    const find = async (q: string) => ids(await api('GET', 'chat.search', { roomId: room, searchText: q }, A)).sort();
    expect(await find('%')).toEqual([pct]);
    expect(await find('50%')).toEqual([pct]);
    expect(await find('_')).toEqual([und]);
    expect(await find('config_final')).toEqual([und]);
    expect(await find('C++')).toEqual([cpp]);
    expect(await find('C#')).toEqual([cpp]);
    expect(await find('linguagens C++')).toEqual([cpp]);
    expect(await find('!')).toEqual([bang]);
    for (const q of ['&', ':*', '\\', '%%', 'arquivo %', 'C++ inexistente', '"']) expect(await find(q), q).toEqual([]);
    expect(await find('"o arquivo"')).toEqual([und]);
    // Uma letra sem símbolo continua sendo começo de palavra.
    expect((await find('c')).length).toBeGreaterThan(1);
  });
});
