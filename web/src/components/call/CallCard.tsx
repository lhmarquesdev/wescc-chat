// Cartão da chamada na conversa, sob o nome de quem ligou: o registro da chamada a dois (call_ended / call_missed,
// com "Ligar de volta") e o cartão da chamada em grupo (call_group), que se atualiza no lugar enquanto ela dura.
import { useId } from 'react';
import type { CallCard as GroupCard, Message } from '@shared/index';
import { CALL_HTTPS_REASON, cardView } from '@shared/call-view';
import { expandCall, isInCall, openJoin, useCallStore } from '../../lib/call/store';
import { prefetchSfu, startCall } from '../../lib/calls';
import { formatDuration, formatTime } from '../../lib/format';
import { namesIn } from '../../lib/names';
import { explainCall, recheckRoomCall, useCallEnv, useRoomCall, useRoomCallSettled } from '../../lib/roomcall';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Avatar } from '../ui';
import '../callroom.css';

export function CallCard({ message: m }: { message: Message & Record<string, any> }) {
  if (m.t === 'call_group') return <GroupCallCard m={m} card={m.call as GroupCard} />;
  return <DirectCallCard m={m} />;
}

// Registro de chamada (call_ended / call_missed): cartão sob o nome de quem ligou, com "Ligar de volta".
function DirectCallCard({ m }: { m: Message & Record<string, any> }) {
  const meId = useStore((s) => s.me?._id);
  const room = useStore((s) => s.rooms[m.rid]);
  const callsOn = useSetting<boolean>('Calls_Enabled');
  const c = (m.call ?? {}) as { kind?: string; status?: string; duration?: number };
  const video = c.kind === 'video';
  const missed = m.t === 'call_missed';
  const caller = m.u._id === meId;
  const status = c.status ?? 'missed';
  const title = !missed
    ? video
      ? 'Chamada de vídeo'
      : 'Chamada de voz'
    : status === 'declined'
      ? 'Chamada recusada'
      : caller
        ? status === 'canceled'
          ? 'Chamada cancelada'
          : 'Chamada não atendida'
        : 'Chamada perdida';
  // O título já diz o tipo (vídeo ou voz) ou o desfecho: a linha de baixo não repete nenhum dos dois.
  const meta = missed ? `${video ? 'Vídeo' : 'Voz'} · ${formatTime(m.ts)}` : `${formatDuration(c.duration ?? 0)} · ${formatTime(m.ts)}`;
  const canCall = !!callsOn && room?.t === 'd' && room.uids?.length === 2 && room.direct?.canCall !== false;
  return (
    <div className={missed ? 'call-card missed' : 'call-card'}>
      <span className="call-card-tile" aria-hidden="true">
        <Icon name={missed ? 'call-missed' : video ? 'call-video' : 'call-audio'} size={18} />
      </span>
      <span className="call-card-text">
        <span className="call-card-title">{title}</span>
        <span className="call-card-meta">{meta}</span>
      </span>
      {canCall && (
        <button type="button" className="btn small" onClick={() => void startCall(m.rid, video ? 'video' : 'audio')}>
          <Icon name={video ? 'call-video' : 'call-audio'} size={14} />
          {missed && !caller ? 'Ligar de volta' : 'Ligar de novo'}
        </button>
      )}
    </div>
  );
}

// Chamada em grupo: viva (quem está, há quanto tempo e Entrar, Ouvir ou Na chamada) ou encerrada (duração, pessoas e
// o motivo). O cronômetro corre aqui com a hora do servidor; o resto chega pelos eventos da sala e da mensagem.
function GroupCallCard({ m, card }: { m: Message & Record<string, any>; card: GroupCard | undefined }) {
  const live = card?.status === 'ongoing';
  const s = useRoomCall(live ? m.rid : null);
  const settled = useRoomCallSettled(live ? m.rid : null);
  const env = useCallEnv(card?._id, live);
  const tabCall = useCallStore((st) => st.tabCall);
  const whyId = useId();
  if (!card) return null;
  const starter = m.u.name || m.u.username;
  const v = cardView(card, s, env, starter);
  const people = (s?.call?._id === card._id ? s.call.sample : card.sample).slice(0, 5);
  const why = v.button?.reason;
  const click = async () => {
    const b = v.button;
    if (!b) return;
    if (b.reason === CALL_HTTPS_REASON) return explainCall(b.reason);
    if (b.reason || (b.action === 'join' && !settled)) {
      // Barrado ou provisório: confere com o servidor antes (a chamada cheia pode ter aberto lugar, algo pode ter
      // mudado com a sala fechada).
      const now = cardView(card, await recheckRoomCall(m.rid), env, starter).button;
      if (!now || now.action !== 'join') return;
      if (now.reason) return explainCall(now.reason);
    }
    if (b.action === 'join') return void openJoin(card._id, m.rid);
    if (!isInCall(card._id) && tabCall?.callId === card._id) return explainCall('Chamada em andamento em outra aba.');
    expandCall();
  };
  return (
    <div className={v.live ? 'call-card group live' : 'call-card group'}>
      <span className="call-card-tile" aria-hidden="true">
        <Icon name={v.icon} size={18} />
      </span>
      <span className="call-card-text">
        <span className="call-card-title">{v.title}</span>
        <span className="call-card-meta">{v.meta}</span>
        {v.people && (
          <span className="call-card-people">
            {people.length > 0 && (
              <span className="call-card-faces" aria-hidden="true">
                {people.map((u) => (
                  <Avatar key={u._id} username={u.username} size={20} />
                ))}
              </span>
            )}
            {v.people}
          </span>
        )}
        {v.reason && <span className="call-card-meta call-card-reason">{namesIn(v.reason)}</span>}
        {why && (
          <span id={whyId} className="call-card-meta call-card-reason">
            {namesIn(why)}
          </span>
        )}
      </span>
      {v.button && (
        <button
          type="button"
          className={v.button.action === 'open' ? 'btn small' : 'btn small primary call-join'}
          aria-disabled={why ? true : undefined}
          aria-describedby={why ? whyId : undefined}
          title={why ? undefined : v.button.action === 'open' ? 'Abrir a chamada' : undefined}
          onPointerEnter={() => prefetchSfu()}
          onFocus={() => prefetchSfu()}
          onClick={() => void click()}
        >
          {v.button.text}
        </button>
      )}
    </div>
  );
}
