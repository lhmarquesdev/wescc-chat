-- Agenda: eventos do chat e trazidos do Google Agenda / Outlook, convidados, reuniões com link e a sincronização.

-- Contas de agenda de cada pessoa (uma por fornecedor). Tokens cifrados (AAD calendar:<id>:<campo>); nunca saem pela API.
-- sync_state: o que a leitura incremental precisa (Google: syncToken; Microsoft: deltaLink e o início da janela).
CREATE TABLE calendar_accounts (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email            text NOT NULL DEFAULT '',
  display_name     text NOT NULL DEFAULT '',
  direction        text NOT NULL DEFAULT 'both' CHECK (direction IN ('import', 'export', 'both')),
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  sync_state       jsonb NOT NULL DEFAULT '{}',
  dirty            boolean NOT NULL DEFAULT true,  -- algo do chat mudou: enviar na próxima rodada
  status           text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired', 'error')),
  status_text      text,
  last_sync_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- source chat: criado no chat (owner = organizador). google/microsoft: trazido da conta account_id, visível só ao dono.
-- Evento cancelado fica um tempo (canceled_at) para as cópias no Google/Outlook serem apagadas e os convidados avisados.
CREATE TABLE calendar_events (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  all_day           boolean NOT NULL DEFAULT false,  -- dia inteiro: 00:00 UTC do primeiro dia até 00:00 UTC do dia seguinte ao último
  source            text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'google', 'microsoft')),
  account_id        text REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  external_id       text,
  external_url      text,
  external_join_url text,
  is_meeting        boolean NOT NULL DEFAULT false,
  meeting_code      text UNIQUE,
  meeting_access    text NOT NULL DEFAULT 'invited' CHECK (meeting_access IN ('invited', 'org')),
  room_id           text REFERENCES rooms(id) ON DELETE SET NULL,
  reminder_minutes  int CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 10080),
  reminded_at       timestamptz,
  status            text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'canceled')),
  canceled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at),
  CHECK ((source = 'chat') = (account_id IS NULL)),
  CHECK (NOT is_meeting OR (source = 'chat' AND meeting_code IS NOT NULL)),
  UNIQUE (account_id, external_id)
);
CREATE INDEX calendar_events_owner_idx ON calendar_events (owner_id, starts_at);
CREATE INDEX calendar_events_range_idx ON calendar_events (starts_at, ends_at) WHERE status = 'confirmed';
CREATE INDEX calendar_events_room_idx ON calendar_events (room_id) WHERE room_id IS NOT NULL;
CREATE INDEX calendar_events_reminder_idx ON calendar_events (starts_at) WHERE reminded_at IS NULL AND reminder_minutes IS NOT NULL AND status = 'confirmed';

CREATE TABLE calendar_attendees (
  event_id     text NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response     text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'accepted', 'declined', 'tentative')),
  responded_at timestamptz,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX calendar_attendees_user_idx ON calendar_attendees (user_id);

-- Cópia de um evento do chat numa conta externa. version = updated_at do evento quando a cópia foi gravada.
CREATE TABLE calendar_exports (
  event_id    text NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  account_id  text NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  version     timestamptz NOT NULL,
  PRIMARY KEY (event_id, account_id),
  UNIQUE (account_id, external_id)
);

-- OAuth das contas de agenda usa o mesmo state de uso único das integrações.
ALTER TABLE integration_oauth_states DROP CONSTRAINT integration_oauth_states_purpose_check;
ALTER TABLE integration_oauth_states ADD CONSTRAINT integration_oauth_states_purpose_check
  CHECK (purpose IN ('jira-user', 'msteams-service', 'calendar-google', 'calendar-microsoft'));
