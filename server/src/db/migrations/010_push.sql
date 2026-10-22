-- Inscrições de Web Push (uma por navegador/dispositivo). Saem junto com a sessão (logout, revogação, expiração).
CREATE TABLE push_subscriptions (
  endpoint     text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
