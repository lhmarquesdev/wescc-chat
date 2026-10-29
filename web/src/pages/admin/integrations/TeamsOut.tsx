// Integrações (Jira/Teams): Microsoft Teams → Envio para o Teams (§7.4): regras que copiam mensagens de salas do chat
// para um canal do Teams por um fluxo do Workflows.
import { useState } from 'react';
import type { TeamsOutFilter, TeamsOutRule, TeamsOutRuleInput } from '@shared/integrations';
import { Icon } from '../../../components/Icon';
import { Empty, SkeletonTable, confirmDialog, useAsync } from '../../../components/ui';
import { RowMenu, TableWrap } from '../parts';
import { coreAdmin, teamsAdmin } from './admin-api';
import { LoadError, RuleStatus, done, fail, useIntegrationEvents } from './parts';
import { roomIcon, roomName } from './RoomTargets';
import { TeamsOffNote, type TeamsTabProps } from './TeamsAdmin';
import { TeamsOutModal } from './TeamsOutModal';
import './integrations-admin.css';

export const FILTER_LABEL: Record<TeamsOutFilter, string> = { all: 'Todas', root: 'Só principais', ack: 'Só avisos com Ciente', keywords: 'Com palavras-chave' };
const FLOW_RUNS = 'https://make.powerautomate.com';

export const outInput = (r: TeamsOutRule): TeamsOutRuleInput & { _id: string } => ({
  _id: r._id,
  name: r.name,
  enabled: r.enabled,
  roomIds: r.roomIds,
  filter: r.filter,
  keywords: r.keywords,
  includeBots: r.includeBots,
  includeFiles: r.includeFiles,
  includeLink: r.includeLink,
  destinationLabel: r.destinationLabel,
  destinationPrivate: r.destinationPrivate,
  flowOwner: r.flowOwner,
  budget: r.budget,
  auth: r.auth,
});

export function TeamsOut({ config }: TeamsTabProps) {
  const list = useAsync(() => (config.enabled ? teamsAdmin.outList().then((r) => r.rules) : Promise.resolve(null)), [config.enabled]);
  useIntegrationEvents(list.reload);
  const [editing, setEditing] = useState<TeamsOutRule | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rules = list.data ?? [];

  const run = async (r: TeamsOutRule, fn: () => Promise<void>) => {
    setBusy(r._id);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const sendTest = (r: TeamsOutRule) =>
    run(r, async () => {
      const res = await teamsAdmin.outTest(r._id);
      if (res.ok) done(res.text);
      else fail(new Error(res.text));
      list.reload();
    });

  const toggle = (r: TeamsOutRule) =>
    run(r, async () => {
      await teamsAdmin.outSave({ ...outInput(r), enabled: !r.enabled });
      done(r.enabled ? 'Regra desligada.' : 'Regra ligada.');
      list.reload();
    });

  const retry = (r: TeamsOutRule) =>
    run(r, async () => {
      const { count } = await coreAdmin.retryAll(r._id);
      done(count === 1 ? '1 mensagem colocada na fila de novo.' : `${count.toLocaleString('pt-BR')} mensagens colocadas na fila de novo.`);
    });

  const remove = async (r: TeamsOutRule) => {
    const yes = await confirmDialog({
      title: `Excluir a regra “${r.name}”?`,
      body: 'As mensagens destas salas deixam de ir para o Teams. O fluxo do Workflows continua existindo no Power Automate.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    await run(r, async () => {
      await teamsAdmin.outRemove(r._id);
      done('Regra excluída.');
      list.reload();
    });
  };

  const newButton = (
    <button type="button" className="btn primary" disabled={!config.enabled} onClick={() => setEditing('new')}>
      <Icon name="int-add" />
      Nova regra
    </button>
  );

  return (
    <>
      {/* Como na aba Avisos do Jira: o texto de apoio no topo e as regras num cartão com a ação no cabeçalho. */}
      <div className="callout info">
        <Icon name="info" />
        <span>
          Copie as mensagens de salas do chat para um canal do Teams. Cada regra usa um fluxo do Workflows criado no canal de destino. O Workflows aceita cerca de 25 posts a cada 5 minutos por dono do
          fluxo; acima disso, as mensagens vão em resumo.
        </span>
      </div>
      <section className="card" aria-labelledby="teams-out-title">
        <div className="card-head">
          <h2 id="teams-out-title">Regras de envio</h2>
          {rules.length > 0 && newButton}
        </div>
        {!config.enabled ? (
          <TeamsOffNote />
        ) : list.loading && !list.data ? (
          <SkeletonTable rows={3} cols={6} />
        ) : list.error && !list.data ? (
          <LoadError text={list.error} onRetry={list.reload} />
        ) : !rules.length ? (
          <Empty icon="int-teams" title="Nenhum envio configurado" action={newButton}>
            Crie uma regra para copiar as mensagens de uma sala para um canal do Teams.
          </Empty>
        ) : (
          <TableWrap>
            <table className="table stack kv">
              <thead>
                <tr>
                  <th>Regra</th>
                  <th>Salas do chat</th>
                  <th>Destino no Teams</th>
                  <th>Quais mensagens</th>
                  <th>Limite</th>
                  <th>Situação</th>
                  <th className="actions-col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  // A linha abre a regra com o mouse; pelo teclado, o nome é o botão (o anel de foco fica nele, à vista).
                  <tr key={r._id} className="clickable" onClick={() => setEditing(r)}>
                    <td>
                      <button type="button" className="link cell-name" aria-label={`Editar a regra ${r.name}`} onClick={(e) => (e.stopPropagation(), setEditing(r))}>
                        {r.name}
                      </button>
                      {r.createdBy && <div className="cell-sub">por @{r.createdBy.username}</div>}
                    </td>
                    <td data-label="Salas do chat">
                      {r.rooms.map((room) => (
                        <span key={room._id}>
                          <span className="chip">
                            <Icon name={roomIcon(room)} size={14} />
                            {roomName(room)}
                          </span>{' '}
                        </span>
                      ))}
                    </td>
                    <td data-label="Destino no Teams">
                      {r.destinationLabel || <span className="muted">{r.urlHost ?? '—'}</span>}
                      {r.destinationPrivate && (
                        <>
                          {' '}
                          <span className="pill">Privado</span>
                        </>
                      )}
                    </td>
                    <td data-label="Quais mensagens" className="nowrap">
                      {FILTER_LABEL[r.filter]}
                    </td>
                    <td data-label="Limite">
                      {/* Uma peça só: empilhada no celular, a célula alinha o valor à direita do rótulo. */}
                      <div>
                        {r.budget} a cada 5 min
                        {r.flowOwner && <div className="cell-sub">{r.flowOwner}</div>}
                      </div>
                    </td>
                    <td data-label="Situação">
                      <RuleStatus rule={r} idle="Sem envios ainda" stale="Sem envios em 24 h" />
                    </td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <RowMenu>
                          {(close) => (
                            <>
                              <button type="button" onClick={() => (close(), setEditing(r))}>
                                <Icon name="edit" />
                                Editar
                              </button>
                              <button type="button" disabled={busy === r._id} onClick={() => (close(), void sendTest(r))}>
                                <Icon name="send" />
                                Enviar teste
                              </button>
                              <button type="button" onClick={() => (close(), window.open(FLOW_RUNS, '_blank', 'noopener,noreferrer'))}>
                                <Icon name="open-external" />
                                Ver execuções do fluxo
                              </button>
                              {r.lastError && (
                                <button type="button" disabled={busy === r._id} onClick={() => (close(), void retry(r))}>
                                  <Icon name="int-retry" />
                                  Tentar de novo as que falharam
                                </button>
                              )}
                              <button type="button" disabled={busy === r._id} onClick={() => (close(), void toggle(r))}>
                                <Icon name={r.enabled ? 'on-hold' : 'resume'} />
                                {r.enabled ? 'Desligar' : 'Ligar'}
                              </button>
                              <button type="button" className="danger" disabled={busy === r._id} onClick={() => (close(), void remove(r))}>
                                <Icon name="delete" />
                                Excluir
                              </button>
                            </>
                          )}
                        </RowMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      {editing && (
        <TeamsOutModal
          rule={editing === 'new' ? null : editing}
          config={config}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}
