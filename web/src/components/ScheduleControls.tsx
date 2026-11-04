import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Room, ScheduledMessage } from '@shared/index';
import { AHEAD_MIN_MS, aheadError } from '@shared/messages';
import { api, errorMessage } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { fromLocalInput, schedulePresets, toLocalInput, whenText } from '../lib/messageTimes';
import { plural } from '../lib/format';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { useIsPhone } from './overlay';
import { confirmDialog, Empty, Field, Menu, Modal } from './ui';

// Envio agendado: a seta ao lado de Enviar (desktop), a folha do toque longo (celular), o modal de data e hora, a faixa
// do compositor e o painel "Mensagens agendadas". Só quem agendou vê as suas.

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const tz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
};

// Os atalhos de horário e "Escolher data e hora…", para o menu da seta e para a folha do celular.
export function ScheduleItems({ onPick, onCustom, close, sheetRole }: { onPick: (at: Date) => void; onCustom: () => void; close: () => void; sheetRole?: boolean }) {
  const now = new Date();
  return (
    <>
      {schedulePresets(now).map((p) => (
        <button key={p.key} type="button" role={sheetRole ? 'menuitem' : undefined} className="time-preset-item" onClick={() => (close(), onPick(p.at))}>
          <span>{p.label}</span>
          <span className="muted">{whenText(p.at.toISOString(), now)}</span>
        </button>
      ))}
      <hr />
      <button type="button" role={sheetRole ? 'menuitem' : undefined} onClick={() => (close(), onCustom())}>
        <Icon name="schedule" size={16} />
        Escolher data e hora…
      </button>
    </>
  );
}

// Desktop: botão colado à direita do Enviar.
export function ScheduleArrow({ onPick, onCustom }: { onPick: (at: Date) => void; onCustom: () => void }) {
  return (
    <Menu
      label="Agendar envio"
      sheetTitle="Agendar envio"
      placement="top-end"
      className="schedule-menu"
      trigger={
        <button type="button" className="btn primary send-more" aria-label="Agendar envio" title="Agendar envio">
          <Icon name="chevron-down" size={14} />
        </button>
      }
    >
      {(close) => <ScheduleItems onPick={onPick} onCustom={onCustom} close={close} />}
    </Menu>
  );
}

// Agendar com data e hora à escolha, ou editar uma agendada (texto e horário).
export function ScheduleModal({
  editing,
  ackLabel,
  onSubmit,
  onClose,
}: {
  editing?: ScheduledMessage;
  ackLabel?: string; // "Pede “Ciente”" / "Sem “Ciente”", como veio do compositor
  onSubmit: (v: { at: Date; msg?: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState(editing?.msg ?? '');
  const [value, setValue] = useState(() => toLocalInput(editing ? new Date(editing.sendAt) : new Date(Date.now() + 3600_000)));
  const [busy, setBusy] = useState(false);
  const at = fromLocalInput(value);
  const err = at ? aheadError(at.toISOString(), new Date()) : 'Escolha a data e a hora.';
  const submit = async () => {
    if (!at || err || busy || (editing && !msg.trim())) return;
    setBusy(true);
    const ok = await onSubmit({ at, msg: editing ? msg : undefined });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title={editing ? 'Editar mensagem agendada' : 'Agendar envio'}
      onClose={onClose}
      className="schedule-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!!err || busy || (!!editing && !msg.trim())} onClick={() => void submit()}>
            {editing ? 'Salvar' : 'Agendar'}
          </button>
        </>
      }
    >
      {editing && (
        <Field label="Mensagem">
          <textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} />
        </Field>
      )}
      <Field label="Data e hora" hint={`Fuso deste aparelho: ${tz()}`} error={at && err ? err : undefined}>
        <input type="datetime-local" value={value} min={toLocalInput(new Date(Date.now() + AHEAD_MIN_MS))} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {ackLabel && <p className="muted small">{ackLabel}</p>}
    </Modal>
  );
}

// Faixa acima do compositor: quantas agendadas nesta conversa.
export function ScheduledStrip({ rid, onOpen }: { rid: string; onOpen: () => void }) {
  const count = useStore((s) => s.scheduled.filter((x) => x.rid === rid).length);
  if (!count) return null;
  return (
    <div className="composer-bar scheduled">
      <Icon name="schedule" size={14} />
      <span className="composer-bar-text">{count === 1 ? '1 mensagem agendada nesta conversa' : `${plural(count, 'mensagem agendada', 'mensagens agendadas')} nesta conversa`}</span>
      <button type="button" className="btn ghost small" onClick={onOpen}>
        Ver
      </button>
    </div>
  );
}

// Painel "Mensagens agendadas" da sala.
export function ScheduledPanel({ room }: { room: Room }) {
  // O seletor devolve a lista do store (referência estável); o filtro fica fora dele, senão cada leitura seria um
  // array novo e o React entraria em laço.
  const all = useStore((s) => s.scheduled);
  const list = useMemo(() => all.filter((x) => x.rid === room._id), [all, room._id]);
  const me = useStore((s) => s.me)!;
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const now = new Date();
  const store = useStore.getState;

  const sendNow = async (s: ScheduledMessage) => {
    try {
      await api.post('chat.sendScheduledMessageNow', { scheduledId: s._id });
      store().removeScheduled(s._id);
      store().toast('Mensagem enviada.', 'success');
    } catch (e) {
      fail(e);
    }
  };
  const cancel = async (s: ScheduledMessage) => {
    const ok = await confirmDialog({ title: 'Cancelar este agendamento?', body: 'A mensagem não será enviada.', confirmLabel: 'Cancelar agendamento', cancelLabel: 'Manter', danger: true });
    if (!ok) return;
    try {
      await api.post('chat.cancelScheduledMessage', { scheduledId: s._id });
      store().removeScheduled(s._id);
    } catch (e) {
      fail(e);
    }
  };
  const save = async (s: ScheduledMessage, v: { at: Date; msg?: string }) => {
    try {
      const r = await api.post('chat.updateScheduledMessage', { scheduledId: s._id, msg: v.msg, sendAt: v.at.toISOString() });
      store().upsertScheduled(r.scheduled);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  if (!list.length)
    return (
      <Empty icon="panel-scheduled" title="Nenhuma mensagem agendada">
        {phone ? 'Escreva a mensagem e segure o botão Enviar.' : 'Escreva a mensagem e use a seta ao lado de Enviar.'}
      </Empty>
    );
  return (
    <>
      <ul className="scheduled-list">
        {list.map((s) => (
          <li key={s._id} className={`scheduled-item ${s.status}`}>
            <div className="scheduled-top">
              <span className="scheduled-when">{whenText(s.sendAt, now)}</span>
              {s.tmid && (
                <button type="button" className="pill" onClick={() => navigate(`/${room.t === 'd' ? 'direct' : room.t === 'p' ? 'group' : 'channel'}/${room._id}/thread/${s.tmid}`)}>
                  No tópico
                </button>
              )}
              {s.ackRequired && <span className="pill">Pede “Ciente”</span>}
              {s.status === 'sending' && <span className="pill">Enviando…</span>}
              {s.status === 'failed' && <span className="pill err">Não enviada</span>}
              <span className="spacer" />
              <Menu
                label="Mais ações"
                trigger={
                  <button type="button" className="icon-btn" aria-label="Mais ações" title="Mais ações" disabled={s.status === 'sending'}>
                    <Icon name="more" size={16} />
                  </button>
                }
              >
                {(close) => (
                  <>
                    <button type="button" onClick={() => (close(), setEditing(s))}>
                      <Icon name="edit" size={16} />
                      Editar
                    </button>
                    <button type="button" onClick={() => (close(), void sendNow(s))}>
                      <Icon name="send" size={16} />
                      Enviar agora
                    </button>
                    <hr />
                    <button type="button" className="danger" onClick={() => (close(), void cancel(s))}>
                      <Icon name="delete" size={16} />
                      Cancelar agendamento
                    </button>
                  </>
                )}
              </Menu>
            </div>
            <div className="scheduled-text">{renderMarkdown(s.msg, { me: me.username, mentions: [], channels: [] })}</div>
            {s.error && <div className="scheduled-error">{s.error}</div>}
          </li>
        ))}
      </ul>
      {editing && <ScheduleModal editing={editing} onSubmit={(v) => save(editing, v)} onClose={() => setEditing(null)} />}
    </>
  );
}
