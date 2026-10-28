// "Chamar pessoas": membros da sala (a mesma lista do painel de membros), até 10 por vez. Quem já está nesta
// chamada ou em outra aparece desabilitado.
import { useEffect, useState } from 'react';
import { CALL_LIMITS, callPeopleLabel } from '@shared/calls';
import { api } from '../../lib/api';
import { refreshRoster, ringPeople, useCallStore } from '../../lib/call/store';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { Avatar, Modal, SearchInput, Spinner } from '../ui';

interface Member {
  _id: string;
  username: string;
  name?: string;
  status?: string;
}

export function RingPicker({ onClose }: { onClose: () => void }) {
  const rid = useCallStore((s) => s.call?.rid);
  const peers = useCallStore((s) => s.peers);
  const roster = useCallStore((s) => s.roster);
  const meId = useStore((s) => s.me?._id);
  const [q, setQ] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [elsewhere, setElsewhere] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!rid) return;
    let alive = true;
    const t = window.setTimeout(
      () => {
        api
          .get('rooms.membersOrderedByRole', { roomId: rid, filter: q.trim(), count: 200 })
          .then(async (r: { members: Member[] }) => {
            if (!alive) return;
            const list = r.members.filter((m) => m._id !== meId);
            const ids = list.map((m) => m._id).slice(0, 200);
            // A lista aparece junto com quem está em outra chamada: a ordem (livres primeiro) não muda depois.
            // O roster só chega no join e nas consultas de nome: quem saiu depois ainda constaria como na chamada.
            const inCall: Promise<{ userIds: string[] }> = ids.length ? api.get('calls.inCall', { userIds: ids.join(',') }).catch(() => ({ userIds: [] })) : Promise.resolve({ userIds: [] });
            const [busy] = await Promise.all([inCall, refreshRoster()]);
            if (!alive) return;
            setElsewhere(new Set(busy.userIds));
            setMembers(list);
          })
          .catch(() => alive && setMembers([]));
      },
      q ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [rid, q, meId]);

  const here = new Set([...Object.keys(peers), ...roster.filter((p) => p.state === 'joined' || p.state === 'joining').map((p) => p.user._id)]);
  const reason = (id: string) => (here.has(id) ? 'Já está na chamada' : elsewhere.has(id) ? 'Em outra chamada' : null);
  const full = picked.length >= CALL_LIMITS.ringPerAction;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : full ? p : [...p, id]));
  const send = async () => {
    if (!picked.length) return;
    setSending(true);
    await ringPeople(picked);
    setSending(false);
    onClose();
  };
  const label = picked.length >= 2 ? `Chamar ${callPeopleLabel(picked.length)}` : 'Chamar';
  // Quem pode ser chamado vem primeiro; quem já está nesta ou em outra chamada, no fim (a ordem da sala em cada parte).
  const rows = members ? [...members].sort((a, b) => Number(!!reason(a._id)) - Number(!!reason(b._id))) : null;

  return (
    <Modal
      title="Chamar pessoas"
      onClose={onClose}
      className="call-ring-picker"
      description="Selecione até 10 pessoas. Quem estiver com o chat aberto recebe a chamada."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!picked.length || sending} onClick={() => void send()}>
            {label}
          </button>
        </>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Buscar pessoas da sala" autoFocus />
      <div className="call-ring-list" role="group" aria-label="Pessoas da sala">
        {rows === null ? (
          <div className="call-ring-empty">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <p className="call-ring-empty">Ninguém encontrado nesta sala.</p>
        ) : (
          rows.map((m) => {
            const why = reason(m._id);
            const on = picked.includes(m._id);
            return (
              <label key={m._id} className={why ? 'call-ring-row disabled' : 'call-ring-row'}>
                <input type="checkbox" checked={on} disabled={!!why || (full && !on)} onChange={() => toggle(m._id)} />
                <Avatar username={m.username} size={32} />
                <span className="call-ring-who">
                  <strong className="ellipsis">{m.name || m.username}</strong>
                  <span className="ellipsis">{why ?? `@${m.username}`}</span>
                </span>
                {on && <Icon name="check" className="call-ring-check" />}
              </label>
            );
          })
        )}
      </div>
    </Modal>
  );
}
