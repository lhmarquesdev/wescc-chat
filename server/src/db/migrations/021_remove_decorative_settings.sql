-- Duas opções da Administração que não faziam nada: "Criptografia ponta a ponta" (o chat não cifra mensagens de ponta a
-- ponta) e "Enviar e-mail em login de novo dispositivo" (nenhum e-mail era enviado). Saem da tela para não enganar.
DELETE FROM settings WHERE id IN ('E2E_Enable', 'Device_Management_Enable_Login_Emails');
