import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, forbidden, unauthorized } from '../lib/errors';
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
      const out = await handler(req, reply, req.ctx as Ctx);
      if (reply.sent) return;
      if (out && typeof out === 'object' && 'success' in (out as any)) return out;
      return { ...(out as object), success: true };
    },
  });
}

export function errorHandler(err: any, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    return reply.status(err.statusCode).send({ success: false, error: err.message, errorType: err.errorType, details: err.details });
  }
  if (err.validation || err.code === 'FST_ERR_VALIDATION') {
    return reply.status(400).send({ success: false, error: err.message, errorType: 'invalid-params' });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.status(err.statusCode).send({ success: false, error: err.message, errorType: err.code ?? 'error' });
  }
  req.log.error(err);
  return reply.status(500).send({ success: false, error: 'Erro interno do servidor.', errorType: 'error-internal' });
}

// Helpers de parâmetros
export const q = (req: FastifyRequest<any>) => (req.query ?? {}) as Record<string, string>;
export const b = (req: FastifyRequest<any>) => (req.body ?? {}) as Record<string, any>;

export function paging(query: Record<string, string>) {
  return { offset: Math.max(0, Number(query.offset ?? 0) || 0), count: Math.max(1, Math.min(500, Number(query.count ?? 25) || 25)) };
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
