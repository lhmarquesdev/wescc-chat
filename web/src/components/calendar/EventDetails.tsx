// Detalhes de um evento: quando, onde, o link da reunião, quem vai, responder ao convite, editar e cancelar.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AttendeeResponse, CalendarEvent } from '@shared/calendar';
import { PROVIDER_LABEL, RESPONSE_LABEL } from '@shared/calendar';
import { errorMessage } from '../../lib/api';
import { calendarApi, reminderLabel, whenLabel } from '../../lib/calendar';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { confirmDialog, Modal, UserAvatar } from '../ui';
import './calendar.css';

const RESPONSE_ICON: Record<AttendeeResponse, IconName> = { accepted: 'check', declined: 'close', tentative: 'cal-time', pending: 'cal-reminder' };

function Row({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <div className="cal-detail-row">
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function EventDetails({ event, onClose, onEdit, onChanged }: { event: CalendarEvent; onClose: () => void; onEdit: () => void; onChanged: (e: CalendarEvent | null) => void }) {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const external = event.source !== 'chat';
  const counts = event.attendees.reduce<Record<AttendeeResponse, number>>((a, x) => ((a[x.response] += 1), a), { accepted: 0, declined: 0, tentative: 0, pending: 0 });

  const respond = async (r: 'accepted' | 'declined' | 'tentative') => {
    setBusy(r);
    try {
      onChanged(await calendarApi.respond(event._id, r));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    const ok = await confirmDialog({
      title: event.meeting ? 'Cancelar a reunião?' : 'Cancelar o evento?',
      body: event.attendees.length ? 'Os convidados são avisados e o evento sai da agenda de todos.' : 'O evento sai da sua agenda.',
      confirmLabel: event.meeting ? 'Cancelar reunião' : 'Cancelar evento',
      cancelLabel: 'Voltar',
      danger: true,
    });
    if (!ok) return;
    setBusy('cancel');
    try {
      await calendarApi.cancel(event._id);
      toast(event.meeting ? 'Reunião cancelada.' : 'Evento cancelado.', 'success');
      onChanged(null);
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!event.meeting) return;
    try {
      await navigator.clipboard.writeText(event.meeting.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Não foi possível copiar.', 'error');
    }
  };

  const canRespond = event.myResponse !== 'organizer' && !external;
  const meetPath = event.meeting ? `/meet/${event.meeting.code}` : null;

  return (
    <Modal
      title={event.title}
      onClose={onClose}
      className="cal-details"
      description={external ? `Do ${PROVIDER_LABEL[event.source as 'google' | 'microsoft']} · só leitura aqui` : event.meeting ? 'Reunião do chat' : undefined}
      footer={
        event.canEdit ? (
          <>
            <button type="button" className="btn ghost danger" disabled={!!busy} aria-busy={busy === 'cancel' || undefined} onClick={() => void cancel()}>
              {event.meeting ? 'Cancelar reunião' : 'Cancelar evento'}
            </button>
            <button type="button" className="btn" onClick={onEdit}>
              <Icon name="edit" />
              Editar
            </button>
          </>
        ) : undefined
      }
    >
      <div className="cal-detail">
        <Row icon="cal-time">
          <strong>{whenLabel(event)}</strong>
          {event.reminderMinutes !== null && !external && <small className="muted">Lembrete: {reminderLabel(event.reminderMinutes)}</small>}
        </Row>

        {event.meeting && (
          <div className="cal-meet-box">
            <div className="cal-meet-link">
              <Icon name="cal-meeting" size={18} />
              <span className="ellipsis" title={event.meeting.url}>
                {event.meeting.url.replace(/^https?:\/\//, '')}
              </span>
              <button type="button" className="icon-btn" aria-label={copied ? 'Copiado' : 'Copiar link'} title={copied ? 'Copiado' : 'Copiar link'} onClick={() => void copy()}>
                <Icon name={copied ? 'check' : 'copy'} size={16} />
              </button>
            </div>
            <button type="button" className="btn primary" onClick={() => (onClose(), navigate(meetPath!))}>
              <Icon name="meeting-join" />
              Entrar na reunião
            </button>
          </div>
        )}
        {external && event.externalJoinUrl && (
          <a className="btn primary cal-ext-join" href={event.externalJoinUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="meeting-join" />
            Entrar na chamada
          </a>
        )}

        {event.location && <Row icon="cal-location">{event.location}</Row>}
        {event.description && (
          <Row icon="info">
            <p className="cal-desc">{event.description}</p>
          </Row>
        )}

        {!external && (
          <Row icon="cal-people">
            <span className="muted small">
              {event.attendees.length
                ? `Organizado por ${event.owner.name || event.owner.username} · ${counts.accepted} vão${counts.tentative ? ` · ${counts.tentative} talvez` : ''}${counts.declined ? ` · ${counts.declined} não vão` : ''}${counts.pending ? ` · ${counts.pending} sem resposta` : ''}`
                : `Organizado por ${event.owner.name || event.owner.username}`}
            </span>
            {event.attendees.length > 0 && (
              <ul className="cal-people">
                <li>
                  <UserAvatar username={event.owner.username} size={24} />
                  <span className="ellipsis">{event.owner.name || event.owner.username}</span>
                  <span className="pill small">Organizador</span>
                </li>
                {event.attendees.map((a) => (
                  <li key={a._id}>
                    <UserAvatar username={a.username} size={24} />
                    <span className="ellipsis">{a.name || a.username}</span>
                    <span className={`cal-resp ${a.response}`} title={RESPONSE_LABEL[a.response]}>
                      <Icon name={RESPONSE_ICON[a.response]} size={14} />
                      {RESPONSE_LABEL[a.response]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}

        {external && event.externalUrl && (
          <a className="btn small cal-open-ext" href={event.externalUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="cal-open" />
            Abrir no {PROVIDER_LABEL[event.source as 'google' | 'microsoft']}
          </a>
        )}

        {canRespond && (
          <div className="cal-rsvp" role="group" aria-label="Sua resposta">
            <span className="field-label">Você vai?</span>
            <div className="cal-rsvp-btns">
              {(['accepted', 'tentative', 'declined'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={event.myResponse === r ? `btn small on ${r}` : 'btn small'}
                  aria-pressed={event.myResponse === r}
                  aria-busy={busy === r || undefined}
                  disabled={!!busy}
                  onClick={() => void respond(r)}
                >
                  <Icon name={RESPONSE_ICON[r]} size={14} />
                  {r === 'accepted' ? 'Vou' : r === 'tentative' ? 'Talvez' : 'Não vou'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
