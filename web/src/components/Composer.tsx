import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@shared/index';
import { api, errorMessage, uploadFile } from '../lib/api';
import { EMOJI, searchEmoji } from '../lib/emoji';
import { realtime } from '../lib/realtime';
import { useSetting, useStore } from '../lib/store';
import { EmojiPicker } from './EmojiPicker';
import { Avatar } from './ui';

interface Suggestion {
  key: string;
  label: React.ReactNode;
  insert: string;
}

let commandsCache: { command: string; params: string; description: string }[] | null = null;

export interface ComposerHandle {
  edit(m: Message): void;
  quote(m: Message): void;
}

export function Composer({
  rid,
  tmid,
  disabled,
  disabledReason,
  placeholder,
  editing,
  setEditing,
  quoting,
  setQuoting,
  onEditLast,
  canned,
  ackOption,
}: {
  rid: string;
  tmid?: string;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  editing: Message | null;
  setEditing: (m: Message | null) => void;
  quoting: Message | null;
  setQuoting: (m: Message | null) => void;
  onEditLast?: () => void;
  // Atendimento: respostas prontas com "!atalho" e variáveis do contato/agente.
  canned?: { contactName: string; contactEmail?: string; agentName: string };
  // Canal de avisos com "Ciente": quem publica escolhe se o aviso pede confirmação.
  ackOption?: boolean;
}) {
  const me = useStore((s) => s.me)!;
  const sendOnEnter = me.preferences?.sendOnEnter !== false;
  const maxSize = useSetting<number>('Message_MaxAllowedSize') ?? 5000;
  const uploadsOn = useSetting<boolean>('FileUpload_Enabled');
  const [text, setText] = useState('');
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [picker, setPicker] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [alsoChannel, setAlsoChannel] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [fileDesc, setFileDesc] = useState('');
  const [askAck, setAskAck] = useState(true);
  const ta = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef<{ on: boolean; timer: number | null }>({ on: false, timer: null });
  const draftKey = `wescc.draft.${rid}${tmid ? `.${tmid}` : ''}`;

  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey) ?? '');
    } catch {
      setText('');
    }
  }, [draftKey]);

  useEffect(() => {
    if (editing) {
      setText(editing.msg);
      ta.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (quoting) ta.current?.focus();
  }, [quoting]);

  const saveDraft = (v: string) => {
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

  const reqSeq = useRef(0);
  const cannedRef = useRef<any[] | null>(null);
  const computeSuggestions = useCallback(
    async (value: string, caret: number) => {
      // Respostas antigas do servidor não podem reabrir a lista depois do envio.
      const my = ++reqSeq.current;
      const put = (list: Suggestion[]) => {
        if (my === reqSeq.current) setSugs(list);
      };
      const before = value.slice(0, caret);
      const cm = canned ? before.match(/(?:^|\s)!([\w-]*)$/) : null;
      if (cm) {
        cannedRef.current ??= (await api.get('canned-responses.get').catch(() => ({ responses: [] }))).responses;
        const term = cm[1].toLowerCase();
        const fill = (t: string) =>
          t
            .replace(/\{\{\s*contact\.name\s*\}\}/g, canned!.contactName)
            .replace(/\{\{\s*contact\.email\s*\}\}/g, canned!.contactEmail ?? '')
            .replace(/\{\{\s*agent\.name\s*\}\}/g, canned!.agentName);
        put(
          (cannedRef.current ?? [])
            .filter((c: any) => c.shortcut.toLowerCase().startsWith(term) || (term.length > 1 && c.text.toLowerCase().includes(term)))
            .slice(0, 10)
            .map((c: any) => ({
              key: c._id,
              label: (
                <>
                  <strong>!{c.shortcut}</strong> <span className="muted">{c.text.slice(0, 80)}</span>
                </>
              ),
              insert: fill(c.text),
            })),
        );
        setSel(0);
        return;
      }
      const m = before.match(/(?:^|\s)([@#:])([^\s@#:]*)$/) ?? (before.match(/^\/([a-z0-9-]*)$/i) ? ([before, '/', before.slice(1)] as unknown as RegExpMatchArray) : null);
      if (!m) return put([]);
      const [, trig, term] = m;
      if (trig === '@') {
        const r = await api.get('users.autocomplete', { term, rid }).catch(() => ({ items: [] }));
        const items: Suggestion[] = r.items.map((u: any) => ({
          key: u._id,
          label: (
            <>
              <Avatar username={u.username} size={20} /> <strong>{u.username}</strong> <span className="muted">{u.name}</span>
            </>
          ),
          insert: `@${u.username} `,
        }));
        for (const g of ['all', 'here']) if (g.startsWith(term)) items.push({ key: g, label: <><strong>@{g}</strong> <span className="muted">{g === 'all' ? 'todos da sala' : 'todos online'}</span></>, insert: `@${g} ` });
        put(items.slice(0, 10));
      } else if (trig === '#') {
        const r = await api.get('rooms.autocomplete.channelAndPrivate', { term }).catch(() => ({ items: [] }));
        put(r.items.map((x: any) => ({ key: x._id, label: <>#{x.name}</>, insert: `#${x.name} ` })));
      } else if (trig === ':') {
        if (term.length < 2) return put([]);
        put(searchEmoji(term).map((c) => ({ key: c, label: <>{EMOJI[c] ?? <img className="emoji custom" src={`/emoji-custom/${c}`} alt="" />} :{c}:</>, insert: `:${c}: ` })));
      } else if (trig === '/') {
        commandsCache ??= (await api.get('commands.list').catch(() => ({ commands: [] }))).commands;
        put(
          (commandsCache ?? [])
            .filter((c) => c.command.startsWith(term))
            .slice(0, 12)
            .map((c) => ({ key: c.command, label: <><strong>/{c.command}</strong> <span className="muted">{c.params} — {c.description}</span></>, insert: `/${c.command} ` })),
        );
      }
      setSel(0);
    },
    [rid, canned],
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

  const doUpload = async (files: File[], description: string) => {
    for (const f of files) {
      setUploads((u) => [...u, { name: f.name, progress: 0 }]);
      try {
        await uploadFile(rid, f, { description, tmid: tmid ?? '' }, (p) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: p } : x))));
      } catch (e) {
        useStore.getState().toast(errorMessage(e), 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name));
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (sugs.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setSel((sel + 1) % sugs.length));
      if (e.key === 'ArrowUp') return (e.preventDefault(), setSel((sel - 1 + sugs.length) % sugs.length));
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), applySuggestion(sugs[sel]));
      if (e.key === 'Escape') return setSugs([]);
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
      const wantsSend = sendOnEnter ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
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

  if (disabled) return <div className="composer disabled">{disabledReason ?? 'Você não pode enviar mensagens aqui.'}</div>;

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (uploadsOn && e.dataTransfer.files.length) setPending([...e.dataTransfer.files]);
      }}
    >
      {editing && (
        <div className="composer-bar">
          ✏️ Editando mensagem <button className="link" onClick={() => (setEditing(null), setText(''))}>cancelar (Esc)</button>
        </div>
      )}
      {quoting && (
        <div className="composer-bar">
          ❝ Citando <strong>{quoting.u.username}</strong>: <span className="muted ellipsis">{quoting.msg.slice(0, 80)}</span>
          <button className="link" onClick={() => setQuoting(null)}>
            remover
          </button>
        </div>
      )}
      {uploads.map((u) => (
        <div key={u.name} className="composer-bar">
          ⬆ Enviando {u.name}… {Math.round(u.progress * 100)}%
          <div className="progress">
            <div style={{ width: `${u.progress * 100}%` }} />
          </div>
        </div>
      ))}
      {sugs.length > 0 && (
        <div className="suggestions">
          {sugs.map((s, i) => (
            <button key={s.key} className={i === sel ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), applySuggestion(s))}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder ?? 'Mensagem'}
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
          style={{ height: Math.min(200, 22 + 20 * Math.min(8, text.split('\n').length)) }}
        />
      </div>
      <div className="composer-tools">
        <button title="Emoji" onClick={() => setPicker(!picker)}>
          😊
        </button>
        <button title="Negrito" onClick={() => wrap('*')}>
          <b>B</b>
        </button>
        <button title="Itálico" onClick={() => wrap('_')}>
          <i>I</i>
        </button>
        <button title="Tachado" onClick={() => wrap('~')}>
          <s>S</s>
        </button>
        <button title="Código" onClick={() => wrap('`')}>
          {'</>'}
        </button>
        {uploadsOn && (
          <label className="tool-btn" title="Enviar arquivo">
            📎
            <input type="file" multiple hidden onChange={(e) => e.target.files && setPending([...e.target.files])} />
          </label>
        )}
        {tmid && (
          <label className="also-channel">
            <input type="checkbox" checked={alsoChannel} onChange={(e) => setAlsoChannel(e.target.checked)} /> Também enviar para a sala
          </label>
        )}
        <span className="spacer" />
        <span className={`counter ${text.length > maxSize ? 'over' : ''}`}>{text.length > maxSize * 0.8 ? `${text.length}/${maxSize}` : ''}</span>
        {ackOption && !editing && !tmid && (
          <button type="button" className={`chip selectable ${askAck ? 'on' : 'off'}`} aria-pressed={askAck} aria-label="Pedir “Ciente”" title="Os membros confirmam que leram este aviso." onClick={() => setAskAck(!askAck)}>
            ✔ <span className="pill-label">Pedir </span>“Ciente”
          </button>
        )}
        <button className="btn primary send" onClick={send} disabled={!text.trim()}>
          {editing ? 'Salvar' : 'Enviar'}
        </button>
      </div>
      {picker && (
        <div className="picker-anchor composer-picker">
          <EmojiPicker onClose={() => setPicker(false)} onPick={(c) => (insertAtCaret(`:${c}: `), setPicker(false))} />
        </div>
      )}
      {pending.length > 0 && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h2>Enviar {pending.length === 1 ? 'arquivo' : `${pending.length} arquivos`}</h2>
            </div>
            <div className="modal-body">
              <ul className="plain-list">
                {pending.map((f) => (
                  <li key={f.name}>
                    {f.type.startsWith('image/') ? <img className="upload-preview" src={URL.createObjectURL(f)} alt="" /> : '📄'} {f.name}
                  </li>
                ))}
              </ul>
              <input autoFocus placeholder="Descrição (opcional)" value={fileDesc} onChange={(e) => setFileDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (void doUpload(pending, fileDesc), setPending([]), setFileDesc(''))} />
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => (setPending([]), setFileDesc(''))}>
                Cancelar
              </button>
              <button className="btn primary" onClick={() => (void doUpload(pending, fileDesc), setPending([]), setFileDesc(''))}>
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
