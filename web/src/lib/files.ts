// Arquivos: chamadas da API e a fila de envios (fica viva ao trocar de pasta ou de tela dentro do chat).
import { useSyncExternalStore } from 'react';
import type { DriveAclEntry, DriveActivity, DriveFile, DriveFolder, DriveFolderView, DriveStorage, DriveSubject } from '@shared/drive';
import { api, ApiError, uploadTo } from './api';
import { usePermission, useSetting, useStore } from './store';

// Item que ficou com outro nome ao mover ou restaurar (já havia um com o mesmo nome no lugar).
export type DriveRenamed = { _id: string; from: string; name: string };

export const filesApi = {
  home: () => api.get<{ folders: DriveFolder[]; canCreateRoot: boolean; manageAll: boolean; storage: DriveStorage }>('files.home'),
  folder: (folderId: string) => api.get<DriveFolderView>('files.folder', { folderId }),
  search: (text: string) => api.get<{ folders: (DriveFolder & { path: { _id: string; name: string }[] })[]; files: DriveFile[] }>('files.search', { text }),
  recent: () => api.get<{ files: DriveFile[] }>('files.recent').then((r) => r.files),
  storage: () => api.get<{ storage: DriveStorage }>('files.storage').then((r) => r.storage),
  activity: (folderId: string, offset = 0) => api.get<{ total: number; events: DriveActivity[] }>('files.activity', { folderId, count: 60, offset }),
  subjects: (text: string) => api.get<{ subjects: DriveSubject[] }>('files.subjects', { text }).then((r) => r.subjects),
  createFolder: (body: { name: string; parentId?: string | null; color?: string | null }) => api.post<{ folder: DriveFolder }>('files.folder.create', body).then((r) => r.folder),
  updateFolder: (folderId: string, body: { name?: string; color?: string | null }) => api.post<{ name?: string }>('files.folder.update', { folderId, ...body }),
  share: (folderId: string, entries: { type: string; id: string; level: number }[], inherit: boolean) =>
    api.post<{ acl: DriveAclEntry[] }>('files.folder.share', { folderId, entries, inherit }).then((r) => r.acl),
  rename: (fileId: string, name: string) => api.post('files.rename', { fileId, name }),
  move: (body: { fileIds?: string[]; folderIds?: string[]; targetId: string | null }) => api.post<{ renamed?: DriveRenamed[] }>('files.move', body),
  trash: (body: { fileIds?: string[]; folderIds?: string[] }) => api.post('files.trash', body),
  trashList: () => api.get<{ days: number; folders: (DriveFolder & { path: { _id: string; name: string }[] })[]; files: DriveFile[] }>('files.trash.list'),
  restore: (body: { fileIds?: string[]; folderIds?: string[] }) => api.post<{ renamed?: DriveRenamed[] }>('files.restore', body),
  purge: (body: { fileIds?: string[]; folderIds?: string[]; all?: boolean }) => api.post<{ removed: number }>('files.purge', body),
};

// ---------- Fila de envios ----------

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  folderId: string;
  folderName: string;
  progress: number;
  state: 'waiting' | 'sending' | 'done' | 'error' | 'canceled';
  error?: string;
  result?: DriveFile;
  abort: AbortController;
}

let jobs: UploadJob[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  jobs = [...jobs];
  for (const l of listeners) l();
};
let running = 0;
const PARALLEL = 3;
let seq = 0;

function pump() {
  while (running < PARALLEL) {
    const next = jobs.find((j) => j.state === 'waiting');
    if (!next) return;
    running++;
    next.state = 'sending';
    emit();
    const file = pendingFiles.get(next.id)!;
    uploadTo<{ file: DriveFile }>(
      `files.upload/${next.folderId}`,
      file,
      {},
      (p) => {
        next.progress = p;
        emit();
      },
      next.abort.signal,
    )
      .then((r) => {
        next.state = 'done';
        next.progress = 1;
        next.result = r.file;
      })
      .catch((e) => {
        if (e instanceof ApiError && e.errorType === 'aborted') next.state = 'canceled';
        else {
          next.state = 'error';
          next.error = e instanceof Error ? e.message : String(e);
          // Fora da tela Arquivos a fila não aparece: avisa aqui (o item Arquivos do menu fica marcado).
          if (!window.location.pathname.startsWith('/files')) useStore.getState().toast(`Não deu para enviar “${next.name}”: ${next.error}`, 'error');
        }
      })
      .finally(() => {
        pendingFiles.delete(next.id);
        running--;
        emit();
        pump();
      });
  }
}

const pendingFiles = new Map<string, File>();

// Fechar ou recarregar a aba no meio de um envio perde o envio: o navegador pergunta antes.
let unloadGuard = false;
function guardUnload() {
  if (unloadGuard) return;
  unloadGuard = true;
  window.addEventListener('beforeunload', (e) => {
    if (!jobs.some((j) => j.state === 'waiting' || j.state === 'sending')) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

export function enqueueUploads(files: File[], folder: { _id: string; name: string }) {
  guardUnload();
  for (const f of files) {
    const id = `u${++seq}`;
    pendingFiles.set(id, f);
    jobs.push({ id, name: f.name, size: f.size, folderId: folder._id, folderName: folder.name, progress: 0, state: 'waiting', abort: new AbortController() });
  }
  emit();
  pump();
}

export function cancelUpload(id: string) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (j.state === 'waiting') {
    j.state = 'canceled';
    pendingFiles.delete(id);
    emit();
  } else if (j.state === 'sending') j.abort.abort();
}

export function clearFinishedUploads() {
  jobs = jobs.filter((j) => j.state === 'waiting' || j.state === 'sending');
  emit();
}

export function useUploads() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => jobs,
  );
}

// A aba aparece com a funcionalidade ligada e a permissão de usar (ou de gerenciar tudo).
export function useFilesTab() {
  const on = useSetting<boolean>('Drive_Enabled') !== false;
  const can = usePermission(['view-files', 'manage-all-files']);
  return on && can;
}
