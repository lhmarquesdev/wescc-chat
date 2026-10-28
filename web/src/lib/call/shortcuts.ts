// Atalhos da chamada: só valem com a chamada aberta (fora dela, Ctrl+D e Ctrl+E continuam do navegador) e nunca
// com o foco num campo de texto. Segurar Espaço para falar é opcional e só vale com o foco no palco.

const PTT_KEY = 'wescc.call.ptt';

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function shortcutLabel(key: 'mic' | 'camera' | 'hand') {
  const mac = isMac();
  if (key === 'hand') return mac ? '⌘⌥H' : 'Ctrl+Alt+H';
  const k = key === 'mic' ? 'D' : 'E';
  return mac ? `⌘${k}` : `Ctrl+${k}`;
}

export function pttEnabled(): boolean {
  try {
    return localStorage.getItem(PTT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPttEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(PTT_KEY, '1');
    else localStorage.removeItem(PTT_KEY);
  } catch {
    // sem armazenamento local: vale só nesta página
  }
}

function editable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

export interface ShortcutActions {
  active(): boolean; // estou numa chamada
  pttAllowed(): boolean; // janela ampliada
  mic(): void;
  camera(): void;
  hand(): void;
  pttDown(): void;
  pttUp(): void;
}

let installed: (() => void) | null = null;

export function installShortcuts(a: ShortcutActions) {
  installed?.();
  let holding = false;
  const release = () => {
    if (!holding) return;
    holding = false;
    a.pttUp();
  };
  const down = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !a.active() || editable(e.target)) return;
    const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.shiftKey) {
      if (!e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        if (!e.repeat) a.mic();
        return;
      }
      if (!e.altKey && e.code === 'KeyE') {
        e.preventDefault();
        if (!e.repeat) a.camera();
        return;
      }
      if (e.altKey && e.code === 'KeyH') {
        e.preventDefault();
        if (!e.repeat) a.hand();
        return;
      }
    }
    if (e.code === 'Space' && !mod && !e.altKey && pttEnabled() && a.pttAllowed()) {
      // Só com o foco no próprio palco: num botão, o Espaço aperta o botão.
      const stage = document.activeElement as HTMLElement | null;
      if (!stage?.classList.contains('call-stage')) return;
      e.preventDefault();
      if (!holding && !e.repeat) {
        holding = true;
        a.pttDown();
      }
    }
  };
  const up = (e: KeyboardEvent) => {
    if (e.code === 'Space') release();
  };
  const blur = () => release();
  const out = (e: FocusEvent) => (e.target as HTMLElement | null)?.classList?.contains('call-stage') && release();
  document.addEventListener('keydown', down);
  document.addEventListener('keyup', up);
  document.addEventListener('focusout', out);
  window.addEventListener('blur', blur);
  installed = () => {
    document.removeEventListener('keydown', down);
    document.removeEventListener('keyup', up);
    document.removeEventListener('focusout', out);
    window.removeEventListener('blur', blur);
  };
}
