// Sair de uma tela com alterações não salvas (matriz, editor de papel, editor de usuário): o navegador pergunta ao
// recarregar ou fechar, e qualquer link interno do chat (a navegação da administração, "Voltar às conversas") pergunta
// antes de trocar de tela. O roteador é o BrowserRouter (sem useBlocker), então o clique no link é interceptado aqui.
// O Voltar do navegador (e o do celular) também pergunta: com alterações, a tela ganha uma entrada extra no histórico
// (mesmo endereço, marcada como "sentinela"); o Voltar consome essa entrada, a pergunta aparece e, se a pessoa fica,
// a entrada volta.
import { useEffect, useRef } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';

const SENTINEL = 'leaveGuard';
const onSentinel = () => !!(window.history.state as Record<string, unknown> | null)?.[SENTINEL];

function pushSentinel() {
  const st = (window.history.state ?? {}) as Record<string, unknown>;
  // Mesmo endereço e mesma chave do roteador: para ele nada muda; o idx segue a ordem do histórico.
  window.history.pushState({ ...st, idx: typeof st.idx === 'number' ? st.idx + 1 : st.idx, [SENTINEL]: true }, '', window.location.href);
}

// Voltas que a própria guarda pediu (salvou ou reverteu: a entrada extra sai do caminho) e que ainda não chegaram. O
// ouvinte daqui roda antes do de cada tela (foi registrado primeiro) e marca a volta como nossa: se a pessoa voltou a
// mexer nesse meio-tempo, a tela só recoloca a sentinela, sem perguntar nada.
let pendingBacks = 0;
let popIsOurs = false;
window.addEventListener('popstate', () => {
  popIsOurs = pendingBacks > 0;
  if (popIsOurs) pendingBacks--;
});

// Sair da tela depois do "Descartar" (botão Voltar do editor, link interceptado): a navegação toma o lugar da entrada
// extra, e o Voltar da tela seguinte não cai de novo no editor.
export function leaveTo(navigate: NavigateFunction, to: string) {
  navigate(to, { replace: onSentinel() });
}

export function useLeaveGuard(active: boolean, ask: () => Promise<boolean> | boolean) {
  const navigate = useNavigate();
  const askRef = useRef(ask);
  askRef.current = ask;
  const navRef = useRef(navigate);
  navRef.current = navigate;
  useEffect(() => {
    if (!active) return;
    let leaving = false;
    let asking = false;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    // Na captura, antes do Link do roteador: o clique só segue depois do "Descartar".
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      void Promise.resolve(askRef.current()).then((yes) => yes && leaveTo(navRef.current, to));
    };
    const remove = () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick, true);
    };
    // Voltar (ou Avançar) do navegador. Caiu na própria sentinela (Avançar, ou a volta que a limpeza pediu): nada a
    // perguntar. Saiu da sentinela para o mesmo endereço: a pessoa apertou Voltar no editor.
    const onPop = () => {
      if (leaving || asking || onSentinel()) return;
      if (popIsOurs) return pushSentinel();
      asking = true;
      void Promise.resolve(askRef.current()).then((yes) => {
        asking = false;
        if (yes) {
          // Descartou: sai de vez para a tela anterior, sem perguntar de novo (nem o "Sair do site?" do navegador).
          leaving = true;
          remove();
          window.history.back();
        } else if (!onSentinel()) pushSentinel();
      });
    };
    if (!onSentinel()) pushSentinel();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', onPop);
    document.addEventListener('click', onClick, true);
    return () => {
      remove();
      // Salvou ou reverteu e ficou na tela: a entrada extra sai do caminho do Voltar.
      if (!leaving && onSentinel()) {
        pendingBacks++;
        window.history.back();
      }
    };
  }, [active]);
}
