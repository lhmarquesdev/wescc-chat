// Adaptive Card (1.4) das mensagens e do resumo que o chat manda ao Teams pelo Workflows (§5.3). Puro: sem banco.
import type { MessageJira } from '@shared/integrations';
import { excerpt, plainFromMarkdown } from '../text';

// Id do primeiro TextBlock: "wescc:{regra}:{mensagem}". A leitura do Teams pula cartões com ele (sem eco).
export const WESCC_MARKER = 'wescc:';
export const CARD_MAX_BYTES = 28_000;

export interface CardRoom {
  name: string;
  t: 'c' | 'p';
}

const pad = (n: number) => String(n).padStart(2, '0');

// Hora em que a mensagem foi escrita (hora do servidor): um envio repetido mais tarde mostra a hora certa.
export function hhmm(at: string | Date): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const roomLabel = (room: CardRoom) => (room.t === 'p' ? `Grupo privado ${room.name}` : `#${room.name}`);

const block = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });
const subtle = (text: string, extra: Record<string, unknown> = {}) => block(text, { size: 'Small', isSubtle: true, ...extra });

function envelope(fallbackText: string, body: object[], link: string | null, siteName: string) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          fallbackText,
          body,
          actions: link ? [{ type: 'Action.OpenUrl', title: `Abrir no ${siteName}`, url: link }] : [],
        },
      },
    ],
  };
}

export const cardBytes = (card: object) => Buffer.byteLength(JSON.stringify(card), 'utf8');

// ---------- Markdown do chat → markdown do Adaptive Card ----------

// O TextBlock entende **negrito**, _itálico_, listas "- " e "1. " e [links](https://…). O resto vira texto simples.
export function chatMarkdownToCard(md: string): string {
  const code: string[] = [];
  const keep = (s: string) => `\u0000${code.push(s) - 1}\u0000`;
  let s = String(md ?? '').replace(/\r\n?/g, '\n');
  // Código vira texto simples (e não passa pelas trocas abaixo).
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, body: string) => keep(body.replace(/\n$/, '')));
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => keep(body));
  // Links: só http(s) continuam clicáveis; um caminho do chat fica só com o texto.
  s = s.replace(/\[([^\[\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (/^https?:\/\//i.test(url) ? `[${label}](${url})` : label));
  // Listas com "* " viram "- " antes do negrito de um asterisco.
  s = s.replace(/^(\s*)\* /gm, '$1- ');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*)\*(?!\w)/g, '$1**$2**');
  s = s.replace(/__([^_\n]+)__/g, '_$1_');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  s = s.replace(/(^|[^\w~])~([^~\s][^~\n]*)~(?!\w)/g, '$1$2');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');
}

// ---------- Cartão de uma mensagem ----------

export interface CardInput {
  ruleId: string;
  messageId: string;
  siteName: string;
  room: CardRoom;
  author: { name: string; username: string };
  text: string;
  at: string;
  rootExcerpt?: string | null;
  files: { name: string }[];
  ack: boolean;
  link: string | null;
  jira?: MessageJira | null;
}

function cardBody(p: CardInput, text: string): object[] {
  const body: object[] = [subtle(`${roomLabel(p.room)} · ${p.siteName} · ${hhmm(p.at)}`, { id: `${WESCC_MARKER}${p.ruleId}:${p.messageId}` })];
  body.push(block(p.author.name || p.author.username, { weight: 'Bolder' }));
  if (p.rootExcerpt) body.push(subtle(`Resposta no tópico “${p.rootExcerpt}”`));
  if (text) body.push(block(text));
  const issue = p.jira?.issues?.[0];
  if (issue) body.push(block(`${issue.key}: ${issue.summary}${issue.status?.name ? ` · ${issue.status.name}` : ''}`));
  if (p.files.length) {
    const names = p.files.slice(0, 20).map((f) => f.name);
    const more = p.files.length > 20 ? ` e mais ${p.files.length - 20}` : '';
    body.push(subtle(`Arquivos: ${names.join(', ')}${more}`));
  }
  if (p.ack) body.push(block(`Este aviso pede confirmação de leitura no ${p.siteName}.`));
  return body;
}

// ≤ 28 000 bytes em JSON: um texto maior é cortado e termina com "… (continua no {Site_Name})".
export function buildCard(p: CardInput): object {
  const fallback = `Mensagem de ${p.author.name || p.author.username} em #${p.room.name} no ${p.siteName}`;
  const make = (text: string) => envelope(fallback, cardBody(p, text), p.link, p.siteName);
  const full = chatMarkdownToCard(p.text);
  const card = make(full);
  if (cardBytes(card) <= CARD_MAX_BYTES) return card;
  const chars = Array.from(full);
  const tail = `… (continua no ${p.siteName})`;
  const cut = (n: number) => make(`${chars.slice(0, n).join('').trimEnd()}${tail}`);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cardBytes(cut(mid)) <= CARD_MAX_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

// ---------- Resumo (limite do Power Automate) ----------

export interface DigestInput {
  ruleId: string;
  siteName: string;
  room: CardRoom; // sala da primeira mensagem
  rooms?: CardRoom[]; // todas as salas do resumo, na ordem em que aparecem (uma regra pode ter várias)
  items: { author: string; text: string; room?: CardRoom }[];
  total: number;
  link: string | null;
}

export function digestTitle(total: number, room: CardRoom, siteName: string): string {
  return total === 1 ? `1 mensagem nova em #${room.name} no ${siteName}` : `${total} mensagens novas em #${room.name} no ${siteName}`;
}

// Mais de uma sala: o título diz quantas e cada linha diz de qual veio (nada fica atribuído à sala da primeira).
const roomsTitle = (total: number, n: number, siteName: string) => `${total} ${total === 1 ? 'mensagem nova' : 'mensagens novas'} em ${n} salas no ${siteName}`;
const roomsLine = (rooms: CardRoom[]) => (rooms.length <= 3 ? rooms.map(roomLabel).join(', ') : `${rooms.slice(0, 3).map(roomLabel).join(', ')} e mais ${rooms.length - 3}`);

export function buildDigestCard(p: DigestInput): object {
  const rooms = p.rooms?.length ? p.rooms : [p.room];
  const multi = rooms.length > 1;
  const title = multi ? roomsTitle(p.total, rooms.length, p.siteName) : digestTitle(p.total, p.room, p.siteName);
  const head = multi ? roomsLine(rooms) : roomLabel(p.room);
  const body: object[] = [subtle(`${head} · ${p.siteName}`, { id: `${WESCC_MARKER}${p.ruleId}:resumo` }), block(title, { weight: 'Bolder' })];
  for (const it of p.items.slice(0, 5)) {
    const line = `${it.author}: ${excerpt(plainFromMarkdown(it.text).replace(/\s*\n\s*/g, ' '), 120)}`;
    body.push(block(multi ? `${roomLabel(it.room ?? p.room)} · ${line}` : line));
  }
  return envelope(title, body, p.link, p.siteName);
}
