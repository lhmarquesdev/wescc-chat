import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { Subscription } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { roomIcon, roomPath, STATUS_LABEL } from '../lib/format';
import { logout } from '../lib/session';
import { usePermission, useSetting, useStore } from '../lib/store';
import { CreateModal, type CreateKind } from './CreateModal';
import { Avatar, Menu, StatusDot, UserAvatar } from './ui';
import { AgentStatusToggle } from '../pages/omnichannel/OmnichannelPage';

function SidebarItem({ s }: { s: Subscription }) {
  const typing = useStore((st) => Object.keys(st.typing[s.rid] ?? {}).length > 0);
  const dmUser = s.t === 'd' && !s.name.includes(',') ? s.name : null;
  const badge = s.userMentions > 0 || s.t === 'd' ? s.unread : s.unread;
  return (
    <NavLink to={roomPath(s)} className={({ isActive }) => `side-item ${isActive ? 'active' : ''} ${s.alert || s.unread ? 'unread' : ''}`}>
      {dmUser ? (
        <UserAvatar username={dmUser} size={20} />
      ) : (
        <span className="side-icon">{roomIcon(s)}</span>
      )}
      <span className="side-name">{s.fname || s.name}</span>
      {typing && <span className="side-typing">digitando…</span>}
      {s.tunread.length > 0 && <span className="badge thread" title="Threads não lidas">{s.tunread.length}</span>}
      {badge > 0 && <span className={`badge ${s.userMentions > 0 || s.t === 'd' ? 'mention' : s.groupMentions > 0 ? 'group' : ''}`}>{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const me = useStore((s) => s.me)!;
  const subs = useStore((s) => s.subscriptions);
  const connected = useStore((s) => s.connected);
  const siteName = useSetting<string>('Site_Name');
  const omni = useSetting<boolean>('Livechat_enabled');
  const callsEnabled = useSetting<boolean>('Calls_Enabled');
  const isAgent = me.roles.includes('livechat-agent') || me.roles.includes('livechat-manager') || me.roles.includes('admin');
  const canAdmin = usePermission(['view-administration', 'view-user-administration', 'view-room-administration', 'access-permissions', 'view-statistics', 'can-audit', 'view-engagement-dashboard']);
  const [filter, setFilter] = useState('');
  const [create, setCreate] = useState<CreateKind | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const queueCount = useStore((st) => Object.keys(st.queue).length);
  const navigate = useNavigate();

  const groups = useMemo(() => {
    const list = Object.values(subs)
      .filter((s) => s.open || s.unread > 0 || s.alert)
      .filter((s) => !filter || (s.fname || s.name).toLowerCase().includes(filter.toLowerCase()))
      .filter((s) => !onlyUnread || s.unread > 0 || s.alert || s.tunread.length);
    const byRecent = (a: Subscription, b: Subscription) => (a.fname || a.name).localeCompare(b.fname || b.name, 'pt-BR');
    return [
      { title: 'Favoritos', items: list.filter((s) => s.f).sort(byRecent) },
      { title: 'Times', items: list.filter((s) => !s.f && s.teamMain).sort(byRecent) },
      { title: 'Canais', items: list.filter((s) => !s.f && !s.teamMain && !s.prid && (s.t === 'c' || s.t === 'p')).sort(byRecent) },
      { title: 'Discussões', items: list.filter((s) => !s.f && s.prid).sort(byRecent) },
      { title: 'Mensagens diretas', items: list.filter((s) => !s.f && s.t === 'd').sort(byRecent) },
      { title: 'Atendimentos', items: list.filter((s) => !s.f && s.t === 'l').sort(byRecent) },
    ].filter((g) => g.items.length);
  }, [subs, filter, onlyUnread]);

  const setStatus = async (status: string) => {
    try {
      await api.post('users.setStatus', { status });
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };

  return (
    <aside className="sidebar" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="side-head">
        <Menu
          align="left"
          trigger={
            <button className="me-btn" title={me.username}>
              <span className="avatar-wrap" style={{ width: 32, height: 32 }}>
                <Avatar username={me.username} size={32} etag={me.avatarETag} />
                <StatusDot status={me.status} />
              </span>
            </button>
          }
        >
          {(close) => (
            <>
              <div className="menu-title">
                <strong>{me.name}</strong>
                <span>@{me.username}</span>
              </div>
              {(['online', 'away', 'busy', 'offline'] as const).map((s) => (
                <button key={s} onClick={() => (setStatus(s), close())}>
                  <StatusDot status={s} /> {STATUS_LABEL[s]}
                  {me.statusDefault === s ? ' ✓' : ''}
                </button>
              ))}
              <hr />
              <button onClick={() => (navigate('/account/profile'), close())}>👤 Minha conta</button>
              {canAdmin && <button onClick={() => (navigate('/admin/info'), close())}>⚙️ Administração</button>}
              {omni && isAgent && <button onClick={() => (navigate('/omnichannel/queue'), close())}>🎧 Omnichannel</button>}
              <hr />
              <button onClick={() => logout().then(() => (location.href = '/login'))}>↩ Sair</button>
            </>
          )}
        </Menu>
        <div className="side-title" title={siteName}>
          {siteName}
          {!connected && <span className="offline-pill">reconectando…</span>}
        </div>
        <div className="side-actions">
          <button className="icon-btn" title="Início" onClick={() => navigate('/home')}>
            🏠
          </button>
          <button className="icon-btn" title="Diretório" onClick={() => navigate('/directory')}>
            🧭
          </button>
          {callsEnabled && (
            <button className="icon-btn" title="Chamadas" onClick={() => navigate('/calls')}>
              📞
            </button>
          )}
          <Menu trigger={<button className="icon-btn" title="Criar">✎</button>}>
            {(close) => (
              <>
                <button onClick={() => (setCreate('dm'), close())}>@ Mensagem direta</button>
                <button onClick={() => (setCreate('discussion'), close())}>💬 Discussão</button>
                <button onClick={() => (setCreate('channel'), close())}># Canal</button>
                <button onClick={() => (setCreate('team'), close())}>👥 Time</button>
              </>
            )}
          </Menu>
        </div>
      </div>
      {omni && isAgent && (
        <div className="side-omni">
          <AgentStatusToggle />
          <button className="btn small" title="Fila de atendimento" onClick={() => (navigate('/omnichannel/queue'), onNavigate?.())}>
            🎧 Fila {queueCount > 0 && <span className="badge mention">{queueCount}</span>}
          </button>
        </div>
      )}
      <div className="side-search">
        <input placeholder="Buscar salas (Ctrl+K)" value={filter} onChange={(e) => setFilter(e.target.value)} id="sidebar-filter" />
        <button className={`icon-btn ${onlyUnread ? 'on' : ''}`} title="Somente não lidas" onClick={() => setOnlyUnread(!onlyUnread)}>
          ●
        </button>
      </div>
      <nav className="side-list">
        {groups.map((g) => (
          <div key={g.title} className="side-group">
            <div className="side-group-title">{g.title}</div>
            {g.items.map((s) => (
              <SidebarItem key={s.rid} s={s} />
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty small">Nada por aqui.</div>}
      </nav>
      {create && <CreateModal kind={create} onClose={() => setCreate(null)} />}
    </aside>
  );
}
