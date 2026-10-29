// Figurinhas: um pacote por dentro, na conta (pessoal) e na administração (organização): nome, situação e quem vê,
// a grade com "Adicionar", reordenar, editar, mover, capa, excluir e "Remover de todas as conversas".
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { STICKER_LIMITS, type MessageStickerLive, type StickerItem, type StickerPack } from '@shared/stickers';
import { plural } from '../../lib/format';
import { stickerAdmin, stickerErrorText, useStickerCaps, useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Empty, Menu, Segmented, Spinner, confirmDialog } from '../ui';
import type { StickerEditorProps } from './StickerEditor';
import { ImportStickersModal, usePackTargets } from './ImportStickersModal';
import { RemoveEverywhereDialog, StickerEditorDialog } from './StickerMenuItems';
import { StickerView } from './StickerView';
import { DragGhostLayer, LiveRegion, RoleChips, useGlobalRoles, useReorder } from './studioParts';
import './studio.css';

type Scope = 'org' | 'personal';

const toastOk = (text: string) => useStore.getState().toast(text, 'success');
const toastError = (e: unknown) => useStore.getState().toast(stickerErrorText(e), 'error');

export const asLiveSticker = (s: StickerItem, scope: Scope): MessageStickerLive => ({
  fileId: s.fileId,
  name: s.name,
  emojis: s.emojis,
  width: s.width,
  height: s.height,
  animated: s.animated,
  durationMs: s.durationMs,
  url: s.url,
  posterUrl: s.posterUrl,
  scope,
});

// Sem capa escolhida o servidor usa a primeira figurinha; a capa é a que tem o mesmo arquivo de coverUrl.
const isCover = (pack: StickerPack, s: StickerItem) => !!pack.coverUrl && (pack.coverUrl === s.posterUrl || pack.coverUrl === s.url);

export function PackManager({ scope, packId, onBack }: { scope: Scope; packId: string; onBack(): void }) {
  const caps = useStickerCaps();
  const targets = usePackTargets(caps);
  const [pack, setPack] = useState<StickerPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Omit<StickerEditorProps, 'onClose'> | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // Outra aba, outra pessoa ou o editor mudou o catálogo: recarrega o pacote.
  const version = useStickers((s) => (scope === 'org' ? s.org?.version : s.mine?.version));

  const reload = useCallback(
    () =>
      stickerAdmin.packInfo(packId).then(
        (p) => {
          setPack(p);
          setError(null);
        },
        (e) => setError(stickerErrorText(e)),
      ),
    [packId],
  );
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const stickers = pack?.stickers ?? [];
  const ids = stickers.map((s) => s._id);
  const reorder = useReorder(ids, (next) => stickerAdmin.reorderStickers(packId, next).then(() => void reload()));
  const byId = new Map(stickers.map((s) => [s._id, s]));
  const ordered = reorder.order.map((id) => byId.get(id)).filter((s): s is StickerItem => !!s);
  const max = scope === 'org' ? caps.limits.orgMaxPerPack : caps.limits.maxPerPack;
  const full = stickers.length >= max;

  if (!pack)
    return (
      <>
        <div className="page-title-row page-head stk-pack-head">
          <BackButton onBack={onBack} />
        </div>
        {error ? (
          <div className="callout warn" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="stk-busy">
            <Spinner />
          </div>
        )}
      </>
    );

  const update = async (patch: Omit<Parameters<typeof stickerAdmin.updatePack>[0], 'packId'>) => {
    try {
      setPack(await stickerAdmin.updatePack({ packId, ...patch }));
      toastOk('Pacote atualizado.');
    } catch (e) {
      toastError(e);
      void reload();
    }
  };

  const removePack = async () => {
    const ok = await confirmDialog({
      title: `Excluir o pacote “${pack.name}”?`,
      body: `As ${stickers.length} figurinhas saem do pacote. Mensagens já enviadas continuam com elas.`,
      confirmLabel: 'Excluir pacote',
      danger: true,
    });
    if (!ok) return;
    try {
      await stickerAdmin.deletePack(packId);
      onBack();
    } catch (e) {
      toastError(e);
    }
  };

  const removeSticker = async (s: StickerItem) => {
    const ok = await confirmDialog({
      title: `Excluir a figurinha “${s.name}”?`,
      body: 'Ela sai do pacote. Mensagens já enviadas continuam com ela.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      await stickerAdmin.deleteSticker(s._id);
      void reload();
    } catch (e) {
      toastError(e);
    }
  };

  const create = () => setEditor({ target: { packId }, onSaved: () => void reload() });
  // Mover só entre pacotes do mesmo dono.
  const others = (scope === 'org' ? targets.org : targets.personal).filter((p) => p._id !== packId);
  const canRemoveAll = scope === 'org' && (caps.canManage || caps.canModerate);

  // Fragmento: o cabeçalho fica filho direto do corpo da página, como a barra de 56 px das outras seções.
  return (
    <>
      <PackHead
        pack={pack}
        count={stickers.length}
        max={max}
        onBack={onBack}
        onRename={(name) => void update({ name })}
        onExport={() => void stickerAdmin.exportPack(packId, pack.name).catch(toastError)}
        onImport={() => setImporting(true)}
        onDelete={() => void removePack()}
      />
      {/* Recarregar falhou (rede, limite do servidor): a lista abaixo pode estar desatualizada. */}
      {error && (
        <div className="callout warn" role="alert">
          <Icon name="error" />
          <span>{error}</span>
        </div>
      )}
      {scope === 'org' && <OrgFields key={pack._id} pack={pack} onSave={(patch) => void update(patch)} />}
      {stickers.length === 0 ? (
        <Empty
          icon="sticker-pack"
          title="Pacote vazio"
          action={
            <>
              <button type="button" className="btn primary" onClick={create}>
                Criar figurinha
              </button>
              <button type="button" className="btn" onClick={() => setImporting(true)}>
                Importar
              </button>
            </>
          }
        >
          Adicione figurinhas criando a partir de imagens ou importando um arquivo.
        </Empty>
      ) : (
        <ul className="stk-tiles" {...reorder.containerProps}>
          <li className="stk-tile-slot">
            <button type="button" className="stk-tile-add" disabled={full} onClick={create}>
              <Icon name="sticker-create" size={24} />
              Adicionar
            </button>
          </li>
          {ordered.map((s) => (
            <li key={s._id} className="stk-tile" {...reorder.itemProps(s._id)}>
              <TileBody pack={pack} sticker={s} scope={scope} onOpen={() => setEditor({ source: { kind: 'sticker', sticker: s }, onSaved: () => void reload() })} />
              <div className="stk-tile-more">
                <TileMenu
                  pack={pack}
                  sticker={s}
                  others={others}
                  max={max}
                  canRemoveAll={canRemoveAll}
                  onEdit={() => setEditor({ source: { kind: 'sticker', sticker: s }, onSaved: () => void reload() })}
                  onCover={() => void update({ coverStickerId: s._id })}
                  onMove={(to) =>
                    void stickerAdmin
                      .moveSticker(s._id, to)
                      .then(() => reload())
                      .catch(toastError)
                  }
                  onDelete={() => void removeSticker(s)}
                  onRemoveAll={() => setRemoving(s.fileId)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <DragGhostLayer ghost={reorder.ghost}>
        {reorder.ghost && byId.get(reorder.ghost.id) && <TileBody pack={pack} sticker={byId.get(reorder.ghost.id)!} scope={scope} />}
      </DragGhostLayer>
      <LiveRegion text={reorder.message} />
      {editor && <StickerEditorDialog {...editor} onClose={() => setEditor(null)} />}
      {importing && (
        <ImportStickersModal
          packId={packId}
          scope={scope}
          onClose={() => {
            setImporting(false);
            void reload();
          }}
        />
      )}
      {removing && <RemoveEverywhereDialog target={{ fileId: removing }} onClose={() => setRemoving(null)} onDone={() => void reload()} />}
    </>
  );
}

export default PackManager;

function BackButton({ onBack }: { onBack(): void }) {
  return (
    <button type="button" className="icon-btn stk-pack-back" title="Voltar" aria-label="Voltar" onClick={onBack}>
      <Icon name="back" />
    </button>
  );
}

function PackHead({
  pack,
  count,
  max,
  onBack,
  onRename,
  onExport,
  onImport,
  onDelete,
}: {
  pack: StickerPack;
  count: number;
  max: number;
  onBack(): void;
  onRename(name: string): void;
  onExport(): void;
  onImport(): void;
  onDelete(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pack.name);
  const done = (save: boolean) => {
    setEditing(false);
    const n = name.trim();
    if (save && n && n !== pack.name) onRename(n);
    else setName(pack.name);
  };
  return (
    <div className="page-title-row page-head stk-pack-head">
      <BackButton onBack={onBack} />
      {editing ? (
        <input
          className="stk-pack-rename"
          value={name}
          maxLength={STICKER_LIMITS.packNameMax}
          aria-label="Nome"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={() => done(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              done(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              done(false);
            }
          }}
        />
      ) : (
        <h1 className="stk-pack-title">
          <button
            type="button"
            className="stk-pack-name"
            title="Renomear"
            onClick={() => {
              setName(pack.name);
              setEditing(true);
            }}
          >
            <span className="stk-pack-name-text">{pack.name}</span>
            <Icon name="edit" size={14} />
          </button>
        </h1>
      )}
      <span className="stk-pack-count">
        {count} de {plural(max, 'figurinha', 'figurinhas')}
      </span>
      <Menu
        label="Mais ações do pacote"
        trigger={
          <button type="button" className="icon-btn stk-pack-more" title="Mais ações" aria-label="Mais ações do pacote">
            <Icon name="more" />
          </button>
        }
      >
        {(close) => (
          <>
            <button
              type="button"
              disabled={count === 0}
              onClick={() => {
                close();
                onExport();
              }}
            >
              <Icon name="sticker-export" />
              Exportar pacote
            </button>
            <button
              type="button"
              disabled={count >= max}
              onClick={() => {
                close();
                onImport();
              }}
            >
              <Icon name="sticker-import" />
              Importar figurinhas
            </button>
            <hr />
            <button
              type="button"
              className="danger"
              onClick={() => {
                close();
                onDelete();
              }}
            >
              <Icon name="delete" />
              Excluir pacote
            </button>
          </>
        )}
      </Menu>
    </div>
  );
}

// Descrição, Situação e Visível para (só pacotes da organização). Cada mudança salva sozinha.
function OrgFields({ pack, onSave }: { pack: StickerPack; onSave(patch: { description?: string; status?: 'draft' | 'published'; visibleRoles?: string[] }): void }) {
  const id = useId();
  const roles = useGlobalRoles();
  const [description, setDescription] = useState(pack.description);
  return (
    <div className="card stk-pack-org">
      <div className="form">
        <label className="field">
          <span className="field-label">Descrição</span>
          <textarea
            rows={2}
            value={description}
            maxLength={STICKER_LIMITS.packDescriptionMax}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description.trim() !== pack.description && onSave({ description: description.trim() })}
          />
        </label>
        <div className="field">
          <span className="field-label" id={`${id}-s`}>
            Situação
          </span>
          <Segmented
            label="Situação"
            value={pack.status}
            onChange={(status) => status !== pack.status && onSave({ status })}
            items={[
              { id: 'draft', label: 'Rascunho' },
              { id: 'published', label: 'Publicado' },
            ]}
          />
          <span className="field-hint">{pack.status === 'draft' ? 'Rascunhos só aparecem aqui.' : 'Todo mundo que pode ver o pacote encontra no seletor.'}</span>
        </div>
        <div className="field">
          <span className="field-label" id={`${id}-r`}>
            Visível para
          </span>
          <RoleChips value={pack.visibleRoles} roles={roles} labelledBy={`${id}-r`} max={STICKER_LIMITS.visibleRolesMax} onChange={(visibleRoles) => onSave({ visibleRoles })} />
          <span className="field-hint">
            {pack.visibleRoles.length
              ? 'Só quem tem um destes papéis encontra, favorita e salva estas figurinhas. Quem recebe uma delas numa conversa continua vendo a imagem.'
              : 'Sem papéis escolhidos, todo mundo vê.'}
          </span>
        </div>
      </div>
    </div>
  );
}

// A figurinha e o nome; sem onOpen é só a imagem (a peça que acompanha o ponteiro no arrasto).
function TileBody({ pack, sticker: s, scope, onOpen }: { pack: StickerPack; sticker: StickerItem; scope: Scope; onOpen?: () => void }) {
  const body = (
    <>
      <span className="stk-tile-img">
        <StickerView sticker={asLiveSticker(s, scope)} size="picker" />
      </span>
      <span className="stk-tile-label">
        <span className="stk-tile-name" title={s.name}>
          {s.name}
        </span>
        {isCover(pack, s) && <span className="pill accent stk-tile-cover">Capa</span>}
      </span>
      <span className="stk-tile-drag" data-drag-handle="" aria-hidden="true">
        <Icon name="sticker-drag" size={14} />
      </span>
    </>
  );
  if (!onOpen) return <div className="stk-tile-open">{body}</div>;
  return (
    <button type="button" className="stk-tile-open" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" onClick={onOpen}>
      {body}
    </button>
  );
}

// "Mover para…" troca o menu pela lista dos pacotes do mesmo dono (o menu do DS não tem submenu).
function TileMenu({
  pack,
  sticker: s,
  others,
  max,
  canRemoveAll,
  onEdit,
  onCover,
  onMove,
  onDelete,
  onRemoveAll,
}: {
  pack: StickerPack;
  sticker: StickerItem;
  others: StickerPack[];
  max: number;
  canRemoveAll: boolean;
  onEdit(): void;
  onCover(): void;
  onMove(packId: string): void;
  onDelete(): void;
  onRemoveAll(): void;
}) {
  const [moving, setMoving] = useState(false);
  // A lista nova recebe o foco (o botão "Mover para…" sumiu do menu) e, no "Voltar", o foco volta para ele.
  const back = useRef(false);
  const focusFirst = useCallback((n: HTMLElement | null) => {
    if (!n) return;
    (n.querySelector<HTMLElement>('button[title]:not(:disabled)') ?? n.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }, []);
  const focusMove = useCallback((n: HTMLButtonElement | null) => {
    if (!n || !back.current) return;
    back.current = false;
    n.focus({ preventScroll: true });
  }, []);
  return (
    <Menu
      label="Mais ações"
      sheetTitle={s.name}
      onOpenChange={(open) => !open && setMoving(false)}
      trigger={
        <button type="button" className="icon-btn" title="Mais ações" aria-label={`Mais ações: ${s.name}`}>
          <Icon name="more" size={16} />
        </button>
      }
    >
      {(close) =>
        moving ? (
          <div ref={focusFirst} className="stk-move-list">
            <button
              type="button"
              onClick={() => {
                back.current = true;
                setMoving(false);
              }}
            >
              <Icon name="back" />
              Voltar
            </button>
            <hr />
            <div className="menu-label" role="presentation">
              Mover para…
            </div>
            {others.map((p) => {
              const label = p.status === 'draft' ? `${p.name} (rascunho)` : p.name;
              return (
                <button
                  key={p._id}
                  type="button"
                  title={label}
                  disabled={p.count >= max}
                  onClick={() => {
                    close();
                    onMove(p._id);
                  }}
                >
                  <Icon name="sticker-pack" />
                  <span className="stk-move-name">{label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                close();
                onEdit();
              }}
            >
              <Icon name="edit" />
              Editar
            </button>
            <button ref={focusMove} type="button" disabled={!others.length} onClick={() => setMoving(true)}>
              <Icon name="sticker-pack" />
              Mover para…
              <Icon name="next" className="stk-menu-chevron" />
            </button>
            {!isCover(pack, s) && (
              <button
                type="button"
                onClick={() => {
                  close();
                  onCover();
                }}
              >
                <Icon name="image-change" />
                Definir como capa
              </button>
            )}
            <hr />
            <button
              type="button"
              className="danger"
              onClick={() => {
                close();
                onDelete();
              }}
            >
              <Icon name="delete" />
              Excluir
            </button>
            {canRemoveAll && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  close();
                  onRemoveAll();
                }}
              >
                <Icon name="sticker-remove-all" />
                Remover de todas as conversas
              </button>
            )}
          </>
        )
      }
    </Menu>
  );
}
