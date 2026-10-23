import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createRoot } from 'react-dom/client';
import { avatarBust, useStore, type ToastItem } from '../lib/store';
import { STATUS_LABEL } from '../lib/format';
import { Icon, type IconName } from './Icon';
import { Portal, Sheet, focusables, useAnchored, useEscape, useFocusTrap, useIsPhone, useScrollLock, useSheetDrag, type Placement } from './overlay';

export { Portal } from './overlay';

// ---------- Presença (saída animada) ----------

// Mantém o nó montado por `ms` depois de fechar, com data-state="closed", para a animação de saída.
export function usePresence(open: boolean, ms: number) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, state: open ? ('open' as const) : ('closed' as const) };
}

// Atraso para estados de carregamento: carregamentos rápidos não piscam.
export function useDelay(ms = 250) {
  const [ready, setReady] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => setReady(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return ready;
}

// ---------- Avatares e presença ----------

export function Avatar({ username, size = 32, rid, etag }: { username?: string; size?: number; rid?: string; etag?: string | null }) {
  const bust = username ? avatarBust[username] ?? etag ?? '' : etag ?? '';
  const src = rid ? `/avatar/room/${rid}?v=${bust}` : `/avatar/${encodeURIComponent(username ?? '')}?v=${bust}`;
  const ref = useRef<HTMLImageElement>(null);
  // Imagem que já veio do cache aparece direto; a que ainda carrega entra com um fade curto.
  useLayoutEffect(() => {
    const img = ref.current;
    if (img && img.complete && !img.dataset.loaded) img.dataset.loaded = 'cache';
  }, [src]);
  const loaded = (e: { currentTarget: HTMLImageElement }) => {
    if (!e.currentTarget.dataset.loaded) e.currentTarget.dataset.loaded = 'fade';
  };
  return (
    <img
      ref={ref}
      className={rid ? 'avatar room' : 'avatar'}
      src={src}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      alt=""
      loading="lazy"
      onLoad={loaded}
      onError={loaded}
    />
  );
}

export function StatusDot({ username, status }: { username?: string; status?: string }) {
  const live = useStore((s) => (username ? s.presence[username]?.status : undefined));
  const st = live ?? status ?? 'offline';
  const label = STATUS_LABEL[st] ?? st;
  return <span className={`status-dot ${st}`} title={label} role="img" aria-label={label} />;
}

// Tamanho do ponto de presença pelo tamanho do avatar (8 / 10 / 12 / 16 px).
function dotSize(size: number) {
  if (size <= 24) return 8;
  if (size <= 40) return 10;
  if (size <= 64) return 12;
  return 16;
}

export function UserAvatar({ username, size = 32, status }: { username: string; size?: number; status?: string }) {
  const style = { width: size, height: size, '--dot': `${dotSize(size)}px` } as CSSProperties;
  return (
    <span className="avatar-wrap" style={style} data-big={size >= 96 ? '' : undefined}>
      <Avatar username={username} size={size} />
      <StatusDot username={username} status={status} />
    </span>
  );
}

// DM em grupo: dois avatares sobrepostos (as duas primeiras pessoas além de quem vê), no lugar de um ícone genérico.
export function GroupAvatar({ usernames, size = 32 }: { usernames: string[]; size?: number }) {
  const me = useStore((s) => s.me?.username);
  const [a, b] = usernames.filter((u) => u !== me);
  const inner = Math.round(size * 0.68);
  return (
    <span className="avatar-pair" style={{ width: size, height: size }} aria-hidden="true">
      <Avatar username={a ?? me} size={inner} />
      {b && <Avatar username={b} size={inner} />}
    </span>
  );
}

// ---------- Modal e folhas ----------

const TEXT_FIELD = ':is(input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="file"], [type="range"]), textarea, select)';
const FIRST_FIELD = `.modal-body ${TEXT_FIELD}:not([disabled], [readonly])`;

export type ModalVariant = 'dialog' | 'sheet' | 'fullscreen';

// Desktop: diálogo central. Celular: folha que sobe de baixo, ou tela cheia para formulários (wide ou variant="fullscreen").
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  size,
  variant,
  description,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  size?: 'sm' | 'lg';
  variant?: ModalVariant;
  description?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const phone = useIsPhone();
  // No celular, formulário (campo de texto no corpo) abre em tela cheia; confirmações e listas, em folha.
  const [hasForm, setHasForm] = useState(false);
  useLayoutEffect(() => {
    if (phone && !variant) setHasForm(!!ref.current?.querySelector(`.modal-body ${TEXT_FIELD}`));
  }, [phone, variant]);
  const kind: ModalVariant = phone ? (variant && variant !== 'dialog' ? variant : wide || hasForm ? 'fullscreen' : 'sheet') : 'dialog';
  useEscape(true, onClose);
  useFocusTrap(ref, true, FIRST_FIELD);
  useScrollLock(true);
  useSheetDrag(ref, onClose, kind === 'sheet');
  const cls = ['modal', wide && 'wide', size, kind !== 'dialog' && kind, className].filter(Boolean).join(' ');
  const headAction = useHeadAction(kind === 'fullscreen', footRef);
  const bodyRef = useFootDivider(footRef, !!footer);
  return (
    <Portal>
      <div className="modal-backdrop" data-kind={kind} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} className={cls} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-head-action={headAction ? '' : undefined}>
          {kind === 'sheet' && <div className="sheet-handle" aria-hidden="true" />}
          <div className="modal-head">
            <div className="modal-titles">
              <h2 id={titleId}>{title}</h2>
              {description && kind !== 'fullscreen' && <p className="modal-desc">{description}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
              <Icon name="close" size={18} />
            </button>
            {headAction && (
              <button type="button" className="modal-head-action" disabled={headAction.disabled} onClick={headAction.run}>
                {headAction.label}
              </button>
            )}
          </div>
          <div className="modal-body" ref={bodyRef}>
            {/* Tela cheia: a barra de 56px tem só o título; a explicação abre o corpo. */}
            {description && kind === 'fullscreen' && <p className="modal-desc modal-body-desc">{description}</p>}
            {children}
          </div>
          {footer && (
            <div className="modal-foot" ref={footRef}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

// Linha acima do rodapé só enquanto há conteúdo do corpo escondido abaixo dele (sem rolagem, nada de linha).
function useFootDivider(footRef: RefObject<HTMLDivElement | null>, hasFoot: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const foot = footRef.current;
    if (!body || !foot) return;
    const sync = () => foot.toggleAttribute('data-divided', body.scrollHeight - body.scrollTop - body.clientHeight > 1);
    sync();
    body.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    // Conteúdo que chega depois (sessões, listas carregadas) muda a altura sem mudar o tamanho do corpo.
    const mo = new MutationObserver(sync);
    mo.observe(body, { childList: true, subtree: true });
    return () => {
      body.removeEventListener('scroll', sync);
      ro.disconnect();
      mo.disconnect();
    };
  }, [footRef, hasFoot]);
  return bodyRef;
}

// Tela cheia no celular (§9.9): a ação principal do rodapé vira um botão de texto na barra do topo, e o Cancelar do
// rodapé sai (o X já cancela). O botão do rodapé continua lá, escondido, e é ele que o botão do topo aciona: o
// formulário, o estado desabilitado e o texto ("Salvando…") seguem os de cada modal. O rodapé só fica visível
// quando sobra outra ação (Excluir, Limpar).
function useHeadAction(on: boolean, footRef: RefObject<HTMLDivElement | null>) {
  const [action, setAction] = useState<{ label: string; disabled: boolean; run: () => void } | null>(null);
  useLayoutEffect(() => {
    const foot = footRef.current;
    if (!on || !foot) {
      setAction(null);
      return;
    }
    const sync = () => {
      const buttons = [...foot.querySelectorAll<HTMLButtonElement>('button')];
      const primary = buttons.filter((b) => b.classList.contains('primary')).pop();
      for (const b of buttons) b.toggleAttribute('data-in-head', b === primary || (!!primary && b.textContent?.trim() === 'Cancelar'));
      foot.toggleAttribute('data-empty', buttons.every((b) => b.hasAttribute('data-in-head')));
      const label = primary?.textContent?.trim() ?? '';
      const disabled = !!primary?.disabled;
      setAction((cur) => (!primary ? null : cur && cur.label === label && cur.disabled === disabled ? cur : { label, disabled, run: () => primary.click() }));
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(foot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'class'] });
    return () => mo.disconnect();
  }, [on, footRef]);
  return action;
}

// ---------- Confirmação ----------

type ConfirmRequest = { title: ReactNode; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void };

let confirmQueue: ConfirmRequest[] = [];
let confirmListener: (() => void) | null = null;

function ConfirmHost() {
  const [, render] = useState(0);
  useEffect(() => {
    confirmListener = () => render((n) => n + 1);
    return () => {
      confirmListener = null;
    };
  }, []);
  const req = confirmQueue[0];
  if (!req) return null;
  const done = (ok: boolean) => {
    confirmQueue = confirmQueue.slice(1);
    req.resolve(ok);
    render((n) => n + 1);
  };
  return <ConfirmDialog key={confirmQueue.length} req={req} onDone={done} />;
}

function ConfirmDialog({ req, onDone }: { req: ConfirmRequest; onDone: (ok: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Ação destrutiva começa no Cancelar: Enter sem pensar não apaga nada.
  useEffect(() => {
    (req.danger ? cancelRef : okRef).current?.focus({ preventScroll: true });
  }, [req.danger]);
  return (
    <Modal
      size="sm"
      title={req.title}
      onClose={() => onDone(false)}
      className="confirm"
      footer={
        <>
          <button type="button" ref={cancelRef} className="btn" onClick={() => onDone(false)}>
            {req.cancelLabel ?? 'Cancelar'}
          </button>
          <button type="button" ref={okRef} className={req.danger ? 'btn danger solid' : 'btn primary'} onClick={() => onDone(true)}>
            {req.confirmLabel ?? 'Confirmar'}
          </button>
        </>
      }
    >
      {req.body && <p className="confirm-body">{req.body}</p>}
    </Modal>
  );
}

let confirmRootReady = false;

// Substitui window.confirm: o título é a pergunta ("Sair de #geral?") e o corpo, uma frase sobre a consequência.
export function confirmDialog(opts: { title: ReactNode; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmQueue = [...confirmQueue, { ...opts, resolve }];
    if (!confirmRootReady) {
      confirmRootReady = true;
      const host = document.createElement('div');
      host.id = 'confirm-root';
      document.body.appendChild(host);
      createRoot(host).render(<ConfirmHost />);
    } else confirmListener?.();
  });
}

export function confirmAction(text: string) {
  return window.confirm(text);
}

// ---------- Campos ----------

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const control =
    only && (described || error)
      ? cloneElement(only, { 'aria-describedby': described, 'aria-invalid': error ? true : only.props['aria-invalid'] })
      : children;
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {control}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-err`}>
          <Icon name="error" size={14} />
          {error}
        </span>
      )}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? 'toggle disabled' : 'toggle'}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label &&
        (description ? (
          <span className="toggle-text">
            <span>{label}</span>
            <span className="toggle-desc">{description}</span>
          </span>
        ) : (
          <span>{label}</span>
        ))}
    </label>
  );
}

// Campo de busca com lupa e botão de limpar.
export function SearchInput({
  value,
  onChange,
  placeholder = 'Buscar',
  autoFocus,
  className,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={className ? `search-field ${className}` : 'search-field'}>
      <Icon name="search" />
      <input
        ref={ref}
        id={id}
        type="search"
        className="search-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="icon-btn search-clear"
          aria-label="Limpar busca"
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

// Botão de arquivo no lugar do <input type=file> nativo ("Choose File / No file chosen").
export function FileButton({
  onChange,
  accept,
  multiple,
  disabled,
  label = 'Escolher arquivo',
  file,
  name,
  small,
}: {
  onChange: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  // Nome a mostrar quando o arquivo é controlado por fora; null limpa.
  file?: File | string | null;
  name?: string;
  small?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string>('');
  const shown = file === undefined ? picked : typeof file === 'string' ? file : file?.name ?? '';
  return (
    <span className="file-button">
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        className="visually-hidden"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          setPicked(list.length > 1 ? `${list.length} arquivos` : list[0]?.name ?? '');
          onChange(list);
          e.target.value = '';
        }}
      />
      <button type="button" className={small ? 'btn small' : 'btn'} disabled={disabled} onClick={() => ref.current?.click()}>
        <Icon name="file-pick" size={small ? 14 : 16} />
        {label}
      </button>
      <span className="file-name" data-empty={shown ? undefined : ''} title={shown || undefined}>
        {shown || 'Nenhum arquivo selecionado'}
      </span>
    </span>
  );
}

// ---------- Abas e controle segmentado ----------

// Aba escolhida pelas setas. Se o onChange troca a rota e as abas remontam (/directory → /directory/:tab),
// a lista nova recupera o foco em vez de ele cair no <body>.
let pendingTabFocus: { id: string; at: number } | null = null;

// Faixa que rola de lado (abas, seções): data-fade diz de que lado há itens escondidos, e o CSS esmaece só aquela borda.
export function useEdgeFade(ref: RefObject<HTMLElement | null>, dep?: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.dataset.fade = max <= 1 ? 'none' : el.scrollLeft <= 1 ? 'end' : el.scrollLeft >= max - 1 ? 'start' : 'both';
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    el.addEventListener('scroll', sync, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', sync);
    };
  }, [ref, dep]);
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: ReactNode; count?: number; icon?: IconName }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeFade(ref, items.length);
  useLayoutEffect(() => {
    const p = pendingTabFocus;
    if (!p || p.id !== value) return;
    pendingTabFocus = null;
    if (performance.now() - p.at > 1000) return;
    ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`)?.focus();
  }, [value]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.id === value);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (next === null || !items.length) return;
    e.preventDefault();
    const it = items[(next + items.length) % items.length];
    pendingTabFocus = { id: it.id, at: performance.now() };
    onChange(it.id);
    ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(it.id)}"]`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" ref={ref} onKeyDown={onKey}>
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          role="tab"
          data-tab={i.id}
          aria-selected={i.id === value}
          tabIndex={i.id === value ? 0 : -1}
          className={i.id === value ? 'active' : ''}
          onClick={() => onChange(i.id)}
        >
          {i.icon && <Icon name={i.icon} />}
          {i.label}
          {i.count !== undefined && <span className="pill">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

// De 2 a 5 opções (Público / Privado; Todas / Perdidas…). Mais que isso vai em abas.
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: ReactNode; icon?: IconName }[];
  label?: string;
}) {
  return (
    <div className="seg-nav" role="radiogroup" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} type="button" role="radio" aria-checked={i.id === value} className={i.id === value ? 'on' : ''} onClick={() => onChange(i.id)}>
          {i.icon && <Icon name={i.icon} />}
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Estados vazios, carregamento ----------

// Com icon/title vira o estado vazio completo; só com texto, a versão pequena de antes.
export function Empty({
  children,
  icon,
  title,
  action,
  tone,
}: {
  children?: ReactNode;
  icon?: IconName;
  title?: ReactNode;
  action?: ReactNode;
  tone?: 'danger';
}) {
  if (!icon && !title && !action) return <div className="empty small">{children}</div>;
  return (
    <div className={tone ? `empty full ${tone}` : 'empty full'}>
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} size={24} />
        </span>
      )}
      {title && <h3 className="empty-title">{title}</h3>}
      {children && <div className="empty-desc">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ size }: { size?: 'sm' | 'lg' }) {
  return <div className={size ? `spinner ${size}` : 'spinner'} role="status" aria-label="Carregando" />;
}

export function Skeleton({ width, height = 12, circle, className, style }: { width?: number | string; height?: number; circle?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={['skeleton', circle && 'circle', className].filter(Boolean).join(' ')}
      style={{ width: width ?? (circle ? height : '100%'), height, ...style }}
      aria-hidden="true"
    />
  );
}

function SkeletonFrame({ children, className, delay = 250 }: { children: ReactNode; className: string; delay?: number }) {
  const ready = useDelay(delay);
  return (
    <div className={`skeleton-group ${className}`} role="status" aria-label="Carregando" aria-busy="true">
      {ready ? children : null}
    </div>
  );
}

export function SkeletonMessages({ n = 6, delay }: { n?: number; delay?: number }) {
  return (
    <SkeletonFrame className="sk-messages" delay={delay}>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <Skeleton circle height={36} />
          <div className="sk-lines">
            <Skeleton width={140} />
            <Skeleton width={`${[60, 72, 48, 66, 54, 70][i % 6]}%`} />
            {i % 3 === 2 && <Skeleton width="40%" />}
          </div>
        </div>
      ))}
    </SkeletonFrame>
  );
}

export function SkeletonList({ n = 8, delay }: { n?: number; delay?: number }) {
  return (
    <SkeletonFrame className="sk-list" delay={delay}>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <Skeleton circle height={20} />
          <Skeleton width={`${[55, 42, 61, 48][i % 4]}%`} />
        </div>
      ))}
    </SkeletonFrame>
  );
}

export function SkeletonTable({ rows = 8, cols = 4, delay }: { rows?: number; cols?: number; delay?: number }) {
  const widths = [60, 40, 30];
  return (
    <SkeletonFrame className="sk-table" delay={delay}>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={`${widths[(r + c) % 3]}%`} />
          ))}
        </div>
      ))}
    </SkeletonFrame>
  );
}

export function SkeletonStats({ n = 6, delay }: { n?: number; delay?: number }) {
  return (
    <SkeletonFrame className="sk-stats stats" delay={delay}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} height={96} className="sk-tile" />
      ))}
    </SkeletonFrame>
  );
}

// ---------- Menu ----------

const MENU_ITEMS = 'button:not(:disabled), a[href], [role^="menuitem"]:not([aria-disabled="true"])';

function menuItems(panel: HTMLElement | null) {
  if (!panel) return [];
  return [...panel.querySelectorAll<HTMLElement>(MENU_ITEMS)].filter((el) => el.getClientRects().length > 0);
}

// Mesmas props de sempre. O painel vai para o portal com a classe `menu ${align}`, posicionado junto do gatilho
// (vira para cima quando falta espaço). No celular vira uma folha que sobe de baixo.
export function Menu({
  trigger,
  children,
  align = 'right',
  placement,
  label,
  sheetTitle,
  className,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  placement?: Placement;
  label?: string;
  // Título da folha no celular (no desktop o menu sai do botão e dispensa título).
  sheetTitle?: string;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const presence = usePresence(open, 80);
  const phone = useIsPhone();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viaKeyboard = useRef<'first' | 'last' | null>(null);
  const openCb = useRef(onOpenChange);
  useLayoutEffect(() => {
    openCb.current = onOpenChange;
  });
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    openCb.current?.(v);
  }, []);
  const triggerEl = () => (wrapRef.current ? focusables(wrapRef.current)[0] ?? null : null);

  // Fecha e, se o foco estava no menu (Esc, item escolhido), devolve-o ao gatilho antes de outra camada abrir.
  const close = useCallback(
    (refocus = true) => {
      const a = document.activeElement;
      if (refocus && (!a || a === document.body || panelRef.current?.contains(a))) triggerEl()?.focus({ preventScroll: true });
      setOpen(false);
    },
    [setOpen],
  );
  const closeFromItem = useCallback(() => close(true), [close]);

  const anch = useAnchored({
    open: open && !phone,
    placement: placement ?? (align === 'left' ? 'bottom-start' : 'bottom-end'),
    onHidden: () => close(false),
  });
  const setWrap = useCallback(
    (n: HTMLDivElement | null) => {
      wrapRef.current = n;
      anch.setReference(n);
    },
    [anch.setReference],
  );
  const setPanel = useCallback(
    (n: HTMLDivElement | null) => {
      panelRef.current = n;
      anch.setFloating(n);
    },
    [anch.setFloating],
  );

  useEscape(open, () => close(true));
  useEffect(() => {
    if (open && phone) viaKeyboard.current = null;
  }, [open, phone]);

  useEffect(() => {
    if (!open || phone) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [open, phone, close]);

  // Itens são os <button> de quem usa o Menu: ganham o papel de item de menu.
  useLayoutEffect(() => {
    if (!presence.mounted) return;
    for (const el of menuItems(panelRef.current)) if (!el.getAttribute('role')) el.setAttribute('role', 'menuitem');
  });

  // Foco ao abrir: pelo teclado vai para o primeiro (ou último) item; pelo mouse, para o painel.
  useEffect(() => {
    if (!open || phone || !anch.positioned) return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    const items = menuItems(panel);
    const how = viaKeyboard.current;
    viaKeyboard.current = null;
    (how === 'last' ? items[items.length - 1] : how === 'first' ? items[0] : panel)?.focus({ preventScroll: true });
  }, [open, phone, anch.positioned]);

  const typed = useRef({ text: '', at: 0 });
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(panelRef.current);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at > 600 ? '' : typed.current.text) + e.key.toLowerCase(), at: now };
      const q = typed.current.text;
      const start = i < 0 ? 0 : q.length === 1 ? i + 1 : i;
      const order = [...items.slice(start), ...items.slice(0, start)];
      const hit = order.find((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(q));
      if (hit) {
        e.preventDefault();
        hit.focus();
      }
    }
  };

  const onTriggerClick = (e: ReactMouseEvent) => {
    if (open) return close(false);
    // detail 0: clique gerado por Enter/Espaço no gatilho.
    if (e.detail === 0) viaKeyboard.current = 'first';
    setOpen(true);
  };
  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    viaKeyboard.current = e.key === 'ArrowUp' ? 'last' : 'first';
    setOpen(true);
  };

  const t = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, { 'aria-haspopup': 'menu', 'aria-expanded': open })
    : trigger;
  const cls = `menu ${align}${className ? ` ${className}` : ''}`;
  return (
    <div className="menu-wrap" ref={setWrap}>
      <span onClick={onTriggerClick} onKeyDown={onTriggerKey}>
        {t}
      </span>
      {open && phone && (
        <Sheet onClose={() => close(true)} className={cls} role="menu" label={label} initialFocus={viaKeyboard.current ? MENU_ITEMS : undefined} onKeyDown={onPanelKey}>
          <div className="sheet-scroll">
            {sheetTitle && (
              <div className="menu-title" role="presentation">
                <strong>{sheetTitle}</strong>
              </div>
            )}
            {children(closeFromItem)}
          </div>
        </Sheet>
      )}
      {presence.mounted && !phone && (
        <Portal>
          <div
            ref={setPanel}
            className={cls}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={anch.style}
            data-side={anch.positioned ? anch.side : undefined}
            data-layer={anch.layer}
            data-state={presence.state}
            onKeyDown={onPanelKey}
          >
            {children(closeFromItem)}
          </div>
        </Portal>
      )}
    </div>
  );
}

// ---------- Dica (tooltip), pronta para a fase 3 ----------

let lastTipHide = 0;

// Some com o title nativo só quando os testes E2E passarem a usar aria-label. Atraso de 400ms, sem atraso
// se outra dica fechou há menos de 800ms.
export function Tooltip({ label, shortcut, placement = 'bottom', children }: { label: ReactNode; shortcut?: string; placement?: Placement; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anch = useAnchored({ open, placement, gap: 6, minHeight: 0 });
  const id = useId();
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), Date.now() - lastTipHide < 800 ? 0 : 400);
  };
  const hideTip = () => {
    clearTimeout(timer.current);
    if (open) lastTipHide = Date.now();
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEscape(open, hideTip);
  return (
    <>
      <span className="tooltip-anchor" ref={anch.setReference} onPointerEnter={show} onPointerLeave={hideTip} onFocus={show} onBlur={hideTip}>
        {cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-describedby': open ? id : undefined })}
      </span>
      {open && (
        <Portal>
          <div ref={anch.setFloating} id={id} role="tooltip" className="tooltip" style={anch.style} data-layer={anch.layer}>
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>
        </Portal>
      )}
    </>
  );
}

// ---------- Toasts ----------

const TOAST_ICON: Record<ToastItem['kind'], IconName> = { info: 'info', success: 'success', warning: 'warning', error: 'error' };

function Toast({ t }: { t: ToastItem }) {
  const dismiss = useStore((s) => s.dismissToast);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(t.duration);
  const since = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    setLeaving(true);
    setTimeout(() => dismiss(t.id), 120);
  }, [dismiss, t.id]);
  const start = useCallback(() => {
    since.current = Date.now();
    clearTimeout(timer.current);
    timer.current = setTimeout(leave, left.current);
  }, [leave]);
  const pause = () => {
    clearTimeout(timer.current);
    left.current = Math.max(1000, left.current - (Date.now() - since.current));
  };
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, [start]);
  return (
    <div
      className={`toast ${t.kind}`}
      role={t.kind === 'error' ? 'alert' : 'status'}
      data-state={leaving ? 'closed' : 'open'}
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <Icon name={(t.icon as IconName | undefined) ?? TOAST_ICON[t.kind]} size={20} className="toast-icon" />
      <span className="toast-text">{t.text}</span>
      {t.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            t.action?.onClick();
            leave();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" className="icon-btn toast-close" aria-label="Fechar aviso" onClick={leave}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  // Ordem de chegada no DOM (o último é o mais novo); o CSS mostra o mais novo em cima. A store guarda no máximo 3.
  return (
    <Portal>
      <div className="toasts">
        {toasts.slice(-3).map((t) => (
          <Toast key={t.id} t={t} />
        ))}
      </div>
    </Portal>
  );
}

// ---------- Dados ----------

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: e?.message ?? String(e), loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

const nf = new Intl.NumberFormat('pt-BR');

export function Pager({
  offset,
  count,
  total,
  onChange,
  sizes,
  onCountChange,
}: {
  offset: number;
  count: number;
  total: number;
  onChange: (o: number) => void;
  sizes?: number[];
  onCountChange?: (n: number) => void;
}) {
  if (total <= count && !onCountChange) return null;
  return (
    <div className="pager">
      <button type="button" className="btn small" title="Página anterior" aria-label="Página anterior" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - count))}>
        <Icon name="prev" />
      </button>
      <span className="pager-range">
        {nf.format(Math.min(offset + 1, total))}–{nf.format(Math.min(offset + count, total))} de {nf.format(total)}
      </span>
      <button type="button" className="btn small" title="Próxima página" aria-label="Próxima página" disabled={offset + count >= total} onClick={() => onChange(offset + count)}>
        <Icon name="next" />
      </button>
      {onCountChange && (
        <select className="pager-size" aria-label="Itens por página" value={count} onChange={(e) => onCountChange(Number(e.target.value))}>
          {(sizes ?? [25, 50, 100]).map((n) => (
            <option key={n} value={n}>
              {n} por página
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
