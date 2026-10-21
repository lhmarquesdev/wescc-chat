import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, roomIcon, roomPath } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { requestNotificationPermission } from '../lib/session';
import { useSetting, useStore } from '../lib/store';
import { Avatar, Empty, Pager, Spinner, Tabs, UserAvatar, useAsync } from '../components/ui';

export function HomePage() {
  const title = useSetting<string>('Layout_Home_Title');
  const body = useSetting<string>('Layout_Home_Body');
  const me = useStore((s) => s.me)!;
  const subs = useStore((s) => s.subscriptions);
  const navigate = useNavigate();
  const unread = Object.values(subs).filter((s) => s.unread > 0 || s.tunread.length);
  const showNotifPrompt = 'Notification' in window && Notification.permission === 'default';
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
      </header>
      <div className="page-body">
        <div className="card">
          <h2>Olá, {me.name.split(' ')[0]}!</h2>
          <div>{renderMarkdown(body ?? '')}</div>
        </div>
        {showNotifPrompt && (
          <div className="card">
            🔔 Ative as notificações do navegador para saber quando alguém falar com você.{' '}
            <button className="btn primary" onClick={requestNotificationPermission}>
              Ativar notificações
            </button>
          </div>
        )}
        <div className="card">
          <h3>Não lidas</h3>
          {unread.length === 0 ? (
            <Empty>Tudo em dia. ✨</Empty>
          ) : (
            unread.map((s) => (
              <button key={s.rid} className="list-row link-row" onClick={() => navigate(roomPath(s))}>
                <span>{roomIcon(s)}</span> <strong>{s.fname || s.name}</strong>
                {s.unread > 0 && <span className={`badge ${s.userMentions ? 'mention' : ''}`}>{s.unread}</span>}
                {s.tunread.length > 0 && <span className="badge thread">{s.tunread.length} threads</span>}
              </button>
            ))
          )}
        </div>
        <div className="grid-3">
          <button className="card action" onClick={() => navigate('/directory')}>
            🧭 <strong>Diretório</strong>
            <span className="muted">Encontre canais, pessoas e times</span>
          </button>
          <button className="card action" onClick={() => navigate('/account/profile')}>
            👤 <strong>Seu perfil</strong>
            <span className="muted">Foto, status e preferências</span>
          </button>
          <button className="card action" onClick={() => navigate('/account/security')}>
            🔐 <strong>Segurança</strong>
            <span className="muted">Senha, 2FA e dispositivos</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function DirectoryPage() {
  const [type, setType] = useState<'channels' | 'users' | 'teams'>('channels');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => (setQ(text), setOffset(0)), 250);
    return () => clearTimeout(t);
  }, [text]);
  const { data, loading } = useAsync(() => api.get('directory', { type, text: q, offset, count: 25 }), [type, q, offset]);

  const openUser = async (username: string) => {
    try {
      const r = await api.post('im.create', { username });
      navigate(roomPath({ _id: r.room._id, t: 'd' }));
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Diretório</h1>
      </header>
      <div className="page-body">
        <Tabs
          value={type}
          onChange={(v) => (setType(v), setOffset(0))}
          items={[
            { id: 'channels', label: 'Canais' },
            { id: 'users', label: 'Pessoas' },
            { id: 'teams', label: 'Times' },
          ]}
        />
        <input className="search-input" placeholder="Buscar…" value={text} onChange={(e) => setText(e.target.value)} />
        {loading ? (
          <Spinner />
        ) : !data?.result.length ? (
          <Empty>Nada encontrado.</Empty>
        ) : (
          <table className="table">
            <thead>
              {type === 'users' ? (
                <tr>
                  <th>Nome</th>
                  <th>Usuário</th>
                  <th>Desde</th>
                </tr>
              ) : (
                <tr>
                  <th>Nome</th>
                  <th>Membros</th>
                  <th>{type === 'teams' ? 'Salas' : 'Time'}</th>
                  <th>Criado em</th>
                </tr>
              )}
            </thead>
            <tbody>
              {data.result.map((r: any) =>
                type === 'users' ? (
                  <tr key={r._id} className="clickable" onClick={() => openUser(r.username)}>
                    <td>
                      <UserAvatar username={r.username} size={28} status={r.status} /> <strong>{r.name}</strong>
                    </td>
                    <td className="muted">@{r.username}</td>
                    <td className="muted">{formatDateTime(r.createdAt)}</td>
                  </tr>
                ) : (
                  <tr key={r._id} className="clickable" onClick={() => navigate(roomPath(type === 'teams' ? { _id: r.roomId, t: r.type === 1 ? 'p' : 'c' } : r))}>
                    <td>
                      <Avatar rid={type === 'teams' ? r.roomId : r._id} size={28} /> <strong>{type === 'teams' ? `👥 ${r.name}` : `${roomIcon(r)} ${r.fname || r.name}`}</strong>
                      {r.featured && <span className="pill">destaque</span>}
                      {r.topic && <div className="muted small ellipsis">{r.topic}</div>}
                    </td>
                    <td>{r.usersCount}</td>
                    <td>{type === 'teams' ? r.roomsCount : r.teamName ?? '—'}</td>
                    <td className="muted">{formatDateTime(r.ts)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        {data && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
      </div>
    </div>
  );
}
