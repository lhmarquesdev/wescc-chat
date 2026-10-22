import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { downloadToBuffer } from '../src/importer/download';
import { countPendingAvatars, countPendingFiles, imageType, pendingFileType, runPendingAvatars, runPendingFiles } from '../src/importer/pending';
import { internalAddress } from '../src/oauth/login';
import type { ProgressSink } from '../src/importer/types';
import { newId } from '../src/lib/ids';
import { admin, api, connectWs, newUser, raw, sleep, startServer, stopServer, type Auth } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let A: Auth;
let rid = '';
let port = 0;
let flakyCalls = 0;
let inFlight = 0;
let maxInFlight = 0;
const savedEnv = process.env.IMPORT_ALLOWED_HOSTS;
const opIds: string[] = [];

const server = http.createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];
  if (url === '/files/relatorio.txt') return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('relatório');
  if (url === '/files/foto.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  if (url === '/files/planilha') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end('xlsx');
  if (url === '/files/desenho.svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
  if (url === '/files/flaky') return ++flakyCalls === 1 ? res.writeHead(500).end() : res.writeHead(200, { 'content-type': 'text/plain' }).end('ok agora');
  if (url === '/files/big') return res.writeHead(200, { 'content-type': 'text/plain' }).end('b'.repeat(100));
  if (url === '/files/slow') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const t = setInterval(() => res.write('.'), 50);
    return res.on('close', () => clearInterval(t));
  }
  if (url.startsWith('/files/conc')) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return setTimeout(() => {
      inFlight--;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(url);
    }, 100);
  }
  if (url === '/avatars/a.png') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG);
  if (url === '/avatars/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
  if (url === '/avatars/fake.png') return res.writeHead(200, { 'content-type': 'image/png' }).end('<script>alert(1)</script>');
  res.writeHead(404).end();
});

const fileUrl = (p: string) => `http://127.0.0.1:${port}${p}`;

function fakeSink(cancelled: () => boolean = () => false) {
  const counts = { completed: 0, error: 0, skipped: 0 };
  const sink: ProgressSink = {
    step: async () => {},
    inc: (d) => {
      counts.completed += d.completed ?? 0;
      counts.error += d.error ?? 0;
      counts.skipped += d.skipped ?? 0;
    },
    flush: async () => {},
    cancelled,
  };
  return { sink, counts };
}

const newOp = () => {
  const id = newId();
  opIds.push(id);
  return id;
};

const placeholder = (sourceId: string, name: string) => ({ title: name, text: `📎 ${name} (arquivo ainda não baixado da origem)`, pendingFileId: sourceId });

// Mensagem como o conversor grava: anexos provisórios e files vazio.
async function insertMessage(attachments: unknown[], createdAt: string, msg = '') {
  const id = newId();
  await pool.query(
    `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, attachments, created_at, updated_at)
     VALUES ($1,$2,$3,'admin','Administrador',$4,$5,$6,$6)`,
    [id, rid, A.userId, msg, JSON.stringify(attachments), createdAt],
  );
  return id;
}

async function insertPending(messageId: string, sourceId: string, f: { name: string; type?: string | null; url?: string | null; external?: boolean }) {
  const id = newId();
  await pool.query(
    `INSERT INTO import_pending_files (id, source_file_id, message_id, room_id, user_id, name, type, url, external, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8::text IS NOT NULL AND NOT $9 THEN 'pending' ELSE 'unavailable' END)`,
    [id, sourceId, messageId, rid, A.userId, f.name, f.type ?? null, f.url ?? null, f.external ?? false],
  );
  return id;
}

const pendingRow = async (id: string) => (await pool.query('SELECT * FROM import_pending_files WHERE id = $1', [id])).rows[0];
const messageRow = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
const fileRow = async (id: string) => (await pool.query('SELECT * FROM files WHERE id = $1', [id])).rows[0];

async function settings(s: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings: s }, A);
  expect(r.success).toBe(true);
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await settings({ API_Enable_Rate_Limiter: false });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
  process.env.IMPORT_ALLOWED_HOSTS = `127.0.0.1:${port}`;
  const ch = await api('POST', 'channels.create', { name: 'importados' }, A);
  rid = ch.channel._id;
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.IMPORT_ALLOWED_HOSTS;
  else process.env.IMPORT_ALLOWED_HOSTS = savedEnv;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  // Só o que este teste gravou na pasta de uploads.
  const rows = (await pool.query('SELECT storage_path FROM files')).rows;
  for (const r of rows) await fs.promises.rm(path.join(config.uploadDir, r.storage_path), { force: true });
  for (const d of ['2021/03', '2021', '2022/11', '2022']) await fs.promises.rmdir(path.join(config.uploadDir, d)).catch(() => {});
  for (const id of opIds) await fs.promises.rm(path.join(config.uploadDir, 'imports', id), { recursive: true, force: true });
  await stopServer();
});

describe('arquivos pendentes', () => {
  it('baixa, troca o anexo provisório pelo do arquivo, grava com a data da mensagem e avisa a sala', async () => {
    const link = { title: 'Site', title_link: 'https://exemplo.com.br' };
    const m1 = await insertMessage([placeholder('F1', 'relatorio.txt'), placeholder('F2', 'foto.png'), link], '2021-03-05T10:00:00.000Z', 'veja os anexos');
    const m2 = await insertMessage([], '2021-03-06T08:30:00.000Z');
    await pool.query(`UPDATE rooms SET last_message = $2 WHERE id = $1`, [rid, JSON.stringify({ _id: m2, msg: '', u: { _id: A.userId, username: 'admin' }, ts: '2021-03-06T08:30:00.000Z' })]);
    const f1 = await insertPending(m1, 'F1', { name: 'relatorio.txt', type: 'text/plain', url: fileUrl('/files/relatorio.txt?t=xoxe-token') });
    const f2 = await insertPending(m1, 'F2', { name: 'foto.png', type: 'image/png', url: fileUrl('/files/foto.png') });
    const f3 = await insertPending(m2, 'F3', { name: 'planilha.xlsx', type: null, url: fileUrl('/files/planilha') });
    const external = await insertPending(m2, 'F4', { name: 'doc', url: 'https://docs.google.com/x', external: true });
    const noUrl = await insertPending(m2, 'F5', { name: 'apagado.txt', url: null });
    // Linhas antigas que ficaram "pending" sem URL também viram indisponíveis.
    await pool.query(`UPDATE import_pending_files SET status = 'pending' WHERE id = $1`, [noUrl]);
    expect(await countPendingFiles()).toBe(3);

    const ws = connectWs(A);
    await ws.ready;
    const op = newOp();
    const { sink, counts } = fakeSink();
    expect(await runPendingFiles(op, sink)).toEqual({ downloaded: 3, failed: 0 });
    expect(counts).toEqual({ completed: 3, error: 0, skipped: 0 });
    expect(await countPendingFiles()).toBe(0);

    const p1 = await pendingRow(f1);
    expect(p1).toMatchObject({ status: 'downloaded', url: null, error: null, attempts: 0 });
    expect(p1.file_id).toBeTruthy();
    expect((await pendingRow(external)).status).toBe('unavailable');
    expect((await pendingRow(noUrl)).status).toBe('unavailable');

    const file1 = await fileRow(p1.file_id);
    expect(file1).toMatchObject({ room_id: rid, user_id: A.userId, message_id: m1, name: 'relatorio.txt', type: 'text/plain', size: Buffer.byteLength('relatório') });
    expect(file1.created_at).toBe('2021-03-05T10:00:00.000Z');
    expect(file1.storage_path).toBe(path.join('2021', '03', p1.file_id));
    expect(fs.readFileSync(path.join(config.uploadDir, file1.storage_path), 'utf8')).toBe('relatório');

    // A ordem dos anexos é mantida; o link continua lá.
    const msg1 = await messageRow(m1);
    const file2Id = (await pendingRow(f2)).file_id;
    expect(msg1.attachments).toEqual([
      { title: 'relatorio.txt', title_link: `/file-upload/${p1.file_id}/relatorio.txt`, type: 'file', size: file1.size, format: 'TXT' },
      { title: 'foto.png', title_link: `/file-upload/${file2Id}/foto.png`, type: 'file', size: PNG.length, format: 'PNG', image_url: `/file-upload/${file2Id}/foto.png` },
      link,
    ]);
    expect(msg1.files.map((f: any) => f._id).sort()).toEqual([p1.file_id, file2Id].sort());
    expect(msg1.msg).toBe('veja os anexos');

    // Sem anexo provisório: acrescenta; tipo pela extensão quando a origem e a resposta não dizem.
    const msg2 = await messageRow(m2);
    const p3 = await pendingRow(f3);
    expect(msg2.attachments).toEqual([{ title: 'planilha.xlsx', title_link: `/file-upload/${p3.file_id}/planilha.xlsx`, type: 'file', size: 4, format: 'XLSX' }]);
    expect((await fileRow(p3.file_id)).type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const room = (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [rid])).rows[0];
    expect(room.last_message.msg).toBe('📎 planilha.xlsx');

    // O arquivo baixa pelo caminho normal, com o controle de acesso da sala.
    const dl = await raw(`/file-upload/${p1.file_id}/relatorio.txt`, A);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('relatório');

    const ev = await ws.waitFor((e) => e.type === 'message' && e.action === 'updated' && e.message._id === m1 && e.message.files?.length === 2);
    expect(ev.message.attachments.some((a: any) => a.pendingFileId)).toBe(false);
    ws.close();
    expect(fs.existsSync(path.join(config.uploadDir, 'imports', op))).toBe(false);
  });

  it('falha conta como erro e é tentada de novo; tipo bloqueado, tamanho e endereço interno', async () => {
    const m = await insertMessage(
      [placeholder('G1', 'instavel.txt'), placeholder('G2', 'desenho.svg'), placeholder('G3', 'interno.txt'), placeholder('G4', 'grande.txt')],
      '2022-11-20T12:00:00.000Z',
    );
    const g1 = await insertPending(m, 'G1', { name: 'instavel.txt', type: 'text/plain', url: fileUrl('/files/flaky') });
    const g2 = await insertPending(m, 'G2', { name: 'desenho.svg', type: 'image/svg+xml', url: fileUrl('/files/desenho.svg') });
    const g3 = await insertPending(m, 'G3', { name: 'interno.txt', type: 'text/plain', url: `http://127.0.0.1:${port + 1}/x` });
    const g4 = await insertPending(m, 'G4', { name: 'grande.txt', type: 'text/plain', url: fileUrl('/files/big') });
    await settings({ FileUpload_MaxFileSize: 50 });
    try {
      const { sink, counts } = fakeSink();
      expect(await runPendingFiles(newOp(), sink)).toEqual({ downloaded: 0, failed: 4 });
      expect(counts).toEqual({ completed: 0, error: 4, skipped: 0 });
    } finally {
      await settings({ FileUpload_MaxFileSize: 104857600 });
    }
    expect(await pendingRow(g1)).toMatchObject({ status: 'failed', attempts: 1, error: 'O servidor respondeu 500.' });
    expect(await pendingRow(g2)).toMatchObject({ status: 'failed', attempts: 5, error: 'Tipo de arquivo não permitido (image/svg+xml).' });
    expect((await pendingRow(g3)).error).toMatch(/rede interna não permitido/);
    expect((await pendingRow(g4)).error).toBe('O arquivo passa do tamanho máximo (50 bytes).');
    expect((await messageRow(m)).attachments.every((a: any) => a.pendingFileId)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM files WHERE message_id = $1', [m])).rows[0].n).toBe(0);
    // O tipo bloqueado não volta para a fila.
    expect(await countPendingFiles()).toBe(3);

    const second = fakeSink();
    expect(await runPendingFiles(newOp(), second.sink)).toEqual({ downloaded: 2, failed: 1 });
    expect(await pendingRow(g1)).toMatchObject({ status: 'downloaded', error: null });
    expect((await pendingRow(g4)).status).toBe('downloaded');
    expect((await pendingRow(g3)).attempts).toBe(2);
    const att = (await messageRow(m)).attachments;
    expect(att.map((a: any) => a.title)).toEqual(['instavel.txt', 'desenho.svg', 'interno.txt', 'grande.txt']);
    expect(att.map((a: any) => !!a.pendingFileId)).toEqual([false, true, true, false]);

    // Depois de 5 tentativas a linha sai da fila.
    await pool.query('UPDATE import_pending_files SET attempts = 4 WHERE id = $1', [g3]);
    expect(await countPendingFiles()).toBe(1);
    await runPendingFiles(newOp(), fakeSink().sink);
    expect(await pendingRow(g3)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(await countPendingFiles()).toBe(0);
  });

  it('cancelar interrompe o download em andamento e a linha continua pendente', async () => {
    const m = await insertMessage([placeholder('H1', 'lento.txt')], '2022-11-21T12:00:00.000Z');
    const h1 = await insertPending(m, 'H1', { name: 'lento.txt', type: 'text/plain', url: fileUrl('/files/slow') });

    const untouched = fakeSink(() => true);
    expect(await runPendingFiles(newOp(), untouched.sink)).toEqual({ downloaded: 0, failed: 0 });

    let cancel = false;
    const { sink, counts } = fakeSink(() => cancel);
    const op = newOp();
    const run = runPendingFiles(op, sink);
    await sleep(300);
    cancel = true;
    const t0 = Date.now();
    expect(await run).toEqual({ downloaded: 0, failed: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(counts).toEqual({ completed: 0, error: 0, skipped: 0 });
    expect(await pendingRow(h1)).toMatchObject({ status: 'pending', attempts: 0, file_id: null });
    expect(fs.existsSync(path.join(config.uploadDir, 'imports', op))).toBe(false);
    // Fora da fila para os próximos testes.
    await pool.query(`UPDATE import_pending_files SET status = 'unavailable' WHERE id = $1`, [h1]);
  });

  it('respeita o número de downloads simultâneos configurado', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await insertMessage([placeholder(`C${i}`, `c${i}.txt`)], `2022-11-22T12:00:0${i}.000Z`);
      ids.push(await insertPending(m, `C${i}`, { name: `c${i}.txt`, type: 'text/plain', url: fileUrl(`/files/conc${i}`) }));
    }
    await settings({ Import_Pending_Files_Concurrency: 2 });
    try {
      maxInFlight = 0;
      expect(await runPendingFiles(newOp(), fakeSink().sink)).toEqual({ downloaded: 5, failed: 0 });
      expect(maxInFlight).toBe(2);
    } finally {
      await settings({ Import_Pending_Files_Concurrency: 3 });
    }
    for (const id of ids) expect((await pendingRow(id)).status).toBe('downloaded');
  });

  it('nome com emoji no limite de 200 caracteres não derruba o download (o anexo é jsonb)', async () => {
    // O conversor guarda até 255 caracteres; o nome no disco e no anexo fica com 200, sem metade de emoji.
    const name = `${'n'.repeat(199)}😀.txt`;
    const m = await insertMessage([placeholder('E1', name)], '2021-03-07T10:00:00.000Z');
    const e1 = await insertPending(m, 'E1', { name, type: 'text/plain', url: fileUrl('/files/relatorio.txt') });
    const { sink, counts } = fakeSink();
    expect(await runPendingFiles(newOp(), sink)).toEqual({ downloaded: 1, failed: 0 });
    expect(counts).toEqual({ completed: 1, error: 0, skipped: 0 });
    const p = await pendingRow(e1);
    expect(p).toMatchObject({ status: 'downloaded', error: null });
    const stored = `${'n'.repeat(199)}😀`;
    expect((await fileRow(p.file_id)).name).toBe(stored);
    const att = (await messageRow(m)).attachments;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ title: stored, type: 'file' });
    expect(att[0].pendingFileId).toBeUndefined();
  });

  it('escolhe o tipo: origem, resposta, extensão', () => {
    expect(pendingFileType('image/png', 'text/html', 'x.bin')).toBe('image/png');
    expect(pendingFileType('application/octet-stream', 'application/pdf', 'x')).toBe('application/pdf');
    expect(pendingFileType('image/png,text/html', 'application/octet-stream', 'nota.PDF')).toBe('application/pdf');
    expect(pendingFileType(null, '', 'sem-extensao')).toBe('application/octet-stream');
  });
});

describe('fotos pendentes', () => {
  it('baixa só PNG/JPEG/GIF/WebP pelo conteúdo, mantém foto já escolhida e registra falhas', async () => {
    const users: Auth[] = [];
    for (let i = 0; i < 5; i++) users.push(await newUser(A));
    const urls = ['/avatars/a.png', '/avatars/page', '/avatars/fake.png', '/avatars/a.png', '/avatars/nao-existe'];
    for (const [i, u] of users.entries()) await pool.query('INSERT INTO import_pending_avatars (user_id, url) VALUES ($1, $2)', [u.userId, fileUrl(urls[i])]);
    await pool.query(`UPDATE users SET avatar_etag = 'propria' WHERE id = $1`, [users[3].userId]);
    expect(await countPendingAvatars()).toBe(5);

    const { sink, counts } = fakeSink();
    expect(await runPendingAvatars(newOp(), sink)).toEqual({ downloaded: 1, failed: 3 });
    expect(counts).toEqual({ completed: 1, error: 3, skipped: 1 });

    const row = async (u: Auth) => (await pool.query('SELECT * FROM import_pending_avatars WHERE user_id = $1', [u.userId])).rows[0];
    expect(await row(users[0])).toMatchObject({ status: 'downloaded', error: null });
    const av = (await pool.query('SELECT content_type, data FROM avatars WHERE user_id = $1', [users[0].userId])).rows[0];
    expect(av.content_type).toBe('image/png');
    expect(Buffer.compare(av.data, PNG)).toBe(0);
    const res = await raw(`/avatar/${users[0].username}`, A);
    expect(res.headers.get('content-type')).toContain('image/png');

    expect(await row(users[1])).toMatchObject({ status: 'failed', attempts: 5, error: 'A imagem não está em PNG, JPEG, GIF ou WebP.' });
    expect(await row(users[2])).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await pool.query('SELECT 1 FROM avatars WHERE user_id = ANY($1)', [[users[1].userId, users[2].userId]])).rowCount).toBe(0);
    expect(await row(users[3])).toMatchObject({ status: 'skipped' });
    expect((await pool.query('SELECT avatar_etag FROM users WHERE id = $1', [users[3].userId])).rows[0].avatar_etag).toBe('propria');
    expect(await row(users[4])).toMatchObject({ status: 'failed', attempts: 1, error: 'O servidor respondeu 404.' });
    expect(await countPendingAvatars()).toBe(1);
  });

  it('reconhece os formatos pelos primeiros bytes', () => {
    expect(imageType(PNG)).toBe('image/png');
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(imageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('endereços internos', () => {
  it('recusa IPv6 que leva um IPv4 dentro (NAT64 de uso local, compatível, traduzido, 6to4)', async () => {
    const internal = [
      '64:ff9b:1::a9fe:a9fe', // NAT64 de uso local (RFC 8215) → 169.254.169.254
      '64:ff9b::a9fe:a9fe',
      '::a9fe:a9fe', // IPv4 compatível
      '::7f00:1',
      '::ffff:0:a9fe:a9fe', // IPv4 traduzido
      '::ffff:169.254.169.254', // IPv4 mapeado
      '2002:a9fe:a9fe::1', // 6to4
      '100::1',
      'fec0::1',
      '::1',
      '127.0.0.1',
    ];
    for (const ip of internal) expect(internalAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '8.8.8.8', '::ffff:8.8.8.8']) expect(internalAddress(ip), ip).toBe(false);
    // O download recusa antes de conectar.
    for (const ip of ['64:ff9b:1::a9fe:a9fe', '::ffff:0:a9fe:a9fe', '2002:a9fe:a9fe::1']) {
      await expect(downloadToBuffer(`http://[${ip}]/latest/meta-data`, { maxBytes: 1000, timeoutMs: 2000, idleTimeoutMs: 2000 }), ip).rejects.toMatchObject({
        code: 'error-download-internal',
      });
    }
  });
});
