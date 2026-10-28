// Abas do mesmo navegador: a aba em chamada avisa as outras (BroadcastChannel 'wescc-call'), que mostram
// "Chamada em andamento em outra aba." e não abrem uma segunda conexão.

export interface TabCall {
  callId: string;
  rid: string;
}

type Msg = { type: 'in-call'; callId: string; rid: string; tab: string } | { type: 'left'; tab: string } | { type: 'ask'; tab: string };

const TAB = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null = null;
let mine: TabCall | null = null;
const others = new Map<string, TabCall>();
let listener: ((c: TabCall | null) => void) | null = null;

function post(m: Msg) {
  try {
    channel?.postMessage(m);
  } catch {
    // canal fechado
  }
}

const current = () => [...others.values()][0] ?? null;

export function watchTabs(onChange: (c: TabCall | null) => void) {
  listener = onChange;
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('wescc-call');
  channel.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (!m || m.tab === TAB) return;
    if (m.type === 'ask') {
      if (mine) post({ type: 'in-call', ...mine, tab: TAB });
      return;
    }
    if (m.type === 'in-call') others.set(m.tab, { callId: m.callId, rid: m.rid });
    else others.delete(m.tab);
    listener?.(current());
  };
  // Aba que fecha no meio da chamada: as outras liberam os botões.
  addEventListener('pagehide', () => mine && post({ type: 'left', tab: TAB }));
  post({ type: 'ask', tab: TAB });
}

export function announceCall(c: TabCall | null) {
  if (c?.callId === mine?.callId) return;
  mine = c;
  post(c ? { type: 'in-call', ...c, tab: TAB } : { type: 'left', tab: TAB });
}
