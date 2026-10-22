import type { Client } from 'ldapts';
import { describe, expect, it } from 'vitest';
import { dnIsUnder, normalizeDn, ouLabel, parseLdapKey, splitDn, type LdapGroupRef } from '@shared/ldap';
import { bindService, entryUid, groupsNamed, groupsOf, guidString, isAccountDisabled, isPersonEntry, ldapErrorText, legacyUids } from '../src/ldap/client';
import { detectImageType, planLdapAvatar } from '../src/ldap/avatar';
import type { LdapConfig } from '../src/ldap/config';
import { ambiguousKeys, ambiguousMatch, applyNestedGroups, groupNames, matchKeys, planMembership, planRoles, type RolePlanInput } from '../src/ldap/mapping';

// Regras puras do LDAP: nenhum servidor nem banco de dados.

const BASE = 'DC=explorer,DC=test';
const SAC = `OU=SAC,OU=Operacao,OU=Explorer,${BASE}`;

function cfgOf(extra: Partial<LdapConfig> = {}): LdapConfig {
  return {
    enabled: true, url: 'ldap://127.0.0.1:389', rejectUnauthorized: true, caPem: '', bindDn: '', bindPassword: '', baseDn: BASE,
    userFilter: '(objectclass=*)', loginFields: ['sAMAccountName'], groupBaseDn: BASE, usernameFields: ['sAMAccountName'], nameFields: ['cn'],
    emailFields: ['mail'], uidFields: ['objectGUID', 'entryUUID'], loginFallback: true, mergeExisting: false, syncAvatar: true,
    avatarFields: ['thumbnailPhoto', 'jpegPhoto'], background: false, backgroundInterval: '*/15 * * * *', importNewUsers: true, syncActiveState: true,
    syncAdDisabled: true, reactivateUsers: true, maxDeactivationPercent: 50, roleMapping: true, roleMap: {}, groupFilter: '', groupNested: false,
    defaultRoles: ['user'], defaultRolesSkipRestricted: true, rolesAutoRemove: true, channelMapping: true, channelMap: {}, channelsAutoRemove: false,
    channelsAdmin: '', teamMapping: true, teamMap: {}, teamsAutoRemove: false, warnings: [],
    ...extra,
  };
}

const group = (cn: string, ou = 'Grupos', sam = cn): LdapGroupRef => ({ dn: `CN=${cn},OU=${ou},OU=Explorer,${BASE}`, cn, sAMAccountName: sam });

describe('chaves dos mapas', () => {
  it('reconhece *, ou:, group: com DN e com nome, nome antigo e DN antigo', () => {
    expect(parseLdapKey('*')).toEqual({ key: '*', kind: 'all', value: '*' });
    expect(parseLdapKey('ou:  OU=SAC,OU=Operacao ')).toMatchObject({ kind: 'ou', value: 'OU=SAC,OU=Operacao' });
    expect(parseLdapKey('group:CN=GG-Operacao,OU=Grupos')).toMatchObject({ kind: 'group-dn', value: 'CN=GG-Operacao,OU=Grupos' });
    expect(parseLdapKey('group:GG-Operacao')).toMatchObject({ kind: 'group', value: 'GG-Operacao' });
    expect(parseLdapKey('GG-Op-SAC')).toEqual({ key: 'GG-Op-SAC', kind: 'group', value: 'GG-Op-SAC' });
    expect(parseLdapKey('CN=GG-Op-SAC,OU=Grupos')).toMatchObject({ kind: 'group-dn', value: 'CN=GG-Op-SAC,OU=Grupos' });
  });
});

describe('DNs', () => {
  it('respeita a vírgula escapada, ignora maiúsculas e espaços e só casa RDNs inteiros', () => {
    const joao = `CN=Silva\\, João,${SAC}`;
    expect(splitDn(joao)[0]).toBe('CN=Silva\\, João');
    expect(splitDn(joao)).toHaveLength(6);
    expect(normalizeDn('cn=Silva\\, João, ou=SAC ,OU=operacao,ou=Explorer, dc=EXPLORER,DC=test')).toBe(normalizeDn(joao));
    expect(dnIsUnder(joao, SAC)).toBe(true);
    expect(dnIsUnder(`CN=Ana,OU=SAC2,OU=Operacao,OU=Explorer,${BASE}`, SAC)).toBe(false);
    expect(dnIsUnder(SAC, SAC)).toBe(false);
    expect(ouLabel(SAC)).toBe('SAC › Operacao › Explorer');
  });
});

describe('regras que se aplicam (matchKeys)', () => {
  it('casa grupo por cn, sAMAccountName ou DN em qualquer caixa, e OU dois níveis acima', () => {
    const maps = {
      roleMap: { 'gg-operacao': ['operacao'], 'group:sam-sac': ['a'], [`group:${group('GG-Op-SAC').dn.toUpperCase()}`]: ['b'], 'GG-Outro': ['c'] },
      channelMap: { '*': ['avisos-geral'], 'ou:OU=Operacao,OU=Explorer,DC=explorer,DC=test': ['operacao'], 'ou:OU=Cobranca,OU=Operacao,OU=Explorer,DC=explorer,DC=test': ['cobranca'] },
      teamMap: { 'gg-operacao': ['time-operacao'] },
    };
    const groups = [group('GG-Operacao'), group('GG-Op-SAC', 'Grupos', 'SAM-SAC')];
    const keys = matchKeys(maps, `CN=Ana Souza,${SAC}`, groups).map((k) => k.key);
    expect(keys).toEqual(['gg-operacao', 'group:sam-sac', `group:${group('GG-Op-SAC').dn.toUpperCase()}`, '*', 'ou:OU=Operacao,OU=Explorer,DC=explorer,DC=test']);
  });

  it('nome de regra que serve para mais de um grupo do diretório é ambíguo; regra por DN nunca é', () => {
    const real = group('GG-Wescc-Admins');
    const rogue = group('GG-Wescc-Admins', 'Helpdesk', 'GG-Helpdesk-Temp');
    const maps = {
      roleMap: { 'GG-Wescc-Admins': ['admin'], [`group:${group('GG-Op').dn}`]: ['operacao'], 'group:GG-Unico': ['x'] },
      channelMap: { 'gg-wescc-admins': ['ti'], 'GG-Sozinho': ['y'] },
      teamMap: {},
    };
    expect(groupNames(maps)).toEqual(['GG-Wescc-Admins', 'GG-Unico', 'GG-Sozinho']);
    // Outro grupo com o sAMAccountName igual ao nome da regra também conta; o mesmo DN em outra caixa não.
    const otherSam = group('Outro', 'Helpdesk', 'GG-Unico');
    const directory = [real, rogue, group('GG-Op'), group('GG-Op', 'Helpdesk'), group('GG-Unico'), otherSam, group('GG-Sozinho'), { ...group('GG-Sozinho'), dn: group('GG-Sozinho').dn.toUpperCase() }];
    const amb = ambiguousKeys(maps, directory);
    expect(amb).toEqual([
      { key: 'GG-Wescc-Admins', dns: [real.dn, rogue.dn] },
      { key: 'group:GG-Unico', dns: [group('GG-Unico').dn, otherSam.dn] },
      { key: 'gg-wescc-admins', dns: [real.dn, rogue.dn] },
    ]);
    expect(ambiguousMatch(amb, [rogue])?.key).toBe('GG-Wescc-Admins');
    expect(ambiguousMatch(amb, [real])?.key).toBe('GG-Wescc-Admins');
    expect(ambiguousMatch(amb, [group('GG-Op', 'Helpdesk'), group('GG-Sozinho')])).toBeUndefined();
    expect(ambiguousKeys(maps, [real, group('GG-Unico'), group('GG-Sozinho')])).toEqual([]);
  });
});

describe('papéis (planRoles)', () => {
  const scopes = new Map([
    ['user', 'Users'],
    ['admin', 'Users'],
    ['operacao', 'Users'],
    ['supervisor', 'Users'],
    ['livre', 'Users'],
    ['owner', 'Subscriptions'],
  ]);
  const base: RolePlanInput = {
    current: [],
    matchedKeys: [],
    roleMap: { 'GG-Operacao': ['operacao'], 'GG-Sup': ['supervisor'], 'GG-Admins': ['admin'] },
    defaultRoles: ['user'],
    skipRestricted: true,
    autoRemove: true,
    roleScopes: scopes,
    restrictedRoles: ['operacao'],
    lastActiveAdmin: false,
  };

  it('soma os papéis mapeados aos padrões', () => {
    expect(planRoles({ ...base, matchedKeys: ['GG-Sup'] }).next).toEqual(['supervisor', 'user']);
  });

  it('papel restrito tira os padrões, a não ser com a opção desligada', () => {
    expect(planRoles({ ...base, matchedKeys: ['GG-Operacao'] }).next).toEqual(['operacao']);
    expect(planRoles({ ...base, matchedKeys: ['GG-Operacao'], skipRestricted: false }).next).toEqual(['operacao', 'user']);
  });

  it('com remoção automática tira os papéis gerenciados (inclusive user) e mantém os manuais; sem ela só acrescenta', () => {
    const p = planRoles({ ...base, current: ['user', 'supervisor', 'livre'], matchedKeys: ['GG-Operacao'] });
    expect(p.next.sort()).toEqual(['livre', 'operacao']);
    expect(p.removed.sort()).toEqual(['supervisor', 'user']);
    expect(p.added).toEqual(['operacao']);
    const off = planRoles({ ...base, current: ['user', 'supervisor', 'livre'], matchedKeys: ['GG-Operacao'], autoRemove: false });
    expect(off.next).toEqual(['user', 'supervisor', 'livre', 'operacao']);
    expect(off.removed).toEqual([]);
  });

  it('ignora papel que não existe ou de sala, com aviso', () => {
    const p = planRoles({ ...base, roleMap: { g: ['fantasma', 'owner', 'supervisor'] }, matchedKeys: ['g'] });
    expect(p.next).toEqual(['supervisor', 'user']);
    expect(p.warnings).toEqual(['Papel "fantasma" do mapeamento não existe ou não é global.', 'Papel "owner" do mapeamento não existe ou não é global.']);
  });

  it('o último administrador ativo continua admin', () => {
    const p = planRoles({ ...base, current: ['user', 'admin'], matchedKeys: [], lastActiveAdmin: true, username: 'gabi' });
    expect(p.next).toContain('admin');
    expect(p.warnings[0]).toContain('@gabi é o último administrador ativo');
    expect(planRoles({ ...base, current: ['user', 'admin'], matchedKeys: [] }).next).toEqual(['user']);
  });
});

describe('canais e times (planMembership)', () => {
  const managed = [
    { name: 'sac', id: 'r-sac' },
    { name: 'cobranca', id: 'r-cob' },
    { name: 'supervisao', id: 'r-sup' },
    { name: 'novo', id: null },
  ];

  it('entra no desejado, sai do gerenciado, poupa quem tem papel na sala e aponta o que falta', () => {
    const p = planMembership({ desired: ['SAC', 'novo'], managed, memberOf: new Set(['r-cob', 'r-sup', 'r-fora']), protectedIds: new Set(['r-sup']), autoRemove: true, active: true });
    expect(p.join.map((t) => t.name)).toEqual(['sac']);
    expect(p.missing).toEqual(['novo']);
    expect(p.leave.map((t) => t.name)).toEqual(['cobranca']);
    expect(p.kept.map((t) => t.name)).toEqual(['supervisao']);
  });

  it('sem remoção automática ninguém sai; inativo não entra, mas sai', () => {
    expect(planMembership({ desired: [], managed, memberOf: new Set(['r-cob']), protectedIds: new Set(), autoRemove: false, active: true }).leave).toEqual([]);
    const inactive = planMembership({ desired: ['sac'], managed, memberOf: new Set(['r-cob']), protectedIds: new Set(), autoRemove: true, active: false });
    expect(inactive.join).toEqual([]);
    expect(inactive.leave.map((t) => t.name)).toEqual(['cobranca']);
  });
});

describe('grupos aninhados', () => {
  it('troca a cláusula member em qualquer caixa e avisa quando não há o que trocar', () => {
    expect(applyNestedGroups('(&(objectCategory=group)(member=#{userdn}))')).toEqual({
      filter: '(&(objectCategory=group)(member:1.2.840.113556.1.4.1941:=#{userdn}))',
      applied: true,
    });
    expect(applyNestedGroups('(&(objectclass=group)( Member = #{userDN} ))').filter).toBe('(&(objectclass=group)(member:1.2.840.113556.1.4.1941:=#{userdn}))');
    expect(applyNestedGroups('(&(objectclass=posixGroup)(memberUid=#{username}))')).toEqual({ filter: '(&(objectclass=posixGroup)(memberUid=#{username}))', applied: false });
  });

  it('DN e nome com $ entram no filtro de grupos como estão', async () => {
    const filters: string[] = [];
    const fake = { search: async (_base: string, o: { filter: string }) => (filters.push(o.filter), { searchEntries: [] }) } as unknown as Client;
    const cfg = cfgOf({ groupFilter: '(|(member=#{userdn})(memberUid=#{username}))' });
    await groupsOf(fake, cfg, { dn: "CN=Joana D$'Arc $` $& $$,OU=SAC,DC=x", sAMAccountName: 'joana$&' });
    expect(filters).toEqual(["(|(member=CN=Joana D$'Arc $` $& $$,OU=SAC,DC=x)(memberUid=joana$&))"]);
  });

  it('um marcador dentro do DN ou do nome não é preenchido de novo', async () => {
    const filters: string[] = [];
    const fake = { search: async (_base: string, o: { filter: string }) => (filters.push(o.filter), { searchEntries: [] }) } as unknown as Client;
    const cfg = cfgOf({ groupFilter: '(&(objectCategory=group)(|(member=#{userdn})(memberUid=#{username})))' });
    await groupsOf(fake, cfg, { dn: 'CN=Ana #{username} Souza,OU=SAC,DC=x', sAMAccountName: 'eve.x' });
    await groupsOf(fake, cfg, { dn: 'CN=Eva,OU=SAC,DC=x', sAMAccountName: 'eva#{userdn}' });
    expect(filters).toEqual([
      '(&(objectCategory=group)(|(member=CN=Ana #{username} Souza,OU=SAC,DC=x)(memberUid=eve.x)))',
      '(&(objectCategory=group)(|(member=CN=Eva,OU=SAC,DC=x)(memberUid=eva#{userdn})))',
    ]);
  });

  it('busca os grupos com os nomes das regras pelo cn e pelo sAMAccountName, só entre grupos', async () => {
    const calls: [string, string][] = [];
    const found = [
      { dn: 'CN=GG-A,OU=Grupos,DC=x', cn: 'GG-A', sAMAccountName: 'GG-A' },
      { dn: 'CN=GG-A,OU=Helpdesk,DC=x', cn: 'GG-A', sAMAccountName: 'H-1' },
    ];
    const fake = { search: async (base: string, o: { filter: string }) => (calls.push([base, o.filter]), { searchEntries: found }) } as unknown as Client;
    const cfg = cfgOf({ groupBaseDn: 'OU=Explorer,DC=x' });
    expect(await groupsNamed(fake, cfg, ['GG-A', 'a*b'])).toEqual(found);
    expect(await groupsNamed(fake, cfg, [])).toEqual([]);
    expect(calls).toEqual([
      [
        'OU=Explorer,DC=x',
        '(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(|(cn=GG-A)(sAMAccountName=GG-A)(cn=a\\2ab)(sAMAccountName=a\\2ab)))',
      ],
    ]);
  });
});

describe('erros do servidor', () => {
  const ad = '80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1 Code: 0x31';
  const refused = () => Object.assign(new Error(ad), { code: 49 });

  it('a recusa do usuário de serviço é traduzida uma vez só', async () => {
    const fake = { bind: async () => Promise.reject(refused()) } as unknown as Client;
    const err = await bindService(fake, cfgOf({ bindDn: 'CN=svc-wescc-ldap,CN=Users,DC=explorer,DC=test', bindPassword: 'errada' })).catch((e) => e);
    expect(ldapErrorText(err)).toBe(`o usuário de serviço foi recusado pelo servidor LDAP (${ad})`);
    // A recusa da senha de uma pessoa continua com o texto genérico.
    expect(ldapErrorText(refused())).toBe(`usuário ou senha recusados pelo servidor LDAP (${ad})`);
  });
});

describe('identificador, conta e foto', () => {
  const guid = Buffer.from('f32beb9a3684a24b94ad0e020e83072a', 'hex');

  it('GUID binário vira hex; o formato canônico é o do AD; texto fica como está', () => {
    const cfg = cfgOf();
    expect(entryUid({ dn: 'CN=a', objectGUID: guid }, cfg)).toBe('f32beb9a3684a24b94ad0e020e83072a');
    expect(guidString(guid)).toBe('9aeb2bf3-8436-4ba2-94ad-0e020e83072a');
    expect(entryUid({ dn: 'CN=a', entryUUID: '6f1c-texto' }, cfg)).toBe('6f1c-texto');
    expect(entryUid({ dn: 'CN=sem-id' }, cfg)).toBe('CN=sem-id');
    // Esses bytes não são UTF-8 válido: a forma antiga era o próprio hex.
    expect(legacyUids({ dn: 'CN=a', objectGUID: guid }, cfg)).toEqual(['CN=a']);
    expect(legacyUids({ dn: 'CN=b', objectGUID: Buffer.from('abcdefghijklmnop') }, cfg)).toEqual(['abcdefghijklmnop', 'CN=b']);
  });

  it('grupos, OUs e computadores não são pessoas; userAccountControl 514 é conta desativada', () => {
    expect(isPersonEntry({ dn: 'x', objectClass: ['top', 'group'] })).toBe(false);
    expect(isPersonEntry({ dn: 'x', objectClass: ['top', 'organizationalUnit'] })).toBe(false);
    expect(isPersonEntry({ dn: 'x', objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'] })).toBe(false);
    expect(isPersonEntry({ dn: 'x', objectClass: ['top', 'person', 'organizationalPerson', 'user'] })).toBe(true);
    expect(isAccountDisabled({ dn: 'x', userAccountControl: '514' })).toBe(true);
    expect(isAccountDisabled({ dn: 'x', userAccountControl: '512' })).toBe(false);
  });

  it('reconhece JPEG e PNG; o resto não', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
  });

  it('não passa por cima da foto escolhida pela pessoa', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    expect(planLdapAvatar({ avatar_etag: null }, jpeg).action).toBe('apply');
    expect(planLdapAvatar({ avatar_etag: 'meu', ldap_avatar_etag: 'ldap', ldap_avatar_hash: 'velho' }, jpeg).action).toBe('none');
    expect(planLdapAvatar({ avatar_etag: 'ldap', ldap_avatar_etag: 'ldap', ldap_avatar_hash: 'velho' }, jpeg).action).toBe('apply');
    expect(planLdapAvatar({ avatar_etag: 'ldap', ldap_avatar_etag: 'ldap' }, null).action).toBe('reset');
    expect(planLdapAvatar({ avatar_etag: 'meu', ldap_avatar_etag: 'ldap' }, null).action).toBe('none');
  });
});
