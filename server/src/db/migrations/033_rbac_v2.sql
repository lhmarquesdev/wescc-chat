-- Papéis e permissões v2: Admin › Salas sem escrita escondida em "Visualizar".
-- Ninguém ganha poder novo: só formaliza o que view-room-administration já deixava fazer pelo painel de salas.
-- A chave nova assign-roles não está aqui: nasce no boot pelo catálogo, com quem já dava papéis (inheritsFrom).

-- Admin › Salas › adicionar pessoa passa a checar add-user-to-any-c-room (canal) e add-user-to-any-p-room (grupo
-- privado), como o resto do chat. Quem tem view-room-administration num papel global já fazia isso pelo painel: recebe
-- as duas que faltam. (Num papel de sala view-room-administration não vale, então ele não ganha nada.) Cada papel que
-- ganhou fica no histórico (autor: migração) com o antes e o depois completos. Todas as partes do WITH leem o estado
-- de antes do UPDATE. Numa instalação nova a tabela permissions ainda está vazia aqui (o seed vem no boot) e nada muda.
WITH holders AS (
  SELECT DISTINCT unnest(roles) AS role FROM permissions WHERE id = 'view-room-administration'
),
gain AS (
  SELECT h.role, array_agg(p.id ORDER BY p.id COLLATE "C") AS keys
  FROM holders h
  JOIN roles r ON r.id = h.role AND r.scope = 'Users'
  JOIN permissions p ON p.id IN ('add-user-to-any-c-room', 'add-user-to-any-p-room') AND NOT (h.role = ANY(p.roles))
  GROUP BY h.role
),
upd AS (
  UPDATE permissions p
  SET roles = p.roles || ARRAY(SELECT g.role FROM gain g WHERE p.id = ANY(g.keys) ORDER BY g.role)
  WHERE p.id IN ('add-user-to-any-c-room', 'add-user-to-any-p-room')
    AND EXISTS (SELECT 1 FROM gain g WHERE p.id = ANY(g.keys))
  RETURNING p.id
),
snap AS (
  SELECT g.role, g.keys,
         coalesce((SELECT array_agg(p.id ORDER BY p.id COLLATE "C") FROM permissions p WHERE g.role = ANY(p.roles)), '{}') AS perms
  FROM gain g
)
INSERT INTO rbac_history (entity_type, entity_id, entity_label, action, source, changes)
SELECT 'role', s.role, s.role, 'update', 'migration',
       jsonb_build_array(jsonb_build_object(
         'field', 'permissions',
         'before', to_jsonb(s.perms),
         'after', to_jsonb((SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(s.perms || s.keys) AS k))))
FROM snap s;
