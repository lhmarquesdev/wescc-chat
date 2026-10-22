// Figurinhas: arquivos minúsculos de PNG/APNG, GIF, WebP e JPEG montados no código (nenhum binário no repositório).
// O leitor nunca decodifica pixels, então o VP8 com perda só precisa de um cabeçalho de quadro válido.
import zlib from 'node:zlib';
import { crc32 as probeCrc32 } from '@shared/imageProbe';

type Raw = Uint8Array | string | number[];

export function bytes(...parts: Raw[]): Buffer {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
}

export const be32 = (v: number) => bytes([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
export const le32 = (v: number) => bytes([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
export const le24 = (v: number) => bytes([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]);
export const le16 = (v: number) => bytes([v & 0xff, (v >>> 8) & 0xff]);
export const be16 = (v: number) => bytes([(v >>> 8) & 0xff, v & 0xff]);

// CRC de referência independente do leitor quando o Node tem zlib.crc32.
const refCrc = (b: Uint8Array) => (typeof zlib.crc32 === 'function' ? zlib.crc32(b) : probeCrc32(b)) >>> 0;

// Gerador pseudoaleatório com semente fixa (mulberry32), para testes reproduzíveis.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(n: number, seed: number): Buffer {
  const r = rng(seed);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 256);
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- PNG / APNG ----------

export function pngChunk(type: string, data: Raw = []): Buffer {
  const body = bytes(type, data);
  return bytes(be32(body.length - 4), body, be32(refCrc(body)));
}

export interface PngOpts {
  w: number;
  h: number;
  alpha?: boolean;
  frames?: number; // > 1 = APNG
  delaysMs?: number[]; // por quadro (delay_den = 1000)
  delays?: [number, number][]; // [delay_num, delay_den] crus, para testar delay_den 0
  loops?: number; // num_plays
  actlFrames?: number; // num_frames declarado, quando deve diferir da quantidade de fcTL
  frameRect?: Rect; // retângulo do último quadro
  text?: string; // bloco tEXt
  exif?: boolean; // bloco eXIf
  privateChunk?: boolean; // bloco auxiliar privado (prVt)
  noIdat?: boolean;
  noise?: boolean; // pixels aleatórios: o arquivo fica do tamanho dos pixels
  seed?: number;
  trailing?: Raw;
}

function pngPixels(w: number, h: number, bpp: number, seed: number, noise: boolean): Buffer {
  const row = 1 + w * bpp;
  const raw = noise ? randomBytes(row * h, seed) : Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0; // filtro "nenhum"
    if (!noise) for (let i = 0; i < Math.min(bpp, 3); i++) raw[y * row + 1 + i] = (seed * (37 + i * 59) + y) & 0xff;
  }
  return zlib.deflateSync(raw);
}

export function png(o: PngOpts): Buffer {
  const bpp = o.alpha ? 4 : 3;
  const seed = o.seed ?? 1;
  const frames = o.frames ?? 1;
  const parts: Buffer[] = [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(pngChunk('IHDR', bytes(be32(o.w), be32(o.h), [8, o.alpha ? 6 : 2, 0, 0, 0])));
  if (o.text !== undefined) parts.push(pngChunk('tEXt', bytes('Comment\0', o.text)));
  if (o.exif) parts.push(pngChunk('eXIf', bytes('MM\0*\0\0\0\x08', 'GPS -23.5505,-46.6333')));
  if (o.privateChunk) parts.push(pngChunk('prVt', 'dados escondidos'));
  const rect = (i: number): Rect => (i === frames - 1 && o.frameRect ? o.frameRect : { x: 0, y: 0, w: o.w, h: o.h });
  const delay = (i: number): [number, number] => o.delays?.[i] ?? [o.delaysMs?.[i] ?? 100, 1000];
  let seq = 0;
  const fctl = (i: number) => {
    const r = rect(i);
    const [num, den] = delay(i);
    return pngChunk('fcTL', bytes(be32(seq++), be32(r.w), be32(r.h), be32(r.x), be32(r.y), be16(num), be16(den), [0, 0]));
  };
  if (frames > 1 || o.actlFrames !== undefined) {
    parts.push(pngChunk('acTL', bytes(be32(o.actlFrames ?? frames), be32(o.loops ?? 0))));
    parts.push(fctl(0));
  }
  if (!o.noIdat) parts.push(pngChunk('IDAT', pngPixels(rect(0).w, rect(0).h, bpp, seed, !!o.noise)));
  for (let i = 1; i < frames; i++) {
    parts.push(fctl(i));
    parts.push(pngChunk('fdAT', bytes(be32(seq++), pngPixels(rect(i).w, rect(i).h, bpp, seed + i, !!o.noise))));
  }
  parts.push(pngChunk('IEND'));
  if (o.trailing !== undefined) parts.push(bytes(o.trailing));
  return Buffer.concat(parts);
}

// Posição do primeiro bloco do tipo pedido (início do campo de tamanho), ou -1.
export function findPngChunk(b: Uint8Array, type: string): number {
  let o = 8;
  while (o + 8 <= b.length) {
    const len = Buffer.from(b.buffer, b.byteOffset, b.length).readUInt32BE(o);
    if (Buffer.from(b.subarray(o + 4, o + 8)).toString('latin1') === type) return o;
    o += 12 + len;
  }
  return -1;
}

// ---------- GIF ----------

export interface GifOpts {
  w: number;
  h: number;
  frames: number;
  delaysCs?: number[];
  comment?: string;
  loops?: number; // com valor: extensão NETSCAPE2.0
  transparent?: boolean;
  frameRect?: Rect; // retângulo do último quadro
  xmp?: string; // extensão de aplicativo "XMP DataXMP" (deve sumir)
  noTrailer?: boolean;
  dataBytes?: number; // bytes extras nos sub-blocos de cada quadro
  seed?: number;
  trailing?: Raw;
}

function subBlocks(data: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    parts.push(bytes([piece.length], piece));
  }
  parts.push(bytes([0]));
  return Buffer.concat(parts);
}

export function gif(o: GifOpts): Buffer {
  const seed = o.seed ?? 1;
  const palette = randomBytes(12, seed); // 4 cores
  const parts: Buffer[] = [bytes('GIF89a', le16(o.w), le16(o.h), [0xf1, 0, 0], palette)];
  if (o.loops !== undefined) parts.push(bytes([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1], le16(o.loops), [0]));
  if (o.comment !== undefined) parts.push(bytes([0x21, 0xfe], subBlocks(bytes(o.comment))));
  if (o.xmp !== undefined) parts.push(bytes([0x21, 0xff, 11], 'XMP DataXMP', subBlocks(bytes(o.xmp))));
  for (let i = 0; i < o.frames; i++) {
    if (o.frames > 1 || o.delaysCs || o.transparent) {
      parts.push(bytes([0x21, 0xf9, 4, o.transparent ? 0x01 : 0x00], le16(o.delaysCs?.[i] ?? 10), [0, 0]));
    }
    const r = i === o.frames - 1 && o.frameRect ? o.frameRect : { x: 0, y: 0, w: o.w, h: o.h };
    // LZW com código mínimo 2: limpar (4), um pixel, fim (5).
    const lzw = bytes([0x04 | (((seed + i) & 3) << 3) | 0x40, 0x01], o.dataBytes ? randomBytes(o.dataBytes, seed + i) : []);
    parts.push(bytes([0x2c], le16(r.x), le16(r.y), le16(r.w), le16(r.h), [0, 2], subBlocks(lzw)));
  }
  if (!o.noTrailer) parts.push(bytes([0x3b]));
  if (o.trailing !== undefined) parts.push(bytes(o.trailing));
  return Buffer.concat(parts);
}

// ---------- WebP ----------

export function riffChunk(fourcc: string, data: Raw = []): Buffer {
  const body = bytes(data);
  return bytes(fourcc, le32(body.length), body, body.length & 1 ? [0] : []);
}

// Arquivo RIFF/WebP montado à mão a partir de blocos já prontos (para cabeçalhos hostis).
export function webpFile(...chunks: Raw[]): Buffer {
  const body = bytes(...chunks);
  return bytes('RIFF', le32(body.length + 4), 'WEBP', body);
}

export function vp8Bitstream(w: number, h: number, seed = 1, extra = 0): Buffer {
  const payload = randomBytes(6 + extra, seed);
  const tag = (1 << 4) | (payload.length << 5); // quadro-chave, versão 0, show_frame
  return bytes([tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff, 0x9d, 0x01, 0x2a], le16(w & 0x3fff), le16(h & 0x3fff), payload);
}

export function vp8lBitstream(w: number, h: number, alpha = false, seed = 1, extra = 0): Buffer {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return bytes([0x2f], le32(v >>> 0), randomBytes(7 + extra, seed));
}

export interface WebpOpts {
  kind: 'vp8' | 'vp8l' | 'vp8x';
  w: number;
  h: number;
  alpha?: boolean;
  frames?: number; // vp8x: quantidade de ANMF (> 1 liga a animação)
  durationsMs?: number[];
  loops?: number;
  animated?: boolean; // força a marca de animação do VP8X (com frames 0: animada sem ANMF)
  frameRect?: Rect; // retângulo do último quadro (x e y pares)
  streamSize?: { w: number; h: number }; // tamanho do fluxo do último quadro, quando deve diferir do ANMF
  exif?: boolean;
  xmp?: boolean;
  icc?: boolean;
  unknownChunk?: boolean;
  anmfJunk?: boolean; // bloco desconhecido dentro de cada ANMF (deve sumir)
  noImage?: boolean; // VP8X parado sem bloco de imagem
  dataBytes?: number; // bytes extras no fluxo de imagem
  seed?: number;
  trailing?: Raw;
}

export function webp(o: WebpOpts): Buffer {
  const seed = o.seed ?? 1;
  const extra = o.dataBytes ?? 0;
  const chunks: Buffer[] = [];
  if (o.kind === 'vp8') chunks.push(riffChunk('VP8 ', vp8Bitstream(o.w, o.h, seed, extra)));
  else if (o.kind === 'vp8l') chunks.push(riffChunk('VP8L', vp8lBitstream(o.w, o.h, !!o.alpha, seed, extra)));
  else {
    const frames = o.frames ?? 0;
    const anim = o.animated ?? frames > 1;
    const flags = (o.icc ? 0x20 : 0) | (o.alpha ? 0x10 : 0) | (o.exif ? 0x08 : 0) | (o.xmp ? 0x04 : 0) | (anim ? 0x02 : 0);
    chunks.push(riffChunk('VP8X', bytes([flags, 0, 0, 0], le24(o.w - 1), le24(o.h - 1))));
    if (o.icc) chunks.push(riffChunk('ICCP', bytes('perfil de cor fictício', randomBytes(5, seed))));
    if (anim) {
      chunks.push(riffChunk('ANIM', bytes([255, 255, 255, 0], le16(o.loops ?? 0))));
      for (let i = 0; i < frames; i++) {
        const r = i === frames - 1 && o.frameRect ? o.frameRect : { x: 0, y: 0, w: o.w, h: o.h };
        const s = i === frames - 1 && o.streamSize ? o.streamSize : r;
        const header = bytes(le24(r.x / 2), le24(r.y / 2), le24(r.w - 1), le24(r.h - 1), le24(o.durationsMs?.[i] ?? 100), [0]);
        const junk = o.anmfJunk ? riffChunk('JUNK', 'lixo no quadro') : bytes();
        chunks.push(riffChunk('ANMF', bytes(header, junk, riffChunk('VP8L', vp8lBitstream(s.w, s.h, !!o.alpha, seed + i, extra)))));
      }
    } else if (!o.noImage) {
      chunks.push(riffChunk('VP8L', vp8lBitstream(o.w, o.h, !!o.alpha, seed, extra)));
    }
    if (o.exif) chunks.push(riffChunk('EXIF', bytes('Exif\0\0MM', 'GPS -23.55,-46.63!')));
    if (o.xmp) chunks.push(riffChunk('XMP ', '<x:xmpmeta>autor</x:xmpmeta>'));
  }
  if (o.unknownChunk) chunks.push(riffChunk('ZZZZ', 'bloco desconhecido'));
  const body = Buffer.concat(chunks);
  return bytes('RIFF', le32(body.length + 4), 'WEBP', body, o.trailing ?? []);
}

// ---------- JPEG (só o editor aceita) ----------

export function jpeg(o: { w: number; h: number; app1Bytes?: number }): Buffer {
  const parts: Buffer[] = [bytes([0xff, 0xd8])];
  parts.push(bytes([0xff, 0xe0], be16(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (o.app1Bytes) parts.push(bytes([0xff, 0xe1], be16(o.app1Bytes + 2), randomBytes(o.app1Bytes, 7)));
  parts.push(bytes([0xff, 0xc0], be16(17), [8], be16(o.h), be16(o.w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(bytes([0xff, 0xd9]));
  return Buffer.concat(parts);
}
