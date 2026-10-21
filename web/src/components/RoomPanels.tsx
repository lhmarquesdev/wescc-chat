import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, Room, Subscription } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { formatBytes, formatDateTime, formatRelative, roomIcon, roomPath } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { canWithRoles, useStore } from '../lib/store';
import { LivechatInfoPanel } from './LivechatPanel';
import { UserPicker, type PickedUser } from './Pickers';
import { Avatar, Empty, Field, Spinner, Toggle, UserAvatar, useAsync } from './ui';

export type PanelId = 'livechat' | 'info' | 'threads' | 'discussions' | 'team' | 'members' | 'search' | 'files' | 'pinned' | 'starred' | 'mentions' | 'notifications' | 'invite' | 'prune';

const TITLES: Record<PanelId, string> = {
  livechat: 'Atendimento',
  info: 'Informações da sala',
  threads: 'Threads',
  discussions: 'Discussões',
  team: 'Canais do time',
  members: 'Membros',
  search: 'Buscar mensagens',
  files: 'Arquivos',
  pinned: 'Mensagens fixadas',
  starred: 'Mensagens favoritas',
  mentions: 'Menções a você',
  notifications: 'Preferências de notificação',
  invite: 'Convidar por link',
  prune: 'Limpar histórico',
};

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

interface Props {
  id: PanelId;
  room: Room & Record<string, any>;
  sub?: Subscription;
  roles: string[];
  onClose: () => void;
  onChanged: () => void;
  onUserClick: (u: string) => void;
}

export function RoomPanel(p: Props) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <h3>{TITLES[p.id]}</h3>
        <button className="icon-btn" onClick={p.onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {p.id === 'livechat' && <LivechatInfoPanel rid={p.room._id} />}
        {p.id === 'info' && <InfoPanel {...p} />}
        {p.id === 'threads' && <ThreadsPanel {...p} />}
        {p.id === 'discussions' && <DiscussionsPanel {...p} />}
        {p.id === 'team' && <TeamPanel {...p} />}
        {p.id === 'members' && <MembersPanel {...p} />}
        {p.id === 'search' && <SearchPanel {...p} />}
        {p.id === 'files' && <FilesPanel {...p} />}
        {(p.id === 'pinned' || p.id === 'starred' || p.id === 'mentions') && <FlagPanel {...p} />}
        {p.id === 'notifications' && <NotificationsPanel {...p} />}
        {p.id === 'invite' && <InvitePanel {...p} />}
        {p.id === 'prune' && <PrunePanel {...p} />}
      </div>
    </aside>
  );
}

const hasPerm = (perm: string, roles: string[]) => canWithRoles(perm, roles);

function MessageResult({ m }: { m: Message }) {
  const navigate = useNavigate();
  return (
    <button className="result" onClick={() => navigate(`${location.pathname.split('/thread/')[0]}?msg=${m._id}`)}>
      <div className="result-head">
        <Avatar username={m.u.username} size={20} /> <strong>{m.u.username}</strong> <span className="muted">{formatDateTime(m.ts)}</span>
      </div>
      <div className="result-body">{renderMarkdown(m.msg)}</div>
    </button>
  );
}

function InfoPanel({ room, sub, roles, onChanged }: Props) {
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<any>({});
  const canEdit = hasPerm('edit-room', roles);
  const isAdmin = useStore((s) => s.me?.permissions.includes('view-room-administration'));
  const canRetention = useStore((s) => s.me?.permissions.includes('edit-room-retention-policy'));
  useEffect(() => {
    setF({
      roomName: room.t === 'd' ? '' : room.prid ? room.fname : room.name,
      roomTopic: room.topic ?? '',
      roomDescription: room.description ?? '',
      roomAnnouncement: room.announcement ?? '',
      roomType: room.t,
      readOnly: room.ro,
      reactWhenReadOnly: room.reactWhenReadOnly,
      default: room.default,
      featured: room.featured,
      encrypted: room.encrypted,
      joinCode: '',
      retention: room.retention ?? { enabled: false, overrideGlobal: false, maxAgeDays: 30, filesOnly: false, excludePinned: true },
    });
  }, [room, edit]);

  const save = async () => {
    try {
      const body: any = { rid: room._id, ...f };
      if (!canRetention) delete body.retention;
      if (!isAdmin) {
        delete body.default;
        delete body.featured;
      }
      if (!body.joinCode) delete body.joinCode;
      await api.post('rooms.saveRoomSettings', body);
      setEdit(false);
      onChanged();
      ok('Configurações salvas.');
    } catch (e) {
      fail(e);
    }
  };

  const setAvatar = async (file: File) => {
    const fd = new FormData();
    fd.append('roomId', room._id);
    fd.append('image', file);
    await api.post('rooms.setAvatar', fd).then(onChanged).catch(fail);
  };

  if (edit)
    return (
      <div className="form">
        {room.t !== 'd' && (
          <Field label="Nome">
            <input value={f.roomName} onChange={(e) => setF({ ...f, roomName: e.target.value })} />
          </Field>
        )}
        <Field label="Tópico">
          <input value={f.roomTopic} onChange={(e) => setF({ ...f, roomTopic: e.target.value })} />
        </Field>
        <Field label="Descrição">
          <textarea rows={3} value={f.roomDescription} onChange={(e) => setF({ ...f, roomDescription: e.target.value })} />
        </Field>
        <Field label="Anúncio">
          <textarea rows={2} value={f.roomAnnouncement} onChange={(e) => setF({ ...f, roomAnnouncement: e.target.value })} />
        </Field>
        {room.t !== 'd' && (
          <>
            <Toggle checked={f.roomType === 'p'} onChange={(v) => setF({ ...f, roomType: v ? 'p' : 'c' })} label="Privada" />
            <Toggle checked={f.readOnly} onChange={(v) => setF({ ...f, readOnly: v })} label="Somente leitura" />
            <Toggle checked={f.reactWhenReadOnly} onChange={(v) => setF({ ...f, reactWhenReadOnly: v })} label="Permitir reações em somente leitura" />
            <Toggle checked={f.encrypted} onChange={(v) => setF({ ...f, encrypted: v })} label="Criptografada" />
            {f.roomType === 'c' && (
              <Field label="Código de acesso" hint="Deixe vazio para não exigir código.">
                <input value={f.joinCode} onChange={(e) => setF({ ...f, joinCode: e.target.value })} placeholder="(sem alteração)" />
              </Field>
            )}
            {isAdmin && (
              <>
                <Toggle checked={f.default} onChange={(v) => setF({ ...f, default: v })} label="Sala padrão (novos usuários entram automaticamente)" />
                <Toggle checked={f.featured} onChange={(v) => setF({ ...f, featured: v })} label="Destaque no diretório" />
              </>
            )}
          </>
        )}
        {canRetention && (
          <fieldset>
            <legend>Política de retenção</legend>
            <Toggle checked={f.retention.overrideGlobal} onChange={(v) => setF({ ...f, retention: { ...f.retention, overrideGlobal: v } })} label="Substituir a política global" />
            {f.retention.overrideGlobal && (
              <>
                <Toggle checked={f.retention.enabled} onChange={(v) => setF({ ...f, retention: { ...f.retention, enabled: v } })} label="Apagar mensagens antigas" />
                <Field label="Idade máxima (dias)">
                  <input type="number" min={1} value={f.retention.maxAgeDays} onChange={(e) => setF({ ...f, retention: { ...f.retention, maxAgeDays: Number(e.target.value) } })} />
                </Field>
                <Toggle checked={f.retention.filesOnly} onChange={(v) => setF({ ...f, retention: { ...f.retention, filesOnly: v } })} label="Apagar só arquivos" />
                <Toggle checked={f.retention.excludePinned} onChange={(v) => setF({ ...f, retention: { ...f.retention, excludePinned: v } })} label="Manter mensagens fixadas" />
              </>
            )}
          </fieldset>
        )}
        <label className="btn">
          🖼 Trocar imagem da sala
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setAvatar(e.target.files[0])} />
        </label>
        <div className="row-actions">
          <button className="btn" onClick={() => setEdit(false)}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </div>
      </div>
    );

  return (
    <div className="info">
      <div className="info-hero">
        {room.t === 'd' && sub ? <Avatar username={sub.name.split(',')[0]} size={96} /> : <Avatar rid={room._id} size={96} etag={(room as any).avatarETag} />}
        <h2>
          {roomIcon(room)} {sub?.fname || room.fname || room.name}
        </h2>
      </div>
      {room.description && (
        <section>
          <h4>Descrição</h4>
          {renderMarkdown(room.description)}
        </section>
      )}
      {room.topic && (
        <section>
          <h4>Tópico</h4>
          {renderMarkdown(room.topic)}
        </section>
      )}
      {room.announcement && (
        <section>
          <h4>Anúncio</h4>
          {renderMarkdown(room.announcement)}
        </section>
      )}
      <section className="muted small">
        Criada em {formatDateTime(room.ts)} · {room.usersCount} membros · {room.msgs} mensagens
        {room.retention?.overrideGlobal && room.retention.enabled && <div>🧹 Mensagens com mais de {room.retention.maxAgeDays} dias são apagadas automaticamente.</div>}
      </section>
      <div className="row-actions wrap">
        {canEdit && room.t !== 'd' && (
          <button className="btn" onClick={() => setEdit(true)}>
            ✏️ Editar
          </button>
        )}
        {room.t !== 'd' && !room.teamMain && !room.prid && !room.teamId && hasPerm('create-team', roles) && canEdit && (
          <button className="btn" onClick={() => confirm('Converter esta sala em um time?') && api.post('rooms.convertToTeam', { roomId: room._id }).then(onChanged).catch(fail)}>
            👥 Converter em time
          </button>
        )}
        {room.teamMain && hasPerm('edit-team', roles) && (
          <button className="btn" onClick={() => confirm('Converter o time em canal comum?') && api.post('teams.convertToChannel', { teamId: room.teamId }).then(onChanged).catch(fail)}>
            # Converter em canal
          </button>
        )}
        {room.t !== 'd' && hasPerm('archive-room', roles) && (
          <button className="btn" onClick={() => api.post(room.archived ? 'channels.unarchive' : 'channels.archive', { roomId: room._id }).then(onChanged).catch(fail)}>
            🗄 {room.archived ? 'Desarquivar' : 'Arquivar'}
          </button>
        )}
        {hasPerm(room.t === 'c' ? 'delete-c' : room.t === 'p' ? 'delete-p' : 'delete-d', roles) && (
          <button
            className="btn danger"
            onClick={() => {
              if (!confirm('Excluir a sala e todas as mensagens? Isso não pode ser desfeito.')) return;
              const call = room.teamMain ? api.post('teams.delete', { teamId: room.teamId }) : api.post('rooms.delete', { roomId: room._id });
              call.then(() => navigate('/home')).catch(fail);
            }}
          >
            🗑 Excluir
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadsPanel({ room }: Props) {
  const [type, setType] = useState<'all' | 'following' | 'unread'>('all');
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.get('chat.getThreadsList', { rid: room._id, type, count: 50 }), [room._id, type]);
  return (
    <>
      <select value={type} onChange={(e) => setType(e.target.value as any)}>
        <option value="all">Todas</option>
        <option value="following">Seguindo</option>
        <option value="unread">Não lidas</option>
      </select>
      {loading ? (
        <Spinner />
      ) : !data?.threads.length ? (
        <Empty>Nenhuma thread.</Empty>
      ) : (
        data.threads.map((m: Message) => (
          <button key={m._id} className="result" onClick={() => navigate(`${roomPath(room)}/thread/${m._id}`)}>
            <div className="result-head">
              <Avatar username={m.u.username} size={20} /> <strong>{m.u.username}</strong> <span className="muted">{formatRelative(m.tlm)}</span>
            </div>
            <div className="result-body ellipsis">{m.msg}</div>
            <div className="muted small">💬 {m.tcount} respostas</div>
          </button>
        ))
      )}
    </>
  );
}

function DiscussionsPanel({ room }: Props) {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.get('rooms.getDiscussions', { roomId: room._id, count: 100 }), [room._id]);
  if (loading) return <Spinner />;
  if (!data?.discussions.length) return <Empty>Nenhuma discussão.</Empty>;
  return data.discussions.map((d: Room) => (
    <button key={d._id} className="result" onClick={() => navigate(roomPath(d))}>
      <div className="result-head">
        🗨 <strong>{d.fname}</strong>
      </div>
      <div className="muted small">
        {d.msgs} mensagens · {formatRelative(d.lm ?? d.ts)}
      </div>
    </button>
  ));
}

function TeamPanel({ room, roles }: Props) {
  const navigate = useNavigate();
  const { data, loading, reload } = useAsync(() => api.get('teams.listRooms', { teamId: room.teamId, count: 200 }), [room.teamId]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const canAdd = hasPerm('create-team-channel', roles) || hasPerm('add-team-channel', roles);
  return (
    <>
      {canAdd && !adding && (
        <button className="btn" onClick={() => setAdding(true)}>
          ＋ Criar canal no time
        </button>
      )}
      {adding && (
        <div className="form">
          <input placeholder="nome-do-canal" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} />
          <Toggle checked={priv} onChange={setPriv} label="Privado" />
          <div className="row-actions">
            <button className="btn" onClick={() => setAdding(false)}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => api.post('teams.createRoom', { teamId: room.teamId, name, type: priv ? 'p' : 'c' }).then(() => (setAdding(false), setName(''), reload())).catch(fail)}>
              Criar
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : !data?.rooms.length ? (
        <Empty>Nenhum canal no time.</Empty>
      ) : (
        data.rooms.map((r: any) => (
          <div key={r._id} className="list-row">
            <button className="link" onClick={() => navigate(roomPath(r))}>
              {roomIcon(r)} {r.fname || r.name}
            </button>
            <span className="muted small">{r.usersCount} membros</span>
            {r.teamDefault && <span className="pill">padrão</span>}
            {!r.isMember && r.t === 'c' && (
              <button className="btn small" onClick={() => api.post('channels.join', { roomId: r._id }).then(reload).catch(fail)}>
                Entrar
              </button>
            )}
            {hasPerm('edit-team-channel', roles) && (
              <button className="btn small" title="Novos membros do time entram automaticamente" onClick={() => api.post('teams.updateRoom', { roomId: r._id, isDefault: !r.teamDefault }).then(reload).catch(fail)}>
                {r.teamDefault ? 'Tirar padrão' : 'Tornar padrão'}
              </button>
            )}
            {hasPerm('remove-team-channel', roles) && (
              <button className="btn small" onClick={() => api.post('teams.removeRoom', { teamId: room.teamId, roomId: r._id }).then(reload).catch(fail)}>
                Remover
              </button>
            )}
          </div>
        ))
      )}
    </>
  );
}

function MembersPanel({ room, roles, onUserClick }: Props) {
  const [filter, setFilter] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [adding, setAdding] = useState<PickedUser[]>([]);
  const { data, loading, reload } = useAsync(
    () => api.get('rooms.membersOrderedByRole', { roomId: room._id, filter, count: 200 }),
    [room._id, filter],
  );
  const canAdd = hasPerm('add-user-to-joined-room', roles);
  const members = (data?.members ?? []).filter((m: any) => !onlineOnly || m.status !== 'offline');
  return (
    <>
      <input placeholder="Filtrar membros" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <Toggle checked={onlineOnly} onChange={setOnlineOnly} label="Somente online" />
      {canAdd && room.t !== 'd' && (
        <div className="form">
          <UserPicker value={adding} onChange={setAdding} placeholder="Adicionar pessoas" />
          {adding.length > 0 && (
            <button
              className="btn primary"
              onClick={() =>
                api
                  .post(room.teamMain ? 'teams.addMembers' : room.t === 'p' ? 'groups.invite' : 'channels.invite', room.teamMain ? { teamId: room.teamId, members: adding.map((u) => ({ userId: u._id })) } : { roomId: room._id, userIds: adding.map((u) => u._id) })
                  .then(() => (setAdding([]), reload()))
                  .catch(fail)
              }
            >
              Adicionar {adding.length}
            </button>
          )}
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="muted small">{data?.total} membros</div>
          {members.map((m: any) => (
            <button key={m._id} className="member" onClick={() => onUserClick(m.username)}>
              <UserAvatar username={m.username} size={28} status={m.status} />
              <span>
                <strong>{m.name || m.username}</strong> <span className="muted">@{m.username}</span>
              </span>
              {m.roles.map((r: string) => (
                <span key={r} className="pill">
                  {r === 'owner' ? 'dono' : r === 'moderator' ? 'moderador' : r === 'leader' ? 'líder' : r}
                </span>
              ))}
              {room.muted?.includes(m.username) && <span className="pill">🔇</span>}
            </button>
          ))}
        </>
      )}
    </>
  );
}

function SearchPanel({ room }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const { data, loading, error } = useAsync(() => (q ? api.get('chat.search', { roomId: room._id, searchText: q, count: 50 }) : Promise.resolve(null)), [q, room._id]);
  return (
    <>
      <input autoFocus placeholder="Buscar (ex.: relatório from:@ana has:file)" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="muted small">Operadores: from:@usuário, has:file, has:link, is:pinned, is:starred, is:thread, before:AAAA-MM-DD, after:AAAA-MM-DD, /regex/</div>
      {error && <div className="form-error">{error}</div>}
      {loading && q ? <Spinner /> : data && (data.messages.length ? data.messages.map((m: Message) => <MessageResult key={m._id} m={m} />) : <Empty>Nada encontrado.</Empty>)}
    </>
  );
}

function FilesPanel({ room }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const { data, loading } = useAsync(() => api.get('rooms.files', { roomId: room._id, name, typeGroup: type, count: 100 }), [room._id, name, type]);
  return (
    <>
      <input placeholder="Filtrar por nome" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">Todos os tipos</option>
        <option value="image/*">Imagens</option>
        <option value="video/*">Vídeos</option>
        <option value="audio/*">Áudios</option>
        <option value="application/*">Documentos</option>
        <option value="text/*">Texto</option>
      </select>
      {loading ? (
        <Spinner />
      ) : !data?.files.length ? (
        <Empty>Nenhum arquivo.</Empty>
      ) : (
        data.files.map((f: any) => (
          <a key={f._id} className="file-row" href={`${f.url}?download`} target="_blank" rel="noreferrer">
            {f.type.startsWith('image/') ? <img src={f.url} alt="" /> : <span className="att-icon">📄</span>}
            <span>
              <strong>{f.name}</strong>
              <span className="muted small">
                {formatBytes(f.size)} · @{f.user.username} · {formatDateTime(f.uploadedAt)}
              </span>
            </span>
          </a>
        ))
      )}
    </>
  );
}

function FlagPanel({ id, room }: Props) {
  const path = id === 'pinned' ? 'chat.getPinnedMessages' : id === 'starred' ? 'chat.getStarredMessages' : 'chat.getMentionedMessages';
  const { data, loading } = useAsync(() => api.get(path, { roomId: room._id, count: 100 }), [room._id, id]);
  if (loading) return <Spinner />;
  if (!data?.messages.length) return <Empty>Nenhuma mensagem.</Empty>;
  return data.messages.map((m: Message) => <MessageResult key={m._id} m={m} />);
}

function NotificationsPanel({ room, sub }: Props) {
  const [n, setN] = useState<any>(sub?.notifications ?? {});
  if (!sub) return <Empty>Entre na sala para configurar notificações.</Empty>;
  const save = (patch: any) => {
    const next = { ...n, ...patch };
    setN(next);
    api.post('rooms.saveNotification', { roomId: room._id, notifications: patch }).catch(fail);
  };
  return (
    <div className="form">
      <Toggle checked={!!n.disableNotifications} onChange={(v) => save({ disableNotifications: v })} label="Silenciar todas as notificações" />
      <Toggle checked={!!n.hideUnreadStatus} onChange={(v) => save({ hideUnreadStatus: v })} label="Ocultar contador de não lidas" />
      <Toggle checked={!!n.muteGroupMentions} onChange={(v) => save({ muteGroupMentions: v })} label="Ignorar @all e @here" />
      <Field label="Notificações na área de trabalho">
        <select value={n.desktop ?? 'default'} onChange={(e) => save({ desktop: e.target.value })}>
          <option value="default">Padrão</option>
          <option value="all">Todas as mensagens</option>
          <option value="mentions">Só menções</option>
          <option value="nothing">Nada</option>
        </select>
      </Field>
      <Field label="E-mail (quando offline)">
        <select value={n.email ?? 'default'} onChange={(e) => save({ email: e.target.value })}>
          <option value="default">Padrão</option>
          <option value="mentions">Menções</option>
          <option value="nothing">Nada</option>
        </select>
      </Field>
    </div>
  );
}

function InvitePanel({ room }: Props) {
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(0);
  const [link, setLink] = useState('');
  const gen = async () => {
    try {
      const r = await api.post('findOrCreateInvite', { rid: room._id, days, maxUses });
      setLink(`${location.origin}${r.url}`);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="form">
      <Field label="Expira em">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>1 dia</option>
          <option value={7}>7 dias</option>
          <option value={15}>15 dias</option>
          <option value={30}>30 dias</option>
          <option value={0}>Nunca</option>
        </select>
      </Field>
      <Field label="Usos máximos">
        <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
          <option value={0}>Ilimitado</option>
          {[1, 5, 10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <button className="btn primary" onClick={gen}>
        Gerar link
      </button>
      {link && (
        <div className="copy-box">
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => (navigator.clipboard?.writeText(link), ok('Link copiado.'))}>
            Copiar
          </button>
        </div>
      )}
    </div>
  );
}

function PrunePanel({ room }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState('2000-01-01');
  const [to, setTo] = useState(today);
  const [excludePinned, setExcludePinned] = useState(true);
  const [filesOnly, setFilesOnly] = useState(false);
  const [users, setUsers] = useState<PickedUser[]>([]);
  const run = async () => {
    if (!confirm('Apagar as mensagens do período escolhido? Isso não pode ser desfeito.')) return;
    try {
      const r = await api.post('rooms.cleanHistory', {
        roomId: room._id,
        oldest: new Date(`${from}T00:00:00`).toISOString(),
        latest: new Date(`${to}T23:59:59`).toISOString(),
        inclusive: true,
        excludePinned,
        filesOnly,
        users: users.map((u) => u.username),
      });
      ok(`${r.count} itens removidos.`);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="form">
      <Field label="De">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <Field label="Até">
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Field label="Somente destes usuários (opcional)">
        <UserPicker value={users} onChange={setUsers} />
      </Field>
      <Toggle checked={excludePinned} onChange={setExcludePinned} label="Manter mensagens fixadas" />
      <Toggle checked={filesOnly} onChange={setFilesOnly} label="Apagar só os arquivos" />
      <button className="btn danger" onClick={run}>
        Limpar histórico
      </button>
    </div>
  );
}
