import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { crc32 } from '@shared/imageProbe';
import {
  alphaBounds,
  applyMask,
  backgroundSeeds,
  createMaskReplay,
  createRaster,
  cropRaster,
  dhash,
  edgeLooksUniform,
  edgeSeeds,
  encodeSteps,
  fitSize,
  floodFillMask,
  hasTransparency,
  outlineMask,
  padRaster,
  padRect,
  paintMask,
  replayMask,
  resizeArea,
  squareCanvas,
  toleranceToDistance,
  withOutline,
  workSide,
  type MaskOp,
  type Raster,
} from '@shared/stickerEdit';
import { PHASH_RE, phashDistance } from '@shared/stickers';
import { inflateRawStream, readStickerPack, readZip, zipDisplayName, ZipError, type ZipEntry } from '@shared/zipRead';
import { bytes, le16, le32, png, randomBytes, rng, webp } from './sticker-bytes';

// Editor e importação de figurinhas: funções puras, sem servidor nem banco de dados.

type RGBA = [number, number, number, number];

function raster(w: number, h: number, fill: (x: number, y: number) => RGBA): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r.data.set(fill(x, y), (y * w + x) * 4);
  return r;
}
const px = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
const at = (m: Uint8Array, w: number, x: number, y: number) => m[y * w + x];
const ones = (m: Uint8Array) => m.reduce((a, v) => a + (v ? 1 : 0), 0);

const WHITE: RGBA = [255, 255, 255, 255];
const RED: RGBA = [255, 0, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];
const CLEAR: RGBA = [0, 0, 0, 0];

describe('stickerEdit: margens, fundo e pincel', () => {
  it('alphaBounds e padRect', () => {
    const r = raster(100, 80, (x, y) => (x >= 10 && x < 90 && y >= 10 && y < 70 ? RED : CLEAR));
    expect(alphaBounds(r)).toEqual({ x: 10, y: 10, width: 80, height: 60 });
    // Limiar padrão 8: alfa 7 não conta, alfa 8 conta.
    const faint = raster(20, 20, (x, y) => (x === 3 && y === 4 ? [0, 0, 0, 7] : x === 15 && y === 12 ? [0, 0, 0, 8] : CLEAR));
    expect(alphaBounds(faint)).toEqual({ x: 15, y: 12, width: 1, height: 1 });
    expect(alphaBounds(faint, 1)).toEqual({ x: 3, y: 4, width: 13, height: 9 });
    expect(alphaBounds(createRaster(30, 30))).toBeNull();

    expect(padRect({ x: 10, y: 10, width: 80, height: 60 }, 4, 100, 80)).toEqual({ x: 6, y: 6, width: 88, height: 68 });
    expect(padRect({ x: 2, y: 3, width: 10, height: 10 }, 5, 14, 14)).toEqual({ x: 0, y: 0, width: 14, height: 14 });
    expect(padRect({ x: 5, y: 5, width: 5, height: 5 }, -3, 20, 20)).toEqual({ x: 5, y: 5, width: 5, height: 5 });

    // Recortar as margens e devolver a margem para o contorno.
    const cut = cropRaster(r, alphaBounds(r)!);
    expect([cut.width, cut.height]).toEqual([80, 60]);
    expect(hasTransparency(cut)).toBe(false);
    const padded = padRaster(cut, 3);
    expect([padded.width, padded.height]).toEqual([86, 66]);
    expect(px(padded, 0, 0)).toEqual(CLEAR);
    expect(px(padded, 3, 3)).toEqual(RED);
    expect(alphaBounds(padded)).toEqual({ x: 3, y: 3, width: 80, height: 60 });
    expect(hasTransparency(padded)).toBe(true);
  });

  it('floodFillMask remove fundo uniforme e respeita a tolerância', () => {
    // Fundo branco, círculo vermelho e um anel claro de antisserrilhado (distância 21,2 do branco).
    const PINK: RGBA = [255, 240, 240, 255];
    const r = raster(64, 64, (x, y) => {
      const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32);
      return d <= 20 ? RED : d <= 21.5 ? PINK : WHITE;
    });
    const kind = (want: RGBA) => Array.from({ length: 64 * 64 }, (_, i) => px(r, i % 64, (i / 64) | 0).join() === want.join());
    const white = kind(WHITE);
    const ring = kind(PINK);
    const circle = kind(RED);
    expect(ring.filter(Boolean).length).toBeGreaterThan(50);
    const seeds = edgeSeeds(r);

    const exact = floodFillMask(r, seeds, 0);
    expect(Array.from(exact, Boolean)).toEqual(white); // tolerância 0: só o branco exato
    // 17 → 20,4 em RGB não alcança o anel; 18 → 21,6 alcança.
    expect(Array.from(floodFillMask(r, seeds, 17), Boolean)).toEqual(white);
    const soft = floodFillMask(r, seeds, 24);
    expect(Array.from(soft, Boolean)).toEqual(white.map((w, i) => w || ring[i]));
    expect(Array.from(floodFillMask(r, seeds, 18), Boolean)).toEqual(white.map((w, i) => w || ring[i]));
    expect(circle.every((c, i) => !c || !soft[i])).toBe(true); // o círculo fica intacto

    // base entra somada.
    const base = new Uint8Array(64 * 64);
    base[32 * 64 + 32] = 1;
    const withBase = floodFillMask(r, seeds, 24, base);
    expect(at(withBase, 64, 32, 32)).toBe(1);
    expect(ones(withBase)).toBe(ones(soft) + 1);
    expect(at(base, 64, 0, 0)).toBe(0); // base não é alterada

    // 4-conexo: uma diagonal de 1 px separa os dois triângulos.
    const diag = raster(20, 20, (x, y) => (x === y ? RED : WHITE));
    const lower = floodFillMask(diag, [[0, 19]], 24);
    expect(ones(lower)).toBe(190);
    expect(at(lower, 20, 19, 0)).toBe(0);

    // Pixel transparente já está apagado e deixa passar; um opaco de outra cor segura.
    const gapClear = raster(30, 10, (x) => (x === 10 ? CLEAR : WHITE));
    expect(ones(floodFillMask(gapClear, [[0, 0]], 0))).toBe(300);
    const gapRed = raster(30, 10, (x) => (x === 10 ? RED : WHITE));
    expect(ones(floodFillMask(gapRed, [[0, 0]], 0))).toBe(100);
    // Semente transparente ou fora da imagem não faz nada.
    expect(ones(floodFillMask(gapClear, [[10, 5], [-1, 3], [99, 2]], 100))).toBe(0);
    expect(toleranceToDistance(24)).toBeCloseTo(28.8);
    expect([toleranceToDistance(-5), toleranceToDistance(100), toleranceToDistance(400), toleranceToDistance(NaN)]).toEqual([0, 120, 120, 0]);
  });

  it('floodFillMask segue a tolerância exata em toda a escala do controle', () => {
    // Linha de cima com a cor da semente; embaixo, um pixel para cada distância² inteira possível até 120².
    // Cada pixel de baixo encosta na linha de cima, então sai apagado só se a própria distância couber.
    const seen = new Set<number>();
    const colors: RGBA[] = [];
    for (let a = 0; a <= 120; a++) {
      for (let b = 0; b <= a; b++) {
        for (let c = 0; c <= b; c++) {
          const d2 = a * a + b * b + c * c;
          if (d2 > 14_400 || seen.has(d2)) continue;
          seen.add(d2);
          colors.push([120 + a, 120 + b, 120 + c, 255]);
        }
      }
    }
    const w = colors.length;
    const strip = raster(w, 2, (x, y) => (y === 0 ? [120, 120, 120, 255] : colors[x]));
    for (let t = 0; t <= 100; t++) {
      const limit = toleranceToDistance(t) ** 2;
      const m = floodFillMask(strip, [[0, 0]], t);
      const wrong = colors.filter(([r, g, b], x) => (m[w + x] === 1) !== ((r - 120) ** 2 + (g - 120) ** 2 + (b - 120) ** 2 <= limit));
      expect(wrong).toEqual([]);
    }
  });

  it('edgeLooksUniform', () => {
    const disc = (bg: (x: number, y: number) => RGBA) =>
      raster(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 30 ? BLUE : bg(x, y)));
    expect(edgeLooksUniform(disc(() => WHITE), 24)).toBe(true);

    const noise = rng(7);
    const n = () => Math.round((noise() - 0.5) * 6);
    const noisy = disc(() => [252 + n(), 250 + n(), 248 + n(), 255]);
    expect(edgeLooksUniform(noisy, 24)).toBe(true);
    expect(edgeLooksUniform(noisy, 0)).toBe(false);

    // Foto: a borda muda de cor o tempo todo.
    const photo = raster(100, 100, (x, y) => [x * 2.5, y * 2.5, (x * 7 + y * 3) % 256, 255]);
    expect(edgeLooksUniform(photo, 24)).toBe(false);

    // Pessoa recortada nos ombros: o objeto encosta em 15 % da borda e o fundo continua liso.
    const shoulders = raster(100, 100, (x, y) => (x >= 20 && x < 80 && y >= 60 ? [40, 30, 90, 255] : WHITE));
    expect(edgeLooksUniform(shoulders, 24)).toBe(true);
    // Metade da borda tomada pelo objeto: não oferece o botão.
    const half = raster(100, 100, (x, y) => (y >= 50 ? [40, 30, 90, 255] : WHITE));
    expect(edgeLooksUniform(half, 24)).toBe(false);
    // Fundo já transparente: nada a remover.
    expect(edgeLooksUniform(disc(() => CLEAR), 24)).toBe(false);
  });

  it('edgeSeeds e backgroundSeeds: o fundo liso não leva junto o que encosta na borda', () => {
    const r = raster(10, 10, (x, y) => (x === 0 && y === 4 ? CLEAR : WHITE));
    const seeds = edgeSeeds(r);
    const keys = seeds.map(([x, y]) => `${x},${y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['0,0', '9,0', '0,9', '9,9', '4,0', '8,0', '0,8']));
    expect(keys).not.toContain('0,4'); // transparente
    expect(seeds.every(([x, y]) => x === 0 || y === 0 || x === 9 || y === 9)).toBe(true);
    expect(edgeSeeds(r, 1).length).toBe(35);

    const shoulders = raster(100, 100, (x, y) => (x >= 20 && x < 80 && y >= 60 ? [40, 30, 90, 255] : WHITE));
    const bg = backgroundSeeds(shoulders, 24);
    expect(bg.length).toBeGreaterThan(0);
    expect(bg.every(([x, y]) => px(shoulders, x, y).join() === WHITE.join())).toBe(true);
    const mask = replayMask(shoulders, [{ kind: 'flat-bg', tolerance: 24 }], (x, y) => [x, y], 1);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) expect(at(mask, 100, x, y)).toBe(x >= 20 && x < 80 && y >= 60 ? 0 : 1);
    }
    // Com todas as sementes da borda, a camisa sumiria.
    const naive = floodFillMask(shoulders, edgeSeeds(shoulders), 24);
    expect(at(naive, 100, 50, 80)).toBe(1);
    expect(backgroundSeeds(createRaster(8, 8), 24)).toEqual([]);
  });

  it('floodFillMask com várias sementes: cada uma compara com a própria cor, dá a união exata e não depende da ordem', () => {
    const unionOf = (r: Raster, seeds: Array<[number, number]>, tol: number) => {
      const u = new Uint8Array(r.width * r.height);
      for (const s of seeds) floodFillMask(r, [s], tol).forEach((v, i) => (u[i] |= v));
      return u;
    };
    const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
    const outside = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v && !b[i] ? 1 : 0), 0);
    const shuffled = <T,>(list: T[], seed: number) => {
      const n = rng(seed);
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(n() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };

    // Branco em cima à esquerda, vermelho embaixo e à direita, coluna 10 transparente: a semente vermelha só chega
    // à direita pela coluna transparente, que a branca alcança primeiro.
    const two = raster(20, 10, (x, y) => (x === 10 ? CLEAR : x < 10 && y < 5 ? WHITE : RED));
    expect(ones(floodFillMask(two, [[0, 9]], 0))).toBe(150);
    expect(ones(floodFillMask(two, [[0, 0], [0, 9]], 0))).toBe(200);
    expect(ones(floodFillMask(two, [[0, 9], [0, 0]], 0))).toBe(200);

    // Fundo com vinheta (claro no meio, 200 nos cantos): o "Remover fundo liso" apaga exatamente a união dos
    // preenchimentos de cada semente com a própria cor, em qualquer ordem das sementes.
    const vignette = (color: RGBA, cx: number, cy: number, rad: number) => {
      const maxD = Math.hypot(150, 150);
      const subject = new Uint8Array(300 * 300);
      const r = raster(300, 300, (x, y) => {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < rad) return (subject[y * 300 + x] = 1), color;
        const g = Math.round(255 - 55 * (Math.hypot(x + 0.5 - 150, y + 0.5 - 150) / maxD) ** 2);
        return [g, g, g, 255];
      });
      return { r, subject };
    };
    const both = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v && b[i] ? 1 : 0), 0);
    const red = vignette([200, 30, 40, 255], 150, 150, 60);
    expect(edgeLooksUniform(red.r, 24)).toBe(true);
    const seeds = backgroundSeeds(red.r, 24);
    const union = unionOf(red.r, seeds, 24);
    const flat = replayMask(red.r, [{ kind: 'flat-bg', tolerance: 24 }], (x, y) => [x, y], 1);
    expect(ones(union)).toBe(63_000); // antes de comparar cada semente com a própria cor: 47.440
    expect(diff(flat, union)).toBe(0);
    expect(diff(floodFillMask(red.r, [...seeds].reverse(), 24), flat)).toBe(0);
    expect(diff(floodFillMask(red.r, shuffled(seeds, 5), 24), flat)).toBe(0);
    expect(both(flat, red.subject)).toBe(0);

    // Caneca cinza no alto, da cor de uma parte mais escura da vinheta. Comparando cada pixel com a cor de qualquer
    // semente, o preenchimento passava de faixa em faixa da vinheta e apagava a caneca inteira (2.828 px); com a cor
    // da própria semente, nenhuma chega nela.
    for (const g of [200, 205]) {
      const mug = vignette([g, g, g, 255], 150, 75, 30);
      expect(edgeLooksUniform(mug.r, 24)).toBe(true);
      const mugSeeds = backgroundSeeds(mug.r, 24);
      const mugFlat = replayMask(mug.r, [{ kind: 'flat-bg', tolerance: 24 }], (x, y) => [x, y], 1);
      expect(ones(mug.subject)).toBe(2828);
      expect(both(mugFlat, mug.subject)).toBe(0);
      expect(diff(mugFlat, unionOf(mug.r, mugSeeds, 24))).toBe(0);
      expect(diff(floodFillMask(mug.r, shuffled(mugSeeds, g), 24), mugFlat)).toBe(0);
    }

    // Sementes ao acaso numa imagem de manchas: numa imagem pequena o teto de trabalho sobra, e o resultado é a união
    // exata dos preenchimentos de cada semente sozinha, em qualquer ordem.
    const noise = rng(31);
    const palette: RGBA[] = [WHITE, [235, 235, 230, 255], [250, 220, 220, 255], RED, BLUE, CLEAR];
    const blots = Array.from({ length: 14 }, () => [noise() * 48, noise() * 36, 3 + noise() * 9, Math.floor(noise() * palette.length)]);
    const spots = raster(48, 36, (x, y) => {
      const hit = blots.find(([cx, cy, cr]) => Math.hypot(x - cx, y - cy) <= cr);
      const c = hit ? palette[hit[3]] : WHITE;
      const j = c[3] ? Math.round((noise() - 0.5) * 10) : 0;
      return [c[0] + j, c[1] + j, c[2] - j, c[3]];
    });
    for (let trial = 0; trial < 60; trial++) {
      const tol = Math.floor(noise() * 40);
      const list = Array.from({ length: 2 + Math.floor(noise() * 12) }, () => [Math.floor(noise() * 48), Math.floor(noise() * 36)] as [number, number]);
      const all = floodFillMask(spots, list, tol);
      expect(diff(all, unionOf(spots, list, tol))).toBe(0);
      expect(diff(floodFillMask(spots, shuffled(list, trial), tol), all)).toBe(0);
    }

    // Fundo com ruído no limite da tolerância: cada semente tem uma cor e o teto de trabalho corta antes de rodar todas.
    // Mesmo assim nada fora da união sai, o resultado não depende da ordem e quase toda a união sai.
    for (const [amp, tol] of [[20, 24], [12, 15], [4, 5]]) {
      const n = rng(amp * 7 + tol);
      const r = raster(256, 192, (x, y) => {
        const base = Math.hypot(x - 128, y - 96) < 48 ? [180, 60, 50] : [235, 235, 235];
        return [...base.map((v) => v + Math.round((n() * 2 - 1) * amp)), 255] as RGBA;
      });
      expect(edgeLooksUniform(r, tol)).toBe(true);
      const bg = backgroundSeeds(r, tol);
      const u = unionOf(r, bg, tol);
      const m = replayMask(r, [{ kind: 'flat-bg', tolerance: tol }], (x, y) => [x, y], 1);
      expect(outside(m, u)).toBe(0);
      expect(ones(m)).toBeGreaterThanOrEqual(ones(u) * 0.99);
      expect(at(m, 256, 128, 96)).toBe(0);
      expect(diff(floodFillMask(r, shuffled(bg, amp), tol), m)).toBe(0);
    }
  });

  it('paintMask apaga e restaura', () => {
    const m = new Uint8Array(100 * 100);
    paintMask(m, 100, 100, { points: [[20, 50], [80, 50]], radius: 10, erase: true });
    // O pixel conta quando o centro (x + 0,5, y + 0,5) cai a até 10 px do traço.
    expect([at(m, 100, 50, 50), at(m, 100, 50, 59), at(m, 100, 50, 40), at(m, 100, 10, 50), at(m, 100, 89, 50)]).toEqual([1, 1, 1, 1, 1]);
    expect([at(m, 100, 50, 60), at(m, 100, 50, 39), at(m, 100, 9, 50), at(m, 100, 90, 50)]).toEqual([0, 0, 0, 0]);
    expect(Math.abs(ones(m) - (60 * 20 + Math.PI * 100))).toBeLessThan(40); // cápsula de 60 × 20 com pontas redondas
    const before = Uint8Array.from(m);

    paintMask(m, 100, 100, { points: [[50, 50], [100, 50]], radius: 12, erase: false });
    for (let y = 0; y < 100; y++) {
      for (let x = 50; x < 100; x++) expect(at(m, 100, x, y)).toBe(0);
      for (let x = 0; x < 38; x++) expect(at(m, 100, x, y)).toBe(before[y * 100 + x]);
    }

    // Raio minúsculo: o pixel do ponto é marcado e a linha não tem falhas.
    const dot = new Uint8Array(20 * 20);
    paintMask(dot, 20, 20, { points: [[5.2, 5.7]], radius: 0, erase: true });
    expect(ones(dot)).toBe(1);
    expect(at(dot, 20, 5, 5)).toBe(1);
    const thin = new Uint8Array(30 * 30);
    paintMask(thin, 30, 30, { points: [[0.5, 0.5], [20.5, 7.5], [NaN, 3]], radius: 0.1, erase: true });
    for (let x = 0; x <= 20; x++) expect(Array.from({ length: 30 }, (_, y) => at(thin, 30, x, y)).some(Boolean)).toBe(true);
    // Fora da imagem não quebra nada.
    paintMask(thin, 30, 30, { points: [[-50, -50], [-40, -60]], radius: 5, erase: true });
    expect(() => paintMask(new Uint8Array(10), 4, 4, { points: [[1, 1]], radius: 1, erase: true })).toThrow(RangeError);
  });

  it('paintMask marca exatamente a cápsula de cada segmento e reaplica 30 traços rápido', () => {
    // Referência pixel a pixel: o centro do pixel a até r do segmento (r mínimo de 0,5).
    const noise = rng(17);
    for (let trial = 0; trial < 150; trial++) {
      const w = 20 + Math.floor(noise() * 40);
      const h = 20 + Math.floor(noise() * 40);
      let pts = Array.from({ length: 1 + Math.floor(noise() * 4) }, () => [noise() * (w + 20) - 10, noise() * (h + 20) - 10] as [number, number]);
      const [px0, py0] = pts[0];
      if (trial % 5 === 0) pts = [pts[0], [px0, py0 + (noise() - 0.5) * 30]]; // vertical: as pontas continuam redondas
      if (trial % 5 === 1) pts = [pts[0], [px0 + (noise() - 0.5) * 30, py0]]; // horizontal
      const radius = trial % 7 === 0 ? 0 : (trial % 5 < 2 ? 3 : 0) + noise() * 12;
      const got = new Uint8Array(w * h);
      paintMask(got, w, h, { points: pts, radius, erase: true });
      const r = Math.max(radius, 0.5);
      const want = new Uint8Array(w * h);
      const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((b, k) => [pts[k], b]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          want[y * w + x] = segs.some(([[ax, ay], [bx, by]]) => {
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.min(1, Math.max(0, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2)) : 0;
            return (x + 0.5 - ax - t * dx) ** 2 + (y + 0.5 - ay - t * dy) ** 2 <= r * r;
          })
            ? 1
            : 0;
        }
      }
      expect(Array.from(got)).toEqual(Array.from(want));
    }

    // Pincel "G" (40 px na tela de 360 px, ~57 px de trabalho) em 30 traços de 90 pontos: o editor reaplica todos
    // os traços a cada prévia. Antes eram ~350 ms; a meta de 150 ms da prévia inteira é medida no navegador (§13).
    const work = createRaster(1024, 768);
    work.data.fill(255);
    const strokes: MaskOp[] = Array.from({ length: 30 }, (_, s) => ({
      kind: 'brush',
      points: Array.from({ length: 90 }, (_, k) => [40 + k * 6, 60 + ((s * 37) % 640) + Math.round(20 * Math.sin(k / 6))] as [number, number]),
      radius: 57,
      erase: s % 5 !== 4,
    }));
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t = performance.now();
      replayMask(work, strokes, (x, y) => [x, y], 1);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(100);
  });

  it('replayMask reaplica as operações depois de mudar o recorte', () => {
    const GREEN: RGBA = [0, 200, 0, 255];
    const src = raster(160, 120, (x, y) =>
      x >= 60 && x < 70 && y >= 50 && y < 60 ? GREEN : x >= 40 && x < 120 && y >= 30 && y < 90 ? BLUE : WHITE,
    );
    const ops: MaskOp[] = [
      { kind: 'flat-bg', tolerance: 24 },
      { kind: 'fill', x: 64.5, y: 54.5, tolerance: 10 },
      { kind: 'brush', points: [[45, 35], [100, 80]], radius: 4, erase: true },
      { kind: 'brush', points: [[70, 57], [90, 57]], radius: 3, erase: false },
    ];
    const full = replayMask(src, ops, (x, y) => [x, y], 1);
    expect(at(full, 160, 0, 0)).toBe(1); // fundo
    expect(at(full, 160, 62, 52)).toBe(1); // ponto verde apagado pelo clique
    expect(at(full, 160, 110, 40)).toBe(0); // azul fica
    expect(at(full, 160, 80, 65)).toBe(1); // traço do pincel
    expect(at(full, 160, 72, 60)).toBe(1);
    expect(at(full, 160, 72, 57)).toBe(0); // apagado pelo pincel e restaurado

    // Outro recorte: (20, 10) a (150, 110). A máscara, levada de volta à origem, é a mesma.
    const crop = { x: 20, y: 10, width: 130, height: 100 };
    const work = cropRaster(src, crop);
    const cropped = replayMask(work, ops, (x, y) => [x - crop.x, y - crop.y], 1);
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) expect(at(cropped, crop.width, x, y)).toBe(at(full, 160, x + crop.x, y + crop.y));
    }

    // Metade do tamanho: o raio do pincel acompanha a escala.
    const half = resizeArea(src, 80, 60);
    const scaled = replayMask(half, ops, (x, y) => [x / 2, y / 2], 0.5);
    let agree = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 80; x++) {
        const block = at(full, 160, 2 * x, 2 * y) + at(full, 160, 2 * x + 1, 2 * y) + at(full, 160, 2 * x, 2 * y + 1) + at(full, 160, 2 * x + 1, 2 * y + 1);
        if ((block >= 2 ? 1 : 0) === at(scaled, 80, x, y)) agree++;
      }
    }
    expect(agree / (80 * 60)).toBeGreaterThan(0.98);
    // Perto do meio do traço (55 a 70 na origem), 3 px de trabalho para fora já não é pincel (raio 2, não 4).
    const brushOnly = replayMask(half, [ops[2]], (x, y) => [x / 2, y / 2], 0.5);
    expect(at(brushOnly, 80, 31, 24)).toBe(1);
    expect(at(brushOnly, 80, 33, 22)).toBe(0);

    // reset apaga tudo o que veio antes; o que vem depois continua valendo.
    expect(ones(replayMask(src, [...ops, { kind: 'reset' }], (x, y) => [x, y], 1))).toBe(0);
    const afterReset = replayMask(src, [...ops, { kind: 'reset' }, ops[2]], (x, y) => [x, y], 1);
    expect(Array.from(afterReset)).toEqual(Array.from(replayMask(src, [ops[2]], (x, y) => [x, y], 1)));
    // Clique que ficou fora do recorte não faz nada.
    expect(ones(replayMask(work, [{ kind: 'fill', x: 5, y: 5, tolerance: 24 }], (x, y) => [x - crop.x, y - crop.y], 1))).toBe(0);
  });

  it('createMaskReplay dá sempre o resultado de replayMask e só refaz o que vem depois do último passo caro', () => {
    const src = raster(160, 120, (x, y) => (Math.hypot(x - 80, y - 60) < 30 ? BLUE : x > 120 && y < 20 ? RED : WHITE));
    const id = (x: number, y: number): [number, number] => [x, y];
    let calls = 0;
    const counted = (x: number, y: number): [number, number] => {
      calls++;
      return [x, y];
    };
    const flat: MaskOp = { kind: 'flat-bg', tolerance: 24 };
    const click: MaskOp = { kind: 'fill', x: 130, y: 5, tolerance: 10 };
    const s1: MaskOp = { kind: 'brush', points: [[20, 20], [140, 100]], radius: 6, erase: true };
    const s2: MaskOp = { kind: 'brush', points: [[70, 50], [90, 70]], radius: 4, erase: false };
    const replay = createMaskReplay();
    const check = (r: Raster, ops: MaskOp[], toWork: (x: number, y: number) => [number, number] = id, scale = 1) =>
      expect(Array.from(replay(r, ops, toWork, scale))).toEqual(Array.from(replayMask(r, ops, toWork, scale)));
    // Traços novos, desfazer, tolerância mudada no lugar, cópia estruturada (como chega no Worker), reset.
    const steps: MaskOp[][] = [[flat], [flat, s1], [flat, s1, click], [flat, s1, click, s2], [flat, s1, click], [flat, s1]];
    for (const ops of steps) check(src, ops);
    const live: MaskOp = { kind: 'flat-bg', tolerance: 24 };
    check(src, [live, s1]);
    live.tolerance = 60;
    check(src, [live, s1]);
    check(src, structuredClone([flat, s1, click, s2]));
    check(src, [flat, s1, { kind: 'reset' }, click, s2]);
    // Outro recorte, outra escala e pixels mudados no mesmo objeto: tudo recomeça.
    const crop = cropRaster(src, { x: 10, y: 10, width: 140, height: 100 });
    check(crop, [flat, s1, s2], (x, y) => [x - 10, y - 10]);
    check(crop, [flat, s1, s2], (x, y) => [x - 10, y - 10], 0.5);
    check(crop, [flat, s1, s2], (x, y) => [(x - 10) / 2, (y - 10) / 2], 0.5);
    crop.data.fill(255, 0, 4 * 140 * 30);
    check(crop, [flat, s1, s2], (x, y) => [(x - 10) / 2, (y - 10) / 2], 0.5);
    // Passo caro depois de um traço: o que ficou guardado depende de toWork e da escala.
    check(crop, [s1, click, s2], (x, y) => [x - 10, y - 10], 1);
    check(crop, [s1, click, s2], (x, y) => [x - 10, y - 10], 2);
    check(crop, [s1, click, s2], (x, y) => [x - 30, y - 10], 2);
    check(crop, [s1, click, s2], (x, y) => [x - 30, y - 10], 2);

    // O clique (toWork 1 vez) só é refeito quando muda o que vem antes dele: 3 chamadas conferem a transformação.
    const fresh = createMaskReplay();
    calls = 0;
    fresh(src, [click, s1], counted, 1);
    expect(calls).toBe(3 + 1 + 2);
    calls = 0;
    fresh(src, structuredClone([click, s1, s2]), counted, 1);
    expect(calls).toBe(3 + 2 + 2);
    calls = 0;
    fresh(src, [{ ...click, tolerance: 30 }, s1], counted, 1);
    expect(calls).toBe(3 + 1 + 2);
  });

  it('applyMask suaviza a borda em 1 px', () => {
    const r = raster(20, 10, (x, y) => (x === 10 && y === 2 ? [255, 0, 0, 100] : RED));
    const mask = new Uint8Array(200);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) mask[y * 20 + x] = 1;
    const out = applyMask(r, mask);
    expect(px(out, 9, 5)).toEqual([255, 0, 0, 0]); // apagado de vez, sem halo
    expect(px(out, 10, 5)[3]).toBe(170); // 6 de 9 vizinhos mantidos
    expect(px(out, 11, 5)[3]).toBe(255);
    expect(px(out, 10, 2)[3]).toBe(67); // respeita o alfa original (100 · 6/9)
    expect(px(r, 9, 5)).toEqual(RED); // a entrada não muda

    const hard = applyMask(r, mask, 0);
    expect([px(hard, 9, 5)[3], px(hard, 10, 5)[3]]).toEqual([0, 255]);
    const wide = applyMask(r, mask, 2);
    expect([px(wide, 10, 5)[3], px(wide, 11, 5)[3], px(wide, 12, 5)[3]]).toEqual([153, 204, 255]);
    // A borda da própria imagem não é suavizada.
    expect(px(out, 19, 0)[3]).toBe(255);
    expect(() => applyMask(r, new Uint8Array(10))).toThrow(RangeError);
  });

  it('outlineMask dilata a silhueta no raio pedido', () => {
    const r = raster(80, 80, (x, y) => ((x - 40) ** 2 + (y - 40) ** 2 <= 100 ? RED : CLEAR));
    const m = outlineMask(r, 6);
    let partial = 0;
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const d = Math.hypot(x - 40, y - 40);
        const v = at(m, 80, x, y);
        if (d <= 15) expect(v).toBe(255); // disco cheio, sem falhas entre direções
        if (d >= 17.1) expect(v).toBe(0);
        if (v > 0 && v < 255) partial++;
      }
    }
    expect(partial).toBeGreaterThan(0); // borda suavizada
    expect([at(m, 80, 56, 40), at(m, 80, 57, 40), at(m, 80, 40, 24), at(m, 80, 40, 23)]).toEqual([255, 0, 255, 0]);
    expect(ones(outlineMask(createRaster(10, 10), 4))).toBe(0);

    // Forma irregular: a cobertura é exatamente a da distância euclidiana calculada na força bruta.
    const noise = rng(11);
    const blobs = Array.from({ length: 6 }, () => [8 + noise() * 44, 8 + noise() * 44, 2 + noise() * 6]);
    const shape = raster(60, 60, (x, y) => (blobs.some(([cx, cy, cr]) => Math.hypot(x - cx, y - cy) <= cr) ? RED : CLEAR));
    const inside: [number, number][] = [];
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) if (shape.data[(y * 60 + x) * 4 + 3]) inside.push([x, y]);
    for (const R of [0, 2.5, 8]) {
      const got = outlineMask(shape, R);
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 60; x++) {
          const d = Math.sqrt(Math.min(...inside.map(([sx, sy]) => (sx - x) ** 2 + (sy - y) ** 2)));
          expect(got[y * 60 + x]).toBe(d <= R ? 255 : Math.round(Math.min(1, Math.max(0, R + 1 - d)) * 255));
        }
      }
    }
    expect(Array.from(outlineMask(r, 0), (v, i) => v === 255)).toEqual(Array.from({ length: 6400 }, (_, i) => r.data[i * 4 + 3] >= 128));

    // withOutline abre espaço para o traço e pinta por baixo da imagem.
    const o = withOutline(r, 6);
    expect([o.width, o.height]).toEqual([94, 94]);
    expect(px(o, 47, 47)).toEqual(RED);
    expect(px(o, 61, 47)).toEqual(WHITE);
    expect(px(o, 47, 33)).toEqual(WHITE);
    expect(px(o, 0, 0)[3]).toBe(0);
    expect(alphaBounds(o)).toEqual({ x: 31, y: 31, width: 33, height: 33 });
    const blue = withOutline(r, 3, [0, 0, 255]);
    expect(px(blue, 4 + 40 + 12, 4 + 40)).toEqual(BLUE);
  });
});

describe('stickerEdit: tamanhos, redimensionamento e hash', () => {
  it('workSide', () => {
    expect(workSide(4000, 8)).toBe(992);
    expect(workSide(600, 8)).toBe(600);
    expect(workSide(5000, 0)).toBe(1024);
    expect(workSide(1000, 16)).toBe(960);
    expect(workSide(NaN, 8)).toBe(1);
    for (let side = 1; side <= 5000; side += 37) {
      for (const outline of [0, 2, 8, 16]) {
        const w = workSide(side, outline);
        expect(w).toBeLessThanOrEqual(1024);
        expect(w).toBeLessThanOrEqual(side);
      }
    }
  });

  it('fitSize', () => {
    expect(fitSize(1024, 512)).toEqual({ width: 512, height: 256 });
    expect(fitSize(512, 1024)).toEqual({ width: 256, height: 512 });
    expect(fitSize(100, 100)).toEqual({ width: 200, height: 200 }); // no máximo 2×
    expect(fitSize(300, 200)).toEqual({ width: 512, height: 341 });
    expect(fitSize(900, 40)).toEqual({ width: 512, height: 23 });
    expect(fitSize(48, 20)).toEqual({ width: 96, height: 40 });
    expect(() => fitSize(40, 40)).toThrow('A imagem é pequena demais (mínimo de 96 px no lado maior).');
    expect(() => fitSize(0, 50)).toThrow(/pequena demais/);
    expect(fitSize(2000, 1000, 256, 96, 1)).toEqual({ width: 256, height: 128 });
    expect(fitSize(5000, 1)).toEqual({ width: 512, height: 1 });
  });

  it('squareCanvas centraliza a imagem inteira', () => {
    expect(squareCanvas(1024, 512)).toEqual({ side: 512, x: 0, y: 128, width: 512, height: 256 });
    expect(squareCanvas(300, 600, 200)).toEqual({ side: 200, x: 50, y: 0, width: 100, height: 200 });
    expect(squareCanvas(50, 50)).toEqual({ side: 512, x: 0, y: 0, width: 512, height: 512 });
  });

  it('valores quebrados (NaN, Infinity) nunca viram NaN nem derrubam a prévia', () => {
    const r = raster(10, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? RED : CLEAR));
    const finite = (o: object) => Object.values(o).every((v) => Number.isFinite(v));
    const edge = new Uint8Array(100);
    for (let y = 0; y < 10; y++) edge[y * 10] = 1;
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(finite(padRect({ x: bad, y: 0, width: 5, height: 5 }, 2, 10, 10))).toBe(true);
      expect(finite(padRect({ x: 1, y: 1, width: bad, height: 5 }, bad, 10, 10))).toBe(true);
      expect(finite(padRect({ x: 1, y: 1, width: 5, height: 5 }, 1, bad, bad))).toBe(true);
      expect([cropRaster(r, { x: bad, y: 0, width: 5, height: 5 }).width, cropRaster(r, { x: 0, y: bad, width: bad, height: 5 }).height]).toEqual([
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(finite(squareCanvas(100, 50, bad))).toBe(true);
      expect(finite(squareCanvas(bad, 50))).toBe(true);
      expect(fitSize(100, 50, bad, bad, bad)).toEqual({ width: 200, height: 100 });
      const o = withOutline(r, bad);
      expect(finite({ w: o.width, h: o.height })).toBe(true);
      expect(alphaBounds(applyMask(r, edge, bad))).toEqual({ x: 3, y: 3, width: 4, height: 4 }); // Infinity apagaria tudo
    }
    // Área vazia ou indefinida: o 1 × 1 transparente do contrato.
    expect([cropRaster(r, { x: NaN, y: 0, width: 5, height: 5 }).width, cropRaster(r, { x: -Infinity, y: 0, width: Infinity, height: 5 }).width]).toEqual([1, 1]);
    expect(squareCanvas(100, 50, NaN)).toEqual({ side: 512, x: 0, y: 128, width: 512, height: 256 });
    expect(() => fitSize(Infinity, 10)).toThrow(RangeError);
    expect(() => fitSize(NaN, 10)).toThrow(/pequena demais/);
    expect([workSide(Infinity, 0), workSide(-Infinity, 0), workSide(600, NaN), workSide(600, Infinity)]).toEqual([1024, 1, 600, 600]); // contorno infinito conta como nenhum, como em withOutline
    // Raio enorme: imagem vazia continua sem contorno; com um pixel, tudo vira contorno.
    expect(Math.max(...outlineMask(createRaster(4, 4), 1e9))).toBe(0);
    expect(Math.min(...outlineMask(raster(4, 4, (x, y) => (x === 0 && y === 0 ? RED : CLEAR)), 1e9))).toBe(255);
    expect(ones(outlineMask(r, NaN))).toBe(16);
    expect(withOutline(r, 1e9).width).toBeLessThanOrEqual(10 + 2 * 257);
  });

  it('encodeSteps começa na qualidade 0,9 e só reduz o tamanho depois da qualidade', () => {
    const w = encodeSteps('webp');
    expect(w).toEqual([
      { scale: 1, quality: 0.9 },
      { scale: 1, quality: 0.8 },
      { scale: 1, quality: 0.7 },
      { scale: 0.875, quality: 0.8 },
      { scale: 0.75, quality: 0.8 },
      { scale: 0.625, quality: 0.75 },
    ]);
    const firstSmaller = w.findIndex((s) => s.scale < 1);
    expect(firstSmaller).toBe(3);
    const full = w.slice(0, firstSmaller);
    expect(full.every((s, i) => s.scale === 1 && (i === 0 || s.quality! < full[i - 1].quality!))).toBe(true);
    expect(w.every((s, i) => i === 0 || s.scale <= w[i - 1].scale)).toBe(true);
    const p = encodeSteps('png');
    expect(p).toEqual([{ scale: 1 }, { scale: 0.875 }, { scale: 0.75 }, { scale: 0.625 }, { scale: 0.5 }]);
    expect(p.every((s) => s.quality === undefined)).toBe(true);
    w[0].quality = 0.1; // cada chamada devolve uma lista nova
    expect(encodeSteps('webp')[0].quality).toBe(0.9);
  });

  it('resizeArea faz média por área em alfa pré-multiplicado', () => {
    const blocks = raster(4, 4, (x, y) => (x < 2 ? (y < 2 ? RED : BLUE) : y < 2 ? WHITE : [0, 0, 0, 255]));
    const small = resizeArea(blocks, 2, 2);
    expect([px(small, 0, 0), px(small, 0, 1), px(small, 1, 0), px(small, 1, 1)]).toEqual([RED, BLUE, WHITE, [0, 0, 0, 255]]);
    // Transparente preto + vermelho opaco = vermelho meio transparente (sem escurecer).
    expect(px(resizeArea(raster(2, 1, (x) => (x ? RED : CLEAR)), 1, 1), 0, 0)).toEqual([255, 0, 0, 128]);
    // Ampliar 2× repete cada pixel.
    const big = resizeArea(small, 4, 4);
    expect(Array.from(big.data)).toEqual(Array.from(blocks.data));
    // 3 → 2: cada destino cobre 1,5 pixel de origem.
    const ramp = resizeArea(raster(3, 1, (x) => [x * 90, x * 90, x * 90, 255]), 2, 1);
    expect([px(ramp, 0, 0)[0], px(ramp, 1, 0)[0]]).toEqual([30, 150]);
    const same = resizeArea(blocks, 4, 4);
    expect(same.data).not.toBe(blocks.data);
    expect(Array.from(same.data)).toEqual(Array.from(blocks.data));
    expect(() => resizeArea(blocks, 0, 3)).toThrow(RangeError);
  });

  it('dhash', () => {
    const scene = (variant: number, noise?: () => number) =>
      raster(512, 512, (x, y) => {
        const u = x / 512;
        const v = y / 512;
        const l =
          variant === 0
            ? 120 + 70 * Math.sin(u * 9 + 1) * Math.cos(v * 4) + (u > 0.55 && v < 0.45 ? 50 : 0) - (Math.hypot(u - 0.3, v - 0.7) < 0.15 ? 60 : 0)
            : 120 + 80 * Math.cos(u * 4 + 2) * Math.sin(v * 11) + (u < 0.4 && v > 0.5 ? 45 : 0);
        const n = () => (noise ? Math.round((noise() - 0.5) * 8) : 0);
        return [l + n(), l * 0.9 + 10 + n(), l * 0.7 + 30 + n(), 255];
      });
    const base = scene(0);
    const h = dhash(base);
    expect(h).toMatch(PHASH_RE);
    expect(dhash(base)).toBe(h);
    expect(phashDistance(h, dhash(scene(0, rng(42))))).toBeLessThanOrEqual(6); // ±4 por canal
    const roundTrip = resizeArea(resizeArea(base, 384, 384), 512, 512);
    expect(phashDistance(h, dhash(roundTrip))).toBeLessThanOrEqual(6);
    expect(phashDistance(h, dhash(resizeArea(base, 300, 300)))).toBeLessThanOrEqual(6);
    expect(phashDistance(h, dhash(scene(1)))).toBeGreaterThan(6);
    const mirrored = raster(512, 512, (x, y) => px(base, 511 - x, y) as RGBA);
    expect(phashDistance(h, dhash(mirrored))).toBeGreaterThan(6);

    // Transparente compõe sobre branco: a cor escondida não importa.
    expect(dhash(createRaster(64, 64))).toBe('0000000000000000');
    expect(dhash(raster(64, 64, (x) => [x * 4, 0, 255 - x * 4, 0]))).toBe('0000000000000000');
    const onClear = raster(90, 80, (x, y) => (Math.hypot(x - 30, y - 40) < 20 ? [0, 0, 0, 255] : CLEAR));
    const onWhite = raster(90, 80, (x, y) => (Math.hypot(x - 30, y - 40) < 20 ? [0, 0, 0, 255] : WHITE));
    expect(dhash(onClear)).toBe(dhash(onWhite));
    expect(dhash(onClear)).not.toBe('0000000000000000');
    // Bits de cima para baixo, o primeiro é o mais alto: só a linha de cima clara à esquerda.
    const topEdge = raster(90, 80, (x, y) => (y < 10 && x < 10 ? WHITE : [0, 0, 0, 255]));
    expect(dhash(topEdge)).toBe('8000000000000000');
  });

  it('trabalho de 1024 px fica num tempo de editor', () => {
    const r = raster(1024, 1024, (x, y) => (Math.hypot(x - 512, y - 512) < 300 ? [200, 40, 60, 255] : [250, 250, 248, 255]));
    const t = performance.now();
    const mask = replayMask(r, [{ kind: 'flat-bg', tolerance: 24 }, { kind: 'brush', points: [[100, 100], [900, 400]], radius: 20, erase: false }], (x, y) => [x, y], 1);
    const outlined = withOutline(applyMask(r, mask), 16);
    expect(alphaBounds(outlined)).not.toBeNull();
    // Folga grande: a máquina de testes é compartilhada; a meta de 150 ms é medida no navegador (§13).
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('fundo liso com ruído em 1024 x 768 fica num tempo de editor em toda a escala de tolerância', () => {
    // Ruído de JPEG: cada semente da borda tem uma cor. Com tolerância baixa, cada uma apaga só uns pixels; perto do
    // limite, os preenchimentos se sobrepõem. Nos dois casos o trabalho tem teto.
    for (const amp of [6, 20]) {
      const n = rng(amp);
      const r = raster(1024, 768, (x, y) => {
        const base = Math.hypot(x - 512, y - 384) < 192 ? [180, 60, 50] : [235, 235, 235];
        return [...base.map((v) => v + Math.round((n() * 2 - 1) * amp)), 255] as RGBA;
      });
      for (const tolerance of [5, 10, 15, 24, 40]) {
        const t = performance.now();
        const mask = replayMask(r, [{ kind: 'flat-bg', tolerance }], (x, y) => [x, y], 1);
        expect(performance.now() - t).toBeLessThan(2000); // folga grande, como acima
        expect(at(mask, 1024, 512, 384)).toBe(0);
        if (tolerance >= 24) expect(ones(mask)).toBeGreaterThan(0.95 * (1024 * 768 - Math.PI * 192 * 192));
      }
    }
  });
});

// ---------- ZIP ----------

const refCrc = (b: Uint8Array) => (typeof zlib.crc32 === 'function' ? zlib.crc32(b) : crc32(b)) >>> 0;
const inflate = async (d: Uint8Array, max: number) => zlib.inflateRawSync(d, { maxOutputLength: Math.max(1, max) });
const text = (s: string) => Buffer.from(s, 'utf8');

function zipReason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZipError) return e.reason;
    throw e;
  }
  return 'ok';
}
async function readReason(e: ZipEntry): Promise<string> {
  try {
    await e.read();
  } catch (err) {
    if (err instanceof ZipError) return err.reason;
    throw err;
  }
  return 'ok';
}

interface YazlFile {
  name: string;
  data: Buffer;
  compress?: boolean;
  stream?: boolean; // tamanho desconhecido: yazl grava descritor de dados (bit 3)
  zip64?: boolean;
}
function yazlZip(files: YazlFile[], end: { forceZip64Format?: boolean } = {}): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const f of files) {
    if (f.stream) {
      const s = new PassThrough();
      s.end(f.data);
      z.addReadStream(s, f.name, { compress: f.compress ?? true, forceZip64Format: !!f.zip64 });
    } else z.addBuffer(f.data, f.name, { compress: f.compress ?? true, forceZip64Format: !!f.zip64 });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
    z.end({ forceZip64Format: !!end.forceZip64Format, comment: '' });
  });
}

// ZIP montado byte a byte, para cabeçalhos que nenhum programa normal grava.
interface Part {
  name: string | Buffer;
  data?: Buffer;
  method?: number; // 8 comprime com zlib; outro valor grava os dados como estão
  flags?: number; // central (padrão UTF-8)
  compressed?: Buffer; // bytes gravados no lugar dos dados
  crc?: number;
  size?: number;
  compressedSize?: number;
  descriptor?: boolean; // zeros no cabeçalho local e descritor depois dos dados
  local?: { name?: Buffer | string; extra?: Buffer; flags?: number; method?: number; crc?: number; sizes?: [number, number]; sig?: number };
  centralExtra?: Buffer;
  offset?: number; // deslocamento do cabeçalho local declarado no diretório central
  noLocal?: boolean; // não grava o cabeçalho local (outra parte o carrega)
  diskStart?: number;
}
interface ZipOpts {
  total?: number;
  disk?: number;
  cdOffset?: number;
  cdSize?: number;
  comment?: Buffer;
  commentLen?: number;
  zip64Locator?: boolean;
  trailing?: Buffer;
}
function buildZip(parts: Part[], o: ZipOpts = {}): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  const push = (b: Buffer) => {
    out.push(b);
    pos += b.length;
  };
  const central: Buffer[] = [];
  for (const p of parts) {
    const name = typeof p.name === 'string' ? text(p.name) : p.name;
    const data = p.data ?? Buffer.alloc(0);
    const method = p.method ?? 0;
    const comp = p.compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = p.crc ?? refCrc(data);
    const flags = (p.flags ?? 0x0800) | (p.descriptor ? 8 : 0);
    const size = p.size ?? data.length;
    const compressedSize = p.compressedSize ?? comp.length;
    const offset = p.offset ?? pos;
    if (!p.noLocal) {
      const l = p.local ?? {};
      const lname = l.name === undefined ? name : typeof l.name === 'string' ? text(l.name) : l.name;
      const lextra = l.extra ?? Buffer.alloc(0);
      const [lc, ls] = l.sizes ?? (p.descriptor ? [0, 0] : [compressedSize, size]);
      push(
        bytes(
          le32(l.sig ?? 0x04034b50),
          le16(20),
          le16(l.flags ?? flags),
          le16(l.method ?? method),
          le16(0),
          le16(0x21),
          le32(l.crc ?? (p.descriptor ? 0 : crc)),
          le32(lc),
          le32(ls),
          le16(lname.length),
          le16(lextra.length),
          lname,
          lextra,
        ),
      );
      push(comp);
      if (p.descriptor) push(bytes(le32(0x08074b50), le32(crc), le32(compressedSize), le32(size)));
    }
    const cextra = p.centralExtra ?? Buffer.alloc(0);
    central.push(
      bytes(
        le32(0x02014b50),
        le16(20),
        le16(20),
        le16(flags),
        le16(method),
        le16(0),
        le16(0x21),
        le32(crc),
        le32(compressedSize),
        le32(size),
        le16(name.length),
        le16(cextra.length),
        le16(0),
        le16(p.diskStart ?? 0),
        le16(0),
        le32(0),
        le32(offset),
        name,
        cextra,
      ),
    );
  }
  const cdOffset = pos;
  const cd = Buffer.concat(central);
  push(cd);
  if (o.zip64Locator) push(bytes(le32(0x07064b50), le32(0), le32(cdOffset), le32(0), le32(1)));
  const comment = o.comment ?? Buffer.alloc(0);
  const n = o.total ?? parts.length;
  push(
    bytes(
      le32(0x06054b50),
      le16(o.disk ?? 0),
      le16(o.disk ?? 0),
      le16(n),
      le16(n),
      le32(o.cdSize ?? cd.length),
      le32(o.cdOffset ?? cdOffset),
      le16(o.commentLen ?? comment.length),
      comment,
    ),
  );
  if (o.trailing) push(o.trailing);
  return Buffer.concat(out);
}

describe('zipRead: leitura de ZIP hostil', () => {
  it('readZip lê ZIP sem compressão e com deflate e confere CRC', async () => {
    const photo = png({ w: 200, h: 150, noise: true, seed: 3 });
    const notes = text(Array.from({ length: 400 }, (_, i) => `linha ${i} da figurinha ${(i * 7919) % 1000}`).join('\n'));
    const z = await yazlZip([
      { name: 'guardada.png', data: photo, compress: false },
      { name: 'comprimida.txt', data: notes },
      { name: 'vazia.txt', data: Buffer.alloc(0) },
    ]);
    const entries = readZip(z, inflate);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['guardada.png', 0, photo.length],
      ['comprimida.txt', 8, notes.length],
      ['vazia.txt', 8, 0],
    ]);
    expect(entries.skipped).toEqual([]);
    expect(entries[1].compressedSize).toBeLessThan(notes.length / 2);
    expect(Buffer.from(await entries[0].read()).equals(photo)).toBe(true);
    expect(Buffer.from(await entries[1].read()).equals(notes)).toBe(true);
    expect((await entries[2].read()).length).toBe(0);
    // O mesmo ZIP pelo inflador do navegador (Compression Streams, também no Node).
    const viaStream = readZip(z, inflateRawStream);
    expect(Buffer.from(await viaStream[1].read()).equals(notes)).toBe(true);
    const out = await viaStream[0].read();
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);

    // Um byte trocado nos dados: o CRC acusa (guardado) ou o inflador falha (comprimido).
    const bad = Buffer.from(z);
    const storedAt = bad.indexOf(photo.subarray(0, 64));
    bad[storedAt + 100] ^= 0xff;
    const badEntries = readZip(bad, inflate);
    expect(await readReason(badEntries[0])).toBe('corrupt');
    const deflatedAt = storedAt + photo.length + 30 + 'comprimida.txt'.length;
    for (const k of [3, 10, 20]) {
      const flipped = Buffer.from(z);
      flipped[deflatedAt + k] ^= 0x55;
      expect(await readReason(readZip(flipped, inflate)[1])).toBe('corrupt');
    }
    // Inflador que devolve bytes a mais (ou que não devolve bytes) também é corrompido.
    const liar = readZip(z, async (d) => Buffer.concat([zlib.inflateRawSync(d), Buffer.from('x')]));
    expect(await readReason(liar[1])).toBe('corrupt');
    const broken = readZip(z, async () => 'nada' as unknown as Uint8Array);
    expect(await readReason(broken[1])).toBe('corrupt');
    // O atalho do design (Response(...).arrayBuffer()) devolve ArrayBuffer: também serve.
    const asBuffer = readZip(z, async (d) => {
      const u = zlib.inflateRawSync(d);
      return u.buffer.slice(u.byteOffset, u.byteOffset + u.length);
    });
    expect(Buffer.from(await asBuffer[1].read()).equals(notes)).toBe(true);
    // CRC errado declarado nos dois cabeçalhos, guardado ou comprimido (o deflate em si é válido).
    const wrongCrc = buildZip([
      { name: 'a.txt', data: text('olá'), crc: 1234 },
      { name: 'b.txt', data: notes, method: 8, crc: 1234 },
    ]);
    for (const inflater of [inflate, inflateRawStream]) {
      const w = readZip(wrongCrc, inflater);
      expect(w.map((e) => e.method)).toEqual([0, 8]);
      expect([await readReason(w[0]), await readReason(w[1])]).toEqual(['corrupt', 'corrupt']);
    }
    expect(Buffer.from(await readZip(buildZip([{ name: 'b.txt', data: notes, method: 8 }]), inflate)[0].read()).equals(notes)).toBe(true);
    // ZIP vazio é válido.
    expect(readZip(buildZip([]), inflate)).toHaveLength(0);
  });

  it('readZip usa os tamanhos do diretório central e o deslocamento do cabeçalho local', async () => {
    const a = webp({ kind: 'vp8l', w: 512, h: 512, dataBytes: 3000, seed: 5 });
    const b = text('segundo arquivo');
    // yazl grava 9 bytes de extra só no diretório central.
    const fromYazl = await yazlZip([
      { name: 'a.webp', data: a, compress: false },
      { name: 'b.txt', data: b },
    ]);
    const y = readZip(fromYazl, inflate);
    expect(Buffer.from(await y[0].read()).equals(a)).toBe(true);
    expect(Buffer.from(await y[1].read()).equals(b)).toBe(true);

    // O contrário: extra local de 37 bytes, central sem extra.
    const longLocal = buildZip([
      { name: 'a.webp', data: a, local: { extra: bytes(le16(0xcafe), le16(33), Buffer.alloc(33, 7)) } },
      { name: 'b.txt', data: b, method: 8, centralExtra: bytes(le16(0x5455), le16(5), [1, 0, 0, 0, 0]) },
    ]);
    const l = readZip(longLocal, inflate);
    expect(Buffer.from(await l[0].read()).equals(a)).toBe(true);
    expect(Buffer.from(await l[1].read()).equals(b)).toBe(true);

    // Descritor de dados (bit 3): o cabeçalho local tem zeros; CRC e tamanhos vêm do central.
    const streamed = await yazlZip([
      { name: 'c.webp', data: a, stream: true },
      { name: 'd.webp', data: a, stream: true, compress: false },
    ]);
    const s = readZip(streamed, inflate);
    expect(s.map((e) => [e.size, e.method])).toEqual([
      [a.length, 8],
      [a.length, 0],
    ]);
    expect(Buffer.from(await s[0].read()).equals(a)).toBe(true);
    expect(Buffer.from(await s[1].read()).equals(a)).toBe(true);
    const handMade = buildZip([{ name: 'e.txt', data: b, method: 8, descriptor: true }, { name: 'f.txt', data: b }]);
    expect(Buffer.from(await readZip(handMade, inflate)[1].read()).equals(b)).toBe(true);

    // Nomes sem a marca UTF-8: UTF-8 válido continua UTF-8; o resto é a página 850 do Windows em português.
    const cp850 = Buffer.from([0x41, 0xc6, 0x87, 0xe4, 0x6f, 0x2e, 0x70, 0x6e, 0x67]); // "Aãçõo.png"
    const legacy = buildZip([
      { name: cp850, data: b, flags: 0 },
      { name: text('Ação.png'), data: b, flags: 0 },
      { name: text('Coração.png'), data: b },
    ]);
    expect(readZip(legacy, inflate).map((e) => e.name)).toEqual(['Aãçõo.png', 'Ação.png', 'Coração.png']);
  });

  it('readZip recusa ZIP criptografado, ZIP64, bomba de compressão e nomes perigosos', async () => {
    const img = png({ w: 100, h: 100 });

    // Com senha: o arquivo fica de fora e aparece na revisão; o resto do ZIP continua.
    const enc = buildZip([
      { name: 'secreta.png', data: img, flags: 0x0801 },
      { name: 'forte.png', data: img, flags: 0x0841 },
      { name: 'aes.png', data: img, method: 99, flags: 0x0801 },
      { name: 'livre.png', data: img },
    ]);
    const e = readZip(enc, inflate);
    expect(e.map((x) => x.name)).toEqual(['livre.png']);
    expect(e.skipped).toEqual([
      { name: 'secreta.png', reason: 'unsupported', message: 'protegida por senha' },
      { name: 'forte.png', reason: 'unsupported', message: 'protegida por senha' },
      { name: 'aes.png', reason: 'unsupported', message: 'protegida por senha' },
    ]);
    // Central diz que não tem senha e o local diz que tem: não confere.
    expect(zipReason(() => readZip(buildZip([{ name: 'x.png', data: img, local: { flags: 0x0801 } }]), inflate))).toBe('corrupt');

    // Compressão desconhecida (bzip2, LZMA, Deflate64): fica de fora.
    const methods = buildZip([12, 14, 9].map((m) => ({ name: `m${m}.png`, data: img, method: m })));
    const me = readZip(methods, inflate);
    expect(me).toHaveLength(0);
    expect(me.skipped.map((s) => s.message)).toEqual(['compressão não suportada', 'compressão não suportada', 'compressão não suportada']);

    // ZIP64: o fim do diretório em 64 bits recusa o arquivo inteiro; um arquivo ZIP64 isolado fica de fora.
    const forced = await yazlZip([{ name: 'a.png', data: img }], { forceZip64Format: true });
    expect(zipReason(() => readZip(forced, inflate))).toBe('unsupported');
    const perEntry = readZip(await yazlZip([{ name: 'grande.png', data: img, zip64: true }, { name: 'normal.png', data: img }]), inflate);
    expect(perEntry.map((x) => x.name)).toEqual(['normal.png']);
    expect(perEntry.skipped).toEqual([{ name: 'grande.png', reason: 'unsupported', message: 'formato ZIP64 não suportado' }]);
    for (const opts of [{ total: 0xffff }, { cdOffset: 0xffffffff }, { cdSize: 0xffffffff }, { zip64Locator: true }])
      expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], opts), inflate))).toBe('unsupported');
    for (const field of [{ size: 0xffffffff }, { compressedSize: 0xffffffff }, { offset: 0xffffffff }, { diskStart: 0xffff }]) {
      const z = readZip(buildZip([{ name: 'a.png', data: img, ...field }, { name: 'b.png', data: img }]), inflate);
      expect(z.map((x) => x.name)).toEqual(['b.png']);
      expect(z.skipped[0].reason).toBe('unsupported');
    }

    // Bomba: 20 MB de zeros viram ~20 KB. A proporção declarada passa de 200 e recusa o arquivo inteiro.
    const zeros = Buffer.alloc(20 * 1024 * 1024);
    const bomb = buildZip([{ name: 'bomba.png', data: zeros, method: 8 }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(zipReason(() => readZip(bomb, inflate, { maxEntryBytes: 64 * 1024 * 1024 }))).toBe('too-big');
    // Com o limite padrão de 8 MB por arquivo, o mesmo arquivo nem chega a ser lido.
    expect(readZip(bomb, inflate).skipped).toEqual([{ name: 'bomba.png', reason: 'too-big', message: 'maior que 8 MB' }]);
    // Bomba que mente o tamanho (declara 20.000 bytes): o inflador para logo depois de 20.000 bytes.
    const deflatedZeros = zlib.deflateRawSync(zeros);
    const liar = buildZip([{ name: 'mentira.png', method: 8, compressed: deflatedZeros, size: 20_000, crc: 0 }]);
    const liarEntry = readZip(liar, inflateRawStream)[0];
    const t = performance.now();
    expect(await readReason(liarEntry)).toBe('corrupt');
    expect(performance.now() - t).toBeLessThan(2000);
    expect(await readReason(readZip(liar, inflate)[0])).toBe('corrupt');
    // Declarando 1000 bytes, os ~20 KB comprimidos já passam do que um compressor real gera: nem é listado.
    expect(zipReason(() => readZip(buildZip([{ name: 'mentira.png', method: 8, compressed: deflatedZeros, size: 1000, crc: 0 }]), inflate))).toBe('corrupt');
    const stopped = await inflateRawStream(new Uint8Array(deflatedZeros), 1000).then(
      () => false,
      (err) => err instanceof ZipError,
    );
    expect(stopped).toBe(true); // booleano: uma falha aqui não tenta imprimir 20 MB
    // Total declarado acima do limite, ou mais arquivos do que o permitido: o arquivo inteiro sai.
    const four = buildZip(['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.png`, data: img })));
    expect(zipReason(() => readZip(four, inflate, { maxTotalBytes: img.length * 3 }))).toBe('too-big');
    expect(zipReason(() => readZip(four, inflate, { maxEntries: 3 }))).toBe('too-many');
    try {
      readZip(four, inflate, { maxEntries: 3 });
    } catch (err) {
      expect((err as Error).message).toBe('O arquivo passa dos limites de importação (3 imagens, 100 MB).');
    }
    const many = buildZip(Array.from({ length: 301 }, (_, i) => ({ name: `${i}.png`, data: Buffer.from([i & 0xff]) })));
    expect(zipReason(() => readZip(many, inflate))).toBe('too-many');
    try {
      readZip(many, inflate);
    } catch (err) {
      expect((err as Error).message).toBe('O arquivo passa dos limites de importação (300 imagens, 100 MB).');
    }
    // Pastas e lixo do macOS não contam no limite.
    const junkParts: Part[] = Array.from({ length: 300 }, (_, i) => ({ name: `p/${i}.png`, data: Buffer.from([1]) }));
    junkParts.push({ name: 'p/' }, { name: '__MACOSX/p/._0.png', data: Buffer.from([0]) }, { name: 'p/.DS_Store', data: Buffer.from([0]) });
    expect(readZip(buildZip(junkParts), inflate)).toHaveLength(300);

    // Nomes perigosos ficam de fora (e aparecem); pastas, __MACOSX, ocultos e Thumbs.db somem sem aviso.
    const long = `${'a'.repeat(509)}.png`; // 513 caracteres
    const names = [
      'boa.png',
      '../fora.png',
      'pasta/../../fora.png',
      '/absoluto.png',
      'C:/windows.png',
      'pasta\\barra.png',
      'nul\u0000.png',
      'tab\tulador.png',
      'foto\u202Egnp.exe',
      'nova\u0085linha.png',
      'c1\u009f.png',
      long,
      'duas//barras.png',
      './ponto.png',
      'pasta/',
      '__MACOSX/pasta/._boa.png',
      '.DS_Store',
      'pasta/.oculta.png',
      '.git/config',
      'Thumbs.db',
      'pasta/desktop.ini',
      'uau...png',
      long.slice(1), // 512 caracteres ainda é nome válido
      'boa.png',
      '',
    ];
    const n = readZip(buildZip(names.map((name) => ({ name, data: img }))), inflate);
    expect(n.map((x) => x.name)).toEqual(['boa.png', 'uau...png', long.slice(1)]);
    // Na revisão o nome chega limpo: controle e inversão de direção viram "�", nome longo ganha reticências no meio.
    const shown = ['../fora.png', 'pasta/../../fora.png', '/absoluto.png', 'C:/windows.png', 'pasta\\barra.png', 'nul�.png', 'tab�ulador.png', 'foto�gnp.exe', 'nova�linha.png', 'c1�.png'];
    expect(n.skipped).toEqual([
      ...shown.map((name) => ({ name, reason: 'name', message: 'nome de arquivo inválido' })),
      { name: `${'a'.repeat(50)}…${'a'.repeat(25)}.png`, reason: 'name', message: 'nome de arquivo inválido' },
      ...['duas//barras.png', './ponto.png'].map((name) => ({ name, reason: 'name', message: 'nome de arquivo inválido' })),
      { name: 'boa.png', reason: 'name', message: 'nome repetido no ZIP' },
      { name: '', reason: 'name', message: 'nome de arquivo inválido' },
    ]);
    // Nome de 65.535 bytes (o máximo do formato): custo fixo e no máximo 80 caracteres na tela.
    const huge = readZip(buildZip([{ name: 'b'.repeat(65_535), data: img }]), inflate).skipped[0].name;
    expect(Array.from(huge)).toHaveLength(80);
    expect(zipDisplayName('x\u200B\u200Ey.png')).toBe('xy.png'); // invisíveis saem
    expect(zipDisplayName('👨‍👩‍👧.png')).toBe('👨‍👩‍👧.png'); // o ZWJ dos emojis fica
  });

  it('readZip pula o ZIP64 que só aparece no cabeçalho local e não deixa limites quebrados desligarem a proteção', async () => {
    const img = png({ w: 100, h: 100 });
    // Como o Python com force_zip64: tamanhos 0xFFFFFFFF e extra 0x0001 no local, tamanhos normais no central.
    const zip64Extra = bytes(le16(0x0001), le16(16), le32(img.length), le32(0), le32(img.length), le32(0));
    const local64 = buildZip([
      { name: '1.png', data: img, local: { sizes: [0xffffffff, 0xffffffff], extra: zip64Extra } },
      { name: '2.png', data: img, method: 8, local: { extra: bytes(le16(0x5455), le16(5), [1, 0, 0, 0, 0], zip64Extra) } },
      { name: '3.png', data: img, method: 8, descriptor: true, local: { extra: zip64Extra } },
      { name: '4.png', data: img },
      { name: '5.png', data: img, local: { sizes: [img.length, 0xffffffff] } }, // marca ZIP64 sem o extra
      { name: '6.png', data: img, local: { sizes: [0xffffffff, img.length] } },
    ]);
    const z = readZip(local64, inflate);
    expect(z.map((e) => e.name)).toEqual(['4.png']);
    expect(z.skipped).toEqual(['1.png', '2.png', '3.png', '5.png', '6.png'].map((name) => ({ name, reason: 'unsupported', message: 'formato ZIP64 não suportado' })));
    expect(Buffer.from(await z[0].read()).equals(img)).toBe(true);
    // Sem ZIP64, o extra local diferente do central continua normal.
    expect(readZip(buildZip([{ name: 'a.png', data: img, local: { extra: bytes(le16(0x7875), le16(3), [1, 4, 0]) } }]), inflate)).toHaveLength(1);

    // undefined, NaN, Infinity, zero ou negativo nos limites valem o padrão: nenhuma comparação fica sempre falsa.
    const many = buildZip(Array.from({ length: 400 }, (_, i) => ({ name: `${i}.png`, data: Buffer.from([i & 0xff]) })));
    const bomb = buildZip([{ name: 'bomba.png', data: Buffer.alloc(4_000_000), method: 8 }]);
    for (const bad of [undefined, NaN, Infinity, 0, -1]) {
      expect(zipReason(() => readZip(many, inflate, { maxEntries: bad }))).toBe('too-many');
      expect(zipReason(() => readZip(bomb, inflate, { maxRatio: bad }))).toBe('too-big');
      expect(zipReason(() => readZip(bomb, inflate, { maxRatio: 1e6, maxTotalBytes: bad, maxEntryBytes: bad }))).toBe('ok');
      expect(zipReason(() => readZip(bomb, inflate, { maxRatio: 1e6, maxTotalBytes: 1000, maxEntryBytes: bad }))).toBe('too-big');
    }
    expect(readZip(bomb, inflate, { maxRatio: 1e6, maxEntryBytes: NaN }).skipped).toEqual([]); // 4 MB cabe nos 8 MB padrão
    expect(readZip(bomb, inflate, { maxRatio: 1e6, maxEntryBytes: 1024 * 1024 }).skipped[0]?.message).toBe('maior que 1 MB');
  });

  it('readZip limita o tamanho comprimido ao que um compressor de verdade gera', async () => {
    // 400.000 blocos "stored" vazios (5 bytes cada, nenhuma saída) e depois "abc": deflate válido, 2 MB para 3 bytes.
    const empties = Buffer.concat([Buffer.alloc(400_000 * 5).map((_, i) => [0, 0, 0, 0xff, 0xff][i % 5]), zlib.deflateRawSync(text('abc'))]);
    expect(zlib.inflateRawSync(empties).toString()).toBe('abc');
    const padded = buildZip([{ name: 'e.png', data: text('abc'), method: 8, compressed: empties }]);
    expect(padded.length).toBeGreaterThan(2_000_000);
    expect(zipReason(() => readZip(padded, inflate))).toBe('corrupt');
    // Dados que não comprimem (PNG e WebP já comprimidos): o zlib grava blocos "stored" e fica dentro do teto,
    // mesmo forçando códigos fixos. Também o arquivo vazio comprimido.
    const noisy = randomBytes(300_000, 8);
    for (const deflated of [zlib.deflateRawSync(noisy, { level: 9 }), zlib.deflateRawSync(noisy, { strategy: zlib.constants.Z_FIXED })]) {
      expect(deflated.length).toBeGreaterThan(noisy.length);
      const z = readZip(buildZip([{ name: 'n.png', data: noisy, method: 8, compressed: deflated }]), inflate);
      expect(Buffer.from(await z[0].read()).equals(noisy)).toBe(true);
    }
    const empty = readZip(buildZip([{ name: 'v.png', data: Buffer.alloc(0), method: 8 }]), inflate);
    expect((await empty[0].read()).length).toBe(0);
  });

  it('readZip confere o cabeçalho local contra o diretório central', () => {
    const img = png({ w: 100, h: 100 });
    const corrupt = (p: Part, o?: ZipOpts) => zipReason(() => readZip(buildZip([p, { name: 'ok.png', data: img }], o), inflate));
    expect(corrupt({ name: 'a.png', data: img, local: { sig: 0x04034b51 } })).toBe('corrupt');
    expect(corrupt({ name: 'a.png', data: img, local: { name: 'b.png' } })).toBe('corrupt');
    expect(corrupt({ name: 'a.png', data: img, local: { method: 8 } })).toBe('corrupt');
    expect(corrupt({ name: 'a.png', data: img, local: { crc: 99 } })).toBe('corrupt');
    expect(corrupt({ name: 'a.png', data: img, local: { sizes: [img.length - 1, img.length] } })).toBe('corrupt');
    expect(corrupt({ name: 'a.png', data: img, size: img.length + 5 })).toBe('corrupt'); // guardado com tamanhos diferentes
    expect(corrupt({ name: 'a.png', data: img, compressedSize: 5_000_000, size: 5_000_000 })).toBe('corrupt'); // dados além do diretório
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img, compressedSize: img.length + 40, size: img.length + 40 }]), inflate))).toBe('corrupt');
    // Cabeçalho local apontando para dentro do diretório central ou para fora do arquivo.
    expect(corrupt({ name: 'a.png', data: img, offset: 5_000_000 })).toBe('corrupt');
    // Mesmo com descritor, método e nome precisam conferir.
    expect(corrupt({ name: 'a.png', data: img, method: 8, descriptor: true, local: { method: 0 } })).toBe('corrupt');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img, descriptor: true, local: { crc: 77, sizes: [1, 2] } }]), inflate))).toBe('ok');

    // Entradas sobrepostas (o truque das bombas que reaproveitam os mesmos bytes).
    const inner = bytes(le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(refCrc(img)), le32(img.length), le32(img.length), le16(5), le16(0), 'b.png', img);
    const outer = Buffer.concat([Buffer.alloc(10), inner, Buffer.alloc(20)]);
    const overlap = buildZip([
      { name: 'a.png', data: outer },
      { name: 'b.png', data: img, noLocal: true, offset: 30 + 5 + 10 },
    ]);
    expect(zipReason(() => readZip(overlap, inflate))).toBe('corrupt');
    // Dois registros centrais com o mesmo cabeçalho local: nomes diferentes não conferem, iguais são repetidos.
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }, { name: 'b.png', data: img, noLocal: true, offset: 0 }]), inflate))).toBe('corrupt');
  });

  it('readZip recusa o que não é ZIP ou tem a estrutura quebrada', () => {
    const img = png({ w: 100, h: 100 });
    const good = buildZip([{ name: 'a.png', data: img }, { name: 'b.png', data: img, method: 8 }]);
    expect(zipReason(() => readZip(good, inflate))).toBe('ok');
    expect(zipReason(() => readZip(img, inflate))).toBe('format');
    expect(zipReason(() => readZip(new Uint8Array(), inflate))).toBe('format');
    expect(zipReason(() => readZip(text('PK\x05\x06 quase'), inflate))).toBe('format');
    expect(zipReason(() => readZip(good.subarray(0, good.length - 1), inflate))).toBe('format');
    // Bytes depois do fim (ou comentário com tamanho errado): o fim não fecha com o arquivo.
    expect(zipReason(() => readZip(Buffer.concat([good, Buffer.from([0])]), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { comment: text('oi'), commentLen: 5 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { comment: text('comentário') }), inflate))).toBe('ok');
    // Contagem, tamanho ou posição do diretório central errados; ZIP dividido em partes.
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { total: 2 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }, { name: 'b.png', data: img }], { total: 1 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { cdSize: 10 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { cdOffset: 3 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { cdOffset: 4_000_000 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { disk: 1 }), inflate))).toBe('format');
    expect(zipReason(() => readZip(buildZip([{ name: 'a.png', data: img }], { total: 65_000 }), inflate))).toBe('format');
  });

  it('ZIP truncado ou alterado nunca derruba o leitor', async () => {
    const files: YazlFile[] = [
      { name: 'pack.json', data: text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'X', stickers: [] })) },
      { name: 'a.webp', data: webp({ kind: 'vp8l', w: 200, h: 200, dataBytes: 300 }), compress: false },
      { name: 'b.png', data: png({ w: 40, h: 40, noise: true, seed: 9 }), stream: true },
    ];
    const z = await yazlZip(files);
    const outcome = async (b: Uint8Array) => {
      let entries;
      try {
        entries = readZip(b, inflate);
      } catch (e) {
        if (e instanceof ZipError) return;
        throw e;
      }
      for (const entry of entries) await readReason(entry);
      await readStickerPack(entries);
    };
    const t = performance.now();
    for (let len = 0; len < z.length; len++) await outcome(z.subarray(0, len));
    const r = rng(2026);
    for (let i = 0; i < 2000; i++) {
      const b = Buffer.from(z);
      const flips = 1 + Math.floor(r() * 3);
      for (let k = 0; k < flips; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      await outcome(b);
    }
    expect(performance.now() - t).toBeLessThan(15_000);
  });
});

describe('zipRead: pacotes', () => {
  it('importa pack.json e .wastickers', async () => {
    const still = webp({ kind: 'vp8l', w: 512, h: 512, alpha: true, seed: 2 });
    const anim = webp({ kind: 'vp8x', w: 512, h: 512, frames: 3, seed: 4 });
    const poster = png({ w: 512, h: 512, alpha: true });
    const manifest = {
      format: 'wescc-stickers',
      version: 1,
      name: '  Atendimento\u200E ',
      description: 'Figurinhas oficiais',
      exportedAt: '2026-10-22T12:00:00.000Z',
      stickers: [
        { file: '001-bom-dia.webp', poster: null, name: 'Bom dia', emojis: ['☀️'], keywords: ['manhã'], animated: false },
        { file: '002-uau.webp', poster: '002-uau.poster.png', name: 'Uau', emojis: ['😮', ':joy:', 'x'], keywords: 'uau, #top', animated: true },
        { file: '003-sumiu.webp', poster: null, name: 'Sumiu', emojis: [], keywords: [] },
        { file: '001-bom-dia.webp', name: 'De novo' },
        { file: '../../etc/passwd', name: 'Ataque' },
        null,
        'texto',
      ],
    };
    const ours = await yazlZip([
      { name: 'Atendimento/pack.json', data: text(JSON.stringify(manifest)) },
      { name: 'Atendimento/001-bom-dia.webp', data: still, compress: false },
      { name: 'Atendimento/002-uau.webp', data: anim, compress: false },
      { name: 'Atendimento/002-uau.poster.png', data: poster, compress: false },
      { name: 'Atendimento/extra_foto.png', data: poster },
      { name: 'Atendimento/leia-me.txt', data: text('oi') },
    ]);
    const p = await readStickerPack(readZip(ours, inflate), { fileName: 'figurinhas-atendimento.zip' });
    expect(p.kind).toBe('wescc');
    expect(p.name).toBe('Atendimento');
    expect(p.description).toBe('Figurinhas oficiais');
    expect(p.items.map((i) => [i.entry.name, i.name, i.emojis, i.keywords, i.poster?.name ?? null])).toEqual([
      ['Atendimento/001-bom-dia.webp', 'Bom dia', ['☀️'], ['manhã'], null],
      ['Atendimento/002-uau.webp', 'Uau', ['😮'], ['uau', 'top'], 'Atendimento/002-uau.poster.png'],
      ['Atendimento/extra_foto.png', 'Extra foto', [], [], null],
    ]);
    expect(p.ignored).toEqual([
      { name: '003-sumiu.webp', reason: 'arquivo não encontrado no ZIP' },
      { name: '001-bom-dia.webp', reason: 'repetida no pack.json' },
      { name: '../../etc/passwd', reason: 'arquivo não encontrado no ZIP' },
      { name: 'Atendimento/leia-me.txt', reason: 'formato não suportado' },
    ]);
    expect(Buffer.from(await p.items[1].entry.read()).equals(anim)).toBe(true);

    // .wastickers: nome em title.txt; author.txt, tray*.png e o PNG 96 × 96 ficam de fora sem aviso.
    const tray = png({ w: 96, h: 96, alpha: true });
    const wa = await yazlZip([
      { name: 'title.txt', data: text('\uFEFF\r\n Meu pacote \r\nsegunda linha') },
      { name: 'author.txt', data: text('Fulano') },
      { name: 'tray.png', data: png({ w: 512, h: 512 }) },
      { name: 'icone.png', data: tray },
      { name: '10.webp', data: still },
      { name: '2.webp', data: anim },
      { name: 'animada.tgs', data: text('{"lottie":true}') },
      { name: 'video.webm', data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
    ]);
    const w = await readStickerPack(readZip(wa, inflate), { fileName: 'pacote.wastickers' });
    expect(w.kind).toBe('wastickers');
    expect(w.name).toBe('Meu pacote');
    expect(w.items.map((i) => [i.entry.name, i.name])).toEqual([
      ['2.webp', '2'],
      ['10.webp', '10'],
    ]);
    expect(w.ignored).toEqual([
      { name: 'animada.tgs', reason: 'formato não suportado' },
      { name: 'video.webm', reason: 'formato não suportado' },
    ]);
    // Renomeado para .zip continua .wastickers pelo title.txt e pelo author.txt.
    expect((await readStickerPack(readZip(wa, inflate), { fileName: 'pacote.zip' })).kind).toBe('wastickers');

    // ZIP comum de imagens: 96 × 96 é uma figurinha válida e fica; ignorados do ZIP aparecem na revisão.
    const loose = buildZip([
      { name: 'fotos/Bom-dia_final.PNG', data: tray },
      { name: 'fotos/Ação.gif', data: poster, method: 8 },
      { name: 'fotos/secreta.png', data: tray, flags: 0x0801 },
    ]);
    const z = await readStickerPack(readZip(loose, inflate), { fileName: 'fotos.zip' });
    expect(z.kind).toBe('zip');
    expect(z.name).toBeNull();
    expect(z.description).toBe('');
    expect(z.items.map((i) => i.name)).toEqual(['Ação', 'Bom dia final']);
    expect(z.ignored).toEqual([{ name: 'fotos/secreta.png', reason: 'protegida por senha' }]);

    // pack.json de outro formato não vale e é avisado.
    const other = await yazlZip([
      { name: 'pack.json', data: text(JSON.stringify({ format: 'outro', stickers: [] })) },
      { name: 'a.png', data: tray },
    ]);
    const o = await readStickerPack(readZip(other, inflate));
    expect(o.kind).toBe('zip');
    expect(o.items.map((i) => i.name)).toEqual(['A']);
    expect(o.ignored).toEqual([{ name: 'pack.json', reason: 'pack.json inválido' }]);
    const broken = await yazlZip([{ name: 'pack.json', data: text('{ "format": "wescc-stickers", ') }]);
    expect((await readStickerPack(readZip(broken, inflate))).ignored).toEqual([{ name: 'pack.json', reason: 'pack.json inválido' }]);
  });

  it('readStickerPack confere o pack.json: formato, pôsteres, arquivos pulados e campos hostis', async () => {
    const still = webp({ kind: 'vp8l', w: 200, h: 200, dataBytes: 100 });
    const img = png({ w: 100, h: 100 });
    const pack = (stickers: unknown[]) => text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'P', stickers }));

    // Arquivo listado no pack.json passa pelo mesmo filtro de extensão dos soltos.
    const formats = await readStickerPack(
      readZip(
        buildZip([
          { name: 'pack.json', data: pack([{ file: 'anim.tgs', name: 'Animada' }, { file: 'leia-me.txt', name: 'Leia' }, { file: 'boa.webp', poster: 'leia-me.txt' }]) },
          { name: 'anim.tgs', data: text('{"v":"5.7"}') },
          { name: 'leia-me.txt', data: text('oi') },
          { name: 'boa.webp', data: still },
        ]),
        inflate,
      ),
    );
    expect(formats.items.map((i) => [i.entry.name, i.poster?.name ?? null])).toEqual([['boa.webp', null]]);
    expect(formats.ignored).toEqual([
      { name: 'anim.tgs', reason: 'formato não suportado' },
      { name: 'leia-me.txt', reason: 'formato não suportado' },
    ]);

    // Pôster não toma a figurinha de outro item, nem é metadado ou arquivo que não é imagem.
    const posters = await readStickerPack(
      readZip(
        buildZip([
          { name: 'pack.json', data: pack([{ file: 'b.webp', poster: 'a.webp', name: 'B' }, { file: 'a.webp', name: 'A' }, { file: 'c.webp', poster: 'pack.json', name: 'C' }, { file: 'd.webp', poster: 'd.poster.png' }, { file: 'e.webp', poster: 'd.poster.png' }, { file: 'f.webp', poster: 'notas.txt' }]) },
          ...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ name: `${n}.webp`, data: still })),
          { name: 'd.poster.png', data: img },
          { name: 'notas.txt', data: text('oi') },
        ]),
        inflate,
      ),
    );
    expect(posters.items.map((i) => [i.entry.name, i.name, i.poster?.name ?? null])).toEqual([
      ['b.webp', 'B', null],
      ['a.webp', 'A', null],
      ['c.webp', 'C', null],
      ['d.webp', 'D', 'd.poster.png'],
      ['e.webp', 'E', null],
      ['f.webp', 'F', null],
    ]);
    expect(posters.ignored).toEqual([{ name: 'notas.txt', reason: 'formato não suportado' }]);

    // Arquivo que o readZip pulou (senha, grande demais) aparece uma vez só, com o motivo de verdade.
    const skippedZip = buildZip([
      { name: 'Pacote/pack.json', data: pack([{ file: 'secreta.png', name: 'Secreta' }, { file: 'grande.webp' }, { file: 'ok.webp' }, { file: 'sumiu.webp' }]) },
      { name: 'Pacote/secreta.png', data: img, flags: 0x0801 },
      { name: 'Pacote/grande.webp', data: Buffer.alloc(9 * 1024 * 1024, 1) },
      { name: 'Pacote/ok.webp', data: still },
    ]);
    const skipped = await readStickerPack(readZip(skippedZip, inflate));
    expect(skipped.items.map((i) => i.entry.name)).toEqual(['Pacote/ok.webp']);
    expect(skipped.ignored).toEqual([
      { name: 'Pacote/secreta.png', reason: 'protegida por senha' },
      { name: 'Pacote/grande.webp', reason: 'maior que 8 MB' },
      { name: 'sumiu.webp', reason: 'arquivo não encontrado no ZIP' },
    ]);
    // Um ZipEntry[] comum (filter e spread perdem .skipped) também serve.
    const listed = readZip(skippedZip, inflate);
    const plain = await readStickerPack(listed.filter(() => true));
    expect(plain.items.map((i) => i.entry.name)).toEqual(['Pacote/ok.webp']);
    expect(plain.ignored.map((i) => i.reason)).toEqual(['arquivo não encontrado no ZIP', 'arquivo não encontrado no ZIP', 'arquivo não encontrado no ZIP']);

    // Campos enormes não prendem a aba e nomes perigosos chegam limpos na revisão.
    const heavy = text(
      JSON.stringify({
        format: 'wescc-stickers',
        version: 1,
        name: 'n'.repeat(100_000),
        stickers: [
          { file: 'a.png', name: 'x'.repeat(100_000), emojis: ['😀', 'a'.repeat(300_000)], keywords: ','.repeat(300_000) },
          { file: 'b.png', emojis: 'a'.repeat(100_000), keywords: Array.from({ length: 5000 }, () => '#top') },
          { file: `x\u202E${'z'.repeat(5000)}` },
        ],
      }),
    );
    expect(heavy.length).toBeLessThan(1024 * 1024);
    const hostile = buildZip([
      { name: 'pack.json', data: heavy },
      { name: 'a.png', data: img },
      { name: 'b.png', data: img },
    ]);
    const t = performance.now();
    const h = await readStickerPack(readZip(hostile, inflate));
    expect(performance.now() - t).toBeLessThan(100); // antes: 300 a 900 ms
    expect(h.name).toBe('n'.repeat(40));
    expect(h.items.map((i) => [i.name.length, i.emojis, i.keywords])).toEqual([
      [40, ['😀'], []],
      [1, [], ['top']],
    ]);
    expect(h.ignored).toHaveLength(1);
    expect(Array.from(h.ignored[0].name).length).toBeLessThanOrEqual(80);
    expect(h.ignored[0].name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    const badNames = readZip(buildZip([{ name: 'foto\u202Egnp.exe', data: img }, { name: 'c'.repeat(65_535), data: img }]), inflate);
    const shown = await readStickerPack(badNames);
    expect(shown.ignored.map((i) => i.name)).toEqual(['foto�gnp.exe', `${'c'.repeat(50)}…${'c'.repeat(29)}`]);
  });

  it('readStickerPack: .wastickers pelo nome do arquivo e tetos de pack.json, title.txt e ícone de bandeja', async () => {
    const still = webp({ kind: 'vp8l', w: 512, h: 512, seed: 6 });
    const tray = png({ w: 96, h: 96, alpha: true });
    const plainZip = buildZip([
      { name: '1.webp', data: still },
      { name: 'icone.png', data: tray },
    ]);
    // Sem title.txt nem author.txt: só a extensão diz que é .wastickers, e o PNG 96 × 96 é o ícone.
    const byName = await readStickerPack(readZip(plainZip, inflate), { fileName: 'Pacote.WASTICKERS' });
    expect([byName.kind, byName.items.map((i) => i.entry.name)]).toEqual(['wastickers', ['1.webp']]);
    const asZip = await readStickerPack(readZip(plainZip, inflate), { fileName: 'pacote.zip' });
    expect([asZip.kind, asZip.items.map((i) => i.entry.name)]).toEqual(['zip', ['1.webp', 'icone.png']]);
    // Ícone acima de 1 MB nem é lido: fica como figurinha (a revisão mostra se passa dos limites).
    const bigTray = png({ w: 96, h: 96, alpha: true, text: 'x'.repeat(1024 * 1024) });
    const big = await readStickerPack(readZip(buildZip([{ name: '1.webp', data: still }, { name: 'icone.png', data: bigTray }]), inflate), { fileName: 'p.wastickers' });
    expect(big.items.map((i) => i.entry.name)).toEqual(['1.webp', 'icone.png']);

    // pack.json acima de 1 MB não é lido; title.txt acima de 1 MB também não.
    const padded = text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'Grande', stickers: [{ file: '1.webp', name: 'Um' }] }) + ' '.repeat(1024 * 1024));
    const tooBig = await readStickerPack(readZip(buildZip([{ name: 'pack.json', data: padded }, { name: '1.webp', data: still }]), inflate));
    expect([tooBig.kind, tooBig.name, tooBig.items.map((i) => i.name)]).toEqual(['zip', null, ['1']]);
    expect(tooBig.ignored).toEqual([{ name: 'pack.json', reason: 'pack.json inválido' }]);
    const longTitle = await readStickerPack(readZip(buildZip([{ name: 'title.txt', data: text(`Nome\n${' '.repeat(1024 * 1024)}`) }, { name: '1.webp', data: still }]), inflate));
    expect([longTitle.kind, longTitle.name]).toEqual(['wastickers', null]);

    // Só os primeiros 1000 itens do pack.json valem: o 1001º vira figurinha solta, com o nome do arquivo.
    const bogus = Array.from({ length: 1000 }, (_, i) => ({ file: `falta-${i}.webp` }));
    const capped = await readStickerPack(readZip(buildZip([{ name: 'pack.json', data: text(JSON.stringify({ format: 'wescc-stickers', version: 1, stickers: [...bogus, { file: 'ultima.webp', name: 'Nome do pacote' }] })) }, { name: 'ultima.webp', data: still }]), inflate));
    expect(capped.items.map((i) => i.name)).toEqual(['Ultima']);
    expect(capped.ignored).toHaveLength(1000);
  });

  it('exportação com pôsteres reimporta: metadados e pôsteres não contam nas 300 imagens', async () => {
    // Como zipStore grava: pack.json, depois NNN-nome.webp e, das animadas, NNN-nome.poster.png.
    const exported = (n: number, animated: (i: number) => boolean) => {
      const id = (i: number) => String(i + 1).padStart(3, '0');
      const stickers = Array.from({ length: n }, (_, i) => ({ file: `${id(i)}-f.webp`, poster: animated(i) ? `${id(i)}-f.poster.png` : null, name: `F ${i + 1}`, emojis: ['😀'], keywords: [] }));
      const parts: Part[] = [{ name: 'pack.json', data: text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'Exportado', description: '', stickers })) }];
      for (let i = 0; i < n; i++) {
        parts.push({ name: `${id(i)}-f.webp`, data: Buffer.from([i & 0xff, 1]) });
        if (animated(i)) parts.push({ name: `${id(i)}-f.poster.png`, data: Buffer.from([i & 0xff, 2]) });
      }
      return buildZip(parts);
    };
    const all = readZip(exported(150, () => true), inflate); // 301 arquivos
    expect(all).toHaveLength(301);
    const p = await readStickerPack(all, { fileName: 'figurinhas-exportado.zip' });
    expect([p.kind, p.items.length, p.items.every((i) => i.poster?.name === i.entry.name.replace('.webp', '.poster.png')), p.ignored]).toEqual(['wescc', 150, true, []]);
    expect(readZip(exported(300, (i) => i % 2 === 0), inflate)).toHaveLength(451);
    expect(readZip(exported(300, () => true), inflate)).toHaveLength(601);
    expect(zipReason(() => readZip(exported(301, () => false), inflate))).toBe('too-many');
    expect(zipReason(() => readZip(exported(301, () => true), inflate))).toBe('too-many');
    // Pôster sem a figurinha ao lado conta como imagem, e cada figurinha libera um pôster só.
    const orphans: Part[] = Array.from({ length: 301 }, (_, i) => ({ name: `${i}.poster.png`, data: Buffer.from([1]) }));
    expect(zipReason(() => readZip(buildZip(orphans), inflate))).toBe('too-many');
    const doubled: Part[] = Array.from({ length: 160 }, (_, i) => [
      { name: `${i}.webp`, data: Buffer.from([1]) },
      { name: `${i}.poster.png`, data: Buffer.from([2]) },
      { name: `${i}.poster.webp`, data: Buffer.from([3]) },
    ]).flat();
    expect(zipReason(() => readZip(buildZip(doubled), inflate))).toBe('too-many');
    // Só um de cada metadado é de graça: 300 imagens e 3 metadados passam; um pack.json numa segunda pasta conta.
    const meta = (extra: string[]) =>
      buildZip([...Array.from({ length: 300 }, (_, i) => ({ name: `p/${i}.png`, data: Buffer.from([1]) })), ...extra.map((name) => ({ name, data: text('{}') }))]);
    expect(readZip(meta(['p/pack.json', 'p/title.txt', 'p/author.txt']), inflate)).toHaveLength(303);
    expect(zipReason(() => readZip(meta(['p/pack.json', 'pack.json']), inflate))).toBe('too-many');
    expect(zipReason(() => readZip(meta(['p/q/pack.json']), inflate))).toBe('too-many');
  });

  it('readStickerPack conta nas 300 imagens o pôster que o pack.json não usa: ele entra como figurinha', async () => {
    const packError = async (entries: Parameters<typeof readStickerPack>[0]) => {
      try {
        await readStickerPack(entries);
      } catch (e) {
        if (e instanceof ZipError) return `${e.reason}: ${e.message}`;
        throw e;
      }
      return 'ok';
    };
    const tooMany = (n: number) => `too-many: O arquivo passa dos limites de importação (${n} imagens, 100 MB).`;
    const loose = (n: number, names: (i: number) => string[]) =>
      buildZip(Array.from({ length: n }, (_, i) => names(i).map((name, k) => ({ name, data: Buffer.from([i & 0xff, k]) }))).flat());

    // Sem pack.json, readZip lista 600 arquivos (os pôsteres ao lado não contam), mas os 600 viram figurinhas.
    const pairs = readZip(loose(300, (i) => [`s${i}.png`, `s${i}.poster.png`]), inflate);
    expect(pairs).toHaveLength(600);
    expect(await packError(pairs)).toBe(tooMany(300));
    const half = await readStickerPack(readZip(loose(150, (i) => [`s${i}.png`, `s${i}.poster.png`]), inflate));
    expect([half.kind, half.items.length, half.items.some((i) => i.poster)]).toEqual(['zip', 300, false]);

    // Pôster de pôster: readZip deixa 402 de 603 fora da conta, e os 603 viram figurinhas.
    const chain = readZip(loose(201, (i) => [`c${i}.png`, `c${i}.poster.png`, `c${i}.poster.poster.png`]), inflate);
    expect(chain).toHaveLength(603);
    expect(await packError(chain)).toBe(tooMany(300));

    // pack.json com 300 figurinhas sem pôster e 300 pôsteres sobrando ao lado.
    const stickers = Array.from({ length: 300 }, (_, i) => ({ file: `s${i}.png`, poster: null, name: `F ${i}` }));
    const pack = { name: 'pack.json', data: text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'P', stickers })) };
    const extra = readZip(buildZip([pack, ...Array.from({ length: 300 }, (_, i) => [`s${i}.png`, `s${i}.poster.png`]).flat().map((name) => ({ name, data: text(name) }))]), inflate);
    expect(extra).toHaveLength(601);
    expect(await packError(extra)).toBe(tooMany(300));
    // Os mesmos 601 arquivos, com o pack.json usando os pôsteres: 300 figurinhas, cada uma com o seu.
    const used = stickers.map((s, i) => ({ ...s, poster: `s${i}.poster.png` }));
    const withPosters = readZip(
      buildZip([
        { name: 'pack.json', data: text(JSON.stringify({ format: 'wescc-stickers', version: 1, name: 'P', stickers: used })) },
        ...Array.from({ length: 300 }, (_, i) => [`s${i}.png`, `s${i}.poster.png`]).flat().map((name) => ({ name, data: text(name) })),
      ]),
      inflate,
    );
    const ok = await readStickerPack(withPosters);
    expect([ok.kind, ok.items.length, ok.items.every((i) => i.poster?.name === i.entry.name.replace('.png', '.poster.png'))]).toEqual(['wescc', 300, true]);

    // O limite é o que readZip recebeu; uma lista comum usa o padrão.
    const ten = readZip(loose(10, (i) => [`s${i}.png`, `s${i}.poster.png`]), inflate, { maxEntries: 10 });
    expect(ten).toHaveLength(20);
    expect(await packError(ten)).toBe(tooMany(10));
    expect((await readStickerPack(readZip(loose(5, (i) => [`s${i}.png`, `s${i}.poster.png`]), inflate, { maxEntries: 10 }))).items).toHaveLength(10);
    const plain = (n: number): ZipEntry[] =>
      Array.from({ length: n }, (_, i) => ({ name: `${i}.png`, size: 1, compressedSize: 1, method: 0, read: async () => new Uint8Array(1) }));
    expect(await packError(plain(301))).toBe(tooMany(300));
    expect((await readStickerPack(plain(300))).items).toHaveLength(300);
  });
});
