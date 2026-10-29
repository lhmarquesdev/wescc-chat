// Integrações (Jira/Teams): Administração → Integrações. /admin/integrations[/jira|teams|webhooks[/aba]] (§7.1).
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { usePermission, useStore } from '../../../lib/store';
import { Empty } from '../../../components/ui';
import { AdminIntegrations } from '../AdminIntegrations';
import { CalendarAdmin } from './CalendarAdmin';
import { Hub } from './Hub';
import { JiraAdmin } from './JiraAdmin';
import { TeamsAdmin } from './TeamsAdmin';
import { motivoText } from './parts';
import './integrations-admin.css';

// Volta do OAuth (?integracao=…): avisa e tira a consulta do endereço.
function useOAuthReturn() {
  const location = useLocation();
  const navigate = useNavigate();
  // O StrictMode roda o efeito duas vezes no desenvolvimento: um aviso por entrada do histórico.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const r = q.get('integracao');
    if (!r || handled.current === location.key) return;
    handled.current = location.key;
    const toast = useStore.getState().toast;
    if (r === 'teams-ok') toast('Conta de serviço conectada.', 'success');
    else if (r === 'jira-ok') toast('Conta do Jira conectada.', 'success');
    else if (r === 'erro') toast(`Não foi possível concluir a conexão (${motivoText(q.get('motivo'))}).`, 'error');
    q.delete('integracao');
    q.delete('motivo');
    const rest = q.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '' }, { replace: true });
  }, [location.search, location.pathname, location.key, navigate]);
}

function NoAccess({ hub }: { hub?: boolean }) {
  return hub ? (
    <Empty icon="admin-integrations" title="Sem acesso às integrações">
      Peça a um administrador a permissão para configurar as integrações.
    </Empty>
  ) : (
    <Empty icon="admin-integrations" title="Sem acesso a esta integração">
      Peça a um administrador a permissão para configurar esta integração.
    </Empty>
  );
}

export function IntegrationsAdmin() {
  const { view, param } = useParams();
  const canJira = usePermission('manage-jira');
  const canTeams = usePermission('manage-msteams');
  const canHooks = usePermission(['manage-integrations', 'manage-own-integrations']);
  const canCalendar = usePermission('edit-privileged-setting');
  useOAuthReturn();
  if (view === 'jira') return canJira ? <JiraAdmin tab={param} /> : <NoAccess />;
  if (view === 'teams') return canTeams ? <TeamsAdmin tab={param} /> : <NoAccess />;
  if (view === 'webhooks') return canHooks ? <AdminIntegrations /> : <NoAccess />;
  if (view === 'calendar') return canCalendar ? <CalendarAdmin /> : <NoAccess />;
  // O hub só lista o que a pessoa pode configurar: sem nenhuma das permissões, ficaria uma página vazia.
  if (!canJira && !canTeams && !canHooks && !canCalendar) return <NoAccess hub />;
  return <Hub />;
}
