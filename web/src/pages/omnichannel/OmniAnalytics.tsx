import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { formatDuration } from '../../lib/format';
import { Icon, type IconName } from '../../components/Icon';
import { useIsPhone } from '../../components/overlay';
import { Empty, SkeletonStats, useAsync } from '../../components/ui';
import { Bars } from '../admin/AdminEngagement';

export function duration(sec: number) {
  return sec ? formatDuration(sec) : '—';
}

function Stat({ value, label, icon }: { value: ReactNode; label: string; icon?: IconName }) {
  return (
    <div className="stat">
      <div className={value === '—' ? 'stat-value muted' : 'stat-value'}>{value}</div>
      <div className="stat-label">
        {icon && <Icon name={icon} size={16} />}
        {label}
      </div>
    </div>
  );
}

function Realtime() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  const { data } = useAsync(() => api.get('livechat/analytics/realtime'), [tick]);
  return (
    <section className="card omni-live" aria-label="Agora">
      <div className="card-head">
        <h2>
          <span className="omni-live-dot" aria-hidden="true" />
          Agora
        </h2>
        <span className="omni-live-note">Atualiza a cada 15 s</span>
      </div>
      {!data ? (
        <SkeletonStats n={6} />
      ) : (
        <div className="stats">
          <Stat icon="queue" value={data.chats.queued} label="Na fila" />
          <Stat icon="conversations" value={data.chats.open} label="Em atendimento" />
          <Stat icon="on-hold" value={data.chats.onhold} label="Em espera" />
          <Stat icon="wait-time" value={duration(data.chats.longest_wait)} label="Maior espera na fila" />
          <Stat icon="panel-members" value={`${data.agents.available}/${data.agents.total}`} label="Agentes disponíveis" />
          <Stat icon="room-livechat" value={data.agents.online} label="Agentes online" />
        </div>
      )}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  if (!rows.length) return <Empty>Sem dados no período.</Empty>;
  return (
    <table className="table omni-report">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={i ? 'num' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={j ? 'num' : 'ellipsis-cell'} title={!j && typeof c === 'string' ? c : undefined}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OmniAnalytics() {
  const phone = useIsPhone();
  const [days, setDays] = useState(30);
  const [departmentId, setDepartmentId] = useState('');
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const deps = useAsync(() => api.get('livechat/department', { count: 200 }), []);
  const { data, loading } = useAsync(
    () => api.get('livechat/analytics/overview', { start, end, ...(departmentId ? { departmentId } : {}) }),
    [start, end, departmentId],
  );
  return (
    <>
      <div className="page-title-row">
        <h1>Relatórios</h1>
        <div className="filters omni-period">
          <select aria-label="Departamento" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            {/* No celular o seletor tem meia linha: sem filtro, mostra o nome do filtro. */}
            <option value="">{phone ? 'Departamento' : 'Todos os departamentos'}</option>
            {(deps.data?.departments ?? []).map((d: any) => (
              <option key={d._id} value={d._id}>
                {d.name}
              </option>
            ))}
          </select>
          <select aria-label="Período" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Hoje</option>
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </div>
      </div>
      <Realtime />
      <h2 className="omni-period-title">No período</h2>
      {loading || !data ? (
        <SkeletonStats n={7} />
      ) : (
        <>
          <div className="stats">
            <Stat icon="conversations" value={data.totals.conversations} label="Conversas" />
            <Stat icon="sys-closed" value={data.totals.closed} label="Encerradas" />
            <Stat icon="wait-time" value={duration(data.totals.avg_wait)} label="Espera média" />
            <Stat icon="reply-thread" value={duration(data.totals.avg_first_response)} label="Primeira resposta média" />
            <Stat icon="retention" value={duration(data.totals.avg_duration)} label="Duração média" />
            <Stat icon="warning" value={data.totals.sla_breached} label="SLA violado" />
            <Stat
              icon="rating"
              value={data.totals.satisfaction ? `${data.totals.satisfaction.toFixed(1).replace('.', ',')} / 5` : '—'}
              label="Satisfação"
            />
          </div>
          {!data.totals.conversations ? (
            <div className="card omni-empty">
              <Empty icon="reports" title="Sem dados no período">
                Escolha outro período ou departamento.
              </Empty>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="card-head">
                  <h2>Conversas por dia</h2>
                </div>
                <Bars data={data.byDay.map((d: any) => ({ x: d.day.slice(8, 10) + '/' + d.day.slice(5, 7), y: d.conversations }))} />
              </div>
              <div className="grid-2 omni-grid">
                <div className="card">
                  <div className="card-head">
                    <h2>Conversas por hora</h2>
                  </div>
                  <Bars data={Array.from({ length: 24 }, (_, h) => ({ x: `${h}h`, y: data.byHour.find((b: any) => b.hour === h)?.conversations ?? 0 }))} />
                </div>
                <div className="card omni-flush">
                  <div className="card-head">
                    <h2>Por departamento</h2>
                  </div>
                  <Table head={['Departamento', 'Conversas']} rows={data.byDepartment.map((d: any) => [d.name, d.conversations])} />
                </div>
              </div>
              <div className="grid-2 omni-grid">
                <div className="card omni-flush">
                  <div className="card-head">
                    <h2>Por agente</h2>
                  </div>
                  <Table
                    head={['Agente', 'Conversas', '1ª resposta', 'Duração']}
                    rows={data.byAgent.map((a: any) => [a.name || '@' + a.username, a.conversations, duration(a.avg_first_response), duration(a.avg_duration)])}
                  />
                </div>
                <div className="card omni-flush">
                  <div className="card-head">
                    <h2>Por tag</h2>
                  </div>
                  <Table head={['Tag', 'Conversas']} rows={data.byTag.map((t: any) => [t.name, t.conversations])} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
