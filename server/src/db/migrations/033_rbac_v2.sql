-- Papéis e permissões v2: o "para que serve" de cada papel, e Admin › Salas sem escrita escondida em "Visualizar".
-- Ninguém ganha poder novo: (b) só formaliza o que view-room-administration já deixava fazer pelo painel de salas.
-- A chave nova assign-roles não está aqui: nasce no boot pelo catálogo, com quem já dava papéis (inheritsFrom).

-- (a) Para que serve o papel: uma frase simples que a tela mostra embaixo do nome. O nome exibido continua em
-- roles.description (até 32 caracteres vira o nome, web/src/lib/format.ts).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '';

-- Papel criado pelo administrador com descrição longa ou terminada em pontuação: ela não vira nome e já é, na
-- prática, o "para que serve". Copia; a descrição fica como está.
UPDATE roles SET purpose = left(btrim(description), 200)
WHERE NOT protected AND purpose = '' AND btrim(description) <> ''
  AND (length(btrim(description)) > 32 OR btrim(description) ~ '[.!?]$');

-- O papel Operação (migração 013) ganha a frase dele, se ninguém escreveu outra.
UPDATE roles SET purpose = 'Turno de operação: lê canais e conversa em particular só com quem não é restrito.'
WHERE id = 'operacao' AND purpose = '';

-- (b) Admin › Salas › adicionar pessoa passa a checar add-user-to-any-c-room (canal) e add-user-to-any-p-room (grupo
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
