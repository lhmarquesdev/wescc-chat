// Instalação do app (PWA). O Chrome e o Edge mandam beforeinstallprompt uma vez, logo no carregamento:
// main.tsx chama captureInstallPrompt() antes de montar o React, para o evento não se perder.
// O menu do usuário mostra "Instalar app" só quando o evento chegou (useInstallPrompt().available).
import { useSyncExternalStore } from 'react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function captureInstallPrompt() {
  // Sem preventDefault: o navegador continua oferecendo a instalação do jeito dele (barra no Android,
  // ícone na barra de endereço) e o app só acrescenta a opção no menu.
  window.addEventListener('beforeinstallprompt', (e) => {
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

// Já está aberto como app instalado (janela própria ou tela de início do iOS).
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// iOS não manda beforeinstallprompt: lá se instala por Compartilhar › Adicionar à Tela de Início.
export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Abre o diálogo de instalação do navegador. Precisa vir de um clique. Devolve true se a pessoa instalou.
export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  // O evento só serve uma vez: depois do prompt() o navegador manda outro quando puder instalar de novo.
  deferred = null;
  emit();
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => deferred !== null;

// available: mostrar "Instalar app" (chama install()). iosHint: no iOS fora do app instalado,
// mostrar a dica "Toque em Compartilhar e depois em Adicionar à Tela de Início".
export function useInstallPrompt() {
  const available = useSyncExternalStore(subscribe, snapshot, () => false);
  return { available, install: promptInstall, iosHint: !available && isIos() && !isStandalone() };
}
