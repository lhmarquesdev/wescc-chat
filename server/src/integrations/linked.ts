import type { LinkedAccount } from '@shared/integrations';
import { many, one, query } from '../db/pool';
import { ApiError } from '../lib/errors';
import { aadFor, decryptSecret, encryptSecret, noteKeyUse } from '../lib/secrets';
import { audit } from '../services/audit';
import { clearAlert, raiseAlert } from './alerts';
import { publishChanged } from './state';

// Contas externas de cada pessoa (Jira e Microsoft 365). Tokens cifrados; nunca saem pela API.

export interface LinkedRow {
  userId: string;
  provider: 'jira' | 'microsoft';
  method: 'token' | 'oauth' | 'directory';
  externalId: string;
  displayName: string;
  email: string | null;
  site: string | null;
  tokenExpiresAt: Date | null;
  secretExpiresAt: Date | null;
  scopes: string[];
  meta: any;
  status: 'ok' | 'expired' | 'error';
  statusText: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
}

const SITE_CHANGED = 'O endereço do Jira mudou. Conecte sua conta de novo.';
const UNREADABLE = 'Não foi possível ler o token guardado (a chave de segredos mudou). Conecte sua conta de novo.';
const RECONNECT_JIRA = 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.';

const toDate = (v: unknown) => (v ? new Date(v as string) : null);

function mapRow(r: any): LinkedRow {
  return {
    userId: r.user_id,
    provider: r.provider,
    method: r.method,
    externalId: r.external_id,
    displayName: r.display_name ?? '',
    email: r.email ?? null,
    site: r.site ?? null,
    tokenExpiresAt: toDate(r.token_expires_at),
    secretExpiresAt: toDate(r.secret_expires_at),
    scopes: r.scopes ?? [],
    meta: r.meta ?? {},
    status: r.status,
    statusText: r.status_text ?? null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  };
}

export async function getLinked(userId: string, provider: LinkedRow['provider']): Promise<LinkedRow | null> {
  const r = await one('SELECT * FROM linked_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
  return r ? mapRow(r) : null;
}

export async function listLinked(userId: string): Promise<LinkedRow[]> {
  return (await many('SELECT * FROM linked_accounts WHERE user_id = $1 ORDER BY provider', [userId])).map(mapRow);
}

// jira: origin = origem atual do Jira (entra no AAD). Outra origem → a conta expira e nada é devolvido.
export async function linkedSecrets(userId: string, provider: LinkedRow['provider'], origin?: string | null): Promise<{ access: string | null; refresh: string | null }> {
  const r = await one('SELECT site, access_token, refresh_token FROM linked_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
  if (!r) return { access: null, refresh: null };
  if (provider === 'jira' && origin !== undefined && (r.site ?? null) !== (origin ?? null)) {
    await setLinkedStatus(userId, provider, 'expired', SITE_CHANGED);
    return { access: null, refresh: null };
  }
  try {
    return {
      access: r.access_token ? decryptSecret(r.access_token, aadFor.linked(userId, provider, 'access', r.site)) : null,
      refresh: r.refresh_token ? decryptSecret(r.refresh_token, aadFor.linked(userId, provider, 'refresh', r.site)) : null,
    };
  } catch {
    await setLinkedStatus(userId, provider, 'error', UNREADABLE);
    return { access: null, refresh: null };
  }
}

async function actorFor(userId: string) {
  const u = await one('SELECT id, username FROM users WHERE id = $1', [userId]);
  return { id: u?.id ?? userId, username: u?.username ?? null };
}

// Cifra e grava. access/refresh undefined: mantém o que já está guardado. 409 se a conta externa já é de outra pessoa.
export async function saveLinked(row: Omit<LinkedRow, 'status' | 'statusText'> & { access?: string | null; refresh?: string | null }): Promise<void> {
  const prev = await one('SELECT * FROM linked_accounts WHERE user_id = $1 AND provider = $2', [row.userId, row.provider]);
  const site = row.site ?? null;
  const field = async (name: 'access' | 'refresh', given: string | null | undefined): Promise<{ keep: boolean; blob: string | null; dropped: boolean }> => {
    const col = name === 'access' ? 'access_token' : 'refresh_token';
    if (given === undefined) {
      if (!prev?.[col] || (prev.site ?? null) === site) return { keep: true, blob: null, dropped: false };
      // Outra origem sem token novo: o token guardado foi dado para o site antigo e não vai para o novo.
      return { keep: false, blob: null, dropped: true };
    }
    if (!given) return { keep: false, blob: null, dropped: false };
    const blob = encryptSecret(given, aadFor.linked(row.userId, row.provider, name, site));
    await noteKeyUse(blob);
    return { keep: false, blob, dropped: false };
  };
  const access = await field('access', row.access);
  const refresh = await field('refresh', row.refresh);
  const siteChanged = access.dropped && !access.blob;
  const status = siteChanged ? 'expired' : 'ok';
  const statusText = siteChanged ? SITE_CHANGED : null;
  try {
    await query(
      `INSERT INTO linked_accounts (user_id, provider, method, external_id, display_name, email, site, access_token, refresh_token,
         token_expires_at, secret_expires_at, scopes, meta, status, status_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $16, $17, now())
       ON CONFLICT (user_id, provider) DO UPDATE SET
         method = EXCLUDED.method, external_id = EXCLUDED.external_id, display_name = EXCLUDED.display_name, email = EXCLUDED.email,
         site = EXCLUDED.site,
         access_token = CASE WHEN $14 THEN linked_accounts.access_token ELSE EXCLUDED.access_token END,
         refresh_token = CASE WHEN $15 THEN linked_accounts.refresh_token ELSE EXCLUDED.refresh_token END,
         token_expires_at = EXCLUDED.token_expires_at, secret_expires_at = EXCLUDED.secret_expires_at, scopes = EXCLUDED.scopes,
         meta = EXCLUDED.meta, status = EXCLUDED.status, status_text = EXCLUDED.status_text, updated_at = now()`,
      [
        row.userId,
        row.provider,
        row.method,
        row.externalId,
        row.displayName ?? '',
        row.email ?? null,
        site,
        access.blob,
        refresh.blob,
        row.tokenExpiresAt ?? null,
        row.secretExpiresAt ?? null,
        row.scopes ?? [],
        JSON.stringify(row.meta ?? {}),
        access.keep,
        refresh.keep,
        status,
        statusText,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ApiError(409, 'error-linked-elsewhere', 'Esta conta já está conectada a outra pessoa do chat. Peça para ela desconectar ou fale com o administrador.');
    }
    throw e;
  }
  if (!prev || prev.external_id !== row.externalId || prev.method !== row.method) {
    await audit(await actorFor(row.userId), 'integration.linked.added', { userId: row.userId }, { provider: row.provider, method: row.method, displayName: row.displayName });
  }
  if (row.provider === 'jira') await clearAlert(`jira.linked:${row.userId}`);
  publishChanged('account', row.userId);
}

export async function setLinkedStatus(userId: string, provider: LinkedRow['provider'], status: LinkedRow['status'], text?: string | null): Promise<void> {
  const r = await one(
    `UPDATE linked_accounts SET status = $3, status_text = $4, updated_at = now()
     WHERE user_id = $1 AND provider = $2 AND (status <> $3 OR status_text IS DISTINCT FROM $4)
     RETURNING user_id`,
    [userId, provider, status, status === 'ok' ? null : (text ?? null)],
  );
  if (!r) return;
  if (provider === 'jira') {
    if (status === 'expired') {
      await raiseAlert({ key: `jira.linked:${userId}`, provider: 'jira', tone: 'warn', text: RECONNECT_JIRA, href: '/account/connected', to: { userId } }).catch(() => {});
    } else if (status === 'ok') {
      await clearAlert(`jira.linked:${userId}`);
    }
  }
  publishChanged('account', userId);
}

// Troca de site do Jira: todas as contas pessoais precisam ser conectadas de novo.
export async function expireAllLinked(provider: 'jira', text: string): Promise<number> {
  const rows = await many(
    `UPDATE linked_accounts SET status = 'expired', status_text = $2, access_token = NULL, refresh_token = NULL, updated_at = now()
     WHERE provider = $1 RETURNING user_id`,
    [provider, text],
  );
  for (const r of rows) {
    await raiseAlert({ key: `jira.linked:${r.user_id}`, provider: 'jira', tone: 'warn', text: RECONNECT_JIRA, href: '/account/connected', to: { userId: r.user_id } }).catch(() => {});
    publishChanged('account', r.user_id);
  }
  return rows.length;
}

// last_used_at, no máximo uma escrita por minuto.
export async function touchLinked(userId: string, provider: LinkedRow['provider']): Promise<void> {
  await query(
    `UPDATE linked_accounts SET last_used_at = now()
     WHERE user_id = $1 AND provider = $2 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [userId, provider],
  );
}

export async function removeLinked(userId: string, provider: LinkedRow['provider']): Promise<void> {
  const r = await one('DELETE FROM linked_accounts WHERE user_id = $1 AND provider = $2 RETURNING method, display_name', [userId, provider]);
  if (!r) return;
  await audit(await actorFor(userId), 'integration.linked.removed', { userId }, { provider, method: r.method, displayName: r.display_name });
  if (provider === 'jira') await clearAlert(`jira.linked:${userId}`);
  publishChanged('account', userId);
}

// Junta campos em meta (por exemplo busySync da conta Microsoft).
export async function setLinkedMeta(userId: string, provider: LinkedRow['provider'], patch: Record<string, unknown>): Promise<LinkedRow | null> {
  const r = await one(
    `UPDATE linked_accounts SET meta = meta || $3::jsonb, updated_at = now() WHERE user_id = $1 AND provider = $2 RETURNING *`,
    [userId, provider, JSON.stringify(patch)],
  );
  if (!r) return null;
  publishChanged('account', userId);
  return mapRow(r);
}

export async function userForExternal(provider: LinkedRow['provider'], externalId: string): Promise<{ id: string; username: string } | null> {
  const r = await one(
    `SELECT u.id, u.username FROM linked_accounts l JOIN users u ON u.id = l.user_id
     WHERE l.provider = $1 AND l.external_id = $2 AND u.active`,
    [provider, externalId],
  );
  return r ? { id: r.id, username: r.username } : null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function mapLinked(row: LinkedRow): LinkedAccount {
  return {
    provider: row.provider,
    method: row.method,
    displayName: row.displayName,
    email: row.email,
    site: row.site,
    status: row.status,
    statusText: row.statusText,
    secretExpiresAt: iso(row.secretExpiresAt),
    lastUsedAt: iso(row.lastUsedAt ?? null),
    createdAt: iso(row.createdAt ?? null) ?? new Date(0).toISOString(),
    ...(row.provider === 'microsoft' ? { busySync: row.meta?.busySync === true } : {}),
  };
}
