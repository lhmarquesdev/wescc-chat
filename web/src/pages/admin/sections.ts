// Seções da Administração e quem vê cada uma (a navegação da AdminPage e o item "Administração" do menu do usuário
// saem desta lista, para não divergirem quando entra uma seção nova). Sem React: os testes do servidor importam direto
// (server/test/web-rules.test.ts).
import type { IconName } from '../../components/icons';

export interface AdminSection {
  id: string;
  icon: IconName;
  label: string;
  perm: string[];
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: 'info', icon: 'admin-info', label: 'Informações', perm: ['view-statistics'] },
  { id: 'engagement', icon: 'admin-engagement', label: 'Engajamento', perm: ['view-engagement-dashboard'] },
  { id: 'users', icon: 'admin-users', label: 'Usuários', perm: ['view-user-administration'] },
  { id: 'rooms', icon: 'room-channel', label: 'Salas', perm: ['view-room-administration'] },
  { id: 'permissions', icon: 'admin-permissions', label: 'Papéis e permissões', perm: ['view-permissions', 'access-permissions', 'manage-roles'] },
  { id: 'devices', icon: 'devices', label: 'Dispositivos', perm: ['view-device-management'] },
  { id: 'audit', icon: 'admin-audit', label: 'Auditoria', perm: ['can-audit', 'can-audit-log'] },
  { id: 'moderation', icon: 'report', label: 'Moderação', perm: ['view-moderation-console'] },
  // Integrações (Jira/Teams): quem configura o Jira ou o Teams também vê o item
  { id: 'integrations', icon: 'admin-integrations', label: 'Integrações', perm: ['manage-integrations', 'manage-own-integrations', 'manage-jira', 'manage-msteams'] },
  { id: 'oauth', icon: 'tokens', label: 'OAuth', perm: ['manage-oauth-apps'] },
  { id: 'omnichannel', icon: 'nav-omnichannel', label: 'Atendimento', perm: ['view-livechat-manager'] },
  { id: 'emoji', icon: 'emoji', label: 'Emojis', perm: ['manage-emoji'] },
  // Figurinhas: curadoria (gestores) e removidas (moderação).
  { id: 'stickers', icon: 'sticker', label: 'Figurinhas', perm: ['manage-sticker-packs', 'view-moderation-console', 'manage-moderation-actions'] },
  { id: 'invites', icon: 'panel-invite', label: 'Convites', perm: ['view-room-administration'] },
  { id: 'import', icon: 'admin-import', label: 'Importação', perm: ['run-import', 'view-import-operations'] },
  { id: 'ldap', icon: 'admin-ldap', label: 'LDAP / AD', perm: ['view-privileged-setting'] },
  // Chamadas em grupo: servidor de chamadas, HTTPS e chamadas em andamento.
  { id: 'calls', icon: 'call-audio', label: 'Chamadas', perm: ['manage-calls'] },
  { id: 'settings', icon: 'admin', label: 'Configurações', perm: ['view-privileged-setting'] },
];

// O item "Administração" do menu do usuário: quem abre alguma seção (quem só administra chamadas, só o Jira/Teams ou
// só figurinhas também), mais view-administration, que já abria o menu. A AdminPage leva à primeira seção que a pessoa vê.
export const ADMIN_MENU_PERMS: string[] = [...new Set(['view-administration', ...ADMIN_SECTIONS.flatMap((s) => s.perm)])];

// Botões "Configurações" das seções: abrem Administração › Configurações direto no grupo onde ficam as opções delas
// (AdminSettings lê o ?group=).
export const SETTINGS_GROUP = { stickers: 'Message', calls: 'VideoConf' } as const;
export const settingsPath = (group: string) => `/admin/settings?group=${encodeURIComponent(group)}`;
