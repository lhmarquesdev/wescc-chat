-- Exportar conversa, "Baixar meus dados" (LGPD) e e-mail de login em dispositivo novo.

-- (a) Exportações. kind 'room': tíquete de uso único do download de uma conversa (o arquivo é gerado na hora, não
--     fica no disco). kind 'user': pedido de "Baixar meus dados", gerado em segundo plano em UPLOAD_DIR/exports.
CREATE TABLE IF NOT EXISTS data_exports (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('room', 'user')),
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- quem pediu (em 'user', também o dono dos dados)
  room_id       text REFERENCES rooms(id) ON DELETE CASCADE,
  params        jsonb NOT NULL DEFAULT '{}',                           -- room: período, formato, arquivos, tópicos
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
  token_hash    text UNIQUE,                                           -- room: sha256 do tíquete
  file_path     text,                                                  -- user: exports/<id>.zip, relativo a UPLOAD_DIR
  size          bigint,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz,
  downloaded_at timestamptz,
  CHECK (kind = 'user' OR (room_id IS NOT NULL AND token_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS data_exports_user_idx ON data_exports (user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS data_exports_queue_idx ON data_exports (created_at) WHERE kind = 'user' AND status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS data_exports_ready_idx ON data_exports (expires_at) WHERE status = 'ready';
-- Um pedido de dados por vez para cada pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS data_exports_user_active_uq ON data_exports (user_id) WHERE kind = 'user' AND status IN ('pending', 'running');

-- (b) Índices que a exportação usa. O de message_id também acelera apagar os arquivos de uma mensagem.
CREATE INDEX IF NOT EXISTS files_message_idx ON files (message_id);
CREATE INDEX IF NOT EXISTS files_user_idx ON files (user_id, created_at);

-- (c) Dispositivos já vistos em cada conta (e-mail de login em dispositivo novo). device_hash: sha256 do cookie do
--     navegador ou, fora de navegador, do programa + rede.
CREATE TABLE IF NOT EXISTS user_devices (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash text NOT NULL,
  device      jsonb NOT NULL DEFAULT '{}',   -- { browser, os, name } do último login
  last_ip     text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS user_devices_last_seen_idx ON user_devices (last_seen);
