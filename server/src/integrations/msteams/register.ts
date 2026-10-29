// Registra, uma vez, as tarefas da fila, as renovações, a leitura periódica (só com o aceite), a presença, o gancho
// message.sent (com wrapHook) e o /teams.
import { registerCommand } from '../../services/commands';
import { on } from '../../services/hooks';
import { registerConnectorStatus } from '../core-api';
import { registerJobHandler } from '../jobs';
import { registerDailyCheck, registerPoller, wrapHook } from '../runtime';
import { commandVisible, COMMAND_TEXT, teamsCommand } from './command';
import { connectorStatus, teamsOn } from './config';
import { pollEnabled, pollIntervalMs, pollTeams } from './delta';
import { catchupJob, lifecycleJob, notifyJob, renewAll } from './notifications';
import { digestJob, onMessageSent, postJob, silentFlowCheck } from './outgoing';
import { presenceEnabled, presenceIntervalMs, presenceJob, presenceRun } from './presence';
import './serviceAccount';

let registered = false;

export function registerMsteams() {
  if (registered) return;
  registered = true;

  // A atividade já mostra o nome da regra (integration_id); a descrição diz só o que a tarefa fazia.
  registerJobHandler('msteams.post', postJob, { provider: 'msteams', concurrency: 4, describe: () => 'Envio para o Teams' });
  registerJobHandler('msteams.digest', digestJob, { provider: 'msteams', describe: () => 'Resumo para o Teams' });
  registerJobHandler('msteams.notify', notifyJob, { provider: 'msteams', concurrency: 4, describe: () => 'Mensagem do Teams' });
  registerJobHandler('msteams.catchup', catchupJob, { provider: 'msteams', describe: () => 'Leitura de recuperação do canal do Teams' });
  registerJobHandler('msteams.lifecycle', lifecycleJob, { provider: 'msteams', describe: () => 'Aviso de assinatura do Microsoft 365' });
  registerJobHandler('msteams.presence', presenceJob, { provider: 'msteams', describe: () => 'Presença do Teams' });

  // Assinaturas (mensagens e presença) renovadas a cada 5 minutos; sem uso, apagadas.
  registerPoller({
    id: 'msteams.subs',
    provider: 'msteams',
    intervalMs: () => 5 * 60_000,
    enabled: teamsOn,
    alert: false,
    run: renewAll,
  });
  registerPoller({ id: 'msteams.in', provider: 'msteams', intervalMs: pollIntervalMs, enabled: pollEnabled, gapWarnMs: 60 * 60_000, alert: false, run: pollTeams });
  registerPoller({ id: 'msteams.presence', provider: 'msteams', intervalMs: presenceIntervalMs, enabled: presenceEnabled, alert: false, run: presenceRun });

  on('message.sent', wrapHook('msteams', 'envio para o Teams', onMessageSent));
  registerDailyCheck(silentFlowCheck);

  registerCommand({ command: 'teams', params: COMMAND_TEXT.params, description: COMMAND_TEXT.description, visible: commandVisible, run: teamsCommand });

  registerConnectorStatus('msteams', connectorStatus);
}
