// Integrações (Jira/Teams): Microsoft Teams → Mensagens do Teams (§7.4): como as mensagens chegam (notificações ou
// leitura periódica, com o aceite por escrito) e as regras canal do Teams → sala do chat.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TeamsInRule } from '@shared/integrations';
import { formatDateTime, formatRelative, formatTime, plural } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, SkeletonTable, confirmDialog, useAsync } from '../../../components/ui';
import { RowMenu, TableWrap } from '../parts';
import { coreAdmin, teamsAdmin } from './admin-api';
import { LoadError, Radio, SaveBar, SettingRow, TabBody, done, fail, useDraft, useIntegrationEvents, useUnsavedGuard } from './parts';
import { roomIcon, roomName } from './RoomTargets';
import { TeamsOffNote, type TeamsTabProps } from './TeamsAdmin';
import { TeamsInModal } from './TeamsInModal';
import './integrations-admin.css';

type Mode = 'off' | 'notifications' | 'polling';
const POLL_MINUTES = [1, 2, 5, 10, 15];
const IN_SCOPES = ['ChannelMessage.Read.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All'];
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const POLLING_ACCEPT = 'Para usar a leitura periódica, confirme que leu o aviso sobre a recomendação da Microsoft.';

export const inInput = (r: TeamsInRule) => ({
  _id: r._id,
  name: r.name,
  enabled: r.enabled,
  teamId: r.team.id,
  channelId: r.channel.id,
  roomId: r.roomId,
  replies: r.replies,
  edits: r.edits,
  deletes: r.deletes,
  grantPublisher: r.grantPublisher,
  acknowledgePrivate: r.channel.membership !== 'standard',
});

function InStatus({ rule, notifications }: { rule: TeamsInRule; notifications: boolean }) {
  if (!rule.enabled) return <span className="pill">Desligada</span>;
  const okAt = rule.lastOkAt ? new Date(rule.lastOkAt).getTime() : 0;
  const errAt = rule.lastErrorAt ? new Date(rule.lastErrorAt).getTime() : 0;
  const failing = !!rule.lastError && errAt >= okAt;
  // Uma peça só: empilhada no celular, a célula alinha o valor à direita do rótulo.
  return (
    <div>
      {failing ? (
        <span className="pill err" title={rule.lastError ?? undefined}>
          Com erro
        </span>
      ) : (
        <span className="nowrap">
          {rule.lastEventAt ? (
            <>
              Última mensagem <time title={formatDateTime(rule.lastEventAt)}>{formatRelative(rule.lastEventAt)}</time>
            </>
          ) : (
            <span className="muted">Nenhuma mensagem ainda</span>
          )}
        </span>
      )}
      {notifications && rule.subscriptionExpiresAt && <div className="cell-sub">Assinatura válida até {formatTime(rule.subscriptionExpiresAt)}</div>}
    </div>
  );
}

export function TeamsIn({ config, onConfig, onDirty }: TeamsTabProps) {
  const navigate = useNavigate();
  const f = useDraft<{ inboundMode: Mode; pollMinutes: number }>({ inboundMode: config.inboundMode, pollMinutes: config.pollMinutes });
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<TeamsInRule | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const svc = config.serviceAccount;
  const missing = config.granted.delegated.length ? IN_SCOPES.filter((s) => !config.granted.delegated.some((d) => d.toLowerCase() === s.toLowerCase())) : [];
  const ready = svc.linked && !missing.length;
  const list = useAsync(() => (config.enabled && ready ? teamsAdmin.inList().then((r) => r.rules) : Promise.resolve(null)), [config.enabled, ready]);
  useIntegrationEvents(list.reload);
  const rules = list.data ?? [];
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const mode = f.get('inboundMode');
  const minutes = f.get('pollMinutes');
  const newPolling = mode === 'polling' && config.inboundMode !== 'polling';

  const discard = () => {
    f.reset();
    setAccepted(false);
  };
  const save = async () => {
    if (newPolling && !accepted) {
      fail(new Error(POLLING_ACCEPT));
      return;
    }
    setSaving(true);
    try {
      const input = { ...Object.fromEntries(f.changed.map((k) => [k, f.get(k)])), ...(newPolling ? { acceptPolling: true } : {}) };
      const r = await teamsAdmin.save(input);
      onConfig(r.config);
      f.reset();
      setAccepted(false);
      done('Alterações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const run = async (r: TeamsInRule, fn: () => Promise<void>) => {
    setBusy(r._id);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const toggle = (r: TeamsInRule) =>
    run(r, async () => {
      await teamsAdmin.inSave({ ...inInput(r), enabled: !r.enabled });
      done(r.enabled ? 'Regra desligada.' : 'Regra ligada.');
      list.reload();
    });
  const retry = (r: TeamsInRule) =>
    run(r, async () => {
      const { count } = await coreAdmin.retryAll(r._id);
      done(count === 1 ? '1 mensagem colocada na fila de novo.' : `${count.toLocaleString('pt-BR')} mensagens colocadas na fila de novo.`);
    });
  const remove = async (r: TeamsInRule) => {
    const yes = await confirmDialog({
      title: `Excluir a regra “${r.name}”?`,
      body: 'As mensagens deste canal do Teams deixam de chegar à sala. As que já foram copiadas continuam no chat.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    await run(r, async () => {
      await teamsAdmin.inRemove(r._id);
      done('Regra excluída.');
      list.reload();
    });
  };

  const newButton = (
    <button type="button" className="btn primary" disabled={config.inboundMode === 'off'} onClick={() => setEditing('new')}>
      <Icon name="int-add" />
      Nova regra
    </button>
  );

  return (
    <>
      <TabBody>
        <section className="card" aria-labelledby="teams-in-mode-title">
          <div className="card-head">
            <h2 id="teams-in-mode-title">Como as mensagens do Teams chegam</h2>
          </div>
          <div className="form">
            <div className="toggle-list" role="radiogroup" aria-labelledby="teams-in-mode-title">
              <Radio name="teams-in-mode" value="off" current={mode} onChange={(v) => f.set('inboundMode', v)}>
                Desligado
              </Radio>
              <Radio
                name="teams-in-mode"
                value="notifications"
                current={mode}
                disabled={!config.notificationsUrl}
                hint={
                  config.notificationsUrl
                    ? 'O Microsoft 365 avisa o chat na hora. Precisa do chat publicado com https e certificado de uma autoridade pública; só o endereço /hooks/msteams/ precisa ficar acessível pela internet.'
                    : config.notificationsProblem
                }
                onChange={(v) => f.set('inboundMode', v)}
              >
                Notificações do Microsoft 365 (recomendado)
              </Radio>
              <Radio
                name="teams-in-mode"
                value="polling"
                current={mode}
                disabled={!!config.pollingUnavailable && config.inboundMode !== 'polling'}
                hint={config.pollingUnavailable ? 'A leitura periódica não está disponível neste locatário do Microsoft 365.' : undefined}
                onChange={(v) => f.set('inboundMode', v)}
              >
                Leitura periódica
              </Radio>
          </div>
          {mode === 'polling' && (
            <>
              <div className="callout warn">
                <Icon name="warning" />
                <span>
                  A Microsoft só permite que um aplicativo consulte o Teams em busca de mensagens novas uma vez por dia e recomenda as notificações. Consultar a cada {plural(minutes, 'minuto', 'minutos')} vai
                  contra essa regra: a Microsoft pode limitar ou suspender o aplicativo, e isso também pararia as reuniões criadas pelo chat e a presença.
                  {config.inboundMode === 'polling' && config.pollingAcceptedAt && (
                    <>
                      {' '}
                      Aceito por {config.pollingAcceptedBy ? `@${config.pollingAcceptedBy}` : 'um administrador'} em {dateFmt.format(new Date(config.pollingAcceptedAt))}.
                    </>
                  )}
                </span>
              </div>
              {newPolling && (
                <label className="check">
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <span>Entendo o risco, e o responsável pela empresa aceitou por escrito usar a leitura periódica.</span>
                </label>
              )}
              <SettingRow label="Ler os canais a cada" htmlFor="teams-poll-minutes" modified={f.isChanged('pollMinutes')}>
                <select id="teams-poll-minutes" value={minutes} onChange={(e) => f.set('pollMinutes', Number(e.target.value))}>
                  {POLL_MINUTES.map((n) => (
                    <option key={n} value={n}>
                      {plural(n, 'minuto', 'minutos')}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </>
          )}
          </div>
        </section>

        {!config.enabled ? (
          <TeamsOffNote />
        ) : !ready ? (
          <Empty
            icon="int-teams"
            title="Ainda não dá para receber mensagens do Teams"
            action={
              <button type="button" className="btn" onClick={() => navigate('/admin/integrations/teams/conexao')}>
                Ir para Conexão
              </button>
            }
          >
            Sem um aplicativo instalado no Teams, o chat lê os canais com uma conta de serviço. Configure o aplicativo do Entra e entre com a conta de serviço na aba Conexão.
          </Empty>
        ) : (
          <section className="card" aria-labelledby="teams-in-rules-title">
            <div className="card-head">
              <div>
                <h2 id="teams-in-rules-title">Regras de recebimento</h2>
                <p className="card-desc">Copie as mensagens de um canal do Teams para uma sala do chat. Respostas viram tópicos; edições e exclusões também são copiadas.</p>
              </div>
              {rules.length > 0 && newButton}
            </div>
            <div className="callout info">
              <Icon name="info" />
              <span>
                As mensagens copiadas do Teams ficam no chat pelo prazo de retenção das mensagens do chat, fora do eDiscovery e dos rótulos de retenção do Microsoft 365. Apagar no Teams só apaga aqui com
                Copiar exclusões ligado.
              </span>
            </div>
            {list.loading && !list.data ? (
              <SkeletonTable rows={3} cols={4} />
            ) : list.error && !list.data ? (
              <LoadError text={list.error} onRetry={list.reload} />
            ) : !rules.length ? (
              <Empty icon="int-teams" title="Nenhum recebimento configurado" action={newButton}>
                {config.inboundMode === 'off' ? 'Escolha acima como as mensagens do Teams chegam e crie uma regra.' : 'Crie uma regra para copiar as mensagens de um canal do Teams para uma sala.'}
              </Empty>
            ) : (
              <TableWrap>
                <table className="table stack kv">
                  <thead>
                    <tr>
                      <th>Regra</th>
                      <th>Canal do Teams</th>
                      <th>Sala do chat</th>
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
                        <td data-label="Canal do Teams">
                          {r.team.name} › {r.channel.name}
                          {r.channel.membership !== 'standard' && (
                            <>
                              {' '}
                              <span className="pill">Privado</span>
                            </>
                          )}
                        </td>
                        <td data-label="Sala do chat">
                          {r.room ? (
                            <span className="chip">
                              <Icon name={roomIcon(r.room)} size={14} />
                              {roomName(r.room)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Situação">
                          <InStatus rule={r} notifications={config.inboundMode === 'notifications'} />
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
        )}
        {editing && (
          <TeamsInModal
            rule={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              list.reload();
            }}
          />
        )}
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={discard} onSave={() => void save()} />
    </>
  );
}
