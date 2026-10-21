-- Esquema inicial do Wescc Chat.

CREATE TABLE users (
  id               text PRIMARY KEY,
  username         text NOT NULL,
  name             text NOT NULL DEFAULT '',
  email            text,
  email_verified   boolean NOT NULL DEFAULT false,
  password_hash    text,
  status           text NOT NULL DEFAULT 'offline',
  status_default   text NOT NULL DEFAULT 'online',
  status_text      text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  type             text NOT NULL DEFAULT 'user',
  roles            text[] NOT NULL DEFAULT '{user}',
  bio              text NOT NULL DEFAULT '',
  avatar_etag      text,
  auth_source      text NOT NULL DEFAULT 'local',
  external_id      text,
  totp_secret      text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  backup_codes     text[] NOT NULL DEFAULT '{}',
  preferences      jsonb NOT NULL DEFAULT '{}',
  require_password_change boolean NOT NULL DEFAULT false,
  last_login       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_external_idx ON users (auth_source, external_id);

CREATE TABLE avatars (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data        bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Sessões de login (também é a base da gestão de dispositivos).
CREATE TABLE sessions (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  device         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE personal_access_tokens (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  bypass_2fa  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE roles (
  id            text PRIMARY KEY,
  description   text NOT NULL DEFAULT '',
  scope         text NOT NULL DEFAULT 'Users',
  protected     boolean NOT NULL DEFAULT false,
  mandatory_2fa boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  id      text PRIMARY KEY,
  grp     text NOT NULL DEFAULT 'general',
  roles   text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE settings (
  id          text PRIMARY KEY,
  value       jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  type        smallint NOT NULL DEFAULT 0,
  room_id     text NOT NULL,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_uq ON teams (lower(name));

CREATE TABLE team_members (
  team_id    text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles      text[] NOT NULL DEFAULT '{member}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE rooms (
  id                   text PRIMARY KEY,
  t                    text NOT NULL,
  name                 text,
  fname                text,
  topic                text NOT NULL DEFAULT '',
  description          text NOT NULL DEFAULT '',
  announcement         text NOT NULL DEFAULT '',
  owner_id             text REFERENCES users(id) ON DELETE SET NULL,
  ro                   boolean NOT NULL DEFAULT false,
  archived             boolean NOT NULL DEFAULT false,
  is_default           boolean NOT NULL DEFAULT false,
  featured             boolean NOT NULL DEFAULT false,
  encrypted            boolean NOT NULL DEFAULT false,
  broadcast            boolean NOT NULL DEFAULT false,
  react_when_ro        boolean NOT NULL DEFAULT false,
  team_id              text REFERENCES teams(id) ON DELETE SET NULL,
  team_main            boolean NOT NULL DEFAULT false,
  prid                 text REFERENCES rooms(id) ON DELETE CASCADE,
  pmid                 text,
  uids                 text[] NOT NULL DEFAULT '{}',
  dm_key               text,
  usernames            text[] NOT NULL DEFAULT '{}',
  users_count          integer NOT NULL DEFAULT 0,
  msgs                 integer NOT NULL DEFAULT 0,
  last_message         jsonb,
  lm                   timestamptz,
  retention            jsonb,
  custom_fields        jsonb NOT NULL DEFAULT '{}',
  muted                text[] NOT NULL DEFAULT '{}',
  join_code            text,
  avatar_etag          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rooms_name_uq ON rooms (lower(name)) WHERE t IN ('c','p') AND prid IS NULL;
CREATE UNIQUE INDEX rooms_dm_uq ON rooms (dm_key) WHERE t = 'd';
CREATE INDEX rooms_team_idx ON rooms (team_id);
CREATE INDEX rooms_prid_idx ON rooms (prid);

CREATE TABLE subscriptions (
  id              text PRIMARY KEY,
  room_id         text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles           text[] NOT NULL DEFAULT '{}',
  open            boolean NOT NULL DEFAULT true,
  alert           boolean NOT NULL DEFAULT false,
  unread          integer NOT NULL DEFAULT 0,
  user_mentions   integer NOT NULL DEFAULT 0,
  group_mentions  integer NOT NULL DEFAULT 0,
  tunread         text[] NOT NULL DEFAULT '{}',
  favorite        boolean NOT NULL DEFAULT false,
  ls              timestamptz,
  notifications   jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

CREATE TABLE messages (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  username    text NOT NULL,
  user_name   text NOT NULL DEFAULT '',
  msg         text NOT NULL DEFAULT '',
  t           text,
  tmid        text,
  tcount      integer NOT NULL DEFAULT 0,
  tlm         timestamptz,
  replies     text[] NOT NULL DEFAULT '{}',
  drid        text,
  dcount      integer NOT NULL DEFAULT 0,
  dlm         timestamptz,
  mentions    jsonb NOT NULL DEFAULT '[]',
  channels    jsonb NOT NULL DEFAULT '[]',
  reactions   jsonb NOT NULL DEFAULT '{}',
  attachments jsonb NOT NULL DEFAULT '[]',
  files       jsonb NOT NULL DEFAULT '[]',
  pinned      boolean NOT NULL DEFAULT false,
  pinned_at   timestamptz,
  pinned_by   jsonb,
  starred     text[] NOT NULL DEFAULT '{}',
  edited_at   timestamptz,
  edited_by   jsonb,
  alias       text,
  emoji       text,
  avatar      text,
  extra       jsonb NOT NULL DEFAULT '{}',
  unread      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(msg, ''))) STORED
);
CREATE INDEX messages_room_ts_idx ON messages (room_id, created_at DESC);
CREATE INDEX messages_tmid_idx ON messages (tmid, created_at) WHERE tmid IS NOT NULL;
CREATE INDEX messages_search_idx ON messages USING gin (search);
CREATE INDEX messages_pinned_idx ON messages (room_id) WHERE pinned;
CREATE INDEX messages_user_idx ON messages (user_id, created_at DESC);

-- Read receipts: quem leu cada mensagem e quando.
CREATE TABLE message_reads (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id    text NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_reads_room_idx ON message_reads (room_id);

CREATE TABLE files (
  id          text PRIMARY KEY,
  room_id     text REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  message_id  text,
  name        text NOT NULL,
  type        text NOT NULL,
  size        bigint NOT NULL,
  storage_path text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_room_idx ON files (room_id, created_at DESC);

CREATE TABLE invites (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  days        integer NOT NULL DEFAULT 0,
  max_uses    integer NOT NULL DEFAULT 0,
  uses        integer NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_emoji (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  aliases     text[] NOT NULL DEFAULT '{}',
  content_type text NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Trilhas de auditoria (ações administrativas e consultas de auditoria).
CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  actor_id    text,
  actor_username text,
  action      text NOT NULL,
  target      jsonb NOT NULL DEFAULT '{}',
  data        jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- Eventos de atividade para o dashboard de engajamento.
CREATE TABLE activity_daily (
  day        date NOT NULL,
  user_id    text NOT NULL,
  messages   integer NOT NULL DEFAULT 0,
  sessions   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

-- Eventos grandes de tempo real que não cabem no NOTIFY.
CREATE TABLE realtime_spill (
  id         bigserial PRIMARY KEY,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_reports (
  id          text PRIMARY KEY,
  message_id  text,
  room_id     text,
  reported_user_id text,
  reporter_id text NOT NULL,
  description text NOT NULL DEFAULT '',
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Instâncias ativas do servidor e conexões em tempo real (presença).
CREATE TABLE instances (
  id         text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  info       jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE presence_connections (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  session_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX presence_connections_user_idx ON presence_connections (user_id);

CREATE TABLE room_avatars (
  room_id      text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data         bytea NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Histórico de edições de mensagens (Message_KeepHistory).
CREATE TABLE message_history (
  id          bigserial PRIMARY KEY,
  message_id  text NOT NULL,
  room_id     text NOT NULL,
  msg         text NOT NULL,
  edited_by   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_history_msg_idx ON message_history (message_id);
