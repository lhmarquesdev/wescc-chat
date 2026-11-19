import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool';
import { purgeExpiredTrash } from '../src/drive/drive';
import { storedPath } from '../src/services/uploads';
import { admin, api, connectWs, newUser, raw, startServer, stopServer, urlOf, type Auth } from './helpers';

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

  it('pasta principal ou restrita não fica sem ninguém que gerencia', async () => {
    const r = await share(root, [{ type: 'user', id: ana.userId, level: 2 }], ana);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-no-manager');
    expect((await folder(root, ana)).folder.level).toBe(3);
    // Subpasta que herda pode ficar sem lista própria; restrita, não.
    const s = (await api('POST', 'files.folder.create', { name: 'Herdeira', parentId: root }, ana)).folder._id;
    expect((await share(s, [], ana)).success).toBe(true);
    expect((await share(s, [{ type: 'user', id: carla.userId, level: 1 }], ana, false)).errorType).toBe('error-no-manager');
    // Quem gerencia todas as pastas pode deixar só para administradores.
    expect((await share(s, [], A, false)).success).toBe(true);
    await api('POST', 'files.trash', { folderIds: [s] }, A);
    await api('POST', 'files.purge', { folderIds: [s] }, A);
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
    expect(view.folder.subfolders).toBe(1); // a árvore só mostra a seta quando há subpasta
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
    expect((await api('POST', 'files.trash', { folderIds: [f.folder._id] }, davi)).status).toBe(403); // só vê
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

  it('quem edita move e manda para a lixeira subpasta que herda o acesso; principal e restrita pedem gerenciar', async () => {
    const a = (await api('POST', 'files.folder.create', { name: 'Criada por engano', parentId: root }, bruno)).folder;
    const b = (await api('POST', 'files.folder.create', { name: 'Destino', parentId: root }, bruno)).folder;
    expect(a.level).toBe(2);
    expect(a.parentLevel).toBe(2);
    expect((await api('POST', 'files.move', { folderIds: [a._id], targetId: b._id }, davi)).status).toBe(403);
    expect((await api('POST', 'files.move', { folderIds: [a._id], targetId: b._id }, bruno)).success).toBe(true);
    expect((await folder(a._id, bruno)).path.map((p: any) => p.name)).toEqual(['Financeiro', 'Destino', 'Criada por engano']);
    expect((await api('POST', 'files.trash', { folderIds: [root] }, bruno)).status).toBe(403);
    expect((await api('POST', 'files.trash', { folderIds: [b._id] }, bruno)).success).toBe(true);
    expect((await api('GET', 'files.trash.list', undefined, bruno)).folders.map((x: any) => x.name)).toContain('Destino');
    expect((await api('POST', 'files.purge', { folderIds: [b._id] }, bruno)).status).toBe(403); // apagar de vez pede gerenciar
    expect((await api('POST', 'files.restore', { folderIds: [b._id] }, bruno)).success).toBe(true);
    expect((await folder(a._id, bruno)).folder.level).toBe(2);
    // Subpasta restrita: mesmo quem edita nela não a move nem a manda para a lixeira.
    await share(b._id, [{ type: 'user', id: ana.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 2 }], ana, false);
    expect((await api('POST', 'files.trash', { folderIds: [b._id] }, bruno)).status).toBe(403);
    expect((await api('POST', 'files.move', { folderIds: [b._id], targetId: a._id }, bruno)).status).toBe(403);
    expect((await api('POST', 'files.trash', { folderIds: [b._id] }, ana)).success).toBe(true);
    expect((await api('POST', 'files.purge', { folderIds: [b._id] }, ana)).success).toBe(true);
  });

  it('com a aba desligada nada responde, nem o download', async () => {
    const f = (await up(root, 'aba-desligada.txt', 'x', bruno)).file;
    await api('POST', 'settings', { settings: { Drive_Enabled: false } }, A);
    try {
      for (const [method, path, body] of [
        ['GET', 'files.home', undefined],
        ['GET', 'files.folder', { folderId: root }],
        ['GET', 'files.search', { text: 'aba' }],
        ['GET', 'files.recent', undefined],
        ['GET', 'files.trash.list', undefined],
        ['POST', 'files.rename', { fileId: f._id, name: 'outro.txt' }],
        ['POST', 'files.trash', { fileIds: [f._id] }],
        ['POST', 'files.folder.share', { folderId: root, entries: [] }],
      ] as const) {
        const r = await api(method, path, body, bruno);
        expect(r.status, path).toBe(403);
        expect(r.error, path).toBe('A aba Arquivos está desligada.');
      }
      const dl = await raw(`${f.url}?download`, bruno);
      expect(dl.status).toBe(403);
      // O administrador também não: a aba está desligada para todos.
      expect((await api('GET', 'files.folder', { folderId: root }, A)).status).toBe(403);
    } finally {
      await api('POST', 'settings', { settings: { Drive_Enabled: true } }, A);
    }
    expect((await api('GET', 'files.folder', { folderId: root }, bruno)).files.map((x: any) => x.name)).toContain('aba-desligada.txt');
  });

  it('caracteres invisíveis de direção saem do nome (envio, renomear e nomes já gravados)', async () => {
    const r = await up(root, 'relatorio-anual\u202efdp.exe', 'MZ', bruno, 'application/octet-stream');
    expect(r.file.name).toBe('relatorio-anualfdp.exe');
    expect((await api('POST', 'files.rename', { fileId: r.file._id, name: '\u2066planilha\u2069\u200f.xlsx' }, bruno)).success).toBe(true);
    expect((await one('SELECT name FROM drive_files WHERE id = $1', [r.file._id]))!.name).toBe('planilha.xlsx');
    expect((await api('POST', 'files.folder.create', { name: '\u202e\u200b' }, A)).errorType).toBe('error-invalid-name');
    // Gravados antes da correção: a migração 038 limpa, sem repetir nome na pasta.
    const ins = (id: string, name: string) =>
      query("INSERT INTO drive_files (id, folder_id, name, type, size, storage_path) VALUES ($1, $2, $3, 'text/plain', 1, '2026/01/' || $1)", [id, root, name]);
    await ins('bidiAAAAAAAAAAAAA', 'Duplicado.txt');
    await ins('bidiBBBBBBBBBBBBB', 'duplicado\u202e.txt');
    await ins('bidiCCCCCCCCCCCCC', 'contrato\u202efdp.exe');
    await query("INSERT INTO drive_folders (id, parent_id, name) VALUES ('bidiPASTAAAAAAAAA', $1, $2)", [root, '\u202e']);
    const sql = fs.readFileSync(new URL('../src/db/migrations/038_arquivos.sql', import.meta.url), 'utf8');
    await query(sql);
    await query(sql); // de novo: nada muda
    const names = async (ids: string[]) => (await many('SELECT id, name FROM drive_files WHERE id = ANY($1) ORDER BY id', [ids])).map((x: any) => x.name);
    expect(await names(['bidiAAAAAAAAAAAAA', 'bidiBBBBBBBBBBBBB', 'bidiCCCCCCCCCCCCC'])).toEqual(['Duplicado.txt', 'duplicado (2).txt', 'contratofdp.exe']);
    expect((await one("SELECT name FROM drive_folders WHERE id = 'bidiPASTAAAAAAAAA'"))!.name).toBe('pasta');
    await query("DELETE FROM drive_files WHERE id LIKE 'bidi%'");
    await query("DELETE FROM drive_folders WHERE id = 'bidiPASTAAAAAAAAA'");
  });

  it('abrir um tipo que o navegador não mostra conta como download; prévia e PDF aberto, não', async () => {
    const xlsx = (await up(root, 'planilha.xlsx', 'PK', bruno, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).file;
    const pdf = (await up(root, 'manual.pdf', '%PDF-1.4', bruno, 'application/pdf')).file;
    const txt = (await up(root, 'notas.txt', 'notas', bruno)).file;
    const downloads = async (fileId: string) =>
      (await api('GET', 'files.activity', { folderId: root, count: 200 }, ana)).events.filter((e: any) => e.action === 'file.download' && e.fileId === fileId).length;
    const open = await raw(xlsx.url, davi);
    expect(open.headers.get('content-disposition')).toContain('attachment');
    expect(await downloads(xlsx._id)).toBe(1);
    expect((await raw(pdf.url, davi)).headers.get('content-disposition')).toContain('inline');
    expect(await downloads(pdf._id)).toBe(0);
    expect((await raw(`${txt.url}?preview`, davi)).status).toBe(200);
    expect(await downloads(txt._id)).toBe(0);
    await raw(`${pdf.url}?download`, davi);
    expect(await downloads(pdf._id)).toBe(1);
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

describe('subpasta restrita dentro de uma pasta que outra pessoa gerencia', () => {
  let rh = '';
  let secret = '';
  beforeAll(async () => {
    rh = (await api('POST', 'files.folder.create', { name: 'RH' }, A)).folder._id;
    await share(rh, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 3 }, { type: 'user', id: carla.userId, level: 2 }], A);
    secret = (await api('POST', 'files.folder.create', { name: 'Demissões sigilosas', parentId: rh }, A)).folder._id;
    const s = await share(secret, [{ type: 'user', id: carla.userId, level: 3 }], A, false);
    expect(s.success, JSON.stringify(s)).toBe(true);
    expect((await up(secret, 'desligamento-fulano.pdf', 'sigilo', carla, 'application/pdf')).success).toBe(true);
  });

  it('o histórico da pasta de cima não mostra nada da subpasta restrita para quem não a acessa', async () => {
    // carla leva um arquivo de RH para a subpasta restrita: RH registra para onde foi.
    const f = await up(rh, 'carta.txt', 'carta', carla);
    expect((await api('POST', 'files.move', { fileIds: [f.file._id], targetId: secret }, carla)).success).toBe(true);
    const r = await api('GET', 'files.activity', { folderId: rh }, bruno);
    expect(r.success, JSON.stringify(r)).toBe(true);
    const text = JSON.stringify(r.events);
    expect(text).not.toContain('desligamento-fulano');
    expect(text).not.toContain('Demissões sigilosas');
    expect(text).not.toContain(secret);
    expect(r.events.find((e: any) => e.action === 'file.move.out').data.to).toBe('uma pasta que você não acessa');
    expect(r.total).toBe(r.events.length);
    // Quem gerencia todas as pastas vê tudo.
    const all = JSON.stringify((await api('GET', 'files.activity', { folderId: rh }, A)).events);
    expect(all).toContain('desligamento-fulano');
    expect(all).toContain('Demissões sigilosas');
  });

  it('quem gerencia a pasta de cima não manda para a lixeira nem apaga de vez a subpasta restrita dos outros', async () => {
    const t = await api('POST', 'files.trash', { folderIds: [rh] }, bruno);
    expect(t.status).toBe(400);
    expect(t.errorType).toBe('error-restricted-inside');
    expect(t.error).toContain('não acessa');
    expect((await folder(rh, bruno)).folder.trashedAt).toBeNull();
    // O administrador pode (vê tudo): a subpasta vai junto, e quem a gerencia a encontra na própria lixeira.
    expect((await api('POST', 'files.trash', { folderIds: [rh] }, A)).success).toBe(true);
    const ct = await api('GET', 'files.trash.list', undefined, carla);
    expect(ct.folders.map((f: any) => f.name)).toEqual(['Demissões sigilosas']);
    expect(ct.folders[0].trashedAt).not.toBeNull();
    const rs = await api('POST', 'files.restore', { folderIds: [secret] }, carla);
    expect(rs.errorType).toBe('error-parent-trashed');
    expect(rs.error).toContain('Peça a quem a gerencia');
    // Apagar de vez também não leva junto o que é dos outros; esvaziar a lixeira deixa a pasta lá.
    const p = await api('POST', 'files.purge', { folderIds: [rh] }, bruno);
    expect(p.errorType).toBe('error-restricted-inside');
    expect((await api('POST', 'files.purge', { all: true }, bruno)).removed).toBe(0);
    expect(await one('SELECT 1 FROM drive_folders WHERE id = $1', [secret])).not.toBeNull();
    expect((await api('POST', 'files.restore', { folderIds: [rh] }, A)).success).toBe(true);
    expect((await folder(rh, carla)).folders.map((f: any) => f.name)).toContain('Demissões sigilosas');
  });

  it('quem gerencia só a subpasta vê quem herda o acesso, mas não o nome da pasta de cima', async () => {
    const top = (await api('POST', 'files.folder.create', { name: 'Diretoria confidencial' }, A)).folder._id;
    await share(top, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 2 }], A);
    const atas = (await api('POST', 'files.folder.create', { name: 'Atas para a qualidade', parentId: top }, A)).folder._id;
    await share(atas, [{ type: 'user', id: carla.userId, level: 3 }], A);
    const v = await folder(atas, carla);
    expect(v.path.map((p: any) => p.name)).toEqual(['Atas para a qualidade']);
    expect(JSON.stringify(v)).not.toContain('Diretoria confidencial');
    const inherited = v.acl.filter((e: any) => e.from);
    expect(inherited.map((e: any) => e.label).sort()).toEqual(['Administrador', 'Bruno Lima']);
    expect(inherited.every((e: any) => e.from._id === '' && e.from.name === '')).toBe(true);
    // A resposta de salvar o compartilhamento segue a mesma regra; quem vê a pasta de cima vê o nome.
    expect(JSON.stringify(await share(atas, [{ type: 'user', id: carla.userId, level: 3 }], carla))).not.toContain('Diretoria confidencial');
    expect((await folder(atas, A)).acl.find((e: any) => e.from).from.name).toBe('Diretoria confidencial');
  });

  it('evento antigo, sem o id da subpasta, também some pelo nome', async () => {
    await query("INSERT INTO drive_activity (id, folder_id, actor_id, actor_username, action, data) VALUES ('legadoAAAAAAAAAAA', $1, $2, 'admin', 'folder.add', $3)", [
      rh,
      A.userId,
      JSON.stringify({ name: 'Demissões sigilosas' }),
    ]);
    const r = await api('GET', 'files.activity', { folderId: rh }, bruno);
    expect(r.events.map((e: any) => e._id)).not.toContain('legadoAAAAAAAAAAA');
    expect((await api('GET', 'files.activity', { folderId: rh }, A)).events.map((e: any) => e._id)).toContain('legadoAAAAAAAAAAA');
  });

  it('subpasta restrita levada para outro lugar ou apagada de vez continua fora do histórico de cima', async () => {
    const mk = async (name: string) => {
      const id = (await api('POST', 'files.folder.create', { name, parentId: rh }, A)).folder._id;
      expect((await share(id, [{ type: 'user', id: carla.userId, level: 3 }], A, false)).success).toBe(true);
      return id;
    };
    const gone = await mk('Sigilo apagado');
    const away = await mk('Sigilo levado');
    const dest = (await api('POST', 'files.folder.create', { name: 'Pasta da Carla' }, A)).folder._id;
    await share(dest, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: carla.userId, level: 3 }], A);
    expect((await api('POST', 'files.trash', { folderIds: [gone] }, carla)).success).toBe(true);
    expect((await api('POST', 'files.purge', { folderIds: [gone] }, carla)).success).toBe(true);
    expect((await api('POST', 'files.move', { folderIds: [away], targetId: dest }, carla)).success).toBe(true);
    const text = JSON.stringify((await api('GET', 'files.activity', { folderId: rh }, bruno)).events);
    expect(text).not.toContain('Sigilo apagado');
    expect(text).not.toContain('Sigilo levado');
    const all = JSON.stringify((await api('GET', 'files.activity', { folderId: rh }, A)).events);
    expect(all).toContain('Sigilo apagado');
    expect(all).toContain('Sigilo levado');
  });
});

describe('nomes, avisos e limites', () => {
  let eq = '';
  let hidden = '';
  beforeAll(async () => {
    eq = (await api('POST', 'files.folder.create', { name: 'Equipe' }, A)).folder._id;
    await share(eq, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 2 }, { type: 'user', id: carla.userId, level: 3 }], A);
    hidden = (await api('POST', 'files.folder.create', { name: 'Avaliações individuais', parentId: eq }, A)).folder._id;
    await share(hidden, [{ type: 'user', id: carla.userId, level: 3 }], A, false);
  });

  it('pasta com o nome de uma subpasta restrita que a pessoa não vê é criada como "nome (2)", sem revelar a outra', async () => {
    expect((await folder(eq, bruno)).folders.map((f: any) => f.name)).toEqual([]);
    const r = await api('POST', 'files.folder.create', { name: 'avaliações individuais', parentId: eq }, bruno);
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.folder.name).toBe('avaliações individuais (2)');
    // Com a outra visível, o aviso de nome repetido continua.
    expect((await api('POST', 'files.folder.create', { name: 'Avaliações individuais', parentId: eq }, carla)).errorType).toBe('error-name-taken');
    // Renomear para o nome escondido também não revela.
    const x = (await api('POST', 'files.folder.create', { name: 'Rascunho', parentId: eq }, bruno)).folder;
    const u = await api('POST', 'files.folder.update', { folderId: x._id, name: 'AVALIAÇÕES INDIVIDUAIS' }, bruno);
    expect(u.success, JSON.stringify(u)).toBe(true);
    expect(u.name).toBe('AVALIAÇÕES INDIVIDUAIS (3)');
    expect((await api('POST', 'files.folder.update', { folderId: x._id, name: 'avaliações individuais (2)' }, bruno)).errorType).toBe('error-name-taken');
  });

  it('nome longo é cortado sem perder a extensão nem partir um emoji; ".." tem aviso próprio', async () => {
    const long = `${'Relatório trimestral de indicadores '.repeat(7)}.xlsx`;
    const f = (await up(eq, long, 'x', bruno, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).file;
    expect(f.name.endsWith('.xlsx')).toBe(true);
    expect(Array.from(f.name).length).toBeLessThanOrEqual(200);
    // De novo: o "(2)" cabe no limite (antes estourava o limite do banco e dava erro 500).
    const again = await up(eq, long, 'y', bruno, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(again.success, JSON.stringify(again)).toBe(true);
    expect(again.file.name.endsWith(' (2).xlsx')).toBe(true);
    expect(Array.from(again.file.name).length).toBeLessThanOrEqual(200);
    const emo = (await api('POST', 'files.folder.create', { name: `${'a'.repeat(119)}📁`, parentId: eq }, bruno)).folder;
    expect(emo.name).toBe(`${'a'.repeat(119)}📁`); // 120 caracteres: cabe inteiro (antes virava "a…a\ufffd")
    const thumb = (await api('POST', 'files.folder.create', { name: `${'b'.repeat(119)}👍🏽`, parentId: eq }, bruno)).folder;
    expect(thumb.name).toBe('b'.repeat(119)); // não cabe: sai o emoji inteiro, sem sobrar meio emoji
    expect((await api('POST', 'files.folder.create', { name: 'c'.repeat(150), parentId: eq }, bruno)).folder.name).toBe('c'.repeat(120));
    const dots = await api('POST', 'files.folder.create', { name: '..', parentId: eq }, bruno);
    expect(dots.errorType).toBe('error-invalid-name');
    expect(dots.error).toBe('Nome inválido: use letras ou números.');
    expect((await api('POST', 'files.folder.create', { name: '  ', parentId: eq }, bruno)).error).toBe('Dê um nome à pasta.');
    expect((await api('POST', 'files.rename', { fileId: f._id, name: '...' }, bruno)).error).toBe('Nome inválido: use letras ou números.');
  });

  it('mover e restaurar dizem quando o item ficou com outro nome', async () => {
    const a = (await up(eq, 'escala.csv', 'v1', bruno, 'text/csv')).file;
    const b = (await up(eq, 'escala.csv', 'v2', bruno, 'text/csv')).file;
    expect(b.name).toBe('escala (2).csv');
    await api('POST', 'files.trash', { fileIds: [a._id] }, bruno);
    await api('POST', 'files.rename', { fileId: b._id, name: 'escala.csv' }, bruno);
    const r = await api('POST', 'files.restore', { fileIds: [a._id] }, bruno);
    expect(r.renamed).toEqual([{ _id: a._id, from: 'escala.csv', name: 'escala (2).csv' }]);
    const dest = (await api('POST', 'files.folder.create', { name: 'Destino', parentId: eq }, bruno)).folder;
    await up(dest._id, 'escala.csv', 'v3', bruno, 'text/csv');
    const m = await api('POST', 'files.move', { fileIds: [b._id], targetId: dest._id }, bruno);
    expect(m.renamed).toEqual([{ _id: b._id, from: 'escala.csv', name: 'escala (2).csv' }]);
    expect((await api('POST', 'files.restore', { fileIds: [] }, bruno)).renamed).toEqual([]);
  });

  it('"na lixeira" conta os arquivos de dentro de uma pasta mandada para a lixeira', async () => {
    const s0 = (await api('GET', 'files.storage', undefined, A)).storage;
    const lixo = (await api('POST', 'files.folder.create', { name: 'Lixo', parentId: eq }, bruno)).folder;
    const sub = (await api('POST', 'files.folder.create', { name: 'Dentro', parentId: lixo._id }, bruno)).folder;
    await up(lixo._id, 'grande.log', 'z'.repeat(10000), bruno);
    await up(sub._id, 'menor.log', 'z'.repeat(500), bruno);
    await api('POST', 'files.trash', { folderIds: [lixo._id] }, bruno);
    const s1 = (await api('GET', 'files.storage', undefined, A)).storage;
    expect(s1.trash - s0.trash).toBe(10500);
    expect(s1.used - s0.used).toBe(10500);
  });

  it('apagar de vez avisa as outras telas (Lixeira e medidor de espaço)', async () => {
    const f = (await up(eq, 'apagar.txt', 'x', carla)).file;
    await api('POST', 'files.trash', { fileIds: [f._id] }, carla);
    const ws = connectWs(bruno);
    await ws.ready;
    try {
      expect((await api('POST', 'files.purge', { fileIds: [f._id] }, carla)).removed).toBe(1);
      const ev = await ws.waitFor((e) => e.type === 'drive.changed' && e.folderIds.includes(eq));
      expect(ev.folderIds).toEqual([eq]);
    } finally {
      ws.close();
    }
  });

  it('histórico: compartilhamento com nomes e níveis, e a página seguinte', async () => {
    await share(eq, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 1 }, { type: 'user', id: carla.userId, level: 3 }, { type: 'user', id: davi.userId, level: 2 }], A);
    await share(eq, [{ type: 'user', id: A.userId, level: 3 }, { type: 'user', id: bruno.userId, level: 1 }, { type: 'user', id: carla.userId, level: 3 }], A);
    const r = await api('GET', 'files.activity', { folderId: eq, count: 2 }, carla);
    expect(r.events.map((e: any) => e.action)).toEqual(['acl.update', 'acl.update']);
    expect(r.events[0].data.removed).toEqual([{ key: `user:${davi.userId}`, label: 'Davi Rocha', level: 2 }]);
    expect(r.events[1].data.added).toEqual([{ key: `user:${davi.userId}`, label: 'Davi Rocha', level: 2 }]);
    expect(r.events[1].data.changed).toEqual([{ key: `user:${bruno.userId}`, label: 'Bruno Lima', level: 1, from: 2 }]);
    expect(r.total).toBeGreaterThan(2);
    // Página seguinte (Ver mais).
    const next = await api('GET', 'files.activity', { folderId: eq, count: 2, offset: 2 }, carla);
    expect(next.events.map((e: any) => e._id)).not.toContain(r.events[0]._id);
  });

  it('histórico com offset ou count fora do normal não dá erro 500', async () => {
    for (const offset of ['1e309', '-5', '1.5', 'abc', '99999999999999999999']) {
      const x = await api('GET', 'files.activity', { folderId: eq, offset }, carla);
      expect(x.status, offset).toBe(200);
    }
    expect((await api('GET', 'files.activity', { folderId: eq, offset: '1e309' }, carla)).events).toEqual([]);
    expect((await api('GET', 'files.activity', { folderId: eq, count: '1e309' }, carla)).events.length).toBeGreaterThan(0);
  });

  it('link do arquivo aberto no navegador sem acesso mostra uma página em português, não o JSON', async () => {
    const f = (await up(hidden, 'avaliacao-fulano.txt', 'sigilo', carla)).file;
    const open = (auth: Auth | null, headers: Record<string, string>) =>
      fetch(urlOf(f.url), { headers: { ...headers, ...(auth ? { cookie: `rc_uid=${auth.userId}; rc_token=${auth.authToken}` } : {}) } });
    const ok = await open(carla, { accept: 'text/html', 'sec-fetch-dest': 'document' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('sigilo');
    const page = await open(bruno, { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' });
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Não deu para abrir este arquivo');
    expect(html).toContain('Peça a quem gerencia a pasta');
    expect(html).not.toContain('errorType');
    const anon = await open(null, { accept: 'text/html' });
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain('Entre para abrir este arquivo');
    // Prévias da tela (imagem, fetch) e chamadas da API seguem com o JSON.
    const img = await open(bruno, { accept: 'image/*', 'sec-fetch-dest': 'image' });
    expect(img.status).toBe(404);
    expect((await img.json()).errorType).toBe('error-file-not-found');
  });
});
