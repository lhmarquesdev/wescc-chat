import { NavLink, useParams } from 'react-router-dom';
import { usePermission } from '../../lib/store';
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

export function AdminPage() {
  const { section = 'info' } = useParams();
  const items = [
    { id: 'info', label: '📊 Informações', perm: ['view-statistics'] },
    { id: 'engagement', label: '📈 Engajamento', perm: ['view-engagement-dashboard'] },
    { id: 'users', label: '👤 Usuários', perm: ['view-user-administration'] },
    { id: 'rooms', label: '# Salas', perm: ['view-room-administration'] },
    { id: 'permissions', label: '🛡 Papéis e permissões', perm: ['access-permissions'] },
    { id: 'devices', label: '💻 Dispositivos', perm: ['view-device-management'] },
    { id: 'audit', label: '🔎 Auditoria', perm: ['can-audit', 'can-audit-log'] },
    { id: 'moderation', label: '🚩 Moderação', perm: ['view-moderation-console'] },
    { id: 'integrations', label: '🔌 Integrações', perm: ['manage-integrations', 'manage-own-integrations'] },
    { id: 'oauth', label: '🔑 OAuth', perm: ['manage-oauth-apps'] },
    { id: 'omnichannel', label: '🎧 Omnichannel', perm: ['view-livechat-manager'] },
    { id: 'emoji', label: '😀 Emojis', perm: ['manage-emoji'] },
    { id: 'invites', label: '🔗 Convites', perm: ['view-room-administration'] },
    { id: 'import', label: '📥 Importação', perm: ['run-import', 'view-import-operations'] },
    { id: 'ldap', label: '🗂 LDAP / AD', perm: ['view-privileged-setting'] },
    { id: 'settings', label: '⚙️ Configurações', perm: ['view-privileged-setting'] },
  ];
  return (
    <div className="page with-nav">
      <nav className="page-nav">
        <h2>Administração</h2>
        {items.map((i) => (
          <AdminLink key={i.id} id={i.id} label={i.label} perm={i.perm} />
        ))}
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
        {section === 'settings' && <AdminSettings />}
      </div>
    </div>
  );
}

function AdminLink({ id, label, perm }: { id: string; label: string; perm: string[] }) {
  const ok = usePermission(perm);
  if (!ok) return null;
  return <NavLink to={`/admin/${id}`}>{label}</NavLink>;
}
