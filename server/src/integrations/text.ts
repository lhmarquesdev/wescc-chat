import { neutralizeMentions, unwrapSafeLinks } from '@shared/integrations';
import { truncate } from '../lib/text';
import { getSetting } from '../services/settings';

export { neutralizeMentions, unwrapSafeLinks } from '@shared/integrations';

// Texto vindo do Jira ou do Teams antes de entrar numa mensagem do chat. O markdown do chat não tem escape com "\",
// então a sintaxe é quebrada com um caractere invisível (U+200B).
const ZWSP = '​';

const hostOf = (raw: string) => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function trustedLinkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/(^|\.)atlassian\.net$/.test(h) || /(^|\.)jira\.com$/.test(h)) return true;
  if (h === 'teams.microsoft.com' || /(^|\.)sharepoint\.com$/.test(h)) return true;
  const jira = hostOf(String(getSetting('Jira_Site_Url') ?? ''));
  const site = hostOf(String(getSetting('Site_Url') ?? ''));
  return (!!jira && h === jira) || (!!site && h === site);
}

// Endereço como o chat o reconheceria: http(s):// ou www. até um espaço ou "<".
const URL_TOKEN = /(?:https?:\/\/|www\.)[^\s<]+/gi;
const SAFELINK = /^https:\/\/[^/\s]*safelinks\.protection\.outlook\.com\//i;
// O começo de link do chat diferencia maiúsculas: "HTTPS://" não vira link lá, mas um "https://" do meio vira.
const WEB_LINK_START = /^(?:https?:\/\/|www\.)/;
// Onde o chat pode cortar um endereço que começou antes dele: fim de *negrito*, _itálico_, ~tachado~, `código` e ```.
const CUT_CHARS = /[*_~`]/;

// O trecho que decide o host, como o navegador lê: depois de "http(s):" e das barras, até "/", "\", "?" ou "#".
function authorityOf(t: string): string {
  const rest = t.replace(/^https?:[/\\]*/i, '');
  const end = rest.search(/[/\\?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

// Cada "http(s)://" e "www." vira texto (U+200B entre ":" e "//", e dentro de "www").
const defang = (s: string) => s.replace(/(https?:)\/\//gi, `$1${ZWSP}//`).replace(/www\./gi, (m) => `${m[0]}${ZWSP}${m.slice(1)}`);

export function safeExternalText(s: string): string {
  let out = String(s ?? '');
  // 1. Safe Links desembrulhados.
  out = out.replace(URL_TOKEN, (t) => (SAFELINK.test(t) ? unwrapSafeLinks(t) : t));
  // 2. Links markdown viram texto com o endereço à mostra.
  out = out.split('](').join(`]${ZWSP}(`);
  // 3. Links soltos: clicáveis só para hosts conhecidos. O U+200B vai entre ":" e "//" (e dentro de "www"):
  //    o chat aceita U+200B dentro de um endereço, mas não no começo dele. O chat começa um link em qualquer
  //    "http(s)://" ou "www." do meio do texto (depois de um *negrito*, `código` ou :emoji: que começou antes, por
  //    exemplo), então os do meio são quebrados em todo endereço, até no de um host confiável. O do começo fica só
  //    quando o chat o lê igual (minúsculo) e nenhum fim de *, _, ~ ou ` pode cortá-lo antes do fim do host: num
  //    "https://evil.example*@explorer.atlassian.net" o chat abriria evil.example.
  out = out.replace(URL_TOKEN, (t) => {
    const lead = WEB_LINK_START.exec(t)?.[0];
    if (lead && !CUT_CHARS.test(authorityOf(t))) {
      const host = hostOf(lead === 'www.' ? `https://${t}` : t);
      if (host && trustedLinkHost(host)) return lead + defang(t.slice(lead.length));
    }
    return defang(t);
  });
  // 4. Ninguém é mencionado: @all, @here, @nome e #sala ficam como texto.
  return neutralizeMentions(out);
}

// {Site_Url}/{channel|group|direct}/{sala}?msg={id}, o mesmo formato dos e-mails de notificação.
export function messagePermalink(room: { id: string; t: string }, messageId: string): string | null {
  const site = String(getSetting('Site_Url') ?? '').trim().replace(/\/+$/, '');
  if (!site) return null;
  const kind = room.t === 'd' ? 'direct' : room.t === 'p' ? 'group' : room.t === 'l' ? 'live' : 'channel';
  return `${site}/${kind}/${encodeURIComponent(room.id)}?msg=${encodeURIComponent(messageId)}`;
}

export function excerpt(text: string, max: number): string {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const cut = truncate(s, max);
  if (cut.length === s.length) return s;
  return `${truncate(s, Math.max(0, max - 1)).trimEnd()}…`;
}

// Para o Jira e o Teams: tira negrito, itálico, tachado, código e citação do chat, mantém os links.
export function plainFromMarkdown(md: string): string {
  return String(md ?? '')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n$/, ''))
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*)\*(?!\w)/g, '$1$2')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^\w])_([^_\s][^_\n]*)_(?!\w)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/(^|[^\w~])~([^~\s][^~\n]*)~(?!\w)/g, '$1$2')
    .replace(/^>\s?/gm, '')
    .trim();
}
