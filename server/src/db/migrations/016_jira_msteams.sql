-- Integrações com Jira e Microsoft Teams: regras, segredos cifrados, contas vinculadas, fila de tarefas e mapeamentos.

-- Regras do Jira e do Teams são linhas de integrations com tipos novos e configuração em JSON.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'integrations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%webhook-incoming%'
  LOOP
    EXECUTE format('ALTER TABLE integrations DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('webhook-incoming', 'webhook-outgoing', 'jira-events', 'msteams-outgoing', 'msteams-incoming'));
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS config        jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS secret        text,          -- cifrado (lib/secrets.ts); nunca sai pela API
  ADD COLUMN IF NOT EXISTS last_ok_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_error    text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
CREATE INDEX IF NOT EXISTS integrations_type_idx ON integrations (type) WHERE enabled;

-- O robô de uma regra do Jira ou do Teams não pode ser excluído enquanto a regra existir
-- (a chave estrangeira apagaria as regras em silêncio).
CREATE OR REPLACE FUNCTION integration_bot_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM integrations WHERE user_id = OLD.id AND type IN ('jira-events', 'msteams-outgoing', 'msteams-incoming')) THEN
    RAISE EXCEPTION 'Este usuário é o robô de uma integração. Exclua as regras dela antes.' USING ERRCODE = 'WI001';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_integration_bot_guard BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION integration_bot_guard();

-- Segredos globais (token da conta da integração, segredo do webhook, client secret...). value é cifrado.
CREATE TABLE integration_secrets (
  id          text PRIMARY KEY,                -- 'jira.apiToken', 'msteams.clientSecret', ...
  value       text NOT NULL,
  hint        text,                            -- últimos 4 caracteres, para o administrador reconhecer
  bound_to    text,                            -- origem do Jira a que o segredo pertence (também entra no AAD); null nos demais
  expires_at  timestamptz,                     -- validade informada pelo administrador (tokens expiram)
  updated_by  text REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Estado pequeno das tarefas periódicas: 'jira.poll', 'lease:<tarefa>', 'msteams.in:<regra>', 'msteams.budget:<dono>',
-- 'secrets.kid', 'alert:<chave>', 'bot.jira', 'bot.msteams', 'jira.webhook', 'msteams.service'...
CREATE TABLE integration_state (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Atividade das integrações (o que foi publicado, o que falhou), para a aba "Atividade". Sem segredos.
CREATE TABLE integration_activity (
  id              text PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('jira', 'msteams')),
  integration_id  text REFERENCES integrations(id) ON DELETE CASCADE,
  tone            text NOT NULL CHECK (tone IN ('ok', 'warn', 'err', 'info')),
  text            text NOT NULL,
  detail          text,
  job_id          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_activity_idx ON integration_activity (provider, created_at DESC);
CREATE INDEX integration_activity_rule_idx ON integration_activity (integration_id, created_at DESC) WHERE integration_id IS NOT NULL;

-- Contas externas de cada pessoa. Tokens cifrados com AAD "linked:<user>:<provider>:<campo>[:<origem do Jira>]".
CREATE TABLE linked_accounts (
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('jira', 'microsoft')),
  method             text NOT NULL CHECK (method IN ('token', 'oauth', 'directory')),
  external_id        text NOT NULL,           -- accountId do Jira; id (oid) do usuário no Entra
  display_name       text NOT NULL DEFAULT '',
  email              text,                    -- microsoft: o e-mail do chat usado na busca (muda → a linha vale de novo só após nova busca)
  site               text,                    -- jira: origem do Jira em que a conta foi validada
  access_token       text,                    -- cifrado (token pessoal ou access token OAuth)
  refresh_token      text,                    -- cifrado (OAuth)
  token_expires_at   timestamptz,             -- access token OAuth
  secret_expires_at  timestamptz,             -- validade do token pessoal, informada pela pessoa
  scopes             text[] NOT NULL DEFAULT '{}',
  meta               jsonb NOT NULL DEFAULT '{}',   -- microsoft: {"upn": "...", "busySync": true}; jira: {"base": "gateway"}
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired', 'error')),
  status_text        text,
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE UNIQUE INDEX linked_accounts_external_idx ON linked_accounts (provider, external_id);

-- Estados de OAuth em andamento (10 minutos). Só o hash do state e do cookie do navegador ficam no banco.
CREATE TABLE integration_oauth_states (
  state_hash     text PRIMARY KEY,
  purpose        text NOT NULL CHECK (purpose IN ('jira-user', 'msteams-service')),
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser_hash   text NOT NULL,
  code_verifier  text,                         -- cifrado (PKCE, Microsoft)
  redirect_uri   text NOT NULL,
  return_to      text NOT NULL DEFAULT '/',
  expires_at     timestamptz NOT NULL
);

-- Fila persistente de chamadas externas com novas tentativas. Tarefas do mesmo group_key rodam uma por vez, em ordem.
CREATE TABLE integration_jobs (
  id              text PRIMARY KEY,
  kind            text NOT NULL,               -- 'jira.webhook', 'jira.post', 'jira.unfurl', 'jira.remotelink', 'msteams.post', ...
  integration_id  text REFERENCES integrations(id) ON DELETE CASCADE,
  group_key       text,                        -- 'jira:<regra>:<sala>', 'msteams:<regra>', 'msteams.in:<regra>'
  payload         jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead', 'merged')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 6,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX integration_jobs_dedupe_idx ON integration_jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX integration_jobs_due_idx ON integration_jobs (run_at) WHERE status = 'queued';
CREATE INDEX integration_jobs_group_idx ON integration_jobs (group_key, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX integration_jobs_running_idx ON integration_jobs (locked_at) WHERE status = 'running';
CREATE INDEX integration_jobs_rule_idx ON integration_jobs (integration_id, created_at DESC);

-- Chaves já vistas (entregas de webhook, eventos já publicados). Limpas depois de 7 dias.
CREATE TABLE integration_seen (
  scope       text NOT NULL,                   -- 'jira.delivery', 'jira.event', 'jira.created-from-chat', 'post'
  key         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX integration_seen_age_idx ON integration_seen (created_at);

-- Tópico de cada issue por regra e sala (o id da issue não muda quando a issue troca de projeto).
CREATE TABLE jira_threads (
  integration_id  text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  room_id         text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  issue_id        text NOT NULL,
  issue_key       text NOT NULL,
  message_id      text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, room_id, issue_id)
);

-- Mensagens do Teams copiadas para o chat (para respostas, edições e exclusões).
CREATE TABLE msteams_bridge_messages (
  integration_id  text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  teams_id        text NOT NULL,
  teams_root_id   text,                        -- null na mensagem raiz
  message_id      text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  edited_at       timestamptz,                 -- lastEditedDateTime já espelhado (reações mudam só lastModifiedDateTime)
  PRIMARY KEY (integration_id, teams_id)
);
CREATE INDEX msteams_bridge_message_idx ON msteams_bridge_messages (message_id);

-- Assinaturas de notificações do Microsoft Graph (mensagens de canal e presença).
CREATE TABLE msteams_subscriptions (
  id                 text PRIMARY KEY,         -- id da assinatura no Graph
  purpose            text NOT NULL CHECK (purpose IN ('messages', 'presence')),
  integration_id     text REFERENCES integrations(id) ON DELETE CASCADE,  -- regra msteams-incoming (messages)
  resource           text NOT NULL,
  client_state_hash  text NOT NULL,            -- sha256 do clientState; o valor só vai para o Graph
  expires_at         timestamptz NOT NULL,
  last_notified_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX msteams_subscriptions_exp_idx ON msteams_subscriptions (expires_at);

-- Reuniões do Teams anunciadas nas salas.
CREATE TABLE meetings (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'msteams' CHECK (provider IN ('msteams')),
  kind          text NOT NULL CHECK (kind IN ('created', 'linked')),
  external_id   text,                          -- id da onlineMeeting (só "created")
  join_url      text NOT NULL,
  subject       text NOT NULL DEFAULT '',
  starts_at     timestamptz,
  ends_at       timestamptz,
  message_id    text REFERENCES messages(id) ON DELETE SET NULL,
  created_by    text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_room_idx ON meetings (room_id, created_at DESC);

-- Presença no Teams (fase 3). applied guarda o que o chat aplicou e o status padrão anterior da pessoa, para restaurar.
CREATE TABLE external_presence (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'msteams' CHECK (provider IN ('msteams')),
  availability  text NOT NULL,
  activity      text NOT NULL,
  applied       jsonb,                         -- {"status": "busy", "previousDefault": "online", "previousText": ""}
  updated_at    timestamptz NOT NULL DEFAULT now()
);
