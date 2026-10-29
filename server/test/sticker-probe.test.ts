import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalize, crc32, probeImage, ProbeError, sniffMime, type ImageProbe } from '@shared/imageProbe';
import {
  buildPickerSections,
  canCreateFromMessage,
  cleanEmojis,
  cleanKeywords,
  cleanStickerName,
  composerEmoji,
  emojiKey,
  mediaTypeAllowed,
  messagePreviewText,
  nameFromFileName,
  normalizeSearch,
  phashBits,
  phashDistance,
  phashFromDb,
  phashToDb,
  rankStickers,
  rolesBlockedFromSending,
  sendBlockedReason,
  similarSticker,
  singleEmoji,
  STICKER_PATH_RE,
  stickerPosterUrl,
  stickerPreviewText,
  stickerScore,
  stickersAllowedIn,
  stickersForEmoji,
  stickerUrl,
  stripInvisible,
  type MessageSticker,
  type StickerCatalogMine,
  type StickerCatalogOrg,
  type StickerItem,
  type StickerPack,
  type StickerSendPolicy,
  type StickerUserItem,
} from '@shared/stickers';
import { be16, be32, bytes, findPngChunk, gif, jpeg, le16, le24, le32, png, pngChunk, randomBytes, riffChunk, rng, vp8lBitstream, webp, webpFile } from './sticker-bytes';

// Leitor de cabeçalhos e funções puras das figurinhas: nenhum servidor nem banco de dados.

type Canon = 'png' | 'apng' | 'gif' | 'webp';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ihdr = (w: number, h: number, colorType = 6) => pngChunk('IHDR', bytes(be32(w), be32(h), [8, colorType, 0, 0, 0]));
const idat = () => pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(10)));
const iend = () => pngChunk('IEND');
const vp8x = (flags: number, w: number, h: number) => riffChunk('VP8X', bytes([flags, 0, 0, 0], le24(w - 1), le24(h - 1)));
const anmf = (x: number, y: number, w: number, h: number, ms: number, stream: Buffer) =>
  riffChunk('ANMF', bytes(le24(x / 2), le24(y / 2), le24(w - 1), le24(h - 1), le24(ms), [0], stream));
const anim = (loops = 0) => riffChunk('ANIM', bytes([0, 0, 0, 0], le16(loops)));

// Motivo do ProbeError, 'ok' quando não lança; qualquer outra exceção faz o teste falhar.
function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProbeError) return e.reason;
    throw e;
  }
  return 'ok';
}

const canonFormat = (b: Uint8Array): Canon => {
  const f = probeImage(b).format;
  if (f === 'jpeg') throw new Error('JPEG não é canonizado');
  return f;
};
const canon = (b: Uint8Array) => canonicalize(b, canonFormat(b));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const has = (b: Uint8Array, s: string | number[]) => Buffer.from(b).includes(bytes(s));

function riffWalk(b: Uint8Array): { fourcc: string; size: number }[] {
  const buf = Buffer.from(b);
  const out: { fourcc: string; size: number }[] = [];
  for (let o = 12; o + 8 <= buf.length; ) {
    const size = buf.readUInt32LE(o + 4);
    out.push({ fourcc: buf.toString('latin1', o, o + 4), size });
    o += 8 + size + (size & 1);
  }
  return out;
}

describe('imageProbe: tipo e cabeçalho', () => {
  it('reconhece PNG, APNG, GIF, WebP (VP8, VP8L, VP8X animado) e JPEG pelo conteúdo, não pela extensão', () => {
    const cases: [Buffer, string, string][] = [
      [png({ w: 120, h: 80 }), 'image/png', 'png'],
      [png({ w: 120, h: 80, frames: 2 }), 'image/png', 'apng'],
      [gif({ w: 100, h: 100, frames: 1 }), 'image/gif', 'gif'],
      [webp({ kind: 'vp8', w: 300, h: 200 }), 'image/webp', 'webp'],
      [webp({ kind: 'vp8l', w: 256, h: 128 }), 'image/webp', 'webp'],
      [webp({ kind: 'vp8x', w: 512, h: 512, frames: 3 }), 'image/webp', 'webp'],
      [jpeg({ w: 640, h: 480 }), 'image/jpeg', 'jpeg'],
    ];
    for (const [b, mime, format] of cases) {
      expect(sniffMime(b)).toBe(mime);
      const p = probeImage(b);
      expect(p.mime).toBe(mime);
      expect(p.format).toBe(format);
    }
    // A API só recebe bytes: nome do arquivo e tipo declarado pelo cliente nem chegam aqui.
    expect(sniffMime(bytes('GIF88a'))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });

  it('recusa SVG, texto e HTML com cabeçalho de imagem truncado', () => {
    expect(reason(() => probeImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')))).toBe('format');
    expect(reason(() => probeImage(bytes('\xef\xbb\xbf<?xml version="1.0"?><svg/>')))).toBe('format');
    expect(reason(() => probeImage(bytes('apenas um texto qualquer')))).toBe('format');
    expect(reason(() => probeImage(bytes('<!doctype html><html><body>oi</body></html>')))).toBe('format');
    expect(reason(() => probeImage(new Uint8Array()))).toBe('format');
    // Cabeçalho mágico certo, conteúdo HTML: o resto não confere.
    expect(reason(() => probeImage(bytes('GIF89a<html><script>alert(1)</script></html>')))).toBe('corrupt');
    expect(reason(() => probeImage(bytes(PNG_SIG, '<html><script>alert(1)</script></html>')))).toBe('corrupt');
    expect(reason(() => probeImage(bytes('RIFF', le32(4000), 'WEBP', '<html></html>')))).toBe('corrupt');
    expect(reason(() => probeImage(bytes([0xff, 0xd8, 0xff], '<html></html>')))).toBe('corrupt');
    expect(reason(() => probeImage(bytes('GIF89a')))).toBe('corrupt');
    expect(reason(() => probeImage(bytes(PNG_SIG)))).toBe('corrupt');
  });

  it('lê dimensões, quadros, duração e repetições', () => {
    const still = (o: Partial<ImageProbe>) => ({ frames: 1, durationMs: 0, loops: 0, animated: false, ...o });
    expect(probeImage(png({ w: 120, h: 80, alpha: true }))).toEqual(still({ mime: 'image/png', format: 'png', width: 120, height: 80, alpha: true }));
    expect(probeImage(png({ w: 120, h: 80 })).alpha).toBe(false);
    const trns = bytes(PNG_SIG, ihdr(100, 100, 2), pngChunk('tRNS', [0, 0, 0, 0, 0, 0]), idat(), iend());
    expect(probeImage(trns).alpha).toBe(true);

    // APNG: delay_den 0 vale 100 (20/100 s = 200 ms).
    expect(probeImage(png({ w: 100, h: 100, frames: 3, delays: [[5, 100], [20, 0], [250, 1000]], loops: 3 }))).toEqual({
      mime: 'image/png',
      format: 'apng',
      width: 100,
      height: 100,
      animated: true,
      frames: 3,
      durationMs: 500,
      loops: 3,
      alpha: false,
    });
    // acTL com um quadro só é imagem parada.
    expect(probeImage(png({ w: 100, h: 100, frames: 1, actlFrames: 1 }))).toMatchObject({ format: 'png', animated: false, frames: 1, durationMs: 0 });

    // GIF: 0 e 1 cs tocam como 100 ms.
    expect(probeImage(gif({ w: 100, h: 90, frames: 4, delaysCs: [0, 1, 7, 50], loops: 0 }))).toEqual({
      mime: 'image/gif',
      format: 'gif',
      width: 100,
      height: 90,
      animated: true,
      frames: 4,
      durationMs: 770,
      loops: 0,
      alpha: false,
    });
    expect(probeImage(gif({ w: 100, h: 100, frames: 2, loops: 5 })).loops).toBe(5);
    expect(probeImage(gif({ w: 100, h: 100, frames: 2 })).loops).toBe(1); // sem NETSCAPE2.0 toca uma vez
    expect(probeImage(gif({ w: 100, h: 100, frames: 1, transparent: true }))).toEqual(
      still({ mime: 'image/gif', format: 'gif', width: 100, height: 100, alpha: true }),
    );

    // WebP
    expect(probeImage(webp({ kind: 'vp8', w: 300, h: 200 }))).toEqual(still({ mime: 'image/webp', format: 'webp', width: 300, height: 200, alpha: false }));
    expect(probeImage(webp({ kind: 'vp8l', w: 256, h: 128, alpha: true }))).toMatchObject({ width: 256, height: 128, alpha: true });
    expect(probeImage(webp({ kind: 'vp8l', w: 256, h: 128 })).alpha).toBe(false);
    expect(probeImage(webp({ kind: 'vp8x', w: 512, h: 384, alpha: true }))).toEqual(still({ mime: 'image/webp', format: 'webp', width: 512, height: 384, alpha: true }));
    // Durações dos ANMF somam; 0 vale 100.
    expect(probeImage(webp({ kind: 'vp8x', w: 512, h: 512, frames: 3, durationsMs: [40, 0, 120], loops: 2, alpha: true }))).toEqual({
      mime: 'image/webp',
      format: 'webp',
      width: 512,
      height: 512,
      animated: true,
      frames: 3,
      durationMs: 260,
      loops: 2,
      alpha: true,
    });
    // Animada com um ANMF só é parada.
    expect(probeImage(webp({ kind: 'vp8x', w: 200, h: 200, animated: true, frames: 1 }))).toMatchObject({ animated: false, frames: 1, durationMs: 0 });

    // JPEG: só o editor lê; um APP1 grande antes do SOF não atrapalha.
    expect(probeImage(jpeg({ w: 640, h: 480 }))).toEqual(still({ mime: 'image/jpeg', format: 'jpeg', width: 640, height: 480, alpha: false }));
    expect(probeImage(jpeg({ w: 4000, h: 3000, app1Bytes: 60_000 }))).toMatchObject({ width: 4000, height: 3000 });

    // Tamanho declarado enorme: o leitor só informa; quem chama aplica o limite (sem alocar nada).
    expect(probeImage(bytes(PNG_SIG, ihdr(30_000, 30_000), idat(), iend()))).toMatchObject({ width: 30_000, height: 30_000 });
  });

  it('atrasos de até 10 ms contam como 100 ms, como o navegador toca', () => {
    expect(probeImage(png({ w: 100, h: 100, frames: 2, delays: [[1, 1000], [0, 100]] })).durationMs).toBe(200);
    expect(probeImage(png({ w: 100, h: 100, frames: 200, delays: Array.from({ length: 200 }, () => [0, 0] as [number, number]) })).durationMs).toBe(20_000);
    expect(probeImage(webp({ kind: 'vp8x', w: 100, h: 100, frames: 2, durationsMs: [5, 11] })).durationMs).toBe(111);
  });

  it('quadro fora da tela é arquivo corrompido', () => {
    const inside = { x: 10, y: 10, w: 50, h: 50 };
    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 2, frameRect: inside })))).toBe('ok');
    expect(reason(() => probeImage(png({ w: 100, h: 100, frames: 2, frameRect: inside })))).toBe('ok');
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 100, h: 100, frames: 2, frameRect: inside })))).toBe('ok');

    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 2, frameRect: { x: 10, y: 0, w: 100, h: 100 } })))).toBe('corrupt');
    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 1, frameRect: { x: 0, y: 0, w: 100, h: 101 } })))).toBe('corrupt');
    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 2, frameRect: { x: 0, y: 0, w: 0, h: 10 } })))).toBe('corrupt');
    expect(reason(() => probeImage(png({ w: 100, h: 100, frames: 2, frameRect: { x: 0, y: 1, w: 100, h: 100 } })))).toBe('corrupt');
    expect(reason(() => probeImage(png({ w: 100, h: 100, frames: 2, frameRect: { x: 0xfffffff0, y: 0, w: 100, h: 100 } })))).toBe('corrupt');
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 100, h: 100, frames: 2, frameRect: { x: 2, y: 0, w: 100, h: 100 } })))).toBe('corrupt');
    // O fluxo do quadro precisa ter o tamanho declarado no ANMF (senão o navegador toca outra coisa).
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 100, h: 100, frames: 2, frameRect: inside, streamSize: { w: 60, h: 50 } })))).toBe('corrupt');
  });

  it('arquivo sem imagem é corrompido', () => {
    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 0 })))).toBe('corrupt');
    expect(reason(() => probeImage(gif({ w: 100, h: 100, frames: 0, comment: 'só comentário' })))).toBe('corrupt');
    expect(reason(() => probeImage(png({ w: 100, h: 100, noIdat: true })))).toBe('corrupt');
    expect(reason(() => probeImage(png({ w: 100, h: 100, frames: 3, actlFrames: 2 })))).toBe('corrupt');
    expect(reason(() => probeImage(png({ w: 100, h: 100, frames: 2, actlFrames: 3 })))).toBe('corrupt');
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 100, h: 100, animated: true, frames: 0 })))).toBe('corrupt');
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 100, h: 100, noImage: true })))).toBe('corrupt');
    expect(reason(() => probeImage(webpFile(vp8x(0x02, 100, 100), anim(), anmf(0, 0, 100, 100, 100, riffChunk('ALPH', 'x')))))).toBe('corrupt');
  });

  it('para no limite de quadros', () => {
    expect(probeImage(png({ w: 96, h: 96, frames: 200 })).frames).toBe(200);
    expect(probeImage(gif({ w: 96, h: 96, frames: 200 })).frames).toBe(200);
    expect(probeImage(webp({ kind: 'vp8x', w: 96, h: 96, frames: 200 })).frames).toBe(200);
    expect(reason(() => probeImage(png({ w: 96, h: 96, frames: 201 })))).toBe('too-many-frames');
    expect(reason(() => probeImage(gif({ w: 96, h: 96, frames: 201 })))).toBe('too-many-frames');
    expect(reason(() => probeImage(webp({ kind: 'vp8x', w: 96, h: 96, frames: 201 })))).toBe('too-many-frames');
    expect(reason(() => probeImage(gif({ w: 96, h: 96, frames: 5 }), { maxFrames: 4 }))).toBe('too-many-frames');
    expect(reason(() => probeImage(gif({ w: 96, h: 96, frames: 4 }), { maxFrames: 4 }))).toBe('ok');
    // acTL que promete 4 bilhões de quadros para logo, sem andar o arquivo.
    expect(reason(() => probeImage(png({ w: 96, h: 96, frames: 2, actlFrames: 0xffffffff })))).toBe('too-many-frames');
    // acTL no limite, mas com um fcTL a mais: o 201º quadro para a leitura.
    expect(reason(() => probeImage(png({ w: 96, h: 96, frames: 201, actlFrames: 200 })))).toBe('too-many-frames');
  });

  it('cabeçalhos hostis: tamanhos falsos, blocos fora de ordem e campos impossíveis', () => {
    const corrupt = (b: Uint8Array) => expect(reason(() => probeImage(b))).toBe('corrupt');
    // PNG
    corrupt(bytes(PNG_SIG, ihdr(100, 100), be32(0xffffffff), 'tEXt', 'abc'));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), be32(0x7ffffff0), 'IDAT', 'abc'));
    corrupt(bytes(PNG_SIG, pngChunk('tEXt', 'antes'), ihdr(100, 100), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), ihdr(100, 100), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(0, 100), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(0x80000000, 100), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100, 5), idat(), iend()));
    corrupt(bytes(PNG_SIG, pngChunk('IHDR', bytes(be32(100), be32(100), [8, 6, 0, 0])), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), pngChunk('ABCD', 'crítico desconhecido'), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), pngChunk('ab#d', 'tipo inválido'), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), idat())); // sem IEND
    corrupt(bytes(PNG_SIG, ihdr(100, 100), idat(), pngChunk('IEND', 'x')));
    const fctl = (seq: number) => pngChunk('fcTL', bytes(be32(seq), be32(100), be32(100), be32(0), be32(0), be16(10), be16(100), [0, 0]));
    const actl = (n: number) => pngChunk('acTL', bytes(be32(n), be32(0)));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), idat(), actl(2), fctl(0), fctl(1), iend())); // acTL depois do IDAT
    corrupt(bytes(PNG_SIG, ihdr(100, 100), actl(0), idat(), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), actl(2), actl(2), fctl(0), idat(), fctl(1), iend()));
    corrupt(bytes(PNG_SIG, ihdr(100, 100), fctl(0), idat(), iend())); // fcTL sem acTL
    corrupt(bytes(PNG_SIG, ihdr(100, 100), actl(2), pngChunk('fdAT', be32(0)), fctl(1), idat(), fctl(2), iend())); // fdAT antes de qualquer fcTL
    corrupt(bytes(PNG_SIG, ihdr(100, 100), actl(2), pngChunk('fcTL', bytes(be32(0), be32(100))), idat(), iend()));
    // GIF
    const lsd = (w: number, h: number, packed = 0) => bytes('GIF89a', le16(w), le16(h), [packed, 0, 0]);
    const image = bytes([0x2c], le16(0), le16(0), le16(10), le16(10), [0, 2, 2, 0x44, 0x01, 0]);
    corrupt(bytes(lsd(0, 0), image, [0x3b]));
    corrupt(bytes(lsd(10, 10, 0x87), randomBytes(100, 1))); // tabela global de 768 bytes truncada
    corrupt(bytes(lsd(10, 10), [0x2c], le16(0), le16(0), le16(10), le16(10), [0, 2, 200, 1, 2, 3])); // sub-bloco passa do fim
    corrupt(bytes(lsd(10, 10), [0x99], image, [0x3b]));
    corrupt(bytes(lsd(10, 10), [0x21, 0xf9, 2, 0, 0, 0], image, [0x3b]));
    corrupt(bytes(lsd(10, 10), image, [0x21])); // extensão cortada no fim
    expect(reason(() => probeImage(bytes(lsd(10, 10), image)))).toBe('ok'); // sem trailer depois de uma imagem completa
    // WebP
    const vp8l = riffChunk('VP8L', vp8lBitstream(100, 100));
    corrupt(bytes('RIFF', le32(10_000), 'WEBP', vp8l));
    // Download cortado no meio do bloco de imagem: RIFF e bloco coerentes entre si, mas maiores que o arquivo.
    corrupt(webp({ kind: 'vp8l', w: 100, h: 100, dataBytes: 1000 }).subarray(0, 600));
    corrupt(webp({ kind: 'vp8', w: 100, h: 100, dataBytes: 1000 }).subarray(0, 600));
    corrupt(bytes('RIFF', le32(2), 'WEBP', vp8l));
    corrupt(bytes('RIFF', le32(4), 'WEBP'));
    corrupt(webpFile(bytes('VP8L', le32(5000), vp8lBitstream(100, 100))));
    corrupt(webpFile(riffChunk('ZZZZ', 'x'), vp8l));
    corrupt(webpFile(riffChunk('VP8 ', bytes([0x10, 0, 0, 0x9d, 0x01, 0x2b], le16(100), le16(100), [0, 0]))));
    corrupt(webpFile(riffChunk('VP8 ', bytes([0x10, 0, 0, 0x9d, 0x01, 0x2a], le16(0), le16(100), [0, 0]))));
    corrupt(webpFile(riffChunk('VP8L', bytes([0x2e], le32(0), [0, 0]))));
    corrupt(webpFile(riffChunk('VP8L', bytes([0x2f], le32(0x20000000), [0, 0])))); // versão 1
    corrupt(webpFile(riffChunk('VP8X', bytes([0, 0, 0, 0], le24(99), le24(99), [0])), vp8l));
    corrupt(webpFile(vp8x(0x02, 100, 100), anmf(0, 0, 100, 100, 100, vp8l))); // ANMF sem ANIM antes
    corrupt(webpFile(vp8x(0, 100, 100), anim(), anmf(0, 0, 100, 100, 100, vp8l))); // ANMF numa imagem parada
    corrupt(webpFile(vp8x(0x02, 100, 100), anim(), anmf(0, 0, 100, 100, 100, vp8l), vp8l)); // imagem solta numa animada
    corrupt(webpFile(vp8x(0, 200, 200), vp8l)); // imagem de tamanho diferente da tela
    corrupt(webpFile(vp8x(0, 100, 100), vp8x(0, 100, 100), vp8l));
    corrupt(webpFile(vp8x(0x02, 100, 100), anim(), anmf(0, 0, 100, 100, 100, bytes(vp8l, vp8l)))); // dois fluxos num quadro
    // JPEG: tamanho 0 de segmento não pode travar o laço; dados antes do SOF; fim antes do SOF.
    corrupt(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xc0]));
    corrupt(bytes([0xff, 0xd8, 0xff, 0xda], be16(8), randomBytes(6, 3), [0xff, 0xd9]));
    corrupt(bytes([0xff, 0xd8, 0xff, 0xd9]));
    corrupt(bytes([0xff, 0xd8, 0xff, 0xc0], be16(17), [8], be16(0), be16(100), randomBytes(10, 4)));
    corrupt(bytes([0xff, 0xd8, 0xff, 0xe0], be16(4), [0, 0], [0x12, 0x34]));
  });
});

describe('imageProbe: canonicalize', () => {
  it('canonicalize tira metadados e mantém a imagem', () => {
    // PNG: tEXt, eXIf e bloco privado somem; o resto fica na ordem original.
    const dirtyPng = png({ w: 200, h: 100, alpha: true, text: '<?php system($_GET["c"]); ?>', exif: true, privateChunk: true, trailing: 'PK\x03\x04zip escondido' });
    const cleanPng = canon(dirtyPng);
    for (const t of ['tEXt', 'eXIf', 'prVt']) expect(findPngChunk(cleanPng, t)).toBe(-1);
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(findPngChunk(cleanPng, t)).toBeGreaterThan(0);
    expect(has(cleanPng, '<?php')).toBe(false);
    expect(has(cleanPng, 'PK\x03\x04')).toBe(false);
    expect(Buffer.from(cleanPng.subarray(-8)).toString('latin1', 0, 4)).toBe('IEND');
    expect(probeImage(cleanPng)).toEqual(probeImage(dirtyPng));
    expect(Buffer.from(cleanPng).equals(Buffer.from(canon(png({ w: 200, h: 100, alpha: true }))))).toBe(true);

    const apng = png({ w: 120, h: 120, frames: 3, delaysMs: [100, 200, 300], loops: 2, text: 'oi' });
    const cleanApng = canon(apng);
    for (const t of ['acTL', 'fcTL', 'fdAT']) expect(findPngChunk(cleanApng, t)).toBeGreaterThan(0);
    expect(probeImage(cleanApng)).toEqual(probeImage(apng));

    // GIF: comentário e extensões de aplicativo que não são de repetição somem.
    const dirtyGif = gif({ w: 100, h: 100, frames: 3, delaysCs: [10, 20, 30], loops: 0, comment: '<script>alert(1)</script>', xmp: '<x:xmpmeta/>', trailing: 'PK\x03\x04jar' });
    const cleanGif = canon(dirtyGif);
    expect(has(cleanGif, [0x21, 0xfe])).toBe(false);
    expect(has(cleanGif, '<script')).toBe(false);
    expect(has(cleanGif, 'XMP DataXMP')).toBe(false);
    expect(has(cleanGif, 'NETSCAPE2.0')).toBe(true);
    expect(has(cleanGif, 'PK\x03\x04')).toBe(false);
    expect(cleanGif[cleanGif.length - 1]).toBe(0x3b);
    expect(probeImage(cleanGif)).toEqual(probeImage(dirtyGif));
    expect(Buffer.from(cleanGif).equals(Buffer.from(canon(gif({ w: 100, h: 100, frames: 3, delaysCs: [10, 20, 30], loops: 0 }))))).toBe(true);

    // WebP: EXIF, XMP e desconhecidos somem; marcas do VP8X conferem com o que ficou; tamanho RIFF exato.
    const dirtyWebp = webp({ kind: 'vp8x', w: 300, h: 300, alpha: true, exif: true, xmp: true, icc: true, unknownChunk: true, trailing: '<html>depois do RIFF</html>' });
    const cleanWebp = canon(dirtyWebp);
    const fourccs = riffWalk(cleanWebp).map((c) => c.fourcc);
    expect(fourccs).toEqual(['VP8X', 'ICCP', 'VP8L']);
    expect(cleanWebp[20]).toBe(0x10 | 0x20); // alfa + ICC, sem EXIF (0x08) e XMP (0x04)
    expect(Buffer.from(cleanWebp).readUInt32LE(4)).toBe(cleanWebp.length - 8);
    expect(cleanWebp.length % 2).toBe(0);
    expect(has(cleanWebp, '<html')).toBe(false);
    expect(probeImage(cleanWebp)).toEqual(probeImage(dirtyWebp));

    // Marca ICC sem bloco ICCP é apagada; EXIF sem ICC deixa só o alfa.
    const flagged = webp({ kind: 'vp8x', w: 100, h: 100, alpha: true, exif: true });
    flagged[20] |= 0x20 | 0x01;
    expect(canon(flagged)[20]).toBe(0x10);

    // Animada: o bloco estranho dentro do ANMF some; cabeçalho do quadro e fluxo ficam.
    const dirtyAnim = webp({ kind: 'vp8x', w: 200, h: 200, frames: 3, durationsMs: [50, 60, 70], loops: 1, anmfJunk: true, exif: true });
    const cleanAnim = canon(dirtyAnim);
    expect(has(cleanAnim, 'JUNK')).toBe(false);
    expect(has(cleanAnim, 'EXIF')).toBe(false);
    expect(riffWalk(cleanAnim).map((c) => c.fourcc)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);
    expect(cleanAnim[20]).toBe(0x02);
    expect(probeImage(cleanAnim)).toEqual(probeImage(dirtyAnim));

    // Formato simples: só o primeiro bloco é decodificado, então só ele fica.
    const simple = webp({ kind: 'vp8l', w: 128, h: 128, unknownChunk: true });
    expect(riffWalk(canon(simple)).map((c) => c.fourcc)).toEqual(['VP8L']);
  });

  it('CRC errado num bloco mantido é corrompido; num bloco descartado não importa', () => {
    const b = png({ w: 100, h: 100, text: 'comentário' });
    const kept = Buffer.from(b);
    kept[findPngChunk(kept, 'IHDR') + 8 + 13] ^= 0xff;
    expect(reason(() => probeImage(kept))).toBe('ok'); // o leitor não confere CRC
    expect(reason(() => canonicalize(kept, 'png'))).toBe('corrupt');
    const dropped = Buffer.from(b);
    const t = findPngChunk(dropped, 'tEXt');
    dropped[t + 8 + dropped.readUInt32BE(t)] ^= 0xff;
    expect(reason(() => canonicalize(dropped, 'png'))).toBe('ok');
  });

  it('canonicalize recusa crítico desconhecido, formato trocado e entrada vazia', () => {
    const critical = bytes(PNG_SIG, ihdr(100, 100), pngChunk('ABCD', 'x'), idat(), iend());
    expect(reason(() => canonicalize(critical, 'png'))).toBe('corrupt');
    expect(reason(() => canonicalize(png({ w: 100, h: 100 }), 'gif'))).toBe('format');
    expect(reason(() => canonicalize(gif({ w: 100, h: 100, frames: 1 }), 'webp'))).toBe('format');
    expect(reason(() => canonicalize(webp({ kind: 'vp8', w: 100, h: 100 }), 'apng'))).toBe('format');
    expect(reason(() => canonicalize(new Uint8Array(), 'png'))).toBe('format');
    expect(reason(() => canonicalize(jpeg({ w: 100, h: 100 }), 'jpeg' as never))).toBe('format');
  });

  it('um byte a mais no fim não muda o hash', () => {
    const files = [
      png({ w: 128, h: 128, alpha: true }),
      png({ w: 128, h: 128, frames: 2 }),
      gif({ w: 128, h: 128, frames: 2, loops: 0 }),
      webp({ kind: 'vp8', w: 128, h: 128 }),
      webp({ kind: 'vp8l', w: 128, h: 128 }),
      webp({ kind: 'vp8x', w: 128, h: 128, frames: 2 }),
    ];
    for (const f of files) {
      const h = sha(canon(f));
      expect(sha(canon(bytes(f, [0])))).toBe(h);
      expect(sha(canon(bytes(f, 'muitos bytes a mais')))).toBe(h);
      expect(sha(canon(canon(f)))).toBe(h); // idempotente: exportar e importar mantém o hash
    }
    // GIF sem trailer ganha um e fica igual ao que tinha.
    expect(sha(canon(gif({ w: 128, h: 128, frames: 2, noTrailer: true })))).toBe(sha(canon(gif({ w: 128, h: 128, frames: 2 }))));
  });

  it('chunk privado é descartado', () => {
    const plain = png({ w: 150, h: 150, seed: 9 });
    const withPrivate = png({ w: 150, h: 150, seed: 9, privateChunk: true });
    expect(sha(withPrivate)).not.toBe(sha(plain));
    expect(sha(canon(withPrivate))).toBe(sha(canon(plain)));
    const unknown = webp({ kind: 'vp8x', w: 150, h: 150, seed: 9, unknownChunk: true });
    expect(sha(canon(unknown))).toBe(sha(canon(webp({ kind: 'vp8x', w: 150, h: 150, seed: 9 }))));
  });

  it('poliglotas: nada de HTML, script ou ZIP sobrevive dentro da figurinha', () => {
    const zip = bytes('PK\x03\x04', randomBytes(40, 5), 'PK\x05\x06', Buffer.alloc(18));
    const html = '<html><script>fetch("/api/v1/me")</script></html>';
    const samples = [
      bytes(png({ w: 100, h: 100, text: html }), zip),
      bytes(gif({ w: 100, h: 100, frames: 1, comment: html }), zip),
      bytes(webp({ kind: 'vp8x', w: 100, h: 100, xmp: true, unknownChunk: true }), html, zip),
    ];
    for (const s of samples) {
      const c = canon(s);
      expect(has(c, '<script')).toBe(false);
      expect(has(c, 'PK\x03\x04')).toBe(false);
      expect(probeImage(c)).toEqual(probeImage(s));
    }
  });

  it('arquivo truncado ou alterado nunca derruba o leitor', () => {
    const fixtures: { b: Buffer; fmt: Canon | null; whole?: boolean }[] = [
      { b: png({ w: 40, h: 30, alpha: true, text: 'oi', exif: true, privateChunk: true, trailing: 'xx' }), fmt: 'png' },
      { b: png({ w: 40, h: 30, alpha: true, text: 'oi', exif: true }), fmt: 'png', whole: true },
      { b: png({ w: 40, h: 40, frames: 3, delays: [[1, 0], [5, 100], [0, 0]], loops: 2 }), fmt: 'apng', whole: true },
      { b: gif({ w: 40, h: 40, frames: 1, transparent: true }), fmt: 'gif' },
      { b: gif({ w: 40, h: 40, frames: 3, delaysCs: [0, 5, 9], loops: 3, comment: 'comentário', xmp: 'x', noTrailer: true }), fmt: 'gif' },
      { b: webp({ kind: 'vp8', w: 40, h: 40 }), fmt: 'webp', whole: true },
      { b: webp({ kind: 'vp8l', w: 40, h: 40, alpha: true, unknownChunk: true }), fmt: 'webp', whole: true },
      { b: webp({ kind: 'vp8x', w: 40, h: 40, alpha: true, exif: true, xmp: true, icc: true, unknownChunk: true, trailing: 'z' }), fmt: 'webp' },
      { b: webp({ kind: 'vp8x', w: 40, h: 40, frames: 3, durationsMs: [0, 20, 40], anmfJunk: true, frameRect: { x: 4, y: 6, w: 20, h: 20 } }), fmt: 'webp', whole: true },
      { b: jpeg({ w: 40, h: 30, app1Bytes: 30 }), fmt: null },
    ];
    const failures: string[] = [];
    let accepted = 0;
    const check = (b: Uint8Array, fmt: Canon | null, label: string) => {
      let probe: ImageProbe | null = null;
      try {
        probe = probeImage(b);
        accepted++;
      } catch (e) {
        if (!(e instanceof ProbeError)) failures.push(`${label}: probeImage lançou ${String(e)}`);
      }
      if (!fmt) return;
      let c: Uint8Array | null = null;
      try {
        c = canonicalize(b, fmt);
      } catch (e) {
        if (!(e instanceof ProbeError)) failures.push(`${label}: canonicalize lançou ${String(e)}`);
      }
      // O que passa pelos dois tem de continuar igual depois de canonizado, e canonizar de novo não muda nada.
      if (probe && c) {
        try {
          expect(probeImage(c)).toEqual(probe);
          expect(Buffer.from(canonicalize(c, fmt)).equals(Buffer.from(c))).toBe(true);
        } catch (e) {
          failures.push(`${label}: canônico diferente (${String(e).slice(0, 200)})`);
        }
      }
    };
    const started = performance.now();
    fixtures.forEach(({ b, fmt, whole }, i) => {
      check(b, fmt, `fixture ${i}`);
      for (let n = 0; n < b.length; n++) {
        check(b.subarray(0, n), fmt, `fixture ${i}, prefixo ${n}`);
        // PNG e WebP sem bytes depois do fim: qualquer pedaço do arquivo é recusado.
        if (whole && reason(() => probeImage(b.subarray(0, n))) === 'ok') failures.push(`fixture ${i}: prefixo ${n} aceito`);
      }
    });
    const r = rng(20261022);
    for (let k = 0; k < 2000; k++) {
      const i = Math.floor(r() * fixtures.length);
      const b = Buffer.from(fixtures[i].b);
      const flips = 1 + Math.floor(r() * 3);
      for (let f = 0; f < flips; f++) b[Math.floor(r() * b.length)] ^= 1 + Math.floor(r() * 255);
      check(b, fixtures[i].fmt, `fixture ${i}, troca ${k}`);
    }
    const elapsed = performance.now() - started;
    expect(failures.slice(0, 5)).toEqual([]);
    expect(accepted).toBeGreaterThan(fixtures.length); // as trocas também geram arquivos válidos, não só recusas
    expect(elapsed).toBeLessThan(3000);
  });

  it('crc32 confere com o zlib', () => {
    const known: [string, number][] = [
      ['', 0],
      ['123456789', 0xcbf43926],
      ['The quick brown fox jumps over the lazy dog', 0x414fa339],
    ];
    for (const [s, v] of known) expect(crc32(bytes(s))).toBe(v);
    const buf = randomBytes(5000, 11);
    expect(crc32(buf, 100, 100)).toBe(0);
    if (typeof zlib.crc32 === 'function') {
      expect(crc32(buf)).toBe(zlib.crc32(buf));
      const r = rng(5);
      for (let k = 0; k < 50; k++) {
        const a = Math.floor(r() * buf.length);
        const z = a + Math.floor(r() * (buf.length - a));
        expect(crc32(buf, a, z)).toBe(zlib.crc32(buf.subarray(a, z)));
      }
    }
    expect(reason(() => crc32(buf, -1, 10))).toBe('corrupt');
    expect(reason(() => crc32(buf, 10, 5001))).toBe('corrupt');
    expect(reason(() => crc32(buf, 20, 10))).toBe('corrupt');
  });
});

// ---------- shared/src/stickers.ts ----------

const EMOJI_MAP: Record<string, string> = { '+1': '👍', joy: '😂' };
const toUnicode = (code: string) => EMOJI_MAP[code] ?? null;

describe('figurinhas: texto', () => {
  it('cleanEmojis aceita bandeiras, teclas, ZWJ e tons de pele e descarta texto e :códigos:', () => {
    expect(cleanEmojis(['🇧🇷', '1️⃣', '👩‍💻', '👍🏽', '👍', 'ok', ':+1:', '😂😂', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'])).toEqual(['🇧🇷', '1️⃣', '👩‍💻', '👍🏽', '😂']);
    expect(cleanEmojis('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toEqual(['🏴󠁧󠁢󠁳󠁣󠁴󠁿']);
    expect(cleanEmojis('😂 ok 👍 :joy:')).toEqual(['😂', '👍']);
    expect(cleanEmojis(':+1:')).toEqual([]);
    expect(cleanEmojis([1, null, { a: 1 }, '#', '*'])).toEqual([]);
    expect(cleanEmojis(undefined)).toEqual([]);
    expect(cleanEmojis('#️⃣*️⃣')).toEqual(['#️⃣', '*️⃣']);
  });

  it('singleEmoji, emojiKey e composerEmoji', () => {
    expect(singleEmoji('👍🏽')).toBe('👍🏽');
    expect(emojiKey('👍🏽')).toBe(emojiKey('👍'));
    expect(emojiKey('☀️')).toBe('☀');
    expect(singleEmoji('ok 👍')).toBeNull();
    expect(singleEmoji('1️⃣')).toBe('1️⃣');
    expect(singleEmoji('  😂  ')).toBe('😂');
    expect(singleEmoji('😂😂')).toBeNull();
    expect(singleEmoji('a')).toBeNull();
    expect(singleEmoji('')).toBeNull();
    expect(composerEmoji(':+1: ', toUnicode)).toBe('👍');
    expect(composerEmoji(':joy:', toUnicode)).toBe('😂');
    expect(composerEmoji(':JOY:', toUnicode)).toBe('😂');
    expect(composerEmoji('oi :+1:', toUnicode)).toBeNull();
    expect(composerEmoji(':wescc:', toUnicode)).toBeNull();
    expect(composerEmoji('🇧🇷', toUnicode)).toBe('🇧🇷');
  });

  it('stripInvisible tira controles e formatação invisível', () => {
    expect(stripInvisible('a‎b⁠c­d᠎e﻿f⁡g\u0007h')).toBe('abcdefgh');
    expect(stripInvisible('👩‍💻')).toBe('👩‍💻');
    expect(stripInvisible('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe('🏴󠁧󠁢󠁳󠁣󠁴󠁿');
    expect(stripInvisible('a\u{E0041}b')).toBe('ab'); // tag solta, sem a bandeira
    expect(stripInvisible('Bom⁠dia')).toBe('Bomdia');
    expect(stripInvisible('‮evil')).toBe('evil');
    expect(cleanStickerName('  Bom⁠   dia‏  ')).toBe('Bom dia');
    expect(cleanStickerName('x'.repeat(60))).toHaveLength(40);
    expect(cleanStickerName(42)).toBe('');
  });

  it('cleanKeywords, nameFromFileName e normalizeSearch', () => {
    expect(cleanKeywords('#Bom dia, café ,  , #Bom Dia, x')).toEqual(['bom dia', 'café', 'x']);
    expect(cleanKeywords(['UM', 'dois', 3, 'um'])).toEqual(['um', 'dois']);
    expect(cleanKeywords(Array.from({ length: 15 }, (_, i) => `k${i}`))).toHaveLength(10);
    expect(cleanKeywords(['y'.repeat(50)])[0]).toHaveLength(30);
    expect(cleanKeywords(null)).toEqual([]);
    expect(nameFromFileName('Bom-dia_final.PNG')).toBe('Bom dia final');
    expect(nameFromFileName('obrigado.webp')).toBe('Obrigado');
    expect(nameFromFileName('ação--rápida..png')).toBe('Ação rápida');
    expect(nameFromFileName('pasta/sub/meta_batida.gif')).toBe('Meta batida');
    expect(nameFromFileName('.png')).toBe('Figurinha');
    expect(nameFromFileName('___.webp')).toBe('Figurinha');
    expect(nameFromFileName(`${'a'.repeat(60)}.png`)).toHaveLength(40);
    expect(normalizeSearch('  Ação   Rápida ')).toBe('acao rapida');
    expect(stickerScore({ name: 'Ação', emojis: [] }, 'acao')).toBe(90);
  });

  it('stickerScore ordena por emoji, nome exato, prefixo, palavra-chave e pacote', () => {
    const item = { name: 'Bom dia', emojis: ['☀️'], keywords: ['manhã', 'saudação'], packName: 'Atendimento' };
    expect(stickerScore(item, '☀️')).toBe(100);
    expect(stickerScore(item, '☀')).toBe(100);
    expect(stickerScore(item, '😂')).toBe(0);
    expect(stickerScore(item, 'Bom Dia')).toBe(90);
    expect(stickerScore(item, 'bom')).toBe(80);
    expect(stickerScore(item, 'manha')).toBe(70);
    expect(stickerScore(item, 'dia')).toBe(60);
    expect(stickerScore(item, 'sauda')).toBe(50);
    expect(stickerScore(item, 'om di')).toBe(30);
    expect(stickerScore(item, 'atend')).toBe(10);
    expect(stickerScore(item, 'xyz')).toBe(0);
    expect(stickerScore(item, '   ')).toBe(0);
    expect(stickerScore({ name: 'Rindo', emojis: [] }, '😂')).toBe(0); // um emoji sozinho não busca pelo nome
  });

  it('messagePreviewText e stickerPreviewText', () => {
    const live = (name: string, emojis: string[]): MessageSticker => ({
      fileId: 'F1aaaaaaaaaaaaaaa',
      name,
      emojis,
      width: 512,
      height: 512,
      animated: false,
      url: '/sticker/F1aaaaaaaaaaaaaaa.webp',
      scope: 'org',
    });
    const removed: MessageSticker = { fileId: 'F1aaaaaaaaaaaaaaa', removed: true, width: 512, height: 512 };
    expect(messagePreviewText({ msg: 'oi' })).toBe('oi');
    expect(messagePreviewText({ msg: 'oi', sticker: live('Rindo', ['😂']) })).toBe('oi');
    expect(messagePreviewText({ msg: '', sticker: live('Rindo', ['😂']) })).toBe('😂 Figurinha “Rindo”');
    expect(messagePreviewText({ sticker: live('Rindo', []) })).toBe('Figurinha “Rindo”');
    expect(messagePreviewText({ sticker: live('', ['😂']) })).toBe('😂 Figurinha');
    expect(messagePreviewText({ sticker: live('Figurinha', ['😂']) })).toBe('😂 Figurinha');
    expect(messagePreviewText({ sticker: live('Rindo', ['😂']) }, { withName: false })).toBe('😂 Figurinha');
    expect(stickerPreviewText(live('Bom dia', ['☀️']), { withName: false })).toBe('☀️ Figurinha');
    expect(messagePreviewText({ msg: '', sticker: removed })).toBe('Figurinha removida');
    expect(messagePreviewText({ msg: '', files: [{ name: 'relatório.pdf' }] })).toBe('📎 relatório.pdf');
    expect(messagePreviewText({})).toBe('');
    expect(messagePreviewText({ msg: null, sticker: null, files: [] })).toBe('');
  });
});

describe('figurinhas: onde e o que dá para enviar', () => {
  const policy: StickerSendPolicy = {
    personalEnabled: true,
    animatedEnabled: true,
    uploadsEnabled: true,
    uploadsInDirect: true,
    whiteList: '',
    blackList: 'image/svg+xml',
  };
  const personal = { scope: 'personal' as const, mime: 'image/webp', animated: false };
  const org = { scope: 'org' as const, mime: 'image/gif', animated: true };
  const ONLY_ORG = 'Nesta conversa só dá para enviar figurinhas da organização.';

  it('sendBlockedReason segue a ordem do servidor', () => {
    expect(sendBlockedReason(personal, { t: 'c' }, policy)).toBeNull();
    expect(sendBlockedReason(personal, { t: 'c' }, { ...policy, personalEnabled: false })).toBe('As figurinhas pessoais estão desativadas.');
    expect(sendBlockedReason({ ...personal, animated: true }, { t: 'c' }, { ...policy, personalEnabled: false, animatedEnabled: false })).toBe(
      'As figurinhas pessoais estão desativadas.',
    );
    expect(sendBlockedReason(personal, { t: 'c' }, { ...policy, uploadsEnabled: false })).toBe(ONLY_ORG);
    expect(sendBlockedReason({ ...personal, mime: 'image/gif' }, { t: 'c' }, { ...policy, blackList: 'image/gif' })).toBe(ONLY_ORG);
    expect(sendBlockedReason(personal, { t: 'c' }, { ...policy, whiteList: 'image/png' })).toBe(ONLY_ORG);
    expect(sendBlockedReason(personal, { t: 'd' }, { ...policy, uploadsInDirect: false })).toBe(ONLY_ORG);
    expect(sendBlockedReason(personal, { t: 'p' }, { ...policy, uploadsInDirect: false })).toBeNull();
    expect(sendBlockedReason(personal, null, { ...policy, uploadsInDirect: false })).toBeNull();
    expect(sendBlockedReason(org, { t: 'c' }, { ...policy, animatedEnabled: false })).toBe('Figurinhas animadas estão desativadas.');
    expect(sendBlockedReason({ ...personal, animated: true }, { t: 'c' }, { ...policy, animatedEnabled: false })).toBe('Figurinhas animadas estão desativadas.');
    expect(sendBlockedReason({ ...org, animated: false }, { t: 'd' }, { ...policy, uploadsEnabled: false, uploadsInDirect: false, blackList: 'image/*' })).toBeNull();
  });

  it('mediaTypeAllowed segue as listas de tipos', () => {
    expect(mediaTypeAllowed('image/png', '', 'image/svg+xml')).toBe(true);
    expect(mediaTypeAllowed('image/svg+xml', '', 'image/svg+xml')).toBe(false);
    expect(mediaTypeAllowed('image/gif', 'image/*', '')).toBe(true);
    expect(mediaTypeAllowed('image/gif', ' Image/PNG , image/webp ', '')).toBe(false);
    expect(mediaTypeAllowed('image/webp', ' Image/PNG , image/webp ', '')).toBe(true);
    expect(mediaTypeAllowed('image/png', 'image/png', 'image/*')).toBe(false);
  });

  it('stickersAllowedIn', () => {
    expect(stickersAllowedIn(null, { noticeRooms: true })).toBe(false);
    expect(stickersAllowedIn(undefined, { noticeRooms: true })).toBe(false);
    expect(stickersAllowedIn({ t: 'c', notice: true }, { noticeRooms: false })).toBe(false);
    expect(stickersAllowedIn({ t: 'p', notice: true }, { noticeRooms: true })).toBe(true);
    for (const t of ['c', 'p', 'd']) expect(stickersAllowedIn({ t }, { noticeRooms: false })).toBe(true);
  });

  it('rolesBlockedFromSending ignora maiúsculas e espaços', () => {
    expect(rolesBlockedFromSending(['user', 'Operacao'], ' operacao , supervisao ')).toBe(true);
    expect(rolesBlockedFromSending(['operacao'], 'OPERACAO')).toBe(true);
    expect(rolesBlockedFromSending(['user'], 'operacao')).toBe(false);
    expect(rolesBlockedFromSending([], '')).toBe(false);
    expect(rolesBlockedFromSending(['admin'], ' ,, ')).toBe(false);
  });

  it('canCreateFromMessage', () => {
    const id = 'AbCdEfGhIjKlMnOpQ';
    const upload = {
      files: [{ _id: id, name: 'foto.png', type: 'image/png' }],
      attachments: [{ type: 'file', image_url: `/file-upload/${id}/foto.png` }],
    };
    expect(canCreateFromMessage(upload)).toEqual({ fileId: id, url: `/file-upload/${id}/foto.png`, name: 'foto.png' });
    expect(canCreateFromMessage({ ...upload, sticker: { fileId: 'x', removed: true } })).toBeNull();
    expect(canCreateFromMessage({ ...upload, t: 'uj' })).toBeNull();
    expect(canCreateFromMessage({ ...upload, files: [{ _id: id, name: 'logo.svg', type: 'image/svg+xml' }] })).toBeNull();
    expect(canCreateFromMessage({ ...upload, attachments: [{ type: 'file', image_url: `/sticker/${id}.webp` }] })).toBeNull();
    expect(canCreateFromMessage({ ...upload, attachments: [{ type: 'file', image_url: '/file-upload/ZZZZZZZZZZZZZZZZZ/foto.png' }] })).toBeNull();
    expect(canCreateFromMessage({ ...upload, attachments: [{ type: 'sticker', image_url: `/file-upload/${id}/foto.png` }] })).toBeNull();
    expect(canCreateFromMessage({ ...upload, attachments: [{ type: 'file', image_url: `https://evil.example/file-upload/${id}/x.png` }] })).toBeNull();
    expect(canCreateFromMessage({ files: null, attachments: null })).toBeNull();
    const second = 'QpOnMlKjIhGfEdCbA';
    expect(
      canCreateFromMessage({
        files: [
          { _id: id, name: 'nota.pdf', type: 'application/pdf' },
          { _id: second, name: 'b.jpg', type: 'image/jpeg' },
        ],
        attachments: [
          { type: 'file', image_url: `/file-upload/${id}/nota.pdf` },
          { type: 'file', image_url: `/file-upload/${second}/b.jpg` },
        ],
      }),
    ).toEqual({ fileId: second, url: `/file-upload/${second}/b.jpg`, name: 'b.jpg' });
  });
});

describe('figurinhas: seletor', () => {
  const file = (id: string) => ({
    fileId: id,
    mime: 'image/webp' as const,
    width: 512,
    height: 512,
    size: 1000,
    animated: false,
    frames: 1,
    url: stickerUrl(id, 'image/webp'),
  });
  const sticker = (packId: string, id: string, fileId: string, name: string, emojis: string[], sort: number, keywords: string[] = []): StickerItem => ({
    ...file(fileId),
    _id: id,
    packId,
    name,
    emojis,
    keywords,
    sort,
    createdAt: '2026-10-01T10:00:00.000Z',
  });
  const pack = (id: string, scope: 'org' | 'personal', sort: number, stickers: StickerItem[], status: 'draft' | 'published' = 'published'): StickerPack => ({
    _id: id,
    scope,
    name: `Pacote ${id}`,
    description: '',
    status,
    visibleRoles: [],
    sort,
    count: stickers.length,
    stickers,
    updatedAt: '2026-10-01T10:00:00.000Z',
  });
  const userItem = (kind: 'favorite' | 'recent', fileId: string, name: string, emojis: string[], usedAt: string, extra: Partial<StickerUserItem> = {}): StickerUserItem => ({
    ...file(fileId),
    kind,
    name,
    emojis,
    scope: 'org',
    usedAt,
    ...extra,
  });

  const org: StickerCatalogOrg = {
    scope: 'org',
    version: '3',
    userId: 'U1',
    packs: [
      pack('P1', 'org', 1, [sticker('P1', 'S2', 'F2', 'Joinha', ['👍🏽'], 1), sticker('P1', 'S1', 'F1', 'Bom dia', ['👍', '☀️'], 0)]),
      pack('P0', 'org', 0, [sticker('P0', 'S3', 'F3', 'Obrigado', ['🙏'], 0), sticker('P0', 'S7', 'F7', 'Joia rara', ['💎'], 1)]),
      pack('D', 'org', 2, [sticker('D', 'S4', 'F4', 'Rascunho', ['👍'], 0)], 'draft'),
      pack('E', 'org', 3, [sticker('E', 'S5', 'F5', 'Removida', ['👍'], 0)]),
      pack('V', 'org', 4, []),
    ],
  };
  const mine: StickerCatalogMine = {
    scope: 'mine',
    version: '7',
    userId: 'U1',
    packs: [pack('M1', 'personal', 0, [sticker('M1', 'S6', 'F6', 'Meu joia', ['👍'], 0, ['joia'])])],
    favorites: [
      userItem('favorite', 'F3', 'Obrigado', ['🙏'], '2026-10-20T10:00:00.000Z', { stickerId: 'S3', packId: 'P0', packName: 'Pacote P0' }),
      userItem('favorite', 'F2', 'Joinha', ['👍🏽'], '2026-10-21T10:00:00.000Z', { stickerId: 'S2', packId: 'P1', packName: 'Pacote P1' }),
      userItem('favorite', 'F5', 'Removida', ['👍'], '2026-10-22T10:00:00.000Z'),
    ],
    recents: [userItem('recent', 'F6', 'Meu joia', ['👍'], '2026-10-22T09:00:00.000Z', { stickerId: 'S6', scope: 'personal' })],
    quota: { packs: 1, maxPacks: 5, bytes: 1000, quotaBytes: 20 * 1024 * 1024 },
  };
  const removed = new Set(['F5']);

  it('buildPickerSections', () => {
    const s = buildPickerSections(org, mine, { canManage: false, removed });
    expect(s.favorites.map((p) => p.key)).toEqual(['fav:F2', 'fav:F3']); // mais recente primeiro; removida fora
    expect(s.favorites.every((p) => p.source === 'favorite' && !p.editable)).toBe(true);
    expect(s.recents.map((p) => p.key)).toEqual(['rec:F6']);
    expect(s.recents[0]).toMatchObject({ source: 'recent', scope: 'personal', editable: false, keywords: ['joia'] });
    expect(s.org.map((g) => g.pack._id)).toEqual(['P0', 'P1']); // por sort; rascunho, vazio e só-removidas fora
    expect(s.org[1].picks.map((p) => p.key)).toEqual(['org:P1:F1', 'org:P1:F2']);
    expect(s.org[1].picks[0]).toMatchObject({ source: 'org', scope: 'org', stickerId: 'S1', packId: 'P1', packName: 'Pacote P1', editable: false });
    expect(s.personal.map((g) => g.pack._id)).toEqual(['M1']);
    expect(s.personal[0].picks[0]).toMatchObject({ key: 'mine:M1:F6', source: 'personal', scope: 'personal', editable: true });

    const managed = buildPickerSections(org, mine, { canManage: true, removed });
    expect(managed.org.flatMap((g) => g.picks).every((p) => p.editable)).toBe(true);
    expect(managed.favorites.some((p) => p.editable)).toBe(false);
    expect(managed.org.map((g) => g.pack._id)).toEqual(['P0', 'P1']); // gestor também não vê rascunho no seletor

    const empty = buildPickerSections(null, null, { canManage: false, removed: new Set() });
    expect(empty).toEqual({ favorites: [], recents: [], org: [], personal: [] });
  });

  it('rankStickers e stickersForEmoji', () => {
    const s = buildPickerSections(org, mine, { canManage: false, removed });
    // :+1: busca como 👍; cada arquivo uma vez, na ordem favoritas, recentes, organização, pessoais.
    const thumbs = rankStickers(s, ':+1:', toUnicode);
    expect(thumbs.map((p) => p.key)).toEqual(['fav:F2', 'rec:F6', 'org:P1:F1']);
    expect(stickersForEmoji(s, '👍🏽').map((p) => p.key)).toEqual(['fav:F2', 'rec:F6', 'org:P1:F1']);
    expect(stickersForEmoji(s, '👍', 2)).toHaveLength(2);
    expect(stickersForEmoji(s, 'ok')).toEqual([]);
    // Favorita que também está num pacote da organização aparece uma vez, na posição de Favoritas.
    expect(rankStickers(s, 'obrigado', toUnicode).map((p) => p.key)).toEqual(['fav:F3']);
    // Pontuação vence a ordem das seções.
    expect(rankStickers(s, 'joia', toUnicode).map((p) => p.key)).toEqual(['org:P0:F7', 'rec:F6']);
    expect(rankStickers(s, 'pacote p1', toUnicode).map((p) => p.key)).toEqual(['fav:F2', 'org:P1:F1']);
    expect(rankStickers(s, '', toUnicode)).toEqual([]);
    expect(rankStickers(s, ':wescc:', toUnicode)).toEqual([]);
    expect(rankStickers(s, 'o', toUnicode, 1)).toHaveLength(1);
  });
});

describe('figurinhas: hash perceptual e URLs', () => {
  it('phash: conversão para o banco e distância', () => {
    for (const h of ['0000000000000000', 'ffffffffffffffff', '8000000000000000', '0123456789abcdef', '7fffffffffffffff']) expect(phashFromDb(phashToDb(h))).toBe(h);
    expect(phashToDb('ffffffffffffffff')).toBe('-1');
    expect(phashToDb('8000000000000000')).toBe('-9223372036854775808');
    expect(phashFromDb(null)).toBeNull();
    expect(phashFromDb(undefined)).toBeNull();
    expect(phashBits('0000000000000000')).toBe(0);
    expect(phashBits('ffffffffffffffff')).toBe(64);
    expect(phashBits('0f0f0f0f0f0f0f0f')).toBe(32);
    expect(phashDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(phashDistance('0f0f0f0f0f0f0f0f', '0f0f0f0f0f0f0f30')).toBe(6);
    expect(() => phashBits('xyz')).toThrow();
    expect(() => phashDistance('ABCDEF0123456789', '0000000000000000')).toThrow();

    const base = { phash: '0f0f0f0f0f0f0f0f', width: 512, height: 512 };
    expect(similarSticker(base, { ...base, phash: '0f0f0f0f0f0f0f30' })).toBe(true); // distância 6
    expect(similarSticker(base, { ...base, phash: '0f0f0f0f0f0f0f70' })).toBe(false); // distância 7
    expect(similarSticker(base, { ...base, width: 512, height: 256 })).toBe(false); // 1:1 contra 2:1
    expect(similarSticker(base, { ...base, width: 512, height: 490 })).toBe(true); // proporção dentro de 10 %
    const flat = { phash: '0000000000000001', width: 512, height: 512 };
    expect(similarSticker(flat, flat)).toBe(false); // lisa demais para comparar
    expect(similarSticker({ ...flat, phash: 'fffffffffffffffe' }, { ...flat, phash: 'fffffffffffffffe' })).toBe(false);
    expect(similarSticker({ ...base, phash: null }, base)).toBe(false);
  });

  it('URLs e caminho das figurinhas', () => {
    expect(stickerUrl('AbCdEfGhIjKlMnOpQ', 'image/png')).toBe('/sticker/AbCdEfGhIjKlMnOpQ.png');
    expect(stickerUrl('AbCdEfGhIjKlMnOpQ', 'image/webp')).toBe('/sticker/AbCdEfGhIjKlMnOpQ.webp');
    expect(stickerPosterUrl('AbCdEfGhIjKlMnOpQ', 'image/gif')).toBe('/sticker/AbCdEfGhIjKlMnOpQ/poster.gif');
    expect(STICKER_PATH_RE.exec('AbCdEfGhIjKlMnOpQ.webp')?.slice(1)).toEqual(['AbCdEfGhIjKlMnOpQ', 'webp']);
    for (const bad of ['../x.webp', 'AbCdEfGhIjKlMnOpQ.svg', 'AbCdEfGhIjKlMnOpQ.webp.html', 'abc.png', 'AbCdEfGhIjKlMnOpQ'])
      expect(STICKER_PATH_RE.test(bad)).toBe(false);
  });
});
