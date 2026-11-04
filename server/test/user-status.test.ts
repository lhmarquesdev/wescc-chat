import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, type Auth } from './helpers';

// Status personalizados (Administração › Status do usuário) e o que eles mudam na presença.
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(() => stopServer());

type Ws = ReturnType<typeof connectWs>;
// Espera um evento que chegue depois deste ponto (os anteriores não contam).
function next(ws: Ws, pred: (e: any) => boolean, ms = 5000) {
  const since = ws.events.length;
  return () => ws.waitFor((e) => ws.events.indexOf(e) >= since && pred(e), ms);
}
async function online(auth: Auth) {
  const ws = connectWs(auth);
  await ws.ready;
  return ws;
}
const list = (auth: Auth) => api('GET', 'custom-user-status.list', {}, auth);
const create = (auth: Auth, name: unknown, statusType: unknown) => api('POST', 'custom-user-status.create', { name, statusType }, auth);
const update = (auth: Auth, _id: string, name: unknown, statusType: unknown) => api('POST', 'custom-user-status.update', { _id, name, statusType }, auth);
const remove = (auth: Auth, customUserStatusId: string) => api('POST', 'custom-user-status.delete', { customUserStatusId }, auth);
const pick = (auth: Auth, body: Record<string, unknown>) => api('POST', 'users.setStatus', body, auth);
const dbUser = async (id: string) => (await pool.query('SELECT status, status_default, status_custom FROM users WHERE id = $1', [id])).rows[0];

describe('status personalizados: cadastro', () => {
  it('a migração semeia os quatro da operação', async () => {
    const r = await list(A);
    expect(r.success).toBe(true);
    const byName = Object.fromEntries(r.statuses.map((s: any) => [s.name, s.statusType]));
    expect(byName).toMatchObject({ 'Em pausa': 'away', 'Em atendimento': 'busy', Almoço: 'away', 'Em reunião': 'busy' });
    // Ordem: por tipo (disponível, ausente, ocupado, invisível) e nome.
    const types = r.statuses.map((s: any) => s.statusType);
    expect(types).toEqual([...types].sort((a: string, b: string) => ['online', 'away', 'busy', 'offline'].indexOf(a) - ['online', 'away', 'busy', 'offline'].indexOf(b)));
  });

  it('a lista é de qualquer pessoa logada; usersCount só para quem gerencia', async () => {
    const u = await newUser(A);
    expect((await api('GET', 'custom-user-status.list', {})).status).toBe(401);
    const mine = await list(u);
    expect(mine.statuses.length).toBeGreaterThanOrEqual(4);
    expect(mine.statuses.every((s: any) => !('usersCount' in s))).toBe(true);
    expect((await list(A)).statuses.every((s: any) => typeof s.usersCount === 'number')).toBe(true);
  });

  it('criar, editar e excluir pedem manage-user-status', async () => {
    const u = await newUser(A);
    expect((await create(u, 'Plantão', 'busy')).status).toBe(403);
    expect((await update(u, 'status-almoco', 'Almoço', 'busy')).status).toBe(403);
    expect((await remove(u, 'status-almoco')).status).toBe(403);
  });

  it('valida nome, tipo, repetido sem acento, reservado e o limite de 30', async () => {
    const err = async (p: Promise<any>) => {
      const r = await p;
      return [r.status, r.errorType, r.error];
    };
    expect(await err(create(A, '', 'busy'))).toEqual([400, 'error-invalid-name', 'O nome precisa ter de 1 a 40 caracteres.']);
    expect(await err(create(A, '   ', 'busy'))).toEqual([400, 'error-invalid-name', 'O nome precisa ter de 1 a 40 caracteres.']);
    expect(await err(create(A, 'x'.repeat(41), 'busy'))).toEqual([400, 'error-invalid-name', 'O nome precisa ter de 1 a 40 caracteres.']);
    expect(await err(create(A, 'Pausa curta', 'dnd'))).toEqual([400, 'error-invalid-status-type', 'Tipo de status inválido.']);
    expect(await err(create(A, 'almoco', 'away'))).toEqual([400, 'error-status-name-exists', 'Já existe um status com esse nome.']);
    expect(await err(create(A, 'ALMOÇO', 'busy'))).toEqual([400, 'error-status-name-exists', 'Já existe um status com esse nome.']);
    expect(await err(create(A, 'Ocupado', 'busy'))).toEqual([400, 'error-status-name-reserved', 'Esse nome já é de um status padrão.']);
    expect(await err(create(A, 'invisivel', 'offline'))).toEqual([400, 'error-status-name-reserved', 'Esse nome já é de um status padrão.']);
    expect(await err(update(A, 'nao-existe', 'Qualquer', 'busy'))).toEqual([404, 'error-status-not-found', 'Status não encontrado.']);
    expect(await err(remove(A, 'nao-existe'))).toEqual([404, 'error-status-not-found', 'Status não encontrado.']);
    // Espaços colapsados e 40 caracteres valem.
    const ok = await create(A, `  Treinamento   ${'a'.repeat(28)} `, 'away');
    expect(ok.customUserStatus).toMatchObject({ name: `Treinamento ${'a'.repeat(28)}`, statusType: 'away' });
    // Editar para o nome de outro também é recusado; para o próprio nome (com outra caixa) não.
    expect(await err(update(A, ok.customUserStatus._id, 'Em Pausa', 'away'))).toEqual([400, 'error-status-name-exists', 'Já existe um status com esse nome.']);
    expect((await update(A, ok.customUserStatus._id, `TREINAMENTO ${'a'.repeat(28)}`, 'away')).success).toBe(true);

    const created: string[] = [ok.customUserStatus._id];
    try {
      const have = (await list(A)).statuses.length;
      for (let i = have; i < 30; i++) created.push((await create(A, `Limite ${i}`, 'online')).customUserStatus._id);
      expect((await list(A)).statuses).toHaveLength(30);
      expect(await err(create(A, 'O trigésimo primeiro', 'online'))).toEqual([400, 'error-too-many-statuses', 'Limite de 30 status personalizados.']);
    } finally {
      for (const id of created) await remove(A, id);
    }
  });

  // Revisão: contar e inserir eram passos soltos; 40 pedidos ao mesmo tempo deixavam 34 status na tabela.
  it('pedidos ao mesmo tempo não passam do limite de 30', async () => {
    const have = (await list(A)).statuses.length;
    const tag = Date.now();
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => create(A, `Paralelo ${tag} ${i}`, 'online')));
    try {
      expect(res.filter((r) => r.success)).toHaveLength(30 - have);
      expect(res.filter((r) => !r.success).every((r) => r.status === 400 && r.errorType === 'error-too-many-statuses')).toBe(true);
      expect((await pool.query('SELECT count(*)::int AS n FROM custom_user_statuses')).rows[0].n).toBe(30);
    } finally {
      for (const r of res) if (r.success) await remove(A, r.customUserStatus._id);
    }
  });
});

describe('status personalizados: escolher', () => {
  it('escolher manda a presença para todos e a escolha só para a própria pessoa', async () => {
    const u = await newUser(A);
    const other = await newUser(A);
    const [wu, wo] = await Promise.all([online(u), online(other)]);
    try {
      const presU = next(wu, (e) => e.type === 'presence' && e.userId === u.userId && e.status === 'busy');
      const presO = next(wo, (e) => e.type === 'presence' && e.userId === u.userId && e.status === 'busy');
      const self = next(wu, (e) => e.type === 'user' && e.user._id === u.userId && e.user.statusCustom === 'status-em-reuniao');
      expect((await pick(u, { statusId: 'status-em-reuniao' })).success).toBe(true);
      expect((await presO()).statusCustom).toBe('status-em-reuniao');
      expect((await presU()).statusCustom).toBe('status-em-reuniao');
      expect((await self()).user).toEqual({ _id: u.userId, statusDefault: 'busy', statusCustom: 'status-em-reuniao' });
      await sleep(200);
      expect(wo.events.some((e) => e.type === 'user' && e.user._id === u.userId)).toBe(false);
      expect(await api('GET', 'me', undefined, u)).toMatchObject({ statusDefault: 'busy', statusCustom: 'status-em-reuniao' });
      expect((await api('GET', 'users.info', { userId: u.userId }, other)).user.statusCustom).toBe('status-em-reuniao');
      expect((await api('GET', 'users.getStatus', { userId: u.userId }, other)).statusCustom).toBe('status-em-reuniao');

      // statusId ganha de status.
      expect((await pick(u, { statusId: 'status-em-pausa', status: 'online' })).success).toBe(true);
      expect(await dbUser(u.userId)).toEqual({ status: 'away', status_default: 'away', status_custom: 'status-em-pausa' });

      // Um status de base limpa o personalizado.
      const cleared = next(wu, (e) => e.type === 'user' && e.user._id === u.userId && e.user.statusCustom === null);
      expect((await pick(u, { status: 'online' })).success).toBe(true);
      expect((await cleared()).user).toMatchObject({ statusDefault: 'online' });
      expect(await api('GET', 'me', undefined, u)).toMatchObject({ statusDefault: 'online', statusCustom: null });

      // O "status" pelo WebSocket (a web antiga e o /away) também limpa.
      await pick(u, { statusId: 'status-almoco' });
      wu.send({ type: 'status', status: 'busy' });
      await next(wu, (e) => e.type === 'presence' && e.userId === u.userId && e.status === 'busy')();
      expect(await dbUser(u.userId)).toMatchObject({ status_custom: null });
      // Só a mensagem não mexe no status escolhido.
      await pick(u, { statusId: 'status-almoco' });
      expect((await pick(u, { message: 'volto às 14h' })).success).toBe(true);
      expect(await dbUser(u.userId)).toMatchObject({ status_custom: 'status-almoco' });
    } finally {
      wu.close();
      wo.close();
    }
  });

  it('statusId que não existe → 400 "Status não encontrado."', async () => {
    const u = await newUser(A);
    const r = await pick(u, { statusId: 'nao-existe' });
    expect([r.status, r.errorType, r.error]).toEqual([400, 'error-invalid-status', 'Status não encontrado.']);
  });

  it('o administrador escolhe por outra pessoa com edit-other-user-info', async () => {
    const u = await newUser(A);
    const other = await newUser(A);
    expect((await pick(other, { userId: u.userId, statusId: 'status-em-reuniao' })).status).toBe(403);
    expect((await pick(A, { userId: u.userId, statusId: 'status-em-reuniao' })).success).toBe(true);
    expect(await dbUser(u.userId)).toMatchObject({ status_default: 'busy', status_custom: 'status-em-reuniao' });
  });

  it('status personalizado invisível não se revela', async () => {
    const ghost = (await create(A, `Fora do ar ${Date.now()}`, 'offline')).customUserStatus;
    const u = await newUser(A);
    const other = await newUser(A);
    const [wu, wo] = await Promise.all([online(u), online(other)]);
    try {
      const pres = next(wo, (e) => e.type === 'presence' && e.userId === u.userId && e.status === 'offline');
      await pick(u, { statusId: ghost._id });
      expect(await pres()).toMatchObject({ status: 'offline', statusCustom: null });
      const seen = await api('GET', 'users.presence', { ids: u.userId }, other);
      expect(seen.users[0]).toMatchObject({ status: 'offline', statusCustom: null });
      expect((await api('GET', 'users.info', { userId: u.userId }, other)).user.statusCustom).toBeNull();
      expect((await api('GET', 'users.getStatus', { userId: u.userId }, other)).statusCustom).toBeNull();
      const members = await api('GET', 'channels.members', { roomName: 'geral' }, other);
      expect(members.members.find((m: any) => m._id === u.userId)?.statusCustom ?? null).toBeNull();
      const dir = await api('GET', 'directory', { type: 'users', text: u.username }, other);
      expect(dir.result[0].statusCustom).toBeNull();
      // A própria pessoa vê o que escolheu.
      expect((await api('GET', 'me', undefined, u)).statusCustom).toBe(ghost._id);
      expect((await api('GET', 'users.getStatus', {}, u)).statusCustom).toBe(ghost._id);
      // Reconectar não revela: nada de presença nova, e a que houver continua offline e sem o personalizado.
      const since = wo.events.length;
      wu.close();
      await sleep(200);
      const again = await online(u);
      await sleep(200);
      expect(wo.events.slice(since).filter((e) => e.type === 'presence' && e.userId === u.userId).every((e) => e.status === 'offline' && e.statusCustom === null)).toBe(true);
      again.close();
    } finally {
      wu.close();
      wo.close();
      await remove(A, ghost._id);
    }
  });
});

describe('status personalizados: editar e excluir', () => {
  it('mudar o tipo atualiza quem está com ele, e o tipo ocupado silencia', async () => {
    const st = (await create(A, `Pausa café ${Date.now()}`, 'away')).customUserStatus;
    const u = await newUser(A);
    const sender = await newUser(A);
    const wu = await online(u);
    try {
      await pick(u, { statusId: st._id });
      expect(await dbUser(u.userId)).toMatchObject({ status: 'away', status_default: 'away' });
      const pres = next(wu, (e) => e.type === 'presence' && e.userId === u.userId && e.status === 'busy');
      const self = next(wu, (e) => e.type === 'user' && e.user._id === u.userId && e.user.statusDefault === 'busy');
      const changed = next(wu, (e) => e.type === 'userStatus.changed');
      expect((await update(A, st._id, st.name, 'busy')).customUserStatus).toMatchObject({ _id: st._id, statusType: 'busy' });
      expect((await pres()).statusCustom).toBe(st._id);
      expect((await self()).user).toEqual({ _id: u.userId, statusDefault: 'busy', statusCustom: st._id });
      expect((await changed()).statuses.find((s: any) => s._id === st._id)).toEqual({ _id: st._id, name: st.name, statusType: 'busy' });
      expect(await dbUser(u.userId)).toEqual({ status: 'busy', status_default: 'busy', status_custom: st._id });
      expect((await list(A)).statuses.find((s: any) => s._id === st._id).usersCount).toBe(1);

      // Agora ocupado: a DM não gera notificação.
      const dm = (await api('POST', 'im.create', { username: u.username }, sender)).room._id;
      const counted = next(wu, (e) => e.type === 'subscription' && e.subscription.rid === dm && e.subscription.unread >= 1);
      await api('POST', 'chat.sendMessage', { message: { rid: dm, msg: 'oi, tudo bem?' } }, sender);
      await counted();
      await sleep(400);
      expect(wu.events.some((e) => e.type === 'notification' && e.rid === dm)).toBe(false);
    } finally {
      wu.close();
      await remove(A, st._id);
    }
  });

  it('excluir deixa quem estava com ele no tipo base e avisa todos', async () => {
    const st = (await create(A, `Externo ${Date.now()}`, 'away')).customUserStatus;
    const u = await newUser(A);
    const other = await newUser(A);
    const [wu, wo] = await Promise.all([online(u), online(other)]);
    try {
      await pick(u, { statusId: st._id });
      const pres = next(wo, (e) => e.type === 'presence' && e.userId === u.userId && e.statusCustom === null);
      const self = next(wu, (e) => e.type === 'user' && e.user._id === u.userId && e.user.statusCustom === null);
      const changed = next(wo, (e) => e.type === 'userStatus.changed');
      expect((await remove(A, st._id)).success).toBe(true);
      expect(await pres()).toMatchObject({ status: 'away' });
      expect((await self()).user).toEqual({ _id: u.userId, statusDefault: 'away', statusCustom: null });
      const ev = await changed();
      expect(ev.statuses.some((s: any) => s._id === st._id)).toBe(false);
      expect(ev.statuses.every((s: any) => !('usersCount' in s))).toBe(true);
      expect(await dbUser(u.userId)).toEqual({ status: 'away', status_default: 'away', status_custom: null });
    } finally {
      wu.close();
      wo.close();
    }
  });

  it('auditoria registra criar, editar (antes e depois) e excluir', async () => {
    const name = `Auditado ${Date.now()}`;
    const st = (await create(A, name, 'online')).customUserStatus;
    await update(A, st._id, `${name} 2`, 'busy');
    await remove(A, st._id);
    const log = await api('GET', 'audit.log', { action: 'user-status.*', count: 50 }, A);
    const mine = log.events.filter((e: any) => e.target.id === st._id);
    expect(mine.map((e: any) => e.action).sort()).toEqual(['user-status.created', 'user-status.deleted', 'user-status.updated']);
    const upd = mine.find((e: any) => e.action === 'user-status.updated');
    expect(upd.data).toMatchObject({ before: { name, statusType: 'online' }, after: { name: `${name} 2`, statusType: 'busy' }, users: 0 });
    expect(mine.find((e: any) => e.action === 'user-status.created').data).toEqual({ statusType: 'online' });
    expect(mine.find((e: any) => e.action === 'user-status.deleted').data).toEqual({ statusType: 'busy', users: 0 });
  });
});
