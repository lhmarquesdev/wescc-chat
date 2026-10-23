import zlib from 'node:zlib';

// Avatares dos robôs das integrações: PNG 256×256, quadrado arredondado (raio 56) em #646c7b com um símbolo branco
// de 128 px no estilo dos ícones do chat (bilhete para o Jira, quadro de apresentação para o Teams).
//
// PROVISÓRIO: ícones genéricos gerados aqui mesmo, até o dono aprovar os logotipos oficiais (§15, item 20) ou a arte
// final chegar em base64. Para trocar, substitua o conteúdo de BOT_AVATAR por constantes base64 (≤ 8 KB cada).

type Vec = [number, number];

const SIZE = 256;
const RADIUS = 56;
const TILE: [number, number, number] = [0x64, 0x6c, 0x7b];
const GLYPH = 128; // px; o desenho usa uma grade de 24 unidades, como os ícones do chat
const UNIT = GLYPH / 24;
const STROKE = 2; // unidades

const len = (x: number, y: number) => Math.hypot(x, y);

function sdRoundBox(p: Vec, c: Vec, half: Vec, r: number): number {
  const qx = Math.abs(p[0] - c[0]) - half[0] + r;
  const qy = Math.abs(p[1] - c[1]) - half[1] + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const sdCircle = (p: Vec, c: Vec, r: number) => len(p[0] - c[0], p[1] - c[1]) - r;

function sdSegment(p: Vec, a: Vec, b: Vec): number {
  const pax = p[0] - a[0];
  const pay = p[1] - a[1];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return len(pax - bax * h, pay - bay * h);
}

const stroke = (d: number) => Math.abs(d) - STROKE / 2;
const line = (p: Vec, a: Vec, b: Vec) => sdSegment(p, a, b) - STROKE / 2;

// Distância (em unidades da grade) até o traço do símbolo; negativa dentro do traço.
const GLYPHS: Record<'jira' | 'msteams', (p: Vec) => number> = {
  // Bilhete: retângulo arredondado com recortes nas laterais e uma linha picotada.
  jira: (p) => {
    const body = sdRoundBox(p, [12, 12], [10, 7], 2);
    const outline = Math.max(body, -sdCircle(p, [2, 12], 3), -sdCircle(p, [22, 12], 3));
    let d = stroke(outline);
    for (const [y0, y1] of [
      [7.75, 8.25],
      [11.75, 12.25],
      [15.75, 16.25],
    ]) {
      d = Math.min(d, line(p, [14.5, y0], [14.5, y1]));
    }
    return d;
  },
  // Quadro de apresentação: barra no alto, quadro e tripé.
  msteams: (p) => {
    let d = line(p, [2, 4], [22, 4]);
    d = Math.min(d, stroke(sdRoundBox(p, [12, 10], [8, 6], 2)));
    d = Math.min(d, line(p, [12, 16], [7.5, 21]));
    d = Math.min(d, line(p, [12, 16], [16.5, 21]));
    return d;
  },
};

const cover = (dPx: number) => Math.max(0, Math.min(1, 0.5 - dPx));

function render(kind: 'jira' | 'msteams'): Buffer {
  const glyph = GLYPHS[kind];
  const off = (SIZE - GLYPH) / 2;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1);
    raw[row] = 0; // filtro "nenhum"
    for (let x = 0; x < SIZE; x++) {
      const px: Vec = [x + 0.5, y + 0.5];
      const tile = cover(sdRoundBox(px, [SIZE / 2, SIZE / 2], [SIZE / 2, SIZE / 2], RADIUS));
      if (tile <= 0) continue;
      const g = cover(glyph([(px[0] - off) / UNIT, (px[1] - off) / UNIT]) * UNIT);
      const i = row + 1 + x * 4;
      raw[i] = Math.round(TILE[0] + (255 - TILE[0]) * g);
      raw[i + 1] = Math.round(TILE[1] + (255 - TILE[1]) * g);
      raw[i + 2] = Math.round(TILE[2] + (255 - TILE[2]) * g);
      raw[i + 3] = Math.round(255 * tile);
    }
  }
  return png(SIZE, SIZE, raw);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(w: number, h: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache: Partial<Record<'jira' | 'msteams', string>> = {};

// base64 de cada PNG (gerado uma vez por processo).
export const BOT_AVATAR: Record<'jira' | 'msteams', string> = {
  get jira() {
    return (cache.jira ??= render('jira').toString('base64'));
  },
  get msteams() {
    return (cache.msteams ??= render('msteams').toString('base64'));
  },
};
