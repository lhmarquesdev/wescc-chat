import { useSearchParams } from 'react-router-dom';
import type { Room } from '@shared/index';
import { useAcks } from '../lib/acks';
import { Icon } from './Icon';
import './notices.css';

// Faixa de uma linha no topo de um canal de avisos, só enquanto há avisos esperando o "Ciente" de quem lê. Quem
// publica aqui já vê isso no compositor (e quem só lê, na linha do compositor desativado).
export function NoticeBar({ room }: { room: Room; canPost?: boolean }) {
  const pending = useAcks((s) => s.byRoom[room._id]?.pending);
  const [params, setParams] = useSearchParams();
  const n = room.noticeAck ? (pending?.length ?? 0) : 0;
  if (!n) return null;
  const showOldest = () => {
    params.set('msg', pending![0]);
    setParams(params);
  };
  return (
    <div className="notice-bar" role="note">
      <div className="notice-bar-pending">
        <span className="notice-bar-dot" aria-hidden="true" />
        <span className="notice-bar-label">
          {n === 1 ? '1 aviso aguardando seu “Ciente”' : `${n.toLocaleString('pt-BR')} avisos aguardando seu “Ciente”`}
        </span>
        <button type="button" className="link" onClick={showOldest} title="Ver o mais antigo">
          {n === 1 ? 'Ver' : 'Ver o mais antigo'}
        </button>
      </div>
    </div>
  );
}
