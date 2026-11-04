import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/db/pool';
import { __resetLibreForTests } from '../src/translate/libre';
import { __resetTranslateForTests } from '../src/translate/service';
import { defaultLanguages, startFakeLibre, type FakeLibre } from './fake-libretranslate';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Tradução de mensagens (§7.3): configuração, teste de conexão, tradução sob demanda com cache por texto, limites,
// disjuntor, criptografia, acesso, Operação e canal de avisos, tudo contra o LibreTranslate falso. Nada sai para a
// internet.

let F: FakeLibre;
let A: Auth;
let bruno: Auth; // escreve em português
let ana: Auth; // lê em inglês
let carla: Auth; // lê em inglês
let ch: { _id: string; name: string };

const uniq = (p: string) => `${p}-${crypto.randomBytes(3).toString('hex')}`;
const settings = (s: Record<string, unknown>) => api('POST', 'settings', { settings: s }, A);

async function send(u: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, u);
  if (!r.message) throw new Error(JSON.stringify(r));
  return r.message as { _id: string; rid: string; msg: string };
}

async function channel(owner: Auth, members: Auth[] = [], extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'channels.create', { name: uniq('trad'), members: members.map((m) => m.username), ...extra }, owner);
  if (!r.channel) throw new Error(JSON.stringify(r));
  return r.channel as { _id: string; name: string };
}

async function group(owner: Auth, members: Auth[] = []) {
  const r = await api('POST', 'groups.create', { name: uniq('grupo'), members: members.map((m) => m.username) }, owner);
  if (!r.group) throw new Error(JSON.stringify(r));
  return r.group as { _id: string; name: string };
}

const tr = (u: Auth, rid: string, ids: string[], targetLanguage?: string) =>
  api('POST', 'autoTranslate.translateMessages', { roomId: rid, messageIds: ids, ...(targetLanguage ? { targetLanguage } : {}) }, u);

const rowsOf = async (table: 'message_translations' | 'message_languages', id: string) => (await pool.query(`SELECT * FROM ${table} WHERE message_id = $1`, [id])).rows;
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

// O texto de todos os corpos recebidos pelo falso (para conferir o que saiu do chat).
const sentToFake = () => F.calls.map((c) => `${c.path}?${new URLSearchParams(c.query).toString()} ${c.body}`).join('\n');

beforeAll(async () => {
  F = await startFakeLibre();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = F.host;
  await startServer();
  A = await admin();
  await settings({ API_Enable_Rate_Limiter: false });
  [bruno, ana, carla] = await Promise.all([newUser(A), newUser(A), newUser(A)]);
  for (const u of [ana, carla]) await api('POST', 'users.setPreferences', { data: { language: 'en' } }, u);
  ch = await channel(bruno, [ana, carla]);
});

afterAll(async () => {
  await stopServer();
  await F?.close();
});

beforeEach(async () => {
  F.reset();
  __resetTranslateForTests();
  __resetLibreForTests();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = F.host;
  config.translate.apiKey = null;
  const r = await settings({
    AutoTranslate_Enabled: true,
    AutoTranslate_LibreTranslate_Url: F.url,
    AutoTranslate_LibreTranslate_ApiKey: '',
    AutoTranslate_Timeout_Seconds: 15,
    AutoTranslate_User_Limit_Per_Minute: 120,
    AutoTranslate_Max_Concurrent: 4,
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
});

describe('configuração e teste de conexão', () => {
  it('endereço fora de INTEGRATIONS_ALLOWED_HOSTS é recusado; a chave fica mascarada na tela e na auditoria', async () => {
    const bad = await settings({ AutoTranslate_LibreTranslate_Url: 'http://10.9.9.9:5000' });
    expect(bad.status).toBe(400);
    expect(bad.errorType).toBe('error-invalid-setting-value');
    expect(bad.error).toContain('INTEGRATIONS_ALLOWED_HOSTS');
    expect(bad.error).toContain('10.9.9.9:5000');

    expect((await settings({ AutoTranslate_LibreTranslate_ApiKey: 'segredo-da-chave' })).status).toBe(200);
    const list = (await api('GET', 'settings', { group: 'AutoTranslate' }, A)).settings as { _id: string; value: unknown }[];
    expect(list.map((s) => s._id).sort()).toEqual(
      ['AutoTranslate_Enabled', 'AutoTranslate_LibreTranslate_ApiKey', 'AutoTranslate_LibreTranslate_Url', 'AutoTranslate_Max_Concurrent', 'AutoTranslate_Timeout_Seconds', 'AutoTranslate_User_Limit_Per_Minute'].sort(),
    );
    expect(list.find((s) => s._id === 'AutoTranslate_LibreTranslate_ApiKey')!.value).toBe('********');
    const log = await api('GET', 'audit.log', { action: 'settings.changed' }, A);
    expect(JSON.stringify(log)).toContain('***');
    expect(JSON.stringify(log)).not.toContain('segredo-da-chave');
    // Só a chave liga/desliga é pública (a web esconde os itens com ela).
    const pub = (await api('GET', 'settings.public')).settings as { _id: string }[];
    expect(pub.some((s) => s._id === 'AutoTranslate_Enabled')).toBe(true);
    expect(pub.some((s) => s._id === 'AutoTranslate_LibreTranslate_Url' || s._id === 'AutoTranslate_LibreTranslate_ApiKey')).toBe(false);
    // O idioma padrão da empresa passa a ser o destino padrão das traduções.
    expect(((await api('GET', 'settings', { group: 'General' }, A)).settings as any[]).find((s) => s._id === 'Language').label).toBe(
      'Idioma padrão (destino das traduções de mensagens)',
    );
  });

  it('teste de conexão: sucesso, chave errada, tempo limite, rede da internet, permissão e rascunho', async () => {
    const ok = await api('POST', 'autoTranslate.testConnection', {}, A);
    expect(ok.status).toBe(200);
    expect(ok.message).toBe('Conexão bem-sucedida: 5 idiomas. Teste: “Bom dia” → “Good morning”.');
    expect(ok.languages).toBe(5);
    expect(ok.warnings).toEqual([]);

    F.requireKey = 'chave-certa';
    const wrong = await api('POST', 'autoTranslate.testConnection', { apiKey: 'chave-errada' }, A);
    expect(wrong.status).toBe(400);
    expect(wrong.errorType).toBe('error-translate-connection');
    expect(wrong.error).toMatch(/^Falha na conexão: .*recusou a chave/);
    const missing = await api('POST', 'autoTranslate.testConnection', {}, A);
    expect(missing.error).toContain('pediu uma chave de API');
    expect((await api('POST', 'autoTranslate.testConnection', { apiKey: 'chave-certa' }, A)).status).toBe(200);
    F.requireKey = null;

    await settings({ AutoTranslate_Timeout_Seconds: 3 });
    F.delayMs = 3500;
    const slow = await api('POST', 'autoTranslate.testConnection', {}, A);
    expect(slow.error).toContain('demorou demais');
    F.delayMs = 0;

    // Endereço da internet liberado por engano: recusado antes de conectar.
    process.env.INTEGRATIONS_ALLOWED_HOSTS = `${F.host},8.8.8.8:5000`;
    const before = F.calls.length;
    const ext = await api('POST', 'autoTranslate.testConnection', { url: 'http://8.8.8.8:5000' }, A);
    expect(ext.status).toBe(400);
    expect(ext.error).toContain('precisa estar na rede da empresa');
    expect(F.calls.length).toBe(before);

    const user = await api('POST', 'autoTranslate.testConnection', {}, ana);
    expect(user.status).toBe(403);
    expect(user.error).toBe('Você não tem permissão para alterar as configurações.');

    // O rascunho da tela vale sem salvar.
    const F2 = await startFakeLibre();
    try {
      F2.languages = defaultLanguages(['en', 'pt']);
      process.env.INTEGRATIONS_ALLOWED_HOSTS = `${F.host},${F2.host}`;
      F.calls.length = 0;
      const draft = await api('POST', 'autoTranslate.testConnection', { url: F2.url }, A);
      expect(draft.message).toContain('Conexão bem-sucedida: 2 idiomas');
      expect(F2.calls.length).toBeGreaterThan(0);
      expect(F.calls.length).toBe(0);
      // Sem o idioma da empresa e com limite de caracteres pequeno: avisos, sem falhar.
      F2.languages = defaultLanguages(['en', 'es']);
      F2.charLimit = 500;
      const warn = await api('POST', 'autoTranslate.testConnection', { url: F2.url }, A);
      expect(warn.status).toBe(200);
      expect(warn.message).toContain('Teste: “Good morning” → “[en>es] Good morning”');
      expect(warn.warnings).toEqual([
        'O LibreTranslate aceita no máximo 500 caracteres por trecho; trechos maiores não são traduzidos.',
        'O servidor não tem o português instalado. Instale o pacote pt no LibreTranslate.',
        'O idioma padrão da empresa (pt-BR) não está instalado no servidor de tradução.',
      ]);
      const empty = await api('POST', 'autoTranslate.testConnection', { url: '' }, A);
      expect(empty.error).toBe('Falha na conexão: Informe o endereço do LibreTranslate em Configurações › Tradução automática.');
    } finally {
      await F2.close();
    }
  });
});

describe('traduzir', () => {
  it('caminho feliz: menção, código, link e emoji ficam exatos e nunca vão ao tradutor', async () => {
    const m = await send(bruno, ch._id, `Bom dia, @${ana.username}! Veja \`npm test\` em https://x.example/a :smile:`);
    const r = await tr(ana, ch._id, [m._id]);
    expect(r.status).toBe(200);
    expect(r.language).toBe('en');
    expect(r.notice).toBeUndefined();
    expect(r.translations).toHaveLength(1);
    const t = r.translations[0];
    expect(t).toMatchObject({ _id: m._id, status: 'translated', language: 'en', source: 'pt' });
    expect(t.text).toContain('Good morning,');
    for (const keep of [`@${ana.username}`, '`npm test`', 'https://x.example/a', ':smile:']) expect(t.text).toContain(keep);
    const out = sentToFake();
    for (const never of [`@${ana.username}`, 'https://x.example', 'npm test', ':smile:']) expect(out).not.toContain(never);
    expect(F.detectCalls()).toHaveLength(1);
    expect(F.translateCalls()).toHaveLength(1);
    expect(F.translateCalls()[0]).toMatchObject({ source: 'pt', target: 'en', format: 'text' });
    // Guardada para o texto atual.
    expect(await rowsOf('message_translations', m._id)).toMatchObject([{ language: 'en', source_language: 'pt', source_hash: sha(m.msg), text: t.text }]);
    expect(await rowsOf('message_languages', m._id)).toMatchObject([{ language: 'pt', source_hash: sha(m.msg) }]);

    // Cache: Carla lê a mesma tradução sem chamar o LibreTranslate, e o balde dela não gasta.
    await settings({ AutoTranslate_User_Limit_Per_Minute: 10 });
    const calls = F.calls.length;
    for (let i = 0; i < 12; i++) {
      const again = await tr(carla, ch._id, [m._id]);
      expect(again.translations[0]).toMatchObject({ status: 'translated', text: t.text, source: 'pt' });
    }
    expect(F.calls.length).toBe(calls);
  });

  it('lote misto: uma detecção por mensagem e uma tradução por idioma de origem, nunca "auto"', async () => {
    const en = await send(bruno, ch._id, 'Hello team, the build is green');
    const es = await send(bruno, ch._id, 'Hola equipo, gracias por todo');
    const pt = await send(bruno, ch._id, 'Bom dia, hoje tem reunião');
    const r = await tr(ana, ch._id, [en._id, es._id, pt._id], 'pt-BR');
    expect(r.language).toBe('pt-BR');
    expect(r.translations.map((t: any) => [t._id, t.status, t.source])).toEqual([
      [en._id, 'translated', 'en'],
      [es._id, 'translated', 'es'],
      [pt._id, 'same', 'pt'],
    ]);
    expect(F.detectCalls()).toHaveLength(3);
    const calls = F.translateCalls();
    expect(calls.map((c) => c.source).sort()).toEqual(['en', 'es']);
    expect(calls.every((c) => c.target === 'pt-BR' && c.source !== 'auto')).toBe(true);
    // A mensagem em português nunca foi ao /translate.
    expect(JSON.stringify(calls)).not.toContain('reunião');
  });

  it('edição apaga as traduções e o idioma; o pedido seguinte manda o texto novo', async () => {
    const m = await send(bruno, ch._id, 'Bom dia, hoje o deploy é às 15h');
    expect((await tr(ana, ch._id, [m._id])).translations[0].status).toBe('translated');
    expect(await rowsOf('message_translations', m._id)).toHaveLength(1);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'Bom dia, hoje o deploy é às 17h' }, bruno)).status).toBe(200);
    expect(await rowsOf('message_translations', m._id)).toHaveLength(0);
    expect(await rowsOf('message_languages', m._id)).toHaveLength(0);
    F.calls.length = 0;
    const r = await tr(ana, ch._id, [m._id]);
    expect(r.translations[0].text).toContain('17h');
    expect(JSON.stringify(F.translateCalls())).toContain('17h');
  });

  it('edição durante a chamada: nada é gravado com o texto velho', async () => {
    const m = await send(bruno, ch._id, 'Você pode revisar o relatório hoje?');
    // O idioma já fica conhecido (tradução para o espanhol); a próxima só traduz.
    expect((await tr(ana, ch._id, [m._id], 'es')).translations[0].status).toBe('translated');
    F.delayMs = 500;
    const pending = tr(ana, ch._id, [m._id], 'en');
    await sleep(150);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'Você pode revisar o relatório amanhã?' }, bruno)).status).toBe(200);
    const r = await pending;
    expect(r.translations[0]).toMatchObject({ status: 'failed', reason: 'changed' });
    expect(r.notice).toBeUndefined();
    const rows = (await pool.query('SELECT source_hash FROM message_translations WHERE message_id = $1 UNION ALL SELECT source_hash FROM message_languages WHERE message_id = $1', [m._id])).rows;
    expect(rows.filter((x) => x.source_hash === sha(m.msg))).toEqual([]);
  });

  it('remoção: raiz de tópico (vira "removida"), mensagem comum (cascata) e limpar histórico', async () => {
    const root = await send(bruno, ch._id, 'Bom dia, quem cuida do plantão hoje?');
    await send(carla, ch._id, 'Eu cuido', { tmid: root._id });
    const plain = await send(bruno, ch._id, 'Bom dia, você viu o alerta?');
    expect((await tr(ana, ch._id, [root._id, plain._id])).translations.map((t: any) => t.status)).toEqual(['translated', 'translated']);
    await api('POST', 'chat.delete', { msgId: root._id, roomId: ch._id }, bruno);
    expect((await pool.query('SELECT t, msg FROM messages WHERE id = $1', [root._id])).rows[0]).toEqual({ t: 'rm', msg: '' });
    expect(await rowsOf('message_translations', root._id)).toHaveLength(0);
    expect(await rowsOf('message_languages', root._id)).toHaveLength(0);
    await api('POST', 'chat.delete', { msgId: plain._id, roomId: ch._id }, bruno);
    expect(await rowsOf('message_translations', plain._id)).toHaveLength(0);
    expect(await rowsOf('message_languages', plain._id)).toHaveLength(0);
    // A raiz removida não volta a ser traduzida.
    expect((await tr(ana, ch._id, [root._id])).translations).toEqual([]);

    const room = await channel(bruno, [ana]);
    const old = await send(bruno, room._id, 'Bom dia, hoje tem reunião');
    expect((await tr(ana, room._id, [old._id])).translations[0].status).toBe('translated');
    const clean = await api('POST', 'rooms.cleanHistory', { roomId: room._id, latest: new Date(Date.now() + 60_000).toISOString(), oldest: '2000-01-01T00:00:00.000Z' }, A);
    expect(clean.status).toBe(200);
    expect(await rowsOf('message_translations', old._id)).toHaveLength(0);
  });

  it('sala criptografada: nunca traduz; ligar a criptografia apaga o guardado e desliga a tradução automática', async () => {
    // Grupo privado (a criptografia de ponta a ponta só vale para grupos e conversas diretas).
    const g = await group(bruno, [ana]);
    const m = await send(bruno, g._id, 'Bom dia, hoje é dia de deploy');
    expect((await api('POST', 'autoTranslate.saveSettings', { roomId: g._id, field: 'autoTranslate', value: true }, ana)).status).toBe(200);
    expect((await tr(ana, g._id, [m._id])).translations[0].status).toBe('translated');
    const ws = connectWs(ana);
    await ws.ready;
    try {
      expect((await api('POST', 'rooms.saveRoomSettings', { rid: g._id, encrypted: true }, bruno)).status).toBe(200);
      const ev = await ws.waitFor((e) => e.type === 'subscription' && e.subscription?.rid === g._id);
      expect(ev.subscription.autoTranslate).toBeUndefined();
    } finally {
      ws.close();
    }
    expect((await pool.query('SELECT auto_translate FROM subscriptions WHERE room_id = $1 AND user_id = $2', [g._id, ana.userId])).rows[0].auto_translate).toBe(false);
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM message_translations WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1) UNION ALL SELECT count(*)::int FROM message_languages WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1)',
      [g._id],
    );
    expect(left.rows.map((r) => r.n)).toEqual([0, 0]);
    F.calls.length = 0;
    const r = await tr(ana, g._id, [m._id]);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-translate-encrypted');
    expect(r.error).toBe('Mensagens de salas criptografadas não são traduzidas.');
    const on = await api('POST', 'autoTranslate.saveSettings', { roomId: g._id, field: 'autoTranslate', value: true }, ana);
    expect(on.errorType).toBe('error-translate-encrypted');
    expect(F.calls).toHaveLength(0);
  });

  it('mensagem de sistema ou cifrada (messages.e2e) fica fora da resposta, numa sala comum', async () => {
    const m = await send(bruno, ch._id, 'Bom dia, hoje tem treinamento');
    const sys = `sys${crypto.randomBytes(6).toString('hex')}`;
    await pool.query(`INSERT INTO messages (id, room_id, user_id, username, user_name, msg, t) VALUES ($1, $2, $3, $4, '', 'Bom dia, texto de sistema', 'e2e')`, [
      sys,
      ch._id,
      bruno.userId,
      bruno.username,
    ]);
    // A coluna da criptografia ponta a ponta (messages.e2e) chega com outro grupo: o teste cria a coluna se ela ainda
    // não existe e confere que a mensagem cifrada nunca chega ao tradutor.
    const had = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'e2e'`)).rowCount;
    if (!had) await pool.query('ALTER TABLE messages ADD COLUMN e2e jsonb');
    const enc = `enc${crypto.randomBytes(6).toString('hex')}`;
    try {
      await pool.query(`INSERT INTO messages (id, room_id, user_id, username, user_name, msg, e2e) VALUES ($1, $2, $3, $4, '', $5, '{"algorithm":"x","ciphertext":"y"}')`, [
        enc,
        ch._id,
        bruno.userId,
        bruno.username,
        had ? '' : 'Bom dia, texto que veio cifrado',
      ]);
      const r = await tr(ana, ch._id, [sys, enc, m._id]);
      expect(r.translations.map((t: any) => t._id)).toEqual([m._id]);
      expect(sentToFake()).not.toContain('texto');
      expect(await rowsOf('message_languages', enc)).toHaveLength(0);
    } finally {
      await pool.query('DELETE FROM messages WHERE id = ANY($1)', [[sys, enc]]);
      if (!had) await pool.query('ALTER TABLE messages DROP COLUMN e2e');
    }
  });

  it('permissão auto-translate e função desligada', async () => {
    const m = await send(bruno, ch._id, 'Bom dia, tudo certo por aí?');
    const roles = (await api('GET', 'permissions.listAll', {}, A)).update.find((p: any) => p._id === 'auto-translate').roles as string[];
    expect(roles.sort()).toEqual(['admin', 'operacao', 'user']);
    await api('POST', 'permissions.update', { permissions: [{ _id: 'auto-translate', roles: roles.filter((x) => x !== 'user') }] }, A);
    try {
      const r = await tr(ana, ch._id, [m._id]);
      expect(r.status).toBe(403);
      expect(r.error).toBe('Você não tem permissão para traduzir mensagens.');
      expect((await api('GET', 'autoTranslate.getSupportedLanguages', {}, ana)).status).toBe(403);
      expect((await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslate', value: true }, ana)).status).toBe(403);
    } finally {
      await api('POST', 'permissions.update', { permissions: [{ _id: 'auto-translate', roles }] }, A);
    }
    await settings({ AutoTranslate_Enabled: false });
    const off = await tr(ana, ch._id, [m._id]);
    expect(off.status).toBe(400);
    expect(off.errorType).toBe('error-translate-disabled');
    expect(off.error).toBe('A tradução de mensagens está desligada.');
    expect((await api('GET', 'autoTranslate.getSupportedLanguages', {}, ana)).errorType).toBe('error-translate-disabled');
    // Sem endereço também conta como desligada.
    await settings({ AutoTranslate_Enabled: true, AutoTranslate_LibreTranslate_Url: '' });
    expect((await tr(ana, ch._id, [m._id])).errorType).toBe('error-translate-disabled');
  });

  it('acesso: grupo de que a pessoa não participa e id de outra sala no pedido', async () => {
    const secret = await group(bruno, [carla]);
    const hidden = await send(bruno, secret._id, 'Bom dia, segredo do grupo');
    const r = await tr(ana, secret._id, [hidden._id]);
    expect(r.status).toBe(403);
    expect(r.error).toBe('Você não tem acesso a esta sala.');
    const mine = await send(bruno, ch._id, 'Bom dia, mensagem do canal');
    const mixed = await tr(ana, ch._id, [hidden._id, mine._id]);
    expect(mixed.translations.map((t: any) => t._id)).toEqual([mine._id]);
    expect(sentToFake()).not.toContain('segredo');
    // Pedido inválido.
    expect((await tr(ana, ch._id, [])).error).toBe('Envie de 1 a 50 mensagens por vez.');
    expect((await tr(ana, ch._id, Array.from({ length: 51 }, (_, i) => `m${i}`))).errorType).toBe('error-invalid-params');
    expect((await tr(ana, ch._id, [mine._id], '<script>')).errorType).toBe('error-translate-language');
  });

  it('Operação traduz o que pode ler; não cria conversa, sala nem inscrição', async () => {
    const op = await newUser(A, { roles: ['operacao'] });
    await api('POST', 'users.setPreferences', { data: { language: 'en' } }, op);
    const room = await channel(bruno, [op]);
    const m = await send(bruno, room._id, 'Bom dia, hoje a escala muda');
    const dm = (await api('POST', 'im.create', { username: bruno.username }, op)).room;
    const dmMsg = await send(bruno, dm._id, 'Bom dia, você pode cobrir hoje?');
    const other = (await api('POST', 'im.create', { username: carla.username }, bruno)).room;
    const otherMsg = await send(bruno, other._id, 'Bom dia, conversa particular');
    const count = async () => (await pool.query('SELECT (SELECT count(*) FROM rooms)::int AS r, (SELECT count(*) FROM subscriptions)::int AS s')).rows[0];
    const before = await count();
    expect((await tr(op, room._id, [m._id])).translations[0].status).toBe('translated');
    expect((await tr(op, dm._id, [dmMsg._id])).translations[0].status).toBe('translated');
    expect((await tr(op, other._id, [otherMsg._id])).status).toBe(403);
    expect(await count()).toEqual(before);
  });

  it('canal de avisos: quem só lê traduz; nada é publicado e o "Ciente" não muda', async () => {
    const pub = await newUser(A);
    const r = await api('POST', 'channels.create', { name: uniq('avisos'), members: [pub.username, ana.username], extraData: { notice: true, noticeAck: true } }, bruno);
    const rid = r.channel._id as string;
    await api('POST', 'channels.addPublisher', { roomId: rid, userId: pub.userId }, bruno);
    const aviso = await send(pub, rid, '# Aviso importante\nA reunião mudou para amanhã.', { ackRequired: true });
    expect((await api('POST', 'chat.sendMessage', { message: { rid, msg: 'oi' } }, ana)).status).toBe(403);
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      const since = ws.events.length;
      const t = await tr(ana, rid, [aviso._id]);
      expect(t.translations[0].status).toBe('translated');
      expect(t.translations[0].text).toBe('# Important notice\nThe meeting moved to tomorrow.');
      await sleep(300);
      expect(ws.events.slice(since).filter((e) => e.type === 'message' || e.type === 'message.deleted')).toEqual([]);
    } finally {
      ws.close();
    }
    const row = (await pool.query('SELECT ack_count, msg, edited_at FROM messages WHERE id = $1', [aviso._id])).rows[0];
    expect(row).toEqual({ ack_count: 0, msg: aviso.msg, edited_at: null });
  });
});

describe('limites e falhas do servidor de tradução', () => {
  it('limite por pessoa: o que cabe é traduzido; o resto espera; o guardado não conta', async () => {
    await settings({ AutoTranslate_User_Limit_Per_Minute: 10 });
    const room = await channel(bruno, [ana]);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await send(bruno, room._id, `Bom dia, mensagem número ${i} de hoje`))._id);
    const r = await tr(ana, room._id, ids);
    expect(r.translations.filter((t: any) => t.status === 'translated')).toHaveLength(10);
    const rate = r.translations.filter((t: any) => t.status === 'failed');
    expect(rate).toHaveLength(2);
    expect(rate.every((t: any) => t.reason === 'rate')).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.notice).toBe('Muitas traduções seguidas. As próximas aparecem em instantes.');
    const done = r.translations.filter((t: any) => t.status === 'translated').map((t: any) => t._id);
    const calls = F.calls.length;
    const again = await tr(ana, room._id, done);
    expect(again.translations.every((t: any) => t.status === 'translated')).toBe(true);
    expect(F.calls.length).toBe(calls);
  });

  it('tempo limite e disjuntor', async () => {
    await settings({ AutoTranslate_Timeout_Seconds: 3 });
    const m = await send(bruno, ch._id, 'Bom dia, o servidor está lento hoje');
    F.delayMs = 3500;
    const r = await tr(ana, ch._id, [m._id]);
    expect(r.translations[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(r.notice).toBe('O servidor de tradução não está respondendo. Mostrando o texto original.');
    // Disjuntor aberto: o LibreTranslate não é chamado.
    F.delayMs = 0;
    const calls = F.calls.length;
    const second = await tr(ana, ch._id, [m._id]);
    expect(second.translations[0]).toMatchObject({ status: 'failed', reason: 'unavailable' });
    expect(F.calls.length).toBe(calls);
    // Com um disjuntor curto, volta a chamar depois do tempo.
    __resetTranslateForTests({ breakerMs: 200 });
    F.failNext({ status: 503, body: { error: 'fora' } }, '/detect');
    expect((await tr(ana, ch._id, [m._id])).translations[0]).toMatchObject({ status: 'failed', reason: 'unavailable' });
    const n = F.calls.length;
    expect((await tr(ana, ch._id, [m._id])).translations[0].reason).toBe('unavailable');
    expect(F.calls.length).toBe(n);
    await sleep(300);
    expect((await tr(ana, ch._id, [m._id])).translations[0].status).toBe('translated');
    expect(F.calls.length).toBeGreaterThan(n);
  });

  it('429 com Retry-After e 500', async () => {
    const m = await send(bruno, ch._id, 'Bom dia, pode me ligar hoje?');
    F.failNext({ status: 429, headers: { 'retry-after': '5' }, body: { error: 'Too many requests' } }, '/detect');
    const busy = await tr(ana, ch._id, [m._id]);
    expect(busy.translations[0]).toMatchObject({ status: 'failed', reason: 'busy' });
    expect(busy.retryAfterMs).toBeGreaterThanOrEqual(5000);
    expect(busy.notice).toBe('O servidor de tradução está ocupado. Tentando de novo em instantes.');
    F.failNext({ status: 500, body: { error: 'erro interno' } }, '/detect');
    const down = await tr(ana, ch._id, [m._id]);
    expect(down.translations[0]).toMatchObject({ status: 'failed', reason: 'unavailable' });
  });

  it('limite de texto: o lote vira uma por uma; a que sozinha passa do limite falha', async () => {
    const room = await channel(bruno, [ana]);
    const long = await send(bruno, room._id, `Bom dia ${'texto '.repeat(60)}`);
    const a = await send(bruno, room._id, 'Bom dia equipe');
    const b = await send(bruno, room._id, 'Você vem hoje');
    F.translateHook = (body) => {
      if (body.q.length > 1 || body.q.some((x: string) => x.length > 200)) return { status: 400, body: { error: 'Invalid request: request (400) exceeds text limit (200)' } };
      return undefined;
    };
    const r = await tr(ana, room._id, [long._id, a._id, b._id]);
    expect(r.translations.map((t: any) => [t._id, t.status, t.reason])).toEqual([
      [long._id, 'failed', 'too-long'],
      [a._id, 'translated', undefined],
      [b._id, 'translated', undefined],
    ]);
    expect(r.notice).toBe('Uma mensagem é longa demais para o servidor de tradução.');
  });

  it('sem letras e idioma desconhecido', async () => {
    const thumbs = await send(bruno, ch._id, '👍👍');
    const ok = await send(bruno, ch._id, 'ok');
    const unknown = await send(bruno, ch._id, 'tudo certo então');
    const r = await tr(ana, ch._id, [thumbs._id, ok._id, unknown._id]);
    expect(r.translations.map((t: any) => t.status)).toEqual(['unknown', 'unknown', 'unknown']);
    // Só a frase com letras perguntou o idioma.
    expect(F.detectCalls()).toHaveLength(1);
    expect(F.translateCalls()).toHaveLength(0);
    expect((await rowsOf('message_languages', thumbs._id))[0].language).toBe('und');
    // Da segunda vez, nada é perguntado.
    F.calls.length = 0;
    expect((await tr(ana, ch._id, [thumbs._id, unknown._id])).translations.map((t: any) => t.status)).toEqual(['unknown', 'unknown']);
    expect(F.calls).toHaveLength(0);
  });

  it('dois pedidos ao mesmo tempo para a mesma tradução: uma chamada só', async () => {
    const m = await send(bruno, ch._id, 'Boa tarde, você viu o alerta de hoje?');
    F.delayMs = 300;
    const [x, y] = await Promise.all([tr(ana, ch._id, [m._id]), tr(carla, ch._id, [m._id])]);
    expect(x.translations[0].status).toBe('translated');
    expect(y.translations[0]).toEqual(x.translations[0]);
    expect(F.detectCalls()).toHaveLength(1);
    expect(F.translateCalls()).toHaveLength(1);
  });

  it('chave da API: só no corpo JSON; com LIBRETRANSLATE_API_KEY_FILE a da tela não vale', async () => {
    F.requireKey = 'chave-123';
    const m = await send(bruno, ch._id, 'Bom dia, chave nova hoje');
    const without = await tr(ana, ch._id, [m._id]);
    expect(without.translations[0]).toMatchObject({ status: 'failed', reason: 'config' });
    expect(without.notice).toBe('A tradução não está disponível: o servidor de tradução não está configurado direito. Avise o administrador.');
    await settings({ AutoTranslate_LibreTranslate_ApiKey: 'chave-123' });
    F.calls.length = 0;
    expect((await tr(ana, ch._id, [m._id])).translations[0].status).toBe('translated');
    for (const c of F.calls.filter((x) => x.method === 'POST')) {
      expect(c.json.api_key).toBe('chave-123');
      expect(c.query).toEqual({});
      expect(c.path).not.toContain('chave');
    }
    expect(F.calls.filter((c) => c.method === 'GET').every((c) => !c.body.includes('chave-123'))).toBe(true);

    config.translate.apiKey = 'do-arquivo';
    try {
      const locked = await settings({ AutoTranslate_LibreTranslate_ApiKey: 'outra' });
      expect(locked.status).toBe(400);
      expect(locked.error).toContain('LIBRETRANSLATE_API_KEY_FILE');
      // A do arquivo vale mais que a gravada.
      F.requireKey = 'do-arquivo';
      const other = await send(bruno, ch._id, 'Bom dia, outra mensagem de hoje');
      expect((await tr(ana, ch._id, [other._id])).translations[0].status).toBe('translated');
    } finally {
      config.translate.apiKey = null;
    }
  });

  it('saída do tradutor não cria link nem bloco de código', async () => {
    const m = await send(bruno, ch._id, 'Veja o manual hoje');
    F.translateHook = (body) => ({ body: { translatedText: body.q.map(() => 'See ```rm -rf /``` at https://evil.example and [here](https://evil.example)') } });
    const t = (await tr(ana, ch._id, [m._id])).translations[0];
    expect(t.status).toBe('translated');
    expect(t.text).not.toContain('```');
    expect(t.text).not.toMatch(/https?:\/\//);
    expect(t.text).not.toContain('](');
    expect(t.text).toContain('​');
    // Saída vazia (alucinação ou falha do modelo): não grava.
    const other = await send(bruno, ch._id, 'Bom dia, mais uma de hoje');
    F.translateHook = (body) => ({ body: { translatedText: body.q.map(() => '   ') } });
    expect((await tr(ana, ch._id, [other._id])).translations[0]).toMatchObject({ status: 'failed', reason: 'unavailable' });
    expect(await rowsOf('message_translations', other._id)).toHaveLength(0);
  });
});

describe('preferências e rotas no formato do Rocket.Chat', () => {
  it('saveSettings: liga, escolhe o idioma e volta a seguir a preferência', async () => {
    const ws = connectWs(ana);
    await ws.ready;
    try {
      const at = () => ws.events.length;
      let since = at();
      expect((await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslate', value: true }, ana)).status).toBe(200);
      let ev = await ws.waitFor((e) => ws.events.indexOf(e) >= since && e.type === 'subscription' && e.subscription.rid === ch._id);
      expect(ev.subscription).toMatchObject({ autoTranslate: true });
      since = at();
      await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslateLanguage', value: 'es' }, ana);
      ev = await ws.waitFor((e) => ws.events.indexOf(e) >= since && e.type === 'subscription' && e.subscription.rid === ch._id);
      expect(ev.subscription).toMatchObject({ autoTranslate: true, autoTranslateLanguage: 'es' });
      // Sem idioma no pedido, a sala manda.
      const m = await send(bruno, ch._id, 'Bom dia, idioma da sala');
      expect((await tr(ana, ch._id, [m._id])).language).toBe('es');
      since = at();
      await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslateLanguage', value: '' }, ana);
      ev = await ws.waitFor((e) => ws.events.indexOf(e) >= since && e.type === 'subscription' && e.subscription.rid === ch._id);
      expect(ev.subscription.autoTranslateLanguage).toBeUndefined();
      expect((await tr(ana, ch._id, [m._id])).language).toBe('en');
    } finally {
      ws.close();
      await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslate', value: false }, ana);
    }
    const sub = (await api('GET', 'subscriptions.getOne', { roomId: ch._id }, ana)).subscription;
    expect(sub.autoTranslate).toBeUndefined();

    expect((await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'outro', value: true }, ana)).error).toBe('O parâmetro "field" deve ser autoTranslate ou autoTranslateLanguage.');
    expect((await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslate', value: 'talvez' }, ana)).error).toBe('O parâmetro "value" deve ser verdadeiro ou falso.');
    const xx = await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslateLanguage', value: 'xx' }, ana);
    expect(xx.errorType).toBe('error-translate-language');
    const outsider = await newUser(A);
    const notIn = await api('POST', 'autoTranslate.saveSettings', { roomId: ch._id, field: 'autoTranslate', value: true }, outsider);
    expect(notIn.errorType).toBe('error-user-not-in-room');
    expect(notIn.error).toBe('Você não está nesta sala.');
    // Rocket.Chat: defaultLanguage ao ligar grava o idioma (o código como está no servidor).
    const room = await channel(bruno, [ana]);
    await api('POST', 'autoTranslate.saveSettings', { roomId: room._id, field: 'autoTranslate', value: true, defaultLanguage: 'pt-br' }, ana);
    expect((await api('GET', 'subscriptions.getOne', { roomId: room._id }, ana)).subscription).toMatchObject({ autoTranslate: true, autoTranslateLanguage: 'pt-BR' });
  });

  it('getSupportedLanguages: a lista, o idioma da pessoa e o servidor fora', async () => {
    const r = await api('GET', 'autoTranslate.getSupportedLanguages', { targetLanguage: 'pt' }, ana);
    expect(r.status).toBe(200);
    expect(r.languages.map((l: any) => l.language)).toEqual(['en', 'es', 'pt', 'pt-BR', 'de']);
    expect(r.languages[0]).toEqual({ language: 'en', name: 'English' });
    expect(r.defaultLanguage).toBe('en');
    expect(r.unavailable).toBeUndefined();
    expect((await api('GET', 'autoTranslate.getSupportedLanguages', {}, bruno)).defaultLanguage).toBe('pt-BR');
    __resetLibreForTests();
    F.failNext({ status: 500, body: { error: 'fora' } }, '/languages');
    const down = await api('GET', 'autoTranslate.getSupportedLanguages', {}, ana);
    expect(down.status).toBe(200);
    expect(down).toMatchObject({ languages: [], unavailable: true });
  });

  it('translateMessage (uma mensagem, formato do Rocket.Chat) e resposta de tópico', async () => {
    const root = await send(bruno, ch._id, 'Bom dia, alguém pode ajudar?');
    const reply = await send(bruno, ch._id, 'Bom dia, eu explico no tópico', { tmid: root._id });
    const r = await api('POST', 'autoTranslate.translateMessage', { messageId: reply._id }, ana);
    expect(r.status).toBe(200);
    expect(r.message._id).toBe(reply._id);
    expect(r.message.tmid).toBe(root._id);
    expect(r.message.translations.en).toBe('[pt>en] Bom dia, eu explico no tópico');
    expect((await api('POST', 'autoTranslate.translateMessage', { messageId: 'nao-existe' }, ana)).error).toBe('Mensagem não encontrada.');
    // A resposta do tópico também vem pela sala.
    expect((await tr(carla, ch._id, [reply._id])).translations[0].status).toBe('translated');
    // Mensagem que não é traduzida: translations vazio.
    const thumbs = await send(bruno, ch._id, '👍');
    expect((await api('POST', 'autoTranslate.translateMessage', { messageId: thumbs._id }, ana)).message.translations).toEqual({});
  });

  it('autor excluído: a mensagem continua traduzível', async () => {
    const author = await newUser(A);
    await api('POST', 'channels.invite', { roomId: ch._id, userId: author.userId }, bruno);
    const m = await send(author, ch._id, 'Bom dia, hoje é meu último dia');
    expect((await api('POST', 'users.delete', { userId: author.userId, confirmRelinquish: true }, A)).status).toBe(200);
    expect((await pool.query('SELECT user_id FROM messages WHERE id = $1', [m._id])).rows[0].user_id).toBeNull();
    expect((await tr(ana, ch._id, [m._id])).translations[0].status).toBe('translated');
  });

  it('preferência de idioma: aceita, recusa o inválido e volta ao padrão da empresa', async () => {
    const u = await newUser(A);
    expect((await api('POST', 'users.setPreferences', { data: { language: 'pt-br' } }, u)).status).toBe(200);
    expect((await pool.query('SELECT preferences FROM users WHERE id = $1', [u.userId])).rows[0].preferences.language).toBe('pt-BR');
    const bad = await api('POST', 'users.setPreferences', { data: { language: '<script>' } }, u);
    expect(bad.status).toBe(400);
    expect(bad.error).toBe('Idioma inválido.');
    expect((await api('POST', 'users.setPreferences', { data: { language: 42 } }, u)).error).toBe('Idioma inválido.');
    expect((await api('POST', 'users.setPreferences', { data: { language: '' } }, u)).status).toBe(200);
    expect((await pool.query('SELECT preferences FROM users WHERE id = $1', [u.userId])).rows[0].preferences).not.toHaveProperty('language');
  });

  it('destino que o servidor não tem: 400', async () => {
    F.languages = defaultLanguages(['en', 'es', 'pt', 'pt-BR']);
    const u = await newUser(A);
    await api('POST', 'channels.invite', { roomId: ch._id, userId: u.userId }, bruno);
    await api('POST', 'users.setPreferences', { data: { language: 'de' } }, u);
    const m = await send(bruno, ch._id, 'Bom dia, alguém fala alemão?');
    const r = await tr(u, ch._id, [m._id]);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-translate-language');
    expect(r.error).toBe('Este idioma não está disponível no servidor de tradução.');
  });
});
