// Regras e textos das chamadas: o servidor usa para decidir e a web, para prever e rotular.

import type { CallCard, CallEndReason, CallGuardMode, CallGuardState, CallScope, CallSource, CallViewerGuard, UserRef } from './index';
import { blockedPair, directBlockMessage, isExempt, isRestricted, type DirectParty, type DirectRules, type DirectVerdict } from './direct';

export const CALL_LIMITS = {
  tokenSeconds: 60, // token de entrada: abre a primeira conexão; "entrando" conta como presente por esse tempo
  selfTestTokenSeconds: 300,
  emptyGraceSeconds: 30, // todos caíram: espera antes de encerrar
  rejoinSeconds: 30, // [v1b] a dois pelo SFU: quem caiu pode voltar nesse tempo
  clientLeftSeconds: 8, // [v1b] a dois: o outro lado fechou o app
  chaperoneGraceSeconds: 8, // acompanhante que caiu (sem desligar) ainda conta
  aloneMinutes: 30, // uma pessoa sozinha por esse tempo: a chamada acaba
  speakerlessMinutes: 5, // [v1b] transmissão sem ninguém com a palavra
  sfuMissingSeconds: 90, // sala sumiu do servidor de chamadas e ninguém voltou
  reconcileSeconds: 10,
  ringPerAction: 10,
  ringActionsPerMinute: 5,
  ringAllMaxMembers: 10, // "Chamar todos" só em salas com até 10 outras pessoas
  inviteEveryMinutes: 10, // "Avisar a sala"
  sampleSize: 5,
  quietAbove: 8, // acima disso, entradas e saídas sem aviso nem som
  lowResAbove: 8, // acima disso, câmera em 360p
  joinMutedFrom: 4, // já há 4 pessoas: entra com o microfone desligado
  tilesDesktop: 9,
  tilesPhone: 4,
  speakerStickyMs: 1500,
  screenBlockSeconds: 60, // moderador parou a tela
} as const;

// Nomes fixos das faixas: o nome é visível para todos na sala, então texto livre seria um canal escondido.
export const CALL_TRACK_NAMES: readonly string[] = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
export function callTrackNameOk(source: CallSource | 'unknown', name: string): boolean {
  return source !== 'unknown' && (name === '' || CALL_TRACK_NAMES.includes(name));
}

// direct: DM a dois; group: DM com mais pessoas, canal, grupo, time, discussão; null: sem chamadas (Atendimento).
export function callScopeOf(r: { t: string; uids?: string[] | null }): CallScope | null {
  if (r.t === 'c' || r.t === 'p') return 'group';
  if (r.t !== 'd') return null;
  const n = r.uids?.length ?? 0;
  // DM consigo mesmo (uma pessoa só) não tem com quem falar.
  return n === 2 ? 'direct' : n > 2 ? 'group' : null;
}

// Sala onde só alguns falam: somente leitura, de avisos ou com a lista de membros oculta.
export function isTransmissionRoom(r: { ro?: boolean; notice?: boolean; broadcast?: boolean }): boolean {
  return !!(r.ro || r.notice || r.broadcast);
}

// Salas privadas são sempre estritas; canais públicos seguem a configuração.
export function guardModeFor(r: { t: string; prid?: string | null; privateTeam?: boolean }, publicMode: CallGuardMode): CallGuardMode {
  return r.t === 'c' && !r.prid && !r.privateTeam ? publicMode : 'strict';
}

export interface GuardPerson extends DirectParty {
  speaks: boolean; // pode publicar nesta chamada agora (ou poderia, ao entrar)
  arriving?: boolean; // tem token de entrada, mas ainda não conectou
}

export interface CallPresenceVerdict {
  allowed: boolean;
  pair?: [string, string]; // usernames
}

// Bloqueia quando ninguém presente é acompanhante (sem restrição ou isento) e duas pessoas restritas que podem
// falar formam um par. No modo pairs (canais públicos), três ou mais restritas falando já são conversa de equipe, mas
// só contam as conectadas: quem ainda está entrando forma par na hora e nunca desfaz um par antes de chegar.
export function callPresenceVerdict(people: GuardPerson[], rules: DirectRules, mode: CallGuardMode): CallPresenceVerdict {
  if (!rules.restrictedRoles.length) return { allowed: true };
  if (people.some((p) => !isRestricted(p, rules) || isExempt(p, rules))) return { allowed: true };
  const speakers = people.filter((p) => p.speaks);
  if (mode === 'pairs' && speakers.filter((p) => !p.arriving).length >= 3) return { allowed: true };
  const pair = blockedPair(speakers, rules);
  return pair ? { allowed: false, pair: [pair[0].username, pair[1].username] } : { allowed: true };
}

// A web prevê a recusa da trava só com o resumo da chamada; o servidor decide de verdade.
export function predictJoinBlocked(g: CallGuardState | undefined, viewer: CallViewerGuard | undefined): boolean {
  if (!g || !viewer || !viewer.speaks || !viewer.restricted || viewer.exempt || g.chaperone) return false;
  if (g.mode === 'pairs' && (g.connectedSpeakers ?? g.restrictedSpeakers) + 1 >= 3) return false;
  return g.restrictedSpeakers >= 1;
}

// Texto da recusa ao iniciar (checkDirect('call', ...)).
export function callStartBlockMessage(v: DirectVerdict, viewer: DirectParty, rules: DirectRules): string {
  if (v.allowed || !v.pair) return '';
  const [a, b] = v.pair;
  if (a === viewer.username || b === viewer.username) return directBlockMessage(v, viewer.username);
  if (isRestricted(viewer, rules)) return `Esta chamada juntaria @${a} e @${b}, que não podem conversar em particular. Inicie a chamada em um canal ou grupo com um supervisor.`;
  return `Esta conversa reúne @${a} e @${b}, que não podem conversar em particular. Só quem tem a permissão de conversa entre pessoas restritas inicia chamadas aqui. Use um grupo privado.`;
}

export const CALL_GUARD_TITLE = 'Aguardando um supervisor';
export const CALL_GUARD_JOIN =
  'Você não pode entrar agora: na chamada só há pessoas que não podem conversar em particular com você. Aguarde um supervisor entrar.';
export const CALL_GUARD_ENDED = 'A chamada foi encerrada: só restaram pessoas que não podem conversar em particular.';
export const CALL_GUARD_CLEARED = 'Um supervisor entrou. Microfones e câmeras liberados.';
export const CALL_GUARD_ROOM = 'A chamada está pausada até um supervisor entrar.'; // faixa da sala

export function callGuardText(secondsLeft: number): string {
  return `Pela política da empresa, a conversa continua quando um supervisor entrar. Encerra em ${formatCallClock(secondsLeft)}.`;
}

const wholeSeconds = (s: number) => Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
const pad2 = (n: number) => String(n).padStart(2, '0');

// 0:30 · 12:05 · 1:02:09
export function formatCallClock(seconds: number): string {
  const s = wholeSeconds(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

// 42 s · 5 min · 1 h · 1 h 12 min
export function formatCallDuration(seconds: number): string {
  const s = wholeSeconds(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// 1 pessoa · 12 pessoas
export function callPeopleLabel(n: number): string {
  return n === 1 ? '1 pessoa' : `${n} pessoas`;
}

export function callUserLabel(u: UserRef): string {
  return u.name || '@' + u.username;
}

const nameWords = (u: UserRef) => (u.name ?? '').trim().split(/\s+/).filter(Boolean);

// Ana · Ana e Bruno · Ana, Bruno e Carla · Ana, Bruno e mais 3
export function callNamesLabel(users: UserRef[], total: number): string {
  if (total === 0) return 'Ninguém na chamada';
  const all = total <= 3 && users.length >= total;
  const shown = users.slice(0, all ? total : 2);
  if (!shown.length) return callPeopleLabel(total);
  const first = shown.map((u) => nameWords(u)[0] ?? null);
  const labels = shown.map((u, i) => {
    const w = first[i];
    if (!w) return '@' + u.username;
    const key = w.toLocaleLowerCase('pt-BR');
    // Dois com o mesmo primeiro nome: a inicial do sobrenome desfaz a dúvida.
    if (!first.some((x, j) => j !== i && x?.toLocaleLowerCase('pt-BR') === key)) return w;
    const words = nameWords(u);
    return words.length > 1 ? `${w} ${words[words.length - 1][0].toLocaleUpperCase('pt-BR')}.` : '@' + u.username;
  });
  if (all) return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
  return `${labels.join(', ')} e mais ${total - shown.length}`;
}

export function callEndedReasonText(reason: CallEndReason | null, by?: UserRef | null): string {
  switch (reason) {
    case 'moderator':
      return by ? `Encerrada por ${callUserLabel(by)}` : '';
    case 'restricted':
      return 'Encerrada: só restaram pessoas que não podem conversar em particular';
    case 'alone':
      return 'Encerrada: uma pessoa ficou sozinha por 30 min';
    case 'max-duration':
      return 'Encerrada: atingiu o limite de duração';
    case 'room':
      return 'Encerrada: a sala foi arquivada';
    case 'readonly':
      return 'Encerrada: a sala passou a aceitar só quem publica';
    case 'no-speaker':
      return 'Encerrada: ninguém com a palavra por 5 min';
    case 'sfu':
      return 'Encerrada: o servidor de chamadas ficou indisponível';
    default:
      return '';
  }
}

// "Chamada encerrada · 42 min · 12 pessoas"
export function callCardSummary(card: CallCard): string {
  if (card.status === 'ongoing') return card.listenOnly ? 'Transmissão ao vivo' : 'Chamada em andamento';
  return `${card.listenOnly ? 'Transmissão encerrada' : 'Chamada encerrada'} · ${formatCallDuration(card.duration ?? 0)} · ${callPeopleLabel(card.totalJoined)}`;
}
