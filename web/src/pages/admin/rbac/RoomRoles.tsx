// Papéis de sala (Dono, Moderador, Publicador e os criados aqui): em que sala, quem, com quais papéis. Por papel (aba
// Pessoas do editor) ou por pessoa (editor de usuário). Grupo privado de que você não participa aparece sem nome.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Pager, SkeletonTable, useAsync } from '../../../components/ui';
import { UserCell } from '../parts';

interface Item {
  room: { _id?: string; name?: string; t: string; hidden?: boolean };
  user: { _id: string; username: string; name: string; active: boolean };
  roles: string[];
}

const HIDDEN = 'Grupo privado (você não participa)';

function RoomName({ room }: { room: Item['room'] }) {
  if (room.hidden) return <span className="muted">{HIDDEN}</span>;
  return (
    <span className="rbac-room-name">
      <Icon name={room.t === 'p' ? 'room-private' : 'room-channel'} size={14} />
      {room.name}
    </span>
  );
}

export function RoomRoles({ role, userId }: { role?: string; userId?: string }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  const list = useAsync(() => api.get('rbac.roomRoles', { role, userId, offset, count }) as Promise<{ items: Item[]; total: number }>, [role, userId, offset, count]);
  const data = list.data;
  if (list.loading && !data) return <SkeletonTable rows={3} cols={3} />;
  if (list.error && !data) return <p className="muted small rbac-empty-areas">{list.error}</p>;
  if (!data?.items.length) return role ? <Empty icon="rbac-room" title="Ninguém tem este papel em nenhuma sala." /> : <p className="muted small rbac-roomroles-empty">Nenhum papel de sala.</p>;
  const pager = data.total > count && <Pager offset={offset} count={count} total={data.total} onChange={setOffset} onCountChange={(c) => (setCount(c), setOffset(0))} />;
  // Por pessoa: uma linha por papel em cada sala ("Dono em #geral").
  if (userId)
    return (
      <div className="rbac-roomroles">
        <ul className="rbac-roomroles-lines">
          {data.items.flatMap((i) =>
            i.roles.map((r) => (
              <li key={`${i.room._id ?? 'x'}-${r}`}>
                <Icon name="rbac-room" size={14} />
                {i.room.hidden ? (
                  <span>
                    {roleLabel(r)} em <span className="muted">{HIDDEN.toLowerCase()}</span>
                  </span>
                ) : (
                  <span>
                    {roleLabel(r)} em #{i.room.name}
                  </span>
                )}
              </li>
            )),
          )}
        </ul>
        {pager}
      </div>
    );
  return (
    <div className="rbac-roomroles">
      <table className="table stack">
        <thead>
          <tr>
            <th>Sala</th>
            <th>Pessoa</th>
            <th>Papéis nesta sala</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((i, n) => (
            <tr key={`${n}-${i.room._id ?? ''}-${i.user._id}`}>
              <td data-label="Sala">
                <RoomName room={i.room} />
              </td>
              <td data-label="Pessoa">
                <button type="button" className="link-btn" onClick={() => navigate(`/admin/users/edit/${i.user._id}`)}>
                  <UserCell username={i.user.username} name={i.user.name} sub={i.user.active ? undefined : 'Desativado'} />
                </button>
              </td>
              <td data-label="Papéis nesta sala">
                <span className="rbac-roomroles-roles">
                  {i.roles.map((r) => (
                    <span key={r} className={`pill tag${r === role ? ' accent' : ''}`}>
                      {roleLabel(r)}
                    </span>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pager}
    </div>
  );
}
