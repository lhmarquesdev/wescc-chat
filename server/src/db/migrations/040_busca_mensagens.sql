-- Busca de mensagens sem acento ("reuniao" acha "reunião") e pelo nome e pela legenda dos arquivos; ausência
-- automática por conexão.

-- (a) Texto pesquisável de uma mensagem, já dobrado como na busca da barra lateral (wescc_fold, migração 030): o texto,
--     os nomes dos arquivos e as legendas (attachments[].description). Mensagem cifrada fica de fora: o servidor só tem
--     o nome genérico do arquivo. O search_path vai junto da função: as colunas geradas abaixo a chamam até numa
--     restauração do pg_dump, que roda com search_path vazio.
CREATE OR REPLACE FUNCTION wescc_message_search_text(msg text, files jsonb, attachments jsonb, e2e jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
  SELECT CASE WHEN e2e IS NOT NULL THEN '' ELSE wescc_fold(concat_ws(' ',
    msg,
    (SELECT string_agg(f->>'name', ' ') FROM jsonb_array_elements(CASE jsonb_typeof(files) WHEN 'array' THEN files ELSE '[]' END) f),
    (SELECT string_agg(a->>'description', ' ') FROM jsonb_array_elements(CASE jsonb_typeof(attachments) WHEN 'array' THEN attachments ELSE '[]' END) a)
  )) END
$$;

-- (b) search_text guarda esse texto (a busca por pedaço de palavra compara com ele sem dobrar cada linha de novo) e o
--     índice de texto (search) passa a usá-lo. Uma coluna gerada não muda de expressão no PostgreSQL 16: sai e volta,
--     num ALTER só (o banco recalcula todas as mensagens uma vez, durante a migração).
DROP INDEX IF EXISTS messages_search_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS search;
ALTER TABLE messages
  ADD COLUMN search_text text GENERATED ALWAYS AS (wescc_message_search_text(msg, files, attachments, e2e)) STORED,
  ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', wescc_message_search_text(msg, files, attachments, e2e))) STORED;
CREATE INDEX messages_search_idx ON messages USING gin (search);

-- (c) Ausência automática: cada conexão (aba, aplicativo, celular) diz se está parada. A pessoa fica Ausente só quando
--     todas estão; uma ativa a deixa Disponível.
ALTER TABLE presence_connections ADD COLUMN IF NOT EXISTS idle boolean NOT NULL DEFAULT false;
