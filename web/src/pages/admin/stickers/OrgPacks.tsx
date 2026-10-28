// Figurinhas: os pacotes da organização (rascunhos e publicados), na ordem do seletor, e "Novo pacote".
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { STICKER_LIMITS, type StickerPack } from '@shared/stickers';
import { api, errorMessage } from '../../../lib/api';
import { plural, roleLabel } from '../../../lib/format';
import { stickerAdmin, stickerErrorText, useStickers } from '../../../lib/stickers';
import { usePermission, useSetting, useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Modal, Skeleton, useAsync } from '../../../components/ui';
import { DragGhostLayer, LiveRegion, PackCover, RoleChips, useGlobalRoles, useReorder } from '../../../components/stickers/studioParts';
import { SendRolesCard } from './SendRolesCard';

export function OrgPacks() {
  const navigate = useNavigate();
  const enabled = useSetting<boolean>('Stickers_Enabled');
  const canEdit = usePermission('edit-privileged-setting');
  const version = useStickers((s) => s.org?.version);
  const { data, loading, error, reload } = useAsync(() => stickerAdmin.orgWithDrafts(), [version]);
  const [creating, setCreating] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const packs = data?.packs ?? [];
  const reorder = useReorder(
    packs.map((p) => p._id),
    (ids) => stickerAdmin.reorderPacks('org', ids).then(reload),
    (i, n) => `Movido para a posição ${i} de ${n}`,
  );
  const byId = new Map(packs.map((p) => [p._id, p]));
  const ordered = reorder.order.map((id) => byId.get(id)).filter((p): p is StickerPack => !!p);
  const open = (p: StickerPack) => navigate(`/admin/stickers/pack/${p._id}`);

  const enable = async () => {
    setEnabling(true);
    try {
      await api.post('settings', { settings: { Stickers_Enabled: true } });
      useStore.getState().toast('Configuração salva.', 'success');
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setEnabling(false);
    }
  };

  return (
    <>
      {enabled === false && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>As figurinhas estão desativadas. Os pacotes ficam guardados, mas ninguém vê o seletor.</span>
          {canEdit && (
            <button type="button" className="btn small callout-action" disabled={enabling} aria-busy={enabling || undefined} onClick={() => void enable()}>
              Ativar
            </button>
          )}
        </div>
      )}
      <SendRolesCard />
      {packs.length > 0 && (
        <div className="stk-toolbar">
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="sticker-pack-new" />
            Novo pacote
          </button>
        </div>
      )}
      {loading && !data ? (
        <OrgPacksSkeleton />
      ) : error && !data ? (
        <div className="callout warn" role="alert">
          <Icon name="error" />
          <span>{error}</span>
        </div>
      ) : !packs.length ? (
        <Empty
          icon="sticker-pack"
          title="Nenhum pacote da organização"
          action={
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="sticker-pack-new" />
              Novo pacote
            </button>
          }
        >
          Crie pacotes com as figurinhas oficiais da empresa. Eles aparecem para todos no seletor.
        </Empty>
      ) : (
        <ul className="stk-org-packs" {...reorder.containerProps}>
          {ordered.map((p) => (
            <li key={p._id} {...reorder.itemProps(p._id)}>
              <button type="button" className="card action stk-org-pack" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" onClick={() => open(p)}>
                <OrgPackBody pack={p} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <DragGhostLayer ghost={reorder.ghost}>
        {reorder.ghost && byId.get(reorder.ghost.id) && (
          <div className="card stk-org-pack">
            <OrgPackBody pack={byId.get(reorder.ghost.id)!} />
          </div>
        )}
      </DragGhostLayer>
      <LiveRegion text={reorder.message} />
      {creating && <NewOrgPackModal onClose={() => setCreating(false)} onCreated={open} />}
    </>
  );
}

// Enquanto carrega: cartões com a mesma forma dos pacotes (capa de 64 px e duas linhas).
function OrgPacksSkeleton() {
  return (
    <div className="stk-org-packs" role="status" aria-label="Carregando" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="card stk-org-pack">
            <Skeleton width={64} height={64} className="stk-sk-cover" />
            <span className="stk-org-pack-text">
              <Skeleton width={`${[64, 52, 72][i]}%`} height={16} />
              <Skeleton width="36%" />
              <Skeleton width={`${[48, 60, 40][i]}%`} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function OrgPackBody({ pack: p }: { pack: StickerPack }) {
  return (
    <>
      <PackCover pack={p} size={64} />
      <span className="stk-org-pack-text">
        <span className="stk-org-pack-name" title={p.name}>
          {p.name}
        </span>
        <span className="stk-org-pack-count">{plural(p.count, 'figurinha', 'figurinhas')}</span>
        <span className="stk-org-pack-meta">
          {p.status === 'draft' ? <span className="pill warn">Rascunho</span> : <span className="pill ok">Publicado</span>}
          <span className="stk-org-pack-roles">{p.visibleRoles.length ? `Visível para: ${p.visibleRoles.map((r) => roleLabel(r)).join(', ')}` : 'Visível para todos'}</span>
        </span>
      </span>
      <span className="stk-row-drag" data-drag-handle="" aria-hidden="true">
        <Icon name="sticker-drag" size={16} />
      </span>
    </>
  );
}

// Nasce como Rascunho: só aparece no seletor depois de publicado no pacote.
function NewOrgPackModal({ onClose, onCreated }: { onClose(): void; onCreated(p: StickerPack): void }) {
  const formId = useId();
  const rolesId = useId();
  const roles = useGlobalRoles();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibleRoles, setVisibleRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const pack = await stickerAdmin.createPack({ scope: 'org', name: n, description: description.trim() || undefined, status: 'draft', visibleRoles });
      onCreated(pack);
    } catch (err) {
      setError(stickerErrorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo pacote da organização"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={!name.trim() || busy} aria-busy={busy || undefined}>
            Criar
          </button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={(e) => void submit(e)}>
        <Field label="Nome" required>
          <input value={name} maxLength={STICKER_LIMITS.packNameMax} required autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Descrição">
          <textarea rows={2} value={description} maxLength={STICKER_LIMITS.packDescriptionMax} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label" id={rolesId}>
            Visível para
          </span>
          <RoleChips value={visibleRoles} roles={roles} labelledBy={rolesId} max={STICKER_LIMITS.visibleRolesMax} onChange={setVisibleRoles} />
          <span className="field-hint">
            {visibleRoles.length
              ? 'Só quem tem um destes papéis encontra, favorita e salva estas figurinhas. Quem recebe uma delas numa conversa continua vendo a imagem.'
              : 'Sem papéis escolhidos, todo mundo vê.'}
          </span>
        </div>
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
