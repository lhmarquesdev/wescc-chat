import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { FastifyInstance } from 'fastify';
import { many, one, pool } from '../db/pool';
import { ApiError } from '../lib/errors';
import { audit } from '../services/audit';
import { getSetting } from '../services/settings';
import { issueSsoCredential, safeRedirect, siteUrl, ssoErrorPage as errorPage, ssoLoginUrl } from '../services/sso';
import { recordHistory } from '../services/rbacHistory';

// Login único via SAML 2.0 (SP-initiated): /saml/login redireciona ao IdP, /saml/acs recebe a
// resposta, cria ou atualiza o usuário e devolve ao cliente web uma credencial de uso único
// (services/sso.ts), trocada por uma sessão em POST /api/v1/login { saml: true, credentialToken }.

const REQUEST_TTL_MIN = 10;

// IDs dos pedidos guardados no Postgres, para a resposta poder chegar a qualquer instância.
const pgCache: CacheProvider = {
  async saveAsync(key, value) {
    const r = await one('INSERT INTO saml_requests (id, value) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING created_at', [key, value]);
    return r ? { value, createdAt: new Date(r.created_at).getTime() } : null;
  },
  async getAsync(key) {
    const r = await one(`SELECT value FROM saml_requests WHERE id = $1 AND created_at > now() - make_interval(mins => $2)`, [key, REQUEST_TTL_MIN]);
    return r?.value ?? null;
  },
  async removeAsync(key) {
    if (!key) return null;
    const r = await one('DELETE FROM saml_requests WHERE id = $1 RETURNING value', [key]);
    return r?.value ?? null;
  },
};

export function samlClient() {
  const cert = String(getSetting('SAML_IdP_Cert') ?? '').trim();
  return new SAML({
    entryPoint: getSetting<string>('SAML_Entry_Point') || undefined,
    issuer: getSetting<string>('SAML_Issuer') || 'wescc-chat',
    callbackUrl: `${siteUrl()}/saml/acs`,
    // Sem certificado configurado nenhuma resposta é aceita.
    idpCert: cert || 'not-configured',
    audience: getSetting<string>('SAML_Issuer') || 'wescc-chat',
    wantAssertionsSigned: getSetting<boolean>('SAML_Want_Assertions_Signed') ?? true,
    wantAuthnResponseSigned: getSetting<boolean>('SAML_Want_Response_Signed') ?? false,
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: REQUEST_TTL_MIN * 60_000,
    cacheProvider: pgCache,
    acceptedClockSkewMs: 60_000,
    identifierFormat: null,
    logoutUrl: getSetting<string>('SAML_Logout_Url') || undefined,
  });
}

function attr(profile: Profile, names: string): string | undefined {
  for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
    const v = n === 'nameID' ? profile.nameID : profile[n];
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined && first !== null && first !== '') return String(first);
  }
  return undefined;
}

function attrList(profile: Profile, name: string): string[] {
  if (!name) return [];
  const v = profile[name];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
}

async function mapRoles(profile: Profile): Promise<string[] | null> {
  const attrName = getSetting<string>('SAML_Role_Attribute');
  if (!attrName) return null;
  const values = attrList(profile, attrName);
  let map: Record<string, string | string[]> = {};
  try {
    map = JSON.parse(getSetting<string>('SAML_Role_Mapping') || '{}');
  } catch {
    map = {};
  }
  const wanted = Object.keys(map).length ? values.flatMap((v) => [map[v] ?? []].flat()) : values;
  const existing = await many('SELECT id FROM roles WHERE id = ANY($1)', [wanted]);
  return existing.map((r) => r.id);
}

// Só troca os papéis que o SAML gerencia (os do mapa e os que ele mesmo deu no último login);
// papéis dados à mão, inclusive admin, ficam.
async function syncSamlRoles(user: any, granted: string[]) {
  let map: Record<string, string | string[]> = {};
  try {
    map = JSON.parse(getSetting<string>('SAML_Role_Mapping') || '{}');
  } catch {
    map = {};
  }
  const managed = new Set([...Object.values(map).flat(), ...(user.saml_synced_roles ?? [])]);
  const next = [...new Set([...user.roles.filter((r: string) => !managed.has(r)), ...granted, 'user'])];
  if (user.roles.includes('admin') && !next.includes('admin')) {
    const n = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active AND id <> $1`, [user.id]);
    if (!n.n) next.push('admin'); // nunca remove o último administrador
  }
  const row = await one('UPDATE users SET roles = $2, saml_synced_roles = $3, updated_at = now() WHERE id = $1 RETURNING *', [user.id, next, granted]);
  const same = next.length === user.roles.length && next.every((r) => user.roles.includes(r));
  if (!same) {
    await recordHistory(pool, { entityType: 'user', entityId: user.id, entityLabel: user.username, action: 'update', source: 'saml', actor: null, changes: [{ field: 'roles', before: user.roles, after: next }] });
    await audit({ id: user.id, username: user.username }, 'auth.saml.roles', { userId: user.id }, { before: user.roles, after: next });
  }
  return row;
}

// Cria ou atualiza o usuário local a partir do perfil SAML.
export async function upsertFromProfile(profile: Profile) {
  const { createUser } = await import('../services/users');
  const externalId = profile.nameID;
  if (!externalId) throw new ApiError(400, 'error-saml-invalid', 'Resposta SAML sem identificador (NameID).');
  const username = (attr(profile, getSetting<string>('SAML_Username_Attribute')) ?? externalId.split('@')[0]).replace(/[^0-9a-zA-Z._-]/g, '.');
  const email = attr(profile, getSetting<string>('SAML_Email_Attribute')) ?? profile.email ?? profile.mail;
  const name = attr(profile, getSetting<string>('SAML_Name_Attribute')) ?? username;

  let user = await one(`SELECT * FROM users WHERE auth_source = 'saml' AND external_id = $1`, [externalId]);
  if (!user && email && getSetting('SAML_Merge_By_Email')) {
    user = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    // Só vincula a contas com o e-mail confirmado (um cadastro com o e-mail de outra pessoa não "captura" o login dela).
    if (user && !user.email_verified) {
      throw new ApiError(409, 'error-saml-email-not-verified', 'A conta existente com este e-mail não tem o e-mail confirmado. Peça ao administrador para confirmá-lo antes de vincular.');
    }
  }
  if (!user) {
    if (!getSetting('SAML_Allow_New_Users')) throw new ApiError(403, 'error-saml-no-user', 'Usuário não cadastrado. Fale com o administrador.');
    const taken = await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    if (taken) throw new ApiError(409, 'error-saml-username-taken', `Já existe um usuário local "${username}". Peça ao administrador para ativar o vínculo por e-mail.`);
    user = await createUser({ username, name, email: email ?? null, authSource: 'saml', externalId, verified: true, skipPasswordPolicy: true });
  } else {
    user = await one(
      `UPDATE users SET name = $2, email = COALESCE($3, email), auth_source = 'saml', external_id = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [user.id, name, email ?? null, externalId],
    );
  }
  const roles = await mapRoles(profile);
  if (roles) user = await syncSamlRoles(user, roles);
  return user;
}

export function samlRoutes(app: FastifyInstance) {
  app.get('/saml/metadata', async (_req, reply) => {
    reply.header('content-type', 'application/xml; charset=utf-8');
    return samlClient().generateServiceProviderMetadata(null, null);
  });

  app.get('/saml/login', async (req, reply) => {
    if (!getSetting('SAML_Enable')) return reply.code(404).type('text/html').send(errorPage('O login SAML não está ativado.'));
    const relay = safeRedirect((req.query as any)?.redirect);
    const url = await samlClient().getAuthorizeUrlAsync(relay, undefined, {});
    return reply.redirect(url);
  });

  app.post('/saml/acs', async (req, reply) => {
    if (!getSetting('SAML_Enable')) return reply.code(404).type('text/html').send(errorPage('O login SAML não está ativado.'));
    const body = (req.body ?? {}) as Record<string, string>;
    if (!body.SAMLResponse) return reply.code(400).type('text/html').send(errorPage('Resposta SAML ausente.'));
    try {
      const { profile } = await samlClient().validatePostResponseAsync({ SAMLResponse: body.SAMLResponse });
      if (!profile) throw new ApiError(400, 'error-saml-invalid', 'Resposta SAML sem perfil.');
      const user = await upsertFromProfile(profile);
      if (!user.active) throw new ApiError(403, 'error-user-inactive', 'Usuário desativado.');
      const { token, cookie } = await issueSsoCredential(user.id, 'saml');
      await audit({ id: user.id, username: user.username, ip: req.ip }, 'auth.saml.assertion', { nameID: profile.nameID, issuer: profile.issuer });
      return reply.header('set-cookie', cookie).header('cache-control', 'no-store').redirect(ssoLoginUrl('saml', token, safeRedirect(body.RelayState)));
    } catch (e: any) {
      await audit({ ip: req.ip, username: 'saml' }, 'auth.saml.failed', { error: String(e?.message ?? e).slice(0, 300) });
      return reply.code(e instanceof ApiError ? e.statusCode : 401).type('text/html').send(errorPage(e instanceof ApiError ? e.message : 'A resposta do provedor de identidade não pôde ser validada.'));
    }
  });
}
