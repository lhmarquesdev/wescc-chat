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
  // Nível da pessoa na pasta de cima (0 se não a vê; ausente na pasta principal). Renomear, mover e mandar uma
  // subpasta para a lixeira valem para quem edita também a de cima.
  parentLevel?: DriveLevel;
  createdBy: DriveUserRef | null;
  createdAt: string;
  updatedAt: string;
  // Só nas listagens de pasta: quantos itens tem dentro (pastas visíveis + arquivos) e o tamanho dos arquivos.
  items?: number;
  // Só as subpastas visíveis (a árvore só mostra a seta de abrir quando há alguma).
  subfolders?: number;
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
  // Herdada de uma pasta de cima (só leitura aqui; muda lá). _id e name vazios: de uma pasta de cima que a pessoa não vê.
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

// Caracteres invisíveis de direção do texto (ex.: U+202E antes de "fdp.exe" faz "relatorio" + U+202E + "fdp.exe" aparecer
// como "relatorioexe.pdf") e de largura zero. O ZWJ (U+200D) fica: ele junta emojis.
export const INVISIBLE_NAME_CHARS = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

// Nome de pasta ou arquivo: sem barras, controle, caracteres invisíveis ou só pontos; espaços nas pontas saem.
export function cleanDriveName(raw: unknown, max: number): string | null {
  const s = clipDriveName(
    String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(INVISIBLE_NAME_CHARS, '')
      .replace(/[\\/]/g, '-')
      .trim(),
    max,
  ).trim();
  if (!s || /^\.+$/.test(s)) return null;
  return s;
}

// Limites do banco (length() conta caracteres, não unidades UTF-16).
export const DRIVE_FOLDER_NAME_MAX = 120;
export const DRIVE_FILE_NAME_MAX = 200;

let graphemes: Intl.Segmenter | null = null;

// Corta em até max caracteres sem partir um emoji ao meio e, se houver extensão, sem perdê-la ("Relatório tri….xlsx"
// vira "Relatório tri.xlsx", não "Relatório tri").
export function clipDriveName(s: string, max: number): string {
  if (Array.from(s).length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && Array.from(s.slice(dot)).length <= 16 && /^\.[^\s.]+$/.test(s.slice(dot)) ? s.slice(dot) : '';
  const room = max - Array.from(ext).length;
  let base = '';
  let used = 0;
  graphemes ??= new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
  for (const { segment } of graphemes.segment(ext ? s.slice(0, dot) : s)) {
    const n = Array.from(segment).length;
    if (used + n > room) break;
    base += segment;
    used += n;
  }
  return base.trimEnd() + ext;
}

// "relatório.pdf" ocupado → "relatório (2).pdf", "relatório (3).pdf"... Com max, encurta o nome para caber o "(2)".
export function nextFreeName(name: string, taken: Set<string>, max?: number): string {
  const lower = (x: string) => x.toLowerCase();
  if (!taken.has(lower(name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const fit = (suffix: string) => (max ? clipDriveName(`${base}${ext}`, max - Array.from(suffix).length) : `${base}${ext}`);
  const make = (suffix: string) => {
    const short = fit(suffix);
    const d = ext && short.endsWith(ext) ? short.length - ext.length : short.length;
    return `${short.slice(0, d).trimEnd()}${suffix}${short.slice(d)}`;
  };
  for (let i = 2; i < 10_000; i++) {
    const n = make(` (${i})`);
    if (!taken.has(lower(n))) return n;
  }
  return make(` (${Date.now()})`);
}

export const FOLDER_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'gray'] as const;
