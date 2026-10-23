import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, Room } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { plural, roomDisplayName } from '../lib/format';
import { useStore } from '../lib/store';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { MessageItem } from './MessageItem';
import { PanelHead, refocusRoom, usePanelEscape } from './RoomPanels';
import { SkeletonMessages } from './ui';

export function ThreadPanel({
  rid,
  tmid,
  room,
  canModerate,
  onClose,
  onUserClick,
  isMember,
  disabledReason,
}: {
  rid: string;
  tmid: string;
  room: Room;
  canModerate: boolean;
  onClose: () => void;
  onUserClick: (u: string) => void;
  isMember: boolean;
  disabledReason?: string;
}) {
  const me = useStore((s) => s.me)!;
  const sub = useStore((s) => s.subscriptions[rid]);
  const replies = useStore((s) => s.threads[tmid]);
  const rootFromList = useStore((s) => s.messages[rid]?.list.find((m) => m._id === tmid));
  const [root, setRoot] = useState<Message | null>(rootFromList ?? null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const following = root?.replies?.includes(me._id);
  const esc = usePanelEscape(onClose);

  useEffect(() => {
    if (rootFromList) setRoot(rootFromList);
  }, [rootFromList]);

  useEffect(() => {
    void (async () => {
      try {
        if (!rootFromList) setRoot((await api.get('chat.getMessage', { msgId: tmid })).message);
        const r = await api.get('chat.getThreadMessages', { tmid, count: 500 });
        useStore.getState().setThread(tmid, r.messages);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmid]);

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [replies?.length]);

  const actions = { onEdit: setEditing, onQuote: setQuoting, onUserClick };
  const name = roomDisplayName(sub, room);
  const where = room.t === 'd' ? name : `#${name}`;
  const count = root?.tcount ?? replies?.length ?? 0;

  return (
    <aside className="panel thread-panel" aria-label="Tópico" {...esc}>
      <PanelHead
        title="Tópico"
        sub={
          <>
            em{' '}
            <button type="button" className="link" onClick={() => (refocusRoom(), onClose())}>
              {where}
            </button>
            {following && ' · você segue'}
          </>
        }
        actions={
          root && (
            <button
              type="button"
              className="icon-btn"
              title={following ? 'Deixar de seguir' : 'Seguir'}
              aria-label={following ? 'Deixar de seguir' : 'Seguir'}
              onClick={() => api.post(following ? 'chat.unfollowMessage' : 'chat.followMessage', { mid: tmid }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'))}
            >
              <Icon name={following ? 'unfollow' : 'follow'} size={18} />
            </button>
          )
        }
        onClose={onClose}
      />
      <div className="panel-body messages" ref={ref}>
        {error && <div className="form-error">{error}</div>}
        {root ? (
          <div className="thread-root">
            <MessageItem m={root} grouped={false} actions={actions} inThread canModerate={canModerate} />
          </div>
        ) : (
          !error && <SkeletonMessages n={1} />
        )}
        <div className="day-sep thread-sep">
          <span>{plural(count, 'resposta', 'respostas')}</span>
        </div>
        {!replies && root && count > 0 && <SkeletonMessages n={3} />}
        {replies?.map((m, i) => (
          <MessageItem
            key={m._id}
            m={m}
            grouped={i > 0 && replies[i - 1].u._id === m.u._id && new Date(m.ts).getTime() - new Date(replies[i - 1].ts).getTime() < 300000}
            actions={actions}
            inThread
            canModerate={canModerate}
          />
        ))}
      </div>
      {isMember && (
        <Composer
          rid={rid}
          tmid={tmid}
          disabled={!!disabledReason}
          disabledReason={disabledReason}
          placeholder="Responder no tópico"
          editing={editing}
          setEditing={setEditing}
          quoting={quoting}
          setQuoting={setQuoting}
        />
      )}
    </aside>
  );
}
