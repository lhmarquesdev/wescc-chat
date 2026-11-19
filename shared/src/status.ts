// Status da pessoa: os quatro de base e os personalizados (Administração › Status do usuário). O tipo de um status
// personalizado decide o comportamento: "Ocupado" silencia as notificações, "Invisível" aparece offline.
import type { UserStatus } from './index'; // só tipo: index.ts importa CustomUserStatus daqui também
import { foldText } from './search';

export interface CustomUserStatus {
  _id: string;
  name: string;
  statusType: UserStatus;
  usersCount?: number; // só para quem gerencia (manage-user-status)
}

export const BASE_STATUS_LABEL: Record<UserStatus, string> = { online: 'Disponível', away: 'Ausente', busy: 'Ocupado', offline: 'Offline' };
// O tipo como a pessoa escolhe (no menu e na Administração): offline escolhido é "Invisível".
export const STATUS_TYPE_LABEL: Record<UserStatus, string> = { ...BASE_STATUS_LABEL, offline: 'Invisível' };
export const STATUS_TYPES: UserStatus[] = ['online', 'away', 'busy', 'offline'];
export const MAX_CUSTOM_STATUSES = 30;
export const STATUS_NAME_MAX = 40;
export const RESERVED_STATUS_NAMES = ['Disponível', 'Ausente', 'Ocupado', 'Offline', 'Invisível'];
// Mensagem de status: 120 como o maxLength dos campos (unidades UTF-16), cortada sem partir um emoji no meio (a metade
// que sobrava virava "�").
export const STATUS_TEXT_MAX = 120;
export function clampStatusText(s: string): string {
  if (s.length <= STATUS_TEXT_MAX) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > STATUS_TEXT_MAX) break;
    out += ch;
  }
  return out;
}
const RESERVED = new Set(RESERVED_STATUS_NAMES.map(foldText));

export const isStatusType = (v: unknown): v is UserStatus => typeof v === 'string' && (STATUS_TYPES as string[]).includes(v);

// Ocupado (ou um personalizado do tipo ocupado) escolhido: sem notificação de mensagem, som, push nem e-mail.
// Vale o status escolhido (status_default), não o real: este vira offline quando a última aba fecha.
export const silencesNotifications = (statusDefault?: string | null) => statusDefault === 'busy';

// Evento "user" sobre a própria pessoa: os que vão para todos (perfil, Administração › Usuários, LDAP) trazem o status
// personalizado como os outros o veem (nada enquanto a pessoa aparece offline). Só o evento da própria escolha, que
// traz statusDefault, diz qual ela escolheu; sem ele, o statusCustom do evento não muda o que a aba já sabe.
export function selfUserPatch<T extends { statusDefault?: unknown; statusCustom?: unknown }>(u: T): Partial<T> {
  if (u.statusDefault !== undefined) return u;
  const { statusCustom: _hidden, ...rest } = u;
  return rest as Partial<T>;
}

// Rótulo da presença: o nome do status personalizado só enquanto o status real é o tipo dele
// (ausência automática ou offline mostram o rótulo base); id desconhecido também cai no base.
export function presenceLabel(p: { status: UserStatus; statusCustom?: string | null }, list: CustomUserStatus[]): string {
  return shownCustomStatus(p, list)?.name ?? BASE_STATUS_LABEL[p.status] ?? p.status;
}

// O status personalizado que vale agora (o tipo dele é o status real), ou undefined.
export function shownCustomStatus(p: { status: UserStatus; statusCustom?: string | null }, list: CustomUserStatus[]): CustomUserStatus | undefined {
  const custom = p.statusCustom ? list.find((s) => s._id === p.statusCustom) : undefined;
  return custom && custom.statusType === p.status ? custom : undefined;
}

// Linha de status com mensagem: o personalizado não some atrás dela ("Em atendimento · até as 15h"); com um status de
// base, só a mensagem (o ponto colorido já diz o resto). Sem mensagem, o rótulo.
export const statusLine = (label: string, custom: boolean, text?: string | null) => (text ? (custom ? `${label} · ${text}` : text) : label);

// NFC, espaços colapsados, 1..40, com pelo menos uma letra ou número; não pode ser (sem acento) um nome reservado.
// Caracteres invisíveis (largura zero, controle) saem antes: um nome só com eles virava uma linha vazia no menu, e
// "Em pausa" com um deles no meio passava por outro nome. Fica só o ZWJ entre dois emojis, onde ele os junta
// (👩‍💻); colado numa letra ("Ocupado" + ZWJ) ele sai também.
const LOOSE_ZWJ = /(^|[^\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200d|\u200d(?!\p{Extended_Pictographic})/gu;
export function normalizeStatusName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; error: string; code: 'error-invalid-name' | 'error-status-name-reserved' } {
  const name = typeof raw === 'string' ? raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? ' ' : c === '\u200d' ? c : '')).replace(LOOSE_ZWJ, '$1').replace(/\s+/g, ' ').trim() : '';
  const len = [...name].length;
  const typed = typeof raw === 'string' && !!raw.trim();
  if (len > STATUS_NAME_MAX || (len < 1 && !typed)) return { ok: false, code: 'error-invalid-name', error: `O nome precisa ter de 1 a ${STATUS_NAME_MAX} caracteres.` };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, code: 'error-invalid-name', error: 'Use letras ou números no nome.' };
  if (RESERVED.has(foldText(name))) return { ok: false, code: 'error-status-name-reserved', error: 'Esse nome já é de um status padrão.' };
  return { ok: true, name };
}

// Por tipo (STATUS_TYPES) e nome (pt-BR).
export function sortStatuses<T extends CustomUserStatus>(list: T[]): T[] {
  // numeric: "Status 2" vem antes de "Status 10"; sensitivity base: maiúsculas e acentos não separam nomes iguais.
  return [...list].sort(
    (a, b) => STATUS_TYPES.indexOf(a.statusType) - STATUS_TYPES.indexOf(b.statusType) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }),
  );
}
