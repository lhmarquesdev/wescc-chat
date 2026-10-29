-- O chat é só para comunicação interna: sai o atendimento a clientes externos (omnichannel/livechat), com widget,
-- visitantes, departamentos, agentes, fila, respostas prontas e o importador de contatos. Nada interno usa estas
-- tabelas. Salas de atendimento (t = 'l') saem com as mensagens, inscrições e registros de arquivos (ON DELETE CASCADE).

DELETE FROM rooms WHERE t = 'l';

DROP INDEX IF EXISTS files_visitor_idx;
ALTER TABLE files DROP COLUMN IF EXISTS visitor_id;

DROP TABLE IF EXISTS
  livechat_rooms,
  livechat_canned_responses,
  livechat_offline_messages,
  livechat_department_agents,
  livechat_unit_monitors,
  livechat_agents,
  livechat_visitors,
  livechat_tags,
  livechat_custom_fields,
  livechat_triggers,
  livechat_sla,
  livechat_priorities,
  livechat_departments,
  livechat_units,
  livechat_business_hours;

-- Configurações do grupo Omnichannel.
DELETE FROM settings WHERE id LIKE 'Livechat\_%' OR id LIKE 'Omnichannel\_%';

-- Permissões do atendimento e os papéis de agente, gestor e monitor (inclusive nas pessoas e nas delegações).
DELETE FROM permissions WHERE id = 'view-l-room' OR id = 'view-canned-responses' OR id LIKE '%livechat%';
UPDATE users SET roles = array_remove(array_remove(array_remove(roles, 'livechat-agent'), 'livechat-manager'), 'livechat-monitor')
 WHERE roles && ARRAY['livechat-agent', 'livechat-manager', 'livechat-monitor'];
UPDATE roles SET delegable_roles = array_remove(array_remove(array_remove(delegable_roles, 'livechat-agent'), 'livechat-manager'), 'livechat-monitor')
 WHERE delegable_roles && ARRAY['livechat-agent', 'livechat-manager', 'livechat-monitor'];
UPDATE sticker_packs SET visible_roles = array_remove(array_remove(array_remove(visible_roles, 'livechat-agent'), 'livechat-manager'), 'livechat-monitor')
 WHERE visible_roles && ARRAY['livechat-agent', 'livechat-manager', 'livechat-monitor'];
DELETE FROM roles WHERE id IN ('livechat-agent', 'livechat-manager', 'livechat-monitor');

-- Importador de contatos: os registros lidos e os vínculos dos contatos importados.
DELETE FROM import_records WHERE data_type = 'contact';
DELETE FROM import_map WHERE kind = 'contact';
ALTER TABLE import_operations DROP COLUMN IF EXISTS count_contacts;
