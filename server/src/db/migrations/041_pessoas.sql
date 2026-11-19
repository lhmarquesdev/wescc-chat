-- Administração de pessoas.

-- E-mail vazio passa a ser "sem e-mail" (NULL): o cadastro sem e-mail gravava '' e o segundo esbarrava no índice
-- único de lower(email) ("Erro interno do servidor").
UPDATE users SET email = NULL, email_verified = false WHERE email IS NOT NULL AND btrim(email) = '';

-- Cadastro pela tela de entrar com "Aprovar novos usuários manualmente": a conta nasce desativada e aguardando a
-- aprovação de um administrador (antes aparecia igual a uma conta desativada). Ativar a conta aprova.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false;
-- Quem já se cadastrou e ainda espera (nunca entrou e continua desativado), pelo registro da auditoria.
UPDATE users u SET pending_approval = true
 WHERE NOT u.active AND u.last_login IS NULL
   AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'user.registered' AND a.target->>'userId' = u.id);
