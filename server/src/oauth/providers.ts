import type { OAuthFieldMap, OAuthMapping, OAuthPreset, OAuthProvider, OAuthProviderPublic, OAuthProviderType } from '@shared/index';
import { many, one, query } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { audit, type Actor } from '../services/audit';
import { siteUrl } from '../services/sso';

// Provedores de login OAuth 2.0 / OpenID Connect guardados no PostgreSQL.
// Os tipos prontos (Google, GitHub, GitLab, Microsoft) só preenchem padrões; qualquer URL pode ser sobrescrita.

export const PROVIDER_TYPES: OAuthProviderType[] = ['google', 'github', 'gitlab', 'microsoft', 'custom'];

interface Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  identityUrl: string;
}

interface Preset extends Omit<OAuthPreset, 'type' | keyof Endpoints> {
  endpoints: (p: { serverUrl: string; tenant: string }) => Endpoints;
}

const trimUrl = (s: string) => String(s ?? '').trim().replace(/\/+$/, '');

const PRESETS: Record<OAuthProviderType, Preset> = {
  google: {
    name: 'Google',
    description: 'Contas Google e Google Workspace (OpenID Connect).',
    label: 'Entrar com Google',
    buttonColor: '#ffffff',
    buttonTextColor: '#1f1f1f',
    scope: 'openid email profile',
    fieldMap: { id: 'sub', username: '', email: 'email', name: 'name', avatar: 'picture', emailVerified: 'email_verified' },
    rolesClaim: '',
    groupsClaim: '',
    endpoints: () => ({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      identityUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    }),
  },
  github: {
    name: 'GitHub',
    description: 'GitHub.com ou GitHub Enterprise Server. Usa o e-mail principal verificado.',
    label: 'Entrar com GitHub',
    buttonColor: '#24292f',
    buttonTextColor: '#ffffff',
    scope: 'read:user user:email',
    fieldMap: { id: 'id', username: 'login', email: 'email', name: 'name', avatar: 'avatar_url', emailVerified: '' },
    rolesClaim: '',
    groupsClaim: '',
    endpoints: ({ serverUrl }) => {
      const base = trimUrl(serverUrl) || 'https://github.com';
      const apiBase = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
      return { authorizeUrl: `${base}/login/oauth/authorize`, tokenUrl: `${base}/login/oauth/access_token`, identityUrl: `${apiBase}/user` };
    },
  },
  gitlab: {
    name: 'GitLab',
    description: 'GitLab.com ou GitLab próprio (OpenID Connect). Os grupos vêm no claim "groups".',
    label: 'Entrar com GitLab',
    buttonColor: '#fc6d26',
    buttonTextColor: '#ffffff',
    scope: 'openid profile email',
    fieldMap: { id: 'sub', username: 'nickname', email: 'email', name: 'name', avatar: 'picture', emailVerified: 'email_verified' },
    rolesClaim: 'groups',
    groupsClaim: 'groups',
    endpoints: ({ serverUrl }) => {
      const base = trimUrl(serverUrl) || 'https://gitlab.com';
      return { authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`, identityUrl: `${base}/oauth/userinfo` };
    },
  },
  microsoft: {
    name: 'Microsoft',
    description: 'Microsoft Entra ID (Azure AD). Informe o ID do diretório; papéis e grupos vêm do id_token.',
    label: 'Entrar com Microsoft',
    buttonColor: '#2f2f2f',
    buttonTextColor: '#ffffff',
    scope: 'openid profile email',
    // O Entra não envia email_verified; o claim opcional xms_edov diz se o domínio do e-mail é verificado.
    fieldMap: { id: 'sub', username: 'preferred_username', email: 'email', name: 'name', avatar: 'picture', emailVerified: 'xms_edov' },
    rolesClaim: 'roles',
    groupsClaim: 'groups',
    endpoints: ({ tenant }) => {
      const t = encodeURIComponent(String(tenant ?? '').trim() || 'common');
      return {
        authorizeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
        identityUrl: 'https://graph.microsoft.com/oidc/userinfo',
      };
    },
  },
  custom: {
    name: 'Personalizado',
    description: 'Qualquer servidor OAuth 2.0 / OpenID Connect (Keycloak, Authentik, Okta, Auth0...).',
    label: 'Entrar com SSO',
    buttonColor: '#1d74f5',
    buttonTextColor: '#ffffff',
    scope: 'openid profile email',
    fieldMap: { id: 'sub', username: 'preferred_username', email: 'email', name: 'name', avatar: 'picture', emailVerified: 'email_verified' },
    rolesClaim: '',
    groupsClaim: '',
    endpoints: () => ({ authorizeUrl: '', tokenUrl: '', identityUrl: '' }),
  },
};

export function listPresets(): OAuthPreset[] {
  return PROVIDER_TYPES.map((type) => {
    const { endpoints, ...rest } = PRESETS[type];
    return { type, ...rest, ...endpoints({ serverUrl: '', tenant: '' }) };
  });
}

// URLs efetivas: o valor salvo (absoluto, ou relativo à URL do servidor) ou o padrão do tipo.
export function effectiveEndpoints(row: any): Endpoints & { emailsUrl?: string } {
  const preset = PRESETS[row.type as OAuthProviderType] ?? PRESETS.custom;
  const d = preset.endpoints({ serverUrl: row.server_url, tenant: row.tenant });
  const base = trimUrl(row.server_url);
  const pick = (v: string, def: string) => {
    const s = String(v ?? '').trim();
    if (!s) return def;
    return s.startsWith('/') && base ? base + s : s;
  };
  const out: Endpoints & { emailsUrl?: string } = {
    authorizeUrl: pick(row.authorize_url, d.authorizeUrl),
    tokenUrl: pick(row.token_url, d.tokenUrl),
    identityUrl: pick(row.identity_url, d.identityUrl),
  };
  if (row.type === 'github' && out.identityUrl) out.emailsUrl = `${out.identityUrl.replace(/\/+$/, '')}/emails`;
  return out;
}

export function effectiveScope(row: any) {
  return String(row.scope ?? '').trim() || (PRESETS[row.type as OAuthProviderType] ?? PRESETS.custom).scope;
}

// Campos vazios usam o padrão do tipo.
export function effectiveFieldMap(row: any): OAuthFieldMap {
  const preset = (PRESETS[row.type as OAuthProviderType] ?? PRESETS.custom).fieldMap;
  const saved = (row.field_map ?? {}) as Partial<OAuthFieldMap>;
  const out = { ...preset };
  for (const k of Object.keys(preset) as (keyof OAuthFieldMap)[]) if (typeof saved[k] === 'string' && saved[k]!.trim()) out[k] = saved[k]!.trim();
  return out;
}

export function presetOf(type: string) {
  return PRESETS[type as OAuthProviderType] ?? PRESETS.custom;
}

// "common", "organizations", "consumers" (ou vazio): qualquer diretório da Microsoft emite os tokens.
export function microsoftMultiTenant(row: any) {
  return ['', 'common', 'organizations', 'consumers'].includes(String(row.tenant ?? '').trim().toLowerCase());
}

// Servidor que emite as identidades; se mudar, os vínculos antigos deixam de valer (os ids podem repetir entre servidores).
function issuerKey(row: any) {
  const ep = effectiveEndpoints(row);
  return [row.type, ep.authorizeUrl, ep.tokenUrl, ep.identityUrl, String(row.tenant ?? '').trim().toLowerCase()].join('|');
}

export function callbackUrl(id: string) {
  return `${siteUrl()}/oauth/${encodeURIComponent(id)}/callback`;
}

// O segredo do cliente nunca é devolvido; só se informa se está definido.
export function mapProvider(r: any): OAuthProvider {
  const ep = effectiveEndpoints(r);
  return {
    _id: r.id,
    type: r.type,
    enabled: r.enabled,
    label: r.label,
    buttonColor: r.button_color,
    buttonTextColor: r.button_text_color,
    clientId: r.client_id,
    clientSecretSet: !!r.client_secret,
    serverUrl: r.server_url,
    tenant: r.tenant,
    authorizeUrl: r.authorize_url,
    tokenUrl: r.token_url,
    identityUrl: r.identity_url,
    scope: r.scope,
    tokenAuth: r.token_auth,
    tokenSentVia: r.token_sent_via,
    accessTokenParam: r.access_token_param,
    identityPath: r.identity_path,
    fieldMap: r.field_map ?? {},
    loginStyle: r.login_style,
    mergeUsers: r.merge_users,
    blockNewUsers: r.block_new_users,
    rolesClaim: r.roles_claim,
    syncRoles: r.sync_roles,
    mergeRoles: r.merge_roles,
    roleMapping: r.role_mapping ?? {},
    groupsClaim: r.groups_claim,
    mapChannels: r.map_channels,
    channelMapping: r.channel_mapping ?? {},
    sort: r.sort,
    callbackUrl: callbackUrl(r.id),
    effective: { authorizeUrl: ep.authorizeUrl, tokenUrl: ep.tokenUrl, identityUrl: ep.identityUrl, scope: effectiveScope(r), fieldMap: effectiveFieldMap(r) },
    _createdAt: r.created_at,
    _updatedAt: r.updated_at,
  };
}

// ---------- Validação ----------

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PATH_RE = /^[A-Za-z0-9_:$@-]+(?:\.[A-Za-z0-9_:$@-]+)*$/;
const FIELD_KEYS: (keyof OAuthFieldMap)[] = ['id', 'username', 'email', 'name', 'avatar', 'emailVerified'];

function text(v: unknown, name: string, max: number) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest('error-invalid-params', `O campo "${name}" deve ser texto.`);
  const s = v.trim();
  if (s.length > max) throw badRequest('error-invalid-params', `O campo "${name}" é longo demais.`);
  return s;
}

function flag(v: unknown) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function url(v: unknown, name: string, opts: { relative?: boolean } = {}) {
  const s = text(v, name, 2000);
  if (!s) return '';
  if (opts.relative && s.startsWith('/') && !s.startsWith('//')) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest('error-invalid-url', `"${name}" não é uma URL válida.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('error-invalid-url', `"${name}" precisa começar com https:// ou http://.`);
  if (u.username || u.password) throw badRequest('error-invalid-url', `"${name}" não pode conter usuário e senha.`);
  return s;
}

function dotPath(v: unknown, name: string) {
  const s = text(v, name, 200);
  if (s && !PATH_RE.test(s)) throw badRequest('error-invalid-params', `"${name}" deve ser um caminho com pontos, ex.: data.user.id.`);
  return s;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], def: T, name: string): T {
  if (v === undefined || v === null || v === '') return def;
  if (!values.includes(v as T)) throw badRequest('error-invalid-params', `Valor inválido para "${name}".`);
  return v as T;
}

// Aceita objeto ou JSON: { "valor do claim": "papel" | ["papel", ...] }.
export function parseMapping(v: unknown, name: string): OAuthMapping {
  if (v === undefined || v === null || v === '') return {};
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      throw badRequest('error-invalid-mapping', `${name}: JSON inválido.`);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badRequest('error-invalid-mapping', `${name}: use um objeto JSON, ex.: {"grupo": ["valor"]}.`);
  const out: OAuthMapping = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    const list = (Array.isArray(val) ? val : [val]).map((x) => (typeof x === 'string' ? x.trim() : null));
    if (!k.trim() || list.some((x) => !x)) throw badRequest('error-invalid-mapping', `${name}: cada chave deve apontar para um texto ou uma lista de textos.`);
    out[k.trim()] = Array.isArray(val) ? (list as string[]) : (list[0] as string);
  }
  if (Object.keys(out).length > 500) throw badRequest('error-invalid-mapping', `${name}: mapeamento grande demais.`);
  return out;
}

function fieldMap(v: unknown) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('error-invalid-params', 'Mapeamento de campos inválido.');
  const out: Partial<OAuthFieldMap> = {};
  for (const k of FIELD_KEYS) {
    const s = dotPath((v as any)[k], `Campo ${k}`);
    if (s) out[k] = s;
  }
  return out;
}

// Colunas editáveis e como cada uma é lida da entrada (camelCase da API).
const COLUMNS: [string, string, (v: unknown) => unknown][] = [
  ['enabled', 'enabled', flag],
  ['label', 'label', (v) => text(v, 'Texto do botão', 80)],
  ['button_color', 'buttonColor', (v) => color(v, 'Cor do botão')],
  ['button_text_color', 'buttonTextColor', (v) => color(v, 'Cor do texto do botão')],
  ['client_id', 'clientId', (v) => text(v, 'Client ID', 500)],
  ['server_url', 'serverUrl', (v) => url(v, 'URL do servidor')],
  ['tenant', 'tenant', (v) => tenant(v)],
  ['authorize_url', 'authorizeUrl', (v) => url(v, 'URL de autorização', { relative: true })],
  ['token_url', 'tokenUrl', (v) => url(v, 'URL do token', { relative: true })],
  ['identity_url', 'identityUrl', (v) => url(v, 'URL de identidade', { relative: true })],
  ['scope', 'scope', (v) => text(v, 'Escopo', 500)],
  ['token_auth', 'tokenAuth', (v) => oneOf(v, ['post', 'basic'] as const, 'post', 'Autenticação no token')],
  ['token_sent_via', 'tokenSentVia', (v) => oneOf(v, ['header', 'query'] as const, 'header', 'Token enviado via')],
  ['access_token_param', 'accessTokenParam', (v) => param(v)],
  ['identity_path', 'identityPath', (v) => dotPath(v, 'Caminho da identidade')],
  ['field_map', 'fieldMap', (v) => JSON.stringify(fieldMap(v))],
  ['login_style', 'loginStyle', (v) => oneOf(v, ['redirect'] as const, 'redirect', 'Estilo de login')],
  ['merge_users', 'mergeUsers', flag],
  ['block_new_users', 'blockNewUsers', flag],
  ['roles_claim', 'rolesClaim', (v) => dotPath(v, 'Claim dos papéis')],
  ['sync_roles', 'syncRoles', flag],
  ['merge_roles', 'mergeRoles', flag],
  ['role_mapping', 'roleMapping', (v) => JSON.stringify(parseMapping(v, 'Mapa de papéis'))],
  ['groups_claim', 'groupsClaim', (v) => dotPath(v, 'Claim dos grupos')],
  ['map_channels', 'mapChannels', flag],
  ['channel_mapping', 'channelMapping', (v) => JSON.stringify(parseMapping(v, 'Mapa de canais'))],
  ['sort', 'sort', (v) => Math.max(-1000, Math.min(1000, Math.trunc(Number(v)) || 0))],
];

function color(v: unknown, name: string) {
  const s = text(v, name, 7);
  if (s && !COLOR_RE.test(s)) throw badRequest('error-invalid-params', `${name}: use o formato #RRGGBB.`);
  return s;
}

function tenant(v: unknown) {
  const s = text(v, 'Tenant', 100);
  if (s && !/^[A-Za-z0-9.-]+$/.test(s)) throw badRequest('error-invalid-params', 'Tenant inválido: use o ID do diretório, o domínio, "common" ou "organizations".');
  return s;
}

function param(v: unknown) {
  const s = text(v, 'Nome do parâmetro do token', 64) || 'access_token';
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) throw badRequest('error-invalid-params', 'Nome do parâmetro do token inválido.');
  return s;
}

function readSecret(v: unknown): string | null | undefined {
  if (v === null) return null; // remove
  if (v === undefined || v === '' || v === '********') return undefined; // mantém
  return text(v, 'Client secret', 4000);
}

const mappingOf = (v: unknown) => (typeof v === 'string' ? JSON.parse(v || '{}') : (v ?? {})) as OAuthMapping;

// Regras que valem mesmo com o provedor desativado.
function assertConsistent(row: any) {
  if (row.sync_roles && !Object.keys(mappingOf(row.role_mapping)).length) {
    throw badRequest('error-oauth-role-mapping', 'Para sincronizar papéis, informe o mapa valor do claim → papéis. Só os papéis do mapa são concedidos.');
  }
  if (row.type === 'microsoft' && microsoftMultiTenant(row) && (row.sync_roles || row.map_channels)) {
    throw badRequest('error-oauth-tenant', 'Para sincronizar papéis ou canais com a Microsoft, informe o ID do diretório (tenant): com "common" qualquer diretório define esses valores.');
  }
}

// Ao ativar, o provedor precisa estar completo.
function assertUsable(row: any) {
  assertConsistent(row);
  if (!row.enabled) return;
  const ep = effectiveEndpoints(row);
  if (!row.client_id) throw badRequest('error-oauth-incomplete', 'Para ativar o provedor, informe o Client ID.');
  if (!ep.authorizeUrl || !ep.tokenUrl) throw badRequest('error-oauth-incomplete', 'Para ativar o provedor, informe as URLs de autorização e de token.');
  for (const [name, u] of [['autorização', ep.authorizeUrl], ['token', ep.tokenUrl], ['identidade', ep.identityUrl]]) {
    if (u && !/^https?:\/\//.test(u)) throw badRequest('error-oauth-incomplete', `A URL de ${name} é relativa: informe também a URL do servidor.`);
  }
  if (!ep.identityUrl && !/\bopenid\b/.test(effectiveScope(row))) {
    throw badRequest('error-oauth-incomplete', 'Informe a URL de identidade (userinfo) ou use o escopo "openid" para ler o id_token.');
  }
}

// ---------- Banco ----------

export async function listProviders() {
  return (await many('SELECT * FROM oauth_providers ORDER BY sort, created_at')).map(mapProvider);
}

export async function getProviderRow(id: string) {
  return one('SELECT * FROM oauth_providers WHERE id = $1', [id]);
}

export async function getProvider(id: string) {
  const r = await getProviderRow(id);
  if (!r) throw notFound('error-oauth-provider-not-found', 'Provedor OAuth não encontrado.');
  return mapProvider(r);
}

export async function getEnabledProvider(id: string) {
  return one('SELECT * FROM oauth_providers WHERE id = $1 AND enabled', [String(id)]);
}

// Lista pública da tela de login: só o necessário para desenhar os botões.
export async function listPublicProviders(): Promise<OAuthProviderPublic[]> {
  const rows = await many(`SELECT id, type, label, button_color, button_text_color FROM oauth_providers WHERE enabled ORDER BY sort, created_at`);
  return rows.map((r) => {
    const preset = presetOf(r.type);
    return { _id: r.id, label: r.label || preset.label, buttonColor: r.button_color || preset.buttonColor, buttonTextColor: r.button_text_color || preset.buttonTextColor };
  });
}

// Só as colunas presentes na entrada.
function changes(input: Record<string, any>) {
  const set: Record<string, unknown> = {};
  for (const [col, key, parse] of COLUMNS) if (key in input) set[col] = parse(input[key]);
  return set;
}

export async function createProvider(actor: Actor, input: Record<string, any>) {
  const type = oneOf(input.type, PROVIDER_TYPES, 'custom', 'Tipo');
  const id = text(input._id ?? input.id, 'ID', 40).toLowerCase() || type;
  if (!ID_RE.test(id)) throw badRequest('error-invalid-params', 'ID inválido: use letras minúsculas, números e hífen (até 40).');
  if (await getProviderRow(id)) throw badRequest('error-duplicate-oauth-provider', `Já existe um provedor com o ID "${id}".`);
  const preset = presetOf(type);
  const row: Record<string, unknown> = { id, type, ...changes(input) };
  row.label ||= preset.label;
  row.button_color ||= preset.buttonColor;
  row.button_text_color ||= preset.buttonTextColor;
  if (!('rolesClaim' in input)) row.roles_claim = preset.rolesClaim;
  if (!('groupsClaim' in input)) row.groups_claim = preset.groupsClaim;
  const secret = readSecret(input.clientSecret);
  row.client_secret = secret ?? '';
  assertUsable({ ...defaultsRow(), ...row });
  const cols = Object.keys(row);
  const created = await one(`INSERT INTO oauth_providers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(row));
  await audit(actor, 'oauth.provider.created', { providerId: id, type }, { fields: cols.filter((c) => c !== 'client_secret'), clientSecretSet: !!secret });
  return mapProvider(created);
}

function defaultsRow() {
  return { enabled: false, client_id: '', server_url: '', tenant: '', authorize_url: '', token_url: '', identity_url: '', scope: '', field_map: {} };
}

export async function updateProvider(actor: Actor, id: string, input: Record<string, any>) {
  const existing = await getProviderRow(id);
  if (!existing) throw notFound('error-oauth-provider-not-found', 'Provedor OAuth não encontrado.');
  if (input.type !== undefined && input.type !== existing.type) throw badRequest('error-invalid-params', 'O tipo do provedor não pode ser alterado.');
  const set = changes(input);
  // Texto e cores apagados voltam ao padrão do tipo, como na criação.
  const preset = presetOf(existing.type);
  if ('label' in set && !set.label) set.label = preset.label;
  if ('button_color' in set && !set.button_color) set.button_color = preset.buttonColor;
  if ('button_text_color' in set && !set.button_text_color) set.button_text_color = preset.buttonTextColor;
  const secret = readSecret(input.clientSecret);
  if (secret !== undefined) set.client_secret = secret ?? '';
  const merged = { ...existing, ...set, field_map: set.field_map ? JSON.parse(String(set.field_map)) : existing.field_map };
  assertUsable(merged);
  const cols = Object.keys(set);
  if (!cols.length) return mapProvider(existing);
  const rebound = issuerKey(existing) !== issuerKey(merged);
  const row = await one(
    `UPDATE oauth_providers SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...Object.values(set)],
  );
  // Outro servidor: os vínculos antigos poderiam apontar para outra pessoa com o mesmo id.
  const identitiesRemoved = rebound ? (await query('DELETE FROM oauth_identities WHERE provider_id = $1', [id])).rowCount ?? 0 : 0;
  await audit(
    actor,
    'oauth.provider.updated',
    { providerId: id, type: existing.type },
    { fields: cols.filter((c) => c !== 'client_secret'), clientSecretChanged: 'client_secret' in set, ...(rebound ? { identitiesRemoved } : {}) },
  );
  return mapProvider(row);
}

export async function deleteProvider(actor: Actor, id: string) {
  const r = await one('DELETE FROM oauth_providers WHERE id = $1 RETURNING id, type', [id]);
  if (!r) throw notFound('error-oauth-provider-not-found', 'Provedor OAuth não encontrado.');
  await audit(actor, 'oauth.provider.deleted', { providerId: id, type: r.type });
}
