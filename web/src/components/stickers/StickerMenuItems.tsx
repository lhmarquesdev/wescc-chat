// Itens das figurinhas no "Mais" da mensagem, o diálogo "Remover de todas as conversas", o "Novo pacote" e o
// lugar onde ficam os diálogos que abrem a partir de um menu (o menu desmonta ao fechar; o diálogo não pode ir junto).
import { createContext, Fragment, lazy, Suspense, useContext, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '@shared/index';
import { canCreateFromMessage, STICKER_LIMITS, type StickerPack, type StickerScope } from '@shared/stickers';
import { plural } from '../../lib/format';
import { canRemoveEverywhere, isRestrictedForMe, loadStickers, saveSticker, setFavorite, stickerAdmin, stickerErrorText, useStickerCaps, useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { Portal } from '../overlay';
import { Field, Modal, Spinner, useAsync } from '../ui';
import type { StickerEditorProps } from './StickerEditor';
import { toggleStickerPlayback, useStickerPlaying } from './StickerView';

const StickerEditor = lazy(() => import('./StickerEditor'));

// ---------- Onde os diálogos ficam ----------

type OpenDialog = (node: ReactNode) => void;
const HostCtx = createContext<OpenDialog | null>(null);
let dialogSeq = 0;

export function StickerHost({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null);
  const [open] = useState<OpenDialog>(() => (n: ReactNode) => setNode(n ? <Fragment key={++dialogSeq}>{n}</Fragment> : null));
  return (
    <HostCtx.Provider value={open}>
      {children}
      {node}
    </HostCtx.Provider>
  );
}

// Sem um StickerHost acima (uso fora da conversa): uma raiz própria no fim do <body>, como o confirmDialog.
let outside: Root | null = null;
function openOutside(node: ReactNode) {
  if (!outside) {
    const host = document.createElement('div');
    host.id = 'sticker-dialog-root';
    document.body.appendChild(host);
    outside = createRoot(host);
  }
  outside.render(node ? <Fragment key={++dialogSeq}>{node}</Fragment> : null);
}

export function useStickerDialog(): OpenDialog {
  return useContext(HostCtx) ?? openOutside;
}

// O editor carrega só quando alguém o abre.
export function StickerEditorDialog(props: StickerEditorProps) {
  return (
    <Suspense
      fallback={
        <Portal>
          <div className="modal-backdrop sticker-editor-loading">
            <Spinner size="lg" />
          </div>
        </Portal>
      }
    >
      <StickerEditor {...props} />
    </Suspense>
  );
}

export function useOpenStickerEditor() {
  const open = useStickerDialog();
  return (props: Omit<StickerEditorProps, 'onClose'> & { onClose?: () => void }) =>
    open(
      <StickerEditorDialog
        {...props}
        onClose={() => {
          open(null);
          props.onClose?.();
        }}
      />,
    );
}

// "Criar figurinha" a partir da imagem enviada nesta mensagem: a origem e quem abre o editor, ou null.
export function useCreateSticker(m: Message, inThread?: boolean): { url: string; open: () => void } | null {
  const caps = useStickerCaps();
  const openEditor = useOpenStickerEditor();
  // Função desligada: o servidor só aceita o gestor (assertStickersOn).
  const src = caps.canAuthor && (caps.on || caps.canManage) ? canCreateFromMessage(m) : null;
  if (!src) return null;
  return {
    url: src.url,
    open: () =>
      openEditor({
        source: { kind: 'message', messageId: m._id, url: src.url, name: src.name },
        // No painel do tópico a mensagem de origem não tem tmid: o tópico é ela mesma.
        room: { rid: m.rid, tmid: inThread ? m.tmid ?? m._id : null },
      }),
  };
}

// ---------- Ações ----------

const toastError = (e: unknown) => useStore.getState().toast(stickerErrorText(e), 'error');

export async function saveFromMessage(m: Message, packId?: string): Promise<void> {
  try {
    const item = await saveSticker({ messageId: m._id }, packId ? { packId } : {});
    const pack = useStickers.getState().mine?.packs.find((p) => p._id === item.packId);
    useStore.getState().toast(`Figurinha salva em “${pack?.name ?? 'Minhas figurinhas'}”.`, 'success');
  } catch (e) {
    toastError(e);
  }
}

export function toggleFavorite(target: { messageId?: string; stickerId?: string; fileId?: string }, favorite: boolean): void {
  setFavorite(target, favorite).catch(toastError);
}

// ---------- Itens do menu ----------

interface ItemProps {
  message: Message;
  close: () => void;
  sheetRole?: boolean; // na folha do toque longo os itens declaram o papel (o Menu faz isso sozinho)
}

function Item({ icon, label, run, close, sheetRole, danger }: { icon: IconName; label: string; run: () => void; close: () => void; sheetRole?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role={sheetRole ? 'menuitem' : undefined}
      className={danger ? 'danger' : undefined}
      onClick={() => {
        close();
        run();
      }}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
}

// Favoritar, salvar e "Ver no seletor" dependem dos dois catálogos (do cache ou da rede). Antes deles o rótulo da
// favorita sairia errado e a figurinha de pacote restrito ofereceria o que o servidor recusa: os itens esperam.
export function useCatalogsReady(): boolean {
  return useStickers((st) => !!st.org && !!st.mine);
}

// O que uma figurinha recebida pode me oferecer. Salvar não depende de enviar (D4): quem está em
// Stickers_Send_Blocked_Roles e cria figurinhas ainda salva, então também carrega os catálogos.
export function useStickerOffers(): { favorite: boolean; save: boolean; ready: boolean } {
  const caps = useStickerCaps();
  const favorite = caps.enabled;
  const save = caps.on && caps.canCreate;
  const want = favorite || save;
  // Quase sempre já estão no cache; aqui só conferem a versão.
  useEffect(() => {
    if (want) void loadStickers('both');
  }, [want]);
  const ready = useCatalogsReady();
  return { favorite, save, ready };
}

// O mesmo arquivo pode ter sido removido por um evento depois que a mensagem chegou.
function useLiveSticker(m: Message) {
  const s = m.sticker;
  const removedHere = useStickers((st) => (s ? st.removed.has(s.fileId) : false));
  return s && !s.removed && !removedHere ? s : null;
}

export function StickerMenuItems({ message, close, sheetRole }: ItemProps) {
  const s = useLiveSticker(message);
  const fav = useStickers((st) => (s ? st.favorites.has(s.fileId) : false));
  useStickers((st) => st.org); // isRestrictedForMe depende do catálogo da organização
  const offers = useStickerOffers();
  const playing = useStickerPlaying(message._id);
  if (!s) return null;
  const offer = offers.ready && !isRestrictedForMe(s);
  return (
    <>
      {offers.favorite && offer && (
        <Item
          icon={fav ? 'sticker-unfavorite' : 'sticker-favorite'}
          label={fav ? 'Remover das figurinhas favoritas' : 'Adicionar às figurinhas favoritas'}
          close={close}
          sheetRole={sheetRole}
          run={() => toggleFavorite({ messageId: message._id }, !fav)}
        />
      )}
      {offers.save && offer && (
        <Item icon="sticker-save" label="Salvar nas minhas figurinhas" close={close} sheetRole={sheetRole} run={() => void saveFromMessage(message)} />
      )}
      {s.animated && (
        <Item
          icon={playing ? 'sticker-pause' : 'sticker-play'}
          label={playing ? 'Pausar animação' : 'Reproduzir animação'}
          close={close}
          sheetRole={sheetRole}
          run={() => toggleStickerPlayback(message._id)}
        />
      )}
    </>
  );
}

export function StickerRemoveItem({ message, close, sheetRole }: ItemProps) {
  const s = useLiveSticker(message);
  const open = useStickerDialog();
  useStickerCaps(); // permissões mudam: o item aparece ou some
  if (!s || !canRemoveEverywhere(s)) return null;
  return (
    <Item
      danger
      icon="sticker-remove-all"
      label="Remover de todas as conversas"
      close={close}
      sheetRole={sheetRole}
      run={() => open(<RemoveEverywhereDialog target={{ messageId: message._id }} onClose={() => open(null)} />)}
    />
  );
}

export function CreateStickerItem({ message, close, sheetRole, inThread }: ItemProps & { inThread?: boolean }) {
  const create = useCreateSticker(message, inThread);
  if (!create) return null;
  return <Item icon="sticker-create" label="Criar figurinha" close={close} sheetRole={sheetRole} run={create.open} />;
}

// ---------- Remover de todas as conversas ----------

export function RemoveEverywhereDialog({
  target,
  onClose,
  onDone,
}: {
  target: { fileId?: string; messageId?: string };
  onClose: () => void;
  onDone?: (r: { messages: number; packs: number; users: number; alreadyRemoved?: true }) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usage = useAsync(
    () =>
      stickerAdmin.usage(target).catch((e) => {
        throw new Error(stickerErrorText(e));
      }),
    [target.fileId, target.messageId],
  );
  const u = usage.data;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await stickerAdmin.removeEverywhere(target, reason.trim());
      const toast = useStore.getState().toast;
      if (r.alreadyRemoved) toast('Esta figurinha já tinha sido removida.', 'info');
      else toast('Figurinha removida de todas as conversas.', 'success');
      onDone?.(r);
      onClose();
    } catch (e) {
      setError(stickerErrorText(e));
      setBusy(false);
    }
  };
  const sources = [...new Set((u?.provenance?.sources ?? []).map((x) => x.sourceUser).filter((x): x is string => !!x))];
  return (
    <Modal
      size="sm"
      variant="sheet"
      className="sticker-remove"
      title="Remover esta figurinha de todas as conversas?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn danger solid" disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>
            Remover de todas
          </button>
        </>
      }
    >
      <div className="sticker-remove-text" aria-live="polite">
        {usage.loading && !u ? (
          <p>Verificando onde ela aparece…</p>
        ) : u ? (
          <>
            <p>
              Ela some de {plural(u.messages, 'mensagem', 'mensagens')} em {plural(u.rooms, 'conversa', 'conversas')} e de {plural(u.packCount, 'pacote', 'pacotes')},
              inclusive das favoritas de todo mundo.
            </p>
            <p>
              {u.keepDays > 0
                ? `Cópias iguais deixam de ser aceitas. Uma cópia fica guardada por ${plural(u.keepDays, 'dia', 'dias')}, só para a moderação.`
                : 'A imagem é apagada do servidor e cópias iguais deixam de ser aceitas.'}
            </p>
            {u.provenance && (u.provenance.createdBy || sources.length > 0) && (
              <p className="sticker-provenance">
                {u.provenance.createdBy && `Enviada primeiro por @${u.provenance.createdBy}. `}
                {sources.map((name) => `Criada a partir de uma imagem de @${name}.`).join(' ')}
              </p>
            )}
          </>
        ) : null}
      </div>
      {usage.error && (
        <div className="callout warn">
          <Icon name="error" />
          <span>{usage.error}</span>
        </div>
      )}
      <Field label="Motivo (opcional)">
        <textarea rows={2} maxLength={500} placeholder="Ex.: conteúdo ofensivo" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && (
        <div className="callout warn" role="alert">
          <Icon name="error" />
          <span>{error}</span>
        </div>
      )}
    </Modal>
  );
}

// ---------- Novo pacote ----------

// Cria o pacote e chama onCreated com ele; quem abriu fecha o diálogo (onClose é só o cancelar).
export function NewPackDialog({ scope, onCreated, onClose }: { scope: StickerScope; onCreated: (pack: StickerPack) => void; onClose: () => void }) {
  const formId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const pack = await stickerAdmin.createPack({ scope, name: n, description: scope === 'org' && description.trim() ? description.trim() : undefined });
      onCreated(pack);
    } catch (err) {
      setError(stickerErrorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title="Novo pacote"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={!name.trim() || busy} aria-busy={busy || undefined}>
            Criar
          </button>
        </>
      }
    >
      <form id={formId} className="form sticker-pack-form" onSubmit={(e) => void submit(e)}>
        <Field label="Nome" required>
          <input value={name} maxLength={STICKER_LIMITS.packNameMax} required onChange={(e) => setName(e.target.value)} />
        </Field>
        {scope === 'org' && (
          <Field label="Descrição">
            <textarea rows={2} value={description} maxLength={STICKER_LIMITS.packDescriptionMax} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        )}
        {error && (
          <div className="callout warn" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}
