import { useState } from 'react';
import type { Message } from '@shared/index';
import { AHEAD_MIN_MS } from '@shared/messages';
import { api, errorMessage } from '../lib/api';
import { fromLocalInput, reminderPresets, toLocalInput, whenText } from '../lib/messageTimes';
import { useStore } from '../lib/store';
import { Field, Modal } from './ui';

// "Lembrar-me desta mensagem": atalhos de horário ou data e hora à escolha. Só a própria pessoa vê.
export function ReminderModal({ m, onClose }: { m: Message; onClose: () => void }) {
  const reminder = useStore((s) => s.reminders.find((r) => r.messageId === m._id));
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const toast = useStore.getState().toast;

  const save = async (at: Date) => {
    setBusy(true);
    try {
      const r = await api.post('reminders.set', { messageId: m._id, remindAt: at.toISOString() });
      useStore.getState().upsertReminder(r.reminder);
      toast(`Lembrete marcado para ${whenText(r.reminder.remindAt, new Date())}.`, 'success', { icon: 'remind' });
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!reminder) return;
    setBusy(true);
    try {
      await api.post('reminders.delete', { reminderId: reminder._id });
      useStore.getState().removeReminder(reminder._id);
      toast('Lembrete removido.');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const picked = fromLocalInput(value);

  return (
    <Modal
      title="Lembrar-me desta mensagem"
      onClose={onClose}
      variant={custom ? undefined : 'sheet'}
      className="reminder-modal"
      footer={
        custom ? (
          <>
            <button type="button" className="btn" onClick={() => setCustom(false)}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={!picked || busy} onClick={() => picked && void save(picked)}>
              Salvar
            </button>
          </>
        ) : undefined
      }
    >
      {reminder && (
        <div className="reminder-current">
          <span>
            {reminder.firedAt ? 'Lembrete avisado' : 'Lembrete marcado para'} {whenText(reminder.firedAt ?? reminder.remindAt, now)}.
          </span>
          <button type="button" className="btn ghost danger small" disabled={busy} onClick={() => void remove()}>
            Remover lembrete
          </button>
        </div>
      )}
      {custom ? (
        <Field label="Data e hora">
          <input type="datetime-local" value={value} min={toLocalInput(new Date(Date.now() + AHEAD_MIN_MS))} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
      ) : (
        <div className="time-presets" role="list">
          {reminderPresets(now).map((p) => (
            <button key={p.key} type="button" role="listitem" className="time-preset" disabled={busy} onClick={() => void save(p.at)}>
              <span>{p.label}</span>
              <span className="muted">{whenText(p.at.toISOString(), now)}</span>
            </button>
          ))}
          <button type="button" role="listitem" className="time-preset" onClick={() => setCustom(true)}>
            <span>Escolher data e hora…</span>
          </button>
        </div>
      )}
    </Modal>
  );
}
