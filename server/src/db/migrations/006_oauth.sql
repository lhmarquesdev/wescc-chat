-- Login com OAuth 2.0 / OpenID Connect (Google, GitHub, GitLab, Microsoft e provedores personalizados).

-- A credencial de uso único entregue ao cliente web passa a servir para SAML e OAuth.
ALTER TABLE saml_credentials RENAME TO sso_credentials;
ALTER TABLE sso_credentials ADD COLUMN method text NOT NULL DEFAULT 'saml';
ALTER TABLE sso_credentials ALTER COLUMN method DROP DEFAULT;
CREATE INDEX sso_credentials_expires_idx ON sso_credentials (expires_at);

CREATE TABLE oauth_providers (
  id                 text PRIMARY KEY,
  type               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT false,
  label              text NOT NULL DEFAULT '',
  button_color       text NOT NULL DEFAULT '#1d74f5',
  button_text_color  text NOT NULL DEFAULT '#ffffff',
  client_id          text NOT NULL DEFAULT '',
  client_secret      text NOT NULL DEFAULT '',
  server_url         text NOT NULL DEFAULT '',
  tenant             text NOT NULL DEFAULT '',
  authorize_url      text NOT NULL DEFAULT '',
  token_url          text NOT NULL DEFAULT '',
  identity_url       text NOT NULL DEFAULT '',
  scope              text NOT NULL DEFAULT '',
  token_auth         text NOT NULL DEFAULT 'post',
  token_sent_via     text NOT NULL DEFAULT 'header',
  access_token_param text NOT NULL DEFAULT 'access_token',
  identity_path      text NOT NULL DEFAULT '',
  field_map          jsonb NOT NULL DEFAULT '{}',
  login_style        text NOT NULL DEFAULT 'redirect',
  merge_users        boolean NOT NULL DEFAULT false,
  block_new_users    boolean NOT NULL DEFAULT false,
  roles_claim        text NOT NULL DEFAULT '',
  sync_roles         boolean NOT NULL DEFAULT false,
  merge_roles        boolean NOT NULL DEFAULT false,
  role_mapping       jsonb NOT NULL DEFAULT '{}',
  groups_claim       text NOT NULL DEFAULT '',
  map_channels       boolean NOT NULL DEFAULT false,
  channel_mapping    jsonb NOT NULL DEFAULT '{}',
  sort               int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Contas externas vinculadas a usuários locais (um usuário pode entrar por mais de um provedor).
-- synced_roles guarda os papéis concedidos pelo provedor no último login (base da mesclagem de papéis).
CREATE TABLE oauth_identities (
  provider_id  text NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
  subject      text NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  synced_roles text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_login   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, subject)
);
CREATE INDEX oauth_identities_user_idx ON oauth_identities (user_id);

-- Logins em andamento: hash do state, verificador PKCE, navegador que iniciou e destino após o login.
CREATE TABLE oauth_states (
  state_hash    text PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
  browser_hash  text NOT NULL,
  code_verifier text NOT NULL,
  redirect      text NOT NULL DEFAULT '/home',
  expires_at    timestamptz NOT NULL
);
CREATE INDEX oauth_states_expires_idx ON oauth_states (expires_at);
