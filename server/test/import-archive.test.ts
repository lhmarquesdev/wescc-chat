import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import v8 from 'node:v8';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { memoryArchive, openArchive, openForImporter, ZIP_LIMITS } from '../src/importer/archive';
import { allowedInternalHosts, downloadToBuffer, downloadToFile } from '../src/importer/download';
import { ImportError, type ArchiveSource } from '../src/importer/types';

// Certificado autoassinado só para os testes (127.0.0.1 e localhost).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgHwyZQufWYTPxQpeR
kUqg1UMuYb5h22w2XPDxv1yZbIChRANCAASVk2306UG7dC/GAWSjUcTXNOCN1dhL
X7obkcVuY87VHA4JIqwimk59mmUcc3HAsvfYGWunP723Y1sAtQnVWUOs
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUFjliuBGSASHTScGArQF08iL1PmYwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMjAzMzQzOVoYDzIxMjYwOTI4
MDMzNDM5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASVk2306UG7dC/GAWSjUcTXNOCN1dhLX7obkcVuY87VHA4JIqwimk59
mmUcc3HAsvfYGWunP723Y1sAtQnVWUOso28wbTAdBgNVHQ4EFgQU85t4ym6Ynma7
xem7rWBleNnIPXQwHwYDVR0jBBgwFoAU85t4ym6Ynma7xem7rWBleNnIPXQwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZI
zj0EAwIDSAAwRQIhAO5e0nzpmx59WBQutwnMPG4+aYzXnM8J2W45kOBtfW4TAiAF
wYwI14UiMVNAdgGye7jYUq0c4wBu3mdGDhPXqcBeQg==
-----END CERTIFICATE-----
`;

const MiB = 1024 * 1024;
let tmp = '';

beforeAll(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wescc-import-archive-'));
});
afterAll(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

// ---------- Montagem de .zip em memória ----------

type ZipItem = [name: string, content: string | Buffer | null, opts?: { compress?: boolean }];

function zipBuffer(items: ZipItem[]) {
  const z = new yazl.ZipFile();
  for (const [name, content, opts] of items) {
    if (content === null) z.addEmptyDirectory(name);
    else z.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name, { compress: opts?.compress ?? true });
  }
  z.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
  });
}

let fileSeq = 0;
async function writeTmp(data: Buffer | string, name = `f${++fileSeq}.zip`) {
  const p = path.join(tmp, `${++fileSeq}-${name}`);
  await fs.promises.writeFile(p, data);
  return p;
}

// Cabeçalhos do diretório central (é dele que os nomes, tamanhos e flags são lidos).
function centralHeaders(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out: { at: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(at + 28);
    const m = buf.readUInt16LE(at + 30);
    const k = buf.readUInt16LE(at + 32);
    out.push({ at, name: buf.subarray(at + 46, at + 46 + n).toString('latin1') });
    at += 46 + n + m + k;
  }
  return out;
}

function central(buf: Buffer, name: string) {
  const h = centralHeaders(buf).find((x) => x.name === name);
  if (!h) throw new Error(`sem ${name}`);
  return h.at;
}

// Troca um nome por outro do mesmo tamanho em todo o arquivo (cabeçalho local e diretório central).
function renameAll(buf: Buffer, from: string, to: Buffer | string) {
  const a = Buffer.from(from, 'latin1');
  const b = Buffer.isBuffer(to) ? to : Buffer.from(to, 'latin1');
  if (a.length !== b.length) throw new Error('tamanhos diferentes');
  for (let i = buf.indexOf(a); i !== -1; i = buf.indexOf(a, i + 1)) b.copy(buf, i);
  return buf;
}

const names = async (src: ArchiveSource) => (await src.list()).map((e) => e.name);

// Coleta de lixo sob demanda, para medir o que fica na memória.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapAfterGc = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

// .zip montado byte a byte (sem compressão), com campos extras à escolha no diretório central.
function rawZip(items: { name: string; data: Buffer; centralExtra?: Buffer }[]) {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const { name, data, centralExtra = Buffer.alloc(0) } of items) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt16LE(centralExtra.length, 30);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    cds.push(ch, n, centralExtra);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const zipImporter = { sourceKind: 'zip' as const };

// ---------- .zip ----------

describe('arquivo .zip', () => {
  it('lista entradas e pastas, lê e faz stream; barra invertida vira "/"', async () => {
    const buf = await zipBuffer([
      ['users.csv', 'ana,ana@x.com,Ana\n'],
      ['canal/', null],
      ['canal/2023.csv', 'ana,1700000000000,oi\n'],
      ['subXa.txt', 'conteúdo', { compress: false }],
    ]);
    renameAll(buf, 'subXa.txt', 'sub\\a.txt');
    const warnings: string[] = [];
    const src = await openForImporter(await writeTmp(buf), zipImporter, { warn: (m) => warnings.push(m) });
    expect(src.kind).toBe('zip');
    const list = await src.list();
    expect(list).toEqual([
      { name: 'users.csv', size: 18, isDirectory: false },
      { name: 'canal', size: 0, isDirectory: true },
      { name: 'canal/2023.csv', size: 21, isDirectory: false },
      { name: 'sub/a.txt', size: Buffer.byteLength('conteúdo'), isDirectory: false },
    ]);
    expect(await src.list()).toBe(list);
    expect((await src.read(list[0])).toString()).toBe('ana,ana@x.com,Ana\n');
    expect((await src.read(list[3])).toString()).toBe('conteúdo');
    const chunks: Buffer[] = [];
    for await (const c of await src.stream(list[2])) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('ana,1700000000000,oi\n');
    await expect(src.read(list[1])).rejects.toThrow(ImportError);
    await expect(src.read({ name: 'nao-existe.csv', size: 1, isDirectory: false })).rejects.toThrow(/não encontrado/);
    expect(warnings).toEqual([]);
    await src.close();
    await src.close();
  });

  it('ignora (com aviso) nomes que tentariam sair da pasta', async () => {
    const buf = await zipBuffer([
      ['xx/evil.txt', 'a'],
      ['Xetc/passwd', 'b'],
      ['Cx/win.txt', 'c'],
      ['a/xx/xx/b.txt', 'd'],
      ['dirX\\..\\up.txt'.replace(/\\/g, '_'), 'e'],
      ['nulX.txt', 'f'],
      ['./ok//bom.txt', 'g'],
    ]);
    renameAll(buf, 'xx/evil.txt', '../evil.txt');
    renameAll(buf, 'Xetc/passwd', '/etc/passwd');
    renameAll(buf, 'Cx/win.txt', 'C:/win.txt');
    renameAll(buf, 'a/xx/xx/b.txt', 'a/../../b.txt');
    renameAll(buf, 'dirX_.._up.txt', 'dirX\\..\\up.txt');
    renameAll(buf, 'nulX.txt', 'nul\0.txt');
    const warnings: string[] = [];
    const src = await openArchive(await writeTmp(buf), 'zip', { warn: (m) => warnings.push(m) });
    expect(await names(src)).toEqual(['ok/bom.txt']);
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('../evil.txt');
    expect(warnings.join('\n')).not.toContain('\0');
    // Mesmo montando a entrada à mão, nada fora da lista é lido.
    await expect(src.read({ name: '../evil.txt', size: 1, isDirectory: false })).rejects.toThrow(/não encontrado/);
    expect((await src.read({ name: 'ok/bom.txt', size: 1, isDirectory: false })).toString()).toBe('g');
    await src.close();
  });

  it('nomes sem a marca de UTF-8: UTF-8 quando válido, senão CP850; nomes repetidos são ignorados', async () => {
    const buf = await zipBuffer([
      ['reuniXo/cafX.txt', '1'],
      ['canalXX.csv', '2'],
      ['dup.txt', '3'],
      ['dup.txt', '4'],
    ]);
    // Como o Windows em português grava: 0xC6 = ã e 0x82 = é na página 850.
    renameAll(buf, 'reuniXo/cafX.txt', Buffer.concat([Buffer.from('reuni'), Buffer.from([0xc6]), Buffer.from('o/caf'), Buffer.from([0x82]), Buffer.from('.txt')]));
    renameAll(buf, 'canalXX.csv', Buffer.concat([Buffer.from('canal'), Buffer.from('ç'), Buffer.from('.csv')]));
    for (const h of centralHeaders(buf)) buf.writeUInt16LE(buf.readUInt16LE(h.at + 8) & ~0x800, h.at + 8);
    const warnings: string[] = [];
    const src = await openArchive(await writeTmp(buf), 'zip', { warn: (m) => warnings.push(m) });
    expect(await names(src)).toEqual(['reunião/café.txt', 'canalç.csv', 'dup.txt']);
    expect(warnings).toEqual(['Entrada repetida ignorada no .zip: "dup.txt".']);
    expect((await src.read((await src.list())[2])).toString()).toBe('3');
    await src.close();
  });

  it('recusa .zip protegido por senha', async () => {
    for (const flag of [0x1, 0x41]) {
      const buf = await zipBuffer([['segredo.csv', 'x'.repeat(100)]]);
      const at = central(buf, 'segredo.csv');
      buf.writeUInt16LE(buf.readUInt16LE(at + 8) | flag, at + 8);
      const src = await openForImporter(await writeTmp(buf), zipImporter);
      await expect(src.list()).rejects.toThrow(/protegido por senha/);
      await src.close();
    }
  });

  it('recusa zip bomb: taxa de compressão suspeita e entradas sobrepostas', async () => {
    const bomb = await zipBuffer([['zeros.bin', Buffer.alloc(65 * MiB)]]);
    expect(bomb.length).toBeLessThan(MiB);
    const src = await openForImporter(await writeTmp(bomb), zipImporter);
    await expect(src.list()).rejects.toThrow(/taxa de compressão suspeita/);
    await src.close();

    // Taxa alta, mas pequena: normal (CSV com muita repetição).
    const small = await openForImporter(await writeTmp(await zipBuffer([['zeros.bin', Buffer.alloc(MiB)]])), zipImporter);
    expect(await small.list()).toEqual([{ name: 'zeros.bin', size: MiB, isDirectory: false }]);
    expect((await small.read((await small.list())[0])).length).toBe(MiB);
    await small.close();

    // Tamanho declarado mentiroso também conta.
    const lie = await zipBuffer([['a.txt', 'abc'.repeat(100)]]);
    lie.writeUInt32LE(100 * MiB, central(lie, 'a.txt') + 24);
    const l = await openArchive(await writeTmp(lie), 'zip');
    await expect(l.list()).rejects.toThrow(/taxa de compressão suspeita/);
    await l.close();

    const overlap = await zipBuffer([
      ['a.txt', 'a'.repeat(1000)],
      ['b.txt', 'b'.repeat(1000)],
    ]);
    overlap.writeUInt32LE(0, central(overlap, 'b.txt') + 42);
    const o = await openArchive(await writeTmp(overlap), 'zip');
    await expect(o.list()).rejects.toThrow(/corrompido ou malicioso/);
    await o.close();
  });

  it('campos extras enormes no diretório central não ficam na memória enquanto o .zip está aberto', async () => {
    // 64 KiB de campos extras vazios por entrada: o yauzl cria um objeto para cada um (16 mil por entrada).
    const extra = Buffer.alloc(65532);
    for (let i = 0; i < extra.length; i += 4) extra.writeUInt16LE(0x9999, i);
    const items = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`conteúdo ${i}`), centralExtra: extra }));
    const file = await writeTmp(rawZip(items));
    const before = heapAfterGc();
    const src = await openArchive(file, 'zip');
    const list = await src.list();
    // Antes da correção ficavam mais de 200 MB na memória (dezenas de vezes o tamanho do .zip, de 6,5 MB).
    expect(heapAfterGc() - before).toBeLessThan(20 * MiB);
    expect(list).toHaveLength(100);
    expect((await src.read(list[7])).toString()).toBe('conteúdo 7');
    let text = '';
    for await (const c of await src.stream(list[99])) text += String(c);
    expect(text).toBe('conteúdo 99');
    await src.close();
  });

  it('read recusa entrada de mais de 1 MiB com taxa de compressão acima de 100; stream continua lendo aos pedaços', async () => {
    const buf = await zipBuffer([
      ['zeros.json', Buffer.alloc(2 * MiB)],
      ['aleatorio.bin', crypto.randomBytes(2 * MiB)],
      ['texto.csv', Buffer.from(Array.from({ length: 60_000 }, (_, i) => `usuario${i},u${i}@x.com,Nome ${i}`).join('\n'))],
    ]);
    const src = await openArchive(await writeTmp(buf), 'zip');
    const [zeros, random, text] = await src.list();
    await expect(src.read(zeros)).rejects.toThrow(new ImportError('O arquivo "zeros.json" do .zip tem uma taxa de compressão suspeita (o .zip parece corrompido ou malicioso).'));
    expect((await src.read(random)).length).toBe(2 * MiB);
    expect(text.size).toBeGreaterThan(MiB);
    expect((await src.read(text)).length).toBe(text.size);
    let n = 0;
    for await (const c of await src.stream(zeros)) n += (c as Buffer).length;
    expect(n).toBe(2 * MiB);
    await src.close();
  });

  it('limites de quantidade de entradas e de tamanho total', async () => {
    const saved = { ...ZIP_LIMITS };
    try {
      ZIP_LIMITS.maxEntries = 3;
      const many = await zipBuffer([1, 2, 3, 4].map((i): ZipItem => [`${i}.txt`, String(i)]));
      await expect(openForImporter(await writeTmp(many), zipImporter)).rejects.toThrow(/entradas demais \(4; o máximo é 3\)/);
      ZIP_LIMITS.maxEntries = saved.maxEntries;

      ZIP_LIMITS.maxTotalBytes = 100;
      const big = await zipBuffer([
        ['a.txt', 'a'.repeat(60)],
        ['b.txt', 'b'.repeat(60)],
      ]);
      const src = await openForImporter(await writeTmp(big), zipImporter);
      await expect(src.list()).rejects.toThrow(/passa de 100 bytes descompactado/);
      await src.close();
    } finally {
      Object.assign(ZIP_LIMITS, saved);
    }
  });

  it('read respeita maxBytes; bytes além do tamanho declarado são recusados', async () => {
    const buf = await zipBuffer([
      ['a.txt', 'x'.repeat(100)],
      ['b.txt', 'y'.repeat(1000)],
    ]);
    buf.writeUInt32LE(10, central(buf, 'b.txt') + 24);
    const src = await openArchive(await writeTmp(buf), 'zip');
    const [a, b] = await src.list();
    await expect(src.read(a, 50)).rejects.toThrow(/grande demais para ser lido \(máximo de 50 bytes\)/);
    expect((await src.read(a, 100)).length).toBe(100);
    expect(b.size).toBe(10);
    await expect(src.read(b)).rejects.toThrow(/parece corrompido/);
    const stream = await src.stream(b);
    await expect(
      (async () => {
        for await (const _ of stream) {
          // consome
        }
      })(),
    ).rejects.toThrow(ImportError);
    await src.close();
  });

  it('arquivo que não é .zip, .zip truncado e .zip vazio', async () => {
    await expect(openForImporter(await writeTmp('username,email\nana,ana@x.com\n', 'users.csv'), zipImporter)).rejects.toThrow('O arquivo enviado não é um .zip válido.');
    const truncated = (await zipBuffer([['a.bin', crypto.randomBytes(3000)]])).subarray(0, 1000);
    await expect(openForImporter(await writeTmp(truncated), zipImporter)).rejects.toThrow('O arquivo enviado não é um .zip válido.');
    await expect(openForImporter(path.join(tmp, 'sumiu.zip'), zipImporter)).rejects.toThrow(/não foi encontrado/);
    const empty = await openForImporter(await writeTmp(await zipBuffer([])), zipImporter);
    expect(await empty.list()).toEqual([]);
    await empty.close();
  });
});

// ---------- Pasta no servidor e arquivo único ----------

describe('pasta no servidor e arquivo único', () => {
  it('lista em ordem, com "/", sem seguir links simbólicos; leitura limitada e sempre dentro da pasta', async () => {
    const base = await fs.promises.mkdtemp(path.join(tmp, 'dir-'));
    const root = path.join(base, 'export');
    await fs.promises.mkdir(path.join(root, 'canal', 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'users.csv'), 'ana,ana@x.com,Ana\n');
    await fs.promises.writeFile(path.join(root, 'canal', '2023.csv'), 'x'.repeat(100));
    await fs.promises.writeFile(path.join(root, 'canal', 'sub', 'x.csv'), 'y');
    await fs.promises.writeFile(path.join(base, 'fora.txt'), 'segredo');
    await fs.promises.symlink(path.join(base, 'fora.txt'), path.join(root, 'link-fora'));
    await fs.promises.symlink(base, path.join(root, 'link-pasta'));
    let fifo = false;
    try {
      execFileSync('mkfifo', [path.join(root, 'fifo')]);
      fifo = true;
    } catch {
      // sem mkfifo: o resto do teste continua valendo
    }
    const warnings: string[] = [];
    const src = await openForImporter(root, { sourceKind: 'zip-or-dir' }, { warn: (m) => warnings.push(m) });
    expect(src.kind).toBe('dir');
    const list = await src.list();
    expect(list).toEqual([
      { name: 'canal', size: 0, isDirectory: true },
      { name: 'canal/2023.csv', size: 100, isDirectory: false },
      { name: 'canal/sub', size: 0, isDirectory: true },
      { name: 'canal/sub/x.csv', size: 1, isDirectory: false },
      { name: 'users.csv', size: 18, isDirectory: false },
    ]);
    expect(warnings.filter((w) => w.startsWith('Link simbólico ignorado'))).toHaveLength(2);
    if (fifo) expect(warnings.some((w) => w.includes('"fifo"'))).toBe(true);

    expect((await src.read(list[4])).toString()).toBe('ana,ana@x.com,Ana\n');
    await expect(src.read(list[1], 10)).rejects.toThrow(/grande demais/);
    const chunks: Buffer[] = [];
    for await (const c of await src.stream(list[3])) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('y');
    for (const name of ['link-fora', '../fora.txt', 'link-pasta/fora.txt', '/etc/passwd', 'canal']) {
      await expect(src.read({ name, size: 1, isDirectory: false })).rejects.toThrow(/não encontrado/);
    }
    if (fifo) await expect(src.read({ name: 'fifo', size: 0, isDirectory: false })).rejects.toThrow(/não encontrado/);
    await src.close();

    // Pasta só para importadores que aceitam pasta.
    await expect(openForImporter(root, zipImporter)).rejects.toThrow(/precisa de um arquivo/);
    await expect(openForImporter(root, { sourceKind: 'file' })).rejects.toThrow(/precisa de um arquivo/);
    // Um .zip continua aceito em zip-or-dir.
    const zipped = await openForImporter(await writeTmp(await zipBuffer([['users.csv', 'a']])), { sourceKind: 'zip-or-dir' });
    expect(zipped.kind).toBe('zip');
    await zipped.close();
  });

  it('limite de itens também vale para pastas', async () => {
    const root = await fs.promises.mkdtemp(path.join(tmp, 'many-'));
    for (const i of [1, 2, 3]) await fs.promises.writeFile(path.join(root, `${i}.csv`), 'x');
    const saved = ZIP_LIMITS.maxEntries;
    ZIP_LIMITS.maxEntries = 2;
    try {
      const src = await openArchive(root, 'dir');
      await expect(src.list()).rejects.toThrow(/itens demais/);
    } finally {
      ZIP_LIMITS.maxEntries = saved;
    }
  });

  it('arquivo único: uma entrada com o nome do arquivo', async () => {
    const csv = 'Username,Email,Status\nana,ana@x.com,Member\n';
    const p = await writeTmp(csv, 'slack-users.csv');
    const src = await openForImporter(p, { sourceKind: 'file' });
    expect(src.kind).toBe('file');
    const list = await src.list();
    expect(list).toEqual([{ name: path.basename(p), size: csv.length, isDirectory: false }]);
    expect((await src.read(list[0])).toString()).toContain('ana@x.com');
    await expect(src.read(list[0], 10)).rejects.toThrow(/grande demais/);
    await expect(src.read({ name: 'outro.csv', size: 1, isDirectory: false })).rejects.toThrow(/não encontrado/);
    let text = '';
    for await (const c of await src.stream(list[0])) text += String(c);
    expect(text).toContain('Member');
    await src.close();
  });

  it('memoryArchive segue as mesmas regras de nome', async () => {
    const warnings: string[] = [];
    const src = memoryArchive({ 'export/users.json': '[]', 'export/': '', '../x.json': '{}', 'a\\b.json': Buffer.from('{"a":1}') }, { warn: (m) => warnings.push(m) });
    expect(await src.list()).toEqual([
      { name: 'export/users.json', size: 2, isDirectory: false },
      { name: 'export', size: 0, isDirectory: true },
      { name: 'a/b.json', size: 7, isDirectory: false },
    ]);
    expect(warnings).toHaveLength(1);
    expect((await src.read({ name: 'a/b.json', size: 7, isDirectory: false })).toString()).toBe('{"a":1}');
    await expect(src.read({ name: 'a/b.json', size: 7, isDirectory: false }, 3)).rejects.toThrow(/grande demais/);
    let text = '';
    for await (const c of await src.stream({ name: 'export/users.json', size: 2, isDirectory: false })) text += String(c);
    expect(text).toBe('[]');
    expect(memoryArchive({ 'contatos.csv': 'name\n' }, { kind: 'file' }).kind).toBe('file');
  });
});

// ---------- Download ----------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: (http.Server | https.Server)[] = [];

async function serve(handler: Handler, secure = false) {
  const srv = secure ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler) : http.createServer(handler);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as any).port as number;
}

describe('download com proteção contra SSRF', () => {
  let a = 0;
  let b = 0;
  let s = 0;
  const savedCAs = tls.getCACertificates('default');
  const savedEnv = process.env.IMPORT_ALLOWED_HOSTS;
  const allow = (...hosts: string[]) => {
    process.env.IMPORT_ALLOWED_HOSTS = hosts.join(',');
  };
  const dest = (name: string) => path.join(tmp, 'dl', name);
  const exists = (p: string) => fs.existsSync(p) || fs.existsSync(`${p}.part`);

  beforeAll(async () => {
    const trickle = (res: http.ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    };
    a = await serve((req, res) => {
      const url = req.url ?? '';
      if (url === '/file') return res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' }).end('ana,ana@x.com\n');
      if (url === '/big') return res.writeHead(200, { 'content-length': '5000' }).end('z'.repeat(5000));
      if (url === '/chunked-big') {
        res.writeHead(200);
        for (let i = 0; i < 20; i++) res.write('z'.repeat(100));
        return res.end();
      }
      if (url === '/missing') return res.writeHead(404).end('não há');
      if (url === '/echo') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.headers));
      if (url === '/to-file') return res.writeHead(302, { location: '/file' }).end();
      if (url === '/to-echo') return res.writeHead(301, { location: '/echo' }).end();
      if (url === '/to-b') return res.writeHead(302, { location: `http://127.0.0.1:${b}/echo` }).end();
      if (url === '/to-metadata') return res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (url.startsWith('/loop')) return res.writeHead(302, { location: `/loop${Number(url.slice(5) || 0) + 1}` }).end();
      if (url === '/silent') return; // nunca responde
      if (url === '/stall') {
        res.writeHead(200, { 'content-length': '1000' });
        return res.write('x'.repeat(10));
      }
      if (url === '/trickle') return trickle(res);
      if (url === '/truncated') {
        res.writeHead(200, { 'content-length': '100' });
        res.write('x'.repeat(10));
        return setTimeout(() => res.socket?.destroy(), 20);
      }
      res.writeHead(500).end();
    });
    b = await serve((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.headers)));
    s = await serve((req, res) => {
      if (req.url === '/file') return res.writeHead(200, { 'content-type': 'text/plain' }).end('seguro');
      if (req.url === '/to-http') return res.writeHead(302, { location: `http://127.0.0.1:${a}/file` }).end();
      res.writeHead(404).end();
    }, true);
    tls.setDefaultCACertificates([...savedCAs, TEST_CERT]);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.IMPORT_ALLOWED_HOSTS;
    else process.env.IMPORT_ALLOWED_HOSTS = savedEnv;
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(savedCAs);
    for (const srv of servers) {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  it('lê IMPORT_ALLOWED_HOSTS a cada chamada', () => {
    allow(' Minio.Local:9000', '[::1]:8080 ', 'interno', '');
    expect(allowedInternalHosts()).toEqual(['minio.local:9000', '[::1]:8080', 'interno']);
    delete process.env.IMPORT_ALLOWED_HOSTS;
    expect(allowedInternalHosts()).toEqual([]);
  });

  it('recusa endereços internos, também pelo nome resolvido e em formatos alternativos', async () => {
    const urls = [
      `http://127.0.0.1:${a}/file`,
      `http://[::1]:${a}/file`,
      `http://[::ffff:127.0.0.1]:${a}/file`,
      `http://2130706433:${a}/file`,
      `http://0.0.0.0:${a}/file`,
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/x',
      'http://192.168.0.1/x',
      `http://localhost:${a}/file`,
    ];
    for (const url of urls) {
      await expect(downloadToBuffer(url, { maxBytes: 1000 }), url).rejects.toThrow(/rede interna não permitido/);
    }
    // Liberar 127.0.0.1 numa porta não libera o nome "localhost" (que resolve para endereço interno) nem outra porta.
    allow(`127.0.0.1:${a}`);
    await expect(downloadToBuffer(`http://localhost:${a}/file`, { maxBytes: 1000 })).rejects.toThrow(/rede interna/);
    await expect(downloadToBuffer(`http://127.0.0.1:${b}/`, { maxBytes: 1000 })).rejects.toThrow(/rede interna/);
    await expect(downloadToBuffer('ftp://example.com/x.zip', { maxBytes: 1000 })).rejects.toThrow('Só são aceitos endereços http:// e https://.');
    await expect(downloadToBuffer('file:///etc/passwd', { maxBytes: 1000 })).rejects.toThrow(/http:\/\/ e https/);
    await expect(downloadToBuffer('não é url', { maxBytes: 1000 })).rejects.toThrow('Endereço inválido.');
  });

  it('baixa de host liberado para .part e renomeia no fim', async () => {
    allow(`127.0.0.1:${a}`);
    const p = dest('ok.csv');
    const r = await downloadToFile(`http://127.0.0.1:${a}/file`, p, { maxBytes: 1000 });
    expect(r).toEqual({ size: 14, contentType: 'text/csv', finalUrl: `http://127.0.0.1:${a}/file`, fileName: '' });
    expect(fs.readFileSync(p, 'utf8')).toBe('ana,ana@x.com\n');
    expect(fs.existsSync(`${p}.part`)).toBe(false);
    const viaRedirect = await downloadToFile(`http://127.0.0.1:${a}/to-file`, dest('ok2.csv'), { maxBytes: 1000 });
    expect(viaRedirect.finalUrl).toBe(`http://127.0.0.1:${a}/file`);
    const buf = await downloadToBuffer(`http://127.0.0.1:${a}/echo`, { maxBytes: 10_000, accept: 'image/*' });
    expect(JSON.parse(buf.data.toString()).accept).toBe('image/*');
  });

  it('confere cada redirecionamento: interno, https → http, credenciais e limite de saltos', async () => {
    allow(`127.0.0.1:${a}`);
    const p = dest('redir.json');
    await expect(downloadToFile(`http://127.0.0.1:${a}/to-b`, p, { maxBytes: 10_000 })).rejects.toThrow(/rede interna/);
    expect(exists(p)).toBe(false);
    await expect(downloadToFile(`http://127.0.0.1:${a}/to-metadata`, p, { maxBytes: 10_000 })).rejects.toThrow(/rede interna/);
    await expect(downloadToFile(`http://127.0.0.1:${a}/loop`, p, { maxBytes: 10_000 })).rejects.toThrow(/redireciona vezes demais/);
    // Até 5 redirecionamentos passam.
    allow(`127.0.0.1:${a}`, `127.0.0.1:${b}`);
    const headers = { authorization: 'Bearer segredo', cookie: 'x=1', 'x-extra': 'sim' };
    await downloadToFile(`http://127.0.0.1:${a}/to-echo`, p, { maxBytes: 10_000, headers });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toMatchObject({ authorization: 'Bearer segredo', 'x-extra': 'sim' });
    await downloadToFile(`http://127.0.0.1:${a}/to-b`, p, { maxBytes: 10_000, headers });
    const other = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(other.authorization).toBeUndefined();
    expect(other.cookie).toBeUndefined();
    expect(other['x-extra']).toBe('sim');

    allow(`127.0.0.1:${a}`, `127.0.0.1:${s}`);
    expect((await downloadToBuffer(`https://127.0.0.1:${s}/file`, { maxBytes: 100 })).data.toString()).toBe('seguro');
    await expect(downloadToBuffer(`https://127.0.0.1:${s}/to-http`, { maxBytes: 100 })).rejects.toThrow('Redirecionamento de https para http recusado.');
  });

  it('limite de tamanho pelo content-length e pelos bytes recebidos, sem deixar arquivo parcial', async () => {
    allow(`127.0.0.1:${a}`);
    for (const route of ['big', 'chunked-big']) {
      const p = dest(`${route}.bin`);
      await expect(downloadToFile(`http://127.0.0.1:${a}/${route}`, p, { maxBytes: 1000 })).rejects.toThrow('O arquivo passa do tamanho máximo (1000 bytes).');
      expect(exists(p)).toBe(false);
    }
    await expect(downloadToBuffer(`http://127.0.0.1:${a}/chunked-big`, { maxBytes: 1024 })).rejects.toThrow('O arquivo passa do tamanho máximo (1 KB).');
    expect((await downloadToBuffer(`http://127.0.0.1:${a}/big`, { maxBytes: 5000 })).data.length).toBe(5000);
  });

  it('tempo limite total, sem resposta, parado no meio e cancelamento', async () => {
    allow(`127.0.0.1:${a}`);
    const p = dest('slow.bin');
    await expect(downloadToFile(`http://127.0.0.1:${a}/silent`, p, { maxBytes: 1000, idleTimeoutMs: 200 })).rejects.toThrow('O servidor parou de responder.');
    await expect(downloadToFile(`http://127.0.0.1:${a}/stall`, p, { maxBytes: 1000, idleTimeoutMs: 200 })).rejects.toThrow('O servidor parou de responder.');
    expect(exists(p)).toBe(false);
    const t0 = Date.now();
    await expect(downloadToFile(`http://127.0.0.1:${a}/trickle`, p, { maxBytes: 1_000_000, timeoutMs: 300 })).rejects.toThrow('O download demorou demais e foi interrompido.');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(exists(p)).toBe(false);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    await expect(downloadToFile(`http://127.0.0.1:${a}/trickle`, p, { maxBytes: 1_000_000, signal: ctl.signal })).rejects.toThrow('Download cancelado.');
    expect(exists(p)).toBe(false);
  });

  it('resposta fora de 2xx e download incompleto', async () => {
    allow(`127.0.0.1:${a}`);
    const p = dest('err.bin');
    await expect(downloadToFile(`http://127.0.0.1:${a}/missing`, p, { maxBytes: 1000 })).rejects.toThrow('O servidor respondeu 404.');
    await expect(downloadToFile(`http://127.0.0.1:${a}/outra`, p, { maxBytes: 1000 })).rejects.toThrow('O servidor respondeu 500.');
    await expect(downloadToFile(`http://127.0.0.1:${a}/truncated`, p, { maxBytes: 1000 })).rejects.toThrow(/incompleto|conexão caiu/);
    expect(exists(p)).toBe(false);
  });
});
