import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Message, Room } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { plural, roomDisplayName } from '../lib/format';
import { continuesGroup, lastOwnEditable } from '../lib/messageRules';
import { contentOf } from '../lib/e2e/client';
import { useSetting, useStore } from '../lib/store';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { MessageGateContext, MessageItem } from './MessageItem';
import { PanelHead, refocusRoom, usePanelEscape } from './RoomPanels';
import { SkeletonMessages } from './ui';
// Integrações (Jira)
import { placeEphemeral, useRoomEphemeral } from '../lib/ephemeral';
import { EphemeralRow } from './integrations/EphemeralRow';

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
  // Integrações (Jira): respostas que só a pessoa vê dentro deste tópico, entre as respostas pela hora
  const ephemeral = useRoomEphemeral(rid, tmid);
  const ephSlots = useMemo(() => placeEphemeral(ephemeral, replies ?? []), [ephemeral, replies]);
  // Respostas seguidas da mesma pessoa se agrupam como na conversa (continuesGroup, com o mesmo intervalo).
  const groupingPeriod = useSetting<number>('Message_GroupingPeriod') ?? 300;
  // Link para uma resposta (Copiar link, Fixadas, Favoritas, busca): /thread/<tmid>?msg=<id> a destaca.
  const [params] = useSearchParams();
  const target = params.get('msg');
  const shown = useRef<string | null>(null);
  const counts = useRef('');
  const [flash, setFlash] = useState<string | null>(null);

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
    const el = ref.current;
    if (!el) return;
    const key = `${replies?.length}:${ephemeral.length}`;
    const grew = key !== counts.current;
    counts.current = key;
    // A resposta do link, uma vez, no meio do painel e destacada; depois, as novas respostas levam ao fim como sempre.
    if (target && replies && shown.current !== target) {
      shown.current = target;
      const row = el.querySelector<HTMLElement>(`#msg-${CSS.escape(target)}`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        setFlash(target);
        setTimeout(() => setFlash((f) => (f === target ? null : f)), 2500);
        return;
      }
    }
    if (grew) el.scrollTop = el.scrollHeight;
    // Integrações (Jira): também quando chega uma resposta efêmera
  }, [replies?.length, ephemeral.length, target]);

  const actions = { onEdit: setEditing, onQuote: setQuoting, onUserClick };
  // Seta para cima no compositor do tópico: a última resposta da pessoa, como na sala (RoomPage.editLast).
  const gate = useContext(MessageGateContext);
  const editLast = () => {
    const mine = lastOwnEditable(replies ?? [], me._id, !!useStore.getState().settings.Message_AllowEditing, gate.editLimit);
    // Mensagem cifrada: edita o texto decifrado (sem ele, nada a editar).
    if (mine && mine.e2e) {
      const c = contentOf(mine);
      if (c) setEditing({ ...mine, msg: c.msg });
    } else if (mine) setEditing(mine);
  };
  const name = roomDisplayName(sub, room);
  const where = room.t === 'd' ? name : `#${name}`;
  const count = root?.tcount ?? replies?.length ?? 0;

  return (
    <aside className="panel thread-panel" aria-label="Tópico" {...esc}>
      <PanelHead
        title="Tópico"
        sub={
          // Nome de sala longo corta com reticências dentro do link: "em" e "· você segue" ficam sempre à vista.
          <span className="sub-line">
            <span>em</span>
            <button type="button" className="link sub-room" title={where} onClick={() => (refocusRoom(), onClose())}>
              {where}
            </button>
            {following && <span>· você segue</span>}
          </span>
        }
        actions={
          root && (
            <button
              type="button"
              className={following ? 'icon-btn follow-on' : 'icon-btn'}
              title={following ? 'Deixar de seguir' : 'Seguir'}
              aria-label={following ? 'Deixar de seguir' : 'Seguir'}
              onClick={() => api.post(following ? 'chat.unfollowMessage' : 'chat.followMessage', { mid: tmid }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'))}
            >
              {/* Sino cheio enquanto segue: o sino cortado parecia dizer que as notificações estavam desligadas. */}
              <Icon name="follow" size={18} fill={following} />
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
        {/* Integrações (Jira): efêmeras antes da primeira resposta mais nova (que começa outro grupo) ou no fim, todas
            irmãs com chave das respostas (a efêmera não é montada de novo quando sobe) */}
        {(replies ?? [])
          .flatMap((m, i) => [
            ...(ephSlots.before.get(m._id) ?? []).map((e) => <EphemeralRow key={`eph-${e._id}`} m={e} />),
            <MessageItem
              key={m._id}
              m={m}
              grouped={!ephSlots.before.has(m._id) && i > 0 && continuesGroup(replies![i - 1], m, groupingPeriod * 1000)}
              actions={actions}
              inThread
              canModerate={canModerate}
              highlight={flash === m._id}
            />,
          ])
          .concat(ephSlots.end.map((e) => <EphemeralRow key={`eph-${e._id}`} m={e} />))}
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
          onEditLast={editLast}
        />
      )}
    </aside>
  );
}
