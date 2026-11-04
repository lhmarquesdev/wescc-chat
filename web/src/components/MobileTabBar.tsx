import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { badgeCount } from '../lib/format';
import { useSetting, useStore } from '../lib/store';
import { Icon, type IconName } from './Icon';
import { useMentionTotal } from './navState';
// Chamadas em grupo: o selo de perdidas vem do servidor (calls.missedCount), com o rótulo para leitores de tela.
import { CallsNavBadge } from './call/LiveIndicators';
import { useMyStatus, UserMenu } from './Sidebar';
import { UserAvatar } from './ui';
import { useFilesTab } from '../lib/files';

function Tab({
  to,
  match,
  icon,
  label,
  badge,
  badgeKind,
  extra,
}: {
  to: string;
  match?: string;
  icon: IconName;
  label: string;
  badge?: number;
  badgeKind?: string;
  extra?: ReactNode;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = match ?? to;
  const active = pathname === to || pathname === base || pathname.startsWith(`${base}/`);
  return (
    <button type="button" className={active ? 'tab active' : 'tab'} aria-current={active ? 'page' : undefined} onClick={() => navigate(to)}>
      <span className="tab-icon">
        <Icon name={icon} size={24} />
        {!!badge && <span className={badgeKind ? `badge ${badgeKind}` : 'badge'}>{badgeCount(badge)}</span>}
        {extra}
      </span>
      <span className="tab-label">{label}</span>
    </button>
  );
}

// Barra de abas do celular (fora das salas): Conversas, Chamadas, Agenda, Arquivos, Diretório e Você.
export function MobileTabBar() {
  const me = useStore((s) => s.me)!;
  const callsEnabled = useSetting<boolean>('Calls_Enabled');
  const calendarOn = useSetting<boolean>('Calendar_Enabled') !== false;
  const filesOn = useFilesTab(); // Arquivos
  const mentions = useMentionTotal();
  const { status, silenced } = useMyStatus();
  const { pathname } = useLocation();
  const meActive = pathname.startsWith('/account') || pathname.startsWith('/admin');
  return (
    <nav className="tabbar" aria-label="Navegação principal">
      <Tab to="/home" icon="nav-chats" label="Conversas" badge={mentions} badgeKind="mention" />
      {callsEnabled && <Tab to="/calls" icon="nav-calls" label="Chamadas" extra={<CallsNavBadge />} />}
      {calendarOn && <Tab to="/calendar" icon="nav-calendar" label="Agenda" />}
      {filesOn && <Tab to="/files" icon="nav-files" label="Arquivos" />}
      <Tab to="/directory" icon="nav-directory" label="Diretório" />
      <UserMenu
        trigger={
          <button
            type="button"
            className={meActive ? 'tab me-btn active' : 'tab me-btn'}
            aria-current={meActive ? 'page' : undefined}
            aria-label={silenced ? 'Você · notificações silenciadas' : undefined}
          >
            <span className="tab-icon">
              <UserAvatar username={me.username} size={24} status={status} />
              {/* Ocupado silencia também o push do celular: o sino cortado fica sempre à vista, como no rodapé do computador. */}
              {silenced && (
                <span className="tab-silenced" title="Notificações silenciadas">
                  <Icon name="notify-silenced" size={12} />
                </span>
              )}
            </span>
            <span className="tab-label">Você</span>
          </button>
        }
      />
    </nav>
  );
}
