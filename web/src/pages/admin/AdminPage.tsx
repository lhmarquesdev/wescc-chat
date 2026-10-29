import { NavLink, useParams } from 'react-router-dom';
import { usePermission } from '../../lib/store';
import { Icon, type IconName } from '../../components/Icon';
import { SideFoot, TakeoverBack, TakeoverHead } from '../../components/Sidebar';
import { AdminInfo } from './AdminInfo';
import { AdminUsers } from './AdminUsers';
import { AdminRooms } from './AdminRooms';
import { AdminPermissions } from './AdminPermissions';
import { AdminSettings } from './AdminSettings';
import { AdminEngagement } from './AdminEngagement';
import { AdminAudit } from './AdminAudit';
import { AdminDevices, AdminEmoji, AdminInvites, AdminModeration } from './AdminMisc';
import { AdminIntegrations } from './AdminIntegrations';
import { AdminOAuth } from './AdminOAuth';
import { AdminOmnichannel } from './AdminOmnichannel';
import { AdminImport } from './import';
import { AdminLdap } from './ldap';
// Chamadas em grupo: Administração › Chamadas.
import { AdminCalls } from './calls/AdminCalls';
import { useActiveNavInView } from './parts';

export function AdminPage() {
  const { section = 'info' } = useParams();
  const navRef = useActiveNavInView(section);
  const items: { id: string; icon: IconName; label: string; perm: string[] }[] = [
    { id: 'info', icon: 'admin-info', label: 'Informações', perm: ['view-statistics'] },
    { id: 'engagement', icon: 'admin-engagement', label: 'Engajamento', perm: ['view-engagement-dashboard'] },
    { id: 'users', icon: 'admin-users', label: 'Usuários', perm: ['view-user-administration'] },
    { id: 'rooms', icon: 'room-channel', label: 'Salas', perm: ['view-room-administration'] },
    { id: 'permissions', icon: 'admin-permissions', label: 'Papéis e permissões', perm: ['access-permissions'] },
    { id: 'devices', icon: 'devices', label: 'Dispositivos', perm: ['view-device-management'] },
    { id: 'audit', icon: 'admin-audit', label: 'Auditoria', perm: ['can-audit', 'can-audit-log'] },
    { id: 'moderation', icon: 'report', label: 'Moderação', perm: ['view-moderation-console'] },
    { id: 'integrations', icon: 'admin-integrations', label: 'Integrações', perm: ['manage-integrations', 'manage-own-integrations'] },
    { id: 'oauth', icon: 'tokens', label: 'OAuth', perm: ['manage-oauth-apps'] },
    { id: 'omnichannel', icon: 'nav-omnichannel', label: 'Atendimento', perm: ['view-livechat-manager'] },
    { id: 'emoji', icon: 'emoji', label: 'Emojis', perm: ['manage-emoji'] },
    { id: 'invites', icon: 'panel-invite', label: 'Convites', perm: ['view-room-administration'] },
    { id: 'import', icon: 'admin-import', label: 'Importação', perm: ['run-import', 'view-import-operations'] },
    { id: 'ldap', icon: 'admin-ldap', label: 'LDAP / AD', perm: ['view-privileged-setting'] },
    // Chamadas em grupo: servidor de chamadas, HTTPS e chamadas em andamento.
    { id: 'calls', icon: 'call-audio', label: 'Chamadas', perm: ['manage-calls'] },
    { id: 'settings', icon: 'admin', label: 'Configurações', perm: ['view-privileged-setting'] },
  ];
  return (
    <div className="page with-nav takeover admin-page">
      <TakeoverHead title="Administração" />
      <nav className="page-nav" aria-label="Administração" ref={navRef}>
        <TakeoverBack />
        <h2>Administração</h2>
        {items.map((i) => (
          <AdminLink key={i.id} id={i.id} icon={i.icon} label={i.label} perm={i.perm} />
        ))}
        <SideFoot />
      </nav>
      <div className="page-body">
        {section === 'info' && <AdminInfo />}
        {section === 'engagement' && <AdminEngagement />}
        {section === 'users' && <AdminUsers />}
        {section === 'rooms' && <AdminRooms />}
        {section === 'permissions' && <AdminPermissions />}
        {section === 'devices' && <AdminDevices />}
        {section === 'audit' && <AdminAudit />}
        {section === 'moderation' && <AdminModeration />}
        {section === 'integrations' && <AdminIntegrations />}
        {section === 'oauth' && <AdminOAuth />}
        {section === 'omnichannel' && <AdminOmnichannel />}
        {section === 'emoji' && <AdminEmoji />}
        {section === 'invites' && <AdminInvites />}
        {section === 'import' && <AdminImport />}
        {section === 'ldap' && <AdminLdap />}
        {/* Chamadas em grupo: */}
        {section === 'calls' && <AdminCalls />}
        {section === 'settings' && <AdminSettings />}
      </div>
    </div>
  );
}

function AdminLink({ id, icon, label, perm }: { id: string; icon: IconName; label: string; perm: string[] }) {
  const ok = usePermission(perm);
  if (!ok) return null;
  return (
    <NavLink to={`/admin/${id}`}>
      <Icon name={icon} />
      {label}
    </NavLink>
  );
}
