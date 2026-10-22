import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Message, Room } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { roomDisplayName, roomIcon, roomPath, STATUS_LABEL } from '../lib/format';
import { realtime } from '../lib/realtime';
import { renderMarkdown } from '../lib/markdown';
import { startCall } from '../lib/calls';
import { sendText } from '../lib/direct';
import { canWithRoles, useSetting, useStore } from '../lib/store';
import { Composer } from '../components/Composer';
import { LIVECHAT_STATUS, LivechatActions } from '../components/LivechatPanel';
import { CreateModal } from '../components/CreateModal';
import { MessageGateContext } from '../components/MessageItem';
import { MessageList } from '../components/MessageList';
import { NoticeBar } from '../components/NoticeBar';
import { RoomPanel, type PanelId } from '../components/RoomPanels';
import { ThreadPanel } from '../components/ThreadPanel';
import { UserCard } from '../components/UserCard';
import { Avatar, Menu, Spinner, StatusDot } from '../components/ui';

const notLive = (r: Room) => r.t !== 'l';
const PANELS: { id: PanelId; icon: string; label: string; when?: (r: Room) => boolean }[] = [
  { id: 'livechat', icon: '🎧', label: 'Atendimento', when: (r) => r.t === 'l' },
  { id: 'info', icon: 'ℹ️', label: 'Informações', when: notLive },
  { id: 'threads', icon: '💬', label: 'Threads' },
  { id: 'discussions', icon: '🗨', label: 'Discussões', when: (r) => !r.prid && notLive(r) },
  { id: 'team', icon: '👥', label: 'Canais do time', when: (r) => !!r.teamMain },
  { id: 'members', icon: '🧑‍🤝‍🧑', label: 'Membros', when: (r) => notLive(r) && (r.t !== 'd' || (r.uids?.length ?? 0) > 2) },
  { id: 'search', icon: '🔍', label: 'Buscar mensagens' },
  { id: 'files', icon: '📁', label: 'Arquivos' },
  { id: 'pinned', icon: '📌', label: 'Fixadas' },
  { id: 'starred', icon: '⭐', label: 'Favoritas' },
  { id: 'mentions', icon: '@', label: 'Menções' },
  { id: 'notifications', icon: '🔔', label: 'Notificações' },
  { id: 'invite', icon: '🔗', label: 'Link de convite', when: (r) => r.t !== 'd' && notLive(r) },
  { id: 'prune', icon: '🧹', label: 'Limpar histórico', when: (r) => r.t !== 'd' && notLive(r) },
];

function TypingIndicator({ id }: { id: string }) {
  const typing = useStore((s) => s.typing[id]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const names = Object.entries(typing ?? {})
    .filter(([, ts]) => Date.now() - ts < 6000)
    .map(([u]) => u);
  if (!names.length) return <div className="typing" />;
  return (
    <div className="typing">
      <strong>{names.slice(0, 3).join(', ')}</strong> {names.length === 1 ? 'está digitando' : 'estão digitando'}…
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

export function RoomPage() {
  const { rid = '', '*': rest = '' } = useParams();
  const tmid = rest.match(/^thread\/([^/]+)/)?.[1];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sub = useStore((s) => s.subscriptions[rid]);
  const roomLive = useStore((s) => s.rooms[rid]);
  const me = useStore((s) => s.me)!;
  const [room, setRoom] = useState<(Room & { muted?: string[]; team?: any; parent?: any; joinCodeRequired?: boolean }) | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Message | null>(null);
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [discussionFrom, setDiscussionFrom] = useState<Message | null>(null);
  const [userCard, setUserCard] = useState<string | null>(null);
  const [roomRoles, setRoomRoles] = useState<string[]>([]);
  const panel = params.get('tab') as PanelId | null;
  const presence = useStore((s) => (room?.t === 'd' && sub && !sub.name.includes(',') ? s.presence[sub.name] : undefined));
  const threadsOn = useSetting<boolean>('Threads_enabled');
  const callsEnabled = useSetting<boolean>('Calls_Enabled');

  const loadRoom = useCallback(async () => {
    try {
      const r = await api.get('rooms.info', { roomId: rid });
      setRoom(r.room);
      useStore.getState().upsertRoom(r.room);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [rid]);

  useEffect(() => {
    setRoom(null);
    setEditing(null);
    setQuoting(null);
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
      onUserClick: (u: string) => setUserCard(u),
      ...gate,
    }),
    [navigate, rid, room?.t, threadsOn, gate],
  );

  const editLast = () => {
    const list = useStore.getState().messages[rid]?.list ?? [];
    const mine = [...list].reverse().find((m) => m.u._id === me._id && !m.t);
    if (mine) setEditing(mine);
  };

  if (error) return <div className="room-error">{error}</div>;
  if (!room) return <div className="room center"><Spinner /></div>;

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

  return (
    <MessageGateContext.Provider value={gate}>
      <div className={`room ${panel || tmid ? 'with-panel' : ''}`}>
        <div className="room-main">
          <header className="room-header">
            <button className="icon-btn mobile-only" onClick={() => navigate('/home')}>
              ←
            </button>
            {dmUser ? (
              <span className="avatar-wrap" style={{ width: 32, height: 32 }}>
                <Avatar username={dmUser} size={32} />
                <StatusDot username={dmUser} />
              </span>
            ) : (
              <span className="room-icon">{roomIcon(room)}</span>
            )}
            <div className="room-title">
              <div className="room-name">
                {name}
                {sub?.f && <span title="Favorito"> ★</span>}
                {room.encrypted && <span title="Criptografada"> 🔐</span>}
                {room.notice ? (
                  <span className="pill notice" title="Canal de avisos" aria-label="Canal de avisos">
                    📢 <span className="pill-label">avisos</span>
                  </span>
                ) : (
                  room.ro && <span className="pill">somente leitura</span>
                )}
                {room.direct?.canSend === false && (
                  <span className="pill blocked" title={room.direct.sendBlockedReason} aria-label="Conversa bloqueada">
                    🚫 <span className="pill-label">conversa bloqueada</span>
                  </span>
                )}
                {room.archived && <span className="pill">arquivada</span>}
                {room.team && !room.teamMain && (
                  <span className="pill clickable" onClick={() => navigate(roomPath({ _id: room.team.roomId, t: 'c' }))}>
                    👥 {room.team.name}
                  </span>
                )}
                {room.parent && (
                  <span className="pill clickable" onClick={() => navigate(roomPath(room.parent))}>
                    ↖ {room.parent.fname || room.parent.name}
                  </span>
                )}
              </div>
              <div className="room-topic">
                {dmUser ? `${STATUS_LABEL[presence?.status ?? 'offline']}${presence?.statusText ? ` — ${presence.statusText}` : ''}` : room.topic ? renderMarkdown(room.topic) : null}
              </div>
            </div>
            <div className="room-actions">
              {room.t === 'l' && <LivechatActions rid={rid} onPanel={() => setPanel(panel === 'livechat' ? null : 'livechat')} />}
              {dmUser && callsEnabled && room.uids?.length === 2 && (
                <>
                  <button className="icon-btn" title={callBlocked ?? 'Chamada de voz'} disabled={!!callBlocked} onClick={() => void startCall(rid, 'audio')}>
                    📞
                  </button>
                  <button className="icon-btn" title={callBlocked ?? 'Chamada de vídeo'} disabled={!!callBlocked} onClick={() => void startCall(rid, 'video')}>
                    🎥
                  </button>
                </>
              )}
              {sub && (
                <button className="icon-btn" title={sub.f ? 'Remover dos favoritos' : 'Favoritar'} onClick={() => api.post('rooms.favorite', { roomId: rid, favorite: !sub.f })}>
                  {sub.f ? '★' : '☆'}
                </button>
              )}
              {panels.filter((p) => ['info', 'threads', 'members', 'search'].includes(p.id)).map((p) => (
                <button key={p.id} className={`icon-btn room-shortcut ${panel === p.id ? 'on' : ''}`} title={p.label} onClick={() => setPanel(panel === p.id ? null : p.id)}>
                  {p.icon}
                </button>
              ))}
              <Menu trigger={<button className="icon-btn" title="Mais">⋮</button>}>
                {(close) => (
                  <>
                    {panels.map((p) => (
                      <button key={p.id} onClick={() => (setPanel(p.id), close())}>
                        {p.icon} {p.label}
                      </button>
                    ))}
                    {sub && (
                      <>
                        <hr />
                        <button onClick={() => (api.post('subscriptions.unread', { roomId: rid }), close())}>● Marcar como não lida</button>
                        <button onClick={() => (api.post('rooms.hide', { roomId: rid }).then(() => navigate('/home')), close())}>🙈 Ocultar</button>
                        {room.t !== 'd' && (
                          <button
                            className="danger"
                            onClick={() => {
                              close();
                              if (confirm(`Sair de ${name}?`)) api.post('rooms.leave', { roomId: rid }).then(() => navigate('/home')).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
                            }}
                          >
                            ↩ Sair da sala
                          </button>
                        )}
                      </>
                    )}
                  </>
                )}
              </Menu>
            </div>
          </header>
          {room.notice && <NoticeBar room={room} canPost={canPostRO} />}
          {room.announcement && <div className="announcement">📌 {renderMarkdown(room.announcement)}</div>}
          <MessageList key={rid} rid={rid} sub={sub} actions={actions} canModerate={canModerate} notice={room.notice ? { ack: room.noticeAck, canPost: canPostRO } : undefined} />
          <TypingIndicator id={rid} />
          {sub ? (
            <Composer
              rid={rid}
              disabled={!!disabledReason}
              disabledReason={disabledReason}
              placeholder={`Mensagem para ${room.t === 'd' ? '@' : '#'}${name}`}
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
                  <span>Você está vendo uma prévia de #{name}.</span>
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
        {tmid ? (
          <ThreadPanel key={tmid} rid={rid} tmid={tmid} room={room} canModerate={canModerate} onClose={() => navigate(roomPath(room))} onUserClick={setUserCard} isMember={!!sub} disabledReason={disabledReason} />
        ) : panel ? (
          <RoomPanel id={panel} room={room} sub={sub} roles={roles} onClose={() => setPanel(null)} onChanged={loadRoom} onUserClick={setUserCard} />
        ) : null}
        {discussionFrom && (
          <CreateModal kind="discussion" parent={{ _id: room._id, name: room.name ?? '', fname: name, t: room.t }} pmid={discussionFrom._id} onClose={() => setDiscussionFrom(null)} />
        )}
        {userCard && <UserCard username={userCard} rid={rid} roomRoles={roles} onClose={() => setUserCard(null)} />}
      </div>
    </MessageGateContext.Provider>
  );
}
