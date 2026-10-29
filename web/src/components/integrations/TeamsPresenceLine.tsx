// "No Teams: Em reunião" no cartão do usuário (fase 3). Some quando a presença está desligada ou é desconhecida.
import { useEffect } from 'react';
import type { ExternalPresence } from '@shared/integrations';
import { TEAMS_BUSY_ACTIVITIES } from '@shared/integrations';
import { setExternalPresence, teamsApi, useIntegrations, useIntegrationsMe } from '../../lib/integrations';
import { useStore } from '../../lib/store';
import './integrations.css';

// Mesma forma do ponto de presença do chat (ocupado com barra, ausente pela metade, offline vazado): cor nunca sozinha.
function dotOf(p: ExternalPresence): 'busy' | 'away' | 'online' | 'offline' {
  const a = p.availability.replace(/Idle$/, '');
  if (TEAMS_BUSY_ACTIVITIES.includes(p.activity) || a === 'Busy' || a === 'DoNotDisturb') return 'busy';
  if (a === 'Away' || a === 'BeRightBack') return 'away';
  if (a === 'Available') return 'online';
  return 'offline';
}

export function TeamsPresenceLine({ userId }: { userId: string }) {
  const me = useIntegrationsMe();
  const on = !!me?.msteams.enabled && me.msteams.presence;
  const p = useIntegrations((s) => s.presence[userId]);
  const connected = useStore((s) => s.connected);

  // Busca ao abrir e de novo depois de cada reconexão: presence.external só chega quando muda.
  useEffect(() => {
    if (!on || !connected) return;
    let alive = true;
    teamsApi
      .presence([userId])
      .then((r) => alive && setExternalPresence(userId, r.presence[userId] ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [on, connected, userId]);

  if (!on || !p || p.availability === 'PresenceUnknown' || !p.label || p.label === 'Desconhecido') return null;
  return (
    <div className="muted small" data-int="presence">
      <span className={`status-dot ${dotOf(p)}`} aria-hidden="true" />
      No Teams: {p.label}
    </div>
  );
}
