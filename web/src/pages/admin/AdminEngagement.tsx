import { useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import { roomIconName } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { Empty, SkeletonStats, SkeletonTable, Tabs, useAsync } from '../../components/ui';
import { BarChart, LineChart } from './charts';
import { PageHead, RoomCell, TableWrap, UserCell, num } from './parts';

// A análise do Omnichannel usa o mesmo gráfico de barras.
export { BarChart as Bars } from './charts';

const WEEKDAYS = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const TYPE_LABEL: Record<string, string> = { c: 'Canais públicos', p: 'Grupos privados', d: 'Mensagens diretas', l: 'Atendimentos' };
const TYPE_ICON: Record<string, 'room-channel' | 'room-private' | 'room-direct' | 'room-livechat'> = { c: 'room-channel', p: 'room-private', d: 'room-direct', l: 'room-livechat' };
const HINT = 'Escolha outro período.';

// "2026-10-22" → "22/10".
const dayLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// O painel só traz o tipo da sala; o que o cliente já conhece (avisos, time, discussão) completa o ícone:
// a assinatura vale para as salas em que a pessoa está, a sala carregada para as que ela já abriu.
function useRoomIcon() {
  const subs = useStore((s) => s.subscriptions);
  const known = useStore((s) => s.rooms);
  return (r: { _id: string; t: string; teamMain?: boolean }) => roomIconName({ ...subs[r._id], ...known[r._id], ...r });
}

export function AdminEngagement() {
  const [tab, setTab] = useState<'users' | 'messages' | 'channels'>('users');
  const [days, setDays] = useState(30);
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return (
    <>
      <PageHead title="Engajamento">
        <select className="head-select" aria-label="Período" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
        </select>
      </PageHead>
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

function Loading() {
  return (
    <>
      <SkeletonStats n={3} />
      <SkeletonTable rows={6} cols={3} />
    </>
  );
}

function UsersTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/users', { start, end }), [start, end]);
  if (loading || !data) return <Loading />;
  const newUsers = data.daily.reduce((n: number, d: any) => n + d.newUsers, 0);
  const last = data.daily[data.daily.length - 1];
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{num(data.activeUsers)}</div>
          <div className="stat-label">
            <Icon name="admin-users" />
            Ativos no período
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{num(newUsers)}</div>
          <div className="stat-label">
            <Icon name="add-people" />
            Novos usuários
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{num(last?.dau)}</div>
          <div className="stat-label">
            <Icon name="admin-engagement" />
            Ativos hoje
          </div>
        </div>
      </div>
      <div className="card chart-card">
        <div className="card-head">
          <div>
            <h2>Usuários ativos</h2>
            <p className="card-desc">Pessoas que usaram o chat em cada dia, nos últimos 7 e nos últimos 30 dias.</p>
          </div>
        </div>
        <LineChart
          x={data.daily.map((d: any) => dayLabel(d.day))}
          emptyHint={HINT}
          series={[
            { name: 'No dia', values: data.daily.map((d: any) => d.dau) },
            { name: 'Em 7 dias', values: data.daily.map((d: any) => d.wau) },
            { name: 'Em 30 dias', values: data.daily.map((d: any) => d.mau) },
          ]}
        />
      </div>
      <div className="card chart-card">
        <div className="card-head">
          <h2>Novos usuários por dia</h2>
        </div>
        <BarChart data={data.daily.map((d: any) => ({ x: dayLabel(d.day), y: d.newUsers }))} unit={['novo usuário', 'novos usuários']} emptyHint={HINT} />
      </div>
      <div className="grid-2">
        <div className="card chart-card">
          <div className="card-head">
            <h2>Horários mais movimentados</h2>
          </div>
          <BarChart
            data={Array.from({ length: 24 }, (_, h) => ({ x: `${h}h`, y: data.busiestHours.find((b: any) => b.hour === h)?.messages ?? 0 }))}
            unit={['mensagem', 'mensagens']}
            emptyHint={HINT}
          />
        </div>
        <div className="card chart-card">
          <div className="card-head">
            <h2>Dias da semana</h2>
          </div>
          <BarChart
            data={Array.from({ length: 7 }, (_, i) => ({ x: WEEKDAYS[i + 1], y: data.weekdays.find((w: any) => w.weekday === i + 1)?.messages ?? 0 }))}
            unit={['mensagem', 'mensagens']}
            emptyHint={HINT}
          />
        </div>
      </div>
    </>
  );
}

function MessagesTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/messages', { start, end }), [start, end]);
  const iconOf = useRoomIcon();
  if (loading || !data) return <Loading />;
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{num(data.total)}</div>
          <div className="stat-label">
            <Icon name="nav-chats" />
            Mensagens no período
          </div>
        </div>
        {data.byRoomType.map((t: any) => (
          <div key={t.t} className="stat">
            <div className="stat-value">{num(t.messages)}</div>
            <div className="stat-label">
              <Icon name={TYPE_ICON[t.t] ?? 'room-channel'} />
              {TYPE_LABEL[t.t] ?? t.t}
            </div>
          </div>
        ))}
      </div>
      <div className="card chart-card">
        <div className="card-head">
          <h2>Mensagens por dia</h2>
        </div>
        <BarChart data={data.daily.map((d: any) => ({ x: dayLabel(d.day), y: d.messages }))} unit={['mensagem', 'mensagens']} emptyHint={HINT} />
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Salas mais ativas</h2>
          </div>
          {data.topRooms.length ? (
            <table className="table rank-table">
              <thead>
                <tr>
                  <th>Sala</th>
                  <th className="num">Mensagens</th>
                </tr>
              </thead>
              <tbody>
                {data.topRooms.map((r: any) => (
                  <tr key={r._id}>
                    <td>
                      <RoomCell icon={<Icon name={iconOf(r)} />} name={r.fname || r.name} />
                    </td>
                    <td className="num">{num(r.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nenhuma mensagem no período.</Empty>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Pessoas mais ativas</h2>
          </div>
          {data.topUsers.length ? (
            <table className="table rank-table">
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th className="num">Mensagens</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsers.map((u: any) => (
                  <tr key={u._id}>
                    <td>
                      <UserCell username={u.username} name={u.name} />
                    </td>
                    <td className="num">{num(u.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nenhuma mensagem no período.</Empty>
          )}
        </div>
      </div>
    </>
  );
}

function Trend({ value }: { value: number }) {
  if (!value) return <span className="trend">0</span>;
  return (
    <span className={value > 0 ? 'trend up' : 'trend down'}>
      <Icon name={value > 0 ? 'trend-up' : 'trend-down'} size={12} />
      {num(Math.abs(value))}
    </span>
  );
}

function ChannelsTab({ start, end }: { start: string; end: string }) {
  const { data, loading } = useAsync(() => api.get('engagement-dashboard/channels', { start, end, count: 100 }), [start, end]);
  const iconOf = useRoomIcon();
  if (loading || !data) return <SkeletonTable rows={8} cols={5} />;
  if (!data.channels.length)
    return (
      <Empty icon="room-channel" title="Nenhum canal com mensagens">
        Os canais aparecem aqui quando recebem mensagens no período.
      </Empty>
    );
  return (
    <TableWrap>
      <table className="table stack kv">
        <thead>
          <tr>
            <th>Canal</th>
            <th className="num">Membros</th>
            <th className="num">Mensagens</th>
            <th className="num">Período anterior</th>
            <th className="num">Variação</th>
          </tr>
        </thead>
        <tbody>
          {data.channels.map((c: any) => (
            <tr key={c.room._id}>
              <td>
                <RoomCell icon={<Icon name={iconOf(c.room)} />} name={c.room.fname || c.room.name} />
              </td>
              <td className="num" data-label="Membros">
                {num(c.room.usersCount)}
              </td>
              <td className="num" data-label="Mensagens">
                {num(c.messages)}
              </td>
              <td className="num" data-label="Período anterior">
                {num(c.lastWeekMessages)}
              </td>
              <td className="num" data-label="Variação">
                <Trend value={c.diffFromLastWeek} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
