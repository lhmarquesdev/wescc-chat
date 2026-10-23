// Sonda de acessibilidade usada por shots.mjs --probe (spec 12.1 e 12.5):
//  - contraste de cada texto visível com o fundo efetivo (4,5:1; 3:1 para texto grande);
//  - contraste dos ícones de botões só com ícone (3:1);
//  - no celular (ponteiro grosso), alvos de toque menores que 44px, contando a área de toque efetiva (::after incluso).
// O fundo efetivo sobe pelos ancestrais compondo fundos e opacidades até uma camada opaca que cubra o resto.
// Elementos com opacidade acumulada perto de 0 (controles que só aparecem no hover) ficam de fora.
// Fundos com imagem ou gradiente ficam de fora (o resultado seria um chute).

export async function probePage(page, { coarse }) {
  return page.evaluate(
    ({ coarse }) => {
      const parse = (c) => {
        let m = /^rgba?\(([^)]+)\)$/.exec(c);
        if (m) {
          const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
        }
        m = /^color\(srgb ([^)]+)\)$/.exec(c);
        if (m) {
          const v = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
          return { r: v[0] * 255, g: v[1] * 255, b: v[2] * 255, a: v.length > 3 ? v[3] : 1 };
        }
        return null;
      };
      const over = (top, bottom) => {
        const a = top.a + bottom.a * (1 - top.a);
        if (!a) return { r: 0, g: 0, b: 0, a: 0 };
        const ch = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
        return { r: ch('r'), g: ch('g'), b: ch('b'), a };
      };
      const lum = ({ r, g, b }) => {
        const f = (x) => {
          x /= 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (x, y) => {
        const [l1, l2] = [lum(x), lum(y)].sort((a, b) => b - a);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      const WHITE = { r: 255, g: 255, b: 255, a: 1 };
      // Cor final do texto (ou ícone) e do fundo, compondo do elemento até a raiz como o navegador faz:
      // cada ancestral desenha o próprio fundo por baixo do conteúdo e aplica a opacidade dele ao grupo.
      // A opacidade de um ancestral vale para o texto e para os fundos dentro dele, não para os de fora.
      // null quando há imagem ou gradiente aparecendo atrás (o resultado seria um chute).
      const composite = (el, color) => {
        const chain = [];
        for (let e = el; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          chain.push({ bg: parse(cs.backgroundColor), op: Number(cs.opacity), img: cs.backgroundImage !== 'none' });
        }
        let fg = color;
        let bg = { r: 0, g: 0, b: 0, a: 0 };
        for (let i = 0; i < chain.length; i++) {
          const { bg: layer, op, img } = chain[i];
          if (!layer) return null;
          // Uma camada opaca com opacidade 1 daqui até a raiz cobre o resto: a composição para nela.
          const covers = layer.a >= 1 && chain.slice(i).every((c) => c.op >= 1);
          if (img) return null;
          fg = over(fg, layer);
          bg = over(bg, layer);
          fg = { ...fg, a: fg.a * op };
          bg = { ...bg, a: bg.a * op };
          if (covers) break;
        }
        return { fg: over(fg, WHITE), bg: over(bg, WHITE) };
      };
      // Opacidade acumulada até a raiz: controles que só aparecem no hover ficam em 0 e não contam.
      const opacity = (el) => {
        let o = 1;
        for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return o;
      };
      const visible = (el, r) => {
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && opacity(el) > 0.05;
      };
      const label = (el) => {
        const cls = [...el.classList].slice(0, 3).join('.');
        const t = el.getAttribute('title') || el.getAttribute('aria-label');
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? `[${t}]` : ''}`;
      };
      const where = (el) => {
        const parts = [];
        for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) parts.unshift(label(e));
        return parts.join(' > ');
      };

      const lowText = [];
      let modalMin = null;
      let checked = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg, .emoji, .qr, [aria-hidden="true"], :disabled, [aria-disabled="true"]')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const r = el.getBoundingClientRect();
        if (!visible(el, r)) continue;
        const cs = getComputedStyle(el);
        const fg0 = parse(cs.color);
        if (!fg0) continue;
        const c = composite(el, fg0);
        if (!c) continue;
        const k = ratio(c.fg, c.bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        checked++;
        if (el.closest('.modal')) modalMin = modalMin === null ? k : Math.min(modalMin, k);
        if (k < need) {
          lowText.push({ where: where(el), text: el.textContent.trim().slice(0, 40), fg: hex(c.fg), bg: hex(c.bg), ratio: +k.toFixed(2), need });
        }
      }

      const lowIcons = [];
      for (const svg of document.querySelectorAll('svg.icon')) {
        const btn = svg.closest('button, a, [role="button"]');
        if (!btn || btn.textContent.trim() || btn.closest(':disabled, [aria-disabled="true"]')) continue;
        // A visibilidade conta pelo botão: a opacidade de "só no hover" fica nele ou num ancestral, não no svg.
        if (!visible(btn, btn.getBoundingClientRect()) || !visible(svg, svg.getBoundingClientRect())) continue;
        const fg0 = parse(getComputedStyle(svg).color);
        if (!fg0) continue;
        const c = composite(svg, fg0);
        if (!c) continue;
        const k = ratio(c.fg, c.bg);
        if (k < 3) lowIcons.push({ where: where(btn), fg: hex(c.fg), bg: hex(c.bg), ratio: +k.toFixed(2) });
      }

      // Área de toque efetiva: um ::after pode crescer além da caixa (spec 9: o visual fica menor, o alvo não).
      // Mede com elementFromPoint nas duas linhas que passam pelo centro, até 22px de cada lado.
      const reach = (t, r) => {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hits = (x, y) => {
          const e = document.elementFromPoint(x, y);
          return !!e && (e === t || t.contains(e));
        };
        if (!hits(cx, cy)) return null;
        const span = (dx, dy) => {
          let n = 0;
          for (let d = 1; d <= 22 && hits(cx + dx * d, cy + dy * d); d++) n = d;
          return n;
        };
        return { w: span(-1, 0) + span(1, 0) + 1, h: span(0, -1) + span(0, 1) + 1 };
      };
      const smallTargets = [];
      if (coarse) {
        const seen = new Set();
        const sel = 'a[href], button, [role="button"], [role="tab"], [role="menuitem"], select, textarea, input:not([type="hidden"]), summary';
        for (const el of document.querySelectorAll(sel)) {
          // Links dentro do texto seguem o texto (exceção "inline" da WCAG 2.5.8).
          if (el.tagName === 'A' && el.closest('.msg-body, p, li, .md-p')) continue;
          // Caixas e rádios contam pelo rótulo inteiro, que é a área clicável.
          const target = el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label') ? el.closest('label') : el;
          if (target.closest(':disabled')) continue;
          const r = target.getBoundingClientRect();
          if (!visible(target, r) && !visible(el, el.getBoundingClientRect())) continue;
          if (Math.min(r.width, r.height) >= 44) continue;
          const hit = reach(target, r);
          // Coberto (folha, menu ou cabeçalho por cima, ou fora da área rolada): não é um alvo agora.
          if (!hit || Math.min(hit.w, hit.h) >= 44) continue;
          const key = label(target);
          if (seen.has(key)) continue;
          seen.add(key);
          smallTargets.push({ where: where(target), size: `${Math.round(r.width)}x${Math.round(r.height)}`, hit: `${hit.w}x${hit.h}` });
        }
      }
      return { checked, modalMin: modalMin === null ? null : +modalMin.toFixed(2), lowText, lowIcons, smallTargets };
    },
    { coarse },
  );
}
