// Capturas das figurinhas no chat em 4 variantes: desktop (1440x900) e celular (390x844), claro e escuro.
// Prepara pela API dois pacotes da organização (um com figurinha animada), uma figurinha pessoal do admin, envios no
// #geral, num tópico e numa DM, uma figurinha removida de todas as conversas e uma sala de atendimento (omnichannel).
// Grava os PNGs e stickers-shots-log.json (rolagem horizontal e elementos que saem da tela) na pasta de saída.
//
// Uso:
//   BASE=http://localhost:5201 PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/stickers-shots.mjs <pasta> [--only=<regex>] [--variants=desktop-light,phone-dark]
// Precisa do seed.json de seed.mjs: na própria pasta ou no caminho em SEED.
// O editor, a importação e as páginas de conta e administração das figurinhas ficam com o outro dono (stkstudio).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ADMIN_PASSWORD, ADMIN_USER, BASE, client, executablePath, flag, loadChromium, login, outDir, requireBase } from './lib.mjs';

requireBase();

const out = outDir();
const onlyArg = flag('only');
const only = onlyArg ? new RegExp(onlyArg) : null;
const variantsArg = flag('variants')?.split(',');

const seedFile = process.env.SEED ?? path.join(out, 'seed.json');
if (!fs.existsSync(seedFile)) {
  console.error(`seed.json não encontrado em ${seedFile}: rode seed.mjs antes.`);
  process.exit(2);
}
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const { GERAL } = seed;
const DM = seed.dmid;

const fail = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};
const adminLogin = await login(ADMIN_USER, ADMIN_PASSWORD);
const api = client(adminLogin);
const people = {};
for (const u of ['qa.visual', 'alice.souza', 'bruno.lima']) people[u] = { ...client(await login(u, seed.password)), login: await login(u, seed.password) };

const hist = await api.call('GET', 'channels.history', { roomId: GERAL, count: 100 });
const THREAD = (hist.messages.find((m) => m.msg?.startsWith('Perfeito')) ?? hist.messages.find((m) => m.tcount))?._id;

const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });

// ---------- imagens das figurinhas (desenhadas no Chromium) ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunks(buf) {
  const list = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    list.push({ type: buf.toString('ascii', o + 4, o + 8), data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return list;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
// APNG a partir de quadros PNG do mesmo tamanho: o canvas não grava animação.
function apng(frames, delayMs) {
  const ihdr = pngChunks(frames[0]).find((c) => c.type === 'IHDR').data;
  for (const f of frames) if (!pngChunks(f).find((c) => c.type === 'IHDR').data.equals(ihdr)) throw new Error('quadros com IHDR diferente');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const parts = [PNG_SIG, pngChunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  parts.push(pngChunk('acTL', actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0);
    fc.writeUInt32BE(w, 4);
    fc.writeUInt32BE(h, 8);
    fc.writeUInt16BE(delayMs, 20);
    fc.writeUInt16BE(1000, 22);
    parts.push(pngChunk('fcTL', fc));
    for (const c of pngChunks(f).filter((x) => x.type === 'IDAT')) {
      if (i === 0) parts.push(pngChunk('IDAT', c.data));
      else {
        const s = Buffer.alloc(4);
        s.writeUInt32BE(seq++);
        parts.push(pngChunk('fdAT', Buffer.concat([s, c.data])));
      }
    }
  });
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const art = await browser.newPage();
// Figurinha "de papel": forma com contorno branco, sombra leve e um texto curto. frames > 1 gira e pulsa a forma.
async function draw({ w = 320, h = 320, label, sub = '', fill, shape = 'blob', frames = 1 }) {
  const urls = await art.evaluate(
    ({ w, h, label, sub, fill, shape, frames }) => {
      const list = [];
      for (let f = 0; f < frames; f++) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        const t = frames > 1 ? f / frames : 0;
        const pulse = frames > 1 ? 1 + 0.06 * Math.sin(t * Math.PI * 2) : 1;
        g.save();
        g.translate(w / 2, h / 2);
        if (frames > 1) g.rotate(Math.sin(t * Math.PI * 2) * 0.12);
        g.scale(pulse, pulse);
        const rw = w / 2 - 18;
        const rh = h / 2 - 18;
        g.beginPath();
        if (shape === 'star') {
          for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 ? 0.72 : 1;
            g.lineTo(Math.cos(a) * rw * r, Math.sin(a) * rh * r);
          }
          g.closePath();
        } else if (shape === 'pill') {
          const r = Math.min(rw, rh);
          g.roundRect(-rw, -rh, rw * 2, rh * 2, r);
        } else {
          for (let i = 0; i <= 64; i++) {
            const a = (i / 64) * Math.PI * 2;
            const k = 1 + 0.05 * Math.sin(a * 5);
            g.lineTo(Math.cos(a) * rw * k * 0.94, Math.sin(a) * rh * k * 0.94);
          }
          g.closePath();
        }
        g.shadowColor = 'rgba(0,0,0,.25)';
        g.shadowBlur = 10;
        g.shadowOffsetY = 4;
        g.lineJoin = 'round';
        g.lineWidth = 14;
        g.strokeStyle = '#ffffff';
        g.stroke();
        g.shadowColor = 'transparent';
        g.fillStyle = fill;
        g.fill();
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const size = Math.round(Math.min(w, h) * (label.length > 8 ? 0.16 : 0.2));
        g.font = `800 ${size}px system-ui, sans-serif`;
        g.lineWidth = 6;
        g.strokeStyle = 'rgba(0,0,0,.28)';
        g.strokeText(label, 0, sub ? -size * 0.35 : 0);
        g.fillText(label, 0, sub ? -size * 0.35 : 0);
        if (sub) {
          g.font = `600 ${Math.round(size * 0.55)}px system-ui, sans-serif`;
          g.fillText(sub, 0, size * 0.65);
        }
        g.restore();
        list.push(c.toDataURL('image/png'));
      }
      return list;
    },
    { w, h, label, sub, fill, shape, frames },
  );
  return urls.map((u) => Buffer.from(u.split(',')[1], 'base64'));
}

// stickers.create: campos primeiro, depois "file" e, se animada, "poster".
async function createSticker(who, fields, file, poster) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  fd.append('file', new Blob([file], { type: 'image/png' }), 'figurinha.png');
  if (poster) fd.append('poster', new Blob([poster], { type: 'image/png' }), 'parada.png');
  const r = await fetch(`${BASE}/api/v1/stickers.create`, { method: 'POST', headers: { 'x-user-id': who.userId, 'x-auth-token': who.authToken }, body: fd }).then((x) => x.json());
  return fail(`stickers.create ${fields.name}`, r).sticker;
}

// ---------- dados ----------
fail('settings', await api.call('POST', 'settings', { settings: { Stickers_Enabled: true, Stickers_Personal_Enabled: true, Stickers_Animated_Enabled: true, Livechat_enabled: true, Livechat_accept_chats_with_no_agents: true } }));

const ORG_PACKS = [
  {
    name: 'Atendimento',
    description: 'Figurinhas do dia a dia da operação',
    items: [
      { name: 'Valeu', emojis: ['👍', '🙏'], keywords: ['obrigado', 'agradecer'], draw: { label: 'Valeu!', fill: '#2563eb' } },
      { name: 'Bom dia', emojis: ['👋'], keywords: ['manhã', 'oi'], draw: { label: 'Bom dia', fill: '#f59e0b', shape: 'pill' } },
      { name: 'Café', emojis: ['☕'], keywords: ['pausa'], draw: { label: 'Café?', fill: '#92400e' } },
      { name: 'Foco', emojis: ['🎯'], keywords: ['meta'], draw: { label: 'Foco', fill: '#dc2626', shape: 'star' } },
      { name: 'OK', emojis: ['👌', '👍'], keywords: ['certo', 'combinado'], draw: { label: 'OK', fill: '#16a34a', shape: 'pill' } },
      { name: 'Reunião às 14h', emojis: ['📅'], keywords: ['agenda'], draw: { w: 480, h: 240, label: 'Reunião', sub: 'às 14h', fill: '#7c3aed', shape: 'pill' } },
      { name: 'Pausa', emojis: ['⏸️'], keywords: ['intervalo'], draw: { w: 200, h: 400, label: 'Pausa', fill: '#0891b2', shape: 'pill' } },
      // Removida de todas as conversas logo depois do envio: sai do pacote e só é criada na primeira vez.
      { name: 'Antiga', emojis: ['😬'], keywords: ['removida'], draw: { label: 'Antiga', fill: '#64748b' }, once: true },
    ],
  },
  {
    name: 'Comemorações',
    description: 'Metas batidas e aniversários',
    items: [
      { name: 'Show', emojis: ['🎉', '🤩'], keywords: ['comemorar'], draw: { label: 'Show!', fill: '#db2777', shape: 'star', frames: 8 } },
      { name: 'Parabéns', emojis: ['🎂', '🎉'], keywords: ['aniversário'], draw: { label: 'Parabéns', fill: '#ea580c' } },
    ],
  },
];

const firstRun = !hist.messages.some((m) => m.sticker);
const orgCat = await api.call('GET', 'stickers.list', { scope: 'org', includeDrafts: 'true' });
const byName = {};
for (const spec of ORG_PACKS) {
  let pack = orgCat.packs?.find((p) => p.name === spec.name);
  if (!pack) pack = fail(`packs.create ${spec.name}`, await api.call('POST', 'stickers.packs.create', { scope: 'org', name: spec.name, description: spec.description, status: 'published' })).pack;
  if (pack.status !== 'published') fail('packs.update', await api.call('POST', 'stickers.packs.update', { packId: pack._id, status: 'published' }));
  for (const it of spec.items) {
    let st = pack.stickers?.find((s) => s.name === it.name);
    if (!st && it.once && !firstRun) continue;
    if (!st) {
      const frames = await draw(it.draw);
      const file = frames.length > 1 ? apng(frames, 120) : frames[0];
      st = await createSticker(adminLogin, { packId: pack._id, name: it.name, emojis: it.emojis, keywords: it.keywords }, file, frames.length > 1 ? frames[0] : null);
    }
    byName[it.name] = st;
  }
}
// Pessoal do admin (vai para "Minhas figurinhas").
const mineCat = await api.call('GET', 'stickers.list', { scope: 'mine' });
let mineSticker = mineCat.packs?.flatMap((p) => p.stickers).find((s) => s.name === 'Até já');
if (!mineSticker) mineSticker = await createSticker(adminLogin, { name: 'Até já', emojis: ['👋'], keywords: ['tchau'] }, (await draw({ label: 'Até já', fill: '#0d9488', shape: 'pill' }))[0]);
await art.close();

// Envios: só na primeira vez (o #geral já tem figurinha depois disso).
const sendSticker = (who, roomId, sticker, extra = {}) => who.call('POST', 'chat.sendSticker', { roomId, stickerId: sticker._id, ...extra }).then((r) => fail(`sendSticker ${sticker.name}`, r).message);
const { qa, alice, bruno } = { qa: people['qa.visual'], alice: people['alice.souza'], bruno: people['bruno.lima'] };
if (firstRun) {
  const valeu = await sendSticker(alice, GERAL, byName['Valeu']);
  const show = await sendSticker(bruno, GERAL, byName['Show']);
  await api.call('POST', 'chat.sendMessage', { message: { rid: GERAL, msg: 'Combinado, a reunião segue no horário.' } });
  await sendSticker(api, GERAL, byName['Reunião às 14h']);
  const old = await sendSticker(qa, GERAL, byName['Antiga']);
  await sendSticker(bruno, GERAL, byName['Pausa']);
  await sendSticker(api, GERAL, mineSticker);
  if (THREAD) await sendSticker(alice, GERAL, byName['OK'], { tmid: THREAD });
  await sendSticker(qa, DM, byName['Bom dia']);
  fail('removeEverywhere', await api.call('POST', 'stickers.removeEverywhere', { messageId: old._id, reason: 'Arte antiga da campanha' }));
  fail('favorite', await api.call('POST', 'stickers.favorite', { stickerId: byName['Café']._id, favorite: true }));
  fail('favorite', await api.call('POST', 'stickers.favorite', { stickerId: byName['Parabéns']._id, favorite: true }));
  // Favoritas do admin: a lista usa o mesmo MessageResult da busca.
  for (const m of [valeu, show, old]) fail('starMessage', await api.call('POST', 'chat.starMessage', { messageId: m._id }));
}

// Atendimento: o admin vira agente disponível e um visitante abre a conversa (a sala só aceita emoji).
await api.call('POST', 'livechat/users/agent', { username: ADMIN_USER });
await api.call('POST', 'livechat/agent.status', { status: 'available' });
const VTOKEN = 'stkshots-visitante-0001';
await fetch(`${BASE}/api/v1/livechat/visitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor: { token: VTOKEN, name: 'Cliente Figurinhas' } }) });
const lv = await fetch(`${BASE}/api/v1/livechat/message`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-visitor-token': VTOKEN }, body: JSON.stringify({ msg: 'Olá, preciso de ajuda com meu pedido.' }) }).then((r) => r.json());
const LIVE = lv.message?.rid;
if (!LIVE) console.log('aviso: sala de atendimento não criada', lv.error ?? '');
else {
  // Sem agente conectado a conversa fica na fila: o admin a pega pela API.
  const queued = await api.call('GET', 'livechat/inquiries.queuedForUser');
  const inq = queued.inquiries?.find((i) => i.rid === LIVE);
  if (inq) fail('inquiries.take', await api.call('POST', 'livechat/inquiries.take', { inquiryId: inq._id }));
}

// ---------- navegador ----------
const VARIANTS = [
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light', mobile: false },
  { id: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', mobile: false },
  { id: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', mobile: true },
  { id: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', mobile: true },
].filter((v) => !variantsArg || variantsArg.includes(v.id));

const log = [];
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
    return { scrollW: doc.scrollWidth, vw, overflow: [...new Set(over)].slice(0, 6) };
  });
}
async function shot(p, v, name) {
  const file = `${name}--${v.id}.png`;
  await p.screenshot({ path: path.join(out, file) });
  const m = await measure(p).catch(() => null);
  log.push({ file, ...(m ?? {}) });
  console.log('shot', file, m && m.overflow.length ? `OVERFLOW ${m.overflow.join(' | ')}` : '');
}

// O catálogo fica no localStorage: sem isso o estado "carregando" e o "vazio" nunca aparecem.
const clearStickerCache = (p) =>
  p.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('wescc.stickers.') && k !== 'wescc.stickers.tab') localStorage.removeItem(k);
  });
async function openRoom(p, url) {
  await go(p, url);
  await p.waitForSelector('.composer textarea');
  await p.waitForTimeout(300);
}
async function openPicker(p) {
  await p.click('.composer-tools button[title="Emoji"]');
  await p.waitForSelector('.emoji-picker');
  await p.waitForTimeout(250);
}
async function stickersTab(p, { wait = true } = {}) {
  await openPicker(p);
  const tab = p.locator('.expr-head [data-tab="stickers"]');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  if (wait) {
    await p.waitForSelector('.sticker-grid .sticker-cell img', { timeout: 8000 });
    await p.waitForFunction(() => [...document.querySelectorAll('.sticker-grid .sticker-cell img')].slice(0, 8).every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
  }
  await p.waitForTimeout(300);
}
const stickerMsg = (p, name) => p.locator(`.msg:has(.sticker-hit[aria-label*="${name}"])`).last();
// Figurinhas na área visível já carregadas (as de fora ficam com loading="lazy" e não contam).
async function imagesReady(p) {
  await p
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.sticker-msg[data-state]')].every((el) => {
          const r = el.getBoundingClientRect();
          return el.dataset.state !== 'loading' || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
        }),
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  await p.waitForTimeout(300);
}

const SCENES = [
  ['__login', async (p) => signIn(p, ADMIN_USER, ADMIN_PASSWORD)],
  ['k01-picker-stickers', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p);
  }],
  ['k02-picker-pack-scroll', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p);
    // O último pacote: ele sobe até o topo e o título dele é o que fica fixo em cima.
    await p.locator('.sticker-pack-tabs .sticker-pack-btn').last().click();
    await p.waitForTimeout(800);
  }],
  ['k03-picker-search-empty', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p);
    await p.fill('.sticker-search input', 'zzzz');
    await p.waitForTimeout(500);
  }],
  ['k04-picker-search-results', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p);
    await p.fill('.sticker-search input', 'pausa');
    await p.waitForTimeout(600);
  }],
  ['k05-picker-loading', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await clearStickerCache(p);
    await p.route('**/api/v1/stickers.list**', () => {}); // fica pendente
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p, { wait: false });
    await p.waitForSelector('.sticker-grid .skeleton', { timeout: 3000 });
    await shotNow(p);
    await p.unroute('**/api/v1/stickers.list**');
    await clearStickerCache(p);
    return 'shot';
  }],
  ['k06-picker-empty', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await clearStickerCache(p);
    await p.route('**/api/v1/stickers.list**', async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      const empty = { ...j, version: 'shots-vazio', packs: [] };
      if (j.scope === 'mine') Object.assign(empty, { favorites: [], recents: [] });
      await route.fulfill({ response: res, json: empty });
    });
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p, { wait: false });
    await p.waitForSelector('.sticker-grid .empty, .sticker-picker .empty', { timeout: 5000 });
    await p.waitForTimeout(300);
    await shotNow(p);
    await p.unroute('**/api/v1/stickers.list**');
    await clearStickerCache(p);
    return 'shot';
  }],
  ['k07-picker-item-menu', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await stickersTab(p);
    await p.locator('.sticker-grid .sticker-cell').nth(1).dispatchEvent('contextmenu');
    await p.waitForSelector('.menu, .sheet', { timeout: 3000 });
    await p.waitForTimeout(400);
  }],
  ['k08-picker-livechat', async (p) => {
    if (!LIVE) return 'skip';
    await openRoom(p, `/live/${LIVE}`);
    await openPicker(p);
  }],
  ['k09-picker-thread', async (p) => {
    if (!THREAD) return 'skip';
    await go(p, `/channel/${GERAL}/thread/${THREAD}`);
    await p.waitForSelector('.thread-panel .composer textarea');
    await p.click('.thread-panel .composer-tools button[title="Emoji"]');
    await p.waitForSelector('.emoji-picker');
    const tab = p.locator('.expr-head [data-tab="stickers"]');
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
    await p.waitForSelector('.sticker-grid .sticker-cell img', { timeout: 8000 });
    await p.waitForTimeout(500);
  }],
  ['k10-messages', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
  }],
  ['k11-message-animated-hover', async (p, v) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    const m = stickerMsg(p, 'Show');
    await m.scrollIntoViewIfNeeded();
    if (v.mobile) return;
    await m.locator('.sticker-msg').hover();
    await p.waitForTimeout(600);
  }],
  ['k12-message-removed', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    await p.locator('.sticker-removed').last().scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  }],
  ['k13-thread', async (p) => {
    if (!THREAD) return 'skip';
    await go(p, `/channel/${GERAL}/thread/${THREAD}`);
    await p.waitForSelector('.thread-panel .sticker-msg');
    await imagesReady(p);
    await p.waitForTimeout(400);
  }],
  ['k14-dm', async (p) => {
    await openRoom(p, `/direct/${DM}`);
    await imagesReady(p);
  }],
  ['k15-card-org', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    await stickerMsg(p, 'Valeu').locator('.sticker-hit').click();
    await p.waitForSelector('.sticker-card');
    await p.waitForTimeout(300);
    await imagesReady(p);
  }],
  ['k16-card-animated', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    await stickerMsg(p, 'Show').locator('.sticker-hit').click();
    await p.waitForSelector('.sticker-card');
    await p.waitForTimeout(300);
    await imagesReady(p);
  }],
  ['k17-card-personal', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    await stickerMsg(p, 'Até já').locator('.sticker-hit').click();
    await p.waitForSelector('.sticker-card');
    await p.waitForTimeout(300);
    await imagesReady(p);
  }],
  ['k19-remove-dialog', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    await stickerMsg(p, 'Valeu').locator('.sticker-hit').click();
    await p.waitForSelector('.sticker-card');
    await p.click('.sticker-card button:has-text("Remover de todas as conversas")');
    await p.waitForSelector('.modal.sticker-remove, .sticker-remove');
    await p.waitForSelector('.sticker-remove-text:not(:has-text("Verificando"))', { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(400);
  }],
  ['k20-message-menu', async (p, v) => {
    await openRoom(p, `/channel/${GERAL}`);
    await imagesReady(p);
    const m = stickerMsg(p, 'Valeu');
    await m.scrollIntoViewIfNeeded();
    if (v.mobile) {
      await m.locator('.sticker-hit').dispatchEvent('contextmenu');
      await p.waitForSelector('.sheet', { timeout: 3000 });
    } else {
      await m.hover();
      await m.locator('.msg-toolbar button[title="Mais"]').click();
      await p.waitForSelector('.menu');
    }
    await p.waitForTimeout(400);
  }],
  ['k21-suggestions', async (p) => {
    await openRoom(p, `/channel/${GERAL}`);
    await p.click('.composer textarea');
    await p.keyboard.insertText('👍');
    await p.waitForSelector('.sticker-suggest .sticker-cell', { timeout: 6000 });
    await imagesReady(p);
    await shotNow(p);
    // Senão o rascunho com o emoji segue para as próximas cenas.
    await p.keyboard.press('Escape');
    await p.fill('.composer textarea', '');
    await p.waitForTimeout(300);
    return 'shot';
  }],
  ['k22-threads-list', async (p) => {
    await go(p, `/channel/${GERAL}?tab=threads`);
    await p.waitForTimeout(800);
  }],
  ['k23-starred-list', async (p) => {
    await go(p, `/channel/${GERAL}?tab=starred`);
    await p.waitForSelector('.panel .sticker-msg', { timeout: 6000 });
    await p.waitForTimeout(400);
    await imagesReady(p);
  }],
];

let shotNow = async () => {};
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
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  for (const [name, fn] of SCENES) {
    if (only && !name.startsWith('__') && !only.test(name)) continue;
    shotNow = (pg) => shot(pg, v, name);
    try {
      const r = await fn(p, v);
      if (name.startsWith('__') || r === 'skip' || r === 'shot') continue;
      await shot(p, v, name);
    } catch (e) {
      console.log('FAIL', name, v.id, e.message.split('\n')[0]);
      log.push({ file: `${name}--${v.id}.png`, error: e.message.split('\n')[0] });
      await p.screenshot({ path: path.join(out, `${name}--${v.id}.png`) }).catch(() => {});
      await p.unroute('**/api/v1/stickers.list**').catch(() => {});
    }
    await p.keyboard.press('Escape').catch(() => {});
  }
  if (errs.length) log.push({ variant: v.id, consoleErrors: [...new Set(errs)].slice(0, 15) });
  await ctx.close();
}
await browser.close();
const overflow = log.filter((l) => l.overflow?.length || (l.scrollW && l.scrollW > l.vw)).length;
const failed = log.filter((l) => l.error).length;
const logFile = path.join(out, only ? 'stickers-shots-log-partial.json' : 'stickers-shots-log.json');
fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
console.log('done', log.length, 'overflow', overflow, 'failed', failed, '->', logFile);
