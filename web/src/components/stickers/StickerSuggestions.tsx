// Sugestões de figurinhas quando o texto do compositor é um emoji só (Unicode ou :atalho:).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, Room } from '@shared/index';
import { composerEmoji } from '@shared/stickers';
import { loadStickers, suggestionsFor, toUnicode, useStickerCaps, useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Portal, useAnchored } from '../overlay';
import { useStickersHere } from './ExpressionPicker';
import { nextCell, pickSticker, useStickerSend } from './StickerPicker';
import { StickerView } from './StickerView';

export function StickerSuggestions({
  text,
  room,
  tmid,
  tshow,
  quotingId,
  onSent,
  anchor,
  input,
  hidden,
}: {
  text: string;
  room: Room | null | undefined;
  tmid?: string | null;
  tshow?: boolean;
  quotingId?: string;
  onSent: (m: Message) => void; // limpa o texto e o rascunho: o emoji em si não vai
  anchor: HTMLElement | null; // o compositor: a linha fica acima dele
  input: HTMLTextAreaElement | null; // ↑ no texto entra na linha; Esc devolve o foco
  hidden?: boolean; // editando, enviando arquivo, pedindo "Ciente" ou outra lista de sugestões aberta
}) {
  const navigate = useNavigate();
  const caps = useStickerCaps();
  const sections = useStickers((s) => s.sections);
  const pref = useStore((s) => s.me?.preferences?.stickerSuggestions);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const emoji = useMemo(() => composerEmoji(text, toUnicode), [text]);
  const sug = useMemo(
    () => (hidden || !emoji ? null : suggestionsFor(text, room)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hidden, emoji, text, room, sections, caps, pref],
  );
  const open = !!sug && dismissed !== text;
  const anch = useAnchored({ open, placement: 'top-start', gap: 6, minHeight: 0 });
  const { send, sending } = useStickerSend({ room, tmid, tshow, quotingId, onSent });

  // O primeiro emoji digitado carrega os catálogos que ainda não vieram; a linha aparece quando chegam. Onde não há
  // figurinhas (desligadas, papel bloqueado) ou com as sugestões desligadas, nada é pedido.
  const here = useStickersHere(room);
  useEffect(() => {
    if (!emoji || hidden || !here || pref === false) return;
    const st = useStickers.getState().status;
    if (st.org === 'idle' || st.mine === 'idle') void loadStickers('both');
  }, [emoji, hidden, here, pref]);
  useEffect(() => {
    if (anchor) anch.setReference(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  // Texto mudou: a linha fechada com Esc pode voltar.
  useEffect(() => {
    if (dismissed !== null && dismissed !== text) setDismissed(null);
  }, [text, dismissed]);

  useEffect(() => {
    if (!input || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      const first = rowRef.current?.querySelector<HTMLElement>('.sticker-cell[tabindex="0"]') ?? rowRef.current?.querySelector<HTMLElement>('.sticker-cell');
      if (!first) return;
      e.preventDefault();
      first.focus();
    };
    input.addEventListener('keydown', onKey);
    return () => input.removeEventListener('keydown', onKey);
  }, [input, open]);

  if (!open || !sug) return null;
  const width = Math.min(360, anchor?.offsetWidth ?? 360);
  const roving = focusKey && sug.picks.some((p) => p.key === focusKey) ? focusKey : sug.picks[0]?.key;
  const back = () => input?.focus({ preventScroll: true });
  return (
    <Portal>
      <div
        ref={anch.setFloating}
        className="suggestions sticker-suggest"
        role="group"
        aria-label={`Figurinhas para ${sug.emoji}`}
        style={{ ...anch.style, width }}
        data-side={anch.positioned ? anch.side : undefined}
        data-layer={anch.layer}
      >
        <div className="sticker-suggest-head">
          <span>Figurinhas para {sug.emoji}</span>
          <button
            type="button"
            className="icon-btn"
            title="Configurar sugestões"
            aria-label="Configurar sugestões"
            onClick={() => navigate('/account/stickers')}
          >
            <Icon name="sticker-manage" size={14} />
          </button>
        </div>
        <div
          className="sticker-suggest-row"
          ref={rowRef}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(text);
              back();
              return;
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
            const next = nextCell(e, rowRef.current, '.sticker-cell');
            if (next) {
              e.preventDefault();
              next.focus();
              next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
          }}
        >
          {sug.picks.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`sticker-cell${sending.has(p.key) ? ' sending' : ''}`}
              tabIndex={p.key === roving ? 0 : -1}
              title={[p.name, p.emojis.join(' ')].filter(Boolean).join(' ')}
              aria-label={`Enviar figurinha “${p.name}”`}
              aria-busy={sending.has(p.key) || undefined}
              onFocus={() => setFocusKey(p.key)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void send(p, { afterSend: back })}
            >
              <StickerView sticker={pickSticker(p)} size="picker" />
              {sending.has(p.key) && (
                <span className="sticker-cell-veil" aria-hidden="true">
                  <span className="spinner" />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </Portal>
  );
}
