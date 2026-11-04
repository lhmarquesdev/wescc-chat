// Tradução de mensagens pelo LibreTranslate da empresa, de ponta a ponta (spec F §8).
// Tira print de cada passo (computador claro e escuro, celular) e sai com código 1 se algo falhar.
//
// Uso:
//   CHAT_URL=http://localhost:3106 PLAYWRIGHT_CORE=/caminho/playwright-core ADMIN_USER=admin ADMIN_PASSWORD=... \
//     node scripts/e2e/traducao.mjs <pasta>
//
// O servidor do chat precisa ter o endereço do tradutor liberado: INTEGRATIONS_ALLOWED_HOSTS=127.0.0.1:3157.
//
// Variáveis de ambiente:
//   CHAT_URL           endereço do chat com a web compilada. Obrigatória.
//   LIBRE_URL          um LibreTranslate de verdade (ex.: http://10.0.0.20:5000). Sem ela, o roteiro sobe o falso dos
//                      testes (server/test/fake-libretranslate.ts) em 127.0.0.1:LIBRE_PORT e confere as frases em inglês
//                      do dicionário dele; o passo 10 (tradutor fora do ar) só roda com o falso.
//   LIBRE_PORT         porta do falso (padrão 3157).
//   STEPS              passos a rodar, por exemplo 1,3 (padrão: todos). Do 3 ao 7 e o 10 a 12 usam o que o 1 e o 2 fazem.
//   PLAYWRIGHT_CORE, CHROMIUM_PATH, ADMIN_USER, ADMIN_PASSWORD   como em scripts/visual/lib.mjs.
//
// Cria (ou reaproveita) e2e.maria, e2e.john (Usuário) e e2e.op1 (Operação), com uma senha nova a cada execução, e
// recria as salas #e2e-geral, #e2e-avisos (canal de avisos, maria publicadora) e e2e-secreto (grupo criptografado).
// No fim desliga a tradução e devolve o limite de requisições.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAT_URL = (process.env.CHAT_URL ?? '').replace(/\/+$/, '');
if (!CHAT_URL) {
  console.error('Defina CHAT_URL com o endereço do chat, por exemplo CHAT_URL=http://localhost:3106');
  process.exit(2);
}
process.env.BASE = CHAT_URL;
const lib = await import('../visual/lib.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = lib.outDir();
const STEPS = new Set((process.env.STEPS ?? '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map((s) => Number(s.trim())));
const PASSWORD = `E2e-${crypto.randomBytes(6).toString('hex')}!`;
const FAKE = !process.env.LIBRE_URL;
const LIBRE_PORT = Number(process.env.LIBRE_PORT ?? 3157);
const LIBRE_URL = (process.env.LIBRE_URL ?? `http://127.0.0.1:${LIBRE_PORT}`).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- LibreTranslate falso ----------

let fake = null;
async function libreUp() {
  try {
    const r = await fetch(`${LIBRE_URL}/languages`);
    return r.ok;
  } catch {
    return false;
  }
}
async function startFake() {
  if (!FAKE) return;
  if (await libreUp()) throw new Error(`a porta ${LIBRE_PORT} já está ocupada: pare o que está nela ou use LIBRE_PORT`);
  fake = spawn(process.execPath, ['--import', 'tsx', 'server/test/fake-libretranslate.ts', String(LIBRE_PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100 && !(await libreUp()); i++) await sleep(100);
  if (!(await libreUp())) throw new Error('o LibreTranslate falso não subiu');
}
async function stopFake() {
  if (!fake) return;
  const child = fake;
  fake = null;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && (await libreUp()); i++) await sleep(100);
}
await startFake();

// ---------- API ----------

const admin = lib.client(await lib.login(lib.ADMIN_USER, lib.ADMIN_PASSWORD));
const ok = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};
const setSettings = async (settings) => ok('settings', await admin.call('POST', 'settings', { settings }));

const PEOPLE = {
  maria: { username: 'e2e.maria', name: 'Maria Oliveira', roles: ['user'] },
  john: { username: 'e2e.john', name: 'John Miller', roles: ['user'] },
  op1: { username: 'e2e.op1', name: 'Otávio Operador', roles: ['operacao'] },
};
const ADMIN = { username: lib.ADMIN_USER, password: lib.ADMIN_PASSWORD };

async function ensurePerson(p) {
  const info = await admin.call('GET', 'users.info', { username: p.username });
  if (info.success && info.user?._id) {
    ok(`users.update ${p.username}`, await admin.call('POST', 'users.update', { userId: info.user._id, data: { password: PASSWORD, roles: p.roles, name: p.name, active: true } }));
  } else {
    ok(
      `users.create ${p.username}`,
      await admin.call('POST', 'users.create', { username: p.username, name: p.name, email: `${p.username}@example.com`, password: PASSWORD, roles: p.roles, verified: true, joinDefaultChannels: false }),
    );
  }
  p.auth = await lib.login(p.username, PASSWORD);
  p.id = p.auth.userId;
  p.api = lib.client(p.auth);
  // Sem idioma próprio: vale o padrão da empresa (português).
  ok('users.setPreferences', await p.api.call('POST', 'users.setPreferences', { data: { language: null } }));
}

// Muitas telas ao mesmo tempo: o limite de requisições da API fica desligado durante o roteiro e volta no fim.
const RATE = 'API_Enable_Rate_Limiter';
const before = ok('settings', await admin.call('GET', 'settings')).settings;
const rateBefore = before.find((x) => x._id === RATE)?.value;
if (rateBefore !== false) await setSettings({ [RATE]: false });
// O passo 1 liga a tradução pela tela: começa desligada e sem endereço.
await setSettings({ AutoTranslate_Enabled: false, AutoTranslate_LibreTranslate_Url: '', Language: 'pt-BR' });

for (const p of Object.values(PEOPLE)) await ensurePerson(p);
const { maria, john, op1 } = PEOPLE;

// Salas novas a cada execução (as mensagens e traduções da anterior somem junto).
async function freshRoom(prefix, name, members, extraData = {}) {
  const info = await admin.call('GET', `${prefix}.info`, { roomName: name });
  if (info.success) ok(`rooms.delete ${name}`, await admin.call('POST', 'rooms.delete', { roomId: (info.channel ?? info.group)._id }));
  const r = ok(`${prefix}.create ${name}`, await admin.call('POST', `${prefix}.create`, { name, members, extraData }));
  return (r.channel ?? r.group)._id;
}
const ROOMS = {
  geral: await freshRoom('channels', 'e2e-geral', [maria.username, john.username, op1.username]),
  avisos: await freshRoom('channels', 'e2e-avisos', [maria.username, john.username], { notice: true, noticeAck: true }),
  secreto: await freshRoom('groups', 'e2e-secreto', [maria.username, john.username]),
};
ok('addPublisher', await admin.call('POST', 'channels.addPublisher', { roomId: ROOMS.avisos, userId: maria.id }));

const send = async (who, rid, msg, extra = {}) => ok(`chat.sendMessage ${who.username}`, await who.api.call('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } })).message;

// Histórico de #e2e-geral: português de maria no alto (fora da tela), muitas mensagens de John, uma em inglês de op1
// e, por último, a mensagem do passo 3.
const OLD_PT = await send(maria, ROOMS.geral, 'Você pode revisar o relatório hoje?');
await send(maria, ROOMS.geral, 'Não esqueça de atualizar o painel hoje.');
for (let i = 1; i <= 40; i++) await send(john, ROOMS.geral, `ok ${i}`);
const EN_MSG = await send(op1, ROOMS.geral, 'Hello team, the build is green.');
await send(maria, ROOMS.geral, 'A reunião mudou para amanhã.');
const STEP3_TEXT = 'Bom dia, @e2e.john! O deploy é hoje às 15h. Veja `npm run build`.';
const STEP3 = await send(maria, ROOMS.geral, STEP3_TEXT);

// ---------- Navegador ----------

const chromium = await lib.loadChromium();
const browser = await chromium.launch({
  executablePath: lib.executablePath,
  channel: lib.executablePath ? undefined : 'chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const DESK = { viewport: { width: 1366, height: 850 } };
const PIXEL7 = { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' };

const problems = [];
const pages = [];
let allowHttp = null; // resposta de erro esperada no passo (ex.: o teste com endereço da internet)

async function open(who, { phone = false, scheme = 'light', url = '/home' } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PIXEL7 : DESK), colorScheme: scheme, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  const name = `${who.username}${phone ? '/celular' : ''}${scheme === 'dark' ? '/escuro' : ''}`;
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Push API in incognito/.test(m.text()) && problems.push(`${name} console: ${m.text()}`.slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/') && !(allowHttp && allowHttp.test(r.url()))) problems.push(`${name} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(CHAT_URL, '')}`);
  });
  await page.goto(`${CHAT_URL}/login`);
  await page.fill('form input >> nth=0', who.username);
  await page.fill('input[type="password"]', who.password ?? PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  if (url) await page.goto(`${CHAT_URL}${url}`);
  await page.waitForFunction(() => [...document.querySelectorAll('.sidebar, .tabbar, .page')].some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'), null, { timeout: 30000 });
  pages.push(ctx);
  return page;
}

let shotN = 0;
async function shot(page, name) {
  shotN++;
  const file = path.join(OUT, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: file });
  return file;
}

const expectVisible = async (loc, what, timeout = 8000) => {
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`não apareceu: ${what}`);
  }
};
const assert = (cond, what) => {
  if (!cond) throw new Error(what);
};
async function waitFor(what, fn, timeout = 10000) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn().catch((e) => e);
    if (last && !(last instanceof Error)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`não aconteceu: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(200);
  }
}
const noOops = async (page) => assert(!(await page.getByText('Algo deu errado').count()), 'a tela mostrou "Algo deu errado"');
const noHScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1);

const results = [];
async function step(n, title, fn) {
  if (!STEPS.has(n)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ n, title, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${n}. ${title}`);
  } catch (e) {
    results.push({ n, title, ok: false, error: e.message });
    for (const [i, ctx] of pages.entries()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(OUT, `falha-${n}-${i}.png`) }).catch(() => {});
    console.log(`FALHA ${n}. ${title}: ${e.message}`);
  }
}

// ---------- Ajudas da tela ----------

const msgEl = (page, id) => page.locator(`#msg-${id}`);
const bodyText = (page, id) => msgEl(page, id).locator('.msg-body').first().innerText();
const lineText = async (page, id) => {
  const l = msgEl(page, id).locator('.msg-translated');
  return (await l.count()) ? (await l.first().innerText()).replace(/\s+/g, ' ').trim() : '';
};
// O que o dicionário do falso devolve (com um LibreTranslate de verdade, só confere que mudou).
const expectBody = async (page, id, en, pt, timeout = 10000) =>
  waitFor(`tradução de ${id}`, async () => {
    const t = await bodyText(page, id);
    return (FAKE ? t.includes(en) : !t.includes(pt)) || null;
  }, timeout);

async function openRoom(page, rid) {
  await page.goto(`${CHAT_URL}/channel/${rid}`);
  await expectVisible(page.locator('.messages .msg'), 'mensagens da sala', 15000);
}
async function messageMenu(page, id) {
  const el = msgEl(page, id);
  await el.scrollIntoViewIfNeeded();
  await el.hover();
  await el.locator('.msg-toolbar button[title="Mais"]').click();
  return page.getByRole('menu').last();
}
async function roomMenu(page) {
  await page.locator('.room-actions button[title="Mais"]').click();
  return page.getByRole('menu').last();
}
// Toque longo de verdade (pointer de toque), como uma pessoa no celular.
async function longPress(page, loc) {
  const box = await loc.boundingBox();
  const x = box.x + Math.min(40, box.width / 2);
  const y = box.y + Math.min(20, box.height / 2);
  const init = { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y, pointerId: 7 };
  await loc.dispatchEvent('pointerdown', init);
  await sleep(650);
  await loc.dispatchEvent('pointerup', init);
}
const toastTexts = (page) => page.locator('.toast .toast-text').allInnerTexts();

let geralJohn = null; // a tela de John em #e2e-geral (passos 3 a 6 e 10)

// ---------- Passos ----------

await step(1, 'Admin configura o LibreTranslate, testa a conexão e liga a tradução', async () => {
  const a = await open(ADMIN, { url: '/admin/settings?group=AutoTranslate' });
  await expectVisible(a.getByText('As mensagens são traduzidas só pelo LibreTranslate da empresa', { exact: false }), 'aviso do grupo');
  const url = a.getByLabel('Endereço do LibreTranslate', { exact: false });
  await url.fill(LIBRE_URL);
  await shot(a, 'admin-traducao-rascunho');
  // Testa o rascunho, sem salvar.
  await a.getByRole('button', { name: 'Testar conexão' }).click();
  await waitFor('toast "Conexão bem-sucedida"', async () => (await toastTexts(a)).some((t) => t.startsWith('Conexão bem-sucedida')) || null);
  await shot(a, 'admin-traducao-teste-ok');
  await a.locator('.setting-row', { hasText: 'Tradução de mensagens' }).locator('.toggle-track').click();
  assert(await a.getByRole('switch', { name: 'Tradução de mensagens' }).isChecked(), 'o interruptor não ligou');
  await a.getByRole('button', { name: 'Salvar alterações' }).click();
  await waitFor('salvo', async () => (await toastTexts(a)).includes('Configurações salvas.') || null);
  const s = ok('settings', await admin.call('GET', 'settings')).settings;
  assert(s.find((x) => x._id === 'AutoTranslate_Enabled')?.value === true, 'a tradução não ficou ligada');
  assert(s.find((x) => x._id === 'AutoTranslate_LibreTranslate_Url')?.value === LIBRE_URL, 'o endereço não foi salvo');
  // Endereço da internet: o teste mostra o motivo sem conectar.
  await url.fill('http://8.8.8.8:5000');
  allowHttp = /autoTranslate\.testConnection/;
  await a.getByRole('button', { name: 'Testar conexão' }).click();
  await waitFor('recusa de endereço externo', async () => (await toastTexts(a)).some((t) => /Falha na conexão: .*(rede da empresa|INTEGRATIONS_ALLOWED_HOSTS)/.test(t)) || null);
  allowHttp = null;
  await shot(a, 'admin-traducao-endereco-externo');
  await a.getByRole('button', { name: 'Descartar' }).click();
  await noOops(a);
  await a.context().close();
});

await step(2, 'John escolhe inglês em Minha conta › Preferências › Tradução', async () => {
  const j = await open(john, { url: '/account/preferences' });
  const card = j.locator('.card', { has: j.getByRole('heading', { name: 'Tradução' }) });
  await expectVisible(card, 'cartão Tradução');
  const select = card.getByLabel('Traduzir mensagens para');
  await waitFor('lista de idiomas', async () => (await select.isEnabled()) && (await select.locator('option').count()) > 2);
  const labels = await select.locator('option').allInnerTexts();
  assert(labels[0] === 'Padrão da empresa (Português (Brasil))', `primeira opção: ${labels[0]}`);
  assert(labels.includes('Inglês'), `sem "Inglês" na lista: ${labels.join(', ')}`);
  await select.selectOption({ label: 'Inglês' });
  await waitFor('preferência salva', async () => {
    const me = await john.api.call('GET', 'me');
    return me.preferences?.language === 'en' || null;
  });
  await card.scrollIntoViewIfNeeded();
  await shot(j, 'preferencias-traducao');
  await j.emulateMedia({ colorScheme: 'dark' });
  await shot(j, 'preferencias-traducao-escuro');
  await j.context().close();
});

await step(3, 'Traduzir pelo menu: corpo em inglês, menção e código intactos, "Ver original" volta', async () => {
  const j = (geralJohn = await open(john));
  await openRoom(j, ROOMS.geral);
  const menu = await messageMenu(j, STEP3._id);
  await menu.getByRole('menuitem', { name: 'Traduzir' }).click();
  await expectBody(j, STEP3._id, 'Good morning, @e2e.john! The deploy is today at 3 pm. See', 'deploy é hoje');
  const el = msgEl(j, STEP3._id);
  assert((await el.locator('.msg-body .mention.me').innerText()) === '@e2e.john', 'a menção a John não ficou destacada');
  assert((await el.locator('.msg-body code').first().innerText()) === 'npm run build', 'o código mudou');
  assert((await lineText(j, STEP3._id)) === 'Traduzida do português · Ver original', `linha: ${await lineText(j, STEP3._id)}`);
  await shot(j, 'manual-traduzida');
  await el.locator('.msg-translated .msg-tr-btn', { hasText: 'Ver original' }).click();
  await waitFor('texto original', async () => (await bodyText(j, STEP3._id)).includes('O deploy é hoje às 15h') || null);
  assert(!(await lineText(j, STEP3._id)), 'a linha de tradução ficou com o original na tela');
  const again = await messageMenu(j, STEP3._id);
  await expectVisible(again.getByRole('menuitem', { name: 'Traduzir' }), 'item "Traduzir" de volta');
  await j.keyboard.press('Escape');
  // A própria mensagem não oferece "Traduzir".
  const own = j.locator('.messages .msg', { hasText: 'ok 40' }).first();
  await own.scrollIntoViewIfNeeded();
  await own.hover();
  await own.locator('.msg-toolbar button[title="Mais"]').click();
  assert(!(await j.getByRole('menu').last().getByRole('menuitem', { name: 'Traduzir' }).count()), '"Traduzir" numa mensagem própria');
  await j.keyboard.press('Escape');
  await noOops(j);
});

await step(4, 'Tradução automática da sala: só o que entra na tela, nem as próprias nem o inglês', async () => {
  const j = geralJohn;
  const menu = await roomMenu(j);
  await menu.getByRole('menuitem', { name: 'Tradução automática' }).click();
  const panel = j.locator('.panel-translate');
  await expectVisible(panel, 'painel Tradução automática');
  const select = panel.locator('select');
  await waitFor('lista de idiomas no painel', async () => (await select.isEnabled()) || null);
  const first = await select.locator('option').first().innerText();
  assert(first === 'Meu idioma (Inglês)', `primeira opção do painel: ${first}`);
  await shot(j, 'painel-traducao-desligada');
  await panel.locator('.toggle', { hasText: 'Traduzir automaticamente para inglês' }).locator('.toggle-track').click();
  await waitFor('inscrição com tradução automática', async () => {
    const r = await john.api.call('GET', 'subscriptions.getOne', { roomId: ROOMS.geral });
    return r.subscription?.autoTranslate === true || null;
  });
  // A mensagem do passo 3 (e a de "reunião") na tela ganham a tradução sozinhas.
  await expectBody(j, STEP3._id, 'Good morning, @e2e.john!', 'deploy é hoje');
  const meeting = j.locator('.messages .msg', { hasText: /reunião|meeting/ }).first();
  await waitFor('reunião traduzida', async () => (await meeting.innerText()).includes(FAKE ? 'The meeting moved to tomorrow.' : 'Traduzida do') || null);
  // A de op1 em inglês e as de John: sem linha.
  assert(!(await lineText(j, EN_MSG._id)), `linha na mensagem em inglês: ${await lineText(j, EN_MSG._id)}`);
  assert(!(await j.locator('.messages .msg', { hasText: 'ok 40' }).first().locator('.msg-translated').count()), 'linha numa mensagem própria');
  await shot(j, 'automatica-ligada');
  await j.locator('.panel-translate').getByRole('button', { name: /Fechar/ }).first().click().catch(() => {});
  // A mensagem antiga, lá no alto, ainda não foi pedida: só ao rolar até ela.
  const oldEl = msgEl(j, OLD_PT._id);
  const hadLine = (await oldEl.count()) ? await oldEl.locator('.msg-translated').count() : 0;
  assert(!hadLine, 'a mensagem fora da tela já veio traduzida (pediu antes de aparecer)');
  await waitFor('rolar até a mensagem antiga', async () => {
    await j.locator('.messages.stream').evaluate((el) => (el.scrollTop = 0));
    return (await oldEl.count()) > 0 || null;
  }, 15000);
  await oldEl.scrollIntoViewIfNeeded();
  await expectBody(j, OLD_PT._id, 'Can you review the report today?', 'revisar o relatório');
  assert((await lineText(j, OLD_PT._id)).startsWith('Traduzida do português'), 'a antiga não ganhou a linha');
  await shot(j, 'automatica-historico');
  await noOops(j);
});

await step(5, 'Edição: a tradução nova aparece em até 3 s', async () => {
  const j = geralJohn;
  ok('chat.update', await maria.api.call('POST', 'chat.update', { roomId: ROOMS.geral, msgId: STEP3._id, text: 'Bom dia, @e2e.john! O deploy foi adiado para amanhã às 10h. Veja `npm run build`.' }));
  await msgEl(j, STEP3._id).scrollIntoViewIfNeeded();
  await expectBody(j, STEP3._id, 'The deploy was moved to tomorrow at 10 am', 'adiado', 3000);
  await shot(j, 'edicao-traduzida');
});

await step(6, 'Tópico: a resposta aparece traduzida no painel do tópico', async () => {
  const j = geralJohn;
  const reply = await send(maria, ROOMS.geral, 'Eu respondo no tópico: hoje não dá.', { tmid: STEP3._id });
  const summary = msgEl(j, STEP3._id).locator('.thread-summary');
  await expectVisible(summary, 'resumo do tópico');
  await summary.click();
  const panel = j.locator('.thread-panel');
  await expectVisible(panel.locator(`#msg-${reply._id}`), 'resposta no painel');
  await waitFor('resposta traduzida', async () => (await panel.locator(`#msg-${reply._id} .msg-body`).innerText()).includes(FAKE ? "I'll answer in the thread: today is not possible." : 'Traduzida') || null);
  assert((await panel.locator(`#msg-${reply._id} .msg-translated`).innerText()).includes('Traduzida do português'), 'sem linha no tópico');
  await shot(j, 'topico-traduzido');
  await panel.getByRole('button', { name: /Fechar/ }).first().click().catch(() => {});
});

await step(7, 'Canal de avisos: título traduzido no cartão e "Ciente" continua contando', async () => {
  ok('saveSettings', await john.api.call('POST', 'autoTranslate.saveSettings', { roomId: ROOMS.avisos, field: 'autoTranslate', value: true }));
  const notice = await send(maria, ROOMS.avisos, '# Aviso importante\nA reunião mudou para amanhã.', { ackRequired: true });
  const j = await open(john);
  await openRoom(j, ROOMS.avisos);
  const card = msgEl(j, notice._id).locator('.notice-card');
  await waitFor('título traduzido', async () => {
    const title = await card.locator('.notice-card-title').innerText();
    return (FAKE ? title === 'Important notice' : title !== 'Aviso importante') || null;
  });
  await waitFor('corpo traduzido', async () => (await card.innerText()).includes(FAKE ? 'The meeting moved to tomorrow.' : 'Traduzida do') || null);
  await shot(j, 'aviso-traduzido');
  await card.getByRole('button', { name: 'Ciente' }).click();
  await waitFor('contagem do Ciente', async () => {
    const r = await maria.api.call('GET', 'chat.getMessage', { msgId: notice._id });
    return r.message?.ackCount === 1 || null;
  });
  const m = ok('getMessage', await maria.api.call('GET', 'chat.getMessage', { msgId: notice._id })).message;
  assert(!m.editedAt, 'traduzir marcou o aviso como editado');
  assert(m.msg === '# Aviso importante\nA reunião mudou para amanhã.', 'o texto do aviso mudou no servidor');
  await shot(j, 'aviso-ciente');
  await j.context().close();
});

await step(8, 'Operação traduz pelo menu e não ganha DM nova', async () => {
  ok('op1 idioma', await op1.api.call('POST', 'users.setPreferences', { data: { language: 'en' } }));
  const dms = async () => ((await op1.api.call('GET', 'subscriptions.get')).update ?? []).filter((s) => s.t === 'd').length;
  const before = await dms();
  const o = await open(op1);
  await openRoom(o, ROOMS.geral);
  const meeting = o.locator('.messages .msg', { hasText: 'A reunião mudou para amanhã.' }).first();
  const id = (await meeting.getAttribute('id')).slice(4);
  const menu = await messageMenu(o, id);
  await menu.getByRole('menuitem', { name: 'Traduzir' }).click();
  await expectBody(o, id, 'The meeting moved to tomorrow.', 'reunião mudou');
  await shot(o, 'operacao-traduz');
  assert((await dms()) === before, 'traduzir criou uma conversa direta para op1');
  await o.context().close();
});

await step(9, 'Grupo criptografado: sem painel nem "Traduzir"; ligar a criptografia desliga a automática', async () => {
  ok('saveSettings secreto', await john.api.call('POST', 'autoTranslate.saveSettings', { roomId: ROOMS.secreto, field: 'autoTranslate', value: true }));
  const msg = await send(maria, ROOMS.secreto, 'Olá, o servidor voltou? Não consigo entrar hoje.');
  ok('encrypted', await admin.call('POST', 'rooms.saveRoomSettings', { rid: ROOMS.secreto, encrypted: true }));
  await waitFor('automática desligada', async () => {
    const r = await john.api.call('GET', 'subscriptions.getOne', { roomId: ROOMS.secreto });
    return r.subscription && !r.subscription.autoTranslate ? true : null;
  });
  const j = await open(john);
  await j.goto(`${CHAT_URL}/group/${ROOMS.secreto}`);
  await expectVisible(msgEl(j, msg._id), 'mensagem no grupo');
  const menu = await roomMenu(j);
  assert(!(await menu.getByRole('menuitem', { name: 'Tradução automática' }).count()), 'painel de tradução numa sala criptografada');
  await j.keyboard.press('Escape');
  const mm = await messageMenu(j, msg._id);
  assert(!(await mm.getByRole('menuitem', { name: 'Traduzir' }).count()), '"Traduzir" numa sala criptografada');
  await shot(j, 'criptografada-sem-traduzir');
  await j.keyboard.press('Escape');
  assert(!(await msgEl(j, msg._id).locator('.msg-translated').count()), 'linha de tradução numa sala criptografada');
  const r = await john.api.call('POST', 'autoTranslate.translateMessages', { roomId: ROOMS.secreto, messageIds: [msg._id] });
  assert(r.success === false && r.errorType === 'error-translate-encrypted', `a API traduziu numa sala criptografada: ${JSON.stringify(r)}`);
  await j.context().close();
});

await step(10, 'Tradutor fora do ar: original com aviso, sem toast; volta sozinho', async () => {
  if (!FAKE) {
    console.log('     (pulado: só com o LibreTranslate falso)');
    return;
  }
  const j = geralJohn;
  await stopFake();
  const t0 = Date.now();
  const msg = await send(maria, ROOMS.geral, 'Boa tarde, você viu o alerta de hoje?');
  await expectVisible(msgEl(j, msg._id), 'mensagem nova');
  await waitFor('linha "Tradução indisponível agora."', async () => (await lineText(j, msg._id)) === 'Tradução indisponível agora.' || null, 15000);
  assert((await bodyText(j, msg._id)).includes('Boa tarde, você viu o alerta de hoje?'), 'o original sumiu');
  assert(!(await toastTexts(j)).some((t) => /tradu/i.test(t)), `toast com o tradutor fora: ${(await toastTexts(j)).join(' | ')}`);
  await shot(j, 'tradutor-fora');
  await startFake();
  await expectBody(j, msg._id, 'Good afternoon, did you see today’s alert?', 'Boa tarde', 60000);
  console.log(`     traduzida ${Math.round((Date.now() - t0) / 1000)} s depois de cair`);
  await shot(j, 'tradutor-voltou');
});

await step(11, 'Celular: toque longo, "Ver original" com alvo de 44 px e o painel em tela cheia', async () => {
  const m = await open(john, { phone: true });
  await m.goto(`${CHAT_URL}/channel/${ROOMS.geral}`);
  const el = msgEl(m, STEP3._id);
  await expectVisible(el, 'mensagem no celular', 15000);
  await el.scrollIntoViewIfNeeded();
  await expectBody(m, STEP3._id, 'The deploy was moved to tomorrow', 'adiado');
  await longPress(m, el.locator('.msg-body'));
  const sheet = m.locator('.sheet');
  await expectVisible(sheet, 'folha de ações');
  await expectVisible(sheet.getByText('Ver original', { exact: true }), '"Ver original" na folha');
  await shot(m, 'celular-folha');
  await sheet.getByText('Ver original', { exact: true }).click();
  await waitFor('original no celular', async () => (await bodyText(m, STEP3._id)).includes('adiado para amanhã') || null);
  const btn = el.locator('.msg-translated .msg-tr-btn');
  await expectVisible(btn, 'botão "Ver tradução"');
  assert((await btn.innerText()) === 'Ver tradução', `botão: ${await btn.innerText()}`);
  const box = await btn.boundingBox();
  assert(box.height >= 44, `alvo de ${box.height}px (precisa de 44)`);
  await shot(m, 'celular-original');
  await btn.click();
  await expectBody(m, STEP3._id, 'The deploy was moved to tomorrow', 'adiado');
  // O painel abre como os outros (tela cheia).
  await m.locator('.room-actions button[title="Mais"]').click();
  await m.getByText('Tradução automática', { exact: true }).last().click();
  const panel = m.locator('.panel-translate');
  await expectVisible(panel, 'painel no celular');
  const pw = await panel.evaluate((p) => p.getBoundingClientRect().width);
  assert(pw >= 412 - 1, `painel com ${pw}px no celular`);
  assert(await noHScroll(m), 'rolagem horizontal no celular');
  await shot(m, 'celular-painel');
  await m.context().close();
});

await step(12, 'Tema escuro: a linha "Traduzida do…" legível', async () => {
  const j = await open(john, { scheme: 'dark' });
  await openRoom(j, ROOMS.geral);
  const el = msgEl(j, STEP3._id);
  await el.scrollIntoViewIfNeeded();
  await expectBody(j, STEP3._id, 'The deploy was moved to tomorrow', 'adiado');
  const colors = await el.locator('.msg-translated').evaluate((l) => {
    const btn = l.querySelector('.msg-tr-btn');
    let bgEl = l;
    let bg = 'rgba(0, 0, 0, 0)';
    while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bg = getComputedStyle(bgEl).backgroundColor;
      bgEl = bgEl.parentElement;
    }
    return { text: getComputedStyle(l).color, btn: getComputedStyle(btn).color, bg };
  });
  const lum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((x) => Number(x) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const ct = contrast(colors.text, colors.bg);
  const cb = contrast(colors.btn, colors.bg);
  console.log(`     contraste no escuro: linha ${ct.toFixed(2)}, botão ${cb.toFixed(2)} (${JSON.stringify(colors)})`);
  assert(ct >= 4.5 && cb >= 4.5, `contraste baixo no escuro: linha ${ct.toFixed(2)}, botão ${cb.toFixed(2)}`);
  await shot(j, 'escuro-traduzida');
  await noOops(j);
});

// ---------- Fim ----------

for (const ctx of pages) await ctx.close().catch(() => {});
await browser.close();
await setSettings({ AutoTranslate_Enabled: false }).catch((e) => problems.push(`desligar a tradução: ${e.message}`));
if (rateBefore !== undefined && rateBefore !== false) await setSettings({ [RATE]: rateBefore }).catch(() => {});
await stopFake();
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ results, problems }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok, ${problems.length} problemas no navegador.`);
for (const x of problems.slice(0, 40)) console.log(`  ${x}`);
process.exit(results.every((r) => r.ok) && !problems.length ? 0 : 1);
