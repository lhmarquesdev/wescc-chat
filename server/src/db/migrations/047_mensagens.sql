-- Mensagens: o texto de uma mensagem apagada não fica guardado em outro lugar.

-- Versões antigas (edições) de mensagens que já saíram, ou que ficaram só como "mensagem removida" (raiz de tópico),
-- saem; daqui para frente elas vão junto com a mensagem (apagar uma sala ou rodar a retenção também as leva).
DELETE FROM message_history h
 WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = h.message_id AND m.t IS DISTINCT FROM 'rm');
ALTER TABLE message_history
  ADD CONSTRAINT message_history_message_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

-- Citações de uma mensagem (anexo com message_link ?msg=<id>): ao apagar ou editar a original, as cópias do texto são
-- atualizadas (refreshMessageCopies) sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS messages_quote_links_idx ON messages USING gin (jsonb_path_query_array(attachments, '$[*].message_link'));
