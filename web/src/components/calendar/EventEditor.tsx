// Criar ou editar um evento da Agenda. "Reunião" cria a sala da reunião e o link /meet/<código> para os convidados.
import { useEffect, useMemo, useState } from 'react';
import type { CalendarEvent, MeetingAccess } from '@shared/calendar';
import { REMINDER_CHOICES } from '@shared/calendar';
import { errorMessage } from '../../lib/api';
import { addDays, calendarApi, dateInput, DAY_MS, eventDays, fromInputs, reminderLabel, startOfDay, timeInput } from '../../lib/calendar';
import { usePermission, useSetting, useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { UserPicker, type PickedUser } from '../Pickers';
import { Field, Modal, Segmented, Toggle } from '../ui';
import './calendar.css';

export interface EditorStart {
  event?: CalendarEvent; // editar
  start?: Date; // novo: dia/hora clicados
  allDay?: boolean;
  meeting?: boolean; // novo já como reunião
  attendees?: PickedUser[];
}

function nextSlot(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

export function EventEditor({ init, onClose, onSaved }: { init: EditorStart; onClose: () => void; onSaved: (e: CalendarEvent) => void }) {
  const editing = init.event;
  const canMeet = usePermission('create-calendar-meeting');
  const callsOn = useSetting<boolean>('Calls_Enabled') !== false;
  const me = useStore((s) => s.me)!;

  const first = useMemo(() => {
    if (editing) {
      const { start, end } = eventDays(editing);
      return { start, end: editing.allDay ? addDays(end, -1) : end };
    }
    const start = init.start ?? nextSlot();
    return { start, end: init.allDay ? start : new Date(start.getTime() + 60 * 60_000) };
  }, [editing, init.start, init.allDay]);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [meeting, setMeeting] = useState(editing ? !!editing.meeting : !!init.meeting && canMeet);
  const [access, setAccess] = useState<MeetingAccess>(editing?.meeting?.access ?? 'invited');
  const [allDay, setAllDay] = useState(editing?.allDay ?? !!init.allDay);
  const [date, setDate] = useState(dateInput(first.start));
  const [endDate, setEndDate] = useState(dateInput(first.end));
  const [startTime, setStartTime] = useState(timeInput(first.start));
  const [endTime, setEndTime] = useState(timeInput(first.end));
  const [people, setPeople] = useState<PickedUser[]>(
    editing ? editing.attendees.map((a) => ({ _id: a._id, username: a.username, name: a.name })) : (init.attendees ?? []).filter((u) => u._id !== me._id),
  );
  const [location, setLocation] = useState(editing?.location ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [reminder, setReminder] = useState<number | null>(editing ? editing.reminderMinutes : 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mudar o início leva o fim junto (mesma duração), como nas agendas de sempre.
  const moveStart = (t: string) => {
    const dur = fromInputs(date, endTime).getTime() - fromInputs(date, startTime).getTime();
    const ns = fromInputs(date, t);
    setStartTime(t);
    if (dur > 0) setEndTime(timeInput(new Date(ns.getTime() + dur)));
  };

  const range = useMemo(() => {
    if (allDay) {
      const s = fromInputs(date, '00:00');
      const e = addDays(fromInputs(endDate || date, '00:00'), 1);
      return { s, e, ok: e > s };
    }
    const s = fromInputs(date, startTime);
    let e = fromInputs(date, endTime);
    if (e <= s) e = new Date(e.getTime() + DAY_MS); // terminou depois da meia-noite
    return { s, e, ok: e.getTime() - s.getTime() <= 24 * 60 * 60_000 };
  }, [allDay, date, endDate, startTime, endTime]);

  // Quem já tem compromisso no horário (só início e fim; o título dos outros nunca chega aqui).
  const [conflicts, setConflicts] = useState<string[]>([]);
  const peopleKey = people.map((p) => p._id).join(',');
  useEffect(() => {
    if (!people.length || allDay || !range.ok) return void setConflicts([]);
    let alive = true;
    const t = window.setTimeout(() => {
      const day = startOfDay(range.s);
      calendarApi
        .busy(
          people.map((p) => p._id),
          day,
          addDays(day, 2),
        )
        .then((b) => {
          if (!alive) return;
          const names = people
            .filter((p) =>
              (b[p._id] ?? []).some((x) => {
                // O próprio evento em edição não conta como conflito.
                if (editing && x.startsAt === editing.startsAt && x.endsAt === editing.endsAt) return false;
                return new Date(x.startsAt) < range.e && new Date(x.endsAt) > range.s;
              }),
            )
            .map((p) => p.name || p.username);
          setConflicts(names);
        })
        .catch(() => alive && setConflicts([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleKey, allDay, range.s.getTime(), range.e.getTime()]);

  const submit = async () => {
    if (!title.trim()) return setError('Dê um título ao evento.');
    if (!range.ok) return setError(allDay ? 'O último dia precisa ser igual ou depois do primeiro.' : 'Um evento com horário pode durar até 24 horas. Para mais, use dia inteiro.');
    setBusy(true);
    setError(null);
    const input = {
      title: title.trim(),
      description,
      location,
      allDay,
      startsAt: allDay ? date : range.s.toISOString(),
      endsAt: allDay ? endDate || date : range.e.toISOString(),
      attendeeIds: people.map((p) => p._id),
      isMeeting: meeting,
      meetingAccess: access,
      reminderMinutes: reminder,
    };
    try {
      const saved = editing ? await calendarApi.update(editing._id, input) : await calendarApi.create(input);
      useStore.getState().toast(editing ? 'Evento atualizado.' : meeting ? 'Reunião marcada. Os convidados foram avisados.' : people.length ? 'Evento criado. Os convidados foram avisados.' : 'Evento criado.', 'success');
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const kindItems = [
    { id: 'event' as const, label: 'Evento', icon: 'calendar' as const },
    { id: 'meeting' as const, label: 'Reunião com link', icon: 'cal-meeting' as const },
  ];

  return (
    <Modal
      title={editing ? (editing.meeting ? 'Editar reunião' : 'Editar evento') : meeting ? 'Nova reunião' : 'Novo evento'}
      onClose={onClose}
      className="cal-editor"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" aria-busy={busy || undefined} disabled={busy || !title.trim()} onClick={() => void submit()}>
            {editing ? 'Salvar' : meeting ? 'Marcar reunião' : 'Criar evento'}
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Título" required>
          <input autoFocus value={title} maxLength={200} placeholder={meeting ? 'Ex.: Alinhamento do turno da noite' : 'Ex.: Treinamento de atendimento'} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {canMeet && !editing?.meeting && (
          <div className="field">
            <span className="field-label">Tipo</span>
            <Segmented label="Tipo" value={meeting ? 'meeting' : 'event'} onChange={(v) => setMeeting(v === 'meeting')} items={kindItems} />
            <span className="field-hint">
              {meeting
                ? `Cria uma sala para a reunião, com chat${callsOn ? ' e chamada de vídeo' : ''}, e um link para entrar.`
                : 'Um compromisso na agenda. Os convidados recebem o convite e respondem.'}
            </span>
          </div>
        )}

        <div className="cal-when">
          <Field label={allDay ? 'Primeiro dia' : 'Data'}>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                const v = e.target.value;
                if (allDay && endDate < v) setEndDate(v);
                setDate(v);
              }}
            />
          </Field>
          {allDay ? (
            <Field label="Último dia">
              <input type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="Início">
                <input type="time" step={300} value={startTime} onChange={(e) => moveStart(e.target.value)} />
              </Field>
              <Field label="Fim">
                <input type="time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <Toggle checked={allDay} onChange={setAllDay} label="Dia inteiro" />

        <Field label="Convidados" hint={meeting ? 'Entram na sala da reunião e recebem o link.' : 'Recebem o convite na hora e podem aceitar ou recusar.'}>
          <UserPicker value={people} onChange={setPeople} placeholder="Buscar pessoas do chat" />
        </Field>
        {conflicts.length > 0 && (
          <p className="muted small cal-conflict" role="status">
            <Icon name="cal-time" size={14} />
            <span>
              {conflicts.length === 1 ? `${conflicts[0]} já tem um compromisso nesse horário.` : `${conflicts.slice(0, -1).join(', ')} e ${conflicts.at(-1)} já têm compromissos nesse horário.`}
            </span>
          </p>
        )}

        {meeting && (
          <div className="field">
            <span className="field-label">Quem entra pelo link</span>
            <Segmented
              label="Quem entra pelo link"
              value={access}
              onChange={setAccess}
              items={[
                { id: 'invited', label: 'Só convidados' },
                { id: 'org', label: 'Qualquer pessoa do chat' },
              ]}
            />
            <span className="field-hint">{access === 'org' ? 'Quem abrir o link entra na reunião e passa a ser convidado.' : 'Quem não foi convidado vê um aviso para pedir o convite.'}</span>
          </div>
        )}

        <Field label="Local" hint={meeting ? 'Opcional. A reunião já tem o link para entrar.' : 'Opcional.'}>
          <input value={location} maxLength={300} placeholder="Ex.: Sala 3, 2º andar" onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Descrição">
          <textarea rows={3} value={description} maxLength={5000} placeholder="Pauta, links, o que levar…" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Lembrete">
          <select value={reminder === null ? 'none' : String(reminder)} onChange={(e) => setReminder(e.target.value === 'none' ? null : Number(e.target.value))}>
            <option value="none">Sem lembrete</option>
            {REMINDER_CHOICES.map((m) => (
              <option key={m} value={m}>
                {reminderLabel(m)}
              </option>
            ))}
          </select>
        </Field>
        {error && (
          <div className="form-error" role="alert">
            <Icon name="error" size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
