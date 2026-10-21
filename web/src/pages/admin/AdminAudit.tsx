import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { usePermission, useStore } from '../../lib/store';
import { RoomPicker, UserPicker, type PickedRoom, type PickedUser } from '../../components/Pickers';
import { Avatar, Empty, Field, Pager, Spinner, Tabs, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

export function AdminAudit() {
  const canMsgs = usePermission('can-audit');
  const canLog = usePermission('can-audit-log');
  const [tab, setTab] = useState<'messages' | 'log' | 'auditions'>(canMsgs ? 'messages' : 'log');
  return (
    <>
      <h1>Auditoria</h1>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ...(canMsgs ? [{ id: 'messages' as const, label: 'Mensagens' }] : []),
          ...(canLog ? [{ id: 'log' as const, label: 'Registro de ações' }, { id: 'auditions' as const, label: 'Consultas de auditoria' }] : []),
        ]}
      />
      {tab === 'messages' && <MessagesAudit />}
      {tab === 'log' && <ActionLog />}
      {tab === 'auditions' && <ActionLog fixed="audit.*" />}
    </>
  );
}

function MessagesAudit() {
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType] = useState<'room' | 'u' | 'user' | 'd'>('room');
  const [room, setRoom] = useState<PickedRoom | null>(null);
  const [users, setUsers] = useState<PickedUser[]>([]);
  const [start, setStart] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(today);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const body: any = { type, startDate: new Date(`${start}T00:00:00`).toISOString(), endDate: new Date(`${end}T23:59:59`).toISOString(), msg: msg || undefined };
      if (type === 'room') body.rid = room?._id;
      if (type === 'u') body.users = users.map((u) => u.username);
      if (type === 'user' || type === 'd') body.username = users[0]?.username;
      const r = await api.post('audit.messages', body);
      setResult(r.messages);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card form">
        <p className="muted small">Toda consulta fica registrada no log de auditoria, com quem consultou e quando.</p>
        <Field label="Tipo de busca">
          <select value={type} onChange={(e) => (setType(e.target.value as any), setUsers([]))}>
            <option value="room">Mensagens de uma sala</option>
            <option value="u">Conversa direta entre usuários</option>
            <option value="user">Mensagens enviadas por um usuário</option>
            <option value="d">Todas as DMs de um usuário</option>
          </select>
        </Field>
        {type === 'room' ? (
          <Field label="Sala">
            <RoomPicker value={room} onChange={setRoom} />
          </Field>
        ) : (
          <Field label={type === 'u' ? 'Usuários (dois ou mais)' : 'Usuário'}>
            <UserPicker value={users} onChange={setUsers} single={type !== 'u'} />
          </Field>
        )}
        <div className="two-col">
          <Field label="De">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Até">
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Contendo o texto (opcional)">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={busy} onClick={run}>
          Auditar
        </button>
      </div>
      {result &&
        (result.length === 0 ? (
          <Empty>Nenhuma mensagem no período.</Empty>
        ) : (
          <div className="card">
            <div className="muted small">{result.length} mensagens (máx. 2000)</div>
            {result.map((m) => (
              <div key={m._id} className="audit-msg">
                <Avatar username={m.u.username} size={24} />
                <div>
                  <div>
                    <strong>{m.u.username}</strong> <span className="muted">em {m.roomName} · {formatDateTime(m.ts)}</span>
                    {m.editedAt && <span className="muted"> (editada)</span>}
                  </div>
                  <div>{m.t ? <em className="muted">[{m.t}] {m.msg}</em> : renderMarkdown(m.msg)}</div>
                  {m.files?.map((f: any) => (
                    <div key={f._id} className="muted small">
                      📎 {f.name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
    </>
  );
}

function ActionLog({ fixed }: { fixed?: string }) {
  const [action, setAction] = useState(fixed ?? '');
  const [actor, setActor] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, loading } = useAsync(() => api.get('audit.log', { action: fixed ?? (action || undefined), actor: actor || undefined, offset, count: 50 }), [action, actor, offset, fixed]);
  return (
    <>
      {!fixed && (
        <div className="filters">
          <input placeholder="Ação (ex.: user.*, settings.*, auth.login)" value={action} onChange={(e) => (setAction(e.target.value), setOffset(0))} />
          <input placeholder="Usuário que fez" value={actor} onChange={(e) => (setActor(e.target.value), setOffset(0))} />
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>Ação</th>
              <th>Alvo</th>
              <th>Detalhes</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {data?.events.map((e: any) => (
              <tr key={e._id}>
                <td className="nowrap">{formatDateTime(e.ts)}</td>
                <td>{e.actor.username ?? '—'}</td>
                <td className="mono">{e.action}</td>
                <td className="mono small">{JSON.stringify(e.target)}</td>
                <td className="mono small ellipsis-cell" title={JSON.stringify(e.data)}>
                  {JSON.stringify(e.data)}
                </td>
                <td className="muted">{e.actor.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </>
  );
}
