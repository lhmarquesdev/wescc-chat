// Posição da janela da chamada (e da tela de entrada): presa a um canto da área principal, ou cobrindo-a inteira.
import { useEffect, useState, type CSSProperties } from 'react';

export type Corner = 'tr' | 'tl' | 'br' | 'bl';
const CORNER_KEY = 'wescc.call.corner';

export function loadCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY);
    if (v === 'tl' || v === 'br' || v === 'bl') return v;
  } catch {
    // sem armazenamento local
  }
  return 'tr';
}

export function saveCorner(c: Corner) {
  try {
    localStorage.setItem(CORNER_KEY, c);
  } catch {
    // sem armazenamento local
  }
}

export interface Dock {
  vw: number;
  vh: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  panelLeft: number | null;
  composerTop: number | null;
  bannerBottom: number | null;
}

export function measureDock(): Dock {
  const main = document.querySelector<HTMLElement>('.layout > .main');
  const r = main?.getBoundingClientRect();
  const box = r && r.width && r.height ? r : new DOMRect(0, 0, innerWidth, innerHeight);
  const pr = main?.querySelector('.panel')?.getBoundingClientRect();
  const cr = main?.querySelector('.room-main .composer')?.getBoundingClientRect();
  const br = main?.querySelector('.call-room-banner')?.getBoundingClientRect();
  return {
    vw: innerWidth,
    vh: innerHeight,
    top: Math.round(box.top),
    left: Math.round(box.left),
    right: Math.round(box.right),
    bottom: Math.round(box.bottom),
    // Painel aberto à direita: a janela anda para a esquerda dele (se ainda couber).
    panelLeft: pr && pr.width && pr.left - box.left > 420 ? Math.round(pr.left) : null,
    composerTop: cr && cr.height ? Math.round(cr.top) : null,
    bannerBottom: br && br.height ? Math.round(br.bottom) : null,
  };
}

const sameDock = (a: Dock | null, b: Dock) => !!a && (Object.keys(b) as (keyof Dock)[]).every((k) => a[k] === b[k]);

// Mede a área principal (e o painel e o compositor dentro dela) enquanto a janela está aberta.
export function useDock(active: boolean) {
  const [dock, setDock] = useState<Dock | null>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = measureDock();
      setDock((prev) => (sameDock(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const main = document.querySelector('.layout > .main');
    const ro = new ResizeObserver(schedule);
    const mo = new MutationObserver(schedule);
    if (main) {
      ro.observe(main);
      mo.observe(main, { childList: true, subtree: true });
    }
    addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      removeEventListener('resize', schedule);
    };
  }, [active]);
  return dock;
}

// Abaixo do cabeçalho (56 + 16) no alto, e da faixa da chamada da sala quando há (o "Entrar" fica à vista); acima do
// compositor embaixo, para nunca cobrir o "Enviar".
export function cornerStyle(d: Dock | null, corner: Corner): CSSProperties {
  if (!d) return {};
  const top = corner[0] === 't';
  const left = corner[1] === 'l';
  return {
    top: top ? Math.max(d.top + 72, d.bannerBottom == null ? 0 : d.bannerBottom + 16) : 'auto',
    bottom: top ? 'auto' : d.vh - (d.composerTop ?? d.bottom) + 16,
    left: left ? d.left + 16 : 'auto',
    right: left ? 'auto' : d.vw - (d.panelLeft ?? d.right) + 16,
  };
}

// Cobre a área principal (a barra lateral continua usável).
export function mainStyle(d: Dock | null): CSSProperties | undefined {
  return d ? { top: d.top, left: d.left, width: d.right - d.left, height: d.bottom - d.top } : undefined;
}
