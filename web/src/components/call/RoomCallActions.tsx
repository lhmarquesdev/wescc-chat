// Ações de chamada no cabeçalho da sala: iniciar (voz e vídeo, ou transmissão), entrar, ouvir ou voltar para a chamada.
// O que mostrar vem de headerView (call-view.ts); aqui só o desenho e os cliques.
import { useEffect, useId } from 'react';
import type { CallKind, Room, Subscription } from '@shared/index';
import { callPeopleLabel } from '@shared/calls';
import { CALL_HTTPS_REASON, headerView, type CallViewEnv, type HeaderView } from '@shared/call-view';
import { expandCall, isInCall, openCall, openJoin, useCallStore } from '../../lib/call/store';
import { prefetchSfu } from '../../lib/calls';
import { namesIn } from '../../lib/names';
import { explainCall as explain, recheckRoomCall, useCallEnv, useRoomCall } from '../../lib/roomcall';
import { Icon } from '../Icon';
import '../callroom.css';

type Props = { room: Room; sub: Subscription | null | undefined; compact?: boolean };

// A conversa a dois usa a chamada direta (P2P); nas outras salas o motor de grupo pode ir carregando antes.
const isPair = (room: Room | null | undefined) => room?.t === 'd' && (room.uids?.length ?? 0) === 2;

// A visão do cabeçalho, para a página da sala decidir o que cabe (pílula no lugar de Membros, botões no Mais).
export function useRoomCallHeader(rid: string | null, room?: Room | null): HeaderView {
  const s = useRoomCall(rid);
  const env = useCallEnv(s?.call?._id);
  return headerView(s, env, { pairDm: isPair(room) });
}

function startKinds(v: Extract<HeaderView, { kind: 'start' }>) {
  return v.transmission
    ? ([{ kind: 'audio', title: 'Iniciar transmissão', icon: 'call-broadcast' }] as const)
    : ([
        { kind: 'audio', title: 'Chamada de voz', icon: 'call-audio' },
        { kind: 'video', title: 'Chamada de vídeo', icon: 'call-video' },
      ] as const);
}

// Iniciar: barrado ou ainda sem resposta, confere com o servidor antes (o motivo pode ter passado) e só então liga ou
// explica. Sem HTTPS não há o que perguntar.
async function start(room: Room, v: Extract<HeaderView, { kind: 'start' }>, kind: CallKind, env: CallViewEnv) {
  if (v.reason === CALL_HTTPS_REASON) return explain(v.reason);
  if (v.reason || v.pending) {
    const now = headerView(await recheckRoomCall(room._id), env, { pairDm: isPair(room) });
    if (now.kind !== 'start') return;
    if (now.reason) return explain(now.reason);
  }
  void openCall(room._id, kind);
}

export function RoomCallActions({ room, sub: _sub, compact }: Props) {
  const rid = room._id;
  const s = useRoomCall(rid);
  const env = useCallEnv(s?.call?._id);
  const v = headerView(s, env, { pairDm: isPair(room) });
  const tabCall = useCallStore((st) => st.tabCall);
  const reasonId = useId();
  const warm = isPair(room) ? undefined : () => prefetchSfu();

  // #call (toque de chamada em grupo pelo push): entra direto quando a chamada está viva e a entrada é possível.
  useEffect(() => {
    if (!s || location.hash !== '#call') return;
    history.replaceState(history.state, '', location.pathname + location.search);
    const call = s.call;
    if (!call || call.status !== 'ongoing' || call.scope !== 'group') return;
    if (isInCall(call._id)) expandCall();
    else if (s.canJoin && window.isSecureContext) void openJoin(call._id, rid);
  }, [s, rid]);

  if (v.kind === 'hidden') return null;
  if (v.kind === 'start') {
    if (compact) return null;
    return (
      <>
        {startKinds(v).map((b) => (
          <button
            key={b.kind}
            type="button"
            className="icon-btn call-start"
            title={b.title}
            aria-label={b.title}
            aria-disabled={v.reason ? true : undefined}
            aria-describedby={v.reason ? reasonId : undefined}
            onPointerEnter={warm}
            onFocus={warm}
            onClick={() => void start(room, v, b.kind, env)}
          >
            <Icon name={b.icon} size={18} />
          </button>
        ))}
        {v.reason && (
          <span id={reasonId} className="visually-hidden">
            {namesIn(v.reason)}
          </span>
        )}
      </>
    );
  }
  const call = s?.call;
  const go = async () => {
    if (!call) return;
    if (v.action === 'join') {
      if (v.reason === CALL_HTTPS_REASON) return explain(v.reason);
      if (v.reason) {
        // Barrada: pergunta de novo (alguém pode ter saído da chamada cheia, o servidor pode ter voltado).
        const now = headerView(await recheckRoomCall(rid), env);
        if (now.kind !== 'pill' || now.action !== 'join') return;
        if (now.reason) return explain(now.reason);
      }
      return void openJoin(call._id, rid);
    }
    // Aberta noutra aba: aqui não há janela para trazer, só o aviso.
    if (!isInCall(call._id) && tabCall?.callId === call._id) return explain('Chamada em andamento em outra aba.');
    expandCall();
  };
  return (
    <>
      <button
        type="button"
        className={v.text === 'Na chamada' ? 'call-join-pill in' : 'call-join-pill'}
        title={v.title}
        aria-label={v.count > 0 ? `${v.title}, ${callPeopleLabel(v.count)}` : v.title}
        aria-disabled={v.reason ? true : undefined}
        aria-describedby={v.reason ? reasonId : undefined}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => void go()}
      >
        <Icon name={v.icon} size={16} />
        <span className="call-join-text">{v.text}</span>
        {v.count > 0 && <span className="call-join-count">{v.count.toLocaleString('pt-BR')}</span>}
      </button>
      {v.reason && (
        <span id={reasonId} className="visually-hidden">
          {namesIn(v.reason)}
        </span>
      )}
    </>
  );
}

// No cabeçalho estreito, iniciar vai para o menu Mais, com os mesmos nomes. Barrados, os itens apontam o motivo, que
// aparece também numa linha logo abaixo deles (no celular não há dica ao passar o mouse). Uma linha separa do resto.
export function RoomCallMenuItems({ room, sub: _sub, onDone }: Props & { onDone?: () => void }) {
  const s = useRoomCall(room._id);
  const env = useCallEnv(s?.call?._id);
  const v = headerView(s, env, { pairDm: isPair(room) });
  const reasonId = useId();
  if (v.kind !== 'start') return null;
  const warm = isPair(room) ? undefined : () => prefetchSfu();
  return (
    <>
      {startKinds(v).map((b) => (
        <button
          key={b.kind}
          type="button"
          className="call-menu-item"
          aria-disabled={v.reason ? true : undefined}
          aria-describedby={v.reason ? reasonId : undefined}
          onPointerEnter={warm}
          onFocus={warm}
          onClick={() => {
            onDone?.();
            void start(room, v, b.kind, env);
          }}
        >
          <Icon name={b.icon} />
          {b.title}
        </button>
      ))}
      {v.reason && (
        <p id={reasonId} className="call-menu-why" aria-hidden="true">
          {namesIn(v.reason)}
        </p>
      )}
      <hr />
    </>
  );
}
