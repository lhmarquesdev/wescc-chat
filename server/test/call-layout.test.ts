import { describe, expect, it } from 'vitest';
import { cameraLimitReached, layoutCall, type LayoutInput, type LayoutPeer } from '@shared/call-layout';
import { CALL_LIMITS } from '@shared/calls';

const NOW = 1_000_000;

function peer(id: string, o: Partial<LayoutPeer> = {}): LayoutPeer {
  return { id, isMe: false, screen: false, camera: false, pinned: false, handAt: null, speakingSince: null, lastSpokeAt: null, joinedAt: 0, ...o };
}

function input(peers: LayoutPeer[], o: Partial<LayoutInput> = {}): LayoutInput {
  return { peers, now: NOW, layout: 'grid', maxTiles: CALL_LIMITS.tilesDesktop, featured: null, ...o };
}

describe('layout da chamada em grupo', () => {
  it('ordem: tela compartilhada, fixado, quem fala agora, mãos levantadas, câmeras ligadas, ordem de chegada', () => {
    const peers = [
      peer('me', { isMe: true, joinedAt: 1 }),
      peer('chegou-cedo', { joinedAt: 2 }),
      peer('camera', { camera: true, joinedAt: 9 }),
      peer('mao-nova', { handAt: NOW - 1000, joinedAt: 3 }),
      peer('mao-antiga', { handAt: NOW - 5000, joinedAt: 8 }),
      peer('falou-antes', { lastSpokeAt: NOW - 60_000, joinedAt: 4 }),
      peer('falando', { speakingSince: NOW - 200, lastSpokeAt: NOW, joinedAt: 7 }),
      peer('fixado', { pinned: true, joinedAt: 6 }),
      peer('tela', { screen: true, joinedAt: 5 }),
    ];
    const r = layoutCall(input(peers));
    expect(r.layout).toBe('spotlight');
    expect(r.featured).toBe('tela');
    expect(r.tiles).toEqual(['tela', 'fixado', 'falando', 'falou-antes', 'mao-antiga', 'mao-nova', 'camera', 'me', 'chegou-cedo']);
    expect(r.hidden).toBe(0);

    // Sem tela nem fixado: a escolha da pessoa vale, e na grade ninguém sobe por ser destaque.
    const calm = layoutCall(input([peer('b', { joinedAt: 2 }), peer('me', { isMe: true, joinedAt: 1 }), peer('c', { camera: true, joinedAt: 3 })]));
    expect(calm.layout).toBe('grid');
    expect(calm.tiles).toEqual(['c', 'me', 'b']);
    expect(layoutCall(input(calm.tiles.map((id) => peer(id)), { layout: 'spotlight' })).layout).toBe('spotlight');

    // Destaque fixado vem primeiro no modo destaque, mesmo sem câmera.
    const pin = layoutCall(input([peer('a', { camera: true }), peer('b', { pinned: true, joinedAt: 5 }), peer('me', { isMe: true })]));
    expect(pin).toMatchObject({ layout: 'spotlight', featured: 'b' });
    expect(pin.tiles[0]).toBe('b');

    // Duas telas: a de outra pessoa antes da minha, e quem já estava em destaque continua.
    const two = [peer('me', { isMe: true, screen: true }), peer('x', { screen: true, joinedAt: 3 })];
    expect(layoutCall(input(two)).featured).toBe('x');
    expect(layoutCall(input(two, { featured: 'me' })).featured).toBe('me');
  });

  it('histerese: o destaque só troca depois de 1,5 s falando', () => {
    const sticky = CALL_LIMITS.speakerStickyMs;
    const base = [peer('me', { isMe: true }), peer('ana', { joinedAt: 1 }), peer('bia', { joinedAt: 2 })];
    // Ninguém falou: a primeira pessoa que chegou (fora eu).
    expect(layoutCall(input(base)).featured).toBe('ana');

    const bia = (since: number) => [base[0], base[1], peer('bia', { joinedAt: 2, speakingSince: since, lastSpokeAt: NOW })];
    expect(layoutCall(input(bia(NOW - sticky + 1), { featured: 'ana' })).featured).toBe('ana');
    expect(layoutCall(input(bia(NOW - sticky), { featured: 'ana' })).featured).toBe('bia');

    // Parou de falar: continua em destaque até outra pessoa falar 1,5 s.
    expect(layoutCall(input(base, { featured: 'bia' })).featured).toBe('bia');

    // Duas falando há tempo: quem estava em destaque fica.
    const both = [base[0], peer('ana', { joinedAt: 1, speakingSince: NOW - 5000 }), peer('bia', { joinedAt: 2, speakingSince: NOW - 3000 })];
    expect(layoutCall(input(both, { featured: 'ana' })).featured).toBe('ana');
    expect(layoutCall(input(both, { featured: null })).featured).toBe('bia');

    // Eu nunca entro em destaque por falar.
    const meTalking = [peer('me', { isMe: true, speakingSince: NOW - 9000 }), peer('ana', { joinedAt: 1 })];
    expect(layoutCall(input(meTalking)).featured).toBe('ana');

    // Quem estava em destaque saiu: volta para a primeira pessoa da chamada.
    expect(layoutCall(input(base, { featured: 'saiu' })).featured).toBe('ana');
  });

  it('páginas: 9 no computador, 4 no celular, eu sempre visível, resto em +N', () => {
    const many = Array.from({ length: 12 }, (_, n) => peer(`p${n}`, { joinedAt: n + 1, camera: n < 10 }));
    const people = [...many, peer('me', { isMe: true, joinedAt: 99 })];

    const desk = layoutCall(input(people, { maxTiles: CALL_LIMITS.tilesDesktop }));
    expect(desk.tiles).toHaveLength(8);
    expect(desk.tiles).toContain('me');
    expect(desk.hidden).toBe(5);
    expect(desk.tiles.length + desk.hidden).toBe(people.length);

    const phone = layoutCall(input(people, { maxTiles: CALL_LIMITS.tilesPhone }));
    expect(phone.tiles).toEqual(['p0', 'p1', 'me']);
    expect(phone.hidden).toBe(10);

    // Cabe todo mundo: sem "+N".
    const nine = layoutCall(input(people.slice(-9), { maxTiles: 9 }));
    expect(nine.tiles).toHaveLength(9);
    expect(nine.hidden).toBe(0);

    // No destaque, o destacado fica no primeiro quadro mesmo com a página cheia.
    const spot = layoutCall(input([...people, peer('tela', { screen: true, joinedAt: 200 })], { maxTiles: 4 }));
    expect(spot.tiles[0]).toBe('tela');
    expect(spot.tiles).toContain('me');
    expect(spot.tiles).toHaveLength(3);
  });

  it('limite de câmeras ligadas', () => {
    const cams = (n: number) => Array.from({ length: 6 }, (_, i) => ({ camera: i < n }));
    expect(cameraLimitReached(cams(0), 4)).toBe(false);
    expect(cameraLimitReached(cams(3), 4)).toBe(false);
    expect(cameraLimitReached(cams(4), 4)).toBe(true);
    expect(cameraLimitReached(cams(6), 4)).toBe(true);
    expect(cameraLimitReached([], 1)).toBe(false);
  });
});
