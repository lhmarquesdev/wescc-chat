import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Message, Subscription } from '@shared/index';
import { watchAcks } from '../lib/acks';
import { api } from '../lib/api';
import { formatDateTime, formatDay, formatTime, nameList, plural, roomDisplayName, roomIconName } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { rememberName, useNames } from '../lib/names';
import { useSetting, useStore } from '../lib/store';
import { AckBar } from './AckBar';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { MessageItem, type MessageActions } from './MessageItem';
import { Avatar, Empty, GroupAvatar, SkeletonMessages } from './ui';

const EMPTY: Message[] = [];
// Entradas, saídas e quem foi adicionado ou removido: em sequência, viram uma linha só (clicável).
const MEMBERSHIP = new Set(['uj', 'ul', 'au', 'ru']);
const JOIN_GAP = 10 * 60 * 1000;

type Row = { kind: 'msg'; m: Message; i: number; grouped: boolean; unread?: boolean } | { kind: 'joins'; ms: Message[]; unread?: boolean };
// Cada dia num bloco próprio: a pílula do dia fica presa só enquanto o dia dela rola, e o dia seguinte a empurra.
type Day = { key: string; ts: string; rows: Row[] };

const time = (m: Message) => new Date(m.ts).getTime();
const actor = (m: Message) => m.u.name || m.u.username;
const uniq = (xs: string[]) => [...new Set(xs)];

// "Alice Souza, Bruno Lima e mais 3 entraram na sala", "Administrador adicionou Renata Alves, Diego Martins e mais 8";
// com mais de um tipo, as partes separadas por ponto e vírgula.
function joinsText(ms: Message[], nameOf: (username: string) => string) {
  const parts: string[] = [];
  const joined = uniq(ms.filter((x) => x.t === 'uj').map(actor));
  if (joined.length) parts.push(`${nameList(joined)} ${joined.length === 1 ? 'entrou' : 'entraram'} na sala`);
  for (const [t, verb] of [
    ['au', 'adicionou'],
    ['ru', 'removeu'],
  ] as const) {
    const by = new Map<string, string[]>();
    for (const x of ms) if (x.t === t) by.set(actor(x), [...(by.get(actor(x)) ?? []), nameOf(x.msg)]);
    for (const [who, list] of by) parts.push(`${who} ${verb} ${nameList(uniq(list))}`);
  }
  const left = uniq(ms.filter((x) => x.t === 'ul').map(actor));
  if (left.length) parts.push(`${nameList(left)} ${left.length === 1 ? 'saiu' : 'saíram'} da sala`);
  return parts.join('; ');
}

function joinsIcon(ms: Message[]): IconName {
  const kinds = new Set(ms.map((x) => x.t));
  if (kinds.size === 1 && kinds.has('ul')) return 'sys-leave';
  if (kinds.size === 1 && kinds.has('au')) return 'sys-added';
  if ([...kinds].every((k) => k === 'ul' || k === 'ru')) return 'sys-removed';
  return 'sys-join';
}

// Topo do histórico: ícone (ou avatar da DM), "Este é o começo de #geral" e o tópico. O # só nos canais públicos;
// na DM em grupo, os participantes.
function RoomStart({ rid, sub }: { rid: string; sub?: Subscription }) {
  const room = useStore((s) => s.rooms[rid]);
  if (!room) return <div className="room-start">Este é o começo da conversa.</div>;
  const name = roomDisplayName(sub, room);
  const group = room.t === 'd' && (room.uids?.length ?? 0) > 2;
  const dm = room.t === 'd' && sub && !group && !sub.name.includes(',') ? sub.name : null;
  const title =
    room.t === 'd'
      ? dm
        ? `Este é o começo da conversa com ${name}`
        : `Este é o começo da conversa com ${nameList(name.split(/,\s*/), 3)}`
      : room.t === 'l'
        ? 'Este é o começo do atendimento.'
        : `Este é o começo de ${room.t === 'c' && !room.prid ? '#' : ''}${name}`;
  return (
    <div className="room-start">
      {dm ? (
        <Avatar username={dm} size={48} />
      ) : group ? (
        <GroupAvatar usernames={room.usernames ?? []} size={48} />
      ) : (
        <span className="room-start-icon" aria-hidden="true">
          <Icon name={roomIconName(room)} size={24} />
        </span>
      )}
      <div className="room-start-title">{title}</div>
      {room.topic && !dm && !group && <div className="room-start-topic">{renderMarkdown(room.topic)}</div>}
    </div>
  );
}

export function MessageList({
  rid,
  sub,
  actions,
  canModerate,
  notice,
}: {
  rid: string;
  sub?: Subscription;
  actions: MessageActions;
  canModerate: boolean;
  // Canal de avisos: "Ciente" ligado e se quem vê publica aqui.
  notice?: { ack: boolean; canPost: boolean };
}) {
  const data = useStore((s) => s.messages[rid]);
  const meId = useStore((s) => s.me?._id);
  const list = data?.list ?? EMPTY;
  const nameOf = useNames();
  // Autores das mensagens carregadas: o nome deles já vem junto, sem users.info.
  for (const m of list) rememberName(m.u.username, m.u.name);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Perto do fim (80px): mensagens novas e imagens que carregam mantêm a lista no fim.
  const atBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  // Distância até o fim antes de entrar mensagem antiga no topo: a posição de leitura fica onde estava.
  const prepend = useRef<number | null>(null);
  const [far, setFar] = useState(false);
  // Rolagem feita pelo próprio código (fixar no fim, manter a posição): não mostra a pílula do dia presa.
  const autoTop = useRef<number | null>(null);
  const stuck = useRef<HTMLElement | null>(null);
  const idle = useRef(0);
  const [fresh, setFresh] = useState(0);
  const freshRef = useRef(0);
  const lastId = useRef<string | null>(null);
  // Mensagens que já estavam na lista; as que chegarem depois, no fim, entram com animação.
  const seen = useRef<Set<string> | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [unreadSince] = useState(() => (sub && sub.unread > 0 ? sub.ls : null));
  const [params, setParams] = useSearchParams();
  const jumpTo = params.get('msg');
  const jumpRef = useRef(jumpTo);
  jumpRef.current = jumpTo;
  const groupingPeriod = useSetting<number>('Message_GroupingPeriod') ?? 300;
  // Avisos antigos podem pedir "Ciente" mesmo depois que a opção foi desligada no canal.
  const hasAck = list.some((m) => m.ackRequired);
  const member = !!sub;

  useEffect(() => {
    if (member && (notice?.ack || hasAck)) return watchAcks(rid);
  }, [rid, member, notice?.ack, hasAck]);

  const setFreshCount = (n: number) => {
    if (freshRef.current === n) return;
    freshRef.current = n;
    setFresh(n);
  };

  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await api.get('rooms.history', { roomId: rid, count: 50 });
      seen.current = null;
      useStore.getState().setMessages(rid, r.messages.slice().reverse(), r.messages.length === 50);
    } catch {
      setFailed(true);
    }
  }, [rid]);

  useEffect(() => {
    atBottom.current = !jumpTo;
    if (jumpTo) {
      void api.get('chat.getMessagesAround', { msgId: jumpTo, count: 30 }).then((r) => {
        const msgs: Message[] = r.messages.slice().reverse();
        seen.current = null;
        useStore.getState().setMessages(rid, msgs, true);
        requestAnimationFrame(() => {
          document.getElementById(`msg-${jumpTo}`)?.scrollIntoView({ block: 'center' });
          atBottom.current = false;
          setFlash(jumpTo);
          setTimeout(() => setFlash((f) => (f === jumpTo ? null : f)), 2500);
        });
      });
    } else if (!data?.loaded) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, jumpTo]);

  // Depois de cada mudança da lista: preserva a posição (antigas no topo) ou fixa no fim, e conta as novas.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const last = list[list.length - 1];
    const appended = !!last && !!lastId.current && last._id !== lastId.current && list.some((x) => x._id === lastId.current);
    if (appended && last.u._id === meId && !jumpRef.current) atBottom.current = true; // quem envia vai para o fim
    if (prepend.current !== null) {
      el.scrollTop = el.scrollHeight - prepend.current;
      prepend.current = null;
      autoTop.current = el.scrollTop;
    } else if (atBottom.current && !jumpRef.current) {
      el.scrollTop = el.scrollHeight;
      autoTop.current = el.scrollTop;
    }
    measure();
    if (appended && !atBottom.current) {
      const idx = list.findIndex((x) => x._id === lastId.current);
      const n = list.slice(idx + 1).filter((x) => x.u._id !== meId && !x.t).length;
      if (n) setFreshCount(freshRef.current + n);
    }
    lastId.current = last?._id ?? null;
    if (data?.loaded) {
      if (!seen.current) seen.current = new Set(list.map((x) => x._id));
      else for (const x of list) seen.current.add(x._id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, data?.loaded]);

  // Imagens que carregam, o compositor que cresce e a faixa de digitação mudam a altura: no fim, continua no fim.
  useEffect(() => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && !jumpRef.current && prepend.current === null) {
        el.scrollTop = el.scrollHeight;
        autoTop.current = el.scrollTop;
      }
      measure();
    });
    ro.observe(c);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data?.loaded]);

  const loadOlder = async () => {
    if (loadingRef.current || !data?.hasMore || !list.length) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await api.get('rooms.history', { roomId: rid, latest: list[0].ts, count: 50 });
      const el = scroller.current;
      if (el) prepend.current = el.scrollHeight - el.scrollTop;
      useStore.getState().prependMessages(rid, r.messages.slice().reverse(), r.messages.length === 50);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  };

  // Marca como lida quando a janela está em foco e o fim da lista está visível.
  useEffect(() => {
    const mark = () => {
      const s = useStore.getState().subscriptions[rid];
      if (!s || !document.hasFocus() || !atBottom.current) return;
      if (s.unread > 0 || s.alert || s.userMentions > 0) void api.post('subscriptions.read', { rid }).catch(() => {});
    };
    mark();
    const t = setInterval(mark, 1500);
    window.addEventListener('focus', mark);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', mark);
    };
  }, [rid]);

  const leaveJump = () => {
    params.delete('msg');
    setParams(params, { replace: true });
    atBottom.current = true;
    void load();
  };

  useEffect(() => () => clearTimeout(idle.current), []);

  // Pílula do dia presa no topo: aparece enquanto a pessoa rola e some 1 s depois, para não cobrir a primeira linha.
  // A que está no fluxo (no começo do dia) fica sempre visível.
  function markStuck(user: boolean) {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    let sep: HTMLElement | null = null;
    for (const d of el.querySelectorAll<HTMLElement>('.messages-list > .day')) {
      const r = d.getBoundingClientRect();
      if (r.bottom <= top) continue;
      // Presa quando o começo do dia já passou do topo (margem de 12px da pílula menos o top de 8px).
      if (r.top < top - 4) sep = d.querySelector<HTMLElement>(':scope > .day-sep');
      break;
    }
    if (stuck.current !== sep) {
      stuck.current?.removeAttribute('data-stuck');
      stuck.current = sep;
      if (sep) sep.dataset.stuck = 'hidden';
    }
    if (!sep || !user) return;
    sep.dataset.stuck = 'scroll';
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      if (stuck.current === sep) sep.dataset.stuck = 'rest';
    }, 1000);
  }

  // Longe do fim (400px): a pílula "ir para o fim" aparece. Medido também quando a lista cresce sem rolagem.
  function measure() {
    const el = scroller.current;
    if (!el) return;
    setFar(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
    markStuck(false);
  }

  const onScroll = () => {
    const el = scroller.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = dist < 80;
    setFar(dist > 400);
    const user = autoTop.current === null || Math.abs(el.scrollTop - autoTop.current) > 1;
    autoTop.current = null;
    markStuck(user);
    if (atBottom.current) setFreshCount(0);
    if (el.scrollTop < 120) void loadOlder();
    if (atBottom.current && jumpTo) leaveJump();
  };

  // Setas entre mensagens a partir do nome (ou da hora, nas agrupadas): dá para chegar à barra de ações de qualquer
  // linha pelo teclado, sem uma parada de Tab a mais em cada mensagem agrupada.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (!t.matches('.msg-name, .msg-time-hover')) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('.msg-name, .msg-time-hover')];
    const next = all[all.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus({ preventScroll: true });
    next.closest('.msg')?.scrollIntoView({ block: 'nearest' });
  };

  const toLatest = () => {
    if (jumpTo) return leaveJump();
    const el = scroller.current;
    if (!el) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
    setFreshCount(0);
  };

  const days = useMemo(() => {
    const out: Day[] = [];
    let unreadShown = false;
    const isFirstUnread = (m: Message) => !unreadShown && !!unreadSince && m.ts > unreadSince && m.u._id !== meId;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const dayKey = new Date(m.ts).toDateString();
      const newDay = out[out.length - 1]?.key !== dayKey;
      if (newDay) out.push({ key: dayKey, ts: m.ts, rows: [] });
      const rows = out[out.length - 1].rows;
      const unread = isFirstUnread(m);
      if (unread) unreadShown = true;
      if (m.t && MEMBERSHIP.has(m.t)) {
        let j = i + 1;
        while (
          j < list.length &&
          list[j].t &&
          MEMBERSHIP.has(list[j].t!) &&
          new Date(list[j].ts).toDateString() === dayKey &&
          time(list[j]) - time(list[j - 1]) < JOIN_GAP &&
          !isFirstUnread(list[j])
        )
          j++;
        // Com um link para uma dessas entradas (?msg=), o grupo fica aberto: a linha de destino precisa existir.
        if (j - i >= 2 && !(jumpTo && list.slice(i, j).some((x) => x._id === jumpTo))) {
          rows.push({ kind: 'joins', ms: list.slice(i, j), unread });
          i = j - 1;
          continue;
        }
      }
      const prev = list[i - 1];
      const grouped =
        !newDay &&
        !unread &&
        !!prev &&
        !prev.t &&
        !m.t &&
        prev.u._id === m.u._id &&
        prev.alias === m.alias &&
        time(m) - time(prev) < groupingPeriod * 1000 &&
        !(prev.tcount ?? 0) &&
        !prev.ackRequired &&
        !m.ackRequired &&
        !m.tmid;
      rows.push({ kind: 'msg', m, i, grouped, unread });
    }
    return out;
  }, [list, unreadSince, meId, groupingPeriod, jumpTo]);

  // Índice da última mensagem que já estava na lista: o que vier depois dela chegou agora.
  let lastSeen = -1;
  if (seen.current) for (let i = 0; i < list.length; i++) if (seen.current.has(list[i]._id)) lastSeen = i;
  const arriving = (m: Message, i: number) => !!seen.current && i > lastSeen && (atBottom.current || m.u._id === meId);

  const renderRow = (r: Row) => {
    const first = r.kind === 'msg' ? r.m : r.ms[0];
    const sep = r.unread && (
      <div className="unread-sep" role="separator">
        <span>Novas mensagens</span>
      </div>
    );
    if (r.kind === 'joins') {
      const open = expanded.has(first._id);
      const last = r.ms[r.ms.length - 1];
      const text = joinsText(r.ms, nameOf);
      return (
        <Fragment key={first._id}>
          {sep}
          {/* Linha inteira é o botão; a seta fica depois do horário para não partir a frase. O id não é o da primeira
              entrada: aberta, ela aparece logo abaixo com o próprio msg-<id>. */}
          <div className="msg system joins" id={`joins-${first._id}`}>
            <div className="msg-left">
              <Icon name={joinsIcon(r.ms)} size={14} />
            </div>
            <div className="msg-main">
              <button
                type="button"
                className="joins-toggle"
                aria-expanded={open}
                title={text}
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (open) n.delete(first._id);
                    else n.add(first._id);
                    return n;
                  })
                }
              >
                <span className="sys-text">{text}</span>
                <span className="sys-time">
                  {' · '}
                  <time className="msg-time" dateTime={last.ts} title={formatDateTime(last.ts)}>
                    {formatTime(last.ts)}
                  </time>
                </span>
                <Icon name="chevron-down" size={14} className={open ? 'open' : undefined} />
              </button>
            </div>
          </div>
          {open && r.ms.map((m) => <MessageItem key={m._id} m={m} grouped={false} actions={actions} canModerate={canModerate} />)}
        </Fragment>
      );
    }
    const m = r.m;
    const ack = m.ackRequired && !m.t;
    return (
      <Fragment key={m._id}>
        {sep}
        <MessageItem
          m={m}
          grouped={r.grouped}
          actions={actions}
          canModerate={canModerate}
          arrive={arriving(m, r.i)}
          highlight={flash === m._id}
          footer={ack ? <AckBar m={m} rid={rid} canPost={!!notice?.canPost} member={member} /> : undefined}
        />
      </Fragment>
    );
  };

  if (!data?.loaded)
    return (
      <div className="messages stream loading">
        {failed ? (
          <Empty
            icon="error"
            tone="danger"
            title="Não foi possível carregar as mensagens"
            action={
              <button type="button" className="btn" onClick={() => void load()}>
                Tentar de novo
              </button>
            }
          >
            Confira a conexão e tente de novo.
          </Empty>
        ) : (
          <SkeletonMessages n={8} />
        )}
      </div>
    );

  return (
    <div className="messages stream" ref={scroller} onScroll={onScroll} onKeyDown={onKeyDown}>
      <div className="messages-list" ref={content}>
        {!data.hasMore && <RoomStart rid={rid} sub={sub} />}
        {loadingOlder && <SkeletonMessages n={3} />}
        {days.map((d) => (
          <div key={d.key} className="day">
            <div className="day-sep">
              <span>{formatDay(d.ts)}</span>
            </div>
            {d.rows.map(renderRow)}
          </div>
        ))}
      </div>
      {(far || fresh > 0 || !!jumpTo) && (
        <div className="jump-wrap">
          <button type="button" className="jump-pill" onClick={toLatest}>
            <Icon name="jump-latest" size={16} />
            {fresh > 0 ? plural(fresh, 'nova mensagem', 'novas mensagens') : 'Ir para o fim'}
          </button>
        </div>
      )}
    </div>
  );
}
