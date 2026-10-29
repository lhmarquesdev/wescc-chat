// Sincronização das contas de agenda. Cada rodada de uma conta:
//   trazer (import/both): lê a janela [hoje − 30 dias, hoje + 365 dias] e reconcilia os eventos trazidos daquela conta
//     (novos, mudados e os que sumiram lá). As cópias gravadas pelo chat são reconhecidas e não voltam.
//   levar (export/both): cada evento do chat da pessoa (dela ou em que foi convidada e não recusou) ganha uma cópia lá;
//     muda quando o evento muda e é apagada quando o evento é cancelado, a pessoa recusa ou sai dos convidados.
// Rodadas: a cada Calendar_Sync_Minutes (agendador) e logo depois de uma mudança no chat (setSyncKicker).
import type { CalendarProvider } from '@shared/calendar';
import { many, one, pool, query } from '../db/pool';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';
import { getSetting } from '../services/settings';
import { accessToken, markAccount } from './accounts';
import { setSyncKicker } from './dirty';
import { calendarOn, meetingUrl } from './events';
import { CalHttpError } from './http';
import { apis, type ExternalEvent, type OutgoingEvent } from './providers';

const DAY = 86_400_000;
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

export interface SyncResult {
  imported: number;
  removed: number;
  pushed: number;
  deleted: number;
  error?: string;
}

const same = (a: Date | string | null, b: Date | string | null) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

// ---------- Trazer ----------

async function importWindow(account: any, token: string): Promise<{ imported: number; removed: number }> {
  const api = apis[account.provider as CalendarProvider];
  const from = new Date(Date.now() - PAST_DAYS * DAY);
  const to = new Date(Date.now() + FUTURE_DAYS * DAY);
  const remote = await api.list(token, from, to);
  const ourIds = new Set((await many(`SELECT external_id FROM calendar_exports WHERE account_id = $1`, [account.id])).map((r) => r.external_id));
  const wanted = new Map<string, ExternalEvent>();
  for (const e of remote) if (!e.ours && !ourIds.has(e.id)) wanted.set(e.id, e);

  const local = await many(`SELECT * FROM calendar_events WHERE account_id = $1`, [account.id]);
  const byExt = new Map(local.map((r) => [r.external_id, r]));
  let imported = 0;
  let removed = 0;
  for (const e of wanted.values()) {
    const r = byExt.get(e.id);
    if (
      r &&
      r.title === e.title &&
      r.description === e.description &&
      r.location === e.location &&
      same(r.starts_at, e.startsAt) &&
      same(r.ends_at, e.endsAt) &&
      r.all_day === e.allDay &&
      (r.external_url ?? null) === e.url &&
      (r.external_join_url ?? null) === e.joinUrl
    )
      continue;
    await query(
      `INSERT INTO calendar_events (id, owner_id, title, description, location, starts_at, ends_at, all_day, source, account_id, external_id, external_url, external_join_url, reminder_minutes)
       VALUES ($13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)
       ON CONFLICT (account_id, external_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, location = EXCLUDED.location,
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, all_day = EXCLUDED.all_day, external_url = EXCLUDED.external_url,
         external_join_url = EXCLUDED.external_join_url, updated_at = now()`,
      [account.user_id, e.title, e.description, e.location, e.startsAt, e.endsAt, e.allDay, account.provider, account.id, e.id, e.url, e.joinUrl, newId()],
    );
    imported++;
  }
  // Sumiu lá (apagado, cancelado ou fora da janela): sai daqui.
  const gone = local.filter((r) => !wanted.has(r.external_id)).map((r) => r.id);
  if (gone.length) {
    await query(`DELETE FROM calendar_events WHERE id = ANY($1)`, [gone]);
    removed = gone.length;
  }
  return { imported, removed };
}

// ---------- Levar ----------

function outgoing(e: any): OutgoingEvent {
  const parts = [e.description];
  let location = e.location;
  if (e.is_meeting && e.meeting_code) {
    const url = meetingUrl(e.meeting_code);
    parts.push(`Entrar na reunião: ${url}`);
    if (!location) location = url;
  }
  return {
    eventId: e.id,
    title: e.title,
    description: parts.filter(Boolean).join('\n\n'),
    location,
    startsAt: new Date(e.starts_at),
    endsAt: new Date(e.ends_at),
    allDay: e.all_day,
  };
}

async function exportEvents(account: any, token: string, maxMs = 60_000): Promise<{ pushed: number; deleted: number }> {
  const api = apis[account.provider as CalendarProvider];
  const started = Date.now();
  const horizon = new Date(Date.now() + FUTURE_DAYS * DAY);
  const since = new Date(Date.now() - DAY);
  // Eventos que devem ter cópia: do chat, confirmados, da pessoa ou com convite não recusado, ainda não terminados.
  const events = await many(
    `SELECT e.*, x.external_id AS x_external_id, x.version AS x_version FROM calendar_events e
       LEFT JOIN calendar_exports x ON x.event_id = e.id AND x.account_id = $2
      WHERE e.source = 'chat' AND e.status = 'confirmed' AND e.ends_at > $3 AND e.starts_at < $4
        AND (e.owner_id = $1 OR EXISTS (SELECT 1 FROM calendar_attendees a WHERE a.event_id = e.id AND a.user_id = $1 AND a.response <> 'declined'))
      ORDER BY e.starts_at LIMIT 1000`,
    [account.user_id, account.id, since, horizon],
  );
  let pushed = 0;
  let deleted = 0;
  const keep = new Set<string>();
  for (const e of events) {
    keep.add(e.id);
    if (e.x_external_id && same(e.x_version, e.updated_at)) continue;
    if (Date.now() - started > maxMs) break; // o resto vai na próxima rodada
    const body = outgoing(e);
    if (e.x_external_id) {
      try {
        await api.update(token, e.x_external_id, body);
        await query(`UPDATE calendar_exports SET version = $3 WHERE event_id = $1 AND account_id = $2`, [e.id, account.id, e.updated_at]);
        pushed++;
        continue;
      } catch (err) {
        if (!(err instanceof CalHttpError && (err.kind === 'notFound' || err.kind === 'gone'))) throw err;
        // A pessoa apagou a cópia lá: grava outra.
        await query(`DELETE FROM calendar_exports WHERE event_id = $1 AND account_id = $2`, [e.id, account.id]);
      }
    }
    const externalId = await api.create(token, body);
    await query(
      `INSERT INTO calendar_exports (event_id, account_id, external_id, version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, account_id) DO UPDATE SET external_id = EXCLUDED.external_id, version = EXCLUDED.version`,
      [e.id, account.id, externalId, e.updated_at],
    );
    pushed++;
  }
  // Cópias que não devem mais existir: evento cancelado, recusado, sem a pessoa, já terminado ou fora da janela.
  const stale = await many(`SELECT event_id, external_id FROM calendar_exports WHERE account_id = $1 AND NOT (event_id = ANY($2))`, [account.id, [...keep]]);
  for (const x of stale) {
    if (Date.now() - started > maxMs) break;
    const ev = await one(`SELECT status, ends_at FROM calendar_events WHERE id = $1`, [x.event_id]);
    // Terminado há mais de um dia: a cópia fica lá como histórico, só deixa de ser acompanhada.
    const finished = ev && ev.status === 'confirmed' && new Date(ev.ends_at) <= since;
    if (!finished) {
      await api.remove(token, x.external_id);
      deleted++;
    }
    await query(`DELETE FROM calendar_exports WHERE event_id = $1 AND account_id = $2`, [x.event_id, account.id]);
  }
  return { pushed, deleted };
}

// Apaga lá as cópias dos eventos do chat (desconectar). futureOnly: só o que ainda não terminou.
export async function removeExports(accountId: string, o: { futureOnly?: boolean; maxMs?: number } = {}): Promise<number> {
  const account = await one(`SELECT * FROM calendar_accounts WHERE id = $1`, [accountId]);
  if (!account) return 0;
  const token = await accessToken(accountId);
  const api = apis[account.provider as CalendarProvider];
  const rows = await many(
    `SELECT x.external_id FROM calendar_exports x JOIN calendar_events e ON e.id = x.event_id
      WHERE x.account_id = $1 AND ($2::boolean IS NOT TRUE OR e.ends_at > now())`,
    [accountId, o.futureOnly === true],
  );
  const started = Date.now();
  let n = 0;
  for (const r of rows) {
    if (Date.now() - started > (o.maxMs ?? 30_000)) break;
    await api.remove(token, r.external_id);
    n++;
  }
  return n;
}

// ---------- Rodada ----------

// Uma rodada por conta de cada vez nesta instância: quem pede durante uma rodada ganha a próxima (uma só, para todos
// os pedidos que chegarem enquanto ela espera), que começa quando a atual termina.
const inflight = new Map<string, Promise<SyncResult>>();
const queued = new Map<string, Promise<SyncResult>>();

export function syncAccount(accountId: string): Promise<SyncResult> {
  const waiting = queued.get(accountId);
  if (waiting) return waiting;
  const current = inflight.get(accountId);
  if (!current) return begin(accountId);
  const next = current
    .catch(() => undefined)
    .then(() => {
      queued.delete(accountId);
      return begin(accountId);
    });
  queued.set(accountId, next);
  return next;
}

function begin(accountId: string): Promise<SyncResult> {
  const p = runOnce(accountId).finally(() => {
    if (inflight.get(accountId) === p) inflight.delete(accountId);
  });
  inflight.set(accountId, p);
  return p;
}

async function runOnce(accountId: string): Promise<SyncResult> {
  const result: SyncResult = { imported: 0, removed: 0, pushed: 0, deleted: 0 };
  // Trava da conta no banco: outra instância (ou a rodada periódica) sincronizando a mesma conta gravaria cópias em dobro.
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(727131, hashtext($1)) AS ok', [accountId])).rows[0].ok;
    if (!locked) return result;
    const account = await one(`SELECT * FROM calendar_accounts WHERE id = $1`, [accountId]);
    if (!account || account.status === 'expired') return result;
    // Limpa a marca antes: uma mudança durante a rodada marca de novo e ganha outra rodada.
    await query(`UPDATE calendar_accounts SET dirty = false WHERE id = $1`, [accountId]);
    try {
      const token = await accessToken(accountId);
      if (account.direction !== 'export') Object.assign(result, await importWindow(account, token));
      if (account.direction !== 'import') Object.assign(result, await exportEvents(account, token));
      await query(`UPDATE calendar_accounts SET last_sync_at = now() WHERE id = $1`, [accountId]);
      await markAccount(accountId, 'ok', null);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      result.error = text;
      if (e instanceof CalHttpError && e.kind === 'auth') await markAccount(accountId, 'expired', text);
      else if (e instanceof CalHttpError && e.kind === 'retry') await query(`UPDATE calendar_accounts SET dirty = true WHERE id = $1`, [accountId]);
      else await markAccount(accountId, 'error', text);
    }
    if (result.imported || result.removed) bus.publish({ user: account.user_id }, { type: 'calendar.changed' });
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(727131, hashtext($1))', [accountId]).catch(() => {});
    client.release();
  }
}

// Logo depois de uma mudança: roda fora da requisição, uma conta de cada vez.
export function kickAccount(accountId: string) {
  setTimeout(() => void syncAccount(accountId).catch(() => {}), 50).unref?.();
}

setSyncKicker((ids) => {
  for (const id of ids) kickAccount(id);
});

// Rodada periódica (o agendador chama a cada minuto, com trava): contas marcadas ou cuja última rodada passou do intervalo.
export async function syncDue(log: (m: string) => void = () => {}): Promise<number> {
  if (!calendarOn()) return 0;
  const minutes = Math.max(1, Number(getSetting('Calendar_Sync_Minutes') ?? 5) || 5);
  const due = await many(
    `SELECT id FROM calendar_accounts WHERE status <> 'expired' AND (dirty OR last_sync_at IS NULL OR last_sync_at < now() - $1 * interval '1 minute')
      ORDER BY last_sync_at NULLS FIRST LIMIT 200`,
    [minutes],
  );
  for (const a of due) {
    const r = await syncAccount(a.id);
    if (r.error) log(`agenda: conta ${a.id}: ${r.error}`);
  }
  // Eventos cancelados há mais de 30 dias sem cópias pendentes saem do banco.
  await query(
    `DELETE FROM calendar_events e WHERE e.status = 'canceled' AND e.canceled_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM calendar_exports x WHERE x.event_id = e.id)`,
  );
  return due.length;
}
