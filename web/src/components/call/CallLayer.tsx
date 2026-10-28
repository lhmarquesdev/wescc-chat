// Camada da chamada: ilha escura acima da janela (e dentro da tela cheia) onde vão os menus, diálogos, folhas e
// avisos abertos de dentro da chamada. As perguntas da chamada (confirmInCall) aparecem aqui.
import { useEffect, useRef } from 'react';
import { answerConfirm, useCallStore } from '../../lib/call/store';
import { Modal } from '../ui';
import { CallLiveRegion, CallToasts } from './CallToasts';

export { confirmInCall } from '../../lib/call/store';

function ConfirmHost() {
  const req = useCallStore((s) => s.confirm);
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Ação destrutiva começa no Cancelar: Enter sem pensar não remove nem encerra nada. O menu que abriu a pergunta
  // devolve o foco ao gatilho quando termina de fechar e o diálogo o puxa para si: nesse caso volta para o botão.
  useEffect(() => {
    if (!req) return;
    const target = () => (req.danger ? cancelRef : okRef).current;
    target()?.focus({ preventScroll: true });
    const onFocus = (e: FocusEvent) => {
      const el = target();
      if (el && e.target === el.closest('.modal')) el.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocus);
    const t = window.setTimeout(() => document.removeEventListener('focusin', onFocus), 600);
    return () => {
      clearTimeout(t);
      document.removeEventListener('focusin', onFocus);
    };
  }, [req]);
  if (!req) return null;
  return (
    <Modal
      size="sm"
      title={req.title}
      onClose={() => answerConfirm(false)}
      className="confirm"
      footer={
        <>
          <button type="button" ref={cancelRef} className="btn" onClick={() => answerConfirm(false)}>
            {req.cancelLabel ?? 'Cancelar'}
          </button>
          <button type="button" ref={okRef} className={req.danger ? 'btn danger solid' : 'btn primary'} onClick={() => answerConfirm(true)}>
            {req.confirmLabel ?? 'Confirmar'}
          </button>
        </>
      }
    >
      {req.body && <p className="confirm-body">{req.body}</p>}
    </Modal>
  );
}

export function CallLayer({ setLayer }: { setLayer: (el: HTMLDivElement | null) => void }) {
  return (
    <div className="call-layer" ref={setLayer}>
      <CallToasts />
      <ConfirmHost />
      <CallLiveRegion />
    </div>
  );
}
