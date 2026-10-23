import { useEffect, useState } from 'react';
import type { Message, NoticeAcks } from '@shared/index';
import { markAcked, useAcks } from '../lib/acks';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, plural } from '../lib/format';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Avatar, Empty, Modal, Pager, SkeletonList, Tabs, useAsync } from './ui';

const COUNT = 50;

const confirmedLabel = (n: number) => `${plural(n, 'pessoa confirmou', 'pessoas confirmaram')} · ver quem`;

// Linha do "Ciente" logo abaixo de um aviso que pede confirmação.
export function AckBar({ m, rid, canPost, member }: { m: Message; rid: string; canPost: boolean; member: boolean }) {
  const meId = useStore((s) => s.me?._id);
  const acks = useAcks((s) => s.byRoom[rid]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const own = m.u._id === meId;
  // Antes de saber o que a pessoa já confirmou, o botão não aparece (senão pisca e vira o selo).
  const reader = !own && member && !!acks;
  const counter = own || canPost;
  if (!reader && !counter) return null;

  const ack = async () => {
    setBusy(true);
    try {
      const r = await api.post('chat.ack', { messageId: m._id });
      markAcked(rid, m._id);
      if (r.message) useStore.getState().upsertMessage(r.message);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ack-bar">
      {reader &&
        (acks.acked.has(m._id) ? (
          <span className="pill ok">
            <Icon name="acked" size={12} />
            Você confirmou a leitura
          </span>
        ) : (
          <span className="ack-ask">
            <button type="button" className="btn small primary" disabled={busy} aria-busy={busy || undefined} onClick={ack}>
              <Icon name="ack" size={14} />
              Ciente
            </button>
            <span className="muted small">Confirme que você leu este aviso.</span>
          </span>
        ))}
      {counter && (
        <button type="button" className="link small ack-count" onClick={() => setOpen(true)}>
          <Icon name="ack-count" size={14} />
          {confirmedLabel(m.ackCount ?? 0)}
        </button>
      )}
      {open && <AckModal m={m} onClose={() => setOpen(false)} />}
    </div>
  );
}

// Quem já confirmou e quem ainda não confirmou um aviso (só para o autor e quem publica no canal).
export function AckModal({ m, onClose }: { m: Message; onClose: () => void }) {
  const [tab, setTab] = useState<'acked' | 'pending'>('acked');
  const [offset, setOffset] = useState(0);
  const [counts, setCounts] = useState<{ acked: number; pending: number | null }>({ acked: m.ackCount ?? 0, pending: null });
  const { data, loading, error } = useAsync(() => api.get('chat.getAcks', { messageId: m._id, status: tab, offset, count: COUNT }) as Promise<NoticeAcks>, [m._id, tab, offset]);
  useEffect(() => {
    if (data) setCounts({ acked: data.ackCount, pending: data.pendingCount });
  }, [data]);

  const rows = !data ? [] : tab === 'acked' ? data.acked.map((a) => ({ user: a.user, at: a.ackAt })) : data.pending.map((user) => ({ user, at: null }));

  return (
    <Modal title="Confirmações do aviso" onClose={onClose} className="ack-modal">
      <Tabs
        value={tab}
        onChange={(v) => (setTab(v), setOffset(0))}
        items={[
          { id: 'acked', label: `Confirmaram (${counts.acked})` },
          { id: 'pending', label: counts.pending === null ? 'Pendentes' : `Pendentes (${counts.pending})` },
        ]}
      />
      {/* Altura fixa com rolagem: trocar de aba não muda o tamanho do diálogo nem tira as abas do lugar. */}
      <div className="ack-body">
        {loading && !data ? (
          <SkeletonList n={5} />
        ) : error ? (
          <div className="form-error">{error}</div>
        ) : !rows.length ? (
          tab === 'acked' ? (
            <Empty icon="ack-count" title="Ninguém confirmou ainda">
              As confirmações aparecem aqui assim que as pessoas lerem o aviso.
            </Empty>
          ) : (
            <Empty icon="all-done" title="Todos já confirmaram">
              Ninguém está com este aviso pendente.
            </Empty>
          )
        ) : (
          <ul className="plain-list ack-list">
            {rows.map(({ user, at }) => (
              <li key={user._id}>
                <Avatar username={user.username} size={28} />
                <span className="ack-person">
                  <strong>{user.name || user.username}</strong> <span className="muted">@{user.username}</span>
                </span>
                {at && <span className="muted small">{formatDateTime(at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {data && <Pager offset={offset} count={COUNT} total={data.total} onChange={setOffset} />}
    </Modal>
  );
}
