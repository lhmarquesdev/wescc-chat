import { useEffect, useState } from 'react';
import type { Room, RoomExportFormat } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { formatBytes, plural } from '../lib/format';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Field, Segmented, Toggle } from './ui';

// Exportar mensagens (painel da sala): período, formato, tópicos e arquivos. A prévia conta o que vai sair; o botão
// pede um tíquete de uso único (2 minutos) e o navegador baixa pelo link, com o cookie da sessão.

interface ExportInfo {
  messages: number;
  files: number;
  filesSize: number;
  maxFilesSize: number;
  encrypted: boolean;
  tooLarge: boolean;
}

const FORMATS: { id: RoomExportFormat; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
];

const HINT: Record<RoomExportFormat, string> = {
  html: 'Página para ler no navegador, com a lista de anexos.',
  csv: 'Planilha (Excel, LibreOffice), uma linha por mensagem.',
  json: 'Dados completos, para outros sistemas.',
};

// AAAA-MM-DD no fuso de quem usa (o campo de data é local; toISOString daria o dia em UTC).
function localDay(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const toast = (text: string, kind: 'success' | 'error') => useStore.getState().toast(text, kind);

export function ExportPanel({ room }: { room: Room & Record<string, any> }) {
  const [from, setFrom] = useState(() => localDay(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(() => localDay(new Date()));
  const [format, setFormat] = useState<RoomExportFormat>('html');
  const [threads, setThreads] = useState(true);
  const [files, setFiles] = useState(false);
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [counting, setCounting] = useState(true);
  const [busy, setBusy] = useState(false);

  const validDates = !!from && !!to;
  const inverted = validDates && from > to;
  const valid = validDates && !inverted;
  // O período vai do começo do dia "De" ao fim do dia "Até", no fuso de quem exporta.
  const period = valid ? { dateFrom: new Date(`${from}T00:00:00`).toISOString(), dateTo: new Date(`${to}T23:59:59.999`).toISOString() } : null;
  const key = period ? `${period.dateFrom}|${period.dateTo}|${threads}|${files}` : '';

  useEffect(() => {
    if (!period) {
      setInfo(null);
      setCounting(false);
      return;
    }
    let alive = true;
    setCounting(true);
    const t = setTimeout(() => {
      api
        .get<ExportInfo>('rooms.export.info', { rid: room._id, ...period, includeThreads: String(threads), includeFiles: String(files) })
        .then((r) => {
          if (!alive) return;
          setInfo(r);
          setInfoError(null);
          setCounting(false);
        })
        .catch((e) => {
          if (!alive) return;
          setInfo(null);
          setInfoError(errorMessage(e));
          setCounting(false);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room._id, key]);

  const run = async () => {
    if (!period) return;
    setBusy(true);
    try {
      const r = await api.post<{ url: string; fileName: string }>('rooms.export', { rid: room._id, type: 'file', format, ...period, includeThreads: threads, includeFiles: files });
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Download iniciado.', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  let summary: { text: string; danger?: boolean } | null = null;
  if (!valid) summary = null;
  else if (counting && !info) summary = { text: 'Contando…' };
  else if (infoError) summary = { text: infoError, danger: true };
  else if (info) {
    if (!info.messages) summary = { text: 'Nenhuma mensagem nesse período.' };
    else if (info.tooLarge) summary = { text: `Os arquivos somam ${formatBytes(info.filesSize)}; o limite é ${formatBytes(info.maxFilesSize)}. Escolha um período menor ou desligue os arquivos.`, danger: true };
    else {
      const msgs = plural(info.messages, 'mensagem', 'mensagens');
      summary = { text: files && info.files ? `${msgs} e ${plural(info.files, 'arquivo', 'arquivos')} (${formatBytes(info.filesSize)})` : msgs };
    }
  }
  const disabled = busy || !valid || counting || !info || !info.messages || info.tooLarge;

  return (
    <div className="form export-panel">
      <p className="muted">Baixe as mensagens desta conversa num arquivo. A exportação fica registrada na auditoria.</p>
      <div className="export-period">
        <Field label="De">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Até" error={inverted ? 'A data inicial precisa ser antes da final.' : undefined}>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {/* O rótulo não é <label>: dentro de um, o primeiro botão do controle levaria o texto do campo como nome. */}
      <div className="field">
        <span className="field-label">Formato</span>
        <Segmented value={format} onChange={setFormat} items={FORMATS} label="Formato" />
        <span className="field-hint">{HINT[format]}</span>
      </div>
      <Toggle checked={threads} onChange={setThreads} label="Incluir respostas dos tópicos" />
      <Toggle checked={files} onChange={setFiles} label="Incluir os arquivos (baixa um .zip)" />
      {summary && (
        <p className={summary.danger ? 'export-summary danger' : 'export-summary'} aria-live="polite">
          {summary.text}
        </p>
      )}
      {(room.encrypted || info?.encrypted) && (
        <p className="muted small">Mensagens criptografadas saem como “Mensagem criptografada”: o servidor não tem a chave para lê-las.</p>
      )}
      <div className="export-actions">
        <button type="button" className="btn primary" disabled={disabled} onClick={run}>
          <Icon name="download" />
          {busy ? 'Preparando…' : 'Exportar'}
        </button>
        <p className="muted small">Se o download não começar, toque em Exportar de novo.</p>
      </div>
    </div>
  );
}
