-- Tentativas de login falhas, compartilhadas entre instâncias (por login e por IP).
CREATE TABLE login_attempts (
  key text PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Papéis concedidos pelo SAML no último login (para não remover papéis dados à mão).
ALTER TABLE users ADD COLUMN saml_synced_roles text[] NOT NULL DEFAULT '{}';

-- Convidados só veem os canais públicos em que foram adicionados.
UPDATE permissions SET roles = array_remove(roles, 'guest') WHERE id = 'view-c-room';

-- Mascara segredos já gravados na auditoria por versões anteriores (só "Password" era mascarado).
UPDATE audit_log SET data = jsonb_set(data, '{settings}', (
  SELECT jsonb_agg(CASE WHEN s->>'_id' ~* '(Password|Secret|Token|Private_?Key)' THEN jsonb_set(s, '{value}', '"***"') ELSE s END)
  FROM jsonb_array_elements(data->'settings') s
))
WHERE action = 'settings.changed' AND jsonb_typeof(data->'settings') = 'array' AND jsonb_array_length(data->'settings') > 0;
