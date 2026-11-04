import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { runDataExportJobs } from '../src/services/userData';
import { admin, api, connectWs, enable2fa, login, newUser, raw, startServer, stopServer, type Auth } from './helpers';
import { unzip } from './zip-read';

// Meus dados (LGPD): pedido, tarefa em segundo plano, aviso, conteúdo do .zip, regra das 24 horas, prazo e limpeza.

const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string; html?: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => (outbox.push(m), true),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false, Site_Url: 'https://chat.empresa.com.br' } }, A);
});
afterAll(() => stopServer());
beforeEach(() => {
  outbox.length = 0;
});

const H = 3600_000;
const exportsDir = () => path.join(config.uploadDir, 'exports');
const ask = (auth: Auth) => api('POST', 'users.requestDataDownload', {}, auth);
const list = (auth: Auth) => api('GET', 'users.dataDownloads.list', {}, auth);
const fileUrl = (id: string) => `/api/v1/users.dataDownloads.file?id=${encodeURIComponent(id)}`;
const setSettings = (settings: Record<string, unknown>) => api('POST', 'settings', { settings }, A);
const row = async (id: string) => (await pool.query('SELECT * FROM data_exports WHERE id = $1', [id])).rows[0];

async function readyZip(auth: Auth) {
  const r = await ask(auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  await runDataExportJobs();
  const res = await raw(fileUrl(r.request._id), auth);
  expect(res.status).toBe(200);
  const entries = await unzip(Buffer.from(await res.arrayBuffer()));
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const json = (name: string) => JSON.parse(byName.get(name)!.toString('utf8'));
  return { id: r.request._id as string, res, entries, byName, json };
}

async function upload(auth: Auth, rid: string, fileName: string, bytes: Buffer | string, type = 'text/plain') {
  const fd = new FormData();
  fd.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), fileName);
  const r = await api('POST', `rooms.upload/${rid}`, fd, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.message;
}

describe('meus dados', () => {
  it('pede, gera e avisa', async () => {
    const ana = await newUser(A, { name: 'Ana Souza' });
    const ws = connectWs(ana);
    await ws.ready;
    try {
      const r = await ask(ana);
      expect(r.request).toMatchObject({ status: 'pending' });
      await ws.waitFor((e) => e.type === 'userdata.changed' && e.request.status === 'pending');
      expect(await runDataExportJobs()).toMatchObject({ done: 1, failed: 0 });
      const ev = await ws.waitFor((e) => e.type === 'userdata.changed' && e.request.status === 'ready');
      expect(ev.request._id).toBe(r.request._id);
      expect(ev.request.size).toBeGreaterThan(0);
      const mail = outbox.find((m) => m.to === `${ana.username}@test.local`);
      expect(mail?.subject).toContain('Seus dados estão prontos');
      expect(mail?.text).toContain('https://chat.empresa.com.br/account/data');
      expect(mail?.text).toContain('Minha conta › Meus dados até');
      expect(mail?.html).toContain('Abrir Meus dados');
      const l = await list(ana);
      expect(l).toMatchObject({ enabled: true, expirationHours: 72 });
      expect(l.requests).toHaveLength(1);
      expect(l.requests[0]).toMatchObject({ _id: r.request._id, status: 'ready' });
      expect(Math.abs(new Date(l.requests[0].expiresAt).getTime() - (Date.now() + 72 * H))).toBeLessThan(2 * 60_000);
      expect(new Date(l.nextAllowedAt).getTime()).toBe(new Date(r.request.requestedAt).getTime() + 24 * H);
      // O arquivo fica em UPLOAD_DIR/exports, sem o .part.
      expect(fs.existsSync(path.join(exportsDir(), `${r.request._id}.zip`))).toBe(true);
      expect(fs.existsSync(path.join(exportsDir(), `${r.request._id}.zip.part`))).toBe(false);
    } finally {
      ws.close();
    }
  });

  it('o zip tem os dados da pessoa e nada dos outros', async () => {
    const ana = await newUser(A, { name: 'Ana Souza' });
    const bruno = await newUser(A, { name: 'Bruno Lima' });
    const secret = await enable2fa(ana);
    const lgpd = (await api('POST', 'channels.create', { name: 'lgpd', members: [bruno.username] }, ana)).channel._id;
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
    const send = async (auth: Auth, rid: string, msg: string) => (await api('POST', 'chat.sendMessage', { message: { rid, msg } }, auth)).message;
    await send(ana, lgpd, 'oi do canal');
    await send(bruno, lgpd, 'bruno escreve no canal');
    await send(ana, dm, 'oi bruno');
    const hisMsg = await send(bruno, dm, 'SEGREDO-DO-BRUNO');
    await api('POST', 'chat.react', { messageId: hisMsg._id, emoji: 'tada' }, ana);
    const up = await upload(ana, lgpd, 'relatório.txt', 'conteúdo do relatório');
    const at = (h: number) => new Date(Date.now() + h * H).toISOString();
    const mine = await api('POST', 'calendar.create', { title: 'Reunião da Ana', startsAt: at(24), endsAt: at(25) }, ana);
    expect(mine.success).toBe(true);
    const his = await api('POST', 'calendar.create', { title: 'Evento do Bruno', startsAt: at(48), endsAt: at(49), attendeeIds: [ana.userId] }, bruno);
    expect((await api('POST', 'calendar.respond', { eventId: his.event._id, response: 'accepted' }, ana)).success).toBe(true);

    const { res, entries, byName, json } = await readyZip(ana);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/meus-dados_user\d+[a-z0-9]*_\d{4}-\d{2}-\d{2}\.zip/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const fileEntry = entries.find((e) => e.name.startsWith('arquivos/'))!;
    expect(entries.map((e) => e.name)).toEqual(['perfil.json', 'agenda.json', 'lembretes.json', 'agendadas.json', 'votos.json', 'reacoes.json', fileEntry.name, 'arquivos.json', 'mensagens.json', 'meus-dados.html']);

    const perfil = json('perfil.json');
    expect(perfil).toMatchObject({ format: 'wescc-user-data', version: 1 });
    expect(perfil.perfil).toMatchObject({ id: ana.userId, username: ana.username, name: 'Ana Souza', email: `${ana.username}@test.local`, doisFatores: true });
    expect(perfil.salas.map((s: any) => s.nome)).toEqual(expect.arrayContaining(['lgpd', 'Conversa com Bruno Lima']));
    expect(perfil.sessoes.length).toBeGreaterThan(0);
    expect(perfil.dispositivos.length).toBeGreaterThan(0);

    const msgs = json('mensagens.json');
    expect(msgs.map((m: any) => m.texto)).toEqual(['oi do canal', 'oi bruno', expect.stringContaining('relatório.txt')]);
    expect(msgs.map((m: any) => m.sala.nome)).toEqual(['lgpd', 'Conversa com Bruno Lima', 'lgpd']);
    expect(msgs[2].arquivos).toEqual([up.files[0]._id]);

    expect(json('reacoes.json')).toEqual([{ mensagemId: hisMsg._id, sala: 'Conversa com Bruno Lima', dataMensagem: expect.any(String), emoji: ':tada:' }]);

    expect(fileEntry.name).toBe(`arquivos/${up.files[0]._id}-relatório.txt`);
    expect(fileEntry.data.toString('utf8')).toBe('conteúdo do relatório');
    expect(json('arquivos.json')).toEqual([expect.objectContaining({ id: up.files[0]._id, nome: 'relatório.txt', sala: 'lgpd', incluido: true, caminho: fileEntry.name })]);

    const agenda = json('agenda.json');
    expect(agenda.eventos).toEqual([expect.objectContaining({ titulo: 'Reunião da Ana', status: 'confirmed' })]);
    expect(agenda.convites).toEqual([expect.objectContaining({ titulo: 'Evento do Bruno', organizador: 'Bruno Lima', resposta: 'accepted' })]);

    const html = byName.get('meus-dados.html')!.toString('utf8');
    expect(html).toContain('<h1>Meus dados</h1>');
    expect(html).toContain('oi bruno');
    expect(html).toContain(`href="arquivos/${up.files[0]._id}-relat%C3%B3rio.txt"`);
    // Reação como no chat (🎉), não o shortcode; os papéis pelo nome.
    expect(html).toContain('🎉 1');
    expect(html).not.toContain('>:tada: 1');
    expect(html).toContain('<dt>Papéis</dt><dd>Usuário</dd>');
    expect(html).toContain('Convite aceito · Bruno Lima');
    expect(html).toContain('Para corrigir ou excluir dados, fale com o administrador do');

    // Nada de outras pessoas e nenhum segredo da conta.
    const u = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [ana.userId])).rows[0];
    const all = entries.map((e) => e.data.toString('utf8')).join('\n');
    for (const bad of ['SEGREDO-DO-BRUNO', 'bruno escreve no canal', u.password_hash, secret, ana.authToken, 'password_hash', 'totp_secret', 'backup_codes', 'token_hash', 'device_hash']) {
      expect(all).not.toContain(bad);
    }
  });

  it('o perfil traz o status personalizado escolhido', async () => {
    const ana = await newUser(A);
    expect((await api('POST', 'users.setStatus', { statusId: 'status-em-atendimento', message: 'fila 2' }, ana)).success).toBe(true);
    const { json, byName } = await readyZip(ana);
    expect(json('perfil.json').perfil).toMatchObject({ statusText: 'fila 2', statusPersonalizado: { id: 'status-em-atendimento', nome: 'Em atendimento', tipo: 'busy' } });
    expect(byName.get('meus-dados.html')!.toString('utf8')).toContain('Em atendimento · fila 2');
    // Sem personalizado, null.
    const bia = await newUser(A);
    expect((await readyZip(bia)).json('perfil.json').perfil.statusPersonalizado).toBeNull();
  });

  it('um pedido a cada 24 horas; falha não conta', async () => {
    const carla = await newUser(A);
    const first = (await ask(carla)).request;
    await runDataExportJobs();
    const again = await ask(carla);
    expect(again.status).toBe(429);
    expect(again.errorType).toBe('error-data-download-rate-limit');
    expect(again.error).toMatch(/^Você já pediu seus dados nas últimas 24 horas\. Peça de novo a partir de \d{2}\/\d{2} às \d{2}:\d{2}\.$/);
    expect(new Date(again.details.nextAllowedAt).getTime()).toBe(new Date(first.requestedAt).getTime() + 24 * H);
    // O que falhou não conta.
    await pool.query(`UPDATE data_exports SET status = 'failed', error = 'teste' WHERE id = $1`, [first._id]);
    const second = await ask(carla);
    expect(second.success).toBe(true);
    await runDataExportJobs();
    expect((await ask(carla)).status).toBe(429);
    // 25 horas depois, pode de novo.
    await pool.query(`UPDATE data_exports SET created_at = created_at - interval '25 hours' WHERE id = $1`, [second.request._id]);
    expect((await list(carla)).nextAllowedAt).toBeNull();
    expect((await ask(carla)).success).toBe(true);
    await runDataExportJobs();
  });

  it('só um em preparação', async () => {
    const dani = await newUser(A);
    const r = (await ask(dani)).request;
    await pool.query(`UPDATE data_exports SET created_at = created_at - interval '25 hours' WHERE id = $1`, [r._id]);
    const dup = await ask(dani);
    expect(dup.status).toBe(409);
    expect(dup).toMatchObject({ errorType: 'error-data-download-pending', error: 'Seus dados já estão sendo preparados.' });
    await runDataExportJobs();
    expect((await row(r._id)).status).toBe('ready');
  });

  it('configuração desligada', async () => {
    const eva = await newUser(A);
    const ready = await readyZip(eva);
    const fio = await newUser(A);
    const queued = (await ask(fio)).request;
    await setSettings({ UserData_EnableDownload: false });
    try {
      const r = await ask(eva);
      expect(r.status).toBe(403);
      expect(r.error).toBe('O download dos dados está desativado pelo administrador.');
      expect(await list(eva)).toMatchObject({ enabled: false, requests: [], nextAllowedAt: null });
      const file = await raw(fileUrl(ready.id), eva);
      expect(file.status).toBe(403);
      // Desligado, a fila espera: nada é preparado.
      await runDataExportJobs();
      expect((await row(queued._id)).status).toBe('pending');
    } finally {
      await setSettings({ UserData_EnableDownload: true });
    }
    await runDataExportJobs();
    expect((await row(queued._id)).status).toBe('ready');
  });

  it('só a própria pessoa baixa; expira e some do disco', async () => {
    const gil = await newUser(A);
    const intruso = await newUser(A);
    const { id } = await readyZip(gil);
    const other = await raw(fileUrl(id), intruso);
    expect(other.status).toBe(404);
    expect((await other.json()).error).toBe('Pedido não encontrado.');
    expect((await raw(fileUrl(id))).status).toBe(401);
    // Dá para baixar de novo até o prazo.
    expect((await raw(fileUrl(id), gil)).status).toBe(200);
    const file = path.join(exportsDir(), `${id}.zip`);
    expect(fs.existsSync(file)).toBe(true);
    await pool.query(`UPDATE data_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    // Vencido e ainda não varrido: 410 mesmo assim.
    expect((await raw(fileUrl(id), gil)).status).toBe(410);
    expect(await runDataExportJobs()).toMatchObject({ expired: 1 });
    expect(fs.existsSync(file)).toBe(false);
    expect((await row(id)).status).toBe('expired');
    const gone = await raw(fileUrl(id), gil);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ errorType: 'error-data-download-expired', error: 'Este arquivo expirou. Peça seus dados de novo.' });
    expect((await list(gil)).requests[0]).toMatchObject({ _id: id, status: 'expired' });
  });

  it('interrompido volta para a fila; desiste depois de 3 tentativas', async () => {
    const [h1, h2] = await Promise.all([newUser(A), newUser(A)]);
    const ins = (id: string, uid: string, attempts: number) =>
      pool.query(`INSERT INTO data_exports (id, kind, user_id, status, attempts, started_at) VALUES ($1, 'user', $2, 'running', $3, now())`, [id, uid, attempts]);
    const id1 = `stale1${Date.now()}`;
    const id2 = `stale2${Date.now()}`;
    await ins(id1, h1.userId, 1);
    await ins(id2, h2.userId, 3);
    const r = await runDataExportJobs();
    expect(r.failed).toBe(1);
    expect(await row(id1)).toMatchObject({ status: 'ready', attempts: 2 });
    expect(await row(id2)).toMatchObject({ status: 'failed', attempts: 3, error: 'O servidor reiniciou durante a preparação.' });
    expect((await list(h2)).requests[0]).toMatchObject({ status: 'failed', error: 'O servidor reiniciou durante a preparação.' });
    // O que falhou não segura a regra das 24 horas.
    expect((await ask(h2)).success).toBe(true);
    await runDataExportJobs();
  });

  it('conta desativada não gera', async () => {
    const ivo = await newUser(A);
    const r = (await ask(ivo)).request;
    await pool.query('UPDATE users SET active = false WHERE id = $1', [ivo.userId]);
    await runDataExportJobs();
    expect(await row(r._id)).toMatchObject({ status: 'failed', error: 'Conta desativada.' });
    expect(fs.existsSync(path.join(exportsDir(), `${r._id}.zip`))).toBe(false);
  });

  it('conta excluída: arquivo órfão é apagado', async () => {
    const jo = await newUser(A);
    const { id } = await readyZip(jo);
    const file = path.join(exportsDir(), `${id}.zip`);
    expect((await api('POST', 'users.delete', { userId: jo.userId }, A)).success).toBe(true);
    expect(await row(id)).toBeUndefined();
    // Recente (pode ser um pedido começando agora): fica. Com mais de 1 hora: sai. Um .part largado também.
    await runDataExportJobs();
    expect(fs.existsSync(file)).toBe(true);
    const old = new Date(Date.now() - 2 * H);
    fs.utimesSync(file, old, old);
    const part = path.join(exportsDir(), 'largado123.zip.part');
    fs.writeFileSync(part, 'x');
    fs.utimesSync(part, old, old);
    const other = path.join(exportsDir(), 'leia-me.txt');
    fs.writeFileSync(other, 'não é nosso');
    fs.utimesSync(other, old, old);
    await runDataExportJobs();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(part)).toBe(false);
    // Só os arquivos com o nome de um pedido.
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(other);
  });

  it('limite dos arquivos', async () => {
    const kiko = await newUser(A);
    const rid = (await api('POST', 'channels.create', { name: `limite-${Date.now()}` }, kiko)).channel._id;
    const small = await upload(kiko, rid, 'pequeno.bin', Buffer.alloc(600 * 1024, 1), 'application/octet-stream');
    const big = await upload(kiko, rid, 'grande.bin', Buffer.alloc(900 * 1024, 2), 'application/octet-stream');
    await setSettings({ DataExport_Max_Files_MB: 1 });
    try {
      const { entries, json, byName } = await readyZip(kiko);
      expect(entries.filter((e) => e.name.startsWith('arquivos/')).map((e) => e.name)).toEqual([`arquivos/${small.files[0]._id}-pequeno.bin`]);
      const files = json('arquivos.json');
      expect(files).toEqual([
        expect.objectContaining({ id: small.files[0]._id, incluido: true, tamanho: 600 * 1024 }),
        expect.objectContaining({ id: big.files[0]._id, incluido: false, motivo: 'limite', tamanho: 900 * 1024, link: `https://chat.empresa.com.br/file-upload/${big.files[0]._id}/grande.bin` }),
      ]);
      expect(byName.get('meus-dados.html')!.toString('utf8')).toContain('fora do .zip: passou do limite');
    } finally {
      await setSettings({ DataExport_Max_Files_MB: 2048 });
    }
  });

  it('auditoria', async () => {
    const lia = await newUser(A);
    const r = (await ask(lia)).request;
    const audits = async (action: string) => (await pool.query(`SELECT * FROM audit_log WHERE action = $1 AND actor_id = $2`, [action, lia.userId])).rows;
    expect(await audits('user.data.requested')).toEqual([expect.objectContaining({ actor_username: lia.username, target: { userId: lia.userId }, data: { requestId: r._id } })]);
    expect(await audits('user.data.downloaded')).toHaveLength(0);
    await runDataExportJobs();
    expect((await raw(fileUrl(r._id), lia)).status).toBe(200);
    const got = await audits('user.data.downloaded');
    expect(got).toHaveLength(1);
    expect(got[0].target).toEqual({ userId: lia.userId, requestId: r._id });
    expect(got[0].data.size).toBe(Number((await row(r._id)).size));
  });

  it('@usuário reaproveitado não herda as reações nem as salas da conta excluída', async () => {
    const dir = await newUser(A, { name: 'Diretor' });
    const old = await newUser(A, { name: 'Pessoa Antiga' });
    const secretName = `segredo-diretoria-${Date.now()}`;
    const g = (await api('POST', 'groups.create', { name: secretName, members: [old.username] }, dir)).group._id;
    const pub = (await api('POST', 'channels.create', { name: `geral-reuso-${Date.now()}`, members: [old.username] }, dir)).channel._id;
    const inGroup = (await api('POST', 'chat.sendMessage', { message: { rid: g, msg: 'pauta' } }, dir)).message;
    const inPublic = (await api('POST', 'chat.sendMessage', { message: { rid: pub, msg: 'bom dia' } }, dir)).message;
    expect((await api('POST', 'chat.react', { messageId: inGroup._id, emoji: ':tada:' }, old)).success).toBe(true);
    expect((await api('POST', 'chat.react', { messageId: inPublic._id, emoji: ':tada:' }, dir)).success).toBe(true);
    expect((await api('POST', 'chat.react', { messageId: inPublic._id, emoji: ':tada:' }, old)).success).toBe(true);
    expect((await api('POST', 'users.delete', { userId: old.userId }, A)).success).toBe(true);
    // As reações da conta excluída saem com ela; as dos outros ficam.
    const reactionsOf = async (id: string) => (await pool.query('SELECT reactions FROM messages WHERE id = $1', [id])).rows[0].reactions;
    expect(await reactionsOf(inGroup._id)).toEqual({});
    expect(await reactionsOf(inPublic._id)).toEqual({ ':tada:': { usernames: [dir.username] } });

    // Outra pessoa ganha o mesmo @usuário (comum no AD) e pede os dados.
    expect((await api('POST', 'users.create', { username: old.username, name: 'Pessoa Nova', email: `nova-${old.username}@test.local`, password: 'senha-forte-1' }, A)).success).toBe(true);
    const novo = await login(old.username, 'senha-forte-1');
    expect((await api('GET', 'groups.info', { roomId: g }, novo)).success).toBe(false);
    const { json, byName } = await readyZip(novo);
    expect(json('reacoes.json')).toEqual([]);
    const html = byName.get('meus-dados.html')!.toString('utf8');
    expect(html).not.toContain(secretName);
    expect(html).toContain('<h3>Reações (0)</h3>');
  });

  it('reações guardadas com um @usuário antigo: só entram as salas que a pessoa abre hoje', async () => {
    // Dados de antes desta versão: a conta excluída deixou o @usuário nas reações, e outra pessoa pegou o nome.
    const dir = await newUser(A, { name: 'Diretor' });
    const bea = await newUser(A, { name: 'Bea' });
    const novo = await newUser(A, { name: 'Pessoa Nova' });
    const secretName = `segredo-${Date.now()}`;
    const g = (await api('POST', 'groups.create', { name: secretName, members: [bea.username] }, dir)).group._id;
    const dm = (await api('POST', 'im.create', { username: bea.username }, dir)).room._id;
    const pub = (await api('POST', 'channels.create', { name: `aberto-${Date.now()}` }, dir)).channel._id;
    const ids: string[] = [];
    for (const rid of [g, dm, pub]) ids.push((await api('POST', 'chat.sendMessage', { message: { rid, msg: 'oi' } }, dir)).message._id);
    await pool.query(`UPDATE messages SET reactions = jsonb_build_object(':tada:', jsonb_build_object('usernames', jsonb_build_array($2::text))) WHERE id = ANY($1)`, [ids, novo.username]);
    const { json, byName } = await readyZip(novo);
    // O canal público ela abre (sem ser membro); o grupo privado e a conversa dos outros, não.
    expect(json('reacoes.json')).toEqual([{ mensagemId: ids[2], sala: expect.stringMatching(/^aberto-/), dataMensagem: expect.any(String), emoji: ':tada:' }]);
    const all = [...byName.values()].map((b) => b.toString('utf8')).join('\n');
    expect(all).not.toContain(secretName);
    expect(all).not.toContain('Conversa com Bea');
  });

  it('@usuário renomeado leva as reações junto', async () => {
    const dir = await newUser(A);
    const rui = await newUser(A, { name: 'Rui' });
    const rid = (await api('POST', 'channels.create', { name: `renome-${Date.now()}`, members: [rui.username] }, dir)).channel._id;
    const m = (await api('POST', 'chat.sendMessage', { message: { rid, msg: 'oi' } }, dir)).message;
    await api('POST', 'chat.react', { messageId: m._id, emoji: ':thumbsup:' }, dir);
    await api('POST', 'chat.react', { messageId: m._id, emoji: ':thumbsup:' }, rui);
    await api('POST', 'chat.react', { messageId: m._id, emoji: ':tada:' }, rui);
    const renamed = `${rui.username}x`;
    expect((await api('POST', 'users.update', { userId: rui.userId, data: { username: renamed } }, A)).success).toBe(true);
    const r = (await pool.query('SELECT reactions FROM messages WHERE id = $1', [m._id])).rows[0].reactions;
    // A ordem de quem reagiu fica.
    expect(r).toEqual({ ':thumbsup:': { usernames: [dir.username, renamed] }, ':tada:': { usernames: [renamed] } });
    const { json } = await readyZip({ ...rui, username: renamed });
    expect(json('reacoes.json').map((x: any) => x.emoji).sort()).toEqual([':tada:', ':thumbsup:']);
  });

  it('troca de senha pendente bloqueia o pedido e o download', async () => {
    const mia = await newUser(A);
    const { id } = await readyZip(mia);
    await pool.query('UPDATE users SET require_password_change = true WHERE id = $1', [mia.userId]);
    const res = await raw(fileUrl(id), mia);
    expect(res.status).toBe(403);
    expect((await res.json()).errorType).toBe('error-password-change-required');
    expect((await ask(mia)).status).toBe(403);
  });
  it('lembretes, agendadas, os próprios votos e o comentário das encaminhadas', async () => {
    const lia = await newUser(A, { name: 'Lia Prado' });
    const rui = await newUser(A, { name: 'Rui Costa' });
    const rid = (await api('POST', 'channels.create', { name: `mensagens-${Date.now()}`, members: [rui.username] }, lia)).channel._id;
    const msg = (await api('POST', 'chat.sendMessage', { message: { rid, msg: 'lembra disso' } }, rui)).message;
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    expect((await api('POST', 'reminders.set', { messageId: msg._id, remindAt: soon }, lia)).success).toBe(true);
    expect((await api('POST', 'reminders.set', { messageId: msg._id, remindAt: soon }, rui)).success).toBe(true);
    expect((await api('POST', 'chat.scheduleMessage', { message: { rid, msg: 'texto agendado' }, sendAt: soon }, lia)).success).toBe(true);
    const poll = (await api('POST', 'polls.create', { rid, question: 'Café?', options: ['Sim', 'Não'], anonymous: true }, rui)).message;
    await api('POST', 'polls.vote', { messageId: poll._id, optionIds: ['o1'] }, lia);
    await api('POST', 'polls.vote', { messageId: poll._id, optionIds: ['o2'] }, rui);
    const fwd = await api('POST', 'chat.forwardMessage', { messageId: msg._id, targets: [{ rid }], comment: 'olha isso' }, lia);
    expect(fwd.results[0].ok).toBe(true);

    const { json, byName } = await readyZip(lia);
    expect(json('lembretes.json')).toEqual([expect.objectContaining({ mensagemId: msg._id, avisadoEm: null })]);
    expect(json('agendadas.json')).toEqual([expect.objectContaining({ texto: 'texto agendado', situacao: 'Agendada' })]);
    expect(json('votos.json')).toEqual([expect.objectContaining({ mensagemId: poll._id, pergunta: 'Café?', opcao: 'Sim' })]);
    const mine = json('mensagens.json').find((m: any) => m.id === fwd.results[0].message._id);
    expect(mine).toMatchObject({ texto: 'lembra disso', encaminhada: true, comentario: 'olha isso' });
    const html = byName.get('meus-dados.html')!.toString('utf8');
    expect(html).toContain('texto agendado');
    expect(html).toContain('olha isso');
    expect(html).not.toContain('>Não<');
  });
});
