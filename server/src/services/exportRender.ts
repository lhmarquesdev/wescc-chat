// Peças comuns de "Exportar mensagens" e "Baixar meus dados": página HTML, modelo de mensagem exportada, CSV, JSON,
// datas no fuso do servidor, nome da conversa e o cabeçalho de download.
import type { Attachment } from '@shared/index';
import { csvRow, ENCRYPTED_PLACEHOLDER, isEncryptedMessage } from '@shared/dataExport';
import { emojiText } from '@shared/emoji';
import { formatBytes, systemText } from '@shared/messageText';
import { messagePreviewText } from '@shared/stickers';
import { many } from '../db/pool';
import { truncate } from '../lib/text';
import { siteUrl } from './sso';

// ---------- Datas (fuso do servidor, como os lembretes da Agenda) ----------

export const EXPORT_TZ = process.env.TZ || 'America/Sao_Paulo';
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: EXPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, dateStyle: 'short', timeStyle: 'short' });
const csvDateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, dateStyle: 'short', timeStyle: 'medium' });
const headingFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: EXPORT_TZ, dateStyle: 'long', timeStyle: 'short' });

// 2026-10-31 (nomes de arquivo e troca de dia no HTML).
export const dayKey = (iso: string | Date) => dayKeyFmt.format(new Date(iso));
// 31/10/2026
export const formatDay = (iso: string | Date) => dateFmt.format(new Date(iso));
// 31/10/2026 15:32 (sem a vírgula que o Intl põe entre a data e a hora)
export const formatDayTime = (iso: string | Date) => dateTimeFmt.format(new Date(iso)).replace(', ', ' ');
// 31 de outubro de 2026 às 15:32
export const formatLong = (iso: string | Date) => longFmt.format(new Date(iso));
const formatCsvDate = (iso: string | Date) => csvDateFmt.format(new Date(iso)).replace(', ', ' ');

// ---------- HTML ----------

export const escapeHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const htmlText = (v: string) => escapeHtml(v).replace(/\r?\n/g, '<br>');

// Página sem scripts, legível no navegador e no celular, clara ou escura conforme o sistema.
const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1e26;--muted:#646c7b;--line:#e3e6eb;--soft:#f4f6f9;--accent:#1d74f5;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#15181d;--fg:#e6e8eb;--muted:#8e97a6;--line:#2b3038;--soft:#1d2128;--accent:#7cb0ff;--warn:#e0a54a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
header{border-bottom:1px solid var(--line);padding-bottom:16px}
h1{font-size:24px;line-height:1.25;margin:0 0 6px}
.meta{color:var(--muted);margin:2px 0;font-size:14px}
h2{font-size:14px;font-weight:600;color:var(--muted);margin:28px 0 6px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2::first-letter{text-transform:uppercase}
h3{font-size:16px;margin:24px 0 8px}
article{display:grid;grid-template-columns:48px 1fr;gap:0 12px;padding:6px 0;scroll-margin-top:16px}
article:target{background:var(--soft);border-radius:8px}
.time{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;padding-top:2px}
.who b{font-weight:600}
.who .u,.who .gone{color:var(--muted);font-size:13px;margin-left:6px}
.text{overflow-wrap:anywhere}
.sys .text,.enc .text,.rm .text{font-style:italic;color:var(--muted)}
.reply{font-size:13px;color:var(--muted);text-decoration:none}
.reply:hover{text-decoration:underline}
blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid var(--line);color:var(--muted)}
ul.files{margin:4px 0;padding-left:20px}
.flag{color:var(--warn)}
.tags{font-size:13px;color:var(--muted)}
.reactions span{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;margin:4px 4px 0 0;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
a{color:var(--accent)}
footer{margin-top:32px;border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:14px}
@media (max-width:520px){article{grid-template-columns:1fr}.time{padding:0}dl{grid-template-columns:1fr}dt{margin-top:6px}}
`.trim();

export function htmlStart(title: string) {
  return (
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>`
  );
}
export const htmlEnd = (footer: string) => `<footer>${footer}</footer></main></body></html>`;

// "1 mensagem", "2.300 mensagens"
export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

// ---------- Download ----------

// RFC 8187: encodeURIComponent deixa ' ( ) * ! passarem, e um apóstrofo a mais faz o Chrome ignorar o filename*.
const extValue = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function contentDisposition(fileName: string) {
  const ascii = fileName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${extValue(fileName)}`;
}

// ---------- Salas ----------

const andList = new Intl.ListFormat('pt-BR', { type: 'conjunction' });

// Nome da conversa como quem exporta vê: o nome do canal ou grupo; numa DM, "Conversa com" as outras pessoas (só a
// própria pessoa: o nome dela).
export async function roomLabel(room: { t: string; name?: string | null; fname?: string | null; uids?: string[] }, viewerId: string): Promise<string> {
  if (room.t !== 'd') return room.fname || room.name || 'conversa';
  const others = (room.uids ?? []).filter((u) => u !== viewerId);
  const users = await many('SELECT username, name FROM users WHERE id = ANY($1) ORDER BY username', [others.length ? others : [viewerId]]);
  const names = andList.format(users.map((u) => u.name || u.username));
  return others.length ? `Conversa com ${names || 'pessoa excluída'}` : names || 'Conversa';
}

export function roomKindLabel(room: { t: string; prid?: string | null; team_main?: boolean; notice?: boolean }) {
  if (room.prid) return 'Discussão';
  if (room.t === 'd') return 'Conversa direta';
  if (room.team_main) return room.t === 'p' ? 'Time privado' : 'Time';
  if (room.notice) return 'Canal de avisos';
  return room.t === 'p' ? 'Grupo privado' : 'Canal público';
}

// ---------- Criptografia ponta a ponta no SQL ----------

// O mesmo teste de isEncryptedMessage (shared/dataExport.ts), para as contagens e listas de arquivos feitas no banco.
export function encryptedSql(alias = 'm'): string {
  return `${alias}.e2e IS NOT NULL`;
}

// ---------- Nomes das pessoas citadas em mensagens de sistema e nas reações ----------

const NAMED_SYSTEM = new Set(['au', 'ru', 'user-muted', 'user-unmuted', 'subscription-role-added', 'subscription-role-removed']);

export function nameResolver() {
  const cache = new Map<string, string>();
  return {
    // Uma consulta por página de mensagens, só com os @usuários ainda desconhecidos. reactions: também quem reagiu
    // (o HTML mostra os nomes ao passar o mouse na reação).
    async prime(rows: { t?: string | null; msg?: string | null; reactions?: Record<string, { usernames?: string[] }> | null }[], reactions = false) {
      const all = new Set<string>();
      for (const r of rows) {
        if (r.t && NAMED_SYSTEM.has(r.t) && r.msg) all.add(r.msg);
        if (reactions) for (const v of Object.values(r.reactions ?? {})) for (const u of v?.usernames ?? []) all.add(u);
      }
      const want = [...all].filter((u) => !cache.has(u));
      if (!want.length) return;
      for (const u of await many('SELECT username, name FROM users WHERE username = ANY($1)', [want])) cache.set(u.username, u.name || u.username);
      for (const w of want) if (!cache.has(w)) cache.set(w, w);
    },
    nameOf: (username: string) => cache.get(username) ?? username,
  };
}

// ---------- Mensagem exportada ----------

export type ExportKind = 'message' | 'system' | 'encrypted' | 'removed';

export interface ExportFile {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string | null; // caminho dentro do .zip (arquivos/<id>-<nome>), quando o arquivo foi incluído
  url: string; // endereço no chat (precisa estar logado)
  encrypted: boolean;
  missing: boolean; // devia estar no .zip e não estava no disco
}

export interface ExportMessage {
  id: string;
  ts: string;
  author: { id: string | null; username: string; name: string; deleted: boolean };
  kind: ExportKind;
  t: string | null;
  msg: string | null;
  text: string;
  fileOnly: boolean; // só arquivos, sem texto: o HTML mostra só a lista
  tmid: string | null;
  editedAt: string | null;
  pinned: boolean;
  files: ExportFile[];
  reactions: Record<string, string[]>;
  attachments: Attachment[];
  ackRequired: boolean;
  ackCount: number;
}

export interface FilePlacement {
  // Só no .zip: o caminho de cada arquivo incluído. Sem isso, cada arquivo leva o link do chat.
  zipped?: Map<string, string>;
}

// m: a linha já com extra (withExtra), para call, sticker e role chegarem a systemText (papéis pelo nome de ROLE_LABEL;
// um papel criado pelo administrador sai pelo id).
export function toExportMessage(m: any, nameOf: (u: string) => string, place: FilePlacement = {}): ExportMessage {
  const encrypted = isEncryptedMessage(m);
  const rawFiles = (Array.isArray(m.files) ? m.files : []) as { _id: string; name: string; type?: string; size?: number; voice?: boolean; duration?: number }[];
  const files: ExportFile[] = rawFiles.map((f) => {
    const zipped = place.zipped?.get(f._id) ?? null;
    return {
      id: f._id,
      name: f.name,
      type: f.type ?? '',
      size: Number(f.size ?? 0),
      path: encrypted ? null : zipped,
      url: `${siteUrl()}/file-upload/${f._id}/${encodeURIComponent(f.name)}`,
      encrypted,
      missing: !encrypted && !!place.zipped && !zipped,
    };
  });
  let kind: ExportKind = 'message';
  let text: string;
  if (encrypted) {
    kind = 'encrypted';
    text = ENCRYPTED_PLACEHOLDER;
  } else if (m.t === 'rm') {
    kind = 'removed';
    text = 'Mensagem removida';
  } else if (m.t) {
    kind = 'system';
    text = systemText(m, nameOf);
  } else {
    text = messagePreviewText({ msg: m.msg, sticker: m.sticker, files: rawFiles }, { withName: false });
  }
  const reactions: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((m.reactions ?? {}) as Record<string, { usernames?: string[] }>)) reactions[k] = [...(v?.usernames ?? [])];
  const userId = m.u?._id ?? null;
  return {
    id: m._id,
    ts: m.ts,
    author: { id: userId, username: m.u?.username ?? '', name: m.u?.name || m.u?.username || '', deleted: userId === null },
    kind,
    t: m.t ?? null,
    msg: encrypted ? null : (m.msg ?? ''),
    text,
    fileOnly: kind === 'message' && !m.msg && !m.sticker && !rawFiles[0]?.voice && rawFiles.length > 0,
    tmid: m.tmid ?? null,
    editedAt: m.editedAt ?? null,
    pinned: !!m.pinned,
    files,
    reactions,
    // Cifrada: nada além do marcador (nem citações nem cartões).
    attachments: encrypted ? [] : ((m.attachments ?? []) as Attachment[]),
    ackRequired: !!m.ackRequired,
    ackCount: Number(m.ackCount ?? 0),
  };
}

const kindCsv: Record<ExportKind, string> = { message: 'mensagem', system: 'sistema', encrypted: 'criptografada', removed: 'removida' };
const kindClass: Record<ExportKind, string> = { message: 'msg', system: 'msg sys', encrypted: 'msg enc', removed: 'msg rm' };

function fileHtml(f: ExportFile) {
  const label = `${escapeHtml(f.name)}`;
  const size = f.size ? ` (${escapeHtml(formatBytes(f.size))})` : '';
  if (f.encrypted) return `<li>${label}${size} · <span class="flag">Arquivo criptografado</span></li>`;
  if (f.missing) return `<li>${label}${size} · <span class="flag">Arquivo indisponível</span></li>`;
  const href = f.path ? f.path.split('/').map(encodeURIComponent).join('/') : f.url;
  return `<li><a href="${escapeHtml(href)}">${label}</a>${size}</li>`;
}

// Reações como no chat: 👍 2 (emoji personalizado como :nome:). O JSON guarda o shortcode.
const reactionList = (em: ExportMessage) => Object.entries(em.reactions).filter(([, us]) => us.length);

export function messageHtml(em: ExportMessage, nameOf: (username: string) => string = (u) => u): string {
  const sys = em.kind === 'system';
  const parts: string[] = [`<article id="m-${escapeHtml(em.id)}" class="${kindClass[em.kind]}">`, `<div class="time">${escapeHtml(timeFmt.format(new Date(em.ts)))}</div><div>`];
  if (!sys) {
    const gone = em.author.deleted ? '<span class="gone">(conta excluída)</span>' : '';
    parts.push(`<div class="who"><b>${escapeHtml(em.author.name)}</b><span class="u">@${escapeHtml(em.author.username)}</span>${gone}</div>`);
  }
  if (em.tmid) parts.push(`<a class="reply" href="#m-${escapeHtml(em.tmid)}">↳ Resposta no tópico</a>`);
  if (!em.fileOnly && em.text) parts.push(`<div class="text">${htmlText(em.text)}</div>`);
  for (const a of em.attachments) {
    if (!a.message_link) continue;
    const who = a.author_alias || a.author_name || '';
    parts.push(`<blockquote>Citou ${escapeHtml(who)}: “${escapeHtml(truncate(String(a.text ?? ''), 200))}”</blockquote>`);
  }
  if (em.files.length) parts.push(`<ul class="files">${em.files.map(fileHtml).join('')}</ul>`);
  const tags = [em.editedAt && '(editada)', em.pinned && 'Fixada', em.ackRequired && `Ciente: ${em.ackCount.toLocaleString('pt-BR')}`].filter(Boolean);
  if (tags.length) parts.push(`<div class="tags">${tags.map((t) => escapeHtml(t)).join(' · ')}</div>`);
  const reactions = reactionList(em);
  if (reactions.length) {
    // O título é o do chat: "Ana e Bruno reagiram com :thumbsup:".
    const title = (k: string, us: string[]) => `${andList.format(us.map(nameOf))} ${us.length === 1 ? 'reagiu' : 'reagiram'} com ${k}`;
    const pill = ([k, us]: [string, string[]]) => `<span title="${escapeHtml(title(k, us))}">${escapeHtml(emojiText(k))} ${us.length}</span>`;
    parts.push(`<div class="reactions">${reactions.map(pill).join('')}</div>`);
  }
  parts.push('</div></article>');
  return parts.join('');
}

// Cabeçalho do dia ("segunda-feira, 3 de novembro de 2026") quando o dia muda.
export function dayHeading(iso: string) {
  return `<h2>${escapeHtml(headingFmt.format(new Date(iso)))}</h2>`;
}

export const CSV_HEADER = csvRow(['Data e hora', 'Autor', 'Usuário', 'Tipo', 'Mensagem', 'Resposta ao tópico', 'Editada em', 'Arquivos', 'Reações', 'Cientes', 'Fixada', 'ID da mensagem']);

export function messageCsv(em: ExportMessage): string {
  const files = em.files.map((f) => `${f.name}${f.encrypted ? ' (criptografado)' : f.missing ? ' (indisponível)' : ''}`).join(' | ');
  const reactions = reactionList(em)
    .map(([k, us]) => `${emojiText(k)} ${us.length}`)
    .join('; ');
  return csvRow([
    formatCsvDate(em.ts),
    em.author.deleted ? `${em.author.name} (conta excluída)` : em.author.name,
    em.author.username,
    kindCsv[em.kind],
    em.text,
    em.tmid ?? '',
    em.editedAt ? formatCsvDate(em.editedAt) : '',
    files,
    reactions,
    em.ackRequired ? em.ackCount : '',
    em.pinned ? 'sim' : '',
    em.id,
  ]);
}

export function messageJson(em: ExportMessage): string {
  return JSON.stringify({
    id: em.id,
    ts: em.ts,
    u: { id: em.author.id, username: em.author.username, name: em.author.name, ...(em.author.deleted ? { deleted: true } : {}) },
    t: em.t,
    msg: em.msg,
    text: em.text,
    tmid: em.tmid,
    editedAt: em.editedAt,
    pinned: em.pinned,
    ...(em.kind === 'encrypted' ? { encrypted: true } : {}),
    files: em.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, path: f.path, url: f.url, ...(f.missing ? { missing: true } : {}) })),
    reactions: em.reactions,
    attachments: em.attachments,
    ackRequired: em.ackRequired,
    ackCount: em.ackCount,
  });
}
