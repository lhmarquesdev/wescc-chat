import { useSearchParams } from 'react-router-dom';
import type { Room } from '@shared/index';
import { useAcks } from '../lib/acks';
import './notices.css';

// Faixa no topo de um canal de avisos: quem escreve aqui e, para quem lê, os avisos que esperam o "Ciente".
export function NoticeBar({ room, canPost }: { room: Room; canPost: boolean }) {
  const pending = useAcks((s) => s.byRoom[room._id]?.pending);
  const [params, setParams] = useSearchParams();
  const n = room.noticeAck ? (pending?.length ?? 0) : 0;
  const text = canPost
    ? `Você pode publicar aqui. Os outros membros só leem${room.reactWhenReadOnly ? ' e reagem' : ''}.${room.noticeAck ? ' Avisos podem pedir “Ciente”.' : ''}`
    : `Só os publicadores enviam mensagens aqui.${room.reactWhenReadOnly ? ' Você pode reagir aos avisos.' : ''}`;
  const showOldest = () => {
    params.set('msg', pending![0]);
    setParams(params);
  };
  return (
    <div className="notice-bar" role="note">
      <div>
        <strong>📢 Canal de avisos</strong> · {text}
      </div>
      {n > 0 && (
        <div className="notice-bar-pending">
          <span>
            Você tem {n} {n === 1 ? 'aviso' : 'avisos'} aguardando seu “Ciente”.
          </span>
          <button className="link" onClick={showOldest}>
            Ver o mais antigo
          </button>
        </div>
      )}
    </div>
  );
}
