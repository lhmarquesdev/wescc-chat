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
    const key = foldText(w);
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
  a: '[aáàâãäå]',
  e: '[eéèêë]',
  i: '[iíìîï]',
  o: '[oóòôõö]',
  u: '[uúùûü]',
  c: '[cç]',
  n: '[nñ]',
  y: '[yýÿ]',
};
// Só os caracteres de sintaxe levam barra: no modo u, "\-" e "\:" são erro.
const SYNTAX = /[\\^$.*+?()[\]{}|/]/;
const BEFORE = '(?<![\\p{L}\\p{M}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{M}\\p{N}_])';

function wordPattern(word: string): string {
  let out = '';
  let space = false;
  for (const ch of foldText(word.normalize('NFC'))) {
    if (/\s/u.test(ch)) {
      if (!space) out += '\\s+';
      space = true;
      continue;
    }
    space = false;
    out += (VARIANTS[ch] ?? (SYNTAX.test(ch) ? `\\${ch}` : ch)) + '\\p{M}*';
  }
  return out;
}

export function compileHighlights(words: string[] | undefined | null): HighlightMatcher | null {
  const list = (Array.isArray(words) ? words : []).filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
  if (!list.length) return null;
  const parts = list.map(wordPattern);
  try {
    const each = parts.map((p) => new RegExp(`${BEFORE}(?:${p})${AFTER}`, 'iu'));
    // A expressão mais longa primeiro: "servidor fora" ganha de "servidor".
    const sorted = [...parts].sort((a, b) => b.length - a.length);
    const any = new RegExp(`${BEFORE}(?:${sorted.join('|')})${AFTER}`, 'giu');
    return { words: list, each, any };
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
