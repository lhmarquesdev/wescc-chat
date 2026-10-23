// Fila serial por chamada (dentro do processo) e agrupamento de tarefas repetidas. A fila fica na frente da trava do
// banco: uma instância nunca tem mais de uma conexão do pool esperando pela mesma chamada.

const lanes = new Map<string, Promise<unknown>>();
let pending = 0;

export function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  pending++;
  const prev = lanes.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  lanes.set(key, tail);
  void tail.then(() => {
    pending--;
    if (lanes.get(key) === tail) lanes.delete(key);
  });
  return run;
}

export function pendingCount(): number {
  return pending;
}

// Vagas por instância: numa enxurrada (300 pessoas clicando "Entrar" ou "Sair" no mesmo minuto) o resto espera aqui,
// sem conexão, e o pool continua livre para o chat.
function gate(slots: number) {
  let busy = 0;
  const waiters: (() => void)[] = [];
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (busy < slots) busy++;
    else await new Promise<void>((r) => waiters.push(r)); // a vaga vem de quem terminou
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else busy--;
    }
  };
}

// Entradas pelo servidor de chamadas (iniciar, entrar e atender em grupo): 8 por vez. A dois (P2P) não passa por aqui.
export const entryGate = gate(8);
// Saídas de chamadas em grupo: 4 por vez, separadas das entradas para uma não esperar atrás da outra.
export const leaveGate = gate(4);

// Pedidos de entrada da mesma pessoa, um de cada vez (duas abas, duplo clique): uma chamada por pessoa (G27).
export function userLane<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return enqueue(`user:${userId}`, fn);
}

interface Slot {
  timer: NodeJS.Timeout | null;
  queued: boolean; // chegou outro pedido durante a janela
  fn: () => unknown;
  leading: boolean;
  ms: number;
}

const slots = new Map<string, Slot>();
const running = new Set<Promise<unknown>>();

function fire(id: string, s: Slot) {
  const p = Promise.resolve()
    .then(() => s.fn())
    .catch((e) => console.error(`[chamadas] tarefa ${id} falhou: ${(e as Error)?.message ?? e}`));
  running.add(p);
  void p.finally(() => running.delete(p));
  return p;
}

function arm(id: string, s: Slot) {
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.leading) {
      if (!s.queued) {
        slots.delete(id);
        return;
      }
      s.queued = false;
      void fire(id, s);
      arm(id, s);
      return;
    }
    slots.delete(id);
    void fire(id, s);
  }, s.ms);
  s.timer.unref();
}

// leading: roda já quando está parada e, na janela, no máximo mais uma vez no fim. Sem leading, só no fim da janela.
export function coalesce(callId: string, key: string, ms: number, fn: () => unknown, opts: { leading?: boolean } = {}): void {
  const id = `${callId}:${key}`;
  const s = slots.get(id);
  if (s) {
    s.fn = fn;
    if (s.leading) s.queued = true;
    return;
  }
  const slot: Slot = { timer: null, queued: false, fn, leading: !!opts.leading, ms };
  slots.set(id, slot);
  if (slot.leading) void fire(id, slot);
  arm(id, slot);
}

// Descarta um agrupamento pendente (o cartão final já foi escrito; não precisa do atrasado).
export function cancelCoalesced(callId: string, key: string): void {
  const id = `${callId}:${key}`;
  const s = slots.get(id);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  slots.delete(id);
}

// Testes: roda agora o que está esperando a janela e aguarda até não sobrar nada (tarefas podem agendar outras).
export async function drainCoalesced(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    const due = [...slots.entries()];
    for (const [id, s] of due) {
      if (s.timer) clearTimeout(s.timer);
      slots.delete(id);
      if (!s.leading || s.queued) void fire(id, s);
    }
    await Promise.allSettled([...running]);
    await Promise.allSettled([...lanes.values()]);
    if (!slots.size && !running.size && !pending) return;
  }
}
