import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../lib/api';
import { formatBytes, formatDateTime } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Empty, Modal, Pager, SkeletonTable, useAsync } from '../../../components/ui';
import { fail, isBusy, isFinal, isImporting, num, ok, operationPath, plural, StatusPill, useImportEvents, Warnings, warningCount } from './common';
import type { ImportErrorRow, ImportOperation } from './types';

const PAGE = 20;

const TYPE_LABEL: Record<string, string> = { user: 'Usuário', channel: 'Canal', message: 'Mensagem', contact: 'Contato' };

export function ImportHistory({ canRun }: { canRun: boolean }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const history = useAsync(() => api.get<{ operations: ImportOperation[]; total: number }>('getLatestImportOperations', { offset, count: PAGE }), [offset]);
  const [current, setCurrent] = useState<ImportOperation | null>(null);
  const [pending, setPending] = useState({ files: 0, avatars: 0 });
  const [starting, setStarting] = useState<'files' | 'avatars' | null>(null);
  const [details, setDetails] = useState<ImportOperation | null>(null);
  const reloadTimer = useRef<number | undefined>(undefined);

  const loadCurrent = useCallback(async () => {
    if (!canRun) return;
    try {
      const r = await api.get<{ operation: ImportOperation | null }>('getCurrentImportOperation');
      setCurrent(r.operation);
    } catch (e) {
      fail(e);
    }
  }, [canRun]);
  const loadPending = useCallback(async () => {
    if (!canRun) return;
    try {
      setPending(await api.get<{ files: number; avatars: number }>('import.pending'));
    } catch {
      // os botões só ficam escondidos
    }
  }, [canRun]);
  const reloadAll = useCallback(() => {
    void loadCurrent();
    void loadPending();
    history.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCurrent, loadPending]);

  useEffect(() => {
    void loadCurrent();
    void loadPending();
  }, [loadCurrent, loadPending]);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  // Atualiza a linha da operação atual ao vivo; outra operação ou o fim de uma recarrega a lista.
  const reloadSoon = () => {
    if (reloadTimer.current) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = undefined;
      reloadAll();
    }, 800);
  };
  useImportEvents((p) => {
    if (current && p._id === current._id) {
      setCurrent({
        ...current,
        status: p.status,
        valid: p.valid,
        count: p.count,
        error: p.error ?? current.error,
        messagesstatus: p.messagesstatus !== undefined ? p.messagesstatus : current.messagesstatus,
        _updatedAt: new Date().toISOString(),
      });
      if (isFinal(p.status) && !isFinal(current.status)) reloadSoon();
    } else reloadSoon();
  });

  const startPending = async (kind: 'files' | 'avatars') => {
    setStarting(kind);
    try {
      const r = await api.post<{ count: number; operation: ImportOperation }>(kind === 'files' ? 'downloadPendingFiles' : 'downloadPendingAvatars');
      if (!r.count) {
        ok(kind === 'files' ? 'Nenhum arquivo pendente para baixar.' : 'Nenhuma foto de perfil pendente para baixar.');
        setStarting(null);
        reloadAll();
        return;
      }
      ok(kind === 'files' ? `Download de ${plural(r.count, 'arquivo', 'arquivos')} iniciado.` : `Download de ${plural(r.count, 'foto', 'fotos')} de perfil iniciado.`);
      navigate('/admin/import/progress');
    } catch (e) {
      fail(e);
      setStarting(null);
    }
  };

  const showCurrent = canRun && offset === 0 && current?.valid;
  const rows = [...(showCurrent && current ? [current] : []), ...(history.data?.operations ?? []).filter((o) => !showCurrent || o._id !== current?._id)];
  const currentBusy = !!current?.valid && isBusy(current.status);

  return (
    <>
      <div className="page-title-row page-head">
        <h1>Importação</h1>
        {canRun && (
          <div className="page-actions">
            {pending.files > 0 && (
              <button className="btn" disabled={starting !== null || currentBusy} title={currentBusy ? 'Espere a importação atual terminar.' : undefined} onClick={() => void startPending('files')}>
                {starting === 'files' ? (
                  'Iniciando…'
                ) : (
                  <>
                    <Icon name="download" />
                    {`Baixar arquivos pendentes (${num(pending.files)})`}
                  </>
                )}
              </button>
            )}
            {pending.avatars > 0 && (
              <button className="btn" disabled={starting !== null || currentBusy} title={currentBusy ? 'Espere a importação atual terminar.' : undefined} onClick={() => void startPending('avatars')}>
                {starting === 'avatars' ? (
                  'Iniciando…'
                ) : (
                  <>
                    <Icon name="download" />
                    {`Baixar fotos pendentes (${num(pending.avatars)})`}
                  </>
                )}
              </button>
            )}
            <button className="btn primary" onClick={() => navigate('/admin/import/new')}>
              <Icon name="add" />
              Importar arquivo
            </button>
          </div>
        )}
      </div>
      {canRun && (pending.files > 0 || pending.avatars > 0) && (
        <p className="muted small imp-lead">Os arquivos das mensagens e as fotos de perfil de importações como a do Slack ficam na origem até serem baixados por estes botões.</p>
      )}
      {history.loading && !history.data ? (
        <SkeletonTable rows={5} cols={5} />
      ) : history.error ? (
        <div className="form-error">Não foi possível carregar o histórico: {history.error}</div>
      ) : !rows.length ? (
        // Sem botão aqui: o "Importar arquivo" do cabeçalho é o único (o E2E o procura pelo nome).
        <Empty icon="admin-import" title="Nenhuma importação ainda">
          {canRun ? 'Use "Importar arquivo" para trazer dados do Slack, de planilhas CSV ou contatos do omnichannel.' : 'As importações feitas aparecem aqui, com a situação e as contagens.'}
        </Empty>
      ) : (
        <div className="imp-table-wrap">
          <table className="table imp-history">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Atualizado em</th>
                <th>Situação</th>
                <th className="imp-opt">Arquivo</th>
                <th className="imp-opt imp-mid">Itens</th>
                <th className="imp-opt imp-wide num">Usuários</th>
                <th className="imp-opt imp-wide num">Canais</th>
                <th className="imp-opt imp-wide num">Mensagens</th>
                <th className="imp-opt imp-wide num">Contatos</th>
                <th className="imp-opt imp-wide num">Total</th>
                <th className="imp-opt num">Erros</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((op) => (
                <HistoryRow key={op._id} op={op} isCurrent={!!showCurrent && op._id === current?._id} onNavigate={(p) => navigate(p)} onDetails={() => setDetails(op)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history.data && <Pager offset={offset} count={PAGE} total={history.data.total} onChange={setOffset} />}
      {details && <OperationDetails op={details} canRun={canRun} onClose={() => setDetails(null)} />}
    </>
  );
}

function HistoryRow({ op, isCurrent, onNavigate, onDetails }: { op: ImportOperation; isCurrent: boolean; onNavigate: (path: string) => void; onDetails: () => void }) {
  const path = isCurrent ? operationPath(op) : null;
  const hasDetails = op.count.error > 0 || op.warnings.length > 0 || !!op.error;
  const open = path ? () => onNavigate(path) : hasDetails ? onDetails : null;
  const onKey = (e: KeyboardEvent) => {
    if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open();
    }
  };
  const c = op.count;
  return (
    <tr
      className={`${open ? 'clickable' : ''} ${isCurrent ? 'imp-current' : ''}`}
      onClick={open ?? undefined}
      onKeyDown={open ? onKey : undefined}
      tabIndex={open ? 0 : undefined}
      role={path ? 'link' : open ? 'button' : undefined}
      title={path ? (isImporting(op.status) ? 'Ver o progresso' : 'Continuar esta importação') : open ? 'Ver erros e avisos' : undefined}
    >
      <td>
        <strong>{op.type}</strong>
        {isCurrent && <span className="pill accent imp-tag">atual</span>}
      </td>
      <td className="nowrap">{formatDateTime(op._updatedAt)}</td>
      <td>
        <StatusPill status={op.status} />
        {path && (
          <div className="imp-go small">
            {isImporting(op.status) ? 'Ver progresso' : 'Continuar'}
            <Icon name="next" size={14} />
          </div>
        )}
      </td>
      <td className="imp-opt ellipsis-cell" title={op.file ? `${op.file}${op.fileSize ? ` (${formatBytes(op.fileSize)})` : ''}` : undefined}>
        {op.file ?? <span className="muted">—</span>}
      </td>
      <td className="imp-opt imp-mid">{itemsSummary(c)}</td>
      <td className="imp-opt imp-wide num">{num(c.users)}</td>
      <td className="imp-opt imp-wide num">{num(c.channels)}</td>
      <td className="imp-opt imp-wide num">{num(c.messages)}</td>
      <td className="imp-opt imp-wide num">{num(c.contacts)}</td>
      <td className="imp-opt imp-wide num">{num(c.total)}</td>
      <td className="imp-opt num nowrap">
        <span className={c.error ? 'neg' : ''}>{num(c.error)}</span>
        {op.warnings.length > 0 && (
          <span className="imp-warn-mark" title={plural(warningCount(op.warnings), 'aviso', 'avisos')} aria-label={plural(warningCount(op.warnings), 'aviso', 'avisos')}>
            <Icon name="warning" size={14} />
          </span>
        )}
      </td>
    </tr>
  );
}

// Em telas médias as contagens viram uma coluna só, para a tabela caber sem rolagem lateral.
function itemsSummary(c: ImportOperation['count']) {
  const parts = [
    c.users > 0 && plural(c.users, 'usuário', 'usuários'),
    c.channels > 0 && plural(c.channels, 'canal', 'canais'),
    c.messages > 0 && plural(c.messages, 'mensagem', 'mensagens'),
    c.contacts > 0 && plural(c.contacts, 'contato', 'contatos'),
  ].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return c.total > 0 ? plural(c.total, 'item', 'itens') : <span className="muted">—</span>;
}

function OperationDetails({ op, canRun, onClose }: { op: ImportOperation; canRun: boolean; onClose: () => void }) {
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const pendingKind = op.importerKey.startsWith('pending-');
  const c = op.count;
  const hasErrors = c.error > 0 && !pendingKind;
  // import.errors exige run-import: os registros com erro trazem nomes e e-mails. Quem só vê o histórico fica com as
  // contagens, o erro da operação e os avisos. A conversão também deixa avisos em registros importados (papel ignorado,
  // nome de usuário ou de sala trocado, conta não desativada), que não contam como erro: por isso a lista é pedida
  // sempre que a importação chegou a gravar algo.
  const wantErrors = canRun && !pendingKind && (c.error > 0 || c.completed > 0);
  const { data, loading, error } = useAsync(
    () =>
      wantErrors
        ? api.get<{ errors: ImportErrorRow[]; total: number }>('import.errors', { operationId: op._id, type: type || undefined, offset, count: 25 })
        : Promise.resolve({ errors: [], total: 0 }),
    [type, offset],
  );
  const showErrors = wantErrors && (hasErrors || !!type || !!data?.total);
  return (
    <Modal
      wide
      title={`${op.type} · ${formatDateTime(op.ts)}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div className="imp-detail-head">
        <StatusPill status={op.status} />
        {op.file && <span className="mono small ellipsis">{op.file}</span>}
      </div>
      <p className="small muted">
        {[
          c.users && plural(c.users, 'usuário', 'usuários'),
          c.channels && plural(c.channels, 'canal', 'canais'),
          c.messages && plural(c.messages, 'mensagem', 'mensagens'),
          c.contacts && plural(c.contacts, 'contato', 'contatos'),
        ]
          .filter(Boolean)
          .join(' · ') || 'Nenhum dado lido.'}
        {c.total > 0 && ` — ${num(c.completed)} importados, ${num(c.error)} com erro, ${num(c.skipped)} ignorados.`}
      </p>
      {op.error && <div className="form-error imp-block">{op.error}</div>}
      <Warnings list={op.warnings} open={!showErrors} />
      {hasErrors && !canRun && <p className="muted small">{plural(c.error, 'registro com erro', 'registros com erro')}. Os detalhes de cada um aparecem só para quem pode importar dados.</p>}
      {pendingKind && c.error > 0 && (
        <p className="muted">{plural(c.error, 'download falhou', 'downloads falharam')}. Eles continuam pendentes e são tentados de novo na próxima vez (até 5 tentativas por item).</p>
      )}
      {showErrors && (
        <>
          <div className="imp-errors-head">
            <h3>Erros e avisos</h3>
            <select value={type} onChange={(e) => (setType(e.target.value), setOffset(0))} aria-label="Tipo de registro">
              <option value="">Todos</option>
              <option value="user">Usuários</option>
              <option value="channel">Canais</option>
              <option value="message">Mensagens</option>
              <option value="contact">Contatos</option>
            </select>
          </div>
          {loading && !data ? (
            <SkeletonTable rows={4} cols={3} />
          ) : error ? (
            <div className="form-error">{error}</div>
          ) : !data?.errors.length ? (
            <Empty>{type ? 'Nenhum erro ou aviso deste tipo.' : 'Os detalhes dos erros desta importação não estão mais disponíveis: eles são apagados quando outra importação começa.'}</Empty>
          ) : (
            <ul className="plain-list imp-errors">
              {data.errors.map((r) => (
                <li key={r.id}>
                  <span className="pill">{TYPE_LABEL[r.type] ?? r.type}</span>
                  <strong className="imp-err-label">{r.label || r.importId || '—'}</strong>
                  {r.importId && r.label !== r.importId && <span className="muted small mono">{r.importId}</span>}
                  <div className="neg small">{r.messages.join(' · ')}</div>
                </li>
              ))}
            </ul>
          )}
          {data && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
        </>
      )}
    </Modal>
  );
}
