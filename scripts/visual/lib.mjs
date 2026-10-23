// Partes comuns dos scripts de capturas: parâmetros, API do servidor e o navegador.
//
// Variáveis de ambiente:
//   BASE             URL do app (Vite ou servidor), obrigatória em seed, shots e calls. Ex.: http://localhost:5201
//   PLAYWRIGHT_CORE  pasta do pacote playwright-core (ou o index.mjs dele).
//                    Ex.: PLAYWRIGHT_CORE=/caminho/do/e2e/node_modules/playwright-core
//   CHROMIUM_PATH    executável do Chromium (padrão: /opt/pw-browsers/chromium-1194/chrome-linux/chrome, se existir)
//   ADMIN_USER / ADMIN_PASSWORD   login do administrador (padrão admin / admin12345)
//   OUT              pasta de saída, quando não vem como argumento
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE = (process.env.BASE ?? '').replace(/\/$/, '');
export function requireBase() {
  if (BASE) return;
  console.error('Defina BASE com a URL do app, por exemplo BASE=http://localhost:5201');
  process.exit(2);
}
export const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin12345';

// Primeiro argumento que não é opção (--x=y) ou OUT.
export function outDir() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const dir = arg ?? process.env.OUT;
  if (!dir) {
    console.error('Informe a pasta de saída como argumento ou em OUT.');
    process.exit(2);
  }
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

export function flag(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

export async function loadChromium() {
  const spec = process.env.PLAYWRIGHT_CORE;
  let mod;
  if (spec) {
    const file = /\.(m?js)$/.test(spec) ? spec : path.join(spec, 'index.mjs');
    mod = await import(pathToFileURL(path.resolve(file)).href);
  } else {
    mod = await import('playwright-core').catch(() => {
      console.error('playwright-core não encontrado. Defina PLAYWRIGHT_CORE com a pasta do pacote.');
      process.exit(2);
    });
  }
  return mod.chromium ?? mod.default?.chromium;
}

const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);

export async function login(user, password) {
  const r = await fetch(`${BASE}/api/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, password }) });
  const j = await r.json().catch(() => ({}));
  if (!j.data?.authToken) throw new Error(`login ${user}: ${j.error ?? r.status}`);
  return j.data;
}

// Cliente da API REST com o token de um usuário.
export function client(d) {
  const H = { 'x-user-id': d.userId, 'x-auth-token': d.authToken };
  return {
    userId: d.userId,
    call: (m, p, body) =>
      fetch(`${BASE}/api/v1/${p}${m === 'GET' && body ? `?${new URLSearchParams(body)}` : ''}`, {
        method: m,
        headers: { ...H, 'content-type': 'application/json' },
        body: m !== 'GET' && body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json()),
    upload: async (rid, file, name, type, description) => {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(file)], { type }), name);
      if (description) fd.append('description', description);
      return fetch(`${BASE}/api/v1/rooms.upload/${rid}`, { method: 'POST', headers: H, body: fd }).then((r) => r.json());
    },
  };
}
