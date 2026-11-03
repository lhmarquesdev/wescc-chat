// Arquivos: pastas, arquivos, compartilhamento, lixeira e histórico. As regras de acesso ficam em access.ts.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  FOLDER_COLORS,
  cleanDriveName,
  nextFreeName,
  type DriveAclEntry,
  type DriveActivity,
  type DriveFile,
  type DriveFolder,
  type DriveFolderView,
  type DriveStorage,
  type DriveSubject,
  type DriveSubjectType,
  type DriveUserRef,
} from '@shared/drive';
import { config } from '../config';
import { many, one, query, tx } from '../db/pool';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { audit } from '../services/audit';
import { hasAnyPermission, roleExists } from '../services/permissions';
import { canAccessRoom, getRoom } from '../services/rooms';
import { getSetting } from '../services/settings';
import { deleteStored, newStoredRel, safeMimeType, storedPath, typeAllowed } from '../services/uploads';
import type { Ctx } from '../services/users';
import { DRIVE_TEXT, loadAccess, needFolder, type Access, type FolderRow } from './access';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const driveOn = () => getSetting<boolean>('Drive_Enabled') !== false;
export function assertDriveOn() {
  if (!driveOn()) throw forbidden('A aba Arquivos está desligada.');
}

export const maxFileSize = () => Math.max(1, Number(getSetting('Drive_MaxFileSize_MB') ?? 200)) * MB;
export const quotaBytes = () => Math.max(0, Number(getSetting('Drive_Quota_GB') ?? 20)) * GB;
const minFreeBytes = () => Math.max(0, Number(getSetting('Drive_MinFreeDisk_MB') ?? 2048)) * MB;

// ---------- Formatos ----------

const userCache = async (ids: (string | null)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = list.length ? await many<{ id: string; username: string; name: string }>('SELECT id, username, name FROM users WHERE id = ANY($1)', [list]) : [];
  const map = new Map(rows.map((r) => [r.id, { _id: r.id, username: r.username, name: r.name || undefined } as DriveUserRef]));
  return (id: string | null) => (id ? (map.get(id) ?? null) : null);
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function driveFileUrl(id: string, name: string) {
  return `/file-upload/drive/${id}/${encodeURIComponent(name)}`;
}

function folderOut(acc: Access, f: FolderRow, users: (id: string | null) => DriveUserRef | null, extra: Partial<DriveFolder> = {}): DriveFolder {
  return {
    _id: f.id,
    parentId: f.parent_id,
    name: f.name,
    color: f.color,
    inherit: f.inherit,
    level: acc.level(f.id),
    createdBy: users(f.created_by),
    createdAt: iso(f.created_at)!,
    updatedAt: iso(f.updated_at)!,
    trashedAt: iso(f.trashed_at),
    trashedBy: users(f.trashed_by),
    ...extra,
  };
}

function fileOut(r: any, users: (id: string | null) => DriveUserRef | null, extra: Partial<DriveFile> = {}): DriveFile {
  return {
    _id: r.id,
    folderId: r.folder_id,
    name: r.name,
    type: r.type,
    size: Number(r.size),
    url: driveFileUrl(r.id, r.name),
    uploadedBy: users(r.uploaded_by),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    trashedAt: iso(r.trashed_at),
    trashedBy: users(r.trashed_by),
    ...extra,
  };
}

// Contagem de itens, tamanho e "compartilhada" de uma lista de pastas.
async function folderStats(acc: Access, ids: string[]) {
  if (!ids.length) return new Map<string, { items: number; size: number; shared: boolean }>();
  const files = await many<{ folder_id: string; n: number; size: string }>(
    'SELECT folder_id, count(*)::int AS n, coalesce(sum(size), 0) AS size FROM drive_files WHERE folder_id = ANY($1) AND trashed_at IS NULL GROUP BY folder_id',
    [ids],
  );
  const acl = await many<{ folder_id: string; n: number; others: number }>(
    `SELECT a.folder_id, count(*)::int AS n,
            count(*) FILTER (WHERE NOT (a.subject_type = 'user' AND a.subject_id = f.created_by))::int AS others
     FROM drive_acl a JOIN drive_folders f ON f.id = a.folder_id WHERE a.folder_id = ANY($1) GROUP BY a.folder_id`,
    [ids],
  );
  const fm = new Map(files.map((r) => [r.folder_id, r]));
  const am = new Map(acl.map((r) => [r.folder_id, r]));
  return new Map(
    ids.map((id) => {
      const f = fm.get(id);
      return [id, { items: (f?.n ?? 0) + acc.children(id).length, size: Number(f?.size ?? 0), shared: (am.get(id)?.others ?? 0) > 0 }];
    }),
  );
}

async function foldersOut(acc: Access, rows: FolderRow[]) {
  const users = await userCache(rows.flatMap((r) => [r.created_by, r.trashed_by]));
  const stats = await folderStats(acc, rows.map((r) => r.id));
  return rows.map((r) => folderOut(acc, r, users, stats.get(r.id)));
}

// ---------- Histórico e tempo real ----------

async function logActivity(ctx: Ctx, folderId: string | null, fileId: string | null, action: string, data: Record<string, unknown> = {}) {
  await query('INSERT INTO drive_activity (id, folder_id, file_id, actor_id, actor_username, action, data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    newId(),
    folderId,
    fileId,
    ctx.userId,
    ctx.username,
    action,
    JSON.stringify(data),
  ]).catch(() => {});
}

// Só os ids: cada aba aberta pede a pasta de novo e o servidor confere o acesso.
function changed(...folderIds: (string | null | undefined)[]) {
  const ids = [...new Set(folderIds.filter((x): x is string => !!x))];
  bus.publish({ all: true }, { type: 'drive.changed', folderIds: ids });
}

// ---------- Leitura ----------

export async function driveHome(ctx: Ctx) {
  const acc = await loadAccess(ctx);
  const folders = await foldersOut(acc, acc.entries());
  return {
    folders,
    canCreateRoot: acc.all || (await hasAnyPermission(ctx.userId, ['create-files-folder'])),
    manageAll: acc.all,
    storage: await storage(),
  };
}

export async function folderView(ctx: Ctx, folderId: unknown): Promise<DriveFolderView> {
  const acc = await loadAccess(ctx);
  const f = needFolder(acc, folderId, 1);
  const subs = acc.children(f.id);
  const fileRows = await many('SELECT * FROM drive_files WHERE folder_id = $1 AND trashed_at IS NULL ORDER BY lower(name)', [f.id]);
  const users = await userCache([f.created_by, ...fileRows.map((r) => r.uploaded_by)]);
  const stats = await folderStats(acc, [f.id]);
  const view: DriveFolderView = {
    folder: folderOut(acc, f, users, stats.get(f.id)),
    path: acc.path(f.id),
    folders: await foldersOut(acc, subs),
    files: fileRows.map((r) => fileOut(r, users)),
  };
  if (acc.level(f.id) >= 3) view.acl = await aclView(acc, f);
  return view;
}

// Compartilhamento visto por quem gerencia: o da pasta e, se ela herda, o das pastas de cima (só leitura aqui).
async function aclView(acc: Access, f: FolderRow): Promise<DriveAclEntry[]> {
  const chain: FolderRow[] = [f];
  let cur = f;
  while (cur.inherit && cur.parent_id && acc.folders.get(cur.parent_id)) {
    cur = acc.folders.get(cur.parent_id)!;
    chain.push(cur);
  }
  const rows = await many<{ folder_id: string; subject_type: DriveSubjectType; subject_id: string; level: 1 | 2 | 3 }>(
    'SELECT folder_id, subject_type, subject_id, level FROM drive_acl WHERE folder_id = ANY($1)',
    [chain.map((c) => c.id)],
  );
  const labels = await subjectLabels(rows.map((r) => ({ type: r.subject_type, id: r.subject_id })));
  const order = new Map(chain.map((c, i) => [c.id, i]));
  return rows
    .sort((a, b) => order.get(a.folder_id)! - order.get(b.folder_id)! || b.level - a.level)
    .map((r) => {
      const l = labels.get(`${r.subject_type}:${r.subject_id}`);
      const from = r.folder_id === f.id ? null : { _id: r.folder_id, name: acc.folders.get(r.folder_id)!.name };
      return { type: r.subject_type, id: r.subject_id, level: r.level, label: l?.label ?? r.subject_id, sublabel: l?.sublabel, from, missing: !l };
    });
}

const ROOM_KIND: Record<string, string> = { c: 'Canal', p: 'Grupo privado' };

async function subjectLabels(list: { type: DriveSubjectType; id: string }[]) {
  const out = new Map<string, { label: string; sublabel?: string }>();
  const ids = (t: DriveSubjectType) => [...new Set(list.filter((x) => x.type === t).map((x) => x.id))];
  const users = ids('user');
  if (users.length)
    for (const u of await many('SELECT id, username, name FROM users WHERE id = ANY($1)', [users])) out.set(`user:${u.id}`, { label: u.name || u.username, sublabel: `@${u.username}` });
  const rooms = ids('room');
  if (rooms.length)
    for (const r of await many("SELECT id, t, name, fname FROM rooms WHERE id = ANY($1) AND t IN ('c','p')", [rooms]))
      out.set(`room:${r.id}`, { label: `#${r.fname || r.name}`, sublabel: `Membros do ${ROOM_KIND[r.t] === 'Canal' ? 'canal' : 'grupo privado'}` });
  const roles = ids('role');
  if (roles.length)
    for (const r of await many("SELECT id, description FROM roles WHERE id = ANY($1) AND scope = 'Users'", [roles])) out.set(`role:${r.id}`, { label: r.description || r.id, sublabel: 'Papel' });
  return out;
}

export async function storage(): Promise<DriveStorage> {
  const r = await one<{ used: string; trash: string }>(
    `SELECT coalesce(sum(size), 0) AS used, coalesce(sum(size) FILTER (WHERE trashed_at IS NOT NULL), 0) AS trash FROM drive_files`,
  );
  let diskFree: number | null = null;
  try {
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    const s = await fs.promises.statfs(config.uploadDir);
    diskFree = Number(s.bavail) * Number(s.bsize);
  } catch {
    // sem statfs (sistema de arquivos remoto ou plataforma sem suporte)
  }
  return { used: Number(r?.used ?? 0), trash: Number(r?.trash ?? 0), quota: quotaBytes(), diskFree, maxFileSize: maxFileSize() };
}

// Busca por nome em todas as pastas que a pessoa vê.
export async function search(ctx: Ctx, text: unknown) {
  const t = String(text ?? '').trim().slice(0, 100);
  if (t.length < 2) return { folders: [], files: [] };
  const acc = await loadAccess(ctx);
  const visible = [...acc.folders.keys()].filter((id) => acc.level(id) > 0 && !acc.trashed(id));
  if (!visible.length) return { folders: [], files: [] };
  const like = `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const fileRows = await many('SELECT * FROM drive_files WHERE folder_id = ANY($1) AND trashed_at IS NULL AND name ILIKE $2 ORDER BY updated_at DESC LIMIT 50', [visible, like]);
  const folderRows = visible.map((id) => acc.folders.get(id)!).filter((f) => f.name.toLowerCase().includes(t.toLowerCase())).slice(0, 20);
  const users = await userCache(fileRows.map((r) => r.uploaded_by));
  return {
    folders: (await foldersOut(acc, folderRows)).map((f) => ({ ...f, path: acc.path(f._id).slice(0, -1) })),
    files: fileRows.map((r) => fileOut(r, users, { path: acc.path(r.folder_id), level: acc.level(r.folder_id) })),
  };
}

export async function recent(ctx: Ctx) {
  const acc = await loadAccess(ctx);
  const visible = [...acc.folders.keys()].filter((id) => acc.level(id) > 0 && !acc.trashed(id));
  if (!visible.length) return { files: [] };
  const rows = await many('SELECT * FROM drive_files WHERE folder_id = ANY($1) AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 12', [visible]);
  const users = await userCache(rows.map((r) => r.uploaded_by));
  return { files: rows.map((r) => fileOut(r, users, { path: acc.path(r.folder_id), level: acc.level(r.folder_id) })) };
}

export async function activity(ctx: Ctx, folderId: unknown, opts: { offset?: number; count?: number }) {
  const acc = await loadAccess(ctx);
  const f = needFolder(acc, folderId, 3, { allowTrashed: true });
  const count = Math.min(opts.count ?? 50, 200);
  const rows = await many(
    `SELECT a.*, u.name AS actor_name, count(*) OVER() AS total FROM drive_activity a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.folder_id = ANY($1) ORDER BY a.created_at DESC LIMIT ${count} OFFSET ${Number(opts.offset ?? 0)}`,
    [acc.subtree(f.id)],
  );
  const events: DriveActivity[] = rows.map((r) => ({
    _id: r.id,
    action: r.action,
    actor: { _id: r.actor_id, username: r.actor_username, name: r.actor_name || undefined },
    fileId: r.file_id,
    data: { ...r.data, folder: r.folder_id !== f.id ? acc.folders.get(r.folder_id)?.name : undefined },
    ts: iso(r.created_at)!,
  }));
  return { total: Number(rows[0]?.total ?? 0), events };
}

// ---------- Pastas ----------

const folderName = (raw: unknown) => {
  const n = cleanDriveName(raw, 120);
  if (!n) throw badRequest('error-invalid-name', 'Dê um nome à pasta.');
  return n;
};

const uniqueViolation = (e: any) => e?.code === '23505';

async function takenFolderNames(parentId: string | null, exceptId?: string) {
  const rows = await many<{ name: string }>('SELECT name FROM drive_folders WHERE parent_id IS NOT DISTINCT FROM $1 AND trashed_at IS NULL AND id IS DISTINCT FROM $2', [parentId, exceptId ?? null]);
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

function checkColor(c: unknown) {
  if (c === undefined) return undefined;
  if (c === null || c === '') return null;
  if (!FOLDER_COLORS.includes(c as any)) throw badRequest('error-invalid-params', 'Cor inválida.');
  return c as string;
}

export async function createFolder(ctx: Ctx, input: { parentId?: unknown; name?: unknown; color?: unknown }) {
  assertDriveOn();
  const acc = await loadAccess(ctx);
  const name = folderName(input.name);
  const color = checkColor(input.color) ?? null;
  const parentId = input.parentId ? String(input.parentId) : null;
  if (parentId) needFolder(acc, parentId, 2);
  else if (!acc.all && !(await hasAnyPermission(ctx.userId, ['create-files-folder']))) throw forbidden('Você não pode criar pastas principais. Crie dentro de uma pasta que você edita.');
  const taken = await takenFolderNames(parentId);
  if (taken.has(name.toLowerCase())) throw badRequest('error-name-taken', 'Já existe uma pasta com esse nome aqui.');
  const id = newId();
  try {
    await tx(async (c) => {
      await c.query('INSERT INTO drive_folders (id, parent_id, name, color, created_by) VALUES ($1,$2,$3,$4,$5)', [id, parentId, name, color, ctx.userId]);
      // Pasta principal: quem cria gerencia (subpasta herda da de cima).
      if (!parentId) await c.query("INSERT INTO drive_acl (folder_id, subject_type, subject_id, level, granted_by) VALUES ($1,'user',$2,3,$2)", [id, ctx.userId]);
    });
  } catch (e) {
    if (uniqueViolation(e)) throw badRequest('error-name-taken', 'Já existe uma pasta com esse nome aqui.');
    throw e;
  }
  await logActivity(ctx, id, null, 'folder.create', { name });
  if (parentId) await logActivity(ctx, parentId, null, 'folder.add', { name });
  changed(parentId, id);
  const fresh = await loadAccess(ctx);
  return (await foldersOut(fresh, [fresh.folders.get(id)!]))[0];
}

export async function updateFolder(ctx: Ctx, folderId: unknown, input: { name?: unknown; color?: unknown }) {
  const acc = await loadAccess(ctx);
  const f = needFolder(acc, folderId, 2);
  const color = checkColor(input.color);
  const name = input.name !== undefined ? folderName(input.name) : f.name;
  // Renomear a pasta principal mexe no que todos veem: pede gerenciar. Subpasta: editar a de cima basta.
  if (name !== f.name && acc.level(f.id) < 3 && !(f.parent_id && acc.level(f.parent_id) >= 2)) throw forbidden(DRIVE_TEXT.needManage);
  if (name.toLowerCase() !== f.name.toLowerCase() && (await takenFolderNames(f.parent_id, f.id)).has(name.toLowerCase()))
    throw badRequest('error-name-taken', 'Já existe uma pasta com esse nome aqui.');
  try {
    await query('UPDATE drive_folders SET name = $2, color = $3, updated_at = now() WHERE id = $1', [f.id, name, color === undefined ? f.color : color]);
  } catch (e) {
    if (uniqueViolation(e)) throw badRequest('error-name-taken', 'Já existe uma pasta com esse nome aqui.');
    throw e;
  }
  if (name !== f.name) await logActivity(ctx, f.id, null, 'folder.rename', { from: f.name, to: name });
  changed(f.parent_id, f.id);
  return {};
}

// Mover pastas e arquivos para outra pasta. Pasta: gerenciar a pasta e editar o destino; arquivo: editar origem e destino.
export async function moveItems(ctx: Ctx, input: { fileIds?: string[]; folderIds?: string[]; targetId?: unknown }) {
  const acc = await loadAccess(ctx);
  const targetId = input.targetId ? String(input.targetId) : null;
  const target = targetId ? needFolder(acc, targetId, 2) : null;
  const fileIds = (input.fileIds ?? []).slice(0, 500);
  const folderIds = (input.folderIds ?? []).slice(0, 100);
  if (!fileIds.length && !folderIds.length) throw badRequest('error-invalid-params', 'Escolha o que mover.');
  if (!target && (fileIds.length || (!acc.all && !(await hasAnyPermission(ctx.userId, ['create-files-folder'])))))
    throw badRequest('error-invalid-params', 'Escolha a pasta de destino.');
  const touched = new Set<string | null>([targetId]);
  for (const id of folderIds) {
    const f = needFolder(acc, id, 3);
    if (target && acc.subtree(f.id).includes(target.id)) throw badRequest('error-invalid-move', `"${f.name}" não pode ir para dentro dela mesma.`);
    if (f.parent_id === targetId) continue;
    const name = nextFreeName(f.name, await takenFolderNames(targetId, f.id));
    await query('UPDATE drive_folders SET parent_id = $2, name = $3, updated_at = now() WHERE id = $1', [f.id, targetId, name]);
    // Pasta que vira principal precisa de alguém que gerencie: quem moveu.
    if (!targetId) await query("INSERT INTO drive_acl (folder_id, subject_type, subject_id, level, granted_by) VALUES ($1,'user',$2,3,$2) ON CONFLICT DO NOTHING", [f.id, ctx.userId]);
    await logActivity(ctx, f.id, null, 'folder.move', { from: f.parent_id ? acc.folders.get(f.parent_id)?.name : null, to: target?.name ?? null });
    touched.add(f.parent_id).add(f.id);
  }
  if (fileIds.length) {
    const rows = await many('SELECT * FROM drive_files WHERE id = ANY($1) AND trashed_at IS NULL', [fileIds]);
    if (rows.length !== new Set(fileIds).size) throw notFound('error-file-not-found', DRIVE_TEXT.fileNotFound);
    for (const r of rows) needFolder(acc, r.folder_id, 2);
    const taken = await takenFileNames(target!.id);
    for (const r of rows) {
      if (r.folder_id === target!.id) continue;
      const name = nextFreeName(r.name, taken);
      taken.add(name.toLowerCase());
      await query('UPDATE drive_files SET folder_id = $2, name = $3, updated_at = now() WHERE id = $1', [r.id, target!.id, name]);
      await logActivity(ctx, r.folder_id, r.id, 'file.move.out', { name: r.name, to: target!.name });
      await logActivity(ctx, target!.id, r.id, 'file.move.in', { name, from: acc.folders.get(r.folder_id)?.name });
      touched.add(r.folder_id);
    }
  }
  changed(...touched);
  return {};
}

// ---------- Compartilhamento ----------

const LEVELS = new Set([1, 2, 3]);

export async function setAcl(ctx: Ctx, folderId: unknown, input: { inherit?: unknown; entries?: unknown }) {
  const acc = await loadAccess(ctx);
  const f = needFolder(acc, folderId, 3);
  if (!Array.isArray(input.entries)) throw badRequest('error-invalid-params', 'Lista de compartilhamento inválida.');
  if (input.entries.length > 300) throw badRequest('error-invalid-params', 'Compartilhamento grande demais (até 300 entradas).');
  const entries = new Map<string, { type: DriveSubjectType; id: string; level: number }>();
  for (const raw of input.entries as any[]) {
    const type = raw?.type;
    const id = typeof raw?.id === 'string' ? raw.id.slice(0, 64) : '';
    const level = Number(raw?.level);
    if (!['role', 'room', 'user'].includes(type) || !id || !LEVELS.has(level)) throw badRequest('error-invalid-params', 'Entrada de compartilhamento inválida.');
    entries.set(`${type}:${id}`, { type, id, level });
  }
  // Toda entrada precisa existir; canal ou grupo só se quem compartilha tiver acesso a ele.
  const prev = await many<{ subject_type: string; subject_id: string; level: number }>('SELECT subject_type, subject_id, level FROM drive_acl WHERE folder_id = $1', [f.id]);
  const prevKeys = new Set(prev.map((p) => `${p.subject_type}:${p.subject_id}`));
  for (const e of entries.values()) {
    if (prevKeys.has(`${e.type}:${e.id}`)) continue; // já estava: pode manter mesmo que tenha sumido
    if (e.type === 'user' && !(await one("SELECT 1 FROM users WHERE id = $1 AND active AND type <> 'app'", [e.id]))) throw badRequest('error-invalid-subject', 'Pessoa não encontrada.');
    if (e.type === 'role' && (!roleExists(e.id) || e.id === 'anonymous')) throw badRequest('error-invalid-subject', 'Papel não encontrado.');
    if (e.type === 'room') {
      const room = await getRoom(e.id);
      if (!room || !['c', 'p'].includes(room.t) || !(acc.all || (await canAccessRoom(ctx.userId, room)))) throw badRequest('error-invalid-subject', 'Canal ou grupo não encontrado.');
    }
  }
  const inherit = input.inherit === undefined ? f.inherit : input.inherit === true;
  await tx(async (c) => {
    await c.query('DELETE FROM drive_acl WHERE folder_id = $1', [f.id]);
    for (const e of entries.values())
      await c.query('INSERT INTO drive_acl (folder_id, subject_type, subject_id, level, granted_by) VALUES ($1,$2,$3,$4,$5)', [f.id, e.type, e.id, e.level, ctx.userId]);
    await c.query('UPDATE drive_folders SET inherit = $2, updated_at = now() WHERE id = $1', [f.id, f.parent_id ? inherit : true]);
  });
  const before = Object.fromEntries(prev.map((p) => [`${p.subject_type}:${p.subject_id}`, p.level]));
  const after = Object.fromEntries([...entries.values()].map((e) => [`${e.type}:${e.id}`, e.level]));
  const diff = {
    added: Object.keys(after).filter((k) => !(k in before)),
    removed: Object.keys(before).filter((k) => !(k in after)),
    changed: Object.keys(after).filter((k) => k in before && before[k] !== after[k]),
    inherit: f.parent_id && inherit !== f.inherit ? inherit : undefined,
  };
  await logActivity(ctx, f.id, null, 'acl.update', diff);
  await audit({ id: ctx.userId, username: ctx.username, ip: ctx.ip }, 'drive.acl.update', { folderId: f.id, name: f.name }, { before, after, inherit });
  changed(f.parent_id, f.id, ...acc.subtree(f.id));
  const fresh = await loadAccess(ctx);
  return { acl: await aclView(fresh, fresh.folders.get(f.id)!) };
}

// Para o seletor do compartilhamento: papéis, canais/grupos e pessoas.
export async function searchSubjects(ctx: Ctx, text: unknown): Promise<DriveSubject[]> {
  const t = String(text ?? '').trim().slice(0, 60);
  const like = `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const out: DriveSubject[] = [];
  const roles = await many("SELECT id, description FROM roles WHERE scope = 'Users' AND id NOT IN ('anonymous', 'app') AND (id ILIKE $1 OR description ILIKE $1) ORDER BY protected DESC, id LIMIT 12", [like]);
  out.push(...roles.map((r) => ({ type: 'role' as const, id: r.id, label: r.description || r.id, sublabel: 'Papel' })));
  const all = await hasAnyPermission(ctx.userId, ['manage-all-files']);
  const rooms = await many(
    `SELECT r.id, r.t, r.name, r.fname FROM rooms r
     WHERE r.t IN ('c','p') AND NOT r.archived AND (coalesce(r.fname, r.name) ILIKE $1)
       AND ($3 OR r.t = 'c' OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.room_id = r.id AND s.user_id = $2))
     ORDER BY lower(coalesce(r.fname, r.name)) LIMIT 12`,
    [like, ctx.userId, all],
  );
  out.push(...rooms.map((r) => ({ type: 'room' as const, id: r.id, label: `#${r.fname || r.name}`, sublabel: `Membros do ${r.t === 'c' ? 'canal' : 'grupo privado'}` })));
  if (t) {
    const users = await many("SELECT id, username, name FROM users WHERE active AND type = 'user' AND (username ILIKE $1 OR name ILIKE $1) ORDER BY lower(name), username LIMIT 12", [like]);
    out.push(...users.map((u) => ({ type: 'user' as const, id: u.id, label: u.name || u.username, sublabel: `@${u.username}` })));
  }
  return out;
}

// ---------- Arquivos ----------

async function takenFileNames(folderId: string, exceptId?: string) {
  const rows = await many<{ name: string }>('SELECT name FROM drive_files WHERE folder_id = $1 AND trashed_at IS NULL AND id IS DISTINCT FROM $2', [folderId, exceptId ?? null]);
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

function fmtSize(n: number) {
  return n >= GB ? `${(n / GB).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(n / MB))} MB`;
}

// Antes de ler o corpo: tamanho anunciado, cota e disco livre.
async function assertRoomFor(bytes: number) {
  const max = maxFileSize();
  if (bytes > max + 64 * 1024) throw new ApiError(413, 'error-file-too-large', `Arquivo maior que o permitido (${fmtSize(max)}).`);
  const s = await storage();
  if (s.quota && s.used + bytes > s.quota)
    throw new ApiError(507, 'error-quota-exceeded', `O espaço da aba Arquivos acabou (${fmtSize(s.used)} de ${fmtSize(s.quota)}). Esvazie a lixeira ou peça para aumentar a cota.`);
  if (s.diskFree !== null && s.diskFree - bytes < minFreeBytes())
    throw new ApiError(507, 'error-disk-full', 'O disco do servidor está quase cheio. Peça à TI para liberar espaço antes de enviar.');
}

export async function uploadFile(ctx: Ctx, folderId: unknown, req: any) {
  assertDriveOn();
  const acc = await loadAccess(ctx);
  const f = needFolder(acc, folderId, 2);
  const announced = Number(req.headers['content-length'] ?? 0);
  await assertRoomFor(Number.isFinite(announced) ? announced : 0);
  const max = maxFileSize();
  let stored: { id: string; rel: string; name: string; type: string; size: number } | null = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: max, files: 1, fields: 4, parts: 5, fieldSize: 1024 } })) {
      if (part.type !== 'file') continue;
      if (stored) {
        part.file.resume();
        continue;
      }
      const type = safeMimeType(part.mimetype);
      if (!typeAllowed(type)) {
        part.file.resume();
        throw badRequest('error-invalid-file-type', 'Tipo de arquivo não permitido.');
      }
      const id = newId();
      const rel = newStoredRel(id);
      const abs = storedPath(rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      stored = { id, rel, name: cleanDriveName(part.filename, 200) ?? 'arquivo', type, size: 0 };
      await pipeline(part.file, fs.createWriteStream(abs));
      if (part.file.truncated) throw new ApiError(413, 'error-file-too-large', `Arquivo maior que o permitido (${fmtSize(max)}).`);
      stored.size = (await fs.promises.stat(abs)).size;
    }
    if (!stored) throw badRequest('error-invalid-params', 'Nenhum arquivo enviado.');
    // Dois envios ao mesmo tempo podem passar da cota juntos: confere de novo com o tamanho real.
    const s = await storage();
    if (s.quota && s.used + stored.size > s.quota) throw new ApiError(507, 'error-quota-exceeded', 'O espaço da aba Arquivos acabou. Esvazie a lixeira ou peça para aumentar a cota.');
    let name = nextFreeName(stored.name, await takenFileNames(f.id));
    for (let attempt = 0; ; attempt++) {
      try {
        await query('INSERT INTO drive_files (id, folder_id, name, type, size, storage_path, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
          stored.id,
          f.id,
          name,
          stored.type,
          stored.size,
          stored.rel,
          ctx.userId,
        ]);
        break;
      } catch (e) {
        if (!uniqueViolation(e) || attempt > 3) throw e;
        name = nextFreeName(stored.name, await takenFileNames(f.id));
      }
    }
    stored.name = name;
  } catch (e: any) {
    if (stored) await deleteStored(stored.rel).catch(() => {});
    if (e?.code === 'FST_REQ_FILE_TOO_LARGE') throw new ApiError(413, 'error-file-too-large', `Arquivo maior que o permitido (${fmtSize(max)}).`);
    if (e?.code === 'FST_FILES_LIMIT' || e?.code === 'FST_PARTS_LIMIT' || e?.code === 'FST_FIELDS_LIMIT') throw new ApiError(413, 'error-too-many-parts', 'Envie um arquivo por vez.');
    throw e;
  }
  await query('UPDATE drive_folders SET updated_at = now() WHERE id = $1', [f.id]);
  await logActivity(ctx, f.id, stored.id, 'file.upload', { name: stored.name, size: stored.size });
  changed(f.id);
  const row = await one('SELECT * FROM drive_files WHERE id = $1', [stored.id]);
  return fileOut(row, await userCache([ctx.userId]));
}

async function needFile(acc: Access, fileId: unknown, min: 1 | 2 | 3, opts: { allowTrashed?: boolean } = {}) {
  const r = typeof fileId === 'string' ? await one('SELECT * FROM drive_files WHERE id = $1', [fileId]) : null;
  if (!r || acc.level(r.folder_id) === 0) throw notFound('error-file-not-found', DRIVE_TEXT.fileNotFound);
  if (!opts.allowTrashed && (r.trashed_at || acc.trashed(r.folder_id))) throw notFound('error-file-not-found', DRIVE_TEXT.fileNotFound);
  needFolder(acc, r.folder_id, min, { allowTrashed: opts.allowTrashed });
  return r;
}

export async function fileForDownload(ctx: Ctx | null, fileId: string, logDownload: boolean) {
  if (!ctx) throw forbidden();
  if (!(await hasAnyPermission(ctx.userId, ['view-files', 'manage-all-files']))) throw forbidden();
  const acc = await loadAccess(ctx);
  const r = await needFile(acc, fileId, 1);
  if (logDownload) await logActivity(ctx, r.folder_id, r.id, 'file.download', { name: r.name });
  return { ...r, absPath: storedPath(r.storage_path) };
}

export async function renameFile(ctx: Ctx, fileId: unknown, rawName: unknown) {
  const acc = await loadAccess(ctx);
  const r = await needFile(acc, fileId, 2);
  const name = cleanDriveName(rawName, 200);
  if (!name) throw badRequest('error-invalid-name', 'Dê um nome ao arquivo.');
  if (name === r.name) return {};
  if (name.toLowerCase() !== r.name.toLowerCase() && (await takenFileNames(r.folder_id, r.id)).has(name.toLowerCase()))
    throw badRequest('error-name-taken', 'Já existe um arquivo com esse nome nesta pasta.');
  try {
    await query('UPDATE drive_files SET name = $2, updated_at = now() WHERE id = $1', [r.id, name]);
  } catch (e) {
    if (uniqueViolation(e)) throw badRequest('error-name-taken', 'Já existe um arquivo com esse nome nesta pasta.');
    throw e;
  }
  await logActivity(ctx, r.folder_id, r.id, 'file.rename', { from: r.name, to: name });
  changed(r.folder_id);
  return {};
}

// ---------- Lixeira ----------

export async function trashItems(ctx: Ctx, input: { fileIds?: string[]; folderIds?: string[] }) {
  const acc = await loadAccess(ctx);
  const touched = new Set<string | null>();
  for (const id of (input.folderIds ?? []).slice(0, 100)) {
    const f = needFolder(acc, id, 3);
    await query('UPDATE drive_folders SET trashed_at = now(), trashed_by = $2 WHERE id = $1', [f.id, ctx.userId]);
    await logActivity(ctx, f.id, null, 'folder.trash', { name: f.name });
    if (f.parent_id) await logActivity(ctx, f.parent_id, null, 'folder.trash', { name: f.name });
    touched.add(f.parent_id).add(f.id);
  }
  for (const id of (input.fileIds ?? []).slice(0, 500)) {
    const r = await needFile(acc, id, 2);
    await query('UPDATE drive_files SET trashed_at = now(), trashed_by = $2 WHERE id = $1', [r.id, ctx.userId]);
    await logActivity(ctx, r.folder_id, r.id, 'file.trash', { name: r.name });
    touched.add(r.folder_id);
  }
  changed(...touched);
  return {};
}

// Itens no topo da lixeira (não os que estão dentro de uma pasta que já está lá) que a pessoa pode restaurar.
export async function listTrash(ctx: Ctx) {
  const acc = await loadAccess(ctx);
  const folders = [...acc.folders.values()].filter((f) => f.trashed_at && !(f.parent_id && acc.trashed(f.parent_id)) && acc.level(f.id) >= 3);
  const fileRows = await many('SELECT * FROM drive_files WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 500');
  const files = fileRows.filter((r) => !acc.trashed(r.folder_id) && acc.level(r.folder_id) >= 2);
  const users = await userCache([...files.flatMap((r) => [r.uploaded_by, r.trashed_by]), ...folders.flatMap((f) => [f.created_by, f.trashed_by])]);
  const stats = await folderStats(acc, folders.map((f) => f.id));
  return {
    days: Number(getSetting('Drive_Trash_Days') ?? 30),
    folders: folders.sort((a, b) => +b.trashed_at! - +a.trashed_at!).map((f) => ({ ...folderOut(acc, f, users, stats.get(f.id)), path: acc.path(f.id).slice(0, -1) })),
    files: files.map((r) => fileOut(r, users, { path: acc.path(r.folder_id), level: acc.level(r.folder_id) })),
  };
}

export async function restoreItems(ctx: Ctx, input: { fileIds?: string[]; folderIds?: string[] }) {
  const acc = await loadAccess(ctx);
  const touched = new Set<string | null>();
  for (const id of (input.folderIds ?? []).slice(0, 100)) {
    const f = needFolder(acc, id, 3, { allowTrashed: true });
    if (!f.trashed_at) continue;
    if (f.parent_id && acc.trashed(f.parent_id)) throw badRequest('error-parent-trashed', `A pasta de cima de "${f.name}" também está na lixeira. Restaure-a primeiro.`);
    const name = nextFreeName(f.name, await takenFolderNames(f.parent_id, f.id));
    await query('UPDATE drive_folders SET trashed_at = NULL, trashed_by = NULL, name = $2, updated_at = now() WHERE id = $1', [f.id, name]);
    await logActivity(ctx, f.id, null, 'folder.restore', { name });
    touched.add(f.parent_id).add(f.id);
  }
  for (const id of (input.fileIds ?? []).slice(0, 500)) {
    const r = await needFile(acc, id, 2, { allowTrashed: true });
    if (!r.trashed_at) continue;
    if (acc.trashed(r.folder_id)) throw badRequest('error-parent-trashed', `A pasta de "${r.name}" está na lixeira. Restaure a pasta.`);
    const name = nextFreeName(r.name, await takenFileNames(r.folder_id, r.id));
    await query('UPDATE drive_files SET trashed_at = NULL, trashed_by = NULL, name = $2, updated_at = now() WHERE id = $1', [r.id, name]);
    await logActivity(ctx, r.folder_id, r.id, 'file.restore', { name });
    touched.add(r.folder_id);
  }
  changed(...touched);
  return {};
}

async function purgeFolderTree(ids: string[]) {
  const files = await many<{ storage_path: string }>('SELECT storage_path FROM drive_files WHERE folder_id = ANY($1)', [ids]);
  await query('DELETE FROM drive_folders WHERE id = ANY($1)', [ids]);
  for (const f of files) await deleteStored(f.storage_path).catch(() => {});
  return files.length;
}

// Apagar de vez: só da lixeira. Arquivo pede gerenciar a pasta; pasta pede gerenciar a própria pasta.
export async function purgeItems(ctx: Ctx, input: { fileIds?: string[]; folderIds?: string[]; all?: boolean }) {
  const acc = await loadAccess(ctx);
  let fileIds = (input.fileIds ?? []).slice(0, 500);
  let folderIds = (input.folderIds ?? []).slice(0, 100);
  if (input.all) {
    const t = await listTrash(ctx);
    folderIds = t.folders.filter((f) => f.level >= 3).map((f) => f._id);
    fileIds = t.files.filter((f) => (f.level ?? 0) >= 3).map((f) => f._id);
  }
  let removed = 0;
  for (const id of folderIds) {
    const f = needFolder(acc, id, 3, { allowTrashed: true });
    if (!f.trashed_at) throw badRequest('error-not-in-trash', 'Mande para a lixeira antes de apagar de vez.');
    removed += await purgeFolderTree(acc.subtree(f.id));
    if (f.parent_id) await logActivity(ctx, f.parent_id, null, 'folder.purge', { name: f.name });
    await audit({ id: ctx.userId, username: ctx.username, ip: ctx.ip }, 'drive.folder.purge', { folderId: f.id, name: f.name });
  }
  for (const id of fileIds) {
    const r = await needFile(acc, id, 3, { allowTrashed: true });
    if (!r.trashed_at) throw badRequest('error-not-in-trash', 'Mande para a lixeira antes de apagar de vez.');
    await query('DELETE FROM drive_files WHERE id = $1', [r.id]);
    await deleteStored(r.storage_path).catch(() => {});
    await logActivity(ctx, r.folder_id, null, 'file.purge', { name: r.name });
    removed++;
  }
  return { removed };
}

// Tarefa diária: o que passou do prazo na lixeira sai de vez.
export async function purgeExpiredTrash() {
  const days = Math.max(1, Number(getSetting('Drive_Trash_Days') ?? 30));
  const folders = await many<{ id: string }>(`SELECT id FROM drive_folders WHERE trashed_at < now() - make_interval(days => $1)`, [days]);
  for (const f of folders) {
    const tree = await many<{ id: string }>(
      'WITH RECURSIVE t AS (SELECT id FROM drive_folders WHERE id = $1 UNION ALL SELECT d.id FROM drive_folders d JOIN t ON d.parent_id = t.id) SELECT id FROM t',
      [f.id],
    );
    await purgeFolderTree(tree.map((x) => x.id));
  }
  const files = await many<{ id: string; storage_path: string }>(`DELETE FROM drive_files WHERE trashed_at < now() - make_interval(days => $1) RETURNING id, storage_path`, [days]);
  for (const f of files) await deleteStored(f.storage_path).catch(() => {});
  return { folders: folders.length, files: files.length };
}
