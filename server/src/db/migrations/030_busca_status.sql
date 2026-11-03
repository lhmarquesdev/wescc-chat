-- Busca da barra lateral sem acento, status personalizados (Administração › Status do usuário).
-- Palavras destacadas ficam em users.preferences.highlights e não mudam o esquema.

-- (a) Texto para comparar sem acento e sem maiúsculas (a web usa a mesma ideia: foldText em shared/search.ts).
CREATE OR REPLACE FUNCTION wescc_fold(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(translate(t,
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'aaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuuccnn'))
$$;

-- (b) Status personalizados: o tipo decide o comportamento (ocupado silencia notificações).
CREATE TABLE IF NOT EXISTS custom_user_statuses (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  status_type text NOT NULL CHECK (status_type IN ('online', 'away', 'busy', 'offline')),
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- "Almoço" e "almoco" são o mesmo nome.
CREATE UNIQUE INDEX IF NOT EXISTS custom_user_statuses_name_uq ON custom_user_statuses (wescc_fold(btrim(name)));

-- Os quatro da operação.
INSERT INTO custom_user_statuses (id, name, status_type) VALUES
  ('status-em-pausa',       'Em pausa',       'away'),
  ('status-em-atendimento', 'Em atendimento', 'busy'),
  ('status-almoco',         'Almoço',         'away'),
  ('status-em-reuniao',     'Em reunião',     'busy')
ON CONFLICT DO NOTHING;

-- Status personalizado escolhido; o tipo dele vai em status_default. Excluir o status deixa a pessoa no tipo base.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_custom text REFERENCES custom_user_statuses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_status_custom_idx ON users (status_custom) WHERE status_custom IS NOT NULL;
