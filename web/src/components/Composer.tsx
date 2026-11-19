import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message } from '@shared/index';
import { encryptedContent } from '@shared/messages';
import { mediaTypeAllowed, stickerPreviewText } from '@shared/stickers';
import { localCommandText } from '@shared/e2e';
import { editEncrypted, quoteOf, sendEncrypted, sendEncryptedFile, type E2eFileMeta } from '../lib/e2e/client';
import { api, ApiError, errorMessage, uploadTo } from '../lib/api';
import { slashCommands, type SlashCommand } from '../lib/commands';
import { EMOJI, searchEmoji } from '../lib/emoji';
import { formatBytes, nameList, roomPath } from '../lib/format';
import { editTextOf, mentionGroups, mentionSuggestions, unknownSlashCommand } from '../lib/messageRules';
import { whenText } from '../lib/messageTimes';
import { realtime } from '../lib/realtime';
import { clientMessageId, registerComposer, useStickers } from '../lib/stickers';
import { canWithRoles, useSetting, useStore } from '../lib/store';
import { namesIn, useNames } from '../lib/names';
import { voiceFileType } from '../lib/voice';
import { Icon, type IconName } from './Icon';
import { fileIconName, FileTile, setEditingMessage } from './MessageItem';
import { Portal, Sheet, useAnchored, useIsPhone, useMedia } from './overlay';
import { PollModal } from './Poll';
import { ScheduleArrow, ScheduledStrip, ScheduleItems, ScheduleModal } from './ScheduleControls';
import { videoBlockedReason, VideoRecorder } from './VideoRecorder';
import { ExpressionPicker } from './stickers/ExpressionPicker';
import { StickerHost } from './stickers/StickerMenuItems';
import { StickerSuggestions } from './stickers/StickerSuggestions';
import { Avatar, Menu, Modal } from './ui';
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

const VOICE_BLOCKED = 'O administrador não permite enviar áudio.';

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
  // /help: a lista de comandos num modal (antes, um aviso enorme que sumia sozinho).
  const [help, setHelp] = useState<SlashCommand[] | null>(null);
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
  const sub = useStore((s) => s.subscriptions[rid]);
  // Upload permitido nesta sala (conversa direta segue FileUpload_Enabled_Direct): vale para o botão, para colar e para
  // arrastar. Antes, colar ou soltar um arquivo numa DM sem upload abria a janela e só dava erro depois de Enviar.
  const uploadsHere = !!uploadsOn && !(room?.t === 'd' && uploadsInDirect === false);
  const uploadsOff = !uploadsOn ? 'Upload de arquivos desativado.' : 'Upload em mensagens diretas desativado.'; // o texto do servidor
  const navigate = useNavigate();
  const whiteList = useSetting<string>('FileUpload_MediaTypeWhiteList') ?? '';
  const blackList = useSetting<string>('FileUpload_MediaTypeBlackList') ?? '';
  const fileInput = useRef<HTMLInputElement>(null);
  const [recordingVideo, setRecordingVideo] = useState(false);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const [scheduleSheet, setScheduleSheet] = useState(false);
  const [scheduleCustom, setScheduleCustom] = useState(false);
  const sendPress = useRef<{ timer: number; fired: boolean } | null>(null);
  // Envio em andamento (rede lenta): Enter e o botão não mandam de novo. O _id vem daqui; reenviar o mesmo texto depois
  // de uma falha usa o mesmo, e o servidor devolve a mensagem que já tinha saído, sem cópia.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendKey = useRef<{ key: string; id: string } | null>(null);
  const textNow = useRef('');
  // Folha "Agendar envio" aberta pelo toque longo: o clique que vem ao soltar o dedo cai em cima dela e é descartado.
  const swallowSheetClicks = useRef(0);
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

  // Rascunho de conversa criptografada não fica no navegador.
  const noDraft = !!room?.encrypted;
  const readDraft = () => {
    try {
      if (noDraft) {
        localStorage.removeItem(draftKey);
        return '';
      }
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  };
  useEffect(() => {
    setText(readDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  // A conversa passou a ser criptografada: o rascunho que já estava guardado sai do navegador.
  useEffect(() => {
    if (noDraft) readDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noDraft]);

  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      setText(editTextOf(editing));
      ta.current?.focus();
      // A mensagem em edição fica à vista: a seta para cima pega a última da pessoa, que pode estar lá em cima.
      box.current?.closest('.thread-panel, .room-main')?.querySelector(`[id="msg-${editing._id}"]`)?.scrollIntoView({ block: 'nearest' });
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

  // Arrastar um arquivo sobre a sala (ou o painel do tópico) mostra a área de soltar. Sem upload aqui, soltar só avisa
  // (sem isso o navegador abria o arquivo no lugar do chat).
  useEffect(() => {
    const host = box.current?.closest<HTMLElement>('.thread-panel, .room-main');
    if (!host || disabled) return;
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!files(e) || !uploadsHere) return;
      e.preventDefault();
      if (depth++ === 0) setDrop(host.getBoundingClientRect());
    };
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!files(e) || !uploadsHere) return;
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
      if (!uploadsHere) useStore.getState().toast(uploadsOff, 'error');
      else if (e.dataTransfer?.files.length) setPending([...e.dataTransfer.files]);
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
  }, [uploadsHere, uploadsOff, disabled]);

  const saveDraft = (v: string) => {
    // O texto de uma edição não é rascunho de mensagem nova: depois de uma recarga, o Enter publicaria uma cópia.
    if (editing || noDraft) return;
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
  // "Gravando vídeo…": o mesmo esquema do áudio.
  const sendVideoActivity = (on: boolean) => {
    if (typingRef.current.timer) clearTimeout(typingRef.current.timer);
    typingRef.current.on = false;
    realtime.send({ type: 'typing', rid, tmid: tmid ?? null, typing: on, activity: 'video' });
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
        // Quem não está na sala vem depois dos membros e não recebe o aviso da menção.
        const outside = useStore.getState().rooms[rid]?.t === 'd' ? 'não está na conversa' : 'não está na sala';
        const person = (u: any): Suggestion => ({
          key: u._id,
          lead: <Avatar username={u.username} size={24} />,
          title: u.name || u.username,
          sub: u.inRoom === false ? `@${u.username} · ${outside}` : `@${u.username}`,
          insert: `@${u.username} `,
        });
        const people: Suggestion[] = r.items.filter((u: any) => u.username !== me.username).map(person);
        const myRoles = [...me.roles, ...(useStore.getState().subscriptions[rid]?.roles ?? [])];
        const groups: Suggestion[] = mentionGroups(term, (p) => canWithRoles(p, myRoles)).map((g) => ({
          key: g,
          lead: <Icon name="mention" size={16} />,
          title: `@${g}`,
          sub: g === 'all' ? 'todos da sala' : 'todos online',
          insert: `@${g} `,
        }));
        const self = r.items.find((u: any) => u.username === me.username);
        put(mentionSuggestions(people, groups, self ? person(self) : undefined), '@');
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
    [rid, me.username, me._id, me.roles],
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
  textNow.current = text;
  // Arquivo: a legenda pode ficar vazia (o arquivo continua). Na cifrada, não.
  const fileEdit = !!editing && !editing.e2e && !!editing.files?.length;

  // Mencionou quem não está na sala: essa pessoa não recebe aviso nenhum. Quem pode adicionar pessoas adiciona dali.
  const warnNotInRoom = (list?: { _id: string; username: string; name?: string }[]) => {
    if (!list?.length || !room) return;
    const st = useStore.getState();
    const names = nameList(list.map((u) => u.name || u.username));
    const where = room.t === 'd' ? 'nesta conversa' : 'nesta sala';
    const text = list.length === 1 ? `${names} não está ${where} e não recebeu o aviso da menção.` : `${names} não estão ${where} e não receberam o aviso da menção.`;
    const roles = [...me.roles, ...(sub?.roles ?? [])];
    const canAdd = room.t !== 'd' && (canWithRoles('add-user-to-joined-room', roles) || canWithRoles(room.t === 'p' ? 'add-user-to-any-p-room' : 'add-user-to-any-c-room', roles));
    const add = () =>
      api
        .post(
          room.teamMain ? 'teams.addMembers' : room.t === 'p' ? 'groups.invite' : 'channels.invite',
          room.teamMain ? { teamId: room.teamId, members: list.map((u) => ({ userId: u._id })) } : { roomId: rid, userIds: list.map((u) => u._id) },
        )
        .then(() => st.toast(list.length === 1 ? `${names} agora está na sala.` : `${names} agora estão na sala.`, 'success'))
        .catch((e) => st.toast(errorMessage(e), 'error'));
    st.toast(text, 'warning', { duration: 10000, action: canAdd ? { label: 'Adicionar à sala', onClick: () => void add() } : undefined });
  };

  // Comando que não deixa nada na sala (/status, /msg): a confirmação que o servidor manda.
  const commandDone = (r?: { ok?: boolean; command?: string; text?: string; rid?: string }) => {
    if (!r?.ok || !r.command || !r.text) return;
    const to = r.rid;
    useStore.getState().toast(r.text, 'success', to ? { action: { label: 'Abrir conversa', onClick: () => navigate(roomPath({ _id: to, t: 'd' })) } } : undefined);
  };

  const clearSent = (msg: string) => {
    // O que a pessoa começou a escrever enquanto a mensagem saía fica no compositor.
    if (textNow.current.trim() !== msg) return;
    setText('');
    saveDraft('');
    reqSeq.current++;
    setSugs([]);
  };

  // asText: "Enviar como texto" do aviso de comando que não existe.
  const send = async (opts: { asText?: boolean } = {}) => {
    if (sendingRef.current) return;
    const msg = textNow.current.trim();
    const isEdit = !!editing;
    if (!msg && !pending.length && !fileEdit) return;
    if (msg.length > maxSize) return useStore.getState().toast(`A mensagem excede ${maxSize} caracteres.`, 'error');
    // Salvou sem mudar nada: só sai da edição (não marca "editada").
    if (editing && msg === editTextOf(editing).trim()) return setEditing(null);
    sendTyping(false);
    sendingRef.current = true;
    setSending(true);
    try {
      if (!editing && !opts.asText && msg.startsWith('/')) {
        const list = await slashCommands(me._id);
        if (/^\/help(?:\s|$)/i.test(msg) && list.length) {
          setHelp(list);
          return clearSent(msg);
        }
        // Erro de digitação (/leav): o texto fica na caixa e não vai para a sala como mensagem.
        const unknown = unknownSlashCommand(msg, list.map((c) => c.command));
        if (unknown) {
          const hint = unknown.suggestion ? ` Você quis dizer /${unknown.suggestion}?` : '';
          useStore.getState().toast(`O comando /${unknown.name} não existe.${hint}`, 'warning', { duration: 8000, action: { label: 'Enviar como texto', onClick: () => void send({ asText: true }) } });
          return;
        }
      }
      if (room?.encrypted) {
        if (!(await sendE2e(msg))) return;
      } else if (editing) {
        await api.post('chat.update', { roomId: rid, msgId: editing._id, text: msg });
        setEditing(null);
      } else {
        const attachments = quoting ? [{ text: quoting.msg, author_name: quoting.u.username, ts: quoting.ts, message_link: `?msg=${quoting._id}` }] : undefined;
        const ackRequired = ackOption && askAck && !tmid ? true : undefined;
        const key = JSON.stringify([rid, tmid ?? '', msg, quoting?._id ?? '', !!alsoChannel, !!ackRequired]);
        const _id = sendKey.current?.key === key ? sendKey.current.id : clientMessageId();
        sendKey.current = { key, id: _id };
        const r = await api.post('chat.sendMessage', { message: { _id, rid, msg, tmid, tshow: tmid ? alsoChannel || undefined : undefined, attachments, ackRequired } });
        sendKey.current = null;
        if (quoting) setQuoting(null);
        // A lista longe do fim (link para uma antiga, primeira não lida): volta para as últimas, onde a mensagem aparece.
        if (!tmid) useStore.getState().sentFromRoom(rid);
        warnNotInRoom(r.mentionsNotInRoom);
        commandDone(r.message);
      }
      // "Também enviar na sala" vale para uma resposta só (como no Rocket.Chat): a seguinte fica no tópico.
      if (!isEdit && tmid) setAlsoChannel(false);
      clearSent(msg);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Conversa criptografada: o texto vai cifrado. Comandos que só publicam texto (/me, /shrug…) saem montados aqui; os
  // outros comandos conhecidos vão para commands.run (o servidor recusa os que publicariam texto aberto).
  const sendE2e = async (msg: string): Promise<boolean> => {
    if (!room) return false;
    if (editing) {
      await editEncrypted(room, editing, msg);
      setEditing(null);
      return true;
    }
    const cmd = msg.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    let text = msg;
    if (cmd) {
      const name = cmd[1].toLowerCase();
      const args = (cmd[2] ?? '').trim();
      const local = localCommandText(name, args);
      if (local !== null) text = local;
      else if ((await slashCommands(me._id)).some((c) => c.command === name)) {
        const r = await api.post('commands.run', { roomId: rid, command: name, params: args, tmid });
        commandDone(r.result);
        return true;
      }
    }
    const ackRequired = ackOption && askAck && !tmid ? true : undefined;
    await sendEncrypted(room, { msg: text, quote: quoting ? quoteOf(quoting) : undefined, tmid, tshow: tmid ? alsoChannel || undefined : undefined, ackRequired });
    if (quoting) setQuoting(null);
    return true;
  };

  // O que o servidor recusaria, conferido antes de enviar (as mesmas regras de uploads.ts): o modal marca cada arquivo e
  // nada sobe à toa. Na conversa criptografada o servidor não vê o tipo nem o tamanho real, e só esta conferência vale
  // (a cifra soma 16 bytes).
  const maxFile = useSetting<number>('FileUpload_MaxFileSize') ?? 0;
  const fileProblem = (f: File) => {
    if (!f.size) return 'Arquivo vazio.';
    const type = (f.type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!mediaTypeAllowed(type, whiteList, blackList)) return 'Tipo de arquivo não permitido.';
    if (maxFile > 0 && f.size + (room?.encrypted ? 16 : 0) > maxFile) {
      const limit = maxFile >= 1048576 ? `${Math.round(maxFile / 1048576)} MB` : `${Math.max(1, Math.round(maxFile / 1024))} KB`;
      return `Maior que o permitido (${limit}).`;
    }
    return null;
  };
  const e2eMeta = async (f: File, extra: Record<string, string>): Promise<E2eFileMeta> => {
    if (extra.voice) return { voice: true, duration: Number(extra.duration) || undefined, waveform: extra.waveform ? extra.waveform.split(',').map(Number) : undefined };
    if (extra.video) return { video: true, duration: Number(extra.duration) || undefined };
    if (f.type.startsWith('image/') && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(f);
        const size = { width: bmp.width, height: bmp.height };
        bmp.close();
        return size;
      } catch {
        // tipo que o navegador não abre: sem tamanho
      }
    }
    return {};
  };

  // Vários arquivos com uma descrição: ela vai só com o primeiro que sair (não se repete embaixo de cada um).
  const doUpload = async (files: File[], description: string, extra: Record<string, string> = {}, label?: string) => {
    let caption = description;
    for (const f of files) {
      const problem = fileProblem(f);
      if (problem) {
        useStore.getState().toast(`${label ?? f.name}: ${problem}`, 'error');
        continue;
      }
      const id = ++uploadSeq.current;
      const abort = new AbortController();
      setUploads((u) => [...u, { id, name: label ?? f.name, progress: 0, abort }]);
      try {
        const progress = (p: number) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x)));
        if (room?.encrypted) await sendEncryptedFile(room, f, { msg: caption, tmid, meta: await e2eMeta(f, extra), onProgress: progress, signal: abort.signal });
        // A legenda vai como o texto da mensagem: menções, formatação e Editar valem para ela.
        else await uploadTo(`rooms.upload/${rid}`, f, { msg: caption, tmid: tmid ?? '', ...extra }, progress, abort.signal);
        caption = '';
        if (!tmid) useStore.getState().sentFromRoom(rid);
      } catch (e) {
        // Cancelado por quem enviou: a barra some e basta.
        if (!(e instanceof ApiError && e.errorType === 'aborted')) useStore.getState().toast(errorMessage(e), 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.id !== id));
      }
    }
  };

  const voice = useVoiceRecorder({
    scope: `${rid}:${tmid ?? ''}`,
    onActivity: sendRecording,
    onSend: (r) => void doUpload([r.file], '', { voice: '1', duration: r.duration.toFixed(1), waveform: r.waveform.join(',') }, 'mensagem de voz'),
  });
  // Caixa vazia: o botão Enviar vira o microfone (como no WhatsApp).
  const micOn = uploadsHere && !editing && !text.trim() && !pending.length;
  // O tipo do áudio fora da lista de tipos permitidos: o microfone aparece desativado, com o motivo (a gravação seria
  // recusada só no envio).
  const voiceBlocked = micOn && !voice.active && !mediaTypeAllowed(voiceFileType(), whiteList, blackList);
  // Itens do "+": vídeo (upload permitido e o tipo aceito), enquete (create-poll). Sala criptografada: nenhum dos dois
  // (o servidor não lê o conteúdo), nem agendar.
  const roles = [...me.roles, ...(sub?.roles ?? [])];
  const encrypted = encryptedContent(room);
  const videoOn = uploadsHere && !encrypted && !editing && (mediaTypeAllowed('video/mp4', whiteList, blackList) || mediaTypeAllowed('video/webm', whiteList, blackList));
  const pollOn = !encrypted && !editing && canWithRoles('create-poll', roles);
  const canSchedule = !encrypted && canWithRoles('schedule-message', roles);
  const schedulable = canSchedule && !!text.trim() && !editing && !quoting && !pending.length && !text.trim().startsWith('/') && !over;
  const schedulePlus = phone && canSchedule && !editing;
  const ackLabel = ackOption && !tmid ? (askAck ? 'Pede “Ciente”' : 'Sem “Ciente”') : undefined;

  const openVideo = () => {
    const why = videoBlockedReason();
    if (why) return useStore.getState().toast(why, 'error');
    setRecordingVideo(true);
  };

  // Agendar o texto do compositor: limpa a caixa e o rascunho como o envio.
  const schedule = async (at: Date): Promise<boolean> => {
    const msg = text.trim();
    if (!msg) return false;
    if (msg.length > maxSize) return (useStore.getState().toast(`A mensagem excede ${maxSize} caracteres.`, 'error'), false);
    try {
      const ackRequired = ackOption && askAck && !tmid ? true : undefined;
      const r = await api.post('chat.scheduleMessage', { message: { rid, msg, tmid, tshow: tmid ? alsoChannel || undefined : undefined, ackRequired }, sendAt: at.toISOString() });
      const st = useStore.getState();
      st.upsertScheduled(r.scheduled);
      sendTyping(false);
      setText('');
      saveDraft('');
      reqSeq.current++;
      setSugs([]);
      const path = `${roomPath({ _id: rid, t: room?.t ?? sub?.t ?? 'c' })}?tab=scheduled`;
      st.toast(`Mensagem agendada para ${whenText(r.scheduled.sendAt, new Date())}.`, 'success', { icon: 'schedule', action: { label: 'Ver', onClick: () => navigate(path) } });
      return true;
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      return false;
    }
  };

  // Celular: segurar o Enviar por 450 ms abre "Agendar envio"; o clique que termina o toque longo não envia nem
  // escolhe a opção da folha que ficou embaixo do dedo (o touchend cancelado não gera clique; a trava de tempo cobre
  // o navegador que gera assim mesmo).
  const openScheduleSheetByPress = () => {
    swallowSheetClicks.current = Number.POSITIVE_INFINITY;
    const release = () => {
      swallowSheetClicks.current = Date.now() + 400;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    navigator.vibrate?.(10);
    setScheduleSheet(true);
  };
  const sendPressProps =
    phone && schedulable
      ? {
          onPointerDown: () => {
            if (sendPress.current) clearTimeout(sendPress.current.timer);
            const timer = window.setTimeout(() => {
              if (sendPress.current) sendPress.current.fired = true;
              openScheduleSheetByPress();
            }, 450);
            sendPress.current = { timer, fired: false };
          },
          onPointerUp: () => {
            const p = sendPress.current;
            if (p && !p.fired) clearTimeout(p.timer);
          },
          onTouchEnd: (e: React.TouchEvent) => {
            if (sendPress.current?.fired) {
              e.preventDefault();
              sendPress.current = null;
            }
          },
          onPointerLeave: () => {
            const p = sendPress.current;
            if (p && !p.fired) (clearTimeout(p.timer), (sendPress.current = null));
          },
          onPointerCancel: () => {
            const p = sendPress.current;
            if (p && !p.fired) (clearTimeout(p.timer), (sendPress.current = null));
          },
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        }
      : {};
  const onSendClick = () => {
    const p = sendPress.current;
    sendPress.current = null;
    if (p?.fired) return;
    void send();
  };

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
    setAlsoChannel(false);
  };
  const ackPending = !!ackOption && askAck && !tmid;
  const cancelPending = () => (setPending([]), setFileDesc(''));
  const pendingOk = pending.filter((f) => !fileProblem(f));
  const descOver = fileDesc.trim().length > maxSize;
  const canConfirm = pendingOk.length > 0 && !descOver;
  // Os arquivos marcados no modal (vazio, tipo, tamanho) ficam de fora.
  const confirmPending = () => canConfirm && (void doUpload(pendingOk, fileDesc), setPending([]), setFileDesc(''));

  const scheduledStrip = !tmid && <ScheduledStrip rid={rid} onOpen={() => navigate(`${roomPath({ _id: rid, t: room?.t ?? sub?.t ?? 'c' })}?tab=scheduled`)} />;

  if (disabled) {
    // Os motivos do servidor citam @usuário: aqui aparece o nome da pessoa. A faixa das agendadas fica também aqui:
    // quem deixou de publicar num canal de avisos ainda precisa ver a que não saiu (e reagendar, enviar ou excluir).
    const note = namesIn(disabledText(disabledReason), nameOf);
    return (
      <div className="composer disabled" ref={box}>
        {scheduledStrip}
        <div className="composer-note" title={note !== disabledReason ? disabledReason : undefined}>
          <Icon name={disabledIcon ?? disabledIconFor(disabledReason)} size={16} />
          <span>{note}</span>
        </div>
      </div>
    );
  }

  // Mensagem com apelido (webhooks): o nome da pessoa, como no stream, e não o do robô.
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
      {scheduledStrip}
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
            if (files.length && uploadsHere) {
              e.preventDefault();
              setPending(files);
            } else if (files.length && !e.clipboardData.getData('text')) useStore.getState().toast(uploadsOff, 'error');
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
        {/* O input fica fora do menu: continua vivo depois que o menu fecha. */}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && setPending([...e.target.files]), (e.target.value = ''))} />
        {videoOn || pollOn || schedulePlus ? (
          <Menu
            label="Adicionar"
            sheetTitle="Adicionar"
            placement="top-start"
            trigger={
              <button type="button" className="tool-btn" title="Adicionar" aria-label="Adicionar">
                <Icon name="add" size={phone ? 18 : 16} />
              </button>
            }
          >
            {(close) => (
              <>
                {uploadsHere && (
                  <button type="button" onClick={() => (close(), fileInput.current?.click())}>
                    <Icon name="attach" size={16} />
                    Enviar arquivo
                  </button>
                )}
                {videoOn && (
                  <button type="button" onClick={() => (close(), openVideo())}>
                    <Icon name="video-message" size={16} />
                    Gravar vídeo
                  </button>
                )}
                {pollOn && (
                  <button type="button" onClick={() => (close(), setCreatingPoll(true))}>
                    <Icon name="poll" size={16} />
                    Criar enquete
                  </button>
                )}
                {schedulePlus && (
                  // No celular o toque longo no Enviar não se vê: aqui o agendar fica à vista (agenda o texto da caixa).
                  <button type="button" disabled={!schedulable} onClick={() => (close(), (swallowSheetClicks.current = 0), setScheduleSheet(true))}>
                    <Icon name="schedule" size={16} />
                    <span className="menu-text">
                      Agendar mensagem
                      {!schedulable && <span className="menu-desc">Escreva a mensagem primeiro</span>}
                    </span>
                  </button>
                )}
              </>
            )}
          </Menu>
        ) : (
          uploadsHere && (
            <button type="button" className="tool-btn" title="Enviar arquivo" aria-label="Enviar arquivo" onClick={() => fileInput.current?.click()}>
              <Icon name={phone ? 'add' : 'attach'} size={phone ? 18 : 16} />
            </button>
          )
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
            <button type="button" className="btn primary small send save" onClick={() => void send()} disabled={(!text.trim() && !fileEdit) || over || sending} aria-busy={sending || undefined}>
              Salvar
            </button>
          </span>
        ) : voiceBlocked ? (
          <button
            type="button"
            className="btn primary send mic"
            aria-disabled="true"
            title={VOICE_BLOCKED}
            aria-label={`Gravar mensagem de voz. ${VOICE_BLOCKED}`}
            onClick={() => useStore.getState().toast(VOICE_BLOCKED, 'info')}
          >
            <Icon name="mic" size={18} />
          </button>
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
          <span className={`send-group${!phone && schedulable ? ' with-more' : ''}`}>
            <button
              type="button"
              className="btn primary send"
              onClick={onSendClick}
              disabled={!text.trim() || over || sending}
              aria-busy={sending || undefined}
              title={sending ? 'Enviando…' : phone && schedulable ? 'Enviar (segure para agendar)' : 'Enviar'}
              {...sendPressProps}
            >
              {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={18} />}
              <span className="visually-hidden">{sending ? 'Enviando…' : 'Enviar'}</span>
            </button>
            {!phone && schedulable && <ScheduleArrow onPick={(at) => void schedule(at)} onCustom={() => setScheduleCustom(true)} />}
          </span>
        )}
      </div>
      {scheduleSheet && (
        <Sheet onClose={() => setScheduleSheet(false)} className="menu schedule-menu" role="menu" label="Agendar envio">
          <div
            className="sheet-scroll"
            onClickCapture={(e) => {
              if (Date.now() < swallowSheetClicks.current) (e.preventDefault(), e.stopPropagation());
            }}
          >
            <div className="menu-title" role="presentation">
              <strong>Agendar envio</strong>
            </div>
            <ScheduleItems sheetRole onPick={(at) => void schedule(at)} onCustom={() => setScheduleCustom(true)} close={() => setScheduleSheet(false)} />
          </div>
        </Sheet>
      )}
      {scheduleCustom && <ScheduleModal ackLabel={ackLabel} onSubmit={({ at }) => schedule(at)} onClose={() => setScheduleCustom(false)} />}
      {recordingVideo && (
        <VideoRecorder
          onClose={() => setRecordingVideo(false)}
          onActivity={sendVideoActivity}
          onSend={(r) => void doUpload([r.file], '', { video: '1', duration: r.duration.toFixed(1) }, 'mensagem de vídeo')}
        />
      )}
      {creatingPoll && <PollModal rid={rid} tmid={tmid ?? null} onClose={() => setCreatingPoll(false)} />}
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
          onSent={() => (setQuoting(null), setAlsoChannel(false))}
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
              <button type="button" className="btn primary" onClick={confirmPending} disabled={!canConfirm}>
                {pendingOk.length && pendingOk.length < pending.length ? `Enviar ${pendingOk.length === 1 ? '1 arquivo' : `${pendingOk.length} arquivos`}` : 'Enviar'}
              </button>
            </>
          }
        >
          <ul className="plain-list upload-list">
            {pending.map((f, i) => {
              const problem = fileProblem(f);
              return (
                <li key={`${i}-${f.name}`} className={problem ? 'blocked' : undefined}>
                  {f.type.startsWith('image/') && !problem ? <img className="upload-preview" src={URL.createObjectURL(f)} alt="" /> : <FileTile name={f.name} mime={f.type} />}
                  <span className="upload-text">
                    <span className="upload-name">{f.name}</span>
                    {problem && <span className="upload-problem">{problem} Não será enviado.</span>}
                  </span>
                  <span className="upload-size">{formatBytes(f.size)}</span>
                </li>
              );
            })}
          </ul>
          <input
            autoFocus
            placeholder={pending.length > 1 ? 'Descrição (opcional, vai com o primeiro arquivo)' : 'Descrição (opcional)'}
            aria-label="Descrição"
            aria-invalid={descOver || undefined}
            value={fileDesc}
            onChange={(e) => setFileDesc(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmPending()}
          />
          {descOver && <p className="upload-problem">{`A descrição excede ${maxSize} caracteres (${fileDesc.trim().length}).`}</p>}
        </Modal>
      )}
      {help && <CommandsHelp commands={help} onPick={(c) => (setHelp(null), setText(`/${c} `), requestAnimationFrame(() => ta.current?.focus()))} onClose={() => setHelp(null)} />}
    </div>
  );
}

// /help: os comandos desta pessoa, um por linha, com os parâmetros. Clicar põe o comando na caixa.
function CommandsHelp({ commands, onPick, onClose }: { commands: SlashCommand[]; onPick: (command: string) => void; onClose: () => void }) {
  return (
    <Modal title="Comandos disponíveis" description="Digite / no campo de mensagem para ver a lista enquanto escreve." onClose={onClose}>
      <ul className="plain-list commands-help">
        {commands.map((c) => (
          <li key={c.command}>
            <button type="button" onClick={() => onPick(c.command)}>
              <code>
                /{c.command}
                {c.params && <span className="commands-help-params"> {c.params}</span>}
              </code>
              <span className="commands-help-desc">{c.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
