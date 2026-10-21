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
    throw new ApiError(res.status, json.errorType ?? 'error', json.error ?? `Erro ${res.status}`, json.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(path: string, params?: Params) => request<T>('GET', path, params),
  post: <T = any>(path: string, body?: Params | FormData) => request<T>('POST', path, body ?? {}),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

// Upload com progresso (XMLHttpRequest).
export function uploadFile(rid: string, file: File, fields: Record<string, string>, onProgress?: (p: number) => void) {
  return new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/rooms.upload/${rid}`);
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
      else reject(new ApiError(xhr.status, json.errorType ?? 'error', json.error ?? 'Falha no upload'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Falha de rede no upload'));
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
