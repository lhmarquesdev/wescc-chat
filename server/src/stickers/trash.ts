import fs from 'node:fs';
import { many, one, pool, query, type Queryable } from '../db/pool';
import { deleteStored, moveStored, storedPath, withFsRetry } from '../services/uploads';
import { destroyStickerStreams } from './files';

// Lixeira de arquivos das figurinhas. A linha entra na mesma transação que tira o arquivo de uso e só sai
// quando o disco obedece: no Windows, antivírus e indexador seguram arquivos e um erro engolido deixaria
// conteúdo removido no disco para sempre.

// Arquivo de figurinha (AAAA/MM/<id>, quarantine/<id>, com ou sem .poster) -> id do arquivo.
const fileIdOf = (rel: string) => (rel.split('/').pop() ?? '').replace(/\.poster$/, '');

const BATCH = 500;

// moveTo vazio = apagar; senão, mover para lá (quarentena). Uma linha que já existia passa a valer agora.
export async function queueTrash(db: Queryable, path: string | null | undefined, moveTo?: string | null): Promise<void> {
  if (!path) return;
  // Apagar um destino de quarentena que ainda não recebeu o arquivo: a mudança pendente vira exclusão da origem,
  // senão ela traria o arquivo de volta depois.
  if (!moveTo) await query('UPDATE sticker_trash SET move_to = NULL WHERE move_to = $1', [path], db);
  await query(
    'INSERT INTO sticker_trash (path, move_to) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET since = least(sticker_trash.since, now())',
    [path, moveTo ?? null],
    db,
  );
}

// Antes de gravar bytes novos. Se o processo cair antes do commit, a limpeza diária apaga o arquivo depois do prazo;
// a transação que passa a usar o arquivo tira a linha (claimWritten), e quem desiste drena com `only`.
export async function queuePendingWrite(paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((p): p is string => !!p);
  if (list.length) {
    await query(`INSERT INTO sticker_trash (path, since) SELECT unnest($1::text[]), now() + interval '1 hour' ON CONFLICT (path) DO NOTHING`, [list]);
  }
}

export async function claimWritten(db: Queryable, paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((p): p is string => !!p);
  if (list.length) await query('DELETE FROM sticker_trash WHERE path = ANY($1)', [list], db);
}

const exists = (rel: string) =>
  fs.promises.access(storedPath(rel)).then(
    () => true,
    () => false,
  );

// Caminhos que alguma linha de arquivo ainda usa. O id está no próprio caminho, então é uma busca pela chave.
async function inUse(paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const rows = await many('SELECT path, poster_path, quarantine_path, quarantine_poster_path FROM sticker_files WHERE id = ANY($1)', [
    [...new Set(paths.map(fileIdOf))],
  ]);
  return new Set(rows.flatMap((r) => [r.path, r.poster_path, r.quarantine_path, r.quarantine_poster_path]).filter(Boolean));
}

// `only`: só estes caminhos, mesmo antes do prazo. Sem `only`: tudo o que já venceu, em lotes, sem repetir o que falhou agora.
export async function drainStickerTrash(opts: { only?: (string | null | undefined)[] } = {}): Promise<{ done: number; failed: number; stuck: number }> {
  const only = opts.only?.filter((p): p is string => !!p);
  if (only && !only.length) return { done: 0, failed: 0, stuck: 0 };
  let done = 0;
  const failed: string[] = [];
  for (;;) {
    const rows = only
      ? await many('SELECT path, move_to FROM sticker_trash WHERE path = ANY($1) ORDER BY since', [only])
      : await many(`SELECT path, move_to FROM sticker_trash WHERE since <= now() AND NOT (path = ANY($1)) ORDER BY since LIMIT ${BATCH}`, [failed]);
    const used = await inUse(rows.map((r) => r.path));
    for (const r of rows) {
      destroyStickerStreams(fileIdOf(r.path));
      try {
        if (used.has(r.path)) {
          // Uma linha ainda usa o caminho (o commit passou e só a resposta se perdeu, por exemplo): o arquivo fica.
        } else if (r.move_to) {
          try {
            await moveStored(r.path, r.move_to);
          } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e;
            // A origem já não existe. Sem a cópia também, a moderação não tem mais o que abrir.
            if (!(await exists(r.move_to))) {
              await query(
                `UPDATE sticker_files SET
                   quarantine_path = CASE WHEN quarantine_path = $2 THEN NULL ELSE quarantine_path END,
                   quarantine_poster_path = CASE WHEN quarantine_poster_path = $2 THEN NULL ELSE quarantine_poster_path END
                 WHERE id = $1`,
                [fileIdOf(r.move_to), r.move_to],
              );
            }
          }
        } else {
          await deleteStored(r.path);
          // Um corte no meio da gravação deixa só o .tmp (linha da gravação pendente). Se o antivírus ainda o
          // segura, a linha fica para a próxima limpeza: depois dela ninguém mais sabe que o .tmp existe.
          await withFsRetry(() => fs.promises.unlink(`${storedPath(r.path)}.tmp`)).catch((e) => {
            if (e?.code !== 'ENOENT') throw e;
          });
        }
        await query('DELETE FROM sticker_trash WHERE path = $1', [r.path]);
        done++;
      } catch (e: any) {
        failed.push(r.path);
        const err = `${e?.code ?? 'erro'}: ${String(e?.message ?? e).slice(0, 300)}`;
        await query('UPDATE sticker_trash SET attempts = attempts + 1, last_error = $2 WHERE path = $1', [r.path, err]).catch(() => {});
      }
    }
    if (only || rows.length < BATCH) break;
  }
  // Presa = já tentou, falhou e está lá há mais de 3 dias. O que nunca foi tentado não conta.
  const stuck = await one<{ n: number }>(`SELECT count(*)::int AS n FROM sticker_trash WHERE attempts > 0 AND since < now() - interval '3 days'`, [], pool);
  return { done, failed: failed.length, stuck: stuck?.n ?? 0 };
}
