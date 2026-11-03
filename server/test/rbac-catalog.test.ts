import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECT_LOOPHOLES } from '@shared/direct';
import {
  applyDelta,
  AREA_GROUP,
  areaLevel,
  diffPermissions,
  effectiveAccess,
  grantContextFor,
  isRoomChecked,
  KEY_AREA,
  keyMatches,
  keysNotHeld,
  planNewKeys,
  RBAC_AREAS,
  RBAC_GROUPS,
  RBAC_KEYS,
  RBAC_TEMPLATES,
  roleDeleteLock,
  roleLock,
  ROOT_KEEP,
  sensitiveAdded,
  templatePlan,
  userLock,
  VISIBLE_KEYS,
  whoCanRoles,
  withAreaLevel,
  type RoleInfo,
} from '@shared/rbac';
import { foldText } from '@shared/search';
import { DEFAULT_PERMISSIONS } from '../src/services/permissions';

// O catálogo único de permissões (shared/rbac.ts): cada chave com nome, numa área só, e nenhuma "decorativa".
const root = path.resolve(import.meta.dirname, '../..');

describe('catálogo de permissões', () => {
  it('toda chave tem nome em português, e os nomes não se repetem', () => {
    const labels = Object.values(RBAC_KEYS).map((k) => k.label);
    expect(Object.entries(RBAC_KEYS).filter(([, k]) => !k.label.trim())).toEqual([]);
    expect(labels.filter((n, i) => labels.indexOf(n) !== i)).toEqual([]);
  });

  it('o seed sai do catálogo', () => {
    expect(DEFAULT_PERMISSIONS.map(([id]) => id).sort()).toEqual(Object.keys(RBAC_KEYS).sort());
  });

  it('toda chave visível está em exatamente uma área, e a área só usa chaves do catálogo', () => {
    const seen = new Map<string, number>();
    for (const a of RBAC_AREAS) for (const k of [...a.levels.flatMap((l) => l.keys), ...a.extras]) seen.set(k, (seen.get(k) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
    expect([...seen.keys()].filter((k) => !RBAC_KEYS[k])).toEqual([]);
    const hidden = Object.entries(RBAC_KEYS).filter(([k, d]) => !d.legacy && !seen.has(k)).map(([k]) => k);
    expect(hidden).toEqual([]);
    expect(VISIBLE_KEYS.filter((k) => RBAC_KEYS[k].legacy)).toEqual([]);
  });

  // Varredura: chave sem rota que a verifique engana quem configura. As legadas ficam escondidas na tela.
  const used = (key: string) => {
    const out = execSync(`grep -rlF "'${key}'" server/src web/src --include=*.ts --include=*.tsx || true`, { cwd: root }).toString();
    return out.split('\n').filter((f) => f && !f.includes('services/permissions.ts'));
  };

  it('toda chave visível é checada em algum lugar do código', () => {
    const decorative = VISIBLE_KEYS.filter((k) => !used(k).length);
    expect(decorative).toEqual([]);
  });

  it('nenhuma chave legada é checada (se passar a ser, deixa de ser legada)', () => {
    const legacy = Object.entries(RBAC_KEYS).filter(([, d]) => d.legacy).map(([k]) => k);
    expect(legacy.filter((k) => used(k).length)).toEqual([]);
  });

  it('toda permissão que o código checa está no catálogo', () => {
    const out = execSync(
      `grep -rhoE "(hasPermission|hasAnyPermission|usePermission|rolesHavePermission)\\([^)]*'[a-z0-9-]+'|permissions: \\[[^]]*\\]" server/src web/src --include=*.ts --include=*.tsx || true`,
      { cwd: root },
    ).toString();
    const keys = new Set([...out.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]));
    const unknown = [...keys].filter((k) => !RBAC_KEYS[k] && !/^(user|admin|bot|guest|owner|moderator|leader)$/.test(k));
    expect(unknown).toEqual([]);
  });
});

const area = (id: string) => RBAC_AREAS.find((a) => a.id === id)!;

describe('nível de uma área', () => {
  const users = area('admin-users');
  it('Sem acesso, Visualizar, Gerenciar e Personalizado', () => {
    expect(areaLevel(users, [])).toEqual({ kind: 'none' });
    expect(areaLevel(users, ['view-user-administration'])).toEqual({ kind: 'level', index: 0 });
    expect(areaLevel(users, ['view-user-administration', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status'])).toEqual({ kind: 'level', index: 1 });
    // Capacidade avulsa não muda o nível.
    expect(areaLevel(users, ['view-user-administration', 'delete-user'])).toEqual({ kind: 'level', index: 0 });
    // Só parte do Gerenciar, ou Gerenciar sem Visualizar: personalizado.
    expect(areaLevel(users, ['view-user-administration', 'create-user'])).toEqual({ kind: 'custom' });
    expect(areaLevel(users, ['create-user', 'edit-other-user-info', 'edit-other-user-active-status'])).toEqual({ kind: 'custom' });
  });
  it('escolher um nível troca só as chaves dos níveis', () => {
    const start = new Set(['delete-user', 'create-user']);
    expect([...withAreaLevel(users, start, 0)].sort()).toEqual(['delete-user', 'view-user-administration']);
    expect([...withAreaLevel(users, start, -1)]).toEqual(['delete-user']);
    expect(areaLevel(users, withAreaLevel(users, start, 1))).toEqual({ kind: 'level', index: 1 });
  });
});

const R = (id: string, permissions: string[], over: Partial<RoleInfo> = {}): RoleInfo => ({ id, scope: 'Users', protected: false, root: false, permissions, delegable: [], ...over });

describe('hierarquia de concessão', () => {
  const admin = R('admin', ['manage-roles', 'can-audit', 'create-c'], { root: true, protected: true });
  const user = R('user', ['create-c']);
  const supervisor = R('supervisor', ['manage-roles', 'edit-other-user-info'], { delegable: ['auditor'] });
  const auditor = R('auditor', ['can-audit']);
  const operador = R('operador', ['can-audit', 'create-c']);
  const leitor = R('leitor', ['create-c']);
  const roles = [admin, user, supervisor, auditor, operador, leitor];
  const sup = grantContextFor('s1', ['user', 'supervisor'], roles);
  const adm = grantContextFor('a1', ['admin'], roles);

  it('o ator junta as permissões dos papéis globais e as delegações', () => {
    expect(sup.root).toBe(false);
    expect(sup.held).toEqual(['create-c', 'edit-other-user-info', 'manage-roles']);
    expect(sup.delegated).toEqual(['auditor']);
    expect(adm.root).toBe(true);
  });

  it('papel gerenciável: cabe no que o ator tem ou foi delegado; o Administrador só o raiz', () => {
    expect(roleLock(sup, user)).toBeNull();
    expect(roleLock(sup, auditor)).toBeNull(); // delegado
    expect(roleLock(sup, operador)).toBe('superior');
    expect(roleLock(sup, admin)).toBe('root-only');
    expect(roleLock(adm, admin)).toBeNull();
  });

  it('excluir pede caber no que o ator tem: delegação não basta, nem papel próprio', () => {
    expect(roleDeleteLock(sup, auditor)).toBe('superior');
    expect(roleDeleteLock(sup, supervisor)).toBe('own-role');
    expect(roleDeleteLock(sup, leitor)).toBeNull();
    expect(roleDeleteLock(adm, admin)).toBe('protected');
  });

  it('só dá ou tira a permissão que tem', () => {
    expect(keysNotHeld(sup, ['create-c'], ['create-c', 'can-audit'])).toEqual(['can-audit']);
    expect(keysNotHeld(sup, ['can-audit', 'create-c'], ['create-c'])).toEqual(['can-audit']);
    expect(keysNotHeld(sup, ['create-c'], ['manage-roles'])).toEqual([]);
    expect(keysNotHeld(adm, [], ['qualquer-uma'])).toEqual([]);
  });

  it('pessoa gerenciável: nunca a própria, e todos os papéis dela gerenciáveis', () => {
    expect(userLock(sup, 's1', ['user', 'supervisor'], roles)).toBe('self');
    expect(userLock(sup, 'u2', ['user', 'auditor'], roles)).toBeNull();
    expect(userLock(sup, 'u3', ['user', 'operador'], roles)).toBe('superior');
    expect(userLock(sup, 'u4', ['admin'], roles)).toBe('root-only');
    expect(userLock(adm, 'a1', ['admin'], roles)).toBeNull();
  });

  it('delegação nunca inclui o Administrador', () => {
    const g = grantContextFor('x', ['supervisor'], [admin, R('supervisor', [], { delegable: ['admin'] })]);
    expect(g.delegated).toEqual([]);
  });
});

describe('acesso efetivo e revisão', () => {
  it('mostra a área com o nível e de qual papel veio cada permissão', () => {
    const roles = [R('user', ['create-c', 'view-c-room']), R('gestor', ['view-user-administration', 'view-c-room'])];
    const eff = effectiveAccess(['user', 'gestor'], roles);
    const channels = eff.find((e) => e.area === 'channels')!;
    expect(channels.level).toEqual({ kind: 'custom' });
    expect(channels.keys).toEqual([
      { key: 'view-c-room', via: ['user', 'gestor'] },
      { key: 'create-c', via: ['user'] },
    ]);
    expect(eff.find((e) => e.area === 'admin-users')!.level).toEqual({ kind: 'level', index: 0 });
  });

  it('a revisão agrupa por área, diz se ampliou ou reduziu, e separa o que não é de área', () => {
    const d = diffPermissions(['view-c-room', 'x-legacy'], ['view-c-room', 'create-c', 'create-p', 'view-statistics']);
    expect(d.areas.map((a) => [a.area, a.direction])).toEqual([
      ['channels', 'up'],
      ['admin-info', 'up'],
    ]);
    expect(d.areas[0].after).toEqual({ kind: 'level', index: 1 });
    expect(d.other).toEqual({ added: [], removed: ['x-legacy'] });
  });
});

describe('nascimento de chaves novas', () => {
  const all = Object.keys(RBAC_KEYS);
  it('instalação nova: os papéis padrão', () => {
    const plan = planNewKeys(new Map(), ['admin', 'user', 'manager'], true);
    expect(plan.get('view-permissions')).toEqual(['admin']);
    expect(plan.get('create-c')).toEqual(['admin', 'user']);
  });
  it('instalação existente: a chave nova nasce com quem tinha a mãe, e chave existente não é tocada', () => {
    const existing = new Map(all.filter((k) => k !== 'view-permissions').map((k) => [k, k === 'manage-roles' ? ['admin', 'gestor'] : ['admin']]));
    const plan = planNewKeys(existing, ['admin', 'gestor'], false);
    expect([...plan.keys()]).toEqual(['view-permissions']);
    expect(plan.get('view-permissions')).toEqual(['admin', 'gestor']);
  });
});

describe('catálogo v2: descrição, sensível e sala', () => {
  it('toda chave visível tem uma descrição simples de uma frase, terminando em ponto', () => {
    const bad = VISIBLE_KEYS.filter((k) => {
      const d = RBAC_KEYS[k].description?.trim() ?? '';
      return !d || d.length > 200 || !d.endsWith('.');
    });
    expect(bad).toEqual([]);
  });

  it('todo aviso de chave sensível é uma frase terminando em ponto', () => {
    const bad = Object.entries(RBAC_KEYS).filter(([, d]) => d.sensitive !== undefined && (!d.sensitive.trim() || !d.sensitive.trim().endsWith('.')));
    expect(bad.map(([k]) => k)).toEqual([]);
    for (const k of ['can-audit', 'assign-roles', 'assign-admin-role', 'start-dm-between-restricted', 'delete-user']) expect(RBAC_KEYS[k].sensitive, k).toBeTruthy();
  });

  it('o Administrador nunca perde a gestão de papéis nem a de dar papéis', () => {
    expect(ROOT_KEEP.filter((k) => !RBAC_KEYS[k])).toEqual([]);
    expect(ROOT_KEEP).toContain('assign-roles');
  });

  it('chaves do grupo de salas são de sala; a marca room só aparece fora dele', () => {
    const roomGroup = RBAC_GROUPS.find((g) => g.id === 'room')!;
    const roomKeys = roomGroup.areas.flatMap((a) => [...a.levels.flatMap((l) => l.keys), ...a.extras]);
    expect(roomKeys.filter((k) => !isRoomChecked(k))).toEqual([]);
    expect(Object.entries(RBAC_KEYS).filter(([k, d]) => d.room && AREA_GROUP[KEY_AREA[k]] === 'room').map(([k]) => k)).toEqual([]);
    expect(isRoomChecked('mention-all')).toBe(true);
    expect(isRoomChecked('can-audit')).toBe(false);
  });

  it('assign-roles nasce com quem já dava papéis e fica primeiro nos extras de Usuários', () => {
    expect(RBAC_KEYS['assign-roles']).toMatchObject({ label: 'Dar e tirar papéis de pessoas', defaults: ['admin'], inheritsFrom: ['edit-other-user-info', 'access-permissions', 'manage-roles'] });
    expect(RBAC_AREAS.find((a) => a.id === 'admin-users')!.extras[0]).toBe('assign-roles');
  });
});

describe('modelos de papel', () => {
  it('só chaves visíveis, ids únicos', () => {
    const ids = RBAC_TEMPLATES.map((t) => t.id);
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([]);
    for (const t of RBAC_TEMPLATES) expect(t.keys.filter((k) => !VISIBLE_KEYS.includes(k)), t.id).toEqual([]);
    for (const t of RBAC_TEMPLATES) expect(t.description.trim().endsWith('.'), t.id).toBe(true);
  });

  it('o Operador é restrito e não leva nenhuma brecha de conversa particular', () => {
    const op = RBAC_TEMPLATES.find((t) => t.id === 'operador')!;
    expect(op.restrictDirect).toBe(true);
    expect(op.keys.filter((k) => DIRECT_LOOPHOLES.includes(k))).toEqual([]);
    expect(op.keys).toContain('view-c-room');
  });

  it('modelo com chave sensível exige 2FA', () => {
    for (const t of RBAC_TEMPLATES) if (t.keys.some((k) => RBAC_KEYS[k].sensitive)) expect(t.mandatory2fa, t.id).toBe(true);
    expect(RBAC_TEMPLATES.filter((t) => t.mandatory2fa).map((t) => t.id).sort()).toEqual(['auditor-mensagens', 'gestor-pessoas', 'supervisor-operacao']);
  });

  it('templatePlan: quem não é raiz leva só o que tem e não define delegação', () => {
    const sup = RBAC_TEMPLATES.find((t) => t.id === 'supervisor-operacao')!;
    const roles = [R('admin', [], { root: true }), R('operacao', ['view-c-room']), R('owner', [], { scope: 'Subscriptions' })];
    const rootCtx = grantContextFor('a', ['admin'], roles);
    expect(templatePlan(sup, rootCtx, roles)).toEqual({ keys: sup.keys, stripped: [], delegable: ['operacao'], delegationSkipped: [] });
    const g = grantContextFor('s', ['gestor'], [...roles, R('gestor', ['view-c-room', 'create-user'])]);
    const plan = templatePlan(sup, g, roles);
    expect(plan.keys).toEqual(['view-c-room', 'create-user']);
    expect(plan.stripped).toHaveLength(sup.keys.length - 2);
    expect(plan.delegable).toEqual([]);
    expect(plan.delegationSkipped).toEqual(['operacao']);
    // Papel que não existe, de sala ou raiz nunca entra na delegação.
    const odd = { ...sup, delegable: ['nao-existe', 'owner', 'admin', 'operacao'] };
    expect(templatePlan(odd, rootCtx, roles).delegable).toEqual(['operacao']);
  });
});

describe('funções puras v2', () => {
  it('applyDelta aplica só o que a tela mudou sobre o estado atual', () => {
    // Outra pessoa acrescentou create-p; a tela (base sem ele) acrescentou create-c e tirou mention-all.
    expect(applyDelta(['view-c-room', 'mention-all', 'create-p'], ['view-c-room', 'mention-all'], ['view-c-room', 'create-c'])).toEqual(['create-c', 'create-p', 'view-c-room']);
    // Chave que a tela não conhece (base sem ela) fica.
    expect(applyDelta(['x-nova', 'a'], ['a'], ['a'])).toEqual(['a', 'x-nova']);
    expect(applyDelta([], [], [])).toEqual([]);
  });

  it('whoCanRoles separa globais, de sala e de sala sem efeito', () => {
    const roles = [R('admin', ['delete-message', 'can-audit'], { root: true }), R('owner', ['delete-message', 'can-audit'], { scope: 'Subscriptions' }), R('user', [])];
    expect(whoCanRoles('delete-message', roles)).toEqual({ global: ['admin'], room: ['owner'], inert: [] });
    expect(whoCanRoles('can-audit', roles)).toEqual({ global: ['admin'], room: [], inert: ['owner'] });
    expect(whoCanRoles('create-c', roles)).toEqual({ global: [], room: [], inert: [] });
  });

  it('sensitiveAdded: só as sensíveis que entram, na ordem do catálogo', () => {
    expect(sensitiveAdded(['view-c-room'], ['view-c-room', 'can-audit', 'create-c', 'assign-roles'])).toEqual(['assign-roles', 'can-audit']);
    expect(sensitiveAdded(['can-audit'], ['can-audit'])).toEqual([]);
  });

  it('busca sem acento por nome, descrição, id, área e grupo', () => {
    expect(foldText('Permissão É')).toBe('permissao e');
    expect(keyMatches('edit-other-user-password', 'senha')).toBe(true);
    expect(keyMatches('delete-message', 'apagar mensagens de outras')).toBe(true);
    expect(keyMatches('can-audit', 'auditoria')).toBe(true);
    expect(keyMatches('can-audit', 'administracao')).toBe(true);
    expect(keyMatches('create-c', 'can-audit')).toBe(false);
    expect(keyMatches('create-c', '')).toBe(true);
  });
});
