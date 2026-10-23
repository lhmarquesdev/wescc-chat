// Camadas flutuantes: raiz do portal, posicionamento ancorado, pilha do Esc, foco preso, trava de rolagem e folha (celular).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, flip, hide, offset, shift, size, useFloating, type Placement, type ReferenceType } from '@floating-ui/react-dom';

export type { Placement } from '@floating-ui/react-dom';

// Raiz única no fim do <body>: nada herda cor, overflow ou transform de quem abriu (barra lateral, gaveta, lista de mensagens).
export function overlayRoot(): HTMLElement {
  let el = document.getElementById('overlay-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'overlay-root';
    document.body.appendChild(el);
  }
  return el;
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, overlayRoot());
}

// ---------- Mídia ----------

export const PHONE_QUERY = '(max-width: 760px)';

export function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export const useIsPhone = () => useMedia(PHONE_QUERY);

// ---------- Esc: só a camada de cima fecha ----------

const layers: { escape: () => void }[] = [];

function onEscapeKey(e: KeyboardEvent) {
  // Quem tratou o Esc antes (a lista de um campo dentro do modal) chama preventDefault ou para a propagação.
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length) return;
  e.preventDefault();
  layers[layers.length - 1].escape();
}

export function useEscape(active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  useLayoutEffect(() => {
    cb.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const layer = { escape: () => cb.current() };
    layers.push(layer);
    if (layers.length === 1) document.addEventListener('keydown', onEscapeKey);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      if (!layers.length) document.removeEventListener('keydown', onEscapeKey);
    };
  }, [active]);
}

// ---------- Foco ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

const traps: HTMLElement[] = [];

// Prende o Tab no contêiner, foca o primeiro campo (ou o próprio contêiner) e devolve o foco a quem abriu.
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, initial?: string) {
  // Quem abriu é lido no primeiro render: um autoFocus dos filhos move o foco antes de qualquer efeito.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  const first = useRef(true);
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const prev = first.current && opener && !root.contains(opener) ? opener : (document.activeElement as HTMLElement | null);
    first.current = false;
    traps.push(root);
    if (!root.contains(document.activeElement)) {
      const first = (initial && root.querySelector<HTMLElement>(initial)) || null;
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || traps[traps.length - 1] !== root) return;
      const list = focusables(root);
      if (!list.length) return e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && (i === list.length - 1 || i < 0)) {
        e.preventDefault();
        list[0].focus();
      }
    };
    // O foco pode ir para outra camada (menu aberto dentro do modal), nunca para a página atrás.
    const onFocusIn = (e: FocusEvent) => {
      if (traps[traps.length - 1] !== root) return;
      const t = e.target as Node;
      if (!root.contains(t) && !overlayRoot().contains(t)) root.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      const i = traps.indexOf(root);
      if (i >= 0) traps.splice(i, 1);
      if (prev && prev.isConnected && (!document.activeElement || document.activeElement === document.body || root.contains(document.activeElement)))
        prev.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

// ---------- Rolagem da página ----------

let scrollLocks = 0;

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (scrollLocks++ === 0) document.body.style.overflow = 'hidden';
    return () => {
      if (--scrollLocks === 0) document.body.style.overflow = '';
    };
  }, [active]);
}

// ---------- Posicionamento ancorado (menus, popovers, seletores) ----------

const ORIGIN: Record<string, string> = {
  'bottom-start': 'top left',
  'bottom-end': 'top right',
  bottom: 'top center',
  'top-start': 'bottom left',
  'top-end': 'bottom right',
  top: 'bottom center',
  'right-start': 'top left',
  'left-start': 'top right',
  right: 'center left',
  left: 'center right',
};

const hasBox = (el: ReferenceType) => !(el instanceof Element) || el.getClientRects().length > 0;

// Fica a 4px da âncora, vira para cima quando falta espaço, encosta a 8px das bordas e rola quando não cabe.
// Se a âncora some de vista por rolagem, chama onHidden. Se ela deixa de ser desenhada (barra da mensagem
// escondida quando o mouse vai para o menu), a posição fica onde estava.
export function useAnchored({
  open,
  placement = 'bottom-start',
  gap = 4,
  matchWidth,
  minHeight = 120,
  onHidden,
}: {
  open: boolean;
  placement?: Placement;
  gap?: number;
  matchWidth?: boolean;
  minHeight?: number;
  onHidden?: () => void;
}) {
  const f = useFloating({
    open,
    placement,
    strategy: 'fixed',
    transform: false, // a animação de entrada usa transform; a posição vai em top/left
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, () => {
        if (hasBox(reference)) update();
      }),
    middleware: [
      offset(gap),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.maxHeight = `${Math.max(minHeight, Math.floor(availableHeight))}px`;
          if (matchWidth) elements.floating.style.width = `${Math.round(rects.reference.width)}px`;
        },
      }),
      hide(),
    ],
  });
  const hidden = !!f.middlewareData.hide?.referenceHidden;
  const hiddenCb = useRef(onHidden);
  useLayoutEffect(() => {
    hiddenCb.current = onHidden;
  });
  useEffect(() => {
    const r = f.elements.reference;
    if (open && hidden && r && hasBox(r)) hiddenCb.current?.();
  }, [open, hidden, f.elements.reference]);
  const ref = f.elements.reference;
  // Aberto de dentro de um modal ou folha: a camada sobe acima dele (data-layer="modal").
  const layer = ref instanceof Element && ref.closest('.modal, .sheet') ? ('modal' as const) : undefined;
  const style: CSSProperties = {
    ...f.floatingStyles,
    transformOrigin: ORIGIN[f.placement] ?? 'top left',
    visibility: f.isPositioned ? undefined : 'hidden',
  };
  return {
    setReference: f.refs.setReference,
    setFloating: f.refs.setFloating,
    style,
    placement: f.placement,
    side: f.placement.split('-')[0] as 'top' | 'bottom' | 'left' | 'right',
    positioned: f.isPositioned,
    layer,
    update: f.update,
  };
}

// ---------- Folha (celular): arrastar para baixo fecha ----------

// Fecha quando o arrasto passa de 30% da altura ou é mais rápido que 0,5 px/ms. Só começa no puxador
// ou com o conteúdo no topo, para não brigar com a rolagem de dentro.
export function useSheetDrag(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const cb = useRef(onClose);
  useLayoutEffect(() => {
    cb.current = onClose;
  });
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let startY = 0;
    let startT = 0;
    let dy = 0;
    let dragging = false;
    const scroller = () => el.querySelector<HTMLElement>('.sheet-scroll, .modal-body') ?? el;
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target as HTMLElement;
      const onHandle = !!t.closest('.sheet-handle, .modal-head');
      if (!onHandle && (scroller().scrollTop > 0 || t.closest('input, textarea, select, [contenteditable="true"]'))) return;
      dragging = true;
      startY = e.clientY;
      startT = performance.now();
      dy = 0;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      if (dy > 4) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
      }
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      const v = dy / Math.max(1, performance.now() - startT);
      el.style.transition = '';
      if (dy > el.offsetHeight * 0.3 || (dy > 24 && v > 0.5)) {
        el.style.transform = 'translateY(100%)';
        cb.current();
      } else el.style.transform = '';
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [enabled, ref]);
}

// Folha que sobe de baixo, com fundo escurecido, puxador, Esc e foco preso. Usada pelo Menu e pelo Modal
// no celular; os donos podem usá-la para o cartão do usuário e o seletor de emoji.
export function Sheet({
  onClose,
  children,
  className,
  label,
  role = 'dialog',
  handle = true,
  initialFocus,
  onKeyDown,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  role?: string;
  handle?: boolean;
  initialFocus?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  useFocusTrap(ref, true, initialFocus);
  useScrollLock(true);
  useSheetDrag(ref, onClose);
  return (
    <Portal>
      <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} className={className ? `sheet ${className}` : 'sheet'} role={role} aria-modal={role === 'dialog' ? true : undefined} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
          {handle && <div className="sheet-handle" aria-hidden="true" />}
          {children}
        </div>
      </div>
    </Portal>
  );
}
