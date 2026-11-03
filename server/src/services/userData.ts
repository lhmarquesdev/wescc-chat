// "Baixar meus dados" (LGPD): a pessoa pede, o agendador monta um .zip em segundo plano (UPLOAD_DIR/exports), avisa
// (tempo real, push e e-mail) e o arquivo fica disponível por UserData_Download_Expiration_Hours. Um pedido a cada 24 h
// (o que falhou não conta) e um por vez. Só entra o que a própria pessoa escreveu ou é dela: mensagens de outras
// pessoas nunca aparecem, nem nas DMs.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UserDataRequest } from '@shared/index';
import { ENCRYPTED_PLACEHOLDER, EXPORT_MAX_FILES, exportSlug, isEncryptedMessage, nextDataRequestAt, safeZipName } from '@shared/dataExport';
import { formatBytes } from '@shared/messageText';
import { messagePreviewText } from '@shared/stickers';
import { config } from '../config';
import { many, one, query } from '../db/pool';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { zipStore, type ZipEntry } from '../lib/zip';
import { bus } from '../realtime/bus';
import { audit } from './audit';
import { dayKey, encryptedSql, escapeHtml, EXPORT_TZ, formatDayTime, formatLong, htmlEnd, htmlStart, plural, roomKindLabel, roomLabel } from './exportRender';
import { getSetting } from './settings';
import { siteUrl } from './sso';
import { actorOf, type Ctx } from './users';

export const EXPORTS_DIR = 'exports';
const exportsDir = () => path.join(config.uploadDir, EXPORTS_DIR);

const STALE_ERROR = 'O servidor reiniciou durante a preparação.';
const BUILD_ERROR = 'Não foi possível gerar o arquivo.';
const MAX_ATTEMPTS = 3;

export const userDataEnabled = () => !!getSetting<boolean>('UserData_EnableDownload');
const expirationHours = () => Math.max(1, getSetting<number>('UserData_Download_Expiration_Hours') || 72);
const disabled = () => forbidden('O download dos dados está desativado pelo administrador.');

export function mapDataRequest(r: any): UserDataRequest {
  return {
    _id: r.id,
    status: r.status,
    requestedAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    expiresAt: r.expires_at ?? null,
    size: r.size ?? null,
    error: r.error ?? null,
  };
}

const publish = (r: any) => bus.publish({ user: r.user_id }, { type: 'userdata.changed', request: mapDataRequest(r) });

const shortWhen = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, day: '2-digit', month: '2-digit' });
const shortTime = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, hour: '2-digit', minute: '2-digit' });

async function nextAllowed(userId: string) {
  const last = await many(`SELECT status, created_at FROM data_exports WHERE kind = 'user' AND user_id = $1 AND status <> 'failed' ORDER BY created_at DESC LIMIT 1`, [userId]);
  return nextDataRequestAt(last.map((r) => ({ status: r.status, requestedAt: r.created_at })));
}

// ---------- Rotas ----------

export async function requestDataDownload(ctx: Ctx): Promise<UserDataRequest> {
  if (!userDataEnabled()) throw disabled();
  const next = await nextAllowed(ctx.userId);
  if (next) {
    const d = new Date(next);
    throw new ApiError(
      429,
      'error-data-download-rate-limit',
      `Você já pediu seus dados nas últimas 24 horas. Peça de novo a partir de ${shortWhen.format(d)} às ${shortTime.format(d)}.`,
      { nextAllowedAt: next },
    );
  }
  let row: any;
  try {
    row = await one(`INSERT INTO data_exports (id, kind, user_id, status) VALUES ($1, 'user', $2, 'pending') RETURNING *`, [newId(), ctx.userId]);
  } catch (e) {
    // data_exports_user_active_uq: já há um pedido na fila ou em preparação.
    if ((e as { code?: string })?.code === '23505') throw new ApiError(409, 'error-data-download-pending', 'Seus dados já estão sendo preparados.');
    throw e;
  }
  await audit(actorOf(ctx), 'user.data.requested', { userId: ctx.userId }, { requestId: row.id });
  publish(row);
  return mapDataRequest(row);
}

export async function listDataDownloads(ctx: Ctx) {
  const hours = expirationHours();
  if (!userDataEnabled()) return { enabled: false, expirationHours: hours, nextAllowedAt: null, requests: [] as UserDataRequest[] };
  const rows = await many(`SELECT * FROM data_exports WHERE kind = 'user' AND user_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.userId]);
  return { enabled: true, expirationHours: hours, nextAllowedAt: await nextAllowed(ctx.userId), requests: rows.map(mapDataRequest) };
}

// O .zip pronto, só para a própria pessoa e dentro do prazo. Dá para baixar de novo até expirar.
export async function openDataDownload(ctx: Ctx, id: string) {
  if (!userDataEnabled()) throw disabled();
  const row = id && id.length <= 64 ? await one(`SELECT * FROM data_exports WHERE id = $1 AND kind = 'user' AND user_id = $2`, [id, ctx.userId]) : null;
  if (!row) throw notFound('error-not-found', 'Pedido não encontrado.');
  const gone = () => new ApiError(410, 'error-data-download-expired', 'Este arquivo expirou. Peça seus dados de novo.');
  if (row.status !== 'ready' || !row.file_path || new Date(row.expires_at).getTime() <= Date.now()) throw gone();
  const abs = path.join(config.uploadDir, row.file_path);
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st?.isFile()) throw gone();
  await audit(actorOf(ctx), 'user.data.downloaded', { userId: ctx.userId, requestId: row.id }, { size: st.size });
  return { fileName: `meus-dados_${exportSlug(ctx.username, 'conta')}_${dayKey(new Date())}.zip`, size: st.size, stream: fs.createReadStream(abs) };
}

// ---------- Tarefa (agendador, a cada 15 s, trava 727150) ----------

export async function runDataExportJobs(log: (m: string) => void = () => {}): Promise<{ done: number; failed: number; expired: number }> {
  const out = { done: 0, failed: 0, expired: 0 };
  // 1. Só quem tem a trava roda pedidos: um "running" aqui é de uma execução que parou no meio (reinício). Volta para a
  //    fila, ou falha de vez depois de 3 tentativas.
  const stale = await many(
    `UPDATE data_exports SET
        status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
        error = CASE WHEN attempts >= $1 THEN $2 END,
        finished_at = CASE WHEN attempts >= $1 THEN now() END
      WHERE kind = 'user' AND status = 'running' RETURNING *`,
    [MAX_ATTEMPTS, STALE_ERROR],
  );
  for (const r of stale) {
    if (r.status === 'failed') out.failed++;
    publish(r);
  }
  // 2 e 3. Um pedido de cada vez, enquanto houver (com a função desligada, os pedidos esperam na fila).
  while (userDataEnabled()) {
    const row = await one(
      `UPDATE data_exports SET status = 'running', started_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM data_exports WHERE kind = 'user' AND status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
    );
    if (!row) break;
    publish(row);
    if (await buildRequest(row, log)) out.done++;
    else out.failed++;
  }
  // 4. Vencidos: o arquivo sai do disco.
  const expired = await many(`UPDATE data_exports SET status = 'expired' WHERE kind = 'user' AND status = 'ready' AND expires_at < now() RETURNING *`);
  for (const r of expired) {
    if (r.file_path) await fs.promises.rm(path.join(config.uploadDir, r.file_path), { force: true }).catch(() => {});
    publish(r);
    out.expired++;
  }
  // 5. Linhas antigas: os tíquetes das conversas depois de 1 dia; os pedidos depois de 30 (até lá mostram "expirou" e
  //    seguram a regra das 24 h).
  await query(`DELETE FROM data_exports WHERE kind = 'room' AND created_at < now() - interval '1 day'`);
  await query(`DELETE FROM data_exports WHERE kind = 'user' AND status IN ('failed', 'expired') AND created_at < now() - interval '30 days'`);
  // 6. Arquivos sem pedido (conta excluída, queda no meio): fora depois de 1 hora.
  await sweepOrphans();
  return out;
}

async function sweepOrphans() {
  const names = await fs.promises.readdir(exportsDir()).catch(() => [] as string[]);
  const candidates: { file: string; id: string }[] = [];
  for (const name of names) {
    const m = /^([A-Za-z0-9]+)\.zip(\.part)?$/.exec(name);
    if (!m) continue;
    const st = await fs.promises.stat(path.join(exportsDir(), name)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600_000) candidates.push({ file: name, id: m[1] });
  }
  if (!candidates.length) return;
  const alive = new Set(
    (await many(`SELECT id FROM data_exports WHERE id = ANY($1) AND kind = 'user' AND status IN ('ready', 'running')`, [candidates.map((c) => c.id)])).map((r) => r.id),
  );
  for (const c of candidates) if (!alive.has(c.id)) await fs.promises.rm(path.join(exportsDir(), c.file), { force: true }).catch(() => {});
}

async function buildRequest(row: any, log: (m: string) => void): Promise<boolean> {
  const fail = async (error: string) => {
    const r = await one(`UPDATE data_exports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running' RETURNING *`, [row.id, error]);
    if (r) publish(r);
    return false;
  };
  const user = await one('SELECT * FROM users WHERE id = $1', [row.user_id]);
  if (!user?.active) return fail('Conta desativada.');
  const rel = path.posix.join(EXPORTS_DIR, `${row.id}.zip`);
  const final = path.join(config.uploadDir, rel);
  const part = `${final}.part`;
  try {
    await fs.promises.mkdir(exportsDir(), { recursive: true });
    await pipeline(zipStore(userZipEntries(user)), fs.createWriteStream(part));
    await fs.promises.rename(part, final);
  } catch (e) {
    log(`meus dados: não foi possível gerar o arquivo de ${user.username}: ${(e as Error).message}`);
    await fs.promises.rm(part, { force: true }).catch(() => {});
    await fs.promises.rm(final, { force: true }).catch(() => {});
    return fail(BUILD_ERROR);
  }
  const { size } = await fs.promises.stat(final);
  const ready = await one(
    `UPDATE data_exports SET status = 'ready', file_path = $2, size = $3, finished_at = now(), expires_at = now() + make_interval(hours => $4)
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [row.id, rel, size, expirationHours()],
  );
  // A conta foi excluída durante a preparação (a linha saiu junto): o arquivo não fica.
  if (!ready) {
    await fs.promises.rm(final, { force: true }).catch(() => {});
    return false;
  }
  publish(ready);
  await notifyReady(user, ready);
  return true;
}

async function notifyReady(user: any, r: any) {
  const until = formatDayTime(r.expires_at);
  const { sendPush } = await import('./push');
  void sendPush([user.id], { title: 'Seus dados estão prontos', body: `Baixe em Minha conta › Meus dados até ${until}.`, url: '/account/data', tag: `userdata-${r.id}` }).catch(() => {});
  if (!user.email) return;
  const { sendMail } = await import('./mailer');
  const site = getSetting<string>('Site_Name');
  const name = user.name || user.username;
  const link = `${siteUrl()}/account/data`;
  const text = `Olá, ${name}.\n\nA cópia dos seus dados no ${site} está pronta. Para baixar, entre no chat e abra Minha conta › Meus dados até ${until}:\n\n${link}\n\nSe não foi você quem pediu, avise o administrador.`;
  const html =
    `<p>Olá, ${escapeHtml(name)}.</p><p>A cópia dos seus dados no ${escapeHtml(site)} está pronta. Para baixar, entre no chat e abra Minha conta › Meus dados até ${escapeHtml(until)}.</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1d74f5;color:#fff;border-radius:6px;text-decoration:none">Abrir Meus dados</a></p>` +
    `<p style="color:#6c727a">Se não foi você quem pediu, avise o administrador.</p>`;
  await sendMail({ to: user.email, subject: `[${site}] Seus dados estão prontos`, text, html }).catch(() => false);
}

// ---------- Conteúdo do .zip ----------

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2), 'utf8');

// Nome, tipo e id de cada sala, uma consulta por sala nova durante a tarefa.
function roomCache(userId: string) {
  const cache = new Map<string, { id: string; nome: string; tipo: string }>();
  return async (ids: (string | null | undefined)[]) => {
    const want = [...new Set(ids.filter((id): id is string => !!id && !cache.has(id)))];
    if (want.length) {
      for (const r of await many('SELECT * FROM rooms WHERE id = ANY($1)', [want])) cache.set(r.id, { id: r.id, nome: await roomLabel(r, userId), tipo: roomKindLabel(r) });
    }
    return (id: string | null | undefined) => (id ? (cache.get(id) ?? { id, nome: 'Sala excluída', tipo: '' }) : null);
  };
}

interface FileItem {
  id: string;
  nome: string;
  tipo: string;
  tamanho: number;
  sala: string | null;
  enviadoEm: string;
  incluido: boolean;
  motivo?: 'limite' | 'indisponivel' | 'criptografado';
  caminho?: string;
  link: string;
}

async function* userZipEntries(user: any): AsyncGenerator<ZipEntry> {
  const rooms = roomCache(user.id);
  const now = new Date();

  // perfil.json
  const subs = await many(`SELECT s.roles AS sub_roles, s.created_at AS joined_at, r.* FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 ORDER BY s.created_at`, [user.id]);
  const salas: { id: string; nome: string; tipo: string; papeis: string[]; entrouEm: string }[] = [];
  for (const s of subs) salas.push({ id: s.id, nome: await roomLabel(s, user.id), tipo: roomKindLabel(s), papeis: s.sub_roles, entrouEm: s.joined_at });
  const sessoes = (await many('SELECT device, created_at, last_active_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at', [user.id])).map((s) => ({
    dispositivo: s.device?.name ?? '',
    ip: s.device?.ip ?? null,
    criadaEm: s.created_at,
    ultimoUso: s.last_active_at,
  }));
  const dispositivos = (await many('SELECT device, first_seen, last_seen, last_ip FROM user_devices WHERE user_id = $1 ORDER BY first_seen', [user.id])).map((d) => ({
    browser: d.device?.browser ?? '',
    os: d.device?.os ?? '',
    primeiroAcesso: d.first_seen,
    ultimoAcesso: d.last_seen,
    ultimoIp: d.last_ip,
  }));
  const tokens = (await many('SELECT name, created_at, last_used_at FROM personal_access_tokens WHERE user_id = $1 ORDER BY created_at', [user.id])).map((t) => ({
    nome: t.name,
    criadoEm: t.created_at,
    ultimoUso: t.last_used_at,
  }));
  // Nunca: hash da senha, chave do 2FA, códigos de backup, hashes de token ou de dispositivo.
  const perfil = {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    bio: user.bio,
    statusText: user.status_text,
    roles: user.roles,
    authSource: user.auth_source,
    criadoEm: user.created_at,
    ultimoLogin: user.last_login,
    preferencias: user.preferences ?? {},
    doisFatores: !!user.totp_enabled,
  };
  yield { name: 'perfil.json', data: json({ format: 'wescc-user-data', version: 1, geradoEm: now.toISOString(), perfil, salas, sessoes, dispositivos, tokens }), mtime: now };

  // agenda.json
  const owned = await many(`SELECT * FROM calendar_events WHERE owner_id = $1 ORDER BY starts_at, id`, [user.id]);
  const label = await rooms(owned.map((e) => e.room_id));
  const eventos = owned.map((e) => ({
    titulo: e.title,
    descricao: e.description,
    local: e.location,
    inicio: e.starts_at,
    fim: e.ends_at,
    diaInteiro: e.all_day,
    reuniao: e.is_meeting,
    acesso: e.is_meeting ? e.meeting_access : null,
    sala: label(e.room_id)?.nome ?? null,
    lembreteMinutos: e.reminder_minutes,
    status: e.status,
  }));
  const convites = (
    await many(
      `SELECT e.title, e.starts_at, e.ends_at, e.all_day, e.status, u.name AS owner_name, u.username AS owner_username, a.response
         FROM calendar_attendees a JOIN calendar_events e ON e.id = a.event_id LEFT JOIN users u ON u.id = e.owner_id
        WHERE a.user_id = $1 ORDER BY e.starts_at, e.id`,
      [user.id],
    )
  ).map((c) => ({ titulo: c.title, organizador: c.owner_name || c.owner_username || null, inicio: c.starts_at, fim: c.ends_at, diaInteiro: c.all_day, status: c.status, resposta: c.response }));
  yield { name: 'agenda.json', data: json({ eventos, convites }), mtime: now };

  // reacoes.json: as reações ficam guardadas pelo @usuário; uma passada pela chave primária (tarefa de fundo).
  const reactionCount = new Map<string, number>();
  async function* reactions() {
    yield '[';
    let cursor = '';
    let first = true;
    for (;;) {
      const rows = await many(
        `SELECT id, room_id, created_at, reactions FROM messages
          WHERE id > $1 AND reactions <> '{}'::jsonb
            AND jsonb_path_exists(reactions, '$.*.usernames[*] ? (@ == $u)', jsonb_build_object('u', $2::text))
          ORDER BY id LIMIT 2000`,
        [cursor, user.username],
      );
      if (!rows.length) break;
      const lab = await rooms(rows.map((r) => r.room_id));
      let chunk = '';
      for (const r of rows) {
        for (const [emoji, v] of Object.entries((r.reactions ?? {}) as Record<string, { usernames?: string[] }>)) {
          if (!v?.usernames?.includes(user.username)) continue;
          reactionCount.set(emoji, (reactionCount.get(emoji) ?? 0) + 1);
          chunk += `${first ? '\n' : ',\n'}${JSON.stringify({ mensagemId: r.id, sala: lab(r.room_id)?.nome ?? null, dataMensagem: r.created_at, emoji })}`;
          first = false;
        }
      }
      if (chunk) yield chunk;
      cursor = rows[rows.length - 1].id;
      if (rows.length < 2000) break;
    }
    yield '\n]\n';
  }
  yield { name: 'reacoes.json', stream: Readable.from(reactions()), mtime: now };

  // arquivos/<id>-<nome>: os enviados pela pessoa, dos mais antigos aos mais novos, até o limite. Cada um é aberto
  // antes de entrar no .zip; arquivo de mensagem cifrada não entra.
  const max = Math.max(1, getSetting<number>('DataExport_Max_Files_MB') || 2048) * 1024 * 1024;
  const enc = await encryptedSql('m');
  const items: FileItem[] = [];
  let total = 0;
  let included = 0;
  let full = false;
  let fts = '-infinity';
  let fid = '';
  for (;;) {
    const page = await many(
      `SELECT f.id, f.name, f.type, f.size, f.storage_path, f.room_id, f.created_at, f.created_at::text AS cursor_ts, (${enc}) AS encrypted
         FROM files f LEFT JOIN messages m ON m.id = f.message_id
        WHERE f.user_id = $1 AND f.created_at >= $2::timestamptz AND (f.created_at, f.id) > ($2::timestamptz, $3)
        ORDER BY f.created_at, f.id LIMIT 1000`,
      [user.id, fts, fid],
    );
    if (!page.length) break;
    const lab = await rooms(page.map((f) => f.room_id));
    for (const f of page) {
      const item: FileItem = {
        id: f.id,
        nome: f.name,
        tipo: f.type,
        tamanho: Number(f.size),
        sala: lab(f.room_id)?.nome ?? null,
        enviadoEm: f.created_at,
        incluido: false,
        link: `${siteUrl()}/file-upload/${f.id}/${encodeURIComponent(f.name)}`,
      };
      items.push(item);
      if (f.encrypted) {
        item.motivo = 'criptografado';
        continue;
      }
      if (full || total + item.tamanho > max || included >= EXPORT_MAX_FILES) {
        full = true;
        item.motivo = 'limite';
        continue;
      }
      const fh = await fs.promises.open(path.join(config.uploadDir, f.storage_path), 'r').catch(() => null);
      if (!fh) {
        item.motivo = 'indisponivel';
        continue;
      }
      item.incluido = true;
      item.caminho = `arquivos/${safeZipName(f.id, f.name)}`;
      total += item.tamanho;
      included++;
      yield { name: item.caminho, stream: fh.createReadStream(), mtime: new Date(f.created_at) };
    }
    fts = page[page.length - 1].cursor_ts;
    fid = page[page.length - 1].id;
    if (page.length < 1000) break;
  }
  yield { name: 'arquivos.json', data: json(items), mtime: now };

  // mensagens.json: só as que a pessoa escreveu (sem as de sistema), em ordem; as cifradas saem sem o texto.
  async function* myMessages(): AsyncGenerator<any[]> {
    let ts = '-infinity';
    let id = '';
    for (;;) {
      const rows = await many(
        `SELECT m.*, m.created_at::text AS cursor_ts FROM messages m
          WHERE m.user_id = $1 AND m.t IS NULL AND m.created_at >= $2::timestamptz AND (m.created_at, m.id) > ($2::timestamptz, $3)
          ORDER BY m.created_at, m.id LIMIT 1000`,
        [user.id, ts, id],
      );
      if (!rows.length) return;
      yield rows;
      ts = rows[rows.length - 1].cursor_ts;
      id = rows[rows.length - 1].id;
      if (rows.length < 1000) return;
    }
  }
  const textOf = (m: any) => (isEncryptedMessage(m) ? null : messagePreviewText({ msg: m.msg, sticker: m.extra?.sticker, files: m.files }, { withName: false }));
  let messageCount = 0;
  async function* messagesJson() {
    yield '[';
    let first = true;
    for await (const rows of myMessages()) {
      const lab = await rooms(rows.map((r) => r.room_id));
      let chunk = '';
      for (const m of rows) {
        const encrypted = isEncryptedMessage(m);
        const item = {
          id: m.id,
          sala: lab(m.room_id),
          data: m.created_at,
          texto: textOf(m),
          topico: m.tmid ?? null,
          editadaEm: m.edited_at ?? null,
          arquivos: encrypted ? [] : ((m.files ?? []) as { _id: string }[]).map((f) => f._id),
          ...(encrypted ? { criptografada: true } : {}),
        };
        chunk += `${first ? '\n' : ',\n'}${JSON.stringify(item)}`;
        first = false;
        messageCount++;
      }
      yield chunk;
    }
    yield '\n]\n';
  }
  yield { name: 'mensagens.json', stream: Readable.from(messagesJson()), mtime: now };

  // meus-dados.html: a mesma coisa para ler no navegador (segunda passada pelas mensagens).
  async function* page() {
    const site = getSetting<string>('Site_Name');
    const name = user.name || user.username;
    const td = (v: unknown) => `<td>${escapeHtml(v ?? '')}</td>`;
    let h = htmlStart(`Meus dados · ${site}`);
    h += `<header><h1>Meus dados</h1><p class="meta">${escapeHtml(name)} (@${escapeHtml(user.username)}) · ${escapeHtml(site)}</p><p class="meta">Gerado em ${escapeHtml(formatLong(now))}</p></header>`;
    h += '<h3>Perfil</h3><dl>';
    const dl: [string, unknown][] = [
      ['Nome', perfil.name],
      ['Usuário', `@${perfil.username}`],
      ['E-mail', perfil.email || '—'],
      ['Sobre', perfil.bio || '—'],
      ['Status', perfil.statusText || '—'],
      ['Papéis', (perfil.roles ?? []).join(', ')],
      ['Conta criada em', formatDayTime(perfil.criadoEm)],
      ['Último login', perfil.ultimoLogin ? formatDayTime(perfil.ultimoLogin) : '—'],
      ['Autenticação em dois fatores', perfil.doisFatores ? 'Ativada' : 'Desativada'],
    ];
    for (const [k, v] of dl) h += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`;
    h += '</dl>';
    h += `<h3>Conversas (${salas.length.toLocaleString('pt-BR')})</h3>`;
    if (salas.length) {
      h += '<table><thead><tr><th>Conversa</th><th>Tipo</th><th>Entrou em</th></tr></thead><tbody>';
      for (const s of salas) h += `<tr>${td(s.nome)}${td(s.tipo)}${td(formatDayTime(s.entrouEm))}</tr>`;
      h += '</tbody></table>';
    } else h += '<p class="meta">Nenhuma.</p>';
    h += `<h3>Agenda</h3>`;
    if (eventos.length || convites.length) {
      h += '<table><thead><tr><th>Evento</th><th>Início</th><th>Situação</th></tr></thead><tbody>';
      for (const e of eventos) h += `<tr>${td(e.titulo)}${td(formatDayTime(e.inicio))}${td(e.status === 'canceled' ? 'Cancelado' : 'Seu evento')}</tr>`;
      const resp: Record<string, string> = { accepted: 'Convite aceito', declined: 'Convite recusado', tentative: 'Talvez', pending: 'Convite sem resposta' };
      for (const c of convites) h += `<tr>${td(c.titulo)}${td(formatDayTime(c.inicio))}${td(`${resp[c.resposta] ?? c.resposta} · ${c.organizador ?? ''}`)}</tr>`;
      h += '</tbody></table>';
    } else h += '<p class="meta">Nenhum evento.</p>';
    h += `<h3>Arquivos que você enviou (${items.length.toLocaleString('pt-BR')})</h3>`;
    yield h;
    if (items.length) {
      const why: Record<string, string> = { limite: 'fora do .zip: passou do limite', indisponivel: 'arquivo indisponível', criptografado: 'arquivo criptografado' };
      let t = '<table><thead><tr><th>Arquivo</th><th>Conversa</th><th>Enviado em</th></tr></thead><tbody>';
      for (const f of items) {
        const nameCell = f.incluido && f.caminho ? `<a href="${escapeHtml(f.caminho.split('/').map(encodeURIComponent).join('/'))}">${escapeHtml(f.nome)}</a>` : escapeHtml(f.nome);
        t += `<tr><td>${nameCell} <span class="meta">(${escapeHtml(formatBytes(f.tamanho))}${f.motivo ? ` · ${escapeHtml(why[f.motivo])}` : ''})</span></td>${td(f.sala ?? '—')}${td(formatDayTime(f.enviadoEm))}</tr>`;
      }
      yield `${t}</tbody></table>`;
    } else yield '<p class="meta">Nenhum.</p>';
    const reacts = [...reactionCount].sort((a, b) => b[1] - a[1]);
    let r = `<h3>Reações (${reacts.reduce((n, [, c]) => n + c, 0).toLocaleString('pt-BR')})</h3>`;
    r += reacts.length ? `<div class="reactions">${reacts.map(([e, c]) => `<span>${escapeHtml(e)} ${c.toLocaleString('pt-BR')}</span>`).join('')}</div>` : '<p class="meta">Nenhuma.</p>';
    r += `<h3>Mensagens que você escreveu (${messageCount.toLocaleString('pt-BR')})</h3>`;
    yield r;
    if (messageCount) {
      yield '<table><thead><tr><th>Data</th><th>Conversa</th><th>Mensagem</th></tr></thead><tbody>';
      for await (const rows of myMessages()) {
        const lab = await rooms(rows.map((m) => m.room_id));
        let chunk = '';
        for (const m of rows) {
          const text = textOf(m);
          const cell = text === null ? `<td><i>${escapeHtml(ENCRYPTED_PLACEHOLDER)}</i></td>` : `<td>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</td>`;
          chunk += `<tr>${td(formatDayTime(m.created_at))}${td(lab(m.room_id)?.nome ?? '')}${cell}</tr>`;
        }
        yield chunk;
      }
      yield '</tbody></table>';
    } else yield '<p class="meta">Nenhuma.</p>';
    yield htmlEnd(`${escapeHtml(plural(messageCount, 'mensagem', 'mensagens'))}, ${escapeHtml(plural(included, 'arquivo incluído', 'arquivos incluídos'))}. Para corrigir ou excluir dados, fale com o administrador do ${escapeHtml(site)}.`);
  }
  yield { name: 'meus-dados.html', stream: Readable.from(page()), mtime: now };
}
