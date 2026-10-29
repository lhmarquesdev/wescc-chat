// Reunião do Teams: criar agora (modo graph), agendar no Teams (abre o formulário do Teams já preenchido) ou colar
// o link de uma reunião. A reunião aparece na sala como cartão; nunca é "chamada do Teams".
import { useEffect, useMemo, useRef, useState } from 'react';
import { isTeamsMeetingUrl, localIso } from '@shared/integrations';
import { ApiError, errorMessage } from '../../lib/api';
import { settleEphemeralRequest } from '../../lib/ephemeral';
import { roomDisplayName } from '../../lib/format';
import { teamsApi, useIntegrationsMe, type IntegrationModalRequest } from '../../lib/integrations';
import { canWithRoles, useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Field, Modal, Segmented } from '../ui';
import { FormError } from './JiraFieldInputs';
import './integrations.css';

type Way = 'now' | 'schedule' | 'link';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Próxima meia hora cheia: o horário que a pessoa mais escolheria.
function nextSlot(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

export default function MeetingModal({ req, onClose }: { req: IntegrationModalRequest; onClose: () => void }) {
  const me = useIntegrationsMe();
  const rid = req.params?.roomId || req.rid;
  const tmid = req.params?.tmid || req.tmid || null;
  const room = useStore((s) => s.rooms[rid]);
  const sub = useStore((s) => s.subscriptions[rid]);
  const myRoles = useStore((s) => s.me?.roles);
  const graph = me?.msteams.meetings === 'graph';
  const name = roomDisplayName(sub, room);
  const defaultSubject = room?.t === 'd' ? `Reunião com ${name}` : `Reunião em #${name}`;
  const ways = useMemo(
    () => [...(graph ? [{ id: 'now' as Way, label: 'Criar agora' }] : []), { id: 'schedule' as Way, label: 'Agendar no Teams' }, { id: 'link' as Way, label: 'Colar link' }],
    [graph],
  );
  const [way, setWay] = useState<Way>(() => (req.params?.tab === 'schedule' ? 'schedule' : graph ? 'now' : 'link'));
  const [subject, setSubject] = useState(req.params?.subject ?? '');
  const [minutes, setMinutes] = useState(() => me?.msteams.defaultMinutes || 30);
  const slot = useMemo(nextSlot, []);
  const [date, setDate] = useState(() => dateValue(slot));
  const [time, setTime] = useState(() => timeValue(slot));
  const [invite, setInvite] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [roundTrip, setRoundTrip] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const linkRef = useRef<HTMLInputElement>(null);

  // O modo pode chegar depois do primeiro desenho (integrations.me ainda carregando).
  useEffect(() => {
    if (!graph && way === 'now') setWay('link');
  }, [graph, way]);
  useEffect(() => {
    if (way === 'link' && roundTrip) linkRef.current?.focus();
  }, [way, roundTrip]);

  // DM ou grupo privado com até 20 pessoas, e só no modo graph (o convite precisa achar a conta de cada um).
  const small = room?.t === 'd' || (room?.t === 'p' && !room.prid && (room.usersCount ?? 0) <= 20);
  // "Ocultar a lista de membros": sem view-broadcast-member-list o servidor não manda os membros como convidados.
  const listHidden = !!room?.broadcast && !canWithRoles('view-broadcast-member-list', [...(myRoles ?? []), ...(sub?.roles ?? [])]);
  const canInvite = graph && small && !listHidden;
  const durations = DURATIONS.includes(minutes) ? DURATIONS : [...DURATIONS, minutes].sort((a, b) => a - b);
  const untrusted = way === 'now' && me?.msteams.emailTrusted === false;

  const fail = (e: unknown) => {
    setError(errorMessage(e));
    if (e instanceof ApiError && e.errorType === 'error-msteams-policy') setWay('schedule');
  };

  const submit = async () => {
    setError('');
    if (way === 'link') {
      if (!isTeamsMeetingUrl(url)) {
        setUrlError('Cole um link de reunião do Teams.');
        linkRef.current?.focus();
        return;
      }
      setUrlError('');
    }
    setBusy(true);
    try {
      if (way === 'now') {
        await teamsApi.create({ roomId: rid, subject: subject.trim() || defaultSubject, minutes, tmid });
        settleEphemeralRequest(req);
        onClose();
      } else if (way === 'link') {
        await teamsApi.link({ roomId: rid, url: url.trim(), subject: subject.trim() || undefined, tmid });
        settleEphemeralRequest(req);
        onClose();
      } else {
        const start = new Date(`${date}T${time}`);
        if (Number.isNaN(start.getTime())) {
          setError('Informe a data e a hora de início.');
          return;
        }
        const offset = -start.getTimezoneOffset();
        // A aba abre ainda no clique: depois da espera pelo servidor o navegador pode tratá-la como pop-up e bloquear.
        const tab = window.open('', '_blank');
        if (tab) tab.opener = null;
        let r: { url: string; skipped: string[] };
        try {
          r = await teamsApi.scheduleLink({ roomId: rid, subject: subject.trim() || defaultSubject, startsAt: localIso(start, offset), minutes, includeMembers: canInvite && invite });
        } catch (e) {
          tab?.close();
          throw e;
        }
        if (tab) tab.location.href = r.url;
        else window.open(r.url, '_blank', 'noopener');
        // Volta com o link: o Teams só devolve a reunião depois que a pessoa salva lá.
        setSkipped(r.skipped);
        setRoundTrip(true);
        setWay('link');
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const primary = way === 'now' ? 'Criar e enviar' : way === 'schedule' ? 'Abrir no Teams' : 'Enviar na sala';
  const duration = (
    <Field label="Duração">
      <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
        {durations.map((n) => (
          <option key={n} value={n}>
            {n} min
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <Modal
      title="Reunião do Teams"
      variant="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={busy || untrusted} aria-busy={busy || undefined} onClick={() => void submit()}>
            {way === 'schedule' && <Icon name="open-external" size={16} />}
            {primary}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !untrusted) void submit();
        }}
      >
        <Segmented
          label="Como marcar a reunião"
          value={way}
          onChange={(v) => {
            setWay(v);
            setError('');
          }}
          items={ways}
        />
        {way === 'now' && (
          <>
            {untrusted && (
              <div className="callout warn">
                <Icon name="warning" />
                <span>Seu e-mail no chat não foi confirmado pelo administrador. Peça para conferir antes de criar reuniões.</span>
              </div>
            )}
            <Field label="Assunto">
              <input value={subject} maxLength={200} placeholder={defaultSubject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            {duration}
            <div className="field-hint">A reunião é criada no Microsoft 365 em seu nome e o link aparece na sala. Ela não entra na sua agenda do Outlook.</div>
          </>
        )}
        {way === 'schedule' && (
          <>
            <Field label="Assunto">
              <input value={subject} maxLength={200} placeholder={defaultSubject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <div className="two-col">
              <Field label="Data">
                <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Início">
                <input type="time" value={time} required step={300} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            {duration}
            {canInvite && (
              <label className="check">
                <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
                Convidar as pessoas desta conversa
              </label>
            )}
            <div className="field-hint">O Teams abre com o formulário preenchido.</div>
          </>
        )}
        {way === 'link' && (
          <>
            {roundTrip && (
              <div className="callout info">
                <Icon name="info" />
                <span>Depois de salvar no Teams, copie o link da reunião e cole aqui.</span>
              </div>
            )}
            {roundTrip && skipped.length > 0 && <div className="field-hint">Sem convite: {skipped.join(', ')} (conta do Microsoft 365 não encontrada).</div>}
            <Field label="Link da reunião" error={urlError || undefined}>
              <input
                ref={linkRef}
                value={url}
                inputMode="url"
                autoComplete="off"
                placeholder="https://teams.microsoft.com/l/meetup-join/…"
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlError) setUrlError('');
                }}
              />
            </Field>
            <Field label="Assunto (opcional)">
              <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </Field>
          </>
        )}
        {error && <FormError>{error}</FormError>}
      </form>
    </Modal>
  );
}
