// Figurinhas no navegador: abrir a imagem, recortar com canvas, codificar e preparar a importação. As contas de pixel
// ficam em @shared/stickerEdit (testadas no servidor); aqui entra só o que precisa de canvas, Worker ou rede.
import { ProbeError, probeImage, sniffMime, type ImageProbe } from '@shared/imageProbe';
import { dhash, encodeSteps, fitSize, resizeArea, type Raster, type Rect } from '@shared/stickerEdit';
import { FILE_UPLOAD_SOURCE_RE, STICKER_LIMITS } from '@shared/stickers';
import { getCredentials } from './api';
import type { StickerCaps } from './stickers';
import { createRenderer, decodeAt, type Affine, type DecodeRequest, type RenderInput, type RenderOutput, type WorkerReply, type WorkerRequest } from './stickerWorker';

export type { Affine, RenderInput, RenderOutput } from './stickerWorker';

const MB = 1024 * 1024;
export const FORMAT_ERROR = 'Formato não suportado. Use PNG, JPEG, WebP ou GIF.';
export const TOO_BIG_ERROR = `A imagem é grande demais (máximo de ${STICKER_LIMITS.editorMaxInputMB} MB).`;
export const MEGAPIXEL_ERROR = `A imagem tem resolução alta demais (máximo de ${STICKER_LIMITS.editorMaxMegapixels} megapixels).`;
export const OPEN_ERROR = 'Não foi possível abrir a imagem. Tente de novo.';
export const encodeLimitError = (kb: number) => `Não foi possível deixar a figurinha abaixo de ${kb} KB. Recorte uma área menor.`;

// A imagem abre, mas passa de um limite (tamanho, resolução, quadros, KB). As outras falhas são arquivo com erro.
export class LimitError extends Error {}

export interface LoadedImage {
  kind: 'static' | 'animated';
  probe: ImageProbe;
  blob: Blob; // bytes originais, com o tipo do que foi lido (não o que a extensão diz)
  bitmap: ImageBitmap; // primeiro quadro, já na orientação do EXIF e com o lado maior ≤ 2048
  small: ImageBitmap | null; // a mesma imagem com o lado maior ≤ 1024, para o palco; null quando bitmap já cabe
  name: string;
}

export function closeImage(img: LoadedImage): void {
  img.bitmap.close();
  img.small?.close();
}

// ---------- Abrir ----------

// Lê os cabeçalhos antes de decodificar: SVG, HTML ou um PNG de 30.000 × 30.000 nunca chegam ao decodificador.
function probeBytes(bytes: Uint8Array): ImageProbe {
  if (!sniffMime(bytes)) throw new Error(FORMAT_ERROR);
  let probe: ImageProbe;
  try {
    // O arquivo inteiro: com só o começo, APNG e WebP animado parecem corrompidos. O teto de quadros vem depois.
    probe = probeImage(bytes, { maxFrames: 100_000 });
  } catch (e) {
    if (e instanceof ProbeError && e.reason === 'too-many-frames') throw new LimitError(e.message);
    throw new Error(e instanceof ProbeError && e.reason !== 'format' ? e.message : FORMAT_ERROR);
  }
  if (probe.width * probe.height > STICKER_LIMITS.editorMaxMegapixels * 1_000_000) throw new LimitError(MEGAPIXEL_ERROR);
  return probe;
}

const fitLong = (w: number, h: number, max: number) => {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
};

export async function decodeBitmap(blob: Blob, probe: Pick<ImageProbe, 'width' | 'height'>): Promise<ImageBitmap> {
  try {
    return await decodeAt(blob, probe.width, probe.height, STICKER_LIMITS.editorDecodeMaxSide);
  } catch {
    throw new Error(OPEN_ERROR);
  }
}

// ---------- Worker de reserva ----------

// O editor sobe o Worker ao abrir: o módulo carrega enquanto a pessoa escolhe o arquivo, a decodificação roda nele e a
// prévia o reaproveita (maskWorker).
let spare: Worker | null = null;
const pendingDecodes = new Set<(e: Error) => void>();
let decodeSeq = 0;

function newWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./stickerWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

export function warmMaskWorker(): void {
  spare ??= newWorker();
}

export function releaseMaskWorker(): void {
  spare?.terminate();
  spare = null;
  for (const fail of pendingDecodes) fail(new Error(OPEN_ERROR));
  pendingDecodes.clear();
}

// A imagem grande (≤ 2048) e a pequena do palco (≤ 1024, ou null) decodificadas no Worker; sem Worker, aqui mesmo.
async function decodeBoth(blob: Blob, probe: ImageProbe): Promise<[ImageBitmap, ImageBitmap | null]> {
  const long = Math.max(probe.width, probe.height);
  const smallSide = !probe.animated && long > STICKER_LIMITS.editorWorkMaxSide ? STICKER_LIMITS.editorWorkMaxSide : 0;
  const w = (spare ??= newWorker());
  if (w) {
    try {
      return await new Promise<[ImageBitmap, ImageBitmap | null]>((resolve, reject) => {
        const id = -++decodeSeq; // negativo: nunca é um pedido da prévia
        const done = () => {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          pendingDecodes.delete(reject);
        };
        const onMessage = (e: MessageEvent<WorkerReply>) => {
          if (e.data.id !== id) return;
          done();
          if ('bitmaps' in e.data && e.data.bitmaps[0]) resolve([e.data.bitmaps[0], e.data.bitmaps[1] ?? null]);
          else reject(new Error(OPEN_ERROR));
        };
        const onError = () => {
          done();
          if (spare === w) spare = null;
          w.terminate();
          reject(new Error(OPEN_ERROR));
        };
        pendingDecodes.add(reject);
        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        const req: DecodeRequest = { id, decode: blob, width: probe.width, height: probe.height, sides: [STICKER_LIMITS.editorDecodeMaxSide, smallSide] };
        w.postMessage(req);
      });
    } catch {
      // Worker sem createImageBitmap ou sem canvas: decodifica na página.
    }
  }
  const smallLoad = smallSide ? decodeAt(blob, probe.width, probe.height, smallSide).catch(() => null) : Promise.resolve(null);
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeBitmap(blob, probe);
  } catch (e) {
    void smallLoad.then((b) => b?.close());
    throw e;
  }
  return [bitmap, await smallLoad];
}

// A cópia pequena só vale com o mesmo formato da grande (o EXIF pode ter trocado os lados) e o lado maior ≤ 1024.
function sameShape(bitmap: ImageBitmap, small: ImageBitmap | null): ImageBitmap | null {
  if (!small) return null;
  const long = Math.max(small.width, small.height);
  const ok =
    long <= STICKER_LIMITS.editorWorkMaxSide &&
    long < Math.max(bitmap.width, bitmap.height) &&
    Math.abs(small.width / small.height - bitmap.width / bitmap.height) <= 2 / Math.min(small.width, small.height);
  if (ok) return small;
  small.close();
  return null;
}

export async function loadImageSource(src: File | Blob | { url: string; name?: string }): Promise<LoadedImage> {
  let blob: Blob;
  let name: string;
  if (src instanceof Blob) {
    blob = src;
    name = src instanceof File ? src.name : 'figurinha';
  } else {
    // Só um arquivo enviado nesta instalação, por caminho relativo.
    if (!FILE_UPLOAD_SOURCE_RE.test(src.url)) throw new Error(FORMAT_ERROR);
    const creds = getCredentials();
    let res: Response;
    try {
      res = await fetch(src.url, {
        credentials: 'same-origin',
        headers: creds ? { 'X-User-Id': creds.userId, 'X-Auth-Token': creds.authToken } : undefined,
      });
    } catch {
      throw new Error(OPEN_ERROR);
    }
    if (!res.ok) throw new Error(OPEN_ERROR);
    if (Number(res.headers.get('content-length')) > STICKER_LIMITS.editorMaxInputMB * MB) throw new Error(TOO_BIG_ERROR);
    blob = await res.blob();
    name = src.name ?? decodeURIComponent(src.url.split('?')[0].split('/').pop() ?? '');
  }
  if (blob.size > STICKER_LIMITS.editorMaxInputMB * MB) throw new Error(TOO_BIG_ERROR);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const probe = probeBytes(bytes);
  const typed = blob.type === probe.mime ? blob : new Blob([bytes], { type: probe.mime });
  // A pequena poupa o palco de reduzir a grande a cada mudança.
  const [bitmap, small] = await decodeBoth(typed, probe);
  return { kind: probe.animated ? 'animated' : 'static', probe, blob: typed, bitmap, small: sameShape(bitmap, small), name };
}

// ---------- Geometria: origem -> vista (girada e espelhada) -> área de trabalho ----------

export type Rotation = 0 | 90 | 180 | 270;

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

// p depois de q
export function multiply(p: Affine, q: Affine): Affine {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export const applyAffine = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Retângulo levado por giros de 90° e espelhos continua alinhado aos eixos.
export function mapRect(m: Affine, r: Rect): Rect {
  const [x1, y1] = applyAffine(m, r.x, r.y);
  const [x2, y2] = applyAffine(m, r.x + r.width, r.y + r.height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export const viewSize = (w: number, h: number, rotate: Rotation) => (rotate % 180 ? { width: h, height: w } : { width: w, height: h });

// Giro no sentido horário, depois espelho horizontal da vista.
export function viewAffine(w: number, h: number, rotate: Rotation, flip: boolean): Affine {
  const m: Affine = rotate === 90 ? [0, 1, -1, 0, h, 0] : rotate === 180 ? [-1, 0, 0, -1, w, h] : rotate === 270 ? [0, -1, 1, 0, 0, w] : IDENTITY;
  return flip ? multiply([-1, 0, 0, 1, viewSize(w, h, rotate).width, 0], m) : m;
}

export interface WorkGeometry {
  width: number;
  height: number;
  affine: Affine; // origem -> área de trabalho
  scale: number; // px de trabalho por px de origem
}

export function workGeometry(w: number, h: number, opts: { crop?: Rect; rotate?: Rotation; flip?: boolean }, maxSide: number): WorkGeometry {
  const crop = opts.crop ?? { x: 0, y: 0, width: w, height: h };
  const v = viewAffine(w, h, opts.rotate ?? 0, !!opts.flip);
  const vr = mapRect(v, crop);
  const size = fitLong(vr.width, vr.height, Math.max(1, maxSide));
  const sx = size.width / vr.width;
  const sy = size.height / vr.height;
  return { ...size, affine: multiply([sx, 0, 0, sy, -vr.x * sx, -vr.y * sy], v), scale: (sx + sy) / 2 };
}

// ---------- Canvas ----------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function canvas2d(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(OPEN_ERROR);
  return { canvas, ctx };
}

function drawRaster(b: CanvasImageSource, g: WorkGeometry, crop: Rect): Raster {
  const { ctx } = canvas2d(g.width, g.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...g.affine);
  ctx.drawImage(b, crop.x, crop.y, crop.width, crop.height, crop.x, crop.y, crop.width, crop.height);
  const img = ctx.getImageData(0, 0, g.width, g.height);
  return { width: g.width, height: g.height, data: img.data };
}

// Com small (a mesma imagem, menor) e sem recorte, desenha a partir dela quando ela tem pixels bastantes: a geometria
// continua a de b, então o pincel e o recorte não mudam.
export function bitmapToRaster(b: ImageBitmap, opts: { crop?: Rect; rotate?: Rotation; flip?: boolean; maxSide?: number } = {}, small?: ImageBitmap | null): Raster {
  const crop = opts.crop ?? { x: 0, y: 0, width: b.width, height: b.height };
  const g = workGeometry(b.width, b.height, opts, opts.maxSide ?? STICKER_LIMITS.editorWorkMaxSide);
  if (small && !opts.crop && Math.max(g.width, g.height) <= Math.max(small.width, small.height)) {
    const toFull: Affine = [b.width / small.width, 0, 0, b.height / small.height, 0, 0];
    return drawRaster(small, { ...g, affine: multiply(g.affine, toFull) }, { x: 0, y: 0, width: small.width, height: small.height });
  }
  return drawRaster(b, g, crop);
}

// Desenha o raster num <canvas> do tamanho dele (palco e prévias; o CSS ajusta o tamanho na tela).
export function paintRaster(canvas: HTMLCanvasElement, r: Raster): void {
  if (canvas.width !== r.width) canvas.width = r.width;
  if (canvas.height !== r.height) canvas.height = r.height;
  canvas.getContext('2d')?.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
}

// ---------- Codificar ----------

type EncodeMime = 'image/webp' | 'image/png';

// Mesma API nos dois lugares: o teste de WebP e a codificação de verdade.
async function encodeBlob(r: Raster, type: EncodeMime, quality?: number): Promise<Blob> {
  const { canvas, ctx } = canvas2d(r.width, r.height);
  ctx.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(encodeLimitError(0)))), type, quality));
}

let webpCheck: Promise<boolean> | null = null;

export function webpEncodeSupported(): Promise<boolean> {
  webpCheck ??= encodeBlob({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) }, 'image/webp', 0.8)
    .then((b) => b.type === 'image/webp')
    .catch(() => false);
  return webpCheck;
}

// Anda por encodeSteps até ficar abaixo do limite. blob.type é conferido a cada passo: o Safari devolve PNG quando
// recebe um pedido de WebP. sameSize fica só nos passos de escala 1 (o pôster tem o tamanho da animação).
export async function encodeSticker(
  r: Raster,
  limitKB: number,
  opts: { sameSize?: boolean } = {},
): Promise<{ blob: Blob; mime: 'image/webp' | 'image/png'; width: number; height: number }> {
  let webp = await webpEncodeSupported();
  for (;;) {
    const type: EncodeMime = webp ? 'image/webp' : 'image/png';
    const steps = encodeSteps(webp ? 'webp' : 'png').filter((s) => !opts.sameSize || s.scale === 1);
    let fellBack = false;
    for (const s of steps) {
      const width = Math.max(1, Math.round(r.width * s.scale));
      const height = Math.max(1, Math.round(r.height * s.scale));
      if (s.scale < 1 && Math.max(width, height) < STICKER_LIMITS.minLongSide) break;
      const blob = await encodeBlob(s.scale === 1 ? r : resizeArea(r, width, height), type, s.quality);
      if (blob.type !== type) {
        if (!webp || blob.type !== 'image/png') throw new LimitError(encodeLimitError(limitKB));
        webp = false;
        webpCheck = Promise.resolve(false);
        fellBack = true;
        break;
      }
      if (blob.size <= limitKB * 1024) return { blob, mime: type, width, height };
    }
    if (!fellBack) throw new LimitError(encodeLimitError(limitKB));
  }
}

// Primeiro quadro, do tamanho da animação. O raster volta para o dhash.
export async function makePoster(animated: Blob, limitKB: number = STICKER_LIMITS.posterMaxKB): Promise<{ blob: Blob; raster: Raster }> {
  const bmp = await createImageBitmap(animated);
  try {
    const full = { x: 0, y: 0, width: bmp.width, height: bmp.height };
    const raster = drawRaster(bmp, { width: bmp.width, height: bmp.height, affine: IDENTITY, scale: 1 }, full);
    const enc = await encodeSticker(raster, limitKB, { sameSize: true });
    return { blob: enc.blob, raster };
  } finally {
    bmp.close();
  }
}

// Só para a contagem da prévia: o tamanho no primeiro passo (o que vai ao servidor sai de encodeSticker).
export async function firstStepSize(r: Raster): Promise<{ bytes: number; mime: EncodeMime }> {
  const webp = await webpEncodeSupported();
  const step = encodeSteps(webp ? 'webp' : 'png')[0];
  const type: EncodeMime = webp ? 'image/webp' : 'image/png';
  const blob = await encodeBlob(r, type, step.quality);
  if (webp && blob.type === 'image/png') webpCheck = Promise.resolve(false);
  return { bytes: blob.size, mime: blob.type === 'image/png' ? 'image/png' : type };
}

// ---------- Animadas ----------

const secondsFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

// Primeira regra que a animação não cumpre, com o texto do editor; null quando pode ir como está.
export function animatedProblem(probe: ImageProbe, size: number, caps: StickerCaps): string | null {
  if (!caps.policy.animatedEnabled) return 'Figurinhas animadas estão desativadas. Use só o primeiro quadro.';
  if (probe.width > STICKER_LIMITS.maxSide || probe.height > STICKER_LIMITS.maxSide)
    return `Animações precisam ter no máximo 512 × 512 px. Esta tem ${probe.width} × ${probe.height}. Use só o primeiro quadro ou reduza a animação em outro programa.`;
  if (Math.max(probe.width, probe.height) < STICKER_LIMITS.minLongSide) return `A imagem é pequena demais (mínimo de ${STICKER_LIMITS.minLongSide} px no lado maior).`;
  if (size > caps.limits.animatedKB * 1024) return `Esta animação tem ${Math.ceil(size / 1024)} KB; o limite é ${caps.limits.animatedKB} KB.`;
  if (probe.durationMs > caps.limits.animatedSeconds * 1000)
    return `Esta animação dura ${secondsFmt.format(probe.durationMs / 1000)} s; o limite é ${caps.limits.animatedSeconds} s.`;
  if (probe.frames > STICKER_LIMITS.maxFrames) return `Esta animação tem ${probe.frames} quadros; o limite é ${STICKER_LIMITS.maxFrames}.`;
  return null;
}

// ---------- Importação ----------

// ignored: não é imagem que dê para usar ("Ignorada: …"); broken: o arquivo não abre ("Com erro"); sem os dois, passou de um limite.
export type NormalizedImport =
  | { ok: true; file: Blob; poster?: Blob; phash: string; name: string; reduced: boolean }
  | { ok: false; reason: string; ignored?: boolean; broken?: boolean };

// Pequena demais é um limite ("Fora dos limites"), não um arquivo com erro; lado inválido continua sendo erro.
function fitLimit(w: number, h: number): { width: number; height: number } {
  try {
    return fitSize(w, h);
  } catch (e) {
    throw e instanceof RangeError || !(e instanceof Error) ? e : new LimitError(e.message);
  }
}

const failure = (e: unknown): NormalizedImport =>
  e instanceof LimitError ? { ok: false, reason: e.message } : { ok: false, reason: e instanceof Error ? e.message : String(e), broken: true };

// Pôster que veio no pacote: só serve se for estático, PNG ou WebP, do tamanho da animação e dentro do limite.
async function packPoster(poster: Blob, probe: ImageProbe): Promise<{ blob: Blob; raster: Raster } | null> {
  if (poster.size > STICKER_LIMITS.posterMaxKB * 1024) return null;
  try {
    const bytes = new Uint8Array(await poster.arrayBuffer());
    const p = probeImage(bytes, { maxFrames: 1 });
    if ((p.mime !== 'image/png' && p.mime !== 'image/webp') || p.animated || p.width !== probe.width || p.height !== probe.height) return null;
    const blob = new Blob([bytes], { type: p.mime });
    const bmp = await createImageBitmap(blob);
    try {
      return { blob, raster: drawRaster(bmp, { width: bmp.width, height: bmp.height, affine: IDENTITY, scale: 1 }, { x: 0, y: 0, width: bmp.width, height: bmp.height }) };
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}

export async function normalizeForImport(file: Blob, name: string, caps: StickerCaps, opts: { poster?: Blob } = {}): Promise<NormalizedImport> {
  try {
    if (file.size > STICKER_LIMITS.editorMaxInputMB * MB) return { ok: false, reason: TOO_BIG_ERROR };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!sniffMime(bytes)) return { ok: false, reason: 'formato não suportado', ignored: true };
    let probe: ImageProbe;
    try {
      probe = probeBytes(bytes);
    } catch (e) {
      return failure(e);
    }
    const typed = new Blob([bytes], { type: probe.mime });
    if (probe.animated) {
      // Animada vai como está: valida, monta o pôster (o do pacote, se servir) e tira o hash dele.
      const why = animatedProblem(probe, bytes.length, caps);
      if (why) return { ok: false, reason: why };
      const poster = (opts.poster && (await packPoster(opts.poster, probe))) || (await makePoster(typed));
      return { ok: true, file: typed, poster: poster.blob, phash: dhash(poster.raster), name, reduced: false };
    }
    const bmp = await decodeBitmap(typed, probe);
    try {
      const long = Math.max(probe.width, probe.height);
      // Já cumpre as regras: sobe sem mudar nenhum byte, para que um pacote exportado volte com os mesmos arquivos.
      if (probe.mime !== 'image/jpeg' && long <= STICKER_LIMITS.maxSide && long >= STICKER_LIMITS.minLongSide && bytes.length <= caps.limits.staticKB * 1024) {
        const r = drawRaster(bmp, { width: bmp.width, height: bmp.height, affine: IDENTITY, scale: 1 }, { x: 0, y: 0, width: bmp.width, height: bmp.height });
        return { ok: true, file: typed, phash: dhash(r), name, reduced: false };
      }
      const base = bitmapToRaster(bmp, { maxSide: STICKER_LIMITS.editorWorkMaxSide });
      const size = fitLimit(base.width, base.height);
      const fitted = resizeArea(base, size.width, size.height);
      const enc = await encodeSticker(fitted, caps.limits.staticKB);
      const last = enc.width === fitted.width && enc.height === fitted.height ? fitted : resizeArea(fitted, enc.width, enc.height);
      return { ok: true, file: enc.blob, phash: dhash(last), name, reduced: true };
    } finally {
      bmp.close();
    }
  } catch (e) {
    return failure(e);
  }
}

// ---------- Worker da prévia ----------

export interface MaskWorker {
  render(input: RenderInput): Promise<RenderOutput>;
  dispose(): void;
}

// Passos 2 a 5 no Worker; o raster só atravessa quando muda. Sem Worker (ou se ele não sobe), a mesma conta roda aqui.
export function maskWorker(): MaskWorker {
  let worker: Worker | null = null;
  let local: ((i: RenderInput) => RenderOutput) | null = null;
  let seq = 0;
  let sentWork: Raster | null = null;
  let sentStage: Raster | null = null;
  const waiting = new Map<number, { input: RenderInput; resolve: (r: RenderOutput) => void; reject: (e: unknown) => void }>();
  const runLocal = (input: RenderInput) => (local ??= createRenderer())(input);
  const fallBack = () => {
    worker?.terminate();
    worker = null;
    for (const [id, w] of waiting) {
      waiting.delete(id);
      try {
        w.resolve(runLocal(w.input));
      } catch (e) {
        w.reject(e);
      }
    }
  };
  worker = spare ?? newWorker();
  spare = null;
  if (worker) {
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if ('failure' in e.data) w.reject(new Error(e.data.failure));
      else if ('result' in e.data) w.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      fallBack();
    };
    worker.onmessageerror = fallBack;
  }
  return {
    render(input) {
      const w = worker;
      if (!w) return Promise.resolve().then(() => runLocal(input));
      const req: WorkerRequest = {
        id: ++seq,
        ops: input.ops,
        outlinePx: input.outlinePx,
        trim: input.trim,
        affine: input.affine,
        scale: input.scale,
        stage: input.stage ? { affine: input.stage.affine } : null,
        stageOnly: input.stageOnly,
      };
      if (input.raster !== sentWork) req.raster = sentWork = input.raster;
      if (input.stage && req.stage && input.stage.raster !== sentStage) req.stage.raster = sentStage = input.stage.raster;
      return new Promise((resolve, reject) => {
        waiting.set(req.id, { input, resolve, reject });
        w.postMessage(req);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      waiting.clear();
    },
  };
}
