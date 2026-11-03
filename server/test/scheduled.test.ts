import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { newId } from '../src/lib/ids';
import { sendDueScheduled } from '../src/services/scheduled';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

// Envios agendados (spec B §12, scheduled.test.ts).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const schedule = (auth: Auth, message: Record<string, unknown>, sendAt = inMinutes(10)) => api('POST', 'chat.scheduleMessage', { message, sendAt }, auth);
const list = async (auth: Auth, roomId?: string) => (await api('GET', 'chat.getScheduledMessages', roomId ? { roomId } : undefined, auth)).scheduled as any[];
const makeDue = (id: string) => pool.query(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [id]);
const row = async (id: string) => (await pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [id])).rows[0];
const setPermission = (id: string, roles: string[]) => api('POST', 'permissions.update', { permissions: [{ _id: id, roles }] }, A);
const rolesOf = async (id: string) => (await pool.query('SELECT roles FROM permissions WHERE id = $1', [id])).rows[0].roles as string[];
const channel = async (owner: Auth, members: Auth[], extraData: Record<string, unknown> = {}) => {
  const r = await api('POST', 'channels.create', { name: name('agenda'), members: members.map((m) => m.username), extraData }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.channel._id as string;
};

describe('envios agendados', () => {
  let ana: Auth;
  let bruno: Auth;
  beforeAll(async () => {
    [ana, bruno] = await Promise.all([newUser(A), newUser(A)]);
  });

  it('agenda, lista só para a pessoa e envia no horário como o autor, com o mesmo id', async () => {
    const rid = await channel(ana, [bruno]);
    const r = await schedule(ana, { rid, msg: `bom dia @${bruno.username}` });
    expect(r.status).toBe(200);
    expect(r.scheduled).toMatchObject({ rid, msg: `bom dia @${bruno.username}`, status: 'pending', error: null, tmid: null });
    expect((await list(ana, rid)).map((s) => s._id)).toEqual([r.scheduled._id]);
    expect(await list(bruno, rid)).toEqual([]);
    expect((await list(A)).find((s) => s._id === r.scheduled._id)).toBeUndefined();
    const wsAna = connectWs(ana);
    const wsBruno = connectWs(bruno);
    await Promise.all([wsAna.ready, wsBruno.ready]);
    try {
      await makeDue(r.scheduled._id);
      expect(await sendDueScheduled()).toBeGreaterThanOrEqual(1);
      const msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [r.scheduled._id])).rows[0];
      expect(msg).toMatchObject({ room_id: rid, user_id: ana.userId, msg: `bom dia @${bruno.username}` });
      expect(await row(r.scheduled._id)).toBeUndefined();
      const ev = await wsAna.waitFor((e) => e.type === 'message.scheduled' && e.action === 'removed' && e.scheduled._id === r.scheduled._id);
      expect(ev.messageId).toBe(r.scheduled._id);
      await wsBruno.waitFor((e) => e.type === 'notification' && e.messageId === r.scheduled._id);
    } finally {
      wsAna.close();
      wsBruno.close();
    }
  });

  it('publicador agenda aviso com "Ciente"; leitor confirma', async () => {
    const avisos = await channel(A, [ana, bruno], { notice: true, noticeAck: true });
    await pool.query('UPDATE rooms SET notice_ack = true WHERE id = $1', [avisos]);
    await api('POST', 'channels.addPublisher', { roomId: avisos, userId: bruno.userId }, A);
    const r = await schedule(bruno, { rid: avisos, msg: 'Reunião às 15h', ackRequired: true });
    expect(r.status).toBe(200);
    expect(r.scheduled.ackRequired).toBe(true);
    await makeDue(r.scheduled._id);
    await sendDueScheduled();
    const msg = (await api('GET', 'chat.getMessage', { msgId: r.scheduled._id }, ana)).message;
    expect(msg.ackRequired).toBe(true);
    expect((await api('POST', 'chat.ack', { messageId: r.scheduled._id }, ana)).status).toBe(200);
  });

  it('validações ao agendar', async () => {
    const rid = await channel(ana, [bruno]);
    const err = async (message: Record<string, unknown>, sendAt?: string) => (await schedule(ana, { rid, ...message }, sendAt)).error;
    expect(await err({ msg: '   ' })).toBe('Mensagem vazia.');
    expect(await err({ msg: 'x'.repeat(6000) })).toMatch(/A mensagem excede \d+ caracteres\./);
    expect(await err({ msg: '/me acena' })).toBe('Comandos não podem ser agendados.');
    expect(await err({ msg: 'oi' }, new Date(Date.now() + 10_000).toISOString())).toBe('Escolha um horário entre 1 minuto e 1 ano a partir de agora.');
    expect(await err({ msg: 'oi' }, inMinutes(367 * 24 * 60))).toBe('Escolha um horário entre 1 minuto e 1 ano a partir de agora.');
    expect(await err({ msg: 'oi', ackRequired: true })).toBe('Só avisos de um canal de avisos com “Ciente” ativado podem pedir confirmação.');
    const mentionAll = await rolesOf('mention-all');
    await setPermission('mention-all', mentionAll.filter((r) => r !== 'user'));
    try {
      expect((await schedule(bruno, { rid, msg: '@all atenção' })).error).toBe('Sem permissão para mencionar @all.');
    } finally {
      await setPermission('mention-all', mentionAll);
    }
    expect(await err({ msg: 'oi', tmid: 'naoexiste123' })).toBe('Thread inválida.');
    const g = (await api('POST', 'groups.create', { name: name('cifra'), members: [bruno.username] }, ana)).group._id;
    await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [g]);
    expect((await schedule(ana, { rid: g, msg: 'oi' })).error).toBe('Não dá para agendar mensagens em salas criptografadas.');
    const before = await rolesOf('schedule-message');
    await setPermission('schedule-message', before.filter((r) => r !== 'user'));
    try {
      expect((await schedule(bruno, { rid, msg: 'oi' })).error).toBe('Você não tem permissão para agendar mensagens nesta sala.');
      expect((await schedule(ana, { rid, msg: 'a dona da sala pode' })).status).toBe(200);
    } finally {
      await setPermission('schedule-message', before);
    }
    // Resposta de resposta vira a raiz.
    const root = (await api('POST', 'chat.sendMessage', { message: { rid, msg: 'raiz' } }, ana)).message;
    const reply = (await api('POST', 'chat.sendMessage', { message: { rid, msg: 'resp', tmid: root._id } }, bruno)).message;
    const t = await schedule(ana, { rid, msg: 'no tópico', tmid: reply._id, tshow: true });
    expect(t.scheduled).toMatchObject({ tmid: root._id, tshow: true });

    const u = await newUser(A);
    const r2 = await channel(u, []);
    const values = Array.from({ length: 100 }, (_, i) => `('s${i}x${u.userId}', '${r2}', '${u.userId}', 'm${i}', now() + interval '1 day')`);
    await pool.query(`INSERT INTO scheduled_messages (id, room_id, user_id, msg, send_at) VALUES ${values.join(',')}`);
    expect((await schedule(u, { rid: r2, msg: 'mais uma' })).error).toBe('Você já tem 100 mensagens agendadas.');
  });

  describe('reconfere no envio', () => {
    async function failsWith(auth: Auth, rid: string, change: () => Promise<unknown>, text: string, extra: Record<string, unknown> = {}) {
      const s = (await schedule(auth, { rid, msg: 'agendada', ...extra })).scheduled;
      expect(s).toBeTruthy();
      await change();
      await makeDue(s._id);
      const ws = connectWs(auth);
      await ws.ready;
      try {
        await sendDueScheduled();
        const ev = await ws.waitFor((e) => e.type === 'message.scheduled' && e.action === 'upserted' && e.scheduled._id === s._id && e.scheduled.status === 'failed');
        expect(ev.scheduled.error).toBe(text);
        expect(ev.notify).toBe(true);
      } finally {
        ws.close();
      }
      expect((await row(s._id)).status).toBe('failed');
      expect((await pool.query('SELECT 1 FROM messages WHERE id = $1', [s._id])).rowCount).toBe(0);
      return s;
    }

    it('silenciado, somente leitura, desativado, sem permissão, "Ciente" desligado, DM restrita', async () => {
      const rid = await channel(A, [ana, bruno]);
      await failsWith(bruno, rid, () => api('POST', 'rooms.muteUser', { roomId: rid, userId: bruno.userId }, A), 'Você está silenciado nesta sala.');
      await api('POST', 'rooms.unmuteUser', { roomId: rid, userId: bruno.userId }, A);

      const ro = await channel(A, [ana]);
      await failsWith(ana, ro, () => pool.query('UPDATE rooms SET ro = true WHERE id = $1', [ro]), 'Esta sala é somente leitura.');

      const u = await newUser(A);
      const r3 = await channel(A, [u]);
      const s = (await schedule(u, { rid: r3, msg: 'antes de desativar' })).scheduled;
      await api('POST', 'users.setActiveStatus', { userId: u.userId, activeStatus: false }, A);
      await makeDue(s._id);
      await sendDueScheduled();
      expect(await row(s._id)).toMatchObject({ status: 'failed', error: 'A conta de quem agendou está desativada.' });

      const before = await rolesOf('schedule-message');
      try {
        await failsWith(ana, rid, () => setPermission('schedule-message', before.filter((r) => r !== 'user')), 'Você não tem mais permissão para agendar mensagens nesta sala.');
      } finally {
        await setPermission('schedule-message', before);
      }

      const avisos = await channel(A, [bruno], { notice: true });
      await pool.query('UPDATE rooms SET notice_ack = true WHERE id = $1', [avisos]);
      await api('POST', 'channels.addPublisher', { roomId: avisos, userId: bruno.userId }, A);
      await failsWith(bruno, avisos, () => pool.query('UPDATE rooms SET notice_ack = false WHERE id = $1', [avisos]), 'Só avisos de um canal de avisos com “Ciente” ativado podem pedir confirmação.', { ackRequired: true });

      const u1 = await newUser(A);
      const u2 = await newUser(A);
      const dm = (await api('POST', 'im.create', { username: u2.username }, u1)).room._id;
      const s2 = (await schedule(u1, { rid: dm, msg: 'oi' })).scheduled;
      for (const x of [u1, u2]) await api('POST', 'users.update', { userId: x.userId, data: { roles: ['user', 'operacao'] } }, A);
      await makeDue(s2._id);
      await sendDueScheduled();
      const failed = await row(s2._id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('estão bloqueadas pela política da empresa');
    });
  });

  it('sair da sala apaga as agendadas dela e avisa', async () => {
    const rid = await channel(A, [ana]);
    const s = (await schedule(ana, { rid, msg: 'vou sair' })).scheduled;
    const ws = connectWs(ana);
    await ws.ready;
    try {
      expect((await api('POST', 'channels.leave', { roomId: rid }, ana)).status).toBe(200);
      await ws.waitFor((e) => e.type === 'message.scheduled' && e.action === 'removed' && e.scheduled._id === s._id);
      expect(await row(s._id)).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it('editar, cancelar, enviar agora: dono, "enviando" e falha editada', async () => {
    const rid = await channel(ana, [bruno]);
    const s = (await schedule(ana, { rid, msg: 'primeiro texto' })).scheduled;
    expect((await api('POST', 'chat.updateScheduledMessage', { scheduledId: s._id, msg: 'x' }, bruno)).status).toBe(404);
    expect((await api('POST', 'chat.cancelScheduledMessage', { scheduledId: s._id }, bruno)).status).toBe(404);
    expect((await api('POST', 'chat.sendScheduledMessageNow', { scheduledId: s._id }, bruno)).status).toBe(404);
    const ed = await api('POST', 'chat.updateScheduledMessage', { scheduledId: s._id, msg: 'texto novo', sendAt: inMinutes(30) }, ana);
    expect(ed.scheduled).toMatchObject({ msg: 'texto novo', status: 'pending' });

    await pool.query(`UPDATE scheduled_messages SET status = 'sending', claimed_at = now() WHERE id = $1`, [s._id]);
    for (const path of ['chat.updateScheduledMessage', 'chat.cancelScheduledMessage', 'chat.sendScheduledMessageNow']) {
      const r = await api('POST', path, { scheduledId: s._id, msg: 'y' }, ana);
      expect(r.status).toBe(409);
      expect(r.error).toBe('Esta mensagem já está sendo enviada.');
    }

    await pool.query(`UPDATE scheduled_messages SET status = 'failed', error = 'falhou', attempts = 2, claimed_at = NULL WHERE id = $1`, [s._id]);
    const fixed = await api('POST', 'chat.updateScheduledMessage', { scheduledId: s._id, msg: 'corrigida' }, ana);
    expect(fixed.scheduled).toMatchObject({ status: 'pending', error: null, msg: 'corrigida' });
    expect((await row(s._id)).attempts).toBe(0);

    const now = await api('POST', 'chat.sendScheduledMessageNow', { scheduledId: s._id }, ana);
    expect(now.status).toBe(200);
    expect(now.message).toMatchObject({ _id: s._id, msg: 'corrigida' });
    expect(await row(s._id)).toBeUndefined();

    const s2 = (await schedule(ana, { rid, msg: 'cancelar' })).scheduled;
    expect((await api('POST', 'chat.cancelScheduledMessage', { scheduledId: s2._id }, ana)).status).toBe(200);
    expect(await row(s2._id)).toBeUndefined();

    // Enviar agora com erro: volta para quem pediu e fica gravado.
    const s3 = (await schedule(ana, { rid, msg: 'silenciada' })).scheduled;
    await api('POST', 'rooms.muteUser', { roomId: rid, userId: ana.userId }, A);
    const fail = await api('POST', 'chat.sendScheduledMessageNow', { scheduledId: s3._id }, ana);
    expect(fail.status).toBe(403);
    expect(fail.error).toBe('Você está silenciado nesta sala.');
    expect(await row(s3._id)).toMatchObject({ status: 'failed', error: 'Você está silenciado nesta sala.' });
    await api('POST', 'rooms.unmuteUser', { roomId: rid, userId: ana.userId }, A);
    expect((await api('POST', 'chat.sendScheduledMessageNow', { scheduledId: s3._id }, ana)).status).toBe(200);
  });

  it('envio interrompido: com a mensagem só apaga a linha; sem ela volta e sai uma vez', async () => {
    const rid = await channel(ana, [bruno]);
    const s = (await schedule(ana, { rid, msg: 'interrompida' })).scheduled;
    await api('POST', 'chat.sendMessage', { message: { _id: s._id, rid, msg: 'interrompida' } }, ana);
    await pool.query(`UPDATE scheduled_messages SET status = 'sending', claimed_at = now() - interval '10 minutes', send_at = now() - interval '10 minutes' WHERE id = $1`, [s._id]);
    await sendDueScheduled();
    expect(await row(s._id)).toBeUndefined();
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND msg = $2', [rid, 'interrompida'])).rows[0].n).toBe(1);

    const s2 = (await schedule(ana, { rid, msg: 'sem mensagem' })).scheduled;
    await pool.query(`UPDATE scheduled_messages SET status = 'sending', attempts = 1, claimed_at = now() - interval '10 minutes', send_at = now() - interval '10 minutes' WHERE id = $1`, [s2._id]);
    await sendDueScheduled();
    expect((await pool.query('SELECT count(*)::int AS n FROM messages WHERE id = $1', [s2._id])).rows[0].n).toBe(1);
    expect(await row(s2._id)).toBeUndefined();
  });

  it('atraso de 2 h: falha e avisa', async () => {
    const rid = await channel(ana, []);
    const s = (await schedule(ana, { rid, msg: 'atrasada' })).scheduled;
    await pool.query(`UPDATE scheduled_messages SET send_at = now() - interval '2 hours' WHERE id = $1`, [s._id]);
    await sendDueScheduled();
    expect(await row(s._id)).toMatchObject({ status: 'failed', error: 'O horário passou com o servidor fora do ar. Confira a mensagem e envie de novo.' });
    // Editar sem horário novo não serve (o guardado já passou).
    expect((await api('POST', 'chat.updateScheduledMessage', { scheduledId: s._id, msg: 'nova' }, ana)).status).toBe(400);
    // Enviar agora vale (a própria pessoa conferiu).
    expect((await api('POST', 'chat.sendScheduledMessageNow', { scheduledId: s._id }, ana)).status).toBe(200);
  });

  it('dois ciclos em paralelo: uma mensagem só', async () => {
    const rid = await channel(ana, []);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await schedule(ana, { rid, msg: `paralela ${i}` })).scheduled._id);
    await pool.query(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = ANY($1)`, [ids]);
    await Promise.all([sendDueScheduled(), sendDueScheduled(), sendDueScheduled()]);
    const n = (await pool.query('SELECT count(*)::int AS n FROM messages WHERE id = ANY($1)', [ids])).rows[0].n;
    expect(n).toBe(5);
    const all = (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND msg LIKE 'paralela %'`, [rid])).rows[0].n;
    expect(all).toBe(5);
    expect(newId()).toBeTruthy();
  });
});
