// Faixa de uma linha abaixo do topo da conversa criptografada: o estado da criptografia neste navegador e o que fazer.
import { useEffect, useState } from 'react';
import type { Room } from '@shared/index';
import { askAgain, E2E_UI, ensureRoom, useE2e, type E2eRoomState, type E2eStatus } from '../../lib/e2e/client';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { openE2eDialog } from './E2eDialogs';
import './e2e.css';

type Block = { key: 'none' | 'locked' | 'waiting' | 'preparing' | 'unsupported' | 'error'; text: string; icon: IconName };

function blockOf(status: E2eStatus, roomState: E2eRoomState | undefined, resetByAdmin = false, returned = false): Block | null {
  if (status === 'unsupported') return { key: 'unsupported', text: E2E_UI.unsupported, icon: 'e2e-warning' };
  if (status === 'none') return { key: 'none', text: resetByAdmin ? E2E_UI.resetByAdmin : E2E_UI.none, icon: 'e2e-key' };
  if (status === 'locked') return { key: 'locked', text: E2E_UI.locked, icon: 'e2e-key' };
  if (status === 'loading' || !roomState || roomState === 'creating' || roomState === 'rotating') return { key: 'preparing', text: E2E_UI.preparing, icon: 'e2e-waiting' };
  if (roomState === 'waiting') return { key: 'waiting', text: returned ? E2E_UI.waitingNew : E2E_UI.waiting, icon: 'e2e-waiting' };
  if (roomState === 'error') return { key: 'error', text: E2E_UI.error, icon: 'e2e-warning' };
  return null;
}

// O que impede escrever na conversa criptografada (o texto do compositor desativado); null quando dá.
export function useE2eBlock(room: Room | null | undefined): Block | null {
  const status = useE2e((s) => s.status);
  const roomState = useE2e((s) => (room ? s.rooms[room._id] : undefined));
  const resetByAdmin = useStore((s) => !!s.me?.e2eResetByAdmin);
  const returned = useE2e((s) => !!(room && s.returned[room._id]));
  if (!room?.encrypted) return null;
  return blockOf(status, roomState, resetByAdmin, returned);
}

// Esperando a chave com a conversa aberta: pede de novo a cada 2 minutos (com a aba à vista). Quem tem a chave entrega
// sozinho ao desbloquear; isto cobre o pedido que se perdeu.
const ASK_EVERY_MS = 120_000;

const dismissKey = (rid: string) => `wescc.e2e.banner.${rid}`;
const readDismissed = (rid: string) => {
  try {
    return localStorage.getItem(dismissKey(rid)) === '1';
  } catch {
    return false;
  }
};
// O aviso de quem voltou fecha por volta: voltar de novo mostra outra vez.
const returnKey = (rid: string) => `wescc.e2e.volta.${rid}`;
const readReturnDismissed = (rid: string) => {
  try {
    return localStorage.getItem(returnKey(rid));
  } catch {
    return null;
  }
};

// Quem saiu e voltou: uma linha explica por que as mensagens de antes da volta não abrem (o aviso de cada uma é o da
// chave que a pessoa não tem). Também na conversa que deixou de ser criptografada.
function ReturnNote({ rid, at }: { rid: string; at: string }) {
  const [closed, setClosed] = useState(() => readReturnDismissed(rid));
  useEffect(() => setClosed(readReturnDismissed(rid)), [rid]);
  if (closed === at) return null;
  const dismiss = () => {
    setClosed(at);
    try {
      localStorage.setItem(returnKey(rid), at);
    } catch {
      // armazenamento indisponível: some só até recarregar
    }
  };
  return (
    <div className="e2e-banner returned" role="note">
      <Icon name="encrypted" size={16} />
      <span className="e2e-banner-text" title={E2E_UI.returned}>
        {E2E_UI.returned}
      </span>
      <button type="button" className="link e2e-banner-more" onClick={() => void openE2eDialog('info')}>
        Saiba mais
      </button>
      <button type="button" className="icon-btn e2e-banner-close" onClick={dismiss} aria-label="Fechar aviso" title="Fechar">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function E2eBanner({ room }: { room: Room }) {
  const returnedAt = useE2e((s) => s.returned[room._id]);
  const note = returnedAt ? <ReturnNote rid={room._id} at={returnedAt} /> : null;
  return (
    <>
      {room.encrypted && <StateBanner room={room} quiet={!!note} />}
      {note}
    </>
  );
}

// quiet: o aviso de quem voltou já está na tela, então a faixa de "pronta" não aparece junto.
function StateBanner({ room, quiet }: { room: Room; quiet: boolean }) {
  const block = useE2eBlock(room);
  const [dismissed, setDismissed] = useState(() => readDismissed(room._id));
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => setDismissed(readDismissed(room._id)), [room._id]);
  useEffect(() => {
    if (cooldown <= Date.now()) return;
    const t = setTimeout(() => setCooldown(0), cooldown - Date.now());
    return () => clearTimeout(t);
  }, [cooldown]);
  const waiting = block?.key === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void askAgain(room._id, { force: false });
    }, ASK_EVERY_MS);
    return () => clearInterval(t);
  }, [waiting, room._id]);
  if (!block) {
    if (dismissed || quiet) return null;
    const dismiss = () => {
      setDismissed(true);
      try {
        localStorage.setItem(dismissKey(room._id), '1');
      } catch {
        // armazenamento indisponível: some só até recarregar
      }
    };
    return (
      <div className="e2e-banner" role="note">
        <Icon name="e2e-mark" size={16} />
        <span className="e2e-banner-text" title={E2E_UI.ready}>
          {E2E_UI.ready}
        </span>
        <button type="button" className="link e2e-banner-more" onClick={() => void openE2eDialog('info')}>
          Saiba mais
        </button>
        <button type="button" className="icon-btn e2e-banner-close" onClick={dismiss} aria-label="Fechar aviso" title="Fechar">
          <Icon name="close" size={16} />
        </button>
      </div>
    );
  }
  const action =
    block.key === 'none' ? (
      <button type="button" className="btn small primary" onClick={() => void openE2eDialog('setup')}>
        Configurar
      </button>
    ) : block.key === 'locked' ? (
      <button type="button" className="btn small primary" onClick={() => void openE2eDialog('unlock')}>
        Desbloquear
      </button>
    ) : block.key === 'waiting' ? (
      // Depois do toque, o próprio botão confirma o pedido (e volta em 30 s, a espera do servidor).
      <button
        type="button"
        className="btn small"
        disabled={cooldown > Date.now()}
        aria-live="polite"
        onClick={() => {
          setCooldown(Date.now() + 30_000);
          void askAgain(room._id);
        }}
      >
        {cooldown > Date.now() ? (
          <>
            <Icon name="success" size={14} />
            {E2E_UI.asked}
          </>
        ) : (
          'Pedir de novo'
        )}
      </button>
    ) : block.key === 'error' ? (
      <button type="button" className="btn small" onClick={() => void ensureRoom(room, { refresh: true })}>
        Tentar de novo
      </button>
    ) : null;
  return (
    <div className={`e2e-banner ${block.key}`} role="note">
      <Icon name={block.icon} size={16} />
      <span className="e2e-banner-text" title={block.text}>
        {block.text}
      </span>
      {action}
    </div>
  );
}
