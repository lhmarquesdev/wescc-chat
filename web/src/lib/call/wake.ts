// Tela acesa durante a chamada com vídeo nos aparelhos de toque (Screen Wake Lock), pedida de novo ao voltar à aba.

type Sentinel = { release(): Promise<void>; released?: boolean };

let wanted = false;
let sentinel: Sentinel | null = null;

const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

async function request() {
  if (!wanted || sentinel || document.visibilityState !== 'visible') return;
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock;
  if (!wl) return;
  try {
    const s = await wl.request('screen');
    if (!wanted) return void s.release().catch(() => {});
    sentinel = s;
    (s as unknown as EventTarget).addEventListener?.('release', () => {
      if (sentinel === s) sentinel = null;
    });
  } catch {
    // negado (bateria fraca, aba sem foco): tenta de novo na próxima volta à aba
  }
}

function onVisible() {
  if (document.visibilityState === 'visible') void request();
}

export function keepAwake(on: boolean) {
  const next = on && touch();
  if (next === wanted) return;
  wanted = next;
  if (next) {
    document.addEventListener('visibilitychange', onVisible);
    void request();
  } else {
    document.removeEventListener('visibilitychange', onVisible);
    const s = sentinel;
    sentinel = null;
    void s?.release().catch(() => {});
  }
}
