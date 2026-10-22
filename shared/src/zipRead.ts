// Figurinhas: leitura de .zip e .wastickers no navegador (importação). Todo byte é hostil: cada leitura confere os
// limites, os tamanhos e o CRC vêm do diretório central e o início dos dados vem do cabeçalho local de cada arquivo.
import { crc32, probeImage } from './imageProbe';
import { cleanEmojis, cleanKeywords, cleanStickerName, nameFromFileName, STICKER_LIMITS, stripInvisible } from './stickers';

export interface ZipEntry {
  name: string; // caminho dentro do ZIP, sempre com "/" (pastas incluídas)
  size: number;
  compressedSize: number;
  method: 0 | 8;
  read(): Promise<Uint8Array<ArrayBuffer>>; // confere tamanho e CRC; ZipError('corrupt') se não bater
}

export type ZipErrorReason = 'format' | 'unsupported' | 'too-big' | 'too-many' | 'corrupt';

export interface ZipLimits {
  maxEntries: number; // imagens: pack.json, title.txt, author.txt e o pôster que o pack.json usa não contam
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number; // tamanho / tamanho comprimido declarados
}

const MB = 1024 * 1024;

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: STICKER_LIMITS.importMaxEntries,
  maxEntryBytes: STICKER_LIMITS.importMaxEntryMB * MB,
  maxTotalBytes: STICKER_LIMITS.importMaxTotalMB * MB,
  maxRatio: 200,
};

const limitsText = (l: ZipLimits) => `O arquivo passa dos limites de importação (${l.maxEntries} imagens, ${Math.round(l.maxTotalBytes / MB)} MB).`;

const ZIP_TEXT: Record<ZipErrorReason, string> = {
  format: 'Este arquivo não é um ZIP válido.',
  unsupported: 'Este ZIP usa um formato que não é suportado (criptografia ou ZIP64).',
  'too-big': limitsText(ZIP_LIMITS),
  'too-many': limitsText(ZIP_LIMITS),
  corrupt: 'Este arquivo não é um ZIP válido.',
};

export class ZipError extends Error {
  constructor(
    public reason: ZipErrorReason,
    message?: string,
  ) {
    super(message ?? ZIP_TEXT[reason]);
    this.name = 'ZipError';
  }
}

// Arquivos que ficaram de fora e aparecem na revisão como "Ignorada: {message}". name já vem pronto para mostrar.
export interface ZipSkipped {
  name: string;
  reason: 'unsupported' | 'name' | 'too-big';
  message: string;
}

// A lista de arquivos legíveis, com os ignorados ao lado (continua sendo um ZipEntry[]).
export type ZipEntries = ZipEntry[] & { skipped: ZipSkipped[] };

// Recebe exatamente os bytes comprimidos e o tamanho declarado: quem implementa deve parar ao passar de maxBytes.
export type InflateRaw = (data: Uint8Array<ArrayBuffer>, maxBytes: number) => Promise<Uint8Array | ArrayBuffer>;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const FLAG_ENCRYPTED = 0x0001 | 0x0040 | 0x2000; // senha, criptografia forte, diretório central criptografado
const FLAG_DESCRIPTOR = 0x0008; // CRC e tamanhos depois dos dados (o cabeçalho local pode ter zeros)
const FLAG_UTF8 = 0x0800;
const EXTRA_ZIP64 = 0x0001;

const SKIP_TEXT = {
  encrypted: 'protegida por senha',
  zip64: 'formato ZIP64 não suportado',
  method: 'compressão não suportada',
  name: 'nome de arquivo inválido',
  duplicate: 'nome repetido no ZIP',
};

// Metadados do pacote e extensões de imagem: os metadados não contam como imagem no limite.
const META_FILES = new Set(['pack.json', 'title.txt', 'author.txt']);
const IMAGE_EXTS = ['png', 'apng', 'webp', 'gif', 'jpg', 'jpeg'];
const IMAGE_EXT = new Set(IMAGE_EXTS);

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Fim do diretório central nos últimos 65.557 bytes; o comentário precisa terminar exatamente no fim do arquivo.
function findEocd(b: Uint8Array): number {
  const min = Math.max(0, b.length - EOCD_SIZE - 0xffff);
  for (let o = b.length - EOCD_SIZE; o >= min; o--) {
    if (b[o] === 0x50 && u32(b, o) === SIG_EOCD && o + EOCD_SIZE + u16(b, o + 20) === b.length) return o;
  }
  return -1;
}

// Página de código 850 (DOS em português): o Windows grava nomes assim quando não marca UTF-8.
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0';

let utf8Strict: TextDecoder | null = null;
let utf8Loose: TextDecoder | null = null;

function decodeName(raw: Uint8Array, flags: number): string {
  utf8Loose ??= new TextDecoder('utf-8', { ignoreBOM: true });
  if (flags & FLAG_UTF8) return utf8Loose.decode(raw);
  if (raw.every((c) => c < 0x80)) return utf8Loose.decode(raw);
  utf8Strict ??= new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    return utf8Strict.decode(raw); // macOS e outros gravam UTF-8 sem a marca
  } catch {
    return Array.from(raw, (c) => (c < 0x80 ? String.fromCharCode(c) : CP850[c - 0x80])).join('');
  }
}

// 'dir' e 'junk' saem sem aviso; 'bad' aparece como ignorado. Os nomes nunca viram caminho em disco, mas um
// nome com "..", "\", ":", barra inicial, caractere de controle ou inversão de direção (U+202E faz "gnp.exe"
// parecer outra coisa na revisão) só pode ser engano ou ataque.
function classifyName(name: string): 'ok' | 'dir' | 'junk' | 'bad' {
  if (!name || name.length > 512) return 'bad';
  if (name.endsWith('/')) return 'dir';
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\:]/.test(name) || name.startsWith('/')) return 'bad';
  const parts = name.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'bad';
  if (parts.some((s) => s.startsWith('.') || s === '__MACOSX')) return 'junk'; // .DS_Store, ._foto.png, .git/
  const base = parts[parts.length - 1].toLowerCase();
  return base === 'thumbs.db' || base === 'desktop.ini' ? 'junk' : 'ok';
}

const SHOWN_MAX = 80;

// Nome de arquivo para a revisão: controles e inversões de direção viram "�" (a troca fica visível), o resto do
// invisível sai e nomes longos ganham reticências no meio, guardando o fim (a extensão). Custo fixo por nome.
export function zipDisplayName(name: string): string {
  const s = String(name);
  const head = s.length > 400 ? `${s.slice(0, 200)}${s.slice(-100)}` : s;
  const clean = stripInvisible(head.replace(/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu, '\uFFFD'));
  const cps = Array.from(clean);
  return cps.length <= SHOWN_MAX && head === s ? clean : `${cps.slice(0, 50).join('')}…${cps.slice(-29).join('')}`;
}

// Nome original de cada ignorado, para readStickerPack reconhecer um arquivo do pack.json que o ZIP pulou.
const RAW_NAME = new WeakMap<ZipSkipped, string>();
// Limites com que readZip listou cada lista: readStickerPack confere com eles as imagens que de fato entram.
const LIST_LIMITS = new WeakMap<object, ZipLimits>();

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// Só números positivos e finitos substituem o padrão: undefined ou NaN desligariam a proteção (toda comparação daria false).
function pickLimits(limits: Partial<ZipLimits> | undefined): ZipLimits {
  const pick = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    maxEntries: pick(limits?.maxEntries, ZIP_LIMITS.maxEntries),
    maxEntryBytes: pick(limits?.maxEntryBytes, ZIP_LIMITS.maxEntryBytes),
    maxTotalBytes: pick(limits?.maxTotalBytes, ZIP_LIMITS.maxTotalBytes),
    maxRatio: pick(limits?.maxRatio, ZIP_LIMITS.maxRatio),
  };
}

// Nenhum compressor real passa disto (o zlib fica em tamanho + 0,03 % quando os dados não comprimem). Sem o teto,
// um arquivo de 3 bytes poderia carregar 50 MB de blocos vazios, copiados e descomprimidos a cada leitura.
const maxDeflated = (size: number) => size + Math.floor(size / 8) + 1024;

function hasZip64Extra(b: Uint8Array, start: number, end: number): boolean {
  for (let o = start; o + 4 <= end; o += 4 + u16(b, o + 2)) if (u16(b, o) === EXTRA_ZIP64) return true;
  return false;
}

// Quantos arquivos listados não contam como imagem: um de cada metadado na raiz ou na pasta única, e o pôster
// "x.poster.<ext>" que acompanha uma figurinha "x.<ext>" (como na exportação). Cada figurinha libera um pôster só.
// É a conta antes de abrir o pack.json: um pôster que ele não usa vira figurinha, e readStickerPack o conta.
function uncountedEntries(names: readonly string[]): number {
  const all = new Set(names);
  const meta = new Set<string>();
  const stems = new Set<string>();
  let free = 0;
  for (const name of names) {
    const slash = name.lastIndexOf('/');
    const dir = name.slice(0, slash + 1);
    const base = name.slice(slash + 1);
    const lower = base.toLowerCase();
    if (META_FILES.has(lower) && dir.split('/').length <= 2) {
      if (!meta.has(lower)) {
        meta.add(lower);
        free++;
      }
      continue;
    }
    const m = /^(.+)\.poster\.[a-z0-9]+$/i.exec(base);
    const stem = m ? dir + m[1] : '';
    if (m && !stems.has(stem) && IMAGE_EXTS.some((ext) => all.has(`${stem}.${ext}`))) {
      stems.add(stem);
      free++;
    }
  }
  return free;
}

// Lista os arquivos do ZIP sem descomprimir nada. Recusa o arquivo inteiro (ZipError) quando a estrutura não confere,
// usa ZIP64, passa dos limites ou parece bomba de compressão; pula (e informa em skipped) arquivos com senha, compressão
// desconhecida, ZIP64 por arquivo, nome perigoso ou repetido, e os maiores que maxEntryBytes.
export function readZip(bytes: Uint8Array, inflateRaw: InflateRaw, limits?: Partial<ZipLimits>): ZipEntries {
  const lim = pickLimits(limits);
  const fail = (reason: ZipErrorReason) => new ZipError(reason, reason === 'too-big' || reason === 'too-many' ? limitsText(lim) : undefined);
  // Teto da listagem: além dele, nem descontando metadados e pôsteres sobram imagens dentro do limite.
  const maxListed = 2 * lim.maxEntries + META_FILES.size;

  const eocd = findEocd(bytes);
  if (eocd < 0) throw fail('format');
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if ([disk, cdDisk, onDisk, total].includes(0xffff) || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw fail('unsupported');
  // Localizador ZIP64 logo antes do fim: outro leitor veria outros tamanhos, então nem tentamos.
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_ZIP64_LOCATOR) throw fail('unsupported');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw fail('format'); // ZIP dividido em partes
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) throw fail('format');

  const entries = [] as unknown as ZipEntries;
  entries.skipped = [];
  const skip = (name: string, reason: ZipSkipped['reason'], message: string) => {
    const s: ZipSkipped = { name: zipDisplayName(name), reason, message };
    RAW_NAME.set(s, name);
    entries.skipped.push(s);
  };
  const names = new Set<string>();
  const listed: string[] = [];
  const ranges: Array<[number, number]> = [];
  let totalBytes = 0;

  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > cdEnd || u32(bytes, p) !== SIG_CENTRAL) throw fail('format');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const next = p + 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    const diskStart = u16(bytes, p + 34);
    const localOffset = u32(bytes, p + 42);
    if (next > cdEnd) throw fail('format');
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    p = next;

    const name = decodeName(rawName, flags);
    const kind = classifyName(name);
    if (kind === 'dir' || kind === 'junk') continue;
    if (listed.push(name) > maxListed) throw fail('too-many');
    if (kind === 'bad') {
      skip(name, 'name', SKIP_TEXT.name);
      continue;
    }
    if (names.has(name)) {
      skip(name, 'name', SKIP_TEXT.duplicate);
      continue;
    }
    names.add(name);
    if (flags & FLAG_ENCRYPTED) {
      skip(name, 'unsupported', SKIP_TEXT.encrypted);
      continue;
    }
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff || diskStart !== 0) {
      skip(name, 'unsupported', SKIP_TEXT.zip64);
      continue;
    }
    if (method !== 0 && method !== 8) {
      skip(name, 'unsupported', SKIP_TEXT.method);
      continue;
    }
    if (size > lim.maxEntryBytes) {
      skip(name, 'too-big', `maior que ${Math.round(lim.maxEntryBytes / MB)} MB`);
      continue;
    }
    if (size > compressedSize * lim.maxRatio) throw fail('too-big'); // bomba de compressão
    if (method === 0 ? compressedSize !== size : compressedSize > maxDeflated(size)) throw fail('corrupt');

    // Cabeçalho local: mesma assinatura, método, nome e (sem descritor de dados) CRC e tamanhos. Os comprimentos do
    // nome e do extra são os dele, não os do diretório central: os dois extras costumam ter tamanhos diferentes.
    const lo = localOffset;
    if (lo + 30 > cdOffset || u32(bytes, lo) !== SIG_LOCAL) throw fail('corrupt');
    const localFlags = u16(bytes, lo + 6);
    const localNameLen = u16(bytes, lo + 26);
    const extraStart = lo + 30 + localNameLen;
    const dataStart = extraStart + u16(bytes, lo + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) throw fail('corrupt');
    if (u16(bytes, lo + 8) !== method || localFlags & FLAG_ENCRYPTED) throw fail('corrupt');
    if (!sameBytes(bytes.subarray(lo + 30, extraStart), rawName)) throw fail('corrupt');
    // ZIP64 só no cabeçalho local (o Python com force_zip64, por exemplo): o diretório central tem tamanhos normais,
    // mas o local diz 0xFFFFFFFF e guarda os de verdade no extra 0x0001. Fica de fora como os outros ZIP64.
    const localCompressed = u32(bytes, lo + 18);
    const localSize = u32(bytes, lo + 22);
    if (localCompressed === 0xffffffff || localSize === 0xffffffff || hasZip64Extra(bytes, extraStart, dataStart)) {
      skip(name, 'unsupported', SKIP_TEXT.zip64);
      continue;
    }
    if (!(localFlags & FLAG_DESCRIPTOR) && (u32(bytes, lo + 14) !== crc || localCompressed !== compressedSize || localSize !== size))
      throw fail('corrupt');
    totalBytes += size;
    if (totalBytes > lim.maxTotalBytes) throw fail('too-big');
    ranges.push([lo, dataEnd]);

    entries.push({
      name,
      size,
      compressedSize,
      method,
      async read() {
        const corrupt = () => new ZipError('corrupt', `Não foi possível ler “${name}”: o arquivo está corrompido dentro do ZIP.`);
        // Cópia, não subarray: o inflador pode transferir o buffer que recebe, e o teto acima limita o tamanho dela.
        const raw = bytes.slice(dataStart, dataEnd);
        let out: Uint8Array<ArrayBuffer> = raw;
        if (method === 8) {
          let res: Uint8Array | ArrayBuffer;
          try {
            res = await inflateRaw(raw, size);
          } catch {
            throw corrupt();
          }
          if (res instanceof ArrayBuffer) out = new Uint8Array(res);
          else if (res instanceof Uint8Array) out = res.buffer instanceof ArrayBuffer ? (res as Uint8Array<ArrayBuffer>) : new Uint8Array(res);
          else throw corrupt();
        }
        if (out.length !== size || crc32(out) !== crc) throw corrupt();
        return out;
      },
    });
  }
  if (p !== cdEnd) throw fail('format');
  if (listed.length - uncountedEntries(listed) > lim.maxEntries) throw fail('too-many');

  // Dois arquivos não dividem bytes: é o truque das bombas de compressão que sobrepõem entradas.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw fail('corrupt');
  LIST_LIMITS.set(entries, lim);
  return entries;
}

// Descompressão para o navegador e para o Node 18+ (Compression Streams), parando ao passar de maxBytes: uma bomba
// de compressão nunca enche a memória da aba. É o inflateRaw que a importação deve passar para readZip.
export async function inflateRawStream(data: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ZipError('corrupt');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------- Pacotes ----------

export interface StickerImportItem {
  entry: ZipEntry;
  name: string; // nome sugerido (pack.json ou nome do arquivo)
  emojis: string[];
  keywords: string[];
  poster?: ZipEntry; // só no nosso formato; a importação pode refazer o pôster no navegador
}

export interface StickerPackImport {
  kind: 'wescc' | 'wastickers' | 'zip';
  name: string | null; // pack.json ou title.txt; null quando o arquivo não diz
  description: string; // '' quando o arquivo não diz
  items: StickerImportItem[];
  ignored: { name: string; reason: string }[]; // "Ignorada: {reason}"; name já vem pronto para mostrar
}

const META_MAX_BYTES = 1024 * 1024;
const PACK_JSON_MAX_ITEMS = 1000;

async function readText(e: ZipEntry): Promise<string | null> {
  if (e.size > META_MAX_BYTES) return null;
  try {
    return new TextDecoder('utf-8').decode(await e.read());
  } catch {
    return null;
  }
}

interface PackJson {
  name?: unknown;
  description?: unknown;
  stickers: { file?: unknown; poster?: unknown; name?: unknown; emojis?: unknown; keywords?: unknown }[];
}

function parsePackJson(text: string | null): PackJson | null {
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || j.format !== 'wescc-stickers' || j.version !== 1 || !Array.isArray(j.stickers)) return null;
    return { name: j.name, description: j.description, stickers: j.stickers.filter((s: unknown) => !!s && typeof s === 'object') };
  } catch {
    return null;
  }
}

// Tetos antes da limpeza: um pack.json hostil de 1 MB com um campo enorme não prende a aba. Cabem com folga cinco
// emojis (com tons de pele e ZWJ), dez palavras-chave e os nomes, que a limpeza ainda corta nos limites de verdade.
const capText = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : v);
const capEmojis = (v: unknown) => (Array.isArray(v) ? v.slice(0, 10).map((x) => capText(x, 32)) : capText(v, 128));
const capKeywords = (v: unknown) =>
  Array.isArray(v) ? v.slice(0, 20).map((x) => capText(x, 64)) : typeof v === 'string' ? v.slice(0, 1280).split(',', 20).map((x) => x.slice(0, 64)) : v;

// O ícone de bandeja do WhatsApp é um PNG de 96 × 96.
async function isTrayIcon(e: ZipEntry): Promise<boolean> {
  if (e.size > META_MAX_BYTES) return false;
  try {
    const p = probeImage(await e.read());
    return (p.format === 'png' || p.format === 'apng') && p.width === 96 && p.height === 96;
  } catch {
    return false; // ilegível: a revisão mostra o erro
  }
}

const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
const baseOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);

// Monta a lista da importação a partir de um ZIP já listado: nosso pack.json (nomes, emojis, palavras-chave, nome do
// pacote), .wastickers (nome em title.txt; author.txt, tray*.png e o PNG 96 × 96 ficam de fora) ou imagens soltas.
// Aceita a lista de readZip ou um ZipEntry[] comum (sem os ignorados do ZIP). Mais figurinhas que o limite de imagens
// (o de readZip, ou o padrão) é ZipError('too-many'), como em readZip.
export async function readStickerPack(entries: ZipEntries | readonly ZipEntry[], opts: { fileName?: string } = {}): Promise<StickerPackImport> {
  const skipped = (entries as Partial<ZipEntries>).skipped ?? [];
  // Uma pasta só na raiz ("pacote/...") é ignorada para achar pack.json e title.txt.
  const first = entries[0]?.name.split('/')[0];
  const prefix = first && entries.every((e) => e.name.startsWith(`${first}/`)) ? `${first}/` : '';
  const rel = (e: ZipEntry) => e.name.slice(prefix.length);
  const byRel = new Map(entries.map((e) => [rel(e), e] as const));
  const skippedRaw = new Set(skipped.map((s) => RAW_NAME.get(s) ?? s.name));
  const used = new Set<ZipEntry>();
  const ignored: StickerPackImport['ignored'] = skipped.map((s) => ({ name: zipDisplayName(s.name), reason: s.message }));
  const ignore = (name: string, reason: string) => ignored.push({ name: zipDisplayName(name), reason });
  const items: StickerImportItem[] = [];
  const lim = LIST_LIMITS.get(entries) ?? ZIP_LIMITS;
  const add = (item: StickerImportItem) => {
    if (items.push(item) > lim.maxEntries) throw new ZipError('too-many', limitsText(lim));
  };

  const packEntry = byRel.get('pack.json');
  const titleEntry = byRel.get('title.txt');
  const authorEntry = byRel.get('author.txt');
  const meta = new Set([packEntry, titleEntry, authorEntry].filter((e): e is ZipEntry => !!e));
  for (const e of meta) used.add(e);

  const pack = packEntry ? parsePackJson(await readText(packEntry)) : null;
  if (packEntry && !pack) ignore(packEntry.name, 'pack.json inválido');
  const kind: StickerPackImport['kind'] = pack
    ? 'wescc'
    : titleEntry || authorEntry || /\.wastickers$/i.test(opts.fileName ?? '')
      ? 'wastickers'
      : 'zip';

  let name: string | null = null;
  let description = '';
  if (pack) {
    name = cleanStickerName(capText(pack.name, 256), STICKER_LIMITS.packNameMax) || null;
    description = cleanStickerName(capText(pack.description, 1024), STICKER_LIMITS.packDescriptionMax);
    // Primeiro as figurinhas, depois os pôsteres: um pôster nunca toma o arquivo de outra figurinha.
    const chosen: Array<{ s: PackJson['stickers'][number]; entry: ZipEntry; file: string }> = [];
    for (const s of pack.stickers.slice(0, PACK_JSON_MAX_ITEMS)) {
      const file = typeof s.file === 'string' ? s.file : '';
      const entry = byRel.get(file);
      if (!entry) {
        if (!file || !skippedRaw.has(prefix + file)) ignore(file || 'pack.json', 'arquivo não encontrado no ZIP'); // o pulado já tem a linha dele
        continue;
      }
      if (used.has(entry)) {
        ignore(file, 'repetida no pack.json');
        continue;
      }
      used.add(entry);
      if (!IMAGE_EXT.has(extOf(file))) {
        ignore(entry.name, 'formato não suportado');
        continue;
      }
      chosen.push({ s, entry, file });
    }
    for (const { s, entry, file } of chosen) {
      let poster = typeof s.poster === 'string' ? byRel.get(s.poster) : undefined;
      if (poster && (used.has(poster) || !IMAGE_EXT.has(extOf(poster.name)))) poster = undefined; // fica solto ou é ignorado
      if (poster) used.add(poster);
      add({
        entry,
        name: cleanStickerName(capText(s.name, 256)) || nameFromFileName(file),
        emojis: cleanEmojis(capEmojis(s.emojis)),
        keywords: cleanKeywords(capKeywords(s.keywords)),
        ...(poster ? { poster } : {}),
      });
    }
  } else if (titleEntry) {
    const title = (await readText(titleEntry))?.slice(0, 4096).split(/\r?\n/).find((l) => l.trim());
    name = cleanStickerName(title, STICKER_LIMITS.packNameMax) || null;
  }

  const rest = entries.filter((e) => !used.has(e)).sort((a, b) => rel(a).localeCompare(rel(b), 'pt-BR', { numeric: true }));
  for (const e of rest) {
    if (!IMAGE_EXT.has(extOf(e.name))) {
      ignore(e.name, 'formato não suportado'); // .tgs e .webm do Telegram, textos, vídeos…
      continue;
    }
    if (kind === 'wastickers' && (/^tray.*\.png$/i.test(baseOf(e.name)) || (extOf(e.name) === 'png' && (await isTrayIcon(e))))) continue;
    add({ entry: e, name: nameFromFileName(e.name), emojis: [], keywords: [] });
  }
  return { kind, name, description, items, ignored };
}
