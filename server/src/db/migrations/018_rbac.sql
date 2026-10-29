-- Papéis e permissões no modelo RBAC: papel raiz por flag, delegação de papéis e histórico com reversão.
-- Nenhuma permissão muda de dono aqui ("ninguém ganha, ninguém perde"); a chave nova view-permissions nasce no boot
-- com quem já tinha access-permissions ou manage-roles.

-- Papel raiz: passa pela hierarquia de concessão (dá e tira qualquer permissão, edita qualquer papel, define
-- delegações). É uma flag, não o nome; só o papel admin a tem e o índice impede um segundo.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_root boolean NOT NULL DEFAULT false;
UPDATE roles SET is_root = true WHERE id = 'admin';
CREATE UNIQUE INDEX IF NOT EXISTS roles_single_root ON roles (is_root) WHERE is_root;

-- Papéis que quem tem este papel pode dar, tirar e editar mesmo sem ter tudo o que eles dão. Só o raiz altera.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS delegable_roles text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS rbac_history (
  id              bigserial PRIMARY KEY,
  batch_id        text,
  entity_type     text NOT NULL CHECK (entity_type IN ('role', 'user')),
  entity_id       text NOT NULL,          -- sem FK: o registro sobrevive à exclusão
  entity_label    text NOT NULL DEFAULT '',
  action          text NOT NULL,          -- create | update | delete | bulk | rollback
  source          text NOT NULL DEFAULT 'manual', -- manual | system | ldap | oauth | saml | omnichannel | migration
  actor_id        text REFERENCES users(id) ON DELETE SET NULL,
  actor_username  text,
  changes         jsonb NOT NULL DEFAULT '[]', -- [{ field, before, after }]
  rolled_back_at  timestamptz,
  rolled_back_by  text REFERENCES users(id) ON DELETE SET NULL,
  reverts_id      bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rbac_history_created_idx ON rbac_history (created_at DESC);
CREATE INDEX IF NOT EXISTS rbac_history_entity_idx ON rbac_history (entity_type, entity_id);

-- Delegação pré-preenchida para ninguém parar de trabalhar: até aqui, quem administrava usuários ou papéis
-- (edit-other-user-info, access-permissions, manage-roles e as outras ações sobre pessoas) agia sobre qualquer pessoa e
-- dava qualquer papel (menos o de administrador). Agora só age sobre quem cabe nas próprias permissões; a delegação
-- devolve o que esse papel já fazia, menos sobre administradores. O administrador revisa as listas em Papéis e
-- permissões (cada uma fica no histórico).
WITH managers AS (
  SELECT r.id FROM roles r
  WHERE r.scope = 'Users' AND NOT r.is_root
    AND EXISTS (SELECT 1 FROM permissions p WHERE p.id IN ('access-permissions', 'manage-roles', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status',
                                                         'edit-other-user-password', 'edit-other-user-avatar', 'edit-other-user-totp', 'delete-user', 'logout-other-user') AND r.id = ANY(p.roles))
),
plan AS (
  SELECT m.id AS manager,
         coalesce(array_agg(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS targets
  FROM managers m
  LEFT JOIN roles t ON t.scope = 'Users' AND NOT t.is_root AND t.id <> m.id
    -- só os papéis que não cabem nas permissões do gestor (os outros ele já pode dar)
    AND EXISTS (SELECT 1 FROM permissions p WHERE t.id = ANY(p.roles) AND NOT (m.id = ANY(p.roles)))
  GROUP BY m.id
),
upd AS (
  UPDATE roles r SET delegable_roles = plan.targets FROM plan
  WHERE r.id = plan.manager AND cardinality(plan.targets) > 0
  RETURNING r.id, r.delegable_roles
)
INSERT INTO rbac_history (entity_type, entity_id, entity_label, action, source, changes)
SELECT 'role', upd.id, upd.id, 'update', 'migration', jsonb_build_array(jsonb_build_object('field', 'delegable', 'before', '[]'::jsonb, 'after', to_jsonb(upd.delegable_roles)))
FROM upd;
