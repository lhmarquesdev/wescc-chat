-- Figurinhas: arquivos (endereçados pelo conteúdo canônico), pacotes, figurinhas, itens por pessoa e lixeira de arquivos.

-- Um arquivo por conteúdo (sha256 do arquivo canônico). A linha de um arquivo removido fica como bloqueio.
CREATE TABLE sticker_files (
  id                     text PRIMARY KEY,
  sha256                 text NOT NULL UNIQUE,  -- hex
  phash                  bigint,                -- dHash de 64 bits calculado no navegador; NULL = desconhecido
  mime                   text NOT NULL CHECK (mime IN ('image/webp', 'image/png', 'image/gif')),
  width                  int  NOT NULL CHECK (width BETWEEN 1 AND 512),
  height                 int  NOT NULL CHECK (height BETWEEN 1 AND 512),
  size                   int  NOT NULL CHECK (size > 0),
  animated               boolean NOT NULL DEFAULT false,
  frames                 int  NOT NULL DEFAULT 1,
  duration_ms            int,
  alpha                  boolean NOT NULL DEFAULT true,
  path                   text,                  -- relativo ao diretório de uploads (AAAA/MM/id, sempre com "/"); NULL depois de removida
  poster_path            text,                  -- só animadas
  poster_mime            text,
  poster_size            int,
  created_by             text REFERENCES users(id) ON DELETE SET NULL, -- quem enviou este conteúdo primeiro
  created_at             timestamptz NOT NULL DEFAULT now(),
  orphan_since           timestamptz,           -- marcado pela limpeza diária; apagado 7 dias depois
  blocked_at             timestamptz,
  blocked_by             jsonb,                 -- { _id, username }
  blocked_reason         text,
  blocked_name           text,
  quarantine_path        text,                  -- quarantine/<id>: cópia só para a moderação, depois da remoção
  quarantine_poster_path text,
  quarantine_until       timestamptz,
  CHECK (blocked_at IS NOT NULL OR path IS NOT NULL),
  CHECK (NOT animated OR blocked_at IS NOT NULL OR poster_path IS NOT NULL),
  CHECK (quarantine_path IS NULL OR blocked_at IS NOT NULL)
);
CREATE INDEX sticker_files_orphan ON sticker_files (orphan_since) WHERE orphan_since IS NOT NULL;
CREATE INDEX sticker_files_blocked ON sticker_files (blocked_at DESC) WHERE blocked_at IS NOT NULL;
CREATE INDEX sticker_files_quarantine ON sticker_files (quarantine_until) WHERE quarantine_path IS NOT NULL;

CREATE TABLE sticker_packs (
  id               text PRIMARY KEY,
  scope            text NOT NULL CHECK (scope IN ('org', 'personal')),
  owner_id         text REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  cover_sticker_id text,              -- FK abaixo; o serviço confere que a figurinha é deste pacote
  status           text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  visible_roles    text[] NOT NULL DEFAULT '{}',
  sort             int  NOT NULL DEFAULT 0,
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'org') = (owner_id IS NULL)),
  CHECK (scope = 'org' OR (status = 'published' AND visible_roles = '{}'))
);
CREATE INDEX sticker_packs_org ON sticker_packs (sort, created_at) WHERE scope = 'org';
CREATE INDEX sticker_packs_owner ON sticker_packs (owner_id, sort, created_at) WHERE owner_id IS NOT NULL;

CREATE TABLE stickers (
  id                text PRIMARY KEY,
  pack_id           text NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  file_id           text NOT NULL REFERENCES sticker_files(id) ON DELETE CASCADE,
  name              text NOT NULL,
  emojis            text[] NOT NULL DEFAULT '{}',
  keywords          text[] NOT NULL DEFAULT '{}',
  sort              int  NOT NULL DEFAULT 0,
  created_by        text REFERENCES users(id) ON DELETE SET NULL,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL, -- "Criar figurinha" a partir desta mensagem
  source_user_id    text REFERENCES users(id) ON DELETE SET NULL,    -- autor da imagem de origem
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, file_id)
);
CREATE INDEX stickers_pack ON stickers (pack_id, sort, created_at);
CREATE INDEX stickers_file ON stickers (file_id);
-- Apagar uma mensagem (de qualquer sala) confere esta chave estrangeira: sem índice, cada exclusão varre as figurinhas.
CREATE INDEX stickers_source_message ON stickers (source_message_id) WHERE source_message_id IS NOT NULL;

ALTER TABLE sticker_packs ADD CONSTRAINT sticker_packs_cover_fk
  FOREIGN KEY (cover_sticker_id) REFERENCES stickers(id) ON DELETE SET NULL;
CREATE INDEX sticker_packs_cover ON sticker_packs (cover_sticker_id) WHERE cover_sticker_id IS NOT NULL;

-- Favoritas e recentes guardam nome e emojis porque a figurinha pode vir de um pacote de outra pessoa.
CREATE TABLE sticker_user_items (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('favorite', 'recent')),
  file_id    text NOT NULL REFERENCES sticker_files(id) ON DELETE CASCADE,
  sticker_id text REFERENCES stickers(id) ON DELETE SET NULL,
  name       text NOT NULL,
  emojis     text[] NOT NULL DEFAULT '{}',
  used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, file_id)
);
CREATE INDEX sticker_user_items_file ON sticker_user_items (file_id);
CREATE INDEX sticker_user_items_list ON sticker_user_items (user_id, kind, used_at DESC);
CREATE INDEX sticker_user_items_sticker ON sticker_user_items (sticker_id) WHERE sticker_id IS NOT NULL;

-- Versão dos catálogos ('org' e 'user:<id>'), para o cliente revalidar sem baixar tudo.
CREATE TABLE sticker_versions (
  key     text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0
);

-- Arquivos a apagar ou mover. Entram na mesma transação que tira o arquivo de uso; saem quando o disco obedece.
CREATE TABLE sticker_trash (
  path       text PRIMARY KEY,        -- relativo ao diretório de uploads, sempre com "/"
  move_to    text,                    -- NULL = apagar; senão, mover para este caminho (quarentena)
  since      timestamptz NOT NULL DEFAULT now(),
  attempts   int NOT NULL DEFAULT 0,
  last_error text
);

ALTER TABLE messages ADD COLUMN sticker_file_id text REFERENCES sticker_files(id) ON DELETE SET NULL;
CREATE INDEX messages_sticker_file ON messages (sticker_file_id, room_id) WHERE sticker_file_id IS NOT NULL;
