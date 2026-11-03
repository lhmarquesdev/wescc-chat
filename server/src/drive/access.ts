// Arquivos: quem acessa cada pasta.
//
// Uma pasta dá um nível (1 ver, 2 editar, 3 gerenciar) a papéis globais, a membros de canais/grupos e a pessoas. O
// nível de alguém numa pasta é o maior entre o que a própria pasta dá a ele e, se a pasta herda (inherit), o nível dele
// na pasta de cima. Desligar a herança deixa valer só o compartilhamento da própria pasta. manage-all-files dá 3 em tudo.
//
// O mapa é calculado inteiro por requisição: a empresa tem poucas milhares de pastas no máximo, e assim cada listagem
// sai de duas consultas, sem consulta recursiva por item.
import type { DriveLevel } from '@shared/drive';
import { many } from '../db/pool';
import { forbidden, notFound } from '../lib/errors';
import { getUserRoles, hasPermission } from '../services/permissions';
import type { Ctx } from '../services/users';

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  inherit: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
  trashed_by: string | null;
}

export interface Access {
  userId: string;
  all: boolean;
  folders: Map<string, FolderRow>;
  level(id: string | null | undefined): DriveLevel;
  // Na lixeira: a própria pasta ou alguma de cima.
  trashed(id: string): boolean;
  // Caminho visível até a pasta: começa na primeira pasta de cima que a pessoa não vê (ou na raiz).
  path(id: string): { _id: string; name: string }[];
  // Pastas em que a pessoa entra sem ver a de cima: as "pastas principais" dela.
  entries(): FolderRow[];
  children(id: string | null): FolderRow[];
  // A pasta e todas as de dentro.
  subtree(id: string): string[];
}

export async function loadAccess(ctx: Ctx): Promise<Access> {
  const all = await hasPermission(ctx.userId, 'manage-all-files');
  const rows = await many<FolderRow>('SELECT id, parent_id, name, color, inherit, created_by, created_at, updated_at, trashed_at, trashed_by FROM drive_folders');
  const folders = new Map(rows.map((r) => [r.id, r]));
  const own = new Map<string, number>();
  if (!all) {
    const roles = await getUserRoles(ctx.userId);
    const grants = await many<{ folder_id: string; level: number }>(
      `SELECT folder_id, max(level)::int AS level FROM drive_acl
       WHERE (subject_type = 'user' AND subject_id = $1)
          OR (subject_type = 'role' AND subject_id = ANY($2::text[]))
          OR (subject_type = 'room' AND subject_id IN (SELECT room_id FROM subscriptions WHERE user_id = $1))
       GROUP BY folder_id`,
      [ctx.userId, roles],
    );
    for (const g of grants) own.set(g.folder_id, g.level);
  }
  const memo = new Map<string, DriveLevel>();
  const level = (id: string | null | undefined): DriveLevel => {
    if (!id) return 0;
    const f = folders.get(id);
    if (!f) return 0;
    if (all) return 3;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    memo.set(id, 0); // corta ciclos (não deveriam existir)
    const mine = own.get(id) ?? 0;
    const up = f.inherit && f.parent_id ? level(f.parent_id) : 0;
    const out = Math.max(mine, up) as DriveLevel;
    memo.set(id, out);
    return out;
  };
  const trashMemo = new Map<string, boolean>();
  const trashed = (id: string): boolean => {
    const hit = trashMemo.get(id);
    if (hit !== undefined) return hit;
    trashMemo.set(id, false);
    const f = folders.get(id);
    const out = !f ? true : !!f.trashed_at || (!!f.parent_id && trashed(f.parent_id));
    trashMemo.set(id, out);
    return out;
  };
  const byParent = new Map<string | null, FolderRow[]>();
  for (const r of rows) {
    const k = r.parent_id ?? null;
    byParent.set(k, [...(byParent.get(k) ?? []), r]);
  }
  const sortRows = (list: FolderRow[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true }));
  return {
    userId: ctx.userId,
    all,
    folders,
    level,
    trashed,
    path(id) {
      const out: { _id: string; name: string }[] = [];
      let cur = folders.get(id);
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id) && level(cur.id) > 0) {
        seen.add(cur.id);
        out.unshift({ _id: cur.id, name: cur.name });
        cur = cur.parent_id ? folders.get(cur.parent_id) : undefined;
      }
      return out;
    },
    entries() {
      return sortRows(rows.filter((r) => !trashed(r.id) && level(r.id) > 0 && (!r.parent_id || level(r.parent_id) === 0)));
    },
    children(id) {
      return sortRows((byParent.get(id) ?? []).filter((r) => !r.trashed_at && level(r.id) > 0));
    },
    subtree(id) {
      const out: string[] = [];
      const walk = (x: string) => {
        if (out.includes(x)) return;
        out.push(x);
        for (const c of byParent.get(x) ?? []) walk(c.id);
      };
      walk(id);
      return out;
    },
  };
}

export const DRIVE_TEXT = {
  notFound: 'Pasta não encontrada ou sem acesso.',
  fileNotFound: 'Arquivo não encontrado ou sem acesso.',
  needEdit: 'Você só pode ver esta pasta. Peça a quem gerencia para liberar a edição.',
  needManage: 'Só quem gerencia a pasta pode fazer isso.',
  inTrash: 'Esta pasta está na lixeira. Restaure-a antes.',
};

// A pasta, se a pessoa tiver pelo menos o nível pedido. Sem acesso nenhum, 404 (não confirma que a pasta existe).
export function needFolder(acc: Access, id: unknown, min: DriveLevel, opts: { allowTrashed?: boolean } = {}): FolderRow {
  const f = typeof id === 'string' ? acc.folders.get(id) : undefined;
  const lvl = f ? acc.level(f.id) : 0;
  if (!f || lvl === 0) throw notFound('error-folder-not-found', DRIVE_TEXT.notFound);
  if (!opts.allowTrashed && acc.trashed(f.id)) throw notFound('error-folder-not-found', DRIVE_TEXT.inTrash);
  if (lvl < min) throw forbidden(min >= 3 ? DRIVE_TEXT.needManage : DRIVE_TEXT.needEdit);
  return f;
}
