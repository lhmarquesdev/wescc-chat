import { useEffect, useRef, useState } from 'react';
import { customEmoji, EMOJI, EMOJI_CATEGORIES } from '../lib/emoji';

const RECENT_KEY = 'wescc.recentEmoji';

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function pushRecent(code: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([code, ...recent().filter((c) => c !== code)].slice(0, 24)));
  } catch {
    // ignora
  }
}

export function EmojiPicker({ onPick, onClose }: { onPick: (code: string) => void; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [cat, setCat] = useState(recent().length ? 'Recentes' : EMOJI_CATEGORIES[0].name);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', h));
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);
  const cats = [
    ...(recent().length ? [{ name: 'Recentes', icon: '🕘', items: recent() }] : []),
    ...EMOJI_CATEGORIES,
    ...(customEmoji.length ? [{ name: 'Personalizados', icon: '⭐', items: customEmoji.map((e) => e.name) }] : []),
  ];
  const items = term
    ? [...Object.keys(EMOJI).filter((k) => k.includes(term.toLowerCase())), ...customEmoji.filter((e) => e.name.includes(term.toLowerCase())).map((e) => e.name)]
    : cats.find((c) => c.name === cat)?.items ?? [];
  const pick = (code: string) => {
    pushRecent(code);
    onPick(code);
  };
  return (
    <div className="emoji-picker" ref={ref}>
      <input autoFocus placeholder="Buscar emoji" value={term} onChange={(e) => setTerm(e.target.value)} />
      {!term && (
        <div className="emoji-cats">
          {cats.map((c) => (
            <button key={c.name} className={c.name === cat ? 'active' : ''} title={c.name} onClick={() => setCat(c.name)}>
              {c.icon}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid">
        {items.map((code) => (
          <button key={code} title={`:${code}:`} onClick={() => pick(code)}>
            {EMOJI[code] ?? <img src={`/emoji-custom/${encodeURIComponent(code)}`} alt={code} />}
          </button>
        ))}
      </div>
    </div>
  );
}
