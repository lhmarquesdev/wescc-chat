-- Quem volta para uma conversa criptografada só lê dali para frente: nenhuma geração da chave que existia enquanto a
-- pessoa estava fora vai para ela. Ao voltar, a conversa troca de chave, e a pessoa recebe a geração que nasce depois
-- da volta. Quem é novo na conversa continua recebendo a geração atual (e lê o histórico cifrado com ela).

-- Gerações da chave de cada sala e quando cada uma passou a valer. Quem voltou só recebe as que nasceram depois da
-- volta, e uma geração não volta a ser usada na mesma sala.
CREATE TABLE e2e_room_generations (
  room_id    text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  key_id     text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{16}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_id, key_id)
);

-- Quem saiu (ou foi removido) de uma conversa criptografada, ou que já foi: quando saiu, a geração da chave naquele
-- momento (nula sem chave ou no registro tirado do histórico) e quando voltou. Enquanto está fora (returned_at nulo),
-- nenhuma geração vai para a pessoa; depois da volta, só as que nasceram depois dela. A linha some com a sala ou com a
-- conta; uma saída nova da mesma pessoa reescreve a linha.
CREATE TABLE e2e_room_departures (
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  left_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_key_id text,
  returned_at timestamptz,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX e2e_room_departures_user_idx ON e2e_room_departures (user_id);

-- Gerações que já existem: a primeira vez em que aparecem (chave entregue ou mensagem cifrada com ela) ou, para a
-- atual sem nenhum rastro, agora. Para quem voltar depois desta atualização, todas são de antes da volta.
INSERT INTO e2e_room_generations (room_id, key_id, created_at)
SELECT room_id, key_id, min(at)
  FROM (
    SELECT room_id, key_id, created_at AS at FROM e2e_room_keys
    UNION ALL
    SELECT room_id, e2e->>'kid', created_at FROM messages WHERE e2e IS NOT NULL
    UNION ALL
    SELECT id, e2e_key_id, now() FROM rooms WHERE e2e_key_id IS NOT NULL
  ) g
 WHERE key_id ~ '^[A-Za-z0-9_-]{16}$'
 GROUP BY room_id, key_id;

-- Quem saiu antes desta atualização não tem registro: ele vem do que ficou na sala desde que a criptografia foi ligada
-- pela primeira vez (ou desde a criação, no grupo que nasceu criptografado). Conta quem saiu ou foi removido ("saiu",
-- "removeu"), quem entrou depois disso e não está mais, quem escreveu cifrado, entregou chave ou leu mensagem cifrada
-- ali. Quem já voltou antes desta atualização (está na sala de novo) fica como está. Sem rastro nenhum (remoção sem
-- mensagem de alguém que nunca escreveu nem leu ali), a pessoa volta como alguém novo.
WITH enc AS (
  SELECT r.id, COALESCE((SELECT min(m.created_at) FROM messages m WHERE m.room_id = r.id AND m.t = 'room_e2e_enabled'), r.created_at) AS since
    FROM rooms r
   WHERE r.encrypted OR r.e2e_key_id IS NOT NULL
), seen AS (
  -- Saiu (a mensagem é da própria pessoa) ou foi removida (a mensagem traz o nome dela): a hora vira a da saída.
  SELECT m.room_id, m.user_id, m.created_at AS at
    FROM messages m JOIN enc ON enc.id = m.room_id
   WHERE m.t = 'ul' AND m.created_at >= enc.since AND m.user_id IS NOT NULL
  UNION ALL
  SELECT m.room_id, u.id, m.created_at
    FROM messages m JOIN enc ON enc.id = m.room_id JOIN users u ON u.username = m.msg
   WHERE m.t = 'ru' AND m.created_at >= enc.since
  -- Entrou (ou foi adicionada) com a criptografia ligada e não está mais: saiu sem mensagem.
  UNION ALL
  SELECT m.room_id, m.user_id, NULL::timestamptz
    FROM messages m JOIN enc ON enc.id = m.room_id
   WHERE m.t = 'uj' AND m.created_at >= enc.since AND m.user_id IS NOT NULL
  UNION ALL
  SELECT m.room_id, u.id, NULL
    FROM messages m JOIN enc ON enc.id = m.room_id JOIN users u ON u.username = m.msg
   WHERE m.t = 'au' AND m.created_at >= enc.since
  -- Escreveu cifrado, entregou chave ou leu mensagem cifrada: teve a chave.
  UNION ALL
  SELECT m.room_id, m.user_id, NULL FROM messages m WHERE m.e2e IS NOT NULL AND m.user_id IS NOT NULL
  UNION ALL
  SELECT k.room_id, k.provided_by, NULL FROM e2e_room_keys k WHERE k.provided_by IS NOT NULL
  UNION ALL
  SELECT m.room_id, rd.user_id, NULL FROM messages m JOIN message_reads rd ON rd.message_id = m.id WHERE m.e2e IS NOT NULL
)
INSERT INTO e2e_room_departures (room_id, user_id, left_at)
SELECT s.room_id, s.user_id, COALESCE(max(s.at), now())
  FROM seen s
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
   AND NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.room_id = s.room_id AND x.user_id = s.user_id)
 GROUP BY s.room_id, s.user_id;
