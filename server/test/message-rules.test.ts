import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { getSetting } from '../src/services/settings';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

let A: Auth;
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(stopServer);

const send = async (auth: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, auth);
const membersOf = async (rid: string) => (await api('GET', 'channels.members', { roomId: rid }, A)).members.map((m: any) => m.username).sort();

describe('comandos que apontam para outra sala', () => {
  it('/invite-all-from de um grupo privado de que a pessoa não participa responde como sala que não existe', async () => {
    const [alice, bruno, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const secret = (await api('POST', 'groups.create', { name: `sigilo-${uniq()}`, members: [bruno.username, carla.username] }, A)).group;
    const mine = (await api('POST', 'channels.create', { name: `da-alice-${uniq()}` }, alice)).channel;
    const r = await send(alice, mine._id, `/invite-all-from #${secret.name}`);
    expect(r.status).toBe(400);
    expect(r.error).toBe(`Sala #${secret.name} não encontrada.`);
    expect(await membersOf(mine._id)).toEqual([alice.username]);
    // O mesmo texto de uma sala que não existe, também nos outros comandos com #sala.
    for (const cmd of [`/archive #${secret.name}`, `/invite-all-to #${secret.name}`, `/join #${secret.name}`]) {
      const x = await send(alice, mine._id, cmd);
      expect([cmd, x.status, x.error]).toEqual([cmd, 400, `Sala #${secret.name} não encontrada.`]);
    }
    // Quem participa do grupo copia os membros; a administração de salas também.
    await api('POST', 'groups.invite', { roomId: secret._id, userId: alice.userId }, A);
    expect((await send(alice, mine._id, `/invite-all-from #${secret.name}`)).status).toBe(200);
    expect(await membersOf(mine._id)).toEqual([A.username, alice.username, bruno.username, carla.username].sort());
  });

  it('não copia os membros de uma sala com a lista de membros oculta', async () => {
    const [alice, bruno] = [await newUser(A), await newUser(A)];
    const hidden = (await api('POST', 'channels.create', { name: `oculta-${uniq()}`, members: [alice.username, bruno.username], extraData: { broadcast: true } }, A)).channel;
    const mine = (await api('POST', 'channels.create', { name: `copia-${uniq()}` }, alice)).channel;
    const r = await send(alice, mine._id, `/invite-all-from #${hidden.name}`);
    expect(r.status).toBe(403);
    expect(await membersOf(mine._id)).toEqual([alice.username]);
  });
});

describe('quem saiu da sala', () => {
  it('removido de um grupo privado não edita nem apaga as próprias mensagens nele', async () => {
    const [alice, bruno] = [await newUser(A), await newUser(A)];
    const g = (await api('POST', 'groups.create', { name: `grupo-${uniq()}`, members: [alice.username, bruno.username] }, A)).group;
    const m = (await send(alice, g._id, 'texto original')).message;
    await api('POST', 'groups.kick', { roomId: g._id, userId: alice.userId }, A);
    const upd = await api('POST', 'chat.update', { roomId: g._id, msgId: m._id, text: 'trocado depois de sair' }, alice);
    expect([upd.status, upd.error]).toEqual([403, 'Você não tem acesso a esta sala.']);
    const del = await api('POST', 'chat.delete', { roomId: g._id, msgId: m._id }, alice);
    expect([del.status, del.error]).toEqual([403, 'Você não tem acesso a esta sala.']);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, bruno)).message.msg).toBe('texto original');
    // O administrador continua podendo editar e apagar.
    expect((await api('POST', 'chat.update', { roomId: g._id, msgId: m._id, text: 'corrigido pela administração' }, A)).status).toBe(200);
    expect((await api('POST', 'chat.delete', { roomId: g._id, msgId: m._id }, A)).status).toBe(200);
  });

  it('quem saiu de um canal público entra de novo para editar (editar é publicar)', async () => {
    const alice = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `publico-${uniq()}`, members: [alice.username] }, A)).channel;
    const m = (await send(alice, ch._id, 'mensagem do canal')).message;
    await api('POST', 'channels.leave', { roomId: ch._id }, alice);
    const upd = await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'outra coisa' }, alice);
    expect([upd.status, upd.error]).toEqual([403, 'Você precisa entrar na sala para editar mensagens.']);
    await api('POST', 'channels.join', { roomId: ch._id }, alice);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'outra coisa' }, alice)).message.msg).toBe('outra coisa');
  });
});

describe('versões anteriores de uma mensagem editada', () => {
  it('só quem escreveu e quem modera a sala veem; apagar a mensagem leva as versões', async () => {
    const [bruno, carla, owner, outsider] = [await newUser(A), await newUser(A), await newUser(A), await newUser(A)];
    const ch = (await api('POST', 'channels.create', { name: `versoes-${uniq()}`, members: [bruno.username, carla.username, owner.username] }, A)).channel;
    await api('POST', 'channels.addOwner', { roomId: ch._id, userId: owner.userId }, A);
    const m = (await send(bruno, ch._id, 'acesso VPN: senha Bru#2026')).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'acesso VPN: peça a senha ao suporte' }, bruno);
    for (const who of [carla, outsider]) {
      const r = await api('GET', 'chat.getMessageHistory', { msgId: m._id }, who);
      expect([r.status, r.history]).toEqual([403, undefined]);
    }
    for (const who of [bruno, owner, A]) {
      const r = await api('GET', 'chat.getMessageHistory', { msgId: m._id }, who);
      expect(r.history.map((h: any) => h.msg)).toEqual(['acesso VPN: senha Bru#2026']);
    }
    await api('POST', 'chat.delete', { roomId: ch._id, msgId: m._id }, bruno);
    expect((await pool.query('SELECT count(*)::int AS n FROM message_history WHERE message_id = $1', [m._id])).rows[0].n).toBe(0);
  });

  it('raiz de tópico apagada (o lugar fica como "mensagem removida") também perde as versões', async () => {
    const ch = (await api('POST', 'channels.create', { name: `raiz-${uniq()}` }, A)).channel;
    const root = (await send(A, ch._id, 'raiz com segredo')).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: root._id, text: 'raiz sem segredo' }, A);
    await send(A, ch._id, 'resposta', { tmid: root._id });
    await api('POST', 'chat.delete', { roomId: ch._id, msgId: root._id }, A);
    expect((await api('GET', 'chat.getMessage', { msgId: root._id }, A)).message.t).toBe('rm');
    expect((await pool.query('SELECT count(*)::int AS n FROM message_history WHERE message_id = $1', [root._id])).rows[0].n).toBe(0);
  });
});

describe('cópias do texto (fixação e citações)', () => {
  const pinNoteOf = async (rid: string, mid: string) => (await api('GET', 'channels.history', { roomId: rid, count: 50 }, A)).messages.find((x: any) => x.t === 'message_pinned' && x.pinnedMessageId === mid);

  it('apagar a original tira o texto da nota de fixação e das citações, em qualquer sala', async () => {
    const ch = (await api('POST', 'channels.create', { name: `copias-${uniq()}` }, A)).channel;
    const other = (await api('POST', 'channels.create', { name: `outra-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'A senha do wifi é Segredo#2026')).message;
    await api('POST', 'chat.pinMessage', { messageId: m._id }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0].text).toBe('A senha do wifi é Segredo#2026');
    const q1 = (await send(A, ch._id, 'citando aqui', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    const q2 = (await send(A, other._id, 'citando em outra sala', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    expect(q2.attachments[0].text).toBe('A senha do wifi é Segredo#2026');

    await api('POST', 'chat.delete', { roomId: ch._id, msgId: m._id }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0]).toMatchObject({ text: 'Mensagem removida', removed: true });
    for (const q of [q1, q2]) {
      const got = (await api('GET', 'chat.getMessage', { msgId: q._id }, A)).message;
      expect(got.attachments[0]).toMatchObject({ text: 'Mensagem removida', removed: true, message_link: `?msg=${m._id}` });
      expect(got.msg).toBe(q.msg);
    }
  });

  it('editar a original atualiza a nota de fixação e as citações', async () => {
    const ch = (await api('POST', 'channels.create', { name: `edita-copia-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'meu CPF é 123.456.789-00')).message;
    await api('POST', 'chat.pinMessage', { messageId: m._id }, A);
    const q = (await send(A, ch._id, 'citação', { attachments: [{ message_link: `?msg=${m._id}` }] })).message;
    await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'meu CPF está no cadastro' }, A);
    expect((await pinNoteOf(ch._id, m._id)).attachments[0].text).toBe('meu CPF está no cadastro');
    expect((await api('GET', 'chat.getMessage', { msgId: q._id }, A)).message.attachments[0].text).toBe('meu CPF está no cadastro');
  });
});

describe('envio repetido', () => {
  it('o mesmo _id da mesma pessoa volta a mensagem que já existe, sem cópia', async () => {
    const ch = (await api('POST', 'channels.create', { name: `duplo-${uniq()}` }, A)).channel;
    const _id = `cli${uniq()}`.replace(/[^A-Za-z0-9]/g, '').padEnd(17, 'x').slice(0, 17);
    const [a, b] = await Promise.all([send(A, ch._id, 'Confirmo a reunião de amanhã', { _id }), send(A, ch._id, 'Confirmo a reunião de amanhã', { _id })]);
    const c = await send(A, ch._id, 'Confirmo a reunião de amanhã', { _id });
    expect([a.message._id, b.message._id, c.message._id]).toEqual([_id, _id, _id]);
    const hist = (await api('GET', 'channels.history', { roomId: ch._id, count: 50 }, A)).messages.filter((x: any) => !x.t);
    expect(hist.map((x: any) => x.msg)).toEqual(['Confirmo a reunião de amanhã']);
    expect((await api('GET', 'rooms.info', { roomId: ch._id }, A)).room.msgs).toBe(1);
    // O _id de outra pessoa não devolve a mensagem dela: a nova sai com outro _id.
    const u = await newUser(A);
    await api('POST', 'channels.invite', { roomId: ch._id, userId: u.userId }, A);
    const other = await send(u, ch._id, 'minha', { _id });
    expect(other.message._id).not.toBe(_id);
    expect(other.message.msg).toBe('minha');
  });
});

describe('menção a quem não está na sala', () => {
  it('a resposta do envio diz quem foi mencionado sem estar na sala', async () => {
    const [alice, bruno, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const g = (await api('POST', 'groups.create', { name: `mencao-${uniq()}`, members: [alice.username, bruno.username] }, alice)).group;
    const r = await send(alice, g._id, `@${carla.username} e @${bruno.username}, podem ver isso?`);
    expect(r.mentionsNotInRoom).toEqual([{ _id: carla.userId, username: carla.username, name: expect.any(String) }]);
    expect((await api('GET', 'subscriptions.getOne', { roomId: g._id }, carla)).subscription).toBeNull();
    const ok = await send(alice, g._id, `@${bruno.username} só você`);
    expect(ok.mentionsNotInRoom).toBeUndefined();
    const all = await send(alice, g._id, '@all reunião');
    expect(all.mentionsNotInRoom).toBeUndefined();
  });

  it('num canal de avisos, só quem vê a lista de membros fica sabendo', async () => {
    const [dono, pub, carla] = [await newUser(A), await newUser(A), await newUser(A)];
    const ch = (await api('POST', 'channels.create', { name: `avisos-${uniq()}`, members: [pub.username], extraData: { broadcast: true } }, dono)).channel;
    await api('POST', 'channels.addPublisher', { roomId: ch._id, userId: pub.userId }, dono);
    expect((await send(dono, ch._id, `@${carla.username} veja`)).mentionsNotInRoom).toHaveLength(1);
    const r = await send(pub, ch._id, `@${carla.username} veja`);
    expect(r.message.msg).toBe(`@${carla.username} veja`);
    expect(r.mentionsNotInRoom).toBeUndefined();
  });
});

describe('abrir uma mensagem antiga (?msg=)', () => {
  it('a janela traz a mensagem e as 30 de depois, sem faltar nenhuma', async () => {
    const ch = (await api('POST', 'channels.create', { name: `janela-${uniq()}` }, A)).channel;
    const ids: string[] = [];
    for (let i = 1; i <= 45; i++) ids.push((await send(A, ch._id, `m${i}`)).message._id);
    const target = ids[9];
    const around = (await api('GET', 'chat.getMessagesAround', { msgId: target, count: 30 }, A)).messages.filter((x: any) => !x.t);
    const got = around.map((x: any) => x._id).reverse();
    expect(got.indexOf(target)).toBe(9);
    expect(got.slice(got.indexOf(target))).toEqual(ids.slice(9, 40));
  });
});

describe('páginas da sala com mensagens na mesma hora', () => {
  it('rolar para cima e para baixo (latestId/oldestId) traz todas, mesmo as gravadas no mesmo instante', async () => {
    const ch = (await api('POST', 'channels.create', { name: `mesma-hora-${uniq()}` }, A)).channel;
    const ids: string[] = [];
    for (let i = 1; i <= 60; i++) ids.push((await send(A, ch._id, `m${i}`)).message._id);
    // m1..m20 no mesmo instante (importação, robô); as outras depois, uma por segundo.
    await pool.query(
      `UPDATE messages SET created_at = CASE WHEN substring(msg from 2)::int <= 20 THEN timestamptz '2026-11-19 10:00:00.123+00'
         ELSE timestamptz '2026-11-19 10:05:00+00' + substring(msg from 2)::int * interval '1 second' END
       WHERE room_id = $1 AND msg ~ '^m[0-9]+$'`,
      [ch._id],
    );
    const page = async (q: Record<string, string | number>) => (await api('GET', 'channels.history', { roomId: ch._id, count: 15, ...q }, A)).messages.filter((x: any) => !x.t);
    // Para cima, como a web: a mais antiga carregada é o limite.
    const up: any[] = await page({});
    for (let more = await page({ latest: up[up.length - 1].ts, latestId: up[up.length - 1]._id }); more.length; ) {
      up.push(...more);
      more = await page({ latest: up[up.length - 1].ts, latestId: up[up.length - 1]._id });
    }
    expect(new Set(up.map((x) => x.msg)).size).toBe(60);
    expect(up).toHaveLength(60);
    // Para baixo, a partir de uma do meio do bloco (link para mensagem antiga).
    const around = (await api('GET', 'chat.getMessagesAround', { msgId: ids[4], count: 5 }, A)).messages.filter((x: any) => !x.t);
    const down: any[] = around.slice().reverse();
    for (;;) {
      const last = down[down.length - 1];
      const more = (await api('GET', 'channels.history', { roomId: ch._id, count: 15, oldest: last.ts, oldestId: last._id }, A)).messages.filter((x: any) => !x.t).reverse();
      if (!more.length) break;
      down.push(...more);
    }
    expect(new Set(down.map((x) => x.msg)).size).toBe(down.length);
    expect(down.map((x) => x.msg)).toEqual(expect.arrayContaining(ids.slice(20).map((_, i) => `m${i + 21}`)));
    // As mesmas, na ordem: a lista para baixo é a lista para cima ao contrário, a partir da mensagem aberta.
    const order = up.map((x) => x._id).reverse();
    expect(down.map((x) => x._id)).toEqual(order.slice(order.indexOf(down[0]._id)));
  });
});

describe('reações', () => {
  it('guardam a hora da primeira de cada emoji (a ordem em que apareceram) e só quem é da sala reage', async () => {
    const bruno = await newUser(A);
    const carla = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `reacoes-${uniq()}`, members: [bruno.username] }, A)).channel;
    const m = (await send(A, ch._id, 'ordem das reações')).message;
    for (const e of ['tada', 'heart', '+1']) expect((await api('POST', 'chat.react', { messageId: m._id, emoji: e }, A)).success).toBe(true);
    const r1 = (await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions;
    const order = (rs: Record<string, { ts?: string }>) => Object.entries(rs).sort(([, a], [, b]) => (a.ts ?? '').localeCompare(b.ts ?? '')).map(([k]) => k);
    expect(order(r1)).toEqual([':tada:', ':heart:', ':+1:']);
    // Mais alguém na mesma reação (e depois saindo dela) não muda a hora nem a ordem.
    await api('POST', 'chat.react', { messageId: m._id, emoji: 'tada' }, bruno);
    const r2 = (await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions;
    expect(r2[':tada:']).toEqual({ usernames: [A.username, bruno.username], ts: r1[':tada:'].ts });
    await api('POST', 'chat.react', { messageId: m._id, emoji: 'tada' }, A);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions[':tada:']).toEqual({ usernames: [bruno.username], ts: r1[':tada:'].ts });
    // Carla só visualiza o canal: reagir pede para entrar, como enviar.
    const no = await api('POST', 'chat.react', { messageId: m._id, emoji: '+1' }, carla);
    expect([no.status, no.error]).toEqual([403, 'Você precisa entrar na sala para reagir.']);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions[':+1:'].usernames).toEqual([A.username]);
    await api('POST', 'channels.join', { roomId: ch._id }, carla);
    expect((await api('POST', 'chat.react', { messageId: m._id, emoji: '+1' }, carla)).success).toBe(true);
    // Quem saiu ainda tira a própria reação.
    await api('POST', 'channels.leave', { roomId: ch._id }, carla);
    expect((await api('POST', 'chat.react', { messageId: m._id, emoji: '+1' }, carla)).success).toBe(true);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions[':+1:'].usernames).toEqual([A.username]);
  });
});

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

const upload = async (auth: Auth, rid: string, file: { body: BlobPart[]; name: string; type: string }, fields: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob(file.body, { type: file.type }), file.name);
  return api('POST', `rooms.upload/${rid}`, fd, auth);
};

describe('parâmetros inválidos na API de mensagens', () => {
  it('count e datas que não são número ou data respondem 400 (antes, erro 500)', async () => {
    const ch = (await api('POST', 'channels.create', { name: `params-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'base')).message;
    for (const [path, q] of [
      ['channels.history', { roomId: ch._id, count: 'abc' }],
      ['channels.history', { roomId: ch._id, latest: 'ontem' }],
      ['channels.history', { roomId: ch._id, oldest: 'amanhã' }],
      ['chat.getMessagesAround', { msgId: m._id, count: 'abc' }],
      ['chat.getThreadMessages', { tmid: m._id, count: 'abc' }],
      ['chat.syncMessages', { roomId: ch._id, lastUpdate: 'x' }],
    ] as const) {
      const r = await api('GET', path, q, A);
      expect([path, r.status, r.errorType]).toEqual([path, 400, 'error-invalid-params']);
      expect(r.error).toMatch(/^O parâmetro "(count|latest|oldest|lastUpdate)" deve ser/);
    }
    // Fora dos limites vale o limite; data ISO segue valendo.
    expect((await api('GET', 'chat.getMessagesAround', { msgId: m._id, count: '-5' }, A)).messages.map((x: any) => x._id)).toContain(m._id);
    expect((await api('GET', 'channels.history', { roomId: ch._id, count: '0' }, A)).messages).toHaveLength(1);
    expect((await api('GET', 'channels.history', { roomId: ch._id, latest: new Date(Date.now() + 60000).toISOString() }, A)).status).toBe(200);
  });

  it('msg que não é texto responde 400', async () => {
    const ch = (await api('POST', 'channels.create', { name: `msg-tipo-${uniq()}` }, A)).channel;
    for (const msg of [123, { a: 1 }, ['x']]) {
      const r = await api('POST', 'chat.sendMessage', { message: { rid: ch._id, msg } }, A);
      expect([r.status, r.errorType, r.error]).toEqual([400, 'error-invalid-params', 'A mensagem precisa ser texto.']);
    }
    expect((await api('POST', 'chat.postMessage', { roomId: ch._id, text: 5 }, A)).status).toBe(400);
  });
});

describe('o que a API aceita numa mensagem', () => {
  it('edição só com espaços é recusada; arquivo sem legenda continua', async () => {
    const ch = (await api('POST', 'channels.create', { name: `edita-vazio-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'texto')).message;
    const r = await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: '   ' }, A);
    expect([r.status, r.error]).toEqual([400, 'Mensagem vazia.']);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message).toMatchObject({ msg: 'texto', editedAt: null });
    // Num arquivo, tirar a legenda é permitido (o arquivo fica).
    const f = (await upload(A, ch._id, { body: ['x'], name: 'nota.txt', type: 'text/plain' }, { msg: 'legenda' })).message;
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: f._id, text: '' }, A)).message.msg).toBe('');
  });

  it('salvar sem mudar o texto não marca "editada" nem guarda versão', async () => {
    const ch = (await api('POST', 'channels.create', { name: `sem-mudanca-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'igual')).message;
    const r = await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: '  igual ' }, A);
    expect(r.status).toBe(200);
    expect(r.message.editedAt).toBeNull();
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.editedAt).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM message_history WHERE message_id = $1', [m._id])).rows[0].n).toBe(0);
    expect((await api('POST', 'chat.update', { roomId: ch._id, msgId: m._id, text: 'outro' }, A)).message.editedAt).toBeTruthy();
  });

  it('emoji no lugar da foto só com a permissão de personificar; customFields com limite', async () => {
    const u = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `emoji-${uniq()}`, members: [u.username] }, A)).channel;
    const e = await send(u, ch._id, 'oi', { emoji: ':crown:' });
    expect([e.status, e.error]).toEqual([403, 'Sem permissão para personificar.']);
    const big = await send(u, ch._id, 'oi', { customFields: { big: 'x'.repeat(200000) } });
    expect([big.status, big.errorType]).toEqual([400, 'error-invalid-params']);
    expect((await send(u, ch._id, 'oi', { customFields: 'texto' })).status).toBe(400);
    const okCf = await send(u, ch._id, 'oi', { customFields: { pedido: '123' } });
    expect(okCf.message.customFields).toEqual({ pedido: '123' });
  });

  it('reação nova só com emoji que existe', async () => {
    const ch = (await api('POST', 'channels.create', { name: `reacao-${uniq()}` }, A)).channel;
    const m = (await send(A, ch._id, 'reaja')).message;
    const bad = await api('POST', 'chat.react', { messageId: m._id, emoji: ':isso_nao_existe:' }, A);
    expect([bad.status, bad.errorType]).toEqual([400, 'error-invalid-emoji']);
    expect((await api('POST', 'chat.react', { messageId: m._id, emoji: ':thumbsup:' }, A)).status).toBe(200);
    expect(Object.keys((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions)).toEqual([':thumbsup:']);
    // Reação antiga (importada) com um código que não está na lista: dá para entrar e sair dela.
    await pool.query(`UPDATE messages SET reactions = '{":velho:": {"usernames": ["fulano"]}}' WHERE id = $1`, [m._id]);
    expect((await api('POST', 'chat.react', { messageId: m._id, emoji: ':velho:' }, A)).status).toBe(200);
    expect((await api('GET', 'chat.getMessage', { msgId: m._id }, A)).message.reactions[':velho:'].usernames).toEqual(['fulano', A.username]);
  });
});

describe('filtro de palavrões', () => {
  it('pega palavras com acento, em maiúsculas, e a legenda de arquivos', async () => {
    const ch = (await api('POST', 'channels.create', { name: `palavroes-${uniq()}` }, A)).channel;
    await withSettings({ Message_AllowBadWordsFilter: true, Message_BadWordsFilterList: 'bobo, babaca, mané, otário, égua' }, async () => {
      const cases: [string, string][] = [
        ['você é bobo', 'você é ****'],
        ['deixa de ser mané', 'deixa de ser ****'],
        ['filho de égua!', 'filho de ****!'],
        ['MANÉ', '****'],
        ['que otário', 'que ******'],
        ['manézinho e bobão ficam', 'manézinho e bobão ficam'],
      ];
      for (const [msg, out] of cases) expect((await send(A, ch._id, msg)).message.msg).toBe(out);
      const f = await upload(A, ch._id, { body: ['x'], name: 'a.txt', type: 'text/plain' }, { description: 'seu babaca' });
      expect(f.message.msg).toBe('seu ******');
      // Outro cliente com msg e description: a description fica no anexo, também filtrada.
      const g = await upload(A, ch._id, { body: ['x'], name: 'b.txt', type: 'text/plain' }, { msg: 'segue', description: 'seu babaca' });
      expect(g.message.attachments[0].description).toBe('seu ******');
    });
  });
});

describe('arquivos enviados', () => {
  it('a legenda vira o texto da mensagem: menções, limite e edição', async () => {
    const bruno = await newUser(A);
    const ch = (await api('POST', 'channels.create', { name: `legenda-${uniq()}`, members: [bruno.username] }, A)).channel;
    const up = await upload(A, ch._id, { body: ['png'], name: 'grafico.png', type: 'image/png' }, { description: `Gráfico de setembro @${bruno.username} **urgente**` });
    expect(up.message.msg).toBe(`Gráfico de setembro @${bruno.username} **urgente**`);
    expect(up.message.mentions.map((x: any) => x.username)).toEqual([bruno.username]);
    expect(up.message.attachments[0].description).toBeUndefined();
    const ed = await api('POST', 'chat.update', { roomId: ch._id, msgId: up.message._id, text: 'Gráfico de outubro' }, A);
    expect(ed.message.msg).toBe('Gráfico de outubro');
    const long = await upload(A, ch._id, { body: ['x'], name: 'c.txt', type: 'text/plain' }, { description: 'a'.repeat(20000) });
    expect([long.status, long.errorType]).toEqual([400, 'error-message-size-exceeded']);
    expect((await pool.query('SELECT count(*)::int AS n FROM files WHERE room_id = $1', [ch._id])).rows[0].n).toBe(1);
  });

  it('legenda antiga (no anexo): editar passa o texto para a mensagem, sem repetir', async () => {
    const ch = (await api('POST', 'channels.create', { name: `legenda-antiga-${uniq()}` }, A)).channel;
    const up = (await upload(A, ch._id, { body: ['x'], name: 'd.txt', type: 'text/plain' }, { description: 'legenda' })).message;
    // Como as mensagens de antes da correção: texto vazio e a legenda no anexo.
    await pool.query(`UPDATE messages SET msg = '', attachments = jsonb_set(attachments, '{0,description}', '"Gráfico de setembro"') WHERE id = $1`, [up._id]);
    const ed = await api('POST', 'chat.update', { roomId: ch._id, msgId: up._id, text: 'Gráfico de outubro' }, A);
    expect(ed.message.msg).toBe('Gráfico de outubro');
    expect(ed.message.attachments[0].description).toBeUndefined();
    expect(ed.message.attachments[0].title).toBe('d.txt');
  });

  it('arquivo vazio é recusado e os erros dizem qual arquivo', async () => {
    const ch = (await api('POST', 'channels.create', { name: `vazio-${uniq()}` }, A)).channel;
    const empty = await upload(A, ch._id, { body: [], name: 'vazio.png', type: 'image/png' });
    expect([empty.status, empty.errorType, empty.error]).toEqual([400, 'error-file-empty', 'O arquivo “vazio.png” está vazio.']);
    await withSettings({ FileUpload_MediaTypeBlackList: 'application/zip', FileUpload_MaxFileSize: 1024 }, async () => {
      const zip = await upload(A, ch._id, { body: ['PK'], name: 'backup.zip', type: 'application/zip' });
      expect([zip.status, zip.error]).toEqual([400, 'O tipo do arquivo “backup.zip” não é permitido.']);
      const big = await upload(A, ch._id, { body: ['x'.repeat(5000)], name: 'planilha-grande.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      expect([big.status, big.errorType, big.error]).toEqual([400, 'error-file-too-large', 'O arquivo “planilha-grande.xlsx” é maior que o permitido (1 KB).']);
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM files WHERE room_id = $1', [ch._id])).rows[0].n).toBe(0);
  });

  it('nome longo é encurtado sem perder a extensão', async () => {
    const ch = (await api('POST', 'channels.create', { name: `nome-longo-${uniq()}` }, A)).channel;
    const name = `Relatório trimestral de indicadores operacionais ${'muito longo '.repeat(15)}final.pdf`;
    expect(name.length).toBeGreaterThan(200);
    const up = await upload(A, ch._id, { body: ['%PDF'], name, type: 'application/pdf' });
    const stored = up.message.files[0].name as string;
    expect(stored.endsWith('.pdf')).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(200);
    expect(stored.startsWith('Relatório trimestral de indicadores operacionais muito longo')).toBe(true);
    expect(up.message.attachments[0]).toMatchObject({ title: stored, format: 'PDF' });
  });
});

describe('comandos de barra', () => {
  it('/shrug sai com uma barra só', async () => {
    const ch = (await api('POST', 'channels.create', { name: `shrug-${uniq()}` }, A)).channel;
    expect((await send(A, ch._id, '/shrug')).message.msg).toBe('¯\\_(ツ)_/¯');
    expect((await send(A, ch._id, '/shrug tanto faz')).message.msg).toBe('tanto faz ¯\\_(ツ)_/¯');
  });

  it('sem o @usuário (ou sem a ação do /me) diz como usar; /status e /msg confirmam', async () => {
    const bruno = await newUser(A, { name: 'Bruno Lima' });
    const ch = (await api('POST', 'channels.create', { name: `uso-${uniq()}` }, A)).channel;
    for (const cmd of ['kick', 'invite', 'mute', 'unmute']) {
      const r = await send(A, ch._id, `/${cmd}`);
      expect([cmd, r.status, r.error]).toEqual([cmd, 400, `Informe quem: /${cmd} @usuário`]);
    }
    const me = await send(A, ch._id, '/me');
    expect([me.status, me.error]).toEqual([400, 'Informe a ação: /me está chegando']);
    expect((await api('GET', 'channels.history', { roomId: ch._id, count: 50 }, A)).messages.filter((x: any) => !x.t)).toHaveLength(0);
    const st = await send(A, ch._id, '/status Em reunião');
    expect(st.message).toMatchObject({ ok: true, command: 'status', text: 'Status alterado para “Em reunião”.' });
    const dm = await send(A, ch._id, `/msg @${bruno.username} oi`);
    expect(dm.message).toMatchObject({ ok: true, command: 'msg', text: 'Mensagem enviada para Bruno Lima.', rid: expect.any(String) });
    const run = await api('POST', 'commands.run', { roomId: ch._id, command: 'status', params: '' }, A);
    expect(run.result.text).toBe('Mensagem de status removida.');
  });
});
