import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { partyOf, useDirect, type DirectState } from '../lib/direct';
import { formatDateTime, roleLabel, roomPath, STATUS_LABEL } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { canWithRoles, useStore } from '../lib/store';
import { Avatar, Modal, Spinner, StatusDot, useAsync } from './ui';

export function UserCard({ username, rid, roomRoles, onClose }: { username: string; rid?: string; roomRoles: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useStore((s) => s.me)!;
  const presence = useStore((s) => s.presence[username]);
  const can = (p: string) => canWithRoles(p, roomRoles);
  const { data, loading, error, reload } = useAsync(async () => {
    const u = (await api.get('users.info', { username })).user;
    if (!rid) return { u, roles: [] as string[], inRoom: false, muted: false, roomType: undefined, notice: false };
    const info = await api.get('rooms.info', { roomId: rid }).catch(() => null);
    // Lista de membros oculta ("Ocultar a lista de membros"): quem não pode vê-la nem pergunta.
    const hidden = !!info?.room.broadcast && !can('view-broadcast-member-list');
    const r = hidden ? null : await api.get('rooms.membersOrderedByRole', { roomId: rid, filter: username, count: 5 }).catch(() => null);
    const roles: string[] = r?.members.find((m: any) => m.username === username)?.roles ?? [];
    const muted = !!info?.room.muted?.includes(username);
    return { u, roles, inRoom: !!r?.members.some((m: any) => m.username === username), muted, roomType: info?.room.t, notice: !!info?.room.notice };
  }, [username, rid]);

  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
  const direct = useDirect();

  const dm = async () => {
    try {
      const r = await api.post('im.create', { username });
      navigate(roomPath({ _id: r.room._id, t: 'd' }));
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const roleAction = (role: 'Owner' | 'Moderator' | 'Leader' | 'Publisher', add: boolean) =>
    api
      .post(`${data?.roomType === 'p' ? 'groups' : 'channels'}.${add ? 'add' : 'remove'}${role}`, { roomId: rid, userId: data!.u._id })
      .then(reload)
      .catch(fail);

  // Abrir, só ver o histórico (bloqueada) ou nada (não dá para começar).
  const dmState = data && data.u._id !== me._id ? direct.state([partyOf(data.u)]) : null;

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
                  {roleLabel(r)} da sala
                </span>
              ))}
            </div>
            {data.u.bio && <div className="bio">{renderMarkdown(data.u.bio)}</div>}
            {data.u.email && <div className="muted small">✉ {data.u.email}</div>}
            {data.u.lastLogin && <div className="muted small">Último acesso: {formatDateTime(data.u.lastLogin)}</div>}
            <div className="row-actions wrap">
              {dmState && <DirectButton st={dmState} onOpen={dm} onView={(path) => (navigate(path), onClose())} />}
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
                  {data.notice && can('set-publisher') && (
                    <button className="btn" onClick={() => roleAction('Publisher', !data.roles.includes('publisher'))}>
                      {data.roles.includes('publisher') ? 'Remover publicador' : '📢 Tornar publicador'}
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
            {dmState && dmState.kind !== 'open' && <p className="muted small direct-note">🚫 {dmState.text}</p>}
          </div>
        )
      )}
    </Modal>
  );
}

function DirectButton({ st, onOpen, onView }: { st: DirectState; onOpen: () => void; onView: (path: string) => void }) {
  if (st.kind === 'view')
    return (
      <button className="btn primary" onClick={() => onView(st.path)}>
        💬 Ver conversa
      </button>
    );
  return (
    <button className="btn primary" onClick={onOpen} disabled={st.kind === 'none'} title={st.kind === 'none' ? st.text : undefined}>
      💬 Mensagem direta
    </button>
  );
}
