// Faixa de uma linha abaixo do topo da conversa criptografada: o estado da criptografia neste navegador e o que fazer.
import { useEffect, useState } from 'react';
import type { Room } from '@shared/index';
import { askAgain, E2E_UI, ensureRoom, useE2e, type E2eRoomState, type E2eStatus } from '../../lib/e2e/client';
import { Icon, type IconName } from '../Icon';
import { openE2eDialog } from './E2eDialogs';
import './e2e.css';

type Block = { key: 'none' | 'locked' | 'waiting' | 'preparing' | 'unsupported' | 'error'; text: string; icon: IconName };

function blockOf(status: E2eStatus, roomState: E2eRoomState | undefined): Block | null {
  if (status === 'unsupported') return { key: 'unsupported', text: E2E_UI.unsupported, icon: 'e2e-warning' };
  if (status === 'none') return { key: 'none', text: E2E_UI.none, icon: 'e2e-key' };
  if (status === 'locked') return { key: 'locked', text: E2E_UI.locked, icon: 'e2e-key' };
  if (status === 'loading' || !roomState || roomState === 'creating' || roomState === 'rotating') return { key: 'preparing', text: E2E_UI.preparing, icon: 'e2e-waiting' };
  if (roomState === 'waiting') return { key: 'waiting', text: E2E_UI.waiting, icon: 'e2e-waiting' };
  if (roomState === 'error') return { key: 'error', text: E2E_UI.error, icon: 'e2e-warning' };
  return null;
}

// O que impede escrever na conversa criptografada (o texto do compositor desativado); null quando dá.
export function useE2eBlock(room: Room | null | undefined): Block | null {
  const status = useE2e((s) => s.status);
  const roomState = useE2e((s) => (room ? s.rooms[room._id] : undefined));
  if (!room?.encrypted) return null;
  return blockOf(status, roomState);
}

const dismissKey = (rid: string) => `wescc.e2e.banner.${rid}`;
const readDismissed = (rid: string) => {
  try {
    return localStorage.getItem(dismissKey(rid)) === '1';
  } catch {
    return false;
  }
};

export function E2eBanner({ room }: { room: Room }) {
  const block = useE2eBlock(room);
  const [dismissed, setDismissed] = useState(() => readDismissed(room._id));
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => setDismissed(readDismissed(room._id)), [room._id]);
  useEffect(() => {
    if (cooldown <= Date.now()) return;
    const t = setTimeout(() => setCooldown(0), cooldown - Date.now());
    return () => clearTimeout(t);
  }, [cooldown]);
  if (!room.encrypted) return null;
  if (!block) {
    if (dismissed) return null;
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
        <Icon name="encrypted" size={16} />
        <span className="e2e-banner-text" title={E2E_UI.ready}>
          {E2E_UI.ready}
        </span>
        <button type="button" className="link" onClick={() => void openE2eDialog('info')}>
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
      <button
        type="button"
        className="btn small"
        disabled={cooldown > Date.now()}
        onClick={() => {
          setCooldown(Date.now() + 30_000);
          void askAgain(room._id);
        }}
      >
        Pedir de novo
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
