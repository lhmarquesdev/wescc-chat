// Sair de uma tela com alterações não salvas (matriz, editor de papel, editor de usuário): o navegador pergunta ao
// recarregar ou fechar, e qualquer link interno do chat (a navegação da administração, "Voltar às conversas") pergunta
// antes de trocar de tela. O roteador é o BrowserRouter (sem useBlocker), então o clique no link é interceptado aqui.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export function useLeaveGuard(active: boolean, ask: () => Promise<boolean> | boolean) {
  const navigate = useNavigate();
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (!active) return;
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
      void Promise.resolve(askRef.current()).then((yes) => yes && navigate(to));
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active, navigate]);
}
