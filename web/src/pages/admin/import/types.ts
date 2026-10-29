// Formatos da API de importação (os mesmos de server/src/importer/types.ts, com os nomes de campo do Rocket.Chat).

export type ImportSource = 'upload' | 'url' | 'path';

export interface ImportCounts {
  users: number;
  channels: number;
  messages: number;
  total: number;
  completed: number;
  error: number;
  skipped: number;
}

export interface ImportOperation {
  _id: string;
  type: string;
  importerKey: string;
  status: string;
  valid: boolean;
  user: string | null;
  source: ImportSource | 'none';
  file: string | null;
  contentType: string | null;
  fileSize: number | null;
  count: ImportCounts;
  messagesstatus: string | null;
  error: string | null;
  warnings: string[];
  options: { sendPasswordEmails?: boolean; skipExistingUsers?: boolean };
  ts: string;
  _updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImporterInfo {
  key: string;
  name: string;
  label: string;
  description: string;
  accept: string;
  sources: ImportSource[];
}

export interface SelectionUser {
  user_id: string;
  username: string;
  name: string;
  email: string;
  is_deleted: boolean;
  is_bot: boolean;
  is_email_taken: boolean;
  is_admin?: boolean;
  do_import: boolean;
}

export interface SelectionChannel {
  channel_id: string;
  name: string;
  is_archived: boolean;
  is_private: boolean;
  is_direct: boolean;
  members: number;
  exists: boolean;
  do_import: boolean;
}

export interface ImportFileData {
  waiting?: boolean;
  operation: ImportOperation;
  name?: string;
  users?: SelectionUser[];
  channels?: SelectionChannel[];
  message_count?: number;
}

export interface ShortSelectionPart {
  all: boolean;
  list?: string[];
}

export interface ImportErrorRow {
  id: number;
  type: 'user' | 'channel' | 'message';
  importId: string | null;
  label: string;
  messages: string[];
}
