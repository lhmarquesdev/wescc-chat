import { api } from '../../lib/api';
import { formatBytes, formatDateTime } from '../../lib/format';
import { Spinner, useAsync } from '../../components/ui';

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function AdminInfo() {
  const { data, loading } = useAsync(() => api.get('statistics'), []);
  if (loading || !data) return <Spinner />;
  const up = Math.round(data.process.uptime / 60);
  return (
    <>
      <h1>Informações do workspace</h1>
      <div className="card">
        <h3>Usuários</h3>
        <div className="stats">
          <Stat label="Total" value={data.users.total} />
          <Stat label="Ativos" value={data.users.active} />
          <Stat label="Desativados" value={data.users.inactive} />
          <Stat label="Online" value={data.users.online} />
          <Stat label="Ausentes" value={data.users.away} />
          <Stat label="Ocupados" value={data.users.busy} />
          <Stat label="Offline" value={data.users.offline} />
          <Stat label="Bots" value={data.users.bots} />
        </div>
      </div>
      <div className="card">
        <h3>Salas e mensagens</h3>
        <div className="stats">
          <Stat label="Salas" value={data.rooms.total} />
          <Stat label="Canais" value={data.rooms.channels} />
          <Stat label="Grupos privados" value={data.rooms.private_groups} />
          <Stat label="DMs" value={data.rooms.direct} />
          <Stat label="Discussões" value={data.rooms.discussions} />
          <Stat label="Atendimentos" value={data.rooms.livechat} />
          <Stat label="Times" value={data.teams} />
          <Stat label="Mensagens" value={data.messages.total} />
          <Stat label="Em threads" value={data.messages.thread_messages} />
          <Stat label="Arquivos" value={`${data.uploads.total} (${formatBytes(data.uploads.totalSize)})`} />
        </div>
      </div>
      <div className="card">
        <h3>Servidor</h3>
        <div className="stats">
          <Stat label="Versão" value="Wescc Chat 0.1.0" />
          <Stat label="Node.js" value={data.process.nodeVersion} />
          <Stat label="Em execução há" value={up < 60 ? `${up} min` : `${Math.round(up / 60)} h`} />
          <Stat label="Memória" value={formatBytes(data.process.memory)} />
        </div>
        <h4>Instâncias ({data.instances.length})</h4>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Host</th>
              <th>PID</th>
              <th>Iniciada</th>
              <th>Último sinal</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((i: any) => (
              <tr key={i._id}>
                <td>
                  {i._id} {i.current && <span className="pill accent">esta</span>}
                </td>
                <td>{i.host}</td>
                <td>{i.pid}</td>
                <td>{formatDateTime(i.startedAt)}</td>
                <td>{formatDateTime(i.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Sem limite de instâncias, conexões simultâneas ou usuários: o tempo real entre instâncias usa o próprio PostgreSQL.</p>
      </div>
    </>
  );
}
