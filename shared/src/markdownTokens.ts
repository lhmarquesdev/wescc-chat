// Tokens do markdown do chat. O render (web/src/lib/markdown.tsx) e a tradução (shared/src/translate.ts) usam os
// mesmos: o que o render mostra como código, link, menção, canal ou emoji nunca vai para o tradutor.

// Cada alternativa, quando falha, só percorre texto onde ela mesma não pode começar de novo, então a busca é linear:
// uma linha cheia de '[' não trava a tela de quem abre a sala. O rótulo do link não aceita '['; o endereço aceita '[' e
// ']' (?ids[]=1, filter[x]=y, [::1]), menos um '[' que abre outro "[texto](", e é aí que a tentativa que falhou para.
export const MD_LINK_SRC = '\\[[^\\[\\]\\n]+\\]\\((?:https?:\\/\\/|\\/)(?:[^)\\s\\[]|\\[(?![^\\[\\]\\n]*\\]\\())+\\)';
export const CODE_SRC = '`[^`\\n]+`';
export const URL_SRC = "(?:https?:\\/\\/|www\\.)[^\\s<]+[^\\s<.,;:!?)\\]'\"]";
export const BOLD_SRC = '\\*\\*[^*\\n]+\\*\\*|\\*[^*\\s][^*\\n]*\\*';
export const ITALIC_SRC = '__[^_\\n]+__|(?<![\\w])_[^_\\s][^_\\n]*_(?![\\w])';
export const STRIKE_SRC = '~~[^~\\n]+~~|~[^~\\s][^~\\n]*~';
export const MENTION_SRC = '(?<![\\w@])@[0-9a-zA-Z._-]+';
export const CHANNEL_SRC = '(?<![\\w#&])#[0-9a-zA-Z\\u00C0-\\u017F._-]+';
export const EMOJI_SRC = ':[a-z0-9_+\\-]+:';
