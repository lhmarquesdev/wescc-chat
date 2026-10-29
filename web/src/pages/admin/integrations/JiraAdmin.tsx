// Integrações (Jira/Teams): Administração → Integrações → Jira (§7.3). As abas devolvem fragmentos: a barra de
// salvar precisa ser filha direta do .page-body.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { JiraConfig } from '@shared/integrations';
import { ApiError } from '../../../lib/api';
import { useStore } from '../../../lib/store';
import { SkeletonTable, Tabs, confirmDialog, useAsync } from '../../../components/ui';
import { Activity } from './Activity';
import { AlertsBanner, SecretsKeyBanner } from './AlertsBanner';
import { jiraAdmin } from './admin-api';
import { JiraChat } from './JiraChat';
import { JiraConnection } from './JiraConnection';
import { JiraRules } from './JiraRules';
import { LoadError, SubHead, fail, useIntegrationEvents } from './parts';
import './integrations-admin.css';

const TABS = [
  { id: 'conexao', label: 'Conexão' },
  { id: 'avisos', label: 'Avisos nos canais' },
  { id: 'chat', label: 'Recursos no chat' },
  { id: 'atividade', label: 'Atividade' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export interface JiraTabProps {
  config: JiraConfig;
  onConfig: (c: JiraConfig) => void;
  onDirty: (dirty: boolean) => void;
}

export function JiraAdmin({ tab: raw }: { tab?: string }) {
  const navigate = useNavigate();
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'conexao';
  const { data, error, loading, reload } = useAsync(() => jiraAdmin.config().then((r) => r.config), []);
  const [config, setConfig] = useState<JiraConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toggling, setToggling] = useState(false);
  const current = config ?? data;
  useIntegrationEvents(() => {
    jiraAdmin
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
    navigate(`/admin/integrations/jira/${t}`);
  };

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      const r = await jiraAdmin.save({ enabled });
      setConfig(r.config);
      useStore.getState().toast(enabled ? 'Jira ativado.' : 'Jira desativado.', 'success');
    } catch (e) {
      if (e instanceof ApiError && e.errorType === 'error-jira-not-configured') useStore.getState().toast('Configure e teste a conexão antes de ativar.', 'error');
      else fail(e);
    } finally {
      setToggling(false);
    }
  };

  const tone = current ? (current.enabled ? current.status.tone : 'off') : null;
  return (
    <>
      <SubHead title="Jira" tone={tone} enabled={current ? current.enabled : null} busy={toggling} loading={!current && loading} onToggle={toggle} />
      <SecretsKeyBanner />
      <AlertsBanner provider="jira" />
      <Tabs value={tab} onChange={go} items={TABS.map((t) => ({ id: t.id, label: t.label }))} />
      {!current ? (
        loading ? (
          <SkeletonTable rows={6} cols={2} />
        ) : (
          <LoadError text={`Não foi possível carregar a configuração do Jira: ${error}`} onRetry={reload} />
        )
      ) : tab === 'conexao' ? (
        <JiraConnection config={current} onConfig={setConfig} onDirty={setDirty} />
      ) : tab === 'avisos' ? (
        <JiraRules config={current} onConfig={setConfig} onDirty={setDirty} />
      ) : tab === 'chat' ? (
        <JiraChat config={current} onConfig={setConfig} onDirty={setDirty} />
      ) : (
        <Activity provider="jira" />
      )}
    </>
  );
}
