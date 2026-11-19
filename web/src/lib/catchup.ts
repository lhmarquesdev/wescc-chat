import { useStore } from './store';

// Reconexão do tempo real: os eventos de enquanto a conexão estava fora se perderam. As listas na tela (salas e
// tópicos) buscam de novo o que chegou; o que estava guardado das outras sai da memória, e a próxima abertura busca
// do servidor.
type Kind = 'room' | 'thread';
const shown: Record<Kind, Map<string, Set<() => void>>> = { room: new Map(), thread: new Map() };

// A lista desta sala (ou deste tópico) está na tela: fn roda a cada reconexão até a lista sair.
export function onReconnectWhileShown(kind: Kind, id: string, fn: () => void) {
  const fns = shown[kind].get(id) ?? new Set();
  fns.add(fn);
  shown[kind].set(id, fns);
  return () => {
    fns.delete(fn);
    if (!fns.size && shown[kind].get(id) === fns) shown[kind].delete(id);
  };
}

export function catchUpAfterReconnect() {
  const { messages, threads } = useStore.getState();
  useStore.setState({
    messages: Object.fromEntries(Object.entries(messages).filter(([rid]) => shown.room.has(rid))),
    threads: Object.fromEntries(Object.entries(threads).filter(([tmid]) => shown.thread.has(tmid))),
  });
  for (const kind of ['room', 'thread'] as const) for (const fns of shown[kind].values()) for (const fn of fns) fn();
}
