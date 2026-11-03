import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, query } from '../src/db/pool';
import { purgeExpiredTrash } from '../src/drive/drive';
import { storedPath } from '../src/services/uploads';
import { admin, api, newUser, raw, startServer, stopServer, type Auth } from './helpers';

// Arquivos: pastas com permissão por pasta (papel, canal, pessoa), herança, envio, download, lixeira, cota e histórico.

let A: Auth;
let ana: Auth; // gerente da pasta
let bruno: Auth; // membro do canal #financeiro
let carla: Auth; // sem acesso
let davi: Auth; // papel "operacao"

const up = (folderId: string, name: string, body: string, auth: Auth, type = 'text/plain') => {
  const fd = new FormData();
  fd.append('file', new Blob([body], { type }), name);
  return api('POST', `files.upload/${folderId}`, fd, auth);
};
const folder = (folderId: string, auth: Auth) => api('GET', 'files.folder', { folderId }, auth);
const share = (folderId: string, entries: unknown[], auth: Auth, inherit?: boolean) => api('POST', 'files.folder.share', { folderId, entries, inherit }, auth);

let root = '';
let channelId = '';

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  ana = await newUser(A, { name: 'Ana Souza' });
  bruno = await newUser(A, { name: 'Bruno Lima' });
  carla = await newUser(A, { name: 'Carla Dias' });
  davi = await newUser(A, { name: 'Davi Rocha', roles: ['operacao'] });
  const ch = await api('POST', 'groups.create', { name: 'financeiro', members: [bruno.username] }, A);
  channelId = ch.group._id;
});

afterAll(async () => {
  await stopServer();
});

describe('pastas principais', () => {
  it('só quem tem create-files-folder cria; quem cria gerencia e mais ninguém vê', async () => {
    const no = await api('POST', 'files.folder.create', { name: 'Minha' }, ana);
    expect(no.status).toBe(403);
    const home = await api('GET', 'files.home', undefined, ana);
    expect(home.canCreateRoot).toBe(false);
    expect(home.folders).toEqual([]);

    const r = await api('POST', 'files.folder.create', { name: 'Financeiro', color: 'green' }, A);
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.folder.level).toBe(3);
    root = r.folder._id;
    expect((await folder(root, ana)).status).toBe(404);
    expect((await api('POST', 'files.folder.create', { name: 'financeiro' }, A)).errorType).toBe('error-name-taken');
  });

  it('nome inválido, cor inválida', async () => {
    expect((await api('POST', 'files.folder.create', { name: '  ' }, A)).errorType).toBe('error-invalid-name');
    expect((await api('POST', 'files.folder.create', { name: 'X', color: 'rosa-choque' }, A)).status).toBe(400);
  });

  it('sem view-files a aba some para a pessoa', async () => {
    const perm = await one<{ roles: string[] }>("SELECT roles FROM permissions WHERE id = 'view-files'");
    expect(perm!.roles).toEqual(expect.arrayContaining(['admin', 'user', 'operacao']));
  });
});

describe('compartilhar', () => {
  it('por pessoa, por canal e por papel, cada um com o seu nível', async () => {
    const r = await share(
      root,
      [
        { type: 'user', id: A.userId, level: 3 },
        { type: 'user', id: ana.userId, level: 3 },
        { type: 'room', id: channelId, level: 2 },
        { type: 'role', id: 'operacao', level: 1 },
      ],
      A,
    );
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.acl.map((e: any) => [e.type, e.label, e.level])).toEqual(
      expect.arrayContaining([
        ['room', '#financeiro', 2],
        ['role', 'Operação', 1],
      ]),
    );
    expect((await folder(root, ana)).folder.level).toBe(3);
    expect((await folder(root, bruno)).folder.level).toBe(2);
    expect((await folder(root, davi)).folder.level).toBe(1);
    expect((await folder(root, carla)).status).toBe(404);
    // Quem não gerencia não vê o compartilhamento.
    expect((await folder(root, bruno)).acl).toBeUndefined();
    expect((await folder(root, ana)).acl.length).toBe(4);
    // A pasta aparece no início de quem tem acesso.
    expect((await api('GET', 'files.home', undefined, bruno)).folders.map((f: any) => f.name)).toEqual(['Financeiro']);
  });

  it('quem edita não compartilha; ninguém compartilha com canal que não vê', async () => {
    expect((await share(root, [], bruno)).status).toBe(403);
    const secret = await api('POST', 'groups.create', { name: 'diretoria', members: [] }, A);
    expect((await share(root, [{ type: 'room', id: secret.group._id, level: 1 }], ana)).errorType).toBe('error-invalid-subject');
    expect((await share(root, [{ type: 'role', id: 'nao-existe', level: 1 }], ana)).errorType).toBe('error-invalid-subject');
    expect((await share(root, [{ type: 'user', id: carla.userId, level: 9 }], ana)).status).toBe(400);
  });

  it('seletor do compartilhamento acha papéis, canais e pessoas', async () => {
    const r = await api('GET', 'files.subjects', { text: 'Carla' }, ana);
    expect(r.subjects.some((s: any) => s.type === 'user' && s.id === carla.userId)).toBe(true);
    const roles = await api('GET', 'files.subjects', { text: '' }, ana);
    expect(roles.subjects.some((s: any) => s.type === 'role' && s.id === 'user')).toBe(true);
    expect(roles.subjects.some((s: any) => s.id === 'anonymous')).toBe(false);
  });
});

describe('subpastas e herança', () => {
  let sub = '';
  let secret = '';
  it('quem edita cria subpasta, que herda o acesso', async () => {
    expect((await api('POST', 'files.folder.create', { name: 'Notas', parentId: root }, davi)).status).toBe(403);
    const r = await api('POST', 'files.folder.create', { name: 'Notas fiscais', parentId: root }, bruno);
    expect(r.success, JSON.stringify(r)).toBe(true);
    sub = r.folder._id;
    expect((await folder(sub, davi)).folder.level).toBe(1);
    expect((await folder(sub, bruno)).path.map((p: any) => p.name)).toEqual(['Financeiro', 'Notas fiscais']);
  });

  it('desligar a herança deixa só o compartilhamento da pasta', async () => {
    const r = await api('POST', 'files.folder.create', { name: 'Salários', parentId: root }, ana);
    secret = r.folder._id;
    const s = await share(secret, [{ type: 'user', id: ana.userId, level: 3 }, { type: 'user', id: carla.userId, level: 1 }], ana, false);
    expect(s.success, JSON.stringify(s)).toBe(true);
    expect((await folder(secret, bruno)).status).toBe(404);
    expect((await folder(root, bruno)).folders.map((f: any) => f.name)).toEqual(['Notas fiscais']);
    // Carla não vê a pasta de cima: a subpasta vira uma pasta principal para ela, e o caminho começa nela.
    const home = await api('GET', 'files.home', undefined, carla);
    expect(home.folders.map((f: any) => f.name)).toEqual(['Salários']);
    expect((await folder(secret, carla)).path.map((p: any) => p.name)).toEqual(['Salários']);
    // O administrador (manage-all-files) vê tudo.
    expect((await folder(secret, A)).folder.level).toBe(3);
  });

  it('mover pasta: não entra nela mesma, e pede gerenciar', async () => {
    expect((await api('POST', 'files.move', { folderIds: [root], targetId: sub }, A)).errorType).toBe('error-invalid-move');
    expect((await api('POST', 'files.move', { folderIds: [sub], targetId: secret }, bruno)).status).toBe(404);
  });
});

describe('arquivos', () => {
  let fileId = '';
  it('quem edita envia; quem vê baixa; quem não tem acesso não acha', async () => {
    expect((await up(root, 'a.txt', 'oi', davi)).status).toBe(403);
    expect((await up(root, 'a.txt', 'oi', carla)).status).toBe(404);
    const r = await up(root, 'Relatório.txt', 'conteúdo do relatório', bruno);
    expect(r.success, JSON.stringify(r)).toBe(true);
    fileId = r.file._id;
    expect(r.file.size).toBe(Buffer.byteLength('conteúdo do relatório'));
    const dl = await raw(`${r.file.url}?download`, davi);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(await dl.text()).toBe('conteúdo do relatório');
    expect((await raw(r.file.url, carla)).status).toBe(404);
    expect((await raw(r.file.url)).status).toBe(403);
  });

  it('mesmo nome vira "nome (2)"; renomear para um nome ocupado é recusado', async () => {
    const r = await up(root, 'relatório.txt', 'outro', bruno);
    expect(r.file.name).toBe('relatório (2).txt');
    expect((await api('POST', 'files.rename', { fileId: r.file._id, name: 'Relatório.txt' }, bruno)).errorType).toBe('error-name-taken');
    expect((await api('POST', 'files.rename', { fileId: r.file._id, name: 'Resumo.txt' }, davi)).status).toBe(403);
    expect((await api('POST', 'files.rename', { fileId: r.file._id, name: 'Resumo.txt' }, bruno)).success).toBe(true);
    const view = await folder(root, davi);
    expect(view.files.map((f: any) => f.name)).toEqual(['Relatório.txt', 'Resumo.txt']);
    expect(view.folder.items).toBe(3); // 2 arquivos + a subpasta visível
  });

  it('busca e recentes respeitam o acesso', async () => {
    const s = await api('GET', 'files.search', { text: 'relat' }, davi);
    expect(s.files.map((f: any) => f.name)).toEqual(['Relatório.txt']);
    expect(s.files[0].path.map((p: any) => p.name)).toEqual(['Financeiro']);
    expect((await api('GET', 'files.search', { text: 'relat' }, carla)).files).toEqual([]);
    expect((await api('GET', 'files.recent', undefined, bruno)).files.length).toBe(2);
  });

  it('lixeira: quem edita manda e restaura; só quem gerencia apaga de vez, e o disco libera', async () => {
    const row = await one('SELECT storage_path FROM drive_files WHERE id = $1', [fileId]);
    expect((await api('POST', 'files.trash', { fileIds: [fileId] }, davi)).status).toBe(403);
    expect((await api('POST', 'files.trash', { fileIds: [fileId] }, bruno)).success).toBe(true);
    expect((await folder(root, bruno)).files.map((f: any) => f._id)).not.toContain(fileId);
    expect((await api('GET', 'files.trash.list', undefined, bruno)).files.map((f: any) => f._id)).toEqual([fileId]);
    expect((await api('POST', 'files.restore', { fileIds: [fileId] }, bruno)).success).toBe(true);
    await api('POST', 'files.trash', { fileIds: [fileId] }, bruno);
    expect((await api('POST', 'files.purge', { fileIds: [fileId] }, bruno)).status).toBe(403);
    expect((await api('POST', 'files.purge', { fileIds: [fileId] }, ana)).removed).toBe(1);
    expect(fs.existsSync(storedPath(row.storage_path))).toBe(false);
  });

  it('pasta na lixeira leva tudo de dentro junto e a restauração volta', async () => {
    const f = await api('POST', 'files.folder.create', { name: 'Temporária', parentId: root }, ana);
    await up(f.folder._id, 'x.txt', 'x', ana);
    expect((await api('POST', 'files.trash', { folderIds: [f.folder._id] }, bruno)).status).toBe(403); // pasta pede gerenciar
    expect((await api('POST', 'files.trash', { folderIds: [f.folder._id] }, ana)).success).toBe(true);
    expect((await folder(f.folder._id, ana)).status).toBe(404);
    expect((await api('GET', 'files.trash.list', undefined, ana)).folders.map((x: any) => x.name)).toContain('Temporária');
    expect((await api('POST', 'files.restore', { folderIds: [f.folder._id] }, ana)).success).toBe(true);
    expect((await folder(f.folder._id, ana)).files.length).toBe(1);
    // Vencida na lixeira: a tarefa diária apaga a pasta e os arquivos.
    await api('POST', 'files.trash', { folderIds: [f.folder._id] }, ana);
    await query("UPDATE drive_folders SET trashed_at = now() - interval '40 days' WHERE id = $1", [f.folder._id]);
    const r = await purgeExpiredTrash();
    expect(r.folders).toBe(1);
    expect(await one('SELECT 1 FROM drive_folders WHERE id = $1', [f.folder._id])).toBeNull();
  });

  it('cota cheia recusa o envio com aviso claro', async () => {
    await api('POST', 'settings', { settings: { Drive_Quota_GB: 1 } }, A);
    await query("INSERT INTO drive_files (id, folder_id, name, type, size, storage_path) VALUES ('grandeAAAAAAAAAAA', $1, 'grande.bin', 'application/octet-stream', $2, '2026/01/grandeAAAAAAAAAAA')", [root, 1024 ** 3]);
    const r = await up(root, 'b.txt', 'b', bruno);
    expect(r.status).toBe(507);
    expect(r.errorType).toBe('error-quota-exceeded');
    await query("DELETE FROM drive_files WHERE id = 'grandeAAAAAAAAAAA'");
    await api('POST', 'settings', { settings: { Drive_Quota_GB: 20 } }, A);
    const s = await api('GET', 'files.storage', undefined, bruno);
    expect(s.storage.quota).toBe(20 * 1024 ** 3);
  });

  it('arquivo maior que o limite é recusado', async () => {
    await api('POST', 'settings', { settings: { Drive_MaxFileSize_MB: 1 } }, A);
    const r = await up(root, 'big.bin', 'x'.repeat(1024 * 1024 + 10), bruno, 'application/octet-stream');
    expect(r.status).toBe(413);
    await api('POST', 'settings', { settings: { Drive_MaxFileSize_MB: 200 } }, A);
  });

  it('histórico: só quem gerencia vê, com envios, downloads e compartilhamento', async () => {
    expect((await api('GET', 'files.activity', { folderId: root }, bruno)).status).toBe(403);
    const r = await api('GET', 'files.activity', { folderId: root }, ana);
    const actions = r.events.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['file.upload', 'file.download', 'acl.update', 'file.rename', 'file.trash', 'file.purge', 'folder.add']));
    const audit = await one("SELECT 1 FROM audit_log WHERE action = 'drive.acl.update'");
    expect(audit).not.toBeNull();
  });
});
