import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Call } from '@shared/index';
import { api } from '../lib/api';
import { startCall } from '../lib/calls';
import { formatDateTime, formatDuration } from '../lib/format';
import { realtime } from '../lib/realtime';
import { useSetting, useStore } from '../lib/store';
import { Avatar, Empty, Pager, Spinner, useAsync } from '../components/ui';

const COUNT = 50;

const STATUS: Record<string, string> = {
  ended: '',
  missed: 'não atendida',
  declined: 'recusada',
  canceled: 'cancelada',
  busy: 'ocupado',
  ringing: 'tocando',
  ongoing: 'em andamento',
};

// Histórico de chamadas da pessoa (feitas e recebidas).
export function CallsPage() {
  const me = useStore((s) => s.me)!;
  const enabled = useSetting<boolean>('Calls_Enabled');
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useAsync(() => api.get('calls.list', { offset, count: COUNT }) as Promise<{ calls: Call[]; total: number }>, [offset]);
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
  return (
    <div className="page">
      <header className="page-head">
        <h1>Chamadas</h1>
      </header>
      <div className="page-body">
        <div className="card">
          {loading && !data ? (
            <Spinner />
          ) : error ? (
            <div className="form-error">Não foi possível carregar as chamadas: {error}</div>
          ) : !data?.calls.length ? (
            <Empty>Nenhuma chamada ainda. Abra uma mensagem direta e use 📞 ou 🎥 no topo da conversa.</Empty>
          ) : (
            <ul className="call-list">
              {data.calls.map((c) => {
                const outgoing = c.caller._id === me._id;
                const other = outgoing ? c.callee : c.caller;
                const missed = !outgoing && ['missed', 'busy'].includes(c.status);
                return (
                  <li key={c._id} className={missed ? 'missed' : ''}>
                    <Avatar username={other.username} size={36} />
                    <button className="call-list-main" onClick={() => navigate(`/direct/${c.rid}`)}>
                      <strong>{other.name || other.username}</strong>
                      <span className="muted small">
                        {outgoing ? '↗ Feita' : missed ? '↙ Perdida' : '↙ Recebida'} · {c.kind === 'video' ? '🎥 vídeo' : '📞 voz'}
                        {c.duration != null ? ` · ${formatDuration(c.duration)}` : STATUS[c.status] ? ` · ${STATUS[c.status]}` : ''}
                      </span>
                    </button>
                    <span className="muted small">{formatDateTime(c.createdAt)}</span>
                    {enabled && (
                      <span className="call-list-actions">
                        <button className="icon-btn" title={c.canCall === false ? c.callBlockedReason : 'Chamada de voz'} disabled={c.canCall === false} onClick={() => void startCall(c.rid, 'audio')}>
                          📞
                        </button>
                        <button className="icon-btn" title={c.canCall === false ? c.callBlockedReason : 'Chamada de vídeo'} disabled={c.canCall === false} onClick={() => void startCall(c.rid, 'video')}>
                          🎥
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {data && <Pager offset={offset} count={COUNT} total={data.total} onChange={setOffset} />}
        </div>
      </div>
    </div>
  );
}
