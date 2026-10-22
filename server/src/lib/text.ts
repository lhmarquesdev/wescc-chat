// Corte de texto seguro para gravar em jsonb.
// String.slice conta unidades UTF-16: cortar no meio de um emoji deixa a metade solta, que o JSON.stringify
// escreve como "\ud83d" e o PostgreSQL recusa ("invalid input syntax for type json").

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

// Até `max` caracteres (pontos de código, como um emoji conta um), nunca com metade de um par UTF-16.
// Uma metade solta que já vinha no texto vira U+FFFD.
export function truncate(text: string, max: number): string {
  let s = text;
  if (s.length > max) {
    let i = 0;
    for (let n = 0; n < max && i < s.length; n++) i += isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
    s = s.slice(0, i);
  }
  return s.replace(LONE_SURROGATE, '�');
}

// Tira do fim os caracteres de `chars`. Sem regex: /[.]+$/ é quadrático numa sequência longa que não termina neles.
export function trimEndChars(text: string, chars: string): string {
  let i = text.length;
  while (i > 0 && chars.includes(text[i - 1])) i--;
  return i === text.length ? text : text.slice(0, i);
}
