// Categorias do seletor e emojis personalizados. O mapa por shortcode (EMOJI) mora em shared/emoji.ts.

import { EMOJI } from '@shared/emoji';

export { EMOJI };

// O JS põe chaves numéricas ('100') antes das outras: sem o filtro, o 💯 abriria a lista de rostos.
const FACE_KEYS = Object.keys(EMOJI).filter((k) => !/^\d+$/.test(k));

export const EMOJI_CATEGORIES: { name: string; icon: string; items: string[] }[] = [
  {
    name: 'Rostos',
    icon: '😄',
    items: FACE_KEYS.slice(0, FACE_KEYS.indexOf('wave')),
  },
  {
    name: 'Pessoas',
    icon: '👍',
    items: ['wave', 'raised_hand', 'ok_hand', 'v', 'crossed_fingers', 'metal', 'call_me', 'point_left', 'point_right', 'point_up', 'point_down', 'thumbsup', 'thumbsdown', 'fist', 'punch', 'clap', 'raised_hands', 'open_hands', 'handshake', 'pray', 'muscle', 'writing_hand', 'eyes', 'brain'],
  },
  {
    name: 'Símbolos',
    icon: '❤️',
    items: ['heart', 'orange_heart', 'yellow_heart', 'green_heart', 'blue_heart', 'purple_heart', 'black_heart', 'broken_heart', 'two_hearts', 'sparkling_heart', 'heartbeat', 'fire', 'sparkles', 'star', 'star2', 'zap', 'boom', '100', 'white_check_mark', 'heavy_check_mark', 'x', 'warning', 'no_entry', 'question', 'exclamation', 'red_circle', 'green_circle', 'yellow_circle', 'blue_circle', 'arrow_right', 'arrow_left', 'arrow_up', 'arrow_down', 'repeat', 'recycle', 'speech_balloon', 'thought_balloon', 'zzz', 'ok', 'new', 'sos', 'cool', 'top', 'soon'],
  },
  {
    name: 'Atividades',
    icon: '🎉',
    items: ['tada', 'confetti_ball', 'balloon', 'gift', 'trophy', 'medal', 'first_place', 'soccer', 'basketball', 'video_game', 'musical_note', 'headphones', 'art', 'checkered_flag', 'triangular_flag_on_post', 'flag_br'],
  },
  {
    name: 'Comida e natureza',
    icon: '☕',
    items: ['coffee', 'beer', 'beers', 'wine_glass', 'pizza', 'hamburger', 'cake', 'birthday', 'apple', 'banana', 'popcorn', 'sun', 'cloud', 'umbrella', 'snowflake', 'rainbow', 'earth_americas', 'moon', 'dog', 'cat', 'unicorn', 'bug', 'bee', 'tree', 'seedling', 'rose', 'sunflower'],
  },
  {
    name: 'Objetos',
    icon: '💡',
    items: ['bulb', 'memo', 'pencil', 'book', 'books', 'calendar', 'clock', 'hourglass', 'alarm_clock', 'bell', 'mega', 'email', 'envelope', 'package', 'paperclip', 'pushpin', 'link', 'lock', 'unlock', 'key', 'hammer', 'wrench', 'gear', 'computer', 'keyboard', 'iphone', 'phone', 'video_camera', 'camera', 'chart_with_upwards_trend', 'chart_with_downwards_trend', 'bar_chart', 'clipboard', 'file_folder', 'mag', 'moneybag', 'dollar', 'credit_card', 'briefcase', 'house', 'office', 'rocket', 'airplane', 'car'],
  },
];

export interface CustomEmoji {
  _id: string;
  name: string;
  aliases: string[];
  extension: string;
}

export let customEmoji: CustomEmoji[] = [];
const customByName = new Map<string, CustomEmoji>();

export function setCustomEmoji(list: CustomEmoji[]) {
  customEmoji = list;
  customByName.clear();
  for (const e of list) {
    customByName.set(e.name, e);
    for (const a of e.aliases) customByName.set(a, e);
  }
}

export function resolveEmoji(code: string): { unicode?: string; url?: string } | null {
  const name = code.replace(/^:|:$/g, '');
  if (EMOJI[name]) return { unicode: EMOJI[name] };
  const c = customByName.get(name);
  if (c) return { url: `/emoji-custom/${encodeURIComponent(c.name)}` };
  return null;
}

// Os códigos são em inglês; estas palavras deixam a busca achar o emoji em português.
const PT_WORDS: Record<string, string[]> = {
  coracao: ['heart', 'orange_heart', 'yellow_heart', 'green_heart', 'blue_heart', 'purple_heart', 'heart_eyes', 'two_hearts', 'sparkling_heart'],
  amor: ['heart', 'heart_eyes', 'kissing_heart', 'two_hearts'],
  joinha: ['+1'],
  joia: ['+1'],
  positivo: ['+1', 'white_check_mark'],
  negativo: ['-1'],
  certo: ['white_check_mark', 'heavy_check_mark'],
  feito: ['white_check_mark', 'heavy_check_mark'],
  errado: ['x'],
  rir: ['joy', 'rofl', 'laughing', 'smile'],
  risada: ['joy', 'rofl', 'laughing'],
  sorriso: ['smile', 'smiley', 'grinning', 'blush'],
  feliz: ['smile', 'smiley', 'grinning', 'blush'],
  triste: ['cry', 'sob', 'disappointed', 'pensive'],
  chorar: ['cry', 'sob'],
  festa: ['tada', 'confetti_ball', 'partying_face'],
  parabens: ['tada', 'clap', 'trophy'],
  palmas: ['clap'],
  obrigado: ['pray'],
  obrigada: ['pray'],
  olhos: ['eyes'],
  fogo: ['fire'],
  estrela: ['star', 'star2'],
  atencao: ['warning', 'exclamation'],
  alerta: ['warning'],
  pergunta: ['question'],
  ideia: ['bulb'],
  cafe: ['coffee'],
  telefone: ['telephone', 'phone'],
  relogio: ['alarm_clock', 'hourglass'],
  dinheiro: ['moneybag', 'dollar'],
  foguete: ['rocket'],
  pensando: ['thinking'],
  ola: ['wave'],
  tchau: ['wave'],
};
const fold = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Busca do seletor de emoji e do atalho ":" do compositor: palavra em português (sem acento: "coração" = "coracao")
// e depois o código em inglês. unicodeOnly deixa de fora os emojis personalizados.
export function searchEmoji(term: string, limit = 10, unicodeOnly = false) {
  const t = fold(term.trim());
  if (!t) return [];
  const pt = Object.entries(PT_WORDS).flatMap(([w, codes]) => (w.startsWith(t) ? codes : []));
  const byCode = Object.keys(EMOJI).filter((k) => k.includes(t));
  const custom = unicodeOnly ? [] : customEmoji.filter((c) => c.name.includes(t)).map((c) => c.name);
  return [...new Set([...pt.filter((c) => c in EMOJI), ...byCode, ...custom])].slice(0, limit);
}
