// Papéis e permissões v2 de ponta a ponta (spec D §9): lista, modelo de papel, permissões por grupo, revisão do
// sensível, matriz, concorrência, Quem pode…?, supervisor com delegação, papel inicial, simulação do acesso, papéis
// de sala, celular e o buraco do Admin › Salas fechado. Os passos 14 a 19 conferem os achados da revisão (lista sem
// rolagem lateral, rótulos e filtros da aba Permissões, sair da matriz, Quem pode…?, lote com 2FA, textos do
// supervisor, plano do modelo e o celular). Tira print de cada passo e sai com código 1 se algo falhar.
//
// Uso:
//   CHAT_URL=http://localhost:3104 PLAYWRIGHT_CORE=/caminho/playwright-core ADMIN_USER=admin ADMIN_PASSWORD=... \
//     node scripts/e2e/rbac-v2.mjs <pasta>
//
// Variáveis de ambiente:
//   CHAT_URL           endereço do chat com a web compilada. Obrigatória.
//   STEPS              passos a rodar, por exemplo 1,2,5 (padrão: todos). Os passos 2 a 4 criam o papel usado do 8 em diante
//                      (e no 18).
//   PLAYWRIGHT_CORE, CHROMIUM_PATH, ADMIN_USER, ADMIN_PASSWORD   como em scripts/visual/lib.mjs.
//
// Cria (ou reaproveita) e2e.ana (Supervisor de operação), e2e.bruno e e2e.carla (Operação), e2e.diego (Usuário) e
// e2e.ester (só vê o Admin › Salas), com uma senha nova a cada execução. Recria o papel supervisor-operacao pelo
// modelo, um canal de avisos e um grupo privado por execução. O 2FA obrigatório do modelo é desligado logo depois de
// criado, para a Ana entrar sem celular.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_URL = (process.env.CHAT_URL ?? '').replace(/\/+$/, '');
if (!CHAT_URL) {
  console.error('Defina CHAT_URL com o endereço do chat, por exemplo CHAT_URL=http://localhost:3104');
  process.exit(2);
}
process.env.BASE = CHAT_URL;
const lib = await import('../visual/lib.mjs');

const OUT = lib.outDir();
const STEPS = new Set((process.env.STEPS ?? '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19').split(',').map((s) => Number(s.trim())));
const PASSWORD = `E2e-${crypto.randomBytes(6).toString('hex')}!`;
const RUN = Date.now().toString(36);
const SUP = 'supervisor-operacao';

// ---------- API ----------

const admin = lib.client(await lib.login(lib.ADMIN_USER, lib.ADMIN_PASSWORD));
const ok = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};

const PEOPLE = {
  ana: { username: 'e2e.ana', name: 'Ana Supervisora', roles: ['user'] },
  bruno: { username: 'e2e.bruno', name: 'Bruno Operador', roles: ['operacao'] },
  carla: { username: 'e2e.carla', name: 'Carla Operadora', roles: ['operacao'] },
  diego: { username: 'e2e.diego', name: 'Diego Usuário', roles: ['user'] },
  ester: { username: 'e2e.ester', name: 'Ester Salas', roles: ['user'] },
  // Nome comprido: a marca "Restrita" no Quem pode…? não pode sumir nas reticências.
  longo: { username: 'e2e.longo', name: 'Fernanda Albuquerque de Oliveira Santos Cavalcanti', roles: ['operacao'] },
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
}

const roleOf = async (id) => ok('rbac.roles', await admin.call('GET', 'rbac.roles')).roles.find((r) => r._id === id);
async function setRoles(p, roles) {
  ok(`users.update ${p.username}`, await admin.call('POST', 'users.update', { userId: p.id, data: { roles } }));
}

// Papel do modelo de uma execução anterior: tira de quem tem e exclui, para o modelo nascer com o mesmo id.
async function dropRole(id) {
  if (!(await roleOf(id))) return;
  const holders = ok('getUsersInRole', await admin.call('GET', 'roles.getUsersInRole', { role: id, count: 200 })).users;
  for (const u of holders) {
    const roles = u.roles.filter((r) => r !== id);
    ok('users.update', await admin.call('POST', 'users.update', { userId: u._id, data: { roles: roles.length ? roles : ['user'] } }));
  }
  ok(`rbac.roles.delete ${id}`, await admin.call('POST', 'rbac.roles.delete', { roleId: id }));
}

// Muitas telas e abas ao mesmo tempo: o limite de requisições da API fica desligado durante o roteiro e volta no fim.
const RATE = 'API_Enable_Rate_Limiter';
const rateBefore = ok('settings', await admin.call('GET', 'settings')).settings.find((x) => x._id === RATE)?.value;
if (rateBefore !== false) ok('settings', await admin.call('POST', 'settings', { settings: { [RATE]: false } }));

for (const p of Object.values(PEOPLE)) await ensurePerson(p);
await dropRole(SUP);
// O passo 6 mexe na Operação: começa sem as duas chaves e devolve no fim.
const OP_TOUCHED = ['mention-here', 'create-personal-stickers', 'create-p'];
const opBefore = (await roleOf('operacao')).permissions;
const opReset = OP_TOUCHED.filter((k) => opBefore.includes(k));
if (opReset.length) ok('matrix reset', await admin.call('POST', 'rbac.matrix.update', { changes: [{ roleId: 'operacao', add: [], remove: opReset }] }));

// ---------- Navegador ----------

const chromium = await lib.loadChromium();
const browser = await chromium.launch({ executablePath: lib.executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const DESK = { viewport: { width: 1366, height: 850 } };
const PIXEL7 = { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' };

const problems = [];
const pages = [];

async function open(who, { phone = false, scheme = 'light', url = '/home' } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PIXEL7 : DESK), colorScheme: scheme, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  const name = `${who.username}${phone ? '/celular' : ''}${scheme === 'dark' ? '/escuro' : ''}`;
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${name} console: ${m.text()}`.slice(0, 400)));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`${name} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(CHAT_URL, '')}`);
  });
  await page.goto(`${CHAT_URL}/login`);
  await page.fill('form input >> nth=0', who.username);
  await page.fill('input[type="password"]', who.password ?? PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  if (url) await page.goto(`${CHAT_URL}${url}`);
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
const expectText = (page, text, timeout) => expectVisible(page.getByText(text, { exact: false }), `"${text}"`, timeout);
const assert = (cond, what) => {
  if (!cond) throw new Error(what);
};
const toast = (page, text) => expectVisible(page.locator('.toast-text, .toast').filter({ hasText: text }), `aviso "${text}"`);
const noOops = async (page) => assert(!(await page.getByText('Algo deu errado').count()), 'a tela mostrou "Algo deu errado"');
// Sem rolagem horizontal da página (nem no corpo que rola).
const noHScroll = (page) =>
  page.evaluate(() => {
    const els = [document.scrollingElement, ...document.querySelectorAll('.page-body')];
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
    console.log(`FALHA ${n}. ${title}: ${e.message}`);
  }
}

const ADMIN = { username: lib.ADMIN_USER, password: lib.ADMIN_PASSWORD };
const adminPage = await open(ADMIN, { url: '/admin/permissions' });

// ---------- 1. Abre ----------
await step(1, 'Papéis e permissões abre com Arquivos no Acesso', async () => {
  const p = adminPage;
  await expectVisible(p.locator('table.rbac-roles'), 'tabela de papéis');
  await expectVisible(p.locator('.rbac-reach-group[aria-label^="Arquivos:"]'), 'Arquivos no Acesso');
  await expectVisible(p.getByRole('radio', { name: 'Matriz' }), 'visão Matriz');
  await noOops(p);
  await shot(p, 'papeis-lista');
});

// ---------- 2. Modelo ----------
await step(2, 'Novo papel pelo modelo Supervisor de operação', async () => {
  const p = adminPage;
  await p.getByRole('button', { name: 'Novo papel' }).click();
  const dlg = p.getByRole('dialog');
  await dlg.getByRole('radio', { name: 'Modelo' }).click();
  await dlg.locator('.rbac-template-card', { hasText: 'Supervisor de operação' }).click();
  await expectText(dlg, 'Já vem com a delegação: quem tiver o papel pode dar Operação.');
  await shot(p, 'novo-papel-modelo');
  await dlg.getByRole('button', { name: 'Criar e abrir' }).click();
  await p.waitForURL(new RegExp(`/admin/permissions/role/${SUP}\\?tab=perms`), { timeout: 10000 });
  const chip = p.locator('.rbac-perm-tools .rbac-chips button', { hasText: 'Administração' });
  await expectVisible(chip, 'chip Administração');
  assert(/\d+\/\d+/.test(await chip.innerText()), 'chip Administração sem contagem');
  const key = p.locator('label.rbac-key[data-key="assign-roles"]');
  await expectVisible(key, 'Dar e tirar papéis de pessoas');
  assert(await key.locator('input').isChecked(), '"Dar e tirar papéis de pessoas" não veio marcado');
  assert((await key.innerText()).includes('Sensível'), 'sem a marca Sensível');
  await shot(p, 'editor-permissoes');
  // Para a Ana entrar sem celular.
  ok('2FA', await admin.call('POST', 'rbac.roles.update', { roleId: SUP, mandatory2fa: false }));
});

// ---------- 3. Permissões por grupo ----------
await step(3, 'Chips de grupo e busca em todas as permissões', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/role/${SUP}?tab=perms`);
  await p.locator('.rbac-perm-tools .rbac-chips button', { hasText: 'Arquivos' }).click();
  await expectText(p, 'Pastas e arquivos');
  await shot(p, 'editor-grupo-arquivos');
  await p.getByRole('searchbox', { name: 'Buscar permissões' }).fill('senha');
  await expectVisible(p.locator('label.rbac-key[data-key="edit-other-user-password"]'), 'Trocar a senha de outras pessoas');
  assert(await p.locator('#rbac-group-admin').count(), 'a busca não veio de Administração');
  await shot(p, 'editor-busca-senha');
  await p.getByRole('searchbox', { name: 'Buscar permissões' }).fill('');
});

// ---------- 4. Revisão sensível ----------
await step(4, 'Revisão pede "Entendi" para permissão sensível', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/role/${SUP}?tab=perms`);
  await p.getByRole('searchbox', { name: 'Buscar permissões' }).fill('auditar');
  await p.locator('label.rbac-key[data-key="can-audit"] input').check();
  await p.locator('.rbac-editor-actions').getByRole('button', { name: 'Salvar' }).click();
  const dlg = p.getByRole('dialog');
  await expectText(dlg, 'Sensível: Auditar mensagens. Lê mensagens de qualquer conversa, inclusive as diretas.');
  const save = dlg.getByRole('button', { name: 'Salvar alterações' });
  assert(await save.isDisabled(), '"Salvar alterações" ligado antes do Entendi');
  await shot(p, 'revisao-sensivel');
  await dlg.getByText('Entendi o que estas permissões liberam.').click();
  assert(await save.isEnabled(), '"Salvar alterações" não ligou com o Entendi');
  await save.click();
  await toast(p, 'salvo');
  assert((await roleOf(SUP)).permissions.includes('can-audit'), 'can-audit não gravou');
  await p.locator('label.rbac-key[data-key="can-audit"] input').uncheck();
  await p.locator('.rbac-editor-actions').getByRole('button', { name: 'Salvar' }).click();
  const save2 = p.getByRole('dialog').getByRole('button', { name: 'Salvar alterações' });
  assert(await save2.isEnabled(), 'tirar a sensível não deveria pedir Entendi');
  await save2.click();
  await p.getByRole('dialog').waitFor({ state: 'detached' });
  assert(!(await roleOf(SUP)).permissions.includes('can-audit'), 'can-audit não saiu');
});

// ---------- 5. Matriz ----------
await step(5, 'Matriz: Só diferenças, célula, barra de salvar e aviso de brecha', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions`);
  await p.getByRole('radio', { name: 'Matriz' }).click();
  await p.waitForURL(/\/admin\/permissions\/matrix/);
  await expectVisible(p.locator('table.rbac-matrix'), 'matriz');
  await shot(p, 'matriz-padrao');
  // Os dois papéis pelo menu "Papéis".
  await p.getByRole('button', { name: /^Papéis/ }).click();
  const menu = p.getByRole('menu');
  const extra = menu.getByRole('menuitemcheckbox', { checked: true }).filter({ hasNotText: /^(Operação|Supervisor de operação)$/ });
  // Cada clique muda a URL e a matriz redesenha; espera o item mudar antes do próximo.
  const checked = () => p.evaluate(() => document.querySelectorAll('[role=menu] [role=menuitemcheckbox][aria-checked=true]').length);
  const changed = (n) => p.waitForFunction((n) => document.querySelectorAll('[role=menu] [role=menuitemcheckbox][aria-checked=true]').length !== n, n);
  for (const want of ['Operação', 'Supervisor de operação']) {
    const item = menu.getByRole('menuitemcheckbox', { name: want, exact: true });
    if ((await item.getAttribute('aria-checked')) === 'true') continue;
    const n = await checked();
    await item.click();
    await changed(n);
  }
  while (await extra.count()) {
    const n = await checked();
    await extra.first().click();
    await changed(n);
  }
  await p.keyboard.press('Escape');
  await expectVisible(p.locator('.rbac-matrix-role', { hasText: 'Supervisor de operação' }), 'coluna Supervisor');
  assert((await p.locator('.rbac-matrix-role').count()) === 2, 'a matriz não ficou com dois papéis');
  const rows = await p.locator('.rbac-matrix-row').count();
  await p.locator('.rbac-matrix-toggles').getByText('Só diferenças').click();
  await p.waitForURL(/diff=1/);
  await p.waitForFunction((n) => document.querySelectorAll('.rbac-matrix-row').length < n, rows, { timeout: 5000 }).catch(() => {});
  const fewer = await p.locator('.rbac-matrix-row').count();
  assert(fewer < rows, `Só diferenças não reduziu as linhas (${rows} → ${fewer})`);
  const cell = p.locator('button.rbac-cell[aria-label^="Operação não tem: Criar grupos privados"]');
  await expectVisible(cell, 'célula Criar grupos privados da Operação');
  await cell.click();
  await expectText(p.locator('.rbac-savebar'), '1 alteração em 1 papel');
  await shot(p, 'matriz-diferencas');
  await p.getByRole('button', { name: 'Revisar e salvar' }).click();
  await expectText(p.getByRole('dialog'), 'O papel é restrito em conversas diretas, mas deixa criar grupos privados');
  await shot(p, 'matriz-revisao');
  await p.getByRole('dialog').getByRole('button', { name: 'Voltar à matriz' }).click();
  await p.locator('.rbac-savebar').getByRole('button', { name: 'Descartar' }).click();
  assert(!(await p.locator('.rbac-savebar').count()), 'a barra de salvar não sumiu');
});

// ---------- 6. Concorrência ----------
await step(6, 'Duas abas: editor avisa e as duas mudanças ficam', async () => {
  const a = adminPage;
  await a.goto(`${CHAT_URL}/admin/permissions/role/operacao?tab=perms`);
  await a.getByRole('searchbox', { name: 'Buscar permissões' }).fill('here');
  await a.locator('label.rbac-key[data-key="mention-here"] input').check();
  const b = await open(ADMIN, { url: '/admin/permissions/matrix?roles=operacao&q=figurinhas' });
  const cell = b.locator('button.rbac-cell[aria-label^="Operação não tem: Criar figurinhas pessoais"]');
  await expectVisible(cell, 'célula Criar figurinhas pessoais');
  await cell.click();
  await b.getByRole('button', { name: 'Revisar e salvar' }).click();
  await b.getByRole('dialog').getByRole('button', { name: 'Salvar alterações' }).click();
  await toast(b, 'Matriz salva: 1 papel.');
  // A mesma pessoa em outra aba: o aviso fala com ela, não dela.
  await expectText(a, 'Você alterou este papel em outra aba. Ao salvar, só as mudanças desta tela são aplicadas.');
  await shot(a, 'editor-aviso-concorrencia');
  // Outro campo salvo no meio-tempo (Exigir 2FA): salvar as permissões daqui não o desfaz.
  ok('2FA da Operação', await admin.call('POST', 'rbac.roles.update', { roleId: 'operacao', mandatory2fa: true }));
  try {
    await a.locator('.rbac-editor-actions').getByRole('button', { name: 'Salvar' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Salvar alterações' }).click();
    await toast(a, 'salvo');
    const op = await roleOf('operacao');
    assert(op.permissions.includes('mention-here') && op.permissions.includes('create-personal-stickers'), `a Operação não ficou com as duas (${op.permissions.filter((k) => OP_TOUCHED.includes(k)).join(', ')})`);
    assert(op.mandatory2fa === true, 'salvar o editor desfez o "Exigir 2FA" salvo pela outra aba');
  } finally {
    ok('2FA da Operação', await admin.call('POST', 'rbac.roles.update', { roleId: 'operacao', mandatory2fa: false }));
  }
  await b.context().close();
  ok('matrix reset', await admin.call('POST', 'rbac.matrix.update', { changes: [{ roleId: 'operacao', add: [], remove: ['mention-here', 'create-personal-stickers'] }] }));
});

// ---------- 7. Quem pode…? ----------
await step(7, 'Quem pode…?: atalho com a nota da Operação e papéis de sala', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions`);
  await p.getByRole('radio', { name: 'Quem pode…?' }).click();
  await p.getByRole('button', { name: 'Quem conversa em particular com outras pessoas restritas?' }).click();
  await p.waitForURL(/key=start-dm-between-restricted/);
  await expectVisible(p.locator('.rbac-who-roles strong', { hasText: 'Administrador' }), 'Administrador nos papéis');
  await expectText(p, 'Pessoas restritas em conversas diretas (Operação) só conversam com quem não é restrito');
  await shot(p, 'quem-pode-restritas');
  const search = p.getByRole('combobox', { name: 'Busque uma ação' });
  await search.fill('apagar mensagens de outras');
  await p.getByRole('option', { name: /Apagar mensagens de outras pessoas/ }).first().click();
  await p.waitForURL(/key=delete-message/);
  const room = p.locator('.rbac-section', { hasText: 'Papéis de sala' });
  await expectVisible(room.locator('strong', { hasText: 'Dono' }), 'Dono nos papéis de sala');
  await expectVisible(room.locator('strong', { hasText: 'Moderador' }), 'Moderador nos papéis de sala');
  await shot(p, 'quem-pode-apagar');
});

// ---------- 8. Supervisor ----------
let ana;
await step(8, 'Supervisor: cadeado no admin, prévia do lote e delegação', async () => {
  const sup = await roleOf(SUP);
  assert(sup, 'papel supervisor-operacao não existe (rode os passos 2 a 4)');
  await setRoles(PEOPLE.ana, [SUP]);
  ana = await open(PEOPLE.ana, { url: '/admin/users' });
  const adminRow = ana.locator('table.rbac-users tbody tr', { hasText: `@${lib.ADMIN_USER}` });
  await expectVisible(adminRow, 'linha do admin');
  await expectVisible(adminRow.locator('.rbac-lock-tag'), 'cadeado na linha do admin');
  await adminRow.locator('.row-menu button').click();
  await expectVisible(ana.getByRole('menu').getByRole('menuitem', { name: 'Ver' }), 'menu "Ver"');
  assert(!(await ana.getByRole('menu').getByRole('menuitem', { name: 'Editar' }).count()), 'o menu do admin diz Editar');
  await ana.keyboard.press('Escape');
  for (const u of [PEOPLE.bruno.username, PEOPLE.carla.username, lib.ADMIN_USER]) await ana.getByLabel(`Selecionar @${u}`).check();
  await ana.locator('.rbac-bulk').getByRole('button', { name: 'Adicionar papel' }).click();
  const auditor = ana.getByRole('menu').getByRole('menuitem', { name: 'Auditor', exact: true });
  await expectVisible(auditor, 'Auditor no menu');
  assert(await auditor.isDisabled(), 'Auditor deveria estar travado');
  assert(await auditor.locator('svg').count(), 'Auditor sem cadeado');
  await shot(ana, 'supervisor-adicionar-papel');
  await ana.keyboard.press('Escape');
  // Tirar a Operação de quem só tem ela deixaria a pessoa com Usuário, que a supervisora não dá: fica de fora.
  await ana.locator('.rbac-bulk').getByRole('button', { name: 'Remover papel' }).click();
  await ana.getByRole('menu').getByRole('menuitem', { name: 'Operação', exact: true }).click();
  const dlg = ana.getByRole('dialog');
  await expectText(dlg, '0 perdem');
  await expectText(dlg, '3 ficam de fora');
  await expectText(dlg, 'Ficaria só com Usuário, e esse papel você não pode dar.');
  await expectText(dlg, `@${lib.ADMIN_USER}`);
  await expectText(dlg, 'Restrito em conversas diretas:');
  assert(await dlg.getByRole('button', { name: /^Aplicar a/ }).isDisabled(), '"Aplicar" ligado sem ninguém para mudar');
  await shot(ana, 'supervisor-previa-lote');
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert(JSON.stringify((await admin.call('GET', 'users.info', { userId: PEOPLE.bruno.id })).user.roles) === '["operacao"]', 'o Bruno mudou de papel');
  // Desativar em lote: uma chamada só (sem esbarrar no limite por minuto); o admin com cadeado fica de fora.
  const calls = [];
  const onReq = (r) => r.url().includes('/api/v1/users.') && calls.push(r.url().split('/api/v1/')[1].split('?')[0]);
  ana.on('request', onReq);
  await ana.locator('.rbac-bulk').getByRole('button', { name: /^Desativar/ }).click();
  await ana.getByRole('dialog').getByRole('button', { name: 'Desativar', exact: true }).click();
  await toast(ana, 'Desativadas: 2 pessoas (1 com cadeado ficou de fora).');
  ana.off('request', onReq);
  assert(calls.filter((c) => c === 'users.bulkSetActiveStatus').length === 1 && !calls.includes('users.setActiveStatus'), `chamadas: ${calls.join(', ')}`);
  await shot(ana, 'supervisor-desativar-lote');
  for (const p of [PEOPLE.bruno, PEOPLE.carla]) ok('reativar', await admin.call('POST', 'users.setActiveStatus', { userId: p.id, activeStatus: true }));
});

// ---------- 9. Novo usuário ----------
await step(9, 'Novo usuário com papel inicial restrito', async () => {
  if (!ana) ana = await open(PEOPLE.ana, { url: '/admin/users' });
  await ana.goto(`${CHAT_URL}/admin/users`);
  await ana.getByRole('button', { name: 'Novo usuário' }).click();
  const dlg = ana.getByRole('dialog');
  const username = `e2e.op${RUN}`;
  await dlg.getByLabel('Nome', { exact: true }).fill('Operador Novo');
  await dlg.getByLabel('Nome de usuário').fill(username);
  await dlg.getByLabel('E-mail').fill(`${username}@example.com`);
  await dlg.getByLabel('Senha').fill(PASSWORD);
  await dlg.getByLabel('Papel inicial').selectOption({ label: 'Operação (restrito)' });
  await shot(ana, 'novo-usuario-papel-inicial');
  await dlg.getByRole('button', { name: 'Criar e abrir' }).click();
  await ana.waitForURL(/\/admin\/users\/edit\//);
  await ana.getByRole('tab', { name: 'Acesso & Papéis' }).click();
  const on = await ana.locator('.rbac-role-chips .chip.on').allInnerTexts();
  assert(on.length === 1 && on[0].startsWith('Operação'), `papéis do novo usuário: ${on.join(', ')}`);
  const id = ana.url().split('/').pop();
  const eff = ok('effective', await admin.call('GET', 'rbac.users.effective', { userId: id }));
  assert(!eff.areas.some((a) => a.keys.some((k) => k.key === 'create-p')), 'o acesso efetivo tem Criar grupos privados');
  await shot(ana, 'novo-usuario-editor');
});

// ---------- 10. Simulação ----------
await step(10, 'Simulação do acesso antes de salvar', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/users/edit/${PEOPLE.diego.id}`);
  await p.getByRole('tab', { name: 'Acesso & Papéis' }).click();
  await p.locator('.rbac-role-chips label', { hasText: /^Auditor/ }).first().click();
  await expectVisible(p.getByRole('radio', { name: 'Depois de salvar', checked: true }), '"Depois de salvar" escolhido');
  const change = p.locator('.rbac-eff-change');
  await expectVisible(change.locator('.rbac-review-row.up', { hasText: 'Auditoria' }), 'Auditoria com seta para cima');
  await expectText(change, 'Sensível: Auditar mensagens.');
  await shot(p, 'simulacao-depois-de-salvar');
  await p.getByRole('button', { name: 'Reverter' }).click();
  assert(!(await p.locator('.rbac-eff-change').count()), 'a simulação continuou depois de Reverter');
});

// ---------- 11. Papéis em salas ----------
await step(11, 'Papéis de sala no editor do papel e no da pessoa', async () => {
  const name = `avisos-${RUN}`;
  const ch = ok('channels.create', await admin.call('POST', 'channels.create', { name, members: [PEOPLE.diego.username], extraData: { notice: true } })).channel;
  ok('addUserToRole', await admin.call('POST', 'roles.addUserToRole', { roleName: 'publisher', username: PEOPLE.diego.username, roomId: ch._id }));
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/role/publisher?tab=people`);
  const row = p.locator('.rbac-roomroles tr', { hasText: name });
  await expectVisible(row, `canal ${name} na aba Pessoas`);
  await expectVisible(row.getByText(PEOPLE.diego.name), 'Diego na linha');
  await shot(p, 'papel-de-sala-pessoas');
  await p.goto(`${CHAT_URL}/admin/users/edit/${PEOPLE.diego.id}`);
  await p.getByRole('tab', { name: 'Acesso & Papéis' }).click();
  await expectText(p, `Publicador em #${name}`);
  await p.locator('.rbac-roomroles-lines').scrollIntoViewIfNeeded();
  await shot(p, 'papeis-em-salas-pessoa');
});

// ---------- 12. Celular ----------
await step(12, 'Celular: abas rotuladas, Comparar e Quem pode…? numa coluna', async () => {
  const p = await open(ADMIN, { phone: true, url: '/admin/permissions/role/operacao' });
  const tabs = p.locator('.rbac-tabbar [role="tab"]');
  await expectVisible(tabs, 'abas');
  assert((await tabs.count()) === 4, 'o editor não tem 4 abas');
  for (const t of await tabs.all()) assert(await t.locator('span').isVisible(), `aba sem rótulo: ${await t.getAttribute('title')}`);
  assert(await noHScroll(p), 'rolagem horizontal no editor');
  await shot(p, 'celular-editor');
  await p.goto(`${CHAT_URL}/admin/permissions/matrix`);
  await expectVisible(p.getByLabel('Papel A'), 'Papel A');
  await expectVisible(p.getByLabel('Papel B'), 'Papel B');
  const box = await p.locator('.rbac-compare-cell .rbac-cell').first().boundingBox();
  assert(box && Math.round(box.width) >= 44 && Math.round(box.height) >= 44, `célula com ${box?.width}x${box?.height}`);
  assert(await noHScroll(p), 'rolagem horizontal no Comparar');
  await shot(p, 'celular-comparar');
  await p.goto(`${CHAT_URL}/admin/permissions/who?key=create-p`);
  await expectVisible(p.locator('.rbac-who-card'), 'card do Quem pode…?');
  const main = await p.locator('.rbac-who-main').boundingBox();
  const side = await p.locator('.rbac-who > .rbac-section').boundingBox();
  assert(main && side && side.y >= main.y + main.height - 1, 'Quem pode…? não ficou em uma coluna');
  assert(await noHScroll(p), 'rolagem horizontal no Quem pode…?');
  await shot(p, 'celular-quem-pode');
  // Escuro no celular.
  const d = await open(ADMIN, { phone: true, scheme: 'dark', url: '/admin/permissions/role/operacao?tab=perms' });
  await expectVisible(d.locator('.rbac-perm-tools'), 'aba Permissões');
  await shot(d, 'celular-permissoes-escuro');
  await p.context().close();
  await d.context().close();
});

// Escuro no desktop: as telas novas.
await step(12, 'Desktop escuro: lista, matriz e Quem pode…?', async () => {
  const d = await open(ADMIN, { scheme: 'dark', url: '/admin/permissions' });
  await expectVisible(d.locator('table.rbac-roles'), 'lista');
  await shot(d, 'escuro-lista');
  await d.goto(`${CHAT_URL}/admin/permissions/matrix?roles=admin,operacao,owner&group=chat`);
  await expectVisible(d.locator('table.rbac-matrix'), 'matriz');
  await shot(d, 'escuro-matriz');
  await d.goto(`${CHAT_URL}/admin/permissions/who?key=delete-message`);
  await expectVisible(d.locator('.rbac-who-card'), 'Quem pode…?');
  await shot(d, 'escuro-quem-pode');
  await d.context().close();
});

// ---------- 13. Buraco fechado ----------
await step(13, 'Admin › Salas: só Visualizar não adiciona pessoas', async () => {
  const role = `e2e-salas-${RUN}`;
  ok('rbac.roles.create', await admin.call('POST', 'rbac.roles.create', { name: role, description: 'Só vê salas', scope: 'Users', permissions: ['view-room-administration'] }));
  await setRoles(PEOPLE.ester, [role]);
  const group = ok('groups.create', await admin.call('POST', 'groups.create', { name: `privado-${RUN}` })).group;
  const ester = lib.client(await lib.login(PEOPLE.ester.username, PASSWORD));
  const r = await ester.call('POST', 'rooms.adminRooms.addUser', { roomId: group._id, userId: PEOPLE.diego.id });
  assert(r.success === false && /Sem permissão para adicionar pessoas a esta sala/.test(r.error ?? ''), `addUser respondeu ${JSON.stringify(r).slice(0, 200)}`);
  await setRoles(PEOPLE.ester, ['user']);
  ok('rbac.roles.delete', await admin.call('POST', 'rbac.roles.delete', { roleId: role }));
});

// ---------- 14. Lista sem rolagem lateral e o submenu Comparar com… ----------
await step(14, 'Lista cabe em 1366, 1280 e 1200; Comparar com… pelo teclado', async () => {
  const p = adminPage;
  await p.setViewportSize({ width: 1366, height: 850 });
  await p.goto(`${CHAT_URL}/admin/permissions`);
  await expectVisible(p.locator('table.rbac-roles'), 'lista');
  assert(await noHScroll(p), 'rolagem horizontal na lista a 1366');
  // Foco no menu da última linha não arrasta a página para o lado.
  const trigger = p.locator('table.rbac-roles tbody tr').last().locator('.row-menu button');
  await trigger.focus();
  assert(await noHScroll(p), 'rolagem horizontal com foco no menu da linha');
  const x0 = await p.evaluate(() => document.querySelector('.page-body')?.scrollLeft ?? 0);
  assert(x0 === 0, `a página andou para o lado (${x0}px)`);
  await p.keyboard.press('Enter');
  const menu = p.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Comparar com…' }).focus();
  await p.keyboard.press('Enter');
  const focused = () => p.evaluate(() => ({ inMenu: !!document.activeElement?.closest('[role=menu]'), text: document.activeElement?.textContent?.trim() ?? '', tag: document.activeElement?.tagName }));
  const f1 = await focused();
  assert(f1.inMenu && f1.tag === 'BUTTON' && f1.text !== 'Comparar com…', `foco depois de abrir o submenu: ${f1.tag} "${f1.text}"`);
  await p.keyboard.press('ArrowDown');
  const f2 = await focused();
  assert(f2.inMenu && f2.text !== f1.text, `ArrowDown não andou no submenu (${f1.text} → ${f2.text})`);
  const fits = await p.evaluate(() => {
    const el = document.querySelector('[role=menu] .rbac-menu-scroll');
    return el ? el.scrollHeight <= el.clientHeight + 1 : false;
  });
  assert(fits, 'a lista do Comparar com… ficou cortada');
  await shot(p, 'lista-comparar-teclado');
  await p.keyboard.press('Escape');
  for (const w of [1280, 1200]) {
    await p.setViewportSize({ width: w, height: 850 });
    await p.waitForTimeout(200);
    assert(await noHScroll(p), `rolagem horizontal na lista a ${w}`);
  }
  await shot(p, 'lista-1200');
  await p.setViewportSize({ width: 1366, height: 850 });
});

// ---------- 15. Aba Permissões: rótulos e filtros ----------
await step(15, 'Dono › Permissões: rótulo inteiro com as marcas e filtros opacos', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/role/owner?tab=perms`);
  const name = p.locator('label.rbac-key[data-key="start-dm-between-restricted"] .rbac-key-name');
  await expectVisible(name, 'Conversar em particular entre pessoas restritas');
  const box = await name.boundingBox();
  assert(box && box.width >= 180 && box.height <= 40, `rótulo espremido (${Math.round(box?.width)}x${Math.round(box?.height)})`);
  await name.scrollIntoViewIfNeeded();
  await shot(p, 'dono-rotulos');
  await p.evaluate(() => document.querySelector('.page-body')?.scrollBy(0, 1400));
  await p.waitForTimeout(300);
  const tools = await p.evaluate(() => {
    const el = document.querySelector('.rbac-perm-tools');
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, top: Math.round(el.getBoundingClientRect().top) };
  });
  assert(!/rgba\(.*, 0\.\d+\)/.test(tools.bg) && tools.shadow !== 'none', `filtros transparentes (${tools.bg}, ${tools.shadow})`);
  await shot(p, 'permissoes-filtros-presos');
});

// ---------- 16. Matriz: sair pela navegação ----------
await step(16, 'Matriz: a navegação da administração pergunta antes de descartar; célula sem efeito com nome', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/matrix?roles=owner,operacao&q=figurinhas`);
  const cell = p.locator('button.rbac-cell[aria-label^="Operação não tem: Criar figurinhas pessoais"]');
  await expectVisible(cell, 'célula Criar figurinhas pessoais');
  const inert = await p.locator('button.rbac-cell[data-state="inert"]').first().getAttribute('aria-label');
  assert(inert?.startsWith('Dono · ') && inert.includes('sem efeito'), `célula sem efeito: "${inert}"`);
  await cell.click();
  await expectVisible(p.locator('.rbac-savebar'), 'barra de salvar');
  await p.locator('.page-nav a', { hasText: 'Usuários' }).click();
  const confirm = p.getByRole('dialog').filter({ hasText: 'Descartar as alterações?' });
  await expectVisible(confirm, 'pergunta "Descartar as alterações?"');
  await shot(p, 'matriz-sair-pela-navegacao');
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  assert(/\/admin\/permissions\/matrix/.test(p.url()) && (await p.locator('.rbac-savebar').count()), 'Cancelar saiu da matriz');
  await p.locator('.page-nav a', { hasText: 'Usuários' }).click();
  await p.getByRole('dialog').filter({ hasText: 'Descartar as alterações?' }).getByRole('button', { name: 'Descartar' }).click();
  await p.waitForURL(/\/admin\/users$/);
  assert(!(await roleOf('operacao')).permissions.includes('create-personal-stickers'), 'a matriz gravou ao sair');
  // Histórico do lote: papéis pelo nome, sem @.
  const batch = ok('lote', await admin.call('POST', 'rbac.matrix.update', { changes: [{ roleId: 'operacao', add: ['mention-here'], remove: [] }, { roleId: 'guest', add: ['mention-here'], remove: [] }] }));
  ok('lote', await admin.call('POST', 'rbac.matrix.update', { changes: [{ roleId: 'operacao', add: [], remove: ['mention-here'] }, { roleId: 'guest', add: [], remove: ['mention-here'] }] }));
  assert(batch.batchId, 'o lote não veio com batchId');
  await p.goto(`${CHAT_URL}/admin/permissions/history`);
  const nested = p.locator('.rbac-event.nested strong');
  await expectVisible(nested, 'linhas do lote');
  const names = await nested.allInnerTexts();
  assert(names.includes('Operação') && names.includes('Convidado') && !names.some((n) => n === '@operacao' || n === '@guest'), `linhas do lote: ${names.slice(0, 6).join(', ')}`);
  await shot(p, 'historico-lote');
});

// ---------- 17. Quem pode…? ----------
await step(17, 'Quem pode…?: marca Restrita com nome longo, pessoas distintas e a busca', async () => {
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions/who?key=create-d`);
  await p.getByRole('searchbox', { name: 'Filtrar pessoas' }).fill(PEOPLE.longo.username);
  const row = p.locator('.rbac-people-row', { hasText: PEOPLE.longo.name.slice(0, 20) });
  await expectVisible(row, 'linha da Fernanda');
  const tag = row.locator('.pill', { hasText: 'Restrita' });
  await expectVisible(tag, 'marca Restrita');
  const [t, r] = [await tag.boundingBox(), await row.boundingBox()];
  assert(t && r && t.x + t.width <= r.x + r.width, 'a marca Restrita saiu da linha');
  const clipped = await row.evaluate((el) => {
    const pill = el.querySelector('.pill.warn');
    const name = el.querySelector('.cell-name');
    return pill.getBoundingClientRect().right > name.getBoundingClientRect().right + 0.5;
  });
  assert(!clipped, 'a marca Restrita ficou cortada pelo nome');
  await shot(p, 'quem-pode-restrita-nome-longo');
  // Papéis de sala: pessoas distintas, como no resto da tela.
  await p.goto(`${CHAT_URL}/admin/permissions/who?key=delete-message`);
  const api = ok('whoCan', await admin.call('GET', 'rbac.whoCan', { permission: 'delete-message' }));
  const owner = api.roomRoles.find((x) => x._id === 'owner');
  const line = p.locator('.rbac-section', { hasText: 'Papéis de sala' }).locator('li', { hasText: 'Dono' }).locator('.muted.small');
  const text = await line.innerText();
  const n = Number(text.match(/^(\d+)/)?.[1]);
  assert(n === owner.users, `Dono: "${text}" (API: ${owner.users} pessoas, ${owner.assignments} atribuições)`);
  // Busca: sem resultado diz; Esc fecha e guarda o texto; o segundo Esc limpa.
  const search = p.getByRole('combobox', { name: 'Busque uma ação' });
  await search.fill('xyzabc');
  await expectText(p, 'Nenhuma permissão para “xyzabc”.');
  await shot(p, 'quem-pode-sem-resultado');
  await search.fill('senha');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Escape');
  assert((await search.inputValue()) === 'senha' && !(await p.locator('#rbac-who-options').count()), 'o primeiro Esc não só fechou a lista');
  await p.keyboard.press('Escape');
  assert((await search.inputValue()) === '', 'o segundo Esc não limpou');
  await search.fill('apagar');
  const lb = await p.getByRole('listbox', { name: 'Permissões' }).boundingBox();
  assert(lb && lb.x >= 0 && lb.x + lb.width <= 1366, `sugestões fora da janela (${Math.round(lb?.x)}→${Math.round((lb?.x ?? 0) + (lb?.width ?? 0))})`);
  await shot(p, 'quem-pode-sugestoes');
  await search.fill('');
  // Celular: o campo e as sugestões cabem na tela.
  const m = await open(ADMIN, { phone: true, url: '/admin/permissions/who' });
  const ms = m.getByRole('combobox', { name: 'Busque uma ação' });
  await ms.fill('apagar');
  await expectVisible(m.getByRole('listbox', { name: 'Permissões' }), 'sugestões no celular');
  const sb = await m.locator('.rbac-who-search .rbac-search').boundingBox();
  const mb = await m.getByRole('listbox', { name: 'Permissões' }).boundingBox();
  assert(sb && sb.x + sb.width <= 412 && mb && mb.x + mb.width <= 412, `celular: busca até ${Math.round(sb.x + sb.width)}, sugestões até ${Math.round(mb.x + mb.width)}`);
  assert(await noHScroll(m), 'rolagem horizontal no celular');
  await shot(m, 'celular-quem-pode-sugestoes');
  await m.context().close();
});

// ---------- 18. Lote com 2FA e restrições ao salvar ----------
await step(18, 'Lote: Exige 2FA e "Inclui você"; editor: a restrição em Muda ao salvar', async () => {
  const role = `e2e-2fa-${RUN}`;
  ok('papel 2FA', await admin.call('POST', 'rbac.roles.create', { name: role, description: 'Turno 2FA', scope: 'Users', mandatory2fa: true, permissions: [] }));
  try {
    const p = adminPage;
    await p.goto(`${CHAT_URL}/admin/permissions/role/${role}?tab=people`);
    await p.getByRole('button', { name: 'Dar este papel a…' }).click();
    const pick = p.getByRole('dialog');
    for (const u of [lib.ADMIN_USER, PEOPLE.diego.username]) {
      await pick.getByPlaceholder('Buscar pessoas').fill(u);
      await p.getByRole('option').filter({ hasText: `@${u}` }).first().click();
    }
    await pick.getByRole('button', { name: 'Revisar' }).click();
    const dlg = p.getByRole('dialog').filter({ hasText: 'Dar o papel' });
    await expectText(dlg, '2 recebem');
    await expectText(dlg, 'Inclui você');
    await expectText(dlg, 'Exige 2FA:');
    const apply = dlg.getByRole('button', { name: /^Aplicar a/ });
    assert(await apply.isDisabled(), '"Aplicar" ligado sem confirmar o 2FA da própria conta');
    await dlg.locator('.rbac-bulk-self input').check();
    assert(await apply.isEnabled(), '"Aplicar" não ligou com a confirmação');
    await shot(p, 'lote-2fa-inclui-voce');
    await dlg.getByRole('button', { name: 'Cancelar' }).click();
  } finally {
    ok('papel 2FA', await admin.call('POST', 'rbac.roles.delete', { roleId: role }));
  }
  // Muda ao salvar: dar Operação diz que a pessoa passa a ser restrita, e a revisão também.
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/users/edit/${PEOPLE.diego.id}`);
  await p.getByRole('tab', { name: 'Acesso & Papéis' }).click();
  await p.locator('.rbac-role-chips label', { hasText: /^Operação/ }).first().click();
  await expectText(p.locator('.rbac-eff-change'), 'Passa a ser restrita em conversas diretas (via Operação)');
  // O texto começa logo depois do ícone (não centralizado na linha).
  const [ri, rt] = [await p.locator('.rbac-eff-restriction > svg').first().boundingBox(), await p.locator('.rbac-eff-restriction .rbac-review-change > span').first().boundingBox()];
  assert(rt.x - (ri.x + ri.width) < 24, `texto da restrição longe do ícone: ícone termina em ${Math.round(ri.x + ri.width)}, texto começa em ${Math.round(rt.x)}`);
  await shot(p, 'muda-ao-salvar-restrita');
  await p.locator('.rbac-editor-actions').getByRole('button', { name: 'Salvar' }).click();
  await expectText(p.getByRole('dialog'), 'Passa a ser restrita em conversas diretas (via Operação).');
  await shot(p, 'revisao-restrita');
  await p.getByRole('dialog').getByRole('button', { name: 'Voltar ao editor' }).click();
  await p.getByRole('button', { name: 'Reverter' }).click();
});

// ---------- 19. Supervisor, novo papel e celular ----------
await step(19, 'Supervisor: textos de quem só dá o papel e o e-mail no editor; plano do modelo; celular', async () => {
  if (!(await roleOf(SUP))) throw new Error('papel supervisor-operacao não existe (rode os passos 2 a 4)');
  await setRoles(PEOPLE.ana, [SUP]);
  if (!ana) ana = await open(PEOPLE.ana, { url: '/admin/users' });
  await ana.goto(`${CHAT_URL}/admin/permissions/role/operacao?tab=people`);
  await expectText(ana, 'Você não altera as permissões deste papel, mas pode dar e tirar o papel.');
  assert(!(await ana.getByText('Você pode ver os papéis, mas não alterá-los.').count()), 'o aviso de só leitura apareceu para quem dá o papel');
  await expectVisible(ana.getByRole('button', { name: 'Dar este papel a…' }), '"Dar este papel a…"');
  // Aviso informativo em linha: o ícone ao lado do texto (a classe .info não pode virar coluna).
  const notice = ana.locator('.rbac-notice.info').first();
  const [ni, nt] = [await notice.locator('svg').first().boundingBox(), await notice.locator('span').first().boundingBox()];
  assert(nt.x > ni.x + ni.width && Math.abs(nt.y - ni.y) < 8, `ícone e texto do aviso fora da linha: ícone ${Math.round(ni.x)},${Math.round(ni.y)}, texto ${Math.round(nt.x)},${Math.round(nt.y)}`);
  await shot(ana, 'supervisor-pessoas-operacao');
  await ana.goto(`${CHAT_URL}/admin/permissions/who?key=create-d`);
  await expectVisible(ana.getByRole('button', { name: 'Ver papel' }), '"Ver papel"');
  assert(!(await ana.getByRole('button', { name: 'Editar papel' }).count()), '"Editar papel" para quem só vê');
  await ana.goto(`${CHAT_URL}/admin/users/edit/${PEOPLE.bruno.id}`);
  const email = ana.getByLabel('E-mail');
  await expectVisible(email, 'campo E-mail');
  assert((await email.inputValue()) === `${PEOPLE.bruno.username}@example.com`, `e-mail no editor: "${await email.inputValue()}"`);
  await shot(ana, 'supervisor-editor-email');
  // A barra do lote fica na coluna do conteúdo, com "Selecionar os N resultados" como link.
  await ana.goto(`${CHAT_URL}/admin/users`);
  await ana.getByRole('combobox', { name: 'Papel' }).selectOption('');
  await ana.getByLabel('Selecionar todos desta página').check();
  const bar = await ana.locator('.rbac-bulk').boundingBox();
  assert(bar && bar.x >= 272 && bar.x + bar.width <= 1366, `barra do lote em ${Math.round(bar?.x)}→${Math.round((bar?.x ?? 0) + (bar?.width ?? 0))}`);
  await shot(ana, 'supervisor-barra-lote');
  await ana.locator('.rbac-bulk').getByRole('button', { name: 'Limpar seleção' }).click();
  // Novo papel › Modelo: o plano aparece no cartão escolhido, sem rolar.
  const p = adminPage;
  await p.goto(`${CHAT_URL}/admin/permissions`);
  await p.getByRole('button', { name: 'Novo papel' }).click();
  const dlg = p.getByRole('dialog');
  await dlg.getByRole('radio', { name: 'Modelo' }).click();
  await dlg.locator('.rbac-template-card', { hasText: 'Supervisor de operação' }).click();
  const plan = dlg.locator('.rbac-template-card.on .rbac-plan');
  await expectVisible(plan, 'plano no cartão');
  await p.waitForTimeout(500);
  const [pb, db] = [await plan.boundingBox(), await dlg.locator('.modal-body, .modal-content').first().boundingBox()];
  assert(pb && db && pb.y >= db.y - 1 && pb.y + pb.height <= db.y + db.height + 1, 'o plano do modelo ficou fora da vista');
  await shot(p, 'novo-papel-plano-no-cartao');
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  // Celular: na aba Pessoas, a ação fica embaixo do título, na largura toda.
  const m = await open(ADMIN, { phone: true, url: '/admin/permissions/role/operacao?tab=people' });
  const give = m.getByRole('button', { name: 'Dar este papel a…' });
  await expectVisible(give, '"Dar este papel a…" no celular');
  const title = await m.locator('.rbac-section-header h2', { hasText: 'Pessoas com este papel' }).boundingBox();
  const gb = await give.boundingBox();
  assert(title && gb && gb.y >= title.y + title.height && gb.width >= 300 && title.height <= 30, `celular: título ${Math.round(title?.height)}px de altura, botão ${Math.round(gb?.width)}px`);
  await shot(m, 'celular-pessoas-acao');
  await m.context().close();
});

// ---------- Fim ----------

for (const ctx of pages) await ctx.close().catch(() => {});
await browser.close();
if (rateBefore !== undefined && rateBefore !== false) ok('settings', await admin.call('POST', 'settings', { settings: { [RATE]: rateBefore } }));
// Respostas 4xx esperadas: o 403 do passo 13 é pela API (fora do navegador).
const real = problems.filter((x) => !/HTTP 4\d\d .*(users\.info\?username)/.test(x));
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ results, problems: real }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok, ${real.length} problemas no navegador.`);
for (const x of real.slice(0, 40)) console.log(`  ${x}`);
process.exit(results.every((r) => r.ok) && !real.length ? 0 : 1);
