import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import yauzl from 'yauzl';
import { truncate } from '../lib/text';
import { ImportError, type ArchiveEntry, type ArchiveSource, type Importer } from './types';

// Leitura do arquivo da importação: .zip, pasta no servidor ou arquivo único. Os nomes das entradas nunca
// saem da raiz, e os limites abaixo barram zip bombs antes de qualquer coisa ser descompactada.

const MiB = 1024 * 1024;

// Mutável só para os testes poderem usar limites pequenos.
export const ZIP_LIMITS = {
  maxEntries: 500_000,
  maxTotalBytes: 20 * 1024 * MiB, // soma dos tamanhos descompactados declarados
  bombMinBytes: 64 * MiB, // entradas maiores que isso não podem ter taxa de compressão acima de bombRatio
  bombRatio: 200,
  // Entrada lida (inteira na memória pelo read, ou aos poucos pelo stream): acima de readMinBytes, a taxa de compressão
  // não pode passar de readRatio.
  readMinBytes: MiB,
  readRatio: 100,
  // O que o importador vai ler, somado: acima de expandMinBytes, não pode passar de expandRatio vezes o tamanho do .zip.
  // Muitos arquivos pequenos (abaixo de readMinBytes) com taxa de 1000 viravam milhões de registros.
  expandMinBytes: 64 * MiB,
  expandRatio: 100,
  // Registros que a leitura de um .zip pode gravar: recordsMin, ou recordsPerByte para cada byte do .zip (ver
  // zipRecordLimit).
  recordsMin: 100_000,
  recordsPerByte: 2,
};
const DEFAULT_READ_MAX = 256 * MiB;

export interface ArchiveOptions {
  // Entradas ignoradas (caminho inválido, link simbólico...) viram avisos da operação.
  warn?: (message: string) => void;
}

export function sizeLabel(n: number) {
  for (const [unit, v] of [['GB', 1024 * MiB], ['MB', MiB], ['KB', 1024]] as const) {
    if (n >= v) return `${String(Math.round((n / v) * 10) / 10).replace('.', ',')} ${unit}`;
  }
  return `${n} bytes`;
}

// Nome para mostrar em mensagens: sem caracteres de controle e curto.
const printable = (s: string) => truncate(s.replace(/[\u0000-\u001f\u007f]/g, '?'), 200);

// Caminho seguro dentro do arquivo: "/" como separador, sem "/" ou letra de unidade no começo, sem "..", sem NUL.
// Devolve null quando o nome tentaria sair da raiz (a entrada é ignorada).
export function safeEntryName(raw: string): { name: string; isDirectory: boolean } | null {
  const s = raw.replace(/\\/g, '/');
  if (s.includes('\0') || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return { name: parts.join('/'), isDirectory: s.endsWith('/') };
}

const tooBig = (name: string, max: number) => new ImportError(`O arquivo "${printable(name)}" é grande demais para ser lido (máximo de ${sizeLabel(max)}).`);
const notFound = (name: string) => new ImportError(`Arquivo não encontrado na importação: "${printable(name)}".`);
const bomb = () => new ImportError('O .zip parece corrompido ou malicioso (taxa de compressão suspeita).');
const bombEntry = (name: string) => new ImportError(`O arquivo "${printable(name)}" do .zip tem uma taxa de compressão suspeita (o .zip parece corrompido ou malicioso).`);
const expanded = (total: number, zipSize: number) =>
  new ImportError(
    `O .zip parece corrompido ou malicioso: os arquivos a importar somam ${sizeLabel(total)} descompactados, mais de ${ZIP_LIMITS.expandRatio} vezes o tamanho do .zip (${sizeLabel(zipSize)}). Uma exportação de verdade descompacta para bem menos que isso; gere o .zip de novo.`,
  );
const encrypted = () => new ImportError('O .zip está protegido por senha. Gere o arquivo de novo sem senha.');
// 500000 → "500.000", sem depender dos dados de idioma do Node.
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, '.');
const notZip = () => new ImportError('O arquivo enviado não é um .zip válido.');

// Teto de registros (usuários, salas, mensagens, contatos) que a leitura de um .zip grava: abaixo de expandMinBytes,
// a taxa de compressão do .zip inteiro não é conferida, e um .zip de 160 KB com 63 MB de linhas iguais de CSV virava 3
// milhões de mensagens (umas 20 por byte do .zip). Medido: uma mensagem do Slack gasta de 3 bytes compactados (todas
// iguais, "ok" a cada segundo) a 50 (com client_msg_id e textos variados); uma linha de CSV, de 2,6 a 16. Qualquer
// .zip pode ter até recordsMin.
export async function zipRecordLimit(filePath: string) {
  const size = (await fs.promises.stat(filePath)).size;
  const max = Math.max(ZIP_LIMITS.recordsMin, Math.floor(size * ZIP_LIMITS.recordsPerByte));
  const error = () =>
    new ImportError(
      `O .zip parece corrompido ou malicioso: a leitura passou de ${thousands(max)} registros (usuários, salas, mensagens e contatos), mais de ${ZIP_LIMITS.recordsPerByte} para cada byte do .zip (${sizeLabel(size)}). Uma exportação de verdade comprime bem menos que isso; gere o .zip de novo.`,
    );
  return { max, error };
}

// Junta um stream na memória até maxBytes.
async function collect(stream: Readable, maxBytes: number, name: string, onError: (e: unknown) => Error) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        throw tooBig(name, maxBytes);
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw onError(e);
  }
  return Buffer.concat(chunks);
}

// ---------- .zip ----------

// __MACOSX/, .DS_Store e outros ocultos: nenhum importador lê.
const isJunkName = (name: string) => name.split('/').some((p) => p.startsWith('.') || p === '__MACOSX');

// A soma dos tamanhos descompactados declarados do que os importadores leem (tudo menos o lixo de quem compactou),
// contra o tamanho do .zip. Conferida ao ler o diretório central, antes de qualquer entrada ser lida ou gravada.
function checkExpansion(entries: ArchiveEntry[], zipSize: number) {
  let total = 0;
  for (const e of entries) if (!e.isDirectory && !isJunkName(e.name)) total += e.size;
  if (total > ZIP_LIMITS.expandMinBytes && total > ZIP_LIMITS.expandRatio * Math.max(zipSize, 1)) throw expanded(total, zipSize);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
// Bytes 0x80–0xFF da página de código 850.
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

// Sem a marca de UTF-8, muitos programas (macOS, Linux) gravam UTF-8 mesmo assim. Se não for UTF-8 válido, é a
// página de código OEM do Windows de quem compactou: no Brasil e na Europa ocidental, a 850 (tem ã, õ, Á, Ê...).
function entryFileName(e: yauzl.Entry) {
  const raw = e.fileNameRaw;
  if (e.generalPurposeBitFlag & 0x800 || e.extraFields.some((f) => f.id === 0x7075)) return yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, raw, e.extraFields, false);
  try {
    return utf8.decode(raw);
  } catch {
    return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80])).join('');
  }
}

const EMPTY = Buffer.alloc(0);

// Para abrir a entrada depois, o yauzl só usa tamanhos, método, flags e posição. Os campos extras (até 64 KiB, que viram
// milhares de objetos pequenos) e o comentário ficariam na memória enquanto o .zip estiver aberto.
function slimEntry(e: yauzl.Entry) {
  e.extraFields = [];
  e.extraFieldRaw = e.fileCommentRaw = e.fileNameRaw = EMPTY;
  e.fileName = e.fileComment = e.comment = '';
  return e;
}

function openZipFile(filePath: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    // decodeStrings: false para os nomes inválidos serem ignorados aqui, em vez de o yauzl recusar o .zip inteiro.
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: false }, (err, zf) => (err ? reject(err) : resolve(zf)));
  });
}

async function readCentralDirectory(zf: yauzl.ZipFile, warn: (m: string) => void) {
  const entries: ArchiveEntry[] = [];
  const byName = new Map<string, yauzl.Entry>();
  const extents: { start: number; size: number }[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const done = (err?: unknown) => {
      zf.removeAllListeners('entry');
      zf.removeAllListeners('end');
      zf.removeAllListeners('error');
      // Um erro tardio do yauzl não pode derrubar o processo.
      zf.on('error', () => {});
      if (err) reject(err);
      else resolve();
    };
    zf.on('entry', (e: yauzl.Entry) => {
      try {
        if (e.isEncrypted()) throw encrypted();
        const raw = entryFileName(e);
        const safe = safeEntryName(raw);
        if (!safe) {
          warn(`Entrada ignorada no .zip (caminho inválido): "${printable(raw)}".`);
        } else if (byName.has(safe.name)) {
          warn(`Entrada repetida ignorada no .zip: "${printable(safe.name)}".`);
        } else {
          const isDirectory = safe.isDirectory;
          if (!isDirectory && e.uncompressedSize > ZIP_LIMITS.bombMinBytes && e.uncompressedSize > ZIP_LIMITS.bombRatio * Math.max(e.compressedSize, 1)) throw bomb();
          total += e.uncompressedSize;
          if (total > ZIP_LIMITS.maxTotalBytes) throw new ImportError(`O conteúdo do .zip passa de ${sizeLabel(ZIP_LIMITS.maxTotalBytes)} descompactado.`);
          byName.set(safe.name, slimEntry(e));
          entries.push({ name: safe.name, size: isDirectory ? 0 : e.uncompressedSize, isDirectory });
        }
        if (e.compressedSize > 0) extents.push({ start: e.relativeOffsetOfLocalHeader, size: e.compressedSize });
        zf.readEntry();
      } catch (err) {
        done(err);
      }
    });
    zf.on('end', () => done());
    zf.on('error', (err) => done(err));
    zf.readEntry();
  });
  // Entradas que apontam para os mesmos bytes (zip bomb por sobreposição).
  extents.sort((a, b) => a.start - b.start);
  for (let i = 1; i < extents.length; i++) if (extents[i - 1].start + extents[i - 1].size > extents[i].start) throw bomb();
  return { entries, byName };
}

function zipReadError(name: string, e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  if (/unsupported compression method/.test(msg)) return new ImportError(`"${printable(name)}" usa um tipo de compressão não suportado. Gere o .zip de novo com a compressão padrão (deflate).`);
  return new ImportError(`Não foi possível ler "${printable(name)}" do .zip: o arquivo parece corrompido.`);
}

async function openZip(filePath: string, opts: ArchiveOptions): Promise<ArchiveSource> {
  let zf: yauzl.ZipFile;
  try {
    zf = await openZipFile(filePath);
  } catch (e) {
    if (/strong encryption/.test(String((e as Error)?.message))) throw encrypted();
    throw notZip();
  }
  if (zf.entryCount > ZIP_LIMITS.maxEntries) {
    zf.close();
    throw new ImportError(`O .zip tem entradas demais (${zf.entryCount}; o máximo é ${ZIP_LIMITS.maxEntries}).`);
  }
  const zipSize = (await fs.promises.stat(filePath)).size;
  const warn = opts.warn ?? (() => {});
  let central: Promise<{ entries: ArchiveEntry[]; byName: Map<string, yauzl.Entry> }> | null = null;
  const load = () =>
    (central ??= readCentralDirectory(zf, warn).then(
      (c) => {
        checkExpansion(c.entries, zipSize);
        return c;
      },
      (e) => {
        if (e instanceof ImportError) throw e;
        if (/strong encryption/.test(String(e?.message))) throw encrypted();
        throw new ImportError('O .zip está corrompido ou incompleto.');
      },
    ));

  // Taxa de compressão de uma entrada lida, inteira (read) ou aos poucos (stream): o CSV lê as mensagens aos poucos, e
  // um messages.csv de 63 MB com taxa de 400 passava.
  const checkRatio = (entry: ArchiveEntry, ze: yauzl.Entry | undefined) => {
    if (ze && ze.uncompressedSize > ZIP_LIMITS.readMinBytes && ze.uncompressedSize > ZIP_LIMITS.readRatio * Math.max(ze.compressedSize, 1)) throw bombEntry(entry.name);
  };

  const openEntry = async (entry: ArchiveEntry) => {
    const ze = (await load()).byName.get(entry.name);
    if (!ze || entry.isDirectory) throw notFound(entry.name);
    try {
      return { ze, stream: await new Promise<Readable>((resolve, reject) => zf.openReadStream(ze, (err, s) => (err ? reject(err) : resolve(s)))) };
    } catch (e) {
      throw zipReadError(entry.name, e);
    }
  };

  return {
    kind: 'zip',
    list: async () => (await load()).entries,
    async read(entry, maxBytes = DEFAULT_READ_MAX) {
      const ze = (await load()).byName.get(entry.name);
      if (ze && ze.uncompressedSize > maxBytes) throw tooBig(entry.name, maxBytes);
      checkRatio(entry, ze);
      const { stream } = await openEntry(entry);
      return collect(stream, maxBytes, entry.name, (e) => zipReadError(entry.name, e));
    },
    async stream(entry) {
      checkRatio(entry, (await load()).byName.get(entry.name));
      const { stream } = await openEntry(entry);
      // Erros do yauzl (em inglês) viram ImportError para quem consome o stream.
      const out = new PassThrough();
      stream.on('error', (e) => out.destroy(zipReadError(entry.name, e)));
      out.on('close', () => stream.destroy());
      return stream.pipe(out);
    },
    async close() {
      if (zf.isOpen) zf.close();
    },
  };
}

// ---------- Pasta no servidor e arquivo único ----------

const isInside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// O_NOFOLLOW: não segue um link trocado depois da listagem; O_NONBLOCK: um FIFO não trava a abertura.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

async function openRegular(abs: string, name: string) {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(abs, OPEN_FLAGS);
  } catch {
    throw notFound(name);
  }
  const st = await fh.stat();
  if (!st.isFile()) {
    await fh.close();
    throw notFound(name);
  }
  return { fh, size: st.size };
}

async function readRegular(abs: string, name: string, maxBytes: number) {
  const { fh, size } = await openRegular(abs, name);
  if (size > maxBytes) {
    await fh.close();
    throw tooBig(name, maxBytes);
  }
  // Lê no máximo maxBytes + 1: o arquivo pode ter crescido depois do stat.
  return collect(fh.createReadStream({ start: 0, end: maxBytes }), maxBytes, name, () => new ImportError(`Não foi possível ler "${printable(name)}".`));
}

async function openDir(dirPath: string, opts: ArchiveOptions): Promise<ArchiveSource> {
  const root = await fs.promises.realpath(dirPath);
  const warn = opts.warn ?? (() => {});
  let listing: Promise<ArchiveEntry[]> | null = null;

  const walk = async () => {
    const out: ArchiveEntry[] = [];
    let total = 0;
    // Nomes que não são UTF-8 (o unzip deixa assim os de um .zip do Windows sem a marca de UTF-8): o nome decodificado
    // não abre o arquivo no disco. Ficam de fora, num aviso só.
    let badNames = 0;
    let badExample = '';
    const visit = async (rel: string) => {
      // Em ordem, para a listagem e os avisos não dependerem do sistema de arquivos.
      for (const raw of (await fs.promises.readdir(rel ? path.join(root, rel) : root, { encoding: 'buffer' })).sort(Buffer.compare)) {
        let name: string;
        try {
          name = utf8.decode(raw);
        } catch {
          if (!badNames++) badExample = `${rel ? `${rel}/` : ''}${raw.toString('utf8')}`;
          continue;
        }
        const r = rel ? `${rel}/${name}` : name;
        const st = await fs.promises.lstat(path.join(root, r)).catch(() => null);
        if (!st) continue;
        if (st.isSymbolicLink()) {
          warn(`Link simbólico ignorado: "${printable(r)}".`);
          continue;
        }
        if (!st.isDirectory() && !st.isFile()) {
          warn(`Item ignorado (não é arquivo nem pasta): "${printable(r)}".`);
          continue;
        }
        if (out.length >= ZIP_LIMITS.maxEntries) throw new ImportError(`A pasta tem itens demais (o máximo é ${ZIP_LIMITS.maxEntries}).`);
        if (st.isDirectory()) {
          out.push({ name: r, size: 0, isDirectory: true });
          await visit(r);
        } else {
          total += st.size;
          if (total > ZIP_LIMITS.maxTotalBytes) throw new ImportError(`O conteúdo da pasta passa de ${sizeLabel(ZIP_LIMITS.maxTotalBytes)}.`);
          out.push({ name: r, size: st.size, isDirectory: false });
        }
      }
    };
    await visit('');
    if (badNames) {
      warn(
        `${badNames === 1 ? '1 item da pasta foi ignorado' : `${badNames} itens da pasta foram ignorados`} porque o nome não está em UTF-8 (por exemplo "${printable(badExample)}"). Renomeie esses arquivos e pastas, ou descompacte o .zip com um programa que converta os nomes para UTF-8, e importe de novo.`,
      );
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  // A entrada pode ter sido montada por quem chama: confere de novo que o caminho real fica dentro da pasta.
  const locate = async (entry: ArchiveEntry) => {
    const safe = safeEntryName(entry.name);
    if (!safe || safe.name !== entry.name || entry.isDirectory) throw notFound(entry.name);
    const real = await fs.promises.realpath(path.join(root, safe.name)).catch(() => null);
    if (!real || !isInside(root, real)) throw notFound(entry.name);
    return real;
  };

  return {
    kind: 'dir',
    list: () => (listing ??= walk()),
    async read(entry, maxBytes = DEFAULT_READ_MAX) {
      return readRegular(await locate(entry), entry.name, maxBytes);
    },
    async stream(entry) {
      const { fh } = await openRegular(await locate(entry), entry.name);
      return fh.createReadStream();
    },
    async close() {},
  };
}

async function openFile(filePath: string): Promise<ArchiveSource> {
  const real = await fs.promises.realpath(filePath).catch(() => null);
  if (!real) throw notFound(path.basename(filePath));
  const { fh, size } = await openRegular(real, path.basename(filePath));
  await fh.close();
  const entry: ArchiveEntry = { name: path.basename(filePath), size, isDirectory: false };
  const check = (e: ArchiveEntry) => {
    if (e.name !== entry.name) throw notFound(e.name);
  };
  return {
    kind: 'file',
    list: async () => [entry],
    async read(e, maxBytes = DEFAULT_READ_MAX) {
      check(e);
      return readRegular(real, e.name, maxBytes);
    },
    async stream(e) {
      check(e);
      return (await openRegular(real, e.name)).fh.createReadStream();
    },
    async close() {},
  };
}

// ---------- Entrada pública ----------

export async function openArchive(filePath: string, kind: 'zip' | 'dir' | 'file', opts: ArchiveOptions = {}): Promise<ArchiveSource> {
  if (kind === 'dir') return openDir(filePath, opts);
  if (kind === 'file') return openFile(filePath);
  return openZip(filePath, opts);
}

// Começo de um .zip: cabeçalho local (PK\x03\x04) ou .zip vazio (PK\x05\x06).
async function looksLikeZip(filePath: string) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));
  } finally {
    await fh.close();
  }
}

export async function openForImporter(filePath: string, importer: Pick<Importer, 'sourceKind'>, opts: ArchiveOptions = {}): Promise<ArchiveSource> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (!st) throw new ImportError('O arquivo da importação não foi encontrado no servidor.');
  if (st.isDirectory()) {
    if (importer.sourceKind === 'zip-or-dir') return openArchive(filePath, 'dir', opts);
    throw new ImportError('Este formato precisa de um arquivo, não de uma pasta.');
  }
  if (!st.isFile()) throw new ImportError('O caminho informado não é um arquivo.');
  if (importer.sourceKind === 'file') return openArchive(filePath, 'file', opts);
  if (!(await looksLikeZip(filePath))) throw notZip();
  return openArchive(filePath, 'zip', opts);
}

// Arquivo em memória, para os testes dos importadores. Mesmas regras de nome do .zip.
export function memoryArchive(files: Record<string, string | Buffer>, opts: ArchiveOptions & { kind?: ArchiveSource['kind'] } = {}): ArchiveSource {
  const data = new Map<string, Buffer>();
  const entries: ArchiveEntry[] = [];
  for (const [raw, content] of Object.entries(files)) {
    const safe = safeEntryName(raw);
    if (!safe) {
      opts.warn?.(`Entrada ignorada no .zip (caminho inválido): "${printable(raw)}".`);
      continue;
    }
    if (data.has(safe.name)) continue;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    data.set(safe.name, buf);
    entries.push({ name: safe.name, size: safe.isDirectory ? 0 : buf.length, isDirectory: safe.isDirectory });
  }
  const get = (entry: ArchiveEntry) => {
    const buf = data.get(entry.name);
    if (!buf || entry.isDirectory) throw notFound(entry.name);
    return buf;
  };
  return {
    kind: opts.kind ?? 'zip',
    list: async () => entries,
    async read(entry, maxBytes = DEFAULT_READ_MAX) {
      const buf = get(entry);
      if (buf.length > maxBytes) throw tooBig(entry.name, maxBytes);
      return Buffer.from(buf);
    },
    stream: async (entry) => Readable.from([get(entry)]),
    async close() {},
  };
}
