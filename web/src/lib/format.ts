import type { Message, Room, Subscription } from '@shared/index';
import type { IconName } from '../components/icons';

export function roomPath(r: { _id?: string; rid?: string; t: string }) {
  const id = r.rid ?? r._id;
  const base = r.t === 'd' ? 'direct' : r.t === 'p' ? 'group' : r.t === 'l' ? 'live' : 'channel';
  return `/${base}/${id}`;
}

type RoomKind = { t: string; prid?: string | null; teamMain?: boolean; notice?: boolean };

// Ícone do tipo da sala para <Icon name={roomIconName(r)} />. A DM sem avatar usa room-direct.
export function roomIconName(r: RoomKind): IconName {
  if (r.prid) return 'room-discussion';
  if (r.teamMain) return 'room-team';
  if (r.notice) return 'room-notice';
  if (r.t === 'p') return 'room-private';
  if (r.t === 'd') return 'room-direct';
  if (r.t === 'l') return 'room-livechat';
  return 'room-channel';
}

export function roomDisplayName(sub?: Subscription | null, room?: Room | null) {
  return sub?.fname || sub?.name || room?.fname || room?.name || (room?.usernames ?? []).join(', ') || '';
}

const dtf = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const formatTime = (iso: string) => dtf.format(new Date(iso));
// "22/10/2026 04:48", sem a vírgula que o Intl põe entre a data e a hora.
export const formatDateTime = (iso?: string | null) => (iso ? fullFmt.format(new Date(iso)).replace(', ', ' ') : '—');

export function formatDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  // "segunda-feira, 20 de outubro"; o ano só quando não é o atual.
  return (d.getFullYear() === today.getFullYear() ? dayFmt : dayYearFmt).format(d);
}

const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const shortDateYear = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

// "agora", "há 3 min", "há 2 h", "ontem", "há 3 dias", "em 16/10" (o ano só quando não é o atual).
// Sempre um adjunto de tempo, para ler bem sozinho e depois de um rótulo: "última há 3 min",
// "Conversa iniciada em 15/10". Os dias são de calendário, como os separadores de formatDay.
export function formatRelative(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const m = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  // round: um dia com mudança de horário tem 23 ou 25 h.
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return `há ${Math.min(23, Math.round(m / 60))} h`;
  if (days === 1) return 'ontem';
  if (days < 7) return `há ${days} dias`;
  return `em ${(d.getFullYear() === now.getFullYear() ? shortDate : shortDateYear).format(d)}`;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

const dec1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const dec2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

// "14,5 KB", com vírgula decimal.
export function formatBytes(n?: number) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${dec1.format(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${dec1.format(n / 1024 ** 2)} MB`;
  return `${dec2.format(n / 1024 ** 3)} GB`;
}

// "1 tópico", "2 tópicos", com o número no formato pt-BR.
export function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}

// Contadores (.badge): acima de 99 mostra "99+".
export const badgeCount = (n: number) => (n > 99 ? '99+' : String(n));

const andList = new Intl.ListFormat('pt-BR', { type: 'conjunction' });

// "Alice", "Alice e Bruno", "Alice, Bruno e Carla", "Alice, Bruno e mais 3": reações, quem está digitando,
// entradas agrupadas. Nunca "e mais 1": com um nome a mais do que max, mostra todos.
export function nameList(names: string[], max = 2) {
  if (names.length <= max + 1) return andList.format(names);
  return `${names.slice(0, max).join(', ')} e mais ${(names.length - max).toLocaleString('pt-BR')}`;
}

// Texto das mensagens de sistema, sem ícone: o ícone vem de systemIcon().
export function systemText(m: Message & Record<string, any>): string {
  const u = m.u.username;
  switch (m.t) {
    case 'uj':
      return `${u} entrou na sala`;
    case 'ul':
      return `${u} saiu da sala`;
    case 'au':
      return `${m.msg} foi adicionado por ${u}`;
    case 'ru':
      return `${m.msg} foi removido por ${u}`;
    case 'r':
      return `${u} renomeou a sala para ${m.msg}`;
    case 'room_changed_topic':
      return m.msg ? `${u} alterou o tópico para: ${m.msg}` : `${u} removeu o tópico`;
    case 'room_changed_description':
      return `${u} alterou a descrição`;
    case 'room_changed_announcement':
      return `${u} alterou o anúncio`;
    case 'room_changed_privacy':
      return `${u} tornou a sala ${m.msg === 'public' ? 'pública' : 'privada'}`;
    case 'room-set-read-only':
      return `${u} tornou a sala somente leitura`;
    case 'room-removed-read-only':
      return `${u} permitiu escrita na sala`;
    case 'room-set-notice':
      return `${u} transformou a sala em canal de avisos`;
    case 'room-removed-notice':
      return `${u} transformou o canal de avisos em sala comum`;
    case 'room-archived':
      return `${u} arquivou a sala`;
    case 'room-unarchived':
      return `${u} desarquivou a sala`;
    case 'room_e2e_enabled':
      return `${u} ativou a criptografia ponta a ponta`;
    case 'room_e2e_disabled':
      return `${u} desativou a criptografia ponta a ponta`;
    case 'user-muted':
      return `${m.msg} foi silenciado por ${u}`;
    case 'user-unmuted':
      return `${m.msg} deixou de ser silenciado por ${u}`;
    case 'subscription-role-added':
      return `${m.msg} agora é ${roleLabel(m.role).toLowerCase()} (por ${u})`;
    case 'subscription-role-removed':
      return `${m.msg} deixou de ser ${roleLabel(m.role).toLowerCase()} (por ${u})`;
    case 'message_pinned':
      return `${u} fixou uma mensagem`;
    case 'discussion-created':
      return `${u} iniciou a discussão "${m.msg}"`;
    case 'user-added-room-to-team':
      return `${u} adicionou ${m.msg} ao time`;
    case 'user-removed-room-from-team':
      return `${u} removeu ${m.msg} do time`;
    case 'user-converted-to-team':
      return `${u} converteu a sala em time`;
    case 'user-converted-to-channel':
      return `${u} converteu o time em canal`;
    case 'rm':
      return 'Mensagem removida';
    case 'livechat-started':
      return 'Atendimento iniciado';
    case 'livechat-close':
      if (!m.u._id || m.closer === 'visitor' || m.closer === 'system') return `Atendimento encerrado${m.msg ? `: ${m.msg}` : ''}`;
      return `${u} encerrou o atendimento${m.msg ? `: ${m.msg}` : ''}`;
    case 'livechat_transfer_history': {
      const d = m.transferData ?? {};
      const by = d.transferredBy?.username ?? u;
      const note = d.comment ? ` — "${d.comment}"` : '';
      if (d.scope === 'agent') return `${by} transferiu o atendimento para ${d.transferredTo?.name || d.transferredTo?.username}${note}`;
      if (d.scope === 'department') return `${by} transferiu o atendimento para o departamento ${d.nextDepartment?.name}${note}`;
      if (d.scope === 'queue') return `${by} devolveu o atendimento para a fila`;
      return `Atendimento transferido${note}`;
    }
    case 'livechat_queue':
      return m.msg;
    case 'omnichannel_placed_chat_on_hold':
      return `${u} colocou o atendimento em espera`;
    case 'omnichannel_on_hold_chat_resumed':
      return m.u._id ? `${u} retomou o atendimento` : 'O visitante retomou o atendimento';
    case 'call_ended':
      return `${m.call?.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'} · ${formatDuration(m.call?.duration ?? 0)}`;
    case 'call_missed': {
      const what = m.call?.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz';
      const why: Record<string, string> = { missed: 'não atendida', declined: 'recusada', canceled: 'cancelada', busy: 'não atendida (ocupado)' };
      return `${what} de ${u} ${why[m.call?.status] ?? 'não atendida'}`;
    }
    case 'livechat_navigation_history':
      return `Visitante navegou para ${m.msg}`;
    default:
      return m.msg;
  }
}

// Ícone da mensagem de sistema (na calha, no lugar do avatar), ou null quando ela não tem.
export function systemIcon(m: Message & Record<string, any>): IconName | null {
  switch (m.t) {
    case 'uj':
      return 'sys-join';
    case 'ul':
      return 'sys-leave';
    case 'au':
      return 'sys-added';
    case 'ru':
      return 'sys-removed';
    case 'r':
    case 'room_changed_topic':
    case 'room_changed_description':
    case 'room_changed_announcement':
      return 'sys-renamed';
    case 'room_changed_privacy':
      return m.msg === 'public' ? 'room-channel' : 'room-private';
    case 'room-set-read-only':
    case 'room-removed-read-only':
      return 'sys-settings';
    case 'room-set-notice':
    case 'room-removed-notice':
      return 'notice';
    case 'room-archived':
      return 'sys-archived';
    case 'room-unarchived':
      return 'unarchive';
    case 'room_e2e_enabled':
    case 'room_e2e_disabled':
      return 'sys-encrypted';
    case 'user-muted':
      return 'sys-muted';
    case 'user-unmuted':
      return 'unmute-user';
    case 'subscription-role-added':
    case 'subscription-role-removed':
      return 'sys-role';
    case 'message_pinned':
      return 'sys-pinned';
    case 'discussion-created':
      return 'room-discussion';
    case 'user-added-room-to-team':
    case 'user-removed-room-from-team':
    case 'user-converted-to-team':
    case 'user-converted-to-channel':
      return 'room-team';
    case 'livechat-started':
      return 'room-livechat';
    case 'livechat-close':
      return 'sys-closed';
    case 'livechat_transfer_history':
      return 'sys-transfer';
    case 'livechat_queue':
      return 'queue';
    case 'omnichannel_placed_chat_on_hold':
      return 'sys-hold';
    case 'omnichannel_on_hold_chat_resumed':
      return 'sys-resume';
    case 'call_ended':
      return m.call?.kind === 'video' ? 'call-video' : 'call-audio';
    case 'call_missed':
      return 'call-missed';
    case 'livechat_navigation_history':
      return 'link';
    default:
      return null;
  }
}

// Nome dos papéis (do workspace e da sala) para mostrar; um id desconhecido volta como veio (mostre em .mono).
export const ROLE_LABEL: Record<string, string> = {
  user: 'Usuário',
  admin: 'Administrador',
  bot: 'Bot',
  guest: 'Convidado',
  owner: 'Dono',
  moderator: 'Moderador',
  leader: 'Líder',
  publisher: 'Publicador',
  'livechat-agent': 'Agente de atendimento',
  'livechat-manager': 'Gestor de atendimento',
  'livechat-monitor': 'Monitor de atendimento',
  auditor: 'Auditor',
  'auditor-log': 'Auditor de logs',
  app: 'App',
  anonymous: 'Anônimo',
};

export function roleLabel(role?: string) {
  return ROLE_LABEL[role ?? ''] ?? role ?? '';
}

export const STATUS_LABEL: Record<string, string> = { online: 'Disponível', away: 'Ausente', busy: 'Ocupado', offline: 'Offline' };
// No menu do próprio usuário "offline" é ficar invisível.
export const MY_STATUS_LABEL: Record<string, string> = { ...STATUS_LABEL, offline: 'Invisível' };
