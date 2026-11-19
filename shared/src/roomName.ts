// Nome de canal, grupo ou time: até 64 caracteres, letras (inclusive acentuadas), números, ponto, hífen e sublinhado,
// com pelo menos uma letra ou número. A tela (erro embaixo do campo) e o servidor usam a mesma regra e o mesmo texto.
export const ROOM_NAME_MAX = 64;

// Letras latinas com acento (À-ÿ e Latin Extended-A), sem × e ÷, que caem no meio da faixa.
const ALNUM = /[0-9a-zA-ZÀ-ÖØ-öø-ſ]/;
const ALLOWED = /[0-9a-zA-ZÀ-ÖØ-öø-ſ._-]/;

export function roomNameProblem(name: string): string | null {
  if (!name) return 'Informe o nome.';
  if (name.length > ROOM_NAME_MAX) return `O nome pode ter no máximo ${ROOM_NAME_MAX} caracteres.`;
  const bad = [...name].find((c) => !ALLOWED.test(c));
  if (bad) return /\s/.test(bad) ? 'O nome não pode ter espaços.' : `O caractere “${bad}” não é permitido. Use letras, números, ponto, hífen ou sublinhado.`;
  if (!ALNUM.test(name)) return 'O nome precisa ter pelo menos uma letra ou número.';
  return null;
}

// Tópico, descrição e anúncio da sala: limites iguais no servidor e na tela (aviso embaixo do campo). O tópico é uma
// linha no cabeçalho; o anúncio vai até o tamanho padrão de uma mensagem.
export const ROOM_TEXT_MAX = { topic: 250, description: 2000, announcement: 5000 } as const;
export type RoomTextField = keyof typeof ROOM_TEXT_MAX;
const ROOM_TEXT_LABEL: Record<RoomTextField, string> = { topic: 'O tópico', description: 'A descrição', announcement: 'O anúncio' };

export function roomTextProblem(field: RoomTextField, value: unknown): string | null {
  if (typeof value !== 'string') return `${ROOM_TEXT_LABEL[field]} precisa ser um texto.`;
  const max = ROOM_TEXT_MAX[field];
  if (value.length > max) return `${ROOM_TEXT_LABEL[field]} pode ter no máximo ${max.toLocaleString('pt-BR')} caracteres (tem ${value.length.toLocaleString('pt-BR')}).`;
  return null;
}
