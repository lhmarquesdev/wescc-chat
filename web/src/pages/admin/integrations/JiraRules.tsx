// Integrações (Jira/Teams): Jira → Avisos nos canais (§7.3). Como o chat fica sabendo das mudanças (consulta ou
// webhook, com barra de salvar própria) e as regras que publicam nas salas.
import { useEffect, useState } from 'react';
import { JIRA_EVENT_LABEL, type JiraRule } from '@shared/integrations';
import { formatDateTime, formatRelative, plural } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Segmented, SkeletonTable, confirmDialog, useAsync } from '../../../components/ui';
import { RowMenu, TableWrap } from '../parts';
import { coreAdmin, jiraAdmin } from './admin-api';
import type { JiraTabProps } from './JiraAdmin';
import { JiraRuleModal } from './JiraRuleModal';
import { CopyBox, LoadError, RuleStatus, SaveBar, SettingRow, TabBody, copyText, done, fail, note, useDraft, useIntegrationEvents, useUnsavedGuard } from './parts';
import { roomIcon, roomName } from './RoomTargets';
import { secretTail } from './SecretField';
import './integrations-admin.css';

const POLL_MINUTES = [1, 2, 5, 10, 15];
// Prefixo do alerta jira.poll (alertText no servidor): na linha de estado fica só o motivo.
const POLL_ALERT_PREFIX = 'A consulta ao Jira falha há mais de 1 hora: ';

type Mode = 'polling' | 'webhook';

export const ruleInput = (r: JiraRule) => ({
  _id: r._id,
  name: r.name,
  enabled: r.enabled,
  projects: r.projects,
  issueTypes: r.issueTypes,
  events: r.events,
  jql: r.jql,
  roomIds: r.roomIds,
  threads: r.threads,
  mentionAssignee: r.mentionAssignee,
  grantPublisher: r.grantPublisher,
});

export function JiraRules({ config, onConfig, onDirty }: JiraTabProps) {
  const f = useDraft<{ eventsMode: Mode; pollMinutes: number }>({ eventsMode: config.eventsMode, pollMinutes: config.pollMinutes });
  const [saving, setSaving] = useState(false);
  // Segredo recém-gerado: só existe nesta resposta do servidor e some ao sair da tela.
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<'url' | 'secret' | null>(null);
  const [editing, setEditing] = useState<JiraRule | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rules = useAsync(() => jiraAdmin.rules().then((r) => r.rules), []);
  const alerts = useAsync(() => coreAdmin.alerts().then((r) => r.alerts), []);
  useIntegrationEvents(() => {
    rules.reload();
    alerts.reload();
  });
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  // Só a barra desta aba conta para "Descartar as alterações?"; o modal de regra salva sozinho.
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const mode = f.get('eventsMode');
  const minutes = f.get('pollMinutes');
  const connected = config.status.tone === 'ok' || config.status.tone === 'warn';
  const serviceDesk = new Set(config.serviceDeskProjects);
  const pollAlert = alerts.data?.find((a) => a.key === 'jira.poll');
  const list = rules.data ?? [];

  const save = async () => {
    setSaving(true);
    try {
      const r = await jiraAdmin.save(Object.fromEntries(f.changed.map((k) => [k, f.get(k)])));
      onConfig(r.config);
      if (r.webhookSecret) setSecret(r.webhookSecret);
      f.reset();
      done('Alterações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const rotate = async (what: 'url' | 'secret') => {
    const yes = await confirmDialog({
      title: what === 'secret' ? 'Gerar novo segredo?' : 'Gerar novo endereço?',
      body: 'O webhook atual deixa de funcionar até você atualizar o Jira.',
      confirmLabel: 'Gerar',
      danger: true,
    });
    if (!yes) return;
    setRotating(what);
    try {
      const r = await jiraAdmin.rotate(what);
      if (r.secret) setSecret(r.secret);
      const c = await jiraAdmin.config();
      onConfig(c.config);
      done(what === 'secret' ? 'Novo segredo gerado.' : 'Novo endereço gerado.');
    } catch (e) {
      fail(e);
    } finally {
      setRotating(null);
    }
  };

  const ack = async () => {
    try {
      await jiraAdmin.ack(config.webhookJql);
      onConfig({ ...config, webhookJqlChanged: false });
    } catch (e) {
      fail(e);
    }
  };

  const toggleRule = async (r: JiraRule) => {
    setBusy(r._id);
    try {
      await jiraAdmin.saveRule({ ...ruleInput(r), enabled: !r.enabled });
      done(r.enabled ? 'Regra desligada.' : 'Regra ligada.');
      rules.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const retryRule = async (r: JiraRule) => {
    setBusy(r._id);
    try {
      const { count } = await coreAdmin.retryAll(r._id);
      if (!count) note('Nenhum aviso com falha para tentar de novo.');
      else done(count === 1 ? '1 aviso colocado na fila de novo.' : `${count.toLocaleString('pt-BR')} avisos colocados na fila de novo.`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const removeRule = async (r: JiraRule) => {
    const yes = await confirmDialog({
      title: `Excluir a regra “${r.name}”?`,
      body: 'O Jira deixa de avisar nas salas desta regra e sai das que nenhuma outra regra usa.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    setBusy(r._id);
    try {
      await jiraAdmin.removeRule(r._id);
      done('Regra excluída.');
      rules.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const newButton = (
    <button type="button" className="btn primary" disabled={!connected} onClick={() => setEditing('new')}>
      <Icon name="int-add" />
      Nova regra
    </button>
  );

  return (
    <>
      <TabBody>
        <div className="callout info">
          <Icon name="info" />
          <span>Os avisos copiados para o chat seguem o prazo de retenção das mensagens do chat, mesmo que a issue seja apagada ou restrita depois no Jira.</span>
        </div>

        <section className="card" aria-labelledby="jira-events-title">
          <div className="card-head">
            <h2 id="jira-events-title">Como o chat fica sabendo das mudanças</h2>
          </div>
          <Segmented
            label="Como o chat fica sabendo das mudanças"
            value={mode}
            onChange={(v) => f.set('eventsMode', v)}
            items={[
              { id: 'polling', label: 'Consulta periódica' },
              { id: 'webhook', label: 'Webhook do Jira' },
            ]}
          />
          {mode === 'polling' ? (
            <>
              <SettingRow
                label="Consultar a cada"
                htmlFor="jira-poll-minutes"
                modified={f.isChanged('pollMinutes')}
                help={`Não precisa de endereço público. Os avisos chegam com até ${plural(minutes, 'minuto', 'minutos')} de atraso. Neste modo, issues excluídas não são avisadas.`}
              >
                <select id="jira-poll-minutes" value={minutes} onChange={(e) => f.set('pollMinutes', Number(e.target.value))}>
                  {POLL_MINUTES.map((n) => (
                    <option key={n} value={n}>
                      {plural(n, 'minuto', 'minutos')}
                    </option>
                  ))}
                </select>
              </SettingRow>
              {config.eventsMode === 'polling' && (
                <>
                  {pollAlert && (
                    <p className="small neg">Última consulta falhou: {pollAlert.text.startsWith(POLL_ALERT_PREFIX) ? pollAlert.text.slice(POLL_ALERT_PREFIX.length) : pollAlert.text}</p>
                  )}
                  <p className="small muted">
                    {config.lastPollAt ? (
                      <>
                        Última consulta: <time title={formatDateTime(config.lastPollAt)}>{formatRelative(config.lastPollAt)}</time>
                      </>
                    ) : (
                      'Ainda não houve consulta.'
                    )}
                  </p>
                </>
              )}
            </>
          ) : config.webhookProblem ? (
            <div className="callout warn">
              <Icon name="warning" />
              <span>{config.webhookProblem}</span>
            </div>
          ) : (
            <>
              {config.webhookJqlChanged && config.webhookUrl && (
                <div className="callout warn">
                  <Icon name="warning" />
                  <span>
                    Os projetos das regras mudaram. Atualize o filtro JQL do webhook no Jira para: <code>{config.webhookJql}</code>
                  </span>
                  <CopyAck jql={config.webhookJql} onAck={ack} />
                </div>
              )}
              {!config.webhookUrl ? (
                <p className="card-desc">Salve para gerar o endereço e o segredo do webhook.</p>
              ) : (
                <>
                  <ol className="int-steps">
                    <li>
                      <p>No Jira, abra Configurações → Sistema → WebHooks e clique em Criar um WebHook.</p>
                    </li>
                    <li>
                      <p>Em URL, cole:</p>
                      <CopyBox value={config.webhookUrl} label="Endereço do webhook" />
                    </li>
                    <li>
                      {secret ? (
                        <>
                          <p>Em Segredo, cole:</p>
                          <CopyBox value={secret} label="Segredo do webhook" />
                          <p>
                            <em>Copie agora. Depois só mostramos o final.</em>
                          </p>
                        </>
                      ) : (
                        // wrap: o texto que não cabe ao lado do botão não fica espremido numa coluna; o botão desce
                        // inteiro, e a borda dele alinha com o começo do texto.
                        <div className="row-actions wrap">
                          <span>{config.webhookSecret.set ? `Segredo cadastrado (final ${secretTail(config.webhookSecret.hint)}).` : 'Nenhum segredo cadastrado.'}</span>
                          <button type="button" className="btn small" disabled={rotating !== null} onClick={() => rotate('secret')}>
                            Gerar novo segredo
                          </button>
                        </div>
                      )}
                    </li>
                    <li>
                      <p>Em Eventos, marque Issue: criada, atualizada e excluída, e Comentário: criado.</p>
                    </li>
                    <li>
                      <p>Em JQL, use:</p>
                      {config.webhookJql ? (
                        <CopyBox value={config.webhookJql} label="Filtro JQL do webhook" onCopy={() => void ack()} />
                      ) : (
                        <p className="small muted">O filtro aparece aqui depois da primeira regra.</p>
                      )}
                    </li>
                    <li>
                      <p>Salve. Esta tela mostra quando a primeira chamada chegar.</p>
                    </li>
                  </ol>
                  <div className="row-actions wrap">
                    <span className="small muted">
                      {config.lastWebhookAt ? (
                        <>
                          Última chamada recebida: <time title={formatDateTime(config.lastWebhookAt)}>{formatRelative(config.lastWebhookAt)}</time>
                        </>
                      ) : (
                        'Nenhuma chamada recebida ainda.'
                      )}
                    </span>
                    <span className="spacer" />
                    <button type="button" className="btn small" disabled={rotating !== null} onClick={() => rotate('url')}>
                      Gerar novo endereço
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        <section className="card" aria-labelledby="jira-rules-title">
          <div className="card-head">
            <h2 id="jira-rules-title">Regras</h2>
            {list.length > 0 && newButton}
          </div>
          {!connected && (
            <div className="callout info">
              <Icon name="info" />
              <span>Teste a conexão na aba Conexão antes de criar regras.</span>
            </div>
          )}
          {rules.loading && !rules.data ? (
            <SkeletonTable rows={3} cols={5} />
          ) : rules.error && !rules.data ? (
            <LoadError text={rules.error} onRetry={rules.reload} />
          ) : !list.length ? (
            <Empty icon="int-jira" title="Nenhuma regra ainda" action={newButton}>
              Crie uma regra para avisar um canal quando issues de um projeto mudarem.
            </Empty>
          ) : (
            <TableWrap>
              <table className="table stack kv">
                <thead>
                  <tr>
                    <th>Regra</th>
                    <th>Projetos</th>
                    <th>Avisos</th>
                    <th>Salas</th>
                    <th>Situação</th>
                    <th className="actions-col">
                      <span className="visually-hidden">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    // A linha inteira abre a regra com o mouse; pelo teclado, o nome é o botão (o anel de foco fica nele,
                    // e não some atrás da primeira coluna presa da tabela).
                    <tr key={r._id} className="clickable" onClick={() => setEditing(r)}>
                      <td>
                        <button type="button" className="link cell-name" aria-label={`Editar a regra ${r.name}`} onClick={(e) => (e.stopPropagation(), setEditing(r))}>
                          {r.name}
                        </button>
                        {r.createdBy && <div className="cell-sub">por @{r.createdBy.username}</div>}
                      </td>
                      <td data-label="Projetos">
                        {r.projects.map((p) => (
                          <span key={p}>
                            <span className="chip mono" title={serviceDesk.has(p) ? 'Projeto de atendimento a clientes' : undefined}>
                              {p}
                            </span>{' '}
                          </span>
                        ))}
                      </td>
                      <td data-label="Avisos" className="nowrap">
                        <span title={r.events.map((e) => JIRA_EVENT_LABEL[e]).join(', ')}>{plural(r.events.length, 'tipo', 'tipos')}</span>
                      </td>
                      <td data-label="Salas">
                        {r.rooms.map((room) => (
                          <span key={room._id}>
                            <span className="chip">
                              <Icon name={roomIcon(room)} size={14} />
                              {roomName(room)}
                            </span>{' '}
                          </span>
                        ))}
                      </td>
                      <td data-label="Situação">
                        <RuleStatus rule={r} idle="Sem avisos ainda" stale="Sem avisos em 24 h" />
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
                                {r.lastError && (
                                  <button type="button" disabled={busy === r._id} onClick={() => (close(), void retryRule(r))}>
                                    <Icon name="int-retry" />
                                    Tentar de novo as que falharam
                                  </button>
                                )}
                                <button type="button" disabled={busy === r._id} onClick={() => (close(), void toggleRule(r))}>
                                  <Icon name={r.enabled ? 'on-hold' : 'resume'} />
                                  {r.enabled ? 'Desligar' : 'Ligar'}
                                </button>
                                <button type="button" className="danger" disabled={busy === r._id} onClick={() => (close(), void removeRule(r))}>
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
          <JiraRuleModal
            rule={editing === 'new' ? null : editing}
            config={config}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              rules.reload();
            }}
          />
        )}
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={f.reset} onSave={() => void save()} />
    </>
  );
}

// "Copiar e marcar como atualizado": copia o filtro novo e avisa o servidor que o Jira já foi atualizado.
function CopyAck({ jql, onAck }: { jql: string; onAck: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          if (!(await copyText(jql))) return;
          await onAck();
          done('Filtro copiado.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="copy" />
      Copiar e marcar como atualizado
    </button>
  );
}
