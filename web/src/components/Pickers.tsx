import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { roomIconName } from '../lib/format';
import { Icon } from './Icon';
import { overlayRoot, useAnchored } from './overlay';
import { Avatar } from './ui';

export interface PickedUser {
  _id: string;
  username: string;
  name?: string;
  roles?: string[]; // papéis globais (users.autocomplete)
}

// Lista de sugestões em posição fixa, com a largura do campo: a rolagem do modal não a corta mais.
// Dentro de um modal ela vai para o próprio .modal (não para o fim do body), e ".modal .picker-list" continua valendo.
// Fora de modal ela vai para #overlay-root e deixa de ser filha da página (".ldap-options .picker-list" não acha; ".picker-list" acha).
function SuggestionList({ anchor, children, label, nav }: { anchor: HTMLElement | null; children: ReactNode; label: string; nav: 'key' | 'pointer' }) {
  const anch = useAnchored({ open: true, placement: 'bottom-start', matchWidth: true });
  useEffect(() => {
    anch.setReference(anchor);
  }, [anchor, anch.setReference]);
  const host = anchor?.closest<HTMLElement>('.modal, .sheet') ?? overlayRoot();
  return createPortal(
    <div
      ref={anch.setFloating}
      className="picker-list"
      role="listbox"
      aria-label={label}
      style={anch.style}
      data-side={anch.positioned ? anch.side : undefined}
      data-layer={anch.layer}
      data-nav={nav}
    >
      {children}
    </div>,
    host,
  );
}

// ↑ ↓ escolhem, Enter confirma, Esc fecha só a lista (não o modal). nav diz quem escolheu por último:
// pelas setas o item ganha o anel de foco; pelo mouse, só o fundo.
function useListKeys(count: number, pick: (i: number) => void, closeList: () => void) {
  const [active, setActive] = useState(-1);
  const [nav, setNav] = useState<'key' | 'pointer'>('pointer');
  useEffect(() => {
    setActive(count ? 0 : -1);
    setNav('pointer');
  }, [count]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!count) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setNav('key');
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeList();
    }
  };
  const hover = (i: number) => {
    setNav('pointer');
    setActive(i);
  };
  return { active, nav, hover, onKeyDown };
}

export function UserPicker({
  value,
  onChange,
  placeholder = 'Buscar pessoas',
  single,
  rid,
  itemDisabled,
}: {
  value: PickedUser[];
  onChange: (v: PickedUser[]) => void;
  placeholder?: string;
  single?: boolean;
  rid?: string;
  // Motivo para não deixar escolher a pessoa (aparece na sugestão, desativada).
  itemDisabled?: (item: PickedUser & { roles?: string[] }) => string | undefined;
}) {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<PickedUser[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!term) {
      setItems([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await api.get('users.autocomplete', { term, exclude: value.map((v) => v.username), rid }).catch(() => ({ items: [] }));
      setItems(r.items);
    }, 150);
    return () => clearTimeout(t);
  }, [term, value, rid]);
  const add = (u: PickedUser) => {
    if (itemDisabled?.(u)) return;
    onChange(single ? [u] : [...value, u]);
    setTerm('');
    inputRef.current?.focus();
  };
  const shown = listOpen ? items : [];
  const keys = useListKeys(shown.length, (i) => add(shown[i]), () => setListOpen(false));
  return (
    <div className="picker">
      <div className="chips" ref={boxRef}>
        {value.map((u) => (
          <span key={u._id} className="chip">
            <Avatar username={u.username} size={20} /> {u.username}
            <button type="button" aria-label={`Remover ${u.username}`} onClick={() => onChange(value.filter((x) => x._id !== u._id))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        {(!single || value.length === 0) && (
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => (setTerm(e.target.value), setListOpen(true))}
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !term && value.length && !single) onChange(value.slice(0, -1));
              keys.onKeyDown(e);
            }}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={shown.length > 0}
            aria-autocomplete="list"
          />
        )}
      </div>
      {shown.length > 0 && (
        <SuggestionList anchor={boxRef.current} label="Pessoas" nav={keys.nav}>
          {shown.map((u, i) => {
            const reason = itemDisabled?.(u);
            const cls = i === keys.active ? 'active' : undefined;
            if (reason)
              return (
                <button
                  key={u._id}
                  type="button"
                  className={cls ? `blocked ${cls}` : 'blocked'}
                  aria-disabled="true"
                  title={reason}
                  role="option"
                  aria-selected={i === keys.active}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <Avatar username={u.username} size={24} />
                  <span className="picker-item">
                    <span>
                      <strong>{u.name}</strong> <span className="muted">@{u.username}</span>
                    </span>
                    <span className="picker-reason">{reason}</span>
                  </span>
                </button>
              );
            return (
              <button
                key={u._id}
                type="button"
                className={cls}
                role="option"
                aria-selected={i === keys.active}
                onMouseEnter={() => keys.hover(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(u)}
              >
                <Avatar username={u.username} size={24} /> <strong>{u.name}</strong> <span className="muted">@{u.username}</span>
              </button>
            );
          })}
        </SuggestionList>
      )}
    </div>
  );
}

export interface PickedRoom {
  _id: string;
  name: string;
  fname?: string;
  t: string;
}

export function RoomPicker({ value, onChange, placeholder = 'Buscar sala' }: { value: PickedRoom | null; onChange: (v: PickedRoom | null) => void; placeholder?: string }) {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<PickedRoom[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!term) {
      setItems([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await api.get('rooms.autocomplete.channelAndPrivate', { term }).catch(() => ({ items: [] }));
      setItems(r.items);
    }, 150);
    return () => clearTimeout(t);
  }, [term]);
  const shown = listOpen ? items : [];
  const keys = useListKeys(shown.length, (i) => onChange(shown[i]), () => setListOpen(false));
  if (value)
    return (
      <div className="chips">
        <span className="chip">
          <Icon name={roomIconName(value)} size={14} /> {value.fname || value.name}
          <button type="button" aria-label={`Remover ${value.fname || value.name}`} onClick={() => onChange(null)}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
    );
  return (
    <div className="picker">
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => (setTerm(e.target.value), setListOpen(true))}
        onFocus={() => setListOpen(true)}
        onBlur={() => setListOpen(false)}
        onKeyDown={keys.onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-autocomplete="list"
      />
      {shown.length > 0 && (
        <SuggestionList anchor={inputRef.current} label="Salas" nav={keys.nav}>
          {shown.map((r, i) => (
            <button
              key={r._id}
              type="button"
              role="option"
              aria-selected={i === keys.active}
              className={i === keys.active ? 'active' : undefined}
              onMouseEnter={() => keys.hover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange(r)}
            >
              <Icon name={roomIconName(r)} /> {r.fname || r.name}
            </button>
          ))}
        </SuggestionList>
      )}
    </div>
  );
}
