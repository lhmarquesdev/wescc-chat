import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { roomIcon } from '../lib/format';
import { Avatar } from './ui';

export interface PickedUser {
  _id: string;
  username: string;
  name?: string;
}

export function UserPicker({ value, onChange, placeholder = 'Buscar pessoas', single, rid }: { value: PickedUser[]; onChange: (v: PickedUser[]) => void; placeholder?: string; single?: boolean; rid?: string }) {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<PickedUser[]>([]);
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
  return (
    <div className="picker">
      <div className="chips">
        {value.map((u) => (
          <span key={u._id} className="chip">
            <Avatar username={u.username} size={18} /> {u.username}
            <button onClick={() => onChange(value.filter((x) => x._id !== u._id))}>✕</button>
          </span>
        ))}
        {(!single || value.length === 0) && <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={placeholder} />}
      </div>
      {items.length > 0 && (
        <div className="picker-list">
          {items.map((u) => (
            <button
              key={u._id}
              type="button"
              onClick={() => {
                onChange(single ? [u] : [...value, u]);
                setTerm('');
              }}
            >
              <Avatar username={u.username} size={22} /> <strong>{u.name}</strong> <span className="muted">@{u.username}</span>
            </button>
          ))}
        </div>
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
  if (value)
    return (
      <div className="chips">
        <span className="chip">
          {roomIcon(value)} {value.fname || value.name}
          <button onClick={() => onChange(null)}>✕</button>
        </span>
      </div>
    );
  return (
    <div className="picker">
      <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={placeholder} />
      {items.length > 0 && (
        <div className="picker-list">
          {items.map((r) => (
            <button key={r._id} type="button" onClick={() => onChange(r)}>
              {roomIcon(r)} {r.fname || r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
