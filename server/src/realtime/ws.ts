import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientEvent, ServerEvent, UserStatus } from '@shared/index';
import { many, one, query } from '../db/pool';
import { newId } from '../lib/ids';
import { parseCookies } from '../api/http';
import { canAccessRoom, getRoom, getSubscriptionRow, userRoomIds } from '../services/rooms';
import { isTrustedBrowserOrigin } from '../services/origins';
import { pendingSetup, resolveToken, setStatus } from '../services/users';
import { bus, type Conn } from './bus';

async function publishPresence(userId: string) {
  const u = await one('SELECT id, username, status, status_text FROM users WHERE id = $1', [userId]);
  if (u) bus.publish({ all: true }, { type: 'presence', userId: u.id, username: u.username, status: u.status, statusText: u.status_text });
}

async function connectionOpened(conn: Conn) {
  await query('INSERT INTO presence_connections (id, user_id, instance_id, session_id) VALUES ($1,$2,$3,$4)', [conn.id, conn.userId, bus.origin, conn.sessionId]);
  const u = await one(`UPDATE users SET status = status_default WHERE id = $1 AND status = 'offline' RETURNING id`, [conn.userId]);
  if (u) await publishPresence(conn.userId);
}

async function connectionClosed(conn: Conn) {
  await query('DELETE FROM presence_connections WHERE id = $1', [conn.id]);
  await refreshOffline(conn.userId);
}

export async function refreshOffline(userId: string) {
  const left = await one('SELECT 1 FROM presence_connections WHERE user_id = $1 LIMIT 1', [userId]);
  if (!left) {
    const u = await one(`UPDATE users SET status = 'offline' WHERE id = $1 AND status <> 'offline' RETURNING id`, [userId]);
    if (u) await publishPresence(userId);
  }
}

// Remove conexões de instâncias que pararam de responder.
export async function cleanupStaleConnections() {
  const stale = await many(
    `DELETE FROM presence_connections WHERE instance_id NOT IN (SELECT id FROM instances WHERE last_seen > now() - interval '90 seconds') RETURNING user_id`,
  );
  for (const uid of new Set(stale.map((s) => s.user_id))) await refreshOffline(uid);
}

export function registerWebsocket(app: FastifyInstance) {
  app.get('/websocket', { websocket: true }, (socket: WebSocket, req) => {
    let conn: Conn | null = null;
    let authTimer: NodeJS.Timeout | null = setTimeout(() => socket.close(4001, 'auth-timeout'), 10_000);
    let idle = false;

    const send = (ev: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(ev));
    };

    const authenticate = async (token: string | undefined, userId?: string) => {
      if (!token) return false;
      const r = await resolveToken(userId, token);
      if (!r) return false;
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
      // Troca de senha ou 2FA obrigatório pendente: o cliente recarrega e mostra a tela de configuração.
      if (await pendingSetup(r.user)) {
        socket.close(4005, 'setup-required');
        return true;
      }
      conn = {
        id: newId(),
        userId: r.user.id,
        sessionId: r.sessionId,
        rooms: new Set(await userRoomIds(r.user.id)),
        watched: new Set(),
        send,
        close: () => socket.close(4003, 'logout'),
      };
      bus.register(conn);
      await connectionOpened(conn);
      send({ type: 'connected', userId: r.user.id, sessionId: r.sessionId, connectionId: conn.id });
      return true;
    };

    // Autentica pelo cookie, se houver e se a página for do próprio chat (senão outro site usaria a sessão); senão espera a mensagem "auth".
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.rc_token && isTrustedBrowserOrigin(req.headers.origin, req.headers.host)) void authenticate(cookies.rc_token, cookies.rc_uid).catch(() => {});

    socket.on('message', async (raw) => {
      let ev: ClientEvent;
      try {
        ev = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (ev.type === 'auth') {
          if (conn) return;
          if (!(await authenticate(ev.token))) socket.close(4001, 'unauthorized');
          return;
        }
        if (ev.type === 'ping') return send({ type: 'pong' });
        if (!conn) return;
        const c = conn as Conn;
        switch (ev.type) {
          case 'typing': {
            if (!c.rooms.has(ev.rid)) return;
            const u = await one('SELECT username FROM users WHERE id = $1', [c.userId]);
            bus.publish({ room: ev.rid }, { type: 'typing', rid: ev.rid, tmid: ev.tmid ?? null, username: u.username, typing: !!ev.typing });
            break;
          }
          case 'watch': {
            if (c.watched.size > 50) c.watched.clear();
            const room = await getRoom(ev.rid);
            if (room && (await canAccessRoom(c.userId, room))) c.watched.add(ev.rid);
            break;
          }
          case 'unwatch':
            c.watched.delete(ev.rid);
            break;
          case 'status':
            if (['online', 'away', 'busy', 'offline'].includes(ev.status)) await setStatus(c.userId, ev.status as UserStatus);
            break;
          case 'call.signal': {
            const { relaySignal } = await import('../services/calls');
            await relaySignal(c.id, c.userId, ev.callId, ev.data);
            break;
          }
          case 'idle': {
            // Ausência automática: só altera quem está "online" por padrão.
            if (idle === ev.idle) return;
            idle = ev.idle;
            const u = await one('SELECT status, status_default FROM users WHERE id = $1', [c.userId]);
            if (!u || u.status_default !== 'online') return;
            const next = ev.idle ? 'away' : 'online';
            if (u.status !== next) {
              await query('UPDATE users SET status = $2 WHERE id = $1', [c.userId, next]);
              await publishPresence(c.userId);
            }
            break;
          }
        }
      } catch {
        // Erros de um evento não derrubam a conexão.
      }
    });

    socket.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      if (conn) {
        const closed = conn;
        bus.unregister(closed);
        void connectionClosed(closed)
          .then(async () => (await import('../services/calls')).connectionClosed(closed.id))
          .catch(() => {});
      }
    });
  });
}

export { getSubscriptionRow };
