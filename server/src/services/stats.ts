import { many, one, query } from '../db/pool';
import { bus } from '../realtime/bus';

export async function recordActivity(userId: string, kind: 'message' | 'session') {
  const col = kind === 'message' ? 'messages' : 'sessions';
  await query(
    `INSERT INTO activity_daily (day, user_id, ${col}) VALUES (current_date, $1, 1)
     ON CONFLICT (day, user_id) DO UPDATE SET ${col} = activity_daily.${col} + 1`,
    [userId],
  ).catch(() => {});
}

// Estatísticas gerais do workspace (tela de informações do admin).
export async function workspaceStatistics() {
  const users = await one(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE active)::int AS active,
      count(*) FILTER (WHERE NOT active)::int AS inactive,
      count(*) FILTER (WHERE status = 'online')::int AS online,
      count(*) FILTER (WHERE status = 'away')::int AS away,
      count(*) FILTER (WHERE status = 'busy')::int AS busy,
      count(*) FILTER (WHERE status = 'offline')::int AS offline,
      count(*) FILTER (WHERE type = 'bot')::int AS bots
    FROM users`);
  const rooms = await one(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE t = 'c' AND prid IS NULL)::int AS channels,
      count(*) FILTER (WHERE t = 'p' AND prid IS NULL)::int AS private_groups,
      count(*) FILTER (WHERE t = 'd')::int AS direct,
      count(*) FILTER (WHERE prid IS NOT NULL)::int AS discussions
    FROM rooms`);
  const msgs = await one(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE tmid IS NOT NULL)::int AS thread_messages FROM messages WHERE t IS NULL`);
  const teams = await one('SELECT count(*)::int AS n FROM teams');
  const files = await one('SELECT count(*)::int AS n, coalesce(sum(size),0)::bigint AS bytes FROM files');
  const instances = await many(`SELECT id, started_at, last_seen, info FROM instances WHERE last_seen > now() - interval '2 minutes' ORDER BY started_at`);
  return {
    users,
    rooms,
    messages: msgs,
    teams: teams.n,
    uploads: { total: files.n, totalSize: Number(files.bytes) },
    instances: instances.map((i) => ({ _id: i.id, startedAt: i.started_at, lastSeen: i.last_seen, ...i.info, current: i.id === bus.origin })),
    process: { nodeVersion: process.version, uptime: process.uptime(), pid: process.pid, memory: process.memoryUsage().rss },
  };
}

// ---------- Dashboard de engajamento ----------

function range(start?: string, end?: string) {
  const e = end ? new Date(end) : new Date();
  const s = start ? new Date(start) : new Date(e.getTime() - 29 * 86400_000);
  return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)];
}

export async function engagementUsers(start?: string, end?: string) {
  const [s, e] = range(start, end);
  const daily = await many(
    `SELECT d::date AS day,
        (SELECT count(DISTINCT user_id) FROM activity_daily a WHERE a.day = d::date)::int AS dau,
        (SELECT count(DISTINCT user_id) FROM activity_daily a WHERE a.day BETWEEN d::date - 6 AND d::date)::int AS wau,
        (SELECT count(DISTINCT user_id) FROM activity_daily a WHERE a.day BETWEEN d::date - 29 AND d::date)::int AS mau,
        (SELECT count(*) FROM users u WHERE u.created_at::date = d::date)::int AS new_users
     FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`,
    [s, e],
  );
  const activeInPeriod = await one('SELECT count(DISTINCT user_id)::int AS n FROM activity_daily WHERE day BETWEEN $1 AND $2', [s, e]);
  const busiest = await many(
    `SELECT extract(hour from created_at)::int AS hour, count(*)::int AS messages
     FROM messages WHERE created_at::date BETWEEN $1 AND $2 AND t IS NULL GROUP BY 1 ORDER BY 1`,
    [s, e],
  );
  const weekday = await many(
    `SELECT extract(isodow from created_at)::int AS weekday, count(*)::int AS messages
     FROM messages WHERE created_at::date BETWEEN $1 AND $2 AND t IS NULL GROUP BY 1 ORDER BY 1`,
    [s, e],
  );
  return {
    start: s,
    end: e,
    activeUsers: activeInPeriod.n,
    daily: daily.map((d) => ({ day: String(d.day).slice(0, 10), dau: d.dau, wau: d.wau, mau: d.mau, newUsers: d.new_users })),
    busiestHours: busiest,
    weekdays: weekday,
  };
}

export async function engagementMessages(start?: string, end?: string) {
  const [s, e] = range(start, end);
  const daily = await many(
    `SELECT d::date AS day, coalesce(m.n, 0)::int AS messages
     FROM generate_series($1::date, $2::date, interval '1 day') d
     LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM messages WHERE t IS NULL GROUP BY 1) m ON m.day = d::date
     ORDER BY d`,
    [s, e],
  );
  const byType = await many(
    `SELECT r.t, count(*)::int AS messages FROM messages m JOIN rooms r ON r.id = m.room_id
     WHERE m.created_at::date BETWEEN $1 AND $2 AND m.t IS NULL GROUP BY r.t`,
    [s, e],
  );
  const topRooms = await many(
    `SELECT r.id, r.t, coalesce(r.fname, r.name) AS name, count(*)::int AS messages, r.users_count
     FROM messages m JOIN rooms r ON r.id = m.room_id
     WHERE m.created_at::date BETWEEN $1 AND $2 AND m.t IS NULL AND r.t IN ('c','p')
     GROUP BY r.id ORDER BY messages DESC LIMIT 10`,
    [s, e],
  );
  const topUsers = await many(
    `SELECT u.id, u.username, u.name, sum(a.messages)::int AS messages
     FROM activity_daily a JOIN users u ON u.id = a.user_id
     WHERE a.day BETWEEN $1 AND $2 GROUP BY u.id ORDER BY messages DESC LIMIT 10`,
    [s, e],
  );
  return {
    start: s,
    end: e,
    total: daily.reduce((n, d) => n + d.messages, 0),
    daily: daily.map((d) => ({ day: String(d.day).slice(0, 10), messages: d.messages })),
    byRoomType: byType,
    topRooms: topRooms.map((r) => ({ _id: r.id, t: r.t, name: r.name, messages: r.messages, usersCount: r.users_count })),
    topUsers: topUsers.map((u) => ({ _id: u.id, username: u.username, name: u.name, messages: u.messages })),
  };
}

export async function engagementChannels(start?: string, end?: string, offset = 0, count = 25) {
  const [s, e] = range(start, end);
  const rows = await many(
    `SELECT r.id, r.t, r.name, r.fname, r.users_count, r.created_at, r.team_main,
        count(m.id) FILTER (WHERE m.created_at::date BETWEEN $1 AND $2)::int AS messages,
        count(m.id) FILTER (WHERE m.created_at::date BETWEEN ($1::date - ($2::date - $1::date) - 1) AND ($1::date - 1))::int AS previous,
        count(*) OVER() AS total
     FROM rooms r LEFT JOIN messages m ON m.room_id = r.id AND m.t IS NULL
     WHERE r.t IN ('c','p')
     GROUP BY r.id ORDER BY messages DESC, r.name LIMIT $3 OFFSET $4`,
    [s, e, count, offset],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    channels: rows.map((r) => ({
      room: { _id: r.id, t: r.t, name: r.name, fname: r.fname, usersCount: r.users_count, ts: r.created_at, teamMain: r.team_main },
      messages: r.messages,
      lastWeekMessages: r.previous,
      diffFromLastWeek: r.messages - r.previous,
    })),
  };
}
