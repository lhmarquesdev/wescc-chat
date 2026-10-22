import { dnIsUnder, normalizeDn, parseLdapKey, type LdapGroupRef, type LdapRuleKey } from '@shared/ldap';

// Regras puras do mapeamento LDAP → papéis, canais e times (sem banco de dados).

const CHAIN_RULE = '1.2.840.113556.1.4.1941'; // LDAP_MATCHING_RULE_IN_CHAIN do Active Directory

export const usesNestedGroups = (filter: string) => /member:1\.2\.840\.113556\.1\.4\.1941:=/i.test(filter);

// Troca (member=#{userdn}) pela regra em cadeia, que devolve também os grupos dos grupos do usuário.
// applied também vale quando o filtro já usa a regra em cadeia.
export function applyNestedGroups(filter: string): { filter: string; applied: boolean } {
  let replaced = false;
  const out = filter.replace(/\(\s*member\s*=\s*#\{userdn\}\s*\)/gi, () => {
    replaced = true;
    return `(member:${CHAIN_RULE}:=#{userdn})`;
  });
  return { filter: out, applied: replaced || usesNestedGroups(out) };
}

export interface LdapMaps {
  roleMap: Record<string, string[]>;
  channelMap: Record<string, string[]>;
  teamMap: Record<string, string[]>;
}

const hasName = (g: LdapGroupRef, name: string) => g.cn.toLowerCase() === name.toLowerCase() || g.sAMAccountName?.toLowerCase() === name.toLowerCase();

export function ruleMatches(rule: LdapRuleKey, userDn: string, groups: LdapGroupRef[]): boolean {
  if (rule.kind === 'all') return true;
  if (rule.kind === 'ou') return dnIsUnder(userDn, rule.value);
  const dn = normalizeDn(rule.value);
  if (rule.kind === 'group-dn') return groups.some((g) => normalizeDn(g.dn) === dn);
  return groups.some((g) => hasName(g, rule.value) || normalizeDn(g.dn) === dn);
}

// Chaves da união dos três mapas, na ordem papéis → canais → times.
const mapKeys = (maps: LdapMaps) => [...new Set([...Object.keys(maps.roleMap), ...Object.keys(maps.channelMap), ...Object.keys(maps.teamMap)])].map(parseLdapKey);

// Chaves que valem para o usuário.
export function matchKeys(maps: LdapMaps, userDn: string, groups: LdapGroupRef[]): LdapRuleKey[] {
  return mapKeys(maps).filter((k) => k.value && ruleMatches(k, userDn, groups));
}

// Nomes de grupo usados nas chaves sem DN ("GG-Admins" ou "group:GG-Admins").
export function groupNames(maps: LdapMaps): string[] {
  const seen = new Map<string, string>();
  for (const k of mapKeys(maps)) if (k.kind === 'group' && k.value && !seen.has(k.value.toLowerCase())) seen.set(k.value.toLowerCase(), k.value);
  return [...seen.values()];
}

export interface AmbiguousKey {
  key: string;
  dns: string[];
}

// Chaves por nome que servem para mais de um grupo do diretório. No AD o cn só é único dentro da OU: quem pode criar
// grupos em outra OU criaria um "GG-Wescc-Admins" com o mesmo cn e ganharia o papel da regra.
export function ambiguousKeys(maps: LdapMaps, directoryGroups: LdapGroupRef[]): AmbiguousKey[] {
  const out: AmbiguousKey[] = [];
  for (const k of mapKeys(maps)) {
    if (k.kind !== 'group' || !k.value) continue;
    const dns = new Map<string, string>();
    for (const g of directoryGroups) if (hasName(g, k.value) && !dns.has(normalizeDn(g.dn))) dns.set(normalizeDn(g.dn), g.dn);
    if (dns.size > 1) out.push({ key: k.key, dns: [...dns.values()] });
  }
  return out;
}

// A primeira chave ambígua que valeria para algum grupo do usuário pelo nome.
export function ambiguousMatch(ambiguous: AmbiguousKey[], groups: LdapGroupRef[]): AmbiguousKey | undefined {
  return ambiguous.find((a) => groups.some((g) => hasName(g, parseLdapKey(a.key).value)));
}

const unique = (list: string[]) => [...new Set(list)];

export interface RolePlanInput {
  current: string[];
  matchedKeys: string[];
  roleMap: Record<string, string[]>;
  defaultRoles: string[];
  skipRestricted: boolean;
  autoRemove: boolean;
  roleScopes: Map<string, string>; // papéis que existem → escopo
  restrictedRoles: string[];
  lastActiveAdmin: boolean; // o usuário é o último administrador ativo
  username?: string;
}

export interface RolePlan {
  next: string[];
  added: string[];
  removed: string[];
  mapped: string[];
  defaults: string[];
  changed: boolean;
  warnings: string[];
}

export function planRoles(i: RolePlanInput): RolePlan {
  const warnings: string[] = [];
  const isGlobal = (r: string) => i.roleScopes.get(r) === 'Users';
  const wanted = unique(i.matchedKeys.flatMap((k) => i.roleMap[k] ?? []));
  for (const r of wanted) if (!isGlobal(r)) warnings.push(`Papel "${r}" do mapeamento não existe ou não é global.`);
  const defaults = unique(i.defaultRoles);
  for (const r of defaults) if (!isGlobal(r)) warnings.push(`Papel padrão "${r}" não existe ou não é global.`);
  let mapped = wanted.filter(isGlobal);
  const validDefaults = defaults.filter(isGlobal);
  // Quem recebe um papel restrito não ganha os padrões (normalmente "user", que libera grupos privados e times).
  if (!(i.skipRestricted && mapped.some((r) => i.restrictedRoles.includes(r)))) mapped = unique([...mapped, ...validDefaults]);
  const managed = new Set([...Object.values(i.roleMap).flat().filter(isGlobal), ...validDefaults]);
  let next = i.autoRemove ? unique([...i.current.filter((r) => !managed.has(r)), ...mapped]) : unique([...i.current, ...mapped]);
  if (i.current.includes('admin') && !next.includes('admin') && i.lastActiveAdmin) {
    next = [...next, 'admin'];
    warnings.push(`${i.username ? `@${i.username}` : 'O usuário'} é o último administrador ativo e continua com o papel admin.`);
  }
  const added = next.filter((r) => !i.current.includes(r));
  const removed = i.current.filter((r) => !next.includes(r));
  return { next, added, removed, mapped, defaults: validDefaults, changed: added.length > 0 || removed.length > 0, warnings };
}

// Canal ou time do mapa já resolvido no banco (id null: não existe).
export interface MembershipTarget {
  name: string;
  id: string | null;
}

export interface MembershipInput {
  desired: string[]; // nomes que o usuário deve ter (das chaves que valem para ele)
  managed: MembershipTarget[]; // todos os nomes do mapa
  memberOf: Set<string>; // ids em que o usuário já está
  protectedIds: Set<string>; // ids em que o usuário tem papel na sala (dono, moderador, líder, publicador)
  autoRemove: boolean;
  active: boolean; // inativos não entram em nada, mas ainda saem
}

export interface MembershipPlan {
  join: MembershipTarget[];
  leave: MembershipTarget[];
  missing: string[]; // desejados que não existem
  kept: MembershipTarget[]; // mapeados que o usuário deixaria, mantidos por ter papel na sala
}

export function planMembership(i: MembershipInput): MembershipPlan {
  const byName = new Map(i.managed.map((t) => [t.name.toLowerCase(), t]));
  const desired = new Set(i.desired.map((n) => n.toLowerCase()));
  const join: MembershipTarget[] = [];
  const missing: string[] = [];
  if (i.active) {
    for (const name of desired) {
      const t = byName.get(name);
      if (!t?.id) missing.push(t?.name ?? name);
      else if (!i.memberOf.has(t.id)) join.push(t);
    }
  }
  const leave: MembershipTarget[] = [];
  const kept: MembershipTarget[] = [];
  if (i.autoRemove) {
    for (const t of i.managed) {
      if (!t.id || desired.has(t.name.toLowerCase()) || !i.memberOf.has(t.id)) continue;
      (i.protectedIds.has(t.id) ? kept : leave).push(t);
    }
  }
  return { join, leave, missing, kept };
}
