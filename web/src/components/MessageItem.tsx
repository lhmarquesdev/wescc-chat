import { Component, memo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Attachment, Message } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { formatBytes, formatDateTime, formatRelative, formatTime, roomPath, systemText } from '../lib/format';
import { resolveEmoji } from '../lib/emoji';
import { isEmojiOnly, renderMarkdown } from '../lib/markdown';
import { useSetting, useStore } from '../lib/store';
import { EmojiPicker } from './EmojiPicker';
import { Avatar, Menu, Modal } from './ui';

export interface MessageActions {
  onReplyThread?: (m: Message) => void;
  onEdit?: (m: Message) => void;
  onQuote?: (m: Message) => void;
  onDiscussion?: (m: Message) => void;
  onUserClick?: (username: string) => void;
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

function ZoomImage({ src, alt, className, download }: { src: string; alt?: string; className: string; download?: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <img className={className} src={src} alt={alt ?? ''} loading="lazy" onClick={() => setZoom(true)} />
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(false)}>
          <img src={src} alt={alt ?? ''} />
          {download && (
            <a href={`${download}?download`} onClick={(e) => e.stopPropagation()} className="btn">
              ⬇ Baixar
            </a>
          )}
        </div>
      )}
    </>
  );
}

// Arquivo enviado pelo chat (type 'file'): imagem, vídeo, áudio ou link de download.
function FileAttachment({ a }: { a: Attachment }) {
  const link = safeHref(a.title_link);
  const image = safeHref(a.image_url);
  if (image)
    return (
      <div className="att">
        <ZoomImage className="att-image" src={image} alt={a.title} download={link} />
        {a.description && <div className="att-desc">{a.description}</div>}
      </div>
    );
  if (a.video_url) return <video className="att-video" src={safeHref(a.video_url)} controls preload="metadata" />;
  if (a.audio_url) return <audio className="att-audio" src={safeHref(a.audio_url)} controls preload="metadata" />;
  if (link)
    return (
      <a className="att-file" href={`${link}?download`} target="_blank" rel="noreferrer">
        <span className="att-icon">📄</span>
        <span>
          <strong>{a.title}</strong>
          <span className="muted">
            {a.format} {formatBytes(a.size)}
          </span>
          {a.description && <span className="att-desc">{a.description}</span>}
        </span>
      </a>
    );
  return null;
}

// Anexo de integração ou de mensagem importada, no formato do Slack.
function RichAttachment({ a }: { a: Attachment }) {
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
          {image && <ZoomImage className="att-image" src={image} alt={a.title} />}
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
        {thumb && <ZoomImage className="att-thumb" src={thumb} alt={a.title} />}
      </div>
    </div>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  if (a.message_link) {
    return (
      <div className="quote-att">
        <div className="quote-head">
          <strong>{a.author_name}</strong> <span className="muted">{a.ts ? formatDateTime(a.ts) : ''}</span>
        </div>
        <div className="quote-body">{renderMarkdown(a.text ?? '')}</div>
      </div>
    );
  }
  // Arquivo de mensagem importada que ainda está na origem ("Baixar arquivos pendentes" na importação). O texto vem
  // do servidor, que sabe se ele ainda vai ser baixado ou se não está disponível (externo, apagado na origem).
  if (a.pendingFileId)
    return (
      <div className="att-pending" title="Arquivo de uma mensagem importada, ainda na origem da importação">
        {a.text || `📎 ${a.title || 'arquivo'} — arquivo ainda não baixado`}
      </div>
    );
  // Anexos de arquivos sempre têm type 'file'; o link /file-upload/ cobre mensagens antigas.
  if (a.type === 'file' || a.title_link?.startsWith('/file-upload/')) return <FileAttachment a={a} />;
  return <RichAttachment a={a} />;
}

function Reactions({ m }: { m: Message }) {
  const me = useStore((s) => s.me);
  const entries = Object.entries(m.reactions ?? {});
  if (!entries.length) return null;
  const toggle = (code: string) => api.post('chat.react', { messageId: m._id, emoji: code }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
  return (
    <div className="reactions">
      {entries.map(([code, r]) => {
        const e = resolveEmoji(code);
        const mine = r.usernames.includes(me?.username ?? '');
        return (
          <button key={code} className={`reaction ${mine ? 'mine' : ''}`} title={`${r.usernames.join(', ')} reagiu com ${code}`} onClick={() => toggle(code)}>
            {e?.unicode ?? (e?.url ? <img src={e.url} alt={code} /> : code)} <span>{r.usernames.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReadReceipts({ m, onClose }: { m: Message; onClose: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  if (list === null) void api.get('chat.getMessageReadReceipts', { messageId: m._id }).then((r) => setList(r.receipts)).catch(() => setList([]));
  return (
    <Modal title="Lida por" onClose={onClose}>
      {!list ? (
        'Carregando…'
      ) : list.length === 0 ? (
        <div className="muted">Ninguém leu ainda.</div>
      ) : (
        <ul className="plain-list">
          {list.map((r) => (
            <li key={r._id}>
              <Avatar username={r.user.username} size={24} /> <strong>{r.user.name}</strong> <span className="muted">@{r.user.username} · {formatDateTime(r.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ReportModal({ m, onClose }: { m: Message; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal
      title="Denunciar mensagem"
      onClose={onClose}
      footer={
        <button
          className="btn danger"
          onClick={() =>
            api
              .post('chat.reportMessage', { messageId: m._id, description: text })
              .then(() => (useStore.getState().toast('Denúncia enviada aos moderadores.'), onClose()))
              .catch((e) => useStore.getState().toast(errorMessage(e), 'error'))
          }
        >
          Denunciar
        </button>
      }
    >
      <textarea rows={4} placeholder="Descreva o motivo" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

interface MessageItemProps {
  m: Message & Record<string, any>;
  grouped: boolean;
  actions: MessageActions;
  inThread?: boolean;
  canModerate: boolean;
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
        <span className="sys-text">Não foi possível exibir esta mensagem.</span>
      </div>
    );
  }
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  return (
    <MessageBoundary m={props.m}>
      <MessageView {...props} />
    </MessageBoundary>
  );
});

function MessageView({ m, grouped, actions, inThread, canModerate }: MessageItemProps) {
  const me = useStore((s) => s.me)!;
  const navigate = useNavigate();
  const [picker, setPicker] = useState(false);
  const [receipts, setReceipts] = useState(false);
  const [report, setReport] = useState(false);
  const allowEdit = useSetting<boolean>('Message_AllowEditing');
  const allowDelete = useSetting<boolean>('Message_AllowDeleting');
  const allowPin = useSetting<boolean>('Message_AllowPinning');
  const allowStar = useSetting<boolean>('Message_AllowStarring');
  const receiptsOn = useSetting<boolean>('Message_Read_Receipt_Enabled');
  const showEdited = useSetting<boolean>('Message_ShowEditedStatus');
  const own = m.u._id === me._id;
  const perms = me.permissions;

  if (m.t && m.t !== 'rm' && m.t !== 'discussion-created' && m.t !== 'message_pinned') {
    return (
      <div className="msg system" id={`msg-${m._id}`}>
        <span className="sys-text">{systemText(m)}</span>
        <span className="msg-time">{formatTime(m.ts)}</span>
      </div>
    );
  }

  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
  const starred = m.starred?.some((s) => s._id === me._id);
  const copyLink = () => {
    const url = `${location.origin}${location.pathname.split('/thread/')[0]}?msg=${m._id}`;
    void navigator.clipboard?.writeText(url);
    useStore.getState().toast('Link copiado.');
  };
  const del = () => {
    if (confirm('Apagar esta mensagem? Esta ação não pode ser desfeita.')) api.post('chat.delete', { msgId: m._id, roomId: m.rid }).catch(fail);
  };

  const body = m.t === 'rm' ? <em className="muted">Mensagem removida</em> : m.t === 'message_pinned' ? <em className="muted">{systemText(m)}</em> : m.t === 'discussion-created' ? null : renderMarkdown(m.msg, { me: me.username, mentions: m.mentions, channels: m.channels, onUserClick: actions.onUserClick });
  const name = m.alias || m.u.name || m.u.username;
  const mentioned = m.mentions?.some((x) => x._id === me._id || x._id === 'all' || (x._id === 'here' && true));

  return (
    <div className={`msg ${grouped ? 'grouped' : ''} ${mentioned && !own ? 'mentioned' : ''} ${m.pinned ? 'pinned' : ''}`} id={`msg-${m._id}`}>
      <div className="msg-left">
        {grouped ? (
          <span className="msg-time-hover">{formatTime(m.ts)}</span>
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
            <span className="msg-name clickable" onClick={() => actions.onUserClick?.(m.u.username)}>
              {m.emoji ? `${resolveEmoji(m.emoji)?.unicode ?? ''} ` : ''}
              {name}
            </span>
            {name !== m.u.username && <span className="msg-username">@{m.u.username}</span>}
            <span className="msg-time" title={formatDateTime(m.ts)}>
              {formatTime(m.ts)}
            </span>
            {m.pinned && <span className="msg-flag" title="Fixada">📌</span>}
            {starred && <span className="msg-flag" title="Favoritada">⭐</span>}
          </div>
        )}
        {m.tmid && !inThread && m.tshow && <div className="muted small">respondeu em uma thread</div>}
        <div className={`msg-body ${isEmojiOnly(m.msg) ? 'big-emoji' : ''}`}>
          {body}
          {m.editedAt && showEdited && m.t !== 'rm' && (
            <span className="edited" title={`Editada por ${m.editedBy?.username} em ${formatDateTime(m.editedAt)}`}>
              (editada)
            </span>
          )}
        </div>
        {m.attachments?.map((a, i) => (
          <AttachmentView key={i} a={a} />
        ))}
        <Reactions m={m} />
        {!inThread && (m.tcount ?? 0) > 0 && (
          <button className="thread-summary" onClick={() => actions.onReplyThread?.(m)}>
            <span className="replies">
              💬 {m.tcount} {m.tcount === 1 ? 'resposta' : 'respostas'}
            </span>
            <span className="muted">última {formatRelative(m.tlm)}</span>
            {(m.replies ?? []).slice(0, 4).map((id) => (
              <span key={id} className="mini-follow" />
            ))}
          </button>
        )}
        {m.drid && (
          <button className="thread-summary" onClick={() => navigate(roomPath({ _id: m.drid!, t: 'c' }))}>
            <span className="replies">🗨 Discussão{m.t === 'discussion-created' ? `: ${m.msg}` : ''}</span>
            <span className="muted">{m.dcount ? `${m.dcount} mensagens` : 'sem mensagens'}</span>
          </button>
        )}
      </div>
      {receiptsOn && own && !m.t && (
        <span className={`receipt ${m.unread ? '' : 'read'}`} title={m.unread ? 'Enviada' : 'Lida por todos'}>
          {m.unread ? '✓' : '✓✓'}
        </span>
      )}
      {m.t !== 'rm' && (
        <div className="msg-toolbar">
          <button title="Reagir" onClick={() => setPicker(true)}>
            😊
          </button>
          {!inThread && (
            <button title="Responder em thread" onClick={() => actions.onReplyThread?.(m)}>
              💬
            </button>
          )}
          <button title="Citar" onClick={() => actions.onQuote?.(m)}>
            ❝
          </button>
          <Menu trigger={<button title="Mais">⋯</button>}>
            {(close) => (
              <>
                {own && allowEdit && !m.t && (
                  <button onClick={() => (actions.onEdit?.(m), close())}>✏️ Editar</button>
                )}
                {!own && perms.includes('edit-message') && canModerate && !m.t && <button onClick={() => (actions.onEdit?.(m), close())}>✏️ Editar</button>}
                {!m.drid && !inThread && actions.onDiscussion && <button onClick={() => (actions.onDiscussion?.(m), close())}>🗨 Iniciar discussão</button>}
                {allowPin && (
                  <button onClick={() => (api.post(m.pinned ? 'chat.unPinMessage' : 'chat.pinMessage', { messageId: m._id }).catch(fail), close())}>
                    📌 {m.pinned ? 'Desafixar' : 'Fixar'}
                  </button>
                )}
                {allowStar && (
                  <button onClick={() => (api.post(starred ? 'chat.unStarMessage' : 'chat.starMessage', { messageId: m._id }).catch(fail), close())}>
                    ⭐ {starred ? 'Remover dos favoritos' : 'Favoritar'}
                  </button>
                )}
                <button onClick={() => (copyLink(), close())}>🔗 Copiar link</button>
                <button onClick={() => (void navigator.clipboard?.writeText(m.msg), close())}>📋 Copiar texto</button>
                {!own && (
                  <button onClick={() => (api.post('subscriptions.unread', { firstUnreadMessage: { _id: m._id } }).catch(fail), close())}>● Marcar como não lida</button>
                )}
                {receiptsOn && <button onClick={() => (setReceipts(true), close())}>👁 Confirmações de leitura</button>}
                {(own ? allowDelete : canModerate || perms.includes('delete-message')) && (
                  <button className="danger" onClick={() => (del(), close())}>
                    🗑 Apagar
                  </button>
                )}
                {!own && <button onClick={() => (setReport(true), close())}>🚩 Denunciar</button>}
              </>
            )}
          </Menu>
        </div>
      )}
      {picker && (
        <div className="picker-anchor">
          <EmojiPicker
            onClose={() => setPicker(false)}
            onPick={(code) => {
              setPicker(false);
              api.post('chat.react', { messageId: m._id, emoji: code }).catch(fail);
            }}
          />
        </div>
      )}
      {receipts && <ReadReceipts m={m} onClose={() => setReceipts(false)} />}
      {report && <ReportModal m={m} onClose={() => setReport(false)} />}
    </div>
  );
}
