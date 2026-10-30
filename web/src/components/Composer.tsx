import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@shared/index';
import { stickerPreviewText } from '@shared/stickers';
import { api, ApiError, errorMessage, uploadTo } from '../lib/api';
import { slashCommands } from '../lib/commands';
import { EMOJI, searchEmoji } from '../lib/emoji';
import { formatBytes } from '../lib/format';
import { realtime } from '../lib/realtime';
import { registerComposer, useStickers } from '../lib/stickers';
import { useSetting, useStore } from '../lib/store';
import { namesIn, useNames } from '../lib/names';
import { Icon, type IconName } from './Icon';
import { fileIconName, FileTile, setEditingMessage } from './MessageItem';
import { Portal, useAnchored, useIsPhone, useMedia } from './overlay';
import { ExpressionPicker } from './stickers/ExpressionPicker';
import { StickerHost } from './stickers/StickerMenuItems';
import { StickerSuggestions } from './stickers/StickerSuggestions';
import { Avatar, Modal } from './ui';
import { useVoiceRecorder, VoiceBar } from './VoiceRecorder';

interface Suggestion {
  key: string;
  insert: string;
  // Avatar, ícone ou emoji à esquerda (24px), nome e o texto secundário.
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
}

// No canal de avisos a faixa do topo já explica quem publica: aqui basta uma linha curta.
const disabledText = (reason?: string) => (!reason ? 'Você não pode enviar mensagens aqui.' : /canal de avisos/i.test(reason) ? 'Só os publicadores enviam aqui.' : reason);

const SECTION: Record<string, string> = { '@': 'Pessoas', '#': 'Canais', ':': 'Emojis', '/': 'Comandos' };

export interface ComposerHandle {
  edit(m: Message): void;
  quote(m: Message): void;
}

// Ícone do compositor desativado, pelo motivo (o texto vem da sala).
function disabledIconFor(reason?: string): IconName {
  if (!reason) return 'composer-locked';
  if (/canal de avisos/i.test(reason)) return 'notice';
  if (/arquivad/i.test(reason)) return 'sys-archived';
  if (/silenciad/i.test(reason)) return 'composer-muted';
  if (/particular|bloquead/i.test(reason)) return 'direct-blocked';
  return 'composer-locked';
}

// Os diálogos das figurinhas (editor, novo pacote) abrem do seletor e ficam abertos depois que ele fecha.
export function Composer(props: ComposerProps) {
  return (
    <StickerHost>
      <ComposerView {...props} />
    </StickerHost>
  );
}

type ComposerProps = Parameters<typeof ComposerView>[0];

function ComposerView({
  rid,
  tmid,
  disabled,
  disabledReason,
  disabledIcon,
  placeholder,
  editing,
  setEditing,
  quoting,
  setQuoting,
  onEditLast,
  ackOption,
}: {
  rid: string;
  tmid?: string;
  disabled?: boolean;
  disabledReason?: string;
  disabledIcon?: IconName;
  placeholder?: string;
  editing: Message | null;
  setEditing: (m: Message | null) => void;
  quoting: Message | null;
  setQuoting: (m: Message | null) => void;
  onEditLast?: () => void;
  // Canal de avisos com "Ciente": quem publica escolhe se o aviso pede confirmação.
  ackOption?: boolean;
}) {
  const me = useStore((s) => s.me)!;
  const nameOf = useNames();
  const sendOnEnter = me.preferences?.sendOnEnter !== false;
  const maxSize = useSetting<number>('Message_MaxAllowedSize') ?? 5000;
  const uploadsOn = useSetting<boolean>('FileUpload_Enabled');
  const uploadsInDirect = useSetting<boolean>('FileUpload_Enabled_Direct');
  const phone = useIsPhone();
  const coarse = useMedia('(pointer: coarse)');
  const [text, setText] = useState('');
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [section, setSection] = useState('');
  const [sel, setSel] = useState(0);
  const [picker, setPicker] = useState(false);
  const [fmt, setFmt] = useState(false);
  const [uploads, setUploads] = useState<{ id: number; name: string; progress: number; abort: AbortController }[]>([]);
  const uploadSeq = useRef(0);
  const [alsoChannel, setAlsoChannel] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [fileDesc, setFileDesc] = useState('');
  const [askAck, setAskAck] = useState(true);
  const [drop, setDrop] = useState<DOMRect | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const typingRef = useRef<{ on: boolean; timer: number | null }>({ on: false, timer: null });
  const listId = useId();
  const draftKey = `wescc.draft.${rid}${tmid ? `.${tmid}` : ''}`;
  const anch = useAnchored({ open: sugs.length > 0, placement: 'top-start', gap: 6, minHeight: 120 });
  // Figurinhas: a sala (onde dá para enviar) e o pedido "Ver no seletor" do cartão da figurinha.
  const room = useStore((s) => s.rooms[rid]);
  const pickerRequest = useStickers((s) => s.pickerRequest);
  const [request, setRequest] = useState<{ packId?: string; seq: number } | null>(null);
  const seenRequest = useRef(useStickers.getState().pickerRequest?.seq ?? 0);
  useEffect(() => (disabled ? undefined : registerComposer(rid, tmid ?? null)), [rid, tmid, disabled]);
  useEffect(() => {
    const r = pickerRequest;
    if (!r || r.seq <= seenRequest.current || disabled) return;
    const here = r.rid ? r.rid === rid && (r.tmid ?? null) === (tmid ?? null) : !tmid;
    if (!here) return;
    seenRequest.current = r.seq;
    setRequest({ packId: r.packId, seq: r.seq });
    setPicker(true);
  }, [pickerRequest, rid, tmid, disabled]);

  const readDraft = () => {
    try {
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  };
  useEffect(() => {
    setText(readDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      setText(editing.msg);
      ta.current?.focus();
    } else if (wasEditing.current) {
      // Fim da edição (salva ou cancelada): volta o rascunho da mensagem nova, que a edição não tocou.
      setText(readDraft());
    }
    wasEditing.current = !!editing;
    // A linha da mensagem em edição fica marcada na lista (.msg.editing).
    setEditingMessage(editing?._id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => () => setEditingMessage(null), []);
  useEffect(() => {
    if (quoting) ta.current?.focus();
  }, [quoting]);

  useEffect(() => {
    if (box.current) anch.setReference(box.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // A caixa cresce com o texto até o limite do CSS (8 linhas; metade da tela no celular) e depois rola.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, phone]);

  // Arrastar um arquivo sobre a sala (ou o painel do tópico) mostra a área de soltar.
  useEffect(() => {
    const host = box.current?.closest<HTMLElement>('.thread-panel, .room-main');
    if (!host || !uploadsOn || disabled) return;
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (depth++ === 0) setDrop(host.getBoundingClientRect());
    };
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDrop(null);
      }
    };
    const dropped = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDrop(null);
      if (e.dataTransfer?.files.length) setPending([...e.dataTransfer.files]);
    };
    host.addEventListener('dragenter', enter);
    host.addEventListener('dragover', over);
    host.addEventListener('dragleave', leave);
    host.addEventListener('drop', dropped);
    return () => {
      host.removeEventListener('dragenter', enter);
      host.removeEventListener('dragover', over);
      host.removeEventListener('dragleave', leave);
      host.removeEventListener('drop', dropped);
    };
  }, [uploadsOn, disabled]);

  const saveDraft = (v: string) => {
    // O texto de uma edição não é rascunho de mensagem nova: depois de uma recarga, o Enter publicaria uma cópia.
    if (editing) return;
    try {
      if (v) localStorage.setItem(draftKey, v);
      else localStorage.removeItem(draftKey);
    } catch {
      // ignora
    }
  };

  const sendTyping = (on: boolean) => {
    const t = typingRef.current;
    if (t.timer) clearTimeout(t.timer);
    if (on) t.timer = window.setTimeout(() => sendTyping(false), 4000);
    if (t.on === on) return;
    t.on = on;
    realtime.send({ type: 'typing', rid, tmid: tmid ?? null, typing: on });
  };
  // "Gravando áudio…": repetido pelo gravador a cada 3 s (quem vê descarta depois de 6 s sem notícia).
  const sendRecording = (on: boolean) => {
    if (typingRef.current.timer) clearTimeout(typingRef.current.timer);
    typingRef.current.on = false;
    realtime.send({ type: 'typing', rid, tmid: tmid ?? null, typing: on, activity: 'recording' });
  };

  const reqSeq = useRef(0);
  const computeSuggestions = useCallback(
    async (value: string, caret: number) => {
      // Respostas antigas do servidor não podem reabrir a lista depois do envio.
      const my = ++reqSeq.current;
      const put = (list: Suggestion[], trig = '') => {
        if (my !== reqSeq.current) return;
        setSugs(list);
        setSection(SECTION[trig] ?? '');
      };
      const before = value.slice(0, caret);
      const m = before.match(/(?:^|\s)([@#:])([^\s@#:]*)$/) ?? (before.match(/^\/([a-z0-9-]*)$/i) ? ([before, '/', before.slice(1)] as unknown as RegExpMatchArray) : null);
      if (!m) return put([]);
      const [, trig, term] = m;
      if (trig === '@') {
        const r = await api.get('users.autocomplete', { term, rid }).catch(() => ({ items: [] }));
        const person = (u: any): Suggestion => ({
          key: u._id,
          lead: <Avatar username={u.username} size={24} />,
          title: u.name || u.username,
          sub: `@${u.username}`,
          insert: `@${u.username} `,
        });
        const items: Suggestion[] = r.items.filter((u: any) => u.username !== me.username).map(person);
        for (const g of ['all', 'here'])
          if (g.startsWith(term))
            items.push({ key: g, lead: <Icon name="mention" size={16} />, title: `@${g}`, sub: g === 'all' ? 'todos da sala' : 'todos online', insert: `@${g} ` });
        // Quem escreve vai para o fim, depois de @all e @here: quase nunca se menciona a si mesmo.
        const self = r.items.find((u: any) => u.username === me.username);
        put([...items.slice(0, self ? 9 : 10), ...(self ? [person(self)] : [])], '@');
      } else if (trig === '#') {
        const r = await api.get('rooms.autocomplete.channelAndPrivate', { term }).catch(() => ({ items: [] }));
        put(
          r.items.map((x: any) => ({ key: x._id, lead: <Icon name={x.t === 'p' ? 'room-private' : 'room-channel'} size={16} />, title: x.name, insert: `#${x.name} ` })),
          '#',
        );
      } else if (trig === ':') {
        if (term.length < 2) return put([]);
        put(
          searchEmoji(term).map((c) => ({
            key: c,
            lead: <span className="sug-emoji">{EMOJI[c] ?? <img className="emoji custom" src={`/emoji-custom/${c}`} alt="" />}</span>,
            title: `:${c}:`,
            insert: `:${c}: `,
          })),
          ':',
        );
      } else if (trig === '/') {
        // A lista é desta pessoa (lib/commands.ts): /jira e /teams entram e saem com as integrações.
        const list = await slashCommands(me._id);
        // Sinônimos (/part = /leave, /jitsi = /call) têm a mesma descrição: fica só o primeiro, a não ser que a
        // pessoa já esteja digitando o sinônimo.
        const seenDesc = new Set<string>();
        const cmds = list.filter((c) => {
          if (!c.command.startsWith(term)) return false;
          if (c.command !== term && c.description && seenDesc.has(c.description)) return false;
          seenDesc.add(c.description);
          return true;
        });
        put(
          cmds.slice(0, 12).map((c) => ({ key: c.command, title: `/${c.command}`, sub: [c.params, c.description].filter(Boolean).join(' · '), insert: `/${c.command} ` })),
          '/',
        );
      }
      setSel(0);
    },
    [rid, me.username, me._id],
  );

  const applySuggestion = (s: Suggestion) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const start = before.search(/(?:[@#:]|^\/)[^\s@#:]*$|(?:^|(?<=\s))![\w-]*$/);
    const next = before.slice(0, start) + s.insert + after;
    setText(next);
    saveDraft(next);
    setSugs([]);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + s.insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const over = text.length > maxSize;

  const send = async () => {
    let msg = text.trim();
    if (!msg && !pending.length) return;
    if (msg.length > maxSize) return useStore.getState().toast(`A mensagem excede ${maxSize} caracteres.`, 'error');
    sendTyping(false);
    try {
      if (editing) {
        await api.post('chat.update', { roomId: rid, msgId: editing._id, text: msg });
        setEditing(null);
      } else {
        const attachments = quoting ? [{ text: quoting.msg, author_name: quoting.u.username, ts: quoting.ts, message_link: `?msg=${quoting._id}` }] : undefined;
        const ackRequired = ackOption && askAck && !tmid ? true : undefined;
        await api.post('chat.sendMessage', { message: { rid, msg, tmid, tshow: tmid ? alsoChannel || undefined : undefined, attachments, ackRequired } });
        if (quoting) setQuoting(null);
      }
      setText('');
      saveDraft('');
      reqSeq.current++;
      setSugs([]);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };

  const doUpload = async (files: File[], description: string, extra: Record<string, string> = {}, label?: string) => {
    for (const f of files) {
      const id = ++uploadSeq.current;
      const abort = new AbortController();
      setUploads((u) => [...u, { id, name: label ?? f.name, progress: 0, abort }]);
      try {
        const progress = (p: number) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x)));
        await uploadTo(`rooms.upload/${rid}`, f, { description, tmid: tmid ?? '', ...extra }, progress, abort.signal);
      } catch (e) {
        // Cancelado por quem enviou: a barra some e basta.
        if (!(e instanceof ApiError && e.errorType === 'aborted')) useStore.getState().toast(errorMessage(e), 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.id !== id));
      }
    }
  };

  const voice = useVoiceRecorder({
    onActivity: sendRecording,
    onSend: (r) => void doUpload([r.file], '', { voice: '1', duration: r.duration.toFixed(1), waveform: r.waveform.join(',') }, 'mensagem de voz'),
  });
  // Caixa vazia: o botão Enviar vira o microfone (como no WhatsApp).
  const micOn = !!uploadsOn && !(room?.t === 'd' && uploadsInDirect === false) && !editing && !text.trim() && !pending.length;

  const cancelEdit = () => {
    setEditing(null);
    setText('');
    ta.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sugs.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setSel((sel + 1) % sugs.length));
      if (e.key === 'ArrowUp') return (e.preventDefault(), setSel((sel - 1 + sugs.length) % sugs.length));
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), applySuggestion(sugs[sel]));
      if (e.key === 'Escape') return (e.preventDefault(), setSugs([]));
    }
    if (e.key === 'Escape') {
      if (editing) {
        setEditing(null);
        setText('');
      }
      if (quoting) setQuoting(null);
    }
    if (e.key === 'ArrowUp' && !text && onEditLast) {
      e.preventDefault();
      onEditLast();
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // Teclado de toque não tem Shift: lá o Enter quebra a linha e quem envia é o botão (a opção "Enter envia"
      // nem aparece nas Preferências do celular).
      const wantsSend = coarse ? false : sendOnEnter ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
      if (wantsSend) {
        e.preventDefault();
        void send();
      }
    }
  };

  const insertAtCaret = (s: string) => {
    const el = ta.current;
    const pos = el?.selectionStart ?? text.length;
    const next = text.slice(0, pos) + s + text.slice(pos);
    setText(next);
    saveDraft(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + s.length, pos + s.length);
    });
  };

  const wrap = (mark: string) => {
    const el = ta.current!;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = text.slice(0, a) + mark + text.slice(a, b) + mark + text.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + mark.length, b + mark.length);
    });
  };

  const closePicker = useCallback(() => {
    setPicker(false);
    setRequest(null);
  }, []);
  // Figurinha enviada pela sugestão: o emoji digitado não vai junto.
  const clearAfterSticker = () => {
    setText('');
    saveDraft('');
    reqSeq.current++;
    setSugs([]);
    sendTyping(false);
    setQuoting(null);
  };
  const ackPending = !!ackOption && askAck && !tmid;
  const cancelPending = () => (setPending([]), setFileDesc(''));
  const confirmPending = () => (void doUpload(pending, fileDesc), setPending([]), setFileDesc(''));

  if (disabled) {
    // Os motivos do servidor citam @usuário: aqui aparece o nome da pessoa.
    const note = namesIn(disabledText(disabledReason), nameOf);
    return (
      <div className="composer disabled" ref={box} title={note !== disabledReason ? disabledReason : undefined}>
        <Icon name={disabledIcon ?? disabledIconFor(disabledReason)} size={16} />
        <span>{note}</span>
      </div>
    );
  }

  // Mensagem com apelido (ponte do Teams): o nome da pessoa, como no stream, e não o do robô.
  const quoteName = quoting ? quoting.alias || quoting.u.name || quoting.u.username : '';
  const format = (
    <>
      <button type="button" className="tool-btn" title="Negrito" aria-label="Negrito" onClick={() => wrap('*')}>
        <Icon name="bold" size={16} />
      </button>
      <button type="button" className="tool-btn" title="Itálico" aria-label="Itálico" onClick={() => wrap('_')}>
        <Icon name="italic" size={16} />
      </button>
      <button type="button" className="tool-btn" title="Tachado" aria-label="Tachado" onClick={() => wrap('~')}>
        <Icon name="strike" size={16} />
      </button>
      <button type="button" className="tool-btn" title="Código" aria-label="Código" onClick={() => wrap('`')}>
        <Icon name="code" size={16} />
      </button>
    </>
  );

  return (
    <div className={`composer${editing ? ' is-editing' : ''}${voice.active ? ' is-recording' : ''}`} ref={box}>
      {editing && (
        <div className="composer-bar editing">
          <Icon name="editing" size={14} />
          <span className="composer-bar-text">Editando mensagem</span>
          <span className="composer-bar-hint">
            <kbd>Esc</kbd> para cancelar
          </span>
          <button type="button" className="icon-btn" title="Cancelar edição" aria-label="Cancelar edição" onClick={cancelEdit}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {quoting && (
        <div className="composer-bar quoting">
          <Icon name="quote" size={14} />
          <span className="composer-bar-text">
            Citando <strong>{quoteName}</strong>
          </span>
          <span className="composer-bar-excerpt">{(quoting.msg || (quoting.sticker ? stickerPreviewText(quoting.sticker, { withName: false }) : '')).slice(0, 160)}</span>
          <button type="button" className="icon-btn" title="Remover citação" aria-label="Remover citação" onClick={() => setQuoting(null)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {uploads.map((u) => (
        <div key={u.id} className="composer-bar upload" role="status">
          <Icon name={fileIconName(u.name)} size={16} />
          <span className="composer-bar-text">Enviando {u.name}</span>
          <span className="progress" aria-hidden="true">
            <span style={{ width: `${u.progress * 100}%` }} />
          </span>
          <span className="composer-bar-pct">{Math.round(u.progress * 100)}%</span>
          <button type="button" className="icon-btn" title="Cancelar envio" aria-label={`Cancelar envio de ${u.name}`} onClick={() => u.abort.abort()}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      {sugs.length > 0 && (
        <Portal>
          <div
            ref={anch.setFloating}
            className={section === SECTION['/'] ? 'suggestions commands' : 'suggestions'}
            id={listId}
            role="listbox"
            aria-label={section || 'Sugestões'}
            style={anch.style}
            data-side={anch.positioned ? anch.side : undefined}
            data-layer={anch.layer}
          >
            {section && <div className="sug-section">{section}</div>}
            {sugs.map((s, i) => (
              <button
                key={s.key}
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === sel}
                className={i === sel ? 'active' : ''}
                tabIndex={-1}
                onMouseDown={(e) => (e.preventDefault(), applySuggestion(s))}
                onMouseEnter={() => setSel(i)}
              >
                {s.lead && <span className="sug-lead">{s.lead}</span>}
                <span className="sug-title">{s.title}</span>
                {s.sub && <span className="sug-sub">{s.sub}</span>}
              </button>
            ))}
          </div>
        </Portal>
      )}
      <StickerSuggestions
        text={text}
        room={room}
        tmid={tmid ?? null}
        tshow={tmid ? alsoChannel : undefined}
        quotingId={quoting?._id}
        anchor={box.current}
        input={ta.current}
        hidden={!!editing || uploads.length > 0 || pending.length > 0 || ackPending || sugs.length > 0}
        onSent={clearAfterSticker}
      />
      <div className="composer-row">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder ?? 'Mensagem'}
          aria-label={placeholder ?? 'Mensagem'}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={sugs.length > 0}
          aria-controls={sugs.length ? listId : undefined}
          aria-activedescendant={sugs.length ? `${listId}-${sel}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            saveDraft(e.target.value);
            sendTyping(!!e.target.value);
            void computeSuggestions(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length && uploadsOn) {
              e.preventDefault();
              setPending(files);
            }
          }}
          onBlur={() => setTimeout(() => setSugs([]), 150)}
        />
      </div>
      {/* No celular a formatação é uma linha própria acima das ferramentas: o botão Enviar nunca sai do lugar. */}
      {phone && fmt && (
        <div className="composer-format" role="toolbar" aria-label="Formatação">
          {format}
        </div>
      )}
      {tmid && (
        <label className="also-channel">
          <input type="checkbox" checked={alsoChannel} onChange={(e) => setAlsoChannel(e.target.checked)} /> Também enviar na sala
        </label>
      )}
      <div className="composer-tools">
        {voice.active && <VoiceBar voice={voice} />}
        {uploadsOn && (
          <label
            className="tool-btn"
            title="Enviar arquivo"
            aria-label="Enviar arquivo"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.currentTarget.querySelector('input')?.click();
            }}
          >
            <Icon name={phone ? 'add' : 'attach'} size={phone ? 18 : 16} />
            <input type="file" multiple hidden onChange={(e) => (e.target.files && setPending([...e.target.files]), (e.target.value = ''))} />
          </label>
        )}
        {phone && (
          <button type="button" className={fmt ? 'tool-btn on' : 'tool-btn'} title="Formatação" aria-label="Formatação" aria-pressed={fmt} onClick={() => setFmt(!fmt)}>
            <Icon name="format" size={16} />
          </button>
        )}
        <button ref={emojiBtn} type="button" className={picker ? 'tool-btn on' : 'tool-btn'} title="Emoji" aria-label="Emoji" aria-expanded={picker} onClick={() => setPicker(!picker)}>
          <Icon name="emoji" size={16} />
        </button>
        {!phone && (
          <>
            <span className="tool-sep" aria-hidden="true" />
            {format}
          </>
        )}
        <span className="spacer" />
        {text.length > maxSize * 0.8 && <span className={`counter ${over ? 'over' : ''}`}>{`${text.length}/${maxSize}`}</span>}
        {ackOption && !editing && !tmid && (
          <button type="button" className={`chip selectable ${askAck ? 'on' : 'off'}`} aria-pressed={askAck} aria-label="Pedir “Ciente”" title="Os membros confirmam que leram este aviso." onClick={() => setAskAck(!askAck)}>
            <Icon name="ack-request" size={14} className="chip-icon" />
            {/* Um item só para o texto: o gap do chip não entra entre as duas palavras. */}
            <span><span className="pill-label">Pedir </span>“Ciente”</span>
          </button>
        )}
        {editing ? (
          // Um item só: numa barra estreita, Cancelar e Salvar descem juntos para a linha de baixo.
          <span className="composer-edit-actions">
            <button type="button" className="btn small ghost" onClick={cancelEdit}>
              Cancelar
            </button>
            <button type="button" className="btn primary small send save" onClick={send} disabled={!text.trim() || over}>
              Salvar
            </button>
          </span>
        ) : micOn || voice.active ? (
          // O mesmo botão grava (segurando) e, com a gravação travada, envia: ele não sai de baixo do dedo.
          <button
            type="button"
            className={['btn primary send mic', voice.phase === 'holding' && 'holding', voice.phase === 'locked' && 'locked'].filter(Boolean).join(' ')}
            title={voice.phase === 'locked' ? 'Enviar áudio' : 'Segure para gravar um áudio (ou clique para gravar sem segurar)'}
            aria-label={voice.phase === 'locked' ? 'Enviar áudio' : 'Gravar mensagem de voz'}
            {...voice.micProps}
          >
            <Icon name={voice.phase === 'locked' ? 'send' : 'mic'} size={18} />
          </button>
        ) : (
          <button type="button" className="btn primary send" onClick={send} disabled={!text.trim() || over} title="Enviar">
            <Icon name="send" size={18} />
            <span className="visually-hidden">Enviar</span>
          </button>
        )}
      </div>
      {picker && (
        <ExpressionPicker
          anchor={emojiBtn.current}
          reference={box.current}
          placement="top-start"
          gap={6}
          room={room}
          tmid={tmid ?? null}
          tshow={tmid ? alsoChannel : undefined}
          quotingId={quoting?._id}
          editing={!!editing}
          ackPending={ackPending}
          request={request}
          onClose={closePicker}
          onEmoji={(c) => (insertAtCaret(`:${c}: `), closePicker())}
          onSent={() => setQuoting(null)}
          focusComposer={() => ta.current?.focus({ preventScroll: true })}
        />
      )}
      {drop && (
        <Portal>
          <div className="drop-overlay" style={{ top: drop.top + 8, left: drop.left + 8, width: drop.width - 16, height: drop.height - 16 }} aria-hidden="true">
            <Icon name="upload-drop" size={32} />
            <span>Solte para enviar</span>
          </div>
        </Portal>
      )}
      {pending.length > 0 && (
        <Modal
          title={pending.length === 1 ? 'Enviar arquivo' : `Enviar ${pending.length} arquivos`}
          onClose={cancelPending}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={cancelPending}>
                Cancelar
              </button>
              <button type="button" className="btn primary" onClick={confirmPending}>
                Enviar
              </button>
            </>
          }
        >
          <ul className="plain-list upload-list">
            {pending.map((f) => (
              <li key={f.name}>
                {f.type.startsWith('image/') ? <img className="upload-preview" src={URL.createObjectURL(f)} alt="" /> : <FileTile name={f.name} mime={f.type} />}
                <span className="upload-name">{f.name}</span>
                <span className="upload-size">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <input autoFocus placeholder="Descrição (opcional)" aria-label="Descrição" value={fileDesc} onChange={(e) => setFileDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirmPending()} />
        </Modal>
      )}
    </div>
  );
}
