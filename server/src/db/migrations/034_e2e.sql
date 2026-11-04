-- Criptografia de ponta a ponta em conversas diretas e grupos privados (opcional: E2E_Enable). O servidor guarda só
-- material cifrado: a chave pública de cada pessoa, a chave privada cifrada com a senha da criptografia (que o servidor
-- nunca vê) e a chave de cada conversa cifrada para cada participante.

-- Chaves de cada pessoa. public_key: JWK RSA-OAEP-256 (JSON canônico). private_key: PKCS#8 cifrado no navegador
-- (JSON com kdf, iter, salt, iv e ct).
CREATE TABLE e2e_user_keys (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key  text NOT NULL CHECK (length(public_key) BETWEEN 300 AND 1000),
  private_key text NOT NULL CHECK (length(private_key) BETWEEN 100 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Chave da conversa (AES-256) cifrada com a chave pública de cada participante, uma linha por geração (key_id).
-- provided_by: quem entregou (nulo depois que a conta some). wrapped_key: 342 caracteres base64url (RSA-2048); o
-- tamanho vai em length() porque as expressões regulares do PostgreSQL só repetem até 255 vezes.
CREATE TABLE e2e_room_keys (
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id      text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{16}$'),
  wrapped_key text NOT NULL CHECK (length(wrapped_key) = 342 AND wrapped_key ~ '^[A-Za-z0-9_-]+$'),
  provided_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id, key_id)
);
CREATE INDEX e2e_room_keys_user_idx ON e2e_room_keys (user_id);
CREATE INDEX e2e_room_keys_current_idx ON e2e_room_keys (room_id, key_id);

-- Geração atual da chave da sala (nula até alguém criar) e o pedido de chave nova (alguém saiu ou redefiniu).
ALTER TABLE rooms ADD COLUMN e2e_key_id text, ADD COLUMN e2e_rotate boolean NOT NULL DEFAULT false;

-- "Criptografada" era só um rótulo (nada era cifrado): nenhuma sala começa criptografada. O UPDATE vem antes da
-- restrição, para um canal marcado no tempo do rótulo não travar a migração.
UPDATE rooms SET encrypted = false WHERE encrypted;
-- Só conversas diretas e grupos privados podem ser criptografados.
ALTER TABLE rooms ADD CONSTRAINT rooms_e2e_type CHECK (NOT encrypted OR t IN ('d', 'p'));

-- Conteúdo cifrado da mensagem ({v, kid, iv, ct, by}); o texto aberto fica vazio. NOT VALID: as linhas antigas têm
-- e2e nulo, e as novas são conferidas.
ALTER TABLE messages ADD COLUMN e2e jsonb;
ALTER TABLE messages ADD CONSTRAINT messages_e2e_no_text CHECK (e2e IS NULL OR msg = '') NOT VALID;
-- Histórico de edição de mensagem cifrada guarda o conteúdo cifrado anterior.
ALTER TABLE message_history ADD COLUMN e2e jsonb;

-- Arquivo enviado cifrado: o servidor não sabe o nome nem o tipo.
ALTER TABLE files ADD COLUMN e2e boolean NOT NULL DEFAULT false;

-- Quando um administrador redefiniu a criptografia da pessoa: a tela de entrar e a de configurar avisam o motivo até
-- ela criar as chaves novas.
ALTER TABLE users ADD COLUMN e2e_reset_at timestamptz;

-- A opção "Criptografia ponta a ponta" de antes não cifrava nada (021 a tirou da tela). Ela volta só com esta
-- implementação, e começa desligada em toda instalação: nenhum valor antigo vale.
DELETE FROM settings WHERE id = 'E2E_Enable';
