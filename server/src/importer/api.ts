import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { b, paging, q, route, str } from '../api/http';
import { many } from '../db/pool';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { hashPassword } from '../lib/password';
import { hasPermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import { actorOf, validatePassword } from '../services/users';
import {
  addApiUsers,
  cancelOperation,
  checkApiOperation,
  clearOperations,
  coarseState,
  currentOperation,
  importFileData,
  latestOperations,
  listErrors,
  newOperation,
  operationNotFound,
  pathOperation,
  presentOperation,
  startImport,
  startPending,
  uploadOperation,
  urlOperation,
  validOperation,
} from './operations';
import { countPendingAvatars, countPendingFiles } from './pending';
import { importers } from './registry';
import type { ImportUser } from './types';

const RUN = ['run-import'];
const VIEW = ['view-import-operations', 'run-import'];
const DATA_TYPES = ['user', 'channel', 'message', 'contact'];

const selectionPart = z.object({ all: z.boolean().optional(), list: z.array(z.string()).optional() }).optional();
const startBody = z.object({
  input: z.object({ users: selectionPart, channels: selectionPart, contacts: selectionPart }),
  options: z.object({ sendPasswordEmails: z.boolean().optional(), skipExistingUsers: z.boolean().optional() }).optional(),
});

const text = (max: number) => z.string().max(max).nullish();
const apiUser = z.strictObject({
  importIds: z.array(z.string().trim().min(1).max(500)).min(1),
  emails: z.array(z.string().trim().min(1).max(254)).min(1),
  username: text(100),
  name: text(200),
  deleted: z.boolean().nullish(),
  statusText: text(200),
  bio: text(2000),
  roles: z.array(z.string().min(1).max(100)).nullish(),
  password: z.string().max(200).nullish(),
  type: z.enum(['user', 'bot']).nullish(),
});
const addUsersBody = z.strictObject({ users: z.array(apiUser).max(10_000) });

function invalid(err: z.ZodError, what: string) {
  const issue = err.issues[0];
  const where = issue?.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '') || 'corpo';
  if (issue?.code === 'unrecognized_keys') return badRequest('error-invalid-params', `Campo não permitido em ${where}: ${issue.keys.join(', ')}.`);
  return badRequest('error-invalid-params', `${what} inválidos em ${where}.`);
}

type ApiUser = z.infer<typeof apiUser>;

// A senha nunca é guardada em texto: vai para os dados lidos já como hash, no mesmo formato das contas normais.
async function toImportUser(u: ApiUser): Promise<ImportUser> {
  const out: ImportUser = { importIds: u.importIds, emails: u.emails };
  if (u.username?.trim()) out.username = u.username.trim();
  if (u.name?.trim()) out.name = u.name.trim();
  if (u.deleted != null) out.deleted = u.deleted;
  if (u.statusText) out.statusText = u.statusText;
  if (u.bio) out.bio = u.bio;
  if (u.roles?.length) out.roles = [...new Set(u.roles)];
  if (u.password) out.passwordHash = await hashPassword(u.password);
  if (u.type) out.type = u.type;
  return out;
}

// Mesmas regras de users.create: papel que existe e vale para a conta (não só dentro de uma sala), e admin só para
// quem tem assign-admin-role.
async function checkRoles(users: ApiUser[], userId: string) {
  const roles = [...new Set(users.flatMap((u) => u.roles ?? []))];
  if (!roles.length) return;
  const scopes = new Map((await many<{ id: string; scope: string }>('SELECT id, scope FROM roles WHERE id = ANY($1::text[])', [roles])).map((r) => [r.id, r.scope]));
  const missing = roles.filter((r) => !scopes.has(r));
  if (missing.length) throw badRequest('error-invalid-roles', `Um ou mais usuários receberam papéis que não existem: ${missing.join(', ')}.`);
  const roomOnly = roles.filter((r) => scopes.get(r) !== 'Users');
  if (roomOnly.length) throw badRequest('error-invalid-roles', `Papéis que valem só dentro de uma sala não podem ser dados na importação: ${roomOnly.join(', ')}.`);
  if (roles.includes('admin') && !(await hasPermission(userId, 'assign-admin-role'))) {
    throw forbidden('Você não tem permissão para dar o papel de administrador (assign-admin-role).');
  }
}

// A mesma política de senha da criação de contas, com a posição do usuário na lista.
function checkPasswords(users: ApiUser[]) {
  users.forEach((u, i) => {
    if (!u.password) return;
    try {
      validatePassword(u.password);
    } catch (e) {
      if (e instanceof ApiError) throw badRequest(e.errorType, `Senha de users[${i}]${u.username ? ` (${u.username})` : ''}: ${e.message}`);
      throw e;
    }
  });
}

// Cada senha vira hash (scrypt, dezenas de ms) durante a chamada: com milhares de senhas numa chamada só, a resposta
// demoraria minutos e passaria do tempo limite de um proxy. Mudável nos testes.
export const addUsersLimits = { passwordsPerCall: 500 };

function checkPasswordCount(users: ApiUser[]) {
  const max = addUsersLimits.passwordsPerCall;
  if (users.filter((u) => u.password).length <= max) return;
  throw badRequest(
    'error-too-many-passwords',
    `Envie no máximo ${max} usuários com senha por chamada: cada senha é protegida (hash) antes de a resposta voltar. Divida a lista em várias chamadas de import.addUsers.`,
  );
}

// O hash (scrypt) roda no pool de threads do Node: alguns por vez, sem enfileirar milhares de uma vez.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function importRoutes(app: FastifyInstance) {
  // ---------- Nova importação ----------
  route(app, 'GET', 'importers.list', { permissions: RUN }, async () => {
    const sources = ['upload', 'url', ...(process.env.IMPORT_SERVER_DIR ? ['path'] : [])];
    return {
      importers: importers
        .filter((i) => i.visible)
        .map((i) => ({ key: i.key, name: i.name, label: i.label, description: i.description, accept: i.accept, sources })),
      maxFileSize: getSetting<number>('Import_MaxFileSize'),
    };
  });
  route(app, 'POST', 'uploadImportFile', { permissions: RUN }, async (req, _rep, ctx) => ({
    operation: presentOperation(await uploadOperation(req, actorOf(ctx))),
  }));
  route(app, 'POST', 'downloadPublicImportFile', { permissions: RUN }, async (req, _rep, ctx) => {
    const body = b(req);
    const key = str(body.importerKey, 'importerKey');
    const fileUrl = str(body.fileUrl, 'fileUrl', { max: 4096 }).trim();
    const row = /^https?:\/\//i.test(fileUrl) ? await urlOperation(actorOf(ctx), key, fileUrl) : await pathOperation(actorOf(ctx), key, fileUrl);
    return { operation: presentOperation(row) };
  });

  // ---------- Operação atual ----------
  route(app, 'GET', 'getCurrentImportOperation', { permissions: RUN }, async () => {
    const r = await currentOperation();
    return { operation: r ? presentOperation(r) : null };
  });
  route(app, 'GET', 'getImportFileData', { permissions: RUN }, async () => importFileData());
  route(app, 'POST', 'startImport', { permissions: RUN }, async (req, _rep, ctx) => {
    const parsed = startBody.safeParse(b(req));
    if (!parsed.success) throw invalid(parsed.error, 'Dados da seleção');
    return { operation: presentOperation(await startImport(actorOf(ctx), parsed.data.input, parsed.data.options ?? {})) };
  });
  route(app, 'GET', 'getImportProgress', { permissions: RUN }, async () => {
    const r = await currentOperation();
    if (!r) throw operationNotFound();
    const operation = presentOperation(r);
    return { key: operation.importerKey, name: operation.type, step: operation.status, count: operation.count, operation };
  });
  route(app, 'POST', 'import.cancel', { permissions: RUN }, async (_req, _rep, ctx) => ({ operation: presentOperation(await cancelOperation(actorOf(ctx))) }));
  route(app, 'POST', 'import.clear', { permissions: RUN }, async (_req, _rep, ctx) => {
    await clearOperations(actorOf(ctx));
    return {};
  });

  // ---------- Histórico ----------
  route(app, 'GET', 'getLatestImportOperations', { permissions: VIEW }, async (req) => {
    const p = paging({ count: '20', ...q(req) });
    return latestOperations(p.offset, p.count);
  });
  // Os rótulos trazem trechos de mensagens (inclusive diretas e de grupos privados) e e-mails: só para quem importa.
  route(app, 'GET', 'import.errors', { permissions: RUN }, async (req) => {
    const query = q(req);
    const type = query.type || undefined;
    if (type && !DATA_TYPES.includes(type)) throw badRequest('error-invalid-params', 'O tipo deve ser user, channel, message ou contact.');
    return listErrors({ operationId: query.operationId || undefined, type, ...paging(query) });
  });

  // ---------- Downloads posteriores ----------
  route(app, 'GET', 'import.pending', { permissions: RUN }, async () => {
    const [files, avatars] = await Promise.all([countPendingFiles(), countPendingAvatars()]);
    return { files, avatars };
  });
  for (const [path, kind] of [
    ['downloadPendingFiles', 'files'],
    ['downloadPendingAvatars', 'avatars'],
  ] as const) {
    route(app, 'POST', path, { permissions: RUN }, async (_req, _rep, ctx) => {
      const r = await startPending(actorOf(ctx), kind);
      return { count: r.count, operation: presentOperation(r.operation) };
    });
  }

  // ---------- Importação pela API ----------
  route(app, 'POST', 'import.new', { permissions: RUN }, async (_req, _rep, ctx) => ({ operation: presentOperation(await newOperation(actorOf(ctx), 'api')) }));
  route(app, 'GET', 'import.status', { permissions: RUN }, async () => {
    const r = await currentOperation();
    if (!r) return { state: 'none' };
    return { state: coarseState(r), operation: presentOperation(r) };
  });
  route(app, 'POST', 'import.addUsers', { permissions: RUN }, async (req, _rep, ctx) => {
    const parsed = addUsersBody.safeParse(b(req));
    if (!parsed.success) throw invalid(parsed.error, 'Dados de usuários');
    const input = parsed.data.users;
    checkPasswordCount(input);
    await checkRoles(input, ctx.userId);
    checkPasswords(input);
    await checkApiOperation();
    const users = await mapLimit(input, 4, toImportUser);
    return { operation: presentOperation(await addApiUsers(users)) };
  });
  route(app, 'POST', 'import.run', { permissions: RUN }, async (_req, _rep, ctx) => {
    const r = await validOperation();
    if (!r || r.importer_key !== 'api') throw badRequest('error-operation-not-found', 'A importação pela API não foi iniciada. Chame import.new antes.');
    return { operation: presentOperation(await startImport(actorOf(ctx), { users: { all: true } }, { skipExistingUsers: true }, 'api')) };
  });
}
