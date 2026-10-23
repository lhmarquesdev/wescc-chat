import { useLocation, useNavigate } from 'react-router-dom';
import { badgeCount } from '../lib/format';
import { useSetting, useStore } from '../lib/store';
import { Icon, type IconName } from './Icon';
import { useMentionTotal, useMissedCalls } from './navState';
import { useAgent, useMyStatus, UserMenu } from './Sidebar';
import { UserAvatar } from './ui';

function Tab({ to, match, icon, label, badge, badgeKind }: { to: string; match?: string; icon: IconName; label: string; badge?: number; badgeKind?: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = match ?? to;
  const active = pathname === to || pathname === base || pathname.startsWith(`${base}/`);
  return (
    <button type="button" className={active ? 'tab active' : 'tab'} aria-current={active ? 'page' : undefined} onClick={() => navigate(to)}>
      <span className="tab-icon">
        <Icon name={icon} size={24} />
        {!!badge && <span className={badgeKind ? `badge ${badgeKind}` : 'badge'}>{badgeCount(badge)}</span>}
      </span>
      <span className="tab-label">{label}</span>
    </button>
  );
}

// Barra de abas do celular (fora das salas): Conversas, Chamadas, Atendimento, Diretório e Você.
export function MobileTabBar() {
  const me = useStore((s) => s.me)!;
  const callsEnabled = useSetting<boolean>('Calls_Enabled');
  const { omni, isAgent } = useAgent();
  const queueCount = useStore((st) => Object.keys(st.queue).length);
  const mentions = useMentionTotal();
  const missed = useMissedCalls().count;
  const { status } = useMyStatus();
  const { pathname } = useLocation();
  const meActive = pathname.startsWith('/account') || pathname.startsWith('/admin');
  return (
    <nav className="tabbar" aria-label="Navegação principal">
      <Tab to="/home" icon="nav-chats" label="Conversas" badge={mentions} badgeKind="mention" />
      {callsEnabled && <Tab to="/calls" icon="nav-calls" label="Chamadas" badge={missed} badgeKind="mention" />}
      {omni && isAgent && <Tab to="/omnichannel/queue" match="/omnichannel" icon="nav-omnichannel" label="Atendimento" badge={queueCount} badgeKind="group" />}
      <Tab to="/directory" icon="nav-directory" label="Diretório" />
      <UserMenu
        trigger={
          <button type="button" className={meActive ? 'tab me-btn active' : 'tab me-btn'} aria-current={meActive ? 'page' : undefined}>
            <span className="tab-icon">
              <UserAvatar username={me.username} size={24} status={status} />
            </span>
            <span className="tab-label">Você</span>
          </button>
        }
      />
    </nav>
  );
}
