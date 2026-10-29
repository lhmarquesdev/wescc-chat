import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SecretState } from '@shared/integrations';
import { readSecret } from '../config';
import { many, one, query } from '../db/pool';
import { audit } from '../services/audit';
import { ApiError } from './errors';

// Segredos das integrações (tokens, client secret, endereços do Workflows) cifrados com AES-256-GCM.
// O AAD prende cada valor ao seu lugar (e o token do Jira à origem do site): copiado para outra linha, não abre.

export type SecretId =
  | 'jira.apiToken'
  | 'jira.oauthClientSecret'
  | 'jira.webhookToken'
  | 'jira.webhookSecret'
  | 'msteams.clientSecret'
  | 'msteams.serviceRefreshToken'
  | 'msteams.notifyToken'
  | 'calendar.googleClientSecret';

const UNREADABLE = 'Não foi possível ler um segredo das integrações (a chave de segredos mudou). Cadastre o segredo de novo.';
const MISSING = 'O servidor não tem a chave de segredos das integrações. Defina SECRETS_KEY_FILE com o caminho completo de um arquivo de chave e reinicie o serviço.';
export const KEY_MISMATCH = 'A chave de segredos deste servidor é diferente da usada pelos outros. Use a mesma SECRETS_KEY em todos.';
const RELATIVE = 'SECRETS_KEY_FILE precisa de um caminho completo, por exemplo C:\\Wescc\\secrets\\integrations-key.txt.';
// Sem o caminho nem o erro do sistema: este texto vai para quem gerencia as integrações e para as respostas da API.
// O detalhe (com o caminho) fica no log e só aparece para o papel admin.
const CREATE_FAILED = 'Não foi possível criar a chave de segredos das integrações no arquivo de SECRETS_KEY_FILE. Confira se a pasta existe e se o serviço pode gravar nela.';
const READ_FAILED = 'Não foi possível ler o arquivo de SECRETS_KEY_FILE. Confira o caminho e se o serviço pode ler o arquivo.';
const MAX_SECRET = 8 * 1024;

export class SecretKeyError extends ApiError {
  code = 'error-secret-key';
  constructor(message = UNREADABLE) {
    super(500, 'error-secret-key', message);
  }
}

// AAD de cada lugar onde um segredo é gravado (os módulos do Jira e do Teams usam os mesmos textos).
export const aadFor = {
  secret: (id: SecretId, boundTo?: string | null) => (boundTo ? `secret:${id}:${boundTo}` : `secret:${id}`),
  rule: (ruleId: string) => `integration:${ruleId}:secret`,
  linked: (userId: string, provider: 'jira' | 'microsoft', field: 'access' | 'refresh', origin?: string | null) =>
    provider === 'jira' ? `linked:${userId}:jira:${field}:${origin ?? ''}` : `linked:${userId}:microsoft:${field}`,
  oauth: (stateHash: string) => `oauth:${stateHash}`,
  calendar: (accountId: string, field: 'access' | 'refresh') => `calendar:${accountId}:${field}`,
};

// ---------- Chave ----------

interface Key {
  kid: string;
  key: Buffer;
}
interface KeyState {
  source: 'env' | 'file' | 'none';
  file?: string;
  created: boolean;
  current: Key | null;
  previous: Key | null;
  problem?: string;
  detail?: string;
}

let state: KeyState | null = null;
let mismatch = false;
// Conferência do kid com o das outras instâncias (keyReady, integrationsPaused).
const RECHECK_MS = 60_000;
let checkedAt = 0;
let triedAt = 0;
let autoCheck = false;
let checking: Promise<void> | null = null;
let generation = 0; // muda a cada reloadSecretsKey: uma conferência que começou antes não vale depois

function parseKey(raw: string, name: string): Key | string {
  const s = raw.trim();
  const key = Buffer.from(s, 'base64');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || key.length !== 32) {
    return `${name} precisa ter 32 bytes aleatórios em base64 (44 caracteres). A chave atual não serve: nenhum segredo das integrações pode ser lido ou salvo.`;
  }
  return { kid: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

// Lê a chave de um arquivo com caminho completo; cria o arquivo uma vez se ele ainda não existe.
function keyFromFile(file: string, create: boolean): { raw?: string; created: boolean; problem?: string; detail?: string } {
  if (!path.isAbsolute(file)) return { created: false, problem: RELATIVE };
  let created = false;
  if (create && !fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      created = true;
    } catch (e) {
      // Outra instância criou ao mesmo tempo: lê o dela.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { created: false, problem: CREATE_FAILED, detail: `Não foi possível criar a chave de segredos das integrações em ${file}: ${(e as Error).message}` };
      }
    }
  }
  try {
    return { raw: readSecret('SECRETS_KEY', { SECRETS_KEY_FILE: file }) ?? '', created };
  } catch (e) {
    return { created, problem: READ_FAILED, detail: (e as Error).message };
  }
}

function loadKeys(): KeyState {
  const env = process.env;
  const s: KeyState = { source: 'none', created: false, current: null, previous: null };
  let raw: string | undefined;
  if (env.SECRETS_KEY) {
    s.source = 'env';
    raw = env.SECRETS_KEY;
  } else if (env.SECRETS_KEY_FILE) {
    s.source = 'file';
    s.file = env.SECRETS_KEY_FILE;
    const r = keyFromFile(env.SECRETS_KEY_FILE, true);
    s.created = r.created;
    s.problem = r.problem;
    s.detail = r.detail;
    raw = r.raw;
  }
  if (raw !== undefined && !s.problem) {
    const k = parseKey(raw, s.source === 'env' ? 'SECRETS_KEY' : 'SECRETS_KEY_FILE');
    if (typeof k === 'string') s.problem = k;
    else s.current = k;
  }
  // Chave anterior, para trocar de chave sem perder os segredos (reencryptAll passa tudo para a atual).
  let prev: string | undefined;
  if (env.SECRETS_KEY_PREVIOUS) prev = env.SECRETS_KEY_PREVIOUS;
  else if (env.SECRETS_KEY_PREVIOUS_FILE) prev = keyFromFile(env.SECRETS_KEY_PREVIOUS_FILE, false).raw;
  if (prev) {
    const k = parseKey(prev, 'SECRETS_KEY_PREVIOUS');
    if (typeof k !== 'string' && k.kid !== s.current?.kid) s.previous = k;
  }
  return s;
}

function keys(): KeyState {
  state ??= loadKeys();
  return state;
}

// Lê de novo as variáveis da chave (testes e troca de chave sem reiniciar).
export function reloadSecretsKey() {
  state = null;
  mismatch = false;
  checkedAt = 0;
  checking = null;
  generation++;
}

// detail: o problema com o caminho do arquivo e o erro do sistema, só para o log e para o papel admin.
export function keyInfo(): { source: 'env' | 'file' | 'none'; file?: string; created: boolean; previous: boolean; problem?: string; detail?: string } {
  const k = keys();
  return {
    source: k.source,
    ...(k.file ? { file: k.file } : {}),
    created: k.created,
    previous: !!k.previous,
    ...(k.problem ? { problem: k.problem } : {}),
    ...(k.detail ? { detail: k.detail } : {}),
  };
}

// Chave de 32 bytes derivada (HKDF) da chave atual para outro uso, como o nonce do OAuth. null sem chave.
export function derivedKey(label: string): Buffer | null {
  const k = keys().current;
  return k ? Buffer.from(crypto.hkdfSync('sha256', k.key, Buffer.alloc(0), `wescc-chat:${label}`, 32)) : null;
}

// ---------- Conferência da chave entre instâncias ----------

// O kid desta instância é comparado com o gravado pelas outras na subida (keyReady no onReady das rotas) e de novo a
// cada minuto, em qualquer instância, com ou sem o agendador (DISABLE_CRON=1). Quem grava um segredo espera a
// conferência; integrationsPaused() só a dispara, sem esperar.
function recheck(): Promise<void> {
  if (!checking) {
    triedAt = Date.now();
    const p: Promise<void> = checkSharedKey()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (checking === p) checking = null;
      });
    checking = p;
  }
  return checking;
}

export async function keyReady(): Promise<void> {
  autoCheck = true;
  if (!checkedAt || Date.now() - checkedAt >= RECHECK_MS) await recheck();
}

// Chave ausente ou com problema, ou diferente da das outras instâncias: nada das integrações roda.
export function integrationsPaused(): boolean {
  if (autoCheck && Date.now() - checkedAt >= RECHECK_MS && Date.now() - triedAt >= 5000) void recheck();
  return !keys().current || mismatch;
}

export function keyMismatch(): boolean {
  return mismatch;
}

function requireKey(): Key {
  const k = keys();
  if (!k.current) throw new ApiError(500, 'error-secret-key-missing', k.problem ?? MISSING);
  if (mismatch) throw new ApiError(500, 'error-secret-key', KEY_MISMATCH);
  return k.current;
}

// ---------- Cifra ----------

const b64 = (b: Buffer) => b.toString('base64url');

export function encryptSecret(plain: string, aad: string): string {
  const k = requireKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', k.kid, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}

export function decryptSecret(blob: string, aad: string): string {
  const parts = String(blob ?? '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new SecretKeyError();
  const ks = keys();
  const k = [ks.current, ks.previous].find((x) => x && x.kid === parts[1]);
  if (!k) throw new SecretKeyError();
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  // O Node aceita etiquetas de 4 a 16 bytes e confere só esse tanto: exigimos os 16 (e o IV de 12) que gravamos.
  if (iv.length !== 12 || tag.length !== 16) throw new SecretKeyError();
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k.key, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(parts[4], 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new SecretKeyError();
  }
}

// O administrador reconhece o segredo pelos 4 últimos caracteres; valores curtos não mostram nada.
export function secretHint(plain: string): string {
  return plain.length < 12 ? '••••' : `••••${plain.slice(-4)}`;
}

const kidOf = (blob: string | null | undefined) => (blob ? String(blob).split('.')[1] ?? null : null);

// Grava o kid da chave na primeira vez que um segredo é salvo (as outras instâncias comparam com ele).
async function rememberKid(kid: string) {
  await query(`INSERT INTO integration_state (id, data) VALUES ('secrets.kid', $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify({ kid })]);
}

// ---------- integration_secrets ----------

export async function getSecret(id: SecretId, boundTo?: string | null): Promise<string | null> {
  const row = await one('SELECT value, bound_to FROM integration_secrets WHERE id = $1', [id]);
  if (!row || (row.bound_to ?? null) !== (boundTo ?? null)) return null;
  return decryptSecret(row.value, aadFor.secret(id, row.bound_to));
}

export async function setSecret(id: SecretId, value: string | null, by: string | null, o: { expiresAt?: string | null; boundTo?: string | null } = {}): Promise<void> {
  const actor = by ? await one('SELECT id, username FROM users WHERE id = $1', [by]) : null;
  if (value === null || value === '') {
    const r = await query('DELETE FROM integration_secrets WHERE id = $1', [id]);
    if (r.rowCount) await audit({ id: actor?.id ?? null, username: actor?.username ?? null }, 'integration.secret.cleared', { id });
    return;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET) throw new ApiError(400, 'error-secret-too-large', 'O valor passa do tamanho máximo (8 KB).');
  await keyReady();
  const boundTo = o.boundTo ?? null;
  const blob = encryptSecret(value, aadFor.secret(id, boundTo));
  let expires: Date | null | undefined;
  if (o.expiresAt !== undefined) {
    expires = o.expiresAt ? new Date(o.expiresAt) : null;
    if (expires && Number.isNaN(expires.getTime())) throw new ApiError(400, 'error-invalid-params', 'Data de validade inválida.');
  }
  await query(
    `INSERT INTO integration_secrets (id, value, hint, bound_to, expires_at, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, hint = EXCLUDED.hint, bound_to = EXCLUDED.bound_to,
       expires_at = CASE WHEN $7 THEN EXCLUDED.expires_at ELSE integration_secrets.expires_at END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, blob, secretHint(value), boundTo, expires ?? null, actor?.id ?? null, expires !== undefined],
  );
  await rememberKid(kidOf(blob)!);
  await audit({ id: actor?.id ?? null, username: actor?.username ?? null }, 'integration.secret.set', { id });
}

export async function secretState(id: SecretId, boundTo?: string | null): Promise<SecretState> {
  const row = await one('SELECT value, hint, bound_to, expires_at, updated_at FROM integration_secrets WHERE id = $1', [id]);
  if (!row || (boundTo !== undefined && (row.bound_to ?? null) !== (boundTo ?? null))) return { set: false };
  const out: SecretState = {
    set: true,
    hint: row.hint ?? '••••',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
  try {
    decryptSecret(row.value, aadFor.secret(id, row.bound_to));
  } catch {
    out.unreadable = true;
  }
  return out;
}

// ---------- Várias instâncias ----------

// Na subida e de tempos em tempos: o kid desta instância é o mesmo gravado pelas outras?
export async function checkSharedKey(): Promise<{ ok: boolean }> {
  const k = keys();
  if (!k.current) {
    mismatch = false;
    checkedAt = Date.now();
    return { ok: false };
  }
  const gen = generation;
  const row = await one(`SELECT data FROM integration_state WHERE id = 'secrets.kid'`);
  const stored: string | undefined = row?.data?.kid;
  if (gen !== generation) return { ok: !stored || stored === k.current.kid };
  checkedAt = Date.now();
  if (!stored || stored === k.current.kid) {
    mismatch = false;
    return { ok: true };
  }
  // Troca de chave com SECRETS_KEY_PREVIOUS: esta instância já tem a nova e passa a ser a referência.
  if (k.previous && stored === k.previous.kid) {
    await query(`UPDATE integration_state SET data = $1, updated_at = now() WHERE id = 'secrets.kid'`, [JSON.stringify({ kid: k.current.kid })]);
    mismatch = false;
    return { ok: true };
  }
  mismatch = true;
  return { ok: false };
}

// Regrava tudo com a chave atual (o que abre com a atual ou com SECRETS_KEY_PREVIOUS). Numa instância cuja chave não é
// a das outras, recusa (500 error-secret-key): cifrar de novo ali tiraria os segredos das instâncias certas. Só com
// discardUnreadable (a chave antiga se perdeu de verdade, confirmado pelo administrador) a chave atual passa a ser a de
// referência; o que não abre fica ilegível e precisa ser cadastrado de novo.
export async function reencryptAll(o: { discardUnreadable?: boolean } = {}): Promise<{ count: number; unreadable: number }> {
  const k = keys();
  if (!k.current) throw new ApiError(500, 'error-secret-key-missing', k.problem ?? MISSING);
  const current = k.current;
  await checkSharedKey();
  if (mismatch && !o.discardUnreadable) throw new ApiError(500, 'error-secret-key', KEY_MISMATCH);
  let count = 0;
  let unreadable = 0;
  const redo = (blob: string | null, aad: string): string | null => {
    if (!blob || kidOf(blob) === current.kid) return null;
    try {
      const plain = decryptSecret(blob, aad);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', current.key, iv);
      c.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', current.kid, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
    } catch {
      unreadable++;
      return null;
    }
  };
  for (const r of await many('SELECT id, value, bound_to FROM integration_secrets')) {
    const v = redo(r.value, aadFor.secret(r.id, r.bound_to));
    if (v && (await query('UPDATE integration_secrets SET value = $2 WHERE id = $1 AND value = $3', [r.id, v, r.value])).rowCount) count++;
  }
  for (const r of await many('SELECT id, secret FROM integrations WHERE secret IS NOT NULL')) {
    const v = redo(r.secret, aadFor.rule(r.id));
    if (v && (await query('UPDATE integrations SET secret = $2 WHERE id = $1 AND secret = $3', [r.id, v, r.secret])).rowCount) count++;
  }
  for (const r of await many('SELECT user_id, provider, site, access_token, refresh_token FROM linked_accounts WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL')) {
    for (const field of ['access', 'refresh'] as const) {
      const col = field === 'access' ? 'access_token' : 'refresh_token';
      const v = redo(r[col], aadFor.linked(r.user_id, r.provider, field, r.site));
      if (v && (await query(`UPDATE linked_accounts SET ${col} = $3 WHERE user_id = $1 AND provider = $2 AND ${col} = $4`, [r.user_id, r.provider, v, r[col]])).rowCount) count++;
    }
  }
  for (const r of await many('SELECT id, access_token, refresh_token FROM calendar_accounts WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL')) {
    for (const field of ['access', 'refresh'] as const) {
      const col = field === 'access' ? 'access_token' : 'refresh_token';
      const v = redo(r[col], aadFor.calendar(r.id, field));
      if (v && (await query(`UPDATE calendar_accounts SET ${col} = $2 WHERE id = $1 AND ${col} = $3`, [r.id, v, r[col]])).rowCount) count++;
    }
  }
  for (const r of await many('SELECT state_hash, code_verifier FROM integration_oauth_states WHERE code_verifier IS NOT NULL')) {
    const v = redo(r.code_verifier, aadFor.oauth(r.state_hash));
    if (v && (await query('UPDATE integration_oauth_states SET code_verifier = $2 WHERE state_hash = $1 AND code_verifier = $3', [r.state_hash, v, r.code_verifier])).rowCount) count++;
  }
  if (mismatch) {
    // Descarte confirmado: a chave desta instância passa a ser a de referência.
    await query(
      `INSERT INTO integration_state (id, data) VALUES ('secrets.kid', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify({ kid: current.kid })],
    );
    mismatch = false;
  } else await rememberKid(current.kid);
  return { count, unreadable };
}

// Para quem grava segredos fora de integration_secrets (regras, contas vinculadas), antes de gravar: confere a chave
// com a das outras instâncias (recusa se for diferente) e anota o kid na primeira vez.
export async function noteKeyUse(blob: string) {
  await keyReady();
  if (mismatch) throw new ApiError(500, 'error-secret-key', KEY_MISMATCH);
  const kid = kidOf(blob);
  if (kid) await rememberKid(kid);
}
