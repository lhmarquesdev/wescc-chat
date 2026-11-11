// Criptografia de ponta a ponta no navegador (spec E §10): conversa direta, grupo privado, troca de chave, quem chega
// depois da troca, quem sai e volta (só lê dali para frente), redefinir a senha, a regra da Operação e o celular. Tira
// print de cada passo (computador claro e escuro, celular) e sai com código 1 se algo falhar.
//
// Uso:
//   CHAT_URL=http://localhost:3105 PLAYWRIGHT_CORE=/caminho/playwright ADMIN_USER=admin ADMIN_PASSWORD=... \
//     DATABASE_URL=postgres://... node scripts/e2e/criptografia.mjs <pasta>
//
// Variáveis de ambiente:
//   CHAT_URL       endereço do chat com a web compilada. Obrigatória. Em localhost o navegador tem Web Crypto (contexto
//                  seguro); em outro endereço precisa ser https.
//   DATABASE_URL   banco do chat, para conferir com psql que o servidor guarda só o conteúdo cifrado e que a conversa
//                  bloqueada pela regra da Operação não tem chave. Sem ela, essas conferências são puladas.
//   STEPS          passos a rodar, por exemplo 1,2,3 (padrão: todos). Cada passo usa o que os anteriores criaram.
//   PLAYWRIGHT_CORE, CHROMIUM_PATH, ADMIN_USER, ADMIN_PASSWORD   como em scripts/visual/lib.mjs.
//
// Cria (ou reaproveita) e2e.cripto.ana, .bruno, .carla e .davi (Usuário) e e2e.cripto.op1 e .op2 (Operação), com uma
// senha nova a cada execução; redefine a criptografia de todos antes de começar e apaga as conversas da execução
// anterior. Liga E2E_Enable e desliga o limite de requisições durante o roteiro; no fim devolve os dois.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHAT_URL = (process.env.CHAT_URL ?? '').replace(/\/+$/, '');
if (!CHAT_URL) {
  console.error('Defina CHAT_URL com o endereço do chat, por exemplo CHAT_URL=http://localhost:3105');
  process.exit(2);
}
process.env.BASE = CHAT_URL;
const lib = await import('../visual/lib.mjs');
const DATABASE_URL = process.env.DATABASE_URL ?? '';

const OUT = lib.outDir();
const STEPS = new Set((process.env.STEPS ?? '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17').split(',').map((s) => Number(s.trim())));
const PASSWORD = `Cr1pto-${crypto.randomBytes(6).toString('hex')}!`;
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Textos da tela (os mesmos de web/src/lib/e2e/client.ts e da spec §6.5).
const T = {
  none: 'Para ler e escrever aqui, configure a criptografia.',
  locked: 'Digite a senha da criptografia para ler e escrever nesta conversa.',
  ready: 'Esta conversa é criptografada de ponta a ponta.',
  waiting: 'Esperando a chave desta conversa.',
  waitingNew: 'Esperando a chave nova desta conversa.',
  returned: 'Você voltou para esta conversa: as mensagens criptografadas de antes da sua volta não podem ser lidas.',
  wrong: 'Senha incorreta.',
  oldKey: 'Mensagem criptografada com uma chave que você não tem.',
  lockedMsg: 'Mensagem criptografada. Desbloqueie para ler.',
  noneMsg: 'Mensagem criptografada. Configure a criptografia para ler.',
  waitingMsg: 'Mensagem criptografada. Esperando a chave.',
  on: 'ligou a criptografia de ponta a ponta',
  noRecovery: 'O chat não mostra de novo nem recupera esta senha.',
  resetByAdmin: 'Um administrador redefiniu sua criptografia.',
};

// ---------- API ----------

const admin = lib.client(await lib.login(lib.ADMIN_USER, lib.ADMIN_PASSWORD));
const ok = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};
const sql = (q) => (DATABASE_URL ? execFileSync('psql', [DATABASE_URL, '-tAc', q], { encoding: 'utf8' }).trim() : null);

const PEOPLE = {
  ana: { username: 'e2e.cripto.ana', name: 'Ana Ribeiro', roles: ['user'] },
  bruno: { username: 'e2e.cripto.bruno', name: 'Bruno Tavares', roles: ['user'] },
  carla: { username: 'e2e.cripto.carla', name: 'Carla Menezes', roles: ['user'] },
  davi: { username: 'e2e.cripto.davi', name: 'Davi Lacerda', roles: ['user'] },
  // A conversa direta dos dois nasce antes de virarem Operação: depois disso ela fica bloqueada.
  op1: { username: 'e2e.cripto.op1', name: 'Otto Operador', roles: ['user'] },
  op2: { username: 'e2e.cripto.op2', name: 'Olívia Operadora', roles: ['user'] },
};

async function ensurePerson(p) {
  const info = await admin.call('GET', 'users.info', { username: p.username });
  if (info.success && info.user?._id) {
    p.id = info.user._id;
    ok(`users.update ${p.username}`, await admin.call('POST', 'users.update', { userId: p.id, data: { password: PASSWORD, roles: p.roles, name: p.name, active: true } }));
  } else {
    ok(
      `users.create ${p.username}`,
      await admin.call('POST', 'users.create', { username: p.username, name: p.name, email: `${p.username}@example.com`, password: PASSWORD, roles: p.roles, verified: true, joinDefaultChannels: false }),
    );
  }
  p.auth = await lib.login(p.username, PASSWORD);
  p.id = p.auth.userId;
  p.api = lib.client(p.auth);
  // Sem chaves de uma execução anterior. A própria pessoa redefine: pelo administrador, a faixa e a configuração
  // mostrariam o aviso de que um administrador redefiniu, e não o texto de quem nunca configurou.
  ok(`e2e.resetOwnE2EKey ${p.username}`, await p.api.call('POST', 'e2e.resetOwnE2EKey', { password: PASSWORD }));
}

const RATE = 'API_Enable_Rate_Limiter';
const all = ok('settings', await admin.call('GET', 'settings')).settings;
const rateBefore = all.find((x) => x._id === RATE)?.value;
const e2eBefore = all.find((x) => x._id === 'E2E_Enable')?.value;
ok('settings', await admin.call('POST', 'settings', { settings: { [RATE]: false, E2E_Enable: true } }));

for (const p of Object.values(PEOPLE)) await ensurePerson(p);
const { ana, bruno, carla, davi, op1, op2 } = PEOPLE;

// Conversas da execução anterior saem (as diretas entre estas pessoas e os grupos e2e-cripto-*).
for (const p of [ana, op1]) {
  const subs = (await p.api.call('GET', 'subscriptions.get')).update ?? [];
  for (const s of subs) {
    if (s.t === 'd') await admin.call('POST', 'im.delete', { roomId: s.rid });
    if (s.t === 'p' && s.name.startsWith('e2e-cripto-')) await admin.call('POST', 'rooms.delete', { roomId: s.rid });
  }
}

// ---------- Navegador ----------

const pwSpec = process.env.PLAYWRIGHT_CORE;
const pw = pwSpec ? await import(pathToFileURL(/\.(m?js)$/.test(pwSpec) ? pwSpec : path.join(pwSpec, 'index.mjs')).href) : await import('playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const devices = pw.devices ?? pw.default?.devices ?? {};
const browser = await chromium.launch({
  executablePath: lib.executablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const DESK = { viewport: { width: 1366, height: 850 } };
const PHONE = devices['Pixel 7'] ?? { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

const problems = [];
const contexts = [];

// Cada contexto é um navegador à parte (IndexedDB próprio): abrir de novo é como entrar num computador novo.
async function open(who, { phone = false, scheme = 'light', url = '/home' } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), colorScheme: scheme, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'microphone'], { origin: CHAT_URL });
  const page = await ctx.newPage();
  const name = `${who.username}${phone ? '/celular' : ''}${scheme === 'dark' ? '/escuro' : ''}`;
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Push API in incognito/.test(m.text()) && problems.push(`${name} console: ${m.text()}`.slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() >= 400 && (r.url().includes('/api/') || r.url().includes('/file-upload/')) && !expected.has(`${r.status()} ${new URL(r.url()).pathname}`)) {
      problems.push(`${name} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(CHAT_URL, '')}`);
    }
  });
  await login(page, who);
  if (url) await page.goto(`${CHAT_URL}${url}`);
  contexts.push(ctx);
  return page;
}
// Respostas de erro que o roteiro provoca de propósito.
const expected = new Set();

async function login(page, who) {
  await page.goto(`${CHAT_URL}/login`);
  await page.fill('form input >> nth=0', who.username);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
}

let shotN = 0;
async function shot(page, name) {
  shotN++;
  const file = path.join(OUT, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
  return file;
}
async function shotDark(page, name) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: 'light' });
}

const assert = (cond, what) => {
  if (!cond) throw new Error(what);
};
const expectVisible = async (loc, what, timeout = 10000) => {
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`não apareceu: ${what}`);
  }
};
async function waitFor(what, fn, timeout = 15000) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn().catch((e) => e);
    if (last && !(last instanceof Error)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`não aconteceu: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(250);
  }
}

const results = [];
async function step(n, title, fn) {
  if (!STEPS.has(n)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ n, title, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${n}. ${title} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ n, title, ok: false, error: e.message });
    for (const [i, ctx] of contexts.entries()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(OUT, `falha-${n}-${i}.png`) }).catch(() => {});
    console.log(`FALHA ${n}. ${title}: ${e.message}`);
  }
}

// ---------- Ações na tela ----------

const banner = (page) => page.locator('.e2e-banner');
const composer = (page) => page.locator('.room-main .composer textarea');
const bodyWith = (page, text) => page.locator('.room-main .msg .msg-body', { hasText: text });
const placeholders = (page, text) => page.locator('.room-main .msg-e2e', { hasText: text });

async function openRoom(page, rid, t) {
  await page.goto(`${CHAT_URL}/${t === 'd' ? 'direct' : 'group'}/${rid}`);
  await expectVisible(page.locator('.room-header .room-name'), 'cabeçalho da conversa', 20000);
}
async function roomMenu(page, item) {
  await page.locator('.room-actions button[aria-label="Mais"]').click();
  const it = page.getByRole('menuitem', { name: item, exact: true });
  await expectVisible(it, `"${item}" no Mais`);
  await it.click();
}
async function menuHas(page, item) {
  await page.locator('.room-actions button[aria-label="Mais"]').click();
  await page.getByRole('menu').first().waitFor({ state: 'visible' });
  const n = await page.getByRole('menuitem', { name: item, exact: true }).count();
  await page.keyboard.press('Escape');
  return n > 0;
}
const visibleButton = (scope, name) => scope.getByRole('button', { name, exact: true }).locator('visible=true').first();
async function confirm(page, label) {
  const dlg = page.locator('.modal.confirm');
  await expectVisible(dlg, `confirmação "${label}"`);
  await dlg.getByRole('button', { name: label, exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
}
const e2eModal = (page, title) => page.locator('.e2e-modal', { has: page.locator('h2', { hasText: title }) });

// Configurar com a senha gerada: copia, confere a área de transferência, marca "Guardei" e conclui.
async function setupGenerated(page, shotName) {
  const m = e2eModal(page, 'Configurar a criptografia');
  await expectVisible(m, 'Configurar a criptografia');
  const pass = (await m.locator('.e2e-pass').getAttribute('aria-label')).replace('Senha da criptografia: ', '');
  assert(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/.test(pass), `senha gerada fora do formato: ${pass}`);
  const done = visibleButton(m, 'Concluir');
  assert(await done.isDisabled(), '"Concluir" habilitado antes de marcar "Guardei a senha"');
  await m.getByRole('button', { name: 'Copiar', exact: true }).click();
  await expectVisible(page.getByText('Senha copiada.'), 'aviso "Senha copiada."');
  assert((await page.evaluate(() => navigator.clipboard.readText())) === pass, 'a área de transferência não tem a senha');
  if (shotName) await shot(page, shotName);
  await m.getByText('Guardei a senha em lugar seguro').click();
  await done.click();
  await m.waitFor({ state: 'detached', timeout: 30000 });
  return pass;
}
async function setupOwn(page, pass, shotName) {
  const m = e2eModal(page, 'Configurar a criptografia');
  await expectVisible(m, 'Configurar a criptografia');
  await m.getByRole('button', { name: 'Prefiro escolher a minha senha' }).click();
  // O aviso de que a senha não se recupera também vale para a senha escolhida.
  await expectVisible(m.getByText(T.noRecovery), 'aviso de que a senha não se recupera');
  // Enquanto a pessoa digita, nada de erro; ao sair do campo, sim.
  await m.getByLabel('Sua senha').pressSequentially('curta');
  await sleep(300);
  assert(!(await m.getByText('A senha precisa ter pelo menos 12 caracteres.').count()), 'erro de senha curta durante a digitação');
  await m.getByLabel('Repita a senha').click();
  await expectVisible(m.getByText('A senha precisa ter pelo menos 12 caracteres.'), 'erro de senha curta ao sair do campo');
  await m.getByLabel('Sua senha').fill('uma senha comprida o bastante');
  await m.getByLabel('Repita a senha').pressSequentially('outra');
  assert(!(await m.getByText('As senhas não conferem.').count()), 'erro de senhas diferentes durante a digitação');
  await m.getByLabel('Sua senha').click();
  await expectVisible(m.getByText('As senhas não conferem.'), 'erro de senhas diferentes ao sair do campo');
  if (shotName) await shot(page, shotName);
  await m.getByLabel('Sua senha').fill(pass);
  await m.getByLabel('Repita a senha').fill(pass);
  await visibleButton(m, 'Concluir').click();
  await m.waitFor({ state: 'detached', timeout: 30000 });
}
async function unlock(page, pass, { wrongFirst = false, shotName } = {}) {
  const m = e2eModal(page, 'Desbloquear a criptografia');
  await expectVisible(m, 'Desbloquear a criptografia');
  const field = m.getByLabel('Senha da criptografia');
  assert((await field.getAttribute('autocomplete')) === 'off', 'campo da senha sem autoComplete="off"');
  if (wrongFirst) {
    await field.fill('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    await visibleButton(m, 'Desbloquear').click();
    await expectVisible(m.getByText(T.wrong), `"${T.wrong}"`, 30000);
    if (shotName) await shot(page, shotName);
  }
  await field.fill(pass);
  await visibleButton(m, 'Desbloquear').click();
  await m.waitFor({ state: 'detached', timeout: 30000 });
}
async function send(page, text) {
  const ta = composer(page);
  await expectVisible(ta, 'compositor habilitado', 30000);
  await waitFor('compositor habilitado', async () => (await ta.isEnabled()) || null, 30000);
  await ta.fill(text);
  await ta.press('Enter');
  await expectVisible(bodyWith(page, text), `a própria mensagem "${text}"`, 20000);
}
const roomInfo = async (p, rid) => ok('rooms.info', await p.api.call('GET', 'rooms.info', { roomId: rid })).room;
const history = async (p, rid) => ok('rooms.history', await p.api.call('GET', 'rooms.history', { roomId: rid, count: 50 })).messages;

// ---------- Estado entre os passos ----------

let dmRid = '';
let anaPass = '';
const brunoPass = `Bruno-cripto-${RUN}`;
let groupRid = '';
let keyBefore = '';
let anaPage = null;
let brunoPage = null;
let carlaPage = null;
let carlaPass = '';
let daviPass = '';
let group2 = '';
let daviDesk = null;

// ---------- 1. Ana liga a criptografia na conversa direta ----------
await step(1, 'Conversa direta: Ana liga a criptografia, configura a senha gerada e escreve', async () => {
  dmRid = ok('im.create', await ana.api.call('POST', 'im.create', { username: bruno.username })).room._id;
  ok('mensagem antes', await ana.api.call('POST', 'chat.sendMessage', { message: { rid: dmRid, msg: 'Mensagem aberta, de antes da criptografia.' } }));
  anaPage = await open(ana);
  await openRoom(anaPage, dmRid, 'd');
  assert(!(await banner(anaPage).count()), 'faixa da criptografia numa conversa sem criptografia');
  await roomMenu(anaPage, 'Ligar criptografia de ponta a ponta');
  // Sem chaves: a senha vem antes da confirmação.
  anaPass = await setupGenerated(anaPage, 'configurar-senha-gerada');
  await expectVisible(anaPage.locator('.modal.confirm', { hasText: 'Ligar a criptografia de ponta a ponta?' }), 'confirmação de ligar');
  await shot(anaPage, 'confirmar-ligar');
  await confirm(anaPage, 'Ligar criptografia');
  await expectVisible(anaPage.locator('.room-header button.e2e-mark[aria-label="Conversa criptografada de ponta a ponta. Saiba mais"]'), 'cadeado no topo');
  await expectVisible(anaPage.locator('.room-main .msg.system', { hasText: T.on }), 'linha "ligou a criptografia de ponta a ponta"');
  await expectVisible(banner(anaPage).getByText(T.ready), 'faixa "Esta conversa é criptografada"', 20000);
  await send(anaPage, 'Olá Bruno, isto vai cifrado 🔒 com acentuação: ação, café.');
  const room = await roomInfo(ana, dmRid);
  assert(room.encrypted && /^[A-Za-z0-9_-]{16}$/.test(room.e2eKeyId ?? ''), `sala sem chave: ${JSON.stringify({ encrypted: room.encrypted, e2eKeyId: room.e2eKeyId })}`);
  await shot(anaPage, 'conversa-direta-ana');
  await shotDark(anaPage, 'conversa-direta-ana-escuro');
  // A mensagem aberta de antes continua legível.
  await expectVisible(bodyWith(anaPage, 'Mensagem aberta, de antes da criptografia.'), 'mensagem aberta de antes');
});

// ---------- 2. Bruno configura e recebe a chave da aba da Ana ----------
await step(2, 'Bruno configura com senha própria, recebe a chave da Ana, lê e responde', async () => {
  brunoPage = await open(bruno);
  await openRoom(brunoPage, dmRid, 'd');
  await expectVisible(banner(brunoPage).getByText(T.none), `faixa "${T.none}"`);
  // Sem configurar: a mensagem pede para configurar, como a faixa (não para desbloquear).
  await expectVisible(placeholders(brunoPage, T.noneMsg), 'mensagem cifrada como aviso');
  const disabled = brunoPage.locator('.room-main .composer.disabled', { hasText: T.none });
  await expectVisible(disabled, 'compositor desativado com o motivo');
  await shot(brunoPage, 'bruno-sem-senha');
  await banner(brunoPage).getByRole('button', { name: 'Configurar' }).click();
  await setupOwn(brunoPage, brunoPass, 'configurar-senha-propria-erros');
  await expectVisible(bodyWith(brunoPage, 'Olá Bruno, isto vai cifrado 🔒'), 'mensagem da Ana decifrada no Bruno', 40000);
  await expectVisible(banner(brunoPage).getByText(T.ready), 'faixa pronta no Bruno');
  await send(brunoPage, 'Recebi! Resposta do Bruno, também cifrada.');
  await expectVisible(bodyWith(anaPage, 'Recebi! Resposta do Bruno'), 'resposta do Bruno decifrada na Ana', 20000);
  // Quem entregou a chave ao Bruno foi a aba da Ana.
  const by = sql(`SELECT provided_by FROM e2e_room_keys WHERE room_id = '${dmRid}' AND user_id = '${bruno.id}'`);
  if (by !== null) assert(by === ana.id, `chave do Bruno entregue por ${by}`);
  // Dispensar a faixa: some e fica dispensada nesta conversa.
  await banner(brunoPage).getByRole('button', { name: 'Fechar aviso' }).click();
  assert(!(await banner(brunoPage).count()), 'a faixa não saiu ao fechar');
  await shot(brunoPage, 'conversa-direta-bruno');
  // Cadeado do topo → Saiba mais.
  await brunoPage.locator('.room-header button.e2e-mark').click();
  const info = brunoPage.locator('.e2e-modal', { hasText: 'Chamadas de voz e vídeo não são cifradas de ponta a ponta.' });
  await expectVisible(info, 'Saiba mais');
  await shot(brunoPage, 'saiba-mais');
  await info.getByRole('button', { name: 'Entendi' }).click();
});

// ---------- 3. O servidor só tem o conteúdo cifrado ----------
await step(3, 'Servidor e auditoria: sem o texto, só o envelope cifrado', async () => {
  const start = new Date(Date.now() - 3600_000).toISOString();
  const end = new Date(Date.now() + 3600_000).toISOString();
  const audit = ok('audit.messages', await admin.call('POST', 'audit.messages', { type: 'room', rid: dmRid, startDate: start, endDate: end })).messages;
  const enc = audit.filter((m) => m.e2e);
  assert(enc.length >= 2, `auditoria com ${enc.length} mensagens cifradas`);
  assert(enc.every((m) => m.msg === '' && /^[A-Za-z0-9_-]+$/.test(m.e2e.ct)), 'mensagem cifrada com texto na auditoria');
  assert(!JSON.stringify(audit).includes('Olá Bruno') && !JSON.stringify(audit).includes('Recebi!'), 'texto aberto na auditoria');
  if (DATABASE_URL) {
    assert(sql(`SELECT count(*) FROM messages WHERE room_id = '${dmRid}' AND (msg ILIKE '%Bruno%' OR e2e::text ILIKE '%Bruno%')`) === '0', 'texto aberto no banco');
    assert(Number(sql(`SELECT count(*) FROM e2e_room_keys WHERE room_id = '${dmRid}'`)) === 2, 'chaves da conversa direta: esperado 2 (Ana e Bruno)');
    assert(sql(`SELECT count(*) FROM e2e_user_keys WHERE user_id = '${ana.id}' AND private_key LIKE '%PBKDF2-SHA256%'`) === '1', 'chave privada da Ana fora do formato cifrado');
  }
});

// ---------- 4. Bruno sai, entra de novo e desbloqueia ----------
await step(4, 'Bruno sai e entra: Desbloquear, senha errada, senha certa e o histórico volta', async () => {
  await brunoPage.locator('.side-foot .me-btn').click();
  await brunoPage.getByRole('menuitem', { name: 'Sair' }).click();
  await brunoPage.waitForURL(/\/login/, { timeout: 15000 });
  await brunoPage.waitForLoadState('load');
  await expectVisible(brunoPage.locator('button[type="submit"]'), 'tela de entrar');
  // Ao sair, nada da criptografia fica no navegador.
  const left = await waitFor('IndexedDB lido', () => brunoPage.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('wescc-e2e', 1);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('keys')) return resolve(0);
          const c = db.transaction('keys', 'readonly').objectStore('keys').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-1);
        };
        r.onerror = () => resolve(-1);
      }),
  ).then((n) => ({ n })));
  assert(left.n === 0, `IndexedDB com ${left.n} chave(s) depois de sair`);
  await login(brunoPage, bruno);
  await openRoom(brunoPage, dmRid, 'd');
  await expectVisible(banner(brunoPage).getByText(T.locked), `faixa "${T.locked}"`);
  await expectVisible(placeholders(brunoPage, T.lockedMsg), 'mensagens bloqueadas');
  await shot(brunoPage, 'bruno-bloqueado');
  await banner(brunoPage).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(brunoPage, brunoPass, { wrongFirst: true, shotName: 'desbloquear-senha-errada' });
  await expectVisible(bodyWith(brunoPage, 'Olá Bruno, isto vai cifrado 🔒'), 'histórico decifrado depois de desbloquear', 20000);
  await expectVisible(bodyWith(brunoPage, 'Recebi! Resposta do Bruno'), 'a própria mensagem decifrada');
});

// ---------- 5. Imagem e áudio cifrados ----------
await step(5, 'Ana envia imagem e mensagem de voz; Bruno vê a imagem e toca o áudio', async () => {
  const png = path.resolve('web/public/icons/icon-192.png');
  await anaPage.locator('.room-main .composer input[type="file"]').setInputFiles(png);
  const dlg = anaPage.locator('.modal', { hasText: 'Enviar arquivo' });
  await expectVisible(dlg, 'confirmação do arquivo');
  await dlg.getByPlaceholder('Descrição (opcional)').fill('Logo cifrado');
  await dlg.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expectVisible(anaPage.locator('.room-main .att-image-box img[src^="blob:"]'), 'imagem decifrada na Ana', 20000);
  // Voz: um clique trava a gravação; o mesmo botão envia.
  await anaPage.getByRole('button', { name: 'Gravar mensagem de voz' }).click();
  await expectVisible(anaPage.getByRole('button', { name: 'Enviar áudio' }), 'gravação travada');
  await sleep(2500);
  await anaPage.getByRole('button', { name: 'Enviar áudio' }).click();
  await expectVisible(anaPage.locator('.room-main .att-file', { hasText: 'Mensagem de voz' }), 'cartão da mensagem de voz', 20000);

  await expectVisible(brunoPage.locator('.room-main .att-image-box img[src^="blob:"]'), 'imagem decifrada no Bruno', 20000);
  await expectVisible(bodyWith(brunoPage, 'Logo cifrado'), 'legenda decifrada');
  const voice = brunoPage.locator('.room-main .att-file', { hasText: 'Mensagem de voz' }).last();
  await expectVisible(voice, 'mensagem de voz no Bruno', 20000);
  assert((await voice.innerText()).includes('Clique para ouvir'), `cartão da voz sem "Clique para ouvir": ${await voice.innerText()}`);
  await shot(brunoPage, 'arquivos-cifrados-bruno');
  await voice.click();
  const player = brunoPage.locator('.room-main .att-voice').last();
  await expectVisible(player, 'player de voz depois de decifrar', 20000);
  // Um toque só: decifra e já toca.
  await waitFor('áudio tocando depois de um toque', async () => (await player.locator('audio').first().evaluate((a) => !a.paused)) || null, 10000);
  await shot(brunoPage, 'voz-tocando');
  const src = await player.locator('audio').first().getAttribute('src').catch(() => null);
  assert(!src || src.startsWith('blob:'), `áudio fora de blob: ${src}`);
  // O arquivo no servidor é opaco: nome e tipo genéricos.
  const files = ok('rooms.files', await bruno.api.call('GET', 'rooms.files', { roomId: dmRid })).files;
  assert(files.length >= 2 && files.every((f) => f.e2e && f.name === 'arquivo-criptografado' && f.type === 'application/octet-stream'), `arquivos no servidor: ${JSON.stringify(files.map((f) => [f.name, f.type, f.e2e]))}`);
  await brunoPage.locator('.room-actions button[aria-label="Mais"]').click();
  await brunoPage.getByRole('menuitem', { name: 'Arquivos' }).click().catch(async () => {
    await brunoPage.keyboard.press('Escape');
    await brunoPage.locator('.room-actions button[title="Arquivos"]').click();
  });
  // O painel decifra o nome e o tipo (o servidor só tem os genéricos) e filtra por eles.
  await expectVisible(brunoPage.locator('.panel-files .file-row-name', { hasText: 'icon-192.png' }), 'painel Arquivos com o nome decifrado', 20000);
  await shot(brunoPage, 'painel-arquivos');
  await brunoPage.locator('.panel-files .panel-filters select').selectOption('image/*');
  await waitFor('filtro Imagens', async () => ((await brunoPage.locator('.panel-files .file-row').count()) === 1 ? true : null));
  await expectVisible(brunoPage.locator('.panel-files .file-row-name', { hasText: 'icon-192.png' }), 'imagem no filtro Imagens');
  await shotDark(brunoPage, 'painel-arquivos-filtro-escuro');
  await brunoPage.locator('.panel-files .panel-filters select').selectOption('');
  await brunoPage.goto(`${CHAT_URL}/direct/${dmRid}`);
});

// ---------- 6. Grupo privado criado já criptografado; Carla recebe a chave do Bruno ----------
await step(6, 'Grupo privado criptografado: Ana cria, Carla configura depois e recebe a chave do Bruno', async () => {
  await anaPage.locator('button[aria-label="Criar"]').first().click();
  await anaPage.getByRole('menuitem', { name: /^Canal/ }).click();
  const dlg = anaPage.locator('.modal', { has: anaPage.locator('h2', { hasText: 'Criar canal' }) });
  await expectVisible(dlg, 'Criar canal');
  await dlg.locator('input').first().fill(`e2e-cripto-${RUN}`);
  const toggle = dlg.locator('label.toggle', { hasText: 'Criptografar de ponta a ponta' });
  await expectVisible(toggle, 'opção "Criptografar de ponta a ponta"');
  await toggle.click();
  assert(await toggle.getByRole('switch').isChecked(), '"Criptografar de ponta a ponta" não ligou');
  await shot(anaPage, 'criar-grupo-criptografado');
  await visibleButton(dlg, 'Criar').click();
  await anaPage.waitForURL(/\/group\//, { timeout: 15000 });
  groupRid = new URL(anaPage.url()).pathname.split('/')[2];
  await expectVisible(banner(anaPage).getByText(T.ready), 'faixa pronta no grupo', 20000);
  ok('convidar', await ana.api.call('POST', 'groups.invite', { roomId: groupRid, userId: bruno.id }));
  ok('convidar', await ana.api.call('POST', 'groups.invite', { roomId: groupRid, userId: carla.id }));
  await send(anaPage, 'Primeira do grupo: bem-vindos.');
  await openRoom(brunoPage, groupRid, 'p');
  await expectVisible(bodyWith(brunoPage, 'Primeira do grupo'), 'Bruno lê o grupo', 30000);
  // Ana fecha o navegador: quem entrega para a Carla é o Bruno.
  await anaPage.context().close();
  anaPage = null;
  carlaPage = await open(carla);
  await openRoom(carlaPage, groupRid, 'p');
  await expectVisible(banner(carlaPage).getByText(T.none), 'faixa "configure" na Carla');
  await banner(carlaPage).getByRole('button', { name: 'Configurar' }).click();
  carlaPass = await setupGenerated(carlaPage);
  await expectVisible(bodyWith(carlaPage, 'Primeira do grupo'), 'Carla lê depois de receber a chave', 40000);
  const by = sql(`SELECT provided_by FROM e2e_room_keys WHERE room_id = '${groupRid}' AND user_id = '${carla.id}'`);
  if (by !== null) assert(by === bruno.id, `chave da Carla entregue por ${by}, esperado o Bruno`);
  await send(carlaPage, 'Carla chegou e lê tudo.');
  await expectVisible(bodyWith(brunoPage, 'Carla chegou'), 'Bruno lê a Carla', 20000);
  await shot(carlaPage, 'grupo-carla');
  // Informações do grupo: a linha da criptografia; a busca procura nas mensagens carregadas.
  await carlaPage.locator('.room-actions').getByRole('button', { name: 'Buscar mensagens' }).click();
  await expectVisible(carlaPage.getByText('A busca procura só nas mensagens já carregadas (a conversa é criptografada).'), 'aviso da busca');
  await carlaPage.locator('.panel-search input').first().fill('bem-vindos');
  await expectVisible(carlaPage.locator('.panel-search .result', { hasText: 'Primeira do grupo' }), 'resultado decifrado na busca');
  await shot(carlaPage, 'busca-carregadas');
  // A aba da Carla fica aberta no grupo, com a chave antiga na memória, para o passo 7.
});

// ---------- 7. Carla sai: chave nova; Davi chega depois da troca (celular) ----------
await step(7, 'Carla sai do grupo: chave nova; Davi chega depois e não lê o que veio antes da troca', async () => {
  keyBefore = (await roomInfo(bruno, groupRid)).e2eKeyId;
  expected.add('403 /api/v1/calls.roomCall');
  ok('tirar a Carla', await ana.api.call('POST', 'groups.kick', { roomId: groupRid, userId: carla.id }));
  // Quem está online (o Bruno) troca a chave entre 0 e 5 s.
  const room = await waitFor('chave nova no grupo', async () => {
    const r = await roomInfo(bruno, groupRid);
    return r.e2eKeyId && r.e2eKeyId !== keyBefore && !r.e2eRotate ? r : null;
  }, 30000);
  await send(brunoPage, 'Depois da troca de chave.');
  // A aba da Carla, aberta no grupo com a chave antiga, não recebe nem decifra a mensagem nova. (A tela de chamadas
  // da sala ainda pergunta pela chamada da sala depois da remoção: 403 esperado, fora da criptografia.)
  if (carlaPage) {
    await sleep(2000);
    assert(!(await bodyWith(carlaPage, 'Depois da troca de chave.').count()), 'a Carla, removida, leu a mensagem nova');
    await carlaPage.context().close();
    carlaPage = null;
  }
  const msgs = await history(bruno, groupRid);
  const after = msgs.find((m) => m.e2e && m.u.username === bruno.username && m.ts === msgs.filter((x) => x.e2e && x.u.username === bruno.username).map((x) => x.ts).sort().pop());
  assert(after?.e2e.kid === room.e2eKeyId && after.e2e.kid !== keyBefore, 'a mensagem nova não usa a chave nova');
  // Carla, fora do grupo, não busca nada dele.
  const denied = await carla.api.call('GET', 'e2e.fetchRoomKeys', { rid: groupRid });
  assert(denied.success === false, 'Carla ainda busca as chaves do grupo');
  if (DATABASE_URL) assert(sql(`SELECT count(*) FROM e2e_room_keys WHERE room_id = '${groupRid}' AND user_id = '${carla.id}'`) === '0', 'linhas de chave da Carla ficaram');

  // Davi entra depois da troca, no celular: configura em tela cheia e recebe a chave atual.
  ok('convidar Davi', await ana.api.call('POST', 'groups.invite', { roomId: groupRid, userId: davi.id }));
  const daviPage = await open(davi, { phone: true });
  await openRoom(daviPage, groupRid, 'p');
  const b = banner(daviPage);
  await expectVisible(b.getByText(T.none), 'faixa no celular');
  const box = await b.boundingBox();
  assert(box && box.height <= 56, `faixa do celular com ${box?.height}px (mais de uma linha)`);
  assert(await daviPage.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1), 'rolagem horizontal no celular');
  await shot(daviPage, 'celular-faixa-configurar');
  await b.getByRole('button', { name: 'Configurar' }).click();
  const setup = e2eModal(daviPage, 'Configurar a criptografia');
  await expectVisible(setup, 'configurar no celular');
  assert(await setup.evaluate((el) => el.classList.contains('fullscreen')), 'configurar no celular não abriu em tela cheia');
  const passBox = await setup.locator('.e2e-pass').boundingBox();
  const vw = daviPage.viewportSize().width;
  assert(passBox && passBox.x >= 0 && passBox.x + passBox.width <= vw + 1, 'senha gerada saiu da tela');
  await shot(daviPage, 'celular-configurar-tela-cheia');
  daviPass = await setupGenerated(daviPage);
  await expectVisible(bodyWith(daviPage, 'Depois da troca de chave.'), 'Davi lê a mensagem depois da troca', 40000);
  await expectVisible(placeholders(daviPage, T.oldKey), `"${T.oldKey}" nas mensagens de antes`);
  await shot(daviPage, 'celular-davi-chave-antiga');
  await daviPage.context().close();
});

// ---------- 8. Bruno esquece a senha e redefine ----------
await step(8, 'Bruno esquece a senha: redefine, as antigas ficam ilegíveis, as novas decifram', async () => {
  await brunoPage.context().close();
  brunoPage = await open(bruno);
  await openRoom(brunoPage, dmRid, 'd');
  await banner(brunoPage).getByRole('button', { name: 'Desbloquear' }).click();
  const m = e2eModal(brunoPage, 'Desbloquear a criptografia');
  await expectVisible(m, 'Desbloquear');
  await m.getByRole('button', { name: 'Esqueci a senha' }).click();
  const reset = e2eModal(brunoPage, 'Redefinir a criptografia?');
  await expectVisible(reset, 'Redefinir a criptografia?');
  expected.add('400 /api/v1/e2e.resetOwnE2EKey');
  await reset.getByLabel('Senha de entrar no chat').fill('senha-errada-123');
  await visibleButton(reset, 'Redefinir').click();
  await expectVisible(reset.getByText('Senha incorreta.'), 'senha de entrar errada');
  await shot(brunoPage, 'redefinir');
  await reset.getByLabel('Senha de entrar no chat').fill(PASSWORD);
  await visibleButton(reset, 'Redefinir').click();
  // Depois de redefinir, a senha nova na hora.
  await setupGenerated(brunoPage);
  // Ana (outro navegador) está online para entregar a chave nova.
  anaPage = await open(ana);
  await openRoom(anaPage, dmRid, 'd');
  await banner(anaPage).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(anaPage, anaPass);
  await expectVisible(bodyWith(anaPage, 'Recebi! Resposta do Bruno'), 'Ana lê o histórico depois de desbloquear', 20000);
  await expectVisible(placeholders(brunoPage, T.oldKey), 'mensagens antigas ilegíveis para o Bruno', 30000);
  await waitFor('Bruno com a chave nova', async () => (await composer(brunoPage).isEnabled()) || null, 40000);
  await send(anaPage, 'Depois da redefinição do Bruno.');
  await expectVisible(bodyWith(brunoPage, 'Depois da redefinição do Bruno.'), 'mensagem nova decifrada no Bruno', 30000);
  await shot(brunoPage, 'bruno-depois-de-redefinir');
});

// ---------- 9. Operação: conversa direta bloqueada não liga e não tem chave ----------
await step(9, 'Operação: op1 e op2 não ligam a criptografia, e a conversa não tem chave', async () => {
  const rid = ok('im.create', await op1.api.call('POST', 'im.create', { username: op2.username })).room._id;
  ok('mensagem', await op1.api.call('POST', 'chat.sendMessage', { message: { rid, msg: 'Combinado antes da regra.' } }));
  const p = await open(op1, { url: '/account/security' });
  // op1 configura a criptografia em Minha conta (o cartão).
  const card = p.locator('.e2e-card');
  await expectVisible(card, 'cartão da criptografia em Minha conta', 15000);
  await card.getByRole('button', { name: 'Configurar agora' }).click();
  await setupGenerated(p);
  await expectVisible(card.getByText('Configurada e desbloqueada neste navegador.'), 'cartão pronto');
  await shot(p, 'minha-conta-cartao');
  for (const u of [op1, op2]) ok('Operação', await admin.call('POST', 'users.update', { userId: u.id, data: { roles: ['operacao'] } }));
  await openRoom(p, rid, 'd');
  const blocked = p.locator('.room-main .composer.disabled');
  await expectVisible(blocked, 'compositor bloqueado pela regra');
  const why = (await blocked.innerText()).trim();
  assert(!why.includes('criptografia'), `o motivo é da criptografia, não da regra: ${why}`);
  assert(!(await menuHas(p, 'Ligar criptografia de ponta a ponta')), '"Ligar criptografia" no Mais de uma conversa bloqueada');
  await shot(p, 'operacao-bloqueada');
  expected.add('403 /api/v1/rooms.saveRoomSettings');
  const r = await op1.api.call('POST', 'rooms.saveRoomSettings', { rid, encrypted: true });
  assert(r.success === false && /particular|bloquead|Operação|conversar/i.test(r.error ?? ''), `ligar pela API: ${JSON.stringify(r)}`);
  const r2 = await op1.api.call('POST', 'im.create', { username: op2.username });
  if (r2.success === false) assert(/particular|bloquead|Operação|conversar/i.test(r2.error ?? ''), `abrir de novo: ${r2.error}`);
  if (DATABASE_URL) {
    assert(sql(`SELECT count(*) FROM e2e_room_keys WHERE room_id = '${rid}'`) === '0', 'a conversa bloqueada tem chave');
    assert(sql(`SELECT encrypted FROM rooms WHERE id = '${rid}'`) === 'f', 'a conversa bloqueada ficou criptografada');
  }
  // Sem a conversa antiga: op1 tenta abrir uma conversa direta nova com op2 e recebe o texto da regra; nada é criado.
  ok('apagar a conversa', await admin.call('POST', 'im.delete', { roomId: rid }));
  const fresh = await op1.api.call('POST', 'im.create', { username: op2.username });
  assert(fresh.success === false && (fresh.error ?? '').includes('estão bloqueadas pela política da empresa'), `conversa nova entre op1 e op2: ${JSON.stringify(fresh)}`);
  if (DATABASE_URL) {
    const pair = `r.t = 'd' AND r.uids @> ARRAY['${op1.id}','${op2.id}']::text[]`;
    assert(sql(`SELECT count(*) FROM rooms r WHERE ${pair}`) === '0', 'a conversa recusada foi criada');
    assert(sql(`SELECT count(*) FROM e2e_room_keys k JOIN rooms r ON r.id = k.room_id WHERE ${pair}`) === '0', 'linha de chave para a conversa recusada');
  }
  await p.context().close();
  for (const u of [op1, op2]) ok('volta', await admin.call('POST', 'users.update', { userId: u.id, data: { roles: ['user'] } }));
});

// ---------- 10. Celular: desbloquear em folha, o cadeado abre o Saiba mais ----------
await step(10, 'Celular: faixa numa linha, desbloquear em folha e o Saiba mais em folha (claro e escuro)', async () => {
  const p = await open(ana, { phone: true });
  await openRoom(p, dmRid, 'd');
  const b = banner(p);
  await expectVisible(b.getByText(T.locked), 'faixa "Desbloquear" no celular');
  const box = await b.boundingBox();
  assert(box && box.height <= 56, `faixa com ${box?.height}px no celular`);
  const btn = await b.getByRole('button', { name: 'Desbloquear' }).boundingBox();
  assert(btn && btn.x + btn.width <= p.viewportSize().width, 'botão da faixa fora da tela');
  await shot(p, 'celular-faixa-desbloquear');
  await b.getByRole('button', { name: 'Desbloquear' }).click();
  const m = e2eModal(p, 'Desbloquear a criptografia');
  await expectVisible(m, 'desbloquear no celular');
  assert(await m.evaluate((el) => el.classList.contains('sheet')), 'desbloquear no celular não abriu em folha');
  await shot(p, 'celular-desbloquear-folha');
  await unlock(p, anaPass);
  await expectVisible(bodyWith(p, 'Depois da redefinição do Bruno.'), 'mensagens decifradas no celular', 20000);
  // "Saiba mais" da faixa com 44 px de toque.
  const more = await b.getByRole('button', { name: 'Saiba mais' }).boundingBox();
  assert(more && more.height >= 44, `"Saiba mais" com ${more?.height}px de toque no celular`);
  await shot(p, 'celular-conversa');
  await p.locator('.room-header button.e2e-mark').click();
  const info = p.locator('.e2e-modal', { hasText: 'Nem os administradores leem.' });
  await expectVisible(info, 'Saiba mais no celular');
  assert(await info.evaluate((el) => el.classList.contains('sheet')), 'Saiba mais no celular não abriu em folha');
  await shot(p, 'celular-saiba-mais');
  await shotDark(p, 'celular-saiba-mais-escuro');
  await info.getByRole('button', { name: 'Entendi' }).click();
  await shotDark(p, 'celular-conversa-escuro');
  await p.context().close();
});

// ---------- 11. Desligar, editar e o compositor sem rascunho ----------
await step(11, 'Edição cifrada, /shrug no navegador, desligar a criptografia e o texto volta aberto', async () => {
  // Rascunho não fica no navegador numa conversa criptografada.
  await composer(anaPage).fill('rascunho secreto');
  const draft = await anaPage.evaluate((rid) => localStorage.getItem(`wescc.draft.${rid}`), dmRid);
  assert(draft === null, 'rascunho guardado no navegador numa conversa criptografada');
  await composer(anaPage).fill('');
  // /shrug sai montado no navegador, cifrado, com o mesmo texto do comando do servidor.
  await composer(anaPage).fill('/shrug tudo certo');
  await composer(anaPage).press('Enter');
  await expectVisible(bodyWith(anaPage, /tudo certo ¯.*ツ/), '/shrug cifrado');
  const shrug = (await history(ana, dmRid)).find((m) => m.e2e && m.u.username === ana.username);
  assert(shrug && shrug.msg === '' && !shrug.t, `/shrug foi aberto para o servidor: ${JSON.stringify(shrug?.msg)}`);
  // Seta para cima edita a última, com o texto decifrado.
  await composer(anaPage).press('ArrowUp');
  await waitFor('texto decifrado na edição', async () => (await composer(anaPage).inputValue()).includes('tudo certo') || null);
  await composer(anaPage).fill('tudo certo, editado');
  await composer(anaPage).press('Enter');
  await expectVisible(bodyWith(anaPage, 'tudo certo, editado'), 'edição cifrada na Ana');
  await expectVisible(bodyWith(brunoPage, 'tudo certo, editado'), 'edição decifrada no Bruno', 20000);
  const last = (await history(ana, dmRid)).find((m) => m.editedAt && m.e2e);
  assert(last && last.msg === '', 'a edição foi aberta para o servidor');
  await shot(brunoPage, 'edicao-cifrada');
  // Desligar.
  await roomMenu(anaPage, 'Desligar criptografia');
  await expectVisible(anaPage.locator('.modal.confirm', { hasText: 'Desligar a criptografia?' }), 'confirmação de desligar');
  await confirm(anaPage, 'Desligar');
  await expectVisible(anaPage.locator('.room-main .msg.system', { hasText: 'desligou a criptografia de ponta a ponta' }), 'linha "desligou"');
  await waitFor('faixa some', async () => (await banner(anaPage).count()) === 0 || null);
  await send(anaPage, 'Agora sem criptografia.');
  const plain = (await history(ana, dmRid)).find((m) => m.msg === 'Agora sem criptografia.');
  assert(plain && !plain.e2e, 'mensagem depois de desligar não ficou aberta');
  await expectVisible(bodyWith(brunoPage, 'tudo certo, editado'), 'as cifradas continuam legíveis depois de desligar');
  await shot(anaPage, 'desligada');
});

// ---------- 12. Quem tem a chave volta depois: a entrega acontece sozinha ----------
await step(12, 'Davi espera a chave com a Ana fora; a Ana volta, desbloqueia em Minha conta e a chave chega sem "Pedir de novo"', async () => {
  // Grupo novo criado pela API; a chave nasce no navegador da Ana, que está aberto e desbloqueado (passo 8).
  group2 = ok('groups.create', await ana.api.call('POST', 'groups.create', { name: `e2e-cripto-${RUN}-volta`, extraData: { encrypted: true } })).group._id;
  await openRoom(anaPage, group2, 'p');
  await expectVisible(banner(anaPage).getByText(T.ready), 'faixa pronta no grupo novo', 20000);
  await send(anaPage, 'Mensagem da Ana antes de sair.');
  // Ana fecha o navegador antes de o Davi chegar: ninguém com a chave fica com o chat aberto.
  await anaPage.context().close();
  anaPage = null;
  ok('convidar Davi', await ana.api.call('POST', 'groups.invite', { roomId: group2, userId: davi.id }));
  daviDesk = await open(davi);
  await openRoom(daviDesk, group2, 'p');
  await banner(daviDesk).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(daviDesk, daviPass);
  await expectVisible(banner(daviDesk).getByText(T.waiting), 'Davi esperando a chave', 20000);
  await expectVisible(placeholders(daviDesk, T.waitingMsg), 'mensagem esperando a chave');
  await banner(daviDesk).getByRole('button', { name: 'Pedir de novo' }).click();
  await expectVisible(banner(daviDesk).getByRole('button', { name: 'Pedido enviado' }), '"Pedido enviado" depois do toque');
  await shot(daviDesk, 'davi-esperando-pedido-enviado');
  // Ana volta e desbloqueia em Minha conta, sem abrir o grupo.
  anaPage = await open(ana, { url: '/account/security' });
  const card = anaPage.locator('.e2e-card');
  await expectVisible(card, 'cartão da criptografia', 15000);
  await card.getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(anaPage, anaPass);
  await expectVisible(card.getByText('Configurada e desbloqueada neste navegador.'), 'cartão pronto');
  assert(!(await card.locator('.pill').count()), 'pílula "Desbloqueada" repetindo o aviso do cartão');
  await shot(anaPage, 'minha-conta-desbloqueada');
  const t0 = Date.now();
  await expectVisible(bodyWith(daviDesk, 'Mensagem da Ana antes de sair.'), 'Davi recebe a chave sem pedir de novo', 30000);
  console.log(`     chave entregue ${((Date.now() - t0) / 1000).toFixed(1)} s depois de a Ana desbloquear`);
  await shot(daviDesk, 'davi-recebeu-sozinho');
});

// ---------- 13. Fixar, o topo, trocar a chave e editar o grupo ----------
await step(13, 'Fixada decifrada (também depois de recarregar), marca própria no topo, texto da troca de chave e "Privada" travada', async () => {
  await openRoom(anaPage, group2, 'p');
  await expectVisible(bodyWith(anaPage, 'Mensagem da Ana antes de sair.'), 'Ana lê o grupo', 20000);
  const m = (await history(ana, group2)).find((x) => x.e2e && !x.t);
  ok('fixar', await ana.api.call('POST', 'chat.pinMessage', { messageId: m._id }));
  const pin = (page) => page.locator('.room-main .pinned-note', { hasText: 'Mensagem da Ana antes de sair.' });
  await expectVisible(pin(anaPage), 'citação decifrada na fixada (Ana)', 20000);
  await expectVisible(pin(daviDesk), 'citação decifrada na fixada (Davi)', 20000);
  await daviDesk.reload();
  await expectVisible(pin(daviDesk), 'citação decifrada depois de recarregar', 30000);
  await shot(daviDesk, 'fixada-decifrada');
  await shotDark(daviDesk, 'fixada-decifrada-escuro');
  // A marca da criptografia não é o cadeado do grupo privado.
  const mark = await anaPage.locator('.room-header button.e2e-mark svg').getAttribute('class');
  const roomIcon = await anaPage.locator('.room-header .room-icon svg').getAttribute('class');
  assert(mark && roomIcon && mark !== roomIcon && /shield/.test(mark), `marca igual ao ícone da sala: ${mark} / ${roomIcon}`);
  await anaPage.locator('.room-header').screenshot({ path: path.join(OUT, `${String(++shotN).padStart(2, '0')}-topo-grupo-criptografado.png`) });
  // "Gerar chave nova": o uso real, sem mandar trocar quando alguém sai.
  await roomMenu(anaPage, 'Gerar chave nova');
  const dlg = anaPage.locator('.modal.confirm', { hasText: 'Gerar uma chave nova?' });
  await expectVisible(dlg, 'confirmação de chave nova');
  const text = await dlg.innerText();
  assert(text.includes('Quem sai da conversa já perde o acesso automaticamente.') && !text.includes('Use se alguém saiu'), `texto da troca manual: ${text}`);
  await shot(anaPage, 'confirmar-chave-nova');
  await dlg.getByRole('button', { name: 'Cancelar', exact: true }).click();
  // Editar o grupo: "Privada" travada enquanto a criptografia está ligada.
  await anaPage.locator('.room-actions').getByRole('button', { name: 'Informações' }).click();
  await anaPage.getByRole('button', { name: 'Editar', exact: true }).click();
  const priv = anaPage.locator('label.toggle', { hasText: 'Privada' });
  await expectVisible(priv, 'opção Privada');
  assert(await priv.getByRole('switch').isDisabled(), '"Privada" habilitada num grupo criptografado');
  await expectVisible(priv.getByText('Desligue a criptografia para tornar o grupo público.'), 'dica da opção Privada');
  await shot(anaPage, 'editar-grupo-privada-travada');
  await anaPage.locator('label.toggle', { hasText: 'Criptografia de ponta a ponta' }).click();
  assert(!(await priv.getByRole('switch').isDisabled()), '"Privada" continua travada depois de desligar a criptografia (sem salvar)');
  await openRoom(anaPage, group2, 'p');
});

// ---------- 14. Arquivo e voz no grupo; o painel Arquivos filtra pelo nome decifrado ----------
await step(14, 'Arquivo e voz no grupo: o painel Arquivos mostra e filtra pelo nome decifrado; a voz toca com um toque', async () => {
  await anaPage.locator('.room-main .composer input[type="file"]').setInputFiles({ name: 'relatorio-trimestral.txt', mimeType: 'text/plain', buffer: Buffer.from('Relatório do trimestre.\n') });
  const dlg = anaPage.locator('.modal', { hasText: 'Enviar arquivo' });
  await expectVisible(dlg, 'confirmação do arquivo');
  await dlg.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expectVisible(anaPage.locator('.room-main .att-file', { hasText: 'relatorio-trimestral.txt' }), 'arquivo na Ana', 20000);
  await anaPage.getByRole('button', { name: 'Gravar mensagem de voz' }).click();
  await expectVisible(anaPage.getByRole('button', { name: 'Enviar áudio' }), 'gravação travada');
  await sleep(2000);
  await anaPage.getByRole('button', { name: 'Enviar áudio' }).click();
  const voice = daviDesk.locator('.room-main .att-file', { hasText: 'Mensagem de voz' }).last();
  await expectVisible(voice, 'mensagem de voz no Davi', 20000);
  await shotDark(daviDesk, 'voz-cartao-escuro');
  await voice.click();
  const player = daviDesk.locator('.room-main .att-voice').last();
  await expectVisible(player, 'player de voz', 20000);
  await waitFor('voz tocando com um toque', async () => (await player.locator('audio').first().evaluate((a) => !a.paused)) || null, 10000);
  await shotDark(daviDesk, 'voz-tocando-escuro');
  await daviDesk.locator('.room-actions button[aria-label="Mais"]').click();
  await daviDesk.getByRole('menuitem', { name: 'Arquivos' }).click().catch(async () => {
    await daviDesk.keyboard.press('Escape');
    await daviDesk.locator('.room-actions button[title="Arquivos"]').click();
  });
  const rows = daviDesk.locator('.panel-files .file-row');
  await expectVisible(daviDesk.locator('.panel-files .file-row-name', { hasText: 'relatorio-trimestral.txt' }), 'nome decifrado no painel', 20000);
  await expectVisible(daviDesk.getByText('A conversa é criptografada: o filtro procura só nos 100 arquivos mais recentes.'), 'aviso do filtro');
  await shot(daviDesk, 'painel-arquivos-grupo');
  await daviDesk.locator('.panel-files input').first().fill('trimestral');
  await waitFor('filtro por nome', async () => ((await rows.count()) === 1 ? true : null));
  await expectVisible(daviDesk.locator('.panel-files .file-row-name', { hasText: 'relatorio-trimestral.txt' }), 'filtro por nome');
  await daviDesk.locator('.panel-files input').first().fill('nada-disso');
  await expectVisible(daviDesk.locator('.panel-files', { hasText: 'Nada encontrado para "nada-disso"' }), 'filtro sem resultado');
  await daviDesk.locator('.panel-files input').first().fill('');
  await daviDesk.locator('.panel-files .panel-filters select').selectOption('audio/*');
  await waitFor('filtro Áudios', async () => ((await rows.count()) === 1 ? true : null));
  assert(!(await daviDesk.locator('.panel-files .file-row-name', { hasText: 'relatorio' }).count()), 'o texto apareceu no filtro Áudios');
  await shotDark(daviDesk, 'painel-arquivos-audios-escuro');
  await daviDesk.goto(`${CHAT_URL}/group/${group2}`);
});

// ---------- 15. Sem configurar; senha própria; muitas senhas erradas ----------
await step(15, 'Quem não configurou vê "Configure" nas mensagens; senha própria valida ao sair do campo; muitas senhas erradas contam o tempo', async () => {
  ok('convidar op2', await ana.api.call('POST', 'groups.invite', { roomId: group2, userId: op2.id }));
  const p = await open(op2, { scheme: 'dark' });
  await openRoom(p, group2, 'p');
  await expectVisible(banner(p).getByText(T.none), 'faixa "configure"');
  await expectVisible(placeholders(p, T.noneMsg), `"${T.noneMsg}" nas mensagens`, 20000);
  assert(!(await placeholders(p, T.lockedMsg).count()), 'mensagem pedindo para desbloquear sem nada configurado');
  await shot(p, 'sem-configurar-escuro');
  await banner(p).getByRole('button', { name: 'Configurar' }).click();
  const m = e2eModal(p, 'Configurar a criptografia');
  await expectVisible(m, 'Configurar');
  await m.getByRole('button', { name: 'Prefiro escolher a minha senha' }).click();
  await expectVisible(m.getByText(T.noRecovery), 'aviso de que a senha não se recupera');
  await m.getByLabel('Sua senha').pressSequentially('curta');
  await sleep(300);
  assert(!(await m.getByText('A senha precisa ter pelo menos 12 caracteres.').count()), 'erro durante a digitação');
  await shot(p, 'senha-propria-digitando-escuro');
  await m.getByLabel('Repita a senha').click();
  await expectVisible(m.getByText('A senha precisa ter pelo menos 12 caracteres.'), 'erro ao sair do campo');
  await shot(p, 'senha-propria-ao-sair-escuro');
  await visibleButton(m, 'Cancelar').click();
  await p.context().close();

  // Davi num navegador novo: cinco senhas erradas.
  const d = await open(davi);
  await openRoom(d, group2, 'p');
  await banner(d).getByRole('button', { name: 'Desbloquear' }).click();
  const u = e2eModal(d, 'Desbloquear a criptografia');
  await expectVisible(u, 'Desbloquear');
  const field = u.getByLabel('Senha da criptografia');
  const go = visibleButton(u, 'Desbloquear');
  for (let i = 0; i < 5; i++) {
    await field.fill(`AAAAA-BBBBB-CCCCC-DDDDD-EEEE${i}`);
    await go.click();
    await waitFor('resposta da senha errada', async () => ((await u.getByText(/Senha incorreta\.|Tente de novo em/).count()) ? true : null), 30000);
  }
  await expectVisible(u.getByText(/Muitas tentativas\. Tente de novo em \d+ s\./), 'contagem regressiva');
  const first = await u.getByText(/Tente de novo em/).innerText();
  await field.fill(daviPass);
  assert(await go.isDisabled(), '"Desbloquear" habilitado durante a espera');
  await shot(d, 'muitas-tentativas-contagem');
  await sleep(2200);
  const later = await u.getByText(/Tente de novo em/).innerText();
  assert(first !== later, `a contagem não andou: ${first} / ${later}`);
  await waitFor('fim da espera', async () => ((await u.getByText(/Tente de novo em|Muitas tentativas/).count()) === 0 ? true : null), 40000);
  assert(!(await go.isDisabled()), '"Desbloquear" travado depois da espera');
  await shot(d, 'muitas-tentativas-depois');
  await go.click();
  await u.waitFor({ state: 'detached', timeout: 30000 });
  await expectVisible(bodyWith(d, 'Mensagem da Ana antes de sair.'), 'Davi lê depois da espera', 20000);
  await d.context().close();
});

// ---------- 16. Administrador redefine: botão travado sem chaves e o motivo na tela de entrar ----------
await step(16, 'Administrador: "Criptografia não configurada" travado; redefinir o Davi leva o motivo à tela de entrar e à configuração', async () => {
  const ctx = await browser.newContext({ ...DESK, colorScheme: 'light', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  contexts.push(ctx);
  const a = await ctx.newPage();
  a.on('pageerror', (e) => problems.push(`admin pageerror: ${e.message}`));
  await a.goto(`${CHAT_URL}/login`);
  await a.fill('form input >> nth=0', lib.ADMIN_USER);
  await a.fill('input[type="password"]', lib.ADMIN_PASSWORD);
  await a.click('button[type="submit"]');
  await a.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  const security = async (who) => {
    await a.goto(`${CHAT_URL}/admin/users/edit/${encodeURIComponent(who.id)}`);
    await a.locator('[role="tab"]', { hasText: 'Segurança' }).first().click();
  };
  await security(op2);
  const none = a.getByRole('button', { name: 'Criptografia não configurada' });
  await expectVisible(none, 'botão travado para quem não configurou', 15000);
  assert(await none.isDisabled(), '"Criptografia não configurada" habilitado');
  await shot(a, 'admin-sem-criptografia');
  await security(davi);
  // A aba do Davi perde a sessão: a primeira leitura depois da saída forçada recebe 401.
  expected.add('401 /api/v1/me');
  expected.add('401 /api/v1/e2e.fetchRoomKeys'); // a troca de chave pedida pela redefinição chega junto com a saída
  const reset = a.getByRole('button', { name: 'Redefinir criptografia' });
  await expectVisible(reset, 'Redefinir criptografia', 15000);
  await reset.click();
  await confirm(a, 'Redefinir');
  await expectVisible(a.getByRole('button', { name: 'Criptografia não configurada' }), 'botão travado depois de redefinir', 15000);
  // A aba do Davi cai para a tela de entrar, com o motivo.
  await daviDesk.waitForURL(/\/login/, { timeout: 15000 });
  await expectVisible(daviDesk.getByText(T.resetByAdmin), 'motivo na tela de entrar', 15000);
  await shot(daviDesk, 'davi-entrar-motivo');
  await daviDesk.fill('form input >> nth=0', davi.username);
  await daviDesk.fill('input[type="password"]', PASSWORD);
  await daviDesk.click('button[type="submit"]');
  await daviDesk.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  await openRoom(daviDesk, group2, 'p');
  await expectVisible(banner(daviDesk).getByText(T.resetByAdmin), 'motivo na faixa da conversa');
  await shotDark(daviDesk, 'davi-faixa-redefinido-escuro');
  await banner(daviDesk).getByRole('button', { name: 'Configurar' }).click();
  const m = e2eModal(daviDesk, 'Configurar a criptografia');
  await expectVisible(m.getByText(T.resetByAdmin), 'motivo na configuração');
  await shot(daviDesk, 'davi-configurar-redefinido');
  await setupGenerated(daviDesk);
  await waitFor('aviso some depois de configurar', async () => ((await daviDesk.getByText(T.resetByAdmin).count()) === 0 ? true : null), 15000);
  await a.close();
});

// ---------- 17. Carla volta para o grupo: só lê dali para frente ----------
await step(17, 'Carla volta para o grupo com ninguém online: não lê nada de antes da volta, espera a chave nova e vê o aviso', async () => {
  // Ninguém com a chave do grupo fica com o chat aberto: a troca pedida pela volta espera alguém voltar.
  for (const p of [anaPage, brunoPage, daviDesk]) await p?.context().close().catch(() => {});
  anaPage = brunoPage = daviDesk = null;
  const before = await roomInfo(ana, groupRid);
  ok('Carla volta', await ana.api.call('POST', 'groups.invite', { roomId: groupRid, userId: carla.id }));
  const back = await roomInfo(ana, groupRid);
  assert(back.e2eRotate === true && back.e2eKeyId === before.e2eKeyId, 'a volta não pediu a troca de chave');
  if (DATABASE_URL) {
    assert(sql(`SELECT count(*) FROM e2e_room_keys WHERE room_id = '${groupRid}' AND user_id = '${carla.id}'`) === '0', 'a Carla recebeu uma chave de antes da volta');
    assert(sql(`SELECT returned_at IS NOT NULL FROM e2e_room_departures WHERE room_id = '${groupRid}' AND user_id = '${carla.id}'`) === 't', 'a volta da Carla não ficou registrada');
  }
  carlaPage = await open(carla);
  await openRoom(carlaPage, groupRid, 'p');
  await banner(carlaPage).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(carlaPage, carlaPass);
  await expectVisible(banner(carlaPage).getByText(T.waitingNew), 'Carla esperando a chave nova', 20000);
  await expectVisible(banner(carlaPage).getByText(T.returned), 'aviso de quem voltou', 20000);
  // O que veio antes da volta (inclusive o que ela já tinha lido) fica com o aviso da chave que ela não tem.
  await expectVisible(placeholders(carlaPage, T.oldKey), `"${T.oldKey}" nas mensagens de antes da volta`, 20000);
  assert(!(await placeholders(carlaPage, T.waitingMsg).count()), 'mensagem de antes da volta "esperando a chave" (ela não vem)');
  for (const text of ['Primeira do grupo', 'Carla chegou e lê tudo.', 'Depois da troca de chave.']) {
    assert(!(await bodyWith(carlaPage, text).count()), `a Carla leu "${text}", de antes da volta`);
  }
  // Sem a chave nova, o compositor dá lugar ao mesmo aviso da faixa.
  await expectVisible(carlaPage.locator('.room-main .composer-note', { hasText: T.waitingNew }), 'compositor esperando a chave nova');
  assert(!(await composer(carlaPage).count()), 'compositor habilitado sem a chave nova');
  await shot(carlaPage, 'carla-voltou-esperando');
  // Ana abre o chat: troca a chave, e a Carla recebe a nova sem pedir de novo.
  anaPage = await open(ana);
  await openRoom(anaPage, groupRid, 'p');
  await banner(anaPage).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(anaPage, anaPass);
  await expectVisible(bodyWith(anaPage, 'Depois da troca de chave.'), 'Ana lê o grupo', 20000);
  const fresh = await waitFor('chave nova depois da volta', async () => {
    const r = await roomInfo(ana, groupRid);
    return r.e2eKeyId && r.e2eKeyId !== before.e2eKeyId && !r.e2eRotate ? r : null;
  }, 30000);
  await waitFor('Carla com a chave nova', async () => (await composer(carlaPage).isEnabled()) || null, 40000);
  await waitFor('faixa de esperando some', async () => ((await banner(carlaPage).getByText(T.waitingNew).count()) === 0 ? true : null), 15000);
  await expectVisible(banner(carlaPage).getByText(T.returned), 'o aviso continua depois da chave nova');
  await send(carlaPage, 'Carla voltou e lê daqui para frente.');
  await expectVisible(bodyWith(anaPage, 'Carla voltou e lê daqui para frente.'), 'Ana lê a Carla', 20000);
  await send(anaPage, 'Bem-vinda de volta, Carla.');
  await expectVisible(bodyWith(carlaPage, 'Bem-vinda de volta, Carla.'), 'Carla lê o que veio depois da volta', 20000);
  assert(!(await bodyWith(carlaPage, 'Depois da troca de chave.').count()), 'a Carla leu o que veio enquanto estava fora');
  if (DATABASE_URL) {
    const held = sql(`SELECT string_agg(key_id, ',') FROM e2e_room_keys WHERE room_id = '${groupRid}' AND user_id = '${carla.id}'`);
    assert(held === fresh.e2eKeyId, `a Carla tem as gerações ${held}, esperada só a nova ${fresh.e2eKeyId}`);
  }
  await shot(carlaPage, 'carla-voltou-lendo');
  await shotDark(carlaPage, 'carla-voltou-lendo-escuro');
  // Celular: a frase inteira do aviso (quebra a linha), sem rolagem para o lado.
  const phone = await open(carla, { phone: true });
  await openRoom(phone, groupRid, 'p');
  await banner(phone).getByRole('button', { name: 'Desbloquear' }).click();
  await unlock(phone, carlaPass);
  await expectVisible(bodyWith(phone, 'Bem-vinda de volta, Carla.'), 'Carla lê no celular', 30000);
  const note = phone.locator('.e2e-banner.returned');
  await expectVisible(note.getByText(T.returned), 'aviso no celular');
  assert(await note.locator('.e2e-banner-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'aviso cortado no celular');
  assert(await phone.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1), 'rolagem horizontal no celular');
  await shot(phone, 'celular-carla-voltou');
  await phone.context().close();
  // Fechar o aviso: some, e continua fechado depois de recarregar.
  await banner(carlaPage).filter({ hasText: T.returned }).getByRole('button', { name: 'Fechar aviso' }).click();
  await waitFor('aviso fechado', async () => ((await carlaPage.getByText(T.returned).count()) === 0 ? true : null));
  await carlaPage.reload();
  await expectVisible(bodyWith(carlaPage, 'Bem-vinda de volta, Carla.'), 'Carla lê depois de recarregar', 30000);
  assert(!(await carlaPage.getByText(T.returned).count()), 'o aviso fechado voltou depois de recarregar');
  await expectVisible(placeholders(carlaPage, T.oldKey), 'mensagens de antes da volta continuam fechadas');
});

// ---------- Fim ----------

for (const ctx of contexts) await ctx.close().catch(() => {});
await browser.close();
const restore = { [RATE]: rateBefore ?? true };
if (e2eBefore !== undefined) restore.E2E_Enable = e2eBefore;
await admin.call('POST', 'settings', { settings: restore }).catch((e) => problems.push(`devolver configurações: ${e.message}`));
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ results, problems }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok, ${problems.length} problemas no navegador.`);
for (const x of problems.slice(0, 40)) console.log(`  ${x}`);
process.exit(results.every((r) => r.ok) && !problems.length ? 0 : 1);
