// Busca sem acento e sem diferença de maiúsculas: "Permissão" acha "permissao" e vice-versa. Um só lugar para dobrar
// texto (Papéis e permissões, encaminhar, busca): quem precisar de outra regra estende aqui.
export const foldText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Todas as palavras do termo aparecem no texto (em qualquer ordem), já dobradas.
export function foldMatches(haystack: string, term: string): boolean {
  const words = foldText(term).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = foldText(haystack);
  return words.every((w) => hay.includes(w));
}
