import pg from 'pg';
import type { ServerEvent } from '@shared/index';
import { newId } from '../lib/ids';
import { config } from '../config';
import { pool } from '../db/pool';

// Barramento de eventos em tempo real.
// Entrega local para os sockets desta instância e repassa às demais instâncias
// via LISTEN/NOTIFY do PostgreSQL, sem broker externo e sem limite de instâncias.

export type Target =
  | { conn: string }
  | { room: string }
  | { user: string }
  | { users: string[] }
  | { all: true };

type Internal =
  | { type: '_join'; userId: string; rid: string }
  | { type: '_leave'; userId: string; rid: string }
  | { type: '_settings'; settings: { _id: string; value: unknown }[] }
  | { type: '_permissions' }
  | { type: '_logout'; sessionIds?: string[]; userId?: string };

export interface Conn {
  id: string;
  userId: string;
  sessionId: string;
  rooms: Set<string>;
  watched: Set<string>;
  send(ev: ServerEvent): void;
  close(): void;
}

const CHANNEL = 'wescc_rt';
const MAX_NOTIFY = 7000;

type Envelope = { o: string; t?: Target; e?: ServerEvent; i?: Internal; spill?: number };

class Bus {
  readonly origin = newId(8);
  private conns = new Map<string, Conn>();
  private byUser = new Map<string, Set<Conn>>();
  private listener: pg.Client | null = null;
  private stopping = false;
  private retry: NodeJS.Timeout | null = null;
  private hooks: { settings?: (s: { _id: string; value: unknown }[]) => void; permissions?: () => void } = {};

  onSettings(fn: (s: { _id: string; value: unknown }[]) => void) {
    this.hooks.settings = fn;
  }
  onPermissions(fn: () => void) {
    this.hooks.permissions = fn;
  }

  async start() {
    if (this.listener) return;
    this.stopping = false;
    await this.listen();
  }

  private async listen() {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    // Sem ouvinte, um erro nesta conexão derrubaria o processo; o 'end' que vem depois cuida da reconexão.
    client.on('error', () => {});
    client.on('notification', (n) => {
      if (!n.payload) return;
      void this.handleRemote(n.payload);
    });
    client.on('end', () => {
      if (this.listener !== client) return;
      this.listener = null;
      if (!this.stopping) this.reconnect(1000);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (e) {
      await client.end().catch(() => {});
      throw e;
    }
    this.listener = client;
  }

  // O banco caiu ou reiniciou: tenta de novo com espera crescente, até 30 s, sem derrubar o processo.
  private reconnect(delay: number) {
    if (this.retry || this.stopping) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.stopping) return;
      this.listen().then(
        () => console.error('[bus] LISTEN restabelecido'),
        () => this.reconnect(Math.min(delay * 2, 30_000)),
      );
    }, delay);
    this.retry.unref?.();
  }

  async stop() {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const client = this.listener;
    this.listener = null;
    await client?.end().catch(() => {});
  }

  private async handleRemote(payload: string) {
    let env: Envelope;
    try {
      env = JSON.parse(payload);
    } catch {
      return;
    }
    if (env.o === this.origin) return;
    if (env.spill) {
      const r = await pool.query('SELECT payload FROM realtime_spill WHERE id = $1', [env.spill]);
      if (!r.rows[0]) return;
      env = { ...r.rows[0].payload, o: env.o };
    }
    if (env.i) this.applyInternal(env.i);
    if (env.t && env.e) this.deliverLocal(env.t, env.e);
  }

  private async forward(env: Omit<Envelope, 'o'>) {
    const full: Envelope = { o: this.origin, ...env };
    let payload = JSON.stringify(full);
    try {
      if (payload.length > MAX_NOTIFY) {
        const r = await pool.query('INSERT INTO realtime_spill (payload) VALUES ($1) RETURNING id', [JSON.stringify(env)]);
        payload = JSON.stringify({ o: this.origin, spill: r.rows[0].id });
      }
      await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
    } catch {
      // Falha ao repassar não impede a entrega local.
    }
  }

  register(conn: Conn) {
    this.conns.set(conn.id, conn);
    let set = this.byUser.get(conn.userId);
    if (!set) this.byUser.set(conn.userId, (set = new Set()));
    set.add(conn);
  }

  unregister(conn: Conn) {
    this.conns.delete(conn.id);
    const set = this.byUser.get(conn.userId);
    set?.delete(conn);
    if (set && set.size === 0) this.byUser.delete(conn.userId);
  }

  isUserConnectedLocally(userId: string) {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  localConnectionCount() {
    return this.conns.size;
  }

  private deliverLocal(target: Target, ev: ServerEvent) {
    if ('all' in target) {
      for (const c of this.conns.values()) c.send(ev);
    } else if ('conn' in target) {
      this.conns.get(target.conn)?.send(ev);
    } else if ('user' in target) {
      for (const c of this.byUser.get(target.user) ?? []) c.send(ev);
    } else if ('users' in target) {
      for (const u of target.users) for (const c of this.byUser.get(u) ?? []) c.send(ev);
    } else {
      for (const c of this.conns.values()) {
        if (c.rooms.has(target.room) || c.watched.has(target.room)) c.send(ev);
      }
    }
  }

  private applyInternal(i: Internal) {
    switch (i.type) {
      case '_join':
        for (const c of this.byUser.get(i.userId) ?? []) c.rooms.add(i.rid);
        break;
      case '_leave':
        for (const c of this.byUser.get(i.userId) ?? []) c.rooms.delete(i.rid);
        break;
      case '_settings':
        this.hooks.settings?.(i.settings);
        break;
      case '_permissions':
        this.hooks.permissions?.();
        break;
      case '_logout':
        for (const c of this.conns.values()) {
          if ((i.sessionIds && i.sessionIds.includes(c.sessionId)) || (i.userId && c.userId === i.userId)) {
            c.send({ type: 'force_logout' });
            c.close();
          }
        }
        break;
    }
  }

  publish(target: Target, ev: ServerEvent) {
    this.deliverLocal(target, ev);
    void this.forward({ t: target, e: ev });
  }

  private internal(i: Internal) {
    this.applyInternal(i);
    void this.forward({ i });
  }

  joinRoom(userId: string, rid: string) {
    this.internal({ type: '_join', userId, rid });
  }
  leaveRoom(userId: string, rid: string) {
    this.internal({ type: '_leave', userId, rid });
  }
  // Todas as alterações vão para o cache das outras instâncias; só as públicas chegam aos clientes.
  publishSettings(settings: { _id: string; value: unknown }[], publicSettings: { _id: string; value: unknown }[]) {
    void this.forward({ i: { type: '_settings', settings } });
    if (publicSettings.length) this.publish({ all: true }, { type: 'settings.changed', settings: publicSettings });
  }
  permissionsChanged() {
    this.internal({ type: '_permissions' });
    this.publish({ all: true }, { type: 'permissions.changed' });
  }
  forceLogout(opts: { sessionIds?: string[]; userId?: string }) {
    this.internal({ type: '_logout', ...opts });
  }
}

export const bus = new Bus();
