// Links de convite. Um link só vale enquanto a sala recebe pessoas (não é conversa direta, não está arquivada) e quem o
// criou ainda poderia criá-lo: conta ativa, inscrito na sala e com create-invite-links ali. Assim quem saiu da sala (ou
// foi removido, desativado, excluído ou perdeu o papel) não traz ninguém pelo link antigo, nem a si mesmo.
import { many, one } from '../db/pool';
import { getUserRoles, rolesHavePermission } from './permissions';

export type InviteStatus = 'active' | 'expired' | 'used-up' | 'archived' | 'invalid';

// Prazo em dias (0 = nunca expira) e limite de usos (0 = ilimitado) aceitos ao criar um link.
export const INVITE_MAX_DAYS = 365;
export const INVITE_MAX_USES = 1000;

// Número inteiro de 0 a max (aceita "7" vindo de formulário); ausente vale o padrão; inválido é null.
export function inviteNumber(v: unknown, fallback: number, max: number): number | null {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

const SELECT = `SELECT i.*, r.name, r.fname, r.t, r.prid, r.team_main, r.notice, r.archived,
    cu.username AS creator_username, cu.active AS creator_active, cu.roles AS creator_roles, cs.roles AS creator_room_roles
  FROM invites i
  JOIN rooms r ON r.id = i.room_id
  LEFT JOIN users cu ON cu.id = i.user_id
  LEFT JOIN subscriptions cs ON cs.room_id = i.room_id AND cs.user_id = i.user_id`;

export function inviteStatus(row: any, now = Date.now()): InviteStatus {
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
  if (row.max_uses > 0 && row.uses >= row.max_uses) return 'used-up';
  if (row.archived) return 'archived';
  const creatorCan =
    row.t !== 'd' && !!row.creator_active && !!row.creator_room_roles && rolesHavePermission([...(row.creator_roles ?? []), ...row.creator_room_roles], 'create-invite-links');
  return creatorCan ? 'active' : 'invalid';
}

export async function getInvite(token: string) {
  return one(`${SELECT} WHERE i.id = $1`, [token]);
}

// Uma entrada por vez para a mesma pessoa com o mesmo link, nesta instância (clique duplo, duas abas, pedidos repetidos
// pela API): o pedido seguinte já encontra a pessoa na sala e não gasta outro uso.
const joining = new Map<string, Promise<unknown>>();
export async function oneJoinAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = joining.get(key);
  const run = prev ? prev.then(fn) : fn();
  const tail = run.catch(() => {});
  joining.set(key, tail);
  try {
    return await run;
  } finally {
    if (joining.get(key) === tail) joining.delete(key);
  }
}

// Lista: os links de uma sala (painel da sala), todos (Administração) ou só os da própria pessoa. canRevoke segue a
// regra de removeInvite: quem criou, ou quem pode criar links naquela sala.
export async function listInvites(viewerId: string, opts: { rid?: string; all?: boolean }) {
  const params: unknown[] = [viewerId];
  const where = opts.rid ? `i.room_id = $${params.push(opts.rid)}` : opts.all ? 'true' : 'i.user_id = $1';
  const rows = await many(
    `SELECT * FROM (${SELECT} WHERE ${where} ORDER BY i.created_at DESC LIMIT 200) x
     LEFT JOIN LATERAL (SELECT roles AS viewer_room_roles FROM subscriptions WHERE room_id = x.room_id AND user_id = $1) v ON true
     ORDER BY x.created_at DESC`,
    params,
  );
  const viewerRoles = await getUserRoles(viewerId);
  return rows.map((i) => ({
    _id: i.id,
    rid: i.room_id,
    roomName: i.name,
    room: { _id: i.room_id, name: i.name, fname: i.fname, t: i.t, prid: i.prid ?? undefined, teamMain: !!i.team_main, notice: !!i.notice },
    days: i.days,
    maxUses: i.max_uses,
    uses: i.uses,
    expires: i.expires_at,
    createdAt: i.created_at,
    createdBy: i.user_id ? { _id: i.user_id, username: i.creator_username } : null,
    status: inviteStatus(i),
    canRevoke: i.user_id === viewerId || rolesHavePermission([...viewerRoles, ...(i.viewer_room_roles ?? [])], 'create-invite-links'),
  }));
}
