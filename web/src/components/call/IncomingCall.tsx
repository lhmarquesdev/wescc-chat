// Chamada recebida: o cartão de hoje (computador) e a tela cheia (celular). Na chamada em grupo, o título é a sala e
// a linha diz quem chamou. Um segundo toque espera na fila; o cartão mostra "+1 chamada".
import type { Call, UserRef } from '@shared/index';
import { acceptIncoming, callRoomName, declineIncoming, useCallStore } from '../../lib/call/store';
import { useSetting, useStore } from '../../lib/store';
import { BrandMark } from '../BrandIcons';
import { Icon, type IconName } from '../Icon';
import { useIsPhone } from '../overlay';
import { Avatar } from '../ui';
import { CallButton } from './ControlBar';

export function IncomingCall({ call, queued }: { call: Call; queued: number }) {
  const phone = useIsPhone();
  const ringBy = useCallStore((s) => s.ringBy[call._id]);
  const group = call.scope === 'group';
  const who: UserRef = (group && ringBy) || call.caller;
  const roomName = useStore(() => (group ? callRoomName(call.room ?? null) : ''));
  const name = group ? roomName || 'Chamada em grupo' : who.name || who.username;
  const video = call.kind === 'video';
  const statusText = useStore((s) => s.presence[who.username]?.statusText);
  const last = useStore((s) => s.rooms[call.rid]?.lastMessage);
  const site = useSetting<string>('Site_Name');
  // A última mensagem de quem liga, se acabou de chegar, costuma dizer o assunto ("vou mostrar a planilha").
  const quote = !group && last && last.u._id === who._id && last.msg && Date.now() - new Date(last.ts).getTime() < 10 * 60000 ? last.msg : '';
  const kindIcon: IconName = video ? 'call-video' : 'call-audio';
  const kindText = group ? (video ? 'Chamada de vídeo em grupo' : 'Chamada de voz em grupo') : video ? 'Chamada de vídeo' : 'Chamada de voz';
  const byLine = group ? `@${who.username} está chamando você` : '';
  const accept = (audioOnly = false) => void acceptIncoming(call._id, audioOnly);
  const decline = <CallButton icon="call-hangup" title="Recusar" label="Recusar" className="hang" size={phone ? 24 : 22} onClick={() => void declineIncoming(call._id)} />;
  const answer = <CallButton icon={kindIcon} title="Atender" label="Atender" className="accept" size={phone ? 24 : 22} onClick={() => accept()} />;
  const more = queued > 0 && <span className="pill call-queue">{queued === 1 ? '+1 chamada' : `+${queued} chamadas`}</span>;
  const label = group ? `Chamada em ${name}` : `Chamada recebida de ${name}`;

  if (phone) {
    return (
      <div className="call-incoming full" role="alertdialog" aria-label={label}>
        {site && (
          <div className="call-brand">
            <BrandMark size={20} />
            <span>{site}</span>
          </div>
        )}
        <div className="call-hero">
          <span className="call-rings">
            <i />
            <i />
            <i />
            <Avatar username={who.username} size={120} />
          </span>
          <strong className="call-name">{name}</strong>
          {byLine && <span className="call-by">{byLine}</span>}
          <span className="call-kind">
            <Icon name={kindIcon} />
            {group ? kindText : video ? 'Chamada de vídeo recebida' : 'Chamada de voz recebida'}
          </span>
          {quote && (
            <span className="call-quote">
              <Icon name="room-dm" size={14} />
              <span>“{quote}”</span>
            </span>
          )}
          {more}
        </div>
        <div className="call-answer">
          {video && (
            <button type="button" className="call-audio-only" title="Atender só com áudio" onClick={() => accept(true)}>
              <Icon name="call-audio" />
              Só áudio
            </button>
          )}
          <div className="call-buttons">
            {decline}
            {answer}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="call-incoming" role="alertdialog" aria-label={label}>
      <div className="call-incoming-head">
        <span className="call-ring">
          <Avatar username={who.username} size={48} />
        </span>
        <div className="call-who">
          <strong>{name}</strong>
          {byLine && <span className="call-by ellipsis">{byLine}</span>}
          <span className="call-kind">
            <Icon name={kindIcon} size={14} />
            <span className="ellipsis">
              {kindText}
              {!group && statusText ? ` · ${statusText}` : ''}
            </span>
          </span>
        </div>
        {more}
      </div>
      <div className="call-buttons">
        {decline}
        {video && <CallButton icon="call-audio" title="Atender só com áudio" label="Só áudio" onClick={() => accept(true)} />}
        {answer}
      </div>
    </div>
  );
}
