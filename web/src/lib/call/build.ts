// Versão do chat: compara o id desta página com /build.json (escrito pelo build) ao abrir, ao voltar à aba e a cada
// 10 min. Outra versão publicada: o aviso "Nova versão do chat disponível." aparece (depois da chamada, se houver).
import { create } from 'zustand';

declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export const useBuild = create<{ newer: string | null }>(() => ({ newer: null }));

let started = false;
let lastCheck = 0;

async function check() {
  if (Date.now() - lastCheck < 30_000) return;
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
  void check();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check());
  setInterval(() => void check(), 10 * 60_000);
}
