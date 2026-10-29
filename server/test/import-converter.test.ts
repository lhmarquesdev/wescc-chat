import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { mentionNames, nameFromUsername, runConversion, sanitizeRoomName, sanitizeUsername } from '../src/importer/converter';
import { buildSelection } from '../src/importer/operations';
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

type Rec = { type: 'user' | 'channel' | 'message'; data: any };
const U = (data: any): Rec => ({ type: 'user', data });
const C = (data: any): Rec => ({ type: 'channel', data: { users: [], ...data } });
const M = (data: any): Rec => ({ type: 'message', data });
const ALL: ShortSelection = { users: { all: true }, channels: { all: true } };

let seq = 0;
const tag = () => `${++seq}${Math.random().toString(36).slice(2, 6)}`;

// Importação de teste: grava a operação e os registros direto no banco, como a leitura do arquivo faria.
async function stage(recs: Rec[], importer = 'csv') {
  const opId = newId();
  await pool.query('UPDATE import_operations SET valid = false WHERE valid');
  await pool.query(`INSERT INTO import_operations (id, importer_key, status, user_id) VALUES ($1, $4, $2, $3)`, [opId, ST.importingStarted, A.userId, importer]);
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

async function convert(
  recs: Rec[],
  opts: { selection?: ShortSelection; options?: ImportOptions; actor?: Auth; cancelAfter?: number; throwAt?: string; importer?: string } = {},
) {
  const opId = await stage(recs, opts.importer);
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
    const byEmail = await newUser(A, { verified: true });
    const byName = await newUser(A);
    await pool.query('UPDATE users SET name = username WHERE id = $1', [byName.userId]);
    const { opId, result, s } = await convert([
      U({ importIds: [`e-${t}`], emails: [`${byEmail.username.toUpperCase()}@TEST.LOCAL`], username: `outro-${t}`, name: 'Nome Novo', roles: ['operacao', 'nao-existe', 'owner'], bio: 'Bio importada' }),
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
    expect(e.roles).toEqual(['user', 'operacao']);
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

  // Exportação do Slack (ids da origem): basta a ligação feita por uma importação anterior.
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
      { actor, importer: 'slack' },
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
      { actor, importer: 'slack' },
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
    const again = await convert([U({ importIds: [`a2-${t}`], emails: [], username: 'admin', deleted: true })], { importer: 'slack' });
    expect((await userByName('admin')).active).toBe(true);
    expect((await errorsOf(again.opId))[`a2-${t}`]).toEqual(['A conta não foi desativada: é a de quem está fazendo a importação.']);
  });

  it('papel de administrador vindo do arquivo: só para conta nova e só quando quem importa pode dar esse papel', async () => {
    const t = tag();
    const eve = await newUser(A);
    const plain = await newUser(A);
    const { opId } = await convert(
      [
        U({ importIds: [`E-${t}`], emails: [], username: eve.username, roles: ['admin', 'operacao'] }),
        U({ importIds: [`N-${t}`], emails: [`dono-${t}@fora.example`], username: `dono${t}`, roles: ['admin'] }),
        U({ importIds: [`X-${t}`], emails: [], username: `papel${t}`, roles: ['nao-existe', 'owner'] }),
      ],
      { actor: plain },
    );
    // Conta que já existia, encontrada pelo nome: ganha os outros papéis, nunca o de administrador.
    expect((await userByName(eve.username)).roles).toEqual(['user', 'operacao']);
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
    expect((await userByName(eve.username)).roles).toEqual(['user', 'operacao']);
    expect((await errorsOf(again.opId))[`E-${t}`]).toEqual(['O papel de administrador não foi dado: a conta já existia.']);
  });

  it('mesmo nome de usuário com outro e-mail ou outro tipo de conta vira outra conta, com aviso', async () => {
    const t = tag();
    const joao = await newUser(A);
    const semEmail = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [semEmail.userId]);
    const porEmail = await newUser(A, { verified: true });
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
        { actor, importer: 'slack' },
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
    const { opId } = await convert(
      [U({ importIds: [`X-${t}`], emails: [], username: victim.username }), ...fillers, U({ importIds: [`X-${t}`], emails: [], username: victim.username, deleted: true })],
      { importer: 'slack' },
    );
    expect((await row('SELECT active FROM users WHERE id = $1', [victim.userId])).active).toBe(true);
    expect((await errorsOf(opId))[`X-${t}`]).toEqual([
      'A conta não foi desativada: ela foi encontrada pelo e-mail ou pelo nome de usuário, e não por uma importação anterior desta origem.',
    ]);
    // Na importação seguinte a conta já está ligada a esta origem por uma importação anterior.
    await convert([U({ importIds: [`X-${t}`], emails: [], username: victim.username, deleted: true })], { importer: 'slack' });
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

  it('e-mail que a própria conta digitou e não confirmou não junta: outra conta, com aviso que diz como resolver', async () => {
    const t = tag();
    // Cadastro aberto: alguém se cadastra com o e-mail da Ana, que ainda não tem conta aqui.
    expect((await api('POST', 'users.register', { username: `mallory${t}`, name: 'Mallory', email: `ana${t}@explorer.example`, pass: 'Senha-forte-123' })).success).toBe(true);
    const mallory = await login(`mallory${t}`, 'Senha-forte-123');
    // Conta criada pelo admin, com e-mail confirmado, que troca o próprio e-mail para o da Bia: deixa de estar confirmado.
    const eve = await newUser(A, { verified: true });
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { email: `bia${t}@explorer.example`, currentPassword: 'senha-forte-1' } }, eve)).success).toBe(true);
    // Confiáveis: e-mail confirmado, e login externo com o e-mail que veio do diretório (a conta do LDAP nasce confirmada).
    const carlos = await newUser(A, { verified: true });
    const dani = await newUser(A, { verified: true });
    await pool.query(`UPDATE users SET auth_source = 'ldap' WHERE id = $1`, [dani.userId]);
    // Login externo que troca o próprio e-mail (sem senha nem confirmação) para o do Otávio: o login externo não o
    // torna confiável.
    const oscar = await newUser(A, { verified: true });
    await pool.query(`UPDATE users SET auth_source = 'oauth', password_hash = NULL WHERE id = $1`, [oscar.userId]);
    expect((await api('POST', 'users.updateOwnBasicInfo', { data: { email: `otavio${t}@explorer.example` } }, oscar)).success).toBe(true);
    expect(await row('SELECT email_verified, auth_source FROM users WHERE id = $1', [oscar.userId])).toEqual({ email_verified: false, auth_source: 'oauth' });
    const bruno = await newUser(A);
    const { opId, result } = await convert([
      U({ importIds: [`ana-${t}`], emails: [`ANA${t}@explorer.example`], username: `ana${t}`, name: 'Ana Lima' }),
      U({ importIds: [`bia-${t}`], emails: [`bia${t}@explorer.example`], username: `bia${t}` }),
      U({ importIds: [`car-${t}`], emails: [`${carlos.username}@test.local`], username: `carlos${t}` }),
      U({ importIds: [`dan-${t}`], emails: [`${dani.username}@test.local`], username: `dani${t}` }),
      U({ importIds: [`ota-${t}`], emails: [`otavio${t}@explorer.example`], username: `otavio${t}` }),
      C({ importIds: [`G-${t}`], t: 'p', name: `diretoria-${t}`, users: [`ana-${t}`, `bia-${t}`, `ota-${t}`, bruno.username], creator: `ana-${t}` }),
      C({ importIds: [`D-${t}`], t: 'd', users: [bruno.username, `ana-${t}`] }),
      M({ importId: `g1-${t}`, rid: `G-${t}`, u: `ana-${t}`, msg: 'folha de pagamento confidencial', ts: '2021-01-01T00:00:00.000Z' }),
      M({ importId: `d1-${t}`, rid: `D-${t}`, u: bruno.username, msg: 'ana, segue meu atestado', ts: '2021-01-01T00:00:01.000Z' }),
    ]);
    expect(result.users).toMatchObject({ inserted: 3, updated: 2, failed: 0 });
    const ana = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `ana-${t}`)]);
    const bia = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `bia-${t}`)]);
    const ota = await row('SELECT * FROM users WHERE id = $1', [await mapped('user', `ota-${t}`)]);
    expect(ana).toMatchObject({ username: `ana${t}`, email: null, name: 'Ana Lima' });
    expect(bia).toMatchObject({ username: `bia${t}`, email: null });
    expect(ota).toMatchObject({ username: `otavio${t}`, email: null });
    expect([ana.id, bia.id, ota.id]).not.toContain(mallory.userId);
    expect([ana.id, bia.id, ota.id]).not.toContain(eve.userId);
    expect(ota.id).not.toBe(oscar.userId);
    expect(await mapped('user', `car-${t}`)).toBe(carlos.userId);
    expect(await mapped('user', `dan-${t}`)).toBe(dani.userId);
    const g = await mapped('room', `G-${t}`);
    expect(await membersOf(g)).toEqual([`ana${t}`, `bia${t}`, `otavio${t}`, bruno.username].sort());
    expect((await api('GET', 'groups.history', { roomId: g }, mallory)).success).toBe(false);
    expect((await api('GET', 'groups.history', { roomId: g }, eve)).success).toBe(false);
    expect((await api('GET', 'groups.history', { roomId: g }, oscar)).success).toBe(false);
    expect([...(await row('SELECT uids FROM rooms WHERE id = $1', [await mapped('room', `D-${t}`)])).uids].sort()).toEqual([ana.id, bruno.userId].sort());
    const errs = await errorsOf(opId);
    expect(errs[`ana-${t}`]).toEqual([
      `O e-mail "ana${t}@explorer.example" já é da conta "mallory${t}", que não confirmou esse e-mail; importado como "ana${t}", sem ele. ` +
        `Se a conta "mallory${t}" for mesmo desta pessoa, confirme o e-mail dela na administração de usuários e importe de novo: ` +
        `o que foi importado para "ana${t}" passa para "mallory${t}", e "ana${t}" é desativada.`,
    ]);
    expect(errs[`bia-${t}`]?.[0]).toContain(`já é da conta "${eve.username}", que não confirmou esse e-mail`);
    expect(errs[`ota-${t}`]?.[0]).toContain(`já é da conta "${oscar.username}", que não confirmou esse e-mail`);
    expect(errs[`car-${t}`]).toBeUndefined();
    expect(errs[`dan-${t}`]).toBeUndefined();
    // As contas que já existiam não mudaram.
    expect(await row('SELECT email, email_verified FROM users WHERE id = $1', [mallory.userId])).toEqual({ email: `ana${t}@explorer.example`, email_verified: false });
  });

  it('o e-mail dado pela importação que criou a conta vale nas seguintes até a conta trocá-lo; confirmar o e-mail e reimportar junta à conta certa', async () => {
    const t = tag();
    // Criada por uma importação: o e-mail que ela deu vale para a importação seguinte, de outra origem.
    await convert([U({ importIds: [`S1-${t}`], emails: [`rui${t}@a.example`], username: `rui${t}` })], { importer: 'slack' });
    const rui = await userByName(`rui${t}`);
    const second = await convert([U({ importIds: [`rui${t}@a.example`], emails: [`rui${t}@a.example`], username: `rui.costa${t}` })], { importer: 'slack-users' });
    expect(second.result.users).toMatchObject({ inserted: 0, updated: 1 });
    expect(await mapped('user', `rui${t}@a.example`)).toBe(rui.id);
    // A conta troca o e-mail (sem confirmação) para o de outra pessoa: esse não vale.
    await pool.query('UPDATE users SET email = $2 WHERE id = $1', [rui.id, `sara${t}@a.example`]);
    const third = await convert([U({ importIds: [`S2-${t}`], emails: [`sara${t}@a.example`], username: `sara${t}` })], { importer: 'slack' });
    expect(third.result.users).toMatchObject({ inserted: 1, updated: 0 });
    expect(await mapped('user', `S2-${t}`)).not.toBe(rui.id);

    // A conta que se cadastrou sozinha é mesmo da Lia: na primeira importação a Lia do arquivo ganha outra conta; o admin
    // confirma o e-mail e importa de novo, e daí em diante tudo vai para a conta dela.
    expect((await api('POST', 'users.register', { username: `lia${t}`, name: 'Lia', email: `lia${t}@a.example`, pass: 'Senha-forte-123' })).success).toBe(true);
    const lia = await userByName(`lia${t}`);
    const zip = [U({ importIds: [`L-${t}`], emails: [`lia${t}@a.example`], username: `lia${t}` }), C({ importIds: [`GL-${t}`], t: 'p', name: `lia-${t}`, users: [`L-${t}`] })];
    await convert(zip, { importer: 'slack' });
    const copy = await mapped('user', `L-${t}`);
    expect(copy).not.toBe(lia.id);
    expect(await row('SELECT username, email FROM users WHERE id = $1', [copy])).toEqual({ username: `lia${t}.2`, email: null });
    expect((await api('POST', 'users.update', { userId: lia.id, data: { verified: true } }, A)).success).toBe(true);
    const again = await convert(zip, { importer: 'slack' });
    expect(await mapped('user', `L-${t}`)).toBe(lia.id);
    expect(await membersOf(await mapped('room', `GL-${t}`))).toContain(`lia${t}`);
    expect((await errorsOf(again.opId))[`L-${t}`]).toEqual([
      `O usuário "lia${t}" estava ligado à conta "lia${t}.2", que uma importação anterior criou sem o e-mail; agora fica com a conta "lia${t}", dona do e-mail confirmado. ` +
        `As mensagens, as salas e as conversas diretas de "lia${t}.2" passaram para "lia${t}", e "lia${t}.2" foi desativada.`,
    ]);
  });

  it('confirmar o e-mail e importar de novo passa para a conta certa as mensagens, os grupos e as conversas diretas da conta criada no lugar dela', async () => {
    const t = tag();
    expect((await api('POST', 'users.register', { username: `lia${t}`, name: 'Lia', email: `lia${t}@a.example`, pass: 'Senha-forte-123' })).success).toBe(true);
    const lia = await login(`lia${t}`, 'Senha-forte-123');
    const bruno = await newUser(A, { verified: true });
    const carla = await newUser(A, { verified: true });
    const zip = [
      U({ importIds: [`L-${t}`], emails: [`lia${t}@a.example`], username: `lia${t}` }),
      U({ importIds: [`B-${t}`], emails: [`${bruno.username}@test.local`], username: bruno.username }),
      U({ importIds: [`K-${t}`], emails: [`${carla.username}@test.local`], username: carla.username }),
      C({ importIds: [`D-${t}`], t: 'd', users: [`L-${t}`, `B-${t}`] }),
      C({ importIds: [`DK-${t}`], t: 'd', users: [`K-${t}`, `L-${t}`] }),
      C({ importIds: [`G-${t}`], t: 'p', name: `contratos-${t}`, users: [`L-${t}`, `B-${t}`], creator: `L-${t}` }),
      M({ importId: `d1-${t}`, rid: `D-${t}`, u: `B-${t}`, msg: 'oi Lia, segue o contrato', ts: '2021-01-01T00:00:00.000Z' }),
      M({ importId: `d2-${t}`, rid: `D-${t}`, u: `L-${t}`, msg: 'obrigada', ts: '2021-01-01T00:00:01.000Z', reactions: { ':+1:': [`B-${t}`] } }),
      M({ importId: `k1-${t}`, rid: `DK-${t}`, u: `K-${t}`, msg: 'Lia, e o relatório?', ts: '2021-01-01T00:00:02.000Z' }),
      M({ importId: `g1-${t}`, rid: `G-${t}`, u: `L-${t}`, msg: 'mensagem da Lia no grupo', ts: '2021-01-01T00:00:03.000Z', reactions: { ':eyes:': [`L-${t}`] } }),
    ];
    const first = await convert(zip, { importer: 'slack' });
    const copy = await mapped('user', `L-${t}`);
    expect(copy).not.toBe(lia.userId);
    expect((await errorsOf(first.opId))[`L-${t}`]?.[0]).toContain(`o que foi importado para "lia${t}.2" passa para "lia${t}", e "lia${t}.2" é desativada.`);
    const oldDm = await mapped('room', `D-${t}`);
    const oldDk = await mapped('room', `DK-${t}`);
    // Antes da reimportação, a Lia de verdade e a Carla já conversaram aqui: as duas conversas viram uma só.
    const dk = await api('POST', 'im.create', { username: carla.username }, lia);
    expect(dk.success).toBe(true);
    expect((await api('POST', 'chat.sendMessage', { message: { rid: dk.room._id, msg: 'oi Carla, cheguei' } }, lia)).success).toBe(true);
    expect((await api('POST', 'users.update', { userId: lia.userId, data: { verified: true } }, A)).success).toBe(true);

    const again = await convert(zip, { importer: 'slack' });
    expect(await mapped('user', `L-${t}`)).toBe(lia.userId);
    expect(again.result.messages).toMatchObject({ inserted: 0, updated: 4, skipped: 0, failed: 0 });
    // A conversa com o Bruno é a mesma sala, agora entre a Lia e o Bruno, com o histórico.
    expect(await mapped('room', `D-${t}`)).toBe(oldDm);
    const dm = await row('SELECT * FROM rooms WHERE id = $1', [oldDm]);
    expect(dm).toMatchObject({ uids: [lia.userId, bruno.userId].sort(), usernames: [`lia${t}`, bruno.username].sort(), dm_key: [lia.userId, bruno.userId].sort().join(',') });
    expect((await api('GET', 'im.history', { roomId: oldDm }, lia)).messages.map((m: any) => m.msg).sort()).toEqual(['obrigada', 'oi Lia, segue o contrato']);
    expect((await roomMessages(oldDm)).map((m) => [m.user_id, m.username])).toEqual([
      [bruno.userId, bruno.username],
      [lia.userId, `lia${t}`],
    ]);
    // A conversa com a Carla já existia aqui: o histórico importado foi para ela, e a sala antiga saiu.
    expect(await mapped('room', `DK-${t}`)).toBe(dk.room._id);
    expect(await row('SELECT id FROM rooms WHERE id = $1', [oldDk])).toBeUndefined();
    expect((await roomMessages(dk.room._id)).filter((m) => !m.t).map((m) => m.msg)).toEqual(['Lia, e o relatório?', 'oi Carla, cheguei']);
    expect((await row('SELECT msgs FROM rooms WHERE id = $1', [dk.room._id])).msgs).toBe(2);
    // O grupo: a Lia entrou no lugar da outra conta, como dona, e a mensagem é dela.
    const g = await mapped('room', `G-${t}`);
    expect(await membersOf(g)).toEqual([bruno.username, `lia${t}`].sort());
    expect((await row('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [g, lia.userId])).roles).toEqual(['owner']);
    const gm = (await roomMessages(g)).filter((m) => !m.t);
    expect(gm.map((m) => [m.user_id, m.username, m.msg])).toEqual([[lia.userId, `lia${t}`, 'mensagem da Lia no grupo']]);
    expect(gm[0].reactions).toEqual({ ':eyes:': { usernames: [`lia${t}`] } });
    expect((await row('SELECT last_message FROM rooms WHERE id = $1', [g])).last_message.u).toEqual({ _id: lia.userId, username: `lia${t}`, name: 'Lia' });
    expect((await api('GET', 'groups.history', { roomId: g }, lia)).success).toBe(true);
    // A conta criada no lugar dela não fica com nada e está desativada.
    expect(await row('SELECT active FROM users WHERE id = $1', [copy])).toEqual({ active: false });
    expect(await rows('SELECT room_id FROM subscriptions WHERE user_id = $1', [copy])).toEqual([]);
    expect(await rows('SELECT id FROM messages WHERE user_id = $1', [copy])).toEqual([]);
    const errs = await errorsOf(again.opId);
    expect(errs[`L-${t}`]).toEqual([
      `O usuário "lia${t}" estava ligado à conta "lia${t}.2", que uma importação anterior criou sem o e-mail; agora fica com a conta "lia${t}", dona do e-mail confirmado. ` +
        `As mensagens, as salas e as conversas diretas de "lia${t}.2" passaram para "lia${t}", e "lia${t}.2" foi desativada.`,
    ]);
    // Nenhum aviso falso sobre as conversas diretas.
    expect(Object.keys(errs)).toEqual([`L-${t}`]);
    // A terceira importação não muda mais nada.
    const third = await convert(zip, { importer: 'slack' });
    expect(await errorsOf(third.opId)).toEqual({});
    expect(third.result.messages).toMatchObject({ inserted: 0, updated: 4 });

    // Conta ligada sem e-mail que nenhuma importação desta origem criou (era daqui, achada pelo nome): fica com o que tinha.
    const nina = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [nina.userId]);
    const nzip = (email: string[]) => [
      U({ importIds: [`N-${t}`], emails: email, username: nina.username }),
      C({ importIds: [`NG-${t}`], t: 'p', name: `nina-${t}`, users: [`N-${t}`] }),
      M({ importId: `n1-${t}`, rid: `NG-${t}`, u: `N-${t}`, msg: 'da Nina', ts: '2021-01-01T00:00:00.000Z' }),
    ];
    await convert(nzip([]), { importer: 'slack' });
    expect(await mapped('user', `N-${t}`)).toBe(nina.userId);
    const dona = await newUser(A, { verified: true });
    const moved = await convert(nzip([`${dona.username}@test.local`]), { importer: 'slack' });
    expect(await mapped('user', `N-${t}`)).toBe(dona.userId);
    expect((await roomMessages(await mapped('room', `NG-${t}`))).map((m) => m.user_id)).toEqual([nina.userId]);
    expect(await row('SELECT active FROM users WHERE id = $1', [nina.userId])).toEqual({ active: true });
    expect((await errorsOf(moved.opId))[`N-${t}`]).toEqual([
      `O usuário "${nina.username}" estava ligado à conta "${nina.username}", que não tem e-mail; agora fica com a conta "${dona.username}", dona do e-mail confirmado. ` +
        `O que já tinha sido importado continua na conta "${nina.username}".`,
    ]);
  });

  it('ligação de uma importação anterior não junta outra pessoa: com outro e-mail, a conta ligada não recebe nada', async () => {
    const t = tag();
    const joao = await newUser(A, { verified: true });
    const maria = await newUser(A);
    // 1º arquivo: outro João, com outro e-mail, ganha a conta "joao.2", ligada ao id J.
    await convert([U({ importIds: [`J-${t}`], emails: [`joao.silva${t}@outra.example`], username: joao.username })]);
    const silva = await mapped('user', `J-${t}`);
    expect(silva).not.toBe(joao.userId);
    // 2º arquivo, de outra origem, com o mesmo id e o e-mail da conta daqui: é o João daqui.
    const { opId } = await convert([
      U({ importIds: [`J-${t}`], emails: [`${joao.username}@test.local`], username: joao.username }),
      C({ importIds: [`RH-${t}`], t: 'p', name: `rh-${t}`, users: [`J-${t}`, maria.username] }),
      C({ importIds: [`DJ-${t}`], t: 'd', users: [maria.username, `J-${t}`] }),
      M({ importId: `rh1-${t}`, rid: `RH-${t}`, u: `J-${t}`, msg: 'salários do RH', ts: '2021-02-01T00:00:00.000Z' }),
    ]);
    expect(await mapped('user', `J-${t}`)).toBe(joao.userId);
    const rh = await mapped('room', `RH-${t}`);
    expect(await membersOf(rh)).toEqual(['admin', joao.username, maria.username].sort());
    expect((await roomMessages(rh)).map((m) => m.user_id)).toEqual([joao.userId]);
    expect([...(await row('SELECT uids FROM rooms WHERE id = $1', [await mapped('room', `DJ-${t}`)])).uids].sort()).toEqual([joao.userId, maria.userId].sort());
    expect((await errorsOf(opId))[`J-${t}`]).toEqual([
      `O usuário "${joao.username}" estava ligado à conta "${joao.username}.2" por uma importação anterior, mas ela tem outro e-mail; não foi juntado a ela, e sim à conta "${joao.username}", dona do e-mail confirmado.`,
    ]);

    // Ligado antes só pelo nome (sem e-mail), e agora com um e-mail que contradiz o da conta: outra conta.
    const jose = await newUser(A, { verified: true });
    await convert([U({ importIds: [`JS-${t}`], emails: [], username: jose.username })]);
    expect(await mapped('user', `JS-${t}`)).toBe(jose.userId);
    const later = await convert([
      U({ importIds: [`JS-${t}`], emails: [`jose.silva${t}@outra.example`], username: jose.username }),
      C({ importIds: [`PJ-${t}`], t: 'p', name: `proj-${t}`, users: [`JS-${t}`] }),
    ]);
    const other = await mapped('user', `JS-${t}`);
    expect(other).not.toBe(jose.userId);
    expect(await row('SELECT username, email FROM users WHERE id = $1', [other])).toEqual({ username: `${jose.username}.2`, email: `jose.silva${t}@outra.example` });
    expect(await membersOf(await mapped('room', `PJ-${t}`))).toEqual(['admin', `${jose.username}.2`].sort());
    expect((await errorsOf(later.opId))[`JS-${t}`]).toEqual([
      `O usuário "${jose.username}" estava ligado à conta "${jose.username}" por uma importação anterior, mas ela tem outro e-mail; não foi juntado a ela; importado como "${jose.username}.2".`,
    ]);

    // Com outro e-mail, também não junta pelo nome a outra conta daqui (sem e-mail) que tem o nome do arquivo: conta nova.
    const m = await newUser(A, { verified: true });
    await convert([U({ importIds: [`JM-${t}`], emails: [`${m.username}@test.local`], username: `qualquer${t}` })], { importer: 'slack' });
    expect(await mapped('user', `JM-${t}`)).toBe(m.userId);
    const x = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [x.userId]);
    const third = await convert(
      [U({ importIds: [`JM-${t}`], emails: [`outra${t}@outra.example`], username: x.username }), C({ importIds: [`PM-${t}`], t: 'p', name: `pm-${t}`, users: [`JM-${t}`] })],
      { importer: 'slack' },
    );
    const now = await mapped('user', `JM-${t}`);
    expect([m.userId, x.userId]).not.toContain(now);
    expect(await row('SELECT username, email FROM users WHERE id = $1', [now])).toEqual({ username: `${x.username}.2`, email: `outra${t}@outra.example` });
    expect(await membersOf(await mapped('room', `PM-${t}`))).toEqual(['admin', `${x.username}.2`].sort());
    expect((await errorsOf(third.opId))[`JM-${t}`]).toEqual([
      `O usuário "${x.username}" estava ligado à conta "${m.username}" por uma importação anterior, mas ela tem outro e-mail; não foi juntado a ela; importado como "${x.username}.2".`,
    ]);
  });

  it('lista de membros do Slack ou CSV só desativa as contas que uma importação dela criou', async () => {
    const t = tag();
    const ana = await newUser(A, { verified: true });
    const email = `${ana.username}@test.local`;
    const novo = `novo${t}@ws.example`;
    // Lista A: a Ana daqui é encontrada pelo e-mail; "novo" é criado pela lista.
    await convert([U({ importIds: [email], emails: [email], username: 'ana' }), U({ importIds: [novo], emails: [novo], username: `novo${t}` })], { importer: 'slack-users' });
    expect(await mapped('user', email)).toBe(ana.userId);
    // Lista B, de outro workspace: as duas aparecem desativadas.
    const { opId } = await convert(
      [U({ importIds: [email], emails: [email], username: 'ana.b', deleted: true }), U({ importIds: [novo], emails: [novo], username: `novo${t}`, deleted: true })],
      { importer: 'slack-users' },
    );
    expect((await row('SELECT active FROM users WHERE id = $1', [ana.userId])).active).toBe(true);
    expect((await api('GET', 'me', undefined, ana)).username).toBe(ana.username);
    expect((await userByName(`novo${t}`)).active).toBe(false);
    expect((await errorsOf(opId))[email]).toEqual(['A conta não foi desativada: ela não foi criada por uma importação desta origem, e este tipo de arquivo só desativa as contas que ele mesmo criou.']);

    // Conta criada por outra origem (a API) com o e-mail como id: uma lista de membros do Slack não a desativa.
    const api1 = `api${t}@ws.example`;
    await convert([U({ importIds: [api1], emails: [api1], username: `api${t}` })], { importer: 'api' });
    const fromApi = await convert([U({ importIds: [api1], emails: [api1], username: `api${t}`, deleted: true })], { importer: 'slack-users' });
    expect((await userByName(`api${t}`)).active).toBe(true);
    expect((await errorsOf(fromApi.opId))[api1]).toEqual(['A conta não foi desativada: ela não foi criada por uma importação desta origem, e este tipo de arquivo só desativa as contas que ele mesmo criou.']);

    // CSV: a conta ligada pelo nome num CSV anterior continua ativa.
    const victim = await newUser(A);
    await convert([U({ importIds: [`csv:u:${victim.username}`], emails: [], username: victim.username })]);
    await convert([U({ importIds: [`csv:u:${victim.username}`], emails: [], username: victim.username, deleted: true })]);
    expect((await row('SELECT active FROM users WHERE id = $1', [victim.userId])).active).toBe(true);
  });

  it('e-mail que não é e-mail ("-", "n/a", espaços) vale como sem e-mail: junta pelo nome e não duplica a conta', async () => {
    const t = tag();
    const carlos = await newUser(A);
    const { opId, result } = await convert([
      U({ importIds: [`C-${t}`], emails: ['-'], username: carlos.username, name: 'Carlos' }),
      U({ importIds: [`N-${t}`], emails: ['n/a', '   ', 'nao-tem'], username: `nina${t}` }),
      U({ importIds: [`X-${t}`], emails: ['-'] }),
      C({ importIds: [`csv:c:ti-${t}`], t: 'p', name: `ti-${t}`, users: [`C-${t}`, `N-${t}`] }),
    ]);
    expect(result.users).toMatchObject({ inserted: 1, updated: 1, failed: 1 });
    expect(await mapped('user', `C-${t}`)).toBe(carlos.userId);
    expect(await userByName(`${carlos.username}.2`)).toBeUndefined();
    expect((await userByName(`nina${t}`)).email).toBeNull();
    expect(await membersOf(await mapped('room', `csv:c:ti-${t}`))).toEqual(['admin', carlos.username, `nina${t}`].sort());
    expect(await errorsOf(opId)).toEqual({ [`X-${t}`]: ['Usuário sem e-mail e sem nome de usuário.'] });
  });

  it('e-mail de mais de 254 caracteres não vale e não é cortado: o começo dele não junta à conta que tem esse e-mail', async () => {
    const t = tag();
    // Exatamente 254 caracteres, confirmado; no arquivo vem com um caractere a mais.
    const e254 = `${'d'.repeat(244 - t.length)}${t}@x.example`;
    expect(e254).toHaveLength(254);
    const dono = await api('POST', 'users.create', { username: `dono${t}`, name: 'Dono', email: e254, password: 'senha-forte-1', verified: true }, A);
    expect(dono.success).toBe(true);
    const { result } = await convert([
      U({ importIds: [`L-${t}`], emails: [`${e254}m`], username: `longo${t}` }),
      C({ importIds: [`csv:c:dir-${t}`], t: 'p', name: `dir-${t}`, users: [`L-${t}`] }),
    ]);
    expect(result.users).toMatchObject({ inserted: 1, updated: 0 });
    const novo = await userByName(`longo${t}`);
    expect(novo.id).not.toBe(dono.user._id);
    expect(novo.email).toBeNull();
    expect(await mapped('user', `L-${t}`)).toBe(novo.id);
    expect(await membersOf(await mapped('room', `csv:c:dir-${t}`))).toEqual(['admin', `longo${t}`].sort());
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

  it('conversa direta ligada pelo id, mas hoje entre outras pessoas, não recebe as mensagens: elas vão para a conversa certa', async () => {
    const t = tag();
    const jo = await newUser(A, { verified: true });
    const ma = await newUser(A);
    const dmId = `csv:d:${jo.username}/${ma.username}`;
    // 1º CSV, só com directmessages/: os nomes são as contas daqui.
    await convert([
      C({ importIds: [dmId], t: 'd', users: [jo.username, ma.username] }),
      M({ importId: `p1-${t}`, rid: dmId, u: jo.username, msg: 'oi Maria (Pereira)', ts: '2023-11-14T22:13:20.000Z' }),
      M({ importId: `p2-${t}`, rid: dmId, u: ma.username, msg: 'oi João', ts: '2023-11-14T22:14:00.000Z' }),
    ]);
    const old = await mapped('room', dmId);
    // 2º CSV, de outra origem: "jo" é outra pessoa (outro e-mail) e ganha outra conta; a conversa tem o mesmo id.
    const { opId, result } = await convert([
      U({ importIds: [jo.username], emails: [`silva${t}@outra.example`], username: jo.username, name: 'João Silva' }),
      C({ importIds: [dmId], t: 'd', users: [jo.username, ma.username] }),
      M({ importId: `s1-${t}`, rid: dmId, u: jo.username, msg: 'Maria, meu salário é 9 mil (Silva)', ts: '2023-11-14T22:15:00.000Z' }),
      // Uma mensagem com o id de uma da conversa antiga: lá ela fica como estava.
      M({ importId: `p2-${t}`, rid: dmId, u: ma.username, msg: 'texto da outra conversa', ts: '2023-11-14T22:14:00.000Z' }),
    ]);
    expect(result.messages).toMatchObject({ inserted: 1, updated: 0, skipped: 1, failed: 0 });
    const silva = await mapped('user', jo.username);
    expect(silva).not.toBe(jo.userId);
    const now = await mapped('room', dmId);
    expect(now).not.toBe(old);
    expect([...(await row('SELECT uids FROM rooms WHERE id = $1', [now])).uids].sort()).toEqual([silva, ma.userId].sort());
    expect((await roomMessages(old)).map((m) => m.msg)).toEqual(['oi Maria (Pereira)', 'oi João']);
    expect((await roomMessages(now)).map((m) => m.msg)).toEqual(['Maria, meu salário é 9 mil (Silva)']);
    const seen = await api('GET', 'im.history', { roomId: old }, jo);
    expect(seen.messages.map((m: any) => m.msg).sort()).toEqual(['oi João', 'oi Maria (Pereira)']);
    const who = [`${jo.username}.2`, ma.username].sort().join(', ');
    expect((await errorsOf(opId))[dmId]).toEqual([
      `A sala ligada a esta conversa direta por uma importação anterior não é a conversa entre ${who}; esta importação usa a conversa entre essas pessoas, ` +
        'e as mensagens importadas antes continuam na sala antiga.',
    ]);
  });

  it('sala ligada pelo id, mas hoje de outro tipo, vira outra sala: conteúdo privado nunca vai para um canal público', async () => {
    const t = tag();
    const ana = await newUser(A);
    const bruno = await newUser(A);
    const dave = await newUser(A);
    // Exportação 1: canal público. Exportação 2: o mesmo canal (mesmo id) virou privado no Slack.
    await convert(
      [
        C({ importIds: [`C1-${t}`], t: 'c', name: `projeto-${t}`, users: [ana.username] }),
        M({ importId: `m1-${t}`, rid: `C1-${t}`, u: ana.username, msg: 'mensagem pública', ts: '2022-01-01T00:00:00.000Z' }),
      ],
      { importer: 'slack' },
    );
    const pub = await mapped('room', `C1-${t}`);
    const { opId } = await convert(
      [
        C({ importIds: [`C1-${t}`], t: 'p', name: `projeto-${t}`, users: [ana.username, bruno.username] }),
        M({ importId: `m1-${t}`, rid: `C1-${t}`, u: ana.username, msg: 'mensagem pública, editada depois de virar privado', ts: '2022-01-01T00:00:00.000Z' }),
        M({ importId: `m2-${t}`, rid: `C1-${t}`, u: bruno.username, msg: 'agora é privado: demissões em março', ts: '2022-02-01T00:00:00.000Z' }),
      ],
      { importer: 'slack' },
    );
    const priv = await mapped('room', `C1-${t}`);
    expect(priv).not.toBe(pub);
    expect(await row('SELECT t, name FROM rooms WHERE id = $1', [pub])).toEqual({ t: 'c', name: `projeto-${t}` });
    expect(await row('SELECT t, name FROM rooms WHERE id = $1', [priv])).toEqual({ t: 'p', name: `projeto-${t}-2` });
    expect(await membersOf(pub)).toEqual(['admin', ana.username].sort());
    expect(await membersOf(priv)).toEqual(['admin', ana.username, bruno.username].sort());
    expect((await roomMessages(pub)).map((m) => m.msg)).toEqual(['mensagem pública']);
    expect((await roomMessages(priv)).map((m) => m.msg)).toEqual(['agora é privado: demissões em março']);
    const seen = await api('GET', 'channels.history', { roomId: pub }, dave);
    expect(seen.messages.map((m: any) => m.msg)).toEqual(['mensagem pública']);
    expect((await errorsOf(opId))[`C1-${t}`]).toEqual([`O canal "projeto-${t}" estava ligado à sala "projeto-${t}", que hoje é um canal público, e no arquivo ele é privado; importado como "projeto-${t}-2".`]);

    // A sala virou privada aqui: reimportar a mesma exportação não põe ninguém nela.
    await convert([C({ importIds: [`C2-${t}`], t: 'c', name: `sala-${t}`, users: [ana.username] })], { importer: 'slack' });
    const fechada = await mapped('room', `C2-${t}`);
    await pool.query(`UPDATE rooms SET t = 'p' WHERE id = $1`, [fechada]);
    const again = await convert([C({ importIds: [`C2-${t}`], t: 'c', name: `sala-${t}`, users: [ana.username, bruno.username] })], { importer: 'slack' });
    expect(await membersOf(fechada)).toEqual(['admin', ana.username].sort());
    expect(await mapped('room', `C2-${t}`)).not.toBe(fechada);
    expect((await errorsOf(again.opId))[`C2-${t}`]).toEqual([`O canal "sala-${t}" estava ligado à sala "sala-${t}", que hoje é um grupo privado, e no arquivo ele é público; importado como "sala-${t}-2".`]);

    // No CSV o id é o nome: um grupo privado de outro arquivo com o nome de um canal público também vira outra sala.
    await convert([C({ importIds: [`csv:c:diretoria-${t}`], t: 'c', name: `diretoria-${t}`, users: [ana.username] })]);
    const aberto = await mapped('room', `csv:c:diretoria-${t}`);
    await convert([
      C({ importIds: [`csv:c:diretoria-${t}`], t: 'p', name: `diretoria-${t}`, users: [bruno.username] }),
      M({ rid: `csv:c:diretoria-${t}`, u: bruno.username, msg: 'salários da diretoria: confidencial', ts: '2022-03-01T00:00:00.000Z' }),
    ]);
    expect(await membersOf(aberto)).toEqual(['admin', ana.username].sort());
    expect(await roomMessages(aberto)).toEqual([]);
    const grupo = await mapped('room', `csv:c:diretoria-${t}`);
    expect(await row('SELECT t FROM rooms WHERE id = $1', [grupo])).toEqual({ t: 'p' });

    // Grupo privado nunca cai no canal padrão, que é público.
    await convert([C({ importIds: [`GD-${t}`], t: 'p', name: `geral-privado-${t}`, isDefault: true, users: [] })], { importer: 'slack' });
    expect(await mapped('room', `GD-${t}`)).not.toBe(await geralId());
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
    expect(result.messages).toMatchObject({ inserted: 1, skipped: 2, failed: 2 });
    expect(s).toMatchObject({ completed: 3, skipped: 5, error: 2 });
    expect(await userByName(`s2${t}`)).toBeUndefined();
    const errs = await errorsOf(opId);
    expect(errs['autor não selecionado']).toEqual([`Autor não encontrado: S2-${t}`]);
    expect(errs['sala desconhecida']).toEqual([`Sala não encontrada: nada-${t}`]);
    expect((await rows('SELECT 1 FROM import_records WHERE operation_id = $1 AND skipped', [opId])).length).toBe(5);
    // Só o selecionado entrou na sala.
    expect((await rows('SELECT user_id FROM subscriptions WHERE room_id = $1', [await mapped('room', `SC1-${t}`)])).length).toBe(2);

    // Mensagens diretas selecionadas pelo item único "Mensagens diretas".
    const dms = await convert([C({ importIds: [`SD2-${t}`], t: 'd', users: [`S1-${t}`, 'admin'] })], { selection: { channels: { list: [DIRECT_MESSAGES_ID] } } });
    expect(dms.result.channels).toMatchObject({ inserted: 1 });
  });

  it('usuário não selecionado (por já existir aqui) fica com a conta daqui pelo e-mail confirmado ou pelo nome, sem mudar nada nela', async () => {
    const t = tag();
    const des = await newUser(A, { verified: true });
    const nom = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [nom.userId]);
    expect((await api('POST', 'users.register', { username: `mal${t}`, name: 'Mal', email: `eva${t}@a.example`, pass: 'Senha-forte-123' })).success).toBe(true);
    const sel = `csv:u:sel${t}@a.example`;
    const ids = { des: `csv:u:${des.username}@test.local`, nom: `csv:u:${nom.username}`, eva: `csv:u:eva${t}@a.example`, novo: `csv:u:novo${t}` };
    const { opId, result } = await convert(
      [
        U({ importIds: [sel], emails: [`sel${t}@a.example`], username: `sel${t}` }),
        U({ importIds: [ids.des], emails: [`${des.username}@test.local`], username: des.username, name: 'Outro Nome' }),
        U({ importIds: [ids.nom], emails: [], username: nom.username }),
        // O e-mail é de uma conta que não o confirmou: nem por ele nem pelo nome.
        U({ importIds: [ids.eva], emails: [`eva${t}@a.example`], username: `mal${t}` }),
        U({ importIds: [ids.novo], emails: [], username: `novo${t}` }),
        C({ importIds: [`csv:c:time-${t}`], t: 'p', name: `time-${t}`, users: [sel, ids.des, ids.nom, ids.eva, ids.novo] }),
        M({ rid: `csv:c:time-${t}`, u: ids.des, msg: 'do des', ts: '2021-01-01T00:00:00.000Z' }),
        M({ rid: `csv:c:time-${t}`, u: ids.nom, msg: 'do nom', ts: '2021-01-01T00:00:01.000Z' }),
        M({ rid: `csv:c:time-${t}`, u: ids.eva, msg: 'da eva', ts: '2021-01-01T00:00:02.000Z' }),
        M({ rid: `csv:c:time-${t}`, u: ids.novo, msg: 'do novo', ts: '2021-01-01T00:00:03.000Z' }),
      ],
      { selection: { users: { list: [sel] }, channels: { all: true } } },
    );
    expect(result.users).toMatchObject({ inserted: 1, skipped: 4 });
    expect(result.messages).toMatchObject({ inserted: 2, failed: 2 });
    const room = await mapped('room', `csv:c:time-${t}`);
    expect(await membersOf(room)).toEqual(['admin', des.username, nom.username, `sel${t}`].sort());
    expect((await roomMessages(room)).map((m) => [m.user_id, m.msg])).toEqual([
      [des.userId, 'do des'],
      [nom.userId, 'do nom'],
    ]);
    const errs = await errorsOf(opId);
    expect(errs['da eva']).toEqual([`Autor não encontrado: ${ids.eva}`]);
    expect(errs['do novo']).toEqual([`Autor não encontrado: ${ids.novo}`]);
    // Nada muda nas contas, nenhuma conta nova, e o vínculo não é gravado.
    expect((await row('SELECT name FROM users WHERE id = $1', [des.userId])).name).not.toBe('Outro Nome');
    expect(await userByName(`novo${t}`)).toBeUndefined();
    expect(await mapped('user', ids.des)).toBeNull();
  });

  it('a prévia mostra como já existente só o que a importação junta: e-mail confiável, ligação que confere e sala do mesmo tipo', async () => {
    const t = tag();
    expect((await api('POST', 'users.register', { username: `mal${t}`, name: 'Mal', email: `ana${t}@a.example`, pass: 'Senha-forte-123' })).success).toBe(true);
    const carlos = await newUser(A, { verified: true });
    const semEmail = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [semEmail.userId]);
    const comEmail = await newUser(A);
    const livre = await newUser(A);
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [livre.userId]);
    const m = await newUser(A, { verified: true });
    await convert([U({ importIds: [`J-${t}`], emails: [`${m.username}@test.local`], username: `j${t}` })], { importer: 'slack' });
    await convert([C({ importIds: [`C1-${t}`], t: 'c', name: `aberto-${t}`, users: [] })], { importer: 'slack' });
    const opId = await stage(
      [
        U({ importIds: [`ana-${t}`], emails: [`ana${t}@a.example`], username: `ana${t}` }),
        // E-mail de uma conta que não o confirmou: nem pelo nome de uma conta daqui sem e-mail.
        U({ importIds: [`liv-${t}`], emails: [`ana${t}@a.example`], username: livre.username }),
        U({ importIds: [`car-${t}`], emails: [`${carlos.username}@test.local`], username: `c${t}` }),
        U({ importIds: [`sem-${t}`], emails: ['-'], username: semEmail.username }),
        U({ importIds: [`com-${t}`], emails: ['n/a'], username: comEmail.username }),
        U({ importIds: [`J-${t}`], emails: [`outra${t}@outra.example`], username: semEmail.username }),
        C({ importIds: [`C1-${t}`], t: 'p', name: `aberto-${t}`, users: [] }),
        C({ importIds: [`GD-${t}`], t: 'p', name: `privado-${t}`, isDefault: true, users: [] }),
        C({ importIds: [`CD-${t}`], t: 'c', name: `publico-${t}`, isDefault: true, users: [] }),
      ],
      'slack',
    );
    const preview = await buildSelection(opId);
    expect(Object.fromEntries(preview.users.map((u) => [u.user_id, u.is_email_taken]))).toEqual({
      [`ana-${t}`]: false,
      [`liv-${t}`]: false,
      [`car-${t}`]: true,
      [`sem-${t}`]: true,
      [`com-${t}`]: true,
      [`J-${t}`]: false,
    });
    expect(Object.fromEntries(preview.channels.map((c) => [c.channel_id, c.exists]))).toEqual({ [`C1-${t}`]: false, [`GD-${t}`]: false, [`CD-${t}`]: true });
    // A conversão faz o que a prévia mostrou.
    const { result } = await convert(
      [
        U({ importIds: [`ana-${t}`], emails: [`ana${t}@a.example`], username: `ana${t}` }),
        U({ importIds: [`sem-${t}`], emails: ['-'], username: semEmail.username }),
        U({ importIds: [`com-${t}`], emails: ['n/a'], username: comEmail.username }),
        U({ importIds: [`J-${t}`], emails: [`outra${t}@outra.example`], username: semEmail.username }),
      ],
      { importer: 'slack' },
    );
    expect(result.users).toMatchObject({ inserted: 2, updated: 2 });
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
