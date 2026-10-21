-- A credencial de uso único do SSO só vale no navegador que concluiu o login (hash do cookie wescc_sso).
ALTER TABLE sso_credentials ADD COLUMN browser_hash text;

-- Cota e limite de envios de arquivos por visitante do livechat.
CREATE INDEX files_visitor_idx ON files (visitor_id, created_at) WHERE visitor_id IS NOT NULL;
