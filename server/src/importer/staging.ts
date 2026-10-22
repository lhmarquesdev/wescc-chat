import { many, pool, query, type Queryable } from '../db/pool';
import { truncate } from '../lib/text';
import type { ImportDataType, StagedRecord } from './types';

const FLUSH_ROWS = 500;

const emptyCounts = (): Record<ImportDataType, number> => ({ user: 0, channel: 0, message: 0, contact: 0 });

// O jsonb do PostgreSQL recusa \u0000 e metades soltas de pares UTF-16; um único caractere desses derrubaria o lote inteiro.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const toJson = (data: unknown) => JSON.stringify(data, (_k, v) => (typeof v === 'string' ? v.replace(/\u0000/g, '').replace(LONE_SURROGATE, '�') : v));

interface Row {
  type: ImportDataType;
  importId: string | null;
  data: string;
}

async function insertRows(operationId: string, rows: Row[], db: Queryable = pool) {
  if (!rows.length) return;
  await query(
    `INSERT INTO import_records (operation_id, data_type, import_id, data)
     SELECT $1, t, i, d FROM unnest($2::text[], $3::text[], $4::jsonb[]) AS x(t, i, d)`,
    [operationId, rows.map((r) => r.type), rows.map((r) => r.importId), rows.map((r) => r.data)],
    db,
  );
}

// Grava os dados lidos do arquivo em lotes, na ordem em que chegam.
export class StagingWriter {
  private buf: Row[] = [];
  private n = emptyCounts();

  constructor(private operationId: string) {}

  async add(type: ImportDataType, importId: string | null, data: unknown): Promise<void> {
    this.buf.push({ type, importId: importId || null, data: toJson(data) });
    this.n[type]++;
    if (this.buf.length >= FLUSH_ROWS) await this.flush();
  }

  async flush(): Promise<void> {
    const rows = this.buf;
    this.buf = [];
    await insertRows(this.operationId, rows);
  }

  counts(): Record<ImportDataType, number> {
    return { ...this.n };
  }
}

// Inserção direta (import.addUsers), dentro da transação de quem chama.
export async function stageRecords(operationId: string, records: { type: ImportDataType; importId: string | null; data: unknown }[], db: Queryable = pool) {
  for (let i = 0; i < records.length; i += FLUSH_ROWS) {
    await insertRows(
      operationId,
      records.slice(i, i + FLUSH_ROWS).map((r) => ({ type: r.type, importId: r.importId || null, data: toJson(r.data) })),
      db,
    );
  }
}

export async function clearStaging(operationId: string): Promise<void> {
  await query('DELETE FROM import_records WHERE operation_id = $1', [operationId]);
}

// Paginação por id (ordem de inserção), sem carregar tudo na memória.
export async function* iterateStaged<T>(operationId: string, type: ImportDataType, batch = 500): AsyncGenerator<StagedRecord<T>[]> {
  let last = 0;
  for (;;) {
    const rows = await many(
      'SELECT id, data_type, import_id, data FROM import_records WHERE operation_id = $1 AND data_type = $2 AND id > $3 ORDER BY id LIMIT $4',
      [operationId, type, last, batch],
    );
    if (!rows.length) return;
    last = Number(rows[rows.length - 1].id);
    yield rows.map((r) => ({ id: Number(r.id), dataType: r.data_type, importId: r.import_id, data: r.data as T }));
    if (rows.length < batch) return;
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
