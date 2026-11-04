import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemText } from '@shared/messageText';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { admin, api, newUser, raw, startServer, stopServer, urlOf, type Auth } from './helpers';
import { unzip } from './zip-read';

// Exportar mensagens (rooms.export): permissão, período, formatos, .zip com arquivos, tíquete de uso único, auditoria
// e mensagens criptografadas.

let A: Auth;
let ana: Auth;
let bruno: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Site_Url: 'https://chat.empresa.com.br' } }, A);
  [ana, bruno] = await Promise.all([newUser(A, { name: 'Ana Souza' }), newUser(A, { name: 'Bruno Lima' })]);
});
afterAll(() => stopServer());

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const send = async (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => {
  const r = await api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.message;
};
const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString();
// Período padrão: os últimos 30 dias até daqui a um minuto.
const recent = () => ({ dateFrom: iso(Date.now() - 30 * DAY), dateTo: iso(Date.now() + 60_000) });
const info = (auth: Auth, rid: string, extra: Record<string, unknown> = {}) => api('GET', 'rooms.export.info', { rid, ...recent(), ...extra }, auth);
// As exportações de outros testes não contam no limite de 3 por minuto (o teste do limite cuida dele).
const freeLimiter = () => pool.query(`UPDATE data_exports SET created_at = created_at - interval '2 minutes' WHERE kind = 'room' AND created_at > now() - interval '1 minute'`);
async function ticket(auth: Auth, rid: string, extra: Record<string, unknown> = {}) {
  await freeLimiter();
  return api('POST', 'rooms.export', { rid, format: 'html', ...recent(), ...extra }, auth);
}
async function download(auth: Auth, rid: string, extra: Record<string, unknown> = {}) {
  const t = await ticket(auth, rid, extra);
  if (!t.success) throw new Error(JSON.stringify(t));
  const res = await raw(t.url, auth);
  expect(res.status).toBe(200);
  return { res, body: Buffer.from(await res.arrayBuffer()), ticket: t };
}
const text = async (auth: Auth, rid: string, extra: Record<string, unknown> = {}) => (await download(auth, rid, extra)).body.toString('utf8');
async function channel(owner: Auth, members: Auth[] = [], extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'channels.create', { name: name('exp'), members: members.map((m) => m.username), ...extra }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.channel._id as string;
}
// Tira do período as mensagens de sistema da criação da sala.
const clearSystem = (rid: string) => pool.query(`UPDATE messages SET created_at = now() - interval '300 days' WHERE room_id = $1 AND t IS NOT NULL`, [rid]);
const at = (id: string, ms: number) => pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [id, iso(ms)]);

async function upload(auth: Auth, rid: string, fileName: string, bytes: Buffer | string, type = 'text/plain') {
  const fd = new FormData();
  fd.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), fileName);
  const r = await api('POST', `rooms.upload/${rid}`, fd, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.message;
}

describe('exportar mensagens', () => {
  it('só quem tem a permissão exporta: dono sim, membro não', async () => {
    const rid = await channel(ana, [bruno]);
    await send(ana, rid, 'primeira mensagem');
    for (const r of [await info(bruno, rid), await ticket(bruno, rid)]) {
      expect(r.status).toBe(403);
      expect(r.error).toBe('Você não pode exportar as mensagens desta sala.');
    }
    const ok = await ticket(ana, rid);
    expect(ok.status).toBe(200);
    expect(ok.url).toMatch(/^\/api\/v1\/rooms\.export\.download\?ticket=[\w-]+$/);
    expect(ok.fileName).toMatch(/^exp-[a-z0-9-]+_\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('sem acesso à sala não exporta, nem o admin', async () => {
    const g = (await api('POST', 'groups.create', { name: name('privado') }, ana)).group;
    await send(ana, g._id, 'segredo do grupo');
    const r = await info(A, g._id);
    expect(r.status).toBe(403);
    expect(r.error).toBe('Você não tem acesso a esta sala.');
    // DM: ninguém é dono; só quem tem a permissão por um papel global (o admin) e participa.
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room;
    await send(ana, dm._id, 'oi bruno');
    expect((await ticket(ana, dm._id)).error).toBe('Você não pode exportar as mensagens desta sala.');
    const dmAdmin = (await api('POST', 'im.create', { username: ana.username }, A)).room;
    await send(A, dmAdmin._id, 'oi ana');
    const t = await ticket(A, dmAdmin._id);
    expect(t.status).toBe(200);
    expect(t.fileName).toMatch(/^conversa-com-ana-souza_/);
  });

  it('período e tópicos', async () => {
    const rid = await channel(ana);
    const now = Date.now();
    const before = await send(ana, rid, 'antes do período');
    const in1 = await send(ana, rid, 'dentro um');
    const in2 = await send(ana, rid, '<script>alert(1)</script>');
    const after = await send(ana, rid, 'depois do período');
    const reply = await send(ana, rid, 'resposta no tópico', { tmid: in1._id });
    await clearSystem(rid);
    await at(before._id, now - 20 * DAY);
    await at(in1._id, now - 5 * DAY);
    await at(in2._id, now - 4 * DAY);
    await at(reply._id, now - 3 * DAY);
    await at(after._id, now + 5 * DAY);
    const period = { dateFrom: iso(now - 10 * DAY), dateTo: iso(now + DAY) };
    const html = await text(ana, rid, period);
    expect(html.match(/<article /g)).toHaveLength(3);
    expect(html).toContain('dentro um');
    expect(html).toContain('resposta no tópico');
    expect(html).not.toContain('antes do período');
    expect(html).not.toContain('depois do período');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    expect(html).toContain(`<a class="reply" href="#m-${in1._id}">↳ Resposta no tópico</a>`);
    expect(html).toMatch(/<h2>[a-zç-]+-feira, \d{1,2} de [a-zç]+ de \d{4}<\/h2>|<h2>(sábado|domingo), \d{1,2} de [a-zç]+ de \d{4}<\/h2>/);
    expect(html).toContain('3 mensagens exportadas.');
    const noThreads = await text(ana, rid, { ...period, includeThreads: false });
    expect(noThreads).not.toContain('resposta no tópico');
    expect(noThreads.match(/<article /g)).toHaveLength(2);
    // A informação do painel conta o mesmo.
    expect((await api('GET', 'rooms.export.info', { rid, ...period }, ana)).messages).toBe(3);
    expect((await api('GET', 'rooms.export.info', { rid, ...period, includeThreads: 'false' }, ana)).messages).toBe(2);
  });

  it('CSV com ; , BOM e proteção contra fórmulas', async () => {
    const rid = await channel(ana);
    await clearSystem(rid);
    for (const m of ['=SOMA(A1)', 'a;b', 'diz "oi"', 'linha 1\nlinha 2', 'ação com acento']) await send(ana, rid, m);
    const { res, body } = await download(ana, rid, { format: 'csv' });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="exp-[^"]+\.csv"; filename\*=UTF-8''exp-/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(body.toString('utf8')).toContain('\r\n');
    const rows = parse(body, { delimiter: ';', bom: true }) as string[][];
    expect(rows[0]).toEqual(['Data e hora', 'Autor', 'Usuário', 'Tipo', 'Mensagem', 'Resposta ao tópico', 'Editada em', 'Arquivos', 'Reações', 'Cientes', 'Fixada', 'ID da mensagem']);
    expect(rows.slice(1).map((r) => r[4])).toEqual(["'=SOMA(A1)", 'a;b', 'diz "oi"', 'linha 1\nlinha 2', 'ação com acento']);
    expect(rows[1].slice(1, 4)).toEqual(['Ana Souza', ana.username, 'mensagem']);
    expect(rows[1][0]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  it('JSON válido e completo', async () => {
    const carla = await newUser(A, { name: 'Carla <b>Dias</b>' });
    const rid = await channel(ana, [bruno, carla]);
    await clearSystem(rid);
    const m1 = await send(ana, rid, 'bom dia');
    await api('POST', 'chat.react', { messageId: m1._id, emoji: ':tada:' }, bruno);
    await api('POST', 'chat.react', { messageId: m1._id, emoji: ':tada:' }, carla);
    await send(carla, rid, 'mensagem da carla');
    await api('POST', 'chat.pinMessage', { messageId: m1._id }, ana);
    await clearSystem(rid);
    // Conta excluída: o nome continua, marcado.
    expect((await api('POST', 'users.delete', { userId: carla.userId }, A)).success).toBe(true);
    const { res, body } = await download(ana, rid, { format: 'json' });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const doc = JSON.parse(body.toString('utf8'));
    expect(doc).toMatchObject({ format: 'wescc-room-export', version: 1, exportedBy: { id: ana.userId, username: ana.username } });
    expect(doc.messages.length).toBe((await info(ana, rid)).messages);
    const ts = doc.messages.map((m: any) => m.ts);
    expect([...ts].sort()).toEqual(ts);
    const bomDia = doc.messages.find((m: any) => m.id === m1._id);
    // A reação da conta excluída sai com ela (um @usuário reaproveitado não a herda).
    expect(bomDia).toMatchObject({ msg: 'bom dia', text: 'bom dia', pinned: true, reactions: { ':tada:': [bruno.username] }, u: { id: ana.userId } });
    const gone = doc.messages.find((m: any) => m.msg === 'mensagem da carla');
    expect(gone.u).toMatchObject({ id: null, name: 'Carla <b>Dias</b>', deleted: true });
    const html = await text(ana, rid);
    expect(html).toContain('<b>Carla &#60;b&#62;Dias&#60;/b&#62;</b>');
    expect(html).toContain('(conta excluída)');
    // Reações como no chat: o emoji, e o nome de quem reagiu ao passar o mouse.
    expect(html).toContain('<span title="Bruno Lima reagiu com :tada:">🎉 1</span>');
    const csv = parse(await text(ana, rid, { format: 'csv' }), { delimiter: ';', bom: true }) as string[][];
    expect(csv.find((r) => r[11] === m1._id)?.[8]).toBe('🎉 1');

    // Canal de avisos com "Ciente".
    const notice = (await api('POST', 'channels.create', { name: name('avisos'), members: [bruno.username], extraData: { notice: true, noticeAck: true } }, ana)).channel;
    const aviso = await send(ana, notice._id, 'Escala de sábado', { ackRequired: true });
    await api('POST', 'chat.ack', { messageId: aviso._id }, bruno);
    const nd = JSON.parse(await text(ana, notice._id, { format: 'json' }));
    expect(nd.messages.find((m: any) => m.id === aviso._id)).toMatchObject({ ackRequired: true, ackCount: 1 });
    expect(nd.room).toMatchObject({ kind: 'Canal de avisos' });
  });

  it('mensagens do sistema com texto legível', async () => {
    const rid = await channel(ana);
    await clearSystem(rid);
    await api('POST', 'channels.invite', { roomId: rid, userId: bruno.userId }, ana);
    await api('POST', 'channels.setTopic', { roomId: rid, topic: 'Planejamento' }, ana);
    const html = await text(ana, rid);
    expect(html).toContain('Ana Souza adicionou Bruno Lima');
    expect(html).toContain('Ana Souza alterou o tópico para: Planejamento');
    expect(html).toContain('<p class="meta">Tópico: Planejamento</p>');
    // O mesmo texto da web (shared/messageText.ts).
    const added = (await api('GET', 'channels.history', { roomId: rid }, ana)).messages.find((m: any) => m.t === 'au');
    expect(html).toContain(systemText(added, (u) => (u === bruno.username ? 'Bruno Lima' : u)));
    expect(html).toContain('class="msg sys"');
  });

  it('zip com arquivos: bytes iguais e arquivo sumido marcado', async () => {
    const rid = await channel(ana);
    await clearSystem(rid);
    const photo = Buffer.from('PNG-de-mentira-'.repeat(200));
    const kept = await upload(ana, rid, 'foto ação.png', photo, 'image/png');
    const lost = await upload(ana, rid, 'perdido.txt', 'vai sumir');
    const f = (await pool.query('SELECT storage_path FROM files WHERE id = $1', [lost.files[0]._id])).rows[0];
    await fs.promises.rm(path.join(config.uploadDir, f.storage_path));
    const info2 = await info(ana, rid, { includeFiles: 'true' });
    expect(info2).toMatchObject({ messages: 2, files: 2, tooLarge: false });
    const { res, body, ticket: t } = await download(ana, rid, { includeFiles: true });
    expect(t.fileName).toMatch(/\.zip$/);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const entries = await unzip(body);
    const keptId = kept.files[0]._id;
    expect(entries.map((e) => e.name)).toEqual([`arquivos/${keptId}-foto ação.png`, 'mensagens.html']);
    expect(entries[0].data.equals(photo)).toBe(true);
    const html = entries[1].data.toString('utf8');
    expect(html).toContain(`href="arquivos/${keptId}-foto%20a%C3%A7%C3%A3o.png"`);
    expect(html).toContain('perdido.txt');
    expect(html).toContain('Arquivo indisponível');
    // Sem arquivos: o link do chat.
    const plain = await text(ana, rid);
    expect(plain).toContain(`https://chat.empresa.com.br/file-upload/${keptId}/foto%20a%C3%A7%C3%A3o.png`);
  });

  it('limite de tamanho dos arquivos', async () => {
    const rid = await channel(ana);
    await upload(ana, rid, 'grande.bin', Buffer.alloc(2 * 1024 * 1024, 7), 'application/octet-stream');
    await api('POST', 'settings', { settings: { DataExport_Max_Files_MB: 1 } }, A);
    try {
      const i = await info(ana, rid, { includeFiles: 'true' });
      expect(i).toMatchObject({ tooLarge: true, maxFilesSize: 1024 * 1024, files: 1 });
      expect((await info(ana, rid)).tooLarge).toBe(false);
      const r = await ticket(ana, rid, { includeFiles: true });
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-export-too-large');
      expect(r.error).toBe('Os arquivos do período somam 2 MB e o limite é 1 MB. Escolha um período menor ou exporte sem os arquivos.');
      expect(r.details).toEqual({ filesSize: 2 * 1024 * 1024, maxFilesSize: 1024 * 1024 });
      expect((await ticket(ana, rid)).status).toBe(200);
    } finally {
      await api('POST', 'settings', { settings: { DataExport_Max_Files_MB: 2048 } }, A);
    }
  });

  it('tíquete de uso único, do mesmo usuário, com prazo', async () => {
    const rid = await channel(ana, [bruno]);
    await send(ana, rid, 'conteúdo');
    const t = await ticket(ana, rid);
    const other = await raw(t.url, bruno);
    expect(other.status).toBe(404);
    expect((await other.json()).errorType).toBe('error-export-expired');
    const anon = await fetch(urlOf(t.url));
    expect(anon.status).toBe(401);
    expect((await raw(t.url, ana)).status).toBe(200);
    const again = await raw(t.url, ana);
    expect(again.status).toBe(404);
    expect((await again.json()).error).toBe('Este link de download expirou. Peça a exportação de novo.');
    const t2 = await ticket(ana, rid);
    await pool.query(`UPDATE data_exports SET expires_at = now() - interval '1 second' WHERE kind = 'room' AND downloaded_at IS NULL`);
    expect((await raw(t2.url, ana)).status).toBe(404);
    // O tíquete vale por 2 minutos.
    const t3 = await ticket(ana, rid);
    expect(new Date(t3.expiresAt).getTime() - Date.now()).toBeGreaterThan(100_000);
    expect(new Date(t3.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(121_000);
    // Quem perdeu a permissão entre o pedido e o download não baixa.
    await api('POST', 'channels.removeOwner', { roomId: rid, userId: ana.userId }, A);
    await api('POST', 'channels.addOwner', { roomId: rid, userId: bruno.userId }, A);
    await api('POST', 'channels.removeOwner', { roomId: rid, userId: ana.userId }, bruno);
    const lostPerm = await raw(t3.url, ana);
    expect(lostPerm.status).toBe(403);
  });

  it('auditoria', async () => {
    const rid = await channel(ana);
    await send(ana, rid, 'para auditar');
    const p = recent();
    const { ticket: t } = await download(ana, rid, { ...p, format: 'csv', includeFiles: false });
    const row = (await pool.query(`SELECT * FROM audit_log WHERE action = 'room.messages.exported' AND target->>'rid' = $1`, [rid])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ actor_id: ana.userId, actor_username: ana.username });
    expect(row[0].target).toMatchObject({ rid, t: 'c' });
    expect(row[0].data).toMatchObject({ format: 'csv', from: p.dateFrom, to: p.dateTo, files: false, threads: true });
    expect(row[0].data.messages).toBeGreaterThan(0);
    expect(t.url).toBeTruthy();
    // O POST sozinho não registra nada: só o download.
    await ticket(ana, rid);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'room.messages.exported' AND target->>'rid' = $1`, [rid])).rows[0].n).toBe(1);
  });

  it('criptografadas saem como marcador', async () => {
    // Contrato da criptografia ponta a ponta: msg vazio e o conteúdo cifrado em messages.e2e. O arquivo sobe antes de
    // a sala virar criptografada (depois, só cifrado) e a linha ganha o conteúdo cifrado direto no banco.
    const g = (await api('POST', 'groups.create', { name: name('cifrado') }, ana)).group;
    await send(ana, g._id, 'mensagem antes da criptografia');
    expect((await info(ana, g._id)).encrypted).toBe(false);
    const up = await upload(ana, g._id, 'segredo.bin', 'CIFRADO-ARQUIVO');
    await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [g._id]);
    await pool.query(`UPDATE messages SET msg = '', attachments = '[]', e2e = '{"v":1,"kid":"AAAAAAAAAAAAAAAA","iv":"AAAAAAAAAAAAAAAA","ct":"CIFRADO-XYZ","by":"x"}' WHERE id = $1`, [up._id]);
    expect((await info(ana, g._id)).encrypted).toBe(true);
    expect((await info(ana, g._id, { includeFiles: 'true' })).files).toBe(0);
    const html = await text(ana, g._id);
    const csv = await text(ana, g._id, { format: 'csv' });
    const json = await text(ana, g._id, { format: 'json' });
    for (const out of [html, csv, json]) expect(out).not.toContain('CIFRADO');
    expect(html).toContain('Mensagem criptografada');
    expect(html).toContain('Arquivo criptografado');
    expect(html).toContain('mensagem antes da criptografia');
    expect(csv).toContain(';criptografada;Mensagem criptografada;');
    const doc = JSON.parse(json);
    expect(doc.messages.find((m: any) => m.id === up._id)).toMatchObject({ encrypted: true, msg: null, text: 'Mensagem criptografada', attachments: [] });
    const zip = await unzip((await download(ana, g._id, { includeFiles: true })).body);
    expect(zip.map((e) => e.name)).toEqual(['mensagens.html']);
    expect(zip[0].data.toString()).not.toContain('CIFRADO');
  });

  it('sala grande: páginas sem repetir nem pular', async () => {
    const rid = await channel(ana);
    await pool.query('DELETE FROM messages WHERE room_id = $1', [rid]);
    // 1.200 com o mesmo instante (o desempate é pelo id) e 1.800 a cada 7 microssegundos: várias no mesmo milissegundo,
    // que o cursor não pode perder nem repetir.
    await pool.query(
      `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, created_at)
       SELECT 'g' || substr(md5(g::text), 1, 16), $1, $2, $3, 'Ana Souza', 'igual ' || g, timestamptz '2026-10-15 12:00:00.123456+00'
         FROM generate_series(1, 1200) g`,
      [rid, ana.userId, ana.username],
    );
    await pool.query(
      `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, created_at)
       SELECT 'h' || substr(md5(g::text), 1, 16), $1, $2, $3, 'Ana Souza', 'espalhada ' || g, timestamptz '2026-10-15 11:59:59.990000+00' + g * 7 * interval '1 microsecond'
         FROM generate_series(1, 1800) g`,
      [rid, ana.userId, ana.username],
    );
    const p = { dateFrom: '2026-10-15T00:00:00.000Z', dateTo: '2026-10-15T23:59:59.999Z' };
    const doc = JSON.parse(await text(ana, rid, { ...p, format: 'json' }));
    const ids = doc.messages.map((m: any) => m.id);
    expect(ids).toHaveLength(3000);
    expect(new Set(ids).size).toBe(3000);
    const expected = (await pool.query('SELECT id FROM messages WHERE room_id = $1 ORDER BY created_at, id', [rid])).rows.map((r) => r.id);
    expect(ids).toEqual(expected);
  });

  it('canal de avisos e somente leitura: exporta e não publica nada', async () => {
    const notice = (await api('POST', 'channels.create', { name: name('avisos'), members: [bruno.username], extraData: { notice: true } }, ana)).channel;
    await send(ana, notice._id, 'aviso importante');
    const before = (await pool.query('SELECT msgs, last_message, lm FROM rooms WHERE id = $1', [notice._id])).rows[0];
    const count = (await pool.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [notice._id])).rows[0].n;
    expect(await text(ana, notice._id)).toContain('aviso importante');
    expect((await pool.query('SELECT msgs, last_message, lm FROM rooms WHERE id = $1', [notice._id])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [notice._id])).rows[0].n).toBe(count);
    // Quem só lê o canal de avisos não exporta.
    expect((await info(bruno, notice._id)).status).toBe(403);
  });

  it('validação', async () => {
    const rid = await channel(ana);
    await send(ana, rid, 'algo');
    const bad = async (body: Record<string, unknown>) => {
      await freeLimiter();
      return api('POST', 'rooms.export', { rid, format: 'html', ...recent(), ...body }, ana);
    };
    expect((await bad({ dateFrom: iso(Date.now()), dateTo: iso(Date.now() - DAY) })).errorType).toBe('error-invalid-period');
    expect((await bad({ format: 'pdf' })).errorType).toBe('error-invalid-format');
    const email = await bad({ type: 'email' });
    expect(email.status).toBe(400);
    expect(email.error).toBe('Só a exportação para arquivo está disponível.');
    expect((await bad({ dateFrom: 'ontem' })).errorType).toBe('error-invalid-date');
    expect((await bad({ format: undefined })).error).toBe('O parâmetro "format" é obrigatório.');
    const empty = await bad({ dateFrom: iso(Date.now() - 400 * DAY), dateTo: iso(Date.now() - 399 * DAY) });
    expect(empty.errorType).toBe('error-export-empty');
    expect(empty.error).toBe('Não há mensagens nesse período.');
    expect((await bad({ rid: 'nao-existe' })).status).toBe(404);
  });

  it('limite por minuto', async () => {
    const rid = await channel(ana);
    await send(ana, rid, 'algo');
    await freeLimiter();
    const post = () => api('POST', 'rooms.export', { rid, format: 'html', ...recent() }, ana);
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(200);
    const r = await post();
    expect(r.status).toBe(429);
    expect(r.error).toBe('Aguarde um minuto antes de exportar de novo.');
    // A tela segura o botão até a mais antiga sair do último minuto.
    const retryAt = Date.parse(r.details.retryAt);
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 60_000);
    await freeLimiter();
  });

  it('pendência de senha bloqueia o download', async () => {
    const rid = await channel(ana);
    await send(ana, rid, 'algo');
    const t = await ticket(ana, rid);
    await pool.query('UPDATE users SET require_password_change = true WHERE id = $1', [ana.userId]);
    try {
      const r = await raw(t.url, ana);
      expect(r.status).toBe(403);
      expect((await r.json()).errorType).toBe('error-password-change-required');
    } finally {
      await pool.query('UPDATE users SET require_password_change = false WHERE id = $1', [ana.userId]);
    }
  });
});
