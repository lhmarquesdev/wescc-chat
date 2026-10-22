-- Conversas diretas restritas por papel, canais de avisos com "Ciente" e sincronização do LDAP / Active Directory.

-- (a) Papéis restritos em conversas diretas.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS restrict_direct boolean NOT NULL DEFAULT false;

-- Papel "Operação": restrito e com permissões próprias (sem as do papel user). Só é criado se ainda não houver
-- um papel com esse nome; as permissões só são dadas quando ele nasce aqui (um papel do administrador não é tocado).
WITH ins AS (
  INSERT INTO roles (id, description, scope, protected, mandatory_2fa, restrict_direct)
  SELECT 'operacao', 'Operação', 'Users', false, false, true
  WHERE NOT EXISTS (SELECT 1 FROM roles WHERE lower(id) = 'operacao')
  RETURNING id
)
UPDATE permissions SET roles = array_append(roles, 'operacao')
WHERE id IN ('create-d', 'view-c-room', 'view-p-room', 'view-d-room', 'view-joined-room', 'preview-c-room',
             'view-outside-room', 'view-room-members', 'delete-own-message', 'view-message-read-receipts')
  AND NOT ('operacao' = ANY(roles)) AND EXISTS (SELECT 1 FROM ins);

-- (b) Canais de avisos e "Ciente".
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS notice boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS notice_ack boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ack_required boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ack_count integer NOT NULL DEFAULT 0;
ALTER TABLE message_reads ADD COLUMN IF NOT EXISTS ack_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_ack_idx ON messages (room_id, created_at DESC) WHERE ack_required;
-- O publicador (papel de sala, semeado no boot) escreve em salas somente leitura e pode chamar @all/@here nelas.
UPDATE permissions SET roles = array_append(roles, 'publisher')
WHERE id IN ('post-readonly', 'mention-all', 'mention-here') AND NOT ('publisher' = ANY(roles));

-- (c) Estado da sincronização LDAP por usuário.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_dn text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_synced_at timestamptz;
-- Preenchidos só quando a própria sincronização desativa a conta: só essas ela reativa.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_deactivated_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_deactivated_reason text CHECK (ldap_deactivated_reason IN ('removed', 'disabled'));
-- Foto aplicada pelo LDAP: o hash evita regravar a mesma foto; o etag mostra se o avatar atual ainda é o do diretório.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_avatar_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_avatar_etag text;

CREATE TABLE IF NOT EXISTS ldap_sync_runs (
  id           text PRIMARY KEY,
  trigger      text NOT NULL CHECK (trigger IN ('cron', 'manual', 'api')),
  status       text NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  started_by   text REFERENCES users(id) ON DELETE SET NULL,
  instance_id  text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  counts       jsonb NOT NULL DEFAULT '{}',
  changes      jsonb NOT NULL DEFAULT '[]',   -- até 500 LdapSyncChange
  errors       jsonb NOT NULL DEFAULT '[]',   -- até 200 LdapSyncIssue
  warnings     jsonb NOT NULL DEFAULT '[]',   -- até 100 textos
  error        text                            -- erro fatal (bind, busca)
);
CREATE INDEX IF NOT EXISTS ldap_sync_runs_started_idx ON ldap_sync_runs (started_at DESC);
