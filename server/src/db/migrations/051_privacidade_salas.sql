-- Discussão aberta (t = 'c') numa sala que não é pública (grupo privado, conversa direta ou canal de time privado)
-- virava um canal que qualquer pessoa lia e em que entrava. Passa a grupo privado, com os mesmos membros; as novas já
-- nascem assim (createDiscussion).
UPDATE rooms d SET t = 'p', updated_at = now()
  FROM rooms p
 WHERE d.prid = p.id
   AND d.t = 'c'
   AND (p.t <> 'c'
        OR (p.team_id IS NOT NULL AND NOT p.team_main AND EXISTS (SELECT 1 FROM teams t WHERE t.id = p.team_id AND t.type = 1)));
