// Leitura de cabeçalhos de PNG/APNG, GIF, WebP e JPEG sem decodificar pixels, e remontagem canônica do arquivo.
// É a fronteira de segurança das figurinhas: toda leitura confere os limites do buffer e qualquer coisa fora do
// esperado vira ProbeError, nunca outra exceção.

export type ProbeMime = 'image/webp' | 'image/png' | 'image/gif' | 'image/jpeg';
export type ProbeFormat = 'webp' | 'png' | 'apng' | 'gif' | 'jpeg';

export interface ImageProbe {
  mime: ProbeMime;
  format: ProbeFormat;
  width: number;
  height: number;
  animated: boolean;
  frames: number; // 1 para estáticas
  durationMs: number; // 0 para estáticas; soma dos atrasos de um ciclo
  loops: number; // 0 = infinito
  alpha: boolean | null; // null quando o cabeçalho não diz (JPEG = false)
}

const REASON_TEXT = {
  format: 'Formato de imagem não suportado.',
  corrupt: 'Arquivo de imagem corrompido.',
  'too-many-frames': 'A animação tem quadros demais.',
} as const;

export class ProbeError extends Error {
  constructor(
    public reason: 'format' | 'corrupt' | 'too-many-frames',
    message?: string,
  ) {
    super(message ?? REASON_TEXT[reason]);
    this.name = 'ProbeError';
  }
}

const DEFAULT_MAX_FRAMES = 200;

const corrupt = () => new ProbeError('corrupt');
const tooManyFrames = () => new ProbeError('too-many-frames');

// ---------- Leitura com limites ----------

function need(b: Uint8Array, o: number, n: number): void {
  if (!(o >= 0 && n >= 0 && o + n <= b.length)) throw corrupt();
}
function u8(b: Uint8Array, o: number): number {
  need(b, o, 1);
  return b[o];
}
function u16le(b: Uint8Array, o: number): number {
  need(b, o, 2);
  return b[o] | (b[o + 1] << 8);
}
function u16be(b: Uint8Array, o: number): number {
  need(b, o, 2);
  return (b[o] << 8) | b[o + 1];
}
function u24le(b: Uint8Array, o: number): number {
  need(b, o, 3);
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}
function u32le(b: Uint8Array, o: number): number {
  need(b, o, 4);
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function u32be(b: Uint8Array, o: number): number {
  need(b, o, 4);
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function ascii(b: Uint8Array, o: number, n: number): string {
  need(b, o, n);
  let s = '';
  for (let i = o; i < o + n; i++) s += String.fromCharCode(b[i]);
  return s;
}
function startsWith(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((x, i) => b[i] === x);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function le32(v: number): Uint8Array {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function asciiBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// Atrasos de até 10 ms tocam como 100 ms no Chrome e no Firefox; contar como tocam impede driblar o limite de duração.
const frameMs = (ms: number) => (ms <= 10 ? 100 : ms);

// ---------- CRC-32 ----------

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (CRC_TABLE = t);
}

// CRC-32 (IEEE), com tabela. Também usado pelo ZIP (zipRead.ts e server/src/stickers/zip.ts).
export function crc32(b: Uint8Array, start = 0, end = b.length): number {
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= b.length)) throw corrupt();
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- Tipo pelo conteúdo ----------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function sniffMime(b: Uint8Array): ProbeMime | null {
  if (startsWith(b, PNG_SIG)) return 'image/png';
  if (b.length >= 6) {
    const sig = ascii(b, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

// ---------- PNG / APNG ----------

interface PngChunk {
  type: string;
  start: number; // início do campo de tamanho
  data: number;
  length: number;
  end: number; // depois do CRC
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'IDAT', 'IEND']);
const PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);
const isCriticalPng = (type: string) => type.charCodeAt(0) < 0x60; // primeira letra maiúscula

function parsePng(b: Uint8Array, maxFrames: number): { probe: ImageProbe; chunks: PngChunk[] } {
  if (!startsWith(b, PNG_SIG)) throw new ProbeError('format');
  const chunks: PngChunk[] = [];
  let width = 0;
  let height = 0;
  let alpha = false;
  let idat = false;
  let actl: { frames: number; plays: number } | null = null;
  let fctl = 0;
  let delay = 0;
  let o: number = PNG_SIG.length;
  for (;;) {
    const length = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) throw corrupt();
    const data = o + 8;
    need(b, data, length + 4);
    const c: PngChunk = { type, start: o, data, length, end: data + length + 4 };
    if ((chunks.length === 0) !== (type === 'IHDR')) throw corrupt(); // IHDR primeiro, e uma vez só
    chunks.push(c);
    switch (type) {
      case 'IHDR': {
        if (length !== 13) throw corrupt();
        width = u32be(b, data);
        height = u32be(b, data + 4);
        const colorType = b[data + 9];
        if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !PNG_COLOR_TYPES.has(colorType)) throw corrupt();
        alpha = colorType === 4 || colorType === 6;
        break;
      }
      case 'tRNS':
        alpha = true;
        break;
      case 'acTL': {
        // Depois do primeiro IDAT o navegador ignora a animação: aceitar seria validar outra coisa.
        if (length !== 8 || idat || actl) throw corrupt();
        const frames = u32be(b, data);
        if (!frames) throw corrupt();
        if (frames > maxFrames) throw tooManyFrames();
        actl = { frames, plays: u32be(b, data + 4) };
        break;
      }
      case 'fcTL': {
        if (length !== 26 || !actl) throw corrupt();
        if (++fctl > maxFrames) throw tooManyFrames();
        if (fctl > actl.frames) throw corrupt();
        const w = u32be(b, data + 4);
        const h = u32be(b, data + 8);
        const x = u32be(b, data + 12);
        const y = u32be(b, data + 16);
        const num = u16be(b, data + 20);
        const den = u16be(b, data + 22);
        if (!w || !h || x + w > width || y + h > height) throw corrupt();
        delay += frameMs((num * 1000) / (den || 100));
        break;
      }
      case 'fdAT':
        if (!actl || !fctl) throw corrupt();
        break;
      case 'IDAT':
        idat = true;
        break;
      case 'PLTE':
        break;
      case 'IEND':
        if (length !== 0) throw corrupt();
        break;
      default:
        if (isCriticalPng(type)) throw corrupt();
    }
    if (type === 'IEND') break;
    o = c.end;
  }
  if (!idat) throw corrupt();
  if (actl && fctl !== actl.frames) throw corrupt(); // senão o navegador toca outra animação
  const animated = !!actl && actl.frames > 1;
  return {
    probe: {
      mime: 'image/png',
      format: animated ? 'apng' : 'png',
      width,
      height,
      animated,
      frames: animated ? actl!.frames : 1,
      durationMs: animated ? Math.round(delay) : 0,
      loops: animated ? actl!.plays : 0,
      alpha,
    },
    chunks,
  };
}

function canonicalPng(b: Uint8Array): Uint8Array {
  const { chunks } = parsePng(b, Infinity);
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIG)];
  for (const c of chunks) {
    if (!PNG_KEEP.has(c.type)) continue; // críticos desconhecidos já foram recusados por parsePng
    const crcAt = c.data + c.length;
    if (crc32(b, c.start + 4, crcAt) !== u32be(b, crcAt)) throw corrupt();
    parts.push(b.subarray(c.start, c.end));
  }
  return concat(parts);
}

// ---------- GIF ----------

type GifBlock =
  | { kind: 'gce'; packed: number; delay: number; transparentIndex: number }
  | { kind: 'loop'; id: string; loops: number } // NETSCAPE2.0 / ANIMEXTS1.0 com o sub-bloco de repetição
  | { kind: 'image'; start: number; end: number }
  | { kind: 'drop' }; // comentário, texto simples, outras extensões

const GIF_LOOP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

const colorTableSize = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);

// Pula sub-blocos (tamanho + dados) até o terminador 0; devolve a posição depois dele.
function subBlocksEnd(b: Uint8Array, o: number): number {
  for (;;) {
    const n = u8(b, o);
    o += 1;
    if (n === 0) return o;
    need(b, o, n);
    o += n;
  }
}

function parseGif(b: Uint8Array, maxFrames: number): { probe: ImageProbe; headerEnd: number; blocks: GifBlock[] } {
  const sig = b.length >= 6 ? ascii(b, 0, 6) : '';
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new ProbeError('format');
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  if (!width || !height) throw corrupt();
  const headerEnd = 13 + colorTableSize(u8(b, 10));
  need(b, 13, headerEnd - 13);
  const blocks: GifBlock[] = [];
  let frames = 0;
  let alpha = false;
  let pendingDelay = 0;
  let delay = 0;
  let loops: number | null = null;
  let o = headerEnd;
  while (o < b.length) {
    const t = b[o];
    if (t === 0x3b) break; // trailer: o resto do arquivo é ignorado
    if (t === 0x21) {
      const label = u8(b, o + 1);
      const end = subBlocksEnd(b, o + 2);
      if (label === 0xf9) {
        if (u8(b, o + 2) < 4) throw corrupt();
        const packed = u8(b, o + 3);
        pendingDelay = u16le(b, o + 4);
        if (packed & 1) alpha = true;
        blocks.push({ kind: 'gce', packed, delay: pendingDelay, transparentIndex: u8(b, o + 6) });
      } else if (label === 0xff && u8(b, o + 2) === 11 && GIF_LOOP_APPS.has(ascii(b, o + 3, 11))) {
        const id = ascii(b, o + 3, 11);
        let found: number | null = null;
        for (let s = o + 14; s < end - 1; ) {
          const n = b[s];
          if (found === null && n >= 3 && b[s + 1] === 1) found = u16le(b, s + 2);
          s += 1 + n;
        }
        if (found !== null) {
          if (loops === null) loops = found;
          blocks.push({ kind: 'loop', id, loops: found });
        } else blocks.push({ kind: 'drop' });
      } else blocks.push({ kind: 'drop' });
      o = end;
      continue;
    }
    if (t === 0x2c) {
      const x = u16le(b, o + 1);
      const y = u16le(b, o + 3);
      const w = u16le(b, o + 5);
      const h = u16le(b, o + 7);
      const lct = colorTableSize(u8(b, o + 9));
      if (!w || !h || x + w > width || y + h > height) throw corrupt();
      if (++frames > maxFrames) throw tooManyFrames();
      need(b, o + 10, lct + 1); // tabela local e tamanho mínimo do código LZW
      const end = subBlocksEnd(b, o + 11 + lct);
      blocks.push({ kind: 'image', start: o, end });
      delay += frameMs(pendingDelay * 10);
      pendingDelay = 0;
      o = end;
      continue;
    }
    throw corrupt();
  }
  if (!frames) throw corrupt();
  const animated = frames > 1;
  return {
    probe: {
      mime: 'image/gif',
      format: 'gif',
      width,
      height,
      animated,
      frames,
      durationMs: animated ? delay : 0,
      loops: animated ? (loops ?? 1) : 0, // sem NETSCAPE2.0 o GIF toca uma vez
      alpha,
    },
    headerEnd,
    blocks,
  };
}

function canonicalGif(b: Uint8Array): Uint8Array {
  const { headerEnd, blocks } = parseGif(b, Infinity);
  const parts: Uint8Array[] = [b.subarray(0, headerEnd)];
  for (const k of blocks) {
    // Extensões reescritas na forma mínima: sub-blocos extras não levam dados escondidos.
    if (k.kind === 'gce') parts.push(Uint8Array.of(0x21, 0xf9, 4, k.packed, k.delay & 0xff, k.delay >> 8, k.transparentIndex, 0));
    else if (k.kind === 'loop') parts.push(Uint8Array.of(0x21, 0xff, 11), asciiBytes(k.id), Uint8Array.of(3, 1, k.loops & 0xff, k.loops >> 8, 0));
    else if (k.kind === 'image') parts.push(b.subarray(k.start, k.end));
  }
  parts.push(Uint8Array.of(0x3b));
  return concat(parts);
}

// ---------- WebP ----------

interface RiffChunk {
  fourcc: string;
  start: number;
  data: number;
  size: number;
}

function riffChunks(b: Uint8Array, from: number, end: number): RiffChunk[] {
  const out: RiffChunk[] = [];
  let o = from;
  while (o < end) {
    if (o + 8 > end) throw corrupt();
    const fourcc = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    const data = o + 8;
    if (size > end - data) throw corrupt();
    out.push({ fourcc, start: o, data, size });
    o = Math.min(data + size + (size & 1), end); // o último bloco ímpar pode vir sem o byte de alinhamento
  }
  return out;
}

// Dimensões de um fluxo VP8 (com perda) ou VP8L (sem perda).
function bitstreamInfo(b: Uint8Array, c: RiffChunk): { width: number; height: number; alpha: boolean } {
  if (c.fourcc === 'VP8 ') {
    if (c.size < 10 || u8(b, c.data + 3) !== 0x9d || u8(b, c.data + 4) !== 0x01 || u8(b, c.data + 5) !== 0x2a) throw corrupt();
    const width = u16le(b, c.data + 6) & 0x3fff;
    const height = u16le(b, c.data + 8) & 0x3fff;
    if (!width || !height) throw corrupt();
    return { width, height, alpha: false };
  }
  if (c.size < 5 || u8(b, c.data) !== 0x2f) throw corrupt();
  const v = u32le(b, c.data + 1);
  if (v >>> 29 !== 0) throw corrupt(); // versão
  return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, alpha: !!((v >>> 28) & 1) };
}

const isBitstream = (fourcc: string) => fourcc === 'VP8 ' || fourcc === 'VP8L';

const VP8X_ANIM = 0x02;
const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;
const VP8X_ALPHA = 0x10;
const VP8X_ICC = 0x20;
const WEBP_KEEP = new Set(['ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L']);
const ANMF_KEEP = new Set(['ALPH', 'VP8 ', 'VP8L']);

function parseWebp(b: Uint8Array, maxFrames: number): { probe: ImageProbe; chunks: RiffChunk[] } {
  if (!(b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP')) throw new ProbeError('format');
  const riff = u32le(b, 4);
  if (riff < 4 || riff > b.length - 8) throw corrupt(); // RIFF maior que o arquivo = arquivo truncado
  const chunks = riffChunks(b, 12, 8 + riff);
  const first = chunks[0];
  if (!first) throw corrupt();
  const still = (width: number, height: number, alpha: boolean): ImageProbe => ({
    mime: 'image/webp',
    format: 'webp',
    width,
    height,
    animated: false,
    frames: 1,
    durationMs: 0,
    loops: 0,
    alpha,
  });
  if (isBitstream(first.fourcc)) {
    // Formato simples: só o primeiro bloco é decodificado.
    const info = bitstreamInfo(b, first);
    return { probe: still(info.width, info.height, info.alpha), chunks: [first] };
  }
  if (first.fourcc !== 'VP8X' || first.size !== 10) throw corrupt();
  const flags = b[first.data];
  const width = u24le(b, first.data + 4) + 1;
  const height = u24le(b, first.data + 7) + 1;
  const animFlag = !!(flags & VP8X_ANIM);
  const alpha = !!(flags & VP8X_ALPHA);
  let anim = false;
  let loops = 0;
  let frames = 0;
  let delay = 0;
  let image: { width: number; height: number } | null = null;
  for (const c of chunks.slice(1)) {
    switch (c.fourcc) {
      case 'VP8X':
        throw corrupt();
      case 'ANIM':
        if (!animFlag || c.size < 6) throw corrupt();
        anim = true;
        loops = u16le(b, c.data + 4);
        break;
      case 'ANMF': {
        if (!animFlag || !anim || c.size < 16) throw corrupt(); // ANIM vem antes dos quadros
        if (++frames > maxFrames) throw tooManyFrames();
        const x = u24le(b, c.data) * 2;
        const y = u24le(b, c.data + 3) * 2;
        const w = u24le(b, c.data + 6) + 1;
        const h = u24le(b, c.data + 9) + 1;
        if (x + w > width || y + h > height) throw corrupt();
        delay += frameMs(u24le(b, c.data + 12));
        const streams = riffChunks(b, c.data + 16, c.data + c.size).filter((s) => isBitstream(s.fourcc));
        if (streams.length !== 1) throw corrupt();
        const info = bitstreamInfo(b, streams[0]);
        if (info.width !== w || info.height !== h) throw corrupt();
        break;
      }
      case 'VP8 ':
      case 'VP8L':
        if (animFlag || image) throw corrupt();
        image = bitstreamInfo(b, c);
        break;
    }
  }
  if (animFlag) {
    if (!frames) throw corrupt();
    if (frames === 1) return { probe: still(width, height, alpha), chunks };
    return {
      probe: { mime: 'image/webp', format: 'webp', width, height, animated: true, frames, durationMs: delay, loops, alpha },
      chunks,
    };
  }
  if (!image || image.width !== width || image.height !== height) throw corrupt();
  return { probe: still(width, height, alpha), chunks };
}

function riffChunkBytes(fourcc: string, body: Uint8Array[]): Uint8Array[] {
  let size = 0;
  for (const p of body) size += p.length;
  const out = [asciiBytes(fourcc), le32(size), ...body];
  if (size & 1) out.push(Uint8Array.of(0));
  return out;
}

function canonicalWebp(b: Uint8Array): Uint8Array {
  const { chunks } = parseWebp(b, Infinity);
  const copy = (c: RiffChunk) => riffChunkBytes(c.fourcc, [b.subarray(c.data, c.data + c.size)]);
  const body: Uint8Array[] = [];
  if (chunks[0].fourcc !== 'VP8X') body.push(...copy(chunks[0]));
  else {
    const vp8x = chunks[0];
    const kept = chunks.slice(1).filter((c) => WEBP_KEEP.has(c.fourcc));
    const icc = kept.some((c) => c.fourcc === 'ICCP');
    // Sem EXIF e XMP; ICC só quando o bloco ficou; bits reservados zerados.
    const flags = (b[vp8x.data] & (VP8X_ANIM | VP8X_ALPHA)) | (icc ? VP8X_ICC : 0);
    const header = new Uint8Array(10);
    header[0] = flags;
    header.set(b.subarray(vp8x.data + 4, vp8x.data + 10), 4);
    body.push(...riffChunkBytes('VP8X', [header]));
    for (const c of kept) {
      if (c.fourcc !== 'ANMF') {
        body.push(...copy(c));
        continue;
      }
      const frame: Uint8Array[] = [b.subarray(c.data, c.data + 16)];
      for (const s of riffChunks(b, c.data + 16, c.data + c.size)) if (ANMF_KEEP.has(s.fourcc)) frame.push(...copy(s));
      body.push(...riffChunkBytes('ANMF', frame));
    }
  }
  const out = concat([asciiBytes('RIFF'), le32(0), asciiBytes('WEBP'), ...body]);
  out.set(le32(out.length - 8), 4);
  return out;
}

// ---------- JPEG (só o editor lê; nunca é guardado) ----------

function probeJpeg(b: Uint8Array): ImageProbe {
  if (!startsWith(b, [0xff, 0xd8, 0xff])) throw new ProbeError('format');
  let o = 2;
  for (;;) {
    if (u8(b, o) !== 0xff) throw corrupt();
    while (u8(b, o) === 0xff) o++; // bytes de preenchimento
    const m = b[o++];
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue; // marcadores sem tamanho
    if (m === 0x00 || m === 0xd9 || m === 0xda) throw corrupt(); // fim da imagem ou dados antes do SOF
    const len = u16be(b, o);
    if (len < 2) throw corrupt();
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8) throw corrupt();
      const height = u16be(b, o + 3);
      const width = u16be(b, o + 5);
      if (!width || !height) throw corrupt();
      return { mime: 'image/jpeg', format: 'jpeg', width, height, animated: false, frames: 1, durationMs: 0, loops: 0, alpha: false };
    }
    need(b, o, len);
    o += len;
  }
}

// ---------- API ----------

export function probeImage(b: Uint8Array, opts: { maxFrames?: number } = {}): ImageProbe {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  switch (sniffMime(b)) {
    case 'image/png':
      return parsePng(b, maxFrames).probe;
    case 'image/gif':
      return parseGif(b, maxFrames).probe;
    case 'image/webp':
      return parseWebp(b, maxFrames).probe;
    case 'image/jpeg':
      return probeJpeg(b);
    default:
      throw new ProbeError('format');
  }
}

// Remonta o arquivo só com os blocos da lista permitida, sem metadados e sem bytes depois do fim.
export function canonicalize(b: Uint8Array, format: Exclude<ProbeFormat, 'jpeg'>): Uint8Array {
  switch (format) {
    case 'png':
    case 'apng':
      return canonicalPng(b);
    case 'gif':
      return canonicalGif(b);
    case 'webp':
      return canonicalWebp(b);
    default:
      throw new ProbeError('format');
  }
}
