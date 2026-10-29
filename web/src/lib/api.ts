// Cliente HTTP da API v1.

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorType: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

interface Credentials {
  userId: string;
  authToken: string;
}

const KEY = 'wescc.auth';
let creds: Credentials | null = load();
let onUnauthorized: (() => void) | null = null;

function load(): Credentials | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

export function getCredentials() {
  return creds;
}

// A credencial em memória diante da guardada, que as outras abas deste navegador também usam: 'gone' quando alguém saiu
// da conta em outra aba (mesmo com o pedido de saída falhando no servidor), 'other' quando outra pessoa entrou lá. A
// mesma pessoa com um token novo (entrou de novo em outra aba) segue com o novo. Sem armazenamento, nada a comparar.
export function syncCredentials(): 'ok' | 'gone' | 'other' {
  if (!creds) return 'ok';
  let stored: Credentials | null;
  try {
    const v = localStorage.getItem(KEY);
    stored = v ? JSON.parse(v) : null;
  } catch {
    return 'ok';
  }
  if (!stored) return 'gone';
  if (stored.userId !== creds.userId) return 'other';
  if (stored.authToken !== creds.authToken) creds = stored;
  return 'ok';
}

let onSignedOutElsewhere: ((why: 'gone' | 'other') => void) | null = null;
export function setSignedOutElsewhereHandler(fn: (why: 'gone' | 'other') => void) {
  onSignedOutElsewhere = fn;
}
// Outra aba saiu da conta ou entrou com outra: esta não continua com a credencial antiga.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return;
  const why = syncCredentials();
  if (why !== 'ok') onSignedOutElsewhere?.(why);
});

export function setCredentials(c: Credentials | null) {
  creds = c;
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    // armazenamento indisponível
  }
  // Cookies permitem que <img> e downloads enviem a autenticação.
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  if (c) {
    document.cookie = `rc_uid=${c.userId}; path=/; SameSite=Lax${secure}`;
    document.cookie = `rc_token=${encodeURIComponent(c.authToken)}; path=/; SameSite=Lax${secure}`;
  } else {
    document.cookie = 'rc_uid=; path=/; max-age=0';
    document.cookie = 'rc_token=; path=/; max-age=0';
  }
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// O administrador passou a exigir troca de senha ou 2FA durante a sessão: recarrega para mostrar a tela de configuração
// (no máximo uma vez a cada 30 s, caso as instâncias do servidor ainda discordem por alguns segundos).
function setupRequired() {
  try {
    const last = Number(sessionStorage.getItem('wescc.setupReload') ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem('wescc.setupReload', String(Date.now()));
  } catch {
    // armazenamento indisponível
  }
  location.reload();
}

if (creds) setCredentials(creds);

type Params = Record<string, unknown> | undefined;

async function request<T = any>(method: string, path: string, data?: Params | FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (creds) {
    headers['X-User-Id'] = creds.userId;
    headers['X-Auth-Token'] = creds.authToken;
  }
  let url = `/api/v1/${path}`;
  let body: BodyInit | undefined;
  if (method === 'GET' && data && !(data instanceof FormData)) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null) continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  } else if (data instanceof FormData) {
    body = data;
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }
  const res = await fetch(url, { method, headers, body });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    // resposta sem corpo
  }
  if (!res.ok || json.success === false) {
    if (res.status === 401 && path !== 'login') onUnauthorized?.();
    if (res.status === 403 && (json.errorType === 'error-2fa-setup-required' || json.errorType === 'error-password-change-required')) setupRequired();
    throw new ApiError(res.status, json.errorType ?? 'error', json.error ?? `Erro ${res.status}`, json.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(path: string, params?: Params) => request<T>('GET', path, params),
  post: <T = any>(path: string, body?: Params | FormData) => request<T>('POST', path, body ?? {}),
  put: <T = any>(path: string, body?: Params) => request<T>('PUT', path, body ?? {}),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

// Upload com progresso (XMLHttpRequest). Os campos vão antes do arquivo: o servidor lê o multipart em ordem.
export function uploadTo<T = any>(path: string, file: File, fields: Record<string, string>, onProgress?: (p: number) => void, signal?: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError(0, 'aborted', 'Envio cancelado.'));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/${path}`);
    if (creds) {
      xhr.setRequestHeader('X-User-Id', creds.userId);
      xhr.setRequestHeader('X-Auth-Token', creds.authToken);
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let json: any = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // ignora
      }
      if (xhr.status >= 200 && xhr.status < 300 && json.success !== false) resolve(json);
      else reject(new ApiError(xhr.status, json.errorType ?? 'error', json.error ?? (xhr.status === 413 ? 'O arquivo é grande demais para o servidor.' : 'Falha no upload'), json.details));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Falha de rede no upload'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Envio cancelado.'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

export function uploadFile(rid: string, file: File, fields: Record<string, string>, onProgress?: (p: number) => void) {
  return uploadTo(`rooms.upload/${rid}`, file, fields, onProgress);
}

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
