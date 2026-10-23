import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage, uploadTo } from '../../../lib/api';
import { formatBytes } from '../../../lib/format';
import { Icon, type IconName } from '../../../components/Icon';
import { Field, SkeletonTable, useAsync } from '../../../components/ui';
import { ImportTitle, isBusy, ok, operationPath, ProgressBar, ST, statusLabel } from './common';
import { FormatHelp } from './FormatHelp';
import type { ImporterInfo, ImportOperation, ImportSource } from './types';

const SOURCE_LABEL: Record<ImportSource, string> = {
  upload: 'Enviar um arquivo',
  url: 'Baixar de um endereço (URL)',
  path: 'Arquivo no servidor',
};

// Ícone de cada tipo nos cartões da escolha (tipos novos ficam com o ícone da importação).
const TYPE_ICON: Record<string, IconName> = { slack: 'file-archive', csv: 'file-sheet', 'slack-users': 'admin-users', omnichannel_contact: 'nav-omnichannel' };

const URL_RE = /^https?:\/\/[^\s/?#]+\S*$/i;

// Extensões do atributo accept (".zip", ".csv"...).
const extensionsOf = (accept: string) =>
  accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith('.'));

function fileProblem(importer: ImporterInfo, file: File, max: number): string | null {
  const exts = extensionsOf(importer.accept);
  const name = file.name.toLowerCase();
  if (exts.length && !exts.some((x) => name.endsWith(x))) {
    if (exts.includes('.zip') && name.endsWith('.csv')) return 'Este importador precisa de um .zip. Compacte os arquivos .csv em um único .zip (veja como montar nesta página) e envie o .zip.';
    if (exts.includes('.csv') && name.endsWith('.zip')) return 'Este importador precisa do arquivo .csv em si, sem compactar.';
    return `Este importador precisa de um arquivo ${exts.join(' ou ')}.`;
  }
  if (max > 0 && file.size > max) return `O arquivo tem ${formatBytes(file.size)}, e o máximo para importação é ${formatBytes(max)}. O limite fica em Configurações › Importação.`;
  if (file.size === 0) return 'O arquivo está vazio.';
  return null;
}

export function NewImport({ importerKey }: { importerKey?: string }) {
  const navigate = useNavigate();
  const list = useAsync(() => api.get<{ importers: ImporterInfo[]; maxFileSize: number }>('importers.list'), []);
  const current = useAsync(() => api.get<{ operation: ImportOperation | null }>('getCurrentImportOperation'), []);
  const importers = list.data?.importers ?? [];
  const importer = importers.find((i) => i.key === importerKey) ?? null;
  const max = Number(list.data?.maxFileSize ?? 0);

  const [source, setSource] = useState<ImportSource>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Tipo desconhecido no endereço: volta para a escolha.
  useEffect(() => {
    if (list.data && importerKey && !importer) navigate('/admin/import/new', { replace: true });
  }, [list.data, importerKey, importer, navigate]);
  // Sair da página cancela um envio em andamento.
  useEffect(() => () => abortRef.current?.abort(), []);

  const sources = importer?.sources ?? [];
  const src: ImportSource = sources.includes(source) ? source : (sources[0] ?? 'upload');
  const problem = importer && file ? fileProblem(importer, file, max) : null;
  const urlValue = url.trim();
  const urlInvalid = !!urlValue && !URL_RE.test(urlValue);
  const ready = !!importer && !sending && (src === 'upload' ? !!file && !problem : src === 'url' ? !!urlValue && !urlInvalid : !!path.trim());

  const op = current.data?.operation;
  const opBusy = !!op?.valid && isBusy(op.status);
  const opPending = !!op?.valid && op.status === ST.userSelection;
  const opPath = operationPath(op);

  const chooseImporter = (key: string) => {
    setError(null);
    navigate(key ? `/admin/import/new/${key}` : '/admin/import/new', { replace: true });
  };
  const pick = (f: File | null | undefined) => {
    setError(null);
    setFile(f ?? null);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!sending) pick(e.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!importer || !ready) return;
    setError(null);
    setSending(true);
    try {
      if (src === 'upload' && file) {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setProgress(0);
        await uploadTo('uploadImportFile', file, { importerKey: importer.key }, setProgress, ctrl.signal);
      } else {
        await api.post('downloadPublicImportFile', { importerKey: importer.key, fileUrl: src === 'url' ? urlValue : path.trim() });
        ok(src === 'url' ? 'Importação solicitada. O servidor está baixando o arquivo.' : 'Importação solicitada. O servidor está lendo o arquivo.');
      }
      abortRef.current = null;
      navigate('/admin/import/prepare');
    } catch (e) {
      abortRef.current = null;
      setError(errorMessage(e));
      setSending(false);
      setProgress(null);
      if (e instanceof ApiError && e.errorType === 'error-import-running') current.reload();
    }
  };

  if (list.loading && !list.data) return <SkeletonTable rows={2} cols={1} />;

  return (
    <>
      <ImportTitle title="Importar arquivo" />
      {list.error && <div className="form-error imp-block">Não foi possível carregar os tipos de importação: {list.error}</div>}
      {opBusy && op && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>Há uma importação em andamento ({statusLabel(op.status).toLowerCase()}). Espere ela terminar ou cancele antes de começar outra.</span>
          {opPath && (
            <button className="btn small" onClick={() => navigate(opPath)}>
              Ver
            </button>
          )}
        </div>
      )}
      {opPending && op && (
        <div className="callout info">
          <Icon name="info" />
          <span>O arquivo lido antes{op.file ? ` (${op.file})` : ''} ainda não foi importado. Se você enviar outro, ele é descartado.</span>
          {opPath && (
            <button className="btn small" onClick={() => navigate(opPath)}>
              Continuar com ele
            </button>
          )}
        </div>
      )}
      <div className="imp-new">
        <div className="form">
          <Field label="Tipo de importação" hint={importer?.description}>
            <select value={importer?.key ?? ''} disabled={sending} onChange={(e) => chooseImporter(e.target.value)}>
              <option value="">Escolha o tipo…</option>
              {importers.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label}
                </option>
              ))}
            </select>
          </Field>
          {!importer && importers.length > 0 && (
            <div className="imp-types">
              {importers.map((i) => (
                <button key={i.key} type="button" className="card action imp-type" disabled={sending} onClick={() => chooseImporter(i.key)}>
                  <span className="card-icon">
                    <Icon name={TYPE_ICON[i.key] ?? 'admin-import'} />
                  </span>
                  <span className="preset-text">
                    <strong>{i.label}</strong>
                    <span className="muted small">{i.description}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {importer && (
            <>
              <Field label="Origem do arquivo">
                <select value={src} disabled={sending || sources.length < 2} onChange={(e) => (setSource(e.target.value as ImportSource), setError(null))}>
                  {sources.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Field>
              {src === 'upload' && (
                <>
                  <div className="callout info small">
                    <Icon name="info" />
                    <span>{max > 0 ? `O servidor aceita arquivos de importação de até ${formatBytes(max)}.` : 'O servidor aceita arquivos de importação de qualquer tamanho.'}</span>
                  </div>
                  <label
                    className={`dropzone ${dragging ? 'over' : ''} ${sending ? 'disabled' : ''}`}
                    onDragOver={(e) => (e.preventDefault(), setDragging(true))}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                  >
                    <input className="visually-hidden" type="file" accept={importer.accept} disabled={sending} onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
                    <span className="dropzone-icon">
                      <Icon name="upload-drop" size={24} />
                    </span>
                    <span>
                      <strong>Escolha o arquivo {extensionsOf(importer.accept).join(' ou ')}</strong>
                      <span className="muted small"> ou arraste até aqui</span>
                    </span>
                  </label>
                  {file && (
                    <div className="imp-file">
                      <span className="imp-file-icon">
                        <Icon name={/\.(csv|tsv|xlsx?)$/i.test(file.name) ? 'file-sheet' : 'file-archive'} />
                      </span>
                      <span className="ellipsis" title={file.name}>
                        {file.name}
                      </span>
                      <span className="muted small nowrap">{formatBytes(file.size)}</span>
                      {!sending && (
                        <button className="icon-btn" title="Remover" aria-label="Remover arquivo" onClick={() => pick(null)}>
                          <Icon name="close" />
                        </button>
                      )}
                    </div>
                  )}
                  {problem && <div className="field-hint neg">{problem}</div>}
                </>
              )}
              {src === 'url' && (
                <Field
                  label="Endereço do arquivo"
                  hint={
                    urlInvalid ? (
                      <span className="neg">O endereço precisa começar com http:// ou https://.</span>
                    ) : (
                      'O servidor baixa o arquivo deste endereço. Endereços da rede interna são bloqueados.'
                    )
                  }
                >
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://exemplo.com/exportacao.zip"
                    value={url}
                    disabled={sending}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                </Field>
              )}
              {src === 'path' && (
                <Field
                  label="Caminho no servidor"
                  hint={`Um arquivo${importer.key === 'csv' ? ' ou uma pasta' : ''} dentro da pasta liberada no servidor (IMPORT_SERVER_DIR). Ele é lido no lugar, sem cópia.`}
                >
                  <input
                    className="mono"
                    placeholder={importer.key === 'csv' ? '/dados/importacao/csv' : `/dados/importacao/arquivo${extensionsOf(importer.accept)[0] ?? ''}`}
                    value={path}
                    disabled={sending}
                    onChange={(e) => setPath(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                </Field>
              )}
              {sending && src === 'upload' && progress !== null && (
                <div className="imp-upload">
                  <ProgressBar value={progress * 100} label="Envio do arquivo" />
                  <div className="row-actions">
                    <span className="muted small">
                      {progress < 1
                        ? `Enviando… ${formatBytes(Math.round((file?.size ?? 0) * progress))} de ${formatBytes(file?.size ?? 0)}. Não saia desta página.`
                        : 'Arquivo enviado. Guardando no servidor…'}
                    </span>
                    <span className="spacer" />
                    {progress < 1 && (
                      <button className="btn small" onClick={() => abortRef.current?.abort()}>
                        Cancelar envio
                      </button>
                    )}
                  </div>
                </div>
              )}
              {error && <div className="form-error">{error}</div>}
              {/* Ordem dos rodapés: Cancelar antes da ação principal, à direita. */}
              <div className="row-actions imp-submit">
                <button className="btn" disabled={sending} onClick={() => navigate('/admin/import')}>
                  Cancelar
                </button>
                <button className="btn primary" disabled={!ready} onClick={() => void submit()}>
                  {sending ? 'Enviando…' : 'Importar'}
                </button>
              </div>
            </>
          )}
        </div>
        {importer && <FormatHelp importerKey={importer.key} canUsePath={sources.includes('path')} />}
      </div>
    </>
  );
}
