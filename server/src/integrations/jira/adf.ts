// Texto ↔ Atlassian Document Format (corpo da descrição e dos comentários na API v3) e wiki do Jira → texto (puro).

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
  version?: number;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

// Linha com os endereços como links (marca link do ADF); o resto é texto puro.
function inline(line: string): AdfNode[] {
  const out: AdfNode[] = [];
  let last = 0;
  for (const m of line.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: line.slice(last, at) });
    out.push({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] });
    last = at + url.length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

// Parágrafos separados por linha em branco; quebra simples vira hardBreak.
export function adfParagraphs(text: string): AdfNode[] {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim());
  return paras.map((p) => {
    const content: AdfNode[] = [];
    p.split('\n').forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      content.push(...inline(line));
    });
    return { type: 'paragraph', content };
  });
}

export const adfDoc = (content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] });
export const adfRule = (): AdfNode => ({ type: 'rule' });
export const adfQuote = (text: string): AdfNode => ({ type: 'blockquote', content: adfParagraphs(text).length ? adfParagraphs(text) : [{ type: 'paragraph', content: [] }] });
export const textToAdf = (text: string): AdfNode => adfDoc(adfParagraphs(text));

// ADF → texto simples. Blocos separados por linha em branco; nada de HTML.
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const out = blocks((node as AdfNode).type === 'doc' ? ((node as AdfNode).content ?? []) : [node as AdfNode]);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function blocks(list: AdfNode[]): string {
  return list.map(block).filter((s) => s !== '').join('\n\n');
}

function block(n: AdfNode): string {
  switch (n.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(n.content ?? []);
    case 'codeBlock':
      return inlineText(n.content ?? []);
    case 'blockquote':
      return blocks(n.content ?? [])
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${blocks(li.content ?? []).replace(/\n/g, '\n  ')}`).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.order ?? 1) || 1;
      return (n.content ?? []).map((li, i) => `${start + i}. ${blocks(li.content ?? []).replace(/\n/g, '\n   ')}`).join('\n');
    }
    case 'rule':
      return '---';
    case 'table':
      return (n.content ?? []).map((row) => (row.content ?? []).map((cell) => blocks(cell.content ?? []).replace(/\n+/g, ' ')).join(' | ')).join('\n');
    case 'panel':
    case 'expand':
    case 'nestedExpand':
    case 'layoutSection':
    case 'layoutColumn':
    case 'listItem':
      return blocks(n.content ?? []);
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '';
    default:
      return n.content ? blocks(n.content) : inlineText([n]);
  }
}

function inlineText(list: AdfNode[]): string {
  let s = '';
  for (const n of list) {
    if (n.type === 'text') s += n.text ?? '';
    else if (n.type === 'hardBreak') s += '\n';
    else if (n.type === 'mention') s += String(n.attrs?.text ?? '@pessoa');
    else if (n.type === 'emoji') s += String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    else if (n.type === 'inlineCard' || n.type === 'blockCard') s += String(n.attrs?.url ?? '');
    else if (n.type === 'date') s += n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    else if (n.type === 'status') s += String(n.attrs?.text ?? '');
    else if (n.content) s += inlineText(n.content);
  }
  return s;
}

// Wiki do Jira (corpos antigos de webhook) → texto simples, sem marcações.
export function wikiToText(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(/\r\n?/g, '\n');
  s = s.replace(/\{(?:code|noformat)(?::[^}]*)?\}([\s\S]*?)\{(?:code|noformat)\}/g, (_m, body: string) => body.trim());
  s = s.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_m, body: string) => body.trim().split('\n').map((l) => `> ${l}`).join('\n'));
  s = s.replace(/\{color(?::[^}]*)?\}/g, '').replace(/\{panel(?::[^}]*)?\}/g, '');
  s = s.replace(/\[~accountid:[^\]]+\]/g, '@pessoa').replace(/\[~([^\]]+)\]/g, '@$1');
  s = s.replace(/\[([^|\]\n]+)\|([^\]\n]+)\]/g, (_m, label: string, url: string) => (label.trim() === url.trim() ? url.trim() : `${label.trim()} (${url.trim()})`));
  s = s.replace(/\[(https?:\/\/[^\]\s]+)\]/g, '$1');
  s = s.replace(/![^!\n]+!/g, '');
  s = s.replace(/^h[1-6]\.\s+/gm, '').replace(/^bq\.\s+/gm, '> ').replace(/^-{4,}\s*$/gm, '---');
  s = s.replace(/^\s*[*#]+\s+/gm, '- ');
  s = s.replace(/\|\|/g, ' | ').replace(/^\s*\|\s*|\s*\|\s*$/gm, '');
  s = s.replace(/\{\{([^}]*)\}\}/g, '$1');
  s = s.replace(/(^|[\s(])[*_+\-^~]([^\s*_+\-^~][^*_+^~\n]*?)[*_+\-^~](?=$|[\s).,;:!?])/gm, '$1$2');
  s = s.replace(/\?\?([^?\n]+)\?\?/g, '$1');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
