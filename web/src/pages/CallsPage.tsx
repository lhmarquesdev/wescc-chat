import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Call, CallRoomRef } from '@shared/index';
import { callsRowView, liveCallIcon, liveRowMeta } from '@shared/call-view';
import { api } from '../lib/api';
import { callRoomName, expandCall, isInCall, openJoin, useCallStore } from '../lib/call/store';
import { prefetchSfu, startCall } from '../lib/calls';
import { formatDateTime, formatDay, formatTime, roomIconName, roomPath } from '../lib/format';
import { namesIn } from '../lib/names';
import { realtime } from '../lib/realtime';
import { explainCall, markCallsSeen, useLiveCalls, useMissedCalls, useNow } from '../lib/roomcall';
import { useSetting, useStore } from '../lib/store';
import { Icon, type IconName } from '../components/Icon';
import { Empty, Pager, Segmented, Skeleton, UserAvatar, useAsync, useDelay } from '../components/ui';
import '../components/callroom.css';

const COUNT = 50;

type Filter = 'all' | 'missed' | 'incoming' | 'outgoing';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'missed', label: 'Perdidas' },
  { id: 'incoming', label: 'Recebidas' },
  { id: 'outgoing', label: 'Feitas' },
];
const FILTER_EMPTY: Record<Exclude<Filter, 'all'>, string> = {
  missed: 'Nenhuma chamada perdida.',
  incoming: 'Nenhuma chamada recebida.',
  outgoing: 'Nenhuma chamada feita.',
};

const toast = explainCall;

// Sala da chamada para o ícone, o nome e o link (calls.list e calls.active trazem; a assinatura cobre o resto).
function roomOf(c: Call): CallRoomRef {
  if (c.room) return c.room;
  const sub = useStore.getState().subscriptions[c.rid];
  return { _id: c.rid, t: sub?.t ?? (c.scope === 'direct' ? 'd' : 'c'), name: sub?.name ?? null, fname: sub?.fname ?? null, prid: sub?.prid ?? null, teamMain: sub?.teamMain, notice: sub?.notice };
}

const roomTitle = (r: CallRoomRef) => callRoomName(r) || 'Sala';

// Histórico de chamadas da pessoa (feitas, recebidas e em grupo), agrupado por dia, com as chamadas vivas no alto.
export function CallsPage() {
  const me = useStore((s) => s.me)!;
  const enabled = useSetting<boolean>('Calls_Enabled');
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const { data, loading, error, reload } = useAsync(
    () => api.get('calls.list', { offset, count: COUNT, filter }) as Promise<{ calls: Call[]; total: number }>,
    [offset, filter],
  );

  // Abrir a página zera o selo; uma perdida que chega com a página aberta também já foi vista.
  const missed = useMissedCalls();
  useEffect(() => {
    void markCallsSeen();
  }, []);
  useEffect(() => {
    if (missed > 0) void markCallsSeen();
  }, [missed]);

  // Quem pode ligar depende dos papéis das duas pessoas e da regra de conversas diretas: quando mudam, busca de novo.
  // Uma chamada que termina entra no histórico: a primeira página busca de novo.
  const people = data ? data.calls.flatMap((c) => [c.caller._id, c.callee?._id ?? '']).join(',') : '';
  useEffect(() => {
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(reload, 1000);
    };
    const off = realtime.on((ev) => {
      if (
        ev.type === 'permissions.changed' ||
        (ev.type === 'user' && ev.user.roles && (ev.user._id === me._id || people.split(',').includes(ev.user._id))) ||
        (ev.type === 'settings.changed' && ev.settings.some((s) => s._id === 'Direct_Restriction_Scope'))
      )
        reload();
      else if (offset === 0 && ((ev.type === 'call' && ev.call.status !== 'ongoing' && ev.call.status !== 'ringing') || (ev.type === 'call.room' && !ev.call))) later();
    });
    return () => {
      clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, me._id, offset]);

  const days = useMemo(() => {
    const out: { day: string; calls: Call[] }[] = [];
    for (const c of data?.calls ?? []) {
      const day = formatDay(c.createdAt);
      const last = out[out.length - 1];
      if (last?.day === day) last.calls.push(c);
      else out.push({ day, calls: [c] });
    }
    return out;
  }, [data]);
  const pick = (f: Filter) => (setFilter(f), setOffset(0));
  // Com uma chamada viva logo acima, o histórico vazio não diz "Nenhuma chamada ainda" em destaque.
  const live = useLiveCalls();
  const hasLive = !!enabled && Object.values(live).some((c) => c.scope === 'group' && c.status === 'ongoing');

  let body;
  if (loading && !data) body = <CallsSkeleton />;
  else if (error)
    body = (
      <div className="card call-empty">
        <Empty
          icon="error"
          tone="danger"
          title="Não foi possível carregar as chamadas"
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
  else if (!data?.calls.length)
    body =
      filter === 'all' && hasLive ? (
        <div className="card call-empty">
          <Empty>Nenhuma chamada no histórico.</Empty>
        </div>
      ) : filter === 'all' ? (
        <div className="card call-empty">
          <Empty
            icon="calls-empty"
            title="Nenhuma chamada ainda"
            action={
              <button type="button" className="btn" onClick={() => navigate('/directory')}>
                Abrir diretório
              </button>
            }
          >
            Ligue de uma mensagem direta ou inicie uma chamada em um canal.
          </Empty>
        </div>
      ) : (
        <div className="card call-empty">
          <Empty
            icon="calls-empty"
            title={FILTER_EMPTY[filter]}
            action={
              <button type="button" className="btn" onClick={() => pick('all')}>
                Mostrar todas
              </button>
            }
          />
        </div>
      );
  else
    body = days.map((g) => (
      <section key={g.day} className="call-day">
        <h2 className="call-day-title">{g.day}</h2>
        <ul className="call-list">
          {g.calls.map((c) => (
            <CallRow key={c._id} c={c} me={me._id} enabled={!!enabled} onOpen={() => navigate(roomPath(roomOf(c)))} />
          ))}
        </ul>
      </section>
    ));

  return (
    <div className="page calls-page">
      <header className="page-head">
        <h1>Chamadas</h1>
      </header>
      <div className="page-body">
        <div className="call-history">
          {enabled && <LiveCalls onOpen={(c) => navigate(roomPath(roomOf(c)))} />}
          <Segmented label="Filtrar chamadas" value={filter} onChange={pick} items={FILTERS} />
          {body}
          {data && <Pager offset={offset} count={COUNT} total={data.total} onChange={setOffset} />}
        </div>
      </div>
    </div>
  );
}

// "Em andamento": as chamadas em grupo vivas nas minhas salas, com Entrar, Ouvir ou Na chamada.
function LiveCalls({ onOpen }: { onOpen: (c: Call) => void }) {
  const byRoom = useLiveCalls();
  const tabCall = useCallStore((s) => s.tabCall);
  // A fase muda o botão (Entrar ↔ Na chamada).
  useCallStore((s) => s.phase);
  const list = Object.values(byRoom)
    .filter((c) => c.scope === 'group' && c.status === 'ongoing')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const now = useNow(list.length > 0);
  if (!list.length) return null;
  return (
    <section className="call-day calls-live" aria-labelledby="calls-live-title">
      <h2 className="call-day-title" id="calls-live-title">
        Em andamento
      </h2>
      <ul className="call-list">
        {list.map((c) => {
          const room = roomOf(c);
          const mine = isInCall(c._id) || tabCall?.callId === c._id;
          const text = mine ? 'Na chamada' : c.mine?.listenOnly ? 'Ouvir' : 'Entrar';
          const go = () => {
            if (!mine) return void openJoin(c._id, c.rid);
            if (!isInCall(c._id)) return toast('Chamada em andamento em outra aba.');
            expandCall();
          };
          return (
            <li key={c._id}>
              <button type="button" className="call-list-main" title={roomTitle(room)} onClick={() => onOpen(c)}>
                <span className="calls-room-tile" aria-hidden="true">
                  <Icon name={roomIconName(room)} size={20} />
                </span>
                <span className="call-list-text">
                  <strong className="call-list-name">{roomTitle(room)}</strong>
                  <span className="call-list-meta tabular">
                    <Icon name={liveCallIcon(c)} size={14} />
                    <span className="ellipsis">{liveRowMeta(c, now)}</span>
                  </span>
                </span>
              </button>
              <span className="call-list-actions">
                <button
                  type="button"
                  className={mine ? 'btn small' : 'btn small primary call-join'}
                  title={mine ? 'Abrir a chamada' : undefined}
                  onPointerEnter={() => prefetchSfu()}
                  onFocus={() => prefetchSfu()}
                  onClick={go}
                >
                  {text}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// O esqueleto tem a forma da lista (título do dia, avatar, duas linhas e a hora), mas sem .call-list li,
// que os testes contam.
function CallsSkeleton() {
  const ready = useDelay();
  return (
    <div className="skeleton-group call-skeleton" role="status" aria-label="Carregando" aria-busy="true">
      {ready && (
        <>
          <Skeleton width={72} height={10} className="call-sk-day" />
          <div className="call-sk-list">
            {[46, 38, 52, 42, 34].map((w, i) => (
              <div className="call-sk-row" key={i}>
                <Skeleton circle height={40} />
                <span className="sk-lines">
                  <Skeleton width={`${w}%`} />
                  <Skeleton width={`${w - 14}%`} height={10} />
                </span>
                <Skeleton width={36} height={10} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function dirIcon(c: Call, me: string, missed: boolean): IconName {
  if (c.caller._id === me) return 'call-outgoing';
  if (missed) return 'call-missed';
  if (c.mine?.state === 'declined' || (c.scope === 'direct' && c.status === 'declined')) return 'call-hangup';
  return c.scope === 'group' ? 'call-people' : 'call-incoming';
}

function CallRow({ c, me, enabled, onOpen }: { c: Call; me: string; enabled: boolean; onOpen: () => void }) {
  const room = roomOf(c);
  const v = callsRowView(c, me, roomTitle(room));
  const reasonId = useId();
  const other = c.scope === 'direct' ? (c.caller._id === me ? c.callee : c.caller) : null;
  // A direção vai separada: no celular o ícone e a cor já a dizem, e a palavra fica só para leitores de tela.
  const cut = v.meta.indexOf(' · ');
  const dir = cut < 0 ? v.meta : v.meta.slice(0, cut);
  const rest = cut < 0 ? '' : v.meta.slice(cut + 3);
  const redial = (kind: 'audio' | 'video') => (v.redialReason ? toast(v.redialReason) : void startCall(c.rid, kind));
  return (
    <li className={v.missed ? 'missed' : ''}>
      <button type="button" className="call-list-main" title={`${v.title} · ${formatDateTime(c.createdAt)}`} onClick={onOpen}>
        {other ? (
          <UserAvatar username={other.username} size={40} />
        ) : (
          <span className="calls-room-tile" aria-hidden="true">
            <Icon name={roomIconName(room)} size={20} />
          </span>
        )}
        <span className="call-list-text">
          <strong className="call-list-name">{v.title}</strong>
          <span className="call-list-meta">
            <Icon name={dirIcon(c, me, v.missed)} size={14} />
            <span className="ellipsis">
              <span className="call-dir">
                {dir}
                {rest ? ' · ' : ''}
              </span>
              {rest}
            </span>
          </span>
        </span>
      </button>
      <time className="call-time" dateTime={c.createdAt}>
        {formatTime(c.createdAt)}
      </time>
      {enabled && v.redial && (
        <span className="call-list-actions">
          <button
            type="button"
            className={c.kind === 'video' ? 'icon-btn call-alt' : 'icon-btn'}
            title="Chamada de voz"
            aria-label="Chamada de voz"
            aria-disabled={v.redialReason ? true : undefined}
            aria-describedby={v.redialReason ? reasonId : undefined}
            onClick={() => redial('audio')}
          >
            <Icon name="call-audio" size={18} />
          </button>
          <button
            type="button"
            className={c.kind === 'video' ? 'icon-btn' : 'icon-btn call-alt'}
            title="Chamada de vídeo"
            aria-label="Chamada de vídeo"
            aria-disabled={v.redialReason ? true : undefined}
            aria-describedby={v.redialReason ? reasonId : undefined}
            onClick={() => redial('video')}
          >
            <Icon name="call-video" size={18} />
          </button>
          {v.redialReason && (
            <span id={reasonId} className="visually-hidden">
              {namesIn(v.redialReason)}
            </span>
          )}
        </span>
      )}
      {/* Em grupo não há rediscagem: um vão do mesmo tamanho deixa a hora na coluna das outras linhas (no toque, onde
          as ações ficam à vista). */}
      {enabled && !v.redial && (
        <span className="call-list-actions call-list-gap" aria-hidden="true">
          <span className="icon-btn" />
          <span className="icon-btn call-alt" />
        </span>
      )}
    </li>
  );
}
