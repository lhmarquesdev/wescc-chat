import type { Entry } from 'ldapts';
import { normalizeDn, ouLabel, splitDn, type LdapGroupRef, type LdapMappingTest, type LdapRuleKey, type LdapRunStatus, type LdapSyncRun } from '@shared/ldap';
import { config } from '../config';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { bus } from '../realtime/bus';
import { audit, type Actor } from '../services/audit';
import { currentDirectRules } from '../services/direct';
import { mapUser } from '../services/mappers';
import { restrictedRoleIds } from '../services/permissions';
import { addUserToRoom, createRoom, getRoomByName, removeUserFromRoom, validateRoomName } from '../services/rooms';
import { createUser, EMAIL_RE, revokeAllSessions, type Ctx } from '../services/users';
import { applyLdapAvatar, photoDataUrl, photoOf, planLdapAvatar } from './avatar';
import {
  bindService,
  entryAttr,
  escapeFilter,
  entryGuid,
  entryUid,
  findEntries,
  groupFilterTemplate,
  groupsNamed,
  groupsOf,
  isAccountDisabled,
  isPersonEntry,
  ldapErrorText,
  legacyUids,
  openClient,
  userPages,
} from './client';
import { loadLdapConfig, type LdapConfig } from './config';
import { ambiguousKeys, ambiguousMatch, groupNames, matchKeys, planMembership, planRoles, type AmbiguousKey, type MembershipTarget } from './mapping';
import { finishRun, getRun, insertRun, RunLog, saveProgress, tryLdapLock, type LdapTrigger } from './runs';

// Sincronização LDAP / Active Directory: uma entrada (login, prévia) ou o diretório inteiro (execução).

export interface LdapSource {
  users(): AsyncIterable<Entry[]>; // páginas
  groupsOf(entry: Entry): Promise<LdapGroupRef[]>; // lança quando a busca falha
  groupsNamed?(names: string[]): Promise<LdapGroupRef[]>; // grupos com esses nomes (cn ou sAMAccountName)
  close(): Promise<void>;
}

export function directorySource(cfg: LdapConfig): LdapSource {
  let client: ReturnType<typeof openClient> | null = null;
  const ready = async () => {
    if (!client) {
      client = openClient(cfg);
      await bindService(client, cfg);
    }
    return client;
  };
  return {
    async *users() {
      yield* userPages(await ready(), cfg);
    },
    async groupsOf(entry) {
      return groupsOf(await ready(), cfg, entry);
    },
    async groupsNamed(names) {
      return groupsNamed(await ready(), cfg, names);
    },
    async close() {
      await client?.unbind().catch(() => {});
    },
  };
}

const SYSTEM: Actor = { username: 'system' };

function logError(what: string, e: unknown) {
  if (config.logLevel !== 'silent') console.error(`LDAP: ${what}`, e);
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);
const unique = <T>(list: T[]) => [...new Set(list)];
// Sem diferença de maiúsculas (nomes de sala e de time são assim no banco); fica a primeira grafia.
function uniqueName(list: string[]) {
  const seen = new Map<string, string>();
  for (const n of list) if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()];
}
const parentDn = (dn: string) => splitDn(dn).slice(1).join(',');
const sanitizeUsername = (v: string) => v.replace(/[^0-9a-zA-Z._-]/g, '.');

// ---------- Contexto de uma execução (lido uma vez) ----------

interface ChannelTarget extends MembershipTarget {
  key: string;
}

interface TeamTarget extends MembershipTarget {
  roomId: string | null;
}

interface MappingContext {
  roleScopes: Map<string, string>;
  restricted: string[];
  channels: Map<string, ChannelTarget>; // nome em minúsculas → sala (id null: será criada)
  teams: Map<string, TeamTarget>;
  channelOwner: { id: string; username: string } | null;
}

const channelName = (v: string) => v.trim().replace(/^#/, '').trim();

async function buildContext(cfg: LdapConfig, log: RunLog): Promise<MappingContext> {
  const roleScopes = new Map((await many<{ id: string; scope: string }>('SELECT id, scope FROM roles')).map((r) => [r.id, r.scope]));
  const channels = new Map<string, ChannelTarget>();
  if (cfg.channelMapping) {
    for (const name of unique(Object.values(cfg.channelMap).flat().map(channelName)).filter(Boolean)) {
      const key = name.toLowerCase();
      if (channels.has(key)) continue;
      try {
        validateRoomName(name);
      } catch {
        log.warn(`Nome de canal inválido no mapeamento: "${name}".`);
        continue;
      }
      const room = await getRoomByName(name);
      if (room?.archived) {
        log.warn(`O canal #${room.name} do mapeamento está arquivado e foi ignorado.`);
        continue;
      }
      channels.set(key, { key, name: room?.name ?? name, id: room?.id ?? null });
    }
  }
  const teams = new Map<string, TeamTarget>();
  if (cfg.teamMapping) {
    const names = unique(Object.values(cfg.teamMap).flat().map((n) => n.trim())).filter(Boolean);
    const rows = names.length
      ? await many('SELECT t.id, t.name, t.room_id, r.archived FROM teams t JOIN rooms r ON r.id = t.room_id WHERE lower(t.name) = ANY($1)', [names.map((n) => n.toLowerCase())])
      : [];
    const found = new Map(rows.map((r) => [String(r.name).toLowerCase(), r]));
    for (const name of names) {
      const key = name.toLowerCase();
      if (teams.has(key)) continue;
      const t = found.get(key);
      if (!t) log.warn(`Time "${name}" do mapeamento não existe.`);
      else if (t.archived) log.warn(`O time "${t.name}" do mapeamento está arquivado e foi ignorado.`);
      teams.set(key, { name: t?.name ?? name, id: t && !t.archived ? t.id : null, roomId: t && !t.archived ? t.room_id : null });
    }
  }
  let channelOwner: MappingContext['channelOwner'] = null;
  if (cfg.channelMapping && cfg.channelsAdmin) {
    channelOwner = await one('SELECT id, username FROM users WHERE lower(username) = lower($1)', [cfg.channelsAdmin]);
    if (!channelOwner) log.warn(`O dono dos canais "${cfg.channelsAdmin}" (LDAP_Channels_Admin) não existe; os canais criados ficam sem dono.`);
  }
  return { roleScopes, restricted: restrictedRoleIds(), channels, teams, channelOwner };
}

// ---------- Uma entrada ----------

export type SyncTrigger = LdapTrigger | 'login';

export interface SyncScope {
  cfg: LdapConfig;
  trigger: SyncTrigger;
  dryRun?: boolean;
  log: RunLog;
  actor: Actor;
  groupsOf(entry: Entry): Promise<LdapGroupRef[]>;
  groupsNamed?(names: string[]): Promise<LdapGroupRef[]>; // sem ela (fontes de teste), nenhuma chave é ambígua
  context?: MappingContext;
  ambiguous?: AmbiguousKey[];
}

export interface EntryOutcome {
  status: 'created' | 'updated' | 'skipped' | 'failed';
  user: any | null;
  reason?: string;
  preview: LdapMappingTest;
}

function emptyPreview(login: string): LdapMappingTest {
  return {
    login,
    found: false,
    groups: [],
    nestedApplied: false,
    matched: [],
    account: { exists: false, action: 'skip', activeAfter: false },
    roles: { before: [], after: [], added: [], removed: [] },
    channels: { join: [], leave: [], create: [] },
    teams: { join: [], leave: [], missing: [] },
    direct: { restricted: false, exempt: false },
    warnings: [],
  };
}

// Pelo identificador e pelas formas antigas dele. O DN como forma antiga só vale com o mesmo nome de usuário ou o
// mesmo e-mail (o administrador pode ter renomeado a conta): um DN é reaproveitado (outra pessoa com o mesmo nome
// na mesma OU) e assumiria a conta de quem saiu.
async function findAccount(uid: string, entry: Entry, cfg: LdapConfig, username: string, email: string | null) {
  const strong = legacyUids(entry, cfg).filter((x) => x !== entry.dn);
  return one(
    `SELECT * FROM users WHERE auth_source = 'ldap' AND (external_id = ANY($1::text[])
       OR (external_id = $3 AND (lower(username) = lower($4) OR lower(email) = lower($5))))
     ORDER BY (external_id = $2) DESC, (external_id = $3) ASC LIMIT 1`,
    [[uid, ...strong], uid, entry.dn, username, email],
  );
}

// Grupos do diretório com os nomes usados nas regras dos mapas ligados: lidos uma vez por execução (ou prévia, ou login).
async function ambiguousOf(s: SyncScope): Promise<AmbiguousKey[]> {
  if (s.ambiguous) return s.ambiguous;
  const { cfg } = s;
  const maps = { roleMap: cfg.roleMapping ? cfg.roleMap : {}, channelMap: cfg.channelMapping ? cfg.channelMap : {}, teamMap: cfg.teamMapping ? cfg.teamMap : {} };
  const names = groupNames(maps);
  const found = names.length && s.groupsNamed ? await s.groupsNamed(names) : [];
  s.ambiguous = ambiguousKeys(maps, found);
  return s.ambiguous;
}

async function isLastActiveAdmin(userId: string) {
  const r = await one(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active AND id <> $1`, [userId]);
  return !r?.n;
}

async function deactivate(s: SyncScope, user: any, reason: 'removed' | 'disabled') {
  const row = await one(
    `UPDATE users SET active = false, ldap_deactivated_at = now(), ldap_deactivated_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [user.id, reason],
  );
  await revokeAllSessions(user.id);
  bus.publish({ all: true }, { type: 'user', action: 'updated', user: mapUser(row) });
  await audit(s.actor, 'ldap.user.deactivated', { userId: user.id, username: user.username }, { reason });
  s.log.counts.deactivated++;
  s.log.change(user.username, 'deactivated', reason === 'disabled' ? 'Conta desativada no Active Directory' : 'Não aparece mais na busca do LDAP');
  return row;
}

// Executa as ações planejadas, ou só as descreve na prévia.
export async function syncEntry(s: SyncScope, entry: Entry): Promise<EntryOutcome> {
  const { cfg, log } = s;
  const dry = !!s.dryRun;
  const rawUsername = entryAttr(entry, cfg.usernameFields) ?? '';
  const username = sanitizeUsername(rawUsername);
  const p = emptyPreview(username);
  const warn = (t: string) => {
    if (!p.warnings.includes(t)) p.warnings.push(t);
    log.warn(t);
  };
  const skip = (reason: string): EntryOutcome => {
    if (!dry) log.counts.skipped++;
    return { status: 'skipped', user: null, reason, preview: p };
  };
  if (!isPersonEntry(entry)) return skip('A entrada não é uma pessoa (grupo, OU, contêiner ou computador).');
  if (!username) {
    warn(`Entrada sem nome de usuário ignorada: ${entry.dn}`);
    return skip('A entrada não tem nome de usuário.');
  }
  const name = entryAttr(entry, cfg.nameFields) ?? username;
  let email = entryAttr(entry, cfg.emailFields)?.trim() || null;
  if (email && !EMAIL_RE.test(email)) {
    warn(`E-mail inválido no diretório para @${username} ("${email}"); o e-mail foi ignorado.`);
    email = null;
  }
  const uid = entryUid(entry, cfg);
  const disabled = isAccountDisabled(entry);
  const photo = cfg.syncAvatar ? photoOf(entry, cfg) : null;
  p.found = true;
  p.entry = { dn: entry.dn, parentDn: parentDn(entry.dn), username, name, email, uid, guid: entryGuid(entry), disabled, photo: photoDataUrl(photo) };

  // Conta: pelo identificador (e formas antigas dele), depois pelo nome de usuário com as regras de vínculo.
  let user = await findAccount(uid, entry, cfg, username, email);
  let linked = false;
  if (!user) {
    const existing = await one('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    if (existing) {
      // Uma conta com o mesmo nome só é vinculada com a opção ligada, nunca a outra pessoa do LDAP e nunca quando
      // o nome só fica igual depois de limpo ("carlos souza" não é "carlos.souza"): senão quem criasse no diretório
      // um nome parecido com o de um administrador assumiria a conta local.
      const otherPerson = existing.auth_source === 'ldap' && existing.external_id && existing.external_id !== uid;
      const sameName = String(existing.username).toLowerCase() === rawUsername.toLowerCase();
      if (!cfg.mergeExisting || otherPerson || !sameName) {
        const message = otherPerson
          ? `Já existe um usuário "${existing.username}" ligado a outra pessoa do diretório.`
          : !sameName
            ? `Já existe um usuário "${existing.username}" e o nome no diretório é "${rawUsername}": a conta local não é vinculada a um nome diferente.`
            : `Já existe um usuário "${existing.username}" que não veio do LDAP. Peça ao administrador para ativar o vínculo de contas existentes.`;
        const err = new ApiError(409, 'error-ldap-username-taken', message);
        if (!dry) throw err;
        p.account = { exists: true, userId: existing.id, username: existing.username, active: existing.active, action: 'conflict', activeAfter: existing.active, note: err.message };
      } else {
        user = existing;
        linked = true;
      }
    }
  }
  const isNew = !user;
  if (user) p.account = { exists: true, userId: user.id, username: user.username, active: user.active, action: 'update', activeAfter: user.active };
  else if (p.account.action !== 'conflict') {
    let note: string | undefined;
    let emailTaken = false;
    if (disabled) note = 'A conta está desativada no Active Directory e não será importada.';
    else if (s.trigger !== 'login' && !cfg.importNewUsers) note = 'A importação de novos usuários está desligada.';
    else if (email && (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]))) {
      emailTaken = true;
      note = `O e-mail ${email} já é usado por outra conta; a conta não será criada.`;
    }
    p.account = { exists: false, action: note ? 'skip' : 'create', activeAfter: !note, note };
    // Fora da prévia, a conta nova que não entra para por aqui (sem buscar grupos).
    if (!dry && emailTaken) {
      // Erro, não só "ignorada": alguém do diretório ficou sem conta e o administrador precisa resolver.
      const message = `O e-mail ${email} já é usado por outra conta; a conta não foi criada.`;
      log.issue({ login: username, dn: entry.dn, message });
      return { status: 'failed', user: null, reason: message, preview: p };
    }
    if (!dry && note) return skip(note);
  }

  // Grupos: antes de criar a conta, porque os papéis iniciais dependem deles.
  const mapping = cfg.roleMapping || cfg.channelMapping || cfg.teamMapping;
  const gf = groupFilterTemplate(cfg);
  p.nestedApplied = gf.nestedApplied;
  if (gf.warning && (mapping || dry)) warn(gf.warning);
  // groups null: não mapeia nada para esta pessoa (busca falhou ou regra ambígua); ela fica como está.
  let groups: LdapGroupRef[] | null = [];
  let ambiguous: AmbiguousKey | undefined;
  if (mapping || dry) {
    try {
      groups = await s.groupsOf(entry);
      p.groups = groups;
      ambiguous = groups.length ? ambiguousMatch(await ambiguousOf(s), groups) : undefined;
    } catch (e) {
      groups = null;
      p.groupError = `Falha ao buscar grupos: ${ldapErrorText(e)}`;
    }
    if (ambiguous) {
      groups = null;
      p.groupError = `A regra "${ambiguous.key}" serve para mais de um grupo do diretório (${ambiguous.dns.join('; ')}): use "group:<DN do grupo>" para dizer qual. Enquanto isso, a sincronização não mexe nos papéis, canais e times de quem está nesses grupos.`;
    }
    if (p.groupError && !dry) log.issue({ login: username, dn: entry.dn, message: p.groupError });
  }
  // Conta nova sem os grupos: não dá para saber os papéis, então a sincronização não cria (e a prévia diz o mesmo).
  const newWithoutGroups = isNew && !groups && cfg.roleMapping && p.account.action === 'create';
  if (newWithoutGroups) {
    const note = ambiguous
      ? 'Com uma regra ambígua não dá para saber os papéis: a conta não será criada até a regra ser corrigida.'
      : 'Sem os grupos não dá para saber os papéis: a conta não será criada agora (a próxima sincronização tenta de novo).';
    p.account = { exists: false, action: 'skip', activeAfter: false, note };
  }
  const matched: LdapRuleKey[] = groups ? matchKeys(cfg, entry.dn, groups) : [];
  p.matched = matched.map((k) => ({ key: k.key, kind: k.kind, roles: cfg.roleMap[k.key] ?? [], channels: cfg.channelMap[k.key] ?? [], teams: cfg.teamMap[k.key] ?? [] }));
  for (const [on, label, list] of [
    [cfg.roleMapping, 'papéis', 'roles'],
    [cfg.channelMapping, 'canais', 'channels'],
    [cfg.teamMapping, 'times', 'teams'],
  ] as const) {
    if (dry && !on && p.matched.some((m) => m[list].length)) warn(`O mapeamento de ${label} está desligado: os ${label} das regras não são aplicados.`);
  }
  for (const w of cfg.warnings) warn(w);

  s.context ??= await buildContext(cfg, log);
  const ctx = s.context;

  // Papéis
  const current: string[] = user?.roles ?? [];
  const validDefaults = cfg.defaultRoles.filter((r) => ctx.roleScopes.get(r) === 'Users');
  let next = newWithoutGroups ? [] : isNew ? validDefaults : current;
  let rolesPlanned = false;
  if (cfg.roleMapping && groups) {
    const input = {
      current,
      matchedKeys: matched.map((k) => k.key),
      roleMap: cfg.roleMap,
      defaultRoles: cfg.defaultRoles,
      skipRestricted: cfg.defaultRolesSkipRestricted,
      autoRemove: cfg.rolesAutoRemove,
      roleScopes: ctx.roleScopes,
      restrictedRoles: ctx.restricted,
      lastActiveAdmin: false,
      username,
    };
    let plan = planRoles(input);
    if (user && plan.removed.includes('admin') && (await isLastActiveAdmin(user.id))) plan = planRoles({ ...input, lastActiveAdmin: true });
    plan.warnings.forEach(warn);
    next = plan.next;
    rolesPlanned = true;
  }
  // Conta nova sempre tem algum papel (o mesmo que createUser faria).
  if (isNew && !newWithoutGroups && !next.length) next = ['user'];
  p.roles = { before: current, after: next, added: next.filter((r) => !current.includes(r)), removed: current.filter((r) => !next.includes(r)) };
  const rules = currentDirectRules();
  p.direct = { restricted: next.some((r) => rules.restrictedRoles.includes(r)), exempt: next.some((r) => rules.exemptRoles.includes(r)) };

  // Estado ativo
  let active = user ? !!user.active : true;
  let activation: 'deactivate' | 'reactivate' | 'clear' | null = null;
  if (user) {
    // A marca só fica numa conta inativa enquanto ninguém mudou "Ativo" à mão (updateUser apaga a marca).
    const bySync = !user.active && !!user.ldap_deactivated_at;
    if (disabled && cfg.syncAdDisabled && user.active) activation = 'deactivate';
    else if (!disabled && bySync && cfg.reactivateUsers) activation = 'reactivate';
    else if (user.ldap_deactivated_at && (user.active || !bySync)) activation = 'clear';
    if (activation === 'deactivate') active = false;
    if (activation === 'reactivate') active = true;
    p.account.activeAfter = active;
    if (activation === 'deactivate') p.account.note = 'A conta será desativada: está desativada no Active Directory.';
    if (activation === 'reactivate') p.account.note = 'A conta será reativada.';
    else if (!user.active && !disabled && !bySync) p.account.note = 'A conta foi desativada à mão no chat e continua desativada (a sincronização não reativa).';
  }
  if (isNew && p.account.action !== 'create') active = false;

  // Canais e times (planos; nada é gravado ainda)
  // Na ordem de cada mapa, para o histórico ler como a configuração.
  const matchedKeys = new Set(matched.map((k) => k.key));
  const fromMap = (map: Record<string, string[]>) => Object.entries(map).flatMap(([k, v]) => (matchedKeys.has(k) ? v : []));
  const channelDesired = cfg.channelMapping && groups ? uniqueName(fromMap(cfg.channelMap).map(channelName)).filter((n) => ctx.channels.has(n.toLowerCase())) : [];
  const teamDesired = cfg.teamMapping && groups ? uniqueName(fromMap(cfg.teamMap).map((n) => n.trim())) : [];
  const channelTargets = [...ctx.channels.values()];
  const teamTargets = [...ctx.teams.values()];
  const subs = user
    ? await many<{ room_id: string; roles: string[] }>('SELECT room_id, roles FROM subscriptions WHERE user_id = $1 AND room_id = ANY($2::text[])', [
        user.id,
        [...channelTargets.map((t) => t.id), ...teamTargets.map((t) => t.roomId)].filter(Boolean),
      ])
    : [];
  const subRoles = new Map(subs.map((r) => [r.room_id, r.roles ?? []]));
  const channelPlan =
    cfg.channelMapping && groups
      ? planMembership({
          desired: channelDesired,
          managed: channelTargets,
          memberOf: new Set(subs.map((r) => r.room_id)),
          protectedIds: new Set(subs.filter((r) => r.roles?.length).map((r) => r.room_id)),
          autoRemove: cfg.channelsAutoRemove,
          active,
        })
      : null;
  const teamMembers = user && teamTargets.some((t) => t.id)
    ? new Set((await many('SELECT team_id FROM team_members WHERE user_id = $1 AND team_id = ANY($2::text[])', [user.id, teamTargets.map((t) => t.id).filter(Boolean)])).map((r) => r.team_id))
    : new Set<string>();
  const teamPlan =
    cfg.teamMapping && groups
      ? planMembership({
          desired: teamDesired,
          managed: teamTargets,
          memberOf: teamMembers,
          protectedIds: new Set(teamTargets.filter((t) => t.id && t.roomId && subRoles.get(t.roomId)?.length).map((t) => t.id!)),
          autoRemove: cfg.teamsAutoRemove,
          active,
        })
      : null;
  if (channelPlan) {
    p.channels = { join: [...channelPlan.join.map((t) => t.name), ...channelPlan.missing], leave: channelPlan.leave.map((t) => t.name), create: channelPlan.missing };
  }
  if (teamPlan) {
    p.teams = { join: teamPlan.join.map((t) => t.name), leave: teamPlan.leave.map((t) => t.name), missing: teamPlan.missing };
  }
  // Só na prévia: fora dela, applyLdapAvatar avisa (já com o nome da conta criada).
  if (dry && cfg.syncAvatar) {
    const a = planLdapAvatar(user ?? { username }, photo);
    if (a.action === 'none' && a.warning) warn(a.warning);
  }
  if (dry || p.account.action === 'conflict') return { status: user ? 'updated' : 'skipped', user, preview: p };

  // ---------- Gravação ----------
  // O erro dos grupos já está na execução; a próxima tenta de novo.
  if (newWithoutGroups) return { status: 'failed', user: null, reason: p.groupError, preview: p };
  let changed = false;
  let publish = false;
  if (isNew) {
    user = await createUser({ username, name, email, roles: next, authSource: 'ldap', externalId: uid, verified: true, skipPasswordPolicy: true });
    user = await one('UPDATE users SET ldap_dn = $2, ldap_synced_at = now() WHERE id = $1 RETURNING *', [user.id, entry.dn]);
    log.counts.imported++;
    log.change(username, 'created', `Conta criada com ${next.length > 1 ? 'os papéis' : 'o papel'} ${next.join(', ')}`);
  } else {
    const details: string[] = [];
    if (linked) details.push('conta local vinculada ao LDAP');
    if (name !== user.name) details.push(`nome: “${user.name}” → “${name}”`);
    let newEmail = user.email;
    if (email && email.toLowerCase() !== String(user.email ?? '').toLowerCase()) {
      if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, user.id])) {
        warn(`O e-mail ${email} de @${user.username} já é usado por outra conta; o e-mail não foi alterado.`);
      } else {
        details.push(`e-mail: ${user.email ?? '(nenhum)'} → ${email}`);
        newEmail = email;
      }
    }
    if (user.ldap_dn && normalizeDn(user.ldap_dn) !== normalizeDn(entry.dn)) {
      const from = ouLabel(parentDn(user.ldap_dn));
      const to = ouLabel(parentDn(entry.dn));
      details.push(from !== to ? `OU: ${from} → ${to}` : `DN: ${user.ldap_dn} → ${entry.dn}`);
    }
    const touched = details.length > 0 || user.auth_source !== 'ldap';
    const row = await one(
      `UPDATE users SET name = $2, email = $3, auth_source = 'ldap', external_id = $4, ldap_dn = $5, ldap_synced_at = now()${touched ? ', updated_at = now()' : ''}
       WHERE id = $1 RETURNING *`,
      [user.id, name, newEmail, uid, entry.dn],
    );
    if (name !== user.name) {
      await query('UPDATE messages SET user_name = $2 WHERE user_id = $1', [user.id, name]);
      publish = true;
    }
    if (details.length) {
      changed = true;
      log.change(user.username, 'profile', details.join('; '));
    }
    if (linked) log.counts.imported++;
    else log.counts.updated++;
    const before = user;
    user = row;
    if (activation === 'deactivate') {
      user = await deactivate(s, user, 'disabled');
      changed = true;
    } else if (activation === 'reactivate') {
      // Só se a marca ainda está lá: o administrador pode ter mudado "Ativo" enquanto esta entrada era processada.
      const row = await one(
        `UPDATE users SET active = true, ldap_deactivated_at = NULL, ldap_deactivated_reason = NULL, updated_at = now()
         WHERE id = $1 AND NOT active AND ldap_deactivated_at IS NOT NULL RETURNING *`,
        [user.id],
      );
      if (row) {
        user = row;
        await audit(s.actor, 'ldap.user.reactivated', { userId: user.id, username: user.username }, { reason: before.ldap_deactivated_reason });
        log.counts.reactivated++;
        log.change(user.username, 'reactivated', before.ldap_deactivated_reason === 'disabled' ? 'Conta reativada no Active Directory' : 'Voltou à busca do LDAP');
        changed = true;
        publish = true;
      }
    } else if (activation === 'clear') {
      user = await one('UPDATE users SET ldap_deactivated_at = NULL, ldap_deactivated_reason = NULL WHERE id = $1 RETURNING *', [user.id]);
    }
    if (rolesPlanned && p.roles.added.length + p.roles.removed.length > 0) {
      user = await one('UPDATE users SET roles = $2, updated_at = now() WHERE id = $1 RETURNING *', [user.id, next]);
      log.counts.rolesChanged++;
      log.change(user.username, 'roles', [...p.roles.added.map((r) => `+${r}`), ...p.roles.removed.map((r) => `−${r}`)].join(' '));
      changed = true;
      publish = true;
    }
  }

  if (channelPlan) {
    const added = new Map<string, string>(); // nome → texto do histórico, na ordem do mapa
    const removed: string[] = [];
    for (const missing of channelPlan.missing) {
      const t = ctx.channels.get(missing.toLowerCase());
      if (!t) continue;
      try {
        const room = await createRoom(null, { type: 'p', name: t.name, skipPermission: true });
        if (ctx.channelOwner) {
          await query('UPDATE rooms SET owner_id = $2 WHERE id = $1', [room.id, ctx.channelOwner.id]);
          await addUserToRoom(room.id, ctx.channelOwner.id, { roles: ['owner'], silent: true });
        }
        t.id = room.id;
        channelPlan.join.push(t);
        added.set(t.name.toLowerCase(), `#${t.name} (criado)`);
      } catch (e) {
        warn(`Não foi possível criar o canal #${t.name}: ${errorText(e)}`);
      }
    }
    const joined = new Set<string>();
    for (const t of channelPlan.join) {
      try {
        await addUserToRoom(t.id!, user.id, { silent: true });
        joined.add(t.name.toLowerCase());
        log.counts.channelsAdded++;
      } catch (e) {
        warn(`Não foi possível adicionar @${user.username} ao canal #${t.name}: ${errorText(e)}`);
      }
    }
    for (const t of channelPlan.leave) {
      await removeUserFromRoom(t.id!, user.id, { silent: true });
      removed.push(`#${t.name}`);
      log.counts.channelsRemoved++;
    }
    const entered = channelDesired
      .filter((n) => joined.has(n.toLowerCase()))
      .map((n) => added.get(n.toLowerCase()) ?? `#${ctx.channels.get(n.toLowerCase())?.name ?? n}`);
    if (entered.length || removed.length) {
      log.change(user.username, 'channels', [...entered.map((x) => `+${x}`), ...removed.map((x) => `−${x}`)].join(' '));
      if (!isNew) changed = true;
    }
  }

  if (teamPlan) {
    const added: string[] = [];
    const removed: string[] = [];
    for (const team of teamPlan.join as TeamTarget[]) {
      if (!team.roomId) continue;
      try {
        await addUserToRoom(team.roomId, user.id, { silent: true });
        // Como na inclusão pela tela: entra também nas salas padrão do time.
        const defaults = await many(`SELECT id FROM rooms WHERE team_id = $1 AND NOT team_main AND NOT archived AND (custom_fields->>'teamDefault')::boolean`, [team.id]);
        for (const r of defaults) await addUserToRoom(r.id, user.id, { silent: true }).catch(() => {});
        added.push(team.name);
        log.counts.teamsAdded++;
      } catch (e) {
        warn(`Não foi possível adicionar @${user.username} ao time ${team.name}: ${errorText(e)}`);
      }
    }
    for (const team of teamPlan.leave as TeamTarget[]) {
      if (!team.roomId) continue;
      await removeUserFromRoom(team.roomId, user.id, { silent: true });
      removed.push(team.name);
      log.counts.teamsRemoved++;
    }
    if (added.length || removed.length) {
      log.change(user.username, 'teams', [...added.map((x) => `+${x}`), ...removed.map((x) => `−${x}`)].join(' '));
      if (!isNew) changed = true;
    }
  }

  if (cfg.syncAvatar) {
    try {
      const fresh = await one('SELECT id, username, avatar_etag, ldap_avatar_hash, ldap_avatar_etag FROM users WHERE id = $1', [user.id]);
      const r = await applyLdapAvatar(fresh, photo);
      if (r.warning) warn(r.warning);
      if (r.result) {
        log.counts.avatars++;
        log.change(user.username, 'avatar', r.result === 'applied' ? 'Foto do diretório aplicada' : 'Foto do diretório removida');
        if (!isNew) changed = true;
      }
    } catch (e) {
      warn(`Foto de @${user.username} ignorada: ${errorText(e)}`);
    }
  }

  if (changed && !linked) log.counts.changed++;
  user = await one('SELECT * FROM users WHERE id = $1', [user.id]);
  if (publish) bus.publish({ all: true }, { type: 'user', action: 'updated', user: mapUser(user) });
  return { status: isNew ? 'created' : 'updated', user, preview: p };
}

// Compatível com os chamadores antigos (testes): grupos como texto viram { dn, cn }.
export async function upsertFromEntry(entry: Entry, groups: (string | LdapGroupRef)[] = []) {
  const refs = groups.map((g) => (typeof g === 'string' ? { dn: g, cn: g } : g));
  const r = await syncEntry({ cfg: loadLdapConfig(), trigger: 'login', log: new RunLog(), actor: SYSTEM, groupsOf: async () => refs }, entry);
  return r.user;
}

// ---------- Execução completa ----------

interface BegunRun {
  runId: string;
  trigger: LdapTrigger;
  startedBy: string | null;
  release: () => Promise<void>;
}

async function beginRun(trigger: LdapTrigger, startedBy: string | null): Promise<BegunRun> {
  const release = await tryLdapLock();
  if (!release) throw new ApiError(409, 'error-ldap-sync-running', 'Já existe uma sincronização do LDAP em andamento.');
  try {
    return { runId: await insertRun(trigger, startedBy), trigger, startedBy, release };
  } catch (e) {
    await release();
    throw e;
  }
}

interface SeenDn {
  username: string;
  email: string | null;
}

// seenDn: DN (forma antiga do identificador) → nome e e-mail da entrada; vale com um dos dois, como em findAccount.
async function deactivateRemoved(s: SyncScope, seen: Set<string>, seenDn: Map<string, SeenDn>) {
  const local = await many(`SELECT * FROM users WHERE auth_source = 'ldap' AND active`);
  const sameDn = (u: any) => {
    const d = seenDn.get(u.external_id);
    return !!d && (d.username === String(u.username).toLowerCase() || (!!d.email && d.email === String(u.email ?? '').toLowerCase()));
  };
  const gone = local.filter((u) => !seen.has(u.external_id) && !sameDn(u));
  if (!gone.length) return;
  const limit = s.cfg.maxDeactivationPercent;
  // Uma busca vazia ou que perde gente demais costuma ser Base DN ou filtro errado, não uma demissão em massa.
  if (seen.size === 0 || (limit > 0 && local.length >= 10 && gone.length * 100 > limit * local.length)) {
    s.log.warn(`Desativação interrompida: ${gone.length} de ${local.length} usuários do LDAP sumiram da busca (limite ${limit}%). Confira o Base DN e o filtro de usuários.`);
    s.log.guardFired = true;
    return;
  }
  for (const u of gone) {
    try {
      await deactivate(s, u, 'removed');
    } catch (e) {
      s.log.issue({ login: u.username, message: `Falha ao desativar: ${errorText(e)}` });
    }
  }
}

async function executeRun(b: BegunRun, opts: { source?: LdapSource; cfg?: LdapConfig } = {}): Promise<LdapSyncRun> {
  const log = new RunLog();
  let fatal: string | null = null;
  let source: LdapSource | null = null;
  let actor: Actor = SYSTEM;
  try {
    if (b.startedBy && b.trigger !== 'cron') {
      const u = await one('SELECT id, username FROM users WHERE id = $1', [b.startedBy]);
      if (u) actor = { id: u.id, username: u.username };
    }
    const cfg = opts.cfg ?? loadLdapConfig();
    source = opts.source ?? directorySource(cfg);
    const src = source;
    const scope: SyncScope = { cfg, trigger: b.trigger, log, actor, groupsOf: (e) => src.groupsOf(e), groupsNamed: src.groupsNamed && ((n) => src.groupsNamed!(n)) };
    for (const w of cfg.warnings) log.warn(w);
    const gf = groupFilterTemplate(cfg);
    if (gf.warning && (cfg.roleMapping || cfg.channelMapping || cfg.teamMapping)) log.warn(gf.warning);
    // Contas reativadas à mão deixam de contar como desativadas pela sincronização.
    await query(`UPDATE users SET ldap_deactivated_at = NULL, ldap_deactivated_reason = NULL WHERE ldap_deactivated_at IS NOT NULL AND active`);
    const seen = new Set<string>();
    const seenDn = new Map<string, SeenDn>();
    try {
      for await (const page of source.users()) {
        for (const entry of page) {
          log.counts.seen++;
          // Também as entradas que não são pessoas: assim nunca contam como removidas.
          seen.add(entryUid(entry, cfg));
          for (const u of legacyUids(entry, cfg)) {
            if (u === entry.dn) {
              seenDn.set(u, {
                username: sanitizeUsername(entryAttr(entry, cfg.usernameFields) ?? '').toLowerCase(),
                email: entryAttr(entry, cfg.emailFields)?.trim().toLowerCase() || null,
              });
            } else seen.add(u);
          }
          try {
            await syncEntry(scope, entry);
          } catch (e) {
            log.issue({ login: entryAttr(entry, cfg.usernameFields), dn: entry.dn, message: errorText(e) });
          }
        }
        await saveProgress(b.runId, log);
      }
    } catch (e) {
      fatal = `Falha ao ler o diretório: ${ldapErrorText(e)}`;
    }
    if (!fatal && cfg.syncActiveState) await deactivateRemoved(scope, seen, seenDn);
  } catch (e) {
    fatal ??= errorText(e);
    logError('sincronização interrompida', e);
  } finally {
    await source?.close().catch(() => {});
  }
  const status: LdapRunStatus = fatal ? 'failed' : log.counts.errors > 0 || log.guardFired ? 'partial' : 'success';
  try {
    await finishRun(b.runId, status, log, fatal);
    await audit(actor, 'ldap.sync', {}, { runId: b.runId, trigger: b.trigger, status, ...log.counts });
  } finally {
    await b.release();
  }
  return (await getRun(b.runId))!;
}

// Roda e espera o fim (testes, API legada). Ocupado → 409.
export async function runSync(opts: { trigger: LdapTrigger; startedBy?: string | null; source?: LdapSource; cfg?: LdapConfig }): Promise<LdapSyncRun> {
  const b = await beginRun(opts.trigger, opts.startedBy ?? null);
  return executeRun(b, opts);
}

// Botão "Sincronizar agora": devolve a execução em milissegundos e continua em segundo plano.
export async function startBackgroundSync(ctx: Ctx, source?: LdapSource): Promise<LdapSyncRun> {
  const b = await beginRun('manual', ctx.userId);
  const run = await getRun(b.runId);
  setImmediate(() => void executeRun(b, { source }).catch((e) => logError('sincronização em segundo plano', e)));
  return run!;
}

export async function runScheduledLdapSync(log: (m: string) => void) {
  const cfg = loadLdapConfig();
  if (!cfg.enabled) return;
  let b: BegunRun;
  try {
    b = await beginRun('cron', null);
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 409) return; // outra instância (ou o botão) já está sincronizando
    log(`sincronização LDAP falhou: ${errorText(e)}`);
    return;
  }
  try {
    const run = await executeRun(b, { cfg });
    const c = run.counts;
    if (run.status === 'failed') log(`sincronização LDAP falhou: ${run.error}`);
    else log(`LDAP: ${c.imported} importados, ${c.updated} atualizados, ${c.deactivated} desativados, ${c.reactivated} reativados, ${c.errors} erros`);
  } catch (e) {
    log(`sincronização LDAP falhou: ${errorText(e)}`);
  }
}

// ---------- Prévia e busca no diretório (tela de administração) ----------

const connectionError = (e: unknown) => badRequest('error-ldap-connection', `Falha na conexão: ${ldapErrorText(e)}`);

// Mesmo caminho da sincronização, sem gravar nada, com as configurações salvas mais as não salvas (overrides).
export async function testMapping(login: string, overrides?: Record<string, unknown> | null): Promise<LdapMappingTest> {
  const cfg = loadLdapConfig(overrides);
  // A senha salva (que nem o administrador vê) só vai para o servidor salvo: senão uma prévia com outra URL a
  // entregaria a qualquer servidor, sem nada salvo nem auditado.
  const saved = loadLdapConfig();
  const target = (c: LdapConfig) => JSON.stringify([c.url, c.bindDn, c.rejectUnauthorized, c.caPem]);
  const typed = overrides?.LDAP_Authentication_Password;
  const passwordTyped = typeof typed === 'string' && typed !== '' && typed !== '********';
  if (saved.bindPassword && !passwordTyped && target(cfg) !== target(saved)) {
    throw badRequest(
      'error-invalid-params',
      'Para testar outra conexão (URL, certificado ou usuário de serviço), informe a senha do usuário de serviço ou salve a conexão antes: a senha salva só vai para o servidor salvo.',
    );
  }
  let client;
  try {
    client = openClient(cfg);
  } catch (e) {
    throw connectionError(e);
  }
  try {
    let entries: Entry[];
    try {
      await bindService(client, cfg);
      entries = await findEntries(client, cfg, login);
    } catch (e) {
      throw connectionError(e);
    }
    if (entries.length !== 1) {
      const p = emptyPreview(login);
      p.nestedApplied = groupFilterTemplate(cfg).nestedApplied;
      p.warnings = [...cfg.warnings];
      p.message = entries.length
        ? `O login "${login}" corresponde a ${entries.length} entradas; o login seria recusado.`
        : `Nenhuma entrada encontrada para "${login}" com o filtro de usuários atual.`;
      return p;
    }
    const c = client;
    const r = await syncEntry(
      { cfg, trigger: 'manual', dryRun: true, log: new RunLog(), actor: SYSTEM, groupsOf: (e) => groupsOf(c, cfg, e), groupsNamed: (n) => groupsNamed(c, cfg, n) },
      entries[0],
    );
    return { ...r.preview, login };
  } finally {
    await client.unbind().catch(() => {});
  }
}

export async function searchDirectory(kind: 'group' | 'ou', text: string) {
  const cfg = loadLdapConfig();
  const t = text.trim() ? `*${escapeFilter(text.trim())}*` : '*';
  const filter =
    kind === 'group' ? `(&(|(objectClass=group)(objectClass=groupOfNames))(|(cn=${t})(sAMAccountName=${t})))` : `(&(objectClass=organizationalUnit)(ou=${t}))`;
  let client;
  try {
    client = openClient(cfg);
  } catch (e) {
    throw connectionError(e);
  }
  try {
    await bindService(client, cfg);
    const { searchEntries } = await client.search(kind === 'group' ? cfg.groupBaseDn : cfg.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['cn', 'ou', 'description'],
      paged: { pageSize: 200 },
    });
    // O Samba ignora sizeLimit: o corte é feito aqui.
    return searchEntries.slice(0, 50).map((e) => {
      const item: { dn: string; name: string; kind: 'group' | 'ou'; description?: string } = {
        dn: e.dn,
        name: entryAttr(e, kind === 'group' ? 'cn' : 'ou') ?? e.dn,
        kind,
      };
      const description = entryAttr(e, 'description');
      if (description) item.description = description;
      return item;
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw connectionError(e);
  } finally {
    await client.unbind().catch(() => {});
  }
}
