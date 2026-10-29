// Figurinhas: Minha conta → Figurinhas (/account/stickers). Preferências, os pacotes da organização para quem cuida
// deles, meus pacotes com a cota, favoritas e recentes. Com ?pack=<id> abre o pacote.
import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { StickerPack } from '@shared/stickers';
import { plural } from '../../lib/format';
import { clearRecents, loadStickers, setFavorite, setStickerPrefs, stickerAdmin, stickerErrorText, useStickerCaps, useStickers } from '../../lib/stickers';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { useMedia } from '../../components/overlay';
import { Empty, SkeletonList, Spinner, Toggle } from '../../components/ui';
import { NewPackDialog, StickerEditorDialog } from '../../components/stickers/StickerMenuItems';
import { StickerView } from '../../components/stickers/StickerView';
import { DragGhostLayer, LiveRegion, PackCover, useReorder } from '../../components/stickers/studioParts';
import '../../components/stickers/studio.css';
import { PageHead } from '../admin/parts';

const PackManager = lazy(() => import('../../components/stickers/PackManager'));
const ImportStickersModal = lazy(() => import('../../components/stickers/ImportStickersModal'));

const toastOk = (text: string) => useStore.getState().toast(text, 'success');
const toastError = (e: unknown) => useStore.getState().toast(stickerErrorText(e), 'error');
const mb = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

type Anim = 'system' | 'auto' | 'hover' | 'never';
const DEFAULT_LABEL: Record<'auto' | 'hover' | 'never', string> = {
  auto: 'reproduzir automaticamente',
  hover: 'só ao passar o mouse ou tocar',
  never: 'nunca',
};

export function StickersSection() {
  const [params, setParams] = useSearchParams();
  const packId = params.get('pack');
  const caps = useStickerCaps();
  // Desligada, o servidor só atende quem cuida dos pacotes: para os outros não há o que carregar nem criar.
  const off = !caps.on && !caps.canManage;
  useEffect(() => {
    if (!off) void loadStickers('mine').catch(() => undefined);
  }, [off]);
  if (off)
    return (
      <>
        <PageHead title="Figurinhas" />
        <div className="account-col">
          <div className="card">
            <Empty icon="sticker" title="As figurinhas estão desativadas">
              Quando a administração ativar, suas figurinhas aparecem aqui.
            </Empty>
          </div>
        </div>
      </>
    );
  if (packId)
    return (
      <Suspense fallback={<Loading />}>
        <PackManager key={packId} scope="personal" packId={packId} onBack={() => setParams({})} />
      </Suspense>
    );
  return (
    <>
      <PageHead title="Figurinhas" />
      <div className="account-col">
        <Preferences />
        <OrgCard />
        <Catalog onOpen={(id) => setParams({ pack: id })} />
      </div>
    </>
  );
}

export default StickersSection;

function Loading() {
  return (
    <div className="stk-busy">
      <Spinner />
    </div>
  );
}

// Meus pacotes, favoritas e recentes vêm da mesma lista: um só "carregando" e um só erro para os três.
function Catalog({ onOpen }: { onOpen(id: string): void }) {
  const loaded = useStickers((s) => !!s.mine);
  const status = useStickers((s) => s.status.mine);
  if (!loaded && status === 'error')
    return (
      <div className="card">
        <Empty
          icon="error"
          tone="danger"
          title="Não foi possível carregar as figurinhas"
          action={
            <button type="button" className="btn" onClick={() => void loadStickers('mine', { force: true }).catch(() => undefined)}>
              Tentar de novo
            </button>
          }
        />
      </div>
    );
  if (!loaded)
    return (
      <div className="card">
        <SkeletonList n={3} />
      </div>
    );
  return (
    <>
      <MyPacks onOpen={onOpen} />
      <Favorites />
      <Recents />
    </>
  );
}

function Preferences() {
  const prefs = useStore((s) => s.me?.preferences);
  const caps = useStickerCaps();
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const value: Anim = prefs?.stickerAnimation && prefs.stickerAnimation !== 'system' ? prefs.stickerAnimation : 'system';
  const save = (p: Parameters<typeof setStickerPrefs>[0]) => void setStickerPrefs(p).catch(toastError);
  const options: [Anim, string][] = [
    ['system', `Padrão da organização (${DEFAULT_LABEL[caps.animationDefault]})`],
    ['auto', 'Reproduzir automaticamente (por até 5 segundos)'],
    ['hover', 'Só ao passar o mouse ou tocar'],
    ['never', 'Nunca (mostrar a imagem parada)'],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Preferências</h2>
      </div>
      <div className="form">
        <div className="field" role="radiogroup" aria-labelledby="stk-anim-label">
          <span className="field-label" id="stk-anim-label">
            Animação das figurinhas
          </span>
          <div className="stk-radios">
            {options.map(([id, label]) => (
              <label key={id} className="check">
                <input type="radio" name="stk-anim" checked={value === id} onChange={() => save({ stickerAnimation: id })} />
                {label}
              </label>
            ))}
          </div>
          {value === 'system' && reduced && <span className="field-hint">Seu sistema pede menos movimento, então as figurinhas ficam paradas.</span>}
          <span className="field-hint">Se luzes piscando incomodam você, escolha “Nunca”.</span>
        </div>
        <div className="toggle-list">
          <Toggle checked={prefs?.stickerSuggestions !== false} onChange={(v) => save({ stickerSuggestions: v })} label="Sugerir figurinhas quando eu digitar só um emoji" />
        </div>
      </div>
    </div>
  );
}

function OrgCard() {
  const caps = useStickerCaps();
  const navigate = useNavigate();
  if (!caps.canManage) return null;
  return (
    <button type="button" className="card action stk-org-card" onClick={() => navigate('/admin/stickers')}>
      <span className="card-icon">
        <Icon name="sticker-manage" />
      </span>
      <span className="stk-org-text">
        <strong>Pacotes da organização</strong>
        <span className="card-desc">Você cuida dos pacotes oficiais da empresa.</span>
      </span>
      <span className="btn" aria-hidden="true">
        Gerenciar
      </span>
    </button>
  );
}

function MyPacks({ onOpen }: { onOpen(id: string): void }) {
  const caps = useStickerCaps();
  const mine = useStickers((s) => s.mine);
  const [newPack, setNewPack] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const packs = mine?.packs ?? [];
  const reorder = useReorder(
    packs.map((p) => p._id),
    (ids) => stickerAdmin.reorderPacks('personal', ids),
    (i, n) => `Movido para a posição ${i} de ${n}`,
  );
  const byId = new Map(packs.map((p) => [p._id, p]));
  const ordered = reorder.order.map((id) => byId.get(id)).filter((p): p is StickerPack => !!p);
  if (!caps.canCreate && !packs.length) return <p className="stk-note">Seu perfil não cria figurinhas. Você pode usar as da organização e favoritar as que receber.</p>;
  const q = mine?.quota;
  const full = !!q && q.packs >= q.maxPacks;
  const row = (p: StickerPack) => (
    <>
      <PackCover pack={p} size={40} />
      <span className="stk-row-text">
        <span className="stk-row-name" title={p.name}>
          {p.name}
        </span>
        <span className="stk-row-sub">{plural(p.count, 'figurinha', 'figurinhas')}</span>
      </span>
      <span className="stk-row-drag" data-drag-handle="" aria-hidden="true">
        <Icon name="sticker-drag" size={16} />
      </span>
      <Icon name="next" size={16} />
    </>
  );
  return (
    <div className="card">
      <div className="card-head stk-packs-head">
        <h2>Meus pacotes</h2>
        {caps.canCreate && (
          <div className="row-actions">
            <button type="button" className="btn small" disabled={full} onClick={() => setNewPack(true)}>
              <Icon name="sticker-pack-new" />
              Novo pacote
            </button>
            <button type="button" className="btn small" onClick={() => setImporting(true)}>
              <Icon name="sticker-import" />
              Importar
            </button>
          </div>
        )}
      </div>
      {!caps.canCreate && <p className="stk-note">Seu perfil não cria figurinhas. Você pode usar as da organização e favoritar as que receber.</p>}
      {q && (
        <div className="stk-quota">
          <div className="stk-progress" role="progressbar" aria-label="Espaço usado" aria-valuemin={0} aria-valuemax={q.quotaBytes} aria-valuenow={q.bytes}>
            <span style={{ width: `${q.quotaBytes ? Math.min(100, (q.bytes / q.quotaBytes) * 100) : 0}%` }} />
          </div>
          <span className="stk-quota-text">
            {mb.format(q.bytes / 1024 / 1024)} MB de {mb.format(q.quotaBytes / 1024 / 1024)} MB · {q.packs} de {plural(q.maxPacks, 'pacote', 'pacotes')}
          </span>
        </div>
      )}
      {!packs.length ? (
        <Empty
          icon="sticker-pack"
          title="Você ainda não tem pacotes"
          action={
            caps.canCreate && (
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                Criar figurinha
              </button>
            )
          }
        >
          Crie uma figurinha ou salve uma que receber para começar.
        </Empty>
      ) : (
        <ul className="stk-pack-rows" {...reorder.containerProps}>
          {ordered.map((p) => (
            <li key={p._id} {...reorder.itemProps(p._id)}>
              <button type="button" className="stk-pack-row" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onClick={() => onOpen(p._id)}>
                {row(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <DragGhostLayer ghost={reorder.ghost}>{reorder.ghost && byId.get(reorder.ghost.id) && <div className="stk-pack-row">{row(byId.get(reorder.ghost.id)!)}</div>}</DragGhostLayer>
      <LiveRegion text={reorder.message} />
      {newPack && (
        <NewPackDialog
          scope="personal"
          onClose={() => setNewPack(false)}
          onCreated={(p) => {
            setNewPack(false);
            onOpen(p._id);
          }}
        />
      )}
      {importing && (
        <Suspense fallback={null}>
          <ImportStickersModal scope="personal" onClose={() => setImporting(false)} />
        </Suspense>
      )}
      {creating && <StickerEditorDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function Favorites() {
  const mine = useStickers((s) => s.mine);
  const caps = useStickerCaps();
  const favorites = mine?.favorites ?? [];
  return (
    <div className="card">
      <div className="card-head stk-fav-head">
        <h2>Favoritas</h2>
        <span className="stk-counter">
          {favorites.length} de {caps.limits.maxFavorites}
        </span>
      </div>
      {!favorites.length ? (
        <Empty icon="sticker-favorite" title="Nenhuma favorita">
          Favorite figurinhas pelo seletor ou pelo menu de uma mensagem.
        </Empty>
      ) : (
        <ul className="stk-favs">
          {favorites.map((f) => (
            <li key={f.fileId} className="stk-fav">
              <StickerView sticker={{ ...f, removed: false }} size="picker" />
              <button
                type="button"
                className="icon-btn stk-fav-remove"
                title="Remover das favoritas"
                aria-label={`Remover das favoritas: ${f.name}`}
                onClick={() => void setFavorite({ fileId: f.fileId }, false).catch(toastError)}
              >
                <Icon name="sticker-unfavorite" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Recents() {
  const recents = useStickers((s) => s.mine?.recents.length ?? 0);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Recentes</h2>
      </div>
      <div className="stk-recents">
        <span>{recents ? plural(recents, 'figurinha usada recentemente', 'figurinhas usadas recentemente') : 'Nenhuma figurinha usada recentemente'}</span>
        {recents > 0 && (
          <button
            type="button"
            className="btn ghost small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void clearRecents()
                .then(() => toastOk('Recentes apagadas.'), toastError)
                .finally(() => setBusy(false));
            }}
          >
            Apagar recentes
          </button>
        )}
      </div>
    </div>
  );
}
