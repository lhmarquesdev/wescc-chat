// Integração com o Jira: chamadas da administração (§3.11, §4.11, §5.8). As do chat ficam em lib/integrations.ts.
import type {
  ConnectorStatus,
  IntegrationActivity,
  IntegrationAlert,
  IntegrationRoomRef,
  JiraConfig,
  JiraConfigInput,
  JiraEventKind,
  JiraProjectRef,
  JiraRule,
  JiraRuleInput,
  MessageJira,
  Provider,
  TargetCheck,
} from '@shared/integrations';
import { api } from '../../../lib/api';

export interface IntegrationsOverview {
  jira: { enabled: boolean; status: ConnectorStatus; rules: number };
  webhooks: { incoming: number; outgoing: number };
  secretsKey: { source: 'env' | 'file' | 'none'; file?: string; created?: boolean; problem?: string };
  paused: boolean;
}

type Body = Record<string, unknown>;
const body = (v: object) => v as Body;

export const coreAdmin = {
  overview: () => api.get<IntegrationsOverview>('integrations.overview'),
  alerts: () => api.get<{ alerts: IntegrationAlert[] }>('integrations.alerts'),
  activity: (p: { provider: Provider; integrationId?: string | null; tone?: 'err' | null; offset: number; count: number }) =>
    api.get<{ activity: IntegrationActivity[]; total: number }>('integrations.activity', {
      provider: p.provider,
      integrationId: p.integrationId || undefined,
      tone: p.tone || undefined,
      offset: p.offset,
      count: p.count,
    }),
  retry: async (jobId: string): Promise<void> => {
    await api.post('integrations.jobs.retry', { jobId });
  },
  retryAll: (integrationId: string) => api.post<{ count: number }>('integrations.jobs.retryAll', { integrationId }),
  checkTargets: (p: { provider: Provider; mode: 'post' | 'read'; roomIds: string[]; grantPublisher: boolean }) => api.post<{ targets: TargetCheck[] }>('integrations.targets.check', body(p)),
  searchRooms: (text: string, count = 10) => api.get<{ rooms: IntegrationRoomRef[] }>('integrations.rooms.search', { text, count }),
};

export const jiraAdmin = {
  config: () => api.get<{ config: JiraConfig }>('jira.config'),
  // O segredo do webhook só vem nesta resposta, na primeira vez em modo webhook.
  save: (input: JiraConfigInput) => api.post<{ config: JiraConfig; webhookSecret?: string }>('jira.config.save', body(input)),
  test: () => api.post<{ status: ConnectorStatus; account: JiraConfig['account'] }>('jira.config.test'),
  rotate: (what: 'url' | 'secret') => api.post<{ webhookUrl: string | null; secret?: string }>('jira.webhook.rotate', { what }),
  ack: async (jql: string): Promise<void> => {
    await api.post('jira.webhook.ack', { jql });
  },
  rules: () => api.get<{ rules: JiraRule[] }>('jira.rules'),
  saveRule: (input: JiraRuleInput & { _id?: string }) => api.post<{ rule: JiraRule }>('jira.rules.save', body(input)),
  removeRule: async (id: string): Promise<void> => {
    await api.post('jira.rules.remove', { _id: id });
  },
  preview: (projects: string[], events: JiraEventKind[]) => api.post<{ msg: string; jira: MessageJira }>('jira.rules.preview', { projects, events }),
  // Precisa do Jira ligado e de use-jira; a lista é a que a conta da pessoa (ou a da integração) vê.
  projects: (query?: string) => api.get<{ projects: JiraProjectRef[]; identity: 'user' | 'integration' }>('jira.projects', { query: query || undefined }),
};

// Papéis que têm uma permissão (para "Quem pode usar"): só para quem pode ler as permissões.
export const permissionsApi = {
  list: () => api.get<{ update: { _id: string; roles: string[] }[] }>('permissions.listAll'),
};
