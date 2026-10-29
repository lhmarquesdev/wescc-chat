// Integrações com Jira e Microsoft Teams: contratos entre servidor e web e funções puras usadas pelos dois.

// ---------- Comuns ----------

export type Provider = 'jira' | 'msteams';
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'off';

// Segredo visto pela API: nunca o valor.
export interface SecretState {
  set: boolean;
  hint?: string; // "••••a1b2"
  updatedAt?: string | null;
  expiresAt?: string | null;
  unreadable?: boolean; // gravado com outra chave (SECRETS_KEY trocada sem SECRETS_KEY_PREVIOUS): cadastre de novo
}

export interface ConnectorStatus {
  tone: Tone;
  text: string; // pt-BR, uma linha: "Conectado como Jira Explorer (conta de serviço)"
  checkedAt?: string | null;
  details?: string[]; // linhas do último teste
}

export interface IntegrationRoomRef {
  _id: string;
  name: string;
  fname?: string;
  t: 'c' | 'p';
  notice: boolean;
  archived: boolean;
  ro: boolean;
}

// Resultado de "posso usar esta sala como destino/origem?"
export interface TargetCheck {
  room: IntegrationRoomRef;
  ok: boolean;
  botMember: boolean;
  needsPublisher: boolean; // canal de avisos (ou somente leitura) e o bot ainda não é publicador
  problem?: string; // pt-BR, quando ok = false
}

export interface IntegrationActivity {
  _id: string;
  provider: Provider;
  integrationId: string | null;
  integrationName?: string | null;
  tone: 'ok' | 'warn' | 'err' | 'info';
  text: string; // pt-BR, sem segredos
  detail?: string | null; // técnico e curto: "HTTP 429", "error-jira-auth"
  jobId?: string | null;
  canRetry: boolean;
  at: string;
}

export interface RuleMeta {
  enabled: boolean;
  lastOkAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  createdBy?: { _id: string; username: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Jira ----------

export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';
export type JiraTypeKind = 'bug' | 'task' | 'story' | 'epic' | 'subtask' | 'other';

export const JIRA_EVENT_KINDS = ['created', 'status', 'resolved', 'assigned', 'priority', 'commented', 'updated', 'deleted'] as const;
export type JiraEventKind = (typeof JIRA_EVENT_KINDS)[number];
export const JIRA_EVENT_LABEL: Record<JiraEventKind, string> = {
  created: 'Issue criada',
  status: 'Mudança de status',
  resolved: 'Issue resolvida',
  assigned: 'Mudança de responsável',
  priority: 'Mudança de prioridade',
  commented: 'Novo comentário',
  updated: 'Outras alterações',
  deleted: 'Issue excluída',
};
export const JIRA_DEFAULT_EVENTS: JiraEventKind[] = ['created', 'status', 'resolved', 'assigned', 'commented'];

export interface JiraPerson {
  accountId?: string;
  displayName: string;
  username?: string; // @ no chat, quando a conta está vinculada
}

export interface JiraIssueSnapshot {
  id: string;
  key: string;
  url: string; // https://empresa.atlassian.net/browse/OPS-123
  summary: string; // já passou por safeExternalText (sem links falsos nem menções)
  status: { name: string; category: JiraStatusCategory };
  type: { name: string; kind: JiraTypeKind };
  priority?: { name: string } | null;
  assignee?: JiraPerson | null;
  reporter?: JiraPerson | null;
  project: { key: string; name: string; serviceDesk?: boolean }; // serviceDesk: projeto do Jira Service Management (atende clientes)
  resolution?: string | null;
  updatedAt: string;
}

export interface JiraChange {
  field: string; // id do campo no Jira
  label: string; // nome mostrado: "Status", "Prioridade", "Resumo"
  from?: string | null;
  to?: string | null;
}

export interface JiraEventInfo {
  kind: JiraEventKind;
  actor?: JiraPerson | null;
  changes?: JiraChange[];
  comment?: { id: string; excerpt: string; url: string }; // trecho seguro (safeExternalText), até 300 caracteres
  at: string;
}

export interface MessageJira {
  kind: 'event' | 'preview' | 'share' | 'created';
  site: string; // origem: https://empresa.atlassian.net
  issues: JiraIssueSnapshot[]; // 1 (event, share, created) ou até Jira_Unfurl_Max (preview)
  event?: JiraEventInfo; // kind 'event'
  by?: { _id: string; username: string; name?: string }; // share/created: quem fez no chat
  viaIntegration?: boolean; // created pela conta da integração
}

export interface JiraRule extends RuleMeta {
  _id: string;
  name: string;
  projects: string[]; // chaves, 1 a 20
  issueTypes: string[]; // nomes; vazio = todos
  events: JiraEventKind[];
  jql: string; // filtro extra opcional, até 1000 caracteres
  roomIds: string[]; // 1 a 5, só canais (c) e grupos privados (p)
  rooms: IntegrationRoomRef[]; // preenchido pelo servidor
  threads: boolean; // agrupar por issue em tópicos
  mentionAssignee: boolean;
  grantPublisher: boolean; // autorização explícita para canais de avisos
}
export type JiraRuleInput = Pick<JiraRule, 'name' | 'enabled' | 'projects' | 'issueTypes' | 'events' | 'jql' | 'roomIds' | 'threads' | 'mentionAssignee' | 'grantPublisher'>;

export interface JiraConfig {
  enabled: boolean;
  siteUrl: string;
  authType: 'scoped' | 'basic';
  accountEmail: string;
  cloudId: string;
  apiToken: SecretState;
  account: { accountId: string; displayName: string; email?: string | null; locale?: string | null } | null; // a conta da integração (último teste)
  siteProblem?: string | null; // pt-BR: o endereço não é *.atlassian.net nem está liberado em INTEGRATIONS_ALLOWED_HOSTS
  status: ConnectorStatus;
  userAuth: 'token' | 'oauth' | 'off';
  oauthClientId: string;
  oauthClientSecret: SecretState;
  oauthRedirectUri: string; // {Site_Url}/integrations/jira/callback
  oauthProblem?: string | null; // pt-BR quando o endereço não serve para OAuth
  eventsMode: 'polling' | 'webhook';
  pollMinutes: number;
  lastPollAt?: string | null;
  webhookUrl: string | null; // {Site_Url}/hooks/jira/<token>; null quando não dá
  webhookProblem?: string | null; // pt-BR: por que o webhook não serve neste endereço
  webhookSecret: SecretState;
  webhookJql: string; // filtro JQL que o webhook do Jira deve usar, calculado das regras
  webhookJqlChanged: boolean; // as regras mudaram depois que o filtro foi mostrado: atualize o webhook no Jira
  lastWebhookAt?: string | null;
  unfurlEnabled: boolean;
  unfurlMax: number;
  projectsVisible: string[];
  projectsCreate: string[];
  defaultProject: string;
  createAsIntegration: boolean;
  serviceDeskProjects: string[]; // chaves de projetos do Service Management vistos no último teste
}

// string = novo valor; null = apagar; ausente = manter.
export interface JiraConfigInput {
  enabled?: boolean;
  siteUrl?: string;
  authType?: 'scoped' | 'basic';
  accountEmail?: string;
  apiToken?: string | null;
  apiTokenExpiresAt?: string | null; // AAAA-MM-DD
  userAuth?: 'token' | 'oauth' | 'off';
  oauthClientId?: string;
  oauthClientSecret?: string | null;
  eventsMode?: 'polling' | 'webhook';
  pollMinutes?: number;
  unfurlEnabled?: boolean;
  unfurlMax?: number;
  projectsVisible?: string[];
  projectsCreate?: string[];
  defaultProject?: string;
  createAsIntegration?: boolean;
}

export interface JiraProjectRef {
  id: string;
  key: string;
  name: string;
  serviceDesk?: boolean; // projeto do Jira Service Management (atende clientes)
}

export interface JiraIssueTypeMeta {
  id: string;
  name: string;
  kind: JiraTypeKind;
  subtask: boolean;
}

// Campos que o formulário de nova issue preenche. Obrigatórios de outros tipos viram "blockers".
export type JiraFieldKind = 'priority' | 'user' | 'string' | 'text' | 'number' | 'date' | 'datetime' | 'option' | 'options' | 'labels' | 'unsupported';
export interface JiraFieldMeta {
  key: string; // 'priority', 'assignee', 'customfield_10020'
  name: string;
  required: boolean;
  kind: JiraFieldKind;
  options?: { id: string; name: string }[]; // option / options / priority
  defaultValue?: unknown; // valor padrão do Jira, quando existe
}

export interface JiraCreateMeta {
  project: JiraProjectRef;
  issueTypes: JiraIssueTypeMeta[]; // sem subtarefas
  fields: Record<string, JiraFieldMeta[]>; // por issueTypeId; só os que o formulário usa ou que bloqueiam
  blockers: Record<string, string[]>; // por issueTypeId: nomes de campos obrigatórios que o chat não preenche
  identity: 'user' | 'integration' | 'none'; // none: sem conta vinculada e sem criação pela conta da integração (o modal pede para conectar)
  canPost: boolean; // a pessoa pode publicar na sala (para "Responder no tópico")
  canPostReason?: string | null; // texto de canPostInRoom quando não pode
}

export interface JiraAssignable {
  accountId: string;
  displayName: string;
  username?: string; // @ no chat, quando vinculado
}

export interface JiraCreateInput {
  roomId: string;
  messageId?: string | null;
  projectKey: string;
  issueTypeId: string;
  summary: string; // 1 a 255
  description: string; // até 32000
  priorityId?: string | null;
  assigneeAccountId?: string | null; // null = sem responsável
  fields?: Record<string, unknown>; // campos obrigatórios extras, pela chave do campo, nos formatos de JiraFieldKind
  replyInThread: boolean;
}

export interface JiraSearchResult {
  mode: 'text' | 'jql';
  jql: string;
  issues: JiraIssueSnapshot[];
  nextPageToken: string | null;
  identity: 'user' | 'integration';
}

// ---------- Microsoft Teams ----------

export interface TeamsConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: SecretState;
  status: ConnectorStatus;
  granted: { application: string[]; delegated: string[] }; // permissões vistas nos tokens do último teste
  serviceAccount: { linked: boolean; upn?: string | null; displayName?: string | null; status: ConnectorStatus };
  serviceRedirectUri: string; // {Site_Url}/integrations/msteams/callback, ou http://localhost:<porta>/... quando Site_Url não é https
  serviceRedirectNote?: string | null; // pt-BR, quando é preciso entrar pelo próprio servidor
  inboundMode: 'off' | 'notifications' | 'polling'; // como as mensagens do Teams chegam (D13)
  notificationsUrl: string | null; // {Site_Url}/hooks/msteams/<token>; null quando o endereço não serve
  notificationsProblem?: string | null; // pt-BR: por que as notificações não servem neste endereço
  pollMinutes: number; // só no modo polling
  pollingAcceptedAt?: string | null; // quando e por quem o risco foi aceito (auditoria)
  pollingAcceptedBy?: string | null;
  pollingUnavailable?: string | null; // pt-BR: este locatário não oferece a leitura por delta dos canais
  appObjectId?: string | null; // ID de objeto do aplicativo no Entra (o gatilho do fluxo libera este ID)
  emailChangeAllowed: boolean; // Accounts_AllowEmailChange ligado: Criar agora e presença ficam inseguros (D30)
  meetingsMode: 'off' | 'links' | 'graph';
  meetingLobby: 'organization' | 'everyone' | 'organizer';
  meetingMinutes: number;
  presenceEnabled: boolean;
  presenceMinutes: number; // só no modo polling (com notificações, a presença chega por assinatura)
}

export interface TeamsConfigInput {
  enabled?: boolean;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string | null;
  clientSecretExpiresAt?: string | null; // AAAA-MM-DD
  inboundMode?: 'off' | 'notifications' | 'polling';
  acceptPolling?: boolean; // obrigatório (true) para passar a 'polling'
  pollMinutes?: number;
  meetingsMode?: 'off' | 'links' | 'graph';
  meetingLobby?: 'organization' | 'everyone' | 'organizer';
  meetingMinutes?: number;
  presenceEnabled?: boolean;
  presenceMinutes?: number;
}

export type TeamsOutFilter = 'all' | 'root' | 'ack' | 'keywords';

export interface TeamsOutRule extends RuleMeta {
  _id: string;
  name: string;
  roomIds: string[]; // 1 a 10, só c/p
  rooms: IntegrationRoomRef[];
  filter: TeamsOutFilter; // padrão 'root'. todas | só mensagens principais | só avisos com "Ciente" | com palavras-chave
  keywords: string[]; // filter 'keywords': até 20, sem diferenciar maiúsculas e acentos
  includeBots: boolean; // também as mensagens de robôs (Jira, webhooks); padrão false
  includeFiles: boolean; // nomes dos arquivos (nunca o arquivo)
  includeLink: boolean; // botão "Abrir no {Site_Name}" quando Site_Url existe
  destinationLabel: string; // "Operação › Avisos", mostrado no chat
  destinationPrivate: boolean; // canal privado do Teams: o fluxo precisa publicar como usuário (Post as user)
  flowOwner: string; // e-mail do dono do fluxo no Power Automate: as regras do mesmo dono dividem o limite
  budget: 5 | 10 | 20; // posts a cada 5 minutos para este dono (vale o menor entre as regras dele)
  auth: 'none' | 'entra'; // 'entra': token do aplicativo Entra no cabeçalho Authorization
  url: SecretState; // URL do fluxo (segredo)
  urlHost?: string | null; // só o host, para mostrar
}
export type TeamsOutRuleInput = Pick<TeamsOutRule, 'name' | 'enabled' | 'roomIds' | 'filter' | 'keywords' | 'includeBots' | 'includeFiles' | 'includeLink' | 'destinationLabel' | 'destinationPrivate' | 'flowOwner' | 'budget' | 'auth'> & {
  url?: string; // obrigatório ao criar; ausente = manter
};

export interface TeamsTeamRef {
  id: string;
  name: string;
}

export interface TeamsChannelRef {
  id: string;
  name: string;
  membership: 'standard' | 'private' | 'shared';
}

export interface TeamsInRule extends RuleMeta {
  _id: string;
  name: string;
  team: TeamsTeamRef;
  channel: TeamsChannelRef;
  roomId: string; // só c/p
  room: IntegrationRoomRef | null;
  replies: boolean;
  edits: boolean;
  deletes: boolean;
  grantPublisher: boolean;
  lastEventAt?: string | null; // última mensagem do Teams processada
  subscriptionExpiresAt?: string | null; // modo notificações
}
export interface TeamsInRuleInput {
  name: string;
  enabled: boolean;
  teamId: string;
  channelId: string;
  roomId: string;
  replies: boolean;
  edits: boolean;
  deletes: boolean;
  grantPublisher: boolean;
  acknowledgePrivate?: boolean; // canal privado/compartilhado do Teams indo para qualquer sala do chat (c ou p)
}

export interface MessageBridge {
  provider: 'msteams';
  externalId: string;
  author: string; // nome no Teams (safeExternalText)
  webUrl?: string | null; // link da mensagem no Teams
  editedAt?: string | null;
}

// provider wescc: reunião da agenda do chat (meetingId = id do evento, joinUrl = /meet/<código> com o endereço do site).
export interface MessageMeeting {
  provider: 'msteams' | 'wescc';
  kind: 'created' | 'linked';
  meetingId: string; // id em meetings
  joinUrl: string;
  subject: string;
  startsAt?: string | null;
  endsAt?: string | null;
  by: { _id: string; username: string; name?: string };
}

export interface ExternalPresence {
  provider: 'msteams';
  availability: string; // Available, Busy, DoNotDisturb, Away, BeRightBack, Offline, PresenceUnknown...
  activity: string; // InACall, InAMeeting, Presenting, OutOfOffice...
  label: string; // pt-BR (teamsPresenceLabel)
  updatedAt: string;
}

// ---------- Contas da pessoa ----------

export interface LinkedAccount {
  provider: 'jira' | 'microsoft';
  method: 'token' | 'oauth' | 'directory';
  displayName: string;
  email?: string | null;
  site?: string | null;
  status: 'ok' | 'expired' | 'error';
  statusText?: string | null;
  secretExpiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  busySync?: boolean; // microsoft, fase 3
}

// O que o chat pode mostrar para a pessoa (GET integrations.me).
export interface IntegrationsMe {
  sessionTag: string; // marca da sessão de login (respostas efêmeras com autoOpenFor igual abrem o formulário só nela)
  bots: string[]; // ids dos usuários robôs das integrações
  jira: {
    enabled: boolean; // ligado e configurado
    canUse: boolean; // use-jira
    canCreate: boolean; // create-jira-issue
    canManage: boolean; // manage-jira
    userAuth: 'token' | 'oauth' | 'off';
    createAsIntegration: boolean;
    defaultProject: string;
    site: string;
    account: LinkedAccount | null;
  };
  msteams: {
    enabled: boolean;
    meetings: 'off' | 'links' | 'graph';
    canMeet: boolean; // start-msteams-meeting
    canManage: boolean; // manage-msteams
    defaultMinutes: number;
    presence: boolean;
    emailTrusted: boolean; // e-mail do chat confirmado (users.email_verified): Criar agora e presença funcionam
    account: LinkedAccount | null; // conta Microsoft 365 encontrada pelo e-mail (fase 3)
  };
}

// Alerta para quem configura (ou para a própria pessoa, nos tokens pessoais).
export interface IntegrationAlert {
  key: string; // 'jira.connection', 'msteams.service', 'jira.linked:<usuário>'...
  provider: Provider;
  tone: 'warn' | 'err';
  text: string; // pt-BR
  href: string; // caminho no chat: /admin/integrations/jira/conexao, /account/connected
  since: string;
}

// ---------- Respostas que só a pessoa vê ----------

export type EphemeralModal = 'jira-create' | 'jira-link' | 'jira-comment' | 'jira-assign' | 'msteams-meeting';
// Únicos endpoints que uma resposta efêmera pode chamar (servidor e cliente conferem a mesma lista).
export const EPHEMERAL_API_ENDPOINTS = ['jira.search.more', 'jira.issue.share', 'jira.issue.assign', 'msteams.meeting.link'] as const;
export type EphemeralApiEndpoint = (typeof EPHEMERAL_API_ENDPOINTS)[number];
export type EphemeralAction =
  | { kind: 'api'; label: string; icon?: string; endpoint: EphemeralApiEndpoint; body: Record<string, unknown>; primary?: boolean }
  | { kind: 'url'; label: string; icon?: string; url: string } // https
  | { kind: 'modal'; label: string; icon?: string; modal: EphemeralModal; params?: Record<string, string>; autoOpen?: boolean; primary?: boolean };

export interface EphemeralMessage {
  _id: string;
  rid: string;
  tmid?: string | null;
  ts: string;
  source: Provider;
  tone: 'info' | 'ok' | 'warn' | 'err';
  text: string; // markdown simples; partes de fora já passaram por safeExternalText
  issues?: JiraIssueSnapshot[]; // até 10 cartões
  issueActions?: boolean; // cada cartão mostra Compartilhar na sala / Comentar / Atribuir
  actions?: EphemeralAction[]; // até 3
  autoOpenFor?: string | null; // sessionTag: só a aba em foco dessa sessão abre o modal autoOpen
}

// ---------- Funções puras ----------

const ZWSP = '\u200B';

// Texto vindo de fora não menciona ninguém nem sala: "@all" vira "@​all". E-mails ficam intactos.
// Vale todo "@" ou "#" que o chat mostraria como menção ou canal (web/src/lib/markdown.tsx: "@" que não vem logo depois
// de letra, número, "_" ou "@"; "#" idem, ou de "&"), também depois de pontuação e dentro de *negrito*. Depois de "_"
// também: o chat tira o "_" de _itálico_ (e o "__" de qualquer lugar) e olha o "@" de novo, já sem nada antes.
export function neutralizeMentions(text: string): string {
  return text.replace(/(?<![A-Za-z0-9@])@(?=[0-9A-Za-zÀ-ſ._-])|(?<![A-Za-z0-9#&])#(?=[0-9A-Za-zÀ-ſ._-])/g, `$&${ZWSP}`);
}

// Links protegidos pelo Microsoft Defender (Safe Links) escondem o destino em ?url=. Desembrulha uma vez.
export function unwrapSafeLinks(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' && /(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) {
      const inner = u.searchParams.get('url');
      if (inner) return inner.trim();
    }
  } catch {
    // não é um endereço: devolve como veio
  }
  return s;
}

export const TEAMS_MEETING_HOSTS = ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft', 'gov.teams.microsoft.us', 'dod.teams.microsoft.us'];

// Link de reunião do Teams (Safe Links desembrulhado): https, host da lista e caminho de reunião. Devolve o link limpo ou null.
export function normalizeTeamsMeetingUrl(raw: string): string | null {
  const s = unwrapSafeLinks(raw);
  if (s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!TEAMS_MEETING_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return /^\/(l\/meetup-join\/|meet\/)/.test(u.pathname) ? u.toString() : null;
}
export const isTeamsMeetingUrl = (raw: string) => normalizeTeamsMeetingUrl(raw) !== null;

// "2026-10-22T14:30:00-03:00": hora local de quem marcou (offsetMinutes = -new Date().getTimezoneOffset() no navegador).
export function localIso(d: Date, offsetMinutes: number): string {
  const t = new Date(d.getTime() + offsetMinutes * 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Formulário de nova reunião do Teams já preenchido (abre o Teams; nada é criado até a pessoa salvar).
// Espaços viram %20 (o Teams não decodifica "+"); convidados só por UPN.
export function teamsScheduleLink(p: { subject: string; start: Date; end: Date; offsetMinutes: number; content?: string; attendeesUpn?: string[] }): string {
  const enc = encodeURIComponent;
  const parts = [`subject=${enc(p.subject.slice(0, 200))}`, `startTime=${enc(localIso(p.start, p.offsetMinutes))}`, `endTime=${enc(localIso(p.end, p.offsetMinutes))}`];
  if (p.content) parts.push(`content=${enc(p.content.slice(0, 500))}`);
  if (p.attendeesUpn?.length) parts.push(`attendees=${p.attendeesUpn.slice(0, 20).map(enc).join(',')}`);
  return `https://teams.microsoft.com/l/meeting/new?${parts.join('&')}`;
}

// INTEGRATIONS_ALLOWED_HOSTS: "host[:porta]" separados por vírgula. Só no ambiente do servidor, nunca pela tela.
export function parseAllowedHosts(raw: string | null | undefined): string[] {
  return String(raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// Endereço do Jira Cloud: https://<nome>.atlassian.net (ou *.jira.com), porta 443, sem caminho. Outro host só se liberado no ambiente.
export function jiraSiteAllowed(raw: string, allowed: string[]): { origin: string } | { problem: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { problem: 'Endereço inválido. Exemplo: https://explorer.atlassian.net' };
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { problem: 'Informe só o endereço do site, sem caminho, usuário, senha ou parâmetros.' };
  }
  // Liberado no ambiente: "host" vale só para https na 443; http ou outra porta só com "host:porta" (como no safeFetch).
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (allowed.includes(`${host}:${port}`) || (u.protocol === 'https:' && !u.port && allowed.includes(host))) return { origin: u.origin };
  if (u.protocol !== 'https:' || u.port) return { problem: 'Use o endereço https do Jira Cloud, por exemplo https://explorer.atlassian.net.' };
  if (!/^[a-z0-9-]+\.(atlassian\.net|jira\.com)$/i.test(u.hostname)) {
    return { problem: 'Use o endereço do Jira Cloud (termina em .atlassian.net). Para outro servidor, o responsável pelo servidor do chat precisa liberá-lo em INTEGRATIONS_ALLOWED_HOSTS.' };
  }
  return { origin: u.origin };
}

const PRESENCE_LABEL: Record<string, string> = {
  InACall: 'Em chamada',
  InAConferenceCall: 'Em chamada',
  InAMeeting: 'Em reunião',
  Presenting: 'Apresentando',
  DoNotDisturb: 'Não incomodar',
  Busy: 'Ocupado',
  Away: 'Ausente',
  BeRightBack: 'Volto logo',
  OutOfOffice: 'Fora do escritório',
  OffWork: 'Fora do expediente',
  Available: 'Disponível',
  Offline: 'Offline',
};

export function teamsPresenceLabel(availability: string, activity: string): string {
  return PRESENCE_LABEL[activity] ?? PRESENCE_LABEL[availability.replace(/Idle$/, '')] ?? 'Desconhecido';
}

// Atividades do Teams que contam como "ocupado" para a sincronização opcional.
export const TEAMS_BUSY_ACTIVITIES = ['InACall', 'InAConferenceCall', 'InAMeeting', 'Presenting', 'DoNotDisturb'];

export const INTEGRATION_CALLBACK = { jira: '/integrations/jira/callback', msteams: '/integrations/msteams/callback' } as const;
