import { Fragment, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { usePermission, useStore } from '../../lib/store';
import { RoomPicker, UserPicker, type PickedRoom, type PickedUser } from '../../components/Pickers';
import { Icon } from '../../components/Icon';
import { Avatar, Empty, Field, Pager, SearchInput, SkeletonTable, Tabs, useAsync } from '../../components/ui';
import { PageHead, TableWrap } from './parts';
// Figurinhas: mensagens com figurinha mostram a figurinha no lugar do texto.
import { StickerView } from '../../components/stickers/StickerView';

const json = (v: unknown) => (v === undefined || v === null || (typeof v === 'object' && !Object.keys(v as object).length) ? '—' : JSON.stringify(v));
const pretty = (v: unknown) => (v === undefined || v === null ? '—' : JSON.stringify(v, null, 2));

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

export function AdminAudit() {
  const canMsgs = usePermission('can-audit');
  const canLog = usePermission('can-audit-log');
  const [tab, setTab] = useState<'messages' | 'log' | 'auditions'>(canMsgs ? 'messages' : 'log');
  return (
    <>
      <PageHead title="Auditoria" />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ...(canMsgs ? [{ id: 'messages' as const, label: 'Mensagens' }] : []),
          ...(canLog
            ? [
                { id: 'log' as const, label: 'Registro de ações' },
                { id: 'auditions' as const, label: 'Consultas de auditoria' },
              ]
            : []),
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
      <div className="card audit-form">
        <div className="card-head">
          <div>
            <h2>Auditar mensagens</h2>
            <p className="card-desc">Toda consulta fica registrada no log de auditoria, com quem consultou e quando.</p>
          </div>
        </div>
        <div className="form">
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
            <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          </Field>
          <div className="form-actions">
            <button className="btn primary" disabled={busy} aria-busy={busy || undefined} onClick={run}>
              <Icon name={busy ? 'loading' : 'search'} className={busy ? 'spin' : undefined} />
              Auditar
            </button>
          </div>
        </div>
      </div>
      {result &&
        (result.length === 0 ? (
          <Empty icon="search" title="Nenhuma mensagem encontrada">
            Mude o período, a sala ou o texto buscado.
          </Empty>
        ) : (
          <div className="card audit-results">
            <div className="card-head">
              <h2>
                Resultado <span className="pill head-count">{result.length.toLocaleString('pt-BR')}</span>
              </h2>
              <span className="muted small">Até 2.000 mensagens por consulta</span>
            </div>
            {result.map((m) => (
              <div key={m._id} className="audit-msg">
                <Avatar username={m.u.username} size={32} />
                <div>
                  <div>
                    <strong>{m.u.username}</strong>{' '}
                    <span className="muted">
                      em {m.roomName} · {formatDateTime(m.ts)}
                    </span>
                    {m.editedAt && <span className="muted"> (editada)</span>}
                  </div>
                  <div>
                    {m.t ? (
                      <em className="muted">
                        [{m.t}] {m.msg}
                      </em>
                    ) : /* Figurinhas */ m.sticker ? (
                      <StickerView sticker={m.sticker} size="small" />
                    ) : (
                      renderMarkdown(m.msg)
                    )}
                  </div>
                  {m.files?.map((f: any) => (
                    <div key={f._id} className="audit-file muted small">
                      <Icon name="attach" size={14} />
                      {f.name}
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
  // Linha aberta: o alvo e os detalhes completos (JSON formatado) logo abaixo.
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {!fixed && (
        <div className="filters admin-filters">
          <SearchInput value={action} onChange={(v) => (setAction(v), setOffset(0))} placeholder="Ação (ex.: user.*, settings.*, auth.login)" />
          <SearchInput value={actor} onChange={(v) => (setActor(v), setOffset(0))} placeholder="Usuário que fez" />
        </div>
      )}
      {loading && !data ? (
        <SkeletonTable rows={10} cols={5} />
      ) : !data?.events.length ? (
        <Empty icon="admin-audit" title="Nenhum registro">
          {fixed ? 'As consultas de auditoria de mensagens aparecem aqui.' : 'Nenhuma ação corresponde aos filtros.'}
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv audit-log">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Quem</th>
                <th>Ação</th>
                <th>Alvo</th>
                <th className="col-lg">Detalhes</th>
                <th className="col-xl">IP</th>
              </tr>
            </thead>
            <tbody>
              {data?.events.map((e: any) => {
                const isOpen = open === e._id;
                const toggle = () => setOpen(isOpen ? null : e._id);
                return (
                  <Fragment key={e._id}>
                    <tr
                      className={isOpen ? 'clickable open' : 'clickable'}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={toggle}
                      onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), toggle())}
                    >
                      <td className="nowrap">{formatDateTime(e.ts)}</td>
                      <td className="nowrap" data-label="Quem">
                        {e.actor.username ? `@${e.actor.username}` : <span className="muted">—</span>}
                      </td>
                      <td data-label="Ação">
                        <code className="audit-action">{e.action}</code>
                      </td>
                      <td className="mono small ellipsis-cell audit-json" data-label="Alvo">
                        {json(e.target)}
                      </td>
                      <td className="mono small ellipsis-cell audit-json opt col-lg" data-label="Detalhes">
                        {json(e.data)}
                      </td>
                      <td className="mono muted small nowrap col-xl" data-label="IP">
                        {e.actor.ip || '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="audit-detail">
                        <td colSpan={6}>
                          <dl className="audit-kv">
                            <dt>Alvo</dt>
                            <dd>
                              <pre className="code-block">{pretty(e.target)}</pre>
                            </dd>
                            <dt>Detalhes</dt>
                            <dd>
                              <pre className="code-block">{pretty(e.data)}</pre>
                            </dd>
                            <dt>IP</dt>
                            <dd className="mono">{e.actor.ip || '—'}</dd>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {data && data.total > 0 && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </>
  );
}
