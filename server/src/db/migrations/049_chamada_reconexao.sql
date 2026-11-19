-- Chamada a dois (P2P): quando a conexão em tempo real de um dos lados cai (rede instável, notebook que dormiu,
-- servidor reiniciado), o áudio e o vídeo seguem direto entre os navegadores. A chamada não termina na hora: guarda
-- quando cada lado caiu e espera ele voltar (calls.reattach). Quem não volta a tempo encerra a chamada como queda, com
-- a duração até a queda. Colunas novas e vazias: as chamadas que já existem não mudam.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_lost_at timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS callee_lost_at timestamptz;
