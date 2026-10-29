// Cartão da figurinha: popover junto da figurinha clicada (no celular, folha que sobe de baixo).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@shared/index';
import type { MessageStickerLive, StickerPack } from '@shared/stickers';
import {
  canRemoveEverywhere,
  isComposerOpen,
  isRestrictedForMe,
  openStickerPicker,
  stickersHere,
  useStickerCaps,
  useStickers,
} from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Portal, Sheet, useAnchored, useEscape, useFocusTrap, useIsPhone } from '../overlay';
import { Menu } from '../ui';
import { NewPackDialog, RemoveEverywhereDialog, saveFromMessage, toggleFavorite, useStickerDialog, useStickerOffers } from './StickerMenuItems';
import { StickerView } from './StickerView';

// Camadas que abrem a partir do cartão (menu, diálogo, avisos): um clique nelas não o fecha.
const KEEP_OPEN = '.menu, .modal-backdrop, .sheet-backdrop, .toasts';
const NO_PACKS: StickerPack[] = [];

export function StickerCard({ message, anchor, onClose, onReport }: { message: Message; anchor: HTMLElement | null; onClose: () => void; onReport?: () => void }) {
  const phone = useIsPhone();
  const s = message.sticker;
  const label = s && !s.removed ? `Figurinha “${s.name}”` : 'Figurinha';
  if (!s) return null;
  const body = <StickerCardBody message={message} anchor={anchor} onClose={onClose} onReport={onReport} />;
  if (phone)
    return (
      <Sheet onClose={onClose} className="sticker-card-sheet" label={label}>
        {body}
      </Sheet>
    );
  return (
    <CardPopover anchor={anchor} label={label} onClose={onClose}>
      {body}
    </CardPopover>
  );
}

function CardPopover({ anchor, label, onClose, children }: { anchor: HTMLElement | null; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // No painel do tópico (à direita) o cartão abre para a esquerda; na lista da sala, para a direita.
  const inPanel = !!anchor?.closest('.panel, .thread-panel');
  const anch = useAnchored({ open: true, placement: inPanel ? 'left-start' : 'right-start', gap: 8, minHeight: 200, onHidden: onClose });
  const { setReference, setFloating } = anch;
  useLayoutEffect(() => {
    if (anchor?.isConnected) setReference(anchor);
    else setReference({ getBoundingClientRect: () => new DOMRect(innerWidth / 2 - 160, 72, 0, 0) });
  }, [anchor, setReference]);
  const setPanel = useCallback(
    (n: HTMLDivElement | null) => {
      ref.current = n;
      setFloating(n);
    },
    [setFloating],
  );
  useEscape(true, onClose);
  useFocusTrap(ref, true);
  useEffect(() => {
    if (anch.positioned && ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
  }, [anch.positioned]);
  useEffect(() => {
    const h = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t) || t.closest?.(KEEP_OPEN)) return;
      onClose();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [anchor, onClose]);
  return (
    <Portal>
      <div ref={setPanel} className="sticker-card-pop" role="dialog" aria-label={label} tabIndex={-1} style={anch.style} data-side={anch.positioned ? anch.side : undefined}>
        {children}
      </div>
    </Portal>
  );
}

function StickerCardBody({ message, anchor, onClose, onReport }: { message: Message; anchor: HTMLElement | null; onClose: () => void; onReport?: () => void }) {
  const me = useStore((st) => st.me)!;
  const room = useStore((st) => st.rooms[message.rid]);
  const caps = useStickerCaps();
  const s = message.sticker!;
  const removedHere = useStickers((st) => st.removed.has(s.fileId));
  const fav = useStickers((st) => st.favorites.has(s.fileId));
  const org = useStickers((st) => st.org);
  const minePacks = useStickers((st) => st.mine?.packs ?? NO_PACKS);
  const offers = useStickerOffers();
  const ready = offers.ready;
  const open = useStickerDialog();
  const [saving, setSaving] = useState(false);

  const own = message.u._id === me._id;
  const report = !own && onReport && (
    <button
      type="button"
      className="btn small full"
      onClick={() => {
        onClose();
        onReport();
      }}
    >
      <Icon name="report" size={16} />
      Denunciar
    </button>
  );

  if (s.removed || removedHere)
    return (
      <div className="sticker-card">
        <div className="sticker-card-preview">
          <StickerView sticker={s} size="card" />
        </div>
        {report && <div className="sticker-card-actions">{report}</div>}
      </div>
    );

  const live: MessageStickerLive = s;
  const restricted = ready && isRestrictedForMe(live);
  const offer = ready && !restricted;
  // Tópico aberto no painel: o compositor dele; na lista da sala, o da sala.
  const tmid = anchor?.closest('.thread-panel') ? message.tmid ?? message._id : null;
  const canSeeInPicker =
    ready && live.scope === 'org' && !!live.packId && !!org?.packs.some((p) => p._id === live.packId) && stickersHere(room) && isComposerOpen(message.rid, tmid);

  const save = async (packId?: string) => {
    setSaving(true);
    await saveFromMessage(message, packId);
    setSaving(false);
  };
  const newPack = () =>
    open(
      <NewPackDialog
        scope="personal"
        onClose={() => open(null)}
        onCreated={(pack) => {
          open(null);
          void save(pack._id);
        }}
      />,
    );

  const meta = [live.scope === 'org' ? `Pacote ${live.packName ?? ''}`.trim() : 'Figurinha pessoal', live.animated && 'Animada'].filter(Boolean).join(' · ');
  const saveLabel = (
    <>
      <Icon name="sticker-save" size={16} />
      Salvar nas minhas figurinhas
    </>
  );

  return (
    <div className="sticker-card">
      <div className="sticker-card-preview">
        <StickerView sticker={live} size="card" />
      </div>
      <div className="sticker-card-info">
        <h3 className="sticker-card-name">{live.name}</h3>
        <p className="sticker-card-meta">
          {meta}
          {restricted && (
            <>
              {' · '}
              <span className="sticker-card-restricted">
                <Icon name="sticker-restricted" size={12} />
                Pacote restrito
              </span>
            </>
          )}
        </p>
        {live.emojis.length > 0 && (
          <p className="sticker-card-emojis" aria-label={`Emojis: ${live.emojis.join(' ')}`}>
            {live.emojis.map((e) => (
              <span key={e} aria-hidden="true">
                {e}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="sticker-card-actions">
        {offers.favorite && offer && (
          <button type="button" className="btn small full" onClick={() => toggleFavorite({ messageId: message._id }, !fav)}>
            <Icon name={fav ? 'sticker-unfavorite' : 'sticker-favorite'} size={16} />
            {fav ? 'Remover das figurinhas favoritas' : 'Adicionar às figurinhas favoritas'}
          </button>
        )}
        {offers.save &&
          offer &&
          (minePacks.length <= 1 ? (
            <button type="button" className="btn small full" disabled={saving} aria-busy={saving || undefined} onClick={() => void save()}>
              {saveLabel}
            </button>
          ) : (
            <Menu
              align="left"
              label="Salvar em…"
              sheetTitle="Salvar em…"
              className="sticker-save-menu"
              trigger={
                <button type="button" className="btn small full" disabled={saving}>
                  {saveLabel}
                </button>
              }
            >
              {(close) => (
                <>
                  <div className="menu-label sticker-menu-head" role="presentation">
                    Salvar em…
                  </div>
                  {minePacks.map((p) => (
                    <button
                      key={p._id}
                      type="button"
                      disabled={p.count >= caps.limits.maxPerPack}
                      onClick={() => {
                        close();
                        void save(p._id);
                      }}
                    >
                      <Icon name="sticker-pack" size={16} />
                      <span className="sticker-menu-name">{p.name}</span>
                      <span className="sticker-menu-count">
                        {p.count}/{caps.limits.maxPerPack}
                      </span>
                    </button>
                  ))}
                  <hr />
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      newPack();
                    }}
                  >
                    <Icon name="sticker-pack-new" size={16} />
                    Novo pacote…
                  </button>
                </>
              )}
            </Menu>
          ))}
        {canSeeInPicker && (
          <button
            type="button"
            className="btn small full"
            onClick={() => {
              onClose();
              openStickerPicker(live.packId, { rid: message.rid, tmid });
            }}
          >
            <Icon name="sticker" size={16} />
            Ver no seletor
          </button>
        )}
        {report}
        {canRemoveEverywhere(live) && (
          <>
            <hr />
            <button
              type="button"
              className="btn small full danger"
              onClick={() => {
                onClose();
                open(<RemoveEverywhereDialog target={{ messageId: message._id }} onClose={() => open(null)} />);
              }}
            >
              <Icon name="sticker-remove-all" size={16} />
              Remover de todas as conversas
            </button>
          </>
        )}
      </div>
    </div>
  );
}
