// Lembretes da Agenda: reminder_minutes antes do início, para o dono e os convidados que não recusaram (aviso na tela e
// push). Cada evento avisa uma vez por horário (mudar o horário zera reminded_at). Trazidos do Google/Outlook: sem lembrete.
import { many } from '../db/pool';
import { bus } from '../realtime/bus';
import { sendPush } from '../services/push';
import { calendarOn, eventFor, whenText } from './events';

const LATE_MINUTES = 10; // o servidor esteve parado: lembrete de evento que começou há mais que isso não sai

export async function sendDueReminders(): Promise<number> {
  if (!calendarOn()) return 0;
  const due = await many(
    `UPDATE calendar_events SET reminded_at = now()
      WHERE id IN (
        SELECT id FROM calendar_events
         WHERE status = 'confirmed' AND source = 'chat' AND reminded_at IS NULL AND reminder_minutes IS NOT NULL
           AND starts_at - reminder_minutes * interval '1 minute' <= now() AND starts_at > now() - $1 * interval '1 minute'
         ORDER BY starts_at LIMIT 200 FOR UPDATE SKIP LOCKED)
      RETURNING id, owner_id, title, starts_at, all_day, is_meeting, meeting_code`,
    [LATE_MINUTES],
  );
  for (const e of due) {
    const people = [
      e.owner_id,
      ...(await many(`SELECT user_id FROM calendar_attendees WHERE event_id = $1 AND response <> 'declined'`, [e.id])).map((r) => r.user_id as string),
    ];
    for (const uid of people) {
      const ev = await eventFor(e.id, uid);
      if (ev) bus.publish({ user: uid }, { type: 'calendar.reminder', event: ev });
    }
    const url = e.is_meeting && e.meeting_code ? `/meet/${e.meeting_code}` : `/calendar?evento=${encodeURIComponent(e.id)}`;
    void sendPush(people, { title: e.title, body: `Começa ${whenText({ allDay: e.all_day, startsAt: e.starts_at })}`, url, tag: `calendar-reminder-${e.id}` }).catch(() => {});
  }
  return due.length;
}
