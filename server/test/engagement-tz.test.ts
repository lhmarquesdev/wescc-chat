import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { EXPORT_TZ } from '../src/services/exportRender';
import { admin, api, startServer, stopServer, type Auth } from './helpers';

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
