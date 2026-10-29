// Janela de chamada: admin (desktop, claro) liga em vídeo para qa.visual (celular, escuro), com câmera e microfone falsos.
//
// Uso:
//   BASE=http://localhost:5201 PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/calls.mjs <pasta>
// Precisa do seed.json de seed.mjs (na pasta ou em SEED). As chamadas precisam de Calls_Enabled ligado.
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, ADMIN_USER, BASE, executablePath, loadChromium, outDir, requireBase } from './lib.mjs';

requireBase();

const out = outDir();
const seedFile = process.env.SEED ?? path.join(out, 'seed.json');
const { dmid, password } = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

const chromium = await loadChromium();
const browser = await chromium.launch({
  executablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
async function open(user, pass, opts) {
  const ctx = await browser.newContext({ ...opts, permissions: ['camera', 'microphone'], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill('form input >> nth=0', user);
  await p.fill('input[type="password"]', pass);
  await p.click('button[type="submit"]');
  await p.waitForSelector('.sidebar', { timeout: 15000 });
  await p.goto(`${BASE}/direct/${dmid}`);
  await p.waitForSelector('.room-header');
  await p.waitForTimeout(1000);
  await p.mouse.move(1, 1);
  return p;
}
const a = await open(ADMIN_USER, ADMIN_PASSWORD, { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const q = await open('qa.visual', password, { viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const snap = async (p, name) => {
  await p.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('shot', name);
};
// Troca o tema e espera as transições de cor (80 ms nos botões) terminarem: capturar logo depois do emulateMedia pega
// os botões no meio do caminho entre o escuro e o claro (quadrados cinza de pouco contraste).
const scheme = async (p, colorScheme) => {
  await p.emulateMedia({ colorScheme });
  await p.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const finite = document.getAnimations().filter((x) => Number.isFinite(x.effect?.getComputedTiming().endTime));
    await Promise.race([Promise.all(finite.map((x) => x.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
  });
};

await a.click('.room-actions button[title="Chamada de vídeo"]');
await a.waitForSelector('.call-window');
await a.waitForTimeout(1200);
await snap(a, '70-call-outgoing--desktop-light');
await q.waitForSelector('.call-incoming', { timeout: 10000 });
await q.waitForTimeout(500);
await snap(q, '71-call-incoming--phone-dark');
await q.click('.call-incoming button[title="Atender"]');
await a
  .waitForFunction(() => {
    const v = document.querySelector('.call-remote');
    return v && v.videoWidth > 0;
  }, null, { timeout: 20000 })
  .catch(() => console.log('o vídeo remoto não começou no admin'));
await a.waitForTimeout(1500);
await snap(a, '72-call-connected--desktop-light');
await snap(q, '73-call-connected--phone-dark');
await scheme(a, 'dark');
await a.waitForTimeout(300);
await snap(a, '72-call-connected--desktop-dark');
await a.click('.call-window button[title="Ampliar"]').catch(() => {});
await a.waitForTimeout(800);
await snap(a, '74-call-big--desktop-dark');
await q.click('.call-window button[title="Ampliar"]').catch(() => {});
await q.waitForTimeout(800);
await snap(q, '74-call-big--phone-dark');
await a.click('.call-window button[title="Desligar microfone"]').catch(() => {});
await a.click('.call-window button[title="Desligar câmera"]').catch(() => {});
await a.waitForTimeout(800);
await snap(a, '75-call-muted-camoff--desktop-dark');
await a.click('.call-window .call-btn.hang');
await a.waitForTimeout(1500);
await scheme(a, 'light');
await snap(a, '76-dm-after-call--desktop-light');
await a.goto(`${BASE}/calls`);
await a.waitForTimeout(1500);
await snap(a, '77-calls-history--desktop-light');
await q.goto(`${BASE}/calls`);
await q.waitForTimeout(1500);
await snap(q, '77-calls-history--phone-dark');
await browser.close();
