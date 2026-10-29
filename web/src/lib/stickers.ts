// Estado e chamadas das figurinhas. Contrato fixo: o stkstudio usa estas funções.
import { useMemo } from 'react';
import { create } from 'zustand';
import type { Message, Room, ServerEvent } from '@shared/index';
import {
  buildPickerSections,
  composerEmoji,
  rankStickers,
  rolesBlockedFromSending,
  STICKER_LIMITS,
  sendBlockedReason,
  stickersAllowedIn,
  stickersForEmoji,
  type BlockedStickerFile,
  type MessageSticker,
  type PickerSections,
  type StickerCatalogMine,
  type StickerCatalogOrg,
  type StickerCatalogUnchanged,
  type StickerItem,
  type StickerMime,
  type StickerPack,
  type StickerPick,
  type StickerScope,
  type StickerSendPolicy,
  type StickerUsage,
  type StickerUserItem,
} from '@shared/stickers';
import { api, ApiError, getCredentials } from './api';
import { EMOJI } from './emoji';
import { useStore } from './store';

export interface StickerCaps {
  on: boolean; // Stickers_Enabled (acréscimo ao contrato). Desligado, o servidor só atende o gestor: quem cria ou usa olha também isto
  enabled: boolean; // Stickers_Enabled e nenhum papel meu em Stickers_Send_Blocked_Roles
  canCreate: boolean; // create-personal-stickers + Stickers_Personal_Enabled + FileUpload_Enabled
  canManage: boolean; // manage-sticker-packs (curadoria; não é moderação)
  canModerate: boolean; // manage-moderation-actions
  canViewRemoved: boolean; // view-moderation-console ou manage-moderation-actions
  canAuthor: boolean; // canCreate || canManage: o editor abre (o gestor cria nos pacotes da organização)
  noticeRooms: boolean; // Stickers_In_Notice_Rooms
  animationDefault: 'auto' | 'hover' | 'never'; // Stickers_Animation_Default
  policy: StickerSendPolicy;
  limits: { staticKB: number; animatedKB: number; animatedSeconds: number; maxFavorites: number; maxPacks: number; maxPerPack: number; orgMaxPerPack: number; quotaMB: number };
}

// ---------- Permissões e configurações ----------

const NONE: string[] = [];
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const anim = (v: unknown): 'auto' | 'hover' | 'never' => (v === 'auto' || v === 'never' ? v : 'hover');

function capsFrom(s: Record<string, any>, roles: string[], perms: string[]): StickerCaps {
  const on = !!s.Stickers_Enabled;
  // canCreate é só a permissão (a Conta diz "Seu perfil não cria" por ele). Função desligada é o "on".
  const canCreate = perms.includes('create-personal-stickers') && !!s.Stickers_Personal_Enabled && !!s.FileUpload_Enabled;
  const canManage = perms.includes('manage-sticker-packs');
  const canModerate = perms.includes('manage-moderation-actions');
  return {
    on,
    enabled: on && !rolesBlockedFromSending(roles, String(s.Stickers_Send_Blocked_Roles ?? '')),
    canCreate,
    canManage,
    canModerate,
    canViewRemoved: canModerate || perms.includes('view-moderation-console'),
    canAuthor: canCreate || canManage,
    noticeRooms: !!s.Stickers_In_Notice_Rooms,
    animationDefault: anim(s.Stickers_Animation_Default),
    policy: {
      personalEnabled: !!s.Stickers_Personal_Enabled,
      animatedEnabled: !!s.Stickers_Animated_Enabled,
      uploadsEnabled: !!s.FileUpload_Enabled,
      uploadsInDirect: s.FileUpload_Enabled_Direct !== false,
      whiteList: String(s.FileUpload_MediaTypeWhiteList ?? ''),
      blackList: String(s.FileUpload_MediaTypeBlackList ?? ''),
    },
    limits: {
      staticKB: num(s.Stickers_Max_Static_KB, 256),
      animatedKB: num(s.Stickers_Max_Animated_KB, 1024),
      animatedSeconds: num(s.Stickers_Max_Animated_Seconds, 10),
      maxFavorites: num(s.Stickers_Max_Favorites, 50),
      maxPacks: num(s.Stickers_Personal_Max_Packs, 5),
      maxPerPack: num(s.Stickers_Personal_Max_Per_Pack, 60),
      orgMaxPerPack: num(s.Stickers_Org_Max_Per_Pack, 120),
      quotaMB: num(s.Stickers_Personal_Quota_MB, 20),
    },
  };
}

let capsCache: { settings: unknown; roles: unknown; perms: unknown; caps: StickerCaps } | null = null;

export function stickerCaps(): StickerCaps {
  const st = useStore.getState();
  const roles = st.me?.roles ?? NONE;
  const perms = st.me?.permissions ?? NONE;
  const c = capsCache;
  if (c && c.settings === st.settings && c.roles === roles && c.perms === perms) return c.caps;
  const caps = capsFrom(st.settings, roles, perms);
  capsCache = { settings: st.settings, roles, perms, caps };
  return caps;
}

export function useStickerCaps(): StickerCaps {
  const settings = useStore((s) => s.settings);
  const roles = useStore((s) => s.me?.roles ?? NONE);
  const perms = useStore((s) => s.me?.permissions ?? NONE);
  return useMemo(() => capsFrom(settings, roles, perms), [settings, roles, perms]);
}

// Onde a aba Figurinhas e as sugestões aparecem: caps.enabled e stickersAllowedIn (aviso só com a configuração).
export function stickersHere(room: Pick<Room, 't' | 'notice'> | null | undefined): boolean {
  const caps = stickerCaps();
  return caps.enabled && stickersAllowedIn(room, { noticeRooms: caps.noticeRooms });
}

// sendBlockedReason de @shared/stickers com a política atual. null = pode enviar aqui.
export function blockedReasonHere(p: Pick<StickerPick, 'scope' | 'mime' | 'animated'>, room: Pick<Room, 't'> | null | undefined): string | null {
  return sendBlockedReason(p, room, stickerCaps().policy);
}

// Mostra "Remover de todas as conversas": moderação sempre; gestor só para figurinha da organização (o servidor decide no fim).
export function canRemoveEverywhere(s: MessageSticker): boolean {
  const caps = stickerCaps();
  if (caps.canModerate) return true;
  return caps.canManage && !s.removed && s.scope === 'org';
}

// ":+1:" -> "👍" pelo mapa da web; emoji personalizado dá null.
export const toUnicode = (code: string): string | null => EMOJI[code.replace(/^:|:$/g, '')] ?? null;

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';

// Id de mensagem gerado no cliente: 17 caracteres do mesmo alfabeto de server/src/lib/ids.ts.
export function clientMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

// ---------- Estado ----------

export interface StickersState {
  userId: string | null;
  org: StickerCatalogOrg | null;
  mine: StickerCatalogMine | null;
  sections: PickerSections; // buildPickerSections(org, mine, …), recalculado a cada mudança
  status: { org: 'idle' | 'loading' | 'ready' | 'error'; mine: 'idle' | 'loading' | 'ready' | 'error' };
  stale: { org: boolean; mine: boolean };
  removed: ReadonlySet<string>; // fileIds removidos (evento sticker.removed)
  favorites: ReadonlySet<string>; // fileIds, derivado de mine.favorites
  pickerOpen: boolean;
  // "Ver no seletor". rid e tmid (acréscimo ao contrato) dizem qual compositor abre; sem rid, o da sala.
  pickerRequest: { packId?: string; seq: number; rid?: string; tmid?: string | null } | null;
  lastTab: 'emoji' | 'stickers';
  importing: boolean; // durante uma importação, eventos só marcam "desatualizado"
}

const EMPTY_SECTIONS: PickerSections = { favorites: [], recents: [], org: [], personal: [] };
const EMPTY_SET: ReadonlySet<string> = new Set();
const KEY_PREFIX = 'wescc.stickers.';
const TAB_KEY = 'wescc.stickers.tab';
const cacheKey = (scope: 'org' | 'mine', userId: string) => `${KEY_PREFIX}${scope}.v1.${userId}`;
const CACHE_MAX = 1_000_000; // caracteres (~1 MB): catálogo maior não vai para o navegador

function readTab(): 'emoji' | 'stickers' {
  try {
    return localStorage.getItem(TAB_KEY) === 'stickers' ? 'stickers' : 'emoji';
  } catch {
    return 'emoji';
  }
}

function initialState(): StickersState {
  return {
    userId: null,
    org: null,
    mine: null,
    sections: EMPTY_SECTIONS,
    status: { org: 'idle', mine: 'idle' },
    stale: { org: false, mine: false },
    removed: EMPTY_SET,
    favorites: EMPTY_SET,
    pickerOpen: false,
    pickerRequest: null,
    lastTab: readTab(),
    importing: false,
  };
}

export const useStickers = create<StickersState>()(() => initialState());

const favoritesOf = (mine: StickerCatalogMine | null): ReadonlySet<string> => (mine?.favorites.length ? new Set(mine.favorites.map((f) => f.fileId)) : EMPTY_SET);

// Recalcula as seções e o conjunto de favoritas a partir dos catálogos (chamado a cada mudança).
function commit(patch: Partial<StickersState>) {
  const cur = useStickers.getState();
  const next = { ...cur, ...patch };
  const sections =
    next.org || next.mine ? buildPickerSections(next.org, next.mine, { canManage: stickerCaps().canManage, removed: next.removed }) : EMPTY_SECTIONS;
  useStickers.setState({ ...patch, sections, favorites: favoritesOf(next.mine) });
}

function readCache<T extends { userId: string }>(scope: 'org' | 'mine', userId: string): T | null {
  try {
    const raw = localStorage.getItem(cacheKey(scope, userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as T;
    return v && typeof v === 'object' && v.userId === userId ? v : null;
  } catch {
    return null;
  }
}

function writeCache(scope: 'org' | 'mine', cat: StickerCatalogOrg | StickerCatalogMine | null) {
  const userId = useStickers.getState().userId;
  if (!userId || !cat || cat.userId !== userId) return;
  try {
    const raw = JSON.stringify(cat);
    if (raw.length > CACHE_MAX) localStorage.removeItem(cacheKey(scope, userId));
    else localStorage.setItem(cacheKey(scope, userId), raw);
  } catch {
    // sem armazenamento: tudo funciona, só busca mais
  }
}

// lê o cache local deste usuário; não chama a rede
export function initStickers(userId: string): void {
  const cur = useStickers.getState();
  if (cur.userId && cur.userId !== userId) resetStickers();
  // Sessão que caiu sem endSession (socket derrubado): os catálogos de outra pessoa não ficam no navegador.
  try {
    const mineKeys = [cacheKey('org', userId), cacheKey('mine', userId)];
    for (const k of Object.keys(localStorage)) if (k.startsWith(KEY_PREFIX) && k !== TAB_KEY && !mineKeys.includes(k)) localStorage.removeItem(k);
  } catch {
    // armazenamento indisponível
  }
  const org = readCache<StickerCatalogOrg>('org', userId);
  const mine = readCache<StickerCatalogMine>('mine', userId);
  useStickers.setState({ userId });
  commit({ org, mine });
}

const loading: { org: Promise<void> | null; mine: Promise<void> | null } = { org: null, mine: null };
let generation = 0; // um reset invalida as respostas que ainda estão a caminho

// zera o estado e apaga todas as chaves wescc.stickers.* do navegador
export function resetStickers(): void {
  generation++;
  loading.org = null;
  loading.mine = null;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(KEY_PREFIX)) localStorage.removeItem(k);
  } catch {
    // armazenamento indisponível
  }
  useStickers.setState({ ...initialState(), lastTab: 'emoji' });
}

function loadScope(scope: 'org' | 'mine'): Promise<void> {
  if (loading[scope]) return loading[scope]!;
  const gen = generation;
  const st = useStickers.getState();
  const userId = st.userId ?? useStore.getState().me?._id ?? null;
  if (!userId) return Promise.resolve();
  if (!st.userId) useStickers.setState({ userId });
  const version = st[scope]?.version;
  // Revalidar um catálogo pronto não volta a "carregando": os itens que dependem dele não piscam.
  if (st.status[scope] !== 'ready') useStickers.setState({ status: { ...st.status, [scope]: 'loading' } });
  const p = (async () => {
    try {
      const r = await api.get<StickerCatalogOrg | StickerCatalogMine | StickerCatalogUnchanged>('stickers.list', { scope, version });
      if (gen !== generation) return;
      const now = useStickers.getState();
      if ('unchanged' in r && r.unchanged) {
        if (now[scope]?.version !== r.version) {
          // O cache mudou enquanto a resposta vinha: busca de novo sem versão na próxima vez.
          useStickers.setState({ status: { ...now.status, [scope]: 'idle' } });
          return;
        }
        useStickers.setState({ status: { ...now.status, [scope]: 'ready' }, stale: { ...now.stale, [scope]: false } });
        return;
      }
      const cat = r as StickerCatalogOrg | StickerCatalogMine;
      if (cat.userId !== now.userId) {
        useStickers.setState({ status: { ...now.status, [scope]: 'idle' } });
        return;
      }
      // Um arquivo removido agora há pouco pode vir num catálogo montado antes da remoção.
      const clean = now.removed.size ? dropFiles(cat, now.removed) : cat;
      commit({ [scope]: clean, status: { ...now.status, [scope]: 'ready' }, stale: { ...now.stale, [scope]: false } } as Partial<StickersState>);
      writeCache(scope, clean);
    } catch {
      if (gen !== generation) return;
      const now = useStickers.getState();
      // Falha ao revalidar: fica o que já estava pronto, marcado como desatualizado.
      if (now.status[scope] === 'ready') useStickers.setState({ stale: { ...now.stale, [scope]: true } });
      else useStickers.setState({ status: { ...now.status, [scope]: 'error' } });
    } finally {
      if (gen === generation) loading[scope] = null;
    }
  })();
  loading[scope] = p;
  return p;
}

// revalidate: confere a versão mesmo com o catálogo pronto (os recentes mudam sem evento, §3.14).
export function loadStickers(scope: 'org' | 'mine' | 'both' = 'both', opts: { force?: boolean; revalidate?: boolean } = {}): Promise<void> {
  const scopes: ('org' | 'mine')[] = scope === 'both' ? ['org', 'mine'] : [scope];
  const st = useStickers.getState();
  const jobs = scopes.map((s) => {
    if (!opts.force && !opts.revalidate && st.status[s] === 'ready' && !st.stale[s]) return Promise.resolve();
    // Pedido forçado com uma carga em andamento: espera e carrega de novo (a mudança pode ter vindo depois).
    if (opts.force && loading[s]) return loading[s]!.then(() => loadScope(s));
    return loadScope(s);
  });
  return Promise.all(jobs).then(() => undefined);
}

export function invalidateStickers(scope: 'org' | 'mine'): void {
  const st = useStickers.getState();
  useStickers.setState({ stale: { ...st.stale, [scope]: true } });
  if (st.pickerOpen && !st.importing) void loadStickers(scope);
}

function dropFiles<T extends StickerCatalogOrg | StickerCatalogMine>(cat: T, files: ReadonlySet<string>): T {
  const packs = cat.packs.map((p) => {
    const stickers = p.stickers.filter((s) => !files.has(s.fileId));
    return stickers.length === p.stickers.length ? p : { ...p, stickers, count: stickers.length };
  });
  if (cat.scope === 'mine') {
    const m = cat as StickerCatalogMine;
    return { ...m, packs, favorites: m.favorites.filter((f) => !files.has(f.fileId)), recents: m.recents.filter((f) => !files.has(f.fileId)) } as T;
  }
  return { ...cat, packs };
}

export function handleStickerEvent(ev: ServerEvent): void {
  if (ev.type === 'stickers.changed') invalidateStickers(ev.scope);
  else if (ev.type === 'sticker.removed') {
    const st = useStickers.getState();
    if (st.removed.has(ev.fileId)) return;
    const removed = new Set(st.removed);
    removed.add(ev.fileId);
    const gone = new Set([ev.fileId]);
    const org = st.org ? dropFiles(st.org, gone) : null;
    const mine = st.mine ? dropFiles(st.mine, gone) : null;
    commit({ removed, org, mine });
    writeCache('org', org);
    writeCache('mine', mine);
  }
}

export function setPickerOpen(open: boolean): void {
  useStickers.setState({ pickerOpen: open });
  // Cada abertura confere a versão: é assim que os recentes de outro aparelho chegam.
  if (open) void loadStickers('both', { revalidate: true });
}

export function setLastTab(tab: 'emoji' | 'stickers'): void {
  useStickers.setState({ lastTab: tab });
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // armazenamento indisponível
  }
}

// at (acréscimo ao contrato): o compositor de qual sala ou tópico abre; sem ele, o da sala atual.
export function openStickerPicker(packId?: string, at?: { rid: string; tmid?: string | null }): void {
  const seq = (useStickers.getState().pickerRequest?.seq ?? 0) + 1;
  useStickers.setState({ pickerRequest: { packId, seq, rid: at?.rid, tmid: at?.tmid ?? null } });
}

// ---------- Compositores abertos (acréscimo ao contrato) ----------

// Quem mostra "Ver no seletor" ou "Salvar e enviar" precisa saber se o compositor daquela sala está ativo agora.
const composers = new Map<string, number>();
const composerKey = (rid: string, tmid?: string | null) => `${rid}:${tmid ?? ''}`;

export function registerComposer(rid: string, tmid?: string | null): () => void {
  const k = composerKey(rid, tmid);
  composers.set(k, (composers.get(k) ?? 0) + 1);
  return () => {
    const n = (composers.get(k) ?? 1) - 1;
    if (n > 0) composers.set(k, n);
    else composers.delete(k);
  };
}

export function isComposerOpen(rid: string, tmid?: string | null): boolean {
  return composers.has(composerKey(rid, tmid));
}

// ---------- Leitura ----------

// rankStickers(sections, query, toUnicode), padrão 60
export function searchStickers(query: string, limit = 60): StickerPick[] {
  return rankStickers(useStickers.getState().sections, query, toUnicode, limit);
}

export function suggestionsFor(text: string, room: Pick<Room, 't' | 'notice'> | null | undefined): { emoji: string; picks: StickerPick[] } | null {
  if (!stickersHere(room)) return null;
  if (useStore.getState().me?.preferences?.stickerSuggestions === false) return null;
  const emoji = composerEmoji(text, toUnicode);
  if (!emoji) return null;
  const picks = stickersForEmoji(useStickers.getState().sections, emoji, 8).filter((p) => blockedReasonHere(p, room) === null);
  return picks.length ? { emoji, picks } : null;
}

// da organização e o pacote não está no meu catálogo
export function isRestrictedForMe(s: MessageSticker): boolean {
  if (s.removed || s.scope !== 'org' || !s.packId) return false;
  const org = useStickers.getState().org;
  if (!org) return false;
  return !org.packs.some((p) => p._id === s.packId);
}

export function isFavorite(fileId: string): boolean {
  return useStickers.getState().favorites.has(fileId);
}

const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export function effectiveAnimation(): 'auto' | 'hover' | 'never' {
  const pref = useStore.getState().me?.preferences?.stickerAnimation;
  if (pref === 'auto' || pref === 'hover' || pref === 'never') return pref;
  if (reducedMotion()) return 'never';
  return stickerCaps().animationDefault;
}

// Message_AllowDeleting e delete-own-message (ou delete-message)
export function canUndoSend(): boolean {
  const st = useStore.getState();
  const perms = st.me?.permissions ?? NONE;
  return st.settings.Message_AllowDeleting !== false && (perms.includes('delete-own-message') || perms.includes('delete-message'));
}

// ---------- Envio ----------

const mimeFromUrl = (url: string): StickerMime => (/\.gif(\?|$)/.test(url) ? 'image/gif' : /\.png(\?|$)/.test(url) ? 'image/png' : 'image/webp');
const isNetworkError = (e: unknown) => !(e instanceof ApiError) || e.status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A figurinha enviada sobe para o topo das recentes já aqui; o servidor confirma na próxima abertura do seletor.
function pushRecentLocal(m: Message, input: { stickerId?: string; fileId?: string }) {
  const s = m.sticker;
  const st = useStickers.getState();
  if (!s || s.removed || !st.mine) return;
  const all = [...st.sections.favorites, ...st.sections.recents, ...st.sections.org.flatMap((g) => g.picks), ...st.sections.personal.flatMap((g) => g.picks)];
  const pick = all.find((p) => (input.stickerId && p.stickerId === input.stickerId) || p.fileId === s.fileId);
  const prev = st.mine.recents.find((r) => r.fileId === s.fileId);
  const item: StickerUserItem = {
    fileId: s.fileId,
    mime: (pick?.mime as StickerMime | undefined) ?? prev?.mime ?? mimeFromUrl(s.url),
    width: s.width,
    height: s.height,
    size: prev?.size ?? 0,
    animated: s.animated,
    frames: prev?.frames ?? 1,
    durationMs: s.durationMs,
    url: s.url,
    posterUrl: s.posterUrl,
    kind: 'recent',
    stickerId: s.stickerId ?? pick?.stickerId,
    packId: s.packId,
    packName: s.packName,
    name: s.name,
    emojis: s.emojis,
    scope: s.scope,
    usedAt: new Date().toISOString(),
  };
  const recents = [item, ...st.mine.recents.filter((r) => r.fileId !== s.fileId)].slice(0, STICKER_LIMITS.recents);
  const mine = { ...st.mine, recents };
  commit({ mine });
  writeCache('mine', mine);
}

export async function sendSticker(input: {
  rid: string;
  tmid?: string | null;
  tshow?: boolean;
  quoteMessageId?: string;
  stickerId?: string;
  fileId?: string;
  _id?: string;
}): Promise<Message> {
  const _id = input._id ?? clientMessageId();
  const body = {
    roomId: input.rid,
    stickerId: input.stickerId,
    fileId: input.stickerId ? undefined : input.fileId,
    tmid: input.tmid ?? undefined,
    tshow: input.tmid ? input.tshow || undefined : undefined,
    quoteMessageId: input.quoteMessageId,
    _id,
  };
  let r: { message: Message };
  try {
    r = await api.post<{ message: Message }>('chat.sendSticker', body);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    // Sem resposta: tenta uma vez com o mesmo _id; se a primeira chegou, o servidor devolve a mesma mensagem.
    await sleep(1000);
    r = await api.post<{ message: Message }>('chat.sendSticker', body);
  }
  useStore.getState().upsertMessage(r.message);
  pushRecentLocal(r.message, input);
  return r.message;
}

// chat.delete, a mesma regra de apagar de sempre
export async function undoSend(message: Message): Promise<void> {
  await api.post('chat.delete', { msgId: message._id, roomId: message.rid });
}

// ---------- Favoritas, salvar, recentes ----------

function fileOfMessage(messageId: string): string | null {
  const st = useStore.getState();
  for (const room of Object.values(st.messages)) {
    const m = room.list.find((x) => x._id === messageId);
    if (m?.sticker) return m.sticker.fileId;
  }
  for (const list of Object.values(st.threads)) {
    const m = list.find((x) => x._id === messageId);
    if (m?.sticker) return m.sticker.fileId;
  }
  return null;
}

const oneTarget = (t: { fileId?: string; stickerId?: string; messageId?: string }) =>
  t.messageId ? { messageId: t.messageId } : t.stickerId ? { stickerId: t.stickerId } : { fileId: t.fileId };

export async function setFavorite(target: { fileId?: string; stickerId?: string; messageId?: string }, favorite: boolean): Promise<void> {
  const fileId =
    target.fileId ??
    (target.messageId ? fileOfMessage(target.messageId) : null) ??
    (target.stickerId ? [...useStickers.getState().sections.org, ...useStickers.getState().sections.personal].flatMap((g) => g.picks).find((p) => p.stickerId === target.stickerId)?.fileId : null) ??
    null;
  const before = useStickers.getState().favorites;
  if (fileId) {
    const next = new Set(before);
    if (favorite) next.add(fileId);
    else next.delete(fileId);
    useStickers.setState({ favorites: next });
  }
  try {
    await api.post('stickers.favorite', { ...oneTarget(target), favorite });
  } catch (e) {
    if (fileId) useStickers.setState({ favorites: before });
    throw e;
  }
  await loadStickers('mine', { force: true });
}

// Pacote da organização (no catálogo) ou pessoal: qual catálogo recarregar depois de uma mudança nele.
function scopeOfPack(packId: string | undefined): 'org' | 'mine' {
  if (!packId) return 'mine';
  const st = useStickers.getState();
  if (st.mine?.packs.some((p) => p._id === packId)) return 'mine';
  return 'org';
}

export async function saveSticker(
  target: { messageId?: string; stickerId?: string; fileId?: string },
  opts: { packId?: string; name?: string; emojis?: string[]; keywords?: string[] } = {},
): Promise<StickerItem> {
  const r = await api.post<{ sticker: StickerItem }>('stickers.save', { ...oneTarget(target), ...opts });
  await loadStickers(scopeOfPack(opts.packId), { force: true });
  return r.sticker;
}

export async function removeRecent(fileId: string): Promise<void> {
  await api.post('stickers.recents.remove', { fileId });
  const st = useStickers.getState();
  if (st.mine) {
    const mine = { ...st.mine, recents: st.mine.recents.filter((r) => r.fileId !== fileId) };
    commit({ mine });
    writeCache('mine', mine);
  }
  await loadStickers('mine', { force: true });
}

export async function clearRecents(): Promise<void> {
  await api.post('stickers.recents.clear');
  const st = useStickers.getState();
  if (st.mine) commit({ mine: { ...st.mine, recents: [] } });
  await loadStickers('mine', { force: true });
}

// ---------- Criar ----------

const extOf = (type: string) => (type === 'image/gif' ? 'gif' : type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp');

export async function createSticker(
  input: { file: Blob; poster?: Blob; packId?: string; name: string; emojis: string[]; keywords: string[]; phash?: string; sourceMessageId?: string; batch?: boolean },
  opts: { reload?: boolean } = {}, // padrão true; a importação passa false e chama finishStickerImport no fim
): Promise<StickerItem> {
  // O servidor lê o multipart em ordem: os campos antes dos arquivos.
  const fd = new FormData();
  if (input.packId) fd.append('packId', input.packId);
  fd.append('name', input.name);
  fd.append('emojis', JSON.stringify(input.emojis));
  fd.append('keywords', JSON.stringify(input.keywords));
  if (input.phash) fd.append('phash', input.phash);
  if (input.sourceMessageId) fd.append('sourceMessageId', input.sourceMessageId);
  if (input.batch) fd.append('batch', '1');
  fd.append('file', input.file, `figurinha.${extOf(input.file.type)}`);
  if (input.poster) fd.append('poster', input.poster, `poster.${extOf(input.poster.type)}`);
  const r = await api.post<{ sticker: StickerItem }>('stickers.create', fd);
  if (opts.reload !== false) await loadStickers(scopeOfPack(input.packId), { force: true });
  return r.sticker;
}

// POST stickers.import.done e recarrega
export async function finishStickerImport(scope: 'org' | 'mine'): Promise<void> {
  try {
    await api.post('stickers.import.done', { scope });
  } finally {
    useStickers.setState({ importing: false });
    await loadStickers(scope, { force: true });
  }
}

export async function setStickerPrefs(p: { stickerAnimation?: 'system' | 'auto' | 'hover' | 'never'; stickerSuggestions?: boolean; stickerTabSeen?: boolean; stickerHintSeen?: boolean }): Promise<void> {
  const st = useStore.getState();
  const me = st.me;
  if (!me) return;
  const before = me.preferences;
  st.setMe({ ...me, preferences: { ...me.preferences, ...p } });
  try {
    await api.post('users.setPreferences', { data: p });
  } catch (e) {
    const now = useStore.getState().me;
    if (now) useStore.getState().setMe({ ...now, preferences: before });
    throw e;
  }
}

// ---------- Administração ----------

const slugOf = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pacote';

const EXPORT_ERROR = 'Não foi possível baixar o pacote. Se o download não começar, a rede da empresa pode estar bloqueando arquivos .zip.';

async function afterAdmin<T>(p: Promise<T>): Promise<T> {
  const r = await p;
  await loadStickers('both', { force: true });
  return r;
}

export const stickerAdmin: {
  createPack(input: { scope: StickerScope; name: string; description?: string; status?: 'draft' | 'published'; visibleRoles?: string[] }): Promise<StickerPack>;
  updatePack(input: { packId: string; name?: string; description?: string; status?: 'draft' | 'published'; visibleRoles?: string[]; coverStickerId?: string }): Promise<StickerPack>;
  deletePack(packId: string): Promise<void>;
  reorderPacks(scope: StickerScope, packIds: string[]): Promise<void>;
  packInfo(packId: string): Promise<StickerPack>;
  updateSticker(input: { stickerId: string; name?: string; emojis?: string[]; keywords?: string[] }): Promise<StickerItem>;
  deleteSticker(stickerId: string): Promise<void>;
  reorderStickers(packId: string, stickerIds: string[]): Promise<void>;
  moveSticker(stickerId: string, packId: string): Promise<StickerItem>;
  orgWithDrafts(): Promise<StickerCatalogOrg>;
  removeEverywhere(target: { fileId?: string; messageId?: string }, reason?: string): Promise<{ messages: number; packs: number; users: number; alreadyRemoved?: true }>;
  usage(target: { fileId?: string; messageId?: string }): Promise<StickerUsage>;
  blockedList(params: { text?: string; offset: number; count: number }): Promise<{ files: BlockedStickerFile[]; total: number }>;
  unblock(fileId: string): Promise<void>;
  quarantineUrl(f: Pick<BlockedStickerFile, 'fileId' | 'mime'>): string; // /sticker/<id>.<ext>?q=1
  exportPack(packId: string, fileName: string): Promise<void>; // fetch -> blob -> a[download]
} = {
  createPack: (input) => afterAdmin(api.post<{ pack: StickerPack }>('stickers.packs.create', input)).then((r) => r.pack),
  updatePack: (input) => afterAdmin(api.post<{ pack: StickerPack }>('stickers.packs.update', input)).then((r) => r.pack),
  deletePack: (packId) => afterAdmin(api.post('stickers.packs.delete', { packId })).then(() => undefined),
  reorderPacks: (scope, packIds) => afterAdmin(api.post('stickers.packs.reorder', { scope, packIds })).then(() => undefined),
  packInfo: (packId) => api.get<{ pack: StickerPack }>('stickers.packs.info', { packId }).then((r) => r.pack),
  updateSticker: (input) => afterAdmin(api.post<{ sticker: StickerItem }>('stickers.update', input)).then((r) => r.sticker),
  deleteSticker: (stickerId) => afterAdmin(api.post('stickers.delete', { stickerId })).then(() => undefined),
  reorderStickers: (packId, stickerIds) => afterAdmin(api.post('stickers.reorder', { packId, stickerIds })).then(() => undefined),
  moveSticker: (stickerId, packId) => afterAdmin(api.post<{ sticker: StickerItem }>('stickers.move', { stickerId, packId })).then((r) => r.sticker),
  // Rascunhos têm versão própria no servidor: não passam pelo cache do seletor.
  orgWithDrafts: () => api.get<StickerCatalogOrg>('stickers.list', { scope: 'org', includeDrafts: true }),
  removeEverywhere: async (target, reason) => {
    const r = await api.post<{ messages: number; packs: number; users: number; alreadyRemoved?: true }>('stickers.removeEverywhere', {
      ...(target.messageId ? { messageId: target.messageId } : { fileId: target.fileId }),
      reason: reason || undefined,
    });
    await loadStickers('both', { force: true });
    return r;
  },
  usage: (target) => api.get<{ usage: StickerUsage }>('stickers.usage', target.messageId ? { messageId: target.messageId } : { fileId: target.fileId }).then((r) => r.usage),
  blockedList: (params) => api.get<{ files: BlockedStickerFile[]; total: number }>('stickers.blocked.list', params).then((r) => ({ files: r.files, total: r.total })),
  unblock: (fileId) => api.post('stickers.blocked.unblock', { fileId }).then(() => undefined),
  quarantineUrl: (f) => `/sticker/${f.fileId}.${f.mime === 'image/gif' ? 'gif' : f.mime === 'image/png' ? 'png' : 'webp'}?q=1`,
  exportPack: async (packId, fileName) => {
    const creds = getCredentials();
    let res: Response;
    try {
      res = await fetch(`/api/v1/stickers.packs.export?packId=${encodeURIComponent(packId)}`, {
        credentials: 'same-origin',
        headers: creds ? { 'X-User-Id': creds.userId, 'X-Auth-Token': creds.authToken } : undefined,
      });
    } catch {
      throw new Error(EXPORT_ERROR);
    }
    if (!res.ok) {
      let json: { error?: string; errorType?: string } = {};
      try {
        json = await res.json();
      } catch {
        // corpo que não é JSON
      }
      throw new ApiError(res.status, json.errorType ?? 'error', json.error || EXPORT_ERROR);
    }
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch {
      throw new Error(EXPORT_ERROR);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.zip$/i.test(fileName) ? fileName : `figurinhas-${slugOf(fileName)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

// texto do servidor, ou "Não foi possível concluir. Tente de novo."
export function stickerErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status > 0 && e.message && !/^Erro \d+$/.test(e.message)) return e.message;
  if (e instanceof Error && e.message === EXPORT_ERROR) return e.message;
  return 'Não foi possível concluir. Tente de novo.';
}
