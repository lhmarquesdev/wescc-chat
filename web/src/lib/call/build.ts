// Versão do chat: compara o id desta página com /build.json (escrito pelo build) ao abrir, ao voltar à aba, a cada
// 10 min e ao reconectar o tempo real (o servidor pode ter sido atualizado). Outra versão publicada: o aviso "Nova
// versão do chat disponível." aparece (depois da chamada, se houver).
import { create } from 'zustand';
import { isPrefetching } from './engine';
import { useCallStore } from './store';

declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export const useBuild = create<{ newer: string | null }>(() => ({ newer: null }));

let started = false;
let lastCheck = 0;

// force: ao reconectar, mesmo que uma conferência tenha rodado há pouco (com o servidor ainda fora do ar). Devolve o id
// que o servidor respondeu agora, ou null (sem resposta, ou conferência pulada pelo intervalo).
export async function checkBuild(force = false): Promise<string | null> {
  if (!force && Date.now() - lastCheck < 30_000) return null;
  lastCheck = Date.now();
  try {
    const r = await fetch('/build.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { id?: unknown };
    if (typeof j.id !== 'string' || !j.id) return null;
    if (j.id !== BUILD_ID) useBuild.setState({ newer: j.id });
    return j.id;
  } catch {
    // sem rede, servidor fora do ar ou resposta que não é JSON (servidor de desenvolvimento)
    return null;
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
// responde 404) e o import() falha. Recarrega só quando o servidor responde agora com outro build: com o servidor fora
// do ar (o reinício da atualização) ou uma falha de rede no mesmo build, a recarga cairia na página de erro do navegador
// e ficaria lá. Também nunca pela pré-carga do motor de grupo (passar o mouse num botão de chamada), em chamada, com uma
// edição, citação ou envio de arquivo em andamento no campo de mensagem, nem mais de uma vez a cada 30 s. Nos outros
// casos o erro segue para quem importou ou para o ErrorBoundary ("Recarregar"), e o aviso de nova versão aparece.
export function reloadOnStaleChunks() {
  // Sem preventDefault: o import() continua falhando para quem chamou (o .catch da pré-carga, o ErrorBoundary).
  window.addEventListener('vite:preloadError', () => {
    if (isPrefetching()) return void checkBuild();
    void reloadIfNewBuild();
  });
}

async function reloadIfNewBuild() {
  const id = await checkBuild(true);
  if (!id || id === BUILD_ID) return;
  const c = useCallStore.getState();
  if (c.phase !== 'idle' || c.preflight || c.incoming.length > 0) return;
  if (document.querySelector('.composer.is-editing, .composer-bar.quoting, .composer-bar.upload')) return;
  try {
    const last = Number(sessionStorage.getItem('wescc.chunkReload') ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem('wescc.chunkReload', String(Date.now()));
  } catch {
    return; // sem armazenamento não há como evitar recargas em laço
  }
  location.reload();
}
