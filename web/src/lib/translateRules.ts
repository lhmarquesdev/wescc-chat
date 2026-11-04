// Tradução de mensagens: regras puras da web (sem store nem React; os testes do servidor importam direto,
// server/test/web-rules.test.ts). O que nunca é traduzido é a regra única do shared (translatableMessage).
import type { Message } from '@shared/index';
import { hasTextToTranslate, normalizeLang, translatableMessage } from '@shared/translate';

// A web oferece e pede a tradução só do texto de outra pessoa (a API aceita a própria, para scripts) e só quando há
// texto para o tradutor: só emoji, menção, link ou código não tem "Traduzir" (o servidor responderia "idioma não
// identificado" sem nem perguntar ao LibreTranslate). Mensagem de autor excluído (u._id nulo) continua traduzível.
export const isTranslatable = (m: Message, meId: string, room?: { encrypted?: boolean | null } | null) =>
  translatableMessage(room, m) && (m.u?._id ?? null) !== meId && hasTextToTranslate(m.msg);

// Chave da tradução no navegador: muda quando a mensagem é editada (a tradução antiga deixa de valer).
export const translationKey = (m: Pick<Message, '_id' | 'editedAt'>, lang: string) => `${m._id}|${lang}|${m.editedAt ?? ''}`;

let names: Intl.DisplayNames | null | undefined;

// Nome do idioma em português ("inglês", "português (Brasil)"). Código que o navegador não conhece: o nome que o
// servidor de tradução deu, ou o próprio código.
export function languageLabel(code: string, serverName?: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(['pt-BR'], { type: 'language', fallback: 'none' });
    } catch {
      names = null;
    }
  }
  const norm = normalizeLang(code);
  let label: string | undefined;
  try {
    label = names?.of(norm);
  } catch {
    label = undefined; // código fora do formato BCP 47
  }
  return label || serverName || norm || code;
}

export const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);

// A lista dos menus de idioma: em ordem alfabética do nome em português, já com a primeira letra maiúscula.
export function languageOptions(list: { language: string; name: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const l of list) {
    const value = normalizeLang(l.language);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: capitalize(languageLabel(l.language, l.name)) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}
