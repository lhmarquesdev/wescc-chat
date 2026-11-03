import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { zipStore, type ZipEntry } from '../src/lib/zip';
import { readAll, unzip } from './zip-read';

// O ZIP escrito à mão (server/src/lib/zip.ts): entradas prontas (figurinhas) e em fluxo (exportações), com o
// descritor de dados depois de cada entrada em fluxo.

async function* list(items: ZipEntry[]) {
  for (const i of items) yield i;
}

// Pedaços de 64 KB, como o fs.createReadStream entrega.
function chunked(buf: Buffer, size = 64 * 1024) {
  return Readable.from(
    (function* () {
      for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
    })(),
  );
}

describe('zip (lib/zip.ts)', () => {
  it('entradas prontas e em fluxo abrem no yauzl com o mesmo conteúdo', async () => {
    const small = Buffer.from('{"format":"teste"}');
    const big = crypto.randomBytes(5 * 1024 * 1024);
    const doc = ['<p>a</p>', '<p>b</p>', ''];
    const zip = await readAll(
      zipStore(
        list([
          { name: 'pronto.json', data: small },
          { name: 'grande.bin', stream: chunked(big) },
          { name: 'doc.html', stream: Readable.from(doc) },
        ]),
      ),
    );
    const entries = await unzip(zip);
    expect(entries.map((e) => e.name)).toEqual(['pronto.json', 'grande.bin', 'doc.html']);
    expect(entries[0].data.equals(small)).toBe(true);
    expect(entries[1].data.equals(big)).toBe(true);
    expect(entries[2].data.toString()).toBe('<p>a</p><p>b</p>');
    // Pronta: sem descritor. Em fluxo: bit 3 ligado (CRC e tamanhos depois dos dados).
    expect(entries[0].flags & 0x0008).toBe(0);
    expect(entries[1].flags & 0x0008).toBe(0x0008);
    // O descritor fica logo depois dos dados da entrada em fluxo.
    const sig = Buffer.alloc(4);
    sig.writeUInt32LE(0x08074b50);
    expect(zip.indexOf(sig)).toBeGreaterThan(big.length);
  });

  it('nomes em UTF-8', async () => {
    const zip = await readAll(zipStore(list([{ name: 'arquivos/ação.pdf', stream: Readable.from([Buffer.from('%PDF')]) }, { name: 'relatório.txt', data: Buffer.from('ok') }])));
    const entries = await unzip(zip);
    expect(entries.map((e) => e.name)).toEqual(['arquivos/ação.pdf', 'relatório.txt']);
    expect(entries.every((e) => (e.flags & 0x0800) === 0x0800)).toBe(true);
  });

  it('entrada que falha no meio aborta o stream', async () => {
    async function* failing() {
      yield Buffer.alloc(1000, 1);
      throw new Error('disco saiu do ar');
    }
    const out = zipStore(list([{ name: 'a.txt', data: Buffer.from('a') }, { name: 'b.bin', stream: failing() }]));
    await expect(readAll(out)).rejects.toThrow('disco saiu do ar');
  });

  it('cancelar o download fecha o arquivo que estava sendo lido', async () => {
    const src = chunked(crypto.randomBytes(1024 * 1024), 1024);
    const out = zipStore(list([{ name: 'a.bin', stream: src }]));
    for await (const _ of out) break; // o primeiro pedaço (cabeçalho) e para
    await new Promise((r) => setImmediate(r));
    expect(src.destroyed).toBe(true);
  });
});
