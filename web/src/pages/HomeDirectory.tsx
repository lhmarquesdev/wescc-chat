import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Subscription } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { useAcks } from '../lib/acks';
import { partyOf, useDirect } from '../lib/direct';
import { badgeCount, plural, roomIconName, roomPath } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { requestNotificationPermission } from '../lib/session';
import { useSetting, useStore } from '../lib/store';
import { Icon, type IconName } from '../components/Icon';
import { useForYou } from '../components/navState';
import { ForYouCard } from '../components/Sidebar';
import { Empty, GroupAvatar, Pager, SearchInput, SkeletonTable, Tabs, UserAvatar, useAsync } from '../components/ui';

const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
// Diretório: só a data ("22/10/2026"); a hora não ajuda a escolher um canal ou uma pessoa.
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const formatDate = (iso?: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—');

// De madrugada ainda se diz "Boa noite".
function greeting(h: number) {
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// O que há de novo numa sala, em uma linha ("3 mensagens novas · 2 tópicos com respostas").
// Num canal de avisos a linha fala de avisos, e dos que esperam o "Ciente" quando a lista já é conhecida.
function unreadLine(s: Subscription, pending = 0) {
  const parts: string[] = [];
  if (s.userMentions > 0 && s.t !== 'd') parts.push(plural(s.userMentions, 'menção a você', 'menções a você'));
  if (pending > 0) parts.push(plural(pending, 'aviso aguardando seu “Ciente”', 'avisos aguardando seu “Ciente”'));
  else if (s.unread > 0) parts.push(s.notice ? plural(s.unread, 'aviso novo', 'avisos novos') : plural(s.unread, 'mensagem nova', 'mensagens novas'));
  if (s.tunread.length) parts.push(plural(s.tunread.length, 'tópico com respostas', 'tópicos com respostas'));
  return parts.join(' · ') || 'Mensagens novas';
}

function UnreadRow({ s }: { s: Subscription }) {
  const navigate = useNavigate();
  const dmUser = s.t === 'd' && !s.name.includes(',') ? s.name : null;
  const mention = s.userMentions > 0 || s.t === 'd';
  const pending = useAcks((a) => (s.notice ? (a.byRoom[s.rid]?.pending.length ?? 0) : 0));
  return (
    <button type="button" className="home-row" onClick={() => navigate(roomPath(s))}>
      {dmUser ? (
        <UserAvatar username={dmUser} size={32} />
      ) : s.t === 'd' ? (
        <GroupAvatar usernames={s.name.split(/,\s*/)} size={32} />
      ) : (
        <span className="home-row-icon">
          <Icon name={roomIconName(s)} />
        </span>
      )}
      <span className="home-row-text">
        <span className="home-row-name">{s.fname || s.name}</span>
        <span className="home-row-sub">{unreadLine(s, pending)}</span>
      </span>
      {s.tunread.length > 0 && (
        <span className="badge thread" title="Tópicos com respostas novas">
          <Icon name="panel-threads" size={12} />
          {badgeCount(s.tunread.length)}
        </span>
      )}
      {s.unread > 0 && <span className={mention ? 'badge mention' : s.groupMentions > 0 ? 'badge group' : 'badge'}>{badgeCount(s.unread)}</span>}
      <Icon name="next" className="home-row-go" />
    </button>
  );
}

export function HomePage() {
  const title = useSetting<string>('Layout_Home_Title');
  const body = useSetting<string>('Layout_Home_Body');
  const me = useStore((s) => s.me)!;
  const subs = useStore((s) => s.subscriptions);
  const forYou = useForYou(4);
  const [askNotif, setAskNotif] = useState(() => 'Notification' in window && Notification.permission === 'default');
  const unread = useMemo(
    () =>
      Object.values(subs)
        .filter((s) => s.unread > 0 || s.tunread.length > 0)
        .sort((a, b) => b.userMentions - a.userMentions || (b._updatedAt ?? '').localeCompare(a._updatedAt ?? '')),
    [subs],
  );
  const now = new Date();
  return (
    <div className="page home-page">
      <header className="page-head">
        <h1>{title || 'Início'}</h1>
      </header>
      <div className="page-body">
        <section className="home-hello">
          <h2 className="home-greeting">
            {greeting(now.getHours())}, {me.name.split(' ')[0]}
          </h2>
          <p className="home-date">{dayFmt.format(now)}</p>
          {body && <div className="home-body">{renderMarkdown(body)}</div>}
        </section>
        {askNotif && (
          <div className="callout info home-notif">
            <Icon name="notify-prompt" />
            <span>Ative as notificações do navegador para saber quando alguém falar com você.</span>
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                requestNotificationPermission();
                setAskNotif(false);
              }}
            >
              Ativar notificações
            </button>
          </div>
        )}
        {forYou.length > 0 && (
          <section className="home-section" aria-labelledby="home-for-you">
            <h3 className="home-section-title" id="home-for-you">
              Para você
            </h3>
            <div className="for-you-grid">
              {forYou.map((i) => (
                <ForYouCard key={i.key} item={i} />
              ))}
            </div>
          </section>
        )}
        <section className="home-section" aria-labelledby="home-unread">
          <h3 className="home-section-title" id="home-unread">
            Não lidas
            {unread.length > 0 && <span className="home-count">{unread.length}</span>}
          </h3>
          {unread.length === 0 ? (
            <div className="card home-empty">
              <Empty icon="all-done" title="Tudo em dia">
                Você leu todas as mensagens.
              </Empty>
            </div>
          ) : (
            <div className="card home-list">
              {unread.map((s) => (
                <UnreadRow key={s.rid} s={s} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type DirType = 'channels' | 'users' | 'teams';

const DIR_TABS: { id: DirType; label: string; icon: IconName; search: string; empty: string; emptyText: string }[] = [
  { id: 'channels', label: 'Canais', icon: 'room-channel', search: 'Buscar canais por nome ou tópico', empty: 'Nenhum canal público ainda', emptyText: 'Os canais públicos da empresa aparecem aqui.' },
  { id: 'users', label: 'Pessoas', icon: 'account', search: 'Buscar pessoas por nome ou usuário', empty: 'Ninguém por aqui ainda', emptyText: 'As pessoas com conta ativa aparecem aqui.' },
  { id: 'teams', label: 'Times', icon: 'room-team', search: 'Buscar times', empty: 'Nenhum time ainda', emptyText: 'Times agrupam canais e pessoas de uma área.' },
];

export function DirectoryPage() {
  const { tab } = useParams();
  const type: DirType = tab === 'users' || tab === 'teams' ? tab : 'channels';
  const meta = DIR_TABS.find((t) => t.id === type)!;
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const subs = useStore((s) => s.subscriptions);
  const meId = useStore((s) => s.me?._id);
  useEffect(() => {
    const t = setTimeout(() => (setQ(text.trim()), setOffset(0)), 250);
    return () => clearTimeout(t);
  }, [text]);
  const { data, loading, error, reload } = useAsync(() => api.get('directory', { type, text: q, offset, count: 25 }), [type, q, offset]);
  const direct = useDirect();

  const openUser = async (username: string) => {
    try {
      const r = await api.post('im.create', { username });
      navigate(roomPath({ _id: r.room._id, t: 'd' }));
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };
  const join = async (rid: string) => {
    try {
      await api.post('channels.join', { roomId: rid });
      navigate(roomPath({ _id: rid, t: 'c' }));
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };
  // Botão da linha: não dispara o clique da linha inteira.
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  let content;
  if (loading && !data) content = <SkeletonTable rows={8} cols={4} />;
  else if (error)
    content = (
      <Empty
        icon="error"
        tone="danger"
        title="Não foi possível carregar o diretório"
        action={
          <button type="button" className="btn" onClick={reload}>
            Tentar de novo
          </button>
        }
      >
        {error}
      </Empty>
    );
  else if (!data?.result.length)
    content = q ? (
      <Empty
        icon="search"
        title={`Nada encontrado para “${q}”`}
        action={
          <button type="button" className="btn" onClick={() => setText('')}>
            Limpar busca
          </button>
        }
      >
        Confira a grafia ou busque por outro nome.
      </Empty>
    ) : (
      <Empty icon={meta.icon} title={meta.empty}>
        {meta.emptyText}
      </Empty>
    );
  else
    content = (
      <table className={`table directory-table${loading ? ' is-loading' : ''}`}>
        <thead>
          {type === 'users' ? (
            <tr>
              <th>Nome</th>
              <th className="dir-meta">Desde</th>
              <th className="dir-action">
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          ) : (
            <tr>
              <th>Nome</th>
              <th className="num dir-meta">Membros</th>
              <th className="dir-meta">{type === 'teams' ? 'Salas' : 'Time'}</th>
              <th className="dir-meta dir-date">Criado em</th>
              <th className="dir-action">
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          )}
        </thead>
        <tbody>
          {data.result.map((r: any) => {
            if (type === 'users') {
              // Conversa nova bloqueada pela política: explica sem chamar o servidor. Se a conversa já existe só para leitura, abre o histórico.
              // A própria linha: a etiqueta Você, sem ação (não há conversa direta consigo mesmo aqui).
              if (r._id === meId)
                return (
                  <tr key={r._id}>
                    <td>
                      <div className="cell-entity">
                        <UserAvatar username={r.username} size={32} status={r.status} />
                        <div>
                          <span className="cell-name">
                            <span className="dir-name">{r.name}</span>
                            <span className="pill tag">Você</span>
                          </span>
                          <span className="cell-sub">
                            @{r.username}
                            {r.statusText ? ` · ${r.statusText}` : ''}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="muted dir-meta">{formatDate(r.createdAt)}</td>
                    <td className="dir-action" />
                  </tr>
                );
              const st = direct.state([partyOf(r)]);
              const blocked = st.kind === 'none';
              const open = () => (st.kind === 'none' ? useStore.getState().toast(st.text) : st.kind === 'view' ? navigate(st.path) : openUser(r.username));
              return (
                <tr key={r._id} className={`clickable ${blocked ? 'blocked' : ''}`} title={st.kind === 'open' ? undefined : st.text} onClick={open}>
                  <td>
                    <div className="cell-entity">
                      <UserAvatar username={r.username} size={32} status={r.status} />
                      <div>
                        <span className="cell-name">
                          <span className="dir-name">{r.name}</span>
                        </span>
                        <span className="cell-sub">
                          @{r.username}
                          {r.statusText ? ` · ${r.statusText}` : ''}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="muted dir-meta">{formatDate(r.createdAt)}</td>
                  <td className="dir-action">
                    {blocked ? (
                      <span className="pill blocked">
                        <Icon name="direct-blocked" size={12} />
                        Sem conversa direta
                      </span>
                    ) : (
                      <div className="row-actions">
                        <button type="button" className="btn small ghost" onClick={act(open)}>
                          <Icon name={st.kind === 'view' ? 'show' : 'room-dm'} />
                          {st.kind === 'view' ? 'Ver conversa' : 'Mensagem'}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            }
            const team = type === 'teams';
            const rid = team ? r.roomId : r._id;
            const path = roomPath(team ? { _id: r.roomId, t: r.type === 1 ? 'p' : 'c' } : r);
            const member = !!subs[rid];
            return (
              <tr key={r._id} className="clickable" onClick={() => navigate(path)}>
                <td>
                  <div className="cell-entity">
                    {/* O mesmo bloco de ícone do Início e da barra lateral: o tipo da sala, sem iniciais. */}
                    <span className="dir-room-icon">
                      <Icon name={team ? 'room-team' : roomIconName(r)} />
                    </span>
                    <div>
                      <span className="cell-name">
                        <span className="dir-name">{team ? r.name : r.fname || r.name}</span>
                        {r.featured && <span className="pill accent">Destaque</span>}
                      </span>
                      {(r.topic || r.description) && <span className="cell-sub">{r.topic || r.description}</span>}
                    </div>
                  </div>
                </td>
                <td className="num dir-meta">{(r.usersCount ?? 0).toLocaleString('pt-BR')}</td>
                <td className="dir-meta">{team ? (r.roomsCount ?? 0).toLocaleString('pt-BR') : r.teamName ? <span className="dir-team">{r.teamName}</span> : <span className="muted">—</span>}</td>
                <td className="muted dir-meta dir-date">{formatDate(r.ts)}</td>
                <td className="dir-action">
                  <div className="row-actions">
                    {member || team ? (
                      <button type="button" className="btn small ghost" onClick={act(() => navigate(path))}>
                        <Icon name="nav-chats" />
                        Abrir
                      </button>
                    ) : (
                      <button type="button" className="btn small ghost" onClick={act(() => void join(rid))}>
                        <Icon name="join-room" />
                        Entrar
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );

  return (
    <div className="page directory-page">
      <header className="page-head">
        <h1>Diretório</h1>
      </header>
      <div className="page-body">
        <Tabs
          value={type}
          onChange={(v) => {
            setOffset(0);
            navigate(`/directory/${v}`, { replace: true });
          }}
          items={DIR_TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
        />
        <SearchInput className="directory-search" value={text} onChange={setText} placeholder={meta.search} />
        {content}
        {data && !error && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
      </div>
    </div>
  );
}
