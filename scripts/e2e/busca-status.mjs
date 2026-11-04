// Busca da barra lateral, status personalizados, Ocupado e palavras destacadas de ponta a ponta (spec A §11).
// Tira print de cada passo (computador claro e escuro, celular) e sai com código 1 se algo falhar.
//
// Uso:
//   CHAT_URL=http://localhost:3101 PLAYWRIGHT_CORE=/caminho/playwright-core ADMIN_USER=admin ADMIN_PASSWORD=... \
//     node scripts/e2e/busca-status.mjs <pasta>
//
// Variáveis de ambiente:
//   CHAT_URL           endereço do chat com a web compilada. Obrigatória (localhost: as chamadas pedem contexto seguro).
//   STEPS              passos a rodar, por exemplo 1,4 (padrão: todos). O 2 e o 3 usam o que o 1 cria; o 6 usa o 5;
//                      o 7 (achados da revisão) roda sozinho.
//   PLAYWRIGHT_CORE, CHROMIUM_PATH, ADMIN_USER, ADMIN_PASSWORD   como em scripts/visual/lib.mjs.
//
// Cria (ou reaproveita) e2e.ana e e2e.bruno (Usuário) e e2e.op1 e e2e.op2 (Operação), com uma senha nova a cada
// execução; os canais #e2e-suporte, #e2e-suporte-noite e #e2e-codigo (com código de acesso), o time privado
// e2e-interno com um canal público e o time público e2e-publico com o canal e2e-publico-vendas. No fim devolve o limite de requisições e os status de fábrica (recria
// "Em reunião" e tira "Plantão").
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_URL = (process.env.CHAT_URL ?? '').replace(/\/+$/, '');
if (!CHAT_URL) {
  console.error('Defina CHAT_URL com o endereço do chat, por exemplo CHAT_URL=http://localhost:3101');
  process.exit(2);
}
process.env.BASE = CHAT_URL;
const lib = await import('../visual/lib.mjs');

const OUT = lib.outDir();
const STEPS = new Set((process.env.STEPS ?? '1,2,3,4,5,6,7').split(',').map((s) => Number(s.trim())));
const PASSWORD = `E2e-${crypto.randomBytes(6).toString('hex')}!`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API ----------

const admin = lib.client(await lib.login(lib.ADMIN_USER, lib.ADMIN_PASSWORD));
const ok = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};

const PEOPLE = {
  ana: { username: 'e2e.ana', name: 'Ana Souza', roles: ['user'] },
  bruno: { username: 'e2e.bruno', name: 'Bruno Conceição', roles: ['user'] },
  op1: { username: 'e2e.op1', name: 'Otávio Operador', roles: ['operacao'] },
  op2: { username: 'e2e.op2', name: 'Olga Operadora', roles: ['operacao'] },
};

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
  // Começa disponível, sem mensagem de status e sem palavras destacadas.
  ok('users.setStatus', await p.api.call('POST', 'users.setStatus', { status: 'online', message: '' }));
  ok('users.setPreferences', await p.api.call('POST', 'users.setPreferences', { data: { highlights: [] } }));
}

// Muitas telas ao mesmo tempo: o limite de requisições da API fica desligado durante o roteiro e volta no fim.
const RATE = 'API_Enable_Rate_Limiter';
const rateBefore = ok('settings', await admin.call('GET', 'settings')).settings.find((x) => x._id === RATE)?.value;
if (rateBefore !== false) ok('settings', await admin.call('POST', 'settings', { settings: { [RATE]: false } }));

for (const p of Object.values(PEOPLE)) await ensurePerson(p);
const { ana, bruno, op1, op2 } = PEOPLE;

// Status de fábrica: os quatro da migração, sem o "Plantão" de uma execução anterior.
const SEEDED = [
  ['Em pausa', 'away'],
  ['Em atendimento', 'busy'],
  ['Almoço', 'away'],
  ['Em reunião', 'busy'],
];
async function resetStatuses() {
  const list = ok('custom-user-status.list', await admin.call('GET', 'custom-user-status.list')).statuses;
  for (const s of list) if (s.name === 'Plantão') ok('delete Plantão', await admin.call('POST', 'custom-user-status.delete', { customUserStatusId: s._id }));
  for (const [name, statusType] of SEEDED) {
    const hit = list.find((s) => s.name === name);
    if (!hit) ok(`create ${name}`, await admin.call('POST', 'custom-user-status.create', { name, statusType }));
    else if (hit.statusType !== statusType) ok(`update ${name}`, await admin.call('POST', 'custom-user-status.update', { _id: hit._id, name, statusType }));
  }
}
await resetStatuses();

// Salas: quem entra pelo passo 1 começa fora delas.
async function channel(name, members = []) {
  const info = await admin.call('GET', 'channels.info', { roomName: name });
  let id = info.success ? info.channel._id : null;
  if (!id) id = ok(`channels.create ${name}`, await admin.call('POST', 'channels.create', { name, members })).channel._id;
  for (const p of [ana]) await admin.call('POST', 'channels.kick', { roomId: id, userId: p.id }).catch(() => {});
  for (const u of members) await admin.call('POST', 'channels.invite', { roomId: id, username: u }).catch(() => {});
  return id;
}
const ROOMS = {
  suporte: await channel('e2e-suporte', [bruno.username]),
  noite: await channel('e2e-suporte-noite'),
  codigo: await channel('e2e-codigo'),
};
ok('joinCode', await admin.call('POST', 'rooms.saveRoomSettings', { rid: ROOMS.codigo, joinCode: '2468' }));
{
  const teams = (await admin.call('GET', 'teams.listAll', { count: 200 })).teams ?? [];
  if (!teams.some((t) => t.name === 'e2e-interno')) {
    const team = ok('teams.create', await admin.call('POST', 'teams.create', { name: 'e2e-interno', type: 1 })).team;
    ok('teams.createRoom', await admin.call('POST', 'teams.createRoom', { teamId: team._id, name: 'e2e-interno-canal', type: 'c' }));
  }
  // Time público: o canal dele aparece na busca com "e2e-publico · N membros".
  if (!teams.some((t) => t.name === 'e2e-publico')) {
    const team = ok('teams.create', await admin.call('POST', 'teams.create', { name: 'e2e-publico', type: 0 })).team;
    ok('teams.createRoom', await admin.call('POST', 'teams.createRoom', { teamId: team._id, name: 'e2e-publico-vendas', type: 'c' }));
  }
}
// A conversa direta Ana–Bruno nasce no passo 1.
{
  const subs = (await ana.api.call('GET', 'subscriptions.get')).update ?? [];
  const dm = subs.find((s) => s.t === 'd' && s.name === bruno.username);
  if (dm) ok('im.delete', await admin.call('POST', 'im.delete', { roomId: dm.rid }));
}

// ---------- Navegador ----------

const chromium = await lib.loadChromium();
// Sem CHROMIUM_PATH, o Chromium completo no headless novo: o headless shell nega a permissão de notificação.
const browser = await chromium.launch({
  executablePath: lib.executablePath,
  channel: lib.executablePath ? undefined : 'chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const DESK = { viewport: { width: 1366, height: 850 } };
const PIXEL7 = { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' };

const problems = [];
const pages = [];

// Contadores de notificação e de som (oscilador do WebAudio) e uma janela "sem foco" sob comando.
function counters() {
  window.__count = { notif: 0, osc: 0 };
  window.__blurred = false;
  const N = window.Notification;
  if (N) {
    window.Notification = class extends N {
      constructor(title, opts) {
        super(title, opts);
        window.__count.notif++;
      }
    };
  }
  const AC = window.AudioContext;
  if (AC) {
    const orig = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      window.__count.osc++;
      return orig.call(this);
    };
  }
  const hasFocus = Document.prototype.hasFocus;
  Document.prototype.hasFocus = function () {
    return window.__blurred ? false : hasFocus.call(this);
  };
}

async function open(who, { phone = false, scheme = 'light', url = '/home', count = false } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PIXEL7 : DESK), colorScheme: scheme, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  if (count) {
    await ctx.grantPermissions(['notifications'], { origin: CHAT_URL });
    await ctx.addInitScript(counters);
  }
  const page = await ctx.newPage();
  const name = `${who.username}${phone ? '/celular' : ''}${scheme === 'dark' ? '/escuro' : ''}`;
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  // O push não existe em contexto anônimo (todo contexto do Playwright é um): o aviso do Chromium não é do chat.
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Push API in incognito/.test(m.text()) && problems.push(`${name} console: ${m.text()}`.slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`${name} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(CHAT_URL, '')}`);
  });
  await page.goto(`${CHAT_URL}/login`);
  await page.fill('form input >> nth=0', who.username);
  await page.fill('input[type="password"]', who.password ?? PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  if (url) await page.goto(`${CHAT_URL}${url}`);
  // Administração e Minha conta escondem a barra lateral no computador (takeover): basta a página.
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
// Print no outro tema e volta (espera as transições de cor terminarem).
async function shotScheme(page, name, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(400);
  await shot(page, name);
}

const expectVisible = async (loc, what, timeout = 8000) => {
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`não apareceu: ${what}`);
  }
};
const expectText = (scope, text, timeout) => expectVisible(scope.getByText(text, { exact: false }), `"${text}"`, timeout);
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
const noHScroll = (page) =>
  page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll('.page-body, .side-list')];
    return els.every((el) => !el || el.scrollWidth <= el.clientWidth + 1);
  });

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
    // Print de cada tela aberta, para ver o que faltou.
    for (const [i, ctx] of pages.entries()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(OUT, `falha-${n}-${i}.png`) }).catch(() => {});
    console.log(`FALHA ${n}. ${title}: ${e.message}`);
  }
}

// A busca da barra lateral: Ctrl+K e o texto digitado como alguém digitaria.
async function search(page, text) {
  await page.keyboard.press('Control+K');
  const input = page.locator('#sidebar-filter');
  await waitFor('foco na busca', async () => (await input.evaluate((el) => el === document.activeElement)) || null);
  await input.fill('');
  await page.keyboard.type(text, { delay: 15 });
  return input;
}
const people = (page) => page.locator('.spot-group[aria-labelledby="spot-people"]');
const roomsGroup = (page) => page.locator('.spot-group[aria-labelledby="spot-rooms"]');
const count = (page) => page.evaluate(() => ({ ...window.__count }));
const resetCount = (page) => page.evaluate(() => (window.__count = { notif: 0, osc: 0 }));

// Status pelo menu do usuário (rodapé da barra lateral).
async function pickStatus(page, label) {
  await page.locator('.side-foot .me-btn').click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitemradio', { name: label, exact: true }).click();
  await menu.waitFor({ state: 'detached' }).catch(() => {});
}

const ADMIN = { username: lib.ADMIN_USER, password: lib.ADMIN_PASSWORD };
const anaPage = await open(ana);
let dmPath = '';

// ---------- 1. Busca no computador ----------
await step(1, 'Busca: pessoa sem conversa, canal para entrar, código de acesso, teclado, Enter adiantado e vazio', async () => {
  const p = anaPage;
  // Pessoa pelo sobrenome, sem acento.
  await search(p, 'concei');
  const row = people(p).locator('.side-item', { hasText: 'Bruno Conceição' });
  await expectVisible(row, 'Bruno Conceição em Pessoas');
  assert((await row.innerText()).includes('@e2e.bruno'), 'a linha da pessoa sem o @usuário');
  await shot(p, 'busca-pessoa');
  await shotScheme(p, 'busca-pessoa-escuro', 'dark');
  await p.emulateMedia({ colorScheme: 'light' });
  await p.keyboard.press('Enter');
  await p.waitForURL(/\/direct\//, { timeout: 10000 });
  dmPath = new URL(p.url()).pathname;
  assert((await p.locator('#sidebar-filter').inputValue()) === '', 'a busca não foi limpa depois de abrir');
  const dmGroup = p.locator('.side-group', { has: p.locator('.side-group-title', { hasText: 'Mensagens diretas' }) });
  await expectVisible(dmGroup.locator('.side-item', { hasText: 'Bruno Conceição' }), 'a DM em Mensagens diretas');

  // Canal público: "Entrar" na linha.
  await search(p, '#e2e-sup');
  const sup = roomsGroup(p).locator('.spot-room', { hasText: 'e2e-suporte' }).filter({ hasNotText: 'noite' });
  await expectVisible(sup, '#e2e-suporte em Canais e times');
  await expectVisible(sup.getByRole('button', { name: 'Entrar em #e2e-suporte' }), 'botão Entrar');
  await shot(p, 'busca-canal-entrar');
  await sup.getByRole('button', { name: 'Entrar em #e2e-suporte' }).click();
  await p.waitForURL(new RegExp(`/channel/${ROOMS.suporte}`), { timeout: 10000 });
  const composer = p.locator('.composer textarea');
  await expectVisible(composer, 'compositor no canal');
  assert(await composer.isEnabled(), 'compositor desligado depois de entrar');

  // Código de acesso: a chave no lugar de Entrar; Enter abre a prévia.
  await search(p, 'e2e-codigo');
  const cod = roomsGroup(p).locator('.spot-room', { hasText: 'e2e-codigo' });
  await expectVisible(cod.locator('.spot-code'), 'ícone do código de acesso');
  assert(!(await cod.locator('.side-join').count()), 'Entrar apareceu num canal com código');
  await shot(p, 'busca-canal-codigo');
  await p.keyboard.press('Enter');
  await expectText(p, 'Você está vendo uma prévia de #e2e-codigo');
  await expectVisible(p.getByRole('button', { name: 'Entrar no canal' }), '"Entrar no canal" na prévia');
  await shot(p, 'previa-codigo');

  // O canal do time privado nunca aparece.
  await search(p, 'e2e-interno');
  await expectText(p, 'Nada encontrado para “e2e-interno”');
  assert(!(await p.locator('.spot-room', { hasText: 'e2e-interno' }).count()), 'canal do time privado na busca');

  // Teclado: conversas da lista, depois Pessoas, depois Canais; para cima volta à busca; Esc limpa.
  await search(p, 'e2e');
  await expectVisible(roomsGroup(p).locator('.side-item'), 'Canais e times');
  await expectVisible(people(p).locator('.side-item'), 'Pessoas');
  const order = await p.locator('.side-list .side-item').evaluateAll((els) =>
    els.map((el) => (el.closest('.spot-group') ? (el.closest('[aria-labelledby="spot-people"]') ? 'pessoa' : 'canal') : 'local')),
  );
  assert(order[0] === 'local' && order.includes('pessoa') && order.includes('canal'), `ordem das linhas: ${order.join(',')}`);
  assert(order.indexOf('canal') > order.lastIndexOf('pessoa') && order.indexOf('pessoa') > order.lastIndexOf('local'), `ordem das linhas: ${order.join(',')}`);
  await p.keyboard.press('ArrowDown');
  for (let i = 0; i < order.length; i++) {
    const at = await p.evaluate(() => [...document.querySelectorAll('.side-list .side-item')].indexOf(document.activeElement));
    assert(at === i, `seta para baixo: foco na linha ${at}, esperado ${i}`);
    if (i < order.length - 1) await p.keyboard.press('ArrowDown');
  }
  await shot(p, 'busca-teclado');
  for (let i = order.length - 1; i > 0; i--) await p.keyboard.press('ArrowUp');
  await p.keyboard.press('ArrowUp');
  assert(await p.locator('#sidebar-filter').evaluate((el) => el === document.activeElement), 'seta para cima na primeira linha não voltou à busca');
  await p.keyboard.press('Escape');
  assert((await p.locator('#sidebar-filter').inputValue()) === '', 'Esc não limpou a busca');

  // Enter antes da resposta: abre o primeiro resultado quando ela chega.
  await p.route('**/api/v1/spotlight**', async (route) => {
    await sleep(1200);
    await route.continue();
  });
  await search(p, '#e2e-cod');
  await p.keyboard.press('Enter');
  await p.waitForURL(new RegExp(`/channel/${ROOMS.codigo}`), { timeout: 10000 });
  await p.unroute('**/api/v1/spotlight**');

  // Nada encontrado.
  await search(p, 'zzzz');
  await expectText(p, 'Nada encontrado para “zzzz”');
  await expectVisible(p.getByRole('button', { name: 'Abrir diretório' }), '"Abrir diretório"');
  assert(await noHScroll(p), 'rolagem horizontal na busca');
  await shot(p, 'busca-vazia');
  await p.keyboard.press('Escape');
  await noOops(p);
});

// ---------- 2. Operação ----------
await step(2, 'Operação: "Sem conversa direta" e Enter só explica', async () => {
  const p = await open(op1);
  await search(p, 'op2');
  const row = people(p).locator('.side-item', { hasText: 'Olga Operadora' });
  await expectVisible(row, 'Olga em Pessoas');
  await expectVisible(row.locator('.pill.blocked', { hasText: 'Sem conversa direta' }), 'pílula "Sem conversa direta"');
  // Revisão: no computador a pílula ficava só com o ícone; agora o texto aparece inteiro, e o nome também.
  const pill = await row.locator('.pill.blocked').evaluate((el) => ({ w: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth + 1 }));
  assert(pill.w > 100 && !pill.cut, `pílula sem o texto inteiro: ${JSON.stringify(pill)}`);
  assert(await row.locator('.side-name').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'nome cortado na linha bloqueada');
  assert((await row.getAttribute('title'))?.includes('@e2e.op2'), 'o @usuário saiu também do title');
  await shot(p, 'operacao-sem-conversa');
  await shotScheme(p, 'operacao-sem-conversa-escuro', 'dark');
  await p.emulateMedia({ colorScheme: 'light' });
  const before = p.url();
  await p.keyboard.press('Enter');
  await expectVisible(p.locator('.toast'), 'aviso da regra');
  await sleep(500);
  assert(p.url() === before, `navegou para ${p.url()}`);
  const subs = (await op1.api.call('GET', 'subscriptions.get')).update ?? [];
  assert(!subs.some((s) => s.t === 'd' && s.name === op2.username), 'a conversa direta foi criada');
  await shot(p, 'operacao-aviso');
  await p.context().close();
});

// ---------- 3. Celular ----------
await step(3, 'Celular: Entrar com 44 px pela lista de conversas, e o teclado fecha', async () => {
  const p = await open(ana, { phone: true });
  await expectVisible(p.locator('.sidebar[data-mode="list"]'), 'lista de conversas');
  const input = p.locator('#sidebar-filter');
  await input.tap();
  await input.fill('#e2e-sup');
  const noite = roomsGroup(p).locator('.spot-room', { hasText: 'e2e-suporte-noite' });
  await expectVisible(noite, '#e2e-suporte-noite');
  const join = noite.getByRole('button', { name: 'Entrar em #e2e-suporte-noite' });
  const box = await join.boundingBox();
  assert(box && box.height >= 44, `Entrar com ${box?.height}px de altura`);
  assert(await noHScroll(p), 'rolagem horizontal na busca do celular');
  await shot(p, 'celular-busca');
  await shotScheme(p, 'celular-busca-escuro', 'dark');
  await p.emulateMedia({ colorScheme: 'light' });
  await join.tap();
  await p.waitForURL(new RegExp(`/channel/${ROOMS.noite}`), { timeout: 10000 });
  await expectVisible(p.locator('.composer textarea'), 'compositor');
  assert(!(await p.evaluate(() => document.activeElement?.id === 'sidebar-filter')), 'a busca continuou com o foco');
  await shot(p, 'celular-entrou');
  await p.context().close();
});

// ---------- 4. Status personalizados ----------
const adminPage = await open(ADMIN, { url: '/admin/user-status' });
const brunoPage = await open(bruno, { scheme: 'dark', count: true });
const statusRow = (name) => adminPage.locator('table.user-status-table tbody tr', { has: adminPage.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

await step(4, 'Status personalizados: criar, escolher, ver nos outros, mudar o tipo, excluir e auditoria', async () => {
  const a = adminPage;
  for (const [name] of SEEDED) await expectVisible(statusRow(name), `status "${name}"`);
  await shot(a, 'admin-status-lista');
  await a.getByRole('button', { name: 'Novo status' }).click();
  const dlg = a.getByRole('dialog');
  await dlg.getByLabel('Nome').fill('Plantão');
  await dlg.locator('.status-choice', { hasText: 'Ocupado' }).click();
  await shot(a, 'admin-status-novo');
  await dlg.getByRole('button', { name: 'Criar status' }).click();
  await expectVisible(a.locator('.toast', { hasText: 'Status criado.' }), 'aviso "Status criado."');
  await expectVisible(statusRow('Plantão'), 'linha Plantão');

  // Bruno: "Personalizados" no menu, escolhe "Em reunião".
  const b = brunoPage;
  await b.locator('.side-foot .me-btn').click();
  const menu = b.getByRole('menu');
  await expectVisible(menu.locator('.menu-label', { hasText: 'Personalizados' }), '"Personalizados" no menu');
  await expectVisible(menu.getByRole('menuitemradio', { name: 'Plantão' }), '"Plantão" no menu');
  await shot(b, 'bruno-menu-personalizados');
  await menu.getByRole('menuitemradio', { name: 'Em reunião' }).click();
  await menu.waitFor({ state: 'detached' }).catch(() => {});
  await waitFor('rodapé "Em reunião"', async () => (await b.locator('.side-foot .me-status-text').innerText()) === 'Em reunião' || null);
  await expectVisible(b.locator('.side-foot .me-silenced'), 'sino cortado no rodapé');
  await b.locator('.side-foot .me-btn').click();
  await expectVisible(b.getByRole('menu').locator('.menu-note', { hasText: 'Notificações silenciadas enquanto você estiver ocupado.' }), 'aviso de silêncio no menu');
  assert(await b.getByRole('menuitemradio', { name: 'Em reunião' }).getAttribute('aria-checked') === 'true', '"Em reunião" sem a marca');
  assert(await b.getByRole('menuitemradio', { name: 'Ocupado', exact: true }).getAttribute('aria-checked') === 'false', '"Ocupado" marcado junto com o personalizado');
  await shot(b, 'bruno-menu-silenciado');
  await shotScheme(b, 'bruno-menu-silenciado-claro', 'light');
  await b.emulateMedia({ colorScheme: 'dark' });
  await b.keyboard.press('Escape');

  // Ana vê "Em reunião" no cabeçalho da DM, no cartão e na dica do avatar.
  ok('mensagem do Bruno', await bruno.api.call('POST', 'chat.sendMessage', { message: { rid: dmPath.split('/').pop(), msg: 'Oi, Ana! Estou numa reunião.' } }));
  const p = anaPage;
  await p.goto(`${CHAT_URL}${dmPath}`);
  await waitFor('cabeçalho "Em reunião"', async () => (await p.locator('.room-header .room-topic').innerText()).startsWith('Em reunião') || null);
  await p.locator('.msg-name', { hasText: 'Bruno Conceição' }).first().click();
  await expectVisible(p.locator('.user-card-status', { hasText: 'Em reunião' }), 'cartão com "Em reunião"');
  await expectVisible(p.locator('.sidebar .status-dot[title="Em reunião"]'), 'dica do avatar "Em reunião"');
  await shot(p, 'ana-ve-em-reuniao');
  await p.keyboard.press('Escape');

  // Muda para Ausente: o ponto fica amarelo e o sino cortado some.
  await statusRow('Em reunião').getByRole('button', { name: /Ações de/ }).click();
  await a.getByRole('menu').getByRole('menuitem', { name: 'Editar' }).click();
  const ed = a.getByRole('dialog');
  await ed.locator('.status-choice', { hasText: 'Ausente' }).click();
  await expectText(ed, '1 pessoa está com este status agora e muda junto.');
  await shot(a, 'admin-status-editar');
  await ed.getByRole('button', { name: 'Salvar' }).click();
  await expectVisible(a.locator('.toast', { hasText: 'Status salvo.' }), 'aviso "Status salvo."');
  await expectVisible(b.locator('.side-foot .status-dot.away'), 'ponto ausente no rodapé do Bruno');
  await waitFor('sino cortado some', async () => (await b.locator('.side-foot .me-silenced').count()) === 0 || null);
  await shot(b, 'bruno-ausente-em-reuniao');

  // Exclui: o Bruno fica "Ausente".
  await statusRow('Em reunião').getByRole('button', { name: /Ações de/ }).click();
  await a.getByRole('menu').getByRole('menuitem', { name: 'Excluir' }).click();
  const cf = a.getByRole('alertdialog').or(a.getByRole('dialog'));
  await expectText(cf, '1 pessoa está com ele agora e passa a aparecer como Ausente.');
  await shot(a, 'admin-status-excluir');
  await cf.getByRole('button', { name: 'Excluir' }).click();
  await expectVisible(a.locator('.toast', { hasText: 'Status excluído.' }), 'aviso "Status excluído."');
  await waitFor('rodapé "Ausente"', async () => (await b.locator('.side-foot .me-status-text').innerText()) === 'Ausente' || null);

  // Auditoria: as três ações.
  await a.goto(`${CHAT_URL}/admin/audit`);
  await a.getByRole('tab', { name: 'Registro de ações' }).or(a.getByRole('radio', { name: 'Registro de ações' })).first().click();
  await a.getByPlaceholder('Ação (ex.: user.*, settings.*, auth.login)').fill('user-status.*');
  for (const act of ['user-status.created', 'user-status.updated', 'user-status.deleted']) await expectVisible(a.locator('code.audit-action', { hasText: act }), act);
  await shot(a, 'auditoria-status');

  // Celular escuro: a tabela empilhada.
  const m = await open(ADMIN, { phone: true, scheme: 'dark', url: '/admin/user-status' });
  await expectVisible(m.locator('table.user-status-table'), 'tabela no celular');
  assert(await noHScroll(m), 'rolagem horizontal na tabela do celular');
  await shot(m, 'celular-admin-status');
  await m.getByRole('button', { name: 'Novo status' }).click();
  await expectVisible(m.getByRole('dialog').locator('.status-choice'), 'escolhas do tipo');
  await shot(m, 'celular-admin-status-novo');
  await m.context().close();
});

// ---------- 5. Ocupado silencia ----------
await step(5, 'Ocupado: sem notificação e sem som; disponível volta; chamada toca mesmo ocupado', async () => {
  const b = brunoPage;
  await b.goto(`${CHAT_URL}/home`);
  await b.waitForSelector('.sidebar');
  await pickStatus(b, 'Ocupado');
  await waitFor('Bruno ocupado', async () => (await bruno.api.call('GET', 'users.getStatus')).status === 'busy' || null);
  await b.evaluate(() => (window.__blurred = true));
  await resetCount(b);
  const rid = dmPath.split('/').pop();
  for (const t of ['Primeira mensagem enquanto você está ocupado', 'Segunda mensagem']) ok('DM', await ana.api.call('POST', 'chat.sendMessage', { message: { rid, msg: t } }));
  const dmRow = b.locator('.side-item', { hasText: 'Ana Souza' });
  await waitFor('contador 2 na DM', async () => (await dmRow.locator('.badge').innerText().catch(() => '')) === '2' || null);
  await sleep(800);
  let c = await count(b);
  assert(c.notif === 0 && c.osc === 0, `ocupado: ${c.notif} notificações e ${c.osc} sons`);
  assert(!(await b.locator('.toast').count()), 'aviso na tela com o Bruno ocupado');
  await shot(b, 'ocupado-contador-sem-aviso');

  await pickStatus(b, 'Disponível');
  await waitFor('Bruno disponível', async () => (await bruno.api.call('GET', 'users.getStatus')).status === 'online' || null);
  await resetCount(b);
  ok('DM', await ana.api.call('POST', 'chat.sendMessage', { message: { rid, msg: 'Agora você vai ser avisado' } }));
  c = await waitFor('uma notificação e um som', async () => {
    const x = await count(b);
    return x.notif >= 1 && x.osc >= 1 ? x : null;
  });
  await sleep(500);
  c = await count(b);
  assert(c.notif === 1 && c.osc === 1, `disponível: ${c.notif} notificações e ${c.osc} sons`);

  // Chamada com o Bruno ocupado: toca.
  await pickStatus(b, 'Ocupado');
  await waitFor('Bruno ocupado de novo', async () => (await bruno.api.call('GET', 'users.getStatus')).status === 'busy' || null);
  await b.evaluate(() => (window.__blurred = false));
  await resetCount(b);
  const p = anaPage;
  await p.goto(`${CHAT_URL}${dmPath}`);
  await p.locator('.room-actions button[title="Chamada de voz"]').click();
  await expectVisible(b.locator('.call-incoming'), 'chamada chegando no Bruno', 15000);
  await waitFor('toque da chamada', async () => (await count(b)).osc > 0 || null);
  await shot(b, 'ocupado-chamada-toca');
  await b.locator('.call-incoming button[title="Recusar"]').click();
  await p.locator('.call-window').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
});

// ---------- 6. Palavras destacadas ----------
await step(6, 'Palavras destacadas: chips, marca na mensagem, selo de menção e notificação; celular', async () => {
  const b = brunoPage;
  await pickStatus(b, 'Disponível');
  await b.goto(`${CHAT_URL}/account/preferences`);
  const card = b.locator('.card', { has: b.locator('h2', { hasText: 'Palavras destacadas' }) });
  await expectVisible(card, 'cartão Palavras destacadas');
  await expectText(card, 'Nenhuma palavra ainda.');
  const input = card.locator('#account-highlights');
  await input.fill('plantão');
  await input.press('Enter');
  await expectVisible(card.locator('.chip', { hasText: 'plantão' }), 'chip "plantão"');
  await input.fill('Plantao');
  await input.press('Enter');
  await sleep(600);
  assert((await card.locator('.chip').count()) === 1, `${await card.locator('.chip').count()} chips depois de repetir sem acento`);
  // Vírgula também fecha a palavra; uma letra só é recusada no campo.
  await input.fill('x,');
  await expectVisible(card.locator('.field-error'), 'erro da palavra curta');
  await input.fill('');
  const prefs = (await bruno.api.call('GET', 'me')).preferences?.highlights;
  assert(JSON.stringify(prefs) === JSON.stringify(['plantão']), `palavras salvas: ${JSON.stringify(prefs)}`);
  await shot(b, 'palavras-destacadas');
  await shotScheme(b, 'palavras-destacadas-claro', 'light');
  await b.emulateMedia({ colorScheme: 'dark' });

  await b.goto(`${CHAT_URL}/home`);
  await b.waitForSelector('.sidebar');
  await b.evaluate(() => (window.__blurred = true));
  await resetCount(b);
  const p = anaPage;
  await p.goto(`${CHAT_URL}/channel/${ROOMS.suporte}`);
  const composer = p.locator('.composer textarea');
  await composer.fill('Quem pega o PLANTAO hoje?');
  await composer.press('Enter');
  const row = b.locator('.side-item', { hasText: 'e2e-suporte' }).filter({ hasNotText: 'noite' });
  await expectVisible(row.locator('.badge.mention'), 'selo de menção em #e2e-suporte');
  await waitFor('uma notificação', async () => (await count(b)).notif === 1 || null);
  await b.evaluate(() => (window.__blurred = false));
  await row.click();
  const msg = b.locator('.msg.mentioned', { hasText: 'Quem pega o PLANTAO hoje?' }).last();
  await expectVisible(msg, 'mensagem marcada');
  assert((await msg.locator('mark.hl-word').innerText()) === 'PLANTAO', 'a palavra não está em mark.hl-word');
  await shot(b, 'destaque-mensagem-escuro');
  await shotScheme(b, 'destaque-mensagem-claro', 'light');
  // Quem escreveu não vê a própria mensagem marcada.
  assert(!(await p.locator('.msg.mentioned', { hasText: 'Quem pega o PLANTAO hoje?' }).count()), 'a mensagem da Ana ficou marcada para ela');

  // Celular: o cartão aparece e o X do chip funciona no toque.
  const m = await open(bruno, { phone: true, url: '/account/preferences' });
  const mc = m.locator('.card', { has: m.locator('h2', { hasText: 'Palavras destacadas' }) });
  await expectVisible(mc, 'cartão no celular');
  await mc.scrollIntoViewIfNeeded();
  await expectVisible(mc.locator('.chip', { hasText: 'plantão' }), 'chip no celular');
  assert(await noHScroll(m), 'rolagem horizontal nas preferências do celular');
  await shot(m, 'celular-palavras');
  await mc.getByRole('button', { name: 'Remover “plantão”' }).tap();
  await expectText(mc, 'Nenhuma palavra ainda.');
  await waitFor('lista vazia no servidor', async () => {
    const r = await bruno.api.call('GET', 'me');
    return (r.preferences?.highlights ?? ['?']).length === 0 || null;
  });
  await shot(m, 'celular-palavras-vazia');
  await m.context().close();
});

// ---------- 7. Achados da revisão ----------
// Onde começa o texto de um título de grupo (depois da seta, nos que recolhem).
const titleTextLeft = (loc) =>
  loc.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.textContent.trim()) break;
    const r = document.createRange();
    r.selectNodeContents(n);
    return r.getBoundingClientRect().left;
  });

await step(7, 'Revisão: detalhe inteiro, títulos alinhados, busca curta, fim da busca, diretório, menu longo, Membros e celular', async () => {
  const p = anaPage;
  await p.goto(`${CHAT_URL}/home`);
  await p.waitForSelector('.sidebar');
  ok('Ana em #e2e-suporte-noite', await ana.api.call('POST', 'channels.join', { roomId: ROOMS.noite }));

  // Canais para entrar: o time e os membros aparecem inteiros (antes: "c…", "Time · 1 m…").
  await search(p, 'e2e-publico');
  await expectVisible(roomsGroup(p).locator('.spot-room', { hasText: 'e2e-publico-vendas' }), 'canal do time público');
  await expectText(roomsGroup(p), 'Canais e times para entrar');
  const hints = await roomsGroup(p)
    .locator('.side-hint')
    .evaluateAll((els) => els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1, w: Math.round(el.getBoundingClientRect().width) })));
  assert(hints.length >= 2 && hints.every((h) => !h.cut && h.w > 40), `detalhe cortado: ${JSON.stringify(hints)}`);
  assert(hints.some((h) => h.text.startsWith('e2e-publico · ')) && hints.some((h) => h.text.startsWith('Time · ')), `sem o time: ${JSON.stringify(hints)}`);
  await shot(p, 'revisao-canais-para-entrar');
  await shotScheme(p, 'revisao-canais-para-entrar-escuro', 'dark');
  await p.emulateMedia({ colorScheme: 'light' });

  // Títulos fixos (Pessoas, Canais e times para entrar) na coluna dos que recolhem.
  await search(p, 'e2e');
  await expectVisible(people(p), 'Pessoas');
  const local = await titleTextLeft(p.locator('.side-group:not(.spot-group) .side-group-title').first());
  const fixed = await titleTextLeft(people(p).locator('.side-group-title'));
  assert(Math.abs(local - fixed) <= 1, `títulos desalinhados: ${local} e ${fixed}`);
  await shot(p, 'revisao-titulos');

  // Curta demais: a dica no lugar de "Nada encontrado".
  for (const [q, hint] of [
    ['a', 'Digite pelo menos 2 letras para buscar pessoas e canais.'],
    ['@', 'Digite um nome depois do @ para buscar pessoas.'],
    ['#z', 'Digite pelo menos 2 letras para buscar canais e times.'],
  ]) {
    await search(p, q);
    await expectText(p.locator('.side-list'), hint);
    assert(!(await p.getByText('Nada encontrado').count()), `"Nada encontrado" com “${q}”`);
    await shot(p, `revisao-busca-curta-${q === 'a' ? 'letra' : q === '@' ? 'arroba' : 'cerquilha'}`);
  }

  // Conversa da lista aberta pela busca: a busca termina, como no Enter.
  await search(p, 'e2e-suporte-noite');
  await p.locator('.side-group:not(.spot-group) a.side-item', { hasText: 'e2e-suporte-noite' }).click();
  await p.waitForURL(new RegExp(`/channel/${ROOMS.noite}`), { timeout: 10000 });
  assert((await p.locator('#sidebar-filter').inputValue()) === '', 'a busca continuou depois de abrir uma conversa da lista');

  // "Abrir diretório" leva o texto; com @, na aba Pessoas.
  await search(p, 'zzzz');
  await p.getByRole('button', { name: 'Abrir diretório' }).click();
  await p.waitForURL(/\/directory\?q=zzzz$/, { timeout: 10000 });
  await waitFor('texto no diretório', async () => (await p.locator('.directory-search input, input.directory-search').first().inputValue()) === 'zzzz' || null);
  assert((await p.locator('#sidebar-filter').inputValue()) === '', 'a busca da barra lateral continuou');
  await shot(p, 'revisao-diretorio-com-texto');
  await search(p, '@zzzz');
  await p.getByRole('button', { name: 'Abrir diretório' }).click();
  await p.waitForURL(/\/directory\/users\?q=zzzz$/, { timeout: 10000 });
  await waitFor('texto em Pessoas', async () => (await p.locator('.directory-search input, input.directory-search').first().inputValue()) === 'zzzz' || null);

  // Menu com muitos status: os personalizados ficam atrás de "Personalizados"; Sair à vista; o escolhido marcado.
  const extra = [];
  try {
    for (let i = 1; i <= 14; i++)
      extra.push(ok('create', await admin.call('POST', 'custom-user-status.create', { name: `E2E status ${String(i).padStart(2, '0')}`, statusType: ['online', 'away', 'busy'][i % 3] })).customUserStatus._id);
    const ghost = ok('create', await admin.call('POST', 'custom-user-status.create', { name: 'E2E fora do ar', statusType: 'offline' })).customUserStatus._id;
    extra.push(ghost);
    const b = brunoPage;
    await b.emulateMedia({ colorScheme: 'dark' });
    await b.goto(`${CHAT_URL}/home`);
    await b.waitForSelector('.sidebar');
    ok('status 03', await bruno.api.call('POST', 'users.setStatus', { statusId: extra[2], message: '' }));
    await waitFor('rodapé "E2E status 03"', async () => (await b.locator('.side-foot .me-status-text').innerText()) === 'E2E status 03' || null);
    // Fechar e reabrir antes de a saída terminar (clique duplo no gatilho): o menu aparecia invisível.
    await b.locator('.side-foot .me-btn').click();
    await b.locator('.side-foot .me-btn').dblclick();
    await expectVisible(b.getByRole('menu'), 'menu reaberto pelo clique duplo', 3000);
    await b.keyboard.press('Escape');
    await sleep(200);
    await b.locator('.side-foot .me-btn').click();
    const menu = b.locator('.menu.user-menu');
    const disc = menu.locator('.menu-disclosure');
    await expectVisible(disc, '"Personalizados" recolhido');
    assert((await disc.getAttribute('aria-expanded')) === 'false', 'grupo aberto de início');
    assert((await menu.getByRole('menuitemradio', { name: 'E2E status 03' }).getAttribute('aria-checked')) === 'true', 'o escolhido sumiu com o grupo fechado');
    assert(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'o menu ainda precisa rolar com o grupo fechado');
    await expectVisible(menu.getByRole('menuitem', { name: 'Sair' }), 'Sair à vista');
    await shot(b, 'revisao-menu-muitos-escuro');
    await disc.click();
    await expectVisible(menu.getByRole('menuitemradio', { name: 'E2E status 14' }), 'lista aberta');
    await shot(b, 'revisao-menu-muitos-aberto-escuro');
    await b.keyboard.press('Escape');
    // O painel sai em 80 ms; reaberto antes disso, é o mesmo (com o grupo ainda aberto).
    await sleep(200);

    // Ocupado: o aviso logo abaixo dos status de base.
    await pickStatus(b, 'Ocupado');
    await sleep(200);
    await b.locator('.side-foot .me-btn').click();
    assert((await menu.locator('.menu-disclosure').getAttribute('aria-expanded')) === 'false', 'o grupo voltou aberto');
    const noteAfterBase = await menu.evaluate((el) => {
      const inv = [...el.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === 'Invisível');
      return !!inv?.nextElementSibling?.classList.contains('menu-note');
    });
    assert(noteAfterBase, 'o aviso de silêncio não está logo abaixo de Invisível');
    await shot(b, 'revisao-menu-ocupado-escuro');
    await shotScheme(b, 'revisao-menu-ocupado-claro', 'light');
    await b.keyboard.press('Escape');
    await sleep(200);

    // Celular ocupado: o sino cortado na aba Você e o aviso logo abaixo de Invisível na folha.
    const m = await open(bruno, { phone: true });
    await expectVisible(m.locator('.tabbar .tab-silenced'), 'sino cortado na aba Você');
    await shot(m, 'revisao-celular-ocupado');
    await m.locator('.tabbar .me-btn').tap();
    await expectVisible(m.locator('.menu .menu-note', { hasText: 'Notificações silenciadas' }), 'aviso na folha');
    await expectVisible(m.locator('.menu .menu-disclosure'), '"Personalizados" na folha');
    await shot(m, 'revisao-celular-folha-ocupado');
    await m.context().close();

    // Invisível personalizado: editar o perfil não apaga a escolha nas abas abertas.
    await pickStatus(b, 'Disponível');
    ok('fora do ar', await bruno.api.call('POST', 'users.setStatus', { statusId: ghost, message: '' }));
    await waitFor('rodapé "E2E fora do ar"', async () => (await b.locator('.side-foot .me-status-text').innerText()) === 'E2E fora do ar' || null);
    ok('bio', await bruno.api.call('POST', 'users.updateOwnBasicInfo', { data: { bio: `Bio ${Date.now()}` } }));
    await sleep(1000);
    assert((await b.locator('.side-foot .me-status-text').innerText()) === 'E2E fora do ar', 'o rodapé perdeu o personalizado depois de editar o perfil');
    await b.locator('.side-foot .me-btn').click();
    assert((await menu.getByRole('menuitemradio', { name: 'E2E fora do ar' }).getAttribute('aria-checked')) === 'true', 'o menu perdeu a marca do personalizado');
    assert((await menu.getByRole('menuitemradio', { name: 'Invisível', exact: true }).getAttribute('aria-checked')) === 'false', '"Invisível" marcado no lugar do personalizado');
    await b.keyboard.press('Escape');
  } finally {
    for (const id of extra) await admin.call('POST', 'custom-user-status.delete', { customUserStatusId: id }).catch(() => {});
  }

  // Membros: o personalizado continua à vista com a mensagem ("Em atendimento · …").
  const atendimento = ok('list', await admin.call('GET', 'custom-user-status.list')).statuses.find((x) => x.name === 'Em atendimento');
  ok('em atendimento', await bruno.api.call('POST', 'users.setStatus', { statusId: atendimento._id, message: 'até as 15h com o cliente' }));
  await p.goto(`${CHAT_URL}/channel/${ROOMS.suporte}`);
  await p.locator('.room-actions button[title="Membros"]').click();
  const member = p.locator('.member', { hasText: 'Bruno Conceição' });
  await expectVisible(member, 'Bruno em Membros');
  await waitFor('linha "Em atendimento · …"', async () => (await member.locator('.member-sub').innerText()).includes('Em atendimento · até as 15h com o cliente') || null);
  await shot(p, 'revisao-membros-personalizado');
  ok('volta', await bruno.api.call('POST', 'users.setStatus', { status: 'online', message: '' }));

  // Administração › Status do usuário no celular: o nome é o título do cartão e o ⋯ fica no canto.
  const a = await open(ADMIN, { phone: true, url: '/admin/user-status' });
  const first = a.locator('table.user-status-table tbody tr').first();
  await expectVisible(first, 'cartão no celular');
  const card = await first.evaluate((tr) => {
    const actions = tr.querySelector('td.actions-col');
    const name = tr.querySelector('td');
    return {
      corner: getComputedStyle(actions).position === 'absolute' && actions.getBoundingClientRect().top - tr.getBoundingClientRect().top < 24,
      label: getComputedStyle(name, '::before').content,
    };
  });
  assert(card.corner, 'o ⋯ não está no canto do cartão');
  assert(card.label === 'none' || card.label === 'normal' || card.label === '""', `o nome ainda tem rótulo: ${card.label}`);
  assert(await noHScroll(a), 'rolagem horizontal na tabela do celular');
  await shot(a, 'revisao-celular-admin-status');
  await a.context().close();
  await noOops(p);
});

// ---------- Fim ----------

for (const ctx of pages) await ctx.close().catch(() => {});
await browser.close();
await resetStatuses().catch((e) => problems.push(`status de fábrica: ${e.message}`));
for (const p of [ana, bruno]) await p.api.call('POST', 'users.setStatus', { status: 'online', message: '' }).catch(() => {});
if (rateBefore !== undefined && rateBefore !== false) ok('settings', await admin.call('POST', 'settings', { settings: { [RATE]: rateBefore } }));
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ results, problems }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok, ${problems.length} problemas no navegador.`);
for (const x of problems.slice(0, 40)) console.log(`  ${x}`);
process.exit(results.every((r) => r.ok) && !problems.length ? 0 : 1);
