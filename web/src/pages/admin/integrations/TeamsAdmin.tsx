// Integrações (Jira/Teams): Administração → Integrações → Microsoft Teams (§7.4). As abas devolvem fragmentos: a
// barra de salvar precisa ser filha direta do .page-body.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TeamsConfig } from '@shared/integrations';
import { ApiError } from '../../../lib/api';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { SkeletonTable, Tabs, confirmDialog, useAsync } from '../../../components/ui';
import { Activity } from './Activity';
import { AlertsBanner, SecretsKeyBanner } from './AlertsBanner';
import { teamsAdmin } from './admin-api';
import { LoadError, SubHead, fail, useIntegrationEvents } from './parts';
import { TeamsConnection } from './TeamsConnection';
import { TeamsIn } from './TeamsIn';
import { TeamsMeetings } from './TeamsMeetings';
import { TeamsOut } from './TeamsOut';
import { TeamsPresence } from './TeamsPresence';
import './integrations-admin.css';

const TABS = [
  { id: 'conexao', label: 'Conexão' },
  { id: 'envio', label: 'Envio para o Teams' },
  { id: 'recebimento', label: 'Mensagens do Teams' },
  { id: 'reunioes', label: 'Reuniões' },
  { id: 'presenca', label: 'Presença' },
  { id: 'atividade', label: 'Atividade' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export interface TeamsTabProps {
  config: TeamsConfig;
  onConfig: (c: TeamsConfig) => void;
  onDirty: (dirty: boolean) => void;
}

// Com o Teams desligado, o servidor recusa as listas de regras e a conta de serviço (error-msteams-disabled).
export function TeamsOffNote() {
  return (
    <div className="callout info">
      <Icon name="info" />
      <span>A integração com o Microsoft Teams está desligada. Ative no topo da página para usar esta aba.</span>
    </div>
  );
}

export function TeamsAdmin({ tab: raw }: { tab?: string }) {
  const navigate = useNavigate();
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'conexao';
  const { data, error, loading, reload } = useAsync(() => teamsAdmin.config().then((r) => r.config), []);
  const [config, setConfig] = useState<TeamsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toggling, setToggling] = useState(false);
  const current = config ?? data;
  // Volta do login da conta de serviço (?integracao=teams-ok, lido antes de o endereço ser limpo): testa de novo uma
  // vez, para "O que já funciona" já contar com a conta nova.
  const [justLinked] = useState(() => new URLSearchParams(window.location.search).get('integracao') === 'teams-ok');
  const retested = useRef(false);
  useEffect(() => {
    if (!justLinked || !data || retested.current) return;
    retested.current = true;
    teamsAdmin
      .test()
      .then((r) => setConfig(r.config))
      .catch(() => {});
  }, [justLinked, data]);
  useIntegrationEvents(() => {
    teamsAdmin
      .config()
      .then((r) => setConfig(r.config))
      .catch(() => {});
  });

  const go = async (t: Tab) => {
    if (t === tab) return;
    if (dirty) {
      const yes = await confirmDialog({ title: 'Descartar as alterações?', body: 'As alterações desta aba ainda não foram salvas.', confirmLabel: 'Descartar', danger: true });
      if (!yes) return;
      setDirty(false);
    }
    navigate(`/admin/integrations/teams/${t}`);
  };

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      const r = await teamsAdmin.save({ enabled });
      setConfig(r.config);
      useStore.getState().toast(enabled ? 'Microsoft Teams ativado.' : 'Microsoft Teams desativado.', 'success');
    } catch (e) {
      if (e instanceof ApiError && e.errorType === 'error-msteams-not-configured') useStore.getState().toast('Configure e teste a conexão antes de ativar.', 'error');
      else fail(e);
    } finally {
      setToggling(false);
    }
  };

  const tone = current ? (current.enabled ? current.status.tone : 'off') : null;
  const props = current ? { config: current, onConfig: setConfig, onDirty: setDirty } : null;
  return (
    <>
      <SubHead title="Microsoft Teams" tone={tone} enabled={current ? current.enabled : null} busy={toggling} loading={!current && loading} onToggle={toggle} />
      <SecretsKeyBanner />
      <AlertsBanner provider="msteams" />
      <Tabs value={tab} onChange={go} items={TABS.map((t) => ({ id: t.id, label: t.label }))} />
      {!props ? (
        loading ? (
          <SkeletonTable rows={6} cols={2} />
        ) : (
          <LoadError text={`Não foi possível carregar a configuração do Microsoft Teams: ${error}`} onRetry={reload} />
        )
      ) : tab === 'conexao' ? (
        <TeamsConnection {...props} />
      ) : tab === 'envio' ? (
        <TeamsOut {...props} />
      ) : tab === 'recebimento' ? (
        <TeamsIn {...props} />
      ) : tab === 'reunioes' ? (
        <TeamsMeetings {...props} />
      ) : tab === 'presenca' ? (
        <TeamsPresence {...props} />
      ) : (
        <Activity provider="msteams" />
      )}
    </>
  );
}
