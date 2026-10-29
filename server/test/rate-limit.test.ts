import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, startServer, stopServer, urlOf, type Auth } from './helpers';

// Limite de requisições da API (@fastify/rate-limit): a recusa sai no formato de erro da API, com o texto do limite,
// o errorType próprio e o Retry-After, para a web mostrar a mensagem certa (e não "Erro 429").
let A: Auth;
beforeAll(async () => {
  await startServer();
  A = await admin();
});
afterAll(() => stopServer());

describe('limite de requisições da API', () => {
  it('a recusa traz o texto do limite, error-too-many-requests e Retry-After', async () => {
    const U = await newUser(A);
    const s = await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: true, API_Enable_Rate_Limiter_Limit_Calls_Default: 5 } }, A);
    expect(s.success).toBe(true);
    const headers = { 'x-user-id': U.userId, 'x-auth-token': U.authToken };
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await fetch(urlOf('/api/v1/me'), { headers });
      if (last.status === 429) break;
      await last.arrayBuffer();
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await last!.json();
    expect(body).toMatchObject({ success: false, errorType: 'error-too-many-requests' });
    expect(body.error).toMatch(/^Limite de requisições excedido\. Tente novamente em \d+s\.$/);
    expect(body.details?.retryAfter).toBe(Number(last!.headers.get('retry-after')));
    // A conta segue válida: a recusa não é 401 nem derruba a sessão (o admin, com outra chave, continua livre).
    expect((await api('GET', 'me', undefined, A)).success).toBe(true);
  });

  it('sem login a chave é o IP e a recusa tem o mesmo formato', async () => {
    await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter_Limit_Calls_Default: 3 } }, A);
    let r: any = null;
    for (let i = 0; i < 6; i++) {
      r = await api('GET', 'info');
      if (r.status === 429) break;
    }
    expect(r.status).toBe(429);
    expect(r.errorType).toBe('error-too-many-requests');
    expect(r.error).toMatch(/^Limite de requisições excedido/);
  });
});
