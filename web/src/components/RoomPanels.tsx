import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, Room, Subscription } from '@shared/index';
import { stickerPreviewText } from '@shared/stickers';
import { api, errorMessage } from '../lib/api';
import { partyOf, useDirect } from '../lib/direct';
import { formatBytes, formatDateTime, formatRelative, formatWhen, plural, roleLabel, roomDisplayName, roomIconName, roomPath, STATUS_LABEL } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { useNames } from '../lib/names';
import { canWithRoles, useStore } from '../lib/store';
import { Icon, type IconName } from './Icon';
import { LivechatInfoPanel } from './LivechatPanel';
import { FileTile } from './MessageItem';
import { useEscape, useIsPhone } from './overlay';
import { UserPicker, type PickedUser } from './Pickers';
import { StickerView } from './stickers/StickerView';
import { Avatar, Empty, Field, GroupAvatar, Menu, Segmented, SearchInput, SkeletonList, Toggle, UserAvatar, confirmDialog, useAsync } from './ui';
// Chamadas em grupo: "Em chamada" ao lado da presença.
import { InCallBadge } from './call/LiveIndicators';

export type PanelId = 'livechat' | 'info' | 'threads' | 'discussions' | 'team' | 'members' | 'search' | 'files' | 'pinned' | 'starred' | 'mentions' | 'notifications' | 'invite' | 'prune';

const TITLES: Record<PanelId, string> = {
  livechat: 'Atendimento',
  info: 'Informações da sala',
  threads: 'Tópicos',
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
const ok = (t: string) => useStore.getState().toast(t, 'success');

interface Props {
  id: PanelId;
  room: Room & Record<string, any>;
  sub?: Subscription;
  roles: string[];
  // Painéis disponíveis nesta sala (os atalhos de Informações só levam a eles).
  available: PanelId[];
  onPanel: (p: PanelId | null) => void;
  onClose: () => void;
  onChanged: () => void;
  onUserClick: (u: string) => void;
}

// Antes de fechar, o foco que está no painel vai para o botão que o abriu no cabeçalho (ou para o compositor):
// sem isso ele cai no <body> quando o painel sai da tela.
export function refocusRoom() {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !a.closest('.panel')) return;
  (document.querySelector<HTMLElement>('.room-actions button.on') ?? document.querySelector<HTMLElement>('.room-main .composer textarea'))?.focus({ preventScroll: true });
}

// Esc fecha o painel enquanto o foco está nele (campos de texto ficam com o próprio Esc).
export function usePanelEscape(onClose: () => void) {
  const [inside, setInside] = useState(false);
  useEscape(inside, () => {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) return;
    refocusRoom();
    onClose();
  });
  return {
    onFocus: () => setInside(true),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
    },
  };
}

// Cabeçalho comum dos painéis: título (e subtítulo), ações à direita e fechar; no celular, voltar à esquerda.
export function PanelHead({ title, sub, actions, onClose }: { title: string; sub?: ReactNode; actions?: ReactNode; onClose: () => void }) {
  const phone = useIsPhone();
  const close = () => {
    refocusRoom();
    onClose();
  };
  return (
    <div className="panel-head">
      {phone && (
        <button type="button" className="icon-btn panel-back" title="Voltar" aria-label="Voltar" onClick={close}>
          <Icon name="back" size={20} />
        </button>
      )}
      <h2 className="panel-title">
        <span className="panel-title-text">{title}</span>
        {sub && <span className="sub">{sub}</span>}
      </h2>
      {actions}
      {!phone && (
        <button type="button" className="icon-btn panel-close" title="Fechar" aria-label="Fechar" onClick={close}>
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

export function RoomPanel(p: Props) {
  const esc = usePanelEscape(p.onClose);
  const sub = p.id === 'members' && p.room.usersCount ? plural(p.room.usersCount, 'pessoa', 'pessoas') : undefined;
  // Numa conversa direta o painel fala da pessoa (ou do grupo), não de uma "sala".
  const title = p.id === 'info' && p.room.t === 'd' ? ((p.room.uids?.length ?? 0) > 2 ? 'Informações da conversa' : 'Informações do contato') : TITLES[p.id];
  return (
    <aside className={`panel panel-${p.id}`} aria-label={title} {...esc}>
      <PanelHead title={title} sub={sub} onClose={p.onClose} />
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

// Corpo de um resultado com as menções destacadas como na conversa (sem links de canal: o resultado já é um botão).
function resultBody(m: Message) {
  return renderMarkdown(m.msg, { me: useStore.getState().me?.username, mentions: m.mentions });
}

function MessageResult({ m }: { m: Message }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="result" onClick={() => navigate(`${location.pathname.split('/thread/')[0]}?msg=${m._id}`)}>
      <div className="result-head">
        <Avatar username={m.u.username} size={20} />
        <strong title={`@${m.u.username}`}>{m.u.name || m.u.username}</strong>
        <time className="muted" dateTime={m.ts} title={formatDateTime(m.ts)}>
          {formatWhen(m.ts)}
        </time>
      </div>
      <div className="result-body">{m.sticker ? <StickerView sticker={m.sticker} size="small" /> : resultBody(m)}</div>
    </button>
  );
}

// Valores do formulário de edição a partir da sala carregada (também a base para enviar só o que mudou).
function roomForm(room: Room & Record<string, any>) {
  return {
    roomName: room.t === 'd' ? '' : room.prid ? room.fname : room.name,
    roomTopic: room.topic ?? '',
    roomDescription: room.description ?? '',
    roomAnnouncement: room.announcement ?? '',
    roomType: room.t,
    readOnly: room.ro,
    reactWhenReadOnly: room.reactWhenReadOnly,
    notice: !!room.notice,
    noticeAck: !!room.noticeAck,
    broadcast: !!room.broadcast,
    default: room.default,
    featured: room.featured,
    encrypted: room.encrypted,
    joinCode: '',
    retention: room.retention ?? { enabled: false, overrideGlobal: false, maxAgeDays: 30, filesOnly: false, excludePinned: true },
  };
}

const INFO_TILES: { id: PanelId; icon: IconName; label: string }[] = [
  { id: 'members', icon: 'panel-members', label: 'Membros' },
  { id: 'files', icon: 'panel-files', label: 'Arquivos' },
  { id: 'notifications', icon: 'panel-notifications', label: 'Notificações' },
];

function InfoPanel({ room, sub, roles, available, onPanel, onChanged }: Props) {
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<any>({});
  const imageRef = useRef<HTMLInputElement>(null);
  const canEdit = hasPerm('edit-room', roles);
  const canSetRO = hasPerm('set-readonly', roles);
  const canSetReact = hasPerm('set-react-when-readonly', roles);
  const isAdmin = useStore((s) => s.me?.permissions.includes('view-room-administration'));
  const canRetention = useStore((s) => s.me?.permissions.includes('edit-room-retention-policy'));
  useEffect(() => {
    setF(roomForm(room));
  }, [room, edit]);

  const save = async () => {
    try {
      // Só o que mudou: quem não tem set-readonly (moderador) salva o resto sem 403 e sem mensagens de sistema à toa.
      const base: Record<string, any> = roomForm(room);
      const body: any = { rid: room._id };
      for (const [k, v] of Object.entries(f)) if (JSON.stringify(v) !== JSON.stringify(base[k])) body[k] = v;
      // Canal de avisos é sempre somente leitura: o servidor cuida de ro.
      if (f.notice) delete body.readOnly;
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
            {canSetRO && (room.t === 'c' || room.t === 'p') && (
              <>
                {/* Desligar um canal de avisos libera a escrita e mostra os membros (dá para religar abaixo); numa sala que não
                    era de avisos, ligar e desligar antes de salvar volta ao que estava. */}
                <Toggle
                  checked={f.notice}
                  onChange={(v) => {
                    const leaving = !v && room.notice;
                    setF({ ...f, notice: v, readOnly: leaving ? false : f.readOnly, broadcast: leaving ? false : !!room.broadcast });
                  }}
                  label="Canal de avisos"
                  description="Só donos, moderadores e publicadores escrevem; todos leem."
                />
                {f.notice ? (
                  <div className="notice-opts">
                    {canSetReact && <Toggle checked={f.reactWhenReadOnly} onChange={(v) => setF({ ...f, reactWhenReadOnly: v })} label="Permitir reações aos avisos" />}
                    <Toggle checked={f.noticeAck} onChange={(v) => setF({ ...f, noticeAck: v })} label="Pedir “Ciente” nos avisos" />
                    <Toggle checked={f.broadcast} onChange={(v) => setF({ ...f, broadcast: v })} label="Ocultar a lista de membros" />
                  </div>
                ) : (
                  <>
                    <Toggle checked={f.readOnly} onChange={(v) => setF({ ...f, readOnly: v })} label="Somente leitura" />
                    {canSetReact && <Toggle checked={f.reactWhenReadOnly} onChange={(v) => setF({ ...f, reactWhenReadOnly: v })} label="Permitir reações em somente leitura" />}
                    {/* Sala que tinha a lista oculta (aviso desligado agora, ou "Transmissão" antiga): dá para desfazer aqui. */}
                    {room.broadcast && <Toggle checked={f.broadcast} onChange={(v) => setF({ ...f, broadcast: v })} label="Ocultar a lista de membros" />}
                  </>
                )}
              </>
            )}
            <Toggle checked={f.encrypted} onChange={(v) => setF({ ...f, encrypted: v })} label="Criptografada" />
            {f.roomType === 'c' && (
              <Field label="Código de acesso" hint="Deixe vazio para não exigir código.">
                <input value={f.joinCode} onChange={(e) => setF({ ...f, joinCode: e.target.value })} placeholder="(sem alteração)" />
              </Field>
            )}
            {isAdmin && (
              <>
                <Toggle checked={f.default} onChange={(v) => setF({ ...f, default: v })} label="Sala padrão" description="Novos usuários entram automaticamente." />
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
        <div className="info-image">
          <input
            ref={imageRef}
            type="file"
            accept="image/*"
            tabIndex={-1}
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void setAvatar(file);
            }}
          />
          <button type="button" className="btn" onClick={() => imageRef.current?.click()}>
            <Icon name="image-change" />
            Trocar imagem da sala
          </button>
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setEdit(false)}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save}>
            Salvar
          </button>
        </div>
      </div>
    );

  const name = roomDisplayName(sub, room);
  const group = room.t === 'd' && ((room.uids?.length ?? 0) > 2 || !!sub?.name.includes(','));
  const dm = room.t === 'd' && !group && sub ? sub.name : null;
  const tiles = INFO_TILES.filter((t) => available.includes(t.id));
  const canDelete = hasPerm(room.t === 'c' ? 'delete-c' : room.t === 'p' ? 'delete-p' : 'delete-d', roles);
  const toTeam = room.t !== 'd' && !room.teamMain && !room.prid && !room.teamId && hasPerm('create-team', roles) && canEdit;
  const toChannel = room.teamMain && hasPerm('edit-team', roles);
  const canArchive = room.t !== 'd' && hasPerm('archive-room', roles);
  const convert = async (team: boolean) => {
    const yes = await confirmDialog(
      team
        ? { title: 'Converter em time?', body: 'A sala vira um time, que pode reunir outros canais.', confirmLabel: 'Converter em time' }
        : { title: 'Converter em canal?', body: 'O time vira um canal comum.', confirmLabel: 'Converter em canal' },
    );
    if (!yes) return;
    (team ? api.post('rooms.convertToTeam', { roomId: room._id }) : api.post('teams.convertToChannel', { teamId: room.teamId })).then(onChanged).catch(fail);
  };
  const remove = async () => {
    const yes = await confirmDialog(
      dm
        ? { title: `Excluir a conversa com ${name}?`, body: 'A conversa e todas as mensagens dela serão apagadas para as duas pessoas. Isso não pode ser desfeito.', confirmLabel: 'Excluir conversa', danger: true }
        : { title: `Excluir ${room.t === 'd' || room.prid ? name : `#${name}`}?`, body: 'A sala e todas as mensagens dela serão apagadas. Isso não pode ser desfeito.', confirmLabel: 'Excluir sala', danger: true },
    );
    if (!yes) return;
    const call = room.teamMain ? api.post('teams.delete', { teamId: room.teamId }) : api.post('rooms.delete', { roomId: room._id });
    call.then(() => navigate('/home')).catch(fail);
  };

  return (
    <div className="info">
      <div className="info-hero">
        {/* A mesma identidade da lista e do cabeçalho: a pessoa, o par de avatares do grupo, a imagem da sala quando
            alguém pôs uma, ou o ícone do tipo (#, cadeado, megafone) em vez das iniciais geradas. */}
        {dm ? (
          <UserAvatar username={dm} size={72} />
        ) : group ? (
          <GroupAvatar usernames={room.usernames ?? []} size={72} />
        ) : room.avatarETag ? (
          <Avatar rid={room._id} size={72} etag={room.avatarETag} />
        ) : (
          <span className="info-hero-icon" aria-hidden="true">
            <Icon name={roomIconName(room)} size={32} />
          </span>
        )}
        <h2>
          {/* O ícone do tipo ao lado do nome só quando a sala tem imagem própria; senão ele já é o bloco acima. */}
          {room.t !== 'd' && room.avatarETag && <Icon name={roomIconName(room)} size={18} />}
          <span>{name}</span>
        </h2>
        {dm && <div className="info-handle">@{dm}</div>}
        {/* O tópico aparece só aqui, sob o nome (não se repete numa seção abaixo). */}
        {room.topic && <div className="info-topic">{renderMarkdown(room.topic)}</div>}
      </div>
      {tiles.length > 0 && (
        <div className="info-tiles">
          {tiles.map((t) => (
            <button key={t.id} type="button" className="info-tile" onClick={() => onPanel(t.id)}>
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
      {room.description && (
        <section>
          <h4>Descrição</h4>
          {renderMarkdown(room.description)}
        </section>
      )}
      {room.announcement && (
        <section>
          <h4>Anúncio</h4>
          {renderMarkdown(room.announcement)}
        </section>
      )}
      {room.notice && <NoticeInfo room={room} />}
      <section className="info-meta">
        <p>
          {dm ? 'Conversa iniciada' : 'Criada'} em {formatDateTime(room.ts)}
          {dm ? '' : ` · ${plural(room.usersCount ?? 0, 'membro', 'membros')}`} · {plural(room.msgs ?? 0, 'mensagem', 'mensagens')}
        </p>
        {room.retention?.overrideGlobal && room.retention.enabled && (
          <p className="info-retention">
            <Icon name="retention" size={14} />
            Mensagens com mais de {room.retention.maxAgeDays} dias são apagadas automaticamente.
          </p>
        )}
      </section>
      {(canEdit && room.t !== 'd') || toTeam || toChannel || canArchive ? (
        <div className="info-actions">
          {canEdit && room.t !== 'd' && (
            <button type="button" className="btn ghost" onClick={() => setEdit(true)}>
              <Icon name="edit" />
              Editar
            </button>
          )}
          {toTeam && (
            <button type="button" className="btn ghost" onClick={() => void convert(true)}>
              <Icon name="room-team" />
              Converter em time
            </button>
          )}
          {toChannel && (
            <button type="button" className="btn ghost" onClick={() => void convert(false)}>
              <Icon name="room-channel" />
              Converter em canal
            </button>
          )}
          {canArchive && (
            <button type="button" className="btn ghost" onClick={() => api.post(room.archived ? 'channels.unarchive' : 'channels.archive', { roomId: room._id }).then(onChanged).catch(fail)}>
              <Icon name={room.archived ? 'unarchive' : 'archive'} />
              {room.archived ? 'Desarquivar' : 'Arquivar'}
            </button>
          )}
        </div>
      ) : null}
      {canDelete && (
        <div className="danger-zone">
          <p>{room.t === 'd' ? 'Excluir apaga a conversa e todas as mensagens. Não dá para desfazer.' : 'Excluir apaga a sala e todas as mensagens. Não dá para desfazer.'}</p>
          <button type="button" className="btn danger" onClick={() => void remove()}>
            <Icon name="delete" />
            {room.t === 'd' ? 'Excluir conversa' : 'Excluir sala'}
          </button>
        </div>
      )}
    </div>
  );
}

const PUBLISHER_ROLES = ['owner', 'moderator', 'publisher'];

// Quem publica num canal de avisos e como os avisos funcionam nele.
function NoticeInfo({ room }: { room: Room }) {
  const { data, loading, error } = useAsync(
    () => api.get(`${room.t === 'p' ? 'groups' : 'channels'}.roles`, { roomId: room._id }) as Promise<{ roles: { u: { _id: string; username: string; name?: string }; roles: string[] }[] }>,
    [room._id, room.t],
  );
  const people = (data?.roles ?? [])
    .map((r) => ({ u: r.u, roles: PUBLISHER_ROLES.filter((x) => r.roles.includes(x)) }))
    .filter((r) => r.roles.length)
    .sort((a, b) => PUBLISHER_ROLES.indexOf(a.roles[0]) - PUBLISHER_ROLES.indexOf(b.roles[0]) || a.u.username.localeCompare(b.u.username, 'pt-BR'));
  return (
    <section className="notice-info">
      <h4>
        <Icon name="notice" size={14} />
        Canal de avisos
      </h4>
      <p>Quem publica: donos, moderadores e publicadores da sala, além de quem tem permissão para publicar em salas somente leitura.</p>
      {loading ? (
        <SkeletonList n={2} />
      ) : error ? (
        <p className="muted small">{error}</p>
      ) : (
        people.length > 0 && (
          <ul className="plain-list">
            {people.map((p) => (
              <li key={p.u._id}>
                <Avatar username={p.u.username} size={24} />
                <span className="ack-person">
                  <strong>{p.u.name || p.u.username}</strong> <span className="muted">@{p.u.username}</span>
                </span>
                {p.roles.map((r) => (
                  <span key={r} className={r === 'owner' ? 'pill accent' : 'pill'}>
                    {roleLabel(r)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )
      )}
      <p className="muted small">
        {room.reactWhenReadOnly ? 'Reações: permitidas' : 'Reações: não permitidas'} · {room.noticeAck ? 'Ciente: ativado' : 'Ciente: desativado'}
      </p>
    </section>
  );
}

type ThreadFilter = 'all' | 'following' | 'unread';
const THREAD_EMPTY: Record<ThreadFilter, [string, string]> = {
  all: ['Nenhum tópico', 'Use “Responder no tópico” em uma mensagem para começar um.'],
  following: ['Nenhum tópico seguido', 'Os tópicos em que você responde ou que você segue aparecem aqui.'],
  unread: ['Tudo lido', 'Não há tópicos com respostas novas.'],
};

function ThreadsPanel({ room }: Props) {
  const [type, setType] = useState<ThreadFilter>('all');
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.get('chat.getThreadsList', { rid: room._id, type, count: 50 }), [room._id, type]);
  return (
    <>
      <div className="panel-filters">
        <Segmented
          value={type}
          onChange={setType}
          label="Filtrar tópicos"
          items={[
            { id: 'all', label: 'Todos' },
            { id: 'following', label: 'Seguindo' },
            { id: 'unread', label: 'Não lidos' },
          ]}
        />
      </div>
      {loading ? (
        <SkeletonList />
      ) : !data?.threads.length ? (
        <Empty icon="panel-threads" title={THREAD_EMPTY[type][0]}>
          {THREAD_EMPTY[type][1]}
        </Empty>
      ) : (
        data.threads.map((m: Message) => (
          <button key={m._id} type="button" className="result thread-row" onClick={() => navigate(`${roomPath(room)}/thread/${m._id}`)}>
            <div className="result-head">
              <Avatar username={m.u.username} size={20} />
              <strong title={`@${m.u.username}`}>{m.u.name || m.u.username}</strong>
              <time className="muted" dateTime={m.ts} title={formatDateTime(m.ts)}>
                {formatWhen(m.ts)}
              </time>
            </div>
            <div className="result-body clamp">{!m.msg && m.sticker ? stickerPreviewText(m.sticker) : resultBody(m)}</div>
            <div className="result-foot">
              <Icon name="panel-threads" size={14} />
              <span className="result-count">{plural(m.tcount ?? 0, 'resposta', 'respostas')}</span>
              {m.tlm && <span className="muted">· última {formatRelative(m.tlm)}</span>}
            </div>
          </button>
        ))
      )}
    </>
  );
}

function DiscussionsPanel({ room }: Props) {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.get('rooms.getDiscussions', { roomId: room._id, count: 100 }), [room._id]);
  if (loading) return <SkeletonList />;
  if (!data?.discussions.length)
    return (
      <Empty icon="panel-discussions" title="Nenhuma discussão">
        Inicie uma discussão pelo menu ⋯ de uma mensagem.
      </Empty>
    );
  return data.discussions.map((d: Room) => (
    <button key={d._id} type="button" className="result" onClick={() => navigate(roomPath(d))}>
      <div className="result-head">
        <Icon name="room-discussion" />
        <strong>{d.fname}</strong>
      </div>
      <div className="result-foot muted">
        {plural(d.msgs ?? 0, 'mensagem', 'mensagens')} · {formatRelative(d.lm ?? d.ts)}
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
  const canEditRooms = hasPerm('edit-team-channel', roles);
  const canRemoveRooms = hasPerm('remove-team-channel', roles);
  return (
    <>
      {canAdd && !adding && (
        <button type="button" className="btn primary panel-cta" onClick={() => setAdding(true)}>
          <Icon name="add" />
          Criar canal no time
        </button>
      )}
      {adding && (
        <div className="form panel-add">
          <input placeholder="nome-do-canal" aria-label="Nome do canal" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} />
          <Toggle checked={priv} onChange={setPriv} label="Privado" />
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => api.post('teams.createRoom', { teamId: room.teamId, name, type: priv ? 'p' : 'c' }).then(() => (setAdding(false), setName(''), reload())).catch(fail)}
            >
              Criar
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <SkeletonList />
      ) : !data?.rooms.length ? (
        <Empty icon="panel-team" title="Nenhum canal no time">
          Crie canais para separar os assuntos do time.
        </Empty>
      ) : (
        data.rooms.map((r: any) => {
          const label = r.fname || r.name;
          // Nome longo: uma linha com reticências; membros e "padrão" na linha de baixo, ações no menu.
          return (
            <div key={r._id} className="list-row team-row">
              <button type="button" className="link team-room" title={label} onClick={() => navigate(roomPath(r))}>
                <Icon name={roomIconName(r)} />
                <span className="team-room-text">
                  <span className="team-room-name">{label}</span>
                  <span className="muted small">
                    {plural(r.usersCount ?? 0, 'membro', 'membros')}
                    {r.teamDefault && ' · padrão'}
                  </span>
                </span>
              </button>
              {!r.isMember && r.t === 'c' && (
                <button type="button" className="btn small" onClick={() => api.post('channels.join', { roomId: r._id }).then(reload).catch(fail)}>
                  Entrar
                </button>
              )}
              {(canEditRooms || canRemoveRooms) && (
                <Menu
                  label={`Ações de ${label}`}
                  trigger={
                    <button type="button" className="icon-btn team-room-more" title="Mais ações" aria-label="Mais ações">
                      <Icon name="more" size={16} />
                    </button>
                  }
                >
                  {(close) => (
                    <>
                      {canEditRooms && (
                        <button
                          title="Novos membros do time entram automaticamente"
                          onClick={() => (close(), api.post('teams.updateRoom', { roomId: r._id, isDefault: !r.teamDefault }).then(reload).catch(fail))}
                        >
                          <Icon name={r.teamDefault ? 'unpin' : 'pin'} />
                          {r.teamDefault ? 'Tirar padrão' : 'Tornar padrão'}
                        </button>
                      )}
                      {canRemoveRooms && (
                        <button className="danger" onClick={() => (close(), api.post('teams.removeRoom', { teamId: room.teamId, roomId: r._id }).then(reload).catch(fail))}>
                          <Icon name="team-remove-room" />
                          Remover do time
                        </button>
                      )}
                    </>
                  )}
                </Menu>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

// Dono primeiro; o resto na ordem do servidor.
const ROLE_ORDER = ['owner', 'moderator', 'leader', 'publisher'];

function MemberRow({ m, muted, onClick }: { m: any; muted: boolean; onClick: () => void }) {
  const roles = [...(m.roles as string[])].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
  const statusText = m.statusText || (m.status && m.status !== 'offline' ? STATUS_LABEL[m.status] : '');
  return (
    <button type="button" className="member" onClick={onClick}>
      <UserAvatar username={m.username} size={32} status={m.status} />
      <span className="member-who">
        <span className="member-name">
          {/* Chamadas em grupo: o nome encurta com reticências e o "Em chamada" fica sempre à vista. */}
          <span className="member-name-text">{m.name || m.username}</span>
          <InCallBadge userId={m._id} />
        </span>
        <span className="member-sub">
          @{m.username}
          {statusText && ` · ${statusText}`}
        </span>
      </span>
      {muted && (
        <span className="pill member-muted" title="Silenciado" aria-label="Silenciado">
          <Icon name="muted-user" size={12} />
        </span>
      )}
      {roles.map((r) => (
        <span key={r} className={r === 'owner' ? 'pill accent' : 'pill'}>
          {roleLabel(r)}
        </span>
      ))}
    </button>
  );
}

function MembersPanel({ room, roles, onUserClick }: Props) {
  const [filter, setFilter] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<PickedUser[]>([]);
  // "Ocultar a lista de membros": sem view-broadcast-member-list o servidor recusa a lista.
  const hidden = !!room.broadcast && !hasPerm('view-broadcast-member-list', roles);
  const { data, error, loading, reload } = useAsync(
    () => (hidden ? Promise.resolve(null) : api.get('rooms.membersOrderedByRole', { roomId: room._id, filter, count: 200 })),
    [room._id, filter, hidden],
  );
  const canAdd = hasPerm('add-user-to-joined-room', roles);
  const direct = useDirect();
  // Grupo privado ou canal de um time privado: só os membros leem.
  const isPrivate = room.t === 'p' || (room.t === 'c' && !room.teamMain && (room as any).team?.type === 1);
  const all: any[] = data?.members ?? [];
  const online = all.filter((m) => m.status && m.status !== 'offline');
  const offline = onlineOnly ? [] : all.filter((m) => !m.status || m.status === 'offline');
  if (hidden)
    return (
      <Empty icon="panel-members" title="Lista de membros oculta">
        Só donos e moderadores veem quem participa deste canal.
      </Empty>
    );
  const invite = () =>
    api
      .post(
        room.teamMain ? 'teams.addMembers' : room.t === 'p' ? 'groups.invite' : 'channels.invite',
        room.teamMain ? { teamId: room.teamId, members: adding.map((u) => ({ userId: u._id })) } : { roomId: room._id, userIds: adding.map((u) => u._id) },
      )
      .then(() => (setAdding([]), setPicking(false), reload()))
      .catch(fail);
  const group = (title: string, list: any[]) =>
    list.length > 0 && (
      <div className="member-group" role="group" aria-label={title}>
        <h4 className="group-label">
          {title} · {list.length.toLocaleString('pt-BR')}
        </h4>
        {list.map((m) => (
          <MemberRow key={m._id} m={m} muted={!!room.muted?.includes(m.username)} onClick={() => onUserClick(m.username)} />
        ))}
      </div>
    );
  return (
    <>
      {canAdd && room.t !== 'd' && (
        <div className="panel-add">
          {!picking ? (
            <button type="button" className="btn primary panel-cta" onClick={() => setPicking(true)}>
              <Icon name="add-people" />
              Adicionar pessoas
            </button>
          ) : (
            <div className="form">
              <UserPicker
                value={adding}
                onChange={setAdding}
                placeholder="Buscar pessoas para adicionar"
                itemDisabled={isPrivate ? (u) => direct.bringIn(adding.map(partyOf), partyOf(u)) : undefined}
              />
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => (setPicking(false), setAdding([]))}>
                  Cancelar
                </button>
                <button type="button" className="btn primary" disabled={!adding.length} onClick={invite}>
                  {adding.length ? `Adicionar ${adding.length}` : 'Adicionar'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="panel-filters">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filtrar membros" />
        <Toggle checked={onlineOnly} onChange={setOnlineOnly} label="Somente online" />
      </div>
      {loading && !data ? (
        <SkeletonList />
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : !online.length && !offline.length ? (
        <Empty icon="panel-members" title={filter ? `Ninguém encontrado para "${filter}"` : 'Ninguém online agora'}>
          {filter ? 'Confira a grafia ou busque por outro nome.' : 'Desligue "Somente online" para ver todos os membros.'}
        </Empty>
      ) : (
        <>
          {group('Online', online)}
          {group('Offline', offline)}
        </>
      )}
    </>
  );
}

// Termos a destacar nos resultados: sem operadores (from:, has:…) nem /regex/; aspas viram uma frase.
function searchTerms(q: string) {
  return [...q.matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2]).toLowerCase())
    .filter((t) => t.length > 1 && !/^[a-z]+:/i.test(t) && !/^\/.*\/[a-z]*$/i.test(t));
}

// Destaque com a CSS Custom Highlight API: não mexe no DOM que o React desenha. Sem suporte, fica sem destaque.
function useHighlight(ref: RefObject<HTMLElement | null>, terms: string[], key: unknown) {
  useLayoutEffect(() => {
    const reg = (globalThis.CSS as any)?.highlights;
    const H = (globalThis as any).Highlight;
    const root = ref.current;
    if (!reg || !H || !root || !terms.length) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement?.closest('.result-body')) continue;
      const text = (n.textContent ?? '').toLowerCase();
      for (const t of terms) {
        for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + t.length);
          ranges.push(r);
        }
      }
    }
    reg.set('search-hit', new H(...ranges));
    return () => reg.delete('search-hit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

const SEARCH_TIPS: [string, string][] = [
  ['from:@', 'De uma pessoa'],
  ['has:file', 'Com arquivo'],
  ['has:link', 'Com link'],
  ['is:pinned', 'Fixadas'],
  ['after:', 'Depois de uma data (AAAA-MM-DD)'],
  ['"frase exata"', 'Exatamente estas palavras'],
];

function SearchPanel({ room }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const { data, loading, error } = useAsync(() => (q ? api.get('chat.search', { roomId: room._id, searchText: q, count: 50 }) : Promise.resolve(null)), [q, room._id]);
  const terms = searchTerms(q);
  useHighlight(list, terms, data);
  return (
    <>
      <div className="panel-filters">
        <SearchInput autoFocus value={text} onChange={setText} placeholder="Buscar mensagens" />
        {/* Os filtros mais usados, com o que fazem, atrás de um toque: a nuvem de operadores parecia sintaxe de
            programador. Escolher um filtro põe o operador na busca. */}
        <details className="search-tips">
          <summary>
            <Icon name="search-filters" size={14} />
            Filtros de busca
          </summary>
          <ul className="search-help" aria-label="Operadores de busca">
            {SEARCH_TIPS.map(([op, what]) => (
              <li key={op}>
                <button type="button" className="search-tip" onClick={() => setText((t) => `${t.trim()} ${op}`.trim() + (op.endsWith(':') || op.endsWith('@') ? '' : ' '))}>
                  <kbd>{op}</kbd>
                  <span>{what}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!q ? (
        <Empty icon="search" title="Buscar nesta sala">
          Digite acima para procurar nas mensagens desta sala.
        </Empty>
      ) : loading ? (
        <div role="status" aria-label="Buscando…">
          <SkeletonList n={5} delay={0} />
        </div>
      ) : (
        data &&
        (data.messages.length ? (
          <div className="results" ref={list}>
            <p className="results-count">{plural(data.messages.length, 'resultado', 'resultados')}</p>
            {data.messages.map((m: Message) => (
              <MessageResult key={m._id} m={m} />
            ))}
          </div>
        ) : (
          <Empty icon="search" title={`Nada encontrado para "${q}"`}>
            Confira a grafia ou tente outros termos.
          </Empty>
        ))
      )}
    </>
  );
}

// "PDF", "PNG"…: a extensão do nome, ou o subtipo do MIME.
function fileType(f: { name?: string; type?: string }) {
  const ext = f.name?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return (ext ?? f.type?.split('/')[1] ?? 'arquivo').toUpperCase();
}

function FilesPanel({ room }: Props) {
  const nameOf = useNames();
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const { data, loading } = useAsync(() => api.get('rooms.files', { roomId: room._id, name, typeGroup: type, count: 100 }), [room._id, name, type]);
  return (
    <>
      <div className="panel-filters">
        <SearchInput value={name} onChange={setName} placeholder="Filtrar por nome" />
        <select value={type} aria-label="Tipo de arquivo" onChange={(e) => setType(e.target.value)}>
          <option value="">Todos os tipos</option>
          <option value="image/*">Imagens</option>
          <option value="video/*">Vídeos</option>
          <option value="audio/*">Áudios</option>
          <option value="application/*">Documentos</option>
          <option value="text/*">Texto</option>
        </select>
      </div>
      {loading && !data ? (
        <SkeletonList />
      ) : !data?.files.length ? (
        name || type ? (
          <Empty icon="panel-files" title={name ? `Nada encontrado para "${name}"` : 'Nenhum arquivo deste tipo'}>
            Confira o nome ou escolha outro tipo.
          </Empty>
        ) : (
          <Empty icon="panel-files" title="Nenhum arquivo">
            Os arquivos enviados nesta sala aparecem aqui.
          </Empty>
        )
      ) : (
        data.files.map((f: any) => (
          <div key={f._id} className="file-row">
            <a className="file-row-main" href={f.url} target="_blank" rel="noreferrer">
              {f.type?.startsWith('image/') ? <img src={f.url} alt="" loading="lazy" /> : <FileTile name={f.name} mime={f.type} />}
              <span className="file-row-text">
                <span className="file-row-name">{f.name}</span>
                <span className="file-row-meta">
                  {[fileType(f), formatBytes(f.size), f.user?.name || (f.user?.username ? nameOf(f.user.username) : ''), f.uploadedAt ? formatWhen(f.uploadedAt) : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
            </a>
            <a className="icon-btn file-row-download" href={`${f.url}?download`} download={f.name} title="Baixar" aria-label={`Baixar ${f.name}`}>
              <Icon name="download" />
            </a>
          </div>
        ))
      )}
    </>
  );
}

const FLAG_EMPTY: Record<'pinned' | 'starred' | 'mentions', [IconName, string, string]> = {
  pinned: ['panel-pinned', 'Nenhuma mensagem fixada', 'Fixe mensagens pelo menu ⋯ de cada mensagem.'],
  starred: ['panel-starred', 'Nenhuma mensagem favorita', 'Marque mensagens como favoritas pelo menu ⋯ de cada mensagem.'],
  mentions: ['panel-mentions', 'Nenhuma menção', 'Quando alguém mencionar você nesta sala, a mensagem aparece aqui.'],
};

function FlagPanel({ id, room }: Props) {
  const path = id === 'pinned' ? 'chat.getPinnedMessages' : id === 'starred' ? 'chat.getStarredMessages' : 'chat.getMentionedMessages';
  const { data, loading } = useAsync(() => api.get(path, { roomId: room._id, count: 100 }), [room._id, id]);
  if (loading) return <SkeletonList />;
  if (!data?.messages.length) {
    const [icon, title, text] = FLAG_EMPTY[id as keyof typeof FLAG_EMPTY];
    return (
      <Empty icon={icon} title={title}>
        {text}
      </Empty>
    );
  }
  return data.messages.map((m: Message) => <MessageResult key={m._id} m={m} />);
}

function NotificationsPanel({ room, sub }: Props) {
  const [n, setN] = useState<any>(sub?.notifications ?? {});
  if (!sub)
    return (
      <Empty icon="panel-notifications" title="Você não participa desta sala">
        Entre na sala para configurar as notificações.
      </Empty>
    );
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
      <Field label="Avisar sobre">
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const gen = async () => {
    try {
      const r = await api.post('findOrCreateInvite', { rid: room._id, days, maxUses });
      setLink(`${location.origin}${r.url}`);
    } catch (e) {
      fail(e);
    }
  };
  const copy = () =>
    navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => fail(new Error('Não foi possível copiar. Selecione o link e copie.')),
    );
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
      <button type="button" className="btn primary" onClick={gen}>
        <Icon name="link" />
        Gerar link
      </button>
      {link && (
        <div className="copy-box">
          <input readOnly value={link} aria-label="Link de convite" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn" onClick={copy} aria-live="polite">
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copiado' : 'Copiar'}
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
    const yes = await confirmDialog({
      title: 'Limpar o histórico?',
      body: 'As mensagens do período escolhido serão apagadas. Isso não pode ser desfeito.',
      confirmLabel: 'Limpar histórico',
      danger: true,
    });
    if (!yes) return;
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
      ok(`${plural(r.count ?? 0, 'item removido', 'itens removidos')}.`);
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
      <button type="button" className="btn danger" onClick={run}>
        <Icon name="panel-prune" />
        Limpar histórico
      </button>
    </div>
  );
}
