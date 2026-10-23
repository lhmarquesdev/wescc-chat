import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { badgeCount, formatDateTime, formatRelative } from '../../lib/format';
import { usePermission, useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { LivechatStatus, VisitorAvatar } from '../../components/LivechatPanel';
import { useIsPhone } from '../../components/overlay';
import { isMentionBadge } from '../../components/navState';
import { confirmDialog, Empty, Field, Modal, Pager, SearchInput, SkeletonList, SkeletonTable, useAsync } from '../../components/ui';
import { OmniAnalytics } from './OmniAnalytics';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

// Disponibilidade do agente para novos atendimentos (barra lateral e navegação do Atendimento).
export function AgentStatusToggle() {
  const status = useStore((s) => s.agentStatus);
  const me = useStore((s) => s.me);
  if (!me?.roles.includes('livechat-agent')) return null;
  const on = status === 'available';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={on ? 'agent-toggle on' : 'agent-toggle'}
      title="Receber novos atendimentos"
      onClick={() => api.post('livechat/agent.status', { status: on ? 'not-available' : 'available' }).catch(fail)}
    >
      <span className="agent-dot" aria-hidden="true" />
      <span className="agent-label">{on ? 'Disponível na fila' : 'Indisponível na fila'}</span>
      <span className="toggle-track" aria-hidden="true" />
    </button>
  );
}

// Erro numa seção não derruba a navegação do Atendimento: a seção mostra o erro e o resto continua.
class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card omni-empty">
        <Empty
          icon="error"
          tone="danger"
          title="Algo deu errado"
          action={
            <button type="button" className="btn" onClick={() => location.reload()}>
              Recarregar
            </button>
          }
        >
          Recarregue a página. Se continuar, avise o suporte.
        </Empty>
      </div>
    );
  }
}

export function OmnichannelPage() {
  const { section = 'queue' } = useParams();
  const canCurrent = usePermission(['view-livechat-rooms', 'view-l-room']);
  const canContacts = usePermission('view-livechat-contacts');
  const canCanned = usePermission(['view-canned-responses', 'manage-livechat-canned-responses']);
  const canAnalytics = usePermission('view-livechat-analytics');
  const canManage = usePermission('view-livechat-manager');
  const queueCount = useStore((s) => Object.keys(s.queue).length);
  const nav = useRef<HTMLElement>(null);
  // No celular a navegação é uma faixa que rola para o lado: a aba ativa fica à vista também quando a página abre direto nela.
  useEffect(() => {
    nav.current?.querySelector('a.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [section]);
  return (
    <div className="page with-nav omni-page">
      <nav className="page-nav" aria-label="Atendimento" ref={nav}>
        <h2>Atendimento</h2>
        <NavLink to="/omnichannel/queue">
          <Icon name="queue" />
          Fila
          {queueCount > 0 && <span className="badge group">{badgeCount(queueCount)}</span>}
        </NavLink>
        {canCurrent && (
          <NavLink to="/omnichannel/current">
            <Icon name="conversations" />
            Conversas
          </NavLink>
        )}
        {canContacts && (
          <NavLink to="/omnichannel/contacts">
            <Icon name="contacts" />
            Contatos
          </NavLink>
        )}
        {canCanned && (
          <NavLink to="/omnichannel/canned">
            <Icon name="canned" />
            Respostas prontas
          </NavLink>
        )}
        {canAnalytics && (
          <NavLink to="/omnichannel/analytics">
            <Icon name="reports" />
            Relatórios
          </NavLink>
        )}
        {canManage && (
          <NavLink to="/admin/omnichannel">
            <Icon name="manage" />
            Gestão
          </NavLink>
        )}
      </nav>
      <div className="page-body">
        <SectionBoundary key={section}>
          {section === 'queue' && <QueuePage />}
          {section === 'current' && <CurrentChats />}
          {section === 'contacts' && <Contacts />}
          {section === 'canned' && <CannedResponses />}
          {section === 'analytics' && <OmniAnalytics />}
        </SectionBoundary>
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
      <div className="page-title-row page-head">
        <h1>Fila de atendimento</h1>
        {list.length > 0 && <span className="pill">{list.length === 1 ? '1 aguardando' : `${list.length} aguardando`}</span>}
      </div>
      {/* No computador o interruptor fica na barra lateral; no celular, aqui no topo da fila (a barra do título vem
          antes: ela é o primeiro filho do .page-body, como nas outras páginas). */}
      <div className="omni-agent">
        <AgentStatusToggle />
      </div>
      {!list.length ? (
        <div className="card omni-empty">
          <Empty icon="all-done" title="Ninguém aguardando">
            Novos atendimentos aparecem aqui assim que chegarem.
          </Empty>
        </div>
      ) : (
        <div className="card omni-flush">
          <table className="table stack queue-table">
            <thead>
              <tr>
                <th className="num queue-pos omni-wide">#</th>
                <th>Visitante</th>
                <th>Mensagem</th>
                <th className="omni-wide">Departamento</th>
                <th className="omni-wide">Prioridade</th>
                <th>Aguardando</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((i: any, idx) => {
                const late = i.slaDue && new Date(i.slaDue) < new Date();
                return (
                  <tr key={i.rid}>
                    <td className="num queue-pos omni-wide">{idx + 1}</td>
                    <td className="queue-who">
                      <div className="cell-entity">
                        <VisitorAvatar name={i.v.name || i.v.username} size={28} />
                        <div>
                          <span className="cell-name">{i.v.name || i.v.username}</span>
                          {i.v.email && <span className="cell-sub omni-wide-only">{i.v.email}</span>}
                          {/* Cartão estreito: departamento e prioridade numa linha só, no lugar das colunas. */}
                          <span className="cell-sub omni-narrow">{[i.departmentName, i.priority?.name].filter(Boolean).join(' · ') || i.v.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="queue-msg" title={i.message}>
                      <span className="queue-msg-text">{i.message}</span>
                    </td>
                    <td className="omni-wide omni-cut">{i.departmentName ?? <span className="muted">—</span>}</td>
                    <td className="omni-wide nowrap">{i.priority ? <span className="pill">{i.priority.name}</span> : <span className="muted">—</span>}</td>
                    <td className="nowrap queue-since">
                      <span className="queue-wait">
                        <Icon name="wait-time" size={14} />
                        {formatRelative(i.queuedAt)}
                      </span>
                      {late && <span className="pill err dot">SLA estourado</span>}
                    </td>
                    <td className="num queue-act">
                      <div className="row-actions">
                        <button className="btn small ghost" onClick={() => navigate(`/live/${i.rid}`)}>
                          Ver
                        </button>
                        {canTake && (
                          <button className="btn small primary" onClick={() => take(i.rid)}>
                            Assumir
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="omni-section-head">
        <h2>Meus atendimentos</h2>
        {mySubs.length > 0 && <span className="pill">{mySubs.length}</span>}
      </div>
      {!mySubs.length ? (
        <Empty>Nenhum atendimento em andamento. Assuma uma conversa da fila para começar.</Empty>
      ) : (
        <div className="card omni-flush omni-mine">
          {mySubs.map((s) => (
            <button key={s.rid} type="button" className="list-row link-row" onClick={() => navigate(`/live/${s.rid}`)}>
              <VisitorAvatar name={s.fname || s.name} size={32} />
              <span className="omni-mine-name">{s.fname || s.name}</span>
              <span className="spacer" />
              {/* Mesmo selo da barra lateral: vermelho só com menção. */}
              {s.unread > 0 && <span className={isMentionBadge(s) ? 'badge mention' : 'badge'}>{badgeCount(s.unread)}</span>}
              <Icon name="next" className="omni-mine-go" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CurrentChats() {
  const navigate = useNavigate();
  const phone = useIsPhone();
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
  const filtered = f.text || f.status !== 'queued,open,onhold' || f.departmentId || f.agent || f.tags || f.from || f.to;
  const [sheet, setSheet] = useState(false);
  // Filtros fora do padrão (a busca fica de fora: ela continua à vista).
  const activeFilters = [f.status !== 'queued,open,onhold', f.departmentId, f.agent, f.tags, f.from || f.to].filter(Boolean).length;
  const clearFilters = () => (setF({ text: f.text, status: 'queued,open,onhold', departmentId: '', agent: '', from: '', to: '', tags: '' }), setOffset(0));
  // Na folha do celular cada controle ganha o rótulo; na barra do computador o rótulo é o próprio texto do controle.
  const filterControls = (labeled: boolean) => {
    const wrap = (label: string, el: ReactNode) => (labeled ? <Field label={label}>{el}</Field> : el);
    return (
      <>
        {wrap(
          'Situação',
          <select aria-label="Situação" value={f.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="queued,open,onhold">Em andamento</option>
            <option value="queued">Na fila</option>
            <option value="open">Em atendimento</option>
            <option value="onhold">Em espera</option>
            <option value="closed">Encerradas</option>
            <option value="">Todas</option>
          </select>,
        )}
        {wrap(
          'Departamento',
          <select aria-label="Departamento" value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
            <option value="">Todos os departamentos</option>
            {deps.data?.departments.map((d: any) => (
              <option key={d._id} value={d._id}>
                {d.name}
              </option>
            ))}
          </select>,
        )}
        {wrap(
          'Agente',
          <select aria-label="Agente" value={f.agent} onChange={(e) => set({ agent: e.target.value })}>
            <option value="">Todos os agentes</option>
            {agents.data?.users.map((a: any) => (
              <option key={a._id} value={a._id}>
                {a.name}
              </option>
            ))}
          </select>,
        )}
        {wrap('Tags', <input className="omni-tags" aria-label="Tags" placeholder="Tags, separadas por vírgula" value={f.tags} onChange={(e) => set({ tags: e.target.value })} />)}
        {wrap(
          'Período',
          <div className="omni-dates" role="group" aria-label="Período">
            <input type="date" aria-label="De" title="De" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <span aria-hidden="true">–</span>
            <input type="date" aria-label="Até" title="Até" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </div>,
        )}
      </>
    );
  };
  return (
    <>
      <div className="page-title-row page-head">
        <h1>Conversas</h1>
        {data && <span className="pill">{data.total === 1 ? '1 conversa' : `${data.total} conversas`}</span>}
      </div>
      <div className="omni-filters">
        <SearchInput className="omni-search" placeholder="Visitante, e-mail ou assunto" value={f.text} onChange={(text) => set({ text })} />
        {phone ? (
          // Celular: os cinco filtros numa folha, atrás de um botão só (eles ocupavam a tela antes do primeiro resultado).
          <button type="button" className="btn omni-filter-btn" onClick={() => setSheet(true)}>
            <Icon name="search-filters" />
            Filtros
            {activeFilters > 0 && <span className="badge">{activeFilters}</span>}
          </button>
        ) : (
          <div className="filters">
            {filterControls(false)}
            {filtered && (
              <button type="button" className="btn ghost" onClick={clearFilters}>
                Limpar filtros
              </button>
            )}
          </div>
        )}
      </div>
      {phone && sheet && (
        <Modal
          title="Filtros"
          variant="sheet"
          onClose={() => setSheet(false)}
          footer={
            <>
              <button type="button" className="btn" disabled={!activeFilters} onClick={clearFilters}>
                Limpar
              </button>
              <button type="button" className="btn primary" onClick={() => setSheet(false)}>
                Ver conversas
              </button>
            </>
          }
        >
          <div className="form">{filterControls(true)}</div>
        </Modal>
      )}
      {loading && !data ? (
        <SkeletonTable rows={6} cols={5} />
      ) : !data?.rooms.length ? (
        <div className="card omni-empty">
          <Empty icon="conversations" title="Nenhuma conversa encontrada">
            {filtered ? 'Confira os filtros ou busque por outro visitante.' : 'As conversas do Atendimento aparecem aqui.'}
          </Empty>
        </div>
      ) : (
        <div className="card omni-flush">
          <table className="table stack omni-chats">
            <thead>
              <tr>
                <th>Visitante</th>
                <th>Agente</th>
                <th className="omni-wide">Departamento</th>
                <th>Situação</th>
                <th className="omni-wide">Tags</th>
                <th>Início</th>
                <th className="num omni-wide">Mensagens</th>
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r: any) => (
                <tr key={r._id} className="clickable" tabIndex={0} onClick={() => navigate(`/live/${r._id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/live/${r._id}`)}>
                  <td className="omni-chats-who">
                    <div className="cell-entity">
                      <VisitorAvatar name={r.v.name} size={28} />
                      <div>
                        <span className="cell-name">{r.v.name}</span>
                        {r.topic && <span className="cell-sub omni-wide-only">{r.topic}</span>}
                        {/* Sem a coluna do departamento, ele vem antes do assunto. */}
                        {(r.departmentName || r.topic) && <span className="cell-sub omni-mid">{[r.departmentName, r.topic].filter(Boolean).join(' · ')}</span>}
                        {/* Cartão compacto: agente e departamento numa linha, a hora na de baixo (juntos, cortavam no celular). */}
                        <span className="cell-sub omni-phone">
                          {[r.servedBy ? r.servedBy.name || `@${r.servedBy.username}` : 'Sem agente', r.departmentName].filter(Boolean).join(' · ')}
                        </span>
                        <span className="cell-sub omni-phone">{formatRelative(r.ts)}</span>
                      </div>
                    </div>
                  </td>
                  <td className="omni-col omni-cut omni-chats-agent">{r.servedBy ? r.servedBy.name || `@${r.servedBy.username}` : <span className="muted">—</span>}</td>
                  <td className="omni-wide omni-cut">{r.departmentName ?? <span className="muted">—</span>}</td>
                  <td className="omni-chats-st">
                    <span className="omni-pills">
                      <LivechatStatus status={r.status} />
                      {r.priority && <span className="pill">{r.priority.name}</span>}
                    </span>
                  </td>
                  <td className="omni-wide">
                    {r.tags.length ? (
                      <span className="omni-pills">
                        {r.tags.map((t: string) => (
                          <span key={t} className="pill">
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap omni-col">
                    <time dateTime={r.ts}>{formatDateTime(r.ts)}</time>
                  </td>
                  <td className="num omni-wide">{r.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <div className="page-title-row page-head">
        <h1>Contatos</h1>
        {data && <span className="pill">{data.total === 1 ? '1 contato' : `${data.total} contatos`}</span>}
      </div>
      <SearchInput placeholder="Buscar por nome, e-mail ou telefone" value={text} onChange={(v) => (setText(v), setOffset(0))} />
      {loading && !data ? (
        <SkeletonTable rows={6} cols={4} />
      ) : !data?.visitors.length ? (
        <div className="card omni-empty">
          <Empty icon="contacts" title={text ? `Nada encontrado para "${text}"` : 'Nenhum contato ainda'}>
            {text ? 'Confira a grafia ou busque por outro nome.' : 'Quem conversa pelo Atendimento vira um contato aqui.'}
          </Empty>
        </div>
      ) : (
        <div className="card omni-flush">
          <table className="table stack omni-contacts">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="omni-wide">E-mail</th>
                <th>Telefone</th>
                <th className="num">Conversas</th>
                <th>Última conversa</th>
              </tr>
            </thead>
            <tbody>
              {data.visitors.map((v: any) => (
                <tr key={v._id} className="clickable" tabIndex={0} onClick={() => setOpen(v)} onKeyDown={(e) => e.key === 'Enter' && setOpen(v)}>
                  <td className="omni-contacts-who">
                    <div className="cell-entity">
                      <VisitorAvatar name={v.name} size={28} />
                      <div>
                        <span className="cell-name">{v.name}</span>
                        {/* Sem a coluna do e-mail, ele vai para baixo do nome. */}
                        {v.email && <span className="cell-sub omni-mid">{v.email}</span>}
                        {/* Cartão compacto: e-mail (ou telefone) numa linha e a última conversa na de baixo. */}
                        {(v.email || v.phone) && <span className="cell-sub omni-phone">{v.email || v.phone}</span>}
                        {v.lastChat && <span className="cell-sub omni-phone">Última conversa {formatRelative(v.lastChat.ts)}</span>}
                      </div>
                    </div>
                  </td>
                  <td className="omni-wide omni-cut">{v.email ?? <span className="muted">—</span>}</td>
                  <td className="nowrap omni-col">{v.phone ?? <span className="muted">—</span>}</td>
                  <td className="num omni-contacts-n">
                    <span className="omni-count" title={v.chats === 1 ? '1 conversa' : `${v.chats} conversas`}>
                      <Icon name="conversations" size={12} />
                      {v.chats}
                    </span>
                  </td>
                  <td className="nowrap omni-col">{v.lastChat ? formatDateTime(v.lastChat.ts) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              onClick={async () => {
                const yes = await confirmDialog({
                  title: `Remover ${contact.name}?`,
                  body: 'O contato e todo o histórico de conversas dele serão apagados. Não dá para desfazer.',
                  confirmLabel: 'Remover contato',
                  danger: true,
                });
                if (yes) api.del(`livechat/visitors/${contact._id}`).then(onClose).catch(fail);
              }}
            >
              <Icon name="delete" />
              Remover contato e dados
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {canEdit ? 'Cancelar' : 'Fechar'}
          </button>
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
          <dl className="lc-kv">
            {Object.entries(contact.customFields).map(([k, v]) => (
              <div key={k} className="lc-kv-row">
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="omni-section-head">
          <h3>Histórico</h3>
          {chats.data && <span className="pill">{chats.data.rooms.length}</span>}
        </div>
        {chats.loading ? (
          <SkeletonList n={3} />
        ) : !chats.data?.rooms.length ? (
          <Empty>Nenhuma conversa com este contato.</Empty>
        ) : (
          <div className="omni-history">
            {chats.data.rooms.map((r: any) => (
              <button key={r._id} type="button" className="list-row link-row" onClick={() => (onClose(), navigate(`/live/${r._id}`))}>
                <Icon name="room-livechat" />
                <time dateTime={r.ts}>{formatDateTime(r.ts)}</time>
                <span className="muted">{r.servedBy ? r.servedBy.name || `@${r.servedBy.username}` : 'Sem agente'}</span>
                <span className="spacer" />
                <LivechatStatus status={r.status} />
              </button>
            ))}
          </div>
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
      <div className="page-title-row page-head">
        <h1>Respostas prontas</h1>
        <button className="btn primary" onClick={() => setEdit({ scope: manager ? 'global' : 'user', shortcut: '', text: '', tags: [] })}>
          <Icon name="add" />
          Nova resposta
        </button>
      </div>
      <p className="omni-hint">
        No atendimento, digite <kbd>!atalho</kbd> para inserir. Variáveis: <code>{'{{contact.name}}'}</code>, <code>{'{{contact.email}}'}</code>, <code>{'{{agent.name}}'}</code>.
      </p>
      <SearchInput placeholder="Buscar por atalho ou texto" value={text} onChange={(v) => (setText(v), setOffset(0))} />
      {loading && !data ? (
        <SkeletonTable rows={5} cols={4} />
      ) : !data?.cannedResponses.length ? (
        <div className="card omni-empty">
          <Empty
            icon="canned"
            title={text ? `Nada encontrado para "${text}"` : 'Nenhuma resposta pronta'}
            action={
              !text && (
                <button className="btn primary" onClick={() => setEdit({ scope: manager ? 'global' : 'user', shortcut: '', text: '', tags: [] })}>
                  <Icon name="add" />
                  Nova resposta
                </button>
              )
            }
          >
            {text ? 'Confira a grafia ou busque por outro atalho.' : 'Textos que você usa sempre, inseridos com !atalho durante o atendimento.'}
          </Empty>
        </div>
      ) : (
        <div className="card omni-flush">
          <table className="table stack omni-canned">
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
                <tr key={c._id} className="clickable" tabIndex={0} onClick={() => setEdit(c)} onKeyDown={(e) => e.key === 'Enter' && setEdit(c)}>
                  <td className="omni-canned-code">
                    <code className="omni-shortcut">!{c.shortcut}</code>
                  </td>
                  <td className="ellipsis-cell omni-canned-text" title={c.text}>
                    {c.text}
                  </td>
                  <td className="omni-canned-scope">
                    {SCOPE[c.scope]}
                    {c.departmentName ? `: ${c.departmentName}` : ''}
                  </td>
                  {/* Sem tags, a linha compacta não mostra o campo vazio. */}
                  <td className={c.tags.length ? 'omni-canned-tags' : 'omni-canned-tags omni-col'}>
                    {c.tags.length ? (
                      <span className="omni-pills">
                        {c.tags.map((t: string) => (
                          <span key={t} className="pill">
                            {t}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            <button
              className="btn danger"
              onClick={async () => {
                const yes = await confirmDialog({ title: `Excluir !${initial.shortcut}?`, body: 'A resposta pronta deixa de aparecer para os agentes.', confirmLabel: 'Excluir', danger: true });
                if (yes) api.del(`canned-responses?_id=${initial._id}`).then(() => (onSaved(), onClose())).catch(fail);
              }}
            >
              <Icon name="delete" />
              Excluir
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
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
