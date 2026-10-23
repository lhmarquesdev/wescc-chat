import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Call } from '@shared/index';
import { api } from '../lib/api';
import { startCall } from '../lib/calls';
import { formatDateTime, formatDay, formatDuration, formatTime } from '../lib/format';
import { realtime } from '../lib/realtime';
import { useSetting, useStore } from '../lib/store';
import { Icon, type IconName } from '../components/Icon';
import { Empty, Pager, Segmented, Skeleton, UserAvatar, useAsync, useDelay } from '../components/ui';

const COUNT = 50;
// Com filtro, o servidor não filtra: vêm as últimas chamadas de uma vez e a página é feita aqui.
const FILTER_WINDOW = 500;

const STATUS: Record<string, string> = { ended: '', missed: 'não atendida', declined: 'recusada', canceled: 'cancelada', busy: 'ocupado', ringing: 'tocando', ongoing: 'em andamento' };

type Filter = 'all' | 'missed' | 'received' | 'made';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'missed', label: 'Perdidas' },
  { id: 'received', label: 'Recebidas' },
  { id: 'made', label: 'Feitas' },
];
const FILTER_EMPTY: Record<Exclude<Filter, 'all'>, [string, string]> = {
  missed: ['Nenhuma chamada perdida', 'As chamadas que você não atender aparecem aqui.'],
  received: ['Nenhuma chamada recebida', 'As chamadas que você atender aparecem aqui.'],
  made: ['Nenhuma chamada feita', 'Abra uma conversa direta e use Chamada de voz ou Chamada de vídeo.'],
};

// Perdida é a recebida que não foi atendida (não atendida, ocupado, recusada ou desistência de quem ligou),
// como na conversa, onde todas viram "Chamada perdida". Recebida é a atendida.
function direction(c: Call, me: string) {
  const outgoing = c.caller._id === me;
  const answered = c.duration != null || c.status === 'ongoing' || c.status === 'ended';
  const missed = !outgoing && !answered && c.status !== 'ringing';
  return { outgoing, missed, other: outgoing ? c.callee : c.caller };
}

// Histórico de chamadas da pessoa (feitas e recebidas), agrupado por dia.
export function CallsPage() {
  const me = useStore((s) => s.me)!;
  const enabled = useSetting<boolean>('Calls_Enabled');
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const all = filter === 'all';
  const { data, loading, error, reload } = useAsync(
    () => api.get('calls.list', all ? { offset, count: COUNT } : { offset: 0, count: FILTER_WINDOW }) as Promise<{ calls: Call[]; total: number }>,
    [all ? offset : -1],
  );
  // Quem pode ligar depende dos papéis das duas pessoas e da regra de conversas diretas: quando mudam, busca de novo.
  const people = data ? data.calls.map((c) => `${c.caller._id},${c.callee._id}`).join(',') : '';
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (
        ev.type === 'permissions.changed' ||
        (ev.type === 'user' && ev.user.roles && (ev.user._id === me._id || people.split(',').includes(ev.user._id))) ||
        (ev.type === 'settings.changed' && ev.settings.some((s) => s._id === 'Direct_Restriction_Scope'))
      )
        reload();
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, me._id]);

  const filtered = useMemo(() => {
    if (!data) return null;
    if (all) return { calls: data.calls, total: data.total };
    const calls = data.calls.filter((c) => {
      const d = direction(c, me._id);
      return filter === 'made' ? d.outgoing : filter === 'missed' ? d.missed : !d.outgoing && !d.missed;
    });
    return { calls: calls.slice(offset, offset + COUNT), total: calls.length };
  }, [data, all, filter, offset, me._id]);
  const days = useMemo(() => {
    const out: { day: string; calls: Call[] }[] = [];
    for (const c of filtered?.calls ?? []) {
      const day = formatDay(c.createdAt);
      const last = out[out.length - 1];
      if (last?.day === day) last.calls.push(c);
      else out.push({ day, calls: [c] });
    }
    return out;
  }, [filtered]);
  const pick = (f: Filter) => (setFilter(f), setOffset(0));

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
  else if (!filtered?.calls.length)
    body = all ? (
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
          Abra uma conversa direta e use Chamada de voz ou Chamada de vídeo.
        </Empty>
      </div>
    ) : (
      <div className="card call-empty">
        <Empty
          icon="calls-empty"
          title={FILTER_EMPTY[filter as Exclude<Filter, 'all'>][0]}
          action={
            <button type="button" className="btn" onClick={() => pick('all')}>
              Mostrar todas
            </button>
          }
        >
          {FILTER_EMPTY[filter as Exclude<Filter, 'all'>][1]}
        </Empty>
      </div>
    );
  else
    body = days.map((g) => (
      <section key={g.day} className="call-day">
        <h2 className="call-day-title">{g.day}</h2>
        <ul className="call-list">
          {g.calls.map((c) => (
            <CallRow key={c._id} c={c} me={me._id} enabled={!!enabled} onOpen={() => navigate(`/direct/${c.rid}`)} />
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
          <Segmented label="Filtrar chamadas" value={filter} onChange={pick} items={FILTERS} />
          {body}
          {filtered && <Pager offset={offset} count={COUNT} total={filtered.total} onChange={setOffset} />}
        </div>
      </div>
    </div>
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

function CallRow({ c, me, enabled, onOpen }: { c: Call; me: string; enabled: boolean; onOpen: () => void }) {
  const { outgoing, missed, other } = direction(c, me);
  const name = other.name || other.username;
  const dir: [IconName, string] = outgoing ? ['call-outgoing', 'Feita'] : missed ? ['call-missed', 'Perdida'] : ['call-incoming', 'Recebida'];
  // "Perdida · não atendida" (ou "· cancelada", quando quem ligou desistiu) diria a mesma coisa duas vezes.
  const extra = c.duration != null ? formatDuration(c.duration) : missed && (c.status === 'missed' || c.status === 'canceled') ? '' : STATUS[c.status];
  return (
    <li className={missed ? 'missed' : ''}>
      <button type="button" className="call-list-main" title={formatDateTime(c.createdAt)} onClick={onOpen}>
        <UserAvatar username={other.username} size={40} />
        <span className="call-list-text">
          <strong className="call-list-name">{name}</strong>
          <span className="call-list-meta">
            <Icon name={dir[0]} size={14} />
            <span className="ellipsis">
              {/* No celular o ícone e a cor já dizem a direção: a palavra sai da vista para a duração caber. */}
              <span className="call-dir">{dir[1]} · </span>
              {c.kind === 'video' ? 'Vídeo' : 'Voz'}
              {extra ? ` · ${extra}` : ''}
            </span>
          </span>
        </span>
      </button>
      <time className="call-time" dateTime={c.createdAt}>
        {formatTime(c.createdAt)}
      </time>
      {enabled && (
        <span className="call-list-actions">
          <button
            type="button"
            className={c.kind === 'video' ? 'icon-btn call-alt' : 'icon-btn'}
            title={c.canCall === false ? c.callBlockedReason : 'Chamada de voz'}
            aria-label={c.canCall === false ? c.callBlockedReason : 'Chamada de voz'}
            disabled={c.canCall === false}
            onClick={() => void startCall(c.rid, 'audio')}
          >
            <Icon name="call-audio" size={18} />
          </button>
          <button
            type="button"
            className={c.kind === 'video' ? 'icon-btn' : 'icon-btn call-alt'}
            title={c.canCall === false ? c.callBlockedReason : 'Chamada de vídeo'}
            aria-label={c.canCall === false ? c.callBlockedReason : 'Chamada de vídeo'}
            disabled={c.canCall === false}
            onClick={() => void startCall(c.rid, 'video')}
          >
            <Icon name="call-video" size={18} />
          </button>
        </span>
      )}
    </li>
  );
}
