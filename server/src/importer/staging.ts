import { many, pool, query, type Queryable } from '../db/pool';
import { truncate } from '../lib/text';
import type { ImportDataType, StagedRecord } from './types';

// Mutável só para os testes poderem usar limites pequenos.
export const STAGING_LIMITS = {
  flushRows: 500,
  // Também grava quando o JSON guardado passa disso: 500 registros grandes juntos esgotavam a memória do servidor.
  flushChars: 8 * 1024 * 1024,
  // A leitura (iterateStaged) para o lote antes do registro que passaria disso em JSON, pelo mesmo motivo.
  readBytes: 32 * 1024 * 1024,
  // Registro acima disso vai num INSERT só dele, com o JSON como parâmetro simples: dentro da lista do lote, o
  // node-postgres escapa o texto inteiro (aspas e barras) sem devolver a vez ao event loop.
  aloneChars: 1024 * 1024,
};
// Chaves de objetos (nomes de reações, campos extras).
const MAX_KEY = 500;

const emptyCounts = (): Record<ImportDataType, number> => ({ user: 0, channel: 0, message: 0, contact: 0 });
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

// O PostgreSQL recusa U+0000 em text e em jsonb, e o jsonb recusa metades soltas de pares UTF-16: um único caractere
// desses derrubava o lote inteiro, e com ele a leitura toda. As metades viram U+FFFD (truncate) antes de o U+0000 sair,
// na mesma ordem da limpeza do JSON abaixo: o id na coluna e o mesmo id dentro dos registros ficam iguais.
function clean(s: string, max = Infinity) {
  let t = truncate(s, Infinity);
  if (t.includes('\u0000')) t = t.replace(/\u0000/g, '');
  return t.length > max ? truncate(t, max) : t;
}

// O JSON.stringify escreve U+0000 como o escape \u0000 e cada metade solta como \udXXX (os pares inteiros saem como
// estão). Trocar esses escapes no texto pronto é uma busca só; com uma função de substituição chamada para cada valor,
// um registro de 15 MB com 480 mil ids levava de 3 a 5 vezes o tempo do JSON.stringify sem devolver a vez. O
// (?<!\\)((?:\\\\)*) garante que a barra começa um escape, e não é a segunda de um "\\" (uma barra do próprio texto).
const ESC_SURROGATE = /(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g;
const ESC_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g;

// Chaves compridas demais são cortadas por caractere (lib/text). O registro só é copiado quando tem uma (quase nunca).
function longKeys(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    for (const x of v) if (x && typeof x === 'object' && longKeys(x)) return true;
    return false;
  }
  for (const k in v) if (k.length > MAX_KEY || longKeys((v as Record<string, unknown>)[k])) return true;
  return false;
}

function cutKeys(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cutKeys);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k.length > MAX_KEY ? truncate(k, MAX_KEY) : k] = cutKeys(x);
  return out;
}

// Num registro grande (aloneChars), cada passada pelo texto fica numa vez separada do event loop.
async function toJson(data: unknown) {
  let json = JSON.stringify(longKeys(data) ? cutKeys(data) : data);
  const big = json.length > STAGING_LIMITS.aloneChars;
  if (big) await breathe();
  if (/\\ud[89a-f]/.test(json)) {
    json = json.replace(ESC_SURROGATE, '$1\ufffd');
    if (big) await breathe();
  }
  if (json.includes('\\u0000')) json = json.replace(ESC_NUL, '$1');
  return json;
}

// Limpo, sem corte: outros registros citam o mesmo id (message.rid, channel.users...) e precisam continuar iguais a ele.
const cleanId = (id: unknown) => (id === null || id === undefined || id === '' ? null : clean(String(id)) || null);

interface Row {
  type: ImportDataType;
  importId: string | null;
  data: string;
}

const toRow = async (type: ImportDataType, importId: string | null, data: unknown): Promise<Row> => ({ type, importId: cleanId(importId), data: await toJson(data) });
const rowSize = (r: Row) => r.data.length + (r.importId?.length ?? 0);

async function insertBatch(operationId: string, rows: Row[], db: Queryable) {
  await query(
    `INSERT INTO import_records (operation_id, data_type, import_id, data)
     SELECT $1, t, i, d FROM unnest($2::text[], $3::text[], $4::jsonb[]) AS x(t, i, d)`,
    [operationId, rows.map((r) => r.type), rows.map((r) => r.importId), rows.map((r) => r.data)],
    db,
  );
}

// Na ordem em que chegaram (os ids seguem a ordem de gravação); os registros grandes, um por um (ver aloneChars).
async function insertRows(operationId: string, rows: Row[], db: Queryable = pool) {
  let start = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].data.length <= STAGING_LIMITS.aloneChars) continue;
    if (i > start) await insertBatch(operationId, rows.slice(start, i), db);
    await breathe();
    await query('INSERT INTO import_records (operation_id, data_type, import_id, data) VALUES ($1, $2, $3, $4::jsonb)', [operationId, rows[i].type, rows[i].importId, rows[i].data], db);
    start = i + 1;
  }
  if (start < rows.length) await insertBatch(operationId, start ? rows.slice(start) : rows, db);
}

// Grava os dados lidos do arquivo em lotes, na ordem em que chegam.
export class StagingWriter {
  private buf: Row[] = [];
  private size = 0;
  private n = emptyCounts();
  private total = 0;
  private max = Infinity;
  private tooMany: () => Error = () => new Error('registros demais');
  private over: Error | null = null;

  constructor(private operationId: string) {}

  // Teto de registros da operação (ver zipRecordLimit em archive.ts). Passado o teto, add falha com o erro, e failure()
  // continua com ele mesmo que o importador tenha seguido em frente (o CSV transforma erros em avisos por arquivo).
  limit(max: number, error: () => Error) {
    this.max = max;
    this.tooMany = error;
  }

  failure(): Error | null {
    return this.over;
  }

  async add(type: ImportDataType, importId: string | null, data: unknown): Promise<void> {
    if (this.over) throw this.over;
    if (this.total >= this.max) throw (this.over = this.tooMany());
    const row = await toRow(type, importId, data);
    this.buf.push(row);
    this.size += rowSize(row);
    this.n[type]++;
    this.total++;
    if (this.buf.length >= STAGING_LIMITS.flushRows || this.size >= STAGING_LIMITS.flushChars) await this.flush();
  }

  async flush(): Promise<void> {
    const rows = this.buf;
    this.buf = [];
    this.size = 0;
    await insertRows(this.operationId, rows);
  }

  counts(): Record<ImportDataType, number> {
    return { ...this.n };
  }
}

// Inserção direta (import.addUsers), dentro da transação de quem chama.
export async function stageRecords(operationId: string, records: { type: ImportDataType; importId: string | null; data: unknown }[], db: Queryable = pool) {
  let batch: Row[] = [];
  let size = 0;
  for (const r of records) {
    const row = await toRow(r.type, r.importId, r.data);
    batch.push(row);
    size += rowSize(row);
    if (batch.length >= STAGING_LIMITS.flushRows || size >= STAGING_LIMITS.flushChars) {
      await insertRows(operationId, batch, db);
      batch = [];
      size = 0;
    }
  }
  await insertRows(operationId, batch, db);
}

export async function clearStaging(operationId: string): Promise<void> {
  await query('DELETE FROM import_records WHERE operation_id = $1', [operationId]);
}

// Paginação por id (ordem de inserção), sem carregar tudo na memória: até `batch` registros, e o lote para antes do
// registro que passaria de readBytes de JSON (o primeiro sempre vem, mesmo maior que isso). O tamanho de cada registro
// é calculado uma vez só: os que ficam para os próximos lotes guardam o tamanho aqui e depois vêm pelo id. Recalcular a
// cada lote os que ficaram de fora convertia de novo até 500 registros grandes para cada 2 lidos.
export async function* iterateStaged<T>(operationId: string, type: ImportDataType, batch = 500): AsyncGenerator<StagedRecord<T>[]> {
  const toRecord = (r: any): StagedRecord<T> => ({ id: Number(r.id), dataType: r.data_type, importId: r.import_id, data: r.data as T });
  let last = 0;
  let ahead: { id: number; size: number }[] = [];
  let end = false;
  for (;;) {
    if (!ahead.length) {
      if (end) return;
      const page = await many(
        `SELECT id, data_type, import_id, size, kept, CASE WHEN kept THEN data END AS data FROM (
           SELECT l.*, row_number() OVER w = 1 OR sum(l.size) OVER w <= $5 AS kept
             FROM (SELECT id, data_type, import_id, data, octet_length(data::text) AS size FROM import_records
                    WHERE operation_id = $1 AND data_type = $2 AND id > $3 ORDER BY id LIMIT $4) l
           WINDOW w AS (ORDER BY l.id)
         ) x ORDER BY id`,
        [operationId, type, last, batch, STAGING_LIMITS.readBytes],
      );
      if (!page.length) return;
      end = page.length < batch;
      last = Number(page[page.length - 1].id);
      const kept = page.filter((r) => r.kept);
      ahead = page.slice(kept.length).map((r) => ({ id: Number(r.id), size: Number(r.size) }));
      yield kept.map(toRecord);
      continue;
    }
    let total = 0;
    let k = 0;
    while (k < ahead.length && (k === 0 || total + ahead[k].size <= STAGING_LIMITS.readBytes)) total += ahead[k++].size;
    const ids = ahead.splice(0, k).map((r) => r.id);
    const rows = await many('SELECT id, data_type, import_id, data FROM import_records WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
    if (rows.length) yield rows.map(toRecord);
  }
}

// Erros e avisos da conversão. O texto pode trazer nomes do arquivo: sem U+0000 (o PostgreSQL recusa) e cortado por
// caractere, como todo corte de texto (lib/text).
export async function markRecordError(id: number, message: string): Promise<void> {
  await query('UPDATE import_records SET errors = errors || jsonb_build_array($2::text) WHERE id = $1', [id, truncate(String(message).replace(/\u0000/g, ''), 2000)]);
}

export async function markRecordsSkipped(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await query('UPDATE import_records SET skipped = true WHERE id = ANY($1::bigint[])', [ids]);
}

// Tira dos usuários lidos as senhas (o hash do import.addUsers, ou a senha em texto de dados antigos). Depois que a
// operação termina, falha ou é interrompida ninguém mais as usa, e os registros com erro ficam para o import.errors.
export async function scrubSecrets(operationId: string): Promise<void> {
  await query(
    `UPDATE import_records SET data = data - 'password' - 'passwordHash'
      WHERE operation_id = $1 AND data_type = 'user' AND (data ? 'password' OR data ? 'passwordHash')`,
    [operationId],
  );
}

// Fica só o que falhou (para import.errors), sem senhas.
export async function deleteSuccessful(operationId: string): Promise<void> {
  await query(`DELETE FROM import_records WHERE operation_id = $1 AND errors = '[]'::jsonb`, [operationId]);
  await scrubSecrets(operationId);
}

export async function countStaged(operationId: string, db: Queryable = pool): Promise<Record<ImportDataType, number>> {
  const out = emptyCounts();
  const rows = await many('SELECT data_type, count(*)::int AS n FROM import_records WHERE operation_id = $1 GROUP BY data_type', [operationId], db);
  for (const r of rows) if (r.data_type in out) out[r.data_type as ImportDataType] = r.n;
  return out;
}
