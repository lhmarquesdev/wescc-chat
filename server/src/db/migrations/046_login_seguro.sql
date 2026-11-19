-- 2FA: último passo de 30 s aceito do aplicativo autenticador. O mesmo código não vale duas vezes (RFC 6238 §5.2).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;

-- O cadastro público deixou de ser o padrão (instalações novas começam com o cadastro desativado). Instalações que já
-- existiam e nunca mudaram a opção continuam como estavam: o valor de antes fica gravado. Numa instalação nova a
-- tabela users ainda está vazia aqui (o administrador é criado depois das migrações).
INSERT INTO settings (id, value)
SELECT 'Accounts_RegistrationForm', '"Public"'::jsonb
WHERE EXISTS (SELECT 1 FROM users)
ON CONFLICT (id) DO NOTHING;
