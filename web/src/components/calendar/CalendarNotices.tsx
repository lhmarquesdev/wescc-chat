// Avisos da Agenda em qualquer tela: convite novo, mudança de horário, cancelamento, saída da lista de convidados e
// lembrete antes do início (com "Entrar" nas reuniões).
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { whenLabel } from '../../lib/calendar';
import { useCallStore } from '../../lib/call/store';
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
      } else if ((ev.type === 'calendar.updated' && ev.moved) || ev.type === 'calendar.canceled' || ev.type === 'calendar.removed') {
        const by = ev.by.name || ev.by.username;
        const e = ev.event;
        const open = { label: 'Ver', onClick: () => navigate(`/calendar?evento=${encodeURIComponent(e._id)}`) };
        if (ev.type === 'calendar.updated')
          toast(`${by} mudou o horário ${e.meeting ? 'da reunião' : 'de'} “${e.title}” · ${whenLabel(e)}`, 'info', { icon: 'nav-calendar', duration: 10_000, action: open });
        else if (ev.type === 'calendar.canceled')
          toast(`${by} cancelou ${e.meeting ? 'a reunião' : 'o evento'} “${e.title}”`, 'warning', { icon: 'cal-canceled', duration: 10_000, action: open });
        else toast(`${by} tirou você ${e.meeting ? 'da reunião' : 'do evento'} “${e.title}”`, 'info', { icon: 'nav-calendar', duration: 10_000 });
      } else if (ev.type === 'calendar.reminder') {
        const e = ev.event;
        const meet = e.meeting;
        toast(`${e.title} · ${whenLabel(e)}`, 'info', {
          icon: 'cal-reminder',
          duration: 30_000,
          // Sem chamadas em grupo não há vídeo para entrar: o botão só abre a página da reunião.
          action: meet
            ? { label: useCallStore.getState().config?.groupEnabled === false ? 'Abrir' : 'Entrar', onClick: () => navigate(`/meet/${meet.code}`) }
            : { label: 'Ver', onClick: () => navigate(`/calendar?evento=${encodeURIComponent(e._id)}`) },
        });
      }
    });
    return () => void off();
  }, [navigate]);
  return null;
}
