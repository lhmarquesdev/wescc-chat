// Aba Figurinhas do seletor do compositor: busca, barra de pacotes, grade e o menu de cada figurinha.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, Room } from '@shared/index';
import { STICKER_LIMITS, type MessageStickerLive, type StickerPack, type StickerPick } from '@shared/stickers';
import {
  blockedReasonHere,
  canUndoSend,
  loadStickers,
  removeRecent,
  searchStickers,
  sendSticker,
  setStickerPrefs,
  stickerErrorText,
  undoSend,
  useStickerCaps,
  useStickers,
} from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { Portal, useMedia } from '../overlay';
import { Empty, Menu, SearchInput, useDelay } from '../ui';
import { toggleFavorite, useOpenStickerEditor } from './StickerMenuItems';
import { StickerView } from './StickerView';

const toastError = (e: unknown) => useStore.getState().toast(stickerErrorText(e), 'error');

// A figurinha do seletor no formato da mensagem (o StickerView mostra as duas do mesmo jeito).
const asSticker = new WeakMap<StickerPick, MessageStickerLive>();
export function pickSticker(p: StickerPick): MessageStickerLive {
  let s = asSticker.get(p);
  if (!s) {
    s = {
      fileId: p.fileId,
      name: p.name,
      emojis: p.emojis,
      width: p.width,
      height: p.height,
      animated: p.animated,
      durationMs: p.durationMs,
      url: p.url,
      posterUrl: p.posterUrl,
      scope: p.scope,
      stickerId: p.stickerId,
      packId: p.packId,
      packName: p.packName,
    };
    asSticker.set(p, s);
  }
  return s;
}

const coverOf = (pack: StickerPack) => pack.coverUrl ?? pack.stickers[0]?.posterUrl ?? pack.stickers[0]?.url;
const pickTitle = (p: StickerPick) => [p.name, p.emojis.join(' ')].filter(Boolean).join(' ');

interface Group {
  key: string;
  title: string;
  icon?: IconName;
  cover?: string;
  personal?: boolean;
  picks: StickerPick[];
}

// Envio com a proteção do clique duplo e o aviso "Figurinha enviada." com "Desfazer". Usado pelo seletor e pelas sugestões.
export function useStickerSend(opts: { room: Room | null | undefined; tmid?: string | null; tshow?: boolean; quotingId?: string; onSent: (m: Message) => void }) {
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const busy = useRef(new Set<string>());
  const last = useRef(new Map<string, number>());
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const send = useCallback(async (p: StickerPick, o: { keepOpen?: boolean; afterSend?: () => void } = {}) => {
    const { room, tmid, tshow, quotingId, onSent } = optsRef.current;
    if (!room) return;
    const reason = blockedReasonHere(p, room);
    if (reason) return useStore.getState().toast(reason, 'info');
    const now = performance.now();
    // Durante o envio e por 600 ms depois de um clique, outro clique na mesma célula não envia de novo.
    if (busy.current.has(p.key) || now - (last.current.get(p.key) ?? -Infinity) < STICKER_LIMITS.doubleClickMs) return;
    last.current.set(p.key, now);
    busy.current.add(p.key);
    setSending(new Set(busy.current));
    try {
      const m = await sendSticker({ rid: room._id, tmid, tshow, quoteMessageId: quotingId, stickerId: p.stickerId, fileId: p.fileId });
      onSent(m);
      o.afterSend?.();
      if (!o.keepOpen)
        useStore.getState().toast('Figurinha enviada.', 'success', {
          duration: 5000,
          action: canUndoSend() ? { label: 'Desfazer', onClick: () => void undoSend(m).catch(toastError) } : undefined,
        });
    } catch (e) {
      toastError(e);
    } finally {
      busy.current.delete(p.key);
      setSending(new Set(busy.current));
    }
  }, []);
  return { send, sending };
}

// Setas pela posição na tela: as seções têm números diferentes de itens.
export function nextCell(e: ReactKeyboardEvent, root: HTMLElement | null, selector: string): HTMLElement | null {
  const cur = (e.target as HTMLElement).closest<HTMLElement>(selector);
  if (!root || !cur) return null;
  const all = [...root.querySelectorAll<HTMLElement>(selector)];
  const i = all.indexOf(cur);
  if (e.key === 'Home') return all[0] ?? null;
  if (e.key === 'End') return all[all.length - 1] ?? null;
  if (e.key === 'ArrowLeft') return all[i - 1] ?? null;
  if (e.key === 'ArrowRight') return all[i + 1] ?? null;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return null;
  const r = cur.getBoundingClientRect();
  const down = e.key === 'ArrowDown';
  const rows = all.filter((b) => {
    const t = b.getBoundingClientRect().top;
    return down ? t > r.top + 4 : t < r.top - 4;
  });
  if (!rows.length) return null;
  const tops = rows.map((b) => b.getBoundingClientRect().top);
  const edge = down ? Math.min(...tops) : Math.max(...tops);
  const row = rows.filter((b) => Math.abs(b.getBoundingClientRect().top - edge) < 4);
  return row.reduce((best, b) => (Math.abs(b.getBoundingClientRect().left - r.left) < Math.abs(best.getBoundingClientRect().left - r.left) ? b : best));
}

export function StickerPicker({
  room,
  tmid,
  tshow,
  quotingId,
  phone,
  packId,
  autoFocus,
  onSent,
  onClose,
  onSentClose,
}: {
  room: Room;
  tmid?: string | null;
  tshow?: boolean;
  quotingId?: string;
  phone: boolean;
  packId?: string; // "Ver no seletor": abre rolado até este pacote
  autoFocus?: boolean;
  onSent: (m: Message) => void;
  onClose: () => void;
  onSentClose?: () => void; // fechar depois de um envio (o foco volta ao compositor); sem ele, onClose
}) {
  const navigate = useNavigate();
  const caps = useStickerCaps();
  const sections = useStickers((s) => s.sections);
  const status = useStickers((s) => s.status);
  const favorites = useStickers((s) => s.favorites);
  const hintSeen = useStore((s) => !!s.me?.preferences?.stickerHintSeen);
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const showSkeleton = useDelay(250);
  const openEditor = useOpenStickerEditor();
  const searchId = useId();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const packsRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [packFocus, setPackFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ pick: StickerPick; cell: HTMLElement; rect: DOMRect; inRecents: boolean } | null>(null);
  const menuKey = useRef<string | null>(null);
  const lockUntil = useRef(0);
  const pendingGo = useRef<string | null>(null);
  const press = useRef<{ key: string; x: number; y: number; top: number; timer: number; fired: boolean; moved: boolean } | null>(null);
  const touchAt = useRef(0);
  const swallowTouchEnd = useRef(false);
  const { send, sending } = useStickerSend({ room, tmid, tshow, quotingId, onSent });

  useEffect(() => {
    void loadStickers('both');
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), 120);
    return () => clearTimeout(t);
  }, [term]);

  // O painel fica invisível até ser posicionado: o foco na busca tenta de novo a cada quadro.
  useEffect(() => {
    if (!autoFocus) return;
    let tries = 0;
    let id = 0;
    const go = () => {
      const el = document.getElementById(searchId);
      el?.focus({ preventScroll: true });
      if (el && document.activeElement !== el && tries++ < 10) id = requestAnimationFrame(go);
    };
    go();
    return () => cancelAnimationFrame(id);
  }, [autoFocus, searchId]);

  const groups: Group[] = useMemo(() => {
    if (q) return [{ key: 'results', title: 'Resultados', picks: searchStickers(q) }];
    const g: Group[] = [];
    if (sections.favorites.length) g.push({ key: 'fav', title: 'Favoritas', icon: 'sticker-favorite', picks: sections.favorites });
    if (sections.recents.length) g.push({ key: 'rec', title: 'Recentes', icon: 'sticker-recent', picks: sections.recents });
    for (const { pack, picks } of sections.org) g.push({ key: `org:${pack._id}`, title: pack.name, cover: coverOf(pack), picks });
    for (const { pack, picks } of sections.personal) g.push({ key: `mine:${pack._id}`, title: pack.name, cover: coverOf(pack), personal: true, picks });
    return g;
  }, [sections, q]);
  const tabs = useMemo(() => {
    const g: Group[] = [];
    if (sections.favorites.length) g.push({ key: 'fav', title: 'Favoritas', icon: 'sticker-favorite', picks: [] });
    if (sections.recents.length) g.push({ key: 'rec', title: 'Recentes', icon: 'sticker-recent', picks: [] });
    for (const { pack } of sections.org) g.push({ key: `org:${pack._id}`, title: pack.name, cover: coverOf(pack), picks: [] });
    for (const { pack } of sections.personal) g.push({ key: `mine:${pack._id}`, title: pack.name, cover: coverOf(pack), personal: true, picks: [] });
    return g;
  }, [sections]);
  const byKey = useMemo(() => new Map(groups.flatMap((g) => g.picks.map((p) => [p.key, { pick: p, group: g.key }] as const))), [groups]);
  const total = byKey.size;
  const firstKey = groups[0]?.picks[0]?.key ?? null;
  const rovingKey = focusKey && byKey.has(focusKey) ? focusKey : firstKey;
  const activeKey = active && tabs.some((t) => t.key === active) ? active : (tabs[0]?.key ?? '');

  const goTo = useCallback(
    (key: string, smooth = true) => {
      setActive(key);
      const el = grid?.querySelector<HTMLElement>(`.sticker-section[data-key="${CSS.escape(key)}"]`);
      if (grid && el) {
        lockUntil.current = performance.now() + 600;
        grid.scrollTo({ top: el.offsetTop, behavior: smooth && !reduced ? 'smooth' : 'auto' });
      }
      packsRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    [grid, reduced],
  );

  // "Ver no seletor": rola até o pacote assim que a grade e o catálogo estiverem prontos.
  const wentTo = useRef<string | null>(null);
  useEffect(() => {
    if (!packId || !grid || wentTo.current === packId) return;
    const key = tabs.find((t) => t.key === `org:${packId}` || t.key === `mine:${packId}`)?.key;
    if (!key) return;
    wentTo.current = packId;
    requestAnimationFrame(() => goTo(key, false));
  }, [packId, grid, tabs, goTo]);

  // Clique num pacote durante a busca: limpa a busca e rola quando a grade normal voltar.
  useEffect(() => {
    if (q || !pendingGo.current) return;
    const key = pendingGo.current;
    pendingGo.current = null;
    requestAnimationFrame(() => goTo(key, false));
  }, [q, goTo]);

  const onScroll = () => {
    if (!grid || q || performance.now() < lockUntil.current) return;
    let cur: string | undefined = tabs[0]?.key;
    for (const el of grid.querySelectorAll<HTMLElement>('.sticker-section')) if (el.offsetTop <= grid.scrollTop + 8) cur = el.dataset.key;
    if (cur && cur !== active) {
      setActive(cur);
      packsRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(cur)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const openMenu = (pick: StickerPick, cell: HTMLElement) => {
    if (menuKey.current === pick.key) return;
    menuKey.current = pick.key;
    setMenu({ pick, cell, rect: cell.getBoundingClientRect(), inRecents: byKey.get(pick.key)?.group === 'rec' });
  };
  const closeMenu = useCallback(() => {
    const m = menu;
    menuKey.current = null;
    setMenu(null);
    const a = document.activeElement;
    if (m?.cell.isConnected && (!a || a === document.body || a.closest('.sticker-menu-anchor'))) requestAnimationFrame(() => m.cell.focus({ preventScroll: true }));
  }, [menu]);

  const editor = (props: Parameters<typeof openEditor>[0]) => {
    onClose();
    openEditor(props);
  };
  const create = () => editor({ room: { rid: room._id, tmid, tshow } });
  const manage = () => {
    onClose();
    navigate('/account/stickers');
  };

  const pickOf = (el: HTMLElement | null) => (el?.dataset.key ? byKey.get(el.dataset.key)?.pick : undefined);
  const sendPick = (p: StickerPick, keepOpen: boolean) =>
    void send(p, {
      keepOpen,
      afterSend: () => {
        if (!useStore.getState().me?.preferences?.stickerHintSeen) void setStickerPrefs({ stickerHintSeen: true }).catch(() => undefined);
        if (!keepOpen) (onSentClose ?? onClose)();
      },
    });

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.sticker-cell');
    const p = pickOf(cell);
    if (!cell || !p) return;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      return openMenu(p, cell);
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) sendPick(p, e.shiftKey);
      return;
    }
    const next = nextCell(e, grid, '.sticker-cell');
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  // Toque: envia ao soltar se o dedo quase não andou e a grade não rolou; segurar 450 ms abre o menu.
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, p: StickerPick) => {
    if (e.pointerType === 'mouse') return;
    const cell = e.currentTarget;
    const timer = window.setTimeout(() => {
      const pr = press.current;
      if (!pr || pr.key !== p.key) return;
      pr.fired = true;
      navigator.vibrate?.(10);
      openMenu(p, cell);
    }, 450);
    press.current = { key: p.key, x: e.clientX, y: e.clientY, top: grid?.scrollTop ?? 0, timer, fired: false, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const pr = press.current;
    if (pr && !pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) >= 10) {
      pr.moved = true;
      clearTimeout(pr.timer);
    }
  };
  const onPointerUp = (e: ReactPointerEvent, p: StickerPick) => {
    const pr = press.current;
    press.current = null;
    if (!pr || e.pointerType === 'mouse') return;
    clearTimeout(pr.timer);
    touchAt.current = performance.now();
    // O menu do toque longo já abriu: o mousedown de compatibilidade que viria depois do touchend cairia no fundo da folha
    // do menu e a fecharia. O touchend logo abaixo cancela esses eventos.
    if (pr.fired) swallowTouchEnd.current = true;
    if (pr.fired || pr.moved || Math.abs((grid?.scrollTop ?? 0) - pr.top) > 2) return;
    sendPick(p, false);
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    if (!swallowTouchEnd.current) return;
    swallowTouchEnd.current = false;
    if (e.cancelable) e.preventDefault();
  };
  const onPointerCancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const cell = (p: StickerPick) => {
    const blocked = blockedReasonHere(p, room);
    const isSending = sending.has(p.key);
    // Com o menu da figurinha aberto, a célula fica marcada: dá para ver sobre qual o menu age.
    const menuOpen = menu?.pick.key === p.key;
    return (
      <button
        key={p.key}
        type="button"
        className={`sticker-cell${blocked ? ' blocked' : ''}${isSending ? ' sending' : ''}${menuOpen ? ' menu-open' : ''}`}
        data-key={p.key}
        tabIndex={p.key === rovingKey ? 0 : -1}
        title={blocked ?? pickTitle(p)}
        aria-label={`Enviar figurinha “${p.name}”`}
        aria-disabled={blocked ? 'true' : undefined}
        aria-busy={isSending || undefined}
        onFocus={() => setFocusKey(p.key)}
        onClick={(e) => {
          // O toque já enviou no pointerup; o clique que vem atrás é o mesmo gesto.
          if (performance.now() - touchAt.current < 700) return;
          sendPick(p, e.shiftKey);
        }}
        onPointerDown={(e) => onPointerDown(e, p)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e, p)}
        onPointerCancel={onPointerCancel}
        onTouchEnd={onTouchEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!press.current?.fired) openMenu(p, e.currentTarget);
        }}
      >
        <StickerView sticker={pickSticker(p)} size="picker" lazyRoot={grid} />
        {isSending && (
          <span className="sticker-cell-veil" aria-hidden="true">
            <span className="spinner" />
          </span>
        )}
      </button>
    );
  };

  const anyLoading = status.org === 'loading' || status.mine === 'loading' || status.org === 'idle' || status.mine === 'idle';
  const anyError = status.org === 'error' || status.mine === 'error';
  let body;
  if (q && !total)
    body = (
      <Empty icon="search" title={`Nada encontrado para “${q}”`}>
        Busque pelo nome, por uma palavra-chave ou por um emoji.
      </Empty>
    );
  else if (!total && anyLoading)
    body = (
      <div className="sticker-items" role="status" aria-label="Carregando" aria-busy="true">
        {showSkeleton && Array.from({ length: 12 }, (_, i) => <span key={i} className="skeleton sticker-cell-skeleton" aria-hidden="true" />)}
      </div>
    );
  else if (!total && anyError)
    body = (
      <Empty
        icon="error"
        tone="danger"
        title="Não foi possível carregar as figurinhas"
        action={
          <button type="button" className="btn" onClick={() => void loadStickers('both', { force: true })}>
            Tentar de novo
          </button>
        }
      />
    );
  else if (!total)
    body = caps.canAuthor ? (
      <Empty
        icon="sticker"
        title="Nenhuma figurinha ainda"
        action={
          <button type="button" className="btn primary" onClick={create}>
            Criar figurinha
          </button>
        }
      >
        Crie figurinhas a partir de imagens ou salve as que receber nas conversas.
      </Empty>
    ) : (
      <Empty icon="sticker" title="Nenhuma figurinha disponível">
        Quando a organização publicar figurinhas, elas aparecem aqui. Você também pode favoritar as que receber nas conversas.
      </Empty>
    );
  else
    body = groups.map((g) => (
      <section key={g.key} className="sticker-section" data-key={g.key} aria-label={g.title}>
        <div className="sticker-section-title">
          <span className="sticker-section-name">{g.title}</span>
          {g.personal && (
            <span className="sticker-section-lock" role="img" title="Só você vê este pacote" aria-label="Só você vê este pacote">
              <Icon name="sticker-restricted" size={12} />
            </span>
          )}
        </div>
        <div className="sticker-items">{g.picks.map(cell)}</div>
      </section>
    ));

  const personalStart = tabs.findIndex((t) => t.personal);
  const rovingPack = packFocus && tabs.some((t) => t.key === packFocus) ? packFocus : activeKey;
  const onPacksKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const btns = [...e.currentTarget.querySelectorAll<HTMLElement>('.sticker-pack-btn')];
    const i = btns.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = btns[Math.max(0, Math.min(btns.length - 1, to))];
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  return (
    <div className="sticker-picker">
      <div
        className="sticker-search"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || !grid) return;
          const target = grid.querySelector<HTMLElement>('.sticker-cell[tabindex="0"]') ?? grid.querySelector<HTMLElement>('.sticker-cell');
          if (!target) return;
          e.preventDefault();
          target.focus();
        }}
      >
        <label htmlFor={searchId} className="visually-hidden">
          Buscar figurinhas
        </label>
        <SearchInput id={searchId} value={term} onChange={setTerm} placeholder="Buscar figurinhas" />
      </div>
      <div
        className="sticker-packs"
        ref={packsRef}
        onWheel={(e) => {
          // A roda do mouse rola a barra para o lado.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {/* Barra de ferramentas com foco itinerante: um Tab entra, as setas andam, Enter rola a grade até o pacote. */}
        <div
          className="sticker-pack-tabs"
          role="toolbar"
          aria-label="Pacotes"
          onKeyDown={onPacksKey}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPackFocus(null)}
        >
          {tabs.map((t, i) => {
            const current = !q && t.key === activeKey;
            return (
              <span key={t.key} className="sticker-pack-slot">
                {i === personalStart && i > 0 && <span className="sticker-pack-sep" aria-hidden="true" />}
                <button
                  type="button"
                  data-key={t.key}
                  tabIndex={t.key === rovingPack ? 0 : -1}
                  aria-current={current ? 'true' : undefined}
                  className={current ? 'sticker-pack-btn active' : 'sticker-pack-btn'}
                  title={t.title}
                  aria-label={t.title}
                  onFocus={() => setPackFocus(t.key)}
                  onClick={() => {
                    if (q) {
                      pendingGo.current = t.key;
                      setTerm('');
                      setQ('');
                    } else goTo(t.key);
                  }}
                >
                  {t.icon ? <Icon name={t.icon} size={18} /> : t.cover ? <img src={t.cover} alt="" width={24} height={24} loading="lazy" decoding="async" /> : <Icon name="sticker-pack" size={18} />}
                </button>
              </span>
            );
          })}
        </div>
        <span className="spacer" />
        {caps.canAuthor && (
          <button type="button" className="sticker-pack-btn" title="Criar figurinha" aria-label="Criar figurinha" onClick={create}>
            <Icon name="sticker-create" size={18} />
          </button>
        )}
        <button type="button" className="sticker-pack-btn" title="Gerenciar figurinhas" aria-label="Gerenciar figurinhas" onClick={manage}>
          <Icon name="sticker-manage" size={18} />
        </button>
      </div>
      <div className="sticker-grid" ref={setGrid} onScroll={onScroll} onKeyDown={onGridKey} onKeyUp={(e) => e.key === ' ' && e.preventDefault()}>
        {body}
      </div>
      {!hintSeen && total > 0 && (
        <div className="sticker-hint">{phone ? 'Toque para enviar · Toque e segure para mais opções' : 'Clique para enviar · Shift+clique envia e mantém aberto'}</div>
      )}
      {menu && (
        <ItemMenu
          key={menu.pick.key}
          pick={menu.pick}
          rect={menu.rect}
          favorite={favorites.has(menu.pick.fileId)}
          inRecents={menu.inRecents}
          onDone={closeMenu}
          onEdit={() => editor({ source: { kind: 'sticker', sticker: menu.pick } })}
        />
      )}
    </div>
  );
}

// O menu da figurinha (botão direito, toque longo, Shift+F10): o Menu do DS aberto sobre a célula.
function ItemMenu({
  pick,
  rect,
  favorite,
  inRecents,
  onDone,
  onEdit,
}: {
  pick: StickerPick;
  rect: DOMRect;
  favorite: boolean;
  inRecents: boolean;
  onDone: () => void;
  onEdit: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    // No StrictMode o efeito roda duas vezes: o segundo clique não pode abrir de novo.
    if (!opened.current) trigger.current?.click();
  }, []);
  return (
    <Portal>
      <div className="sticker-menu-anchor" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        <Menu
          align="left"
          label="Ações da figurinha"
          sheetTitle={pick.name}
          onOpenChange={(open) => {
            if (open) opened.current = true;
            else if (opened.current) onDone();
          }}
          trigger={<button ref={trigger} type="button" className="sticker-menu-trigger" tabIndex={-1} aria-label={`Ações da figurinha “${pick.name}”`} />}
        >
          {(close) => (
            <>
              <button
                type="button"
                onClick={() => {
                  close();
                  toggleFavorite(pick.stickerId ? { stickerId: pick.stickerId } : { fileId: pick.fileId }, !favorite);
                }}
              >
                <Icon name={favorite ? 'sticker-unfavorite' : 'sticker-favorite'} size={16} />
                {favorite ? 'Remover das figurinhas favoritas' : 'Adicionar às figurinhas favoritas'}
              </button>
              {inRecents && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    removeRecent(pick.fileId).catch(toastError);
                  }}
                >
                  <Icon name="close" size={16} />
                  Remover dos recentes
                </button>
              )}
              {pick.editable && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onEdit();
                  }}
                >
                  <Icon name="edit" size={16} />
                  Editar figurinha
                </button>
              )}
            </>
          )}
        </Menu>
      </div>
    </Portal>
  );
}
