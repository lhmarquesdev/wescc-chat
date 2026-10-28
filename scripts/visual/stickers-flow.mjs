// Fluxo de ponta a ponta das figurinhas com três pessoas conectadas ao mesmo tempo:
//   1. sup (alice.souza) cria uma figurinha pessoal (pela API, o editor é do outro dono) e a envia no #geral pelo seletor;
//   2. op1 (bruno.lima, no celular e no tema escuro) a vê chegar sem recarregar;
//   3. o admin a remove de todas as conversas pelo cartão da figurinha;
//   4. nas duas páginas a mensagem vira "Figurinha removida" numa caixa do mesmo tamanho, sem a lista pular;
//   5. fetch(url, { cache: 'no-store' }) na página devolve 410.
// Grava as capturas e stickers-flow-log.json na pasta de saída; sai com código 1 se alguma conferência falhar.
//
// Uso:
//   BASE=http://localhost:5201 PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/stickers-flow.mjs <pasta>
// Precisa do seed.json de seed.mjs: na própria pasta ou no caminho em SEED.
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, ADMIN_USER, BASE, client, executablePath, loadChromium, login, outDir, requireBase } from './lib.mjs';

requireBase();
const out = outDir();
const seedFile = process.env.SEED ?? path.join(out, 'seed.json');
if (!fs.existsSync(seedFile)) {
  console.error(`seed.json não encontrado em ${seedFile}: rode seed.mjs antes.`);
  process.exit(2);
}
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const { GERAL } = seed;
const SUP = 'alice.souza';
const OP1 = 'bruno.lima';

const checks = [];
const check = (name, ok, detail = {}) => {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(ok ? 'ok  ' : 'FALHOU', name, Object.keys(detail).length ? JSON.stringify(detail) : '');
};

const admin = client(await login(ADMIN_USER, ADMIN_PASSWORD));
const r0 = await admin.call('POST', 'settings', { settings: { Stickers_Enabled: true, Stickers_Personal_Enabled: true } });
if (r0.success === false) throw new Error(`settings: ${r0.error}`);
const supLogin = await login(SUP, seed.password);

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });

// Imagem nova a cada execução: o arquivo de uma execução anterior foi bloqueado pela remoção.
const stamp = new Date().toISOString().slice(11, 19);
const NAME = `Teste ${stamp}`;
const art = await browser.newPage();
const png = await art.evaluate((label) => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.beginPath();
  g.arc(0, 0, 110, 0, Math.PI * 2);
  g.lineWidth = 12;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 70% 45%)`;
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '800 34px system-ui, sans-serif';
  g.fillText(label.split(' ')[0], 0, -18);
  g.font = '700 26px system-ui, sans-serif';
  g.fillText(label.split(' ')[1], 0, 22);
  return c.toDataURL('image/png').split(',')[1];
}, NAME);
await art.close();
const fd = new FormData();
fd.append('name', NAME);
fd.append('emojis', JSON.stringify(['🧪']));
fd.append('keywords', JSON.stringify(['fluxo']));
fd.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'teste.png');
const created = await fetch(`${BASE}/api/v1/stickers.create`, { method: 'POST', headers: { 'x-user-id': supLogin.userId, 'x-auth-token': supLogin.authToken }, body: fd }).then((r) => r.json());
check('sup cria a figurinha pessoal', created.sticker?._id, { error: created.error });
if (!created.sticker) process.exit(1);

async function open(user, password, opts) {
  const ctx = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', ...opts });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}/login`);
  await p.fill('form input >> nth=0', user);
  await p.fill('input[type="password"]', password);
  await p.click('button[type="submit"]');
  await p.waitForSelector('.sidebar', { timeout: 15000 });
  await p.goto(`${BASE}/channel/${GERAL}`);
  await p.waitForSelector('.composer textarea');
  await p.waitForTimeout(800);
  return { ctx, p, errs };
}
const desktop = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' };
const phone = { viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sup = await open(SUP, seed.password, desktop);
const op1 = await open(OP1, seed.password, phone);
const adm = await open(ADMIN_USER, ADMIN_PASSWORD, desktop);
const shot = (pg, name) => pg.screenshot({ path: path.join(out, `${name}.png`) });

// 1. sup envia pelo seletor.
await sup.p.click('.composer-tools button[title="Emoji"]');
await sup.p.waitForSelector('.expr-picker');
const tab = sup.p.locator('.expr-head [data-tab="stickers"]');
if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
const cell = sup.p.locator(`.sticker-grid .sticker-cell[aria-label="Enviar figurinha “${NAME}”"]`).first();
await cell.waitFor({ timeout: 8000 });
await cell.scrollIntoViewIfNeeded();
await cell.click();
const sentHit = sup.p.locator(`.msg .sticker-hit[aria-label="Figurinha “${NAME}”: ver detalhes"]`).last();
await sentHit.waitFor({ timeout: 8000 });
const toast = await sup.p.waitForSelector('.toasts :text("Figurinha enviada.")', { timeout: 4000 }).then(() => true, () => false);
check('sup: mensagem aparece e o aviso "Figurinha enviada." mostra', toast);
check('sup: seletor fecha depois de enviar', !(await sup.p.locator('.expr-picker').isVisible().catch(() => false)));
const msgId = (await sentHit.evaluate((el) => el.closest('.msg')?.id ?? '')).replace(/^msg-/, '');
const url = await sentHit.locator('img').getAttribute('src');
check('id da mensagem e endereço da figurinha', msgId && url?.startsWith('/sticker/'), { msgId, url });
await sup.p.waitForFunction((id) => document.querySelector(`#msg-${id} .sticker-msg`)?.dataset.state === 'loaded', msgId, { timeout: 8000 }).catch(() => {});
await sup.p.waitForTimeout(600);
await shot(sup.p, 'flow-01-sup-enviou');

// 2. op1 recebe em tempo real.
const op1Seen = await op1.p
  .waitForFunction((id) => document.querySelector(`#msg-${id} .sticker-msg`)?.dataset.state === 'loaded', msgId, { timeout: 10000 })
  .then(() => true, () => false);
check('op1 vê a figurinha chegar sem recarregar', op1Seen);
await op1.p.waitForTimeout(600);
await shot(op1.p, 'flow-02-op1-recebeu');

// Medidas antes da remoção: caixa da figurinha, posição na tela e rolagem da lista.
const metrics = (pg) =>
  pg.evaluate((id) => {
    const box = document.querySelector(`#msg-${id} .sticker-msg`);
    const list = document.querySelector('.room-main .messages') ?? document.querySelector('.messages');
    const r = box?.getBoundingClientRect();
    return {
      w: Math.round(r?.width ?? -1),
      h: Math.round(r?.height ?? -1),
      top: Math.round(r?.top ?? -1),
      scrollTop: Math.round(list?.scrollTop ?? -1),
      scrollHeight: Math.round(list?.scrollHeight ?? -1),
      removed: !!box?.querySelector('.sticker-removed'),
      text: box?.textContent?.trim() ?? '',
    };
  }, msgId);
const before = { sup: await metrics(sup.p), op1: await metrics(op1.p) };

// 3. admin remove de todas as conversas pelo cartão.
const admHit = adm.p.locator(`#msg-${msgId} .sticker-hit`);
await admHit.waitFor({ timeout: 8000 });
await admHit.scrollIntoViewIfNeeded();
await admHit.click();
await adm.p.waitForSelector('.sticker-card');
await adm.p.click('.sticker-card button:has-text("Remover de todas as conversas")');
await adm.p.waitForSelector('.sticker-remove-text');
await adm.p.waitForFunction(() => !document.querySelector('.sticker-remove-text')?.textContent?.includes('Verificando'), null, { timeout: 6000 });
const usageText = (await adm.p.locator('.sticker-remove-text').first().textContent())?.trim();
check('admin: o diálogo conta onde a figurinha aparece', /1 mensagem em 1 conversa/.test(usageText ?? ''), { usageText });
await adm.p.fill('.modal textarea', 'Teste do fluxo de remoção');
await shot(adm.p, 'flow-03-admin-dialogo');
await adm.p.click('.modal button:has-text("Remover de todas")');
const removedToast = await adm.p.waitForSelector('.toasts :text("Figurinha removida de todas as conversas.")', { timeout: 6000 }).then(() => true, () => false);
check('admin: aviso "Figurinha removida de todas as conversas."', removedToast);

// 4. As duas páginas trocam a figurinha pelo aviso, na mesma caixa e sem pular.
for (const [who, s] of [['sup', sup], ['op1', op1]]) {
  const ok = await s.p
    .waitForFunction((id) => !!document.querySelector(`#msg-${id} .sticker-removed`), msgId, { timeout: 10000 })
    .then(() => true, () => false);
  await s.p.waitForTimeout(500);
  const after = await metrics(s.p);
  const b = before[who];
  check(`${who}: mostra "Figurinha removida"`, ok && /Figurinha removida/.test(after.text), { text: after.text });
  check(`${who}: caixa do mesmo tamanho`, Math.abs(after.w - b.w) <= 1 && Math.abs(after.h - b.h) <= 1, { antes: `${b.w}x${b.h}`, depois: `${after.w}x${after.h}` });
  check(`${who}: lista não pula`, Math.abs(after.top - b.top) <= 1 && Math.abs(after.scrollHeight - b.scrollHeight) <= 1, {
    topo: `${b.top} -> ${after.top}`,
    altura: `${b.scrollHeight} -> ${after.scrollHeight}`,
    rolagem: `${b.scrollTop} -> ${after.scrollTop}`,
  });
  const status = await s.p.evaluate((u) => fetch(u, { cache: 'no-store' }).then((r) => r.status), url);
  check(`${who}: fetch(url, { cache: 'no-store' }) dá 410`, status === 410, { status });
  await shot(s.p, `flow-0${who === 'sup' ? 4 : 5}-${who}-removida`);
}

// O seletor de sup não oferece mais a figurinha.
await sup.p.click('.composer-tools button[title="Emoji"]');
await sup.p.waitForSelector('.expr-picker');
await sup.p.waitForTimeout(600);
const still = await sup.p.locator(`.sticker-grid .sticker-cell[aria-label="Enviar figurinha “${NAME}”"]`).count();
check('sup: a figurinha sai do seletor (pacote e recentes)', still === 0, { cells: still });
await shot(sup.p, 'flow-06-sup-seletor');

for (const [who, s] of [['sup', sup], ['op1', op1], ['admin', adm]]) {
  if (s.errs.length) check(`${who}: sem erros na página`, false, { errors: [...new Set(s.errs)].slice(0, 5) });
  await s.ctx.close();
}
await browser.close();
const failed = checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(out, 'stickers-flow-log.json'), JSON.stringify({ sticker: NAME, msgId, url, checks }, null, 2));
console.log('done', checks.length, 'conferências,', failed, 'falharam');
process.exit(failed ? 1 : 0);
