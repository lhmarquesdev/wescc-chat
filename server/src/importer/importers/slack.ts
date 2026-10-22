import { truncate } from '../../lib/text';
import {
  ImportError,
  ST,
  roomToken,
  userToken,
  type ArchiveEntry,
  type ImportAttachment,
  type ImportChannel,
  type ImportFile,
  type ImportMessage,
  type ImportUser,
  type Importer,
  type PrepareContext,
} from '../types';

// Exportação do Slack (.zip): users.json, channels.json, groups.json, mpims.json e dms.json na raiz, e uma pasta por
// conversa com um .json por dia (general/2023-11-14.json). A pasta é o nome do canal, do grupo ou da MPIM, ou o id da DM.

type Json = Record<string, any>;
type Kind = 'users' | 'channels' | 'groups' | 'mpims' | 'dms';

// Lidos nesta ordem, onde quer que estejam no .zip.
const META = new Map<string, Kind>([
  ['users.json', 'users'],
  ['channels.json', 'channels'],
  ['groups.json', 'groups'],
  ['mpims.json', 'mpims'],
  ['dms.json', 'dms'],
]);
// Limite de participantes das mensagens diretas daqui: MPIMs maiores viram grupos privados.
const MAX_DM_MEMBERS = 9;
// Avisos por mensagem: depois disso só a contagem, para não esconder os avisos do fim da leitura.
const MAX_MESSAGE_WARNINGS = 50;
const SLACKBOT = 'USLACKBOT';
const MAX_MS = 253402300799999; // 9999-12-31
// Cada .json da exportação vem inteiro para um Buffer, mas a lista dele nunca é montada inteira (ver JsonList).
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MiB = 1024 * 1024;
// Mutável só para os testes poderem usar limites pequenos. "Valores" são os objetos, listas e itens do JSON (contados
// pelos {, [, vírgulas e dois-pontos fora dos textos): cada um ocupa até uns 60 bytes de memória depois de lido.
export const SLACK_LIMITS = {
  // Pedaço da lista montado de uma vez: alguns itens inteiros, até uns 256 KB ou 50 mil valores.
  pieceBytes: 256 * 1024,
  pieceValues: 50_000,
  // Um item (mensagem, usuário, conversa) é sempre montado inteiro. O maior item de verdade é um canal com todos os
  // membros do espaço de trabalho: bem abaixo disso.
  itemBytes: 16 * MiB,
  itemValues: 500_000,
  // Nomes e ids guardados durante toda a leitura (ver SlackReader.remember).
  tableBytes: 128 * MiB,
  // Integrações sem usuário (bot_id) diferentes; cada uma vira um usuário bot.
  bots: 5000,
  // Subtipos ignorados contados um a um; os seguintes entram em "outros tipos".
  ignoredKinds: 100,
};
// Bytes conferidos entre uma pausa e outra ao cortar a lista em pedaços.
const SCAN_PAUSE = MiB;
// Itens lidos entre uma pausa e outra para o event loop: um dia com muitas mensagens não trava o servidor.
const YIELD_EVERY = 500;
// Caracteres convertidos (convertMarkup) entre uma pausa e outra: umas dezenas de ms no pior caso.
const WORK_PAUSE = 100_000;
// Dentro de um item só (os membros de um canal, quem reagiu, os arquivos): a vez volta ao event loop depois de PAUSE_MS
// seguidos. Um item de 16 MB pode ter 500 mil valores, e cada um custa alguns microssegundos (480 mil membros num
// canal seguravam a vez por meio segundo).
const PAUSE_MS = 20;
const PAUSE_CHECK = 500;
// O maior texto de mensagem do Slack. O resto é cortado antes da conversão, com aviso: sem o corte, um item de 16 MB
// travava o event loop por segundos e ficava inteiro nos registros gravados (500 deles esgotavam a memória).
export const MAX_TEXT = 40_000;
// Ids e nomes (usuário, canal, bot) cortados na leitura, antes das tabelas, dos marcadores de menção e do jsonb.
const MAX_ID = 200;
const MAX_NAME = 200;
// O maior nome de entrada de um .zip. As pastas das conversas são procuradas pelo nome inteiro, sem o corte de MAX_NAME
// (o de uma MPIM de 9 pessoas passa de 200 caracteres).
const MAX_PATH = 65_535;
// Tópico e descrição: o dobro do que a conversão guarda (a marcação encolhe ao ser convertida).
const MAX_TOPIC = 4000;
// Anexos: os 20 primeiros (a conversão guarda 20), cada campo até o dobro do que a conversão guarda, e todos juntos até
// MAX_TEXT.
const MAX_ATTACHMENTS = 20;
const MAX_FIELDS = 20;
const ATTACHMENT_MAX = { title: 1000, text: 10_000, author: 400, fieldTitle: 400, fieldValue: 4000 };
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

// Subtipos que viram mensagens de sistema; o texto é o campo indicado (o resto do texto do Slack é descartado).
const SYSTEM = new Map<string, { t: string; field?: 'topic' | 'purpose' | 'name' }>([
  ['channel_join', { t: 'uj' }],
  ['group_join', { t: 'uj' }],
  ['channel_leave', { t: 'ul' }],
  ['group_leave', { t: 'ul' }],
  ['channel_topic', { t: 'room_changed_topic', field: 'topic' }],
  ['group_topic', { t: 'room_changed_topic', field: 'topic' }],
  ['channel_purpose', { t: 'room_changed_description', field: 'purpose' }],
  ['group_purpose', { t: 'room_changed_description', field: 'purpose' }],
  ['channel_name', { t: 'r', field: 'name' }],
  ['group_name', { t: 'r', field: 'name' }],
]);
const REGULAR = new Set(['', 'me_message', 'bot_message', 'slackbot_response', 'thread_broadcast', 'reply_broadcast', 'file_share']);
const BOT_SUBTYPES = new Set(['bot_message', 'slackbot_response']);
const BROADCASTS = new Set(['thread_broadcast', 'reply_broadcast']);

// ---------- Auxiliares ----------

const CONTROL_RE = /[\u0000\u0001\u0002]/g;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
// Os marcadores de menção (\u0001 e \u0002) nunca podem vir do próprio texto, e o PostgreSQL recusa U+0000 (num id,
// derrubava a gravação da leitura inteira).
const clean = (v: unknown) => (typeof v === 'string' ? v.replace(CONTROL_RE, '') : '');
const str = (v: unknown) => clean(v).trim();
// Cortado antes de limpar: um campo de 16 MB não é percorrido inteiro.
const cutText = (v: unknown, max: number) => (typeof v === 'string' ? clean(truncate(v, max)).trim() : '');
const sid = (v: unknown) => cutText(v, MAX_ID);
// Nome de pasta: limpo, sem corte; maior que um nome do .zip, não é pasta nenhuma.
const folderKey = (v: unknown) => (typeof v === 'string' && v.length <= MAX_PATH ? str(v) : '');
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const httpUrl = (v: unknown) => {
  // Bem maior que o limite já não é endereço: nem é percorrido.
  if (typeof v !== 'string' || v.length > 16_384) return '';
  const s = str(v);
  return /^https?:\/\//i.test(s) && s.length <= 8192 ? s : '';
};
// Imagens em files.slack.com só abrem com o login do Slack: aqui ficariam quebradas.
const imageUrl = (v: unknown) => {
  const s = httpUrl(v);
  return /^https?:\/\/files\.slack\.com\//i.test(s) ? '' : s;
};

// Id estável da mensagem: reimportar a mesma exportação atualiza em vez de duplicar.
export const slackMessageId = (conversation: string, ts: string) => `slack-${conversation}-${ts.replace(/\./g, '-')}`;

// "1700000000.123456" → ISO com milissegundos. Vazio, inválido ou ≤ 0 → undefined (a conversão usa a hora da importação).
export function slackTs(v: unknown): string | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const ms = Math.round(parseFloat(s) * 1000);
  return ms > 0 && ms <= MAX_MS ? new Date(ms).toISOString() : undefined;
}

// ---------- Marcação do Slack ----------

export interface SlackNames {
  user(id: string): string | undefined; // nome no Slack, para o rótulo da menção
  room(id: string): string | undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>' };
const decode = (s: string) => s.replace(/&(amp|lt|gt);/g, (_m, e: string) => ENTITIES[e]);
// Nomes do Slack (os do emoji-data) para os do conjunto daqui (web/src/lib/emoji.ts), só quando o mesmo desenho tem
// outro nome aqui. Não é a tabela do Rocket.Chat: lá "pencil" é 📝; no Slack, :pencil: é 📝 e :pencil2: é ✏️, e aqui
// :memo: é 📝 e :pencil: é ✏️.
const EMOJI_RENAMES = new Map([
  ['simple_smile', 'slight_smile'],
  ['slightly_smiling_face', 'slight_smile'],
  ['slightly_frowning_face', 'slight_frown'],
  ['upside_down_face', 'upside_down'],
  ['rolling_on_the_floor_laughing', 'rofl'],
  ['satisfied', 'laughing'],
  ['thinking_face', 'thinking'],
  ['nerd_face', 'nerd'],
  ['face_with_rolling_eyes', 'rolling_eyes'],
  ['face_with_cowboy_hat', 'cowboy'],
  ['hugging_face', 'hugging'],
  ['zipper_mouth_face', 'zipper_mouth'],
  ['money_mouth_face', 'money_mouth'],
  ['star-struck', 'star_struck'],
  ['grinning_face_with_star_eyes', 'star_struck'],
  ['face_with_finger_covering_closed_lips', 'shushing_face'],
  ['shocked_face_with_exploding_head', 'exploding_head'],
  ['robot_face', 'robot'],
  ['clown_face', 'clown'],
  ['hankey', 'poop'],
  ['shit', 'poop'],
  ['the_horns', 'metal'],
  ['sign_of_the_horns', 'metal'],
  ['call_me_hand', 'call_me'],
  ['hand_with_index_and_middle_fingers_crossed', 'crossed_fingers'],
  ['facepunch', 'punch'],
  ['first_place_medal', 'first_place'],
  ['sports_medal', 'medal'],
  ['unicorn_face', 'unicorn'],
  ['honeybee', 'bee'],
  ['deciduous_tree', 'tree'],
  ['crescent_moon', 'moon'],
  ['umbrella_with_rain_drops', 'umbrella'],
  ['red_car', 'car'],
  ['heavy_exclamation_mark', 'exclamation'],
  ['open_book', 'book'],
  ['pencil', 'memo'],
  ['pencil2', 'pencil'],
  ['clock1', 'clock'],
  ['email', 'envelope'],
  ['e-mail', 'email'],
  ['phone', 'telephone'],
  ['telephone_receiver', 'phone'],
  ['large_blue_circle', 'blue_circle'],
  ['large_green_circle', 'green_circle'],
  ['large_yellow_circle', 'yellow_circle'],
  ['flag-br', 'flag_br'],
]);

const withoutSkinTone = (raw: string) => raw.replace(/::skin-tone-\d+$/, '');

// Nome de emoji do texto: sem o tom de pele (não existe aqui) e com o nome daqui.
export function emojiName(raw: string) {
  const n = withoutSkinTone(raw);
  return EMOJI_RENAMES.get(n) ?? n;
}

function plainText(s: string) {
  return decode(s)
    .replace(/::skin-tone-\d+:/g, ':')
    .replace(/:([a-z0-9_+-]+):/g, (m, n: string) => {
      const to = EMOJI_RENAMES.get(n);
      return to ? `:${to}:` : m;
    });
}

function markdownLink(label: string, url: string) {
  // O link do markdown daqui não aceita "]" no texto nem ")" ou espaço no endereço.
  const text = label.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
  const href = url.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'));
  return text && text !== url ? `[${text}](${href})` : href;
}

// Como cada <...> vira texto:
// - markdown: texto das mensagens e dos anexos mostrados com markdown (links em markdown, menções como marcadores);
// - text: campos dos anexos que a tela mostra como texto simples (título, autor, rodapé, título dos campos): links
//   viram "rótulo (endereço)", menções continuam marcadores (a conversão troca pelo nome final);
// - plain: tópico e descrição das salas, que a conversão não toca: menções viram só "@nome" e "#sala".
export type MarkupMode = 'markdown' | 'text' | 'plain';

function convertToken(inner: string, names: SlackNames, mode: MarkupMode): string {
  const bar = inner.indexOf('|');
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? '' : decode(inner.slice(bar + 1)).trim();
  const head = target.charAt(0);
  if (head === '@' || head === '#') {
    const id = sid(target.slice(1));
    const name = label.replace(/^[@#]/, '') || (id ? (head === '@' ? names.user(id) : names.room(id)) : undefined);
    if (!id) return name ? `${head}${name}` : '';
    if (mode === 'plain') return `${head}${name || id}`;
    return head === '@' ? userToken(id, name) : roomToken(id, name);
  }
  if (head === '!') {
    const [cmd, arg] = target.slice(1).split('^');
    switch (cmd.toLowerCase()) {
      case 'here':
        return '@here';
      case 'channel':
      case 'everyone':
        return '@all';
      case 'subteam':
        return label ? (label.startsWith('@') ? label : `@${label}`) : `@${arg ?? 'grupo'}`;
      case 'date':
        return label;
      default:
        return label || decode(target);
    }
  }
  const url = decode(target).trim();
  if (/^https?:\/\//i.test(url)) {
    if (!label || label === url) return url;
    return mode === 'markdown' ? markdownLink(label, url) : `${label} (${url})`;
  }
  if (/^mailto:/i.test(url)) {
    const address = url.slice(7);
    return label && label !== address ? `${label} (${address})` : address;
  }
  return label || url;
}

// Texto do Slack para o daqui. Cada <...> é tratado sozinho (nunca uma regra pegando dois), e as entidades &amp; &lt;
// &gt; são decodificadas depois, só no texto comum: "&lt;@U1&gt;" digitado continua texto, não vira menção.
// Usuários e salas viram marcadores, trocados pelo nome final na conversão (menos no modo plain, ver MarkupMode).
// Só os primeiros `max` caracteres: a conversão é linear, mas síncrona (16 MB travavam o servidor por 8 s).
export function convertMarkup(raw: unknown, names: SlackNames, mode: MarkupMode = 'markdown', max = MAX_TEXT): string {
  const s = clean(typeof raw === 'string' && raw.length > max ? truncate(raw, max) : raw).replace(/\r\n?/g, '\n');
  if (!s) return '';
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/<([^<>]*)>/g)) {
    out += plainText(s.slice(last, m.index));
    out += convertToken(m[1], names, mode);
    last = m.index + m[0].length;
  }
  return out + plainText(s.slice(last));
}

// Quanto texto do arquivo ainda pode ser convertido (numa mensagem, nos anexos dela...). Corta antes da conversão e
// lembra quando o corte foi pelo total, não pelo limite do campo (só esse perde o que a conversão guardaria).
class TextBudget {
  cut = false;
  used = 0;
  constructor(private left: number) {}

  get done() {
    return this.left <= 0;
  }

  // Um pedaço que não é texto do arquivo (menção, emoji): entra inteiro ou não entra, e aí o resto é cortado.
  spend(n: number): boolean {
    if (n > this.left) {
      this.left = 0;
      this.cut = true;
      return false;
    }
    this.left -= n;
    this.used += n;
    return true;
  }

  take(v: unknown, max = Infinity): string {
    if (typeof v !== 'string') return '';
    const n = Math.max(0, Math.min(max, this.left));
    let s = v;
    if (s.length > n) {
      s = truncate(s, n);
      if (s.length < v.length && n < max) this.cut = true;
    }
    this.left = Math.max(0, this.left - s.length);
    this.used += s.length;
    return s;
  }
}

// ---------- Blocos (rich_text) ----------

function styled(text: string, style: unknown) {
  if (!isObj(style) || text.includes('\n')) return text;
  const inner = text.trim();
  if (!inner) return text;
  // Sem regex: /^(\s*)([\s\S]*?)(\s*)$/ é quadrática num texto com muitos espaços no meio.
  const start = text.length - text.trimStart().length;
  const before = text.slice(0, start);
  const after = text.slice(start + inner.length);
  if (style.code) return `${before}\`${inner}\`${after}`;
  let s = inner;
  if (style.strike) s = `~${s}~`;
  if (style.italic) s = `_${s}_`;
  if (style.bold) s = `*${s}*`;
  return before + s + after;
}

// Os laços dos blocos param quando o limite do texto acaba: um bloco com 500 mil elementos não é percorrido inteiro.
const exhausted = (budget: TextBudget) => {
  if (budget.done) budget.cut = true;
  return budget.done;
};

function richInline(elements: unknown, names: SlackNames, budget: TextBudget, withStyle = true): string {
  if (!Array.isArray(elements)) return '';
  let s = '';
  for (const e of elements) {
    if (exhausted(budget)) break;
    if (!isObj(e)) continue;
    switch (e.type) {
      case 'text': {
        const text = clean(budget.take(e.text));
        s += withStyle ? styled(text, e.style) : text;
        break;
      }
      case 'link': {
        const url = httpUrl(e.url);
        const text = str(budget.take(e.text));
        s += url ? (text && withStyle ? markdownLink(text, url) : url) : text;
        break;
      }
      // Contam no limite como no texto do Slack: <@U1>, <#C1>, :nome:, <!here>.
      case 'user': {
        const id = sid(e.user_id);
        if (id && budget.spend(id.length + 3)) s += userToken(id, names.user(id));
        break;
      }
      case 'channel': {
        const id = sid(e.channel_id);
        if (id && budget.spend(id.length + 3)) s += roomToken(id, names.room(id));
        break;
      }
      case 'emoji': {
        const name = cutText(e.name, 100);
        if (name && budget.spend(name.length + 2)) s += `:${emojiName(name)}:`;
        break;
      }
      case 'broadcast':
        if (budget.spend(7)) s += e.range === 'here' ? '@here' : '@all';
        break;
      case 'date':
        s += str(budget.take(e.fallback));
        break;
      case 'color':
        s += budget.take(cutText(e.value, 30));
        break;
    }
  }
  return s;
}

// Sem /\n+$/: sem âncora no começo, a regex percorre de novo cada sequência de quebras de linha (quadrática).
function trimEnd(s: string) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  return end === s.length ? s : s.slice(0, end);
}

function richText(elements: unknown, names: SlackNames, budget: TextBudget): string {
  if (!Array.isArray(elements)) return '';
  const out: string[] = [];
  for (const el of elements) {
    if (exhausted(budget)) break;
    if (!isObj(el)) continue;
    if (el.type === 'rich_text_section') out.push(richInline(el.elements, names, budget));
    else if (el.type === 'rich_text_quote') out.push(trimEnd(richInline(el.elements, names, budget)).split('\n').map((l) => `> ${l}`).join('\n'));
    else if (el.type === 'rich_text_preformatted') out.push(`\`\`\`\n${trimEnd(richInline(el.elements, names, budget, false))}\n\`\`\``);
    else if (el.type === 'rich_text_list' && Array.isArray(el.elements)) {
      const indent = '  '.repeat(Math.max(0, Math.min(8, Number(el.indent) || 0)));
      const offset = Math.max(0, Number(el.offset) || 0);
      const items: string[] = [];
      for (const it of el.elements) {
        if (exhausted(budget)) break;
        if (isObj(it)) items.push(`${indent}${el.style === 'ordered' ? `${offset + items.length + 1}.` : '-'} ${trimEnd(richInline(it.elements, names, budget))}`);
      }
      out.push(items.join('\n'));
    }
  }
  return out.map(trimEnd).join('\n');
}

const textObject = (t: unknown, names: SlackNames, budget: TextBudget) => (!isObj(t) ? '' : t.type === 'mrkdwn' ? convertMarkup(budget.take(t.text), names) : clean(budget.take(t.text)));

// Texto das mensagens que só têm blocos (o campo text vazio), até MAX_TEXT caracteres do arquivo.
export function blocksText(blocks: unknown, names: SlackNames, budget = new TextBudget(MAX_TEXT)): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  const texts = (list: unknown[]) => {
    const out: string[] = [];
    for (const t of list) {
      if (exhausted(budget)) break;
      const text = textObject(t, names, budget);
      if (text) out.push(text);
    }
    return out;
  };
  for (const b of blocks) {
    if (exhausted(budget)) break;
    if (!isObj(b)) continue;
    if (b.type === 'rich_text') parts.push(richText(b.elements, names, budget));
    else if (b.type === 'section' || b.type === 'header') parts.push(texts([b.text, ...(Array.isArray(b.fields) ? b.fields : [])]).join('\n'));
    else if (b.type === 'context' && Array.isArray(b.elements)) parts.push(texts(b.elements).join(' '));
  }
  return parts.map(trimEnd).filter(Boolean).join('\n');
}

// ---------- Arquivos ----------

// Arquivo de uma mensagem, baixado depois (o endereço já leva o token de acesso do Slack na query).
export function slackFile(f: unknown): ImportFile | null {
  if (!isObj(f) || !sid(f.id)) return null;
  const file: ImportFile = { id: sid(f.id), name: cutText(f.name, 255) || cutText(f.title, 255) || 'arquivo' };
  if (typeof f.size === 'number' && Number.isFinite(f.size) && f.size >= 0) file.size = f.size;
  const type = cutText(f.mimetype, 200);
  if (type) file.type = type;
  // Removido no Slack ou escondido pelo limite do plano gratuito: não há o que baixar.
  const gone = f.mode === 'tombstone' || f.mode === 'hidden_by_limit' || f.hidden_by_limit === true;
  const url = httpUrl(f.url_private_download) || httpUrl(f.url_private);
  if (url && !gone) file.url = url;
  file.external = f.is_external === true || f.mode === 'external';
  return file;
}

// ---------- Leitura ----------

function normalizeColor(v: unknown) {
  const s = cutText(v, 30);
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s) ? `#${s}` : s;
}

class SlackReader implements SlackNames {
  private handles = new Map<string, string>(); // usuário → nome no Slack
  private roomNames = new Map<string, string>(); // conversa → nome
  private wanted = new Set<string>(); // pastas dos dias (e em minúsculas): só elas entram em folders
  private folders = new Map<string, string>(); // pasta → conversa
  private kinds = new Map<string, ImportChannel['t']>();
  private botAuthors = new Map<string, string>(); // bot_id → autor
  private bots = 0;
  private tableBytes = 0;
  private pendingUsers: ImportUser[] = [];
  private ignored = new Map<string, number>(); // subtipos não importados → quantidade
  private empty = 0;
  private problems = 0;
  private cuts = 0; // mensagens cortadas (MAX_TEXT)
  private work = 0; // caracteres convertidos desde a última pausa
  private labels = 0; // caracteres de rótulos de menção que a mensagem atual ainda pode receber
  private lastPause = performance.now();

  constructor(private ctx: PrepareContext) {}

  // Ver PAUSE_MS. Chamada a cada PAUSE_CHECK valores dos laços longos de um item.
  private async pause() {
    if (performance.now() - this.lastPause < PAUSE_MS) return;
    await breathe();
    this.lastPause = performance.now();
  }

  // Ids de uma lista do arquivo (membros, quem reagiu), sem repetir, com pausas.
  private async idList(v: unknown, into = new Set<string>()): Promise<Set<string>> {
    if (!Array.isArray(v)) return into;
    for (let i = 0; i < v.length; i++) {
      if (i % PAUSE_CHECK === 0) await this.pause();
      const id = sid(v[i]);
      if (id) into.add(id);
    }
    return into;
  }

  // Rótulo de uma menção sem rótulo no texto: o nome no Slack, enquanto couber no limite da mensagem. Sem o limite,
  // milhares de "<@U1>" (5 caracteres cada) com um nome de 200 viravam um texto 40 vezes maior. Sem rótulo, a conversão
  // usa o nome final, ou o id quando a pessoa não é importada.
  private label(name: string | undefined) {
    if (!name || name.length > this.labels) return undefined;
    this.labels -= name.length;
    return name;
  }

  user(id: string) {
    return this.label(this.handles.get(id));
  }

  room(id: string) {
    return this.label(this.roomNames.get(id));
  }

  // Tabelas que ficam na memória a leitura toda, com limite: um users.json ou channels.json de 64 MB com milhões de
  // itens pequenos (ou ids e nomes enormes) ainda esgotaria a memória. A conta é uma estimativa por entrada nova: 64
  // bytes do Map e dos cabeçalhos e 2 bytes por caractere. Uma exportação grande de verdade fica bem abaixo.
  private remember<V extends string>(map: Map<string, V>, key: string, value: V) {
    if (!map.has(key)) {
      this.tableBytes += 64 + 2 * (key.length + value.length);
      if (this.tableBytes > SLACK_LIMITS.tableBytes) {
        throw new ImportError(`Não foi possível ler a exportação: ela tem usuários e conversas demais para ler de uma vez (os nomes e ids guardados durante a leitura passariam de ${Math.round(SLACK_LIMITS.tableBytes / MiB)} MB).`);
      }
    }
    map.set(key, value);
  }

  private folder(key: string, id: string, replace = false) {
    if (this.wanted.has(key) && (replace || !this.folders.has(key))) this.folders.set(key, id);
  }

  async prepare() {
    const ctx = this.ctx;
    const all = (await ctx.source.list()).filter((e) => !e.isDirectory && !isJunk(e.name));
    const prefix = wrapperPrefix(all.map((e) => e.name));
    const entries = all.filter((e) => e.name.startsWith(prefix)).map((e) => ({ entry: e, name: e.name.slice(prefix.length) }));
    if (entries.length < all.length) ctx.warn(`${plural(all.length - entries.length, 'arquivo fora da pasta', 'arquivos fora da pasta')} "${prefix.slice(0, -1)}" da exportação ${all.length - entries.length === 1 ? 'foi ignorado' : 'foram ignorados'}.`);
    const meta = new Map(entries.filter((e) => META.has(e.name)).map((e) => [e.name, e.entry]));
    if (!meta.size) {
      throw new ImportError('Este .zip não parece uma exportação do Slack: não há users.json nem channels.json (nem groups.json, mpims.json ou dms.json) na raiz.');
    }
    const days = entries.filter((e) => e.name.includes('/') && /\.json$/i.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const others = entries.filter((e) => e.name.includes('/') && !/\.json$/i.test(e.name)).length;
    for (const { name } of days) {
      const folder = name.slice(0, name.indexOf('/'));
      this.wanted.add(folder);
      this.wanted.add(folder.toLowerCase());
    }

    const units = meta.size + days.length;
    let done = 0;
    const step = () => ctx.progress((++done * 100) / units);
    ctx.progress(0);

    await ctx.setStep(ST.preparingUsers);
    const users = meta.get('users.json');
    if (users) {
      await this.readUsers(readList(ctx, users, 'users.json'));
      step();
    }
    await this.ensureSlackbot();
    if (ctx.cancelled()) return;

    await ctx.setStep(ST.preparingChannels);
    const conversations = [...META.keys()].slice(1).filter((file) => meta.has(file));
    // Todos os nomes antes, para um tópico citar um canal que aparece depois. Cada arquivo é lido duas vezes: nunca
    // mais de um pedaço de lista fica montado na memória (as quatro listas inteiras juntas esgotavam a memória).
    for (const file of conversations) {
      for await (const piece of readList(ctx, meta.get(file)!, file)) {
        for (const c of piece) {
          if (!isObj(c)) continue;
          const id = sid(c.id);
          const name = cutText(c.name, MAX_NAME);
          if (id && name && !this.roomNames.has(id)) this.remember(this.roomNames, id, name);
        }
      }
      if (ctx.cancelled()) return;
    }
    for (const file of conversations) {
      await this.readConversations(file, META.get(file)!, readList(ctx, meta.get(file)!, file));
      step();
      if (ctx.cancelled()) return;
    }

    await ctx.setStep(ST.preparingMessages);
    const unresolved = new Set<string>();
    for (const { entry, name } of days) {
      if (ctx.cancelled()) return;
      const slash = name.indexOf('/');
      const folder = name.slice(0, slash);
      const label = `${folder}/${name.slice(slash + 1).replace(/\.json$/i, '')}`;
      const rid = this.folders.get(folder) ?? this.folders.get(folder.toLowerCase());
      if (!rid) {
        if (!unresolved.has(folder)) {
          unresolved.add(folder);
          ctx.warn(`A pasta "${folder}" não corresponde a nenhum canal, grupo ou conversa da exportação; as mensagens dela foram ignoradas.`);
        }
      } else {
        await this.readDay(entry, name, label, rid);
      }
      step();
    }

    if (this.problems > MAX_MESSAGE_WARNINGS) ctx.warn(`E mais ${plural(this.problems - MAX_MESSAGE_WARNINGS, 'mensagem ignorada', 'mensagens ignoradas')} por problemas no formato.`);
    if (this.cuts > MAX_MESSAGE_WARNINGS) {
      ctx.warn(`E mais ${plural(this.cuts - MAX_MESSAGE_WARNINGS, 'mensagem cortada', 'mensagens cortadas')} por passar de ${thousands(MAX_TEXT)} caracteres.`);
    }
    if (this.ignored.size) {
      const list = [...this.ignored].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`);
      const more = list.length > 15 ? ` e mais ${list.length - 15} tipos` : '';
      ctx.warn(`Mensagens de tipos que não são importados foram ignoradas: ${list.slice(0, 15).join(', ')}${more}.`);
    }
    if (this.empty) ctx.warn(`${plural(this.empty, 'mensagem sem texto nem arquivos foi ignorada', 'mensagens sem texto nem arquivos foram ignoradas')}.`);
    if (others) ctx.warn(`${plural(others, 'arquivo que não é .json foi ignorado', 'arquivos que não são .json foram ignorados')} dentro das pastas das conversas.`);
    await ctx.setMessagesStatus(null);
    ctx.progress(100);
  }

  // ---------- users.json ----------

  private async readUsers(pieces: AsyncIterable<unknown[]>) {
    let invalid = 0;
    let repeated = 0;
    let unnamed = 0;
    let n = 0;
    for await (const piece of pieces) for (const u of piece) {
      if (++n % YIELD_EVERY === 0) await breathe();
      if (this.ctx.cancelled()) return;
      if (!isObj(u) || !sid(u.id)) {
        invalid++;
        continue;
      }
      const id = sid(u.id);
      if (this.handles.has(id)) {
        repeated++;
        continue;
      }
      const p: Json = isObj(u.profile) ? u.profile : {};
      const username = cutText(u.name, MAX_NAME) || cutText(p.display_name_normalized, MAX_NAME) || cutText(p.display_name, MAX_NAME);
      // Mais de 254 caracteres não é e-mail (e cortar poderia formar o de outra pessoa): fica sem.
      const rawEmail = cutText(p.email, 300);
      const email = rawEmail.length <= 254 ? rawEmail : '';
      if (!username && !email) {
        unnamed++;
        continue;
      }
      const rec: ImportUser = { importIds: [id], emails: email ? [email] : [] };
      if (username) rec.username = username;
      const name = cutText(p.real_name, MAX_NAME) || cutText(u.real_name, MAX_NAME) || cutText(p.display_name, MAX_NAME);
      if (name) rec.name = name;
      if (u.is_bot === true || u.is_app_user === true || id === SLACKBOT) rec.type = 'bot';
      if (u.deleted === true) rec.deleted = true;
      const statusText = cutText(p.status_text, 200);
      if (statusText) rec.statusText = statusText;
      const bio = cutText(p.title, 2000);
      if (bio) rec.bio = bio;
      // Donos do espaço de trabalho também são os administradores dele.
      if (u.is_admin === true || u.is_owner === true || u.is_primary_owner === true) rec.roles = ['admin'];
      // Sem foto escolhida, o Slack manda a padrão dele; aqui as iniciais já fazem esse papel.
      const avatar = p.is_custom_image === false ? '' : httpUrl(p.image_original) || httpUrl(p.image_512);
      if (avatar) rec.avatarUrl = avatar;
      // Mensagens de bot só com bot_id são atribuídas ao usuário do bot.
      if (sid(p.bot_id)) this.remember(this.botAuthors, sid(p.bot_id), id);
      this.remember(this.handles, id, username || name || id);
      await this.ctx.user(rec);
    }
    if (invalid) this.ctx.warn(`"users.json": ${plural(invalid, 'usuário sem id foi ignorado', 'usuários sem id foram ignorados')}.`);
    if (unnamed) this.ctx.warn(`"users.json": ${plural(unnamed, 'usuário sem nome de usuário e sem e-mail foi ignorado', 'usuários sem nome de usuário e sem e-mail foram ignorados')}.`);
    if (repeated) this.ctx.warn(`"users.json": ${plural(repeated, 'usuário repetido foi ignorado', 'usuários repetidos foram ignorados')} (vale o primeiro).`);
  }

  // O Slackbot é autor de lembretes e respostas automáticas, e nem sempre está em users.json.
  private async ensureSlackbot() {
    if (this.handles.has(SLACKBOT)) return;
    this.remember(this.handles, SLACKBOT, 'slackbot');
    await this.ctx.user({ importIds: [SLACKBOT], username: 'slackbot', name: 'Slackbot', type: 'bot', emails: [] });
  }

  // ---------- channels.json, groups.json, mpims.json, dms.json ----------

  private async readConversations(file: string, kind: Kind, pieces: AsyncIterable<unknown[]>) {
    let invalid = 0;
    let repeated = 0;
    let unnamed = 0;
    let noMembers = 0;
    let n = 0;
    for await (const piece of pieces) for (const c of piece) {
      if (++n % YIELD_EVERY === 0 || this.work >= WORK_PAUSE) {
        this.work = 0;
        await breathe();
      }
      if (this.ctx.cancelled()) return;
      if (!isObj(c) || !sid(c.id)) {
        invalid++;
        continue;
      }
      const id = sid(c.id);
      if (this.kinds.has(id)) {
        repeated++;
        continue;
      }
      const users = [...(await this.idList(c.members))];
      const t: ImportChannel['t'] = kind === 'channels' ? 'c' : kind === 'groups' ? 'p' : kind === 'dms' || users.length <= MAX_DM_MEMBERS ? 'd' : 'p';
      const rec: ImportChannel = { importIds: [id], t, users };
      const name = cutText(c.name, MAX_NAME);
      if (t === 'd') {
        if (!users.length) {
          noMembers++;
          continue;
        }
      } else {
        if (!name) unnamed++;
        rec.name = name || id;
        if (sid(c.creator)) rec.creator = sid(c.creator);
        const topic = this.plain(isObj(c.topic) ? c.topic.value : undefined);
        const purpose = this.plain(isObj(c.purpose) ? c.purpose.value : undefined);
        if (topic) rec.topic = topic;
        if (purpose) rec.description = purpose;
        if (c.is_archived === true) rec.archived = true;
        if (kind === 'channels' && c.is_general === true) rec.isDefault = true;
      }
      const created = typeof c.created === 'number' || typeof c.created === 'string' ? slackTs(Number(c.created)) : undefined;
      if (created) rec.ts = created;
      this.remember(this.kinds, id, t);
      this.folder(folderKey(c.id) || id, id, true);
      const folder = folderKey(c.name);
      if (folder) {
        this.folder(folder, id);
        this.folder(folder.toLowerCase(), id);
      }
      await this.ctx.channel(rec);
    }
    if (invalid) this.ctx.warn(`"${file}": ${plural(invalid, 'conversa sem id foi ignorada', 'conversas sem id foram ignoradas')}.`);
    if (unnamed) this.ctx.warn(`"${file}": ${plural(unnamed, 'canal sem nome recebeu', 'canais sem nome receberam')} o id do Slack como nome.`);
    if (noMembers) this.ctx.warn(`"${file}": ${plural(noMembers, 'conversa sem membros foi ignorada', 'conversas sem membros foram ignoradas')}.`);
    if (repeated) this.ctx.warn(`"${file}": ${plural(repeated, 'conversa repetida foi ignorada', 'conversas repetidas foram ignoradas')} (vale a primeira).`);
  }

  // Tópico e descrição das salas, até MAX_TOPIC caracteres do arquivo.
  private plain(v: unknown) {
    this.work += typeof v === 'string' ? Math.min(v.length, MAX_TOPIC) : 0;
    this.labels = MAX_TOPIC;
    return convertMarkup(v, this, 'plain', MAX_TOPIC).trim();
  }

  // ---------- Mensagens ----------

  private async readDay(entry: ArchiveEntry, name: string, label: string, rid: string) {
    const ctx = this.ctx;
    let list: JsonList;
    try {
      // Conferido inteiro antes: um dia com defeito é ignorado todo, sem deixar metade das mensagens.
      list = await JsonList.open(ctx, entry, true);
    } catch (e) {
      if (e instanceof JsonError) ctx.warn(e.problem === 'not-list' ? `"${name}" não tem uma lista de mensagens e foi ignorado.` : `${jsonProblem(name, e)} e foi ignorado.`);
      else if (e instanceof ImportError) ctx.warn(`${e.message} O arquivo foi ignorado.`);
      else throw e;
      return;
    }
    await ctx.setMessagesStatus(label);
    await breathe();
    let n = 0;
    for await (const piece of list.pieces()) for (const m of piece) {
      if (++n % YIELD_EVERY === 0 || this.work >= WORK_PAUSE) {
        this.work = 0;
        await breathe();
      }
      if (ctx.cancelled()) return;
      let rec: ImportMessage | string | null;
      const cut: string[] = [];
      try {
        rec = await this.message(m, rid, cut);
      } catch (e) {
        // O limite das tabelas (remember) para a leitura toda, não só esta mensagem.
        if (e instanceof ImportError) throw e;
        rec = 'formato inesperado';
      }
      const ts = () => (isObj(m) && (typeof m.ts === 'string' || typeof m.ts === 'number') ? ` (ts ${truncate(String(m.ts), 40)})` : '');
      if (typeof rec === 'string') {
        if (++this.problems <= MAX_MESSAGE_WARNINGS) ctx.warn(`Mensagem ignorada em "${label}"${ts()}: ${rec}.`);
        rec = null;
      } else if (rec && cut.length && ++this.cuts <= MAX_MESSAGE_WARNINGS) {
        const what = cut.join(' e ');
        ctx.warn(`Mensagem cortada em "${label}"${ts()}: ${what} ${cut.length > 1 || what.startsWith('os ') ? 'passavam' : 'passava'} de ${thousands(MAX_TEXT)} caracteres, e o resto foi descartado.`);
      }
      // O bot já ficou conhecido (outras mensagens dele usam o mesmo id), mesmo que esta mensagem tenha falhado.
      if (this.pendingUsers.length) for (const u of this.pendingUsers.splice(0)) await ctx.user(u);
      if (rec) await ctx.message(rec);
    }
  }

  private skip(subtype: string) {
    // Os avisos vão para jsonb: nunca com metade de um emoji (o PostgreSQL recusaria e a leitura falharia).
    let key = truncate(subtype, 40);
    // Milhões de subtipos diferentes não viram milhões de contadores na memória.
    if (!this.ignored.has(key) && this.ignored.size >= SLACK_LIMITS.ignoredKinds) key = 'outros tipos';
    this.ignored.set(key, (this.ignored.get(key) ?? 0) + 1);
  }

  // Uma mensagem do Slack; null quando ela não é importada (tipo ignorado, vazia) e o motivo quando tem defeito.
  // O motivo volta como texto, sem exceção: um dia pode ter milhões de itens com defeito, e cada exceção custa caro.
  // `cut` recebe o que foi cortado por passar de MAX_TEXT ("o texto", "os anexos"), para o aviso.
  private async message(m: unknown, rid: string, cut: string[]): Promise<ImportMessage | string | null> {
    if (!isObj(m)) return 'não é um objeto';
    if (m.type !== undefined && m.type !== 'message') return null;
    const ts = typeof m.ts === 'number' ? String(m.ts) : sid(m.ts);
    if (!ts) return 'sem "ts"';
    const subtype = cutText(m.subtype, 100);
    if (subtype === 'tombstone') return null;

    const rec: ImportMessage = { importId: slackMessageId(rid, ts), rid, u: '', msg: '' };
    const at = slackTs(ts);
    if (at) rec.ts = at;
    this.labels = MAX_TEXT;
    // O texto e os blocos (usados quando o texto fica vazio) têm MAX_TEXT cada um; os anexos, juntos, outro tanto.
    const textBudget = new TextBudget(MAX_TEXT);
    const blocksBudget = new TextBudget(MAX_TEXT);
    const attachmentsBudget = new TextBudget(MAX_TEXT);
    const done = (r: ImportMessage) => {
      this.work += textBudget.used + blocksBudget.used + attachmentsBudget.used;
      if (textBudget.cut || blocksBudget.cut) cut.push('o texto');
      if (attachmentsBudget.cut) cut.push('os anexos');
      return r;
    };

    const sys = SYSTEM.get(subtype);
    if (sys) {
      rec.u = sid(m.user);
      if (!rec.u) return `"${subtype}" sem usuário`;
      rec.t = sys.t;
      if (sys.field) rec.msg = sys.field === 'name' ? cutText(m.name, MAX_NAME) : convertMarkup(textBudget.take(m[sys.field]), this).trim();
      await this.reactions(m, rec);
      return done(rec);
    }
    if (!REGULAR.has(subtype)) {
      this.skip(subtype);
      return null;
    }

    const bot = BOT_SUBTYPES.has(subtype);
    const alias = cutText(m.username, MAX_NAME);
    rec.u = sid(m.user);
    if (rec.u) {
      if (bot && alias && alias !== this.handles.get(rec.u)) rec.alias = alias;
    } else {
      const author = this.botAuthor(m);
      if (!author) return `a exportação tem mais de ${SLACK_LIMITS.bots} integrações (bot_id) diferentes`;
      rec.u = author;
      if (alias) rec.alias = alias;
    }
    if (bot || !sid(m.user)) rec.bot = true;

    let text = convertMarkup(textBudget.take(m.text), this);
    if (!text.trim()) text = blocksText(m.blocks, this, blocksBudget);
    if (subtype === 'me_message' && text.trim()) text = `_${text.trim()}_`;
    rec.msg = text;

    const threadTs = typeof m.thread_ts === 'number' ? String(m.thread_ts) : sid(m.thread_ts);
    if (threadTs && threadTs !== ts) {
      rec.tmid = slackMessageId(rid, threadTs);
      if (BROADCASTS.has(subtype)) rec.tshow = true;
    }
    if (isObj(m.edited)) {
      const editedAt = slackTs(m.edited.ts);
      if (editedAt) {
        rec.editedAt = editedAt;
        if (sid(m.edited.user)) rec.editedBy = sid(m.edited.user);
      }
    }
    await this.reactions(m, rec);
    if (Array.isArray(m.pinned_to) && m.pinned_to.includes(rid)) rec.pinned = true;
    const attachments = this.attachments(m.attachments, attachmentsBudget);
    if (attachments.length) rec.attachments = attachments;
    const emoji = isObj(m.icons) ? cutText(m.icons.emoji, 100) : '';
    if (emoji) rec.emoji = emoji;

    const files = new Map<string, ImportFile>();
    const list: unknown[] = Array.isArray(m.files) ? m.files : [];
    for (let i = 0; i <= list.length; i++) {
      if (i % PAUSE_CHECK === 0) await this.pause();
      const file = slackFile(i < list.length ? list[i] : m.file);
      if (file && !files.has(file.id)) files.set(file.id, file);
    }
    if (files.size) rec.files = [...files.values()];

    // Sem texto, anexos nem arquivos não há o que mostrar; a raiz de uma thread fica, para as respostas.
    if (!rec.msg.trim() && !rec.attachments && !rec.files && threadTs !== ts) {
      this.work += textBudget.used + blocksBudget.used + attachmentsBudget.used;
      this.empty++;
      return null;
    }
    return done(rec);
  }

  // Bot sem usuário (integrações, webhooks): um usuário bot por bot_id; sem bot_id, o Slackbot. Null passado o limite
  // de integrações: uma exportação de verdade tem dezenas, e cada uma fica na memória e vira um usuário.
  private botAuthor(m: Json): string | null {
    const botId = sid(m.bot_id);
    if (!botId) return SLACKBOT;
    const known = this.botAuthors.get(botId);
    if (known) return known;
    if (this.bots >= SLACK_LIMITS.bots) return null;
    this.bots++;
    const profile: Json = isObj(m.bot_profile) ? m.bot_profile : {};
    const username = cutText(profile.name, MAX_NAME) || cutText(m.username, MAX_NAME) || 'bot';
    const id = `slack-bot:${botId}`;
    // Sem bot_profile.deleted: uma integração removida no Slack não é conta para desativar, e o nome dela (jira,
    // github...) pode ser o de uma conta daqui.
    const rec: ImportUser = { importIds: [id], username, name: username, type: 'bot', emails: [] };
    const icons: Json = isObj(profile.icons) ? profile.icons : {};
    const avatar = httpUrl(icons.image_72) || httpUrl(icons.image_48) || httpUrl(icons.image_36);
    if (avatar) rec.avatarUrl = avatar;
    this.remember(this.botAuthors, botId, id);
    this.remember(this.handles, id, username);
    this.pendingUsers.push(rec);
    return id;
  }

  private async reactions(m: Json, rec: ImportMessage) {
    if (!Array.isArray(m.reactions)) return;
    const out = new Map<string, Set<string>>();
    for (let i = 0; i < m.reactions.length; i++) {
      if (i % PAUSE_CHECK === 0) await this.pause();
      const r = m.reactions[i];
      if (!isObj(r)) continue;
      // Só sai o tom de pele: a troca de nomes do texto não vale para as reações (slack.md §6.5). O nome vira chave
      // do jsonb: sem U+0000 nem metade de emoji (cut), que derrubavam a gravação da leitura inteira.
      const name = withoutSkinTone(cutText(r.name, 100));
      if (!name) continue;
      // +1 e +1::skin-tone-2 são a mesma reação aqui.
      const key = `:${name}:`;
      const set = await this.idList(r.users, out.get(key));
      if (set.size) out.set(key, set);
    }
    if (out.size) rec.reactions = Object.fromEntries([...out].map(([k, v]) => [k, [...v]]));
  }

  private attachments(list: unknown, budget: TextBudget): ImportAttachment[] {
    if (!Array.isArray(list)) return [];
    const out: ImportAttachment[] = [];
    const L = ATTACHMENT_MAX;
    const conv = (v: unknown, max: number, mode: MarkupMode = 'markdown') => convertMarkup(budget.take(v, max), this, mode).trim();
    for (const a of list) {
      if (out.length >= MAX_ATTACHMENTS) break;
      if (!isObj(a)) continue;
      const att: ImportAttachment = {};
      // Título, autor, rodapé e título dos campos aparecem como texto simples: um link em markdown ficaria cru na tela.
      const title = conv(a.title, L.title, 'text');
      const pretext = conv(a.pretext, L.text);
      let text = conv(a.text, L.text);
      const fields: { title: string; value: string; short: boolean }[] = [];
      for (const f of Array.isArray(a.fields) ? a.fields : []) {
        if (fields.length >= MAX_FIELDS) break;
        if (!isObj(f)) continue;
        const field = { title: conv(f.title, L.fieldTitle, 'text'), value: conv(f.value, L.fieldValue), short: f.short === true };
        if (field.title || field.value) fields.push(field);
      }
      if (!text && !title && !pretext && !fields.length) text = conv(a.fallback, L.text);
      if (title) att.title = title;
      const link = httpUrl(a.title_link) || httpUrl(a.from_url) || httpUrl(a.original_url);
      if (link) att.title_link = link;
      if (text) att.text = text;
      if (pretext) att.pretext = pretext;
      const color = normalizeColor(a.color);
      if (color) att.color = color;
      const author = conv(a.author_name, L.author, 'text') || conv(a.author_subname, L.author, 'text');
      if (author) att.author_name = author;
      if (httpUrl(a.author_link)) att.author_link = httpUrl(a.author_link);
      if (imageUrl(a.author_icon)) att.author_icon = imageUrl(a.author_icon);
      if (imageUrl(a.image_url)) att.image_url = imageUrl(a.image_url);
      if (imageUrl(a.thumb_url)) att.thumb_url = imageUrl(a.thumb_url);
      const footer = conv(a.footer, L.text, 'text');
      if (footer) att.footer = footer;
      if (fields.length) att.fields = fields;
      const ts = slackTs(a.ts);
      if (Object.keys(att).length) {
        if (ts) att.ts = ts;
        out.push(att);
      }
    }
    return out;
  }
}

// __MACOSX/, .DS_Store e outros arquivos ocultos: lixo de quem compactou, nunca dados.
const isJunk = (name: string) => name.split('/').some((p) => p.startsWith('.') || p === '__MACOSX');

// Pasta em volta da exportação (o .zip foi feito da pasta, não dos arquivos dentro dela): o prefixo a tirar dos nomes.
// Vale a pasta mais rasa que tem users.json, channels.json etc. logo abaixo, quando eles não estão na raiz.
function wrapperPrefix(names: string[]): string {
  if (names.some((n) => META.has(n))) return '';
  const candidates = names.filter((n) => META.has(n.slice(n.lastIndexOf('/') + 1))).map((n) => n.slice(0, n.lastIndexOf('/') + 1));
  return candidates.sort((a, b) => a.length - b.length)[0] ?? '';
}

class JsonError extends Error {
  constructor(
    public problem: 'invalid' | 'not-list' | 'too-big',
    public line?: number,
  ) {
    super('JSON inválido');
  }
}

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
// Bytes que começam um valor JSON que não é lista: { " - 0-9 t f n.
const isValueStart = (c: number) => c === 0x7b || c === 0x22 || c === 0x2d || (c >= 0x30 && c <= 0x39) || c === 0x74 || c === 0x66 || c === 0x6e;

// Linha (contando de 1) do byte pos.
function lineAt(buf: Buffer, pos: number) {
  let line = 1;
  for (let i = 0; i < pos && i < buf.length; i++) if (buf[i] === 0x0a) line++;
  return line;
}

// Estado de cutList entre uma pausa e outra.
interface CutState {
  cuts: [number, number][];
  phase: 'before' | 'inside' | 'after'; // antes do "[", dentro da lista, depois do "]"
  i: number;
  depth: number;
  piece: number; // começo do pedaço atual
  pieceValues: number;
  item: number; // começo do item atual
  values: number;
  filled: boolean; // o item atual já tem algo além de espaços
  commas: boolean;
}

const invalidAt = (buf: Buffer, pos: number) => new JsonError('invalid', lineAt(buf, pos));
const tooBigAt = (buf: Buffer, item: number) => new JsonError('too-big', lineAt(buf, item));

// Avança o corte da lista até o byte stop. Devolve true quando a lista acabou. Síncrona e só com variáveis locais no
// laço (é o laço mais quente da leitura); cutList faz as pausas entre uma chamada e outra.
function cutStep(buf: Buffer, s: CutState, stop: number): boolean {
  const { itemBytes, itemValues, pieceBytes, pieceValues: maxPieceValues } = SLACK_LIMITS;
  const n = buf.length;
  const end = Math.min(n, stop);
  let i = s.i;
  if (s.phase === 'before') {
    while (i < end && isSpace(buf[i])) i++;
    if (i >= n) throw new JsonError('invalid');
    if (i >= end) {
      s.i = i;
      return false;
    }
    if (buf[i] !== 0x5b) throw new JsonError(isValueStart(buf[i]) ? 'not-list' : 'invalid', lineAt(buf, i));
    i++;
    Object.assign(s, { phase: 'inside', depth: 1, piece: i, item: i });
  }
  if (s.phase === 'inside') {
    let { depth, piece, pieceValues, item, values, filled, commas } = s;
    for (; i < end; i++) {
      const c = buf[i];
      if (c === 0x22) {
        // Pula o texto até a aspa que fecha (a barra invertida escapa o byte seguinte), no máximo até o limite do item.
        const max = Math.min(n, item + itemBytes + 1);
        for (i++; i < max && buf[i] !== 0x22; i++) if (buf[i] === 0x5c) i++;
        if (i >= n) break;
        if (i >= max) throw tooBigAt(buf, item);
        filled = true;
      } else if (c === 0x7b || c === 0x5b) {
        depth++;
        values++;
        filled = true;
      } else if (c === 0x7d || c === 0x5d) {
        if (--depth > 0) continue;
        if (c !== 0x5d) throw invalidAt(buf, i);
        // "[]" é uma lista vazia; "[1,]", um item vazio.
        if (filled) {
          if (i - item > itemBytes || values > itemValues) throw tooBigAt(buf, item);
        } else if (commas) {
          throw invalidAt(buf, i);
        }
        s.cuts.push([piece, i]);
        s.phase = 'after';
        i++;
        break;
      } else if (c === 0x2c && depth === 1) {
        if (!filled) throw invalidAt(buf, i);
        if (i - item > itemBytes || values > itemValues) throw tooBigAt(buf, item);
        pieceValues += values + 1;
        if (i - piece >= pieceBytes || pieceValues >= maxPieceValues) {
          s.cuts.push([piece, i]);
          piece = i + 1;
          pieceValues = 0;
        }
        item = i + 1;
        values = 0;
        filled = false;
        commas = true;
      } else if (c === 0x2c || c === 0x3a) {
        values++;
      } else if (!filled && !isSpace(c)) {
        filled = true;
      }
    }
    // Acabou antes de fechar a lista (ou um texto).
    if (s.phase === 'inside' && i >= n) throw invalidAt(buf, n);
    Object.assign(s, { depth, piece, pieceValues, item, values, filled, commas });
  }
  if (s.phase === 'after') {
    for (; i < end; i++) if (!isSpace(buf[i])) throw invalidAt(buf, i);
  }
  s.i = i;
  return s.phase === 'after' && i >= n;
}

// Corta a lista ([...]) em pedaços de itens inteiros sem montar nada: [início, fim) de cada pedaço nos bytes, sem os
// colchetes de fora e sem a vírgula entre um pedaço e outro. Aqui só a estrutura é conferida (colchetes, textos,
// vírgulas entre os itens e o tamanho de cada item); o resto, pelo JSON.parse de cada pedaço.
async function cutList(buf: Buffer): Promise<[number, number][]> {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const s: CutState = { cuts: [], phase: 'before', i: bom, depth: 0, piece: 0, pieceValues: 0, item: 0, values: 0, filled: false, commas: false };
  while (!cutStep(buf, s, s.i + SCAN_PAUSE)) await breathe();
  return s.cuts;
}

// Um pedaço cortado por cutList, montado. O erro diz a linha no arquivo. Num pedaço grande (um item só, até 16 MB),
// a decodificação do texto e o JSON.parse ficam em vezes separadas do event loop.
async function parsePiece(buf: Buffer, [start, end]: [number, number]): Promise<unknown[]> {
  const text = `[${buf.toString('utf8', start, end)}]`;
  if (end - start > SCAN_PAUSE) await breathe();
  try {
    return JSON.parse(text) as unknown[];
  } catch (e) {
    // Só a posição do fim da mensagem do V8: o trecho do JSON citado em outras mensagens é texto do arquivo.
    const m = /in JSON at position (\d+)(?: \(line (\d+) column \d+\))?$/.exec(String((e as Error)?.message ?? ''));
    if (!m) throw new JsonError('invalid');
    let line = m[2] ? Number(m[2]) : 1;
    if (!m[2]) for (let i = text.indexOf('\n'); i >= 0 && i < Number(m[1]); i = text.indexOf('\n', i + 1)) line++;
    throw new JsonError('invalid', lineAt(buf, start) - 1 + line);
  }
}

// Lista de um .json da exportação, lida aos pedaços: cada pedaço é um JSON.parse de alguns itens inteiros, e só o
// pedaço da vez fica montado. Com um JSON.parse do arquivo inteiro, um .zip de 3 MB com quatro listas de 64 MB de
// "-0,-0,..." (ou "{},{},...", ou chaves diferentes) virava gigabytes e travava o servidor por segundos.
class JsonList {
  private constructor(
    private buf: Buffer,
    private cuts: [number, number][],
    private first: unknown[] | null,
  ) {}

  // Com validate, o arquivo todo é conferido antes (cada pedaço é montado e descartado), e pieces() não falha.
  // Sem validate, um defeito no meio da lista aparece durante pieces().
  static async open(ctx: PrepareContext, entry: ArchiveEntry, validate: boolean) {
    const buf = await ctx.source.read(entry, MAX_JSON_BYTES);
    const cuts = await cutList(buf);
    // Um pedaço só (quase todo dia de verdade): montado uma vez.
    if (cuts.length === 1) return new JsonList(buf, cuts, await parsePiece(buf, cuts[0]));
    if (validate) {
      for (const cut of cuts) {
        await parsePiece(buf, cut);
        await breathe();
      }
    }
    return new JsonList(buf, cuts, null);
  }

  async *pieces(): AsyncGenerator<unknown[]> {
    if (this.first) {
      yield this.first;
      return;
    }
    // Pausas antes e depois de montar cada pedaço: montar um item de 16 MB e converter a mensagem dele, juntos, já
    // passavam de 100 ms sem devolver a vez.
    for (const cut of this.cuts) {
      await breathe();
      const piece = await parsePiece(this.buf, cut);
      await breathe();
      yield piece;
    }
  }
}

// 500000 → "500.000", sem depender dos dados de idioma do Node.
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, '.');

const jsonProblem = (file: string, e: JsonError) =>
  e.problem === 'too-big'
    ? `"${file}" tem um item grande demais (mais de ${Math.round(SLACK_LIMITS.itemBytes / MiB)} MB ou de ${thousands(SLACK_LIMITS.itemValues)} valores)`
    : `"${file}" não é um JSON válido${e.line ? ` (erro perto da linha ${e.line})` : ''}`;

// users.json, channels.json etc., aos pedaços. Qualquer defeito para a leitura, mesmo no meio da lista (o que já foi
// gravado é descartado com a operação).
async function* readList(ctx: PrepareContext, entry: ArchiveEntry, file: string): AsyncGenerator<unknown[]> {
  try {
    yield* (await JsonList.open(ctx, entry, false)).pieces();
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    throw new ImportError(`Não foi possível ler a exportação: ${e.problem === 'not-list' ? `"${file}" deveria ter uma lista (começando com "[")` : jsonProblem(file, e)}.`);
  }
}

export const slackImporter: Importer = {
  key: 'slack',
  name: 'Slack',
  label: 'Slack (exportação .zip)',
  description:
    'O .zip gerado em "Importar/exportar dados" nas configurações do espaço de trabalho do Slack. Traz os usuários, os canais (e, se a exportação tiver, os grupos privados e as mensagens diretas) com as mensagens, threads e reações. Os arquivos das mensagens e as fotos de perfil são baixados depois, em "Baixar arquivos pendentes" e "Baixar fotos pendentes".',
  accept: '.zip',
  sourceKind: 'zip',
  visible: true,
  prepare: (ctx) => new SlackReader(ctx).prepare(),
};
