import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { useStore } from '../../../lib/store';
import { confirmDialog, SkeletonTable } from '../../../components/ui';
import { fail, ImportTitle, isImporting, num, ok, plural, processed, ProgressBar, ST, Stat, stepText, useImportEvents, usePolling } from './common';
import type { ImportOperation } from './types';

function titleOf(op: ImportOperation | null) {
  if (op?.importerKey === 'pending-files') return 'Baixando arquivos pendentes';
  if (op?.importerKey === 'pending-avatars') return 'Baixando fotos pendentes';
  return 'Importando os dados';
}

function doneText(op: ImportOperation) {
  const what = op.importerKey === 'pending-files' ? 'Download dos arquivos concluído' : op.importerKey === 'pending-avatars' ? 'Download das fotos concluído' : 'Importação concluída';
  return op.count.error ? `${what}, com ${plural(op.count.error, 'erro', 'erros')}. Veja os detalhes no histórico.` : `${what}!`;
}

export function ImportProgress() {
  const navigate = useNavigate();
  const [op, setOp] = useState<ImportOperation | null>(null);
  const [polling, setPolling] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // O aviso de fim sai uma vez só, venha ele do evento ou da consulta.
  const finished = useRef(false);

  const settle = (o: ImportOperation) => {
    if (finished.current) return;
    const go = (path: string) => {
      finished.current = true;
      setPolling(false);
      navigate(path, { replace: true });
    };
    if (!o.valid) return go('/admin/import');
    if (o.status === ST.done) {
      ok(doneText(o));
      return go('/admin/import');
    }
    if (o.status === ST.failed) {
      useStore.getState().toast(o.error ? `A importação falhou: ${o.error}` : 'A importação falhou.', 'error');
      return go('/admin/import');
    }
    if (o.status === ST.cancelled) {
      ok('Importação cancelada. O que já tinha sido importado continua no chat.');
      return go('/admin/import');
    }
    if (!isImporting(o.status)) go('/admin/import/prepare');
  };

  usePolling(
    async () => {
      try {
        const r = await api.get<{ operation: ImportOperation | null }>('getCurrentImportOperation');
        setLoadError(null);
        if (!r.operation) {
          finished.current = true;
          setPolling(false);
          navigate('/admin/import', { replace: true });
          return;
        }
        setOp(r.operation);
        settle(r.operation);
      } catch (e) {
        setLoadError(errorMessage(e));
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPolling(false);
      }
    },
    2000,
    polling,
  );

  useImportEvents((p) => {
    if (!op || p._id !== op._id) return;
    const next = { ...op, status: p.status, valid: p.valid, count: p.count, error: p.error ?? op.error, messagesstatus: p.messagesstatus !== undefined ? p.messagesstatus : op.messagesstatus };
    setOp(next);
    settle(next);
  });

  const cancel = async () => {
    const yes = await confirmDialog({
      title: 'Cancelar a importação?',
      body: 'O que já foi importado continua no chat; o resto fica de fora.',
      confirmLabel: 'Cancelar importação',
      cancelLabel: 'Continuar importando',
      danger: true,
    });
    if (!yes) return;
    setCancelling(true);
    try {
      const r = await api.post<{ operation: ImportOperation }>('import.cancel');
      setOp(r.operation);
      settle(r.operation);
    } catch (e) {
      fail(e);
      setCancelling(false);
    }
  };

  if (!op) {
    return (
      <>
        <ImportTitle title={titleOf(null)} />
        {loadError ? <div className="form-error imp-block">Não foi possível carregar a importação: {loadError}</div> : <SkeletonTable rows={4} cols={3} />}
      </>
    );
  }

  const c = op.count;
  const done = processed(c);
  return (
    <>
      <ImportTitle title={titleOf(op)} />
      <div className="card imp-card">
        <h2 aria-live="polite">{cancelling ? 'Cancelando…' : stepText(op)}</h2>
        <ProgressBar value={c.total > 0 ? (done / c.total) * 100 : null} label="Progresso da importação" />
        {c.total > 0 && (
          <p className="small muted">
            {num(Math.min(done, c.total))} de {num(c.total)} itens
          </p>
        )}
        {op.messagesstatus && <p className="small muted ellipsis">{op.messagesstatus}</p>}
        <div className="stats imp-stats">
          <Stat label={op.importerKey.startsWith('pending-') ? 'Baixados' : 'Importados'} value={num(c.completed)} />
          <Stat label="Erros" value={num(c.error)} tone={c.error ? 'neg' : ''} />
          <Stat label="Ignorados" value={num(c.skipped)} />
          <Stat label="Total" value={num(c.total)} />
        </div>
        {loadError && <div className="field-hint neg">Sem resposta do servidor ({loadError}). Tentando de novo…</div>}
        <p className="small muted">A importação continua no servidor se você sair desta página; o resultado fica no histórico.</p>
        <div className="row-actions">
          <button className="btn danger" disabled={cancelling || op.status === ST.finishing} onClick={() => void cancel()}>
            Cancelar importação
          </button>
        </div>
      </div>
    </>
  );
}
