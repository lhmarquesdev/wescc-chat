import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Salas privadas continuam privadas em todo caminho: discussões de canal de time privado, canais que saem de um time
// privado, autocompletar, eventos em tempo real (para todos, ao excluir, a quem só assistia), #menções, edição com @all e
// imagens de fora nos anexos.
let A: Auth;
let alice: Auth; // dona do time privado
let bruno: Auth; // membro do time
let eve: Auth; // ninguém do time
let op: Auth; // papel Operação (sem mencionar @all)
let n = 0;
const tag = () => `${Date.now().toString(36)}${++n}`;

const ws = async (who: Auth) => {
  const w = connectWs(who);
  await w.ready;
  return w;
};
const roomEvents = (w: { events: any[] }, rid: string) => w.events.filter((e) => e.type === 'room' && e.room?._id === rid);
const send = (who: Auth, rid: string, msg: string) => api('POST', 'chat.sendMessage', { message: { rid, msg } }, who);

async function privateTeamChannel(type: 'c' | 'p' = 'c') {
  const t = await api('POST', 'teams.create', { name: `diretoria-${tag()}`, type: 1, members: [bruno.username] }, alice);
  expect(t.success).toBe(true);
  const ch = await api('POST', 'teams.createRoom', { teamId: t.team._id, name: `cortes-${tag()}`, type }, alice);
  expect(ch.success).toBe(true);
  return { team: t.team, rid: ch.room._id as string, name: ch.room.name as string };
}

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  alice = await newUser(A, { roles: ['user'] });
  bruno = await newUser(A, { roles: ['user'] });
  eve = await newUser(A, { roles: ['user'] });
  op = await newUser(A, { roles: ['operacao'] });
});
afterAll(() => stopServer());

describe('discussão de canal de time privado', () => {
  it('nasce grupo privado: quem não é do time não recebe o id, não lê, não entra e não escreve', async () => {
    const { rid } = await privateTeamChannel();
    const w = await ws(eve);
    try {
      const d = await api('POST', 'rooms.createDiscussion', { prid: rid, t_name: 'Valuation', reply: 'Oferta final: 120 milhões' }, alice);
      expect(d.success).toBe(true);
      expect(d.discussion.t).toBe('p');
      const did = d.discussion._id;
      await sleep(300);
      expect(w.events.some((e) => e.type === 'room' && e.room?._id === did)).toBe(false);
      expect((await api('GET', 'groups.history', { roomId: did }, eve)).status).toBe(403);
      expect((await api('GET', 'channels.history', { roomId: did }, eve)).status).toBe(403);
      expect((await api('POST', 'channels.join', { roomId: did }, eve)).status).toBe(403);
      expect((await send(eve, did, 'eve estava aqui')).status).toBe(403);
      // Quem abriu continua lendo e escrevendo.
      expect((await api('GET', 'groups.history', { roomId: did }, alice)).messages.map((m: any) => m.msg)).toContain('Oferta final: 120 milhões');
    } finally {
      w.close();
    }
  });

  it('discussão de canal público continua aberta a todos', async () => {
    const ch = await api('POST', 'channels.create', { name: `publico-${tag()}` }, alice);
    const d = await api('POST', 'rooms.createDiscussion', { prid: ch.channel._id, t_name: 'Aberta', reply: 'todos leem' }, alice);
    expect(d.discussion.t).toBe('c');
    expect((await api('GET', 'channels.history', { roomId: d.discussion._id }, eve)).status).toBe(200);
  });

  it('discussão antiga aberta (t = c) segue a sala de origem, e a migração a torna grupo privado', async () => {
    const { rid } = await privateTeamChannel();
    const d = await api('POST', 'rooms.createDiscussion', { prid: rid, t_name: 'Antiga', reply: 'segredo antigo' }, alice);
    const did = d.discussion._id;
    // Como era antes da correção.
    await pool.query(`UPDATE rooms SET t = 'c' WHERE id = $1`, [did]);
    expect((await api('GET', 'channels.history', { roomId: did }, eve)).status).toBe(403);
    expect((await api('POST', 'channels.join', { roomId: did }, eve)).status).toBe(403);
    // Discussão de canal público que virou privado.
    const pub = await api('POST', 'channels.create', { name: `vira-${tag()}` }, alice);
    const d2 = await api('POST', 'rooms.createDiscussion', { prid: pub.channel._id, t_name: 'Era aberta', reply: 'x' }, alice);
    await pool.query(`UPDATE rooms SET t = 'p' WHERE id = $1`, [pub.channel._id]);
    expect((await api('GET', 'channels.history', { roomId: d2.discussion._id }, eve)).status).toBe(403);
    const here = path.dirname(fileURLToPath(import.meta.url));
    await pool.query(fs.readFileSync(path.join(here, '../src/db/migrations/051_privacidade_salas.sql'), 'utf8'));
    const rows = (await pool.query('SELECT id, t FROM rooms WHERE id = ANY($1)', [[did, d2.discussion._id]])).rows;
    expect(rows.map((r) => r.t)).toEqual(['p', 'p']);
    // A discussão de canal público que segue público não muda.
    const pub2 = await api('POST', 'channels.create', { name: `segue-${tag()}` }, alice);
    const d3 = await api('POST', 'rooms.createDiscussion', { prid: pub2.channel._id, t_name: 'Segue aberta', reply: 'x' }, alice);
    await pool.query(fs.readFileSync(path.join(here, '../src/db/migrations/051_privacidade_salas.sql'), 'utf8'));
    expect((await pool.query('SELECT t FROM rooms WHERE id = $1', [d3.discussion._id])).rows[0].t).toBe('c');
  });

  it('ficar privado leva as discussões abertas junto', async () => {
    const pub = await api('POST', 'channels.create', { name: `privatiza-${tag()}` }, alice);
    const d = await api('POST', 'rooms.createDiscussion', { prid: pub.channel._id, t_name: 'Vai junto', reply: 'x' }, alice);
    expect((await api('POST', 'rooms.saveRoomSettings', { rid: pub.channel._id, roomType: 'p' }, alice)).success).toBe(true);
    expect((await api('GET', 'rooms.info', { roomId: d.discussion._id }, alice)).room.t).toBe('p');
    expect((await api('GET', 'channels.history', { roomId: d.discussion._id }, eve)).status).toBe(403);
  });
});

describe('canal de time privado que sai do time', () => {
  const outsider = async (rid: string) => {
    expect((await api('GET', 'rooms.info', { roomId: rid }, alice)).room.t).toBe('p');
    expect((await api('GET', 'channels.history', { roomId: rid }, eve)).status).toBe(403);
    expect((await api('POST', 'channels.join', { roomId: rid }, eve)).status).toBe(403);
    // Quem já estava continua.
    expect((await api('GET', 'groups.history', { roomId: rid }, alice)).status).toBe(200);
  };

  it('tirado do time vira grupo privado com os mesmos membros', async () => {
    const { team, rid } = await privateTeamChannel();
    expect((await api('POST', 'teams.removeRoom', { teamId: team._id, roomId: rid }, alice)).success).toBe(true);
    await outsider(rid);
  });

  it('time excluído ou convertido em sala: os canais viram grupos privados', async () => {
    const a = await privateTeamChannel();
    expect((await api('POST', 'teams.delete', { teamId: a.team._id }, alice)).success).toBe(true);
    await outsider(a.rid);
    const b = await privateTeamChannel();
    expect((await api('POST', 'teams.convertToChannel', { teamId: b.team._id }, alice)).success).toBe(true);
    await outsider(b.rid);
  });

  it('canal de time público que sai do time continua público', async () => {
    const t = await api('POST', 'teams.create', { name: `aberto-${tag()}`, type: 0 }, alice);
    const ch = await api('POST', 'teams.createRoom', { teamId: t.team._id, name: `aberto-canal-${tag()}`, type: 'c' }, alice);
    expect((await api('POST', 'teams.removeRoom', { teamId: t.team._id, roomId: ch.room._id }, alice)).success).toBe(true);
    expect((await api('GET', 'rooms.info', { roomId: ch.room._id }, alice)).room.t).toBe('c');
    expect((await api('GET', 'channels.history', { roomId: ch.room._id }, eve)).status).toBe(200);
  });
});

describe('o que vai para todas as conexões', () => {
  it('autocompletar não mostra canal de time privado a quem não é do time, nem tópico ou última mensagem', async () => {
    const { rid, name } = await privateTeamChannel();
    await api('POST', 'rooms.saveRoomSettings', { rid, roomTopic: 'Plano de cortes', roomAnnouncement: 'Interno' }, alice);
    await send(alice, rid, 'Lista de demissões');
    const term = name;
    expect((await api('GET', 'rooms.autocomplete.channelAndPrivate', { term }, eve)).items).toEqual([]);
    const forMember = (await api('GET', 'rooms.autocomplete.channelAndPrivate', { term }, bruno)).items;
    expect(forMember.map((x: any) => x._id)).toEqual([rid]);
    expect(forMember[0]).toEqual({ _id: rid, t: 'c', name, fname: name, teamMain: false, notice: false });
    // Canal público aparece para todos, grupo privado só para quem participa.
    const pub = await api('POST', 'channels.create', { name: `auto-pub-${tag()}` }, alice);
    const grp = await api('POST', 'groups.create', { name: `auto-grp-${tag()}` }, alice);
    expect((await api('GET', 'rooms.autocomplete.channelAndPrivate', { term: 'auto-' }, eve)).items.map((x: any) => x._id)).toEqual([pub.channel._id]);
    expect((await api('GET', 'rooms.autocomplete.channelAndPrivate', { term: 'auto-' }, alice)).items.map((x: any) => x._id).sort()).toEqual(
      [pub.channel._id, grp.group._id].sort(),
    );
  });

  it('mensagem em canal de time privado não chega a quem não é do time; canal público chega sem a prévia', async () => {
    const { rid } = await privateTeamChannel();
    const pub = await api('POST', 'channels.create', { name: `aviso-${tag()}`, members: [bruno.username] }, alice);
    const pid = pub.channel._id;
    const we = await ws(eve);
    const wb = await ws(bruno);
    try {
      await send(alice, rid, 'Reajuste da diretoria: 35%');
      await send(alice, pid, 'Bom dia a todos');
      await wb.waitFor((e) => e.type === 'room' && e.room?._id === pid && e.room.lastMessage?.msg === 'Bom dia a todos');
      await sleep(300);
      expect(roomEvents(we, rid)).toEqual([]);
      const seen = roomEvents(we, pid);
      expect(seen.length).toBeGreaterThan(0);
      for (const e of seen) expect(e.room.lastMessage).toBeUndefined();
      // Quem está na sala recebe só o evento completo (o resumo para todos não sobrescreve a prévia).
      for (const e of roomEvents(wb, pid)) expect(e.room.lastMessage?.msg).toBeTruthy();
    } finally {
      we.close();
      wb.close();
    }
  });

  it('excluir grupo privado ou DM não avisa quem não participa; canal público avisa sem o conteúdo', async () => {
    const we = await ws(eve);
    try {
      const g = await api('POST', 'groups.create', { name: `juridico-${tag()}`, members: [bruno.username] }, alice);
      await send(alice, g.group._id, 'Acordo proposto: R$ 80 mil');
      expect((await api('POST', 'groups.delete', { roomId: g.group._id }, alice)).success).toBe(true);
      const dm = await api('POST', 'im.create', { username: bruno.username }, A);
      await send(A, dm.room._id, 'Avaliação negativa');
      expect((await api('POST', 'im.delete', { roomId: dm.room._id }, A)).success).toBe(true);
      const { rid } = await privateTeamChannel();
      await send(alice, rid, 'segredo do time');
      expect((await api('POST', 'rooms.delete', { roomId: rid }, alice)).success).toBe(true);
      const pub = await api('POST', 'channels.create', { name: `apagar-${tag()}` }, alice);
      await send(alice, pub.channel._id, 'some daqui');
      expect((await api('POST', 'channels.delete', { roomId: pub.channel._id }, alice)).success).toBe(true);
      const gone = await we.waitFor((e) => e.type === 'room' && e.action === 'removed' && e.room._id === pub.channel._id);
      expect(gone.room.lastMessage).toBeUndefined();
      await sleep(300);
      const removed = we.events.filter((e) => e.type === 'room' && e.action === 'removed').map((e) => e.room._id);
      expect(removed).toEqual([pub.channel._id]);
    } finally {
      we.close();
    }
  });
});

describe('quem perde o acesso para de receber na hora', () => {
  it('canal que vira privado: quem só assistia não recebe mais as mensagens', async () => {
    const ch = await api('POST', 'channels.create', { name: `assiste-${tag()}` }, alice);
    const rid = ch.channel._id;
    const we = await ws(eve);
    try {
      we.send({ type: 'watch', rid });
      await sleep(200);
      await send(alice, rid, 'antes, público');
      await we.waitFor((e) => e.type === 'message' && e.message?.msg === 'antes, público');
      expect((await api('POST', 'rooms.saveRoomSettings', { rid, roomType: 'p' }, alice)).success).toBe(true);
      await send(alice, rid, 'SEGREDO depois de virar privado');
      await sleep(300);
      expect(we.events.some((e) => e.type === 'message' && e.message?.msg?.includes('SEGREDO'))).toBe(false);
      // Pedir de novo não adianta.
      we.send({ type: 'watch', rid });
      await sleep(200);
      await send(alice, rid, 'SEGREDO 2');
      await sleep(300);
      expect(we.events.some((e) => e.type === 'message' && e.message?.msg === 'SEGREDO 2')).toBe(false);
    } finally {
      we.close();
    }
  });

  it('removido de um grupo com a sala aberta não recebe o que vem depois', async () => {
    const g = await api('POST', 'groups.create', { name: `grupo-watch-${tag()}`, members: [eve.username] }, alice);
    const gid = g.group._id;
    const we = await ws(eve);
    try {
      we.send({ type: 'watch', rid: gid });
      await sleep(200);
      expect((await api('POST', 'groups.kick', { roomId: gid, username: eve.username }, alice)).success).toBe(true);
      await send(alice, gid, 'CONFIDENCIAL depois que eve saiu');
      await sleep(300);
      expect(we.events.some((e) => e.type === 'message' && e.message?.msg?.includes('CONFIDENCIAL'))).toBe(false);
    } finally {
      we.close();
    }
  });

  it('time que fica privado: quem é do time continua assistindo o canal; quem não é, para', async () => {
    const t = await api('POST', 'teams.create', { name: `vira-privado-${tag()}`, type: 0, members: [bruno.username] }, alice);
    const ch = await api('POST', 'teams.createRoom', { teamId: t.team._id, name: `canal-time-${tag()}`, type: 'c' }, alice);
    const rid = ch.room._id;
    const we = await ws(eve);
    const wb = await ws(bruno);
    try {
      we.send({ type: 'watch', rid });
      wb.send({ type: 'watch', rid });
      await sleep(200);
      expect((await api('POST', 'rooms.saveRoomSettings', { rid: t.team.roomId, roomType: 'p' }, alice)).success).toBe(true);
      await sleep(300);
      await send(alice, rid, 'só para o time');
      await wb.waitFor((e) => e.type === 'message' && e.message?.msg === 'só para o time');
      await sleep(200);
      expect(we.events.some((e) => e.type === 'message' && e.message?.msg === 'só para o time')).toBe(false);
    } finally {
      we.close();
      wb.close();
    }
  });
});
