import { useState } from 'react';
import { api } from '../../lib/api';
import { Spinner, Tabs, useAsync } from '../../components/ui';

const WEEKDAYS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const TYPE_LABEL: Record<string, string> = { c: 'Canais públicos', p: 'Grupos privados', d: 'Mensagens diretas', l: 'Atendimentos' };

function Bars({ data, height = 140, label }: { data: { x: string; y: number }[]; height?: number; label?: (d: { x: string; y: number }) => string }) {
  const max = Math.max(1, ...data.map((d) => d.y));
  const w = 100 / Math.max(1, data.length);
  return (
    <div className="chart">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img">
        {data.map((d, i) => {
          const h = (d.y / max) * (height - 4);
          return (
            <rect key={i} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} rx={0.6} className="bar">
              <title>{label ? label(d) : `${d.x}: ${d.y}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="chart-axis">
        <span>{data[0]?.x}</span>
        <span>{data[Math.floor(data.length / 2)]?.x}</span>
        <span>{data[data.length - 1]?.x}</span>
      </div>
    </div>
  );
}

function Lines({ series, height = 160 }: { series: { name: string; cls: string; values: number[] }[]; height?: number }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = series[0]?.values.length ?? 0;
  const pt = (v: number, i: number) => `${(i / Math.max(1, n - 1)) * 100},${height - (v / max) * (height - 6) - 3}`;
  return (
    <div className="chart">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height}>
        {series.map((s) => (
          <polyline key={s.name} className={`line ${s.cls}`} fill="none" vectorEffect="non-scaling-stroke" points={s.values.map(pt).join(' ')} />
        ))}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name} className={`legend-item ${s.cls}`}>
            {s.name}: <strong>{s.values[s.values.length - 1] ?? 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function AdminEngagement() {
  const [tab, setTab] = useState<'users' | 'messages' | 'channels'>('users');
  const [days, setDays] = useState(30);
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return (
    <>
      <div className="page-title-row">
        <h1>Dashboard de engajamento</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
        </select>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'users', label: 'Usuários' },
          { id: 'messages', label: 'Mensagens' },
          { id: 'channels', label: 'Canais' },
        ]}
      />
      {tab === 'users' && <UsersTab start={start} end={end} />}
      {tab === 'messages' && <MessagesTab start={start} end={end} />}
      {tab === 'channels' && <ChannelsTab start={start} end={end} />}
    </>
  );
}

function UsersTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/users', { start, end }), [start, end]);
  if (loading || !data) return <Spinner />;
  const newUsers = data.daily.reduce((n: number, d: any) => n + d.newUsers, 0);
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{data.activeUsers}</div>
          <div className="stat-label">Usuários ativos no período</div>
        </div>
        <div className="stat">
          <div className="stat-value">{newUsers}</div>
          <div className="stat-label">Novos usuários</div>
        </div>
      </div>
      <div className="card">
        <h3>Usuários ativos (diário, semanal, mensal)</h3>
        <Lines
          series={[
            { name: 'DAU', cls: 's1', values: data.daily.map((d: any) => d.dau) },
            { name: 'WAU', cls: 's2', values: data.daily.map((d: any) => d.wau) },
            { name: 'MAU', cls: 's3', values: data.daily.map((d: any) => d.mau) },
          ]}
        />
      </div>
      <div className="card">
        <h3>Novos usuários por dia</h3>
        <Bars data={data.daily.map((d: any) => ({ x: d.day.slice(5), y: d.newUsers }))} />
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Horários mais movimentados</h3>
          <Bars data={Array.from({ length: 24 }, (_, h) => ({ x: `${h}h`, y: data.busiestHours.find((b: any) => b.hour === h)?.messages ?? 0 }))} />
        </div>
        <div className="card">
          <h3>Dias da semana</h3>
          <Bars data={Array.from({ length: 7 }, (_, i) => ({ x: WEEKDAYS[i + 1], y: data.weekdays.find((w: any) => w.weekday === i + 1)?.messages ?? 0 }))} />
        </div>
      </div>
    </>
  );
}

function MessagesTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/messages', { start, end }), [start, end]);
  if (loading || !data) return <Spinner />;
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{data.total}</div>
          <div className="stat-label">Mensagens no período</div>
        </div>
        {data.byRoomType.map((t: any) => (
          <div key={t.t} className="stat">
            <div className="stat-value">{t.messages}</div>
            <div className="stat-label">{TYPE_LABEL[t.t] ?? t.t}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Mensagens por dia</h3>
        <Bars data={data.daily.map((d: any) => ({ x: d.day.slice(5), y: d.messages }))} />
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Salas mais ativas</h3>
          <table className="table">
            <tbody>
              {data.topRooms.map((r: any) => (
                <tr key={r._id}>
                  <td>
                    {r.t === 'p' ? '🔒' : '#'} {r.name}
                  </td>
                  <td>{r.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Pessoas mais ativas</h3>
          <table className="table">
            <tbody>
              {data.topUsers.map((u: any) => (
                <tr key={u._id}>
                  <td>@{u.username}</td>
                  <td>{u.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function ChannelsTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/channels', { start, end, count: 100 }), [start, end]);
  if (loading || !data) return <Spinner />;
  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>Canal</th>
            <th>Membros</th>
            <th>Mensagens</th>
            <th>Período anterior</th>
            <th>Variação</th>
          </tr>
        </thead>
        <tbody>
          {data.channels.map((c: any) => (
            <tr key={c.room._id}>
              <td>
                {c.room.t === 'p' ? '🔒' : '#'} {c.room.fname || c.room.name}
              </td>
              <td>{c.room.usersCount}</td>
              <td>{c.messages}</td>
              <td>{c.lastWeekMessages}</td>
              <td className={c.diffFromLastWeek >= 0 ? 'pos' : 'neg'}>
                {c.diffFromLastWeek >= 0 ? '▲' : '▼'} {Math.abs(c.diffFromLastWeek)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
