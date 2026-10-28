// Participantes: à direita na janela ampliada, folha no celular. Mãos levantadas (a mais antiga primeiro), quem
// está na chamada e quem está sendo chamado; cada linha tem o menu da pessoa.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { callUserLabel } from '@shared/calls';
import type { CallParticipant } from '@shared/index';
import { inviteRoom, inviteWaitMinutes, setView, useCallStore, type LivePeer } from '../../lib/call/store';
import { Icon } from '../Icon';
import { Sheet } from '../overlay';
import { Avatar, SearchInput } from '../ui';
import { RingPicker } from './RingPicker';
import { PeopleMenu } from './Tile';

const ROW_H = 52;

const RING_TEXT: Record<string, string> = { ringing: 'Chamando…', missed: 'Não atendeu', declined: 'Recusou', busy: 'Em outra chamada' };

function ringStatus(p: CallParticipant): string | null {
  if (p.state === 'ringing' || p.state === 'missed' || p.state === 'declined') return RING_TEXT[p.state];
  if (p.state === 'left' && p.leftReason === 'busy') return RING_TEXT.busy;
  return null;
}

const match = (q: string, u: { username: string; name?: string | null } | null) => !q || (!!u && (`${u.name ?? ''} ${u.username}`.toLocaleLowerCase('pt-BR').includes(q)));

// Setas sobem e descem entre as linhas (cada linha é um item da lista).
function onListKey(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.call-people-row')];
  const i = rows.findIndex((r) => r.contains(document.activeElement));
  if (i < 0) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

function PeerRow({ peer, host }: { peer: LivePeer; host: boolean }) {
  const name = peer.user ? callUserLabel(peer.user) : 'Alguém';
  return (
    <div className="call-people-row" role="listitem" tabIndex={-1} aria-label={name}>
      <Avatar username={peer.user?.username} size={32} />
      <span className="call-people-who">
        <strong className="ellipsis">{name}</strong>
        <span className="call-people-badges">
          {host && <span className="pill accent">Anfitrião</span>}
          {peer.isMe && <span className="pill">Você</span>}
        </span>
      </span>
      <span className="call-people-state">
        {peer.handAt && <Icon name="call-hand" label="Mão levantada" className="call-hand-up" />}
        {!peer.mic && <Icon name="mic-off" label="Microfone desligado" className="call-muted" />}
      </span>
      <PeopleMenu peer={peer} className="icon-btn call-people-menu" />
    </div>
  );
}

function RingRow({ p, status }: { p: CallParticipant; status: string }) {
  return (
    <div className="call-people-row" role="listitem" tabIndex={-1} aria-label={callUserLabel(p.user)}>
      <Avatar username={p.user.username} size={32} />
      <span className="call-people-who">
        <strong className="ellipsis">{callUserLabel(p.user)}</strong>
        <span className="call-people-sub">{status}</span>
      </span>
    </div>
  );
}

// Acima de 100 linhas só as visíveis vão para o DOM (linhas de altura fixa).
function Rows({ items, render }: { items: LivePeer[]; render: (p: LivePeer) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ from: 0, to: 60 });
  const big = items.length > 100;
  useLayoutEffect(() => {
    if (!big) return;
    const scroller = ref.current?.closest<HTMLElement>('.call-people-scroll');
    if (!scroller) return;
    const update = () => {
      const top = scroller.scrollTop - (ref.current?.offsetTop ?? 0);
      const from = Math.max(0, Math.floor(top / ROW_H) - 10);
      setWin((w) => {
        const next = { from, to: from + Math.ceil(scroller.clientHeight / ROW_H) + 20 };
        return w.from === next.from && w.to === next.to ? w : next;
      });
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [big]);
  if (!big) return <>{items.map(render)}</>;
  return (
    <div ref={ref} style={{ position: 'relative', height: items.length * ROW_H }}>
      <div style={{ position: 'absolute', top: win.from * ROW_H, left: 0, right: 0 }}>{items.slice(win.from, win.to).map(render)}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="call-people-section">
      <h3 className="call-people-title">{title}</h3>
      <div role="list" onKeyDown={onListKey}>
        {children}
      </div>
    </section>
  );
}

function PanelBody({ onClose }: { onClose: () => void }) {
  const peers = useCallStore((s) => s.peers);
  const roster = useCallStore((s) => s.roster);
  const mine = useCallStore((s) => s.call?.mine);
  const room = useCallStore((s) => s.room);
  const [q, setQ] = useState('');
  const [ring, setRing] = useState(false);
  const query = q.trim().toLocaleLowerCase('pt-BR');
  const hosts = new Set(roster.filter((p) => p.host).map((p) => p.user._id));
  const all = Object.values(peers).sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.joinedAt - b.joinedAt);
  const shown = all.filter((p) => match(query, p.user));
  const hands = shown.filter((p) => p.handAt).sort((a, b) => (a.handAt ?? 0) - (b.handAt ?? 0));
  const rest = shown.filter((p) => !p.handAt);
  const ringing = roster
    .filter((p) => !peers[p.user._id] && match(query, p.user))
    .map((p) => ({ p, status: ringStatus(p) }))
    .filter((x): x is { p: CallParticipant; status: string } => !!x.status);
  const wait = inviteWaitMinutes();
  const row = (p: LivePeer) => <PeerRow key={p.id} peer={p} host={hosts.has(p.id)} />;
  return (
    <>
      <div className="call-people-head">
        <h2>Participantes ({all.length})</h2>
        <button type="button" className="icon-btn" title="Fechar" aria-label="Fechar" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="call-people-search">
        <SearchInput value={q} onChange={setQ} placeholder="Buscar na chamada" />
      </div>
      <div className="call-people-scroll">
        {hands.length > 0 && <Section title={`Mãos levantadas (${hands.length})`}>{hands.map(row)}</Section>}
        <Section title={`Na chamada (${rest.length})`}>
          <Rows items={rest} render={row} />
        </Section>
        {ringing.length > 0 && (
          <Section title={`Chamando (${ringing.length})`}>
            {ringing.map(({ p, status }) => (
              <RingRow key={p.user._id} p={p} status={status} />
            ))}
          </Section>
        )}
      </div>
      {(mine?.canRing || (mine?.canInvite && room?.t !== 'd')) && (
        <div className="call-people-foot">
          {mine?.canRing && (
            <button type="button" className="btn" onClick={() => setRing(true)}>
              <Icon name="call-ring" />
              Chamar pessoas
            </button>
          )}
          {room?.t !== 'd' && (mine?.canInvite || wait > 0) && (
            <button type="button" className="btn" disabled={!mine?.canInvite} title={!mine?.canInvite ? `Você poderá avisar de novo em ${wait} min.` : undefined} onClick={() => void inviteRoom()}>
              <Icon name="announcement" />
              Avisar a sala
            </button>
          )}
        </div>
      )}
      {ring && <RingPicker onClose={() => setRing(false)} />}
    </>
  );
}

export function PeoplePanel({ phone }: { phone: boolean }) {
  const close = () => setView({ panel: null });
  if (phone)
    return (
      <Sheet onClose={close} className="call-people" label="Participantes">
        <PanelBody onClose={close} />
      </Sheet>
    );
  return (
    <aside className="call-people" aria-label="Participantes">
      <PanelBody onClose={close} />
    </aside>
  );
}
