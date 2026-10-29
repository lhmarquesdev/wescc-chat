// Dados de Papéis e permissões: papéis com as permissões, o contexto de concessão (o que o ator pode mexer) e as
// mensagens de erro da hierarquia em português com os nomes das permissões e dos papéis.
import type { Role } from '@shared/index';
import { LOCK_TEXT, rbacLabel, type LockReason } from '@shared/rbac';
import { ApiError, api, errorMessage } from '../../../lib/api';
import { nameList, roleLabel, setRoleDescriptions } from '../../../lib/format';
import { useStore } from '../../../lib/store';

export interface RbacRole extends Role {
  permissions: string[];
  users: number;
  activeUsers: number;
}

export interface Grant {
  userId: string;
  root: boolean;
  held: string[];
  ownRoles: string[];
  delegated: string[];
  roleLocks: Record<string, LockReason>;
  deleteLocks: Record<string, LockReason>;
  canEditPermissions: boolean;
  canEditRoles: boolean;
  canAssignRoles: boolean;
  canAssignAdmin: boolean;
}

export const loadRoles = () =>
  api.get('rbac.roles').then((r) => {
    setRoleDescriptions(r.roles);
    return r.roles as RbacRole[];
  });

export const loadGrant = () => api.get('rbac.grantContext') as Promise<Grant>;

export const lockText = (l: LockReason | 'self' | undefined | null) => (l ? LOCK_TEXT[l] : '');

// O servidor manda o código e as chaves: a mensagem diz quais permissões ou papéis travaram, pelo nome.
export function rbacError(e: unknown) {
  if (e instanceof ApiError && e.details) {
    const keys: string[] | undefined = e.details.keys;
    const roles: string[] | undefined = e.details.roles;
    if (keys?.length) return `${e.message} (${nameList(keys.map(rbacLabel), 4)})`;
    if (roles?.length) return `${e.message.replace(/:.*$/, '')}: ${nameList(roles.map(roleLabel), 4)}.`;
  }
  return errorMessage(e);
}

export const rbacFail = (e: unknown) => useStore.getState().toast(rbacError(e), 'error');
export const rbacOk = (t: string) => useStore.getState().toast(t);

export const people = (n: number) => `${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;
