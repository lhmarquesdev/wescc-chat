import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import { usePermission, useStore } from '../../lib/store';
import { LIVECHAT_STATUS } from '../../components/LivechatPanel';
import { Empty, Field, Modal, Pager, Spinner, useAsync } from '../../components/ui';
import { OmniAnalytics } from './OmniAnalytics';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

export function AgentStatusToggle() {
  const status = useStore((s) => s.agentStatus);
  const me = useStore((s) => s.me);
  if (!me?.roles.includes('livechat-agent')) return null;
  const on = status === 'available';
  return (
    <button
      className={`btn small ${on ? 'primary' : ''}`}
      title="Receber novos atendimentos"
      onClick={() => api.post('livechat/agent.status', { status: on ? 'not-available' : 'available' }).catch(fail)}
    >
      {on ? '● Disponível' : '○ Indisponível'}
    </button>
  );
}

export function OmnichannelPage() {
  const { section = 'queue' } = useParams();
  const canCurrent = usePermission(['view-livechat-rooms', 'view-l-room']);
  const canContacts = usePermission('view-livechat-contacts');
  const canCanned = usePermission(['view-canned-responses', 'manage-livechat-canned-responses']);
  const canAnalytics = usePermission('view-livechat-analytics');
  const canManage = usePermission('view-livechat-manager');
  const queueCount = useStore((s) => Object.keys(s.queue).length);
  return (
    <div className="page with-nav">
      <nav className="page-nav">
        <h2>Omnichannel</h2>
        <div style={{ padding: '0 10px 8px' }}>
          <AgentStatusToggle />
        </div>
        <NavLink to="/omnichannel/queue">📥 Fila {queueCount > 0 && <span className="badge mention">{queueCount}</span>}</NavLink>
        {canCurrent && <NavLink to="/omnichannel/current">💬 Conversas</NavLink>}
        {canContacts && <NavLink to="/omnichannel/contacts">📇 Contatos</NavLink>}
        {canCanned && <NavLink to="/omnichannel/canned">⚡ Respostas prontas</NavLink>}
        {canAnalytics && <NavLink to="/omnichannel/analytics">📊 Relatórios</NavLink>}
        {canManage && <NavLink to="/admin/omnichannel">⚙️ Gestão</NavLink>}
      </nav>
      <div className="page-body">
        {section === 'queue' && <QueuePage />}
        {section === 'current' && <CurrentChats />}
        {section === 'contacts' && <Contacts />}
        {section === 'canned' && <CannedResponses />}
        {section === 'analytics' && <OmniAnalytics />}
      </div>
    </div>
  );
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function QueuePage() {
  const queue = useStore((s) => s.queue);
  const navigate = useNavigate();
  const canTake = usePermission('take-livechat-room');
  // O seletor devolve o objeto do store; filtrar dentro dele criaria um array novo a cada render e travaria a página.
  const subscriptions = useStore((s) => s.subscriptions);
  const mySubs = useMemo(() => Object.values(subscriptions).filter((x) => x.t === 'l'), [subscriptions]);
  useTick(15000);
  useEffect(() => {
    api
      .get('livechat/inquiries.queuedForUser')
      .then((r) => useStore.setState({ queue: Object.fromEntries(r.inquiries.map((i: any) => [i.rid, i])) }))
      .catch(() => {});
  }, []);
  const list = useMemo(
    () =>
      Object.values(queue).sort(
        (a, b) => (a.priority?.sortItem ?? 99) - (b.priority?.sortItem ?? 99) || String(a.slaDue ?? '9').localeCompare(String(b.slaDue ?? '9')) || a.queuedAt.localeCompare(b.queuedAt),
      ),
    [queue],
  );
  const take = async (rid: string) => {
    try {
      await api.post('livechat/inquiries.take', { inquiryId: rid });
      navigate(`/live/${rid}`);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <div className="page-title-row">
        <h1>Fila de atendimento</h1>
      </div>
      {!list.length ? (
        <Empty>Ninguém aguardando. 🎉</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Visitante</th>
              <th>Mensagem</th>
              <th>Departamento</th>
              <th>Prioridade</th>
              <th>Aguardando</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((i: any, idx) => {
              const late = i.slaDue && new Date(i.slaDue) < new Date();
              return (
                <tr key={i.rid}>
                  <td>{idx + 1}</td>
                  <td>
                    <strong>{i.v.name || i.v.username}</strong>
                  </td>
                  <td className="ellipsis-cell">{i.message}</td>
                  <td>{i.departmentName ?? '—'}</td>
                  <td>{i.priority ? <span className="pill accent">{i.priority.name}</span> : '—'}</td>
                  <td className={late ? 'neg' : ''}>
                    {formatRelative(i.queuedAt)}
                    {late && ' · SLA estourado'}
                  </td>
                  <td className="row-actions">
                    <button className="btn small" onClick={() => navigate(`/live/${i.rid}`)}>
                      Ver
                    </button>
                    {canTake && (
                      <button className="btn small primary" onClick={() => take(i.rid)}>
                        Assumir
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h2 style={{ marginTop: 24 }}>Meus atendimentos ({mySubs.length})</h2>
      {!mySubs.length ? (
        <Empty>Nenhum atendimento em andamento.</Empty>
      ) : (
        <div className="card">
          {mySubs.map((s) => (
            <button key={s.rid} className="list-row link-row" onClick={() => navigate(`/live/${s.rid}`)}>
              🎧 <strong>{s.fname || s.name}</strong>
              <span className="spacer" />
              {s.unread > 0 && <span className="badge mention">{s.unread}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CurrentChats() {
  const navigate = useNavigate();
  const [f, setF] = useState({ text: '', status: 'queued,open,onhold', departmentId: '', agent: '', from: '', to: '', tags: '' });
  const [offset, setOffset] = useState(0);
  const deps = useAsync(() => api.get('livechat/department', { count: 200 }).catch(() => ({ departments: [] })), []);
  const agents = useAsync(() => api.get('livechat/users/agent', { count: 200 }).catch(() => ({ users: [] })), []);
  const { data, loading } = useAsync(
    () =>
      api.get('livechat/rooms', {
        text: f.text || undefined,
        status: f.status || undefined,
        departmentId: f.departmentId || undefined,
        agents: f.agent || undefined,
        tags: f.tags || undefined,
        from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
        to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
        offset,
        count: 50,
      }),
    [f, offset],
  );
  const set = (patch: Partial<typeof f>) => (setF({ ...f, ...patch }), setOffset(0));
  return (
    <>
      <h1>Conversas</h1>
      <div className="filters">
        <input placeholder="Visitante, e-mail ou assunto" value={f.text} onChange={(e) => set({ text: e.target.value })} />
        <select value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="queued,open,onhold">Em andamento</option>
          <option value="queued">Na fila</option>
          <option value="open">Em atendimento</option>
          <option value="onhold">Em espera</option>
          <option value="closed">Encerradas</option>
          <option value="">Todas</option>
        </select>
        <select value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
          <option value="">Todos os departamentos</option>
          {deps.data?.departments.map((d: any) => (
            <option key={d._id} value={d._id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={f.agent} onChange={(e) => set({ agent: e.target.value })}>
          <option value="">Todos os agentes</option>
          {agents.data?.users.map((a: any) => (
            <option key={a._id} value={a._id}>
              {a.name}
            </option>
          ))}
        </select>
        <input placeholder="Tags (vírgula)" value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
        <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {loading ? (
        <Spinner />
      ) : !data?.rooms.length ? (
        <Empty>Nenhuma conversa encontrada.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Visitante</th>
              <th>Agente</th>
              <th>Departamento</th>
              <th>Status</th>
              <th>Tags</th>
              <th>Início</th>
              <th>Mensagens</th>
            </tr>
          </thead>
          <tbody>
            {data.rooms.map((r: any) => (
              <tr key={r._id} className="clickable" onClick={() => navigate(`/live/${r._id}`)}>
                <td>
                  <strong>{r.v.name}</strong>
                  {r.topic && <div className="muted small ellipsis">{r.topic}</div>}
                </td>
                <td>{r.servedBy ? `@${r.servedBy.username}` : '—'}</td>
                <td>{r.departmentName ?? '—'}</td>
                <td>
                  <span className={`pill ${r.status === 'open' ? 'accent' : ''}`}>{LIVECHAT_STATUS[r.status]}</span>
                  {r.priority && <span className="pill">{r.priority.name}</span>}
                </td>
                <td className="small">{r.tags.join(', ')}</td>
                <td className="nowrap">{formatDateTime(r.ts)}</td>
                <td>{r.messages}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </>
  );
}

function Contacts() {
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => api.get('livechat/visitors.search', { text, offset, count: 50 }), [text, offset]);
  return (
    <>
      <h1>Contatos</h1>
      <input className="search-input" placeholder="Buscar por nome, e-mail ou telefone" value={text} onChange={(e) => (setText(e.target.value), setOffset(0))} />
      {loading ? (
        <Spinner />
      ) : !data?.visitors.length ? (
        <Empty>Nenhum contato.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Telefone</th>
              <th>Conversas</th>
              <th>Última conversa</th>
            </tr>
          </thead>
          <tbody>
            {data.visitors.map((v: any) => (
              <tr key={v._id} className="clickable" onClick={() => setOpen(v)}>
                <td>
                  <strong>{v.name}</strong>
                </td>
                <td>{v.email ?? '—'}</td>
                <td>{v.phone ?? '—'}</td>
                <td>{v.chats}</td>
                <td>{v.lastChat ? formatDateTime(v.lastChat.ts) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
      {open && <ContactModal contact={open} onClose={() => (setOpen(null), reload())} />}
    </>
  );
}

function ContactModal({ contact, onClose }: { contact: any; onClose: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ name: contact.name ?? '', email: contact.email ?? '', phone: contact.phone ?? '' });
  const canEdit = usePermission('edit-livechat-contact');
  const canRemove = usePermission('remove-livechat-contact');
  const chats = useAsync(() => api.get('livechat/rooms', { visitorId: contact._id, status: '', count: 50 }).catch(() => ({ rooms: [] })), [contact._id]);
  return (
    <Modal
      wide
      title={contact.name}
      onClose={onClose}
      footer={
        <>
          {canRemove && (
            <button
              className="btn danger"
              onClick={() => confirm('Remover o contato e todo o histórico de conversas? Não dá para desfazer.') && api.del(`livechat/visitors/${contact._id}`).then(onClose).catch(fail)}
            >
              Remover contato e dados
            </button>
          )}
          <span className="spacer" />
          {canEdit && (
            <button className="btn primary" onClick={() => api.put(`livechat/visitors/${contact._id}`, f).then(onClose).catch(fail)}>
              Salvar
            </button>
          )}
        </>
      }
    >
      <div className="form">
        <div className="two-col">
          <Field label="Nome">
            <input disabled={!canEdit} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="E-mail">
            <input disabled={!canEdit} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
        </div>
        <Field label="Telefone">
          <input disabled={!canEdit} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        {Object.keys(contact.customFields ?? {}).length > 0 && (
          <div className="small">
            {Object.entries(contact.customFields).map(([k, v]) => (
              <div key={k}>
                <span className="muted">{k}:</span> {String(v)}
              </div>
            ))}
          </div>
        )}
        <h3>Histórico</h3>
        {chats.loading ? (
          <Spinner />
        ) : (
          chats.data?.rooms.map((r: any) => (
            <button key={r._id} className="list-row link-row" onClick={() => (onClose(), navigate(`/live/${r._id}`))}>
              {formatDateTime(r.ts)} · {r.servedBy ? `@${r.servedBy.username}` : 'sem agente'}
              <span className="spacer" />
              <span className="pill">{LIVECHAT_STATUS[r.status]}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

function CannedResponses() {
  const manager = usePermission('manage-livechat-canned-responses');
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => api.get('canned-responses', { text, offset, count: 50 }), [text, offset]);
  const SCOPE: Record<string, string> = { global: 'Todos', department: 'Departamento', user: 'Pessoal' };
  return (
    <>
      <div className="page-title-row">
        <h1>Respostas prontas</h1>
        <button className="btn primary" onClick={() => setEdit({ scope: manager ? 'global' : 'user', shortcut: '', text: '', tags: [] })}>
          ＋ Nova resposta
        </button>
      </div>
      <p className="muted small">
        No atendimento, digite <code>!atalho</code> para inserir. Variáveis: <code>{'{{contact.name}}'}</code>, <code>{'{{contact.email}}'}</code>, <code>{'{{agent.name}}'}</code>.
      </p>
      <input className="search-input" placeholder="Buscar" value={text} onChange={(e) => (setText(e.target.value), setOffset(0))} />
      {loading ? (
        <Spinner />
      ) : !data?.cannedResponses.length ? (
        <Empty>Nenhuma resposta pronta.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Atalho</th>
              <th>Texto</th>
              <th>Disponível para</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {data.cannedResponses.map((c: any) => (
              <tr key={c._id} className="clickable" onClick={() => setEdit(c)}>
                <td className="mono">!{c.shortcut}</td>
                <td className="ellipsis-cell">{c.text}</td>
                <td>
                  {SCOPE[c.scope]}
                  {c.departmentName ? `: ${c.departmentName}` : ''}
                </td>
                <td className="small">{c.tags.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
      {edit && <CannedForm initial={edit} manager={manager} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

function CannedForm({ initial, manager, onClose, onSaved }: { initial: any; manager: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ shortcut: initial.shortcut, text: initial.text, scope: initial.scope, departmentId: initial.departmentId ?? '', tags: (initial.tags ?? []).join(', ') });
  const deps = useAsync(() => api.get('livechat/department', { count: 200 }).catch(() => ({ departments: [] })), []);
  const save = async () => {
    try {
      await api.post('canned-responses', { _id: initial._id, ...f, tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean) });
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={initial._id ? `!${initial.shortcut}` : 'Nova resposta pronta'}
      onClose={onClose}
      footer={
        <>
          {initial._id && (
            <button className="btn danger" onClick={() => api.del(`canned-responses?_id=${initial._id}`).then(() => (onSaved(), onClose())).catch(fail)}>
              Excluir
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Atalho">
          <input value={f.shortcut} onChange={(e) => setF({ ...f, shortcut: e.target.value.replace(/\s/g, '-') })} />
        </Field>
        <Field label="Texto">
          <textarea rows={5} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        </Field>
        <Field label="Disponível para">
          <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            {manager && <option value="global">Todos os agentes</option>}
            {manager && <option value="department">Um departamento</option>}
            <option value="user">Só eu</option>
          </select>
        </Field>
        {f.scope === 'department' && (
          <Field label="Departamento">
            <select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
              <option value="">Escolha</option>
              {deps.data?.departments.map((d: any) => (
                <option key={d._id} value={d._id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Tags (vírgula)">
          <input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
