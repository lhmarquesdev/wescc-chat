// Ganchos internos para módulos que reagem a eventos do chat (integrações, omnichannel).
// Os ouvintes rodam depois da operação principal e nunca a fazem falhar.

export interface HookEvents {
  'message.sent': { room: any; message: any; user: { _id: string; username: string; name?: string } | null };
  'message.updated': { room: any; message: any };
  'room.created': { room: any; owner: { _id: string; username: string } | null };
  'room.archived': { room: any; by: { _id: string; username: string } | null };
  'room.joined': { room: any; user: { _id: string; username: string } };
  'room.left': { room: any; user: { _id: string; username: string } };
  'user.created': { user: { _id: string; username: string; name: string; email?: string | null } };
  'file.uploaded': { room: any; message: any; file: any; user: { _id: string; username: string } };
}

type Listener<K extends keyof HookEvents> = (data: HookEvents[K]) => unknown;
const listeners = new Map<keyof HookEvents, Listener<any>[]>();

export function on<K extends keyof HookEvents>(event: K, fn: Listener<K>) {
  const list = listeners.get(event) ?? [];
  list.push(fn);
  listeners.set(event, list);
}

export function emit<K extends keyof HookEvents>(event: K, data: HookEvents[K]) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      const r = fn(data);
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch {
      // ouvinte com erro não afeta o chat
    }
  }
}
