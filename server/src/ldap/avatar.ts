import { createHash } from 'node:crypto';
import type { Entry } from 'ldapts';
import { query } from '../db/pool';
import { resetAvatar, setAvatar } from '../services/users';
import { entryValues } from './client';
import type { LdapConfig } from './config';

// Foto do diretório (thumbnailPhoto / jpegPhoto) como avatar, sem passar por cima da foto que a pessoa escolheu.

export function detectImageType(buf: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

// Primeiro Buffer não vazio entre os atributos de foto.
export function photoOf(entry: Entry, cfg: LdapConfig): Buffer | null {
  for (const name of cfg.avatarFields) {
    const v = entryValues(entry, name).find((x) => Buffer.isBuffer(x) && x.length);
    if (v) return v as Buffer;
  }
  return null;
}

export const photoHash = (photo: Buffer) => createHash('sha256').update(photo).digest('hex');

export function photoDataUrl(photo: Buffer | null, max = 200 * 1024): string | undefined {
  const type = photo && detectImageType(photo);
  if (!photo || !type || photo.length > max) return undefined;
  return `data:${type};base64,${photo.toString('base64')}`;
}

interface AvatarState {
  username?: string;
  avatar_etag?: string | null;
  ldap_avatar_hash?: string | null;
  ldap_avatar_etag?: string | null;
}

export type AvatarPlan =
  | { action: 'apply'; type: 'image/jpeg' | 'image/png'; hash: string }
  | { action: 'reset' }
  | { action: 'none'; warning?: string };

// Aplica quando a foto mudou e o avatar atual não é escolha da pessoa (nenhum, ou o que veio do LDAP).
export function planLdapAvatar(user: AvatarState | null, photo: Buffer | null): AvatarPlan {
  const ldapIsCurrent = !!user?.ldap_avatar_etag && user.avatar_etag === user.ldap_avatar_etag;
  if (!photo) return ldapIsCurrent ? { action: 'reset' } : { action: 'none' };
  const type = detectImageType(photo);
  if (!type) return { action: 'none', warning: `Foto de @${user?.username ?? '?'} ignorada: o diretório não mandou um JPEG nem um PNG.` };
  const hash = photoHash(photo);
  if (hash === user?.ldap_avatar_hash) return { action: 'none' };
  if (user?.avatar_etag && !ldapIsCurrent) return { action: 'none' };
  return { action: 'apply', type, hash };
}

export async function applyLdapAvatar(user: AvatarState & { id: string }, photo: Buffer | null): Promise<{ result: 'applied' | 'removed' | null; warning?: string }> {
  const plan = planLdapAvatar(user, photo);
  if (plan.action === 'apply' && photo) {
    const etag = await setAvatar(user.id, plan.type, photo);
    await query('UPDATE users SET ldap_avatar_hash = $2, ldap_avatar_etag = $3 WHERE id = $1', [user.id, plan.hash, etag]);
    return { result: 'applied' };
  }
  if (plan.action === 'reset') {
    await resetAvatar(user.id);
    await query('UPDATE users SET ldap_avatar_hash = NULL, ldap_avatar_etag = NULL WHERE id = $1', [user.id]);
    return { result: 'removed' };
  }
  return { result: null, warning: plan.action === 'none' ? plan.warning : undefined };
}
