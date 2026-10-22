import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Attribute, Change, Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { groupsNamed } from '../src/ldap/client';
import { loadLdapConfig } from '../src/ldap/config';
import { ambiguousKeys, groupNames } from '../src/ldap/mapping';
import { AD, AD_START_HINT, adCa, adUnavailableReason } from './ad-env';
import { admin, api, login, raw, sleep, startServer, stopServer, type Auth } from './helpers';

// Ponta a ponta contra o AD de teste (Samba como controlador de domínio, EXPLORER.TEST).

const reason = await adUnavailableReason();
if (reason) console.warn(`[ldap-ad] AD de teste indisponível (${reason}). Testes de Active Directory ignorados. Para rodar: ${AD_START_HINT}`);

const ca = adCa();
if (!reason && !ca) console.warn(`[ldap-ad] CA do AD de teste não encontrada em ${AD.caFile}: testes que escrevem no AD e de LDAPS ignorados.`);

const GROUPS = `OU=Grupos,${AD.baseDn}`;
const OU_SAC = `OU=SAC,OU=Operacao,${AD.baseDn}`;
const OU_COB = `OU=Cobranca,OU=Operacao,${AD.baseDn}`;
const OPERACAO_DN = `CN=GG-Operacao,${GROUPS}`;

const SETTINGS = {
  LDAP_Enable: true,
  LDAP_Url: AD.url,
  LDAP_Reject_Unauthorized: true,
  LDAP_CA_Certificate: '',
  LDAP_Authentication_UserDN: AD.sync.dn,
  LDAP_Authentication_Password: AD.sync.password,
  LDAP_BaseDN: AD.baseDn,
  // Sem a exclusão por userAccountControl: as contas desativadas aparecem e a sincronização cuida delas.
  LDAP_User_Search_Filter: `(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:=CN=GG-Wescc-Usuarios,${GROUPS}))`,
  LDAP_User_Search_Field: 'sAMAccountName,userPrincipalName',
  LDAP_Username_Field: 'sAMAccountName',
  LDAP_Name_Field: 'displayName,cn',
  LDAP_Email_Field: 'mail,userPrincipalName',
  LDAP_Unique_Identifier_Field: 'objectGUID',
  LDAP_Group_Filter: '(&(objectCategory=group)(member=#{userdn}))',
  LDAP_Group_Nested: true,
  LDAP_Merge_Existing_Users: true,
  LDAP_Enable_Role_Mapping: true,
  LDAP_Role_Mapping: JSON.stringify({
    [`group:${OPERACAO_DN}`]: ['operacao'],
    'GG-Op-Conversa-Direta': ['operacao-conversa-direta'],
    'GG-Op-Supervisores': ['supervisor'],
    'GG-Avisos-Publicadores': ['avisos-publicador'],
    'GG-Wescc-Admins': ['admin'],
  }),
  LDAP_Enable_Channel_Mapping: true,
  LDAP_Channel_Mapping: JSON.stringify({
    '*': ['avisos-geral'],
    [`group:${OPERACAO_DN}`]: ['avisos-operacao'],
    [`ou:${OU_SAC}`]: ['sac'],
    [`ou:${OU_COB}`]: ['cobranca'],
    'GG-Op-Supervisores': ['supervisao', 'sac', 'cobranca'],
  }),
  LDAP_Channels_Admin: 'admin',
  LDAP_Channels_Auto_Remove: true,
  LDAP_Enable_Team_Mapping: true,
  LDAP_Team_Mapping: JSON.stringify({ [`group:${OPERACAO_DN}`]: ['time-operacao'] }),
  LDAP_Teams_Auto_Remove: true,
};

const MAPPED_CHANNELS = ['avisos-geral', 'avisos-operacao', 'cobranca', 'sac', 'supervisao'];
const OPS = ['ana.souza', 'joao.silva', ...Array.from({ length: 20 }, (_, i) => `op.sac.${String(i + 1).padStart(2, '0')}`)];
const EXPECTED: Record<string, { roles: string[]; channels: string[]; team: boolean }> = {
  ...Object.fromEntries(OPS.map((u) => [u, { roles: ['operacao'], channels: ['avisos-geral', 'avisos-operacao', 'sac'], team: true }])),
  'bruno.lima': { roles: ['operacao', 'operacao-conversa-direta'], channels: ['avisos-geral', 'avisos-operacao', 'sac'], team: true },
  'carla.mendes': { roles: ['operacao'], channels: ['avisos-geral', 'avisos-operacao', 'cobranca'], team: true },
  'elisa.ferreira': { roles: ['avisos-publicador', 'supervisor', 'user'], channels: ['avisos-geral', 'cobranca', 'sac', 'supervisao'], team: false },
  'fabio.costa': { roles: ['avisos-publicador', 'user'], channels: ['avisos-geral'], team: false },
  'gabriela.nunes': { roles: ['admin', 'user'], channels: ['avisos-geral'], team: false },
};

const FABIO_LOCAL_PASSWORD = 'senha-local-fabio-1';

describe.skipIf(!!reason)('Active Directory de teste (EXPLORER.TEST)', () => {
  let A: Auth;
  let reader: Client;
  const tmpSam = `wtmp.${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
  let tmpDn = `CN=${tmpSam},${OU_SAC}`;

  const settings = (values: Record<string, unknown>) => api('POST', 'settings', { settings: values }, A);

  async function provision() {
    const c = new Client({ url: AD.ldapsUrl, timeout: 15_000, connectTimeout: 10_000, tlsOptions: { ca: [ca!] } });
    await c.bind(AD.provision.dn, AD.provision.password);
    return c;
  }

  async function withProvision<T>(fn: (c: Client) => Promise<T>) {
    const c = await provision();
    try {
      return await fn(c);
    } finally {
      await c.unbind().catch(() => {});
    }
  }

  const memberChange = (operation: 'add' | 'delete', dn: string) => new Change({ operation, modification: new Attribute({ type: 'member', values: [dn] }) });
  const uacChange = (uac: number) => new Change({ operation: 'replace', modification: new Attribute({ type: 'userAccountControl', values: [String(uac)] }) });

  async function syncNow() {
    const started = await api('POST', 'ldap.sync.start', {}, A);
    expect(started.success, JSON.stringify(started)).toBe(true);
    expect(started.run.status).toBe('running');
    for (let i = 0; i < 300; i++) {
      const r = await api('GET', 'ldap.sync.run', { runId: started.run._id }, A);
      if (r.run.status !== 'running') return r.run;
      await sleep(200);
    }
    throw new Error('a sincronização não terminou em 60 s');
  }

  async function membersOf(name: string): Promise<string[]> {
    const info = await api('GET', 'rooms.info', { roomName: name }, A);
    if (!info.success) return [];
    const prefix = info.room.t === 'c' ? 'channels' : 'groups';
    const r = await api('GET', `${prefix}.members`, { roomId: info.room._id, count: 500 }, A);
    return r.members.map((m: any) => m.username);
  }

  async function teamMembers(name: string): Promise<string[]> {
    const r = await api('GET', 'teams.members', { teamName: name, count: 200 }, A);
    return r.members.map((m: any) => m.user.username);
  }

  const userInfo = (username: string) => api('GET', 'users.info', { username }, A);
  const rolesOf = async (username: string) => ((await userInfo(username)).user?.roles ?? []).slice().sort();
  const ldapState = async (username: string) =>
    (await pool.query('SELECT active, ldap_deactivated_reason FROM users WHERE username = $1', [username])).rows[0];

  async function deleteTemporaryUsers() {
    if (!ca) return;
    await withProvision(async (c) => {
      const { searchEntries } = await c.search(AD.baseDn, { scope: 'sub', filter: '(&(objectClass=user)(sAMAccountName=wtmp.*))', attributes: ['sAMAccountName'] });
      for (const e of searchEntries) await c.del(e.dn);
    });
  }

  beforeAll(async () => {
    reader = new Client({ url: AD.url, timeout: 10_000, connectTimeout: 5_000 });
    await reader.bind(AD.sync.dn, AD.sync.password);
    const ana = await reader.search(AD.baseDn, { scope: 'sub', filter: '(sAMAccountName=ana.souza)', attributes: ['dn'] });
    if (!ana.searchEntries.length) throw new Error('A árvore de teste não foi semeada: rode adctl.sh seed.');
    await deleteTemporaryUsers();

    await startServer();
    A = await admin();
    await settings({ API_Enable_Rate_Limiter: false });
    for (const [name, description] of [
      ['operacao-conversa-direta', 'Operação com conversa direta'],
      ['supervisor', 'Supervisor'],
      ['avisos-publicador', 'Publica nos canais de avisos'],
    ]) {
      expect((await api('POST', 'roles.create', { name, description, scope: 'Users' }, A)).success).toBe(true);
    }
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    const plus = (id: string, role: string) => ({ _id: id, roles: [...(perms.find((p) => p._id === id)?.roles ?? []), role] });
    expect(
      (await api('POST', 'permissions.update', { permissions: [plus('start-dm-between-restricted', 'operacao-conversa-direta'), plus('post-readonly', 'avisos-publicador')] }, A)).success,
    ).toBe(true);
    for (const name of ['avisos-geral', 'avisos-operacao']) {
      expect((await api('POST', 'channels.create', { name, extraData: { notice: true, noticeAck: true } }, A)).success).toBe(true);
    }
    expect((await api('POST', 'teams.create', { name: 'time-operacao', type: 0 }, A)).success).toBe(true);
    // Conta local com o mesmo nome de um usuário do AD: será vinculada pela sincronização.
    const fabio = await api('POST', 'users.create', { username: 'fabio.costa', name: 'Fábio (local)', email: 'fabio.local@test.local', password: FABIO_LOCAL_PASSWORD }, A);
    expect(fabio.success).toBe(true);
    const saved = await settings(SETTINGS);
    expect(saved.success, JSON.stringify(saved)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await deleteTemporaryUsers().catch(() => {});
    await reader?.unbind().catch(() => {});
    await stopServer();
  });

  it('testConnection e prévia de joao.silva por UPN', async () => {
    const conn = await api('POST', 'ldap.testConnection', {}, A);
    expect(conn.status, JSON.stringify(conn)).toBe(200);

    const { result } = await api('POST', 'ldap.testMapping', { login: 'joao.silva@explorer.test' }, A);
    expect(result.found).toBe(true);
    expect(result.entry.dn).toContain('Silva\\, João');
    expect(result.entry.username).toBe('joao.silva');
    expect(result.entry.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.groups.map((g: any) => g.cn)).toEqual(expect.arrayContaining(['GG-Op-SAC', 'GG-Operacao', 'GG-Wescc-Usuarios']));
    expect(result.nestedApplied).toBe(true);
    expect(result.account).toMatchObject({ exists: false, action: 'create', activeAfter: true });
    expect(result.roles.after).toEqual(['operacao']);
    expect(result.channels.join).toEqual(expect.arrayContaining(['avisos-geral', 'avisos-operacao', 'sac']));
    expect(result.channels.create).toEqual(['sac']);
    expect(result.teams.join).toEqual(['time-operacao']);
    expect(result.direct).toEqual({ restricted: true, exempt: false });

    const none = await api('POST', 'ldap.testMapping', { login: 'nao.existe' }, A);
    expect(none.result).toMatchObject({ found: false, message: 'Nenhuma entrada encontrada para "nao.existe" com o filtro de usuários atual.' });
  });

  it('sem grupos aninhados ana não cai em GG-Operacao', async () => {
    const { result } = await api('POST', 'ldap.testMapping', { login: 'ana.souza', overrides: { LDAP_Group_Nested: false } }, A);
    expect(result.groups.map((g: any) => g.cn)).toEqual(['GG-Op-SAC']);
    expect(result.nestedApplied).toBe(false);
    expect(result.roles.after).toContain('user');
    expect(result.roles.after).not.toContain('operacao');
    // Nada foi salvo: a configuração continua com grupos aninhados.
    expect((await api('POST', 'ldap.testMapping', { login: 'ana.souza' }, A)).result.roles.after).toEqual(['operacao']);
  });

  it('grupos que não podem ser lidos: a prévia não promete criar a conta', async () => {
    const overrides = { LDAP_Group_BaseDN: `OU=NaoExiste,${AD.baseDn}` };
    const { result } = await api('POST', 'ldap.testMapping', { login: 'ana.souza', overrides }, A);
    expect(result.groupError).toMatch(/^Falha ao buscar grupos: /);
    expect(result.account).toEqual({
      exists: false,
      action: 'skip',
      activeAfter: false,
      note: 'Sem os grupos não dá para saber os papéis: a conta não será criada agora (a próxima sincronização tenta de novo).',
    });
    expect(result.roles.after).toEqual([]);
  });

  it('senha errada do usuário de serviço: o motivo aparece traduzido uma vez só', async () => {
    try {
      expect((await settings({ LDAP_Authentication_Password: 'senha-errada-de-servico' })).success).toBe(true);
      const conn = await api('POST', 'ldap.testConnection', {}, A);
      expect(conn.status).toBe(400);
      expect(conn.error).toMatch(/^Falha na conexão: o usuário de serviço foi recusado pelo servidor LDAP \(80090308: [^()]*\)$/);
      const test = await api('POST', 'ldap.testMapping', { login: 'ana.souza' }, A);
      expect(test.error).toMatch(/^Falha na conexão: o usuário de serviço foi recusado pelo servidor LDAP \(80090308: [^()]*\)$/);
    } finally {
      await settings({ LDAP_Authentication_Password: AD.sync.password });
    }
  });

  it('nomes das regras: no AD de teste cada um é um grupo só', async () => {
    const cfg = loadLdapConfig();
    const names = groupNames(cfg).sort();
    expect(names).toEqual(['GG-Avisos-Publicadores', 'GG-Op-Conversa-Direta', 'GG-Op-Supervisores', 'GG-Wescc-Admins']);
    const found = await groupsNamed(reader, cfg, names);
    expect(found.map((g) => g.dn).sort()).toEqual(names.map((n) => `CN=${n},${GROUPS}`));
    expect(ambiguousKeys(cfg, found)).toEqual([]);
  });

  it.skipIf(!ca)('uma pessoa com o mesmo cn de um grupo não torna a regra ambígua', async () => {
    const sam = `wtmp.cn${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
    const dn = `CN=GG-Wescc-Admins,${OU_SAC}`;
    await withProvision((c) =>
      c.add(dn, [
        new Attribute({ type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'] }),
        new Attribute({ type: 'cn', values: ['GG-Wescc-Admins'] }),
        new Attribute({ type: 'sAMAccountName', values: [sam] }),
      ]),
    );
    try {
      const cfg = loadLdapConfig();
      const found = await groupsNamed(reader, cfg, ['GG-Wescc-Admins']);
      expect(found.map((g) => g.dn)).toEqual([`CN=GG-Wescc-Admins,${GROUPS}`]);
      const { result } = await api('POST', 'ldap.testMapping', { login: 'gabriela.nunes' }, A);
      expect(result.groupError).toBeUndefined();
      expect(result.roles.after.slice().sort()).toEqual(['admin', 'user']);
    } finally {
      await withProvision((c) => c.del(dn));
    }
  });

  it('sincronização completa', async () => {
    const run = await syncNow();
    expect(run.status, JSON.stringify(run.errors)).toBe('success');
    const tmpCreated = run.changes.filter((c: any) => c.kind === 'created' && c.username.startsWith('wtmp.')).length;
    expect(run.counts.imported - tmpCreated).toBe(27);
    expect(run.changes).toContainEqual({ username: 'fabio.costa', kind: 'profile', detail: expect.stringContaining('conta local vinculada ao LDAP') });
    expect((await userInfo('diego.rocha')).success).toBe(false);

    const channels = new Map<string, string[]>();
    for (const ch of [...MAPPED_CHANNELS, 'geral']) channels.set(ch, await membersOf(ch));
    const team = await teamMembers('time-operacao');
    for (const [username, exp] of Object.entries(EXPECTED)) {
      expect(await rolesOf(username), username).toEqual(exp.roles.slice().sort());
      expect(MAPPED_CHANNELS.filter((ch) => channels.get(ch)!.includes(username)), username).toEqual(exp.channels.slice().sort());
      expect(team.includes(username), username).toBe(exp.team);
      expect(channels.get('geral')!.includes(username), username).toBe(true);
    }
    const sac = await api('GET', 'rooms.info', { roomName: 'sac' }, A);
    expect(sac.room).toMatchObject({ t: 'p', u: { username: 'admin' } });

    const again = await syncNow();
    expect(again.status).toBe('success');
    expect(again.counts).toMatchObject({ imported: 0, changed: 0, errors: 0 });
  }, 90_000);

  it('fotos do AD viram avatar', async () => {
    const { searchEntries } = await reader.search(AD.baseDn, {
      scope: 'sub',
      filter: '(sAMAccountName=ana.souza)',
      attributes: ['thumbnailPhoto'],
      explicitBufferAttributes: ['thumbnailPhoto'],
    });
    const photo = searchEntries[0].thumbnailPhoto as Buffer;
    expect(Buffer.isBuffer(photo) && photo.length > 0).toBe(true);
    const res = await raw('/avatar/ana.souza', A);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(photo));
    expect((await raw('/avatar/op.sac.01', A)).headers.get('content-type')).toContain('image/svg+xml');
  });

  it('login pelo AD e regra de DM', async () => {
    const ana = await login('ana.souza', AD.userPassword);
    expect((await api('POST', 'im.create', { username: 'carla.mendes' }, ana)).errorType).toBe('error-direct-restricted');
    expect((await api('POST', 'im.create', { username: 'elisa.ferreira' }, ana)).success).toBe(true);

    const bruno = await login('bruno.lima', AD.userPassword);
    const dm = await api('POST', 'im.create', { username: 'ana.souza' }, bruno);
    expect(dm.success, JSON.stringify(dm)).toBe(true);
    const reply = await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'Oi, Bruno!' } }, ana);
    expect(reply.success, JSON.stringify(reply)).toBe(true);

    expect((await api('POST', 'login', { user: 'ana.souza', password: 'Errada#2026' })).status).toBe(401);
  });

  it.skipIf(!ca)('ciclo de vida de um usuário temporário', async () => {
    await withProvision(async (c) => {
      await c.add(tmpDn, [
        new Attribute({ type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'] }),
        new Attribute({ type: 'cn', values: [tmpSam] }),
        new Attribute({ type: 'sAMAccountName', values: [tmpSam] }),
        new Attribute({ type: 'userPrincipalName', values: [`${tmpSam}@explorer.test`] }),
        new Attribute({ type: 'displayName', values: ['Usuário Temporário'] }),
        new Attribute({ type: 'mail', values: [`${tmpSam}@explorer.test`] }),
        new Attribute({ type: 'unicodePwd', values: [Buffer.from(`"${AD.userPassword}"`, 'utf16le')] }),
        new Attribute({ type: 'userAccountControl', values: ['512'] }),
      ]);
      await c.modify(`CN=GG-Op-SAC,${GROUPS}`, memberChange('add', tmpDn));
    });
    await syncNow();
    expect(await rolesOf(tmpSam)).toEqual(['operacao']);
    expect(await membersOf('sac')).toContain(tmpSam);
    expect(await teamMembers('time-operacao')).toContain(tmpSam);
    const session = await login(tmpSam, AD.userPassword);

    // Mudou de operação: de OU e de grupo.
    const movedDn = `CN=${tmpSam},${OU_COB}`;
    await withProvision(async (c) => {
      await c.modifyDN(tmpDn, movedDn);
      await c.modify(`CN=GG-Op-SAC,${GROUPS}`, memberChange('delete', movedDn));
      await c.modify(`CN=GG-Op-Cobranca,${GROUPS}`, memberChange('add', movedDn));
    });
    tmpDn = movedDn;
    const moved = await syncNow();
    expect(moved.changes).toContainEqual({ username: tmpSam, kind: 'profile', detail: 'OU: SAC › Operacao › Explorer → Cobranca › Operacao › Explorer' });
    expect(await membersOf('cobranca')).toContain(tmpSam);
    expect(await membersOf('sac')).not.toContain(tmpSam);
    expect(await rolesOf(tmpSam)).toEqual(['operacao']);

    await withProvision((c) => c.modify(tmpDn, uacChange(514)));
    await syncNow();
    expect(await ldapState(tmpSam)).toEqual({ active: false, ldap_deactivated_reason: 'disabled' });
    expect((await api('GET', 'subscriptions.get', undefined, session)).status).toBe(401);

    await withProvision((c) => c.modify(tmpDn, uacChange(512)));
    const back = await syncNow();
    expect(back.counts.reactivated).toBe(1);
    expect(await ldapState(tmpSam)).toEqual({ active: true, ldap_deactivated_reason: null });

    await withProvision((c) => c.del(tmpDn));
    const removed = await syncNow();
    expect(removed.changes).toContainEqual({ username: tmpSam, kind: 'deactivated', detail: 'Não aparece mais na busca do LDAP' });
    expect(await ldapState(tmpSam)).toEqual({ active: false, ldap_deactivated_reason: 'removed' });
  }, 120_000);

  it.skipIf(!ca)('LDAPS com a CA nas configurações', async () => {
    try {
      await settings({ LDAP_Url: AD.ldapsUrl, LDAP_CA_Certificate: ca });
      const ok = await api('POST', 'ldap.testConnection', {}, A);
      expect(ok.status, JSON.stringify(ok)).toBe(200);
      await settings({ LDAP_CA_Certificate: '' });
      // Só dá para provar a recusa quando o Node não confia na CA de teste por outro caminho.
      const extra = process.env.NODE_EXTRA_CA_CERTS ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') : '';
      if (extra.includes(ca!.trim().split('\n')[1])) {
        console.warn('[ldap-ad] NODE_EXTRA_CA_CERTS já confia na CA de teste: a recusa sem a CA não foi verificada.');
      } else {
        const refused = await api('POST', 'ldap.testConnection', {}, A);
        expect(refused.status).toBe(400);
        expect(refused.error).toContain('Falha na conexão');
      }
    } finally {
      await settings({ LDAP_Url: AD.url, LDAP_CA_Certificate: '' });
    }
  });

  it('conta vinculada não usa a senha local quando o AD recusa', async () => {
    expect((await userInfo('fabio.costa')).user.roles.slice().sort()).toEqual(['avisos-publicador', 'user']);
    expect((await api('POST', 'login', { user: 'fabio.costa', password: FABIO_LOCAL_PASSWORD })).status).toBe(401);
    expect((await login('fabio.costa', AD.userPassword)).username).toBe('fabio.costa');
  });
});
