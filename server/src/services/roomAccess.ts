// Permissões de um canal: quem pode enviar mensagens (todos ou só quem foi escolhido) e o que cada pessoa pode fazer
// nele. Tudo em cima do RBAC: "só quem eu escolher" é a sala somente leitura, quem fala é quem tem "Escrever em salas
// somente leitura" (Dono, Moderador, Publicador ou um papel de sala próprio), e o que cada pessoa pode é a soma dos
// papéis globais com os papéis dela na sala.
import { RBAC_GROUPS, type RoleInfo } from '@shared/rbac';
import { many } from '../db/pool';
import { badRequest, forbidden } from '../lib/errors';
import { getRoom, roomRoleLock, setRoomRole } from './rooms';
import { getUserRoles, roleInfos, rolesHavePermission } from './permissions';
import type { Ctx } from './users';

export const BUILTIN_ROOM_ROLES = ['owner', 'moderator', 'leader', 'publisher'];
const BUILTIN_PERM: Record<string, string> = { owner: 'set-owner', moderator: 'set-moderator', leader: 'set-leader', publisher: 'set-publisher' };
// Chaves que fazem sentido dentro de uma sala: o grupo "Moderação de salas" do catálogo.
export const ROOM_KEYS = RBAC_GROUPS.find((g) => g.id === 'room')!.areas.flatMap((a) => [...a.levels.flatMap((l) => l.keys), ...a.extras]);
const MANAGE_KEYS = ['set-readonly', 'set-react-when-readonly', 'mute-user', 'set-owner', 'set-moderator', 'set-leader', 'set-publisher'];

const permsOf = (roles: string[], infos: RoleInfo[]) => {
  const set = new Set<string>();
  for (const r of infos) if (roles.includes(r.id)) for (const k of r.permissions) set.add(k);
  return set;
};

async function loadManaged(ctx: Ctx, rid: string) {
  const room = await getRoom(rid);
  if (!room) throw badRequest('error-room-not-found', 'Sala não encontrada.');
  if (room.t === 'd') throw badRequest('error-not-allowed', 'Conversas diretas não têm permissões de canal.');
  const actorRoles = await getUserRoles(ctx.userId, rid);
  if (!MANAGE_KEYS.some((k) => rolesHavePermission(actorRoles, k))) throw forbidden('Só donos e moderadores ajustam as permissões deste canal.');
  return { room, actorRoles };
}

export async function roomAccess(ctx: Ctx, rid: string, filter = '') {
  const { room, actorRoles } = await loadManaged(ctx, rid);
  const infos = roleInfos();
  const roomRoles = infos.filter((r) => r.scope === 'Subscriptions');
  const can = (k: string) => rolesHavePermission(actorRoles, k);
  const term = filter.trim().toLowerCase();
  const rows = await many<{ id: string; username: string; name: string | null; status: string | null; active: boolean; type: string; groles: string[]; sroles: string[] }>(
    `SELECT u.id, u.username, u.name, u.status, u.active, u.type, u.roles AS groles, s.roles AS sroles
       FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.room_id = $1 AND ($2 = '' OR lower(u.username) LIKE '%' || $2 || '%' OR lower(coalesce(u.name, '')) LIKE '%' || $2 || '%')
      ORDER BY lower(coalesce(u.name, u.username))
      LIMIT 500`,
    [rid, term],
  );
  const total = (await many<{ n: number }>('SELECT count(*)::int AS n FROM subscriptions WHERE room_id = $1', [rid]))[0]?.n ?? 0;
  const muted: string[] = room.muted ?? [];
  const members = rows.map((u) => {
    const all = [...u.groles, ...u.sroles];
    const perms = permsOf(all, infos);
    const isMuted = muted.includes(u.username);
    return {
      _id: u.id,
      username: u.username,
      name: u.name ?? undefined,
      status: u.status ?? undefined,
      active: u.active,
      bot: u.type === 'bot',
      roomRoles: u.sroles,
      globalRoles: u.groles,
      muted: isMuted,
      // Quem pode enviar agora: silenciado nunca; em sala somente leitura só com a permissão de escrever nela.
      canPost: !isMuted && (!room.ro || perms.has('post-readonly')),
      // Pode enviar por um papel global (Administrador, por exemplo): tirar o papel de sala não o cala.
      postsByGlobal: permsOf(u.groles, infos).has('post-readonly'),
      roomPermissions: ROOM_KEYS.filter((k) => perms.has(k)),
    };
  });
  return {
    room: { _id: room.id, name: room.fname || room.name, t: room.t, readOnly: !!room.ro, notice: !!room.notice, reactWhenReadOnly: !!room.react_when_ro, teamMain: !!room.team_main },
    can: {
      mode: can('set-readonly'),
      react: can('set-react-when-readonly'),
      mute: can('mute-user'),
      posters: can('set-publisher'),
    },
    roles: roomRoles.map((r) => {
      const perm = BUILTIN_PERM[r.id] ?? 'set-moderator';
      const lock = roomRoleLock(actorRoles, r.id);
      return {
        _id: r.id,
        builtin: BUILTIN_ROOM_ROLES.includes(r.id),
        permissions: r.permissions.filter((k) => ROOM_KEYS.includes(k)),
        canPost: r.permissions.includes('post-readonly'),
        // Por que não dá para dar ou tirar: falta a permissão na sala ou o papel dá mais do que o ator tem.
        lock: !can(perm) ? 'perm' : lock ? 'superior' : null,
      };
    }),
    members,
    total,
  };
}

// Troca os papéis de sala de uma pessoa de uma vez: cada papel que entra ou sai passa pelas mesmas regras de setRoomRole.
export async function setMemberRoomRoles(ctx: Ctx, rid: string, userId: string, roles: string[]) {
  await loadManaged(ctx, rid);
  const cur = await many<{ roles: string[] }>('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [rid, userId]);
  if (!cur.length) throw badRequest('error-user-not-in-room', 'Usuário não está na sala.');
  const before = cur[0].roles;
  const next = [...new Set(roles)];
  // Dono entra antes de qualquer saída: tirar e dar dono na mesma troca nunca deixa a sala sem dono no meio.
  for (const r of next.filter((x) => !before.includes(x))) await setRoomRole(ctx, rid, userId, r, true);
  for (const r of before.filter((x) => !next.includes(x))) await setRoomRole(ctx, rid, userId, r, false);
  return next;
}

// "Quem pode enviar": dá ou tira o Publicador de várias pessoas. Quem já fala por outro papel fica como está.
export async function setPosters(ctx: Ctx, rid: string, add: string[], remove: string[]) {
  await loadManaged(ctx, rid);
  const subs = await many<{ user_id: string; roles: string[] }>('SELECT user_id, roles FROM subscriptions WHERE room_id = $1 AND user_id = ANY($2)', [rid, [...add, ...remove]]);
  const byUser = new Map(subs.map((s) => [s.user_id, s.roles]));
  let changed = 0;
  for (const id of add) {
    const r = byUser.get(id);
    if (!r) throw badRequest('error-user-not-in-room', 'Usuário não está na sala.');
    if (r.includes('publisher')) continue;
    await setRoomRole(ctx, rid, id, 'publisher', true);
    changed++;
  }
  for (const id of remove) {
    const r = byUser.get(id);
    if (!r?.includes('publisher')) continue;
    await setRoomRole(ctx, rid, id, 'publisher', false);
    changed++;
  }
  return changed;
}
