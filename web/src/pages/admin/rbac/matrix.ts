// Regras da Matriz de permissões (sem React, testadas em server/test/web-rules.test.ts): quais papéis entram por
// padrão, o que mudou em cada papel, quando uma linha difere, por que uma célula está travada e o estado na URL.
import { isRoomChecked, LOCK_TEXT, ROOT_KEEP, type LockReason, type RoleScope } from '@shared/rbac';

export interface RbacRoleLite {
  _id: string;
  scope: RoleScope;
  root?: boolean;
  protected?: boolean;
  users: number;
}

export interface GrantLite {
  root: boolean;
  held: string[];
  roleLocks: Record<string, LockReason>;
}

export interface MatrixQuery {
  roles: string[];
  group: string;
  q: string;
  diff: boolean;
  sens: boolean;
}

export type CellState = 'on' | 'off' | 'inert' | 'locked';

// Colunas na tela.
export const MATRIX_MAX = 12;
// Colunas sem ?roles: o Administrador, os personalizados, os do sistema globais com gente e os de sala principais.
export const MATRIX_DEFAULT = 8;
const ROOM_DEFAULTS = ['owner', 'moderator', 'publisher'];

export function defaultColumns(roles: RbacRoleLite[]): string[] {
  const out: string[] = [];
  const push = (id: string) => !out.includes(id) && out.push(id);
  roles.filter((r) => r.root).forEach((r) => push(r._id));
  roles.filter((r) => !r.root && !r.protected).forEach((r) => push(r._id));
  roles.filter((r) => !r.root && r.protected && r.scope === 'Users' && r.users > 0).forEach((r) => push(r._id));
  ROOM_DEFAULTS.filter((id) => roles.some((r) => r._id === id)).forEach(push);
  return out.slice(0, MATRIX_DEFAULT);
}

// O que entra e sai de cada papel, na ordem das colunas. Papel sem mudança fica de fora.
export function matrixChanges(initial: Record<string, string[]>, draft: Record<string, Set<string>>): { roleId: string; add: string[]; remove: string[] }[] {
  const out: { roleId: string; add: string[]; remove: string[] }[] = [];
  for (const [roleId, now] of Object.entries(draft)) {
    const before = new Set(initial[roleId] ?? []);
    const add = [...now].filter((k) => !before.has(k)).sort();
    const remove = [...before].filter((k) => !now.has(k)).sort();
    if (add.length || remove.length) out.push({ roleId, add, remove });
  }
  return out;
}

// Linha com diferença: entre os papéis mostrados, alguns têm a permissão e outros não.
export function differs(key: string, roleIds: string[], perms: Record<string, Set<string>>): boolean {
  if (roleIds.length < 2) return false;
  const first = !!perms[roleIds[0]]?.has(key);
  return roleIds.some((id) => !!perms[id]?.has(key) !== first);
}

// Por que a célula não muda (null = muda). As mesmas travas do servidor, na mesma ordem.
export function cellLock(key: string, role: { _id: string; root?: boolean }, grant: GrantLite, canEdit: boolean): string | null {
  if (!canEdit) return 'Você pode ver, mas não alterar permissões.';
  const lock = grant.roleLocks[role._id];
  if (lock) return LOCK_TEXT[lock];
  if (role.root && ROOT_KEEP.includes(key)) return 'O Administrador sempre gerencia papéis.';
  if (!grant.root && !grant.held.includes(key)) return 'Você não tem esta permissão, então não pode dá-la nem tirá-la.';
  return null;
}

// Papel de sala numa permissão que não é checada nas salas: marcar ou não dá no mesmo.
export function cellState(key: string, role: RbacRoleLite, perms: Set<string>, lock: string | null): CellState {
  if (role.scope === 'Subscriptions' && !isRoomChecked(key)) return 'inert';
  if (lock) return 'locked';
  return perms.has(key) ? 'on' : 'off';
}

export function parseMatrixQuery(search: string): MatrixQuery {
  const p = new URLSearchParams(search);
  return {
    roles: (p.get('roles') ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    group: p.get('group') || 'all',
    q: p.get('q') ?? '',
    diff: p.get('diff') === '1',
    sens: p.get('sens') === '1',
  };
}

// Só o que foge do padrão, com as vírgulas de roles legíveis (?roles=a,b&diff=1).
export function matrixQuery(q: MatrixQuery): string {
  const parts: string[] = [];
  if (q.roles.length) parts.push(`roles=${q.roles.map(encodeURIComponent).join(',')}`);
  if (q.group && q.group !== 'all') parts.push(`group=${encodeURIComponent(q.group)}`);
  if (q.q) parts.push(`q=${encodeURIComponent(q.q)}`);
  if (q.diff) parts.push('diff=1');
  if (q.sens) parts.push('sens=1');
  return parts.length ? `?${parts.join('&')}` : '';
}
