import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { mentionNames, nameFromUsername, runConversion, sanitizeRoomName, sanitizeUsername } from '../src/importer/converter';
import { DIRECT_MESSAGES_ID, ST, roomToken, userToken, type ImportOptions, type ProgressSink, type ShortSelection } from '../src/importer/types';
import { newId } from '../src/lib/ids';
import { hashPassword } from '../src/lib/password';
import { trimEndChars, truncate } from '../src/lib/text';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// E-mails vão para uma caixa de saída em memória.
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string; html?: string }[]);
vi.mock('../src/services/mailer', () => ({
  sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => (outbox.push(m), true),
}));

let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

type Rec = { type: 'user' | 'channel' | 'message' | 'contact'; data: any };
const U = (data: any): Rec => ({ type: 'user', data });
const C = (data: any): Rec => ({ type: 'channel', data: { users: [], ...data } });
const M = (data: any): Rec => ({ type: 'message', data });
const K = (data: any): Rec => ({ type: 'contact', data: { emails: [], phones: [], ...data } });
const ALL: ShortSelection = { users: { all: true }, channels: { all: true }, contacts: { all: true } };

let seq = 0;
const tag = () => `${++seq}${Math.random().toString(36).slice(2, 6)}`;

// Importação de teste: grava a operação e os registros direto no banco, como a leitura do arquivo faria.
async function stage(recs: Rec[]) {
  const opId = newId();
  await pool.query('UPDATE import_operations SET valid = false WHERE valid');
  await pool.query(`INSERT INTO import_operations (id, importer_key, status, user_id) VALUES ($1, 'csv', $2, $3)`, [opId, ST.importingStarted, A.userId]);
  for (const r of recs) {
    const importId = r.type === 'message' ? null : (r.data.importIds?.[0] ?? null);
    await pool.query('INSERT INTO import_records (operation_id, data_type, import_id, data) VALUES ($1,$2,$3,$4)', [opId, r.type, importId, JSON.stringify(r.data)]);
  }
  return opId;
}

function fakeSink(cancelAfter?: number, throwAt?: string) {
  const s = { steps: [] as string[], completed: 0, error: 0, skipped: 0, stop: false };
  const sink: ProgressSink = {
    async step(st) {
      s.steps.push(st);
      // Simula o servidor caindo nesse passo.
      if (st === throwAt) throw new Error('queda simulada');
    },
    inc(d) {
      s.completed += d.completed ?? 0;
      s.error += d.error ?? 0;
      s.skipped += d.skipped ?? 0;
      if (cancelAfter !== undefined && s.completed >= cancelAfter) s.stop = true;
    },
    async flush() {},
    cancelled: () => s.stop,
  };
  return { s, sink };
}

async function convert(recs: Rec[], opts: { selection?: ShortSelection; options?: ImportOptions; actor?: Auth; cancelAfter?: number; throwAt?: string } = {}) {
  const opId = await stage(recs);
  const { s, sink } = fakeSink(opts.cancelAfter, opts.throwAt);
  const actor = opts.actor ?? A;
  const result = await runConversion({ operationId: opId, actor: { userId: actor.userId, username: actor.username }, selection: opts.selection ?? ALL, options: opts.options ?? {}, sink });
  return { opId, result, s };
}

const row = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const userByName = (username: string) => row('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
const mapped = (kind: string, importId: string) => row('SELECT target_id FROM import_map WHERE kind = $1 AND import_id = $2', [kind, importId]).then((r) => r?.target_id ?? null);
const errorsOf = async (opId: string) =>
  Object.fromEntries((await rows(`SELECT import_id, data, errors FROM import_records WHERE operation_id = $1 AND errors <> '[]'`, [opId])).map((r) => [r.import_id ?? r.data.importId ?? r.data.msg, r.errors]));
const roomMessages = (rid: string) => rows('SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at', [rid]);
const membersOf = async (rid: string) => (await rows('SELECT u.username FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.room_id = $1', [rid])).map((r) => r.username).sort();
const geralId = async () => (await row(`SELECT id FROM rooms WHERE is_default AND t = 'c' ORDER BY created_at LIMIT 1`)).id;

describe('nomes', () => {
  it('ajusta nomes de usuário e de sala ao formato aceito aqui', () => {
    expect(sanitizeUsername('joao.silva')).toBe('joao.silva');
    expect(sanitizeUsername('João da Silva')).toBe('Joao.da.Silva');
    expect(sanitizeUsername('  ana -- souza!! ')).toBe('ana.souza');
    expect(sanitizeUsername('@@x')).toBe('x');
    expect(sanitizeUsername('a'.repeat(50))).toHaveLength(40);
    expect(nameFromUsername('john.doe')).toBe('John Doe');
    expect(nameFromUsername('maria_silva')).toBe('Maria_silva');
    expect(sanitizeRoomName('Equipe de Vendas!')).toBe('Equipe-de-Vendas');
    expect(sanitizeRoomName('ação')).toBe('ação');
    expect(sanitizeRoomName('日本')).toBe('');
    expect(sanitizeRoomName('x'.repeat(70))).toHaveLength(64);
  });

  it('corta texto por caractere, sem deixar metade de um emoji', () => {
    expect(truncate('x'.repeat(199) + '😀 resto', 200)).toBe('x'.repeat(199) + '😀');
    expect(truncate('😀😀😀', 2)).toBe('😀😀');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('ab', 0)).toBe('');
    // Metade solta que já vinha no texto vira U+FFFD (o jsonb recusaria).
    expect(truncate('a\ud83d', 5)).toBe('a\ufffd');
    expect(truncate('\ude00b', 5)).toBe('\ufffdb');
    expect(JSON.parse(JSON.stringify(truncate('y'.repeat(4999) + '🚀', 5000)))).toBe('y'.repeat(4999) + '🚀');
  });

  it('menção com uma sequência enorme de pontos não trava a importação (tempo linear)', () => {
    const big = '@' + '.'.repeat(1_000_000) + 'a';
    const start = performance.now();
    const found = mentionNames(`${big} @${'b'.repeat(10)}.... ${'@'.repeat(1_000_000)}`);
    expect(trimEndChars('a' + '.'.repeat(1_000_000), '.')).toBe('a');
    expect(truncate('😀'.repeat(1_000_000), 999_999)).toHaveLength(1_999_998);
    expect(performance.now() - start).toBeLessThan(500);
    expect(found.users.size).toBe(2);
    expect(found.users.has('b'.repeat(10))).toBe(true);
  });
});

describe('usuários', () => {
  it('cria contas novas e junta às existentes por e-mail ou nome de usuário, sem trocar nome de usuário, e-mail ou senha', async () => {
    const t = tag();
    const byEmail = await newUser(A);
    const byName = await newUser(A);
    await pool.query('UPDATE users SET name = username WHERE id = $1', [byName.userId]);
    const { opId, result, s } = await convert([
      U({ importIds: [`e-${t}`], emails: [`${byEmail.username.toUpperCase()}@TEST.LOCAL`], username: `outro-${t}`, name: 'Nome Novo', roles: ['livechat-agent', 'nao-existe', 'owner'], bio: 'Bio importada' }),
      U({ importIds: [`n-${t}`], emails: [], username: byName.username.toUpperCase(), name: 'Nome Do Slack', statusText: 'Ocupado' }),
      U({ importIds: [`new-${t}`], emails: [`novo-${t}@x.com`], username: `novo.${t}`, name: 'Pessoa Nova', avatarUrl: 'https://img.example/a.png', roles: ['admin'] }),
      U({ importIds: [`bad-${t}`], emails: [] }),
    ]);
    expect(result.users).toEqual({ inserted: 1, updated: 2, failed: 1, skipped: 0 });
    expect(s).toMatchObject({ completed: 3, error: 1, skipped: 0 });
    expect(s.steps[0]).toBe(ST.importingUsers);

    const e = await row('SELECT * FROM users WHERE id = $1', [byEmail.userId]);
    expect(e.username).toBe(byEmail.username);
    expect(e.email).toBe(`${byEmail.username}@test.local`);
    expect(e.name).toMatch(/^Usuário/);
    expect(e.roles).toEqual(['user', 'livechat-agent']);
    expect(e.bio).toBe('Bio importada');
    expect((await login(byEmail.username, 'senha-forte-1')).userId).toBe(byEmail.userId);

    const n = await row('SELECT * FROM users WHERE id = $1', [byName.userId]);
    expect(n.username).toBe(byName.username);
    expect(n.name).toBe('Nome Do Slack');
    expect(n.status_text).toBe('Ocupado');

    const nu = await userByName(`novo.${t}`);
    expect(nu).toMatchObject({ email: `novo-${t}@x.com`, email_verified: false, password_hash: null, active: true, type: 'user', auth_source: 'local', require_password_change: false, name: 'Pessoa Nova' });
    expect(nu.roles).toEqual(['user', 'admin']);
    expect(await mapped('user', `new-${t}`)).toBe(nu.id);
    expect(await mapped('user', `e-${t}`)).toBe(byEmail.userId);
    expect(await mapped('user', `n-${t}`)).toBe(byName.userId);
    expect(await row('SELECT url, status FROM import_pending_avatars WHERE user_id = $1', [nu.id])).toEqual({ url: 'https://img.example/a.png', status: 'pending' });
    // Canal padrão, sem mensagem de sistema e já lido.
    const geral = await geralId();
    const sub = await row('SELECT * FROM subscriptions WHERE room_id = $1 AND user_id = $2', [geral, nu.id]);
    expect(sub).toMatchObject({ unread: 0, alert: false, open: true });
    expect(sub.ls).toBeTruthy();
    expect(await row(`SELECT 1 FROM messages WHERE room_id = $1 AND t = 'uj' AND user_id = $2`, [geral, nu.id])).toBeUndefined();
    const g = await row('SELECT users_count, (SELECT count(*)::int FROM subscriptions WHERE room_id = $1) AS n FROM rooms WHERE id = $1', [geral]);
    expect(g.users_count).toBe(g.n);

    expect((await errorsOf(opId))[`bad-${t}`]).toEqual(['Usuário sem e-mail e sem nome de usuário.']);
  });

  it('desativa contas excluídas na origem só quando ligadas a ela por uma importação anterior, menos a de quem importa e a do último administrador', async () => {
    const t = tag();
    const actor = await newUser(A);
    const victim = await newUser(A);
    const off = await newUser(A);
    const byName = await newUser(A);
    await api('POST', 'users.update', { userId: off.userId, data: { active: false } }, A);
    // Só o "admin" é administrador ativo.
    await pool.query(`UPDATE users SET active = false WHERE 'admin' = ANY(roles) AND username <> 'admin'`);

    // Encontrada agora só pelo nome de usuário: não é desativada.
    const first = await convert(
      [
        U({ importIds: [`a-${t}`], emails: [], username: 'admin' }),
        U({ importIds: [`s-${t}`], emails: [], username: actor.username }),
        U({ importIds: [`v-${t}`], emails: [], username: victim.username }),
        U({ importIds: [`o-${t}`], emails: [], username: off.username }),
        U({ importIds: [`n-${t}`], emails: [], username: byName.username, deleted: true }),
      ],
      { actor },
    );
    expect((await userByName(byName.username)).active).toBe(true);
    expect((await errorsOf(first.opId))[`n-${t}`]).toEqual([
      'A conta não foi desativada: ela foi encontrada pelo e-mail ou pelo nome de usuário, e não por uma importação anterior desta origem.',
    ]);

    // Reimportação da mesma origem: as contas ligadas pelo import_map são desativadas.
    const { opId, result } = await convert(
      [
        U({ importIds: [`a-${t}`], emails: [], username: 'admin', deleted: true }),
        U({ importIds: [`s-${t}`], emails: [], username: actor.username, deleted: true }),
        U({ importIds: [`v-${t}`], emails: [], username: victim.username, deleted: true }),
        U({ importIds: [`o-${t}`], emails: [], username: off.username, deleted: false }),
      ],
      { actor },
    );
    expect(result.users).toMatchObject({ updated: 4, failed: 0 });
    expect((await userByName('admin')).active).toBe(true);
    expect((await userByName(actor.username)).active).toBe(true);
    expect((await userByName(victim.username)).active).toBe(false);
    // Desativada pela importação continua desativada; e a sessão de quem foi desativado acaba.
    expect((await userByName(off.username)).active).toBe(false);
    expect((await api('GET', 'me', undefined, victim)).status).toBe(401);
    const errs = await errorsOf(opId);
    expect(errs[`a-${t}`]).toEqual(['A conta não foi desativada: é a do último administrador ativo.']);
    expect(errs[`s-${t}`]).toEqual(['A conta não foi desativada: é a de quem está fazendo a importação.']);

    // Quem importa nunca se desativa, mesmo sendo administrador.
    const again = await convert([U({ importIds: [`a2-${t}`], emails: [], username: 'admin', deleted: true })]);
    expect((await userByName('admin')).active).toBe(true);
    expect((await errorsOf(again.opId))[`a2-${t}`]).toEqual(['A conta não foi desativada: é a de quem está fazendo a importação.']);
  });

  it('papel de administrador vindo do arquivo: só para conta nova e só quando quem importa pode dar esse papel', async () => {
    const t = tag();
    const eve = await newUser(A);
    const plain = await newUser(A);
    const { opId } = await convert(
      [
        U({ importIds: [`E-${t}`], emails: [], username: eve.username, roles: ['admin', 'livechat-agent'] }),
        U({ importIds: [`N-${t}`], emails: [`dono-${t}@fora.example`], username: `dono${t}`, roles: ['admin'] }),
        U({ importIds: [`X-${t}`], emails: [], username: `papel${t}`, roles: ['nao-existe', 'owner'] }),
      ],
      { actor: plain },
    );
    // Conta que já existia, encontrada pelo nome: ganha os outros papéis, nunca o de administrador.
    expect((await userByName(eve.username)).roles).toEqual(['user', 'livechat-agent']);
    // Conta nova, mas quem importa não tem assign-admin-role.
    expect((await userByName(`dono${t}`)).roles).toEqual(['user']);
    expect((await userByName(`papel${t}`)).roles).toEqual(['user']);
    const errs = await errorsOf(opId);
    expect(errs[`E-${t}`]).toEqual(['O papel de administrador não foi dado: a conta já existia.']);
    expect(errs[`N-${t}`]).toEqual(['O papel de administrador não foi dado: quem importa não tem a permissão para dar esse papel.']);
    expect(errs[`X-${t}`]).toEqual(['Papel "nao-existe" ignorado: não existe aqui.', 'Papel "owner" ignorado: vale só dentro de uma sala.']);

    // Quem importa pode dar o papel: só a conta nova vira administradora.
    const again = await convert([
      U({ importIds: [`N2-${t}`], emails: [], username: `chefe${t}`, roles: ['admin'] }),
      U({ importIds: [`E2-${t}`], emails: [], username: eve.username, roles: ['admin'] }),
      U({ importIds: [`E-${t}`], emails: [], username: eve.username, roles: ['admin'] }),
    ]);
    expect((await userByName(`chefe${t}`)).roles).toEqual(['user', 'admin']);
    expect((await userByName(eve.username)).roles).toEqual(['user', 'livechat-agent']);
    expect((await errorsOf(again.opId))[`E-${t}`]).toEqual(['O papel de administrador não foi dado: a conta já existia.']);
  });

  it('mesmo nome de usuário com outro e-mail ou outro tipo de conta vira outra conta, com aviso', async () => {
    const t = tag();
    const joao = await newUser(A);
    const semEmail = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [semEmail.userId]);
    const porEmail = await newUser(A);
    await convert([U({ importIds: [`R0-${t}`], emails: [], username: `robo${t}`, type: 'bot' })]);
    const robo = await userByName(`robo${t}`);
    const { opId, result } = await convert([
      U({ importIds: [`J-${t}`], emails: [`joao.silva-${t}@corp.example`], username: joao.username, name: 'João Silva' }),
      U({ importIds: [`R-${t}`], emails: [], username: `robo${t}`, name: 'Pessoa Robo' }),
      U({ importIds: [`B-${t}`], emails: [], username: joao.username, type: 'bot' }),
      // Sem e-mail de um dos lados: é a mesma pessoa.
      U({ importIds: [`K-${t}`], emails: [], username: joao.username, bio: 'Mesmo João' }),
      U({ importIds: [`S-${t}`], emails: [`sem-${t}@corp.example`], username: semEmail.username }),
      // Qualquer um dos e-mails do arquivo serve para achar a conta.
      U({ importIds: [`M-${t}`], emails: [`outro-${t}@corp.example`, `${porEmail.username.toUpperCase()}@test.local`], username: `qualquer${t}` }),
    ]);
    expect(result.users).toMatchObject({ inserted: 3, updated: 3, failed: 0 });
    const j = await row('SELECT * FROM users WHERE id = $1', [joao.userId]);
    expect(j).toMatchObject({ email: `${joao.username}@test.local`, roles: ['user'], bio: 'Mesmo João' });
    const j2 = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `J-${t}`)]);
    expect(j2).toMatchObject({ username: `${joao.username}.2`, email: `joao.silva-${t}@corp.example`, name: 'João Silva', type: 'user' });
    const r2 = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `R-${t}`)]);
    expect(r2).toMatchObject({ username: `robo${t}.2`, type: 'user' });
    expect(r2.id).not.toBe(robo.id);
    const b2 = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `B-${t}`)]);
    expect(b2).toMatchObject({ username: `${joao.username}.3`, type: 'bot' });
    expect(await mapped('user', `K-${t}`)).toBe(joao.userId);
    expect(await mapped('user', `S-${t}`)).toBe(semEmail.userId);
    expect(await mapped('user', `M-${t}`)).toBe(porEmail.userId);
    const errs = await errorsOf(opId);
    expect(errs[`J-${t}`]).toEqual([`O usuário "${joao.username}" já existe com outro e-mail; importado como "${joao.username}.2".`]);
    expect(errs[`R-${t}`]).toEqual([`O usuário "robo${t}" já existe e é um bot; importado como "robo${t}.2".`]);
    expect(errs[`B-${t}`]).toEqual([`O usuário "${joao.username}" já existe e não é um bot; importado como "${joao.username}.3".`]);
    expect(errs[`K-${t}`]).toBeUndefined();

    // Reimportação: a conta nova continua ligada pelo import_map, sem aviso de novo.
    const again = await convert([U({ importIds: [`J-${t}`], emails: [`joao.silva-${t}@corp.example`], username: joao.username })]);
    expect(again.result.users).toMatchObject({ inserted: 0, updated: 1 });
    expect(await errorsOf(again.opId)).toEqual({});
  });

  it('não desativa o último administrador que consegue entrar, mesmo com um bot administrador criado pelo mesmo arquivo', async () => {
    const t = tag();
    // Quem importa pode dar o papel de admin, mas não consegue entrar (sem senha): não conta como administrador.
    const actor = await newUser(A, { roles: ['user', 'admin'] });
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [actor.userId]);
    await pool.query(`UPDATE users SET active = false WHERE 'admin' = ANY(roles) AND username <> 'admin' AND id <> $1`, [actor.userId]);
    try {
      await convert([U({ importIds: [`UA-${t}`], emails: [], username: 'admin' })], { actor });
      const { opId } = await convert(
        [
          U({ importIds: [`B-${t}`], emails: [], username: `integracao${t}`, type: 'bot', roles: ['admin'] }),
          U({ importIds: [`UA-${t}`], emails: [], username: 'admin', deleted: true }),
        ],
        { actor },
      );
      expect((await userByName(`integracao${t}`)).roles).toEqual(['bot', 'admin']);
      expect((await userByName('admin')).active).toBe(true);
      expect((await errorsOf(opId))[`UA-${t}`]).toEqual(['A conta não foi desativada: é a do último administrador ativo.']);
      // A sessão do admin continua valendo.
      expect((await api('GET', 'me', undefined, A)).username).toBe('admin');
    } finally {
      await pool.query(`UPDATE users SET active = false WHERE id = $1 OR username = $2`, [actor.userId, `integracao${t}`]);
    }
  });

  it('não desativa a conta encontrada pelo nome neste mesmo arquivo, nem quando o id volta em outro lote', async () => {
    const t = tag();
    const victim = await newUser(A);
    // 500 registros por lote: o segundo registro com o mesmo id cai no lote seguinte.
    const fillers = Array.from({ length: 500 }, (_, i) => U({ importIds: [`F${i}-${t}`], emails: [], username: `fill${i}x${t}` }));
    const { opId } = await convert([
      U({ importIds: [`X-${t}`], emails: [], username: victim.username }),
      ...fillers,
      U({ importIds: [`X-${t}`], emails: [], username: victim.username, deleted: true }),
    ]);
    expect((await row('SELECT active FROM users WHERE id = $1', [victim.userId])).active).toBe(true);
    expect((await errorsOf(opId))[`X-${t}`]).toEqual([
      'A conta não foi desativada: ela foi encontrada pelo e-mail ou pelo nome de usuário, e não por uma importação anterior desta origem.',
    ]);
    // Na importação seguinte a conta já está ligada a esta origem por uma importação anterior.
    await convert([U({ importIds: [`X-${t}`], emails: [], username: victim.username, deleted: true })]);
    expect((await row('SELECT active FROM users WHERE id = $1', [victim.userId])).active).toBe(false);
  });

  it('repetidos no mesmo lote seguem as mesmas regras dos lotes seguintes (id, e-mail e nome de usuário)', async () => {
    const t = tag();
    const { opId, result } = await convert([
      U({ importIds: [`R1-${t}`], emails: [`r1-${t}@x.example`], username: `dup${t}` }),
      // Sem e-mail e com o mesmo nome: a mesma pessoa.
      U({ importIds: [`R2-${t}`], emails: [], username: `dup${t}` }),
      // Mesmo nome com outro e-mail: outra pessoa.
      U({ importIds: [`R3-${t}`], emails: [`r3-${t}@x.example`], username: `dup${t}` }),
      // Mesmo e-mail com outro nome, e o mesmo id outra vez: a mesma pessoa.
      U({ importIds: [`R4-${t}`], emails: [`R1-${t}@X.example`], username: `outro${t}` }),
      U({ importIds: [`R1-${t}`], emails: [], username: `dup${t}` }),
    ]);
    expect(result.users).toMatchObject({ inserted: 2, updated: 3, failed: 0 });
    const r1 = await mapped('user', `R1-${t}`);
    expect(await row('SELECT username, email FROM users WHERE id = $1', [r1])).toEqual({ username: `dup${t}`, email: `r1-${t}@x.example` });
    expect(await mapped('user', `R2-${t}`)).toBe(r1);
    expect(await mapped('user', `R4-${t}`)).toBe(r1);
    expect(await row('SELECT username, email FROM users WHERE id = $1', [await mapped('user', `R3-${t}`)])).toEqual({ username: `dup${t}.2`, email: `r3-${t}@x.example` });
    expect(await errorsOf(opId)).toEqual({ [`R3-${t}`]: [`O usuário "dup${t}" já existe com outro e-mail; importado como "dup${t}.2".`] });
    expect(await userByName(`outro${t}`)).toBeUndefined();
  });

  it('usa o hash de senha guardado pelo import.addUsers só em contas novas', async () => {
    const t = tag();
    const existing = await newUser(A);
    await convert([
      U({ importIds: [`H1-${t}`], emails: [`h1-${t}@x.com`], username: `hash${t}`, passwordHash: await hashPassword('Senha-Hash-123') }),
      U({ importIds: [`H2-${t}`], emails: [], username: existing.username, passwordHash: await hashPassword('outra-senha-1') }),
      U({ importIds: [`H3-${t}`], emails: [], username: `ruim${t}`, passwordHash: 'scrypt$1' }),
    ]);
    expect((await login(`hash${t}`, 'Senha-Hash-123')).username).toBe(`hash${t}`);
    expect((await login(existing.username, 'senha-forte-1')).userId).toBe(existing.userId);
    expect((await userByName(`ruim${t}`)).password_hash).toBeNull();
  });

  it('gera nomes de usuário válidos e únicos, e respeita skipExistingUsers', async () => {
    const t = tag();
    const existing = await newUser(A);
    await pool.query('UPDATE users SET username = $2 WHERE id = $1', [existing.userId, `ana.souza${t}`]);
    const long = 'C'.repeat(45);
    const { result } = await convert([
      U({ importIds: [`u1-${t}`], emails: [], username: `Ana Souza${t}` }),
      U({ importIds: [`u2-${t}`], emails: [`p1-${t}@x.com`], name: `Pedro Lima ${t}` }),
      U({ importIds: [`u3-${t}`], emails: [`p2-${t}@x.com`], name: `Pedro Lima ${t}` }),
      U({ importIds: [`u4-${t}`], emails: [`all-${t}@x.com`], username: 'all' }),
      U({ importIds: [`u5-${t}`], emails: [`carla-${t}@x.com`] }),
      U({ importIds: [`u6-${t}`], emails: [`z-${t}@x.com`], username: 'x', name: `Zé Ninguém ${t}` }),
      U({ importIds: [`u7-${t}`], emails: [`l1-${t}@x.com`], name: long }),
      U({ importIds: [`u8-${t}`], emails: [`l2-${t}@x.com`], name: long }),
      U({ importIds: [`u9-${t}`], emails: [`invalido-${t}`], username: `sem.email.${t}` }),
      U({ importIds: [`u10-${t}`], emails: [], username: `bot.${t}`, type: 'bot', roles: ['user'] }),
    ]);
    expect(result.users).toMatchObject({ inserted: 10, failed: 0 });
    const name = async (id: string) => (await row('SELECT u.* FROM import_map m JOIN users u ON u.id = m.target_id WHERE m.kind = $1 AND m.import_id = $2', ['user', id]));
    expect((await name(`u1-${t}`)).username).toBe(`Ana.Souza${t}.2`);
    expect((await name(`u2-${t}`)).username).toBe(`pedro.lima.${t}`);
    expect((await name(`u3-${t}`)).username).toBe(`pedro.lima.${t}.2`);
    expect((await name(`u3-${t}`)).name).toBe(`Pedro Lima ${t}`);
    expect((await name(`u4-${t}`)).username).toMatch(/^all\.\d+$/);
    expect((await name(`u5-${t}`)).username).toBe(`carla-${t}`);
    expect((await name(`u5-${t}`)).name).toBe(`Carla ${t}`);
    expect((await name(`u6-${t}`)).username).toBe(`ze.ninguem.${t}`);
    expect((await name(`u7-${t}`)).username).toBe('c'.repeat(40));
    expect((await name(`u8-${t}`)).username).toBe(`${'c'.repeat(38)}.2`);
    const noEmail = await name(`u9-${t}`);
    expect(noEmail.email).toBeNull();
    expect(noEmail.name).toBe(`Sem Email ${t}`);
    const bot = await name(`u10-${t}`);
    expect(bot).toMatchObject({ type: 'bot', roles: ['bot'] });

    // import.run (API): conta que já existe é ignorada.
    const skip = await convert([U({ importIds: [`u1-${t}`], emails: [], username: `Ana Souza${t}`, name: 'Outro' }), U({ importIds: [`api-${t}`], emails: [`api-${t}@x.com`], username: `api.${t}`, password: 'segredo-123' })], {
      options: { skipExistingUsers: true },
    });
    expect(skip.result.users).toMatchObject({ inserted: 1, skipped: 1 });
    expect((await login(`api.${t}`, 'segredo-123')).username).toBe(`api.${t}`);
  });
});

describe('salas', () => {
  it('cria canais e grupos com nome ajustado, sem juntar público com privado', async () => {
    const t = tag();
    const pub = await api('POST', 'channels.create', { name: `vendas-${t}` }, A);
    expect(pub.success).toBe(true);
    const { opId, result } = await convert([
      U({ importIds: [`U1-${t}`], emails: [`c1-${t}@x.com`], username: `c1${t}` }),
      C({ importIds: [`P1-${t}`], t: 'p', name: `vendas-${t}`, users: [`U1-${t}`], creator: `U1-${t}`, topic: 'Privado', ts: '2020-05-01T10:00:00.000Z' }),
      C({ importIds: [`C2-${t}`], t: 'c', name: `Equipe de Vendas ${t}`, users: [`U1-${t}`, 'nao-existe'] }),
      C({ importIds: [`C3-${t}`], t: 'c', name: '日本', users: [] }),
      C({ importIds: [`C4-${t}`], t: 'c', name: '   ', users: [] }),
      C({ importIds: [`C5-${t}`], t: 'c', name: `arq-${t}`, users: [`U1-${t}`], archived: true }),
    ]);
    expect(result.channels).toEqual({ inserted: 4, updated: 0, failed: 1, skipped: 0 });
    const p = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `P1-${t}`)]);
    expect(p).toMatchObject({ t: 'p', name: `vendas-${t}-2`, fname: `vendas-${t}`, topic: 'Privado', archived: false, users_count: 1 });
    expect(p.created_at).toBe('2020-05-01T10:00:00.000Z');
    const owner = await row('SELECT * FROM subscriptions WHERE room_id = $1', [p.id]);
    expect(owner.roles).toEqual(['owner']);
    expect(owner.user_id).toBe((await userByName(`c1${t}`)).id);

    const c2 = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `C2-${t}`)]);
    expect(c2).toMatchObject({ t: 'c', name: `Equipe-de-Vendas-${t}`, fname: `Equipe de Vendas ${t}` });
    // Sem criador: quem importa vira o dono.
    const subs = await rows('SELECT user_id, roles FROM subscriptions WHERE room_id = $1 ORDER BY roles DESC', [c2.id]);
    expect(subs).toHaveLength(2);
    expect(subs.find((x) => x.user_id === A.userId)?.roles).toEqual(['owner']);
    expect(c2.users_count).toBe(2);

    expect((await row('SELECT name FROM rooms WHERE id = $1', [await mapped('room', `C3-${t}`)])).name).toMatch(/^sala-\d+$/);
    expect((await errorsOf(opId))[`C4-${t}`]).toEqual(['Sala sem nome.']);

    const arq = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `C5-${t}`)]);
    expect(arq.archived).toBe(true);
    const arqSubs = await rows('SELECT open, alert FROM subscriptions WHERE room_id = $1', [arq.id]);
    expect(arqSubs).toHaveLength(2);
    expect(arqSubs.every((x) => !x.open && !x.alert)).toBe(true);
    // Nenhuma mensagem de sistema de criação ou entrada.
    expect(await rows('SELECT 1 FROM messages WHERE room_id = ANY($1)', [[p.id, c2.id, arq.id]])).toEqual([]);
  });

  it('usa o canal padrão sem renomear e só acrescenta membros a salas criadas por importação', async () => {
    const t = tag();
    const old = await newUser(A);
    const other = await newUser(A);
    const geral = await geralId();
    await pool.query('DELETE FROM subscriptions WHERE room_id = $1 AND user_id = $2', [geral, old.userId]);
    const pub = await api('POST', 'channels.create', { name: `pub-${t}` }, A);
    const proj = await api('POST', 'groups.create', { name: `proj-${t}` }, A);
    const first = await convert([
      C({ importIds: [`G-${t}`], t: 'c', name: 'general', isDefault: true, topic: 'Tópico do Slack', users: [old.username] }),
      C({ importIds: [`Q-${t}`], t: 'c', name: `pub-${t}`, users: [old.username], archived: true }),
      C({ importIds: [`P-${t}`], t: 'p', name: `proj-${t}`, users: [old.username] }),
      C({ importIds: [`N-${t}`], t: 'c', name: `novo-${t}`, users: [old.username] }),
    ]);
    expect(first.result.channels).toMatchObject({ inserted: 2, updated: 2 });
    const g = await row('SELECT * FROM rooms WHERE id = $1', [geral]);
    expect(g.name).toBe('geral');
    expect(g.topic).toBe('Tópico do Slack');
    expect(await mapped('room', `G-${t}`)).toBe(geral);
    expect(await row('SELECT 1 AS ok FROM subscriptions WHERE room_id = $1 AND user_id = $2', [geral, old.userId])).toEqual({ ok: 1 });
    // Canal público que já existia, encontrado só pelo nome: recebe as mensagens, mas ninguém novo entra e não é arquivado.
    expect(await mapped('room', `Q-${t}`)).toBe(pub.channel._id);
    expect(await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [pub.channel._id])).toEqual([{ user_id: A.userId }]);
    expect((await row('SELECT archived FROM rooms WHERE id = $1', [pub.channel._id])).archived).toBe(false);
    // Grupo privado com o mesmo nome nunca se junta: vira outra sala.
    const p = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `P-${t}`)]);
    expect(p).toMatchObject({ t: 'p', name: `proj-${t}-2`, fname: `proj-${t}` });
    expect(await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [proj.group._id])).toEqual([{ user_id: A.userId }]);
    expect((await errorsOf(first.opId))[`P-${t}`]).toEqual([`Já existe uma sala com o nome "proj-${t}"; importada como "proj-${t}-2".`]);

    // Segunda importação: as salas criadas pela primeira recebem os membros novos; a encontrada pelo nome continua igual.
    const second = await convert([
      C({ importIds: [`P-${t}`], t: 'p', name: `proj-${t}`, users: [old.username, other.username] }),
      C({ importIds: [`N-${t}`], t: 'c', name: `novo-${t}`, users: [old.username, other.username] }),
      C({ importIds: [`Q-${t}`], t: 'c', name: `pub-${t}`, users: [old.username, other.username] }),
    ]);
    expect(second.result.channels).toMatchObject({ inserted: 0, updated: 3 });
    const novo = await mapped('room', `N-${t}`);
    expect((await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [novo])).map((r) => r.user_id).sort()).toEqual([A.userId, old.userId, other.userId].sort());
    expect((await row('SELECT users_count FROM rooms WHERE id = $1', [novo])).users_count).toBe(3);
    expect((await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [p.id])).map((r) => r.user_id).sort()).toEqual([A.userId, old.userId, other.userId].sort());
    // "pub" ficou mapeada na primeira, mas continua sendo uma sala que a importação não criou.
    expect(await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [pub.channel._id])).toEqual([{ user_id: A.userId }]);
    expect(await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [proj.group._id])).toEqual([{ user_id: A.userId }]);
  });

  it('grupo privado de outra origem com o mesmo nome vira outra sala, sem abrir o histórico da primeira', async () => {
    const t = tag();
    const name = `financeiro-${t}`;
    await convert([
      U({ importIds: [`W1U-${t}`], username: `ana${t}`, emails: [`ana${t}@w1.example`] }),
      C({ importIds: [`G1-${t}`], t: 'p', name, users: [`W1U-${t}`] }),
      C({ importIds: [`C1-${t}`], t: 'c', name: `pub-${name}`, users: [`W1U-${t}`] }),
      M({ importId: `s1-${t}`, rid: `G1-${t}`, u: `W1U-${t}`, msg: 'salarios w1', ts: '2020-01-01T00:00:00.000Z' }),
    ]);
    const g1 = await mapped('room', `G1-${t}`);
    const c1 = await mapped('room', `C1-${t}`);
    const before = await membersOf(g1);
    // Outra origem (outros ids), mesmos nomes, outra pessoa.
    const second = await convert([
      U({ importIds: [`W2U-${t}`], username: `bruno${t}`, emails: [`bruno${t}@w2.example`] }),
      C({ importIds: [`G9-${t}`], t: 'p', name, users: [`W2U-${t}`], archived: true }),
      C({ importIds: [`C9-${t}`], t: 'c', name: `pub-${name}`, users: [`W2U-${t}`], archived: true }),
      M({ importId: `s9-${t}`, rid: `G9-${t}`, u: `W2U-${t}`, msg: 'salarios w2', ts: '2020-01-02T00:00:00.000Z' }),
    ]);
    expect(second.result.channels).toMatchObject({ inserted: 1, updated: 1, failed: 0 });
    const g9 = await mapped('room', `G9-${t}`);
    expect(g9).not.toBe(g1);
    expect(await row('SELECT t, name, archived FROM rooms WHERE id = $1', [g9])).toEqual({ t: 'p', name: `${name}-2`, archived: true });
    expect(await membersOf(g1)).toEqual(before);
    expect((await row('SELECT archived FROM rooms WHERE id = $1', [g1])).archived).toBe(false);
    expect((await roomMessages(g1)).map((m) => m.msg)).toEqual(['salarios w1']);
    expect((await roomMessages(g9)).map((m) => m.msg)).toEqual(['salarios w2']);
    expect((await errorsOf(second.opId))[`G9-${t}`]).toEqual([`Já existe uma sala com o nome "${name}"; importada como "${name}-2".`]);
    // Canal público com o mesmo nome, criado por outra importação: junta as mensagens, sem membros novos e sem arquivar.
    expect(await mapped('room', `C9-${t}`)).toBe(c1);
    expect(await membersOf(c1)).toEqual([`ana${t}`, 'admin'].sort());
    expect((await row('SELECT archived FROM rooms WHERE id = $1', [c1])).archived).toBe(false);
  });

  it('canais diferentes do mesmo arquivo com o mesmo nome ajustado viram salas separadas', async () => {
    const t = tag();
    const prefix = `diretoria-financeira-planejamento-orcamentario-${t}`.padEnd(64, 'x');
    const people = ['A', 'B', 'C', 'D'].map((k) => U({ importIds: [`${k}-${t}`], emails: [], username: `${k.toLowerCase()}u${t}` }));
    const { result } = await convert([
      ...people,
      C({ importIds: [`G1-${t}`], t: 'p', name: `${prefix}-2024-board`, users: [`A-${t}`, `B-${t}`], creator: `A-${t}` }),
      C({ importIds: [`G2-${t}`], t: 'p', name: `${prefix}-2024-interns`, users: [`C-${t}`, `D-${t}`], creator: `C-${t}` }),
      C({ importIds: [`G3-${t}`], t: 'p', name: `vendas-${t}-日本`, users: [`A-${t}`], creator: `A-${t}` }),
      C({ importIds: [`G4-${t}`], t: 'p', name: `vendas-${t}-中国`, users: [`D-${t}`], creator: `D-${t}` }),
      C({ importIds: [`C5-${t}`], t: 'c', name: `Vendas SP ${t}`, users: [`A-${t}`], creator: `A-${t}` }),
      C({ importIds: [`C6-${t}`], t: 'c', name: `Vendas-SP-${t}`, users: [`D-${t}`], creator: `D-${t}` }),
      M({ importId: `secret-${t}`, rid: `G1-${t}`, u: `A-${t}`, ts: '2022-01-01T00:00:00.000Z', msg: 'só da diretoria' }),
    ]);
    expect(result.channels).toEqual({ inserted: 6, updated: 0, failed: 0, skipped: 0 });
    const id = (k: string) => mapped('room', `${k}-${t}`);
    const [g1, g2, g3, g4, c5, c6] = await Promise.all(['G1', 'G2', 'G3', 'G4', 'C5', 'C6'].map(id));
    expect(new Set([g1, g2, g3, g4, c5, c6]).size).toBe(6);
    expect((await row('SELECT name FROM rooms WHERE id = $1', [g1])).name).toBe(prefix);
    expect((await row('SELECT name FROM rooms WHERE id = $1', [g2])).name).toBe(`${prefix.slice(0, 62)}-2`);
    expect((await row('SELECT name FROM rooms WHERE id = $1', [c6])).name).toBe(`Vendas-SP-${t}-2`);
    expect(await membersOf(g1)).toEqual([`au${t}`, `bu${t}`]);
    expect(await membersOf(g2)).toEqual([`cu${t}`, `du${t}`]);
    expect(await membersOf(g4)).toEqual([`du${t}`]);
    expect(await membersOf(c6)).toEqual([`du${t}`]);
    const secret = await row('SELECT room_id FROM messages WHERE id = $1', [await mapped('message', `secret-${t}`)]);
    expect(secret.room_id).toBe(g1);
  });

  it('grupo privado de outro CSV com o mesmo nome não põe ninguém no grupo que já existe', async () => {
    const t = tag();
    const name = `conselho-${t}`;
    const aberto = `aberto-${t}`;
    const ana = await newUser(A);
    const mallory = await newUser(A);
    const carla = await newUser(A);
    await convert([
      C({ importIds: [`csv:c:${name}`], t: 'p', name, users: [ana.username] }),
      C({ importIds: [`csv:c:${aberto}`], t: 'c', name: aberto, users: [ana.username] }),
      M({ rid: `csv:c:${name}`, u: ana.username, msg: 'ata secreta', ts: '2020-01-01T00:00:00.000Z' }),
    ]);
    const g = await mapped('room', `csv:c:${name}`);
    const pub = await mapped('room', `csv:c:${aberto}`);
    const members = ['admin', ana.username].sort();
    expect(await membersOf(g)).toEqual(members);

    // No CSV o id do canal é o próprio nome: um zip sem relação nenhuma com o primeiro chega com os mesmos ids.
    const second = await convert([
      C({ importIds: [`csv:c:${name}`], t: 'p', name, users: [ana.username, mallory.username] }),
      C({ importIds: [`csv:c:${aberto}`], t: 'c', name: aberto, users: [carla.username] }),
    ]);
    expect(second.result.channels).toMatchObject({ inserted: 0, updated: 2, failed: 0 });
    expect(await mapped('room', `csv:c:${name}`)).toBe(g);
    expect(await membersOf(g)).toEqual(members);
    expect((await api('GET', 'groups.history', { roomId: g }, mallory)).success).toBe(false);
    expect((await errorsOf(second.opId))[`csv:c:${name}`]).toEqual([
      `1 pessoa do arquivo não foi adicionada ao grupo privado "${name}": no CSV o grupo é reconhecido só pelo nome, e isso não basta para pôr alguém num grupo que já existe. Adicione pela própria sala quem precisar.`,
    ]);
    // Canal público continua recebendo os membros do CSV.
    expect(await membersOf(pub)).toEqual(['admin', ana.username, carla.username].sort());

    // O canal virou privado depois da importação: o próximo CSV também não põe ninguém nele.
    await pool.query(`UPDATE rooms SET t = 'p' WHERE id = $1`, [pub]);
    const third = await convert([
      C({ importIds: [`csv:c:${name}`], t: 'p', name, users: [ana.username] }),
      C({ importIds: [`csv:c:${aberto}`], t: 'c', name: aberto, users: [mallory.username] }),
    ]);
    expect(await membersOf(pub)).toEqual(['admin', ana.username, carla.username].sort());
    // Reimportar o mesmo grupo com quem já está nele não gera aviso.
    expect((await errorsOf(third.opId))[`csv:c:${name}`]).toBeUndefined();
    expect((await errorsOf(third.opId))[`csv:c:${aberto}`]).toHaveLength(1);
  });

  it('canal ligado só pelo nome a uma sala de outra importação não ganha membros nem a arquiva, nem ao reimportar', async () => {
    const t = tag();
    const name = `pub-${t}`;
    await convert([
      U({ importIds: [`A1-${t}`], username: `ana${t}`, emails: [`ana${t}@a.example`] }),
      C({ importIds: [`CA-${t}`], t: 'c', name, users: [`A1-${t}`] }),
    ]);
    const rid = await mapped('room', `CA-${t}`);
    const before = ['admin', `ana${t}`].sort();
    // Outra origem (outros ids), mesmo nome; o canal vem repetido no arquivo.
    const b = [
      U({ importIds: [`B1-${t}`], username: `bruno${t}`, emails: [`bruno${t}@b.example`] }),
      C({ importIds: [`CB-${t}`], t: 'c', name, users: [] }),
      C({ importIds: [`CB-${t}`], t: 'c', name, users: [`B1-${t}`], archived: true }),
    ];
    const state = async () => ({ members: await membersOf(rid), archived: (await row('SELECT archived FROM rooms WHERE id = $1', [rid])).archived });
    await convert(b);
    expect(await mapped('room', `CB-${t}`)).toBe(rid);
    expect(await state()).toEqual({ members: before, archived: false });
    await convert(b);
    expect(await state()).toEqual({ members: before, archived: false });
    // Nem depois que a sala virou privada.
    await pool.query(`UPDATE rooms SET t = 'p' WHERE id = $1`, [rid]);
    await convert(b);
    expect(await state()).toEqual({ members: before, archived: false });
    // A origem que criou a sala continua acrescentando os membros dela.
    await convert([
      U({ importIds: [`A1-${t}`], username: `ana${t}`, emails: [`ana${t}@a.example`] }),
      U({ importIds: [`A2-${t}`], username: `carla${t}`, emails: [`carla${t}@a.example`] }),
      C({ importIds: [`CA-${t}`], t: 'p', name, users: [`A1-${t}`, `A2-${t}`] }),
    ]);
    expect(await membersOf(rid)).toEqual(['admin', `ana${t}`, `carla${t}`].sort());
  });

  it('canal do arquivo nunca fica com a sala de outro canal do mesmo arquivo, qualquer que seja a ordem', async () => {
    const t = tag();
    const ana = await newUser(A);
    const zeca = await newUser(A);
    const archivedOf = async (rid: string) => (await row('SELECT archived FROM rooms WHERE id = $1', [rid])).archived;

    // A sala foi criada para "Vendas-SP"; no arquivo seguinte, "Vendas SP" (mesmo nome ajustado) vem antes dele.
    const a = `Vendas-SP-${t}`;
    const b = `Vendas SP ${t}`;
    await convert([C({ importIds: [`csv:c:${a}`], t: 'c', name: a, users: [ana.username] })]);
    const rid = await mapped('room', `csv:c:${a}`);
    const zip = [
      C({ importIds: [`csv:c:${b}`], t: 'c', name: b, users: [zeca.username], archived: true }),
      C({ importIds: [`csv:c:${a}`], t: 'c', name: a, users: [ana.username] }),
      M({ importId: `vsp-${t}`, rid: `csv:c:${b}`, u: zeca.username, msg: 'mensagem do canal Vendas SP', ts: '2021-01-01T00:00:00.000Z' }),
    ];
    const second = await convert(zip);
    expect(second.result.channels).toMatchObject({ inserted: 1, updated: 1, failed: 0 });
    const ridB = await mapped('room', `csv:c:${b}`);
    expect(ridB).not.toBe(rid);
    expect(await row('SELECT name, archived FROM rooms WHERE id = $1', [ridB])).toEqual({ name: `${a}-2`, archived: true });
    expect((await errorsOf(second.opId))[`csv:c:${b}`]).toEqual([`Já existe uma sala com o nome "${a}"; importada como "${a}-2".`]);
    expect(await roomMessages(rid)).toEqual([]);
    expect((await roomMessages(ridB)).map((m) => m.msg)).toEqual(['mensagem do canal Vendas SP']);
    // Reimportar o mesmo arquivo não junta os dois nem arquiva a sala de "Vendas-SP".
    await convert(zip);
    expect(await mapped('room', `csv:c:${b}`)).toBe(ridB);
    expect(await membersOf(rid)).toEqual(['admin', ana.username].sort());
    expect(await archivedOf(rid)).toBe(false);

    // Ligado antes só pelo nome, num arquivo à parte: num arquivo com os dois, a sala fica com o canal que a criou.
    await convert([C({ importIds: [`E1-${t}`], t: 'c', name: `Equipe-${t}`, users: [ana.username] })]);
    const e1 = await mapped('room', `E1-${t}`);
    await convert([C({ importIds: [`E2-${t}`], t: 'c', name: `Equipe ${t}`, users: [] })]);
    expect(await mapped('room', `E2-${t}`)).toBe(e1);
    const third = await convert([
      C({ importIds: [`E2-${t}`], t: 'c', name: `Equipe ${t}`, users: [zeca.username], archived: true }),
      C({ importIds: [`E1-${t}`], t: 'c', name: `Equipe-${t}`, users: [ana.username] }),
    ]);
    const e2 = await mapped('room', `E2-${t}`);
    expect(e2).not.toBe(e1);
    expect((await row('SELECT name FROM rooms WHERE id = $1', [e2])).name).toBe(`Equipe-${t}-2`);
    expect((await errorsOf(third.opId))[`E2-${t}`]).toEqual([
      `O canal "Equipe ${t}" estava ligado à sala "Equipe-${t}", que é de outro canal deste arquivo; importado como "Equipe-${t}-2".`,
    ]);
    expect(await membersOf(e1)).toEqual(['admin', ana.username].sort());
    expect(await archivedOf(e1)).toBe(false);
    expect(await membersOf(e2)).toEqual(['admin', zeca.username].sort());

    // Sala que nenhuma importação criou, ligada pelo nome a dois canais em arquivos separados: o primeiro fica com ela.
    const f = await api('POST', 'channels.create', { name: `feira-${t}` }, A);
    await convert([C({ importIds: [`F1-${t}`], t: 'c', name: `feira-${t}`, users: [] })]);
    await convert([C({ importIds: [`F2-${t}`], t: 'c', name: `Feira ${t}`, users: [] })]);
    expect(await mapped('room', `F2-${t}`)).toBe(f.channel._id);
    const fourth = await convert([
      C({ importIds: [`F1-${t}`], t: 'c', name: `feira-${t}`, users: [] }),
      C({ importIds: [`F2-${t}`], t: 'c', name: `Feira ${t}`, users: [] }),
    ]);
    expect(await mapped('room', `F1-${t}`)).toBe(f.channel._id);
    const f2 = await mapped('room', `F2-${t}`);
    expect(f2).not.toBe(f.channel._id);
    expect((await errorsOf(fourth.opId))[`F2-${t}`]).toEqual([`O canal "Feira ${t}" estava ligado à sala "feira-${t}", que é de outro canal deste arquivo; importado como "Feira-${t}-2".`]);
  });

  it('cria e reaproveita mensagens diretas, inclusive com quem importa e consigo mesmo', async () => {
    const t = tag();
    const x = await newUser(A);
    const dm = await api('POST', 'im.create', { username: x.username }, A);
    const { opId, result } = await convert([
      U({ importIds: [`D1-${t}`], emails: [], username: `d1${t}` }),
      U({ importIds: [`D2-${t}`], emails: [], username: `d2${t}` }),
      C({ importIds: [`DM12-${t}`], t: 'd', users: [`D2-${t}`, `D1-${t}`] }),
      C({ importIds: [`DMA-${t}`], t: 'd', users: ['admin', x.username] }),
      C({ importIds: [`DMS-${t}`], t: 'd', users: [`D1-${t}`, `D1-${t}`] }),
      C({ importIds: [`DMX-${t}`], t: 'd', users: [`D1-${t}`, `ghost-${t}`] }),
      M({ rid: `DMX-${t}`, u: `D1-${t}`, msg: 'na DM que falhou', ts: '2021-01-01T00:00:00.000Z' }),
      M({ rid: `DM12-${t}`, u: `D1-${t}`, msg: 'oi', ts: '2021-01-01T00:00:00.000Z' }),
    ]);
    expect(result.channels).toEqual({ inserted: 2, updated: 1, failed: 1, skipped: 0 });
    expect(result.messages).toMatchObject({ inserted: 1, skipped: 1, failed: 0 });
    const d1 = (await userByName(`d1${t}`)).id;
    const d2 = (await userByName(`d2${t}`)).id;
    const r12 = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `DM12-${t}`)]);
    expect(r12).toMatchObject({ t: 'd', name: null, fname: null, uids: [d1, d2].sort(), usernames: [`d1${t}`, `d2${t}`], dm_key: [d1, d2].sort().join(','), users_count: 2, msgs: 1 });
    expect((await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [r12.id])).length).toBe(2);
    expect(await mapped('room', `DMA-${t}`)).toBe(dm.room._id);
    const self = await row('SELECT * FROM rooms WHERE id = $1', [await mapped('room', `DMS-${t}`)]);
    expect(self.uids).toEqual([d1]);
    expect((await errorsOf(opId))[`DMX-${t}`]).toEqual([`Mensagem direta com usuário não importado: ghost-${t}`]);
  });
});

describe('mensagens', () => {
  async function base(t: string) {
    return [
      U({ importIds: [`MA-${t}`], emails: [], username: `ana${t}`, name: 'Ana' }),
      U({ importIds: [`MB-${t}`], emails: [], username: `bruno${t}`, name: 'Bruno' }),
      C({ importIds: [`MC-${t}`], t: 'c', name: `conversa-${t}`, users: [`MA-${t}`, `MB-${t}`] }),
    ];
  }

  it('troca os marcadores de menção, calcula menções, reações e anexos', async () => {
    const t = tag();
    const { result } = await convert([
      ...(await base(t)),
      M({
        importId: `m1-${t}`,
        rid: `MC-${t}`,
        u: `MA-${t}`,
        ts: '2022-03-01T12:00:00.000Z',
        msg: `Oi ${userToken(`MB-${t}`, 'bruno')} e ${userToken(`MZ-${t}`, 'fantasma')}, veja ${roomToken(`MC-${t}`, 'x')} e ${roomToken('geral', 'geral')} @all`,
        reactions: { ':+1::skin-tone-2:': [`MA-${t}`], ':+1:': [`MB-${t}`, `MA-${t}`], ':nome inválido:': [`MA-${t}`], ':smile:': ['ninguem'] },
        attachments: [
          { title: 'Build', title_link: 'javascript:alert(1)', text: `por ${userToken(`MB-${t}`)}`, color: 'good', fields: [{ title: 'Status', value: 'ok', short: true }], image_url: 'https://img.example/x.png', thumb_url: 'ftp://x', footer: 'CI', ts: '2022-03-01T12:00:00.000Z' },
        ],
        alias: 'Robô',
        emoji: ':robot:',
        pinned: true,
        editedAt: '2022-03-01T12:05:00.000Z',
        editedBy: `MA-${t}`,
      }),
    ]);
    expect(result.messages).toMatchObject({ inserted: 1, failed: 0 });
    const m = await row('SELECT * FROM messages WHERE id = $1', [await mapped('message', `m1-${t}`)]);
    expect(m.msg).toBe(`Oi @bruno${t} e @fantasma, veja #conversa-${t} e #geral @all`);
    expect(m.mentions).toEqual([{ _id: 'all', username: 'all' }, { _id: (await userByName(`bruno${t}`)).id, username: `bruno${t}`, name: 'Bruno' }]);
    expect(m.channels.map((c: any) => c.name).sort()).toEqual([`conversa-${t}`, 'geral'].sort());
    expect(Object.keys(m.reactions)).toEqual([':+1:']);
    expect([...m.reactions[':+1:'].usernames].sort()).toEqual([`ana${t}`, `bruno${t}`]);
    expect(m.attachments).toEqual([
      { title: 'Build', text: `por @bruno${t}`, color: 'good', fields: [{ title: 'Status', value: 'ok', short: true }], image_url: 'https://img.example/x.png', footer: 'CI', ts: '2022-03-01T12:00:00.000Z' },
    ]);
    expect(m).toMatchObject({ alias: 'Robô', emoji: ':robot:', pinned: true, pinned_at: '2022-03-01T12:00:00.000Z', edited_at: '2022-03-01T12:05:00.000Z', unread: false, created_at: '2022-03-01T12:00:00.000Z', username: `ana${t}`, user_name: 'Ana' });
    expect(m.edited_by).toEqual({ _id: (await userByName(`ana${t}`)).id, username: `ana${t}` });
    expect(m.extra).toEqual({});
    // Ninguém recebe "não lida" pelo histórico importado.
    const subs = await rows('SELECT unread, alert, ls FROM subscriptions WHERE room_id = $1', [m.room_id]);
    expect(subs).toHaveLength(3);
    expect(subs.every((x) => x.unread === 0 && !x.alert && x.ls)).toBe(true);
  });

  it('liga threads mesmo com a resposta antes da raiz, mostra tshow e recalcula a sala', async () => {
    const t = tag();
    const { result } = await convert([
      ...(await base(t)),
      M({ importId: `c1-${t}`, rid: `MC-${t}`, u: `MB-${t}`, ts: '2022-01-01T10:01:00.000Z', msg: 'resposta na sala', tmid: `p-${t}`, tshow: true }),
      M({ importId: `p-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-01-01T10:00:00.000Z', msg: 'raiz' }),
      M({ importId: `c2-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-01-01T10:02:00.000Z', msg: 'resposta', tmid: `p-${t}` }),
      M({ importId: `o-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-01-01T09:00:00.000Z', msg: 'órfã', tmid: `nunca-${t}`, tshow: true }),
      M({ rid: `MC-${t}`, u: `MB-${t}`, ts: '2022-01-01T08:00:00.000Z', msg: `bruno${t}`, t: 'uj' }),
    ]);
    expect(result.messages).toMatchObject({ inserted: 5, failed: 0 });
    const id = (k: string) => mapped('message', `${k}-${t}`);
    const root = await row('SELECT * FROM messages WHERE id = $1', [await id('p')]);
    const c1 = await row('SELECT * FROM messages WHERE id = $1', [await id('c1')]);
    const c2 = await row('SELECT * FROM messages WHERE id = $1', [await id('c2')]);
    const orphan = await row('SELECT * FROM messages WHERE id = $1', [await id('o')]);
    expect(c1.tmid).toBe(root.id);
    expect(c1.extra).toEqual({ tshow: true });
    expect(c2.tmid).toBe(root.id);
    expect(orphan.tmid).toBeNull();
    expect(orphan.extra).toEqual({});
    expect(root.tcount).toBe(2);
    expect(root.tlm).toBe('2022-01-01T10:02:00.000Z');
    expect([...root.replies].sort()).toEqual([(await userByName(`ana${t}`)).id, (await userByName(`bruno${t}`)).id].sort());
    const room = await row('SELECT * FROM rooms WHERE id = $1', [root.room_id]);
    // msgs conta as respostas e não as mensagens de sistema; a última mensagem é a resposta mostrada na sala.
    expect(room.msgs).toBe(4);
    expect(room.lm).toBe('2022-01-01T10:02:00.000Z');
    expect(room.last_message).toEqual({ _id: c1.id, msg: 'resposta na sala', u: { _id: c1.user_id, username: `bruno${t}`, name: 'Bruno' }, ts: '2022-01-01T10:01:00.000Z' });
    expect(room.users_count).toBe(3);
  });

  it('deixa os horários únicos por sala, inclusive com mensagens que já estavam lá', async () => {
    const t = tag();
    const ch = await api('POST', 'channels.create', { name: `antiga-${t}` }, A);
    const sent = await api('POST', 'chat.sendMessage', { message: { rid: ch.channel._id, msg: 'mensagem ao vivo' } }, A);
    const liveTs = sent.message.ts;
    const before = await row('SELECT msgs FROM rooms WHERE id = $1', [ch.channel._id]);
    const ts = '2023-06-01T12:00:00.000Z';
    await convert([
      ...(await base(t)),
      M({ rid: `MC-${t}`, u: `MA-${t}`, ts, msg: 'a' }),
      M({ rid: `MC-${t}`, u: `MA-${t}`, ts, msg: 'b' }),
      M({ rid: `MC-${t}`, u: `MB-${t}`, ts, msg: 'c' }),
      M({ rid: `MC-${t}`, u: `MA-${t}`, msg: 'sem hora 1' }),
      M({ rid: `MC-${t}`, u: `MA-${t}`, ts: 'lixo', msg: 'sem hora 2' }),
      C({ importIds: [`OLD-${t}`], t: 'c', name: `antiga-${t}` }),
      M({ rid: `OLD-${t}`, u: 'admin', ts: liveTs, msg: 'mesmo milissegundo' }),
    ]);
    const msgs = await roomMessages(await mapped('room', `MC-${t}`));
    expect(msgs.slice(0, 3).map((m) => m.created_at)).toEqual(['2023-06-01T12:00:00.000Z', '2023-06-01T12:00:00.001Z', '2023-06-01T12:00:00.002Z']);
    const late = msgs.slice(3).map((m) => Date.parse(m.created_at));
    expect(late[1]).toBeGreaterThan(late[0]);
    expect(late[0]).toBeGreaterThan(Date.parse('2024-01-01'));
    const old = await roomMessages(ch.channel._id);
    expect(old.map((m) => m.msg)).toEqual(['mensagem ao vivo', 'mesmo milissegundo']);
    expect(Date.parse(old[1].created_at) - Date.parse(liveTs)).toBe(1);
    // Sala que já existia: msgs soma só o que entrou.
    expect((await row('SELECT msgs FROM rooms WHERE id = $1', [ch.channel._id])).msgs).toBe(before.msgs + 1);
  });

  it('marca arquivos para baixar depois e reimporta sem duplicar', async () => {
    const t = tag();
    const files = [
      { id: `F1-${t}`, name: 'doc.pdf', url: 'https://files.example/F1?token=x', size: 10, type: 'application/pdf' },
      { id: `F2-${t}`, name: 'planilha', url: 'https://docs.example/x', external: true },
      { id: `F3-${t}`, name: 'apagado' },
    ];
    const recs = [...(await base(t)), M({ importId: `f-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-02-02T00:00:00.000Z', msg: '', files }), M({ importId: `g-${t}`, rid: `MC-${t}`, u: `MB-${t}`, ts: '2022-02-02T00:01:00.000Z', msg: 'texto' })];
    const first = await convert(recs);
    expect(first.result.messages).toMatchObject({ inserted: 2 });
    const mid = await mapped('message', `f-${t}`);
    const m = await row('SELECT * FROM messages WHERE id = $1', [mid]);
    expect(m.files).toEqual([]);
    // Só o que tem endereço e não é externo vai ser baixado; os outros dizem que não estão disponíveis.
    expect(m.attachments).toEqual(
      files.map((f) => ({ title: f.name, text: `📎 ${f.name} (${f.url && !f.external ? 'arquivo ainda não baixado da origem' : 'arquivo não disponível na origem'})`, pendingFileId: f.id })),
    );
    const pend = await rows('SELECT source_file_id, status, url, external, room_id, user_id, size FROM import_pending_files WHERE message_id = $1 ORDER BY source_file_id', [mid]);
    expect(pend.map((p) => [p.source_file_id, p.status])).toEqual([
      [`F1-${t}`, 'pending'],
      [`F2-${t}`, 'unavailable'],
      [`F3-${t}`, 'unavailable'],
    ]);
    expect(pend[0]).toMatchObject({ url: 'https://files.example/F1?token=x', room_id: m.room_id, user_id: m.user_id, size: 10 });

    // Simula o download do primeiro arquivo entre as duas importações.
    const fileAtt = { title: 'doc.pdf', title_link: '/file-upload/X/doc.pdf', type: 'file' };
    await pool.query(`UPDATE import_pending_files SET status = 'downloaded', url = NULL WHERE message_id = $1 AND source_file_id = $2`, [mid, `F1-${t}`]);
    await pool.query(`UPDATE messages SET attachments = $2 WHERE id = $1`, [mid, JSON.stringify([fileAtt, ...m.attachments.slice(1)])]);

    recs[recs.length - 1] = M({ importId: `g-${t}`, rid: `MC-${t}`, u: `MB-${t}`, ts: '2022-02-02T00:01:00.000Z', msg: 'texto editado', editedAt: '2022-02-03T00:00:00.000Z', editedBy: `MB-${t}` });
    const second = await convert(recs);
    expect(second.result.users).toMatchObject({ inserted: 0, updated: 2 });
    expect(second.result.channels).toMatchObject({ inserted: 0, updated: 1 });
    expect(second.result.messages).toMatchObject({ inserted: 0, updated: 2 });
    const all = await roomMessages(m.room_id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ msg: 'texto editado', edited_at: '2022-02-03T00:00:00.000Z' });
    const again = await row('SELECT attachments FROM messages WHERE id = $1', [mid]);
    expect(again.attachments.map((a: any) => a.pendingFileId ?? a.type)).toEqual([`F2-${t}`, `F3-${t}`, 'file']);
    expect((await rows('SELECT 1 FROM import_pending_files WHERE message_id = $1', [mid])).length).toBe(3);
    const room = await row('SELECT msgs, last_message FROM rooms WHERE id = $1', [m.room_id]);
    expect(room.msgs).toBe(2);
    expect(room.last_message.msg).toBe('texto editado');
  });

  it('última mensagem longa com emoji no corte de 200 não derruba o fim da importação', async () => {
    const t = tag();
    const long = 'x'.repeat(199) + '😀' + ' resto';
    const { result } = await convert([
      ...(await base(t)),
      C({ importIds: [`MD-${t}`], t: 'c', name: `depois-${t}`, users: [`MA-${t}`] }),
      M({ importId: `l1-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-01-01T00:00:00.000Z', msg: long }),
      M({ importId: `l2-${t}`, rid: `MD-${t}`, u: `MA-${t}`, ts: '2022-01-01T00:00:00.000Z', msg: 'ok' }),
      M({ importId: `l3-${t}`, rid: `MD-${t}`, u: `MB-${t}`, ts: '2022-01-01T00:00:01.000Z', msg: 'resposta', tmid: `l2-${t}` }),
    ]);
    expect(result.messages).toMatchObject({ inserted: 3, failed: 0 });
    const r1 = await row('SELECT msgs, lm, last_message FROM rooms WHERE id = $1', [await mapped('room', `MC-${t}`)]);
    expect(r1.msgs).toBe(1);
    expect(r1.last_message.msg).toBe('x'.repeat(199) + '😀');
    const r2 = await row('SELECT msgs, lm, last_message FROM rooms WHERE id = $1', [await mapped('room', `MD-${t}`)]);
    expect(r2).toMatchObject({ msgs: 2, lm: '2022-01-01T00:00:01.000Z' });
    expect(r2.last_message.msg).toBe('ok');
  });

  it('texto de anexo, campo e nome de arquivo com emoji no limite entram sem metade de emoji', async () => {
    const t = tag();
    const { opId, result } = await convert([
      ...(await base(t)),
      M({
        importId: `a1-${t}`,
        rid: `MC-${t}`,
        u: `MA-${t}`,
        ts: '2022-01-01T00:00:00.000Z',
        msg: 'com anexo',
        attachments: [
          {
            title: 't'.repeat(499) + '😀x',
            text: 'y'.repeat(4999) + '😀z',
            pretext: 'p'.repeat(4999) + '😀z',
            author_name: 'a'.repeat(199) + '😀z',
            footer: 'f'.repeat(4999) + '😀z',
            fields: [{ title: 'c'.repeat(199) + '🚀z', value: 'b'.repeat(1999) + '🚀z' }],
          },
        ],
      }),
      M({ importId: `a2-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-01-01T00:00:01.000Z', msg: 'arquivo', files: [{ id: `F1-${t}`, name: 'n'.repeat(254) + '😀.pdf', url: 'https://x.example/f' }] }),
    ]);
    expect(result.messages).toMatchObject({ inserted: 2, failed: 0 });
    expect(await errorsOf(opId)).toEqual({});
    const m = await row('SELECT attachments FROM messages WHERE id = $1', [await mapped('message', `a1-${t}`)]);
    expect(m.attachments).toEqual([
      {
        title: 't'.repeat(499) + '😀',
        text: 'y'.repeat(4999) + '😀',
        pretext: 'p'.repeat(4999) + '😀',
        author_name: 'a'.repeat(199) + '😀',
        footer: 'f'.repeat(4999) + '😀',
        fields: [{ title: 'c'.repeat(199) + '🚀', value: 'b'.repeat(1999) + '🚀', short: false }],
      },
    ]);
    const f = await row('SELECT attachments FROM messages WHERE id = $1', [await mapped('message', `a2-${t}`)]);
    expect(f.attachments[0].title).toBe('n'.repeat(254) + '😀');
    expect((await row('SELECT name FROM import_pending_files WHERE source_file_id = $1', [`F1-${t}`])).name).toBe('n'.repeat(254) + '😀');
  });

  it('reimportar depois de uma importação interrompida acerta o total de mensagens da sala', async () => {
    const t = tag();
    const head = await base(t);
    const msgs = Array.from({ length: 10 }, (_, i) => M({ importId: `q${i}-${t}`, rid: `MC-${t}`, u: `MA-${t}`, ts: new Date(Date.UTC(2022, 0, 1, 0, i)).toISOString(), msg: `m${i}` }));
    // O servidor cai antes do fim: as mensagens entraram, mas os contadores da sala não foram recalculados.
    await expect(convert([...head, ...msgs.slice(0, 6)], { throwAt: ST.finishing })).rejects.toThrow('queda simulada');
    const rid = await mapped('room', `MC-${t}`);
    expect((await row('SELECT msgs FROM rooms WHERE id = $1', [rid])).msgs).toBe(0);
    const again = await convert([...head, ...msgs]);
    expect(again.result.messages).toMatchObject({ inserted: 4, updated: 6 });
    expect((await row('SELECT msgs, lm FROM rooms WHERE id = $1', [rid])).msgs).toBe(10);
  });

  it('reimportar uma exportação nova renova o endereço e as tentativas dos arquivos que falharam', async () => {
    const t = tag();
    const recs = async (token: string) => [
      ...(await base(t)),
      M({
        importId: `pf-${t}`,
        rid: `MC-${t}`,
        u: `MA-${t}`,
        ts: '2022-01-01T00:00:00.000Z',
        msg: '',
        files: [
          { id: `F1-${t}`, name: 'a.pdf', url: `https://files.example/F1/a.pdf?t=${token}` },
          { id: `F2-${t}`, name: 'b.pdf', url: `https://files.example/F2/b.pdf?t=${token}` },
        ],
      }),
    ];
    await convert(await recs('xoxe-OLD'));
    const mid = await mapped('message', `pf-${t}`);
    // O token expirou e o download desistiu; o outro arquivo já tinha sido baixado.
    await pool.query(`UPDATE import_pending_files SET status = 'failed', attempts = 5, error = 'HTTP 403' WHERE message_id = $1 AND source_file_id = $2`, [mid, `F1-${t}`]);
    await pool.query(`UPDATE import_pending_files SET status = 'downloaded', url = NULL, file_id = 'X' WHERE message_id = $1 AND source_file_id = $2`, [mid, `F2-${t}`]);
    await convert(await recs('xoxe-NEW'));
    const pend = await rows('SELECT source_file_id, status, attempts, error, url, file_id FROM import_pending_files WHERE message_id = $1 ORDER BY source_file_id', [mid]);
    expect(pend).toEqual([
      { source_file_id: `F1-${t}`, status: 'pending', attempts: 0, error: null, url: 'https://files.example/F1/a.pdf?t=xoxe-NEW', file_id: null },
      { source_file_id: `F2-${t}`, status: 'downloaded', attempts: 0, error: null, url: null, file_id: 'X' },
    ]);
  });

  it('mensagem enviada pelo chat com emoji no corte de 200 atualiza a última mensagem da sala (envio e exclusão)', async () => {
    const t = tag();
    const ch = await api('POST', 'channels.create', { name: `corte-${t}` }, A);
    const rid = ch.channel._id;
    const first = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'y'.repeat(199) + '😀 fim' } }, A);
    expect(first.success).toBe(true);
    expect((await row('SELECT last_message FROM rooms WHERE id = $1', [rid])).last_message.msg).toBe('y'.repeat(199) + '😀');
    const second = await api('POST', 'chat.sendMessage', { message: { rid, msg: 'segunda' } }, A);
    expect((await api('POST', 'chat.delete', { roomId: rid, msgId: second.message._id }, A)).success).toBe(true);
    expect((await row('SELECT last_message FROM rooms WHERE id = $1', [rid])).last_message).toMatchObject({ _id: first.message._id, msg: 'y'.repeat(199) + '😀' });
  });

  it('mostra o nome do arquivo como última mensagem quando só há arquivo', async () => {
    const t = tag();
    await convert([...(await base(t)), M({ rid: `MC-${t}`, u: `MA-${t}`, ts: '2022-02-02T00:00:00.000Z', msg: '', files: [{ id: `F-${t}`, name: 'foto.png', url: 'https://x.example/f' }] })]);
    const room = await row('SELECT last_message FROM rooms WHERE id = $1', [await mapped('room', `MC-${t}`)]);
    expect(room.last_message.msg).toBe('📎 foto.png');
  });
});

describe('seleção e cancelamento', () => {
  it('ignora o que não foi selecionado sem contar como erro', async () => {
    const t = tag();
    const { opId, result, s } = await convert(
      [
        U({ importIds: [`S1-${t}`], emails: [], username: `s1${t}` }),
        U({ importIds: [`S2-${t}`], emails: [], username: `s2${t}` }),
        C({ importIds: [`SC1-${t}`], t: 'c', name: `sel1-${t}`, users: [`S1-${t}`, `S2-${t}`] }),
        C({ importIds: [`SC2-${t}`], t: 'c', name: `sel2-${t}`, users: [`S1-${t}`] }),
        C({ importIds: [`SD-${t}`], t: 'd', users: [`S1-${t}`, 'admin'] }),
        K({ importIds: [`SK-${t}`], name: 'Contato' }),
        M({ rid: `SC1-${t}`, u: `S1-${t}`, msg: 'entra' }),
        M({ rid: `SC1-${t}`, u: `S2-${t}`, msg: 'autor não selecionado' }),
        M({ rid: `SC2-${t}`, u: `S1-${t}`, msg: 'sala não selecionada' }),
        M({ rid: `SD-${t}`, u: `S1-${t}`, msg: 'dm não selecionada' }),
        M({ rid: `nada-${t}`, u: `S1-${t}`, msg: 'sala desconhecida' }),
      ],
      { selection: { users: { list: [`S1-${t}`] }, channels: { all: false, list: [`SC1-${t}`] } } },
    );
    expect(result.users).toMatchObject({ inserted: 1, skipped: 1 });
    expect(result.channels).toMatchObject({ inserted: 1, skipped: 2 });
    expect(result.contacts).toMatchObject({ inserted: 0, skipped: 1 });
    expect(result.messages).toMatchObject({ inserted: 1, skipped: 2, failed: 2 });
    expect(s).toMatchObject({ completed: 3, skipped: 6, error: 2 });
    expect(await userByName(`s2${t}`)).toBeUndefined();
    const errs = await errorsOf(opId);
    expect(errs['autor não selecionado']).toEqual([`Autor não encontrado: S2-${t}`]);
    expect(errs['sala desconhecida']).toEqual([`Sala não encontrada: nada-${t}`]);
    expect((await rows('SELECT 1 FROM import_records WHERE operation_id = $1 AND skipped', [opId])).length).toBe(6);
    // Só o selecionado entrou na sala.
    expect((await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [await mapped('room', `SC1-${t}`)])).length).toBe(2);

    // Mensagens diretas selecionadas pelo item único "Mensagens diretas".
    const dms = await convert([C({ importIds: [`SD2-${t}`], t: 'd', users: [`S1-${t}`, 'admin'] })], { selection: { channels: { list: [DIRECT_MESSAGES_ID] } } });
    expect(dms.result.channels).toMatchObject({ inserted: 1 });
  });

  it('para no meio quando a importação é cancelada', async () => {
    const t = tag();
    const { result, s } = await convert(
      [
        U({ importIds: [`X1-${t}`], emails: [], username: `x1${t}` }),
        U({ importIds: [`X2-${t}`], emails: [], username: `x2${t}` }),
        C({ importIds: [`XC-${t}`], t: 'c', name: `cancelada-${t}`, users: [`X1-${t}`] }),
        M({ rid: `XC-${t}`, u: `X1-${t}`, msg: 'não entra' }),
      ],
      { cancelAfter: 1 },
    );
    expect(result.users.inserted).toBe(2);
    expect(result.channels.inserted).toBe(0);
    expect(s.steps).toEqual([ST.importingUsers]);
    expect(await mapped('room', `XC-${t}`)).toBeNull();
  });
});

describe('contatos', () => {
  it('cria contatos novos e completa os que já existem pelo e-mail', async () => {
    const t = tag();
    await pool.query(`INSERT INTO livechat_custom_fields (id, label, scope) VALUES ('cpf', 'CPF', 'visitor') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO livechat_visitors (id, token, username, name, email) VALUES ($1, $2, $3, 'Cliente Antigo', $4)`, [newId(), newId(24), `guest-old-${t}`, `cliente-${t}@x.com`]);
    const recs = [
      K({ importIds: [`K1-${t}`], name: 'Outro Nome', emails: [`CLIENTE-${t}@x.com`, `outro-${t}@x.com`], phones: ['+55 11 9999-0000'], customFields: { cpf: ' 123 ', desconhecido: 'x' } }),
      K({ importIds: [`K2-${t}`], name: 'Contato Novo', emails: [`novo-${t}@x.com`], phones: ['111', '222'], manager: 'ADMIN' }),
      K({ importIds: [`K3-${t}`] }),
    ];
    const { opId, result } = await convert(recs);
    expect(result.contacts).toEqual({ inserted: 1, failed: 1, skipped: 0 });
    const old = await row('SELECT * FROM livechat_visitors WHERE id = $1', [await mapped('contact', `K1-${t}`)]);
    expect(old).toMatchObject({ name: 'Cliente Antigo', email: `cliente-${t}@x.com`, phone: '+55 11 9999-0000' });
    expect(old.custom_fields).toEqual({ cpf: '123', importedEmails: `outro-${t}@x.com` });
    const novo = await row('SELECT * FROM livechat_visitors WHERE id = $1', [await mapped('contact', `K2-${t}`)]);
    expect(novo).toMatchObject({ name: 'Contato Novo', email: `novo-${t}@x.com`, phone: '111' });
    expect(novo.username).toMatch(/^guest-\d+-/);
    expect(novo.token.length).toBeGreaterThan(20);
    expect(novo.custom_fields).toEqual({ importedPhones: '222', contactManager: 'admin' });
    expect((await errorsOf(opId))[`K3-${t}`]).toEqual(['Contato sem nome, e-mail e telefone.']);

    const again = await convert(recs.slice(0, 2));
    expect(again.result.contacts.inserted).toBe(0);
    expect((await rows('SELECT 1 FROM livechat_visitors WHERE lower(email) = lower($1)', [`novo-${t}@x.com`])).length).toBe(1);
  });
});

describe('efeitos colaterais', () => {
  it('avisa quem está conectado sobre as salas novas, sem notificar as mensagens', async () => {
    const t = tag();
    const x = await newUser(A);
    const ws = connectWs(x);
    await ws.ready;
    try {
      await convert([
        C({ importIds: [`RT-${t}`], t: 'c', name: `tempo-real-${t}`, users: [x.username] }),
        M({ rid: `RT-${t}`, u: 'admin', ts: '2022-01-01T00:00:00.000Z', msg: `oi @${x.username}` }),
      ]);
      const rid = await mapped('room', `RT-${t}`);
      const sub = await ws.waitFor((e) => e.type === 'subscription' && e.action === 'inserted' && e.subscription.rid === rid);
      expect(sub.subscription).toMatchObject({ unread: 0, alert: false, userMentions: 0 });
      const room = await ws.waitFor((e) => e.type === 'room' && e.action === 'inserted' && e.room._id === rid);
      expect(room.room).toMatchObject({ msgs: 1, lastMessage: { msg: `oi @${x.username}` } });
      await sleep(200);
      expect(ws.events.some((e) => e.type === 'message' || e.type === 'notification')).toBe(false);
      expect((await row('SELECT user_mentions, unread FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, x.userId]))).toEqual({ user_mentions: 0, unread: 0 });
    } finally {
      ws.close();
    }
  });

  it('manda o link para definir a senha só para as contas novas com e-mail', async () => {
    const t = tag();
    outbox.length = 0;
    const existing = await newUser(A);
    await convert(
      [
        U({ importIds: [`P1-${t}`], emails: [`pessoa-${t}@x.com`], username: `pessoa${t}` }),
        U({ importIds: [`P2-${t}`], emails: [`bot-${t}@x.com`], username: `robo${t}`, type: 'bot' }),
        U({ importIds: [`P3-${t}`], emails: [`saiu-${t}@x.com`], username: `saiu${t}`, deleted: true }),
        U({ importIds: [`P4-${t}`], emails: [], username: `semmail${t}` }),
        U({ importIds: [`P5-${t}`], emails: [`${existing.username}@test.local`] }),
      ],
      { options: { sendPasswordEmails: true } },
    );
    for (let i = 0; i < 40 && !outbox.length; i++) await sleep(50);
    await sleep(100);
    expect(outbox.map((m) => m.to)).toEqual([`pessoa-${t}@x.com`]);
    expect(outbox[0].subject).toBe('Defina sua senha no Wescc Chat');
    const token = /reset-password#token=([A-Za-z0-9_-]+)/.exec(outbox[0].text)?.[1] ?? '';
    expect((await api('POST', 'users.resetPassword', { token, password: 'senha-nova-123' })).success).toBe(true);
    expect((await login(`pessoa${t}`, 'senha-nova-123')).username).toBe(`pessoa${t}`);
  });

  it('não dispara webhooks de saída nem cria mensagens de sistema', async () => {
    const t = tag();
    const received: any[] = [];
    const hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body || '{}'));
        res.end('{}');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hook.address() as any).port}/hook`;
    const ids: string[] = [];
    try {
      for (const event of ['sendMessage', 'userCreated', 'roomCreated', 'roomJoined']) {
        const r = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: `Teste ${event}`, username: 'admin', event, channel: 'all_public_channels', urls: [url] }, A);
        expect(r.success).toBe(true);
        ids.push(r.integration._id);
      }
      await convert([
        U({ importIds: [`W1-${t}`], emails: [`w1-${t}@x.com`], username: `w1${t}` }),
        C({ importIds: [`WC-${t}`], t: 'c', name: `webhook-${t}`, users: [`W1-${t}`] }),
        M({ rid: `WC-${t}`, u: `W1-${t}`, msg: '/leave' }),
        M({ rid: `WC-${t}`, u: `W1-${t}`, msg: 'olá' }),
      ]);
      await sleep(400);
      expect(received).toEqual([]);
      expect(await rows('SELECT 1 FROM integration_history WHERE integration_id = ANY($1)', [ids])).toEqual([]);
      const room = await mapped('room', `WC-${t}`);
      expect((await roomMessages(room)).map((m) => [m.msg, m.t])).toEqual([
        ['/leave', null],
        ['olá', null],
      ]);
      // Controle: o mesmo webhook dispara para uma conta criada pelo caminho normal.
      await newUser(A);
      for (let i = 0; i < 40 && !received.length; i++) await sleep(50);
      expect(received.length).toBeGreaterThan(0);
    } finally {
      for (const id of ids) await api('POST', 'integrations.remove', { integrationId: id }, A);
      hook.close();
    }
  });
});
