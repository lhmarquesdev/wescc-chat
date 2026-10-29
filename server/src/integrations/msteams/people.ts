// Conta Microsoft 365 de cada pessoa pelo e-mail confirmado do chat (D30): só e-mails com email_verified, busca por
// mail ou UPN com exatamente um resultado; o cache cai quando o e-mail do chat muda.
import { one, query } from '../../db/pool';
import { ApiError, badRequest } from '../../lib/errors';
import { getLinked, saveLinked, type LinkedRow } from '../linked';
import { getState, setState } from '../state';
import { safeExternalText } from '../text';
import { safeName } from './html';
import { graph, odataQuote } from './graph';

export const PEOPLE_TEXT = {
  unverified: 'Seu e-mail no chat não foi confirmado pelo administrador. Peça para conferir antes de criar reuniões.',
  noAccount: (email: string) =>
    `Não encontramos sua conta do Microsoft 365 pelo e-mail ${email}. Peça ao administrador para conferir o e-mail no chat e no Microsoft 365.`,
};

const HIT_MS = 7 * 86_400_000;
const MISS_MS = 86_400_000;

export interface MsPerson {
  userId: string;
  id: string; // id (oid) do usuário no Entra
  upn: string;
  displayName: string;
  email: string;
}

const missKey = (userId: string) => `msteams.people.miss:${userId}`;
const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();

const unverified = () => new ApiError(403, 'error-msteams-email-unverified', PEOPLE_TEXT.unverified);
const noAccount = (email: string) => badRequest('error-msteams-no-account', PEOPLE_TEXT.noAccount(email));

function fromRow(row: LinkedRow, email: string): MsPerson {
  return { userId: row.userId, id: row.externalId, upn: String(row.meta?.upn ?? ''), displayName: row.displayName, email };
}

// O id do Entra já está guardado para outra pessoa: se o e-mail dela no chat mudou, a linha antiga não vale mais.
async function freeStaleOwner(externalId: string, userId: string): Promise<boolean> {
  const other = await one(
    `SELECT l.user_id, l.email AS linked_email, u.email AS user_email, u.email_verified FROM linked_accounts l JOIN users u ON u.id = l.user_id
     WHERE l.provider = 'microsoft' AND l.external_id = $1 AND l.user_id <> $2`,
    [externalId, userId],
  );
  if (!other) return false;
  if (other.email_verified === true && lower(other.user_email) === lower(other.linked_email)) return false;
  await query(`DELETE FROM linked_accounts WHERE user_id = $1 AND provider = 'microsoft'`, [other.user_id]);
  return true;
}

// Erros: error-msteams-email-unverified (403) sem nenhuma chamada ao Graph; error-msteams-no-account (400); os do Graph.
export async function lookup(userId: string, o: { interactive?: boolean } = {}): Promise<MsPerson> {
  const user = await one(`SELECT id, email, email_verified FROM users WHERE id = $1`, [userId]);
  const email = lower(user?.email);
  if (!user || user.email_verified !== true || !email) throw unverified();

  const cached = await getLinked(userId, 'microsoft');
  if (cached && cached.method === 'directory') {
    if (lower(cached.email) !== email) {
      // O e-mail do chat mudou: a conta encontrada antes pode ser de outra pessoa.
      await query(`DELETE FROM linked_accounts WHERE user_id = $1 AND provider = 'microsoft'`, [userId]);
    } else {
      const at = Date.parse(String(cached.meta?.lookedUpAt ?? ''));
      if (Number.isFinite(at) && Date.now() - at < HIT_MS) return fromRow(cached, email);
    }
  }
  const miss = await getState<{ email: string; at: string }>(missKey(userId));
  if (miss && miss.email === email && Date.now() - Date.parse(miss.at) < MISS_MS) throw noAccount(email);

  const filter = `mail eq ${odataQuote(email)} or userPrincipalName eq ${odataQuote(email)}`;
  const r = await graph<any>('app', 'GET', `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName`, undefined, {
    interactive: o.interactive !== false,
    permission: 'User.Read.All',
  });
  const found: any[] = Array.isArray(r?.value) ? r.value : [];
  if (found.length !== 1 || !found[0]?.id) {
    await setState(missKey(userId), { email, at: new Date().toISOString() });
    throw noAccount(email);
  }
  const u = found[0];
  const keep = cached && cached.method === 'directory' && lower(cached.email) === email ? cached.meta ?? {} : {};
  const row = {
    userId,
    provider: 'microsoft' as const,
    method: 'directory' as const,
    externalId: String(u.id),
    displayName: safeName(u.displayName, safeExternalText, 200),
    email,
    site: null,
    tokenExpiresAt: null,
    secretExpiresAt: null,
    scopes: [],
    meta: { ...keep, upn: String(u.userPrincipalName ?? u.mail ?? email), lookedUpAt: new Date().toISOString() },
  };
  try {
    await saveLinked(row);
  } catch (e) {
    if (!(e instanceof ApiError && e.statusCode === 409) || !(await freeStaleOwner(row.externalId, userId))) throw e;
    await saveLinked(row);
  }
  await setState(missKey(userId), null);
  return { userId, id: row.externalId, upn: row.meta.upn, displayName: row.displayName, email };
}

// Para outras pessoas (convidados de "Agendar no Teams", presença): sem e-mail confirmado ou sem conta → null.
export async function lookupQuiet(userId: string, o: { interactive?: boolean } = {}): Promise<MsPerson | null> {
  try {
    return await lookup(userId, o);
  } catch (e) {
    if (e instanceof ApiError && ['error-msteams-email-unverified', 'error-msteams-no-account', 'error-linked-elsewhere'].includes(e.errorType)) return null;
    throw e;
  }
}
