// Limpeza das entradas da API (corpo, consulta e parâmetros da rota), antes de qualquer rota.

// U+0000: o PostgreSQL não grava esse caractere em texto ("invalid byte sequence for encoding UTF8: 0x00"). Ele chega
// em texto colado de logs e terminais e em alertas de webhooks; sai de todas as entradas.
const NUL = /\u0000/g;
// Controles de direção (incorporação, sobreposição e isolamento: U+202A–U+202E, U+2066–U+2069). Um RLO (U+202E)
// num nome ou num tópico inverte o resto do texto na tela de todo mundo.
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
// Nomes (de pessoa, de sala, de equipe, de discussão), tópico, descrição, anúncio, "Sobre" e mensagem de status: perdem
// os controles de direção. O texto das mensagens fica como veio.
const DISPLAY_KEYS = new Set([
  'name',
  'fname',
  't_name',
  'roomName',
  'topic',
  'roomTopic',
  'description',
  'roomDescription',
  'announcement',
  'roomAnnouncement',
  'bio',
  'statusText',
]);
// Corpo aninhado além disso não é de nenhuma rota; o que sobrar cai na rede do errorHandler.
const MAX_DEPTH = 32;

export const stripBidi = (s: string) => s.replace(BIDI, '');

function cleanString(s: string, key: string | undefined) {
  let out = s.includes('\u0000') ? s.replace(NUL, '') : s;
  if (key !== undefined && DISPLAY_KEYS.has(key)) out = stripBidi(out);
  return out;
}

// Limpa no lugar (o objeto veio do parser desta requisição) e devolve o valor limpo.
export function cleanInput(v: unknown, key?: string, depth = 0): unknown {
  if (typeof v === 'string') return cleanString(v, key);
  if (!v || typeof v !== 'object' || depth >= MAX_DEPTH || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = cleanInput(v[i], key, depth + 1);
    return v;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) o[k] = cleanInput(o[k], k, depth + 1);
  return o;
}

// Espaços, caracteres de largura zero e os demais invisíveis (U+200B, U+2060, U+FEFF, controles de direção...), e o
// braile em branco (U+2800), que aparece como nada.
const INVISIBLE = /[\s\p{Default_Ignorable_Code_Point}\u2800]/gu;

// Se o texto tem ao menos um caractere visível (só U+200B não tem).
export const hasVisibleText = (s: string) => s.replace(INVISIBLE, '') !== '';
