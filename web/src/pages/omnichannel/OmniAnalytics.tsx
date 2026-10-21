import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Spinner, useAsync } from '../../components/ui';
import { Bars } from '../admin/AdminEngagement';

export function duration(sec: number) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}min` : m ? `${m}min ${s}s` : `${s}s`;
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
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
  if (!data) return <Spinner />;
  return (
    <div className="card">
      <h3>Agora</h3>
      <div className="stats">
        <Stat value={data.chats.queued} label="Na fila" />
        <Stat value={data.chats.open} label="Em atendimento" />
        <Stat value={data.chats.onhold} label="Em espera" />
        <Stat value={duration(data.chats.longest_wait)} label="Maior espera na fila" />
        <Stat value={`${data.agents.available}/${data.agents.total}`} label="Agentes disponíveis" />
        <Stat value={data.agents.online} label="Agentes online" />
      </div>
    </div>
  );
}

export function OmniAnalytics() {
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
        <h1>Análises</h1>
        <div className="row">
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Todos os departamentos</option>
            {(deps.data?.departments ?? []).map((d: any) => (
              <option key={d._id} value={d._id}>
                {d.name}
              </option>
            ))}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Hoje</option>
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </div>
      </div>
      <Realtime />
      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="stats">
            <Stat value={data.totals.conversations} label="Conversas" />
            <Stat value={data.totals.closed} label="Encerradas" />
            <Stat value={duration(data.totals.avg_wait)} label="Espera média" />
            <Stat value={duration(data.totals.avg_first_response)} label="Primeira resposta média" />
            <Stat value={duration(data.totals.avg_duration)} label="Duração média" />
            <Stat value={data.totals.sla_breached} label="SLA violado" />
            <Stat value={data.totals.satisfaction ? data.totals.satisfaction.toFixed(1) + ' / 5' : '—'} label="Satisfação" />
          </div>
          <div className="card">
            <h3>Conversas por dia</h3>
            <Bars data={data.byDay.map((d: any) => ({ x: d.day.slice(5), y: d.conversations }))} />
          </div>
          <div className="grid-2">
            <div className="card">
              <h3>Conversas por hora</h3>
              <Bars data={Array.from({ length: 24 }, (_, h) => ({ x: `${h}h`, y: data.byHour.find((b: any) => b.hour === h)?.conversations ?? 0 }))} />
            </div>
            <div className="card">
              <h3>Por departamento</h3>
              <table className="table">
                <tbody>
                  {data.byDepartment.map((d: any) => (
                    <tr key={d.name}>
                      <td>{d.name}</td>
                      <td>{d.conversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid-2">
            <div className="card">
              <h3>Por agente</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Agente</th>
                    <th>Conversas</th>
                    <th>1ª resposta</th>
                    <th>Duração</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAgent.map((a: any) => (
                    <tr key={a.id}>
                      <td>{a.name || '@' + a.username}</td>
                      <td>{a.conversations}</td>
                      <td>{duration(a.avg_first_response)}</td>
                      <td>{duration(a.avg_duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3>Por tag</h3>
              <table className="table">
                <tbody>
                  {data.byTag.map((t: any) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td>{t.conversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
