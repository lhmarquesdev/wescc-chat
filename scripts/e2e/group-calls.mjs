// Chamadas em grupo de ponta a ponta (design §8.7 e §13.7): o chat no ar, um LiveKit de verdade subido por este
// roteiro e o Chromium com câmera e microfone falsos. Roda os cenários 1 a 11; o 12 é da v1b e fica de fora.
//
// Uso:
//   CHAT_URL=http://localhost:3080 LIVEKIT_BIN=/caminho/livekit-server \
//     PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/e2e/group-calls.mjs <pasta>
//
// Variáveis de ambiente:
//   CHAT_URL           endereço do chat (o servidor com a web compilada, ou o Vite). Obrigatória.
//   LIVEKIT_BIN        executável livekit-server. Obrigatória. O roteiro sobe o seu, com chave e segredo novos.
//   LK_BIN             opcional: o lk lista as faixas no cenário 1 (a chave vai pelo ambiente, nunca na linha de comando).
//   LIVEKIT_PORT_BASE  porta HTTP do LiveKit (padrão 27880); TCP = base+1, UDP = base+2 a base+5. Nunca 7880.
//   WEBHOOK_URL        webhook do LiveKit. Padrão: http://127.0.0.1:<porta do CHAT_URL>/sfu-webhook. Com o Vite,
//                      informe a porta do servidor do chat.
//   CHAT_RESTART       comando de shell que reinicia o chat e só termina com ele no ar (cenário 8). Sem ele, o 8 é pulado.
//   REBUILD_CMD        comando de shell que gera outra versão da web servida pelo chat (cenário 10). Sem ele, com WEB_DIST
//                      (a pasta que o chat serve), o roteiro troca o id de WEB_DIST/build.json e depois o devolve.
//                      Sem os dois, o 10 é pulado.
//   NET_DROP=iptables  no cenário 2, além de context.setOffline, descarta no iptables (precisa de root) os pacotes UDP
//                      das conexões de mídia do supervisor durante a queda.
//   SCENARIOS          cenários a rodar, por exemplo 1,4,6 (padrão: todos).
//   PLAYWRIGHT_CORE, CHROMIUM_PATH, ADMIN_USER, ADMIN_PASSWORD   como em scripts/visual/lib.mjs.
//
// O roteiro muda configurações do chat (Calls_*, API_Enable_Rate_Limiter) e devolve os valores antigos no fim; o
// segredo anterior do servidor de chamadas não volta, porque a API nunca o devolve. Cria (ou reaproveita) os usuários
// e2e.* com uma senha nova a cada execução e um canal novo por cenário. Sai com código 1 se algum cenário falhar.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHAT_URL = (process.env.CHAT_URL ?? '').replace(/\/+$/, '');
const LIVEKIT_BIN = process.env.LIVEKIT_BIN ?? '';
if (!CHAT_URL) {
  console.error('Defina CHAT_URL com o endereço do chat, por exemplo CHAT_URL=http://localhost:3080');
  process.exit(2);
}
if (!LIVEKIT_BIN || !fs.existsSync(LIVEKIT_BIN)) {
  console.error('Defina LIVEKIT_BIN com o caminho do executável livekit-server.');
  process.exit(2);
}
// lib.mjs lê BASE ao ser carregado.
process.env.BASE = CHAT_URL;
const lib = await import('../visual/lib.mjs');
const { renderConfig } = await import('../livekit/render-config.mjs');

const OUT = lib.outDir();
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// Os mesmos valores de shared/src/calls.ts e de lib/call/store.ts (strings exatas do design).
const CALL_TRACK_NAMES = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
const CALL_GUARD_TITLE = 'Aguardando um supervisor';
const CALL_GUARD_ENDED = 'A chamada foi encerrada: só restaram pessoas que não podem conversar em particular.';
const GUARD_PAUSED = 'Microfones e câmeras pausados até um supervisor entrar.';
const SCREEN_BLOCKED = 'Um moderador parou seu compartilhamento. Tente de novo em instantes.';

const WANTED = (process.env.SCENARIOS ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const wanted = (n) => !WANTED.length || WANTED.includes(n);
const RUN = Date.now().toString(36);
const PASSWORD = `${crypto.randomBytes(12).toString('base64url')}a1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)} s] ${m}`);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

class Skip extends Error {}

// Espera fn() dar um valor verdadeiro; erro com o que faltou.
async function waitFor(what, fn, { timeout = 15000, every = 250 } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeout) {
      const why = last instanceof Error ? ` (${last.message.split('\n')[0]})` : '';
      throw new Error(`${what}: não aconteceu em ${Math.round(timeout / 1000)} s${why}`);
    }
    await sleep(every);
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- Chat: administrador, configurações e pessoas ----------

const admin = lib.client(await lib.login(lib.ADMIN_USER, lib.ADMIN_PASSWORD));
const ok = (what, r) => {
  if (!r || r.success === false) throw new Error(`${what}: ${r?.error ?? 'sem resposta'}`);
  return r;
};

const PEOPLE = {
  sup: { username: 'e2e.sup', name: 'Sofia Supervisora', roles: ['user'] },
  op1: { username: 'e2e.op1', name: 'Otávio Operador', roles: ['operacao'] },
  op2: { username: 'e2e.op2', name: 'Olga Operadora', roles: ['operacao'] },
  ana: { username: 'e2e.ana', name: 'Ana Ribeiro', roles: ['user'] },
  beto: { username: 'e2e.beto', name: 'Beto Nunes', roles: ['user'] },
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

const SETTING_KEYS = ['Calls_Enabled', 'Calls_Group_Enabled', 'Calls_SFU_Url', 'Calls_SFU_Api_Key', 'Calls_SFU_Api_Secret', 'Calls_Restricted_Public', 'Calls_Restricted_Grace', 'API_Enable_Rate_Limiter'];
let savedSettings = null;

async function applySettings(lk) {
  const all = ok('settings', await admin.call('GET', 'settings'));
  savedSettings = {};
  for (const k of SETTING_KEYS) {
    const s = all.settings.find((x) => x._id === k);
    if (s) savedSettings[k] = s.value;
  }
  ok(
    'settings (chamadas)',
    await admin.call('POST', 'settings', {
      settings: {
        Calls_Enabled: true,
        Calls_Group_Enabled: true,
        Calls_SFU_Url: lk.httpUrl,
        Calls_SFU_Api_Key: lk.key,
        Calls_SFU_Api_Secret: lk.secret,
        Calls_Restricted_Public: 'pairs',
        // Cenário 2: a pausa encerra a chamada em 10 s (o mínimo da configuração).
        Calls_Restricted_Grace: 10,
        // calls.start em grupo aceita 3 por minuto; o roteiro inicia mais que isso.
        API_Enable_Rate_Limiter: false,
      },
    }),
  );
  const st = ok('calls.sfu.status', await admin.call('GET', 'calls.sfu.status'));
  if (st.urlFromEnv || st.url !== lk.httpUrl) {
    throw new Error(`O chat usa o servidor de chamadas ${st.url} (variáveis LIVEKIT_* no ambiente dele). Suba o chat sem LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET para o roteiro usar o próprio LiveKit.`);
  }
  await waitFor('o chat alcançar o LiveKit', async () => (await admin.call('GET', 'calls.sfu.status')).reachable, { timeout: 15000, every: 500 });
}

async function restoreSettings() {
  if (!savedSettings) return;
  const values = { ...savedSettings };
  // O segredo vem mascarado; mandar a máscara de volta não muda nada no servidor.
  if (values.Calls_SFU_Api_Secret === '********') delete values.Calls_SFU_Api_Secret;
  const r = await admin.call('POST', 'settings', { settings: values }).catch((e) => ({ success: false, error: e.message }));
  if (r.success === false) log(`AVISO: não foi possível devolver as configurações: ${r.error}`);
}

let roomSeq = 0;
async function newChannel(label, members) {
  const name = `e2e-${RUN}-${++roomSeq}-${label}`;
  const r = ok(`channels.create ${name}`, await PEOPLE.sup.api.call('POST', 'channels.create', { name, members: members.map((m) => m.username) }));
  return r.channel._id;
}

async function liveCall(rid, who = PEOPLE.sup) {
  const r = await who.api.call('GET', 'calls.roomCall', { roomId: rid });
  return r.call ?? null;
}
async function callInfo(callId, who = PEOPLE.sup) {
  const r = await who.api.call('GET', 'calls.info', { callId });
  return r.call ?? null;
}

async function endAllCalls() {
  const r = await admin.call('GET', 'calls.admin.active');
  for (const c of r.calls ?? []) await admin.call('POST', 'calls.admin.end', { callId: c._id }).catch(() => {});
}

// ---------- LiveKit próprio ----------

const LK_BASE = Number(process.env.LIVEKIT_PORT_BASE || 27880);
if (!Number.isInteger(LK_BASE) || LK_BASE < 1024 || LK_BASE > 65530 || (LK_BASE + 5 >= 7880 && LK_BASE <= 7885)) {
  console.error('LIVEKIT_PORT_BASE inválida: use uma porta livre de 1024 a 65530, fora de 7880-7885.');
  process.exit(2);
}

function lanIpv4() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

const tcpFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
const udpFree = (port) =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => resolve(false));
    s.bind(port, () => s.close(() => resolve(true)));
  });

const LK = {
  key: `API${crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(12, 'x').slice(0, 12)}`,
  secret: crypto.randomBytes(32).toString('base64url'),
  http: LK_BASE,
  httpUrl: `http://127.0.0.1:${LK_BASE}`,
  dir: path.join(OUT, 'livekit'),
  proc: null,
  starts: 0,
};

function writeLivekitConfig() {
  fs.mkdirSync(LK.dir, { recursive: true });
  const secretFile = path.join(LK.dir, 'secret');
  fs.writeFileSync(secretFile, LK.secret, { mode: 0o600 });
  const chatPort = new URL(CHAT_URL).port || (CHAT_URL.startsWith('https') ? '443' : '80');
  const lan = lanIpv4();
  let text = renderConfig({
    nodeIp: lan ?? '127.0.0.1',
    lanCidr: `${lan ?? '127.0.0.1'}/32`,
    apiKey: LK.key,
    secretFile,
    webhookUrl: process.env.WEBHOOK_URL || `http://127.0.0.1:${chatPort}/sfu-webhook`,
    cores: Math.min(64, os.availableParallelism?.() ?? os.cpus().length),
    maxMbps: 480,
    warn: () => {},
  });
  // O modelo traz as portas de produção (7880-7885): aqui o LiveKit usa as do roteiro.
  text = text
    .replace(/^port: 7880$/m, `port: ${LK.http}`)
    .replace(/^(\s+)tcp_port: 7881$/m, `$1tcp_port: ${LK.http + 1}`)
    .replace(/^(\s+)udp_port: "7882-7885"$/m, `$1udp_port: "${LK.http + 2}-${LK.http + 5}"`);
  if (!lan) text = text.replace(/^(\s+)enable_loopback_candidate: false$/m, '$1enable_loopback_candidate: true');
  check(!/788[0-5]/.test(text.replace(/^keys:[\s\S]*?^room:/m, '')), 'a configuração do LiveKit ainda tem uma porta 7880-7885');
  LK.config = path.join(LK.dir, 'livekit.yaml');
  fs.writeFileSync(LK.config, text, { mode: 0o600 });
  fs.rmSync(secretFile, { force: true });
}

async function startLivekit() {
  for (let i = 0; i < 40; i++) {
    const free = (await tcpFree(LK.http)) && (await tcpFree(LK.http + 1)) && (await Promise.all([2, 3, 4, 5].map((d) => udpFree(LK.http + d)))).every(Boolean);
    if (free) break;
    if (i === 39) throw new Error(`As portas ${LK.http}-${LK.http + 5} estão ocupadas. Escolha outra LIVEKIT_PORT_BASE.`);
    await sleep(500);
  }
  const fd = fs.openSync(path.join(OUT, 'livekit.log'), 'a');
  LK.proc = spawn(LIVEKIT_BIN, ['--config', LK.config], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  LK.starts++;
  const proc = LK.proc;
  proc.on('exit', (code, sig) => {
    if (LK.proc === proc) log(`LiveKit saiu (código ${code ?? '-'}, sinal ${sig ?? '-'})`);
    proc.exited = true;
  });
  await waitFor('o LiveKit responder', async () => {
    if (proc.exited) throw new Error('o processo do LiveKit terminou; veja livekit.log');
    const r = await fetch(`${LK.httpUrl}/`).catch(() => null);
    return r?.ok;
  }, { timeout: 20000, every: 300 });
}

async function stopLivekit() {
  const proc = LK.proc;
  if (!proc || proc.exited) return;
  LK.proc = null;
  proc.kill('SIGTERM');
  for (let i = 0; i < 40 && !proc.exited; i++) await sleep(250);
  if (!proc.exited) {
    proc.kill('SIGKILL');
    for (let i = 0; i < 20 && !proc.exited; i++) await sleep(250);
  }
}

function signJwt(claims) {
  const b = (x) => Buffer.from(x).toString('base64url');
  const head = b(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b(JSON.stringify(claims));
  return `${head}.${body}.${crypto.createHmac('sha256', LK.secret).update(`${head}.${body}`).digest('base64url')}`;
}
async function twirp(method, body, grant) {
  const now = Math.floor(Date.now() / 1000);
  const r = await fetch(`${LK.httpUrl}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signJwt({ iss: LK.key, nbf: now - 5, exp: now + 60, video: grant })}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method}: ${j.code ?? r.status} ${j.msg ?? ''}`), { code: j.code });
  return j;
}
async function lkParticipants(callId) {
  const room = `wc_${callId}`;
  try {
    return (await twirp('ListParticipants', { room }, { roomAdmin: true, room })).participants ?? [];
  } catch (e) {
    if (e.code === 'not_found') return [];
    throw e;
  }
}
const lkOf = (list, person) => list.find((p) => p.identity === person.id);
const trackSources = (p) => (p?.tracks ?? []).map((t) => String(t.source ?? 'UNKNOWN').toLowerCase());

// lk mostra as faixas de uma pessoa (só para conferência; a chave e o segredo vão pelo ambiente).
function lkGet(callId, identity) {
  return new Promise((resolve) => {
    const child = spawn(process.env.LK_BIN, ['room', 'participants', 'get', '--room', `wc_${callId}`, identity], {
      env: { ...process.env, LIVEKIT_URL: LK.httpUrl, LIVEKIT_API_KEY: LK.key, LIVEKIT_API_SECRET: LK.secret },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
  });
}

// ---------- Navegador ----------

const chromium = await lib.loadChromium();
const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// Na página, antes do app: guarda as RTCPeerConnection (getStats, getConfiguration) e anota os textos que aparecem
// (avisos, faixas, fim da chamada), porque muitos somem em poucos segundos.
const INIT = () => {
  const pcs = [];
  window.__pcs = pcs;
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    const Wrapped = function (...args) {
      const pc = new Orig(...args);
      pcs.push(pc);
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  }
  const seen = [];
  window.__seen = seen;
  const SEL = ['.toast-text', '.call-banner', '.call-end', '.call-status', '.call-version', '.call-note', '.call-room-banner-title'];
  const present = new Set();
  let queued = false;
  const scan = () => {
    queued = false;
    const now = new Set();
    for (const sel of SEL) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text || (sel === '.call-status' && /^\d+:\d\d/.test(text))) continue;
        // A região de avisos do chat some (visibility: hidden) com a chamada ampliada: o mesmo aviso aparece na da chamada.
        if (getComputedStyle(el).visibility === 'hidden') continue;
        const k = `${sel}|${text}`;
        now.add(k);
        if (!present.has(k)) seen.push({ t: Date.now(), sel, text });
      }
    }
    present.clear();
    for (const k of now) present.add(k);
  };
  const mo = new MutationObserver(() => {
    if (!queued) {
      queued = true;
      setTimeout(scan, 100);
    }
  });
  const go = () => mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) go();
  else document.addEventListener('DOMContentLoaded', go);
};

let browser = null;
const pages = {};
const shots = [];

async function open(name, person, { phone = false, scheme = 'light', url = '/home' } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), colorScheme: scheme, permissions: ['camera', 'microphone'], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const e = { name, ctx, page, person, logs: [], tokens: [], loadedAt: 0, phone };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') e.logs.push(`${new Date().toISOString()} ${m.type()}: ${m.text()}`.slice(0, 600));
  });
  page.on('pageerror', (err) => e.logs.push(`${new Date().toISOString()} pageerror: ${err.message}`.slice(0, 600)));
  page.on('load', () => (e.loadedAt = Date.now()));
  // Tokens renovados que o LiveKit manda pelo websocket da sinalização (refresh_token): usados no S2.
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/sfu/rtc')) return;
    ws.on('framereceived', (f) => {
      const raw = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1');
      for (const m of raw.matchAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g)) {
        try {
          const claims = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8'));
          if (claims.sub === person.id && claims.iss === LK.key) e.tokens.push({ at: Date.now(), token: m[0], claims });
        } catch {
          // não é um JWT
        }
      }
    });
  });
  await page.goto(`${CHAT_URL}/login`);
  await page.fill('form input >> nth=0', person.username);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar, .tabbar, .layout', { timeout: 30000 });
  if (url) await page.goto(`${CHAT_URL}${url}`);
  pages[name] = e;
  return e;
}

async function close(name) {
  const e = pages[name];
  if (!e) return;
  delete pages[name];
  fs.appendFileSync(path.join(OUT, `console-${name}.log`), e.logs.join('\n') + (e.logs.length ? '\n' : ''));
  const seen = await seenTexts(e);
  fs.appendFileSync(path.join(OUT, `textos-${name}.log`), seen.map((x) => `${new Date(x.t).toISOString()} ${x.sel} ${x.text}`).join('\n') + (seen.length ? '\n' : ''));
  await e.ctx.close().catch(() => {});
}

async function shot(e, file) {
  const f = path.join(SHOTS, `${file}.png`);
  // Sem animação: um modal no meio do modal-in sai translúcido na captura.
  await e.page.screenshot({ path: f, animations: 'disabled' }).catch(() => {});
  shots.push(f);
  return f;
}

async function goRoom(e, rid, t = 'channel') {
  await e.page.goto(`${CHAT_URL}/${t}/${rid}`);
  await e.page.waitForSelector('header.room-header:not(.room-header-error)', { timeout: 20000 });
}

const seenTexts = (e, since = 0) => e.page.evaluate((s) => (window.__seen ?? []).filter((x) => x.t >= s), since).catch(() => []);
const sawText = async (e, re, since = 0) => (await seenTexts(e, since)).find((x) => re.test(x.text)) ?? null;
// Depois de uma reconexão, quem já estava na chamada não "entra" de novo. Conta a partir do "Reconectando…" de cada
// página: um aviso de entrada de antes pode chegar atrasado (o nome vem do calls.info, no máximo um a cada 2 s).
async function noGhostArrivals(people, t) {
  for (const e of people) {
    const since = (await sawText(e, /^Reconectando…/, t))?.t ?? t + 3000;
    const ghost = (await seenTexts(e, since)).filter((x) => x.sel === '.toast-text' && / (entrou|saiu)$/.test(x.text));
    check(!ghost.length, `${e.name} viu aviso de entrada ou saída de quem já estava na chamada: ${ghost.map((x) => x.text).join(' | ')}`);
  }
}
const count = (e, sel) => e.page.locator(sel).count();

// Quadros de câmera (sem as telas e o "mais") no palco da chamada.
const TILE = '.call-stage .call-tile:not(.screen):not(.call-more-tile)';
const tiles = (e) => count(e, TILE);

async function clickPreflight(e, label) {
  const btn = e.page.locator('.call-preflight button.btn.primary');
  await btn.waitFor({ timeout: 20000 });
  await waitFor('o botão da tela de entrada ficar livre', async () => (await btn.getAttribute('aria-disabled')) !== 'true' && (await btn.isEnabled()), { timeout: 20000 });
  const text = (await btn.innerText()).trim();
  check(text === label, `a tela de entrada mostra "${text}" no botão principal, em vez de "${label}"`);
  await btn.click();
}

async function waitInLk(callId, person, timeout = 30000) {
  return waitFor(`${person.username} aparecer no LiveKit`, async () => lkOf(await lkParticipants(callId), person), { timeout, every: 500 });
}

async function startCall(e, rid, kind = 'video') {
  await e.page.click(`button.call-start[title="${kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'}"]`);
  await clickPreflight(e, 'Iniciar chamada');
  await e.page.waitForSelector('.call-window.group', { timeout: 20000 });
  const call = await waitFor('a chamada aparecer na sala', () => liveCall(rid));
  await waitInLk(call._id, e.person);
  return call._id;
}

async function joinFromBanner(e, callId) {
  const b = e.page.locator('.call-room-banner button.call-join');
  await b.waitFor({ timeout: 20000 });
  await b.click();
  await clickPreflight(e, 'Entrar agora');
  await e.page.waitForSelector('.call-window.group', { timeout: 20000 });
  await waitInLk(callId, e.person);
}

// Abre a sala para todos, inicia com o primeiro e os outros entram pela faixa da sala.
async function callIn(rid, starter, joiners, kind = 'video') {
  for (const e of [starter, ...joiners]) await goRoom(e, rid);
  const callId = await startCall(starter, rid, kind);
  for (const e of joiners) await joinFromBanner(e, callId);
  const n = 1 + joiners.length;
  for (const e of [starter, ...joiners]) await waitFor(`${e.name} ver ${n} quadros`, async () => (await tiles(e)) === n, { timeout: 20000 });
  return callId;
}

// Clica num botão da barra da chamada (acorda os controles antes).
async function ctl(e, title) {
  await wake(e);
  await e.page.click(`.call-window button.call-btn[title="${title}"]`);
}

async function leave(e) {
  await ctl(e, 'Sair da chamada');
}

// Fecha o que sobrou na tela: fim da chamada, aviso de outro dispositivo, chamada recebida.
async function tidy(e) {
  for (let i = 0; i < 4; i++) {
    const p = e.page;
    const btn = p.locator('.call-end button:has-text("Fechar"), .call-incoming button[title="Recusar"], .modal.confirm button:has-text("Cancelar")');
    if (!(await btn.count())) return;
    await btn.first().click({ timeout: 3000 }).catch(() => {});
    await sleep(400);
  }
}

async function resetAll() {
  await endAllCalls().catch(() => {});
  await sleep(800);
  for (const e of Object.values(pages)) {
    await waitFor(`${e.name} sair da chamada`, async () => !(await count(e, '.call-window.group')) || (await count(e, '.call-end')), { timeout: 10000 }).catch(() => {});
    await tidy(e);
  }
}

// Bytes de vídeo recebidos e pacotes RTP enviados, somados em todas as conexões da página.
const mediaStats = (e) =>
  e.page.evaluate(async () => {
    let inVideo = 0;
    let outPackets = 0;
    let outRtp = 0;
    for (const pc of window.__pcs ?? []) {
      let st;
      try {
        st = await pc.getStats();
      } catch {
        continue;
      }
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inVideo += r.bytesReceived ?? 0;
        if (r.type === 'outbound-rtp') {
          outRtp++;
          outPackets += r.packetsSent ?? 0;
        }
      });
    }
    return { inVideo, outPackets, outRtp, pcs: (window.__pcs ?? []).length };
  });

async function videoFlowing(e, ms = 2500) {
  const a = await mediaStats(e);
  await sleep(ms);
  const b = await mediaStats(e);
  return b.inVideo - a.inVideo;
}

// Portas UDP locais das conexões de mídia (para o NET_DROP=iptables).
const localUdpPorts = (e) =>
  e.page.evaluate(async () => {
    const ports = new Set();
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const st = await pc.getStats();
      const pairs = [];
      st.forEach((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && pairs.push(r));
      for (const pr of pairs) {
        const c = st.get(pr.localCandidateId);
        if (c?.protocol === 'udp' && c.port) ports.add(c.port);
      }
    }
    return [...ports];
  });

function runCmd(cmd, args, { timeout = 120000, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = shell ? spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
  });
}

// Pedido HTTP de upgrade para o websocket da ponte /sfu: devolve o código (101 = conectou).
function wsUpgradeStatus(token) {
  return new Promise((resolve) => {
    const u = new URL(`${CHAT_URL}/sfu/rtc`);
    u.searchParams.set('access_token', token);
    u.searchParams.set('auto_subscribe', '1');
    u.searchParams.set('sdk', 'js');
    u.searchParams.set('protocol', '16');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, timeout: 10000 });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('tempo esgotado');
    });
    req.on('error', (err) => resolve(`erro ${err.message}`));
    req.end();
  });
}
const validateStatus = async (token) => (await fetch(`${CHAT_URL}/sfu/rtc/validate?access_token=${encodeURIComponent(token)}`)).status;

// O elemento do seletor (o último visível) é o de cima no centro dele?
const topmost = (e, sel, text) =>
  e.page.evaluate(
    ([sel, text]) => {
      const els = [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        // A região de avisos do chat fica invisível (visibility: hidden) com a chamada ampliada: não conta.
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (!text || (el.textContent ?? '').includes(text));
      });
      const el = els[els.length - 1];
      const fs = document.fullscreenElement ? document.fullscreenElement.className : null;
      if (!el) return { ok: false, hit: null, fs, why: `nenhum ${sel} visível` };
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const desc = (n) => (n ? `${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''}` : null);
      // Fundo efetivo (o primeiro não transparente subindo) e a luminância dele: a camada da chamada é escura nos dois temas (G29).
      let bg = null;
      for (let n = el; n && !bg; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor.match(/[\d.]+/g)?.map(Number);
        if (c && (c.length < 4 || c[3] > 0.5)) bg = c;
      }
      const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      const lum = bg ? 0.2126 * lin(bg[0]) + 0.7152 * lin(bg[1]) + 0.0722 * lin(bg[2]) : null;
      return { ok: !!hit && el.contains(hit), hit: desc(hit), fs, bg: bg ? `rgb(${bg.slice(0, 3).join(', ')})` : null, lum };
    },
    [sel, text ?? null],
  );

// Sem mexer, os controles da janela ampliada somem (.idle); um toque ou o mouse no palco os traz de volta.
async function wake(e) {
  if (!(await count(e, '.call-window.idle'))) return;
  if (e.phone) await e.page.locator('.call-stage').tap({ position: { x: 20, y: 120 } });
  else await e.page.mouse.move(700 + Math.random() * 20, 400);
  await waitFor('os controles da chamada voltarem', async () => !(await count(e, '.call-window.idle')), { timeout: 5000, every: 100 });
}

async function openMore(e) {
  await wake(e);
  await ctl(e, 'Mais opções da chamada');
  await e.page.waitForSelector('[role="menu"].call-menu', { timeout: 5000 });
}
async function menuItem(e, text) {
  await e.page.locator('[role="menu"] button', { hasText: text }).first().click();
}
async function tileMenu(e, person, { screen = false } = {}) {
  const tile = e.page.locator(`.call-stage .call-tile${screen ? '.screen' : ':not(.screen)'}`, { has: e.page.locator(`button.call-tile-menu[title="Opções de ${person.name}"]`) }).first();
  await tile.hover();
  await tile.locator(`button.call-tile-menu[title="Opções de ${person.name}"]`).click();
  await e.page.waitForSelector('[role="menu"]', { timeout: 5000 });
}

// ---------- Cenários ----------

const results = [];

async function scenario(n, title, fn) {
  if (!wanted(n)) return;
  const c = { n, step: 'preparação', notes: [], cleanup: [] };
  c.step_ = (s) => {
    c.step = s;
    log(`  · ${s}`);
  };
  log(`Cenário ${n}: ${title}`);
  const t0 = Date.now();
  try {
    await fn(c);
    results.push({ n, title, status: 'OK', notes: c.notes, seconds: Math.round((Date.now() - t0) / 1000) });
    log(`Cenário ${n}: OK`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ n, title, status: 'IGNORADO', detail: err.message, notes: c.notes });
      log(`Cenário ${n}: IGNORADO (${err.message})`);
    } else {
      const evidence = [];
      for (const e of Object.values(pages)) evidence.push(await shot(e, `${String(n).padStart(2, '0')}-falha-${e.name}`));
      results.push({ n, title, status: 'FALHOU', step: c.step, detail: err.message, notes: c.notes, evidence });
      log(`Cenário ${n}: FALHOU no passo "${c.step}": ${err.message}`);
    }
  } finally {
    for (const f of c.cleanup.reverse()) await f().catch((err) => log(`AVISO: limpeza do cenário ${n}: ${err.message}`));
    await resetAll();
  }
}

const S = (n) => String(n).padStart(2, '0');

async function main() {
  log(`Chat ${CHAT_URL}; LiveKit ${LIVEKIT_BIN} nas portas ${LK.http}-${LK.http + 5}; saída em ${OUT}`);
  writeLivekitConfig();
  await startLivekit();
  for (const p of Object.values(PEOPLE)) await ensurePerson(p);
  await applySettings(LK);
  const cfg = ok('calls.config', await PEOPLE.sup.api.call('GET', 'calls.config'));
  check(cfg.groupEnabled && cfg.sfu, `o chat não liberou chamadas em grupo (groupEnabled=${cfg.groupEnabled}, sfu=${cfg.sfu})`);
  await endAllCalls();

  browser = await chromium.launch({
    executablePath: lib.executablePath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'],
  });
  const { sup: SUP, op1: OP1, op2: OP2, ana: ANA, beto: BETO } = PEOPLE;
  const sup = await open('sup', SUP);
  const op1 = await open('op1', OP1);
  const op2 = await open('op2', OP2, { scheme: 'dark' });

  // 1. Supervisor e dois operadores: quadros, anel de fala, tela sem áudio, mão, nomes das faixas e ICE vazio.
  await scenario(1, 'Supervisor inicia; dois operadores entram pela faixa da sala', async (c) => {
    const rid = await newChannel('grade', [OP1, OP2]);
    c.step_('supervisor inicia a chamada de vídeo pelo cabeçalho; operadores entram pela faixa');
    for (const e of [sup, op1, op2]) await goRoom(e, rid);
    await waitFor('o botão Chamada de vídeo aparecer para o supervisor', () => count(sup, 'button.call-start[title="Chamada de vídeo"]'));
    const callId = await startCall(sup, rid);
    await waitFor('a faixa "Chamada em andamento" aparecer para o operador', async () => (await op1.page.locator('.call-room-banner .call-room-banner-title').innerText().catch(() => '')).includes('Chamada em andamento'));
    await shot(op1, `${S(1)}-faixa-da-sala-op1`);
    for (const e of [op1, op2]) await joinFromBanner(e, callId);
    c.step_('cada página mostra 3 quadros com o vídeo dos outros dois');
    for (const e of [sup, op1, op2]) {
      await waitFor(`${e.name} ver 3 quadros`, async () => (await tiles(e)) === 3, { timeout: 20000 });
      await waitFor(`${e.name} receber 2 vídeos`, () => e.page.evaluate(() => [...document.querySelectorAll('.call-stage video.call-remote')].filter((v) => v.videoWidth > 0).length >= 2), { timeout: 20000 });
    }
    c.step_('anel de quem fala (.call-tile.speaking)');
    await waitFor('um quadro com o anel de fala', async () => {
      for (const e of [sup, op1, op2]) if (await count(e, '.call-tile.speaking')) return true;
      return false;
    }, { timeout: 45000, every: 300 });
    await shot(sup, `${S(1)}-grade-sup`);
    await shot(op2, `${S(1)}-grade-op2-escuro`);

    c.step_('operador 1 compartilha a tela (sem faixa de áudio)');
    await ctl(op1, 'Compartilhar tela');
    await op1.page.waitForSelector('.call-window button.call-btn[title="Parar de compartilhar"]', { timeout: 15000 });
    await waitFor('o supervisor ver a tela do operador', () => sup.page.evaluate(() => [...document.querySelectorAll('.call-tile.screen video')].some((v) => v.videoWidth > 0)), { timeout: 20000 });
    const lk = await waitFor('o LiveKit listar a tela do operador', async () => {
      const list = await lkParticipants(callId);
      return trackSources(lkOf(list, OP1)).includes('screen_share') ? list : null;
    });
    check(!trackSources(lkOf(lk, OP1)).includes('screen_share_audio'), 'o operador publicou uma faixa de áudio da tela (screen_share_audio) com "Compartilhar tela"');
    c.step_('todas as faixas publicadas têm nome fixo (CALL_TRACK_NAMES = fonte)');
    const bad = [];
    for (const p of lk) for (const t of p.tracks ?? []) if (!CALL_TRACK_NAMES.includes(t.name) || t.name !== String(t.source ?? '').toLowerCase()) bad.push(`${p.identity}: "${t.name ?? ''}" (${t.source})`);
    check(lk.length === 3, `o LiveKit lista ${lk.length} participantes, não 3`);
    check(!bad.length, `faixas com nome fora da lista: ${bad.join('; ')}`);
    c.notes.push(`faixas: ${lk.map((p) => `${p.identity}=${(p.tracks ?? []).map((t) => t.name).join('+')}`).join(', ')}`);
    if (process.env.LK_BIN) {
      const r = await lkGet(callId, OP1.id);
      fs.writeFileSync(path.join(OUT, `${S(1)}-lk-participants-get.txt`), r.out);
      check(r.code === 0, `lk room participants get saiu com ${r.code}`);
      let names = null;
      try {
        names = (JSON.parse(r.out.slice(r.out.indexOf('{'))).tracks ?? []).map((t) => `${t.name}/${t.source}`);
      } catch {
        // saída que não é JSON: o check abaixo mostra
      }
      check(names, 'lk room participants get não devolveu o participante em JSON');
      check(names.includes('screen_share/SCREEN_SHARE') && !names.some((n) => /SCREEN_SHARE_AUDIO/.test(n)), `lk room participants get mostra as faixas ${names.join(', ')}`);
      c.notes.push(`lk: ${names.join(', ')}`);
    }
    await shot(sup, `${S(1)}-tela-compartilhada-sup`);
    await ctl(op1, 'Parar de compartilhar');
    await waitFor('a tela sair do LiveKit', async () => !trackSources(lkOf(await lkParticipants(callId), OP1)).includes('screen_share'));

    c.step_('operador 1 levanta a mão; o supervisor baixa pelo menu do quadro');
    const tHand = Date.now();
    await ctl(op1, 'Levantar a mão');
    await waitFor('o supervisor ver "Mão levantada" no quadro do operador', () => count(sup, '.call-tile [aria-label="Mão levantada"]'));
    await waitFor('o aviso "levantou a mão" para o supervisor', () => sawText(sup, /Otávio Operador levantou a mão/, tHand));
    await shot(sup, `${S(1)}-mao-levantada-sup`);
    await tileMenu(sup, OP1);
    await menuItem(sup, 'Baixar a mão');
    await waitFor('o aviso "baixou sua mão" para o operador', () => sawText(op1, /baixou sua mão\./, tHand));
    await waitFor('o botão do operador voltar a "Levantar a mão"', () => count(op1, '.call-window button.call-btn[title="Levantar a mão"]'));
    await waitFor('o "Mão levantada" sumir para o supervisor', async () => !(await count(sup, '.call-tile [aria-label="Mão levantada"]')));

    c.step_('getConfiguration().iceServers vazio em todas as conexões (F2)');
    for (const e of [sup, op1, op2]) {
      const conf = await e.page.evaluate(() => (window.__pcs ?? []).map((pc) => pc.getConfiguration().iceServers ?? []));
      check(conf.length > 0, `${e.name}: nenhuma RTCPeerConnection criada`);
      const used = conf.filter((s) => s.length);
      check(!used.length, `${e.name}: RTCPeerConnection com iceServers ${JSON.stringify(used[0])}`);
    }
  });

  // 2. A trava: o supervisor sai, os operadores ficam pausados e a chamada acaba em 10 s. Antes, uma queda de rede
  // de 4 s do supervisor não pausa (ele ainda conta por 8 s).
  await scenario(2, 'O supervisor sai: pausa e fim em 10 s; queda de rede de 4 s não pausa', async (c) => {
    const rid = await newChannel('trava', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada');
    const callId = await callIn(rid, sup, [op1, op2]);

    c.step_('variante: a rede do supervisor cai por 4 s');
    const drop = Date.now();
    const ports = process.env.NET_DROP === 'iptables' ? await localUdpPorts(sup) : [];
    const rules = ports.flatMap((port) => [['OUTPUT', '-p', 'udp', '--sport', String(port), '-j', 'DROP'], ['INPUT', '-p', 'udp', '--dport', String(port), '-j', 'DROP']]);
    const added = [];
    let paused = null;
    const watch = (async () => {
      while (Date.now() - drop < 18000 && !paused) {
        for (const e of [op1, op2]) if (await count(e, '.call-guard')) paused = `${e.name} viu "${CALL_GUARD_TITLE}"`;
        const info = await callInfo(callId);
        if (info?.guardUntil) paused = `calls.info trouxe guardUntil=${info.guardUntil}`;
        if (info && info.status !== 'ongoing') paused = `a chamada terminou (${info.endedReason})`;
        await sleep(300);
      }
    })();
    try {
      await sup.ctx.setOffline(true);
      for (const r of rules) {
        const x = await runCmd('iptables', ['-I', ...r]);
        if (x.code !== 0) throw new Error(`iptables -I falhou: ${x.out.trim()}`);
        added.push(r);
      }
      await sleep(4000);
    } finally {
      for (const r of added) await runCmd('iptables', ['-D', ...r]);
      await sup.ctx.setOffline(false);
    }
    await watch;
    c.notes.push(`queda: setOffline${ports.length ? ` + iptables nas portas UDP ${ports.join(', ')}` : ''}; o supervisor viu: ${(await seenTexts(sup, drop)).map((x) => x.text).join(' | ') || 'nada'}`);
    check(!paused, `a chamada pausou com a queda de 4 s do supervisor: ${paused}`);
    await waitFor('o supervisor seguir no LiveKit', async () => lkOf(await lkParticipants(callId), SUP), { timeout: 20000 });

    c.step_('o supervisor sai: faixa "Aguardando um supervisor" e microfones bloqueados');
    const tLeave = Date.now();
    await leave(sup);
    for (const e of [op1, op2]) {
      await waitFor(`${e.name} ver "${CALL_GUARD_TITLE}"`, async () => (await e.page.locator('.call-banner.call-guard').innerText().catch(() => '')).includes(CALL_GUARD_TITLE), { timeout: 15000, every: 200 });
      await waitFor(`${e.name} ver o microfone bloqueado`, () => count(e, `.call-window button.call-btn[aria-disabled="true"][title="${GUARD_PAUSED}"]`), { timeout: 10000 });
    }
    const tGuard = Date.now();
    c.notes.push(`pausa ${((tGuard - tLeave) / 1000).toFixed(1)} s depois da saída`);
    await shot(op1, `${S(2)}-pausa-op1`);
    await shot(op2, `${S(2)}-pausa-op2-escuro`);
    const lkPaused = await lkParticipants(callId);
    const publishing = lkPaused.filter((p) => (p.tracks ?? []).some((t) => !t.muted && /MICROPHONE|CAMERA/.test(String(t.source))));
    c.notes.push(`faixas no LiveKit durante a pausa: ${lkPaused.map((p) => `${p.identity}=${trackSources(p).join('+') || 'nenhuma'}`).join(', ')}`);

    c.step_('a chamada termina com o texto da trava (Calls_Restricted_Grace = 10 s)');
    for (const e of [op1, op2]) {
      await waitFor(`${e.name} ver o fim da chamada`, async () => (await e.page.locator('.call-end').innerText().catch(() => '')).includes(CALL_GUARD_ENDED), { timeout: 35000, every: 300 });
    }
    const tEnd = Date.now();
    const info = await callInfo(callId);
    c.notes.push(`fim ${((tEnd - tGuard) / 1000).toFixed(1)} s depois da pausa; endedReason=${info?.endedReason}`);
    await shot(op1, `${S(2)}-fim-op1`);
    check(info?.status === 'ended' && info.endedReason === 'restricted', `calls.info: status ${info?.status}, endedReason ${info?.endedReason}`);
    check(tEnd - tGuard >= 7000, `a chamada terminou ${((tEnd - tGuard) / 1000).toFixed(1)} s depois da pausa, antes dos 10 s`);
    check(tEnd - tLeave <= 30000, `a chamada levou ${((tEnd - tLeave) / 1000).toFixed(1)} s para terminar depois da saída`);
    check(!publishing.length, `durante a pausa ainda havia microfone ou câmera publicados no LiveKit: ${publishing.map((p) => p.identity).join(', ')}`);
  });

  // 3. Conversa com várias pessoas: toca para as duas; Ana recusa, Beto atende.
  await scenario(3, 'Conversa com várias pessoas: uma recusa, outra atende', async (c) => {
    const ana = await open('ana', ANA);
    const beto = await open('beto', BETO);
    c.cleanup.push(async () => {
      await resetAll();
      await close('ana');
      await close('beto');
    });
    {
      const dm = ok('im.create', await SUP.api.call('POST', 'im.create', { usernames: [ANA.username, BETO.username] }));
      const rid = dm.room.rid ?? dm.room._id;
      c.step_('supervisor inicia a chamada de vídeo na conversa');
      await goRoom(sup, rid, 'direct');
      await sup.page.click('button.call-start[title="Chamada de vídeo"]');
      await sup.page.waitForSelector('.call-preflight', { timeout: 15000 });
      const note = await sup.page.locator('.call-preflight').innerText();
      check(note.includes('Todos desta conversa vão receber a chamada.'), 'a tela de entrada não diz "Todos desta conversa vão receber a chamada."');
      await clickPreflight(sup, 'Iniciar chamada');
      await sup.page.waitForSelector('.call-window.group', { timeout: 20000 });
      const call = await waitFor('a chamada aparecer na conversa', () => liveCall(rid));
      c.step_('Ana e Beto recebem a chamada');
      for (const e of [ana, beto]) {
        await e.page.waitForSelector('.call-incoming', { timeout: 20000 });
        const text = await e.page.locator('.call-incoming').innerText();
        check(text.includes(`@${SUP.username} está chamando você`), `${e.name}: a chamada recebida não diz "@${SUP.username} está chamando você" (${text.replace(/\s+/g, ' ')})`);
        check(text.includes('Chamada de vídeo em grupo'), `${e.name}: a chamada recebida não diz "Chamada de vídeo em grupo"`);
      }
      await shot(ana, `${S(3)}-chamada-recebida-ana`);
      // A lista fica aberta antes da recusa: a mudança tem de chegar sem fechar e abrir de novo.
      c.step_('a lista de participantes do supervisor mostra Ana e Beto como "Chamando…"');
      await ctl(sup, 'Participantes');
      await sup.page.waitForSelector('.call-people', { timeout: 5000 });
      for (const u of [ANA, BETO]) {
        await waitFor(`"Chamando…" para ${u.name} na lista do supervisor`, async () => {
          const row = sup.page.locator('.call-people-row', { hasText: u.name });
          return (await row.count()) && (await row.first().innerText()).includes('Chamando…');
        }, { timeout: 10000 });
      }
      c.step_('Ana recusa; Beto atende');
      await ana.page.click('.call-incoming button[title="Recusar"]');
      await beto.page.click('.call-incoming button[title="Atender"]');
      await beto.page.waitForSelector('.call-window.group', { timeout: 20000 });
      await waitInLk(call._id, BETO);
      for (const e of [sup, beto]) await waitFor(`${e.name} ver 2 quadros`, async () => (await tiles(e)) === 2, { timeout: 20000 });
      await waitFor('a chamada sumir da tela da Ana', async () => !(await count(ana, '.call-incoming, .call-window')), { timeout: 10000 });
      c.step_('o servidor marca a recusa da Ana');
      const st = async (u) => (await callInfo(call._id))?.participants?.find((p) => p.user._id === u.id)?.state;
      await waitFor('calls.info trazer Ana como declined', async () => {
        const [a, b] = [await st(ANA), await st(BETO)];
        if (a === 'declined' && b === 'joined') return true;
        throw new Error(`calls.info: Ana ${a}, Beto ${b}`);
      }, { timeout: 10000 });
      c.step_('a lista de participantes, ainda aberta, mostra Ana como "Recusou"');
      await sup.page.waitForSelector('.call-people', { timeout: 5000 });
      await waitFor('"Recusou" na lista do supervisor', async () => {
        const row = sup.page.locator('.call-people-row', { hasText: ANA.name });
        if ((await row.count()) && (await row.first().innerText()).includes('Recusou')) return true;
        throw new Error(`calls.info já traz Ana como declined, mas a lista mostra: ${(await sup.page.locator('.call-people').innerText()).replace(/\s+/g, ' ')}`);
      }, { timeout: 15000 });
      await shot(sup, `${S(3)}-participantes-sup`);
    }
  });

  // 4. Remoção: o removido não volta com o token renovado (S2); o moderador chama e ele volta.
  await scenario(4, 'Moderador remove um operador; o token renovado não reconecta (S2); chamado de novo, ele volta', async (c) => {
    const rid = await newChannel('remocao', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada');
    const callId = await callIn(rid, sup, [op1, op2]);
    const tok = await waitFor('o operador receber um token renovado do LiveKit', () => op1.tokens.at(-1), { timeout: 20000 });
    const before = await validateStatus(tok.token);
    c.notes.push(`token renovado antes da remoção: /sfu/rtc/validate = ${before}`);
    check(before === 200, `o token renovado do operador já era recusado antes da remoção (${before}): o teste S2 não diria nada`);

    c.step_('supervisor remove o operador pelo menu do quadro');
    const tRemove = Date.now();
    await tileMenu(sup, OP1);
    await menuItem(sup, 'Remover da chamada');
    const dlg = sup.page.locator('.modal.confirm');
    await dlg.waitFor({ timeout: 5000 });
    check((await dlg.innerText()).includes(`Remover ${OP1.name} da chamada?`), 'a confirmação não pergunta "Remover Otávio Operador da chamada?"');
    await shot(sup, `${S(4)}-confirmar-remocao-sup`);
    await dlg.locator('button', { hasText: 'Remover' }).click();
    await waitFor('o operador ver o fim com "removeu você da chamada."', async () => (await op1.page.locator('.call-end').innerText().catch(() => '')).includes('removeu você da chamada.'), { timeout: 15000 });
    await shot(op1, `${S(4)}-removido-op1`);
    await waitFor('o operador sair do LiveKit', async () => !lkOf(await lkParticipants(callId), OP1), { timeout: 15000 });

    c.step_('S2: o último token renovado do removido não passa pela ponte');
    const last = op1.tokens.at(-1);
    const v = await validateStatus(last.token);
    const w = await wsUpgradeStatus(last.token);
    c.notes.push(`depois da remoção: validate=${v}, websocket=${w} (token de ${new Date(last.at).toISOString()}, ${op1.tokens.length} tokens vistos)`);
    check(v === 401 || v === 403, `/sfu/rtc/validate com o token renovado do removido respondeu ${v}`);
    check(w === 401 || w === 403, `o websocket /sfu/rtc com o token renovado do removido respondeu ${w}`);
    await sleep(4000);
    check(!lkOf(await lkParticipants(callId), OP1), 'o removido voltou ao LiveKit sozinho');
    check((await tiles(op2)) === 2, `o outro operador vê ${await tiles(op2)} quadros, não 2`);

    c.step_('o supervisor chama o operador de novo (Mais > Chamar pessoas)');
    await tidy(op1);
    await openMore(sup);
    await menuItem(sup, 'Chamar pessoas');
    const picker = sup.page.locator('.modal.call-ring-picker');
    await picker.waitFor({ timeout: 5000 });
    await picker.locator('label.call-ring-row', { hasText: OP1.name }).locator('input[type="checkbox"]').check();
    await shot(sup, `${S(4)}-chamar-pessoas-sup`);
    await picker.locator('button.btn.primary', { hasText: 'Chamar' }).click();
    await waitFor('o aviso "Chamando 1 pessoa."', () => sawText(sup, /^Chamando 1 pessoa\.$/, tRemove));
    await op1.page.waitForSelector('.call-incoming', { timeout: 20000 });
    await op1.page.click('.call-incoming button[title="Atender"]');
    await op1.page.waitForSelector('.call-window.group', { timeout: 20000 });
    await waitInLk(callId, OP1);
    for (const e of [sup, op1, op2]) await waitFor(`${e.name} ver 3 quadros`, async () => (await tiles(e)) === 3, { timeout: 20000 });
    await shot(op1, `${S(4)}-de-volta-op1`);
  });

  // 5. S3: o token sai com o supervisor presente; ele sai antes da conexão; o operador não pode mandar RTP.
  await scenario(5, 'Corrida da trava (S3): token com o supervisor presente, conexão depois que ele sai', async (c) => {
    const rid = await newChannel('corrida', [OP1, OP2]);
    c.step_('supervisor e operador 1 na chamada');
    const callId = await callIn(rid, sup, [op1]);
    c.step_('operador 2 pede para entrar; a resposta de calls.join fica presa');
    await goRoom(op2, rid);
    const got = deferred();
    const release = deferred();
    let held = null;
    await op2.page.route('**/api/v1/calls.join', async (route) => {
      const resp = await route.fetch();
      const body = await resp.text();
      held = { status: resp.status(), body };
      got.resolve();
      await release.promise;
      await route.fulfill({ response: resp, body });
    });
    try {
      const b = op2.page.locator('.call-room-banner button.call-join');
      await b.waitFor({ timeout: 20000 });
      await b.click();
      await clickPreflight(op2, 'Entrar agora');
      await Promise.race([got.promise, sleep(20000)]);
      check(held, 'o pedido calls.join do operador 2 não saiu');
      const j = JSON.parse(held.body);
      check(held.status === 200 && j.join?.token, `calls.join com o supervisor presente respondeu ${held.status}: ${held.body.slice(0, 200)}`);
      c.notes.push(`token emitido com o supervisor presente: canPublish=${j.join.canPublish}, fontes=${(j.join.sources ?? []).join('+')}`);
      c.step_('o supervisor sai antes de o operador 2 conectar');
      await leave(sup);
      await waitFor('o supervisor sair do LiveKit', async () => !lkOf(await lkParticipants(callId), SUP), { timeout: 15000 });
      await sleep(1500);
    } finally {
      release.resolve();
    }
    const tRelease = Date.now();
    c.step_('o operador 2 nunca manda RTP nem publica no LiveKit');
    let maxPackets = 0;
    let lkTracks = [];
    let lkSeen = false;
    while (Date.now() - tRelease < 12000) {
      const st = await mediaStats(op2);
      maxPackets = Math.max(maxPackets, st.outPackets);
      const p = lkOf(await lkParticipants(callId), OP2);
      if (p) lkSeen = true;
      if (p?.tracks?.length) lkTracks = trackSources(p);
      await sleep(400);
    }
    await op2.page.unroute('**/api/v1/calls.join');
    const texts = (await seenTexts(op2, tRelease)).map((x) => x.text);
    c.notes.push(`operador 2: ${lkSeen ? 'chegou a entrar no LiveKit' : 'não entrou no LiveKit'}; viu: ${texts.join(' | ') || 'nada'}`);
    await shot(op2, `${S(5)}-depois-op2`);
    await shot(op1, `${S(5)}-depois-op1`);
    check(maxPackets === 0, `o operador 2 mandou ${maxPackets} pacotes RTP`);
    check(!lkTracks.length, `o operador 2 publicou no LiveKit: ${lkTracks.join(', ')}`);
  });

  // 6. F11: o moderador para uma tela; quem assiste para de receber em até 2 s.
  await scenario(6, 'Moderador para uma tela compartilhada: o inbound-rtp para em até 2 s (F11)', async (c) => {
    const rid = await newChannel('tela', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada; operador 1 compartilha a tela');
    const callId = await callIn(rid, sup, [op1, op2]);
    const tShare = Date.now();
    await ctl(op1, 'Compartilhar tela');
    await waitFor('o operador 2 ver a tela', () => op2.page.evaluate(() => [...document.querySelectorAll('.call-tile.screen video')].some((v) => v.videoWidth > 0)), { timeout: 20000 });
    await waitFor('o supervisor ver a tela', () => count(sup, '.call-tile.screen'), { timeout: 20000 });
    const trackId = await op2.page.evaluate(() => document.querySelector('.call-tile.screen video')?.srcObject?.getVideoTracks?.()[0]?.id ?? null);
    check(trackId, 'não achei a faixa da tela no quadro do operador 2');
    const screenBytes = () =>
      op2.page.evaluate(async (id) => {
        let total = null;
        for (const pc of window.__pcs ?? []) {
          let st;
          try {
            st = await pc.getStats();
          } catch {
            continue;
          }
          st.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === id) total = (total ?? 0) + (r.bytesReceived ?? 0);
          });
        }
        return total;
      }, trackId);
    const a = await screenBytes();
    await sleep(1500);
    const b = await screenBytes();
    check(a !== null && b > a, `o inbound-rtp da tela não estava crescendo antes da moderação (${a} → ${b})`);
    await shot(sup, `${S(6)}-tela-antes-sup`);

    c.step_('supervisor usa "Desligar vídeo" no menu do operador 1');
    await tileMenu(sup, OP1);
    await menuItem(sup, 'Desligar vídeo');
    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 < 4500) {
      samples.push({ t: Date.now() - t0, bytes: await screenBytes() });
      await sleep(150);
    }
    // Último instante em que os bytes ainda cresceram.
    let lastGrowth = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i].bytes !== null && samples[i - 1].bytes !== null && samples[i].bytes > samples[i - 1].bytes) lastGrowth = samples[i].t;
    c.notes.push(`o inbound-rtp da tela cresceu pela última vez ${lastGrowth} ms depois do clique (${samples.length} amostras; some aos ${samples.find((s) => s.bytes === null)?.t ?? '-'} ms)`);
    check(lastGrowth <= 2000, `o operador 2 ainda recebia a tela ${lastGrowth} ms depois do clique`);
    c.step_('o operador 1 recebe o aviso e o botão de tela fica bloqueado');
    await waitFor('o aviso "parou seu compartilhamento de tela" para o operador 1', () => sawText(op1, /parou seu compartilhamento de tela\./, tShare), { timeout: 10000 });
    await waitFor('o botão de tela bloqueado com o motivo', () => count(op1, `.call-window button.call-btn[aria-disabled="true"][title="${SCREEN_BLOCKED}"]`), { timeout: 10000 });
    await shot(op1, `${S(6)}-tela-parada-op1`);
    check(!trackSources(lkOf(await lkParticipants(callId), OP1)).includes('screen_share'), 'a tela continua publicada no LiveKit');
  });

  // 7. D2: na janela ampliada e na tela cheia, o que abre de dentro da chamada fica por cima.
  await scenario(7, 'Janela ampliada e tela cheia: menus, confirmação, Chamar pessoas e aviso por cima (D2)', async (c) => {
    const rid = await newChannel('camadas', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada');
    await callIn(rid, sup, [op1, op2]);
    check(await count(sup, '.call-window.group.g-big'), 'a chamada de vídeo do supervisor não abriu ampliada');
    const failures = [];
    const light = [];
    const probe = async (label, sel, text) => {
      const r = await topmost(sup, sel, text);
      if (!r.ok) failures.push(`${label}: ${r.why ?? `por cima está ${r.hit}`}${r.fs ? ` (tela cheia em .${r.fs})` : ''}`);
      if (r.lum != null && r.lum > 0.4) light.push(`${label}: fundo ${r.bg}`);
      return r;
    };
    const round = async (mode, raiser) => {
      c.step_(`${mode}: menu Mais`);
      await openMore(sup);
      await probe(`${mode}, menu Mais`, '[role="menu"].call-menu');
      await shot(sup, `${S(7)}-${mode}-menu-mais`);
      await sup.page.keyboard.press('Escape');
      c.step_(`${mode}: menu do quadro`);
      await tileMenu(sup, OP1);
      await probe(`${mode}, menu do quadro`, '[role="menu"]');
      await shot(sup, `${S(7)}-${mode}-menu-quadro`);
      await sup.page.keyboard.press('Escape');
      c.step_(`${mode}: confirmação de Encerrar para todos`);
      await openMore(sup);
      await menuItem(sup, 'Encerrar para todos');
      await sup.page.waitForSelector('.modal.confirm', { timeout: 5000 });
      await probe(`${mode}, confirmação`, '.modal.confirm');
      await shot(sup, `${S(7)}-${mode}-confirmacao`);
      await sup.page.locator('.modal.confirm button', { hasText: 'Cancelar' }).click();
      c.step_(`${mode}: Chamar pessoas`);
      await openMore(sup);
      await menuItem(sup, 'Chamar pessoas');
      await sup.page.waitForSelector('.modal.call-ring-picker', { timeout: 5000 });
      await probe(`${mode}, Chamar pessoas`, '.modal.call-ring-picker');
      await shot(sup, `${S(7)}-${mode}-chamar-pessoas`);
      await sup.page.locator('.modal.call-ring-picker button', { hasText: 'Cancelar' }).click();
      c.step_(`${mode}: aviso de mão levantada`);
      const t = Date.now();
      await ctl(raiser, 'Levantar a mão');
      const text = `${raiser.person.name} levantou a mão`;
      await waitFor(`o aviso "${text}"`, () => sup.page.locator('.toast', { hasText: text }).count(), { timeout: 10000, every: 150 });
      await probe(`${mode}, aviso`, '.toast', text);
      await shot(sup, `${S(7)}-${mode}-aviso`);
      await ctl(raiser, 'Baixar a mão');
      c.notes.push(`${mode}: aviso em ${Date.now() - t} ms`);
    };
    await round('ampliada', op1);
    c.step_('tela cheia');
    await wake(sup);
    await sup.page.click('.call-window button[title="Tela cheia"]');
    await waitFor('a tela cheia na .call-root', () => sup.page.evaluate(() => !!document.fullscreenElement?.classList.contains('call-root')), { timeout: 5000 });
    await round('tela-cheia', op2);
    await sup.page.click('.call-window button[title="Sair da tela cheia"]').catch(() => {});
    check(!failures.length, failures.join('; '));
    c.step_('a camada da chamada é escura nos dois temas (G29)');
    check(!light.length, `no tema claro, a camada da chamada saiu clara: ${light.join('; ')}`);
  });

  // 8. W12: o chat reinicia no meio da chamada.
  await scenario(8, 'O chat reinicia no meio da chamada (W12)', async (c) => {
    if (!process.env.CHAT_RESTART) throw new Skip('defina CHAT_RESTART com o comando que reinicia o chat');
    const rid = await newChannel('reinicio-chat', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada');
    const callId = await callIn(rid, sup, [op1, op2]);
    c.step_('o chat reinicia (CHAT_RESTART)');
    const t0 = Date.now();
    const r = await runCmd(process.env.CHAT_RESTART, [], { shell: true, timeout: 180000 });
    fs.writeFileSync(path.join(OUT, `${S(8)}-chat-restart.txt`), r.out);
    check(r.code === 0, `CHAT_RESTART saiu com ${r.code}: ${r.out.trim().slice(-300)}`);
    c.notes.push(`chat reiniciado em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    c.step_('"Reconectando…" e depois a chamada continua');
    await waitFor('alguém ver "Reconectando…"', async () => {
      for (const e of [sup, op1, op2]) if (await sawText(e, /^Reconectando…/, t0)) return true;
      return false;
    }, { timeout: 30000, every: 300 });
    await shot(op1, `${S(8)}-depois-op1`);
    for (const e of [sup, op1, op2]) {
      await waitFor(`${e.name} voltar ao normal`, async () => !(await count(e, '.call-end')) && !(await e.page.locator('.call-banner', { hasText: /Reconectando|Não foi possível reconectar/ }).count()) && (await tiles(e)) === 3, { timeout: 60000, every: 500 });
      const flow = await videoFlowing(e);
      check(flow > 0, `${e.name} não recebe mais vídeo depois do reinício`);
    }
    const reconnected = [];
    for (const e of [sup, op1, op2]) {
      const saw = await sawText(e, /^Reconectando…/, t0);
      const back = await sawText(e, /^Conexão restabelecida\.$/, t0);
      reconnected.push(`${e.name}: ${saw ? 'Reconectando…' : '-'} / ${back ? 'Conexão restabelecida.' : '-'}`);
      if (saw) check(back, `${e.name} viu "Reconectando…" mas não "Conexão restabelecida."`);
    }
    c.notes.push(reconnected.join('; '));
    await noGhostArrivals([sup, op1, op2], t0);
    const call = await liveCall(rid);
    check(call?._id === callId, `depois do reinício a sala tem a chamada ${call?._id ?? 'nenhuma'}, não ${callId}`);
    check((await lkParticipants(callId)).length === 3, 'o LiveKit não lista as 3 pessoas depois do reinício');
    await shot(sup, `${S(8)}-continua-sup`);
  });

  // 9. C1/C2: o LiveKit reinicia no meio da chamada.
  await scenario(9, 'O LiveKit reinicia no meio da chamada (C1, C2)', async (c) => {
    const rid = await newChannel('reinicio-livekit', [OP1, OP2]);
    c.step_('supervisor e dois operadores na chamada');
    const callId = await callIn(rid, sup, [op1, op2]);
    c.step_('o LiveKit para (SIGTERM, depois SIGKILL) e sobe de novo nas mesmas portas');
    const t0 = Date.now();
    await stopLivekit();
    await startLivekit();
    c.notes.push(`LiveKit de volta em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    c.step_('a chamada continua depois da reconexão');
    for (const e of [sup, op1, op2]) {
      await waitFor(`${e.name} voltar à chamada`, async () => {
        if (await count(e, '.call-end')) throw new Error(`${e.name} viu o fim: ${(await e.page.locator('.call-end').innerText()).replace(/\s+/g, ' ')}`);
        return !(await e.page.locator('.call-banner', { hasText: /Reconectando|Não foi possível reconectar/ }).count()) && (await tiles(e)) === 3;
      }, { timeout: 90000, every: 500 });
    }
    await waitFor('o LiveKit listar as 3 pessoas', async () => (await lkParticipants(callId)).length === 3, { timeout: 60000, every: 1000 });
    for (const e of [sup, op1, op2]) check((await videoFlowing(e)) > 0, `${e.name} não recebe vídeo depois do reinício do LiveKit`);
    const call = await liveCall(rid);
    check(call?._id === callId, `depois do reinício a sala tem a chamada ${call?._id ?? 'nenhuma'}, não ${callId}`);
    for (const e of [sup, op1, op2]) c.notes.push(`${e.name} viu: ${(await seenTexts(e, t0)).map((x) => x.text).join(' | ') || 'nada'}`);
    c.notes.push(`de volta em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await noGhostArrivals([sup, op1, op2], t0);
    await shot(sup, `${S(9)}-continua-sup`);
  });

  // 10. M3: nova versão com a aba aberta.
  await scenario(10, 'Nova versão da web com a aba aberta (M3)', async (c) => {
    const dist = process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : null;
    if (!process.env.REBUILD_CMD && !(dist && fs.existsSync(path.join(dist, 'build.json')))) throw new Skip('defina REBUILD_CMD ou WEB_DIST');
    const rid = await newChannel('versao', [OP1]);
    c.step_('supervisor numa chamada; operador 1 com a aba parada');
    await goRoom(op1, rid);
    await goRoom(sup, rid);
    await startCall(sup, rid);
    const before = await (await fetch(`${CHAT_URL}/build.json`, { cache: 'no-store' })).json();
    let restore = null;
    c.step_('nova versão');
    if (process.env.REBUILD_CMD) {
      const r = await runCmd(process.env.REBUILD_CMD, [], { shell: true, timeout: 600000 });
      fs.writeFileSync(path.join(OUT, `${S(10)}-rebuild.txt`), r.out);
      check(r.code === 0, `REBUILD_CMD saiu com ${r.code}: ${r.out.trim().slice(-300)}`);
    } else {
      const file = path.join(dist, 'build.json');
      const old = fs.readFileSync(file, 'utf8');
      restore = () => fs.writeFileSync(file, old);
      fs.writeFileSync(file, JSON.stringify({ id: `e2e${RUN}` }));
    }
    try {
      const after = await (await fetch(`${CHAT_URL}/build.json`, { cache: 'no-store' })).json();
      c.notes.push(`build.json: ${before.id} → ${after.id}`);
      check(after.id && after.id !== before.id, `o build.json servido não mudou (${before.id})`);
      // A página confere no máximo uma vez a cada 30 s; volta à aba (visibilitychange) depois disso.
      for (const e of [op1, sup]) {
        const wait = 31000 - (Date.now() - e.loadedAt);
        if (wait > 0) await sleep(wait);
      }
      const poke = (e) => e.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      c.step_('a aba parada mostra "Nova versão do chat disponível."');
      await poke(op1);
      await waitFor('o aviso de nova versão no operador', async () => (await op1.page.locator('.call-version').innerText().catch(() => '')).includes('Nova versão do chat disponível.'), { timeout: 15000 });
      check(await count(op1, '.call-version button.call-version-action:has-text("Recarregar")'), 'o aviso não tem o botão Recarregar');
      await shot(op1, `${S(10)}-nova-versao-op1`);
      c.step_('durante a chamada o aviso espera; depois de sair, aparece');
      await poke(sup);
      await sleep(4000);
      check(!(await count(sup, '.call-version')), 'o aviso de nova versão apareceu durante a chamada');
      await leave(sup);
      await tidy(sup);
      await waitFor('o aviso de nova versão no supervisor depois da chamada', () => count(sup, '.call-version'), { timeout: 15000 });
      await shot(sup, `${S(10)}-nova-versao-sup`);
    } finally {
      restore?.();
    }
  });

  // 11. Celular: chamada em tela cheia, controles com rótulo, sem compartilhar tela (claro e escuro).
  await scenario(11, 'Celular: chamada em tela cheia, controles com rótulo, sem compartilhar tela', async (c) => {
    await close('op1');
    await close('op2');
    const rid = await newChannel('celular', [OP1, OP2]);
    const ph1 = await open('op1-cel', OP1, { phone: true });
    const ph2 = await open('op2-cel', OP2, { phone: true, scheme: 'dark' });
    c.cleanup.push(async () => {
      await resetAll();
      await close('op1-cel');
      await close('op2-cel');
    });
    {
      c.step_('supervisor inicia; os operadores entram pelo celular');
      await goRoom(sup, rid);
      await goRoom(ph1, rid);
      await goRoom(ph2, rid);
      const callId = await startCall(sup, rid);
      for (const e of [ph1, ph2]) await joinFromBanner(e, callId);
      for (const e of [ph1, ph2]) await waitFor(`${e.name} ver 3 quadros`, async () => (await tiles(e)) === 3, { timeout: 20000 });
      for (const [e, scheme] of [[ph1, 'claro'], [ph2, 'escuro']]) {
        c.step_(`${e.name}: a chamada cobre a tela`);
        await sleep(1500);
        const box = await e.page.evaluate(() => {
          const el = document.querySelector('.call-window.group');
          const r = el?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight } : null;
        });
        check(box && box.x <= 0.5 && box.y <= 0.5 && box.w >= box.vw - 1 && box.h >= box.vh - 1, `${e.name}: a janela da chamada não cobre a tela (${JSON.stringify(box)})`);
        c.step_(`${e.name}: controles com rótulo e sem compartilhar tela`);
        const labels = (await e.page.locator('.call-window .call-btn-label').allInnerTexts()).map((s) => s.trim());
        for (const l of ['Microfone', 'Câmera', 'Mão', 'Pessoas', 'Mais', 'Sair']) check(labels.includes(l), `${e.name}: falta o rótulo "${l}" nos controles (${labels.join(', ')})`);
        check(!(await count(e, 'button[title="Compartilhar tela"], button[title="Opções de compartilhamento"]')), `${e.name}: há um botão de compartilhar tela no celular`);
        await shot(e, `${S(11)}-celular-${scheme}`);
        await openMore(e);
        const sheet = await e.page.locator('[role="menu"].call-menu').innerText();
        check(!/Compartilhar/.test(sheet), `${e.name}: o menu Mais oferece compartilhar tela no celular`);
        await shot(e, `${S(11)}-celular-${scheme}-mais`);
        await e.page.keyboard.press('Escape');
        await sleep(400);
      }
    }
  });

  results.push({ n: 12, title: '[v1b] Transmissão e chamada a dois pelo servidor de chamadas', status: 'IGNORADO', detail: 'cenário da v1b (§13.7, item 12), fora desta versão' });
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  log(`ERRO: ${err.stack ?? err.message}`);
} finally {
  for (const name of Object.keys(pages)) await close(name);
  await browser?.close().catch(() => {});
  await endAllCalls().catch(() => {});
  await restoreSettings();
  await stopLivekit();
  if (LK.config) fs.rmSync(LK.config, { force: true });
}

console.log('\nResumo');
for (const r of results.sort((a, b) => a.n - b.n)) {
  console.log(`  ${String(r.n).padStart(2)}  ${r.status.padEnd(8)} ${r.title}`);
  if (r.status === 'FALHOU') console.log(`               passo: ${r.step}\n               ${r.detail}`);
  if (r.status === 'IGNORADO') console.log(`               ${r.detail}`);
  for (const n of r.notes ?? []) console.log(`               - ${n}`);
}
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ results, shots }, null, 2));
console.log(`\nCapturas em ${SHOTS}; resultado em ${path.join(OUT, 'resultado.json')}`);
const bad = failed || results.some((r) => r.status === 'FALHOU');
process.exit(bad ? 1 : 0);
