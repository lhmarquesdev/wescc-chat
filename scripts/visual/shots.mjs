// Capturas de todas as telas em 4 variantes: desktop (1440x900) e celular (390x844), claro e escuro.
// Grava os PNGs e shots-log.json (rolagem horizontal e elementos que saem da tela) na pasta de saída.
//
// Uso:
//   BASE=http://localhost:5201 PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/shots.mjs <pasta> [--only=<regex>] [--variants=desktop-light,phone-dark] [--probe]
// --probe: também mede contraste e alvos de toque em cada tela (probe.mjs) e grava probe-log.json.
// Precisa do seed.json de seed.mjs: na própria pasta ou no caminho em SEED.
// Com --only, o log vai para shots-log-partial.json.
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, ADMIN_USER, BASE, client, executablePath, flag, loadChromium, login, outDir, requireBase } from './lib.mjs';
import { probePage } from './probe.mjs';

requireBase();

const out = outDir();
const onlyArg = flag('only');
const only = onlyArg ? new RegExp(onlyArg) : null;
const variantsArg = flag('variants')?.split(',');
const probeOn = process.argv.includes('--probe');
const probeLog = [];

const seedFile = process.env.SEED ?? path.join(out, 'seed.json');
if (!fs.existsSync(seedFile)) {
  console.error(`seed.json não encontrado em ${seedFile}: rode seed.mjs antes.`);
  process.exit(2);
}
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const { GERAL, AVISOS } = seed;
const DM = seed.dmid;
const PDF = path.join(path.dirname(seedFile), 'seed-escala.pdf');

const api = client(await login(ADMIN_USER, ADMIN_PASSWORD));
const hist = await api.call('GET', 'channels.history', { roomId: GERAL, count: 50 });
const THREAD = (hist.messages.find((m) => m.msg?.startsWith('Perfeito')) ?? hist.messages.find((m) => m.tcount))?._id;

const VARIANTS = [
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light', mobile: false },
  { id: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', mobile: false },
  { id: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', mobile: true },
  { id: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', mobile: true },
].filter((v) => !variantsArg || variantsArg.includes(v.id));

const log = [];
const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });

const settle = (p, ms = 500) =>
  p
    .waitForLoadState('networkidle', { timeout: 5000 })
    .catch(() => {})
    .then(() => p.evaluate(() => document.fonts.ready).catch(() => {}))
    .then(() => p.waitForTimeout(ms));
async function go(p, url) {
  await p.goto(BASE + url);
  await p.mouse.move(1, (p.viewportSize()?.height ?? 800) - 1).catch(() => {});
  await p.waitForSelector('.sidebar, .auth, .auth-card', { timeout: 10000 }).catch(() => {});
  await settle(p);
}
// Reserva: no celular o início já é a lista; só abre a gaveta antiga se o botão dela estiver visível.
async function openNav(p, v) {
  if (!v.mobile) return;
  if (!(await p.locator('.mobile-nav-btn').isVisible().catch(() => false))) return;
  await p.click('.mobile-nav-btn');
  await p.waitForTimeout(400);
}
// Desktop: aba da lista lateral. Celular: o seletor de grupo abre um menu.
async function pickSettingsGroup(p, label) {
  if (await p.locator('.settings-group-pick').isVisible().catch(() => false)) {
    await p.click('.settings-group-pick');
    await p.click(`[role="menuitemradio"]:has-text("${label}")`);
  } else {
    await p.click(`.tabs button:has-text("${label}")`);
  }
}
async function signIn(p, user, password) {
  await go(p, '/login');
  await p.fill('form input >> nth=0', user);
  await p.fill('input[type="password"]', password);
  await p.click('button[type="submit"]');
  await p.waitForSelector('.sidebar', { timeout: 15000 });
  await settle(p);
}
// Rolagem horizontal e elementos que saem da tela (fora de contêineres com rolagem própria).
async function measure(p) {
  return p.evaluate(() => {
    const vw = innerWidth;
    const doc = document.scrollingElement;
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.position === 'fixed') continue;
      if (r.right > vw + 1 && r.left < vw) {
        let a = el.parentElement;
        let clipped = false;
        while (a && a !== document.body) {
          const s = getComputedStyle(a);
          if (/(auto|scroll|hidden)/.test(s.overflowX) && a.getBoundingClientRect().right <= vw + 1) {
            clipped = true;
            break;
          }
          a = a.parentElement;
        }
        if (!clipped) over.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} r=${Math.round(r.right)}`);
      }
    }
    const ml = document.querySelector('.room-main .messages');
    const fromBottom = ml ? Math.round(ml.scrollHeight - ml.scrollTop - ml.clientHeight) : undefined;
    return { scrollW: doc.scrollWidth, vw, fromBottom, overflow: [...new Set(over)].slice(0, 6) };
  });
}

async function shot(p, v, name, opts = {}) {
  const file = `${name}--${v.id}.png`;
  await p.screenshot({ path: path.join(out, file), fullPage: !!opts.full });
  const m = await measure(p).catch(() => null);
  log.push({ file, ...(m ?? {}) });
  if (probeOn) {
    const pr = await probePage(p, { coarse: v.mobile }).catch((e) => ({ error: e.message.split('\n')[0] }));
    probeLog.push({ file, ...pr });
  }
  console.log('shot', file, m?.fromBottom ? `msgs ${m.fromBottom}px above bottom` : '', m && m.overflow.length ? `OVERFLOW ${m.overflow.join(' | ')}` : '');
}

const SCENES = [
  ['01-login', async (p) => go(p, '/login')],
  ['02-forgot-password', async (p) => go(p, '/forgot-password')],
  ['03-register', async (p) => go(p, '/register')],
  ['04-login-error', async (p) => {
    await go(p, '/login');
    // usuário inexistente: não mexe no contador de bloqueio do admin
    await p.fill('form input >> nth=0', 'ninguem.visual');
    await p.fill('input[type="password"]', 'senhaerrada');
    await p.click('button[type="submit"]');
    await p.waitForTimeout(1200);
  }],
  // ---- a partir daqui, logado como admin ----
  ['__login', async (p) => signIn(p, ADMIN_USER, ADMIN_PASSWORD)],
  ['05-home', async (p) => go(p, '/home')],
  // No celular o início já é a lista de conversas (05-home) e a gaveta não aparece mais: a cena fica de fora.
  ['06-sidebar-open', async () => 'skip'],
  ['07-user-menu', async (p, v) => {
    await go(p, '/home');
    await openNav(p, v);
    await p.click('.me-btn');
    await p.waitForTimeout(300);
  }],
  ['08-create-menu', async (p, v) => {
    await go(p, '/home');
    await openNav(p, v);
    await p.click('button[title="Criar"]');
    await p.waitForTimeout(300);
  }],
  ['09-create-channel-modal', async (p, v) => {
    await go(p, '/home');
    await openNav(p, v);
    await p.click('button[title="Criar"]');
    await p.click('.menu button:has-text("Canal")');
    await p.waitForSelector('.modal');
    await p.waitForTimeout(300);
  }],
  ['10-create-dm-modal', async (p, v) => {
    await go(p, '/home');
    await openNav(p, v);
    await p.click('button[title="Criar"]');
    await p.click('.menu button:has-text("Mensagem direta")');
    await p.waitForSelector('.modal');
    await p.waitForTimeout(300);
  }],
  ['11-directory-channels', async (p) => go(p, '/directory')],
  ['12-directory-users', async (p) => {
    await go(p, '/directory');
    await p.click('.tabs button:has-text("Pessoas")');
    await settle(p, 700);
  }],
  ['12b-directory-teams', async (p) => {
    await go(p, '/directory');
    await p.click('.tabs button:has-text("Times")');
    await settle(p, 700);
  }],
  ['13-directory-empty-search', async (p) => {
    await go(p, '/directory');
    await p.fill('.page-body input', 'zzzz-nada');
    await p.waitForTimeout(900);
  }],
  ['14-channel', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    await p.waitForTimeout(600);
  }],
  ['14b-notice-channel', async (p) => {
    await go(p, `/channel/${AVISOS}`);
    await p.waitForSelector('.msg');
    await p.waitForTimeout(600);
  }],
  ['15-channel-hover-toolbar', async (p, v) => {
    if (v.mobile) return 'skip';
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    await p.hover('.msg:has-text("painel de filas")');
    await p.waitForTimeout(300);
  }],
  ['16-message-more-menu', async (p, v) => {
    if (v.mobile) return 'skip';
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    const msg = p.locator('.msg:has-text("Perfeito, obrigado")');
    await msg.hover();
    await msg.locator('.msg-toolbar button[title="Mais"]').click();
    await p.waitForTimeout(300);
  }],
  ['17-room-kebab-menu', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    await p.click('.room-actions button[title="Mais"]');
    await p.waitForTimeout(300);
  }],
  ['18-emoji-picker', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.composer');
    await p.click('.composer-tools button[title="Emoji"]');
    await p.waitForSelector('.emoji-picker');
    await p.waitForTimeout(300);
  }],
  ['19-composer-suggestions', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.composer textarea');
    await p.click('.composer textarea');
    await p.keyboard.type('@a');
    await p.waitForTimeout(700);
  }],
  ['20-thread-panel', async (p) => {
    await go(p, `/channel/${GERAL}/thread/${THREAD}`);
    await p.waitForSelector('.thread-panel');
    await p.waitForTimeout(800);
  }],
  ['21-members-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=members`);
    await p.waitForSelector('.panel');
    await settle(p, 700);
  }],
  ['22-room-info-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=info`);
    await p.waitForSelector('.panel');
    await settle(p, 700);
  }],
  ['23-search-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=search`);
    await p.waitForSelector('.panel');
    const inp = p.locator('.panel input').first();
    await inp.fill('fila');
    await inp.press('Enter');
    await settle(p, 900);
  }],
  ['24-files-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=files`);
    await p.waitForSelector('.panel');
    await settle(p, 900);
  }],
  ['25-threads-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=threads`);
    await p.waitForSelector('.panel');
    await settle(p, 800);
  }],
  ['26-pinned-empty-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=pinned`);
    await p.waitForSelector('.panel');
    await settle(p, 800);
  }],
  ['27-notifications-panel', async (p) => {
    await go(p, `/channel/${GERAL}?tab=notifications`);
    await p.waitForSelector('.panel');
    await settle(p, 800);
  }],
  ['28-user-card', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    await p.locator('.msg-name:has-text("QA")').first().click().catch(() => p.locator('.msg-name').first().click());
    await p.waitForSelector('.user-card, .modal');
    await settle(p, 600);
  }],
  ['29-image-lightbox', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.att-image');
    await p.locator('.att-image').last().click();
    await p.waitForTimeout(600);
  }],
  ['30-dm', async (p) => {
    await go(p, `/direct/${DM}`);
    await p.waitForSelector('.room-header');
    await p.waitForTimeout(700);
  }],
  ['31-room-error', async (p) => {
    await go(p, '/channel/naoexiste123');
    await p.waitForTimeout(800);
  }],
  ['32-room-loading', async (p, v) => {
    if (v.id !== 'desktop-light' && v.id !== 'phone-dark') return 'skip';
    await go(p, '/home');
    const slow = '**/api/v1/rooms.info**';
    await p.route(slow, async (r) => {
      await new Promise((res) => setTimeout(res, 4000));
      await r.continue().catch(() => {});
    });
    await p.evaluate((rid) => {
      history.pushState({}, '', `/channel/${rid}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, GERAL);
    await p.waitForSelector('.room.loading .skeleton', { timeout: 3000 });
    await p.waitForTimeout(300);
    // A foto sai antes do unroute: sem nenhuma rota, o Chromium solta na hora o pedido que estava preso.
    await shot(p, v, '32-room-loading');
    await p.unroute(slow);
    await p.waitForSelector('.msg', { timeout: 10000 }).catch(() => {});
    return 'skip';
  }],
  ['33-calls', async (p) => go(p, '/calls')],
  ['34-omnichannel-queue', async (p) => go(p, '/omnichannel/queue')],
  ['34b-omnichannel-current', async (p) => {
    await go(p, '/omnichannel/current');
    await settle(p, 700);
  }],
  ['34c-omnichannel-analytics', async (p) => {
    await go(p, '/omnichannel/analytics');
    await settle(p, 900);
  }],
  ['35-account-profile', async (p) => go(p, '/account/profile')],
  ['36-account-preferences', async (p) => go(p, '/account/preferences')],
  ['37-account-security', async (p) => go(p, '/account/security')],
  ['38-account-devices', async (p) => go(p, '/account/devices')],
  ['39-account-tokens', async (p) => go(p, '/account/tokens')],
  ['40-admin-info', async (p) => go(p, '/admin/info')],
  ['41-admin-engagement', async (p) => {
    await go(p, '/admin/engagement');
    await settle(p, 800);
  }],
  ['42-admin-users', async (p) => go(p, '/admin/users')],
  ['43-admin-user-edit', async (p) => {
    await go(p, '/admin/users');
    await p.locator('.table tr.clickable, .table tbody tr').filter({ hasText: 'qa.visual' }).first().click();
    await settle(p, 700);
  }],
  ['44-admin-rooms', async (p) => go(p, '/admin/rooms')],
  ['45-admin-permissions', async (p) => {
    await go(p, '/admin/permissions');
    await settle(p, 800);
  }],
  ['46-admin-settings', async (p) => go(p, '/admin/settings')],
  ['47-admin-settings-messages', async (p) => {
    await go(p, '/admin/settings');
    await pickSettingsGroup(p, 'Mensagens');
    await settle(p, 700);
  }],
  ['47b-admin-settings-appearance', async (p) => {
    await go(p, '/admin/settings');
    await pickSettingsGroup(p, 'Aparência');
    await settle(p, 700);
  }],
  ['48-admin-integrations', async (p) => go(p, '/admin/integrations')],
  ['49-admin-oauth', async (p) => go(p, '/admin/oauth')],
  ['50-admin-omnichannel', async (p) => go(p, '/admin/omnichannel')],
  ['51-admin-import', async (p) => {
    await go(p, '/admin/import');
    await settle(p, 800);
  }],
  ['52-admin-import-new', async (p) => {
    await go(p, '/admin/import');
    await p.click('.page-body button:has-text("Importar arquivo"), .page-body a:has-text("Importar arquivo")');
    await settle(p, 700);
  }],
  ['53-admin-audit', async (p) => go(p, '/admin/audit')],
  ['54-admin-moderation', async (p) => go(p, '/admin/moderation')],
  ['55-admin-emoji', async (p) => go(p, '/admin/emoji')],
  ['56-admin-invites', async (p) => go(p, '/admin/invites')],
  ['57-admin-devices', async (p) => go(p, '/admin/devices')],
  ['57b-admin-ldap', async (p) => {
    await go(p, '/admin/ldap');
    await settle(p, 700);
  }],
  ['58-upload-confirm-modal', async (p) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.composer');
    await p.setInputFiles('.composer input[type="file"]', PDF);
    await p.waitForSelector('.modal');
    await p.waitForTimeout(400);
  }],
  ['59-composer-editing', async (p) => {
    await go(p, `/direct/${DM}`);
    await p.waitForSelector('.composer textarea');
    await p.click('.composer textarea');
    await p.keyboard.press('ArrowUp');
    await p.waitForTimeout(500);
  }],
  ['59b-toast', async (p, v) => {
    if (v.mobile) return 'skip';
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    const msg = p.locator('.msg:has-text("Perfeito, obrigado")');
    await msg.hover();
    await msg.locator('.msg-toolbar button[title="Mais"]').click();
    await p.click('.menu button:has-text("Copiar link")');
    await p.waitForTimeout(400);
  }],
  // Derruba a conexão do app e segura as novas tentativas (initScript abaixo) até a captura; depois deixa reconectar.
  ['59c-offline-bar', async (p, v) => {
    await go(p, `/channel/${GERAL}`);
    await p.waitForSelector('.msg');
    await p.evaluate(() => {
      window.__block = true;
      for (const ws of window.__ws) if (ws.url.endsWith('/websocket')) ws.close();
    });
    await p.waitForSelector('.offline-bar', { timeout: 15000 });
    await p.waitForTimeout(400);
    await shot(p, v, '59c-offline-bar');
    await p.evaluate(() => (window.__block = false));
    await p.waitForSelector('.offline-bar', { state: 'detached', timeout: 40000 }).catch(() => {});
    return 'skip';
  }],
  // ---- quem lê o canal de avisos (botão "Ciente") ----
  ['__login-reader', async (p) => {
    await p.context().clearCookies();
    await p.evaluate(() => localStorage.clear()).catch(() => {});
    await signIn(p, 'qa.visual', seed.password);
  }],
  ['60-notice-reader', async (p) => {
    await go(p, `/channel/${AVISOS}`);
    await p.waitForSelector('.msg');
    await settle(p, 700);
  }],
];

for (const v of VARIANTS) {
  const ctx = await browser.newContext({
    viewport: v.viewport,
    colorScheme: v.colorScheme,
    deviceScaleFactor: v.mobile ? 2 : 1,
    isMobile: v.mobile,
    hasTouch: v.mobile,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  // Guarda os WebSockets da página; com __block, a conexão do app (/websocket) vai para uma porta fechada e o HMR do Vite segue.
  await ctx.addInitScript(() => {
    const Native = window.WebSocket;
    window.__ws = [];
    window.WebSocket = class extends Native {
      constructor(url, ...rest) {
        super(window.__block && String(url).endsWith('/websocket') ? 'ws://127.0.0.1:9/websocket' : url, ...rest);
        window.__ws.push(this);
      }
    };
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  for (const [name, fn] of SCENES) {
    if (only && !name.startsWith('__') && !only.test(name)) continue;
    try {
      const r = await fn(p, v);
      if (name.startsWith('__') || r === 'skip') continue;
      await shot(p, v, name);
      await p.keyboard.press('Escape').catch(() => {});
    } catch (e) {
      console.log('FAIL', name, v.id, e.message.split('\n')[0]);
      log.push({ file: `${name}--${v.id}.png`, error: e.message.split('\n')[0] });
      await p.screenshot({ path: path.join(out, `${name}--${v.id}.png`) }).catch(() => {});
    }
  }
  if (errs.length) log.push({ variant: v.id, consoleErrors: [...new Set(errs)].slice(0, 15) });
  await ctx.close();
}
await browser.close();
const overflow = log.filter((l) => l.overflow?.length || (l.scrollW && l.scrollW > l.vw)).length;
const failed = log.filter((l) => l.error).length;
const logFile = path.join(out, only ? 'shots-log-partial.json' : 'shots-log.json');
fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
console.log('done', log.length, 'overflow', overflow, 'failed', failed, '->', logFile);
if (probeOn) {
  const probeFile = path.join(out, only ? 'probe-log-partial.json' : 'probe-log.json');
  fs.writeFileSync(probeFile, JSON.stringify(probeLog, null, 2));
  const sum = (k) => probeLog.reduce((n, x) => n + (x[k]?.length ?? 0), 0);
  const modal = probeLog.filter((x) => x.modalMin !== null && x.modalMin !== undefined).map((x) => x.modalMin);
  const modalMin = modal.length ? Math.min(...modal) : null;
  console.log('probe: texto abaixo do mínimo', sum('lowText'), '| ícones abaixo de 3:1', sum('lowIcons'), '| alvos < 44px (celular)', sum('smallTargets'), '| menor contraste em .modal', modalMin ?? '—', modalMin !== null && modalMin < 4.5 ? 'FALHOU' : '', '->', probeFile);
}
