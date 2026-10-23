-- Chamadas em grupo (canais, grupos privados, times, discussões e DMs com várias pessoas) por um servidor de chamadas
-- (SFU), e o histórico por pessoa, que passa a valer também para as chamadas a dois. Idempotente: os testes reaplicam.

ALTER TABLE calls ALTER COLUMN callee_id DROP NOT NULL;
ALTER TABLE calls ALTER COLUMN caller_conn DROP NOT NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'direct' CHECK (scope IN ('direct', 'group'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS media text NOT NULL DEFAULT 'p2p' CHECK (media IN ('p2p', 'sfu'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sfu_room text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS message_id text REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS listen_only boolean NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ring boolean NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS peak int NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_reason text
  CHECK (ended_reason IN ('hangup', 'empty', 'dropped', 'moderator', 'restricted', 'no-answer', 'alone', 'max-duration',
                          'room', 'readonly', 'no-speaker', 'sfu'));
-- Relógios da varredura: espera por supervisor, sala vazia, pessoa sozinha, transmissão sem ninguém com a palavra,
-- sala sumida do servidor de chamadas. invited_at limita o "Avisar a sala".
ALTER TABLE calls ADD COLUMN IF NOT EXISTS guard_until timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS empty_since timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS alone_since timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS speakerless_since timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sfu_missing_since timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS invited_at timestamptz;
-- Uma chamada em grupo viva por sala: a segunda tentativa de iniciar vira "entrar".
CREATE UNIQUE INDEX IF NOT EXISTS calls_room_live_idx ON calls (room_id) WHERE scope = 'group' AND status = 'ongoing';
CREATE INDEX IF NOT EXISTS calls_room_idx ON calls (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_ended_idx ON calls (ended_at) WHERE ended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_participants (
  call_id            text NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host               boolean NOT NULL DEFAULT false,
  state              text NOT NULL CHECK (state IN ('ringing', 'joining', 'joined', 'left', 'declined', 'missed')),
  created_at         timestamptz NOT NULL,              -- igual a calls.created_at: ordena o histórico pelo índice
  rung_at            timestamptz,
  rung_by            text,
  token_at           timestamptz,                       -- último token de entrada: abre a primeira conexão por 60 s
  session_id         text,                              -- sid do participante no LiveKit (ou a conexão, no P2P)
  joined_at          timestamptz,                       -- primeira entrada
  last_joined_at     timestamptz,                       -- entrada atual
  left_at            timestamptz,
  left_reason        text CHECK (left_reason IN ('hangup', 'disconnected', 'removed', 'ended', 'failed', 'busy', 'deactivated', 'room')),
  seconds            int NOT NULL DEFAULT 0,             -- tempo somado dentro da chamada
  speak_granted      boolean NOT NULL DEFAULT false,     -- transmissão: um moderador liberou a fala
  removed_by         text,
  hand_at            timestamptz,                       -- mão levantada; só o servidor muda
  -- O que o LiveKit aplica a esta pessoa agora (token ou último UpdateParticipant). Diferente de grantsFor: reaplicar.
  granted_publish    boolean NOT NULL DEFAULT false,
  granted_sources    text[] NOT NULL DEFAULT '{}',
  granted_hidden     boolean NOT NULL DEFAULT false,
  -- Fontes que o servidor acabou de tirar de quem estava dentro (silêncio na sala, fala ou papel revogados, pausa) e
  -- quando: uma faixa delas publicada antes de o LiveKit receber a permissão nova não é adulteração.
  revoked_sources    text[] NOT NULL DEFAULT '{}',
  revoked_at         timestamptz,
  screen_block_until timestamptz,                      -- um moderador parou a tela: sem compartilhar até lá
  sfu_event_at       timestamptz,                       -- createdAt do último webhook aplicado: descarta os atrasados
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX IF NOT EXISTS call_participants_user_idx ON call_participants (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_participants_live_idx ON call_participants (call_id) WHERE state IN ('ringing', 'joining', 'joined');
CREATE INDEX IF NOT EXISTS call_participants_in_call_idx ON call_participants (user_id) WHERE state IN ('joining', 'joined');

-- Histórico das chamadas a dois que já existiam: quem ligou e quem recebeu.
INSERT INTO call_participants (call_id, user_id, host, state, created_at, joined_at, last_joined_at, left_at, left_reason, seconds, session_id)
SELECT id, caller_id, true,
       CASE WHEN status IN ('ringing', 'ongoing') THEN 'joined' ELSE 'left' END,
       created_at, created_at, created_at, ended_at,
       CASE WHEN status IN ('ringing', 'ongoing') THEN NULL ELSE 'hangup' END,
       CASE WHEN answered_at IS NOT NULL AND ended_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM ended_at - answered_at))::int ELSE 0 END,
       caller_conn
FROM calls
ON CONFLICT DO NOTHING;

-- Para quem recebeu: cancelada (quem ligou desistiu antes do atendimento) e ocupada contam como perdidas,
-- que é o que as pessoas esperam ver no histórico.
INSERT INTO call_participants (call_id, user_id, host, state, created_at, rung_at, joined_at, last_joined_at, left_at, left_reason, seconds, session_id)
SELECT id, callee_id, false,
       CASE status WHEN 'ringing' THEN 'ringing' WHEN 'ongoing' THEN 'joined' WHEN 'ended' THEN 'left' WHEN 'declined' THEN 'declined' ELSE 'missed' END,
       created_at, created_at, answered_at, answered_at, ended_at,
       CASE status WHEN 'ended' THEN 'hangup' WHEN 'busy' THEN 'busy' ELSE NULL END,
       CASE WHEN answered_at IS NOT NULL AND ended_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM ended_at - answered_at))::int ELSE 0 END,
       callee_conn
FROM calls WHERE callee_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Chamadas perdidas vistas: o selo do menu Chamadas conta só as mais novas. As antigas já contam como vistas.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calls_seen_at timestamptz;
UPDATE users SET calls_seen_at = now() WHERE calls_seen_at IS NULL;

-- Padrão do Rocket.Chat: usuários comuns iniciam chamadas. Só muda instalações que mantêm o padrão antigo.
UPDATE permissions SET roles = array_append(roles, 'user')
 WHERE id = 'call-management'
   AND roles @> ARRAY['admin', 'owner', 'moderator'] AND roles <@ ARRAY['admin', 'owner', 'moderator'];
