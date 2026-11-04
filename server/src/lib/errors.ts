export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public errorType: string,
    message?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message ?? errorType);
  }
}

export const badRequest = (type: string, msg?: string, details?: Record<string, unknown>) => new ApiError(400, type, msg, details);
// Os textos padrão aparecem para quem usa o chat (a web mostra error): em português. Integrações leem errorType.
export const unauthorized = (msg = 'Entre de novo para continuar.') => new ApiError(401, 'error-unauthorized', msg);
export const forbidden = (msg = 'Você não tem permissão para fazer isso.') => new ApiError(403, 'error-not-allowed', msg);
export const notFound = (type = 'error-not-found', msg = 'Não encontrado.') => new ApiError(404, type, msg);
