// Ações de chamada no cabeçalho da sala: iniciar (voz e vídeo, ou transmissão), entrar, ouvir ou voltar para a chamada.
// O que mostrar vem de headerView (call-view.ts); aqui só o desenho e os cliques.
import { useEffect, useId } from 'react';
import type { CallKind, Room, Subscription } from '@shared/index';
import { callPeopleLabel } from '@shared/calls';
import { CALL_HTTPS_REASON, headerView, type CallViewEnv, type HeaderGuess, type HeaderView } from '@shared/call-view';
import { expandCall, isInCall, openCall, openJoin, useCallStore } from '../../lib/call/store';
import { prefetchSfu } from '../../lib/calls';
import { namesIn } from '../../lib/names';
import { explainCall as explain, recheckRoomCall, useCallEnv, useHeaderGuess, useRoomCall } from '../../lib/roomcall';
import { Icon } from '../Icon';
import '../callroom.css';

// room vem de rooms.info (com muted e direct): o cabeçalho provisório usa o que ela já diz.
type RoomInfo = Room & { muted?: string[] };
type Props = { room: RoomInfo; sub: Subscription | null | undefined; compact?: boolean };

// A conversa a dois usa a chamada direta (P2P); nas outras salas o motor de grupo pode ir carregando antes.
const isPair = (room: Room | null | undefined) => room?.t === 'd' && (room.uids?.length ?? 0) === 2;

// O estado da sala, o que o cliente já sabe dela e a visão do cabeçalho: antes da resposta do servidor (ou com o
// estado guardado) o cabeçalho já nasce com o que a sala oferece, sem pular quando a resposta chega.
function useHeader(rid: string | null, room: RoomInfo | null | undefined) {
  const s = useRoomCall(rid);
  const g = useHeaderGuess(rid, room);
  const env = useCallEnv(s?.call?._id);
  return { s, g, env, v: headerView(s, env, g) };
}

// A visão do cabeçalho, para a página da sala decidir o que cabe (pílula no lugar de Membros, botões no Mais).
export function useRoomCallHeader(rid: string | null, room?: RoomInfo | null): HeaderView {
  return useHeader(rid, room).v;
}

function startKinds(v: Extract<HeaderView, { kind: 'start' }>) {
  return v.transmission
    ? ([{ kind: 'audio', title: 'Iniciar transmissão', icon: 'call-broadcast' }] as const)
    : ([
        { kind: 'audio', title: 'Chamada de voz', icon: 'call-audio' },
        { kind: 'video', title: 'Chamada de vídeo', icon: 'call-video' },
      ] as const);
}

// Iniciar: barrado ou provisório, confere com o servidor antes (o motivo pode ter passado, ou surgido com a sala
// fechada) e só então liga ou explica. Sem HTTPS não há o que perguntar.
async function start(room: Room, v: Extract<HeaderView, { kind: 'start' }>, kind: CallKind, env: CallViewEnv, g: HeaderGuess) {
  if (v.reason === CALL_HTTPS_REASON) return explain(v.reason);
  if (v.reason || v.pending) {
    const now = headerView(await recheckRoomCall(room._id), env, { ...g, settled: true });
    if (now.kind !== 'start') return;
    if (now.reason) return explain(now.reason);
  }
  void openCall(room._id, kind);
}

export function RoomCallActions({ room, sub: _sub, compact }: Props) {
  const rid = room._id;
  const { s, g, env, v } = useHeader(rid, room);
  const tabCall = useCallStore((st) => st.tabCall);
  const reasonId = useId();
  const warm = isPair(room) ? undefined : () => prefetchSfu();

  // #call (toque de chamada em grupo pelo push): entra direto quando a chamada está viva e a entrada é possível,
  // pela resposta do servidor (não pelo estado provisório).
  const settled = g.settled;
  useEffect(() => {
    if (!s || !settled || location.hash !== '#call') return;
    history.replaceState(history.state, '', location.pathname + location.search);
    const call = s.call;
    if (!call || call.status !== 'ongoing' || call.scope !== 'group') return;
    if (isInCall(call._id)) expandCall();
    else if (s.canJoin && window.isSecureContext) void openJoin(call._id, rid);
  }, [s, settled, rid]);

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
            onClick={() => void start(room, v, b.kind, env, g)}
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
      if (v.reason || v.pending) {
        // Barrada ou provisória: pergunta de novo (alguém pode ter saído da chamada cheia, o servidor pode ter voltado,
        // algo pode ter mudado com a sala fechada).
        const fresh = await recheckRoomCall(rid);
        const now = headerView(fresh, env, { ...g, settled: true });
        if (now.kind !== 'pill' || now.action !== 'join' || !fresh?.call) return;
        if (now.reason) return explain(now.reason);
        return void openJoin(fresh.call._id, rid);
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
  const { g, env, v } = useHeader(room._id, room);
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
            void start(room, v, b.kind, env, g);
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
