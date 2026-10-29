// Seletor de emoji: no computador, painel ancorado no botão que abriu (em portal); no celular, folha que sobe de baixo.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { customEmoji, EMOJI, EMOJI_CATEGORIES } from '../lib/emoji';
import { Icon, type IconName } from './Icon';
import { Portal, Sheet, useAnchored, useEscape, useIsPhone, type Placement } from './overlay';

// Os códigos são em inglês; estas palavras deixam a busca achar o emoji em português.
const PT_WORDS: Record<string, string[]> = {
  coracao: ['heart', 'orange_heart', 'yellow_heart', 'green_heart', 'blue_heart', 'purple_heart', 'heart_eyes', 'two_hearts', 'sparkling_heart'],
  amor: ['heart', 'heart_eyes', 'kissing_heart', 'two_hearts'],
  joinha: ['+1'],
  positivo: ['+1', 'white_check_mark'],
  negativo: ['-1'],
  certo: ['white_check_mark', 'heavy_check_mark'],
  feito: ['white_check_mark', 'heavy_check_mark'],
  errado: ['x'],
  rir: ['joy', 'rofl', 'laughing', 'smile'],
  risada: ['joy', 'rofl', 'laughing'],
  sorriso: ['smile', 'smiley', 'grinning', 'blush'],
  triste: ['cry', 'sob', 'disappointed', 'pensive'],
  chorar: ['cry', 'sob'],
  festa: ['tada', 'confetti_ball', 'partying_face'],
  parabens: ['tada', 'clap', 'trophy'],
  palmas: ['clap'],
  obrigado: ['pray'],
  obrigada: ['pray'],
  olhos: ['eyes'],
  fogo: ['fire'],
  estrela: ['star', 'star2'],
  atencao: ['warning', 'exclamation'],
  alerta: ['warning'],
  pergunta: ['question'],
  ideia: ['bulb'],
  cafe: ['coffee'],
  telefone: ['telephone', 'phone'],
  relogio: ['alarm_clock', 'hourglass'],
  dinheiro: ['moneybag', 'dollar'],
  foguete: ['rocket'],
  pensando: ['thinking'],
  ola: ['wave'],
  tchau: ['wave'],
};
const fold = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const RECENT_KEY = 'wescc.recentEmoji';
let recentCache: string[] | null = null;

// Últimos emojis usados (reações e compositor), do mais recente para o mais antigo.
export function recentEmoji(): string[] {
  if (recentCache) return recentCache;
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    recentCache = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    recentCache = [];
  }
  return recentCache;
}

export function pushRecent(code: string) {
  recentCache = [code, ...recentEmoji().filter((c) => c !== code)].slice(0, 24);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCache));
  } catch {
    // sem armazenamento (aba anônima): a lista vale só nesta aba
  }
}

// Os dados de lib/emoji.ts ficam como estão: o ícone de cada categoria sai daqui, pelo nome.
const CAT_ICON: Record<string, IconName> = {
  Recentes: 'emoji-recent',
  Rostos: 'emoji-faces',
  Pessoas: 'emoji-people',
  Símbolos: 'emoji-symbols',
  Atividades: 'emoji-activities',
  'Comida e natureza': 'emoji-food',
  Objetos: 'emoji-objects',
  Personalizados: 'emoji-custom',
};

function Glyph({ code }: { code: string }) {
  return EMOJI[code] ? <>{EMOJI[code]}</> : <img src={`/emoji-custom/${encodeURIComponent(code)}`} alt={code} />;
}

// Setas movem o foco pela grade, pela posição na tela (as seções não têm o mesmo número de itens).
function moveFocus(e: ReactKeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  const cur = e.target as HTMLElement;
  if (!root || !keys.includes(e.key) || !cur.matches('button[data-code]')) return;
  const all = [...root.querySelectorAll<HTMLElement>('button[data-code]')];
  const i = all.indexOf(cur);
  let next: HTMLElement | undefined;
  if (e.key === 'ArrowLeft') next = all[i - 1];
  else if (e.key === 'ArrowRight') next = all[i + 1];
  else {
    const r = cur.getBoundingClientRect();
    const down = e.key === 'ArrowDown';
    const rows = all.filter((b) => {
      const t = b.getBoundingClientRect().top;
      return down ? t > r.top + 4 : t < r.top - 4;
    });
    if (rows.length) {
      const edge = down ? Math.min(...rows.map((b) => b.getBoundingClientRect().top)) : Math.max(...rows.map((b) => b.getBoundingClientRect().top));
      const row = rows.filter((b) => Math.abs(b.getBoundingClientRect().top - edge) < 4);
      next = row.reduce((best, b) => (Math.abs(b.getBoundingClientRect().left - r.left) < Math.abs(best.getBoundingClientRect().left - r.left) ? b : best));
    }
  }
  if (next) {
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
}

// Busca, categorias, grade e rodapé, sem o painel em volta: o seletor de expressões do compositor e o editor de
// figurinhas usam o mesmo corpo. unicodeOnly tira os emojis personalizados (a figurinha guarda só Unicode).
export function EmojiPickerBody({ onPick, unicodeOnly, autoFocus = false }: { onPick: (code: string, unicode: string | null) => void; unicodeOnly?: boolean; autoFocus?: boolean }) {
  // O painel fica invisível até ser posicionado; o foco na busca só pega depois disso.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    let tries = 0;
    let id = 0;
    const go = () => {
      const el = search.current;
      el?.focus({ preventScroll: true });
      if (el && document.activeElement !== el && tries++ < 10) id = requestAnimationFrame(go);
    };
    go();
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);
  const [term, setTerm] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const recent = unicodeOnly ? recentEmoji().filter((c) => c in EMOJI) : recentEmoji();
  const cats = useMemo(
    () => [
      ...(recent.length ? [{ name: 'Recentes', items: recent }] : []),
      ...EMOJI_CATEGORIES,
      ...(customEmoji.length && !unicodeOnly ? [{ name: 'Personalizados', items: customEmoji.map((e) => e.name) }] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [active, setActive] = useState(cats[0]?.name ?? '');
  const grid = useRef<HTMLDivElement>(null);
  const t = fold(term.trim());
  const found = useMemo(() => {
    if (!t) return [];
    const pt = Object.entries(PT_WORDS).flatMap(([w, codes]) => (w.startsWith(t) ? codes : []));
    const byCode = Object.keys(EMOJI).filter((k) => k.includes(t));
    const custom = unicodeOnly ? [] : customEmoji.filter((e) => e.name.includes(t)).map((e) => e.name);
    return [...new Set([...pt.filter((c) => c in EMOJI), ...byCode, ...custom])];
  }, [t, unicodeOnly]);
  const pick = (code: string) => {
    pushRecent(code);
    onPick(code, EMOJI[code] ?? null);
  };

  const onScroll = () => {
    const el = grid.current;
    if (!el || t) return;
    let cur: string | undefined = cats[0]?.name;
    for (const s of el.querySelectorAll<HTMLElement>('.emoji-section')) if (s.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = s.dataset.cat;
    if (cur && cur !== active) setActive(cur);
  };
  const goTo = (name: string) => {
    const el = grid.current;
    const s = el?.querySelector<HTMLElement>(`.emoji-section[data-cat="${CSS.escape(name)}"]`);
    if (el && s) el.scrollTop = s.offsetTop - el.offsetTop;
    setActive(name);
  };
  const track = (e: { target: EventTarget }) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-code]');
    if (b) setHover(b.dataset.code ?? null);
  };

  const cell = (code: string) => (
    <button key={code} type="button" data-code={code} title={`:${code}:`} aria-label={`:${code}:`} onClick={() => pick(code)}>
      <Glyph code={code} />
    </button>
  );

  return (
    <>
      <div className="emoji-search">
        <Icon name="search" size={16} />
        <input
          ref={search}
          placeholder="Buscar emoji"
          aria-label="Buscar emoji"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found[0]) {
              e.preventDefault();
              pick(found[0]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              grid.current?.querySelector<HTMLElement>('button[data-code]')?.focus();
            }
          }}
        />
      </div>
      {!t && (
        <div className="emoji-cats" role="tablist" aria-label="Categorias">
          {cats.map((c) => (
            <button key={c.name} type="button" role="tab" aria-selected={c.name === active} className={c.name === active ? 'active' : ''} title={c.name} aria-label={c.name} onClick={() => goTo(c.name)}>
              <Icon name={CAT_ICON[c.name] ?? 'emoji'} size={18} />
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid" ref={grid} onScroll={onScroll} onMouseOver={track} onFocus={track} onKeyDown={(e) => moveFocus(e, grid.current)}>
        {t ? (
          found.length ? (
            <div className="emoji-section">
              <div className="emoji-items">{found.map(cell)}</div>
            </div>
          ) : (
            <div className="emoji-empty">Nenhum emoji encontrado.</div>
          )
        ) : (
          cats.map((c) => (
            <section key={c.name} className="emoji-section" data-cat={c.name} aria-label={c.name}>
              <div className="emoji-section-title">{c.name}</div>
              <div className="emoji-items">{c.items.map(cell)}</div>
            </section>
          ))
        )}
      </div>
      <div className="emoji-foot" aria-hidden="true">
        {hover ? (
          <>
            <span className="emoji-foot-glyph">
              <Glyph code={hover} />
            </span>
            <code>:{hover}:</code>
          </>
        ) : (
          <span>Escolha um emoji</span>
        )}
      </div>
    </>
  );
}

export function EmojiPicker({
  onPick,
  onClose,
  anchor,
  reference,
  placement = 'top-end',
  gap,
}: {
  onPick: (code: string) => void;
  onClose: () => void;
  // Quem abriu: o painel se posiciona nele e devolve o foco a ele no Esc.
  anchor?: HTMLElement | null;
  // Onde o painel se posiciona, quando não é no botão (o compositor: o painel fica acima do texto, sem cobri-lo).
  reference?: HTMLElement | null;
  placement?: Placement;
  gap?: number;
}) {
  const phone = useIsPhone();
  const ref = useRef<HTMLDivElement | null>(null);
  const anch = useAnchored({ open: !phone, placement, gap, minHeight: 240 });
  const setPanel = useCallback(
    (n: HTMLDivElement | null) => {
      ref.current = n;
      anch.setFloating(n);
    },
    [anch.setFloating],
  );
  const close = () => {
    onClose();
    if (anchor?.isConnected) anchor.focus({ preventScroll: true });
  };
  useEscape(!phone, close);
  useEffect(() => {
    const at = reference ?? anchor;
    if (at) anch.setReference(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, reference]);
  useEffect(() => {
    if (phone) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [phone, anchor, onClose]);

  if (phone)
    return (
      <Sheet onClose={onClose} className="emoji-sheet" label="Emojis">
        <div className="emoji-picker in-sheet">
          <EmojiPickerBody onPick={(code) => onPick(code)} />
        </div>
      </Sheet>
    );
  return (
    <Portal>
      <div
        ref={setPanel}
        className="emoji-picker"
        role="dialog"
        aria-label="Emojis"
        style={anch.style}
        data-side={anch.positioned ? anch.side : undefined}
        data-layer={anch.layer}
      >
        <EmojiPickerBody onPick={(code) => onPick(code)} autoFocus={anch.positioned} />
      </div>
    </Portal>
  );
}
