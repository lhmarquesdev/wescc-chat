import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ImportProgress } from '@shared/index';
import { errorMessage } from '../../../lib/api';
import { plural } from '../../../lib/format';
import { realtime } from '../../../lib/realtime';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import type { ImportCounts, ImportOperation } from './types';

export const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
export const ok = (t: string) => useStore.getState().toast(t, 'success');

export const ST = {
  new: 'importer_new',
  uploading: 'importer_uploading',
  downloadingFile: 'importer_downloading_file',
  fileLoaded: 'importer_file_loaded',
  preparingStarted: 'importer_preparing_started',
  preparingUsers: 'importer_preparing_users',
  preparingChannels: 'importer_preparing_channels',
  preparingMessages: 'importer_preparing_messages',
  preparingContacts: 'importer_preparing_contacts',
  userSelection: 'importer_user_selection',
  importingStarted: 'importer_importing_started',
  importingUsers: 'importer_importing_users',
  importingContacts: 'importer_importing_contacts',
  importingChannels: 'importer_importing_channels',
  importingMessages: 'importer_importing_messages',
  importingFiles: 'importer_importing_files',
  finishing: 'importer_finishing',
  done: 'importer_done',
  failed: 'importer_import_failed',
  cancelled: 'importer_import_cancelled',
} as const;

const WAITING: string[] = [ST.new, ST.uploading, ST.downloadingFile];
const PREPARING: string[] = [ST.fileLoaded, ST.preparingStarted, ST.preparingUsers, ST.preparingChannels, ST.preparingMessages, ST.preparingContacts];
const IMPORTING: string[] = [ST.importingStarted, ST.importingUsers, ST.importingContacts, ST.importingChannels, ST.importingMessages, ST.importingFiles, ST.finishing];
const FINAL: string[] = [ST.done, ST.failed, ST.cancelled];

export const isWaiting = (s: string) => WAITING.includes(s);
export const isPreparing = (s: string) => PREPARING.includes(s);
export const isImporting = (s: string) => IMPORTING.includes(s);
export const isFinal = (s: string) => FINAL.includes(s);
// Leitura do arquivo ainda não terminou (inclui o envio e o download).
export const isReading = (s: string) => isWaiting(s) || isPreparing(s);
// Trabalho em segundo plano: não dá para começar outra importação.
export const isBusy = (s: string) => s !== ST.new && (isReading(s) || isImporting(s));

export const STATUS_LABEL: Record<string, string> = {
  [ST.new]: 'Não iniciada',
  [ST.uploading]: 'Enviando o arquivo',
  [ST.downloadingFile]: 'Baixando o arquivo',
  [ST.fileLoaded]: 'Arquivo carregado',
  [ST.preparingStarted]: 'Lendo o arquivo',
  [ST.preparingUsers]: 'Lendo os usuários',
  [ST.preparingChannels]: 'Lendo os canais',
  [ST.preparingMessages]: 'Lendo as mensagens',
  [ST.preparingContacts]: 'Lendo os contatos',
  [ST.userSelection]: 'Pronta para escolher o que importar',
  [ST.importingStarted]: 'Importando os dados',
  [ST.importingUsers]: 'Importando os usuários',
  [ST.importingContacts]: 'Importando os contatos',
  [ST.importingChannels]: 'Importando os canais',
  [ST.importingMessages]: 'Importando as mensagens',
  [ST.importingFiles]: 'Baixando os arquivos',
  [ST.finishing]: 'Quase pronto',
  [ST.done]: 'Concluída',
  [ST.failed]: 'Erro',
  [ST.cancelled]: 'Cancelada',
};

export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

// Texto da etapa na tela de progresso.
export function stepText(op: Pick<ImportOperation, 'status' | 'importerKey'>) {
  if (op.status === ST.importingFiles) return op.importerKey === 'pending-avatars' ? 'Baixando as fotos de perfil.' : 'Baixando os arquivos das mensagens.';
  const text: Record<string, string> = {
    [ST.importingStarted]: 'Começando a importação.',
    [ST.importingUsers]: 'Importando os usuários.',
    [ST.importingContacts]: 'Importando os contatos.',
    [ST.importingChannels]: 'Importando os canais.',
    [ST.importingMessages]: 'Importando as mensagens.',
    [ST.finishing]: 'Finalizando a importação.',
  };
  return text[op.status] ?? `${statusLabel(op.status)}.`;
}

// Cor da situação no histórico.
export function statusTone(s: string) {
  if (s === ST.done) return 'ok';
  if (s === ST.failed) return 'err';
  if (s === ST.cancelled) return 'warn';
  if (s === ST.userSelection) return 'accent';
  if (isBusy(s)) return 'busy';
  return '';
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill imp-status ${statusTone(status)}`}>{statusLabel(status)}</span>;
}

// Para onde a operação atual leva quando é aberta pelo histórico.
export function operationPath(op: ImportOperation | null | undefined): string | null {
  if (!op || !op.valid) return null;
  if (isReading(op.status) || op.status === ST.userSelection) return op.importerKey === 'api' ? null : '/admin/import/prepare';
  if (isImporting(op.status)) return '/admin/import/progress';
  return null;
}

export const processed = (c: ImportCounts) => c.completed + c.error + c.skipped;

// O plural agora mora em lib/format; fica reexportado para as telas da importação.
export { plural };

export const num = (n: number | undefined) => (n ?? 0).toLocaleString('pt-BR');

// Eventos import.progress do servidor. O callback mais recente é sempre o usado.
export function useImportEvents(cb: (op: ImportProgress) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'import.progress') ref.current(ev.operation);
    });
    return () => {
      off();
    };
  }, []);
}

// Chama fn agora e de novo a cada `ms` enquanto `active`, sem sobrepor requisições.
export function usePolling(fn: () => Promise<unknown>, ms: number, active: boolean, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        await ref.current();
      } catch {
        // quem chama trata o erro
      }
      if (alive) timer = window.setTimeout(tick, ms);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ms, ...deps]);
}

// Barra de progresso; value null = indeterminada.
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className="imp-progress">
      <div
        className={`imp-bar ${pct === null ? 'indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.floor(pct)}
      >
        <div style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      {pct !== null && <span className="imp-pct">{Math.floor(pct)}%</span>}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// Título com seta de voltar para o histórico.
export function ImportTitle({ title, back = true, children }: { title: ReactNode; back?: boolean; children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="page-title-row page-head imp-head">
      {back && (
        <button className="icon-btn" title="Voltar para o histórico" aria-label="Voltar para o histórico" onClick={() => navigate('/admin/import')}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

// O servidor guarda até 200 avisos e termina a lista com "e mais N avisos".
export function warningCount(list: string[]) {
  const extra = /^e mais (\d+) avisos?$/.exec(list[list.length - 1] ?? '');
  return extra ? list.length - 1 + Number(extra[1]) : list.length;
}

export function Warnings({ list, open }: { list: string[]; open?: boolean }) {
  // Aberto ou fechado fica no estado: as atualizações da importação (a cada poucos segundos) não fecham a lista.
  const [isOpen, setOpen] = useState(!!open);
  if (!list.length) return null;
  return (
    <details className="imp-warnings" open={isOpen} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="warning" size={16} />
        {plural(warningCount(list), 'aviso', 'avisos')} na leitura do arquivo
      </summary>
      <ul>
        {list.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
}
