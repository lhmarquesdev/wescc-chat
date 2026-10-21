-- Integrações: webhooks de entrada e de saída.
CREATE TABLE integrations (
  id                     text PRIMARY KEY,
  type                   text NOT NULL CHECK (type IN ('webhook-incoming', 'webhook-outgoing')),
  name                   text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  token                  text NOT NULL,
  user_id                text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username               text NOT NULL,
  channels               text[] NOT NULL DEFAULT '{}',
  event                  text,
  trigger_words          text[] NOT NULL DEFAULT '{}',
  trigger_word_anywhere  boolean NOT NULL DEFAULT false,
  urls                   text[] NOT NULL DEFAULT '{}',
  alias                  text,
  avatar                 text,
  emoji                  text,
  impersonate_user       boolean NOT NULL DEFAULT false,
  run_on_edits           boolean NOT NULL DEFAULT false,
  retry_failed_calls     boolean NOT NULL DEFAULT true,
  retry_count            integer NOT NULL DEFAULT 5,
  retry_delay            text NOT NULL DEFAULT 'powers-of-ten',
  target_room            text,
  script_enabled         boolean NOT NULL DEFAULT false,
  script                 text NOT NULL DEFAULT '',
  created_by             text REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integrations_event_idx ON integrations (event) WHERE type = 'webhook-outgoing' AND enabled;

CREATE TABLE integration_history (
  id              text PRIMARY KEY,
  integration_id  text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event           text NOT NULL,
  step            text NOT NULL,
  url             text,
  data            jsonb,
  http_status     integer,
  response        text,
  error           text,
  finished        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_history_idx ON integration_history (integration_id, created_at DESC);
