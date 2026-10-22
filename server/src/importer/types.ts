// Tipos e contratos da importação de dados. Cada módulo de server/src/importer implementa uma parte:
//   archive.ts     leitura de .zip, pasta no servidor ou arquivo único (com limites contra zip bomb)
//   download.ts    download http(s) com proteção contra SSRF, tamanho máximo e tempo limite
//   operations.ts  operação de importação: estados, contadores, progresso, histórico, recuperação
//   staging.ts     dados lidos do arquivo (import_records), antes da conversão
//   converter.ts   conversão dos dados lidos em usuários, salas, mensagens e contatos
//   pending.ts     download posterior de arquivos e fotos de perfil
//   importers/*    leitura de cada formato (csv, slack, slack-users, contatos)
//   api.ts         rotas REST (mesmos nomes do Rocket.Chat)
import type { Readable } from 'node:stream';

// ---------- Estados (mesmos valores do Rocket.Chat) ----------

export const ST = {
  new: 'importer_new',
  uploading: 'importer_uploading',
  downloadingFile: 'importer_downloading_file',
  fileLoaded: 'importer_file_loaded',
  preparingStarted: 'importer_preparing_started',
  preparingUsers: 'importer_preparing_users',
  preparingChannels: 'importer_preparing_channels',
  preparingMessages: 'importer_preparing_messages',
  preparingContacts: 'importer_preparing_contacts',
  userSelection: 'importer_user_selection',
  importingStarted: 'importer_importing_started',
  importingUsers: 'importer_importing_users',
  importingContacts: 'importer_importing_contacts',
  importingChannels: 'importer_importing_channels',
  importingMessages: 'importer_importing_messages',
  importingFiles: 'importer_importing_files',
  finishing: 'importer_finishing',
  done: 'importer_done',
  failed: 'importer_import_failed',
  cancelled: 'importer_import_cancelled',
} as const;

export type ImportStatus = (typeof ST)[keyof typeof ST];

export const WAITING_STATES: readonly ImportStatus[] = [ST.new, ST.uploading, ST.downloadingFile];
export const PREPARING_STATES: readonly ImportStatus[] = [ST.fileLoaded, ST.preparingStarted, ST.preparingUsers, ST.preparingChannels, ST.preparingMessages, ST.preparingContacts];
export const IMPORTING_STATES: readonly ImportStatus[] = [
  ST.importingStarted,
  ST.importingUsers,
  ST.importingContacts,
  ST.importingChannels,
  ST.importingMessages,
  ST.importingFiles,
  ST.finishing,
];
export const FINAL_STATES: readonly ImportStatus[] = [ST.done, ST.failed, ST.cancelled];
// Estados em que há trabalho rodando em segundo plano (não dá para começar outra importação).
export const BUSY_STATES: readonly ImportStatus[] = [ST.uploading, ST.downloadingFile, ...PREPARING_STATES, ...IMPORTING_STATES];

export type ImporterKey = 'csv' | 'slack' | 'slack-users' | 'omnichannel_contact' | 'api' | 'pending-files' | 'pending-avatars';

// ---------- Operação ----------

export interface ImportCounts {
  users: number;
  channels: number;
  messages: number;
  contacts: number;
  total: number;
  completed: number;
  error: number;
  skipped: number;
}

export interface ImportOptions {
  // Novos usuários com e-mail recebem o link para definir a senha (o mesmo de "Esqueci minha senha").
  sendPasswordEmails?: boolean;
  // Importação pela API (import.run): só cria usuários novos, sem procurar existentes, como no Rocket.Chat.
  skipExistingUsers?: boolean;
}

// Formato devolvido pela API (campos com os nomes do Rocket.Chat).
export interface ImportOperation {
  _id: string;
  type: string; // nome do importador (ex.: "Slack")
  importerKey: ImporterKey;
  status: ImportStatus;
  valid: boolean;
  user: string | null;
  source: 'upload' | 'url' | 'path' | 'none';
  file: string | null; // nome original do arquivo, ou a pasta no servidor
  contentType: string | null;
  fileSize: number | null;
  count: ImportCounts;
  messagesstatus: string | null;
  error: string | null;
  warnings: string[];
  options: ImportOptions;
  ts: string; // criação
  _updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// Evento em tempo real para quem pode importar (ServerEvent 'import.progress').
export interface ImportProgressPayload {
  _id: string;
  importerKey: ImporterKey;
  status: ImportStatus;
  valid: boolean;
  count: ImportCounts;
  rate?: number; // 0–100, só durante a leitura do arquivo
  messagesstatus?: string | null;
  error?: string | null;
}

// ---------- Dados lidos do arquivo (import_records.data) ----------
// Ids "de importação" são os ids da origem (Slack U123/C123, nome de usuário no CSV etc.).

// Marcadores de menção dentro do texto, trocados pelo nome final na conversão:
//   usuário: "\u0001@<importId>|<rótulo>\u0002"  →  "@nomeDeUsuario" (ou "@<rótulo>" se o usuário não foi importado)
//   sala:    "\u0001#<importId ou nome>|<rótulo>\u0002"  →  "#nomeDaSala" (ou "#<rótulo>")
// O rótulo é opcional ("\u0001@U123\u0002"). Fora dos marcadores, @nome e #sala comuns também viram menções
// se o usuário ou a sala existir, como nas mensagens enviadas pelo chat.
export const MENTION_OPEN = '\u0001';
export const MENTION_CLOSE = '\u0002';
export const userToken = (importId: string, label?: string) => `${MENTION_OPEN}@${importId}${label ? `|${label}` : ''}${MENTION_CLOSE}`;
export const roomToken = (ref: string, label?: string) => `${MENTION_OPEN}#${ref}${label ? `|${label}` : ''}${MENTION_CLOSE}`;

export interface ImportUser {
  importIds: string[];
  emails: string[];
  username?: string;
  name?: string;
  type?: 'user' | 'bot';
  deleted?: boolean;
  statusText?: string;
  bio?: string;
  roles?: string[]; // papéis globais a acrescentar (nunca remove os que a pessoa já tem)
  avatarUrl?: string; // baixada depois, em "Baixar fotos pendentes"
  password?: string; // legado: o import.addUsers guarda só passwordHash, nunca a senha em texto
  passwordHash?: string; // hash no mesmo formato das contas normais (import.addUsers)
}

export interface ImportChannel {
  importIds: string[];
  t: 'c' | 'p' | 'd';
  name?: string; // obrigatório para c/p
  users: string[]; // ids de importação dos membros
  creator?: string; // id de importação de quem criou
  topic?: string;
  description?: string;
  ts?: string; // ISO; data de criação
  archived?: boolean;
  isDefault?: boolean; // canal geral do Slack: vai para o canal padrão daqui
}

export interface ImportAttachment {
  title?: string;
  title_link?: string;
  text?: string;
  pretext?: string;
  color?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  fields?: { title: string; value: string; short?: boolean }[];
  ts?: string;
}

export interface ImportFile {
  id: string; // id na origem
  name: string;
  size?: number;
  type?: string; // mime
  url?: string; // de onde baixar depois (pode levar token na query, como no Slack)
  external?: boolean; // arquivo externo (Google Drive etc.): não é baixado
}

export interface ImportMessage {
  importId?: string; // id estável na origem: reimportar atualiza em vez de duplicar; usado por tmid
  rid: string; // id de importação da sala
  u: string; // id de importação do autor
  ts?: string; // ISO com milissegundos; vazio ou inválido → hora da importação
  msg: string; // texto, com marcadores de menção (MENTION_OPEN)
  t?: string; // tipo de mensagem de sistema (uj, ul, room_changed_topic, room_changed_description, r...)
  tmid?: string; // importId da mensagem raiz da thread
  tshow?: boolean; // resposta de thread também mostrada na sala
  reactions?: Record<string, string[]>; // ":emoji:" → ids de importação de quem reagiu
  editedAt?: string;
  editedBy?: string; // id de importação
  attachments?: ImportAttachment[];
  files?: ImportFile[];
  alias?: string;
  emoji?: string;
  bot?: boolean;
  pinned?: boolean;
}

export interface ImportContact {
  importIds: string[];
  name?: string;
  emails: string[];
  phones: string[];
  manager?: string; // nome de usuário de quem cuida do contato
  customFields?: Record<string, string>;
}

export type ImportDataType = 'user' | 'channel' | 'message' | 'contact';

export interface StagedRecord<T = unknown> {
  id: number;
  dataType: ImportDataType;
  importId: string | null;
  data: T;
}

// ---------- Prévia e seleção (getImportFileData / startImport) ----------

export const DIRECT_MESSAGES_ID = '__directMessages__';

export interface SelectionUser {
  user_id: string;
  username: string;
  name: string;
  email: string;
  is_deleted: boolean;
  is_bot: boolean;
  is_email_taken: boolean; // já existe conta com o e-mail ou o nome de usuário: os dados são juntados
  is_admin: boolean; // o arquivo pede o papel de admin (só vale para contas novas)
  do_import: boolean;
}

export interface SelectionChannel {
  channel_id: string;
  name: string;
  is_archived: boolean;
  is_private: boolean;
  is_direct: boolean;
  members: number;
  exists: boolean; // já existe sala com esse nome (ou importada antes)
  do_import: boolean;
}

export interface SelectionContact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  do_import: boolean;
}

export interface ImportSelection {
  name: string;
  users: SelectionUser[];
  channels: SelectionChannel[];
  contacts: SelectionContact[];
  message_count: number;
}

export interface ShortSelectionPart {
  all?: boolean;
  list?: string[];
}

export interface ShortSelection {
  users?: ShortSelectionPart;
  channels?: ShortSelectionPart;
  contacts?: ShortSelectionPart;
}

// ---------- Leitura do arquivo enviado ----------

export class ImportError extends Error {
  // message: texto para o administrador, em português.
  constructor(message: string, public code = 'error-import-failed') {
    super(message);
  }
}

export interface ArchiveEntry {
  name: string; // caminho com "/", sem "/" no começo, nunca com ".."
  size: number; // tamanho descompactado
  isDirectory: boolean;
}

export interface ArchiveSource {
  kind: 'zip' | 'dir' | 'file';
  // Todas as entradas, na ordem do arquivo (.zip) ou em ordem alfabética (pasta). Para 'file', uma entrada só.
  list(): Promise<ArchiveEntry[]>;
  // Conteúdo inteiro de uma entrada. Lança ImportError se passar de maxBytes (padrão 256 MiB).
  read(entry: ArchiveEntry, maxBytes?: number): Promise<Buffer>;
  stream(entry: ArchiveEntry): Promise<Readable>;
  close(): Promise<void>;
}

// ---------- Leitura de cada formato ----------

export interface PrepareContext {
  operationId: string;
  source: ArchiveSource;
  user(rec: ImportUser): Promise<void>;
  channel(rec: ImportChannel): Promise<void>;
  message(rec: ImportMessage): Promise<void>;
  contact(rec: ImportContact): Promise<void>;
  setStep(step: ImportStatus): Promise<void>; // preparing_users / _channels / _messages / _contacts
  setMessagesStatus(s: string | null): Promise<void>; // ex.: "general/2023-11-14"
  progress(rate: number): void; // 0–100
  warn(message: string): void; // aviso para o administrador (arquivo ignorado, linha inválida...)
  cancelled(): boolean; // a importação foi cancelada: pare assim que possível
  // Ids de importação já usados antes (import_map), para importadores que reaproveitam salas de importações anteriores.
  findImported(kind: 'user' | 'room', importId: string): Promise<string | null>;
}

export interface Importer {
  key: ImporterKey;
  name: string; // nome no histórico (ex.: "Slack")
  label: string; // nome na lista (ex.: "Slack (exportação .zip)")
  description: string; // explicação curta do formato
  accept: string; // extensões aceitas no seletor de arquivos (ex.: ".zip")
  sourceKind: 'zip' | 'file' | 'zip-or-dir'; // como o arquivo é aberto
  visible: boolean;
  prepare(ctx: PrepareContext): Promise<void>;
}

// ---------- Conversão ----------

export interface ProgressSink {
  step(step: ImportStatus): Promise<void>;
  inc(delta: { completed?: number; error?: number; skipped?: number }): void; // agrupado e gravado de tempos em tempos
  flush(): Promise<void>;
  cancelled(): boolean;
}

export interface Actor {
  userId: string;
  username: string;
}

export interface ConversionResult {
  users: { inserted: number; updated: number; failed: number; skipped: number };
  channels: { inserted: number; updated: number; failed: number; skipped: number };
  messages: { inserted: number; updated: number; failed: number; skipped: number };
  contacts: { inserted: number; failed: number; skipped: number };
  roomIds: string[]; // salas que receberam mensagens ou membros
  newUserIds: string[];
}
