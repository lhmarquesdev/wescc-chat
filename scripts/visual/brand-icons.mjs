// Gera os ícones PNG do app (PWA e iOS) a partir de web/public/favicon.svg, a marca.
// Uso: PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/brand-icons.mjs [pasta] [--svg=arquivo] [--only=badge-96.png]
// Sem pasta, grava em web/public/icons. Troque o favicon.svg e rode de novo para mudar a marca.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executablePath, loadChromium } from './lib.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(arg ?? path.join(root, 'web/public/icons'));
fs.mkdirSync(out, { recursive: true });
const src = process.argv.slice(2).find((a) => a.startsWith('--svg='))?.slice(6) ?? path.join(root, 'web/public/favicon.svg');
// O brilho de 1px no topo é para a marca pequena; ampliado vira uma faixa, então sai dos PNGs.
const svg = fs.readFileSync(src, 'utf8').replace(/<path class="mark-highlight"[^>]*\/>\s*/, '');
const INK = '#13161c'; // fundo do ícone mascarável, a cor da barra lateral
// O Android usa só o canal alfa do selo da notificação: um ícone colorido vira um quadrado branco.
// O selo é só o símbolo (o grupo branco da marca), sem o quadrado de fundo.
const glyph = svg.match(/<g fill="#fff" transform="translate\(6 6\)">([\s\S]*?)<\/g>/)?.[1];
const only = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice(7);

// mark: tamanho da marca em % do lado; bg: fundo opaco; square: sem cantos arredondados (o iOS aplica a máscara dele).
const ICONS = [
  { file: 'icon-192.png', size: 192, mark: 100 },
  { file: 'icon-512.png', size: 512, mark: 100 },
  { file: 'icon-maskable-512.png', size: 512, mark: 60, bg: INK },
  { file: 'apple-touch-icon.png', size: 180, mark: 100, square: true },
  { file: 'badge-96.png', size: 96, mark: 100, glyph: true },
].filter((i) => !only || i.file === only);

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });
for (const icon of ICONS) {
  const p = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  // O ícone quadrado do iOS é a marca sem os cantos: o gradiente ocupa tudo e o símbolo fica no mesmo lugar.
  const markSvg = icon.glyph
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><g fill="#fff">${glyph}</g></svg>`
    : icon.square
      ? svg.replace(/rx="8"/g, 'rx="0"')
      : svg;
  await p.setContent(`<html><body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:grid;place-items:center;background:${icon.bg ?? 'transparent'}">
    <div style="width:${icon.mark}%;height:${icon.mark}%">${markSvg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await p.screenshot({ path: path.join(out, icon.file), omitBackground: !icon.bg && !icon.square });
  await p.close();
  console.log('ícone', icon.file);
}
await browser.close();
