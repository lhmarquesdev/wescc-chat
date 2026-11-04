// Exportar mensagens de uma sala (HTML, CSV ou JSON, com os arquivos num .zip se a pessoa quiser).
//
// Só lê: nada é publicado na sala, então as regras de quem escreve (somente leitura, canal de avisos, Operação) não
// entram. Precisa ler a sala (loadRoomForUser) e ter export-room-messages nela (papel global ou da sala). O download
// é em dois passos: POST rooms.export confere tudo e devolve um tíquete de uso único, válido por 2 minutos; o GET com
// o tíquete (um <a download> comum, com o cookie de sessão) confere de novo, registra na auditoria e gera o arquivo
// enquanto envia. Sem o tíquete, uma navegação vinda de outro site deixaria um falso "Fulano exportou" na auditoria.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EXPORT_MAX_FILES, exportFileName, ROOM_EXPORT_FORMATS, safeZipName, type RoomExportFormat } from '@shared/dataExport';
import { formatBytes } from '@shared/messageText';
import { config } from '../config';
import { many, one, query } from '../db/pool';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { newId, randomToken, sha256 } from '../lib/ids';
import { zipStore, type ZipEntry } from '../lib/zip';
import { bool, str } from '../api/http';
import { audit } from './audit';
import {
  CSV_HEADER,
  dayHeading,
  dayKey,
  encryptedSql,
  escapeHtml,
  formatDay,
  formatDayTime,
  htmlEnd,
  htmlStart,
  messageCsv,
  messageHtml,
  messageJson,
  nameResolver,
  plural,
  pollVotersOf,
  roomKindLabel,
  roomLabel,
  toExportMessage,
  type FilePlacement,
} from './exportRender';
import { withExtra } from './messages';
import { hasPermission } from './permissions';
import { loadRoomForUser } from './rooms';
import { getSetting } from './settings';
import { actorOf, type Ctx } from './users';

export interface RoomExportParams {
  rid: string;
  from: string;
  to: string;
  format: RoomExportFormat;
  files: boolean;
  threads: boolean;
}

const PAGE = 500;
const TICKET_TTL_SEC = 120;
const TICKETS_PER_MINUTE = 3;

const CONTENT_TYPE: Record<RoomExportFormat | 'zip', string> = {
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  zip: 'application/zip',
};

function parseDate(v: string) {
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw badRequest('error-invalid-date', 'Data inválida.');
  return d;
}

export function parseExportParams(src: Record<string, unknown>, opts: { needFormat: boolean }): RoomExportParams {
  const rid = str(src.rid, 'rid', { max: 64 });
  const dateFrom = str(src.dateFrom, 'dateFrom', { max: 64 });
  const dateTo = str(src.dateTo, 'dateTo', { max: 64 });
  const format = opts.needFormat ? str(src.format, 'format', { max: 16 }) : String(src.format || 'html');
  // Como no Rocket.Chat, "type" diz o destino; aqui só existe o arquivo (nada de mandar por e-mail).
  if (src.type !== undefined && src.type !== null && src.type !== '' && src.type !== 'file') {
    throw badRequest('error-invalid-params', 'Só a exportação para arquivo está disponível.');
  }
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if (from.getTime() > to.getTime()) throw badRequest('error-invalid-period', 'A data inicial precisa ser anterior à final.');
  if (!ROOM_EXPORT_FORMATS.includes(format as RoomExportFormat)) throw badRequest('error-invalid-format', 'Formato inválido. Use html, csv ou json.');
  return { rid, from: from.toISOString(), to: to.toISOString(), format: format as RoomExportFormat, files: bool(src.includeFiles) ?? false, threads: bool(src.includeThreads) ?? true };
}

// Ler a sala e ter a permissão nela. O administrador que não está num grupo privado ou numa DM não exporta: auditar a
// conversa dos outros fica em Auditoria (can-audit).
export async function assertCanExport(ctx: Ctx, rid: string) {
  const room = await loadRoomForUser(ctx, rid);
  if (!(await hasPermission(ctx.userId, 'export-room-messages', rid))) throw forbidden('Você não pode exportar as mensagens desta sala.');
  return room;
}

// Filtro das mensagens do período (m.*). Com threads=false, só as respostas que também foram para a sala (tshow).
function where(p: Pick<RoomExportParams, 'rid' | 'from' | 'to' | 'threads'>, params: unknown[]) {
  const w = [`m.room_id = $${params.push(p.rid)}`, `m.created_at >= $${params.push(p.from)}`, `m.created_at <= $${params.push(p.to)}`];
  if (!p.threads) w.push(`(m.tmid IS NULL OR m.extra->>'tshow' = 'true')`);
  return w.join(' AND ');
}

async function counts(p: RoomExportParams) {
  const enc = encryptedSql('m');
  const mp: unknown[] = [];
  const m = await one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ${enc})::int AS enc FROM messages m WHERE ${where(p, mp)}`, mp);
  const fp: unknown[] = [];
  const f = await one(
    `SELECT count(f.id)::int AS n, coalesce(sum(f.size), 0)::bigint AS size FROM files f JOIN messages m ON m.id = f.message_id WHERE ${where(p, fp)} AND NOT (${enc})`,
    fp,
  );
  return { messages: m.n as number, encrypted: m.enc as number, files: f.n as number, filesSize: Number(f.size) };
}

const maxFilesBytes = () => Math.max(1, getSetting<number>('DataExport_Max_Files_MB') || 2048) * 1024 * 1024;

export async function exportInfo(ctx: Ctx, p: RoomExportParams) {
  const room = await assertCanExport(ctx, p.rid);
  const c = await counts(p);
  const max = maxFilesBytes();
  return {
    messages: c.messages,
    files: c.files,
    filesSize: c.filesSize,
    maxFilesSize: max,
    encrypted: !!room.encrypted || c.encrypted > 0,
    tooLarge: p.files && (c.filesSize > max || c.files > EXPORT_MAX_FILES),
  };
}

async function fileNameFor(ctx: Ctx, room: any, p: RoomExportParams) {
  return exportFileName(await roomLabel(room, ctx.userId), dayKey(p.from), dayKey(p.to), p.files ? 'zip' : p.format);
}

export async function createExportTicket(ctx: Ctx, p: RoomExportParams) {
  const room = await assertCanExport(ctx, p.rid);
  // Antes das contagens (a parte cara): no máximo 3 exportações por minuto para cada pessoa.
  // retryAt: quando a mais antiga do último minuto sai da conta (a tela segura o botão até lá).
  const recent = await one(
    `SELECT count(*)::int AS n, min(created_at) + interval '1 minute' AS retry_at FROM data_exports WHERE kind = 'room' AND user_id = $1 AND created_at > now() - interval '1 minute'`,
    [ctx.userId],
  );
  if (recent.n >= TICKETS_PER_MINUTE) throw new ApiError(429, 'error-too-many-requests', 'Aguarde um minuto antes de exportar de novo.', { retryAt: recent.retry_at });
  const c = await counts(p);
  if (!c.messages) throw badRequest('error-export-empty', 'Não há mensagens nesse período.');
  if (p.files) {
    const max = maxFilesBytes();
    if (c.filesSize > max) {
      throw badRequest(
        'error-export-too-large',
        `Os arquivos do período somam ${formatBytes(c.filesSize)} e o limite é ${formatBytes(max)}. Escolha um período menor ou exporte sem os arquivos.`,
        { filesSize: c.filesSize, maxFilesSize: max },
      );
    }
    if (c.files > EXPORT_MAX_FILES) {
      throw badRequest('error-export-too-large', `São arquivos demais para um .zip (${c.files.toLocaleString('pt-BR')}). Escolha um período menor ou exporte sem os arquivos.`, {
        files: c.files,
      });
    }
  }
  const ticket = randomToken();
  const row = await one(
    `INSERT INTO data_exports (id, kind, user_id, room_id, params, status, token_hash, expires_at)
     VALUES ($1, 'room', $2, $3, $4, 'ready', $5, now() + make_interval(secs => $6)) RETURNING expires_at`,
    [newId(), ctx.userId, room.id, JSON.stringify(p), sha256(ticket), TICKET_TTL_SEC],
  );
  return { url: `/api/v1/rooms.export.download?ticket=${encodeURIComponent(ticket)}`, fileName: await fileNameFor(ctx, room, p), expiresAt: row.expires_at as string };
}

const expired = () => new ApiError(404, 'error-export-expired', 'Este link de download expirou. Peça a exportação de novo.');

// GET com o tíquete: gasta o tíquete (só da própria pessoa, uma vez, dentro do prazo), confere de novo a permissão,
// registra na auditoria e devolve o fluxo do arquivo.
export async function openExport(ctx: Ctx, ticket: string) {
  if (!ticket || ticket.length > 128) throw expired();
  const row = await one(
    `UPDATE data_exports SET downloaded_at = now()
      WHERE token_hash = $1 AND kind = 'room' AND user_id = $2 AND downloaded_at IS NULL AND expires_at > now()
      RETURNING *`,
    [sha256(ticket), ctx.userId],
  );
  if (!row) throw expired();
  const p = row.params as RoomExportParams;
  const room = await assertCanExport(ctx, row.room_id);
  const label = await roomLabel(room, ctx.userId);
  const c = await counts(p);
  await audit(actorOf(ctx), 'room.messages.exported', { rid: room.id, name: label, t: room.t }, {
    format: p.format,
    from: p.from,
    to: p.to,
    threads: p.threads,
    files: p.files,
    messages: c.messages,
    filesSize: p.files ? c.filesSize : 0,
    ticketId: row.id,
  });
  const me = await one('SELECT id, username, name FROM users WHERE id = $1', [ctx.userId]);
  const doc: DocInfo = { p, room, label, me, count: c.messages };
  const fileName = exportFileName(label, dayKey(p.from), dayKey(p.to), p.files ? 'zip' : p.format);
  if (!p.files) return { fileName, contentType: CONTENT_TYPE[p.format], stream: Readable.from(documentChunks(doc, {})) };
  return { fileName, contentType: CONTENT_TYPE.zip, stream: zipStore(zipEntries(doc)) };
}

interface DocInfo {
  p: RoomExportParams;
  room: any;
  label: string;
  me: { id: string; username: string; name: string };
  count: number;
}

// Páginas de 500 mensagens em ordem (created_at, id), consultas curtas: nenhuma conexão do banco fica presa enquanto
// um navegador lento baixa. created_at volta como texto para não perder os microssegundos no cursor (o ISO do JSON
// corta em milissegundos e repetiria a mesma linha). O "created_at >= cursor" explícito deixa o índice
// (room_id, created_at) começar do cursor em vez de reler o período inteiro a cada página.
async function* pages(p: RoomExportParams, extraWhere = '') {
  let ts = p.from;
  let id = '';
  for (;;) {
    const params: unknown[] = [];
    const w = where(p, params);
    const rows = await many(
      `SELECT m.*, m.created_at::text AS cursor_ts FROM messages m
        WHERE ${w}${extraWhere} AND m.created_at >= $${params.push(ts)}::timestamptz AND (m.created_at, m.id) > ($${params.length}::timestamptz, $${params.push(id)})
        ORDER BY m.created_at, m.id LIMIT ${PAGE}`,
      params,
    );
    if (!rows.length) return;
    yield rows;
    const last = rows[rows.length - 1];
    ts = last.cursor_ts;
    id = last.id;
    if (rows.length < PAGE) return;
  }
}

async function* documentChunks(d: DocInfo, place: FilePlacement): AsyncGenerator<string> {
  const { p, room, label, me } = d;
  const names = nameResolver();
  const period = `${formatDay(p.from)} a ${formatDay(p.to)}`;
  if (p.format === 'html') {
    let head = htmlStart(`${label} · ${period}`);
    head += `<header><h1>${escapeHtml(label)}</h1><p class="meta">${escapeHtml(roomKindLabel(room))}</p>`;
    if (room.topic) head += `<p class="meta">Tópico: ${escapeHtml(room.topic)}</p>`;
    head += `<p class="meta">Período: ${escapeHtml(period)} · Exportado por ${escapeHtml(me.name || me.username)} (@${escapeHtml(me.username)}) em ${escapeHtml(formatDayTime(new Date()))}</p>`;
    if (room.encrypted) head += `<p class="meta">Mensagens criptografadas saem como “Mensagem criptografada”: o servidor não tem a chave para lê-las.</p>`;
    head += '</header>';
    yield head;
  } else if (p.format === 'csv') {
    yield `﻿${CSV_HEADER}`;
  } else {
    yield `{"format":"wescc-room-export","version":1,"room":${JSON.stringify({ id: room.id, name: label, type: room.t, kind: roomKindLabel(room), topic: room.topic || null })},` +
      `"period":${JSON.stringify({ from: p.from, to: p.to })},"exportedAt":${JSON.stringify(new Date().toISOString())},` +
      `"exportedBy":${JSON.stringify({ id: me.id, username: me.username })},"messages":[`;
  }
  let n = 0;
  let day = '';
  for await (const rows of pages(p)) {
    await names.prime(rows, p.format === 'html');
    // Enquetes não anônimas: quem votou em cada opção (a sala vê isso no chat).
    const pagePlace: FilePlacement = { ...place, pollVoters: await pollVotersOf(rows) };
    let out = '';
    for (const row of rows) {
      // mapMessage não leva a coluna e2e: ela vai junto da linha crua, para isEncryptedMessage enxergar.
      const em = toExportMessage({ ...withExtra(row), e2e: row.e2e }, names.nameOf, pagePlace);
      if (p.format === 'html') {
        const k = dayKey(em.ts);
        if (k !== day) {
          day = k;
          out += dayHeading(em.ts);
        }
        out += messageHtml(em, names.nameOf);
      } else if (p.format === 'csv') out += messageCsv(em);
      else out += (n ? ',' : '') + messageJson(em);
      n++;
    }
    yield out;
  }
  if (p.format === 'html') yield htmlEnd(`${escapeHtml(plural(n, 'mensagem exportada', 'mensagens exportadas'))}.`);
  else if (p.format === 'json') yield ']}';
}

// .zip: os arquivos primeiro, cada um aberto antes de entrar no .zip (o que não abre fica de fora e o documento diz
// "Arquivo indisponível"); o documento por último, quando já se sabe o que entrou. Arquivos de mensagens cifradas
// nunca entram.
async function* zipEntries(d: DocInfo): AsyncGenerator<ZipEntry> {
  const zipped = new Map<string, string>();
  const enc = encryptedSql('m');
  for await (const rows of pages(d.p, ` AND m.files <> '[]'::jsonb AND NOT (${enc})`)) {
    const byMessage = new Map<string, any[]>();
    for (const f of await many('SELECT id, name, size, storage_path, message_id, created_at FROM files WHERE message_id = ANY($1)', [rows.map((r) => r.id)])) {
      byMessage.set(f.message_id, [...(byMessage.get(f.message_id) ?? []), f]);
    }
    for (const m of rows) {
      const stored = new Map((byMessage.get(m.id) ?? []).map((f) => [f.id, f]));
      // Na ordem em que a mensagem lista os arquivos.
      for (const ref of (m.files ?? []) as { _id: string }[]) {
        const f = stored.get(ref._id);
        if (!f || zipped.has(f.id)) continue;
        const fh = await fs.promises.open(path.join(config.uploadDir, f.storage_path), 'r').catch(() => null);
        if (!fh) continue;
        const name = `arquivos/${safeZipName(f.id, f.name)}`;
        zipped.set(f.id, name);
        yield { name, stream: fh.createReadStream(), mtime: new Date(f.created_at) };
      }
    }
  }
  yield { name: `mensagens.${d.p.format}`, stream: Readable.from(documentChunks(d, { zipped })), mtime: new Date() };
}

