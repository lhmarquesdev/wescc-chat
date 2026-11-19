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
const INVALID_DATE = 'Data inválida.';
// Valor que o PostgreSQL recusa (U+0000, data, número, texto longo): a entrada veio errada, não é falha do servidor.
const DB_INPUT_ERRORS: Record<string, string> = {
  '22021': 'O texto contém um caractere inválido.', // U+0000 em texto
  '22P05': 'O texto contém um caractere inválido.', // U+0000 em jsonb
  '22007': INVALID_DATE,
  '22008': INVALID_DATE, // fora do intervalo
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
  if (err instanceof RangeError && err.message === 'Invalid time value') return INVALID_DATE; // toISOString()
  // String() de um objeto do JSON com toString/valueOf que não é função ({ "toString": 1 }).
  if (err instanceof TypeError && err.message === 'Cannot convert object to primitive value') return INVALID_PARAM;
  return undefined;
}

const DATE_PARAM = /^(latest|oldest|lastUpdate|updatedSince|start|end|from|to|[a-z]+(Date|At))$/;

// O parâmetro (da consulta ou do corpo) que trouxe o valor recusado, quando só um pode ter sido: o PostgreSQL cita o
// valor entre aspas; numa data inválida (toISOString), o único parâmetro de data que não é uma data.
function badParam(req: FastifyRequest, err: any): string | undefined {
  const msg = typeof err?.code === 'string' ? String(err.message ?? '') : '';
  const quoted = (/: "(.*)"$/s.exec(msg) ?? /^value "(.*)" is out of range/s.exec(msg))?.[1];
  if (quoted === undefined && !(err instanceof RangeError)) return undefined;
  const hits = new Set<string>();
  for (const src of [req.query, req.body]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if ((typeof v !== 'string' && typeof v !== 'number') || v === '') continue;
      if (quoted !== undefined ? String(v) === quoted : DATE_PARAM.test(k) && Number.isNaN(Date.parse(String(v)))) hits.add(k);
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined;
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
    const name = invalid === INVALID_DATE || invalid === INVALID_PARAM ? badParam(req, err) : undefined;
    const error = !name ? invalid : invalid === INVALID_DATE ? `O parâmetro "${name}" deve ser uma data.` : `O parâmetro "${name}" tem um valor inválido.`;
    return reply.status(400).send({ success: false, error, errorType: 'error-invalid-params' });
  }
  req.log.error(err);
  return reply.status(500).send({ success: false, error: 'Erro interno do servidor.', errorType: 'error-internal' });
}

// Helpers de parâmetros
export const q = (req: FastifyRequest<any>) => (req.query ?? {}) as Record<string, string>;
export const b = (req: FastifyRequest<any>) => (req.body ?? {}) as Record<string, any>;

// Números fora do normal (1e309 vira Infinity, 1.5, -3) não chegam ao SQL.
export function paging(query: Record<string, string>) {
  const int = (v: unknown, def: number) => {
    const n = Number(v ?? def);
    return Number.isNaN(n) ? def : Number.isFinite(n) ? Math.floor(n) : n > 0 ? Number.MAX_SAFE_INTEGER : 0;
  };
  return { offset: Math.min(1_000_000, Math.max(0, int(query.offset, 0))), count: Math.max(1, Math.min(500, int(query.count, 25) || 25)) };
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

// Número inteiro de um parâmetro (count da query): vazio vale o padrão, o que não é número é recusado e o resto fica
// entre min e max. Sem isso "count=abc" chegava ao SQL como NaN e virava erro 500.
export function intParam(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" deve ser um número inteiro.`);
  return Math.min(max, Math.max(min, n));
}

// Data de um parâmetro (latest, oldest, lastUpdate). ISO 8601 segue como veio (com os microssegundos, se houver); outro
// formato que o JavaScript entende vira ISO; o resto é recusado (antes chegava ao banco e virava erro 500).
export function dateParam(v: unknown, name: string, opts: { optional?: boolean } = {}): string {
  const s = str(v, name, opts);
  if (s === undefined) return s;
  const bad = () => new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" deve ser uma data (ex.: 2026-11-19T10:00:00Z).`);
  const t = Date.parse(s);
  // O banco não aceita o ano 0 nem anos de mais de 4 dígitos, que o JavaScript aceita.
  const year = new Date(t).getUTCFullYear();
  if (Number.isNaN(t) || year < 1 || year > 9999) throw bad();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  if (!iso) return new Date(t).toISOString();
  // Dia que não existe (2026-02-30, 2026-04-31): o JavaScript passa para o mês seguinte, o banco recusa.
  const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const day = new Date(0);
  day.setUTCFullYear(y, m - 1, d);
  if (y < 1 || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) throw bad();
  return s;
}

// Data de filtro (AAAA-MM-DD ou data e hora ISO). Inválida vira 400 "Data inválida." em vez de erro do banco (500).
// AAAA-MM-DD segue como veio (o banco a lê como antes); com hora, segue como instante ISO.
export function filterDateParam(v: unknown, name: string, opts: { optional?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return undefined;
    throw new ApiError(400, 'error-invalid-params', `O parâmetro "${name}" é obrigatório.`);
  }
  const s = typeof v === 'string' ? v.trim() : '';
  // O dia é conferido no calendário também com hora (o JavaScript aceitava 2026-02-30T10:00 como 2 de março).
  const day = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(s);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const t = new Date(Date.UTC(y, m - 1, d));
    const real = t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
    if (real && !day[4]) return s;
    if (real && !Number.isNaN(new Date(s).getTime())) return new Date(s).toISOString();
  }
  throw new ApiError(400, 'error-invalid-date', 'Data inválida.', { param: name });
}

// Início depois do fim: recusa em vez de devolver uma lista vazia sem explicação.
export function assertDateOrder(start: string | undefined, end: string | undefined) {
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) throw new ApiError(400, 'error-invalid-date', 'A data inicial é depois da final.');
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
