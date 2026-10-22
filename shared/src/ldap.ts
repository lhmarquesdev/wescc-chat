// Tipos e regras puras da integração LDAP / Active Directory (servidor e tela de administração).
import type { UserRef } from './index';

export type LdapRuleKind = 'all' | 'group' | 'group-dn' | 'ou';
export interface LdapRuleKey { key: string; kind: LdapRuleKind; value: string }
export interface LdapGroupRef { dn: string; cn: string; sAMAccountName?: string }

// Chaves dos mapas LDAP_Role_Mapping, LDAP_Channel_Mapping e LDAP_Team_Mapping:
//   "*"              todos os usuários sincronizados
//   "ou:<DN da OU>"  quem está dentro da OU, em qualquer nível abaixo dela
//   "group:<DN>"     membros do grupo com esse DN
//   "group:<nome>"   membros do grupo com esse cn ou sAMAccountName
//   "<nome>"         formato antigo, igual a "group:<nome>" (um texto com "=" é tratado como DN)
// `key` volta como veio, para achar a entrada no mapa; `value` vem sem espaços nas pontas.
export function parseLdapKey(key: string): LdapRuleKey {
  const k = key.trim();
  if (k === '*') return { key, kind: 'all', value: '*' };
  const prefix = /^(ou|group):/i.exec(k);
  const value = prefix ? k.slice(prefix[0].length).trim() : k;
  if (prefix?.[1].toLowerCase() === 'ou') return { key, kind: 'ou', value };
  return { key, kind: value.includes('=') ? 'group-dn' : 'group', value };
}

// Divide nos separadores que não estão escapados (\,) nem entre aspas.
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// Tira espaços das pontas sem comer um espaço final escapado ("CN=x\ ").
function trimDnPart(s: string): string {
  const t = s.trimStart();
  let end = t.length;
  while (end > 0 && /\s/.test(t[end - 1])) {
    let slashes = 0;
    for (let j = end - 2; j >= 0 && t[j] === '\\'; j--) slashes++;
    if (slashes % 2) break;
    end--;
  }
  return t.slice(0, end);
}

// Valor de um RDN sem escapes: "\," vira ",", "\C3\A3" vira "ã", "\"x\"" perde as aspas.
function unescapeValue(raw: string): string {
  const s = trimDnPart(raw);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  let out = '';
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes = [];
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      flush();
      out += s[++i];
      continue;
    }
    flush();
    out += s[i];
  }
  flush();
  return out;
}

// Forma canônica (RFC 4514) para comparar DNs escritos de jeitos diferentes.
const escapeValue = (v: string) => v.replace(/[,+"\\<>;]/g, '\\$&').replace(/^[ #]/, '\\$&').replace(/ $/, '\\ ');

function normalizeAva(ava: string): string {
  const i = ava.indexOf('=');
  if (i < 0) return escapeValue(unescapeValue(ava)).toLowerCase();
  return `${ava.slice(0, i).trim().toLowerCase()}=${escapeValue(unescapeValue(ava.slice(i + 1))).toLowerCase()}`;
}

const normalizeRdn = (rdn: string) => splitUnescaped(rdn, '+').map(normalizeAva).sort().join('+');

// RDNs, respeitando "\," e "\\" (ex.: "CN=Silva\, João,OU=SAC,...")
export function splitDn(dn: string): string[] {
  return splitUnescaped(String(dn ?? ''), ',').map(trimDnPart).filter(Boolean);
}

// RDNs sem espaços nas pontas, tipo e valor em minúsculas, unidos por ","
export function normalizeDn(dn: string): string {
  return splitDn(dn).map(normalizeRdn).join(',');
}

// dn é descendente estrito de baseDn (casamento por RDN inteiro)
export function dnIsUnder(dn: string, baseDn: string): boolean {
  const d = splitDn(dn).map(normalizeRdn);
  const b = splitDn(baseDn).map(normalizeRdn);
  if (!b.length || d.length <= b.length) return false;
  const offset = d.length - b.length;
  return b.every((x, i) => x === d[offset + i]);
}

// "OU=SAC" -> "SAC" (sem escapes). Recebendo um DN inteiro, usa o primeiro RDN.
export function rdnValue(rdn: string): string {
  const first = splitDn(rdn)[0] ?? '';
  const i = first.indexOf('=');
  return unescapeValue(i < 0 ? first : first.slice(i + 1));
}

// "OU=SAC,OU=Operacao,OU=Explorer,DC=..." -> "SAC › Operacao › Explorer"
export function ouLabel(dn: string): string {
  const rdns = splitDn(dn);
  const parts = rdns.filter((r) => !/^dc\s*=/i.test(r)).map(rdnValue);
  return parts.length ? parts.join(' › ') : rdns.map(rdnValue).join('.');
}

export const LDAP_SYNC_PRESETS: { cron: string; label: string }[] = [
  { cron: '*/5 * * * *', label: 'A cada 5 minutos' },
  { cron: '*/15 * * * *', label: 'A cada 15 minutos' },
  { cron: '*/30 * * * *', label: 'A cada 30 minutos' },
  { cron: '0 * * * *', label: 'A cada hora' },
  { cron: '0 */6 * * *', label: 'A cada 6 horas' },
  { cron: '0 0 * * *', label: 'Todo dia à meia-noite' },
];

// preset -> label; vazio -> 'Desligada'; outro -> `Personalizado: ${expr}`
export function cronLabel(expr: string): string {
  const e = String(expr ?? '').trim().replace(/\s+/g, ' ');
  if (!e) return 'Desligada';
  return LDAP_SYNC_PRESETS.find((p) => p.cron === e)?.label ?? `Personalizado: ${e}`;
}

// Valores do botão "Usar padrões do Active Directory".
export const LDAP_AD_PRESET: Record<string, string | boolean> = {
  LDAP_User_Search_Filter: '(&(objectCategory=person)(objectClass=user))',
  LDAP_User_Search_Field: 'sAMAccountName,userPrincipalName',
  LDAP_Username_Field: 'sAMAccountName',
  LDAP_Name_Field: 'displayName,cn',
  LDAP_Email_Field: 'mail,userPrincipalName',
  LDAP_Unique_Identifier_Field: 'objectGUID',
  LDAP_Group_Filter: '(&(objectCategory=group)(member=#{userdn}))',
  LDAP_Group_Nested: true,
  LDAP_Avatar_Field: 'thumbnailPhoto,jpegPhoto',
  LDAP_Sync_AD_Disabled: true,
};

export interface LdapSyncCounts {
  seen: number; imported: number; updated: number; changed: number; deactivated: number; reactivated: number;
  skipped: number; errors: number; avatars: number; rolesChanged: number;
  channelsAdded: number; channelsRemoved: number; teamsAdded: number; teamsRemoved: number;
}
export type LdapSyncChangeKind = 'created' | 'profile' | 'roles' | 'channels' | 'teams' | 'avatar' | 'deactivated' | 'reactivated';
export interface LdapSyncChange { username: string; kind: LdapSyncChangeKind; detail: string }
export interface LdapSyncIssue { login?: string; dn?: string; message: string }
export type LdapRunStatus = 'running' | 'success' | 'partial' | 'failed';
export interface LdapSyncRun {
  _id: string;
  trigger: 'cron' | 'manual' | 'api';
  status: LdapRunStatus;
  startedBy: UserRef | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  counts: LdapSyncCounts;
  error: string | null;
  changesCount: number;
  errorsCount: number;
  warningsCount: number;
  changes?: LdapSyncChange[]; // só em ldap.sync.run
  errors?: LdapSyncIssue[];
  warnings?: string[];
}
export interface LdapStatus {
  enabled: boolean;
  background: { enabled: boolean; expression: string; valid: boolean; label: string };
  running: LdapSyncRun | null;
  lastRun: LdapSyncRun | null;
  users: { total: number; active: number; deactivatedBySync: number };
}
export interface LdapDirectoryItem { dn: string; name: string; kind: 'group' | 'ou'; description?: string }
export interface LdapMappingTest {
  login: string;
  found: boolean;
  message?: string; // quando não achou ou achou mais de uma entrada
  entry?: { dn: string; parentDn: string; username: string; name: string; email: string | null; uid: string; guid?: string; disabled: boolean; photo?: string };
  groups: LdapGroupRef[];
  groupError?: string;
  nestedApplied: boolean;
  matched: { key: string; kind: LdapRuleKind; roles: string[]; channels: string[]; teams: string[] }[];
  account: { exists: boolean; userId?: string; username?: string; active?: boolean; action: 'create' | 'update' | 'skip' | 'conflict'; activeAfter: boolean; note?: string };
  roles: { before: string[]; after: string[]; added: string[]; removed: string[] };
  channels: { join: string[]; leave: string[]; create: string[] };
  teams: { join: string[]; leave: string[]; missing: string[] };
  direct: { restricted: boolean; exempt: boolean };
  warnings: string[];
}
