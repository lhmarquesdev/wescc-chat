// Texto das mensagens de sistema e formatos que a web e o servidor (exportações) mostram iguais. Saiu de
// web/src/lib/format.ts sem mudar o comportamento; a web reexporta com os mesmos nomes.
import type { CallCard, CallSummary, Message } from './index';
import { callCardSummary } from './calls';

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
  auditor: 'Auditor',
  'auditor-log': 'Auditor de logs',
  app: 'App',
  anonymous: 'Anônimo',
};

const defaultRoleLabel = (role?: string) => ROLE_LABEL[role ?? ''] ?? role ?? '';

// Nome de um papel para mostrar: o de ROLE_LABEL; num papel criado pelo administrador (operador, supervisor…), a
// descrição curta vira o nome; sem ela, o id com inicial maiúscula.
export function roleDisplayName(id: string, description?: string | null) {
  if (ROLE_LABEL[id]) return ROLE_LABEL[id];
  const d = description?.trim();
  return d && d.length <= 32 && !/[.!?]$/.test(d) ? d : id.charAt(0).toUpperCase() + id.slice(1);
}

// Texto das mensagens de sistema, sem ícone: o ícone vem de systemIcon() (web). Usa o nome de exibição de quem fez
// (m.u.name); quem recebeu a ação vem só como @usuário em m.msg, e nameOf troca pelo nome. roleLabelOf dá o nome do
// papel (a web passa o que também conhece os papéis criados pelo administrador).
export function systemText(
  m: Message & Record<string, any>,
  nameOf: (username: string) => string = (x) => x,
  roleLabelOf: (role?: string) => string = defaultRoleLabel,
): string {
  const u = m.u.name || m.u.username;
  const who = () => nameOf(m.msg);
  switch (m.t) {
    case 'uj':
      return `${u} entrou na sala`;
    case 'ul':
      return `${u} saiu da sala`;
    case 'au':
      return `${u} adicionou ${who()}`;
    case 'ru':
      return `${u} removeu ${who()}`;
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
      return `${u} silenciou ${who()}`;
    case 'user-unmuted':
      return `${u} removeu o silêncio de ${who()}`;
    case 'subscription-role-added':
      return `${u} deu o papel ${roleLabelOf(m.role)} a ${who()}`;
    case 'subscription-role-removed':
      return `${u} tirou o papel ${roleLabelOf(m.role)} de ${who()}`;
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
    case 'call_ended':
      return `${m.call?.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'} · ${formatDuration(m.call?.duration ?? 0)}`;
    case 'call_missed': {
      const what = m.call?.kind === 'video' ? 'Chamada de vídeo' : 'Chamada de voz';
      const why: Record<string, string> = { missed: 'não atendida', declined: 'recusada', canceled: 'cancelada', busy: 'não atendida (ocupado)' };
      // Chamadas em grupo: m.call agora também pode ser o cartão do grupo; aqui (t = call_missed) é sempre o resumo a dois.
      const status = (m.call as CallSummary | undefined)?.status ?? 'missed';
      return `${what} de ${u} ${why[status] ?? 'não atendida'}`;
    }
    // Chamadas em grupo: o texto do cartão (notificações, buscas, respostas e a última mensagem da sala).
    case 'call_group': {
      const c = m.call as CallCard | undefined;
      if (!c) return m.msg;
      if (c.status === 'ongoing') return c.listenOnly ? `${u} iniciou uma transmissão` : `${u} iniciou uma chamada de ${c.kind === 'video' ? 'vídeo' : 'voz'}`;
      return callCardSummary(c);
    }
    default:
      return m.msg;
  }
}
