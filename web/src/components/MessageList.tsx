import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Message, Subscription } from '@shared/index';
import { watchAcks } from '../lib/acks';
import { api } from '../lib/api';
import { formatDay } from '../lib/format';
import { useSetting, useStore } from '../lib/store';
import { AckBar } from './AckBar';
import { MessageItem, type MessageActions } from './MessageItem';
import { Spinner } from './ui';

const EMPTY: Message[] = [];

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
  const list = data?.list ?? EMPTY;
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unreadSince] = useState(() => (sub && sub.unread > 0 ? sub.ls : null));
  const [params, setParams] = useSearchParams();
  const jumpTo = params.get('msg');
  const groupingPeriod = useSetting<number>('Message_GroupingPeriod') ?? 300;
  const prevHeight = useRef(0);
  // Avisos antigos podem pedir "Ciente" mesmo depois que a opção foi desligada no canal.
  const hasAck = list.some((m) => m.ackRequired);
  const member = !!sub;

  useEffect(() => {
    if (member && (notice?.ack || hasAck)) return watchAcks(rid);
  }, [rid, member, notice?.ack, hasAck]);

  const load = useCallback(async () => {
    const r = await api.get('rooms.history', { roomId: rid, count: 50 });
    useStore.getState().setMessages(rid, r.messages.slice().reverse(), r.messages.length === 50);
  }, [rid]);

  useEffect(() => {
    if (jumpTo) {
      void api.get('chat.getMessagesAround', { msgId: jumpTo, count: 30 }).then((r) => {
        const msgs: Message[] = r.messages.slice().reverse();
        useStore.getState().setMessages(rid, msgs, true);
        requestAnimationFrame(() => {
          const el = document.getElementById(`msg-${jumpTo}`);
          el?.scrollIntoView({ block: 'center' });
          el?.classList.add('highlight');
          setTimeout(() => el?.classList.remove('highlight'), 2500);
          atBottom.current = false;
        });
      });
    } else if (!data?.loaded) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, jumpTo]);

  // Mantém o scroll no fim quando chegam mensagens novas.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevHeight.current && loadingOlder === false && el.scrollTop < 50 && prevHeight.current < el.scrollHeight && !atBottom.current) {
      // carregou antigas: preserva a posição
    }
    if (atBottom.current && !jumpTo) el.scrollTop = el.scrollHeight;
  }, [list, jumpTo, loadingOlder]);

  const loadOlder = async () => {
    if (loadingOlder || !data?.hasMore || !list.length) return;
    setLoadingOlder(true);
    const el = ref.current!;
    const before = el.scrollHeight;
    try {
      const r = await api.get('rooms.history', { roomId: rid, latest: list[0].ts, count: 50 });
      useStore.getState().prependMessages(rid, r.messages.slice().reverse(), r.messages.length === 50);
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - before;
      });
    } finally {
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

  const onScroll = () => {
    const el = ref.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 120) void loadOlder();
    if (atBottom.current && jumpTo) {
      params.delete('msg');
      setParams(params, { replace: true });
      void load();
    }
  };

  if (!data?.loaded) return <div className="messages center"><Spinner /></div>;

  let lastDay = '';
  let unreadShown = false;
  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      {!data.hasMore && <div className="room-start">Este é o começo da conversa.</div>}
      {loadingOlder && <Spinner />}
      {list.map((m, i) => {
        const day = new Date(m.ts).toDateString();
        const prev = list[i - 1];
        const showDay = day !== lastDay;
        lastDay = day;
        const showUnread = !unreadShown && unreadSince && m.ts > unreadSince && m.u._id !== useStore.getState().me?._id;
        if (showUnread) unreadShown = true;
        const grouped =
          !showDay &&
          !showUnread &&
          !!prev &&
          !prev.t &&
          !m.t &&
          prev.u._id === m.u._id &&
          prev.alias === m.alias &&
          new Date(m.ts).getTime() - new Date(prev.ts).getTime() < groupingPeriod * 1000 &&
          !(prev.tcount ?? 0) &&
          !prev.ackRequired &&
          !m.ackRequired &&
          !m.tmid;
        return (
          <Fragment key={m._id}>
            {showDay && (
              <div className="day-sep">
                <span>{formatDay(m.ts)}</span>
              </div>
            )}
            {showUnread && (
              <div className="unread-sep">
                <span>Mensagens não lidas</span>
              </div>
            )}
            <MessageItem m={m} grouped={grouped} actions={actions} canModerate={canModerate} />
            {m.ackRequired && !m.t && <AckBar m={m} rid={rid} canPost={!!notice?.canPost} member={member} />}
          </Fragment>
        );
      })}
    </div>
  );
}
