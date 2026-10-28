// Raiz da chamada: chamada recebida, tela de entrada, janela, as pílulas de "Voltar" e "outra aba", e a camada da
// chamada. A raiz passa a camada como destino dos portais (menus, diálogos e folhas abertos de dentro da chamada) e
// é ela que entra em tela cheia, para a camada continuar visível.
import { useEffect, useState } from 'react';
import { callRoomName, dismissOtherDevice, dismissRejoin, isInCall, openJoin, startCallStore, useCallStore } from '../../lib/call/store';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { OverlayRootContext } from '../ui';
import { CallLayer } from './CallLayer';
import { CallWindow } from './CallWindow';
import { cornerStyle, loadCorner, useDock } from './dock';
import { IncomingCall } from './IncomingCall';
import { Preflight } from './Preflight';

// Pílula fora da chamada: a chamada aberta em outra aba, a chamada em que estou em outro aparelho (Trazer para cá) ou
// "Você saiu da chamada em …" (Voltar).
// No celular a tela desce pela altura real do aviso: um texto longo quebra em três linhas e passaria dos 56 px.
function reserveSpace(el: HTMLDivElement | null) {
  const layout = el?.closest<HTMLElement>('.layout');
  if (!el || !layout) return;
  const ro = new ResizeObserver(() => layout.style.setProperty('--call-note-h', `${el.offsetHeight}px`));
  ro.observe(el);
  return () => {
    ro.disconnect();
    layout.style.removeProperty('--call-note-h');
  };
}

function CallNote() {
  const rejoin = useCallStore((s) => s.rejoin);
  const tabCall = useCallStore((s) => s.tabCall);
  const other = useCallStore((s) => s.otherDevice);
  const busy = useCallStore((s) => s.phase !== 'idle' || !!s.preflight);
  const phone = useIsPhone();
  const dock = useDock(!phone && !busy && !!(rejoin || tabCall || other));
  const roomName = useStore(() => (rejoin ? callRoomName(rejoin.room ?? null) : ''));
  if (busy || isInCall()) return null;
  const style = phone ? undefined : cornerStyle(dock, loadCorner());
  if (tabCall)
    return (
      <div ref={reserveSpace} className={phone ? 'call-note phone' : 'call-note'} style={style} role="status">
        <span className="call-note-icon">
          <Icon name="call-live" size={18} />
        </span>
        <span className="call-note-text">Chamada em andamento em outra aba.</span>
      </div>
    );
  if (other)
    return (
      <div ref={reserveSpace} className={phone ? 'call-note phone' : 'call-note'} style={style} role="status">
        <span className="call-note-icon">
          <Icon name="call-switch-camera" size={18} />
        </span>
        <span className="call-note-text">Você está nesta chamada em outro dispositivo.</span>
        <button type="button" className="btn small primary" onClick={() => void openJoin(other._id, other.rid)}>
          Trazer para cá
        </button>
        <button type="button" className="call-tool" title="Fechar" aria-label="Fechar" onClick={dismissOtherDevice}>
          <Icon name="close" size={16} />
        </button>
      </div>
    );
  if (!rejoin) return null;
  return (
    <div ref={reserveSpace} className={phone ? 'call-note phone' : 'call-note'} style={style} role="status">
      <span className="call-note-icon">
        <Icon name="call-outgoing" size={18} />
      </span>
      <span className="call-note-text">Você saiu da chamada em {roomName || 'outra sala'}.</span>
      <button type="button" className="btn small primary" onClick={() => void openJoin(rejoin._id, rejoin.rid)}>
        Voltar
      </button>
      <button type="button" className="call-tool" title="Fechar" aria-label="Fechar" onClick={dismissRejoin}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function CallRoot() {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const incoming = useCallStore((s) => s.incoming);
  const preflight = useCallStore((s) => s.preflight);
  const me = useStore((s) => !!s.me);
  useEffect(() => {
    if (me) startCallStore();
  }, [me]);
  useEffect(() => {
    useCallStore.setState({ layer });
  }, [layer]);
  return (
    <OverlayRootContext.Provider value={layer}>
      <div className="call-root">
        <CallWindow />
        {preflight && <Preflight key={`${preflight.mode}-${preflight.rid}-${preflight.callId ?? ''}`} />}
        <CallNote />
        {incoming[0] && <IncomingCall key={incoming[0]._id} call={incoming[0]} queued={incoming.length - 1} />}
        <CallLayer setLayer={setLayer} />
      </div>
    </OverlayRootContext.Provider>
  );
}
