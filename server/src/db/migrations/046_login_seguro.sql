-- 2FA: último passo de 30 s aceito do aplicativo autenticador. O mesmo código não vale duas vezes (RFC 6238 §5.2).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
