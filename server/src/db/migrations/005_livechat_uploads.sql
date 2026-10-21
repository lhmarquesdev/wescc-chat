-- Arquivos enviados por visitantes do livechat: user_id fica nulo e o autor é o visitante.
ALTER TABLE files ADD COLUMN visitor_id text REFERENCES livechat_visitors(id) ON DELETE SET NULL;
