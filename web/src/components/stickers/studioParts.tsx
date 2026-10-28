// Figurinhas: peças do estúdio usadas pela conta e pela administração sem carregar o editor: reordenar
// (arrastar ou Alt + setas) e os chips de papéis ("Visível para", "Quem não envia figurinhas").
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { StickerPack } from '@shared/stickers';
import { roleLabel, setRoleDescriptions } from '../../lib/format';
import { stickerErrorText } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Portal } from '../overlay';
import { Menu } from '../ui';

// ---------- Reordenar ----------

export interface DragGhost {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const THRESHOLD = 4; // px até o arrasto começar: abaixo disso é um clique
const SAVE_MS = 400;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function moved(list: readonly string[], id: string, to: number): string[] {
  const from = list.indexOf(id);
  const next = [...list];
  if (from < 0 || to < 0 || to >= list.length || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

// A ordem da tela fica local até o servidor devolver a mesma; um erro desfaz.
export function useReorder(
  ids: readonly string[],
  save: (ids: string[]) => Promise<void>,
  announce: (i: number, n: number) => string = (i, n) => `Movida para a posição ${i} de ${n}`,
) {
  const [local, setLocal] = useState<string[] | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [message, setMessage] = useState('');
  const box = useRef<HTMLElement | null>(null);
  const timer = useRef(0);
  const pending = useRef<string[] | null>(null);
  const refocus = useRef<Element | null>(null);
  const suppress = useRef(false);
  const order = local && sameSet(local, ids) ? local : [...ids];
  const orderRef = useRef(order);
  orderRef.current = order;
  const saveRef = useRef(save);
  saveRef.current = save;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const key = ids.join('\n');
  useEffect(() => {
    if (local && !pending.current && sameList(local, key.split('\n'))) setLocal(null);
  }, [key, local]);

  const flush = useCallback(() => {
    const next = pending.current;
    window.clearTimeout(timer.current);
    timer.current = 0;
    if (!next) return;
    saveRef
      .current(next)
      .catch((e) => {
        useStore.getState().toast(stickerErrorText(e), 'error');
        setLocal(null);
      })
      .finally(() => {
        if (pending.current === next) pending.current = null;
      });
  }, []);
  const schedule = useCallback(
    (next: string[]) => {
      pending.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_MS);
    },
    [flush],
  );
  // Saiu da tela antes dos 400 ms: salva na hora.
  useEffect(() => flush, [flush]);

  // Ao mover com o teclado o React reposiciona o nó e o foco pode cair no <body>: volta para onde estava.
  useLayoutEffect(() => {
    const el = refocus.current as HTMLElement | null;
    if (!el) return;
    refocus.current = null;
    if (el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  const place = (next: string[], id: string) => {
    setLocal(next);
    setMessage(announceRef.current(next.indexOf(id) + 1, next.length));
    schedule(next);
  };

  const onKeyDown = (id: string) => (e: KeyboardEvent<HTMLElement>) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    const cur = orderRef.current;
    const next = moved(cur, id, cur.indexOf(id) + d);
    if (sameList(next, cur)) return;
    refocus.current = document.activeElement;
    place(next, id);
  };

  const onPointerDown = (id: string) => (e: PointerEvent<HTMLElement>) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target as HTMLElement;
    const handle = !!target.closest('[data-drag-handle]');
    // No toque só a alça arrasta: o resto da peça rola a página.
    if (e.pointerType === 'touch' && !handle) return;
    if (!handle && target.closest('.menu-wrap, input, textarea, select')) return;
    const item = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const before = orderRef.current;
    let started = false;
    let dx = 0;
    let dy = 0;
    const end = (ok: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      if (!started) return;
      setGhost(null);
      if (!ok) {
        setLocal(sameList(before, [...ids]) ? null : before);
        return;
      }
      // O clique que segue o soltar não abre a peça.
      suppress.current = true;
      window.setTimeout(() => (suppress.current = false), 0);
      const now = orderRef.current;
      if (!sameList(now, before)) place(now, id);
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
        started = true;
        const r = item.getBoundingClientRect();
        dx = x0 - r.left;
        dy = y0 - r.top;
        window.getSelection()?.removeAllRanges();
        setGhost({ id, left: ev.clientX - dx, top: ev.clientY - dy, width: r.width, height: r.height });
      }
      ev.preventDefault();
      setGhost((g) => (g ? { ...g, left: ev.clientX - dx, top: ev.clientY - dy } : g));
      // A peça sob o ponteiro cede o lugar; a fantasma não recebe o ponteiro (pointer-events: none).
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-reorder-id]');
      const overId = over && box.current?.contains(over) ? over.dataset.reorderId : undefined;
      if (!overId || overId === id) return;
      const cur = orderRef.current;
      const next = moved(cur, id, cur.indexOf(overId));
      if (!sameList(next, cur)) setLocal(next);
    };
    const onUp = (ev: globalThis.PointerEvent) => ev.pointerId === e.pointerId && end(true);
    const onCancel = (ev: globalThis.PointerEvent) => ev.pointerId === e.pointerId && end(false);
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape' || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  return {
    order,
    ghost,
    message,
    containerProps: {
      ref: (n: HTMLElement | null) => {
        box.current = n;
      },
      onClickCapture: (e: MouseEvent) => {
        if (!suppress.current) return;
        suppress.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
    itemProps: (id: string) => ({
      'data-reorder-id': id,
      'data-dragging': ghost?.id === id ? '' : undefined,
      onPointerDown: onPointerDown(id),
      onKeyDown: onKeyDown(id),
    }),
  };
}

// A peça que acompanha o ponteiro enquanto o lugar dela fica marcado na lista.
export function DragGhostLayer({ ghost, children }: { ghost: DragGhost | null; children: ReactNode }) {
  if (!ghost) return null;
  return (
    <Portal>
      <div className="stk-ghost" style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }} aria-hidden="true">
        {children}
      </div>
    </Portal>
  );
}

// Texto só para leitores de tela ("Movida para a posição 3 de 8").
export function LiveRegion({ text }: { text: string }) {
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

// A capa do pacote (pôster ou arquivo da figurinha de capa); sem figurinhas, o ícone do pacote.
export function PackCover({ pack, size }: { pack: Pick<StickerPack, 'coverUrl'>; size: number }) {
  return (
    <span className="stk-cover" style={{ width: size, height: size }}>
      {pack.coverUrl ? <img src={pack.coverUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="sticker-pack" size={size >= 64 ? 32 : size >= 40 ? 20 : 16} />}
    </span>
  );
}

// ---------- Papéis ----------

export interface GlobalRole {
  _id: string;
  name?: string;
  description?: string | null;
  scope?: string;
}

let rolesLoad: Promise<GlobalRole[]> | null = null;

// Os papéis globais (escopo Users) de roles.list, uma vez por página.
export function useGlobalRoles(): GlobalRole[] | null {
  const [roles, setRoles] = useState<GlobalRole[] | null>(null);
  useEffect(() => {
    let alive = true;
    rolesLoad ??= api
      .get<{ roles: GlobalRole[] }>('roles.list')
      .then((r) => {
        setRoleDescriptions(r.roles);
        return r.roles.filter((x) => !x.scope || x.scope === 'Users');
      })
      .catch((e) => {
        rolesLoad = null;
        throw e;
      });
    rolesLoad.then(
      (r) => alive && setRoles(r),
      () => alive && setRoles([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  return roles;
}

// Chips dos papéis escolhidos, cada um com o "remover", e "Adicionar papel" com o menu dos papéis globais.
export function RoleChips({
  value,
  onChange,
  roles,
  labelledBy,
  max = 20,
  disabled,
}: {
  value: string[];
  onChange(ids: string[]): void;
  roles: GlobalRole[] | null;
  labelledBy?: string;
  max?: number;
  disabled?: boolean;
}) {
  const free = (roles ?? []).filter((r) => !value.includes(r._id));
  return (
    <div className="chips stk-role-chips" role="group" aria-labelledby={labelledBy}>
      {value.map((id) => (
        <span key={id} className="chip">
          {roleLabel(id)}
          <button type="button" aria-label={`Remover ${roleLabel(id)}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== id))}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      <Menu
        align="left"
        label="Adicionar papel"
        sheetTitle="Adicionar papel"
        trigger={
          <button type="button" className="chip selectable" disabled={disabled || !free.length || value.length >= max}>
            <Icon name="add" size={14} />
            Adicionar papel
          </button>
        }
      >
        {(close) =>
          free.map((r) => (
            <button
              key={r._id}
              type="button"
              onClick={() => {
                close();
                onChange([...value, r._id]);
              }}
            >
              {roleLabel(r._id)}
            </button>
          ))
        }
      </Menu>
    </div>
  );
}
