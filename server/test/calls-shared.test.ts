import { describe, expect, it } from 'vitest';
import {
  CALL_TRACK_NAMES,
  callCardSummary,
  callEndedReasonText,
  callGuardText,
  callNamesLabel,
  callPeopleLabel,
  callPresenceVerdict,
  callScopeOf,
  callStartBlockMessage,
  callTrackNameOk,
  callUserLabel,
  formatCallClock,
  formatCallDuration,
  guardModeFor,
  isTransmissionRoom,
  predictJoinBlocked,
  type GuardPerson,
} from '@shared/calls';
import type { CallCard, CallEndReason, CallGuardMode, CallGuardState } from '@shared/index';
import { checkDirect, isExempt, isRestricted, type DirectRules } from '@shared/direct';

// Regras e textos puros das chamadas (shared/src/calls.ts): o servidor decide com elas e a web prevê.

const rules: DirectRules = { restrictedRoles: ['operacao'], exemptRoles: ['admin'], scope: 'any' };
const op = (id: string, speaks = true, roles = ['user', 'operacao']): GuardPerson => ({ _id: id, username: id, roles, speaks });
const sup: GuardPerson = { _id: 's', username: 's', roles: ['user'], speaks: true };
const exempt: GuardPerson = { _id: 'x', username: 'x', roles: ['user', 'operacao', 'admin'], speaks: true };

describe('regras das chamadas (shared)', () => {
  it('callPresenceVerdict: dois restritos que falam, sem acompanhante, bloqueiam; com supervisor ou isento, não', () => {
    expect(callPresenceVerdict([op('o1'), op('o2')], rules, 'strict')).toEqual({ allowed: false, pair: ['o1', 'o2'] });
    expect(callPresenceVerdict([op('o1'), op('o2')], rules, 'pairs')).toEqual({ allowed: false, pair: ['o1', 'o2'] });
    expect(callPresenceVerdict([op('o1'), op('o2'), sup], rules, 'strict').allowed).toBe(true);
    expect(callPresenceVerdict([op('o1'), op('o2'), exempt], rules, 'strict').allowed).toBe(true);
    // Um acompanhante que não fala (ouvinte) também acompanha.
    expect(callPresenceVerdict([op('o1'), op('o2'), { ...sup, speaks: false }], rules, 'strict').allowed).toBe(true);
  });

  it('modo pairs: três ou mais restritos falando seguem; modo strict bloqueia; só quem fala forma par', () => {
    expect(callPresenceVerdict([op('o1'), op('o2'), op('o3')], rules, 'pairs').allowed).toBe(true);
    expect(callPresenceVerdict([op('o1'), op('o2'), op('o3')], rules, 'strict').allowed).toBe(false);
    // Três restritos, mas só dois falam: no modo pairs isso ainda é um par.
    expect(callPresenceVerdict([op('o1'), op('o2'), op('o3', false)], rules, 'pairs')).toEqual({ allowed: false, pair: ['o1', 'o2'] });
    expect(callPresenceVerdict([op('o1'), op('o2', false)], rules, 'strict').allowed).toBe(true);
    expect(callPresenceVerdict([op('o1', false), op('o2', false)], rules, 'strict').allowed).toBe(true);
    // Quem ainda está entrando (token sem conexão) forma par na hora, mas não completa os três do modo pairs.
    const arriving = (id: string) => ({ ...op(id), arriving: true });
    expect(callPresenceVerdict([op('o1'), op('o2'), arriving('o3')], rules, 'pairs')).toEqual({ allowed: false, pair: ['o1', 'o2'] });
    expect(callPresenceVerdict([op('o1'), arriving('o2')], rules, 'strict')).toEqual({ allowed: false, pair: ['o1', 'o2'] });
    expect(callPresenceVerdict([op('o1'), op('o2'), op('o3'), arriving('o4')], rules, 'pairs').allowed).toBe(true);
  });

  it('uma pessoa sozinha nunca é bloqueada; sem papéis restritos nada bloqueia; escopo same_role respeitado', () => {
    expect(callPresenceVerdict([op('o1')], rules, 'strict').allowed).toBe(true);
    expect(callPresenceVerdict([], rules, 'strict').allowed).toBe(true);
    expect(callPresenceVerdict([op('o1'), op('o2')], { ...rules, restrictedRoles: [] }, 'strict').allowed).toBe(true);
    const same: DirectRules = { restrictedRoles: ['operacao', 'vendas'], exemptRoles: [], scope: 'same_role' };
    const vend = (id: string): GuardPerson => op(id, true, ['user', 'vendas']);
    // Papéis restritos diferentes não formam par em same_role; iguais formam.
    expect(callPresenceVerdict([op('o1'), vend('v1')], same, 'strict').allowed).toBe(true);
    expect(callPresenceVerdict([op('o1'), vend('v1'), vend('v2')], same, 'strict')).toEqual({ allowed: false, pair: ['v1', 'v2'] });
    expect(callPresenceVerdict([op('o1'), op('o2')], { ...rules, scope: 'any' }, 'strict').allowed).toBe(false);
  });

  it('predictJoinBlocked concorda com o veredito do servidor nos dois modos', () => {
    // Para cada cenário, a previsão da web (só com o resumo) bate com o veredito do servidor com a pessoa entrando.
    const viewers: GuardPerson[] = [op('eu'), op('eu', false), sup, exempt];
    const arriving = (id: string): GuardPerson => ({ ...op(id), arriving: true });
    const present: GuardPerson[][] = [
      [],
      [op('a')],
      [op('a'), op('b')],
      [op('a', false)],
      [op('a'), sup],
      [op('a'), op('b'), op('c')],
      [op('a'), exempt],
      [arriving('a')],
      [op('a'), arriving('b')],
      [op('a'), op('b'), arriving('c')],
      [op('a'), op('b'), op('c'), arriving('d')],
    ];
    for (const mode of ['strict', 'pairs'] as CallGuardMode[]) {
      for (const people of present) {
        for (const me of viewers) {
          const g: CallGuardState = {
            mode,
            chaperone: people.some((p) => !isRestricted(p, rules) || isExempt(p, rules)),
            restrictedSpeakers: people.filter((p) => isRestricted(p, rules) && !isExempt(p, rules) && p.speaks).length,
            connectedSpeakers: people.filter((p) => isRestricted(p, rules) && !isExempt(p, rules) && p.speaks && !p.arriving).length,
          };
          const viewer = { restricted: isRestricted(me, rules), exempt: isExempt(me, rules), speaks: me.speaks };
          // Como o assertJoinSafe do servidor: quem só ouve nunca é barrado (sem falar não forma par).
          const server = !me.speaks || callPresenceVerdict([...people, me], rules, mode).allowed;
          const label = people.map((p) => p._id + (p.speaks ? '' : '(ouve)') + (p.arriving ? '(entrando)' : '')).join(',');
          expect(predictJoinBlocked(g, viewer), `${mode} ${label} + ${me._id}`).toBe(!server);
        }
      }
    }
    expect(predictJoinBlocked(undefined, { restricted: true, exempt: false, speaks: true })).toBe(false);
  });

  it('callStartBlockMessage: quem está no par, restrito que juntaria um par, e quem não é restrito', () => {
    const o1 = { _id: 'o1', username: 'o1', roles: ['user', 'operacao'] };
    const o2 = { _id: 'o2', username: 'o2', roles: ['user', 'operacao'] };
    const o3 = { _id: 'o3', username: 'o3', roles: ['user', 'operacao'] };
    const s = { _id: 's', username: 's', roles: ['user'] };
    const v = checkDirect('call', o1, [o2], rules);
    expect(callStartBlockMessage(v, o1, rules)).toBe('Você não pode ligar para @o2: chamadas entre vocês estão bloqueadas pela política da empresa.');
    const v3 = checkDirect('call', o3, [o1, o2], rules);
    expect(v3.pair).toEqual(['o3', 'o1']);
    expect(callStartBlockMessage({ allowed: false, action: 'call', pair: ['o1', 'o2'] }, o3, rules)).toBe(
      'Esta chamada juntaria @o1 e @o2, que não podem conversar em particular. Inicie a chamada em um canal ou grupo com um supervisor.',
    );
    const vs = checkDirect('call', s, [o1, o2], rules);
    expect(callStartBlockMessage(vs, s, rules)).toBe(
      'Esta conversa reúne @o1 e @o2, que não podem conversar em particular. Só quem tem a permissão de conversa entre pessoas restritas inicia chamadas aqui. Use um grupo privado.',
    );
    expect(callStartBlockMessage({ allowed: true, action: 'call' }, s, rules)).toBe('');
  });

  it('callScopeOf, guardModeFor e isTransmissionRoom para DM a dois, DM em grupo, canal, grupo, discussão, time privado e aviso', () => {
    expect(callScopeOf({ t: 'd', uids: ['a', 'b'] })).toBe('direct');
    expect(callScopeOf({ t: 'd', uids: ['a', 'b', 'c'] })).toBe('group');
    expect(callScopeOf({ t: 'd', uids: ['a'] })).toBeNull();
    expect(callScopeOf({ t: 'c' })).toBe('group');
    expect(callScopeOf({ t: 'p' })).toBe('group');
    expect(guardModeFor({ t: 'c' }, 'pairs')).toBe('pairs');
    expect(guardModeFor({ t: 'c' }, 'strict')).toBe('strict');
    expect(guardModeFor({ t: 'p' }, 'pairs')).toBe('strict');
    expect(guardModeFor({ t: 'c', prid: 'pai' }, 'pairs')).toBe('strict');
    expect(guardModeFor({ t: 'c', privateTeam: true }, 'pairs')).toBe('strict');
    expect(guardModeFor({ t: 'd' }, 'pairs')).toBe('strict');
    expect(isTransmissionRoom({ notice: true })).toBe(true);
    expect(isTransmissionRoom({ ro: true })).toBe(true);
    expect(isTransmissionRoom({ broadcast: true })).toBe(true);
    expect(isTransmissionRoom({})).toBe(false);
  });

  it('formatCallClock, formatCallDuration, callPeopleLabel, callNamesLabel com nomes repetidos (Ana S.) e callCardSummary', () => {
    expect([30, 725, 3729, -5, 0, 59.9, NaN].map(formatCallClock)).toEqual(['0:30', '12:05', '1:02:09', '0:00', '0:00', '0:59', '0:00']);
    expect([42, 0, 60, 300, 3599, 3600, 4320, -1].map(formatCallDuration)).toEqual(['42 s', '0 s', '1 min', '5 min', '59 min', '1 h', '1 h 12 min', '0 s']);
    expect([1, 12, 0].map(callPeopleLabel)).toEqual(['1 pessoa', '12 pessoas', '0 pessoas']);
    expect(callUserLabel({ _id: '1', username: 'ana', name: 'Ana Souza' })).toBe('Ana Souza');
    expect(callUserLabel({ _id: '1', username: 'ana' })).toBe('@ana');
    const ana = { _id: '1', username: 'ana', name: 'Ana Souza' };
    const bruno = { _id: '2', username: 'bruno', name: 'Bruno Lima' };
    const carla = { _id: '3', username: 'carla', name: 'Carla Dias' };
    const anaP = { _id: '4', username: 'anap', name: 'Ana Pereira' };
    const anaSo = { _id: '5', username: 'ana2', name: 'Ana' };
    const semNome = { _id: '6', username: 'davi' };
    expect(callNamesLabel([], 0)).toBe('Ninguém na chamada');
    expect(callNamesLabel([ana], 1)).toBe('Ana');
    expect(callNamesLabel([ana, bruno], 2)).toBe('Ana e Bruno');
    expect(callNamesLabel([ana, bruno, carla], 3)).toBe('Ana, Bruno e Carla');
    expect(callNamesLabel([ana, bruno, carla, anaP, semNome], 5)).toBe('Ana, Bruno e mais 3');
    expect(callNamesLabel([ana, anaP], 2)).toBe('Ana S. e Ana P.');
    expect(callNamesLabel([ana, anaSo, semNome], 3)).toBe('Ana S., @ana2 e @davi');
    expect(callNamesLabel([ana, anaP, carla], 12)).toBe('Ana S., Ana P. e mais 10');
    expect(callNamesLabel([], 4)).toBe('4 pessoas');
    const card: CallCard = { _id: 'c', kind: 'video', scope: 'group', status: 'ended', listenOnly: false, startedAt: '', endedAt: '', duration: 2520, participantsCount: 0, sample: [], peak: 9, totalJoined: 12, endedReason: null, endedBy: null };
    expect(callCardSummary(card)).toBe('Chamada encerrada · 42 min · 12 pessoas');
    expect(callCardSummary({ ...card, listenOnly: true })).toBe('Transmissão encerrada · 42 min · 12 pessoas');
    expect(callCardSummary({ ...card, status: 'ongoing' })).toBe('Chamada em andamento');
    expect(callCardSummary({ ...card, status: 'ongoing', listenOnly: true })).toBe('Transmissão ao vivo');
    expect(callGuardText(30)).toBe('Pela política da empresa, a conversa continua quando um supervisor entrar. Encerra em 0:30.');
  });

  it('callEndedReasonText tem texto para cada motivo da tabela', () => {
    const by = { _id: '9', username: 'sup', name: 'Supervisora Rita' };
    const texts: Record<CallEndReason, string> = {
      moderator: 'Encerrada por Supervisora Rita',
      restricted: 'Encerrada: só restaram pessoas que não podem conversar em particular',
      alone: 'Encerrada: uma pessoa ficou sozinha por 30 min',
      'max-duration': 'Encerrada: atingiu o limite de duração',
      room: 'Encerrada: a sala foi arquivada',
      readonly: 'Encerrada: a sala passou a aceitar só quem publica',
      'no-speaker': 'Encerrada: ninguém com a palavra por 5 min',
      sfu: 'Encerrada: o servidor de chamadas ficou indisponível',
      hangup: '',
      empty: '',
      dropped: '',
      'no-answer': '',
    };
    for (const [reason, text] of Object.entries(texts)) expect(callEndedReasonText(reason as CallEndReason, by), reason).toBe(text);
    expect(callEndedReasonText('moderator', { _id: '9', username: 'sup' })).toBe('Encerrada por @sup');
    expect(callEndedReasonText('moderator')).toBe('');
    expect(callEndedReasonText(null)).toBe('');
  });

  it('callTrackNameOk aceita só vazio e os quatro nomes fixos', () => {
    expect([...CALL_TRACK_NAMES]).toEqual(['microphone', 'camera', 'screen_share', 'screen_share_audio']);
    for (const n of ['', ...CALL_TRACK_NAMES]) expect(callTrackNameOk('camera', n), n).toBe(true);
    for (const n of ['oi @ana', 'Camera', 'microphone ', 'câmera', 'x'.repeat(300)]) expect(callTrackNameOk('microphone', n), n).toBe(false);
    expect(callTrackNameOk('unknown', '')).toBe(false);
    expect(callTrackNameOk('unknown', 'microphone')).toBe(false);
  });
});
