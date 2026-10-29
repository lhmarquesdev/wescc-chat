// Seletor de expressões do compositor: "Emojis | Figurinhas" onde dá para enviar figurinha; nas outras salas, o seletor de
// emoji de sempre. No computador, painel ancorado (em portal); no celular, folha de 50dvh.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Message, Room } from '@shared/index';
import { stickersAllowedIn } from '@shared/stickers';
import { EMOJI } from '../../lib/emoji';
import { setLastTab, setPickerOpen, setStickerPrefs, useStickerCaps, useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { EmojiPicker, EmojiPickerBody } from '../EmojiPicker';
import { focusables, Portal, Sheet, useAnchored, useEscape, useIsPhone, type Placement } from '../overlay';
import { StickerPicker } from './StickerPicker';

// Camadas que abrem a partir do seletor (menu da figurinha, editor, avisos): um clique nelas não o fecha.
const KEEP_OPEN = '.menu, .modal-backdrop, .sheet-backdrop, .toasts';

// stickersHere, mas reativo: muda quando as permissões ou as configurações mudam.
export function useStickersHere(room: Pick<Room, 't' | 'notice'> | null | undefined): boolean {
  const caps = useStickerCaps();
  return caps.enabled && stickersAllowedIn(room, { noticeRooms: caps.noticeRooms });
}

export interface ExpressionPickerProps {
  anchor: HTMLElement | null; // o botão do emoji: recebe o foco de volta no Esc
  reference?: HTMLElement | null; // onde o painel se posiciona (o compositor), quando não é no botão
  placement?: Placement;
  gap?: number;
  room: Room | null | undefined;
  tmid?: string | null;
  tshow?: boolean;
  quotingId?: string;
  editing?: boolean;
  ackPending?: boolean; // a próxima mensagem pediria "Ciente"
  request?: { packId?: string; seq: number } | null; // "Ver no seletor"
  onEmoji: (code: string, unicode: string | null) => void;
  onSent: (m: Message) => void;
  onClose: () => void;
  focusComposer?: () => void; // depois de enviar uma figurinha e fechar (no computador): o foco volta ao texto
}

export function ExpressionPicker(props: ExpressionPickerProps) {
  const here = useStickersHere(props.room);
  if (!here || !props.room)
    return (
      <EmojiPicker
        anchor={props.anchor}
        reference={props.reference}
        placement={props.placement}
        gap={props.gap}
        onClose={props.onClose}
        onPick={(code) => props.onEmoji(code, EMOJI[code] ?? null)}
      />
    );
  return <Expressions {...props} room={props.room} />;
}

function Expressions({
  anchor,
  reference,
  placement = 'top-start',
  gap = 6,
  room,
  tmid,
  tshow,
  quotingId,
  editing,
  ackPending,
  request,
  onEmoji,
  onSent,
  onClose,
  focusComposer,
}: ExpressionPickerProps & { room: Room }) {
  const phone = useIsPhone();
  const ids = useId();
  const lastTab = useStickers((s) => s.lastTab);
  const tabSeen = useStore((s) => !!s.me?.preferences?.stickerTabSeen);
  const blocked = editing ? 'Termine a edição para enviar uma figurinha.' : ackPending ? 'Figurinhas não pedem “Ciente”. Desligue “Pedir Ciente” para enviar uma.' : null;
  const [tab, setTab] = useState<'emoji' | 'stickers'>(() => (request ? 'stickers' : lastTab));
  const shown = blocked ? 'emoji' : tab;
  // A busca recebe o foco só na abertura; trocar de aba deixa o foco na aba.
  const [switched, setSwitched] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const anch = useAnchored({ open: !phone, placement, gap, minHeight: 240 });
  const setPanel = useCallback(
    (n: HTMLDivElement | null) => {
      ref.current = n;
      anch.setFloating(n);
    },
    [anch.setFloating],
  );

  // Um envio lento pode responder com este seletor já fechado: aí ele não fecha nem move nada.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setPickerOpen(true);
    return () => {
      alive.current = false;
      setPickerOpen(false);
    };
  }, []);
  useEffect(() => {
    if (request) setTab('stickers');
  }, [request?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (shown === 'stickers' && !tabSeen) void setStickerPrefs({ stickerTabSeen: true }).catch(() => undefined);
  }, [shown, tabSeen]);

  const close = () => {
    onClose();
    if (anchor?.isConnected) anchor.focus({ preventScroll: true });
  };
  // Enviou e fechou: o painel some com o foco dentro, que cairia no <body>. No computador o foco vai para o texto do
  // compositor (como nas sugestões); no celular a folha devolve o foco a quem a abriu, sem abrir o teclado.
  const closeAfterSend = () => {
    if (!alive.current) return;
    const panel = ref.current;
    onClose();
    if (phone) return;
    requestAnimationFrame(() => {
      // Só o foco que ficou sem dono: quem já foi para outro campo (ou um aviso) não é puxado de volta.
      const a = document.activeElement;
      if (a && a !== document.body && !panel?.contains(a)) return;
      if (focusComposer) focusComposer();
      else if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    });
  };
  // O Tab dá a volta dentro do painel (a folha do celular já prende o foco): do último controle volta ao primeiro.
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    // Botões com tabIndex -1 (células fora do foco itinerante) não entram na ordem do Tab.
    const list = focusables(e.currentTarget).filter((el) => el.tabIndex >= 0);
    if (!list.length) return;
    const cur = document.activeElement as HTMLElement | null;
    const after = cur ? list.filter((el) => cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : list;
    const before = cur ? list.filter((el) => cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) : [];
    if (e.shiftKey && !before.length) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && !after.length) {
      e.preventDefault();
      list[0].focus();
    }
  };
  useEscape(!phone, close);
  useEffect(() => {
    const at = reference ?? anchor;
    if (at) anch.setReference(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, reference]);
  useEffect(() => {
    if (phone) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t) || t.closest?.(KEEP_OPEN)) return;
      onClose();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [phone, anchor, onClose]);

  const choose = (t: 'emoji' | 'stickers') => {
    if (t === 'stickers' && blocked) return;
    setSwitched(true);
    setTab(t);
    setLastTab(t);
  };
  const onTabKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = shown === 'emoji' ? 'stickers' : 'emoji';
    if (next === 'stickers' && blocked) return;
    choose(next);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  const focusBody = !phone && anch.positioned && !switched;
  const head = (
    <div className="expr-head">
      <div className="seg-nav" role="tablist" aria-label="Expressões" ref={tabsRef} onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          id={`${ids}-emoji`}
          data-tab="emoji"
          aria-selected={shown === 'emoji'}
          aria-controls={`${ids}-panel`}
          tabIndex={shown === 'emoji' ? 0 : -1}
          className={shown === 'emoji' ? 'on' : undefined}
          onClick={() => choose('emoji')}
        >
          Emojis
        </button>
        <button
          type="button"
          role="tab"
          id={`${ids}-stickers`}
          data-tab="stickers"
          aria-selected={shown === 'stickers'}
          aria-controls={`${ids}-panel`}
          aria-disabled={blocked ? 'true' : undefined}
          title={blocked ?? undefined}
          tabIndex={shown === 'stickers' ? 0 : -1}
          className={shown === 'stickers' ? 'on' : undefined}
          onClick={() => choose('stickers')}
        >
          Figurinhas
          {!tabSeen && (
            <>
              <span className="badge dot" aria-hidden="true" />
              <span className="visually-hidden">Novidade</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
  const body: ReactNode =
    shown === 'emoji' ? (
      <EmojiPickerBody onPick={onEmoji} autoFocus={focusBody} />
    ) : (
      <StickerPicker
        key={request?.seq ?? 0}
        room={room}
        tmid={tmid}
        tshow={tshow}
        quotingId={quotingId}
        phone={phone}
        packId={request?.packId}
        autoFocus={focusBody}
        onSent={onSent}
        onClose={onClose}
        onSentClose={closeAfterSend}
      />
    );
  const panel = (
    <>
      {head}
      <div className="expr-body" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${shown}`}>
        {body}
      </div>
    </>
  );

  if (phone)
    return (
      <Sheet onClose={onClose} className="emoji-sheet expr-sheet" label="Emojis e figurinhas">
        <div className="emoji-picker in-sheet expr-picker">{panel}</div>
      </Sheet>
    );
  return (
    <Portal>
      <div
        ref={setPanel}
        className="emoji-picker expr-picker"
        role="dialog"
        aria-label="Emojis e figurinhas"
        style={anch.style}
        data-side={anch.positioned ? anch.side : undefined}
        data-layer={anch.layer}
        onKeyDown={onPanelKey}
      >
        {panel}
      </div>
    </Portal>
  );
}
