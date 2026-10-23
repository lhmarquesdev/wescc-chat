import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Message, Room } from '@shared/index';
import { api, ApiError, errorMessage } from '../lib/api';
import { roomDisplayName, roomIconName, roomPath, STATUS_LABEL } from '../lib/format';
import { realtime } from '../lib/realtime';
import { renderMarkdown } from '../lib/markdown';
import { startCall } from '../lib/calls';
import { sendText } from '../lib/direct';
import { canWithRoles, useSetting, useStore } from '../lib/store';
import { Composer } from '../components/Composer';
import { Icon, type IconName } from '../components/Icon';
import { LIVECHAT_STATUS, LivechatActions } from '../components/LivechatPanel';
import { CreateModal } from '../components/CreateModal';
import { MessageGateContext } from '../components/MessageItem';
import { MessageList } from '../components/MessageList';
import { NoticeBar } from '../components/NoticeBar';
import { RoomPanel, type PanelId } from '../components/RoomPanels';
import { ThreadPanel } from '../components/ThreadPanel';
import { UserCard } from '../components/UserCard';
import { useIsPhone } from '../components/overlay';
import { Empty, Menu, Skeleton, SkeletonMessages, UserAvatar, confirmDialog, useDelay } from '../components/ui';

const notLive = (r: Room) => r.t !== 'l';
const PANELS: { id: PanelId; icon: IconName; label: string; when?: (r: Room) => boolean }[] = [
  { id: 'livechat', icon: 'panel-livechat', label: 'Atendimento', when: (r) => r.t === 'l' },
  { id: 'info', icon: 'panel-info', label: 'Informações', when: notLive },
  { id: 'threads', icon: 'panel-threads', label: 'Tópicos' },
  { id: 'discussions', icon: 'panel-discussions', label: 'Discussões', when: (r) => !r.prid && notLive(r) },
  { id: 'team', icon: 'panel-team', label: 'Canais do time', when: (r) => !!r.teamMain },
  { id: 'members', icon: 'panel-members', label: 'Membros', when: (r) => notLive(r) && (r.t !== 'd' || (r.uids?.length ?? 0) > 2) },
  { id: 'search', icon: 'panel-search', label: 'Buscar mensagens' },
  { id: 'files', icon: 'panel-files', label: 'Arquivos' },
  { id: 'pinned', icon: 'panel-pinned', label: 'Fixadas' },
  { id: 'starred', icon: 'panel-starred', label: 'Favoritas' },
  { id: 'mentions', icon: 'panel-mentions', label: 'Menções' },
  { id: 'notifications', icon: 'panel-notifications', label: 'Notificações' },
  { id: 'invite', icon: 'panel-invite', label: 'Link de convite', when: (r) => r.t !== 'd' && notLive(r) },
  { id: 'prune', icon: 'panel-prune', label: 'Limpar histórico', when: (r) => r.t !== 'd' && notLive(r) },
];

// Atalhos do cabeçalho, na ordem em que aparecem. Os que não cabem vão para o menu Mais.
const SHORTCUTS: PanelId[] = ['threads', 'members', 'info', 'search'];

// Compactação pela largura do próprio cabeçalho (o painel aberto também a reduz), não pela da tela.
function shortcutsFor(width: number, calls: boolean): PanelId[] {
  if (width < 440) return calls ? [] : ['members'];
  if (width < 560) return ['members'];
  if (width < 720) return ['threads', 'members', 'info'];
  return SHORTCUTS;
}

// Largura de um elemento, medida antes da pintura e acompanhada por ResizeObserver.
function useWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.borderBoxSize?.[0]?.inlineSize ?? e.target.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

// Nome de quem digita: o evento só traz o @usuário. Vale o nome das mensagens já carregadas da sala; sem ele, busca
// uma vez em users.info. Só o primeiro nome, para a linha ficar curta.
const typingNames = new Map<string, string>();
const typingAsked = new Set<string>();
function firstName(name: string | undefined, username: string) {
  return name?.trim().split(/\s+/)[0] || username;
}
function useTypingName(rid: string) {
  const list = useStore((s) => s.messages[rid]?.list);
  const [, bump] = useState(0);
  return (username: string) => {
    const known = typingNames.get(username);
    if (known) return known;
    const m = list && [...list].reverse().find((x) => x.u.username === username && x.u.name);
    if (m) return firstName(m.u.name, username);
    if (!typingAsked.has(username)) {
      typingAsked.add(username);
      api
        .get('users.info', { username })
        .then((r) => {
          typingNames.set(username, firstName(r.user?.name, username));
          bump((x) => x + 1);
        })
        .catch(() => {});
    }
    return username;
  };
}

function TypingIndicator({ id }: { id: string }) {
  const typing = useStore((s) => s.typing[id]);
  const nameOf = useTypingName(id.split(':')[0]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const names = Object.entries(typing ?? {})
    .filter(([, ts]) => Date.now() - ts < 6000)
    .map(([u]) => nameOf(u));
  // A linha fica sobre o fim da lista: não ocupa espaço quando ninguém digita.
  return (
    <div className="typing" aria-live="polite">
      {names.length > 0 && (
        <div className="typing-row">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="typing-text">
            {names.length === 1 ? (
              <>
                <strong>{names[0]}</strong> está digitando…
              </>
            ) : names.length === 2 ? (
              <>
                <strong>{names[0]}</strong> e <strong>{names[1]}</strong> estão digitando…
              </>
            ) : (
              'Várias pessoas estão digitando…'
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function LivechatJoinBar({ rid }: { rid: string }) {
  const room = useStore((s) => s.livechatRooms[rid]);
  if (!room) return <span>Conversa de atendimento.</span>;
  if (room.status === 'closed') return <span>Esta conversa foi encerrada {room.closedAt ? `em ${new Date(room.closedAt).toLocaleString('pt-BR')}` : ''}.</span>;
  return (
    <span>
      {LIVECHAT_STATUS[room.status]}
      {room.servedBy ? ` com @${room.servedBy.username}` : ''}. Você está acompanhando como supervisor.
    </span>
  );
}

// Anúncio da sala: uma linha, com "Ver mais" quando o texto não cabe.
function Announcement({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className={open ? 'announcement open' : 'announcement'}>
      <Icon name="announcement" />
      <span className="announcement-text" ref={ref}>
        {renderMarkdown(text)}
      </span>
      {(cut || open) && (
        <button type="button" className="link announcement-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Ver menos' : 'Ver mais'}
        </button>
      )}
    </div>
  );
}

const BackButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="icon-btn mobile-only room-back" title="Voltar" aria-label="Voltar" onClick={onClick}>
    <Icon name="back" size={20} />
  </button>
);

function RoomLoading() {
  const ready = useDelay(250);
  return (
    <div className="room loading">
      <div className="room-main">
        <div className="room-head-skeleton" aria-hidden="true">
          {ready && (
            <>
              <Skeleton circle height={32} />
              <span className="room-head-skeleton-lines">
                <Skeleton width={180} height={14} />
                <Skeleton width={260} height={10} />
              </span>
            </>
          )}
        </div>
        <SkeletonMessages />
      </div>
    </div>
  );
}

export function RoomPage() {
  const { rid = '', '*': rest = '' } = useParams();
  const tmid = rest.match(/^thread\/([^/]+)/)?.[1];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sub = useStore((s) => s.subscriptions[rid]);
  const roomLive = useStore((s) => s.rooms[rid]);
  const me = useStore((s) => s.me)!;
  const [room, setRoom] = useState<(Room & { muted?: string[]; team?: any; parent?: any; joinCodeRequired?: boolean }) | null>(null);
  const [error, setError] = useState<{ text: string; missing: boolean } | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [discussionFrom, setDiscussionFrom] = useState<Message | null>(null);
  const [userCard, setUserCard] = useState<{ username: string; anchor: HTMLElement | null } | null>(null);
  const [roomRoles, setRoomRoles] = useState<string[]>([]);
  const panel = params.get('tab') as PanelId | null;
  const presence = useStore((s) => (room?.t === 'd' && sub && !sub.name.includes(',') ? s.presence[sub.name] : undefined));
  const threadsOn = useSetting<boolean>('Threads_enabled');
  const callsEnabled = useSetting<boolean>('Calls_Enabled');
  const [setHeader, headerWidth] = useWidth();
  const phone = useIsPhone();

  // O cartão do usuário abre junto do nome ou avatar clicado: guarda o alvo do último clique (fase de captura,
  // antes do onClick do React) para ancorar o popover.
  const lastClick = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      lastClick.current = e.target instanceof HTMLElement ? e.target : null;
    };
    document.addEventListener('click', h, true);
    return () => document.removeEventListener('click', h, true);
  }, []);
  const openUserCard = useCallback((username: string) => {
    const t = lastClick.current;
    const anchor = t?.isConnected ? t.closest<HTMLElement>('.msg-name, .clickable, .mention, .member, button, a') ?? t : null;
    setUserCard({ username, anchor });
  }, []);

  const loadRoom = useCallback(async () => {
    try {
      const r = await api.get('rooms.info', { roomId: rid });
      setRoom(r.room);
      useStore.getState().upsertRoom(r.room);
      setError(null);
    } catch (e) {
      setError({ text: errorMessage(e), missing: e instanceof ApiError && e.status < 500 });
    }
  }, [rid]);

  useEffect(() => {
    setRoom(null);
    setEditing(null);
    setQuoting(null);
    setUserCard(null);
    void loadRoom();
  }, [rid, loadRoom]);

  // Permissões ou papéis de alguém da conversa mudaram: a política da DM (e quem publica) pode ter mudado.
  // A regra (escopo) também muda a política. O evento da sala não traz a lista de silenciados: quando a pessoa é
  // silenciada ou liberada aqui, busca de novo.
  const dmUids = room?.t === 'd' ? (room.uids ?? []).join(',') : '';
  // Discussão criada numa DM: a política vem da DM de origem, cujos participantes a web não conhece aqui.
  const fromDirect = !!room?.direct && room.t !== 'd';
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'permissions.changed' || (ev.type === 'user' && ev.user.roles && (fromDirect || dmUids.split(',').includes(ev.user._id)))) void loadRoom();
      else if ((dmUids || fromDirect) && ev.type === 'settings.changed' && ev.settings.some((s) => s._id === 'Direct_Restriction_Scope')) void loadRoom();
      else if (ev.type === 'message' && ev.message.rid === rid && (ev.message.t === 'user-muted' || ev.message.t === 'user-unmuted') && ev.message.msg === me.username) void loadRoom();
    });
    return () => {
      off();
    };
  }, [dmUids, fromDirect, loadRoom, rid, me.username]);

  useEffect(() => {
    if (roomLive && room && roomLive._updatedAt !== room._updatedAt) setRoom((r) => (r ? { ...r, ...roomLive } : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomLive]);

  // Assiste salas públicas sem ser membro (pré-visualização).
  useEffect(() => {
    if (!sub && room?.t === 'c') {
      realtime.watch(rid);
      return () => realtime.unwatch(rid);
    }
  }, [sub, room?.t, rid]);

  useEffect(() => {
    if (sub) setRoomRoles(sub.roles);
    else setRoomRoles([]);
  }, [sub]);

  const roles = useMemo(() => [...me.roles, ...roomRoles], [me.roles, roomRoles]);
  const canModerate = roles.some((r) => ['admin', 'owner', 'moderator'].includes(r));

  const setPanel = (p: PanelId | null) => {
    if (p) params.set('tab', p);
    else params.delete('tab');
    setParams(params);
  };

  const canPostRO = canWithRoles('post-readonly', roles);
  const muted = !!room?.muted?.includes(me.username);
  const directBlocked = sendText(room);
  const disabledReason = !room
    ? undefined
    : room.archived
      ? 'Esta sala está arquivada.'
      : directBlocked
        ? directBlocked
        : muted
          ? 'Você está silenciado nesta sala.'
          : room.ro && !canPostRO
            ? room.notice
              ? 'Este é um canal de avisos: só os publicadores enviam mensagens.'
              : 'Esta sala é somente leitura.'
            : undefined;
  // As mesmas recusas do servidor: reagir não exige poder escrever (canal de avisos com reações), mas sala arquivada,
  // silêncio e DM bloqueada também barram a reação. Discussão e edição seguem as regras de envio.
  const canReact = !!room && !room.archived && !muted && room.direct?.canSend !== false && (!room.ro || room.reactWhenReadOnly || canPostRO);
  // Discussão dentro de discussão o servidor também recusa.
  const canDiscuss = !disabledReason && !room?.prid && (canWithRoles('start-discussion', roles) || canWithRoles('start-discussion-other-user', roles));
  // "Ocultar a lista de membros": o servidor recusa a lista para quem não tem view-broadcast-member-list.
  const membersHidden = !!room?.broadcast && !canWithRoles('view-broadcast-member-list', roles);
  // Recibos de leitura mostram quem está na sala e quem já confirmou: num canal de avisos (ou com a lista oculta) só
  // para quem publica ou vê a lista.
  const canSeeReceipts = canWithRoles('view-message-read-receipts', roles);
  const receiptsLimited = !!(room?.notice || room?.broadcast);
  const canSeeLimitedReceipts = canPostRO || (!!room?.broadcast && !membersHidden);
  // Vale para a lista e para a thread (que monta as próprias ações).
  const gate = useMemo(
    () => ({ canReact, canReply: !disabledReason, canDiscuss, canSeeReceipts, receiptsLimited, canSeeLimitedReceipts }),
    [canReact, disabledReason, canDiscuss, canSeeReceipts, receiptsLimited, canSeeLimitedReceipts],
  );

  const actions = useMemo(
    () => ({
      onReplyThread: (m: Message) => threadsOn && navigate(`${roomPath({ _id: rid, t: room?.t ?? 'c' })}/thread/${m._id}`),
      onEdit: (m: Message) => setEditing(m),
      onQuote: (m: Message) => setQuoting(m),
      onDiscussion: (m: Message) => setDiscussionFrom(m),
      onUserClick: openUserCard,
      ...gate,
    }),
    [navigate, rid, room?.t, threadsOn, gate, openUserCard],
  );

  const editLast = () => {
    const list = useStore.getState().messages[rid]?.list ?? [];
    const mine = [...list].reverse().find((m) => m.u._id === me._id && !m.t);
    if (mine) setEditing(mine);
  };

  if (error)
    return (
      <div className="room">
        <div className="room-main">
          {/* No computador o estado vazio já tem "Voltar às conversas": o cabeçalho vazio só fica no celular, com a seta. */}
          {phone && (
            <header className="room-header">
              <BackButton onClick={() => navigate('/home')} />
            </header>
          )}
          <div className="room-error" role="alert">
            {error.missing ? (
              <Empty
                icon="error"
                tone="danger"
                title="Sala não encontrada"
                action={
                  <button type="button" className="btn primary" onClick={() => navigate('/home')}>
                    Voltar às conversas
                  </button>
                }
              >
                Ela pode ter sido apagada ou você não tem acesso.
              </Empty>
            ) : (
              <Empty
                icon="error"
                tone="danger"
                title="Algo deu errado"
                action={
                  <>
                    <button type="button" className="btn primary" onClick={() => navigate('/home')}>
                      Voltar às conversas
                    </button>
                    <button type="button" className="btn" onClick={() => location.reload()}>
                      Recarregar
                    </button>
                  </>
                }
              >
                {error.text}
              </Empty>
            )}
          </div>
        </div>
      </div>
    );
  if (!room) return <RoomLoading />;

  const name = roomDisplayName(sub, room);
  const join = async () => {
    try {
      const code = room.joinCodeRequired ? prompt('Esta sala exige um código de acesso:') ?? undefined : undefined;
      await api.post('channels.join', { roomId: rid, joinCode: code });
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };
  const callBlocked = room.direct?.canCall === false ? room.direct.callBlockedReason : undefined;
  const dmUser = room.t === 'd' && sub && !sub.name.includes(',') ? sub.name : null;
  const panels = PANELS.filter((p) => (!p.when || p.when(room)) && !(p.id === 'members' && membersHidden));
  const hasCalls = !!(dmUser && callsEnabled && room.uids?.length === 2);
  const inHeader = new Set(shortcutsFor(headerWidth, hasCalls));
  const shortcuts = SHORTCUTS.map((id) => panels.find((p) => p.id === id)).filter((p): p is (typeof PANELS)[number] => !!p && inHeader.has(p.id));
  const menuPanels = panels.filter((p) => !shortcuts.includes(p));
  const hasInfo = panels.some((p) => p.id === 'info');
  const closePanel = () => (tmid ? navigate(roomPath(room)) : setPanel(null));
  const favorite = () => api.post('rooms.favorite', { roomId: rid, favorite: !sub?.f }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
  const leave = async () => {
    const ok = await confirmDialog({ title: `Sair de ${room.prid ? name : `#${name}`}?`, body: 'Você deixa de receber as mensagens desta sala.', confirmLabel: 'Sair da sala', danger: true });
    if (ok) api.post('rooms.leave', { roomId: rid }).then(() => navigate('/home')).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
  };
  const status = presence?.status ?? 'offline';

  return (
    <MessageGateContext.Provider value={gate}>
      <div className={`room ${panel || tmid ? 'with-panel' : ''}`}>
        <div className="room-main">
          <header className="room-header" ref={setHeader}>
            <BackButton onClick={() => navigate('/home')} />
            {dmUser ? (
              <UserAvatar username={dmUser} size={32} />
            ) : (
              <span className="room-icon" aria-hidden="true">
                <Icon name={roomIconName(room)} size={20} />
              </span>
            )}
            <div className="room-title">
              <div className="room-name">
                <span className="room-name-text">{name}</span>
                {sub?.f && (
                  <button type="button" className="room-fav" title="Remover dos favoritos" aria-label="Remover dos favoritos" onClick={favorite}>
                    <Icon name="favorite" size={14} fill />
                  </button>
                )}
                {room.encrypted && (
                  <span className="room-mark" title="Criptografada">
                    <Icon name="encrypted" size={14} label="Criptografada" />
                  </span>
                )}
                {/* Canal de avisos: o ícone da sala e a faixa logo abaixo já dizem isso, sem pílula. */}
                {room.ro && !room.notice && (
                  <span className="pill" title="Somente leitura">
                    <Icon name="composer-locked" size={12} />
                    <span className="pill-label">somente leitura</span>
                  </span>
                )}
                {room.direct?.canSend === false && (
                  <span className="pill blocked" title={room.direct.sendBlockedReason} aria-label="Conversa bloqueada">
                    <Icon name="direct-blocked" size={12} />
                    <span className="pill-label">conversa bloqueada</span>
                  </span>
                )}
                {room.archived && (
                  <span className="pill" title="Arquivada">
                    <Icon name="archive" size={12} />
                    <span className="pill-label">arquivada</span>
                  </span>
                )}
                {room.team && !room.teamMain && (
                  <button type="button" className="pill clickable" title="Abrir o time" onClick={() => navigate(roomPath({ _id: room.team.roomId, t: 'c' }))}>
                    <Icon name="room-team" size={12} />
                    <span className="pill-label">{room.team.name}</span>
                  </button>
                )}
                {room.parent && (
                  <button type="button" className="pill clickable" title="Abrir a sala de origem" onClick={() => navigate(roomPath(room.parent))}>
                    <Icon name="parent-room" size={12} />
                    <span className="pill-label">{room.parent.fname || room.parent.name}</span>
                  </button>
                )}
              </div>
              <div
                className={hasInfo ? 'room-topic clickable' : 'room-topic'}
                onClick={hasInfo ? (e) => !(e.target as HTMLElement).closest('a, .mention') && setPanel('info') : undefined}
              >
                {dmUser ? `${STATUS_LABEL[status] ?? status}${presence?.statusText ? ` · ${presence.statusText}` : ''}` : room.topic ? renderMarkdown(room.topic) : null}
              </div>
            </div>
            <div className="room-actions">
              {room.t === 'l' && <LivechatActions rid={rid} onPanel={() => setPanel(panel === 'livechat' ? null : 'livechat')} />}
              {hasCalls && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    title={callBlocked ?? 'Chamada de voz'}
                    aria-label="Chamada de voz"
                    disabled={!!callBlocked}
                    onClick={() => void startCall(rid, 'audio')}
                  >
                    <Icon name="call-audio" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={callBlocked ?? 'Chamada de vídeo'}
                    aria-label="Chamada de vídeo"
                    disabled={!!callBlocked}
                    onClick={() => void startCall(rid, 'video')}
                  >
                    <Icon name="call-video" size={18} />
                  </button>
                  {shortcuts.length > 0 && <span className="room-actions-sep" aria-hidden="true" />}
                </>
              )}
              {shortcuts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`icon-btn room-shortcut ${p.id === 'members' && room.usersCount ? 'with-count' : ''} ${panel === p.id || (p.id === 'threads' && tmid) ? 'on' : ''}`}
                  title={p.label}
                  aria-label={p.label}
                  aria-pressed={panel === p.id || (p.id === 'threads' && !!tmid)}
                  onClick={() => setPanel(panel === p.id ? null : p.id)}
                >
                  <Icon name={p.icon} size={18} />
                  {p.id === 'members' && room.usersCount ? <span className="count">{room.usersCount.toLocaleString('pt-BR')}</span> : null}
                </button>
              ))}
              {(shortcuts.length > 0 || hasCalls || room.t === 'l') && <span className="room-actions-sep" aria-hidden="true" />}
              <Menu
                label="Mais opções da sala"
                trigger={
                  <button type="button" className="icon-btn" title="Mais" aria-label="Mais">
                    <Icon name="more-vertical" size={18} />
                  </button>
                }
              >
                {(close) => (
                  <>
                    {menuPanels.length > 0 && <div className="menu-label">Painéis</div>}
                    {menuPanels.map((p) => (
                      <button key={p.id} onClick={() => (setPanel(p.id), close())}>
                        <Icon name={p.icon} />
                        {p.label}
                      </button>
                    ))}
                    {sub && (
                      <>
                        {menuPanels.length > 0 && <hr />}
                        <button onClick={() => (favorite(), close())}>
                          <Icon name={sub.f ? 'unfavorite' : 'favorite'} />
                          {sub.f ? 'Remover dos favoritos' : 'Favoritar'}
                        </button>
                        <button onClick={() => (api.post('subscriptions.unread', { roomId: rid }), close())}>
                          <Icon name="mark-unread" />
                          Marcar como não lida
                        </button>
                        <button onClick={() => (api.post('rooms.hide', { roomId: rid }).then(() => navigate('/home')), close())}>
                          <Icon name="hide" />
                          Ocultar
                        </button>
                        {room.t !== 'd' && (
                          <>
                            <hr />
                            <button className="danger" onClick={() => (close(), void leave())}>
                              <Icon name="leave-room" />
                              Sair da sala
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </Menu>
            </div>
          </header>
          {room.notice && <NoticeBar room={room} canPost={canPostRO} />}
          {room.announcement && <Announcement text={room.announcement} />}
          <MessageList key={rid} rid={rid} sub={sub} actions={actions} canModerate={canModerate} notice={room.notice ? { ack: room.noticeAck, canPost: canPostRO } : undefined} />
          <TypingIndicator id={rid} />
          {sub ? (
            <Composer
              rid={rid}
              disabled={!!disabledReason}
              disabledReason={disabledReason}
              placeholder={room.t === 'd' || room.t === 'l' ? `Mensagem para ${name}` : `Mensagem em #${name}`}
              editing={editing}
              setEditing={setEditing}
              quoting={quoting}
              setQuoting={setQuoting}
              onEditLast={editLast}
              canned={room.t === 'l' ? { contactName: room.fname ?? '', agentName: me.name } : undefined}
              ackOption={!!(room.notice && room.noticeAck && canPostRO)}
            />
          ) : (
            <div className="join-bar">
              {room.t === 'c' ? (
                <>
                  <span>Você está vendo uma prévia de #{name}</span>
                  <button className="btn primary" onClick={join}>
                    Entrar no canal
                  </button>
                </>
              ) : room.t === 'l' ? (
                <LivechatJoinBar rid={rid} />
              ) : (
                <span>Você não participa desta sala.</span>
              )}
            </div>
          )}
        </div>
        {(panel || tmid) && <div className="panel-scrim" aria-hidden="true" onClick={closePanel} />}
        {tmid ? (
          <ThreadPanel key={tmid} rid={rid} tmid={tmid} room={room} canModerate={canModerate} onClose={() => navigate(roomPath(room))} onUserClick={openUserCard} isMember={!!sub} disabledReason={disabledReason} />
        ) : panel ? (
          <RoomPanel
            key={panel}
            id={panel}
            room={room}
            sub={sub}
            roles={roles}
            available={panels.map((p) => p.id)}
            onPanel={setPanel}
            onClose={() => setPanel(null)}
            onChanged={loadRoom}
            onUserClick={openUserCard}
          />
        ) : null}
        {discussionFrom && (
          <CreateModal kind="discussion" parent={{ _id: room._id, name: room.name ?? '', fname: name, t: room.t }} pmid={discussionFrom._id} onClose={() => setDiscussionFrom(null)} />
        )}
        {userCard && <UserCard key={userCard.username} username={userCard.username} anchor={userCard.anchor} rid={rid} roomRoles={roles} onClose={() => setUserCard(null)} />}
      </div>
    </MessageGateContext.Provider>
  );
}
