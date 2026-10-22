-- Importação de dados (Slack, CSV, usuários do Slack, contatos do omnichannel e API), como no Rocket.Chat.

-- Uma linha por importação. Só a mais recente pode estar "válida" (em uso); as outras são histórico.
CREATE TABLE import_operations (
  id               text PRIMARY KEY,
  importer_key     text NOT NULL,
  status           text NOT NULL,
  valid            boolean NOT NULL DEFAULT true,
  user_id          text REFERENCES users(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'none',   -- upload | url | path | none
  file_name        text,                           -- nome original, para o histórico
  file_path        text,                           -- arquivo guardado (ou pasta no servidor)
  content_type     text,
  file_size        bigint,
  count_users      integer NOT NULL DEFAULT 0,
  count_channels   integer NOT NULL DEFAULT 0,
  count_messages   integer NOT NULL DEFAULT 0,
  count_contacts   integer NOT NULL DEFAULT 0,
  count_total      integer NOT NULL DEFAULT 0,
  count_completed  integer NOT NULL DEFAULT 0,
  count_error      integer NOT NULL DEFAULT 0,
  count_skipped    integer NOT NULL DEFAULT 0,
  messages_status  text,
  error            text,
  warnings         jsonb NOT NULL DEFAULT '[]',
  options          jsonb NOT NULL DEFAULT '{}',
  instance_id      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX import_operations_created_idx ON import_operations (created_at DESC);
CREATE UNIQUE INDEX import_operations_one_valid ON import_operations ((true)) WHERE valid;

-- Dados lidos do arquivo, antes de virarem usuários, salas e mensagens (prévia e seleção).
CREATE TABLE import_records (
  id            bigserial PRIMARY KEY,
  operation_id  text NOT NULL REFERENCES import_operations(id) ON DELETE CASCADE,
  data_type     text NOT NULL,                     -- user | channel | message | contact
  import_id     text,                              -- importIds[0] de usuários, salas e contatos
  data          jsonb NOT NULL,
  skipped       boolean NOT NULL DEFAULT false,
  errors        jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX import_records_op_type_idx ON import_records (operation_id, data_type, id);

-- Id na origem (Slack, CSV...) → id aqui. Permite reimportar sem duplicar e ligar threads, menções e salas.
CREATE TABLE import_map (
  kind          text NOT NULL,                     -- user | room | message | contact
  import_id     text NOT NULL,
  target_id     text NOT NULL,
  operation_id  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, import_id)
);
CREATE INDEX import_map_target_idx ON import_map (kind, target_id);

-- Arquivos das mensagens importadas que ainda precisam ser baixados da origem.
CREATE TABLE import_pending_files (
  id              text PRIMARY KEY,
  source_file_id  text NOT NULL,
  message_id      text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id         text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id         text REFERENCES users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  type            text,
  size            bigint,
  url             text,
  external        boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'pending', -- pending | downloaded | failed | unavailable
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  file_id         text,
  operation_id    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, source_file_id)
);
CREATE INDEX import_pending_files_status_idx ON import_pending_files (status) WHERE status IN ('pending', 'failed');

-- Fotos de perfil a baixar depois da importação.
CREATE TABLE import_pending_avatars (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',     -- pending | downloaded | failed
  error       text,
  attempts    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
