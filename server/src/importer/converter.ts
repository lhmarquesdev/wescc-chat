import type { Attachment, UserRef as MentionRef } from '@shared/index';
import { config } from '../config';
import { many, one, pool, query, tx, type Queryable } from '../db/pool';
import { newId, randomToken } from '../lib/ids';
import { hashPassword } from '../lib/password';
import { trimEndChars, truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { mapRoom } from '../services/mappers';
import { CHANNEL_RE, MENTION_RE, safeUrl } from '../services/messages';
import { hasPermission } from '../services/permissions';
import { buildSubscription, getRoom, notifyRoomUpdated, notifySubscription } from '../services/rooms';
import { revokeAllSessions, sendPasswordSetupEmail } from '../services/users';
import { channelImportId } from './importers/csv';
import { MAX_EMAIL, isEmail } from './importers/csv-util';
import { iterateStaged, markRecordError, markRecordsSkipped } from './staging';
import {
  DIRECT_MESSAGES_ID,
  ST,
  type Actor,
  type ConversionResult,
  type ImportChannel,
  type ImportContact,
  type ImportFile,
  type ImportMessage,
  type ImportOptions,
  type ImportUser,
  type ProgressSink,
  type ShortSelection,
  type ShortSelectionPart,
  type StagedRecord,
} from './types';

// Conversão dos dados lidos do arquivo (import_records) em usuários, contatos, salas e mensagens.
// Grava direto no banco, sem createUser/createRoom/sendMessage: eles disparam webhooks, bots, notificações
// e usam a hora atual, o que não serve para histórico importado.

const BATCH = 500;
const MAX_MSG = 50_000;
const USERNAME_RE = /^[0-9a-zA-Z._-]{2,40}$/;
const ROOM_NAME_RE = /^[0-9a-zA-ZÀ-ſ._-]{1,64}$/;
const REACTION_RE = /^:[a-z0-9_+\-]{1,64}:$/i;
const TOKEN_RE = /\u0001([@#])([^|\u0001\u0002]*)(?:\|([^\u0001\u0002]*))?\u0002/g;
// No CSV o id de um canal é o próprio nome: dois arquivos sem relação nenhuma dão o mesmo id a grupos de mesmo nome.
const CSV_ROOM_ID = channelImportId('');
const nameOnlyId = (id: string) => id.startsWith(CSV_ROOM_ID);
const RESERVED_USERNAMES = new Set(['all', 'here']);
// Importadores cujos ids não são da origem (e-mail ou nome): só desativam as contas que uma importação deles criou.
const CREATED_ONLY = new Set(['csv', 'slack-users']);
// "-", "n/a", vazio ou espaços no lugar do e-mail valem como sem e-mail, e um texto de mais de 254 caracteres também.
export const validEmail = isEmail;
// Um e-mail do arquivo é cortado um caractere além do máximo antes de conferir: comprido demais continua comprido demais
// e não vale (cortado no máximo, podia virar o endereço de outra pessoa).
export const EMAIL_CUT = MAX_EMAIL + 1;
// E-mail confiável (expressão SQL sobre a conta u): confirmado, ou o que uma importação deu à conta que criou, enquanto
// a conta não o trocar. Login externo entra pelo email_verified: conta criada pelo LDAP ou SAML já nasce confirmada, o
// OAuth grava o que o provedor diz, e a troca do e-mail pela própria pessoa (permitida também a essas contas) desmarca.
// Um e-mail digitado por quem usa a conta, no cadastro ou no perfil, não prova que é dela.
export const trustedEmailSql = (u: string) =>
  `(${u}.email_verified OR EXISTS (SELECT 1 FROM import_map p WHERE p.kind = 'user-email' AND p.import_id = lower(${u}.email) AND p.target_id = ${u}.id))`;

interface UserRef {
  id: string;
  username: string;
  name: string;
}

interface RoomRef {
  id: string;
  t: string;
  name: string | null;
}

interface KnownMessage {
  id: string;
  roomId: string;
  userId: string | null;
  tmid: string | null;
  attachments: Attachment[];
}

// ---------- Auxiliares ----------

const uniq = <T>(list: T[]) => [...new Set(list)];
// Todo corte de texto usa truncate: String.slice pode partir um emoji, e o jsonb recusa a metade solta.
const str = (v: unknown, max: number) => (typeof v === 'string' ? truncate(v.trim(), max) : '');
const clip = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? truncate(String(v), max) || undefined : undefined);
const errText = (e: unknown) => truncate(String((e as Error)?.message ?? e), 500);
const iso = (ms: number) => new Date(ms).toISOString();
const userRef = (r: any): UserRef => ({ id: r.id, username: r.username, name: r.name ?? '' });
const roomRef = (r: any): RoomRef => ({ id: r.id, t: r.t, name: r.name ?? null });

function timeOf(v: unknown): number | null {
  const ms = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
}

function withSuffix(base: string, suffix: string, max: number) {
  return trimEndChars(truncate(base, max - suffix.length), '._-') + suffix;
}

// Nome de usuário no formato aceito aqui (2-40: letras, números, ponto, hífen, sublinhado). Um nome já válido fica como está.
export function sanitizeUsername(raw: string): string {
  const v = raw.trim();
  if (USERNAME_RE.test(v)) return v;
  let s = v
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^0-9a-zA-Z._-]+/g, '.')
    .replace(/[._-]{2,}/g, (m) => m[0])
    .replace(/^[._-]+|[._-]+$/g, '');
  if (s.length > 40) s = trimEndChars(truncate(s, 40), '._-');
  return s;
}

// Nome de sala no formato aceito aqui (até 64: letras, inclusive acentuadas, números, ponto, hífen, sublinhado).
export function sanitizeRoomName(raw: string): string {
  const v = raw.normalize('NFC').trim();
  if (ROOM_NAME_RE.test(v)) return v;
  let s = v
    .replace(/[^0-9a-zA-ZÀ-ſ._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 64) s = trimEndChars(truncate(s, 64), '-');
  return s;
}

// "john.doe" → "John Doe"
export function nameFromUsername(username: string): string {
  return username
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim()
    .replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

function selector(part?: ShortSelectionPart) {
  if (part?.all) return () => true;
  const set = new Set(part?.list ?? []);
  return (id: string | null | undefined) => !!id && set.has(id);
}

// ---------- Anexos e arquivos ----------

function importAttachments(list: unknown, fix: (s: string) => string): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  const txt = (v: unknown, max: number) => {
    const s = clip(v, max);
    return s === undefined ? undefined : fix(s) || undefined;
  };
  for (const a of list.slice(0, 20) as any[]) {
    if (!a || typeof a !== 'object') continue;
    const ts = timeOf(a.ts);
    const fields = Array.isArray(a.fields)
      ? a.fields
          .slice(0, 20)
          .filter((f: any) => f && typeof f === 'object')
          .map((f: any) => ({ title: truncate(fix(String(f.title ?? '')), 200), value: truncate(fix(String(f.value ?? '')), 2000), short: !!f.short }))
      : [];
    // Sem type: 'file' (esses são só os arquivos guardados aqui).
    const clean: Record<string, unknown> = {
      title: txt(a.title, 500),
      title_link: safeUrl(a.title_link),
      text: txt(a.text, 5000),
      pretext: txt(a.pretext, 5000),
      color: clip(a.color, 30),
      author_name: txt(a.author_name, 200),
      author_link: safeUrl(a.author_link),
      author_icon: safeUrl(a.author_icon),
      image_url: safeUrl(a.image_url),
      thumb_url: safeUrl(a.thumb_url),
      footer: txt(a.footer, 5000),
      fields: fields.length ? fields : undefined,
      ts: ts ? iso(ts) : undefined,
    };
    for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    if (Object.keys(clean).some((k) => k !== 'ts')) out.push(clean as Attachment);
  }
  return out;
}

function importFiles(list: unknown): ImportFile[] {
  if (!Array.isArray(list)) return [];
  const out = new Map<string, ImportFile>();
  for (const f of list as any[]) {
    if (!f || typeof f !== 'object' || f.id === undefined || f.id === null || f.id === '') continue;
    const id = truncate(String(f.id), 200);
    if (out.has(id)) continue;
    const url = typeof f.url === 'string' && /^https?:\/\//i.test(f.url) && f.url.length <= 8192 ? f.url : undefined;
    out.set(id, {
      id,
      name: str(f.name, 255) || 'arquivo',
      size: typeof f.size === 'number' && Number.isFinite(f.size) && f.size >= 0 ? Math.trunc(f.size) : undefined,
      type: str(f.type, 200) || undefined,
      url,
      external: !!f.external,
    });
  }
  return [...out.values()];
}

// Externos (Google Drive etc.) e apagados na origem nunca são baixados: o texto não promete um download que não vem.
const placeholder = (f: ImportFile): Attachment => ({
  title: f.name,
  text: f.url && !f.external ? `📎 ${f.name} (arquivo ainda não baixado da origem)` : `📎 ${f.name} (arquivo não disponível na origem)`,
  pendingFileId: f.id,
});

export function mentionNames(msg: string) {
  const special = new Set<string>();
  const users = new Set<string>();
  const rooms = new Set<string>();
  for (const m of msg.matchAll(MENTION_RE)) {
    const n = trimEndChars(m[1], '.');
    if (!n) continue;
    if (n === 'all' || n === 'here') special.add(n);
    else users.add(n.toLowerCase());
  }
  for (const m of msg.matchAll(CHANNEL_RE)) rooms.add(m[1].toLowerCase());
  return { special, users, rooms };
}

// ---------- Usuários ----------

interface NormUser {
  importIds: string[];
  email: string; // o primeiro: vira o e-mail da conta nova
  emails: string[]; // todos os válidos, para achar a conta que já existe
  username: string;
  name: string;
  bio: string;
  statusText: string;
  roles: string[];
  deleted?: boolean;
  bot: boolean;
  avatarUrl: string;
  passwordHash: string;
  password: string; // legado: nada mais guarda a senha em texto em import_records
}

// Hash no formato de lib/password (scrypt$N$r$p$sal$chave), como o import.addUsers guarda.
function passwordHashOf(v: unknown) {
  if (typeof v !== 'string' || v.length > 512) return '';
  const p = v.split('$');
  return p.length === 6 && p[0] === 'scrypt' && p.slice(1, 4).every((x) => /^\d{1,7}$/.test(x)) && !!p[4] && !!p[5] ? v : '';
}

function normUser(u: ImportUser): NormUser {
  const emails = uniq((Array.isArray(u.emails) ? u.emails : []).map((e) => str(e, EMAIL_CUT)).filter(validEmail));
  return {
    importIds: uniq((Array.isArray(u.importIds) ? u.importIds : []).filter((x) => x !== null && x !== undefined && x !== '').map(String)),
    email: emails[0] ?? '',
    emails,
    username: str(u.username, 200).replace(/^@+/, ''),
    name: str(u.name, 200),
    bio: str(u.bio, 1000),
    statusText: str(u.statusText, 120),
    roles: Array.isArray(u.roles) ? uniq(u.roles.map(String)) : [],
    deleted: u.deleted === true ? true : u.deleted === false ? false : undefined,
    bot: u.type === 'bot',
    avatarUrl: typeof u.avatarUrl === 'string' && /^https?:\/\//i.test(u.avatarUrl) && u.avatarUrl.length <= 2048 ? u.avatarUrl : '',
    passwordHash: passwordHashOf(u.passwordHash),
    password: typeof u.password === 'string' ? u.password : '',
  };
}

function usernameBase(n: NormUser) {
  const tries: [string, boolean][] = [
    [n.username, false],
    [n.name, true],
    [n.email.split('@')[0] ?? '', true],
  ];
  for (const [v, lower] of tries) {
    if (!v) continue;
    const s = sanitizeUsername(v);
    if (s.length >= 2) return lower ? s.toLowerCase() : s;
  }
  return 'usuario';
}

interface NewUserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  hash: string | null;
  active: boolean;
  type: 'user' | 'bot';
  roles: string[];
  bio: string;
  statusText: string;
}

// notes: avisos gravados no registro depois do COMMIT.
// viaMap: a conta veio do import_map (esta mesma origem já foi importada antes, com e-mail que não contradiz), e não só
// do e-mail ou do nome.
// handover: conta provisória desta pessoa (criada por uma importação desta origem sem o e-mail, que era de uma conta que
// não o tinha confirmado), cujo conteúdo passa para esta conta.
type UserPlan = { rec: StagedRecord<ImportUser>; n: NormUser; notes: string[] } & (
  | { kind: 'new'; row: NewUserRow }
  | { kind: 'existing'; userId: string; viaMap: boolean; handover?: { id: string; username: string } }
  | { kind: 'same'; ref: UserRef }
);

// Conta criada nesta importação, para os registros seguintes do mesmo arquivo.
interface RunUser {
  ref: UserRef;
  bot: boolean;
  hasEmail: boolean;
}

type SubRow = {
  id: string;
  room_id: string;
  user_id: string;
};

// O que só pode ser feito depois do COMMIT (memória, avisos, sessões, eventos).
interface Effects {
  refs: Map<UserPlan, UserRef>;
  subs: SubRow[];
  deactivated: string[];
  warnings: { id: number; msg: string }[];
  // Passagem de conta provisória: salas a recalcular, e conversas diretas juntadas a outra (já apagadas).
  rooms: string[];
  removed: { room: any; subs: any[] }[];
}

// ---------- Mensagens ----------

interface MsgPlan {
  rec: StagedRecord<ImportMessage>;
  kind: 'insert' | 'update';
  id: string;
  importId: string | null;
  roomId: string;
  author: UserRef;
  msg: string;
  t: string | null;
  tmid: string | null;
  deferredParent: string | null;
  tshow: boolean;
  attachments: Attachment[];
  files: ImportFile[];
  keep: Attachment[];
  reactions: Record<string, { usernames: string[] }>;
  pinned: boolean;
  editedAt: string | null;
  editedBy: { _id: string; username: string } | null;
  alias: string | null;
  emoji: string | null;
  ms: number;
  mentions: MentionRef[];
  channels: { _id: string; name: string }[];
}

const THREADS_SQL = `
  UPDATE messages p SET tcount = c.n, tlm = c.last,
    replies = (SELECT array_agg(DISTINCT x) FROM unnest(c.users || ARRAY[p.user_id]) x WHERE x IS NOT NULL),
    updated_at = now()
  FROM (SELECT tmid, count(*)::int AS n, max(created_at) AS last, array_agg(DISTINCT user_id) AS users
        FROM messages WHERE room_id = ANY($1::text[]) AND tmid IS NOT NULL GROUP BY tmid) c
  WHERE p.id = c.tmid`;

class Conversion {
  private readonly result: ConversionResult = {
    users: { inserted: 0, updated: 0, failed: 0, skipped: 0 },
    channels: { inserted: 0, updated: 0, failed: 0, skipped: 0 },
    messages: { inserted: 0, updated: 0, failed: 0, skipped: 0 },
    contacts: { inserted: 0, failed: 0, skipped: 0 },
    roomIds: [],
    newUserIds: [],
  };
  private importer: UserRef | null = null;
  private online = new Set<string>();
  private defaultRooms: string[] = [];

  // Ids de importação → usuários e salas daqui (só usuários e salas: mensagens vão sempre pelo import_map).
  private users = new Map<string, UserRef>();
  private missingUsers = new Set<string>();
  private usersDone = false;
  private rooms = new Map<string, RoomRef>();
  private missingRooms = new Set<string>();
  private roomsByName = new Map<string, RoomRef | null>();
  // Salas não selecionadas ou que falharam: as mensagens delas contam como ignoradas, não como erro.
  private skippedRooms = new Set<string>();

  private takenUsernames = new Set<string>();
  private takenEmails = new Set<string>();
  private runByEmail = new Map<string, UserRef>();
  private runByName = new Map<string, RunUser>();
  // Ids de importação ligados nesta importação só pelo e-mail ou pelo nome: não contam como importação anterior.
  private weakUserIds = new Set<string>();
  private takenRoomNames = new Set<string>();
  private roleScopes = new Map<string, string>();
  private canGrantAdmin = false;
  private importerKey = '';
  private createdOnly = false;
  // Contas provisórias já passadas para a conta certa nesta importação.
  private handedOver = new Set<string>();
  // Usuários do arquivo que não entraram (não selecionados, ou já existentes com skipExistingUsers): id → dados.
  private skippedUsers: Map<string, NormUser> | null = null;
  // Salas c/p já usadas por algum canal deste arquivo (sala → ids do canal): outro canal nunca se junta a elas.
  private runRooms = new Map<string, Set<string>>();
  // Salas ligadas pelo import_map a algum canal c/p deste arquivo, e as que uma importação criou para um deles
  // (sala → ids). Calculadas antes de tudo: a ordem dos canais no arquivo não pode decidir de quem é a sala.
  private fileRooms = new Set<string>();
  private fileCreators = new Map<string, Set<string>>();

  private createdRooms = new Set<string>();
  private publicRooms: string[] = [];
  private memberRooms = new Set<string>();
  private msgRooms = new Set<string>();
  private insertedNormal = new Map<string, number>();
  private usedTs = new Map<string, Set<number>>();
  private clock = 0;
  private deferred: { id: string; roomId: string; parent: string; tshow: boolean }[] = [];
  private newSubs: { userId: string; rid: string }[] = [];
  private newUsers: { id: string; email: string | null; bot: boolean; active: boolean }[] = [];

  constructor(
    private readonly opId: string,
    private readonly actor: Actor,
    private readonly sel: ShortSelection,
    private readonly options: ImportOptions,
    private readonly sink: ProgressSink,
  ) {}

  private stopped() {
    return this.sink.cancelled();
  }

  async run(): Promise<ConversionResult> {
    const me = this.actor.userId ? await one('SELECT id, username, name FROM users WHERE id = $1', [this.actor.userId]) : null;
    this.importer = me ? userRef(me) : null;
    const op = await one('SELECT importer_key FROM import_operations WHERE id = $1', [this.opId]);
    this.importerKey = String(op?.importer_key ?? '');
    this.createdOnly = CREATED_ONLY.has(this.importerKey);
    this.online = new Set((await many('SELECT DISTINCT user_id FROM presence_connections')).map((r) => r.user_id));

    if (!this.stopped()) await this.convertUsers();
    this.usersDone = true;
    if (!this.stopped()) await this.convertContacts();
    if (!this.stopped()) await this.convertChannels();
    if (!this.stopped()) await this.convertMessages();
    if (!this.stopped()) await this.sink.step(ST.finishing);
    // Mesmo cancelada, o que já entrou fica consistente (contadores, threads, última mensagem).
    await this.finish();
    await this.sink.flush();
    await this.notify();
    if (this.options.sendPasswordEmails) this.sendPasswordEmails();
    this.result.roomIds = uniq([...this.memberRooms, ...this.msgRooms]);
    return this.result;
  }

  // ---------- Contagem ----------

  private async fail(rec: StagedRecord<unknown>, kind: 'users' | 'channels' | 'messages' | 'contacts', msg: string) {
    await markRecordError(rec.id, msg);
    this.sink.inc({ error: 1 });
    this.result[kind].failed++;
  }

  private async skipRecords(recs: StagedRecord<unknown>[], kind: 'users' | 'channels' | 'messages' | 'contacts') {
    if (!recs.length) return;
    await markRecordsSkipped(recs.map((r) => r.id));
    this.sink.inc({ skipped: recs.length });
    this.result[kind].skipped += recs.length;
  }

  private async pick<T>(batch: StagedRecord<T>[], keep: (r: StagedRecord<T>) => boolean, kind: 'users' | 'channels' | 'contacts', onSkip?: (r: StagedRecord<T>) => void) {
    const chosen: StagedRecord<T>[] = [];
    const skipped: StagedRecord<T>[] = [];
    for (const r of batch) (keep(r) ? chosen : skipped).push(r);
    skipped.forEach((r) => onSkip?.(r));
    await this.skipRecords(skipped, kind);
    return chosen;
  }

  // ---------- Resolução de ids ----------

  private async resolveUsers(ids: string[]) {
    const need = uniq(ids.filter((id) => id && !this.users.has(id) && !this.missingUsers.has(id)));
    if (!need.length) return;
    const mapped = await many(
      `SELECT m.import_id, u.id, u.username, u.name FROM import_map m JOIN users u ON u.id = m.target_id
       WHERE m.kind = 'user' AND m.import_id = ANY($1::text[])`,
      [need],
    );
    for (const r of mapped) this.users.set(r.import_id, userRef(r));
    let rest = need.filter((id) => !this.users.has(id));
    if (!rest.length) return;
    if (this.usersDone) {
      await this.resolveSkipped(rest);
      rest = rest.filter((id) => !this.users.has(id) && !this.missingUsers.has(id));
      if (!rest.length) return;
    }
    // Autor que não veio na lista de usuários (CSV): um usuário que já existe com esse nome.
    const rows = await many('SELECT id, username, name FROM users WHERE lower(username) = ANY($1::text[])', [rest.map((s) => s.toLowerCase())]);
    const byName = new Map(rows.map((r) => [String(r.username).toLowerCase(), r]));
    for (const id of rest) {
      const u = byName.get(id.toLowerCase());
      if (u) this.users.set(id, userRef(u));
      else if (this.usersDone) this.missingUsers.add(id);
    }
  }

  // Usuário do arquivo que não entrou (não selecionado, por exemplo porque já existe aqui): fica com a conta que a
  // importação dele acharia pelo e-mail confiável ou pelo nome (mesmas regras de userBatch), sem mexer nela; nunca com
  // uma conta nova. O id de uma pessoa do CSV é o e-mail, então o nome dela só é achado por aqui.
  private async resolveSkipped(ids: string[]) {
    if (!this.skippedUsers) {
      const skipped = new Map<string, NormUser>();
      const recs = await many(
        `SELECT data->'importIds' AS ids, data->'emails' AS emails, data->'username' AS username, data->'type' AS type
         FROM import_records WHERE operation_id = $1 AND data_type = 'user' AND skipped`,
        [this.opId],
      );
      for (const r of recs) {
        const n = normUser({ importIds: r.ids, emails: r.emails, username: r.username, type: r.type } as ImportUser);
        for (const id of n.importIds) if (!skipped.has(id)) skipped.set(id, n);
      }
      this.skippedUsers = skipped;
    }
    const found = ids.flatMap((id) => {
      const n = this.skippedUsers!.get(id);
      return n ? [[id, n] as const] : [];
    });
    if (!found.length) return;
    const emails = uniq(found.flatMap(([, n]) => n.emails.map((e) => e.toLowerCase())));
    const names = uniq(found.map(([, n]) => n.username.toLowerCase()).filter(Boolean));
    const byEmail = new Map(
      (await many(`SELECT u.id, u.username, u.name, u.email, ${trustedEmailSql('u')} AS trusted FROM users u WHERE lower(u.email) = ANY($1::text[])`, [emails])).map((r) => [
        String(r.email).toLowerCase(),
        r,
      ]),
    );
    const byName = new Map((await many('SELECT id, username, name, email, type FROM users WHERE lower(username) = ANY($1::text[])', [names])).map((r) => [String(r.username).toLowerCase(), r]));
    for (const [id, n] of found) {
      const held = n.emails.map((e) => byEmail.get(e.toLowerCase())).filter(Boolean);
      let u = held.find((x) => x.trusted);
      if (!u && !held.length && n.username) {
        const db = byName.get(n.username.toLowerCase());
        if (db && (db.type === 'bot') === n.bot && !(validEmail(db.email) && n.emails.length)) u = db;
      }
      if (u) this.users.set(id, userRef(u));
      else this.missingUsers.add(id);
    }
  }

  private async resolveRooms(ids: string[]) {
    const need = uniq(ids.filter((id) => id && !this.rooms.has(id) && !this.missingRooms.has(id)));
    if (!need.length) return;
    const rows = await many(
      `SELECT m.import_id, r.id, r.t, r.name FROM import_map m JOIN rooms r ON r.id = m.target_id
       WHERE m.kind = 'room' AND m.import_id = ANY($1::text[])`,
      [need],
    );
    for (const r of rows) this.rooms.set(r.import_id, roomRef(r));
    for (const id of need) if (!this.rooms.has(id)) this.missingRooms.add(id);
  }

  // Menção a sala: id de importação ou nome de um canal/grupo.
  private async resolveRoomRefs(refs: string[]) {
    await this.resolveRooms(refs);
    if (this.roomsByName.size > 100_000) this.roomsByName.clear();
    const names = uniq(refs.filter((r) => r && !this.rooms.get(r)?.name).map((r) => r.toLowerCase())).filter((n) => !this.roomsByName.has(n));
    if (!names.length) return;
    const rows = await many(`SELECT id, t, name FROM rooms WHERE lower(name) = ANY($1::text[]) AND t IN ('c','p') ORDER BY prid NULLS FIRST, created_at`, [names]);
    for (const r of rows) if (!this.roomsByName.get(String(r.name).toLowerCase())) this.roomsByName.set(String(r.name).toLowerCase(), roomRef(r));
    for (const n of names) if (!this.roomsByName.has(n)) this.roomsByName.set(n, null);
  }

  private roomName(ref: string) {
    const r = this.rooms.get(ref);
    if (r?.name) return r.name;
    return this.roomsByName.get(ref.toLowerCase())?.name ?? null;
  }

  private replaceTokens(s: string) {
    if (!s.includes('\u0001') && !s.includes('\u0002')) return s;
    return s
      .replace(TOKEN_RE, (_all, kind: string, ref: string, label?: string) => {
        if (kind === '@') return `@${this.users.get(ref)?.username ?? (label || ref)}`;
        return `#${this.roomName(ref) ?? (label || ref)}`;
      })
      .replace(/[\u0001\u0002]/g, '');
  }

  private async mapIds(c: Queryable, kind: 'user' | 'user-created' | 'user-email' | 'room' | 'room-created' | 'message' | 'contact', pairs: [string, string][]) {
    // Um id repetido no mesmo INSERT ... ON CONFLICT DO UPDATE é recusado pelo PostgreSQL.
    const m = new Map(pairs.filter(([i]) => i));
    if (!m.size) return;
    await query(
      `INSERT INTO import_map (kind, import_id, target_id, operation_id)
       SELECT $1, i, t, $4 FROM unnest($2::text[], $3::text[]) AS x(i, t)
       ON CONFLICT (kind, import_id) DO UPDATE SET target_id = EXCLUDED.target_id, operation_id = EXCLUDED.operation_id`,
      [kind, [...m.keys()], [...m.values()], this.opId],
      c,
    );
  }

  // Assinaturas silenciosas (sem mensagem de sistema), já lidas.
  private async addSubs(c: Queryable, subs: { rid: string; uid: string; owner?: boolean; open?: boolean }[]): Promise<SubRow[]> {
    if (!subs.length) return [];
    const r = await query<SubRow>(
      `INSERT INTO subscriptions (id, room_id, user_id, roles, open, alert, ls)
       SELECT x.id, x.rid, x.uid, CASE WHEN x.owner THEN '{owner}'::text[] ELSE '{}'::text[] END, x.open, false, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[], $5::bool[]) AS x(id, rid, uid, owner, open)
       ON CONFLICT (room_id, user_id) DO NOTHING RETURNING id, room_id, user_id`,
      [subs.map(() => newId()), subs.map((s) => s.rid), subs.map((s) => s.uid), subs.map((s) => !!s.owner), subs.map((s) => s.open !== false)],
      c,
    );
    if (r.rows.length) {
      await query(
        `INSERT INTO team_members (team_id, user_id)
         SELECT r.team_id, x.uid FROM unnest($1::text[], $2::text[]) AS x(rid, uid) JOIN rooms r ON r.id = x.rid
         WHERE r.team_main AND r.team_id IS NOT NULL ON CONFLICT DO NOTHING`,
        [r.rows.map((s) => s.room_id), r.rows.map((s) => s.user_id)],
        c,
      );
    }
    return r.rows;
  }

  private rememberSubs(subs: SubRow[]) {
    for (const s of subs) {
      this.memberRooms.add(s.room_id);
      if (this.online.has(s.user_id)) this.newSubs.push({ userId: s.user_id, rid: s.room_id });
    }
  }

  // ---------- Usuários ----------

  private async convertUsers() {
    await this.sink.step(ST.importingUsers);
    this.roleScopes = new Map((await many('SELECT id, scope FROM roles')).map((r) => [r.id, r.scope]));
    this.canGrantAdmin = !!this.actor.userId && (await hasPermission(this.actor.userId, 'assign-admin-role'));
    this.defaultRooms = (await many(`SELECT id FROM rooms WHERE is_default AND t IN ('c','p') AND NOT archived ORDER BY created_at`)).map((r) => r.id);
    const sel = selector(this.sel.users);
    for await (const batch of iterateStaged<ImportUser>(this.opId, 'user', BATCH)) {
      if (this.stopped()) return;
      const chosen = await this.pick(batch, (r) => sel(r.importId ?? r.data.importIds?.[0]), 'users');
      if (chosen.length) await this.userBatch(chosen);
    }
  }

  private async userBatch(recs: StagedRecord<ImportUser>[]) {
    const norm = recs.map((r) => normUser(r.data ?? ({} as ImportUser)));
    const ids = uniq(norm.flatMap((n) => n.importIds));
    const emails = uniq(norm.flatMap((n) => n.emails.map((e) => e.toLowerCase())));
    const names = uniq(norm.map((n) => n.username.toLowerCase()).filter(Boolean));
    const byMap = new Map<string, any>();
    for (const r of await many(`SELECT m.import_id, u.* FROM import_map m JOIN users u ON u.id = m.target_id WHERE m.kind = 'user' AND m.import_id = ANY($1::text[])`, [ids]))
      byMap.set(r.import_id, r);
    const byEmail = new Map(
      (await many(`SELECT u.*, ${trustedEmailSql('u')} AS trusted_email FROM users u WHERE lower(u.email) = ANY($1::text[])`, [emails])).map((r) => [
        String(r.email).toLowerCase(),
        r,
      ]),
    );
    const byName = new Map((await many('SELECT * FROM users WHERE lower(username) = ANY($1::text[])', [names])).map((r) => [String(r.username).toLowerCase(), r]));
    // Contas que uma importação desta mesma origem criou para estes ids.
    const createdHere = new Map((await this.createdRows(pool, ids)).map((r) => [r.import_id, r.target_id]));

    const plans: UserPlan[] = [];
    // Repetidos de uma conta nova deste mesmo lote: entram depois dela.
    const later: UserPlan[] = [];
    const fresh: { rec: StagedRecord<ImportUser>; n: NormUser; base: string; conflict: string; untrusted: any; disjoint: string; notes: string[]; run: RunUser }[] = [];
    const freshRefs = new Set<UserRef>();
    const batchIds = new Map<string, UserRef>();
    const skipped: StagedRecord<ImportUser>[] = [];
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const n = norm[i];
      if (!n.email && !n.username) {
        await this.fail(rec, 'users', 'Usuário sem e-mail e sem nome de usuário.');
        continue;
      }
      // Ordem: importação anterior (import_map), qualquer um dos e-mails, nome de usuário. Repetidos no mesmo arquivo viram um só.
      const les = n.emails.map((e) => e.toLowerCase());
      const lu = n.username.toLowerCase();
      const notes: string[] = [];
      const hit = n.importIds.find((id) => byMap.has(id));
      let existing: any;
      let viaMap = false;
      // Ligada antes a uma conta sem e-mail, e o e-mail do arquivo é de uma conta confirmada: fica com ela.
      let moved = '';
      let handover: { id: string; username: string } | undefined;
      let owner: any;
      // Ligada antes a uma conta com outro e-mail: é outra pessoa, e não junta a nenhuma conta pelo nome.
      let disjoint = '';
      if (hit) {
        // O vínculo de uma importação anterior também passa pelo e-mail: com outro e-mail é outra pessoa (um id de CSV
        // sem e-mail é só o nome). Conta ligada sem e-mail perde para a dona confirmada do e-mail do arquivo.
        const m = byMap.get(hit);
        const own = validEmail(m.email) ? m.email.toLowerCase() : '';
        owner = own ? undefined : les.map((e) => byEmail.get(e)).find((u) => u?.trusted_email && u.id !== m.id);
        const label = truncate(n.username || n.email, 100);
        if (own && les.length && !les.includes(own)) disjoint = `O usuário "${label}" estava ligado à conta "${m.username}" por uma importação anterior, mas ela tem outro e-mail; não foi juntado a ela`;
        else if (owner) {
          // Conta que uma importação desta origem criou para esta pessoa sem o e-mail (era de uma conta que não o tinha
          // confirmado, e agora confirmou): o que foi importado para ela passa para a dona do e-mail.
          if (m.id !== this.actor.userId && m.type === owner.type && !this.handedOver.has(m.id) && n.importIds.some((id) => createdHere.get(id) === m.id)) {
            handover = { id: m.id, username: m.username };
          } else {
            moved =
              `O usuário "${label}" estava ligado à conta "${m.username}", que não tem e-mail; agora fica com a conta "${owner.username}", dona do e-mail confirmado. ` +
              `O que já tinha sido importado continua na conta "${m.username}".`;
          }
        } else {
          existing = m;
          viaMap = !this.weakUserIds.has(hit);
        }
      }
      let same = existing ? undefined : n.importIds.map((id) => this.users.get(id) ?? batchIds.get(id)).find(Boolean);
      // E-mail de uma conta que não o confirmou: é outra pessoa até alguém confirmar (nem pelo nome de usuário junta).
      let untrusted: any;
      if (!existing && !same && les.length) {
        const found = les.map((e) => byEmail.get(e)).filter(Boolean);
        existing = found.find((u) => u.trusted_email);
        same = existing ? undefined : les.map((e) => this.runByEmail.get(e)).find(Boolean);
        if (!existing && !same) untrusted = found[0];
      }
      // Só pelo nome de usuário: junta apenas se for o mesmo tipo de conta (bot ou não) e os e-mails não se contradizem.
      // Senão é outra pessoa com o mesmo nome, e ganha uma conta nova com outro nome de usuário.
      let conflict = '';
      if (!existing && !same && !untrusted && !disjoint && lu) {
        const db = byName.get(lu);
        const run = db ? undefined : this.runByName.get(lu);
        const other = db ? { bot: db.type === 'bot', hasEmail: validEmail(db.email) } : run;
        if (other && other.bot !== n.bot) conflict = other.bot ? 'já existe e é um bot' : 'já existe e não é um bot';
        else if (other && other.hasEmail && n.emails.length) conflict = 'já existe com outro e-mail';
        else if (db) existing = db;
        else same = run?.ref;
      }
      if (same) {
        if (disjoint) notes.push(`${disjoint}.`);
        else if (moved) notes.push(moved);
        (freshRefs.has(same) ? later : plans).push({ kind: 'same', rec, n, ref: same, notes });
      } else if (existing && this.options.skipExistingUsers) skipped.push(rec);
      else if (existing) {
        if (disjoint) notes.push(`${disjoint}, e sim à conta "${existing.username}", dona do e-mail confirmado.`);
        else if (moved) notes.push(moved);
        if (!viaMap) n.importIds.forEach((id) => this.weakUserIds.add(id));
        if (handover && existing.id === owner?.id) this.handedOver.add(handover.id);
        else handover = undefined;
        plans.push({ kind: 'existing', rec, n, userId: existing.id, viaMap, handover, notes });
      } else {
        // Já conta para os registros seguintes deste lote (mesmo id, e-mail ou nome); o nome final sai abaixo.
        const run: RunUser = { ref: { id: newId(), username: '', name: '' }, bot: n.bot, hasEmail: n.emails.length > 0 };
        freshRefs.add(run.ref);
        for (const id of n.importIds) batchIds.set(id, run.ref);
        for (const e of les) if (!this.runByEmail.has(e)) this.runByEmail.set(e, run.ref);
        // Com conflito, o nome do arquivo continua sendo da conta que já existia.
        if (lu && !conflict) this.runByName.set(lu, run);
        fresh.push({ rec, n, base: usernameBase(n), conflict, untrusted, disjoint, notes, run });
      }
    }
    await this.skipRecords(skipped, 'users');

    if (fresh.length) {
      const bases = uniq(fresh.map((f) => f.base.toLowerCase()));
      const inDb = new Set((await many('SELECT lower(username) AS u FROM users WHERE lower(username) = ANY($1::text[])', [bases])).map((r) => r.u));
      for (const { rec, n, base, conflict, untrusted, disjoint, notes, run } of fresh) {
        const lb = base.toLowerCase();
        let username = base;
        if (inDb.has(lb) || this.takenUsernames.has(lb) || RESERVED_USERNAMES.has(lb)) username = await this.uniqueUsername(base);
        else this.takenUsernames.add(lb);
        if (disjoint) notes.push(`${disjoint}; importado como "${username}".`);
        if (conflict) notes.push(`O usuário "${n.username}" ${conflict}; importado como "${username}".`);
        if (untrusted) {
          // Na reimportação, com o e-mail confirmado, handOver passa esta conta para a outra (só entre contas do mesmo tipo).
          const after = untrusted.type === (n.bot ? 'bot' : 'user') ? `: o que foi importado para "${username}" passa para "${untrusted.username}", e "${username}" é desativada` : '';
          notes.push(
            `O e-mail "${untrusted.email}" já é da conta "${untrusted.username}", que não confirmou esse e-mail; importado como "${username}", sem ele. ` +
              `Se a conta "${untrusted.username}" for mesmo desta pessoa, confirme o e-mail dela na administração de usuários e importe de novo${after}.`,
          );
        }
        const le = n.email.toLowerCase();
        // O e-mail já é de outra conta (não confirmada): a conta nova fica sem ele.
        const email = n.email && !this.takenEmails.has(le) && !byEmail.has(le) ? n.email : null;
        if (email) this.takenEmails.add(le);
        const valid = this.importedRoles(n, [], true, notes);
        const roles = n.bot ? uniq(['bot', ...valid.filter((r) => r !== 'user')]) : uniq(['user', ...valid]);
        run.ref.username = username;
        run.ref.name = n.name || nameFromUsername(username);
        const row: NewUserRow = {
          id: run.ref.id,
          username,
          name: run.ref.name,
          email,
          hash: n.passwordHash || (n.password ? await hashPassword(n.password) : null),
          active: n.deleted !== true,
          type: n.bot ? 'bot' : 'user',
          roles,
          bio: n.bio,
          statusText: n.statusText,
        };
        this.runByName.set(username.toLowerCase(), run);
        plans.push({ kind: 'new', rec, n, row, notes });
      }
    }
    plans.push(...later);
    if (!plans.length) return;

    try {
      const fx = await tx((c) => this.execUsers(c, plans));
      await this.afterUsers(plans, fx);
    } catch {
      // Um registro com problema não derruba o lote: tenta um por um.
      for (const p of plans) {
        if (this.stopped()) return;
        try {
          const fx = await tx((c) => this.execUsers(c, [p]));
          await this.afterUsers([p], fx);
        } catch (e) {
          await this.fail(p.rec, 'users', errText(e));
        }
      }
    }
  }

  // Papéis pedidos pelo arquivo: só os papéis globais que existem aqui. Admin só para conta criada agora,
  // e só quando quem importa pode dar esse papel (assign-admin-role); conta que já existe nunca vira admin.
  private importedRoles(n: NormUser, have: string[], isNew: boolean, notes: string[]) {
    const out: string[] = [];
    for (const r of n.roles) {
      if (have.includes(r)) continue;
      const scope = this.roleScopes.get(r);
      const label = truncate(r, 100);
      if (!scope) notes.push(`Papel "${label}" ignorado: não existe aqui.`);
      else if (scope !== 'Users') notes.push(`Papel "${label}" ignorado: vale só dentro de uma sala.`);
      else if (r === 'admin' && !isNew) notes.push('O papel de administrador não foi dado: a conta já existia.');
      else if (r === 'admin' && !this.canGrantAdmin) notes.push('O papel de administrador não foi dado: quem importa não tem a permissão para dar esse papel.');
      else out.push(r);
    }
    return out;
  }

  private async uniqueUsername(base: string): Promise<string> {
    for (let start = 2; ; start += 50) {
      const cands: string[] = [];
      for (let k = start; k < start + 50; k++) cands.push(withSuffix(base, `.${k}`, 40));
      const free = cands.filter((c) => !this.takenUsernames.has(c.toLowerCase()) && !RESERVED_USERNAMES.has(c.toLowerCase()));
      if (!free.length) continue;
      const taken = new Set((await many('SELECT lower(username) AS u FROM users WHERE lower(username) = ANY($1::text[])', [free.map((c) => c.toLowerCase())])).map((r) => r.u));
      const pick = free.find((c) => !taken.has(c.toLowerCase()));
      if (pick) {
        this.takenUsernames.add(pick.toLowerCase());
        return pick;
      }
    }
  }

  private async execUsers(c: Queryable, plans: UserPlan[]): Promise<Effects> {
    const fx: Effects = { refs: new Map(), subs: [], deactivated: [], warnings: [], rooms: [], removed: [] };
    const rows = plans.flatMap((p) => (p.kind === 'new' ? [p.row] : []));
    if (rows.length) {
      await query(
        `INSERT INTO users (id, username, name, email, email_verified, password_hash, active, type, roles, bio, status_text, auth_source, require_password_change)
         SELECT x.id, x.username, x.name, x.email, false, x.hash, x.active, x.type, ARRAY(SELECT jsonb_array_elements_text(x.roles)), x.bio, x.status_text, 'local', false
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::text[], $8::jsonb[], $9::text[], $10::text[])
           AS x(id, username, name, email, hash, active, type, roles, bio, status_text)`,
        [
          rows.map((r) => r.id),
          rows.map((r) => r.username),
          rows.map((r) => r.name),
          rows.map((r) => r.email),
          rows.map((r) => r.hash),
          rows.map((r) => r.active),
          rows.map((r) => r.type),
          rows.map((r) => JSON.stringify(r.roles)),
          rows.map((r) => r.bio),
          rows.map((r) => r.statusText),
        ],
        c,
      );
      fx.subs.push(...(await this.addSubs(c, rows.filter((r) => r.active).flatMap((r) => this.defaultRooms.map((rid) => ({ rid, uid: r.id }))))));
    }
    const avatars: [string, string][] = [];
    for (const p of plans) {
      if (p.kind === 'new') {
        fx.refs.set(p, { id: p.row.id, username: p.row.username, name: p.row.name });
        if (p.n.avatarUrl) avatars.push([p.row.id, p.n.avatarUrl]);
      } else if (p.kind === 'existing') {
        const { ref, avatar } = await this.updateExisting(c, p, fx);
        fx.refs.set(p, ref);
        if (avatar) avatars.push([ref.id, avatar]);
        if (p.handover) await this.handOver(c, p, ref, fx);
      } else {
        // Repetido de um usuário novo que pode ter falhado no mesmo lote.
        if (!(await one('SELECT 1 FROM users WHERE id = $1', [p.ref.id], c))) throw new Error('Usuário repetido no arquivo, e a primeira ocorrência falhou.');
        fx.refs.set(p, p.ref);
      }
    }
    await this.mapIds(
      c,
      'user',
      plans.flatMap((p) => p.n.importIds.map((i): [string, string] => [i, fx.refs.get(p)!.id])),
    );
    // Contas criadas agora: para que ids da origem (uma lista de membros ou um CSV só desativa as contas que criou) e
    // com que e-mail (vale como confiável nas próximas importações enquanto a conta não o trocar).
    const created = plans.flatMap((p) => (p.kind === 'new' ? [p] : []));
    await this.mapIds(c, 'user-created', created.flatMap((p) => p.n.importIds.map((i): [string, string] => [i, p.row.id])));
    await this.mapIds(c, 'user-email', created.flatMap((p) => (p.row.email ? [[p.row.email.toLowerCase(), p.row.id] as [string, string]] : [])));
    if (avatars.length) {
      await query(
        `INSERT INTO import_pending_avatars (user_id, url) SELECT * FROM unnest($1::text[], $2::text[])
         ON CONFLICT (user_id) DO UPDATE SET url = EXCLUDED.url, status = 'pending', error = NULL, attempts = 0, updated_at = now()`,
        [avatars.map((a) => a[0]), avatars.map((a) => a[1])],
        c,
      );
    }
    return fx;
  }

  // Conta que já existe: nunca troca nome de usuário, e-mail nem senha; só completa o que está vazio e acrescenta papéis.
  private async updateExisting(c: Queryable, p: Extract<UserPlan, { kind: 'existing' }>, fx: Effects) {
    const u = await one('SELECT * FROM users WHERE id = $1 FOR UPDATE', [p.userId], c);
    if (!u) throw new Error('Usuário não encontrado.');
    const n = p.n;
    const sets: string[] = [];
    const params: unknown[] = [u.id];
    const rename = !!n.name && n.name !== u.name && (!u.name || String(u.name).toLowerCase() === String(u.username).toLowerCase());
    if (rename) sets.push(`name = $${params.push(n.name)}`);
    if (n.bio && !u.bio) sets.push(`bio = $${params.push(n.bio)}`);
    if (n.statusText && !u.status_text) sets.push(`status_text = $${params.push(n.statusText)}`);
    const notes: string[] = [];
    const add = this.importedRoles(n, u.roles, false, notes);
    if (add.length) sets.push(`roles = $${params.push([...u.roles, ...add])}`);
    if (n.deleted === true && u.active) {
      // Só desativa a conta ligada a esta mesma origem por uma importação anterior (lista de membros e CSV: só a que
      // uma importação desta origem criou, porque o id deles é o e-mail ou o nome); nunca quem importa nem o último admin.
      let why = '';
      if (u.id === this.actor.userId) why = 'A conta não foi desativada: é a de quem está fazendo a importação.';
      else if (this.createdOnly && !(await this.createdFor(c, n.importIds, u.id)))
        why = 'A conta não foi desativada: ela não foi criada por uma importação desta origem, e este tipo de arquivo só desativa as contas que ele mesmo criou.';
      else if (!this.createdOnly && !p.viaMap) why = 'A conta não foi desativada: ela foi encontrada pelo e-mail ou pelo nome de usuário, e não por uma importação anterior desta origem.';
      else if (u.roles.includes('admin') && !(await this.otherHumanAdmins(c, u.id))) why = 'A conta não foi desativada: é a do último administrador ativo.';
      if (why) notes.push(why);
      else {
        sets.push('active = false');
        fx.deactivated.push(u.id);
      }
    }
    for (const msg of notes) fx.warnings.push({ id: p.rec.id, msg });
    if (sets.length) {
      sets.push('updated_at = now()');
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params, c);
    }
    if (rename) await query('UPDATE messages SET user_name = $2 WHERE user_id = $1', [u.id, n.name], c);
    return { ref: { id: u.id, username: u.username, name: rename ? n.name : (u.name ?? '') }, avatar: n.avatarUrl && !u.avatar_etag ? n.avatarUrl : '' };
  }

  // Contas que uma importação desta mesma origem (o mesmo importador) criou para estes ids: um id igual vindo de outra
  // origem (o e-mail, por exemplo) não dá a esta o direito de desativar ou passar adiante a conta.
  private async createdRows(c: Queryable, ids: string[], userId?: string): Promise<{ import_id: string; target_id: string }[]> {
    if (!ids.length) return [];
    return many(
      `SELECT m.import_id, m.target_id FROM import_map m JOIN import_operations o ON o.id = m.operation_id
       WHERE m.kind = 'user-created' AND m.import_id = ANY($1::text[]) AND o.importer_key = $2 AND ($3::text IS NULL OR m.target_id = $3)`,
      [ids, this.importerKey, userId ?? null],
      c,
    );
  }

  private async createdFor(c: Queryable, ids: string[], userId: string) {
    return (await this.createdRows(c, ids, userId)).length > 0;
  }

  // A conta provisória (criada por uma importação desta origem sem o e-mail, que era de uma conta que ainda não o tinha
  // confirmado) é desta pessoa: as mensagens, as salas, as conversas diretas e as ligações da importação passam para a
  // conta certa, e a provisória é desativada. Sem isso, confirmar o e-mail e importar de novo deixaria o histórico com ela.
  private async handOver(c: Queryable, p: Extract<UserPlan, { kind: 'existing' }>, to: UserRef, fx: Effects) {
    const from = p.handover!;
    const rooms = new Set<string>();
    const add = (r: { rows: { room_id: string }[] }) => r.rows.forEach((x) => rooms.add(x.room_id));
    add(
      await query(
        `WITH m AS (UPDATE messages SET user_id = $2, username = $3, user_name = $4 WHERE user_id = $1 RETURNING room_id) SELECT DISTINCT room_id FROM m`,
        [from.id, to.id, to.username, to.name],
        c,
      ),
    );
    // Salas (menos conversas diretas): a assinatura passa para a conta certa; se ela já está na sala, ganha os papéis.
    await query(
      `UPDATE subscriptions o SET roles = ARRAY(SELECT DISTINCT x FROM unnest(o.roles || s.roles) x), updated_at = now()
       FROM subscriptions s JOIN rooms r ON r.id = s.room_id
       WHERE s.user_id = $1 AND o.user_id = $2 AND o.room_id = s.room_id AND r.t <> 'd' AND NOT (o.roles @> s.roles)`,
      [from.id, to.id],
      c,
    );
    add(
      await query(
        `DELETE FROM subscriptions s USING rooms r
         WHERE r.id = s.room_id AND r.t <> 'd' AND s.user_id = $1 AND EXISTS (SELECT 1 FROM subscriptions o WHERE o.room_id = s.room_id AND o.user_id = $2)
         RETURNING s.room_id`,
        [from.id, to.id],
        c,
      ),
    );
    const subs = await query<SubRow>(
      `UPDATE subscriptions s SET user_id = $2, updated_at = now() FROM rooms r WHERE r.id = s.room_id AND r.t <> 'd' AND s.user_id = $1 RETURNING s.id, s.room_id, s.user_id`,
      [from.id, to.id],
      c,
    );
    fx.subs.push(...subs.rows);
    add(subs);
    await query('INSERT INTO team_members (team_id, user_id, roles) SELECT team_id, $2, roles FROM team_members WHERE user_id = $1 ON CONFLICT DO NOTHING', [from.id, to.id], c);
    await query('DELETE FROM team_members WHERE user_id = $1', [from.id], c);
    // Conversas diretas: a mesma conversa, agora com a conta certa. Se ela já existe aqui, as duas viram uma só.
    const dms = await many(`SELECT r.* FROM subscriptions s JOIN rooms r ON r.id = s.room_id WHERE s.user_id = $1 AND r.t = 'd' FOR UPDATE OF r`, [from.id], c);
    for (const r of dms) {
      const uids = uniq((r.uids as string[]).map((u) => (u === from.id ? to.id : u))).sort();
      const key = uids.join(',');
      const into = await one(`SELECT id FROM rooms WHERE t = 'd' AND dm_key = $1 AND id <> $2 FOR UPDATE`, [key, r.id], c);
      if (into) {
        const before = await many('SELECT * FROM subscriptions WHERE room_id = $1', [r.id], c);
        await this.mergeDirect(c, r.id, into.id);
        fx.removed.push({ room: r, subs: before });
        rooms.delete(r.id);
        rooms.add(into.id);
        continue;
      }
      const names = (await many('SELECT username FROM users WHERE id = ANY($1::text[])', [uids], c)).map((x) => x.username as string).sort();
      await query(
        `UPDATE rooms SET uids = $2, usernames = $3, dm_key = $4, users_count = $5, owner_id = CASE WHEN owner_id = $6 THEN $7 ELSE owner_id END, updated_at = now() WHERE id = $1`,
        [r.id, uids, names, key, uids.length, from.id, to.id],
        c,
      );
      // Conversa entre a provisória e a conta certa: vira a conversa da pessoa consigo mesma.
      await query('DELETE FROM subscriptions WHERE room_id = $1 AND user_id = $2 AND EXISTS (SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $3)', [r.id, from.id, to.id], c);
      const moved = await query<SubRow>('UPDATE subscriptions SET user_id = $3, updated_at = now() WHERE room_id = $1 AND user_id = $2 RETURNING id, room_id, user_id', [r.id, from.id, to.id], c);
      fx.subs.push(...moved.rows);
      rooms.add(r.id);
    }
    const rids = [...rooms];
    await query('UPDATE rooms SET owner_id = $2 WHERE owner_id = $1 AND id = ANY($3::text[])', [from.id, to.id, rids], c);
    await query(`UPDATE messages SET edited_by = jsonb_build_object('_id', $2::text, 'username', $3::text) WHERE room_id = ANY($4::text[]) AND edited_by->>'_id' = $1`, [from.id, to.id, to.username, rids], c);
    await query('UPDATE files SET user_id = $2 WHERE user_id = $1 AND room_id = ANY($3::text[])', [from.id, to.id, rids], c);
    await query('UPDATE import_pending_files SET user_id = $2 WHERE user_id = $1 AND room_id = ANY($3::text[])', [from.id, to.id, rids], c);
    // Outros ids ligados à provisória também passam a ser desta conta.
    await query(`UPDATE import_map SET target_id = $2 WHERE kind = 'user' AND target_id = $1`, [from.id, to.id], c);
    for (const [id, ref] of this.users) if (ref.id === from.id) this.users.set(id, to);
    fx.rooms.push(...rids);

    const label = truncate(p.n.username || p.n.email, 100);
    let msg =
      `O usuário "${label}" estava ligado à conta "${from.username}", que uma importação anterior criou sem o e-mail; agora fica com a conta "${to.username}", dona do e-mail confirmado. ` +
      `As mensagens, as salas e as conversas diretas de "${from.username}" passaram para "${to.username}"`;
    const u = await one('SELECT active, roles FROM users WHERE id = $1 FOR UPDATE', [from.id], c);
    if (u?.active && u.roles.includes('admin') && !(await this.otherHumanAdmins(c, from.id))) msg += `; "${from.username}" não foi desativada: é a do último administrador ativo.`;
    else {
      if (u?.active) {
        await query('UPDATE users SET active = false, updated_at = now() WHERE id = $1', [from.id], c);
        fx.deactivated.push(from.id);
      }
      msg += u?.active ? `, e "${from.username}" foi desativada.` : `; "${from.username}" já estava desativada.`;
    }
    fx.warnings.push({ id: p.rec.id, msg });
  }

  // A mesma conversa direta em duas salas: tudo da sala antiga vai para a que já existe, e a antiga sai.
  private async mergeDirect(c: Queryable, rid: string, into: string) {
    for (const table of ['messages', 'files', 'import_pending_files', 'message_reads', 'message_history', 'calls', 'moderation_reports'])
      await query(`UPDATE ${table} SET room_id = $2 WHERE room_id = $1`, [rid, into], c);
    await query('UPDATE rooms SET prid = $2 WHERE prid = $1', [rid, into], c);
    await query(`UPDATE import_map SET target_id = $2 WHERE kind IN ('room', 'room-created') AND target_id = $1`, [rid, into], c);
    await query('DELETE FROM rooms WHERE id = $1', [rid], c);
  }

  // Administradores que ainda conseguem entrar: pessoas (não bots), ativas, com senha ou com login externo.
  private async otherHumanAdmins(c: Queryable, exceptId: string) {
    const r = await one(
      `SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND active AND type = 'user' AND (password_hash IS NOT NULL OR auth_source <> 'local') AND id <> $1`,
      [exceptId],
      c,
    );
    return r!.n as number;
  }

  private async afterUsers(plans: UserPlan[], fx: Effects) {
    for (const p of plans) {
      for (const msg of p.notes) await markRecordError(p.rec.id, msg);
      const ref = fx.refs.get(p)!;
      for (const id of p.n.importIds) this.users.set(id, ref);
      if (p.kind === 'new') {
        this.result.users.inserted++;
        this.result.newUserIds.push(p.row.id);
        this.newUsers.push({ id: p.row.id, email: p.row.email, bot: p.row.type === 'bot', active: p.row.active });
      } else this.result.users.updated++;
    }
    this.sink.inc({ completed: plans.length });
    this.rememberSubs(fx.subs);
    // Salas que a passagem de uma conta provisória mexeu: contadores, threads e última mensagem são recalculados no fim.
    for (const rid of fx.rooms) this.msgRooms.add(rid);
    for (const w of fx.warnings) await markRecordError(w.id, w.msg);
    for (const id of fx.deactivated) await revokeAllSessions(id).catch(() => 0);
    for (const { room, subs } of fx.removed) {
      try {
        for (const s of subs) {
          bus.leaveRoom(s.user_id, room.id);
          bus.publish({ user: s.user_id }, { type: 'subscription', action: 'removed', subscription: await buildSubscription(s, room) });
        }
      } catch {
        // Só conveniência: quem recarregar já não vê a conversa juntada.
      }
    }
  }

  // ---------- Contatos ----------

  private async convertContacts() {
    await this.sink.step(ST.importingContacts);
    const fields = new Set((await many(`SELECT id FROM livechat_custom_fields WHERE scope = 'visitor'`)).map((r) => r.id));
    let seq = (await one('SELECT count(*)::int AS n FROM livechat_visitors'))!.n;
    const sel = selector(this.sel.contacts);
    for await (const batch of iterateStaged<ImportContact>(this.opId, 'contact', BATCH)) {
      if (this.stopped()) return;
      const chosen = await this.pick(batch, (r) => sel(r.importId ?? r.data.importIds?.[0]), 'contacts');
      if (!chosen.length) continue;
      const norm = chosen.map((r) => {
        const d = r.data ?? ({} as ImportContact);
        // "-", "n/a" e afins não são e-mail: nem acham o contato que já existe, nem vão para importedEmails.
        const emails = uniq((Array.isArray(d.emails) ? d.emails : []).map((e) => str(e, EMAIL_CUT)).filter(validEmail));
        const phones = uniq((Array.isArray(d.phones) ? d.phones : []).map((e) => str(e, 60)).filter(Boolean));
        return {
          ids: uniq((Array.isArray(d.importIds) ? d.importIds : []).filter((x) => x !== null && x !== undefined && x !== '').map(String)),
          name: str(d.name, 120),
          emails,
          phones,
          email: emails[0] ?? null,
          manager: str(d.manager, 100).replace(/^@+/, ''),
          custom: d.customFields && typeof d.customFields === 'object' ? d.customFields : {},
        };
      });
      const byMap = new Map(
        (
          await many(`SELECT m.import_id, v.* FROM import_map m JOIN livechat_visitors v ON v.id = m.target_id WHERE m.kind = 'contact' AND m.import_id = ANY($1::text[])`, [
            uniq(norm.flatMap((n) => n.ids)),
          ])
        ).map((r) => [r.import_id, r]),
      );
      const byEmail = new Map<string, any>();
      for (const r of await many('SELECT * FROM livechat_visitors WHERE lower(email) = ANY($1::text[]) ORDER BY created_at', [
        uniq(norm.map((n) => n.email?.toLowerCase()).filter(Boolean) as string[]),
      ]))
        if (!byEmail.has(String(r.email).toLowerCase())) byEmail.set(String(r.email).toLowerCase(), r);
      const managers = new Map(
        (await many('SELECT username FROM users WHERE lower(username) = ANY($1::text[])', [uniq(norm.map((n) => n.manager.toLowerCase()).filter(Boolean))])).map((r) => [
          String(r.username).toLowerCase(),
          r.username as string,
        ]),
      );
      for (let i = 0; i < chosen.length; i++) {
        if (this.stopped()) return;
        const rec = chosen[i];
        const n = norm[i];
        try {
          if (!n.name && !n.emails.length && !n.phones.length) throw new Error('Contato sem nome, e-mail e telefone.');
          // Só campos personalizados de contato cadastrados aqui; os outros são descartados.
          const custom: Record<string, string> = {};
          for (const [k, v] of Object.entries(n.custom)) {
            const s = str(typeof v === 'number' ? String(v) : v, 1000);
            if (fields.has(k) && s) custom[k] = s;
          }
          const extraEmails = n.emails.filter((e) => e !== n.email);
          if (extraEmails.length) custom.importedEmails = extraEmails.join('; ');
          if (n.phones.length > 1) custom.importedPhones = n.phones.slice(1).join('; ');
          const manager = n.manager ? managers.get(n.manager.toLowerCase()) : undefined;
          if (manager) custom.contactManager = manager;
          const found = n.ids.map((id) => byMap.get(id)).find(Boolean) ?? (n.email ? byEmail.get(n.email.toLowerCase()) : undefined);
          let id: string;
          if (found) {
            id = found.id;
            await query(
              `UPDATE livechat_visitors SET name = CASE WHEN name = '' THEN $2 ELSE name END, email = coalesce(email, $3), phone = coalesce(phone, $4),
                 custom_fields = $5::jsonb || custom_fields, updated_at = now() WHERE id = $1`,
              [id, n.name, n.email, n.phones[0] ?? null, JSON.stringify(custom)],
            );
          } else {
            seq++;
            id = newId();
            const row = await one(
              `INSERT INTO livechat_visitors (id, token, username, name, email, phone, custom_fields) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [
                id,
                randomToken(),
                `guest-${seq}-${randomToken(3).replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase()}`,
                n.name || `Visitante ${seq}`,
                n.email,
                n.phones[0] ?? null,
                JSON.stringify(custom),
              ],
            );
            if (n.email) byEmail.set(n.email.toLowerCase(), row);
            for (const x of n.ids) byMap.set(x, row);
            this.result.contacts.inserted++;
          }
          await this.mapIds(pool, 'contact', n.ids.map((x): [string, string] => [x, id]));
          this.sink.inc({ completed: 1 });
        } catch (e) {
          await this.fail(rec, 'contacts', errText(e));
        }
      }
    }
  }

  // ---------- Salas ----------

  private async convertChannels() {
    await this.sink.step(ST.importingChannels);
    const sel = selector(this.sel.channels);
    const directs = sel(DIRECT_MESSAGES_ID);
    const forget = (c: ImportChannel) => (c?.importIds ?? []).forEach((id) => id && this.skippedRooms.add(String(id)));
    await this.scanFileRooms();
    for await (const batch of iterateStaged<ImportChannel>(this.opId, 'channel', BATCH)) {
      if (this.stopped()) return;
      const chosen = await this.pick(batch, (r) => (r.data?.t === 'd' ? directs : sel(r.importId ?? r.data?.importIds?.[0])), 'channels', (r) => forget(r.data));
      await this.resolveUsers(uniq(chosen.flatMap((r) => [...(Array.isArray(r.data?.users) ? r.data.users : []), r.data?.creator].filter(Boolean).map(String))));
      for (const rec of chosen) {
        if (this.stopped()) return;
        try {
          const isNew = await this.channelRecord(rec.data ?? ({} as ImportChannel), rec.id);
          this.result.channels[isNew ? 'inserted' : 'updated']++;
          this.sink.inc({ completed: 1 });
        } catch (e) {
          forget(rec.data);
          await this.fail(rec, 'channels', errText(e));
        }
      }
    }
  }

  private async mappedRoom(ids: string[]) {
    return one(`SELECT r.* FROM import_map m JOIN rooms r ON r.id = m.target_id WHERE m.kind = 'room' AND m.import_id = ANY($1::text[]) LIMIT 1`, [ids]);
  }

  // Ids desta origem para os quais uma importação criou a sala (import_map kind 'room-created': id da origem → sala).
  // Um canal ligado à sala só pelo nome não entra aqui: a sala continua sendo do canal que a criou.
  private async creatorsOf(ids: string[], rid: string): Promise<string[]> {
    const rows = await many(`SELECT import_id FROM import_map WHERE kind = 'room-created' AND import_id = ANY($1::text[]) AND target_id = $2`, [ids, rid]);
    return rows.map((r) => r.import_id);
  }

  private async scanFileRooms() {
    const rows = await many(
      `SELECT m.import_id, m.target_id, rc.import_id IS NOT NULL AS created
       FROM import_map m
       LEFT JOIN import_map rc ON rc.kind = 'room-created' AND rc.import_id = m.import_id AND rc.target_id = m.target_id
       WHERE m.kind = 'room' AND m.import_id IN (
         SELECT x.v FROM import_records r
         CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.data->'importIds') = 'array' THEN r.data->'importIds' ELSE '[]'::jsonb END) AS x(v)
         WHERE r.operation_id = $1 AND r.data_type = 'channel' AND coalesce(r.data->>'t', '') <> 'd')`,
      [this.opId],
    );
    for (const r of rows) {
      this.fileRooms.add(r.target_id);
      if (r.created) this.fileCreators.set(r.target_id, (this.fileCreators.get(r.target_id) ?? new Set<string>()).add(r.import_id));
    }
  }

  private useRoom(rid: string, ids: string[]) {
    const used = this.runRooms.get(rid) ?? new Set<string>();
    ids.forEach((i) => used.add(i));
    this.runRooms.set(rid, used);
  }

  private setRoom(ids: string[], room: any) {
    const ref = roomRef(room);
    for (const id of ids) {
      this.rooms.set(id, ref);
      this.missingRooms.delete(id);
    }
  }

  private async channelRecord(c: ImportChannel, recId: number): Promise<boolean> {
    const ids = uniq((Array.isArray(c.importIds) ? c.importIds : []).filter((x) => x !== null && x !== undefined && x !== '').map(String));
    if (!ids.length) throw new Error('Sala sem id de importação.');
    const t = c.t === 'p' ? 'p' : c.t === 'd' ? 'd' : 'c';
    const memberIds = uniq((Array.isArray(c.users) ? c.users : []).filter(Boolean).map(String));
    const created = timeOf(c.ts);
    if (t === 'd') return this.directRecord(ids, memberIds, created, recId);

    const name = str(c.name, 500);
    if (!name) throw new Error('Sala sem nome.');
    const topic = str(c.topic, 2000);
    const description = str(c.description, 2000);
    const members = [...new Map(memberIds.flatMap((id) => (this.users.has(id) ? [[this.users.get(id)!.id, this.users.get(id)!] as const] : []))).values()];
    const creator = c.creator ? this.users.get(String(c.creator)) : undefined;
    const slug = sanitizeRoomName(name);

    // Sala existente: canal padrão, importação anterior desta mesma origem (import_map, só com o mesmo tipo) ou canal
    // público com o mesmo nome. Membros e arquivamento só no canal padrão ou numa sala que uma importação criou para estes
    // mesmos ids.
    let room: any = null;
    let owned = false;
    let isDefault = false;
    let lockedGroup = false;
    let lost: string | null = null;
    let otherType: { name: string; t: string } | null = null;
    // Canal padrão é público: um grupo privado nunca cai nele.
    if (c.isDefault && t === 'c') {
      room = await one(`SELECT * FROM rooms WHERE is_default AND t = 'c' ORDER BY created_at LIMIT 1`);
      owned = isDefault = !!room;
    }
    if (!room) {
      const prev = await this.mappedRoom(ids);
      // Ligada antes, mas hoje de outro tipo (o canal virou privado na origem, ou a sala virou privada aqui): outra sala,
      // senão o conteúdo privado ficaria num canal público, ou os membros da origem entrariam num grupo fechado.
      if (prev && (prev.t === 'c' || prev.t === 'p') && !prev.prid && prev.t !== t) otherType = { name: String(prev.name ?? ''), t: prev.t };
      else if (prev && (prev.t === 'c' || prev.t === 'p') && !prev.prid) {
        const creators = await this.creatorsOf(ids, prev.id);
        // Ligada antes só pelo nome: perde a sala para o canal deste arquivo que a criou ou que já a usou aqui.
        const used = this.runRooms.get(prev.id);
        const taken = !creators.length && (this.fileCreators.has(prev.id) || (!!used && !ids.some((i) => used.has(i))));
        if (taken) lost = String(prev.name ?? '');
        else {
          room = prev;
          // Grupo privado que já existia e só foi reconhecido por um id de CSV (o nome): ninguém entra nem arquiva.
          lockedGroup = prev.t === 'p' && !!creators.length && creators.every(nameOnlyId) && !this.createdRooms.has(prev.id);
          owned = !!creators.length && !lockedGroup;
        }
      }
    }
    if (!room && lost === null && !otherType && slug && t === 'c') {
      // Só pelo nome: junta as mensagens a um canal público, sem acrescentar membros nem arquivar. Grupo privado nunca
      // (abriria o histórico dele), nem sala de outro canal deste arquivo (já usada aqui ou ligada a ele pelo import_map):
      // nesses casos cria outra sala.
      const same = await one(`SELECT * FROM rooms WHERE lower(name) = lower($1) AND prid IS NULL AND t IN ('c','p')`, [slug]);
      if (same?.t === 'c' && !this.runRooms.has(same.id) && !this.fileRooms.has(same.id)) room = same;
    }
    if (room) {
      this.useRoom(room.id, ids);
      const subs = await tx(async (cl) => {
        if (topic || description) {
          await query(
            `UPDATE rooms SET topic = CASE WHEN $2 <> '' THEN $2 ELSE topic END, description = CASE WHEN $3 <> '' THEN $3 ELSE description END, updated_at = now() WHERE id = $1`,
            [room.id, topic, description],
            cl,
          );
        }
        let rows: SubRow[] = [];
        if (owned) rows = await this.addSubs(cl, members.map((u) => ({ rid: room.id, uid: u.id, open: !room.archived })));
        if (owned && !isDefault && c.archived && !room.archived) await this.archive(cl, room.id);
        await this.mapIds(cl, 'room', ids.map((i): [string, string] => [i, room.id]));
        return rows;
      });
      this.rememberSubs(subs);
      this.setRoom(ids, room);
      if (lockedGroup && members.length) {
        const inside = new Set((await many('SELECT user_id FROM subscriptions WHERE room_id = $1 AND user_id = ANY($2::text[])', [room.id, members.map((u) => u.id)])).map((r) => r.user_id));
        const out = members.filter((u) => !inside.has(u.id)).length;
        if (out) {
          const who = out === 1 ? '1 pessoa do arquivo não foi adicionada' : `${out} pessoas do arquivo não foram adicionadas`;
          const why = 'no CSV o grupo é reconhecido só pelo nome, e isso não basta para pôr alguém num grupo que já existe';
          await markRecordError(recId, `${who} ao grupo privado "${room.name}": ${why}. Adicione pela própria sala quem precisar.`);
        }
      }
      return false;
    }

    const finalName = slug ? await this.uniqueRoomName(slug, false) : await this.uniqueRoomName('sala', true);
    const renamed = !!slug && finalName.toLowerCase() !== slug.toLowerCase();
    const owner = creator ?? this.importer ?? members[0] ?? null;
    const all = uniq([...(owner ? [owner] : []), ...members].map((u) => u.id));
    const id = newId();
    const subs = await tx(async (cl) => {
      await query(
        `INSERT INTO rooms (id, t, name, fname, topic, description, owner_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()), now())`,
        [id, t, finalName, name, topic, description, owner?.id ?? null, created ? iso(created) : null],
        cl,
      );
      const rows = await this.addSubs(cl, all.map((uid) => ({ rid: id, uid, owner: uid === owner?.id, open: !c.archived })));
      await query('UPDATE rooms SET users_count = $2 WHERE id = $1', [id, rows.length], cl);
      if (c.archived) await this.archive(cl, id);
      await this.mapIds(cl, 'room', ids.map((i): [string, string] => [i, id]));
      await this.mapIds(cl, 'room-created', ids.map((i): [string, string] => [i, id]));
      return rows;
    });
    this.createdRooms.add(id);
    this.useRoom(id, ids);
    if (lost !== null) await markRecordError(recId, `O canal "${truncate(name, 100)}" estava ligado à sala "${lost}", que é de outro canal deste arquivo; importado como "${finalName}".`);
    else if (otherType) {
      const was = otherType.t === 'p' ? 'um grupo privado' : 'um canal público';
      const is = t === 'p' ? 'privado' : 'público';
      await markRecordError(recId, `O canal "${truncate(name, 100)}" estava ligado à sala "${otherType.name}", que hoje é ${was}, e no arquivo ele é ${is}; importado como "${finalName}".`);
    } else if (renamed) await markRecordError(recId, `Já existe uma sala com o nome "${slug}"; importada como "${finalName}".`);
    if (t === 'c') this.publicRooms.push(id);
    this.memberRooms.add(id);
    this.rememberSubs(subs);
    this.setRoom(ids, { id, t, name: finalName });
    return true;
  }

  private async archive(c: Queryable, rid: string) {
    await query('UPDATE rooms SET archived = true, updated_at = now() WHERE id = $1', [rid], c);
    await query('UPDATE subscriptions SET open = false, alert = false, updated_at = now() WHERE room_id = $1', [rid], c);
  }

  private async uniqueRoomName(base: string, numbered: boolean): Promise<string> {
    for (let start = numbered ? 1 : 2, first = !numbered; ; start += 50, first = false) {
      const cands: string[] = first ? [base] : [];
      for (let k = start; k < start + 50; k++) cands.push(withSuffix(base, `-${k}`, 64));
      const free = cands.filter((c) => !this.takenRoomNames.has(c.toLowerCase()));
      if (!free.length) continue;
      const taken = new Set(
        (await many(`SELECT lower(name) AS n FROM rooms WHERE t IN ('c','p') AND prid IS NULL AND lower(name) = ANY($1::text[])`, [free.map((c) => c.toLowerCase())])).map((r) => r.n),
      );
      const pick = free.find((c) => !taken.has(c.toLowerCase()));
      if (pick) {
        this.takenRoomNames.add(pick.toLowerCase());
        return pick;
      }
    }
  }

  private async directRecord(ids: string[], memberIds: string[], created: number | null, recId: number): Promise<boolean> {
    if (!memberIds.length) throw new Error('Mensagem direta sem participantes.');
    const missing = memberIds.find((id) => !this.users.has(id));
    if (missing) throw new Error(`Mensagem direta com usuário não importado: ${missing}`);
    const members = [...new Map(memberIds.map((id) => [this.users.get(id)!.id, this.users.get(id)!])).values()];
    const uids = members.map((u) => u.id).sort();
    const key = uids.join(',');
    // A conversa ligada por uma importação anterior só vale com as mesmas pessoas: o id de uma DM do CSV é feito de
    // nomes, e o mesmo nome pode ser hoje outra pessoa. Senão vai para a conversa entre as pessoas de agora.
    let room: any = await this.mappedRoom(ids);
    const moved = !!room && (room.t !== 'd' || [...(room.uids ?? [])].sort().join(',') !== key);
    if (moved || !room) room = await one(`SELECT * FROM rooms WHERE t = 'd' AND dm_key = $1`, [key]);
    let isNew = false;
    const subs = await tx(async (cl) => {
      if (!room) {
        const ins = await one(
          `INSERT INTO rooms (id, t, uids, usernames, owner_id, users_count, dm_key, created_at, updated_at)
           VALUES ($1,'d',$2,$3,$4,$5,$6, coalesce($7::timestamptz, now()), now())
           ON CONFLICT (dm_key) WHERE t = 'd' DO NOTHING RETURNING *`,
          [newId(), uids, members.map((u) => u.username).sort(), members[0].id, uids.length, key, created ? iso(created) : null],
          cl,
        );
        // Corrida com a mesma DM criada agora por outra pessoa: usa a que já existe.
        room = ins ?? (await one(`SELECT * FROM rooms WHERE t = 'd' AND dm_key = $1`, [key], cl));
        isNew = !!ins;
      }
      const rows = await this.addSubs(cl, (room.uids as string[]).map((uid) => ({ rid: room.id, uid })));
      await this.mapIds(cl, 'room', ids.map((i): [string, string] => [i, room.id]));
      return rows;
    });
    if (isNew) this.createdRooms.add(room.id);
    this.rememberSubs(subs);
    this.setRoom(ids, room);
    if (moved) {
      const names = members.map((u) => u.username).sort();
      const who = truncate(names.slice(0, 10).join(', ') + (names.length > 10 ? ` e mais ${names.length - 10}` : ''), 500);
      await markRecordError(
        recId,
        `A sala ligada a esta conversa direta por uma importação anterior não é a conversa entre ${who}; esta importação usa a conversa entre essas pessoas, ` +
          'e as mensagens importadas antes continuam na sala antiga.',
      );
    }
    return isNew;
  }

  // ---------- Mensagens ----------

  private async convertMessages() {
    await this.sink.step(ST.importingMessages);
    for await (const batch of iterateStaged<ImportMessage>(this.opId, 'message', BATCH)) {
      if (this.stopped()) return;
      await this.messageBatch(batch);
    }
  }

  private nextClock() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  private async lookupMessages(importIds: string[]) {
    const out = new Map<string, KnownMessage>();
    if (!importIds.length) return out;
    const rows = await many(
      `SELECT m.import_id, g.id, g.room_id, g.user_id, g.tmid, g.attachments FROM import_map m JOIN messages g ON g.id = m.target_id
       WHERE m.kind = 'message' AND m.import_id = ANY($1::text[])`,
      [importIds],
    );
    for (const r of rows) out.set(r.import_id, { id: r.id, roomId: r.room_id, userId: r.user_id, tmid: r.tmid, attachments: r.attachments ?? [] });
    return out;
  }

  private async messageBatch(batch: StagedRecord<ImportMessage>[]) {
    const roomIds = new Set<string>();
    const userIds = new Set<string>();
    const refs = new Set<string>();
    const msgIds = new Set<string>();
    const scan = (s: unknown) => {
      if (typeof s !== 'string' || !s.includes('\u0001')) return;
      for (const t of s.matchAll(TOKEN_RE)) (t[1] === '@' ? userIds : refs).add(t[2]);
    };
    for (const { data: m } of batch) {
      if (!m || typeof m !== 'object') continue;
      if (m.rid) roomIds.add(String(m.rid));
      if (m.u) userIds.add(String(m.u));
      if (m.editedBy) userIds.add(String(m.editedBy));
      if (m.reactions && typeof m.reactions === 'object') for (const list of Object.values(m.reactions)) if (Array.isArray(list)) list.forEach((id) => userIds.add(String(id)));
      scan(m.msg);
      if (Array.isArray(m.attachments)) for (const a of m.attachments as any[]) if (a) [a.text, a.pretext, a.title, ...(Array.isArray(a.fields) ? a.fields.map((f: any) => f?.value) : [])].forEach(scan);
      if (m.importId) msgIds.add(String(m.importId));
      if (m.tmid) msgIds.add(String(m.tmid));
    }
    await this.resolveRooms([...roomIds]);
    await this.resolveUsers([...userIds]);
    await this.resolveRoomRefs([...refs]);
    const known = await this.lookupMessages([...msgIds]);

    const plans: MsgPlan[] = [];
    const skipped: StagedRecord<ImportMessage>[] = [];
    const inBatch = new Map<string, { id: string; roomId: string; tmid: string | null }>();
    for (const rec of batch) {
      try {
        const p = this.planMessage(rec, known, inBatch);
        if (p) plans.push(p);
        else skipped.push(rec);
      } catch (e) {
        await this.fail(rec, 'messages', errText(e));
      }
    }
    await this.skipRecords(skipped, 'messages');
    if (!plans.length) return;

    await this.computeMentions(plans);
    // Arquivos já baixados numa importação anterior não voltam a ser marcadores.
    const updates = plans.filter((p) => p.kind === 'update' && p.files.length);
    if (updates.length) {
      const done = new Set(
        (await many(`SELECT message_id, source_file_id FROM import_pending_files WHERE message_id = ANY($1::text[]) AND status = 'downloaded'`, [updates.map((p) => p.id)])).map(
          (r) => `${r.message_id}/${r.source_file_id}`,
        ),
      );
      for (const p of updates) p.files = p.files.filter((f) => !done.has(`${p.id}/${f.id}`));
    }
    const byRoom = new Map<string, MsgPlan[]>();
    for (const p of plans) if (p.kind === 'insert') byRoom.set(p.roomId, [...(byRoom.get(p.roomId) ?? []), p]);
    for (const [rid, list] of byRoom) await this.reserveTimes(rid, list);

    try {
      await tx((c) => this.writeMessages(c, plans));
      this.afterMessages(plans);
    } catch {
      const failed = new Set<string>();
      for (const p of plans) {
        // Resposta cuja mensagem raiz falhou neste lote vira mensagem comum.
        if (p.tmid && failed.has(p.tmid)) {
          p.tmid = null;
          p.tshow = false;
        }
        try {
          await tx((c) => this.writeMessages(c, [p]));
          this.afterMessages([p]);
        } catch (e) {
          failed.add(p.id);
          await this.fail(p.rec, 'messages', errText(e));
        }
      }
    }
  }

  private planMessage(rec: StagedRecord<ImportMessage>, known: Map<string, KnownMessage>, inBatch: Map<string, { id: string; roomId: string; tmid: string | null }>): MsgPlan | null {
    const m = rec.data ?? ({} as ImportMessage);
    const rid = String(m.rid ?? '');
    const room = this.rooms.get(rid);
    if (!room) {
      if (this.skippedRooms.has(rid)) return null;
      throw new Error(`Sala não encontrada: ${rid}`);
    }
    const uid = String(m.u ?? '');
    const author = this.users.get(uid);
    if (!author) throw new Error(`Autor não encontrado: ${uid}`);
    const importId = m.importId ? String(m.importId) : null;
    // Repetida no mesmo lote: já está sendo importada.
    if (importId && inBatch.has(importId)) return null;
    const prev = importId ? known.get(importId) : undefined;
    // Mensagem importada antes que hoje é de outra pessoa, ou que está em outra sala (a do canal mudou: virou privado,
    // ou a DM é hoje entre outras pessoas): não mexe, senão o texto novo iria para a sala antiga.
    if (prev && (prev.userId !== author.id || prev.roomId !== room.id)) return null;
    const roomId = room.id;

    let tmid: string | null = null;
    let deferredParent: string | null = null;
    const parentId = m.tmid ? String(m.tmid) : null;
    if (parentId && parentId !== importId) {
      const parent = inBatch.get(parentId) ?? known.get(parentId);
      if (parent) {
        if (parent.roomId === roomId && parent.id !== prev?.id) tmid = parent.tmid ?? parent.id;
      } else deferredParent = parentId;
    }

    const fix = (s: string) => this.replaceTokens(s);
    const editedMs = timeOf(m.editedAt);
    const editor = editedMs && m.editedBy ? this.users.get(String(m.editedBy)) : undefined;
    const id = prev?.id ?? newId();
    const plan: MsgPlan = {
      rec,
      kind: prev ? 'update' : 'insert',
      id,
      importId,
      roomId,
      author,
      msg: truncate(fix(typeof m.msg === 'string' ? m.msg : ''), MAX_MSG),
      t: typeof m.t === 'string' && m.t ? truncate(m.t, 64) : null,
      tmid,
      deferredParent,
      tshow: !!m.tshow && !!(tmid || deferredParent),
      attachments: importAttachments(m.attachments, fix),
      files: importFiles(m.files),
      keep: prev ? prev.attachments.filter((a) => a?.type === 'file') : [],
      reactions: this.reactions(m.reactions),
      pinned: m.pinned === true,
      editedAt: editedMs ? iso(editedMs) : null,
      editedBy: editor ? { _id: editor.id, username: editor.username } : null,
      alias: str(m.alias, 100) || null,
      emoji: str(m.emoji, 100) || null,
      ms: timeOf(m.ts) ?? this.nextClock(),
      mentions: [],
      channels: [],
    };
    if (importId) inBatch.set(importId, { id, roomId, tmid });
    return plan;
  }

  private reactions(list: unknown) {
    const out: Record<string, { usernames: string[] }> = {};
    if (!list || typeof list !== 'object') return out;
    for (const [raw, ids] of Object.entries(list as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      let key = raw.trim().replace(/::skin-tone-\d+/g, '');
      if (!key.startsWith(':')) key = `:${key}:`;
      if (!REACTION_RE.test(key)) continue;
      const names = ids.map((id) => this.users.get(String(id))?.username).filter((u): u is string => !!u);
      if (!names.length) continue;
      out[key] = { usernames: uniq([...(out[key]?.usernames ?? []), ...names]) };
    }
    return out;
  }

  // Mesmas regras de menção das mensagens enviadas pelo chat, com uma consulta por lote.
  private async computeMentions(plans: MsgPlan[]) {
    const parsed = plans.map((p) => mentionNames(p.msg));
    const unames = uniq(parsed.flatMap((x) => [...x.users]));
    const rnames = uniq(parsed.flatMap((x) => [...x.rooms]));
    const users = new Map<string, MentionRef>();
    const teams = new Map<string, MentionRef>();
    const rooms = new Map<string, { _id: string; name: string }>();
    if (unames.length) {
      for (const u of await many('SELECT id, username, name FROM users WHERE lower(username) = ANY($1::text[])', [unames]))
        users.set(String(u.username).toLowerCase(), { _id: u.id, username: u.username, name: u.name });
      const rest = unames.filter((n) => !users.has(n));
      if (rest.length) {
        for (const t of await many('SELECT id, name FROM teams WHERE lower(name) = ANY($1::text[])', [rest]))
          teams.set(String(t.name).toLowerCase(), { _id: t.id, username: t.name, name: t.name, type: 'team' } as MentionRef);
      }
    }
    if (rnames.length) {
      for (const r of await many(`SELECT id, name FROM rooms WHERE lower(name) = ANY($1::text[]) AND t IN ('c','p') ORDER BY prid NULLS FIRST`, [rnames]))
        if (!rooms.has(String(r.name).toLowerCase())) rooms.set(String(r.name).toLowerCase(), { _id: r.id, name: r.name });
    }
    plans.forEach((p, i) => {
      const x = parsed[i];
      p.mentions = [
        ...[...x.special].map((s) => ({ _id: s, username: s })),
        ...([...x.users].map((n) => users.get(n)).filter(Boolean) as MentionRef[]),
        ...([...x.users].map((n) => teams.get(n)).filter(Boolean) as MentionRef[]),
      ];
      p.channels = [...x.rooms].map((n) => rooms.get(n)).filter((r): r is { _id: string; name: string } => !!r);
    });
  }

  // Horário único por sala (a paginação do histórico usa created_at e se perderia com dois iguais).
  private async reserveTimes(rid: string, plans: MsgPlan[]) {
    let used = this.usedTs.get(rid);
    if (!used) this.usedTs.set(rid, (used = new Set()));
    const checkDb = !this.createdRooms.has(rid);
    const inDb = new Set<number>();
    const checked = new Set<number>();
    for (;;) {
      const local = new Set<number>();
      const out = plans.map((p) => {
        let v = p.ms;
        while (used.has(v) || inDb.has(v) || local.has(v)) v++;
        local.add(v);
        return v;
      });
      const ask = checkDb ? out.filter((v) => !checked.has(v)) : [];
      if (ask.length) {
        ask.forEach((v) => checked.add(v));
        const rows = await many(
          `SELECT DISTINCT round(extract(epoch FROM date_trunc('milliseconds', m.created_at)) * 1000)::bigint AS ms
           FROM unnest($2::timestamptz[]) AS v(ts) JOIN messages m ON m.room_id = $1 AND m.created_at >= v.ts AND m.created_at < v.ts + interval '1 millisecond'`,
          [rid, ask.map(iso)],
        );
        if (rows.length) {
          rows.forEach((r) => inDb.add(Number(r.ms)));
          continue;
        }
      }
      plans.forEach((p, i) => {
        p.ms = out[i];
        used.add(out[i]);
      });
      return;
    }
  }

  private async writeMessages(c: Queryable, plans: MsgPlan[]) {
    const ins = plans.filter((p) => p.kind === 'insert');
    if (ins.length) {
      await query(
        `INSERT INTO messages (id, room_id, user_id, username, user_name, msg, t, tmid, mentions, channels, attachments, files, reactions,
           pinned, pinned_at, edited_at, edited_by, alias, emoji, extra, unread, created_at, updated_at)
         SELECT x.id, x.rid, x.uid, x.username, x.user_name, x.msg, x.t, x.tmid, x.mentions, x.channels, x.attachments, '[]'::jsonb, x.reactions,
           x.pinned, CASE WHEN x.pinned THEN x.ts END, x.edited_at, x.edited_by, x.alias, x.emoji, x.extra, false, x.ts, x.ts
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::jsonb[],
           $11::jsonb[], $12::jsonb[], $13::bool[], $14::timestamptz[], $15::jsonb[], $16::text[], $17::text[], $18::jsonb[], $19::timestamptz[])
           AS x(id, rid, uid, username, user_name, msg, t, tmid, mentions, channels, attachments, reactions, pinned, edited_at, edited_by, alias, emoji, extra, ts)`,
        [
          ins.map((p) => p.id),
          ins.map((p) => p.roomId),
          ins.map((p) => p.author.id),
          ins.map((p) => p.author.username),
          ins.map((p) => p.author.name),
          ins.map((p) => p.msg),
          ins.map((p) => p.t),
          ins.map((p) => p.tmid),
          ins.map((p) => JSON.stringify(p.mentions)),
          ins.map((p) => JSON.stringify(p.channels)),
          ins.map((p) => JSON.stringify([...p.attachments, ...p.files.map(placeholder)])),
          ins.map((p) => JSON.stringify(p.reactions)),
          ins.map((p) => p.pinned),
          ins.map((p) => p.editedAt),
          ins.map((p) => (p.editedBy ? JSON.stringify(p.editedBy) : null)),
          ins.map((p) => p.alias),
          ins.map((p) => p.emoji),
          ins.map((p) => JSON.stringify(p.tshow ? { tshow: true } : {})),
          ins.map((p) => iso(p.ms)),
        ],
        c,
      );
      await this.mapIds(c, 'message', ins.flatMap((p) => (p.importId ? [[p.importId, p.id] as [string, string]] : [])));
    }
    const ups = plans.filter((p) => p.kind === 'update');
    if (ups.length) {
      await query(
        `UPDATE messages m SET msg = x.msg, mentions = x.mentions, channels = x.channels, attachments = x.attachments, reactions = x.reactions,
           edited_at = x.edited_at, edited_by = x.edited_by, pinned = x.pinned, pinned_at = CASE WHEN x.pinned THEN coalesce(m.pinned_at, m.created_at) END,
           tmid = x.tmid, extra = CASE WHEN x.tshow THEN m.extra || '{"tshow": true}'::jsonb ELSE m.extra - 'tshow' END, updated_at = now()
         FROM unnest($1::text[], $2::text[], $3::jsonb[], $4::jsonb[], $5::jsonb[], $6::jsonb[], $7::timestamptz[], $8::jsonb[], $9::bool[], $10::text[], $11::bool[], $12::text[])
           AS x(id, msg, mentions, channels, attachments, reactions, edited_at, edited_by, pinned, tmid, tshow, uid)
         WHERE m.id = x.id AND m.user_id = x.uid`,
        [
          ups.map((p) => p.id),
          ups.map((p) => p.msg),
          ups.map((p) => JSON.stringify(p.mentions)),
          ups.map((p) => JSON.stringify(p.channels)),
          ups.map((p) => JSON.stringify([...p.attachments, ...p.files.map(placeholder), ...p.keep])),
          ups.map((p) => JSON.stringify(p.reactions)),
          ups.map((p) => p.editedAt),
          ups.map((p) => (p.editedBy ? JSON.stringify(p.editedBy) : null)),
          ups.map((p) => p.pinned),
          ups.map((p) => p.tmid),
          ups.map((p) => p.tshow),
          ups.map((p) => p.author.id),
        ],
        c,
      );
    }
    // Reimportar uma exportação nova traz o endereço novo (o token do Slack expira) e volta a tentar do zero; o que já foi
    // baixado fica como está. Repetido no mesmo INSERT ... ON CONFLICT DO UPDATE é recusado pelo PostgreSQL.
    const files = [...new Map(plans.flatMap((p) => p.files.map((f) => [`${p.id}/${f.id}`, { p, f }] as const))).values()];
    if (files.length) {
      await query(
        `INSERT INTO import_pending_files (id, source_file_id, message_id, room_id, user_id, name, type, size, url, external, status, operation_id)
         SELECT x.* FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::text[], $10::bool[], $11::text[], $12::text[])
           AS x(id, source_file_id, message_id, room_id, user_id, name, type, size, url, external, status, operation_id)
         ON CONFLICT (message_id, source_file_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, size = EXCLUDED.size, url = EXCLUDED.url,
           external = EXCLUDED.external, status = EXCLUDED.status, attempts = 0, error = NULL, operation_id = EXCLUDED.operation_id, updated_at = now()
         WHERE import_pending_files.status <> 'downloaded'`,
        [
          files.map(() => newId()),
          files.map(({ f }) => f.id),
          files.map(({ p }) => p.id),
          files.map(({ p }) => p.roomId),
          files.map(({ p }) => p.author.id),
          files.map(({ f }) => f.name),
          files.map(({ f }) => f.type ?? null),
          files.map(({ f }) => f.size ?? null),
          files.map(({ f }) => f.url ?? null),
          files.map(({ f }) => !!f.external),
          files.map(({ f }) => (f.url && !f.external ? 'pending' : 'unavailable')),
          files.map(() => this.opId),
        ],
        c,
      );
    }
  }

  private afterMessages(plans: MsgPlan[]) {
    for (const p of plans) {
      this.msgRooms.add(p.roomId);
      if (p.kind === 'insert') {
        this.result.messages.inserted++;
        if (!p.t) this.insertedNormal.set(p.roomId, (this.insertedNormal.get(p.roomId) ?? 0) + 1);
      } else this.result.messages.updated++;
      if (p.deferredParent) this.deferred.push({ id: p.id, roomId: p.roomId, parent: p.deferredParent, tshow: p.tshow });
    }
    this.sink.inc({ completed: plans.length });
  }

  // Respostas que chegaram antes da mensagem raiz.
  private async resolveDeferred() {
    for (let i = 0; i < this.deferred.length; i += BATCH) {
      const part = this.deferred.slice(i, i + BATCH);
      const known = await this.lookupMessages(uniq(part.map((d) => d.parent)));
      const ids: string[] = [];
      const tmids: string[] = [];
      const plain: string[] = [];
      for (const d of part) {
        const p = known.get(d.parent);
        if (p && p.roomId === d.roomId && p.id !== d.id) {
          ids.push(d.id);
          tmids.push(p.tmid ?? p.id);
        } else if (d.tshow) plain.push(d.id);
      }
      if (ids.length) await query('UPDATE messages m SET tmid = x.tmid FROM unnest($1::text[], $2::text[]) AS x(id, tmid) WHERE m.id = x.id', [ids, tmids]);
      // A raiz nunca apareceu: a resposta fica como mensagem comum.
      if (plain.length) await query(`UPDATE messages SET extra = extra - 'tshow' WHERE id = ANY($1::text[])`, [plain]);
    }
    this.deferred = [];
  }

  // ---------- Fim ----------

  private async finish() {
    await this.resolveDeferred();
    const rooms = [...this.msgRooms];
    for (let i = 0; i < rooms.length; i += 100) await query(THREADS_SQL, [rooms.slice(i, i + 100)]);
    for (const rid of rooms) {
      // Uma sala com problema não deixa as outras sem contadores e sem última mensagem.
      await this.recomputeRoom(rid).catch((e) => {
        if (config.logLevel !== 'silent') console.error(`importação: recálculo da sala ${rid}`, e);
      });
    }
    const onlyMembers = [...this.memberRooms].filter((r) => !this.msgRooms.has(r));
    for (let i = 0; i < onlyMembers.length; i += 500) {
      await query(`UPDATE rooms r SET users_count = (SELECT count(*)::int FROM subscriptions s WHERE s.room_id = r.id), updated_at = now() WHERE r.id = ANY($1::text[])`, [
        onlyMembers.slice(i, i + 500),
      ]);
    }
  }

  private async recomputeRoom(rid: string) {
    const last = await one(
      `SELECT id, msg, files, attachments, user_id, username, user_name, created_at FROM messages
       WHERE room_id = $1 AND t IS NULL AND (tmid IS NULL OR extra->>'tshow' = 'true') ORDER BY created_at DESC LIMIT 1`,
      [rid],
    );
    let lastMessage: string | null = null;
    if (last) {
      const file = (last.files ?? [])[0]?.name ?? (last.attachments ?? []).find((a: Attachment) => a?.pendingFileId)?.title;
      const preview = last.msg || (file ? `📎 ${file}` : '');
      lastMessage = JSON.stringify({ _id: last.id, msg: truncate(preview, 200), u: { _id: last.user_id, username: last.username, name: last.user_name }, ts: last.created_at });
    }
    // msgs nunca diminui (é um total corrido): numa sala que já existia, soma o que entrou agora. Nunca fica abaixo do
    // que está na sala: uma importação interrompida antes do fim deixa msgs = 0, e na reimportação as mensagens voltam como atualizadas.
    await query(
      `UPDATE rooms r SET
         msgs = CASE WHEN $2 THEN c.n ELSE greatest(r.msgs + $3, c.n) END,
         lm = greatest(r.lm, c.last),
         last_message = coalesce($4::jsonb, r.last_message),
         users_count = (SELECT count(*)::int FROM subscriptions s WHERE s.room_id = r.id),
         updated_at = now()
       FROM (SELECT count(*)::int AS n, max(created_at) AS last FROM messages WHERE room_id = $1 AND t IS NULL) c
       WHERE r.id = $1`,
      [rid, this.createdRooms.has(rid), this.insertedNormal.get(rid) ?? 0, lastMessage],
    );
  }

  // Avisa só quem está conectado; nada de notificação de mensagem, e-mail, push, webhook ou bot.
  private async notify() {
    try {
      for (const s of this.newSubs) {
        bus.joinRoom(s.userId, s.rid);
        await notifySubscription(s.userId, s.rid, 'inserted');
      }
      for (const rid of this.publicRooms) {
        const room = await getRoom(rid);
        if (room) bus.publish({ all: true }, { type: 'room', action: 'inserted', room: mapRoom(room) });
      }
      // Sala que já existia e recebeu mensagens novas: a lista de salas de quem está conectado se atualiza.
      for (const rid of this.insertedNormal.keys()) if (!this.createdRooms.has(rid)) await notifyRoomUpdated(rid);
    } catch {
      // Eventos em tempo real são só conveniência: quem recarregar vê tudo.
    }
  }

  private sendPasswordEmails() {
    const ids = this.newUsers.filter((u) => u.active && !u.bot && u.email).map((u) => u.id);
    if (!ids.length) return;
    // Um por vez, em segundo plano; falha de e-mail não afeta a importação.
    void (async () => {
      for (const id of ids) await sendPasswordSetupEmail(id).catch(() => false);
    })();
  }
}

export async function runConversion(o: { operationId: string; actor: Actor; selection: ShortSelection; options: ImportOptions; sink: ProgressSink }): Promise<ConversionResult> {
  return new Conversion(o.operationId, o.actor, o.selection ?? {}, o.options ?? {}, o.sink).run();
}
