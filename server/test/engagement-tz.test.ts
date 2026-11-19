import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { EXPORT_TZ } from '../src/services/exportRender';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Engajamento no fuso da empresa (TZ do servidor ou America/Sao_Paulo), não no do banco: a mensagem das 11h38 de
// Brasília contava às 14h e o dia virava às 21h (admsys-12).
let A: Auth;
const hourIn = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: EXPORT_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
const dayIn = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: EXPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

describe('engajamento no fuso da empresa', () => {
  it('horários de pico, dias e salas contam no fuso da empresa', async () => {
    const ch = await api('POST', 'channels.create', { name: 'fuso' }, A);
    const rid = ch.channel._id;
    // 14h38 UTC (11h38 em Brasília) e 01h00 UTC do dia 20 (22h do dia 19 em Brasília).
    const at = ['2026-11-19T14:38:00Z', '2026-11-20T01:00:00Z'];
    for (const [i, ts] of at.entries()) {
      const m = await api('POST', 'chat.sendMessage', { message: { rid, msg: `fuso ${i}` } }, A);
      await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [m.message._id, ts]);
    }
    const day = dayIn(at[0]);
    const users = await api('GET', 'engagement-dashboard/users', { start: day, end: day }, A);
    expect(users.busiestHours).toEqual(at.filter((ts) => dayIn(ts) === day).map((ts) => ({ hour: hourIn(ts), messages: 1 })).sort((a, b) => a.hour - b.hour));
    const msgs = await api('GET', 'engagement-dashboard/messages', { start: day, end: day }, A);
    expect(msgs.daily).toEqual([{ day, messages: at.filter((ts) => dayIn(ts) === day).length }]);
    const chans = await api('GET', 'engagement-dashboard/channels', { start: day, end: day }, A);
    expect(chans.channels.find((c: any) => c.room._id === rid).messages).toBe(at.filter((ts) => dayIn(ts) === day).length);
    if (EXPORT_TZ === 'America/Sao_Paulo') {
      expect(users.busiestHours).toEqual([
        { hour: 11, messages: 1 },
        { hour: 22, messages: 1 },
      ]);
    }
  });

  it('a atividade do dia é anotada no dia da empresa', async () => {
    await api('POST', 'chat.sendMessage', { message: { rid: (await api('GET', 'channels.info', { roomName: 'geral' }, A)).channel._id, msg: 'hoje' } }, A);
    const row = (await pool.query('SELECT day::text AS day FROM activity_daily WHERE user_id = $1 ORDER BY day DESC LIMIT 1', [A.userId])).rows[0];
    expect(row.day).toBe(dayIn(new Date().toISOString()));
  });
});

describe('engajamento sem linhas vazias (admsys-32)', () => {
  it('"Pessoas mais ativas" só traz quem mandou mensagem e a aba Canais só salas com mensagens', async () => {
    // Só entrou (o login também conta em activity_daily), sem mandar nada.
    const quieto = await newUser(A);
    const vazia = await api('POST', 'channels.create', { name: `vazia-${Date.now()}` }, A);
    const ativa = await api('POST', 'channels.create', { name: `ativa-${Date.now()}` }, A);
    await api('POST', 'chat.sendMessage', { message: { rid: ativa.channel._id, msg: 'oi' } }, A);
    const today = dayIn(new Date().toISOString());
    const logins = await pool.query('SELECT sessions, messages FROM activity_daily WHERE user_id = $1', [quieto.userId]);
    expect(logins.rows[0]).toMatchObject({ messages: 0 });
    const msgs = await api('GET', 'engagement-dashboard/messages', { start: today, end: today }, A);
    expect(msgs.topUsers.some((u: any) => u._id === quieto.userId)).toBe(false);
    expect(msgs.topUsers.every((u: any) => u.messages > 0)).toBe(true);
    const chans = await api('GET', 'engagement-dashboard/channels', { start: today, end: today, count: 500 }, A);
    const ids = chans.channels.map((c: any) => c.room._id);
    expect(ids).toContain(ativa.channel._id);
    expect(ids).not.toContain(vazia.channel._id);
    expect(chans.total).toBe(chans.channels.length);
    // A sala que ficou quieta no período, mas teve mensagens no anterior, continua (mostra a queda).
    const ontem = new Date(Date.now() - 86400_000).toISOString();
    const antiga = await api('POST', 'channels.create', { name: `quieta-${Date.now()}` }, A);
    const m = await api('POST', 'chat.sendMessage', { message: { rid: antiga.channel._id, msg: 'ontem' } }, A);
    await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [m.message._id, ontem]);
    const again = await api('GET', 'engagement-dashboard/channels', { start: today, end: today, count: 500 }, A);
    expect(again.channels.find((c: any) => c.room._id === antiga.channel._id)).toMatchObject({ messages: 0, lastWeekMessages: 1, diffFromLastWeek: -1 });
  });
});
