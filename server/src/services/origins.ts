import { getSetting } from './settings';
import { siteUrl } from './sso';

// Origens de navegador aceitas: o próprio servidor, a URL do site e, com CORS ligado, as origens configuradas.

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function corsOrigins() {
  if (!getSetting('API_Enable_CORS')) return [];
  return String(getSetting('API_CORS_Origin') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// CORS da API: o cliente web é da mesma origem e não precisa de cabeçalhos; outros sites só com CORS ligado.
export function isCorsOriginAllowed(origin: string | undefined) {
  if (!origin) return false;
  if (origin === originOf(siteUrl())) return true;
  const list = corsOrigins();
  return list.includes('*') || list.includes(origin);
}

// Conexões que usam o cookie de sessão (WebSocket): só da mesma origem, da URL do site ou de origens liberadas no CORS.
export function isTrustedBrowserOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) return true; // clientes fora do navegador não mandam Origin
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (host && o.host === host) return true;
  if (o.origin === originOf(siteUrl())) return true;
  return corsOrigins().filter((x) => x !== '*').includes(o.origin);
}
