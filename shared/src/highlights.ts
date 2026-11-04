// Palavras destacadas (Minha conta › Preferências): mensagens com elas ficam marcadas e avisam como uma menção.
// Maiúsculas e acentos não importam ("PLANTAO" acha "plantão"); a palavra precisa estar inteira ("replantão" não conta).
// O servidor (quem recebe aviso) e a web (o que fica marcado) usam as mesmas regras daqui.
import { foldText } from './search';

export const HIGHLIGHTS_MAX = 20;
export const HIGHLIGHT_MIN = 2;
export const HIGHLIGHT_MAX = 40;

const LIST_ERROR = 'Palavras destacadas: envie uma lista de textos.';

// Lista de textos; NFC, espaços colapsados, trim; vazias saem; repetidas (sem acento/maiúsculas) saem, fica a primeira.
export function normalizeHighlights(input: unknown): { ok: true; words: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length > 200) return Array.isArray(input) ? { ok: false, error: `Use no máximo ${HIGHLIGHTS_MAX} palavras destacadas.` } : { ok: false, error: LIST_ERROR };
  const words: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') return { ok: false, error: LIST_ERROR };
    const w = item.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!w) continue;
    const len = [...w].length;
    if (len < HIGHLIGHT_MIN || len > HIGHLIGHT_MAX) return { ok: false, error: `“${w.slice(0, 60)}”: cada palavra destacada precisa ter de ${HIGHLIGHT_MIN} a ${HIGHLIGHT_MAX} caracteres.` };
    if (!/[\p{L}\p{N}]/u.test(w)) return { ok: false, error: `“${w}”: use letras ou números.` };
    // Acentos e outros sinais sobre as letras não contam: "a" com dez sinais em cima é só "a".
    const key = foldText(w);
    if ([...key].length < HIGHLIGHT_MIN || !/[\p{L}\p{N}]/u.test(key))
      return { ok: false, error: `“${w.slice(0, 60)}”: use pelo menos ${HIGHLIGHT_MIN} letras ou números (acentos e sinais sozinhos não contam).` };
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
  }
  if (words.length > HIGHLIGHTS_MAX) return { ok: false, error: `Use no máximo ${HIGHLIGHTS_MAX} palavras destacadas.` };
  return { ok: true, words };
}

export interface HighlightMatcher {
  words: string[];
  each: RegExp[];
  any: RegExp;
}

// Letra sem acento → a letra com os acentos do português (e vizinhos); \p{M}* aceita o acento separado (texto em NFD).
const VARIANTS: Record<string, string> = {
  a: 'aáàâãäå',
  e: 'eéèêë',
  i: 'iíìîï',
  o: 'oóòôõö',
  u: 'uúùûü',
  c: 'cç',
  n: 'nñ',
  y: 'yýÿ',
};
// Dentro de [...] no modo u, só estes levam barra ("\:" seria erro).
const CLASS_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;
const BEFORE = '(?<![\\p{L}\\p{M}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{M}\\p{N}_])';

// Um caractere da palavra (já sem acento e minúsculo): as variantes, em minúscula e maiúscula, numa classe.
// Nada da classe é marca nem espaço. Por isso as expressões não usam a flag i: com ela, maiúsculas e minúsculas se
// misturam com as marcas (o "ι" grego casa com a marca U+0345) e um \p{M}* seguido de algo que também casa com uma
// marca faz o motor testar todas as divisões possíveis de uma fila de marcas: uma mensagem trava o servidor (ReDoS).
function charClass(ch: string): string {
  const out = new Set<string>();
  for (const v of VARIANTS[ch] ?? ch)
    for (const x of [v, v.toLowerCase(), v.toUpperCase()]) if ([...x].length === 1 && !/[\p{M}\s]/u.test(x)) out.add(x);
  return out.size ? `[${[...out].map((x) => (CLASS_SYNTAX.test(x) ? `\\${x}` : x)).join('')}]` : '';
}

// Cada caractere vira "classe + \p{M}*"; espaços viram \s+. Cada trecho do texto só tem um jeito de casar.
function wordPattern(word: string): string {
  let out = '';
  let space = false;
  for (const ch of foldText(word.normalize('NFC'))) {
    if (/\s/u.test(ch)) {
      if (out && !space) out += '\\s+';
      space = true;
      continue;
    }
    const cls = charClass(ch);
    if (!cls) continue;
    space = false;
    out += cls + '\\p{M}*';
  }
  return out.replace(/\\s\+$/, '');
}

export function compileHighlights(words: string[] | undefined | null): HighlightMatcher | null {
  const pairs = (Array.isArray(words) ? words : [])
    .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    .map((w) => ({ w, p: wordPattern(w) }))
    .filter((x) => x.p);
  if (!pairs.length) return null;
  try {
    const each = pairs.map((x) => new RegExp(`${BEFORE}(?:${x.p})${AFTER}`, 'u'));
    // A expressão mais longa primeiro: "servidor fora" ganha de "servidor".
    const sorted = pairs.map((x) => x.p).sort((a, b) => b.length - a.length);
    const any = new RegExp(`${BEFORE}(?:${sorted.join('|')})${AFTER}`, 'gu');
    return { words: pairs.map((x) => x.w), each, any };
  } catch {
    return null;
  }
}

// A palavra (como a pessoa escreveu) que aparece no texto, ou null.
export function findHighlight(text: string, m: HighlightMatcher | null): string | null {
  if (!m || !text) return null;
  for (let i = 0; i < m.each.length; i++) if (m.each[i].test(text)) return m.words[i];
  return null;
}

// O texto em pedaços, marcando os trechos destacados. Juntar os pedaços devolve o texto original.
export function splitHighlights(text: string, m: HighlightMatcher | null): { text: string; hit: boolean }[] {
  if (!m || !text) return text ? [{ text, hit: false }] : [];
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const x of text.matchAll(m.any)) {
    const at = x.index ?? 0;
    if (!x[0]) continue;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: x[0], hit: true });
    last = at + x[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
