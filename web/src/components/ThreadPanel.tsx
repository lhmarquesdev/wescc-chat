import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message, Room } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { useStore } from '../lib/store';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { Spinner } from './ui';

export function ThreadPanel({
  rid,
  tmid,
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
  const replies = useStore((s) => s.threads[tmid]);
  const rootFromList = useStore((s) => s.messages[rid]?.list.find((m) => m._id === tmid));
  const [root, setRoot] = useState<Message | null>(rootFromList ?? null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const following = root?.replies?.includes(me._id);

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

  return (
    <aside className="panel thread-panel">
      <div className="panel-head">
        <h3>Thread</h3>
        {root && (
          <button className="btn small" onClick={() => api.post(following ? 'chat.unfollowMessage' : 'chat.followMessage', { mid: tmid })}>
            {following ? '🔕 Deixar de seguir' : '🔔 Seguir'}
          </button>
        )}
        <button className="icon-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body messages" ref={ref}>
        {error && <div className="form-error">{error}</div>}
        {root ? <MessageItem m={root} grouped={false} actions={actions} inThread canModerate={canModerate} /> : <Spinner />}
        <div className="day-sep">
          <span>{root?.tcount ?? 0} respostas</span>
        </div>
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
          placeholder="Responder na thread"
          editing={editing}
          setEditing={setEditing}
          quoting={quoting}
          setQuoting={setQuoting}
        />
      )}
    </aside>
  );
}
