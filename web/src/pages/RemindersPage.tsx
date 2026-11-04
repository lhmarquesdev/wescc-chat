import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageReminder } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { roomIconName } from '../lib/format';
import { authorName, messageLink } from '../lib/messageRules';
import { reminderPresets, whenText } from '../lib/messageTimes';
import { useNames } from '../lib/names';
import { useStore } from '../lib/store';
import { Icon } from '../components/Icon';
import { messagePreview } from '../components/MessageNotices';
import { TakeoverHead } from '../components/Sidebar';
import { Empty, Menu } from '../components/ui';

// "Lembretes": os avisados (Agora) e os próximos. Só a própria pessoa vê os seus.
export function RemindersPage() {
  const reminders = useStore((s) => s.reminders);
  const subs = useStore((s) => s.subscriptions);
  const navigate = useNavigate();
  useNames();
  const [, tick] = useState(0);
  // Abre buscando de novo (a retenção ou outra aba pode ter mudado a lista) e o relógio do "hoje às" anda.
  useEffect(() => {
    void api
      .get('reminders.list')
      .then((r) => useStore.getState().setReminders(r.reminders))
      .catch(() => {});
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = new Date();
  const fired = reminders.filter((r) => r.firedAt).sort((a, b) => b.firedAt!.localeCompare(a.firedAt!));
  const next = reminders.filter((r) => !r.firedAt).sort((a, b) => a.remindAt.localeCompare(b.remindAt));
  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

  const remove = async (r: MessageReminder) => {
    try {
      await api.post('reminders.delete', { reminderId: r._id });
      useStore.getState().removeReminder(r._id);
    } catch (e) {
      fail(e);
    }
  };
  const snooze = async (r: MessageReminder, at: Date) => {
    try {
      const res = await api.post('reminders.set', { messageId: r.messageId, remindAt: at.toISOString() });
      useStore.getState().upsertReminder(res.reminder);
      useStore.getState().toast(`Lembrete marcado para ${whenText(res.reminder.remindAt, new Date())}.`, 'success', { icon: 'remind' });
    } catch (e) {
      fail(e);
    }
  };
  const snoozeOptions = reminderPresets(now).filter((p) => p.key !== '3h');

  // O ícone ao lado já diz o tipo (canal, grupo, conversa direta): aqui só o nome.
  const roomLabel = (r: MessageReminder) => {
    const sub = subs[r.rid];
    if (r.roomName) return r.roomName;
    if (sub) return sub.fname || sub.name;
    return r.t === 'd' ? 'Conversa direta' : 'Conversa';
  };

  const item = (r: MessageReminder, isFired: boolean) => {
    const sub = subs[r.rid];
    const m = r.message;
    const path = messageLink({ rid: r.rid, t: r.t, mid: r.messageId, tmid: m?.tmid });
    return (
      <li key={r._id} className={`reminder-item ${isFired ? 'fired' : ''}`}>
        <div className="reminder-top">
          <Icon name={roomIconName(sub ?? { t: r.t })} size={14} />
          <span className="reminder-room">{roomLabel(r)}</span>
          <span className="muted small">{isFired ? `Avisou ${whenText(r.firedAt!, now)}` : whenText(r.remindAt, now)}</span>
        </div>
        {m ? (
          <div className="reminder-preview">
            <strong>{authorName(m)}</strong> {messagePreview(m)}
          </div>
        ) : (
          <div className="reminder-preview muted">Mensagem apagada ou sem acesso.</div>
        )}
        <div className="reminder-actions">
          {m && (
            <button type="button" className="btn small" onClick={() => navigate(path)}>
              Abrir
            </button>
          )}
          {m && isFired && (
            <button type="button" className="btn small primary" onClick={() => void remove(r)}>
              <Icon name="check" size={14} />
              Concluir
            </button>
          )}
          {m && (
            <Menu
              label="Adiar"
              sheetTitle="Adiar"
              trigger={
                <button type="button" className="btn small ghost">
                  Adiar
                </button>
              }
            >
              {(close) => (
                <>
                  {snoozeOptions.map((p) => (
                    <button key={p.key} type="button" onClick={() => (close(), void snooze(r, p.at))}>
                      {p.label}
                    </button>
                  ))}
                  {isFired && (
                    <>
                      <hr />
                      <button type="button" className="danger" onClick={() => (close(), void remove(r))}>
                        Remover
                      </button>
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
          {(!isFired || !m) && (
            <button type="button" className="btn small ghost danger" onClick={() => void remove(r)}>
              Remover
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="page reminders-page">
      <TakeoverHead title="Lembretes" />
      <header className="page-head">
        <h1>Lembretes</h1>
      </header>
      <div className="page-body">
        {!reminders.length ? (
          <Empty icon="nav-reminders" title="Nenhum lembrete">
            No menu de uma mensagem, escolha “Lembrar-me” para ser avisado depois.
          </Empty>
        ) : (
          <>
            {fired.length > 0 && (
              <section>
                <h2 className="reminders-h">Agora</h2>
                <ul className="reminder-list">{fired.map((r) => item(r, true))}</ul>
              </section>
            )}
            {next.length > 0 && (
              <section>
                <h2 className="reminders-h">Próximos</h2>
                <ul className="reminder-list">{next.map((r) => item(r, false))}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
