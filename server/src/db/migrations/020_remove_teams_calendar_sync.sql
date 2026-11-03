-- Sai a integração com o Microsoft Teams (ponte de mensagens, reuniões do Teams, presença, conta de serviço) e a
-- sincronização da Agenda com o Google Agenda e o Outlook. A Agenda do chat, as reuniões com link e convites e a
-- integração com o Jira continuam.

-- ---------- Microsoft Teams ----------

-- Regras do Teams (tarefas, atividade e assinaturas saem junto: ON DELETE CASCADE).
DELETE FROM integrations WHERE type IN ('msteams-outgoing', 'msteams-incoming');

DROP TABLE IF EXISTS msteams_bridge_messages, msteams_subscriptions, external_presence, meetings;

DELETE FROM integration_jobs WHERE kind LIKE 'msteams.%';
DELETE FROM integration_activity WHERE provider = 'msteams';
DELETE FROM linked_accounts WHERE provider = 'microsoft';
DELETE FROM integration_oauth_states WHERE purpose <> 'jira-user';
DELETE FROM integration_secrets WHERE id LIKE 'msteams.%' OR id LIKE 'calendar.%';

-- O robô do Teams (se chegou a ser criado) fica desativado: as mensagens antigas dele continuam com autor.
UPDATE users SET active = false
 WHERE id = (SELECT data->>'id' FROM integration_state WHERE id = 'bot.msteams');
DELETE FROM integration_state WHERE id = 'bot.msteams' OR id LIKE 'msteams.%' OR id LIKE 'lease:msteams.%' OR id LIKE 'alert:msteams.%';

-- Cartões da ponte do Teams nas mensagens antigas viram texto comum; reuniões do Teams anunciadas saem do cartão.
UPDATE messages SET extra = extra - 'bridge' WHERE extra ? 'bridge';
UPDATE messages SET extra = extra - 'meeting' WHERE extra->'meeting'->>'provider' = 'msteams';

ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check
  CHECK (type IN ('webhook-incoming', 'webhook-outgoing', 'jira-events'));

CREATE OR REPLACE FUNCTION integration_bot_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM integrations WHERE user_id = OLD.id AND type = 'jira-events') THEN
    RAISE EXCEPTION 'Este usuário é o robô de uma integração. Exclua as regras dela antes.' USING ERRCODE = 'WI001';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

ALTER TABLE integration_activity DROP CONSTRAINT IF EXISTS integration_activity_provider_check;
ALTER TABLE integration_activity ADD CONSTRAINT integration_activity_provider_check CHECK (provider IN ('jira'));

ALTER TABLE linked_accounts DROP CONSTRAINT IF EXISTS linked_accounts_provider_check;
ALTER TABLE linked_accounts ADD CONSTRAINT linked_accounts_provider_check CHECK (provider IN ('jira'));
ALTER TABLE linked_accounts DROP CONSTRAINT IF EXISTS linked_accounts_method_check;
ALTER TABLE linked_accounts ADD CONSTRAINT linked_accounts_method_check CHECK (method IN ('token', 'oauth'));

ALTER TABLE integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_purpose_check;
ALTER TABLE integration_oauth_states ADD CONSTRAINT integration_oauth_states_purpose_check CHECK (purpose IN ('jira-user'));

DELETE FROM settings WHERE id LIKE 'MSTeams\_%';
DELETE FROM permissions WHERE id IN ('manage-msteams', 'start-msteams-meeting');

-- ---------- Sincronização da Agenda com Google e Outlook ----------

-- Eventos trazidos de fora somem; os do chat ficam. As cópias levadas para fora não são apagadas lá.
DELETE FROM calendar_events WHERE source <> 'chat';
ALTER TABLE calendar_events
  DROP COLUMN IF EXISTS account_id,
  DROP COLUMN IF EXISTS external_id,
  DROP COLUMN IF EXISTS external_url,
  DROP COLUMN IF EXISTS external_join_url,
  DROP COLUMN IF EXISTS source;
DROP TABLE IF EXISTS calendar_exports, calendar_accounts;

DELETE FROM settings WHERE id IN ('Calendar_Sync_Minutes', 'Calendar_Google_Enabled', 'Calendar_Google_Client_Id', 'Calendar_Microsoft_Enabled');
