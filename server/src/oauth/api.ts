import type { FastifyInstance, FastifyReply } from 'fastify';
import { b, parseCookies, q, route, str } from '../api/http';
import { ApiError } from '../lib/errors';
import { randomToken } from '../lib/ids';
import { audit } from '../services/audit';
import { issueSsoCredential, safeRedirect, siteUrl, ssoErrorPage, ssoLoginUrl } from '../services/sso';
import { actorOf } from '../services/users';
import { BROWSER_COOKIE, completeLogin, consumeState, startLogin, stateTtlSeconds } from './login';
import { createProvider, deleteProvider, getEnabledProvider, getProvider, listPresets, listProviders, listPublicProviders, updateProvider } from './providers';

const P = (req: any) => (req.params ?? {}) as Record<string, string>;
const PERM = { permissions: ['manage-oauth-apps'] };

function htmlError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(ssoErrorPage(message, 'Não foi possível entrar'));
}

// Cookie que liga o pedido de login ao navegador que o iniciou (contra CSRF de login).
function browserCookie(nonce: string) {
  const secure = siteUrl().startsWith('https:') ? '; Secure' : '';
  return `${BROWSER_COOKIE}=${nonce}; Path=/oauth; Max-Age=${stateTtlSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export function oauthRoutes(app: FastifyInstance) {
  // ---------- Administração ----------
  route(app, 'GET', 'oauth-providers.public', { auth: false }, async () => ({ providers: await listPublicProviders() }));
  route(app, 'GET', 'oauth-providers.presets', PERM, async () => ({ presets: listPresets() }));
  route(app, 'GET', 'oauth-providers', PERM, async () => ({ providers: await listProviders() }));
  route(app, 'GET', 'oauth-providers/:id', PERM, async (req) => ({ provider: await getProvider(P(req).id) }));
  route(app, 'POST', 'oauth-providers', PERM, async (req, _r, ctx) => ({ provider: await createProvider(actorOf(ctx), b(req)) }));
  route(app, 'PUT', 'oauth-providers/:id', PERM, async (req, _r, ctx) => ({ provider: await updateProvider(actorOf(ctx), str(P(req).id, 'id'), b(req)) }));
  route(app, 'DELETE', 'oauth-providers/:id', PERM, async (req, _r, ctx) => {
    await deleteProvider(actorOf(ctx), str(P(req).id, 'id'));
    return {};
  });

  // ---------- Fluxo de login ----------
  app.get('/oauth/:provider/login', async (req, reply) => {
    const p = await getEnabledProvider(P(req).provider);
    if (!p) return htmlError(reply, 404, 'Este provedor de login não existe ou está desativado.');
    let nonce = parseCookies(req.headers.cookie)[BROWSER_COOKIE];
    if (!nonce || !/^[A-Za-z0-9_-]{32,64}$/.test(nonce)) nonce = randomToken(24);
    const url = await startLogin(p, safeRedirect(q(req).redirect), nonce);
    reply.header('set-cookie', browserCookie(nonce)).header('cache-control', 'no-store');
    return reply.redirect(url);
  });

  app.get('/oauth/:provider/callback', async (req, reply) => {
    const p = await getEnabledProvider(P(req).provider);
    if (!p) return htmlError(reply, 404, 'Este provedor de login não existe ou está desativado.');
    const query = q(req);
    try {
      if (typeof query.state !== 'string' || !query.state) throw new ApiError(400, 'error-oauth-state', 'A resposta do provedor veio sem o parâmetro "state".');
      const st = await consumeState(p.id, query.state, parseCookies(req.headers.cookie)[BROWSER_COOKIE]);
      if (query.error) {
        const detail = String(query.error_description ?? query.error).slice(0, 200);
        throw new ApiError(401, 'error-oauth-denied', `O provedor não autorizou o login: ${detail}`);
      }
      if (typeof query.code !== 'string' || !query.code) throw new ApiError(400, 'error-oauth-code', 'A resposta do provedor veio sem o código de autorização.');
      const { user, externalId, created } = await completeLogin(p, query.code, st.code_verifier);
      // A credencial da URL só é trocada por uma sessão com o cookie entregue aqui, neste navegador.
      const { token, cookie } = await issueSsoCredential(user.id, 'oauth');
      await audit({ id: user.id, username: user.username, ip: req.ip }, 'auth.oauth.callback', { provider: p.id }, { externalId, created });
      return reply.header('set-cookie', cookie).header('cache-control', 'no-store').redirect(ssoLoginUrl('oauth', token, st.redirect));
    } catch (e: any) {
      const known = e instanceof ApiError;
      if (!known) req.log.error(e);
      await audit({ ip: req.ip, username: `oauth:${p.id}` }, 'auth.oauth.failed', { provider: p.id }, { error: known ? `${e.errorType}: ${e.message}`.slice(0, 300) : 'erro interno' });
      return htmlError(reply, known ? e.statusCode : 500, known ? e.message : 'Erro inesperado ao concluir o login. Tente novamente.');
    }
  });
}
