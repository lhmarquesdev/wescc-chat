// Figurinhas: passos 2 a 5 da prévia do editor (máscara, contorno, margens e o encaixe em 512) num Worker de módulo,
// longe da thread da página. Sem Worker, maskWorker() (stickerImage.ts) chama o mesmo createRenderer na thread principal.
import { alphaBounds, applyMask, createMaskReplay, cropRaster, fitSize, outlineMask, padRaster, padRect, resizeArea, type MaskOp, type Raster } from '@shared/stickerEdit';
import { STICKER_LIMITS } from '@shared/stickers';

// Origem -> área de trabalho, como DOMMatrix 2D: x' = a·x + c·y + e, y' = b·x + d·y + f.
export type Affine = [number, number, number, number, number, number];

export interface RenderInput {
  raster: Raster; // área de trabalho: recorte já girado, espelhado e reduzido (lado maior ≤ 1024)
  ops: MaskOp[];
  outlinePx: number; // espessura do contorno em px da figurinha final; 0 = sem contorno
  trim: boolean;
  affine: Affine;
  scale: number; // px de trabalho por px de origem (raio do pincel)
  stage?: { raster: Raster; affine: Affine }; // imagem inteira do palco (origem -> palco), só quando há recorte
  stageOnly?: boolean; // gesto em andamento (traço, tolerância): só o palco; a figurinha sai quando o gesto termina
}

export interface RenderOutput {
  stage: Raster; // o palco: imagem com a máscara, sem contorno
  output: Raster | null; // a figurinha já no tamanho final (lado maior ≤ 512); null quando não há o que salvar
  error?: string; // por que não há figurinha: recorte pequeno demais (fitSize)
}

const toWork =
  (m: Affine) =>
  (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// p depois de q, e a inversa (giros de 90°, espelho e escala: sempre invertível).
const after = (p: Affine, q: Affine): Affine => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
function inverse(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

// O palco com recorte mostra, dentro do recorte, a máscara da própria figurinha (a do recorte) e, fora dele, a
// imagem sem máscara. O "fundo liso" e o "Apagar área" dependem da borda e das ligações dentro do raster: refeitos
// na imagem inteira, apagariam outra coisa que a figurinha salva. toCut leva um pixel do palco à área de trabalho.
export function stageView(stage: Raster, cut: Raster, toCut: Affine): Raster {
  const W = stage.width;
  const H = stage.height;
  const out = stage.data.slice();
  const back = inverse(toCut);
  // Só o retângulo do palco que cai no recorte (giros de 90° mantêm os eixos).
  const [ax, ay] = toWork(back)(0, 0);
  const [bx, by] = toWork(back)(cut.width, cut.height);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
  const x1 = Math.min(W, Math.ceil(Math.max(ax, bx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const y1 = Math.min(H, Math.ceil(Math.max(ay, by)));
  const [a, b, c, d, e, f] = toCut;
  const cw = cut.width;
  const ch = cut.height;
  const cd = cut.data;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      const u = Math.floor(a * px + c * py + e);
      const v = Math.floor(b * px + d * py + f);
      if (u < 0 || v < 0 || u >= cw || v >= ch) continue;
      out[(y * W + x) * 4 + 3] = cd[(v * cw + u) * 4 + 3];
    }
  }
  return { width: W, height: H, data: out };
}

// Raio do contorno em px de trabalho para que a faixa saia com px na figurinha final. O encaixe em 512 (ou o
// dobro das pequenas) mede o raster depois do contorno e das margens, e esse tamanho depende do próprio raio:
// algumas voltas só de geometria convergem (o raio pesa pouco no tamanho).
export function outlineRadius(cut: Raster, px: number, trim: boolean): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  const box = trim ? alphaBounds(cut) : { x: 0, y: 0, width: cut.width, height: cut.height };
  if (!box) return 0;
  let r = px;
  for (let i = 0; i < 8; i++) {
    const pad = Math.ceil(r) + 1;
    const ow = cut.width + 2 * pad;
    const oh = cut.height + 2 * pad;
    let w = ow;
    let h = oh;
    if (trim) {
      const bw = Math.min(ow, box.width + 2 * r);
      const bh = Math.min(oh, box.height + 2 * r);
      const m = Math.round(0.04 * Math.max(bw, bh));
      w = Math.min(ow, bw + 2 * m);
      h = Math.min(oh, bh + 2 * m);
    }
    let k: number;
    try {
      const fit = fitSize(w, h);
      k = Math.max(fit.width, fit.height) / Math.max(w, h);
    } catch {
      return r; // pequena demais: o erro sai no encaixe de verdade
    }
    const next = Math.min(px / k, STICKER_LIMITS.maxSide / 2);
    if (Math.abs(next - r) < 0.01) return next;
    r = next;
  }
  return r;
}

// Só o que vem depois do último "Restaurar tudo" muda alguma coisa.
function hasMask(ops: readonly MaskOp[]): boolean {
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].kind === 'reset') return false;
    return true;
  }
  return false;
}

const copy = (r: Raster): Raster => ({ width: r.width, height: r.height, data: r.data.slice() });

// O mesmo que withOutline(r, radius) com o branco, byte a byte, mais barato: a distância só é calculada no retângulo dos
// pixels visíveis (fora dele não há silhueta a menos de radius + 1 px) e a mistura só onde ela muda algo, nos pixels
// não opacos que o contorno cobre. Num pixel opaco, ou sem contorno, a conta de withOutline devolve o próprio pixel.
export function outlineVisible(r: Raster, radius: number): Raster {
  const R = Number.isFinite(radius) ? Math.min(Math.max(radius, 0), STICKER_LIMITS.maxSide / 2) : 0;
  const pad = Math.ceil(R) + 1;
  const out = padRaster(r, pad);
  const box = alphaBounds(r, 1);
  if (!box) return out;
  const sub = padRaster(cropRaster(r, box), pad); // no mesmo lugar de out a partir de (box.x, box.y)
  const cover = outlineMask(sub, R);
  const d = out.data;
  for (let y = 0; y < sub.height; y++) {
    for (let x = 0, i = y * sub.width, o = ((box.y + y) * out.width + box.x) * 4; x < sub.width; x++, i++, o += 4) {
      const c = cover[i];
      if (!c || d[o + 3] === 255) continue;
      const a = d[o + 3] / 255;
      const b = (c / 255) * (1 - a);
      const outA = a + b;
      d[o] = (d[o] * a + 255 * b) / outA;
      d[o + 1] = (d[o + 1] * a + 255 * b) / outA;
      d[o + 2] = (d[o + 2] * a + 255 * b) / outA;
      d[o + 3] = Math.round(outA * 255);
    }
  }
  return out;
}

export function createRenderer(): (input: RenderInput) => RenderOutput {
  // A máscara roda só no recorte; o palco a reaproveita (stageView). O último recorte mascarado fica guardado: o fim
  // de um gesto (só o palco a cada passo) pede a figurinha com a mesma máscara.
  const replay = createMaskReplay();
  let last: { raster: Raster; sig: string; cut: Raster } | null = null;
  return (input) => {
    const sig = JSON.stringify([input.ops, input.affine, input.scale]);
    let cut: Raster;
    if (last && last.raster === input.raster && last.sig === sig) cut = last.cut;
    else {
      cut = hasMask(input.ops) ? applyMask(input.raster, replay(input.raster, input.ops, toWork(input.affine), input.scale), 1) : copy(input.raster);
      last = { raster: input.raster, sig, cut };
    }
    // O palco é sempre um buffer novo: o Worker o transfere, e o recorte guardado não pode ir junto.
    const stage = input.stage ? stageView(input.stage.raster, cut, after(input.affine, inverse(input.stage.affine))) : copy(cut);
    if (input.stageOnly) return { stage, output: null };
    const radius = outlineRadius(cut, input.outlinePx, input.trim);
    let out = radius > 0 ? outlineVisible(cut, radius) : cut;
    const bounds = alphaBounds(out);
    if (!bounds) return { stage, output: null };
    if (input.trim) out = cropRaster(out, padRect(bounds, Math.round(0.04 * Math.max(bounds.width, bounds.height)), out.width, out.height));
    let size: { width: number; height: number };
    try {
      size = fitSize(out.width, out.height);
    } catch (e) {
      return { stage, output: null, error: e instanceof Error ? e.message : String(e) };
    }
    const final = resizeArea(out, size.width, size.height); // sempre um buffer novo, nunca o do palco
    return { stage, output: final };
  };
}

// ---------- Decodificar ----------

// createImageBitmap reduzido a max no lado maior. A redução roda na thread que chama (no Chrome, numa imagem de 12 MP,
// centenas de ms), então o editor pede isto ao Worker. null quando nem dá para abrir a imagem.
export async function decodeAt(blob: Blob, w: number, h: number, max: number): Promise<ImageBitmap> {
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image', resizeQuality: 'high' };
  if (Math.max(w, h) > max) {
    if (w >= h) opts.resizeWidth = max;
    else opts.resizeHeight = max;
  }
  const bmp = await createImageBitmap(blob, opts);
  // O lado calculado sai arredondado para cima no ponto flutuante (3000 · 2048 / 4000 dá 1537): tira a linha a mais.
  const sw = opts.resizeWidth ? max : Math.round((w * max) / h);
  const sh = opts.resizeHeight ? max : Math.round((h * max) / w);
  if ((opts.resizeWidth || opts.resizeHeight) && bmp.width >= sw && bmp.height >= sh && bmp.width + bmp.height === sw + sh + 1) {
    const cut = await createImageBitmap(bmp, 0, 0, sw, sh);
    bmp.close();
    return cut;
  }
  if (Math.max(bmp.width, bmp.height) <= max) return bmp;
  // Navegador que ignora o resize (ou EXIF que trocou os lados): uma redução no canvas, uma vez.
  const k = max / Math.max(bmp.width, bmp.height);
  const width = Math.max(1, Math.round(bmp.width * k));
  const height = Math.max(1, Math.round(bmp.height * k));
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    bmp.close();
    throw new Error('canvas');
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return createImageBitmap(canvas);
}

// ---------- Protocolo do Worker ----------

// raster e stage.raster só vão quando mudam; o Worker guarda o último de cada.
export interface WorkerRequest {
  id: number;
  raster?: Raster;
  ops: MaskOp[];
  outlinePx: number;
  trim: boolean;
  affine: Affine;
  scale: number;
  stage: { raster?: Raster; affine: Affine } | null;
  stageOnly?: boolean;
}
// Decodificar fora da página: uma cópia por lado maior pedido (0 = não precisa); a primeira é obrigatória.
export interface DecodeRequest {
  id: number;
  decode: Blob;
  width: number; // do cabeçalho, antes do EXIF
  height: number;
  sides: number[];
}
export type WorkerReply = { id: number; result: RenderOutput } | { id: number; bitmaps: Array<ImageBitmap | null> } | { id: number; failure: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest | DecodeRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer: Transferable[]): void;
}

// Na thread principal este arquivo só fornece createRenderer.
if (typeof window === 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as WorkerScope;
  const render = createRenderer();
  let work: Raster | null = null;
  let stage: Raster | null = null;
  // Aquece o JIT enquanto a pessoa escolhe o arquivo: sem isso, a primeira prévia com fundo e contorno roda o código
  // ainda frio e demora o dobro. Um disco num fundo liso passa por todos os passos.
  setTimeout(() => {
    try {
      const W = 320;
      const H = 240;
      const r: Raster = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
      for (let y = 0, o = 0; y < H; y++) for (let x = 0; x < W; x++, o += 4) r.data.set(Math.hypot(x - 160, y - 120) < 80 ? [220, 60, 40, 255] : [235, 240, 250, 255], o);
      const warm = createRenderer();
      for (let i = 0; i < 3; i++)
        warm({
          raster: r,
          ops: [
            { kind: 'flat-bg', tolerance: 20 + i },
            {
              kind: 'brush',
              points: [
                [60, 60],
                [200, 150],
              ],
              radius: 12,
              erase: true,
            },
          ],
          outlinePx: 6,
          trim: true,
          affine: [1, 0, 0, 1, 0, 0],
          scale: 1,
          stage: i ? { raster: r, affine: [1, 0, 0, 1, 0, 0] } : undefined,
        });
    } catch {
      // só aquecimento
    }
  }, 0);
  scope.onmessage = (e) => {
    const m = e.data;
    if ('decode' in m) {
      const { decode: blob, width, height, sides } = m;
      void Promise.all(sides.map((side, i) => (side ? decodeAt(blob, width, height, side).catch((err) => (i ? null : Promise.reject(err))) : null))).then(
        (bitmaps) =>
          scope.postMessage(
            { id: m.id, bitmaps },
            bitmaps.filter((b): b is ImageBitmap => !!b),
          ),
        (err) => scope.postMessage({ id: m.id, failure: err instanceof Error ? err.message : String(err) }, []),
      );
      return;
    }
    try {
      if (m.raster) work = m.raster;
      if (m.stage?.raster) stage = m.stage.raster;
      if (!work) throw new Error('Imagem inválida para edição.');
      const res = render({
        raster: work,
        ops: m.ops,
        outlinePx: m.outlinePx,
        trim: m.trim,
        affine: m.affine,
        scale: m.scale,
        stage: m.stage && stage ? { raster: stage, affine: m.stage.affine } : undefined,
        stageOnly: m.stageOnly,
      });
      const transfer: Transferable[] = [res.stage.data.buffer];
      if (res.output) transfer.push(res.output.data.buffer);
      scope.postMessage({ id: m.id, result: res }, transfer);
    } catch (err) {
      scope.postMessage({ id: m.id, failure: err instanceof Error ? err.message : String(err) }, []);
    }
  };
}
