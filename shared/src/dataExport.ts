// "Exportar mensagens" e "Baixar meus dados" (LGPD): regras puras que o servidor e a web usam iguais.

export type RoomExportFormat = 'html' | 'csv' | 'json';
export const ROOM_EXPORT_FORMATS: RoomExportFormat[] = ['html', 'csv', 'json'];

// ---------- Criptografia ponta a ponta ----------

// O que sai no lugar do texto de uma mensagem cifrada: o servidor não tem a chave para lê-la.
export const ENCRYPTED_PLACEHOLDER = 'Mensagem criptografada';

// Contrato com a criptografia ponta a ponta: a mensagem cifrada fica com msg vazio e o conteúdo em messages.e2e
// (jsonb). No SQL, o mesmo teste é "m.e2e IS NOT NULL" (server/src/services/exportRender.ts, encryptedSql). Enquanto a
// coluna não existe, nenhuma linha traz e2e e nenhuma mensagem é cifrada.
export const isEncryptedMessage = (m: { e2e?: unknown }) => m.e2e != null;

// ---------- Limites ----------

// Um pedido de "Baixar meus dados" a cada 24 horas por pessoa (pedido que falhou não conta).
export const DATA_REQUEST_INTERVAL_HOURS = 24;
// Arquivos num .zip: bem abaixo das 65.535 entradas de um ZIP sem ZIP64 (sobra lugar para os documentos).
export const EXPORT_MAX_FILES = 60_000;

// Quando a pessoa pode pedir os dados de novo: 24 h depois do pedido mais recente que não falhou; null = já pode.
export function nextDataRequestAt(reqs: { status: string; requestedAt: string }[], now = Date.now()): string | null {
  const last = reqs
    .filter((r) => r.status !== 'failed')
    .map((r) => new Date(r.requestedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (last === undefined) return null;
  const next = last + DATA_REQUEST_INTERVAL_HOURS * 3600_000;
  return next > now ? new Date(next).toISOString() : null;
}

// ---------- Nomes de arquivo ----------

// "Projeto X / Operação" → "projeto-x-operacao": sem acentos, minúsculas, trechos de [a-z0-9] ligados por "-".
export function exportSlug(s: string, fallback: string): string {
  const slug = String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

// projeto-x_2026-10-01_a_2026-10-31.html (os dias já vêm no fuso do servidor, AAAA-MM-DD).
export function exportFileName(label: string, fromDay: string, toDay: string, ext: string): string {
  return `${exportSlug(label, 'conversa')}_${fromDay}_a_${toDay}.${ext}`;
}

// Nome de um arquivo dentro do .zip: <id>-<nome>, sem barras, caracteres proibidos no Windows nem de controle, sem
// "..". O id na frente deixa cada nome único e impede que um nome escape da pasta arquivos/ (zip slip).
export function safeZipName(id: string, name: string): string {
  let clean = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .trim();
  clean = clean.replace(/^\.+/, '');
  if (!clean) clean = 'arquivo';
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return `${id}-${clean}`;
}

// ---------- CSV (Excel em português: ";", BOM e CRLF) ----------

// Célula que começa com = + - @ ou tabulação vira texto ('=SOMA(A1)): a planilha não executa fórmula vinda de uma
// mensagem. Com ; aspas ou quebra de linha, vai entre aspas (com as aspas dobradas).
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(';')}\r\n`;
}
