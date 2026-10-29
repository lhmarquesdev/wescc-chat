// O que as superfícies da sala mostram sobre chamadas: cabeçalho, faixa, cartão na conversa, linhas da página
// Chamadas e o selo de perdidas. Puro: os componentes leem o estado, chamam estas funções e desenham o resultado.

import type { Call, CallCard, RoomCallState } from './index';
import { CALL_GUARD_ROOM, callEndedReasonText, callNamesLabel, callPeopleLabel, callScopeOf, formatCallClock, formatCallDuration, isTransmissionRoom } from './calls';

export interface CallViewEnv {
  enabled: boolean; // Calls_Enabled
  secure: boolean; // isSecureContext
  inThisCall: boolean; // estou nesta chamada (store da chamada)
  inOtherCall: boolean; // estou em outra chamada
  otherTab: boolean; // a chamada está aberta em outra aba
  now: number; // serverNow()
}

// pending: ainda sem a resposta de calls.roomCall com a sala aberta (primeira abertura ou estado guardado de quando
// ela estava fechada); os botões já ficam e o clique confere com o servidor antes de agir.
export type HeaderView =
  | { kind: 'hidden' }
  | { kind: 'start'; transmission: boolean; reason?: string; pending?: boolean } // reason: botões aria-disabled
  | { kind: 'pill'; text: 'Entrar' | 'Ouvir' | 'Na chamada'; title: string; count: number; action: 'join' | 'open'; reason?: string; icon: 'call-live' | 'call-broadcast'; pending?: boolean };

// Recusas de iniciar que o cliente já conhece pela sala (os textos de startCheck no servidor).
export const CALL_NOT_MEMBER = 'Entre na sala para iniciar uma chamada.';
export const CALL_ARCHIVED = 'Esta sala está arquivada.';
export const CALL_MUTED = 'Você está silenciado nesta sala.';
const CLIENT_REASONS = [CALL_NOT_MEMBER, CALL_ARCHIVED, CALL_MUTED];

export interface StartGuessRoom {
  t: string;
  uids?: string[] | null;
  ro?: boolean;
  notice?: boolean;
  broadcast?: boolean;
  archived?: boolean;
  muted?: string[] | null; // rooms.info
  direct?: { canCall: boolean; callBlockedReason?: string } | null; // rooms.info de mensagens diretas
}

export interface StartGuessCtx {
  groupEnabled: boolean; // Calls_Group_Enabled
  canManage: boolean; // call-management com os papéis que o servidor conta (managementRoles)
  member: boolean; // tem a assinatura da sala
  username: string;
}

export type StartGuess = { show: false } | { show: true; reason?: string };

// Iniciar antes da resposta do servidor: as mesmas recusas de startCheck, na mesma ordem, com o que o cliente sabe.
// As que só o servidor conhece (servidor de chamadas, limite, regras de conversa direta em grupo) chegam com a resposta.
export function guessStart(room: StartGuessRoom, c: StartGuessCtx): StartGuess {
  const scope = callScopeOf(room);
  if (room.t === 'l' || !scope) return { show: false };
  if (scope === 'group' && !c.groupEnabled) return { show: false };
  if (room.t === 'd') {
    if (!c.member) return { show: true, reason: CALL_NOT_MEMBER };
    if (scope === 'direct') return room.direct?.canCall === false && room.direct.callBlockedReason ? { show: true, reason: room.direct.callBlockedReason } : { show: true };
    return isTransmissionRoom(room) ? { show: false } : { show: true };
  }
  if (isTransmissionRoom(room) || !c.canManage) return { show: false };
  if (!c.member) return { show: true, reason: CALL_NOT_MEMBER };
  if (room.archived) return { show: true, reason: CALL_ARCHIVED };
  if (room.muted?.includes(c.username)) return { show: true, reason: CALL_MUTED };
  return { show: true };
}

// settled false: o estado é provisório (sem resposta ainda, só o resumo da lista de chamadas vivas, ou guardado de
// quando a sala estava fechada e os sinais que pedem nova busca não chegaram a ela).
export interface HeaderGuess {
  start: StartGuess;
  settled: boolean;
}

export interface BannerView {
  title: string; // "Chamada em andamento" · "Transmissão ao vivo" · CALL_GUARD_ROOM
  meta: string; // nomes ou pessoas · cronômetro
  primary: { text: 'Entrar' | 'Ouvir'; reason?: string } | null;
  guard: boolean;
}

export interface CardView {
  live: boolean;
  icon: 'call-video' | 'call-audio' | 'call-broadcast';
  title: string;
  meta: string;
  people?: string; // "12 na chamada" · "120 ouvindo"
  reason?: string; // callEndedReasonText
  button?: { text: 'Entrar' | 'Ouvir' | 'Na chamada'; action: 'join' | 'open'; reason?: string };
}

export interface CallsRowView {
  title: string;
  meta: string;
  missed: boolean;
  redial: boolean;
  redialReason?: string;
}

// Sem HTTPS o navegador não libera câmera nem microfone: os botões ficam, com o motivo.
export const CALL_HTTPS_REASON = 'Chamadas exigem HTTPS. Peça ao administrador para ativar o HTTPS do chat.';

// Recusas que passam sozinhas, sem evento que avise (os textos de ERR.sfu e ERR.capacity do servidor): a sala aberta
// confere de novo de tempos em tempos enquanto uma delas aparece.
export const CALL_SFU_DOWN = 'O servidor de chamadas não está respondendo. Tente de novo em instantes ou avise o administrador.';
export const CALL_SERVER_FULL = 'O servidor de chamadas está no limite agora. Tente em alguns minutos.';
// Sem servidor de chamadas configurado (ERR.sfuNotConfigured): não passa sozinho, só quando o administrador configurar;
// a sala não fica conferindo. As chamadas a dois (P2P) seguem sem ele.
export const CALL_SFU_NOT_CONFIGURED = 'As chamadas em grupo ainda não foram configuradas. Peça ao administrador para ativá-las em Administração › Chamadas.';
export function callReasonPasses(reason: string | null | undefined): boolean {
  return reason === CALL_SFU_DOWN || reason === CALL_SERVER_FULL;
}

// Precisa perguntar ao servidor de novo: um motivo que passa sozinho em iniciar ou em entrar.
export function roomCallNeedsPoll(s: RoomCallState | null): boolean {
  if (!s) return false;
  if (!s.canStart && callReasonPasses(s.startBlockedReason)) return true;
  return !!s.call && !s.canJoin && callReasonPasses(s.joinBlockedReason);
}

// A entrada só muda pelo limite de pessoas quando a contagem passa por ele (para cima ou para baixo); entre uma
// coisa e outra o resumo da sala basta.
export function crossesCallLimit(before: number, after: number, limit: number): boolean {
  return limit > 0 && before !== after && (before >= limit) !== (after >= limit);
}

// Selo de perdidas: uma chamada a dois para mim que terminou sem eu atender (perdida, cancelada, ocupado...) pode
// ter virado perdida no servidor.
export function missedMayChange(call: Pick<Call, 'scope' | 'status' | 'callee'>, viewerId: string | null): boolean {
  return !!viewerId && call.scope === 'direct' && call.callee?._id === viewerId && call.status !== 'ringing' && call.status !== 'ongoing';
}

// Silenciar e liberar viram mensagem de sistema (a sala não traz a lista de silenciados).
export function isMuteNoticeFor(m: { t?: string | null; msg?: string | null }, username: string | null | undefined): boolean {
  return !!username && (m.t === 'user-muted' || m.t === 'user-unmuted') && m.msg === username;
}

// Ícone da chamada viva: o da transmissão quando ela é só para ouvir (pílula, faixa e "Em andamento").
export function liveCallIcon(call: Pick<Call, 'listenOnly'> | null | undefined): 'call-live' | 'call-broadcast' {
  return call?.listenOnly ? 'call-broadcast' : 'call-live';
}

const isLive = (c: Call | null | undefined): c is Call => !!c && (c.status === 'ongoing' || c.status === 'ringing');
const seconds = (fromIso: string | null | undefined, now: number) => (fromIso ? Math.max(0, (now - Date.parse(fromIso)) / 1000) : 0);

// Hora curta (10:24), a mesma da conversa.
const hm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const timeOf = (iso: string | null) => (iso ? hm.format(new Date(iso)) : '');

// Entrar ou ouvir, com o motivo quando a entrada está barrada (sem HTTPS ou recusa prevista pelo servidor).
function joinReason(s: RoomCallState, env: CallViewEnv): string | undefined {
  if (!env.secure) return CALL_HTTPS_REASON;
  return s.canJoin ? undefined : s.joinBlockedReason;
}

// Cabeçalho provisório (g.settled false): a chamada viva já conhecida vira a pílula; sem ela, iniciar segue o que o
// cliente sabe da sala. Um motivo guardado que o cliente não confere fica até a resposta (o clique confere antes).
function provisionalHeader(s: RoomCallState | null, env: CallViewEnv, g: HeaderGuess): HeaderView {
  const call = s?.call;
  if (s && isLive(call)) {
    const count = call.participantsCount;
    const icon = liveCallIcon(call);
    if (env.inThisCall || env.otherTab) return { kind: 'pill', text: 'Na chamada', title: 'Abrir a chamada', count, action: 'open', icon };
    if (call.scope === 'group') {
      const reason = joinReason(s, env);
      const pill = s.listenOnly
        ? ({ kind: 'pill', text: 'Ouvir', title: 'Ouvir a transmissão', count, action: 'join', icon, pending: true } as const)
        : ({ kind: 'pill', text: 'Entrar', title: 'Entrar na chamada', count, action: 'join', icon, pending: true } as const);
      return reason ? { ...pill, reason } : pill;
    }
  }
  if (!g.start.show) return { kind: 'hidden' };
  const kept = s && !s.canStart && s.startBlockedReason && !CLIENT_REASONS.includes(s.startBlockedReason) ? s.startBlockedReason : undefined;
  const reason = !env.secure ? CALL_HTTPS_REASON : (g.start.reason ?? kept);
  return reason ? { kind: 'start', transmission: false, pending: true, reason } : { kind: 'start', transmission: false, pending: true };
}

// g: o que o cliente já sabe da sala; com ele, o cabeçalho nasce certo antes da resposta do servidor (não pula) e
// segue certo enquanto o estado for provisório.
export function headerView(s: RoomCallState | null, env: CallViewEnv, g?: HeaderGuess): HeaderView {
  if (!env.enabled) return { kind: 'hidden' };
  if (g && !g.settled) return provisionalHeader(s, env, g);
  if (s === null) return { kind: 'hidden' };
  const call = s.call;
  if (isLive(call)) {
    const count = call.participantsCount;
    const icon = liveCallIcon(call);
    if (env.inThisCall || env.otherTab) return { kind: 'pill', text: 'Na chamada', title: 'Abrir a chamada', count, action: 'open', icon };
    // Chamada a dois tocando ou aberta em outro aparelho: não há em que entrar, os botões explicam.
    if (call.scope === 'direct') {
      if (s.hideStart) return { kind: 'hidden' };
      return { kind: 'start', transmission: false, reason: env.secure ? s.startBlockedReason : CALL_HTTPS_REASON };
    }
    const reason = joinReason(s, env);
    const pill = s.listenOnly
      ? ({ kind: 'pill', text: 'Ouvir', title: 'Ouvir a transmissão', count, action: 'join', icon } as const)
      : ({ kind: 'pill', text: 'Entrar', title: 'Entrar na chamada', count, action: 'join', icon } as const);
    return reason ? { ...pill, reason } : pill;
  }
  if (s.hideStart) return { kind: 'hidden' };
  const reason = !env.secure ? CALL_HTTPS_REASON : !s.canStart ? s.startBlockedReason : undefined;
  return reason ? { kind: 'start', transmission: s.transmission, reason } : { kind: 'start', transmission: s.transmission };
}

export function bannerView(s: RoomCallState | null, env: CallViewEnv, hiddenFor: string | null): BannerView | null {
  const call = s?.call;
  if (!s || !env.enabled || !isLive(call) || call.scope !== 'group') return null;
  if (env.inThisCall || env.otherTab || hiddenFor === call._id) return null;
  const clock = formatCallClock(seconds(call.createdAt, env.now));
  const who = call.listenOnly ? callPeopleLabel(call.participantsCount) : callNamesLabel(call.sample, call.participantsCount);
  const guard = !!call.guardUntil;
  const reason = joinReason(s, env);
  const primary: BannerView['primary'] = { text: s.listenOnly ? 'Ouvir' : 'Entrar' };
  if (reason) primary.reason = reason;
  return {
    title: guard ? CALL_GUARD_ROOM : call.listenOnly ? 'Transmissão ao vivo' : 'Chamada em andamento',
    meta: `${who} · ${clock}`,
    primary,
    guard,
  };
}

export function cardView(card: CallCard, s: RoomCallState | null, env: CallViewEnv, starterName: string): CardView {
  const video = card.kind === 'video';
  const icon: CardView['icon'] = card.listenOnly ? 'call-broadcast' : video ? 'call-video' : 'call-audio';
  if (card.status !== 'ongoing') {
    const out: CardView = {
      live: false,
      icon,
      title: card.listenOnly ? 'Transmissão encerrada' : video ? 'Chamada de vídeo encerrada' : 'Chamada de voz encerrada',
      meta: [formatCallDuration(card.duration ?? 0), callPeopleLabel(card.totalJoined), timeOf(card.endedAt)].filter(Boolean).join(' · '),
    };
    const reason = callEndedReasonText(card.endedReason, card.endedBy);
    if (reason) out.reason = reason;
    return out;
  }
  // O resumo da sala (call.room, a cada 2 s) é mais novo que o cartão (a cada 10 s).
  const same = s?.call && s.call._id === card._id ? s.call : null;
  const n = same ? same.participantsCount : card.participantsCount;
  const out: CardView = {
    live: true,
    icon,
    title: card.listenOnly ? 'Transmissão ao vivo' : video ? 'Chamada de vídeo em andamento' : 'Chamada de voz em andamento',
    meta: `Iniciada por ${starterName} · ${formatCallClock(seconds(card.startedAt, env.now))}`,
    people: card.listenOnly ? `${n} ouvindo` : `${n} na chamada`,
  };
  if (!env.enabled) return out;
  if (env.inThisCall || env.otherTab) out.button = { text: 'Na chamada', action: 'open' };
  else if (s && !same) {
    // A sala já não tem esta chamada viva: o cartão final chega em seguida, sem botão até lá.
  } else {
    const listen = same ? s!.listenOnly : card.listenOnly;
    const reason = !env.secure ? CALL_HTTPS_REASON : same && !s!.canJoin ? s!.joinBlockedReason : undefined;
    out.button = { text: listen ? 'Ouvir' : 'Entrar', action: 'join' };
    if (reason) out.button.reason = reason;
  }
  return out;
}

// Direção vista por quem pergunta, para as linhas a dois.
function directDir(call: Call, viewerId: string): { dir: string; missed: boolean; declined: boolean; outgoing: boolean } {
  const mine = call.mine;
  const outgoing = mine ? mine.direction === 'outgoing' : call.caller._id === viewerId;
  if (outgoing) return { dir: 'Feita', missed: false, declined: false, outgoing };
  const declined = mine ? mine.state === 'declined' : call.status === 'declined';
  const missed = mine ? mine.state === 'missed' : !declined && call.duration == null && call.status !== 'ended' && call.status !== 'ongoing';
  return { dir: missed ? 'Perdida' : declined ? 'Recusada' : 'Recebida', missed, declined, outgoing };
}

// Quem ligou e não foi atendido: o desfecho entra no lugar da duração.
const OUTCOME: Record<string, string> = { missed: 'não atendida', declined: 'recusada', canceled: 'cancelada', busy: 'ocupado' };

export function callsRowView(call: Call, viewerId: string, roomTitle: string): CallsRowView {
  const kind = call.listenOnly ? 'Transmissão' : call.kind === 'video' ? 'Vídeo' : 'Voz';
  if (call.scope === 'group') {
    const mine = call.mine;
    const missed = mine?.state === 'missed';
    const dir = call.caller._id === viewerId ? 'Iniciada por você' : missed ? 'Perdida' : mine?.state === 'declined' ? 'Recusada' : 'Você participou';
    const time = mine?.seconds ? formatCallDuration(mine.seconds) : '—';
    return { title: roomTitle, meta: `${dir} · ${kind} · ${time} · ${callPeopleLabel(call.totalJoined)}`, missed, redial: false };
  }
  const d = directDir(call, viewerId);
  const other = d.outgoing ? call.callee : call.caller;
  const title = other ? other.name || other.username : roomTitle;
  // "Perdida · não atendida" ou "Recusada · recusada" diriam a mesma coisa duas vezes.
  const extra = call.duration != null ? formatCallDuration(call.duration) : d.missed || d.declined ? '' : (OUTCOME[call.status] ?? '');
  const out: CallsRowView = { title, meta: [d.dir, kind, extra].filter(Boolean).join(' · '), missed: d.missed, redial: true };
  if (call.canCall === false) out.redialReason = call.callBlockedReason ?? 'Você não pode ligar para esta pessoa.';
  return out;
}

// Linha "Em andamento" da página Chamadas.
export function liveRowMeta(call: Call, now: number): string {
  return `Em grupo · ${callPeopleLabel(call.participantsCount)} · ${formatCallClock(seconds(call.createdAt, now))}`;
}

export function missedBadgeLabel(n: number): string {
  if (!(n > 0)) return '';
  return n === 1 ? '1 chamada perdida' : `${n} chamadas perdidas`;
}
