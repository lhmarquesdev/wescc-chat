// O texto de um erro da API para mostrar. Rede de segurança: um texto em inglês (o padrão antigo do servidor, o de um
// proxy) ou só o código do erro vira uma frase em português.
const EN_DEFAULTS: Record<string, string> = {
  'User does not have the permissions required for this action': 'Você não tem permissão para fazer isso.',
  'You must be logged in to do this.': 'Entre de novo para continuar.',
};
const BY_TYPE: Record<string, string> = {
  'error-not-allowed': 'Você não tem permissão para fazer isso.',
  'error-unauthorized': 'Entre de novo para continuar.',
};
export function readableError(status: number, type: string | undefined, error: unknown): string {
  const msg = typeof error === 'string' ? error.trim() : '';
  if (EN_DEFAULTS[msg]) return EN_DEFAULTS[msg];
  if (!msg || msg === type || /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(msg)) {
    if (type && BY_TYPE[type]) return BY_TYPE[type];
    if (status === 401) return BY_TYPE['error-unauthorized'];
    if (status === 403) return BY_TYPE['error-not-allowed'];
    if (status === 404) return 'Não encontrado.';
    if (status === 429) return 'Muitas tentativas. Espere um pouco e tente de novo.';
    return `Não deu certo (erro ${status}).`;
  }
  return msg;
}
