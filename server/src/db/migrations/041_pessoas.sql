-- Administração de pessoas.

-- E-mail vazio passa a ser "sem e-mail" (NULL): o cadastro sem e-mail gravava '' e o segundo esbarrava no índice
-- único de lower(email) ("Erro interno do servidor").
UPDATE users SET email = NULL, email_verified = false WHERE email IS NOT NULL AND btrim(email) = '';
