// Busca sem acento e sem diferença de maiúsculas: "Permissão" acha "permissao" e vice-versa. Um só lugar para dobrar
// texto (Papéis e permissões, encaminhar, busca): quem precisar de outra regra estende aqui. No banco, a mesma ideia
// é a função wescc_fold (migração 030).
export const foldText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Todas as palavras do termo aparecem no texto (em qualquer ordem), já dobradas.
export function foldMatches(haystack: string, term: string): boolean {
  const words = foldText(term).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = foldText(haystack);
  return words.every((w) => hay.includes(w));
}

// ---------- Busca da barra lateral (Ctrl+K) ----------

export type SpotlightScope = 'all' | 'users' | 'rooms';
export const SPOTLIGHT_MIN = 2; // letras mínimas para ir ao servidor
export const SPOTLIGHT_MAX = 64; // o resto é cortado

// "@ana" busca só pessoas, "#sup" só salas. Um só prefixo; espaços nas pontas saem.
export function parseSpotlightQuery(raw: string): { text: string; scope: SpotlightScope } {
  let text = String(raw ?? '').trim();
  let scope: SpotlightScope = 'all';
  if (text.startsWith('@')) scope = 'users';
  else if (text.startsWith('#')) scope = 'rooms';
  if (scope !== 'all') text = text.slice(1).trim();
  return { text: [...text].slice(0, SPOTLIGHT_MAX).join(''), scope };
}

export const spotlightReady = (q: { text: string }) => [...q.text].length >= SPOTLIGHT_MIN;

// % e _ do termo valem como letras no LIKE (o escape padrão do PostgreSQL é a barra invertida).
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
