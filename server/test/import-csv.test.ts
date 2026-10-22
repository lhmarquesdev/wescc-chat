import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { pool } from '../src/db/pool';
import { memoryArchive, openArchive } from '../src/importer/archive';
import { contactsImporter, parseContactsCsv } from '../src/importer/importers/contacts';
import { csvImporter } from '../src/importer/importers/csv';
import { CSV_LIMITS, type CsvRow, CsvTextDecoder, csvRows, isJunkEntry, parseTimestamp, restOfRow, wrapperPrefix } from '../src/importer/importers/csv-util';
import { slackUsersImporter } from '../src/importer/importers/slack-users';
import { BUSY_STATES, ImportError, ST, type ArchiveSource, type ImportChannel, type ImportContact, type ImportMessage, type ImportUser, type Importer, type PrepareContext } from '../src/importer/types';
import { admin, api, sleep, startServer, stopServer, type Auth } from './helpers';

// Os importadores só leem o arquivo e entregam os registros ao contexto; aqui o contexto guarda tudo na memória.

interface Run {
  users: ImportUser[];
  channels: ImportChannel[];
  messages: ImportMessage[];
  contacts: ImportContact[];
  warnings: string[];
  steps: string[];
  statuses: (string | null)[];
  rates: number[];
}

interface Opts {
  imported?: string[]; // salas que vieram de uma importação anterior (import_map)
  cancelAfter?: number; // cancela depois de N registros
  progress?: (rate: number) => void;
}

function context(source: ArchiveSource, opts: Opts = {}) {
  const out: Run = { users: [], channels: [], messages: [], contacts: [], warnings: [], steps: [], statuses: [], rates: [] };
  let staged = 0;
  const ctx: PrepareContext = {
    operationId: 'op-teste',
    source,
    user: async (r) => void (staged++, out.users.push(r)),
    channel: async (r) => void (staged++, out.channels.push(r)),
    message: async (r) => void (staged++, out.messages.push(r)),
    contact: async (r) => void (staged++, out.contacts.push(r)),
    setStep: async (s) => void out.steps.push(s),
    setMessagesStatus: async (s) => void out.statuses.push(s),
    progress: (r) => {
      out.rates.push(r);
      opts.progress?.(r);
    },
    warn: (m) => void out.warnings.push(m),
    cancelled: () => opts.cancelAfter !== undefined && staged >= opts.cancelAfter,
    findImported: async (kind, id) => (kind === 'room' && opts.imported?.includes(id) ? 'sala-antiga' : null),
  };
  return { ctx, out };
}

async function prepare(importer: Importer, files: Record<string, string | Buffer>, opts: Opts = {}) {
  const { ctx, out } = context(memoryArchive(files, { kind: importer.sourceKind === 'file' ? 'file' : 'zip' }), opts);
  await importer.prepare(ctx);
  return out;
}

const csv = (files: Record<string, string | Buffer>, opts?: Opts) => prepare(csvImporter, files, opts);
const slackUsers = (content: string | Buffer) => prepare(slackUsersImporter, { 'membros.csv': content });
const contacts = (content: string | Buffer) => prepare(contactsImporter, { 'contatos.csv': content });

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (s: string) => Buffer.concat([BOM, Buffer.from(s)]);
const TS = '2023-11-14T22:13:20.000Z'; // 1700000000000
const increasing = (rates: number[]) => rates.slice(1, -1).every((r, i) => r > rates[i]);

function zipFile(items: [string, string | Buffer | null][]) {
  const z = new yazl.ZipFile();
  for (const [name, content] of items) {
    if (content === null) z.addEmptyDirectory(name);
    else z.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  }
  z.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
  });
}

let tmp = '';
beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wescc-import-csv-'));
});
afterAll(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

// Exemplo completo do formato (csv.md §3.16).
const EXAMPLE = {
  'users.csv': 'alice,alice@example.com,Alice Smith\nbob,bob@example.com,Bob Jones\ncarol,carol@example.com,"O\'Neil, Carol"\n',
  'channels.csv': 'town-square,alice,public,alice;bob;carol\ndesign-team,bob,private,bob;carol\n',
  'town-square/messages.csv': 'alice,1700000000000,Hello everyone!\nbob,1700000060000,"Hi Alice, welcome aboard"\ncarol,1700000120000,"Two lines:\nsecond line with ""quotes"""\n',
  'design-team/2023-11.csv': 'bob,1700000180000,Mockups are in the drive\ncarol,1700000240000,Looks great\n',
  'directmessages/messages.csv': 'alice,bob,1700000300000,Hey Bob\nbob,alice,1700000360000,"Hi! What\'s up?"\ncarol,alice,1700000420000,Lunch?\n',
  'contacts.csv': 'name,emails,phones,manager,id,company\nJane Doe,jane@example.com;jd@example.org,+5511999990000,alice,contact-1,ACME\n',
};

describe('importador CSV: formato', () => {
  it('lê o .zip de exemplo: usuários, canais, conversas diretas, mensagens e contatos', async () => {
    const r = await csv(EXAMPLE);
    expect(r.warnings).toEqual([]);
    // Quem está em users.csv é referido pelo id da pessoa (o e-mail), em canais, conversas e mensagens; os ids das
    // conversas e das mensagens continuam feitos dos nomes, para reimportar sem duplicar.
    const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((u) => `csv:u:${u}@example.com`);
    expect(r.users).toEqual([
      { importIds: [alice], emails: ['alice@example.com'], username: 'alice', name: 'Alice Smith' },
      { importIds: [bob], emails: ['bob@example.com'], username: 'bob', name: 'Bob Jones' },
      { importIds: [carol], emails: ['carol@example.com'], username: 'carol', name: "O'Neil, Carol" },
    ]);
    expect(r.channels).toEqual([
      { importIds: ['csv:c:town-square'], t: 'c', name: 'town-square', creator: alice, users: [alice, bob, carol] },
      { importIds: ['csv:c:design-team'], t: 'p', name: 'design-team', creator: bob, users: [bob, carol] },
      { importIds: ['csv:d:alice/bob'], t: 'd', users: [alice, bob] },
      { importIds: ['csv:d:alice/carol'], t: 'd', users: [alice, carol] },
    ]);
    expect(r.messages).toHaveLength(8);
    expect(r.messages.map((m) => m.rid)).toEqual([
      'csv:c:town-square',
      'csv:c:town-square',
      'csv:c:town-square',
      'csv:c:design-team',
      'csv:c:design-team',
      'csv:d:alice/bob',
      'csv:d:alice/bob',
      'csv:d:alice/carol',
    ]);
    // Texto entre aspas com quebra de linha e aspas duplicadas.
    expect(r.messages[2].msg).toBe('Two lines:\nsecond line with "quotes"');
    expect(r.messages[1].msg).toBe('Hi Alice, welcome aboard');
    expect(r.messages[7]).toMatchObject({ u: carol, msg: 'Lunch?', ts: new Date(1700000420000).toISOString() });
    expect(r.contacts).toEqual([
      { importIds: ['contact-1'], name: 'Jane Doe', emails: ['jane@example.com', 'jd@example.org'], phones: ['+5511999990000'], manager: 'alice', customFields: { company: 'ACME' } },
    ]);
    // Contadores da operação: as conversas diretas contam como canais.
    expect([r.users.length, r.channels.length, r.messages.length, r.contacts.length]).toEqual([3, 4, 8, 1]);
    expect(r.steps).toEqual([ST.preparingUsers, ST.preparingChannels, ST.preparingContacts, ST.preparingMessages]);
    expect(r.statuses).toEqual(['town-square/messages', null, 'design-team/2023-11', null, 'directmessages/messages', null]);
    expect(r.rates[0]).toBe(0);
    expect(r.rates.at(-1)).toBe(100);
    expect(increasing(r.rates)).toBe(true);
  });

  it('a mensagem tem id estável, sala, autor, data e texto', async () => {
    const files = { 'channels.csv': 'general,alice,public,alice\n', 'general/a.csv': 'alice,1700000000000,Olá\n' };
    const [m] = (await csv(files)).messages;
    expect(m).toEqual({ importId: expect.stringMatching(/^csv:m:[A-Za-z0-9_-]{22}$/), rid: 'csv:c:general', u: 'alice', ts: TS, msg: 'Olá' });
    // Reimportar o mesmo arquivo dá os mesmos ids: a conversão atualiza em vez de duplicar.
    expect((await csv(files)).messages[0].importId).toBe(m.importId);
  });

  it('linhas iguais no mesmo arquivo continuam sendo mensagens diferentes', async () => {
    const r = await csv({ 'channels.csv': 'general,alice,public,\n', 'general/a.csv': 'alice,1700000000000,oi\nalice,1700000000000,oi\nalice,1700000000000,tchau\n' });
    const ids = r.messages.map((m) => m.importId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}:2`);
  });

  it('uma sala com duas pastas de arquivos usa o mesmo id; a etapa de mensagens é marcada uma vez', async () => {
    const r = await csv({
      'general/first.csv': 'alice,1700000000000,primeira\n',
      'channels.csv': 'general,alice,public,alice;bob\n',
      'general/second.csv': 'bob,1700000001000,segunda\nalice,1700000002000,terceira\n',
    });
    expect(r.messages.map((m) => m.rid)).toEqual(['csv:c:general', 'csv:c:general', 'csv:c:general']);
    expect(r.steps.filter((s) => s === ST.preparingMessages)).toHaveLength(1);
    expect(r.statuses).toEqual(['general/first', null, 'general/second', null]);
  });

  it('reconhece Users.CSV e Channels.CSV, apara os campos e descarta membros vazios', async () => {
    const r = await csv({
      'Users.CSV': ' alice , alice@example.com , Alice Smith \n',
      'Channels.CSV': ' general , alice , Public , " alice ; bob " \nsecret , bob , Private , carol;;dave;\n',
    });
    const alice = 'csv:u:alice@example.com';
    expect(r.users).toEqual([{ importIds: [alice], emails: ['alice@example.com'], username: 'alice', name: 'Alice Smith' }]);
    expect(r.channels).toEqual([
      { importIds: ['csv:c:general'], t: 'c', name: 'general', creator: alice, users: [alice, 'bob'] },
      { importIds: ['csv:c:secret'], t: 'p', name: 'secret', creator: 'bob', users: ['carol', 'dave'] },
    ]);
  });

  it('conversas diretas: um canal por par, nos dois sentidos, em qualquer arquivo', async () => {
    const r = await csv({
      'directmessages/a.csv': 'alice,bob,1700000000000,oi\nbob,alice,1700000001000,olá\ncarol,,1700000002000,sem destinatário\n',
      'DirectMessages/b.csv': 'bob,alice,1700000003000,de novo\nalice,alice,1700000004000,nota para mim\n',
    });
    expect(r.channels).toEqual([
      { importIds: ['csv:d:alice/bob'], t: 'd', users: ['alice', 'bob'] },
      { importIds: ['csv:d:alice/alice'], t: 'd', users: ['alice'] },
    ]);
    expect(r.messages.map((m) => [m.rid, m.u, m.msg])).toEqual([
      ['csv:d:alice/bob', 'alice', 'oi'],
      ['csv:d:alice/bob', 'bob', 'olá'],
      ['csv:d:alice/bob', 'bob', 'de novo'],
      ['csv:d:alice/alice', 'alice', 'nota para mim'],
    ]);
    // A linha sem destinatário não cria conversa nem mensagem, mas aparece nos avisos.
    expect(r.warnings).toEqual(['"directmessages/a.csv": linha incompleta ignorada (cada linha precisa de remetente, destinatário, data e texto) (linha 3).']);
  });

  it('usuários fora de users.csv ficam como estão, e nenhuma conta existente é alterada na leitura', async () => {
    const r = await csv({
      'users.csv': 'Alice,alice@x.com,Alice\n',
      'channels.csv': 'general,ALICE,public,alice;dana\n',
      'general/m.csv': 'alice,1700000000000,oi\ndana,1700000001000,olá\n@ghost,1700000002000,boo\n',
      'directmessages/m.csv': 'dana,bob,1700000003000,oi bob\n',
    });
    // Sem diferença de maiúsculas, quem está em users.csv é referido pelo id da pessoa; os outros, pelo nome.
    const alice = 'csv:u:alice@x.com';
    expect(r.channels[0]).toMatchObject({ creator: alice, users: [alice, 'dana'] });
    expect(r.messages.map((m) => m.u)).toEqual([alice, 'dana', 'ghost', 'dana']);
    expect(r.channels[1]).toEqual({ importIds: ['csv:d:bob/dana'], t: 'd', users: ['bob', 'dana'] });
    expect(r.users).toHaveLength(1);
  });

  it('o id da pessoa de users.csv é o e-mail: outro arquivo com o mesmo nome, mas outra pessoa, tem outro id', async () => {
    const files = (row: string) => ({
      'users.csv': `${row}\n`,
      'channels.csv': 'rh,joao,private,joao;maria\n',
      'rh/m.csv': 'joao,1700000000000,salários\n',
      'directmessages/d.csv': 'maria,JOAO,1700000001000,oi\n',
    });
    const silva = await csv(files('joao,Joao.Silva@Outra.example,João Silva'));
    const id = 'csv:u:joao.silva@outra.example';
    expect(silva.users[0].importIds).toEqual([id]);
    expect(silva.channels[0]).toMatchObject({ creator: id, users: [id, 'maria'] });
    // O id da conversa é feito dos nomes (a conversão confere as pessoas), e os membros são as pessoas.
    expect(silva.channels[1]).toEqual({ importIds: ['csv:d:joao/maria'], t: 'd', users: [id, 'maria'] });
    expect(silva.messages.map((m) => m.u)).toEqual([id, 'maria']);
    // Mesmo nome, outro e-mail: outro id para a pessoa (o import_map de um não serve para o outro).
    const pereira = await csv(files('joao,joao.pereira@explorer.example,João Pereira'));
    expect(pereira.users[0].importIds).toEqual(['csv:u:joao.pereira@explorer.example']);
    expect(pereira.messages.map((m) => m.u)).toEqual(['csv:u:joao.pereira@explorer.example', 'maria']);
    // Sem e-mail, ou com algo que não é e-mail no lugar dele, o id é o nome (com prefixo, nunca o nome puro).
    for (const row of ['joao,,João', 'joao,-,João', 'JOAO, n/a ,João']) expect((await csv(files(row))).users[0].importIds).toEqual(['csv:u:joao']);
  });

  it('os ids das mensagens e das conversas diretas vêm dos nomes: pôr o e-mail em users.csv ou mandar o CSV sem users.csv não muda nenhum', async () => {
    const base = {
      'channels.csv': 'geral,ana,public,ana;bia\n',
      'geral/m.csv': 'ana,1700000000000,primeira\nbia,1700000001000,segunda\n',
      'directmessages/dm.csv': 'ana,bia,1700000002000,dm\n',
    };
    const semEmail = await csv({ 'users.csv': 'ana,,Ana\nbia,bia@x.example,Bia\n', ...base });
    const comEmail = await csv({ 'users.csv': 'ana,ana@x.example,Ana\nbia,bia@x.example,Bia\n', ...base });
    const semUsers = await csv(base);
    const keys = (r: Run) => ({ messages: r.messages.map((m) => [m.importId, m.rid]), directs: r.channels.filter((c) => c.t === 'd').map((c) => c.importIds) });
    expect(keys(semEmail)).toEqual(keys(comEmail));
    expect(keys(semUsers)).toEqual(keys(comEmail));
    expect(keys(comEmail).directs).toEqual([['csv:d:ana/bia']]);
    // Quem é a pessoa muda com o e-mail; os ids do conteúdo, não.
    expect(semEmail.messages[0].u).toBe('csv:u:ana');
    expect(comEmail.messages[0].u).toBe('csv:u:ana@x.example');
    expect(semUsers.messages[0].u).toBe('ana');
  });

  it('ignora __MACOSX, pastas, arquivos ocultos e o que fica solto na raiz', async () => {
    const r = await csv({
      '__MACOSX/._general': 'lixo',
      'general/': '',
      'general/.DS_Store': 'lixo',
      'Thumbs.db': 'lixo',
      'readme.txt': 'leia-me',
      'messages.csv': 'alice,1700000000000,oi\n',
      'planilha.xlsx': 'PK',
    });
    expect([r.users, r.channels, r.messages, r.contacts].every((l) => l.length === 0)).toBe(true);
    expect(r.statuses).toEqual([]);
    expect(r.warnings).toEqual([
      'Arquivo ignorado: "readme.txt".',
      '"messages.csv" está fora de uma pasta e foi ignorado. As mensagens de um canal vão numa pasta com o nome do canal (ex.: geral/mensagens.csv).',
      '"planilha.xlsx" foi ignorado: salve as planilhas como .csv (UTF-8, separado por vírgulas).',
      'O .zip não tem users.csv, channels.csv, contacts.csv nem pastas com mensagens. Veja na ajuda como montar o arquivo.',
    ]);
    expect(r.rates[0]).toBe(0);
    expect(r.rates.at(-1)).toBe(100);
  });

  it('um .zip só com __MACOSX não tem nada; só contacts.csv já basta', async () => {
    const empty = await csv({ '__MACOSX/a.csv': 'x', '__MACOSX/b/': '' });
    expect(empty.users.length + empty.channels.length + empty.messages.length + empty.contacts.length).toBe(0);
    expect(empty.warnings).toHaveLength(1);
    const only = await csv({ 'contacts.csv': 'name,emails\nJane,jane@x.com\n' });
    expect(only.contacts).toEqual([{ importIds: ['contact:jane@x.com'], name: 'Jane', emails: ['jane@x.com'], phones: [] }]);
    expect(only.warnings).toEqual([]);
  });

  it('contacts.csv tem cabeçalho e linhas vazias como ",," são ignoradas', async () => {
    const r = await csv({ 'contacts.csv': 'name,emails,phones\nJane,jane@x.com,+55 11 9999-0000\n,,\n' });
    expect(r.contacts).toEqual([{ importIds: ['contact:jane@x.com'], name: 'Jane', emails: ['jane@x.com'], phones: ['+55 11 9999-0000'] }]);
    expect(r.warnings).toEqual([]);
    expect(r.steps).toEqual([ST.preparingContacts]);
  });

  it('uma falha ao avisar o progresso não interrompe a leitura', async () => {
    const r = await csv(
      { 'users.csv': 'alice,a@x.com,Alice\nbob,b@x.com,Bob\n' },
      {
        progress: () => {
          throw new Error('websocket fora do ar');
        },
      },
    );
    expect(r.users).toHaveLength(2);
    expect(r.rates.at(-1)).toBe(100);
  });

  it('para quando a importação é cancelada', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `alice,${1700000000000 + i},mensagem ${i}`).join('\n');
    const r = await csv({ 'users.csv': 'alice,a@x.com,Alice\nbob,b@x.com,Bob\n', 'channels.csv': 'general,alice,public,\n', 'general/m.csv': big }, { cancelAfter: 600 });
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(2000);
    expect(r.rates.at(-1)).toBeLessThan(100);
    const early = await csv({ 'users.csv': 'alice,a@x.com,Alice\n', 'channels.csv': 'general,alice,public,\n' }, { cancelAfter: 1 });
    expect(early.channels).toEqual([]);
  });

  it('expõe os dados do importador para a lista', () => {
    expect(csvImporter).toMatchObject({ key: 'csv', name: 'CSV', accept: '.zip', sourceKind: 'zip-or-dir', visible: true });
    expect(slackUsersImporter).toMatchObject({ key: 'slack-users', accept: '.csv', sourceKind: 'file', visible: true });
    expect(contactsImporter).toMatchObject({ key: 'omnichannel_contact', accept: '.csv', sourceKind: 'file', visible: true });
    for (const i of [csvImporter, slackUsersImporter, contactsImporter]) expect(i.label && i.description).toBeTruthy();
  });
});

describe('importador CSV: correções em relação ao Rocket.Chat', () => {
  it('tira a marca BOM do UTF-8 (Excel), inclusive antes de um campo entre aspas', async () => {
    const r = await csv({
      'users.csv': withBom('"alice",alice@x.com,Alice\n'),
      'channels.csv': withBom('general,alice,public,alice\n'),
      'general/m.csv': withBom('alice,1700000000000,oi\n'),
      'contacts.csv': withBom('name,emails\nJane,jane@x.com\n'),
    });
    expect(r.users[0].importIds).toEqual(['csv:u:alice@x.com']);
    expect(r.messages[0].u).toBe('csv:u:alice@x.com');
    expect(r.contacts[0]).toMatchObject({ name: 'Jane' });
    expect(r.contacts[0].customFields).toBeUndefined();
  });

  it('aceita \\r\\n, \\r e linhas em branco no meio e no fim', async () => {
    const r = await csv({
      'users.csv': 'alice,a@x.com,Alice\r\n\r\nbob,b@x.com,Bob\r\n\r\n',
      'channels.csv': 'general,alice,public,alice;bob\rrandom,bob,public,bob\r',
      'general/m.csv': 'alice,1700000000000,"linha 1\r\nlinha 2"\r\n\r\n\r\nbob,1700000001000,fim\n\n',
    });
    expect(r.users.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(r.channels.map((c) => c.name)).toEqual(['general', 'random']);
    expect(r.messages.map((m) => m.msg)).toEqual(['linha 1\nlinha 2', 'fim']);
    expect(r.warnings).toEqual([]);
  });

  it('tira a pasta em volta de tudo quando o .zip foi feito da pasta', async () => {
    const r = await csv({
      'export/': '',
      'export/users.csv': 'alice,a@x.com,Alice\n',
      'export/channels.csv': 'geral,alice,public,alice\n',
      'export/geral/m.csv': 'alice,1700000000000,oi\n',
      'export/directmessages/d.csv': 'alice,bob,1700000001000,oi bob\n',
      '__MACOSX/export/._users.csv': 'lixo',
    });
    expect(r.users).toHaveLength(1);
    expect(r.channels.map((c) => c.importIds[0])).toEqual(['csv:c:geral', 'csv:d:alice/bob']);
    expect(r.messages.map((m) => m.rid)).toEqual(['csv:c:geral', 'csv:d:alice/bob']);
    expect(r.warnings).toEqual([]);
    // Duas pastas em volta também.
    const deep = await csv({ 'a/b/users.csv': 'alice,a@x.com,Alice\n', 'a/b/readme.txt': 'x' });
    expect(deep.users).toHaveLength(1);
    expect(deep.warnings).toEqual(['Arquivo ignorado: "readme.txt".']);
  });

  it('não confunde uma pasta de mensagens com a pasta em volta de tudo', async () => {
    const dms = await csv({ 'directmessages/d.csv': 'alice,bob,1700000000000,oi\n' });
    expect(dms.channels).toEqual([{ importIds: ['csv:d:alice/bob'], t: 'd', users: ['alice', 'bob'] }]);
    const folder = await csv({ 'geral/m.csv': 'alice,1700000000000,oi\n' });
    expect(folder.messages).toEqual([]);
    expect(folder.warnings).toEqual(['A pasta "geral" não tem linha em channels.csv; as mensagens dela foram ignoradas.']);
  });

  it('uma pasta sem linha em channels.csv é ignorada com um aviso só', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,alice\n',
      'general/m.csv': 'alice,1700000000000,oi\n',
      'random/a.csv': 'alice,1700000000000,perdida\n',
      'random/b.csv': 'alice,1700000001000,perdida também\n',
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['oi']);
    expect(r.warnings).toEqual(['A pasta "random" não tem linha em channels.csv; as mensagens dela foram ignoradas.']);
    expect(r.statuses).toEqual(['general/m', null]);
  });

  it('mensagens novas de um canal que veio numa importação anterior não precisam de channels.csv', async () => {
    const r = await csv({ 'antigo/m.csv': 'alice,1700000000000,continuação\n' }, { imported: ['csv:c:antigo'] });
    expect(r.messages).toEqual([expect.objectContaining({ rid: 'csv:c:antigo', msg: 'continuação' })]);
    expect(r.channels).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('liga a pasta ao canal sem diferença de maiúsculas e com acentos de qualquer forma (macOS)', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,\nreuniões,alice,private,\n',
      'General/m.csv': 'alice,1700000000000,oi\n',
      [`${'reuniões'.normalize('NFD')}/m.csv`]: 'alice,1700000001000,pauta\n',
    });
    expect(r.messages.map((m) => m.rid)).toEqual(['csv:c:general', 'csv:c:reuniões']);
    expect(r.warnings).toEqual([]);
  });

  it('só arquivos .csv dentro das pastas são mensagens', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,\n',
      'general/m.csv': 'alice,1700000000000,oi\n',
      'general/notas.txt': 'alice,1700000000000,não é mensagem\n',
      'general/.DS_Store': 'lixo',
    });
    expect(r.messages).toHaveLength(1);
    expect(r.warnings).toEqual(['Arquivo ignorado: "general/notas.txt" (nas pastas, só arquivos .csv são lidos).']);
  });

  it('datas: milissegundos, segundos (10 dígitos), ISO-8601; inválidas ficam com a hora da importação', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,\n',
      'general/m.csv': [
        'alice,1700000000000,ms',
        'alice,1700000000,segundos',
        'alice,2026-09-23T10:00:00Z,iso',
        'alice,1700000000000abc,inválida',
        'alice,,vazia',
        'alice,1700000001,segundos de novo',
      ].join('\n'),
      'directmessages/d.csv': 'alice,bob,2026-09-23T10:00:00.250-03:00,iso\nalice,bob,ontem,inválida\n',
    });
    expect(r.messages.map((m) => m.ts)).toEqual([TS, TS, '2026-09-23T10:00:00.000Z', undefined, undefined, '2023-11-14T22:13:21.000Z', '2026-09-23T13:00:00.250Z', undefined]);
    expect(r.messages[3]).not.toHaveProperty('ts');
    expect(r.warnings).toEqual([
      'Algumas datas estão em segundos (10 dígitos) e não em milissegundos; elas foram convertidas.',
      '"general/m.csv": 2 mensagens com data inválida ficaram com a hora da importação (linhas 4 e 5).',
      '"directmessages/d.csv": mensagem com data inválida ficou com a hora da importação (linha 2).',
    ]);
  });

  it('parseTimestamp', () => {
    const cases: [string, string | undefined][] = [
      ['1700000000000', TS],
      [' 1700000000000 ', TS],
      ['1.7e12', new Date(1.7e12).toISOString()],
      ['1700000000', TS],
      ['1700000000.5', '2023-11-14T22:13:20.500Z'],
      ['2026-09-23T10:00:00Z', '2026-09-23T10:00:00.000Z'],
      ['2026-09-23 10:00:00', '2026-09-23T10:00:00.000Z'],
      ['2026-09-23t10:00', '2026-09-23T10:00:00.000Z'],
      ['2026-09-23T10:00:00-03:00', '2026-09-23T13:00:00.000Z'],
      ['2026-09-23T10:00:00-03', '2026-09-23T13:00:00.000Z'],
      ['2026-09-23T10:00:00,5+0100', '2026-09-23T09:00:00.500Z'],
      ['2026-09-23', '2026-09-23T00:00:00.000Z'],
      ['1700000000000abc', undefined],
      ['', undefined],
      ['0', undefined],
      ['-5', undefined],
      ['0x10', undefined],
      ['ontem', undefined],
      ['99999999999999999', undefined],
      ['2026-13-45', undefined],
    ];
    for (const [raw, ts] of cases) expect([raw, parseTimestamp(raw).ts]).toEqual([raw, ts]);
    expect(parseTimestamp('1700000000').seconds).toBe(true);
    expect(parseTimestamp('1700000000000').seconds).toBe(false);
  });

  it('texto com vírgulas sem aspas fica inteiro; linhas incompletas são avisadas', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,\n',
      'general/m.csv': 'alice,1700000000000,Olá, tudo bem?  Sim,  tudo.\nbob,1700000001000\n,1700000002000,sem autor\nalice,1700000003000,ok,,\nalice,1700000004000,"com aspas",e mais\n',
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['Olá, tudo bem?  Sim,  tudo.', 'ok', 'com aspas,e mais']);
    expect(r.warnings).toEqual([
      '"general/m.csv": 2 mensagens com vírgulas no texto sem aspas (o texto foi mantido inteiro) (linhas 1 e 5).',
      '"general/m.csv": 2 linhas incompletas ignoradas (cada linha precisa de autor, data e texto) (linhas 2 e 3).',
    ]);
  });

  it('um erro de formato no meio de um arquivo de mensagens ignora o resto dele, e os outros continuam', async () => {
    const r = await csv({
      'channels.csv': 'general,alice,public,\n',
      'general/broken.csv': 'alice,1700000000000,"sem fechar\nbob,1700000001000,engolida\n',
      'general/meio.csv': 'alice,1700000000000,antes\nbob,1700000001000,"x"y\ncarol,1700000002000,depois\n',
      'general/valid.csv': 'bob,1700000003000,Oi\n',
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['antes', 'Oi']);
    expect(r.warnings).toEqual([
      'Não foi possível ler "general/broken.csv": aspas abertas e não fechadas (linha 1). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "general/meio.csv": texto logo depois de fechar as aspas (dentro de um campo entre aspas, escreva "" para cada aspa) (linha 2). As linhas a partir dela foram ignoradas.',
    ]);
    expect(r.statuses).toEqual(['general/broken', null, 'general/meio', null, 'general/valid', null]);
  });

  it('erro de formato em users.csv, channels.csv ou contacts.csv é fatal e diz o arquivo e a linha', async () => {
    await expect(csv({ 'users.csv': 'alice,a@x.com,Alice\nbob,"b@x.com,Bob\n' })).rejects.toThrow(
      new ImportError('Não foi possível ler "users.csv": aspas abertas e não fechadas (linha 2).'),
    );
    const err = await csv({ 'channels.csv': 'general,alice,public,\nrandom,bob,"public"x,\n' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/^Não foi possível ler "channels.csv": texto logo depois de fechar as aspas .* \(linha 2\)\.$/);
    await expect(csv({ 'contacts.csv': 'name,emails\n"Jane,j@x.com\n' })).rejects.toThrow(/"contacts.csv": aspas abertas e não fechadas \(linha 2\)/);
  });

  it('users.csv: e-mail vazio, nome de usuário a partir do e-mail, repetidos e cabeçalho', async () => {
    const r = await csv({
      'users.csv': 'username,email,name\nsemmail,,Sem Mail\n,maria.silva@x.com,Maria\n,,Só Nome\nzeca\nALICE,a@x.com,Alice\nalice,outra@x.com,Outra\n',
    });
    expect(r.users).toEqual([
      { importIds: ['csv:u:semmail'], emails: [], username: 'semmail', name: 'Sem Mail' },
      { importIds: ['csv:u:maria.silva@x.com'], emails: ['maria.silva@x.com'], username: 'maria.silva', name: 'Maria' },
      { importIds: ['csv:u:zeca'], emails: [], username: 'zeca' },
      { importIds: ['csv:u:a@x.com'], emails: ['a@x.com'], username: 'ALICE', name: 'Alice' },
    ]);
    expect(r.warnings).toEqual([
      '"users.csv": a primeira linha parece um cabeçalho e foi ignorada (este arquivo não leva cabeçalho).',
      '"users.csv": linha sem nome de usuário e sem e-mail ignorada (linha 4).',
      '"users.csv": usuário repetido ignorado (vale a primeira linha) (linha 7).',
    ]);
  });

  it('channels.csv: sem nome, repetido, tipo desconhecido, privado em português e membros separados por vírgula', async () => {
    const r = await csv({
      'channels.csv': 'name,creator,type,members\n,alice,public,\ngeral,alice,public,alice,bob\nGeral,bob,public,\nequipe,bob,privado,bob\nsegredo,bob,secreto,bob\npublica,bob,Pública,bob\n',
    });
    expect(r.channels.map((c) => [c.name, c.t, c.users])).toEqual([
      ['geral', 'c', ['alice', 'bob']],
      ['equipe', 'p', ['bob']],
      ['segredo', 'c', ['bob']],
      ['publica', 'c', ['bob']],
    ]);
    expect(r.warnings).toEqual([
      '"channels.csv": a primeira linha parece um cabeçalho e foi ignorada (este arquivo não leva cabeçalho).',
      '"channels.csv": linha sem nome de canal ignorada (linha 2).',
      '"channels.csv": canal repetido ignorado (vale a primeira linha) (linha 4).',
      '"channels.csv": canal com tipo desconhecido ficou público (use public ou private) (linha 6).',
    ]);
  });

  it('arquivo em Windows-1252 (Excel) é lido com os acentos certos', async () => {
    const r = await csv({
      'users.csv': Buffer.from('joao,joao@x.com,Jo\xe3o Concei\xe7\xe3o\n', 'latin1'),
      'channels.csv': 'geral,joao,public,joao\n',
      'geral/m.csv': Buffer.from('joao,1700000000000,Ol\xe1, tudo bem? \x93aspas\x94\n', 'latin1'),
    });
    expect(r.users[0].name).toBe('João Conceição');
    expect(r.messages[0].msg).toBe('Olá, tudo bem? “aspas”');
    expect(r.warnings).toEqual([
      '"users.csv" não está em UTF-8 e foi lido como Windows-1252 (o padrão do Excel). Confira se os acentos ficaram certos.',
      '"geral/m.csv" não está em UTF-8 e foi lido como Windows-1252 (o padrão do Excel). Confira se os acentos ficaram certos.',
      '"geral/m.csv": mensagem com vírgulas no texto sem aspas (o texto foi mantido inteiro) (linha 1).',
    ]);
  });

  it('arquivo separado por ponto e vírgula: users.csv falha com a dica, mensagens são avisadas', async () => {
    await expect(csv({ 'users.csv': 'alice;alice@x.com;Alice\n' })).rejects.toThrow(/"users.csv" parece usar ponto e vírgula/);
    await expect(csv({ 'channels.csv': 'geral;alice;public;alice\n' })).rejects.toThrow(/"channels.csv" parece usar ponto e vírgula/);
    const r = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': 'alice;1700000000000;Olá, tudo bem\n' });
    expect(r.messages).toEqual([]);
    expect(r.warnings[0]).toMatch(/^"geral\/m.csv" parece usar ponto e vírgula .* O arquivo foi ignorado\.$/);
  });

  it('arquivo de mensagens que não é texto (UTF-16, binário) é ignorado com aviso', async () => {
    const r = await csv({
      'channels.csv': 'geral,alice,public,\n',
      'geral/utf16.csv': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alice,1700000000000,oi\n', 'utf16le')]),
      'geral/bin.csv': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]),
      'geral/ok.csv': 'alice,1700000000000,oi\n',
    });
    expect(r.messages).toHaveLength(1);
    expect(r.warnings).toEqual([
      'Não foi possível ler "geral/utf16.csv": o arquivo está em UTF-16; salve de novo como "CSV UTF-8". O resto do arquivo foi ignorado.',
      'Não foi possível ler "geral/bin.csv": o arquivo não parece ser um .csv de texto. O resto do arquivo foi ignorado.',
    ]);
  });

  it('cabeçalho num arquivo de mensagens é ignorado com aviso', async () => {
    const r = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': 'author,timestamp,text\nalice,1700000000000,oi\n', 'directmessages/d.csv': 'from,to,timestamp,text\nalice,bob,1700000000000,oi\n' });
    expect(r.messages).toHaveLength(2);
    expect(r.warnings).toEqual([
      '"geral/m.csv": a primeira linha parece um cabeçalho e foi ignorada (este arquivo não leva cabeçalho).',
      '"directmessages/d.csv": a primeira linha parece um cabeçalho e foi ignorada (este arquivo não leva cabeçalho).',
    ]);
  });

  it('arquivo de mensagens grande é lido aos pedaços, com o progresso subindo', async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => `alice,${1700000000000 + i},"mensagem ${i} com acentuação: ção, ã, é — e ""aspas"""`);
    const r = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': rows.join('\r\n') });
    expect(r.messages).toHaveLength(20000);
    expect(r.messages[19999].msg).toBe('mensagem 19999 com acentuação: ção, ã, é — e "aspas"');
    expect(r.warnings).toEqual([]);
    expect(r.rates.length).toBeGreaterThan(3);
    expect(increasing(r.rates)).toBe(true);
  });
});

describe('importador CSV: .zip e pasta de verdade', () => {
  it('lê um .zip com entradas de pasta, pasta em volta de tudo e __MACOSX', async () => {
    const buf = await zipFile([
      ['exportacao/', null],
      ['exportacao/users.csv', 'alice,a@x.com,Alice\nbob,b@x.com,Bob\n'],
      ['exportacao/channels.csv', 'geral,alice,public,alice;bob\n'],
      ['exportacao/geral/', null],
      ['exportacao/geral/2024-01.csv', 'alice,1700000000000,oi\nbob,1700000001000,"olá, tudo bem?"\n'],
      ['exportacao/DirectMessages/conversas.csv', 'bob,alice,1700000002000,oi alice\n'],
      ['__MACOSX/exportacao/._users.csv', 'lixo'],
      ['exportacao/.DS_Store', 'lixo'],
    ]);
    const file = path.join(tmp, 'exportacao.zip');
    await fs.promises.writeFile(file, buf);
    const source = await openArchive(file, 'zip');
    const { ctx, out } = context(source);
    try {
      await csvImporter.prepare(ctx);
    } finally {
      await source.close();
    }
    expect(out.warnings).toEqual([]);
    expect(out.users.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(out.channels.map((c) => c.importIds[0])).toEqual(['csv:c:geral', 'csv:d:alice/bob']);
    expect(out.messages.map((m) => m.msg)).toEqual(['oi', 'olá, tudo bem?', 'oi alice']);
  });

  it('lê uma pasta descompactada no servidor', async () => {
    const dir = path.join(tmp, 'pasta');
    await fs.promises.mkdir(path.join(dir, 'geral'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'users.csv'), 'alice,a@x.com,Alice\n');
    await fs.promises.writeFile(path.join(dir, 'channels.csv'), 'geral,alice,public,alice\n');
    await fs.promises.writeFile(path.join(dir, 'geral', 'm.csv'), 'alice,1700000000000,oi\n');
    const { ctx, out } = context(await openArchive(dir, 'dir'));
    await csvImporter.prepare(ctx);
    expect([out.users.length, out.channels.length, out.messages.length]).toEqual([1, 1, 1]);
    expect(out.warnings).toEqual([]);
  });
});

describe('leitura de CSV', () => {
  it('decodifica UTF-8 recebido byte a byte, sem cortar acentos nem \\r\\n', () => {
    const text = 'olá,ação\r\n“citação” 😀\rfim\r';
    const bytes = Buffer.concat([BOM, Buffer.from(text)]);
    const d = new CsvTextDecoder();
    let out = '';
    for (const b of bytes) out += d.write(Buffer.from([b]));
    out += d.end();
    expect(out).toBe('olá,ação\n“citação” 😀\nfim\n');
    expect(d.legacy).toBe(false);
  });

  it('arquivo sem nenhum caractere UTF-8 válido é lido como Windows-1252, mesmo recebido aos pedaços', () => {
    let warned = 0;
    const d = new CsvTextDecoder(() => warned++);
    const out = d.write(Buffer.from('abc,')) + d.write(Buffer.from('Jo\xe3o\n', 'latin1')) + d.write(Buffer.from('S\xe3o\n', 'latin1')) + d.end();
    expect(out).toBe('abc,João\nSão\n');
    expect([d.legacy, warned]).toEqual([true, 1]);
  });

  it('entrega a linha onde cada registro começa', async () => {
    const rows = [];
    for await (const row of csvRows(Readable.from([Buffer.from('a,b\n\n"c\nd",e\n\nf,g')]))) rows.push([row.fields, row.line]);
    expect(rows).toEqual([
      [['a', 'b'], 1],
      [['c\nd', 'e'], 3],
      [['f', 'g'], 6],
    ]);
  });

  it('pasta em volta de tudo e arquivos de lixo', () => {
    const marker = (rel: string) => rel === 'users.csv';
    expect(wrapperPrefix(['x/users.csv', 'x/geral/m.csv'], marker)).toBe('x/');
    expect(wrapperPrefix(['x/y/users.csv', 'x/y/z.csv'], marker)).toBe('x/y/');
    expect(wrapperPrefix(['users.csv', 'geral/m.csv'], marker)).toBe('');
    expect(wrapperPrefix(['x/users.csv', 'y/m.csv'], marker)).toBe('');
    expect(wrapperPrefix(['geral/m.csv'], marker)).toBe('');
    expect(wrapperPrefix([], marker)).toBe('');
    for (const n of ['__MACOSX/a.csv', 'a/.DS_Store', '.hidden/x.csv', 'pasta/Thumbs.db', 'desktop.ini']) expect(isJunkEntry(n)).toBe(true);
    for (const n of ['users.csv', 'geral/m.csv', 'a.b/c.csv']) expect(isJunkEntry(n)).toBe(false);
  });
});

// ---------- Arquivos grandes, malformados ou feitos para travar o servidor ----------

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MiB = 1024 * 1024;

const elapsed = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n');

// Origem que entrega cada arquivo em pedaços de 16 KiB, sob demanda, e não deixa ler um arquivo inteiro de uma vez.
function chunkedSource(files: Record<string, string | Buffer>, kind: ArchiveSource['kind'] = 'zip') {
  const base = memoryArchive(files, { kind });
  const served = new Map<string, number>();
  const source: ArchiveSource = {
    ...base,
    read: async (entry) => {
      throw new Error(`"${entry.name}" foi lido inteiro`);
    },
    async stream(entry) {
      const buf = await base.read(entry);
      function* pieces() {
        for (let at = 0; at < buf.length; at += 16 * 1024) {
          served.set(entry.name, (served.get(entry.name) ?? 0) + 1);
          yield buf.subarray(at, at + 16 * 1024);
        }
      }
      return Readable.from(pieces(), { highWaterMark: 1 });
    },
  };
  return { source, served };
}

// Quantas vezes o laço de eventos rodou enquanto fn trabalhava.
async function loopTurns(fn: () => Promise<unknown>) {
  let turns = 0;
  let on = true;
  const turn = () => {
    if (!on) return;
    turns++;
    setImmediate(turn);
  };
  setImmediate(turn);
  try {
    await fn();
  } finally {
    on = false;
  }
  return turns;
}

describe('arquivos grandes, malformados ou feitos para travar o servidor', () => {
  it('users.csv, channels.csv, contacts.csv e a lista do Slack são lidos aos pedaços, sem carregar o arquivo inteiro', async () => {
    const files = {
      'users.csv': lines(30_000, (i) => `usuario${i},u${i}@x.com,Usuário ${i}`),
      'channels.csv': lines(30_000, (i) => `canal${i},usuario${i},public,usuario${i}`),
      'contacts.csv': `name,emails\n${lines(30_000, (i) => `Contato ${i},c${i}@x.com`)}`,
    };
    const { source, served } = chunkedSource(files);
    const { ctx, out } = context(source);
    const atFirst: Record<string, number> = {};
    const first = (kind: string, file: string, stage: (r: any) => Promise<void>) => async (r: any) => {
      atFirst[kind] ??= served.get(file) ?? 0;
      await stage(r);
    };
    ctx.user = first('user', 'users.csv', ctx.user);
    ctx.channel = first('channel', 'channels.csv', ctx.channel);
    ctx.contact = first('contact', 'contacts.csv', ctx.contact);
    await csvImporter.prepare(ctx);
    expect([out.users.length, out.channels.length, out.contacts.length]).toEqual([30_000, 30_000, 30_000]);
    for (const file of Object.keys(files)) expect(served.get(file)).toBeGreaterThan(40);
    // O primeiro registro de cada arquivo é entregue com só o começo do arquivo lido.
    expect(atFirst.user).toBeLessThan(5);
    expect(atFirst.channel).toBeLessThan(5);
    expect(atFirst.contact).toBeLessThan(5);

    for (const [importer, content] of [
      [slackUsersImporter, `username,email\n${lines(30_000, (i) => `u${i},u${i}@x.com`)}`],
      [contactsImporter, `name,phones\n${lines(30_000, (i) => `Contato ${i},+55 11 ${i}`)}`],
    ] as const) {
      const single = chunkedSource({ 'lista.csv': content }, 'file');
      const run = context(single.source);
      let at = -1;
      const stage = importer === slackUsersImporter ? 'user' : 'contact';
      const original = run.ctx[stage] as (r: unknown) => Promise<void>;
      run.ctx[stage] = (async (r: unknown) => {
        if (at < 0) at = single.served.get('lista.csv') ?? 0;
        await original(r);
      }) as any;
      await importer.prepare(run.ctx);
      expect(run.out.users.length + run.out.contacts.length).toBe(30_000);
      expect(single.served.get('lista.csv')).toBeGreaterThan(20);
      expect(at).toBeLessThan(5);
      expect(run.out.rates.at(-1)).toBe(100);
      expect(increasing(run.out.rates)).toBe(true);
    }
  });

  it('um .csv grande que chega de uma vez só não trava o servidor: a leitura dá vez aos outros a cada parte', async () => {
    const users = lines(40_000, (i) => `usuario${i},u${i}@x.com,Usuário ${i}`);
    const messages = lines(40_000, (i) => `alice,${1700000000000 + i},mensagem ${i}`);
    expect(users.length).toBeGreaterThan(MiB);
    // Antes da correção, cada arquivo era lido inteiro sem dar vez ao laço de eventos (0 voltas).
    expect(await loopTurns(() => csv({ 'users.csv': users }))).toBeGreaterThan(10);
    expect(await loopTurns(() => csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': messages }))).toBeGreaterThan(10);
    expect(await loopTurns(() => slackUsers(`username,email,fullname\n${users}`))).toBeGreaterThan(10);
    expect(await loopTurns(() => contacts(`username,emails,name\n${users}`))).toBeGreaterThan(10);
  });

  it('users.csv muito repetitivo num .zip pequeno não enche a memória', async () => {
    const zip = await zipFile([['users.csv', Buffer.alloc(MiB, 'a\n')]]);
    expect(zip.length).toBeLessThan(10 * 1024);
    const file = path.join(tmp, 'repetido.zip');
    await fs.promises.writeFile(file, zip);
    const source = await openArchive(file, 'zip');
    const { ctx, out } = context(source);
    const stage = ctx.user;
    let heap = -1;
    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    ctx.user = async (r) => {
      if (heap < 0) heap = process.memoryUsage().heapUsed - before;
      await stage(r);
    };
    try {
      await csvImporter.prepare(ctx);
    } finally {
      await source.close();
    }
    // Antes da correção, as 500 mil linhas ficavam na memória (mais de 100 MB) antes do primeiro usuário.
    expect(heap).toBeGreaterThanOrEqual(0);
    expect(heap).toBeLessThan(30 * MiB);
    expect(out.users).toEqual([{ importIds: ['csv:u:a'], emails: [], username: 'a' }]);
    expect(out.warnings).toEqual(['"users.csv": 524287 usuários repetidos ignorados (vale a primeira linha) (linhas 2, 3, 4, 5, 6 e outras).']);
  });

  it('tabela com linhas demais ou grande demais para com um erro claro', async () => {
    const saved = { ...CSV_LIMITS };
    try {
      CSV_LIMITS.maxTableRows = 3;
      const four = 'a,a@x.com\nb,b@x.com\nc,c@x.com\nd,d@x.com\n';
      await expect(csv({ 'users.csv': four })).rejects.toThrow(new ImportError('"users.csv" tem mais de 3 linhas. Divida o arquivo em partes menores e importe uma de cada vez.'));
      await expect(csv({ 'channels.csv': 'a,x,public,\nb,x,public,\nc,x,public,\nd,x,public,\n' })).rejects.toThrow(/"channels.csv" tem mais de 3 linhas/);
      await expect(slackUsers(`username,email\n${four}`)).rejects.toThrow(/"membros.csv" tem mais de 3 linhas/);
      await expect(contacts(`name,emails\n${four}`)).rejects.toThrow(/"contatos.csv" tem mais de 3 linhas/);
      // As mensagens não têm esse limite.
      const ok = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': lines(10, (i) => `alice,${1700000000000 + i},oi`) });
      expect(ok.messages).toHaveLength(10);
      CSV_LIMITS.maxTableRows = saved.maxTableRows;

      CSV_LIMITS.maxTableBytes = 20;
      await expect(csv({ 'channels.csv': 'geral,alice,public,alice;bob\n' })).rejects.toThrow(new ImportError('O arquivo "channels.csv" é grande demais para ser lido (máximo de 20 bytes).'));
      await expect(slackUsers('username,email\nana,ana@x.com\n')).rejects.toThrow(/"membros.csv" é grande demais/);
      // O tamanho declarado pode mentir: os bytes lidos também contam.
      const base = memoryArchive({ 'users.csv': 'alice,alice@x.com,Alice\nbob,bob@x.com,Bob\n' });
      const lying: ArchiveSource = { ...base, list: async () => [{ name: 'users.csv', size: 10, isDirectory: false }] };
      await expect(csvImporter.prepare(context(lying).ctx)).rejects.toThrow(/"users.csv" é grande demais para ser lido \(máximo de 20 bytes\)/);
    } finally {
      Object.assign(CSV_LIMITS, saved);
    }
  });

  it('texto com milhares de vírgulas seguidas não trava o servidor', async () => {
    const row = (raw: string): CsvRow => ({ fields: raw.split(','), line: 1, raw });
    const head = 'alice,1700000000000,';
    // Antes da correção, 20 mil vírgulas levavam 3 s, e 1 milhão, mais de uma hora.
    expect(elapsed(() => restOfRow(row(`${head}olá${','.repeat(20_000)}x`), 2))).toBeLessThan(100);
    const big = `${head}olá${','.repeat(1_000_000)}x`;
    let text = '';
    expect(elapsed(() => (text = restOfRow(row(big), 2)))).toBeLessThan(500);
    expect(text).toBe(big.slice(head.length));
    // Vírgulas e espaços no fim continuam saindo.
    expect(restOfRow(row(`${head}olá, mundo${', ,'.repeat(300_000)}`), 2)).toBe('olá, mundo');
    // De ponta a ponta, com uma linha perto do tamanho máximo de um registro.
    const line = `${head}oi${','.repeat(990_000)}x`;
    const r = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': `${line}\nalice,1700000000001,depois\n` });
    expect(r.messages.map((m) => m.msg)).toEqual([line.slice(head.length), 'depois']);
    expect(r.warnings).toEqual(['"geral/m.csv": mensagem com vírgulas no texto sem aspas (o texto foi mantido inteiro) (linha 1).']);
  });

  it('data com milhares de dígitos não trava o servidor', async () => {
    // Antes da correção, 20 mil dígitos levavam 1,6 s, e 1 milhão, quase uma hora.
    expect(elapsed(() => parseTimestamp(`${'1'.repeat(20_000)}x`))).toBeLessThan(100);
    let r: ReturnType<typeof parseTimestamp> = { ts: 'x' };
    expect(elapsed(() => (r = parseTimestamp(`${'1'.repeat(1_000_000)}x`)))).toBeLessThan(500);
    expect(r).toEqual({});
    expect(elapsed(() => parseTimestamp(`2026-09-23T10:00:00.${'1'.repeat(1_000_000)}x`))).toBeLessThan(500);
    expect(parseTimestamp(`${'1'.repeat(30)}.${'5'.repeat(30)}x`)).toEqual({});
    expect(parseTimestamp('1.e12').ts).toBe(new Date(1e12).toISOString());
    const m = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': `alice,${'1'.repeat(990_000)}x,oi\nalice,1700000000000,depois\n` });
    expect(m.messages.map((x) => [x.msg, x.ts])).toEqual([
      ['oi', undefined],
      ['depois', TS],
    ]);
    expect(m.warnings).toEqual(['"geral/m.csv": mensagem com data inválida ficou com a hora da importação (linha 1).']);
  });

  it('um byte inválido num arquivo UTF-8 vira "�" sem estragar os acentos certos', async () => {
    const stray = (...parts: (string | number)[]) => Buffer.concat(parts.map((p) => (typeof p === 'number' ? Buffer.from([p]) : Buffer.from(p))));
    const r = await csv({ 'users.csv': stray('joao,joao@x.com,João Silva\nmaria,maria@x.com,Maria Conceição\njose,j@x.com,Jos', 0xe9, '\n') });
    expect(r.users.map((u) => u.name)).toEqual(['João Silva', 'Maria Conceição', 'Jos�']);
    expect(r.warnings).toEqual(['"users.csv" tem bytes que não são UTF-8 válido; eles foram trocados por "�" (o primeiro na linha 3). Confira o texto dessas linhas.']);

    // O byte inválido antes dos acentos certos, no mesmo arquivo: continua UTF-8.
    const before = await csv({ 'users.csv': stray('jose,j@x.com,Jos', 0xe9, '\njoao,joao@x.com,João Conceição\n') });
    expect(before.users.map((u) => u.name)).toEqual(['Jos�', 'João Conceição']);

    // Num arquivo de mensagens lido aos pedaços, o byte inválido depois de muitas linhas certas só muda a própria linha.
    const ok = lines(5000, (i) => `alice,${1700000000000 + i},ação ${i}`).replace(/\n/g, '\r\n');
    const m = await csv({
      'channels.csv': 'geral,alice,public,\n',
      'geral/m.csv': stray(ok, '\r\nalice,1700000009999,caf', 0xe9, ' com leite\r\nalice,1700000010000,depois: ação\r\n'),
    });
    expect(m.messages).toHaveLength(5002);
    expect(m.messages.slice(-3).map((x) => x.msg)).toEqual(['ação 4999', 'caf� com leite', 'depois: ação']);
    expect(m.warnings).toEqual(['"geral/m.csv" tem bytes que não são UTF-8 válido; eles foram trocados por "�" (o primeiro na linha 5001). Confira o texto dessas linhas.']);

    // Windows-1252 de verdade continua Windows-1252, mesmo com um par de bytes que por acaso é UTF-8 válido (Ã + espaço fixo).
    const legacy = await contacts(Buffer.from('nome,empresa\nJOÃ\xa0SILVA,Conceição Ltda\n', 'latin1'));
    expect(legacy.contacts[0]).toMatchObject({ name: 'JOÃ\u00a0SILVA', customFields: { empresa: 'Conceição Ltda' } });
    expect(legacy.warnings).toEqual(['"contatos.csv" não está em UTF-8 e foi lido como Windows-1252 (o padrão do Excel). Confira se os acentos ficaram certos.']);
  });

  it('CsvTextDecoder: byte inválido depois de UTF-8 válido vira "�" e diz a linha, mesmo recebido byte a byte', () => {
    const found: number[] = [];
    const d = new CsvTextDecoder(undefined, (line) => found.push(line));
    const bytes = Buffer.concat([Buffer.from('ação\r\nlinha 2\rlinha 3\n'), Buffer.from([0xff]), Buffer.from('x\nfim é\n'), Buffer.from([0xc3])]);
    let out = '';
    for (const b of bytes) out += d.write(Buffer.from([b]));
    out += d.end();
    expect(out).toBe('ação\nlinha 2\nlinha 3\n�x\nfim é\n�');
    expect(found).toEqual([4]);
    expect([d.legacy, d.lossy]).toEqual([false, true]);
  });

  it('aspas sem fechar: o aviso diz a causa e a linha onde o problema começa', async () => {
    const rest = 'x,y,z\n'.repeat(200_000);
    const r = await csv({
      'channels.csv': 'geral,alice,public,\n',
      'geral/m.csv': `alice,1700000000000,ok\nbob,1700000000001,"nunca fechada\n${rest}`,
      'geral/n.csv': `alice,1700000000000,ok\n\n\nbob,1700000000001,"nunca fechada\n${rest}`,
      'geral/o.csv': `alice,1700000000000,ok\n\nbob,1700000000001,${'y'.repeat(1_000_001)}\ncarol,1700000000002,perdida\n`,
      'geral/p.csv': `alice,1700000000000,"duas\nlinhas",${'y'.repeat(1_000_001)}\n`,
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['ok', 'ok', 'ok']);
    expect(r.warnings).toEqual([
      'Não foi possível ler "geral/m.csv": aspas abertas e não fechadas (linha 2). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "geral/n.csv": aspas abertas e não fechadas (linha 4). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "geral/o.csv": linha grande demais (o arquivo parece corrompido ou não é um .csv) (linha 3). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "geral/p.csv": linha grande demais (o arquivo parece corrompido ou não é um .csv) (linha 1). As linhas a partir dela foram ignoradas.',
    ]);
    // Em users.csv, o mesmo erro é fatal e aponta a mesma linha.
    await expect(csv({ 'users.csv': `alice,a@x.com,Alice\nbob,"b@x.com,Bob\n${rest}` })).rejects.toThrow(new ImportError('Não foi possível ler "users.csv": aspas abertas e não fechadas (linha 2).'));
  });

  it('um byte inválido no começo não estraga os acentos certos que vêm muito depois', async () => {
    const bytes = (...parts: (string | number)[]) => Buffer.concat(parts.map((p) => (typeof p === 'number' ? Buffer.from([p]) : Buffer.from(p))));
    // O byte ruim na linha 1 e os acentos só depois de mais de 16 KiB sem acento.
    const ascii = lines(600, (i) => `user${i},user${i}@x.com,User ${i}`);
    const r = await csv({ 'users.csv': bytes('jose,j@x.com,Jos', 0xe9, `\n${ascii}\njoao,joao@x.com,João Conceição\nmaria,m@x.com,Maria Antônia\n`) });
    expect(r.users.map((u) => u.name).filter((n) => !n?.startsWith('User'))).toEqual(['Jos�', 'João Conceição', 'Maria Antônia']);
    expect(r.warnings).toEqual(['"users.csv" tem bytes que não são UTF-8 válido; eles foram trocados por "�" (o primeiro na linha 1). Confira o texto dessas linhas.']);

    // Mais de 1 MiB sem acento entre os dois: o byte fica como Windows-1252, mas os acentos depois continuam UTF-8.
    const far = lines(12_000, (i) => `alice,${1700000000000 + i},${'x'.repeat(80)}`);
    const m = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': bytes('alice,1600000000000,caf', 0xe9, `\n${far}\nalice,1800000000000,ação e coração\n`) });
    expect([m.messages.length, m.messages[0].msg, m.messages.at(-1)?.msg]).toEqual([12_002, 'café', 'ação e coração']);
    expect(m.warnings).toEqual([
      '"geral/m.csv" mistura UTF-8 e Windows-1252: os trechos que não são UTF-8 foram lidos como Windows-1252 (o primeiro na linha 1). Confira se os acentos ficaram certos.',
    ]);

    // Windows-1252 do começo ao fim, com pares que por acaso são UTF-8 válido no meio: continua Windows-1252.
    const excel = Buffer.from(`${lines(3000, (i) => `alice,${1700000000000 + i},${i % 500 === 7 ? 'JOÃ\xa0SILVA' : 'Concei\xe7\xe3o'}`)}\n`, 'latin1');
    const x = await csv({ 'channels.csv': 'geral,alice,public,\n', 'geral/m.csv': excel });
    expect(x.messages.filter((y) => y.msg !== 'Conceição' && y.msg !== 'JOÃ\u00a0SILVA')).toEqual([]);
    expect(x.warnings).toEqual(['"geral/m.csv" não está em UTF-8 e foi lido como Windows-1252 (o padrão do Excel). Confira se os acentos ficaram certos.']);
  });

  it('CsvTextDecoder: a codificação é escolhida por trecho, e um trecho em dúvida não espera sem limite', () => {
    const run = (parts: Buffer[]) => {
      const seen: (string | number | undefined)[] = [];
      const d = new CsvTextDecoder(
        (mixed) => seen.push('legacy', mixed),
        (line) => seen.push('invalid', line),
      );
      const out = parts.map((p) => d.write(p));
      out.push(d.end());
      return { out, text: out.join(''), seen };
    };
    // Byte ruim e, em outras partes, 20 KiB sem acento e depois acentos em UTF-8: o byte vira "�".
    const a = run([Buffer.from('Jos\xe9\n', 'latin1'), Buffer.from(`${'a'.repeat(20_000)}\n`), Buffer.from('ação\n')]);
    expect(a.text).toBe(`Jos�\n${'a'.repeat(20_000)}\nação\n`);
    expect(a.seen).toEqual(['invalid', 1]);

    // Mais de 1 MiB sem acento depois do byte ruim: o texto sai antes do fim (a memória usada tem limite).
    const filler = Array.from({ length: 80 }, () => Buffer.from(`${'b'.repeat(16_383)}\n`));
    const b = run([Buffer.from('caf\xe9\n', 'latin1'), ...filler, Buffer.from('coração\n')]);
    expect(b.out.slice(0, 70).join('').length).toBeGreaterThan(1_000_000);
    expect(b.text).toBe(`café\n${filler.join('')}coração\n`);
    expect(b.seen).toEqual(['legacy', 1]);

    // Um arquivo do Excel com outro em UTF-8 colado no fim: cada parte com os seus acentos.
    const excel = Buffer.from('linha 1\nConcei\xe7\xe3o, a\xe7\xe3o, cora\xe7\xe3o, informa\xe7\xe3o\n'.repeat(100), 'latin1');
    const c = run([excel, Buffer.from('Conceição, ação, coração, informação\n'.repeat(100))]);
    expect(c.text).toBe('linha 1\nConceição, ação, coração, informação\n'.repeat(100) + 'Conceição, ação, coração, informação\n'.repeat(100));
    expect(c.seen).toEqual(['legacy', 2]);
  });

  it('linhas só com espaços contam no número da linha dos registros e dos avisos', async () => {
    const rows: [string[], number][] = [];
    for await (const row of csvRows(Readable.from([Buffer.from('a,b\n  \n\t\nc,d\n \t \n\ne,"f\ng"\n\u00a0\nh,i\n')]))) rows.push([row.fields, row.line]);
    expect(rows).toEqual([
      [['a', 'b'], 1],
      [['c', 'd'], 4],
      [['e', 'f\ng'], 7],
      [['h', 'i'], 10],
    ]);

    const rest = 'x,y,z\n'.repeat(200_000);
    const r = await csv({
      'channels.csv': 'geral,alice,public,\n \n,alice,public,\n',
      'geral/m.csv': 'alice,1700000000000,ok\n  \n\t\nbob,1700000000001,"nunca fechada\nalice,1,z\n',
      'geral/n.csv': `alice,1700000000000,ok\n   \n\u00a0\nbob,1700000000001,"nunca fechada\n${rest}`,
      'geral/o.csv': `alice,1700000000000,ok\n \t\nbob,1700000000001,${'y'.repeat(1_000_001)}\n`,
    });
    expect(r.warnings).toEqual([
      '"channels.csv": linha sem nome de canal ignorada (linha 3).',
      'Não foi possível ler "geral/m.csv": aspas abertas e não fechadas (linha 4). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "geral/n.csv": aspas abertas e não fechadas (linha 4). As linhas a partir dela foram ignoradas.',
      'Não foi possível ler "geral/o.csv": linha grande demais (o arquivo parece corrompido ou não é um .csv) (linha 3). As linhas a partir dela foram ignoradas.',
    ]);
    await expect(csv({ 'users.csv': 'alice,a@x.com,Alice\n \nbob,"b@x.com,Bob\n' })).rejects.toThrow(new ImportError('Não foi possível ler "users.csv": aspas abertas e não fechadas (linha 3).'));
  });

  it('espaço especial no começo de um campo não vira "�" no texto da mensagem', async () => {
    const r = await csv({
      'channels.csv': 'geral,alice,public,\n',
      'geral/m.csv': 'alice,1700000000000,\u00a0Olá, tudo bem?\nalice,1700000000001,Olá,\u3000tudo bem?\nalice,1700000000002,Olá,\u00a0 tudo,\u2003bem\u00a0\n',
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['Olá, tudo bem?', 'Olá, tudo bem?', 'Olá,  tudo, bem']);
  });

  it('nomes enormes viram ids de tamanho limitado, iguais em todo lugar que os cita e diferentes entre si', async () => {
    // O import_map indexa o id, e o índice do PostgreSQL recusa uma linha de mais de uns 2.700 bytes.
    const a = `${'c'.repeat(3000)}a`;
    const b = `${'c'.repeat(3000)}b`;
    const u = 'u'.repeat(3000);
    const r = await csv({
      'users.csv': `${u},,Longo\nana,${'e'.repeat(300)}@x.com,Ana\nbia,bia@x.com,Bia\n`,
      'channels.csv': `${a},${u},public,${u};ana\n${b},ana,private,ana\ncurto,bia,public,bia\n`,
      [`${a}/m.csv`]: `${u},1700000000000,oi\n`,
      [`${b}/m.csv`]: 'ana,1700000000000,olá\n',
      'directmessages/d.csv': `${u},ana,1700000001000,direta\n`,
    });
    const [longo, ana, bia] = r.users.map((x) => x.importIds[0]);
    // Um e-mail de mais de 254 caracteres não é e-mail: o id da pessoa sai do nome.
    expect([ana, bia]).toEqual(['csv:u:ana', 'csv:u:bia@x.com']);
    expect(longo).toMatch(/^csv:u:u{400,}~[\w-]{27}$/);
    const [ca, cb, curto, dm] = r.channels;
    expect(curto.importIds).toEqual(['csv:c:curto']);
    for (const id of [longo, ca.importIds[0], cb.importIds[0], dm.importIds[0]]) expect(id.length).toBeLessThanOrEqual(500);
    expect(ca.importIds[0]).not.toBe(cb.importIds[0]);
    expect(ca.importIds[0].startsWith('csv:c:ccc')).toBe(true);
    expect(ca.users).toEqual([longo, ana]);
    expect(ca.creator).toBe(longo);
    expect(dm).toMatchObject({ t: 'd', users: [longo, ana].sort() });
    expect(r.messages.map((m) => [m.rid, m.u, m.msg])).toEqual([
      [ca.importIds[0], longo, 'oi'],
      [cb.importIds[0], ana, 'olá'],
      [dm.importIds[0], longo, 'direta'],
    ]);
    expect(r.warnings).toEqual([]);
  });
});

describe('importador de usuários do Slack', () => {
  const EXAMPLE_SLACK = [
    'username,email,status,billing-active,has-2fa,has-sso,userid,fullname,displayname,expiration-timestamp',
    'alice,alice@example.com,Admin,1,1,0,U01,Alice Smith,alice,',
    'bob,bob@example.com,Member,1,0,0,U02,,Bobby,',
    'helperbot,bot@example.com,Bot,0,0,0,B01,Helper Bot,,',
    'dave,dave@example.com,Deactivated,0,0,0,U03,Dave Old,,',
    'nomail,,Member,1,0,0,U04,No Mail,,',
    '',
  ].join('\n');

  it('lê a lista de membros de exemplo', async () => {
    const r = await slackUsers(EXAMPLE_SLACK);
    expect(r.users).toEqual([
      { importIds: ['alice@example.com'], emails: ['alice@example.com'], username: 'alice', name: 'Alice Smith', roles: ['admin'] },
      { importIds: ['bob@example.com'], emails: ['bob@example.com'], username: 'bob', name: 'Bobby' },
      { importIds: ['bot@example.com'], emails: ['bot@example.com'], username: 'helperbot', name: 'Helper Bot', type: 'bot' },
      { importIds: ['dave@example.com'], emails: ['dave@example.com'], username: 'dave', name: 'Dave Old', deleted: true },
    ]);
    expect(r.warnings).toEqual(['"membros.csv": linha sem e-mail válido ignorada (linha 6).']);
    expect(r.steps).toEqual([ST.preparingUsers]);
    expect(r.rates.at(-1)).toBe(100);
  });

  it('"-", "n/a" ou espaços no lugar do e-mail não viram o id de ninguém: a linha é ignorada como sem e-mail', async () => {
    const r = await slackUsers('username,email,status\nbob,-,Member\ncarol,n/a,Deactivated\ndan, ,Member\neva,eva@x.com,Member\nfred,-,Member\n');
    expect(r.users).toEqual([{ importIds: ['eva@x.com'], emails: ['eva@x.com'], username: 'eva', name: 'eva' }]);
    expect(r.warnings).toEqual(['"membros.csv": 4 linhas sem e-mail válido ignoradas (linhas 2, 3, 4 e 6).']);
  });

  it('e-mail de mais de 254 caracteres não é e-mail: a linha é ignorada (como id, derrubava a gravação do vínculo)', async () => {
    const r = await slackUsers(`username,email,status\nzed,${'z'.repeat(300)}@x.com,Member\neva,eva@x.com,Member\n`);
    expect(r.users.map((u) => u.importIds)).toEqual([['eva@x.com']]);
    expect(r.warnings).toEqual(['"membros.csv": linha sem e-mail válido ignorada (linha 2).']);
  });

  it('usa os nomes das colunas do cabeçalho, em qualquer ordem', async () => {
    const r = await slackUsers(withBom('"email","fullname","username","status"\n x@y.com , X Y , xy , bot \nw@y.com,,,owner\nv@y.com,,v,Primary Owner\nu@y.com,,u,deactivated\n'));
    expect(r.users).toEqual([
      { importIds: ['x@y.com'], emails: ['x@y.com'], username: 'xy', name: 'X Y', type: 'bot' },
      { importIds: ['w@y.com'], emails: ['w@y.com'], roles: ['admin'] },
      { importIds: ['v@y.com'], emails: ['v@y.com'], username: 'v', name: 'v', roles: ['admin'] },
      { importIds: ['u@y.com'], emails: ['u@y.com'], username: 'u', name: 'u', deleted: true },
    ]);
  });

  it('sem nomes conhecidos no cabeçalho, usa as posições do Slack; sem cabeçalho, a primeira linha não se perde', async () => {
    const pos = await slackUsers('a,b,c,d,e,f,g,h,i\nana,ana@x.com,Member,1,0,0,U1,Ana Lima,ana\n');
    expect(pos.users).toEqual([{ importIds: ['ana@x.com'], emails: ['ana@x.com'], username: 'ana', name: 'Ana Lima' }]);
    const none = await slackUsers('ana,ana@x.com,Member,1,0,0,U1,Ana Lima,ana\nbia,bia@x.com,Admin,1,0,0,U2,,Bia\n');
    expect(none.users.map((u) => u.username)).toEqual(['ana', 'bia']);
    expect(none.warnings).toEqual(['"membros.csv" não tem a linha de cabeçalho; a primeira linha foi lida como um usuário.']);
  });

  it('e-mails repetidos, arquivo só com cabeçalho e .zip no lugar do .csv', async () => {
    const dup = await slackUsers('username,email\na,a@x.com\nb,A@X.com\n');
    expect(dup.users).toHaveLength(1);
    expect(dup.warnings).toEqual(['"membros.csv": e-mail repetido ignorado (vale a primeira linha) (linha 3).']);
    const empty = await slackUsers('username,email,status\n');
    expect(empty.users).toEqual([]);
    expect(empty.warnings).toEqual(['Nenhum usuário com e-mail em "membros.csv".']);
    await expect(slackUsers(await zipFile([['users.csv', 'a,b\n']]))).rejects.toThrow(new ImportError('Este formato espera um arquivo .csv, não um .zip.'));
    await expect(slackUsers('username,email\n"a,a@x.com\n')).rejects.toThrow(/aspas abertas e não fechadas \(linha 2\)/);
  });
});

describe('importador de contatos do omnichannel', () => {
  it('lê contatos com cabeçalho, apara os valores e descarta itens vazios das listas', async () => {
    const r = await contacts(
      'id,name,emails,phones,manager,empresa,cidade\nc-1,Ana,Ana@X.com; ana2@x.com ;,,@bia,ACME,\n,,,+55 (11) 9999-0000,,,\n,Só Nome,,,,,Recife\n,Bia,bia@x.com,11 98888-7777;,bia,,\n',
    );
    expect(r.contacts).toEqual([
      { importIds: ['c-1'], name: 'Ana', emails: ['Ana@X.com', 'ana2@x.com'], phones: [], manager: '@bia', customFields: { empresa: 'ACME' } },
      { importIds: ['contact:+551199990000'], emails: [], phones: ['+55 (11) 9999-0000'] },
      { importIds: ['contact:row4'], name: 'Só Nome', emails: [], phones: [], customFields: { cidade: 'Recife' } },
      { importIds: ['contact:bia@x.com'], name: 'Bia', emails: ['bia@x.com'], phones: ['11 98888-7777'], manager: 'bia' },
    ]);
    expect(r.steps).toEqual([ST.preparingContacts]);
    expect(r.warnings).toEqual([]);
  });

  it('aceita nomes de coluna em português e sem diferença de maiúsculas', async () => {
    const r = await contacts(withBom('Nome,E-mail,Telefone,Gerente,Empresa\nJoão,joao@x.com,123,ana,ACME\n'));
    expect(r.contacts).toEqual([{ importIds: ['contact:joao@x.com'], name: 'João', emails: ['joao@x.com'], phones: ['123'], manager: 'ana', customFields: { Empresa: 'ACME' } }]);
  });

  it('linha sem nome, e-mail e telefone e contato repetido são ignorados com aviso', async () => {
    const r = await contacts('name,emails,phones,empresa\nAna,ana@x.com,,\n,,,ACME\nAna 2,ANA@x.com,,\n');
    expect(r.contacts).toHaveLength(1);
    expect(r.warnings).toEqual([
      '"contatos.csv": linha sem nome, e-mail e telefone ignorada (linha 3).',
      '"contatos.csv": contato repetido ignorado (vale a primeira linha) (linha 4).',
    ]);
  });

  it('exige o cabeçalho e avisa do ponto e vírgula', async () => {
    await expect(contacts('Jane,jane@x.com\n')).rejects.toThrow(/"contatos.csv" precisa de uma primeira linha de cabeçalho/);
    await expect(contacts('name;emails;phones\nJane;jane@x.com;1\n')).rejects.toThrow(/"contatos.csv" parece usar ponto e vírgula/);
    const empty = await contacts('');
    expect(empty.contacts).toEqual([]);
    expect(empty.warnings).toEqual(['"contatos.csv" está vazio.']);
  });

  it('"-" ou "n/a" no lugar do e-mail não identificam o contato: contatos diferentes continuam diferentes', async () => {
    const r = await contacts('name,emails,phones\nAna,-,1111\nBob,-,2222\nCid,n/a;cid@x.com,\nDé,n/a,\n');
    expect(r.contacts.map((c) => [c.name, c.importIds[0]])).toEqual([
      ['Ana', 'contact:1111'],
      ['Bob', 'contact:2222'],
      ['Cid', 'contact:cid@x.com'],
      ['Dé', 'contact:row5'],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('id enorme do contato fica com tamanho limitado, e dois ids com o mesmo começo continuam diferentes', async () => {
    const id = 'i'.repeat(3000);
    const r = await contacts(`name,phones,id\nZé,1,${id}\nZá,2,${id}x\nZu,3,curto\n`);
    const ids = r.contacts.map((c) => c.importIds[0]);
    expect(ids[2]).toBe('curto');
    expect(ids[0]).not.toBe(ids[1]);
    for (const x of ids) expect(x.length).toBeLessThanOrEqual(500);
    expect(r.warnings).toEqual([]);
  });

  it('parseContactsCsv devolve quantos contatos foram lidos', async () => {
    const { ctx, out } = context(memoryArchive({}));
    expect(await parseContactsCsv(Buffer.from('name,phones\nA,1\nB,2\n,\n'), ctx, 'lista.csv')).toBe(2);
    expect(out.contacts.map((c) => c.importIds[0])).toEqual(['contact:1', 'contact:2']);
  });
});

// ---------- Do envio à conversão, com o banco de verdade ----------

describe('importação CSV de ponta a ponta', () => {
  let A: Auth;
  const ops: string[] = [];

  beforeAll(async () => {
    await startServer();
    A = await admin();
    await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
    await pool.query(`INSERT INTO livechat_custom_fields (id, label, scope) VALUES ('company', 'Empresa', 'visitor')`);
  });
  afterAll(async () => {
    const { operationDir } = await import('../src/importer/operations');
    for (const id of ops) await fs.promises.rm(operationDir(id), { recursive: true, force: true });
    await stopServer();
  });

  const current = async () => (await api('GET', 'getCurrentImportOperation', undefined, A)).operation;
  async function settle(ms = 20_000) {
    const end = Date.now() + ms;
    for (;;) {
      const op = await current();
      if (op && op.status !== ST.new && !BUSY_STATES.includes(op.status)) return op;
      if (Date.now() > end) throw new Error(`a operação não terminou: ${JSON.stringify(op)}`);
      await sleep(50);
    }
  }
  async function upload(key: string, name: string, data: Buffer | string) {
    const fd = new FormData();
    fd.append('importerKey', key);
    fd.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
    const r = await api('POST', 'uploadImportFile', fd, A);
    expect(r.success).toBe(true);
    ops.push(r.operation._id);
    return settle();
  }
  async function run(input: unknown = { users: { all: true }, channels: { all: true }, contacts: { all: true } }) {
    expect((await api('POST', 'startImport', { input }, A)).success).toBe(true);
    const done = await settle(60_000);
    expect(done.status).toBe(ST.done);
    return done;
  }
  const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

  it('o .zip de exemplo vira usuários, canais, conversas diretas, mensagens e contatos; reimportar não duplica', async () => {
    const zip = await zipFile(Object.entries(EXAMPLE).map(([k, v]) => [`exemplo/${k}`, v]));
    const op = await upload('csv', 'exemplo.zip', zip);
    expect(op).toMatchObject({ status: ST.userSelection, count: { users: 3, channels: 4, messages: 8, contacts: 1, total: 16 }, warnings: [] });
    const data = await api('GET', 'getImportFileData', undefined, A);
    expect(data.users.map((u: any) => u.username)).toEqual(['alice', 'bob', 'carol']);
    expect(data.channels.map((c: any) => [c.name, c.is_private, c.is_direct])).toEqual([
      ['town-square', false, false],
      ['design-team', true, false],
      ['Mensagens diretas', true, true],
    ]);
    expect(data.message_count).toBe(8);
    expect(data.contacts).toHaveLength(1);

    const done = await run();
    expect(done.count).toMatchObject({ total: 16, error: 0, skipped: 0, completed: 16 });
    const rooms = (await pool.query(`SELECT id, t, name FROM rooms WHERE name IN ('town-square', 'design-team') ORDER BY name`)).rows;
    expect(rooms.map((r) => [r.name, r.t])).toEqual([
      ['design-team', 'p'],
      ['town-square', 'c'],
    ]);
    const town = rooms.find((r) => r.name === 'town-square').id;
    const msgs = (await pool.query(`SELECT username, msg, created_at FROM messages WHERE room_id = $1 AND t IS NULL ORDER BY created_at`, [town])).rows;
    expect(msgs.map((m) => m.username)).toEqual(['alice', 'bob', 'carol']);
    expect(msgs[2].msg).toBe('Two lines:\nsecond line with "quotes"');
    expect(msgs[0].created_at).toBe(TS);
    const dms = (await pool.query(`SELECT usernames FROM rooms WHERE t = 'd' ORDER BY dm_key`)).rows.map((r) => [...r.usernames].sort());
    expect(dms.sort()).toEqual([
      ['alice', 'bob'],
      ['alice', 'carol'],
    ]);
    const contact = (await pool.query(`SELECT name, email, phone, custom_fields FROM livechat_visitors WHERE lower(email) = 'jane@example.com'`)).rows[0];
    expect(contact).toMatchObject({ name: 'Jane Doe', phone: '+5511999990000' });
    expect(contact.custom_fields).toMatchObject({ company: 'ACME' });
    const total = await count(`SELECT count(*)::int AS n FROM messages WHERE t IS NULL`);

    // O mesmo arquivo de novo: as mensagens são atualizadas, não duplicadas.
    await upload('csv', 'exemplo.zip', zip);
    await run();
    expect(await count(`SELECT count(*)::int AS n FROM messages WHERE t IS NULL`)).toBe(total);
    expect(await count(`SELECT count(*)::int AS n FROM rooms WHERE t = 'd'`)).toBe(2);
  });

  it('a lista de membros do Slack cria as contas com os papéis certos', async () => {
    const op = await upload('slack-users', 'membros.csv', 'username,email,status,billing-active,has-2fa,has-sso,userid,fullname,displayname\nzara,zara@ex.com,Admin,1,0,0,U1,Zara Lima,\nyuri,yuri@ex.com,Deactivated,0,0,0,U2,,Yuri\n');
    expect(op).toMatchObject({ status: ST.userSelection, count: { users: 2 } });
    await run();
    const users = (await pool.query(`SELECT username, name, roles, active FROM users WHERE username IN ('zara', 'yuri') ORDER BY username`)).rows;
    expect(users.map((u) => ({ ...u, roles: [...u.roles].sort() }))).toEqual([
      { username: 'yuri', name: 'Yuri', roles: ['user'], active: false },
      { username: 'zara', name: 'Zara Lima', roles: ['admin', 'user'], active: true },
    ]);
  });

  it('um arquivo de contatos e um .zip sem nada válido', async () => {
    const op = await upload('omnichannel_contact', 'contatos.csv', 'nome,telefone\nCarlos,+55 81 3333-4444\n');
    expect(op).toMatchObject({ status: ST.userSelection, count: { contacts: 1 } });
    await run();
    expect(await count(`SELECT count(*)::int AS n FROM livechat_visitors WHERE name = 'Carlos'`)).toBe(1);
    const bad = await upload('csv', 'vazio.zip', await zipFile([['readme.txt', 'nada aqui']]));
    expect(bad.status).toBe(ST.failed);
    expect(bad.error).toMatch(/^Nenhum dado válido foi encontrado no arquivo\..*readme\.txt/);
  });

  it('reimportar depois de pôr o e-mail que faltava em users.csv, ou sem users.csv, não duplica mensagens nem conversas', async () => {
    const k = Math.random().toString(36).slice(2, 7);
    const base: [string, string][] = [
      ['channels.csv', `geral${k},ana${k},public,ana${k};bia${k}\n`],
      [`geral${k}/m.csv`, `ana${k},1700000000000,primeira\nbia${k},1700000001000,segunda\n`],
      ['directmessages/dm.csv', `ana${k},bia${k},1700000002000,dm\n`],
    ];
    const state = async () => ({
      channel: (
        await pool.query(`SELECT m.username, m.msg FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.name = $1 AND m.t IS NULL ORDER BY m.created_at`, [`geral${k}`])
      ).rows,
      dm: await count(`SELECT count(*)::int AS n FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.t = 'd' AND $1 = ANY(r.usernames) AND m.t IS NULL`, [`ana${k}`]),
      accounts: await count('SELECT count(*)::int AS n FROM users WHERE username LIKE $1', [`ana${k}%`]),
    });
    await upload('csv', 'a.zip', await zipFile([['users.csv', `ana${k},,Ana\nbia${k},bia${k}@x.example,Bia\n`], ...base]));
    await run();
    const before = await state();
    expect(before).toEqual({
      channel: [
        { username: `ana${k}`, msg: 'primeira' },
        { username: `bia${k}`, msg: 'segunda' },
      ],
      dm: 1,
      accounts: 1,
    });
    await upload('csv', 'a.zip', await zipFile([['users.csv', `ana${k},ana${k}@x.example,Ana\nbia${k},bia${k}@x.example,Bia\n`], ...base]));
    await run();
    expect(await state()).toEqual(before);
    await upload('csv', 'b.zip', await zipFile(base));
    await run();
    expect(await state()).toEqual(before);
  });

  it('quem foi desmarcado na prévia porque já existe aqui continua no canal, e as mensagens são da conta daqui', async () => {
    const k = Math.random().toString(36).slice(2, 7);
    const r0 = await api('POST', 'users.create', { username: `des${k}`, name: 'Des', email: `des${k}@x.example`, password: 'senha-forte-1', verified: true }, A);
    expect(r0.success).toBe(true);
    await upload(
      'csv',
      'd.zip',
      await zipFile([
        ['users.csv', `des${k},des${k}@x.example,Outro Nome\noutro${k},outro${k}@x.example,Outro\n`],
        ['channels.csv', `canal${k},outro${k},private,des${k};outro${k}\n`],
        [`canal${k}/m.csv`, `des${k},1700000000000,mensagem do des\n`],
      ]),
    );
    const preview = await api('GET', 'getImportFileData', undefined, A);
    const desId = preview.users.find((u: any) => u.username === `des${k}`);
    expect(desId.is_email_taken).toBe(true);
    const done = await run({ users: { list: preview.users.filter((u: any) => u !== desId).map((u: any) => u.user_id) }, channels: { all: true }, contacts: { all: true } });
    expect(done.count).toMatchObject({ error: 0 });
    const room = (await pool.query('SELECT id FROM rooms WHERE name = $1', [`canal${k}`])).rows[0].id;
    const members = (await pool.query('SELECT u.username FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.room_id = $1', [room])).rows.map((r) => r.username);
    expect(members.sort()).toEqual([`des${k}`, `outro${k}`]);
    expect((await pool.query('SELECT user_id, msg FROM messages WHERE room_id = $1 AND t IS NULL', [room])).rows).toEqual([{ user_id: r0.user._id, msg: 'mensagem do des' }]);
    expect((await pool.query('SELECT name FROM users WHERE id = $1', [r0.user._id])).rows[0].name).toBe('Des');
  });

  it('listas de membros com "-" no lugar do e-mail não juntam nem desativam outra pessoa', async () => {
    const k = Math.random().toString(36).slice(2, 7);
    const head = 'username,email,status\n';
    const first = await upload('slack-users', 'a.csv', `${head}bob${k},-,Member\nreal${k},real${k}@x.example,Member\n`);
    expect(first.warnings).toEqual(['"a.csv": linha sem e-mail válido ignorada (linha 2).']);
    await run();
    await upload('slack-users', 'b.csv', `${head}carol${k},n/a,Deactivated\nreal${k},real${k}@x.example,Member\n`);
    await run();
    expect(await count('SELECT count(*)::int AS n FROM users WHERE username IN ($1, $2)', [`bob${k}`, `carol${k}`])).toBe(0);
    expect((await pool.query('SELECT active FROM users WHERE username = $1', [`real${k}`])).rows).toEqual([{ active: true }]);
    expect(await count(`SELECT count(*)::int AS n FROM import_map WHERE import_id IN ('-', 'n/a')`)).toBe(0);
  });

  it('nomes de canal e de usuário e ids de contato enormes são importados (o índice do banco recusava o vínculo com um erro em inglês)', async () => {
    // Letras aleatórias: o PostgreSQL comprime uma linha do índice repetitiva, e "u" repetido passava.
    const rnd = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
    const canal = `canal-${rnd(4000)}`;
    const nome = rnd(4000);
    const k = Math.random().toString(36).slice(2, 7);
    const op = await upload(
      'csv',
      'enormes.zip',
      await zipFile([
        ['users.csv', `${nome},,Longo\nana${k},ana${k}@x.example,Ana\n`],
        ['channels.csv', `${canal},ana${k},public,ana${k};${nome}\n`],
        [`${canal}/m.csv`, `${nome},1700000000000,do longo no canal longo ${k}\n`],
        ['directmessages/d.csv', `${nome},ana${k},1700000001000,direta longa ${k}\n`],
        ['contacts.csv', `name,phones,id\nContato ${k},55${Math.floor(Math.random() * 1e9)},${rnd(4000)}\n`],
      ]),
    );
    expect(op).toMatchObject({ status: ST.userSelection, count: { users: 2, channels: 2, messages: 2, contacts: 1 } });
    const done = await run();
    expect(done.count).toMatchObject({ total: 7, completed: 7, error: 0 });
    const msgs = (await pool.query(`SELECT r.t, m.msg FROM messages m JOIN rooms r ON r.id = m.room_id WHERE m.msg LIKE $1 ORDER BY m.created_at`, [`%${k}`])).rows;
    expect(msgs).toEqual([
      { t: 'c', msg: `do longo no canal longo ${k}` },
      { t: 'd', msg: `direta longa ${k}` },
    ]);
    expect(await count('SELECT count(*)::int AS n FROM livechat_visitors WHERE name = $1', [`Contato ${k}`])).toBe(1);
  });

  it('um CSV de outra origem com o mesmo nome de usuário não fica com o vínculo de quem um CSV anterior importou', async () => {
    const k = Math.random().toString(36).slice(2, 7);
    const create = async (username: string, email: string) => {
      const r = await api('POST', 'users.create', { username, name: username, email, password: 'senha-forte-1', verified: true }, A);
      expect(r.success).toBe(true);
      return r.user._id as string;
    };
    const pereira = await create(`joao${k}`, `pereira${k}@explorer.example`);
    const maria = await create(`maria${k}`, `maria${k}@explorer.example`);
    // 1º CSV: outro João, com outro e-mail, ganha a conta "joao.2".
    await upload('csv', 'silva.zip', await zipFile([['users.csv', `joao${k},silva${k}@outra.example,João Silva\n`]]));
    await run();
    const silva = (await pool.query('SELECT id, username FROM users WHERE lower(email) = $1', [`silva${k}@outra.example`])).rows[0];
    expect(silva.username).toBe(`joao${k}.2`);
    // 2º CSV, de outra origem: só o nome, sem e-mail. Pelo nome é o João daqui, não a conta criada para o Silva.
    await upload(
      'csv',
      'rh.zip',
      await zipFile([
        ['users.csv', `joao${k},,João\n`],
        ['channels.csv', `rh${k},joao${k},private,joao${k};maria${k}\n`],
        [`rh${k}/m.csv`, `joao${k},1700000000000,salários do RH\n`],
        ['directmessages/d.csv', `maria${k},joao${k},1700000001000,oi João\n`],
      ]),
    );
    await run();
    const rh = (await pool.query('SELECT id FROM rooms WHERE name = $1', [`rh${k}`])).rows[0].id;
    const members = (await pool.query('SELECT user_id FROM subscriptions WHERE room_id = $1', [rh])).rows.map((r) => r.user_id);
    expect(members.sort()).toEqual([pereira, maria].sort());
    expect((await pool.query('SELECT user_id FROM messages WHERE room_id = $1 AND t IS NULL', [rh])).rows).toEqual([{ user_id: pereira }]);
    const dms = (await pool.query(`SELECT uids FROM rooms WHERE t = 'd' AND $1 = ANY(uids)`, [maria])).rows.map((r) => [...r.uids].sort());
    expect(dms).toEqual([[pereira, maria].sort()]);
    expect(dms.flat()).not.toContain(silva.id);
  });
});
