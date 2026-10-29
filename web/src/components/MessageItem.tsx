import {
  Component,
  createContext,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { Attachment, Message } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { startCall } from '../lib/calls';
import { formatBytes, formatDateTime, formatDuration, formatRelative, formatTime, formatWhen, nameList, plural, roomPath, systemIcon, systemText } from '../lib/format';
import { resolveEmoji } from '../lib/emoji';
import { isEmojiOnly, renderMarkdown } from '../lib/markdown';
import { canRemoveEverywhere, useStickers } from '../lib/stickers';
import { useNames } from '../lib/names';
import { avatarBust, useSetting, useStore } from '../lib/store';
import { EmojiPicker, recentEmoji } from './EmojiPicker';
import { Icon, type IconName } from './Icon';
import { Portal, Sheet, useEscape, useFocusTrap, useMedia, useScrollLock } from './overlay';
import { StickerCard } from './stickers/StickerCard';
import { CreateStickerItem, StickerHost, StickerMenuItems, StickerRemoveItem, useCreateSticker } from './stickers/StickerMenuItems';
import { StickerView } from './stickers/StickerView';
import { Avatar, confirmDialog, Empty, Field, Menu, Modal, SkeletonList, useAsync } from './ui';

export interface MessageActions {
  onReplyThread?: (m: Message) => void;
  onEdit?: (m: Message) => void;
  onQuote?: (m: Message) => void;
  onDiscussion?: (m: Message) => void;
  onUserClick?: (username: string) => void;
  // Ações que a sala recusaria (somente leitura, conversa direta bloqueada): sem os botões. Padrão: true.
  canReact?: boolean;
  canReply?: boolean;
  canDiscuss?: boolean;
}

export type MessageGate = Pick<MessageActions, 'canReact' | 'canReply' | 'canDiscuss'> & {
  // Recibos de leitura (as mesmas regras do servidor): com a permissão de ver recibos; num canal de avisos, com a lista
  // de membros oculta ou num aviso com "Ciente", os das mensagens dos outros só para quem publica (ou vê a lista oculta).
  canSeeReceipts?: boolean;
  receiptsLimited?: boolean;
  canSeeLimitedReceipts?: boolean;
  // Fixar: permissão pin-message (global ou da sala); em DMs, qualquer participante. Padrão: true.
  canPin?: boolean;
};

// As mesmas regras para toda mensagem da sala, inclusive as da thread, que monta as próprias ações.
// O que vier em actions tem prioridade.
export const MessageGateContext = createContext<MessageGate>({});

// ---------- Mensagem em edição (marcada na lista com .editing) ----------

let editingId: string | null = null;
const editingListeners = new Set<() => void>();
const subscribeEditing = (l: () => void) => {
  editingListeners.add(l);
  return () => {
    editingListeners.delete(l);
  };
};

// O compositor avisa qual mensagem está editando; só a linha dela renderiza de novo.
export function setEditingMessage(id: string | null) {
  if (editingId === id) return;
  editingId = id;
  for (const l of editingListeners) l();
}

const useIsEditing = (id: string) => useSyncExternalStore(subscribeEditing, () => editingId === id);

// ---------- Arquivos: tipo, ícone e cor do quadradinho ----------

export type FileKind = 'pdf' | 'doc' | 'sheet' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'other';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  txt: 'doc',
  rtf: 'doc',
  md: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  json: 'code',
  js: 'code',
  ts: 'code',
  xml: 'code',
  html: 'code',
  sql: 'code',
};

const KIND_ICON: Record<FileKind, IconName> = {
  pdf: 'file-doc',
  doc: 'file-doc',
  sheet: 'file-sheet',
  image: 'file-image',
  video: 'file-video',
  audio: 'file-audio',
  archive: 'file-archive',
  code: 'file-code',
  other: 'file',
};

export function fileKind(name?: string, mime?: string): FileKind {
  const ext = name?.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

export const fileIconName = (name?: string, mime?: string): IconName => KIND_ICON[fileKind(name, mime)];

// Quadradinho do tipo de arquivo (cartão do anexo, lista de arquivos, importação): 36px ou 28px.
export function FileTile({ name, mime, size = 36 }: { name?: string; mime?: string; size?: 28 | 36 }) {
  const k = fileKind(name, mime);
  return (
    <span className={size === 28 ? 'att-tile sm' : 'att-tile'} data-kind={k} aria-hidden="true">
      <Icon name={KIND_ICON[k]} size={size === 28 ? 16 : 18} />
    </span>
  );
}

// Só links http(s) ou do próprio servidor (o servidor já filtra; aqui é a segunda barreira).
const safeHref = (url?: string) => (url && /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : undefined);

// Cores nomeadas dos anexos no formato do Slack.
const ATT_COLORS: Record<string, string> = { good: '#2eb67d', warning: '#ecb22e', danger: '#e01e5a' };

function attachmentColor(c?: string) {
  if (!c) return undefined;
  const v = c.trim().toLowerCase();
  if (ATT_COLORS[v]) return ATT_COLORS[v];
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return v.startsWith('#') ? v : `#${v}`;
  return undefined;
}

// ---------- Imagens e visualizador ----------

function Lightbox({ src, title, download, m, onClose }: { src: string; title?: string; download?: string; m?: Message; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  useScrollLock(true);
  useFocusTrap(ref, true);
  const name = m ? m.alias || m.u.name || m.u.username : '';
  return (
    <Portal>
      <div
        ref={ref}
        className="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Imagem'}
        tabIndex={-1}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.lightbox-img, .lightbox-bar a, .lightbox-bar button')) onClose();
        }}
      >
        <img className="lightbox-img" src={src} alt={title ?? ''} />
        <div className="lightbox-bar">
          <div className="lightbox-who">
            {m && (
              <>
                <Avatar username={m.u.username} size={32} />
                <span className="lightbox-meta">
                  <span className="lightbox-name">{name}</span>
                  <span className="lightbox-time">{formatDateTime(m.ts)}</span>
                </span>
              </>
            )}
          </div>
          <div className="lightbox-file">{title}</div>
          <div className="lightbox-actions">
            {download && (
              <a className="lightbox-btn" href={`${download}?download`} title="Baixar" aria-label="Baixar">
                <Icon name="download" size={20} />
              </a>
            )}
            <a className="lightbox-btn" href={src} target="_blank" rel="noreferrer" title="Abrir em nova aba" aria-label="Abrir em nova aba">
              <Icon name="open-external" size={20} />
            </a>
            <button type="button" className="lightbox-btn" onClick={onClose} title="Fechar" aria-label="Fechar">
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// Imagem do anexo: caixa reservada (esqueleto até carregar), ampliar e baixar no hover, abre no visualizador.
function ImageView({ src, title, download, m, thumb, onCreateSticker }: { src: string; title?: string; download?: string; m?: Message; thumb?: boolean; onCreateSticker?: () => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const done = () => setLoaded(true);
  return (
    <span className={`${thumb ? 'att-thumb-box' : 'att-image-box'}${loaded ? ' loaded' : ''}`}>
      <button type="button" className="att-image-open" onClick={() => setOpen(true)} aria-label={title ? `Ampliar ${title}` : 'Ampliar imagem'}>
        <img className={thumb ? 'att-thumb' : 'att-image'} src={src} alt={title ?? ''} loading="lazy" onLoad={done} onError={done} />
      </button>
      {!thumb && (
        <span className="att-image-actions">
          <button type="button" className="glass-btn" title="Ampliar" aria-label="Ampliar" tabIndex={-1} onClick={() => setOpen(true)}>
            <Icon name="expand" size={16} />
          </button>
          {download && (
            <a className="glass-btn" href={`${download}?download`} title="Baixar" aria-label="Baixar">
              <Icon name="download" size={16} />
            </a>
          )}
          {onCreateSticker && (
            <button type="button" className="glass-btn" title="Criar figurinha" aria-label="Criar figurinha" onClick={onCreateSticker}>
              <Icon name="sticker-create" size={16} />
            </button>
          )}
        </span>
      )}
      {open && <Lightbox src={src} title={title} download={download} m={m} onClose={() => setOpen(false)} />}
    </span>
  );
}

// ---------- Anexos ----------

// Arquivo enviado pelo chat (type 'file'): imagem, vídeo, áudio ou cartão de download.
function FileAttachment({ a, m, createSticker }: { a: Attachment; m?: Message; createSticker?: StickerSource }) {
  const link = safeHref(a.title_link);
  const image = safeHref(a.image_url);
  if (image)
    return (
      <div className="att att-media">
        <ImageView src={image} title={a.title} download={link} m={m} onCreateSticker={createSticker && createSticker.url === a.image_url ? createSticker.open : undefined} />
        {a.description && <div className="att-desc">{a.description}</div>}
      </div>
    );
  if (a.video_url) return <video className="att-video" src={safeHref(a.video_url)} controls preload="metadata" />;
  if (a.audio_url) return <audio className="att-audio" src={safeHref(a.audio_url)} controls preload="metadata" />;
  if (link) {
    const meta = [a.format?.toUpperCase(), formatBytes(a.size)].filter(Boolean).join(' · ');
    return (
      <div className="att">
        <a className="att-file" href={`${link}?download`} target="_blank" rel="noreferrer" title={a.title ? `Baixar ${a.title}` : 'Baixar'}>
          <FileTile name={a.title} />
          <span className="att-file-meta">
            <strong className="att-file-name">{a.title}</strong>
            {meta && <span className="att-file-size">{meta}</span>}
          </span>
          <span className="att-file-dl" aria-hidden="true">
            <Icon name="download" size={16} />
          </span>
        </a>
        {a.description && <div className="att-desc">{a.description}</div>}
      </div>
    );
  }
  return null;
}

// Anexo de integração ou de mensagem importada, no formato do Slack.
function RichAttachment({ a, m }: { a: Attachment; m?: Message }) {
  const color = attachmentColor(a.color);
  const titleLink = safeHref(a.title_link);
  const authorLink = safeHref(a.author_link);
  const authorIcon = safeHref(a.author_icon);
  const image = safeHref(a.image_url);
  const thumb = safeHref(a.thumb_url);
  const fields = (a.fields ?? []).filter((f) => f && (f.title || f.value));
  const author = a.author_name || authorIcon ? (
    <div className="att-author">
      {authorIcon && <img src={authorIcon} alt="" width={16} height={16} loading="lazy" />}
      {a.author_name &&
        (authorLink ? (
          <a href={authorLink} target="_blank" rel="noopener noreferrer">
            {a.author_name}
          </a>
        ) : (
          <span>{a.author_name}</span>
        ))}
    </div>
  ) : null;
  const ts = a.ts && !Number.isNaN(Date.parse(a.ts)) ? formatDateTime(a.ts) : '';
  if (!a.pretext && !author && !a.title && !a.text && !a.description && !fields.length && !image && !thumb && !a.video_url && !a.audio_url && !a.footer) return null;
  return (
    <div className="att-rich-wrap">
      {a.pretext && <div className="att-pretext">{renderMarkdown(a.pretext)}</div>}
      <div className="att-rich" style={color ? { borderLeftColor: color } : undefined}>
        <div className="att-rich-main">
          {author}
          {a.title &&
            (titleLink ? (
              <a className="att-title" href={titleLink} target="_blank" rel="noopener noreferrer">
                {a.title}
              </a>
            ) : (
              <div className="att-title">{a.title}</div>
            ))}
          {a.text && <div className="att-text">{renderMarkdown(a.text)}</div>}
          {a.description && <div className="att-desc">{a.description}</div>}
          {fields.length > 0 && (
            <div className="att-fields">
              {fields.map((f, i) => (
                <div key={i} className={`att-field ${f.short ? 'short' : ''}`}>
                  {f.title && <div className="att-field-title">{f.title}</div>}
                  {f.value && <div className="att-field-value">{renderMarkdown(f.value)}</div>}
                </div>
              ))}
            </div>
          )}
          {image && <ImageView src={image} title={a.title} m={m} />}
          {a.video_url && <video className="att-video" src={safeHref(a.video_url)} controls preload="metadata" />}
          {a.audio_url && <audio className="att-audio" src={safeHref(a.audio_url)} controls preload="metadata" />}
          {(a.footer || ts) && (
            <div className="att-footer">
              {a.footer}
              {a.footer && ts ? ' · ' : ''}
              {ts}
            </div>
          )}
        </div>
        {thumb && <ImageView src={thumb} title={a.title} m={m} thumb />}
      </div>
    </div>
  );
}

// Citação: o servidor manda o @usuário do autor; aparece o nome, e a data no formato curto ("Ontem 10:24").
function QuoteAttachment({ a }: { a: Attachment }) {
  const nameOf = useNames();
  return (
    <div className="quote-att">
      <div className="quote-head">
        {a.author_name && <Avatar username={a.author_name} size={16} />}
        <strong>{a.author_name ? nameOf(a.author_name) : ''}</strong>
        {a.ts && (
          <time className="muted" dateTime={a.ts} title={formatDateTime(a.ts)}>
            {formatWhen(a.ts)}
          </time>
        )}
      </div>
      <div className="quote-body">{renderMarkdown(a.text ?? '')}</div>
    </div>
  );
}

// "Criar figurinha" da imagem enviada (só a do arquivo de origem ganha o botão).
type StickerSource = { url: string; open: () => void };

function AttachmentView({ a, m, createSticker }: { a: Attachment; m?: Message; createSticker?: StickerSource }) {
  if (a.message_link) return <QuoteAttachment a={a} />;
  // Arquivo de mensagem importada que ainda está na origem ("Baixar arquivos pendentes" na importação). O texto vem
  // do servidor, que sabe se ele ainda vai ser baixado ou se não está disponível (externo, apagado na origem).
  if (a.pendingFileId)
    return (
      <div className="att-pending" title="Arquivo de uma mensagem importada, ainda na origem da importação">
        <Icon name="attach" size={14} />
        <span>{a.text || `${a.title || 'arquivo'} — arquivo ainda não baixado`}</span>
      </div>
    );
  // Anexos de arquivos sempre têm type 'file'; o link /file-upload/ cobre mensagens antigas.
  if (a.type === 'file' || a.title_link?.startsWith('/file-upload/')) return <FileAttachment a={a} m={m} createSticker={createSticker} />;
  return <RichAttachment a={a} m={m} />;
}

// ---------- Reações ----------

function EmojiGlyph({ code }: { code: string }) {
  const e = resolveEmoji(code);
  if (e?.unicode) return <>{e.unicode}</>;
  if (e?.url) return <img className="emoji custom" src={e.url} alt={code} />;
  return <>{code}</>;
}

function Reactions({ m, canReact, onAdd }: { m: Message; canReact: boolean; onAdd: (anchor: HTMLElement) => void }) {
  const me = useStore((s) => s.me);
  const entries = Object.entries(m.reactions ?? {});
  if (!entries.length) return null;
  const toggle = (code: string) => api.post('chat.react', { messageId: m._id, emoji: code }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
  return (
    <div className="reactions-row">
      <div className="reactions">
        {entries.map(([code, r]) => {
          const mine = r.usernames.includes(me?.username ?? '');
          const title = `${nameList(r.usernames)} ${r.usernames.length === 1 ? 'reagiu' : 'reagiram'} com ${code}`;
          const content = (
            <>
              <span className="reaction-emoji">
                <EmojiGlyph code={code} />
              </span>{' '}
              <span className="n">{r.usernames.length}</span>
            </>
          );
          // Onde reagir é recusado, as reações antigas continuam visíveis, mas não são botões.
          if (!canReact)
            return (
              <span key={code} className={`reaction ${mine ? 'mine' : ''}`} title={title}>
                {content}
              </span>
            );
          return (
            <button key={code} type="button" className={`reaction ${mine ? 'mine' : ''}`} title={title} aria-pressed={mine} onClick={() => toggle(code)}>
              {content}
            </button>
          );
        })}
      </div>
      {canReact && (
        <button type="button" className="reaction-add" title="Adicionar reação" aria-label="Adicionar reação" onClick={(e) => onAdd(e.currentTarget)}>
          <Icon name="react" size={14} />
        </button>
      )}
    </div>
  );
}

// As três reações rápidas da barra: as mais recentes de quem usa, completadas com as de sempre.
const QUICK_DEFAULT = ['+1', 'white_check_mark', 'eyes', 'joy', 'tada', 'pray'];
function quickReactions(n: number) {
  return [...new Set([...recentEmoji(), ...QUICK_DEFAULT])].filter((c) => resolveEmoji(c)).slice(0, n);
}

// ---------- Modais ----------

function ReadReceipts({ m, onClose }: { m: Message; onClose: () => void }) {
  const { data, error } = useAsync(() => api.get('chat.getMessageReadReceipts', { messageId: m._id }), [m._id]);
  const list: any[] | null = data?.receipts ?? null;
  return (
    <Modal title="Lida por" onClose={onClose}>
      {error ? (
        <div className="form-error">{error}</div>
      ) : !list ? (
        <SkeletonList n={4} />
      ) : list.length === 0 ? (
        <Empty>Ninguém leu ainda.</Empty>
      ) : (
        <ul className="plain-list receipt-list">
          {list.map((r) => (
            <li key={r._id}>
              <Avatar username={r.user.username} size={32} />
              <span className="receipt-who">
                <strong>{r.user.name}</strong>
                <span className="muted">@{r.user.username}</span>
              </span>
              <time className="muted">{formatDateTime(r.ts)}</time>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ReportModal({ m, onClose }: { m: Message; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = () => {
    setBusy(true);
    api
      .post('chat.reportMessage', { messageId: m._id, description: text })
      .then(() => (useStore.getState().toast('Denúncia enviada aos moderadores.', 'success'), onClose()))
      .catch((e) => (useStore.getState().toast(errorMessage(e), 'error'), setBusy(false)));
  };
  return (
    <Modal
      title="Denunciar mensagem"
      description="Os moderadores recebem a mensagem e o motivo."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn danger solid" disabled={busy} onClick={send}>
            Denunciar
          </button>
        </>
      }
    >
      <Field label="Motivo">
        <textarea rows={4} placeholder="Descreva o motivo" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------- Linhas especiais ----------

// Linha de sistema: ícone na calha, texto em uma linha e a hora depois de " · ". O texto que não cabe corta com
// reticências e fica inteiro no title.
export function SystemLine({ id, icon, ts, children, className, title }: { id?: string; icon: IconName | null; ts: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={className ? `msg system ${className}` : 'msg system'} id={id}>
      <div className="msg-left">{icon && <Icon name={icon} size={14} />}</div>
      <div className="msg-main">
        <span className="sys-text" title={title}>
          {children}
        </span>
        <SysTime ts={ts} />
      </div>
    </div>
  );
}

function SysTime({ ts }: { ts: string }) {
  return (
    <span className="sys-time">
      {' · '}
      <time className="msg-time" dateTime={ts} title={formatDateTime(ts)}>
        {formatTime(ts)}
      </time>
    </span>
  );
}

// Mensagem de sistema com nomes de exibição (quem recebeu a ação só vem como @usuário).
function SystemMessage({ m }: { m: Message & Record<string, any> }) {
  const nameOf = useNames();
  const text = systemText(m, nameOf);
  return (
    <SystemLine id={`msg-${m._id}`} icon={systemIcon(m)} ts={m.ts} title={text}>
      {text}
    </SystemLine>
  );
}

// "Administrador fixou uma mensagem · 10:33" e, embaixo, a citação compacta da mensagem fixada.
function PinnedNote({ m }: { m: Message & Record<string, any> }) {
  const nameOf = useNames();
  const text = systemText(m, nameOf);
  return (
    <div className="msg system pinned-note" id={`msg-${m._id}`}>
      <div className="msg-left">
        <Icon name="sys-pinned" size={14} />
      </div>
      <div className="msg-main">
        <div className="sys-line">
          <span className="sys-text" title={text}>
            {text}
          </span>
          <SysTime ts={m.ts} />
        </div>
        {m.attachments?.map((a, i) => (
          <AttachmentView key={i} a={a} m={m} />
        ))}
      </div>
    </div>
  );
}

// Registro de chamada (call_ended / call_missed): cartão sob o nome de quem ligou, com "Ligar de volta".
function CallCard({ m }: { m: Message & Record<string, any> }) {
  const meId = useStore((s) => s.me?._id);
  const room = useStore((s) => s.rooms[m.rid]);
  const callsOn = useSetting<boolean>('Calls_Enabled');
  const c = (m.call ?? {}) as { kind?: string; status?: string; duration?: number };
  const video = c.kind === 'video';
  const missed = m.t === 'call_missed';
  const caller = m.u._id === meId;
  const status = c.status ?? 'missed';
  const title = !missed
    ? video
      ? 'Chamada de vídeo'
      : 'Chamada de voz'
    : status === 'declined'
      ? 'Chamada recusada'
      : caller
        ? status === 'canceled'
          ? 'Chamada cancelada'
          : 'Chamada não atendida'
        : 'Chamada perdida';
  // O título já diz o tipo (vídeo ou voz) ou o desfecho: a linha de baixo não repete nenhum dos dois.
  const meta = missed ? `${video ? 'Vídeo' : 'Voz'} · ${formatTime(m.ts)}` : `${formatDuration(c.duration ?? 0)} · ${formatTime(m.ts)}`;
  const canCall = !!callsOn && room?.t === 'd' && room.uids?.length === 2 && room.direct?.canCall !== false;
  return (
    <div className={missed ? 'call-card missed' : 'call-card'}>
      <span className="call-card-tile" aria-hidden="true">
        <Icon name={missed ? 'call-missed' : video ? 'call-video' : 'call-audio'} size={18} />
      </span>
      <span className="call-card-text">
        <span className="call-card-title">{title}</span>
        <span className="call-card-meta">{meta}</span>
      </span>
      {canCall && (
        <button type="button" className="btn small" onClick={() => void startCall(m.rid, video ? 'video' : 'audio')}>
          <Icon name={video ? 'call-video' : 'call-audio'} size={14} />
          {missed && !caller ? 'Ligar de volta' : 'Ligar de novo'}
        </button>
      )}
    </div>
  );
}

// Copia para a área de transferência e confirma só depois que deu certo.
function copyText(text: string, done: string) {
  const { toast } = useStore.getState();
  if (!navigator.clipboard) return toast('Não foi possível copiar.', 'error');
  navigator.clipboard.writeText(text).then(
    () => toast(done, 'success'),
    () => toast('Não foi possível copiar.', 'error'),
  );
}

// Blocos de código ganham "Copiar" (renderMarkdown devolve os <pre> no primeiro nível).
function withCopy(nodes: ReactNode): ReactNode {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((n) => {
    if (!isValidElement(n) || n.type !== 'pre') return n;
    const code = (n.props as { children?: ReactElement<{ children?: string }> }).children?.props.children ?? '';
    return (
      <div key={n.key} className="md-pre-wrap">
        {n}
        <button
          type="button"
          className="btn ghost small md-copy"
          aria-label="Copiar código"
          onClick={() => copyText(code, 'Código copiado.')}
        >
          <Icon name="copy" size={14} />
          <span className="md-copy-label">Copiar</span>
        </button>
      </div>
    );
  });
}

// Quem respondeu no tópico: nomes tirados das mensagens já carregadas (sem lista nova a cada leitura do estado).
function useReplyFaces(m: Message) {
  const ids = (m.replies ?? []).slice(0, 3);
  const key = useStore((s) => {
    if (!ids.length) return '';
    const known = new Map<string, string>();
    for (const x of s.threads[m._id] ?? []) known.set(x.u._id, x.u.username);
    for (const x of s.messages[m.rid]?.list ?? []) if (!known.has(x.u._id)) known.set(x.u._id, x.u.username);
    return ids
      .map((id) => known.get(id))
      .filter(Boolean)
      .join(' ');
  });
  return key ? key.split(' ') : [];
}

// "Última há 3 min", "Última em 16/10"; "agora" e "ontem" pedem o substantivo: "Última resposta agora".
function lastReply(ts: string) {
  const rel = formatRelative(ts);
  return /^(há|em) /.test(rel) ? `Última ${rel}` : `Última resposta ${rel}`;
}

function ThreadSummary({ m, onOpen }: { m: Message; onOpen: () => void }) {
  const faces = useReplyFaces(m);
  const unread = useStore((s) => !!s.subscriptions[m.rid]?.tunread?.includes(m._id));
  const n = m.tcount ?? 0;
  return (
    <button type="button" className="thread-summary" onClick={onOpen}>
      {faces.length > 0 && (
        <span className="avatar-stack" aria-hidden="true">
          {faces.map((u) => (
            <img key={u} className="avatar mini-follow" src={`/avatar/${encodeURIComponent(u)}?v=${avatarBust[u] ?? ''}`} width={20} height={20} alt="" loading="lazy" />
          ))}
        </span>
      )}
      <span className="replies">{plural(n, 'resposta', 'respostas')}</span>
      {m.tlm && <span className="thread-last">{lastReply(m.tlm)}</span>}
      {unread && <span className="badge dot" role="img" aria-label="Respostas não lidas" />}
    </button>
  );
}

// ---------- A mensagem ----------

interface MessageItemProps {
  m: Message & Record<string, any>;
  grouped: boolean;
  actions: MessageActions;
  inThread?: boolean;
  canModerate: boolean;
  // Chegou agora (tempo real, com a lista no fim): entra com uma animação curta.
  arrive?: boolean;
  // Destino de um link para a mensagem (?msg=): destaque que some sozinho.
  highlight?: boolean;
  // Rodapé do cartão de aviso (o "Ciente").
  footer?: ReactNode;
}

// Uma mensagem que falha ao renderizar vira um aviso só no lugar dela. Sem isto o erro sobe até a raiz e o React
// desmonta o app inteiro para todos que abrem a sala (por exemplo, uma mensagem importada malformada).
class MessageBoundary extends Component<{ m: Message; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { m: Message }) {
    // A mensagem mudou (edição, nova versão do servidor): tenta renderizar de novo.
    if (this.state.failed && prev.m !== this.props.m) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="msg system" id={this.props.m?._id ? `msg-${this.props.m._id}` : undefined}>
        <div className="msg-left">
          <Icon name="warning" size={14} />
        </div>
        <div className="msg-main">
          <span className="sys-text">Não foi possível exibir esta mensagem.</span>
        </div>
      </div>
    );
  }
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  return (
    <MessageBoundary m={props.m}>
      {/* Figurinhas: os diálogos que abrem do menu (que desmonta ao fechar) ficam aqui. */}
      <StickerHost>
        <MessageView {...props} />
      </StickerHost>
    </MessageBoundary>
  );
});

// Aviso que começa com uma linha só de título (# Título ou *Título*): ela vira o título do cartão e sai do corpo.
function noticeTitle(msg: string): { title: string; rest: string } | null {
  const nl = msg.indexOf('\n');
  const first = (nl < 0 ? msg : msg.slice(0, nl)).trim();
  const h = first.match(/^#{1,4}\s+(\S.*)$/) ?? first.match(/^\*\*([^*\n]+)\*\*$/) ?? first.match(/^\*([^*\s][^*\n]*)\*$/);
  if (!h) return null;
  return { title: h[1].trim(), rest: nl < 0 ? '' : msg.slice(nl + 1).replace(/^\s*\n/, '') };
}

// Mensagens com o mesmo cartão de sempre (as outras de sistema viram uma linha).
const CARD_TYPES = new Set(['rm', 'discussion-created', 'call_ended', 'call_missed']);

// Toque longo nestes elementos abre o menu do sistema, e não a folha de ações.
const NATIVE_PRESS = 'a, img, video, audio, .md-pre';

interface MenuItem {
  key: string;
  icon: IconName;
  label: string;
  run: () => void;
  danger?: boolean;
}
// Itens que são componentes (os das figurinhas): recebem o close do menu e o papel da folha.
type MenuEntry = MenuItem | { key: string; el: (close: () => void, sheetRole?: boolean) => ReactNode };

function MessageView({ m, grouped, actions, inThread, canModerate, arrive, highlight, footer }: MessageItemProps) {
  const me = useStore((s) => s.me)!;
  const navigate = useNavigate();
  const [picker, setPicker] = useState<{ anchor: HTMLElement | null; bar?: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [receipts, setReceipts] = useState(false);
  const [report, setReport] = useState(false);
  const [stickerCard, setStickerCard] = useState<HTMLElement | null>(null);
  const stickerGone = useStickers((st) => !!m.sticker && (m.sticker.removed || st.removed.has(m.sticker.fileId)));
  const createSticker = useCreateSticker(m, inThread);
  const editing = useIsEditing(m._id);
  const coarse = useMedia('(hover: none)');
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const allowEdit = useSetting<boolean>('Message_AllowEditing');
  const allowDelete = useSetting<boolean>('Message_AllowDeleting');
  const allowPin = useSetting<boolean>('Message_AllowPinning');
  const allowStar = useSetting<boolean>('Message_AllowStarring');
  const receiptsOn = useSetting<boolean>('Message_Read_Receipt_Enabled');
  const showEdited = useSetting<boolean>('Message_ShowEditedStatus');
  const closePicker = useCallback(() => setPicker(null), []);
  const own = m.u._id === me._id;
  const perms = me.permissions;
  const gate = useContext(MessageGateContext);
  const canReact = (actions.canReact ?? gate.canReact) !== false;
  const canReply = (actions.canReply ?? gate.canReply) !== false;
  const canDiscuss = (actions.canDiscuss ?? gate.canDiscuss) !== false;
  const limited = !!gate.receiptsLimited || !!m.ackRequired;
  const showReceipts = receiptsOn && gate.canSeeReceipts !== false && (own || !limited || !!gate.canSeeLimitedReceipts);

  if (m.t === 'message_pinned') return <PinnedNote m={m} />;
  if (m.t && !CARD_TYPES.has(m.t)) return <SystemMessage m={m} />;

  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
  const react = (code: string) => api.post('chat.react', { messageId: m._id, emoji: code }).catch(fail);
  const call = m.t === 'call_ended' || m.t === 'call_missed';
  const notice = !!m.ackRequired && !m.t;
  const lifted = notice ? noticeTitle(m.msg) : null;
  const text = lifted ? lifted.rest : m.msg;
  const starred = m.starred?.some((s) => s._id === me._id);
  const bot = !!m.alias || !!m.bot;
  const copyLink = () => {
    const url = `${location.origin}${location.pathname.split('/thread/')[0]}?msg=${m._id}`;
    copyText(url, 'Link copiado.');
  };
  const del = async () => {
    const ok = await confirmDialog({ title: 'Apagar esta mensagem?', body: 'Esta ação não pode ser desfeita.', confirmLabel: 'Apagar', danger: true });
    if (ok) api.post('chat.delete', { msgId: m._id, roomId: m.rid }).catch(fail);
  };

  // Itens do "Mais" (e da folha do toque longo), em grupos separados por linha.
  const canEdit = !m.t && !m.sticker && canReply && ((own && allowEdit) || (!own && perms.includes('edit-message') && canModerate));
  const opt = (on: unknown, item: MenuEntry) => (on ? item : null);
  const groups = [
    [
      opt(canEdit, { key: 'edit', icon: 'edit', label: 'Editar', run: () => actions.onEdit?.(m) }),
      opt(!m.drid && !inThread && actions.onDiscussion && canDiscuss, { key: 'disc', icon: 'start-discussion', label: 'Iniciar discussão', run: () => actions.onDiscussion?.(m) }),
    ],
    [
      opt(allowPin && gate.canPin !== false, {
        key: 'pin',
        icon: m.pinned ? 'unpin' : 'pin',
        label: m.pinned ? 'Desafixar' : 'Fixar',
        run: () => void api.post(m.pinned ? 'chat.unPinMessage' : 'chat.pinMessage', { messageId: m._id }).catch(fail),
      }),
      opt(allowStar, {
        key: 'star',
        icon: starred ? 'unstar' : 'star',
        label: starred ? 'Remover dos favoritos' : 'Favoritar',
        run: () => void api.post(starred ? 'chat.unStarMessage' : 'chat.starMessage', { messageId: m._id }).catch(fail),
      }),
      { key: 'link', icon: 'copy-link', label: 'Copiar link', run: copyLink } as MenuItem,
      opt(!m.sticker, { key: 'text', icon: 'copy', label: 'Copiar texto', run: () => copyText(m.msg, 'Texto copiado.') }),
      opt(!own, { key: 'unread', icon: 'mark-unread', label: 'Marcar como não lida', run: () => void api.post('subscriptions.unread', { firstUnreadMessage: { _id: m._id } }).catch(fail) }),
      opt(showReceipts, { key: 'receipts', icon: 'receipts', label: 'Confirmações de leitura', run: () => setReceipts(true) }),
      opt(m.sticker, { key: 'sticker', el: (close, sheetRole) => <StickerMenuItems message={m} close={close} sheetRole={sheetRole} /> }),
      opt(createSticker, { key: 'create-sticker', el: (close, sheetRole) => <CreateStickerItem message={m} close={close} sheetRole={sheetRole} inThread={inThread} /> }),
    ],
    [opt(!own, { key: 'report', icon: 'report', label: 'Denunciar', run: () => setReport(true) })],
    [
      opt(m.sticker && !stickerGone && canRemoveEverywhere(m.sticker), {
        key: 'remove-all',
        el: (close, sheetRole) => <StickerRemoveItem message={m} close={close} sheetRole={sheetRole} />,
      }),
      opt(own ? allowDelete : canModerate || perms.includes('delete-message'), { key: 'del', icon: 'delete', label: 'Apagar', run: () => void del(), danger: true }),
    ],
  ]
    .map((g) => g.filter((x): x is MenuEntry => !!x))
    .filter((g) => g.length);
  const renderItems = (close: () => void, sheetRole?: boolean) =>
    groups.map((g, i) => (
      <Fragment key={i}>
        {i > 0 && <hr />}
        {g.map((it) =>
          'el' in it ? (
            <Fragment key={it.key}>{it.el(close, sheetRole)}</Fragment>
          ) : (
            <button
              key={it.key}
              type="button"
              role={sheetRole ? 'menuitem' : undefined}
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                close();
                it.run();
              }}
            >
              <Icon name={it.icon} size={16} />
              {it.label}
            </button>
          ),
        )}
      </Fragment>
    ));

  const actionable = m.t !== 'rm' && !call;

  // A barra fica 16px acima da linha; na primeira linha visível ela entraria embaixo do cabeçalho: desce para dentro.
  const placeToolbar = (e: { currentTarget: HTMLDivElement }) => {
    const el = e.currentTarget;
    // A mensagem de origem da thread tem a barra embaixo (panels.css): não há o que ajustar.
    if (el.closest('.thread-root')) return;
    const top = el.closest('.messages, .panel-body')?.getBoundingClientRect().top ?? 0;
    const gap = el.getBoundingClientRect().top - top;
    el.toggleAttribute('data-tb-in', gap < 20);
    // Linha meio escondida sob o cabeçalho: a barra desce até a parte visível.
    el.style.setProperty('--tb-top', `${Math.max(4, 4 - gap)}px`);
  };

  // Toque longo (celular): a folha de ações no lugar da barra que aparece no hover.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch' || !actionable) return;
    // A figurinha é um botão (abre o cartão), mas o toque longo nela abre a folha de ações como no resto da mensagem.
    const onSticker = !!(e.target as HTMLElement).closest('.sticker-hit');
    if (!onSticker && (e.target as HTMLElement).closest(`button, input, textarea, .att-image-box, ${NATIVE_PRESS}`)) return;
    const timer = window.setTimeout(() => {
      if (press.current) press.current.fired = true;
      navigator.vibrate?.(10);
      setSheet(true);
    }, 450);
    press.current = { timer, x: e.clientX, y: e.clientY, fired: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
      clearTimeout(p.timer);
      press.current = null;
    }
  };
  const endPress = () => {
    const p = press.current;
    if (p && !p.fired) {
      clearTimeout(p.timer);
      press.current = null;
    }
  };
  // O toque que abriu a folha não pode virar clique no fundo dela (e fechá-la).
  const onTouchEnd = (e: ReactTouchEvent) => {
    if (press.current?.fired) {
      e.preventDefault();
      press.current = null;
    }
  };

  const body =
    m.t === 'rm' ? (
      <em className="muted">Mensagem removida</em>
    ) : m.t === 'discussion-created' || call ? null : (
      withCopy(renderMarkdown(text, { me: me.username, mentions: m.mentions, channels: m.channels, onUserClick: actions.onUserClick }))
    );
  const name = m.alias || m.u.name || m.u.username;
  const mentioned = m.mentions?.some((x) => x._id === me._id || x._id === 'all' || x._id === 'here');
  const edited =
    m.editedAt && showEdited && m.t !== 'rm' ? (
      <span className="edited" title={`Editada por ${m.editedBy?.username} em ${formatDateTime(m.editedAt)}`}>
        editada
      </span>
    ) : null;
  const receipt =
    receiptsOn && own && !m.t ? (
      <span className={`receipt ${m.unread ? '' : 'read'}`} title={m.unread ? 'Enviada' : 'Lida por todos'} role="img" aria-label={m.unread ? 'Enviada' : 'Lida por todos'}>
        <Icon name={m.unread ? 'sent' : 'read'} size={14} />
      </span>
    ) : null;
  // Figurinha: no lugar do texto, sem o emoji grande; a imagem de reserva (anexo 'sticker') é para outros clientes.
  const sticker = m.sticker && m.t !== 'rm' ? m.sticker : null;
  const content = (
    <>
      {sticker ? (
        <StickerView sticker={sticker} size="message" playbackKey={m._id} onOpen={setStickerCard} />
      ) : (
        !call &&
        (text || !lifted) && (
          <div className={`msg-body ${isEmojiOnly(text) ? 'big-emoji' : ''}`}>
            {body}
            {grouped && edited}
          </div>
        )
      )}
      {m.attachments?.map((a, i) =>
        sticker && a.type === 'sticker' ? null : <AttachmentView key={i} a={a} m={m} createSticker={createSticker ?? undefined} />,
      )}
    </>
  );

  const cls = [
    'msg',
    grouped && 'grouped',
    mentioned && !own && 'mentioned',
    m.pinned && 'pinned',
    arrive && 'arrive',
    highlight && 'highlight',
    editing && 'editing',
    (menuOpen || picker) && 'menu-open',
    notice && 'notice',
    call && 'call',
    bot && 'bot',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      id={`msg-${m._id}`}
      onPointerDown={coarse ? onPointerDown : undefined}
      onPointerMove={coarse ? onPointerMove : undefined}
      onPointerUp={coarse ? endPress : undefined}
      onPointerCancel={coarse ? endPress : undefined}
      onTouchEnd={coarse ? onTouchEnd : undefined}
      onMouseEnter={actionable ? placeToolbar : undefined}
      onFocus={actionable ? placeToolbar : undefined}
      onContextMenu={
        coarse && actionable
          ? (e) => {
              // Em links, imagens, código e mídia fica o menu do sistema (abrir, copiar, compartilhar, salvar).
              if (!(e.target as HTMLElement).closest('.sticker-hit') && (e.target as HTMLElement).closest(NATIVE_PRESS)) return;
              e.preventDefault();
              if (!sheet) setSheet(true);
            }
          : undefined
      }
    >
      <div className="msg-left">
        {grouped ? (
          <>
            <time className="msg-time-hover" dateTime={m.ts} title={formatDateTime(m.ts)} tabIndex={-1}>
              {formatTime(m.ts)}
            </time>
            {receipt && <span className="msg-gutter-receipt">{receipt}</span>}
          </>
        ) : m.avatar ? (
          <img className="avatar" src={m.avatar} width={36} height={36} alt="" />
        ) : (
          <span className="clickable" onClick={() => actions.onUserClick?.(m.u.username)}>
            <Avatar username={m.u.username} size={36} />
          </span>
        )}
      </div>
      <div className="msg-main">
        {!grouped && (
          <div className="msg-head">
            <button type="button" className="msg-name clickable" title={name} onClick={() => actions.onUserClick?.(m.u.username)}>
              {m.emoji ? `${resolveEmoji(m.emoji)?.unicode ?? ''} ` : ''}
              {name}
            </button>
            {name !== m.u.username && <span className="msg-username">@{m.u.username}</span>}
            {bot && <span className="pill msg-bot">Bot</span>}
            <time className="msg-time" dateTime={m.ts} title={formatDateTime(m.ts)}>
              {formatTime(m.ts)}
            </time>
            {edited}
            {m.pinned && (
              <span className="msg-flag pin" title="Fixada" role="img" aria-label="Fixada">
                <Icon name="pin" size={12} />
              </span>
            )}
            {starred && (
              <span className="msg-flag star" title="Favoritada" role="img" aria-label="Favoritada">
                <Icon name="star" size={12} fill />
              </span>
            )}
            {receipt}
          </div>
        )}
        {m.tmid && !inThread && m.tshow && <div className="muted small msg-thread-hint">respondeu em um tópico</div>}
        {notice ? (
          <div className="notice-card">
            <div className="notice-card-head">
              <span className="notice-card-tile" aria-hidden="true">
                <Icon name="notice" size={16} />
              </span>
              <span className="notice-card-titles">
                <span className="notice-card-title">
                  {lifted ? renderMarkdown(lifted.title, { me: me.username, mentions: m.mentions, channels: m.channels, onUserClick: actions.onUserClick }) : 'Aviso'}
                </span>
                <span className="notice-card-meta">Leitura obrigatória</span>
              </span>
            </div>
            {content}
            {footer && <div className="notice-card-foot">{footer}</div>}
          </div>
        ) : (
          content
        )}
        {call && <CallCard m={m} />}
        <Reactions m={m} canReact={canReact} onAdd={(anchor) => setPicker({ anchor })} />
        {!inThread && (m.tcount ?? 0) > 0 && <ThreadSummary m={m} onOpen={() => actions.onReplyThread?.(m)} />}
        {m.drid && (
          <button type="button" className="thread-summary discussion" onClick={() => navigate(roomPath({ _id: m.drid!, t: 'c' }))}>
            <Icon name="room-discussion" size={14} />
            <span className="replies">Discussão{m.t === 'discussion-created' ? `: ${m.msg}` : ''}</span>
            <span className="thread-last">{m.dcount ? plural(m.dcount, 'mensagem', 'mensagens') : 'sem mensagens'}</span>
          </button>
        )}
      </div>
      {actionable && (
        <div className="msg-toolbar" role="toolbar" aria-label="Ações da mensagem">
          {canReact &&
            quickReactions(3).map((code) => (
              <button key={code} type="button" className="tb-btn quick" title={`:${code}:`} aria-label={`Reagir com :${code}:`} onClick={() => void react(code)}>
                <EmojiGlyph code={code} />
              </button>
            ))}
          {canReact && <span className="tb-sep" aria-hidden="true" />}
          {canReact && (
            <button
              type="button"
              className="tb-btn"
              title="Reagir"
              aria-label="Reagir"
              aria-haspopup="dialog"
              aria-expanded={!!picker?.bar}
              onClick={(e) => setPicker(picker ? null : { anchor: e.currentTarget, bar: true })}
            >
              <Icon name="react" size={16} />
            </button>
          )}
          {!inThread && canReply && (
            <button type="button" className="tb-btn" title="Responder no tópico" aria-label="Responder no tópico" onClick={() => actions.onReplyThread?.(m)}>
              <Icon name="reply-thread" size={16} />
            </button>
          )}
          {canReply && (
            <button type="button" className="tb-btn" title="Citar" aria-label="Citar" onClick={() => actions.onQuote?.(m)}>
              <Icon name="quote" size={16} />
            </button>
          )}
          <Menu
            label="Ações da mensagem"
            onOpenChange={setMenuOpen}
            trigger={
              <button type="button" className="tb-btn" title="Mais" aria-label="Mais">
                <Icon name="more" size={16} />
              </button>
            }
          >
            {(close) => renderItems(close)}
          </Menu>
        </div>
      )}
      {sheet && (
        <Sheet onClose={() => setSheet(false)} className="menu msg-sheet" role="menu" label="Ações da mensagem">
          <div className="sheet-scroll">
            {canReact && (
              <div className="msg-sheet-quick">
                {quickReactions(6).map((code) => (
                  <button
                    key={code}
                    type="button"
                    className="msg-sheet-emoji"
                    aria-label={`Reagir com :${code}:`}
                    onClick={() => {
                      setSheet(false);
                      void react(code);
                    }}
                  >
                    <EmojiGlyph code={code} />
                  </button>
                ))}
                <button
                  type="button"
                  className="msg-sheet-emoji more"
                  aria-label="Mais emojis"
                  onClick={() => {
                    setSheet(false);
                    setPicker({ anchor: null });
                  }}
                >
                  <Icon name="react" size={20} />
                </button>
              </div>
            )}
            {canReply && (
              <>
                {!inThread && (
                  <button type="button" role="menuitem" onClick={() => (setSheet(false), actions.onReplyThread?.(m))}>
                    <Icon name="reply-thread" size={16} />
                    Responder no tópico
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => (setSheet(false), actions.onQuote?.(m))}>
                  <Icon name="quote" size={16} />
                  Citar
                </button>
                <hr />
              </>
            )}
            {renderItems(() => setSheet(false), true)}
          </div>
        </Sheet>
      )}
      {picker && (
        <EmojiPicker
          anchor={picker.anchor}
          onClose={closePicker}
          onPick={(code) => {
            setPicker(null);
            void react(code);
          }}
        />
      )}
      {receipts && <ReadReceipts m={m} onClose={() => setReceipts(false)} />}
      {report && <ReportModal m={m} onClose={() => setReport(false)} />}
      {stickerCard && sticker && <StickerCard message={m} anchor={stickerCard} onClose={() => setStickerCard(null)} onReport={() => setReport(true)} />}
    </div>
  );
}
