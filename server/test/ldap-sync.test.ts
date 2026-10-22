import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { Entry } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LdapGroupRef, LdapMappingTest } from '@shared/ldap';
import { pool } from '../src/db/pool';
import { loadLdapConfig } from '../src/ldap/config';
import { ldapLogin, ldapSync, upsertFromEntry } from '../src/ldap/ldap';
import { failDeadRuns, RunLog } from '../src/ldap/runs';
import { runSync, syncEntry, type LdapSource } from '../src/ldap/sync';
import { bus } from '../src/realtime/bus';
import { loadSettings } from '../src/services/settings';
import { createSession } from '../src/services/users';
import { admin, api, connectWs, login, newUser, raw, sleep, startServer, stopServer, type Auth } from './helpers';

// Sincronização com uma fonte falsa (sem AD): banco de dados e API de verdade.

const BASE = 'OU=Explorer,DC=explorer,DC=test';
const OU_SAC = `OU=SAC,OU=Operacao,${BASE}`;
const OU_OP = `OU=Operacao,${BASE}`;
const groupRef = (cn: string): LdapGroupRef => ({ dn: `CN=${cn},OU=Grupos,${BASE}`, cn, sAMAccountName: cn });

interface Person {
  sam: string;
  ou?: string;
  groups?: string[];
  uac?: number;
  photo?: Buffer | null;
  failGroups?: boolean;
  guid: Buffer;
}

const person = (sam: string, extra: Partial<Person> = {}): Person => ({ sam, guid: randomBytes(16), ou: OU_SAC, groups: [], ...extra });

function entryOf(p: Person): Entry {
  const e: Entry = {
    dn: `CN=${p.sam},${p.ou ?? OU_SAC}`,
    objectClass: ['top', 'person', 'organizationalPerson', 'user'],
    sAMAccountName: p.sam,
    cn: p.sam,
    mail: `${p.sam}@explorer.test`,
    objectGUID: p.guid,
    userAccountControl: String(p.uac ?? 512),
  };
  if (p.photo) e.thumbnailPhoto = p.photo;
  return e;
}

const GROUP_ENTRY: Entry = { dn: `CN=GG-Operacao,OU=Grupos,${BASE}`, objectClass: ['top', 'group'], cn: 'GG-Operacao', sAMAccountName: 'GG-Operacao' };

function fakeSource(people: Person[], opts: { extra?: Entry[]; gate?: Promise<void> } = {}): LdapSource {
  return {
    async *users() {
      if (opts.gate) await opts.gate;
      yield [...people.map(entryOf), ...(opts.extra ?? [])];
    },
    async groupsOf(entry) {
      const p = people.find((x) => entryOf(x).dn === entry.dn);
      if (p?.failGroups) throw new Error('tempo esgotado na busca de grupos');
      return (p?.groups ?? []).map(groupRef);
    },
    async close() {},
  };
}

const sync = (people: Person[], opts: { extra?: Entry[] } = {}) => runSync({ trigger: 'manual', startedBy: A.userId, source: fakeSource(people, opts) });

// A prévia (ldap.testMapping) sem o diretório: o mesmo syncEntry, sem gravar nada.
async function preview(p: Person): Promise<LdapMappingTest> {
  const src = fakeSource([p]);
  const r = await syncEntry({ cfg: loadLdapConfig(), trigger: 'manual', dryRun: true, log: new RunLog(), actor: { username: 'system' }, groupsOf: (e) => src.groupsOf(e) }, entryOf(p));
  return r.preview;
}

async function waitRunning() {
  for (let i = 0; i < 50 && !(await pool.query(`SELECT 1 FROM ldap_sync_runs WHERE status = 'running'`)).rowCount; i++) await sleep(20);
}

const jpeg = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, seed)]);

let A: Auth;

async function userRow(username: string) {
  return (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
}

async function roomIdsOf(username: string) {
  const r = await pool.query('SELECT r.name FROM subscriptions s JOIN rooms r ON r.id = s.room_id JOIN users u ON u.id = s.user_id WHERE u.username = $1', [username]);
  return r.rows.map((x) => x.name as string).sort();
}

async function teamsOf(username: string) {
  const r = await pool.query('SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = m.user_id WHERE u.username = $1', [username]);
  return r.rows.map((x) => x.name as string).sort();
}

const settings = (values: Record<string, unknown>) => api('POST', 'settings', { settings: values }, A);

// Sessão de uma conta do LDAP (que não tem senha local).
async function sessionOf(username: string): Promise<Auth> {
  const u = await userRow(username);
  const s = await createSession(u.id, { userAgent: 'teste' });
  return { userId: u.id, authToken: s.authToken, username };
}

const MAPPING = {
  LDAP_Enable: true,
  LDAP_Url: 'ldap://127.0.0.1:9',
  LDAP_Enable_Role_Mapping: true,
  LDAP_Role_Mapping: JSON.stringify({ 'GG-Operacao': ['operacao'], 'GG-Sup': ['supervisor'] }),
  LDAP_Enable_Channel_Mapping: true,
  LDAP_Channel_Mapping: JSON.stringify({ '*': ['avisos-geral'], 'GG-Operacao': ['canal-op'], [`ou:${OU_SAC}`]: ['sac'] }),
  LDAP_Enable_Team_Mapping: true,
  LDAP_Team_Mapping: JSON.stringify({ 'group:GG-Operacao': ['time-op'] }),
  LDAP_Channels_Admin: 'admin',
  LDAP_Sync_User_Active_State: false,
};

beforeAll(async () => {
  await startServer();
  A = await admin();
  await settings({ API_Enable_Rate_Limiter: false });
  expect((await api('POST', 'roles.create', { name: 'supervisor', scope: 'Users', description: 'Supervisor' }, A)).success).toBe(true);
  expect((await api('POST', 'channels.create', { name: 'avisos-geral' }, A)).success).toBe(true);
  expect((await api('POST', 'teams.create', { name: 'time-op', type: 0 }, A)).success).toBe(true);
});
afterAll(() => stopServer());

describe('compatibilidade', () => {
  it('upsertFromEntry continua compatível, com grupos como texto', async () => {
    const entry = (user: string, guid: string) => ({ dn: `cn=${user},dc=empresa`, sAMAccountName: user, cn: user, objectGUID: guid }) as any;
    await expect(upsertFromEntry(entry('admin', 'g-admin'), ['GG-Qualquer'])).rejects.toMatchObject({ errorType: 'error-ldap-username-taken' });
    expect((await userRow('admin')).auth_source).toBe('local');

    const local = await newUser(A);
    await settings({ LDAP_Merge_Existing_Users: true, LDAP_Enable_Role_Mapping: true, LDAP_Role_Mapping: '{"GG-Sup": "supervisor"}' });
    try {
      const merged = await upsertFromEntry(entry(local.username, 'g-1'), ['GG-Sup']);
      expect(merged).toMatchObject({ id: local.userId, auth_source: 'ldap', external_id: 'g-1' });
      expect(merged.roles.sort()).toEqual(['supervisor', 'user']);
      await expect(upsertFromEntry(entry(local.username, 'g-2'), [])).rejects.toMatchObject({ errorType: 'error-ldap-username-taken' });
    } finally {
      await settings({ LDAP_Merge_Existing_Users: false, LDAP_Enable_Role_Mapping: false, LDAP_Role_Mapping: '{}' });
    }
  });

  it('ldapSync com o LDAP desligado devolve zeros e não registra execução', async () => {
    const r = await ldapSync();
    expect(r).toMatchObject({ imported: 0, updated: 0, deactivated: 0, runId: null, status: 'success' });
    expect((await pool.query('SELECT count(*)::int AS n FROM ldap_sync_runs')).rows[0].n).toBe(0);
  });

  it('ldap.syncNow (botão das configurações) diz quando falha, registra quem pediu e audita uma vez só', async () => {
    expect(await api('POST', 'ldap.syncNow', {}, A)).toMatchObject({ status: 400, errorType: 'error-ldap-disabled', error: 'Ative o LDAP antes de sincronizar.' });
    await settings({ LDAP_Enable: true, LDAP_Url: 'ldap://127.0.0.1:9' });
    try {
      const r = await api('POST', 'ldap.syncNow', {}, A);
      expect(r).toMatchObject({ status: 400, errorType: 'error-ldap-sync-failed' });
      expect(r.error).toMatch(/^A sincronização falhou: Falha ao ler o diretório: /);
      const run = (await pool.query('SELECT * FROM ldap_sync_runs ORDER BY started_at DESC LIMIT 1')).rows[0];
      expect(run).toMatchObject({ trigger: 'api', status: 'failed', started_by: A.userId });
      const audits = await pool.query(`SELECT action, actor_username FROM audit_log WHERE action LIKE 'ldap.sync%'`);
      expect(audits.rows).toEqual([{ action: 'ldap.sync', actor_username: 'admin' }]);
    } finally {
      await settings({ LDAP_Enable: false });
    }
  });
});

describe('sincronização com fonte falsa', () => {
  const ana = person('ana.f', { groups: ['GG-Operacao'] });
  const bia = person('bia.f', { groups: ['GG-Operacao'] });
  const sup = person('sup.f', { ou: OU_OP, groups: ['GG-Sup'] });

  beforeAll(async () => {
    await settings(MAPPING);
  });

  it('importa com papéis, canais (criados privados, com dono) e time; grupo é ignorado', async () => {
    const run = await sync([ana, bia, sup], { extra: [GROUP_ENTRY] });
    expect(run.status).toBe('success');
    expect(run.counts).toMatchObject({ seen: 4, imported: 3, skipped: 1, errors: 0, updated: 0 });
    expect((await userRow('ana.f')).roles).toEqual(['operacao']);
    expect((await userRow('sup.f')).roles.sort()).toEqual(['supervisor', 'user']);
    expect(await userRow('GG-Operacao')).toBeUndefined();
    expect(await roomIdsOf('ana.f')).toEqual(['avisos-geral', 'canal-op', 'geral', 'sac', 'time-op']);
    expect(await roomIdsOf('sup.f')).toEqual(['avisos-geral', 'geral']);
    expect(await teamsOf('bia.f')).toEqual(['time-op']);
    const created = (await pool.query(`SELECT r.name, r.t, u.username AS owner, s.roles FROM rooms r JOIN users u ON u.id = r.owner_id
      JOIN subscriptions s ON s.room_id = r.id AND s.user_id = r.owner_id WHERE r.name IN ('canal-op', 'sac') ORDER BY r.name`)).rows;
    expect(created).toEqual([
      { name: 'canal-op', t: 'p', owner: 'admin', roles: ['owner'] },
      { name: 'sac', t: 'p', owner: 'admin', roles: ['owner'] },
    ]);
    const detail = await api('GET', 'ldap.sync.run', { runId: run._id }, A);
    expect(detail.run.changes).toEqual(
      expect.arrayContaining([
        { username: 'ana.f', kind: 'created', detail: 'Conta criada com o papel operacao' },
        { username: 'ana.f', kind: 'channels', detail: '+#avisos-geral +#canal-op (criado) +#sac (criado)' },
        { username: 'ana.f', kind: 'teams', detail: '+time-op' },
      ]),
    );
    // A segunda execução não muda nada.
    const again = await sync([ana, bia, sup]);
    expect(again.counts).toMatchObject({ imported: 0, updated: 3, changed: 0, errors: 0 });
  });

  it('saiu do grupo: sem remoção automática nada sai; com ela perde papel, canal e time, e o moderador fica no canal', async () => {
    const canalOp = (await pool.query(`SELECT id FROM rooms WHERE name = 'canal-op'`)).rows[0].id;
    expect((await api('POST', 'groups.addModerator', { roomId: canalOp, userId: (await userRow('bia.f')).id }, A)).success).toBe(true);
    ana.groups = [];
    bia.groups = [];
    await settings({ LDAP_Roles_Auto_Remove: false });
    try {
      const off = await sync([ana, bia, sup]);
      expect(off.counts.errors).toBe(0);
      expect((await userRow('ana.f')).roles.sort()).toEqual(['operacao', 'user']);
      expect(await roomIdsOf('ana.f')).toContain('canal-op');
      expect(await teamsOf('ana.f')).toEqual(['time-op']);
    } finally {
      await settings({ LDAP_Roles_Auto_Remove: true });
    }
    await settings({ LDAP_Channels_Auto_Remove: true, LDAP_Teams_Auto_Remove: true });
    const on = await sync([ana, bia, sup]);
    expect(on.counts).toMatchObject({ errors: 0, channelsRemoved: 1, teamsRemoved: 2 });
    expect((await userRow('ana.f')).roles).toEqual(['user']);
    expect(await roomIdsOf('ana.f')).toEqual(['avisos-geral', 'geral', 'sac']);
    expect(await teamsOf('ana.f')).toEqual([]);
    // bia é moderadora de canal-op: a sincronização não a tira de lá.
    expect(await roomIdsOf('bia.f')).toEqual(['avisos-geral', 'canal-op', 'geral', 'sac']);
    expect(await teamsOf('bia.f')).toEqual([]);
    const detail = await api('GET', 'ldap.sync.run', { runId: on._id }, A);
    expect(detail.run.changes).toContainEqual({ username: 'ana.f', kind: 'roles', detail: '−operacao' });
    expect(detail.run.changes).toContainEqual({ username: 'ana.f', kind: 'channels', detail: '−#canal-op' });
  });

  it('falha ao buscar grupos não mexe em nada', async () => {
    const cora = person('cora.f', { groups: ['GG-Operacao'] });
    await sync([ana, bia, sup, cora]);
    const before = { roles: (await userRow('cora.f')).roles, rooms: await roomIdsOf('cora.f'), teams: await teamsOf('cora.f') };
    expect(before.roles).toEqual(['operacao']);
    cora.groups = [];
    cora.failGroups = true;
    const run = await sync([ana, bia, sup, cora]);
    expect(run.status).toBe('partial');
    expect(run.counts.errors).toBe(1);
    expect(run.errors).toEqual([{ login: 'cora.f', dn: `CN=cora.f,${OU_SAC}`, message: 'Falha ao buscar grupos: tempo esgotado na busca de grupos' }]);
    expect({ roles: (await userRow('cora.f')).roles, rooms: await roomIdsOf('cora.f'), teams: await teamsOf('cora.f') }).toEqual(before);
  });

  it('falha nos grupos com conta nova: a prévia diz o mesmo que a sincronização (não cria)', async () => {
    const novo = person('novo.f', { groups: ['GG-Operacao'], failGroups: true });
    const p = await preview(novo);
    expect(p.groupError).toBe('Falha ao buscar grupos: tempo esgotado na busca de grupos');
    expect(p.account).toEqual({
      exists: false,
      action: 'skip',
      activeAfter: false,
      note: 'Sem os grupos não dá para saber os papéis: a conta não será criada agora (a próxima sincronização tenta de novo).',
    });
    expect(p.roles).toEqual({ before: [], after: [], added: [], removed: [] });
    const run = await sync([novo]);
    expect(run.counts).toMatchObject({ imported: 0, errors: 1 });
    expect(await userRow('novo.f')).toBeUndefined();
  });

  it('nome de regra que serve para dois grupos (mesmo cn em outra OU) não dá o papel a ninguém novo: quem está neles fica como está', async () => {
    const real = groupRef('GG-Chefia');
    // Criado por quem administra outra OU: mesmo cn, outro sAMAccountName (que no AD é único).
    const rogue: LdapGroupRef = { dn: `CN=GG-Chefia,OU=Helpdesk,${BASE}`, cn: 'GG-Chefia', sAMAccountName: 'GG-Helpdesk-Temp' };
    const chefe = person('chefe.amb', { ou: OU_OP });
    const eva = person('eva.amb');
    const nova = person('nova.amb');
    const directory: LdapGroupRef[] = [real, groupRef('GG-Operacao'), groupRef('GG-Sup')];
    const groupsBy = new Map<string, LdapGroupRef[]>([[entryOf(chefe).dn, [real]]]);
    const source = (people: Person[], named = true): LdapSource => ({
      async *users() {
        yield people.map(entryOf);
      },
      async groupsOf(entry) {
        return groupsBy.get(entry.dn) ?? [];
      },
      ...(named && {
        async groupsNamed(names: string[]) {
          const wanted = names.map((n) => n.toLowerCase());
          return directory.filter((g) => wanted.includes(g.cn.toLowerCase()) || wanted.includes(String(g.sAMAccountName).toLowerCase()));
        },
      }),
      async close() {},
    });
    const roleMap = { 'GG-Operacao': ['operacao'], 'GG-Sup': ['supervisor'] };
    await settings({ LDAP_Role_Mapping: JSON.stringify({ ...roleMap, 'GG-Chefia': ['admin'] }) });
    try {
      expect((await runSync({ trigger: 'manual', startedBy: A.userId, source: source([chefe, eva]) })).status).toBe('success');
      expect((await userRow('chefe.amb')).roles.sort()).toEqual(['admin', 'user']);
      expect((await userRow('eva.amb')).roles).toEqual(['user']);
      const evaRooms = await roomIdsOf('eva.amb');

      directory.push(rogue);
      groupsBy.set(entryOf(eva).dn, [rogue]);
      groupsBy.set(entryOf(nova).dn, [rogue]);
      const scope = (named: boolean, cfg = loadLdapConfig()) => {
        const src = source([eva], named);
        return { cfg, trigger: 'manual' as const, dryRun: true, log: new RunLog(), actor: { username: 'system' }, groupsOf: src.groupsOf, groupsNamed: src.groupsNamed };
      };
      // Sem a conferência dos nomes, eva viraria administradora.
      expect((await syncEntry(scope(false), entryOf(eva))).preview.roles.after).toContain('admin');
      const message = `A regra "GG-Chefia" serve para mais de um grupo do diretório (${real.dn}; ${rogue.dn}): use "group:<DN do grupo>" para dizer qual. Enquanto isso, a sincronização não mexe nos papéis, canais e times de quem está nesses grupos.`;
      const p = (await syncEntry(scope(true), entryOf(eva))).preview;
      expect(p.groupError).toBe(message);
      expect(p.groups).toEqual([rogue]);
      expect(p.roles).toEqual({ before: ['user'], after: ['user'], added: [], removed: [] });
      // Só contam as regras dos mapas ligados.
      expect((await syncEntry(scope(true, { ...loadLdapConfig(), roleMapping: false }), entryOf(eva))).preview.groupError).toBeUndefined();
      const novaPreview = (await syncEntry(scope(true), entryOf(nova))).preview;
      expect(novaPreview.account).toEqual({
        exists: false,
        action: 'skip',
        activeAfter: false,
        note: 'Com uma regra ambígua não dá para saber os papéis: a conta não será criada até a regra ser corrigida.',
      });

      const run = await runSync({ trigger: 'manual', startedBy: A.userId, source: source([chefe, eva, nova]) });
      expect(run.status).toBe('partial');
      expect(run.counts).toMatchObject({ imported: 0, rolesChanged: 0, errors: 3 });
      expect(run.errors).toEqual([chefe, eva, nova].map((x) => ({ login: x.sam, dn: entryOf(x).dn, message })));
      expect((await userRow('chefe.amb')).roles.sort()).toEqual(['admin', 'user']);
      expect((await userRow('eva.amb')).roles).toEqual(['user']);
      expect(await roomIdsOf('eva.amb')).toEqual(evaRooms);
      expect(await userRow('nova.amb')).toBeUndefined();

      // Com a regra pelo DN não há dúvida: só o grupo de verdade dá o papel.
      await settings({ LDAP_Role_Mapping: JSON.stringify({ ...roleMap, [`group:${real.dn}`]: ['admin'] }) });
      const byDn = await runSync({ trigger: 'manual', startedBy: A.userId, source: source([chefe, eva, nova]) });
      expect(byDn.status).toBe('success');
      expect((await userRow('chefe.amb')).roles.sort()).toEqual(['admin', 'user']);
      expect((await userRow('eva.amb')).roles).toEqual(['user']);
      expect((await userRow('nova.amb')).roles).toEqual(['user']);
    } finally {
      await settings({ LDAP_Role_Mapping: MAPPING.LDAP_Role_Mapping });
    }
  });

  it('conta nova com o e-mail de outra conta: o erro da execução diz qual e-mail', async () => {
    expect((await api('POST', 'users.create', { username: 'lia.local', name: 'Lia', email: 'dup.f@explorer.test', password: 'senha-forte-1' }, A)).success).toBe(true);
    const dup = person('dup.f');
    expect((await preview(dup)).account).toEqual({ exists: false, action: 'skip', activeAfter: false, note: 'O e-mail dup.f@explorer.test já é usado por outra conta; a conta não será criada.' });
    const run = await sync([dup]);
    expect(run.status).toBe('partial');
    expect(run.counts).toMatchObject({ imported: 0, errors: 1 });
    expect(run.errors).toEqual([{ login: 'dup.f', dn: `CN=dup.f,${OU_SAC}`, message: 'O e-mail dup.f@explorer.test já é usado por outra conta; a conta não foi criada.' }]);
    expect(await userRow('dup.f')).toBeUndefined();
  });

  it('com o vínculo ligado, um nome que só fica igual depois de limpo não assume a conta local', async () => {
    const local = await api('POST', 'users.create', { username: 'caio.souza', name: 'Caio (local)', email: 'caio.local@test.local', password: 'senha-forte-1', roles: ['user', 'admin'] }, A);
    expect(local.success).toBe(true);
    await settings({ LDAP_Merge_Existing_Users: true });
    try {
      const outro = person('caio souza');
      expect((await preview(outro)).account).toMatchObject({ action: 'conflict', userId: local.user._id });
      const run = await sync([outro]);
      expect(run.errors).toEqual([
        { login: 'caio souza', dn: `CN=caio souza,${OU_SAC}`, message: 'Já existe um usuário "caio.souza" e o nome no diretório é "caio souza": a conta local não é vinculada a um nome diferente.' },
      ]);
      expect(await userRow('caio.souza')).toMatchObject({ auth_source: 'local', external_id: null });
      // O mesmo nome (sem diferença de caixa) continua sendo vinculado.
      const caio = person('Caio.Souza');
      expect((await sync([caio])).counts).toMatchObject({ imported: 1, errors: 0 });
      expect(await userRow('caio.souza')).toMatchObject({ auth_source: 'ldap', external_id: caio.guid.toString('hex') });
    } finally {
      await settings({ LDAP_Merge_Existing_Users: false });
    }
  });

  it('DN de uma conta antiga reaproveitado por outra pessoa não assume a conta; a mesma pessoa é migrada', async () => {
    // Contas gravadas pela versão antiga sem identificador único: external_id é o DN.
    const oldEntry = (sam: string, extra: Partial<Entry> = {}): Entry => ({ dn: `CN=Ana Lima,${OU_SAC}`, objectClass: ['top', 'person', 'user'], sAMAccountName: sam, cn: 'Ana Lima', mail: `${sam}@explorer.test`, ...extra });
    await sync([], { extra: [oldEntry('ana.lima')] });
    expect(await userRow('ana.lima')).toMatchObject({ external_id: `CN=Ana Lima,${OU_SAC}` });

    const guid = randomBytes(16);
    const run = await sync([], { extra: [oldEntry('ana.lima2', { objectGUID: guid })] });
    expect(run.counts).toMatchObject({ imported: 1, errors: 0 });
    expect(await userRow('ana.lima')).toMatchObject({ external_id: `CN=Ana Lima,${OU_SAC}`, email: 'ana.lima@explorer.test' });
    expect(await userRow('ana.lima2')).toMatchObject({ external_id: guid.toString('hex') });
    // O DN de outra pessoa também não mantém a conta antiga como "ainda no diretório".
    await settings({ LDAP_Sync_User_Active_State: true, LDAP_Sync_Max_Deactivation_Percent: 0 });
    try {
      await sync([], { extra: [oldEntry('ana.lima2', { objectGUID: guid })] });
    } finally {
      await settings({ LDAP_Sync_User_Active_State: false, LDAP_Sync_Max_Deactivation_Percent: 50 });
    }
    expect(await userRow('ana.lima')).toMatchObject({ active: false, ldap_deactivated_reason: 'removed' });
    expect((await userRow('ana.lima2')).active).toBe(true);

    const leo = (extra: Partial<Entry> = {}): Entry => ({ dn: `CN=Leo,${OU_SAC}`, objectClass: ['top', 'person', 'user'], sAMAccountName: 'leo.m', cn: 'Leo', ...extra });
    await sync([], { extra: [leo()] });
    const id = (await userRow('leo.m')).id;
    const leoGuid = randomBytes(16);
    expect((await sync([], { extra: [leo({ objectGUID: leoGuid })] })).counts).toMatchObject({ imported: 0, updated: 1, errors: 0 });
    expect(await userRow('leo.m')).toMatchObject({ id, external_id: leoGuid.toString('hex') });
  });

  it('conta antiga (DN como identificador) renomeada pelo administrador continua sendo a mesma pessoa', async () => {
    const dn = `CN=Leo Vaz,${OU_SAC}`;
    const old: Entry = { dn, objectClass: ['top', 'person', 'user'], sAMAccountName: 'leo.vaz', cn: 'Leo Vaz', mail: 'leo.vaz@explorer.test', userAccountControl: '512' };
    await sync([], { extra: [old] });
    const id = (await userRow('leo.vaz')).id;
    expect((await api('POST', 'users.update', { userId: id, data: { username: 'leo.vaz.sac' } }, A)).success).toBe(true);
    await settings({ LDAP_Sync_User_Active_State: true, LDAP_Sync_Max_Deactivation_Percent: 0 });
    try {
      // O mesmo DN e o mesmo e-mail: a conta é migrada para o GUID e não é dada como removida.
      const guid = randomBytes(16);
      const run = await sync([], { extra: [{ ...old, objectGUID: guid }] });
      expect(run.errors).toEqual([]);
      expect(run.counts).toMatchObject({ imported: 0, updated: 1, errors: 0 });
      expect(run.changes?.filter((c) => c.username === 'leo.vaz.sac' && c.kind === 'deactivated')).toEqual([]);
      expect(await userRow('leo.vaz.sac')).toMatchObject({ id, active: true, external_id: guid.toString('hex'), ldap_deactivated_reason: null });
      expect(await userRow('leo.vaz')).toBeUndefined();
    } finally {
      await settings({ LDAP_Sync_User_Active_State: false, LDAP_Sync_Max_Deactivation_Percent: 50 });
    }
  });
});

describe('estado da conta', () => {
  it('desativada no AD, reativada, e desativação manual', async () => {
    const dani = person('dani.f');
    await sync([dani]);
    const s = await sessionOf('dani.f');
    expect((await api('GET', 'subscriptions.get', undefined, s)).status).toBe(200);

    dani.uac = 514;
    const off = await sync([dani]);
    expect(off.counts.deactivated).toBe(1);
    expect(await userRow('dani.f')).toMatchObject({ active: false, ldap_deactivated_reason: 'disabled' });
    expect((await api('GET', 'subscriptions.get', undefined, s)).status).toBe(401);

    dani.uac = 512;
    const on = await sync([dani]);
    expect(on.counts.reactivated).toBe(1);
    expect(await userRow('dani.f')).toMatchObject({ active: true, ldap_deactivated_at: null, ldap_deactivated_reason: null });

    expect((await api('POST', 'users.update', { userId: (await userRow('dani.f')).id, data: { active: false } }, A)).success).toBe(true);
    const manual = await sync([dani]);
    expect(manual.counts.reactivated).toBe(0);
    expect((await userRow('dani.f')).active).toBe(false);
  });

  it('reativada e desativada à mão antes da próxima sincronização: nem o login nem a sincronização reativam', async () => {
    const gil = person('gil.f');
    await sync([gil]);
    gil.uac = 514;
    await sync([gil]);
    const id = (await userRow('gil.f')).id;
    expect(await userRow('gil.f')).toMatchObject({ active: false, ldap_deactivated_reason: 'disabled' });
    expect((await api('POST', 'users.setActiveStatus', { userId: id, activeStatus: true }, A)).success).toBe(true);
    expect(await userRow('gil.f')).toMatchObject({ active: true, ldap_deactivated_at: null });
    expect((await api('POST', 'users.setActiveStatus', { userId: id, activeStatus: false }, A)).success).toBe(true);

    gil.uac = 512;
    expect((await preview(gil)).account).toMatchObject({ exists: true, active: false, activeAfter: false });
    // Login pelo AD (mesmo caminho de upsertFromEntry).
    expect(await upsertFromEntry(entryOf(gil))).toMatchObject({ id, active: false });
    const run = await sync([gil]);
    expect(run.counts.reactivated).toBe(0);
    expect(await userRow('gil.f')).toMatchObject({ active: false, ldap_deactivated_at: null, ldap_deactivated_reason: null });

    // O mesmo pela tela de usuários (que manda todos os campos) e com a resposta da reativação ainda sem efeito:
    // a marca que ficou numa conta ativa sai antes da desativação.
    const hugo = person('hugo.f', { uac: 514 });
    await sync([{ ...hugo, uac: 512 }]);
    await sync([hugo]);
    const h = await userRow('hugo.f');
    const form = (active: boolean) => ({ name: h.name, username: h.username, email: h.email, roles: h.roles, active, verified: true, requirePasswordChange: false, bio: '' });
    expect((await api('POST', 'users.update', { userId: h.id, data: form(true) }, A)).success).toBe(true);
    await pool.query(`UPDATE users SET ldap_deactivated_at = now(), ldap_deactivated_reason = 'disabled' WHERE id = $1`, [h.id]);
    expect((await api('POST', 'users.update', { userId: h.id, data: form(false) }, A)).success).toBe(true);
    hugo.uac = 512;
    expect((await sync([hugo])).counts.reactivated).toBe(0);
    expect(await userRow('hugo.f')).toMatchObject({ active: false, ldap_deactivated_at: null });
  });

  it('salvar o perfil pela tela de usuários sem mexer em "Ativo" não impede a reativação pelo AD', async () => {
    const rui = person('rui.f');
    await sync([rui]);
    rui.uac = 514;
    await sync([rui]);
    const u = await userRow('rui.f');
    expect(u).toMatchObject({ active: false, ldap_deactivated_reason: 'disabled' });
    // O formulário de AdminUsers.tsx manda sempre "Ativo", mesmo sem mudança; setActiveStatus com o mesmo valor também.
    const data = { name: 'Rui (nome corrigido)', username: u.username, email: u.email, roles: u.roles, active: false, verified: true, requirePasswordChange: false, bio: '' };
    expect((await api('POST', 'users.update', { userId: u.id, data }, A)).success).toBe(true);
    expect((await api('POST', 'users.setActiveStatus', { userId: u.id, activeStatus: false }, A)).success).toBe(true);
    expect(await userRow('rui.f')).toMatchObject({ active: false, ldap_deactivated_reason: 'disabled' });

    rui.uac = 512;
    expect((await preview(rui)).account).toMatchObject({ exists: true, active: false, activeAfter: true, note: 'A conta será reativada.' });
    const run = await sync([rui]);
    expect(run.counts.reactivated).toBe(1);
    expect(await userRow('rui.f')).toMatchObject({ active: true, ldap_deactivated_at: null, ldap_deactivated_reason: null });
  });

  it('removido do diretório e limite de segurança', async () => {
    // Recomeça só com as contas deste teste.
    await pool.query(`UPDATE users SET auth_source = 'local' WHERE auth_source = 'ldap'`);
    await settings({ LDAP_Sync_User_Active_State: true });
    try {
      const people = Array.from({ length: 11 }, (_, i) => person(`rem.${i + 1}`));
      expect((await sync(people)).counts.imported).toBe(11);

      const gone = await sync(people.slice(0, 10));
      expect(gone.counts.deactivated).toBe(1);
      expect(await userRow('rem.11')).toMatchObject({ active: false, ldap_deactivated_reason: 'removed' });

      const empty = await sync([]);
      expect(empty.status).toBe('partial');
      expect(empty.counts.deactivated).toBe(0);
      expect(empty.warnings).toContain('Desativação interrompida: 10 de 10 usuários do LDAP sumiram da busca (limite 50%). Confira o Base DN e o filtro de usuários.');

      const many = await sync(people.slice(0, 4));
      expect(many.status).toBe('partial');
      expect(many.counts.deactivated).toBe(0);
      expect(many.warnings?.join(' ')).toContain('6 de 10 usuários');

      await settings({ LDAP_Sync_Max_Deactivation_Percent: 0 });
      const nolimit = await sync(people.slice(0, 4));
      expect(nolimit.status).toBe('success');
      expect(nolimit.counts.deactivated).toBe(6);
      expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE username LIKE 'rem.%' AND active`)).rows[0].n).toBe(4);
    } finally {
      await settings({ LDAP_Sync_User_Active_State: false, LDAP_Sync_Max_Deactivation_Percent: 50 });
    }
  });
});

describe('foto', () => {
  it('foto que não é JPEG nem PNG: um aviso só, com o nome da pessoa, na prévia e na execução', async () => {
    const gif = person('gif.f', { photo: Buffer.from('GIF89a-imagem-de-teste') });
    const text = 'Foto de @gif.f ignorada: o diretório não mandou um JPEG nem um PNG.';
    const p = await preview(gif);
    expect(p.warnings).toContain(text);
    expect(p.warnings.filter((w) => w.startsWith('Foto de'))).toEqual([text]);
    const run = await sync([gif]);
    expect(run.counts.imported).toBe(1);
    expect(run.warnings?.filter((w) => w.startsWith('Foto de'))).toEqual([text]);
  });

  it('aplica a foto do AD, não regrava a mesma, respeita a foto da pessoa e remove a do LDAP quando some', async () => {
    const f1 = person('foto.1', { photo: jpeg(1) });
    const f2 = person('foto.2', { photo: jpeg(2) });
    const first = await sync([f1, f2]);
    expect(first.counts.avatars).toBe(2);
    const img = await raw('/avatar/foto.1', A);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await img.arrayBuffer()).equals(jpeg(1))).toBe(true);
    const etag = (await userRow('foto.1')).avatar_etag;

    const same = await sync([f1, f2]);
    expect(same.counts.avatars).toBe(0);
    expect((await userRow('foto.1')).avatar_etag).toBe(etag);

    // A pessoa escolhe a própria foto: uma foto nova no AD não passa por cima.
    const own = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32, 7)]);
    const set = await api('POST', 'users.setAvatar', { userId: (await userRow('foto.1')).id, avatarUrl: `data:image/png;base64,${own.toString('base64')}` }, A);
    expect(set.success).toBe(true);
    f1.photo = jpeg(3);
    await sync([f1, f2]);
    expect(Buffer.from(await (await raw('/avatar/foto.1', A)).arrayBuffer()).equals(own)).toBe(true);

    f2.photo = null;
    const removed = await sync([f1, f2]);
    expect(removed.changes).toContainEqual({ username: 'foto.2', kind: 'avatar', detail: 'Foto do diretório removida' });
    expect(await userRow('foto.2')).toMatchObject({ avatar_etag: null, ldap_avatar_hash: null, ldap_avatar_etag: null });
    expect((await raw('/avatar/foto.2', A)).headers.get('content-type')).toContain('image/svg+xml');
  });
});

describe('eventos', () => {
  it('mudança de papel publica o evento user com os papéis para a própria pessoa', async () => {
    const eva = person('eva.f', { ou: OU_OP });
    await sync([eva]);
    const ws = connectWs(await sessionOf('eva.f'));
    await ws.ready;
    try {
      eva.groups = ['GG-Sup'];
      await sync([eva]);
      const ev = await ws.waitFor((e) => e.type === 'user' && e.user?.username === 'eva.f' && e.user.roles?.includes('supervisor'));
      expect(ev.user.roles.sort()).toEqual(['supervisor', 'user']);
    } finally {
      ws.close();
    }
  });
});

describe('API da sincronização', () => {
  it('ldap.sync.start dá 409 com outra em andamento; histórico, detalhe e retenção', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slow = runSync({ trigger: 'manual', startedBy: A.userId, source: fakeSource([person('lenta.f')], { gate }) });
    for (let i = 0; i < 50 && !(await pool.query(`SELECT 1 FROM ldap_sync_runs WHERE status = 'running'`)).rowCount; i++) await sleep(20);
    const busy = await api('POST', 'ldap.sync.start', {}, A);
    expect(busy.status).toBe(409);
    expect(busy).toMatchObject({ errorType: 'error-ldap-sync-running', error: 'Já existe uma sincronização do LDAP em andamento.' });
    const status = await api('GET', 'ldap.status', {}, A);
    expect(status.running).toMatchObject({ status: 'running', trigger: 'manual', startedBy: { username: 'admin' } });
    open();
    const done = await slow;
    expect(done.status).toBe('success');

    const list = await api('GET', 'ldap.sync.runs', { count: 5 }, A);
    expect(list.runs).toHaveLength(5);
    expect(list.total).toBeGreaterThan(5);
    const top = list.runs[0];
    expect(top).toMatchObject({ _id: done._id, trigger: 'manual', status: 'success', startedBy: { _id: A.userId, username: 'admin' }, error: null, errorsCount: 0, warningsCount: 0 });
    expect(Object.keys(top.counts).sort()).toEqual(
      ['avatars', 'changed', 'channelsAdded', 'channelsRemoved', 'deactivated', 'errors', 'imported', 'reactivated', 'rolesChanged', 'seen', 'skipped', 'teamsAdded', 'teamsRemoved', 'updated'].sort(),
    );
    expect(typeof top.durationMs).toBe('number');
    expect(top.changesCount).toBeGreaterThan(0);
    expect(top).not.toHaveProperty('changes');
    const one = await api('GET', 'ldap.sync.run', { runId: done._id }, A);
    expect(one.run.changes.length).toBe(top.changesCount);
    expect(one.run.errors).toEqual([]);
    expect(one.run.warnings).toEqual([]);
    expect((await api('GET', 'ldap.sync.run', { runId: 'nao-existe' }, A)).errorType).toBe('error-not-found');

    const status2 = await api('GET', 'ldap.status', {}, A);
    expect(status2).toMatchObject({ enabled: true, running: null, lastRun: { _id: done._id } });
    expect(status2.users.total).toBeGreaterThan(0);

    for (let i = 0; i < 105; i++) {
      await pool.query(`INSERT INTO ldap_sync_runs (id, trigger, status, started_at, finished_at) VALUES ($1, 'cron', 'success', now() - make_interval(days => $2), now() - make_interval(days => $2))`, [`antiga-${i}`, i + 1]);
    }
    await sync([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM ldap_sync_runs')).rows[0].n).toBe(100);

    const plain = await newUser(A);
    expect((await api('GET', 'ldap.status', {}, plain)).status).toBe(403);
    expect((await api('POST', 'ldap.sync.start', {}, plain)).status).toBe(403);
  });

  it('a execução mantém a instância viva sem o agendador (DISABLE_CRON): outra instância não a dá por interrompida', async () => {
    const age = () => pool.query(`UPDATE instances SET last_seen = now() - interval '10 minutes' WHERE id = $1`, [bus.origin]);
    // Vista de outra instância: failDeadRuns de lá (outro bus.origin).
    const fromOtherInstance = async () => {
      const origin = bus.origin;
      Object.defineProperty(bus, 'origin', { value: 'outra-instancia', configurable: true, writable: true });
      try {
        await failDeadRuns();
      } finally {
        Object.defineProperty(bus, 'origin', { value: origin, configurable: true, writable: true });
      }
      return (await pool.query(`SELECT status FROM ldap_sync_runs WHERE status = 'running' OR error IS NOT NULL ORDER BY started_at DESC LIMIT 1`)).rows[0].status;
    };
    await age();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slow = runSync({ trigger: 'manual', startedBy: A.userId, source: fakeSource([person('viva.f')], { gate }) });
    try {
      await waitRunning();
      expect(await fromOtherInstance()).toBe('running');
      // Continua batendo enquanto a execução roda.
      await age();
      vi.advanceTimersByTime(20_000);
      for (let i = 0; i < 50 && (await pool.query(`SELECT 1 FROM instances WHERE id = $1 AND last_seen < now() - interval '1 minute'`, [bus.origin])).rowCount; i++) await sleep(20);
      expect(await fromOtherInstance()).toBe('running');
    } finally {
      open();
      await slow;
      vi.useRealTimers();
    }
    expect((await slow).status).toBe('success');
  });

  it('a prévia não manda a senha salva do usuário de serviço para uma conexão não salva', async () => {
    const SECRET = 'Senha-Salva-Do-Servico-1';
    const got: Buffer[] = [];
    const srv = net.createServer((sock) => sock.on('data', (d) => (got.push(Buffer.from(d)), sock.destroy())));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await settings({ LDAP_Authentication_UserDN: 'CN=svc-wescc-ldap,CN=Users,DC=explorer,DC=test', LDAP_Authentication_Password: SECRET });
    try {
      const r = await api('POST', 'ldap.testMapping', { login: 'ana.souza', overrides: { LDAP_Url: `ldap://127.0.0.1:${port}`, LDAP_Authentication_Password: '********' } }, A);
      expect(r).toMatchObject({ status: 400, errorType: 'error-invalid-params' });
      expect(r.error).toBe('Para testar outra conexão (URL, certificado ou usuário de serviço), informe a senha do usuário de serviço ou salve a conexão antes: a senha salva só vai para o servidor salvo.');
      expect(Buffer.concat(got).includes(Buffer.from(SECRET))).toBe(false);
      // Com a senha informada, a conexão não salva é usada.
      const other = await api('POST', 'ldap.testMapping', { login: 'ana.souza', overrides: { LDAP_Url: `ldap://127.0.0.1:${port}`, LDAP_Authentication_Password: 'outra-senha' } }, A);
      expect(other).toMatchObject({ status: 400, errorType: 'error-ldap-connection' });
      expect(Buffer.concat(got).includes(Buffer.from('outra-senha'))).toBe(true);
      expect(Buffer.concat(got).includes(Buffer.from(SECRET))).toBe(false);
    } finally {
      srv.close();
      await settings({ LDAP_Authentication_UserDN: '', LDAP_Authentication_Password: '' });
    }
  });

  it('uma falha ao ler o diretório termina como falha e não desativa ninguém', async () => {
    await settings({ LDAP_Sync_User_Active_State: true });
    try {
      const active = (await pool.query(`SELECT count(*)::int AS n FROM users WHERE auth_source = 'ldap' AND active`)).rows[0].n;
      const broken: LdapSource = {
        async *users() {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
        },
        groupsOf: async () => [],
        close: async () => {},
      };
      const run = await runSync({ trigger: 'manual', startedBy: A.userId, source: broken });
      expect(run.status).toBe('failed');
      expect(run.error).toBe('Falha ao ler o diretório: conexão recusada pelo servidor LDAP (connect ECONNREFUSED 127.0.0.1:9)');
      expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE auth_source = 'ldap' AND active`)).rows[0].n).toBe(active);
    } finally {
      await settings({ LDAP_Sync_User_Active_State: false });
    }
  });

  it('configurações validadas', async () => {
    const cronErr = await settings({ LDAP_Background_Sync_Interval: 'toda hora' });
    expect(cronErr.status).toBe(400);
    expect(cronErr.error).toBe('Frequência (cron): Expressão cron inválida. Exemplo: */15 * * * * (a cada 15 minutos).');
    expect((await settings({ LDAP_Role_Mapping: '{"a": 1}' })).status).toBe(400);
    expect((await settings({ LDAP_Background_Sync_Interval: '0 * * * *', LDAP_Role_Mapping: '{"a": ["b"]}' })).status).toBe(200);
    expect((await api('GET', 'ldap.status', {}, A)).background).toEqual({ enabled: false, expression: '0 * * * *', valid: true, label: 'A cada hora' });

    // Valor gravado antes da validação (direto no banco).
    await pool.query(`UPDATE settings SET value = '"toda hora"' WHERE id = 'LDAP_Background_Sync_Interval'`);
    await loadSettings();
    try {
      expect((await api('GET', 'ldap.status', {}, A)).background).toMatchObject({ valid: false, label: 'Personalizado: toda hora' });
    } finally {
      await settings({ LDAP_Background_Sync_Interval: '*/15 * * * *', LDAP_Role_Mapping: MAPPING.LDAP_Role_Mapping });
    }
  });

  it('login cai na senha local só com o servidor fora do ar', async () => {
    const u = await newUser(A);
    await pool.query(`UPDATE users SET auth_source = 'ldap', external_id = 'guid-local' WHERE id = $1`, [u.userId]);
    expect(await ldapLogin(u.username, 'senha-forte-1')).toMatchObject({ status: 'unavailable' });
    expect(await ldapLogin(u.username, '')).toMatchObject({ status: 'rejected' });
    const ok = await login(u.username, 'senha-forte-1');
    expect(ok.userId).toBe(u.userId);
    expect((await api('POST', 'login', { user: u.username, password: 'errada-123' })).status).toBe(401);
    await settings({ LDAP_Login_Fallback: false });
    try {
      expect((await api('POST', 'login', { user: u.username, password: 'senha-forte-1' })).status).toBe(401);
    } finally {
      await settings({ LDAP_Login_Fallback: true });
    }
    const test = await api('POST', 'ldap.testMapping', { login: 'ana' }, A);
    expect(test).toMatchObject({ status: 400, errorType: 'error-ldap-connection' });
    expect(test.error).toContain('Falha na conexão: conexão recusada');
  });
});
