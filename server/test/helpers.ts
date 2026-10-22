import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import { boot } from '../src/boot';
import { pool } from '../src/db/pool';
import { bus } from '../src/realtime/bus';

let app: FastifyInstance | null = null;
let baseUrl = '';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

export async function startServer() {
  await resetDb();
  app = await buildApp({ logger: false });
  await boot(() => {});
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as any;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return app;
}

export async function stopServer() {
  await app?.close();
  await bus.stop();
}

export interface Auth {
  userId: string;
  authToken: string;
  username: string;
}

export async function api(method: string, path: string, body?: unknown, auth?: Auth) {
  const headers: Record<string, string> = {};
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (auth) {
    headers['x-user-id'] = auth.userId;
    headers['x-auth-token'] = auth.authToken;
  }
  let url = `${baseUrl}/api/v1/${path}`;
  let payload: any = undefined;
  if (method === 'GET' && body && typeof body === 'object') {
    url += '?' + new URLSearchParams(body as Record<string, string>).toString();
  } else if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

export async function raw(path: string, auth?: Auth) {
  const headers: Record<string, string> = {};
  if (auth) headers.cookie = `rc_uid=${auth.userId}; rc_token=${auth.authToken}`;
  return fetch(`${baseUrl}${path}`, { headers });
}

export async function login(user: string, password: string): Promise<Auth> {
  const r = await api('POST', 'login', { user, password });
  if (!r.data) throw new Error(`login falhou: ${JSON.stringify(r)}`);
  return { userId: r.data.userId, authToken: r.data.authToken, username: r.data.me.username };
}

export async function admin() {
  return login('admin', 'admin-pass-123');
}

// Ativa o 2FA (TOTP) da conta e devolve a chave, para gerar códigos com totpCode().
export async function enable2fa(auth: Auth) {
  const { totpCode } = await import('../src/lib/totp');
  const setup = await api('POST', 'users.2fa.enableTotp', {}, auth);
  if (!setup.secret) throw new Error(JSON.stringify(setup));
  const r = await api('POST', 'users.2fa.verifyTotp', { code: totpCode(setup.secret) }, auth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return setup.secret as string;
}

let seq = 0;
export async function newUser(adminAuth: Auth, extra: Record<string, unknown> = {}) {
  seq++;
  const username = `user${seq}${Math.random().toString(36).slice(2, 6)}`;
  const r = await api('POST', 'users.create', { username, name: `Usuário ${seq}`, email: `${username}@test.local`, password: 'senha-forte-1', ...extra }, adminAuth);
  if (!r.success) throw new Error(JSON.stringify(r));
  return login(username, 'senha-forte-1');
}

export function connectWs(auth: Auth) {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/websocket`);
  const events: any[] = [];
  const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  ws.on('message', (data) => {
    const ev = JSON.parse(String(data));
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.pred(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: auth.authToken })));
    ws.on('error', reject);
    waiters.push({ pred: (e) => e.type === 'connected', resolve: () => resolve() });
  });
  const waitFor = (pred: (e: any) => boolean, ms = 5000) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      const t = setTimeout(() => reject(new Error('timeout esperando evento')), ms);
      waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  return { ws, events, ready, waitFor, send: (e: unknown) => ws.send(JSON.stringify(e)), close: () => ws.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const urlOf = (path: string) => `${baseUrl}${path}`;
