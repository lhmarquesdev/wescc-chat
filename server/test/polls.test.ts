import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLL_ERRORS } from '@shared/messages';
import { pool } from '../src/db/pool';
import { closeDuePolls } from '../src/services/polls';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Enquetes (spec B §12, polls.test.ts).

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

let seq = 0;
const name = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const channel = async (owner: Auth, members: Auth[], extraData: Record<string, unknown> = {}) => {
  const r = await api('POST', 'channels.create', { name: name('enquete'), members: members.map((m) => m.username), extraData }, owner);
  if (!r.success) throw new Error(JSON.stringify(r));
  return r.channel._id as string;
};
const create = (auth: Auth, rid: string, extra: Record<string, unknown> = {}) =>
  api('POST', 'polls.create', { rid, question: 'Qual dia?', options: ['Segunda', 'Terça', 'Quarta'], ...extra }, auth);
const vote = (auth: Auth, messageId: string, optionIds: unknown) => api('POST', 'polls.vote', { messageId, optionIds }, auth);
const pollOf = async (id: string) => (await pool.query('SELECT extra FROM messages WHERE id = $1', [id])).rows[0].extra.poll;
const setPermission = (id: string, roles: string[]) => api('POST', 'permissions.update', { permissions: [{ _id: id, roles }] }, A);
const rolesOf = async (id: string) => (await pool.query('SELECT roles FROM permissions WHERE id = $1', [id])).rows[0].roles as string[];
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('enquetes', () => {
  let ana: Auth;
  let bruno: Auth;
  let carla: Auth;
  beforeAll(async () => {
    [ana, bruno, carla] = await Promise.all([newUser(A), newUser(A), newUser(A)]);
  });

  it('cria num canal: msg = pergunta, opções o1..oN zeradas, linha em polls', async () => {
    const rid = await channel(ana, [bruno]);
    const r = await create(ana, rid, { options: [' Segunda ', 'Terça', '', 'Quarta'], closesAt: inMinutes(60) });
    expect(r.status).toBe(200);
    const m = r.message;
    expect(m.msg).toBe('Qual dia?');
    expect(m.poll).toMatchObject({
      question: 'Qual dia?',
      options: [
        { id: 'o1', text: 'Segunda', votes: 0 },
        { id: 'o2', text: 'Terça', votes: 0 },
        { id: 'o3', text: 'Quarta', votes: 0 },
      ],
      voters: 0,
      multiple: false,
      anonymous: false,
      closedAt: null,
    });
    expect(m.poll.closesAt).toBeTruthy();
    const row = (await pool.query('SELECT * FROM polls WHERE message_id = $1', [m._id])).rows[0];
    expect(row).toMatchObject({ room_id: rid, created_by: ana.userId, option_ids: ['o1', 'o2', 'o3'] });
    const lm = (await pool.query('SELECT last_message FROM rooms WHERE id = $1', [rid])).rows[0].last_message;
    expect(lm.msg).toBe('📊 Qual dia?');
  });

  it('create-poll pelo papel da sala: publicador cria no canal de avisos; leitor recebe o erro de envio', async () => {
    const before = await rolesOf('create-poll');
    const avisos = await channel(A, [ana, bruno], { notice: true });
    await api('POST', 'channels.addPublisher', { roomId: avisos, userId: bruno.userId }, A);
    const comum = await channel(A, [ana]);
    await setPermission('create-poll', before.filter((r) => r !== 'user'));
    try {
      const no = await create(ana, comum);
      expect(no.status).toBe(403);
      expect(no.error).toBe('Você não tem permissão para criar enquetes nesta sala.');
      expect((await create(bruno, avisos)).status).toBe(200);
    } finally {
      await setPermission('create-poll', before);
    }
    const reader = await create(ana, avisos);
    expect(reader.status).toBe(403);
    expect(reader.error).toBe('Este é um canal de avisos: só os publicadores enviam mensagens.');
  });

  it('cada texto de validação', async () => {
    const rid = await channel(ana, []);
    const err = async (extra: Record<string, unknown>) => (await create(ana, rid, extra)).error;
    expect(await err({ question: '  ' })).toBe(POLL_ERRORS.question);
    expect(await err({ options: ['só uma'] })).toBe(POLL_ERRORS.count);
    expect(await err({ options: Array.from({ length: 11 }, (_, i) => `op ${i}`) })).toBe(POLL_ERRORS.count);
    expect(await err({ options: ['a', 'x'.repeat(101)] })).toBe(POLL_ERRORS.optionLength);
    expect(await err({ options: ['Sim', 'sim'] })).toBe(POLL_ERRORS.repeated);
    expect(await err({ closesAt: inMinutes(1) })).toBe(POLL_ERRORS.deadline);
    expect(await err({ closesAt: inMinutes(91 * 24 * 60) })).toBe(POLL_ERRORS.deadline);
    expect(POLL_ERRORS.deadline).toBe('O prazo precisa ficar entre 5 minutos e 90 dias a partir de agora.');
  });

  it('voto único: votar, trocar, retirar; evento da sala no máximo 1/s; poll.myVotes nas outras conexões', async () => {
    const rid = await channel(ana, [bruno]);
    const m = (await create(ana, rid)).message;
    const wsAna = connectWs(ana);
    const wsOther = connectWs(bruno);
    await Promise.all([wsAna.ready, wsOther.ready]);
    try {
      const v1 = await vote(bruno, m._id, ['o2']);
      expect(v1.optionIds).toEqual(['o2']);
      expect(v1.message.poll.options.map((o: any) => o.votes)).toEqual([0, 1, 0]);
      await vote(ana, m._id, ['o2']);
      const switched = await vote(bruno, m._id, ['o3']);
      expect(switched.message.poll.options.map((o: any) => o.votes)).toEqual([0, 1, 1]);
      expect(switched.message.poll.voters).toBe(2);
      const removed = await vote(bruno, m._id, []);
      expect(removed.optionIds).toEqual([]);
      expect(removed.message.poll.voters).toBe(1);
      const myEv = await wsOther.waitFor((e) => e.type === 'poll.myVotes' && e.messageId === m._id && e.optionIds.length === 0);
      expect(myEv.rid).toBe(rid);
      const since = wsAna.events.length;
      for (let i = 0; i < 5; i++) await vote(bruno, m._id, [i % 2 ? 'o1' : 'o2']);
      await sleep(1500);
      const updates = wsAna.events.slice(since).filter((e) => e.type === 'message' && e.action === 'updated' && e.message._id === m._id);
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates.length).toBeLessThanOrEqual(2);
      expect(updates[updates.length - 1].message.poll.options.map((o: any) => o.votes)).toEqual([0, 2, 0]);
    } finally {
      wsAna.close();
      wsOther.close();
    }
  });

  it('várias respostas e opções inválidas', async () => {
    const rid = await channel(ana, [bruno]);
    const multi = (await create(ana, rid, { multiple: true })).message;
    const r = await vote(bruno, multi._id, ['o3', 'o1']);
    expect(r.optionIds).toEqual(['o1', 'o3']);
    const rows = (await pool.query('SELECT option_id FROM poll_votes WHERE message_id = $1 ORDER BY option_id', [multi._id])).rows.map((x) => x.option_id);
    expect(rows).toEqual(['o1', 'o3']);
    const single = (await create(ana, rid)).message;
    expect((await vote(bruno, single._id, ['o1', 'o2'])).error).toBe('Esta enquete aceita uma resposta só.');
    expect((await vote(bruno, single._id, ['o9'])).error).toBe('Opção inválida.');
    expect((await vote(bruno, single._id, 'o1')).error).toBe('Parâmetros inválidos.');
  });

  it('anônima: ninguém vê quem votou; não anônima: lista; canal de avisos só para quem publica', async () => {
    const rid = await channel(ana, [bruno, carla]);
    const anon = (await create(ana, rid, { anonymous: true })).message;
    const ws = connectWs(carla);
    await ws.ready;
    try {
      await vote(bruno, anon._id, ['o1']);
      const voters = await api('GET', 'polls.voters', { messageId: anon._id }, ana);
      expect(voters.status).toBe(400);
      expect(voters.error).toBe('Esta enquete é anônima: ninguém vê quem votou.');
      const ev = await ws.waitFor((e) => e.type === 'message' && e.action === 'updated' && e.message._id === anon._id, 3000);
      const text = JSON.stringify(ev.message.poll) + JSON.stringify(await pollOf(anon._id));
      expect(text).not.toContain(bruno.userId);
      expect(text).not.toContain(bruno.username);
    } finally {
      ws.close();
    }

    const open = (await create(ana, rid)).message;
    await vote(bruno, open._id, ['o2']);
    await vote(carla, open._id, ['o2']);
    const list = await api('GET', 'polls.voters', { messageId: open._id }, ana);
    expect(list.status).toBe(200);
    const o2 = list.options.find((o: any) => o.id === 'o2');
    expect(o2.total).toBe(2);
    expect(o2.users.map((u: any) => u.username).sort()).toEqual([bruno.username, carla.username].sort());

    const avisos = await channel(A, [ana, bruno], { notice: true });
    await api('POST', 'channels.addPublisher', { roomId: avisos, userId: bruno.userId }, A);
    const np = (await create(bruno, avisos)).message;
    await vote(ana, np._id, ['o1']);
    const reader = await api('GET', 'polls.voters', { messageId: np._id }, ana);
    expect(reader.status).toBe(403);
    expect(reader.error).toBe('Só quem publica neste canal vê quem votou.');
    expect((await api('GET', 'polls.voters', { messageId: np._id }, bruno)).status).toBe(200);
  });

  it('quem vota: fora da sala, silenciado, arquivada, leitor de somente leitura e de avisos, DM restrita', async () => {
    const pub = await channel(ana, [bruno]);
    const m = (await create(ana, pub)).message;
    const outsider = await newUser(A);
    const out = await vote(outsider, m._id, ['o1']);
    expect(out.status).toBe(403);
    expect(out.error).toBe('Entre na sala para votar.');
    await api('POST', 'rooms.muteUser', { roomId: pub, userId: bruno.userId }, ana);
    expect((await vote(bruno, m._id, ['o1'])).status).toBe(403);
    await api('POST', 'rooms.unmuteUser', { roomId: pub, userId: bruno.userId }, ana);

    const ro = await channel(ana, [bruno]);
    const rm = (await create(ana, ro)).message;
    await pool.query('UPDATE rooms SET ro = true WHERE id = $1', [ro]);
    expect((await vote(bruno, rm._id, ['o1'])).status).toBe(200);
    const avisos = await channel(A, [bruno], { notice: true });
    const am = (await create(A, avisos)).message;
    expect((await vote(bruno, am._id, ['o1'])).status).toBe(200);

    const arq = await channel(ana, [bruno]);
    const qm = (await create(ana, arq)).message;
    await api('POST', 'channels.archive', { roomId: arq }, ana);
    expect((await vote(bruno, qm._id, ['o1'])).status).toBe(400);
    expect((await create(ana, arq)).status).toBe(400);

    const u1 = await newUser(A);
    const u2 = await newUser(A);
    const dm = (await api('POST', 'im.create', { username: u2.username }, u1)).room._id;
    const dmPoll = (await create(u1, dm)).message;
    for (const u of [u1, u2]) await api('POST', 'users.update', { userId: u.userId, data: { roles: ['user', 'operacao'] } }, A);
    const blocked = await vote(u2, dmPoll._id, ['o1']);
    expect(blocked.errorType).toBe('error-direct-restricted');
    expect((await create(u1, dm)).errorType).toBe('error-direct-restricted');
  });

  it('encerrar: autor; outro membro não; moderador sim, com auditoria; voto depois é recusado', async () => {
    const rid = await channel(ana, [bruno, carla]);
    const m1 = (await create(bruno, rid)).message;
    const other = await api('POST', 'polls.close', { messageId: m1._id }, carla);
    expect(other.status).toBe(403);
    expect(other.error).toBe('Só quem criou a enquete ou um moderador da sala pode encerrá-la.');
    const closed = await api('POST', 'polls.close', { messageId: m1._id }, bruno);
    expect(closed.message.poll.closedAt).toBeTruthy();
    const late = await vote(carla, m1._id, ['o1']);
    expect(late.status).toBe(400);
    expect(late.error).toBe('Esta enquete já foi encerrada.');
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'poll.closed' AND target->>'msgId' = $1`, [m1._id])).rowCount).toBe(0);

    const m2 = (await create(bruno, rid)).message;
    expect((await api('POST', 'polls.close', { messageId: m2._id }, ana)).status).toBe(200); // dona da sala
    const log = (await pool.query(`SELECT * FROM audit_log WHERE action = 'poll.closed' AND target->>'msgId' = $1`, [m2._id])).rows[0];
    expect(log).toMatchObject({ actor_id: ana.userId });
    expect(log.data.author).toBe(bruno.username);
  });

  it('prazo: voto recusado logo depois; closeDuePolls encerra e publica', async () => {
    const rid = await channel(ana, [bruno]);
    const m = (await create(ana, rid, { closesAt: inMinutes(30) })).message;
    await pool.query(`UPDATE polls SET closes_at = now() - interval '1 second' WHERE message_id = $1`, [m._id]);
    expect((await vote(bruno, m._id, ['o1'])).error).toBe('Esta enquete já foi encerrada.');
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      expect(await closeDuePolls()).toBeGreaterThanOrEqual(1);
      const ev = await ws.waitFor((e) => e.type === 'message' && e.action === 'updated' && e.message._id === m._id && e.message.poll.closedAt);
      expect(ev.message.poll.closedAt).toBeTruthy();
      expect((await pollOf(m._id)).closedAt).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('sala criptografada (grupo privado): recusada', async () => {
    const g = (await api('POST', 'groups.create', { name: name('cifrado'), members: [bruno.username] }, ana)).group._id;
    await pool.query('UPDATE rooms SET encrypted = true WHERE id = $1', [g]);
    const r = await create(ana, g);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-poll-encrypted');
  });

  it('não editável; apagar remove polls e poll_votes; raiz com respostas vira rm sem enquete', async () => {
    const rid = await channel(ana, [bruno]);
    const m = (await create(ana, rid)).message;
    const ed = await api('POST', 'chat.update', { roomId: rid, msgId: m._id, text: 'outra pergunta' }, ana);
    expect(ed.status).toBe(400);
    expect(ed.error).toBe('Enquetes não podem ser editadas.');
    await vote(bruno, m._id, ['o1']);
    await api('POST', 'chat.delete', { msgId: m._id, roomId: rid }, ana);
    expect((await pool.query('SELECT 1 FROM polls WHERE message_id = $1', [m._id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM poll_votes WHERE message_id = $1', [m._id])).rowCount).toBe(0);

    const root = (await create(ana, rid)).message;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'resposta', tmid: root._id } }, bruno);
    await api('POST', 'chat.delete', { msgId: root._id, roomId: rid }, ana);
    const row = (await pool.query('SELECT t, extra FROM messages WHERE id = $1', [root._id])).rows[0];
    expect(row.t).toBe('rm');
    expect(row.extra.poll).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM polls WHERE message_id = $1', [root._id])).rowCount).toBe(0);
    expect((await vote(bruno, root._id, ['o1'])).status).toBe(404);
  });

  it('concorrência: 20 pessoas ao mesmo tempo', async () => {
    const people = await Promise.all(Array.from({ length: 20 }, () => newUser(A)));
    const rid = await channel(ana, people);
    const m = (await create(ana, rid)).message;
    const res = await Promise.all(people.map((p, i) => vote(p, m._id, [`o${(i % 3) + 1}`])));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const poll = await pollOf(m._id);
    expect(poll.voters).toBe(20);
    expect(poll.options.reduce((s: number, o: any) => s + o.votes, 0)).toBe(20);
  });

  it('myVotes devolve só os próprios votos', async () => {
    const rid = await channel(ana, [bruno]);
    const m1 = (await create(ana, rid)).message;
    const m2 = (await create(ana, rid, { multiple: true })).message;
    await vote(ana, m1._id, ['o1']);
    await vote(bruno, m2._id, ['o2', 'o3']);
    const mine = await api('GET', 'polls.myVotes', { messageIds: `${m1._id},${m2._id}` }, bruno);
    expect(mine.votes).toEqual({ [m2._id]: ['o2', 'o3'] });
    const tooMany = await api('GET', 'polls.myVotes', { messageIds: Array.from({ length: 101 }, (_, i) => `id${i}`).join(',') }, bruno);
    expect(tooMany.status).toBe(400);
  });

  it('conta excluída: o voto continua no total, fora da lista', async () => {
    const gone = await newUser(A);
    const rid = await channel(ana, [gone, bruno]);
    const m = (await create(ana, rid)).message;
    await vote(gone, m._id, ['o1']);
    await vote(bruno, m._id, ['o1']);
    const del = await api('POST', 'users.delete', { userId: gone.userId }, A);
    expect(del.status).toBe(200);
    const poll = await pollOf(m._id);
    expect(poll.options[0].votes).toBe(2);
    const list = await api('GET', 'polls.voters', { messageId: m._id }, ana);
    const o1 = list.options.find((o: any) => o.id === 'o1');
    expect(o1.total).toBe(2);
    expect(o1.users.map((u: any) => u.username)).toEqual([bruno.username]);
  });
});
