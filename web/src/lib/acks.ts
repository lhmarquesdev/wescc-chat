import { create } from 'zustand';
import { api } from './api';
import { realtime } from './realtime';
import { useStore } from './store';

// "Ciente" de quem lê: quais avisos da sala a pessoa já confirmou e quais ainda esperam a confirmação dela.

export interface RoomAcks {
  acked: Set<string>;
  pending: string[];
}

export const useAcks = create<{ byRoom: Record<string, RoomAcks> }>(() => ({ byRoom: {} }));

const put = (rid: string, next: RoomAcks) => useAcks.setState((s) => ({ byRoom: { ...s.byRoom, [rid]: next } }));

// Salas na tela (quantas listas mostram cada uma) e o que falta sincronizar nelas.
const watched = new Map<string, number>();
const timers = new Map<string, number>();
const lastSync = new Map<string, number>();
const stale = new Set<string>();
// Numa sala grande os eventos de contagem chegam a cada 2 s enquanto as pessoas confirmam: no máximo uma busca a cada 10 s.
const SYNC_GAP = 10_000;

// O "Ciente" pode ter sido dado em outra aba ou aparelho da mesma pessoa, e o servidor só avisa a nova contagem
// do aviso. Então a sala na tela busca de novo a lista dela (com a aba escondida, só quando ela voltar).
function resync(rid: string, delay: number) {
  if (!watched.has(rid) || timers.has(rid)) return;
  if (document.visibilityState === 'hidden') {
    stale.add(rid);
    return;
  }
  stale.delete(rid);
  const wait = Math.max(delay, (lastSync.get(rid) ?? 0) + SYNC_GAP - Date.now());
  timers.set(
    rid,
    window.setTimeout(() => {
      timers.delete(rid);
      lastSync.set(rid, Date.now());
      void loadAcks(rid);
    }, wait),
  );
}

let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  realtime.on((ev) => {
    if (ev.type === 'message' && ev.message.ackRequired && !ev.message.t && !ev.message.tmid) {
      const cur = useAcks.getState().byRoom[ev.message.rid];
      const id = ev.message._id;
      if (!cur) return;
      // Contagem nova de um aviso que a tela mostra sem o "Ciente" desta pessoa: talvez ela mesma tenha confirmado em
      // outro lugar. Vale também para avisos antigos, que o servidor não põe na lista de pendentes (30 dias, 100 avisos).
      if (ev.action === 'updated') {
        if (!cur.acked.has(id) && ev.message.u._id !== useStore.getState().me?._id) resync(ev.message.rid, 300);
        return;
      }
      // Avisos novos entram na lista de pendentes na hora.
      if (ev.message.u._id === useStore.getState().me?._id || cur.acked.has(id) || cur.pending.includes(id)) return;
      put(ev.message.rid, { ...cur, pending: [...cur.pending, id] });
    } else if (ev.type === 'message.deleted') {
      const cur = useAcks.getState().byRoom[ev.rid];
      if (cur?.pending.includes(ev._id)) put(ev.rid, { ...cur, pending: cur.pending.filter((x) => x !== ev._id) });
    } else if (ev.type === 'connected') {
      // Reconexão: eventos podem ter se perdido enquanto a conexão estava fora.
      for (const rid of watched.keys()) resync(rid, 300);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') for (const rid of [...stale]) resync(rid, 300);
  });
}

// Outra pessoa entrou no navegador: as confirmações da anterior não valem mais.
useStore.subscribe((s, prev) => {
  if (s.me?._id !== prev.me?._id) useAcks.setState({ byRoom: {} });
});

async function loadAcks(rid: string) {
  try {
    const r = (await api.get('chat.myAcks', { roomId: rid })) as { acked: string[]; pending: string[] };
    // Um clique em "Ciente" durante a busca não pode voltar a ficar pendente.
    const local = useAcks.getState().byRoom[rid]?.acked ?? new Set<string>();
    const acked = new Set([...r.acked, ...local]);
    put(rid, { acked, pending: r.pending.filter((id) => !acked.has(id)) });
  } catch {
    // Quem só está vendo a prévia do canal não confirma.
    put(rid, { acked: new Set(), pending: [] });
  }
}

// A lista de mensagens da sala está na tela: carrega as confirmações e as mantém em dia até desmontar.
export function watchAcks(rid: string) {
  listen();
  watched.set(rid, (watched.get(rid) ?? 0) + 1);
  void loadAcks(rid);
  return () => {
    const n = (watched.get(rid) ?? 1) - 1;
    if (n > 0) {
      watched.set(rid, n);
      return;
    }
    watched.delete(rid);
    stale.delete(rid);
    clearTimeout(timers.get(rid));
    timers.delete(rid);
  };
}

export function markAcked(rid: string, msgId: string) {
  const cur = useAcks.getState().byRoom[rid] ?? { acked: new Set<string>(), pending: [] };
  put(rid, { acked: new Set([...cur.acked, msgId]), pending: cur.pending.filter((x) => x !== msgId) });
}
