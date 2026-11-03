import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

// ZIP só com armazenamento (método 0), escrito à mão: pacotes de figurinhas, "Exportar mensagens" e "Baixar meus
// dados". Sem ZIP64: quem chama limita o tamanho (os arquivos de uma exportação vão até 3.500 MB) para ficar longe
// dos limites de 65.535 entradas e 4 GiB; passar deles aborta o fluxo com erro em vez de gerar um ZIP corrompido.
//
// Duas formas de entrada:
// - data: os bytes já prontos. O cabeçalho local leva CRC e tamanho.
// - stream: os bytes chegam aos pedaços (um arquivo do disco, um documento gerado página a página). O cabeçalho local
//   sai com CRC e tamanho zerados e o bit 3 ligado; os valores vêm depois dos dados, no descritor (data descriptor),
//   e no diretório central. O CRC é calculado aos poucos (zlib.crc32 com o valor anterior).

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const UTF8 = 0x0800; // nomes em UTF-8
const DESCRIPTOR = 0x0008; // CRC e tamanhos no descritor depois dos dados

export interface ZipEntry {
  name: string;
  data?: Uint8Array;
  stream?: AsyncIterable<Uint8Array | string>;
  mtime?: Date;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

interface Central {
  name: Buffer;
  flags: number;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const tooBig = () => new Error('ZIP grande demais');

function localHeader(name: Buffer, flags: number, time: number, date: number, crc: number, size: number) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // versão necessária
  h.writeUInt16LE(flags, 6);
  h.writeUInt16LE(0, 8); // armazenado
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name]);
}

// O fluxo da entrada, se ainda estiver aberto, é fechado quando a entrada termina ou o ZIP é abortado (o arquivo do
// disco não fica com o descritor aberto quando o navegador cancela o download).
function closeSource(s: unknown) {
  const d = (s as { destroy?: () => void } | undefined)?.destroy;
  if (typeof d === 'function') d.call(s);
}

export function zipStore(entries: AsyncIterable<ZipEntry>): Readable {
  async function* generate() {
    const central: Central[] = [];
    let offset = 0;
    for await (const e of entries) {
      try {
        if (central.length >= MAX_ENTRIES) throw new Error('ZIP com entradas demais');
        const name = Buffer.from(e.name, 'utf8');
        const { time, date } = dosTime(e.mtime ?? new Date());
        if (e.stream) {
          const flags = UTF8 | DESCRIPTOR;
          const start = offset;
          const head = localHeader(name, flags, time, date, 0, 0);
          offset += head.length;
          yield head;
          let crc = 0;
          let size = 0;
          for await (const chunk of e.stream) {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (!buf.length) continue;
            size += buf.length;
            offset += buf.length;
            if (offset + 16 > MAX_OFFSET) throw tooBig();
            crc = crc32(buf, crc);
            yield buf;
          }
          const dd = Buffer.alloc(16);
          dd.writeUInt32LE(0x08074b50, 0);
          dd.writeUInt32LE(crc, 4);
          dd.writeUInt32LE(size, 8);
          dd.writeUInt32LE(size, 12);
          offset += dd.length;
          central.push({ name, flags, crc, size, offset: start, time, date });
          yield dd;
        } else {
          const data = e.data ?? new Uint8Array();
          const crc = crc32(data);
          const size = data.length;
          if (offset + 30 + name.length + size > MAX_OFFSET) throw tooBig();
          const head = localHeader(name, UTF8, time, date, crc, size);
          central.push({ name, flags: UTF8, crc, size, offset, time, date });
          offset += head.length + size;
          yield head;
          yield Buffer.from(data.buffer, data.byteOffset, data.length);
        }
      } finally {
        closeSource(e.stream);
      }
    }
    const start = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // feito por
      h.writeUInt16LE(20, 6); // versão necessária
      h.writeUInt16LE(c.flags, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.size, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28);
      // extra, comentário, disco, atributos internos e externos: zero
      h.writeUInt32LE(c.offset, 42);
      offset += h.length + c.name.length;
      if (offset > MAX_OFFSET) throw tooBig();
      yield Buffer.concat([h, c.name]);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    yield end;
  }
  return Readable.from(generate(), { objectMode: false });
}
