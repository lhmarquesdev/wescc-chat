// Cartão de reunião (.att-meeting), no formato do cartão de chamada: do Teams ("Reunião do Microsoft Teams", abre
// fora) ou da Agenda do chat ("Reunião do chat", abre /meet/<código> aqui mesmo).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MessageMeeting } from '@shared/integrations';
import { formatTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import './integrations.css';

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

// "Reunião do Microsoft Teams · 14:00–14:30" (hoje), "· 23/10 14:00" (outro dia) ou só o nome sem horário.
function meetingMeta(m: MessageMeeting): string {
  const base = m.provider === 'wescc' ? 'Reunião do chat' : 'Reunião do Microsoft Teams';
  if (!m.startsAt) return base;
  const start = new Date(m.startsAt);
  if (Number.isNaN(start.getTime())) return base;
  if (start.toDateString() !== new Date().toDateString()) return `${base} · ${dayMonth.format(start)} ${formatTime(m.startsAt)}`;
  return m.endsAt ? `${base} · ${formatTime(m.startsAt)}–${formatTime(m.endsAt)}` : `${base} · ${formatTime(m.startsAt)}`;
}

export function MeetingCard({ meeting }: { meeting: MessageMeeting }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Reunião do chat: o link é /meet/<código> no próprio site (o endereço completo vai para a cópia).
  const internal = meeting.provider === 'wescc';
  const internalPath = internal ? (/\/meet\/[a-z0-9-]+$/.exec(meeting.joinUrl)?.[0] ?? '/calendar') : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meeting.joinUrl);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      useStore.getState().toast('Não foi possível copiar.', 'error');
    }
  };

  return (
    <div className="att-meeting">
      <span aria-hidden="true">
        <Icon name={internal ? 'cal-meeting' : 'meeting-teams'} size={18} />
      </span>
      <div>
        <strong title={meeting.subject}>{meeting.subject || (internal ? 'Reunião' : 'Reunião do Teams')}</strong>
        <small>{meetingMeta(meeting)}</small>
      </div>
      {internal ? (
        <Link className="btn small primary" to={internalPath}>
          <Icon name="meeting-join" size={14} />
          Entrar
        </Link>
      ) : (
        <a className="btn small primary" href={meeting.joinUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="meeting-join" size={14} />
          Entrar
        </a>
      )}
      <button type="button" className="icon-btn" aria-label={copied ? 'Copiado' : 'Copiar link'} title={copied ? 'Copiado' : 'Copiar link'} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
    </div>
  );
}
