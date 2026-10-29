import { NavLink, useParams } from 'react-router-dom';
// Figurinhas: Navigate e useStore para mandar quem não pode abrir a seção para a primeira que pode.
import { Navigate } from 'react-router-dom';
import { usePermission, useStore } from '../../lib/store';
import { Icon, type IconName } from '../../components/Icon';
import { SideFoot, TakeoverBack, TakeoverHead } from '../../components/Sidebar';
import { AdminInfo } from './AdminInfo';
import { AdminUsers } from './AdminUsers';
import { AdminRooms } from './AdminRooms';
import { AdminPermissions } from './rbac';
import { AdminSettings } from './AdminSettings';
import { AdminEngagement } from './AdminEngagement';
import { AdminAudit } from './AdminAudit';
import { AdminDevices, AdminEmoji, AdminInvites, AdminModeration } from './AdminMisc';
// Integrações (Jira/Teams): hub com Jira, Microsoft Teams e os webhooks (AdminIntegrations, agora em /admin/integrations/webhooks)
import { IntegrationsAdmin } from './integrations';
import { AdminOAuth } from './AdminOAuth';
import { AdminImport } from './import';
import { AdminLdap } from './ldap';
// Chamadas em grupo: Administração › Chamadas.
import { AdminCalls } from './calls/AdminCalls';
import { useActiveNavInView } from './parts';
import { ADMIN_SECTIONS } from './sections';
// Figurinhas: Administração → Figurinhas.
import { AdminStickers } from './stickers';

export function AdminPage() {
  const { section = 'info' } = useParams();
  const navRef = useActiveNavInView(section);
  // A lista fica em sections.ts: o item "Administração" do menu do usuário sai dela também.
  const items = ADMIN_SECTIONS;
  // Figurinhas: a seção pedida precisa estar entre as que a pessoa vê (o mesmo teste do AdminLink); senão vai para a primeira.
  const perms = useStore((s) => s.me?.permissions);
  const firstVisible = perms ? items.find((i) => i.perm.some((p) => perms.includes(p))) : undefined;
  if (perms && !items.some((i) => i.id === section && i.perm.some((p) => perms.includes(p)))) return <Navigate to={firstVisible ? '/admin/' + firstVisible.id : '/home'} replace />;
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
        {/* Integrações (Jira/Teams) */}
        {section === 'integrations' && <IntegrationsAdmin />}
        {section === 'oauth' && <AdminOAuth />}
        {section === 'emoji' && <AdminEmoji />}
        {/* Figurinhas */}
        {section === 'stickers' && <AdminStickers />}
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
