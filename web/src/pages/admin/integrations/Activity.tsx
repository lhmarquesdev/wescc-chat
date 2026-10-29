// Integrações (Jira/Teams): atividade de um provedor (§7.5): publicações, avisos e falhas, com nova tentativa.
import { useState } from 'react';
import type { IntegrationActivity, Provider } from '@shared/integrations';
import { formatDateTime, formatRelative } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Pager, Segmented, SkeletonTable, useAsync } from '../../../components/ui';
import { TableWrap } from '../parts';
import { coreAdmin, jiraAdmin, teamsAdmin } from './admin-api';
import { LoadError, done, fail, useIntegrationEvents } from './parts';
import './integrations-admin.css';

const PER_PAGE = 50;

const TONE: Record<IntegrationActivity['tone'], { cls: string; text: string }> = {
  ok: { cls: 'pill ok', text: 'Feito' },
  warn: { cls: 'pill warn', text: 'Atenção' },
  err: { cls: 'pill err', text: 'Falhou' },
  info: { cls: 'pill', text: 'Info' },
};

async function rulesOf(provider: Provider): Promise<{ _id: string; name: string }[]> {
  if (provider === 'jira') return (await jiraAdmin.rules()).rules.map((r) => ({ _id: r._id, name: r.name }));
  // Com o Teams desligado as listas respondem erro: o filtro fica só com "Todas as regras".
  const [out, inn] = await Promise.all([teamsAdmin.outList().catch(() => ({ rules: [] })), teamsAdmin.inList().catch(() => ({ rules: [] }))]);
  return [...out.rules, ...inn.rules].map((r) => ({ _id: r._id, name: r.name }));
}

export function Activity({ provider }: { provider: Provider }) {
  const [errorsOnly, setErrorsOnly] = useState<'all' | 'err'>('all');
  const [rule, setRule] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const rules = useAsync(() => rulesOf(provider), [provider]);
  const list = useAsync(
    () => coreAdmin.activity({ provider, integrationId: rule || null, tone: errorsOnly === 'err' ? 'err' : null, offset, count: PER_PAGE }),
    [provider, rule, errorsOnly, offset],
  );
  useIntegrationEvents(list.reload);
  const rows = list.data?.activity ?? [];
  const canRetryAll = !!rule && rows.some((r) => r.canRetry);

  const retry = async (row: IntegrationActivity) => {
    if (!row.jobId) return;
    setBusy(row._id);
    try {
      await coreAdmin.retry(row.jobId);
      done('Tarefa colocada na fila de novo.');
      list.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const retryAll = async () => {
    setBusy('all');
    try {
      const { count } = await coreAdmin.retryAll(rule);
      done(count === 1 ? '1 tarefa colocada na fila de novo.' : `${count.toLocaleString('pt-BR')} tarefas colocadas na fila de novo.`);
      list.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="filters admin-filters">
        <Segmented
          label="Mostrar"
          value={errorsOnly}
          onChange={(v) => (setErrorsOnly(v), setOffset(0))}
          items={[
            { id: 'all', label: 'Tudo' },
            { id: 'err', label: 'Erros' },
          ]}
        />
        <select aria-label="Regra" value={rule} onChange={(e) => (setRule(e.target.value), setOffset(0))}>
          <option value="">Todas as regras</option>
          {(rules.data ?? []).map((r) => (
            <option key={r._id} value={r._id}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {canRetryAll && (
          <button type="button" className="btn small" disabled={busy === 'all'} onClick={retryAll}>
            <Icon name="int-retry" />
            Tentar de novo todas
          </button>
        )}
      </div>
      {list.loading && !list.data ? (
        <SkeletonTable rows={6} cols={4} />
      ) : list.error && !list.data ? (
        <LoadError text={list.error} onRetry={list.reload} />
      ) : !rows.length ? (
        <Empty icon="int-activity" title="Nada por aqui ainda">
          As publicações e os erros das integrações aparecem aqui.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Situação</th>
                <th>O quê</th>
                <th>Detalhe</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td className="nowrap">
                    <time dateTime={r.at} title={formatDateTime(r.at)}>
                      {formatRelative(r.at)}
                    </time>
                  </td>
                  <td data-label="Situação">
                    <span className={TONE[r.tone].cls}>{TONE[r.tone].text}</span>
                  </td>
                  <td data-label="O quê">
                    {/* Uma peça só: empilhada no celular, a célula alinha o valor à direita do rótulo. */}
                    <div>
                      {r.text}
                      {r.integrationName && !rule && <div className="cell-sub">{r.integrationName}</div>}
                    </div>
                  </td>
                  <td data-label="Detalhe" className="mono muted small">
                    {r.detail || '—'}
                  </td>
                  <td className="actions-col">
                    {r.canRetry && r.jobId && (
                      <div className="row-actions">
                        <button type="button" className="btn small ghost" disabled={busy === r._id} onClick={() => retry(r)}>
                          <Icon name="int-retry" />
                          Tentar de novo
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {list.data && list.data.total > PER_PAGE && <Pager offset={offset} count={PER_PAGE} total={list.data.total} onChange={setOffset} />}
    </>
  );
}
