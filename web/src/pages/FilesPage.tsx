// Arquivos: pastas compartilhadas com permissão por pasta. Início (pastas e recentes), pasta, busca e lixeira.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { FOLDER_COLORS, driveLevelLabel, type DriveActivity, type DriveFile, type DriveFolder, type DriveFolderView, type DriveStorage } from '@shared/drive';
import { errorMessage } from '../lib/api';
import { cancelUpload, clearFinishedUploads, enqueueUploads, filesApi, useUploads } from '../lib/files';
import { formatBytes, formatRelative, formatWhen, plural } from '../lib/format';
import { realtime } from '../lib/realtime';
import { useSetting, useStore } from '../lib/store';
import { fileKind } from '../components/MessageItem';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/icons';
import { useIsPhone } from '../components/overlay';
import { confirmDialog, Empty, Menu, Modal, SearchInput, Segmented, Skeleton, Spinner } from '../components/ui';
import { ShareDialog } from '../components/files/ShareDialog';
import '../components/files/files.css';

type ViewMode = 'grid' | 'list';
const VIEW_KEY = 'wescc.files.view';

const KIND_ICON: Record<string, IconName> = {
  pdf: 'file-doc',
  doc: 'file-doc',
  sheet: 'file-sheet',
  image: 'file-image',
  video: 'file-video',
  audio: 'file-audio',
  archive: 'file-archive',
  code: 'file-code',
  other: 'file',
};
const kindOf = (f: { name: string; type: string }) => fileKind(f.name, f.type);
const isText = (f: DriveFile) => /^text\//.test(f.type) || /\.(txt|md|csv|log|json|xml|ya?ml|ini|sql)$/i.test(f.name);
const canPreview = (f: DriveFile) => /^(image|video|audio)\//.test(f.type) || f.type === 'application/pdf' || isText(f);
const LEVEL_ICON: Record<number, IconName> = { 1: 'files-view', 2: 'files-edit', 3: 'files-manage' };
const COLOR_LABEL: Record<string, string> = { blue: 'Azul', green: 'Verde', amber: 'Âmbar', red: 'Vermelho', purple: 'Roxo', teal: 'Turquesa', gray: 'Cinza' };

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function FilesPage() {
  const { folderId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const toast = useStore((s) => s.toast);
  const enabled = useSetting<boolean>('Drive_Enabled') !== false;
  const trash = location.pathname === '/files/trash';
  const [view, setViewState] = useState<ViewMode>(readView);
  const [search, setSearch] = useState('');
  const [home, setHome] = useState<Awaited<ReturnType<typeof filesApi.home>> | null>(null);
  const [data, setData] = useState<DriveFolderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: 'file'; file: DriveFile } | { kind: 'folder'; folder: DriveFolder } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [dragOver, setDragOver] = useState(false);
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  const setView = (v: ViewMode) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // armazenamento indisponível
    }
  };

  useEffect(() => {
    let alive = true;
    filesApi
      .home()
      .then((h) => alive && setHome(h))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    if (!folderId) {
      setData(null);
      return;
    }
    let alive = true;
    setError(null);
    filesApi
      .folder(folderId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setSelected((s) => (s?.kind === 'file' ? (d.files.find((f) => f._id === s.file._id) ? { kind: 'file', file: d.files.find((f) => f._id === s.file._id)! } : null) : s));
      })
      .catch((e) => alive && (setError(errorMessage(e)), setData(null)));
    return () => {
      alive = false;
    };
  }, [folderId, tick]);

  useEffect(() => setSelected(null), [folderId, trash]);

  // Outra pessoa mudou uma pasta que está na tela: pede de novo (o servidor confere o acesso).
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type !== 'drive.changed') return;
      if (!folderId || ev.folderIds.includes(folderId) || data?.folders.some((f) => ev.folderIds.includes(f._id))) reload();
    });
    return () => {
      off();
    };
  }, [folderId, data, reload]);

  // Envio terminado nesta pasta: atualiza a lista.
  const uploads = useUploads();
  const doneCount = uploads.filter((u) => u.state === 'done' && u.folderId === folderId).length;
  useEffect(() => {
    if (doneCount) reload();
  }, [doneCount, reload]);

  const folder = data?.folder ?? null;
  const canEdit = (folder?.level ?? 0) >= 2;
  const canManage = (folder?.level ?? 0) >= 3;
  const canCreateRoot = !!home?.canCreateRoot;

  const pickFiles = () => fileInput.current?.click();
  const send = (files: File[]) => {
    if (!folder || !files.length) return;
    const max = home?.storage.maxFileSize ?? Infinity;
    const big = files.filter((f) => f.size > max);
    if (big.length) toast(`${plural(big.length, 'arquivo passa', 'arquivos passam')} do limite de ${formatBytes(max)} e não ${big.length === 1 ? 'foi enviado' : 'foram enviados'}.`, 'warning');
    enqueueUploads(
      files.filter((f) => f.size <= max),
      { _id: folder._id, name: folder.name },
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canEdit) return;
    send([...e.dataTransfer.files]);
  };

  const newFolder = () =>
    setDialog(
      <NameDialog
        title={folder ? `Nova pasta em “${folder.name}”` : 'Nova pasta principal'}
        description={folder ? 'Ela começa com o mesmo acesso desta pasta.' : 'Só você terá acesso até compartilhar.'}
        confirm="Criar pasta"
        withColor
        onClose={() => setDialog(null)}
        onSave={async (name, color) => {
          const f = await filesApi.createFolder({ name, color, parentId: folder?._id ?? null });
          setDialog(null);
          toast(`Pasta “${f.name}” criada.`, 'success');
          if (!folder) navigate(`/files/f/${f._id}`);
          else reload();
        }}
      />,
    );

  const openShare = (f: DriveFolder) => {
    const show = (view: DriveFolderView) =>
      setDialog(
        <ShareDialog
          folder={view.folder}
          acl={view.acl ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />,
      );
    if (data && f._id === data.folder._id) show(data);
    else filesApi.folder(f._id).then(show, (e) => toast(errorMessage(e), 'error'));
  };

  const actions = useItemActions({ setDialog, reload, toast, navigate, openShare, parent: folder, onGone: () => setSelected(null) });

  let body: ReactNode;
  if (!enabled) body = <Empty icon="files-folder" title="A aba Arquivos está desligada">Um administrador pode ligá-la em Administração › Configurações › Arquivos.</Empty>;
  else if (trash) body = <TrashView onChanged={reload} />;
  else if (search.trim().length >= 2) body = <SearchResults text={search.trim()} view={view} onOpenFile={(f) => setSelected({ kind: 'file', file: f })} />;
  else if (folderId && error) body = <Empty icon="files-locked" title="Não deu para abrir esta pasta" tone="danger" action={<Link className="btn" to="/files">Voltar para Arquivos</Link>}>{error}</Empty>;
  else if (folderId)
    body = (
      <FolderContents
        data={data}
        view={view}
        selectedId={selected?.kind === 'file' ? selected.file._id : selected?.kind === 'folder' ? selected.folder._id : null}
        onSelectFile={(f) => setSelected({ kind: 'file', file: f })}
        onSelectFolder={(f) => setSelected({ kind: 'folder', folder: f })}
        onOpenFolder={(f) => navigate(`/files/f/${f._id}`)}
        actions={actions}
        onUpload={pickFiles}
        onNewFolder={newFolder}
      />
    );
  else
    body = (
      <HomeView
        home={home}
        error={error}
        view={view}
        onOpenFolder={(f) => navigate(`/files/f/${f._id}`)}
        onSelectFile={(f) => setSelected({ kind: 'file', file: f })}
        onNewFolder={newFolder}
        actions={actions}
      />
    );

  const details =
    selected && (selected.kind === 'file' ? (
      <FileDetails file={selected.file} level={selected.file.level ?? folder?.level ?? 1} actions={actions} onClose={() => setSelected(null)} />
    ) : (
      <FolderDetails folder={selected.folder} actions={actions} onClose={() => setSelected(null)} />
    ));

  const title = trash ? 'Lixeira' : folder?.name ?? 'Arquivos';
  return (
    <div className="page fl-page" onDragOver={(e) => canEdit && (e.preventDefault(), setDragOver(true))} onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)} onDrop={onDrop}>
      <header className="page-head fl-head">
        <h1>Arquivos</h1>
        {!phone && <SearchInput className="fl-search" value={search} onChange={setSearch} placeholder="Buscar em todas as pastas" />}
        <div className="fl-head-actions">
          {(folder ? canEdit : canCreateRoot) && !trash && (
            <button type="button" className="btn" onClick={newFolder}>
              <Icon name="files-folder-new" />
              {phone ? 'Pasta' : 'Nova pasta'}
            </button>
          )}
          {folder && canEdit && !trash && (
            <button type="button" className="btn primary" onClick={pickFiles}>
              <Icon name="files-upload" />
              Enviar
            </button>
          )}
        </div>
      </header>
      {phone && (
        <div className="fl-phone-search">
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar em todas as pastas" />
        </div>
      )}
      <div className={details && !phone ? 'fl-layout with-details' : 'fl-layout'}>
        {!phone && <FilesNav home={home} currentId={folderId ?? null} path={data?.path ?? []} trash={trash} />}
        <main className="fl-main" aria-label={title}>
          {!trash && !search && folderId && <Breadcrumb data={data} />}
          {!trash && !(search.trim().length >= 2) && (folderId ? data : home) && (
            <div className="fl-toolbar">
              {folder ? (
                <div className="fl-folder-meta">
                  <span className={`fl-level l${folder.level}`}>
                    <Icon name={LEVEL_ICON[folder.level]} size={14} />
                    {driveLevelLabel(folder.level)}
                  </span>
                  {!folder.inherit && (
                    <span className="fl-level restricted" title="Não herda o acesso da pasta de cima">
                      <Icon name="files-locked" size={14} />
                      Restrita
                    </span>
                  )}
                  <span className="muted">
                    {plural(folder.items ?? 0, 'item', 'itens')} · {formatBytes(folder.size ?? 0)}
                  </span>
                </div>
              ) : (
                <span className="muted">Pastas compartilhadas com você</span>
              )}
              <div className="fl-toolbar-right">
                {folder && canManage && (
                  <button type="button" className="btn small" onClick={() => openShare(folder)}>
                    <Icon name="files-share" />
                    Compartilhar
                  </button>
                )}
                {folder && (
                  <Menu
                    label="Mais ações da pasta"
                    trigger={
                      <button type="button" className="icon-btn" aria-label="Mais ações da pasta" title="Mais ações">
                        <Icon name="more" />
                      </button>
                    }
                  >
                    {(close) => (
                      <>
                        <button type="button" onClick={() => (close(), setSelected({ kind: 'folder', folder }))}>
                          <Icon name="panel-info" />
                          Detalhes e atividade
                        </button>
                        {actions.folderItems(folder, close)}
                      </>
                    )}
                  </Menu>
                )}
                <Segmented
                  label="Exibição"
                  value={view}
                  onChange={setView}
                  items={[
                    { id: 'grid', label: <Icon name="files-grid" label="Grade" /> },
                    { id: 'list', label: <Icon name="files-list" label="Lista" /> },
                  ]}
                />
              </div>
            </div>
          )}
          {body}
        </main>
        {details && !phone && <aside className="fl-details">{details}</aside>}
      </div>
      {details && phone && (
        <Modal title={selected?.kind === 'file' ? selected.file.name : selected?.kind === 'folder' ? selected.folder.name : ''} onClose={() => setSelected(null)} variant="sheet" className="fl-details-sheet">
          {details}
        </Modal>
      )}
      {phone && trash === false && !folderId && (
        <Link to="/files/trash" className="fl-phone-trash">
          <Icon name="files-trash" size={16} />
          Lixeira
        </Link>
      )}
      {dragOver && canEdit && (
        <div className="fl-drop" aria-hidden="true">
          <div>
            <Icon name="files-upload" size={32} />
            <strong>Solte para enviar para “{folder?.name}”</strong>
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          send([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <UploadTray />
      {dialog}
    </div>
  );
}

// ---------- Navegação lateral ----------

function FilesNav({ home, currentId, path, trash }: { home: Awaited<ReturnType<typeof filesApi.home>> | null; currentId: string | null; path: { _id: string; name: string }[]; trash: boolean }) {
  const onPath = new Set(path.map((p) => p._id));
  return (
    <nav className="fl-nav" aria-label="Pastas">
      <Link to="/files" className={!currentId && !trash ? 'fl-nav-row active' : 'fl-nav-row'}>
        <Icon name="files-all" />
        Início
      </Link>
      <div className="fl-nav-label">Pastas</div>
      {!home ? (
        <div className="fl-nav-skel">
          <Skeleton height={14} />
          <Skeleton height={14} width="70%" />
        </div>
      ) : home.folders.length === 0 ? (
        <p className="muted fl-nav-empty">Nenhuma pasta compartilhada com você ainda.</p>
      ) : (
        <ul className="fl-tree" role="tree">
          {home.folders.map((f) => (
            <TreeNode key={f._id} folder={f} depth={0} currentId={currentId} onPath={onPath} />
          ))}
        </ul>
      )}
      <div className="fl-nav-foot">
        <Link to="/files/trash" className={trash ? 'fl-nav-row active' : 'fl-nav-row'}>
          <Icon name="files-trash" />
          Lixeira
        </Link>
        {home && <StorageMeter s={home.storage} />}
      </div>
    </nav>
  );
}

function TreeNode({ folder, depth, currentId, onPath }: { folder: DriveFolder; depth: number; currentId: string | null; onPath: Set<string> }) {
  const [open, setOpen] = useState(onPath.has(folder._id));
  const [children, setChildren] = useState<DriveFolder[] | null>(null);
  const hasKids = (folder.items ?? 0) > 0;
  useEffect(() => {
    if (onPath.has(folder._id)) setOpen(true);
  }, [onPath, folder._id]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    filesApi.folder(folder._id).then(
      (d) => alive && setChildren(d.folders),
      () => alive && setChildren([]),
    );
    return () => {
      alive = false;
    };
  }, [open, folder._id, currentId]);
  const active = currentId === folder._id;
  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={active}>
      <div className={active ? 'fl-tree-row active' : 'fl-tree-row'} style={{ paddingLeft: 8 + depth * 14 }}>
        <button type="button" className={open ? 'fl-tree-toggle open' : 'fl-tree-toggle'} aria-label={open ? `Fechar ${folder.name}` : `Abrir ${folder.name}`} tabIndex={-1} onClick={() => setOpen(!open)} style={{ visibility: hasKids ? 'visible' : 'hidden' }}>
          <Icon name="files-expand" size={14} />
        </button>
        <Link to={`/files/f/${folder._id}`} className="fl-tree-link">
          <FolderGlyph color={folder.color} size={16} open={active} />
          <span className="ellipsis">{folder.name}</span>
          {!folder.inherit && depth > 0 && <Icon name="files-locked" size={12} className="muted" />}
        </Link>
      </div>
      {open && children && children.length > 0 && (
        <ul role="group">
          {children.map((c) => (
            <TreeNode key={c._id} folder={c} depth={depth + 1} currentId={currentId} onPath={onPath} />
          ))}
        </ul>
      )}
    </li>
  );
}

function StorageMeter({ s }: { s: DriveStorage }) {
  const pct = s.quota ? Math.min(100, (s.used / s.quota) * 100) : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  return (
    <div className="fl-storage">
      <div className="fl-storage-top">
        <Icon name="files-storage" size={14} />
        <span>Armazenamento</span>
      </div>
      {s.quota > 0 && (
        <div className={`fl-meter ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Espaço usado">
          <span style={{ width: `${Math.max(pct, 1.5)}%` }} />
        </div>
      )}
      <small className="muted">
        {formatBytes(s.used)}
        {s.quota ? ` de ${formatBytes(s.quota)}` : ' usados'}
        {s.trash > 0 && ` · ${formatBytes(s.trash)} na lixeira`}
      </small>
    </div>
  );
}

function Breadcrumb({ data }: { data: DriveFolderView | null }) {
  if (!data) return <Skeleton height={16} width={220} />;
  return (
    <nav className="fl-crumbs" aria-label="Caminho">
      <Link to="/files">Arquivos</Link>
      {data.path.map((p, i) => (
        <span key={p._id} className="fl-crumb">
          <Icon name="files-expand" size={14} />
          {i === data.path.length - 1 ? <strong aria-current="page">{p.name}</strong> : <Link to={`/files/f/${p._id}`}>{p.name}</Link>}
        </span>
      ))}
    </nav>
  );
}

// ---------- Itens ----------

export function FolderGlyph({ color, size = 20, open }: { color: string | null; size?: 14 | 16 | 20 | 24 | 32; open?: boolean }) {
  return (
    <span className={`fl-glyph c-${color ?? 'blue'}`} aria-hidden="true">
      <Icon name={open ? 'files-folder-open' : 'files-folder'} size={size} fill />
    </span>
  );
}

function FileGlyph({ file, size = 20 }: { file: { name: string; type: string }; size?: 16 | 20 | 24 | 32 }) {
  const k = kindOf(file);
  return (
    <span className={`fl-file-glyph k-${k}`} aria-hidden="true">
      <Icon name={KIND_ICON[k] ?? 'file'} size={size} />
    </span>
  );
}

function Thumb({ file }: { file: DriveFile }) {
  const [failed, setFailed] = useState(false);
  if (file.type.startsWith('image/') && !failed)
    return (
      <span className="fl-thumb">
        <img src={file.url} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  return (
    <span className={`fl-thumb icon k-${kindOf(file)}`}>
      <FileGlyph file={file} size={32} />
      <span className="fl-ext">{file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 5).toUpperCase() : ''}</span>
    </span>
  );
}

interface ItemActions {
  fileItems: (f: DriveFile, level: number, close: () => void) => ReactNode;
  folderItems: (f: DriveFolder, close: () => void) => ReactNode;
  download: (f: DriveFile) => void;
}

function FolderCard({ f, selected, onOpen, onSelect, actions, view }: { f: DriveFolder; selected: boolean; onOpen: () => void; onSelect: () => void; actions: ItemActions; view: ViewMode }) {
  const meta = `${plural(f.items ?? 0, 'item', 'itens')}${f.size ? ` · ${formatBytes(f.size)}` : ''}`;
  const more = (
    <Menu
      label={`Ações de ${f.name}`}
      trigger={
        <button type="button" className="icon-btn fl-more" aria-label={`Ações de ${f.name}`} title="Mais ações" onClick={(e) => e.stopPropagation()}>
          <Icon name="more" />
        </button>
      }
    >
      {(close) => (
        <>
          <button type="button" onClick={() => (close(), onSelect())}>
            <Icon name="panel-info" />
            Detalhes
          </button>
          {actions.folderItems(f, close)}
        </>
      )}
    </Menu>
  );
  if (view === 'list')
    return (
      <div className={selected ? 'fl-row selected' : 'fl-row'} onClick={onOpen} role="row">
        <span className="fl-row-name">
          <FolderGlyph color={f.color} />
          <span className="ellipsis">{f.name}</span>
          {f.shared && <Icon name="files-share" size={14} className="muted" label="Compartilhada" />}
          {!f.inherit && f.parentId && <Icon name="files-locked" size={14} className="muted" label="Restrita" />}
        </span>
        <span className="fl-row-size muted">{meta}</span>
        <span className="fl-row-who muted ellipsis">{driveLevelLabel(f.level)}</span>
        <span className="fl-row-date muted">{formatRelative(f.updatedAt)}</span>
        {more}
      </div>
    );
  return (
    <div className={selected ? `fl-folder-card c-${f.color ?? 'blue'} selected` : `fl-folder-card c-${f.color ?? 'blue'}`} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()} role="button" tabIndex={0} aria-label={`Abrir ${f.name}`}>
      <FolderGlyph color={f.color} size={32} />
      <span className="fl-card-text">
        <strong className="ellipsis" title={f.name}>
          {f.name}
        </strong>
        <small className="muted">{meta}</small>
      </span>
      <span className="fl-card-badges">
        {f.shared && (
          <span className="fl-badge" title="Compartilhada">
            <Icon name="files-share" size={12} />
          </span>
        )}
        {!f.inherit && f.parentId && (
          <span className="fl-badge" title="Restrita: não herda o acesso da pasta de cima">
            <Icon name="files-locked" size={12} />
          </span>
        )}
        <span className={`fl-badge l${f.level}`} title={driveLevelLabel(f.level)}>
          <Icon name={LEVEL_ICON[f.level]} size={12} />
        </span>
      </span>
      {more}
    </div>
  );
}

function FileItem({ f, level, selected, onSelect, actions, view, showPath }: { f: DriveFile; level: number; selected: boolean; onSelect: () => void; actions: ItemActions; view: ViewMode; showPath?: boolean }) {
  const who = f.uploadedBy ? f.uploadedBy.name || f.uploadedBy.username : '—';
  const more = (
    <Menu
      label={`Ações de ${f.name}`}
      trigger={
        <button type="button" className="icon-btn fl-more" aria-label={`Ações de ${f.name}`} title="Mais ações" onClick={(e) => e.stopPropagation()}>
          <Icon name="more" />
        </button>
      }
    >
      {(close) => actions.fileItems(f, level, close)}
    </Menu>
  );
  if (view === 'list')
    return (
      <div className={selected ? 'fl-row selected' : 'fl-row'} onClick={onSelect} onDoubleClick={() => actions.download(f)} role="row">
        <span className="fl-row-name">
          <FileGlyph file={f} />
          <span className="fl-row-title">
            <span className="ellipsis">{f.name}</span>
            {showPath && f.path && <small className="muted ellipsis">{f.path.map((p) => p.name).join(' › ')}</small>}
          </span>
        </span>
        <span className="fl-row-size muted tabular">{formatBytes(f.size)}</span>
        <span className="fl-row-who muted ellipsis">{who}</span>
        <span className="fl-row-date muted">{formatRelative(f.updatedAt)}</span>
        {more}
      </div>
    );
  return (
    <div className={selected ? 'fl-file-card selected' : 'fl-file-card'} onClick={onSelect} onDoubleClick={() => actions.download(f)} onKeyDown={(e) => e.key === 'Enter' && onSelect()} role="button" tabIndex={0} aria-label={f.name}>
      <Thumb file={f} />
      <span className="fl-card-text">
        <strong className="ellipsis" title={f.name}>
          {f.name}
        </strong>
        <small className="muted ellipsis">{showPath && f.path ? f.path.map((p) => p.name).join(' › ') : `${formatBytes(f.size)} · ${formatRelative(f.updatedAt)}`}</small>
      </span>
      {more}
    </div>
  );
}

function ListHead() {
  return (
    <div className="fl-row head" role="row">
      <span>Nome</span>
      <span>Tamanho</span>
      <span>Enviado por</span>
      <span>Alterado</span>
      <span />
    </div>
  );
}

// ---------- Vistas ----------

function HomeView({
  home,
  error,
  view,
  onOpenFolder,
  onSelectFile,
  onNewFolder,
  actions,
}: {
  home: Awaited<ReturnType<typeof filesApi.home>> | null;
  error: string | null;
  view: ViewMode;
  onOpenFolder: (f: DriveFolder) => void;
  onSelectFile: (f: DriveFile) => void;
  onNewFolder: () => void;
  actions: ItemActions;
}) {
  const [recent, setRecent] = useState<DriveFile[] | null>(null);
  useEffect(() => {
    filesApi.recent().then(setRecent, () => setRecent([]));
  }, [home]);
  if (error && !home) return <Empty icon="files-folder" title="Não deu para carregar" tone="danger">{error}</Empty>;
  if (!home) return <GridSkeleton />;
  if (!home.folders.length)
    return (
      <div className="fl-empty-wrap">
        <Empty
          icon="files-folder"
          title="Nenhuma pasta por aqui ainda"
          action={
            home.canCreateRoot ? (
              <button type="button" className="btn primary" onClick={onNewFolder}>
                <Icon name="files-folder-new" />
                Criar a primeira pasta
              </button>
            ) : undefined
          }
        >
          {home.canCreateRoot ? 'Crie uma pasta e compartilhe com um papel, um canal da operação ou pessoas.' : 'Quando alguém compartilhar uma pasta com você, ela aparece aqui.'}
        </Empty>
      </div>
    );
  return (
    <div className="fl-sections">
      <section>
        <h2 className="fl-section-h">Pastas</h2>
        <div className={view === 'grid' ? 'fl-grid folders' : 'fl-list'}>
          {view === 'list' && <ListHead />}
          {home.folders.map((f) => (
            <FolderCard key={f._id} f={f} selected={false} view={view} onOpen={() => onOpenFolder(f)} onSelect={() => onOpenFolder(f)} actions={actions} />
          ))}
        </div>
      </section>
      {recent && recent.length > 0 && (
        <section>
          <h2 className="fl-section-h">
            <Icon name="files-recent" size={16} />
            Recentes
          </h2>
          <div className={view === 'grid' ? 'fl-grid files' : 'fl-list'}>
            {view === 'list' && <ListHead />}
            {recent.map((f) => (
              <FileItem key={f._id} f={f} level={f.level ?? 1} selected={false} view={view} showPath onSelect={() => onSelectFile(f)} actions={actions} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="fl-grid folders" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={72} />
      ))}
    </div>
  );
}

function FolderContents({
  data,
  view,
  selectedId,
  onSelectFile,
  onSelectFolder,
  onOpenFolder,
  actions,
  onUpload,
  onNewFolder,
}: {
  data: DriveFolderView | null;
  view: ViewMode;
  selectedId: string | null;
  onSelectFile: (f: DriveFile) => void;
  onSelectFolder: (f: DriveFolder) => void;
  onOpenFolder: (f: DriveFolder) => void;
  actions: ItemActions;
  onUpload: () => void;
  onNewFolder: () => void;
}) {
  if (!data) return <GridSkeleton />;
  const canEdit = data.folder.level >= 2;
  if (!data.folders.length && !data.files.length)
    return (
      <div className={canEdit ? 'fl-empty-wrap drop' : 'fl-empty-wrap'}>
        <Empty
          icon="files-upload"
          title="Pasta vazia"
          action={
            canEdit ? (
              <div className="fl-empty-actions">
                <button type="button" className="btn primary" onClick={onUpload}>
                  <Icon name="files-upload" />
                  Enviar arquivos
                </button>
                <button type="button" className="btn" onClick={onNewFolder}>
                  <Icon name="files-folder-new" />
                  Nova pasta
                </button>
              </div>
            ) : undefined
          }
        >
          {canEdit ? 'Arraste arquivos para cá ou use o botão Enviar.' : 'Ainda não há nada nesta pasta.'}
        </Empty>
      </div>
    );
  return (
    <div className="fl-sections">
      {data.folders.length > 0 && (
        <section>
          <h2 className="fl-section-h">Pastas</h2>
          <div className={view === 'grid' ? 'fl-grid folders' : 'fl-list'}>
            {view === 'list' && <ListHead />}
            {data.folders.map((f) => (
              <FolderCard key={f._id} f={f} selected={selectedId === f._id} view={view} onOpen={() => onOpenFolder(f)} onSelect={() => onSelectFolder(f)} actions={actions} />
            ))}
          </div>
        </section>
      )}
      {data.files.length > 0 && (
        <section>
          <h2 className="fl-section-h">Arquivos</h2>
          <div className={view === 'grid' ? 'fl-grid files' : 'fl-list'}>
            {view === 'list' && <ListHead />}
            {data.files.map((f) => (
              <FileItem key={f._id} f={f} level={data.folder.level} selected={selectedId === f._id} view={view} onSelect={() => onSelectFile(f)} actions={actions} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SearchResults({ text, view, onOpenFile }: { text: string; view: ViewMode; onOpenFile: (f: DriveFile) => void }) {
  const navigate = useNavigate();
  const [r, setR] = useState<Awaited<ReturnType<typeof filesApi.search>> | null>(null);
  useEffect(() => {
    let alive = true;
    setR(null);
    const t = setTimeout(() => filesApi.search(text).then((x) => alive && setR(x), () => alive && setR({ folders: [], files: [] })), 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text]);
  const actions = useItemActions({});
  if (!r) return <GridSkeleton />;
  if (!r.folders.length && !r.files.length) return <Empty icon="search" title="Nada encontrado">Nenhuma pasta ou arquivo com “{text}” nas pastas que você acessa.</Empty>;
  return (
    <div className="fl-sections">
      {r.folders.length > 0 && (
        <section>
          <h2 className="fl-section-h">Pastas</h2>
          <div className="fl-list">
            {r.folders.map((f) => (
              <div key={f._id} className="fl-row" role="row" onClick={() => navigate(`/files/f/${f._id}`)}>
                <span className="fl-row-name">
                  <FolderGlyph color={f.color} />
                  <span className="fl-row-title">
                    <span className="ellipsis">{f.name}</span>
                    {f.path.length > 0 && <small className="muted ellipsis">{f.path.map((p) => p.name).join(' › ')}</small>}
                  </span>
                </span>
                <span className="fl-row-size muted">{plural(f.items ?? 0, 'item', 'itens')}</span>
                <span className="fl-row-who muted">{driveLevelLabel(f.level)}</span>
                <span className="fl-row-date muted">{formatRelative(f.updatedAt)}</span>
                <span />
              </div>
            ))}
          </div>
        </section>
      )}
      {r.files.length > 0 && (
        <section>
          <h2 className="fl-section-h">Arquivos</h2>
          <div className={view === 'grid' ? 'fl-grid files' : 'fl-list'}>
            {view === 'list' && <ListHead />}
            {r.files.map((f) => (
              <FileItem key={f._id} f={f} level={f.level ?? 1} selected={false} view={view} showPath onSelect={() => onOpenFile(f)} actions={actions} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function TrashView({ onChanged }: { onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const [r, setR] = useState<Awaited<ReturnType<typeof filesApi.trashList>> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    filesApi.trashList().then(setR, (e) => toast(errorMessage(e), 'error'));
  }, [tick, toast]);
  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      toast(ok, 'success');
      setTick((t) => t + 1);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  if (!r) return <GridSkeleton />;
  const canPurgeAny = r.folders.some((f) => f.level >= 3) || r.files.some((f) => (f.level ?? 0) >= 3);
  const empty = !r.folders.length && !r.files.length;
  return (
    <div className="fl-sections">
      <div className="fl-trash-head">
        <div>
          <h2>Lixeira</h2>
          <p className="muted">Itens ficam {r.days} dias aqui e depois são apagados de vez. Só aparece o que você pode restaurar.</p>
        </div>
        {canPurgeAny && (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (await confirmDialog({ title: 'Esvaziar a lixeira?', body: 'Os itens que você gerencia serão apagados de vez. Não dá para desfazer.', confirmLabel: 'Esvaziar', danger: true }))
                void run(filesApi.purge({ all: true }), 'Lixeira esvaziada.');
            }}
          >
            <Icon name="files-trash" />
            Esvaziar lixeira
          </button>
        )}
      </div>
      {empty ? (
        <Empty icon="files-trash" title="A lixeira está vazia">O que for apagado das pastas aparece aqui.</Empty>
      ) : (
        <div className="fl-list">
          <div className="fl-row head trash" role="row">
            <span>Nome</span>
            <span>Estava em</span>
            <span>Apagado por</span>
            <span>Quando</span>
            <span />
          </div>
          {r.folders.map((f) => (
            <TrashRow
              key={f._id}
              icon={<FolderGlyph color={f.color} />}
              name={f.name}
              where={f.path.map((p) => p.name).join(' › ') || 'Arquivos'}
              who={f.trashedBy?.name || f.trashedBy?.username || '—'}
              when={f.trashedAt}
              canPurge={f.level >= 3}
              onRestore={() => run(filesApi.restore({ folderIds: [f._id] }), `“${f.name}” restaurada.`)}
              onPurge={() => run(filesApi.purge({ folderIds: [f._id] }), `“${f.name}” apagada de vez.`)}
            />
          ))}
          {r.files.map((f) => (
            <TrashRow
              key={f._id}
              icon={<FileGlyph file={f} />}
              name={f.name}
              where={f.path?.map((p) => p.name).join(' › ') ?? ''}
              who={f.trashedBy?.name || f.trashedBy?.username || '—'}
              when={f.trashedAt}
              canPurge={(f.level ?? 0) >= 3}
              onRestore={() => run(filesApi.restore({ fileIds: [f._id] }), `“${f.name}” restaurado.`)}
              onPurge={() => run(filesApi.purge({ fileIds: [f._id] }), `“${f.name}” apagado de vez.`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TrashRow({ icon, name, where, who, when, canPurge, onRestore, onPurge }: { icon: ReactNode; name: string; where: string; who: string; when?: string | null; canPurge: boolean; onRestore: () => void; onPurge: () => void }) {
  return (
    <div className="fl-row trash" role="row">
      <span className="fl-row-name">
        {icon}
        <span className="ellipsis">{name}</span>
      </span>
      <span className="muted ellipsis">{where}</span>
      <span className="muted ellipsis">{who}</span>
      <span className="muted">{formatRelative(when)}</span>
      <span className="fl-trash-actions">
        <button type="button" className="btn small" onClick={onRestore}>
          <Icon name="files-restore" />
          Restaurar
        </button>
        {canPurge && (
          <button
            type="button"
            className="icon-btn danger"
            aria-label={`Apagar ${name} de vez`}
            title="Apagar de vez"
            onClick={async () => {
              if (await confirmDialog({ title: `Apagar “${name}” de vez?`, body: 'Não dá para desfazer.', confirmLabel: 'Apagar de vez', danger: true })) onPurge();
            }}
          >
            <Icon name="files-trash" />
          </button>
        )}
      </span>
    </div>
  );
}

// ---------- Detalhes ----------

function FilePreview({ file }: { file: DriveFile }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!isText(file) || file.size > 512 * 1024) return;
    let alive = true;
    fetch(file.url, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [file]);
  if (file.type.startsWith('image/')) return <img className="fl-preview-img" src={file.url} alt={file.name} />;
  if (file.type.startsWith('video/')) return <video className="fl-preview-media" src={file.url} controls preload="metadata" />;
  if (file.type.startsWith('audio/')) return <audio className="fl-preview-audio" src={file.url} controls preload="metadata" />;
  if (file.type === 'application/pdf') return <iframe className="fl-preview-pdf" src={file.url} title={`Prévia de ${file.name}`} />;
  if (isText(file) && file.size <= 512 * 1024) return text === null ? <Skeleton height={120} /> : <pre className="fl-preview-text">{text.slice(0, 20000)}</pre>;
  return (
    <div className="fl-preview-none">
      <FileGlyph file={file} size={32} />
      <span className="muted">Sem prévia para este tipo. Baixe para abrir.</span>
    </div>
  );
}

function FileDetails({ file, level, actions, onClose }: { file: DriveFile; level: number; actions: ItemActions; onClose: () => void }) {
  const phone = useIsPhone();
  const [full, setFull] = useState(false);
  return (
    <div className="fl-detail">
      {!phone && (
        <div className="fl-detail-head">
          <FileGlyph file={file} />
          <h2 className="ellipsis" title={file.name}>
            {file.name}
          </h2>
          <button type="button" className="icon-btn" aria-label="Fechar detalhes" title="Fechar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="fl-preview">
        <FilePreview file={file} />
        {canPreview(file) && !phone && (
          <button type="button" className="btn small fl-preview-open" onClick={() => setFull(true)}>
            <Icon name="expand" />
            Ampliar
          </button>
        )}
      </div>
      <div className="fl-detail-actions">
        <button type="button" className="btn primary" onClick={() => actions.download(file)}>
          <Icon name="download" />
          Baixar
        </button>
        <a className="btn" href={file.url} target="_blank" rel="noreferrer">
          <Icon name="open-external" />
          Abrir
        </a>
        <Menu
          label="Mais ações do arquivo"
          trigger={
            <button type="button" className="icon-btn" aria-label="Mais ações do arquivo" title="Mais ações">
              <Icon name="more" />
            </button>
          }
        >
          {(close) => actions.fileItems(file, level, close)}
        </Menu>
      </div>
      <dl className="fl-props">
        <div>
          <dt>Tamanho</dt>
          <dd className="tabular">{formatBytes(file.size)}</dd>
        </div>
        <div>
          <dt>Tipo</dt>
          <dd className="ellipsis">{file.type}</dd>
        </div>
        <div>
          <dt>Enviado por</dt>
          <dd>{file.uploadedBy ? file.uploadedBy.name || file.uploadedBy.username : '—'}</dd>
        </div>
        <div>
          <dt>Enviado</dt>
          <dd>{formatWhen(file.createdAt)}</dd>
        </div>
        {file.updatedAt !== file.createdAt && (
          <div>
            <dt>Alterado</dt>
            <dd>{formatWhen(file.updatedAt)}</dd>
          </div>
        )}
        {file.path && (
          <div>
            <dt>Pasta</dt>
            <dd>
              <Link to={`/files/f/${file.folderId}`}>{file.path.map((p) => p.name).join(' › ')}</Link>
            </dd>
          </div>
        )}
        <div>
          <dt>Seu acesso</dt>
          <dd>{driveLevelLabel(level)}</dd>
        </div>
      </dl>
      {full && (
        <Modal title={file.name} onClose={() => setFull(false)} wide className="fl-preview-modal" variant="fullscreen">
          <FilePreview file={file} />
        </Modal>
      )}
    </div>
  );
}

const ACTIVITY_TEXT: Record<string, (d: Record<string, any>) => string> = {
  'file.upload': (d) => `enviou ${d.name}`,
  'file.download': (d) => `baixou ${d.name}`,
  'file.rename': (d) => `renomeou ${d.from} para ${d.to}`,
  'file.move.in': (d) => `trouxe ${d.name}${d.from ? ` de ${d.from}` : ''}`,
  'file.move.out': (d) => `levou ${d.name} para ${d.to}`,
  'file.trash': (d) => `mandou ${d.name} para a lixeira`,
  'file.restore': (d) => `restaurou ${d.name}`,
  'file.purge': (d) => `apagou ${d.name} de vez`,
  'folder.create': (d) => `criou a pasta ${d.name}`,
  'folder.add': (d) => `criou a subpasta ${d.name}`,
  'folder.rename': (d) => `renomeou a pasta de ${d.from} para ${d.to}`,
  'folder.move': (d) => `moveu a pasta para ${d.to ?? 'as pastas principais'}`,
  'folder.trash': (d) => `mandou a pasta ${d.name} para a lixeira`,
  'folder.restore': (d) => `restaurou a pasta ${d.name}`,
  'folder.purge': (d) => `apagou a pasta ${d.name} de vez`,
  'acl.update': (d) => {
    const n = (d.added?.length ?? 0) + (d.removed?.length ?? 0) + (d.changed?.length ?? 0);
    const parts = [d.added?.length && `${d.added.length} acesso(s) novo(s)`, d.removed?.length && `${d.removed.length} retirado(s)`, d.changed?.length && `${d.changed.length} alterado(s)`].filter(Boolean);
    const inh = d.inherit === false ? ' e deixou a pasta restrita' : d.inherit === true ? ' e voltou a herdar o acesso' : '';
    return n ? `mudou o compartilhamento (${parts.join(', ')})${inh}` : `mudou o compartilhamento${inh}`;
  },
};

const ACTIVITY_ICON: Record<string, IconName> = {
  'file.upload': 'files-upload',
  'file.download': 'download',
  'acl.update': 'files-share',
  'file.trash': 'files-trash',
  'folder.trash': 'files-trash',
  'file.purge': 'files-trash',
  'folder.purge': 'files-trash',
};

function ActivityList({ folderId }: { folderId: string }) {
  const [r, setR] = useState<DriveActivity[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    filesApi.activity(folderId).then(
      (x) => setR(x.events),
      (e) => setErr(errorMessage(e)),
    );
  }, [folderId]);
  if (err) return <p className="muted">{err}</p>;
  if (!r) return <Skeleton height={60} />;
  if (!r.length) return <p className="muted">Nada registrado ainda.</p>;
  return (
    <ol className="fl-activity">
      {r.map((e) => (
        <li key={e._id}>
          <span className="fl-act-icon">
            <Icon name={ACTIVITY_ICON[e.action] ?? (e.action.startsWith('folder') ? 'files-folder' : 'file')} size={14} />
          </span>
          <span>
            <strong>{e.actor.name || e.actor.username || 'Sistema'}</strong> {(ACTIVITY_TEXT[e.action] ?? (() => e.action))(e.data as Record<string, any>)}
            {typeof e.data.folder === 'string' && <span className="muted"> em {e.data.folder}</span>}
            <small className="muted">{formatWhen(e.ts)}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

function FolderDetails({ folder, actions, onClose }: { folder: DriveFolder; actions: ItemActions; onClose: () => void }) {
  const phone = useIsPhone();
  const [view, setView] = useState<DriveFolderView | null>(null);
  useEffect(() => {
    filesApi.folder(folder._id).then(setView, () => setView(null));
  }, [folder]);
  const acl = view?.acl;
  return (
    <div className="fl-detail">
      {!phone && (
        <div className="fl-detail-head">
          <FolderGlyph color={folder.color} />
          <h2 className="ellipsis">{folder.name}</h2>
          <button type="button" className="icon-btn" aria-label="Fechar detalhes" title="Fechar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <dl className="fl-props">
        <div>
          <dt>Itens</dt>
          <dd>{plural(folder.items ?? 0, 'item', 'itens')}</dd>
        </div>
        <div>
          <dt>Tamanho</dt>
          <dd>{formatBytes(folder.size ?? 0)}</dd>
        </div>
        <div>
          <dt>Criada por</dt>
          <dd>{folder.createdBy ? folder.createdBy.name || folder.createdBy.username : '—'}</dd>
        </div>
        <div>
          <dt>Criada</dt>
          <dd>{formatWhen(folder.createdAt)}</dd>
        </div>
        <div>
          <dt>Seu acesso</dt>
          <dd>{driveLevelLabel(folder.level)}</dd>
        </div>
      </dl>
      {acl && (
        <section className="fl-detail-sec">
          <h3>
            <Icon name="files-share" size={14} />
            Quem tem acesso
          </h3>
          <ul className="fl-acl compact">
            {acl.map((e) => (
              <li key={`${e.from?._id ?? ''}:${e.type}:${e.id}`}>
                <span className="fl-subject-text">
                  <strong className="ellipsis">{e.label}</strong>
                  <small className="muted ellipsis">{e.from ? `de “${e.from.name}”` : (e.sublabel ?? '')}</small>
                </span>
                <span className={`fl-level l${e.level}`}>{driveLevelLabel(e.level)}</span>
              </li>
            ))}
          </ul>
          <Menu
            label="Ações"
            trigger={
              <button type="button" className="btn small">
                <Icon name="more" />
                Ações da pasta
              </button>
            }
          >
            {(close) => actions.folderItems(folder, close)}
          </Menu>
        </section>
      )}
      {folder.level >= 3 && (
        <section className="fl-detail-sec">
          <h3>
            <Icon name="files-activity" size={14} />
            Atividade
          </h3>
          <ActivityList folderId={folder._id} />
        </section>
      )}
    </div>
  );
}

// ---------- Ações (menus) ----------

function useItemActions(opts: {
  setDialog?: (n: ReactNode) => void;
  reload?: () => void;
  toast?: (t: string, k?: 'info' | 'success' | 'warning' | 'error') => void;
  navigate?: (to: string) => void;
  openShare?: (f: DriveFolder) => void;
  parent?: DriveFolder | null;
  onGone?: () => void;
}): ItemActions {
  const storeToast = useStore((s) => s.toast);
  const toast = opts.toast ?? storeToast;
  const { setDialog, reload, navigate, openShare, parent, onGone } = opts;
  const run = useCallback(
    async (p: Promise<unknown>, ok: string) => {
      try {
        await p;
        toast(ok, 'success');
        reload?.();
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    },
    [toast, reload],
  );
  return useMemo<ItemActions>(() => {
    const download = (f: DriveFile) => {
      const a = document.createElement('a');
      a.href = `${f.url}?download`;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    const move = (title: string, current: string | null, exclude: string | null, go: (target: DriveFolder) => Promise<unknown>) =>
      setDialog?.(
        <MoveDialog
          title={title}
          currentId={current}
          excludeId={exclude}
          onClose={() => setDialog(null)}
          onPick={async (t) => {
            await go(t);
            setDialog(null);
          }}
        />,
      );
    return {
      download,
      fileItems: (f, level, close) => (
        <>
          <button type="button" onClick={() => (close(), download(f))}>
            <Icon name="download" />
            Baixar
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              void navigator.clipboard?.writeText(`${location.origin}/files/f/${f.folderId}`).then(() => toast('Link da pasta copiado.', 'success'));
            }}
          >
            <Icon name="copy-link" />
            Copiar link da pasta
          </button>
          {level >= 2 && setDialog && (
            <>
              <button
                type="button"
                onClick={() => {
                  close();
                  setDialog(
                    <NameDialog
                      title="Renomear arquivo"
                      initial={f.name}
                      confirm="Renomear"
                      selectBase
                      onClose={() => setDialog(null)}
                      onSave={async (name) => {
                        await filesApi.rename(f._id, name);
                        setDialog(null);
                        toast('Arquivo renomeado.', 'success');
                        reload?.();
                      }}
                    />,
                  );
                }}
              >
                <Icon name="edit" />
                Renomear
              </button>
              <button type="button" onClick={() => (close(), move(`Mover “${f.name}”`, f.folderId, null, (t) => run(filesApi.move({ fileIds: [f._id], targetId: t._id }), `Movido para “${t.name}”.`)))}>
                <Icon name="files-move" />
                Mover para…
              </button>
              <hr />
              <button
                type="button"
                className="danger"
                onClick={() => {
                  close();
                  onGone?.();
                  void run(filesApi.trash({ fileIds: [f._id] }), `“${f.name}” foi para a lixeira.`);
                }}
              >
                <Icon name="files-trash" />
                Mandar para a lixeira
              </button>
            </>
          )}
        </>
      ),
      folderItems: (f, close) => (
        <>
          {navigate && (
            <button type="button" onClick={() => (close(), navigate(`/files/f/${f._id}`))}>
              <Icon name="files-folder-open" />
              Abrir
            </button>
          )}
          {f.level >= 3 && openShare && (
            <button type="button" onClick={() => (close(), openShare(f))}>
              <Icon name="files-share" />
              Compartilhar
            </button>
          )}
          {(f.level >= 3 || (parent?.level ?? 0) >= 2) && setDialog && (
            <button
              type="button"
              onClick={() => {
                close();
                setDialog(
                  <NameDialog
                    title="Renomear pasta"
                    initial={f.name}
                    initialColor={f.color}
                    withColor
                    confirm="Salvar"
                    onClose={() => setDialog(null)}
                    onSave={async (name, color) => {
                      await filesApi.updateFolder(f._id, { name, color });
                      setDialog(null);
                      toast('Pasta atualizada.', 'success');
                      reload?.();
                    }}
                  />,
                );
              }}
            >
              <Icon name="edit" />
              Renomear e cor
            </button>
          )}
          {f.level >= 3 && setDialog && f.parentId && (
            <button type="button" onClick={() => (close(), move(`Mover a pasta “${f.name}”`, f.parentId, f._id, (t) => run(filesApi.move({ folderIds: [f._id], targetId: t._id }), `Pasta movida para “${t.name}”.`)))}>
              <Icon name="files-move" />
              Mover para…
            </button>
          )}
          {f.level >= 3 && (
            <>
              <hr />
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  close();
                  if (!(await confirmDialog({ title: `Mandar “${f.name}” para a lixeira?`, body: 'Tudo o que está dentro vai junto. Dá para restaurar pela Lixeira.', confirmLabel: 'Mandar para a lixeira', danger: true }))) return;
                  try {
                    await filesApi.trash({ folderIds: [f._id] });
                    toast(`“${f.name}” foi para a lixeira.`, 'success');
                    if (parent && parent._id === f._id) navigate?.(f.parentId ? `/files/f/${f.parentId}` : '/files');
                    else reload?.();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                <Icon name="files-trash" />
                Mandar para a lixeira
              </button>
            </>
          )}
        </>
      ),
    };
  }, [setDialog, reload, navigate, openShare, parent, onGone, run, toast]);
}

// ---------- Diálogos ----------

function NameDialog({
  title,
  description,
  initial = '',
  initialColor = null,
  withColor,
  selectBase,
  confirm,
  onClose,
  onSave,
}: {
  title: string;
  description?: string;
  initial?: string;
  initialColor?: string | null;
  withColor?: boolean;
  selectBase?: boolean;
  confirm: string;
  onClose: () => void;
  onSave: (name: string, color: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [color, setColor] = useState<string | null>(initialColor);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    if (selectBase && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectBase]);
  const submit = async () => {
    if (!name.trim()) return setErr('Dê um nome.');
    setBusy(true);
    setErr(null);
    try {
      await onSave(name.trim(), color);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      description={description}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="fl-name-form" className="btn primary" disabled={busy}>
            {busy && <Spinner size="sm" />}
            {confirm}
          </button>
        </>
      }
    >
      <form
        id="fl-name-form"
        className="fl-name-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="field-label">Nome</span>
          <input ref={ref} className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-invalid={!!err} />
          {err && <span className="field-error">{err}</span>}
        </label>
        {withColor && (
          <div className="fl-colors" role="radiogroup" aria-label="Cor da pasta">
            {FOLDER_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={(color ?? 'blue') === c} aria-label={COLOR_LABEL[c]} title={COLOR_LABEL[c]} className={`fl-color c-${c}`} onClick={() => setColor(c)}>
                <Icon name="files-folder" size={20} fill />
              </button>
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}

// Escolher a pasta de destino: as pastas principais e as de dentro, só as que a pessoa edita.
function MoveDialog({ title, currentId, excludeId, onClose, onPick }: { title: string; currentId: string | null; excludeId: string | null; onClose: () => void; onPick: (f: DriveFolder) => Promise<void> }) {
  const toast = useStore((s) => s.toast);
  const [stack, setStack] = useState<DriveFolder[]>([]);
  const [list, setList] = useState<DriveFolder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const here = stack[stack.length - 1] ?? null;
  useEffect(() => {
    setList(null);
    (here ? filesApi.folder(here._id).then((d) => d.folders) : filesApi.home().then((h) => h.folders)).then(setList, () => setList([]));
  }, [here]);
  const canDrop = !!here && here.level >= 2 && here._id !== currentId;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canDrop || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(here!);
              } catch (e) {
                toast(errorMessage(e), 'error');
                setBusy(false);
              }
            }}
          >
            {here ? `Mover para “${here.name}”` : 'Escolha uma pasta'}
          </button>
        </>
      }
    >
      <div className="fl-move-crumbs">
        <button type="button" className="link" onClick={() => setStack([])}>
          Arquivos
        </button>
        {stack.map((f, i) => (
          <span key={f._id}>
            <Icon name="files-expand" size={12} />
            <button type="button" className="link" onClick={() => setStack(stack.slice(0, i + 1))}>
              {f.name}
            </button>
          </span>
        ))}
      </div>
      <ul className="fl-move-list">
        {!list && <Skeleton height={36} />}
        {list?.length === 0 && <li className="muted fl-move-empty">Sem subpastas aqui.</li>}
        {list
          ?.filter((f) => f._id !== excludeId)
          .map((f) => (
            <li key={f._id}>
              <button type="button" onClick={() => setStack([...stack, f])} disabled={f.level < 2 && !(f.items ?? 0)}>
                <FolderGlyph color={f.color} />
                <span className="ellipsis">{f.name}</span>
                {f.level < 2 && <small className="muted">só ver</small>}
                <Icon name="files-expand" size={14} />
              </button>
            </li>
          ))}
      </ul>
    </Modal>
  );
}

// ---------- Fila de envios ----------

function UploadTray() {
  const jobs = useUploads();
  const [min, setMin] = useState(false);
  if (!jobs.length) return null;
  const active = jobs.filter((j) => j.state === 'waiting' || j.state === 'sending');
  const done = jobs.filter((j) => j.state === 'done').length;
  const failed = jobs.filter((j) => j.state === 'error').length;
  const head = active.length ? `Enviando ${active.length} de ${jobs.length}` : failed ? `${plural(done, 'enviado', 'enviados')}, ${failed} com erro` : `${plural(done, 'arquivo enviado', 'arquivos enviados')}`;
  return (
    <section className="fl-tray" aria-label="Envios" aria-live="polite">
      <header>
        <strong>{head}</strong>
        <button type="button" className="icon-btn" aria-label={min ? 'Mostrar envios' : 'Recolher envios'} title={min ? 'Mostrar' : 'Recolher'} onClick={() => setMin(!min)}>
          <Icon name={min ? 'voice-up' : 'chevron-down'} />
        </button>
        {!active.length && (
          <button type="button" className="icon-btn" aria-label="Fechar envios" title="Fechar" onClick={clearFinishedUploads}>
            <Icon name="close" />
          </button>
        )}
      </header>
      {!min && (
        <ul>
          {jobs.map((j) => (
            <li key={j.id} className={j.state}>
              <FileGlyph file={{ name: j.name, type: '' }} size={16} />
              <span className="fl-tray-text">
                <span className="ellipsis">{j.name}</span>
                <small className="muted ellipsis">
                  {j.state === 'error' ? j.error : j.state === 'canceled' ? 'Cancelado' : j.state === 'done' ? `Em ${j.folderName}` : `${formatBytes(j.size)} · ${j.folderName}`}
                </small>
                {j.state === 'sending' && (
                  <span className="fl-meter thin">
                    <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </span>
                )}
              </span>
              {j.state === 'done' ? (
                <Icon name="success" className="fl-ok" />
              ) : j.state === 'error' ? (
                <Icon name="error" className="fl-err" />
              ) : j.state === 'canceled' ? null : (
                <button type="button" className="icon-btn" aria-label={`Cancelar ${j.name}`} title="Cancelar" onClick={() => cancelUpload(j.id)}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
