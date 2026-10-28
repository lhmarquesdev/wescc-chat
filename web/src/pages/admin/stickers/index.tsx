// Figurinhas: Administração → Figurinhas. /admin/stickers (pacotes da organização), /admin/stickers/pack/:packId
// e /admin/stickers/removed (removidas pela moderação). Cada aba só para quem pode abri-la.
import { lazy, Suspense, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { MessageSticker } from '@shared/stickers';
import { useStickerCaps } from '../../../lib/stickers';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Spinner, Tabs } from '../../../components/ui';
import { RemoveEverywhereDialog } from '../../../components/stickers/StickerMenuItems';
import { StickerView } from '../../../components/stickers/StickerView';
import '../../../components/stickers/studio.css';
import { PageHead } from '../parts';
import { OrgPacks } from './OrgPacks';
import { RemovedStickers } from './RemovedStickers';

const PackManager = lazy(() => import('../../../components/stickers/PackManager'));

type Tab = 'packs' | 'removed';

export function AdminStickers() {
  const { view, param } = useParams();
  const navigate = useNavigate();
  const caps = useStickerCaps();
  const canSettings = usePermission('view-privileged-setting');
  if (view === 'pack' && param) {
    if (!caps.canManage) return <Navigate to="/admin/stickers" replace />;
    return (
      <Suspense
        fallback={
          <div className="stk-busy">
            <Spinner />
          </div>
        }
      >
        <PackManager key={param} scope="org" packId={param} onBack={() => navigate('/admin/stickers')} />
      </Suspense>
    );
  }
  const tab: Tab = view === 'removed' ? 'removed' : 'packs';
  if (tab === 'packs' && !caps.canManage) return <Navigate to={caps.canViewRemoved ? '/admin/stickers/removed' : '/home'} replace />;
  if (tab === 'removed' && !caps.canViewRemoved) return <Navigate to={caps.canManage ? '/admin/stickers' : '/home'} replace />;
  const tabs = [
    ...(caps.canManage ? [{ id: 'packs' as const, label: 'Pacotes da organização' }] : []),
    ...(caps.canViewRemoved ? [{ id: 'removed' as const, label: 'Removidas' }] : []),
  ];
  return (
    <>
      <PageHead title="Figurinhas">
        {canSettings && (
          <button type="button" className="btn ghost" onClick={() => navigate('/admin/settings')}>
            <Icon name="sticker-manage" />
            Configurações
          </button>
        )}
      </PageHead>
      <p className="page-lead">Pacotes oficiais da empresa e figurinhas removidas pela moderação.</p>
      {tabs.length > 1 && <Tabs value={tab} onChange={(t) => navigate(t === 'removed' ? '/admin/stickers/removed' : '/admin/stickers')} items={tabs} />}
      {tab === 'packs' ? <OrgPacks /> : <RemovedStickers />}
    </>
  );
}

// Na denúncia (Moderação): a figurinha da mensagem e, para quem modera, "Remover figurinha de todas as conversas".
export function ReportSticker({ sticker, messageId, onDone }: { sticker: MessageSticker; messageId: string; onDone(): void }) {
  const caps = useStickerCaps();
  const [open, setOpen] = useState(false);
  return (
    <div className="stk-report">
      <StickerView sticker={sticker} size="small" />
      {!sticker.removed && caps.canModerate && (
        <button type="button" className="btn small danger" onClick={() => setOpen(true)}>
          <Icon name="sticker-remove-all" />
          Remover figurinha de todas as conversas
        </button>
      )}
      {open && <RemoveEverywhereDialog target={{ messageId }} onClose={() => setOpen(false)} onDone={onDone} />}
    </div>
  );
}
