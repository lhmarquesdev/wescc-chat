// Cartão de reunião do Teams (.att-meeting), no formato do cartão de chamada. A chamada do Wescc é "Chamada";
// a do Teams é sempre "Reunião do Teams".
import { useEffect, useRef, useState } from 'react';
import type { MessageMeeting } from '@shared/integrations';
import { formatTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import './integrations.css';

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

// "Reunião do Microsoft Teams · 14:00–14:30" (hoje), "· 23/10 14:00" (outro dia) ou só o nome sem horário.
function meetingMeta(m: MessageMeeting): string {
  const base = 'Reunião do Microsoft Teams';
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
        <Icon name="meeting-teams" size={18} />
      </span>
      <div>
        <strong title={meeting.subject}>{meeting.subject || 'Reunião do Teams'}</strong>
        <small>{meetingMeta(meeting)}</small>
      </div>
      <a className="btn small primary" href={meeting.joinUrl} target="_blank" rel="noopener noreferrer">
        <Icon name="meeting-join" size={14} />
        Entrar
      </a>
      <button type="button" className="icon-btn" aria-label={copied ? 'Copiado' : 'Copiar link'} title={copied ? 'Copiado' : 'Copiar link'} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
    </div>
  );
}
