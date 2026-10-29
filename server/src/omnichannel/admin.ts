import { many, one, query, tx } from '../db/pool';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { hasPermission } from '../services/permissions';
import { removeFiles } from '../services/uploads';
import { actorOf, type Ctx } from '../services/users';
import { departmentScope, getAgentStatus, getLivechatRoom, isBusinessHourOpen, mapVisitor, processQueue, setAgentStatus } from './service';
import { recordHistory } from '../services/rbacHistory';

// Gestão do omnichannel: departamentos, agentes, gerentes, monitores, unidades, respostas prontas,
// tags, prioridades, SLA, horários, campos personalizados, gatilhos, contatos e relatórios.

const clean = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);

async function need(ctx: Ctx, perm: string | string[]) {
  const perms = Array.isArray(perm) ? perm : [perm];
  for (const p of perms) if (await hasPermission(ctx.userId, p)) return;
  throw forbidden();
}

// ---------- Agentes, gerentes e monitores ----------

const ROLE_OF = { agent: 'livechat-agent', manager: 'livechat-manager', monitor: 'livechat-monitor' } as const;
export type LivechatUserType = keyof typeof ROLE_OF;

export async function listLivechatUsers(ctx: Ctx, type: LivechatUserType, opts: { text?: string; offset: number; count: number }) {
  await need(ctx, type === 'agent' ? ['manage-livechat-agents', 'view-livechat-manager', 'transfer-livechat-guest'] : type === 'manager' ? 'manage-livechat-managers' : 'manage-livechat-monitors');
  const role = ROLE_OF[type];
  const params: unknown[] = [role];
  let where = `$1 = ANY(u.roles) AND u.active`;
  if (opts.text) where += ` AND (u.username ILIKE $${params.push(`%${opts.text}%`)} OR u.name ILIKE $${params.length})`;
  const rows = await many(
    `SELECT u.id, u.username, u.name, u.email, u.status, la.status AS livechat_status, la.max_chats, la.total_chats,
       (SELECT count(*) FROM livechat_rooms lr WHERE lr.agent_id = u.id AND lr.status = 'open')::int AS open_chats,
       (SELECT coalesce(array_agg(d.name ORDER BY d.name), '{}') FROM livechat_department_agents da JOIN livechat_departments d ON d.id = da.department_id WHERE da.user_id = u.id) AS departments
     FROM users u LEFT JOIN livechat_agents la ON la.user_id = u.id
     WHERE ${where} ORDER BY u.username OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`,
    params,
  );
  const total = await one(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params.slice(0, params.length - 2));
  return {
    users: rows.map((u) => ({
      _id: u.id,
      username: u.username,
      name: u.name,
      emails: u.email ? [{ address: u.email }] : [],
      status: u.status,
      statusLivechat: u.livechat_status ?? 'not-available',
      livechat: { maxNumberSimultaneousChat: u.max_chats ?? undefined },
      totalChats: u.total_chats ?? 0,
      openChats: u.open_chats,
      departments: u.departments,
    })),
    offset: opts.offset,
    count: rows.length,
    total: total.n,
  };
}

export async function addLivechatUser(ctx: Ctx, type: LivechatUserType, username: string) {
  await need(ctx, type === 'agent' ? 'manage-livechat-agents' : type === 'manager' ? 'manage-livechat-managers' : 'manage-livechat-monitors');
  const user = await one('SELECT id, username, name FROM users WHERE lower(username) = lower($1) AND active', [clean(username).replace(/^@/, '')]);
  if (!user) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  await setLivechatRole(ctx, user, ROLE_OF[type], true);
  if (type === 'agent') await query(`INSERT INTO livechat_agents (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);
  await audit(actorOf(ctx), 'livechat.user.added', { type, userId: user.id, username: user.username });
  bus.publish({ user: user.id }, { type: 'permissions.changed' });
  return { _id: user.id, username: user.username, name: user.name };
}

export async function removeLivechatUser(ctx: Ctx, type: LivechatUserType, userId: string) {
  await need(ctx, type === 'agent' ? 'manage-livechat-agents' : type === 'manager' ? 'manage-livechat-managers' : 'manage-livechat-monitors');
  const user = await one('SELECT id, username FROM users WHERE id = $1', [userId]);
  if (!user) throw notFound('error-invalid-user', 'Usuário não encontrado.');
  await setLivechatRole(ctx, user, ROLE_OF[type], false);
  if (type === 'agent') {
    await query(`UPDATE livechat_agents SET status = 'not-available' WHERE user_id = $1`, [user.id]);
    await query('DELETE FROM livechat_department_agents WHERE user_id = $1', [user.id]);
  }
  if (type === 'monitor') await query('DELETE FROM livechat_unit_monitors WHERE user_id = $1', [user.id]);
  await audit(actorOf(ctx), 'livechat.user.removed', { type, userId: user.id, username: user.username });
  bus.publish({ user: user.id }, { type: 'permissions.changed' });
}

export async function updateAgent(ctx: Ctx, userId: string, data: { maxNumberSimultaneousChat?: number | null; departments?: string[]; status?: 'available' | 'not-available' }) {
  await need(ctx, 'manage-livechat-agents');
  const agent = await one(`SELECT id FROM users WHERE id = $1 AND 'livechat-agent' = ANY(roles)`, [userId]);
  if (!agent) throw notFound('error-invalid-agent', 'Agente não encontrado.');
  if (data.maxNumberSimultaneousChat !== undefined) {
    const v = data.maxNumberSimultaneousChat === null || data.maxNumberSimultaneousChat === ('' as any) ? null : Math.max(0, Number(data.maxNumberSimultaneousChat));
    await query(`INSERT INTO livechat_agents (user_id, max_chats) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET max_chats = EXCLUDED.max_chats`, [userId, v]);
  }
  if (data.departments) {
    await tx(async (c) => {
      await c.query('DELETE FROM livechat_department_agents WHERE user_id = $1 AND NOT (department_id = ANY($2))', [userId, data.departments]);
      for (const d of data.departments!) await c.query('INSERT INTO livechat_department_agents (department_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [d, userId]);
    });
  }
  if (data.status) await setAgentStatus(userId, data.status);
  void processQueue().catch(() => {});
}

export async function agentInfo(userId: string) {
  const u = await one(
    `SELECT u.id, u.username, u.name, u.email, u.status, la.status AS livechat_status, la.max_chats FROM users u LEFT JOIN livechat_agents la ON la.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  if (!u) return null;
  const departments = await many(
    `SELECT d.id, d.name FROM livechat_department_agents da JOIN livechat_departments d ON d.id = da.department_id WHERE da.user_id = $1 ORDER BY d.name`,
    [userId],
  );
  return {
    _id: u.id,
    username: u.username,
    name: u.name,
    status: u.status,
    statusLivechat: u.livechat_status ?? (await getAgentStatus(userId)),
    livechat: { maxNumberSimultaneousChat: u.max_chats ?? undefined },
    departments: departments.map((d) => ({ _id: d.id, name: d.name })),
  };
}

// ---------- Departamentos ----------

function mapDepartment(d: any) {
  return {
    _id: d.id,
    name: d.name,
    description: d.description,
    enabled: d.enabled,
    showOnRegistration: d.show_on_registration,
    showOnOfflineForm: d.show_on_offline_form,
    email: d.email,
    requestTagBeforeClosingChat: d.request_tag_before_closing,
    maxNumberSimultaneousChat: d.max_chats_per_agent,
    fallbackForwardDepartment: d.fallback_department_id,
    businessHourId: d.business_hour_id,
    unitId: d.unit_id,
    waitingQueueMessage: d.waiting_queue_message,
    archived: d.archived,
    numAgents: d.num_agents ?? undefined,
    _updatedAt: d.updated_at,
  };
}

export async function listDepartments(ctx: Ctx | null, opts: { text?: string; enabledOnly?: boolean; offset: number; count: number; onlyMyDepartments?: boolean }) {
  const params: unknown[] = [];
  const where: string[] = ['NOT d.archived'];
  if (opts.enabledOnly) where.push('d.enabled');
  if (opts.text) where.push(`d.name ILIKE $${params.push(`%${opts.text}%`)}`);
  if (ctx) {
    const scope = await departmentScope(ctx.userId);
    if (scope) where.push(`d.id = ANY($${params.push(scope)})`);
    if (opts.onlyMyDepartments) where.push(`EXISTS (SELECT 1 FROM livechat_department_agents x WHERE x.department_id = d.id AND x.user_id = $${params.push(ctx.userId)})`);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const rows = await many(
    `SELECT d.*, (SELECT count(*) FROM livechat_department_agents da WHERE da.department_id = d.id)::int AS num_agents
     FROM livechat_departments d ${w} ORDER BY d.name OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`,
    params,
  );
  const total = await one(`SELECT count(*)::int AS n FROM livechat_departments d ${w}`, params.slice(0, params.length - 2));
  return { departments: rows.map(mapDepartment), offset: opts.offset, count: rows.length, total: total.n };
}

export async function getDepartment(id: string) {
  const d = await one('SELECT * FROM livechat_departments WHERE id = $1', [id]);
  if (!d) throw notFound('error-invalid-department', 'Departamento não encontrado.');
  const agents = await many(
    `SELECT da.user_id, da.count, da.sort_order, u.username, u.name FROM livechat_department_agents da JOIN users u ON u.id = da.user_id WHERE da.department_id = $1 ORDER BY da.sort_order, u.username`,
    [id],
  );
  return {
    department: mapDepartment(d),
    agents: agents.map((a) => ({ agentId: a.user_id, username: a.username, name: a.name, count: a.count, order: a.sort_order })),
  };
}

export interface DepartmentInput {
  name: string;
  description?: string;
  enabled?: boolean;
  showOnRegistration?: boolean;
  showOnOfflineForm?: boolean;
  email?: string;
  requestTagBeforeClosingChat?: boolean;
  maxNumberSimultaneousChat?: number;
  fallbackForwardDepartment?: string | null;
  businessHourId?: string | null;
  unitId?: string | null;
  waitingQueueMessage?: string;
}

export async function saveDepartment(ctx: Ctx, id: string | null, input: DepartmentInput, agents?: { agentId: string; count?: number; order?: number }[]) {
  await need(ctx, 'manage-livechat-departments');
  const name = clean(input.name, 100);
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome do departamento.');
  const dup = await one('SELECT id FROM livechat_departments WHERE lower(name) = lower($1) AND id <> coalesce($2, \'\')', [name, id]);
  if (dup) throw badRequest('error-duplicate-department', 'Já existe um departamento com este nome.');
  if (input.fallbackForwardDepartment && input.fallbackForwardDepartment === id) throw badRequest('error-invalid-fallback', 'O departamento reserva não pode ser o próprio.');
  const vals = [
    name,
    clean(input.description, 1000),
    input.enabled ?? true,
    input.showOnRegistration ?? true,
    input.showOnOfflineForm ?? true,
    clean(input.email) || null,
    input.requestTagBeforeClosingChat ?? false,
    Math.max(0, Number(input.maxNumberSimultaneousChat ?? 0) || 0),
    input.fallbackForwardDepartment || null,
    input.businessHourId || null,
    input.unitId || null,
    clean(input.waitingQueueMessage, 500) || null,
  ];
  const deptId = id ?? newId();
  if (id) {
    const r = await one(
      `UPDATE livechat_departments SET name=$2, description=$3, enabled=$4, show_on_registration=$5, show_on_offline_form=$6, email=$7,
         request_tag_before_closing=$8, max_chats_per_agent=$9, fallback_department_id=$10, business_hour_id=$11, unit_id=$12, waiting_queue_message=$13, updated_at=now()
       WHERE id=$1 RETURNING id`,
      [id, ...vals],
    );
    if (!r) throw notFound('error-invalid-department', 'Departamento não encontrado.');
  } else {
    await query(
      `INSERT INTO livechat_departments (id, name, description, enabled, show_on_registration, show_on_offline_form, email, request_tag_before_closing,
         max_chats_per_agent, fallback_department_id, business_hour_id, unit_id, waiting_queue_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [deptId, ...vals],
    );
  }
  if (agents) await setDepartmentAgents(deptId, agents);
  await audit(actorOf(ctx), id ? 'livechat.department.updated' : 'livechat.department.created', { departmentId: deptId, name });
  void processQueue().catch(() => {});
  return getDepartment(deptId);
}

export async function setDepartmentAgents(departmentId: string, agents: { agentId: string; count?: number; order?: number }[]) {
  const valid = await many(`SELECT id FROM users WHERE id = ANY($1) AND 'livechat-agent' = ANY(roles)`, [agents.map((a) => a.agentId)]);
  const ok = new Set(valid.map((v) => v.id));
  await tx(async (c) => {
    await c.query('DELETE FROM livechat_department_agents WHERE department_id = $1 AND NOT (user_id = ANY($2))', [departmentId, [...ok]]);
    for (const a of agents) {
      if (!ok.has(a.agentId)) continue;
      await c.query(
        `INSERT INTO livechat_department_agents (department_id, user_id, count, sort_order) VALUES ($1,$2,$3,$4)
         ON CONFLICT (department_id, user_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [departmentId, a.agentId, a.count ?? 0, a.order ?? 0],
      );
    }
  });
}

export async function removeDepartment(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-departments');
  const open = await one(`SELECT count(*)::int AS n FROM livechat_rooms WHERE department_id = $1 AND status <> 'closed'`, [id]);
  if (open.n > 0) {
    // Com conversas em andamento, só arquiva.
    await query('UPDATE livechat_departments SET archived = true, enabled = false, updated_at = now() WHERE id = $1', [id]);
  } else {
    await query('DELETE FROM livechat_departments WHERE id = $1', [id]);
  }
  await audit(actorOf(ctx), 'livechat.department.removed', { departmentId: id });
}

// ---------- Unidades e monitores ----------

export async function listUnits(ctx: Ctx) {
  await need(ctx, ['manage-livechat-units', 'view-livechat-manager']);
  const rows = await many(
    `SELECT un.*, (SELECT coalesce(array_agg(d.id), '{}') FROM livechat_departments d WHERE d.unit_id = un.id) AS departments,
       (SELECT coalesce(json_agg(json_build_object('_id', u.id, 'username', u.username)), '[]') FROM livechat_unit_monitors m JOIN users u ON u.id = m.user_id WHERE m.unit_id = un.id) AS monitors
     FROM livechat_units un ORDER BY un.name`,
  );
  return rows.map((u) => ({ _id: u.id, name: u.name, visibility: u.visibility, departments: u.departments, monitors: u.monitors }));
}

export async function saveUnit(ctx: Ctx, id: string | null, input: { name: string; visibility?: string; departments?: string[]; monitors?: string[] }) {
  await need(ctx, 'manage-livechat-units');
  const name = clean(input.name, 100);
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome da unidade.');
  const unitId = id ?? newId();
  await tx(async (c) => {
    if (id) await c.query('UPDATE livechat_units SET name = $2, visibility = $3 WHERE id = $1', [id, name, input.visibility === 'private' ? 'private' : 'public']);
    else await c.query('INSERT INTO livechat_units (id, name, visibility) VALUES ($1,$2,$3)', [unitId, name, input.visibility === 'private' ? 'private' : 'public']);
    if (input.departments) {
      await c.query('UPDATE livechat_departments SET unit_id = NULL WHERE unit_id = $1 AND NOT (id = ANY($2))', [unitId, input.departments]);
      await c.query('UPDATE livechat_departments SET unit_id = $1 WHERE id = ANY($2)', [unitId, input.departments]);
    }
    if (input.monitors) {
      const valid = (await c.query(`SELECT id FROM users WHERE id = ANY($1) AND 'livechat-monitor' = ANY(roles)`, [input.monitors])).rows.map((r) => r.id);
      await c.query('DELETE FROM livechat_unit_monitors WHERE unit_id = $1', [unitId]);
      for (const m of valid) await c.query('INSERT INTO livechat_unit_monitors (unit_id, user_id) VALUES ($1,$2)', [unitId, m]);
    }
  });
  await audit(actorOf(ctx), id ? 'livechat.unit.updated' : 'livechat.unit.created', { unitId, name });
  return (await listUnits(ctx)).find((u) => u._id === unitId);
}

export async function removeUnit(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-units');
  await query('DELETE FROM livechat_units WHERE id = $1', [id]);
}

// ---------- Respostas prontas ----------

function mapCanned(r: any) {
  return {
    _id: r.id,
    shortcut: r.shortcut,
    text: r.text,
    scope: r.scope,
    departmentId: r.department_id ?? undefined,
    departmentName: r.department_name ?? undefined,
    userId: r.user_id ?? undefined,
    tags: r.tags,
    createdBy: r.created_by,
    _createdAt: r.created_at,
    _updatedAt: r.updated_at,
  };
}

// Respostas que o agente pode usar: globais, dos seus departamentos e as pessoais.
export async function cannedForAgent(ctx: Ctx) {
  await need(ctx, 'view-canned-responses');
  const rows = await many(
    `SELECT c.*, d.name AS department_name FROM livechat_canned_responses c LEFT JOIN livechat_departments d ON d.id = c.department_id
     WHERE c.scope = 'global' OR (c.scope = 'user' AND c.user_id = $1)
        OR (c.scope = 'department' AND (c.department_id IN (SELECT department_id FROM livechat_department_agents WHERE user_id = $1)
             OR EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.roles && ARRAY['admin','livechat-manager','livechat-monitor'])))
     ORDER BY c.shortcut`,
    [ctx.userId],
  );
  return rows.map(mapCanned);
}

export async function listCanned(ctx: Ctx, opts: { text?: string; scope?: string; offset: number; count: number }) {
  const manager = await hasPermission(ctx.userId, 'manage-livechat-canned-responses');
  if (!manager) await need(ctx, 'view-canned-responses');
  const params: unknown[] = [];
  const where: string[] = [];
  if (!manager) where.push(`(c.scope = 'user' AND c.user_id = $${params.push(ctx.userId)})`);
  if (opts.scope) where.push(`c.scope = $${params.push(opts.scope)}`);
  if (opts.text) where.push(`(c.shortcut ILIKE $${params.push(`%${opts.text}%`)} OR c.text ILIKE $${params.length})`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await many(
    `SELECT c.*, d.name AS department_name FROM livechat_canned_responses c LEFT JOIN livechat_departments d ON d.id = c.department_id ${w}
     ORDER BY c.shortcut OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`,
    params,
  );
  const total = await one(`SELECT count(*)::int AS n FROM livechat_canned_responses c ${w}`, params.slice(0, params.length - 2));
  return { cannedResponses: rows.map(mapCanned), offset: opts.offset, count: rows.length, total: total.n };
}

export async function saveCanned(ctx: Ctx, input: { _id?: string; shortcut: string; text: string; scope: string; departmentId?: string; tags?: string[] }) {
  const manager = await hasPermission(ctx.userId, 'manage-livechat-canned-responses');
  const scope = ['global', 'department', 'user'].includes(input.scope) ? input.scope : 'user';
  if (scope !== 'user' && !manager) throw forbidden('Só gerentes criam respostas globais ou de departamento.');
  if (scope === 'user') await need(ctx, ['view-canned-responses', 'manage-livechat-canned-responses']);
  const shortcut = clean(input.shortcut, 60).replace(/^!/, '').replace(/\s+/g, '-');
  const text = String(input.text ?? '').trim().slice(0, 5000);
  if (!shortcut || !text) throw badRequest('error-invalid-params', 'Informe o atalho e o texto.');
  if (scope === 'department' && !input.departmentId) throw badRequest('error-invalid-department', 'Escolha o departamento.');
  const dup = await one(
    `SELECT id FROM livechat_canned_responses WHERE lower(shortcut) = lower($1) AND id <> coalesce($2, '') AND (scope <> 'user' OR user_id = $3)`,
    [shortcut, input._id ?? null, ctx.userId],
  );
  if (dup) throw badRequest('error-duplicate-shortcut', 'Já existe uma resposta com este atalho.');
  const tags = (input.tags ?? []).map((t) => clean(t, 50)).filter(Boolean);
  const me = await one('SELECT username FROM users WHERE id = $1', [ctx.userId]);
  if (input._id) {
    const cur = await one('SELECT * FROM livechat_canned_responses WHERE id = $1', [input._id]);
    if (!cur) throw notFound('error-invalid-canned', 'Resposta não encontrada.');
    if (!manager && !(cur.scope === 'user' && cur.user_id === ctx.userId)) throw forbidden();
    await query(
      `UPDATE livechat_canned_responses SET shortcut=$2, text=$3, scope=$4, department_id=$5, user_id=$6, tags=$7, updated_at=now() WHERE id=$1`,
      [input._id, shortcut, text, scope, scope === 'department' ? input.departmentId : null, scope === 'user' ? cur.user_id ?? ctx.userId : null, tags],
    );
    return mapCanned(await one('SELECT * FROM livechat_canned_responses WHERE id = $1', [input._id]));
  }
  const row = await one(
    `INSERT INTO livechat_canned_responses (id, shortcut, text, scope, department_id, user_id, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [newId(), shortcut, text, scope, scope === 'department' ? input.departmentId : null, scope === 'user' ? ctx.userId : null, tags, JSON.stringify({ _id: ctx.userId, username: me?.username })],
  );
  return mapCanned(row);
}

export async function removeCanned(ctx: Ctx, id: string) {
  const cur = await one('SELECT * FROM livechat_canned_responses WHERE id = $1', [id]);
  if (!cur) throw notFound('error-invalid-canned', 'Resposta não encontrada.');
  const manager = await hasPermission(ctx.userId, 'manage-livechat-canned-responses');
  if (!manager && !(cur.scope === 'user' && cur.user_id === ctx.userId)) throw forbidden();
  await query('DELETE FROM livechat_canned_responses WHERE id = $1', [id]);
}

// ---------- Tags, prioridades e SLA ----------

export async function listTags(departmentId?: string) {
  const rows = departmentId
    ? await many(`SELECT * FROM livechat_tags WHERE cardinality(departments) = 0 OR $1 = ANY(departments) ORDER BY name`, [departmentId])
    : await many('SELECT * FROM livechat_tags ORDER BY name');
  return rows.map((t) => ({ _id: t.id, name: t.name, description: t.description, departments: t.departments }));
}

export async function saveTag(ctx: Ctx, id: string | null, input: { name: string; description?: string; departments?: string[] }) {
  await need(ctx, 'manage-livechat-tags');
  const name = clean(input.name, 60);
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome da tag.');
  const dup = await one(`SELECT id FROM livechat_tags WHERE lower(name) = lower($1) AND id <> coalesce($2, '')`, [name, id]);
  if (dup) throw badRequest('error-duplicate-tag', 'Já existe uma tag com este nome.');
  const tagId = id ?? newId();
  await query(
    `INSERT INTO livechat_tags (id, name, description, departments) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, departments = EXCLUDED.departments`,
    [tagId, name, clean(input.description, 500), input.departments ?? []],
  );
  return (await listTags()).find((t) => t._id === tagId);
}

export async function removeTag(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-tags');
  await query('DELETE FROM livechat_tags WHERE id = $1', [id]);
}

export async function listPriorities() {
  const rows = await many('SELECT * FROM livechat_priorities ORDER BY sort_item');
  return rows.map((p) => ({ _id: p.id, name: p.name, sortItem: p.sort_item, dirty: p.dirty }));
}

export async function updatePriority(ctx: Ctx, id: string, name: string | null) {
  await need(ctx, 'manage-livechat-priorities');
  const defaults: Record<string, string> = { highest: 'Altíssima', high: 'Alta', medium: 'Média', low: 'Baixa', lowest: 'Baixíssima' };
  if (!defaults[id]) throw notFound('error-invalid-priority', 'Prioridade não encontrada.');
  await query('UPDATE livechat_priorities SET name = $2, dirty = $3 WHERE id = $1', [id, clean(name, 60) || defaults[id], !!clean(name, 60)]);
}

export async function listSla() {
  const rows = await many('SELECT * FROM livechat_sla ORDER BY due_time_minutes');
  return rows.map((s) => ({ _id: s.id, name: s.name, description: s.description, dueTimeInMinutes: s.due_time_minutes }));
}

export async function saveSla(ctx: Ctx, id: string | null, input: { name: string; description?: string; dueTimeInMinutes: number }) {
  await need(ctx, 'manage-livechat-sla');
  const name = clean(input.name, 60);
  const due = Math.floor(Number(input.dueTimeInMinutes));
  if (!name || !(due > 0)) throw badRequest('error-invalid-params', 'Informe nome e prazo em minutos.');
  const slaId = id ?? newId();
  await query(
    `INSERT INTO livechat_sla (id, name, description, due_time_minutes) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, due_time_minutes = EXCLUDED.due_time_minutes`,
    [slaId, name, clean(input.description, 500), due],
  );
  // Recalcula o prazo das conversas na fila com este SLA.
  await query(`UPDATE livechat_rooms SET sla_due = queued_at + make_interval(mins => $2) WHERE sla_id = $1 AND status = 'queued'`, [slaId, due]);
  return (await listSla()).find((s) => s._id === slaId);
}

export async function removeSla(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-sla');
  await query('DELETE FROM livechat_sla WHERE id = $1', [id]);
}

// ---------- Horários de atendimento ----------

function mapBH(b: any) {
  return { _id: b.id, name: b.name, type: b.type, active: b.active, timezone: { name: b.timezone }, workHours: b.work_hours, isOpenNow: isBusinessHourOpen(b), departments: b.departments ?? [] };
}

export async function listBusinessHours() {
  const rows = await many(
    `SELECT b.*, (SELECT coalesce(json_agg(json_build_object('_id', d.id, 'name', d.name)), '[]') FROM livechat_departments d WHERE d.business_hour_id = b.id) AS departments
     FROM livechat_business_hours b ORDER BY (b.type = 'default') DESC, b.name`,
  );
  return rows.map(mapBH);
}

export async function saveBusinessHour(ctx: Ctx, id: string | null, input: { name: string; active?: boolean; timezone?: string; workHours: { day: number; open: string; close: string; enabled: boolean }[]; departments?: string[] }) {
  await need(ctx, 'manage-livechat-business-hours');
  const name = clean(input.name, 100);
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome.');
  const tz = clean(input.timezone || 'America/Sao_Paulo', 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw badRequest('error-invalid-timezone', 'Fuso horário inválido.');
  }
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const work = (input.workHours ?? []).map((w) => {
    if (!hhmm.test(w.open) || !hhmm.test(w.close) || !(w.day >= 0 && w.day <= 6)) throw badRequest('error-invalid-hours', 'Horário inválido.');
    return { day: w.day, open: w.open, close: w.close, enabled: !!w.enabled };
  });
  const bhId = id ?? newId();
  if (id) {
    const r = await one('UPDATE livechat_business_hours SET name=$2, active=$3, timezone=$4, work_hours=$5, updated_at=now() WHERE id=$1 RETURNING id', [id, name, input.active ?? true, tz, JSON.stringify(work)]);
    if (!r) throw notFound('error-invalid-business-hour', 'Horário não encontrado.');
  } else {
    await query(`INSERT INTO livechat_business_hours (id, name, type, active, timezone, work_hours) VALUES ($1,$2,'custom',$3,$4,$5)`, [bhId, name, input.active ?? true, tz, JSON.stringify(work)]);
  }
  if (input.departments && bhId !== 'default') {
    await query('UPDATE livechat_departments SET business_hour_id = NULL WHERE business_hour_id = $1 AND NOT (id = ANY($2))', [bhId, input.departments]);
    await query('UPDATE livechat_departments SET business_hour_id = $1 WHERE id = ANY($2)', [bhId, input.departments]);
  }
  return (await listBusinessHours()).find((b) => b._id === bhId);
}

export async function removeBusinessHour(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-business-hours');
  if (id === 'default') throw badRequest('error-not-allowed', 'O horário padrão não pode ser removido.');
  await query('DELETE FROM livechat_business_hours WHERE id = $1', [id]);
}

// ---------- Campos personalizados e gatilhos ----------

export async function listCustomFields(publicOnly = false) {
  const rows = await many(`SELECT * FROM livechat_custom_fields ${publicOnly ? `WHERE public AND visibility = 'visible'` : ''} ORDER BY label`);
  return rows.map((f) => ({ _id: f.id, label: f.label, scope: f.scope, visibility: f.visibility, regexp: f.regexp ?? '', required: f.required, defaultValue: f.default_value ?? '', options: f.options, public: f.public }));
}

export async function saveCustomField(ctx: Ctx, input: { field: string; label: string; scope: 'visitor' | 'room'; visibility?: string; regexp?: string; required?: boolean; defaultValue?: string; options?: string[]; public?: boolean }) {
  await need(ctx, 'manage-livechat-custom-fields');
  const id = clean(input.field, 60).replace(/[^A-Za-z0-9_-]/g, '');
  if (!id || !clean(input.label)) throw badRequest('error-invalid-params', 'Informe identificador e rótulo.');
  if (input.regexp) {
    try {
      new RegExp(input.regexp);
    } catch {
      throw badRequest('error-invalid-regexp', 'Expressão regular inválida.');
    }
  }
  await query(
    `INSERT INTO livechat_custom_fields (id, label, scope, visibility, regexp, required, default_value, options, public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, scope=EXCLUDED.scope, visibility=EXCLUDED.visibility, regexp=EXCLUDED.regexp, required=EXCLUDED.required,
       default_value=EXCLUDED.default_value, options=EXCLUDED.options, public=EXCLUDED.public`,
    [id, clean(input.label), input.scope === 'room' ? 'room' : 'visitor', input.visibility === 'hidden' ? 'hidden' : 'visible', input.regexp || null, !!input.required, input.defaultValue || null, (input.options ?? []).map((o) => clean(o, 100)).filter(Boolean), input.public ?? true],
  );
  return (await listCustomFields()).find((f) => f._id === id);
}

export async function removeCustomField(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-custom-fields');
  await query('DELETE FROM livechat_custom_fields WHERE id = $1', [id]);
}

export async function listTriggers(enabledOnly = false) {
  const rows = await many(`SELECT * FROM livechat_triggers ${enabledOnly ? 'WHERE enabled' : ''} ORDER BY name`);
  return rows.map((t) => ({ _id: t.id, name: t.name, description: t.description, enabled: t.enabled, runOnce: t.run_once, conditions: t.conditions, actions: t.actions }));
}

export async function saveTrigger(ctx: Ctx, input: { _id?: string; name: string; description?: string; enabled?: boolean; runOnce?: boolean; conditions: any[]; actions: any[] }) {
  await need(ctx, 'manage-livechat-triggers');
  const name = clean(input.name, 100);
  if (!name) throw badRequest('error-invalid-name', 'Informe o nome.');
  const conditions = (input.conditions ?? [])
    .filter((c) => ['time-on-site', 'page-url', 'chat-opened-by-visitor'].includes(c?.name))
    .map((c) => ({ name: c.name, value: clean(c.value, 300) }));
  const actions = (input.actions ?? [])
    .filter((a) => a?.name === 'send-message')
    .map((a) => ({ name: 'send-message', params: { sender: a.params?.sender === 'custom' ? 'custom' : 'queue', name: clean(a.params?.name, 100), msg: String(a.params?.msg ?? '').slice(0, 2000) } }));
  if (!conditions.length || !actions.length) throw badRequest('error-invalid-params', 'Defina condição e ação.');
  const id = input._id ?? newId();
  await query(
    `INSERT INTO livechat_triggers (id, name, description, enabled, run_once, conditions, actions) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, enabled=EXCLUDED.enabled, run_once=EXCLUDED.run_once, conditions=EXCLUDED.conditions, actions=EXCLUDED.actions`,
    [id, name, clean(input.description, 500), input.enabled ?? true, !!input.runOnce, JSON.stringify(conditions), JSON.stringify(actions)],
  );
  return (await listTriggers()).find((t) => t._id === id);
}

export async function removeTrigger(ctx: Ctx, id: string) {
  await need(ctx, 'manage-livechat-triggers');
  await query('DELETE FROM livechat_triggers WHERE id = $1', [id]);
}

// ---------- Salas (conversas atuais e histórico) ----------

export async function listRooms(
  ctx: Ctx,
  opts: { agents?: string[]; departmentId?: string; status?: string; tags?: string[]; text?: string; from?: string; to?: string; visitorId?: string; offset: number; count: number },
) {
  const viewAll = await hasPermission(ctx.userId, 'view-livechat-rooms');
  const params: unknown[] = [];
  const where: string[] = [];
  if (!viewAll) {
    if (!(await hasPermission(ctx.userId, 'view-l-room'))) throw forbidden();
    where.push(`lr.agent_id = $${params.push(ctx.userId)}`);
  } else {
    const scope = await departmentScope(ctx.userId);
    if (scope) where.push(`lr.department_id = ANY($${params.push(scope)})`);
  }
  if (opts.agents?.length) where.push(`lr.agent_id = ANY($${params.push(opts.agents)})`);
  if (opts.departmentId) where.push(`lr.department_id = $${params.push(opts.departmentId)}`);
  if (opts.status) where.push(`lr.status = ANY($${params.push(opts.status.split(','))})`);
  if (opts.tags?.length) where.push(`lr.tags && $${params.push(opts.tags)}`);
  if (opts.visitorId) where.push(`lr.visitor_id = $${params.push(opts.visitorId)}`);
  if (opts.text) where.push(`(v.name ILIKE $${params.push(`%${opts.text}%`)} OR v.username ILIKE $${params.length} OR v.email ILIKE $${params.length} OR r.topic ILIKE $${params.length})`);
  if (opts.from) where.push(`lr.created_at >= $${params.push(opts.from)}`);
  if (opts.to) where.push(`lr.created_at <= $${params.push(opts.to)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM livechat_rooms lr JOIN rooms r ON r.id = lr.room_id JOIN livechat_visitors v ON v.id = lr.visitor_id`;
  const ids = await many(`SELECT lr.room_id ${base} ${w} ORDER BY lr.created_at DESC OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`, params);
  const total = await one(`SELECT count(*)::int AS n ${base} ${w}`, params.slice(0, params.length - 2));
  const rooms = [];
  for (const r of ids) rooms.push(await getLivechatRoom(r.room_id));
  return { rooms, offset: opts.offset, count: rooms.length, total: total.n };
}

export async function queueForUser(ctx: Ctx) {
  if (!(await hasPermission(ctx.userId, 'view-livechat-queue'))) throw forbidden();
  const manager = await hasPermission(ctx.userId, 'view-livechat-manager');
  const rows = await many(
    `SELECT lr.*, r.fname, r.msgs, v.username AS v_username, v.name AS v_name, p.name AS p_name, p.sort_item AS p_sort, d.name AS d_name,
       (SELECT msg FROM messages m WHERE m.room_id = lr.room_id AND m.t IS NULL ORDER BY m.created_at LIMIT 1) AS first_msg
     FROM livechat_rooms lr JOIN rooms r ON r.id = lr.room_id JOIN livechat_visitors v ON v.id = lr.visitor_id
     LEFT JOIN livechat_priorities p ON p.id = lr.priority_id LEFT JOIN livechat_departments d ON d.id = lr.department_id
     WHERE lr.status = 'queued' AND r.msgs > 0
       AND ($2 OR lr.department_id IS NULL OR lr.department_id IN (SELECT department_id FROM livechat_department_agents WHERE user_id = $1))
     ORDER BY p.sort_item NULLS LAST, lr.sla_due NULLS LAST, lr.queued_at`,
    [ctx.userId, manager],
  );
  return rows.map((r, i) => ({
    _id: r.room_id,
    rid: r.room_id,
    name: r.fname,
    v: { _id: r.visitor_id, username: r.v_username, name: r.v_name },
    departmentId: r.department_id,
    departmentName: r.d_name,
    priority: r.priority_id ? { _id: r.priority_id, name: r.p_name, sortItem: r.p_sort } : null,
    slaDue: r.sla_due,
    queuedAt: r.queued_at,
    message: r.first_msg ?? '',
    position: i + 1,
  }));
}

// ---------- Contatos ----------

export async function listContacts(ctx: Ctx, opts: { text?: string; offset: number; count: number }) {
  await need(ctx, 'view-livechat-contacts');
  const params: unknown[] = [];
  let w = '';
  if (opts.text) w = `WHERE v.name ILIKE $${params.push(`%${opts.text}%`)} OR v.email ILIKE $1 OR v.phone ILIKE $1 OR v.username ILIKE $1`;
  const rows = await many(
    `SELECT v.*, (SELECT count(*) FROM livechat_rooms lr WHERE lr.visitor_id = v.id)::int AS chats FROM livechat_visitors v ${w}
     ORDER BY v.updated_at DESC OFFSET $${params.push(opts.offset)} LIMIT $${params.push(opts.count)}`,
    params,
  );
  const total = await one(`SELECT count(*)::int AS n FROM livechat_visitors v ${w}`, params.slice(0, params.length - 2));
  return {
    visitors: rows.map((v) => {
      const m: any = mapVisitor(v);
      delete m.token;
      return { ...m, chats: v.chats };
    }),
    offset: opts.offset,
    count: rows.length,
    total: total.n,
  };
}

export async function contactInfo(ctx: Ctx, id: string) {
  await need(ctx, 'view-livechat-contacts');
  const v = await one('SELECT * FROM livechat_visitors WHERE id = $1', [id]);
  if (!v) throw notFound('error-invalid-visitor', 'Contato não encontrado.');
  const m: any = mapVisitor(v);
  delete m.token;
  return m;
}

export async function updateContact(ctx: Ctx, id: string, data: { name?: string; email?: string; phone?: string; customFields?: Record<string, unknown> }) {
  await need(ctx, 'edit-livechat-contact');
  if (data.email && !/^[^\s@]+@[^\s@]+$/.test(data.email)) throw badRequest('error-invalid-email', 'E-mail inválido.');
  const r = await one(
    `UPDATE livechat_visitors SET name = coalesce(NULLIF($2, ''), name), email = CASE WHEN $3::text IS NULL THEN email ELSE NULLIF($3, '') END,
       phone = CASE WHEN $4::text IS NULL THEN phone ELSE NULLIF($4, '') END, custom_fields = custom_fields || $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, clean(data.name, 120), data.email ?? null, data.phone ?? null, JSON.stringify(data.customFields ?? {})],
  );
  if (!r) throw notFound('error-invalid-visitor', 'Contato não encontrado.');
  await audit(actorOf(ctx), 'livechat.contact.updated', { visitorId: id });
  return contactInfo(ctx, id);
}

// Remove o contato e todo o histórico (pedido de exclusão de dados).
export async function removeContact(ctx: Ctx, id: string) {
  await need(ctx, 'remove-livechat-contact');
  const open = await one(`SELECT 1 FROM livechat_rooms WHERE visitor_id = $1 AND status <> 'closed'`, [id]);
  if (open) throw badRequest('error-contact-has-open-rooms', 'Encerre as conversas abertas antes de remover o contato.');
  const stored = await tx(async (c) => {
    const files = await c.query('SELECT storage_path FROM files WHERE room_id IN (SELECT room_id FROM livechat_rooms WHERE visitor_id = $1)', [id]);
    await c.query('DELETE FROM rooms WHERE id IN (SELECT room_id FROM livechat_rooms WHERE visitor_id = $1)', [id]);
    await c.query('DELETE FROM livechat_visitors WHERE id = $1', [id]);
    return files.rows;
  });
  // Os registros saem em cascata com as salas; os arquivos no disco, aqui.
  await removeFiles(stored);
  await audit(actorOf(ctx), 'livechat.contact.removed', { visitorId: id });
}

export async function listOfflineMessages(ctx: Ctx, offset: number, count: number) {
  await need(ctx, 'view-livechat-offline-messages');
  const rows = await many(
    `SELECT o.*, d.name AS department_name FROM livechat_offline_messages o LEFT JOIN livechat_departments d ON d.id = o.department_id ORDER BY o.created_at DESC OFFSET $1 LIMIT $2`,
    [offset, count],
  );
  const total = await one('SELECT count(*)::int AS n FROM livechat_offline_messages');
  return { messages: rows.map((o) => ({ _id: o.id, name: o.name, email: o.email, message: o.message, departmentName: o.department_name, host: o.host, ts: o.created_at })), total: total.n };
}

// ---------- Relatórios ----------

export async function analyticsOverview(ctx: Ctx, opts: { start: string; end: string; departmentId?: string }) {
  await need(ctx, 'view-livechat-analytics');
  const scope = await departmentScope(ctx.userId);
  const params: unknown[] = [opts.start, opts.end];
  let dept = '';
  if (opts.departmentId) dept += ` AND lr.department_id = $${params.push(opts.departmentId)}`;
  if (scope) dept += ` AND lr.department_id = ANY($${params.push(scope)})`;
  const range = `lr.created_at >= $1::date AND lr.created_at < $2::date + 1 ${dept}`;
  const totals = await one(
    `SELECT count(*)::int AS conversations,
       count(*) FILTER (WHERE status = 'closed')::int AS closed,
       count(*) FILTER (WHERE status = 'open')::int AS open,
       count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status = 'onhold')::int AS onhold,
       coalesce(avg(extract(epoch FROM first_response_at - served_at)) FILTER (WHERE first_response_at IS NOT NULL AND served_at IS NOT NULL), 0)::int AS avg_first_response,
       coalesce(avg(extract(epoch FROM served_at - queued_at)) FILTER (WHERE served_at IS NOT NULL), 0)::int AS avg_wait,
       coalesce(avg(extract(epoch FROM closed_at - coalesce(served_at, queued_at))) FILTER (WHERE closed_at IS NOT NULL), 0)::int AS avg_duration,
       count(*) FILTER (WHERE sla_due IS NOT NULL AND coalesce(served_at, now()) > sla_due)::int AS sla_breached,
       coalesce(avg((survey->>'satisfaction')::numeric) FILTER (WHERE survey ? 'satisfaction' AND survey->>'satisfaction' ~ '^[1-5]$'), 0)::float AS satisfaction
     FROM livechat_rooms lr WHERE ${range}`,
    params,
  );
  const byDay = await many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, (SELECT count(*) FROM livechat_rooms lr WHERE lr.created_at::date = d::date ${dept})::int AS conversations
     FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`,
    params,
  );
  const byHour = await many(`SELECT extract(hour FROM lr.created_at)::int AS hour, count(*)::int AS conversations FROM livechat_rooms lr WHERE ${range} GROUP BY 1 ORDER BY 1`, params);
  const byAgent = await many(
    `SELECT u.id, u.username, u.name, count(*)::int AS conversations,
       coalesce(avg(extract(epoch FROM lr.closed_at - lr.served_at)) FILTER (WHERE lr.closed_at IS NOT NULL), 0)::int AS avg_duration,
       coalesce(avg(extract(epoch FROM lr.first_response_at - lr.served_at)) FILTER (WHERE lr.first_response_at IS NOT NULL), 0)::int AS avg_first_response
     FROM livechat_rooms lr JOIN users u ON u.id = lr.agent_id WHERE ${range} GROUP BY u.id ORDER BY 4 DESC LIMIT 50`,
    params,
  );
  const byDepartment = await many(
    `SELECT coalesce(d.name, 'Sem departamento') AS name, count(*)::int AS conversations FROM livechat_rooms lr LEFT JOIN livechat_departments d ON d.id = lr.department_id
     WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`,
    params,
  );
  const byTag = await many(`SELECT t AS name, count(*)::int AS conversations FROM livechat_rooms lr, unnest(lr.tags) t WHERE ${range} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, params);
  return { totals, byDay, byHour, byAgent, byDepartment, byTag };
}

export async function realtimeMonitoring(ctx: Ctx) {
  await need(ctx, 'view-livechat-analytics');
  const agents = await one(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE u.status <> 'offline')::int AS online,
       count(*) FILTER (WHERE u.status <> 'offline' AND la.status = 'available')::int AS available,
       count(*) FILTER (WHERE u.status = 'away')::int AS away
     FROM users u LEFT JOIN livechat_agents la ON la.user_id = u.id WHERE u.active AND 'livechat-agent' = ANY(u.roles)`,
  );
  const chats = await one(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status = 'onhold')::int AS onhold,
       coalesce(max(extract(epoch FROM now() - queued_at)) FILTER (WHERE status = 'queued'), 0)::int AS longest_wait
     FROM livechat_rooms`,
  );
  return { agents, chats };
}


// Agentes, gestores e monitores são papéis: a troca fica no histórico de Papéis e permissões (origem Atendimento).
async function setLivechatRole(ctx: Ctx, user: { id: string; username: string }, role: string, add: boolean) {
  await tx(async (c) => {
    const before = (await c.query('SELECT roles FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]?.roles ?? [];
    const after = add ? [...before.filter((r: string) => r !== role), role] : before.filter((r: string) => r !== role);
    await c.query('UPDATE users SET roles = $2, updated_at = now() WHERE id = $1', [user.id, after]);
    await recordHistory(c, { entityType: 'user', entityId: user.id, entityLabel: user.username, action: 'update', source: 'omnichannel', actor: { id: ctx.userId, username: ctx.username }, changes: [{ field: 'roles', before, after }] });
  });
}
