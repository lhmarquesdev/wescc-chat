// Teste de conexão com o servidor de chamadas: servidor, mídia, caminho (UDP ou TCP), envio de áudio e de vídeo.
// Fica fora da chamada (U7): com uma chamada aberta, só explica que é preciso sair dela.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { isInCall } from '../../lib/call/store';
import type { SelfTestStep } from '../../lib/call/sfu';
import { Icon, type IconName } from '../Icon';
import { Modal } from '../ui';

const STEPS = ['Servidor de chamadas', 'Conexão de mídia', 'Caminho da mídia', 'Envio de áudio', 'Envio de vídeo'];
const STATUS_TEXT: Record<SelfTestStep['status'], string> = { idle: '', running: 'Testando…', success: 'OK', failed: 'Falhou', skipped: 'Pulado' };
const STATUS_ICON: Record<SelfTestStep['status'], IconName | null> = { idle: null, running: null, success: 'success', failed: 'error', skipped: 'info' };

const TEXT = {
  ok: 'Tudo certo para chamadas.',
  ws: 'O navegador não alcança o servidor de chamadas. Confira se o chat abre por HTTPS e se o proxy da rede deixa o endereço do chat passar direto (lista de exceções do proxy).',
  rtc: 'A mídia não passa. Peça à TI para liberar UDP 7882 a 7885 e TCP 7881 até o servidor do chat, no firewall e na VPN. Se o Chrome é gerenciado, confira a política WebRtcIPHandling.',
  tcp: 'A mídia passa só por TCP. Funciona, mas com mais atraso: peça à TI para liberar UDP 7882 a 7885 até o servidor do chat.',
  audio: 'Não foi possível enviar áudio. Confira o microfone e a permissão do navegador.',
  video: 'Não foi possível enviar vídeo. Confira a câmera e a permissão do navegador.',
  down: 'O servidor de chamadas não está configurado ou não responde.',
  inCall: 'Saia da chamada para testar a conexão.',
};

function verdict(steps: SelfTestStep[]): { text: string; kind: 'ok' | 'warn' | 'err' } {
  if (steps[0].status === 'failed') return { text: TEXT.ws, kind: 'err' };
  if (steps[1].status === 'failed') return { text: TEXT.rtc, kind: 'err' };
  if (steps[3].status === 'failed') return { text: TEXT.audio, kind: 'err' };
  if (steps[4].status === 'failed') return { text: TEXT.video, kind: 'err' };
  if (steps[2].protocol === 'tcp') return { text: TEXT.tcp, kind: 'warn' };
  return { text: TEXT.ok, kind: 'ok' };
}

const idle = (): SelfTestStep[] => STEPS.map(() => ({ status: 'idle' }));

export function SelfTest({ onClose }: { onClose: () => void }) {
  const [steps, setSteps] = useState<SelfTestStep[]>(idle);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setError(null);
    setDone(false);
    setSteps(idle());
    if (isInCall()) return setError(TEXT.inCall);
    setRunning(true);
    try {
      const { token } = (await api.post('calls.selfTest', {})) as { token: string };
      const { runSelfTest } = await import('../../lib/call/sfu');
      await runSelfTest(token, (s) => alive.current && setSteps(s));
      if (alive.current) setDone(true);
    } catch (e) {
      if (!alive.current) return;
      const status = e instanceof ApiError ? e.status : 0;
      setError(status === 503 ? TEXT.down : status === 409 ? TEXT.inCall : errorMessage(e));
    } finally {
      if (alive.current) setRunning(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const result = done ? verdict(steps) : null;
  return (
    <Modal
      title="Teste de conexão"
      onClose={onClose}
      className="call-selftest"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Fechar
          </button>
          <button type="button" className="btn primary" disabled={running} onClick={() => void run()}>
            Testar de novo
          </button>
        </>
      }
    >
      {error ? (
        <div className="callout warn" role="alert">
          <Icon name="warning" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <ol className="call-selftest-steps">
            {STEPS.map((label, i) => {
              const s = steps[i];
              const icon = STATUS_ICON[s.status];
              const path = i === 2 && s.status === 'success' && s.protocol ? (s.protocol === 'udp' ? 'UDP (ideal)' : 'TCP (funciona, com mais atraso)') : null;
              return (
                <li key={label} className={`call-selftest-step ${s.status}`}>
                  <span className="call-selftest-icon">{icon ? <Icon name={icon} size={18} /> : <span className="call-selftest-dot" />}</span>
                  <span className="call-selftest-label">{label}</span>
                  <span className="call-selftest-status">{path ?? STATUS_TEXT[s.status]}</span>
                </li>
              );
            })}
          </ol>
          {/* Lugar reservado para o veredito: o diálogo não muda de altura quando o teste acaba. */}
          <div className="call-selftest-verdict" aria-live="polite">
            {result && (
              <div className={`callout ${result.kind}`} role="status">
                <Icon name={result.kind === 'ok' ? 'success' : 'warning'} />
                <span>{result.text}</span>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
