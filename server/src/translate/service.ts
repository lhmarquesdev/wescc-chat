import type { MessageTranslation, TranslateFailReason, TranslateLanguage, TranslateResponse } from '@shared/translate';
import {
  cleanRun,
  DETECT_MIN_CONFIDENCE,
  joinTranslation,
  LANG_RE,
  letterCount,
  MIN_LETTERS,
  normalizeLang,
  pickLanguage,
  runsOf,
  sameLanguage,
  splitForTranslation,
  targetFor,
  translatableMessage,
  TRANSLATE_MAX_IDS,
  type Piece,
} from '@shared/translate';
import { config } from '../config';
import { many, one } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { hasPermission } from '../services/permissions';
import { getSubscriptionRow, loadRoomForUser, notifySubscription } from '../services/rooms';
import { getSetting } from '../services/settings';
import type { Ctx } from '../services/users';
import {
  cachedLanguages,
  libreConfig,
  libreConfigForTest,
  libreDetect,
  LibreError,
  libreFrontendSettings,
  libreLanguages,
  libreTranslate,
  type LibreConn,
  type LibreLanguage,
} from './libre';

// Tradução sob demanda, por quem lê: nada é traduzido ao enviar. O resultado fica guardado por mensagem + idioma e
// serve para os leitores seguintes; vale só para o texto atual (source_hash, calculado no PostgreSQL). Não publica
// nada na sala: não cria mensagem, não edita, não marca como lida. Quem traduz precisa poder ler a sala.

export const TRANSLATE_TEXT = {
  disabled: 'A tradução de mensagens está desligada.',
  notAllowed: 'Você não tem permissão para traduzir mensagens.',
  encrypted: 'Mensagens de salas criptografadas não são traduzidas.',
  ids: `Envie de 1 a ${TRANSLATE_MAX_IDS} mensagens por vez.`,
  language: 'Este idioma não está disponível no servidor de tradução.',
  notInRoom: 'Você não está nesta sala.',
};

const NOTICE: Partial<Record<TranslateFailReason, string>> = {
  config: 'A tradução não está disponível: o servidor de tradução não está configurado direito. Avise o administrador.',
  timeout: 'O servidor de tradução não está respondendo. Mostrando o texto original.',
  unavailable: 'O servidor de tradução não está respondendo. Mostrando o texto original.',
  busy: 'O servidor de tradução está ocupado. Tentando de novo em instantes.',
  rate: 'Muitas traduções seguidas. As próximas aparecem em instantes.',
  'too-long': 'Uma mensagem é longa demais para o servidor de tradução.',
};
// Do mais grave ao menos grave ('changed' não gera aviso).
const SEVERITY: TranslateFailReason[] = ['config', 'timeout', 'unavailable', 'busy', 'rate', 'too-long'];

const disabled = () => badRequest('error-translate-disabled', TRANSLATE_TEXT.disabled);
// O forbidden() padrão é em inglês: este texto a web mostra direto.
const notAllowed = () => new ApiError(403, 'error-not-allowed', TRANSLATE_TEXT.notAllowed);
const badLanguage = () => badRequest('error-translate-language', TRANSLATE_TEXT.language);

// Ligada e com endereço preenchido.
export function translateOn(): boolean {
  return !!getSetting<boolean>('AutoTranslate_Enabled') && !!String(getSetting<string>('AutoTranslate_LibreTranslate_Url') ?? '').trim();
}

export async function assertCanTranslate(ctx: Ctx) {
  if (!translateOn()) throw disabled();
  if (!(await hasPermission(ctx.userId, 'auto-translate'))) throw notAllowed();
}

const timeoutMs = () => (Number(getSetting<number>('AutoTranslate_Timeout_Seconds')) || 15) * 1000;

// ---------- Estado da instância: fila, balde por pessoa, disjuntor, pedidos em andamento ----------
// (como os limites do Jira: com várias instâncias, cada uma tem os seus; o cache no banco é de todas)

let breakerMs = 30_000;
let breakerUntil = 0;
const buckets = new Map<string, { tokens: number; at: number }>();
let running = 0;
const waiting: (() => void)[] = [];
const inflight = new Map<string, Promise<MessageTranslation>>();

export function __resetTranslateForTests(o: { breakerMs?: number } = {}) {
  breakerMs = o.breakerMs ?? 30_000;
  breakerUntil = 0;
  buckets.clear();
  inflight.clear();
}

const breakerOpen = () => Date.now() < breakerUntil;

// Servidor fora ou lento: 30 s sem chamá-lo. Só a abertura vai para o log (nunca texto de mensagem).
function openBreaker(code: string) {
  const was = breakerOpen();
  breakerUntil = Date.now() + breakerMs;
  if (!was && config.logLevel !== 'silent') console.error(`[tradução] servidor indisponível: ${code}`);
}

// No máximo AutoTranslate_Max_Concurrent chamadas ao mesmo tempo (o LT_THREADS do LibreTranslate é 4 por padrão).
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  const max = Math.max(1, Number(getSetting<number>('AutoTranslate_Max_Concurrent')) || 4);
  while (running >= max) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// Balde por pessoa: capacidade e reposição de AutoTranslate_User_Limit_Per_Minute por minuto. Cada mensagem que precisa
// do LibreTranslate gasta 1 (take); o que vem do banco não gasta. wait: quando cabem as que ficaram de fora.
function bucketOf(userId: string) {
  const per = Math.max(1, Number(getSetting<number>('AutoTranslate_User_Limit_Per_Minute')) || 120);
  const now = Date.now();
  const b = buckets.get(userId) ?? { tokens: per, at: now };
  b.tokens = Math.min(per, b.tokens + ((now - b.at) / 60_000) * per);
  b.at = now;
  if (buckets.size > 10_000) buckets.clear();
  buckets.set(userId, b);
  return {
    take(): boolean {
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    wait: (missing: number) => Math.max(1000, Math.ceil(((missing - b.tokens) / per) * 60_000)),
  };
}

// Erros de configuração (endereço, rede da empresa, chave) não são "servidor fora": não abrem o disjuntor.
const isConfigError = (e: unknown) => e instanceof LibreError && (e.code === 'not-configured' || e.code === 'external' || e.code === 'auth');

function failReason(e: unknown): TranslateFailReason {
  if (isConfigError(e)) return 'config';
  if (e instanceof LibreError && (e.code === 'busy' || e.code === 'timeout' || e.code === 'too-long')) return e.code;
  return 'unavailable';
}

// ---------- Idiomas ----------

type Languages = { list: LibreLanguage[] } | { error: TranslateFailReason };

// A lista do servidor (guardada 10 min). Com o disjuntor aberto, só a guardada.
async function serverLanguages(c: LibreConn | null): Promise<Languages> {
  if (!c) return { error: 'config' };
  if (breakerOpen()) {
    const hit = cachedLanguages(c);
    return hit ? { list: hit } : { error: 'unavailable' };
  }
  try {
    return { list: await slot(() => libreLanguages(c)) };
  } catch (e) {
    if (e instanceof LibreError && (e.code === 'timeout' || e.code === 'unavailable')) openBreaker(e.code);
    return { error: failReason(e) };
  }
}

function connOrNull(): LibreConn | null {
  try {
    return libreConfig();
  } catch {
    return null;
  }
}

export async function supportedLanguages(): Promise<{ languages: TranslateLanguage[]; unavailable?: true }> {
  const r = await serverLanguages(connOrNull());
  if (!('list' in r)) return { languages: [], unavailable: true };
  return { languages: r.list.map((l) => ({ language: l.code, name: l.name })) };
}

// ---------- Traduzir ----------

interface Row {
  id: string;
  msg: string;
  t: string | null;
  extra: Record<string, unknown> | null;
  e2e: unknown;
  h: string;
  det: string | null;
  conf: number | null;
  det_h: string | null;
  tr_text: string | null;
  tr_h: string | null;
  tr_src: string | null;
}

interface Work {
  row: Row;
  pieces: Piece[];
  det: string | null; // idioma já conhecido do texto atual
  resolve: (r: MessageTranslation) => void;
}

type Result = Omit<MessageTranslation, '_id' | 'language'>;

// Grava só se o texto da mensagem, agora, ainda é o mesmo e a sala não é criptografada (nem a mensagem cifrada: a
// coluna messages.e2e, quando existir, é lida pelo to_jsonb, sem o SQL depender dela).
const GUARD = `m.t IS NULL AND (to_jsonb(m) ->> 'e2e') IS NULL AND NOT r.encrypted AND encode(sha256(convert_to(m.msg, 'UTF8')), 'base64')`;

async function saveDetection(id: string, hash: string, language: string, confidence: number): Promise<boolean> {
  const r = await one(
    `INSERT INTO message_languages (message_id, source_hash, language, confidence)
     SELECT m.id, $2, $3, $4 FROM messages m JOIN rooms r ON r.id = m.room_id
      WHERE m.id = $1 AND ${GUARD} = $2
     ON CONFLICT (message_id) DO UPDATE SET source_hash = EXCLUDED.source_hash, language = EXCLUDED.language,
       confidence = EXCLUDED.confidence, created_at = now()
     RETURNING 1 AS ok`,
    [id, hash, language, confidence],
  );
  return !!r;
}

async function saveTranslation(id: string, target: string, hash: string, source: string, text: string): Promise<boolean> {
  const r = await one(
    `INSERT INTO message_translations (message_id, language, source_hash, source_language, text)
     SELECT m.id, $2, $3, $4, $5 FROM messages m JOIN rooms r ON r.id = m.room_id
      WHERE m.id = $1 AND ${GUARD} = $3
     ON CONFLICT (message_id, language) DO UPDATE SET source_hash = EXCLUDED.source_hash,
       source_language = EXCLUDED.source_language, text = EXCLUDED.text, created_at = now()
     RETURNING 1 AS ok`,
    [id, target, hash, source, text],
  );
  return !!r;
}

const MAX_RUNS_PER_CALL = 20;
const MAX_CHARS_PER_CALL = 3000;

// Trechos em chamadas de no máximo 20 trechos e 3.000 caracteres, uma depois da outra.
async function translateRuns(runs: string[], source: string, target: string, c: LibreConn): Promise<string[]> {
  const out: string[] = [];
  let chunk: string[] = [];
  let chars = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const q = chunk;
    chunk = [];
    chars = 0;
    out.push(...(await slot(() => libreTranslate(q, source, target, c))));
  };
  for (const r of runs) {
    if (chunk.length && (chunk.length >= MAX_RUNS_PER_CALL || chars + r.length > MAX_CHARS_PER_CALL)) await flush();
    chunk.push(r);
    chars += r.length;
  }
  await flush();
  return out;
}

// Mensagens inteiras em lotes de até 20 trechos e 3.000 caracteres (trechos iguais no mesmo lote contam uma vez).
function packBatches(items: Work[]): Work[][] {
  const out: Work[][] = [];
  let cur: Work[] = [];
  let seen = new Set<string>();
  let chars = 0;
  for (const w of items) {
    const mine = [...new Set(runsOf(w.pieces))];
    const extra = mine.filter((r) => !seen.has(r));
    const extraChars = extra.reduce((n, r) => n + r.length, 0);
    if (cur.length && (seen.size + extra.length > MAX_RUNS_PER_CALL || chars + extraChars > MAX_CHARS_PER_CALL)) {
      out.push(cur);
      cur = [];
      seen = new Set();
      chars = 0;
    }
    for (const r of mine) {
      if (seen.has(r)) continue;
      seen.add(r);
      chars += r.length;
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

// O trabalho dos itens deste pedido: detectar (por mensagem), conferir a origem e traduzir agrupado por origem.
// finish entrega o resultado para a resposta e para quem está esperando a mesma tradução.
async function runWork(items: Work[], target: string, langs: LibreLanguage[], c: LibreConn, finish: (w: Work, r: Result) => void, hints: number[]) {
  const settled = new Set<Work>();
  const end = (w: Work, r: Result) => {
    if (settled.has(w)) return;
    settled.add(w);
    finish(w, r);
  };
  const fail = (w: Work, e: unknown) => {
    if (e instanceof LibreError) {
      if (e.code === 'timeout' || e.code === 'unavailable') openBreaker(e.code);
      if (e.retryAfterMs) hints.push(e.retryAfterMs);
    }
    end(w, { status: 'failed', reason: failReason(e) });
  };
  try {
    // 1. Detectar, uma mensagem por vez (num lote com source 'auto' o LibreTranslate usaria o idioma da primeira para
    //    todas). O que já está no idioma de destino não vai ao tradutor.
    await Promise.all(
      items.map(async (w) => {
        if (w.det) return;
        try {
          const d = await slot(() => libreDetect(runsOf(w.pieces).join(' ').slice(0, 2000), c));
          const language = normalizeLang(d.language);
          if (!(await saveDetection(w.row.id, w.row.h, language, d.confidence))) return end(w, { status: 'failed', reason: 'changed' });
          // O LibreTranslate devolve "en" com confiança 0 quando não sabe.
          if (d.confidence < DETECT_MIN_CONFIDENCE) return end(w, { status: 'unknown' });
          if (sameLanguage(language, target)) return end(w, { status: 'same', source: language });
          w.det = language;
        } catch (e) {
          fail(w, e);
        }
      }),
    );
    // 2. Origem instalada no servidor e com este destino.
    const codes = langs.map((l) => l.code);
    const groups = new Map<string, { source: string; target: string; items: Work[] }>();
    for (const w of items) {
      if (settled.has(w) || !w.det) continue;
      const source = pickLanguage(w.det, codes);
      const targets = source ? (langs.find((l) => l.code === source)?.targets ?? []) : [];
      const to = targets.length ? pickLanguage(target, targets) : target;
      if (!source || !to) {
        end(w, { status: 'unsupported', source: w.det });
        continue;
      }
      const g = groups.get(`${source}>${to}`) ?? { source, target: to, items: [] };
      g.items.push(w);
      groups.set(`${source}>${to}`, g);
    }
    // 3. Traduzir com a origem explícita; a mensagem é remontada com os pedaços que não foram ao tradutor.
    const store = async (w: Work, source: string, out: Map<string, string>) => {
      const cleaned = runsOf(w.pieces).map((r) => cleanRun(r, out.get(r) ?? ''));
      if (cleaned.some((x) => x === null)) return end(w, { status: 'failed', reason: 'unavailable' });
      const text = joinTranslation(w.pieces, cleaned as string[]);
      // Sem linha gravada: a mensagem foi editada, removida ou a sala passou a ser criptografada durante a chamada.
      const saved = await saveTranslation(w.row.id, target, w.row.h, source, text);
      end(w, saved ? { status: 'translated', source, text } : { status: 'failed', reason: 'changed' });
    };
    const alone = async (w: Work, g: { source: string; target: string }) => {
      const runs = [...new Set(runsOf(w.pieces))];
      try {
        const out = await translateRuns(runs, g.source, g.target, c);
        await store(w, g.source, new Map(runs.map((r, i) => [r, out[i]])));
      } catch (e) {
        if (e instanceof LibreError && e.code === 'unsupported') return end(w, { status: 'unsupported', source: w.det ?? g.source });
        if (e instanceof LibreError && e.code === 'invalid') return end(w, { status: 'failed', reason: 'unavailable' });
        fail(w, e);
      }
    };
    const calls: Promise<void>[] = [];
    for (const g of groups.values()) {
      for (const batch of packBatches(g.items)) {
        calls.push(
          (async () => {
            if (batch.length === 1) return alone(batch[0], g);
            const runs = [...new Set(batch.flatMap((w) => runsOf(w.pieces)))];
            let out: string[];
            try {
              out = await translateRuns(runs, g.source, g.target, c);
            } catch (e) {
              // Uma mensagem do lote pode ser o problema: cada uma sozinha.
              if (e instanceof LibreError && (e.code === 'too-long' || e.code === 'unsupported' || e.code === 'invalid')) {
                await Promise.all(batch.map((w) => alone(w, g)));
                return;
              }
              for (const w of batch) fail(w, e);
              return;
            }
            const map = new Map(runs.map((r, i) => [r, out[i]]));
            for (const w of batch) await store(w, g.source, map);
          })(),
        );
      }
    }
    await Promise.all(calls);
  } catch (e) {
    for (const w of items) fail(w, e);
  } finally {
    // Ninguém que espera a mesma tradução fica sem resposta.
    for (const w of items) end(w, { status: 'failed', reason: 'unavailable' });
  }
}

export async function translateMessages(ctx: Ctx, rid: string, ids: unknown, requested?: unknown): Promise<TranslateResponse> {
  if (!translateOn()) throw disabled();
  const room = await loadRoomForUser(ctx, rid);
  if (!(await hasPermission(ctx.userId, 'auto-translate'))) throw notAllowed();
  if (room.encrypted) throw badRequest('error-translate-encrypted', TRANSLATE_TEXT.encrypted);
  const raw = Array.isArray(ids) ? ids : [];
  const list = [...new Set(raw.filter((x): x is string => typeof x === 'string' && !!x && x.length <= 64))];
  if (!list.length || list.length > TRANSLATE_MAX_IDS || raw.length > TRANSLATE_MAX_IDS * 2) throw badRequest('error-invalid-params', TRANSLATE_TEXT.ids);

  // Destino: o pedido, a sala, a pessoa ou a empresa.
  let wanted = requested;
  if (wanted === undefined || wanted === null || wanted === '') {
    const [sub, user] = await Promise.all([getSubscriptionRow(rid, ctx.userId), one('SELECT preferences FROM users WHERE id = $1', [ctx.userId])]);
    wanted = targetFor({ sub: sub ? { autoTranslateLanguage: sub.auto_translate_language } : null, prefs: user?.preferences, siteLanguage: getSetting<string>('Language') });
  }
  if (typeof wanted !== 'string' || !LANG_RE.test(wanted.trim())) throw badLanguage();
  const c = connOrNull();
  const langs = await serverLanguages(c);
  let target: string;
  if ('list' in langs) {
    const picked = pickLanguage(wanted, langs.list.map((l) => l.code));
    if (!picked) throw badLanguage();
    target = picked;
  } else target = normalizeLang(wanted);

  const rows = await many<Row>(
    `SELECT m.id, m.msg, m.t, m.extra, to_jsonb(m) -> 'e2e' AS e2e,
            encode(sha256(convert_to(m.msg, 'UTF8')), 'base64') AS h,
            l.language AS det, l.confidence AS conf, l.source_hash AS det_h,
            tr.text AS tr_text, tr.source_hash AS tr_h, tr.source_language AS tr_src
       FROM messages m
       LEFT JOIN message_languages l ON l.message_id = m.id
       LEFT JOIN message_translations tr ON tr.message_id = m.id AND tr.language = $3
      WHERE m.id = ANY($1) AND m.room_id = $2`,
    [list, rid, target],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results = new Map<string, MessageTranslation>();
  const done = (id: string, r: Result) => results.set(id, { _id: id, language: target, ...r });
  const order: string[] = [];
  const pending: { row: Row; det: string | null }[] = [];

  for (const id of list) {
    const row = byId.get(id);
    // Ids de outra sala ficam fora da resposta (nenhum texto de outra sala vaza), como o que nunca é traduzido.
    if (!row || !translatableMessage(room, { ...(row.extra ?? {}), t: row.t, msg: row.msg, e2e: row.e2e ?? row.extra?.e2e })) continue;
    order.push(id);
    if (row.tr_h === row.h && row.tr_text != null) {
      done(id, { status: 'translated', source: row.tr_src ?? undefined, text: row.tr_text });
      continue;
    }
    let det: string | null = null;
    if (row.det_h === row.h && row.det) {
      if (row.det === 'und' || Number(row.conf ?? 0) < DETECT_MIN_CONFIDENCE) {
        done(id, { status: 'unknown' });
        continue;
      }
      if (sameLanguage(row.det, target)) {
        done(id, { status: 'same', source: row.det });
        continue;
      }
      det = row.det;
    }
    pending.push({ row, det });
  }

  // Quem precisa do LibreTranslate. Servidor fora, disjuntor aberto e balde vazio vêm antes de cortar a mensagem em
  // trechos: o que não vai ao tradutor agora não custa nada (pedidos repetidos com 50 mensagens longas não seguram o
  // servidor). O que outro leitor já está pedindo agora espera a mesma chamada (sem gastar balde).
  let retryAfterMs = 0;
  const own: Work[] = [];
  const joined: Promise<unknown>[] = [];
  if (pending.length && !('list' in langs)) {
    for (const p of pending) done(p.row.id, { status: 'failed', reason: langs.error });
  } else if (pending.length && breakerOpen()) {
    for (const p of pending) done(p.row.id, { status: 'failed', reason: 'unavailable' });
  } else if (pending.length) {
    const bucket = bucketOf(ctx.userId);
    let limited = 0;
    for (const p of pending) {
      const key = `${p.row.id}|${target}|${p.row.h}`;
      const other = inflight.get(key);
      if (other) {
        joined.push(other.then((r) => results.set(p.row.id, r)));
        continue;
      }
      // Sem balde, nem corta: volta depois (a web tenta de novo sozinha).
      if (limited) {
        limited++;
        done(p.row.id, { status: 'failed', reason: 'rate' });
        continue;
      }
      const pieces = splitForTranslation(p.row.msg);
      if (!pieces) {
        done(p.row.id, { status: 'failed', reason: 'too-long' });
        continue;
      }
      if (!p.det && letterCount(pieces) < MIN_LETTERS) {
        // Só emoji, menção, link ou código: nem vale perguntar ao LibreTranslate.
        await saveDetection(p.row.id, p.row.h, 'und', 0);
        done(p.row.id, { status: 'unknown' });
        continue;
      }
      if (!bucket.take()) {
        limited++;
        done(p.row.id, { status: 'failed', reason: 'rate' });
        continue;
      }
      let resolve!: (r: MessageTranslation) => void;
      const promise = new Promise<MessageTranslation>((r) => (resolve = r));
      inflight.set(key, promise);
      void promise.then(() => inflight.get(key) === promise && inflight.delete(key));
      own.push({ row: p.row, pieces, det: p.det, resolve });
    }
    if (limited) retryAfterMs = bucket.wait(limited);
  }

  if (own.length || joined.length) {
    const hints: number[] = [];
    const finish = (w: Work, r: Result) => {
      const full: MessageTranslation = { _id: w.row.id, language: target, ...r };
      results.set(w.row.id, full);
      w.resolve(full);
    };
    const work = own.length && 'list' in langs && c ? runWork(own, target, langs.list, c, finish, hints) : Promise.resolve();
    // Prazo do pedido: 2 × o tempo limite. O que não terminou sai failed/timeout (e continua, para o próximo pedido).
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((r) => (timer = setTimeout(r, 2 * timeoutMs())));
    await Promise.race([Promise.all([work, ...joined]), deadline]);
    clearTimeout(timer);
    if (hints.length) retryAfterMs = Math.max(retryAfterMs, ...hints);
  }

  const translations: MessageTranslation[] = order.map((id) => results.get(id) ?? { _id: id, language: target, status: 'failed', reason: 'timeout' });
  const reasons = new Set(translations.filter((t) => t.status === 'failed').map((t) => t.reason));
  const worst = SEVERITY.find((r) => reasons.has(r));
  return {
    language: target,
    translations,
    ...(worst ? { notice: NOTICE[worst] } : {}),
    ...(retryAfterMs && (reasons.has('rate') || reasons.has('busy')) ? { retryAfterMs } : {}),
  };
}

// ---------- Preferência da sala (formato do Rocket.Chat) ----------

// Idioma escolhido para a sala: o código como está no servidor de tradução (sem a lista, o código normalizado).
async function roomLanguage(v: unknown): Promise<string> {
  if (typeof v !== 'string' || !LANG_RE.test(v.trim())) throw badLanguage();
  const langs = await serverLanguages(connOrNull());
  if (!('list' in langs)) return normalizeLang(v);
  const picked = pickLanguage(v, langs.list.map((l) => l.code));
  if (!picked) throw badLanguage();
  return picked;
}

export async function saveRoomTranslate(ctx: Ctx, rid: string, field: unknown, value: unknown, defaultLanguage?: unknown): Promise<void> {
  await assertCanTranslate(ctx);
  const sub = await getSubscriptionRow(rid, ctx.userId);
  if (!sub) throw badRequest('error-user-not-in-room', TRANSLATE_TEXT.notInRoom);
  if (field !== 'autoTranslate' && field !== 'autoTranslateLanguage') {
    throw badRequest('error-invalid-params', 'O parâmetro "field" deve ser autoTranslate ou autoTranslateLanguage.');
  }
  const sets: string[] = [];
  const params: unknown[] = [sub.id];
  if (field === 'autoTranslate') {
    const on = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
    if (on === null) throw badRequest('error-invalid-params', 'O parâmetro "value" deve ser verdadeiro ou falso.');
    if (on && (await one('SELECT 1 FROM rooms WHERE id = $1 AND encrypted', [rid]))) throw badRequest('error-translate-encrypted', TRANSLATE_TEXT.encrypted);
    sets.push(`auto_translate = $${params.push(on)}`);
    // Compatível com o Rocket.Chat: o idioma vem junto ao ligar, se a sala ainda não tem um (a web nunca manda).
    if (on && !sub.auto_translate_language && typeof defaultLanguage === 'string' && LANG_RE.test(defaultLanguage.trim())) {
      sets.push(`auto_translate_language = $${params.push(await roomLanguage(defaultLanguage))}`);
    }
  } else {
    // Vazio: segue o idioma da pessoa.
    const lang = value === '' || value === null || value === undefined ? null : await roomLanguage(value);
    sets.push(`auto_translate_language = $${params.push(lang)}`);
  }
  const row = await one(`UPDATE subscriptions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  await notifySubscription(ctx.userId, rid, 'updated', row);
}

// ---------- Teste de conexão (Administração › Configurações › Tradução automática) ----------

// Ignora o disjuntor; sucesso o fecha. Os erros saem como LibreError (a rota põe "Falha na conexão: " na frente).
export async function testConnection(o: { url?: string; apiKey?: string }): Promise<{ message: string; languages: number; warnings: string[] }> {
  const c = await libreConfigForTest({ url: o.url, apiKey: o.apiKey });
  const langs = await libreLanguages(c, { fresh: true });
  if (!langs.length) throw new LibreError('unsupported', 'O LibreTranslate não tem nenhum idioma instalado.');
  const codes = langs.map((l) => l.code);
  const targetsOf = (code: string) => langs.find((l) => l.code === code)?.targets ?? [];
  // Destino de from na lista dele (sem lista de destinos, qualquer outro instalado).
  const toFrom = (from: string, want?: string | null) => {
    const ts = targetsOf(from).filter((x) => x !== from);
    if (want) return ts.length ? pickLanguage(want, ts) : want;
    return ts[0] ?? codes.find((x) => x !== from) ?? null;
  };
  const pt = pickLanguage('pt', codes);
  const en = pickLanguage('en', codes);
  let sample: { text: string; from: string; to: string } | null = null;
  if (pt && en && toFrom(pt, en)) sample = { text: 'Bom dia', from: pt, to: toFrom(pt, en)! };
  else if (en && toFrom(en)) sample = { text: 'Good morning', from: en, to: toFrom(en)! };
  else {
    const from = langs.find((l) => toFrom(l.code));
    if (from) sample = { text: 'Good morning', from: from.code, to: toFrom(from.code)! };
  }
  if (!sample) throw new LibreError('unsupported', 'O LibreTranslate precisa de pelo menos dois idiomas instalados.');
  const [out] = await libreTranslate([sample.text], sample.from, sample.to, c);
  const warnings: string[] = [];
  const fe = await libreFrontendSettings(c);
  const max = Number(getSetting<number>('Message_MaxAllowedSize')) || 0;
  if (fe?.charLimit && fe.charLimit > 0 && fe.charLimit < max) {
    warnings.push(`O LibreTranslate aceita no máximo ${fe.charLimit} caracteres por trecho; trechos maiores não são traduzidos.`);
  }
  if (!pt) warnings.push('O servidor não tem o português instalado. Instale o pacote pt no LibreTranslate.');
  const site = String(getSetting<string>('Language') || 'pt-BR');
  if (!pickLanguage(site, codes)) warnings.push(`O idioma padrão da empresa (${site}) não está instalado no servidor de tradução.`);
  breakerUntil = 0;
  return { message: `Conexão bem-sucedida: ${langs.length} idiomas. Teste: “${sample.text}” → “${out}”.`, languages: langs.length, warnings };
}
