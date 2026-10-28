// Distribuição dos quadros da chamada em grupo: quem fica em destaque, em que ordem e quantos cabem.
// Pura: a web chama a cada mudança de pessoas, fala, mão ou tela, com o relógio de fora.

import { CALL_LIMITS } from './calls';

export interface LayoutPeer {
  id: string;
  isMe: boolean;
  screen: boolean;
  camera: boolean;
  pinned: boolean;
  handAt: number | null;
  speakingSince: number | null;
  lastSpokeAt: number | null;
  joinedAt: number;
}

export interface LayoutInput {
  peers: LayoutPeer[];
  now: number;
  layout: 'grid' | 'spotlight';
  maxTiles: number;
  featured: string | null; // destaque anterior (histerese)
}

export interface LayoutResult {
  layout: 'grid' | 'spotlight';
  featured: string | null;
  tiles: string[];
  hidden: number; // quantos ficam no quadro "+N"
}

const byJoin = (a: LayoutPeer, b: LayoutPeer) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Fala há pelo menos speakerStickyMs: só então toma o destaque de quem estava.
function steadySpeaker(p: LayoutPeer, now: number) {
  return !p.isMe && p.speakingSince !== null && now - p.speakingSince >= CALL_LIMITS.speakerStickyMs;
}

function pickFeatured(i: LayoutInput): string | null {
  const { peers, now } = i;
  const prev = peers.find((p) => p.id === i.featured) ?? null;
  // Tela compartilhada: a de outra pessoa antes da minha; quem já estava em destaque continua.
  const screens = peers.filter((p) => p.screen);
  if (screens.length) {
    if (prev?.screen) return prev.id;
    return (screens.find((p) => !p.isMe) ?? screens[0]).id;
  }
  const pinned = peers.find((p) => p.pinned);
  if (pinned) return pinned.id;
  const talking = peers.filter((p) => steadySpeaker(p, now));
  if (talking.length) {
    if (prev && talking.includes(prev)) return prev.id;
    // Quem começou a falar por último ganha.
    return talking.reduce((a, b) => ((b.speakingSince ?? 0) > (a.speakingSince ?? 0) ? b : a)).id;
  }
  if (prev) return prev.id;
  const others = peers.filter((p) => !p.isMe).sort(byJoin);
  return (others[0] ?? peers.find((p) => p.isMe) ?? null)?.id ?? null;
}

// Ordem: tela compartilhada, fixado, quem fala (mais recente primeiro), mãos levantadas (a mais antiga primeiro),
// câmeras ligadas e, por fim, a ordem de chegada.
function rank(p: LayoutPeer, now: number): number[] {
  const spoke = p.speakingSince !== null ? now : p.lastSpokeAt;
  return [p.screen ? 0 : 1, p.pinned ? 0 : 1, spoke !== null ? -spoke : Infinity, p.handAt !== null ? p.handAt : Infinity, p.camera ? 0 : 1, p.joinedAt];
}

function compare(a: LayoutPeer, b: LayoutPeer, now: number) {
  const ra = rank(a, now);
  const rb = rank(b, now);
  for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] < rb[k] ? -1 : 1;
  return byJoin(a, b);
}

export function layoutCall(i: LayoutInput): LayoutResult {
  const featured = pickFeatured(i);
  const layout = i.peers.some((p) => p.screen || p.pinned) ? 'spotlight' : i.layout;
  const ordered = [...i.peers].sort((a, b) => compare(a, b, i.now));
  if (layout === 'spotlight' && featured) {
    const at = ordered.findIndex((p) => p.id === featured);
    if (at > 0) ordered.unshift(...ordered.splice(at, 1));
  }
  const max = Math.max(1, i.maxTiles);
  if (ordered.length <= max) return { layout, featured, tiles: ordered.map((p) => p.id), hidden: 0 };
  // Não cabe todo mundo: o último quadro vira "+N". Eu fico sempre visível, no lugar do último que caberia.
  const room = max - 1;
  const shown = ordered.slice(0, room);
  const me = ordered.find((p) => p.isMe);
  if (me && !shown.includes(me)) {
    if (room > 0) shown[room - 1] = me;
    else shown.push(me);
  }
  return { layout, featured, tiles: shown.map((p) => p.id), hidden: i.peers.length - shown.length };
}

export function cameraLimitReached(peers: { camera: boolean }[], max: number): boolean {
  return peers.filter((p) => p.camera).length >= max;
}
