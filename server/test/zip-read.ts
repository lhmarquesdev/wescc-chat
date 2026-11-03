import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

// Lê um .zip inteiro com o yauzl (o mesmo leitor da importação). O yauzl confere os tamanhos de cada entrada contra o
// diretório central; o CRC é conferido aqui, contra o que o ZIP declara.
export interface UnzippedEntry {
  name: string;
  data: Buffer;
  crc32: number;
  flags: number;
}

export function unzip(buf: Buffer): Promise<UnzippedEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: UnzippedEntry[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (e: yauzl.Entry) => {
        zip.openReadStream(e, (err2, s) => {
          if (err2 || !s) return reject(err2);
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          s.on('error', reject);
          s.on('end', () => {
            const data = Buffer.concat(chunks);
            if (crc32(data) !== e.crc32) return reject(new Error(`CRC diferente em ${e.fileName}`));
            out.push({ name: e.fileName, data, crc32: e.crc32, flags: e.generalPurposeBitFlag });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks);
}
