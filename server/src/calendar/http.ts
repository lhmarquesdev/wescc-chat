// Chamadas HTTP da Agenda ao Google e ao Microsoft Graph, com os erros classificados para a sincronização.
import { safeFetch, SafeFetchError, type SafeResponse } from '../lib/safeFetch';

// auth: o token não vale mais (a pessoa conecta de novo) · gone: a leitura incremental venceu (ler tudo de novo) ·
// notFound: o evento não existe mais lá · retry: fora do ar ou pediu para esperar · fail: pedido recusado.
export type CalErrorKind = 'auth' | 'gone' | 'notFound' | 'retry' | 'fail';

export class CalHttpError extends Error {
  constructor(
    public kind: CalErrorKind,
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export const HTTP_TEXT = {
  unavailable: (who: string) => `O ${who} não respondeu. A agenda tenta de novo na próxima rodada.`,
  auth: (who: string) => `O ${who} recusou o acesso. Conecte a conta de novo na Agenda.`,
  refused: (who: string, status: number, code: string) => `O ${who} recusou o pedido (HTTP ${status}${code ? `, ${code}` : ''}).`,
  url: 'O endereço do fornecedor não é permitido neste servidor.',
};

function parse(res: SafeResponse): any {
  if (!res.body.length) return null;
  try {
    return res.json();
  } catch {
    return null;
  }
}

export async function calFetch<T = any>(
  who: string,
  url: string,
  o: { token?: string; method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  let res: SafeResponse;
  try {
    res = await safeFetch(url, { method: o.method ?? 'GET', headers, body, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
  } catch (e) {
    if (e instanceof SafeFetchError && (e.code === 'error-url-not-allowed' || e.code === 'error-url-internal')) throw new CalHttpError('fail', HTTP_TEXT.url);
    throw new CalHttpError('retry', HTTP_TEXT.unavailable(who));
  }
  const json = parse(res);
  if (res.status >= 200 && res.status < 300) return json as T;
  const code = String(json?.error?.code ?? json?.error?.status ?? json?.error ?? '');
  if (res.status === 401 || (res.status === 400 && code === 'invalid_grant')) throw new CalHttpError('auth', HTTP_TEXT.auth(who), res.status);
  if (res.status === 410) throw new CalHttpError('gone', 'sync token expirado', 410);
  if (res.status === 404) throw new CalHttpError('notFound', HTTP_TEXT.refused(who, 404, code), 404);
  if (res.status === 429 || res.status >= 500 || res.status === 408) throw new CalHttpError('retry', HTTP_TEXT.unavailable(who), res.status);
  // Graph: a janela do delta venceu ou o token é de outra consulta.
  if (res.status === 400 && /syncStateNotFound|resyncRequired|SyncStateInvalid/i.test(code)) throw new CalHttpError('gone', 'delta expirado', 400);
  throw new CalHttpError('fail', HTTP_TEXT.refused(who, res.status, code), res.status);
}

// Claims de um id_token recebido direto do endpoint de token (por TLS): só para mostrar o e-mail da conta.
export function idTokenClaims(jwt: unknown): { email?: string; name?: string; sub?: string } {
  try {
    const part = String(jwt ?? '').split('.')[1];
    if (!part) return {};
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return {
      ...(typeof c?.email === 'string' ? { email: c.email } : {}),
      ...(typeof c?.name === 'string' ? { name: c.name } : {}),
      ...(typeof c?.sub === 'string' ? { sub: c.sub } : {}),
    };
  } catch {
    return {};
  }
}
