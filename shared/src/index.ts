// Tipos compartilhados entre servidor e cliente web.

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
  u?: UserRef; // criador
  ro: boolean; // somente leitura
  archived: boolean;
  default: boolean;
  featured: boolean;
  encrypted: boolean;
  broadcast: boolean;
  reactWhenReadOnly: boolean;
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
  notifications: SubscriptionNotifyPrefs;
  _updatedAt: string;
}

export interface Reaction {
  usernames: string[];
}

export interface Attachment {
  title?: string;
  title_link?: string;
  type?: string; // 'file'
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
  ts?: string;
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
  alias?: string;
  emoji?: string;
  avatar?: string;
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
  | { type: 'pong' };

// ---------- Chamadas (WebRTC em mensagens diretas) ----------

export type CallKind = 'audio' | 'video';
export type CallStatus = 'ringing' | 'ongoing' | 'ended' | 'missed' | 'declined' | 'canceled' | 'busy';

export interface Call {
  _id: string;
  rid: string;
  kind: CallKind;
  status: CallStatus;
  caller: UserRef;
  callee: UserRef;
  callerConnectionId: string;
  calleeConnectionId: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  duration: number | null; // segundos
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
