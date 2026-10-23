// Conteúdo de exemplo para as capturas: pessoas, canais, um canal de avisos com "Ciente", DMs, arquivos e um tópico.
// Pode rodar de novo no mesmo banco: só cria o que falta.
//
// Uso:
//   BASE=http://localhost:5201 PLAYWRIGHT_CORE=/caminho/node_modules/playwright-core node scripts/visual/seed.mjs <pasta>
// Grava <pasta>/seed.json com os ids usados por shots.mjs (e os arquivos de exemplo na mesma pasta).
// SITE_NAME=<nome> também grava o nome do workspace (configuração Site_Name).
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, ADMIN_USER, client, executablePath, loadChromium, login, outDir, requireBase } from './lib.mjs';

requireBase();

const out = outDir();
const admin = client(await login(ADMIN_USER, ADMIN_PASSWORD));
const fail = (what, r) => {
  if (r && r.success === false) throw new Error(`${what}: ${r.error}`);
  return r;
};

// As capturas fazem centenas de requisições por minuto: sem isso o limitador da API devolve 429 e o app desloga.
fail('API_Enable_Rate_Limiter', await admin.call('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }));
if (process.env.SITE_NAME) fail('Site_Name', await admin.call('POST', 'settings', { settings: { Site_Name: process.env.SITE_NAME } }));

// Pessoas. A senha é a mesma para todas (qa.visual também é usada pelo script das chamadas).
const PEOPLE = [
  ['qa.visual', 'QA Visual'],
  ['alice.souza', 'Alice Souza'],
  ['bruno.lima', 'Bruno Lima'],
  ['carla.dias', 'Carla Dias'],
];
const PASSWORD = 'qavisual123';
const users = {};
for (const [username, name] of PEOPLE) {
  let d = await login(username, PASSWORD).catch(() => null);
  if (!d) {
    fail(`users.create ${username}`, await admin.call('POST', 'users.create', { username, name, email: `${username}@example.com`, password: PASSWORD, verified: true }));
    d = await login(username, PASSWORD);
  }
  users[username] = client(d);
}
const qa = users['qa.visual'];
const alice = users['alice.souza'];
const bruno = users['bruno.lima'];

const info = await admin.call('GET', 'channels.info', { roomName: 'geral' });
const GERAL = info.channel?._id;
if (!GERAL) throw new Error('canal #geral não encontrado');
for (const u of Object.values(users)) await u.call('POST', 'channels.join', { roomId: GERAL });

// Arquivos de exemplo: um gráfico (PNG) e uma escala (PDF).
const chromium = await loadChromium();
const browser = await chromium.launch({ executablePath });
const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
await p.setContent(`<html><body style="margin:0;font-family:system-ui;background:#0f172a;color:#e2e8f0">
<div style="padding:24px"><div style="font-size:18px;font-weight:600;margin-bottom:16px">Atendimentos por hora — Fila N1</div>
<svg width="592" height="240">${[42, 58, 77, 93, 88, 71, 64, 80, 96, 110, 84, 60].map((v, i) => `<rect x="${i * 49 + 4}" y="${230 - v * 2}" width="36" height="${v * 2}" rx="4" fill="#38bdf8"/>`).join('')}</svg></div></body></html>`);
const png = path.join(out, 'seed-chart.png');
await p.screenshot({ path: png });
await p.setContent('<h1 style="font-family:sans-serif">Escala da operação — novembro</h1><p>Turnos A, B e C.</p>');
const pdf = path.join(out, 'seed-escala.pdf');
await p.pdf({ path: pdf, format: 'A4' });
await browser.close();

const has = async (rid, text, kind = 'channels') => (await admin.call('GET', `${kind}.history`, { roomId: rid, count: 100 })).messages?.some((m) => m.msg?.includes(text));
const send = (u, rid, msg, extra = {}) => u.call('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }).then((r) => fail('chat.sendMessage', r).message);

if (!(await has(GERAL, 'painel de filas'))) {
  const m1 = await send(admin, GERAL, 'Pessoal, o painel de filas da operação foi atualizado. @alice.souza consegue revisar hoje? :rocket:');
  await send(qa, GERAL, '@admin revisei os números da manhã, segue o resumo:\n```\nfila: suporte-n1\nTME: 00:42\nabandono: 3,1%\n```');
  fail('upload png', await admin.upload(GERAL, png, 'atendimentos-por-hora.png', 'image/png', 'Gráfico da fila N1 (hoje)'));
  fail('upload pdf', await admin.upload(GERAL, pdf, 'escala-novembro.pdf', 'application/pdf', 'Escala de novembro'));
  const m5 = await send(qa, GERAL, 'Perfeito, obrigado! *Reunião às 14h* na sala 2. Usem o código `N1-0042` no convite.');
  await admin.call('POST', 'chat.react', { messageId: m1._id, emoji: ':eyes:' });
  await qa.call('POST', 'chat.react', { messageId: m1._id, emoji: ':+1:' });
  await admin.call('POST', 'chat.react', { messageId: m5._id, emoji: ':tada:' });
  // Um tópico na mensagem do QA.
  await send(admin, GERAL, 'Confirmado, levo o notebook.', { tmid: m5._id });
  await send(alice, GERAL, 'Ótimo 👍', { tmid: m5._id });
}

// Mais salas para a barra lateral: um canal público, um grupo privado e um time.
async function ensureRoom(kind, name, members, extraData = {}) {
  const prefix = kind === 'p' ? 'groups' : 'channels';
  const found = await admin.call('GET', `${prefix}.info`, { roomName: name });
  const room = found.channel ?? found.group;
  if (room) return room._id;
  const r = fail(`${prefix}.create ${name}`, await admin.call('POST', `${prefix}.create`, { name, members, extraData }));
  return (r.channel ?? r.group)._id;
}
const OPERACAO = await ensureRoom('c', 'operacao-n1', ['bruno.lima', 'qa.visual'], { topic: 'Fila N1: escalas, pausas e incidentes' });
if (!(await has(OPERACAO, 'pausa'))) {
  await send(bruno, OPERACAO, 'Bom dia! A pausa das 10h foi para as 10h15 hoje.');
  await send(qa, OPERACAO, 'Anotado. Vou avisar o turno B.');
}
const SUPERVISORES = await ensureRoom('p', 'supervisores', ['carla.dias']);
if (!(await has(SUPERVISORES, 'indicadores', 'groups'))) await send(admin, SUPERVISORES, 'Reunião de indicadores na quinta, 9h.');
const teams = await admin.call('GET', 'teams.list');
if (!teams.teams?.some((t) => t.name === 'qualidade')) fail('teams.create', await admin.call('POST', 'teams.create', { name: 'qualidade', type: 0, members: ['alice.souza', 'carla.dias'] }));

// Canal de avisos: só quem publica escreve; os outros confirmam a leitura com "Ciente".
const AVISOS = await ensureRoom('c', 'avisos', PEOPLE.map(([u]) => u), { notice: true, noticeAck: true, topic: 'Comunicados da gestão' });
if (!(await has(AVISOS, 'URA'))) {
  await send(admin, AVISOS, 'Lembrete: atualização da URA hoje às 22h. Pode haver instabilidade por até 15 minutos.');
  const ack = await send(admin, AVISOS, '**Novo roteiro de retenção a partir de 24/10**\n@all a partir de sexta, as ofertas de retenção seguem o roteiro v3:\n- desconto só após a 2ª objeção;\n- motivo obrigatório no CRM;\n- mudança de endereço vai para o N2.', { ackRequired: true });
  await users['bruno.lima'].call('POST', 'chat.ack', { messageId: ack._id });
}

// DMs com o admin.
const dm = fail('im.create', await admin.call('POST', 'im.create', { username: 'qa.visual' }));
const dmid = dm.room._id;
if (!(await has(dmid, 'escala', 'im'))) {
  await send(qa, dmid, 'Oi! Você pode me ligar para alinharmos a escala?');
  await send(admin, dmid, 'Claro, te ligo em 5 minutos.');
}
const dm2 = fail('im.create', await admin.call('POST', 'im.create', { username: 'alice.souza' }));
if (!(await has(dm2.room._id, 'relatório', 'im'))) await send(alice, dm2.room._id, 'Mandei o relatório de qualidade por e-mail.');

const seed = { GERAL, dmid, OPERACAO, SUPERVISORES, AVISOS, password: PASSWORD };
fs.writeFileSync(path.join(out, 'seed.json'), JSON.stringify(seed, null, 2));
console.log('ok', seed);
