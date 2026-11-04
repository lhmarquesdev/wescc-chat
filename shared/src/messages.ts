// Encaminhar, mensagem de vídeo, enquetes, lembretes e envios agendados: limites e regras que o servidor e a web usam iguais.
import { isEncryptedMessage } from './dataExport';
import type { Message, RoomType, UserRef } from './index';

export const FORWARD_MAX_TARGETS = 10;
export const VIDEO_MESSAGE_MAX_SECONDS = 120;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_DEADLINE_MIN_MINUTES = 5;
export const POLL_DEADLINE_MAX_DAYS = 90;
export const REMINDERS_MAX = 200; // por pessoa
export const SCHEDULED_MAX = 100; // por pessoa (pendentes e que falharam)
export const SCHEDULE_LATE_MINUTES = 60; // servidor parado: atraso maior que isso não envia, avisa quem agendou
export const AHEAD_MIN_MS = 60_000; // lembrete e agendamento: pelo menos 1 minuto à frente
export const AHEAD_MAX_DAYS = 365;

// ---------- Criptografia ----------

// Até a criptografia ponta a ponta definir como recifrar no cliente, encaminhar, criar enquete, agendar e gravar vídeo
// ficam fora das salas criptografadas, e o aviso do lembrete nunca leva o conteúdo. Um lugar só para o E2E ajustar:
// a sala (rooms.encrypted) ou a própria mensagem cifrada (messages.e2e, isEncryptedMessage).
// m: qualquer mensagem (linha do banco ou Message da web); o campo e2e chega com o grupo da criptografia.
export function encryptedContent(room: { encrypted?: boolean | null } | null | undefined, m?: object | null): boolean {
  return !!room?.encrypted || (!!m && isEncryptedMessage(m as { e2e?: unknown }));
}

// ---------- Tipos ----------

// Origem de uma mensagem encaminhada (messages.extra.forward). Encaminhar de novo mantém a origem e soma hops.
export interface MessageForward {
  mid: string; // mensagem original
  rid: string;
  t: RoomType;
  roomName?: string; // só canal público fora de time privado; grupo e DM a web resolve pela inscrição de quem vê
  tmid?: string | null; // a original era resposta de tópico
  u: UserRef; // autor original (fotografia: continua igual se a conta mudar de nome ou sair)
  alias?: string; // apelido do autor (webhooks)
  ts: string; // hora da original
  hops: number; // 1 = encaminhada; 2+ = "Encaminhada várias vezes"
  comment?: string; // comentário de quem encaminhou (as menções da mensagem saem só daqui)
}

export interface MessagePoll {
  question: string;
  options: { id: string; text: string; votes: number }[]; // ids o1..o10, na ordem de criação
  voters: number; // pessoas que votaram
  multiple: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closedAt: string | null;
}

export interface MessageReminder {
  _id: string;
  messageId: string;
  rid: string;
  t: RoomType;
  roomName?: string; // canal ou grupo (fname || name); DM a web resolve pela inscrição
  remindAt: string;
  firedAt: string | null;
  message: Message | null; // null: apagada ou sem acesso
}

export interface ScheduledMessage {
  _id: string;
  rid: string;
  tmid: string | null;
  tshow: boolean;
  msg: string;
  ackRequired: boolean;
  sendAt: string;
  status: 'pending' | 'sending' | 'failed';
  error: string | null;
  createdAt: string;
  _updatedAt: string;
}

export interface PollInput {
  question: string;
  options: string[];
  multiple?: boolean;
  anonymous?: boolean;
  closesAt?: string | null;
}

// ---------- Validações ----------

// Tira espaços das pontas e as opções vazias (a web manda as linhas como estão).
export function cleanPollOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
}

export const POLL_ERRORS = {
  question: `Escreva a pergunta (até ${POLL_QUESTION_MAX} caracteres).`,
  count: `Uma enquete precisa de ${POLL_MIN_OPTIONS} a ${POLL_MAX_OPTIONS} opções.`,
  optionLength: `Cada opção pode ter até ${POLL_OPTION_MAX} caracteres.`,
  repeated: 'As opções não podem se repetir.',
  deadline: `O prazo precisa ficar entre ${POLL_DEADLINE_MIN_MINUTES} minutos e ${POLL_DEADLINE_MAX_DAYS} dias a partir de agora.`,
} as const;

// Qual campo o erro aponta (a web mostra o texto embaixo dele).
export type PollErrorField = 'question' | 'options' | 'deadline';

export function pollInputIssue(p: PollInput, now: Date): { field: PollErrorField; text: string } | null {
  const question = typeof p.question === 'string' ? p.question.trim() : '';
  if (!question || question.length > POLL_QUESTION_MAX) return { field: 'question', text: POLL_ERRORS.question };
  const options = cleanPollOptions(p.options);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return { field: 'options', text: POLL_ERRORS.count };
  if (options.some((o) => o.length > POLL_OPTION_MAX)) return { field: 'options', text: POLL_ERRORS.optionLength };
  const seen = new Set<string>();
  for (const o of options) {
    const k = o.toLocaleLowerCase('pt-BR');
    if (seen.has(k)) return { field: 'options', text: POLL_ERRORS.repeated };
    seen.add(k);
  }
  if (p.closesAt !== undefined && p.closesAt !== null && p.closesAt !== '') {
    const t = typeof p.closesAt === 'string' ? Date.parse(p.closesAt) : NaN;
    const min = now.getTime() + POLL_DEADLINE_MIN_MINUTES * 60_000;
    const max = now.getTime() + POLL_DEADLINE_MAX_DAYS * 86_400_000;
    if (!Number.isFinite(t) || t < min || t > max) return { field: 'deadline', text: POLL_ERRORS.deadline };
  }
  return null;
}

// null quando serve; senão o texto exato do erro (a web usa para desativar "Criar enquete").
export function pollInputError(p: PollInput, now: Date): string | null {
  return pollInputIssue(p, now)?.text ?? null;
}

export const AHEAD_ERROR = 'Escolha um horário entre 1 minuto e 1 ano a partir de agora.';

// Lembrete e agendamento.
export function aheadError(iso: unknown, now: Date): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return AHEAD_ERROR;
  if (t < now.getTime() + AHEAD_MIN_MS || t > now.getTime() + AHEAD_MAX_DAYS * 86_400_000) return AHEAD_ERROR;
  return null;
}

// ---------- Links ----------

// /channel/<rid>?msg=<id>; resposta de tópico abre o tópico: /channel/<rid>/thread/<tmid>. O mesmo caminho vai no push
// do lembrete e no "Abrir" da web.
export function messageLink(p: { rid: string; t: string; mid: string; tmid?: string | null }): string {
  const base = `/${p.t === 'd' ? 'direct' : p.t === 'p' ? 'group' : 'channel'}/${p.rid}`;
  return p.tmid ? `${base}/thread/${p.tmid}` : `${base}?msg=${p.mid}`;
}
