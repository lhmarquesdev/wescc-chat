import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Call, CallCard, CallEndReason, RoomCallState, UserRef } from '@shared/index';
import { CALL_GUARD_JOIN, CALL_GUARD_ROOM, callEndedReasonText } from '@shared/calls';
import {
  bannerView,
  CALL_ARCHIVED,
  CALL_MUTED,
  CALL_NOT_MEMBER,
  callReasonPasses,
  callsRowView,
  cardView,
  CALL_HTTPS_REASON,
  CALL_SERVER_FULL,
  CALL_SFU_DOWN,
  CALL_SFU_NOT_CONFIGURED,
  crossesCallLimit,
  guessStart,
  headerView,
  isMuteNoticeFor,
  liveCallIcon,
  liveRowMeta,
  missedBadgeLabel,
  missedMayChange,
  roomCallNeedsPoll,
  type CallViewEnv,
  type HeaderGuess,
  type StartGuessCtx,
} from '@shared/call-view';
import { ERR } from '../src/calls/policy';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const ana: UserRef = { _id: 'u-ana', username: 'ana', name: 'Ana Souza' };
const bruno: UserRef = { _id: 'u-bruno', username: 'bruno', name: 'Bruno Lima' };
const carla: UserRef = { _id: 'u-carla', username: 'carla', name: 'Carla Dias' };
const me: UserRef = { _id: 'u-me', username: 'eu', name: 'Eu Mesmo' };

function env(o: Partial<CallViewEnv> = {}): CallViewEnv {
  return { enabled: true, secure: true, inThisCall: false, inOtherCall: false, otherTab: false, now: NOW, ...o };
}

function call(o: Partial<Call> = {}): Call {
  return {
    _id: 'c1',
    rid: 'r1',
    kind: 'video',
    status: 'ongoing',
    scope: 'group',
    media: 'sfu',
    caller: ana,
    callee: null,
    callerConnectionId: null,
    calleeConnectionId: null,
    createdAt: ago(125),
    answeredAt: null,
    endedAt: null,
    endedBy: null,
    endedReason: null,
    duration: null,
    listenOnly: false,
    participantsCount: 3,
    sample: [ana, bruno, carla],
    peak: 3,
    totalJoined: 3,
    guardUntil: null,
    messageId: 'm1',
    ...o,
  };
}

function state(o: Partial<RoomCallState> = {}): RoomCallState {
  return { call: null, canStart: true, hideStart: false, canJoin: false, listenOnly: false, transmission: false, serverTime: new Date(NOW).toISOString(), ...o };
}

function card(o: Partial<CallCard> = {}): CallCard {
  return {
    _id: 'c1',
    kind: 'video',
    scope: 'group',
    status: 'ongoing',
    listenOnly: false,
    startedAt: ago(65),
    endedAt: null,
    duration: null,
    participantsCount: 2,
    sample: [ana, bruno],
    peak: 2,
    totalJoined: 2,
    endedReason: null,
    endedBy: null,
    ...o,
  };
}

const hm = (iso: string) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

describe('apresentação das chamadas na sala (call-view)', () => {
  it('cabeçalho: escondido, iniciar, iniciar com motivo, entrar, ouvir, na chamada e chamada em outra aba', () => {
    expect(headerView(null, env())).toEqual({ kind: 'hidden' });
    expect(headerView(state({ canStart: false, hideStart: true, startBlockedReason: 'Esta sala não aceita chamadas.' }), env())).toEqual({ kind: 'hidden' });
    expect(headerView(state(), env())).toEqual({ kind: 'start', transmission: false });
    expect(headerView(state({ transmission: true }), env())).toEqual({ kind: 'start', transmission: true });
    expect(headerView(state({ canStart: false, startBlockedReason: 'Esta sala está arquivada.' }), env())).toEqual({
      kind: 'start',
      transmission: false,
      reason: 'Esta sala está arquivada.',
    });

    const live = state({ call: call(), canStart: false, canJoin: true });
    expect(headerView(live, env())).toEqual({ kind: 'pill', text: 'Entrar', title: 'Entrar na chamada', count: 3, action: 'join', icon: 'call-live' });
    expect(headerView({ ...live, listenOnly: true }, env())).toEqual({ kind: 'pill', text: 'Ouvir', title: 'Ouvir a transmissão', count: 3, action: 'join', icon: 'call-live' });
    expect(headerView({ ...live, canJoin: false, joinBlockedReason: CALL_GUARD_JOIN }, env())).toEqual({
      kind: 'pill',
      text: 'Entrar',
      title: 'Entrar na chamada',
      count: 3,
      action: 'join',
      reason: CALL_GUARD_JOIN,
      icon: 'call-live',
    });
    // Mesmo em outra chamada, entrar continua possível: a web pergunta antes de sair da outra.
    expect(headerView(live, env({ inOtherCall: true }))).toMatchObject({ kind: 'pill', text: 'Entrar', action: 'join' });
    const inside = { kind: 'pill', text: 'Na chamada', title: 'Abrir a chamada', count: 3, action: 'open', icon: 'call-live' };
    expect(headerView(live, env({ inThisCall: true }))).toEqual(inside);
    expect(headerView(live, env({ otherTab: true }))).toEqual(inside);

    // Chamada a dois viva na DM, fora desta aba: os botões ficam com o motivo do servidor.
    const direct = state({ call: call({ scope: 'direct', media: 'p2p', status: 'ringing', callee: me }), canStart: false, startBlockedReason: 'Você já está em uma chamada.' });
    expect(headerView(direct, env())).toEqual({ kind: 'start', transmission: false, reason: 'Você já está em uma chamada.' });
    expect(headerView(direct, env({ inThisCall: true }))).toMatchObject({ kind: 'pill', text: 'Na chamada', action: 'open' });
  });

  it('cabeçalho sem HTTPS mostra o motivo; chamadas desligadas escondem', () => {
    expect(headerView(state(), env({ secure: false }))).toEqual({ kind: 'start', transmission: false, reason: CALL_HTTPS_REASON });
    expect(CALL_HTTPS_REASON).toBe('Chamadas exigem HTTPS. Peça ao administrador para ativar o HTTPS do chat.');
    const live = state({ call: call(), canStart: false, canJoin: true });
    expect(headerView(live, env({ secure: false }))).toMatchObject({ kind: 'pill', text: 'Entrar', reason: CALL_HTTPS_REASON });
    expect(headerView(state(), env({ enabled: false }))).toEqual({ kind: 'hidden' });
    expect(headerView(live, env({ enabled: false }))).toEqual({ kind: 'hidden' });
  });

  it('faixa da sala: normal, pausada pela trava, entrada bloqueada, oculta para esta chamada', () => {
    const live = state({ call: call(), canStart: false, canJoin: true });
    expect(bannerView(null, env(), null)).toBeNull();
    expect(bannerView(state(), env(), null)).toBeNull();
    expect(bannerView(live, env(), null)).toEqual({ title: 'Chamada em andamento', meta: 'Ana, Bruno e Carla · 2:05', primary: { text: 'Entrar' }, guard: false });
    const many = state({ ...live, call: call({ participantsCount: 7, sample: [ana, bruno, carla] }) });
    expect(bannerView(many, env(), null)?.meta).toBe('Ana, Bruno e mais 5 · 2:05');

    const paused = state({ ...live, call: call({ guardUntil: new Date(NOW + 20_000).toISOString() }) });
    expect(bannerView(paused, env(), null)).toEqual({ title: CALL_GUARD_ROOM, meta: 'Ana, Bruno e Carla · 2:05', primary: { text: 'Entrar' }, guard: true });

    const blocked = state({ ...live, canJoin: false, joinBlockedReason: 'Entre na sala para participar da chamada.' });
    expect(bannerView(blocked, env(), null)?.primary).toEqual({ text: 'Entrar', reason: 'Entre na sala para participar da chamada.' });
    expect(bannerView(live, env({ secure: false }), null)?.primary).toEqual({ text: 'Entrar', reason: CALL_HTTPS_REASON });

    const listen = state({ ...live, listenOnly: true, call: call({ listenOnly: true, participantsCount: 120 }) });
    expect(bannerView(listen, env(), null)).toMatchObject({ title: 'Transmissão ao vivo', meta: '120 pessoas · 2:05', primary: { text: 'Ouvir' } });

    expect(bannerView(live, env(), 'c1')).toBeNull();
    expect(bannerView(live, env(), 'outra')).not.toBeNull();
    expect(bannerView(live, env({ inThisCall: true }), null)).toBeNull();
    expect(bannerView(live, env({ otherTab: true }), null)).toBeNull();
    expect(bannerView(live, env({ enabled: false }), null)).toBeNull();
    // A dois não há faixa: a chamada toca para a outra pessoa.
    expect(bannerView(state({ call: call({ scope: 'direct' }) }), env(), null)).toBeNull();
  });

  it('cartão: ao vivo e encerrado, com cada motivo de encerramento', () => {
    const live = state({ call: call({ participantsCount: 4 }), canStart: false, canJoin: true });
    expect(cardView(card(), live, env(), 'Ana Souza')).toEqual({
      live: true,
      icon: 'call-video',
      title: 'Chamada de vídeo em andamento',
      meta: 'Iniciada por Ana Souza · 1:05',
      people: '4 na chamada',
      button: { text: 'Entrar', action: 'join' },
    });
    expect(cardView(card({ kind: 'audio' }), null, env(), 'Ana Souza')).toMatchObject({ icon: 'call-audio', title: 'Chamada de voz em andamento', people: '2 na chamada', button: { text: 'Entrar', action: 'join' } });
    expect(cardView(card(), live, env({ inThisCall: true }), 'Ana').button).toEqual({ text: 'Na chamada', action: 'open' });
    expect(cardView(card(), live, env({ otherTab: true }), 'Ana').button).toEqual({ text: 'Na chamada', action: 'open' });
    expect(cardView(card(), { ...live, canJoin: false, joinBlockedReason: CALL_GUARD_JOIN }, env(), 'Ana').button).toEqual({ text: 'Entrar', action: 'join', reason: CALL_GUARD_JOIN });
    expect(cardView(card(), live, env({ secure: false }), 'Ana').button?.reason).toBe(CALL_HTTPS_REASON);
    // A sala já não tem a chamada (o cartão final ainda vai chegar) e chamadas desligadas: sem botão.
    expect(cardView(card(), state(), env(), 'Ana').button).toBeUndefined();
    expect(cardView(card(), live, env({ enabled: false }), 'Ana').button).toBeUndefined();
    expect(cardView(card({ listenOnly: true, participantsCount: 120 }), null, env(), 'Ana')).toMatchObject({
      icon: 'call-broadcast',
      title: 'Transmissão ao vivo',
      people: '120 ouvindo',
      button: { text: 'Ouvir' },
    });

    const endedAt = ago(30);
    const ended = card({ status: 'ended', endedAt, duration: 42 * 60, totalJoined: 12, endedReason: 'hangup' });
    expect(cardView(ended, null, env(), 'Ana')).toEqual({ live: false, icon: 'call-video', title: 'Chamada de vídeo encerrada', meta: `42 min · 12 pessoas · ${hm(endedAt)}` });
    expect(cardView({ ...ended, kind: 'audio' }, null, env(), 'Ana').title).toBe('Chamada de voz encerrada');
    expect(cardView({ ...ended, listenOnly: true }, null, env(), 'Ana')).toMatchObject({ icon: 'call-broadcast', title: 'Transmissão encerrada' });
    expect(cardView({ ...ended, duration: 42, totalJoined: 1 }, null, env(), 'Ana').meta).toBe(`42 s · 1 pessoa · ${hm(endedAt)}`);

    const reasons: CallEndReason[] = ['hangup', 'empty', 'dropped', 'moderator', 'restricted', 'no-answer', 'alone', 'max-duration', 'room', 'readonly', 'no-speaker', 'sfu'];
    for (const r of reasons) {
      const v = cardView({ ...ended, endedReason: r, endedBy: r === 'moderator' ? bruno : null }, null, env(), 'Ana');
      const text = callEndedReasonText(r, r === 'moderator' ? bruno : null);
      if (text) expect(v.reason).toBe(text);
      else expect(v).not.toHaveProperty('reason');
      expect(v.button).toBeUndefined();
    }
    expect(cardView({ ...ended, endedReason: 'moderator', endedBy: bruno }, null, env(), 'Ana').reason).toBe('Encerrada por Bruno Lima');
    expect(cardView({ ...ended, endedReason: 'restricted' }, null, env(), 'Ana').reason).toBe('Encerrada: só restaram pessoas que não podem conversar em particular');
    expect(cardView({ ...ended, endedReason: 'sfu' }, null, env(), 'Ana').reason).toBe('Encerrada: o servidor de chamadas ficou indisponível');
  });

  it('linhas da página Chamadas: feita, recebida, perdida, recusada, em grupo e rediscagem bloqueada', () => {
    const base = { scope: 'direct' as const, media: 'p2p' as const, status: 'ended' as const, callee: bruno, caller: me, kind: 'video' as const, duration: 6 };
    const mine = (o: Partial<NonNullable<Call['mine']>>) => ({
      state: 'left' as const,
      host: false,
      seconds: 0,
      direction: 'incoming' as const,
      missed: false,
      leftReason: null,
      leftAt: null,
      listenOnly: false,
      handAt: null,
      canModerate: false,
      canEnd: false,
      canRing: false,
      canInvite: false,
      ...o,
    });

    const made = call({ ...base, mine: mine({ direction: 'outgoing', host: true }), canCall: true });
    expect(callsRowView(made, me._id, 'Bruno Lima')).toEqual({ title: 'Bruno Lima', meta: 'Feita · Vídeo · 6 s', missed: false, redial: true });
    const notAnswered = call({ ...base, status: 'missed', duration: null, kind: 'audio', mine: mine({ direction: 'outgoing' }) });
    expect(callsRowView(notAnswered, me._id, 'x').meta).toBe('Feita · Voz · não atendida');

    const got = call({ ...base, caller: ana, callee: me, duration: 5 * 60 + 3, mine: mine({ direction: 'incoming' }) });
    expect(callsRowView(got, me._id, 'x')).toEqual({ title: 'Ana Souza', meta: 'Recebida · Vídeo · 5 min', missed: false, redial: true });

    const lost = call({ ...base, status: 'missed', caller: ana, callee: me, duration: null, mine: mine({ state: 'missed', missed: true }) });
    expect(callsRowView(lost, me._id, 'x')).toEqual({ title: 'Ana Souza', meta: 'Perdida · Vídeo', missed: true, redial: true });

    const refused = call({ ...base, status: 'declined', caller: ana, callee: me, duration: null, kind: 'audio', mine: mine({ state: 'declined' }) });
    expect(callsRowView(refused, me._id, 'x')).toEqual({ title: 'Ana Souza', meta: 'Recusada · Voz', missed: false, redial: true });

    const blocked = call({ ...got, canCall: false, callBlockedReason: 'Você não pode ligar para @ana.' });
    expect(callsRowView(blocked, me._id, 'x')).toMatchObject({ redial: true, redialReason: 'Você não pode ligar para @ana.' });

    const group = call({ status: 'ended', duration: 42 * 60, totalJoined: 12, mine: mine({ state: 'left', seconds: 30 * 60 }) });
    expect(callsRowView(group, me._id, 'Suporte')).toEqual({ title: 'Suporte', meta: 'Você participou · Vídeo · 30 min · 12 pessoas', missed: false, redial: false });
    expect(callsRowView(call({ ...group, caller: me, kind: 'audio', mine: mine({ host: true, direction: 'outgoing', seconds: 90 }) }), me._id, 'Suporte').meta).toBe(
      'Iniciada por você · Voz · 1 min · 12 pessoas',
    );
    expect(callsRowView(call({ ...group, mine: mine({ state: 'missed', missed: true }) }), me._id, 'Time A')).toEqual({
      title: 'Time A',
      meta: 'Perdida · Vídeo · — · 12 pessoas',
      missed: true,
      redial: false,
    });
    expect(callsRowView(call({ ...group, mine: mine({ state: 'declined' }) }), me._id, 'Time A').meta).toBe('Recusada · Vídeo · — · 12 pessoas');
    expect(callsRowView(call({ ...group, listenOnly: true, mine: mine({ seconds: 5 }) }), me._id, 'Avisos').meta).toBe('Você participou · Transmissão · 5 s · 12 pessoas');

    expect(liveRowMeta(call({ participantsCount: 4 }), NOW)).toBe('Em grupo · 4 pessoas · 2:05');
  });

  it('selo de perdidas: vazio, 1 chamada perdida, n chamadas perdidas', () => {
    expect(missedBadgeLabel(0)).toBe('');
    expect(missedBadgeLabel(-1)).toBe('');
    expect(missedBadgeLabel(1)).toBe('1 chamada perdida');
    expect(missedBadgeLabel(37)).toBe('37 chamadas perdidas');
  });
  it('iniciar antes da resposta: as recusas de startCheck que o cliente já conhece, na mesma ordem', () => {
    const ctx = (o: Partial<StartGuessCtx> = {}): StartGuessCtx => ({ groupEnabled: true, canManage: true, member: true, username: 'eu', ...o });
    const channel = { t: 'c', ro: false, notice: false, broadcast: false, archived: false };
    expect(guessStart(channel, ctx())).toEqual({ show: true });
    expect(guessStart({ ...channel, t: 'p' }, ctx())).toEqual({ show: true });
    expect(guessStart({ t: 'd', uids: ['u-me', 'u-ana', 'u-bruno'] }, ctx({ canManage: false }))).toEqual({ show: true }); // DM em grupo não pede call-management
    // Escondem (a recusa não muda sozinha): atendimento, DM consigo mesmo, grupo desligado, transmissão, sem permissão.
    expect(guessStart({ t: 'l' }, ctx())).toEqual({ show: false });
    expect(guessStart({ t: 'd', uids: ['u-me'] }, ctx())).toEqual({ show: false });
    expect(guessStart(channel, ctx({ groupEnabled: false }))).toEqual({ show: false });
    expect(guessStart({ t: 'd', uids: ['u-me', 'u-ana', 'u-bruno'] }, ctx({ groupEnabled: false }))).toEqual({ show: false });
    expect(guessStart({ ...channel, ro: true }, ctx())).toEqual({ show: false });
    expect(guessStart({ ...channel, notice: true }, ctx())).toEqual({ show: false });
    expect(guessStart({ ...channel, broadcast: true }, ctx())).toEqual({ show: false });
    expect(guessStart({ t: 'd', uids: ['u-me', 'u-ana', 'u-bruno'], ro: true }, ctx())).toEqual({ show: false });
    expect(guessStart(channel, ctx({ canManage: false }))).toEqual({ show: false });
    // Mostram com o motivo, na ordem do servidor.
    expect(guessStart(channel, ctx({ member: false }))).toEqual({ show: true, reason: CALL_NOT_MEMBER });
    expect(guessStart({ ...channel, archived: true, muted: ['eu'] }, ctx())).toEqual({ show: true, reason: CALL_ARCHIVED });
    expect(guessStart({ ...channel, muted: ['ana', 'eu'] }, ctx())).toEqual({ show: true, reason: CALL_MUTED });
    expect(guessStart({ ...channel, muted: ['ana'] }, ctx())).toEqual({ show: true });
    // A dois: o grupo desligado não importa (é P2P); a regra de conversa direta vem pronta em rooms.info.
    const pair = { t: 'd', uids: ['u-me', 'u-ana'] };
    expect(guessStart(pair, ctx({ groupEnabled: false, canManage: false }))).toEqual({ show: true });
    expect(guessStart({ ...pair, direct: { canCall: false, callBlockedReason: 'Bloqueada.' } }, ctx())).toEqual({ show: true, reason: 'Bloqueada.' });
    expect(guessStart({ ...pair, direct: { canCall: true } }, ctx())).toEqual({ show: true });
  });

  it('os motivos que o cliente conhece são os textos do servidor (startCheck)', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/calls/policy.ts'), 'utf8');
    for (const t of [CALL_NOT_MEMBER, CALL_ARCHIVED, CALL_MUTED]) expect(src).toContain(`notAllowed('${t}')`);
  });

  it('cabeçalho provisório: primeira abertura nasce com o que a sala oferece, e o clique confere (pending)', () => {
    const g = (start: HeaderGuess['start'], settled = false): HeaderGuess => ({ start, settled });
    expect(headerView(null, env(), g({ show: true }))).toEqual({ kind: 'start', transmission: false, pending: true });
    expect(headerView(null, env({ secure: false }), g({ show: true }))).toEqual({ kind: 'start', transmission: false, pending: true, reason: CALL_HTTPS_REASON });
    expect(headerView(null, env(), g({ show: true, reason: CALL_MUTED }))).toEqual({ kind: 'start', transmission: false, pending: true, reason: CALL_MUTED });
    expect(headerView(null, env(), g({ show: false }))).toEqual({ kind: 'hidden' });
    expect(headerView(null, env({ enabled: false }), g({ show: true }))).toEqual({ kind: 'hidden' });
    // Com a resposta (settled), vale o servidor e some o pending.
    expect(headerView(state(), env(), g({ show: true, reason: CALL_MUTED }, true))).toEqual({ kind: 'start', transmission: false });
    expect(headerView(null, env(), g({ show: true }, true))).toEqual({ kind: 'hidden' });
    // Chamada em grupo viva já conhecida (lista de chamadas vivas): a pílula desde o início.
    const live = state({ call: call(), canStart: false, canJoin: true });
    expect(headerView(live, env(), g({ show: true }))).toEqual({ kind: 'pill', text: 'Entrar', title: 'Entrar na chamada', count: 3, action: 'join', icon: 'call-live', pending: true });
    expect(headerView({ ...live, canJoin: false, joinBlockedReason: CALL_GUARD_JOIN }, env(), g({ show: true }))).toMatchObject({ kind: 'pill', reason: CALL_GUARD_JOIN, pending: true });
    expect(headerView(live, env({ inThisCall: true }), g({ show: true }))).toMatchObject({ kind: 'pill', text: 'Na chamada', action: 'open' });
    expect(headerView({ ...live, listenOnly: true }, env(), g({ show: false }))).toMatchObject({ kind: 'pill', text: 'Ouvir', pending: true });
  });

  it('estado guardado de uma sala fechada: o que o cliente sabe vale por cima, o resto fica até a resposta', () => {
    const stale = (start: HeaderGuess['start']): HeaderGuess => ({ start, settled: false });
    // Silenciado com a sala fechada: o guardado dizia livre, a sala (rooms.info) já diz silenciado.
    expect(headerView(state(), env(), stale({ show: true, reason: CALL_MUTED }))).toEqual({ kind: 'start', transmission: false, pending: true, reason: CALL_MUTED });
    // Liberado com a sala fechada: o motivo guardado que o cliente confere sai.
    for (const r of [CALL_MUTED, CALL_ARCHIVED, CALL_NOT_MEMBER]) {
      expect(headerView(state({ canStart: false, startBlockedReason: r }), env(), stale({ show: true }))).toEqual({ kind: 'start', transmission: false, pending: true });
    }
    // Um motivo que só o servidor conhece fica (o clique confere de novo antes de agir).
    expect(headerView(state({ canStart: false, startBlockedReason: CALL_SERVER_FULL }), env(), stale({ show: true }))).toEqual({
      kind: 'start',
      transmission: false,
      pending: true,
      reason: CALL_SERVER_FULL,
    });
    // A sala virou somente leitura: some.
    expect(headerView(state(), env(), stale({ show: false }))).toEqual({ kind: 'hidden' });
    // Chamada a dois viva na DM: os botões ficam com o motivo guardado.
    const direct = state({ call: call({ scope: 'direct', media: 'p2p', status: 'ringing', callee: me }), canStart: false, startBlockedReason: 'Você já está em uma chamada.' });
    expect(headerView(direct, env(), stale({ show: true }))).toEqual({ kind: 'start', transmission: false, pending: true, reason: 'Você já está em uma chamada.' });
  });

  it('pílula de uma transmissão usa o ícone da transmissão, como a faixa', () => {
    const live = state({ call: call({ listenOnly: true }), canStart: false, canJoin: true, listenOnly: true });
    expect(headerView(live, env())).toMatchObject({ kind: 'pill', text: 'Ouvir', icon: 'call-broadcast' });
    expect(headerView(live, env({ inThisCall: true }))).toMatchObject({ kind: 'pill', text: 'Na chamada', icon: 'call-broadcast' });
    expect(liveCallIcon(call({ listenOnly: true }))).toBe('call-broadcast');
    expect(liveCallIcon(call())).toBe('call-live');
    expect(liveCallIcon(null)).toBe('call-live');
  });

  it('motivos que passam sozinhos (servidor fora do ar ou no limite) pedem nova conferência', () => {
    // Os textos são os do servidor: se um mudar lá, este teste avisa.
    expect(CALL_SFU_DOWN).toBe(ERR.sfu().message);
    expect(CALL_SERVER_FULL).toBe(ERR.capacity().message);
    expect(callReasonPasses(CALL_SFU_DOWN)).toBe(true);
    expect(callReasonPasses(CALL_SERVER_FULL)).toBe(true);
    expect(callReasonPasses('Esta sala está arquivada.')).toBe(false);
    expect(callReasonPasses(undefined)).toBe(false);
    expect(roomCallNeedsPoll(state({ canStart: false, startBlockedReason: CALL_SFU_DOWN }))).toBe(true);
    expect(roomCallNeedsPoll(state({ canStart: false, startBlockedReason: 'Esta sala está arquivada.' }))).toBe(false);
    expect(roomCallNeedsPoll(state({ call: call(), canStart: false, startBlockedReason: 'Já existe uma chamada em andamento nesta sala.', canJoin: false, joinBlockedReason: CALL_SERVER_FULL }))).toBe(true);
    expect(roomCallNeedsPoll(state({ call: call(), canStart: false, canJoin: true }))).toBe(false);
    expect(roomCallNeedsPoll(null)).toBe(false);
  });

  it('sem servidor de chamadas configurado: motivo próprio nos botões, que não passa sozinho', () => {
    expect(CALL_SFU_NOT_CONFIGURED).toBe(ERR.sfuNotConfigured().message);
    expect(ERR.sfuNotConfigured().errorType).toBe('error-call-sfu-not-configured');
    expect(ERR.sfu().errorType).toBe('error-call-sfu-unavailable');
    expect(CALL_SFU_NOT_CONFIGURED).not.toBe(CALL_SFU_DOWN);
    // O caminho do menu é o da administração da web (item Chamadas).
    expect(CALL_SFU_NOT_CONFIGURED).toContain('Administração › Chamadas');
    expect(callReasonPasses(CALL_SFU_NOT_CONFIGURED)).toBe(false);
    const s = state({ canStart: false, startBlockedReason: CALL_SFU_NOT_CONFIGURED });
    expect(roomCallNeedsPoll(s)).toBe(false);
    expect(headerView(s, env())).toEqual({ kind: 'start', transmission: false, reason: CALL_SFU_NOT_CONFIGURED });
    // Provisório (estado guardado): o motivo do servidor fica até a resposta.
    expect(headerView(s, env(), { start: { show: true }, settled: false })).toEqual({ kind: 'start', transmission: false, pending: true, reason: CALL_SFU_NOT_CONFIGURED });
    // Sem HTTPS, o motivo do HTTPS vem antes.
    expect(headerView(s, env({ secure: false }))).toEqual({ kind: 'start', transmission: false, reason: CALL_HTTPS_REASON });
  });

  it('limite de pessoas: só cruzar o limite (para cima ou para baixo) pede a visão do servidor', () => {
    expect(crossesCallLimit(2, 1, 2)).toBe(true); // alguém saiu da chamada cheia
    expect(crossesCallLimit(1, 2, 2)).toBe(true); // encheu com a sala aberta
    expect(crossesCallLimit(1, 0, 2)).toBe(false);
    expect(crossesCallLimit(3, 4, 30)).toBe(false);
    expect(crossesCallLimit(30, 30, 30)).toBe(false);
    expect(crossesCallLimit(5, 1, 0)).toBe(false);
  });

  it('selo de perdidas: a dois para mim que terminou sem atender; silenciar e liberar a mim', () => {
    const d = (status: Call['status']) => call({ scope: 'direct', media: 'p2p', status, caller: ana, callee: me });
    for (const st of ['missed', 'canceled', 'busy', 'declined', 'ended'] as Call['status'][]) expect(missedMayChange(d(st), me._id)).toBe(true);
    expect(missedMayChange(d('ringing'), me._id)).toBe(false);
    expect(missedMayChange(d('ongoing'), me._id)).toBe(false);
    expect(missedMayChange(d('canceled'), ana._id)).toBe(false); // quem ligou não perdeu nada
    expect(missedMayChange(call({ status: 'ended' }), me._id)).toBe(false); // em grupo: call.ring stop
    expect(missedMayChange(d('canceled'), null)).toBe(false);
    expect(isMuteNoticeFor({ t: 'user-muted', msg: 'eu' }, 'eu')).toBe(true);
    expect(isMuteNoticeFor({ t: 'user-unmuted', msg: 'eu' }, 'eu')).toBe(true);
    expect(isMuteNoticeFor({ t: 'user-muted', msg: 'ana' }, 'eu')).toBe(false);
    expect(isMuteNoticeFor({ t: 'uj', msg: 'eu' }, 'eu')).toBe(false);
    expect(isMuteNoticeFor({ t: 'user-muted', msg: 'eu' }, null)).toBe(false);
  });
});
