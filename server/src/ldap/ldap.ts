import { Client, type Entry } from 'ldapts';
import { many, one, query } from '../db/pool';
import { audit } from '../services/audit';
import { getSetting } from '../services/settings';

// Integração LDAP / Active Directory: login, sincronização de dados,
// mapeamento de grupos para papéis e canais e sincronização em segundo plano.

function client() {
  return new Client({
    url: getSetting<string>('LDAP_Url'),
    timeout: 10_000,
    connectTimeout: 10_000,
    tlsOptions: { rejectUnauthorized: getSetting<boolean>('LDAP_Reject_Unauthorized') },
  });
}

function escapeFilter(v: string) {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function attr(entry: Entry, names: string): string | undefined {
  for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
    const v = entry[n];
    if (v === undefined) continue;
    const first = Array.isArray(v) ? v[0] : v;
    if (Buffer.isBuffer(first)) return first.toString('hex');
    if (first !== undefined && first !== '') return String(first);
  }
  return undefined;
}

async function bindService(c: Client) {
  const dn = getSetting<string>('LDAP_Authentication_UserDN');
  if (dn) await c.bind(dn, getSetting<string>('LDAP_Authentication_Password'));
}

async function findEntry(c: Client, login: string): Promise<Entry | null> {
  const fields = getSetting<string>('LDAP_User_Search_Field')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const byLogin = fields.length > 1 ? `(|${fields.map((f) => `(${f}=${escapeFilter(login)})`).join('')})` : `(${fields[0]}=${escapeFilter(login)})`;
  const filter = `(&${getSetting<string>('LDAP_User_Search_Filter') || '(objectclass=*)'}${byLogin})`;
  const { searchEntries } = await c.search(getSetting<string>('LDAP_BaseDN'), { scope: 'sub', filter, sizeLimit: 2 });
  return searchEntries[0] ?? null;
}

async function groupsOf(c: Client, entry: Entry): Promise<string[]> {
  const tmpl = getSetting<string>('LDAP_Group_Filter');
  if (!tmpl) return [];
  const username = attr(entry, getSetting<string>('LDAP_Username_Field')) ?? '';
  const filter = tmpl.replace(/#\{userdn\}/g, escapeFilter(entry.dn)).replace(/#\{username\}/g, escapeFilter(username));
  const { searchEntries } = await c.search(getSetting<string>('LDAP_BaseDN'), { scope: 'sub', filter, attributes: ['cn'] });
  return searchEntries.map((g) => attr(g, 'cn') ?? g.dn);
}

function parseMap(key: string): Record<string, string | string[]> {
  try {
    return JSON.parse(getSetting<string>(key) || '{}');
  } catch {
    return {};
  }
}

// Cria ou atualiza o usuário local a partir da entrada LDAP.
async function upsertFromEntry(entry: Entry, groups: string[]) {
  const { createUser } = await import('../services/users');
  const username = (attr(entry, getSetting<string>('LDAP_Username_Field')) ?? '').replace(/[^0-9a-zA-Z._-]/g, '.');
  const name = attr(entry, getSetting<string>('LDAP_Name_Field')) ?? username;
  const email = attr(entry, getSetting<string>('LDAP_Email_Field'));
  const uid = attr(entry, getSetting<string>('LDAP_Unique_Identifier_Field')) ?? entry.dn;
  if (!username) return null;

  let user = await one(`SELECT * FROM users WHERE auth_source = 'ldap' AND external_id = $1`, [uid]);
  if (!user) user = await one(`SELECT * FROM users WHERE lower(username) = lower($1)`, [username]);
  if (!user) {
    user = await createUser({ username, name, email: email ?? null, authSource: 'ldap', externalId: uid, verified: true, skipPasswordPolicy: true });
  } else {
    user = await one(
      `UPDATE users SET name = $2, email = COALESCE($3, email), auth_source = 'ldap', external_id = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [user.id, name, email ?? null, uid],
    );
  }

  if (getSetting('LDAP_Enable_Role_Mapping')) {
    const map = parseMap('LDAP_Role_Mapping');
    const mapped = new Set<string>();
    for (const g of groups) for (const r of [map[g] ?? []].flat()) mapped.add(r);
    const managed = new Set(Object.values(map).flat());
    const keep = user.roles.filter((r: string) => !managed.has(r));
    const roles = [...new Set([...keep, ...mapped])];
    if (!roles.includes('user')) roles.push('user');
    user = await one('UPDATE users SET roles = $2 WHERE id = $1 RETURNING *', [user.id, roles]);
  }
  if (getSetting('LDAP_Enable_Channel_Mapping')) {
    const map = parseMap('LDAP_Channel_Mapping');
    const { getRoomByName, addUserToRoom, createRoom } = await import('../services/rooms');
    for (const g of groups) {
      for (const ch of [map[g] ?? []].flat()) {
        let room = await getRoomByName(String(ch));
        if (!room) room = await createRoom(null, { type: 'p', name: String(ch), skipPermission: true });
        await addUserToRoom(room.id, user.id, { silent: true }).catch(() => {});
      }
    }
  }
  return user;
}

export async function ldapLogin(login: string, password: string) {
  if (!password) return null;
  const c = client();
  try {
    await bindService(c);
    const entry = await findEntry(c, login);
    if (!entry) return null;
    // Valida a senha fazendo bind como o próprio usuário.
    const userClient = client();
    try {
      await userClient.bind(entry.dn, password);
    } finally {
      await userClient.unbind().catch(() => {});
    }
    const groups = await groupsOf(c, entry).catch(() => []);
    return upsertFromEntry(entry, groups);
  } finally {
    await c.unbind().catch(() => {});
  }
}

export async function ldapTestConnection() {
  const c = client();
  try {
    await bindService(c);
    const { searchEntries } = await c.search(getSetting<string>('LDAP_BaseDN'), {
      scope: 'sub',
      filter: getSetting<string>('LDAP_User_Search_Filter') || '(objectclass=*)',
      sizeLimit: 5,
    });
    return { ok: true, sample: searchEntries.length };
  } finally {
    await c.unbind().catch(() => {});
  }
}

export async function ldapSync() {
  if (!getSetting('LDAP_Enable')) return { imported: 0, updated: 0, deactivated: 0 };
  const c = client();
  let imported = 0;
  let updated = 0;
  let deactivated = 0;
  try {
    await bindService(c);
    const { searchEntries } = await c.search(getSetting<string>('LDAP_BaseDN'), {
      scope: 'sub',
      filter: getSetting<string>('LDAP_User_Search_Filter') || '(objectclass=*)',
      paged: { pageSize: 500 },
    });
    const seen = new Set<string>();
    for (const e of searchEntries) {
      const uid = attr(e, getSetting<string>('LDAP_Unique_Identifier_Field')) ?? e.dn;
      seen.add(uid);
      const exists = await one(`SELECT 1 FROM users WHERE auth_source = 'ldap' AND external_id = $1`, [uid]);
      if (!exists && !getSetting('LDAP_Background_Sync_Import_New_Users')) continue;
      const groups = await groupsOf(c, e).catch(() => []);
      const u = await upsertFromEntry(e, groups).catch(() => null);
      if (u) exists ? updated++ : imported++;
    }
    if (getSetting('LDAP_Sync_User_Active_State')) {
      const local = await many(`SELECT id, external_id FROM users WHERE auth_source = 'ldap' AND active`);
      for (const l of local) {
        if (!seen.has(l.external_id)) {
          await query('UPDATE users SET active = false WHERE id = $1', [l.id]);
          await query('DELETE FROM sessions WHERE user_id = $1', [l.id]);
          deactivated++;
        }
      }
    }
  } finally {
    await c.unbind().catch(() => {});
  }
  await audit({ username: 'system' }, 'ldap.sync', {}, { imported, updated, deactivated });
  return { imported, updated, deactivated };
}
