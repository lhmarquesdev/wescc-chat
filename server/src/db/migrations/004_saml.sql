-- SAML: pedidos em andamento (validação de InResponseTo, compartilhada entre instâncias)
-- e credenciais de uso único trocadas pelo cliente web por uma sessão.
CREATE TABLE saml_requests (
  id          text PRIMARY KEY,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saml_credentials (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
