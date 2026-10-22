import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { sizeLabel } from '../archive';
import { ImportError, type ArchiveEntry, type ArchiveSource, type PrepareContext } from '../types';

// Leitura de .csv comum aos importadores CSV, usuários do Slack e contatos.

const MiB = 1024 * 1024;

// users.csv, channels.csv, contacts.csv e a lista do Slack são lidos aos pedaços, como as mensagens, mas cada linha
// lida deixa algo na memória (nomes já vistos, para achar repetidos): por isso os limites.
// Mutável só para os testes poderem usar limites pequenos.
export const CSV_LIMITS = {
  maxTableBytes: 128 * MiB,
  maxTableRows: 2_000_000,
};

// O texto vai para o leitor de CSV em partes deste tamanho, com uma pausa a cada parte e a cada ROWS_PER_PAUSE
// registros entregues, para o servidor atender o resto enquanto isso.
const SLICE_BYTES = 16 * 1024;
const ROWS_PER_PAUSE = 500;

export interface CsvRow {
  fields: string[];
  line: number; // linha do arquivo onde o registro começa
  raw: string; // texto original do registro
}

// Problema no conteúdo do .csv; quem lê decide se é fatal ou só um aviso.
export class CsvFileError extends Error {
  constructor(
    public reason: string,
    public line?: number,
  ) {
    super(reason);
  }
}

const PARSE_OPTIONS = {
  relax_column_count: true, // linhas curtas ou longas são tratadas por quem lê, com o número da linha
  relax_quotes: true, // aspas no meio do texto (Ele disse "oi") ficam como estão
  skip_empty_lines: true,
  trim: true,
  info: true,
  raw: true,
  max_record_size: 1_000_000, // um arquivo binário sem quebras de linha não vira um registro gigante na memória
};

// ---------- Texto ----------

const EMPTY = Buffer.alloc(0);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_LOOSE = new TextDecoder('utf-8', { ignoreBOM: true });
// Bytes 0x80–0x9F do Windows-1252 (aspas curvas, travessão, €...): o TextDecoder do Node os lê como Latin-1, onde são
// caracteres de controle.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const cp1252 = (buf: Buffer) => buf.toString('latin1').replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));

// Não corta um caractere de vários bytes no fim do pedaço: os bytes que faltam chegam no próximo.
function utf8Boundary(buf: Buffer) {
  for (let i = buf.length - 1, back = 0; i >= 0 && back < 4; i--, back++) {
    const b = buf[i];
    if (b < 0x80) return buf.length;
    if (b >= 0xc0) return buf.length - i < (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2) ? i : buf.length;
  }
  return buf.length;
}

// Sequências de vários bytes válidas em UTF-8, bytes inválidos e a posição do primeiro inválido (-1 se não houver).
function scanUtf8(buf: Buffer) {
  let valid = 0;
  let invalid = 0;
  let first = -1;
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    const n = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = n > 0 && i + n <= buf.length;
    for (let k = 1; ok && k < n; k++) {
      const c = buf[i + k];
      const lo = k > 1 ? 0x80 : b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
      const hi = k > 1 ? 0xbf : b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
      ok = c >= lo && c <= hi;
    }
    if (ok) {
      valid++;
      i += n;
    } else {
      invalid++;
      if (first < 0) first = i;
      i++;
    }
  }
  return { valid, invalid, first };
}

// Quebras de linha (\r\n, \r ou \n contam uma vez cada).
function lineBreaks(text: string) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) n++;
  }
  return n;
}

// Um trecho com bytes que não são UTF-8 válido só é lido quando tem caracteres não ASCII que bastem para decidir a
// codificação; até lá ele espera, no máximo este tanto do arquivo.
const ENCODING_EVIDENCE = 8;
const ENCODING_LOOKAHEAD = MiB;

// Texto de um .csv lido aos pedaços: UTF-8 sem a marca BOM. \r\n e \r viram \n.
// Um trecho que não é UTF-8 válido é lido como Windows-1252 (o padrão do Excel em português, que senão viraria "Jo�o")
// quando a maior parte dos seus caracteres não ASCII não é UTF-8; senão continua UTF-8 e só os bytes ruins viram "�"
// (campo cortado no meio de um caractere, arquivos juntados). Com poucos caracteres no trecho, conta também o que o
// arquivo já mostrou antes. A escolha vale para os trechos seguintes até um deles a contradizer: um byte ruim no começo
// não estraga os acentos certos que vêm depois, nem um trecho em UTF-8 no fim de um arquivo do Excel.
export class CsvTextDecoder {
  legacy = false; // algum trecho foi lido como Windows-1252
  lossy = false; // algum byte inválido foi trocado por "�"
  private mode: 'utf8' | 'cp1252' = 'utf8';
  private utf8Seen = 0; // caracteres de vários bytes já lidos como UTF-8
  private cp1252Seen = 0; // bytes já lidos como Windows-1252 que não eram UTF-8 válido
  private held: Buffer[] = []; // trecho que espera a decisão
  private heldBytes = 0;
  private heldValid = 0;
  private heldInvalid = 0;
  private heldFirst = -1; // posição do primeiro byte inválido do trecho
  private line = 1; // linha do começo do próximo texto entregue
  private legacyLine = 0;
  private invalidLine = 0;
  private reported = false;
  private tail: Buffer = EMPTY;
  private started = false;
  private cr = false;

  constructor(
    private onLegacy?: (mixedLine?: number) => void, // mixedLine: o arquivo também tem UTF-8 (linha do primeiro trecho em Windows-1252)
    private onInvalid?: (line: number) => void,
  ) {}

  write(chunk: Buffer): string {
    return this.decode(this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk, false);
  }

  end(): string {
    const text = this.decode(this.tail, true);
    this.report();
    return this.cr ? `${text}\n` : text;
  }

  // Os avisos saem quando se sabe como o arquivo inteiro foi lido; quem lê chama também ao parar antes do fim.
  report() {
    if (this.reported) return;
    this.reported = true;
    if (this.legacy) this.onLegacy?.(this.utf8Seen > 0 ? this.legacyLine : undefined);
    if (this.lossy) this.onInvalid?.(this.invalidLine);
  }

  private decode(input: Buffer, final: boolean): string {
    let buf = input;
    if (!this.started) {
      if (buf.length < 3 && !final) {
        this.tail = Buffer.from(buf);
        return '';
      }
      this.started = true;
      if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
        throw new CsvFileError('o arquivo está em UTF-16; salve de novo como "CSV UTF-8"');
      }
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
    }
    const cut = final ? buf.length : utf8Boundary(buf);
    this.tail = cut < buf.length ? Buffer.from(buf.subarray(cut)) : EMPTY;
    const piece = buf.subarray(0, cut);
    if (this.held.length) return this.hold(piece, final);
    if (this.mode === 'utf8') {
      let text: string;
      try {
        text = UTF8.decode(piece);
      } catch {
        return this.hold(piece, final);
      }
      this.utf8Seen += piece.length - text.length;
      return this.emit(text);
    }
    const scan = scanUtf8(piece);
    if (scan.valid) return this.hold(piece, final, scan);
    this.cp1252Seen += scan.invalid;
    return this.emit(cp1252(piece));
  }

  // Trecho que contradiz a leitura atual: guardado até ter caracteres que bastem para decidir.
  private hold(piece: Buffer, final: boolean, known?: ReturnType<typeof scanUtf8>): string {
    const scan = known ?? scanUtf8(piece);
    if (scan.first >= 0 && this.heldFirst < 0) this.heldFirst = this.heldBytes + scan.first;
    this.held.push(Buffer.from(piece));
    this.heldBytes += piece.length;
    this.heldValid += scan.valid;
    this.heldInvalid += scan.invalid;
    const enough = this.heldValid + this.heldInvalid >= ENCODING_EVIDENCE;
    if (!enough && !final && this.heldBytes < ENCODING_LOOKAHEAD) return '';

    const buf = Buffer.concat(this.held);
    const { heldValid: valid, heldInvalid: invalid, heldFirst: first } = this;
    this.held = [];
    this.heldBytes = this.heldValid = this.heldInvalid = 0;
    this.heldFirst = -1;
    // Com caracteres que bastem, vale a maioria dentro do trecho (o arquivo pode juntar partes em codificações
    // diferentes); com poucos, conta também o que já foi lido.
    const utf8 = enough ? valid >= invalid : valid + this.utf8Seen >= invalid + this.cp1252Seen;
    const at = first < 0 ? this.line : this.line + lineBreaks((this.cr ? '\r' : '') + buf.toString('latin1', 0, first));
    if (utf8) {
      this.mode = 'utf8';
      this.utf8Seen += valid;
      if (invalid && !this.lossy) {
        this.lossy = true;
        this.invalidLine = at;
      }
      return this.emit(UTF8_LOOSE.decode(buf));
    }
    this.mode = 'cp1252';
    this.cp1252Seen += invalid;
    if (!this.legacy) {
      this.legacy = true;
      this.legacyLine = at;
    }
    return this.emit(cp1252(buf));
  }

  private emit(decoded: string): string {
    let text = this.cr ? `\r${decoded}` : decoded;
    this.line += lineBreaks(text);
    this.cr = text.endsWith('\r');
    if (this.cr) {
      text = text.slice(0, -1);
      this.line--;
    }
    if (text.includes('\0')) throw new CsvFileError('o arquivo não parece ser um .csv de texto');
    return text.replace(/\r\n?/g, '\n');
  }
}

// ---------- Registros ----------

function csvErrorReason(code: string) {
  switch (code) {
    case 'CSV_QUOTE_NOT_CLOSED':
      return 'aspas abertas e não fechadas';
    case 'CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE':
    case 'CSV_INVALID_CLOSING_QUOTE':
      return 'texto logo depois de fechar as aspas (dentro de um campo entre aspas, escreva "" para cada aspa)';
    case 'INVALID_OPENING_QUOTE':
      return 'aspas no meio de um campo';
    case 'CSV_MAX_RECORD_SIZE':
      return 'linha grande demais (o arquivo parece corrompido ou não é um .csv)';
    default:
      return 'formato inválido';
  }
}

// O registro termina dentro de um campo entre aspas que nunca foi fechado? Varre o texto uma vez só.
function insideQuotes(raw: string) {
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    if (raw[i] === '"') {
      for (i++; ; i += 2) {
        i = raw.indexOf('"', i);
        if (i < 0) return true;
        if (raw[i + 1] !== '"') break;
      }
      i++;
    }
    while (i < raw.length && raw[i] !== ',' && raw[i] !== '\n') i++;
    i++;
  }
  return false;
}

// last: linha do fim do último registro lido e linhas em branco puladas até ele.
function toCsvError(e: any, last: { line: number; empty: number }) {
  const code = typeof e?.code === 'string' ? e.code : '';
  if (!code.startsWith('CSV_') && code !== 'INVALID_OPENING_QUOTE') return e;
  if (code === 'CSV_QUOTE_NOT_CLOSED' || code === 'CSV_MAX_RECORD_SIZE') {
    // O erro aponta onde a leitura parou; o problema começa no registro seguinte ao último lido, depois das linhas em
    // branco (o leitor as conta, também as que só têm espaços). Aspas sem fechar engolem as linhas seguintes até o fim
    // do arquivo ou até o registro ficar grande demais.
    const blank = Math.max(0, (Number(e.empty_lines) || 0) - last.empty);
    const open = code === 'CSV_QUOTE_NOT_CLOSED' || insideQuotes(typeof e.raw === 'string' ? e.raw : '');
    return new CsvFileError(csvErrorReason(open ? 'CSV_QUOTE_NOT_CLOSED' : code), last.line + 1 + blank);
  }
  return new CsvFileError(csvErrorReason(code), Number(e.lines) || undefined);
}

interface ParsedRecord {
  record: string[];
  info: { lines: number; empty_lines: number };
  raw?: string;
}

// skipped: linhas em branco puladas logo antes do registro, que o texto bruto traz no começo (com os espaços que
// tiverem; um espaço especial pode nem estar inteiro, por isso elas são contadas pelo leitor e não pelo texto).
function toRow(r: ParsedRecord, skipped: number): CsvRow {
  const raw = r.raw ?? '';
  let start = 0;
  for (let k = 0; k < skipped; k++) {
    const nl = raw.indexOf('\n', start);
    if (nl < 0) break;
    start = nl + 1;
  }
  const body = raw.slice(start, raw.endsWith('\n') ? -1 : undefined);
  let breaks = 0;
  for (let i = body.indexOf('\n'); i >= 0; i = body.indexOf('\n', i + 1)) breaks++;
  return { fields: r.record, line: r.info.lines - breaks, raw: body };
}

export interface CsvReadOptions {
  onBytes?: (n: number) => void; // bytes lidos da origem, para o progresso
  onLegacy?: (mixedLine?: number) => void; // trechos lidos como Windows-1252 (mixedLine: o arquivo também tem UTF-8)
  onInvalid?: (line: number) => void; // UTF-8 com bytes inválidos, trocados por "�" (linha do primeiro)
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

// Texto em partes de até SLICE_BYTES caracteres, sem separar as duas metades de um emoji (par substituto).
function* textParts(text: string) {
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + SLICE_BYTES, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    yield text.slice(at, end);
    at = end;
  }
}

// Registros de um .csv, um a um, sem carregar o arquivo inteiro. Lança CsvFileError num erro de formato; os
// registros anteriores ao erro já foram entregues.
export async function* csvRows(source: Readable, opts: CsvReadOptions = {}): AsyncGenerator<CsvRow> {
  const decoder = new CsvTextDecoder(opts.onLegacy, opts.onInvalid);
  // Os registros são recolhidos assim que lidos: num erro, os que vieram antes dele na mesma parte não se perdem.
  let ready: CsvRow[] = [];
  const last = { line: 0, empty: 0 };
  const parser = parse({
    ...PARSE_OPTIONS,
    on_record: (r: unknown) => {
      const rec = r as ParsedRecord;
      ready.push(toRow(rec, rec.info.empty_lines - last.empty));
      last.line = rec.info.lines;
      last.empty = rec.info.empty_lines;
      return null;
    },
  });
  parser.on('error', () => {}); // o erro chega pelo retorno de write/end
  parser.resume();
  const feed = (text: string | null) => new Promise<Error | null | undefined>((resolve) => (text === null ? parser.end(resolve) : parser.write(text, resolve)));
  let delivered = 0;
  async function* take() {
    const rows = ready;
    ready = [];
    for (const row of rows) {
      yield row;
      if (++delivered % ROWS_PER_PAUSE === 0) await pause();
    }
  }
  // O decodificador pode devolver de uma vez um trecho que esperou a decisão da codificação: ele também vai em partes.
  async function* push(text: string) {
    for (const part of textParts(text)) {
      const err = await feed(part);
      yield* take();
      if (err) throw err;
      await pause();
    }
  }
  try {
    for await (const chunk of source as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Um pedaço grande (o arquivo inteiro, quando já está na memória) também é lido em partes.
      for (let at = 0; at < buf.length; at += SLICE_BYTES) {
        const part = buf.subarray(at, at + SLICE_BYTES);
        opts.onBytes?.(part.length);
        const text = decoder.write(part);
        if (text) yield* push(text);
        else await pause();
      }
    }
    yield* push(decoder.end());
    const err = await feed(null);
    yield* take();
    if (err) throw err;
  } catch (e) {
    throw toCsvError(e, last);
  } finally {
    decoder.report();
    parser.destroy();
    source.destroy();
  }
}

const tableTooBig = (file: string) => new ImportError(`O arquivo "${file}" é grande demais para ser lido (máximo de ${sizeLabel(CSV_LIMITS.maxTableBytes)}).`);

export interface TableOptions {
  warn: (message: string) => void;
  onBytes?: (n: number) => void;
}

// users.csv, channels.csv, contacts.csv e a lista do Slack, registro a registro. Um erro de formato aqui é fatal: vira
// ImportError com o nome do arquivo e a linha.
export async function* csvTable(input: Readable | Buffer, file: string, opts: TableOptions): AsyncGenerator<CsvRow> {
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : input;
  let bytes = 0;
  let rows = 0;
  try {
    const records = csvRows(source, {
      onBytes: (n) => {
        bytes += n;
        if (bytes > CSV_LIMITS.maxTableBytes) throw tableTooBig(file);
        opts.onBytes?.(n);
      },
      onLegacy: (mixedLine) => opts.warn(legacyWarning(file, mixedLine)),
      onInvalid: (line) => opts.warn(invalidUtf8Warning(file, line)),
    });
    for await (const row of records) {
      if (++rows > CSV_LIMITS.maxTableRows) {
        throw new ImportError(`"${file}" tem mais de ${CSV_LIMITS.maxTableRows.toLocaleString('pt-BR')} linhas. Divida o arquivo em partes menores e importe uma de cada vez.`);
      }
      yield row;
    }
  } catch (e) {
    if (e instanceof CsvFileError) throw new ImportError(`Não foi possível ler "${file}": ${e.reason}${e.line ? ` (linha ${e.line})` : ''}.`);
    throw e;
  }
}

// Uma tabela dentro do arquivo da importação, para ler com csvTable.
export async function openTable(source: ArchiveSource, entry: ArchiveEntry, file = entry.name): Promise<Readable> {
  if (entry.size > CSV_LIMITS.maxTableBytes) throw tableTooBig(file);
  return source.stream(entry);
}

export const invalidUtf8Warning = (file: string, line: number) =>
  `"${file}" tem bytes que não são UTF-8 válido; eles foram trocados por "�" (o primeiro na linha ${line}). Confira o texto dessas linhas.`;

export const legacyWarning = (file: string, mixedLine?: number) =>
  mixedLine === undefined
    ? `"${file}" não está em UTF-8 e foi lido como Windows-1252 (o padrão do Excel). Confira se os acentos ficaram certos.`
    : `"${file}" mistura UTF-8 e Windows-1252: os trechos que não são UTF-8 foram lidos como Windows-1252 (o primeiro na linha ${mixedLine}). Confira se os acentos ficaram certos.`;

// Linha só com separadores (o Excel grava ",,," nas linhas vazias da planilha).
export const isBlankRow = (fields: string[]) => fields.every((f) => f === '');

// O Excel em português salva "CSV" com ponto e vírgula; sem esta checagem, cada linha viraria um campo só.
export const semicolonSeparated = (fields: string[], columns: number) => !!fields[0]?.includes(';') && fields[0].split(';').length >= columns;

export const semicolonText = (file: string) =>
  `"${file}" parece usar ponto e vírgula (;) para separar as colunas. Salve como "CSV UTF-8 (delimitado por vírgulas)" ou troque o separador por vírgula.`;
export const semicolonError = (file: string) => new ImportError(semicolonText(file));

// Palavra para comparar sem diferença de maiúsculas e acentos ("Público" → "publico").
export const plainWord = (s: string | undefined) =>
  (s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

// Célula de uma primeira linha que é cabeçalho (username,email,name...) e não dados.
export const isHeaderCell = (value: string | undefined, names: string[]) => names.includes(plainWord(value));

// Lista separada por ";", sem espaços nem itens vazios.
export const splitList = (s: string | undefined) =>
  (s ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean);

// Colunas a partir de "from" juntas de volta: num texto com vírgulas e sem aspas (alice,1700000000000,Olá, tudo bem?)
// as vírgulas viram colunas a mais, e o texto original é recuperado do registro bruto.
export function restOfRow(row: CsvRow, from: number): string {
  let fields = row.fields;
  let end = fields.length;
  while (end > from + 1 && fields[end - 1] === '') end--;
  fields = fields.slice(0, end);
  if (fields.length <= from + 1) return fields[from] ?? '';
  if (!row.raw.includes('"')) {
    // Vírgulas e espaços no fim saem. Num laço e não numa expressão regular: com milhares de vírgulas seguidas, a
    // expressão levaria um tempo que cresce com o quadrado do tamanho da linha.
    const raw = row.raw;
    let stop = raw.length;
    while (stop > 0 && (raw[stop - 1] === ',' || /\s/.test(raw[stop - 1]))) stop--;
    const parts = raw.slice(0, stop).split(',');
    for (let k = from; k < parts.length; k++) parts[k] = restoreLeadingSpace(parts[k], row.fields[k] ?? '');
    return parts.slice(from).join(',').trim();
  }
  return fields.slice(from).join(',');
}

// O csv-parse perde bytes de um espaço especial (U+00A0, U+3000...) tirado do começo de um campo, e no texto bruto ele
// vira "�". Antes do valor do campo só há espaços: esses "�" voltam como espaço comum.
function restoreLeadingSpace(part: string, value: string) {
  let end = part.length;
  while (end > 0 && /\s/.test(part[end - 1])) end--;
  const lead = end - value.length;
  if (lead <= 0 || part.slice(lead, end) !== value) return part;
  return part.slice(0, lead).replace(/\uFFFD/g, ' ') + part.slice(lead);
}

// Colunas a mais que só têm vazios no fim da linha não contam (o Excel completa as linhas com ",").
export function columnCount(fields: string[]) {
  let n = fields.length;
  while (n > 0 && fields[n - 1] === '') n--;
  return n;
}

// ---------- Datas ----------

// Cada texto casa de um jeito só (sem dois quantificadores de dígitos seguidos), e o tempo não cresce com o quadrado.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const SECONDS_RE = /^\d{10}(\.\d+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const MAX_MS = 253402300799999; // 9999-12-31
const MAX_TS_LENGTH = 64; // nenhuma data válida é maior; um campo enorme nem passa pelas expressões regulares

// Data de uma mensagem: milissegundos desde 1970 (o formato do Rocket.Chat), segundos com 10 dígitos ou ISO-8601.
// Sem data válida, a mensagem fica com a hora da importação (ts vazio).
export function parseTimestamp(raw: string | undefined): { ts?: string; seconds?: boolean } {
  const s = (raw ?? '').trim();
  if (s.length > MAX_TS_LENGTH) return {};
  let ms = NaN;
  let seconds = false;
  if (SECONDS_RE.test(s)) {
    ms = Number(s) * 1000;
    seconds = true;
  } else if (NUMBER_RE.test(s)) {
    ms = Number(s);
  } else if (ISO_RE.test(s)) {
    let iso = s.toUpperCase().replace(' ', 'T').replace(',', '.');
    if (/[+-]\d{2}$/.test(iso) && iso.includes('T')) iso += ':00';
    // Sem fuso horário: UTC, para o resultado não depender do servidor.
    else if (iso.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
    ms = Date.parse(iso);
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) return {};
  return { ts: new Date(Math.round(ms)).toISOString(), seconds };
}

// ---------- Arquivos ----------

const JUNK = new Set(['thumbs.db', 'desktop.ini']);

// __MACOSX/, .DS_Store e outros arquivos ocultos, Thumbs.db: lixo de quem compactou, nunca dados.
export const isJunkEntry = (name: string) => name.split('/').some((p) => p.startsWith('.') || p.startsWith('__MACOSX') || JUNK.has(p.toLowerCase()));

// Pasta em volta de tudo (o .zip foi feito da pasta, não dos arquivos dentro dela): devolve o prefixo "pasta/" a tirar
// dos nomes. Só quando há um arquivo conhecido logo abaixo dela, para não confundir com uma pasta de canal.
export function wrapperPrefix(names: string[], isMarker: (relative: string) => boolean): string {
  if (!names.length || names.some(isMarker)) return '';
  const first = names[0].split('/');
  let common = first.length - 1;
  for (const n of names) {
    const parts = n.split('/');
    let k = 0;
    while (k < common && k < parts.length - 1 && parts[k] === first[k]) k++;
    common = k;
  }
  for (let k = 1; k <= common; k++) {
    const prefix = `${first.slice(0, k).join('/')}/`;
    if (names.some((n) => isMarker(n.slice(prefix.length)))) return prefix;
  }
  return '';
}

export const looksLikeZip = (buf: Buffer) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6));

// Os primeiros bytes dizem se mandaram um .zip no lugar do .csv.
async function* refuseZip(stream: Readable): AsyncGenerator<Buffer> {
  let head: Buffer | null = EMPTY;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (!head) {
        yield chunk;
        continue;
      }
      head = Buffer.concat([head, chunk]);
      if (head.length < 4) continue;
      if (looksLikeZip(head)) throw new ImportError('Este formato espera um arquivo .csv, não um .zip.');
      yield head;
      head = null;
    }
    if (head?.length) yield head;
  } finally {
    stream.destroy();
  }
}

// O único arquivo de um importador de arquivo .csv (usuários do Slack, contatos), para ler com csvTable.
export async function openSingleCsv(ctx: PrepareContext): Promise<{ name: string; size: number; stream: Readable }> {
  const entry = (await ctx.source.list()).find((e) => !e.isDirectory);
  if (!entry) throw new ImportError('O arquivo enviado está vazio.');
  const stream = await openTable(ctx.source, entry);
  return { name: entry.name, size: entry.size, stream: Readable.from(refuseZip(stream)) };
}

// Progresso pelos bytes lidos de um arquivo de tamanho conhecido, em pontos inteiros (100 só no fim, por quem chama).
export function byteProgress(ctx: PrepareContext, size: number) {
  let read = 0;
  let last = 0;
  return (n: number) => {
    read += n;
    const rate = Math.min(99, Math.floor((read * 100) / Math.max(size, 1)));
    if (rate <= last) return;
    last = rate;
    try {
      ctx.progress(rate);
    } catch {
      // O progresso é só informativo: uma falha ao avisar não interrompe a leitura.
    }
  };
}

// ---------- Avisos ----------

// Avisos por arquivo agrupados por motivo, com as primeiras linhas: um arquivo com mil linhas ruins gera um aviso, não mil.
export class RowIssues {
  private m = new Map<string, { one: string; many: string; n: number; lines: number[] }>();

  add(issue: readonly [one: string, many: string], line: number) {
    const key = issue[0];
    const w = this.m.get(key) ?? { one: issue[0], many: issue[1], n: 0, lines: [] };
    w.n++;
    if (w.lines.length < 5) w.lines.push(line);
    this.m.set(key, w);
  }

  flush(warn: (m: string) => void, file: string) {
    for (const w of this.m.values()) {
      const list = w.lines.length === 1 ? `linha ${w.lines[0]}` : `linhas ${w.lines.slice(0, -1).join(', ')}${w.n > w.lines.length ? `, ${w.lines.at(-1)} e outras` : ` e ${w.lines.at(-1)}`}`;
      warn(`"${file}": ${w.n === 1 ? w.one : `${w.n} ${w.many}`} (${list}).`);
    }
    this.m.clear();
  }
}

// Id estável de uma mensagem sem id na origem: reimportar o mesmo arquivo atualiza em vez de duplicar.
export function contentId(prefix: string, parts: string[]) {
  return prefix + createHash('sha1').update(parts.join('\u0000')).digest('base64url').slice(0, 22);
}
