import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { pruneMessages } from '../src/services/retention';
import { getSetting, setSettingCache } from '../src/services/settings';
import { storedPath } from '../src/services/uploads';
import { admin, api, connectWs, newUser, raw, startServer, stopServer, type Auth } from './helpers';
import { png, webp } from './sticker-bytes';

// Encaminhar (spec B §12, forward.test.ts).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const send = (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const forward = (auth: Auth, messageId: string, targets: unknown, comment?: string) => api('POST', 'chat.forwardMessage', { messageId, targets, comment }, auth);
const channel = async (owner: Auth, members: Auth[], extraData: Record<string, unknown> = {}) => {
  const r = await api('POST', 'channels.create', { name: name('canal'), members: members.map((m) => m.username), extraData }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.channel._id as string;
};
const group = async (owner: Auth, members: Auth[]) => {
  const r = await api('POST', 'groups.create', { name: name('grupo'), members: members.map((m) => m.username) }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.group._id as string;
};
const messageRow = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
const setPermission = (id: string, roles: string[]) => api('POST', 'permissions.update', { permissions: [{ _id: id, roles }] }, A);
const rolesOf = async (id: string) => (await pool.query('SELECT roles FROM permissions WHERE id = $1', [id])).rows[0].roles as string[];

async function withSettings(values: Record<string, unknown>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, getSetting(k)]));
  const r = await api('POST', 'settings', { settings: values }, A);
  if (!r.success) throw new Error(JSON.stringify(r));
  try {
    await fn();
  } finally {
    await api('POST', 'settings', { settings: before }, A);
  }
}

async function upload(auth: Auth, rid: string, file: Blob, filename: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', file, filename);
  const r = await api('POST', `rooms.upload/${rid}`, fd, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.message;
}

describe('encaminhar', () => {
  let ana: Auth;
  let bruno: Auth;
  let carla: Auth;
  beforeAll(async () => {
    [ana, bruno, carla] = await Promise.all([newUser(A), newUser(A), newUser(A)]);
  });

  it('texto para um canal e por username para uma pessoa; menções só do comentário', async () => {
    const src = await channel(ana, [bruno, carla]);
    const dest = await channel(ana, [bruno, carla]);
    const orig = (await send(ana, src, `veja isso @${carla.username}`)).message;
    const r = await forward(ana, orig._id, [{ rid: dest }, { username: bruno.username }], `olha @${bruno.username}`);
    expect(r.status).toBe(200);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x: any) => x.ok)).toBe(true);
    for (const res of r.results) {
      const m = res.message;
      expect(m.msg).toBe(orig.msg);
      expect(m.forward).toMatchObject({ mid: orig._id, rid: src, t: 'c', u: { _id: ana.userId, username: ana.username }, ts: orig.ts, hops: 1, comment: `olha @${bruno.username}` });
      expect(m.mentions.map((x: any) => x.username)).toEqual([bruno.username]);
      expect(m.u._id).toBe(ana.userId);
    }
    const dm = r.results[1];
    expect((await pool.query('SELECT t FROM rooms WHERE id = $1', [dm.rid])).rows[0].t).toBe('d');
  });

  it('sem forward-message: 403 com o texto em português', async () => {
    const before = await rolesOf('forward-message');
    const src = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'oi')).message;
    await setPermission('forward-message', before.filter((r) => r !== 'user'));
    try {
      const r = await forward(bruno, orig._id, [{ rid: src }]);
      expect(r.status).toBe(403);
      expect(r.error).toBe('Você não tem permissão para encaminhar mensagens.');
    } finally {
      await setPermission('forward-message', before);
    }
  });

  it('origem: grupo privado sem ser membro → 403; canal público sem entrar → permitido', async () => {
    const g = await group(ana, [bruno]);
    const gm = (await send(ana, g, 'segredo')).message;
    const dest = await channel(carla, []);
    const r = await forward(carla, gm._id, [{ rid: dest }]);
    expect(r.status).toBe(403);
    expect(r.error).toBe('Você não tem acesso a esta mensagem.');
    const pub = await channel(ana, [bruno]);
    const pm = (await send(ana, pub, 'aberto')).message;
    const ok = await forward(carla, pm._id, [{ rid: dest }]);
    expect(ok.results[0]).toMatchObject({ ok: true });
  });

  it('a inscrição avisa ao vivo quando a sala vira somente leitura ou é arquivada', async () => {
    const rid = await channel(A, [bruno]);
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      const subEv = (pred: (s: any) => boolean) => ws.waitFor((e) => e.type === 'subscription' && e.action === 'updated' && e.subscription.rid === rid && pred(e.subscription));
      const ro = subEv((x) => x.ro === true);
      expect((await api('POST', 'channels.setReadOnly', { roomId: rid, readOnly: true }, A)).success).toBe(true);
      await ro;
      const arch = subEv((x) => x.archived === true);
      expect((await api('POST', 'channels.archive', { roomId: rid }, A)).success).toBe(true);
      await arch;
    } finally {
      ws.close();
    }
  });

  it('destinos com regras: aviso, somente leitura, arquivada, silenciado; os outros saem', async () => {
    const src = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'conteúdo')).message;
    const avisos = await channel(A, [bruno], { notice: true });
    const ro = await channel(A, [bruno]);
    await pool.query('UPDATE rooms SET ro = true WHERE id = $1', [ro]);
    const arq = await channel(A, [bruno]);
    await api('POST', 'channels.archive', { roomId: arq }, A);
    // A inscrição traz da sala o que decide a linha do Encaminhar sem abrir a sala.
    const subOf = async (rid: string) => (await api('GET', 'subscriptions.getOne', { roomId: rid }, bruno)).subscription;
    expect(await subOf(arq)).toMatchObject({ archived: true });
    expect(await subOf(ro)).toMatchObject({ ro: true });
    expect((await subOf(src)).archived).toBeUndefined();
    const muted = await channel(A, [bruno]);
    expect((await api('POST', 'rooms.muteUser', { roomId: muted, userId: bruno.userId }, A)).success).toBe(true);
    const ok = await channel(A, [bruno]);
    const r = await forward(bruno, orig._id, [{ rid: avisos }, { rid: ro }, { rid: arq }, { rid: muted }, { rid: ok }]);
    expect(r.status).toBe(200);
    const [a, b, c, d, e] = r.results;
    expect(a).toMatchObject({ ok: false, error: 'Este é um canal de avisos: só os publicadores enviam mensagens.' });
    expect(b).toMatchObject({ ok: false, error: 'Esta sala é somente leitura.' });
    expect(c).toMatchObject({ ok: false, errorType: 'error-room-archived' });
    expect(d).toMatchObject({ ok: false, error: 'Você está silenciado nesta sala.' });
    expect(e).toMatchObject({ ok: true, rid: ok });
  });

  it('papel restrito: DM nova entre operadores recusada sem criar sala; DM existente bloqueada; operador → comum ok', async () => {
    const op1 = await newUser(A, { roles: ['operacao'] });
    const op2 = await newUser(A, { roles: ['operacao'] });
    const src = await channel(A, [op1]);
    const orig = (await send(A, src, 'para encaminhar')).message;
    const r = await forward(op1, orig._id, [{ username: op2.username }, { username: ana.username }]);
    expect(r.status).toBe(200);
    expect(r.results[0]).toMatchObject({ ok: false, errorType: 'error-direct-restricted' });
    expect(r.results[0].error).toContain('Use um canal da equipe ou fale com um supervisor.');
    expect(r.results[1]).toMatchObject({ ok: true });
    const key = [op1.userId, op2.userId].sort().join(',');
    expect((await pool.query(`SELECT 1 FROM rooms WHERE t = 'd' AND dm_key = $1`, [key])).rowCount).toBe(0);

    // DM criada antes da restrição: continua bloqueada para encaminhar.
    const u1 = await newUser(A);
    const u2 = await newUser(A);
    const dm = (await api('POST', 'im.create', { username: u2.username }, u1)).room._id;
    const src2 = await channel(A, [u1]);
    const orig2 = (await send(A, src2, 'outra')).message;
    for (const u of [u1, u2]) expect((await api('POST', 'users.update', { userId: u.userId, data: { roles: ['operacao'] } }, A)).success).toBe(true);
    const r2 = await forward(u1, orig2._id, [{ rid: dm }]);
    expect(r2.results[0]).toMatchObject({ ok: false, errorType: 'error-direct-restricted' });
  });

  it('sem create-d: o motivo vem em português', async () => {
    const before = await rolesOf('create-d');
    const src = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'x')).message;
    const fresh = await newUser(A);
    await setPermission('create-d', before.filter((r) => r !== 'user'));
    try {
      const r = await forward(bruno, orig._id, [{ username: fresh.username }]);
      expect(r.results[0]).toMatchObject({ ok: false, error: 'Você não pode iniciar conversas diretas.' });
    } finally {
      await setPermission('create-d', before);
    }
  });

  it('arquivo: cópia com o mesmo storage_path, URL nova; o disco só sai sem referência', async () => {
    const g = await group(ana, [bruno]);
    const dest = await channel(ana, [carla]);
    const img = png({ w: 32, h: 32, seed: 77 });
    const up = await upload(ana, g, new Blob([new Uint8Array(img)], { type: 'image/png' }), 'foto.png', { msg: 'foto' });
    const origUrl = up.attachments[0].title_link as string;
    const r = await forward(ana, up._id, [{ rid: dest }]);
    expect(r.results[0].ok).toBe(true);
    const copy = r.results[0].message;
    const newUrl = copy.attachments[0].title_link as string;
    expect(newUrl).not.toBe(origUrl);
    expect(copy.files[0]._id).not.toBe(up.files[0]._id);
    expect(newUrl).toContain(`/file-upload/${copy.files[0]._id}/`);
    if (copy.attachments[0].image_url) expect(copy.attachments[0].image_url).toContain(copy.files[0]._id);
    const rows = (await pool.query('SELECT id, room_id, user_id, message_id, storage_path FROM files WHERE id = ANY($1)', [[up.files[0]._id, copy.files[0]._id]])).rows;
    const origRow = rows.find((x) => x.id === up.files[0]._id)!;
    const copyRow = rows.find((x) => x.id === copy.files[0]._id)!;
    expect(copyRow).toMatchObject({ room_id: dest, message_id: copy._id, storage_path: origRow.storage_path });
    expect((await raw(newUrl, carla)).status).toBe(200);
    expect((await raw(origUrl, carla)).status).toBe(403);
    // Apagar a original mantém o arquivo no disco; apagar a cópia apaga.
    expect((await api('POST', 'chat.delete', { msgId: up._id, roomId: g }, ana)).status).toBe(200);
    expect(fs.existsSync(storedPath(origRow.storage_path))).toBe(true);
    expect((await raw(newUrl, carla)).status).toBe(200);
    expect((await api('POST', 'chat.delete', { msgId: copy._id, roomId: dest }, ana)).status).toBe(200);
    expect(fs.existsSync(storedPath(origRow.storage_path))).toBe(false);
  });

  it('regras de arquivo no destino: DM sem arquivos e tipo proibido', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const up = await upload(ana, src, new Blob(['texto'], { type: 'text/plain' }), 'nota.txt');
    await withSettings({ FileUpload_Enabled_Direct: false }, async () => {
      const r = await forward(ana, up._id, [{ username: bruno.username }]);
      expect(r.results[0]).toMatchObject({ ok: false, error: 'Arquivos não podem ser enviados em mensagens diretas.' });
    });
    await withSettings({ FileUpload_MediaTypeBlackList: 'text/plain' }, async () => {
      const r = await forward(ana, up._id, [{ rid: dest }]);
      expect(r.results[0]).toMatchObject({ ok: false, error: 'Tipo de arquivo não permitido.' });
    });
  });

  it('@usuário recusado: nenhuma conversa direta nova e vazia fica para trás', async () => {
    const src = await channel(ana, [bruno]);
    const up = await upload(ana, src, new Blob(['texto'], { type: 'text/plain' }), 'nota.txt');
    const text = (await send(ana, src, 'só texto')).message;
    const dmRows = async (u: Auth) => (await pool.query(`SELECT 1 FROM rooms WHERE t = 'd' AND dm_key = $1`, [[ana.userId, u.userId].sort().join(',')])).rowCount;
    const fresh = await newUser(A);
    await withSettings({ FileUpload_Enabled_Direct: false }, async () => {
      const r = await forward(ana, up._id, [{ username: fresh.username }]);
      expect(r.results[0]).toMatchObject({ ok: false, error: 'Arquivos não podem ser enviados em mensagens diretas.' });
    });
    expect(await dmRows(fresh)).toBe(0);
    const off = await newUser(A);
    expect((await api('POST', 'users.setActiveStatus', { userId: off.userId, activeStatus: false }, A)).status).toBe(200);
    const r2 = await forward(ana, text._id, [{ username: off.username }]);
    expect(r2.results[0]).toMatchObject({ ok: false, error: 'Este usuário está desativado.' });
    expect(await dmRows(off)).toBe(0);
    // O mesmo destino, sem o arquivo, sai normalmente (e aí a conversa existe).
    expect((await forward(ana, text._id, [{ username: fresh.username }])).results[0]).toMatchObject({ ok: true });
    expect(await dmRows(fresh)).toBe(1);
  });

  it('destino de que não é membro: a resposta não conta nada da sala (DM, arquivos)', async () => {
    const src = await channel(ana, [bruno, carla]);
    const up = await upload(ana, src, new Blob(['texto'], { type: 'text/plain' }), 'nota.txt');
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
    await withSettings({ FileUpload_Enabled_Direct: false }, async () => {
      const r = await forward(carla, up._id, [{ rid: dm }]);
      expect(r.results[0]).toMatchObject({ ok: false, error: 'Você precisa entrar na sala para enviar mensagens.' });
    });
  });

  it('limites: figurinha encaminhada conta no das figurinhas; destinos por minuto com o limitador da API', async () => {
    const dona = await newUser(A);
    const quem = await newUser(A);
    const pack = (await api('POST', 'stickers.packs.create', { scope: 'personal', name: 'limite' }, dona)).pack._id;
    const fd = new FormData();
    fd.append('packId', pack);
    fd.append('file', new Blob([new Uint8Array(webp({ kind: 'vp8l', w: 256, h: 256, seed: 9922 }))], { type: 'application/octet-stream' }), 'f.bin');
    const st = (await api('POST', 'stickers.create', fd, dona)).sticker;
    expect(st).toBeTruthy();
    const src = await channel(dona, [quem]);
    const sticker = (await api('POST', 'chat.sendSticker', { roomId: src, stickerId: st._id }, dona)).message;
    const dests: string[] = [];
    for (let i = 0; i < 10; i++) dests.push(await channel(quem, []));
    const all = dests.map((rid) => ({ rid }));
    const r = await forward(quem, sticker._id, all);
    expect(r.results.slice(0, 8).every((x: any) => x.ok)).toBe(true);
    expect(r.results.slice(8)).toMatchObject([
      { ok: false, error: 'Muitas figurinhas seguidas. Espere alguns segundos.' },
      { ok: false, error: 'Muitas figurinhas seguidas. Espere alguns segundos.' },
    ]);
    // Pelo seletor, na mesma janela, também já não vai.
    expect((await api('POST', 'chat.sendSticker', { roomId: src, fileId: sticker.sticker.fileId }, quem)).status).toBe(429);

    const text = (await send(quem, dests[0], 'várias vezes')).message;
    const before = getSetting('API_Enable_Rate_Limiter');
    setSettingCache('API_Enable_Rate_Limiter', true);
    try {
      // 60 destinos por minuto: 6 chamadas de 10 saem, a sétima não.
      for (let i = 0; i < 6; i++) expect((await forward(quem, text._id, all)).results.every((x: any) => x.ok)).toBe(true);
      const over = await forward(quem, text._id, all);
      expect(over.status).toBe(200);
      expect(over.results.every((x: any) => !x.ok && x.error === 'Muitos encaminhamentos seguidos. Espere um minuto e tente de novo.')).toBe(true);
    } finally {
      setSettingCache('API_Enable_Rate_Limiter', before);
    }
  });

  it('voz e vídeo: os campos vão iguais na cópia', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const voice = await upload(ana, src, new Blob(['opus'], { type: 'audio/webm' }), 'Mensagem de voz.webm', { voice: '1', duration: '7.5', waveform: '0,50,100' });
    const video = await upload(ana, src, new Blob(['webm'], { type: 'video/webm' }), 'Mensagem de vídeo.webm', { video: '1', duration: '3.2' });
    const r = await forward(ana, voice._id, [{ rid: dest }]);
    const v = r.results[0].message.attachments[0];
    expect(v).toMatchObject({ voice: true, audio_duration: 7.5, audio_waveform: [0, 50, 100] });
    expect(r.results[0].message.files[0]).toMatchObject({ voice: true, duration: 7.5 });
    const r2 = await forward(ana, video._id, [{ rid: dest }]);
    expect(r2.results[0].message.attachments[0]).toMatchObject({ video_message: true, video_duration: 3.2 });
    expect(r2.results[0].message.files[0]).toMatchObject({ video: true, duration: 3.2 });
  });

  it('figurinha pessoal de outra pessoa: fotografia igual; canal de avisos recusa; remoção atinge a cópia', async () => {
    const pack = (await api('POST', 'stickers.packs.create', { scope: 'personal', name: 'minhas' }, ana)).pack._id;
    const fd = new FormData();
    fd.append('packId', pack);
    fd.append('file', new Blob([new Uint8Array(webp({ kind: 'vp8l', w: 256, h: 256, seed: 9911 }))], { type: 'application/octet-stream' }), 'f.bin');
    const st = (await api('POST', 'stickers.create', fd, ana)).sticker;
    expect(st).toBeTruthy();
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const sent = (await api('POST', 'chat.sendSticker', { roomId: src, stickerId: st._id }, ana)).message;
    const r = await forward(bruno, sent._id, [{ rid: dest }]);
    expect(r.results[0]).toMatchObject({ ok: true });
    const copy = r.results[0].message;
    expect(copy.sticker).toEqual(sent.sticker);
    expect((await messageRow(copy._id)).sticker_file_id).toBe(sent.sticker.fileId);

    const avisos = await channel(A, [bruno], { notice: true });
    await api('POST', 'channels.addPublisher', { roomId: avisos, userId: bruno.userId }, A);
    await withSettings({ Stickers_In_Notice_Rooms: false }, async () => {
      const r2 = await forward(bruno, sent._id, [{ rid: avisos }]);
      expect(r2.results[0]).toMatchObject({ ok: false, error: 'Figurinhas não são permitidas em canais de avisos.' });
    });

    const rm = await api('POST', 'stickers.removeEverywhere', { fileId: sent.sticker.fileId, reason: 'teste' }, A);
    expect(rm.status).toBe(200);
    expect((await messageRow(copy._id)).extra.sticker).toMatchObject({ fileId: sent.sticker.fileId, removed: true });
    const again = await forward(bruno, copy._id, [{ rid: src }]);
    expect(again.status).toBe(400);
  });

  it('encaminhar uma encaminhada: origem igual, hops 2, sem o comentário anterior', async () => {
    const src = await channel(ana, [bruno]);
    const d1 = await channel(ana, [bruno]);
    const d2 = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'primeira')).message;
    const f1 = (await forward(ana, orig._id, [{ rid: d1 }], 'comentário 1')).results[0].message;
    const f2 = (await forward(bruno, f1._id, [{ rid: d2 }])).results[0].message;
    expect(f2.forward).toMatchObject({ mid: orig._id, rid: src, u: { _id: ana.userId }, hops: 2 });
    expect(f2.forward.comment).toBeUndefined();
    expect(f2.msg).toBe('primeira');
  });

  it('roomName só para canal público', async () => {
    const dest = await channel(ana, [bruno]);
    const pub = await channel(ana, [bruno]);
    const pubName = (await pool.query('SELECT name FROM rooms WHERE id = $1', [pub])).rows[0].name;
    const pm = (await send(ana, pub, 'a')).message;
    expect((await forward(ana, pm._id, [{ rid: dest }])).results[0].message.forward.roomName).toBe(pubName);
    const g = await group(ana, [bruno]);
    const gm = (await send(ana, g, 'b')).message;
    expect((await forward(ana, gm._id, [{ rid: dest }])).results[0].message.forward.roomName).toBeUndefined();
    const team = await api('POST', 'teams.create', { name: name('time'), type: 1, members: [bruno.username] }, ana);
    const tc = await api('POST', 'teams.createRoom', { teamId: team.team._id, name: name('tc'), type: 'c' }, ana);
    const tcid = (tc.room ?? tc.channel)._id;
    const tm = (await send(ana, tcid, 'c')).message;
    expect((await forward(ana, tm._id, [{ rid: dest }])).results[0].message.forward.roomName).toBeUndefined();
    const dm = (await api('POST', 'im.create', { username: bruno.username }, ana)).room._id;
    const dmm = (await send(ana, dm, 'd')).message;
    const fd = (await forward(ana, dmm._id, [{ rid: dest }])).results[0].message.forward;
    expect(fd.roomName).toBeUndefined();
    expect(fd.t).toBe('d');
  });

  it('sala criptografada: origem e destino recusados (grupo privado)', async () => {
    const g = await group(ana, [bruno]);
    const gm = (await send(ana, g, 'antes')).message;
    const dest = await channel(ana, [bruno]);
    await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [g]);
    try {
      const r = await forward(ana, gm._id, [{ rid: dest }]);
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-forward-encrypted');
      const pub = await channel(ana, [bruno]);
      const pm = (await send(ana, pub, 'aberto')).message;
      const r2 = await forward(ana, pm._id, [{ rid: g }]);
      expect(r2.results[0]).toMatchObject({ ok: false, errorType: 'error-forward-encrypted-target' });
      // Quem não é do grupo não fica sabendo que ele é criptografado.
      const r3 = await forward(carla, pm._id, [{ rid: g }]);
      expect(r3.results[0]).toMatchObject({ ok: false, error: 'Você precisa entrar na sala para enviar mensagens.' });
    } finally {
      await pool.query('UPDATE rooms SET encrypted = false WHERE id = $1', [g]);
    }
  });

  it('não encaminháveis: sistema, enquete, rm', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    await api('POST', 'channels.invite', { roomId: src, userId: carla.userId }, ana);
    const sys = (await pool.query(`SELECT id FROM messages WHERE room_id = $1 AND t IS NOT NULL LIMIT 1`, [src])).rows[0];
    expect(sys).toBeTruthy();
    expect((await forward(ana, sys.id, [{ rid: dest }])).error).toBe('Este tipo de mensagem não pode ser encaminhado.');
    const poll = await api('POST', 'polls.create', { rid: src, question: 'Pizza?', options: ['Sim', 'Não'] }, ana);
    expect(poll.status).toBe(200);
    expect((await forward(ana, poll.message._id, [{ rid: dest }])).error).toBe('Este tipo de mensagem não pode ser encaminhado.');
    const root = (await send(ana, src, 'raiz')).message;
    await send(bruno, src, 'resposta', { tmid: root._id });
    await api('POST', 'chat.delete', { msgId: root._id, roomId: src }, ana);
    expect((await messageRow(root._id)).t).toBe('rm');
    expect((await forward(ana, root._id, [{ rid: dest }])).error).toBe('Este tipo de mensagem não pode ser encaminhado.');
  });

  it('0 ou 11 destinos → 400; repetidos viram um só', async () => {
    const src = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'oi')).message;
    expect((await forward(ana, orig._id, [])).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => ({ username: `ninguem${i}` }));
    expect((await forward(ana, orig._id, many)).status).toBe(400);
    expect((await forward(ana, orig._id, 'x')).error).toBe('Parâmetros inválidos.');
    const dest = await channel(ana, [bruno]);
    const r = await forward(ana, orig._id, [{ rid: dest }, { rid: dest }, { username: bruno.username }, { username: bruno.username.toUpperCase() }]);
    expect(r.results).toHaveLength(2);
    const n = (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE extra->'forward'->>'mid' = $1`, [orig._id])).rows[0].n;
    expect(n).toBe(2);
  });

  it('encaminhada não é editável', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'oi')).message;
    const f = (await forward(ana, orig._id, [{ rid: dest }], 'comentário')).results[0].message;
    const r = await api('POST', 'chat.update', { roomId: dest, msgId: f._id, text: 'mudei' }, ana);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Mensagens encaminhadas não podem ser editadas.');
  });

  it('prévia no destino: ↪ sem comentário; o comentário quando há', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const orig = (await send(ana, src, 'texto original')).message;
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      await forward(ana, orig._id, [{ rid: dest }]);
      const lm = (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [dest])).rows[0].last_message;
      expect(lm.msg).toBe('↪ texto original');
      await forward(ana, orig._id, [{ rid: dest }], 'veja só');
      const lm2 = (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [dest])).rows[0].last_message;
      expect(lm2.msg).toBe('veja só');
      // Bruno recebe a notificação da DM com a prévia encaminhada.
      await forward(ana, orig._id, [{ username: bruno.username }]);
      const n = await ws.waitFor((e) => e.type === 'notification' && e.text?.includes('↪ texto original'));
      expect(n.text).toBe('↪ texto original');
    } finally {
      ws.close();
    }
  });

  it('retenção: podar a origem mantém o arquivo da cópia; filesOnly no destino só marca a cópia', async () => {
    const src = await channel(ana, [bruno]);
    const dest = await channel(ana, [bruno]);
    const up = await upload(ana, src, new Blob(['conteúdo'], { type: 'text/plain' }), 'ret.txt');
    const copy = (await forward(ana, up._id, [{ rid: dest }])).results[0].message;
    const path = (await pool.query('SELECT storage_path FROM files WHERE id = $1', [up.files[0]._id])).rows[0].storage_path;
    await pruneMessages(src, { latest: new Date(Date.now() + 60_000).toISOString(), oldest: new Date(0).toISOString() });
    expect(await messageRow(up._id)).toBeUndefined();
    expect(fs.existsSync(storedPath(path))).toBe(true);
    expect((await raw(copy.attachments[0].title_link, bruno)).status).toBe(200);
    await pruneMessages(dest, { latest: new Date(Date.now() + 60_000).toISOString(), oldest: new Date(0).toISOString(), filesOnly: true });
    expect((await messageRow(copy._id)).attachments).toEqual([{ text: 'Arquivo removido pela política de retenção' }]);
    expect(fs.existsSync(storedPath(path))).toBe(false);
  });
});
