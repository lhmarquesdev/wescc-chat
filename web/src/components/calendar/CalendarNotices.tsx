// Avisos da Agenda em qualquer tela: convite novo e lembrete antes do início (com "Entrar" nas reuniões).
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { whenLabel } from '../../lib/calendar';
import { realtime } from '../../lib/realtime';
import { useStore } from '../../lib/store';

export function CalendarNotices() {
  const navigate = useNavigate();
  useEffect(() => {
    const off = realtime.on((ev) => {
      const toast = useStore.getState().toast;
      if (ev.type === 'calendar.invite') {
        const by = ev.by.name || ev.by.username;
        const what = ev.event.meeting ? `a reunião “${ev.event.title}”` : `“${ev.event.title}”`;
        toast(`${by} convidou você para ${what} · ${whenLabel(ev.event)}`, 'info', {
          icon: ev.event.meeting ? 'cal-meeting' : 'nav-calendar',
          duration: 10_000,
          action: { label: 'Ver', onClick: () => navigate(`/calendar?evento=${encodeURIComponent(ev.event._id)}`) },
        });
      } else if (ev.type === 'calendar.reminder') {
        const e = ev.event;
        const meet = e.meeting;
        toast(`${e.title} · ${whenLabel(e)}`, 'info', {
          icon: 'cal-reminder',
          duration: 30_000,
          action: meet
            ? { label: 'Entrar', onClick: () => navigate(`/meet/${meet.code}`) }
            : { label: 'Ver', onClick: () => navigate(`/calendar?evento=${encodeURIComponent(e._id)}`) },
        });
      }
    });
    return () => void off();
  }, [navigate]);
  return null;
}
