// Tradução de mensagens pelo LibreTranslate da empresa: regras puras que o servidor e a web usam iguais (o que nunca é
// traduzido, como a mensagem é cortada em trechos, idiomas, endereço do servidor) e os tipos da API autoTranslate.*.
import { CHANNEL_SRC, CODE_SRC, EMOJI_SRC, MD_LINK_SRC, MENTION_SRC, URL_SRC } from './markdownTokens';
import { encryptedContent } from './messages';

export const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
export const TRANSLATE_MAX_IDS = 50; // mensagens por pedido
export const TRANSLATE_MAX_RUNS = 100; // trechos de texto por mensagem
export const DETECT_MIN_CONFIDENCE = 40; // abaixo disso: idioma não identificado
// Nomes antigos do LibreTranslate (modelos do Argos) → os de hoje (libretranslate/language.py: aliases).
export const LANG_ALIASES: Record<string, string> = { pb: 'pt-BR', zt: 'zh-Hant', zh: 'zh-Hans' };

export type TranslateStatus = 'translated' | 'same' | 'unknown' | 'unsupported' | 'failed';
export type TranslateFailReason = 'rate' | 'busy' | 'timeout' | 'unavailable' | 'too-long' | 'changed' | 'config';
export interface MessageTranslation {
  _id: string;
  status: TranslateStatus;
  language: string; // destino resolvido
  source?: string; // idioma detectado (translated, same, unsupported)
  text?: string; // só com translated
  reason?: TranslateFailReason; // só com failed
}
export interface TranslateResponse {
  language: string;
  translations: MessageTranslation[];
  notice?: string;
  retryAfterMs?: number;
}
export interface TranslateLanguage {
  language: string;
  name: string;
} // formato do Rocket.Chat

// ---------- O que nunca é traduzido ----------

// Os campos de uma mensagem que a regra olha: Message da web ou linha do banco com o extra espalhado.
export interface TranslatableShape {
  t?: string | null;
  msg?: string | null;
  e2e?: unknown;
  sticker?: unknown;
  poll?: unknown;
  forward?: unknown;
}

// A regra única de "nunca traduzir" (o servidor e a web chamam esta): sala criptografada ou mensagem cifrada
// (encryptedContent: rooms.encrypted ou messages.e2e), mensagem de sistema ou removida (t), figurinha, enquete (o
// cartão não mostra o texto), encaminhada (o cartão é de outra mensagem) e mensagem sem texto. O servidor não pode ler
// o que é cifrado, e o texto decifrado no navegador nunca volta ao servidor para ser traduzido.
export function translatableMessage(room: { encrypted?: boolean | null } | null | undefined, m: TranslatableShape | null | undefined): boolean {
  if (!m || encryptedContent(room, m)) return false;
  return !m.t && !m.sticker && !m.poll && !m.forward && typeof m.msg === 'string' && !!m.msg.trim();
}

// ---------- Idiomas ----------

// pt-br → pt-BR, zh-hans → zh-Hans, pb → pt-BR (nome antigo do LibreTranslate).
export function normalizeLang(code: string): string {
  const raw = String(code ?? '')
    .trim()
    .replace(/_/g, '-');
  const alias = LANG_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const [base, ...rest] = raw.split('-');
  const parts = [base.toLowerCase()];
  for (const p of rest) {
    if (/^[A-Za-z]{4}$/.test(p)) parts.push(p[0].toUpperCase() + p.slice(1).toLowerCase()); // escrita
    else if (/^(?:[A-Za-z]{2}|\d{3})$/.test(p)) parts.push(p.toUpperCase()); // região
    else parts.push(p.toLowerCase());
  }
  return parts.join('-');
}

export const baseLang = (code: string) => normalizeLang(code).split('-')[0];

// pt e pt-BR são o mesmo idioma para a tradução; chinês simplificado e tradicional não.
export function sameLanguage(a: string, b: string): boolean {
  const na = normalizeLang(a);
  const nb = normalizeLang(b);
  if (na === nb) return true;
  const base = baseLang(na);
  return base !== 'zh' && base === baseLang(nb);
}

// O código como aparece na lista do servidor: igual, ou do mesmo idioma (preferindo o código que é só o idioma).
export function pickLanguage(want: string, available: string[]): string | null {
  const w = normalizeLang(want);
  const exact = available.find((x) => normalizeLang(x) === w);
  if (exact) return exact;
  const base = baseLang(w);
  const same = available.filter((x) => baseLang(x) === base);
  if (!same.length) return null;
  return same.find((x) => !x.includes('-') && !LANG_ALIASES[x.toLowerCase()]) ?? same[0];
}

// Destino das traduções: o idioma escolhido na sala, o da pessoa (Minha conta › Preferências) ou o padrão da empresa.
export function targetFor(o: {
  sub?: { autoTranslateLanguage?: string | null } | null;
  prefs?: { language?: unknown } | null;
  siteLanguage?: string | null;
}): string {
  const mine = typeof o.prefs?.language === 'string' ? o.prefs.language : '';
  return o.sub?.autoTranslateLanguage || mine || o.siteLanguage || 'pt-BR';
}

// ---------- Endereço do servidor ----------

// O texto das mensagens não sai da empresa: o servidor de tradução precisa ser da rede interna.
export const translateExternalText = (host: string) =>
  `O servidor de tradução precisa estar na rede da empresa: ${host} é um endereço da internet. O texto das mensagens não pode sair da empresa.`;

// Mesma regra do safeFetch (allowlisted): "host:porta" exato, ou "host" sozinho só para https na 443. isExternal (o
// servidor passa a regra dele para IP literal) vem antes: liberar um endereço da internet em INTEGRATIONS_ALLOWED_HOSTS
// não adiantaria, então o aviso é o da rede da empresa.
export function translateUrlCheck(
  raw: string,
  allowed: string[],
  isExternal?: (host: string) => boolean,
): { base: string; hostPort: string } | { problem: string; external?: true } {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return { problem: 'Endereço inválido. Exemplo: http://10.0.0.20:5000' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { problem: 'Use http:// ou https://.' };
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(raw)) {
    return { problem: 'Informe só o endereço do servidor, sem usuário, senha ou parâmetros.' };
  }
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (isExternal?.(bare)) return { problem: translateExternalText(bare), external: true };
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const hostPort = `${host}:${port}`;
  if (!allowed.includes(hostPort) && !(u.protocol === 'https:' && !u.port && allowed.includes(host))) {
    return { problem: `Libere "${hostPort}" em INTEGRATIONS_ALLOWED_HOSTS no servidor do chat e reinicie o serviço.` };
  }
  // Um LibreTranslate atrás de um proxy num caminho (/tradutor) também serve.
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, hostPort };
}

// ---------- Trechos ----------

// k: fica como está; t: vai para o tradutor.
export type Piece = { k: string } | { t: string };

// O que o render mostra como código, link, menção, canal ou emoji (mesmos padrões de web/src/lib/markdown.tsx).
const KEEP = new RegExp([CODE_SRC, MD_LINK_SRC, URL_SRC, MENTION_SRC, CHANNEL_SRC, EMOJI_SRC].map((s) => `(?:${s})`).join('|'), 'g');
// Início de linha que o render trata como marcação: citações, depois título ou item de lista.
const QUOTES = /^(?:[ \t]*>[ \t]?)*/;
const HEADING = /^#{1,4}\s+(?=\S)/;
const LIST_ITEM = /^\s*[-*•]\s+(?=\S)/;
const EDGE_START = /^[\s*_~]+/;
const EDGE = /[\s*_~]/;
const LETTER = /\p{L}/u;

// Corta a mensagem nos pedaços que o tradutor nunca vê. null = mais de TRANSLATE_MAX_RUNS trechos de texto.
// Garantia (testada): joinTranslation(p, runsOf(p)) devolve a mensagem igual (com as quebras de linha em \n).
export function splitForTranslation(msg: string): Piece[] | null {
  const out: Piece[] = [];
  let runs = 0;
  const keep = (k: string) => {
    if (!k) return;
    const last = out[out.length - 1];
    if (last && 'k' in last) last.k += k;
    else out.push({ k });
  };
  const text = (s: string) => {
    if (!s) return;
    const lead = EDGE_START.exec(s)?.[0] ?? '';
    if (lead.length === s.length) return keep(s);
    // O fim é cortado à mão: /[\s*_~]+$/ recomeça de cada posição de uma sequência longa de '*', '_', '~' ou espaços
    // (5.000 caracteres, ~50 ms por mensagem) e travaria o servidor a cada pedido de tradução.
    let end = s.length;
    while (end > lead.length && EDGE.test(s[end - 1])) end--;
    const mid = s.slice(lead.length, end);
    keep(lead);
    if (LETTER.test(mid)) {
      out.push({ t: mid });
      runs++;
    } else keep(mid);
    keep(s.slice(end));
  };
  const line = (l: string) => {
    let rest = l;
    const q = QUOTES.exec(rest)?.[0] ?? '';
    rest = rest.slice(q.length);
    const mark = HEADING.exec(rest)?.[0] ?? LIST_ITEM.exec(rest)?.[0] ?? '';
    keep(q + mark);
    rest = rest.slice(mark.length);
    let last = 0;
    for (const m of rest.matchAll(KEEP)) {
      const idx = m.index ?? 0;
      text(rest.slice(last, idx));
      keep(m[0]);
      last = idx + m[0].length;
    }
    text(rest.slice(last));
  };
  const parts = String(msg ?? '')
    .replace(/\r\n?/g, '\n')
    .split('```');
  parts.forEach((p, i) => {
    if (i > 0) keep('```');
    // Bloco de código (mesmo sem fechamento, como no render): fica inteiro.
    if (i % 2 === 1) return keep(p);
    p.split('\n').forEach((l, j) => {
      if (j > 0) keep('\n');
      line(l);
    });
  });
  return runs > TRANSLATE_MAX_RUNS ? null : out;
}

export const runsOf = (pieces: Piece[]): string[] => pieces.flatMap((p) => ('t' in p ? [p.t] : []));

export function joinTranslation(pieces: Piece[], out: string[]): string {
  let j = 0;
  return pieces.map((p) => ('t' in p ? (out[j++] ?? p.t) : p.k)).join('');
}

const ZWSP = '​';

// Saída do tradutor para um trecho: numa linha só, sem abrir bloco de código nem link novo (U+200B no meio, como
// server/src/integrations/text.ts). null = saída suspeita (vazia ou muito maior que o original: alucinação do modelo).
export function cleanRun(source: string, out: string): string | null {
  let s = String(out ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!s || s.length > source.length * 4 + 50) return null;
  s = s
    .replace(/`{3,}/g, (m) => m.replace(/``(?=`)/g, `\`\`${ZWSP}`))
    .split('](')
    .join(`]${ZWSP}(`)
    .replace(/(https?:)\/\//gi, `$1${ZWSP}//`)
    .replace(/www\./gi, (m) => `${m[0]}${ZWSP}${m.slice(1)}`);
  return s;
}

// Letras somadas nos trechos (menos de MIN_LETTERS: só emoji, menção, link ou código; nem vale perguntar o idioma).
export const letterCount = (pieces: Piece[]) => runsOf(pieces).reduce((n, r) => n + (r.match(/\p{L}/gu)?.length ?? 0), 0);
export const MIN_LETTERS = 3;

// Há texto para o tradutor? Mais de TRANSLATE_MAX_RUNS trechos conta como sim: o servidor responde que é longa demais.
export function hasTextToTranslate(msg: string): boolean {
  const p = splitForTranslation(msg);
  return !p || letterCount(p) >= MIN_LETTERS;
}
