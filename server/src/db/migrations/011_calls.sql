-- Chamadas de voz e vídeo em mensagens diretas (WebRTC ponto a ponto) e o histórico delas.
CREATE TABLE calls (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  caller_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('audio', 'video')),
  status        text NOT NULL CHECK (status IN ('ringing', 'ongoing', 'ended', 'missed', 'declined', 'canceled', 'busy')),
  -- Conexões (WebSocket) de cada lado: a sinalização WebRTC só circula entre elas.
  caller_conn   text NOT NULL,
  callee_conn   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz,
  ended_at      timestamptz,
  ended_by      text
);
CREATE INDEX calls_caller_idx ON calls (caller_id, created_at DESC);
CREATE INDEX calls_callee_idx ON calls (callee_id, created_at DESC);
CREATE INDEX calls_active_idx ON calls (status) WHERE status IN ('ringing', 'ongoing');
