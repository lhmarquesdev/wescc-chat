import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { pool } from '../src/db/pool';
import { addUsersLimits } from '../src/importer/api';
import { dispositionFileName } from '../src/importer/download';
import { operationDir, plainMentions, recoverInterrupted, uploadLimits } from '../src/importer/operations';
import { BUSY_STATES, PREPARING_STATES } from '../src/importer/types';
import { verifyPassword } from '../src/lib/password';
import { bus } from '../src/realtime/bus';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Importador de teste: o arquivo enviado é um JSON que diz o que ler, quantos avisos dar e se deve falhar ou esperar.
// Os importadores de verdade continuam disponíveis.
vi.mock('../src/importer/registry', async (importOriginal) => {
  const real: any = await importOriginal();
  const { ImportError } = await import('../src/importer/types');
  const prepare = async (ctx: any) => {
    const entries = (await ctx.source.list()).filter((e: any) => !e.isDirectory);
    const spec = JSON.parse(String(await ctx.source.read(entries[0])));
    await ctx.setStep('importer_preparing_users');
    for (const u of spec.users ?? []) await ctx.user(u);
    await ctx.setStep('importer_preparing_channels');
    for (const c of spec.channels ?? []) await ctx.channel(c);
    await ctx.setStep('importer_preparing_messages');
    await ctx.setMessagesStatus('geral/2024-01-01');
    for (const m of spec.messages ?? []) await ctx.message(m);
    for (const c of spec.contacts ?? []) await ctx.contact(c);
    for (let i = 0; i < (spec.warnings ?? 0); i++) ctx.warn(`Aviso ${i + 1}`);
    for (const w of spec.warnTexts ?? []) ctx.warn(w);
    ctx.progress(50);
    if (spec.fail === 'import') throw new ImportError('O arquivo de teste está com defeito.');
    if (spec.fail === 'other') throw new Error('falha inesperada');
    while (spec.hold && !ctx.cancelled()) await new Promise((r) => setTimeout(r, 20));
    ctx.progress(100);
  };
  const base = { name: 'Teste', label: 'Arquivo de teste', description: 'Só para os testes.', visible: false, prepare };
  const extra = [
    { ...base, key: 'test', accept: '.json', sourceKind: 'file' },
    { ...base, key: 'test-dir', name: 'Teste (pasta)', accept: '.zip', sourceKind: 'zip-or-dir' },
  ];
  return {
    importers: real.importers,
    getImporter: (k: string) => extra.find((i) => i.key === k) ?? real.getImporter(k),
    importerName: (k: string) => extra.find((i) => i.key === k)?.name ?? real.importerName(k),
  };
});

// Conversão de teste (quando ativada), para casos que o conversor real não produz sob encomenda (erro, falha, demora).
const conv = vi.hoisted(() => ({ fake: null as null | ((o: any) => Promise<any>) }));
vi.mock('../src/importer/converter', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, runConversion: (o: any) => (conv.fake ? conv.fake(o) : real.runConversion(o)) };
});

let A: Auth;
let U: Auth;
let tmp = '';
let port = 0;

const json = (v: unknown) => JSON.stringify(v);
const opRows = async (id: string) => (await pool.query('SELECT data_type, import_id, data FROM import_records WHERE operation_id = $1 ORDER BY id', [id])).rows;

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

async function upload(key: string | null, name: string, data: Buffer | string, opts: { auth?: Auth; fileFirst?: boolean; type?: string } = {}) {
  const fd = new FormData();
  const file = new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: opts.type ?? 'application/json' });
  if (key !== null && !opts.fileFirst) fd.append('importerKey', key);
  fd.append('file', file, name);
  if (key !== null && opts.fileFirst) fd.append('importerKey', key);
  return api('POST', 'uploadImportFile', fd, opts.auth ?? A);
}

const current = async () => (await api('GET', 'getCurrentImportOperation', undefined, A)).operation;

async function waitOp(pred: (op: any) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const op = await current();
    if (op && pred(op)) return op;
    if (Date.now() > end) throw new Error(`a operação não chegou ao estado esperado: ${json(op)}`);
    await sleep(40);
  }
}

const settled = (op: any) => !BUSY_STATES.includes(op.status) && op.status !== 'importer_new';

async function reset() {
  const op = await current();
  if (op?.valid && BUSY_STATES.includes(op.status)) {
    await api('POST', 'import.cancel', {}, A);
    await waitOp((o) => !BUSY_STATES.includes(o.status));
  }
  conv.fake = null;
  expect((await api('POST', 'import.clear', {}, A)).success).toBe(true);
}

async function apiOperation(users: unknown[]) {
  const created = await api('POST', 'import.new', {}, A);
  expect(created.success).toBe(true);
  const r = await api('POST', 'import.addUsers', { users }, A);
  expect(r.success).toBe(true);
  return r.operation;
}

beforeAll(async () => {
  port = ((await startServer()).server.address() as any).port;
  A = await admin();
  U = await newUser(A);
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wescc-import-api-'));
});
afterAll(async () => {
  const ops = await pool.query('SELECT id FROM import_operations').catch(() => ({ rows: [] as { id: string }[] }));
  for (const r of ops.rows) await fs.promises.rm(operationDir(r.id), { recursive: true, force: true });
  await fs.promises.rm(tmp, { recursive: true, force: true });
  await stopServer();
});
beforeEach(reset);

describe('permissões', () => {
  it('exige login e a permissão run-import (ou view-import-operations só para o histórico)', async () => {
    const routes: [string, string][] = [
      ['GET', 'importers.list'],
      ['GET', 'getCurrentImportOperation'],
      ['GET', 'getImportFileData'],
      ['GET', 'getLatestImportOperations'],
      ['GET', 'import.errors'],
      ['POST', 'import.new'],
      ['POST', 'import.addUsers'],
      ['POST', 'startImport'],
      ['POST', 'import.cancel'],
      ['POST', 'downloadPendingFiles'],
    ];
    for (const [method, route] of routes) {
      expect((await api(method, route, method === 'POST' ? {} : undefined)).status, route).toBe(401);
      expect((await api(method, route, method === 'POST' ? {} : undefined, U)).status, route).toBe(403);
    }
    const fd = new FormData();
    fd.append('importerKey', 'test');
    fd.append('file', new Blob(['{}']), 'dados.json');
    expect((await api('POST', 'uploadImportFile', fd, U)).status).toBe(403);

    // Quem só vê o histórico não importa nada.
    const viewer = await newUser(A);
    expect((await api('POST', 'users.update', { userId: viewer.userId, data: { roles: ['user', 'auditor'] } }, A)).success).toBe(true);
    await api('POST', 'permissions.update', { permissions: [{ _id: 'view-import-operations', roles: ['admin', 'auditor'] }] }, A);
    try {
      expect((await api('GET', 'getLatestImportOperations', undefined, viewer)).status).toBe(200);
      expect((await api('POST', 'import.new', {}, viewer)).status).toBe(403);
    } finally {
      await api('POST', 'permissions.update', { permissions: [{ _id: 'view-import-operations', roles: ['admin'] }] }, A);
    }
  });
});

describe('envio e leitura do arquivo', () => {
  const spec = {
    users: [
      { importIds: ['u1'], emails: ['ADMIN@localhost'], username: 'chefe', name: 'Chefe' },
      { importIds: ['u2'], emails: ['nova@ex.com'], username: 'nova', deleted: true },
      { importIds: ['b1'], emails: [], username: 'Admin', type: 'bot' },
      { importIds: ['u3'], emails: ['outra@ex.com'], username: 'outra' },
    ],
    channels: [
      { importIds: ['c1'], t: 'c', name: 'Geral', users: ['u1', 'u2'] },
      { importIds: ['c2'], t: 'p', name: 'geral', users: ['u1'], archived: true },
      { importIds: ['d1'], t: 'd', users: ['u1', 'u2'] },
      { importIds: ['d2'], t: 'd', users: ['u2', 'b1'] },
    ],
    messages: [
      { importId: 'm1', rid: 'c1', u: 'u1', msg: 'oi' },
      { importId: 'm2', rid: 'c1', u: 'u2', msg: 'olá' },
      { importId: 'm3', rid: 'd1', u: 'u1', msg: 'tudo bem?' },
    ],
    contacts: [{ importIds: ['k1'], name: 'Cliente', emails: ['cliente@ex.com'], phones: ['+5511999990000'] }],
    warnings: 3,
  };

  it('guarda o arquivo, lê em segundo plano e monta a prévia sem mudar a situação', async () => {
    await pool.query(`INSERT INTO import_map (kind, import_id, target_id) VALUES ('user', 'u3', $1) ON CONFLICT DO NOTHING`, [A.userId]);
    const r = await upload('test', 'meus dados (1).json', json(spec));
    expect(r.success).toBe(true);
    expect(r.operation).toMatchObject({ importerKey: 'test', type: 'Teste', source: 'upload', file: 'meus dados (1).json', valid: true, user: A.userId });
    const id = r.operation._id;
    const op = await waitOp((o) => settled(o));
    expect(op.status).toBe('importer_user_selection');
    expect(op.count).toMatchObject({ users: 4, channels: 4, messages: 3, contacts: 1, total: 12, completed: 0 });
    expect(op.warnings).toEqual(['Aviso 1', 'Aviso 2', 'Aviso 3']);
    expect(op.messagesstatus).toBeNull();
    // Nome no disco só com caracteres seguros, dentro da pasta da operação.
    const row = (await pool.query('SELECT file_path, file_size FROM import_operations WHERE id = $1', [id])).rows[0];
    expect(path.dirname(row.file_path)).toBe(operationDir(id));
    expect(path.basename(row.file_path)).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    expect(row.file_size).toBe(Buffer.byteLength(json(spec)));
    expect((await opRows(id)).map((x) => x.data_type)).toEqual(['user', 'user', 'user', 'user', 'channel', 'channel', 'channel', 'channel', 'message', 'message', 'message', 'contact']);

    const data = await api('GET', 'getImportFileData', undefined, A);
    expect(data.waiting).toBeUndefined();
    expect(data.name).toBe('Teste');
    expect(data.message_count).toBe(3);
    expect(data.operation._id).toBe(id);
    const users = Object.fromEntries(data.users.map((u: any) => [u.user_id, u]));
    expect(users.u1).toMatchObject({ username: 'chefe', name: 'Chefe', email: 'ADMIN@localhost', is_email_taken: true, is_deleted: false, is_bot: false, do_import: true });
    expect(users.u2).toMatchObject({ is_email_taken: false, is_deleted: true });
    // Id já importado antes conta como existente. Um bot com o nome de uma pessoa ("Admin") é outra conta.
    expect(users.b1).toMatchObject({ is_email_taken: false, is_bot: true, email: '' });
    expect(users.u3.is_email_taken).toBe(true);
    expect(data.channels).toEqual([
      { channel_id: 'c1', name: 'Geral', is_archived: false, is_private: false, is_direct: false, members: 2, exists: true, do_import: true },
      { channel_id: 'c2', name: 'geral', is_archived: true, is_private: true, is_direct: false, members: 1, exists: false, do_import: true },
      { channel_id: '__directMessages__', name: 'Mensagens diretas', is_archived: false, is_private: true, is_direct: true, members: 2, exists: false, do_import: true },
    ]);
    expect(data.contacts).toEqual([{ id: 'k1', name: 'Cliente', emails: ['cliente@ex.com'], phones: ['+5511999990000'], do_import: true }]);
    expect((await current()).status).toBe('importer_user_selection');
    const audit = await pool.query(`SELECT data FROM audit_log WHERE action = 'import.uploaded' AND target->>'operationId' = $1`, [id]);
    expect(audit.rows[0].data).toMatchObject({ importer: 'test', source: 'upload', file: 'meus dados (1).json' });
    await pool.query(`DELETE FROM import_map WHERE import_id = 'u3'`);
  });

  it('a prévia acha as salas e contas existentes como a conversão acha', async () => {
    expect((await api('POST', 'channels.create', { name: 'projeto-novo' }, A)).success).toBe(true);
    await upload(
      'test',
      'dados.json',
      json({
        users: [{ importIds: ['t1'], emails: ['', ' Admin@Localhost '], username: '@novo.usuario' }],
        channels: [
          { importIds: ['t2'], t: 'c', name: 'Projeto Novo', users: [] },
          { importIds: ['t3'], t: 'p', name: 'Projeto Novo', users: [] },
        ],
      }),
    );
    await waitOp(settled);
    const data = await api('GET', 'getImportFileData', undefined, A);
    expect(data.users[0].is_email_taken).toBe(true);
    // "Projeto Novo" vira projeto-novo na conversão; só o canal público se junta a ele.
    expect(data.channels.map((c: any) => [c.channel_id, c.exists])).toEqual([
      ['t2', true],
      ['t3', false],
    ]);
  });

  it('aceita o arquivo antes do campo importerKey', async () => {
    const r = await upload('test', 'dados.json', json({ users: [spec.users[1]] }), { fileFirst: true });
    expect(r.success).toBe(true);
    const op = await waitOp(settled);
    expect(op).toMatchObject({ _id: r.operation._id, status: 'importer_user_selection', count: { users: 1, total: 1 } });
  });

  it('recusa importador desconhecido, tipo errado e arquivo grande demais', async () => {
    const before = (await api('POST', 'import.new', {}, A)).operation._id;
    const unknown = await upload('nada', 'dados.json', '{}');
    expect(unknown).toMatchObject({ status: 400, errorType: 'error-importer-not-defined' });
    const noKey = await upload(null, 'dados.json', '{}');
    expect(noKey).toMatchObject({ status: 400, errorType: 'error-importer-not-defined' });
    expect((await current())._id).toBe(before);

    const wrong = await upload('test', 'planilha.csv', 'a,b\n', { type: 'text/csv' });
    expect(wrong).toMatchObject({ status: 400, errorType: 'error-invalid-file-type' });
    expect(wrong.error).toContain('.json');
    let op = await current();
    expect(op).toMatchObject({ status: 'importer_import_failed', file: 'planilha.csv' });
    expect(op.error).toBe(wrong.error);
    expect(fs.existsSync(operationDir(op._id))).toBe(false);

    await api('POST', 'settings', { settings: { Import_MaxFileSize: 100 } }, A);
    try {
      const big = await upload('test', 'grande.json', json({ users: Array.from({ length: 20 }, (_, i) => ({ importIds: [`g${i}`], emails: [] })) }));
      expect(big).toMatchObject({ status: 413, errorType: 'error-file-too-large' });
      expect(big.error).toContain('100 bytes');
      op = await current();
      expect(op.status).toBe('importer_import_failed');
      expect(fs.existsSync(operationDir(op._id))).toBe(false);
    } finally {
      await api('POST', 'settings', { settings: { Import_MaxFileSize: 1073741824 } }, A);
    }
  });

  it('falha com mensagem clara quando o arquivo está vazio ou com defeito', async () => {
    await upload('test', 'vazio.json', json({ warnings: 2 }));
    let op = await waitOp(settled);
    expect(op.status).toBe('importer_import_failed');
    expect(op.error).toBe('Nenhum dado válido foi encontrado no arquivo. Avisos: Aviso 1 | Aviso 2');
    // A prévia não reabre uma operação que falhou.
    expect(await api('GET', 'getImportFileData', undefined, A)).toMatchObject({ success: true, operation: { status: 'importer_import_failed' } });
    expect((await current()).status).toBe('importer_import_failed');

    await upload('test', 'ruim.json', json({ users: spec.users, fail: 'import' }));
    op = await waitOp(settled);
    expect(op).toMatchObject({ status: 'importer_import_failed', error: 'O arquivo de teste está com defeito.' });
    expect(await opRows(op._id)).toHaveLength(0);

    await upload('test', 'erro.json', json({ users: spec.users, fail: 'other' }));
    op = await waitOp(settled);
    expect(op).toMatchObject({ status: 'importer_import_failed', error: 'Não foi possível ler o arquivo: falha inesperada' });

    await upload('test', 'avisos.json', json({ users: [spec.users[0]], warnings: 250 }));
    op = await waitOp(settled);
    expect(op.status).toBe('importer_user_selection');
    expect(op.warnings).toHaveLength(201);
    expect(op.warnings.at(-1)).toBe('e mais 50 avisos');
  });

  it('guarda texto que o PostgreSQL recusaria em jsonb', async () => {
    await upload('test', 'texto.json', json({ messages: [{ rid: 'c1', u: 'u1', msg: 'a\u0000b\ud800c' }] }));
    const op = await waitOp(settled);
    expect(op.status).toBe('importer_user_selection');
    expect((await opRows(op._id))[0].data.msg).toBe('ab�c');
  });
});

describe('concorrência e cancelamento', () => {
  it('recusa outra importação enquanto uma está em andamento e cancela a leitura', async () => {
    const r = await upload('test', 'longo.json', json({ users: [{ importIds: ['x1'], emails: ['x1@ex.com'] }], hold: true }));
    expect(r.success).toBe(true);
    await waitOp((o) => PREPARING_STATES.includes(o.status));
    expect(await api('POST', 'import.new', {}, A)).toMatchObject({ status: 409, errorType: 'error-import-running' });
    expect(await upload('test', 'outro.json', '{}')).toMatchObject({ status: 409, errorType: 'error-import-running' });
    expect(await api('POST', 'import.clear', {}, A)).toMatchObject({ status: 409 });
    expect(await api('POST', 'downloadPendingFiles', {}, A)).toMatchObject({ status: 409 });
    expect((await api('GET', 'getImportFileData', undefined, A)).waiting).toBe(true);
    expect((await api('POST', 'startImport', { input: { users: { all: true } } }, A)).errorType).toBe('error-invalid-operation-status');

    const c = await api('POST', 'import.cancel', {}, A);
    expect(c.success).toBe(true);
    const op = await waitOp((o) => o._id === r.operation._id && settled(o));
    expect(op.status).toBe('importer_import_cancelled');
    expect(op.finishedAt).toBeTruthy();
    expect(await opRows(op._id)).toHaveLength(0);
    expect((await api('POST', 'import.cancel', {}, A)).errorType).toBe('error-invalid-operation-status');
    expect((await api('POST', 'import.new', {}, A)).success).toBe(true);
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'import.cancelled' AND target->>'operationId' = $1`, [op._id]);
    expect(audit.rowCount).toBe(1);
  });

  it('cancela na hora uma importação parada (sem trabalho rodando aqui)', async () => {
    const op = await apiOperation([{ importIds: ['a1'], emails: ['a1@ex.com'] }]);
    expect(op.status).toBe('importer_user_selection');
    const c = await api('POST', 'import.cancel', {}, A);
    expect(c.operation.status).toBe('importer_import_cancelled');
    expect(await opRows(op._id)).toHaveLength(0);

    // Situação de importação sem trabalho nesta instância (por exemplo, rodando em outra): cancela na hora.
    const other = await apiOperation([{ importIds: ['a2'], emails: ['a2@ex.com'] }]);
    await pool.query(`UPDATE import_operations SET status = 'importer_importing_messages' WHERE id = $1`, [other._id]);
    expect(await api('POST', 'import.new', {}, A)).toMatchObject({ status: 409 });
    expect((await api('POST', 'import.cancel', {}, A)).operation.status).toBe('importer_import_cancelled');
  });
});

describe('importação com o conversor de teste', () => {
  const users = [
    { importIds: ['p1'], emails: ['p1@ex.com'], username: 'p1' },
    { importIds: ['p2'], emails: ['p2@ex.com'], username: 'falha' },
    { importIds: ['p3'], emails: ['p3@ex.com'], username: 'p3', password: 'senha-secreta-1' },
  ];

  it('importa, conta cada registro uma vez e guarda só os que falharam', async () => {
    conv.fake = async (o) => {
      const { iterateStaged, markRecordError, markRecordsSkipped } = await import('../src/importer/staging');
      await o.sink.step('importer_importing_users');
      for await (const batch of iterateStaged<any>(o.operationId, 'user')) {
        for (const r of batch) {
          if (r.data.username === 'falha') {
            await markRecordError(r.id, 'Usuário inválido para o teste.');
            o.sink.inc({ error: 1 });
          } else if (!o.selection.users?.list?.includes(r.importId)) {
            await markRecordsSkipped([r.id]);
            o.sink.inc({ skipped: 1 });
          } else o.sink.inc({ completed: 1 });
        }
      }
      await o.sink.step('importer_finishing');
      const zero = { inserted: 0, updated: 0, failed: 0, skipped: 0 };
      return { users: { ...zero, inserted: 1, failed: 1, skipped: 1 }, channels: zero, messages: zero, contacts: { inserted: 0, failed: 0, skipped: 0 }, roomIds: [], newUserIds: ['x'] };
    };
    const op = await apiOperation(users);
    const r = await api('POST', 'startImport', { input: { users: { list: ['p1', 'p2'] } }, options: { sendPasswordEmails: true } }, A);
    expect(r.operation).toMatchObject({ status: 'importer_importing_started', options: { sendPasswordEmails: true } });
    expect(r.operation.startedAt).toBeTruthy();
    const done = await waitOp((o) => settled(o));
    expect(done).toMatchObject({ status: 'importer_done', count: { total: 3, completed: 1, error: 1, skipped: 1 } });
    expect(done.finishedAt).toBeTruthy();
    // Sobra só o registro com erro, sem a senha.
    const rows = await opRows(op._id);
    expect(rows.map((x) => x.import_id)).toEqual(['p2']);
    const errors = await api('GET', 'import.errors', undefined, A);
    expect(errors).toMatchObject({ total: 1, errors: [{ type: 'user', importId: 'p2', label: 'falha', messages: ['Usuário inválido para o teste.'] }] });
    const audit = await pool.query(`SELECT action, data FROM audit_log WHERE target->>'operationId' = $1 ORDER BY created_at`, [op._id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['import.started', 'import.finished']);
    expect(audit.rows[1].data).toMatchObject({ status: 'importer_done', newUsers: 1, rooms: 0 });
    // Não dá para começar de novo a mesma operação.
    expect((await api('POST', 'startImport', { input: { users: { all: true } } }, A)).errorType).toBe('error-invalid-operation-status');
  });

  it('cancela durante a importação e registra a falha do conversor', async () => {
    conv.fake = async (o) => {
      await o.sink.step('importer_importing_messages');
      while (!o.sink.cancelled()) {
        o.sink.inc({ completed: 1 });
        await sleep(10);
      }
      return { users: {}, channels: {}, messages: {}, contacts: {}, roomIds: [], newUserIds: [] };
    };
    await apiOperation(users);
    await api('POST', 'startImport', { input: { users: { all: true } } }, A);
    await waitOp((o) => o.status === 'importer_importing_messages' && o.count.completed > 0);
    expect((await api('POST', 'import.cancel', {}, A)).success).toBe(true);
    const op = await waitOp(settled);
    expect(op.status).toBe('importer_import_cancelled');

    conv.fake = async () => {
      throw new Error('Banco fora do ar.');
    };
    await apiOperation(users);
    const started = await api('POST', 'startImport', { input: { users: { all: true } } }, A);
    const failed = await waitOp(settled);
    expect(failed).toMatchObject({ status: 'importer_import_failed', error: 'Banco fora do ar.' });
    const audit = await pool.query(`SELECT data FROM audit_log WHERE action = 'import.failed' AND target->>'operationId' = $1`, [started.operation._id]);
    expect(audit.rows[0].data.error).toBe('Banco fora do ar.');
  });
});

describe('recuperação depois de uma queda', () => {
  it('marca como falha só o que estava rodando em uma instância que parou', async () => {
    await pool.query(`INSERT INTO instances (id, last_seen) VALUES ('viva', now()), ('velha', now() - interval '5 minutes') ON CONFLICT (id) DO UPDATE SET last_seen = EXCLUDED.last_seen`);
    const ins = (id: string, status: string, instance: string | null) =>
      pool.query(`INSERT INTO import_operations (id, importer_key, status, valid, instance_id) VALUES ($1, 'csv', $2, false, $3)`, [id, status, instance]);
    await ins('rec-sumiu', 'importer_importing_messages', 'sumiu');
    await ins('rec-velha', 'importer_preparing_users', 'velha');
    await ins('rec-sem', 'importer_uploading', null);
    await ins('rec-viva', 'importer_importing_users', 'viva');
    await ins('rec-minha', 'importer_importing_users', bus.origin);
    await ins('rec-pronta', 'importer_user_selection', 'sumiu');
    try {
      expect(await recoverInterrupted()).toBe(3);
      const rows = Object.fromEntries((await pool.query(`SELECT id, status, error, finished_at FROM import_operations WHERE id LIKE 'rec-%'`)).rows.map((r) => [r.id, r]));
      for (const id of ['rec-sumiu', 'rec-velha', 'rec-sem']) {
        expect(rows[id].status).toBe('importer_import_failed');
        expect(rows[id].error).toContain('servidor reiniciou');
        expect(rows[id].finished_at).toBeTruthy();
      }
      expect(rows['rec-viva'].status).toBe('importer_importing_users');
      expect(rows['rec-minha'].status).toBe('importer_importing_users');
      expect(rows['rec-pronta'].status).toBe('importer_user_selection');
    } finally {
      await pool.query(`DELETE FROM import_operations WHERE id LIKE 'rec-%'`);
      await pool.query(`DELETE FROM instances WHERE id IN ('viva', 'velha')`);
    }
  });
});

describe('import.errors', () => {
  it('lista os registros com erro, com rótulo, filtro por tipo e paginação', async () => {
    const op = await apiOperation([
      { importIds: ['e1'], emails: ['e1@ex.com'], username: 'ana' },
      { importIds: ['e2'], emails: ['e2@ex.com'], name: 'Beto Lima' },
    ]);
    await pool.query(`UPDATE import_records SET errors = '["E-mail já usado."]' WHERE operation_id = $1 AND import_id = 'e2'`, [op._id]);
    await pool.query(
      `INSERT INTO import_records (operation_id, data_type, import_id, data, errors) VALUES ($1, 'message', 'm9', $2, '["Autor não encontrado: U9", "outro"]'), ($1, 'channel', 'd9', '{"t":"d","users":[]}', '["Mensagem direta com usuário não importado: U9"]')`,
      [op._id, json({ rid: 'c1', u: 'U9', msg: `oi \u0001@U1|ana\u0002, veja \u0001#C1\u0002 ${'x'.repeat(100)}` })],
    );
    const all = await api('GET', 'import.errors', undefined, A);
    expect(all.total).toBe(3);
    expect(all.errors.map((e: any) => [e.type, e.importId, e.label])).toEqual([
      ['user', 'e2', 'Beto Lima'],
      ['message', 'm9', `oi @ana, veja #C1 ${'x'.repeat(62)}…`],
      ['channel', 'd9', 'Mensagem direta'],
    ]);
    expect(all.errors[1].messages).toEqual(['Autor não encontrado: U9', 'outro']);
    expect((await api('GET', 'import.errors', { type: 'user' }, A)).total).toBe(1);
    const page = await api('GET', 'import.errors', { offset: '1', count: '1', operationId: op._id }, A);
    expect(page).toMatchObject({ total: 3, errors: [{ importId: 'm9' }] });
    expect((await api('GET', 'import.errors', { type: 'sala' }, A)).status).toBe(400);
    expect((await api('GET', 'import.errors', { operationId: 'nenhuma' }, A))).toMatchObject({ total: 0, errors: [] });
  });
});

describe('importação pela API', () => {
  it('import.new, import.addUsers com validação estrita e import.status', async () => {
    const created = await api('POST', 'import.new', {}, A);
    expect(created.operation).toMatchObject({ importerKey: 'api', type: 'API', status: 'importer_new', source: 'none', valid: true });
    expect(await api('GET', 'import.status', undefined, A)).toMatchObject({ state: 'new', operation: { _id: created.operation._id } });

    const bad = async (users: unknown) => api('POST', 'import.addUsers', { users }, A);
    const extraKey = await bad([{ importIds: ['x'], emails: ['x@ex.com'], services: { password: 'x' } }]);
    expect(extraKey).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
    expect(extraKey.error).toContain('services');
    expect((await api('POST', 'import.addUsers', { users: [], extra: 1 }, A)).status).toBe(400);
    expect((await bad([{ importIds: ['x'] }])).status).toBe(400);
    expect((await bad([{ importIds: ['x'], emails: [] }])).status).toBe(400);
    expect((await bad([{ importIds: ['x'], emails: [''] }])).status).toBe(400);
    expect((await bad([{ importIds: [], emails: ['x@ex.com'] }])).status).toBe(400);
    expect((await bad([{ importIds: ['x'], emails: ['x@ex.com'], type: 'admin' }])).status).toBe(400);
    expect((await bad([{ importIds: ['x'], emails: ['x@ex.com'], password: 'x'.repeat(201) }])).status).toBe(400);
    const role = await bad([{ importIds: ['x'], emails: ['x@ex.com'], roles: ['user', 'inexistente'] }]);
    expect(role).toMatchObject({ status: 400, errorType: 'error-invalid-roles' });
    expect(role.error).toContain('inexistente');
    expect((await current()).status).toBe('importer_new');

    const first = await bad([
      { importIds: ['api-1', 'legado-1'], emails: ['api1@ex.com'], username: 'api1', name: 'Api Um', roles: ['user', 'auditor'], password: 'senha-forte-1', bio: null },
      { importIds: ['api-2'], emails: ['api2@ex.com'], type: 'bot', deleted: false },
    ]);
    expect(first.operation).toMatchObject({ status: 'importer_user_selection', count: { users: 2, total: 2 } });
    const second = await bad([{ importIds: ['api-3'], emails: ['api3@ex.com'] }]);
    expect(second.operation.count).toMatchObject({ users: 3, total: 3 });
    expect(await api('GET', 'import.status', undefined, A)).toMatchObject({ state: 'ready' });
    const rows = await opRows(created.operation._id);
    expect(rows.map((r) => r.import_id)).toEqual(['api-1', 'api-2', 'api-3']);
    expect(rows[0].data).toEqual({
      importIds: ['api-1', 'legado-1'],
      emails: ['api1@ex.com'],
      username: 'api1',
      name: 'Api Um',
      roles: ['user', 'auditor'],
      passwordHash: expect.stringMatching(/^scrypt\$/),
    });
    expect(rows[1].data).toEqual({ importIds: ['api-2'], emails: ['api2@ex.com'], type: 'bot', deleted: false });
    expect((await api('GET', 'getImportFileData', undefined, A)).users).toHaveLength(3);

    // Uma operação de outro tipo, ou que já terminou, não recebe usuários.
    await api('POST', 'import.cancel', {}, A);
    expect(await bad([{ importIds: ['x'], emails: ['x@ex.com'] }])).toMatchObject({ status: 400, errorType: 'error-invalid-operation-status' });
    expect(await api('GET', 'import.status', undefined, A)).toMatchObject({ state: 'canceled' });
    await api('POST', 'import.clear', {}, A);
    expect(await bad([{ importIds: ['x'], emails: ['x@ex.com'] }])).toMatchObject({ status: 400, errorType: 'error-operation-not-found' });
    expect(await api('GET', 'import.status', undefined, A)).toMatchObject({ state: 'error' });
  });

  it('import.run exige uma operação da API pronta', async () => {
    expect(await api('POST', 'import.run', {}, A)).toMatchObject({ status: 400, errorType: 'error-operation-not-found' });
    await api('POST', 'import.new', {}, A);
    expect(await api('POST', 'import.run', {}, A)).toMatchObject({ status: 400, errorType: 'error-invalid-operation-status' });
  });

  it('import.run cria os usuários com a senha informada', async () => {
    await apiOperation([
      { importIds: ['run-1'], emails: ['run1@ex.com'], username: 'run1', name: 'Run Um', password: 'senha-forte-9' },
      { importIds: ['run-2'], emails: ['run2@ex.com'], username: 'run2' },
    ]);
    const r = await api('POST', 'import.run', {}, A);
    expect(r.operation).toMatchObject({ status: 'importer_importing_started', options: { skipExistingUsers: true } });
    const op = await waitOp(settled);
    expect(op).toMatchObject({ status: 'importer_done', count: { total: 2, completed: 2, error: 0 } });
    expect(await api('GET', 'import.status', undefined, A)).toMatchObject({ state: 'done' });
    // O corpo do login traz status: 'success' (formato do Rocket.Chat), no lugar do código HTTP.
    const login = await api('POST', 'login', { user: 'run1', password: 'senha-forte-9' });
    expect(login).toMatchObject({ status: 'success', data: { me: { username: 'run1' } } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE username IN ('run1', 'run2')`)).rows[0].n).toBe(2);
  });
});

describe('progresso em tempo real', () => {
  it('chega a quem pode importar e não a um usuário comum', async () => {
    const wa = connectWs(A);
    const wu = connectWs(U);
    try {
      await Promise.all([wa.ready, wu.ready]);
      const created = await api('POST', 'import.new', {}, A);
      const ev = await wa.waitFor((e) => e.type === 'import.progress' && e.operation._id === created.operation._id);
      expect(ev.operation).toMatchObject({ importerKey: 'api', status: 'importer_new', valid: true, count: { total: 0 } });

      const r = await upload('test', 'dados.json', json({ users: [{ importIds: ['w1'], emails: [] }] }));
      const rate = await wa.waitFor((e) => e.type === 'import.progress' && e.operation._id === r.operation._id && e.operation.rate === 100);
      expect(rate.operation.count.users).toBe(1);
      await wa.waitFor((e) => e.type === 'import.progress' && e.operation._id === r.operation._id && e.operation.status === 'importer_user_selection');
      await sleep(200);
      expect(wu.events.some((e) => e.type === 'import.progress')).toBe(false);
    } finally {
      wa.close();
      wu.close();
    }
  });
});

describe('arquivo ou pasta no servidor', () => {
  let base = '';
  const saved = process.env.IMPORT_SERVER_DIR;
  beforeAll(async () => {
    base = path.join(tmp, 'liberada');
    await fs.promises.mkdir(path.join(base, 'pasta'), { recursive: true });
    await fs.promises.writeFile(path.join(base, 'dados.json'), json({ users: [{ importIds: ['s1'], emails: ['s1@ex.com'] }] }));
    await fs.promises.writeFile(path.join(base, 'pasta', 'dados.json'), json({ users: [{ importIds: ['s2'], emails: [] }, { importIds: ['s3'], emails: [] }] }));
    await fs.promises.writeFile(path.join(tmp, 'segredo.json'), json({ users: [{ importIds: ['z'], emails: [] }] }));
    await fs.promises.symlink(path.join(tmp, 'segredo.json'), path.join(base, 'atalho.json'));
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.IMPORT_SERVER_DIR;
    else process.env.IMPORT_SERVER_DIR = saved;
  });
  const fromPath = (importerKey: string, fileUrl: string) => api('POST', 'downloadPublicImportFile', { importerKey, fileUrl }, A);

  it('só funciona com IMPORT_SERVER_DIR, não sai da pasta e usa o arquivo no lugar', async () => {
    delete process.env.IMPORT_SERVER_DIR;
    expect(await fromPath('test', path.join(base, 'dados.json'))).toMatchObject({ status: 400, errorType: 'error-import-path-disabled' });
    process.env.IMPORT_SERVER_DIR = base;
    const before = (await api('POST', 'import.new', {}, A)).operation._id;
    for (const p of ['../segredo.json', path.join(tmp, 'segredo.json'), 'atalho.json', 'nao-existe.json', '/etc/passwd']) {
      expect(await fromPath('test', p), p).toMatchObject({ status: 400, errorType: 'error-import-file-missing' });
    }
    expect(await fromPath('test', 'pasta')).toMatchObject({ status: 400, errorType: 'error-invalid-file-type' });
    expect(await fromPath('nada', 'dados.json')).toMatchObject({ status: 400, errorType: 'error-importer-not-defined' });
    expect((await current())._id).toBe(before);

    const r = await fromPath('test', 'dados.json');
    expect(r.operation).toMatchObject({ source: 'path', file: await fs.promises.realpath(path.join(base, 'dados.json')) });
    let op = await waitOp(settled);
    expect(op).toMatchObject({ status: 'importer_user_selection', count: { users: 1 } });

    // Pasta inteira, para quem aceita (CSV descompactado).
    const dir = await fromPath('test-dir', 'pasta');
    expect(dir.success).toBe(true);
    op = await waitOp(settled);
    expect(op).toMatchObject({ _id: dir.operation._id, status: 'importer_user_selection', count: { users: 2 }, fileSize: null });

    // O que está no servidor nunca é apagado.
    await api('POST', 'import.clear', {}, A);
    expect(fs.existsSync(path.join(base, 'dados.json'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'pasta', 'dados.json'))).toBe(true);
  });

  it('importers.list mostra a origem "path" só com IMPORT_SERVER_DIR', async () => {
    delete process.env.IMPORT_SERVER_DIR;
    const off = await api('GET', 'importers.list', undefined, A);
    expect(off.importers.map((i: any) => i.key)).toEqual(['csv', 'slack', 'slack-users', 'omnichannel_contact']);
    expect(off.maxFileSize).toBe(1073741824);
    for (const i of off.importers) {
      expect(i.sources).toEqual(['upload', 'url']);
      expect(i.name && i.label && i.description && i.accept).toBeTruthy();
    }
    process.env.IMPORT_SERVER_DIR = base;
    const on = await api('GET', 'importers.list', undefined, A);
    expect(on.importers[0].sources).toEqual(['upload', 'url', 'path']);
  });
});

describe('arquivo em um endereço público', () => {
  let server: http.Server;
  let origin = '';
  let release: (() => void) | null = null;
  const saved = process.env.IMPORT_ALLOWED_HOSTS;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/dados.json?token=segredo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(json({ users: [{ importIds: ['h1'], emails: ['h1@ex.com'] }] }));
      } else if (req.url === '/lento.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"users": [');
        release = () => res.end(']}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    release?.();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (saved === undefined) delete process.env.IMPORT_ALLOWED_HOSTS;
    else process.env.IMPORT_ALLOWED_HOSTS = saved;
  });
  const fromUrl = (fileUrl: string) => api('POST', 'downloadPublicImportFile', { importerKey: 'test', fileUrl }, A);

  it('baixa em segundo plano de um servidor liberado e não guarda o endereço completo', async () => {
    delete process.env.IMPORT_ALLOWED_HOSTS;
    const blocked = await fromUrl(`${origin}/dados.json?token=segredo`);
    expect(blocked.success).toBe(true);
    let op = await waitOp(settled);
    expect(op.status).toBe('importer_import_failed');
    expect(op.error).toContain('IMPORT_ALLOWED_HOSTS');

    process.env.IMPORT_ALLOWED_HOSTS = new URL(origin).host;
    const r = await fromUrl(`${origin}/dados.json?token=segredo`);
    expect(r.operation).toMatchObject({ source: 'url', file: 'dados.json', status: 'importer_downloading_file' });
    op = await waitOp(settled);
    expect(op).toMatchObject({ _id: r.operation._id, status: 'importer_user_selection', count: { users: 1 }, contentType: 'application/json' });
    const row = (await pool.query('SELECT * FROM import_operations WHERE id = $1', [op._id])).rows[0];
    expect(JSON.stringify(row)).not.toContain('segredo');
    expect(fs.existsSync(row.file_path)).toBe(true);

    await fromUrl(`${origin}/sumiu.json`);
    op = await waitOp(settled);
    expect(op.status).toBe('importer_import_failed');
    expect(op.error).toContain('404');

    expect(await fromUrl(`${origin}/planilha.csv`)).toMatchObject({ status: 400, errorType: 'error-invalid-file-type' });
    expect(await fromUrl('http://')).toMatchObject({ status: 400, errorType: 'error-invalid-url' });
  });

  it('cancela um download em andamento', async () => {
    process.env.IMPORT_ALLOWED_HOSTS = new URL(origin).host;
    const r = await fromUrl(`${origin}/lento.json`);
    for (let i = 0; i < 100 && !release; i++) await sleep(20);
    expect(release).toBeTruthy();
    expect((await current()).status).toBe('importer_downloading_file');
    await api('POST', 'import.cancel', {}, A);
    const op = await waitOp(settled);
    expect(op).toMatchObject({ _id: r.operation._id, status: 'importer_import_cancelled' });
    expect(fs.existsSync(operationDir(op._id))).toBe(false);
  });
});

describe('histórico, limpeza e downloads pendentes', () => {
  it('lista as operações da mais nova para a mais antiga, com paginação', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api('POST', 'import.new', {}, A)).operation._id);
    const page = await api('GET', 'getLatestImportOperations', { count: '2' }, A);
    expect(page.operations.map((o: any) => o._id)).toEqual([ids[2], ids[1]]);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.operations[0]).toMatchObject({ valid: true, type: 'API' });
    expect(page.operations[1].valid).toBe(false);
    const next = await api('GET', 'getLatestImportOperations', { count: '2', offset: '2' }, A);
    expect(next.operations[0]._id).toBe(ids[0]);
    expect((await api('GET', 'getLatestImportOperations', { offset: '100000' }, A)).total).toBe(page.total);
    const progress = await api('GET', 'getImportProgress', undefined, A);
    expect(progress).toMatchObject({ key: 'api', name: 'API', step: 'importer_new', count: { total: 0 }, operation: { _id: ids[2] } });
  });

  it('import.clear invalida tudo e apaga os dados lidos e o arquivo guardado', async () => {
    const r = await upload('test', 'dados.json', json({ users: [{ importIds: ['l1'], emails: [] }] }));
    await waitOp(settled);
    expect(fs.existsSync(operationDir(r.operation._id))).toBe(true);
    expect((await api('POST', 'import.clear', {}, A)).success).toBe(true);
    const op = await current();
    expect(op).toMatchObject({ _id: r.operation._id, valid: false });
    expect(await opRows(op._id)).toHaveLength(0);
    expect(fs.existsSync(operationDir(op._id))).toBe(false);
    expect((await api('GET', 'getImportFileData', undefined, A)).errorType).toBe('error-operation-not-found');
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'import.cleared' AND data->'operations' ? $1`, [op._id]);
    expect(audit.rowCount).toBe(1);
  });

  it('downloads pendentes sem nada para baixar terminam na hora', async () => {
    expect(await api('GET', 'import.pending', undefined, A)).toMatchObject({ files: 0, avatars: 0 });
    const files = await api('POST', 'downloadPendingFiles', {}, A);
    expect(files).toMatchObject({ count: 0, operation: { importerKey: 'pending-files', type: 'Arquivos pendentes', status: 'importer_done' } });
    const avatars = await api('POST', 'downloadPendingAvatars', {}, A);
    expect(avatars).toMatchObject({ count: 0, operation: { importerKey: 'pending-avatars', type: 'Fotos pendentes', status: 'importer_done' } });
  });
});

describe('ciclo completo com o importador CSV', () => {
  it('envia o .zip, mostra a prévia, importa e registra no histórico', async () => {
    const zip = await zipBuffer({
      'users.csv': 'ana.csv,ana.csv@ex.com,Ana Souza\nbeto.csv,beto.csv@ex.com,Beto Lima\n',
      'channels.csv': 'projeto-csv,ana.csv,public,ana.csv;beto.csv\n',
      'projeto-csv/mensagens.csv': 'ana.csv,1700000000000,"Olá, @beto.csv"\nbeto.csv,1700000001000,Oi Ana\n',
    });
    const wrong = await upload('csv', 'users.csv', 'a,b,c\n', { type: 'text/csv' });
    expect(wrong.error).toContain('Compacte');

    const r = await upload('csv', 'exportacao.zip', zip, { type: 'application/zip' });
    expect(r.success).toBe(true);
    const op = await waitOp(settled);
    expect(op).toMatchObject({ status: 'importer_user_selection', count: { users: 2, channels: 1, messages: 2, total: 5 } });
    const data = await api('GET', 'getImportFileData', undefined, A);
    expect(data.users.map((u: any) => u.username).sort()).toEqual(['ana.csv', 'beto.csv']);
    expect(data.channels.map((c: any) => c.name)).toEqual(['projeto-csv']);
    expect(data.message_count).toBe(2);

    const s = await api('POST', 'startImport', { input: { users: { all: true }, channels: { all: true } } }, A);
    expect(s.success).toBe(true);
    const done = await waitOp(settled, 30_000);
    expect(done.status).toBe('importer_done');
    expect(done.count).toMatchObject({ total: 5, completed: 5, error: 0, skipped: 0 });
    const room = (await pool.query(`SELECT id, msgs, last_message FROM rooms WHERE name = 'projeto-csv'`)).rows[0];
    expect(room).toMatchObject({ msgs: 2, last_message: { msg: 'Oi Ana' } });
    const msgs = (await pool.query('SELECT username, msg, mentions, created_at FROM messages WHERE room_id = $1 AND t IS NULL ORDER BY created_at', [room.id])).rows;
    expect(msgs.map((m) => [m.username, m.msg])).toEqual([
      ['ana.csv', 'Olá, @beto.csv'],
      ['beto.csv', 'Oi Ana'],
    ]);
    expect(msgs[0].mentions.map((m: any) => m.username)).toEqual(['beto.csv']);
    expect(new Date(msgs[0].created_at).getTime()).toBe(1700000000000);
    // Os dados lidos que deram certo saem da área de preparação.
    expect(await opRows(r.operation._id)).toHaveLength(0);
    const csv = (await api('GET', 'importers.list', undefined, A)).importers.find((i: any) => i.key === 'csv');
    const history = await api('GET', 'getLatestImportOperations', undefined, A);
    expect(history.operations[0]).toMatchObject({ _id: r.operation._id, type: csv.name, status: 'importer_done', file: 'exportacao.zip' });
    const audit = await pool.query(`SELECT action FROM audit_log WHERE target->>'operationId' = $1 ORDER BY created_at`, [r.operation._id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['import.uploaded', 'import.started', 'import.finished']);
  });
});

describe('correções da revisão', () => {
  const RECOVER_PEER = 'outra-instancia';

  it('import.errors não mostra trechos de mensagens a quem só vê o histórico', async () => {
    const viewer = await newUser(A);
    expect((await api('POST', 'users.update', { userId: viewer.userId, data: { roles: ['user', 'auditor'] } }, A)).success).toBe(true);
    await api('POST', 'permissions.update', { permissions: [{ _id: 'view-import-operations', roles: ['admin', 'auditor'] }] }, A);
    try {
      const op = await apiOperation([{ importIds: ['v1'], emails: ['v1@ex.com'], username: 'v1' }]);
      await pool.query(`INSERT INTO import_records (operation_id, data_type, import_id, data, errors) VALUES ($1, 'message', 'dm1', $2, '["Autor não encontrado"]')`, [
        op._id,
        json({ rid: 'd1', u: 'U9', msg: 'conversa particular' }),
      ]);
      // O histórico (contadores e erro da operação) continua visível; os registros com erro, não.
      expect((await api('GET', 'getLatestImportOperations', undefined, viewer)).operations[0]._id).toBe(op._id);
      const r = await api('GET', 'import.errors', undefined, viewer);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r)).not.toContain('conversa particular');
      expect((await api('GET', 'import.errors', undefined, A)).errors[0].label).toBe('conversa particular');
    } finally {
      await api('POST', 'permissions.update', { permissions: [{ _id: 'view-import-operations', roles: ['admin'] }] }, A);
    }
  });

  it('rótulo de import.errors com marcadores de menção leva tempo linear', () => {
    expect(plainMentions('oi \u0001@U1|ana\u0002 e \u0001#C1\u0002, \u0001@U2|\u0002 \u0001x\u0002 \u0001@sem fim')).toBe('oi @ana e #C1, @U2 \u0001x\u0002 \u0001@sem fim');
    expect(plainMentions('\u0001\u0001@U1|a|b\u0002\u0002')).toBe('\u0001@a|b\u0002');
    // Muitas aberturas sem fechamento, ou muitas aberturas antes de um fechamento só: com a regex, quadrático.
    for (const evil of ['\u0001@'.repeat(500_000), `${'\u0001x'.repeat(500_000)}\u0002`, `\u0001@${'|'.repeat(1_000_000)}`]) {
      const t0 = performance.now();
      plainMentions(evil);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('a prévia só junta pelo nome de usuário quando a conta é do mesmo tipo e os e-mails não se contradizem; mostra quem pede admin', async () => {
    const semEmail = `semmail${Date.now()}`;
    expect((await api('POST', 'users.create', { username: semEmail, name: 'Sem E-mail', password: 'senha-forte-1' }, A)).success).toBe(true);
    await upload(
      'test',
      'nomes.json',
      json({
        users: [
          // Mesmo nome, outro e-mail: outra pessoa.
          { importIds: ['n1'], emails: ['outro@ex.com'], username: U.username },
          // Mesmo nome, sem e-mail no arquivo: a mesma conta.
          { importIds: ['n2'], emails: [], username: U.username.toUpperCase() },
          // Mesmo nome, a conta não tem e-mail: a mesma conta.
          { importIds: ['n3'], emails: ['novo@ex.com'], username: semEmail },
          // Mesmo nome, mas um é bot: outra conta.
          { importIds: ['n4'], emails: [], username: semEmail, type: 'bot' },
          // Qualquer um dos e-mails serve.
          { importIds: ['n5'], emails: ['nada@ex.com', `${U.username}@test.local`], username: 'qualquer', roles: ['user', 'admin'] },
        ],
      }),
    );
    await waitOp(settled);
    const data = await api('GET', 'getImportFileData', undefined, A);
    expect(data.users.map((u: any) => [u.user_id, u.is_email_taken, u.is_admin])).toEqual([
      ['n1', false, false],
      ['n2', true, false],
      ['n3', true, false],
      ['n4', false, false],
      ['n5', true, true],
    ]);
  });

  it('import.addUsers e os arquivos só dão admin a contas novas, e só quando quem importa tem assign-admin-role', async () => {
    const role = await api('POST', 'roles.create', { name: 'importador', scope: 'Users', description: 'Importa dados' }, A);
    expect(role.success).toBe(true);
    await api('POST', 'permissions.update', { permissions: [{ _id: 'run-import', roles: ['admin', 'importador'] }] }, A);
    const imp = await newUser(A);
    expect((await api('POST', 'users.update', { userId: imp.userId, data: { roles: ['user', 'importador'] } }, A)).success).toBe(true);
    const existingEmail = `${U.username}@test.local`;
    const rolesOf = async (where: string, v: string) => (await pool.query(`SELECT roles FROM users WHERE ${where} = $1`, [v])).rows[0]?.roles;
    try {
      // Pela API: recusado na hora, sem guardar nada.
      expect((await api('POST', 'import.new', {}, imp)).success).toBe(true);
      const denied = await api('POST', 'import.addUsers', { users: [{ importIds: ['adm1'], emails: ['adm1@ex.com'], username: 'adm1', password: 'senha-forte-9', roles: ['admin'] }] }, imp);
      expect(denied).toMatchObject({ status: 403 });
      expect(denied.error).toContain('assign-admin-role');
      const room = await api('POST', 'import.addUsers', { users: [{ importIds: ['adm1'], emails: ['adm1@ex.com'], roles: ['owner'] }] }, imp);
      expect(room).toMatchObject({ status: 400, errorType: 'error-invalid-roles' });
      expect((await current()).count.users).toBe(0);

      // Por arquivo: a prévia avisa, e a conta nova não vira admin porque quem importa não pode dar o papel.
      const file = (newId: string) =>
        json({
          users: [
            { importIds: [newId], emails: [`${newId}@ex.com`], username: newId, roles: ['admin'] },
            { importIds: [`${newId}-existente`], emails: [existingEmail], roles: ['admin'] },
          ],
        });
      expect((await upload('test', 'admins.json', file('adm2'), { auth: imp })).success).toBe(true);
      await waitOp(settled);
      expect((await api('GET', 'getImportFileData', undefined, imp)).users.map((u: any) => u.is_admin)).toEqual([true, true]);
      expect((await api('POST', 'startImport', { input: { users: { all: true } } }, imp)).success).toBe(true);
      expect((await waitOp(settled, 20_000)).status).toBe('importer_done');
      expect(await rolesOf('username', 'adm2')).toEqual(['user']);
      expect(await rolesOf('lower(email)', existingEmail)).not.toContain('admin');

      // Quem tem assign-admin-role: só a conta criada agora ganha o papel; a que já existia, nunca.
      expect((await upload('test', 'admins.json', file('adm3'))).success).toBe(true);
      await waitOp(settled);
      expect((await api('POST', 'startImport', { input: { users: { all: true } } }, A)).success).toBe(true);
      expect((await waitOp(settled, 20_000)).status).toBe('importer_done');
      expect(await rolesOf('username', 'adm3')).toContain('admin');
      expect(await rolesOf('lower(email)', existingEmail)).not.toContain('admin');
    } finally {
      await api('POST', 'permissions.update', { permissions: [{ _id: 'run-import', roles: ['admin'] }] }, A);
    }
  });

  it('import.addUsers aplica a política de senha das contas', async () => {
    await api('POST', 'import.new', {}, A);
    const r = await api('POST', 'import.addUsers', { users: [{ importIds: ['pw0'], emails: ['pw0@ex.com'], username: 'curta', password: 'a' }] }, A);
    expect(r).toMatchObject({ status: 400, errorType: 'error-password-policy-not-met' });
    expect(r.error).toContain('users[0] (curta)');
    expect((await current()).status).toBe('importer_new');
  });

  it('a senha da API nunca fica em texto nos dados lidos, e o hash some quando a importação falha', async () => {
    const op = await apiOperation([{ importIds: ['pw1'], emails: ['pw1@ex.com'], username: 'pw1', password: 'Segredo-Em-Texto-1' }]);
    let rows = await opRows(op._id);
    expect(JSON.stringify(rows)).not.toContain('Segredo-Em-Texto-1');
    expect(rows[0].data.password).toBeUndefined();
    expect(await verifyPassword('Segredo-Em-Texto-1', rows[0].data.passwordHash)).toBe(true);
    conv.fake = async () => {
      throw new Error('Banco fora do ar.');
    };
    await api('POST', 'import.run', {}, A);
    expect((await waitOp(settled)).status).toBe('importer_import_failed');
    rows = await opRows(op._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).not.toHaveProperty('passwordHash');
    expect(rows[0].data).not.toHaveProperty('password');

    // Operação interrompida (instância que parou): idem.
    await pool.query(`INSERT INTO import_operations (id, importer_key, status, valid, instance_id) VALUES ('rec-senha', 'api', 'importer_importing_users', false, 'sumiu')`);
    try {
      await pool.query(`INSERT INTO import_records (operation_id, data_type, import_id, data) VALUES ('rec-senha', 'user', 'pw2', $1)`, [
        json({ importIds: ['pw2'], emails: [], passwordHash: rows[0].data.passwordHash ?? 'scrypt$1$1$1$a$b', password: 'legado' }),
      ]);
      await recoverInterrupted();
      const left = (await pool.query(`SELECT data FROM import_records WHERE operation_id = 'rec-senha'`)).rows[0].data;
      expect(left).toEqual({ importIds: ['pw2'], emails: [] });
    } finally {
      await pool.query(`DELETE FROM import_operations WHERE id = 'rec-senha'`);
    }
  });

  it('a instância se marca viva antes de a operação ficar ocupada, mesmo com a linha apagada ou velha (DISABLE_CRON)', async () => {
    // A limpeza diária apagou a linha desta instância.
    await pool.query('DELETE FROM instances WHERE id = $1', [bus.origin]);
    await upload('test', 'longo.json', json({ users: [{ importIds: ['hb1'], emails: [] }], hold: true }));
    await waitOp((o) => PREPARING_STATES.includes(o.status));
    // Outra instância confere logo em seguida (bem antes dos 20 s do intervalo).
    expect(await recoverInterrupted(RECOVER_PEER)).toBe(0);
    expect(PREPARING_STATES).toContain((await current()).status);
    await api('POST', 'import.cancel', {}, A);
    await waitOp(settled);

    // Linha velha (sem o agendador, só o boot gravou last_seen).
    conv.fake = async (o) => {
      await o.sink.step('importer_importing_users');
      while (!o.sink.cancelled()) await sleep(20);
      return { users: {}, channels: {}, messages: {}, contacts: {}, roomIds: [], newUserIds: [] };
    };
    await apiOperation([{ importIds: ['hb2'], emails: ['hb2@ex.com'] }]);
    await pool.query(`UPDATE instances SET last_seen = now() - interval '5 minutes' WHERE id = $1`, [bus.origin]);
    expect((await api('POST', 'import.run', {}, A)).success).toBe(true);
    expect(await recoverInterrupted(RECOVER_PEER)).toBe(0);
    const fresh = await pool.query(`SELECT 1 FROM instances WHERE id = $1 AND last_seen > now() - interval '10 seconds'`, [bus.origin]);
    expect(fresh.rowCount).toBe(1);
  });

  it('a leitura do arquivo para quando outra instância já deu a operação como falha', async () => {
    // 600 usuários: os 500 primeiros já estão gravados nos dados lidos enquanto a leitura espera.
    const users = Array.from({ length: 600 }, (_, i) => ({ importIds: [`f${i}`], emails: [] }));
    const r = await upload('test', 'longo.json', json({ users, hold: true }));
    await waitOp((o) => PREPARING_STATES.includes(o.status));
    for (let i = 0; i < 50 && (await opRows(r.operation._id)).length < 500; i++) await sleep(40);
    expect(await opRows(r.operation._id)).toHaveLength(500);
    await pool.query(`UPDATE import_operations SET status = 'importer_import_failed', error = 'interrompida' WHERE id = $1`, [r.operation._id]);
    // No próximo ciclo dos contadores (2 s) a leitura percebe, para e apaga o que tinha lido.
    const end = Date.now() + 6000;
    while ((await opRows(r.operation._id)).length && Date.now() < end) await sleep(100);
    expect(await opRows(r.operation._id)).toHaveLength(0);
    expect(await current()).toMatchObject({ _id: r.operation._id, status: 'importer_import_failed', error: 'interrompida' });
  });

  it('a importação para quando outra instância já deu a operação como falha', async () => {
    let exited = false;
    conv.fake = async (o) => {
      await o.sink.step('importer_importing_messages');
      while (!o.sink.cancelled()) {
        o.sink.inc({ completed: 1 });
        await sleep(10);
      }
      exited = true;
      return { users: {}, channels: {}, messages: {}, contacts: {}, roomIds: [], newUserIds: [] };
    };
    const op = await apiOperation([{ importIds: ['f2'], emails: ['f2@ex.com'] }]);
    await api('POST', 'startImport', { input: { users: { all: true } } }, A);
    await waitOp((o) => o.status === 'importer_importing_messages');
    await pool.query(`UPDATE import_operations SET status = 'importer_import_failed', error = 'interrompida' WHERE id = $1`, [op._id]);
    for (let i = 0; i < 60 && !exited; i++) await sleep(50);
    expect(exited).toBe(true);
    expect((await current()).status).toBe('importer_import_failed');
  });

  it('uma nova operação não invalida a importação que acabou de começar', async () => {
    conv.fake = async (o) => {
      await o.sink.step('importer_importing_users');
      const zero = { inserted: 0, updated: 0, failed: 0, skipped: 0 };
      return { users: zero, channels: zero, messages: zero, contacts: { inserted: 0, failed: 0, skipped: 0 }, roomIds: [], newUserIds: [] };
    };
    const op = await apiOperation([{ importIds: ['r1'], emails: ['r1@ex.com'], username: 'corrida1' }]);
    // Força a ordem: startImport muda a operação entre a conferência do import.new e a invalidação.
    const lock = await pool.connect();
    let started: Promise<any>;
    let other: Promise<any>;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM import_operations WHERE valid FOR UPDATE');
      started = api('POST', 'startImport', { input: { users: { all: true } } }, A);
      await sleep(300);
      other = api('POST', 'import.new', {}, A);
      await sleep(300);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const [s, n] = await Promise.all([started!, other!]);
    expect(s.success).toBe(true);
    expect(n).toMatchObject({ status: 409, errorType: 'error-import-running' });
    const done = await waitOp(settled);
    expect(done).toMatchObject({ _id: op._id, status: 'importer_done', valid: true });
  });

  it('um envio que para de chegar é interrompido e não bloqueia as outras importações', async () => {
    uploadLimits.idleMs = 300;
    const boundary = 'limiteDoTeste';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/uploadImportFile',
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-user-id': A.userId, 'x-auth-token': A.authToken },
    });
    req.on('error', () => {});
    req.on('response', (res) => res.resume());
    try {
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="importerKey"\r\n\r\ntest\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="parado.json"\r\nContent-Type: application/json\r\n\r\n{"users": [`,
      );
      const op = await waitOp((o) => o.file === 'parado.json' && settled(o), 5000);
      expect(op.status).toBe('importer_import_failed');
      expect(op.error).toContain('parou de chegar');
      expect(fs.existsSync(operationDir(op._id))).toBe(false);
      expect((await api('POST', 'import.new', {}, A)).success).toBe(true);
    } finally {
      uploadLimits.idleMs = 120_000;
      req.destroy();
    }
  });

  it('um envio que para depois do arquivo, antes do fim do corpo, também é interrompido', async () => {
    uploadLimits.idleMs = 300;
    const boundary = 'limiteDoTeste';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/uploadImportFile',
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-user-id': A.userId, 'x-auth-token': A.authToken },
    });
    req.on('error', () => {});
    req.on('response', (res) => res.resume());
    try {
      // O arquivo chegou inteiro, mas falta o fechamento do multipart.
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="importerKey"\r\n\r\ntest\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quase.json"\r\nContent-Type: application/json\r\n\r\n{"users": []}\r\n--${boundary}`,
      );
      const op = await waitOp((o) => o.file === 'quase.json' && settled(o), 5000);
      expect(op).toMatchObject({ status: 'importer_import_failed' });
      expect(op.error).toContain('parou de chegar');
      expect(fs.existsSync(operationDir(op._id))).toBe(false);
    } finally {
      uploadLimits.idleMs = 120_000;
      req.destroy();
    }
  });

  it('um envio lento mas contínuo não é interrompido pelo prazo de espera', async () => {
    // Prazo de 400 ms, envio que dura uns 1,5 s com um pedaço a cada 100 ms: o prazo vale entre pedaços, não para o envio todo.
    uploadLimits.idleMs = 400;
    const boundary = 'limiteDoTeste';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/uploadImportFile',
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-user-id': A.userId, 'x-auth-token': A.authToken },
    });
    // Conexão derrubada pelo servidor: 0, sem esperar o tempo limite do teste.
    const status = new Promise<number>((resolve) => {
      req.on('error', () => resolve(0));
      req.on('close', () => resolve(0));
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    try {
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="importerKey"\r\n\r\ntest\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="lento.json"\r\nContent-Type: application/json\r\n\r\n`,
      );
      const content = json({ users: [{ importIds: ['lento1'], emails: [] }] });
      const t0 = Date.now();
      for (let i = 0; i < content.length; i += 4) {
        await sleep(100);
        req.write(content.slice(i, i + 4));
      }
      req.end(`\r\n--${boundary}--\r\n`);
      expect(Date.now() - t0).toBeGreaterThan(3 * uploadLimits.idleMs);
      expect(await status).toBe(200);
      const op = await waitOp((o) => o.file === 'lento.json' && settled(o));
      expect(op).toMatchObject({ status: 'importer_user_selection', count: { users: 1 } });
    } finally {
      uploadLimits.idleMs = 120_000;
      req.destroy();
    }
  });

  it('nome de arquivo com U+0000 no envio não derruba a operação', async () => {
    // filename* (RFC 5987) com %00: o leitor do multipart entrega o caractere, que o PostgreSQL recusa em text.
    const boundary = 'limiteNulo';
    const content = json({ users: [{ importIds: ['nulo1'], emails: [] }] });
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/uploadImportFile`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-user-id': A.userId, 'x-auth-token': A.authToken },
      body:
        `--${boundary}\r\nContent-Disposition: form-data; name="importerKey"\r\n\r\ntest\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''en%00vio%01.json\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    });
    const r: any = await res.json();
    expect(r).toMatchObject({ success: true, operation: { file: 'envio.json' } });
    expect(await waitOp(settled)).toMatchObject({ _id: r.operation._id, status: 'importer_user_selection' });
  });

  it('U+0000 ou meio emoji num aviso ou num erro não deixa a operação presa', async () => {
    // O corte em 1000 unidades UTF-16 cairia no meio de um emoji; o jsonb recusa a metade e o U+0000.
    await upload('test', 'avisos.json', json({ users: [{ importIds: ['aviso1'], emails: ['aviso1@ex.com'] }], warnTexts: ['nome\u0000ruim', `a${'😀'.repeat(1200)}`] }));
    const op = await waitOp(settled);
    expect(op.status).toBe('importer_user_selection');
    expect(op.warnings[0]).toBe('nomeruim');
    expect([...op.warnings[1]]).toHaveLength(1000);
    expect(op.warnings[1].endsWith('😀')).toBe(true);

    // Erro da conversão com U+0000: sem limpar, a gravação da falha é recusada e a operação fica "importando" para sempre.
    conv.fake = async () => {
      throw new Error('falhou\u0000 no meio');
    };
    expect((await api('POST', 'startImport', { input: { users: { all: true } } }, A)).success).toBe(true);
    expect(await waitOp(settled)).toMatchObject({ _id: op._id, status: 'importer_import_failed', error: 'falhou no meio' });
  });

  it('erro ou aviso de um registro com U+0000 ou emoji no limite fica gravado inteiro, sem metade de emoji', async () => {
    conv.fake = async (o) => {
      const { iterateStaged, markRecordError } = await import('../src/importer/staging');
      await o.sink.step('importer_importing_users');
      for await (const batch of iterateStaged<any>(o.operationId, 'user')) {
        for (const r of batch) {
          // Sem limpar, o U+0000 faria o PostgreSQL recusar a gravação, e a conversão pararia no meio.
          await markRecordError(r.id, 'nome\u0000ruim');
          await markRecordError(r.id, `${'x'.repeat(1999)}😀 e o resto`);
          o.sink.inc({ error: 1 });
        }
      }
      const zero = { inserted: 0, updated: 0, failed: 0, skipped: 0 };
      return { users: { ...zero, failed: 1 }, channels: zero, messages: zero, contacts: { inserted: 0, failed: 0, skipped: 0 }, roomIds: [], newUserIds: [] };
    };
    await apiOperation([{ importIds: ['nota1'], emails: ['nota1@ex.com'], username: 'nota1' }]);
    expect((await api('POST', 'startImport', { input: { users: { all: true } } }, A)).success).toBe(true);
    expect(await waitOp(settled)).toMatchObject({ status: 'importer_done', count: { error: 1 } });
    const errors = await api('GET', 'import.errors', undefined, A);
    expect(errors.total).toBe(1);
    // Corte por caractere (lib/text): o emoji na posição 2000 fica inteiro, nada de "�" no fim.
    expect(errors.errors[0].messages).toEqual(['nomeruim', `${'x'.repeat(1999)}😀`]);
  });

  it('cancelar uma importação que roda em outra instância apaga o hash das senhas', async () => {
    const op = await apiOperation([{ importIds: ['pwc'], emails: ['pwc@ex.com'], username: 'pwc', password: 'Segredo-Em-Texto-3' }]);
    expect((await opRows(op._id))[0].data.passwordHash).toBeTruthy();
    // Começou em outra instância (viva): aqui não há trabalho para avisar, e a situação muda direto.
    await pool.query(`UPDATE import_operations SET status = 'importer_importing_users', instance_id = $2 WHERE id = $1`, [op._id, RECOVER_PEER]);
    const r = await api('POST', 'import.cancel', {}, A);
    expect(r.operation.status).toBe('importer_import_cancelled');
    const rows = await opRows(op._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).not.toHaveProperty('passwordHash');
    expect(rows[0].data).not.toHaveProperty('password');
    expect(rows[0].data).toMatchObject({ importIds: ['pwc'], username: 'pwc' });
  });

  it('import.addUsers limita as senhas por chamada para a resposta não demorar minutos', async () => {
    addUsersLimits.passwordsPerCall = 2;
    try {
      await api('POST', 'import.new', {}, A);
      const user = (i: number, password?: string) => ({ importIds: [`lim${i}`], emails: [`lim${i}@ex.com`], username: `lim${i}`, ...(password ? { password } : {}) });
      const many = await api('POST', 'import.addUsers', { users: [user(1, 'senha-forte-1'), user(2, 'senha-forte-2'), user(3, 'senha-forte-3')] }, A);
      expect(many).toMatchObject({ status: 400, errorType: 'error-too-many-passwords' });
      expect(many.error).toContain('no máximo 2 usuários com senha');
      expect((await current()).count.users).toBe(0);
      // Usuários sem senha não contam (não há hash a gerar).
      const ok = await api('POST', 'import.addUsers', { users: [user(1, 'senha-forte-1'), user(2, 'senha-forte-2'), user(3), user(4)] }, A);
      expect(ok.success).toBe(true);
      expect(ok.operation.count.users).toBe(4);
    } finally {
      addUsersLimits.passwordsPerCall = 500;
    }
  });

  it('a prévia das salas segue a conversão: grupo privado só pelo nome e nome repetido no arquivo viram sala nova', async () => {
    const n = Date.now().toString(36);
    const group = (await api('POST', 'groups.create', { name: `segredo-${n}` }, A)).group;
    const channel = (await api('POST', 'channels.create', { name: `publico-${n}` }, A)).channel;
    const linked = (await api('POST', 'groups.create', { name: `ligado-${n}` }, A)).group;
    const owned = (await api('POST', 'channels.create', { name: `dono-${n}` }, A)).channel;
    // Este grupo foi criado por uma importação anterior do mesmo canal de origem: continua sendo dele.
    await pool.query(`INSERT INTO import_map (kind, import_id, target_id) VALUES ('room', $1, $2), ('room-created', $1, $2)`, [`sp-${n}`, linked._id]);
    // Canal criado para sy e ligado depois a sx só pelo nome: fica com sy, e sx ganha outra sala.
    await pool.query(`INSERT INTO import_map (kind, import_id, target_id) VALUES ('room', $1, $3), ('room-created', $1, $3), ('room', $2, $3)`, [`sy-${n}`, `sx-${n}`, owned._id]);
    const before = new Set([group._id, channel._id, linked._id, owned._id]);
    const ids = [`s1-${n}`, `s2-${n}`, `s3-${n}`, `s4-${n}`, `sp-${n}`, `sx-${n}`, `sy-${n}`];
    await upload(
      'test',
      'salas.json',
      json({
        channels: [
          // Grupo privado que existe só com o mesmo nome: nunca se junta.
          { importIds: [ids[0]], t: 'p', name: `segredo-${n}`, users: [] },
          { importIds: [ids[1]], t: 'c', name: `publico-${n}`, users: [] },
          // Outro canal do arquivo com o mesmo nome depois de ajustado: vira outra sala.
          { importIds: [ids[2]], t: 'c', name: `PUBLICO ${n}`, users: [] },
          { importIds: [ids[3]], t: 'c', name: `segredo-${n}`, users: [] },
          { importIds: [ids[4]], t: 'p', name: `ligado-${n}`, users: [] },
          { importIds: [ids[5]], t: 'c', name: `outro-${n}`, users: [] },
          { importIds: [ids[6]], t: 'c', name: `dono-${n}`, users: [] },
        ],
      }),
    );
    await waitOp(settled);
    const preview = (await api('GET', 'getImportFileData', undefined, A)).channels.map((c: any) => c.exists);
    expect(preview).toEqual([false, true, false, false, true, false, true]);
    // A conversão faz o que a prévia mostrou.
    expect((await api('POST', 'startImport', { input: { users: { all: true }, channels: { all: true } } }, A)).success).toBe(true);
    expect((await waitOp(settled, 20_000)).status).toBe('importer_done');
    const maps = await pool.query(`SELECT import_id, target_id FROM import_map WHERE kind = 'room' AND import_id = ANY($1::text[])`, [ids]);
    const target = new Map(maps.rows.map((r) => [r.import_id, r.target_id]));
    expect(ids.map((i) => before.has(target.get(i)))).toEqual(preview);
  });

  describe('caminho no servidor', () => {
    const saved = process.env.IMPORT_SERVER_DIR;
    afterAll(() => {
      if (saved === undefined) delete process.env.IMPORT_SERVER_DIR;
      else process.env.IMPORT_SERVER_DIR = saved;
    });

    it('a mensagem não diz se um arquivo fora da pasta existe', async () => {
      const base = path.join(tmp, 'liberada-2');
      await fs.promises.mkdir(base, { recursive: true });
      await fs.promises.writeFile(path.join(tmp, 'existe.json'), '{}');
      process.env.IMPORT_SERVER_DIR = base;
      const tryPath = async (p: string) => {
        const r = await api('POST', 'downloadPublicImportFile', { importerKey: 'test', fileUrl: p }, A);
        expect(r, p).toMatchObject({ status: 400, errorType: 'error-import-file-missing' });
        return String(r.error).replace(p, '<caminho>');
      };
      const messages = new Set([
        await tryPath('../existe.json'),
        await tryPath('../nao-existe.json'),
        await tryPath('../../../../../../etc/passwd'),
        await tryPath('../../../../../../etc/nao-existe-xyz'),
        await tryPath(path.join(tmp, 'existe.json')),
        await tryPath('nao-existe.json'),
      ]);
      expect([...messages]).toEqual(['Arquivo não encontrado na pasta de importação do servidor: <caminho>']);
    });
  });

  describe('arquivo em um endereço', () => {
    let server: http.Server;
    let origin = '';
    const saved = process.env.IMPORT_ALLOWED_HOSTS;
    const body = json({ users: [{ importIds: ['url1'], emails: [] }] });
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/servido.php') {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="velho.txt"; filename*=UTF-8''exporta%C3%A7%C3%A3o%20final.json` });
          return res.end(body);
        }
        if (url === '/nulo.php') {
          res.writeHead(200, { 'content-disposition': `attachment; filename*=UTF-8''expo%00rt.json` });
          return res.end(body);
        }
        if (url === '/errado.php') {
          res.writeHead(200, { 'content-disposition': 'attachment; filename="planilha.csv"' });
          return res.end('a,b\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      origin = `http://127.0.0.1:${(server.address() as any).port}`;
      process.env.IMPORT_ALLOWED_HOSTS = new URL(origin).host;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (saved === undefined) delete process.env.IMPORT_ALLOWED_HOSTS;
      else process.env.IMPORT_ALLOWED_HOSTS = saved;
    });
    const fromUrl = (fileUrl: string) => api('POST', 'downloadPublicImportFile', { importerKey: 'test', fileUrl }, A);

    it('aceita download.php, endereço sem caminho e nome com versão; quem decide é o conteúdo', async () => {
      for (const [p, file] of [
        ['/download.php?id=42', 'download.php'],
        ['/', '127.0.0.1'],
        ['/exports/backup-v1.2', 'backup-v1.2'],
      ]) {
        const r = await fromUrl(`${origin}${p}`);
        expect(r.success, p).toBe(true);
        const op = await waitOp((o) => o._id === r.operation._id && settled(o));
        expect(op, p).toMatchObject({ status: 'importer_user_selection', file, count: { users: 1 } });
      }
      // Extensão conhecida e errada continua recusada antes do download.
      expect(await fromUrl(`${origin}/planilha.csv`)).toMatchObject({ status: 400, errorType: 'error-invalid-file-type' });
    });

    it('lê o nome do Content-Disposition com aspas, escapes e filename*', () => {
      expect(dispositionFileName('attachment; filename="a;b \\"c\\".zip"')).toBe('a;b "c".zip');
      expect(dispositionFileName('inline; FileName=simples.zip; size=10')).toBe('simples.zip');
      expect(dispositionFileName(`attachment; filename*=UTF-8''%E2%82%AC%20taxas.zip; filename="taxas.zip"`)).toBe('€ taxas.zip');
      expect(dispositionFileName(`attachment; filename*=UTF-8''%E2%ZZ; filename="reserva.zip"`)).toBe('reserva.zip');
      expect(dispositionFileName('attachment; x; filename=depois.zip')).toBe('depois.zip');
      expect(dispositionFileName('attachment')).toBe('');
      expect(dispositionFileName(undefined)).toBe('');
      const t0 = performance.now();
      dispositionFileName(`a${'; filename="'.repeat(100_000)}`);
      dispositionFileName(`a;${' '.repeat(1_000_000)}`);
      expect(performance.now() - t0).toBeLessThan(500);
    });

    it('nome com U+0000 no endereço ou no Content-Disposition não derruba a operação', async () => {
      const served = await fromUrl(`${origin}/nulo.php`);
      expect(served.success).toBe(true);
      expect(await waitOp((o) => o._id === served.operation._id && settled(o))).toMatchObject({ status: 'importer_user_selection', file: 'export.json' });
      const inPath = await fromUrl(`${origin}/a%00b%7F.json`);
      expect(inPath).toMatchObject({ success: true, operation: { file: 'ab.json' } });
      expect(await waitOp((o) => o._id === inPath.operation._id && settled(o))).toMatchObject({ status: 'importer_user_selection', file: 'ab.json' });
    });

    it('usa o nome que o servidor dá ao arquivo (Content-Disposition)', async () => {
      const r = await fromUrl(`${origin}/servido.php`);
      let op = await waitOp((o) => o._id === r.operation._id && settled(o));
      expect(op).toMatchObject({ status: 'importer_user_selection', file: 'exportação final.json' });
      const wrong = await fromUrl(`${origin}/errado.php`);
      op = await waitOp((o) => o._id === wrong.operation._id && settled(o));
      expect(op.status).toBe('importer_import_failed');
      expect(op.error).toContain('.csv');
    });
  });
});
