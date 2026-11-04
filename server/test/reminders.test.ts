import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import * as push from '../src/services/push';
import { fireDueReminders, REMINDER_HIDDEN_TEXT } from '../src/services/reminders';
import { getSetting } from '../src/services/settings';
import { admin, api, connectWs, newUser, startServer, stopServer, type Auth } from './helpers';

// "Lembrar-me" (spec B §12, reminders.test.ts).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const send = (auth: Auth, rid: string, msg: string) => api('POST', 'chat.sendMessage', { message: { rid, msg } }, auth);
const set = (auth: Auth, messageId: string, remindAt: string) => api('POST', 'reminders.set', { messageId, remindAt }, auth);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const AHEAD = 'Escolha um horário entre 1 minuto e 1 ano a partir de agora.';
const due = (id: string) => pool.query(`UPDATE message_reminders SET remind_at = now() - interval '1 second' WHERE id = $1`, [id]);

describe('lembretes', () => {
  let ana: Auth;
  let bruno: Auth;
  let geral: string;
  beforeAll(async () => {
    [ana, bruno] = await Promise.all([newUser(A), newUser(A)]);
    geral = (await api('POST', 'channels.create', { name: name('geral'), members: [ana.username, bruno.username] }, A)).channel._id;
  });

  it('marca, lista e troca o horário (uma linha só)', async () => {
    const m = (await send(bruno, geral, 'lembra disso')).message;
    const r = await set(ana, m._id, inMinutes(20));
    expect(r.status).toBe(200);
    expect(r.reminder).toMatchObject({ messageId: m._id, rid: geral, t: 'c', firedAt: null });
    expect(r.reminder.message.msg).toBe('lembra disso');
    const list = await api('GET', 'reminders.list', undefined, ana);
    expect(list.reminders.map((x: any) => x.messageId)).toContain(m._id);
    expect(list.reminders.find((x: any) => x.messageId === m._id).message.msg).toBe('lembra disso');
    const later = inMinutes(90);
    const again = await set(ana, m._id, later);
    expect(again.reminder._id).toBe(r.reminder._id);
    expect(new Date(again.reminder.remindAt).getTime()).toBe(new Date(later).getTime());
    expect((await pool.query('SELECT count(*)::int AS n FROM message_reminders WHERE user_id = $1 AND message_id = $2', [ana.userId, m._id])).rows[0].n).toBe(1);
    // Ninguém mais vê (nem o administrador).
    expect((await api('GET', 'reminders.list', undefined, A)).reminders.find((x: any) => x.messageId === m._id)).toBeUndefined();
  });

  it('validações: horário, acesso, mensagem de sistema, limite', async () => {
    const m = (await send(bruno, geral, 'msg')).message;
    expect((await set(ana, m._id, new Date(Date.now() - 1000).toISOString())).error).toBe(AHEAD);
    expect((await set(ana, m._id, inMinutes(366 * 24 * 60))).error).toBe(AHEAD);
    const g = (await api('POST', 'groups.create', { name: name('g') }, bruno)).group._id;
    const gm = (await send(bruno, g, 'segredo')).message;
    const no = await set(ana, gm._id, inMinutes(10));
    expect(no.status).toBe(403);
    expect(no.error).toBe('Você não tem acesso a esta mensagem.');
    await api('POST', 'channels.invite', { roomId: geral, userId: (await newUser(A)).userId }, A);
    const sys = (await pool.query(`SELECT id FROM messages WHERE room_id = $1 AND t IS NOT NULL LIMIT 1`, [geral])).rows[0];
    const sr = await set(ana, sys.id, inMinutes(10));
    expect(sr.status).toBe(400);
    expect(sr.error).toBe('Não dá para pôr lembrete nesta mensagem.');

    const u = await newUser(A);
    const rid = (await api('POST', 'channels.create', { name: name('muitos'), members: [u.username] }, A)).channel._id;
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) ids.push((await send(A, rid, `m${i}`)).message._id);
    const values = ids.slice(0, 200).map((id, i) => `('r${i}x${u.userId}', '${u.userId}', '${id}', '${rid}', now() + interval '1 day')`);
    await pool.query(`INSERT INTO message_reminders (id, user_id, message_id, room_id, remind_at) VALUES ${values.join(',')}`);
    const over = await set(u, ids[200], inMinutes(10));
    expect(over.status).toBe(400);
    expect(over.error).toBe('Você já tem 200 lembretes. Conclua alguns antes de criar outro.');
    // Trocar o horário de um que já existe continua valendo.
    expect((await set(u, ids[0], inMinutes(10))).status).toBe(200);
  });

  it('limite por pessoa com pedidos em paralelo: nunca passa de 200; trocar o horário continua valendo', async () => {
    const u = await newUser(A);
    const rid = (await api('POST', 'channels.create', { name: name('paralelo'), members: [u.username] }, A)).channel._id;
    const ids = (
      await pool.query(
        `INSERT INTO messages (id, room_id, user_id, username, msg)
         SELECT 'pm' || g || substr(md5($1), 1, 12), $2, $3, 'admin', 'm' || g FROM generate_series(1, 230) g RETURNING id`,
        [u.userId, rid, A.userId],
      )
    ).rows.map((r) => r.id as string);
    const values = ids.slice(0, 198).map((id, i) => `('q${i}x${u.userId}', '${u.userId}', '${id}', '${rid}', now() + interval '1 day')`);
    await pool.query(`INSERT INTO message_reminders (id, user_id, message_id, room_id, remind_at) VALUES ${values.join(',')}`);
    const all = await Promise.all(ids.slice(198, 228).map((id) => set(u, id, inMinutes(10))));
    expect(all.filter((r) => r.status === 200)).toHaveLength(2);
    expect(all.filter((r) => r.error === 'Você já tem 200 lembretes. Conclua alguns antes de criar outro.')).toHaveLength(28);
    expect((await pool.query('SELECT count(*)::int AS n FROM message_reminders WHERE user_id = $1', [u.userId])).rows[0].n).toBe(200);
    // No limite, trocar o horário de um que já existe (ON CONFLICT) continua valendo, também em paralelo.
    const again = await Promise.all(ids.slice(0, 5).map((id) => set(u, id, inMinutes(15))));
    expect(again.every((r) => r.status === 200)).toBe(true);
  });

  it('avisa: evento fired e firedAt na lista', async () => {
    const m = (await send(bruno, geral, 'reunião amanhã')).message;
    const r = (await set(ana, m._id, inMinutes(5))).reminder;
    await due(r._id);
    const ws = connectWs(ana);
    await ws.ready;
    try {
      await fireDueReminders();
      const ev = await ws.waitFor((e) => e.type === 'message.reminder' && e.action === 'fired' && e.reminder._id === r._id);
      expect(ev.reminder.message.msg).toBe('reunião amanhã');
      const list = await api('GET', 'reminders.list', undefined, ana);
      expect(list.reminders[0]._id).toBe(r._id);
      expect(list.reminders[0].firedAt).toBeTruthy();
      expect(list.fired).toBeGreaterThanOrEqual(1);
      // Adiar: volta a esperar.
      const snooze = await set(ana, m._id, inMinutes(30));
      expect(snooze.reminder.firedAt).toBeNull();
    } finally {
      ws.close();
    }
  });

  it('perdeu o acesso antes do aviso: o ciclo apaga e só manda removed', async () => {
    const g = (await api('POST', 'groups.create', { name: name('saida'), members: [ana.username] }, bruno)).group._id;
    const m = (await send(bruno, g, 'conteúdo secreto')).message;
    const r = (await set(ana, m._id, inMinutes(5))).reminder;
    expect(r.roomName).toBeTruthy();
    await api('POST', 'groups.kick', { roomId: g, userId: ana.userId }, bruno);
    // Renomeado depois que ela saiu: nem a lista nem o evento levam o nome novo.
    const secreto = name('demissoes-secretas');
    expect((await api('POST', 'groups.rename', { roomId: g, name: secreto }, bruno)).status).toBe(200);
    const listed = (await api('GET', 'reminders.list', undefined, ana)).reminders.find((x: any) => x._id === r._id);
    expect(listed).toMatchObject({ rid: g, t: 'p', message: null });
    expect(listed.roomName).toBeUndefined();
    await due(r._id);
    const ws = connectWs(ana);
    await ws.ready;
    try {
      await fireDueReminders();
      const ev = await ws.waitFor((e) => e.type === 'message.reminder' && e.reminder._id === r._id);
      expect(ev.action).toBe('removed');
      expect(ev.reminder.message).toBeNull();
      expect(ev.reminder.roomName).toBeUndefined();
      expect(JSON.stringify(ws.events)).not.toContain('conteúdo secreto');
      expect(JSON.stringify(ws.events)).not.toContain(secreto);
      expect((await pool.query('SELECT 1 FROM message_reminders WHERE id = $1', [r._id])).rowCount).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('concluir: só o próprio; apagar a mensagem apaga o lembrete e avisa', async () => {
    const m = (await send(bruno, geral, 'apagável')).message;
    const r = (await set(ana, m._id, inMinutes(5))).reminder;
    const other = await api('POST', 'reminders.delete', { reminderId: r._id }, bruno);
    expect(other.status).toBe(404);
    expect(other.error).toBe('Lembrete não encontrado.');
    expect((await api('POST', 'reminders.delete', { reminderId: r._id }, ana)).status).toBe(200);
    expect((await api('GET', 'reminders.list', undefined, ana)).reminders.find((x: any) => x._id === r._id)).toBeUndefined();

    const m2 = (await send(bruno, geral, 'vai sumir')).message;
    const r2 = (await set(ana, m2._id, inMinutes(5))).reminder;
    const ws = connectWs(ana);
    await ws.ready;
    try {
      await api('POST', 'chat.delete', { msgId: m2._id, roomId: geral }, bruno);
      const ev = await ws.waitFor((e) => e.type === 'message.reminder' && e.action === 'removed' && e.reminder._id === r2._id);
      expect(ev.reminder.messageId).toBe(m2._id);
      expect((await pool.query('SELECT 1 FROM message_reminders WHERE id = $1', [r2._id])).rowCount).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('conta desativada: fica avisado, sem evento', async () => {
    const u = await newUser(A);
    await api('POST', 'channels.invite', { roomId: geral, userId: u.userId }, A);
    const m = (await send(bruno, geral, 'para a conta desativada')).message;
    const r = (await set(u, m._id, inMinutes(5))).reminder;
    await due(r._id);
    await api('POST', 'users.setActiveStatus', { userId: u.userId, activeStatus: false }, A);
    await fireDueReminders();
    const row = (await pool.query('SELECT fired_at FROM message_reminders WHERE id = $1', [r._id])).rows[0];
    expect(row.fired_at).toBeTruthy();
  });

  it('push: sem conexão aberta; com Push_Privacy_Hide_Content, sem o texto', async () => {
    const spy = vi.spyOn(push, 'sendPush').mockResolvedValue(undefined);
    const before = { Push_enable: getSetting('Push_enable'), Push_Privacy_Hide_Content: getSetting('Push_Privacy_Hide_Content') };
    await api('POST', 'settings', { settings: { Push_enable: true, Push_Privacy_Hide_Content: false } }, A);
    try {
      const m = (await send(bruno, geral, 'texto visível')).message;
      const r = (await set(ana, m._id, inMinutes(5))).reminder;
      await due(r._id);
      await fireDueReminders();
      const call = spy.mock.calls.find((c) => c[1].tag === `reminder-${r._id}`)!;
      expect(call[0]).toEqual([ana.userId]);
      expect(call[1]).toMatchObject({ title: 'Lembrete', url: `/channel/${geral}?msg=${m._id}` });
      expect(call[1].body).toContain('texto visível');

      await api('POST', 'settings', { settings: { Push_Privacy_Hide_Content: true } }, A);
      const m2 = (await send(bruno, geral, 'texto secreto')).message;
      const r2 = (await set(ana, m2._id, inMinutes(5))).reminder;
      await due(r2._id);
      await fireDueReminders();
      const call2 = spy.mock.calls.find((c) => c[1].tag === `reminder-${r2._id}`)!;
      expect(call2[1].body).toBe(REMINDER_HIDDEN_TEXT);
      expect(JSON.stringify(call2)).not.toContain('texto secreto');

      // Sala criptografada: nunca o conteúdo.
      await api('POST', 'settings', { settings: { Push_Privacy_Hide_Content: false } }, A);
      const g = (await api('POST', 'groups.create', { name: name('cifra'), members: [ana.username] }, bruno)).group._id;
      const m3 = (await send(bruno, g, 'cifrado')).message;
      await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [g]);
      const r3 = (await set(ana, m3._id, inMinutes(5))).reminder;
      await due(r3._id);
      await fireDueReminders();
      const call3 = spy.mock.calls.find((c) => c[1].tag === `reminder-${r3._id}`)!;
      expect(call3[1].body).toContain('Mensagem criptografada');
      expect(call3[1].body).not.toContain('cifrado');
      expect(call3[1].url).toBe(`/group/${g}?msg=${m3._id}`);
    } finally {
      spy.mockRestore();
      await api('POST', 'settings', { settings: before }, A);
    }
  });
});
