// Agenda: mês, semana e lista, com os eventos do chat, os convites e o que vem do Google Agenda e do Outlook.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CalendarEvent } from '@shared/calendar';
import { PROVIDER_LABEL } from '@shared/calendar';
import {
  addDays,
  calendarApi,
  cap,
  eventDays,
  fmtDay,
  fmtTime,
  layoutDay,
  monthFmt,
  monthGrid,
  onDay,
  sameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  useCalendarEvents,
  weekdayShort,
  whenLabel,
} from '../lib/calendar';
import { usePermission, useStore } from '../lib/store';
import { EventDetails } from '../components/calendar/EventDetails';
import { EventEditor, type EditorStart } from '../components/calendar/EventEditor';
import { SyncPanel, useCalendarAccounts } from '../components/calendar/SyncPanel';
import { Icon } from '../components/Icon';
import { useIsPhone } from '../components/overlay';
import { Empty, Segmented, Skeleton } from '../components/ui';
import '../components/calendar/calendar.css';

type View = 'month' | 'week' | 'list';
const VIEW_KEY = 'wescc.calendar.view';
const HOUR_PX = 48;

function readView(phone: boolean): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'month' || v === 'week' || v === 'list') return v;
  } catch {
    // armazenamento indisponível
  }
  return phone ? 'list' : 'week';
}

const MOTIVO: Record<string, string> = {
  negado: 'o acesso não foi autorizado',
  token: 'o fornecedor não liberou o acesso',
  rede: 'o fornecedor não respondeu',
  config: 'a configuração do administrador está incompleta',
  estado: 'o link de conexão venceu; tente de novo',
};

function eventClass(e: CalendarEvent) {
  return ['cal-ev', e.source !== 'chat' && `src-${e.source}`, e.meeting && 'meeting', e.myResponse === 'pending' && 'pending', e.myResponse === 'declined' && 'declined', e.myResponse === 'tentative' && 'tentative']
    .filter(Boolean)
    .join(' ');
}

function sourceTitle(e: CalendarEvent) {
  return e.source === 'chat' ? '' : ` · ${PROVIDER_LABEL[e.source]}`;
}

export function CalendarPage() {
  const phone = useIsPhone();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useStore((s) => s.toast);
  const canMeet = usePermission('create-calendar-meeting');
  const [view, setViewState] = useState<View>(() => readView(phone));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editor, setEditor] = useState<EditorStart | null>(null);
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const { providers, setProviders } = useCalendarAccounts();

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // armazenamento indisponível
    }
  };

  const span = useMemo(() => {
    if (view === 'month') {
      const grid = monthGrid(cursor);
      return { from: grid[0], to: addDays(grid[41], 1) };
    }
    if (view === 'week') {
      const s = startOfWeek(cursor);
      return { from: s, to: addDays(s, 7) };
    }
    return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 45) };
  }, [view, cursor]);
  const { events, error, reload } = useCalendarEvents(span.from, span.to);

  // ?evento=<id> (push, convite) abre o evento; ?integracao=… volta do Google/Microsoft.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (handled.current === location.key) return;
    handled.current = location.key;
    const q = new URLSearchParams(location.search);
    const id = q.get('evento');
    const r = q.get('integracao');
    const p = q.get('agenda');
    if (id) void calendarApi.get(id).then(setOpen).catch(() => toast('Esse evento não existe mais ou não é seu.', 'warning'));
    if (r === 'agenda-ok') toast(`${p === 'microsoft' ? 'Outlook' : 'Google Agenda'} conectado. A primeira sincronização já começou.`, 'success');
    else if (r === 'erro') toast(`Não foi possível conectar (${MOTIVO[q.get('motivo') ?? ''] ?? 'erro inesperado'}).`, 'error');
    if (id || r) navigate({ pathname: location.pathname, search: '' }, { replace: true });
  }, [location.key, location.search, location.pathname, navigate, toast]);

  const move = (dir: -1 | 1) => {
    if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (view === 'week') setCursor(addDays(cursor, 7 * dir));
    else setCursor(addDays(cursor, 30 * dir));
  };
  const title =
    view === 'month'
      ? cap(monthFmt.format(cursor))
      : view === 'week'
        ? (() => {
            const s = startOfWeek(cursor);
            const e = addDays(s, 6);
            if (s.getMonth() === e.getMonth()) return cap(monthFmt.format(s));
            const short = new Intl.DateTimeFormat('pt-BR', { month: 'short' });
            return `${s.getDate()} ${short.format(s)} – ${e.getDate()} ${short.format(e)} de ${e.getFullYear()}`;
          })()
        : 'Próximos eventos';

  const openNew = (init: EditorStart = {}) => setEditor(init);
  const pendingInvites = (events ?? []).filter((e) => e.myResponse === 'pending' && new Date(e.endsAt) > new Date());

  let body;
  if (error && !events)
    body = (
      <div className="card cal-empty">
        <Empty
          icon="error"
          tone="danger"
          title="Não foi possível carregar a agenda"
          action={
            <button type="button" className="btn" onClick={reload}>
              Tentar de novo
            </button>
          }
        >
          {error}
        </Empty>
      </div>
    );
  else if (view === 'month') body = <MonthView month={cursor} events={events} onOpen={setOpen} onDay={(d) => (setCursor(d), setView('week'))} onNew={(d) => openNew({ start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9) })} />;
  else if (view === 'week') body = <WeekView start={startOfWeek(cursor)} events={events} onOpen={setOpen} onNew={(d, allDay) => openNew({ start: d, allDay })} />;
  else body = <ListView from={startOfDay(cursor)} events={events} onOpen={setOpen} onNew={() => openNew()} />;

  return (
    <div className="page cal-page">
      <header className="page-head cal-head">
        <h1>Agenda</h1>
        <div className="cal-head-actions">
          {canMeet && !phone && (
            <button type="button" className="btn" onClick={() => openNew({ meeting: true })}>
              <Icon name="cal-meeting" />
              Nova reunião
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => openNew()}>
            <Icon name="cal-new" />
            {phone ? 'Novo' : 'Novo evento'}
          </button>
        </div>
      </header>
      <div className="cal-layout">
        <div className="cal-main">
          <div className="cal-toolbar">
            <div className="cal-nav">
              <button type="button" className="btn small" onClick={() => setCursor(startOfDay(new Date()))}>
                Hoje
              </button>
              <button type="button" className="icon-btn" aria-label="Anterior" title="Anterior" onClick={() => move(-1)}>
                <Icon name="cal-prev" size={18} />
              </button>
              <button type="button" className="icon-btn" aria-label="Próximo" title="Próximo" onClick={() => move(1)}>
                <Icon name="cal-next" size={18} />
              </button>
              <h2 className="cal-range" aria-live="polite">
                {title}
              </h2>
            </div>
            <Segmented
              label="Visualização"
              value={view}
              onChange={setView}
              items={[
                { id: 'month', label: 'Mês' },
                { id: 'week', label: 'Semana' },
                { id: 'list', label: 'Lista' },
              ]}
            />
          </div>
          {body}
        </div>
        <aside className="cal-side">
          {pendingInvites.length > 0 && (
            <section className="cal-side-card" aria-labelledby="cal-inv-title">
              <h2 id="cal-inv-title">
                <Icon name="cal-reminder" size={16} />
                Convites sem resposta
                <span className="pill small">{pendingInvites.length}</span>
              </h2>
              <ul className="cal-mini-list">
                {pendingInvites.slice(0, 5).map((e) => (
                  <li key={e._id}>
                    <button type="button" onClick={() => setOpen(e)}>
                      <strong className="ellipsis">{e.title}</strong>
                      <small className="muted">
                        {whenLabel(e)} · {e.owner.name || e.owner.username}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <SyncPanel providers={providers} onProviders={setProviders} />
        </aside>
      </div>
      {phone && canMeet && (
        <button type="button" className="cal-fab" aria-label="Nova reunião" title="Nova reunião" onClick={() => openNew({ meeting: true })}>
          <Icon name="cal-meeting" size={22} />
        </button>
      )}
      {editor && (
        <EventEditor
          init={editor}
          onClose={() => setEditor(null)}
          onSaved={(e) => {
            setEditor(null);
            setOpen(e);
            reload();
          }}
        />
      )}
      {open && !editor && (
        <EventDetails
          event={open}
          onClose={() => setOpen(null)}
          onEdit={() => setEditor({ event: open })}
          onChanged={(e) => {
            setOpen(e);
            reload();
          }}
        />
      )}
    </div>
  );
}

// ---------- Mês ----------

function MonthView({ month, events, onOpen, onDay: openDay, onNew }: { month: Date; events: CalendarEvent[] | null; onOpen: (e: CalendarEvent) => void; onDay: (d: Date) => void; onNew: (d: Date) => void }) {
  const days = monthGrid(month);
  const today = new Date();
  const heads = days.slice(0, 7).map((d) => cap(weekdayShort.format(d).replace('.', '')));
  return (
    <div className="cal-month" role="grid" aria-label={cap(monthFmt.format(month))}>
      <div className="cal-month-head" role="row">
        {heads.map((h) => (
          <span key={h} role="columnheader">
            {h}
          </span>
        ))}
      </div>
      <div className="cal-month-grid">
        {days.map((d) => {
          const list = (events ?? []).filter((e) => onDay(e, d));
          const out = d.getMonth() !== month.getMonth();
          return (
            <div key={d.toISOString()} role="gridcell" className={['cal-cell', out && 'out', sameDay(d, today) && 'today'].filter(Boolean).join(' ')} onDoubleClick={() => onNew(d)}>
              <button type="button" className="cal-cell-day" aria-label={fmtDay(d)} onClick={() => openDay(d)}>
                {d.getDate()}
              </button>
              {!events ? (
                d.getDay() % 3 === 0 && <Skeleton height={16} />
              ) : (
                <>
                  {list.slice(0, 3).map((e) => (
                    <button key={e._id} type="button" className={`${eventClass(e)} chip`} title={`${e.title} · ${whenLabel(e)}${sourceTitle(e)}`} onClick={() => onOpen(e)}>
                      {!e.allDay && <span className="tabular">{fmtTime(e.startsAt)}</span>}
                      {e.meeting && <Icon name="cal-meeting" size={12} />}
                      <span className="ellipsis">{e.title}</span>
                    </button>
                  ))}
                  {list.length > 3 && (
                    <button type="button" className="cal-more" onClick={() => openDay(d)}>
                      +{list.length - 3} mais
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Semana ----------

function WeekView({ start, events, onOpen, onNew }: { start: Date; events: CalendarEvent[] | null; onOpen: (e: CalendarEvent) => void; onNew: (d: Date, allDay?: boolean) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = new Date();
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Abre às 7h, ou antes se algum evento da semana começa mais cedo; na semana atual, garante que agora fica à vista.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const thisWeek = days.some((d) => sameDay(d, today));
    const first = Math.min(7, ...(events ?? []).filter((e) => !e.allDay).map((e) => new Date(e.startsAt).getHours()));
    const visible = Math.floor(el.clientHeight / HOUR_PX);
    const h = thisWeek && today.getHours() >= first + visible - 1 ? today.getHours() - 2 : first;
    el.scrollTop = Math.max(0, h * HOUR_PX - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.getTime(), !!events]);

  const allDay = (events ?? []).filter((e) => e.allDay || new Date(e.endsAt).getTime() - new Date(e.startsAt).getTime() >= 24 * 3_600_000);
  const timed = (events ?? []).filter((e) => !allDay.includes(e));
  const hours = Array.from({ length: 24 }, (_, h) => h);

  const clickSlot = (d: Date, ev: React.MouseEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest('.cal-ev')) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2) * 30;
    onNew(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.max(0, Math.min(23 * 60 + 30, minutes))));
  };

  return (
    <div className="cal-week">
      <div className="cal-week-head">
        <span className="cal-gutter" />
        {days.map((d) => (
          <div key={d.toISOString()} className={sameDay(d, today) ? 'cal-week-day today' : 'cal-week-day'}>
            <small>{cap(weekdayShort.format(d).replace('.', ''))}</small>
            <strong>{d.getDate()}</strong>
          </div>
        ))}
      </div>
      <div className="cal-week-allday">
        <span className="cal-gutter muted">dia todo</span>
        {days.map((d) => (
          <div key={d.toISOString()} className="cal-allday-cell" onDoubleClick={() => onNew(d, true)}>
            {allDay
              .filter((e) => onDay(e, d))
              .map((e) => (
                <button key={e._id} type="button" className={`${eventClass(e)} chip`} title={`${e.title} · ${whenLabel(e)}${sourceTitle(e)}`} onClick={() => onOpen(e)}>
                  <span className="ellipsis">{e.title}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="cal-week-body" ref={scroller}>
        <div className="cal-week-grid" style={{ height: 24 * HOUR_PX }}>
          <div className="cal-gutter cal-hours">
            {hours.map((h) => (
              <span key={h} style={{ top: h * HOUR_PX }}>
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </span>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className={sameDay(d, today) ? 'cal-col today' : 'cal-col'} onClick={(ev) => clickSlot(d, ev)}>
              {layoutDay(timed, d).map((p) => (
                <button
                  key={p.e._id}
                  type="button"
                  className={`${eventClass(p.e)} block${p.height >= 90 && p.cols === 1 ? ' tall' : ''}`}
                  style={{
                    top: (p.top / 60) * HOUR_PX,
                    height: Math.max(20, (p.height / 60) * HOUR_PX - 2),
                    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                    width: `calc(${100 / p.cols}% - 4px)`,
                  }}
                  title={`${p.e.title} · ${whenLabel(p.e)}${sourceTitle(p.e)}`}
                  onClick={() => onOpen(p.e)}
                >
                  <strong className="ellipsis">
                    {p.e.meeting && <Icon name="cal-meeting" size={12} />}
                    {p.e.title}
                  </strong>
                  {p.height >= 40 && (
                    <small className="tabular">
                      {fmtTime(p.e.startsAt)}–{fmtTime(p.e.endsAt)}
                    </small>
                  )}
                </button>
              ))}
              {sameDay(d, now) && <span className="cal-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} aria-hidden="true" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Lista ----------

function ListView({ from, events, onOpen, onNew }: { from: Date; events: CalendarEvent[] | null; onOpen: (e: CalendarEvent) => void; onNew: () => void }) {
  if (!events)
    return (
      <div className="cal-list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={56} />
        ))}
      </div>
    );
  const groups: { day: Date; list: CalendarEvent[] }[] = [];
  for (let i = 0; i < 45; i++) {
    const day = addDays(from, i);
    const list = events.filter((e) => onDay(e, day) && (i === 0 || sameDay(eventDays(e).start, day) || e.allDay));
    if (list.length) groups.push({ day, list });
  }
  if (!groups.length)
    return (
      <div className="card cal-empty">
        <Empty
          icon="nav-calendar"
          title="Nada marcado por aqui"
          action={
            <button type="button" className="btn" onClick={onNew}>
              Criar evento
            </button>
          }
        >
          Crie um evento, marque uma reunião ou conecte o Google Agenda e o Outlook ao lado.
        </Empty>
      </div>
    );
  const today = new Date();
  return (
    <div className="cal-list">
      {groups.map((g) => (
        <section key={g.day.toISOString()} className="cal-list-day">
          <h3 className={sameDay(g.day, today) ? 'today' : undefined}>{sameDay(g.day, today) ? `Hoje · ${fmtDay(g.day)}` : fmtDay(g.day)}</h3>
          <ul>
            {g.list.map((e) => (
              <li key={e._id}>
                <button type="button" className={`${eventClass(e)} row`} onClick={() => onOpen(e)}>
                  <span className="cal-list-time tabular">{e.allDay ? 'Dia todo' : `${fmtTime(e.startsAt)}–${fmtTime(e.endsAt)}`}</span>
                  <span className="cal-list-text">
                    <strong className="ellipsis">
                      {e.meeting && <Icon name="cal-meeting" size={14} />}
                      {e.title}
                    </strong>
                    <small className="muted ellipsis">
                      {[
                        e.source !== 'chat' ? PROVIDER_LABEL[e.source] : null,
                        e.location || null,
                        e.myResponse === 'pending' ? `Convite de ${e.owner.name || e.owner.username}` : null,
                        e.myResponse === 'tentative' ? 'Talvez' : null,
                        e.attendees.length ? `${e.attendees.length + 1} pessoas` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
