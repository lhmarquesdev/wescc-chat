// Gera os ícones PNG do app (PWA e iOS) a partir de web/public/favicon.svg, a marca.
// Uso: PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/brand-icons.mjs [pasta] [--svg=arquivo] [--only=badge-96.png]
// Sem pasta, grava em web/public/icons. Troque o favicon.svg (mantendo as cores #dd083d e #1a2d54) e rode de novo para mudar a marca.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executablePath, loadChromium } from './lib.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(arg ?? path.join(root, 'web/public/icons'));
fs.mkdirSync(out, { recursive: true });
const src = process.argv.slice(2).find((a) => a.startsWith('--svg='))?.slice(6) ?? path.join(root, 'web/public/favicon.svg');
const svg = fs.readFileSync(src, 'utf8');
const BRAND = '#1a2d54'; // fundo dos ícones opacos: Deep Navy, a cor do menu lateral
// Sobre o Navy a marca fica em Soft Butter com a dobra em Cherry Red, como no menu lateral.
const white = svg.replace(/#dd083d/g, '#ffeeb5').replace(/#1a2d54/g, '#dd083d');
// O Android usa só o canal alfa do selo da notificação: o selo é a marca toda em branco, sem degradê.
const flat = svg.replace(/url\(#fold\)/g, '#ffffff').replace(/#dd083d/g, '#ffffff');
const only = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice(7);

// mark: tamanho da marca em % do lado; bg: fundo opaco (o iOS e o Android aplicam a máscara deles).
const ICONS = [
  { file: 'icon-192.png', size: 192, mark: 92 },
  { file: 'icon-512.png', size: 512, mark: 92 },
  { file: 'icon-maskable-512.png', size: 512, mark: 52, bg: BRAND },
  { file: 'apple-touch-icon.png', size: 180, mark: 62, bg: BRAND },
  { file: 'badge-96.png', size: 96, mark: 100, glyph: true },
].filter((i) => !only || i.file === only);

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });
for (const icon of ICONS) {
  const p = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  const markSvg = icon.glyph ? flat : icon.bg ? white : svg;
  await p.setContent(`<html><body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:grid;place-items:center;background:${icon.bg ?? 'transparent'}">
    <div style="width:${icon.mark}%;height:${icon.mark}%">${markSvg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await p.screenshot({ path: path.join(out, icon.file), omitBackground: !icon.bg });
  await p.close();
  console.log('ícone', icon.file);
}
await browser.close();
