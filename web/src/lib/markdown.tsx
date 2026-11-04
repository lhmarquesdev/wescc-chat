import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { splitHighlights, type HighlightMatcher } from '@shared/highlights';
import type { Message } from '@shared/index';
import { BOLD_SRC, CHANNEL_SRC, CODE_SRC, EMOJI_SRC, ITALIC_SRC, MD_LINK_SRC, MENTION_SRC, STRIKE_SRC, URL_SRC } from '@shared/markdownTokens';
import { resolveEmoji } from './emoji';

// Renderização das mensagens no estilo do Rocket.Chat, sem HTML bruto:
// ```bloco```, `código`, *negrito*, **negrito**, _itálico_, ~tachado~, > citação,
// [texto](url), links automáticos, @menções, #canais e :emoji:.

interface Opts {
  me?: string;
  mentions?: Message['mentions'];
  channels?: Message['channels'];
  onUserClick?: (username: string) => void;
  highlights?: HighlightMatcher | null; // palavras destacadas de quem lê (só no texto comum; nunca em código, link ou menção)
}

// Texto comum com as palavras destacadas marcadas.
function hl(text: string, o: Opts, key: string): ReactNode[] {
  if (!o.highlights || !text) return [text];
  return splitHighlights(text, o.highlights).map((p, j) =>
    p.hit ? (
      <mark key={`${key}-h${j}`} className="hl-word">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

// Os padrões ficam em @shared/markdownTokens: a tradução corta a mensagem nos mesmos tokens.
const INLINE = new RegExp(
  [
    `(${CODE_SRC})`, // 1 código
    `(${MD_LINK_SRC})`, // 2 link markdown
    `(${URL_SRC})`, // 3 url
    `(${BOLD_SRC})`, // 4 negrito
    `(${ITALIC_SRC})`, // 5 itálico
    `(${STRIKE_SRC})`, // 6 tachado
    `(${MENTION_SRC})`, // 7 menção
    `(${CHANNEL_SRC})`, // 8 canal
    `(${EMOJI_SRC})`, // 9 emoji
  ].join('|'),
  'g',
);

function safeUrl(url: string) {
  const u = url.startsWith('www.') ? `https://${url}` : url;
  return /^(https?:\/\/|\/)/i.test(u) ? u : '#';
}

// Tira os pontos do fim sem regex: /[.]+$/ recomeça em cada ponto e fica quadrático em "@....a".
function trimDots(s: string) {
  let end = s.length;
  while (end > 0 && s[end - 1] === '.') end--;
  return s.slice(0, end);
}

function inline(text: string, o: Opts, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    const k = `${keyBase}-${i++}`;
    if (idx > last) out.push(...hl(text.slice(last, idx), o, `${k}t`));
    const [all, code, mdLink, url, bold, italic, strike, mention, channel, emoji] = m;
    if (code) out.push(<code key={k} className="md-code">{code.slice(1, -1)}</code>);
    else if (mdLink) {
      const mm = mdLink.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(
        <a key={k} href={safeUrl(mm[2])} target="_blank" rel="noopener noreferrer">
          {mm[1]}
        </a>,
      );
    } else if (url) {
      out.push(
        <a key={k} href={safeUrl(url)} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
    } else if (bold) {
      const inner = bold.startsWith('**') ? bold.slice(2, -2) : bold.slice(1, -1);
      out.push(<strong key={k}>{inline(inner, o, k)}</strong>);
    } else if (italic) {
      const inner = italic.startsWith('__') ? italic.slice(2, -2) : italic.slice(1, -1);
      out.push(<em key={k}>{inline(inner, o, k)}</em>);
    } else if (strike) {
      const inner = strike.startsWith('~~') ? strike.slice(2, -2) : strike.slice(1, -1);
      out.push(<del key={k}>{inline(inner, o, k)}</del>);
    } else if (mention) {
      const name = trimDots(mention.slice(1));
      const known = name === 'all' || name === 'here' || o.mentions?.some((x) => x.username.toLowerCase() === name.toLowerCase());
      if (!known) out.push(...hl(mention, o, k));
      else {
        const cls = name === o.me ? 'mention me' : name === 'all' || name === 'here' ? `mention group ${name}` : 'mention';
        out.push(
          <span key={k} className={cls} onClick={() => name !== 'all' && name !== 'here' && o.onUserClick?.(name)}>
            @{name}
          </span>,
        );
        // O ponto final da frase fica fora do destaque da menção.
        if (mention.length > name.length + 1) out.push(mention.slice(name.length + 1));
      }
    } else if (channel) {
      const name = channel.slice(1);
      const ch = o.channels?.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (ch)
        out.push(
          <Link key={k} className="mention channel" to={`/channel/${ch._id}`}>
            {channel}
          </Link>,
        );
      else out.push(...hl(channel, o, k));
    } else if (emoji) {
      const e = resolveEmoji(emoji);
      if (e?.unicode) out.push(<span key={k} className="emoji" title={emoji}>{e.unicode}</span>);
      else if (e?.url) out.push(<img key={k} className="emoji custom" src={e.url} alt={emoji} title={emoji} />);
      else out.push(emoji);
    } else out.push(all);
    last = idx + all.length;
  }
  if (last < text.length) out.push(...hl(text.slice(last), o, `${keyBase}-end`));
  return out;
}

// Citação dentro de citação vai até este nível; dali em diante o '>' fica como texto. lines() chama a si mesma a cada
// nível, e uma mensagem com milhares de '>' estourava a pilha e desmontava o app.
const MAX_QUOTE_DEPTH = 10;

function lines(text: string, o: Opts, keyBase: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const ls = text.split('\n');
  let quote: string[] = [];
  let quoted = false;
  const flushQuote = (k: string) => {
    if (!quote.length) return;
    out.push(<blockquote key={k}>{lines(quote.join('\n'), o, k, depth + 1)}</blockquote>);
    quote = [];
    quoted = true;
  };
  ls.forEach((line, i) => {
    const k = `${keyBase}-l${i}`;
    if (depth < MAX_QUOTE_DEPTH && /^>\s?/.test(line)) {
      quote.push(line.replace(/^>\s?/, ''));
      return;
    }
    flushQuote(`${k}q`);
    // A citação já é um bloco: a linha em branco logo depois dela virava um vão a mais antes do texto seguinte.
    const afterQuote = quoted;
    quoted = false;
    if (afterQuote && !line.trim()) return;
    // \s+ seguido de \S (classes disjuntas): sem isso "#" + muitos espaços + "a\u2028" volta atrás de forma quadrática.
    const h = line.match(/^(#{1,4})\s+(\S.*)$/);
    if (h) {
      out.push(<div key={k} className={`md-h md-h${h[1].length}`}>{inline(h[2], o, k)}</div>);
      return;
    }
    const li = line.match(/^\s*[-*•]\s+(\S.*)$/);
    if (li) {
      out.push(<div key={k} className="md-li">• {inline(li[1], o, k)}</div>);
      return;
    }
    out.push(<Fragment key={k}>{inline(line, o, k)}</Fragment>);
    if (i < ls.length - 1) out.push(<br key={`${k}br`} />);
  });
  flushQuote(`${keyBase}-qend`);
  return out;
}

export function renderMarkdown(text: string, o: Opts = {}): ReactNode {
  if (!text) return null;
  const parts = text.split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const lang = nl > 0 && /^[a-z0-9+#-]{1,20}$/i.test(p.slice(0, nl).trim()) ? p.slice(0, nl).trim() : '';
      const body = lang ? p.slice(nl + 1) : p.replace(/^\n/, '');
      return (
        <pre key={i} className="md-pre" data-lang={lang || undefined}>
          <code>{body.replace(/\n$/, '')}</code>
        </pre>
      );
    }
    return <Fragment key={i}>{lines(p, o, `p${i}`)}</Fragment>;
  });
}

// Mensagem só com emojis aparece maior.
export function isEmojiOnly(text: string) {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  return /^((:[a-z0-9_+\-]+:)|\p{Extended_Pictographic}|️|‍|\s)+$/u.test(t);
}
