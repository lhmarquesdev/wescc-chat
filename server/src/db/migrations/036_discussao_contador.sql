-- O cartão "Discussão: nome" (mensagem de sistema discussion-created) passa a ter a mesma contagem da mensagem de
-- origem: antes só a mensagem de origem guardava drid e dcount, e o cartão dizia "sem mensagens" com a discussão cheia.
UPDATE messages s
   SET drid = r.id,
       dcount = coalesce(p.dcount, (SELECT count(*)::int FROM messages d WHERE d.room_id = r.id AND d.t IS NULL)),
       dlm = coalesce(p.dlm, r.lm)
  FROM rooms r
  LEFT JOIN messages p ON p.id = r.pmid
 WHERE s.t = 'discussion-created'
   AND s.drid IS NULL
   AND s.extra ? 'drid'
   AND r.id = s.extra->>'drid'
   AND r.prid = s.room_id;
