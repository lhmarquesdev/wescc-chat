// Mensagem com o foco do teclado dentro (a hora, um link, os botões da barra de ações): a .msg ganha data-focus-in e o
// CSS mostra a barra e a hora, como no passar do mouse. Antes era o seletor .msg:has(:focus-visible), que a cada tecla
// digitada no compositor fazia o navegador reavaliar cada mensagem carregada inteira (numa conversa longa, ~55 ms por
// tecla). O foco do mouse (um clique num botão) não marca, como o :focus-visible.

let marked: Element | null = null;

function clear() {
  marked?.removeAttribute('data-focus-in');
  marked = null;
}

function mark(el: Element | null) {
  const msg = el?.closest('.msg') ?? null;
  if (msg === marked) return;
  clear();
  if (msg && el!.matches(':focus-visible')) {
    msg.setAttribute('data-focus-in', '');
    marked = msg;
  }
}

export function trackMessageFocus() {
  document.addEventListener('focusin', (e) => mark(e.target instanceof Element ? e.target : null));
  document.addEventListener('focusout', clear);
  // Foco que veio do mouse e passa a ser de teclado (uma tecla com o botão focado).
  document.addEventListener('keydown', () => mark(document.activeElement), true);
}
