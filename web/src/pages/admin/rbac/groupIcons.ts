import type { IconName } from '../../../components/icons';

// Ícone de cada grupo do catálogo (shared/rbac.ts RBAC_GROUPS). Grupo novo sem ícone aqui não pode derrubar a tela:
// groupIcon cai num ícone neutro, e o teste em server/test/web-rules.test.ts cobra a entrada de cada grupo.
export const GROUP_ICON: Record<string, IconName> = {
  chat: 'rbac-chat',
  room: 'rbac-room',
  admin: 'rbac-admin',
  files: 'nav-files',
  technical: 'rbac-technical',
};

export const groupIcon = (id: string): IconName => GROUP_ICON[id] ?? 'rbac-admin';
