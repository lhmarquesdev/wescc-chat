// Sinais de chamada fora da sala: o ponto da sala com chamada viva, o selo de perdidas em Chamadas e o "Em chamada" de
// uma pessoa. Todos parados (sem animação): ficam na tela o tempo todo.
import { missedBadgeLabel } from '@shared/call-view';
import { isInCall, useCallStore } from '../../lib/call/store';
import { badgeCount } from '../../lib/format';
import { useInCall, useLiveCalls, useMissedCalls } from '../../lib/roomcall';
import { useSetting } from '../../lib/store';
import { Icon, type IconSize } from '../Icon';
import '../callroom.css';

// Depois do nome da sala na barra lateral. Uma chamada a dois só tocando ainda não está "em andamento".
export function RoomLiveDot({ rid }: { rid: string }) {
  const enabled = useSetting<boolean>('Calls_Enabled');
  const call = useLiveCalls()[rid];
  const mine = useCallStore((s) => !!call && s.call?._id === call._id && isInCall(call._id));
  if (!enabled || !call || call.status !== 'ongoing') return null;
  const title = mine ? 'Você está nesta chamada' : 'Chamada em andamento';
  return (
    <span className={mine ? 'side-live in' : 'side-live'} title={title} role="img" aria-label={title}>
      <Icon name="call-live" size={14} />
    </span>
  );
}

// Selo de chamadas perdidas em "Chamadas" (barra lateral e barra de abas do celular); some no zero.
export function CallsNavBadge() {
  const n = useMissedCalls();
  if (!(n > 0)) return null;
  return (
    <span className="badge mention" role="img" aria-label={missedBadgeLabel(n)}>
      {badgeCount(n)}
    </span>
  );
}

// "Em chamada" ao lado da presença (nunca no lugar dela): cartão da pessoa, membros e conversas a dois. Nas listas
// densas só o ícone (com o nome para leitores de tela e no title); com `label`, o texto aparece (cartão da pessoa, onde
// no toque não há dica ao passar o mouse).
export function InCallBadge({ userId, size = 14, label }: { userId: string | null | undefined; size?: IconSize; label?: boolean }) {
  const enabled = useSetting<boolean>('Calls_Enabled');
  const on = useInCall(enabled && userId ? userId : null);
  if (!on) return null;
  if (label)
    return (
      <span className="in-call-badge labelled">
        <Icon name="call-headset" size={size} />
        Em chamada
      </span>
    );
  return (
    <span className="in-call-badge" title="Em chamada" role="img" aria-label="Em chamada">
      <Icon name="call-headset" size={size} />
    </span>
  );
}
