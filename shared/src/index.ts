// Tipos compartilhados entre servidor e cliente web.

import type { MessageSticker } from './stickers';
// Integrações (Jira/Teams)
import type { EphemeralMessage, ExternalPresence, IntegrationAlert, MessageBridge, MessageJira, MessageMeeting } from './integrations';

export type UserStatus = 'online' | 'away' | 'busy' | 'offline';
export type RoomType = 'c' | 'p' | 'd' | 'l';

export interface UserRef {
  _id: string;
  username: string;
  name?: string;
}

export interface User {
  _id: string;
  username: string;
  name: string;
  email?: string;
  emailVerified?: boolean;
  status: UserStatus;
  statusText?: string;
  statusDefault?: UserStatus;
  active: boolean;
  type: 'user' | 'bot' | 'app';
  roles: string[];
  bio?: string;
  avatarETag?: string | null;
  authSource?: 'local' | 'ldap' | 'saml' | 'oauth';
  authProvider?: string; // provedor OAuth da conta (authSource 'oauth')
  twoFactorEnabled?: boolean;
  preferences?: UserPreferences;
  createdAt: string;
  lastLogin?: string | null;
}

export interface UserPreferences {
  language?: string;
  theme?: 'light' | 'dark' | 'auto';
  desktopNotifications?: 'all' | 'mentions' | 'nothing';
  emailNotificationMode?: 'mentions' | 'nothing';
  notificationSound?: boolean;
  sendOnEnter?: boolean;
  showThreadsInMainChannel?: boolean;
  sidebarGroupByType?: boolean;
  sidebarShowUnread?: boolean;
  hideReadReceipts?: boolean;
  stickerAnimation?: 'system' | 'auto' | 'hover' | 'never'; // ausente ou 'system' = padrão da organização
  stickerSuggestions?: boolean; // ausente = true
  stickerTabSeen?: boolean; // já abriu a aba Figurinhas (some o ponto de novidade)
  stickerHintSeen?: boolean; // já enviou uma figurinha pelo seletor (some a dica de Shift+clique)
  [key: string]: unknown;
}

export interface LastMessage {
  _id: string;
  msg: string;
  u: UserRef;
  ts: string;
}

export interface Room {
  _id: string;
  t: RoomType;
  name: string | null;
  fname: string | null;
  topic?: string;
  description?: string;
  announcement?: string;
  avatarETag?: string; // só quando alguém enviou uma imagem para a sala
  u?: UserRef; // criador
  ro: boolean; // somente leitura
  archived: boolean;
  default: boolean;
  featured: boolean;
  encrypted: boolean;
  broadcast: boolean;
  reactWhenReadOnly: boolean;
  notice: boolean; // canal de avisos (implica ro)
  noticeAck: boolean; // avisos podem pedir "Ciente"
  direct?: RoomDirectPolicy; // só em rooms.info de mensagens diretas, calculado para quem pergunta
  teamId?: string | null;
  teamMain?: boolean;
  prid?: string | null; // sala pai (discussão)
  pmid?: string | null; // mensagem pai (discussão)
  usernames?: string[]; // DMs
  uids?: string[]; // DMs
  usersCount: number;
  msgs: number;
  lastMessage?: LastMessage | null;
  lm?: string | null;
  retention?: RoomRetention | null;
  ts: string;
  _updatedAt: string;
}

export interface RoomDirectPolicy {
  canSend: boolean;
  canCall: boolean;
  sendBlockedReason?: string;
  callBlockedReason?: string;
}

export interface RoomRetention {
  enabled: boolean;
  overrideGlobal: boolean;
  maxAgeDays: number;
  filesOnly: boolean;
  excludePinned: boolean;
}

export interface SubscriptionNotifyPrefs {
  desktop?: 'default' | 'all' | 'mentions' | 'nothing';
  email?: 'default' | 'mentions' | 'nothing';
  muteGroupMentions?: boolean;
  disableNotifications?: boolean;
  hideUnreadStatus?: boolean;
}

export interface Subscription {
  _id: string;
  rid: string;
  u: UserRef;
  t: RoomType;
  name: string;
  fname: string;
  roles: string[];
  open: boolean;
  alert: boolean;
  unread: number;
  userMentions: number;
  groupMentions: number;
  tunread: string[];
  f: boolean; // favorito
  ls: string | null; // última leitura
  ts: string;
  prid?: string | null;
  teamId?: string | null;
  teamMain?: boolean;
  notice?: boolean; // a sala é um canal de avisos (ícone na barra lateral)
  lm?: string; // hora da última mensagem da sala (ordem de "Recentes")
  notifications: SubscriptionNotifyPrefs;
  _updatedAt: string;
}

export interface Reaction {
  usernames: string[];
}

export interface Attachment {
  title?: string;
  title_link?: string;
  type?: string; // 'file' para arquivos enviados; sem tipo, anexo de integração (formato do Slack)
  // type 'sticker' = imagem de reserva de uma figurinha (clientes novos usam message.sticker)
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  description?: string;
  size?: number;
  format?: string;
  // mensagem citada
  message_link?: string;
  text?: string;
  author_name?: string;
  author_alias?: string; // apelido do autor (integração, ponte do Teams); só o servidor preenche
  ts?: string;
  // anexos de integrações e mensagens importadas do Slack
  pretext?: string;
  color?: string;
  author_link?: string;
  author_icon?: string;
  thumb_url?: string;
  footer?: string;
  fields?: { title: string; value: string; short?: boolean }[];
  // arquivo de mensagem importada que ainda não foi baixado da origem
  pendingFileId?: string;
  // novos campos (hoje só a figurinha preenche)
  image_dimensions?: { width: number; height: number };
  image_type?: string;
  image_size?: number;
}

export interface MessageFile {
  _id: string;
  name: string;
  type: string;
  size: number;
}

export interface Message {
  _id: string;
  rid: string;
  msg: string;
  u: UserRef;
  t?: string | null; // tipo de mensagem de sistema
  ts: string;
  _updatedAt: string;
  tmid?: string | null; // mensagem raiz da thread
  tcount?: number;
  tlm?: string | null;
  replies?: string[];
  drid?: string | null;
  dcount?: number;
  dlm?: string | null;
  mentions: UserRef[];
  channels: { _id: string; name: string }[];
  reactions: Record<string, Reaction>;
  attachments: Attachment[];
  file?: MessageFile | null;
  files?: MessageFile[];
  pinned: boolean;
  pinnedAt?: string | null;
  pinnedBy?: UserRef | null;
  starred: { _id: string }[];
  editedAt?: string | null;
  editedBy?: UserRef | null;
  unread?: boolean; // read receipts: ainda não lida por todos
  ackRequired?: boolean; // o aviso pede "Ciente"
  ackCount?: number; // quantas pessoas confirmaram
  sticker?: MessageSticker; // figurinha (messages.extra.sticker, montada pelo servidor)
  call?: CallCard | CallSummary; // chamadas: cartão (grupo) ou resumo (a dois)
  alias?: string;
  emoji?: string;
  avatar?: string;
  // Integrações (Jira/Teams): conteúdo gerado pelo servidor (messages.extra)
  jira?: MessageJira;
  meeting?: MessageMeeting;
  bridge?: MessageBridge;
  jiraNoPreview?: boolean; // o autor removeu a prévia; edições não a recriam
}

export interface NoticeAcks {
  messageId: string;
  ackCount: number;
  pendingCount: number;
  acked: { user: UserRef; ackAt: string }[]; // quando status = 'acked'
  pending: UserRef[]; // quando status = 'pending'
  total: number; // tamanho da lista pedida
}

export interface Team {
  _id: string;
  name: string;
  type: 0 | 1; // 0 pública, 1 privada
  roomId: string;
  createdBy: UserRef;
  createdAt: string;
  roomsCount?: number;
  membersCount?: number;
}

export interface Role {
  _id: string;
  name: string;
  description: string;
  scope: 'Users' | 'Subscriptions';
  protected: boolean;
  mandatory2fa: boolean;
  restrictDirect: boolean; // "Restrito em conversas diretas" (só papéis globais)
}

export interface Permission {
  _id: string;
  group: string;
  roles: string[];
}

export type SettingType = 'string' | 'boolean' | 'int' | 'select' | 'code' | 'password' | 'multiline';

export interface Setting {
  _id: string;
  value: unknown;
  type: SettingType;
  group: string;
  section?: string;
  public: boolean;
  label?: string;
  description?: string;
  values?: { key: string; label: string }[];
  sorter?: number;
}

export interface DeviceSession {
  _id: string;
  userId: string;
  username?: string;
  device: { name?: string; os?: string; browser?: string; userAgent?: string; ip?: string };
  createdAt: string;
  lastActiveAt: string;
  current?: boolean;
}

// ---------- Tempo real ----------

// ---------- Login OAuth / OpenID Connect ----------

export type OAuthProviderType = 'google' | 'github' | 'gitlab' | 'microsoft' | 'custom';

// Caminhos (com pontos, ex.: "data.user.id") dos campos na resposta de identidade.
export interface OAuthFieldMap {
  id: string;
  username: string;
  email: string;
  name: string;
  avatar: string;
  emailVerified: string;
}

export type OAuthMapping = Record<string, string | string[]>;

export interface OAuthProvider {
  _id: string;
  type: OAuthProviderType;
  enabled: boolean;
  label: string;
  buttonColor: string;
  buttonTextColor: string;
  clientId: string;
  clientSecretSet: boolean; // o segredo nunca sai do servidor
  serverUrl: string;
  tenant: string;
  authorizeUrl: string;
  tokenUrl: string;
  identityUrl: string;
  scope: string;
  tokenAuth: 'post' | 'basic';
  tokenSentVia: 'header' | 'query';
  accessTokenParam: string;
  identityPath: string;
  fieldMap: Partial<OAuthFieldMap>;
  loginStyle: 'redirect';
  mergeUsers: boolean;
  blockNewUsers: boolean;
  rolesClaim: string;
  syncRoles: boolean;
  mergeRoles: boolean;
  roleMapping: OAuthMapping;
  groupsClaim: string;
  mapChannels: boolean;
  channelMapping: OAuthMapping;
  sort: number;
  callbackUrl: string;
  effective: { authorizeUrl: string; tokenUrl: string; identityUrl: string; scope: string; fieldMap: OAuthFieldMap };
  _createdAt: string;
  _updatedAt: string;
}

export interface OAuthProviderPublic {
  _id: string;
  label: string;
  buttonColor: string;
  buttonTextColor: string;
}

export interface OAuthPreset {
  type: OAuthProviderType;
  name: string;
  description: string;
  label: string;
  buttonColor: string;
  buttonTextColor: string;
  scope: string;
  fieldMap: OAuthFieldMap;
  rolesClaim: string;
  groupsClaim: string;
  authorizeUrl: string;
  tokenUrl: string;
  identityUrl: string;
}

export type ServerEvent =
  | { type: 'connected'; userId: string; sessionId: string; connectionId: string }
  | { type: 'message'; action: 'inserted' | 'updated'; message: Message }
  | { type: 'message.deleted'; rid: string; _id: string; tmid?: string | null }
  | { type: 'messages.bulkDeleted'; rid: string; ids?: string[]; before?: string; filesOnly?: boolean }
  | { type: 'typing'; rid: string; tmid?: string | null; username: string; typing: boolean }
  | { type: 'subscription'; action: 'inserted' | 'updated' | 'removed'; subscription: Subscription }
  | { type: 'room'; action: 'inserted' | 'updated' | 'removed'; room: Room }
  | { type: 'presence'; userId: string; username: string; status: UserStatus; statusText?: string }
  | { type: 'notification'; rid: string; title: string; text: string; messageId: string; sender: UserRef; tmid?: string | null }
  | { type: 'reads'; rid: string; messageIds: string[] }
  | { type: 'user'; action: 'updated'; user: Partial<User> & { _id: string } }
  | { type: 'permissions.changed' }
  | { type: 'settings.changed'; settings: { _id: string; value: unknown }[] }
  | { type: 'force_logout' }
  | { type: 'livechat.inquiry'; action: 'queued' | 'taken' | 'removed'; inquiry: LivechatInquiry }
  | { type: 'livechat.room'; room: LivechatRoomInfo }
  | { type: 'livechat.agentStatus'; status: LivechatAgentStatus }
  | { type: 'call'; call: Call }
  | { type: 'call.signal'; callId: string; data: CallSignal }
  | { type: 'call.room'; rid: string; call: Call | null } // resumo para a sala; null = acabou
  | { type: 'call.ring'; action: 'ring' | 'stop'; call: Call; by?: UserRef }
  | { type: 'call.notice'; callId: string; notice: CallNotice }
  | { type: 'call.prompt'; rid: string; kind: CallKind } // /call: abre a tela de entrada
  | { type: 'call.hand'; callId: string; userId: string; at: string | null } // mão levantada ou baixada
  | { type: 'call.presence'; userId: string; inCall: boolean } // "Em chamada"
  | { type: 'call.invite'; call: Call; by: UserRef } // "Avisar a sala": aviso sem toque
  | { type: 'import.progress'; operation: ImportProgress }
  | { type: 'stickers.changed'; scope: 'org' | 'mine' }
  | { type: 'sticker.removed'; fileId: string }
  // Integrações (Jira/Teams)
  | { type: 'ephemeral'; message: EphemeralMessage }
  | { type: 'integrations.changed'; scope: 'config' | 'account' }
  | { type: 'presence.external'; userId: string; presence: ExternalPresence | null }
  | { type: 'integrations.alert'; alert: IntegrationAlert }
  | { type: 'pong' };

// ---------- Importação de dados ----------

export interface ImportProgress {
  _id: string;
  importerKey: string;
  status: string;
  valid: boolean;
  count: { users: number; channels: number; messages: number; contacts: number; total: number; completed: number; error: number; skipped: number };
  rate?: number;
  messagesstatus?: string | null;
  error?: string | null;
}

// ---------- Chamadas (diretas e em grupo) ----------

export type CallKind = 'audio' | 'video';
export type CallStatus = 'ringing' | 'ongoing' | 'ended' | 'missed' | 'declined' | 'canceled' | 'busy'; // grupo: só ongoing e ended
export type CallScope = 'direct' | 'group';
export type CallMedia = 'p2p' | 'sfu';
export type CallParticipantState = 'ringing' | 'joining' | 'joined' | 'left' | 'declined' | 'missed';
export type CallEndReason =
  | 'hangup' | 'empty' | 'dropped' | 'moderator' | 'restricted' | 'no-answer' | 'alone' | 'max-duration'
  | 'room' | 'readonly' | 'no-speaker' | 'sfu';
export type CallLeftReason = 'hangup' | 'disconnected' | 'removed' | 'ended' | 'failed' | 'busy' | 'deactivated' | 'room';
export type CallModerationAction = 'mute' | 'stopVideo' | 'lowerHand' | 'allowSpeak' | 'revokeSpeak' | 'remove';
export type CallSource = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio';
export type CallGuardMode = 'strict' | 'pairs';

export interface CallRoomRef {
  _id: string;
  t: RoomType;
  name: string | null;
  fname: string | null;
  prid?: string | null;
  teamMain?: boolean;
  notice?: boolean;
  broadcast?: boolean;
  usernames?: string[]; // DMs
}

// Estado da trava de pessoas restritas, para a web prever a recusa sem conhecer os papéis de cada um.
export interface CallGuardState {
  mode: CallGuardMode;
  chaperone: boolean; // há na chamada alguém sem restrição ou isento
  restrictedSpeakers: number; // pessoas restritas que podem falar agora
  connectedSpeakers?: number; // dessas, as já conectadas (a regra dos três do modo pairs só conta estas)
}

// Quem pergunta, para a mesma previsão: calculado pelo servidor, sem expor papéis.
export interface CallViewerGuard {
  restricted: boolean;
  exempt: boolean;
  speaks: boolean; // falaria nesta chamada ao entrar
}

export interface CallParticipant {
  user: UserRef;
  state: CallParticipantState;
  host: boolean;
  speaker: boolean; // pode publicar áudio agora (papel na sala, fala liberada, sem trava)
  speakGranted: boolean;
  handAt: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  leftReason: CallLeftReason | null;
  seconds: number;
}

// O que a pessoa que pergunta é e pode fazer nesta chamada.
export interface CallMine {
  state: CallParticipantState | null; // null: nunca entrou nem foi chamada
  host: boolean;
  seconds: number;
  direction: 'incoming' | 'outgoing';
  missed: boolean;
  leftReason: CallLeftReason | null;
  leftAt: string | null;
  listenOnly: boolean; // entra ou está só ouvindo
  handAt: string | null;
  canModerate: boolean; // moderate-call na sala, ou anfitrião com call-management
  canEnd: boolean; // anfitrião ou moderate-call
  canRing: boolean; // presente e pode usar "Chamar"
  canInvite: boolean; // presente, pode usar "Avisar a sala" e o intervalo de 10 min já passou
}

export interface Call {
  _id: string;
  rid: string;
  kind: CallKind;
  status: CallStatus;
  scope: CallScope;
  media: CallMedia;
  caller: UserRef; // quem iniciou
  callee: UserRef | null; // só em chamadas a dois
  callerConnectionId: string | null; // só P2P
  calleeConnectionId: string | null; // só P2P
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  endedReason: CallEndReason | null;
  duration: number | null; // segundos: atendimento → fim (a dois) ou início → fim (grupo)
  listenOnly: boolean; // transmissão
  participantsCount: number; // presentes agora
  sample: UserRef[]; // até 5 presentes (encerrada: os primeiros que entraram); com a lista oculta, só quem fala
  peak: number;
  totalJoined: number;
  guardUntil: string | null; // pausada até; null = sem pausa
  guard?: CallGuardState; // só quando a trava se aplica a esta sala
  messageId: string | null; // cartão na sala (grupo)
  room?: CallRoomRef; // em calls.active, calls.list, calls.admin.active, call.ring e call.invite
  participants?: CallParticipant[]; // só em calls.info e nas respostas de start, join e accept
  mine?: CallMine; // para quem pergunta
  canCall?: boolean; // só em calls.list (chamadas a dois)
  callBlockedReason?: string;
}

export interface CallJoin {
  token: string; // abre só a primeira conexão, por 60 s; o endereço é sempre o próprio chat em /sfu
  expiresAt: string;
  identity: string; // = _id do usuário
  canPublish: boolean;
  sources: CallSource[];
  hidden: boolean; // ouvinte de transmissão: o LiveKit não o anuncia aos outros
  maxVideoPublishers: number;
}

// Cartão da chamada em grupo na sala (messages.extra.call, t = 'call_group').
export interface CallCard {
  _id: string;
  kind: CallKind;
  scope: 'group';
  status: 'ongoing' | 'ended';
  listenOnly: boolean;
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  participantsCount: number;
  sample: UserRef[];
  peak: number;
  totalJoined: number;
  endedReason: CallEndReason | null;
  endedBy: UserRef | null;
}

// Resumo das chamadas a dois (t = 'call_ended' | 'call_missed'), como hoje.
export interface CallSummary {
  _id: string;
  kind: CallKind;
  status: CallStatus;
  duration: number | null;
}

export type CallNotice =
  | { kind: 'guard'; until: string; text: string }
  | { kind: 'guard-cleared'; text: string }
  | { kind: 'moderated'; action: CallModerationAction; by: UserRef; text: string }
  | { kind: 'host'; text: string }
  | { kind: 'refused'; text: string } // a ponte ou o servidor recusou a conexão
  | { kind: 'ended'; reason: CallEndReason; text: string };

export interface CallsConfig {
  enabled: boolean;
  groupEnabled: boolean; // Calls_Group_Enabled e servidor de chamadas configurado
  directViaSfu: boolean; // [v1b] Calls_Direct_Via_SFU
  inNoticeRooms: boolean; // [v1b] Calls_In_Notice_Rooms
  ringTimeout: number;
  sfu: boolean; // servidor de chamadas configurado e respondendo
  iceServers: { urls: string[]; username?: string; credential?: string }[]; // só P2P
  limits: { participants: number; listeners: number; videoPublishers: number; maxHours: number; ringPerAction: number };
  serverTime: string; // relógio do servidor, para os cronômetros
}

export interface RoomCallState {
  call: Call | null; // chamada viva na sala
  canStart: boolean;
  startBlockedReason?: string;
  hideStart: boolean; // a recusa não muda sozinha nesta sala: nem mostra os botões
  canJoin: boolean;
  joinBlockedReason?: string;
  listenOnly: boolean; // quem pergunta entra só ouvindo
  transmission: boolean; // sala somente leitura, de avisos ou com a lista oculta
  viewerGuard?: CallViewerGuard; // só quando a trava se aplica a esta sala
  serverTime: string;
}

export type CallSignal = { sdp: { type: 'offer' | 'answer'; sdp: string } } | { candidate: Record<string, unknown> | null };

// ---------- Omnichannel ----------

export type LivechatAgentStatus = 'available' | 'not-available';
export type LivechatRoomStatus = 'queued' | 'open' | 'onhold' | 'closed';

export interface LivechatVisitor {
  _id: string;
  token: string;
  username: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  customFields?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  ts: string;
  lastChat?: { _id: string; ts: string } | null;
}

export interface LivechatRoomInfo {
  _id: string;
  rid: string;
  fname: string;
  status: LivechatRoomStatus;
  v: { _id: string; username: string; name: string; token?: string; email?: string | null; phone?: string | null };
  servedBy?: { _id: string; username: string; name?: string } | null;
  departmentId?: string | null;
  departmentName?: string | null;
  priority?: { _id: string; name: string; sortItem: number } | null;
  sla?: { _id: string; name: string; dueTimeInMinutes: number } | null;
  estimatedWaitingTimeQueue?: number;
  tags: string[];
  topic?: string;
  livechatData?: Record<string, unknown>;
  source?: { type: string; url?: string };
  queuedAt?: string | null;
  servedAt?: string | null;
  firstResponseAt?: string | null;
  closedAt?: string | null;
  closer?: 'user' | 'visitor' | 'system' | null;
  closedBy?: { _id: string; username: string } | null;
  closeComment?: string | null;
  onHoldAt?: string | null;
  survey?: Record<string, unknown> | null;
  messages: number;
  ts: string;
}

export interface LivechatInquiry {
  _id: string; // = rid
  rid: string;
  name: string;
  v: { _id: string; username: string; name: string };
  departmentId?: string | null;
  priority?: { _id: string; name: string; sortItem: number } | null;
  slaDue?: string | null;
  queuedAt: string;
  message?: string;
}

export type ClientEvent =
  | { type: 'auth'; token: string }
  | { type: 'ping' }
  | { type: 'idle'; idle: boolean }
  | { type: 'typing'; rid: string; tmid?: string | null; typing: boolean }
  | { type: 'watch'; rid: string }
  | { type: 'unwatch'; rid: string }
  | { type: 'status'; status: UserStatus }
  | { type: 'call.signal'; callId: string; data: CallSignal };

// Eventos do widget do visitante (WebSocket /livechat/websocket)
export type VisitorClientEvent = { type: 'ping' } | { type: 'typing'; rid: string; typing: boolean };
