// Avisos dentro da chamada. Com a janela ampliada ou em tela cheia, os avisos do chat aparecem aqui, na camada da
// chamada (a região do chat fica escondida por html[data-call="big"]); encaixada, a região do chat basta.
import { useEffect, useState } from 'react';
import { useCallStore } from '../../lib/call/store';
import { useIsPhone } from '../overlay';
import { OverlayRootContext, Toasts } from '../ui';

export function CallToasts() {
  const phone = useIsPhone();
  // A tela de entrada cobre a área principal; no celular a janela encaixada não existe (é a tela cheia).
  const big = useCallStore((s) => !!s.preflight || (s.phase !== 'idle' && (s.view.window === 'big' || s.view.fullscreen || (phone && s.view.window === 'docked'))));
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    if (big) root.dataset.call = 'big';
    else delete root.dataset.call;
    return () => {
      delete root.dataset.call;
    };
  }, [big]);
  return (
    <div className="call-toasts" ref={setEl}>
      {big && el && (
        <OverlayRootContext.Provider value={el}>
          <Toasts />
        </OverlayRootContext.Provider>
      )}
    </div>
  );
}

// Região viva (leitores de tela): entradas, saídas, mãos, moderação, trava e meu microfone e câmera.
export function CallLiveRegion() {
  const live = useCallStore((s) => s.live);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {live.text && <span key={live.n}>{live.text}</span>}
    </div>
  );
}
