// Em teste (NODE_ENV=test) ou com INTEGRATIONS_DEV_ENDPOINTS=1, as URLs base podem apontar para servidores falsos.
const dev = () => process.env.NODE_ENV === 'test' || process.env.INTEGRATIONS_DEV_ENDPOINTS === '1';
const pick = (env: string, def: string) => (dev() && process.env[env]) || def;

export const endpoints = {
  atlassianApi: () => pick('JIRA_API_GATEWAY', 'https://api.atlassian.com'),
  atlassianAuth: () => pick('ATLASSIAN_AUTH_URL', 'https://auth.atlassian.com'),
  msLogin: () => pick('MS_LOGIN_URL', 'https://login.microsoftonline.com'),
  msGraph: () => pick('MS_GRAPH_URL', 'https://graph.microsoft.com'),
};

// Únicos hosts de fornecedores que safeFetch alcança (além de INTEGRATIONS_ALLOWED_HOSTS).
export const VENDOR_HOSTS = {
  exact: ['api.atlassian.com', 'auth.atlassian.com', 'login.microsoftonline.com', 'graph.microsoft.com'],
  suffixes: ['.atlassian.net', '.jira.com', '.environment.api.powerplatform.com'],
};

// Um rótulo inteiro antes do sufixo ("explorer.atlassian.net"), nunca o próprio sufixo nem um nome com ponto no fim.
export function isVendorHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h.endsWith('.') || !/^[a-z0-9.-]+$/.test(h)) return false;
  if (VENDOR_HOSTS.exact.includes(h)) return true;
  return VENDOR_HOSTS.suffixes.some((s) => h.endsWith(s) && h.length > s.length && !h.slice(0, -s.length).endsWith('.') && !h.startsWith('.'));
}

// Público do token do Power Automate: tem de ser exatamente este texto, com a barra final.
export const FLOW_AUDIENCE = 'https://service.flow.microsoft.com/';
