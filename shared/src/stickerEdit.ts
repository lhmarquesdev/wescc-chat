// Figurinhas: edição de imagem sem DOM (rasters RGBA em memória). Roda no Worker do editor, na thread principal
// quando não há Worker, e nos testes do servidor. Nada aqui decodifica ou codifica arquivos: isso é do canvas.
import { STICKER_LIMITS } from './stickers';

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>; // RGBA, sem pré-multiplicação (o mesmo formato de ImageData)
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Abaixo disto o pixel conta como transparente (margens, preenchimento e silhueta usam o mesmo limiar).
const ALPHA_MIN = 8;

// NaN vira min: um valor quebrado no estado do editor nunca chega como NaN ao canvas.
const clamp = (v: number, min: number, max: number) => (v > min ? (v < max ? v : max) : min);
const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

function assertRaster(r: Raster): void {
  if (!(Number.isInteger(r.width) && Number.isInteger(r.height) && r.width > 0 && r.height > 0) || r.data.length !== r.width * r.height * 4)
    throw new RangeError('Imagem inválida para edição.');
}
function assertMask(mask: Uint8Array, width: number, height: number): void {
  if (mask.length !== width * height) throw new RangeError('Máscara de tamanho diferente da imagem.');
}

export function createRaster(width: number, height: number): Raster {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new RangeError('Imagem inválida para edição.');
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

// ---------- Margens e recorte ----------

// Menor retângulo com todos os pixels de alfa >= limiar; null quando nada é visível.
export function alphaBounds(r: Raster, threshold: number = ALPHA_MIN): Rect | null {
  assertRaster(r);
  const { width: w, height: h, data } = r;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    let o = y * w * 4 + 3;
    for (let x = 0; x < w; x++, o += 4) {
      if (data[o] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Aumenta o retângulo em pad px de cada lado, sem sair de 0..maxW × 0..maxH.
export function padRect(rect: Rect, pad: number, maxW: number, maxH: number): Rect {
  const p = Math.max(0, Math.round(pad) || 0);
  const W = Math.max(0, finiteOr(maxW, 0));
  const H = Math.max(0, finiteOr(maxH, 0));
  const x0 = clamp(Math.floor(rect.x) - p, 0, W);
  const y0 = clamp(Math.floor(rect.y) - p, 0, H);
  const x1 = clamp(Math.ceil(rect.x + rect.width) + p, 0, W);
  const y1 = clamp(Math.ceil(rect.y + rect.height) + p, 0, H);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// Cópia de uma área (cortada nos limites da imagem). Usada para recortar as margens transparentes.
// Área vazia (ou com NaN) dá 1 × 1 transparente.
export function cropRaster(r: Raster, rect: Rect): Raster {
  assertRaster(r);
  const c = padRect(rect, 0, r.width, r.height);
  if (!c.width || !c.height) return createRaster(1, 1);
  const out = createRaster(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    const from = ((c.y + y) * r.width + c.x) * 4;
    out.data.set(r.data.subarray(from, from + c.width * 4), y * c.width * 4);
  }
  return out;
}

// Margem transparente em volta: o contorno precisa de espaço para não ser cortado.
export function padRaster(r: Raster, pad: number): Raster {
  assertRaster(r);
  const p = Math.max(0, Math.ceil(pad) || 0);
  const out = createRaster(r.width + 2 * p, r.height + 2 * p);
  for (let y = 0; y < r.height; y++) {
    out.data.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((y + p) * out.width + p) * 4);
  }
  return out;
}

export function hasTransparency(r: Raster): boolean {
  assertRaster(r);
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] < 255) return true;
  return false;
}

// ---------- Fundo liso e preenchimento ----------

// Controle "Tolerância" (0–100) para distância euclidiana em RGB (0–120).
export const toleranceToDistance = (t: number) => clamp(Number.isFinite(t) ? t : 0, 0, 100) * 1.2;

const dist2Limit = (tolerance: number) => {
  const d = toleranceToDistance(tolerance);
  return d * d;
};

// Pixels opacos da borda, a cada step px (os cantos sempre entram).
export function edgeSeeds(r: Raster, step = 4): Array<[number, number]> {
  assertRaster(r);
  const { width: w, height: h, data } = r;
  const s = Math.max(1, Math.floor(step) || 1);
  const out: Array<[number, number]> = [];
  const seen = new Set<number>();
  const add = (x: number, y: number) => {
    const i = y * w + x;
    if (seen.has(i)) return;
    seen.add(i);
    if (data[i * 4 + 3] >= ALPHA_MIN) out.push([x, y]);
  };
  for (let x = 0; x < w; x += s) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y += s) {
    add(0, y);
    add(w - 1, y);
  }
  add(w - 1, 0);
  add(0, h - 1);
  add(w - 1, h - 1);
  return out;
}

interface EdgeStats {
  total: number; // pixels da borda
  opaque: number;
  near: number; // opacos perto da cor dominante
  color: [number, number, number] | null; // mediana por canal dos opacos
}

// Toda a borda, pixel a pixel: cor dominante (mediana, resiste a um objeto encostado na borda) e quantos a seguem.
function edgeStats(r: Raster, tolerance: number): EdgeStats {
  const { width: w, height: h, data } = r;
  const idx: number[] = [];
  for (let x = 0; x < w; x++) {
    idx.push(x);
    if (h > 1) idx.push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    idx.push(y * w);
    if (w > 1) idx.push(y * w + w - 1);
  }
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let opaque = 0;
  for (const i of idx) {
    if (data[i * 4 + 3] < ALPHA_MIN) continue;
    opaque++;
    for (let c = 0; c < 3; c++) hist[c][data[i * 4 + c]]++;
  }
  if (!opaque) return { total: idx.length, opaque: 0, near: 0, color: null };
  const median = (hh: Uint32Array) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hh[v]) * 2 >= opaque) return v;
    return 255;
  };
  const color: [number, number, number] = [median(hist[0]), median(hist[1]), median(hist[2])];
  const limit = dist2Limit(tolerance);
  let near = 0;
  for (const i of idx) {
    if (data[i * 4 + 3] < ALPHA_MIN) continue;
    const dr = data[i * 4] - color[0];
    const dg = data[i * 4 + 1] - color[1];
    const db = data[i * 4 + 2] - color[2];
    if (dr * dr + dg * dg + db * db <= limit) near++;
  }
  return { total: idx.length, opaque, near, color };
}

// "Remover fundo liso" só aparece quando a borda é quase toda de uma cor só (tolerância na escala do controle):
// 60 % da borda inteira opaca e perto da cor dominante. Fundo já transparente não tem o que remover.
export function edgeLooksUniform(r: Raster, tolerance: number): boolean {
  assertRaster(r);
  const s = edgeStats(r, tolerance);
  return s.near >= s.total * 0.6;
}

// Sementes do "Remover fundo liso": as de edgeSeeds com a cor dominante da borda. Uma pessoa recortada na altura
// dos ombros encosta na borda; sem este filtro, a camisa viraria semente e sumiria junto com o fundo.
export function backgroundSeeds(r: Raster, tolerance: number, step = 4): Array<[number, number]> {
  assertRaster(r);
  const { color } = edgeStats(r, tolerance);
  if (!color) return [];
  const limit = dist2Limit(tolerance);
  return edgeSeeds(r, step).filter(([x, y]) => {
    const i = (y * r.width + x) * 4;
    const dr = r.data[i] - color[0];
    const dg = r.data[i + 1] - color[1];
    const db = r.data[i + 2] - color[2];
    return dr * dr + dg * dg + db * db <= limit;
  });
}

// Trabalho dos preenchimentos: cada pixel marcado conta 3 (o teste dele e dos vizinhos), cada trecho de linha
// FILL_RUN_COST e cada pixel que barrou 3, então o fundo todo custa perto de 3 por pixel. O primeiro preenchimento vai
// sempre até o fim; os seguintes dividem FILL_EXTRA por pixel (no mínimo FILL_MIN_WORK, alguns ms: em imagem pequena
// sobra para todos) e o que passa disso para no meio. Depois do teto, o que já saiu vira parede e as sementes que ainda
// não saíram rodam barradas: cada pixel custa no máximo mais uma visita.
const FILL_EXTRA = 3;
const FILL_MIN_WORK = 1 << 20;
const FILL_RUN_COST = 8;
// Cores distintas que o pulo exato confere de uma vez. Acima disso (fundo ruidoso no limite da tolerância, com buracos
// de toda cor) quase nenhuma semente passaria, e o teste fica de fora.
const FILL_RING_COLORS = 1024;
const WALL = 0xffffffff;

// Distância² entre duas cores 0xRRGGBB.
const gap2 = (a: number, b: number) =>
  (((a >> 16) & 255) - ((b >> 16) & 255)) ** 2 + (((a >> 8) & 255) - ((b >> 8) & 255)) ** 2 + ((a & 255) - (b & 255)) ** 2;

interface FillRing {
  fresh: number[]; // pixels que barraram e ainda não tinham saído
  colors: number[]; // cores distintas dos que barraram, até FILL_RING_COLORS + 1, só as que cabem em near
  bits: Uint32Array; // cores já vistas, 1 bit por cor RGB; volta zerado
  center: number; // longe disto (distância² > near), uma cor não cabe na tolerância de nenhuma semente
  near: number;
}

// Um preenchimento por linhas, 4-conexo, de uma cor só, a partir de todas as sementes dessa cor. stamp, por pixel:
// 2g = marcado pelo preenchimento g, 2g + 1 = barrou no preenchimento g (um marcado continua par), WALL = parede.
// Todo vizinho de um pixel marcado é testado, então os que barraram são a borda inteira do que ele marcou.
// Para no meio quando o trabalho passa de stop.
function scanFill(
  r: Raster,
  starts: readonly number[],
  rgb: number,
  limit: number,
  mark: number,
  claim: number,
  stamp: Uint32Array,
  out: Uint8Array,
  ring: FillRing | null,
  stop: number,
): { work: number; whole: boolean } {
  const { width: w, height: h, data } = r;
  const R = (rgb >> 16) & 255;
  const G = (rgb >> 8) & 255;
  const B = rgb & 255;
  let work = 0;
  const passable = (i: number) => {
    const st = stamp[i];
    if (st >= mark) return false;
    const o = i * 4;
    if (data[o + 3] < ALPHA_MIN) return true;
    const dr = data[o] - R;
    const dg = data[o + 1] - G;
    const db = data[o + 2] - B;
    if (dr * dr + dg * dg + db * db <= limit) return true;
    if (st & 1 || !st) {
      stamp[i] = mark + 1;
      work += 3;
      ring?.fresh.push(i);
    }
    if (ring && ring.colors.length <= FILL_RING_COLORS) {
      const q = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      const bit = 1 << (q & 31);
      if (!(ring.bits[q >>> 5] & bit) && gap2(q, ring.center) <= ring.near) {
        ring.bits[q >>> 5] |= bit;
        ring.colors.push(q);
      }
    }
    return false;
  };
  const stack = starts.slice();
  let whole = true;
  while (stack.length) {
    if (work > stop) {
      whole = false;
      break;
    }
    const i = stack.pop()!;
    if (!passable(i)) continue;
    const y = (i / w) | 0;
    const row = y * w;
    let xl = i - row;
    let xr = xl;
    while (xl > 0 && passable(row + xl - 1)) xl--;
    while (xr < w - 1 && passable(row + xr + 1)) xr++;
    stamp.fill(claim, row + xl, row + xr + 1);
    out.fill(1, row + xl, row + xr + 1);
    work += FILL_RUN_COST + 3 * (xr - xl + 1);
    for (let ny = y - 1; ny <= y + 1; ny += 2) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let run = false;
      for (let x = xl; x <= xr; x++) {
        if (passable(nrow + x)) {
          if (!run) stack.push(nrow + x);
          run = true;
        } else run = false;
      }
    }
  }
  if (ring) for (const q of ring.colors) ring.bits[q >>> 5] = 0;
  return { work, whole };
}

// Preenchimento a partir de várias sementes, marcando 1 em out. Cada semente compara os pixels com a própria cor
// (pixels de alfa < 8 já estão apagados e sempre passam): nada sai apagado sem estar ligado a uma semente por pixels a
// até a tolerância da cor dela, então o assunto nunca some por uma corrente de cores de sementes diferentes.
// Sementes da mesma cor rodam juntas. Uma semente não roda quando nada que ela alcançaria falta: quando um
// preenchimento que a alcançou não tem, entre os pixels que o barraram, nenhum na tolerância dela, ou quando ela já
// saiu e nenhum pixel da borda do que já saiu cabe na tolerância dela. A ordem é fixa e não depende da recebida:
// primeiro a cor mais perto da mediana das sementes, depois sempre a mais longe das que já rodaram (os extremos de um
// degradê saem cedo). Até o teto, o resultado é a união exata dos preenchimentos de cada semente; depois, parte dela.
function fillInto(r: Raster, seeds: ReadonlyArray<readonly [number, number]>, tolerance: number, out: Uint8Array): void {
  const { width: w, height: h, data } = r;
  const n = w * h;
  const limit = dist2Limit(tolerance);
  const d = Math.sqrt(limit);
  const pos: number[] = [];
  const seen = new Set<number>();
  for (const seed of seeds) {
    const sx = Math.floor(seed[0]);
    const sy = Math.floor(seed[1]);
    if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) continue;
    const s = sy * w + sx;
    if (seen.has(s) || data[s * 4 + 3] < ALPHA_MIN) continue; // semente transparente: não há cor para comparar
    seen.add(s);
    pos.push(s);
  }
  if (!pos.length) return;
  const rgbAt = (i: number) => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
  const rgb = pos.map(rgbAt);
  const mid = [16, 8, 0].map((sh) => rgb.map((c) => (c >> sh) & 255).sort((a, b) => a - b)[pos.length >> 1]);
  const center = (mid[0] << 16) | (mid[1] << 8) | mid[2];
  const fromCenter = rgb.map((c) => Math.sqrt(gap2(c, center)));
  const order = pos.map((_, k) => k).sort((a, b) => fromCenter[a] - fromCenter[b] || rgb[a] - rgb[b] || pos[a] - pos[b]);
  const groups: number[][] = [];
  const groupOf = new Int32Array(pos.length);
  for (const k of order) {
    const g = groups[groups.length - 1];
    if (g && rgb[g[0]] === rgb[k]) g.push(k);
    else groups.push([k]);
    groupOf[k] = groups.length - 1;
  }
  const stamp = new Uint32Array(n);
  if (groups.length === 1) {
    scanFill(r, pos, rgb[0], limit, 2, 2, stamp, out, null, Infinity);
    return;
  }

  const erased = (i: number) => stamp[i] !== 0 && !(stamp[i] & 1);
  // Cores em ordem de distância a ref. Pela desigualdade triangular, só as que ficam a δ ± d de ref podem caber na
  // tolerância de uma cor a δ de ref: a busca começa e para nessa janela.
  const byDistance = (cols: number[], ref: number) => {
    const dist = cols.map((q) => Math.sqrt(gap2(q, ref)));
    const idx = cols.map((_, k) => k).sort((a, b) => dist[a] - dist[b]);
    return { cols: idx.map((k) => cols[k]), dist: Float64Array.from(idx, (k) => dist[k]) };
  };
  let work = 0;
  const fits = (set: { cols: number[]; dist: Float64Array }, delta: number, col: number) => {
    let a = 0;
    let b = set.cols.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (set.dist[m] < delta - d - 1e-9) a = m + 1;
      else b = m;
    }
    for (; a < set.cols.length && set.dist[a] <= delta + d + 1e-9; a++) {
      work++;
      if (gap2(set.cols[a], col) <= limit) return true;
    }
    return false;
  };

  const near = d + Math.max(...fromCenter) + 1e-9;
  const ring: FillRing = { fresh: [], colors: [], bits: new Uint32Array(1 << 19), center, near: near * near };
  const inEdge = new Uint8Array(n);
  let edge: number[] = []; // pixels que barraram algum preenchimento e não saíram: a borda do que já saiu
  const skip = new Uint8Array(pos.length);
  const starts = groups.map((g) => g.map((k) => pos[k]));
  const groupRgb = Int32Array.from(groups, (g) => rgb[g[0]]);
  const open = Int32Array.from(groups, (g) => g.length); // sementes do grupo que ainda não foram puladas
  const ran = new Uint8Array(groups.length);
  const gapToRun = new Float64Array(groups.length).fill(Infinity); // menor distância² até uma cor que já rodou
  let budget = Math.max(FILL_EXTRA * n, FILL_MIN_WORK);
  let mark = 0;
  for (;;) {
    let pick = -1;
    for (let g = 0; g < groups.length; g++) if (!ran[g] && open[g] && (pick < 0 || gapToRun[g] > gapToRun[pick])) pick = g;
    if (pick < 0) return;
    if (work > budget) break;
    ran[pick] = 1;
    const c = groupRgb[pick];
    mark += 2;
    ring.fresh.length = 0;
    ring.colors.length = 0;
    const run = scanFill(r, starts[pick], c, limit, mark, mark, stamp, out, ring, mark === 2 ? Infinity : budget - work);
    if (mark === 2) budget += run.work;
    work += run.work + groups.length + pos.length; // a escolha e a conferência das sementes também contam
    if (!run.whole) break;
    for (const i of ring.fresh) {
      if (inEdge[i]) continue;
      inEdge[i] = 1;
      edge.push(i);
    }
    work += ring.fresh.length;
    let own: ReturnType<typeof byDistance> | null | undefined;
    for (let k = 0; k < pos.length; k++) {
      if (skip[k] || ran[groupOf[k]] || stamp[pos[k]] !== mark) continue;
      if (own === undefined) own = ring.colors.length <= FILL_RING_COLORS ? byDistance(ring.colors, c) : null;
      if (own && !fits(own, Math.sqrt(gap2(rgb[k], c)), rgb[k])) skip[k] = 1;
    }
    // A borda do que já saiu só é conferida depois de um preenchimento grande: os pequenos (manchas soltas) quase não
    // a mudam.
    if (run.work >= n) {
      edge = edge.filter((i) => !erased(i) || (inEdge[i] = 0));
      const cols: number[] = [];
      for (const i of edge) {
        const q = rgbAt(i);
        const bit = 1 << (q & 31);
        if (ring.bits[q >>> 5] & bit || gap2(q, center) > ring.near) continue;
        ring.bits[q >>> 5] |= bit;
        cols.push(q);
        if (cols.length > FILL_RING_COLORS) break;
      }
      for (const q of cols) ring.bits[q >>> 5] = 0;
      work += edge.length;
      if (cols.length <= FILL_RING_COLORS) {
        const all = byDistance(cols, center);
        for (let k = 0; k < pos.length; k++)
          if (!skip[k] && !ran[groupOf[k]] && erased(pos[k]) && !fits(all, fromCenter[k], rgb[k])) skip[k] = 1;
      }
    }
    for (let k = 0; k < pos.length; k++) if (skip[k] === 1) (skip[k] = 2), open[groupOf[k]]--;
    for (let g = 0; g < groups.length; g++) if (!ran[g]) gapToRun[g] = Math.min(gapToRun[g], gap2(groupRgb[g], c));
  }
  // Depois do teto: o que já saiu vira parede e as sementes que faltam rodam na ordem canônica, barradas.
  for (let i = 0; i < n; i++) {
    const st = stamp[i];
    if (st && !(st & 1)) stamp[i] = WALL;
  }
  for (let g = 0; g < groups.length; g++) {
    const left = starts[g].filter((s) => stamp[s] !== WALL);
    if (!left.length) continue;
    mark += 2;
    scanFill(r, left, groupRgb[g], limit, mark, WALL, stamp, out, null, Infinity);
  }
}

// Máscara (1 = apagar) com tudo o que está ligado às sementes e tem cor parecida. base entra somada.
export function floodFillMask(r: Raster, seeds: Array<[number, number]>, tolerance: number, base?: Uint8Array): Uint8Array<ArrayBuffer> {
  assertRaster(r);
  const out = new Uint8Array(r.width * r.height);
  if (base) {
    assertMask(base, r.width, r.height);
    out.set(base);
  }
  fillInto(r, seeds, tolerance, out);
  return out;
}

// ---------- Pincel ----------

// Pincel redondo: o disco percorre cada segmento entre os pontos (espaçamento zero, sem serrilhado entre os carimbos).
// Coordenadas contínuas: o pixel (i, j) ocupa [i, i + 1) × [j, j + 1) e conta quando o centro cai no traço.
// A cápsula de cada segmento é convexa: cada linha vira um intervalo calculado de uma vez e preenchido com fill,
// sem teste pixel a pixel (o editor reaplica todos os traços a cada prévia).
export function paintMask(
  mask: Uint8Array,
  width: number,
  height: number,
  stroke: { points: Array<[number, number]>; radius: number; erase: boolean },
): void {
  assertMask(mask, width, height);
  const v = stroke.erase ? 1 : 0;
  const r = Math.max(Number.isFinite(stroke.radius) ? stroke.radius : 0, 0.5); // 0,5 px: o traço nunca tem falhas
  const r2 = r * r;
  const pts = stroke.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return;
  const segment = (ax: number, ay: number, bx: number, by: number) => {
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by) - r - 0.5));
    const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by) + r - 0.5));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const rl = r * Math.sqrt(len2);
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - ay; // tudo relativo a A
      let lo = Infinity;
      let hi = -Infinity;
      // Discos das pontas.
      const qa = r2 - py * py;
      if (qa >= 0) {
        const s = Math.sqrt(qa);
        lo = -s;
        hi = s;
      }
      const qb = r2 - (py - dy) * (py - dy);
      if (qb >= 0) {
        const s = Math.sqrt(qb);
        lo = Math.min(lo, dx - s);
        hi = Math.max(hi, dx + s);
      }
      // Corpo: projeção em [0, 1] (x·dx entre t0 e t0 + len2) e distância perpendicular <= r (x·dy entre c ± r·len).
      if (len2) {
        let bl = -Infinity;
        let bh = Infinity;
        const t0 = -py * dy;
        if (dx) {
          const a = t0 / dx;
          const b = (t0 + len2) / dx;
          bl = Math.max(bl, Math.min(a, b));
          bh = Math.min(bh, Math.max(a, b));
        } else if (t0 > 0 || t0 + len2 < 0) bh = -Infinity;
        const c = dx * py;
        if (dy) {
          const a = (c - rl) / dy;
          const b = (c + rl) / dy;
          bl = Math.max(bl, Math.min(a, b));
          bh = Math.min(bh, Math.max(a, b));
        } // dy = 0: toda linha de y0 a y1 já fica a até r do segmento
        if (bl <= bh) {
          lo = Math.min(lo, bl);
          hi = Math.max(hi, bh);
        }
      }
      if (!(lo <= hi)) continue;
      const x0 = Math.max(0, Math.ceil(ax + lo - 0.5)); // centros x + 0,5 dentro de [ax + lo, ax + hi]
      const x1 = Math.min(width - 1, Math.floor(ax + hi - 0.5));
      if (x0 <= x1) mask.fill(v, y * width + x0, y * width + x1 + 1);
    }
  };
  if (pts.length === 1) segment(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) segment(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
}

// ---------- Aplicar máscara e contorno ----------

// Apagado fica transparente de vez (sem halo da cor do fundo). Do lado mantido, cada pixel perde alfa na proporção
// de vizinhos apagados numa janela (2·feather + 1)²: com feather 1, a borda fica suave em 1 px.
export function applyMask(r: Raster, mask: Uint8Array, feather = 1): Raster {
  assertRaster(r);
  const { width: w, height: h } = r;
  assertMask(mask, w, h);
  const out: Raster = { width: w, height: h, data: new Uint8ClampedArray(r.data) };
  const f = clamp(Math.round(feather) || 0, 0, 32); // Infinity apagaria tudo (área infinita)
  // Tabela de somas dos apagados; fora da imagem conta como mantido, então a borda da imagem não é suavizada.
  let sums: Int32Array | null = null;
  const W = w + 1;
  if (f) {
    sums = new Int32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += mask[y * w + x] ? 1 : 0;
        sums[(y + 1) * W + x + 1] = sums[y * W + x + 1] + row;
      }
    }
  }
  const area = (2 * f + 1) * (2 * f + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) {
        out.data[i * 4 + 3] = 0;
        continue;
      }
      if (!sums) continue;
      const x0 = Math.max(0, x - f);
      const y0 = Math.max(0, y - f);
      const x1 = Math.min(w, x + f + 1);
      const y1 = Math.min(h, y + f + 1);
      const erased = sums[y1 * W + x1] - sums[y0 * W + x1] - sums[y1 * W + x0] + sums[y0 * W + x0];
      if (erased) out.data[i * 4 + 3] = Math.round((r.data[i * 4 + 3] * (area - erased)) / area);
    }
  }
  return out;
}

const EDT_INF = 1e20;

// Transformada de distância euclidiana exata (Felzenszwalb e Huttenlocher), uma linha por vez.
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Cobertura do contorno (0 = fora, 255 = cheio, intermediário = borda suavizada) do tamanho da imagem.
// A silhueta são os pixels de alfa >= 128, dilatada por um disco exato de raio radius (sem falhas entre direções).
// O contorno é cortado na borda da imagem: use padRaster antes, ou withOutline, que já faz isso.
export function outlineMask(r: Raster, radius: number): Uint8Array<ArrayBuffer> {
  assertRaster(r);
  const { width: w, height: h, data } = r;
  // Nenhuma distância dentro da imagem chega a w + h: o teto mantém o sentinela "longe" abaixo de R + 1.
  const R = clamp(finiteOr(radius, 0), 0, w + h);
  const n = w * h;
  const out = new Uint8Array(n);
  // 1ª passada: distância vertical até a silhueta, em duas varreduras de linhas inteiras (memória contínua).
  // Uma coluna a R + 1 ou mais não alcança o contorno, então vira infinito e a linha inteira pode ser pulada.
  const far = 1 << 29;
  const vd = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w; x < w; x++, i++) vd[i] = data[i * 4 + 3] >= 128 ? 0 : y ? Math.min(far, vd[i - w] + 1) : far;
  }
  for (let y = h - 2; y >= 0; y--) {
    for (let x = 0, i = y * w; x < w; x++, i++) if (vd[i + w] + 1 < vd[i]) vd[i] = vd[i + w] + 1;
  }
  // 2ª passada: envelope de parábolas em cada linha (Felzenszwalb e Huttenlocher), distância euclidiana exata.
  const f = new Float64Array(w);
  const d = new Float64Array(w);
  const v = new Int32Array(w);
  const z = new Float64Array(w + 1);
  const g = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    let reach = false;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const dy = vd[i];
      f[x] = dy < R + 1 ? dy * dy : EDT_INF;
      reach ||= dy < R + 1;
    }
    if (!reach) {
      g.fill(EDT_INF, y * w, (y + 1) * w);
      continue;
    }
    edt1d(f, w, d, v, z);
    g.set(d.subarray(0, w), y * w);
  }
  // Um pixel a distância d (centro a centro) cobre [d − 0,5, d + 0,5]; a borda da silhueta fica a 0,5 do último centro.
  const full = R * R;
  const none = (R + 1) * (R + 1);
  for (let i = 0; i < n; i++) {
    const d2 = g[i];
    if (d2 <= full) out[i] = 255;
    else if (d2 < none) out[i] = Math.round(clamp(R + 1 - Math.sqrt(d2), 0, 1) * 255);
  }
  return out;
}

// Contorno pronto: margem para o traço, contorno da cor pedida por baixo e a imagem por cima.
export function withOutline(r: Raster, radius: number, color: readonly [number, number, number] = [255, 255, 255]): Raster {
  const R = clamp(finiteOr(radius, 0), 0, STICKER_LIMITS.maxSide / 2); // acima disso workSide já é 1 px
  const padded = padRaster(r, Math.ceil(R) + 1);
  const cover = outlineMask(padded, R);
  const d = padded.data;
  for (let i = 0; i < cover.length; i++) {
    const o = i * 4;
    const a = d[o + 3] / 255;
    const b = (cover[i] / 255) * (1 - a);
    const outA = a + b;
    if (!outA) continue;
    d[o] = (d[o] * a + color[0] * b) / outA;
    d[o + 1] = (d[o + 1] * a + color[1] * b) / outA;
    d[o + 2] = (d[o + 2] * a + color[2] * b) / outA;
    d[o + 3] = Math.round(outA * 255);
  }
  return padded;
}

// ---------- Redimensionar ----------

interface AxisWeights {
  start: Int32Array; // primeiro pixel de origem de cada pixel de destino
  count: Int32Array;
  offset: Int32Array; // onde começam os pesos de cada destino em weight
  weight: Float64Array;
}

// Média por área: cada pixel de destino cobre [i·s, (i + 1)·s) da origem e pesa cada pixel pela sobreposição.
function axisWeights(src: number, dst: number): AxisWeights {
  const s = src / dst;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const offset = new Int32Array(dst);
  const list: number[] = [];
  for (let i = 0; i < dst; i++) {
    const a = i * s;
    const b = Math.min(src, (i + 1) * s);
    const j0 = Math.floor(a);
    const j1 = Math.min(src, Math.ceil(b));
    start[i] = j0;
    offset[i] = list.length;
    for (let j = j0; j < j1; j++) list.push((Math.min(b, j + 1) - Math.max(a, j)) / s);
    count[i] = j1 - j0;
  }
  return { start, count, offset, weight: Float64Array.from(list) };
}

// Redimensiona com média por área em alfa pré-multiplicado (o fundo apagado não escurece a borda).
export function resizeArea(r: Raster, width: number, height: number): Raster {
  assertRaster(r);
  const out = createRaster(width, height);
  const { width: sw, height: sh, data } = r;
  if (sw === width && sh === height) {
    out.data.set(data);
    return out;
  }
  const ax = axisWeights(sw, width);
  const ay = axisWeights(sh, height);
  // Passada horizontal: width × sh, pré-multiplicado.
  const tmp = new Float64Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < width; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let k = 0; k < ax.count[x]; k++) {
        const o = row + (ax.start[x] + k) * 4;
        const wa = ax.weight[ax.offset[x] + k] * data[o + 3];
        pr += data[o] * wa;
        pg += data[o + 1] * wa;
        pb += data[o + 2] * wa;
        pa += wa;
      }
      const t = (y * width + x) * 4;
      tmp[t] = pr;
      tmp[t + 1] = pg;
      tmp[t + 2] = pb;
      tmp[t + 3] = pa;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let k = 0; k < ay.count[y]; k++) {
        const t = ((ay.start[y] + k) * width + x) * 4;
        const wy = ay.weight[ay.offset[y] + k];
        pr += tmp[t] * wy;
        pg += tmp[t + 1] * wy;
        pb += tmp[t + 2] * wy;
        pa += tmp[t + 3] * wy;
      }
      const o = (y * width + x) * 4;
      if (pa > 0) {
        out.data[o] = pr / pa;
        out.data[o + 1] = pg / pa;
        out.data[o + 2] = pb / pa;
      }
      out.data[o + 3] = pa;
    }
  }
  return out;
}

// ---------- Tamanhos ----------

// Lado maior da área de trabalho: nunca amplia, nunca passa de 1024 e deixa espaço para o contorno no tamanho final.
export function workSide(longSide: number, outlinePx: number): number {
  const o = Math.max(0, finiteOr(outlinePx, 0));
  const long = Number.isNaN(longSide) ? 1 : Math.floor(longSide); // Infinity fica no teto de 1024
  const side = Math.min(long, STICKER_LIMITS.editorWorkMaxSide, 2 * (STICKER_LIMITS.maxSide - 2 * o));
  return Math.max(1, side);
}

// Tamanho final: o lado maior vira min(maxSide, L · maxUpscale). Lado menor estreito (900 × 40) é permitido.
export function fitSize(
  w: number,
  h: number,
  maxSide: number = STICKER_LIMITS.maxSide,
  minLongSide: number = STICKER_LIMITS.minLongSide,
  maxUpscale = 2,
): { width: number; height: number } {
  // Parâmetros quebrados (NaN, Infinity, negativos) voltam ao padrão; lados não finitos não são imagem.
  const side = Number.isFinite(maxSide) && maxSide >= 1 ? Math.floor(maxSide) : STICKER_LIMITS.maxSide;
  const min = Number.isFinite(minLongSide) && minLongSide >= 0 ? minLongSide : STICKER_LIMITS.minLongSide;
  const up = Number.isFinite(maxUpscale) && maxUpscale > 0 ? maxUpscale : 2;
  const small = () => new Error(`A imagem é pequena demais (mínimo de ${min} px no lado maior).`);
  if (!(w > 0 && h > 0)) throw small();
  if (!(Number.isFinite(w) && Number.isFinite(h))) throw new RangeError('Imagem inválida para edição.');
  const long = Math.max(w, h);
  const target = Math.min(side, Math.floor(long * up));
  if (target < min) throw small();
  const k = target / long;
  return w >= h ? { width: target, height: clamp(Math.round(h * k), 1, target) } : { width: clamp(Math.round(w * k), 1, target), height: target };
}

// Onde a imagem w × h fica, centralizada e inteira, numa tela quadrada de side px.
export function squareCanvas(w: number, h: number, side: number = STICKER_LIMITS.maxSide): { side: number; x: number; y: number; width: number; height: number } {
  const s = Number.isFinite(side) ? Math.max(1, Math.round(side)) : STICKER_LIMITS.maxSide;
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return { side: s, x: 0, y: 0, width: s, height: s };
  const k = s / Math.max(w, h);
  const width = clamp(Math.round(w * k), 1, s);
  const height = clamp(Math.round(h * k), 1, s);
  return { side: s, x: Math.floor((s - width) / 2), y: Math.floor((s - height) / 2), width, height };
}

// Tentativas do codificador, em ordem: primeiro a qualidade, só depois o tamanho. Para no primeiro abaixo do limite.
export function encodeSteps(kind: 'webp' | 'png'): Array<{ scale: number; quality?: number }> {
  if (kind === 'png') return [{ scale: 1 }, { scale: 0.875 }, { scale: 0.75 }, { scale: 0.625 }, { scale: 0.5 }];
  return [
    { scale: 1, quality: 0.9 },
    { scale: 1, quality: 0.8 },
    { scale: 1, quality: 0.7 },
    { scale: 0.875, quality: 0.8 },
    { scale: 0.75, quality: 0.8 },
    { scale: 0.625, quality: 0.75 },
  ];
}

// ---------- Hash perceptual ----------

// dHash de 64 bits: sobre branco, luminância, média por área para 9 × 8 e "o da esquerda é mais claro" por linha.
// 16 hex minúsculos, a primeira linha nos bits mais altos (o mesmo PHASH_RE de stickers.ts).
export function dhash(r: Raster): string {
  assertRaster(r);
  const { width: w, height: h, data } = r;
  const lum = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    const bg = 255 * (1 - a);
    lum[i] = 0.299 * (data[o] * a + bg) + 0.587 * (data[o + 1] * a + bg) + 0.114 * (data[o + 2] * a + bg);
  }
  const ax = axisWeights(w, 9);
  const ay = axisWeights(h, 8);
  const small = new Float64Array(72);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      let acc = 0;
      for (let ky = 0; ky < ay.count[y]; ky++) {
        const row = (ay.start[y] + ky) * w;
        const wy = ay.weight[ay.offset[y] + ky];
        for (let kx = 0; kx < ax.count[x]; kx++) acc += lum[row + ax.start[x] + kx] * wy * ax.weight[ax.offset[x] + kx];
      }
      small[y * 9 + x] = acc;
    }
  }
  // A margem absorve o erro de arredondamento das médias: área lisa dá bit 0, nunca ruído.
  let hi = 0;
  let lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = small[y * 9 + x] - small[y * 9 + x + 1] > 1e-6 ? 1 : 0;
      if (y < 4) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// ---------- Operações de máscara ----------

// Guardadas em coordenadas da imagem de origem; o editor as reaplica quando o recorte muda.
export type MaskOp =
  | { kind: 'flat-bg'; tolerance: number }
  | { kind: 'fill'; x: number; y: number; tolerance: number }
  | { kind: 'brush'; points: Array<[number, number]>; radius: number; erase: boolean }
  | { kind: 'reset' };

type ToWork = (x: number, y: number) => [number, number];

function applyOp(r: Raster, mask: Uint8Array, op: MaskOp, toWork: ToWork, k: number): void {
  if (op.kind === 'reset') mask.fill(0);
  else if (op.kind === 'flat-bg') fillInto(r, backgroundSeeds(r, op.tolerance), op.tolerance, mask);
  else if (op.kind === 'fill') fillInto(r, [toWork(op.x, op.y)], op.tolerance, mask);
  else if (op.kind === 'brush')
    paintMask(mask, r.width, r.height, { points: op.points.map(([x, y]) => toWork(x, y)), radius: op.radius * k, erase: op.erase });
}

const brushScale = (scale: number) => (Number.isFinite(scale) && scale > 0 ? scale : 1);

// O que vem antes do último reset não muda o resultado.
function afterLastReset(ops: readonly MaskOp[]): number {
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].kind === 'reset') return i + 1;
  return 0;
}

// Máscara da área de trabalho r: começa vazia e aplica as operações em ordem. toWork leva um ponto da origem para
// a área de trabalho e scale (px de trabalho por px de origem) ajusta o raio do pincel.
export function replayMask(r: Raster, ops: readonly MaskOp[], toWork: ToWork, scale: number): Uint8Array<ArrayBuffer> {
  assertRaster(r);
  const mask = new Uint8Array(r.width * r.height);
  const k = brushScale(scale);
  for (let i = afterLastReset(ops); i < ops.length; i++) applyOp(r, mask, ops[i], toWork, k);
  return mask;
}

const REPLAY_SAVED = 4;

function sameData(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
    const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// replayMask com memória, para o editor: guarda a máscara depois de cada fundo liso ou preenchimento (os passos
// caros) e, quando a lista nova começa com as mesmas operações, só refaz o que vem depois. Um traço novo ou desfeito
// custa só os traços seguintes ao último passo caro. Tudo é comparado por valor, porque o Worker recebe cópias a cada
// prévia: os pixels de r, o scale, as operações (JSON) e toWork, que precisa ser afim (como o affine do Worker) e é
// conferida em três pontos. Qualquer diferença recomeça do zero, então o resultado é sempre o de replayMask.
export function createMaskReplay(): (r: Raster, ops: readonly MaskOp[], toWork: ToWork, scale: number) => Uint8Array<ArrayBuffer> {
  let base: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>; probe: number[]; scale: number } | null = null;
  let saved: Array<{ sigs: string[]; mask: Uint8Array<ArrayBuffer> }> = [];
  return (r, ops, toWork, scale) => {
    assertRaster(r);
    const k = brushScale(scale);
    const probe = [...toWork(0, 0), ...toWork(1, 0), ...toWork(0, 1)];
    const same =
      base &&
      base.width === r.width &&
      base.height === r.height &&
      base.scale === k &&
      base.probe.every((v, i) => Object.is(v, probe[i])) &&
      sameData(base.data, r.data);
    if (!same) {
      base = { width: r.width, height: r.height, data: r.data.slice(), probe, scale: k };
      saved = [];
    }
    const sigs = ops.map((op) => JSON.stringify(op));
    const mask = new Uint8Array(r.width * r.height);
    let from = afterLastReset(ops);
    let best: (typeof saved)[number] | null = null;
    for (const s of saved) {
      const n = s.sigs.length;
      if (n < from || n > ops.length || (best && n <= best.sigs.length)) continue;
      if (s.sigs.every((g, i) => g === sigs[i])) best = s;
    }
    if (best) {
      mask.set(best.mask);
      from = best.sigs.length;
    }
    for (let i = from; i < ops.length; i++) {
      applyOp(r, mask, ops[i], toWork, k);
      if (ops[i].kind === 'flat-bg' || ops[i].kind === 'fill') {
        saved.push({ sigs: sigs.slice(0, i + 1), mask: mask.slice() });
        if (saved.length > REPLAY_SAVED) saved.shift();
      }
    }
    return mask;
  };
}
