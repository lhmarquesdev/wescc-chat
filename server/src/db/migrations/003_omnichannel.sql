-- Omnichannel (livechat): visitantes, departamentos, roteamento, fila e recursos de gestão.

CREATE TABLE livechat_business_hours (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'custom' CHECK (type IN ('default', 'custom')),
  active      boolean NOT NULL DEFAULT true,
  timezone    text NOT NULL DEFAULT 'America/Sao_Paulo',
  -- [{ day: 0..6 (domingo = 0), open: 'HH:MM', close: 'HH:MM', enabled: bool }]
  work_hours  jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livechat_units (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livechat_departments (
  id                          text PRIMARY KEY,
  name                        text NOT NULL,
  description                 text NOT NULL DEFAULT '',
  enabled                     boolean NOT NULL DEFAULT true,
  show_on_registration        boolean NOT NULL DEFAULT true,
  show_on_offline_form        boolean NOT NULL DEFAULT true,
  email                       text,
  request_tag_before_closing  boolean NOT NULL DEFAULT false,
  max_chats_per_agent         integer NOT NULL DEFAULT 0,
  fallback_department_id      text REFERENCES livechat_departments(id) ON DELETE SET NULL,
  business_hour_id            text REFERENCES livechat_business_hours(id) ON DELETE SET NULL,
  unit_id                     text REFERENCES livechat_units(id) ON DELETE SET NULL,
  waiting_queue_message       text,
  archived                    boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX livechat_departments_name_uq ON livechat_departments (lower(name));

CREATE TABLE livechat_department_agents (
  department_id  text NOT NULL REFERENCES livechat_departments(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  count          integer NOT NULL DEFAULT 0,
  sort_order     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (department_id, user_id)
);

CREATE TABLE livechat_unit_monitors (
  unit_id  text NOT NULL REFERENCES livechat_units(id) ON DELETE CASCADE,
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (unit_id, user_id)
);

CREATE TABLE livechat_agents (
  user_id          text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'not-available' CHECK (status IN ('available', 'not-available')),
  max_chats        integer,
  last_routing_at  timestamptz,
  total_chats      integer NOT NULL DEFAULT 0
);

CREATE TABLE livechat_visitors (
  id             text PRIMARY KEY,
  token          text NOT NULL UNIQUE,
  username       text NOT NULL UNIQUE,
  name           text NOT NULL DEFAULT '',
  email          text,
  phone          text,
  department_id  text REFERENCES livechat_departments(id) ON DELETE SET NULL,
  custom_fields  jsonb NOT NULL DEFAULT '{}',
  ip             text,
  user_agent     text,
  last_chat      jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX livechat_visitors_email_idx ON livechat_visitors (lower(email));

CREATE TABLE livechat_priorities (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  sort_item   integer NOT NULL,
  dirty       boolean NOT NULL DEFAULT false
);

CREATE TABLE livechat_sla (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  description          text NOT NULL DEFAULT '',
  due_time_minutes     integer NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE livechat_rooms (
  room_id            text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  visitor_id         text NOT NULL REFERENCES livechat_visitors(id) ON DELETE CASCADE,
  department_id      text REFERENCES livechat_departments(id) ON DELETE SET NULL,
  agent_id           text REFERENCES users(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'open', 'onhold', 'closed')),
  priority_id        text REFERENCES livechat_priorities(id) ON DELETE SET NULL,
  sla_id             text REFERENCES livechat_sla(id) ON DELETE SET NULL,
  sla_due            timestamptz,
  tags               text[] NOT NULL DEFAULT '{}',
  livechat_data      jsonb NOT NULL DEFAULT '{}',
  source             jsonb NOT NULL DEFAULT '{"type":"widget"}',
  queued_at          timestamptz NOT NULL DEFAULT now(),
  served_at          timestamptz,
  first_response_at  timestamptz,
  last_visitor_msg   timestamptz,
  last_agent_msg     timestamptz,
  onhold_at          timestamptz,
  closed_at          timestamptz,
  closer             text,
  closed_by          jsonb,
  close_comment      text,
  survey             jsonb,
  transcript_email   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX livechat_rooms_status_idx ON livechat_rooms (status, queued_at);
CREATE INDEX livechat_rooms_agent_idx ON livechat_rooms (agent_id, status);
CREATE INDEX livechat_rooms_visitor_idx ON livechat_rooms (visitor_id, status);

CREATE TABLE livechat_canned_responses (
  id             text PRIMARY KEY,
  shortcut       text NOT NULL,
  text           text NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('global', 'department', 'user')),
  department_id  text REFERENCES livechat_departments(id) ON DELETE CASCADE,
  user_id        text REFERENCES users(id) ON DELETE CASCADE,
  tags           text[] NOT NULL DEFAULT '{}',
  created_by     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX livechat_canned_shortcut_idx ON livechat_canned_responses (lower(shortcut));

CREATE TABLE livechat_tags (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  departments  text[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX livechat_tags_name_uq ON livechat_tags (lower(name));

CREATE TABLE livechat_custom_fields (
  id             text PRIMARY KEY,
  label          text NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('visitor', 'room')),
  visibility     text NOT NULL DEFAULT 'visible',
  regexp         text,
  required       boolean NOT NULL DEFAULT false,
  default_value  text,
  options        text[] NOT NULL DEFAULT '{}',
  public         boolean NOT NULL DEFAULT true
);

CREATE TABLE livechat_triggers (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  run_once     boolean NOT NULL DEFAULT false,
  -- [{ name: 'time-on-site' | 'page-url' | 'chat-opened-by-visitor', value }]
  conditions   jsonb NOT NULL DEFAULT '[]',
  -- [{ name: 'send-message', params: { sender: 'queue' | 'custom', name, msg } }]
  actions      jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE livechat_offline_messages (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL,
  message        text NOT NULL,
  department_id  text REFERENCES livechat_departments(id) ON DELETE SET NULL,
  host           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO livechat_priorities (id, name, sort_item) VALUES
  ('highest', 'Altíssima', 1),
  ('high', 'Alta', 2),
  ('medium', 'Média', 3),
  ('low', 'Baixa', 4),
  ('lowest', 'Baixíssima', 5);

INSERT INTO livechat_business_hours (id, name, type, work_hours) VALUES
  ('default', 'Padrão', 'default',
   '[{"day":0,"open":"08:00","close":"18:00","enabled":false},{"day":1,"open":"08:00","close":"18:00","enabled":true},{"day":2,"open":"08:00","close":"18:00","enabled":true},{"day":3,"open":"08:00","close":"18:00","enabled":true},{"day":4,"open":"08:00","close":"18:00","enabled":true},{"day":5,"open":"08:00","close":"18:00","enabled":true},{"day":6,"open":"08:00","close":"18:00","enabled":false}]');
