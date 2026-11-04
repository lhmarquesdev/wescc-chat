-- Tradução automática de mensagens pelo LibreTranslate da empresa. A preferência é de cada pessoa em cada sala; o
-- idioma detectado e as traduções valem para o texto atual da mensagem (source_hash) e somem com ela.

-- Como no Rocket.Chat (subscription.autoTranslate / autoTranslateLanguage). Idioma vazio = o idioma da pessoa
-- (Minha conta › Preferências, preferences.language) e, sem ele, o idioma padrão da empresa (configuração Language).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_translate boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_translate_language text;

-- Idioma detectado do texto atual. source_hash = encode(sha256(convert_to(msg, 'UTF8')), 'base64').
CREATE TABLE IF NOT EXISTS message_languages (
  message_id  text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  source_hash text NOT NULL,
  language    text NOT NULL,            -- código do LibreTranslate ('en', 'pt-BR', 'zh-Hans'); 'und' = não identificado
  confidence  real NOT NULL DEFAULT 0,  -- 0 a 100, como o /detect devolve
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Tradução do texto atual para um idioma. Só vale enquanto source_hash for o do msg de agora.
CREATE TABLE IF NOT EXISTS message_translations (
  message_id      text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  language        text NOT NULL,        -- idioma de destino
  source_hash     text NOT NULL,
  source_language text NOT NULL,        -- de onde veio ("Traduzida do inglês")
  text            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, language)
);
