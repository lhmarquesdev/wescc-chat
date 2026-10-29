// Faixa da chamada viva, abaixo do cabeçalho da sala (depois da faixa de avisos, antes do anúncio): quem está, há
// quanto tempo e Entrar (ou Ouvir). "Ocultar" vale para esta chamada nesta aba.
import { useEffect, useId, useRef, useState } from 'react';
import type { Room } from '@shared/index';
import { bannerView, CALL_HTTPS_REASON, liveCallIcon } from '@shared/call-view';
import { announce, openJoin } from '../../lib/call/store';
import { prefetchSfu } from '../../lib/calls';
import { namesIn } from '../../lib/names';
import { explainCall, recheckRoomCall, useCallEnv, useRoomCall, useRoomCallSettled } from '../../lib/roomcall';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Avatar } from '../ui';
import '../callroom.css';

const HIDE_KEY = (rid: string) => `wescc.call.banner.${rid}`;

function readHidden(rid: string): string | null {
  try {
    return sessionStorage.getItem(HIDE_KEY(rid));
  } catch {
    return null;
  }
}

export function CallBanner({ room }: { room: Room }) {
  const rid = room._id;
  const s = useRoomCall(rid);
  const settled = useRoomCallSettled(rid);
  const env = useCallEnv(s?.call?._id, true);
  const phone = useIsPhone();
  const [hidden, setHidden] = useState(() => readHidden(rid));
  const whyId = useId();
  useEffect(() => setHidden(readHidden(rid)), [rid]);
  const v = bannerView(s, env, hidden);
  const call = s?.call;

  // Anuncia uma vez por chamada, quando a faixa aparece (não a cada segundo do cronômetro).
  const told = useRef<string | null>(null);
  const shown = v && call ? call._id : null;
  useEffect(() => {
    if (shown && told.current !== shown) announce('Chamada em andamento nesta sala.');
    told.current = shown;
  }, [shown]);

  if (!v || !call) return null;
  const hide = () => {
    try {
      sessionStorage.setItem(HIDE_KEY(rid), call._id);
    } catch {
      // sem armazenamento da sessão: oculta só até sair da sala
    }
    setHidden(call._id);
  };
  // Barrada ou provisória: confere com o servidor antes (a chamada pode ter aberto lugar, a trava pode ter saído, algo
  // pode ter mudado com a sala fechada).
  const join = async () => {
    const why = v.primary?.reason;
    if (why === CALL_HTTPS_REASON) return explainCall(why);
    if (why || !settled) {
      const fresh = await recheckRoomCall(rid);
      const now = bannerView(fresh, env, hidden);
      if (!now?.primary || !fresh?.call) return;
      if (now.primary.reason) return explainCall(now.primary.reason);
      return void openJoin(fresh.call._id, rid);
    }
    void openJoin(call._id, rid);
  };
  const icon = v.guard ? 'call-guard' : liveCallIcon(call);
  const people = call.sample.slice(0, 5);
  // Barrada ou pausada: no celular a faixa ganha linhas para o título inteiro e o motivo.
  const cls = ['call-room-banner', v.guard && 'warn', v.primary?.reason && 'blocked'].filter(Boolean).join(' ');
  return (
    <div className={cls} role="region" aria-label="Chamada na sala">
      <span className="call-room-banner-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <div className="call-room-banner-text">
        <strong className="call-room-banner-title">{v.title}</strong>
        <span className="call-room-banner-meta">{v.meta}</span>
        {v.primary?.reason && (
          <span className="call-banner-why" id={whyId}>
            {namesIn(v.primary.reason)}
          </span>
        )}
      </div>
      {!phone && people.length > 0 && (
        <span className="call-room-banner-people" aria-hidden="true">
          {people.map((u) => (
            <Avatar key={u._id} username={u.username} size={24} />
          ))}
        </span>
      )}
      {v.primary && (
        <button
          type="button"
          className="btn small primary call-join"
          aria-disabled={v.primary.reason ? true : undefined}
          aria-describedby={v.primary.reason ? whyId : undefined}
          onPointerEnter={() => prefetchSfu()}
          onFocus={() => prefetchSfu()}
          onClick={() => void join()}
        >
          {v.primary.text}
        </button>
      )}
      <button type="button" className="icon-btn" title="Ocultar" aria-label="Ocultar" onClick={hide}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
