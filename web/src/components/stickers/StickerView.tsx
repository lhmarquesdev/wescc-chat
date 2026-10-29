// Figurinha na mensagem, no cartão, no seletor e nas listas: caixa fixa, pôster parado e reprodução sob controle.
import './stickers.css';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { STICKER_LIMITS, type MessageSticker, type MessageStickerLive } from '@shared/stickers';
import { useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { useMedia } from '../overlay';
import { useDelay } from '../ui';

export type StickerSize = 'message' | 'small' | 'card' | 'picker';

// Caixa nominal de cada tamanho. A mensagem usa a menor variante (tópico, 128) para decidir se o texto cabe.
const BOX: Record<StickerSize, number> = { message: 128, small: 64, card: 200, picker: 68 };

type Mode = 'auto' | 'hover' | 'never';
type Reason = 'auto' | 'hover' | 'button' | 'card';

// O mesmo de effectiveAnimation() (lib/stickers), mas reativo: preferência, configuração e "reduzir movimento".
export function useStickerAnimation(): Mode {
  const pref = useStore((s) => s.me?.preferences?.stickerAnimation);
  const def = useStore((s) => s.settings.Stickers_Animation_Default);
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  if (pref === 'auto' || pref === 'hover' || pref === 'never') return pref;
  if (reduced) return 'never';
  return def === 'auto' || def === 'never' ? def : 'hover';
}

// ---------- Bytes das animações (LRU de blobs) ----------

const BLOB_MAX = 40;
const BLOB_BYTES = 24 * 1024 * 1024;
const blobs = new Map<string, Blob>();
const pendingBlobs = new Map<string, Promise<Blob>>();
let blobBytes = 0;

function getBlob(url: string): Promise<Blob> {
  const hit = blobs.get(url);
  if (hit) {
    blobs.delete(url);
    blobs.set(url, hit);
    return Promise.resolve(hit);
  }
  const pending = pendingBlobs.get(url);
  if (pending) return pending;
  // O cache HTTP imutável quase sempre responde: o fetch só copia os bytes para um blob.
  const p = fetch(url, { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    })
    .then((b) => {
      blobs.set(url, b);
      blobBytes += b.size;
      while (blobs.size > BLOB_MAX || blobBytes > BLOB_BYTES) {
        const [k, v] = blobs.entries().next().value as [string, Blob];
        blobs.delete(k);
        blobBytes -= v.size;
      }
      return b;
    })
    .finally(() => pendingBlobs.delete(url));
  pendingBlobs.set(url, p);
  return p;
}

// Outra pessoa entrou no mesmo navegador: nada da sessão anterior fica na memória.
useStickers.subscribe((s, prev) => {
  if (s.userId !== prev.userId) {
    blobs.clear();
    blobBytes = 0;
  }
});

// ---------- Reprodução ----------

interface Player {
  key?: string;
  url: string;
  durationMs?: number;
  reason: Reason | null;
  objectUrl: string | null;
  timer: number;
  token: number;
  startedAt: number;
  visible: boolean;
  autoDone: boolean;
  card: boolean; // no cartão aberto: repete até ele fechar
  resume: boolean; // o cartão repetia quando a aba saiu da frente: volta junto com ela
  mode(): Mode;
  setSrc(src: string | null): void;
  setReason(r: Reason | null): void;
}

const players = new Set<Player>();
const playListeners = new Set<() => void>();
let playVersion = 0;
const notifyPlay = () => {
  playVersion++;
  for (const l of playListeners) l();
};

function stopPlay(p: Player) {
  clearTimeout(p.timer);
  p.token++;
  const was = p.reason;
  p.reason = null;
  const u = p.objectUrl;
  p.objectUrl = null;
  p.setSrc(null);
  p.setReason(null);
  // A imagem já decodificada não precisa do endereço; espera o pôster entrar antes de soltar o blob.
  if (u) setTimeout(() => URL.revokeObjectURL(u), 1000);
  if (was) notifyPlay();
}

function startPlay(p: Player, reason: Reason, ms: number | null) {
  // O botão e o cartão vencem o automático e o passar do mouse: sair de cima não para o que está tocando por eles.
  if ((p.reason === 'button' || p.reason === 'card') && reason !== p.reason && reason !== 'button') return;
  clearTimeout(p.timer);
  if (ms) p.timer = window.setTimeout(() => stopPlay(p), ms);
  const already = !!p.reason;
  p.reason = reason;
  p.setReason(reason);
  if (already) return notifyPlay();
  // No máximo 6 ao mesmo tempo: a sétima para a mais antiga (o cartão aberto não sai).
  const active = [...players].filter((x) => x !== p && x.reason && x.reason !== 'card').sort((a, b) => a.startedAt - b.startedAt);
  while (active.length >= STICKER_LIMITS.playingMax) stopPlay(active.shift()!);
  p.startedAt = performance.now();
  const token = ++p.token;
  getBlob(p.url).then(
    (blob) => {
      if (token !== p.token || !p.reason) return;
      // Endereço novo a cada vez: a animação sempre começa do primeiro quadro.
      const u = URL.createObjectURL(blob);
      p.objectUrl = u;
      p.setSrc(u);
    },
    () => {
      if (token === p.token) stopPlay(p);
    },
  );
  notifyPlay();
}

// Reprodução automática: 5 s, em ciclos inteiros quando a animação é curta (pelo menos um ciclo).
function autoplayMs(d?: number) {
  const max = STICKER_LIMITS.autoplayMs;
  if (!d || d >= max) return max;
  return Math.floor(max / d) * d;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const p of players) {
        if (!p.reason) continue;
        const card = p.reason === 'card';
        stopPlay(p);
        p.resume = card;
      }
      return;
    }
    // De volta à aba: só o cartão que esta saída parou volta a repetir. O que a pessoa pausou fica parado.
    for (const p of players) {
      if (!p.resume) continue;
      p.resume = false;
      if (!p.reason && p.mode() !== 'never') startPlay(p, 'card', null);
    }
  });
}

// Um observador para todas: metade visível dispara o automático; fora da tela para.
const seen = new WeakMap<Element, { player: Player; mode: () => Mode }>();
let viewIO: IntersectionObserver | null = null;
function viewObserver() {
  viewIO ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const it = seen.get(e.target);
        if (!it) continue;
        const p = it.player;
        p.visible = e.isIntersecting;
        if (!e.isIntersecting) {
          if (p.reason) stopPlay(p);
        } else if (e.intersectionRatio >= 0.5 && !p.autoDone && it.mode() === 'auto') {
          p.autoDone = true;
          startPlay(p, 'auto', autoplayMs(p.durationMs));
        }
      }
    },
    { threshold: [0, 0.5] },
  );
  return viewIO;
}

// Seletor: a imagem só carrega quando a célula chega perto da área visível da grade (e não da janela).
const lazyIOs = new WeakMap<Element, IntersectionObserver>();
const lazyCbs = new WeakMap<Element, () => void>();
function lazyObserver(root: Element) {
  let io = lazyIOs.get(root);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          lazyCbs.get(e.target)?.();
          io!.unobserve(e.target);
        }
      },
      { root, rootMargin: '200px 0px' },
    );
    lazyIOs.set(root, io);
  }
  return io;
}

// Alterna a reprodução pela chave (id da mensagem): o item "Reproduzir animação" do menu.
export function toggleStickerPlayback(key: string): void {
  const mine = [...players].filter((p) => p.key === key);
  if (mine.some((p) => p.reason)) for (const p of mine) stopPlay(p);
  else for (const p of mine.filter((x) => x.visible || mine.length === 1)) startPlay(p, 'button', 60_000);
}

export function useStickerPlaying(key: string): boolean {
  useSyncExternalStore(
    (l) => {
      playListeners.add(l);
      return () => playListeners.delete(l);
    },
    () => playVersion,
  );
  return [...players].some((p) => p.key === key && !!p.reason);
}

// ---------- Componente ----------

function boxVars(w?: number, h?: number): CSSProperties {
  // Sem medidas (removida antiga): caixa quadrada.
  const sw = w && h ? w : 512;
  const sh = w && h ? h : 512;
  return { '--sw': sw, '--sh': sh, '--sl': Math.max(sw, sh) } as CSSProperties;
}

function displaySize(size: StickerSize, w?: number, h?: number) {
  const sw = w && h ? w : 512;
  const sh = w && h ? h : 512;
  const L = Math.max(sw, sh);
  const long = Math.min(BOX[size], L * 2);
  return { w: Math.max(1, Math.round((long * sw) / L)), h: Math.max(1, Math.round((long * sh) / L)) };
}

function Placeholder({ size, text, w, h }: { size: StickerSize; text: string; w?: number; h?: number }) {
  const d = displaySize(size, w, h);
  const iconOnly = d.w < 96 || d.h < 56;
  return (
    <div className="sticker-msg" data-size={size} style={boxVars(w, h)}>
      <div className="sticker-removed" role={iconOnly ? 'img' : undefined} aria-label={iconOnly ? text : undefined} title={iconOnly ? text : undefined}>
        <Icon name="sticker-removed" size={18} />
        {!iconOnly && <span>{text}</span>}
      </div>
    </div>
  );
}

export function StickerView(props: {
  sticker: MessageSticker;
  size?: StickerSize; // caixa: 160 (telefone 140; tópico 128) | 64 | 200 | 68
  playbackKey?: string; // id da mensagem, para o menu "Reproduzir animação"
  lazyRoot?: Element | null; // seletor: a imagem só carrega quando a célula entra na grade rolável
  onOpen?: (anchor: HTMLElement) => void; // abre o StickerCard
}) {
  const { sticker, size = 'message' } = props;
  const removedHere = useStickers((s) => s.removed.has(sticker.fileId));
  if (sticker.removed || removedHere) return <Placeholder size={size} text="Figurinha removida" w={sticker.width} h={sticker.height} />;
  return <LiveSticker {...props} sticker={sticker} size={size} />;
}

function LiveSticker({
  sticker: s,
  size,
  playbackKey,
  lazyRoot,
  onOpen,
}: {
  sticker: MessageStickerLive;
  size: StickerSize;
  playbackKey?: string;
  lazyRoot?: Element | null;
  onOpen?: (anchor: HTMLElement) => void;
}) {
  const mode = useStickerAnimation();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const root = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(!lazyRoot);
  const [playSrc, setPlaySrc] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  // Guardado por imagem: outra figurinha no mesmo lugar volta a "carregando" sem efeito nenhum.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showSkeleton = useDelay(250);
  const animated = s.animated;
  const rest = animated ? s.posterUrl || s.url : s.url;
  const src = inView ? playSrc ?? rest : undefined;
  const d = displaySize(size, s.width, s.height);
  const playerRef = useRef<Player | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const state = failedSrc === rest ? 'failed' : loadedSrc === rest ? 'loaded' : 'loading';

  // Do cache a imagem pode terminar antes do commit (render concorrente) e o onLoad não chega: confere aqui.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img?.complete || !img.getAttribute('src')) return;
    if (img.naturalWidth > 0) setLoadedSrc(rest);
    else if (img.getAttribute('src') === rest) setFailedSrc(rest);
  }, [rest, src]);

  useEffect(() => {
    if (!lazyRoot || inView) return;
    const el = root.current;
    if (!el) return;
    const io = lazyObserver(lazyRoot);
    lazyCbs.set(el, () => setInView(true));
    io.observe(el);
    return () => {
      io.unobserve(el);
      lazyCbs.delete(el);
    };
  }, [lazyRoot, inView]);

  useEffect(() => {
    const el = root.current;
    if (!animated || !el) return;
    const p: Player = {
      key: playbackKey,
      url: s.url,
      durationMs: s.durationMs,
      reason: null,
      objectUrl: null,
      timer: 0,
      token: 0,
      startedAt: 0,
      visible: true,
      autoDone: false,
      card: size === 'card',
      resume: false,
      mode: () => modeRef.current,
      setSrc: setPlaySrc,
      setReason,
    };
    players.add(p);
    playerRef.current = p;
    // O cartão repete a animação enquanto está aberto, a não ser no modo "nunca". Só fechar (desmontar) ou o botão de
    // pausar a param: nada de automático de 5 s nem de passar o mouse.
    if (p.card) {
      if (modeRef.current !== 'never') startPlay(p, 'card', null);
      return () => {
        stopPlay(p);
        players.delete(p);
        playerRef.current = null;
      };
    }
    p.visible = false;
    seen.set(el, { player: p, mode: () => modeRef.current });
    viewObserver().observe(el);
    // No seletor e nas listas quem recebe o mouse e o foco é a célula ou a linha. Na mensagem é só a imagem (.sticker-hit):
    // ir até o botão de tocar para o hover, e o clique nele toca de verdade (segue tocando ao tirar o mouse).
    const inRow = size === 'picker' || size === 'small';
    const target = inRow ? el.closest<HTMLElement>('button, [role="button"]') ?? el : el.querySelector<HTMLElement>('.sticker-hit') ?? el;
    const enter = () => {
      if (modeRef.current !== 'never') startPlay(p, 'hover', 30_000);
    };
    const leave = () => {
      if (p.reason === 'hover') stopPlay(p);
    };
    const focusOut = (e: FocusEvent) => {
      if (!target.contains(e.relatedTarget as Node | null)) leave();
    };
    // Toque não tem hover: lá só o botão toca (o toque abre o cartão).
    const enterMouse = (e: PointerEvent) => e.pointerType !== 'touch' && enter();
    target.addEventListener('pointerenter', enterMouse);
    target.addEventListener('pointerleave', leave);
    target.addEventListener('focusin', enter);
    target.addEventListener('focusout', focusOut);
    return () => {
      target.removeEventListener('pointerenter', enterMouse);
      target.removeEventListener('pointerleave', leave);
      target.removeEventListener('focusin', enter);
      target.removeEventListener('focusout', focusOut);
      viewObserver().unobserve(el);
      seen.delete(el);
      stopPlay(p);
      players.delete(p);
      playerRef.current = null;
    };
  }, [animated, s.url, s.durationMs, playbackKey, size]);

  const playing = !!reason;
  const toggle = () => {
    const p = playerRef.current;
    if (!p) return;
    p.resume = false;
    if (p.reason) stopPlay(p);
    // No cartão, tocar de novo volta a repetir enquanto ele está aberto (no modo "nunca", o botão vale 60 s como sempre).
    else if (p.card && mode !== 'never') startPlay(p, 'card', null);
    else startPlay(p, 'button', 60_000);
  };

  if (state === 'failed') return <Placeholder size={size} text="Figurinha indisponível" w={s.width} h={s.height} />;

  const img = (
    <img
      ref={imgRef}
      className="sticker-img"
      alt=""
      draggable={false}
      decoding="async"
      loading="lazy"
      src={src}
      width={d.w}
      height={d.h}
      onLoad={() => setLoadedSrc(rest)}
      onError={() => {
        // Falha só da animação (blob): volta ao pôster sem dar a figurinha por perdida.
        if (playSrc && playerRef.current) stopPlay(playerRef.current);
        else setFailedSrc(rest);
      }}
    />
  );
  const label = `Figurinha “${s.name}”: ver detalhes`;
  // Célula do seletor e cartão já têm nome (o rótulo do botão, o título do cartão).
  const named = size === 'small' || size === 'message';
  return (
    <div
      ref={root}
      className="sticker-msg"
      data-size={size}
      data-anim={animated ? mode : undefined}
      data-playing={playing ? '' : undefined}
      data-state={state}
      style={boxVars(s.width, s.height)}
    >
      {onOpen ? (
        <button type="button" className="sticker-hit" aria-label={label} onClick={(e) => onOpen(e.currentTarget)}>
          {img}
        </button>
      ) : named ? (
        // Nas listas (favoritas, fixadas, busca, auditoria) a figurinha faz as vezes do texto: precisa de nome.
        <span className="sticker-hit" role="img" aria-label={`Figurinha “${s.name}”`}>
          {img}
        </span>
      ) : (
        <span className="sticker-hit">{img}</span>
      )}
      {state === 'loading' && showSkeleton && <span className="skeleton sticker-skeleton" aria-hidden="true" />}
      {/* Célula e linha de lista já são botões: lá não cabe outro. */}
      {animated && size !== 'picker' && size !== 'small' && (
        <button
          type="button"
          className="sticker-play"
          aria-label={playing ? 'Pausar animação' : 'Reproduzir animação'}
          title={playing ? 'Pausar animação' : 'Reproduzir animação'}
          onClick={toggle}
        >
          <Icon name={playing ? 'sticker-pause' : 'sticker-play'} size={14} />
        </button>
      )}
    </div>
  );
}
