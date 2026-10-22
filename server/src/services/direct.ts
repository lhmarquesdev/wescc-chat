import {
  blockedPair,
  bringInBlockMessage,
  checkDirect,
  directBlockMessage,
  isExempt,
  isRestricted,
  type BringInMode,
  type DirectAction,
  type DirectParty,
  type DirectRestrictionReport,
  type DirectRules,
  type DirectVerdict,
} from '@shared/direct';
import type { RoomDirectPolicy } from '@shared/index';
import { many, one } from '../db/pool';
import { ApiError } from '../lib/errors';
import { restrictedRoleIds, roleScope, rolesWithPermission } from './permissions';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Conversas diretas entre pessoas com papel restrito. Veredictos e textos vêm só de @shared/direct,
// os mesmos que a web usa para avisar antes do clique; os papéis de quem age vêm sempre do banco.

export function currentDirectRules(): DirectRules {
  return {
    restrictedRoles: restrictedRoleIds(),
    exemptRoles: rolesWithPermission('start-dm-between-restricted'),
    scope: getSetting('Direct_Restriction_Scope') === 'same_role' ? 'same_role' : 'any',
  };
}

// Quem está desativado continua restrito, mas não abre exceção: quem saiu não mantém liberada a conversa dos outros.
export function partyOf(r: { id: string; username: string; roles: string[] | null; active?: boolean }): DirectParty {
  const roles = r.roles ?? [];
  if (r.active !== false) return { _id: r.id, username: r.username, roles };
  const exempt = rolesWithPermission('start-dm-between-restricted');
  return { _id: r.id, username: r.username, roles: roles.filter((x) => !exempt.includes(x)) };
}

export async function loadParties(ids: string[]): Promise<DirectParty[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return (await many('SELECT id, username, roles, active FROM users WHERE id = ANY($1)', [unique])).map(partyOf);
}

// Discussão criada numa DM: junta as mesmas pessoas, então quem participa da DM segue a regra dela também ali.
export async function directParentFor(ctx: Ctx, room: any): Promise<any | null> {
  if (!room?.prid || room.t === 'd') return null;
  const parent = await one(`SELECT * FROM rooms WHERE id = $1 AND t = 'd'`, [room.prid]);
  return parent?.uids.includes(ctx.userId) ? parent : null;
}

export function directError(v: DirectVerdict, viewer: string): ApiError {
  return new ApiError(403, 'error-direct-restricted', directBlockMessage(v, viewer), { action: v.action, usernames: v.pair });
}

// Veredicto de quem age diante dos demais participantes (parties precisa incluir quem age).
function judge(action: DirectAction, ctx: Ctx, parties: DirectParty[], rules: DirectRules) {
  const actor = parties.find((p) => p._id === ctx.userId) ?? { _id: ctx.userId, username: ctx.username, roles: [] };
  const v = checkDirect(action, actor, parties.filter((p) => p._id !== ctx.userId), rules);
  return { v, text: v.allowed ? '' : directBlockMessage(v, actor.username), viewer: actor.username };
}

export async function assertCanStartDirect(ctx: Ctx, otherIds: string[]): Promise<void> {
  if (!restrictedRoleIds().length) return;
  const { v, viewer } = judge('start', ctx, await loadParties([ctx.userId, ...otherIds]), currentDirectRules());
  if (!v.allowed) throw directError(v, viewer);
}

// DM, ou discussão criada numa DM. parties: participantes já lidos por quem chama (canPostInRoom), para não consultar o banco de novo.
export async function assertCanSendDirect(ctx: Ctx, room: any, parties?: DirectParty[]): Promise<void> {
  if (!restrictedRoleIds().length) return;
  if (room?.t !== 'd') {
    const parent = await directParentFor(ctx, room);
    if (parent) await assertCanSendDirect(ctx, parent);
    return;
  }
  if (!parties?.some((p) => p._id === ctx.userId)) parties = await loadParties([ctx.userId, ...room.uids]);
  const { v, viewer } = judge('send', ctx, parties, currentDirectRules());
  if (!v.allowed) throw directError(v, viewer);
}

export async function assertCanCall(ctx: Ctx, room: any): Promise<void> {
  if (room?.t !== 'd' || !restrictedRoleIds().length) return;
  const { v, viewer } = judge('call', ctx, await loadParties([ctx.userId, ...room.uids]), currentDirectRules());
  if (!v.allowed) throw directError(v, viewer);
}

// Sala que só os membros leem: grupo privado (com as discussões de grupos e de DMs) ou canal de um time privado.
async function isPrivateRoom(room: { t: string; team_id?: string | null; team_main?: boolean }) {
  if (room.t === 'p') return true;
  if (room.t !== 'c' || !room.team_id || room.team_main) return false;
  return (await one('SELECT type FROM teams WHERE id = $1', [room.team_id]))?.type === 1;
}

// Os textos vêm de @shared/direct (a web avisa antes do clique com os mesmos).
function bringInError(x: DirectParty, y: DirectParty, inviter: DirectParty, mode: BringInMode): ApiError {
  const withInviter = y._id === inviter._id;
  const usernames = withInviter && !mode.joinerId ? [y.username, x.username] : [x.username, y.username];
  return new ApiError(403, 'error-direct-restricted', bringInBlockMessage(x, y, inviter, mode), { action: 'start', usernames });
}

// Quem tem papel restrito, sem a exceção, não leva outra pessoa restrita para uma sala privada: seria uma conversa
// particular entre restritos sem um dono que responda por ela (§3.5). Vale para convites, membros na criação, times,
// links de convite e para tornar privada uma sala em que já estão. Canal público fica de fora: todos leem.
// Sem room.id (sala que ainda não existe, ou que vai virar privada) todos os userIds contam como novos.
export async function assertCanBringIn(
  inviterId: string,
  room: { id?: string; t: string; team_id?: string | null; team_main?: boolean },
  userIds: string[],
  mode: BringInMode = {},
): Promise<void> {
  const restricted = restrictedRoleIds();
  let ids = [...new Set(userIds)].filter((id) => id !== inviterId);
  if (!restricted.length || !ids.length || !(await isPrivateRoom(room))) return;
  const rules = currentDirectRules();
  const [inviter] = await loadParties([inviterId]);
  if (!inviter || !isRestricted(inviter, rules) || isExempt(inviter, rules)) return;
  // Quem já está na sala não muda nada.
  if (room.id) {
    const inside = new Set((await many('SELECT user_id FROM subscriptions WHERE room_id = $1 AND user_id = ANY($2)', [room.id, ids])).map((r) => r.user_id));
    ids = ids.filter((id) => !inside.has(id));
  }
  const found = new Map((await loadParties(ids)).map((p) => [p._id, p]));
  const newcomers = ids.map((id) => found.get(id)).filter((p): p is DirectParty => !!p && isRestricted(p, rules));
  let members: DirectParty[] | null = null;
  for (let i = 0; i < newcomers.length; i++) {
    const x = newcomers[i];
    let y = [inviter, ...newcomers.slice(0, i)].find((p) => blockedPair([x, p], rules));
    // Com same_role o par pode ser com quem já está na sala.
    if (!y && rules.scope === 'same_role' && room.id) {
      members ??= (
        await many(
          'SELECT u.id, u.username, u.roles, u.active FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.room_id = $1 AND u.roles && $2 AND u.id <> $3',
          [room.id, restricted, inviterId],
        )
      ).map(partyOf);
      y = members.find((p) => blockedPair([x, p], rules));
    }
    if (y) throw bringInError(x, y, inviter, mode);
  }
}

export async function directPolicyFor(ctx: Ctx, room: any): Promise<RoomDirectPolicy> {
  if (room?.t !== 'd' || !restrictedRoleIds().length) return { canSend: true, canCall: true };
  const parties = await loadParties([ctx.userId, ...room.uids]);
  const rules = currentDirectRules();
  const send = judge('send', ctx, parties, rules);
  const call = judge('call', ctx, parties, rules);
  const out: RoomDirectPolicy = { canSend: send.v.allowed, canCall: call.v.allowed };
  if (!send.v.allowed) out.sendBlockedReason = send.text;
  if (!call.v.allowed) out.callBlockedReason = call.text;
  return out;
}

// Em lote, para calls.list: pode ligar de novo para quem está em cada conversa?
export async function callPolicies(ctx: Ctx, roomIds: string[]): Promise<Map<string, { canCall: boolean; reason?: string }>> {
  const out = new Map<string, { canCall: boolean; reason?: string }>();
  const ids = [...new Set(roomIds)];
  if (!restrictedRoleIds().length) {
    for (const id of ids) out.set(id, { canCall: true });
    return out;
  }
  const rooms = ids.length ? await many(`SELECT id, uids FROM rooms WHERE id = ANY($1) AND t = 'd'`, [ids]) : [];
  const parties = new Map((await loadParties([ctx.userId, ...rooms.flatMap((r) => r.uids)])).map((p) => [p._id, p]));
  const rules = currentDirectRules();
  for (const r of rooms) {
    const { v, text } = judge('call', ctx, [ctx.userId, ...r.uids].map((id: string) => parties.get(id)).filter((p): p is DirectParty => !!p), rules);
    out.set(r.id, v.allowed ? { canCall: true } : { canCall: false, reason: text });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { canCall: true });
  return out;
}

// Permissões que deixam duas pessoas restritas conversarem em particular fora das mensagens diretas.
const LOOPHOLE_PERMISSIONS = ['create-p', 'create-team', 'start-discussion', 'start-discussion-other-user'];

export async function directRestrictionReport(): Promise<DirectRestrictionReport> {
  const rules = currentDirectRules();
  const report: DirectRestrictionReport = {
    scope: rules.scope,
    restrictedRoles: [],
    exemptRoles: rules.exemptRoles.filter((r) => roleScope(r) === 'Users'),
    loopholes: [],
    blockedDirects: 0,
  };
  const restricted = rules.restrictedRoles;
  if (!restricted.length) return report;

  const roles = await many(
    `SELECT r.id, r.description, (SELECT count(*)::int FROM users u WHERE u.active AND r.id = ANY(u.roles)) AS users
     FROM roles r WHERE r.id = ANY($1) ORDER BY r.id`,
    [restricted],
  );
  report.restrictedRoles = roles.map((r) => ({ _id: r.id, description: r.description, users: r.users }));

  for (const permission of LOOPHOLE_PERMISSIONS) {
    const grants = rolesWithPermission(permission).filter((r) => roleScope(r) === 'Users');
    if (!grants.length) continue;
    const found = await one(
      `SELECT count(*)::int AS n,
         (SELECT array_agg(DISTINCT x ORDER BY x) FROM users v, unnest(v.roles) x WHERE v.active AND v.roles && $1 AND x = ANY($2)) AS via
       FROM users u WHERE u.active AND u.roles && $1 AND u.roles && $2`,
      [restricted, grants],
    );
    if (!found?.n) continue;
    const sample = await many(`SELECT id, username, name FROM users WHERE active AND roles && $1 AND roles && $2 ORDER BY username LIMIT 10`, [restricted, grants]);
    report.loopholes.push({
      permission,
      viaRoles: found.via ?? [],
      users: found.n,
      sample: sample.map((s) => ({ _id: s.id, username: s.username, name: s.name || undefined })),
    });
  }

  // DMs que já existiam e hoje não aceitam mensagens (só as que têm ao menos duas pessoas restritas).
  const restrictedIds = (await many('SELECT id FROM users WHERE roles && $1', [restricted])).map((u) => u.id);
  if (restrictedIds.length < 2) return report;
  const dms = await many(
    `SELECT uids FROM rooms WHERE t = 'd' AND uids && $1::text[]
       AND (SELECT count(*) FROM unnest(uids) x WHERE x = ANY($1::text[])) >= 2
     LIMIT 5000`,
    [restrictedIds],
  );
  const parties = new Map((await loadParties(dms.flatMap((d) => d.uids))).map((p) => [p._id, p]));
  for (const d of dms) {
    const list = d.uids.map((id: string) => parties.get(id)).filter((p: DirectParty | undefined): p is DirectParty => !!p);
    if (list.length >= 2 && !checkDirect('send', list[0], list.slice(1), rules).allowed) report.blockedDirects++;
  }
  return report;
}
