// Figurinhas: tipos e funções puras usadas pelo servidor e pela web.

export type StickerScope = 'org' | 'personal';
export type StickerMime = 'image/webp' | 'image/png' | 'image/gif';
export const STICKER_MIMES: readonly StickerMime[] = ['image/webp', 'image/png', 'image/gif'];

export const STICKER_LIMITS = {
  maxSide: 512,
  minLongSide: 96,
  maxFrames: 200,
  nameMax: 40,
  emojisMax: 5,
  keywordsMax: 10,
  keywordMax: 30,
  packNameMax: 40,
  packDescriptionMax: 200,
  orgPacksMax: 50,
  recents: 30,
  visibleRolesMax: 20,
  posterMaxKB: 256,
  autoplayMs: 5000,
  playingMax: 6,
  sendBurst: 8, // figurinhas por pessoa dentro de sendWindowMs
  sendWindowMs: 10_000,
  doubleClickMs: 600, // segundo clique na mesma célula é ignorado
  phashMaxDistance: 6,
  phashAspectTolerance: 0.1,
  phashMinBits: 8, // hash com menos de 8 (ou mais de 56) bits 1 = imagem lisa demais para comparar
  accessCacheMs: 600_000,
  accessCacheMax: 50_000,
  deniedCacheMs: 30_000,
  byteChecksPerMinute: 1200, // por pessoa, só pedidos que chegam às consultas de acesso
  importMaxEntries: 300,
  importMaxEntryMB: 8,
  importMaxTotalMB: 100,
  importPerSecond: 2,
  editorMaxInputMB: 20,
  editorMaxMegapixels: 40,
  editorDecodeMaxSide: 2048,
  editorWorkMaxSide: 1024,
  editorHistory: 20,
} as const;

// O que fica gravado na mensagem (messages.extra.sticker). Montado só pelo servidor.
export interface MessageStickerLive {
  fileId: string;
  removed?: false;
  name: string;
  emojis: string[];
  width: number;
  height: number;
  animated: boolean;
  durationMs?: number;
  url: string; // /sticker/<fileId>.<ext>
  posterUrl?: string; // /sticker/<fileId>/poster.<ext> (só animadas)
  scope: StickerScope;
  stickerId?: string; // só 'org'
  packId?: string; // só 'org'
  packName?: string; // só 'org'
}
export interface MessageStickerRemoved {
  fileId: string;
  removed: true;
  width?: number; // mantidos para a caixa não mudar de tamanho
  height?: number;
}
export type MessageSticker = MessageStickerLive | MessageStickerRemoved;

export interface StickerFileInfo {
  fileId: string;
  mime: StickerMime;
  width: number;
  height: number;
  size: number;
  animated: boolean;
  frames: number;
  durationMs?: number;
  url: string;
  posterUrl?: string;
}

export interface StickerItem extends StickerFileInfo {
  _id: string;
  packId: string;
  name: string;
  emojis: string[];
  keywords: string[];
  sort: number;
  createdAt: string;
}

export interface StickerPack {
  _id: string;
  scope: StickerScope;
  name: string;
  description: string;
  coverUrl?: string; // pôster (animadas) ou arquivo da figurinha de capa
  status: 'draft' | 'published';
  visibleRoles: string[];
  sort: number;
  count: number;
  stickers: StickerItem[];
  updatedAt: string;
}

export interface StickerUserItem extends StickerFileInfo {
  kind: 'favorite' | 'recent';
  stickerId?: string;
  packId?: string; // só quando a origem é um pacote da organização visível
  packName?: string;
  name: string;
  emojis: string[];
  scope: StickerScope; // calculado na listagem: 'org' se está num pacote da organização visível
  usedAt: string;
}

export interface StickerQuota {
  packs: number;
  maxPacks: number;
  bytes: number;
  quotaBytes: number;
}

export interface StickerCatalogOrg {
  scope: 'org';
  version: string;
  userId: string; // de quem é este catálogo (o cache local confere)
  packs: StickerPack[];
}
export interface StickerCatalogMine {
  scope: 'mine';
  version: string;
  userId: string;
  packs: StickerPack[];
  favorites: StickerUserItem[];
  recents: StickerUserItem[];
  quota: StickerQuota;
}
export interface StickerCatalogUnchanged {
  scope: 'org' | 'mine';
  version: string;
  unchanged: true;
}

export interface BlockedStickerFile {
  fileId: string;
  name: string;
  reason: string;
  blockedAt: string;
  blockedBy: { _id: string; username: string } | null;
  messages: number;
  quarantined: boolean;
  quarantineUntil: string | null;
  mime: StickerMime;
}

export interface StickerUsage {
  fileId: string;
  messages: number;
  rooms: number;
  packCount: number; // todos os pacotes que têm a figurinha
  packs: { _id: string; name: string; scope: StickerScope; owner?: string }[]; // gestores: só os da organização; owner = username, sem @
  favorites: number;
  blocked: boolean;
  keepDays: number; // Stickers_Removed_Keep_Days, para o texto do diálogo de remoção
  provenance?: {
    // só para a moderação; nomes de usuário sem @ (a web acrescenta)
    createdBy: string | null; // username de quem enviou este conteúdo primeiro
    sources: { stickerId: string; packName: string; owner?: string; sourceMessageId: string | null; sourceUser: string | null }[];
  };
}

// Uma célula do seletor (montada no cliente a partir dos catálogos).
export interface StickerPick {
  key: string; // `${seção}:${fileId}`
  fileId: string;
  stickerId?: string;
  packId?: string;
  packName?: string;
  name: string;
  emojis: string[];
  keywords: string[];
  mime: string;
  url: string;
  posterUrl?: string;
  width: number;
  height: number;
  animated: boolean;
  durationMs?: number;
  scope: StickerScope;
  source: 'favorite' | 'recent' | 'org' | 'personal';
  editable: boolean; // minha pessoal, ou da organização e eu gerencio
}
export interface PickerSections {
  favorites: StickerPick[];
  recents: StickerPick[];
  org: { pack: StickerPack; picks: StickerPick[] }[];
  personal: { pack: StickerPack; picks: StickerPick[] }[];
}

// ---------- Texto ----------

const seg = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
const graphemes = (s: string) => Array.from(seg.segment(s), (x) => x.segment);

// Um emoji: bandeira, tecla (1️⃣), pictograma com modificador, sequência ZWJ ou bandeira por tags.
const EMOJI_RE =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?)*)$/u;

export const isEmoji = (g: string) => EMOJI_RE.test(g);

// Chave de comparação: sem seletor de variação e sem tom de pele ("👍🏽" acha "👍").
export const emojiKey = (e: string) => e.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, '');

export function singleEmoji(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 32) return null;
  const g = graphemes(t);
  return g.length === 1 && isEmoji(g[0]) ? g[0] : null;
}

// O que o compositor tem quando a pessoa "digitou um emoji": o emoji Unicode ou um ":código:" (o seletor de
// emojis e o autocompletar inserem códigos). toUnicode vem da web (resolveEmoji); emoji personalizado dá null.
export function composerEmoji(text: string, toUnicode: (code: string) => string | null): string | null {
  const t = text.trim();
  const code = /^:([a-z0-9_+\-]+):$/i.exec(t)?.[1];
  if (code) {
    const u = toUnicode(code.toLowerCase());
    return u ? singleEmoji(u) : null;
  }
  return singleEmoji(t);
}

// Tira controles (Cc) e formatação invisível (Cf): marcas de direção, U+2060, U+00AD, U+180E, U+FEFF…
// Ficam o ZWJ (U+200D, parte de emojis) e as bandeiras por tags (🏴 + tags + U+E007F).
export function stripInvisible(s: string): string {
  return s.replace(/(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\p{Cc}\p{Cf}]/gu, (m, flag) => (flag ? flag : m === '‍' ? m : ''));
}

export function cleanStickerName(v: unknown, max: number = STICKER_LIMITS.nameMax): string {
  if (typeof v !== 'string') return '';
  const s = stripInvisible(v.normalize('NFC')).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

export function cleanEmojis(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    for (const g of graphemes(item)) {
      if (!isEmoji(g) || seen.has(emojiKey(g))) continue; // ":+1:" não é emoji: só Unicode entra
      seen.add(emojiKey(g));
      out.push(g);
      if (out.length === STICKER_LIMITS.emojisMax) return out;
    }
  }
  return out;
}

export function cleanKeywords(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const k = cleanStickerName(item.trim().replace(/^#+/, ''), STICKER_LIMITS.keywordMax).toLocaleLowerCase('pt-BR'); // "a, #b": o # vem depois do espaço
    if (k && !out.includes(k)) out.push(k);
    if (out.length === STICKER_LIMITS.keywordsMax) break;
  }
  return out;
}

// "Bom-dia_final.PNG" -> "Bom dia final" (nome sugerido pelo editor e pela importação).
export function nameFromFileName(file: string): string {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? ''; // entradas de ZIP podem vir com pastas
  const words = base
    .replace(/\.[^.]*$/, '')
    .replace(/[_.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [first = '', ...rest] = Array.from(words);
  return cleanStickerName(first.toLocaleUpperCase('pt-BR') + rest.join('')) || DEFAULT_STICKER_NAME;
}

export const normalizeSearch = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();

// 0 = não combina. Um emoji sozinho só combina pelos emojis da figurinha.
export function stickerScore(item: { name: string; emojis: string[]; keywords?: string[]; packName?: string }, query: string): number {
  const e = singleEmoji(query);
  if (e) return item.emojis.some((x) => emojiKey(x) === emojiKey(e)) ? 100 : 0;
  const q = normalizeSearch(query);
  if (!q) return 0;
  const name = normalizeSearch(item.name);
  const kws = (item.keywords ?? []).map(normalizeSearch);
  if (name === q) return 90;
  if (name.startsWith(q)) return 80;
  if (kws.includes(q)) return 70;
  if (name.split(' ').some((w) => w.startsWith(q))) return 60;
  if (kws.some((k) => k.startsWith(q))) return 50;
  if (name.includes(q)) return 30;
  if (item.packName && normalizeSearch(item.packName).includes(q)) return 10;
  return 0;
}

export const DEFAULT_STICKER_NAME = 'Figurinha';

// withName false: citações e mensagens de "fixou" guardam só "☀️ Figurinha", porque são cópias duradouras.
export function stickerPreviewText(s: MessageSticker, opts: { withName?: boolean } = {}): string {
  if (s.removed) return 'Figurinha removida';
  const named = opts.withName !== false && s.name && s.name !== DEFAULT_STICKER_NAME ? ` “${s.name}”` : '';
  return `${s.emojis[0] ? `${s.emojis[0]} ` : ''}Figurinha${named}`;
}

// Prévia de uma mensagem sem texto (notificação, última mensagem, citação, fixar, integrações).
export function messagePreviewText(
  m: { msg?: string | null; sticker?: MessageSticker | null; files?: { name: string }[] | null },
  opts: { withName?: boolean } = {},
): string {
  if (m.msg) return m.msg;
  if (m.sticker) return stickerPreviewText(m.sticker, opts);
  if (m.files?.length) return `📎 ${m.files[0].name}`; // igual aos outros produtores de prévia (dívida do DS, design §1.4)
  return '';
}

// ---------- Onde e o que dá para enviar ----------

// Mesma regra de typeAllowed (server/src/services/uploads.ts); o teste confere as duas.
export function mediaTypeAllowed(type: string, whiteList: string, blackList: string): boolean {
  const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const match = (p: string) => (p.endsWith('/*') ? type.startsWith(p.slice(0, -1)) : type === p);
  if (list(blackList).some(match)) return false;
  const white = list(whiteList);
  return !white.length || white.some(match);
}

export interface StickerSendPolicy {
  personalEnabled: boolean; // Stickers_Personal_Enabled
  animatedEnabled: boolean; // Stickers_Animated_Enabled
  uploadsEnabled: boolean; // FileUpload_Enabled
  uploadsInDirect: boolean; // FileUpload_Enabled_Direct
  whiteList: string; // FileUpload_MediaTypeWhiteList
  blackList: string; // FileUpload_MediaTypeBlackList
}

// D7 no cliente, na mesma ordem do servidor (§3.6 passo 9). null = pode enviar; texto = motivo.
export function sendBlockedReason(
  p: { scope: StickerScope; mime: string; animated: boolean },
  room: { t: string } | null | undefined,
  policy: StickerSendPolicy,
): string | null {
  if (p.scope === 'personal') {
    if (!policy.personalEnabled) return 'As figurinhas pessoais estão desativadas.';
    if (!policy.uploadsEnabled || !mediaTypeAllowed(p.mime, policy.whiteList, policy.blackList) || (room?.t === 'd' && !policy.uploadsInDirect))
      return 'Nesta conversa só dá para enviar figurinhas da organização.';
  }
  if (p.animated && !policy.animatedEnabled) return 'Figurinhas animadas estão desativadas.';
  return null;
}

// Salas onde a aba Figurinhas e as sugestões aparecem. O servidor recusa as mesmas (§3.6).
export function stickersAllowedIn(room: { t: string; notice?: boolean } | null | undefined, opts: { noticeRooms: boolean }): boolean {
  if (!room) return false;
  if (room.notice && !opts.noticeRooms) return false;
  return true;
}

// Stickers_Send_Blocked_Roles: ids separados por vírgula, comparados sem diferenciar maiúsculas.
export function rolesBlockedFromSending(roles: string[], setting: string): boolean {
  const blocked = setting.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return roles.some((r) => blocked.includes(r.toLowerCase()));
}

// "Criar figurinha" só a partir de uma imagem enviada como arquivo, nunca de outra figurinha.
export const STICKER_SOURCE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const FILE_UPLOAD_SOURCE_RE = /^\/file-upload\/([A-Za-z0-9]{10,24})\//;
export function canCreateFromMessage(m: {
  t?: string | null;
  sticker?: unknown;
  files?: { _id: string; name: string; type: string }[] | null;
  attachments?: { type?: string; image_url?: string }[] | null;
}): { fileId: string; url: string; name: string } | null {
  if (m.t || m.sticker) return null;
  for (const f of m.files ?? []) {
    if (!STICKER_SOURCE_TYPES.includes(f.type)) continue;
    const a = (m.attachments ?? []).find((x) => x.type === 'file' && FILE_UPLOAD_SOURCE_RE.exec(x.image_url ?? '')?.[1] === f._id);
    if (a?.image_url) return { fileId: f._id, url: a.image_url, name: f.name };
  }
  return null;
}

// ---------- Seletor ----------

const byTime = (s: string) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
};

function packPick(pack: StickerPack, s: StickerItem, source: 'org' | 'personal', editable: boolean): StickerPick {
  return {
    key: `${source === 'org' ? 'org' : 'mine'}:${pack._id}:${s.fileId}`,
    fileId: s.fileId,
    stickerId: s._id,
    packId: pack._id,
    packName: pack.name,
    name: s.name,
    emojis: s.emojis,
    keywords: s.keywords,
    mime: s.mime,
    url: s.url,
    posterUrl: s.posterUrl,
    width: s.width,
    height: s.height,
    animated: s.animated,
    durationMs: s.durationMs,
    scope: source === 'org' ? 'org' : 'personal',
    source,
    editable,
  };
}

function userPick(it: StickerUserItem, keywords: string[]): StickerPick {
  return {
    key: `${it.kind === 'favorite' ? 'fav' : 'rec'}:${it.fileId}`,
    fileId: it.fileId,
    stickerId: it.stickerId,
    packId: it.packId,
    packName: it.packName,
    name: it.name,
    emojis: it.emojis,
    keywords,
    mime: it.mime,
    url: it.url,
    posterUrl: it.posterUrl,
    width: it.width,
    height: it.height,
    animated: it.animated,
    durationMs: it.durationMs,
    scope: it.scope,
    source: it.kind,
    editable: false,
  };
}

function sortedPacks(packs: StickerPack[]): StickerPack[] {
  return [...packs].sort((a, b) => a.sort - b.sort);
}

function sortedStickers(list: StickerItem[]): StickerItem[] {
  return [...list].sort((a, b) => a.sort - b.sort || byTime(a.createdAt) - byTime(b.createdAt));
}

// Seções na ordem do seletor. Pacotes vazios e arquivos em `removed` ficam de fora; rascunhos nunca chegam aqui.
export function buildPickerSections(
  org: StickerCatalogOrg | null,
  mine: StickerCatalogMine | null,
  opts: { canManage: boolean; removed: ReadonlySet<string> },
): PickerSections {
  const live = (fileId: string) => !opts.removed.has(fileId);
  const group = (packs: StickerPack[], source: 'org' | 'personal', editable: boolean) =>
    sortedPacks(packs)
      .map((pack) => ({ pack, picks: sortedStickers(pack.stickers).filter((s) => live(s.fileId)).map((s) => packPick(pack, s, source, editable)) }))
      .filter((g) => g.picks.length > 0);
  const orgGroups = group((org?.packs ?? []).filter((p) => p.status === 'published'), 'org', opts.canManage);
  const personalGroups = group(mine?.packs ?? [], 'personal', true);
  // Favoritas e recentes não têm palavras-chave próprias: herdam as da figurinha visível de mesmo id.
  const keywordsById = new Map<string, string[]>();
  for (const g of [...orgGroups, ...personalGroups]) for (const p of g.picks) if (p.stickerId) keywordsById.set(p.stickerId, p.keywords);
  const users = (list: StickerUserItem[]) =>
    [...list]
      .filter((it) => live(it.fileId))
      .sort((a, b) => byTime(b.usedAt) - byTime(a.usedAt))
      .map((it) => userPick(it, (it.stickerId && keywordsById.get(it.stickerId)) || []));
  return {
    favorites: users(mine?.favorites ?? []),
    recents: users(mine?.recents ?? []),
    org: orgGroups,
    personal: personalGroups,
  };
}

function orderedPicks(sections: PickerSections): StickerPick[] {
  return [...sections.favorites, ...sections.recents, ...sections.org.flatMap((g) => g.picks), ...sections.personal.flatMap((g) => g.picks)];
}

// Uma vez por arquivo: vale a primeira célula que combina, na ordem do seletor.
function rankPicks(sections: PickerSections, query: string, limit: number): StickerPick[] {
  const seen = new Set<string>();
  const hits: { pick: StickerPick; score: number; i: number }[] = [];
  orderedPicks(sections).forEach((pick, i) => {
    if (seen.has(pick.fileId)) return;
    const score = stickerScore(pick, query);
    if (!score) return;
    seen.add(pick.fileId);
    hits.push({ pick, score, i });
  });
  return hits
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map((h) => h.pick);
}

// Busca: ":código:" vira o emoji (toUnicode); uma figurinha aparece uma vez (a primeira na ordem favoritas,
// recentes, organização, pessoais); ordena por stickerScore e, no empate, por essa ordem. Padrão 60.
export function rankStickers(sections: PickerSections, query: string, toUnicode: (code: string) => string | null, limit = 60): StickerPick[] {
  return rankPicks(sections, composerEmoji(query, toUnicode) ?? query, limit);
}

// Sugestões para um emoji: mesma ordem e mesma regra de uma vez só. Padrão 8.
export function stickersForEmoji(sections: PickerSections, emoji: string, limit = 8): StickerPick[] {
  const e = singleEmoji(emoji);
  return e ? rankPicks(sections, e, limit) : [];
}

// ---------- Hash perceptual (dHash de 64 bits, em hex; calculado em shared/src/stickerEdit.ts) ----------

export const PHASH_RE = /^[0-9a-f]{16}$/;
export const phashToDb = (hex: string) => BigInt.asIntN(64, BigInt(`0x${hex}`)).toString(); // bigint com sinal no Postgres
export const phashFromDb = (v: string | null | undefined) => (v == null ? null : BigInt.asUintN(64, BigInt(v)).toString(16).padStart(16, '0'));

const phashValue = (hex: string) => {
  if (!PHASH_RE.test(hex)) throw new Error(`hash perceptual inválido: ${hex}`);
  return BigInt(`0x${hex}`);
};

function popcount64(x: bigint): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    let w = Number((x >> BigInt(i * 16)) & 0xffffn);
    while (w) {
      w &= w - 1;
      n++;
    }
  }
  return n;
}

export function phashBits(hex: string): number {
  return popcount64(phashValue(hex));
}

export function phashDistance(a: string, b: string): number {
  return popcount64(phashValue(a) ^ phashValue(b));
}

// Quase igual: distância ≤ 6, proporção parecida (10 %) e nenhuma das duas lisa demais para comparar.
export function similarSticker(a: { phash: string | null; width: number; height: number }, b: { phash: string | null; width: number; height: number }): boolean {
  if (!a.phash || !b.phash) return false;
  const comparable = (h: string) => phashBits(h) >= STICKER_LIMITS.phashMinBits && phashBits(h) <= 64 - STICKER_LIMITS.phashMinBits;
  if (!comparable(a.phash) || !comparable(b.phash)) return false;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  if (Math.abs(ra - rb) / Math.max(ra, rb) > STICKER_LIMITS.phashAspectTolerance) return false;
  return phashDistance(a.phash, b.phash) <= STICKER_LIMITS.phashMaxDistance;
}

// ---------- URLs ----------

export const stickerExt = (mime: string) => (mime === 'image/gif' ? 'gif' : mime === 'image/png' ? 'png' : 'webp');
export const stickerUrl = (fileId: string, mime: string) => `/sticker/${fileId}.${stickerExt(mime)}`;
export const stickerPosterUrl = (fileId: string, posterMime: string) => `/sticker/${fileId}/poster.${stickerExt(posterMime)}`;
export const STICKER_PATH_RE = /^([A-Za-z0-9]{10,24})\.(webp|png|gif)$/;
