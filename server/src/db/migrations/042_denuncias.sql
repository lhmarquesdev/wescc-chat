-- Denúncias da Moderação: uma denúncia aberta por pessoa e mensagem, e uma por pessoa e usuário denunciado, para que
-- repetir a denúncia (ou denunciar a si mesmo) não infle a contagem. Nas instalações com dados, as repetidas e as
-- denúncias contra a própria pessoa que estão abertas passam a resolvidas; a primeira de cada pessoa continua aberta.
UPDATE moderation_reports SET resolved = true WHERE NOT resolved AND reporter_id = reported_user_id;
UPDATE moderation_reports r SET resolved = true
 WHERE NOT r.resolved AND r.message_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM moderation_reports o
      WHERE NOT o.resolved AND o.message_id = r.message_id AND o.reporter_id = r.reporter_id AND (o.created_at, o.id) < (r.created_at, r.id)
   );
UPDATE moderation_reports r SET resolved = true
 WHERE NOT r.resolved AND r.message_id IS NULL AND r.reported_user_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM moderation_reports o
      WHERE NOT o.resolved AND o.message_id IS NULL AND o.reported_user_id = r.reported_user_id AND o.reporter_id = r.reporter_id
        AND (o.created_at, o.id) < (r.created_at, r.id)
   );
CREATE UNIQUE INDEX moderation_reports_open_message_idx ON moderation_reports (message_id, reporter_id) WHERE NOT resolved AND message_id IS NOT NULL;
CREATE UNIQUE INDEX moderation_reports_open_user_idx ON moderation_reports (reported_user_id, reporter_id) WHERE NOT resolved AND message_id IS NULL;
