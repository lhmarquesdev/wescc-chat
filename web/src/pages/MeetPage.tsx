// /meet/<código>: a página do link da reunião. Mostra a reunião, entra na sala e abre a chamada de vídeo.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { MeetingInfo } from '@shared/calendar';
import type { RoomCallState } from '@shared/index';
import { api, ApiError, errorMessage } from '../lib/api';
import { calendarApi, whenLabel } from '../lib/calendar';
import { openCall, openJoin, useCallStore } from '../lib/call/store';
import { roomPath } from '../lib/format';
import { explainCall } from '../lib/roomcall';
import { useSetting } from '../lib/store';
import { Icon } from '../components/Icon';
import { Empty, Skeleton, UserAvatar, useAsync } from '../components/ui';
import '../components/calendar/calendar.css';

export function MeetPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const callsOn = useSetting<boolean>('Calls_Enabled') !== false;
  // A reunião é uma sala de grupo: a chamada de vídeo precisa das chamadas em grupo (servidor de chamadas configurado).
  // Sem elas, a página não oferece um "Entrar na reunião" que só falharia depois de mudar de tela.
  const groupOn = useCallStore((s) => s.config?.groupEnabled) !== false;
  const videoOn = callsOn && groupOn;
  // Link errado, reunião só para convidados ou Agenda desligada não mudam com outra tentativa: "Tentar de novo" fica
  // só para falha de rede, limite de pedidos ou erro do servidor.
  const [retryable, setRetryable] = useState(false);
  const { data, error, reload } = useAsync<MeetingInfo>(
    () =>
      calendarApi.meeting(code).catch((e) => {
        const status = e instanceof ApiError ? e.status : 0;
        setRetryable(status === 0 || status === 429 || status >= 500);
        throw e;
      }),
    [code],
  );
  const [busy, setBusy] = useState<'video' | 'chat' | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const enter = async (how: 'video' | 'chat') => {
    setBusy(how);
    setJoinError(null);
    try {
      const { rid } = await calendarApi.join(code);
      navigate(roomPath({ _id: rid, t: 'p' }));
      if (how === 'video' && videoOn) {
        // Chamada já aberta na sala: entra nela; senão abre a tela de entrada para começar.
        const st = await api.get<RoomCallState>('calls.roomCall', { roomId: rid }).catch(() => null);
        if (st?.call && st.canJoin) void openJoin(st.call._id, rid);
        else if (st?.call) explainCall(st.joinBlockedReason ?? 'Não foi possível entrar na chamada.');
        else if (st && !st.canStart) explainCall(st.startBlockedReason ?? 'As chamadas não estão disponíveis nesta sala.');
        else void openCall(rid, 'video');
      }
    } catch (e) {
      setJoinError(errorMessage(e));
      setBusy(null);
    }
  };

  let body;
  if (error)
    body = (
      <Empty
        icon="cal-canceled"
        title="Não foi possível abrir a reunião"
        action={
          <button type="button" className="btn" onClick={() => navigate('/calendar')}>
            Abrir a Agenda
          </button>
        }
      >
        {error}
      </Empty>
    );
  else if (!data)
    body = (
      <div className="meet-card" aria-busy="true">
        <Skeleton width="60%" height={22} />
        <Skeleton width="40%" />
        <Skeleton height={40} />
      </div>
    );
  else {
    const e = data.event;
    const canceled = e.status === 'canceled';
    const ended = new Date(e.endsAt) < new Date();
    const people = [e.owner, ...e.attendees.filter((a) => a._id !== e.owner._id && a.response !== 'declined')];
    body = (
      <div className="meet-card">
        <span className="meet-icon" aria-hidden="true">
          <Icon name="cal-meeting" size={24} />
        </span>
        <h1>{e.title}</h1>
        <p className="meet-when">
          <Icon name="cal-time" size={16} />
          {whenLabel(e)}
        </p>
        <p className="meet-owner muted">
          <UserAvatar username={e.owner.username} size={20} />
          Organizada por {e.owner.name || e.owner.username}
        </p>
        {e.description && <p className="meet-desc">{e.description}</p>}
        {canceled ? (
          <div className="callout warn">
            <Icon name="cal-canceled" />
            <span>Esta reunião foi cancelada.</span>
          </div>
        ) : (
          <>
            {ended && (
              <p className="muted small">
                Esta reunião já terminou. A sala continua aberta para o chat{videoOn ? ' e para uma nova chamada' : ''}.
              </p>
            )}
            <div className="meet-actions">
              {videoOn && (
                <button type="button" className="btn primary lg" aria-busy={busy === 'video' || undefined} disabled={!data.canJoin || !!busy} onClick={() => void enter('video')}>
                  <Icon name="meeting-join" />
                  Entrar na reunião
                </button>
              )}
              <button type="button" className={videoOn ? 'btn lg' : 'btn primary lg'} aria-busy={busy === 'chat' || undefined} disabled={!data.canJoin || !!busy} onClick={() => void enter('chat')}>
                <Icon name="nav-chats" />
                Abrir o chat da reunião
              </button>
            </div>
            {callsOn && !groupOn && <p className="muted small">A chamada de vídeo da reunião ainda não está disponível neste chat. A conversa da reunião funciona normalmente.</p>}
            {!data.joined && data.canJoin && e.myResponse !== 'organizer' && e.meeting?.access === 'org' && (
              <p className="muted small">Ao entrar você passa a ser convidado desta reunião.</p>
            )}
          </>
        )}
        {joinError && (
          <div className="form-error" role="alert">
            <Icon name="error" size={16} />
            <span>{joinError}</span>
          </div>
        )}
        {people.length > 1 && (
          <div className="meet-people" aria-label="Participantes">
            {people.slice(0, 8).map((a) => (
              <span key={a._id} title={a.name || a.username}>
                <UserAvatar username={a.username} size={28} />
              </span>
            ))}
            {people.length > 8 && <span className="pill small">+{people.length - 8}</span>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page meet-page">
      <div className="meet-wrap">
        {body}
        {error && retryable && (
          <button type="button" className="btn ghost small" onClick={reload}>
            Tentar de novo
          </button>
        )}
      </div>
    </div>
  );
}
