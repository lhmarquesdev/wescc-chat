import type { LivechatInquiry, LivechatRoomInfo } from '@shared/index';
import { many, one, query } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId, randomToken } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { on } from '../services/hooks';
import { sendMail } from '../services/mailer';
import { mapRoom } from '../services/mappers';
import { sendSystemMessage, withExtra } from '../services/messages';
import { dispatchNotifications } from '../services/notifications';
import { hasPermission } from '../services/permissions';
import { addUserToRoom, getRoom, notifySubscription, removeUserFromRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { actorOf, type Ctx } from '../services/users';

// Núcleo do omnichannel: visitantes, salas de atendimento, roteamento e fila.
// Sem limites de agentes, departamentos ou contatos.

export const visitorConnId = (visitorId: string) => `v:${visitorId}`;

// ---------- Leitura ----------

const ROOM_SQL = `
  SELECT lr.*, r.fname, r.msgs, r.topic, r.created_at AS room_created_at,
         v.username AS v_username, v.name AS v_name, v.token AS v_token, v.email AS v_email, v.phone AS v_phone,
         a.username AS a_username, a.name AS a_name, a.email AS a_email,
         d.name AS d_name, p.name AS p_name, p.sort_item AS p_sort, s.name AS s_name, s.due_time_minutes AS s_due
  FROM livechat_rooms lr
  JOIN rooms r ON r.id = lr.room_id
  JOIN livechat_visitors v ON v.id = lr.visitor_id
  LEFT JOIN users a ON a.id = lr.agent_id
  LEFT JOIN livechat_departments d ON d.id = lr.department_id
  LEFT JOIN livechat_priorities p ON p.id = lr.priority_id
  LEFT JOIN livechat_sla s ON s.id = lr.sla_id`;

export function mapLivechatRoom(r: any): LivechatRoomInfo {
  return {
    _id: r.room_id,
    rid: r.room_id,
    fname: r.fname,
    status: r.status,
    v: { _id: r.visitor_id, username: r.v_username, name: r.v_name, token: r.v_token, email: r.v_email, phone: r.v_phone },
    servedBy: r.agent_id ? { _id: r.agent_id, username: r.a_username, name: r.a_name } : null,
    departmentId: r.department_id,
    departmentName: r.d_name ?? null,
    priority: r.priority_id ? { _id: r.priority_id, name: r.p_name, sortItem: r.p_sort } : null,
    sla: r.sla_id ? { _id: r.sla_id, name: r.s_name, dueTimeInMinutes: r.s_due } : null,
    tags: r.tags ?? [],
    topic: r.topic || undefined,
    livechatData: r.livechat_data,
    source: r.source,
    queuedAt: r.queued_at,
    servedAt: r.served_at,
    firstResponseAt: r.first_response_at,
    closedAt: r.closed_at,
    closer: r.closer,
    closedBy: r.closed_by,
    closeComment: r.close_comment,
    onHoldAt: r.onhold_at,
    survey: r.survey,
    messages: r.msgs,
    ts: r.room_created_at,
  };
}

// O visitante só vê o necessário: nada de tags, notas ou dados internos.
export function mapRoomForVisitor(r: any) {
  const showAgent = getSetting<boolean>('Livechat_show_agent_info');
  return {
    _id: r.room_id,
    rid: r.room_id,
    status: r.status,
    open: r.status !== 'closed',
    departmentId: r.department_id,
    servedBy: r.agent_id && showAgent ? { _id: r.agent_id, username: r.a_username, name: r.a_name, email: getSetting('Livechat_show_agent_email') ? r.a_email : undefined } : null,
    ts: r.room_created_at,
  };
}

export async function getLivechatRoomRow(rid: string) {
  return one(`${ROOM_SQL} WHERE lr.room_id = $1`, [rid]);
}

export async function getLivechatRoom(rid: string) {
  const r = await getLivechatRoomRow(rid);
  return r ? mapLivechatRoom(r) : null;
}

function inquiryOf(r: any): LivechatInquiry {
  return {
    _id: r.room_id,
    rid: r.room_id,
    name: r.fname,
    v: { _id: r.visitor_id, username: r.v_username, name: r.v_name },
    departmentId: r.department_id,
    priority: r.priority_id ? { _id: r.priority_id, name: r.p_name, sortItem: r.p_sort } : null,
    slaDue: r.sla_due,
    queuedAt: r.queued_at,
  };
}

// ---------- Escopo de quem vê o quê ----------

async function userRoles(userId: string): Promise<string[]> {
  return (await one('SELECT roles FROM users WHERE id = $1', [userId]))?.roles ?? [];
}

// null = todos os departamentos; array = só estes (monitores enxergam as unidades que monitoram).
export async function departmentScope(userId: string): Promise<string[] | null> {
  const roles = await userRoles(userId);
  if (roles.includes('admin') || roles.includes('livechat-manager')) return null;
  if (roles.includes('livechat-monitor')) {
    const rows = await many(
      `SELECT d.id FROM livechat_departments d JOIN livechat_unit_monitors m ON m.unit_id = d.unit_id WHERE m.user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.id);
  }
  return null;
}

export async function canViewLivechatRoom(userId: string, rid: string) {
  const lr = await one('SELECT agent_id, department_id FROM livechat_rooms WHERE room_id = $1', [rid]);
  if (!lr) return false;
  if (lr.agent_id === userId && (await hasPermission(userId, 'view-l-room'))) return true;
  if (!(await hasPermission(userId, 'view-livechat-rooms'))) return false;
  const scope = await departmentScope(userId);
  return scope === null || (lr.department_id && scope.includes(lr.department_id));
}

async function agentAudience(departmentId?: string | null): Promise<string[]> {
  const rows = departmentId
    ? await many(
        `SELECT DISTINCT u.id FROM users u
         LEFT JOIN livechat_department_agents da ON da.user_id = u.id AND da.department_id = $1
         WHERE u.active AND (da.user_id IS NOT NULL OR u.roles && ARRAY['livechat-manager','livechat-monitor','admin'])`,
        [departmentId],
      )
    : await many(`SELECT id FROM users WHERE active AND roles && ARRAY['livechat-agent','livechat-manager','livechat-monitor','admin']`);
  return rows.map((r) => r.id);
}

async function publishRoomState(rid: string) {
  const r = await getLivechatRoomRow(rid);
  if (!r) return;
  bus.publish({ room: rid }, { type: 'livechat.room', room: mapLivechatRoom(r) });
  // Visitantes recebem a versão reduzida pelo mesmo canal da sala.
  bus.publish({ user: visitorConnId(r.visitor_id) }, { type: 'livechat.room', room: mapRoomForVisitor(r) as any });
}

// ---------- Horário de atendimento ----------

function nowIn(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hh = get('hour') === '24' ? '00' : get('hour');
  return { day, time: `${hh}:${get('minute')}` };
}

export function isBusinessHourOpen(bh: { active: boolean; timezone: string; work_hours: any[] } | null) {
  if (!bh || !bh.active) return true;
  let tz = bh.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const { day, time } = nowIn(tz);
  const today = (bh.work_hours ?? []).find((w: any) => w.day === day);
  if (!today?.enabled) return false;
  return today.open <= today.close ? time >= today.open && time < today.close : time >= today.open || time < today.close;
}

export async function businessHoursOpen(departmentId?: string | null) {
  if (!getSetting<boolean>('Livechat_enable_business_hours')) return true;
  let bh = null;
  if (getSetting<string>('Livechat_business_hour_type') === 'Multiple' && departmentId) {
    bh = await one(`SELECT b.* FROM livechat_business_hours b JOIN livechat_departments d ON d.business_hour_id = b.id WHERE d.id = $1`, [departmentId]);
  }
  bh ??= await one(`SELECT * FROM livechat_business_hours WHERE id = 'default'`);
  return isBusinessHourOpen(bh);
}

// ---------- Roteamento ----------

function globalMax() {
  return getSetting<number>('Livechat_maximum_chats_per_agent') || 0;
}

export async function eligibleAgents(departmentId: string | null, opts: { exclude?: string[]; ignoreLimits?: boolean } = {}) {
  const params: unknown[] = [opts.exclude ?? []];
  let deptJoin = '';
  if (departmentId) {
    params.push(departmentId);
    deptJoin = `JOIN livechat_department_agents da ON da.user_id = u.id AND da.department_id = $2
                JOIN livechat_departments dep ON dep.id = da.department_id`;
  }
  const rows = await many(
    `SELECT u.id, u.username, u.name, u.type, la.last_routing_at, la.total_chats, la.max_chats,
            ${departmentId ? 'da.count AS dept_count, da.sort_order, dep.max_chats_per_agent AS dept_max' : 'la.total_chats AS dept_count, 0 AS sort_order, 0 AS dept_max'},
            (SELECT count(*) FROM livechat_rooms lr WHERE lr.agent_id = u.id AND lr.status = 'open')::int AS open_chats
     FROM users u
     JOIN livechat_agents la ON la.user_id = u.id
     ${deptJoin}
     WHERE u.active AND 'livechat-agent' = ANY(u.roles) AND la.status = 'available' AND u.status <> 'offline'
       AND NOT (u.id = ANY($1))`,
    params,
  );
  if (opts.ignoreLimits) return rows;
  return rows.filter((a) => {
    const max = a.max_chats ?? (a.dept_max || globalMax());
    return !max || a.open_chats < max;
  });
}

async function pickAgent(departmentId: string | null, exclude: string[] = []) {
  const method = getSetting<string>('Livechat_Routing_Method');
  if (method === 'Manual_Selection') return null;
  let agents = await eligibleAgents(departmentId, { exclude });
  if (!agents.length) return null;
  if (getSetting<boolean>('Livechat_assign_new_conversation_to_bot')) {
    const bots = agents.filter((a) => a.type === 'bot');
    if (bots.length) agents = bots;
  }
  if (method === 'External') {
    const url = getSetting<string>('Livechat_External_Queue_URL');
    if (!url) return null;
    try {
      const u = new URL(url);
      if (departmentId) u.searchParams.set('departmentId', departmentId);
      const res = await fetch(u, { headers: { 'X-RocketChat-Secret-Token': getSetting<string>('Livechat_External_Queue_Token') ?? '' }, signal: AbortSignal.timeout(5000) });
      const data: any = await res.json();
      return agents.find((a) => a.username === data?.username) ?? null;
    } catch {
      return null;
    }
  }
  const byDate = (x: any) => (x ? new Date(x).getTime() : 0);
  const sorted = [...agents].sort((a, b) => {
    if (method === 'Load_Balancing') return a.open_chats - b.open_chats || byDate(a.last_routing_at) - byDate(b.last_routing_at);
    if (method === 'Load_Rotation') return byDate(a.last_routing_at) - byDate(b.last_routing_at);
    return a.dept_count - b.dept_count || a.sort_order - b.sort_order || byDate(a.last_routing_at) - byDate(b.last_routing_at);
  });
  return sorted[0];
}

// Atribui a sala a um agente; só funciona se a sala ainda estiver na fila (ou for transferência).
async function assignAgent(rid: string, agent: { id: string; username: string }, opts: { fromQueue?: boolean } = {}) {
  const row = await one(
    `UPDATE livechat_rooms SET agent_id = $2, status = 'open', served_at = coalesce(served_at, now()), onhold_at = NULL
     WHERE room_id = $1 AND ${opts.fromQueue === false ? `status <> 'closed'` : `status = 'queued'`} RETURNING *`,
    [rid, agent.id],
  );
  if (!row) return false;
  await query('UPDATE livechat_agents SET last_routing_at = now(), total_chats = total_chats + 1 WHERE user_id = $1', [agent.id]);
  if (row.department_id) await query('UPDATE livechat_department_agents SET count = count + 1 WHERE department_id = $1 AND user_id = $2', [row.department_id, agent.id]);
  await addUserToRoom(rid, agent.id, { silent: true });
  await query(`UPDATE subscriptions SET alert = true, unread = GREATEST(unread, 1), updated_at = now() WHERE room_id = $1 AND user_id = $2`, [rid, agent.id]);
  await notifySubscription(agent.id, rid, 'updated');
  await sendSystemMessage(rid, 'livechat-started', agent, '');
  const full = await getLivechatRoomRow(rid);
  bus.publish({ users: await agentAudience(row.department_id) }, { type: 'livechat.inquiry', action: 'taken', inquiry: inquiryOf(full) });
  bus.publish({ user: agent.id }, { type: 'notification', rid, title: 'Novo atendimento', text: `${full.v_name || full.v_username} foi encaminhado para você.`, messageId: '', sender: { _id: full.visitor_id, username: full.v_username } });
  await publishRoomState(rid);
  return true;
}

export async function queuePosition(rid: string) {
  const r = await one(
    `WITH q AS (
       SELECT lr.room_id, row_number() OVER (ORDER BY p.sort_item NULLS LAST, lr.sla_due NULLS LAST, lr.queued_at) AS pos
       FROM livechat_rooms lr LEFT JOIN livechat_priorities p ON p.id = lr.priority_id
       WHERE lr.status = 'queued')
     SELECT pos::int FROM q WHERE room_id = $1`,
    [rid],
  );
  return r?.pos ?? 0;
}

async function announceQueuePosition(rid: string) {
  if (!getSetting<boolean>('Omnichannel_calculate_dispatch_service_queue_statistics')) return;
  const pos = await queuePosition(rid);
  if (!pos) return;
  const dept = await one('SELECT d.waiting_queue_message FROM livechat_rooms lr LEFT JOIN livechat_departments d ON d.id = lr.department_id WHERE lr.room_id = $1', [rid]);
  const text = (dept?.waiting_queue_message || getSetting<string>('Livechat_waiting_queue_message')).replace('{position}', String(pos));
  await systemFromQueue(rid, 'livechat_queue', text);
}

async function systemFromQueue(rid: string, t: string, msg: string, extra: Record<string, unknown> = {}) {
  const row = await one(
    `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, t, extra) VALUES ($1,$2,NULL,'sistema','Sistema',$3,$4,$5) RETURNING *`,
    [newId(), rid, msg, t, JSON.stringify(extra)],
  );
  bus.publish({ room: rid }, { type: 'message', action: 'inserted', message: withExtra(row) });
  return row;
}

// Tenta encaminhar uma sala da fila. Devolve true se algum agente assumiu.
export async function routeRoom(rid: string, opts: { exclude?: string[]; announce?: boolean } = {}) {
  const lr = await one('SELECT * FROM livechat_rooms WHERE room_id = $1', [rid]);
  if (!lr || lr.status !== 'queued') return false;
  let departmentId = lr.department_id;
  let agent = await pickAgent(departmentId, opts.exclude);
  if (!agent && departmentId && getSetting<string>('Livechat_Routing_Method') !== 'Manual_Selection') {
    // Sem agentes no departamento: tenta o departamento reserva.
    const dept = await one('SELECT fallback_department_id FROM livechat_departments WHERE id = $1', [departmentId]);
    if (dept?.fallback_department_id) {
      const fb = await pickAgent(dept.fallback_department_id, opts.exclude);
      if (fb) {
        departmentId = dept.fallback_department_id;
        await query('UPDATE livechat_rooms SET department_id = $2 WHERE room_id = $1', [rid, departmentId]);
        agent = fb;
      }
    }
  }
  if (agent && (await assignAgent(rid, agent))) return true;
  const full = await getLivechatRoomRow(rid);
  if (full) bus.publish({ users: await agentAudience(full.department_id) }, { type: 'livechat.inquiry', action: 'queued', inquiry: inquiryOf(full) });
  if (opts.announce) await announceQueuePosition(rid);
  return false;
}

let processing = false;
export async function processQueue() {
  if (processing || getSetting<string>('Livechat_Routing_Method') === 'Manual_Selection') return;
  processing = true;
  try {
    const queued = await many(
      `SELECT lr.room_id FROM livechat_rooms lr JOIN rooms r ON r.id = lr.room_id LEFT JOIN livechat_priorities p ON p.id = lr.priority_id
       WHERE lr.status = 'queued' AND r.msgs > 0 ORDER BY p.sort_item NULLS LAST, lr.sla_due NULLS LAST, lr.queued_at LIMIT 200`,
    );
    for (const q of queued) {
      const assigned = await routeRoom(q.room_id);
      if (!assigned) continue;
    }
  } finally {
    processing = false;
  }
}

// ---------- Disponibilidade ----------

export async function isOnline(departmentId?: string | null) {
  if (!getSetting<boolean>('Livechat_enabled')) return false;
  if (!(await businessHoursOpen(departmentId))) return false;
  if (getSetting<boolean>('Livechat_accept_chats_with_no_agents')) return true;
  const agents = await eligibleAgents(departmentId ?? null, { ignoreLimits: true });
  return agents.length > 0;
}

export async function setAgentStatus(userId: string, status: 'available' | 'not-available') {
  await query(
    `INSERT INTO livechat_agents (user_id, status) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status`,
    [userId, status],
  );
  bus.publish({ user: userId }, { type: 'livechat.agentStatus', status });
  if (status === 'available') void processQueue().catch(() => {});
}

export async function getAgentStatus(userId: string) {
  return ((await one('SELECT status FROM livechat_agents WHERE user_id = $1', [userId]))?.status ?? 'not-available') as 'available' | 'not-available';
}

// ---------- Visitantes ----------

export async function getVisitorByToken(token: string) {
  if (!token || token.length < 8) return null;
  return one('SELECT * FROM livechat_visitors WHERE token = $1', [token]);
}

export function mapVisitor(v: any) {
  return {
    _id: v.id,
    token: v.token,
    username: v.username,
    name: v.name,
    email: v.email,
    phone: v.phone,
    department: v.department_id,
    customFields: v.custom_fields,
    ip: v.ip,
    userAgent: v.user_agent,
    lastChat: v.last_chat,
    ts: v.created_at,
  };
}

async function validateCustomFields(scope: 'visitor' | 'room', data: Record<string, unknown> = {}) {
  const fields = await many('SELECT * FROM livechat_custom_fields WHERE scope = $1', [scope]);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f.id];
    if (v === undefined || v === null || v === '') {
      if (f.required && scope === 'visitor') throw badRequest('error-invalid-custom-field', `Campo obrigatório: ${f.label}`);
      continue;
    }
    const s = String(v).slice(0, 1000);
    if (f.regexp) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(f.regexp);
      } catch {
        re = null;
      }
      if (re && !re.test(s)) throw badRequest('error-invalid-custom-field', `Valor inválido para ${f.label}`);
    }
    if (f.options?.length && !f.options.includes(s)) throw badRequest('error-invalid-custom-field', `Opção inválida para ${f.label}`);
    out[f.id] = s;
  }
  return out;
}

export async function registerVisitor(input: { token: string; name?: string; email?: string; phone?: string; department?: string; customFields?: Record<string, unknown> }, meta: { ip?: string; userAgent?: string }) {
  const token = String(input.token ?? '').trim();
  if (token.length < 8 || token.length > 128) throw badRequest('error-invalid-token', 'Token inválido.');
  const email = input.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
  let department: string | null = null;
  if (input.department) {
    const d = await one('SELECT id FROM livechat_departments WHERE (id = $1 OR lower(name) = lower($1)) AND enabled AND NOT archived', [input.department]);
    if (!d) throw badRequest('error-invalid-department', 'Departamento inválido.');
    department = d.id;
  }
  const customFields = await validateCustomFields('visitor', input.customFields);
  const existing = await getVisitorByToken(token);
  if (existing) {
    const row = await one(
      `UPDATE livechat_visitors SET name = coalesce(NULLIF($2, ''), name), email = coalesce($3, email), phone = coalesce($4, phone),
         department_id = coalesce($5, department_id), custom_fields = custom_fields || $6, ip = $7, user_agent = $8, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [existing.id, input.name?.trim().slice(0, 120) ?? '', email, input.phone?.trim() || null, department, JSON.stringify(customFields), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    return row;
  }
  // Reaproveita o contato pelo e-mail, como o Rocket.Chat faz.
  if (email) {
    const byEmail = await one('SELECT * FROM livechat_visitors WHERE lower(email) = lower($1)', [email]);
    if (byEmail) {
      return one(
        `UPDATE livechat_visitors SET token = $2, name = coalesce(NULLIF($3, ''), name), department_id = coalesce($4, department_id), custom_fields = custom_fields || $5, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [byEmail.id, token, input.name?.trim() ?? '', department, JSON.stringify(customFields)],
      );
    }
  }
  const seq = (await one(`SELECT count(*)::int + 1 AS n FROM livechat_visitors`)).n;
  return one(
    `INSERT INTO livechat_visitors (id, token, username, name, email, phone, department_id, custom_fields, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [newId(), token, `guest-${seq}-${randomToken(3).replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase()}`, input.name?.trim().slice(0, 120) || `Visitante ${seq}`, email, input.phone?.trim() || null, department, JSON.stringify(customFields), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
  );
}

export async function openRoomOf(visitorId: string) {
  return one(`SELECT room_id FROM livechat_rooms WHERE visitor_id = $1 AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`, [visitorId]);
}

export async function getOrCreateVisitorRoom(visitor: any, opts: { rid?: string; departmentId?: string; source?: { type: string; url?: string } } = {}) {
  if (!getSetting<boolean>('Livechat_enabled')) throw badRequest('error-livechat-disabled', 'Atendimento desativado.');
  if (opts.rid) {
    const r = await one('SELECT room_id FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [opts.rid, visitor.id]);
    if (r) return { rid: r.room_id, newRoom: false };
  }
  const open = await openRoomOf(visitor.id);
  if (open) return { rid: open.room_id, newRoom: false };
  const departmentId = opts.departmentId || visitor.department_id || null;
  if (departmentId && !(await one('SELECT 1 FROM livechat_departments WHERE id = $1 AND enabled AND NOT archived', [departmentId]))) {
    throw badRequest('error-invalid-department', 'Departamento inválido.');
  }
  if (!(await isOnline(departmentId))) throw badRequest('error-no-agents-online', 'Nenhum atendente disponível no momento.');
  const rid = newId();
  await query(`INSERT INTO rooms (id, t, name, fname, users_count) VALUES ($1, 'l', $2, $3, 0)`, [rid, visitor.username, visitor.name || visitor.username]);
  await query(`INSERT INTO livechat_rooms (room_id, visitor_id, department_id, source) VALUES ($1,$2,$3,$4)`, [rid, visitor.id, departmentId, JSON.stringify(opts.source ?? { type: 'widget' })]);
  await query(`UPDATE livechat_visitors SET last_chat = $2, updated_at = now() WHERE id = $1`, [visitor.id, JSON.stringify({ _id: rid, ts: new Date().toISOString() })]);
  bus.joinRoom(visitorConnId(visitor.id), rid);
  return { rid, newRoom: true };
}

// ---------- Mensagens do visitante ----------

export async function sendVisitorMessage(visitor: any, rid: string, text: string, clientId?: string) {
  const lr = await one('SELECT * FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [rid, visitor.id]);
  if (!lr) throw notFound('error-room-not-found', 'Conversa não encontrada.');
  if (lr.status === 'closed') throw badRequest('error-room-closed', 'Conversa encerrada.');
  const msg = String(text ?? '').trim();
  const limit = getSetting<number>('Livechat_enable_message_character_limit') || getSetting<number>('Message_MaxAllowedSize');
  if (!msg) throw badRequest('error-invalid-message', 'Mensagem vazia.');
  if (msg.length > limit) throw badRequest('error-message-size-exceeded', `A mensagem excede ${limit} caracteres.`);
  const id = clientId && /^[A-Za-z0-9]{10,24}$/.test(clientId) && !(await one('SELECT 1 FROM messages WHERE id = $1', [clientId])) ? clientId : newId();
  const row = await one(
    `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, extra, unread) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7) RETURNING *`,
    [id, rid, visitor.username, visitor.name, msg, JSON.stringify({ visitorId: visitor.id, token: undefined }), !!lr.agent_id],
  );
  const lastMessage = { _id: id, msg: msg.slice(0, 200), u: { _id: visitor.id, username: visitor.username, name: visitor.name }, ts: row.created_at };
  await query(`UPDATE rooms SET msgs = msgs + 1, last_message = $2, lm = $3, updated_at = now() WHERE id = $1`, [rid, JSON.stringify(lastMessage), row.created_at]);
  await query(`UPDATE livechat_rooms SET last_visitor_msg = now() WHERE room_id = $1`, [rid]);
  const message = withExtra(row);
  bus.publish({ room: rid }, { type: 'message', action: 'inserted', message });
  const changed = await many(
    `UPDATE subscriptions SET unread = unread + 1, alert = true, open = true, updated_at = now() WHERE room_id = $1 RETURNING *`,
    [rid],
  );
  for (const s of changed) await notifySubscription(s.user_id, rid, 'updated', s);
  const room = await getRoom(rid);
  void dispatchNotifications({ userId: visitorConnId(visitor.id), username: visitor.name || visitor.username, sessionId: '' }, { ...room, t: 'd', uids: [] }, row, [], null).catch(() => {});
  bus.publish({ room: rid }, { type: 'room', action: 'updated', room: mapRoom(room) });
  // Mensagem do visitante tira a conversa da espera.
  if (lr.status === 'onhold') await resumeOnHold(null, rid);
  if (lr.status === 'queued' && room.msgs <= 1) {
    void routeRoom(rid, { announce: true }).catch(() => {});
  }
  return message;
}

export async function visitorHistory(visitor: any, rid: string, opts: { limit: number; before?: string }) {
  const lr = await one('SELECT 1 FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [rid, visitor.id]);
  if (!lr) throw notFound('error-room-not-found', 'Conversa não encontrada.');
  const rows = await many(
    `SELECT * FROM messages WHERE room_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       AND (t IS NULL OR t IN ('livechat-started','livechat-close','livechat_queue','livechat_transfer_history','omnichannel_placed_chat_on_hold','omnichannel_on_hold_chat_resumed','uj'))
     ORDER BY created_at DESC LIMIT $3`,
    [rid, opts.before ?? null, opts.limit],
  );
  return rows.map((r) => {
    const m = withExtra(r);
    delete m.token;
    return m;
  });
}

// ---------- Ações do agente ----------

async function requireRoomActor(ctx: Ctx, rid: string, perm: string) {
  const lr = await getLivechatRoomRow(rid);
  if (!lr) throw notFound('error-room-not-found', 'Atendimento não encontrado.');
  if (!(await hasPermission(ctx.userId, perm))) throw forbidden();
  // Quem atende a conversa, ou gerentes/monitores com acesso ao departamento.
  if (lr.agent_id !== ctx.userId && !(await canViewLivechatRoom(ctx.userId, rid))) throw forbidden('Você não está atendendo esta conversa.');
  return lr;
}

async function sendTranscript(rid: string, email: string) {
  const lr = await getLivechatRoomRow(rid);
  if (!lr) return false;
  const msgs = await many(`SELECT username, user_name, msg, t, created_at FROM messages WHERE room_id = $1 AND (t IS NULL) ORDER BY created_at`, [rid]);
  const site = getSetting<string>('Site_Name');
  const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const lines = msgs.map((m) => `[${fmt.format(new Date(m.created_at))}] ${m.user_name || m.username}: ${m.msg}`);
  return sendMail({ to: email, subject: `[${site}] Transcrição da conversa`, text: `Conversa com ${lr.a_name ?? 'atendimento'}\n\n${lines.join('\n')}` });
}

export async function closeRoom(by: { ctx?: Ctx; visitor?: any; system?: boolean }, rid: string, opts: { comment?: string; tags?: string[] } = {}) {
  const lr = by.ctx ? await requireRoomActor(by.ctx, rid, 'close-livechat-room') : await getLivechatRoomRow(rid);
  if (!lr) throw notFound('error-room-not-found', 'Atendimento não encontrado.');
  if (by.visitor && lr.visitor_id !== by.visitor.id) throw forbidden();
  if (lr.status === 'closed') throw badRequest('error-room-closed', 'A conversa já foi encerrada.');
  const tags = [...new Set([...(lr.tags ?? []), ...(opts.tags ?? []).map((t) => t.trim()).filter(Boolean)])];
  if (by.ctx) {
    if (getSetting<boolean>('Livechat_request_comment_when_closing_conversation') && !opts.comment?.trim()) throw badRequest('error-comment-required', 'Informe um comentário para encerrar.');
    if (lr.department_id) {
      const d = await one('SELECT request_tag_before_closing FROM livechat_departments WHERE id = $1', [lr.department_id]);
      if (d?.request_tag_before_closing && !tags.length) throw badRequest('error-tags-required', 'Este departamento exige ao menos uma tag para encerrar.');
    }
  }
  const closer = by.ctx ? 'user' : by.visitor ? 'visitor' : 'system';
  const closedBy = by.ctx ? { _id: by.ctx.userId, username: by.ctx.username } : by.visitor ? { _id: by.visitor.id, username: by.visitor.username } : null;
  const updated = await one(
    `UPDATE livechat_rooms SET status = 'closed', closed_at = now(), closer = $2, closed_by = $3, close_comment = $4, tags = $5
     WHERE room_id = $1 AND status <> 'closed' RETURNING *`,
    [rid, closer, closedBy ? JSON.stringify(closedBy) : null, opts.comment?.trim() || null, tags],
  );
  if (!updated) throw badRequest('error-room-closed', 'A conversa já foi encerrada.');
  const text = opts.comment?.trim() || '';
  if (by.ctx) await sendSystemMessage(rid, 'livechat-close', { id: by.ctx.userId, username: by.ctx.username }, text);
  else await systemFromQueue(rid, 'livechat-close', text || (by.visitor ? 'Encerrada pelo visitante' : getSetting<string>('Livechat_abandoned_rooms_closed_custom_message')), { closer });
  if (lr.agent_id) await removeUserFromRoom(rid, lr.agent_id, { silent: true });
  if (lr.status === 'queued') bus.publish({ users: await agentAudience(lr.department_id) }, { type: 'livechat.inquiry', action: 'removed', inquiry: inquiryOf(lr) });
  if (by.ctx) await audit(actorOf(by.ctx), 'livechat.room.closed', { rid, visitor: lr.v_username, tags });
  await publishRoomState(rid);
  if (lr.transcript_email && getSetting<boolean>('Livechat_enable_transcript')) void sendTranscript(rid, lr.transcript_email);
  void processQueue().catch(() => {});
}

export async function requestTranscript(visitor: any, rid: string, email: string) {
  const lr = await one('SELECT status FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [rid, visitor.id]);
  if (!lr) throw notFound('error-room-not-found', 'Conversa não encontrada.');
  if (!getSetting<boolean>('Livechat_enable_transcript')) throw badRequest('error-transcript-disabled', 'Transcrição desativada.');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
  await query('UPDATE livechat_rooms SET transcript_email = $2 WHERE room_id = $1', [rid, email]);
  if (lr.status === 'closed') await sendTranscript(rid, email);
}

export async function takeInquiry(ctx: Ctx, rid: string, userId?: string) {
  if (!(await hasPermission(ctx.userId, 'take-livechat-room'))) throw forbidden();
  const targetId = userId && userId !== ctx.userId ? userId : ctx.userId;
  if (targetId !== ctx.userId && !(await hasPermission(ctx.userId, 'view-livechat-manager'))) throw forbidden();
  const lr = await one('SELECT * FROM livechat_rooms WHERE room_id = $1', [rid]);
  if (!lr) throw notFound('error-room-not-found', 'Atendimento não encontrado.');
  if (lr.status !== 'queued') throw badRequest('error-inquiry-taken', 'Este atendimento já foi assumido.');
  const agent = await one(`SELECT u.id, u.username FROM users u WHERE u.id = $1 AND u.active AND 'livechat-agent' = ANY(u.roles)`, [targetId]);
  if (!agent) throw badRequest('error-not-agent', 'O usuário não é agente de atendimento.');
  const la = await one('SELECT max_chats FROM livechat_agents WHERE user_id = $1', [agent.id]);
  const dept = lr.department_id ? await one('SELECT max_chats_per_agent FROM livechat_departments WHERE id = $1', [lr.department_id]) : null;
  const max = la?.max_chats ?? (dept?.max_chats_per_agent || globalMax());
  if (max) {
    const n = (await one(`SELECT count(*)::int AS n FROM livechat_rooms WHERE agent_id = $1 AND status = 'open'`, [agent.id])).n;
    if (n >= max) throw badRequest('error-max-chats', `Limite de ${max} chats simultâneos atingido.`);
  }
  if (!(await assignAgent(rid, agent))) throw badRequest('error-inquiry-taken', 'Este atendimento já foi assumido.');
  return getLivechatRoom(rid);
}

export async function forwardRoom(ctx: Ctx, rid: string, to: { userId?: string; departmentId?: string; comment?: string }) {
  const lr = await requireRoomActor(ctx, rid, 'transfer-livechat-guest');
  if (lr.status === 'closed') throw badRequest('error-room-closed', 'A conversa já foi encerrada.');
  if (!to.userId && !to.departmentId) throw badRequest('error-invalid-target', 'Informe o agente ou o departamento de destino.');
  const prevAgent = lr.agent_id;
  if (to.userId) {
    if (to.userId === prevAgent) throw badRequest('error-same-agent', 'A conversa já está com este agente.');
    const target = await one(`SELECT u.id, u.username, u.name, u.status, la.status AS lstatus FROM users u LEFT JOIN livechat_agents la ON la.user_id = u.id WHERE u.id = $1 AND u.active AND 'livechat-agent' = ANY(u.roles)`, [to.userId]);
    if (!target) throw badRequest('error-not-agent', 'O destino não é um agente.');
    if (target.status === 'offline' || target.lstatus !== 'available') throw badRequest('error-agent-offline', 'O agente de destino não está disponível.');
    if (prevAgent) await removeUserFromRoom(rid, prevAgent, { silent: true });
    await query(`UPDATE livechat_rooms SET status = 'queued' WHERE room_id = $1`, [rid]);
    await assignAgent(rid, target, { fromQueue: true });
    await sendSystemMessage(rid, 'livechat_transfer_history', { id: ctx.userId, username: ctx.username }, to.comment?.trim() ?? '', {
      transferData: { scope: 'agent', transferredBy: { _id: ctx.userId, username: ctx.username }, transferredTo: { _id: target.id, username: target.username, name: target.name }, comment: to.comment },
    });
  } else {
    const dept = await one('SELECT id, name FROM livechat_departments WHERE id = $1 AND enabled AND NOT archived', [to.departmentId]);
    if (!dept) throw badRequest('error-invalid-department', 'Departamento inválido.');
    if (prevAgent) await removeUserFromRoom(rid, prevAgent, { silent: true });
    await query(`UPDATE livechat_rooms SET status = 'queued', agent_id = NULL, department_id = $2, queued_at = now() WHERE room_id = $1`, [rid, dept.id]);
    await sendSystemMessage(rid, 'livechat_transfer_history', { id: ctx.userId, username: ctx.username }, to.comment?.trim() ?? '', {
      transferData: { scope: 'department', transferredBy: { _id: ctx.userId, username: ctx.username }, nextDepartment: { _id: dept.id, name: dept.name }, comment: to.comment },
    });
    await routeRoom(rid, { exclude: prevAgent ? [prevAgent] : [] });
  }
  await audit(actorOf(ctx), 'livechat.room.forwarded', { rid, to });
  await publishRoomState(rid);
  return getLivechatRoom(rid);
}

export async function returnToQueue(ctx: Ctx, rid: string) {
  const lr = await requireRoomActor(ctx, rid, 'view-l-room');
  if (lr.status !== 'open' && lr.status !== 'onhold') throw badRequest('error-invalid-status', 'Só é possível devolver conversas em andamento.');
  if (lr.agent_id) await removeUserFromRoom(rid, lr.agent_id, { silent: true });
  await query(`UPDATE livechat_rooms SET status = 'queued', agent_id = NULL, onhold_at = NULL, queued_at = now() WHERE room_id = $1`, [rid]);
  await sendSystemMessage(rid, 'livechat_transfer_history', { id: ctx.userId, username: ctx.username }, '', { transferData: { scope: 'queue', transferredBy: { _id: ctx.userId, username: ctx.username } } });
  await routeRoom(rid, { exclude: lr.agent_id ? [lr.agent_id] : [] });
  await publishRoomState(rid);
}

export async function placeOnHold(ctx: Ctx, rid: string) {
  if (!getSetting<boolean>('Livechat_allow_manual_on_hold')) throw badRequest('error-on-hold-disabled', 'Colocar em espera está desativado.');
  const lr = await requireRoomActor(ctx, rid, 'on-hold-livechat-room');
  if (lr.status !== 'open') throw badRequest('error-invalid-status', 'Só conversas em andamento podem ir para espera.');
  if (lr.last_visitor_msg && (!lr.last_agent_msg || new Date(lr.last_visitor_msg) > new Date(lr.last_agent_msg))) {
    throw badRequest('error-visitor-waiting', 'O visitante está aguardando sua resposta.');
  }
  await query(`UPDATE livechat_rooms SET status = 'onhold', onhold_at = now() WHERE room_id = $1`, [rid]);
  await sendSystemMessage(rid, 'omnichannel_placed_chat_on_hold', { id: ctx.userId, username: ctx.username }, '');
  await publishRoomState(rid);
  void processQueue().catch(() => {});
}

export async function resumeOnHold(ctx: Ctx | null, rid: string) {
  const lr = ctx ? await requireRoomActor(ctx, rid, 'on-hold-livechat-room') : await getLivechatRoomRow(rid);
  if (!lr || lr.status !== 'onhold') return;
  await query(`UPDATE livechat_rooms SET status = 'open', onhold_at = NULL WHERE room_id = $1`, [rid]);
  if (ctx) await sendSystemMessage(rid, 'omnichannel_on_hold_chat_resumed', { id: ctx.userId, username: ctx.username }, '');
  else await systemFromQueue(rid, 'omnichannel_on_hold_chat_resumed', '');
  await publishRoomState(rid);
}

export async function saveRoomInfo(ctx: Ctx, rid: string, data: { guestData?: { name?: string; email?: string; phone?: string }; roomData?: { topic?: string; tags?: string[]; livechatData?: Record<string, unknown>; priorityId?: string | null; slaId?: string | null } }) {
  const lr = await requireRoomActor(ctx, rid, 'view-l-room');
  const g = data.guestData ?? {};
  if (g.name !== undefined || g.email !== undefined || g.phone !== undefined) {
    if (g.email && !/^[^\s@]+@[^\s@]+$/.test(g.email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
    await query(
      `UPDATE livechat_visitors SET name = coalesce(NULLIF($2, ''), name), email = CASE WHEN $3::text IS NULL THEN email ELSE NULLIF($3, '') END,
         phone = CASE WHEN $4::text IS NULL THEN phone ELSE NULLIF($4, '') END, updated_at = now() WHERE id = $1`,
      [lr.visitor_id, g.name?.trim() ?? '', g.email ?? null, g.phone ?? null],
    );
    if (g.name?.trim()) await query('UPDATE rooms SET fname = $2, updated_at = now() WHERE id = $1', [rid, g.name.trim()]);
  }
  const rd = data.roomData ?? {};
  if (rd.topic !== undefined) await query('UPDATE rooms SET topic = $2, updated_at = now() WHERE id = $1', [rid, String(rd.topic).slice(0, 300)]);
  if (rd.tags) await query('UPDATE livechat_rooms SET tags = $2 WHERE room_id = $1', [rid, [...new Set(rd.tags.map((t) => String(t).trim()).filter(Boolean))]]);
  if (rd.livechatData) {
    const fields = await validateCustomFields('room', rd.livechatData);
    await query('UPDATE livechat_rooms SET livechat_data = livechat_data || $2 WHERE room_id = $1', [rid, JSON.stringify(fields)]);
  }
  if (rd.priorityId !== undefined) {
    if (!(await hasPermission(ctx.userId, 'manage-livechat-priorities')) && !(await hasPermission(ctx.userId, 'view-l-room'))) throw forbidden();
    if (rd.priorityId && !(await one('SELECT 1 FROM livechat_priorities WHERE id = $1', [rd.priorityId]))) throw badRequest('error-invalid-priority', 'Prioridade inválida.');
    await query('UPDATE livechat_rooms SET priority_id = $2 WHERE room_id = $1', [rid, rd.priorityId || null]);
  }
  if (rd.slaId !== undefined) {
    const sla = rd.slaId ? await one('SELECT * FROM livechat_sla WHERE id = $1', [rd.slaId]) : null;
    if (rd.slaId && !sla) throw badRequest('error-invalid-sla', 'SLA inválido.');
    await query(`UPDATE livechat_rooms SET sla_id = $2, sla_due = CASE WHEN $2::text IS NULL THEN NULL ELSE queued_at + make_interval(mins => $3) END WHERE room_id = $1`, [rid, sla?.id ?? null, sla?.due_time_minutes ?? 0]);
  }
  await publishRoomState(rid);
  bus.publish({ room: rid }, { type: 'room', action: 'updated', room: mapRoom(await getRoom(rid)) });
  return getLivechatRoom(rid);
}

export async function saveSurvey(visitor: any, rid: string, data: { name: string; value: string }[]) {
  const lr = await one('SELECT 1 FROM livechat_rooms WHERE room_id = $1 AND visitor_id = $2', [rid, visitor.id]);
  if (!lr) throw notFound('error-room-not-found', 'Conversa não encontrada.');
  const allowed = ['satisfaction', 'agentKnowledge', 'agentResposiveness', 'agentFriendliness', 'additionalFeedback'];
  const survey: Record<string, string> = {};
  for (const d of data ?? []) if (allowed.includes(d.name)) survey[d.name] = String(d.value).slice(0, 1000);
  await query('UPDATE livechat_rooms SET survey = coalesce(survey, $3::jsonb) || $2 WHERE room_id = $1', [rid, JSON.stringify(survey), '{}']);
}

export async function saveOfflineMessage(input: { name: string; email: string; message: string; department?: string; host?: string }) {
  if (!input.name?.trim() || !input.message?.trim()) throw badRequest('error-invalid-params', 'Preencha nome e mensagem.');
  if (!/^[^\s@]+@[^\s@]+$/.test(input.email ?? '')) throw badRequest('error-invalid-email', 'E-mail inválido.');
  const dept = input.department ? await one('SELECT id, name, email FROM livechat_departments WHERE id = $1', [input.department]) : null;
  await query('INSERT INTO livechat_offline_messages (id, name, email, message, department_id, host) VALUES ($1,$2,$3,$4,$5,$6)', [
    newId(),
    input.name.trim().slice(0, 120),
    input.email.trim(),
    input.message.trim().slice(0, 5000),
    dept?.id ?? null,
    input.host?.slice(0, 300) ?? null,
  ]);
  const to = dept?.email || getSetting<string>('Livechat_offline_email');
  if (to) {
    void sendMail({
      to,
      subject: `[${getSetting<string>('Site_Name')}] Mensagem offline de ${input.name}`,
      text: `Nome: ${input.name}\nE-mail: ${input.email}${dept ? `\nDepartamento: ${dept.name}` : ''}\n\n${input.message}`,
    });
  }
}

// ---------- Rotinas periódicas ----------

export async function runOmnichannelTimers() {
  if (!getSetting<boolean>('Livechat_enabled')) return;
  const abandon = getSetting<number>('Livechat_auto_close_abandoned_rooms');
  if (abandon > 0) {
    const rows = await many(
      `SELECT room_id FROM livechat_rooms WHERE status = 'open' AND last_agent_msg IS NOT NULL
         AND (last_visitor_msg IS NULL OR last_agent_msg > last_visitor_msg) AND last_agent_msg < now() - make_interval(secs => $1)`,
      [abandon],
    );
    for (const r of rows) await closeRoom({ system: true }, r.room_id).catch(() => {});
  }
  const onhold = getSetting<number>('Livechat_auto_close_on_hold_chats_timeout');
  if (onhold > 0) {
    const rows = await many(`SELECT room_id FROM livechat_rooms WHERE status = 'onhold' AND onhold_at < now() - make_interval(secs => $1)`, [onhold]);
    for (const r of rows) await closeRoom({ system: true }, r.room_id, { comment: 'Encerrada após tempo em espera.' }).catch(() => {});
  }
  const maxWait = getSetting<number>('Livechat_max_queue_wait_time');
  if (maxWait > 0) {
    const rows = await many(`SELECT room_id FROM livechat_rooms WHERE status = 'queued' AND queued_at < now() - make_interval(mins => $1)`, [maxWait]);
    for (const r of rows) await closeRoom({ system: true }, r.room_id, { comment: 'Tempo máximo na fila atingido.' }).catch(() => {});
  }
  await processQueue();
}

// ---------- Ganchos ----------

let registered = false;
export function registerOmnichannelHooks() {
  if (registered) return;
  registered = true;
  on('message.sent', async ({ room, message, user }) => {
    if (room.t !== 'l' || message.t || !user) return;
    await query(
      `UPDATE livechat_rooms SET last_agent_msg = now(), first_response_at = coalesce(first_response_at, now()) WHERE room_id = $1`,
      [room.id],
    );
  });
}
