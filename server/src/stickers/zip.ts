import { Readable } from 'node:stream';
import { crc32 } from '@shared/imageProbe';

// ZIP só com armazenamento (método 0), escrito à mão para a exportação de pacotes. Sem ZIP64: o maior pacote
// possível (500 × 1 MB) fica longe dos limites de 65.535 entradas e 4 GiB.

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

interface Central {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export function zipStore(entries: AsyncIterable<{ name: string; data: Uint8Array; mtime?: Date }>): Readable {
  async function* generate() {
    const central: Central[] = [];
    let offset = 0;
    for await (const e of entries) {
      if (central.length >= MAX_ENTRIES) throw new Error('ZIP com entradas demais');
      const name = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(e.mtime ?? new Date());
      const crc = crc32(e.data);
      const size = e.data.length;
      if (offset + 30 + name.length + size > MAX_OFFSET) throw new Error('ZIP grande demais');
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4); // versão necessária
      h.writeUInt16LE(0x0800, 6); // nomes em UTF-8
      h.writeUInt16LE(0, 8); // armazenado
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(size, 18);
      h.writeUInt32LE(size, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(0, 28);
      central.push({ name, crc, size, offset, time, date });
      offset += h.length + name.length + size;
      yield Buffer.concat([h, name]);
      yield Buffer.from(e.data.buffer, e.data.byteOffset, e.data.length);
    }
    const start = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // feito por
      h.writeUInt16LE(20, 6); // versão necessária
      h.writeUInt16LE(0x0800, 8);
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
      if (offset > MAX_OFFSET) throw new Error('ZIP grande demais');
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
