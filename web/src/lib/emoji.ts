// Emojis por shortcode (subconjunto mais usado) e categorias do seletor.

export const EMOJI: Record<string, string> = {
  smile: '😄', smiley: '😃', grinning: '😀', blush: '😊', wink: '😉', heart_eyes: '😍', kissing_heart: '😘', relaxed: '☺️',
  joy: '😂', rofl: '🤣', sweat_smile: '😅', laughing: '😆', innocent: '😇', slight_smile: '🙂', upside_down: '🙃', yum: '😋',
  stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜', sunglasses: '😎', nerd: '🤓', thinking: '🤔', neutral_face: '😐',
  expressionless: '😑', no_mouth: '😶', smirk: '😏', unamused: '😒', rolling_eyes: '🙄', grimacing: '😬', relieved: '😌',
  pensive: '😔', sleepy: '😪', sleeping: '😴', mask: '😷', nauseated_face: '🤢', sneezing_face: '🤧', hot_face: '🥵',
  cold_face: '🥶', dizzy_face: '😵', exploding_head: '🤯', cowboy: '🤠', partying_face: '🥳', confused: '😕', worried: '😟',
  slight_frown: '🙁', open_mouth: '😮', astonished: '😲', flushed: '😳', pleading_face: '🥺', cry: '😢', sob: '😭',
  scream: '😱', confounded: '😖', persevere: '😣', disappointed: '😞', sweat: '😓', weary: '😩', tired_face: '😫',
  yawning_face: '🥱', triumph: '😤', rage: '😡', angry: '😠', skull: '💀', poop: '💩', clown: '🤡', ghost: '👻', alien: '👽',
  robot: '🤖', smiley_cat: '😺', see_no_evil: '🙈', hear_no_evil: '🙉', speak_no_evil: '🙊', hugging: '🤗', shushing_face: '🤫',
  zipper_mouth: '🤐', money_mouth: '🤑', star_struck: '🤩', face_with_monocle: '🧐', saluting_face: '🫡', melting_face: '🫠',
  wave: '👋', raised_hand: '✋', ok_hand: '👌', v: '✌️', crossed_fingers: '🤞', metal: '🤘', call_me: '🤙', point_left: '👈',
  point_right: '👉', point_up: '☝️', point_down: '👇', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', fist: '✊',
  punch: '👊', clap: '👏', raised_hands: '🙌', open_hands: '👐', handshake: '🤝', pray: '🙏', muscle: '💪', writing_hand: '✍️',
  eyes: '👀', brain: '🧠', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙',
  purple_heart: '💜', black_heart: '🖤', broken_heart: '💔', two_hearts: '💕', sparkling_heart: '💖', heartbeat: '💓',
  fire: '🔥', sparkles: '✨', star: '⭐', star2: '🌟', zap: '⚡', boom: '💥', '100': '💯', tada: '🎉', confetti_ball: '🎊',
  balloon: '🎈', gift: '🎁', trophy: '🏆', medal: '🏅', first_place: '🥇', rocket: '🚀', airplane: '✈️', car: '🚗',
  coffee: '☕', beer: '🍺', beers: '🍻', wine_glass: '🍷', pizza: '🍕', hamburger: '🍔', cake: '🍰', birthday: '🎂',
  apple: '🍎', banana: '🍌', popcorn: '🍿', sun: '☀️', sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️',
  rainbow: '🌈', earth_americas: '🌎', moon: '🌙', dog: '🐶', cat: '🐱', unicorn: '🦄', bug: '🐛', bee: '🐝', tree: '🌳',
  seedling: '🌱', rose: '🌹', sunflower: '🌻', check: '✔️', white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌',
  warning: '⚠️', no_entry: '⛔', question: '❓', exclamation: '❗', bulb: '💡', memo: '📝', pencil: '✏️', book: '📖',
  books: '📚', calendar: '📅', date: '📅', clock: '🕐', hourglass: '⌛', alarm_clock: '⏰', bell: '🔔', mega: '📣',
  loudspeaker: '📢', email: '📧', envelope: '✉️', inbox_tray: '📥', outbox_tray: '📤', package: '📦', paperclip: '📎',
  pushpin: '📌', round_pushpin: '📍', link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑', hammer: '🔨', wrench: '🔧',
  gear: '⚙️', computer: '💻', keyboard: '⌨️', iphone: '📱', telephone: '☎️', phone: '📞', video_camera: '📹',
  camera: '📷', tv: '📺', chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊',
  clipboard: '📋', file_folder: '📁', mag: '🔍', money_with_wings: '💸', moneybag: '💰', dollar: '💵', credit_card: '💳',
  briefcase: '💼', house: '🏠', office: '🏢', hospital: '🏥', school: '🏫', checkered_flag: '🏁', triangular_flag_on_post: '🚩',
  flag_br: '🇧🇷', soccer: '⚽', basketball: '🏀', video_game: '🎮', musical_note: '🎵', headphones: '🎧', art: '🎨',
  red_circle: '🔴', green_circle: '🟢', yellow_circle: '🟡', blue_circle: '🔵', white_circle: '⚪', black_circle: '⚫',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', repeat: '🔁', recycle: '♻️', infinity: '♾️',
  hourglass_flowing_sand: '⏳', stopwatch: '⏱️', zzz: '💤', speech_balloon: '💬', thought_balloon: '💭', dash: '💨',
  sweat_drops: '💦', droplet: '💧', ok: '🆗', new: '🆕', free: '🆓', sos: '🆘', cool: '🆒', top: '🔝', soon: '🔜',
};

export const EMOJI_CATEGORIES: { name: string; icon: string; items: string[] }[] = [
  {
    name: 'Rostos',
    icon: '😄',
    items: Object.keys(EMOJI).slice(0, Object.keys(EMOJI).indexOf('wave')),
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

export function searchEmoji(term: string, limit = 10) {
  const t = term.toLowerCase();
  const out: string[] = [];
  for (const k of Object.keys(EMOJI)) if (k.includes(t)) out.push(k);
  for (const c of customEmoji) if (c.name.includes(t)) out.push(c.name);
  return out.slice(0, limit);
}
