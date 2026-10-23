import type { ReactNode } from 'react';
import { api } from '../../lib/api';
import { formatBytes, formatDateTime } from '../../lib/format';
import { Icon, type IconName } from '../../components/Icon';
import { SkeletonStats, useAsync } from '../../components/ui';
import { PageHead, TableWrap, num } from './parts';

// Rótulo primeiro (com ícone de 16px ou o ponto de presença), valor grande embaixo.
function Stat({ label, value, icon, dot }: { label: string; value: ReactNode; icon?: IconName; dot?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">
        {icon && <Icon name={icon} />}
        {dot && <span className={`status-dot ${dot}`} aria-hidden="true" />}
        {label}
      </div>
    </div>
  );
}

export function AdminInfo() {
  const { data, loading } = useAsync(() => api.get('statistics'), []);
  if (loading || !data)
    return (
      <>
        <PageHead title="Informações" />
        <SkeletonStats n={8} />
        <SkeletonStats n={4} />
      </>
    );
  const up = Math.round(data.process.uptime / 60);
  return (
    <>
      <PageHead title="Informações" />
      <section className="admin-section">
        <h2 className="section-title">Usuários</h2>
        <div className="stats">
          <Stat icon="admin-users" label="Total" value={num(data.users.total)} />
          <Stat icon="success" label="Ativos" value={num(data.users.active)} />
          <Stat icon="disabled-user" label="Desativados" value={num(data.users.inactive)} />
          <Stat dot="online" label="Disponíveis" value={num(data.users.online)} />
          <Stat dot="away" label="Ausentes" value={num(data.users.away)} />
          <Stat dot="busy" label="Ocupados" value={num(data.users.busy)} />
          <Stat dot="offline" label="Offline" value={num(data.users.offline)} />
          <Stat icon="bot" label="Bots" value={num(data.users.bots)} />
        </div>
      </section>
      <section className="admin-section">
        <h2 className="section-title">Salas e mensagens</h2>
        <div className="stats">
          <Stat icon="rooms-all" label="Salas" value={num(data.rooms.total)} />
          <Stat icon="room-channel" label="Canais" value={num(data.rooms.channels)} />
          <Stat icon="room-private" label="Grupos privados" value={num(data.rooms.private_groups)} />
          <Stat icon="room-direct" label="Conversas diretas" value={num(data.rooms.direct)} />
          <Stat icon="room-discussion" label="Discussões" value={num(data.rooms.discussions)} />
          <Stat icon="room-livechat" label="Atendimentos" value={num(data.rooms.livechat)} />
          <Stat icon="panel-team" label="Times" value={num(data.teams)} />
          <Stat icon="nav-chats" label="Mensagens" value={num(data.messages.total)} />
          <Stat icon="panel-threads" label="Em tópicos" value={num(data.messages.thread_messages)} />
          <Stat
            icon="panel-files"
            label="Arquivos"
            value={
              <>
                {num(data.uploads.total)}
                <span className="stat-unit">{formatBytes(data.uploads.totalSize)}</span>
              </>
            }
          />
        </div>
      </section>
      <section className="admin-section">
        <h2 className="section-title">Servidor</h2>
        <div className="stats">
          <Stat icon="server" label="Versão" value="0.1.0" />
          <Stat icon="code" label="Node.js" value={data.process.nodeVersion ?? '—'} />
          <Stat icon="last-seen" label="Em execução há" value={up < 60 ? `${up} min` : `${Math.round(up / 60)} h`} />
          <Stat icon="storage" label="Memória" value={formatBytes(data.process.memory) || '—'} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>
                Instâncias <span className="pill head-count">{num(data.instances.length)}</span>
              </h2>
              <p className="card-desc">Sem limite de instâncias, conexões simultâneas ou usuários: o tempo real entre instâncias usa o próprio PostgreSQL.</p>
            </div>
          </div>
          <TableWrap>
            <table className="table stack kv">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Host</th>
                  <th className="num col-md">PID</th>
                  <th className="col-lg">Iniciada</th>
                  <th>Último sinal</th>
                </tr>
              </thead>
              <tbody>
                {data.instances.map((i: any) => (
                  <tr key={i._id}>
                    <td>
                      <span className="mono">{i._id}</span> {i.current && <span className="pill accent">Esta instância</span>}
                    </td>
                    <td data-label="Host">{i.host}</td>
                    <td className="num col-md" data-label="PID">
                      {i.pid}
                    </td>
                    <td className="nowrap col-lg" data-label="Iniciada">
                      {formatDateTime(i.startedAt)}
                    </td>
                    <td className="nowrap" data-label="Último sinal">
                      {formatDateTime(i.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
      </section>
    </>
  );
}
