import type { Message, Room, Subscription } from '@shared/index';

export function roomPath(r: { _id?: string; rid?: string; t: string }) {
  const id = r.rid ?? r._id;
  const base = r.t === 'd' ? 'direct' : r.t === 'p' ? 'group' : r.t === 'l' ? 'live' : 'channel';
  return `/${base}/${id}`;
}

export function roomIcon(r: { t: string; prid?: string | null; teamMain?: boolean }) {
  if (r.prid) return '💬';
  if (r.teamMain) return '👥';
  if (r.t === 'p') return '🔒';
  if (r.t === 'd') return '@';
  if (r.t === 'l') return '🎧';
  return '#';
}

export function roomDisplayName(sub?: Subscription | null, room?: Room | null) {
  return sub?.fname || sub?.name || room?.fname || room?.name || (room?.usernames ?? []).join(', ') || '';
}

const dtf = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const formatTime = (iso: string) => dtf.format(new Date(iso));
export const formatDateTime = (iso?: string | null) => (iso ? fullFmt.format(new Date(iso)) : '—');

export function formatDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return dayFmt.format(d);
}

export function formatRelative(iso?: string | null) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

export function formatBytes(n?: number) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Texto das mensagens de sistema.
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
      return `${m.msg} agora é ${roleLabel(m.role)} (por ${u})`;
    case 'subscription-role-removed':
      return `${m.msg} deixou de ser ${roleLabel(m.role)} (por ${u})`;
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
      return `${m.call?.kind === 'video' ? '🎥 Chamada de vídeo' : '📞 Chamada de voz'} · ${formatDuration(m.call?.duration ?? 0)}`;
    case 'call_missed': {
      const what = m.call?.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz';
      const why: Record<string, string> = { missed: 'não atendida', declined: 'recusada', canceled: 'cancelada', busy: 'não atendida (ocupado)' };
      return `📵 ${what} de ${u} ${why[m.call?.status] ?? 'não atendida'}`;
    }
    case 'livechat_navigation_history':
      return `Visitante navegou para ${m.msg}`;
    default:
      return m.msg;
  }
}

export function roleLabel(role?: string) {
  return ({ owner: 'dono', moderator: 'moderador', leader: 'líder' } as Record<string, string>)[role ?? ''] ?? role ?? '';
}

export const STATUS_LABEL: Record<string, string> = { online: 'Online', away: 'Ausente', busy: 'Ocupado', offline: 'Offline' };
