import type { CallMedia, CallScope, CallSource } from '@shared/index';
import { CALL_LIMITS, callScopeOf, callStartBlockMessage, isTransmissionRoom } from '@shared/calls';
import { checkDirect, isRestricted } from '@shared/direct';
import { many, one, pool, type Queryable } from '../db/pool';
import { ApiError } from '../lib/errors';
import { assertCanCall, currentDirectRules, directError, loadParties } from '../services/direct';
import { restrictedRoleIds, rolesHavePermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import type { Ctx } from '../services/users';
import { assertJoinSafe } from './guard';
import { sfuConfig } from './livekit';
import { currentCallOf, lk, presentSql, totalPresent } from './model';

// Quem inicia, quem entra e o que cada um pode publicar. Nada aqui lança erro de política: devolve { allowed, error },
// para calls.roomCall prever com o mesmo código que calls.start e calls.join usam para decidir.

export interface Verdict {
  allowed: boolean;
  error?: ApiError;
  hide?: boolean; // a recusa não muda sozinha nesta sala: a web nem mostra os botões
}

const ok: Verdict = { allowed: true };
const no = (error: ApiError, hide = false): Verdict => ({ allowed: false, error, hide });
const notAllowed = (msg: string, hide = false) => no(new ApiError(403, 'error-call-not-allowed', msg), hide);

export const ERR = {
  disabled: () => new ApiError(403, 'error-not-allowed', 'As chamadas estão desativadas.'),
  room: () => new ApiError(400, 'error-call-room', 'Chamadas não estão disponíveis em conversas de atendimento.'),
  groupDisabled: () => new ApiError(400, 'error-call-group-disabled', 'Chamadas em grupo estão desativadas. Só é possível ligar em mensagens diretas entre duas pessoas.'),
  user: () => new ApiError(400, 'error-call-user', 'Este usuário não pode receber chamadas.'),
  sfu: () => new ApiError(503, 'error-call-sfu-unavailable', 'O servidor de chamadas não está respondendo. Tente de novo em instantes ou avise o administrador.'),
  // Sem LiveKit configurado (endereço, chave e segredo): não é queda, e só o administrador resolve (CALL_SFU_NOT_CONFIGURED).
  sfuNotConfigured: () => new ApiError(503, 'error-call-sfu-not-configured', 'As chamadas em grupo ainda não foram configuradas. Peça ao administrador para ativá-las em Administração › Chamadas.'),
  capacity: () => new ApiError(503, 'error-call-capacity', 'O servidor de chamadas está no limite agora. Tente em alguns minutos.'),
  notMember: () => new ApiError(403, 'error-call-not-member', 'Entre na sala para participar da chamada.'),
  exists: (callId: string) => new ApiError(409, 'error-call-exists', 'Já existe uma chamada em andamento nesta sala.', { callId }),
  inProgress: () => new ApiError(409, 'error-call-in-progress', 'Você já está em uma chamada.'),
  full: (n: number) => new ApiError(409, 'error-call-full', `A chamada está cheia (${n} pessoas).`),
  ended: () => new ApiError(400, 'error-call-ended', 'Esta chamada já terminou.'),
  removed: (by: string) => new ApiError(403, 'error-call-removed', `Você foi removido desta chamada por @${by}.`),
  notModerator: () => new ApiError(403, 'error-call-not-moderator', 'Só quem iniciou a chamada e os moderadores da sala podem fazer isso.'),
  notFound: () => new ApiError(404, 'error-call-not-found', 'Chamada não encontrada.'),
  cannotRing: () => new ApiError(403, 'error-call-not-allowed', 'Você não pode chamar pessoas para esta chamada.'),
  notInCall: () => new ApiError(400, 'error-invalid-params', 'Você não está nesta chamada.'),
};

// ---------- Permissões de publicação ----------

export interface Grants {
  speaker: boolean; // pode publicar áudio pelo papel, pela sala e pela fala liberada (ignora a pausa da trava)
  canPublish: boolean;
  sources: CallSource[];
  hidden: boolean;
  screenAllowed: boolean;
}

const ALL_SOURCES: CallSource[] = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
const AV_SOURCES: CallSource[] = ['microphone', 'camera'];

export function grantsFor(
  user: { username: string },
  call: { listen_only?: boolean; guard_until?: string | null },
  room: { muted?: string[] | null },
  roles: string[],
  row: { speak_granted?: boolean; screen_block_until?: string | null } | null,
): Grants {
  const speakerByRole = !call.listen_only || rolesHavePermission(roles, 'post-readonly');
  const mutedInRoom = !!room.muted?.includes(user.username);
  const speaker = (speakerByRole && !mutedInRoom) || !!row?.speak_granted;
  const paused = !!call.guard_until;
  const canPublish = speaker && !paused;
  const blocked = !!row?.screen_block_until && new Date(row.screen_block_until).getTime() > Date.now();
  const screenAllowed = speakerByRole && !mutedInRoom && !blocked;
  const sources = !canPublish ? [] : screenAllowed ? [...ALL_SOURCES] : [...AV_SOURCES];
  return { speaker, canPublish, sources, hidden: !!call.listen_only && !speaker, screenAllowed };
}

export const sameSources = (a: string[] | null | undefined, b: string[]) => {
  const x = [...(a ?? [])].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((s, i) => s === y[i]);
};

// ---------- Quem pergunta ----------

// Papéis que valem para iniciar em salas, chamar, moderar e assumir como anfitrião (call-management, moderate-call,
// videoconf-ring-users): quem tem papel restrito (operacao) conta só os globais. Ser dono ou moderador da sala nunca
// dá esses direitos a um operador (G10, O1).
export function managementRoles(globalRoles: string[] | null | undefined, roomRoles: string[] | null | undefined): string[] {
  const g = globalRoles ?? [];
  const rules = currentDirectRules();
  if (rules.restrictedRoles.length && isRestricted({ _id: '', username: '', roles: g }, rules)) return g;
  return [...g, ...(roomRoles ?? [])];
}

export interface Viewer {
  id: string;
  username: string;
  roles: string[]; // globais e da sala
  globalRoles: string[];
  mgmtRoles: string[]; // managementRoles
  member: boolean;
  active: boolean;
  type: string;
  row: any | null; // linha em call_participants (com present)
}

export async function loadViewer(userId: string, callId: string | null, rid: string, db: Queryable = pool): Promise<Viewer | null> {
  const u = await one(
    `SELECT u.id, u.username, u.roles AS g, u.active, u.type, s.roles AS s, (s.id IS NOT NULL) AS member
       FROM users u LEFT JOIN subscriptions s ON s.room_id = $2 AND s.user_id = u.id WHERE u.id = $1`,
    [userId, rid],
    db,
  );
  if (!u) return null;
  const row = callId ? await one(`SELECT p.*, ${presentSql()} AS present FROM call_participants p WHERE p.call_id = $1 AND p.user_id = $2`, [callId, userId], db) : null;
  return { id: u.id, username: u.username, roles: [...u.g, ...(u.s ?? [])], globalRoles: u.g, mgmtRoles: managementRoles(u.g, u.s), member: u.member, active: u.active, type: u.type, row };
}

export interface Rights {
  canModerate: boolean;
  canEnd: boolean;
  canRing: boolean;
  canInvite: boolean;
}

export function rightsFor(v: Viewer, call: any, room: any): Rights {
  const live = call.status === 'ringing' || call.status === 'ongoing';
  if (call.scope !== 'group') {
    const party = v.id === call.caller_id || v.id === call.callee_id;
    return { canModerate: false, canEnd: party && live, canRing: false, canInvite: false };
  }
  const moderator = rolesHavePermission(v.mgmtRoles, 'moderate-call');
  const host = !!v.row?.host;
  const present = live && !!v.row?.present;
  const canModerate = live && (moderator || (host && rolesHavePermission(v.mgmtRoles, 'call-management')));
  const canEnd = live && (host || moderator);
  const ring = present && v.member && (room.t === 'd' || host || moderator || rolesHavePermission(v.mgmtRoles, 'videoconf-ring-users'));
  const waited = !call.invited_at || new Date(call.invited_at).getTime() <= Date.now() - CALL_LIMITS.inviteEveryMinutes * 60_000;
  return { canModerate, canEnd, canRing: ring, canInvite: ring && room.t !== 'd' && waited };
}

export function canRing(v: Viewer, call: any, room: any): boolean {
  return rightsFor(v, call, room).canRing;
}

// ---------- Iniciar ----------

export function callsEnabled() {
  return !!getSetting('Calls_Enabled');
}

export function groupEnabled() {
  return !!getSetting('Calls_Group_Enabled');
}

// Pessoas ativas e humanas da sala, sem contar quem pergunta (até 3, para a regra das salas com duas pessoas).
async function otherHumans(rid: string, userId: string, db: Queryable) {
  return many(
    `SELECT u.id FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.room_id = $1 AND u.active AND u.type = 'user' AND u.id <> $2 LIMIT 2`,
    [rid, userId],
    db,
  );
}

// Recusa do checkDirect('call'): o texto da política quando quem pergunta está no par, senão o das chamadas.
async function directCallVerdict(ctx: Ctx, otherIds: string[]): Promise<Verdict> {
  if (!restrictedRoleIds().length || !otherIds.length) return ok;
  const rules = currentDirectRules();
  const parties = await loadParties([ctx.userId, ...otherIds]);
  const viewer = parties.find((p) => p._id === ctx.userId) ?? { _id: ctx.userId, username: ctx.username, roles: [] };
  const v = checkDirect('call', viewer, parties.filter((p) => p._id !== ctx.userId), rules);
  if (v.allowed || !v.pair) return ok;
  if (v.pair.includes(viewer.username)) return no(directError(v, viewer.username));
  return no(new ApiError(403, 'error-direct-restricted', callStartBlockMessage(v, viewer, rules), { action: 'call', usernames: v.pair }));
}

const NO_CALLS = 'Esta sala não aceita chamadas.';

// Passos 2 a 4 do início (§5.6): atendimento, escopo, chamadas em grupo e a política da sala.
export async function startCheck(ctx: Ctx, room: any, db: Queryable = pool): Promise<Verdict & { scope?: CallScope }> {
  if (room.t === 'l') return no(ERR.room(), true);
  const scope = callScopeOf(room);
  if (!scope) return no(ERR.user(), true);
  if (scope === 'group' && !groupEnabled()) return { ...no(ERR.groupDisabled(), true), scope };
  const viewer = await loadViewer(ctx.userId, null, room.id, db);
  if (room.t === 'd') {
    if (!viewer?.member || !room.uids.includes(ctx.userId)) return { ...notAllowed('Entre na sala para iniciar uma chamada.'), scope };
    if (scope === 'direct') {
      const calleeId = room.uids.find((u: string) => u !== ctx.userId);
      const callee = calleeId ? await one('SELECT id, active, type FROM users WHERE id = $1', [calleeId], db) : null;
      if (!callee?.active || callee.type === 'bot') return { ...no(ERR.user()), scope };
      try {
        await assertCanCall(ctx, room);
      } catch (e) {
        if (e instanceof ApiError) return { ...no(e), scope };
        throw e;
      }
      return { ...ok, scope };
    }
    // v1a: DM em grupo que um administrador deixou somente leitura também não tem chamadas.
    if (isTransmissionRoom(room)) return { ...notAllowed(NO_CALLS, true), scope };
    return { ...(await directCallVerdict(ctx, room.uids.filter((u: string) => u !== ctx.userId))), scope };
  }
  // v1a: salas somente leitura, de avisos ou com a lista oculta não têm chamadas.
  if (isTransmissionRoom(room)) return { ...notAllowed(NO_CALLS, true), scope };
  if (!viewer || !rolesHavePermission(viewer.mgmtRoles, 'call-management')) return { ...notAllowed('Você não tem permissão para iniciar chamadas nesta sala.', true), scope };
  if (!viewer.member) return { ...notAllowed('Entre na sala para iniciar uma chamada.'), scope };
  if (room.archived) return { ...notAllowed('Esta sala está arquivada.'), scope };
  if (room.muted?.includes(ctx.username)) return { ...notAllowed('Você está silenciado nesta sala.'), scope };
  // Sala com até duas pessoas é, na prática, uma ligação direta: vale a mesma regra.
  const others = await otherHumans(room.id, ctx.userId, db);
  if (others.length === 1) return { ...(await directCallVerdict(ctx, [others[0].id])), scope };
  return { ...ok, scope };
}

// §5.5: grupo sempre pelo servidor de chamadas, que precisa estar configurado e respondendo; a dois, P2P na v1a.
// recheck false (calls.roomCall): só o resultado guardado, para abrir a sala nunca esperar o LiveKit fora do ar.
export async function resolveMedia(
  scope: CallScope,
  o: { engines?: string[]; connectionId?: string; recheck?: boolean } = {},
): Promise<{ allowed: true; media: CallMedia } | { allowed: false; error: ApiError }> {
  if (scope === 'direct') return { allowed: true, media: 'p2p' };
  if (!groupEnabled()) return { allowed: false, error: ERR.groupDisabled() };
  if (!sfuConfig().configured) return { allowed: false, error: ERR.sfuNotConfigured() };
  let h = await lk.health();
  // Resultado guardado de quando estava fora: confere de novo antes de recusar.
  if (!h.ok && o.recheck !== false) h = await lk.health(true);
  return h.ok ? { allowed: true, media: 'sfu' } : { allowed: false, error: ERR.sfu() };
}

export const maxParticipants = () => Number(getSetting('Calls_Max_Participants')) || 30;
export const maxListeners = () => Number(getSetting('Calls_Max_Listeners')) || 300;
export const maxTotal = () => Number(getSetting('Calls_Max_Total_Participants')) || 150;

export async function serverFull(userAlreadyPresent: boolean, db: Queryable = pool) {
  return !userAlreadyPresent && (await totalPresent(db)) + 1 > maxTotal();
}

// ---------- Entrar ----------

// §5.7, a primeira recusa vale. leaveCurrent: quem pergunta aceita sair da chamada em que está. server false: o limite do
// servidor fica para quem chama (joinCall confere de novo sob a trava de entradas).
export async function joinCheck(
  ctx: Ctx,
  call: any,
  room: any,
  o: { leaveCurrent?: boolean; db?: Queryable; server?: boolean } = {},
): Promise<Verdict & { listenOnly: boolean; viewer?: Viewer }> {
  const db = o.db ?? pool;
  const res = (v: Verdict, viewer?: Viewer) => ({ ...v, listenOnly: false, viewer });
  if (!call) return res(no(ERR.notFound()));
  if (call.status !== 'ongoing') return res(no(ERR.ended()));
  if (call.scope === 'direct' && call.media === 'p2p') return res(no(new ApiError(400, 'error-invalid-params', 'Use Atender para chamadas diretas.')));
  const viewer = await loadViewer(ctx.userId, call.id, call.room_id, db);
  if (!viewer?.member || !viewer.active) return res(no(ERR.notMember()));
  if (call.scope === 'direct' && viewer.id !== call.caller_id && viewer.id !== call.callee_id) return res(no(ERR.notMember()));
  // v1a: a sala virou somente leitura, de avisos ou oculta durante a chamada (a reconciliação a encerra em até 10 s).
  if (call.scope === 'group' && !call.listen_only && isTransmissionRoom(room)) return res(notAllowed(NO_CALLS), viewer);
  if (viewer.row?.left_reason === 'removed' && viewer.row.state === 'left') {
    const by = viewer.row.removed_by ? await one('SELECT username FROM users WHERE id = $1', [viewer.row.removed_by], db) : null;
    return res(no(ERR.removed(by?.username ?? '')), viewer);
  }
  // Configuração do LiveKit apagada com a chamada viva: ninguém recebe token. O motivo é o de não configurado (como em
  // iniciar), antes de gravar a entrada; a varredura encerra a chamada com 'sfu' depois de sfuMissingSeconds.
  if (call.media === 'sfu' && !sfuConfig().configured) return res(no(ERR.sfuNotConfigured()), viewer);
  const g = grantsFor(viewer, call, room, viewer.roles, viewer.row);
  const listenOnly = g.hidden;
  const already = !!viewer.row?.present;
  const limit = call.listen_only && listenOnly ? maxListeners() : maxParticipants();
  if (!already) {
    const n = await one(`SELECT count(*)::int AS n FROM call_participants p WHERE p.call_id = $1 AND ${presentSql()}`, [call.id], db);
    if ((n?.n ?? 0) >= limit) return { ...no(ERR.full(limit)), listenOnly, viewer };
  }
  if (o.server !== false && call.media === 'sfu' && (await serverFull(already, db))) return { ...no(ERR.capacity()), listenOnly, viewer };
  if (!o.leaveCurrent && (await currentCallOf(ctx.userId, { except: call.id }, db))) return { ...no(ERR.inProgress()), listenOnly, viewer };
  try {
    await assertJoinSafe(call, room, ctx.userId, db);
  } catch (e) {
    if (e instanceof ApiError) return { ...no(e), listenOnly, viewer };
    throw e;
  }
  return { ...ok, listenOnly, viewer };
}

// Para a web prever a trava sem conhecer os papéis de ninguém.
export function viewerGuardOf(v: Viewer, call: any, room: any) {
  const rules = currentDirectRules();
  const party = { _id: v.id, username: v.username, roles: v.active ? v.globalRoles : v.globalRoles.filter((r) => !rules.exemptRoles.includes(r)) };
  return {
    restricted: isRestricted(party, rules),
    exempt: party.roles.some((r) => rules.exemptRoles.includes(r)),
    speaks: grantsFor(v, call ?? { listen_only: isTransmissionRoom(room) }, room, v.roles, v.row).speaker,
  };
}
