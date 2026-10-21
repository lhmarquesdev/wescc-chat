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
export const unauthorized = (msg = 'You must be logged in to do this.') => new ApiError(401, 'error-unauthorized', msg);
export const forbidden = (msg = 'User does not have the permissions required for this action') => new ApiError(403, 'error-not-allowed', msg);
export const notFound = (type = 'error-not-found', msg?: string) => new ApiError(404, type, msg);
