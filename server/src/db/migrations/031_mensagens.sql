-- Mensagens: encaminhar (arquivo compartilhado entre salas), enquetes, "Lembrar-me" e envios agendados. Idempotente.

-- (a) Encaminhar: a cópia de um arquivo em outra sala é outra linha de files com o mesmo storage_path. O arquivo só
-- sai do disco quando sai a última linha que aponta para ele (uploads.removeFiles confere por este índice).
CREATE INDEX IF NOT EXISTS files_storage_path_idx ON files (storage_path);

-- (b) Enquetes. Pergunta, opções e o resultado que a sala vê ficam em messages.extra.poll; aqui ficam as regras e os
-- votos. A linha sai com a mensagem.
CREATE TABLE IF NOT EXISTS polls (
  message_id  text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id     text NOT NULL,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  multiple    boolean NOT NULL DEFAULT false,
  anonymous   boolean NOT NULL DEFAULT false,
  option_ids  text[] NOT NULL CHECK (cardinality(option_ids) BETWEEN 2 AND 10),
  closes_at   timestamptz,
  closed_at   timestamptz,
  closed_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polls_due_idx ON polls (closes_at) WHERE closed_at IS NULL AND closes_at IS NOT NULL;

-- Sem chave estrangeira em user_id: o voto de quem teve a conta excluída continua contando (como uma reação).
-- Numa enquete anônima o user_id só serve para impedir voto duplo; nenhuma rota o devolve a outra pessoa.
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id text NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  option_id  text NOT NULL,
  voted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_id)
);
CREATE INDEX IF NOT EXISTS poll_votes_option_idx ON poll_votes (message_id, option_id, voted_at);
CREATE INDEX IF NOT EXISTS poll_votes_user_idx ON poll_votes (user_id, message_id);

-- (c) "Lembrar-me": um lembrete por pessoa e mensagem. fired_at preenchido = já avisou e está em "Lembretes" até
-- a pessoa concluir (apagar) ou adiar (fired_at volta a NULL).
CREATE TABLE IF NOT EXISTS message_reminders (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id     text NOT NULL,
  remind_at   timestamptz NOT NULL,
  fired_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_reminders_due_idx ON message_reminders (remind_at) WHERE fired_at IS NULL;
-- Apagar uma mensagem confere esta chave estrangeira: sem índice, cada exclusão varre os lembretes.
CREATE INDEX IF NOT EXISTS message_reminders_message_idx ON message_reminders (message_id);
CREATE INDEX IF NOT EXISTS message_reminders_user_idx ON message_reminders (user_id, remind_at);

-- (d) Envios agendados. O id vira o _id da mensagem enviada: um envio interrompido no meio não sai duas vezes.
-- Enviada, a linha sai; falhou, fica com o motivo até a pessoa editar, enviar agora ou cancelar.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id           text PRIMARY KEY,
  room_id      text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmid         text,
  tshow        boolean NOT NULL DEFAULT false,
  msg          text NOT NULL CHECK (msg <> ''),
  ack_required boolean NOT NULL DEFAULT false,
  send_at      timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed')),
  attempts     int NOT NULL DEFAULT 0,
  error        text,
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx ON scheduled_messages (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_messages_user_idx ON scheduled_messages (user_id, room_id, send_at);
CREATE INDEX IF NOT EXISTS scheduled_messages_room_idx ON scheduled_messages (room_id);
