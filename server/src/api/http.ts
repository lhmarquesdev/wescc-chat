import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, badRequest, forbidden, unauthorized } from '../lib/errors';
import { hasAnyPermission } from '../services/permissions';
import { pendingSetup, resolveToken, type Ctx } from '../services/users';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx | null;
    authUser: any;
  }
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function extractCredentials(req: FastifyRequest) {
  const h = req.headers;
  let userId = h['x-user-id'] as string | undefined;
  let token = h['x-auth-token'] as string | undefined;
  const auth = h.authorization;
  if (!token && auth?.startsWith('Bearer ')) token = auth.slice(7);
  // O cookie só vale para leituras (<img>, downloads): ações exigem o token no cabeçalho, o que impede CSRF.
  if (!token && (req.method === 'GET' || req.method === 'HEAD')) {
    const c = parseCookies(h.cookie);
    token = c.rc_token;
    userId = userId ?? c.rc_uid;
  }
  return { userId, token };
}

export async function authenticate(req: FastifyRequest) {
  req.ctx = null;
  const { userId, token } = extractCredentials(req);
  if (!token) return;
  const r = await resolveToken(userId, token);
  if (!r) return;
  const setup = await pendingSetup(r.user);
  // Com troca de senha ou 2FA pendente, só a API (rotas liberadas em SETUP_ROUTES) reconhece a sessão.
  if (setup && !req.url.startsWith('/api/')) return;
  req.authUser = r.user;
  req.ctx = { userId: r.user.id, username: r.user.username, sessionId: r.sessionId, ip: req.ip, setup };
}

// Rotas disponíveis enquanto a conta tem uma pendência obrigatória.
const SETUP_ROUTES: Record<'password' | '2fa', Set<string>> = {
  password: new Set(['me', 'logout', 'users.updateOwnBasicInfo']),
  '2fa': new Set(['me', 'logout', 'users.2fa.enableTotp', 'users.2fa.verifyTotp']),
};

function setupRequired(setup: 'password' | '2fa') {
  return setup === 'password'
    ? new ApiError(403, 'error-password-change-required', 'Defina uma nova senha antes de continuar.')
    : new ApiError(403, 'error-2fa-setup-required', 'Configure a autenticação em dois fatores antes de continuar.');
}

export interface RouteOpts {
  auth?: boolean;
  permissions?: string[];
}

type Handler = (req: FastifyRequest<any>, reply: FastifyReply, ctx: Ctx) => Promise<unknown>;

export function requireCtx(req: FastifyRequest): Ctx {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

// Registra uma rota da API v1 no formato de resposta do Rocket.Chat: { success, ... }.
export function route(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RouteOpts, handler: Handler) {
  app.route({
    method,
    url: `/api/v1/${path}`,
    handler: async (req, reply) => {
      const auth = opts.auth !== false;
      if (auth && !req.ctx) throw unauthorized();
      if (auth && req.ctx?.setup && !SETUP_ROUTES[req.ctx.setup].has(path)) throw setupRequired(req.ctx.setup);
      if (opts.permissions?.length && !(await hasAnyPermission(req.ctx!.userId, opts.permissions))) throw forbidden();
      // Corpo que não é um objeto JSON (42, "texto", [...]): as rotas leem campos dele.
      if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body))) throw badRequest('error-invalid-params', 'O corpo da requisição deve ser um objeto JSON.');
      const out = await handler(req, reply, req.ctx as Ctx);
      if (reply.sent) return;
      if (out && typeof out === 'object' && 'success' in (out as any)) return out;
      return { ...(out as object), success: true };
    },
  });
}

// Erros do Fastify sobre o formato da requisição, em português (a web mostra o texto); o errorType continua o código.
const FASTIFY_ERRORS: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'O corpo da requisição não é um JSON válido.',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'O corpo da requisição está vazio.',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Formato da requisição não aceito.',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Tamanho da requisição inválido.',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'Envie o arquivo como formulário (multipart/form-data).',
  FST_ERR_BAD_URL: 'Endereço inválido.',
};

const INVALID_PARAM = 'Um dos parâmetros enviados tem um valor inválido.';
// Valor que o PostgreSQL recusa (U+0000, data, número, texto longo): a entrada veio errada, não é falha do servidor.
const DB_INPUT_ERRORS: Record<string, string> = {
  '22021': 'O texto contém um caractere inválido.', // U+0000 em texto
  '22P05': 'O texto contém um caractere inválido.', // U+0000 em jsonb
  '22007': 'Data inválida.',
  '22008': 'Data inválida.', // fora do intervalo
  '22P02': INVALID_PARAM, // texto onde vai número, booleano...
  '22003': INVALID_PARAM, // número fora do intervalo
  '2201W': INVALID_PARAM, // LIMIT negativo
  '2201X': INVALID_PARAM, // OFFSET negativo
  '22001': 'Um dos textos enviados é longo demais.',
};

function inputError(err: any): string | undefined {
  if (typeof err?.code === 'string' && !err.statusCode) {
    if (DB_INPUT_ERRORS[err.code]) return DB_INPUT_ERRORS[err.code];
    // LIMIT ${n} com n = NaN ou Infinity: o banco lê como a coluna "nan".
    if (err.code === '42703' && /column "-?(nan|infinity)"/i.test(err.message ?? '')) return INVALID_PARAM;
  }
  if (err instanceof RangeError && err.message === 'Invalid time value') return 'Data inválida.'; // toISOString()
  // String() de um objeto do JSON com toString/valueOf que não é função ({ "toString": 1 }).
  if (err instanceof TypeError && err.message === 'Cannot convert object to primitive value') return INVALID_PARAM;
  return undefined;
}

const fmtLimit = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`);

export function errorHandler(err: any, req: FastifyRequest, reply: FastifyReply) {
  // Integrações (Jira): o banco recusa excluir o robô de uma regra (gatilho integration_bot_guard).
  if (err?.code === 'WI001') {
    return reply.status(400).send({ success: false, error: err.message, errorType: 'error-integration-bot' });
  }
  if (err instanceof ApiError) {
    return reply.status(err.statusCode).send({ success: false, error: err.message, errorType: err.errorType, details: err.details });
  }
  if (err.validation || err.code === 'FST_ERR_VALIDATION') {
    return reply.status(400).send({ success: false, error: err.message, errorType: 'invalid-params' });
  }
  if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    const limit = req.routeOptions?.bodyLimit ?? 2 * 1024 * 1024;
    return reply.status(413).send({ success: false, error: `O conteúdo enviado é grande demais (máx. ${fmtLimit(limit)}).`, errorType: err.code });
  }
  if (err.statusCode && err.statusCode < 500) {
    // Os textos do Fastify e dos plugins vêm em inglês.
    const fst = typeof err.code === 'string' && err.code.startsWith('FST_');
    const error = fst ? (FASTIFY_ERRORS[err.code] ?? 'Requisição inválida.') : err.message;
    return reply.status(err.statusCode).send({ success: false, error, errorType: err.code ?? 'error' });
  }
  const invalid = inputError(err);
  if (invalid) {
    // Fica no log como aviso, com a pilha, para achar a rota que deixou o valor passar.
    req.log.warn(err);
    return reply.status(400).send({ success: false, error: invalid, errorType: 'error-invalid-params' });
  }
  req.log.error(err);
  return reply.status(500).send({ success: false, error: 'Erro interno do servidor.', errorType: 'error-internal' });
}

// Helpers de parâmetros
export const q = (req: FastifyRequest<any>) => (req.query ?? {}) as Record<string, string>;
export const b = (req: FastifyRequest<any>) => (req.body ?? {}) as Record<string, any>;

export function paging(query: Record<string, string>) {
  // Inteiros: offset=1e20 ou 1e308 passava ao SQL como está ("bigint out of range").
  return { offset: Math.min(1e9, Math.max(0, Math.floor(Number(query.offset ?? 0)) || 0)), count: Math.max(1, Math.min(500, Math.floor(Number(query.count ?? 25)) || 25)) };
}

export function str(v: unknown, name: string, opts: { optional?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return undefined as unknown as string;
    throw new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" é obrigatório.`);
  }
  if (typeof v !== 'string') throw new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" deve ser texto.`);
  if (opts.max && v.length > opts.max) throw new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" é longo demais.`);
  return v;
}

export function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

export function jsonParam<T = any>(v: unknown, fallback: T): T {
  if (!v) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}
