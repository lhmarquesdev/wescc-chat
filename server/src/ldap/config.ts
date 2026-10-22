import type { SettingType } from '@shared/index';
import { getSetting, listSettings } from '../services/settings';

// Foto tirada das configurações LDAP. Uma sincronização (ou uma prévia) lê tudo uma vez só: a execução fica
// coerente mesmo que alguém salve no meio, e a prévia usa valores não salvos sem tocar no cache global.
export interface LdapConfig {
  enabled: boolean;
  url: string;
  rejectUnauthorized: boolean;
  caPem: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  loginFields: string[];
  groupBaseDn: string;
  usernameFields: string[];
  nameFields: string[];
  emailFields: string[];
  uidFields: string[];
  loginFallback: boolean;
  mergeExisting: boolean;
  syncAvatar: boolean;
  avatarFields: string[];
  background: boolean;
  backgroundInterval: string;
  importNewUsers: boolean;
  syncActiveState: boolean;
  syncAdDisabled: boolean;
  reactivateUsers: boolean;
  maxDeactivationPercent: number;
  roleMapping: boolean;
  roleMap: Record<string, string[]>;
  groupFilter: string;
  groupNested: boolean;
  defaultRoles: string[];
  defaultRolesSkipRestricted: boolean;
  rolesAutoRemove: boolean;
  channelMapping: boolean;
  channelMap: Record<string, string[]>;
  channelsAutoRemove: boolean;
  channelsAdmin: string;
  teamMapping: boolean;
  teamMap: Record<string, string[]>;
  teamsAutoRemove: boolean;
  // Problemas da própria configuração (mapa com JSON inválido salvo antes da validação, por exemplo).
  warnings: string[];
}

export const splitList = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Valores aceitos: texto ou lista de textos; o resto é descartado.
export function parseLdapMap(raw: unknown): { map: Record<string, string[]>; error?: string } {
  let obj: unknown;
  try {
    obj = typeof raw === 'object' && raw !== null ? raw : JSON.parse(String(raw || '{}'));
  } catch {
    return { map: {}, error: 'JSON inválido' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { map: {}, error: 'não é um objeto JSON' };
  const map: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!k.trim()) continue;
    const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    map[k] = [...new Set(values)];
  }
  return { map };
}

function coerce(type: SettingType, v: unknown): unknown {
  if (type === 'boolean') return v === true || v === 'true';
  if (type === 'int') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return v == null ? '' : String(v);
}

// overrides: só ids LDAP_* conhecidos; '********' (senha mascarada na tela) mantém o valor salvo.
export function loadLdapConfig(overrides?: Record<string, unknown> | null): LdapConfig {
  const types = new Map(listSettings().filter((s) => s.group === 'LDAP').map((s) => [s._id, s.type]));
  const values = new Map<string, unknown>();
  for (const id of types.keys()) values.set(id, getSetting(id));
  for (const [id, v] of Object.entries(overrides ?? {})) {
    const type = types.get(id);
    if (!type || v === undefined || v === '********') continue;
    const c = coerce(type, v);
    if (c !== undefined) values.set(id, c);
  }
  const s = (id: string) => String(values.get(id) ?? '').trim();
  const on = (id: string) => values.get(id) === true || values.get(id) === 'true';
  const warnings: string[] = [];
  const map = (id: string, enabled: string) => {
    const r = parseLdapMap(values.get(id));
    if (r.error && on(enabled)) warnings.push(`O mapa ${id} foi ignorado: ${r.error}.`);
    return r.map;
  };
  const percent = Number(values.get('LDAP_Sync_Max_Deactivation_Percent'));
  return {
    enabled: on('LDAP_Enable'),
    url: s('LDAP_Url'),
    rejectUnauthorized: on('LDAP_Reject_Unauthorized'),
    caPem: s('LDAP_CA_Certificate'),
    bindDn: s('LDAP_Authentication_UserDN'),
    bindPassword: String(values.get('LDAP_Authentication_Password') ?? ''),
    baseDn: s('LDAP_BaseDN'),
    userFilter: s('LDAP_User_Search_Filter') || '(objectclass=*)',
    loginFields: splitList(values.get('LDAP_User_Search_Field')),
    groupBaseDn: s('LDAP_Group_BaseDN') || s('LDAP_BaseDN'),
    usernameFields: splitList(values.get('LDAP_Username_Field')),
    nameFields: splitList(values.get('LDAP_Name_Field')),
    emailFields: splitList(values.get('LDAP_Email_Field')),
    uidFields: splitList(values.get('LDAP_Unique_Identifier_Field')),
    loginFallback: on('LDAP_Login_Fallback'),
    mergeExisting: on('LDAP_Merge_Existing_Users'),
    syncAvatar: on('LDAP_Sync_Avatar'),
    avatarFields: splitList(values.get('LDAP_Avatar_Field')),
    background: on('LDAP_Background_Sync'),
    backgroundInterval: s('LDAP_Background_Sync_Interval'),
    importNewUsers: on('LDAP_Background_Sync_Import_New_Users'),
    syncActiveState: on('LDAP_Sync_User_Active_State'),
    syncAdDisabled: on('LDAP_Sync_AD_Disabled'),
    reactivateUsers: on('LDAP_Sync_Reactivate_Users'),
    maxDeactivationPercent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 50,
    roleMapping: on('LDAP_Enable_Role_Mapping'),
    roleMap: map('LDAP_Role_Mapping', 'LDAP_Enable_Role_Mapping'),
    groupFilter: s('LDAP_Group_Filter'),
    groupNested: on('LDAP_Group_Nested'),
    defaultRoles: [...new Set(splitList(values.get('LDAP_Default_Roles')))],
    defaultRolesSkipRestricted: on('LDAP_Default_Roles_Skip_Restricted'),
    rolesAutoRemove: on('LDAP_Roles_Auto_Remove'),
    channelMapping: on('LDAP_Enable_Channel_Mapping'),
    channelMap: map('LDAP_Channel_Mapping', 'LDAP_Enable_Channel_Mapping'),
    channelsAutoRemove: on('LDAP_Channels_Auto_Remove'),
    channelsAdmin: s('LDAP_Channels_Admin').replace(/^@/, ''),
    teamMapping: on('LDAP_Enable_Team_Mapping'),
    teamMap: map('LDAP_Team_Mapping', 'LDAP_Enable_Team_Mapping'),
    teamsAutoRemove: on('LDAP_Teams_Auto_Remove'),
    warnings,
  };
}
