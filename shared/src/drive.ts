// Arquivos: tipos da aba Arquivos (pastas compartilhadas com permissão por pasta), usados pelo servidor e pela web.

// 0 sem acesso · 1 ver e baixar · 2 editar · 3 gerenciar
export type DriveLevel = 0 | 1 | 2 | 3;
export type DriveSubjectType = 'role' | 'room' | 'user';

export const DRIVE_LEVELS: { level: 1 | 2 | 3; label: string; description: string }[] = [
  { level: 1, label: 'Pode ver', description: 'Abre, pré-visualiza e baixa.' },
  { level: 2, label: 'Pode editar', description: 'Também envia, renomeia, move, cria subpastas e manda para a lixeira.' },
  { level: 3, label: 'Gerencia', description: 'Também compartilha, muda permissões e esvazia a lixeira da pasta.' },
];

export const driveLevelLabel = (l: number) => DRIVE_LEVELS.find((x) => x.level === l)?.label ?? 'Sem acesso';

export interface DriveUserRef {
  _id: string;
  username: string;
  name?: string;
}

export interface DriveFolder {
  _id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  inherit: boolean;
  level: DriveLevel;
  createdBy: DriveUserRef | null;
  createdAt: string;
  updatedAt: string;
  // Só nas listagens de pasta: quantos itens tem dentro (pastas visíveis + arquivos) e o tamanho dos arquivos.
  items?: number;
  size?: number;
  // Compartilhada com mais alguém além de quem criou.
  shared?: boolean;
  trashedAt?: string | null;
  trashedBy?: DriveUserRef | null;
}

export interface DriveFile {
  _id: string;
  folderId: string;
  name: string;
  type: string;
  size: number;
  url: string;
  uploadedBy: DriveUserRef | null;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string | null;
  trashedBy?: DriveUserRef | null;
  // Busca e recentes: caminho da pasta, a partir do ponto em que a pessoa tem acesso.
  path?: { _id: string; name: string }[];
  level?: DriveLevel;
}

export interface DriveAclEntry {
  type: DriveSubjectType;
  id: string;
  level: 1 | 2 | 3;
  label: string;
  sublabel?: string;
  // Herdada de uma pasta de cima (só leitura aqui; muda lá).
  from?: { _id: string; name: string } | null;
  missing?: boolean;
}

export interface DriveFolderView {
  folder: DriveFolder;
  path: { _id: string; name: string }[];
  folders: DriveFolder[];
  files: DriveFile[];
  // Só para quem gerencia.
  acl?: DriveAclEntry[];
}

export interface DriveStorage {
  used: number;
  trash: number;
  quota: number; // bytes; 0 = sem limite
  diskFree: number | null;
  maxFileSize: number;
}

export interface DriveActivity {
  _id: string;
  action: string;
  actor: { _id: string | null; username: string | null; name?: string };
  fileId: string | null;
  data: Record<string, unknown>;
  ts: string;
}

export interface DriveSubject {
  type: DriveSubjectType;
  id: string;
  label: string;
  sublabel?: string;
}

// Nome de pasta ou arquivo: sem barras, controle ou só pontos; espaços nas pontas saem.
export function cleanDriveName(raw: unknown, max: number): string | null {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .trim()
    .slice(0, max)
    .trim();
  if (!s || /^\.+$/.test(s)) return null;
  return s;
}

// "relatório.pdf" ocupado → "relatório (2).pdf", "relatório (3).pdf"...
export function nextFreeName(name: string, taken: Set<string>): string {
  const lower = (x: string) => x.toLowerCase();
  if (!taken.has(lower(name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const n = `${base} (${i})${ext}`;
    if (!taken.has(lower(n))) return n;
  }
  return `${base} (${Date.now()})${ext}`;
}

export const FOLDER_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'gray'] as const;
