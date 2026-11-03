// Sem React nem API (testado em server/test/web-rules.test.ts).
import type { LockReason } from '@shared/rbac';

// Trava de uma pessoa para o ator (Usuários, lote, editor): o administrador não tem trava; a própria pessoa não muda
// os próprios papéis; senão vale a primeira trava entre os papéis globais dela (o mesmo que o servidor checa).
export function userLockOf(grant: { root: boolean; roleLocks: Record<string, LockReason> }, me: string, user: { _id: string; roles?: string[] }): LockReason | 'self' {
  if (grant.root) return null;
  if (user._id === me) return 'self';
  for (const r of user.roles ?? []) {
    const l = grant.roleLocks[r];
    if (l) return l;
  }
  return null;
}
