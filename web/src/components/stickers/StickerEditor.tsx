// Figurinhas: o editor. Cria a partir de um arquivo, de uma imagem colada ou de uma imagem enviada numa conversa
// (recorte, fundo, contorno e detalhes) e edita os detalhes de uma figurinha que já existe. Carrega sob demanda.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { dhash, edgeLooksUniform, hasTransparency, resizeArea, workSide, type MaskOp, type Raster, type Rect } from '@shared/stickerEdit';
import {
  cleanEmojis,
  cleanKeywords,
  composerEmoji,
  isEmoji,
  nameFromFileName,
  STICKER_LIMITS,
  type MessageStickerLive,
  type StickerItem,
  type StickerPack,
  type StickerPick,
  type StickerScope,
} from '@shared/stickers';
import { ApiError } from '../../lib/api';
import {
  animatedProblem,
  applyAffine,
  bitmapToRaster,
  closeImage,
  encodeSticker,
  firstStepSize,
  invert,
  loadImageSource,
  makePoster,
  mapRect,
  maskWorker,
  paintRaster,
  releaseMaskWorker,
  viewAffine,
  viewSize,
  warmMaskWorker,
  webpEncodeSupported,
  workGeometry,
  type LoadedImage,
  type MaskWorker,
  type RenderInput,
  type RenderOutput,
  type Rotation,
} from '../../lib/stickerImage';
import {
  blockedReasonHere,
  createSticker,
  isComposerOpen,
  sendSticker,
  stickerAdmin,
  stickerErrorText,
  stickersHere,
  toUnicode,
  useStickerCaps,
  useStickers,
} from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { EmojiPickerBody } from '../EmojiPicker';
import { Icon, type IconName } from '../Icon';
import { Portal, Sheet, useAnchored, useEscape, useIsPhone } from '../overlay';
import { Field, FileButton, Modal, Spinner, Toggle, confirmDialog } from '../ui';
import { ImportStickersModal, defaultPackId, usePackTargets } from './ImportStickersModal';
import { NewPackDialog } from './StickerMenuItems';
import { StickerView } from './StickerView';
import './studio.css';

export interface StickerEditorProps {
  source?:
    | { kind: 'file'; file: File }
    | { kind: 'message'; messageId: string; url: string; name: string } // "Criar figurinha" de uma imagem enviada
    | { kind: 'sticker'; sticker: StickerItem | StickerPick }; // só figurinhas editáveis: abre em modo detalhes
  target?: { packId?: string };
  room?: { rid: string; tmid?: string | null; tshow?: boolean }; // pode mostrar "Salvar e enviar"
  onClose(): void;
  onSaved?(item: StickerItem, sent: boolean): void;
}

export default function StickerEditor(props: StickerEditorProps) {
  const caps = useStickerCaps();
  if (!caps.canAuthor) return <NoAuthor onClose={props.onClose} />;
  if (props.source?.kind === 'sticker') return <DetailsEditor sticker={props.source.sticker} onClose={props.onClose} onSaved={props.onSaved} />;
  return <CreateEditor {...props} />;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const NEW_PACK = '__new';
const DEFAULT_TOLERANCE = 24;
const EMPTY_TEXT = 'Nada ficou visível na figurinha. Desfaça a última ação ou use “Restaurar tudo”.';

const toast = (text: string) => useStore.getState().toast(text, 'success');
// Texto do servidor, ou a mensagem local (codificação, recorte); falha de rede vira o texto genérico.
const errText = (e: unknown) => (e instanceof ApiError || e instanceof TypeError || !(e instanceof Error) ? stickerErrorText(e) : e.message);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function NoAuthor({ onClose }: { onClose(): void }) {
  return (
    <Modal size="sm" title="Nova figurinha" onClose={onClose}>
      <p className="muted">Seu perfil não cria figurinhas. Você pode usar as da organização e favoritar as que receber.</p>
    </Modal>
  );
}

// Erro do salvar no fim do corpo do modal: rola até ele, para o clique em "Salvar" não parecer sem efeito.
function SaveError({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: 'nearest' }), [text]);
  return (
    <div ref={ref} className="callout warn stk-error" role="alert">
      <Icon name="error" />
      <span>{text}</span>
    </div>
  );
}

// ---------- Campos de detalhes ----------

interface Details {
  name: string;
  emojis: string[];
  keywords: string[];
  packId: string | null; // null = ainda no padrão; '' = "Minhas figurinhas" (criado pelo servidor)
}

function PackSelect({
  value,
  personal,
  org,
  autoPersonal,
  onChange,
  onNew,
}: {
  value: string | null;
  personal: StickerPack[];
  org: StickerPack[];
  autoPersonal: boolean;
  onChange(packId: string): void;
  onNew(): void;
}) {
  const none = !personal.length && !org.length && !autoPersonal;
  return (
    <Field label="Pacote">
      <select value={value ?? ''} onChange={(e) => (e.target.value === NEW_PACK ? onNew() : onChange(e.target.value))}>
        {none && (
          <option value="" disabled>
            Escolha um pacote
          </option>
        )}
        {personal.map((p) => (
          <option key={p._id} value={p._id}>
            {p.name}
          </option>
        ))}
        {autoPersonal && <option value="">Minhas figurinhas</option>}
        {org.length > 0 && (
          <optgroup label="Organização">
            {org.map((p) => (
              <option key={p._id} value={p._id}>
                {p.status === 'draft' ? `${p.name} (rascunho)` : p.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={NEW_PACK}>Novo pacote…</option>
      </select>
    </Field>
  );
}

// O seletor de emojis sem os personalizados: a figurinha guarda só Unicode.
function EmojiPopover({ anchor, onPick, onClose }: { anchor: HTMLElement | null; onPick(unicode: string): void; onClose(): void }) {
  const phone = useIsPhone();
  const panel = useRef<HTMLDivElement | null>(null);
  const anch = useAnchored({ open: !phone, placement: 'bottom-start', minHeight: 240 });
  const close = useCallback(() => {
    onClose();
    if (anchor?.isConnected) anchor.focus({ preventScroll: true });
  }, [anchor, onClose]);
  useEscape(!phone, close);
  useEffect(() => {
    if (anchor) anch.setReference(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  useEffect(() => {
    if (phone) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [phone, anchor, onClose]);
  const pick = (_code: string, unicode: string | null) => {
    if (!unicode) return;
    onPick(unicode);
    close();
  };
  if (phone)
    return (
      <Sheet onClose={onClose} className="emoji-sheet" label="Emojis">
        <div className="emoji-picker in-sheet">
          <EmojiPickerBody unicodeOnly onPick={pick} />
        </div>
      </Sheet>
    );
  return (
    <Portal>
      <div
        ref={(n) => {
          panel.current = n;
          anch.setFloating(n);
        }}
        className="emoji-picker"
        role="dialog"
        aria-label="Emojis"
        style={anch.style}
        data-side={anch.positioned ? anch.side : undefined}
        data-layer={anch.layer}
      >
        <EmojiPickerBody unicodeOnly onPick={pick} autoFocus={anch.positioned} />
      </div>
    </Portal>
  );
}

// Sem <label> em volta: num rótulo com botões, clicar no texto acionaria o "remover" do primeiro chip.
function EmojiField({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const [picker, setPicker] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const full = value.length >= STICKER_LIMITS.emojisMax;
  const add = (list: string[]) => onChange(cleanEmojis([...value, ...list]));
  const typed = (t: string) => {
    const e = composerEmoji(t, toUnicode);
    if (e) {
      add([e]);
      setText('');
    } else setText(t);
    setBad(false);
  };
  // Enter, vírgula ou sair do campo: o que sobrou só entra se for emoji (vários de uma vez, colados, também).
  const settle = () => {
    const t = text.trim();
    if (!t) return;
    const parts = Array.from(new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(t.replace(/[\s,]+/g, '')), (x) => x.segment);
    if (parts.length && parts.every(isEmoji)) {
      add(parts);
      setText('');
    } else setBad(true);
  };
  return (
    <div className="field">
      <span className="field-label" id={`${id}-l`}>
        Emojis
      </span>
      <div className="picker">
        <div className="chips stk-chips" role="group" aria-labelledby={`${id}-l`}>
          {value.map((e) => (
            <span key={e} className="chip stk-emoji-chip">
              <span className="emoji">{e}</span>
              <button type="button" aria-label={`Remover ${e}`} onClick={() => onChange(value.filter((x) => x !== e))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <input
            value={text}
            disabled={full}
            aria-labelledby={`${id}-l`}
            aria-describedby={`${id}-h`}
            aria-invalid={bad || undefined}
            onChange={(e) => typed(e.target.value)}
            onBlur={settle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                settle();
              } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
            }}
          />
          <button ref={btn} type="button" className="icon-btn" title="Escolher emoji" aria-label="Escolher emoji" disabled={full} onClick={() => setPicker((v) => !v)}>
            <Icon name="react" size={18} />
          </button>
        </div>
      </div>
      <span className="field-hint" id={`${id}-h`}>
        {bad ? 'Use um emoji, como 😂 ou :joy:.' : 'Ajudam a achar a figurinha e aparecem nas sugestões.'}
      </span>
      {picker && <EmojiPopover anchor={btn.current} onPick={(u) => add([u])} onClose={() => setPicker(false)} />}
    </div>
  );
}

function KeywordField({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const id = useId();
  const [text, setText] = useState('');
  const full = value.length >= STICKER_LIMITS.keywordsMax;
  const settle = (t: string) => {
    if (t.trim()) onChange(cleanKeywords([...value, ...t.split(',')]));
    setText('');
  };
  return (
    <div className="field">
      <span className="field-label" id={`${id}-l`}>
        Palavras-chave
      </span>
      <div className="picker">
        <div className="chips stk-chips" role="group" aria-labelledby={`${id}-l`}>
          {value.map((k) => (
            <span key={k} className="chip">
              {k}
              <button type="button" aria-label={`Remover ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <input
            value={text}
            disabled={full}
            maxLength={STICKER_LIMITS.keywordMax * 4}
            aria-labelledby={`${id}-l`}
            aria-describedby={`${id}-h`}
            onChange={(e) => (e.target.value.includes(',') ? settle(e.target.value) : setText(e.target.value))}
            onBlur={() => settle(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                settle(text);
              } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
            }}
          />
        </div>
      </div>
      <span className="field-hint" id={`${id}-h`}>
        Ex.: obrigado, valeu, top
      </span>
    </div>
  );
}

function DetailsFields({
  value,
  onChange,
  packs,
  onNewPack,
}: {
  value: Details;
  onChange(d: Details): void;
  packs: { personal: StickerPack[]; org: StickerPack[]; autoPersonal: boolean; value: string | null };
  onNewPack(): void;
}) {
  return (
    <div className="form stk-details">
      <Field label="Nome" required>
        <input value={value.name} maxLength={STICKER_LIMITS.nameMax} required onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </Field>
      <EmojiField value={value.emojis} onChange={(emojis) => onChange({ ...value, emojis })} />
      <KeywordField value={value.keywords} onChange={(keywords) => onChange({ ...value, keywords })} />
      <PackSelect
        value={packs.value}
        personal={packs.personal}
        org={packs.org}
        autoPersonal={packs.autoPersonal}
        onChange={(packId) => onChange({ ...value, packId })}
        onNew={onNewPack}
      />
    </div>
  );
}

// ---------- Histórico (desfazer/refazer) ----------

interface Edit {
  crop: Rect; // coordenadas da imagem decodificada (antes de girar)
  aspect: 'free' | 'square';
  rotate: Rotation;
  flip: boolean;
  trim: boolean;
  ops: MaskOp[];
  outline: boolean;
  outlinePx: number; // px da figurinha final
}

// commit = um passo; live muda sem passo até end (um gesto inteiro: arrastar, um traço, um controle deslizante).
function useHistory<T>(initial: () => T) {
  const [h, setH] = useState(() => ({ past: [] as T[], present: initial(), future: [] as T[] }));
  const gesture = useRef<{ base: T } | null>(null);
  const api = useMemo(() => {
    const push = (past: T[], s: T) => [...past, s].slice(-STICKER_LIMITS.editorHistory);
    const end = () => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      setH((cur) => (cur.present === g.base ? cur : { past: push(cur.past, g.base), present: cur.present, future: [] }));
    };
    return {
      live(fn: (cur: T) => T) {
        setH((cur) => {
          if (!gesture.current) gesture.current = { base: cur.present };
          return { ...cur, present: fn(cur.present) };
        });
      },
      end,
      cancel() {
        const g = gesture.current;
        if (!g) return;
        gesture.current = null;
        setH((cur) => ({ ...cur, present: g.base }));
      },
      commit(fn: (cur: T) => T) {
        const g = gesture.current;
        gesture.current = null;
        setH((cur) => {
          const next = fn(cur.present);
          if (next === cur.present && !g) return cur;
          return { past: push(cur.past, g ? g.base : cur.present), present: next, future: [] };
        });
      },
      undo() {
        end();
        setH((cur) => (cur.past.length ? { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future] } : cur));
      },
      redo() {
        end();
        setH((cur) => (cur.future.length ? { past: push(cur.past, cur.present), present: cur.future[0], future: cur.future.slice(1) } : cur));
      },
    };
  }, []);
  return { present: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0, ...api };
}

// Índice do último "fundo liso" ou "apagar área" depois do último "Restaurar tudo": é ele que a Tolerância ajusta.
function lastAdjustable(ops: readonly MaskOp[]): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const k = ops[i].kind;
    if (k === 'reset') return -1;
    if (k === 'flat-bg' || k === 'fill') return i;
  }
  return -1;
}

const hasEffectiveMask = (ops: readonly MaskOp[]) => ops.length > 0 && ops[ops.length - 1].kind !== 'reset';

// ---------- Palco ----------

type Tool = 'fill' | 'brush' | null;
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const BRUSH_PX = { P: 8, M: 20, G: 40 } as const;
const ZOOM_MAX = 8;
const FIT = 0.9; // a imagem não encosta na borda do palco: sobra lugar para as alças
const MIN_CROP = 48; // px de origem: o encaixe dobra no máximo, e a figurinha precisa de 96 px no lado maior
const OUTLINE_MIN = 2;
const OUTLINE_MAX = 16;

interface Pt {
  x: number;
  y: number;
}
type Gesture =
  | { kind: 'pan'; id: number; start: Pt; pan0: Pt }
  | { kind: 'crop'; id: number; mode: Handle | 'move'; start: Pt; rect0: Rect; rect: Rect | null }
  | { kind: 'brush'; id: number; points: Array<[number, number]>; last: Pt }
  | { kind: 'fill'; id: number; start: Pt }
  | { kind: 'pinch'; d0: number; mid0: Pt; zoom0: number; disp0: number; o0: Pt };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Novo retângulo (vista) ao arrastar uma alça; no quadrado, o canto oposto (ou o meio do lado oposto) fica parado.
function resizeView(r0: Rect, mode: Handle | 'move', dx: number, dy: number, square: boolean, vw: number, vh: number): Rect {
  if (mode === 'move') return { ...r0, x: clamp(r0.x + dx, 0, vw - r0.width), y: clamp(r0.y + dy, 0, vh - r0.height) };
  const min = Math.min(MIN_CROP, vw, vh);
  let x1 = r0.x;
  let y1 = r0.y;
  let x2 = r0.x + r0.width;
  let y2 = r0.y + r0.height;
  if (mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - min);
  if (mode.includes('e')) x2 = clamp(x2 + dx, x1 + min, vw);
  if (mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - min);
  if (mode.includes('s')) y2 = clamp(y2 + dy, y1 + min, vh);
  if (!square) return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  if (mode.length === 2) {
    const ax = mode.includes('w') ? r0.x + r0.width : r0.x;
    const ay = mode.includes('n') ? r0.y + r0.height : r0.y;
    const room = Math.min(mode.includes('w') ? ax : vw - ax, mode.includes('n') ? ay : vh - ay);
    const side = clamp(Math.max(x2 - x1, y2 - y1), min, room);
    return { x: mode.includes('w') ? ax - side : ax, y: mode.includes('n') ? ay - side : ay, width: side, height: side };
  }
  const horizontal = mode === 'e' || mode === 'w';
  const c = horizontal ? r0.y + r0.height / 2 : r0.x + r0.width / 2;
  const span = horizontal ? vh : vw;
  const side = clamp(horizontal ? x2 - x1 : y2 - y1, min, Math.min(horizontal ? (mode === 'w' ? r0.x + r0.width : vw - r0.x) : mode === 'n' ? r0.y + r0.height : vh - r0.y, span));
  const off = clamp(c - side / 2, 0, span - side);
  if (horizontal) return { x: mode === 'w' ? r0.x + r0.width - side : r0.x, y: off, width: side, height: side };
  return { x: off, y: mode === 'n' ? r0.y + r0.height - side : r0.y, width: side, height: side };
}

function toSourceRect(vi: ReturnType<typeof invert>, r: Rect, W: number, H: number): Rect {
  const s = mapRect(vi, r);
  const x = clamp(Math.round(s.x), 0, W - 1);
  const y = clamp(Math.round(s.y), 0, H - 1);
  return { x, y, width: clamp(Math.round(s.width), 1, W - x), height: clamp(Math.round(s.height), 1, H - y) };
}

interface StageProps {
  W: number;
  H: number;
  rotate: Rotation;
  flip: boolean;
  crop: Rect;
  square: boolean;
  tool: Tool;
  erase: boolean;
  brushPx: number;
  zoom: number;
  pan: Pt;
  setView(zoom: number, pan: Pt): void;
  zoomRef: MutableRefObject<((k: number) => void) | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onCrop(r: Rect): void;
  onStroke(phase: 'start' | 'move' | 'end' | 'cancel', op?: MaskOp): void;
  onFill(x: number, y: number): void;
}

// memo: o palco só renderiza de novo quando muda algo dele (a tolerância e o tamanho estimado não mexem nele).
const Stage = memo(function Stage(p: StageProps) {
  const box = useRef<HTMLDivElement>(null);
  const [S, setS] = useState(360);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [live, setLive] = useState<Rect | null>(null);
  const g = useRef<Gesture | null>(null);
  const pts = useRef(new Map<number, Pt>());
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const sync = () => setS(el.clientWidth || 360);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const V = useMemo(() => viewAffine(p.W, p.H, p.rotate, p.flip), [p.W, p.H, p.rotate, p.flip]);
  const Vi = useMemo(() => invert(V), [V]);
  const vs = viewSize(p.W, p.H, p.rotate);
  const fit = (S * FIT) / Math.max(vs.width, vs.height);
  const disp = fit * p.zoom;
  const ox = (S - vs.width * disp) / 2 + p.pan.x;
  const oy = (S - vs.height * disp) / 2 + p.pan.y;
  const cv = live ?? mapRect(V, p.crop);
  const frame = { left: ox + cv.x * disp, top: oy + cv.y * disp, width: cv.width * disp, height: cv.height * disp };

  // Zoom em torno de um ponto do palco: o ponto da imagem embaixo dele fica onde está.
  const zoomAt = (at: Pt, z: number, from = { disp, ox, oy }) => {
    const zoom = clamp(z, 1, ZOOM_MAX);
    const d2 = fit * zoom;
    const vx = (at.x - from.ox) / from.disp;
    const vy = (at.y - from.oy) / from.disp;
    const pan = zoom === 1 ? { x: 0, y: 0 } : { x: at.x - vx * d2 - (S - vs.width * d2) / 2, y: at.y - vy * d2 - (S - vs.height * d2) / 2 };
    const lim = { x: (vs.width * d2) / 2, y: (vs.height * d2) / 2 };
    p.setView(zoom, { x: clamp(pan.x, -lim.x, lim.x), y: clamp(pan.y, -lim.y, lim.y) });
  };
  const latest = useRef(zoomAt);
  latest.current = zoomAt;
  const zoomNow = useRef(p.zoom);
  zoomNow.current = p.zoom;
  p.zoomRef.current = (k: number) => latest.current({ x: S / 2, y: S / 2 }, zoomNow.current * k);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Pinça no trackpad chega como Ctrl + roda, com passos bem menores.
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      latest.current({ x: e.clientX - r.left, y: e.clientY - r.top }, zoomNow.current * k);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toSource = (q: Pt) => applyAffine(Vi, (q.x - ox) / disp, (q.y - oy) / disp);
  const stroke = (points: Array<[number, number]>): MaskOp => ({ kind: 'brush', points: [...points], radius: p.brushPx / 2 / disp, erase: p.erase });

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    box.current?.setPointerCapture(e.pointerId);
    const q = local(e);
    pts.current.set(e.pointerId, q);
    if (pts.current.size === 2) {
      // Dois dedos: pinça e arrasto, desfazendo o que um dedo tinha começado.
      const cur = g.current;
      if (cur?.kind === 'brush') p.onStroke('cancel');
      if (cur?.kind === 'crop') setLive(null);
      const [a, b] = [...pts.current.values()];
      g.current = { kind: 'pinch', d0: Math.max(1, dist(a, b)), mid0: mid(a, b), zoom0: p.zoom, disp0: disp, o0: { x: ox, y: oy } };
      return;
    }
    if (pts.current.size > 2) return;
    if (p.tool === 'brush') {
      const points: Array<[number, number]> = [toSource(q)];
      g.current = { kind: 'brush', id: e.pointerId, points, last: q };
      p.onStroke('start', stroke(points));
      return;
    }
    if (p.tool === 'fill') {
      g.current = { kind: 'fill', id: e.pointerId, start: q };
      return;
    }
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    const inside = q.x >= frame.left && q.x <= frame.left + frame.width && q.y >= frame.top && q.y <= frame.top + frame.height;
    if (handle || inside) g.current = { kind: 'crop', id: e.pointerId, mode: handle ?? 'move', start: q, rect0: cv, rect: null };
    else g.current = { kind: 'pan', id: e.pointerId, start: q, pan0: p.pan };
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const q = local(e);
    if (p.tool === 'brush' && e.pointerType !== 'touch') setCursor(q);
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, q);
    const cur = g.current;
    if (!cur) return;
    if (cur.kind === 'pinch') {
      const [a, b] = [...pts.current.values()];
      if (!b) return;
      const m = mid(a, b);
      // O ponto da imagem sob o meio dos dedos acompanha os dedos.
      const zoom = clamp((cur.zoom0 * dist(a, b)) / cur.d0, 1, ZOOM_MAX);
      const vx = (cur.mid0.x - cur.o0.x) / cur.disp0;
      const vy = (cur.mid0.y - cur.o0.y) / cur.disp0;
      const d2 = fit * zoom;
      const lim = { x: (vs.width * d2) / 2, y: (vs.height * d2) / 2 };
      p.setView(zoom, { x: clamp(m.x - vx * d2 - (S - vs.width * d2) / 2, -lim.x, lim.x), y: clamp(m.y - vy * d2 - (S - vs.height * d2) / 2, -lim.y, lim.y) });
      return;
    }
    if (cur.id !== e.pointerId) return;
    if (cur.kind === 'pan') {
      const lim = { x: (vs.width * disp) / 2, y: (vs.height * disp) / 2 };
      p.setView(p.zoom, { x: clamp(cur.pan0.x + q.x - cur.start.x, -lim.x, lim.x), y: clamp(cur.pan0.y + q.y - cur.start.y, -lim.y, lim.y) });
    } else if (cur.kind === 'brush') {
      if (dist(q, cur.last) < 2) return;
      cur.last = q;
      cur.points.push(toSource(q));
      p.onStroke('move', stroke(cur.points));
    } else if (cur.kind === 'crop') {
      cur.rect = resizeView(cur.rect0, cur.mode, (q.x - cur.start.x) / disp, (q.y - cur.start.y) / disp, p.square, vs.width, vs.height);
      setLive(cur.rect);
    }
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    const cur = g.current;
    if (!cur) return;
    if (cur.kind === 'pinch') {
      if (pts.current.size < 2) g.current = null; // o dedo que sobra não faz nada até sair
      return;
    }
    if (cur.id !== e.pointerId) return;
    g.current = null;
    const cancel = e.type === 'pointercancel';
    if (cur.kind === 'brush') p.onStroke(cancel ? 'cancel' : 'end');
    else if (cur.kind === 'fill') {
      const q = local(e);
      if (cancel || dist(q, cur.start) > 6) return;
      // Fora do recorte não há o que apagar na figurinha (e o palco mostra só a máscara dela).
      const [x, y] = toSource(q);
      const c = p.crop;
      if (x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height) p.onFill(x, y);
    } else if (cur.kind === 'crop') {
      setLive(null);
      if (!cancel && cur.rect) p.onCrop(toSourceRect(Vi, cur.rect, p.W, p.H));
    }
  };

  // Teclado: setas movem o recorte; com Shift, mudam o tamanho (canto inferior direito).
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const step = (e.altKey ? 1 : 8) / Math.max(1e-6, disp); // 8 px de tela (1 com Alt), em px da vista
    const r = resizeView(mapRect(V, p.crop), e.shiftKey ? 'se' : 'move', d[0] * step, d[1] * step, p.square, vs.width, vs.height);
    p.onCrop(toSourceRect(Vi, r, p.W, p.H));
  };

  const brushR = p.brushPx / 2;
  return (
    <div
      ref={box}
      className="stk-stage"
      data-tool={p.tool ?? undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setCursor(null)}
    >
      <canvas ref={p.canvasRef} className="stk-stage-img" style={{ left: ox, top: oy, width: vs.width * disp, height: vs.height * disp }} />
      <div
        className="stk-crop"
        style={frame}
        tabIndex={p.tool ? -1 : 0}
        role="group"
        aria-label="Área do recorte"
        aria-roledescription="recorte"
        onKeyDown={key}
        data-busy={live ? '' : undefined}
      >
        {!p.tool && HANDLES.map((h) => <span key={h} className={`stk-handle ${h}`} data-handle={h} aria-hidden="true" />)}
      </div>
      {p.tool === 'brush' && cursor && (
        <span className="stk-brush-cursor" style={{ left: cursor.x - brushR, top: cursor.y - brushR, width: brushR * 2, height: brushR * 2 }} aria-hidden="true" />
      )}
    </div>
  );
});

// ---------- Seções da coluna da direita (acordeão no celular) ----------

type SectionId = 'crop' | 'bg' | 'outline' | 'details';

function Section({
  id,
  title,
  phone,
  open,
  onToggle,
  children,
}: {
  id?: SectionId;
  title: string;
  phone: boolean;
  open?: boolean;
  onToggle?(id: SectionId): void;
  children: ReactNode;
}) {
  const bodyId = useId();
  if (!phone || !id)
    return (
      <section className="stk-section">
        <h3 className="stk-section-title">{title}</h3>
        {children}
      </section>
    );
  return (
    <section className="stk-section" data-open={open ? '' : undefined}>
      <h3 className="stk-section-title">
        <button type="button" className="stk-acc" aria-expanded={!!open} aria-controls={bodyId} onClick={() => onToggle?.(id)}>
          {title}
          <Icon name="chevron-down" size={16} />
        </button>
      </h3>
      <div id={bodyId} className="stk-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function ToolButton({ icon, label, shortcut, disabled, onClick }: { icon: IconName; label: string; shortcut?: string; disabled?: boolean; onClick(): void }) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button type="button" className="tool-btn" title={title} aria-label={label} aria-keyshortcuts={shortcut} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={18} />
    </button>
  );
}

// ---------- Estúdio da figurinha estática ----------

interface StudioHandle {
  output(): Promise<RenderOutput>;
  edit(): Edit; // o estado da imagem agora: o mesmo objeto enquanto nada muda (desfazer volta ao objeto anterior)
  edited(): boolean; // a imagem mudou desde que abriu
}

interface StudioProps {
  img: LoadedImage;
  phone: boolean;
  limitKB: number;
  top?: ReactNode;
  details: ReactNode;
  handleRef: MutableRefObject<StudioHandle | null>;
  onReady(ready: boolean): void;
}

// A parte preenchida do controle deslizante (o trilho é desenhado no CSS).
const fill = (v: number, min: number, max: number) => ({ '--stk-fill': `${((v - min) / (max - min)) * 100}%` }) as CSSProperties;

const kbFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

// As prévias mostram a figurinha em 80 px no lado maior, como num balão. Elas mudam a cada passo de um gesto, sem
// passar pelo React: os pixels e o tamanho vão direto no canvas.
function paintTile(canvas: HTMLCanvasElement | null, r: Raster | null) {
  if (!canvas) return;
  if (!r) {
    canvas.style.visibility = 'hidden';
    return;
  }
  paintRaster(canvas, r);
  const k = 80 / Math.max(r.width, r.height);
  canvas.style.width = `${Math.max(1, Math.round(r.width * k))}px`;
  canvas.style.height = `${Math.max(1, Math.round(r.height * k))}px`;
  canvas.style.visibility = '';
}

function StaticStudio({ img, phone, limitKB, top, details, handleRef, onReady }: StudioProps) {
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const hist = useHistory<Edit>(() => ({
    crop: { x: 0, y: 0, width: W, height: H },
    aspect: 'free',
    rotate: 0,
    flip: false,
    trim: img.probe.alpha !== false && hasTransparency(bitmapToRaster(img.bitmap, { maxSide: 256 }, img.small)),
    ops: [],
    outline: false,
    outlinePx: 8,
  }));
  const e = hist.present;
  const initial = useRef(e);
  const [tool, setTool] = useState<Tool>(null);
  const [erase, setErase] = useState(true);
  const [brush, setBrush] = useState<keyof typeof BRUSH_PX>('M');
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [view, setViewState] = useState<{ zoom: number; pan: Pt }>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [open, setOpen] = useState<SectionId | null>('crop');
  const [result, setResult] = useState<RenderOutput | null>(null);
  const [sized, setSized] = useState<{ of: Raster; bytes: number; mime: string; w: number; h: number } | null>(null);
  const zoomRef = useRef<((k: number) => void) | null>(null);
  const stageCanvas = useRef<HTMLCanvasElement>(null);
  // As prévias claro/escuro; um canvas novo (a Prévia muda de coluna no celular) já nasce com a última.
  const tiles = useRef<{ light: HTMLCanvasElement | null; dark: HTMLCanvasElement | null; last: Raster | null }>({ light: null, dark: null, last: null });
  const tileLight = useCallback((c: HTMLCanvasElement | null) => {
    tiles.current.light = c;
    paintTile(c, tiles.current.last);
  }, []);
  const tileDark = useCallback((c: HTMLCanvasElement | null) => {
    tiles.current.dark = c;
    paintTile(c, tiles.current.last);
  }, []);
  useEscape(!!tool, () => setTool(null));

  // Passo 1: recorte, giro e espelho da imagem decodificada para a área de trabalho (≤ 1024).
  // A área de trabalho deixa folga para o contorno mais grosso: mudar a espessura não refaz a área nem a máscara.
  const o = e.outline ? e.outlinePx : 0;
  const room = e.outline ? OUTLINE_MAX : 0;
  const vs = viewSize(W, H, e.rotate);
  const stageSide = workSide(Math.max(vs.width, vs.height), room);
  const full = e.crop.x === 0 && e.crop.y === 0 && e.crop.width === W && e.crop.height === H;
  const cropSide = workSide(Math.max(e.crop.width, e.crop.height), room);
  const stageGeom = useMemo(() => workGeometry(W, H, { rotate: e.rotate, flip: e.flip }, stageSide), [W, H, e.rotate, e.flip, stageSide]);
  const stageRaster = useMemo(
    () => bitmapToRaster(img.bitmap, { rotate: e.rotate, flip: e.flip, maxSide: stageSide }, img.small),
    [img.bitmap, img.small, e.rotate, e.flip, stageSide],
  );
  const workGeom = useMemo(
    () => (full ? stageGeom : workGeometry(W, H, { crop: e.crop, rotate: e.rotate, flip: e.flip }, cropSide)),
    [full, stageGeom, W, H, e.crop, e.rotate, e.flip, cropSide],
  );
  const workRaster = useMemo(
    () => (full ? stageRaster : bitmapToRaster(img.bitmap, { crop: e.crop, rotate: e.rotate, flip: e.flip, maxSide: cropSide })),
    [full, stageRaster, img.bitmap, e.crop, e.rotate, e.flip, cropSide],
  );
  const uniform = useMemo(() => edgeLooksUniform(workRaster, DEFAULT_TOLERANCE), [workRaster]);

  // A espessura vai em px da figurinha final: o Worker a converte depois de saber o tamanho sem as margens.
  const input = useMemo<RenderInput>(
    () => ({
      raster: workRaster,
      ops: e.ops,
      outlinePx: o,
      trim: e.trim,
      affine: workGeom.affine,
      scale: workGeom.scale,
      stage: full ? undefined : { raster: stageRaster, affine: stageGeom.affine },
    }),
    [workRaster, e.ops, o, e.trim, workGeom, full, stageRaster, stageGeom],
  );

  // Passos 2 a 5 no Worker: no máximo uma prévia por quadro; um pedido ultrapassado por outro mais novo é descartado.
  const worker = useRef<MaskWorker | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  // O traço em andamento vai direto para a prévia, sem passar pelo React; entra no histórico ao soltar.
  const liveOp = useRef<MaskOp | null>(null);
  // Tolerância sendo ajustada: a cada passo só o palco e as prévias pequenas (o preenchimento é a parte cara); a
  // figurinha inteira sai no fim do gesto, reaproveitando a máscara que o palco acabou de calcular. settle: o gesto
  // acabou; a figurinha vem depois do palco, para um toque na seta não esperar as duas coisas juntas. staged: a
  // entrada cujo palco já saiu, para não repeti-lo quando a tecla solta durante a prévia.
  const quick = useRef(false);
  const loop = useRef({ busy: false, dirty: false, settle: false, raf: 0, since: 0, alive: true, staged: null as RenderInput | null });
  useEffect(() => {
    const w = maskWorker();
    worker.current = w;
    const l = loop.current;
    l.alive = true;
    return () => {
      l.alive = false;
      cancelAnimationFrame(l.raf);
      l.raf = 0;
      w.dispose();
      worker.current = null;
    };
  }, []);
  const run = useCallback(async () => {
    const l = loop.current;
    l.raf = 0;
    if (l.busy) {
      l.dirty = true;
      return;
    }
    const w = worker.current;
    if (!w) return;
    l.busy = true;
    const since = l.since;
    l.since = 0;
    const stroke = liveOp.current;
    const cur = inputRef.current;
    let stageOnly = !!stroke || quick.current;
    if (stageOnly && !stroke && l.settle && l.staged === cur) {
      l.settle = false;
      quick.current = false;
      stageOnly = false;
    }
    l.staged = stageOnly && !stroke ? cur : null;
    try {
      const res = await w.render(stroke ? { ...cur, ops: [...cur.ops, stroke], stageOnly } : stageOnly ? { ...cur, stageOnly } : cur);
      if (!l.alive) return;
      if (stageCanvas.current) paintRaster(stageCanvas.current, res.stage);
      // As prévias acompanham o palco a cada passo; a figurinha inteira (tamanho, Salvar) sai quando o gesto termina.
      const t = tiles.current;
      t.last = res.preview;
      paintTile(t.light, res.preview);
      paintTile(t.dark, res.preview);
      if (!stageOnly) setResult(res);
      if (import.meta.env.DEV) console.info(`[figurinhas] prévia em ${Math.round(performance.now() - since)} ms${stageOnly ? ' (palco)' : ''}`);
    } catch (err) {
      if (l.alive) setResult({ stage: inputRef.current.raster, output: null, preview: null, error: errText(err) });
    } finally {
      l.busy = false;
      if (l.dirty && l.alive) {
        l.dirty = false;
        schedule();
      } else if (stageOnly && !stroke && l.settle && l.alive) {
        l.settle = false;
        quick.current = false;
        schedule();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const schedule = useCallback(() => {
    const l = loop.current;
    if (!l.since) l.since = performance.now();
    if (!l.raf) l.raf = requestAnimationFrame(() => void run());
  }, [run]);
  useEffect(() => schedule(), [input, schedule]);

  handleRef.current = {
    output: () => {
      const w = worker.current;
      if (!w) return Promise.reject(new Error(EMPTY_TEXT));
      return w.render(inputRef.current);
    },
    edit: () => hist.present,
    edited: () => hist.present !== initial.current,
  };
  useEffect(() => onReady(!!result?.output), [result, onReady]);

  // Tamanho estimado, 300 ms depois da última mudança.
  const output = result?.output ?? null;
  useEffect(() => {
    if (!output) return;
    let alive = true;
    const t = setTimeout(() => {
      firstStepSize(output)
        .then((s) => alive && setSized({ of: output, bytes: s.bytes, mime: s.mime, w: output.width, h: output.height }))
        .catch(() => undefined);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [output]);

  // Atalhos: desfazer/refazer e zoom, fora dos campos de texto.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest('input:not([type="range"], [type="checkbox"], [type="radio"]), textarea, select, [contenteditable="true"]')) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if (mod && k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) hist.redo();
        else hist.undo();
      } else if (mod && k === 'y') {
        ev.preventDefault();
        hist.redo();
      } else if (!mod && !ev.altKey && (ev.key === '+' || ev.key === '=')) {
        ev.preventDefault();
        zoomRef.current?.(1.25);
      } else if (!mod && !ev.altKey && (ev.key === '-' || ev.key === '−')) {
        ev.preventDefault();
        zoomRef.current?.(0.8);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hist.undo, hist.redo]);

  const adjustable = lastAdjustable(e.ops);
  const tolValue = adjustable >= 0 ? (e.ops[adjustable] as { tolerance: number }).tolerance : tolerance;
  const masked = hasEffectiveMask(e.ops);
  const { commit, live, end, undo, redo, canUndo, canRedo } = hist;
  const setView = useCallback((zoom: number, pan: Pt) => setViewState({ zoom, pan }), []);
  const toggle = useCallback((id: SectionId) => setOpen((cur) => (cur === id ? null : id)), []);
  const addOp = useCallback((op: MaskOp) => commit((cur) => ({ ...cur, ops: [...cur.ops, op] })), [commit]);
  const tolRef = useRef(tolerance);
  tolRef.current = tolerance;
  // Fim do ajuste da tolerância ou da espessura: um passo no histórico e a figurinha inteira.
  const endQuick = useCallback(() => {
    end();
    if (!quick.current) return;
    loop.current.settle = true;
    schedule();
  }, [end, schedule]);
  const onCrop = useCallback((crop: Rect) => commit((cur) => (sameRect(cur.crop, crop) ? cur : { ...cur, crop })), [commit]);
  const onFill = useCallback((x: number, y: number) => addOp({ kind: 'fill', x, y, tolerance: tolRef.current }), [addOp]);
  const onStroke = useCallback(
    (phase: 'start' | 'move' | 'end' | 'cancel', op?: MaskOp) => {
      if ((phase === 'start' || phase === 'move') && op) liveOp.current = op;
      else if (phase === 'end' && liveOp.current) {
        const done = liveOp.current;
        liveOp.current = null;
        addOp(done);
        return;
      } else liveOp.current = null;
      schedule();
    },
    [addOp, schedule],
  );

  // O tamanho vale só para a prévia que o gerou; uma nova volta a "…" sem outra renderização.
  const size = sized && sized.of === output ? sized : null;
  const over = !!size && size.bytes > limitKB * 1024;
  const sizeLine = !result
    ? '…'
    : !output
      ? (result.error ?? EMPTY_TEXT)
      : !size
        ? `${output.width} × ${output.height} px`
        : over
          ? `Passa do limite de ${limitKB} KB; a imagem será reduzida ao salvar.`
          : `${size.w} × ${size.h} px · ${size.mime === 'image/png' ? 'PNG' : 'WebP'} · ${kbFmt.format(Math.max(1, Math.round(size.bytes / 1024)))} KB`;

  // Cada parte da tela só renderiza de novo quando muda o que ela mostra: num celular fraco, o React em cada passo da
  // tolerância custava mais que a prévia.
  const preview = useMemo(
    () => (
      <Section title="Prévia" phone={phone}>
        <div className="stk-previews">
          <figure>
            <div className="stk-preview light">
              <canvas ref={tileLight} />
            </div>
            <figcaption>Tema claro</figcaption>
          </figure>
          <figure>
            <div className="stk-preview dark">
              <canvas ref={tileDark} />
            </div>
            <figcaption>Tema escuro</figcaption>
          </figure>
        </div>
        <p className={(!output && result) || over ? 'stk-size over' : 'stk-size'} aria-live="polite">
          {sizeLine}
        </p>
      </Section>
    ),
    [phone, output, result, over, sizeLine],
  );

  const tools = useMemo(
    () => (
      <div className="stk-tools" role="toolbar" aria-label="Ferramentas da imagem">
        <ToolButton icon="sticker-zoom-out" label="Diminuir zoom" shortcut="−" disabled={view.zoom <= 1} onClick={() => zoomRef.current?.(0.8)} />
        <ToolButton icon="sticker-zoom-in" label="Aumentar zoom" shortcut="+" disabled={view.zoom >= ZOOM_MAX} onClick={() => zoomRef.current?.(1.25)} />
        <span className="tool-sep" aria-hidden="true" />
        <ToolButton icon="sticker-rotate-left" label="Girar para a esquerda" onClick={() => commit((cur) => ({ ...cur, rotate: ((cur.rotate + 270) % 360) as Rotation }))} />
        <ToolButton icon="sticker-rotate-right" label="Girar para a direita" onClick={() => commit((cur) => ({ ...cur, rotate: ((cur.rotate + 90) % 360) as Rotation }))} />
        <ToolButton icon="sticker-flip" label="Espelhar" onClick={() => commit((cur) => ({ ...cur, flip: !cur.flip }))} />
        <span className="tool-sep" aria-hidden="true" />
        <ToolButton icon="sticker-undo" label="Desfazer" shortcut="Ctrl+Z" disabled={!canUndo} onClick={undo} />
        <ToolButton icon="sticker-redo" label="Refazer" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo} />
      </div>
    ),
    [view.zoom, canUndo, canRedo, commit, undo, redo],
  );

  const cropSection = useMemo(
    () => (
      <Section id="crop" title="Recorte" phone={phone} open={open === 'crop'} onToggle={toggle}>
        <div className="stk-row">
          <div className="seg-nav" role="radiogroup" aria-label="Formato do recorte">
            {(['free', 'square'] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={e.aspect === a}
                className={e.aspect === a ? 'on' : ''}
                onClick={() =>
                  commit((cur) => {
                    if (cur.aspect === a) return cur;
                    if (a === 'free') return { ...cur, aspect: a };
                    const side = Math.min(cur.crop.width, cur.crop.height);
                    return {
                      ...cur,
                      aspect: a,
                      crop: { x: cur.crop.x + Math.floor((cur.crop.width - side) / 2), y: cur.crop.y + Math.floor((cur.crop.height - side) / 2), width: side, height: side },
                    };
                  })
                }
              >
                {a === 'free' ? 'Livre' : 'Quadrado'}
              </button>
            ))}
          </div>
        </div>
        <div className="stk-toggle-row">
          <Icon name="sticker-trim" size={16} />
          <Toggle checked={e.trim} onChange={(trim) => commit((cur) => ({ ...cur, trim }))} label="Recortar margens transparentes" />
        </div>
      </Section>
    ),
    [phone, open, toggle, e.aspect, e.trim, commit],
  );

  const bgSection = useMemo(
    () => (
      <Section id="bg" title="Fundo" phone={phone} open={open === 'bg'} onToggle={toggle}>
        {uniform ? (
          <div className="stk-stack">
            <button type="button" className="btn small" onClick={() => addOp({ kind: 'flat-bg', tolerance })}>
              <Icon name="sticker-remove-bg" size={14} />
              Remover fundo liso
            </button>
            <p className="stk-hint">O fundo parece de uma cor só: dá para tirar com um clique.</p>
          </div>
        ) : (
          <p className="stk-hint">Para fotos, use o pincel em “Apagar” ou “Apagar área” sobre o fundo.</p>
        )}
        <div className="stk-row">
          <button type="button" className="btn small stk-tool" aria-pressed={tool === 'fill'} onClick={() => setTool((t) => (t === 'fill' ? null : 'fill'))}>
            <Icon name="sticker-fill" size={14} />
            Apagar área
          </button>
          <button type="button" className="btn small stk-tool" aria-pressed={tool === 'brush'} onClick={() => setTool((t) => (t === 'brush' ? null : 'brush'))}>
            <Icon name="sticker-brush" size={14} />
            Pincel
          </button>
        </div>
        {tool === 'fill' && <p className="stk-hint">Clique numa área da imagem para apagá-la.</p>}
        {tool === 'brush' && (
          <div className="stk-row">
            <div className="seg-nav" role="radiogroup" aria-label="Modo do pincel">
              {([true, false] as const).map((v) => (
                <button key={String(v)} type="button" role="radio" aria-checked={erase === v} className={erase === v ? 'on' : ''} onClick={() => setErase(v)}>
                  {v ? 'Apagar' : 'Restaurar'}
                </button>
              ))}
            </div>
            <div className="seg-nav" role="radiogroup" aria-label="Tamanho do pincel">
              {(['P', 'M', 'G'] as const).map((sz) => (
                <button key={sz} type="button" role="radio" aria-checked={brush === sz} className={brush === sz ? 'on' : ''} onClick={() => setBrush(sz)}>
                  {sz}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="stk-range">
          <span>Tolerância</span>
          <input
            type="range"
            min={0}
            max={100}
            value={tolValue}
            style={fill(tolValue, 0, 100)}
            onChange={(ev) => {
              const v = Number(ev.target.value);
              setTolerance(v);
              if (adjustable >= 0) {
                quick.current = true;
                loop.current.settle = false;
                live((cur) => {
                  const i = lastAdjustable(cur.ops);
                  return i < 0 ? cur : { ...cur, ops: cur.ops.map((op, j) => (j === i ? ({ ...op, tolerance: v } as MaskOp) : op)) };
                });
              }
            }}
            onPointerUp={endQuick}
            onKeyUp={endQuick}
            onBlur={endQuick}
          />
          <output>{tolValue}</output>
        </label>
        <button type="button" className="btn small ghost" disabled={!masked} onClick={() => addOp({ kind: 'reset' })}>
          Restaurar tudo
        </button>
      </Section>
    ),
    [phone, open, toggle, uniform, tool, erase, brush, tolValue, tolerance, adjustable, masked, addOp, live, endQuick],
  );

  const outlineSection = useMemo(
    () => (
      <Section id="outline" title="Contorno" phone={phone} open={open === 'outline'} onToggle={toggle}>
        <div className="stk-toggle-row">
          <Icon name="sticker-outline" size={16} />
          <Toggle checked={e.outline} onChange={(outline) => commit((cur) => ({ ...cur, outline }))} label="Contorno branco" />
        </div>
        <label className="stk-range">
          <span>Espessura</span>
          <input
            type="range"
            min={OUTLINE_MIN}
            max={OUTLINE_MAX}
            value={e.outlinePx}
            style={fill(e.outlinePx, OUTLINE_MIN, OUTLINE_MAX)}
            disabled={!e.outline}
            onChange={(ev) => {
              const v = Number(ev.target.value);
              // O palco não muda com o contorno: a cada passo só as prévias pequenas.
              quick.current = true;
              loop.current.settle = false;
              live((cur) => ({ ...cur, outlinePx: v }));
            }}
            onPointerUp={endQuick}
            onKeyUp={endQuick}
            onBlur={endQuick}
          />
          <output>{e.outlinePx} px</output>
        </label>
      </Section>
    ),
    [phone, open, toggle, e.outline, e.outlinePx, commit, live, endQuick],
  );

  const detailsSection = useMemo(
    () => (
      <Section id="details" title="Detalhes" phone={phone} open={open === 'details'} onToggle={toggle}>
        {details}
      </Section>
    ),
    [phone, open, toggle, details],
  );

  return (
    <div className="stk-editor">
      <div className="stk-stage-col">
        <Stage
          W={W}
          H={H}
          rotate={e.rotate}
          flip={e.flip}
          crop={e.crop}
          square={e.aspect === 'square'}
          tool={tool}
          erase={erase}
          brushPx={BRUSH_PX[brush]}
          zoom={view.zoom}
          pan={view.pan}
          setView={setView}
          zoomRef={zoomRef}
          canvasRef={stageCanvas}
          onCrop={onCrop}
          onFill={onFill}
          onStroke={onStroke}
        />
        {tools}
        {phone && preview}
      </div>
      <div className="stk-side">
        {top}
        {cropSection}
        {bgSection}
        {outlineSection}
        {!phone && preview}
        {detailsSection}
      </div>
    </div>
  );
}

// ---------- Animada ----------

function useObjectUrl(blob: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function AnimatedNotice({ firstFrame, onFirstFrame, problem }: { firstFrame: boolean; onFirstFrame(v: boolean): void; problem: string | null }) {
  return (
    <div className="stk-stack stk-anim-notice">
      <div className="callout info">
        <Icon name="info" />
        <span>Figurinhas animadas são enviadas como estão: sem recorte nem remoção de fundo.</span>
      </div>
      <Toggle checked={firstFrame} onChange={onFirstFrame} label="Usar só o primeiro quadro (figurinha estática)" />
      {problem && !firstFrame && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>{problem}</span>
        </div>
      )}
    </div>
  );
}

// ---------- Criar ----------

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function CreateEditor({ source, target, room, onClose, onSaved }: StickerEditorProps) {
  const caps = useStickerCaps();
  const phone = useIsPhone();
  const targets = usePackTargets(caps);
  const roomObj = useStore((s) => (room ? s.rooms[room.rid] : undefined));
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [loading, setLoading] = useState(source?.kind === 'file' || source?.kind === 'message');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [importing, setImporting] = useState(false);
  const [details, setDetails] = useState<Details>({ name: '', emojis: [], keywords: [], packId: null });
  const [newPack, setNewPack] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webp, setWebp] = useState(true);
  const studio = useRef<StudioHandle | null>(null);
  // A figurinha já criada nesta sessão (o envio falhou) e de que imagem e edição ela saiu.
  const created = useRef<{ item: StickerItem; img: LoadedImage; animated: boolean; edit: Edit | null } | null>(null);
  // O ponto de partida: imagem aberta, sem edição, com o nome tirado do arquivo.
  const pristine = useRef<{ img: LoadedImage | null; name: string }>({ img: null, name: '' });
  const confirming = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    void webpEncodeSupported().then(setWebp);
  }, []);
  useEffect(() => () => void (img && closeImage(img)), [img]);
  useEffect(() => {
    warmMaskWorker();
    return releaseMaskWorker;
  }, []);

  const open = useCallback(async (src: File | { url: string; name?: string }) => {
    const n = ++seq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const im = await loadImageSource(src);
      if (n !== seq.current) return closeImage(im);
      setImg(im);
      setFirstFrame(false);
      setReady(false);
      setDetails((d) => {
        const name = d.name || nameFromFileName(im.name);
        pristine.current = { img: im, name };
        return { ...d, name };
      });
    } catch (e) {
      if (n === seq.current) setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (source?.kind === 'file') void open(source.file);
    else if (source?.kind === 'message') void open({ url: source.url, name: source.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+V com uma imagem na área de transferência, enquanto nenhuma foi escolhida.
  useEffect(() => {
    if (img) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void open(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [img, open]);

  const packId = details.packId ?? defaultPackId(targets, target?.packId);
  const orgPack = !!packId && targets.org.some((p) => p._id === packId);
  const scope: StickerScope = orgPack ? 'org' : 'personal';
  const animated = img?.kind === 'animated' && !firstFrame;
  const problem = img && img.kind === 'animated' ? animatedProblem(img.probe, img.blob.size, caps) : null;
  const mime = animated && img ? img.probe.mime : webp ? 'image/webp' : 'image/png';
  const canSend = !!room && stickersHere(roomObj) && isComposerOpen(room.rid, room.tmid) && !blockedReasonHere({ scope, mime, animated: !!animated }, roomObj);
  const canSave = !busy && !!img && !!details.name.trim() && packId !== null && (animated ? !problem : ready);

  const save = async (send: boolean) => {
    if (!canSave || !img) return;
    setBusy(true);
    setError(null);
    const edit = animated ? null : (studio.current?.edit() ?? null);
    const name = details.name.trim();
    let item: StickerItem;
    try {
      const prev = created.current;
      // O servidor só move entre pacotes do mesmo dono: para a organização (ou de volta para os pessoais), cria de novo.
      const sameOwner = !!prev && targets.org.some((p) => p._id === prev.item.packId) === orgPack;
      if (prev && prev.img === img && prev.animated === animated && prev.edit === edit && sameOwner) {
        // Já salva com esta imagem (o envio é que falhou): mudam só os detalhes e o pacote.
        item = prev.item;
        if (name !== item.name || !sameList(details.emojis, item.emojis) || !sameList(details.keywords, item.keywords ?? []))
          item = await stickerAdmin.updateSticker({ stickerId: item._id, name, emojis: details.emojis, keywords: details.keywords });
        if (packId && packId !== item.packId) item = await stickerAdmin.moveSticker(item._id, packId);
      } else {
        const base = {
          packId: packId || undefined,
          name,
          emojis: details.emojis,
          keywords: details.keywords,
          sourceMessageId: source?.kind === 'message' ? source.messageId : undefined,
        };
        if (animated) {
          const poster = await makePoster(img.blob);
          item = await createSticker({ ...base, file: img.blob, poster: poster.blob, phash: dhash(poster.raster) });
        } else {
          const res = await studio.current?.output();
          if (!res?.output) throw new Error(res?.error ?? EMPTY_TEXT);
          const enc = await encodeSticker(res.output, caps.limits.staticKB);
          const last = enc.width === res.output.width && enc.height === res.output.height ? res.output : resizeArea(res.output, enc.width, enc.height);
          item = await createSticker({ ...base, file: enc.blob, phash: dhash(last) });
        }
        // A imagem ou o dono do pacote mudou depois de um envio que falhou: a nova toma o lugar da salva antes (que
        // ninguém recebeu).
        if (prev) void stickerAdmin.deleteSticker(prev.item._id).catch(() => undefined);
      }
      created.current = { item, img, animated, edit };
    } catch (e) {
      setError(errText(e));
      setBusy(false);
      return;
    }
    if (send && room) {
      try {
        await sendSticker({ rid: room.rid, tmid: room.tmid, tshow: room.tshow, stickerId: item._id });
      } catch (e) {
        setError(`A figurinha foi salva, mas não foi enviada. ${errText(e)}`);
        setBusy(false);
        return;
      }
      onSaved?.(item, true);
      onClose();
      return;
    }
    toast('Figurinha criada.');
    onSaved?.(item, false);
    onClose();
  };

  // Fechar (Esc, fora do modal, X, Cancelar) com trabalho por salvar pede confirmação: nada se desfaz depois.
  const dirty = () => {
    if (!img) return false;
    const edit = animated ? null : (studio.current?.edit() ?? null);
    const prev = created.current;
    if (prev)
      return (
        prev.img !== img ||
        prev.animated !== animated ||
        prev.edit !== edit ||
        (!!packId && packId !== prev.item.packId) ||
        details.name.trim() !== prev.item.name ||
        !sameList(details.emojis, prev.item.emojis) ||
        !sameList(details.keywords, prev.item.keywords ?? [])
      );
    const start = pristine.current;
    return (
      start.img !== img ||
      firstFrame ||
      !!studio.current?.edited() ||
      details.name.trim() !== start.name.trim() ||
      details.emojis.length > 0 ||
      details.keywords.length > 0 ||
      details.packId !== null
    );
  };
  const requestClose = async () => {
    if (busy || confirming.current) return;
    if (!dirty()) return onClose();
    confirming.current = true;
    const ok = await confirmDialog({
      title: 'Descartar a figurinha?',
      body: 'O recorte, o fundo, o contorno e os detalhes que você preencheu se perdem.',
      confirmLabel: 'Descartar',
      cancelLabel: 'Continuar editando',
      danger: true,
    });
    confirming.current = false;
    if (ok) onClose();
  };

  if (importing) return <ImportStickersModal packId={target?.packId} onClose={onClose} />;

  const detailsNode = (
    <DetailsFields
      value={details}
      onChange={setDetails}
      packs={{ personal: targets.personal, org: targets.org, autoPersonal: targets.autoPersonal, value: packId }}
      onNewPack={() => setNewPack(true)}
    />
  );
  const animNotice = img?.kind === 'animated' && <AnimatedNotice firstFrame={firstFrame} onFirstFrame={setFirstFrame} problem={problem} />;
  const primary = busy ? 'Salvando…' : null;

  const footer = (
    <>
      <button type="button" className="btn ghost" onClick={() => void requestClose()}>
        Cancelar
      </button>
      {img &&
        (canSend ? (
          <>
            {/* No celular a barra do topo leva o "Salvar"; o "Salvar e enviar" fica no rodapé. */}
            <button type="button" className={phone ? 'btn primary' : 'btn'} disabled={!canSave} onClick={() => void save(false)}>
              {phone ? (primary ?? 'Salvar') : 'Salvar'}
            </button>
            <button type="button" className={phone ? 'btn' : 'btn primary'} disabled={!canSave} onClick={() => void save(true)}>
              {phone ? 'Salvar e enviar' : (primary ?? 'Salvar e enviar')}
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={!canSave} onClick={() => void save(false)}>
            {primary ?? (phone ? 'Salvar' : 'Salvar figurinha')}
          </button>
        ))}
    </>
  );

  return (
    <>
      <Modal wide title="Nova figurinha" onClose={() => void requestClose()} className="stk-modal" footer={footer}>
        {!img ? (
          <div className="stk-pick">
            <div
              className={over ? 'stk-drop over' : 'stk-drop'}
              onDragEnter={(e) => {
                if ([...e.dataTransfer.types].includes('Files')) {
                  e.preventDefault();
                  setOver(true);
                }
              }}
              onDragOver={(e) => {
                if ([...e.dataTransfer.types].includes('Files')) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const file = [...e.dataTransfer.files][0];
                if (file) void open(file);
              }}
            >
              {loading ? (
                <Spinner size="lg" />
              ) : (
                <>
                  <span className="stk-drop-icon">
                    <Icon name="sticker-create" size={32} />
                  </span>
                  <p className="stk-drop-title">{over ? 'Solte para usar esta imagem' : 'Arraste uma imagem aqui'}</p>
                  <span className="stk-drop-or">ou</span>
                  <FileButton label="Escolher arquivo" accept={ACCEPT} onChange={(files) => files[0] && void open(files[0])} />
                  <p className="stk-drop-hint">PNG, JPEG, WebP ou GIF, até 20 MB. Você também pode colar uma imagem (Ctrl+V).</p>
                </>
              )}
            </div>
            {loadError && (
              <div className="callout warn" role="alert">
                <Icon name="error" />
                <span>{loadError}</span>
              </div>
            )}
            <div>
              <button type="button" className="btn ghost small" onClick={() => setImporting(true)}>
                <Icon name="sticker-import" size={14} />
                Importar várias de uma vez
              </button>
            </div>
          </div>
        ) : animated ? (
          <AnimatedEditor img={img} top={animNotice} details={detailsNode} phone={phone} />
        ) : (
          <StaticStudio
            key={img.bitmap.width + 'x' + img.bitmap.height + img.name}
            img={img}
            phone={phone}
            limitKB={caps.limits.staticKB}
            top={animNotice || undefined}
            details={detailsNode}
            handleRef={studio}
            onReady={setReady}
          />
        )}
        {error && <SaveError text={error} />}
      </Modal>
      {newPack && (
        <NewPackDialog
          scope={caps.canCreate ? 'personal' : 'org'}
          onClose={() => setNewPack(false)}
          onCreated={(pack) => {
            targets.add(pack);
            setDetails((d) => ({ ...d, packId: pack._id }));
            setNewPack(false);
          }}
        />
      )}
    </>
  );
}

function AnimatedEditor({ img, top, details, phone }: { img: LoadedImage; top: ReactNode; details: ReactNode; phone: boolean }) {
  const url = useObjectUrl(img.blob);
  return (
    <div className="stk-editor">
      <div className="stk-stage-col">
        <div className="stk-stage anim">{url && <img src={url} alt="" />}</div>
      </div>
      <div className="stk-side">
        {top}
        <Section title="Detalhes" phone={phone}>
          {details}
        </Section>
      </div>
    </div>
  );
}

// ---------- Detalhes de uma figurinha que já existe ----------

function asMessageSticker(s: StickerItem | StickerPick, scope: StickerScope): MessageStickerLive {
  return {
    fileId: s.fileId,
    name: s.name,
    emojis: s.emojis,
    width: s.width,
    height: s.height,
    animated: s.animated,
    durationMs: s.durationMs,
    url: s.url,
    posterUrl: s.posterUrl,
    scope,
  };
}

function DetailsEditor({ sticker, onClose, onSaved }: { sticker: StickerItem | StickerPick; onClose(): void; onSaved?(item: StickerItem, sent: boolean): void }) {
  const caps = useStickerCaps();
  const targets = usePackTargets(caps);
  const mine = useStickers((s) => s.mine);
  const stickerId = '_id' in sticker ? sticker._id : (sticker.stickerId ?? '');
  const scope: StickerScope = 'scope' in sticker ? sticker.scope : mine?.packs.some((p) => p._id === sticker.packId) ? 'personal' : 'org';
  const [details, setDetails] = useState<Details>({ name: sticker.name, emojis: sticker.emojis, keywords: sticker.keywords ?? [], packId: sticker.packId ?? null });
  const [newPack, setNewPack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mover só entre pacotes do mesmo dono.
  const personal = scope === 'personal' ? targets.personal : [];
  const org = scope === 'org' ? targets.org : [];

  const save = async () => {
    if (busy || !details.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let item: StickerItem | null = null;
      const name = details.name.trim();
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (name !== sticker.name || !same(details.emojis, sticker.emojis) || !same(details.keywords, sticker.keywords ?? []))
        item = await stickerAdmin.updateSticker({ stickerId, name, emojis: details.emojis, keywords: details.keywords });
      if (details.packId && details.packId !== sticker.packId) item = await stickerAdmin.moveSticker(stickerId, details.packId);
      if (item) onSaved?.(item, false);
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Excluir a figurinha “${sticker.name}”?`,
      body: 'Ela sai do pacote. Mensagens já enviadas continuam com ela.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await stickerAdmin.deleteSticker(stickerId);
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        title="Editar figurinha"
        onClose={onClose}
        className="stk-modal"
        footer={
          <>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
              <Icon name="delete" size={16} />
              Excluir
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={busy || !details.name.trim()} onClick={() => void save()}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </>
        }
      >
        <div className="stk-detail-preview">
          <StickerView sticker={asMessageSticker(sticker, scope)} size="message" />
        </div>
        <DetailsFields value={details} onChange={setDetails} packs={{ personal, org, autoPersonal: false, value: details.packId }} onNewPack={() => setNewPack(true)} />
        {error && <SaveError text={error} />}
      </Modal>
      {newPack && (
        <NewPackDialog
          scope={scope}
          onClose={() => setNewPack(false)}
          onCreated={(pack) => {
            targets.add(pack);
            setDetails((d) => ({ ...d, packId: pack._id }));
            setNewPack(false);
          }}
        />
      )}
    </>
  );
}
