// HTML de uma mensagem do Teams → markdown do chat (§5.4). Puro e sem dependência: lista branca de tags, nunca
// renderizado como HTML. Só links https sobrevivem, e só os de hosts conhecidos ficam clicáveis.
//
// D21: o texto de fora passa por safeText UMA vez, já montado. Um endereço, um "](" ou um "@all" partido entre
// tags, comentários, <img> ou <emoji> ("https:<span>//evil</span>", "[x]<!-- -->(//evil)", "@<b></b>all") só
// aparece inteiro depois da montagem; tratado nó a nó, cada pedaço parecia inofensivo. Os links de hosts conhecidos
// são os únicos que ficam fora dessa passada: entram como marcas (U+0003 com um código sorteado) e voltam no fim.
// Depois da passada nada é apagado: ela desembrulha Safe Links (url=%01, %03…) e um caractere apagado ali juntaria
// pedaços que ela conferiu separados ("https:" e "//", "]" e "(", "@" e "all"). O que sobrar de controle vira U+200B.
import { randomBytes } from 'node:crypto';
import { unwrapSafeLinks } from '@shared/integrations';

export interface HtmlOptions {
  trustedHost: (host: string) => boolean; // trustedLinkHost (§3.9)
  safeText: (s: string) => string; // safeExternalText: links soltos de fora sem clique, menções neutralizadas
  max?: number; // Message_MaxAllowedSize
}

export const HTML_TEXT = {
  image: '[imagem]',
  file: (name: string, url: string) => `Arquivo no Teams: ${name} (${url})`,
  hidden: '[conteúdo do Teams que o chat não mostra]',
  olderThread: '_Resposta numa conversa anterior do Teams_',
};

const MAX_INPUT = 100 * 1024;
// Níveis de tags guardados na árvore. Os de dentro disso valem só pelo texto: a saída não precisa de mais, e a
// renderização recursiva não estoura a pilha com "<b>" repetido milhares de vezes.
const MAX_DEPTH = 32;
// Citações e itens de lista refazem a limpeza de espaços do que têm dentro: além de 5 níveis um dentro do outro,
// valem como bloco comum (o custo fica em 5 × o tamanho, não 32 ×).
const MAX_NEST = 5;

// Caracteres de controle (menos tab e quebra de linha) não chegam à saída: alguns são as marcas internas
// (U+0001 quebra, U+0002 bloco de código, U+0003 link pronto) e não podem vir de fora, nem por entidade (&#2;).
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(CTRL, '');
const ZWSP = '\u200b';

// ---------- Entidades ----------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', deg: '°',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ',
  uacute: 'ú', uuml: 'ü', ccedil: 'ç', Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í',
  Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Ccedil: 'Ç', zwj: '‍', zwnj: '‌',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return NAMED[e] ?? m;
  });
}

// ---------- Árvore ----------

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | string;

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track', 'param']);
const DROP = new Set(['script', 'style', 'head', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'title', 'textarea', 'select']);

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = clean(decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

const selfClosing = (attrs: string) => attrs.trimEnd().endsWith('/');

function parse(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  let skip: string | null = null; // dentro de <script>, <style>…: tudo é descartado até o fechamento
  // Cada "<" olha adiante no máximo um nome de 41 caracteres e 2000 de atributos, e nunca passa de outro "<":
  // a busca fica linear mesmo com "<a" seguido de 100 KB de letras ou "<a " repetido.
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^<>]{0,2000}>|<\/([a-zA-Z][a-zA-Z0-9-]{0,40})\s{0,100}>|<([a-zA-Z][a-zA-Z0-9-]{0,40})((?:[\s/][^<>]{0,2000})?)>|([^<]+)|</g;
  for (const m of html.matchAll(re)) {
    const [all, close, open, attrs, text] = m;
    if (skip) {
      if (close && close.toLowerCase() === skip) skip = null;
      continue;
    }
    if (text !== undefined || all === '<') {
      stack[stack.length - 1].children.push(text ?? '<');
      continue;
    }
    if (open) {
      const tag = open.toLowerCase();
      const a = attrs ?? '';
      if (DROP.has(tag)) {
        if (!selfClosing(a)) skip = tag;
        continue;
      }
      const container = !VOID.has(tag) && !selfClosing(a);
      if (container && stack.length > MAX_DEPTH) continue; // fundo demais: o conteúdo fica no nível de cima
      const el: El = { tag, attrs: parseAttrs(selfClosing(a) ? a.trimEnd().slice(0, -1) : a), children: [] };
      stack[stack.length - 1].children.push(el);
      if (container) stack.push(el);
      continue;
    }
    if (close) {
      const tag = close.toLowerCase();
      for (let at = stack.length - 1; at > 0; at--) {
        if (stack[at].tag === tag) {
          stack.length = at;
          break;
        }
      }
    }
    // Comentários, doctype e CDATA ficam de fora.
  }
  return root;
}

// ---------- Saída ----------

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd']);
const URLISH = /^(?:https?:\/\/|www\.)\S+$|^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const BR = '\u0001'; // quebra de linha forçada (<br>): não some na limpeza de espaços

function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    const t = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    try {
      const u = new URL(t);
      return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
    } catch {
      return s.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

// Sem regex com espaço dos dois lados: "x" + 50 mil espaços + "x" ficaria quadrático.
function trimNewlines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '\n') a++;
  while (b > a && s[b - 1] === '\n') b--;
  return s.slice(a, b);
}

// Envolve cada trecho não vazio (linha a linha) com a marca: "  texto " → "  **texto** ".
function wrap(inner: string, mark: string): string {
  return inner
    .split(/(\n|\u0001)/)
    .map((part) => {
      if (part === '\n' || part === BR) return part;
      const body = part.trim();
      if (!body) return part;
      const lead = part.length - part.trimStart().length;
      return `${part.slice(0, lead)}${mark}${body}${mark}${part.slice(lead + body.length)}`;
    })
    .join('');
}

interface Ctx {
  o: HtmlOptions;
  pre: boolean;
  inLink: boolean; // rótulo de um link: só o texto, sem marcação
  nest: number; // citações e itens de lista em volta
  list: { ordered: boolean; n: number } | null;
  blocks: string[]; // blocos de código já prontos: ficam fora da limpeza de espaços (a indentação do código vale)
  links: string[]; // links de hosts conhecidos já prontos: ficam fora da passada de safeText
  nonce: string; // código das marcas de link: um url= desembrulhado não sabe imitá-las
}

const newCtx = (o: HtmlOptions): Ctx => ({ o, pre: false, inLink: false, nest: 0, list: null, blocks: [], links: [], nonce: randomBytes(8).toString('hex') });

// Marca de um bloco de código guardado em ctx.blocks; volta ao texto só depois da limpeza.
const blockMark = (c: Ctx, body: string) => `\u0002${c.blocks.push(body) - 1}\u0002`;
const expandBlocks = (s: string, c: Ctx) => s.replace(/\u0002(\d+)\u0002/g, (_m, i: string) => c.blocks[Number(i)] ?? '');
// Marca de um link pronto guardado em ctx.links; volta só depois de safeText (ver finish).
const linkMark = (c: Ctx, md: string) => `\u0003${c.nonce}${c.links.push(md) - 1}\u0003`;

// Link markdown de um host conhecido. O rótulo é texto de fora: passa por safeText sozinho, sem colchetes. Os que
// safeText desembrulhar (%5B, %5D) e os controles viram U+200B: um "]" ou um "(" a mais não fecha o rótulo antes.
function trusted(c: Ctx, label: string, href: string): string {
  const text = c.o
    .safeText(label.replace(/[[\]]/g, ''))
    .replace(/[[\]]/g, ZWSP)
    .replace(CTRL, ZWSP)
    .replace(/\s+/g, ' ')
    .trim();
  return text ? linkMark(c, `[${text}](${href})`) : href;
}

function link(el: El, c: Ctx): string {
  let href = unwrapSafeLinks(String(el.attrs.href ?? '').trim());
  let u: URL | null = null;
  try {
    u = new URL(href);
  } catch {
    u = null;
  }
  if (!u || u.protocol !== 'https:' || u.username || u.password) return renderChildren(el, c);
  const label = renderChildren(el, { ...c, inLink: true }).replace(/\s+/g, ' ').trim();
  // Mostra o endereço como veio (sem a "/" que o URL acrescenta); só espaços e parênteses são codificados. Com controle
  // (um url= do Safe Links com %01), vale a forma do URL, que codifica tudo.
  href = (/^[^\s<>"'`\u0000-\u001f\u007f]+$/.test(href) ? href : u.toString()).replace(/\(/g, '%28').replace(/\)/g, '%29');
  const host = u.hostname.toLowerCase();
  // Nada aqui passa por safeText: o texto de fora volta cru e a passada única de finish trata o que ficar em volta.
  if (!label) return href;
  if (URLISH.test(label)) {
    // O texto visível é um endereço: diferente do destino → os dois à mostra (nada esconde para onde o link vai).
    if (!sameUrl(label, href)) return `${label} (${href})`;
    return c.o.trustedHost(host) ? trusted(c, label, href) : href;
  }
  if (c.o.trustedHost(host)) return trusted(c, label, href);
  return `${label} (${href})`;
}

function renderChildren(el: El, c: Ctx): string {
  return el.children.map((n) => render(n, c)).join('');
}

// Dentro do rótulo de um link: só o texto.
function renderLabel(n: El, c: Ctx): string {
  switch (n.tag) {
    case 'br':
      return ' ';
    case 'img':
      return HTML_TEXT.image;
    case 'emoji':
      return n.attrs.alt || renderChildren(n, c);
    case 'attachment':
      return '';
    default:
      return renderChildren(n, c);
  }
}

function render(n: Node, c: Ctx): string {
  if (typeof n === 'string') {
    const t = clean(decodeEntities(n));
    return c.pre ? t : t.replace(/[\t\r\n ]+/g, ' ');
  }
  if (c.inLink) return renderLabel(n, c);
  switch (n.tag) {
    case 'br':
      return BR;
    case 'img':
      return HTML_TEXT.image;
    case 'emoji':
      return n.attrs.alt || renderChildren(n, c).trim();
    case 'attachment':
      return '';
    case 'at':
      return renderChildren(n, c).replace(/\s+/g, ' ');
    case 'a':
      return link(n, c);
    case 'b':
    case 'strong':
      return wrap(renderChildren(n, c), '**');
    case 'i':
    case 'em':
      return wrap(renderChildren(n, c), '_');
    case 'code':
      if (c.pre) return renderChildren(n, c);
      return wrap(renderChildren(n, c).replace(/`/g, "'"), '`');
    case 'pre': {
      const body = trimNewlines(renderChildren(n, { ...c, pre: true }).replace(/\u0001/g, '\n')).replace(/```/g, "'''");
      return `\n${blockMark(c, `\`\`\`\n${body}\n\`\`\``)}\n`;
    }
    case 'blockquote': {
      if (c.nest >= MAX_NEST) return `\n${renderChildren(n, c)}\n`;
      const inner = expandBlocks(tidy(renderChildren(n, { ...c, nest: c.nest + 1 })), c);
      return `\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
    }
    case 'ul':
    case 'ol': {
      // Espaços entre os itens (HTML indentado) não viram linhas.
      const sub: Ctx = { ...c, list: { ordered: n.tag === 'ol', n: 0 } };
      return `\n${n.children.filter((x) => typeof x !== 'string' || x.trim()).map((x) => render(x, sub)).join('')}\n`;
    }
    case 'li': {
      if (c.nest >= MAX_NEST) return `\n${renderChildren(n, { ...c, list: null })}\n`;
      const l = c.list ?? { ordered: false, n: 0 };
      l.n++;
      const bullet = l.ordered ? `${l.n}. ` : '- ';
      // Linhas seguintes (e listas dentro do item) ficam alinhadas depois do marcador.
      const inner = expandBlocks(tidy(renderChildren(n, { ...c, list: null, nest: c.nest + 1 })), c).replace(/\n/g, `\n${' '.repeat(bullet.length)}`);
      return `\n${bullet}${inner}\n`;
    }
    case 'hr':
      return '\n';
    default: {
      const inner = renderChildren(n, c);
      return BLOCK.has(n.tag) ? `\n${inner}\n` : inner;
    }
  }
}

// Linhas sem espaço sobrando, no máximo uma linha em branco seguida.
// Itens de lista seguidos ficam sem linha em branco entre eles; a indentação só vale para itens aninhados.
function tidy(s: string): string {
  return trimNewlines(
    s
      .replace(/\u0001 ?/g, '\n')
      .split('\n')
      .map((l) => {
        const m = /^([ \t]*)(.*)$/.exec(l)!;
        const body = m[2].replace(/[ \t]+/g, ' ').trimEnd();
        return /^(?:- |\d+\. )/.test(body) ? `${m[1].replace(/\t/g, '  ')}${body}` : body;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(?<=^|\n)( *(?:- |\d+\. )[^\n]*)\n\n(?= *(?:- |\d+\. ))/g, '$1\n'),
  );
}

// HTML → markdown ainda cru (texto de fora sem safeText, links prontos como marcas).
function convert(html: string, c: Ctx): string {
  const root = parse(clean(String(html ?? '').slice(0, MAX_INPUT)));
  return expandBlocks(tidy(renderChildren(root, c)), c);
}

// A passada única de safeText sobre o texto já montado; depois os links prontos voltam, cada um uma vez. Numa só
// troca: a marca certa volta como link; marca repetida ou desconhecida e qualquer outro controle viram U+200B.
function finish(s: string, c: Ctx): string {
  const used = new Set<number>();
  const marks = new RegExp(`\u0003${c.nonce}(\\d+)\u0003|${CTRL.source}`, 'g');
  return c.o.safeText(s).replace(marks, (_m, i: string | undefined) => {
    const n = Number(i);
    if (i === undefined || used.has(n) || c.links[n] === undefined) return ZWSP;
    used.add(n);
    return c.links[n];
  });
}

export function teamsHtmlToMarkdown(html: string, o: HtmlOptions): string {
  const c = newCtx(o);
  return finish(convert(html, c), c);
}

// Corpo sem texto nenhum (só anexos, tags e espaços)? Lido pela mesma árvore da conversão, com o mesmo corte: uma
// regex "<[^>]+>" sobre o corpo cru voltava ao fim do texto a cada "<" sem ">" (28 KB de "<" seguravam o servidor).
export function htmlIsBlank(html: string): boolean {
  const blank = (el: El): boolean => el.children.every((n) => (typeof n === 'string' ? !decodeEntities(n).trim() : blank(n)));
  return blank(parse(clean(String(html ?? '').slice(0, MAX_INPUT))));
}

// Nome de fora (autor, equipe, canal, pessoa) numa linha, pela passada de safeText. Controles viram espaço antes e
// depois dela: o que ela desembrulhar de um Safe Links (url=%00, %0A…) não junta nada nem chega ao banco (U+0000 o
// Postgres recusa sempre, e a mesma mensagem falharia a cada nova tentativa).
export function safeName(raw: unknown, safeText: (s: string) => string, max = 80): string {
  const line = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return line(safeText(Array.from(line(String(raw ?? ''))).slice(0, max).join('')));
}

// ---------- Mensagem inteira ----------

export interface TeamsMessageLike {
  subject?: string | null;
  body?: { contentType?: string; content?: string } | null;
  attachments?: { contentType?: string; name?: string | null; contentUrl?: string | null; content?: string | null }[] | null;
}

// Corte por pontos de código (um emoji não fica pela metade).
export function cutText(s: string, max: number): string {
  if (!max || s.length <= max) return s;
  const chars = Array.from(s);
  let out = '';
  for (const ch of chars) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

// Assunto, corpo e arquivos montados crus e tratados juntos por finish: um "[x]" no assunto e um "(//evil)" no
// corpo não viram link por estarem lado a lado.
export function teamsMessageText(m: TeamsMessageLike, o: HtmlOptions): string {
  const c = newCtx(o);
  const parts: string[] = [];
  const subject = clean(String(m.subject ?? '')).replace(/\s+/g, ' ').trim();
  if (subject) parts.push(`**${subject}**`);
  const content = String(m.body?.content ?? '');
  const text = String(m.body?.contentType ?? 'html').toLowerCase() === 'text' ? tidy(clean(content.slice(0, MAX_INPUT))) : convert(content, c);
  if (text) parts.push(text);
  let hidden = false;
  for (const a of m.attachments ?? []) {
    if (a?.contentType === 'reference' && a.contentUrl) {
      let url: URL | null = null;
      try {
        url = new URL(unwrapSafeLinks(String(a.contentUrl)));
      } catch {
        url = null;
      }
      const name = clean(String(a.name ?? '')).replace(/\s+/g, ' ').trim() || 'arquivo';
      parts.push(url && url.protocol === 'https:' ? HTML_TEXT.file(name, url.toString()) : name);
    } else if (!hidden) {
      hidden = true;
      parts.push(HTML_TEXT.hidden);
    }
  }
  return cutText(finish(parts.join('\n'), c), o.max ?? 0);
}
