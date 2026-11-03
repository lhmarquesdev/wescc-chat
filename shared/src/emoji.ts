// Emojis por shortcode (o subconjunto que a web desenha). Mora no shared porque as exportações do servidor (Exportar
// mensagens e Meus dados) mostram as reações como o chat: 👍, não :thumbsup:.

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

// ":thumbsup:" ou "thumbsup" → "👍". Emoji personalizado (ou desconhecido) fica como ":nome:".
export function emojiText(code: string): string {
  const name = code.replace(/^:|:$/g, '');
  return Object.prototype.hasOwnProperty.call(EMOJI, name) ? EMOJI[name] : `:${name}:`;
}
