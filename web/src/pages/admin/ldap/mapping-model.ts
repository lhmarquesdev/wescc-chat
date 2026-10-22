// Modelo do editor visual dos mapas LDAP (papéis, canais e times). Puro: sem React e sem rede.
import { normalizeDn, ouLabel, parseLdapKey, rdnValue, type LdapRuleKind } from '@shared/ldap';

export type MapId = 'role' | 'channel' | 'team';
export const MAP_IDS: MapId[] = ['role', 'channel', 'team'];
export const MAP_SETTING: Record<MapId, string> = { role: 'LDAP_Role_Mapping', channel: 'LDAP_Channel_Mapping', team: 'LDAP_Team_Mapping' };
export const MAP_TITLE: Record<MapId, string> = { role: 'Papéis', channel: 'Canais', team: 'Times' };

export interface MappingRow {
  key: string; // texto exato da chave no JSON
  roles: string[];
  channels: string[];
  teams: string[];
}
export type MapErrors = Partial<Record<MapId, string>>;
export type Maps = Record<MapId, Record<string, string[]>>;

const FIELD = { role: 'roles', channel: 'channels', team: 'teams' } as const;
export const rowValues = (row: MappingRow, id: MapId) => row[FIELD[id]];

function jsonError(e: unknown) {
  // Chrome e Firefox dizem "line X column Y"; o resto da mensagem vem em inglês.
  const m = /line (\d+) column (\d+)/i.exec(e instanceof Error ? e.message : '');
  return m ? `JSON inválido (linha ${m[1]}, coluna ${m[2]}).` : 'JSON inválido.';
}

// Mesmas regras (e textos) da validação do servidor: objeto, chaves não vazias, valor texto ou lista de textos.
// Uma lista vazia é aceita, mas não dá nada a ninguém: fica de fora do mapa (senão viraria uma regra em branco
// e a tela acharia que há alterações não salvas).
export function parseMap(json: string): { map: Record<string, string[]>; error?: undefined } | { map?: undefined; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(json.trim() || '{}');
  } catch (e) {
    return { error: jsonError(e) };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'O mapa deve ser um objeto JSON, por exemplo {"GG-Operacao": ["operacao"]}.' };
  const map: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!k.trim()) return { error: 'As chaves do mapa não podem ser vazias.' };
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x.trim())) return { error: `Valor inválido para a chave "${k}": use um texto ou uma lista de textos.` };
    if (list.length) map[k] = [...new Set(list.map((x: string) => x.trim()))];
  }
  return { map };
}

// Junta os três mapas em linhas. Ordem: chaves do mapa de papéis, depois as novas do de canais, depois as novas do de times.
export function rowsFromMaps(roleJson: string, channelJson: string, teamJson: string): { rows: MappingRow[]; errors: MapErrors } {
  const rows: MappingRow[] = [];
  const byKey = new Map<string, MappingRow>();
  const errors: MapErrors = {};
  const src: [MapId, string][] = [
    ['role', roleJson],
    ['channel', channelJson],
    ['team', teamJson],
  ];
  for (const [id, json] of src) {
    const r = parseMap(json);
    if (r.error !== undefined) {
      errors[id] = r.error;
      continue;
    }
    for (const [key, values] of Object.entries(r.map)) {
      let row = byKey.get(key);
      if (!row) {
        row = { key, roles: [], channels: [], teams: [] };
        byKey.set(key, row);
        rows.push(row);
      }
      row[FIELD[id]] = values;
    }
  }
  return { rows, errors };
}

// Três objetos "chave: lista", só com as listas que têm itens, na ordem das linhas.
export function mapsFromRows(rows: MappingRow[]): Maps {
  const out: Maps = { role: {}, channel: {}, team: {} };
  for (const row of rows) for (const id of MAP_IDS) if (rowValues(row, id).length) out[id][row.key] = [...rowValues(row, id)];
  return out;
}

export const mapJson = (map: Record<string, string[]>) => (Object.keys(map).length ? JSON.stringify(map, null, 2) : '{}');

export function jsonFromRows(rows: MappingRow[]): Record<MapId, string> {
  const m = mapsFromRows(rows);
  return { role: mapJson(m.role), channel: mapJson(m.channel), team: mapJson(m.team) };
}

// Forma estável de um mapa salvo, para saber se o que está na tela mudou. Espaços, quebras de linha e a ordem das
// chaves e dos itens não contam: a sincronização junta tudo o que vale para a pessoa, e o editor visual remonta os
// mapas na ordem das linhas (papéis primeiro), que pode não ser a do texto salvo.
export function canonicalMap(json: string): string {
  const r = parseMap(json);
  if (r.error !== undefined) return `!${json.trim()}`;
  return JSON.stringify(
    Object.keys(r.map)
      .sort()
      .map((k) => [k, [...r.map[k]].sort()]),
  );
}

export const mapHasRules = (json: string) => Object.keys(parseMap(json).map ?? {}).length > 0;

export interface Origin {
  kind: LdapRuleKind;
  value: string;
  icon: string;
  label: string; // sem o ícone
  title?: string; // DN completo
}

export function originOf(key: string): Origin {
  const k = parseLdapKey(key);
  if (k.kind === 'all') return { kind: 'all', value: '*', icon: '🌐', label: 'Todos os usuários' };
  if (k.kind === 'ou') return { kind: 'ou', value: k.value, icon: '📁', label: `OU ${ouLabel(k.value) || k.value}`, title: k.value };
  if (k.kind === 'group-dn') return { kind: 'group-dn', value: k.value, icon: '👥', label: `Grupo ${rdnValue(k.value) || k.value}`, title: k.value };
  return { kind: 'group', value: k.value, icon: '👥', label: `Grupo ${k.value}` };
}

// Duas chaves escritas de jeitos diferentes ("GG-X" e "group:gg-x") são a mesma origem.
export function sameOrigin(a: string, b: string): boolean {
  const x = parseLdapKey(a);
  const y = parseLdapKey(b);
  if (x.kind !== y.kind) return false;
  if (x.kind === 'all') return true;
  if (x.kind === 'group') return x.value.toLowerCase() === y.value.toLowerCase();
  return normalizeDn(x.value) === normalizeDn(y.value);
}

export type RuleTarget = 'group' | 'ou' | 'all';
export type GroupIdentity = 'cn' | 'dn';

// Chave gravada no mapa: "*", "ou:<DN>", "<nome>" ou "group:<DN>".
export function keyFor(target: RuleTarget, value: string, by: GroupIdentity): string {
  const v = value.trim();
  if (target === 'all') return '*';
  if (!v) return '';
  if (target === 'ou') return `ou:${v}`;
  return by === 'dn' ? `group:${v}` : v;
}

// Caminho inverso, para abrir uma regra existente no formulário.
export function targetOf(key: string): { target: RuleTarget; value: string; by: GroupIdentity } {
  const k = parseLdapKey(key);
  if (k.kind === 'all') return { target: 'all', value: '', by: 'cn' };
  if (k.kind === 'ou') return { target: 'ou', value: k.value, by: 'cn' };
  return { target: 'group', value: k.value, by: k.kind === 'group-dn' ? 'dn' : 'cn' };
}

export const channelName = (v: string) => v.trim().replace(/^#/, '');

// "a, b,c" <-> ["a", "b", "c"] (LDAP_Default_Roles).
export const splitList = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
