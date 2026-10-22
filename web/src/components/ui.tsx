import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { avatarBust, useStore } from '../lib/store';
import { STATUS_LABEL } from '../lib/format';

export function Avatar({ username, size = 32, rid, etag }: { username?: string; size?: number; rid?: string; etag?: string | null }) {
  const bust = username ? avatarBust[username] ?? etag ?? '' : etag ?? '';
  const src = rid ? `/avatar/room/${rid}?v=${bust}` : `/avatar/${encodeURIComponent(username ?? '')}?v=${bust}`;
  return <img className="avatar" src={src} width={size} height={size} style={{ width: size, height: size }} alt="" loading="lazy" />;
}

export function StatusDot({ username, status }: { username?: string; status?: string }) {
  const live = useStore((s) => (username ? s.presence[username]?.status : undefined));
  const st = live ?? status ?? 'offline';
  return <span className={`status-dot ${st}`} title={STATUS_LABEL[st]} />;
}

export function UserAvatar({ username, size = 32, status }: { username: string; size?: number; status?: string }) {
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      <Avatar username={username} size={size} />
      <StatusDot username={username} status={status} />
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  // Vai direto para o <body>: dentro da barra lateral o modal herdava a cor clara dela e, no celular, ficava preso na gaveta.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs">
      {items.map((i) => (
        <button key={i.id} className={i.id === value ? 'active' : ''} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Carregando" />;
}

export function Menu({ trigger, children, align = 'right' }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <span onClick={() => setOpen(!open)}>{trigger}</span>
      {open && <div className={`menu ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

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

export function Pager({ offset, count, total, onChange }: { offset: number; count: number; total: number; onChange: (o: number) => void }) {
  if (total <= count) return null;
  return (
    <div className="pager">
      <button className="btn" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - count))}>
        ‹ Anterior
      </button>
      <span>
        {offset + 1}–{Math.min(offset + count, total)} de {total}
      </span>
      <button className="btn" disabled={offset + count >= total} onClick={() => onChange(offset + count)}>
        Próxima ›
      </button>
    </div>
  );
}

export function confirmAction(text: string) {
  return window.confirm(text);
}
