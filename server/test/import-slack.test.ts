import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { pool } from '../src/db/pool';
import { memoryArchive, openArchive } from '../src/importer/archive';
import { SLACK_LIMITS, blocksText, convertMarkup, emojiName, slackFile, slackImporter, slackMessageId, slackTs, type SlackNames } from '../src/importer/importers/slack';
import { operationDir } from '../src/importer/operations';
import { BUSY_STATES, ImportError, ST, roomToken, userToken, type ArchiveSource, type ImportChannel, type ImportMessage, type ImportUser, type PrepareContext } from '../src/importer/types';
import { admin, api, sleep, startServer, stopServer, type Auth } from './helpers';

// Leitura da exportação do Slack (prepare) com um arquivo em memória e um contexto falso que guarda o que foi lido.

const j = (v: unknown) => JSON.stringify(v);

interface Run {
  users: ImportUser[];
  channels: ImportChannel[];
  messages: ImportMessage[];
  warnings: string[];
  steps: string[];
  statuses: (string | null)[];
  rates: number[];
}

function fakeContext(source: ArchiveSource, cancelAfterMessages = Infinity) {
  const r: Run = { users: [], channels: [], messages: [], warnings: [], steps: [], statuses: [], rates: [] };
  const ctx: PrepareContext = {
    operationId: 'op-teste',
    source,
    user: async (u) => void r.users.push(u),
    channel: async (c) => void r.channels.push(c),
    message: async (m) => void r.messages.push(m),
    contact: async () => {
      throw new Error('o Slack não tem contatos');
    },
    setStep: async (s) => void r.steps.push(s),
    setMessagesStatus: async (s) => void r.statuses.push(s),
    progress: (v) => void r.rates.push(v),
    warn: (m) => void r.warnings.push(m),
    cancelled: () => r.messages.length >= cancelAfterMessages,
    findImported: async () => null,
  };
  return { ctx, r };
}

async function run(files: Record<string, string | Buffer>, cancelAfterMessages?: number): Promise<Run> {
  const { ctx, r } = fakeContext(memoryArchive(files), cancelAfterMessages);
  await slackImporter.prepare(ctx);
  // Os registros vão para jsonb: nenhum campo pode ficar undefined.
  for (const rec of [...r.users, ...r.channels, ...r.messages]) expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  return r;
}

const byId = (r: Run) => new Map(r.messages.map((m) => [m.importId, m]));

// Exportação mínima: dois usuários e um canal; as mensagens vão em geral/2024-01-01.json.
const USERS = [
  { id: 'U1', name: 'ana', profile: { real_name: 'Ana Lima', email: 'ana@ex.com' } },
  { id: 'U2', name: 'bob', profile: { real_name: 'Bob Roe', email: 'bob@ex.com' } },
];
const CHANNELS = [{ id: 'C1', name: 'geral', creator: 'U1', members: ['U1', 'U2'] }];
const slack = (messages: unknown[], extra: Record<string, string | Buffer> = {}) => ({ 'users.json': j(USERS), 'channels.json': j(CHANNELS), 'geral/2024-01-01.json': j(messages), ...extra });
const one = async (m: Record<string, unknown>) => {
  const r = await run(slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', ...m }]));
  return r.messages[0];
};

// ---------- Exemplo da especificação (slack.md §14) ----------

const EXAMPLE_USERS = [
  {
    id: 'U0ALICE01',
    name: 'alice',
    deleted: false,
    is_bot: false,
    real_name: 'Alice Doe',
    tz: 'America/Sao_Paulo',
    tz_offset: -10800,
    profile: {
      real_name: 'Alice Doe',
      display_name: 'alice',
      email: 'alice@example.com',
      title: 'Engineer',
      status_text: 'Focusing',
      image_512: 'https://avatars.example.com/alice_512.png',
      image_original: 'https://avatars.example.com/alice_original.png',
    },
  },
  {
    id: 'U0BOB0002',
    name: 'bob',
    deleted: false,
    is_bot: false,
    tz: 'Asia/Kolkata',
    tz_offset: 19800,
    profile: { real_name: 'Bob Roe', email: 'bob@example.com', title: '', status_text: '', image_512: 'https://avatars.example.com/bob_512.png' },
  },
  {
    id: 'U0BOT0003',
    name: 'deploybot',
    deleted: false,
    is_bot: true,
    profile: { real_name: 'Deploy Bot', bot_id: 'B0BOT0003', image_512: 'https://avatars.example.com/bot_512.png' },
  },
];
const EXAMPLE_CHANNELS = [
  {
    id: 'C024BE91L',
    name: 'general',
    created: 1699900000,
    creator: 'U0ALICE01',
    is_archived: false,
    is_general: true,
    members: ['U0ALICE01', 'U0BOB0002', 'U0BOT0003'],
    topic: { value: 'Company-wide', creator: 'U0ALICE01', last_set: 1699900000 },
    purpose: { value: 'Announcements', creator: 'U0ALICE01', last_set: 1699900000 },
  },
  {
    id: 'C024BE92M',
    name: 'random',
    created: 1699900000,
    creator: 'U0BOB0002',
    is_archived: false,
    is_general: false,
    members: ['U0ALICE01', 'U0BOB0002'],
    topic: { value: '', creator: '', last_set: 0 },
    purpose: { value: 'Off-topic', creator: 'U0BOB0002', last_set: 1699900000 },
  },
];
const EXAMPLE_GENERAL = [
  { type: 'message', subtype: 'channel_join', ts: '1700000000.000100', user: 'U0BOB0002', text: '<@U0BOB0002> has joined the channel' },
  {
    type: 'message',
    ts: '1700000100.000200',
    user: 'U0ALICE01',
    text: 'Hey <@U0BOB0002>, <!here> see <#C024BE92M|random> and <https://example.com|the docs> &amp; *ship it*',
    thread_ts: '1700000100.000200',
    reply_count: 1,
    reply_users_count: 1,
    reply_users: ['U0BOB0002'],
    latest_reply: '1700000200.000300',
    edited: { user: 'U0ALICE01', ts: '1700000150.000000' },
    reactions: [{ name: '+1', users: ['U0BOB0002', 'U0ALICE01'], count: 2 }],
  },
  {
    type: 'message',
    ts: '1700000200.000300',
    user: 'U0BOB0002',
    thread_ts: '1700000100.000200',
    parent_user_id: 'U0ALICE01',
    text: 'Here is the spec',
    upload: true,
    files: [
      {
        id: 'F0SPEC0001',
        created: 1700000199,
        name: 'spec.pdf',
        title: 'spec.pdf',
        mimetype: 'application/pdf',
        filetype: 'pdf',
        user: 'U0BOB0002',
        size: 48213,
        mode: 'hosted',
        is_external: false,
        url_private: 'https://files.slack.com/files-pri/T0TEAM/F0SPEC0001/spec.pdf',
        url_private_download: 'https://files.slack.com/files-pri/T0TEAM/F0SPEC0001/download/spec.pdf?t=xoxe-EXAMPLE',
        permalink: 'https://example.slack.com/files/U0BOB0002/F0SPEC0001/spec.pdf',
      },
    ],
  },
  {
    type: 'message',
    subtype: 'bot_message',
    ts: '1700000300.000400',
    user: 'U0BOT0003',
    bot_id: 'B0BOT0003',
    username: 'deploybot',
    text: 'Deploy finished :simple_smile:',
    icons: { emoji: ':rocket:' },
    attachments: [{ fallback: 'Build #42 passed', title: 'Build #42', title_link: 'https://ci.example.com/42', text: 'All 128 tests passed &amp; deployed', color: 'good' }],
  },
  { type: 'message', subtype: 'me_message', ts: '1700000400.000500', user: 'U0ALICE01', text: 'is out for lunch' },
];
const EXAMPLE = {
  'users.json': j(EXAMPLE_USERS),
  'channels.json': j(EXAMPLE_CHANNELS),
  'dms.json': j([{ id: 'D0DM00001', created: 1699990000, members: ['U0ALICE01', 'U0BOB0002'] }]),
  'integration_logs.json': j({ logs: [{ service_id: '1', change_type: 'added' }] }),
  'general/2023-11-14.json': j(EXAMPLE_GENERAL),
  'random/2023-11-14.json': j([
    { type: 'message', subtype: 'channel_topic', ts: '1700000050.000010', user: 'U0BOB0002', topic: 'Water-cooler chat', text: '<@U0BOB0002> set the channel topic: Water-cooler chat' },
  ]),
  'D0DM00001/2023-11-14.json': j([{ type: 'message', ts: '1700000500.000600', user: 'U0ALICE01', text: 'Lunch at 1?' }]),
};

describe('exemplo da especificação', () => {
  it('lê usuários, canais, DM e mensagens como o esperado', async () => {
    const r = await run(EXAMPLE);
    expect(r.users).toEqual([
      {
        importIds: ['U0ALICE01'],
        emails: ['alice@example.com'],
        username: 'alice',
        name: 'Alice Doe',
        statusText: 'Focusing',
        bio: 'Engineer',
        avatarUrl: 'https://avatars.example.com/alice_original.png',
      },
      { importIds: ['U0BOB0002'], emails: ['bob@example.com'], username: 'bob', name: 'Bob Roe', avatarUrl: 'https://avatars.example.com/bob_512.png' },
      { importIds: ['U0BOT0003'], emails: [], username: 'deploybot', name: 'Deploy Bot', type: 'bot', avatarUrl: 'https://avatars.example.com/bot_512.png' },
      // users.json não tem o Slackbot: ele é criado para ser o autor das mensagens dele.
      { importIds: ['USLACKBOT'], emails: [], username: 'slackbot', name: 'Slackbot', type: 'bot' },
    ]);
    expect(r.channels).toEqual([
      {
        importIds: ['C024BE91L'],
        t: 'c',
        name: 'general',
        users: ['U0ALICE01', 'U0BOB0002', 'U0BOT0003'],
        creator: 'U0ALICE01',
        topic: 'Company-wide',
        description: 'Announcements',
        isDefault: true,
        ts: '2023-11-13T18:26:40.000Z',
      },
      { importIds: ['C024BE92M'], t: 'c', name: 'random', users: ['U0ALICE01', 'U0BOB0002'], creator: 'U0BOB0002', description: 'Off-topic', ts: '2023-11-13T18:26:40.000Z' },
      { importIds: ['D0DM00001'], t: 'd', users: ['U0ALICE01', 'U0BOB0002'], ts: '2023-11-14T19:26:40.000Z' },
    ]);

    // Sem mensagens "carregadoras" de arquivo: 7 mensagens do Slack, 7 registros.
    expect(r.messages).toHaveLength(7);
    const m = byId(r);
    expect(m.get('slack-C024BE91L-1700000000-000100')).toEqual({
      importId: 'slack-C024BE91L-1700000000-000100',
      rid: 'C024BE91L',
      u: 'U0BOB0002',
      msg: '',
      t: 'uj',
      ts: '2023-11-14T22:13:20.000Z',
    });
    expect(m.get('slack-C024BE91L-1700000100-000200')).toEqual({
      importId: 'slack-C024BE91L-1700000100-000200',
      rid: 'C024BE91L',
      u: 'U0ALICE01',
      msg: `Hey ${userToken('U0BOB0002', 'bob')}, @here see ${roomToken('C024BE92M', 'random')} and [the docs](https://example.com) & *ship it*`,
      ts: '2023-11-14T22:15:00.000Z',
      editedAt: '2023-11-14T22:15:50.000Z',
      editedBy: 'U0ALICE01',
      reactions: { ':+1:': ['U0BOB0002', 'U0ALICE01'] },
    });
    expect(m.get('slack-C024BE91L-1700000200-000300')).toEqual({
      importId: 'slack-C024BE91L-1700000200-000300',
      rid: 'C024BE91L',
      u: 'U0BOB0002',
      msg: 'Here is the spec',
      ts: '2023-11-14T22:16:40.000Z',
      tmid: 'slack-C024BE91L-1700000100-000200',
      files: [
        {
          id: 'F0SPEC0001',
          name: 'spec.pdf',
          size: 48213,
          type: 'application/pdf',
          url: 'https://files.slack.com/files-pri/T0TEAM/F0SPEC0001/download/spec.pdf?t=xoxe-EXAMPLE',
          external: false,
        },
      ],
    });
    expect(m.get('slack-C024BE91L-1700000300-000400')).toEqual({
      importId: 'slack-C024BE91L-1700000300-000400',
      rid: 'C024BE91L',
      u: 'U0BOT0003',
      msg: 'Deploy finished :slight_smile:',
      ts: '2023-11-14T22:18:20.000Z',
      bot: true,
      emoji: ':rocket:',
      attachments: [{ title: 'Build #42', title_link: 'https://ci.example.com/42', text: 'All 128 tests passed & deployed', color: 'good' }],
    });
    expect(m.get('slack-C024BE91L-1700000400-000500')).toMatchObject({ msg: '_is out for lunch_', u: 'U0ALICE01' });
    expect(m.get('slack-C024BE92M-1700000050-000010')).toEqual({
      importId: 'slack-C024BE92M-1700000050-000010',
      rid: 'C024BE92M',
      u: 'U0BOB0002',
      msg: 'Water-cooler chat',
      t: 'room_changed_topic',
      ts: '2023-11-14T22:14:10.000Z',
    });
    expect(m.get('slack-D0DM00001-1700000500-000600')).toMatchObject({ rid: 'D0DM00001', u: 'U0ALICE01', msg: 'Lunch at 1?' });

    // integration_logs.json e outros arquivos da raiz são ignorados sem aviso.
    expect(r.warnings).toEqual([]);
    // Mensagens na ordem dos dias de cada pasta.
    expect(r.messages.filter((x) => x.rid === 'C024BE91L').map((x) => x.importId)).toEqual(EXAMPLE_GENERAL.map((x) => slackMessageId('C024BE91L', x.ts)));
  });

  it('mostra as etapas, o andamento e a pasta/dia sendo lidos', async () => {
    const r = await run(EXAMPLE);
    expect(r.steps).toEqual([ST.preparingUsers, ST.preparingChannels, ST.preparingMessages]);
    expect(r.rates[0]).toBe(0);
    expect(r.rates.at(-1)).toBe(100);
    for (let i = 1; i < r.rates.length; i++) expect(r.rates[i]).toBeGreaterThanOrEqual(r.rates[i - 1]);
    expect(r.statuses).toEqual(['D0DM00001/2023-11-14', 'general/2023-11-14', 'random/2023-11-14', null]);
  });

  it('para quando a importação é cancelada', async () => {
    const r = await run(EXAMPLE, 2);
    expect(r.messages).toHaveLength(2);
  });
});

// ---------- Ids e datas (slack.md §13.8, §15.7) ----------

describe('ids e datas', () => {
  it('gera o id estável da mensagem a partir da conversa e do ts', () => {
    expect(slackMessageId('C12345', '1234567890.000001')).toBe('slack-C12345-1234567890-000001');
    expect(slackMessageId('CHANNEL', '123.456.789')).toBe('slack-CHANNEL-123-456-789');
  });

  it('mantém os milissegundos do ts', () => {
    expect(slackTs('1700000000.123456')).toBe('2023-11-14T22:13:20.123Z');
    expect(slackTs('1700000000.000600')).toBe('2023-11-14T22:13:20.001Z');
    expect(slackTs('1700000000')).toBe('2023-11-14T22:13:20.000Z');
    expect(slackTs(1700000000.5)).toBe('2023-11-14T22:13:20.500Z');
  });

  it('ts inválido, zero ou negativo fica sem data (a conversão usa a hora da importação), mas com id', async () => {
    for (const ts of ['0', '-836412.432', 'abc', '0.0']) expect(slackTs(ts)).toBeUndefined();
    const r = await run(
      slack([
        { type: 'message', ts: '0', user: 'U1', text: 'zero' },
        { type: 'message', ts: 'abc', user: 'U1', text: 'texto' },
      ]),
    );
    expect(r.messages.map((m) => [m.importId, m.ts])).toEqual([
      ['slack-C1-0', undefined],
      ['slack-C1-abc', undefined],
    ]);
  });

  it('mensagens do mesmo segundo ficam com datas diferentes', async () => {
    const r = await run(
      slack([
        { type: 'message', ts: '1704067200.000100', user: 'U1', text: 'a' },
        { type: 'message', ts: '1704067200.002100', user: 'U2', text: 'b' },
      ]),
    );
    expect(r.messages.map((m) => m.ts)).toEqual(['2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.002Z']);
  });
});

// ---------- Arquivos (slack.md §13.1–7, §15.3–4) ----------

describe('arquivos', () => {
  const FILE = { id: 'F12345', name: 'test.png', url_private_download: 'https://files.slack.com/files/F12345/test.png?token=xoxe-123', size: 1024, is_external: false };
  const inC12345 = async (messages: unknown[]) =>
    run({ 'users.json': j([{ id: 'U12345', name: 'u12345' }]), 'channels.json': j([{ id: 'C12345', name: 'canal' }]), 'canal/2009-02-13.json': j(messages) });

  it('file_share com endereço: uma mensagem só, com o arquivo e o token na URL', async () => {
    const r = await inC12345([{ type: 'message', subtype: 'file_share', ts: '1234567890.000001', user: 'U12345', file: FILE }]);
    expect(r.messages).toEqual([
      {
        importId: 'slack-C12345-1234567890-000001',
        rid: 'C12345',
        u: 'U12345',
        msg: '',
        ts: '2009-02-13T23:31:30.000Z',
        files: [{ id: 'F12345', name: 'test.png', size: 1024, url: 'https://files.slack.com/files/F12345/test.png?token=xoxe-123', external: false }],
      },
    ]);
  });

  it('file_share sem endereço de download: a mensagem fica, o arquivo sem URL (aparece como não disponível)', async () => {
    const { url_private_download: _, ...noUrl } = FILE;
    const r = await inC12345([{ type: 'message', subtype: 'file_share', ts: '1234567890.000001', user: 'U12345', file: noUrl }]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].files).toEqual([{ id: 'F12345', name: 'test.png', size: 1024, external: false }]);
  });

  it('file_share numa thread vira resposta da thread', async () => {
    const r = await inC12345([{ type: 'message', subtype: 'file_share', ts: '1234567890.000002', thread_ts: '1234567890.000001', user: 'U12345', file: FILE }]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].tmid).toBe('slack-C12345-1234567890-000001');
  });

  it('o texto de um file_share não se perde', async () => {
    const r = await inC12345([{ type: 'message', subtype: 'file_share', ts: '1234567890.000001', user: 'U12345', text: 'olha isso', file: FILE }]);
    expect(r.messages[0]).toMatchObject({ msg: 'olha isso', files: [{ id: 'F12345' }] });
  });

  it('dois arquivos e texto: uma mensagem com o texto e os dois arquivos, cada um com seu id', async () => {
    const r = await inC12345([
      {
        type: 'message',
        ts: '1234567890.000001',
        user: 'U12345',
        text: 'Dois arquivos',
        files: [
          { ...FILE, id: 'F1', name: 'a.png' },
          { ...FILE, id: 'F2', name: 'b.png' },
        ],
      },
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].msg).toBe('Dois arquivos');
    expect(r.messages[0].files?.map((f) => [f.id, f.name])).toEqual([
      ['F1', 'a.png'],
      ['F2', 'b.png'],
    ]);
  });

  it('converte o arquivo do Slack', () => {
    expect(slackFile({ id: 'F12345', name: 'document.pdf', url_private_download: 'https://files.slack.com/x?token=xoxe-abc', size: 4096, is_external: false, mimetype: 'application/pdf' })).toEqual({
      id: 'F12345',
      name: 'document.pdf',
      size: 4096,
      type: 'application/pdf',
      url: 'https://files.slack.com/x?token=xoxe-abc',
      external: false,
    });
    expect(slackFile({ ...FILE, is_external: true })?.external).toBe(true);
    expect(slackFile({ id: 'F9', title: 'Planilha', mode: 'external', url_private: 'https://docs.google.com/x' })).toEqual({
      id: 'F9',
      name: 'Planilha',
      url: 'https://docs.google.com/x',
      external: true,
    });
    // Sem url_private_download, vale url_private.
    expect(slackFile({ id: 'F3', name: 'x.txt', url_private: 'https://files.slack.com/files-pri/T/F3/x.txt' })?.url).toBe('https://files.slack.com/files-pri/T/F3/x.txt');
    // Apagado no Slack ou escondido pelo limite do plano: sem endereço.
    expect(slackFile({ id: 'F4', mode: 'tombstone', url_private_download: 'https://files.slack.com/a' })).toEqual({ id: 'F4', name: 'arquivo', external: false });
    expect(slackFile({ id: 'F5', name: 'b.png', mode: 'hidden_by_limit', url_private: 'https://files.slack.com/b' })?.url).toBeUndefined();
    expect(slackFile({ id: 'F6', name: 'c.png', hidden_by_limit: true, url_private: 'https://files.slack.com/c' })?.url).toBeUndefined();
    expect(slackFile({ id: 'F7', name: 'd.png', url_private_download: 'javascript:alert(1)' })?.url).toBeUndefined();
    expect(slackFile({ name: 'sem-id.png' })).toBeNull();
    expect(slackFile('F8')).toBeNull();
  });

  it('o arquivo antigo (file) e o da lista (files) com o mesmo id contam uma vez', async () => {
    const r = await inC12345([{ type: 'message', subtype: 'file_share', ts: '1234567890.000001', user: 'U12345', files: [FILE], file: FILE }]);
    expect(r.messages[0].files).toHaveLength(1);
  });

  it('mensagem sem texto, anexos nem arquivos é ignorada e contada', async () => {
    const r = await inC12345([
      { type: 'message', ts: '1234567890.000001', user: 'U12345', text: '' },
      { type: 'message', ts: '1234567890.000002', user: 'U12345', files: [{ name: 'sem-id' }] },
      { type: 'message', ts: '1234567890.000003', user: 'U12345', text: 'oi' },
    ]);
    expect(r.messages.map((m) => m.msg)).toEqual(['oi']);
    expect(r.warnings).toEqual(['2 mensagens sem texto nem arquivos foram ignoradas.']);
  });
});

// ---------- Marcação do Slack (slack.md §7, §15.5–6) ----------

describe('marcação', () => {
  const names: SlackNames = {
    user: (id) => (({ U1: 'ana', U2: 'bob' }) as Record<string, string>)[id],
    room: (id) => (({ C1: 'geral', C2: 'dev-team' }) as Record<string, string>)[id],
  };
  const conv = (s: string) => convertMarkup(s, names);
  const ana = userToken('U1', 'ana');
  const bob = userToken('U2', 'bob');

  it('usuários e salas viram marcadores, sem uma regra engolir a outra', () => {
    expect(conv('<@U1> and <@U2|bob>')).toBe(`${ana} and ${bob}`);
    expect(conv('<@U1> e <@U2|roberto>')).toBe(`${ana} e ${userToken('U2', 'roberto')}`);
    expect(conv('<#C1> <#C2|x>')).toBe(`${roomToken('C1', 'geral')} ${roomToken('C2', 'x')}`);
    expect(conv('<@U1> a | b &gt; c')).toBe(`${ana} a | b > c`);
    // Canal sem rótulo (formato atual) e com rótulo vazio.
    expect(conv('<#C1>')).toBe(roomToken('C1', 'geral'));
    expect(conv('<#C1|>')).toBe(roomToken('C1', 'geral'));
    expect(conv('<#C2>')).toBe(roomToken('C2', 'dev-team'));
    // Desconhecidos ficam com o id; a conversão decide o nome final.
    expect(conv('<@U9>')).toBe(userToken('U9'));
    expect(conv('<#C9>')).toBe(roomToken('C9'));
  });

  it('menções logo depois de pontuação, parênteses e citação', () => {
    expect(conv('hi,<@U1> (<@U2>)')).toBe(`hi,${ana} (${bob})`);
    expect(conv('&gt; <@U1> disse')).toBe(`> ${ana} disse`);
    expect(conv('_<@U1> acenou_')).toBe(`_${ana} acenou_`);
  });

  it('avisos para todos e grupos', () => {
    for (const s of ['<!here>', '<!here|here>', '<!here|@here>']) expect(conv(s)).toBe('@here');
    for (const s of ['<!channel>', '<!channel|@channel>', '<!everyone>', '<!everyone|@everyone>']) expect(conv(s)).toBe('@all');
    expect(conv('<!subteam^S123|@devs> olhem')).toBe('@devs olhem');
    expect(conv('<!subteam^S123|devs>')).toBe('@devs');
    expect(conv('<!subteam^S123>')).toBe('@S123');
    expect(conv('<!date^1392734382^{date_pretty} às {time}|Feb 18, 2014 at 6:39 AM>')).toBe('Feb 18, 2014 at 6:39 AM');
  });

  it('links, e-mails e outros endereços', () => {
    expect(conv('<https://ex.com|the docs>')).toBe('[the docs](https://ex.com)');
    expect(conv('<https://a.com/x?a=1&amp;b=2>')).toBe('https://a.com/x?a=1&b=2');
    expect(conv('<https://a.com/?q=1&amp;r=2|busca &amp; mais>')).toBe('[busca & mais](https://a.com/?q=1&r=2)');
    expect(conv('<https://ex.com|https://ex.com>')).toBe('https://ex.com');
    // O link do markdown daqui não aceita ")" no endereço nem "]" no texto.
    expect(conv('<https://pt.wikipedia.org/wiki/Java_(linguagem)|Java [wiki]>')).toBe('[Java (wiki)](https://pt.wikipedia.org/wiki/Java_%28linguagem%29)');
    expect(conv('<mailto:ana@ex.com|Ana>')).toBe('Ana (ana@ex.com)');
    expect(conv('<mailto:ana@ex.com|ana@ex.com>')).toBe('ana@ex.com');
    expect(conv('<mailto:ana@ex.com>')).toBe('ana@ex.com');
    expect(conv('<tel:+5511999990000|ligue>')).toBe('ligue');
    expect(conv('<outra-coisa>')).toBe('outra-coisa');
  });

  it('entidades são decodificadas só no texto: o que foi digitado continua texto', () => {
    expect(conv('&lt;@U9&gt; &amp;lt; a &amp; b')).toBe('<@U9> &lt; a & b');
    expect(conv('5 &gt; 3 &amp;&amp; 2 &lt; 4')).toBe('5 > 3 && 2 < 4');
    expect(conv('*negrito* _itálico_ ~tachado~ `código`')).toBe('*negrito* _itálico_ ~tachado~ `código`');
  });

  it('emoji com outro nome aqui e tom de pele', () => {
    expect(conv(':simple_smile: :slightly_smiling_face: :thinking_face: :+1::skin-tone-2: :wave:')).toBe(':slight_smile: :slight_smile: :thinking: :+1: :wave:');
    expect(emojiName('+1::skin-tone-6')).toBe('+1');
    expect(emojiName('robot_face::skin-tone-2')).toBe('robot');
    expect(emojiName('constructor')).toBe('constructor');
    // Só nomes inteiros entre dois-pontos; o resto do texto não muda.
    expect(conv('10:30:memo: :x:pencil: :nao_existe:')).toBe('10:30:memo: :x:pencil: :nao_existe:');
  });

  it('emoji do Slack não vira outro desenho aqui (tabela do Rocket.Chat trocava :memo: 📝 por :pencil: ✏️)', () => {
    // Aqui :memo: é 📝, :pencil: é ✏️ e :slight_smile: é 🙂; no Slack :pencil: é 📝, :pencil2: é ✏️ e :simple_smile: é 🙂.
    expect(conv('notas :memo: :simple_smile:')).toBe('notas :memo: :slight_smile:');
    expect(conv(':pencil: :pencil2:')).toBe(':memo: :pencil:');
    expect(emojiName('memo')).toBe('memo');
    expect(emojiName('pencil2')).toBe('pencil');
    // Nomes que não existem aqui com outro nome ficam como estão.
    expect(conv(':piggy: :uk: :pig: :gb:')).toBe(':piggy: :uk: :pig: :gb:');
    // Emoji dos blocos também.
    expect(blocksText([{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'emoji', name: 'memo' }, { type: 'emoji', name: 'simple_smile' }] }] }], names)).toBe(':memo::slight_smile:');
  });

  it('o texto não consegue criar marcadores falsos', () => {
    expect(conv('a\u0001@U1|x\u0002b')).toBe('a@U1|xb');
  });

  it('sem marcadores (tópico e descrição das salas)', () => {
    expect(convertMarkup('<@U1> <#C1> <https://x.com|site> <https://y.com> &amp;', names, 'plain')).toBe('@ana #geral site (https://x.com) https://y.com &');
    expect(convertMarkup('<@U9|zé> <#C9>', names, 'plain')).toBe('@zé #C9');
  });

  it('texto simples com marcadores (campos dos anexos mostrados sem markdown)', () => {
    expect(convertMarkup('<https://x.com|site> <https://y.com> por <@U1> em <#C1> &amp;', names, 'text')).toBe(`site (https://x.com) https://y.com por ${ana} em ${roomToken('C1', 'geral')} &`);
  });

  it('valores vazios ou que não são texto', () => {
    expect(conv('')).toBe('');
    expect(conv('linha 1\r\nlinha 2')).toBe('linha 1\nlinha 2');
    expect(convertMarkup(undefined, names)).toBe('');
    expect(convertMarkup(42, names)).toBe('');
  });
});

// ---------- Blocos ----------

describe('blocos', () => {
  const names: SlackNames = { user: (id) => (id === 'U2' ? 'bob' : undefined), room: (id) => (id === 'C1' ? 'geral' : undefined) };
  const RICH = [
    {
      type: 'rich_text',
      block_id: 'x1',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'Oi ' },
            { type: 'user', user_id: 'U2' },
            { type: 'text', text: ', veja ' },
            { type: 'channel', channel_id: 'C1' },
            { type: 'text', text: ' e ' },
            { type: 'link', url: 'https://ex.com', text: 'o site' },
            { type: 'text', text: ' ' },
            { type: 'emoji', name: 'wave', skin_tone: 2 },
            { type: 'text', text: ' importante ', style: { bold: true } },
            { type: 'broadcast', range: 'here' },
            { type: 'text', text: '\n' },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          indent: 0,
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'um' }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'dois', style: { italic: true } }] },
          ],
        },
        { type: 'rich_text_list', style: 'ordered', indent: 1, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'sub', style: { code: true } }] }] },
        { type: 'rich_text_quote', elements: [{ type: 'text', text: 'citação\nem duas linhas' }] },
        { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test', style: { bold: true } }] },
      ],
    },
  ];

  it('texto simples dos blocos rich_text, com marcadores para usuários e canais', () => {
    expect(blocksText(RICH, names)).toBe(
      [
        `Oi ${userToken('U2', 'bob')}, veja ${roomToken('C1', 'geral')} e [o site](https://ex.com) :wave: *importante* @here`,
        '- um',
        '- _dois_',
        '  1. `sub`',
        '> citação',
        '> em duas linhas',
        '```',
        'npm test',
        '```',
      ].join('\n'),
    );
  });

  it('blocos de seção e cabeçalho; outros tipos são ignorados', () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Relatório' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Feito por <@U2> &amp; equipe' }, fields: [{ type: 'mrkdwn', text: '*Status:* ok' }] },
      { type: 'divider' },
      { type: 'image', image_url: 'https://ex.com/a.png', alt_text: 'gráfico' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'enviado' }, { type: 'image', image_url: 'https://ex.com/i.png' }, { type: 'plain_text', text: 'hoje' }] },
    ];
    expect(blocksText(blocks, names)).toBe(`Relatório\nFeito por ${userToken('U2', 'bob')} & equipe\n*Status:* ok\nenviado hoje`);
    expect(blocksText('nada', names)).toBe('');
  });

  it('mensagem só com blocos usa o texto deles; com texto, vale o texto', async () => {
    expect((await one({ text: '', blocks: RICH })).msg).toContain(`Oi ${userToken('U2', 'bob')}`);
    expect((await one({ blocks: RICH })).msg).toContain('- um');
    expect((await one({ text: 'Oi <@U2>', blocks: RICH })).msg).toBe(`Oi ${userToken('U2', 'bob')}`);
  });
});

// ---------- Mensagens ----------

describe('mensagens', () => {
  it('reações por emoji, juntando os tons de pele (slack.md §15.1)', async () => {
    const m = await one({
      text: 'oi',
      reactions: [
        { name: '+1', users: ['U1'], count: 1 },
        { name: '+1::skin-tone-2', users: ['U2', 'U1'], count: 2 },
        { name: 'tada', users: ['U2'], count: 1 },
        { name: 'simple_smile', users: ['U1'], count: 1 },
        { name: 'vazia', users: [], count: 0 },
        { users: ['U1'] },
      ],
    });
    expect(m.reactions).toEqual({ ':+1:': ['U1', 'U2'], ':tada:': ['U2'], ':simple_smile:': ['U1'] });
    expect((await one({ text: 'oi', reactions: [] })).reactions).toBeUndefined();
  });

  it('reações ficam com o nome do Slack, só sem o tom de pele (a troca de nomes vale só para o texto)', async () => {
    const m = await one({
      text: ':memo:',
      reactions: [
        { name: 'memo', users: ['U1'] },
        { name: 'thinking_face::skin-tone-3', users: ['U2'] },
      ],
    });
    expect(m.msg).toBe(':memo:');
    expect(m.reactions).toEqual({ ':memo:': ['U1'], ':thinking_face:': ['U2'] });
  });

  it('threads: resposta, raiz e respostas também mostradas no canal (tshow)', async () => {
    const r = await run(
      slack([
        { type: 'message', ts: '1704067200.000100', user: 'U1', text: 'raiz', thread_ts: '1704067200.000100', reply_count: 3 },
        { type: 'message', ts: '1704067201.000100', user: 'U2', text: 'resposta', thread_ts: '1704067200.000100' },
        { type: 'message', subtype: 'thread_broadcast', ts: '1704067202.000100', user: 'U2', text: 'também no canal', thread_ts: '1704067200.000100' },
        { type: 'message', subtype: 'reply_broadcast', ts: '1704067203.000100', user: 'U1', text: 'forma antiga', thread_ts: '1704067200.000100' },
        { type: 'message', subtype: 'thread_broadcast', ts: '1704067204.000100', user: 'U1', text: 'sem thread_ts' },
      ]),
    );
    const root = 'slack-C1-1704067200-000100';
    expect(r.messages.map((m) => [m.msg, m.tmid, m.tshow])).toEqual([
      ['raiz', undefined, undefined],
      ['resposta', root, undefined],
      ['também no canal', root, true],
      ['forma antiga', root, true],
      ['sem thread_ts', undefined, undefined],
    ]);
  });

  it('raiz de thread sem texto continua, para as respostas', async () => {
    const r = await run(
      slack([
        { type: 'message', ts: '1704067200.000100', user: 'U1', text: '', thread_ts: '1704067200.000100' },
        { type: 'message', ts: '1704067201.000100', user: 'U2', text: 'resposta', thread_ts: '1704067200.000100' },
      ]),
    );
    expect(r.messages).toHaveLength(2);
  });

  it('fixada no canal (pinned_to), editada e com emoji de ícone', async () => {
    expect((await one({ text: 'importante', pinned_to: ['C1'] })).pinned).toBe(true);
    expect((await one({ text: 'em outro canal', pinned_to: ['C2'] })).pinned).toBeUndefined();
    expect(await one({ text: 'editada', edited: { user: 'U2', ts: '1704067260.000000' } })).toMatchObject({ editedAt: '2024-01-01T00:01:00.000Z', editedBy: 'U2' });
    const noTs = await one({ text: 'edição sem ts', edited: { user: 'U2' } });
    expect(noTs.editedAt).toBeUndefined();
    expect(noTs.editedBy).toBeUndefined();
    expect((await one({ text: 'x', icons: { emoji: ':ghost:', image_48: 'https://ex.com/i.png' } })).emoji).toBe(':ghost:');
  });

  it('me_message em itálico', async () => {
    expect((await one({ subtype: 'me_message', text: 'acenou para <@U2>' })).msg).toBe(`_acenou para ${userToken('U2', 'bob')}_`);
  });

  it('mensagens de sistema: entrou, saiu, tópico, descrição e nome', async () => {
    const r = await run(
      slack([
        { type: 'message', subtype: 'channel_join', ts: '1704067200.000100', user: 'U2', text: '<@U2> has joined the channel' },
        { type: 'message', subtype: 'group_leave', ts: '1704067201.000100', user: 'U2', text: '<@U2> has left' },
        { type: 'message', subtype: 'channel_topic', ts: '1704067202.000100', user: 'U1', topic: 'Fale com <@U2> &amp; cia', text: 'set the topic' },
        { type: 'message', subtype: 'group_purpose', ts: '1704067203.000100', user: 'U1', purpose: 'Projetos', text: 'set the purpose' },
        { type: 'message', subtype: 'channel_name', ts: '1704067204.000100', user: 'U1', name: 'geral-novo', old_name: 'geral', text: 'renamed' },
      ]),
    );
    expect(r.messages.map((m) => [m.t, m.u, m.msg])).toEqual([
      ['uj', 'U2', ''],
      ['ul', 'U2', ''],
      ['room_changed_topic', 'U1', `Fale com ${userToken('U2', 'bob')} & cia`],
      ['room_changed_description', 'U1', 'Projetos'],
      ['r', 'U1', 'geral-novo'],
    ]);
  });

  it('tipos não importados são contados num aviso só no fim; tombstone e outros "type" sem aviso', async () => {
    const r = await run(
      slack([
        { type: 'message', subtype: 'pinned_item', ts: '1704067200.000100', user: 'U1', text: 'pinned a message', attachments: [{ text: 'x' }] },
        { type: 'message', subtype: 'channel_archive', ts: '1704067201.000100', user: 'U1', text: 'archived' },
        { type: 'message', subtype: 'pinned_item', ts: '1704067202.000100', user: 'U1', text: 'pinned' },
        { type: 'message', subtype: 'channel_unarchive', ts: '1704067203.000100', user: 'U1' },
        { type: 'message', subtype: 'tombstone', ts: '1704067204.000100', user: 'USLACKBOT', text: 'This message was deleted.' },
        { type: 'reaction_added', ts: '1704067205.000100', user: 'U1' },
        { type: 'message', ts: '1704067206.000100', user: 'U1', text: 'fica' },
      ]),
    );
    expect(r.messages.map((m) => m.msg)).toEqual(['fica']);
    expect(r.warnings).toEqual(['Mensagens de tipos que não são importados foram ignoradas: pinned_item (2), channel_archive (1), channel_unarchive (1).']);
  });

  it('anexos de integração: marcação convertida, link de origem e cores', async () => {
    const m = await one({
      subtype: 'bot_message',
      text: '',
      attachments: [
        {
          fallback: 'resumo',
          pretext: 'Novo chamado de <@U2>',
          title: 'Chamado #7 &amp; outros',
          from_url: 'https://ex.com/7',
          text: 'Veja <https://ex.com/7|o chamado>',
          color: '36a64f',
          author_name: 'Sistema',
          author_link: 'https://ex.com',
          author_icon: 'https://ex.com/i.png',
          image_url: 'https://files.slack.com/files-pri/T/F1/x.png',
          thumb_url: 'https://ex.com/t.png',
          footer: '<https://ex.com|Ex> &amp; cia',
          ts: 1704067200,
          fields: [
            { title: 'Prioridade', value: '*alta* para <#C1>', short: true },
            { title: '', value: '' },
          ],
          actions: [{ type: 'button', text: 'Abrir' }],
        },
        { fallback: 'só o resumo' },
        { color: 'danger', ts: '1704067200' },
        'texto solto',
      ],
    });
    expect(m.attachments).toEqual([
      {
        title: 'Chamado #7 & outros',
        title_link: 'https://ex.com/7',
        text: 'Veja [o chamado](https://ex.com/7)',
        pretext: `Novo chamado de ${userToken('U2', 'bob')}`,
        color: '#36a64f',
        author_name: 'Sistema',
        author_link: 'https://ex.com',
        author_icon: 'https://ex.com/i.png',
        // Imagens de files.slack.com precisam do login do Slack.
        thumb_url: 'https://ex.com/t.png',
        footer: 'Ex (https://ex.com) & cia',
        fields: [{ title: 'Prioridade', value: `*alta* para ${roomToken('C1', 'geral')}`, short: true }],
        ts: '2024-01-01T00:00:00.000Z',
      },
      { text: 'só o resumo' },
      { color: 'danger', ts: '2024-01-01T00:00:00.000Z' },
    ]);
  });

  it('título, autor, rodapé e título dos campos dos anexos sem link em markdown (a tela mostra esses campos como texto)', async () => {
    const m = await one({
      subtype: 'bot_message',
      text: '',
      attachments: [
        {
          title: '<https://jira.acme.com/browse/OPS-1|OPS-1> fixed',
          author_name: '<https://github.com/ana|ana> via <@U2>',
          footer: '<https://github.com/acme/api|acme/api>',
          text: 'Veja <https://ex.com/7|o chamado>',
          pretext: 'Por <https://ex.com|Ex>',
          fields: [{ title: '<https://x.com|Link>', value: '<https://x.com|Link>' }],
        },
      ],
    });
    expect(m.attachments).toEqual([
      {
        title: 'OPS-1 (https://jira.acme.com/browse/OPS-1) fixed',
        author_name: `ana (https://github.com/ana) via ${userToken('U2', 'bob')}`,
        footer: 'acme/api (https://github.com/acme/api)',
        // Texto, pretexto e valor dos campos aparecem com markdown: o link continua link.
        text: 'Veja [o chamado](https://ex.com/7)',
        pretext: 'Por [Ex](https://ex.com)',
        fields: [{ title: 'Link (https://x.com)', value: '[Link](https://x.com)', short: false }],
      },
    ]);
  });
});

// ---------- Bots (slack.md §15.8) ----------

describe('bots', () => {
  it('bot sem usuário vira um usuário bot por bot_id, com o nome mostrado como apelido', async () => {
    const hook = (ts: string, username: string) => ({
      type: 'message',
      subtype: 'bot_message',
      ts,
      bot_id: 'B9',
      username,
      text: `aviso ${ts}`,
      bot_profile: { id: 'B9', name: 'Integração', icons: { image_72: 'https://avatars.slack-edge.com/b9_72.png' } },
    });
    const r = await run(slack([hook('1704067200.000100', 'GitHub'), hook('1704067201.000100', 'Jenkins')]));
    expect(r.users.filter((u) => u.importIds[0] === 'slack-bot:B9')).toEqual([
      { importIds: ['slack-bot:B9'], username: 'Integração', name: 'Integração', type: 'bot', emails: [], avatarUrl: 'https://avatars.slack-edge.com/b9_72.png' },
    ]);
    expect(r.messages.map((m) => [m.u, m.alias, m.bot])).toEqual([
      ['slack-bot:B9', 'GitHub', true],
      ['slack-bot:B9', 'Jenkins', true],
    ]);
  });

  it('sem bot_profile o nome vem de username; integração apagada no Slack não vira conta desativada', async () => {
    const r = await run(
      slack([
        { type: 'message', subtype: 'bot_message', ts: '1704067200.000100', bot_id: 'B1', username: 'deploy', text: 'ok' },
        { type: 'message', subtype: 'bot_message', ts: '1704067201.000100', bot_id: 'B2', text: 'sem nome', bot_profile: { name: 'velho', deleted: true } },
        { type: 'message', subtype: 'bot_message', ts: '1704067202.000100', bot_id: 'B3', text: 'nada' },
      ]),
    );
    const bots = r.users.filter((u) => u.importIds[0].startsWith('slack-bot:'));
    // bot_profile.deleted não passa para o usuário: com o nome de uma conta daqui, ele a desativaria.
    expect(bots.map((u) => [u.importIds[0], u.username, u.deleted])).toEqual([
      ['slack-bot:B1', 'deploy', undefined],
      ['slack-bot:B2', 'velho', undefined],
      ['slack-bot:B3', 'bot', undefined],
    ]);
    expect(bots.every((u) => !('deleted' in u))).toBe(true);
  });

  it('bot_id de um usuário de users.json é atribuído a ele', async () => {
    const users = [...USERS, { id: 'U7', name: 'ci', is_bot: true, profile: { bot_id: 'B7', real_name: 'CI' } }];
    const r = await run({ ...slack([{ type: 'message', subtype: 'bot_message', ts: '1704067200.000100', bot_id: 'B7', username: 'ci', text: 'build ok' }]), 'users.json': j(users) });
    expect(r.messages[0]).toMatchObject({ u: 'U7', alias: 'ci', bot: true });
    expect(r.users.some((u) => u.importIds[0].startsWith('slack-bot:'))).toBe(false);
  });

  it('sem usuário e sem bot_id: o Slackbot', async () => {
    const m = await one({ user: undefined, subtype: 'bot_message', username: 'Lembrete', text: 'reunião' });
    expect(m).toMatchObject({ u: 'USLACKBOT', alias: 'Lembrete', bot: true });
  });

  it('bot_message com usuário: o apelido só quando o nome mostrado é outro', async () => {
    expect((await one({ subtype: 'bot_message', username: 'ana', text: 'x' })).alias).toBeUndefined();
    expect(await one({ subtype: 'bot_message', username: 'Robô da Ana', text: 'x' })).toMatchObject({ u: 'U1', alias: 'Robô da Ana', bot: true });
    expect(await one({ subtype: 'slackbot_response', user: 'USLACKBOT', text: 'resposta' })).toMatchObject({ u: 'USLACKBOT', bot: true });
  });
});

// ---------- Usuários ----------

describe('usuários', () => {
  it('administradores, donos, apps, desativados e perfil ausente', async () => {
    const r = await run({
      'users.json': j([
        { id: 'U1', name: 'chefe', is_admin: true, profile: { email: 'chefe@ex.com' } },
        { id: 'U2', name: 'dona', is_owner: true, is_primary_owner: true, profile: { email: 'dona@ex.com' } },
        { id: 'U3', name: 'app', is_app_user: true, profile: { real_name: 'App' } },
        { id: 'U4', name: 'saiu', deleted: true, profile: { email: 'saiu@ex.com' } },
        { id: 'U5', name: 'semperfil', real_name: 'Sem Perfil' },
        { id: 'U6', name: 'padrao', profile: { is_custom_image: false, image_512: 'https://secure.gravatar.com/avatar/x.png', display_name: 'Padrão' } },
      ]),
    });
    expect(r.users.slice(0, 6)).toEqual([
      { importIds: ['U1'], emails: ['chefe@ex.com'], username: 'chefe', roles: ['admin'] },
      { importIds: ['U2'], emails: ['dona@ex.com'], username: 'dona', roles: ['admin'] },
      { importIds: ['U3'], emails: [], username: 'app', name: 'App', type: 'bot' },
      { importIds: ['U4'], emails: ['saiu@ex.com'], username: 'saiu', deleted: true },
      { importIds: ['U5'], emails: [], username: 'semperfil', name: 'Sem Perfil' },
      { importIds: ['U6'], emails: [], username: 'padrao', name: 'Padrão' },
    ]);
  });

  it('o Slackbot de users.json não é duplicado e é sempre bot', async () => {
    const r = await run({ 'users.json': j([...USERS, { id: 'USLACKBOT', name: 'slackbot', is_bot: false, profile: { real_name: 'Slackbot' } }]) });
    expect(r.users.filter((u) => u.importIds[0] === 'USLACKBOT')).toEqual([{ importIds: ['USLACKBOT'], emails: [], username: 'slackbot', name: 'Slackbot', type: 'bot' }]);
  });

  it('sem nome de usuário usa o nome de exibição; sem nada, sem id ou repetido é ignorado com aviso', async () => {
    const r = await run({
      'users.json': j([
        { id: 'U1', profile: { display_name: 'zeca', email: 'zeca@ex.com' } },
        { id: 'U2', profile: { real_name: 'Ninguém' } },
        { name: 'semid' },
        'texto',
        { id: 'U1', name: 'outro' },
      ]),
    });
    expect(r.users.map((u) => u.importIds[0])).toEqual(['U1', 'USLACKBOT']);
    expect(r.users[0]).toMatchObject({ username: 'zeca', name: 'zeca' });
    expect(r.warnings).toEqual([
      '"users.json": 2 usuários sem id foram ignorados.',
      '"users.json": 1 usuário sem nome de usuário e sem e-mail foi ignorado.',
      '"users.json": 1 usuário repetido foi ignorado (vale o primeiro).',
    ]);
  });
});

// ---------- Conversas ----------

describe('conversas', () => {
  it('grupos privados, MPIMs pequenas como DM e grandes como grupo privado', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `U${i + 1}`);
    const r = await run({
      'users.json': j(USERS),
      'groups.json': j([{ id: 'G1', name: 'diretoria', creator: 'U1', is_archived: true, members: ['U1'], purpose: { value: 'Só a diretoria' } }]),
      'mpims.json': j([
        { id: 'G2', name: 'mpdm-ana--bob-1', creator: 'U1', members: ['U1', 'U2'] },
        { id: 'G3', name: 'mpdm-nove-1', members: ten.slice(0, 9) },
        { id: 'G4', name: 'mpdm-dez-1', creator: 'U1', members: ten, topic: { value: 'Muita gente' } },
      ]),
      'mpdm-ana--bob-1/2024-01-01.json': j([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'na mpim' }]),
      'mpdm-dez-1/2024-01-01.json': j([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'no grupo' }]),
      'diretoria/2024-01-01.json': j([{ type: 'message', subtype: 'group_join', ts: '1704067100.000100', user: 'U1' }]),
    });
    expect(r.channels).toEqual([
      { importIds: ['G1'], t: 'p', name: 'diretoria', users: ['U1'], creator: 'U1', description: 'Só a diretoria', archived: true },
      { importIds: ['G2'], t: 'd', users: ['U1', 'U2'] },
      { importIds: ['G3'], t: 'd', users: ten.slice(0, 9) },
      { importIds: ['G4'], t: 'p', name: 'mpdm-dez-1', users: ten, creator: 'U1', topic: 'Muita gente' },
    ]);
    expect(r.messages.map((m) => [m.rid, m.msg])).toEqual([
      ['G1', ''],
      ['G2', 'na mpim'],
      ['G4', 'no grupo'],
    ]);
    expect(r.messages[0].t).toBe('uj');
  });

  it('sem filtro de criador; membros ausentes; canal sem nome recebe o id; repetidos e DMs vazias são ignorados', async () => {
    const r = await run({
      'users.json': j(USERS),
      'channels.json': j([
        { id: 'C1', name: 'sem-criador' },
        { id: 'C2', name: 'criador-nulo', creator: null, members: null },
        { id: 'C3' },
        { id: 'C1', name: 'repetido' },
        { name: 'sem-id' },
      ]),
      'dms.json': j([
        { id: 'D1', members: ['U1', 'U1'] },
        { id: 'D2', members: [] },
        { id: 'D3' },
      ]),
    });
    expect(r.channels).toEqual([
      { importIds: ['C1'], t: 'c', name: 'sem-criador', users: [] },
      { importIds: ['C2'], t: 'c', name: 'criador-nulo', users: [] },
      { importIds: ['C3'], t: 'c', name: 'C3', users: [] },
      // Conversa com a própria pessoa.
      { importIds: ['D1'], t: 'd', users: ['U1'] },
    ]);
    expect(r.warnings).toEqual([
      '"channels.json": 1 conversa sem id foi ignorada.',
      '"channels.json": 1 canal sem nome recebeu o id do Slack como nome.',
      '"channels.json": 1 conversa repetida foi ignorada (vale a primeira).',
      '"dms.json": 2 conversas sem membros foram ignoradas.',
    ]);
  });

  it('tópico e descrição sem a marcação do Slack, citando canais que vêm depois', async () => {
    const r = await run({
      'users.json': j(USERS),
      'channels.json': j([{ id: 'C1', name: 'geral', topic: { value: 'Avisos de <@U2> &amp; <#G1|>' }, purpose: { value: 'Veja <https://ex.com|o site>' } }]),
      'groups.json': j([{ id: 'G1', name: 'equipe' }]),
    });
    expect(r.channels[0]).toMatchObject({ topic: 'Avisos de @bob & #equipe', description: 'Veja o site (https://ex.com)' });
  });

  it('pasta pelo id do canal, pasta sem conversa ignorada com um aviso', async () => {
    const r = await run({
      ...slack([]),
      'C1/2024-01-02.json': j([{ type: 'message', ts: '1704153600.000100', user: 'U1', text: 'pasta com o id' }]),
      'sumiu/2024-01-01.json': j([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'x' }]),
      'sumiu/2024-01-02.json': j([{ type: 'message', ts: '1704153600.000100', user: 'U1', text: 'y' }]),
    });
    expect(r.messages.map((m) => [m.rid, m.msg])).toEqual([['C1', 'pasta com o id']]);
    expect(r.warnings).toEqual(['A pasta "sumiu" não corresponde a nenhum canal, grupo ou conversa da exportação; as mensagens dela foram ignoradas.']);
  });
});

// ---------- O arquivo .zip ----------

describe('o arquivo da exportação', () => {
  it('pasta em volta de tudo, lixo do macOS e marca BOM', async () => {
    const bom = (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)]);
    const r = await run({
      'minha-exportacao/users.json': bom(j(USERS)),
      'minha-exportacao/channels.json': bom(j(CHANNELS)),
      'minha-exportacao/geral/2024-01-01.json': bom(j([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'olá' }])),
      'minha-exportacao/.DS_Store': 'lixo',
      '__MACOSX/minha-exportacao/._users.json': 'lixo',
      'minha-exportacao/geral/.DS_Store': 'lixo',
    });
    expect(r.users.map((u) => u.username)).toEqual(['ana', 'bob', 'slackbot']);
    expect(r.channels.map((c) => c.name)).toEqual(['geral']);
    expect(r.messages.map((m) => [m.rid, m.msg])).toEqual([['C1', 'olá']]);
    expect(r.warnings).toEqual([]);
  });

  it('arquivos fora da pasta da exportação são ignorados com aviso', async () => {
    const r = await run({ 'export/users.json': j(USERS), 'export/channels.json': j(CHANNELS), 'leia-me.txt': 'oi' });
    expect(r.channels).toHaveLength(1);
    expect(r.warnings).toEqual(['1 arquivo fora da pasta "export" da exportação foi ignorado.']);
  });

  it('sem os arquivos da exportação do Slack: erro claro', async () => {
    const { ctx } = fakeContext(memoryArchive({ 'geral/2024-01-01.json': '[]', 'notas.txt': 'x' }));
    await expect(slackImporter.prepare(ctx)).rejects.toThrow(ImportError);
    await expect(slackImporter.prepare(ctx)).rejects.toThrow('não parece uma exportação do Slack');
  });

  it('users.json ou channels.json com defeito param a leitura, com o nome e a linha', async () => {
    const broken = async (files: Record<string, string>) => {
      const { ctx } = fakeContext(memoryArchive(files));
      return slackImporter.prepare(ctx).then(
        () => '',
        (e) => (e instanceof ImportError ? e.message : `outro erro: ${e}`),
      );
    };
    expect(await broken({ 'users.json': '[\n  {"id": "U1"},\n  {"id": "U2",}\n]' })).toBe('Não foi possível ler a exportação: "users.json" não é um JSON válido (erro perto da linha 3).');
    expect(await broken({ 'users.json': j(USERS), 'channels.json': j({ channels: [] }) })).toBe('Não foi possível ler a exportação: "channels.json" deveria ter uma lista (começando com "[").');
  });

  it('dia com JSON inválido ou sem lista é ignorado com aviso, e os outros dias continuam', async () => {
    const r = await run({
      ...slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'dia 1' }]),
      'geral/2024-01-02.json': '[{"type": "message", "ts": "1"',
      'geral/2024-01-03.json': j({ messages: [] }),
      'geral/2024-01-04.json': j([{ type: 'message', ts: '1704326400.000100', user: 'U1', text: 'dia 4' }]),
      'geral/anexo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(r.messages.map((m) => m.msg)).toEqual(['dia 1', 'dia 4']);
    expect(r.warnings).toEqual([
      '"geral/2024-01-02.json" não é um JSON válido (erro perto da linha 1) e foi ignorado.',
      '"geral/2024-01-03.json" não tem uma lista de mensagens e foi ignorado.',
      '1 arquivo que não é .json foi ignorado dentro das pastas das conversas.',
    ]);
  });

  it('uma mensagem com defeito não leva junto o resto do dia (slack.md §15.9)', async () => {
    const r = await run(
      slack([
        { type: 'message', ts: '1704067200.000100', user: 'U1', text: 'antes' },
        { type: 'message', user: 'U1', text: 'sem ts' },
        null,
        { type: 'message', subtype: 'channel_join', ts: '1704067201.000100' },
        { type: 'message', ts: '1704067202.000100', user: 'U2', text: 'depois' },
      ]),
    );
    expect(r.messages.map((m) => m.msg)).toEqual(['antes', 'depois']);
    expect(r.warnings).toEqual([
      'Mensagem ignorada em "geral/2024-01-01": sem "ts".',
      'Mensagem ignorada em "geral/2024-01-01": não é um objeto.',
      'Mensagem ignorada em "geral/2024-01-01" (ts 1704067201.000100): "channel_join" sem usuário.',
    ]);
  });

  it('muitas mensagens com defeito: os primeiros avisos e depois a contagem', async () => {
    const r = await run(slack(Array.from({ length: 60 }, () => ({ type: 'message', user: 'U1', text: 'sem ts' }))));
    expect(r.warnings).toHaveLength(51);
    expect(r.warnings.at(-1)).toBe('E mais 10 mensagens ignoradas por problemas no formato.');
  });

  it('lê um .zip de verdade', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wescc-slack-'));
    try {
      const file = path.join(dir, 'slack.zip');
      await fs.promises.writeFile(file, await zipBuffer({ 'export/users.json': j(USERS), 'export/channels.json': j(CHANNELS), 'export/geral/2024-01-01.json': j([{ type: 'message', ts: '1704067200.000100', user: 'U2', text: 'oi' }]) }));
      const source = await openArchive(file, 'zip');
      const { ctx, r } = fakeContext(source);
      try {
        await slackImporter.prepare(ctx);
      } finally {
        await source.close();
      }
      expect(r.messages).toEqual([{ importId: 'slack-C1-1704067200-000100', rid: 'C1', u: 'U2', msg: 'oi', ts: '2024-01-01T00:00:00.000Z' }]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('é o importador "slack" de .zip', () => {
    expect(slackImporter).toMatchObject({ key: 'slack', name: 'Slack', accept: '.zip', sourceKind: 'zip', visible: true });
  });
});

// ---------- Arquivos grandes e conteúdo hostil ----------

describe('arquivos grandes e conteúdo hostil', () => {
  const names: SlackNames = { user: () => undefined, room: () => undefined };
  // Tempo só da leitura (sem a conferência de jsonb do run, que é lenta com textos enormes).
  async function timed(files: Record<string, string | Buffer>) {
    const { ctx, r } = fakeContext(memoryArchive(files));
    const t = performance.now();
    await slackImporter.prepare(ctx);
    return { r, ms: performance.now() - t };
  }
  const section = (text: string, style?: Record<string, boolean>) => [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text, ...(style ? { style } : {}) }] }] }];
  const onlyBlocks = (blocks: unknown) => slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: '', blocks }]);

  it('arquivo .json acima de 64 MB: o dia é ignorado com aviso e users.json para a leitura (antes ia até 256 MB e estourava a memória)', async () => {
    // Uma lista vazia válida de 64 MB e 1 byte: sem o limite, seria lida e montada inteira.
    const big = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
    big[0] = 0x5b;
    big[big.length - 1] = 0x5d;
    const r = await run(slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'fica' }], { 'geral/2024-01-02.json': big }));
    expect(r.messages.map((m) => m.msg)).toEqual(['fica']);
    expect(r.warnings).toHaveLength(1);
    // A mensagem vem da leitura do arquivo (archive.ts); daqui só o fim.
    expect(r.warnings[0]).toContain('"geral/2024-01-02.json" é grande demais');
    expect(r.warnings[0]).toContain('64 MB');
    expect(r.warnings[0]).toMatch(/ O arquivo foi ignorado\.$/);
    for (const file of ['users.json', 'channels.json']) {
      const { ctx } = fakeContext(memoryArchive({ ...slack([]), [file]: big }));
      const error = await slackImporter.prepare(ctx).then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(ImportError);
      expect(error.message).toContain(`"${file}" é grande demais`);
      expect(error.message).toContain('64 MB');
    }
  });

  // Maior texto que o JSON.parse recebeu durante fn.
  async function largestParse(fn: () => Promise<unknown>) {
    const parse = JSON.parse;
    let max = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: any) => {
      max = Math.max(max, text.length);
      return parse(text, reviver);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return max;
  }
  // Com os limites trocados só durante fn.
  async function withLimits<T>(limits: Partial<typeof SLACK_LIMITS>, fn: () => Promise<T>) {
    const saved = { ...SLACK_LIMITS };
    Object.assign(SLACK_LIMITS, limits);
    try {
      return await fn();
    } finally {
      Object.assign(SLACK_LIMITS, saved);
    }
  }
  const settle = <T>(p: Promise<T>) =>
    p.then(
      () => null,
      (e) => e,
    );

  it('listas lidas aos pedaços: nenhum JSON.parse monta um arquivo inteiro, nem as quatro listas de conversas juntas (um .zip de 3 MB com "-0,-0,..." estourava a memória)', async () => {
    // Cada -0 ocupa uns 24 bytes depois de lido, e não é objeto nem lista: o limite de objetos e listas não pegava.
    const padded = (first: unknown) => `[${j(first)}${',-0'.repeat(500_000)}]`;
    const files = {
      'users.json': padded(USERS[0]),
      'channels.json': padded(CHANNELS[0]),
      'groups.json': padded({ id: 'G1', name: 'privado', members: ['U1'] }),
      'mpims.json': padded({ id: 'G2', name: 'mpdm-ana--bob-1', members: ['U1', 'U2'] }),
      'dms.json': padded({ id: 'D1', members: ['U1', 'U2'] }),
      'geral/2024-01-01.json': padded({ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'oi' }),
    };
    const { ctx, r } = fakeContext(memoryArchive(files));
    const max = await largestParse(() => slackImporter.prepare(ctx));
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(SLACK_LIMITS.pieceBytes + 1000);
    expect(r.users.map((u) => u.importIds[0])).toEqual(['U1', 'USLACKBOT']);
    expect(r.channels.map((c) => [c.importIds[0], c.t])).toEqual([
      ['C1', 'c'],
      ['G1', 'p'],
      ['G2', 'd'],
      ['D1', 'd'],
    ]);
    expect(r.messages.map((m) => m.msg)).toEqual(['oi']);
    expect(r.warnings).toContain('"users.json": 500000 usuários sem id foram ignorados.');
    expect(r.warnings).toContain('"dms.json": 500000 conversas sem id foram ignoradas.');
    expect(r.warnings.at(-1)).toBe('E mais 499950 mensagens ignoradas por problemas no formato.');
  });

  it('um item com valores demais ou de mais de 16 MB é recusado antes de ser montado, e o dia dele é ignorado inteiro', async () => {
    const good = { type: 'message', ts: '1704067200.000100', user: 'U1', text: 'fica' };
    const dense = { type: 'message', ts: '1704153600.000100', user: 'U1', text: 'x', blocks: Array(SLACK_LIMITS.itemValues).fill(0) };
    const huge = { type: 'message', ts: '1704153600.000200', user: 'U1', text: 'x'.repeat(SLACK_LIMITS.itemBytes) };
    for (const item of [dense, huge]) {
      const day = j([{ ...good, ts: '1704153600.000001', text: 'some com o dia' }, item]);
      const { ctx, r } = fakeContext(memoryArchive(slack([good], { 'geral/2024-01-02.json': day })));
      const max = await largestParse(() => slackImporter.prepare(ctx));
      expect(max).toBeLessThan(1000);
      expect(r.messages.map((m) => m.msg)).toEqual(['fica']);
      expect(r.warnings).toEqual(['"geral/2024-01-02.json" tem um item grande demais (mais de 16 MB ou de 500.000 valores) e foi ignorado.']);
    }
    const bigUser = j([USERS[0], { ...USERS[1], profile: { ...USERS[1].profile, fields: Array(SLACK_LIMITS.itemValues).fill(0) } }]);
    const bigChannel = j([{ ...CHANNELS[0], members: Array.from({ length: SLACK_LIMITS.itemValues + 1 }, (_, i) => `U${i}`) }]);
    for (const [file, content] of [['users.json', bigUser], ['channels.json', bigChannel]]) {
      const { ctx } = fakeContext(memoryArchive({ ...slack([]), [file]: content }));
      const error = await settle(slackImporter.prepare(ctx));
      expect(error).toBeInstanceOf(ImportError);
      expect(error.message).toBe(`Não foi possível ler a exportação: "${file}" tem um item grande demais (mais de 16 MB ou de 500.000 valores).`);
    }
    // Um canal com 400 mil membros (um #geral de um espaço de trabalho enorme) ainda cabe.
    const members = Array.from({ length: 400_000 }, (_, i) => `U${i}`);
    const { ctx, r } = fakeContext(memoryArchive({ ...slack([]), 'channels.json': j([{ ...CHANNELS[0], members }]) }));
    await slackImporter.prepare(ctx);
    expect(r.channels[0].users).toHaveLength(400_000);
  });

  it('o JSON cortado em pedaços é conferido como um só: defeito no fim ignora o dia inteiro e diz a linha certa', async () => {
    // Uns 600 KB em várias linhas: mais de um pedaço.
    const many = Array.from({ length: 3000 }, (_, i) => ({ type: 'message', ts: `1704153600.${String(i).padStart(6, '0')}`, user: 'U1', text: `m${i} ${'x'.repeat(150)}` }));
    const pretty = JSON.stringify(many, null, 2);
    expect(pretty.length).toBeGreaterThan(2 * SLACK_LIMITS.pieceBytes);
    const lines = pretty.split('\n').length;
    const broken: Record<string, string> = {
      '02': pretty.replace(/\n\]$/, ',\n  {"ts": "1" "2"}\n]'), // vírgula faltando no último item, na penúltima linha
      '03': pretty.replace(/\n\]$/, ',\n]'), // vírgula sobrando
      '04': pretty.replace(/\n\]$/, '\n}'), // fecha com o colchete errado
      '05': `${pretty} x`, // algo depois da lista
      '06': pretty.slice(0, -2), // cortado no meio
      '07': pretty.replace('"m2999', '"m2999\n'), // quebra de linha crua dentro de um texto
      '08': pretty.replace(/\n\]$/, ',\n  {"ts": x}\n]'), // o V8 não diz a posição: sem linha
    };
    const files: Record<string, string> = { ...slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'fica' }]) };
    for (const [day, content] of Object.entries(broken)) files[`geral/2024-01-${day}.json`] = content;
    files['geral/2024-01-10.json'] = `\ufeff ${pretty} \n`; // BOM e espaços: válido
    files['geral/2024-01-11.json'] = ' [ ] ';
    // Chaves, colchetes, vírgulas e aspas dentro dos textos não contam, nem depois de barras escapadas.
    const tricky = '"{[\\{\\"{,]}:'.repeat(60_000);
    files['geral/2024-01-12.json'] = j([
      { type: 'message', ts: '1704931200.000100', user: 'U1', text: tricky },
      ...many.slice(0, 1000).map((m) => ({ ...m, ts: m.ts.replace('1704153600', '1704931201') })),
      { type: 'message', ts: '1704931202.000100', user: 'U1', text: 'depois' },
    ]);
    const r = await run(files);
    const twelfth = r.messages.filter((m) => m.ts?.startsWith('2024-01-11'));
    expect(twelfth.map((m) => m.msg)).toEqual([tricky, ...many.slice(0, 1000).map((m) => m.text), 'depois']);
    r.messages = r.messages.filter((m) => !twelfth.includes(m));
    expect(r.messages).toHaveLength(1 + 3000);
    expect(r.messages.filter((m) => m.msg === 'fica')).toHaveLength(1);
    expect(r.warnings).toEqual([
      `"geral/2024-01-02.json" não é um JSON válido (erro perto da linha ${lines}) e foi ignorado.`,
      `"geral/2024-01-03.json" não é um JSON válido (erro perto da linha ${lines}) e foi ignorado.`,
      `"geral/2024-01-04.json" não é um JSON válido (erro perto da linha ${lines}) e foi ignorado.`,
      `"geral/2024-01-05.json" não é um JSON válido (erro perto da linha ${lines}) e foi ignorado.`,
      `"geral/2024-01-06.json" não é um JSON válido (erro perto da linha ${lines - 1}) e foi ignorado.`,
      `"geral/2024-01-07.json" não é um JSON válido (erro perto da linha ${lines - 2}) e foi ignorado.`,
      '"geral/2024-01-08.json" não é um JSON válido e foi ignorado.',
    ]);
    // Os mesmos defeitos em users.json param a leitura.
    for (const [day, content] of Object.entries(broken)) {
      const { ctx } = fakeContext(memoryArchive({ ...slack([]), 'users.json': content }));
      const error = await settle(slackImporter.prepare(ctx));
      expect(error, day).toBeInstanceOf(ImportError);
      expect(error.message, day).toMatch(/^Não foi possível ler a exportação: "users\.json" não é um JSON válido/);
    }
  });

  it('usuários e conversas demais para guardar na memória param a leitura com erro claro (milhões de itens pequenos esgotavam a memória)', async () => {
    const users = Array.from({ length: 20_000 }, (_, i) => ({ id: `U${i}`, name: `u${i}` }));
    const files = { ...slack([]), 'users.json': j(users) };
    // Com o limite de verdade, passa; com um limite pequeno, para antes de guardar tudo.
    const ok = fakeContext(memoryArchive(files));
    await slackImporter.prepare(ok.ctx);
    expect(ok.r.users).toHaveLength(20_001);
    await withLimits({ tableBytes: 1024 * 1024 }, async () => {
      const { ctx, r } = fakeContext(memoryArchive(files));
      const error = await settle(slackImporter.prepare(ctx));
      expect(error).toBeInstanceOf(ImportError);
      expect(error.message).toBe('Não foi possível ler a exportação: ela tem usuários e conversas demais para ler de uma vez (os nomes e ids guardados durante a leitura passariam de 1 MB).');
      expect(r.users.length).toBeLessThan(20_000);
      // Conversas também contam (o nome e o id de cada uma ficam guardados).
      const conversations = Array.from({ length: 20_000 }, (_, i) => ({ id: `C${i}`, name: `canal-${i}`, members: [] }));
      const second = fakeContext(memoryArchive({ ...slack([]), 'channels.json': j(conversations) }));
      expect((await settle(slackImporter.prepare(second.ctx)))?.message).toMatch(/usuários e conversas demais/);
    });
  });

  it('integrações (bot_id) e subtipos diferentes demais não crescem sem limite durante os dias', async () => {
    const messages = [
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'message', subtype: 'bot_message', ts: `1704067200.00010${i}`, bot_id: `B${i}`, text: `bot ${i}` })),
      ...['a', 'b', 'c', 'd', 'c'].map((subtype, i) => ({ type: 'message', subtype, ts: `1704067201.00010${i}`, user: 'U1', text: 'x' })),
    ];
    const r = await withLimits({ bots: 3, ignoredKinds: 2 }, () => run(slack(messages)));
    expect(r.users.filter((u) => u.importIds[0].startsWith('slack-bot:')).map((u) => u.importIds[0])).toEqual(['slack-bot:B0', 'slack-bot:B1', 'slack-bot:B2']);
    expect(r.messages.map((m) => m.msg)).toEqual(['bot 0', 'bot 1', 'bot 2']);
    expect(r.warnings).toEqual([
      'Mensagem ignorada em "geral/2024-01-01" (ts 1704067200.000103): a exportação tem mais de 3 integrações (bot_id) diferentes.',
      'Mensagem ignorada em "geral/2024-01-01" (ts 1704067200.000104): a exportação tem mais de 3 integrações (bot_id) diferentes.',
      'Mensagens de tipos que não são importados foram ignoradas: outros tipos (3), a (1), b (1).',
    ]);
    // Os bots também contam no limite das tabelas, e passar dele para a leitura (não vira "formato inesperado").
    const named = messages.slice(0, 5).map((m, i) => ({ ...m, bot_profile: { name: `bot-${i}-${'x'.repeat(200_000)}` } }));
    const error = await withLimits({ tableBytes: 1024 * 1024 }, () => settle(slackImporter.prepare(fakeContext(memoryArchive(slack(named))).ctx)));
    expect(error).toBeInstanceOf(ImportError);
    expect(error.message).toMatch(/usuários e conversas demais/);
  });

  it('dia com milhões de itens com defeito é lido depressa e só os primeiros viram aviso (antes uma exceção por item)', async () => {
    const junk = '[' + '{},0,'.repeat(1_000_000) + '0]';
    const { r, ms } = await timed(slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'fica' }], { 'geral/2024-01-02.json': junk }));
    expect(ms).toBeLessThan(3000);
    expect(r.messages.map((m) => m.msg)).toEqual(['fica']);
    expect(r.warnings).toHaveLength(51);
    expect(r.warnings.slice(0, 2)).toEqual(['Mensagem ignorada em "geral/2024-01-02": sem "ts".', 'Mensagem ignorada em "geral/2024-01-02": não é um objeto.']);
    expect(r.warnings.at(-1)).toBe('E mais 1999951 mensagens ignoradas por problemas no formato.');
  });

  it('arquivo recusado pela leitura do .zip (ex.: taxa de compressão suspeita): o dia é ignorado com aviso e users.json para a leitura', async () => {
    const refusing = (files: Record<string, string>, refused: string): ArchiveSource => {
      const inner = memoryArchive(files);
      return {
        ...inner,
        read: async (entry, maxBytes) => {
          if (entry.name === refused) throw new ImportError('O .zip parece corrompido ou malicioso (taxa de compressão suspeita).');
          return inner.read(entry, maxBytes);
        },
      };
    };
    const files = slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'fica' }], { 'geral/2024-01-02.json': '[]' });
    const day = fakeContext(refusing(files, 'geral/2024-01-02.json'));
    await slackImporter.prepare(day.ctx);
    expect(day.r.messages.map((m) => m.msg)).toEqual(['fica']);
    expect(day.r.warnings).toEqual(['O .zip parece corrompido ou malicioso (taxa de compressão suspeita). O arquivo foi ignorado.']);
    const meta = fakeContext(refusing(files, 'users.json'));
    await expect(slackImporter.prepare(meta.ctx)).rejects.toThrow('O .zip parece corrompido ou malicioso (taxa de compressão suspeita).');
  });

  it('avisos com texto do arquivo nunca ficam com metade de um emoji (o jsonb dos avisos recusaria)', async () => {
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const emojis = 'a' + '😀'.repeat(45);
    const r = await run(
      slack([
        { type: 'message', subtype: 'channel_join', ts: emojis },
        { type: 'message', subtype: 'channel_join', ts: '\ud83d sozinho' },
        { type: 'message', subtype: emojis, ts: '1704067200.000100', user: 'U1' },
        { type: 'message', ts: '1704067201.000100', user: 'U1', text: 'x', attachments: [{ text: 'a', color: 'b' + '😀'.repeat(40) }] },
      ]),
    );
    expect(r.warnings).toHaveLength(3);
    for (const w of r.warnings) expect(loneSurrogate.test(w), w).toBe(false);
    expect(r.warnings[0]).toBe(`Mensagem ignorada em "geral/2024-01-01" (ts a${'😀'.repeat(39)}): "channel_join" sem usuário.`);
    expect(r.messages[0].attachments![0].color).toBe('b' + '😀'.repeat(29));
  });

  it('um dia com muitas mensagens devolve a vez ao event loop durante a leitura', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ type: 'message', ts: `1704067200.${String(i).padStart(6, '0')}`, user: 'U1', text: `m${i}` }));
    const { ctx, r } = fakeContext(memoryArchive(slack(many)));
    const seen: number[] = [];
    let done = false;
    const spin = () => {
      seen.push(r.messages.length);
      if (!done) setImmediate(spin);
    };
    setImmediate(spin);
    await slackImporter.prepare(ctx);
    done = true;
    expect(r.messages).toHaveLength(3000);
    // Outras tarefas do servidor rodaram no meio da leitura, não só no fim.
    expect(seen.some((n) => n > 0 && n < 3000)).toBe(true);
  });

  it('texto com estilo e muitos espaços no meio não trava a leitura (a regex de styled era quadrática)', async () => {
    const text = 'a' + ' '.repeat(1_000_000) + 'b';
    const { r, ms } = await timed(onlyBlocks(section(text, { bold: true })));
    expect(ms).toBeLessThan(1000);
    expect(r.messages[0].msg).toBe(`*${text}*`);
    // Os espaços das pontas continuam fora da marcação.
    expect(blocksText(section('  a  b \t', { bold: true, italic: true }), names)).toBe('  *_a  b_* \t');
    expect(blocksText(section(' x ', { code: true }), names)).toBe(' `x` ');
    expect(blocksText(section('   ', { bold: true }), names)).toBe('   ');
  });

  it('muitas quebras de linha num bloco não travam a leitura (a regex de trimEnd era quadrática)', async () => {
    const text = '\n'.repeat(1_000_000) + 'x';
    const { r, ms } = await timed(onlyBlocks([{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }, { type: 'rich_text_quote', elements: [{ type: 'text', text }] }] }]));
    expect(ms).toBeLessThan(1000);
    expect(r.messages[0].msg.startsWith(text)).toBe(true);
    expect(blocksText(section('fim\n\n\n'), names)).toBe('fim');
  });

  it('as outras regexes aplicadas ao texto do arquivo levam tempo linear (1 MB hostil em bem menos de 1 s)', () => {
    const n = 1_000_000;
    const cases: [string, () => unknown][] = [
      ['marcador sem fim', () => convertMarkup('<' + 'a'.repeat(n), names)],
      ['muitos <', () => convertMarkup('<'.repeat(n), names)],
      ['link com muitos espaços no rótulo', () => convertMarkup('<https://x.com|' + ' \t'.repeat(n / 2) + 'a>', names)],
      ['link com muitos parênteses', () => convertMarkup('<https://x.com/' + '('.repeat(n) + '|a>', names)],
      ['tom de pele sem fim', () => convertMarkup('::skin-tone-' + '1'.repeat(n) + 'x', names)],
      ['nome de emoji sem fim', () => convertMarkup(':' + 'a'.repeat(n), names)],
      ['dois-pontos alternados', () => convertMarkup(':a'.repeat(n / 2), names)],
      ['entidades pela metade', () => convertMarkup('&amp'.repeat(n / 4), names)],
      ['emoji de reação', () => emojiName('::skin-tone-1'.repeat(n / 13) + 'x')],
      ['ts com muitos dígitos', () => slackTs('1'.repeat(n) + 'x')],
      ['ts com muitos pontos', () => slackMessageId('C1', '1.'.repeat(n / 2))],
    ];
    for (const [label, fn] of cases) {
      const t = performance.now();
      fn();
      expect(performance.now() - t, label).toBeLessThan(1000);
    }
  });

  it('muitas reações com o mesmo emoji não travam a leitura', async () => {
    // 60 mil reações (o Slack aceita umas 50): ainda dentro do limite de valores de um item.
    const reactions = Array.from({ length: 60_000 }, (_, i) => ({ name: i % 2 ? '+1' : '+1::skin-tone-2', users: [`U${i}`, 'U1'] }));
    const { r, ms } = await timed(slack([{ type: 'message', ts: '1704067200.000100', user: 'U1', text: 'oi', reactions }]));
    expect(ms).toBeLessThan(1000);
    expect(Object.keys(r.messages[0].reactions!)).toEqual([':+1:']);
    expect(r.messages[0].reactions![':+1:']).toHaveLength(60_000);
  });
});

function zipBuffer(files: Record<string, string>) {
  const z = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) z.addBuffer(Buffer.from(content), name);
  z.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
  });
}

// ---------- De ponta a ponta: envio, leitura, seleção e conversão ----------

describe('de ponta a ponta', () => {
  let A: Auth;
  const ops: string[] = [];

  beforeAll(async () => {
    await startServer();
    A = await admin();
    await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  });
  afterAll(async () => {
    for (const id of ops) await fs.promises.rm(operationDir(id), { recursive: true, force: true });
    await stopServer();
  });

  const current = async () => (await api('GET', 'getCurrentImportOperation', undefined, A)).operation;
  async function waitOp(pred: (op: any) => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    for (;;) {
      const op = await current();
      if (op && pred(op)) return op;
      if (Date.now() > end) throw new Error(`a operação não chegou ao estado esperado: ${j(op)}`);
      await sleep(50);
    }
  }

  async function importZip(files: Record<string, string>) {
    const fd = new FormData();
    fd.append('importerKey', 'slack');
    fd.append('file', new Blob([new Uint8Array(await zipBuffer(files))], { type: 'application/zip' }), 'slack-export.zip');
    const up = await api('POST', 'uploadImportFile', fd, A);
    expect(up.success, j(up)).toBe(true);
    ops.push(up.operation._id);
    const ready = await waitOp((o) => o._id === up.operation._id && !BUSY_STATES.includes(o.status));
    expect(ready.status, j(ready)).toBe(ST.userSelection);
    const data = await api('GET', 'getImportFileData', undefined, A);
    const started = await api('POST', 'startImport', { input: { users: { all: true }, channels: { all: true } } }, A);
    expect(started.success, j(started)).toBe(true);
    const done = await waitOp((o) => o._id === up.operation._id && !BUSY_STATES.includes(o.status));
    expect(done.status, j(done)).toBe(ST.done);
    return { data, done };
  }

  const FILES = {
    ...EXAMPLE,
    'general/2023-11-15.json': j([
      {
        type: 'message',
        subtype: 'thread_broadcast',
        ts: '1700086400.000100',
        user: 'U0BOB0002',
        thread_ts: '1700000100.000200',
        text: 'Também no canal',
        reactions: [
          { name: '+1::skin-tone-3', users: ['U0ALICE01'] },
          { name: '+1', users: ['U0BOB0002'] },
        ],
      },
      { type: 'message', subtype: 'bot_message', ts: '1700086500.000100', bot_id: 'B5', username: 'Alertas', text: 'CPU alta', bot_profile: { name: 'Alertas' } },
      { type: 'message', ts: '1700086600.000100', user: 'U0ALICE01', text: 'fixada <#C024BE92M>', pinned_to: ['C024BE91L'] },
      { type: 'message', subtype: 'pinned_item', ts: '1700086700.000100', user: 'U0ALICE01', text: 'pinned a message' },
    ]),
  };

  const roomOf = async (importId: string) => (await pool.query(`SELECT r.* FROM import_map m JOIN rooms r ON r.id = m.target_id WHERE m.kind = 'room' AND m.import_id = $1`, [importId])).rows[0];
  const messageOf = async (importId: string) =>
    (await pool.query(`SELECT g.* FROM import_map m JOIN messages g ON g.id = m.target_id WHERE m.kind = 'message' AND m.import_id = $1`, [importId])).rows[0];

  it('importa a exportação de exemplo e reimporta sem duplicar', async () => {
    const { data, done } = await importZip(FILES);
    expect(data.users.map((u: any) => u.username).sort()).toEqual(['Alertas', 'alice', 'bob', 'deploybot', 'slackbot']);
    expect(data.users.find((u: any) => u.username === 'deploybot').is_bot).toBe(true);
    expect(data.channels.map((c: any) => c.name)).toEqual(['general', 'random', 'Mensagens diretas']);
    expect(data.message_count).toBe(10);
    expect(done.warnings).toEqual(['Mensagens de tipos que não são importados foram ignoradas: pinned_item (1).']);
    expect(done.count).toMatchObject({ users: 5, channels: 3, messages: 10, error: 0 });

    const users = (await pool.query(`SELECT username, name, email, type, active FROM users WHERE username = ANY($1) ORDER BY username`, [['Alertas', 'alice', 'bob', 'deploybot', 'slackbot']])).rows;
    expect(users).toEqual([
      { username: 'Alertas', name: 'Alertas', email: null, type: 'bot', active: true },
      { username: 'alice', name: 'Alice Doe', email: 'alice@example.com', type: 'user', active: true },
      { username: 'bob', name: 'Bob Roe', email: 'bob@example.com', type: 'user', active: true },
      { username: 'deploybot', name: 'Deploy Bot', email: null, type: 'bot', active: true },
      { username: 'slackbot', name: 'Slackbot', email: null, type: 'bot', active: true },
    ]);

    // O canal geral do Slack vai para o canal padrão daqui.
    const general = await roomOf('C024BE91L');
    expect(general).toMatchObject({ is_default: true, t: 'c', topic: 'Company-wide', description: 'Announcements' });
    const random = await roomOf('C024BE92M');
    expect(random).toMatchObject({ t: 'c', name: 'random', description: 'Off-topic' });
    const dm = await roomOf('D0DM00001');
    expect(dm).toMatchObject({ t: 'd', usernames: ['alice', 'bob'] });

    const parent = await messageOf('slack-C024BE91L-1700000100-000200');
    expect(parent.msg).toBe('Hey @bob, @here see #random and [the docs](https://example.com) & *ship it*');
    expect(parent.mentions.map((x: any) => x.username).sort()).toEqual(['bob', 'here']);
    expect(parent.channels).toEqual([{ _id: random.id, name: 'random' }]);
    expect(parent.reactions).toEqual({ ':+1:': { usernames: ['bob', 'alice'] } });
    expect(parent.created_at).toBe('2023-11-14T22:15:00.000Z');
    expect(parent.edited_at).toBe('2023-11-14T22:15:50.000Z');
    expect(parent.tcount).toBe(2);

    const reply = await messageOf('slack-C024BE91L-1700000200-000300');
    expect(reply).toMatchObject({ msg: 'Here is the spec', tmid: parent.id });
    expect(reply.attachments).toEqual([expect.objectContaining({ title: 'spec.pdf', pendingFileId: 'F0SPEC0001' })]);
    const pending = (await pool.query('SELECT name, type, size, url, status FROM import_pending_files WHERE message_id = $1', [reply.id])).rows;
    expect(pending).toEqual([
      { name: 'spec.pdf', type: 'application/pdf', size: 48213, url: 'https://files.slack.com/files-pri/T0TEAM/F0SPEC0001/download/spec.pdf?t=xoxe-EXAMPLE', status: 'pending' },
    ]);

    const broadcast = await messageOf('slack-C024BE91L-1700086400-000100');
    expect(broadcast).toMatchObject({ tmid: parent.id, extra: { tshow: true } });
    expect(broadcast.reactions).toEqual({ ':+1:': { usernames: ['alice', 'bob'] } });

    const bot = await messageOf('slack-C024BE91L-1700000300-000400');
    expect(bot).toMatchObject({ username: 'deploybot', msg: 'Deploy finished :slight_smile:', emoji: ':rocket:', alias: null });
    expect(bot.attachments).toEqual([{ title: 'Build #42', title_link: 'https://ci.example.com/42', text: 'All 128 tests passed & deployed', color: 'good' }]);
    expect(await messageOf('slack-C024BE91L-1700086500-000100')).toMatchObject({ username: 'Alertas', alias: 'Alertas', msg: 'CPU alta' });
    expect(await messageOf('slack-C024BE91L-1700086600-000100')).toMatchObject({ msg: 'fixada #random', pinned: true });
    expect(await messageOf('slack-C024BE91L-1700000000-000100')).toMatchObject({ t: 'uj', username: 'bob' });
    expect(await messageOf('slack-C024BE91L-1700000400-000500')).toMatchObject({ msg: '_is out for lunch_' });
    expect(await messageOf('slack-C024BE92M-1700000050-000010')).toMatchObject({ t: 'room_changed_topic', msg: 'Water-cooler chat', room_id: random.id });
    expect(await messageOf('slack-D0DM00001-1700000500-000600')).toMatchObject({ msg: 'Lunch at 1?', username: 'alice', room_id: dm.id });

    const count = async () => Number((await pool.query('SELECT count(*) FROM messages WHERE room_id = ANY($1)', [[general.id, random.id, dm.id]])).rows[0].count);
    const before = await count();
    const imported = async () => Number((await pool.query(`SELECT count(*) FROM import_map m JOIN messages g ON g.id = m.target_id WHERE m.kind = 'message'`)).rows[0].count);
    expect(await imported()).toBe(10);

    // A mesma exportação de novo: tudo é atualizado, nada duplicado.
    const again = await importZip(FILES);
    expect(again.data.users.every((u: any) => u.is_email_taken)).toBe(true);
    expect(again.data.channels.filter((c: any) => !c.is_direct).every((c: any) => c.exists)).toBe(true);
    expect(again.done.count.error).toBe(0);
    expect(await count()).toBe(before);
    expect(await imported()).toBe(10);
    expect(Number((await pool.query('SELECT count(*) FROM import_pending_files WHERE message_id = $1', [reply.id])).rows[0].count)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) FROM users WHERE username ILIKE 'alice%' OR username ILIKE 'slackbot%'`)).rows[0].count)).toBe(2);
  });

  const userOf = async (importId: string) => (await pool.query(`SELECT u.* FROM import_map m JOIN users u ON u.id = m.target_id WHERE m.kind = 'user' AND m.import_id = $1`, [importId])).rows[0];
  const botExport = (rid: string, folder: string, ts: string, botProfile: Record<string, unknown>) => ({
    'users.json': j([{ id: 'U0CARLA01', name: 'carla', profile: { email: 'carla@example.com', real_name: 'Carla' } }]),
    'channels.json': j([{ id: rid, name: folder, members: ['U0CARLA01'], created: 1700000000 }]),
    [`${folder}/2023-11-14.json`]: j([{ type: 'message', subtype: 'bot_message', ts, bot_id: botProfile.id, text: 'Ticket ABC-1 closed', bot_profile: botProfile }]),
  });

  it('integração apagada no Slack com o nome de uma conta daqui não desativa essa conta', async () => {
    const created = await api('POST', 'users.create', { username: 'jira', name: 'Jira Local', email: 'jira@empresa.local', password: 'senha-forte-1' }, A);
    expect(created.success, j(created)).toBe(true);
    const { data } = await importZip(botExport('C0ENG0001', 'eng', '1700000000.000100', { id: 'B9', name: 'jira', deleted: true }));
    expect(data.users.find((u: any) => u.user_id === 'slack-bot:B9')).toMatchObject({ is_bot: true, is_deleted: false });
    const local = (await pool.query(`SELECT active FROM users WHERE id = $1`, [created.user._id])).rows[0];
    expect(local.active).toBe(true);
  });

  it('aviso com metade de um emoji não derruba a leitura (o jsonb dos avisos recusava)', async () => {
    const { done } = await importZip({
      'users.json': j([{ id: 'U0DANI001', name: 'dani', profile: { email: 'dani@example.com' } }]),
      'channels.json': j([{ id: 'C0EMO0001', name: 'emoji', members: ['U0DANI001'] }]),
      'emoji/2023-11-14.json': j([
        { type: 'message', subtype: 'channel_join', ts: 'a' + '😀'.repeat(45) },
        { type: 'message', ts: '1700000000.000300', user: 'U0DANI001', text: 'oi' },
      ]),
    });
    expect(done.warnings).toEqual([`Mensagem ignorada em "emoji/2023-11-14" (ts a${'😀'.repeat(39)}): "channel_join" sem usuário.`]);
  });

  it('reimportar uma integração que foi apagada no Slack não desativa a conta dela aqui', async () => {
    await importZip(botExport('C0CI00001', 'ci', '1700000000.000200', { id: 'B8', name: 'ci-wescc' }));
    const bot = await userOf('slack-bot:B8');
    expect(bot).toMatchObject({ type: 'bot', active: true });
    // A mesma integração, removida no Slack depois da primeira exportação.
    await importZip(botExport('C0CI00001', 'ci', '1700000000.000200', { id: 'B8', name: 'ci-wescc', deleted: true }));
    expect((await userOf('slack-bot:B8')).id).toBe(bot.id);
    expect((await pool.query('SELECT active FROM users WHERE id = $1', [bot.id])).rows[0].active).toBe(true);
  });
});
