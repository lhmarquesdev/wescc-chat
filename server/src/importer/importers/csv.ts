import { ImportError, ST, type ArchiveEntry, type ImportChannel, type ImportMessage, type ImportStatus, type ImportUser, type Importer, type PrepareContext } from '../types';
import { parseContactsCsv } from './contacts';
import {
  CsvFileError,
  type CsvRow,
  RowIssues,
  columnCount,
  contentId,
  csvRows,
  csvTable,
  invalidUtf8Warning,
  isBlankRow,
  isHeaderCell,
  isJunkEntry,
  legacyWarning,
  openTable,
  parseTimestamp,
  plainWord,
  restOfRow,
  semicolonError,
  semicolonSeparated,
  semicolonText,
  splitList,
  wrapperPrefix,
} from './csv-util';

// Importador CSV: um .zip (ou uma pasta no servidor) com
//   users.csv      usuario,email,nome                       (sem cabeçalho)
//   channels.csv   canal,criador,public|private,membro1;membro2 (sem cabeçalho)
//   <canal>/*.csv  autor,data,texto                         (sem cabeçalho; data em milissegundos desde 1970)
//   directmessages/*.csv  de,para,data,texto                (sem cabeçalho)
//   contacts.csv   contatos do omnichannel                  (com cabeçalho)

const ROOT_FILES = ['users.csv', 'channels.csv', 'contacts.csv'] as const;
type RootFile = (typeof ROOT_FILES)[number];
const DM_FOLDER = 'directmessages';

const isMarker = (rel: string) => (ROOT_FILES as readonly string[]).includes(rel.toLowerCase()) || rel.toLowerCase().startsWith(`${DM_FOLDER}/`);

export const channelImportId = (name: string) => `csv:c:${name}`;
export const directImportId = (a: string, b: string) => `csv:d:${[a, b].sort().join('/')}`;

const USER_HEADER = ['username', 'usuario', 'user', 'login', 'nome de usuario'];
const EMAIL_HEADER = ['email', 'e-mail', 'mail'];
const CHANNEL_HEADER = ['name', 'nome', 'channel', 'canal', 'sala'];
const CREATOR_HEADER = ['creator', 'criador', 'owner', 'dono'];
const TYPE_HEADER = ['type', 'tipo', 'visibility', 'visibilidade', 'privacy', 'privacidade'];
const AUTHOR_HEADER = ['author', 'autor', 'username', 'user', 'usuario', 'from', 'de', 'remetente', 'sender'];
const PRIVATE = ['private', 'privado', 'privada', 'p'];
const PUBLIC = ['public', 'publico', 'publica', 'c', ''];

const NO_USER = ['linha sem nome de usuário e sem e-mail ignorada', 'linhas sem nome de usuário e sem e-mail ignoradas'] as const;
const USER_REPEATED = ['usuário repetido ignorado (vale a primeira linha)', 'usuários repetidos ignorados (vale a primeira linha)'] as const;
const NO_NAME = ['linha sem nome de canal ignorada', 'linhas sem nome de canal ignoradas'] as const;
const CHANNEL_REPEATED = ['canal repetido ignorado (vale a primeira linha)', 'canais repetidos ignorados (vale a primeira linha)'] as const;
const UNKNOWN_TYPE = ['canal com tipo desconhecido ficou público (use public ou private)', 'canais com tipo desconhecido ficaram públicos (use public ou private)'] as const;
const INCOMPLETE = ['linha incompleta ignorada (cada linha precisa de autor, data e texto)', 'linhas incompletas ignoradas (cada linha precisa de autor, data e texto)'] as const;
const INCOMPLETE_DM = [
  'linha incompleta ignorada (cada linha precisa de remetente, destinatário, data e texto)',
  'linhas incompletas ignoradas (cada linha precisa de remetente, destinatário, data e texto)',
] as const;
const BAD_DATE = ['mensagem com data inválida ficou com a hora da importação', 'mensagens com data inválida ficaram com a hora da importação'] as const;
const EXTRA_COMMAS = ['mensagem com vírgulas no texto sem aspas (o texto foi mantido inteiro)', 'mensagens com vírgulas no texto sem aspas (o texto foi mantido inteiro)'] as const;

interface Item {
  entry: ArchiveEntry;
  rel: string; // nome sem a pasta em volta de tudo
  folder: string;
  direct: boolean;
}

class CsvReader {
  private users = new Map<string, string>(); // nome em minúsculas → id de importação (o nome como está em users.csv)
  private channels = new Map<string, string>(); // nome exato → id de importação
  private channelsLower = new Map<string, string>();
  private folders = new Map<string, string | null>();
  private directs = new Set<string>();
  private total = 1;
  private done = 0;
  private partial = 0;
  private lastRate = -1;
  private secondsWarned = false;

  constructor(private ctx: PrepareContext) {}

  async run() {
    const ctx = this.ctx;
    const all = await ctx.source.list();
    this.total = Math.max(all.length, 1);
    this.report();
    const files = all.filter((e) => !e.isDirectory && !isJunkEntry(e.name));
    this.done += all.length - files.length;
    const prefix = wrapperPrefix(files.map((e) => e.name), isMarker);

    const tables: Record<RootFile, Item[]> = { 'users.csv': [], 'channels.csv': [], 'contacts.csv': [] };
    const messages: Item[] = [];
    for (const entry of files) {
      const rel = entry.name.slice(prefix.length);
      const slash = rel.indexOf('/');
      if (slash < 0) {
        const root = rel.toLowerCase() as RootFile;
        if (ROOT_FILES.includes(root)) tables[root].push({ entry, rel, folder: '', direct: false });
        else this.ignoreRoot(rel);
      } else if (!rel.toLowerCase().endsWith('.csv')) {
        ctx.warn(`Arquivo ignorado: "${rel}" (nas pastas, só arquivos .csv são lidos).`);
        this.step();
      } else {
        const folder = rel.slice(0, slash).trim().normalize('NFC');
        messages.push({ entry, rel, folder, direct: folder.toLowerCase() === DM_FOLDER });
      }
    }
    if (!Object.values(tables).some((t) => t.length) && !messages.length) {
      ctx.warn('O .zip não tem users.csv, channels.csv, contacts.csv nem pastas com mensagens. Veja na ajuda como montar o arquivo.');
    }

    // Usuários e canais antes das mensagens, onde quer que estejam no .zip: as pastas são ligadas aos canais pelo nome.
    const phases: [RootFile, (it: Item) => Promise<unknown>, ImportStatus][] = [
      ['users.csv', (it) => this.readUsers(it), ST.preparingUsers],
      ['channels.csv', (it) => this.readChannels(it), ST.preparingChannels],
      ['contacts.csv', async (it) => parseContactsCsv(await openTable(ctx.source, it.entry, it.rel), ctx, it.rel, this.partialProgress(it)), ST.preparingContacts],
    ];
    for (const [key, read, step] of phases) {
      if (!tables[key].length) continue;
      await ctx.setStep(step);
      for (const it of tables[key]) {
        if (ctx.cancelled()) return;
        await read(it);
        this.step();
      }
    }
    if (messages.length) await ctx.setStep(ST.preparingMessages);
    for (const it of messages) {
      if (ctx.cancelled()) return;
      if (it.direct) await this.readDirect(it);
      else await this.readChannelFile(it);
      this.step();
    }
    if (!ctx.cancelled()) this.report(true);
  }

  // ---------- Progresso ----------

  // Por entradas do .zip, com a parte já lida do arquivo atual (100% só no fim); só avisa quando sobe.
  private report(final = false) {
    const rate = final ? 100 : Math.min(100, Math.floor(((this.done + Math.min(this.partial, 0.99)) * 1000) / this.total) / 10);
    if (!final && rate <= this.lastRate) return;
    this.lastRate = rate;
    try {
      this.ctx.progress(rate);
    } catch {
      // O progresso é só informativo: uma falha ao avisar não interrompe a leitura.
    }
  }

  private step() {
    this.done++;
    this.partial = 0;
    if (!this.ctx.cancelled()) this.report();
  }

  // ---------- Arquivos ----------

  // Parte já lida do arquivo atual, para o progresso.
  private partialProgress(it: Item) {
    const size = Math.max(it.entry.size, 1);
    let read = 0;
    return (n: number) => {
      read += n;
      this.partial = read / size;
      this.report();
    };
  }

  // users.csv e channels.csv: lidos aos pedaços como as mensagens, mas um erro de formato é fatal.
  private async *table(it: Item) {
    yield* csvTable(await openTable(this.ctx.source, it.entry, it.rel), it.rel, { warn: (m) => this.ctx.warn(m), onBytes: this.partialProgress(it) });
  }

  private async *rows(it: Item) {
    const stream = await this.ctx.source.stream(it.entry);
    yield* csvRows(stream, {
      onBytes: this.partialProgress(it),
      onLegacy: (mixedLine) => this.ctx.warn(legacyWarning(it.rel, mixedLine)),
      onInvalid: (line) => this.ctx.warn(invalidUtf8Warning(it.rel, line)),
    });
  }

  private ignoreRoot(rel: string) {
    const lower = rel.toLowerCase();
    if (lower.endsWith('.csv')) {
      this.ctx.warn(`"${rel}" está fora de uma pasta e foi ignorado. As mensagens de um canal vão numa pasta com o nome do canal (ex.: geral/mensagens.csv).`);
    } else if (/\.(xlsx?|ods|numbers)$/.test(lower)) {
      this.ctx.warn(`"${rel}" foi ignorado: salve as planilhas como .csv (UTF-8, separado por vírgulas).`);
    } else {
      this.ctx.warn(`Arquivo ignorado: "${rel}".`);
    }
    this.step();
  }

  private headerSkipped(rel: string) {
    this.ctx.warn(`"${rel}": a primeira linha parece um cabeçalho e foi ignorada (este arquivo não leva cabeçalho).`);
  }

  // Erro no meio de um arquivo de mensagens: o que veio antes fica, o resto do arquivo é ignorado.
  private fileError(rel: string, e: unknown) {
    if (e instanceof CsvFileError) {
      this.ctx.warn(`Não foi possível ler "${rel}": ${e.reason}${e.line ? ` (linha ${e.line}). As linhas a partir dela foram ignoradas.` : '. O resto do arquivo foi ignorado.'}`);
    } else if (e instanceof ImportError) {
      this.ctx.warn(`${e.message} O resto de "${rel}" foi ignorado.`);
    } else {
      throw e;
    }
  }

  // Nome de usuário como em users.csv, sem diferença de maiúsculas ("Alice" e "alice" são a mesma pessoa).
  private user(ref: string | undefined) {
    const s = (ref ?? '').trim().replace(/^@+/, '');
    return s ? (this.users.get(s.toLowerCase()) ?? s) : '';
  }

  // ---------- users.csv ----------

  private async readUsers(it: Item) {
    const issues = new RowIssues();
    let first = true;
    for await (const row of this.table(it)) {
      if (this.ctx.cancelled()) return;
      if (isBlankRow(row.fields)) continue;
      const f = row.fields.map((v) => v.trim());
      if (first) {
        first = false;
        if (semicolonSeparated(f, 2)) throw semicolonError(it.rel);
        if (isHeaderCell(f[0], USER_HEADER) && isHeaderCell(f[1], EMAIL_HEADER)) {
          this.headerSkipped(it.rel);
          continue;
        }
      }
      const email = f[1] ?? '';
      let username = (f[0] ?? '').replace(/^@+/, '');
      if (!username && email.includes('@')) username = email.slice(0, email.indexOf('@'));
      if (!username) {
        issues.add(NO_USER, row.line);
        continue;
      }
      const key = username.toLowerCase();
      if (this.users.has(key)) {
        issues.add(USER_REPEATED, row.line);
        continue;
      }
      this.users.set(key, username);
      const rec: ImportUser = { importIds: [username], emails: email ? [email] : [], username };
      if (f[2]) rec.name = f[2];
      await this.ctx.user(rec);
    }
    issues.flush((m) => this.ctx.warn(m), it.rel);
  }

  // ---------- channels.csv ----------

  private async readChannels(it: Item) {
    const issues = new RowIssues();
    let first = true;
    for await (const row of this.table(it)) {
      if (this.ctx.cancelled()) return;
      if (isBlankRow(row.fields)) continue;
      const f = row.fields.map((v) => v.trim());
      if (first) {
        first = false;
        if (semicolonSeparated(f, 3)) throw semicolonError(it.rel);
        if (isHeaderCell(f[0], CHANNEL_HEADER) && (isHeaderCell(f[1], CREATOR_HEADER) || isHeaderCell(f[2], TYPE_HEADER))) {
          this.headerSkipped(it.rel);
          continue;
        }
      }
      const name = (f[0] ?? '').normalize('NFC');
      if (!name) {
        issues.add(NO_NAME, row.line);
        continue;
      }
      if (this.channelsLower.has(name.toLowerCase())) {
        issues.add(CHANNEL_REPEATED, row.line);
        continue;
      }
      const type = plainWord(f[2]);
      if (!PRIVATE.includes(type) && !PUBLIC.includes(type)) issues.add(UNKNOWN_TYPE, row.line);
      // Membros separados por vírgula em vez de ";" viram colunas a mais: também são membros.
      const users = [...new Set(f.slice(3).flatMap(splitList).map((u) => this.user(u)).filter(Boolean))];
      const id = channelImportId(name);
      const rec: ImportChannel = { importIds: [id], t: PRIVATE.includes(type) ? 'p' : 'c', name, users };
      const creator = this.user(f[1]);
      if (creator) rec.creator = creator;
      this.channels.set(name, id);
      this.channelsLower.set(name.toLowerCase(), id);
      await this.ctx.channel(rec);
    }
    issues.flush((m) => this.ctx.warn(m), it.rel);
  }

  // ---------- Mensagens ----------

  // Canal de uma pasta: o nome exato em channels.csv, depois sem diferença de maiúsculas, depois um canal que veio
  // de uma importação anterior (mensagens novas de um canal já importado, sem repetir channels.csv).
  private async roomFor(folder: string) {
    const known = this.folders.get(folder);
    if (known !== undefined) return known;
    let id = this.channels.get(folder) ?? this.channelsLower.get(folder.toLowerCase()) ?? null;
    if (!id && (await this.ctx.findImported('room', channelImportId(folder)))) id = channelImportId(folder);
    if (!id) this.ctx.warn(`A pasta "${folder}" não tem linha em channels.csv; as mensagens dela foram ignoradas.`);
    this.folders.set(folder, id);
    return id;
  }

  private async readChannelFile(it: Item) {
    const rid = await this.roomFor(it.folder);
    if (!rid) return;
    await this.messageFile(it, 3, async (row, f, issues, ids) => {
      const author = this.user(f[0]);
      const text = restOfRow(row, 2);
      if (!author || !text) return issues.add(INCOMPLETE, row.line);
      if (columnCount(f) > 3) issues.add(EXTRA_COMMAS, row.line);
      await this.message({ rid, author, rawTs: f[1], text, file: it.rel, line: row.line }, issues, ids);
    });
  }

  private async readDirect(it: Item) {
    await this.messageFile(it, 4, async (row, f, issues, ids) => {
      const from = this.user(f[0]);
      const to = this.user(f[1]);
      const text = restOfRow(row, 3);
      if (!from || !to || !text) return issues.add(INCOMPLETE_DM, row.line);
      if (columnCount(f) > 4) issues.add(EXTRA_COMMAS, row.line);
      const rid = directImportId(from, to);
      if (!this.directs.has(rid)) {
        this.directs.add(rid);
        await this.ctx.channel({ importIds: [rid], t: 'd', users: from === to ? [from] : [from, to].sort() });
      }
      await this.message({ rid, author: from, rawTs: f[2], text, file: it.rel, line: row.line }, issues, ids);
    });
  }

  private async messageFile(
    it: Item,
    columns: number,
    each: (row: CsvRow, f: string[], issues: RowIssues, ids: Map<string, number>) => Promise<unknown>,
  ) {
    const ctx = this.ctx;
    await ctx.setMessagesStatus(it.rel.replace(/\.csv$/i, ''));
    const issues = new RowIssues();
    const ids = new Map<string, number>();
    let first = true;
    let n = 0;
    try {
      for await (const row of this.rows(it)) {
        if (++n % 500 === 0 && ctx.cancelled()) break;
        if (isBlankRow(row.fields)) continue;
        const f = row.fields.map((v) => v.trim());
        if (first) {
          first = false;
          if (semicolonSeparated(f, columns)) {
            ctx.warn(`${semicolonText(it.rel)} O arquivo foi ignorado.`);
            break;
          }
          if (isHeaderCell(f[0], AUTHOR_HEADER) && !parseTimestamp(f[columns - 2]).ts) {
            this.headerSkipped(it.rel);
            continue;
          }
        }
        await each(row, f, issues, ids);
      }
    } catch (e) {
      this.fileError(it.rel, e);
    }
    issues.flush((m) => ctx.warn(m), it.rel);
    await ctx.setMessagesStatus(null);
  }

  private async message(m: { rid: string; author: string; rawTs: string | undefined; text: string; file: string; line: number }, issues: RowIssues, ids: Map<string, number>) {
    const { ts, seconds } = parseTimestamp(m.rawTs);
    if (!ts) issues.add(BAD_DATE, m.line);
    if (seconds && !this.secondsWarned) {
      this.secondsWarned = true;
      this.ctx.warn('Algumas datas estão em segundos (10 dígitos) e não em milissegundos; elas foram convertidas.');
    }
    // Sem data, a posição no arquivo distingue mensagens iguais. A mesma mensagem repetida no mesmo arquivo continua
    // repetida; o limite só protege a memória em arquivos enormes.
    const base = contentId('csv:m:', [m.rid, m.author, ts ?? `?${m.file}:${m.line}`, m.text]);
    if (ids.size > 200_000) ids.clear();
    const seen = ids.get(base) ?? 0;
    ids.set(base, seen + 1);
    const rec: ImportMessage = { importId: seen ? `${base}:${seen + 1}` : base, rid: m.rid, u: m.author, msg: m.text };
    if (ts) rec.ts = ts;
    await this.ctx.message(rec);
  }
}

export const csvImporter: Importer = {
  key: 'csv',
  name: 'CSV',
  label: 'CSV (.zip)',
  description:
    'Um .zip com users.csv (usuario,email,nome), channels.csv (canal,criador,public ou private,membros separados por ;), uma pasta por canal com as mensagens em .csv (autor,data em milissegundos,texto) e, se quiser, directmessages/ (de,para,data,texto) e contacts.csv. Os arquivos não levam cabeçalho, exceto contacts.csv.',
  accept: '.zip',
  sourceKind: 'zip-or-dir',
  visible: true,
  prepare: (ctx) => new CsvReader(ctx).run(),
};
