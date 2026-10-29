// Versão do chat: compara o id desta página com /build.json (escrito pelo build) ao abrir, ao voltar à aba, a cada
// 10 min e ao reconectar o tempo real (o servidor pode ter sido atualizado). Outra versão publicada: o aviso "Nova
// versão do chat disponível." aparece (depois da chamada, se houver).
import { create } from 'zustand';
import { useCallStore } from './store';

declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export const useBuild = create<{ newer: string | null }>(() => ({ newer: null }));

let started = false;
let lastCheck = 0;

// force: ao reconectar, mesmo que uma conferência tenha rodado há pouco (com o servidor ainda fora do ar).
export async function checkBuild(force = false) {
  if (!force && Date.now() - lastCheck < 30_000) return;
  lastCheck = Date.now();
  try {
    const r = await fetch('/build.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = (await r.json()) as { id?: unknown };
    if (typeof j.id === 'string' && j.id && j.id !== BUILD_ID) useBuild.setState({ newer: j.id });
  } catch {
    // sem rede ou resposta que não é JSON (servidor de desenvolvimento)
  }
}

export function startBuildCheck() {
  if (started) return;
  started = true;
  void checkBuild();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void checkBuild());
  setInterval(() => void checkBuild(), 10 * 60_000);
}

// Atualização publicada com a aba aberta: os pedaços sob demanda do build anterior não existem mais (o servidor
// responde 404) e o import() falha. Recarrega uma vez a cada 30 s, fora de chamada; senão o erro segue para o
// ErrorBoundary, que oferece "Recarregar", e o aviso de nova versão aparece quando a chamada acabar.
export function reloadOnStaleChunks() {
  window.addEventListener('vite:preloadError', () => {
    void checkBuild(true);
    const c = useCallStore.getState();
    if (c.phase !== 'idle' || c.preflight || c.incoming.length > 0) return;
    try {
      const last = Number(sessionStorage.getItem('wescc.chunkReload') ?? 0);
      if (Date.now() - last < 30_000) return;
      sessionStorage.setItem('wescc.chunkReload', String(Date.now()));
    } catch {
      return; // sem armazenamento não há como evitar recargas em laço
    }
    location.reload();
  });
}
