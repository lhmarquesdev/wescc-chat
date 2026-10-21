import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Empty, Field, Modal, Pager, Spinner, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

export function AdminDevices() {
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useAsync(() => api.get('sessions.list.all', { filter, offset, count: 50 }), [filter, offset]);
  return (
    <>
      <h1>Gestão de dispositivos</h1>
      <div className="filters">
        <input placeholder="Filtrar por usuário ou IP" value={filter} onChange={(e) => (setFilter(e.target.value), setOffset(0))} />
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Dispositivo</th>
              <th>Sistema</th>
              <th>IP</th>
              <th>Login</th>
              <th>Último uso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.sessions.map((s: any) => (
              <tr key={s._id}>
                <td>@{s.username}</td>
                <td>{s.device.browser}</td>
                <td>{s.device.os}</td>
                <td>{s.device.ip}</td>
                <td>{formatDateTime(s.createdAt)}</td>
                <td>{formatDateTime(s.lastActiveAt)}</td>
                <td>
                  <button className="btn small danger" onClick={() => api.post('sessions.logout', { sessionId: s._id }).then(reload).catch(fail)}>
                    Encerrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </>
  );
}

export function AdminModeration() {
  const { data, loading, reload } = useAsync(() => api.get('moderation.reportsByUsers', { count: 100 }), []);
  const [user, setUser] = useState<any>(null);
  return (
    <>
      <h1>Moderação</h1>
      {loading ? (
        <Spinner />
      ) : !data?.reports.length ? (
        <Empty>Nenhuma denúncia pendente.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Usuário denunciado</th>
              <th>Denúncias</th>
              <th>Última</th>
            </tr>
          </thead>
          <tbody>
            {data.reports.map((r: any) => (
              <tr key={r.userId} className="clickable" onClick={() => setUser(r)}>
                <td>
                  @{r.username} <span className="muted">{r.name}</span>
                </td>
                <td>{r.count}</td>
                <td>{formatDateTime(r.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {user && <UserReports user={user} onClose={() => (setUser(null), reload())} />}
    </>
  );
}

function UserReports({ user, onClose }: { user: any; onClose: () => void }) {
  const { data, loading } = useAsync(() => api.get('moderation.userReports', { userId: user.userId }), [user.userId]);
  return (
    <Modal
      wide
      title={`Denúncias contra @${user.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => api.post('moderation.dismissReports', { userId: user.userId }).then(onClose).catch(fail)}>
            Descartar denúncias
          </button>
          <button className="btn danger" onClick={() => confirm('Apagar todas as mensagens denunciadas?') && api.post('moderation.user.deleteReportedMessages', { userId: user.userId }).then(onClose).catch(fail)}>
            Apagar mensagens denunciadas
          </button>
          <button className="btn danger" onClick={() => confirm(`Desativar @${user.username}?`) && api.post('users.setActiveStatus', { userId: user.userId, activeStatus: false }).then(onClose).catch(fail)}>
            Desativar usuário
          </button>
        </>
      }
    >
      {loading ? (
        <Spinner />
      ) : (
        <ul className="plain-list">
          {data?.reports.map((r: any) => (
            <li key={r._id}>
              <div>
                <strong>{r.reporter}</strong> denunciou em {formatDateTime(r.ts)} {r.roomName && <>na sala #{r.roomName}</>}
              </div>
              {r.msg && <blockquote>{r.msg}</blockquote>}
              {r.description && <div className="muted">Motivo: {r.description}</div>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function AdminEmoji() {
  const emojiVersion = useStore((s) => s.emojiVersion);
  const { data, loading, reload } = useAsync(() => api.get('emoji-custom.list'), [emojiVersion]);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const create = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('name', name);
    fd.append('aliases', aliases);
    fd.append('emoji', file);
    try {
      await api.post('emoji-custom.create', fd);
      setName('');
      setAliases('');
      setFile(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <h1>Emojis personalizados</h1>
      <div className="card form narrow">
        <Field label="Nome (use como :nome:)">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_+-]/g, ''))} />
        </Field>
        <Field label="Apelidos (separados por vírgula)">
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </Field>
        <input type="file" accept="image/png,image/gif,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn primary" disabled={!name || !file} onClick={create}>
          Adicionar emoji
        </button>
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <div className="emoji-admin">
          {data?.emojis.update.map((e: any) => (
            <div key={e._id} className="card emoji-card">
              <img src={`/emoji-custom/${e.name}?v=${emojiVersion}`} alt={e.name} />
              <code>:{e.name}:</code>
              {e.aliases.length > 0 && <span className="muted small">{e.aliases.join(', ')}</span>}
              <button className="btn small danger" onClick={() => api.post('emoji-custom.delete', { emojiId: e._id }).then(reload).catch(fail)}>
                Remover
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function AdminInvites() {
  const { data, loading, reload } = useAsync(() => api.get('listInvites'), []);
  return (
    <>
      <h1>Convites</h1>
      {loading ? (
        <Spinner />
      ) : !data?.invites.length ? (
        <Empty>Nenhum convite criado.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Sala</th>
              <th>Link</th>
              <th>Usos</th>
              <th>Expira</th>
              <th>Criado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.invites.map((i: any) => (
              <tr key={i._id}>
                <td>#{i.roomName}</td>
                <td className="mono small">{`${location.origin}/invite/${i._id}`}</td>
                <td>
                  {i.uses}
                  {i.maxUses ? ` / ${i.maxUses}` : ''}
                </td>
                <td>{i.expires ? formatDateTime(i.expires) : 'nunca'}</td>
                <td>{formatDateTime(i.createdAt)}</td>
                <td>
                  <button className="btn small danger" onClick={() => api.del(`removeInvite/${i._id}`).then(reload).catch(fail)}>
                    Revogar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
