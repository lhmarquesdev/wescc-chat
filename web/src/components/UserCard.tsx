import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, roomPath, STATUS_LABEL } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { canWithRoles, useStore } from '../lib/store';
import { Avatar, Modal, Spinner, StatusDot, useAsync } from './ui';

export function UserCard({ username, rid, roomRoles, onClose }: { username: string; rid?: string; roomRoles: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useStore((s) => s.me)!;
  const presence = useStore((s) => s.presence[username]);
  const { data, loading, error, reload } = useAsync(async () => {
    const u = (await api.get('users.info', { username })).user;
    let roles: string[] = [];
    let muted = false;
    if (rid) {
      const r = await api.get('rooms.membersOrderedByRole', { roomId: rid, filter: username, count: 5 }).catch(() => null);
      roles = r?.members.find((m: any) => m.username === username)?.roles ?? [];
      const info = await api.get('rooms.info', { roomId: rid }).catch(() => null);
      muted = !!info?.room.muted?.includes(username);
      return { u, roles, inRoom: !!r?.members.some((m: any) => m.username === username), muted, roomType: info?.room.t };
    }
    return { u, roles, inRoom: false, muted, roomType: undefined };
  }, [username, rid]);

  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
  const can = (p: string) => canWithRoles(p, roomRoles);

  const dm = async () => {
    try {
      const r = await api.post('im.create', { username });
      navigate(roomPath({ _id: r.room._id, t: 'd' }));
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const roleAction = (role: 'Owner' | 'Moderator' | 'Leader', add: boolean) =>
    api
      .post(`${data?.roomType === 'p' ? 'groups' : 'channels'}.${add ? 'add' : 'remove'}${role}`, { roomId: rid, userId: data!.u._id })
      .then(reload)
      .catch(fail);

  return (
    <Modal title="Usuário" onClose={onClose}>
      {loading ? (
        <Spinner />
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : (
        data && (
          <div className="user-card">
            <Avatar username={username} size={120} etag={data.u.avatarETag} />
            <h2>{data.u.name}</h2>
            <div className="muted">@{data.u.username}</div>
            <div>
              <StatusDot username={username} status={data.u.status} /> {STATUS_LABEL[presence?.status ?? data.u.status]}
              {(presence?.statusText ?? data.u.statusText) && <span className="muted"> — {presence?.statusText ?? data.u.statusText}</span>}
            </div>
            <div className="chips">
              {data.u.roles.map((r: string) => (
                <span key={r} className="pill">
                  {r}
                </span>
              ))}
              {data.roles.map((r: string) => (
                <span key={r} className="pill accent">
                  {r} da sala
                </span>
              ))}
            </div>
            {data.u.bio && <div className="bio">{renderMarkdown(data.u.bio)}</div>}
            {data.u.email && <div className="muted small">✉ {data.u.email}</div>}
            {data.u.lastLogin && <div className="muted small">Último acesso: {formatDateTime(data.u.lastLogin)}</div>}
            <div className="row-actions wrap">
              {data.u._id !== me._id && (
                <button className="btn primary" onClick={dm}>
                  💬 Mensagem direta
                </button>
              )}
              {rid && data.inRoom && data.u._id !== me._id && (
                <>
                  {can('set-owner') && (
                    <button className="btn" onClick={() => roleAction('Owner', !data.roles.includes('owner'))}>
                      {data.roles.includes('owner') ? 'Remover dono' : 'Tornar dono'}
                    </button>
                  )}
                  {can('set-moderator') && (
                    <button className="btn" onClick={() => roleAction('Moderator', !data.roles.includes('moderator'))}>
                      {data.roles.includes('moderator') ? 'Remover moderador' : 'Tornar moderador'}
                    </button>
                  )}
                  {can('set-leader') && (
                    <button className="btn" onClick={() => roleAction('Leader', !data.roles.includes('leader'))}>
                      {data.roles.includes('leader') ? 'Remover líder' : 'Tornar líder'}
                    </button>
                  )}
                  {can('mute-user') && (
                    <button className="btn" onClick={() => api.post(data.muted ? 'rooms.unmuteUser' : 'rooms.muteUser', { roomId: rid, userId: data.u._id }).then(reload).catch(fail)}>
                      {data.muted ? '🔊 Remover silêncio' : '🔇 Silenciar'}
                    </button>
                  )}
                  {can('remove-user') && (
                    <button
                      className="btn danger"
                      onClick={() => confirm(`Remover @${username} da sala?`) && api.post(`${data.roomType === 'p' ? 'groups' : 'channels'}.kick`, { roomId: rid, userId: data.u._id }).then(onClose).catch(fail)}
                    >
                      Remover da sala
                    </button>
                  )}
                </>
              )}
              {me.permissions.includes('view-user-administration') && (
                <button className="btn" onClick={() => (navigate(`/admin/users?edit=${data.u._id}`), onClose())}>
                  ⚙️ Administrar
                </button>
              )}
            </div>
          </div>
        )
      )}
    </Modal>
  );
}
