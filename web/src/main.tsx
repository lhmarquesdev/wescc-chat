// Fontes servidas pelo próprio app (sem CDN): Inter com tamanho óptico e JetBrains Mono para código.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono';
// Ordem fixa da cascata: cada arquivo só sobrescreve regras dos anteriores. Vem antes de qualquer componente, para
// o CSS de cada recurso (figurinhas, chamadas, integrações, avisos), importado pelos próprios componentes, entrar
// depois do design system.
import './styles/tokens.css';
import './styles/base.css';
import './styles/primitives.css';
import './styles/overlays.css';
import './styles/shell.css';
import './styles/room.css';
import './styles/panels.css';
import './styles/calls.css';
import './styles/admin.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getCredentials } from './lib/api';
import { captureInstallPrompt } from './lib/install';
import { registerServiceWorker } from './lib/push';

registerServiceWorker();
captureInstallPrompt();

// Tema manual (Claro ou Escuro): fica guardado neste navegador para o index.html aplicar antes da
// primeira pintura, sem piscar o tema do sistema; a barra do navegador acompanha o fundo do app.
// Guardado com o id do usuário: o index.html só aplica enquanto a sessão for desse usuário, então
// depois de sair (computador compartilhado) o login e o próximo usuário abrem no tema do sistema.
const THEME_KEY = 'wescc.theme';
const themeMetas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => [m, m.content] as const);
function syncTheme() {
  const theme = document.documentElement.dataset.theme;
  const uid = getCredentials()?.userId;
  try {
    if (!theme) localStorage.removeItem(THEME_KEY);
    else if (uid) localStorage.setItem(THEME_KEY, JSON.stringify({ uid, theme }));
  } catch {
    // Sem armazenamento: só perde a aplicação antecipada.
  }
  const bg = theme ? getComputedStyle(document.body).backgroundColor : '';
  for (const [meta, original] of themeMetas) meta.content = bg || original;
}
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
syncTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
