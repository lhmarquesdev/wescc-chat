// Registra, uma vez, as tarefas da fila, a consulta periódica, os ganchos (com wrapHook) e o /jira.
import { JIRA_EVENT_LABEL } from '@shared/integrations';
import { registerCommand } from '../../services/commands';
import { on } from '../../services/hooks';
import { hasPermission } from '../../services/permissions';
import { registerConnectorStatus } from '../core-api';
import { registerJobHandler, type JobRow } from '../jobs';
import { registerPoller, wrapHook } from '../runtime';
import { getState } from '../state';
import { currentSite, jiraEnabled, jiraOn, type ConnectionState } from './client';
import { jiraCommand } from './command';
import { connectionAlert, jiraConnectorStatus } from './config';
import { remoteLinkJob } from './issues';
import { postJob, type PostPayload } from './notify';
import { pollEnabled, pollIntervalMs, pollJira } from './poll';
import { COMMAND_TEXT } from './texts';
import { onMessageForPreview, unfurlJob } from './unfurl';
import { webhookJob } from './webhook';

let registered = false;

const describePost = (job: JobRow) => {
  const p = job.payload as PostPayload;
  return `Aviso de ${p?.ev?.issueKey ?? 'issue'} (${JIRA_EVENT_LABEL[p?.kind] ?? 'Jira'})`;
};

export function registerJira() {
  if (registered) return;
  registered = true;

  registerConnectorStatus('jira', jiraConnectorStatus);
  registerJobHandler('jira.webhook', webhookJob, { provider: 'jira', describe: (j) => `Evento do webhook do Jira (${j.payload?.issue?.key ?? 'issue'})` });
  registerJobHandler('jira.post', postJob, { provider: 'jira', concurrency: 4, describe: describePost });
  registerJobHandler('jira.unfurl', unfurlJob, { provider: 'jira', describe: (j) => `Prévia de ${(j.payload?.keys ?? []).join(', ')}` });
  registerJobHandler('jira.remotelink', remoteLinkJob, { provider: 'jira', describe: (j) => `Link da mensagem em ${j.payload?.key ?? 'issue'}` });

  registerPoller({ id: 'jira.poll', provider: 'jira', intervalMs: pollIntervalMs, enabled: pollEnabled, gapWarnMs: 60 * 60_000, run: pollJira });
  // Erro de conexão que dura mais de 1 hora vira alerta (e some quando volta). currentSite() também faz a troca de
  // endereço do §4.2 quando o Jira_Site_Url mudou pelo POST settings genérico, mesmo sem ninguém usar o Jira.
  registerPoller({
    id: 'jira.health',
    provider: 'jira',
    intervalMs: () => 5 * 60_000,
    enabled: jiraOn,
    alert: false,
    run: async () => {
      await currentSite();
      await connectionAlert(await getState<ConnectionState>('jira.status'));
    },
  });

  on('message.sent', wrapHook('jira', 'prévias do Jira', (d) => onMessageForPreview(d, false)));
  on('message.updated', wrapHook('jira', 'prévias do Jira', (d) => onMessageForPreview(d, true)));

  registerCommand({
    command: 'jira',
    params: COMMAND_TEXT.params,
    description: COMMAND_TEXT.description,
    visible: async (ctx) => (await jiraEnabled()) && (await hasPermission(ctx.userId, 'use-jira')),
    run: jiraCommand,
  });
}
