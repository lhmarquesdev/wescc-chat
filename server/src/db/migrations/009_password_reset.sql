-- Links de redefinição de senha enviados por e-mail (só o hash do token fica no banco).
CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);
